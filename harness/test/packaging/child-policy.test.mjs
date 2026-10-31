import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderWorkers } from "../../../scripts/generate-workers.mjs";
import { agentProfileNames, blockedDelegationToolNames, managementToolNames } from "../../dist/tools/tool-names.js";

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

test("production and portable seeds allow the two current child tools and answer, preserving send while denying retired notify", () => {
  for (const relative of ["../../../resources/permissions.json", "../../../test/policy/permissions.json"]) {
    const permission = json(relative).permission;
    for (const tool of [...managementToolNames, "alert_parent", "ask_parent"]) assert.equal(permission[tool], "allow", `${relative}: ${tool}`);
    assert.equal(permission.agent_send, "allow", "steering is still independently permitted");
    assert.equal(permission.agent_answer, "allow");
    assert.equal(permission.notify_parent, "deny", "no old allow or runtime alias");
    assert.equal(permission.web_search, "ask"); assert.equal(permission.fetch_content, "ask");
    assert.equal(permission.get_search_content, "allow");
    assert.equal(permission.path["*.env"], "deny");
    assert.equal(permission.path_write[".git/*"], "deny");
  }
});

test("generated managed definitions deny all current/retired parent tools and notify without changing local capability tables", () => {
  const policy = json("../../../resources/worker-policy.json"), rendered = renderWorkers();
  assert.deepEqual(Object.keys(policy.profiles).sort(), ["editor", "researcher"]);
  assert.deepEqual(agentProfileNames, ["editor", "researcher"]);
  assert.equal(Object.hasOwn(rendered.agents, "reader"), false, "no active retired definition");
  assert.deepEqual(policy.childToolDenies, [...blockedDelegationToolNames], "source policy and assembly exclusion must be a matched API boundary");
  for (const [name, profile] of Object.entries(policy.profiles)) {
    const definition = rendered.agents[name];
    const tools = JSON.parse(/^tools: (.+)$/m.exec(definition)[1]);
    assert.deepEqual(tools, [...policy.readTools.filter((tool) => profile.bash !== false || tool !== "bash"),
      ...(profile.edits ? ["edit", "write"] : [])]);
    for (const tool of policy.childToolDenies) {
      assert.match(definition, new RegExp(`^  ${tool}: deny$`, "m"), `${name}: ${tool}`);
      assert(!tools.includes(tool), `${name}: forbidden declared tool ${tool}`);
    }
    assert.equal(rendered.metadata[name].digest, createHash("sha256").update(definition).digest("hex"));
    assert.match(definition, /Use alert_parent for decision-relevant facts/);
    assert.doesNotMatch(definition.split("---\n").at(-1), /notify_parent/);
    for (const spelling of ["git commit *", "git -C * push *", "git config *"])
      assert.equal(rendered.metadata[name].bashDenies.includes(spelling), name !== "editor", `${name}: shipped Git floor ${spelling}`);
    if (!profile.edits) assert.match(definition, / {2}path_write:\n {4}"\*": deny/);
    if (profile.bash === false) assert.match(definition, / {2}bash:\n {4}"\*": deny/);
  }
  for (const name of policy.disabled) {
    assert.match(rendered.agents[name], /^enabled: false$/m);
    assert.match(rendered.agents[name], /^ {2}"\*": deny$/m);
  }
});

test("source render keeps cooperative editor Git permission-checked and researcher floors intact", () => {
  const policy = json("../../../resources/worker-policy.json"), rendered = renderWorkers();
  assert.equal(policy.profiles.editor.legacyGitDenies, false);
  assert.deepEqual(rendered.metadata.editor.bashDenies, [], "no shipped child-only blanket Git bans for the cooperative worker");
  assert.match(rendered.agents.editor, /^ {2}bash:\n {4}"\*": ask$/m);
  assert.doesNotMatch(rendered.agents.editor, /^ {4}"git .*": allow$/m, "no blanket or command-specific Git allow");
  assert.match(rendered.agents.editor, /including add and commit, remain permission-checked, not automatically approved/);
  assert.doesNotMatch(rendered.agents.editor, /Git mutations stay with the parent/);
  for (const name of ["researcher"]) {
    assert.equal(policy.profiles[name].legacyGitDenies, undefined, `${name}: no opt-out`);
    const git = (commands) => [...commands.map((command) => `git ${command}`), ...commands.map((command) => `git -C * ${command}`)];
    assert.deepEqual(rendered.metadata[name].bashDenies, [
      ...git(policy.commonGitDenies), ...policy.gitSpellingDenies,
      ...git(policy.mutationGitDenies), ...policy.profiles[name].extraBashDenies,
    ], `${name}: exact historical Git floor order and spellings`);
  }
  const researcher = rendered.agents.researcher;
  const tools = JSON.parse(/^tools: (.+)$/m.exec(researcher)[1]);
  for (const tool of ["bash", "edit", "write"]) assert(!tools.includes(tool), `researcher: no ${tool}`);
  assert.match(researcher, /^ {2}bash:\n {4}"\*": deny$/m);
  assert.match(researcher, /^ {2}edit: deny$/m);
  assert.match(researcher, /^ {2}write: deny$/m);
});
