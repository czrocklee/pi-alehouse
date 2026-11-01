// Real core/tools/packer/commit with controlled ports, no provider or checkout.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { communicationEnvelopeBytes } from "../../dist/core/communication-envelope.js";
import { SessionInitializationError } from "../../dist/core/ports.js";
import { withWorkspaceRecovery } from "../../dist/core/workspace-metadata.js";
import { FakePort, deferred, ended, fixture, settings, task, until } from "../support/controller-fixture.mjs";

const model = { provider: "fixture", id: "controlled" };
function toolsFor(f) {
  const manager = { getSessionId: () => f.owner_id }, registry = { getAll: () => [model] };
  const ctx = { sessionManager: manager, modelRegistry: registry, cwd: "/tmp", thinkingLevel: "off" };
  const route = { name: "fixture", version: "v1", digest: "a".repeat(64),
    models: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "fixture/controlled"])),
    effort: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "off"])),
    effort_defaults: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`d${n}`, "off"])), effort_overrides: {} };
  const tools = createOwnerTools({ controller: f.controller, context: ctx,
    profiles: Object.fromEntries(["editor", "researcher"].map(profile => [profile, { definition: profile, tools: ["read"] }])),
    getSupportedThinkingLevels: () => ["off"], getPreset: () => route });
  let id = 0;
  const tool = name => tools.find(item => item.name === name);
  return { tool, call: async (name, args) => JSON.parse((await tool(name).execute(`lean-${++id}`, args, undefined, undefined, ctx)).content[0].text) };
}
const spawn = (rest = {}) => ({ agent: "pine", profile: "worker", reasoning_difficulty: 1, prompt: "Inspect", label: "Inspect first", ...rest });
const errorCode = expected => error => JSON.parse(error.message).error.code === expected;
const read = async (controller, run, rest = {}) => JSON.parse((await controller.observe({ kind: "read", agent_id: run.agent_id, ...rest }, { validate() {} })).content[0].text);
const telemetry = ["context_tokens", "elapsed_s", "earlier_labels", "touched", "touched_omitted", "time_wrapped", "recovery_hint"];
const noTelemetry = row => { for (const field of telemetry) assert.equal(Object.hasOwn(row, field), false, field); };

test("default replies are small; builds_on and historical task reads remain", async t => {
  const f = await fixture(t), { call, tool } = toolsFor(f);
  const first = await call("agent_spawn", spawn());
  assert.deepEqual(first, { action: { type: "agent_spawn", agent: "pine", task: 1 },
    agents: [{ agent: "pine", task: 1, status: "running", label: "Inspect first" }] });
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish("SHORT_A"); await ended(f.controller, { run_id: f.controller.findAgent("pine").run_id });
  const complete = await call("agent_read", { agent: "pine" });
  assert.deepEqual(complete, { agents: [{ agent: "pine", task: 1, status: "completed", label: "Inspect first", result: "SHORT_A" }] });
  const follow = { agent: "pine", builds_on: "UNIQUE_REUSE_REASON", prompt: "Follow up", label: "Second inspection" };
  const { builds_on: _reason, ...missing } = follow;
  assert.throws(() => tool("agent_run").prepareArguments(missing), errorCode("INVALID_PARAMETERS"));
  await call("agent_run", follow);
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  assert.equal(f.ports[0].calls[1].prompt, "Follow up", "reuse reason stays parent-side");
  f.ports[0].finish("SHORT_B"); await ended(f.controller, { run_id: f.controller.findAgent("pine").run_id });
  assert.equal((await call("agent_read", { agent: "pine" })).agents[0].result, "SHORT_B");
  const old = await call("agent_read", { agent: "pine", task: 1 });
  assert.equal(old.agents[0].result, "SHORT_A"); assert.equal(old.agents[0].label, "Inspect first");
  assert.deepEqual(await call("agent_kill", { agent: "pine" }), { agent: "pine", status: "killed", label: "Second inspection" });
  assert.equal((await call("agent_read", { agent: "pine", task: 1 })).agents[0].result, "SHORT_A");
  for (const task of [0, -1, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => tool("agent_read").prepareArguments({ agent: "pine", task }), errorCode("INVALID_PARAMETERS"));
    await assert.rejects(call("agent_read", { agent: "pine", task }), errorCode("INVALID_PARAMETERS"));
  }
  assert.throws(() => tool("agent_read").prepareArguments({ agent: "pine", task: 1, cursor: "x" }), errorCode("INVALID_PARAMETERS"));
  await assert.rejects(call("agent_read", { agent: "pine", task: Number.MAX_SAFE_INTEGER }), errorCode("TASK_NOT_FOUND"));
});

test("working locations are on demand in wait/read/list, including after kill", async t => {
  const port = new FakePort();
  port.workspace = { mode: "worktree", cwd: "/retained/tree/nested", source_cwd: "/tmp", base_commit: "a".repeat(40) };
  port.workspace_details = { checkout_root: "/retained/tree", recovery_manifest: "/retained/recovery.jsonl" };
  const f = await fixture(t, { controller: { createSession: async () => port }, beforeShutdown: () => {
    if (port.streaming) port.finish("cleanup", "aborted");
  } });
  const { call } = toolsFor(f);
  const started = await call("agent_spawn", spawn({ workspace: "worktree" }));
  assert.equal(started.agents[0].workspace, undefined); assert.equal(started.agents[0].workspace_pending, undefined);
  await until(() => port.streaming);
  const expected = { ...port.workspace, checkout_root: "/retained/tree" };
  for (const [name, args] of [["agent_wait", { agents: ["pine"], wait_ms: 0 }], ["agent_read", { agent: "pine" }], ["agent_list", {}]]) {
    const row = (await call(name, args)).agents[0];
    assert.deepEqual(row.workspace, expected); assert.equal(row.workspace_pending, undefined); assert.equal(row.recovery, undefined); noTelemetry(row);
  }
  assert.equal((await call("agent_send", { agent: "pine", message: "Check one more case" })).agents[0].workspace, undefined);
  assert.equal((await call("agent_interrupt", { agent: "pine" })).workspace, undefined);
  port.finish("partial", "aborted"); await ended(f.controller, { run_id: f.controller.findAgent("pine").run_id });
  assert.deepEqual(await call("agent_kill", { agent: "pine" }), { agent: "pine", status: "killed", label: "Inspect first" });
  assert.deepEqual((await call("agent_read", { agent: "pine", task: 1 })).agents[0].workspace, expected);
});

test("oversized optional paths yield honestly; retired metadata modes/cursors cannot consume communication", async t => {
  let enabled = true;
  const port = new FakePort(), huge = `/tmp/${'"\\\0'.repeat(15000)}`;
  port.workspace = { mode: "worktree", cwd: huge, source_cwd: "/tmp", base_commit: "b".repeat(40) };
  port.workspace_details = { checkout_root: huge, recovery_manifest: `${huge}/recovery.jsonl` };
  const f = await fixture(t, { controller: { createSession: async () => port, admission: () => ({ enabled, revision: 0 }) } });
  const run = await f.controller.submit("huge-workspace", task("Inspect huge paths", { name: "pine", settings: { ...settings, workspace: "worktree" } }));
  await until(() => port.streaming);
  port.callbacks.question("\0".repeat(8192));
  for (let n = 0; n < 16; n++) port.callbacks.alert("\0".repeat(8192));
  port.finish("done"); await ended(f.controller, run); enabled = false;
  const normal = await read(f.controller, run, { max_chars: 1 });
  assert.equal(normal.agents[0].workspace, undefined); assert.equal(normal.agents[0].workspace_pending, undefined);
  assert.equal(normal.response_limit_reached, true);
  assert.equal(normal.workers_disabled, true); assert.equal(normal.alerts_pending, 16);
  assert(communicationEnvelopeBytes(normal) <= 65536);
  const { call, tool } = toolsFor(f), count = f.controller.view(run.run_id).pending_messages;
  const bit = f.controller.runs.get(run.run_id).finished_presented;
  for (const view of ["metadata", "result"]) {
    assert.throws(() => tool("agent_read").prepareArguments({ agent: "pine", view }), errorCode("INVALID_PARAMETERS"));
    await assert.rejects(call("agent_read", { agent: "pine", view }), errorCode("INVALID_PARAMETERS"));
    assert.deepEqual(await read(f.controller, run, { view, max_chars: 1 }), normal, "core has no retired view branch; the public schema rejects it");
  }
  await assert.rejects(call("agent_read", { agent: "pine", cursor: `m1_${"A".repeat(22)}.${"0".repeat(11)}` }), errorCode("INVALID_CURSOR"));
  assert.equal(f.controller.view(run.run_id).pending_messages, count);
  assert.equal(f.controller.runs.get(run.run_id).finished_presented, bit);
  assert.equal(f.controller.stats().internal_error, undefined);
});

test("failure exposes retained locations, not recovery states, while typed cleanup uncertainty stays strict", async t => {
  const recovery = { mode: "worktree", state: "checkout_ready", source_cwd: "/tmp", checkout_root: "/retained/tree",
    cwd: "/retained/tree/nested", base_commit: "a".repeat(40), recovery_manifest: "/retained/recovery.jsonl" };
  const failure = new SessionInitializationError(new Error("x".repeat(4000)), new Error("cleanup unconfirmed"));
  Object.freeze(failure); assert.equal(withWorkspaceRecovery(failure, recovery), failure);
  const f = await fixture(t, { cleanupUncertainExpected: true, controller: { createSession: async () => { throw failure; } } });
  const run = await f.controller.submit("failed", task("Failure recovery", { name: "pine", settings: { ...settings, workspace: "worktree" } }));
  await ended(f.controller, run);
  const view = f.controller.view(run.run_id);
  assert.equal(view.workspace, undefined); assert.equal(view.recovery.state, "checkout_ready");
  assert.equal(f.controller.stats().cleanup_uncertain, true);
  const row = (await read(f.controller, run)).agents[0];
  assert(row.error.length <= 512); assert.equal(row.recovery, undefined); assert.equal(row.workspace, undefined);
  assert.equal(row.workspace_pending, undefined);
  assert.deepEqual(row.retained_paths, ["/retained/tree", "/retained/recovery.jsonl"]); noTelemetry(row);
  await assert.rejects(f.controller.submit("blocked", task("Never start", { name: "oak" })), error => {
    assert.equal(error.code, "OWNER_CLEANUP_UNCERTAIN"); assert.match(error.details.resolution, /no retry or force release/); return true;
  });
  assert.equal((await f.controller.shutdown(10)).closed, false);
});

test("later initialization does not rewrite an earlier unstarted task's workspace", async t => {
  const gate = deferred(), port = new FakePort(), blockerPort = new FakePort(); blockerPort.autoStop = true;
  port.workspace = { mode: "worktree", cwd: "/retained/tree", source_cwd: "/tmp", base_commit: "c".repeat(40) };
  const f = await fixture(t, { controller: { createSession: async agent => {
    if (agent.settings.workspace !== "worktree") return blockerPort;
    await gate.promise; return port;
  } }, beforeShutdown: () => {
    gate.resolve(); if (port.streaming) port.finish("cleanup", "aborted");
    if (blockerPort.streaming) blockerPort.finish("cleanup", "aborted");
  } });
  const { call } = toolsFor(f);
  const blocker = await f.controller.submit("blocker", task("Blocker", { name: "oak" })); await until(() => blockerPort.streaming);
  const first = await f.controller.submit("first", task("Not started", { name: "pine", after: [blocker.run_id], settings: { ...settings, workspace: "worktree" } }));
  assert.equal((await read(f.controller, first)).agents[0].workspace_pending, true, "queued original worktree task");
  assert.equal((await call("agent_wait", { agents: ["pine"], wait_ms: 0 })).agents[0].workspace_pending, true);
  assert.equal((await call("agent_list", {})).agents.find(row => row.agent === "pine").workspace_pending, true);
  f.controller.cancel(first.run_id); await ended(f.controller, first);
  assert.equal((await read(f.controller, first)).agents[0].workspace_pending, undefined, "cancelled before initialization");
  f.controller.cancel(blocker.run_id); await ended(f.controller, blocker);
  const second = await f.controller.submit("second", { resume: first.agent_id, prompt: "Now initialize", description: "New baseline" });
  const initializing = (await read(f.controller, second)).agents[0];
  assert.equal(initializing.workspace, undefined); assert.equal(initializing.workspace_pending, true);
  assert.equal(initializing.status, "running");
  gate.resolve(); await until(() => port.streaming);
  assert.equal(f.controller.view(first.run_id).workspace, undefined);
  const original = (await read(f.controller, first, { task: 1 })).agents[0];
  assert.equal(original.workspace, undefined); assert.equal(original.workspace_pending, undefined);
  const bound = (await read(f.controller, second)).agents[0];
  assert.equal(bound.workspace.base_commit, "c".repeat(40)); assert.equal(bound.workspace_pending, undefined);
  port.finish(); await ended(f.controller, second);
});

test("large rosters stay bounded without exposing host telemetry or consuming finished facts", async t => {
  const f = await fixture(t, { controller: { concurrency: 16, resident_limit: 16 } }), { call } = toolsFor(f);
  for (let n = 0; n < 16; n++) await call("agent_spawn", spawn({ agent: `pine${n}`, label: "\0".repeat(120) }));
  await until(() => f.ports.length === 16 && f.ports.every(port => port.streaming));
  for (const port of f.ports) {
    port.callbacks.runtime({ activity: "generating", context: { tokens: 50000, context_window: 100000 } });
    port.finish("", "error", "\0".repeat(2048));
  }
  for (const view of f.controller.list()) await ended(f.controller, view);
  const bits = f.controller.list().map(view => f.controller.runs.get(view.run_id).finished_presented);
  const roster = await call("agent_list", {});
  assert(communicationEnvelopeBytes(roster) <= 65536); assert.equal(roster.response_limit_reached, true);
  assert.equal(roster.agents.length, 16);
  for (const row of roster.agents) { noTelemetry(row); assert.equal(row.status, "failed"); }
  for (const view of f.controller.list()) {
    assert.deepEqual(view.runtime.context, { tokens: 50000, context_window: 100000 });
  }
  assert.deepEqual(f.controller.list().map(view => f.controller.runs.get(view.run_id).finished_presented), bits);
});

test("closed-owner guidance is on demand and inspection remains available", async t => {
  const f = await fixture(t), { call } = toolsFor(f);
  assert.equal((await f.controller.shutdown()).closed, true);
  await assert.rejects(call("agent_spawn", spawn()), error => {
    const value = JSON.parse(error.message).error;
    assert.equal(value.code, "OWNER_CLOSED"); assert.match(value.resolution, /fresh session.*confirmed closure/); return true;
  });
  assert.deepEqual(await call("agent_list", {}), { agents: [] });
});
