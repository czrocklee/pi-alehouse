import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { packCommunication } from "../../dist/core/communication-packer.js";
import { createModelFixtureSubmit } from "../support/model-fixture-names.mjs";

// Portable only: parse host source as data; never import/execute a host fixture,
// loadHost, a collector, a provider or a real Owner.
const fixtureSource = (name) => {
  const path = new URL(`../host/${name}.mjs`, import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  assert.deepEqual(source.parseDiagnostics, [], `invalid fixture syntax: ${path.pathname}`);
  return source;
};
function nodes(root, predicate) {
  const found = [];
  const visit = (node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root); return found;
}
const methodCall = (node, method) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === method;
const contains = (parent, child) => parent && parent.pos <= child.pos && child.end <= parent.end;
function enclosingBranch(node, name, side = "thenStatement") {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.expression.getText() === name && contains(parent[side], node)) return parent;
  }
  return undefined;
}
function submitFactory(source) {
  const bindings = nodes(source, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "submit");
  assert.equal(bindings.length, 1, "all ordinary submissions need one shared naming facade");
  const factory = bindings[0].initializer;
  assert(ts.isCallExpression(factory)); assert.equal(factory.expression.getText(), "createModelFixtureSubmit");
  assert.equal(factory.arguments[0].getText(), "controller"); assert.equal(factory.arguments[1].getText(), "effective");
  assert.equal(factory.arguments.length, 3); assert(ts.isStringLiteral(factory.arguments[2]));
  const imports = nodes(source, (node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "../support/model-fixture-names.mjs");
  assert.equal(imports.length, 1); assert.equal(imports[0].importClause.namedBindings.elements[0].name.text, "createModelFixtureSubmit");
  return factory.arguments[2].text;
}
const recordingSubmit = (theme) => {
  const requests = [], settings = { profile: "reader", definition_digest: "synthetic" };
  const controller = { submit: (id, request) => { requests.push({ id, request }); return request; } };
  return { submit: createModelFixtureSubmit(controller, settings, theme), requests, settings };
};
const validName = (name) => typeof name === "string" && name.length <= 24 && /^[a-z][a-z0-9-]{0,23}$/.exec(name)?.[0] === name;

for (const theme of ["foal", "hare", "abcdefg"]) {
  test(`${theme}: fresh names are unique, short ASCII regardless of request ID/label`, () => {
    const { submit, requests, settings } = recordingSubmit(theme);
    for (let index = 0; index < 128; index++) submit(`長い依頼-${index}-${"x".repeat(256)}`, "月兔 task", undefined, { description: "Unicode label: 潮兔" });
    assert.equal(new Set(requests.map(({ request }) => request.name)).size, requests.length);
    for (const { request } of requests) {
      assert(validName(request.name)); assert.equal(request.settings, settings);
      assert.equal(request.prompt, "月兔 task"); assert.equal(request.description, "Unicode label: 潮兔");
    }
  });
}
test("request replay keeps its name; resume cannot rename the original Agent or settings", () => {
  const { submit, requests } = recordingSubmit("hare");
  const first = submit("first", "task one"), peer = submit("peer", "task two");
  assert.equal(submit("first", "task one").name, first.name); assert.notEqual(peer.name, first.name);
  const resumed = submit("resume", "follow-up", "existing-agent", { max_turns: 1, max_duration_ms: 100, after: ["peer"] });
  assert.deepEqual(resumed, { resume: "existing-agent", prompt: "follow-up", max_turns: 1, max_duration_ms: 100, after: ["peer"] });
  assert.equal(requests.length, 4);
});
test("identity/settings overrides and invalid naming themes fail before submission", () => {
  const { submit, requests } = recordingSubmit("hare");
  for (const options of [{ name: "月兔" }, { name: "hare-1" }, { settings: {} }, { resume: "other" }, { prompt: "other" }]) {
    assert.throws(() => submit("bad", "task", undefined, options), /cannot override/);
    assert.throws(() => submit("bad", "task", "existing-agent", options), /cannot override/);
  }
  for (const theme of ["", "月兔", "abcdefgh", "Upper", "hare\n", "hare_"]) {
    assert.throws(() => recordingSubmit(theme), /Invalid fixture name theme/);
  }
  assert.throws(() => submit("", "task"), /needs an ID/); assert.equal(requests.length, 0);
});

test("session-replacement has no unnamed/raw submissions outside the naming facade", () => {
  const source = fixtureSource("session-replacement"); assert.equal(submitFactory(source), "foal");
  assert.equal(nodes(source, (node) => methodCall(node, "submit")).length, 0);
  assert.equal(nodes(source, (node) => methodCall(node, "observe")).length, 1, "review model observation drift explicitly");
});
test("run-lifecycle keeps Unicode naming exclusively in isolated lifecycle-only branches", () => {
  const source = fixtureSource("run-lifecycle"); assert.equal(submitFactory(source), "hare");
  const raw = nodes(source, (node) => methodCall(node, "submit"));
  assert.equal(raw.length, 2, "fresh model-lane submissions must use the naming facade, including historical candidates");
  const guards = new Set();
  for (const call of raw) {
    assert.equal(call.expression.expression.getText(), "controller");
    const guard = enclosingBranch(call, "boundary") ?? enclosingBranch(call, "natural");
    assert(guard, "raw Unicode submission must stay in a lifecycle-only scenario"); guards.add(guard.expression.getText());
    assert.equal(nodes(guard.thenStatement, (node) => methodCall(node, "observe")).length, 0);
    const name = call.arguments[1].properties.find((property) => property.name?.getText() === "name").initializer;
    assert.match(name.getText(), /月兔|潮兔/, "retain Unicode naming coverage rather than silently deleting it");
  }
  assert.deepEqual([...guards].sort(), ["boundary", "natural"]);
  const modelCalls = nodes(source, (node) => methodCall(node, "observe")); assert.equal(modelCalls.length, 1);
  assert(enclosingBranch(modelCalls[0], "boundary", "elseStatement"));
  assert(enclosingBranch(modelCalls[0], "natural", "elseStatement"), "model observations may only enter the regular ASCII lane");
});

// Use the real host source's fresh request IDs through the shared facade, then
// pure-pack all of their old finished Runs. This catches invalid candidates
// beyond the eight convenience rows, not merely the bound target's name.
for (const fixture of ["session-replacement", "run-lifecycle"]) {
  test(`${fixture}: all fresh submissions and global finished candidates fit model projection`, () => {
    const source = fixtureSource(fixture), { submit, requests } = recordingSubmit(submitFactory(source));
    const fresh = nodes(source, (node) => ts.isCallExpression(node) && node.expression.getText() === "submit" &&
      (node.arguments[2] === undefined || node.arguments[2].getText() === "undefined"));
    assert(fresh.length > 0, "zero fixture submissions is not coverage");
    for (const call of fresh) {
      assert(ts.isStringLiteral(call.arguments[0]));
      submit(call.arguments[0].text, "synthetic lifecycle task");
    }
    if (fixture === "run-lifecycle") assert(requests.some(({ id }) => id === "queued-after-parent-fault"));
    assert.equal(new Set(requests.map(({ request }) => request.name)).size, requests.length);
    const names = requests.map(({ request }) => request.name);
    // More than eight old rows deliberately exercises validation of unshown
    // finished candidates. Same-Agent reuse has distinct task ordinals.
    const finished = names.flatMap((agent) => Array.from({ length: 5 }, (_, index) => ({ row: { agent, task: index + 1, status: "completed" } })));
    assert(finished.length > 8);
    const agent = names.at(-1);
    for (const reason of ["alert", "owner_blocked"]) {
      const input = { reason, tasks: [{ row: { agent, task: 6, status: "queued" }, settled: false }], finished,
        alerts: [{ agent: names[0], task: 1, label: "月兔: lifecycle result", message: "synthetic decision alert" }],
        ...(reason === "owner_blocked" ? { blocked: "synthetic parent history fault" } : {}) };
      const { envelope, result } = packCommunication(input);
      assert.equal(envelope.reason, reason); assert.equal(envelope.agents[0].agent, agent);
      assert.equal(envelope.alerts[0].label, input.alerts[0].label);
      assert.equal(envelope.finished.length, 8); assert.equal(envelope.finished_pending, finished.length - 8);
      assert.deepEqual(JSON.parse(result.content[0].text), envelope);
      for (const row of [...envelope.agents, ...envelope.finished, ...envelope.alerts]) assert(validName(row.agent));
      for (const invalid of ["", "月兔", "a".repeat(25)]) {
        const bad = structuredClone(input); bad.finished.at(-1).row.agent = invalid;
        assert.throws(() => packCommunication(bad), { code: "INVALID_COMMUNICATION_SNAPSHOT" }, "even unshown global candidates need valid names");
      }
      const duplicate = structuredClone(input); duplicate.finished.at(-1).row = { ...duplicate.finished[0].row };
      assert.throws(() => packCommunication(duplicate), { code: "INVALID_COMMUNICATION_SNAPSHOT" }, "different Agents cannot share a task identity");
    }
  });
}
