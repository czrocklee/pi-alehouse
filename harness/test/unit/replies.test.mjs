import assert from "node:assert/strict";
import test from "node:test";
import { runReply, compactRunReply, listRunReply, resultReply, waitReply, errorReply, waitEnvelopeBytes, WAIT_SERIALIZED_REPLY_LIMIT } from "../../dist/tools/replies.js";
import { deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

const compact = (value) => {
  const forbidden = /"(?:owner_id|generation|phase|execution_exited|finalization_pending|history_ref|result_ref|cleanup_errors|effective_settings|outcome|snapshots)"/;
  assert(!forbidden.test(JSON.stringify(value)), JSON.stringify(value));
};
test("wait replies include each result once, without internal snapshots or refs", async (t) => {
  const { controller: c, ports } = await fixture(t, { history: () => {} });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); const full = await ended(c, a), reply = waitReply(full);
  compact(reply); assert.equal(reply.runs.length, 1); assert.equal(reply.runs[0].text, "answer");
  assert.equal(reply.runs[0].complete, true); assert.equal(reply.runs[0].status, "completed");
  assert(JSON.stringify(reply).length < JSON.stringify(full).length / 2);
  assert.deepEqual(resultReply(c.getResult(a.run_id)), reply.runs[0]);
  const initial = runReply(a, true); compact(initial);
  assert.equal("name" in initial, false, "an unnamed Agent reports no name; the ids route");
  assert.deepEqual(initial.settings, { profile: "reader", difficulty: 3 });
  assert.equal(JSON.stringify(initial).includes("fixture/controlled"), false, "ordinary replies hide concrete models");
});
test("only list rows carry bounded task descriptions, with explicit Unicode-safe truncation", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("description", task("source label")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, run);
  const page = c.getResult(run.run_id);
  const escaped = "\n\\\"".repeat(1000);
  for (const [description, expected, truncated] of [
    ["检查取消竞态", "检查取消竞态", false],
    ["x".repeat(256), "x".repeat(256), false],
    ["x".repeat(257), "x".repeat(256), true],
    ["x".repeat(254) + "🚀", "x".repeat(254) + "🚀", false],
    ["x".repeat(254) + "🚀tail", "x".repeat(254) + "🚀", true],
    ["x".repeat(255) + "🚀tail", "x".repeat(255), true],
    ["文".repeat(4096), "文".repeat(256), true],
    [escaped, escaped.slice(0, 256), true],
  ]) {
    const view = { ...page.snapshot, description };
    const row = listRunReply(view);
    assert.equal(row.description, expected); assert.equal(row.description_truncated, truncated);
    assert(row.description.length <= 256); assert.equal(row.description.isWellFormed(), true);
    assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
    assert.equal(row.name, undefined); assert.equal(row.role, undefined);
    const { description: _label, description_truncated: _cut, ...rest } = row;
    assert.deepEqual(rest, runReply(view, true), "list labels cannot change routing or lifecycle projection");
    for (const ordinary of [runReply(view), runReply(view, true), compactRunReply(view),
      resultReply({ ...page, snapshot: view }), waitReply({ reason: "condition", snapshots: [view] }).runs[0]]) {
      assert.equal("description" in ordinary, false); assert.equal("description_truncated" in ordinary, false);
    }
  }
  assert.equal(c.view(run.run_id).description, "source label", "projection never mutates stored metadata");
});

test("model sees finishing and resumable=false, not contradictory lifecycle flags", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await entered.promise;
  const reply = resultReply(c.getResult(a.run_id)); compact(reply);
  assert.equal(reply.status, "finishing"); assert.equal(reply.resumable, false); assert.equal(reply.complete, false);
  gate.resolve(); await ended(c, a);
});
test("model replies omit live runtime after execution exit, including history finalization", async (t) => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const run = await c.submit("runtime-projection", task("runtime-projection")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.runtime({ activity: "generating", context: { tokens: 20, context_window: 8192 } });
  assert.equal(runReply(c.view(run.run_id)).runtime.activity, "generating");
  ports[0].finish("done"); await entered.promise;
  const finishing = c.view(run.run_id);
  assert.equal(finishing.execution_exited, true); assert.equal(finishing.finalization_pending, true);
  assert.equal(finishing.runtime.activity, "generating", "raw last observation remains available to host diagnostics");
  assert.equal(runReply(finishing).runtime, undefined);
  assert.equal(resultReply(c.getResult(run.run_id)).runtime, undefined);
  assert.equal(waitReply({ reason: "timeout", snapshots: [finishing] }).runs[0].runtime, undefined);
  gate.resolve(); const done = await ended(c, run);
  assert.equal(waitReply(done).runs[0].runtime, undefined);
  assert.equal(runReply(c.list()[0]).runtime, undefined);
  for (const status of ["completed", "failed", "cancelled", "needs_input"]) {
    assert.equal(runReply({ ...c.view(run.run_id), status }).runtime, undefined, status);
  }
});

test("drain observations age on reads without resetting, waking waits or surviving exit", async (t) => {
  let mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { clock: { wall: Date.now, mono: () => mono } } });
  const run = await c.submit("drain-view", task("drain-view")); await until(() => ports[0]?.streaming);
  const callbacks = ports[0].callbacks;
  callbacks.drain("unknown"); assert.equal(c.view(run.run_id).drain, undefined);
  const waiting = c.wait([run.run_id], { mode: "all", timeout_ms: 10 });
  callbacks.drain("deliveries");
  mono = 1200;
  callbacks.drain("sdk_idle");
  callbacks.runtime({ activity: "generating" });
  mono = 5000;
  const view = c.view(run.run_id);
  assert.deepEqual(view.drain, { waiting_for: "sdk_idle", elapsed_ms: 5000 });
  assert.deepEqual(runReply(view).drain, view.drain);
  assert.deepEqual(resultReply(c.getResult(run.run_id)).drain, view.drain);
  assert.deepEqual(waitReply({ reason: "timeout", snapshots: [view] }).runs[0].drain, view.drain);
  assert.equal(compactRunReply(view).diagnostic_omitted, true);
  assert.equal(c.stats().active, 1); assert.equal(c.view(run.run_id).status, "running");
  const stats = c.stats(); stats.draining[0].elapsed_ms = -1;
  assert.equal(c.stats().draining[0].elapsed_ms, 5000);
  assert.equal((await waiting).reason, "timeout", "observability cannot change model wait semantics");
  ports[0].finish("done"); await ended(c, run);
  callbacks.drain("deliveries");
  assert.equal(c.view(run.run_id).drain, undefined); assert.equal(c.stats().draining, undefined);
  assert.equal(runReply(c.view(run.run_id)).drain, undefined);
  assert.equal(c.view(run.run_id).status, "completed");
  for (const ending of [{ execution_exited: true }, { status: "completed" }]) {
    assert.equal(runReply({ ...view, ...ending }).drain, undefined);
  }
});

test("question/progress and reconfiguration errors retain actionable fields only", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const waiting = c.wait([a.run_id], { mode: "all" }); ports[0].callbacks.notify("progress");
  let resolved = false; void waiting.then(() => { resolved = true; }); await new Promise((done) => setImmediate(done));
  assert.equal(resolved, false);
  ports[0].callbacks.question("factor?"); ports[0].finish("Please provide factor");
  const reply = waitReply(await waiting); compact(reply);
  assert.equal(reply.progress[0].text, "progress"); assert.match(reply.progress[0].event_id, /^[0-9a-f-]{36}$/);
  assert.equal(reply.reason, "condition");
  assert.equal(reply.runs[0].status, "needs_input"); assert.equal(reply.runs[0].has_question, true);
  assert.equal(reply.runs[0].question, "factor?"); assert.equal(reply.runs[0].question_complete, true);
  assert.equal(runReply(c.view(a.run_id), true).question, undefined);
  assert.equal(resultReply(c.getResult(a.run_id)).question, "factor?");
  assert.equal(resultReply(c.getResult(a.run_id)).question_complete, true);
  try { await c.submit("bad", { resume: a.agent_id, prompt: "answer", model: "different" }); assert.fail("must reject"); }
  catch (error) {
    const value = errorReply(error); compact(value);
    assert.equal(value.error.code, "IMMUTABLE_SETTING"); assert.equal(value.error.parameter, "model");
    assert.deepEqual(Object.keys(value.error.settings).sort(), ["difficulty", "profile"]);
    assert.equal(JSON.stringify(value).includes("fixture/controlled"), false);
  }
});

test("a turn-capped Run is flagged next to the status it qualifies, not left as plain completed", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 2 } });
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  ports[0].finish("exact");
  const exact = waitReply(await ended(c, a)); compact(exact);
  assert.equal(exact.runs[0].status, "completed");
  // Not a "false" the model must weigh on every reply: absent means unflagged.
  assert.equal("limit_reached" in exact.runs[0], false);
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b", max_turns: 1 });
  await until(() => ports[0].calls.length === 2);
  ports[0].callbacks.turnEnd(true); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.length > 0);
  ports[0].finish("cut short"); const capped = await ended(c, b);
  assert.equal(capped.snapshots[0].outcome.limit_reached, true);
  for (const reply of [waitReply(capped).runs[0], resultReply(c.getResult(b.run_id)), runReply(c.view(b.run_id))]) {
    compact(reply);
    assert.equal(reply.status, "completed");
    assert.equal(reply.limit_reached, true, JSON.stringify(reply));
  }
});

test("the hard envelope fallback preserves questions, limits and explicit retrieval requirements", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("bounded", task("bounded")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, a);
  const snapshots = Array.from({ length: 16 }, (_, index) => ({ ...c.view(a.run_id), run_id: `run-${index}`,
    name: "\u0000".repeat(256), owner_error: "\u0000".repeat(512),
    outcome: { status: "completed", error: "\u0000".repeat(512), limit_reached: true, question: "question?" } }));
  const value = { reason: "condition", snapshots };
  const reply = waitReply(value);
  assert.equal(reply.response_limit_reached, true);
  assert(waitEnvelopeBytes(reply) <= WAIT_SERIALIZED_REPLY_LIMIT);
  assert(reply.runs.every((run) => run.limit_reached && run.has_question && run.question_complete === false &&
    run.question_requires_get && run.result_requires_get && run.diagnostic_omitted && run.resumable));
  const wrap = (wait) => ({ ...runReply(snapshots[0], true), wait });
  const measured = [];
  const measuredWrap = (wait) => { measured.push(wait); return wrap(wait); };
  const compactReply = waitReply(value, undefined, measuredWrap);
  assert.equal(compactReply.metadata_compacted, true);
  assert.equal(measured.at(-1), compactReply, "the final fallback itself was measured with its wrapper");
  assert(waitEnvelopeBytes(wrap(compactReply)) <= WAIT_SERIALIZED_REPLY_LIMIT);
  const oversizedWrap = (wait) => ({ padding: "x".repeat(65536), wait });
  assert.throws(() => waitReply(value, undefined, oversizedWrap), errorCode("WAIT_REPLY_TOO_LARGE"));
  assert.throws(() => waitReply({ reason: "condition", snapshots: [c.view(a.run_id)] }, undefined, oversizedWrap),
    (error) => error.code === "WAIT_REPLY_TOO_LARGE" && error.details.run_id === a.run_id && error.details.agent_id === a.agent_id);
});

test("overfull question batches return complete questions before sharing the remainder", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("questions", task("questions")); await until(() => ports[0]?.streaming);
  ports[0].finish(""); await ended(c, a);
  const snapshots = Array.from({ length: 16 }, (_, index) => ({ ...c.view(a.run_id), run_id: `run-${index}`,
    outcome: { status: "needs_input", question: "Q".repeat(2000) }, status: "needs_input" }));
  const reply = waitReply({ reason: "condition", snapshots });
  assert.equal(reply.runs.filter((run) => run.question_complete).length, 8);
  assert(reply.runs.slice(0, 8).every((run) => run.question.length === 2000 && !run.question_requires_get));
  assert(reply.runs.slice(8).every((run) => !run.question_complete && run.question_requires_get));
  assert.equal(reply.runs.reduce((sum, run) => sum + run.question.length, 0), 16384);
  assert(waitEnvelopeBytes(reply) <= WAIT_SERIALIZED_REPLY_LIMIT);
  // A deferred large question must not take prefixes at the expense of a later
  // short question that could instead be answered directly.
  const overfull = waitReply({ reason: "condition", snapshots: snapshots.slice(0, 4).map((view, index) => ({ ...view,
    outcome: { ...view.outcome, question: "Q".repeat([8190, 8192, 8192, 2][index]) } })) });
  assert.deepEqual(overfull.runs.map((run) => run.question_complete), [true, true, false, true]);
});

for (const remaining of [1, 9]) test(`emoji result pages respect ${remaining} remaining UTF-16 units without broken cursors`, async (t) => {
  const { controller: c, ports } = await fixture(t), runs = [], answer = "🚀".repeat(10);
  for (let index = 0; index < 3; index++) {
    const run = await c.submit(`run-${index}`, task(`run-${index}`)); runs.push(run);
    await until(() => ports[index]?.streaming);
    if (index < 2) ports[index].callbacks.question("Q".repeat(index === 0 ? 8192 : 8192 - remaining));
    ports[index].finish(answer); await ended(c, run);
  }
  const limits = [];
  const reply = waitReply({ reason: "condition", snapshots: runs.map((run) => c.view(run.run_id)) }, (id, limit) => {
    limits.push(limit); return c.getResult(id, { limit });
  });
  if (remaining === 1) {
    assert.deepEqual(limits, [1]);
    assert(reply.runs.every((run) => run.result_requires_get && run.text === undefined && run.next_cursor === undefined));
  } else {
    assert.deepEqual(limits, [3, 2, 3, 2, 5, 4]);
    for (const run of reply.runs) {
      assert(run.text.length > 0 && run.next_cursor && !run.result_requires_get);
      assert.equal(run.text + c.getResult(run.run_id, { cursor: run.next_cursor }).text, answer);
    }
  }
});

test("diagnostic and abstract error prefixes never split a Unicode surrogate pair", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("unicode-errors", task("unicode-errors")); await until(() => ports[0]?.streaming);
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
    const view = c.view(run.run_id), reply = runReply({ ...view, owner_error: diagnostic, outcome: { ...view.outcome, error: diagnostic } });
    assert.equal(reply.error, expectedDiagnostic); assert.equal(reply.owner_error, expectedDiagnostic);
  }
});

test("a cut allowed list reports its remainder and never reads as the whole set", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `provider/model-${i}`);
  const cut = errorReply({ code: "INVALID_MODEL", details: { key: "model", allowed: many, requested: "model-7" } }).error;
  assert.equal(cut.allowed.length, 32);
  assert.equal(cut.allowed_omitted, 8);
  assert.equal(cut.allowed.length + cut.allowed_omitted, many.length);
  assert.equal(cut.requested, "model-7");
  assert.equal(cut.parameter, "model");
  const whole = errorReply({ code: "INVALID_MODEL", details: { key: "model", allowed: many.slice(0, 32) } }).error;
  assert.equal(whole.allowed.length, 32);
  assert.equal("allowed_omitted" in whole, false);
  assert.equal("requested" in whole, false);
  const levels = errorReply({ code: "THINKING_INCOMPATIBLE", details: { key: "parent_thinking",
    parent_thinking: "minimal", thinking: "medium", model: "openai-codex/gpt-5.6-luna",
    preset: "team", difficulty: 2, strength: "light", reason: "mapped_target_unsupported" } }).error;
  assert.equal(levels.model, undefined); assert.equal(levels.preset, undefined); assert.equal(levels.difficulty, 2);
  assert.equal(levels.strength, undefined);
  assert.equal(levels.parent_thinking, "minimal"); assert.equal(levels.thinking, undefined, "mapped targets are routing details");
  assert.equal(levels.allowed, undefined);
  const invalid = errorReply({ code: "INVALID_DIFFICULTY", details: { key: "difficulty",
    resolution: "Use an integer from 1 to 5 to rate the task difficulty." } }).error;
  assert.deepEqual(invalid, { code: "INVALID_DIFFICULTY", parameter: "difficulty",
    resolution: "Use an integer from 1 to 5 to rate the task difficulty." });
  assert.equal(errorReply({ code: "X", details: { allowed: "not an array" } }).error.allowed, undefined);
  assert.equal(errorReply({ code: "OWNER_HISTORY_LIMIT", details: { resolution: "Close this owner and start fresh." } }).error.resolution,
    "Close this owner and start fresh.");
  assert.equal(errorReply({ code: "X" }).error.allowed, undefined);
});
