import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HarnessError } from "../../dist/core/ports.js";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { fixture, task, tick, until } from "../support/controller-fixture.mjs";

// Real OwnerController, FileOwnerLease and production tool factory. Only child
// execution and host context/configuration are controlled fixtures; no provider,
// host collector, UI-authority or generic alert-retrieval claim is made here.
const hasCode = (code, details = {}) => (error) => {
  assert(error instanceof HarnessError); assert.equal(error.code, code);
  for (const [key, value] of Object.entries(details)) assert.equal(error.details[key], value);
  return true;
};
const finishedBit = (c, run) => c.runs.get(run.run_id).finished_presented; // Inspect original presentation evidence only.
const invalidNames = [undefined, "月兔", "a".repeat(25), "otter\n"];
const profiles = () => Object.fromEntries(["reader", "editor", "researcher"].map((name) =>
  [name, { definition: `${name} fixture definition`, tools: ["read"] }]));

function toolOptions(f) {
  const model = { provider: "fixture", id: "controlled", levels: ["off", "high"] };
  const manager = { getSessionId: () => f.owner_id, buildSessionProjection: () => ({ messages: [] }) };
  return { controller: f.controller, context: { sessionManager: manager, cwd: "/tmp", model,
    thinkingLevel: "off", modelRegistry: { getAll: () => [model] } }, profiles: profiles(),
  getSupportedThinkingLevels: (selected) => selected.levels,
  getPreset: () => ({ name: "fixture", version: "v1", digest: "a".repeat(64),
    models: { light: "fixture/controlled", standard: "fixture/controlled", strong: "fixture/controlled" },
    thinking: { light: {}, standard: {}, strong: {} },
    effort: { light: "inherit", standard: "inherit", strong: "inherit" },
    effort_defaults: { light: "inherit", standard: "inherit", strong: "inherit" }, effort_overrides: {} }) };
}
function assemble(f, options = toolOptions(f)) {
  const tools = createOwnerTools(options);
  assert.equal(tools.length, 9);
  return { tools, call: async (name, args, signal) => {
    const result = await tools.find((tool) => tool.name === name).execute(randomUUID(), args, signal, undefined, options.context);
    assert.equal(result.details, undefined); assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text");
    return JSON.parse(result.content[0].text);
  } };
}
async function started(f, id, name) {
  const run = await f.controller.submit(id, task(id, { name }));
  await until(() => f.ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id));
  return { run, port: f.ports.find((port) => port.calls.at(-1)?.identity.run_id === run.run_id) };
}
async function settle(c, run) {
  assert.equal(await c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
  assert.equal(c.view(run.run_id).phase, "settled");
}
function facts(f, runs) {
  const c = f.controller, stats = c.stats();
  return { agents: stats.agents, runs: stats.runs, requests: stats.requests, resident: stats.resident,
    active: stats.active, queued: stats.queued, internal_error: stats.internal_error,
    parent_error: stats.parent_error, cleanup_uncertain: stats.cleanup_uncertain,
    retained_output_chars: stats.retained_output_chars, reserved_output_chars: stats.reserved_output_chars,
    originals: runs.map((run) => {
      const view = c.view(run.run_id);
      return { agent_id: view.agent_id, run_id: view.run_id, name: view.name, task: view.task, status: view.status,
        phase: view.phase, resident: view.resident, pending_messages: view.pending_messages,
        question_id: view.question_id, finished_presented: finishedBit(c, run), result: c.getResult(run.run_id).text };
    }), ports: f.ports.map((port) => ({ calls: port.calls.length, stopped: port.stopped, disposed: port.disposed })) };
}

test("fresh production assembly fences direct core names and lifetime collisions before allocating or presenting any facts", async (t) => {
  const f = await fixture(t), c = f.controller;
  const { call } = assemble(f);
  const existing = await started(f, "accepted", "otter");
  existing.port.callbacks.alert("original pending alert"); existing.port.finish("original retained result"); await settle(c, existing.run);
  const before = facts(f, [existing.run]);
  for (const [index, name] of [...invalidNames, " "].entries()) {
    await assert.rejects(c.submit(`invalid-${index}`, task("invalid", { name })),
      hasCode(name === " " ? "INVALID_PARAMETER" : "INVALID_MODEL_AGENT_NAME"));
    assert.deepEqual(facts(f, [existing.run]), before);
  }
  await assert.rejects(c.submit("duplicate", task("duplicate", { name: "otter" })), hasCode("AGENT_EXISTS"));
  assert.deepEqual(facts(f, [existing.run]), before);
  assert.equal((await c.release(existing.run.agent_id)).released, true);
  const released = facts(f, [existing.run]);
  await assert.rejects(c.submit("duplicate-released", task("duplicate released", { name: "otter" })), hasCode("AGENT_EXISTS"));
  assert.deepEqual(facts(f, [existing.run]), released);
  // A rejected request ID was never allocated/cached; correcting it is new work.
  const repaired = await c.submit("invalid-0", task("valid repair", { name: "orca" }));
  assert.equal(repaired.task, 1); assert.equal(c.stats().runs, 2); assert.equal(c.stats().requests, 2);
  assert.equal(c.view(existing.run.run_id).pending_messages, 1); assert.equal(finishedBit(c, existing.run), false);
  const historical = await call("agent_read", { agent: "otter" });
  assert.equal(historical.agents[0].result, "original retained result");
  assert.equal(historical.alerts[0].message, "original pending alert"); assert.equal(finishedBit(c, existing.run), true);
});

for (const [index, name] of invalidNames.entries())
  test(`binding closes admission-time race for pre-binding queued incompatible name ${index}`, async (t) => {
    const f = await fixture(t), c = f.controller;
    const pending = c.submit("queued-before-binding", task("queued before binding", { name }));
    const rejected = assert.rejects(pending, hasCode("INVALID_MODEL_AGENT_NAME"));
    // No await: the submit tail has not admitted the request when assembly binds.
    assemble(f);
    assert.equal(c.stats().runs, 0);
    await rejected; await tick();
    assert.equal(c.stats().agents, 0); assert.equal(c.stats().runs, 0); assert.equal(c.stats().requests, 0);
    assert.equal(f.ports.length, 0); assert.equal(c.stats().internal_error, undefined);
    const repaired = await c.submit("queued-before-binding", task("repaired", { name: "otter" }));
    assert.equal(repaired.task, 1); assert.equal(c.stats().runs, 1);
  });

test("two same-name direct submissions queued before assembly can admit only one original Agent", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), c = f.controller;
  const first = c.submit("first", task("first", { name: "otter" }));
  const second = c.submit("second", task("second", { name: "otter" }));
  const outcomes = Promise.allSettled([first, second]);
  assemble(f);
  const [one, two] = await outcomes;
  assert.equal(one.status, "fulfilled"); assert.equal(two.status, "rejected"); hasCode("AGENT_EXISTS")(two.reason);
  assert.equal(c.stats().agents, 1); assert.equal(c.stats().runs, 1); assert.equal(c.stats().requests, 1);
  assert.equal(c.findAgent("otter").agent_id, one.value.agent_id);
  const corrected = await c.submit("second", task("second", { name: "orca" }));
  assert.notEqual(corrected.agent_id, one.value.agent_id); assert.equal(corrected.task, 1);
  assert.equal(c.stats().requests, 2); assert.equal(c.stats().internal_error, undefined);
});

test("accepted generic request replays unchanged after binding and Off; binding neither consumes facts nor disappears", async (t) => {
  let admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => admission } }), c = f.controller;
  const input = task("pre-binding", { name: "otter" }), run = await c.submit("original", input);
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.alert("retained across binding"); f.ports[0].finish("accepted result"); await settle(c, run);
  const before = facts(f, [run]), { call } = assemble(f);
  assert.deepEqual(facts(f, [run]), before);
  assert.equal((await c.submit("original", input)).run_id, run.run_id);
  admission = { enabled: false, revision: 1 };
  assert.equal((await c.submit("original", input)).run_id, run.run_id);
  assert.deepEqual(facts(f, [run]), before);
  const inspected = await call("agent_read", { agent: "otter" });
  assert.equal(inspected.workers_disabled, true); assert.equal(inspected.alerts[0].message, "retained across binding");
  const afterRead = facts(f, [run]);
  assert.equal((await c.submit("original", input)).run_id, run.run_id);
  assert.deepEqual(facts(f, [run]), afterRead);
  assert.equal((await call("agent_read", { agent: "otter" })).alerts, undefined);
  await assert.rejects(c.submit("off-new", task("off new", { name: "orca" })), hasCode("WORKERS_DISABLED"));
  admission = { enabled: true, revision: 2 };
  await assert.rejects(c.submit("still-bound", task("still bound")), hasCode("INVALID_MODEL_AGENT_NAME"));
  await assert.rejects(c.submit("name-still-taken", task("duplicate", { name: "otter" })), hasCode("AGENT_EXISTS"));
  assert.equal(c.stats().runs, 1); assert.equal(f.ports[0].calls.length, 1);
});

test("bound tools keep read/wait, timeout/abort and accepted child communication healthy while Off", async (t) => {
  let admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => admission } }), c = f.controller;
  const { call } = assemble(f), { run, port } = await started(f, "ongoing", "otter");
  const timeout = await call("agent_wait", { agents: ["otter"], wait_ms: 0 });
  assert.equal(timeout.reason, "timeout"); assert.equal(port.stopped, 0);
  admission = { enabled: false, revision: 1 };
  port.callbacks.alert("accepted while Off");
  const aborted = await call("agent_wait", { agents: ["otter"], wait_ms: 300000 }, AbortSignal.abort());
  assert.equal(aborted.reason, "aborted"); assert.equal(aborted.workers_disabled, true);
  assert.equal(aborted.alerts, undefined); assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
  const snapshot = await call("agent_read", { agent: "otter" });
  assert.equal(snapshot.reason, "snapshot"); assert.equal(snapshot.workers_disabled, true);
  assert.equal(snapshot.alerts[0].message, "accepted while Off"); assert.equal(port.stopped, 0);
  const offTimeout = await call("agent_wait", { agents: ["otter"], wait_ms: 0 });
  assert.equal(offTimeout.reason, "timeout"); assert.equal(offTimeout.workers_disabled, true);
  port.callbacks.question("Accepted task may still ask while Off?"); port.finish("needs input"); await settle(c, run);
  const asking = await call("agent_wait", { agents: ["otter"], wait_ms: 0 });
  assert.equal(asking.reason, "question"); assert.equal(asking.workers_disabled, true);
  assert.match(asking.agents[0].question_id, /^q_[0-9a-f]{32}$/);
  assert.equal((await call("agent_wait", { wait_ms: 0 })).reason, "nothing_pending");
  const before = facts(f, [run]); assemble(f); // Idempotent reassembly also consumes nothing.
  assert.deepEqual(facts(f, [run]), before); assert.equal(c.stats().internal_error, undefined);
  admission = { enabled: true, revision: 2 };
  await assert.rejects(c.submit("not-unbound", task("invalid after Off", { name: "月兔" })), hasCode("INVALID_MODEL_AGENT_NAME"));
});

for (const [index, name] of invalidNames.entries())
  test(`incompatible retained generic identity ${index}, including released history, rejects assembly without changing generic facts`, async (t) => {
    const f = await fixture(t), c = f.controller, { run, port } = await started(f, "generic-history", name);
    port.callbacks.alert("accepted generic alert stays pending"); port.finish("generic retained result"); await settle(c, run);
    assert.equal((await c.release(run.agent_id)).released, true);
    const before = facts(f, [run]);
    assert.throws(() => assemble(f), hasCode("UNSUPPORTED_MODEL_AGENT_IDENTITY", { reason: "invalid_name" }));
    assert.deepEqual(facts(f, [run]), before);
    assert.equal(c.view(run.run_id).name, name ?? "");
    assert.equal(c.list({ include_released: true })[0].run_id, run.run_id);
    assert.equal(c.getResult(run.run_id).text, "generic retained result");
    assert.equal(await c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 0 }), "ready");
    assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
    // getResult recovers result text only; there is no generic alert retrieval API.
    const later = await started(f, "generic-after-rejection", "另一个通用名字");
    later.port.finish("still generic"); await settle(c, later.run);
    assert.equal(c.view(later.run.run_id).name, "另一个通用名字");
    assert.equal((await c.release(later.run.agent_id)).released, true);
    assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
  });

test("duplicate generic names include released Agents in binding validation, without merging IDs or consuming either original", async (t) => {
  const f = await fixture(t), c = f.controller, a = await started(f, "generic-a", "otter");
  a.port.callbacks.alert("A generic pending"); a.port.finish("A result"); await settle(c, a.run);
  assert.equal((await c.release(a.run.agent_id)).released, true);
  const b = await started(f, "generic-b", "otter");
  b.port.callbacks.alert("B generic pending"); b.port.finish("B result"); await settle(c, b.run);
  assert.notEqual(a.run.agent_id, b.run.agent_id); assert.equal(a.run.task, 1); assert.equal(b.run.task, 1);
  const before = facts(f, [a.run, b.run]);
  assert.throws(() => assemble(f), hasCode("UNSUPPORTED_MODEL_AGENT_IDENTITY", { reason: "duplicate_name" }));
  assert.deepEqual(facts(f, [a.run, b.run]), before);
  assert.equal(c.list({ include_released: true }).length, 2);
  assert.equal(c.getResult(a.run.run_id).text, "A result"); assert.equal(c.getResult(b.run.run_id).text, "B result");
  const third = await started(f, "generic-c", "otter");
  third.port.finish("C result"); await settle(c, third.run);
  assert.notEqual(third.run.agent_id, b.run.agent_id); assert.equal(third.run.task, 1);
  assert.equal(c.view(a.run.run_id).pending_messages, 1); assert.equal(c.view(b.run.run_id).pending_messages, 1);
  assert.equal(finishedBit(c, a.run), false); assert.equal(finishedBit(c, b.run), false);
  assert.equal((await c.release(b.run.agent_id)).released, true); assert.equal((await c.release(third.run.agent_id)).released, true);
});

for (const problem of ["context", "missing profile", "empty definition", "delegation tool"])
  test(`invalid ${problem} fails production assembly before imposing a lifetime model binding`, async (t) => {
    const f = await fixture(t), c = f.controller, options = toolOptions(f);
    if (problem === "context") options.context.sessionManager = { getSessionId: () => randomUUID() };
    else if (problem === "missing profile") delete options.profiles.editor;
    else if (problem === "empty definition") options.profiles.editor.definition = "";
    else options.profiles.editor.tools = ["agent_wait"];
    assert.throws(() => createOwnerTools(options), hasCode(problem === "context" ? "OWNER_CONTEXT_MISMATCH" : "INVALID_PROFILE_DEFINITION"));
    assert.equal(c.stats().runs, 0); assert.equal(c.stats().agents, 0); assert.equal(c.stats().internal_error, undefined);
    const generic = await started(f, "still-optional-name", undefined);
    generic.port.finish("generic completion"); await settle(c, generic.run);
    assert.equal(c.view(generic.run.run_id).name, ""); assert.equal(c.getResult(generic.run.run_id).text, "generic completion");
  });

for (const resident_limit of [8, 16, 17])
  test(`binding preserves the model resident capacity boundary at ${resident_limit} without constraining generic Owners`, async (t) => {
    const f = await fixture(t, { controller: { resident_limit } }), c = f.controller;
    if (resident_limit > 16) {
      assert.throws(() => assemble(f), hasCode("UNSUPPORTED_MODEL_RESIDENT_LIMIT"));
      const generic = await started(f, "large-generic", undefined);
      generic.port.finish("generic large-capacity result"); await settle(c, generic.run);
      assert.equal(c.view(generic.run.run_id).name, "");
    } else {
      assemble(f);
      await assert.rejects(c.submit("bound-unnamed", task("unnamed")), hasCode("INVALID_MODEL_AGENT_NAME"));
      assert.equal(c.stats().runs, 0); assert.equal(c.stats().requests, 0);
    }
    assert.equal(c.stats().limits.resident, resident_limit); assert.equal(c.stats().internal_error, undefined);
  });

test("binding cannot be smuggled through a guarded read-only phase, even if its nested rejection is swallowed", async (t) => {
  const f = await fixture(t), c = f.controller;
  assert.throws(() => c.validateObservationEntry(() => {
    assert.throws(() => c.bindModelCommunication(), hasCode("OBSERVATION_REENTRANCY"));
  }), hasCode("OBSERVATION_REENTRANCY"));
  const generic = await started(f, "not-bound-by-reentry", "通用名字");
  generic.port.finish("generic after rejected reentry"); await settle(c, generic.run);
  assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
});
