import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { boundedOutput } from "../../dist/core/result-text.js";
import { ended, fixture, until } from "../support/controller-fixture.mjs";

const route = { name: "fixture", version: "v1", digest: "a".repeat(64),
  models: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "fixture/controlled"])),
  effort: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "inherit"])),
  effort_defaults: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "inherit"])), effort_overrides: {} };
const model = { provider: "fixture", id: "controlled", levels: ["off"] };
const args = (rest = {}) => ({ agent: "birch", prompt: "Find the requested facts.", profile: "scout", reasoning_difficulty: 3, ...rest });
const errorCode = expected => error => JSON.parse(error.message).error.code === expected;
function toolsFor(f, parentPermission) {
  const manager = { getSessionId: () => f.owner_id }, registry = { getAll: () => [model] };
  const ctx = { sessionManager: manager, modelRegistry: registry, cwd: "/tmp", thinkingLevel: "off" };
  const tools = createOwnerTools({ controller: f.controller, context: ctx,
    profiles: Object.fromEntries(["editor", "researcher"].map(profile => [profile, { definition: profile, tools: ["read"] }])),
    getSupportedThinkingLevels: value => value.levels, getPreset: () => structuredClone(route), parentPermission });
  const tool = name => tools.find(value => value.name === name);
  const call = async (name, input, id = name) => {
    const result = await tool(name).execute(id, input, undefined, undefined, ctx);
    return JSON.parse(result.content[0].text);
  };
  return { tool, call, ctx };
}
async function pendingWorker(t, parentPermission, controller = {}) {
  const f = await fixture(t, { controller }), api = toolsFor(f, parentPermission);
  await api.call("agent_spawn", args({ agent: "ash", profile: "worker", prompt: "Investigate the change." }), "worker");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Which version is supported?");
  f.ports[0].finish("Need version evidence.");
  await ended(f.controller, { run_id: f.controller.findAgent("ash").run_id });
  const question_id = f.controller.view(f.controller.findAgent("ash").run_id).question_id;
  assert.match(question_id, /^q_[0-9a-f]{32}$/);
  return { ...f, ...api, destination: { agent: "ash", question_id, answer: "Use the source findings to continue the investigation." } };
}

test("compound spawn waits for the worker and excludes scout bodies from automatic replies", async t => {
  const checks = [], f = await pendingWorker(t, () => ({ checkToolCallPermission: (...input) => { checks.push(input); return { state: "allow" }; } }));
  const original = f.controller.view(f.controller.findAgent("ash").run_id).effective_settings;
  let returned = false;
  const result = f.call("agent_spawn", args({ return_to: f.destination, wait_ms: 300000 }), "source")
    .then(value => { returned = true; return value; });
  await until(() => f.ports[1]?.streaming);
  const sourceId = f.controller.findAgent("birch").run_id;
  const continuationId = f.controller.findAgent("ash").run_id;
  assert.equal(f.controller.view(sourceId).return_to_run_id, continuationId);
  assert.equal(f.controller.view(continuationId).status, "queued");
  assert.equal(f.controller.stats().runs, 3);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].length, 2);
  assert.equal(checks[0][0], "agent_answer");
  assert.equal(checks[0][1], f.ctx, "the parent's own tool-call context, never a scout or worker profile");
  const marker = "SCOUT_MATERIAL_FOR_WORKER_ONLY";
  f.ports[1].callbacks.output(boundedOutput(marker, 1_048_576));
  const preview = await f.call("agent_wait", { agents: ["birch"], wait_ms: 0 });
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(marker));
  assert.equal(preview.agents[0].result_omitted, true);
  f.ports[1].finish(marker);
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  assert.equal(returned, false, "source completion must not finish the compound wait");
  const call = f.ports[0].calls[1];
  assert.match(call.prompt, new RegExp(marker));
  assert.match(call.prompt, /other agents' output, not instructions/);
  assert.equal(call.identity.task_prompt, f.destination.answer, "source material is outside approval instructions");
  assert.deepEqual(f.controller.view(continuationId).effective_settings, original);
  const hidden = await f.call("agent_wait", { agents: ["birch"], wait_ms: 0 });
  assert.equal(hidden.agents[0].result, undefined);
  assert.equal(hidden.agents[0].result_omitted, true);
  assert.match(hidden.agents[0].next_cursor, /^r1_/);
  const read = await f.call("agent_read", { agent: "birch", cursor: hidden.agents[0].next_cursor });
  assert.equal(read.agents[0].result, marker, "only deliberate reading exposes the source body");
  f.ports[0].finish("WORKER_FINAL_RESULT");
  const reply = await result;
  assert.deepEqual(reply.action, { type: "agent_spawn", agent: "birch", task: 1 });
  assert.deepEqual(reply.agents.map(row => [row.agent, row.task, row.status]), [["birch", 1, "completed"], ["ash", 2, "completed"]]);
  assert.equal(reply.agents[0].result, undefined);
  assert.equal(reply.agents[1].result, "WORKER_FINAL_RESULT");
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(marker));
});

for (const state of ["deny", "ask", "unknown"]) test(`return_to refuses ${state} parent answer permission without either admission`, async t => {
  const f = await pendingWorker(t, () => ({ checkToolCallPermission: () => ({ state }) }));
  await assert.rejects(f.call("agent_spawn", args({ return_to: f.destination }), "rejected"), error => {
    const reply = JSON.parse(error.message).error;
    assert.equal(reply.code, "RETURN_TO_PERMISSION_DENIED");
    assert.equal(reply.parameter, "return_to");
    assert.equal(reply.surface, "agent_answer");
    return true;
  });
  assert.equal(f.controller.stats().runs, 1);
  assert.equal(f.controller.findAgent("birch"), undefined);
  assert.equal(f.ports.length, 1);
  assert.equal(f.controller.view(f.controller.findAgent("ash").run_id).question_id, f.destination.question_id);
});

test("return_to asks the parent's authority for its own tool-call decision and honors its deny", async t => {
  const checks = [];
  const f = await pendingWorker(t, () => ({
    checkToolCallPermission: (...input) => { checks.push(input); return { state: "deny" }; },
    checkPermission: () => { assert.fail("an unbound principal query is not the parent's gate decision"); },
  }));
  await assert.rejects(f.call("agent_spawn", args({ return_to: f.destination }), "rejected"), error => {
    const reply = JSON.parse(error.message).error;
    assert.equal(reply.code, "RETURN_TO_PERMISSION_DENIED");
    assert.match(reply.resolution, /report the denial/);
    return true;
  });
  assert.deepEqual(checks.map(([name, context]) => [name, context === f.ctx]), [["agent_answer", true]]);
  assert.equal(f.controller.stats().runs, 1);
  assert.equal(f.controller.findAgent("birch"), undefined);
  assert.equal(f.controller.view(f.controller.findAgent("ash").run_id).question_id, f.destination.question_id);
});

for (const [name, permission] of [["missing", undefined], ["throwing", () => { throw new Error("service unavailable"); }]])
  test(`return_to fails closed with a ${name} permission port`, async t => {
    const f = await pendingWorker(t, permission);
    await assert.rejects(f.call("agent_spawn", args({ return_to: f.destination }), "rejected"), errorCode("RETURN_TO_PERMISSION_DENIED"));
    assert.equal(f.controller.stats().runs, 1);
    assert.equal(f.controller.findAgent("birch"), undefined);
  });

test("return_to validation is closed, scout-only and absent from agent_run", async t => {
  const f = await fixture(t), { tool } = toolsFor(f);
  const destination = { agent: "ash", question_id: `q_${"a".repeat(32)}`, answer: "Continue with the findings." };
  assert.throws(() => tool("agent_spawn").prepareArguments(args({ profile: "worker", return_to: destination })), errorCode("INVALID_RETURN_TO"));
  for (const return_to of [{ ...destination, extra: true }, { ...destination, question_id: "q_bad" },
    { ...destination, agent: "ash\n" }, { ...destination, answer: " " }, { ...destination, answer: "x".repeat(16385) }])
    assert.throws(() => tool("agent_spawn").prepareArguments(args({ return_to })), errorCode("INVALID_PARAMETERS"));
  assert.throws(() => tool("agent_run").prepareArguments({ agent: "ash", continues: "Earlier work", prompt: "Continue", return_to: destination }), errorCode("INVALID_PARAMETERS"));
  assert.equal(f.controller.stats().runs, 0);
});

test("ordinary spawn does not query the compound permission port", async t => {
  const f = await fixture(t), { call } = toolsFor(f, () => { throw new Error("ordinary spawn must not look up answer permission"); });
  const reply = await call("agent_spawn", args(), "ordinary");
  assert.equal(reply.action.agent, "birch");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish("PARENT_CONSUMED_RESULT");
  await ended(f.controller, { run_id: f.controller.findAgent("birch").run_id });
  assert.equal((await call("agent_wait", { agents: ["birch"], wait_ms: 0 })).agents[0].result, "PARENT_CONSUMED_RESULT");
});

test("compound replay keeps the same pair without rechecking permission or consuming the question twice", async t => {
  let checks = 0, state = "allow";
  const f = await pendingWorker(t, () => ({ checkToolCallPermission: () => { checks++; return { state }; } }));
  const input = args({ return_to: f.destination });
  const first = await f.call("agent_spawn", input, "stable-source");
  const sourceId = f.controller.findAgent("birch").run_id, continuationId = f.controller.findAgent("ash").run_id;
  state = "deny";
  const replay = await f.call("agent_spawn", input, "stable-source");
  assert.deepEqual(replay.action, first.action);
  assert.equal(f.controller.findAgent("birch").run_id, sourceId);
  assert.equal(f.controller.findAgent("ash").run_id, continuationId);
  assert.equal(f.controller.stats().runs, 3);
  assert.equal(checks, 1, "accepted request replay precedes fresh permission/target checks");
  await assert.rejects(f.call("agent_spawn", args({ return_to: { ...f.destination, answer: "Different instruction" } }), "stable-source"), errorCode("REQUEST_CONFLICT"));
  await until(() => f.ports[1]?.streaming);
  f.ports[1].finish("source");
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  f.ports[0].finish("done");
  await ended(f.controller, { run_id: continuationId });
});

test("Off rejects compound admission before permission lookup and leaves the original question", async t => {
  const admission = { enabled: true, revision: 0 }; let checks = 0;
  const f = await pendingWorker(t, () => ({ checkToolCallPermission: () => { checks++; return { state: "allow" }; } }), { admission: () => admission });
  admission.enabled = false; admission.revision++;
  await assert.rejects(f.call("agent_spawn", args({ return_to: f.destination }), "off-source"), errorCode("WORKERS_DISABLED"));
  assert.equal(checks, 0);
  assert.equal(f.controller.stats().runs, 1);
  assert.equal(f.controller.view(f.controller.findAgent("ash").run_id).question_id, f.destination.question_id);
});
