import assert from "node:assert/strict";
import test from "node:test";
import { OwnerController, softBudgetMessage } from "../../dist/core/owner-controller.js";
import { SessionInitializationError } from "../../dist/core/ports.js";
import { runReply } from "../../dist/tools/replies.js";
import { FakePort, deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

// A port is an interface anyone may implement, so every shape here has to land
// somewhere honest: a real figure kept, a bad one treated as unknown rather
// than zero, and a ledger naming no model treated as nothing to attribute.
const shapes = [
  [{ byModel: { "p/m": { input: 2 } } },
   { total: { input: 2, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
     partial: ["output", "cache_read", "cache_write", "cost"], byModel: { "p/m": { input: 2, output: 0, cache_read: 0, cache_write: 0, cost: 0 } } }],
  [{ byModel: { "p/m": { input: Number.NaN, output: -1, cache_read: 0, cache_write: 0, cost: 0 } } },
   { total: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
     partial: ["input", "output"], byModel: { "p/m": { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 } } }],
  // A bare Usage from a port written against the old contract names no model.
  [{ input: 2, output: 1, cache_read: 0, cache_write: 0, cost: 1 }, undefined],
  [{ byModel: {} }, undefined],
  [{ byModel: [] }, undefined],
  [{ byModel: { "p/m": null } }, undefined],
  [null, undefined],
];
for (const [usage, expected] of shapes) {
  test(`partial/invalid usage is unknown, not a permanent owner error: ${JSON.stringify(usage)}`, async (t) => {
    const { controller: c, ports } = await fixture(t);
    const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
    ports[0].calls[0].done.resolve({ kind: "success", output: { text: "answer", total_chars: 6, truncated: false }, usage });
    const result = await ended(c, a);
    assert.equal(result.snapshots[0].status, "completed");
    assert.equal(result.snapshots[0].owner_blocked, false);
    assert.equal(Object.hasOwn(result.snapshots[0], "durable"), false);
    // Cost is unknown here for the same reason the counts are: nothing reported it.
    assert.deepEqual(result.snapshots[0].usage, expected);
    const b = await c.submit("b", { resume: a.agent_id, prompt: "b" }); await until(() => ports[0].calls.length === 2);
    ports[0].finish("b"); await ended(c, b); assert.equal((await c.shutdown()).closed, true);
  });
}

test("new assistant revision replaces commentary and resets the cap; old revisions are ignored", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 8 } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.output({ text: "draft ".repeat(100), total_chars: 600, truncated: false, revision: 1 });
  ports[0].callbacks.output({ text: "", total_chars: 0, truncated: false, revision: 2 });
  ports[0].callbacks.output({ text: "old late draft", total_chars: 14, truncated: false, revision: 1 });
  ports[0].calls[0].done.resolve({ kind: "success", output: { text: "FINAL", total_chars: 5, truncated: false, revision: 2 } });
  const result = await ended(c, a);
  assert.equal(result.results[0].text, "FINAL"); assert.equal(result.results[0].complete, true);
  assert.equal(result.results[0].total_chars, 5); assert.equal(result.snapshots[0].resumable, true);
});

for (const output of [{ text: "p", total_chars: 1, truncated: false, revision: 2 }, { text: "changed", total_chars: 20, truncated: true, revision: 2 }]) {
  test(`same revision final regression preserves the last prefix: ${output.text}`, async (t) => {
    const { controller: c, ports } = await fixture(t);
    const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
    ports[0].callbacks.output({ text: "partial", total_chars: 7, truncated: false, revision: 2 });
    ports[0].calls[0].done.resolve({ kind: "success", output });
    const value = await ended(c, a);
    assert.equal(value.results[0].text, "partial"); assert.equal(value.results[0].complete, false);
    assert.equal(value.snapshots[0].status, "failed");
    assert(value.snapshots[0].cleanup_errors.includes("EXECUTION_OUTPUT_REGRESSED"));
  });
}

test("initialization cleanup uncertainty survives failure before a port was returned", async (t) => {
  const { controller: c, owner } = await fixture(t, { cleanupUncertainExpected: true, controller: {
    createSession: async () => { throw new SessionInitializationError(new Error("bind failed"), new Error("CHILD_SHUTDOWN_TIMEOUT")); },
  } });
  const a = await c.submit("a", task("a")); await until(() => c.view(a.run_id).status === "failed");
  assert.equal(c.stats().resident, 1); assert.equal(c.stats().cleanup_uncertain, true);
  await assert.rejects(c.submit("b", task("b")), errorCode("OWNER_CLEANUP_UNCERTAIN"));
  assert.equal((await c.shutdown()).closed, false); owner.assertHeld();
});

test("wait always rejects via its Promise, including unknown Run IDs", async (t) => {
  const { controller: c } = await fixture(t);
  let unknown;
  assert.doesNotThrow(() => { unknown = c.wait(["unknown"], { mode: "all" }); });
  await assert.rejects(unknown, errorCode("RUN_NOT_FOUND"));
  await assert.rejects(c.wait([], { mode: "all" }), errorCode("INVALID_WAIT"));
});

test("initialization failure is not labelled cancellation", async (t) => {
  const { controller: c } = await fixture(t, { controller: { createSession: async () => { throw new Error("synthetic init failure"); } } });
  const a = await c.submit("a", task("a")); const result = await ended(c, a);
  assert.equal(result.snapshots[0].status, "failed"); assert.equal(result.snapshots[0].unavailable_reason, "initialization_failed");
});

for (const queuedPeer of [false, true]) test(`lost owner authority settles output without writing history or unblocking peers (queued=${queuedPeer})`, async (t) => {
  let historyWrites = 0;
  const { controller: c, ports, owner } = await fixture(t, { controller: { concurrency: 2 }, history: (point) => {
    if (point === "finish") historyWrites++;
  } });
  const first = await c.submit("loses-lock", task("loses-lock"));
  const peer = await c.submit("active-peer", task("active-peer"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const queued = queuedPeer ? await c.submit("queued-peer", task("queued-peer")) : undefined;
  const assertActuallyHeld = owner.assertHeld.bind(owner);
  const brokenAuthority = t.mock.method(owner, "assertHeld", () => { throw new Error("LOCK_INODE_CHANGED"); });
  ports[0].finish("retained answer");
  // owner_blocked may wake wait before finalization; poll the actual phase.
  await until(() => c.view(first.run_id).phase === "settled");
  const settled = c.view(first.run_id), stats = c.stats();
  assert.equal(settled.execution_exited, true); assert.equal(settled.resumable, false);
  assert.equal(settled.owner_blocked, true); assert.match(settled.history_error, /LOCK_INODE_CHANGED/);
  assert.match(stats.internal_error, /LOCK_INODE_CHANGED/);
  assert.equal(stats.cleanup_uncertain, false, "lost authority is not fabricated execution uncertainty");
  assert.equal(stats.active, 1); assert.equal(stats.finalizing, 0);
  assert.equal(stats.reserved_output_chars, (queuedPeer ? 2 : 1) * 1048576);
  assert.equal(stats.retained_output_chars, "retained answer".length);
  assert.equal(c.getResult(first.run_id).text, "retained answer"); assert.equal(historyWrites, 0);
  assert.equal(ports.length, 2); if (queued) assert.equal(c.view(queued.run_id).status, "queued");
  await assert.rejects(c.submit("new-work", task("new-work")), errorCode("OWNER_INTERNAL_ERROR"));
  await assert.rejects(c.submit("reuse", { resume: first.agent_id, prompt: "again" }), errorCode("OWNER_INTERNAL_ERROR"));
  assert.throws(() => c.steer(peer.run_id, "more work"), errorCode("OWNER_INTERNAL_ERROR"));
  assert.equal((await c.shutdown(1)).closed, false, "live peer still owns its slot and lease");
  assertActuallyHeld(); assert.equal(c.stats().active, 1);
  brokenAuthority.mock.restore(); // Apparent recovery must not authorize later END writes.
  ports[1].finish("peer stopped", "aborted");
  await until(() => c.view(peer.run_id).phase === "settled");
  assert.equal((await c.shutdown()).closed, true);
  assert.equal(historyWrites, 0); assert.equal(c.stats().reserved_output_chars, 0);
  assert.equal(c.stats().retained_output_chars, "retained answerpeer stopped".length);
});

test("unexpected successful port stop reasons gain diagnostics without replacing existing errors", async (t) => {
  const { controller: c, ports } = await fixture(t);
  for (const [reason, supplied, expected] of [["content_filter", undefined, "UNEXPECTED_MODEL_STOP_REASON: content_filter"],
    ["length", undefined, "MODEL_OUTPUT_LIMIT"], ["future_reason", "provider detail", "provider detail"]]) {
    const run = await c.submit(reason, task(reason)); await until(() => ports.at(-1)?.streaming);
    ports.at(-1).finish("partial", "success", supplied, reason);
    const view = (await ended(c, run)).snapshots[0];
    assert.equal(view.status, "failed"); assert.equal(view.model_stop_reason, reason);
    assert.equal(view.outcome.error, expected); assert.equal(view.outcome.limit_reached, false);
    assert.equal(view.outcome.reason, reason === "length" ? "output_limit" : "execution_error");
    assert.equal(view.resumable, true); assert.equal(c.getResult(run.run_id).text, "partial");
  }
});

test("deadline starts on execution, covers initialization, and cannot release a hung slot or owner", async (t) => {
  const initialization = deferred(), entered = deferred(), port = new FakePort();
  const f = await fixture(t, { controller: { createSession: async () => { entered.resolve(); await initialization.promise; return port; } } });
  const run = await f.controller.submit("deadline-init", task("deadline-init", { max_duration_ms: 10 }));
  await entered.promise; await until(() => f.controller.view(run.run_id).stop_reason === "deadline");
  assert.deepEqual(f.events.map((event) => event.kind), ["submit", "deadline"]);
  assert.equal(f.controller.view(run.run_id).status, "cancelling"); assert.equal(f.controller.stats().active, 1);
  assert.equal((await f.controller.shutdown(1)).closed, false); f.owner.assertHeld();
  initialization.resolve(); const done = (await ended(f.controller, run)).snapshots[0];
  assert.equal(done.status, "failed"); assert.equal(done.outcome.reason, "deadline");
  assert.equal(port.calls.length, 0); assert.equal(f.controller.stats().active, 0);
});

test("queued time is excluded and a non-cooperative deadline only requests stop", async (t) => {
  const { controller: c, ports, owner } = await fixture(t);
  const blocker = await c.submit("blocker", task("blocker")); await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued-deadline", task("queued-deadline", { max_duration_ms: 10 }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(c.view(queued.run_id).status, "queued"); assert.equal(c.view(queued.run_id).execution_elapsed_ms, undefined);
  ports[0].finish("free slot"); await ended(c, blocker); await until(() => ports[1]?.stopped === 1);
  assert.equal(c.view(queued.run_id).status, "cancelling"); assert.equal(c.stats().active, 1);
  assert.equal((await c.shutdown(1)).closed, false); owner.assertHeld();
  ports[1].finish("late partial", "aborted"); const done = (await ended(c, queued)).snapshots[0];
  assert.equal(done.status, "failed"); assert.equal(done.outcome.reason, "deadline");
  assert(done.execution_elapsed_ms >= 0);
});

test("normal exit clears its deadline and a resumed Run owns a fresh timer", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const first = await c.submit("first-timer", task("first-timer", { max_duration_ms: 50 })); await until(() => ports[0]?.streaming);
  ports[0].finish("first"); await ended(c, first);
  const resumed = await c.submit("fresh-timer", { resume: first.agent_id, prompt: "next", max_duration_ms: 200 });
  await until(() => ports[0].calls.length === 2); await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(c.view(resumed.run_id).status, "running"); assert.equal(ports[0].stopped, 0);
  ports[0].finish("second"); await ended(c, resumed);
});

test("runtime snapshots are validated, projected live, and billed once at finish", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("runtime", task("runtime")); await until(() => ports[0]?.streaming);
  const waiting = c.wait([run.run_id], { mode: "all", timeout_ms: 20 });
  ports[0].callbacks.runtime({ activity: "unknown", context: { tokens: -1, context_window: 0 } });
  assert.equal(c.view(run.run_id).runtime, undefined);
  const usage = { byModel: { "p/m": { input: 2, output: 1, cache_read: 0, cache_write: 0, cost: 0.25 } }, partial: ["cost"] };
  ports[0].callbacks.runtime({ activity: "generating", context: { tokens: null, context_window: 128000 }, usage });
  usage.byModel["p/m"].cost = 7;
  const live = c.view(run.run_id), projected = runReply(live);
  assert.equal(live.usage.total.cost, 0.25); assert.equal(projected.runtime.activity, "generating");
  assert.deepEqual(projected.runtime.context, { tokens: null, context_window: 128000 });
  assert.deepEqual(projected.runtime.usage, { observed_cost: 0.25, partial: true });
  // A structurally valid cumulative regression cannot erase already observed spend.
  ports[0].callbacks.runtime({ activity: "tool", usage: { byModel: { "p/m": { input: 1, output: 0, cache_read: 0, cache_write: 0, cost: 0 } }, partial: ["cost"] } });
  assert.equal(c.view(run.run_id).usage.total.cost, 0.25);
  assert.equal((await waiting).reason, "timeout", "runtime telemetry does not wake model waits");
  ports[0].calls[0].done.resolve({ kind: "success", output: { text: "done", total_chars: 4, truncated: false } });
  await ended(c, run);
  ports[0].callbacks.runtime({ activity: "retrying", usage: { byModel: { "p/m": { input: 99, output: 99, cache_read: 0, cache_write: 0, cost: 99 } } } });
  assert.equal(c.view(run.run_id).runtime.activity, "tool", "late callbacks cannot mutate a settled Run");
  const stats = c.stats(); assert.equal(stats.unreported_usage.total.cost, 0.25);
  stats.unreported_usage.byModel["p/m"].cost = 99;
  assert.equal(c.stats().unreported_usage.total.cost, 0.25, "stats returns a clone, not the live ledger");
  assert.equal(c.drainUsage().total.cost, 0.25); assert.equal(c.drainUsage(), undefined);
});

test("mixed cumulative regressions preserve every model floor and partial through settlement", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("mixed-runtime", task("mixed-runtime")); await until(() => ports[0]?.streaming);
  const share = (cost) => ({ input: 2, output: 1, cache_read: 0, cache_write: 0, cost });
  ports[0].callbacks.runtime({ activity: "generating", usage: { byModel: { "p/m": share(0.25) }, partial: ["cost"] } });
  ports[0].callbacks.runtime({ activity: "tool", usage: { byModel: { "p/m": share(0.20), "q/m": share(0.50) }, partial: [] } });
  assert.equal(c.view(run.run_id).usage.total.cost, 0.75);
  ports[0].calls[0].done.resolve({ kind: "success", output: { text: "done", total_chars: 4, truncated: false },
    usage: { byModel: { "p/m": share(0.10), "r/m": share(0.30) }, partial: [] } });
  await ended(c, run);
  assert.equal(c.view(run.run_id).usage.total.cost, 1.05);
  assert.deepEqual(c.view(run.run_id).usage.partial, ["cost"]);
  assert.equal(c.drainUsage().total.cost, 1.05); assert.equal(c.drainUsage(), undefined);
});

test("history capacity must fit one output reservation at construction", async () => {
  let closed = false, creates = 0;
  const owner = { owner_id: "owner", generation: "generation", assertHeld() { assert.equal(closed, false); }, close() { closed = true; } };
  await assert.rejects(OwnerController.open({ owner, output_chars: 16, history_output_chars: 8,
    createSession: async () => { creates++; return new FakePort(); } }), errorCode("INVALID_LIMIT"));
  assert.equal(closed, true, "failed open returns its owner lease"); assert.equal(creates, 0);
});

test("history capacity equal to one output reservation admits the first Run", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 16, history_output_chars: 16 } });
  const run = await c.submit("fits", task("fits")); await until(() => ports[0]?.streaming);
  assert.equal(c.stats().reserved_output_chars, 16);
  await assert.rejects(c.submit("full", task("full")), errorCode("OWNER_HISTORY_LIMIT"));
  ports[0].finish("answer"); await ended(c, run);
  assert.equal(c.stats().reserved_output_chars, 0); assert.equal(c.stats().retained_output_chars, 6);
});

test("owner history bounds reserve concurrent output and never evict old Runs or request identities", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 4, history_output_chars: 8,
    history_run_limit: 3, concurrency: 1, resident_limit: 3, queue_limit: 4 } });
  const first = await c.submit("history-first", task("history-first")); await until(() => ports[0]?.streaming);
  const second = await c.submit("history-second", task("history-second"));
  assert.deepEqual({ reserved: c.stats().reserved_output_chars, retained: c.stats().retained_output_chars }, { reserved: 8, retained: 0 });
  await assert.rejects(c.submit("history-full", task("history-full")), (error) => {
    assert.equal(error.code, "OWNER_HISTORY_LIMIT"); assert.match(error.details.resolution, /Close this owner/); return true;
  });
  assert.equal((await c.submit("history-first", task("history-first"))).run_id, first.run_id, "replay precedes the limit gate");
  ports[0].finish("a"); await ended(c, first); await until(() => ports[1]?.streaming);
  await assert.rejects(c.submit("resume-too-large", { resume: first.agent_id, prompt: "resume" }), errorCode("OWNER_HISTORY_LIMIT"));
  ports[1].finish("b"); await ended(c, second);
  const resumed = await c.submit("history-resume", { resume: first.agent_id, prompt: "resume" });
  assert.deepEqual({ agents: c.stats().agents, runs: c.stats().runs, requests: c.stats().requests,
    reserved: c.stats().reserved_output_chars, retained: c.stats().retained_output_chars },
  { agents: 2, runs: 3, requests: 3, reserved: 4, retained: 2 });
  assert.equal((await c.submit("history-resume", { resume: first.agent_id, prompt: "resume" })).run_id, resumed.run_id);
  await assert.rejects(c.submit("run-limit", task("run-limit")), errorCode("OWNER_HISTORY_LIMIT"));
  assert.equal(c.getResult(first.run_id).text, "a");
  await until(() => ports[0].calls.length === 2); c.cancel(resumed.run_id); ports[0].finish("c", "aborted"); await ended(c, resumed);
  await c.release(second.agent_id); await c.release(first.agent_id);
  assert.equal((await c.shutdown()).closed, true);
});

test("exact budget completion is unflagged; a continuing turn gets one wrap-up message", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 2 } });
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  ports[0].finish("exact"); assert.equal((await ended(c, a)).snapshots[0].outcome.limit_reached, false);
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b", max_turns: 1 }); await until(() => ports[0].calls.length === 2);
  ports[0].callbacks.turnEnd(true); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.includes(softBudgetMessage));
  assert.equal(ports[0].inputs.filter((s) => s === softBudgetMessage).length, 1);
  ports[0].finish("wrapped up"); const result = await ended(c, b);
  assert.equal(result.snapshots[0].status, "completed"); assert.equal(result.snapshots[0].outcome.limit_reached, true);
});
