import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedAgentNames } from "../../bin/runtime-support.mjs";
import { renderWorkers } from "../../scripts/build/generate-workers.mjs";
import {
  agentProfileNames,
  blockedDelegationToolNames,
  managementToolNames,
} from "../../dist/orchestration/tools/tool-names.js";

const text = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const json = (relative) => JSON.parse(text(relative));
const definitionParts = (definition) => {
  const parts = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(definition);
  assert(parts, "managed definition must separate frontmatter and prompt");
  return { frontmatter: parts[1], prompt: parts[2] };
};

test("generated agent inventory matches init and the guide names the supported agents and tools", () => {
  assert.deepEqual(Object.keys(renderWorkers().agents).sort(), [...managedAgentNames].sort());
  const guide = text("../../docs/orchestration.md");
  const identifiers = new Set([...guide.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]));
  for (const name of [...managedAgentNames, ...managementToolNames])
    assert(identifiers.has(name), `orchestration guide does not name ${name}`);
});

test("production and portable seeds allow the two current child tools and answer, preserving send while denying retired notify", () => {
  for (const relative of [
    "../../resources/permissions.json",
    "../../test/policy/permissions.json",
  ]) {
    const permission = json(relative).permission;
    for (const tool of [...managementToolNames, "alert_parent", "ask_parent"])
      assert.equal(permission[tool], "allow", `${relative}: ${tool}`);
    assert.equal(permission.agent_send, "allow", "steering is still independently permitted");
    assert.equal(permission.agent_answer, "allow");
    assert.equal(permission.notify_parent, "deny", "no old allow or runtime alias");
    assert.equal(permission.web_search, "ask");
    assert.equal(permission.source_check, "ask");
    assert.equal(permission.fetch_content, "ask");
    assert.equal(permission.get_search_content, "allow");
    assert.equal(permission.path["*.env"], "deny");
    assert.equal(permission.path_write[".git/*"], "deny");
  }
});

test("generated managed definitions deny all current/retired parent tools and notify without changing local capability tables", () => {
  const policy = json("../../resources/worker-policy.json"),
    rendered = renderWorkers();
  assert.deepEqual(Object.keys(policy.profiles).sort(), ["editor", "researcher"]);
  assert.deepEqual(agentProfileNames, ["editor", "researcher"]);
  assert.equal(Object.hasOwn(rendered.agents, "reader"), false, "no active retired definition");
  assert.deepEqual(
    policy.childToolDenies,
    [...blockedDelegationToolNames],
    "source policy and assembly exclusion must be a matched API boundary",
  );
  for (const [name, profile] of Object.entries(policy.profiles)) {
    const definition = rendered.agents[name];
    const { frontmatter } = definitionParts(definition);
    const tools = JSON.parse(/^tools: (.+)$/m.exec(frontmatter)[1]);
    assert.match(frontmatter, /^prompt_mode: replace$/m);
    assert.match(frontmatter, /^inherit_context: false$/m);
    assert.deepEqual(tools, [
      ...policy.readTools.filter((tool) => profile.bash !== false || tool !== "bash"),
      ...(profile.edits ? ["edit", "write"] : []),
    ]);
    for (const tool of policy.childToolDenies) {
      assert.match(frontmatter, new RegExp(`^  ${tool}: deny$`, "m"), `${name}: ${tool}`);
      assert(!tools.includes(tool), `${name}: forbidden declared tool ${tool}`);
    }
    assert.equal(
      rendered.metadata[name].digest,
      createHash("sha256").update(definition).digest("hex"),
    );
    for (const spelling of ["git commit *", "git -C * push *", "git config *"])
      assert.equal(
        rendered.metadata[name].bashDenies.includes(spelling),
        name !== "editor",
        `${name}: shipped Git floor ${spelling}`,
      );
    if (!profile.edits) assert.match(frontmatter, /^ {2}path_write:\n {4}"\*": deny$/m);
    if (profile.bash === false) assert.match(frontmatter, /^ {2}bash:\n {4}"\*": deny$/m);
  }
  for (const name of policy.disabled) {
    const { frontmatter } = definitionParts(rendered.agents[name]);
    assert.match(frontmatter, /^enabled: false$/m);
    assert.match(frontmatter, /^tools: none$/m);
    assert.match(frontmatter, /^ {2}"\*": deny$/m);
  }
});

test("child prompts include shared and profile-specific sources without mixing profiles", () => {
  const { agents } = renderWorkers();
  const { profiles } = json("../../resources/worker-policy.json");
  const common = text("../../resources/agent.md").trim();
  const worker = text("../../resources/worker.md").trim();
  const scout = text("../../resources/scout.md").trim();
  assert(common && worker && scout, "all three source prompts must be nonempty");
  // Tool names are API identifiers. The surrounding guidance is reviewed as prose.
  for (const name of ["alert_parent", "ask_parent"])
    assert.match(common, new RegExp(`\\b${name}\\b`));
  for (const [name, own, other] of [
    ["editor", worker, scout],
    ["researcher", scout, worker],
  ]) {
    const { prompt } = definitionParts(agents[name]);
    assert(prompt.includes(common), `${name}: missing common prompt`);
    assert(prompt.includes(own), `${name}: missing profile prompt`);
    assert(!prompt.includes(other), `${name}: another profile's prompt leaked in`);
    if (profiles[name].prompt)
      assert(prompt.includes(profiles[name].prompt.trim()), `${name}: missing policy prompt`);
    assert.doesNotMatch(prompt, /\bnotify_parent\b/, `${name}: retired tool in prompt`);
  }
});

test("source render keeps cooperative editor Git permission-checked and researcher floors intact", () => {
  const policy = json("../../resources/worker-policy.json"),
    rendered = renderWorkers();
  assert.equal(policy.profiles.editor.gitDenyFloor, false);
  assert.deepEqual(
    rendered.metadata.editor.bashDenies,
    [],
    "no shipped child-only blanket Git bans for the cooperative worker",
  );
  const editor = definitionParts(rendered.agents.editor).frontmatter;
  assert.match(editor, /^ {2}bash:\n {4}"\*": ask$/m);
  assert.doesNotMatch(editor, /^ {4}"git .*": allow$/m, "no command-specific Git allow");
  for (const name of ["researcher"]) {
    assert.equal(policy.profiles[name].gitDenyFloor, undefined, `${name}: no opt-out`);
    const git = (commands) => [
      ...commands.map((command) => `git ${command}`),
      ...commands.map((command) => `git -C * ${command}`),
    ];
    assert.deepEqual(
      rendered.metadata[name].bashDenies,
      [
        ...git(policy.commonGitDenies),
        ...policy.gitSpellingDenies,
        ...git(policy.mutationGitDenies),
        ...policy.profiles[name].extraBashDenies,
      ],
      `${name}: exact historical Git floor order and spellings`,
    );
  }
  const researcher = definitionParts(rendered.agents.researcher).frontmatter;
  const tools = JSON.parse(/^tools: (.+)$/m.exec(researcher)[1]);
  for (const tool of ["bash", "edit", "write"])
    assert(!tools.includes(tool), `researcher: no ${tool}`);
  assert.match(researcher, /^ {2}bash:\n {4}"\*": deny$/m);
  assert.match(researcher, /^ {2}edit: deny$/m);
  assert.match(researcher, /^ {2}write: deny$/m);
});
