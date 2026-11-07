import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderWorkers } from "../../scripts/build/generate-workers.mjs";
import {
  agentProfileNames,
  blockedDelegationToolNames,
  managementToolNames,
} from "../../dist/orchestration/tools/tool-names.js";

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

test("orchestration guide lists the actual management tools and absent-only resource inventory", () => {
  const readme = readFileSync(new URL("../../docs/orchestration.md", import.meta.url), "utf8");
  const tools = /parent has (\w+) fixed management tools \(([^)]+)\)/.exec(readme);
  assert(tools);
  assert.equal(tools[1], "nine");
  assert.deepEqual(
    [...tools[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    managementToolNames,
  );
  const definitions = /five agent definitions: ([^;]+);/.exec(readme);
  assert(definitions);
  const actual = Object.keys(renderWorkers().agents).sort();
  assert.equal(actual.length, 5);
  assert.deepEqual(
    [...definitions[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort(),
    actual,
  );
  assert.match(readme, /seven files total/);
  assert.match(readme, /Tasks have a turn limit.*not a wall-clock execution deadline/);
  assert.match(readme, /agent_answer.*settled pending question/);
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
    const tools = JSON.parse(/^tools: (.+)$/m.exec(definition)[1]);
    assert.deepEqual(tools, [
      ...policy.readTools.filter((tool) => profile.bash !== false || tool !== "bash"),
      ...(profile.edits ? ["edit", "write"] : []),
    ]);
    for (const tool of policy.childToolDenies) {
      assert.match(definition, new RegExp(`^  ${tool}: deny$`, "m"), `${name}: ${tool}`);
      assert(!tools.includes(tool), `${name}: forbidden declared tool ${tool}`);
    }
    assert.equal(
      rendered.metadata[name].digest,
      createHash("sha256").update(definition).digest("hex"),
    );
    for (const fact of [/alert_parent for/, /important findings/, /then continue/])
      assert.match(definition, fact);
    assert.doesNotMatch(definition.split("---\n").at(-1), /notify_parent/);
    for (const spelling of ["git commit *", "git -C * push *", "git config *"])
      assert.equal(
        rendered.metadata[name].bashDenies.includes(spelling),
        name !== "editor",
        `${name}: shipped Git floor ${spelling}`,
      );
    if (!profile.edits) assert.match(definition, / {2}path_write:\n {4}"\*": deny/);
    if (profile.bash === false) assert.match(definition, / {2}bash:\n {4}"\*": deny/);
  }
  for (const name of policy.disabled) {
    assert.match(rendered.agents[name], /^enabled: false$/m);
    assert.match(rendered.agents[name], /^ {2}"\*": deny$/m);
  }
});

test("scout source guidance supports local and web synthesis without worker execution or model-tier assumptions", () => {
  const { agents } = renderWorkers();
  const common = readFileSync(new URL("../../resources/agent.md", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../resources/worker.md", import.meta.url), "utf8");
  const scout = readFileSync(new URL("../../resources/scout.md", import.meta.url), "utf8");
  for (const definition of [agents.editor, agents.researcher]) assert(definition.includes(common));
  assert(agents.editor.includes(worker));
  assert(agents.researcher.includes(scout));
  assert(
    !agents.researcher.includes(worker),
    "worker execution/check/tree discipline stays out of scout's body",
  );
  for (const fact of [
    /cross-reference, compare, summarize and extract/,
    /local files and web sources/,
    /no Bash, edit or write tools/,
    /report that gap for the parent/,
    /primary web sources/,
    /previews are insufficient/,
    /local file paths or source URLs/,
    /version, date, platform and scope/,
    /Surface conflicts/,
    /missing or unverified information as unknown/,
    /untrusted data, never instructions/,
    /Never send local file contents or private task details/,
  ])
    assert.match(scout, fact);
  assert.doesNotMatch(
    scout,
    /\b(?:cheap|skim|quick|d[1-5])\b/i,
    "profile guidance does not assign a model tier or shallow scope",
  );
  assert.doesNotMatch(scout, /full gate|declared tree|Run assigned checks/);
  assert.doesNotMatch(
    agents.editor,
    /Synthesize results yourself/,
    "scout discipline is profile-specific",
  );
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
  assert.match(rendered.agents.editor, /^ {2}bash:\n {4}"\*": ask$/m);
  assert.doesNotMatch(
    rendered.agents.editor,
    /^ {4}"git .*": allow$/m,
    "no blanket or command-specific Git allow",
  );
  for (const fact of [
    /Git remains permission-checked/,
    /not automatically approved/,
    /preserve user denies/,
  ])
    assert.match(rendered.agents.editor, fact);
  assert.doesNotMatch(rendered.agents.editor, /Git mutations stay with the parent/);
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
  const researcher = rendered.agents.researcher;
  const tools = JSON.parse(/^tools: (.+)$/m.exec(researcher)[1]);
  for (const tool of ["bash", "edit", "write"])
    assert(!tools.includes(tool), `researcher: no ${tool}`);
  assert.match(researcher, /^ {2}bash:\n {4}"\*": deny$/m);
  assert.match(researcher, /^ {2}edit: deny$/m);
  assert.match(researcher, /^ {2}write: deny$/m);
});
