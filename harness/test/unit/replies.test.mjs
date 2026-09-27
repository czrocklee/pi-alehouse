import assert from "node:assert/strict";
import test from "node:test";
import { agentRow, finishedReply, errorReply, resultReply, taskReply, waitEnvelopeBytes, waitReply,
  WAIT_SERIALIZED_REPLY_LIMIT } from "../../dist/tools/replies.js";
import { deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

const named = (name, rest = {}) => task(name, { name, ...rest });
const namesOf = (c) => (run_id) => c.view(run_id).name;
const compact = (value) => {
  const forbidden = /"(?:run_id|agent_id|owner_id|generation|phase|execution_exited|finalization_pending|history_ref|result_ref|cleanup_errors|effective_settings|outcome|snapshots|runtime|drain|resumable|model_stop_reason|max_duration_ms|settings|model|preset)"/;
  assert(!forbidden.test(JSON.stringify(value)), JSON.stringify(value));
};

test("wait replies include each result once, by Agent name, without internal state", async (t) => {
  const { controller: c, ports } = await fixture(t, { history: () => {} });
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); const full = await ended(c, a), reply = waitReply(full, undefined, namesOf(c));
  compact(reply);
  assert.deepEqual(reply, { reason: "done", agents: [{ agent: "orca", status: "completed", result: "answer" }] });
  assert(JSON.stringify(reply).length < JSON.stringify(full).length / 4);
  assert.deepEqual(resultReply(c.getResult(a.run_id), namesOf(c)), reply.agents[0]);
  const receipt = taskReply(a, namesOf(c)); compact(receipt);
  assert.deepEqual(receipt, { agent: "orca", status: "running" });
  assert.deepEqual(finishedReply(c.view(a.run_id)), { agent: "orca", status: "completed" });
});

test("only roster rows carry bounded labels, with Unicode-safe truncation", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("label", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, run);
  const page = c.getResult(run.run_id), summary = c.agentSummary(run.agent_id);
  const escaped = "\n\\\"".repeat(1000);
  for (const [description, expected] of [
    ["检查取消竞态", "检查取消竞态"], ["x".repeat(120), "x".repeat(120)], ["x".repeat(121), "x".repeat(120)],
    ["x".repeat(118) + "🚀", "x".repeat(118) + "🚀"], ["x".repeat(119) + "🚀tail", "x".repeat(119)],
    ["文".repeat(4096), "文".repeat(120)], [escaped, escaped.slice(0, 120)],
  ]) {
    const view = { ...page.snapshot, description };
    const row = agentRow(view, summary, namesOf(c));
    assert.equal(row.label, expected); assert.equal(row.label.isWellFormed(), true); compact(row);
    for (const ordinary of [taskReply(view, namesOf(c)), finishedReply(view), resultReply({ ...page, snapshot: view }, namesOf(c)),
      waitReply({ reason: "condition", snapshots: [view] }, undefined, namesOf(c)).agents[0]]) {
      assert.equal("label" in ordinary, false); assert.equal(JSON.stringify(ordinary).includes(description.slice(0, 20)), false);
    }
  }
  assert.equal(c.view(run.run_id).description, "orca", "projection never mutates stored metadata");
});

test("model sees finishing, then the settled status, never contradictory lifecycle flags", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await entered.promise;
  const reply = resultReply(c.getResult(a.run_id), namesOf(c)); compact(reply);
  assert.equal(reply.status, "finishing"); assert.equal(reply.next_cursor, undefined);
  gate.resolve(); await ended(c, a);
  assert.equal(taskReply(c.view(a.run_id), namesOf(c)).status, "completed");
});

test("live runtime and drain diagnostics stay host-only; the roster shows elapsed time while running", async (t) => {
  let mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { clock: { wall: Date.now, mono: () => mono } } });
  const run = await c.submit("runtime", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.runtime({ activity: "generating", context: { tokens: 20, context_window: 8192 } });
  ports[0].callbacks.drain("sdk_idle");
  mono = 5000;
  const live = c.view(run.run_id);
  assert.equal(live.runtime.activity, "generating"); assert.equal(live.drain.waiting_for, "sdk_idle");
  for (const reply of [taskReply(live, namesOf(c)), resultReply(c.getResult(run.run_id), namesOf(c)),
    waitReply({ reason: "timeout", snapshots: [live] }, undefined, namesOf(c))]) compact(reply);
  const row = agentRow(live, c.agentSummary(run.agent_id), namesOf(c)); compact(row);
  assert.equal(row.elapsed_s, 5); assert.equal(row.context_pct, 0);
  ports[0].finish("done"); await ended(c, run);
  const settled = agentRow(c.view(run.run_id), c.agentSummary(run.agent_id), namesOf(c));
  assert.equal(settled.elapsed_s, undefined); assert.equal(settled.context_pct, 0, "last observed context is kept after the task");
});

test("questions and progress arrive on the Agent's own entry; errors name Agents, not IDs", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  const waiting = c.wait([a.run_id], { mode: "all" }); ports[0].callbacks.notify("progress");
  let resolved = false; void waiting.then(() => { resolved = true; }); await new Promise((done) => setImmediate(done));
  assert.equal(resolved, false);
  ports[0].callbacks.question("factor?"); ports[0].finish("Please provide factor");
  const reply = waitReply(await waiting, undefined, namesOf(c)); compact(reply);
  assert.deepEqual(reply, { reason: "done", agents: [{ agent: "orca", status: "needs_input", question: "factor?",
    result: "Please provide factor", progress: ["progress"] }] });
  assert.equal(taskReply(c.view(a.run_id), namesOf(c)).question, undefined);
  assert.equal(resultReply(c.getResult(a.run_id), namesOf(c)).question, "factor?");
  assert.equal(finishedReply(c.view(a.run_id)).has_question, true);
  const names = { agent: (id) => c.agentName(id), run: namesOf(c) };
  assert.deepEqual(errorReply({ code: "AGENT_BUSY", details: { run_id: a.run_id } }, names).error, { code: "AGENT_BUSY", agent: "orca" });
  assert.deepEqual(errorReply({ code: "AGENT_UNAVAILABLE", details: { agent_id: a.agent_id, reason: "released" } }, names).error,
    { code: "AGENT_UNAVAILABLE", agent: "orca", reason: "released" });
  assert.deepEqual(errorReply({ code: "RUN_NOT_FOUND", details: { run_id: "unknown" } }, names).error, { code: "RUN_NOT_FOUND" },
    "an unresolvable ID is dropped, never echoed");
});

test("a turn-capped task is flagged next to the status it qualifies, not left as plain completed", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 2 } });
  const a = await c.submit("a", named("orca", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  ports[0].finish("exact");
  const exact = waitReply(await ended(c, a), undefined, namesOf(c)); compact(exact);
  assert.equal(exact.agents[0].status, "completed");
  assert.equal("limit_reached" in exact.agents[0], false, "absent means unflagged");
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b", max_turns: 1 });
  await until(() => ports[0].calls.length === 2);
  ports[0].callbacks.turnEnd(true); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.length > 0);
  ports[0].finish("cut short"); const capped = await ended(c, b);
  for (const reply of [waitReply(capped, undefined, namesOf(c)).agents[0], resultReply(c.getResult(b.run_id), namesOf(c)),
    taskReply(c.view(b.run_id), namesOf(c)), finishedReply(c.view(b.run_id))]) {
    compact(reply); assert.equal(reply.status, "completed"); assert.equal(reply.limit_reached, true, JSON.stringify(reply));
  }
});

test("the hard envelope fallback preserves questions, limits and explicit retrieval requirements", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("bounded", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, a);
  const snapshots = Array.from({ length: 16 }, (_, index) => ({ ...c.view(a.run_id), run_id: `run-${index}`,
    name: `a${index}`, owner_error: "\u0000".repeat(512),
    status: "needs_input",
    outcome: { status: "needs_input", error: "\u0000".repeat(512), limit_reached: true, question: "question?" } }));
  const value = { reason: "condition", snapshots };
  const reply = waitReply(value, undefined, (id) => id);
  assert(waitEnvelopeBytes(reply) <= WAIT_SERIALIZED_REPLY_LIMIT);
  const measured = [];
  const wrap = (wait) => { measured.push(wait); return { padding: "x".repeat(60000), wait }; };
  const squeezed = waitReply(value, undefined, (id) => id, wrap);
  assert.equal(squeezed.response_limit_reached, true);
  assert(squeezed.agents.every((entry) => entry.limit_reached && entry.question_truncated && entry.result_omitted));
  assert.equal(measured.at(-1), squeezed, "the returned reply itself was measured with its wrapper");
  assert(waitEnvelopeBytes(wrap(squeezed)) <= WAIT_SERIALIZED_REPLY_LIMIT);
  assert.throws(() => waitReply(value, undefined, (id) => id, (wait) => ({ padding: "x".repeat(65536), wait })), errorCode("WAIT_REPLY_TOO_LARGE"));
  // A task stopped while asking is not answerable: even the compact fallback
  // must not send the caller to agent_read for a question agent_send cannot answer.
  const stopped = { reason: "condition", snapshots: snapshots.map((view) => ({ ...view, status: "cancelled",
    outcome: { ...view.outcome, status: "cancelled" } })) };
  const stoppedSqueezed = waitReply(stopped, undefined, (id) => id, wrap);
  assert.equal(stoppedSqueezed.response_limit_reached, true);
  assert(stoppedSqueezed.agents.every((entry) => entry.status === "interrupted" && entry.result_omitted && !("error" in entry) &&
    !entry.question_truncated && !entry.question), "the compact fallback, without an unanswerable question");
});

test("overfull question batches return complete questions before sharing the remainder", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("questions", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish(""); await ended(c, a);
  const snapshots = Array.from({ length: 16 }, (_, index) => ({ ...c.view(a.run_id), run_id: `run-${index}`, name: `a${index}`,
    outcome: { status: "needs_input", question: "Q".repeat(2000) }, status: "needs_input" }));
  const reply = waitReply({ reason: "condition", snapshots }, undefined, (id) => id);
  assert.equal(reply.agents.filter((entry) => !entry.question_truncated).length, 8);
  assert(reply.agents.slice(0, 8).every((entry) => entry.question.length === 2000));
  assert(reply.agents.slice(8).every((entry) => entry.question_truncated));
  assert.equal(reply.agents.reduce((sum, entry) => sum + entry.question.length, 0), 16384);
  // A deferred large question must not take prefixes at the expense of a later
  // short question that could instead be answered directly.
  const overfull = waitReply({ reason: "condition", snapshots: snapshots.slice(0, 4).map((view, index) => ({ ...view,
    outcome: { ...view.outcome, question: "Q".repeat([8190, 8192, 8192, 2][index]) } })) }, undefined, (id) => id);
  assert.deepEqual(overfull.agents.map((entry) => !entry.question_truncated), [true, true, false, true]);
});

for (const remaining of [1, 9]) test(`emoji result pages respect ${remaining} remaining UTF-16 units without broken cursors`, async (t) => {
  const { controller: c, ports } = await fixture(t), runs = [], answer = "🚀".repeat(10);
  for (let index = 0; index < 3; index++) {
    const run = await c.submit(`run-${index}`, named(`a${index}`)); runs.push(run);
    await until(() => ports[index]?.streaming);
    if (index < 2) ports[index].callbacks.question("Q".repeat(index === 0 ? 8192 : 8192 - remaining));
    ports[index].finish(answer); await ended(c, run);
  }
  const limits = [];
  const reply = waitReply({ reason: "condition", snapshots: runs.map((run) => c.view(run.run_id)) }, (id, limit) => {
    limits.push(limit); return c.getResult(id, { limit });
  }, namesOf(c));
  if (remaining === 1) {
    assert.deepEqual(limits, [1]);
    assert(reply.agents.every((entry) => entry.result_omitted && entry.result === undefined && entry.next_cursor === undefined));
  } else {
    assert.deepEqual(limits, [3, 2, 3, 2, 5, 4]);
    for (const [index, entry] of reply.agents.entries()) {
      assert(entry.result.length > 0 && entry.next_cursor && !entry.result_omitted);
      assert.equal(entry.result + c.getResult(runs[index].run_id, { cursor: entry.next_cursor }).text, answer);
    }
  }
});

test("diagnostic and abstract error prefixes never split a Unicode surrogate pair", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("unicode-errors", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("done"); await ended(c, run);
  for (const offset of [-2, -1, 0]) {
    const diagnostic = "x".repeat(512 + offset) + "🚀tail", model = "m".repeat(128 + offset) + "🚀tail";
    const expectedDiagnostic = "x".repeat(512 + offset) + (offset === -2 ? "🚀" : "");
    const expectedModel = "m".repeat(128 + offset) + (offset === -2 ? "🚀" : "");
    const error = errorReply({ code: "FIXTURE", details: { reason: diagnostic, error: diagnostic, resolution: diagnostic,
      model, requested: model, allowed: [model] } }).error;
    for (const key of ["reason", "message", "resolution"]) {
      assert.equal(error[key], expectedDiagnostic); assert.equal(error[key].isWellFormed(), true);
    }
    assert.equal(error.model, undefined, "concrete models stay out of ordinary errors");
    for (const value of [error.requested, error.allowed[0]]) {
      assert.equal(value, expectedModel); assert.equal(value.isWellFormed(), true);
    }
    const view = c.view(run.run_id), reply = taskReply({ ...view, owner_error: diagnostic, outcome: { ...view.outcome, error: diagnostic } }, namesOf(c));
    assert.equal(reply.error, expectedDiagnostic); assert.equal(reply.owner_error, expectedDiagnostic);
  }
});

test("a cut allowed list reports its remainder and never reads as the whole set", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `provider/model-${i}`);
  const cut = errorReply({ code: "INVALID_MODEL", details: { key: "model", allowed: many, requested: "model-7" } }).error;
  assert.equal(cut.allowed.length, 32); assert.equal(cut.allowed_omitted, 8);
  assert.equal(cut.requested, "model-7"); assert.equal(cut.parameter, "model");
  const whole = errorReply({ code: "INVALID_MODEL", details: { key: "model", allowed: many.slice(0, 32) } }).error;
  assert.equal(whole.allowed.length, 32); assert.equal("allowed_omitted" in whole, false); assert.equal("requested" in whole, false);
  const levels = errorReply({ code: "THINKING_INCOMPATIBLE", details: { key: "parent_thinking",
    parent_thinking: "minimal", thinking: "medium", model: "openai-codex/gpt-5.6-luna",
    preset: "team", difficulty: 2, strength: "light", reason: "mapped_target_unsupported" } }).error;
  assert.equal(levels.model, undefined); assert.equal(levels.preset, undefined); assert.equal(levels.difficulty, 2);
  assert.equal(levels.strength, undefined);
  assert.equal(levels.parent_thinking, "minimal"); assert.equal(levels.thinking, undefined, "mapped targets are routing details");
  assert.equal(levels.allowed, undefined);
  assert.deepEqual(errorReply({ code: "INVALID_DIFFICULTY", details: { key: "difficulty",
    resolution: "Use an integer from 1 to 5 to rate the task difficulty." } }).error, { code: "INVALID_DIFFICULTY", parameter: "difficulty",
    resolution: "Use an integer from 1 to 5 to rate the task difficulty." });
  assert.equal(errorReply({ code: "X", details: { allowed: "not an array" } }).error.allowed, undefined);
  assert.equal(errorReply({ code: "X", details: { allowed: [] } }).error.allowed, undefined, "an empty list offers nothing");
  assert.equal(errorReply({ code: "X" }).error.allowed, undefined);
});

test("the parent's interrupt verb names task statuses; an Esc-stopped wait is aborted, not interrupted", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  c.cancel(run.run_id);
  assert.equal(taskReply(c.view(run.run_id), namesOf(c)).status, "interrupting");
  const abort = new AbortController(); abort.abort();
  const aborted = await c.wait([run.run_id], { mode: "all", signal: abort.signal, include_results: false });
  assert.equal(waitReply(aborted, undefined, namesOf(c)).reason, "aborted");
  ports[0].finish("partial", "aborted");
  const settled = await ended(c, run);
  assert.equal(waitReply(settled, undefined, namesOf(c)).agents[0].status, "interrupted");
  assert.equal(finishedReply(c.view(run.run_id)).status, "interrupted");
});

test("a stopped task's question is readable but never advertised as answerable", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("orca"));
  await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("factor?");
  c.cancel(a.run_id);
  ports[0].finish("partial", "aborted");
  await ended(c, a);
  const view = c.view(a.run_id);
  assert.equal(view.status, "cancelled", "interrupted while asking");
  assert.ok(view.outcome?.question, "the question text is still recorded");
  // Rows and the finished feed must not point the model at agent_send.
  assert.equal(finishedReply(view).has_question, undefined);
  assert.equal(agentRow(view, c.agentSummary(view.agent_id), namesOf(c)).has_question, undefined);
  // Nor may the wait reply, the main place questions surface, full or compact.
  const waited = waitReply({ reason: "condition", snapshots: [view] }, undefined, namesOf(c));
  assert.equal(waited.agents[0].status, "interrupted");
  assert.equal(waited.agents[0].question, undefined);
  // The reading path keeps the question text for composing the next agent_run.
  assert.equal(resultReply(c.getResult(a.run_id), namesOf(c)).question, "factor?");
  // And agent_send indeed cannot deliver to a stopped task.
  const sent = await c.send("s", a.agent_id, "the answer");
  assert.equal(sent.delivery, "not_delivered");
  // The answerable case still advertises: a needs_input task keeps the flag.
  const b = await c.submit("b", task("b", { name: "otter" }));
  await until(() => ports[1]?.streaming);
  ports[1].callbacks.question("why?");
  ports[1].finish("asked");
  await ended(c, b);
  const asked = c.view(b.run_id);
  assert.equal(asked.status, "needs_input");
  assert.equal(finishedReply(asked).has_question, true);
  assert.equal(agentRow(asked, c.agentSummary(asked.agent_id), namesOf(c)).has_question, true);
  assert.equal(waitReply({ reason: "condition", snapshots: [asked] }, undefined, namesOf(c)).agents[0].question, "why?");
  assert.equal((await c.send("s2", b.agent_id, "because")).delivery, "answered");
});
