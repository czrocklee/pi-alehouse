import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const git = (commands) => [...commands.map((c) => `git ${c}`), ...commands.map((c) => `git -C * ${c}`)];

// The source declaration and prompt are build-time trust inputs. Installed
// agent profiles are NEVER inputs to expected hashes.
export function renderWorkers(root = packageRoot) {
  const policy = JSON.parse(readFileSync(join(root, "resources/worker-policy.json"), "utf8"));
  assert.equal(policy.version, 1);
  assert(Array.isArray(policy.childToolDenies) && policy.childToolDenies.length > 0 &&
    policy.childToolDenies.every((tool) => typeof tool === "string" && /^[a-z][a-z0-9_]*$/.test(tool)), "Invalid child tool denies");
  assert.equal(new Set(policy.childToolDenies).size, policy.childToolDenies.length, "Duplicate child tool deny");
  assert(policy.childToolDenies.includes("agent_answer") && policy.childToolDenies.includes("notify_parent"), "Missing communication boundary deny");
  const toolDenies = policy.childToolDenies.map((tool) => `  ${tool}: deny\n`).join("");
  const prompt = readFileSync(join(root, "resources/worker.md"), "utf8");
  const agents = {}, metadata = {};
  for (const [name, profile] of Object.entries(policy.profiles)) {
    assert.match(name, /^[a-z]+$/);
    const bashDenies = [...git(policy.commonGitDenies), ...policy.gitSpellingDenies,
      ...git(policy.mutationGitDenies), ...profile.extraBashDenies];
    // Optional profile capabilities remain opt-in; communication changes must
    // never widen Bash, editing, or web access.
    assert(profile.bash === undefined || profile.bash === false, `Invalid bash flag: ${name}`);
    assert(profile.prompt === undefined || (typeof profile.prompt === "string" && profile.prompt.trim()), `Invalid prompt: ${name}`);
    const bash = profile.bash !== false;
    const tools = [...policy.readTools.filter((tool) => bash || tool !== "bash"), ...(profile.edits ? ["edit", "write"] : [])];
    assert(tools.every((tool) => !policy.childToolDenies.includes(tool)), `Denied tool in profile: ${name}`);
    agents[name] = `---\ndisplay_name: Worker\ndescription: ${JSON.stringify(profile.description)}\ntools: ${JSON.stringify(tools)}\nprompt_mode: replace\ninherit_context: false\npermission:\n` +
      toolDenies + (profile.edits ? "" : '  write: deny\n  edit: deny\n  path_write:\n    "*": deny\n') +
      `  bash:\n    "*": ${bash ? "ask" : "deny"}\n` + bashDenies.map((p) => `    ${JSON.stringify(p)}: deny`).join("\n") +
      `\n---\n${prompt}${profile.prompt ? `\n${profile.prompt}\n` : ""}\n`;
    // Nix's toJSON sorts attributes; retain that order for byte-for-byte output.
    metadata[name] = { bashDenies, digest: createHash("sha256").update(agents[name]).digest("hex") };
  }
  for (const name of policy.disabled) {
    assert.match(name, /^[A-Za-z-]+$/);
    agents[name] = '---\nenabled: false\ntools: none\npermission:\n  "*": deny\n  path_write:\n    "*": deny\n---\nThis built-in is disabled. Select a managed worker capability profile.\n';
  }
  return { agents, metadata };
}

export function generateWorkers(output = join(packageRoot, "runtime"), root = packageRoot) {
  const rendered = renderWorkers(root);
  mkdirSync(join(output, "agents"), { recursive: true });
  for (const [name, source] of Object.entries(rendered.agents)) writeFileSync(join(output, "agents", `${name}.md`), source);
  // Real siblings: transitive imports resolve identically in parent and child.
  cpSync(join(root, "extensions"), join(output, "policy"), { recursive: true });
  cpSync(join(root, "lib"), join(output, "lib"), { recursive: true });
  const marker = "/* @worker-policy@ */ {}";
  for (const name of ["jev-auto-approval.ts", "luna-auto-approval.ts", "static-safety-guard.ts"]) {
    const source = readFileSync(join(root, "extensions", name), "utf8");
    assert.equal(source.split(marker).length, 2, `Expected exactly one worker-policy marker: ${name}`);
    writeFileSync(join(output, "policy", name), source.replace(marker, JSON.stringify(rendered.metadata)));
  }
  writeFileSync(join(output, "worker-policy.json"), json(rendered.metadata));
  return rendered;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateWorkers();
