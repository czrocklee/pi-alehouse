import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { OwnerController, DELIVERY_LOG_LIMIT } from "../../dist/core/owner-controller.js";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { taskReply } from "../../dist/tools/replies.js";
import { FakePort, deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

// These are scheduler/lifecycle tests with an explicit fake SessionPort/journal.
// They are not SDK permission, Bash cancellation or real-model acceptance.
test("new Agent admission rejects legacy and mismatched difficulty slots before allocation", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const baseline = c.stats();
  for (const strength of ["light", "standard", "strong", "d1", "d2", "d4", "d5"]) {
    const request = task("invalid route");
    request.settings = { ...request.settings, difficulty: 3, strength };
    await assert.rejects(c.submit(`invalid-${strength}`, request), errorCode("INVALID_EFFECTIVE_SETTINGS"));
    assert.equal(c.stats().agents, baseline.agents); assert.equal(c.stats().runs, baseline.runs);
    assert.equal(c.stats().resident, baseline.resident); assert.equal(ports.length, 0);
  }
  for (const difficulty of [1, 2, 3, 4, 5]) {
    const request = task("valid route");
    request.settings = { ...request.settings, difficulty, strength: `d${difficulty}` };
    const accepted = await c.submit(`valid-${difficulty}`, request);
    assert.equal(accepted.effective_settings.strength, `d${difficulty}`);
    assert.equal(accepted.effective_settings.difficulty, difficulty);
  }
});

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
  assert.equal(await c.waitForRuns([first.run_id], { mode: "all", timeout_ms: 0 }), "ready");
  assert.equal(c.getResult(first.run_id).text, "first result");
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

test("accepted automatic and historical preset routes stay immutable on reuse", { timeout: 5000 }, async (t) => {
  const { controller: c, ports } = await fixture(t);
  const mapped = task("automatic");
  mapped.settings = { ...mapped.settings, thinking: "high", parent_thinking: "low",
    thinking_resolution: "automatic_mapping", effort_source: "preset" };
  const first = await c.submit("auto", mapped);
  assert.equal(first.effective_settings.thinking, "high");
  assert.equal(first.effective_settings.parent_thinking, "low");
  assert.equal(first.effective_settings.thinking_resolution, "automatic_mapping");
  await until(() => ports[0]?.streaming);
  ports[0].finish("done"); await ended(c, first);
  const accepted = structuredClone(c.view(first.run_id).effective_settings);
  const reuse = await c.submit("auto-reuse", { resume: first.agent_id, prompt: "again" });
  assert.deepEqual(reuse.effective_settings, accepted);
  assert.deepEqual(c.view(first.run_id).effective_settings, accepted, "the accepted route is not re-resolved");
  await assert.rejects(c.submit("mutate-route", { resume: first.agent_id, prompt: "x", thinking: "max" }),
    errorCode("IMMUTABLE_SETTING"));
  await assert.rejects(c.submit("mutate-settings", { resume: first.agent_id, prompt: "x",
    settings: { ...accepted, thinking: "max", thinking_resolution: "identity" } }), errorCode("IMMUTABLE_SETTING"));
  await until(() => ports[0].calls.length === 2);
  ports[0].finish("again"); await ended(c, reuse);

  const historical = task("historical map");
  historical.settings = { ...historical.settings, thinking: "medium", parent_thinking: "minimal",
    thinking_resolution: "preset_mapping" };
  const old = await c.submit("historical", historical);
  assert.equal(old.effective_settings.thinking_resolution, "preset_mapping");
  assert.equal(old.effective_settings.thinking, "medium");
  assert.equal(old.effective_settings.parent_thinking, "minimal");
  await until(() => ports[1]?.streaming);
  ports[1].finish("old"); await ended(c, old);
  const reusedOld = await c.submit("historical-reuse", { resume: old.agent_id, prompt: "still mapped" });
  assert.equal(reusedOld.effective_settings.thinking_resolution, "preset_mapping");
  assert.equal(reusedOld.effective_settings.parent_thinking, "minimal");
  assert.equal(reusedOld.effective_settings.thinking, "medium");
  await until(() => ports[1].calls.length === 2);
  ports[1].finish("still"); await ended(c, reusedOld);
});

test("lifecycle any/all, timeout and abort stay gap-free and never consume alerts", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("a", task("a", { name: "alpha" })), b = await c.submit("b", task("b", { name: "beta" }));
  await until(() => ports.length === 2 && ports.every((p) => p.streaming));
  const waitAny = c.waitForRuns([a.run_id, b.run_id], { mode: "any" });
  const waitAll = c.waitForRuns([a.run_id, b.run_id], { mode: "all" });
  ports[0].finish("A");
  assert.equal(await waitAny, "ready");
  assert.equal(await c.waitForRuns([b.run_id], { mode: "all", timeout_ms: 0 }), "timeout");
  const abort = new AbortController();
  const interrupt = c.waitForRuns([b.run_id], { mode: "all", signal: abort.signal }); abort.abort();
  assert.equal(await interrupt, "aborted"); assert.equal(c.view(b.run_id).status, "running");
  ports[1].callbacks.alert("important fact, not an answer");
  ports[1].callbacks.alert("still active");
  let resolved = false; void waitAll.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  assert.equal(await c.waitForRuns([b.run_id], { mode: "all", timeout_ms: 0 }), "timeout");
  assert.equal(c.view(b.run_id).pending_messages, 2, "lifecycle timeout leaves alerts pending");
  const observed = JSON.parse((await c.observe({ kind: "wait", agent_ids: [b.agent_id], wait_ms: 0 }, { validate() {} })).content[0].text);
  assert.equal(observed.reason, "alert");
  assert.deepEqual(observed.alerts.map((event) => event.message), ["important fact, not an answer", "still active"]);
  assert.equal(c.view(b.run_id).status, "running");
  ports[1].finish("B");
  assert.equal(await waitAll, "ready");
  assert.equal(await c.waitForRuns([a.run_id, b.run_id], { mode: "all" }), "ready");
  assert.equal(c.getResult(a.run_id).text, "A"); assert.equal(c.getResult(b.run_id).text, "B");
});

test("all model waits continue past normal completion but prioritize questions and task issues", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 6 } });
  const peer = await c.submit("peer", task("peer", { name: "peer" }));
  const normal = await c.submit("normal", task("normal", { name: "normal" }));
  const question = await c.submit("question-attention", task("question-attention", { name: "question" }));
  const failed = await c.submit("failed-attention", task("failed-attention", { name: "failed" }));
  const cancelled = await c.submit("cancel-attention", task("cancel-attention", { name: "cancelled" }));
  const limited = await c.submit("limit-attention", task("limit-attention", { name: "limited", max_turns: 1 }));
  await until(() => ports.length === 6 && ports.every((port) => port.streaming));
  ports[1].finish("ordinary"); await ended(c, normal);
  assert.equal(JSON.parse((await c.observe({ kind: "wait", agent_ids: [normal.agent_id, peer.agent_id], mode: "all", wait_ms: 0 }, { validate() {} })).content[0].text).reason, "timeout");

  ports[2].callbacks.question("need input"); ports[2].finish("please answer"); await ended(c, question);
  let value = JSON.parse((await c.observe({ kind: "wait", agent_ids: [question.agent_id, peer.agent_id], mode: "all" }, { validate() {} })).content[0].text);
  assert.equal(value.reason, "question"); assert.equal(value.agents[0].status, "needs_input");

  ports[3].finish("partial", "error", "provider failed"); await ended(c, failed);
  value = JSON.parse((await c.observe({ kind: "wait", agent_ids: [failed.agent_id, peer.agent_id], mode: "all" }, { validate() {} })).content[0].text);
  assert.equal(value.reason, "task_issue"); assert.equal(value.agents[0].status, "failed");

  c.cancel(cancelled.run_id); ports[4].finish("partial", "aborted"); await ended(c, cancelled);
  value = JSON.parse((await c.observe({ kind: "wait", agent_ids: [cancelled.agent_id, peer.agent_id], mode: "all" }, { validate() {} })).content[0].text);
  assert.equal(value.reason, "task_issue"); assert.equal(value.agents[0].status, "interrupted");

  ports[5].callbacks.turnEnd(true); ports[5].finish("best effort"); await ended(c, limited);
  value = JSON.parse((await c.observe({ kind: "wait", agent_ids: [limited.agent_id, peer.agent_id], mode: "all" }, { validate() {} })).content[0].text);
  assert.equal(value.reason, "task_issue"); assert.equal(value.agents[0].limit_reached, true);
  assert.deepEqual(value.pending, ["peer"]);
  // Task issues outrank done even for any and already-terminal targets.
  assert.equal(JSON.parse((await c.observe({ kind: "wait", agent_ids: [failed.agent_id, peer.agent_id], mode: "any" }, { validate() {} })).content[0].text).reason, "task_issue");
});

test("questions only interrupt all after finalization and never authorize early reuse", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 }, history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  t.after(() => gate.resolve());
  const question = await c.submit("question", task("question", { name: "question" })), peer = await c.submit("peer", task("peer", { name: "peer" }));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  assert.equal(ports[0].callbacks.question("choice?"), "recorded");
  assert.equal(JSON.parse((await c.observe({ kind: "wait", agent_ids: [question.agent_id, peer.agent_id], mode: "all", wait_ms: 0 }, { validate() {} })).content[0].text).reason, "timeout");
  ports[0].finish("please choose"); await entered.promise;
  assert.equal(c.view(question.run_id).finalization_pending, true);
  assert.equal(c.view(question.run_id).question_id, undefined);
  assert.equal(JSON.parse((await c.observe({ kind: "wait", agent_ids: [question.agent_id, peer.agent_id], mode: "all", wait_ms: 0 }, { validate() {} })).content[0].text).reason, "timeout");
  await assert.rejects(c.answer("early", question.agent_id, `q_${"0".repeat(32)}`, "yes"), errorCode("STALE_ANSWER"));
  const waiting = c.observe({ kind: "wait", agent_ids: [question.agent_id, peer.agent_id], mode: "all" }, { validate() {} }); gate.resolve();
  assert.equal(JSON.parse((await waiting).content[0].text).reason, "question");
  assert.equal(c.view(question.run_id).resumable, true); assert.equal(ports[1].stopped, 0);
});

test("core lifecycle waits support more than sixteen resident Agents without model publication", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { resident_limit: 17, queue_limit: 17 } });
  const runs = [];
  for (let index = 0; index < 17; index++) runs.push(await c.submit(`large-${index}`, task(`task ${index}`)));
  await until(() => ports[0]?.streaming);
  assert.equal(c.stats().resident, 17);
  const waiting = c.waitForRuns(runs.map((run) => run.run_id), { mode: "all", timeout_ms: 3000 });
  for (const run of runs) c.cancel(run.run_id);
  ports[0].finish("partial", "aborted");
  assert.equal(await waiting, "ready");
  assert(runs.every((run) => c.view(run.run_id).status === "cancelled"));
  assert(runs.every((run) => !c.runs.get(run.run_id).finished_presented), "lifecycle waits do not mark finished presentation");
});

test("queue/resident limits, queued cancel, and non-cooperative cancel retain the execution slot and lock", async (t) => {
  const { controller: c, ports, directory, owner_id } = await fixture(t, { controller: { queue_limit: 1, resident_limit: 2 } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const b = await c.submit("b", task("b"));
  await assert.rejects(c.submit("full", task("full")), errorCode("QUEUE_FULL"));
  const cancel = c.cancel(b.run_id); assert.equal(cancel.execution_exited, true);
  await ended(c, b); assert.equal(c.view(b.run_id).status, "cancelled"); assert.equal(ports.length, 1);
  assert.equal(c.view(b.run_id).resumable, true, "an Agent lives until kill, even if its first task never started");
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
  await assert.rejects(c.answer("stale", a.agent_id, `q_${"0".repeat(32)}`, "answer"), errorCode("STALE_ANSWER"));
  const questionId = c.view(q.run_id).question_id;
  const answer = await c.answer("answer", a.agent_id, questionId, "main");
  await until(() => ports[0].calls.length === 4); ports[0].finish("answered"); await ended(c, answer);
  await assert.rejects(c.answer("again", a.agent_id, questionId, "main"), errorCode("STALE_ANSWER"));
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
  assert.equal(taskReply(view, () => "").reason, "output_limit", "the model sees the outcome, not the provider stop reason");
  assert.equal("model_stop_reason" in taskReply(view, () => ""), false);

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
  const questionId = c.view(q.run_id).question_id;
  const answer = await c.answer("answer", q.agent_id, questionId, "yes");
  c.cancel(answer.run_id); await ended(c, answer);
  assert.equal(ports[0].calls.length, 1);
  assert.equal(c.view(q.run_id).question_id, questionId, "pre-input cancellation restores the same question");
  const retry = await c.answer("retry", q.agent_id, questionId, "no");
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

test("shipped default limits are pinned, not just mechanism", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-p1-defaults-"));
  const owner = await FileOwnerLease.open({ directory, owner_id: randomUUID(), flock });
  const controller = await OwnerController.open({ owner, createSession: async () => new FakePort() });
  try {
    assert.deepEqual(controller.stats().limits, {
      concurrency: 4, resident: 8, queue: 16, grace: 5, output: 1_048_576,
      historyRuns: 512, historyOutput: 64 * 1024 * 1024, releaseWait: 10_000,
    }, "the documented headline numbers must not drift silently");
  } finally {
    await controller.shutdown(1000);
    owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queued Run is cancelled by shutdown and the owner still closes", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1 } });
  const first = await c.submit("first", task("first"));
  await until(() => ports[0]?.streaming);
  const second = await c.submit("second", task("second"));
  assert.equal(c.stats().queued, 1);
  ports[0].autoStop = true; // The tracked stop settles the running Run as aborted.
  const report = await c.shutdown(5000);
  assert.equal(report.closed, true, "an owner with queued FIFO work must still be able to close");
  assert.equal(c.view(second.run_id).status, "cancelled", "the queued Run was cancelled, not left hanging");
  assert.equal(c.view(first.run_id).status, "cancelled");
  assert.equal(c.stats().queued, 0);
});

test("a failing release during shutdown keeps the owner open instead of closing on top of it", async (t) => {
  const { controller: c, ports } = await fixture(t, { cleanupUncertainExpected: true });
  const run = await c.submit("run", task("run"));
  await until(() => ports[0]?.streaming);
  ports[0].finish("done"); await ended(c, run);
  c.releaseAgent = () => { throw new Error("release exploded"); };
  const report = await c.shutdown(3000);
  assert.equal(report.closed, false, "the owner must not hand back the lease with an unreleased Agent");
  assert.equal(report.cleanup_uncertain, true);
  assert.equal(report.resident, 1);
  delete c.releaseAgent; // The fixture's own shutdown then releases normally.
});

test("send delivery replay is a bounded window: the newest replays, the oldest re-delivers", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1 } });
  const run = await c.submit("run", task("run"));
  await until(() => ports[0]?.streaming);
  ports[0].finish("done"); await ended(c, run);
  // Every send to a settled task records a not_delivered delivery without
  // touching the per-run steer budget, so the replay window can be filled.
  let prepared = 0;
  for (let index = 0; index <= DELIVERY_LOG_LIMIT; index++) {
    const { delivery } = await c.send(`send-${index}`, run.agent_id, `message ${index}`, { prepare: () => prepared++ });
    assert.equal(delivery, "not_delivered");
  }
  assert.equal(prepared, DELIVERY_LOG_LIMIT + 1);
  // The newest entry is still inside the window: replay prepares nothing new.
  const replayed = await c.send(`send-${DELIVERY_LOG_LIMIT}`, run.agent_id, `message ${DELIVERY_LOG_LIMIT}`, { prepare: () => prepared++ });
  assert.equal(replayed.delivery, "not_delivered");
  assert.equal(prepared, DELIVERY_LOG_LIMIT + 1, "a replayed delivery never re-delivers");
  // The oldest entry fell out of the window and is treated as a fresh send.
  const fresh = await c.send("send-0", run.agent_id, "message 0", { prepare: () => prepared++ });
  assert.equal(fresh.delivery, "not_delivered");
  assert.equal(prepared, DELIVERY_LOG_LIMIT + 2, "an evicted request id re-delivers instead of growing forever");
});

test("a synchronous finalization fault settles the Run failed and releases its reservation", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("poison", task("poison"));
  await until(() => ports[0]?.streaming);
  // A hostile getter in the port's facts: normalizeFacts touches output first.
  ports[0].calls[0].done.resolve({ kind: "success",
    get output() { throw new Error("poisoned output getter"); } });
  await ended(c, run);
  const view = c.view(run.run_id);
  assert.equal(view.status, "failed", "the Run settles instead of wedging in finalizing");
  assert.equal(view.outcome?.reason, "finalization_failed");
  assert.match(view.outcome?.error ?? "", /poisoned output getter/);
  assert.ok(view.cleanup_errors.some((entry) => /FINALIZATION_FAILED/.test(entry)), "diagnostics land on the Run");
  assert.equal(c.stats().reserved_output_chars, 0, "the output reservation is released, not leaked");
  // The final report was unreadable: spend is unknown, never zero-filled, and
  // is still rolled into the parent's ledger exactly once.
  assert.deepEqual(view.usage?.partial, ["input", "output", "cache_read", "cache_write", "cost"]);
  assert.deepEqual(c.stats().unreported_usage?.partial, ["input", "output", "cache_read", "cache_write", "cost"]);
  const row = c.list().find((entry) => entry.agent_id === run.agent_id);
  assert.ok(!row?.resident, "the quarantined Agent is released so the owner can still close");
  assert.equal((await c.shutdown(5000)).closed, true);
});

test("a parked settle path and an unconfirmed stop are observable, never released early", async (t) => {
  let mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1,
    clock: { wall: Date.now, mono: () => mono } } });
  const run = await c.submit("waiter", task("waiter"));
  await until(() => ports[0]?.streaming);
  // Park finish() on the inputs await: a steer delivery held at the gate.
  ports[0].deliveryGate = deferred();
  c.steer(run.run_id, "held");
  ports[0].finish("done");
  await until(() => (c.stats().finalizing_waits ?? []).some((entry) => entry.run_id === run.run_id && entry.wait === "inputs"));
  const parked = c.stats().finalizing_waits.find((entry) => entry.run_id === run.run_id);
  assert.equal(parked.wait, "inputs");
  assert.ok(parked.elapsed_ms >= 0);
  assert.equal(c.view(run.run_id).finalization_pending, true, "still finalizing while parked");
  ports[0].deliveryGate.resolve();
  await ended(c, run);
  assert.equal(c.stats().finalizing_waits, undefined, "the wait marker clears once the await settles");
  // An unconfirmed stop is visible with its reason, including deadline overruns.
  const second = await c.submit("second", task("second"));
  await until(() => ports[1]?.streaming);
  mono += 600_000; // A long-running task...
  c.cancel(second.run_id);
  mono += 250; // ...whose stop has gone unconfirmed briefly.
  const stopping = (c.stats().stopping ?? []).find((entry) => entry.run_id === second.run_id);
  assert.ok(stopping, "a stop request with no confirmed exit is visible");
  assert.equal(stopping.stop_reason, "user_cancel");
  assert.equal(stopping.elapsed_ms, 250, "measured from the stop request, not from execution start");
  ports[1].finish("partial", "aborted");
  await ended(c, second);
  assert.equal(c.stats().stopping, undefined);
});
