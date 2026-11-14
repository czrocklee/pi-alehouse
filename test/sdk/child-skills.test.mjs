// Real pinned SDK resource discovery only: no child authority, provider or model calls.
// Factory tests separately prove that the live preference selects this noSkills flag.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Per-file process isolation; never discover the operator's skills or settings.
const home = await mkdtemp(join(tmpdir(), "alehouse-child-skills-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
test.after(() => rm(home, { recursive: true, force: true }));
const { DefaultResourceLoader, SettingsManager, formatSkillsForPrompt } =
  await import("@earendil-works/pi-coding-agent");

async function skill(base, name) {
  const directory = join(base, name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: Use for ${name} fixture tasks.\n---\nPRIVATE_BODY_${name}\n`,
  );
  return path;
}

async function fixture(t) {
  t.mock.method(globalThis, "fetch", () => assert.fail("skill fixture attempted network IO"));
  const root = await mkdtemp(join(home, "case-")),
    cwd = join(root, "project"),
    agentDir = join(root, "agent");
  const globalSkill = await skill(join(agentDir, "skills"), "global-skill");
  await skill(join(cwd, ".pi", "skills"), "project-skill");
  await skill(join(cwd, ".agents", "skills"), "agents-skill");
  // Stop project ancestor discovery inside this owned fixture tree.
  await mkdir(join(cwd, ".git"));
  const load = async ({ enabled = true, trusted = true, skills } = {}) => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(skills ? { skills } : {}));
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: !enabled,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getExtensions().extensions, []);
    assert.deepEqual(loader.getSkills().diagnostics, []);
    return loader;
  };
  return { load, globalSkill };
}

const names = (loader) =>
  loader
    .getSkills()
    .skills.map((skill) => skill.name)
    .sort();

test("enabled child discovery advertises global and trusted project skills, not their bodies", async (t) => {
  const f = await fixture(t),
    loader = await f.load();
  assert.deepEqual(names(loader), ["agents-skill", "global-skill", "project-skill"]);
  const prompt = formatSkillsForPrompt(loader.getSkills().skills, "read");
  for (const name of names(loader)) assert(prompt.includes(name));
  assert(prompt.includes(f.globalSkill));
  assert(!prompt.includes("PRIVATE_BODY_"), "skill bodies stay on demand");
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
});

test("enabled discovery respects project trust and configured skill exclusions", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(names(await f.load({ trusted: false })), ["global-skill"]);
  assert.deepEqual(names(await f.load({ skills: [`-${f.globalSkill}`] })), [
    "agents-skill",
    "project-skill",
  ]);
});

test("disabled child discovery leaves no skill catalogue without changing an existing loader", async (t) => {
  const f = await fixture(t),
    existing = await f.load(),
    disabled = await f.load({ enabled: false });
  assert.deepEqual(names(disabled), []);
  assert.equal(formatSkillsForPrompt(disabled.getSkills().skills, "read"), "");
  assert.deepEqual(names(existing), ["agents-skill", "global-skill", "project-skill"]);
});
