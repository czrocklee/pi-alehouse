import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { compactRunReply, runReply } from "../../dist/tools/replies.js";
import { FakePort, deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

// These are scheduler/lifecycle tests with an explicit fake SessionPort/journal.
// They are not SDK permission, Bash cancellation or real-model acceptance.
test("new and reuse share FIFO, request identity, immutable snapshots and exact Run waits", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const first = await c.submit("a", task("first", { name: "月兔" }));
  await until(() => ports[0]?.streaming);
  const second = await c.submit("b", task("second"));
  assert.equal(second.status, "queued");
  assert.equal(first.name, "月兔"); assert.equal(second.name, "", "an unnamed Agent keeps no synthesized id");
  assert.equal((await c.submit("b", task("second"))).run_id, second.run_id);
  await assert.rejects(c.submit("b", task("changed")), errorCode("REQUEST_CONFLICT"));
  await assert.rejects(c.submit("busy", { resume: first.agent_id, prompt: "busy" }), errorCode("AGENT_BUSY"));
  ports[0].finish("first result"); await ended(c, first);
  const reuse = await c.submit("c", { resume: first.agent_id, prompt: "follow up" });
  assert.notEqual(reuse.run_id, first.run_id); assert.equal(reuse.agent_id, first.agent_id);
  assert.equal(reuse.status, "queued");
  assert.equal(c.list().find((r) => r.agent_id === first.agent_id).run_id, reuse.run_id);
  await until(() => ports[1]?.streaming);
  ports[1].finish("second result"); await ended(c, second);
  await until(() => ports[0].calls.length === 2);
  assert.equal(ports.length, 2); assert.equal(ports[0].calls[1].prompt, "follow up");
  const oldWait = await c.wait([first.run_id], { mode: "all", timeout_ms: 0 });
  assert.equal(oldWait.reason, "condition"); assert.equal(oldWait.results[0].text, "first result");
  assert.equal(c.view(first.run_id).resumable, false);
  ports[0].finish("review result"); await ended(c, reuse);
  assert.equal(c.view(first.run_id).resumable, true); // Agent availability is current, Run state immutable.
  for (const [key, value] of [["model", "other"], ["provider", "other"], ["tools", ["write"]]]) {
    await assert.rejects(c.submit(`mutate-${key}`, { resume: first.agent_id, prompt: "x", [key]: value }),
      errorCode("IMMUTABLE_SETTING"));
  }
  await assert.rejects(c.submit("old", { resume: first.agent_id, prompt: "x", wait: true }), errorCode("UNSUPPORTED_PARAMETER"));
  const accepted = task("stable");
  const submit = c.submit("snapshot", accepted); accepted.settings = { ...accepted.settings, model: "changed" };
  const snapshot = await submit; assert.equal(snapshot.effective_settings.model, "controlled");
  c.cancel(snapshot.run_id); await until(() => ports.at(-1)?.streaming || c.view(snapshot.run_id).execution_exited);
  if (ports.at(-1).streaming) ports.at(-1).finish("", "aborted");
  await ended(c, snapshot);
});

test("wait read/subscribe is gap-free; any/all, timeout, interrupt and progress stay distinct", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("a", task("a")), b = await c.submit("b", task("b"));
  await until(() => ports.length === 2 && ports.every((p) => p.streaming));
  const waitAny = c.wait([a.run_id, b.run_id], { mode: "any" });
  const waitAll = c.wait([a.run_id, b.run_id], { mode: "all" });
  ports[0].finish("A");
  assert.equal((await waitAny).reason, "condition");
  assert.equal((await c.wait([b.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
  const abort = new AbortController();
  const interrupt = c.wait([b.run_id], { mode: "all", signal: abort.signal }); abort.abort();
  assert.equal((await interrupt).reason, "interrupted"); assert.equal(c.view(b.run_id).status, "running");
  ports[1].callbacks.notify("progress, not an answer");
  ports[1].callbacks.notify("still active");
  let resolved = false; void waitAll.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  assert.equal((await c.wait([b.run_id], { mode: "all", timeout_ms: 0 })).progress, undefined,
    "timeouts do not claim buffered progress");
  ports[1].finish("B");
  const all = await waitAll; assert.equal(all.reason, "condition");
  assert.deepEqual(all.progress.map((event) => event.text), ["progress, not an answer", "still active"]);
  assert.equal((await c.wait([a.run_id, b.run_id], { mode: "all" })).reason, "condition");
  assert.equal((await c.wait([a.run_id, b.run_id], { mode: "all", include_results: false })).results, undefined);
});

test("all waits continue past normal completion but return attention for actionable terminal peers", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 6 } });
  const peer = await c.submit("peer", task("peer"));
  const normal = await c.submit("normal", task("normal"));
  const question = await c.submit("question-attention", task("question-attention"));
  const failed = await c.submit("failed-attention", task("failed-attention"));
  const cancelled = await c.submit("cancel-attention", task("cancel-attention"));
  const limited = await c.submit("limit-attention", task("limit-attention", { max_turns: 1 }));
  await until(() => ports.length === 6 && ports.every((port) => port.streaming));
  ports[1].finish("ordinary"); await ended(c, normal);
  assert.equal((await c.wait([normal.run_id, peer.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");

  ports[2].callbacks.question("need input"); ports[2].finish("please answer"); await ended(c, question);
  let value = await c.wait([question.run_id, peer.run_id], { mode: "all" });
  assert.equal(value.reason, "attention"); assert.equal(value.snapshots[0].status, "needs_input");

  ports[3].finish("partial", "error", "provider failed"); await ended(c, failed);
  value = await c.wait([failed.run_id, peer.run_id], { mode: "all" });
  assert.equal(value.reason, "attention"); assert.equal(value.snapshots[0].status, "failed");

  c.cancel(cancelled.run_id); ports[4].finish("partial", "aborted"); await ended(c, cancelled);
  value = await c.wait([cancelled.run_id, peer.run_id], { mode: "all" });
  assert.equal(value.reason, "attention"); assert.equal(value.snapshots[0].status, "cancelled");

  ports[5].callbacks.turnEnd(true); ports[5].finish("best effort"); await ended(c, limited);
  value = await c.wait([limited.run_id, peer.run_id], { mode: "all" });
  assert.equal(value.reason, "attention"); assert.equal(value.snapshots[0].outcome.limit_reached, true);
  assert.deepEqual(value.snapshots.filter((run) => !["completed", "needs_input", "failed", "cancelled"].includes(run.status)).map((run) => run.run_id), [peer.run_id]);
  // any is level-triggered and keeps its existing condition spelling even when
  // the terminal Run predates the wait.
  assert.equal((await c.wait([failed.run_id, peer.run_id], { mode: "any" })).reason, "condition");
});

test("questions only interrupt all after finalization and never authorize early reuse", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 }, history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  t.after(() => gate.resolve());
  const question = await c.submit("question", task("question")), peer = await c.submit("peer", task("peer"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  ports[0].callbacks.question("choice?");
  assert.equal((await c.wait([question.run_id, peer.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
  ports[0].finish("please choose"); await entered.promise;
  assert.equal(c.view(question.run_id).finalization_pending, true);
  assert.equal((await c.wait([question.run_id, peer.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
  await assert.rejects(c.submit("early", { resume: question.agent_id, prompt: "yes", answer_to_run_id: question.run_id }), errorCode("AGENT_BUSY"));
  const waiting = c.wait([question.run_id, peer.run_id], { mode: "all" }); gate.resolve();
  assert.equal((await waiting).reason, "attention");
  assert.equal(c.view(question.run_id).resumable, true); assert.equal(ports[1].stopped, 0);
});

test("queue/resident limits, queued cancel, and non-cooperative cancel retain the execution slot and lock", async (t) => {
  const { controller: c, ports, directory, owner_id } = await fixture(t, { controller: { queue_limit: 1, resident_limit: 2 } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const b = await c.submit("b", task("b"));
  await assert.rejects(c.submit("full", task("full")), errorCode("QUEUE_FULL"));
  const cancel = c.cancel(b.run_id); assert.equal(cancel.execution_exited, true);
  await ended(c, b); assert.equal(c.view(b.run_id).status, "cancelled"); assert.equal(ports.length, 1);
  assert.equal(c.view(b.run_id).resumable, false);
  c.cancel(a.run_id); await tick();
  assert.equal(c.view(a.run_id).status, "cancelling"); assert.equal(c.stats().active, 1);
  const shutdown = await c.shutdown(5); assert.equal(shutdown.closed, false); assert.equal(shutdown.active, 1);
  await assert.rejects(FileOwnerLease.open({ directory, owner_id, flock }), /OWNER_LOCKED/);
  ports[0].finish("partial", "aborted"); await ended(c, a);
  assert.equal(c.view(a.run_id).status, "cancelled"); assert.equal(c.stats().active, 0);
  assert.equal((await c.shutdown()).closed, true);
});

test("input closes at exit before history IO; in-flight delivery drains, old input never reaches the next Run", async (t) => {
  const io = deferred(), reached = deferred(); let hold = false;
  const { controller: c, ports, events } = await fixture(t, { history: async (point) => {
    if (hold && point === "finish") { reached.resolve(); await io.promise; }
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].deliveryGate = deferred();
  c.steer(a.run_id, "old held input"); await tick();
  hold = true; ports[0].finish("finished a");
  await until(() => c.view(a.run_id).execution_exited);
  assert.equal(c.stats().active, 0); assert.equal(c.view(a.run_id).finalization_pending, true);
  assert.throws(() => c.steer(a.run_id, "too late"), errorCode("RUN_INPUT_CLOSED"));
  assert.equal(c.cancel(a.run_id).result, "already_exited");
  await assert.rejects(c.submit("too soon", { resume: a.agent_id, prompt: "b" }), errorCode("AGENT_BUSY"));
  ports[0].deliveryGate.resolve(); await reached.promise;
  assert.deepEqual(ports[0].inputs, []);
  assert.deepEqual(c.view(a.run_id).discarded_inputs, ["old held input"]);
  assert.equal(c.view(a.run_id).phase, "finalizing");
  io.resolve(); await ended(c, a);
  assert.equal(c.view(a.run_id).status, "completed"); assert.equal(c.view(a.run_id).stop_reason, undefined);
  const b = await c.submit("b", { resume: a.agent_id, prompt: "only b" }); await until(() => ports[0].calls.length === 2);
  assert.equal(ports[0].calls[1].prompt, "only b"); assert.deepEqual(ports[0].inputs, []);
  ports[0].finish("b"); await ended(c, b);
  assert.deepEqual(events.map((e) => e.kind), ["submit", "steer", "resume"]);
  assert.equal(new Set(events.map((e) => e.event_id)).size, events.length);
});

test("first accepted stop reason wins; provider errors, question, soft and hard budget outcomes remain distinct", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2, grace_turns: 0 } });
  const a = await c.submit("hard", task("hard", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("question before hard limit"); ports[0].callbacks.turnStart(); c.cancel(a.run_id);
  ports[0].finish("partial", "aborted", "aborted while stopping"); await ended(c, a);
  const hard = c.view(a.run_id); assert.equal(hard.status, "failed"); assert.equal(hard.stop_reason, "hard_budget");
  assert.equal(hard.outcome.reason, "turn_limit"); assert.equal(hard.outcome.question, "question before hard limit");
  const b = await c.submit("cancel", task("cancel", { max_turns: 1 })); await until(() => ports[1]?.streaming);
  c.cancel(b.run_id); ports[1].callbacks.turnStart(); ports[1].finish("", "aborted"); await ended(c, b);
  assert.equal(c.view(b.run_id).stop_reason, "user_cancel"); assert.equal(c.view(b.run_id).status, "cancelled");
  const e = await c.submit("error", { resume: a.agent_id, prompt: "provider fails" }); await until(() => ports[0].calls.length === 2);
  ports[0].finish("partial error", "error", "provider unavailable"); await ended(c, e);
  assert.equal(c.view(e.run_id).status, "failed"); assert.equal(c.view(e.run_id).outcome.error, "provider unavailable");
  const q = await c.submit("question", { resume: a.agent_id, prompt: "question", max_turns: 1 }); await until(() => ports[0].calls.length === 3);
  ports[0].callbacks.question("Which branch?"); ports[0].finish("need answer"); await ended(c, q);
  assert.equal(c.view(q.run_id).status, "needs_input"); assert.equal(c.view(q.run_id).outcome.limit_reached, false);
  await assert.rejects(c.submit("pending", { resume: a.agent_id, prompt: "unrelated" }), errorCode("PENDING_QUESTION"));
  await assert.rejects(c.submit("stale", { resume: a.agent_id, prompt: "answer", answer_to_run_id: a.run_id }), errorCode("STALE_ANSWER"));
  const answer = await c.submit("answer", { resume: a.agent_id, prompt: "main", answer_to_run_id: q.run_id });
  await until(() => ports[0].calls.length === 4); ports[0].finish("answered"); await ended(c, answer);
  await assert.rejects(c.submit("again", { resume: a.agent_id, prompt: "main", answer_to_run_id: q.run_id }), errorCode("STALE_ANSWER"));
});

test("an unrecovered model output limit fails without becoming a turn limit or poisoning reuse", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const limited = await c.submit("length", task("length")); await until(() => ports[0]?.streaming);
  // Fail closed even if a non-SDK port incorrectly labels the preserved reason success.
  ports[0].finish("useful partial", "success", undefined, "length"); await ended(c, limited);
  const view = c.view(limited.run_id);
  assert.equal(view.status, "failed"); assert.equal(view.outcome.reason, "output_limit");
  assert.equal(view.model_stop_reason, "length"); assert.equal(view.outcome.model_stop_reason, "length");
  assert.equal(view.outcome.limit_reached, false); assert.equal(view.stop_reason, undefined);
  assert.equal(c.getResult(limited.run_id).text, "useful partial"); assert.equal(view.resumable, true);
  assert.equal(runReply(view).model_stop_reason, "length");
  assert.equal(compactRunReply(view).model_stop_reason, "length");

  const resumed = await c.submit("after-length", { resume: limited.agent_id, prompt: "continue" });
  await until(() => ports[0].calls.length === 2); ports[0].finish("recovered", "success", undefined, "stop"); await ended(c, resumed);
  assert.equal(c.view(resumed.run_id).status, "completed"); assert.equal(c.view(resumed.run_id).model_stop_reason, "stop");
});

test("restart starts empty; live paging survives release but is not a durable result store", async (t) => {
  const { controller: c, ports, directory, owner_id } = await fixture(t);
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("甲😀乙".repeat(2000)); await ended(c, a);
  const first = c.getResult(a.run_id, { limit: 2 }); assert.equal(first.text, "甲😀"); assert.ok(first.next_cursor);
  let text = first.text, cursor = first.next_cursor;
  while (cursor) { const page = c.getResult(a.run_id, { cursor, limit: 300 }); text += page.text; cursor = page.next_cursor; }
  assert.equal(text, "甲😀乙".repeat(2000));
  await c.release(a.agent_id);
  assert.equal(c.view(a.run_id).resumable, false);
  assert.equal(c.getResult(a.run_id).result_ref.scope, "owner_memory");
  assert.equal(c.getResult(a.run_id).text, text.slice(0, 4096));
  assert.throws(() => c.getResult(a.run_id, { cursor: "../../owner.json" }), errorCode("INVALID_CURSOR"));
  assert.equal((await c.shutdown()).closed, true);
  const owner = await FileOwnerLease.open({ directory, owner_id, flock });
  const reopened = await OwnerController.open({ owner, createSession: async () => { throw new Error("must not replay"); } });
  assert.deepEqual(reopened.list(), []);
  assert.throws(() => reopened.view(a.run_id), errorCode("RUN_NOT_FOUND"));
  await assert.rejects(reopened.submit("resume", { resume: a.agent_id, prompt: "x" }), errorCode("AGENT_NOT_FOUND"));
  const other = await fixture(t);
  assert.throws(() => other.controller.view(a.run_id), errorCode("RUN_NOT_FOUND"));
  const b = await other.controller.submit("b", task("b")); await until(() => other.ports[0]?.streaming);
  other.ports[0].finish("different"); await ended(other.controller, b);
  assert.throws(() => other.controller.getResult(b.run_id, { cursor: first.next_cursor }), errorCode("INVALID_CURSOR"));
  assert.equal((await reopened.shutdown()).closed, true);
  assert.deepEqual(await readdir(join(directory, owner_id)), ["owner.lock"]);
});

test("queued answer reservation reopens on cancellation without entering history", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const q = await c.submit("q", task("q")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("Choose?"); ports[0].finish("waiting"); await ended(c, q);
  const blocker = await c.submit("block", task("block")); await until(() => ports[1]?.streaming);
  const answer = await c.submit("answer", { resume: q.agent_id, prompt: "yes", answer_to_run_id: q.run_id });
  c.cancel(answer.run_id); await ended(c, answer);
  assert.equal(ports[0].calls.length, 1);
  const retry = await c.submit("retry", { resume: q.agent_id, prompt: "no", answer_to_run_id: q.run_id });
  ports[1].finish(); await ended(c, blocker); await until(() => ports[0].calls.length === 2);
  ports[0].finish("no accepted"); await ended(c, retry);
});

test("initialization cancellation never prompts, cleanup uncertainty is not a released owner", async (t) => {
  const gate = deferred(), port = new FakePort();
  const { controller: c, owner } = await fixture(t, { controller: { createSession: async () => { await gate.promise; return port; } } });
  const a = await c.submit("a", task("a")); c.cancel(a.run_id);
  assert.equal((await c.shutdown(5)).closed, false);
  gate.resolve(); await ended(c, a);
  assert.equal(port.calls.length, 0); assert.equal(c.view(a.run_id).status, "cancelled");
  assert.equal((await c.shutdown()).closed, true);
  assert.throws(() => owner.assertHeld(), /OWNER_LOCK_CLOSED/);
});
