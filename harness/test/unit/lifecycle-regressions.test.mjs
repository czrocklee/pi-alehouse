import assert from "node:assert/strict";
import test from "node:test";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

test("history failure preserves live outcome; late cleanup uncertainty still retains resident and owner", async (t) => {
  const { controller: c, ports, directory, owner_id } = await fixture(t, { cleanupUncertainExpected: true, history: (point) => {
    if (point === "finish") throw new Error("synthetic journal failure");
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const b = await c.submit("b", task("b")), queued = await c.submit("queued", task("queued"));
  const cleanup = deferred(), cleanupEntered = deferred();
  ports[0].dispose = async () => { ports[0].disposed++; cleanupEntered.resolve(); await cleanup.promise; return { shutdownExited: false, errors: ["late cleanup failure"] }; };
  ports[0].finish("preserve output"); await ended(c, a); await cleanupEntered.promise;
  assert.equal(c.view(a.run_id).status, "completed"); assert.equal(c.getResult(a.run_id).text, "preserve output");
  assert.match(c.view(a.run_id).history_error, /journal failure/);
  assert.equal(c.recoverStorage, undefined); await until(() => ports[1]?.streaming);
  assert.equal(c.stats().cleaning, 1); assert.equal(c.view(b.run_id).execution_exited, false);
  cleanup.resolve(); await until(() => c.stats().cleanup_uncertain);
  assert.equal(c.view(a.run_id).owner_blocked, true);
  assert(c.view(a.run_id).cleanup_errors.includes("late cleanup failure"));
  assert.equal(c.stats().resident, 3);
  assert.equal(c.view(queued.run_id).status, "queued"); assert.equal((await c.wait([queued.run_id], { mode: "all" })).reason, "owner_blocked");
  await assert.rejects(c.submit("new", task("new")), errorCode("OWNER_CLEANUP_UNCERTAIN"));
  await c.release(a.agent_id); assert.equal(ports[0].disposed, 1); assert.equal(c.stats().resident, 3);
  ports[1].finish("peer drains after uncertainty"); await ended(c, b);
  assert.equal(c.view(queued.run_id).status, "queued"); assert.equal((await c.shutdown(30)).closed, false);
  await assert.rejects(ExecutionOwner.open({ directory, owner_id, flock }), /OWNER_LOCKED/);
});

test("shutdown tracks history finalization and cannot close its lock during IO", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports, directory, owner_id } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await entered.promise;
  assert.equal((await c.shutdown(5)).closed, false);
  await assert.rejects(ExecutionOwner.open({ directory, owner_id, flock }), /OWNER_LOCKED/);
  gate.resolve(); await ended(c, a);
  assert.equal((await c.shutdown()).closed, true);
});

for (const [name, output] of [
  ["empty count", { text: "", total_chars: 0, truncated: false }],
  ["same count with empty body", { text: "", total_chars: 15, truncated: true }],
  ["increasing count with different body", { text: "replacement text", total_chars: 30, truncated: true }],
]) {
  test(`terminal aborted facts (${name}) cannot erase observed partial output`, async (t) => {
    const { controller: c, ports } = await fixture(t);
    const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
    ports[0].callbacks.output({ text: "visible partial", total_chars: 15, truncated: false });
    c.cancel(a.run_id);
    ports[0].calls[0].done.resolve({ kind: "aborted", output });
    const result = await ended(c, a);
    assert.equal(result.snapshots[0].status, "cancelled"); assert.equal(result.results[0].text, "visible partial");
    assert.equal(result.results[0].complete, false); assert.equal(result.results[0].truncated, true);
    assert(result.snapshots[0].cleanup_errors.includes("EXECUTION_OUTPUT_REGRESSED")); assert.equal(result.snapshots[0].resumable, false);
  });
}

test("monotonic timing freezes old Runs; stale callbacks cannot change reuse, snapshots omit inherited body", async (t) => {
  let wall = 10000, mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { clock: { wall: () => wall, mono: () => mono } } });
  const input = task("a"); input.settings = { ...input.settings, context_snapshot: "PRIVATE_SYNTHETIC_SNAPSHOT" };
  const a = await c.submit("a", input); await until(() => ports[0]?.streaming);
  const oldCallbacks = ports[0].callbacks;
  mono = 42; wall = 1;
  assert.equal(c.view(a.run_id).elapsed_ms, 42); assert.equal(c.view(a.run_id).turn_elapsed_ms, 42);
  oldCallbacks.output({ text: "token", total_chars: 5, truncated: false });
  mono = 50; assert.equal(c.view(a.run_id).turn_elapsed_ms, 50);
  ports[0].finish("token final"); await ended(c, a);
  const historical = c.view(a.run_id); assert.equal(historical.elapsed_ms, 50);
  assert.equal(historical.effective_settings.context_mode, "text_snapshot");
  assert.equal(Object.hasOwn(historical.effective_settings, "context_snapshot"), false);
  mono = 80; wall = 20000;
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b" }); await until(() => ports[0].calls.length === 2);
  oldCallbacks.turnStart(); oldCallbacks.output({ text: "STALE", total_chars: 5, truncated: false }); oldCallbacks.question("STALE?");
  assert.equal(c.view(b.run_id).turns, 1); assert.equal(c.getResult(b.run_id).text, "");
  mono = 90; assert.equal(c.view(b.run_id).turn_elapsed_ms, 10); assert.equal(c.view(a.run_id).elapsed_ms, 50);
  ports[0].finish("b"); await ended(c, b); assert.equal(c.view(b.run_id).status, "completed");
  assert.equal(ports[0].calls[1].prompt, "b"); // Snapshot is not prepended on reuse.
});

test("the turn clock measures time since the last turn began, not only an open turn", async (t) => {
  let mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { clock: { wall: () => 1, mono: () => mono } } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  mono = 10; assert.equal(c.view(a.run_id).turn_elapsed_ms, 10);
  // Between turns the clock keeps running, so a stalled Run still reads its age.
  ports[0].callbacks.turnEnd(true); mono = 25;
  assert.equal(c.view(a.run_id).turn_elapsed_ms, 25);
  ports[0].callbacks.turnStart(); mono = 30;
  assert.equal(c.view(a.run_id).turn_elapsed_ms, 5); assert.equal(c.view(a.run_id).turns, 2);
  ports[0].finish("done"); await ended(c, a);
  assert.equal(c.view(a.run_id).turn_elapsed_ms, undefined);
});

test("invalid non-JSON submissions reject structurally without reserving work", async (t) => {
  const { controller: c, ports } = await fixture(t);
  for (const input of [null, [], { prompt: () => {} }]) await assert.rejects(c.submit("invalid", input), errorCode("INVALID_SUBMIT"));
  assert.equal(ports.length, 0); assert.equal(c.stats().resident, 0);
});
