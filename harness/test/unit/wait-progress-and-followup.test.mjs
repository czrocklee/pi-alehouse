import assert from "node:assert/strict";
import test from "node:test";
import { softBudgetMessage } from "../../dist/core/owner-controller.js";
import { ParentHistoryError } from "../../dist/core/ports.js";
import { errorReply, resultReply, runReply, waitReply } from "../../dist/tools/replies.js";
import { deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";

test("notifications survive absent waiters, never wake them, and are claimed only once by concurrent normal returns", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("a", task("a")), b = await c.submit("b", task("b"));
  await until(() => ports.length === 2 && ports.every((p) => p.streaming));
  ports[1].callbacks.notify("B before wait");
  assert.equal((await c.wait([a.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
  assert.equal((await c.wait([b.run_id], { mode: "all", timeout_ms: 0 })).progress, undefined);
  const cancelled = AbortSignal.abort(); ports[0].callbacks.notify("A buffered");
  assert.equal((await c.wait([a.run_id], { mode: "all", signal: cancelled })).reason, "interrupted");
  const one = c.wait([a.run_id], { mode: "all" }), two = c.wait([a.run_id], { mode: "all" });
  ports[0].callbacks.notify("one claim");
  let resolved = false; void one.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  ports[0].finish("A");
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first.progress.map((event) => event.text), ["A buffered", "one claim"]);
  assert.equal(second.progress, undefined, "concurrent waiter cannot duplicate a claim");
  ports[1].finish("B"); const final = await ended(c, b);
  assert.deepEqual(final.progress.map((event) => event.text), ["B before wait"]);
  assert.equal(c.view(b.run_id).pending_messages, 0);
});

test("an unrelated terminal return preserves all 15 running peers' progress", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 16, resident_limit: 16 } });
  const runs = [];
  for (let index = 0; index < 16; index++) runs.push(await c.submit(`run-${index}`, task(`run-${index}`)));
  await until(() => ports.length === 16 && ports.every((port) => port.streaming));
  ports[0].callbacks.notify("terminal notice");
  for (const port of ports.slice(1)) { port.callbacks.notify("first"); port.callbacks.notify("second"); }
  ports[0].finish("done"); await until(() => c.view(runs[0].run_id).phase === "settled");
  const reply = waitReply(await c.wait(runs.map((run) => run.run_id), { mode: "any" }));
  assert.equal(reply.reason, "condition"); assert.equal(reply.progress_claimed, 1);
  assert.deepEqual(reply.progress.map((event) => event.text), ["terminal notice"]);
  assert.equal(reply.progress_remaining, 30);
  assert(reply.runs.slice(1).every((run) => run.pending_messages === 2));
  assert.deepEqual(reply.pending_run_ids, runs.slice(1).map((run) => run.run_id));
  for (let index = 1; index < 16; index++) {
    assert.equal(c.view(runs[index].run_id).pending_messages, 2);
    ports[index].finish("done");
    const result = await ended(c, runs[index]);
    assert.deepEqual(result.progress.map((event) => event.text), ["first", "second"]);
    assert.equal(c.view(runs[index].run_id).pending_messages, 0);
  }
});

test("attention is per-wait level readiness, not an owner-wide consumed edge", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("question", task("question")), b = await c.submit("peer", task("peer"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const ids = [a.run_id, b.run_id];
  const one = c.wait(ids, { mode: "all", timeout_ms: 1000 });
  const two = c.wait(ids, { mode: "all", timeout_ms: 1000 });
  ports[0].callbacks.question("which option?"); ports[0].finish("please choose");
  for (const value of await Promise.all([one, two])) {
    assert.equal(value.reason, "attention");
    assert.equal(value.snapshots[0].outcome.question, "which option?");
  }
  const again = waitReply(await c.wait(ids, { mode: "all", timeout_ms: 0 }));
  assert.equal(again.reason, "attention", "readiness survives an unobserved or stale previous reply");
  assert.deepEqual(again.pending_run_ids, [b.run_id]);
  assert.equal((await c.wait(again.pending_run_ids, { mode: "all", timeout_ms: 0 })).reason, "timeout");
  assert.equal(ports[1].stopped, 0);
});

test("core question recording rejects overlong inputs rather than claiming a sliced question is complete", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("question", task("question")); await until(() => ports[0]?.streaming);
  const question = "Q".repeat(8190) + "🚀";
  ports[0].callbacks.question(question);
  for (const invalid of ["Q".repeat(8191) + "🚀", "Q".repeat(8193), " ", null]) {
    assert.throws(() => ports[0].callbacks.question(invalid), errorCode("INVALID_QUESTION"));
  }
  ports[0].finish("please answer"); await ended(c, run);
  const result = resultReply(c.getResult(run.run_id));
  assert.equal(result.status, "needs_input"); assert.equal(result.question, question);
  assert.equal(result.question_complete, true); assert.equal(result.question_omitted_chars, 0);
});

test("bounded inbox reports loss; terminal replies retain progress and remaining-message counts", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const old = ports[0].callbacks;
  for (let i = 0; i < 66; i++) old.notify(`message ${i}`);
  assert.equal(c.view(a.run_id).pending_messages, 64); assert.equal(c.view(a.run_id).notification_drops, 2);
  ports[0].finish("FINAL"); await until(() => c.view(a.run_id).phase === "settled");
  const reply = waitReply(await c.wait([a.run_id], { mode: "all" }));
  assert.equal(reply.reason, "condition"); assert.equal(reply.progress_claimed, 64);
  assert.equal(reply.progress.length, 2, "projection keeps the latest bounded progress per Run");
  assert.deepEqual(reply.progress.map((event) => event.text), ["message 64", "message 65"]);
  assert.equal(reply.progress_omitted, 62);
  assert.equal(reply.runs[0].text, "FINAL"); assert.equal(reply.runs[0].notification_drops, 2);
  assert.equal(reply.runs[0].pending_messages, undefined);
  assert.equal((await ended(c, a)).progress, undefined, "one normal return claims the whole bounded inbox");
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b" }); await until(() => ports[0].calls.length === 2);
  old.notify("STALE"); assert.equal(c.view(a.run_id).pending_messages, 0); assert.equal(c.view(b.run_id).pending_messages, 0);
});

test("a new owner block wakes every pending waiter, but not a later retry", async (t) => {
  let starts = 0;
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 3 }, history: (point) => {
    if (point === "begin" && ++starts === 3) throw new ParentHistoryError("broadcast parent write unavailable");
  } });
  const a = await c.submit("a", task("a")), b = await c.submit("b", task("b"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  ports[0].callbacks.notify("A still running"); ports[1].callbacks.notify("B still running");
  const one = c.wait([a.run_id], { mode: "all", timeout_ms: 1000 });
  const two = c.wait([b.run_id], { mode: "all", timeout_ms: 1000 });
  await c.submit("damaged", task("damaged"));
  const replies = await Promise.all([one, two]);
  assert.deepEqual(replies.map((reply) => reply.reason), ["owner_blocked", "owner_blocked"]);
  for (const reply of replies) {
    assert.equal(reply.snapshots[0].owner_blocked, true);
    assert.equal(reply.snapshots[0].pending_messages, 1);
    assert.equal(reply.progress, undefined, "owner faults must not consume running peers' progress");
  }
  const late = await c.wait([a.run_id, b.run_id], { mode: "all", timeout_ms: 0 });
  assert.equal(late.reason, "timeout", "the same owner fault remains an edge for later waits");
  assert(late.snapshots.every((run) => run.owner_blocked && run.pending_messages === 1));
  assert.equal(ports[0].stopped, 0); assert.equal(ports[1].stopped, 0);
});

test("releasing an Agent retains bounded notifications for a later historical Run wait", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("history", task("history")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.notify("recorded before release"); ports[0].finish("done");
  await until(() => c.view(run.run_id).phase === "settled");
  assert.equal((await c.release(run.agent_id)).released, true);
  assert.equal(c.view(run.run_id).pending_messages, 1);
  const reply = await c.wait([run.run_id], { mode: "all" });
  assert.deepEqual(reply.progress.map((event) => event.text), ["recorded before release"]);
  assert.equal((await c.wait([run.run_id], { mode: "all" })).progress, undefined);
});

test("owner block is an edge, not an immediate-return loop; later waits still receive messages or interruption", async (t) => {
  let starts = 0;
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 }, history: (point) => {
    if (point === "begin" && ++starts === 2) throw new ParentHistoryError("parent write unavailable");
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  await c.submit("damaged", task("damaged")); await until(() => c.stats().parent_error);
  // A is still executing. The first wait reports the owner edge, not a fake exit.
  assert.equal((await c.wait([a.run_id], { mode: "all" })).reason, "owner_blocked");
  const abort = new AbortController(); const next = c.wait([a.run_id], { mode: "all", signal: abort.signal });
  let resolved = false; void next.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  ports[0].callbacks.notify("still executing"); await tick(); assert.equal(resolved, false);
  abort.abort(); assert.equal((await next).reason, "interrupted");
  assert.equal(c.view(a.run_id).pending_messages, 1, "interruption preserves progress");
  ports[0].finish("done"); const final = await ended(c, a);
  assert.deepEqual(final.progress.map((event) => event.text), ["still executing"]);
  assert.match(runReply(c.view(a.run_id)).owner_error, /parent write unavailable/);
});

for (const clean of [true, false]) test(`prequeued peers start during pending cleanup; later clean=${clean} keeps correct fault domain`, async (t) => {
  const hold = deferred(), entered = deferred();
  const { controller: c, ports, owner } = await fixture(t, { cleanupUncertainExpected: !clean });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].dispose = async () => { ports[0].disposed++; entered.resolve(); await hold.promise; return { shutdownExited: clean, errors: clean ? [] : ["synthetic cleanup timeout"] }; };
  t.after(() => hold.resolve());
  const b = await c.submit("b", task("b")); ports[0].finish("invalid facts", "invalid"); await entered.promise;
  await until(() => ports[1]?.streaming);
  assert.equal(c.stats().cleaning, 1); assert.equal(c.stats().active, 1); assert.equal(c.stats().resident, 2);
  assert.equal(c.runs.get(a.run_id).session, ports[0]);
  await assert.rejects(c.submit("reuse", { resume: a.agent_id, prompt: "reuse" }), errorCode("AGENT_BUSY"));
  const queued = await c.submit("queued", task("queued"));
  hold.resolve(); await until(() => c.view(a.run_id).phase === "settled");
  assert.equal(c.runs.get(a.run_id).session, undefined);
  assert.equal(c.stats().cleanup_uncertain, !clean); assert.equal(c.view(b.run_id).execution_exited, false);
  ports[1].finish("healthy peer"); await until(() => c.view(b.run_id).phase === "settled");
  if (clean) {
    await until(() => ports[2]?.streaming); ports[2].finish("healthy queue"); await ended(c, queued);
  } else {
    assert.equal(c.view(queued.run_id).status, "queued");
    await assert.rejects(c.submit("new", task("new")), errorCode("OWNER_CLEANUP_UNCERTAIN"));
    assert.equal((await c.shutdown(50)).closed, false); owner.assertHeld();
  }
});

for (const before of [63, 64]) test(`automatic soft budget has its own provenance and does not spend the ${before}-input quota`, async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  for (let i = 0; i < before; i++) c.steer(a.run_id, `user ${i}`);
  ports[0].callbacks.turnEnd(true); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.includes(softBudgetMessage));
  if (before === 63) c.steer(a.run_id, "last user input");
  assert.throws(() => c.steer(a.run_id, "over quota"), errorCode("INPUT_LIMIT"));
  assert.equal(events.filter((e) => e.kind === "steer").length, 64);
  assert.equal(events.filter((e) => e.kind === "soft_budget").length, 1);
  assert.equal(ports[0].inputs.filter((s) => s === softBudgetMessage).length, 1);
});

test("thin results distinguish paging from omission and preserve actionable error details", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 5 } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("0123456789"); await ended(c, a);
  const first = resultReply(c.getResult(a.run_id, { limit: 2 }));
  assert.equal(first.omitted_chars, 5); assert(first.next_cursor); assert.equal(Object.hasOwn(first, "truncated"), false);
  const last = resultReply(c.getResult(a.run_id, { cursor: first.next_cursor }));
  assert.equal(first.text + last.text, "01234"); assert.equal(last.next_cursor, undefined); assert.equal(last.omitted_chars, 5);
  await c.release(a.agent_id);
  try { await c.submit("released", { resume: a.agent_id, prompt: "x" }); assert.fail(); }
  catch (error) { assert.equal(errorReply(error).error.reason, "explicitly_released"); }
  try { await c.submit("unsupported", { ...task("x"), wait: true }); assert.fail(); }
  catch (error) { assert(errorReply(error).error.allowed.includes("prompt")); assert.equal(errorReply(error).error.parameter, "wait"); }
  assert.equal(errorReply({ code: "OWNER_PARENT_UNAVAILABLE", details: { error: "x".repeat(1000), secret_fixture: "hidden" } }).error.message.length, 512);
});
