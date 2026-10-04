import assert from "node:assert/strict";
import test from "node:test";
import { agentRow, errorReply, taskReply } from "../../dist/tools/replies.js";
import { communicationEnvelopeBytes } from "../../dist/core/communication-envelope.js";
import { deferred, ended, fixture, task, until } from "../support/controller-fixture.mjs";

const named = (name, rest = {}) => task(name, { name, ...rest });
const namesOf = (c) => (id) => c.view(id).name;
const observe = async (c, request, signal) => JSON.parse((await c.observe(request, { validate() {}, signal })).content[0].text);
const read = (c, run, rest = {}) => observe(c, { kind: "read", agent_id: run.agent_id, ...rest });
const wait = (c, runs, rest = {}) => observe(c, { kind: "wait", agent_ids: runs.map((run) => run.agent_id), ...rest });
const compact = (value) => {
  const forbidden = /"(?:run_id|agent_id|owner_id|generation|phase|execution_exited|finalization_pending|history_ref|result_ref|cleanup_errors|effective_settings|outcome|snapshots|runtime|drain|resumable|model_stop_reason|max_duration_ms|settings|model|preset)"/;
  assert(!forbidden.test(JSON.stringify(value)), JSON.stringify(value));
};

test("wait/read share the envelope, original task ordinal and result without exposing internal identity", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, a);
  const reply = await wait(c, [a]); compact(reply);
  assert.equal(reply.reason, "done");
  assert.deepEqual(reply.agents, [{ agent: "orca", task: 1, status: "completed", result: "answer" }]);
  assert.equal(reply.alerts_pending, 0); assert.equal(reply.finished_pending, 0);
  const page = await read(c, a); compact(page);
  assert.equal(page.reason, "snapshot"); assert.deepEqual(page.agents, reply.agents);
  assert.deepEqual(taskReply(a, namesOf(c)), { agent: "orca", task: 1, status: "running" });
});

test("only roster and alert rows carry bounded labels; projection never changes stored descriptions", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("label", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("answer"); await ended(c, a);
  for (const [description, expected] of [
    ["检查取消竞态", "检查取消竞态"], ["x".repeat(121), "x".repeat(120)],
    ["x".repeat(118) + "🚀", "x".repeat(118) + "🚀"], ["x".repeat(119) + "🚀tail", "x".repeat(119)],
    ["文".repeat(4096), "文".repeat(120)],
  ]) {
    const view = { ...c.view(a.run_id), description };
    const row = agentRow(view, c.agentSummary(a.agent_id), namesOf(c)); compact(row);
    assert.equal(row.label, expected); assert(row.label.isWellFormed());
    assert.equal(taskReply(view, namesOf(c)).label, undefined);
  }
  assert.equal(c.view(a.run_id).description, "orca");
});

test("finalizing is finishing, has no stable result cursor and is not yet answerable", async (t) => {
  const gate = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("decision?"); ports[0].finish("answer"); await entered.promise;
  const reply = await read(c, a, { max_chars: 2 }); compact(reply);
  assert.equal(reply.agents[0].status, "finishing"); assert.equal(reply.agents[0].next_cursor, undefined);
  assert.equal(reply.agents[0].result_truncated, true); assert.equal(reply.agents[0].question_id, undefined);
  gate.resolve(); await ended(c, a);
  assert.equal((await read(c, a)).agents[0].status, "needs_input");
});

test("live runtime/drain facts stay out of model replies while roster retains context and elapsed time", async (t) => {
  let mono = 0;
  const { controller: c, ports } = await fixture(t, { controller: { clock: { wall: Date.now, mono: () => mono } } });
  const a = await c.submit("runtime", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.runtime({ activity: "generating", context: { tokens: 20, context_window: 8192 } });
  ports[0].callbacks.drain("sdk_idle"); mono = 5000;
  compact(await read(c, a)); compact(await wait(c, [a], { wait_ms: 0 }));
  const row = agentRow(c.view(a.run_id), c.agentSummary(a.agent_id), namesOf(c)); compact(row);
  assert.equal(row.elapsed_s, 5); assert.equal(row.context_pct, 0);
  ports[0].finish("done"); await ended(c, a);
  const settled = agentRow(c.view(a.run_id), c.agentSummary(a.agent_id), namesOf(c));
  assert.equal(settled.elapsed_s, undefined); assert.equal(settled.context_pct, 0);
});

test("alerts live at envelope top level and can wake a still-running task before its later question", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  const waiting = wait(c, [a]); ports[0].callbacks.alert("important fact");
  const alert = await waiting; compact(alert);
  assert.equal(alert.reason, "alert"); assert.equal(alert.agents[0].status, "running");
  assert.deepEqual(alert.alerts, [{ agent: "orca", task: 1, label: "orca", message: "important fact" }]);
  assert.equal(alert.agents[0].progress, undefined);
  ports[0].callbacks.question("factor?"); ports[0].finish("Please provide factor"); await ended(c, a);
  const question = await wait(c, [a]);
  assert.equal(question.reason, "question"); assert.equal(question.agents[0].question, "factor?");
  assert.match(question.agents[0].question_id, /^q_[0-9a-f]{32}$/);
  assert.equal(question.agents[0].has_question, true);
  const names = { agent: (id) => c.agentName(id), run: namesOf(c) };
  assert.deepEqual(errorReply({ code: "AGENT_BUSY", details: { run_id: a.run_id } }, names).error, { code: "AGENT_BUSY", agent: "orca" });
  assert.deepEqual(errorReply({ code: "RUN_NOT_FOUND", details: { run_id: "unknown" } }, names).error, { code: "RUN_NOT_FOUND" });
});

test("a turn-capped completed task retains limit control and returns task_issue", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 2 } });
  const a = await c.submit("a", named("orca", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  ports[0].finish("exact"); await ended(c, a);
  assert.equal((await wait(c, [a])).agents[0].limit_reached, undefined);
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b", max_turns: 1 });
  await until(() => ports[0].calls.length === 2); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.length > 0); ports[0].finish("cut short"); await ended(c, b);
  const reply = await wait(c, [b]); assert.equal(reply.reason, "task_issue");
  assert.equal(reply.agents[0].status, "completed"); assert.equal(reply.agents[0].limit_reached, true);
  assert.equal(taskReply(c.view(b.run_id), namesOf(c)).limit_reached, true);
});

test("sixteen real question rows retain all controls and bounded bodies without a compact row-dropping fallback", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 16, resident_limit: 16 } });
  const runs = [];
  for (let index = 0; index < 16; index++) runs.push(await c.submit(`q${index}`, named(`a${index}`)));
  await until(() => ports.length === 16 && ports.every((port) => port.streaming));
  ports.forEach((port) => { port.callbacks.question("\u0000".repeat(8192)); port.finish("result"); });
  await Promise.all(runs.map((run) => ended(c, run)));
  const reply = await wait(c, runs); compact(reply);
  assert.equal(reply.reason, "question"); assert.equal(reply.agents.length, 16);
  assert(reply.agents.every((row) => row.has_question && /^q_[0-9a-f]{32}$/.test(row.question_id)));
  assert(reply.agents.slice(1).some((row) => row.question_truncated));
  assert(communicationEnvelopeBytes(reply) <= 65536);
  assert.equal(reply.agents_omitted, undefined); assert.equal(reply.pending_omitted, undefined);
});

for (const remaining of [1, 9]) test(`real result cursor advances only through whole shown glyphs with ${remaining} body units left`, async (t) => {
  const { controller: c, ports } = await fixture(t), runs = [], answer = "🚀".repeat(10);
  for (let index = 0; index < 3; index++) {
    const run = await c.submit(`r${index}`, named(`a${index}`)); runs.push(run);
    await until(() => ports[index]?.streaming);
    if (index < 2) ports[index].callbacks.question("Q".repeat(index === 0 ? 8192 : 8192 - remaining));
    ports[index].finish(answer); await ended(c, run);
  }
  const reply = await wait(c, runs);
  for (const [index, entry] of reply.agents.entries()) {
    assert((entry.result ?? "").isWellFormed());
    assert(entry.next_cursor, "including an omitted page, the continuation cannot skip unshown text");
    assert.equal((entry.result ?? "") + c.getResult(runs[index].run_id, { cursor: entry.next_cursor }).text, answer);
  }
  if (remaining === 1) assert(reply.agents.every((row) => row.result_omitted));
});

test("diagnostic and abstract error prefixes never split a surrogate pair", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("unicode", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].finish("done"); await ended(c, run);
  for (const offset of [-2, -1, 0]) {
    const diagnostic = "x".repeat(512 + offset) + "🚀tail", model = "m".repeat(128 + offset) + "🚀tail";
    const expected = "x".repeat(512 + offset) + (offset === -2 ? "🚀" : "");
    const error = errorReply({ code: "FIXTURE", details: { reason: diagnostic, error: diagnostic, resolution: diagnostic,
      requested: model, allowed: [model] } }).error;
    for (const key of ["reason", "message", "resolution"]) { assert.equal(error[key], expected); assert(error[key].isWellFormed()); }
    assert.equal(error.requested, "m".repeat(128 + offset) + (offset === -2 ? "🚀" : ""));
    const view = c.view(run.run_id), reply = taskReply({ ...view, owner_error: diagnostic, outcome: { ...view.outcome, error: diagnostic } }, namesOf(c));
    assert.equal(reply.error, expected); assert.equal(reply.owner_error, expected);
  }
});

test("bounded error choices retain remainder counts and hide concrete routing internals", () => {
  const many = Array.from({ length: 40 }, (_, i) => `provider/model-${i}`);
  const cut = errorReply({ code: "INVALID_MODEL", details: { key: "model", allowed: many, requested: "model-7" } }).error;
  assert.equal(cut.allowed.length, 32); assert.equal(cut.allowed_omitted, 8); assert.equal(cut.requested, "model-7");
  const whole = errorReply({ code: "INVALID_MODEL", details: { allowed: many.slice(0, 32) } }).error;
  assert.equal(whole.allowed_omitted, undefined);
  const levels = errorReply({ code: "THINKING_INCOMPATIBLE", details: { parent_thinking: "minimal", thinking: "medium",
    model: "secret-model", preset: "team", difficulty: 2, strength: "d2" } }).error;
  assert.equal(levels.model, undefined); assert.equal(levels.preset, undefined); assert.equal(levels.strength, undefined);
  assert.equal(levels.parent_thinking, "minimal"); assert.equal(levels.thinking, undefined); assert.equal(levels.reasoning_difficulty, 2);
  assert.equal(Object.hasOwn(levels, "difficulty"), false);
  const invalid = errorReply({ code: "INVALID_DIFFICULTY", details: { key: "difficulty" } }).error;
  assert.equal(invalid.parameter, "reasoning_difficulty"); assert.equal(invalid.code, "INVALID_DIFFICULTY");
  for (const allowed of ["not an array", [], undefined]) assert.equal(errorReply({ code: "X", details: { allowed } }).error.allowed, undefined);
});

test("independent task/roster replies show optional whole dispatch notes and live or final time warning without a turn-limit flag", () => {
  const base = { name: "otter", task: 1, status: "running", description: "task", resumable: true,
    owner_blocked: false, has_question: false, effective_settings: { profile: "reader", difficulty: 3 } };
  const notes = Object.freeze(["tree_shared", "x".repeat(118) + "🚀"]);
  const live = { ...base, time_wrapped: true, dispatch_notes: notes }, reply = taskReply(live, () => "otter");
  assert.deepEqual(reply, { agent: "otter", task: 1, status: "running", time_wrapped: true, dispatch_notes: notes });
  assert.notEqual(reply.dispatch_notes, notes, "independent projections cannot alias retained view arrays");
  reply.dispatch_notes[0] = "changed output"; assert.equal(notes[0], "tree_shared");
  const terminalView = { ...base, status: "completed", dispatch_notes: notes,
    outcome: { status: "completed", limit_reached: false, time_wrapped: true } };
  const final = taskReply(terminalView, () => "otter");
  assert.equal(final.time_wrapped, true); assert.equal(final.limit_reached, undefined);
  assert.equal(final.dispatch_notes[1].length, 120); assert.equal(final.next_cursor, undefined);
  const summary = { runs: 1, earlier_descriptions: [], touched: [], touched_omitted: 0, observed_cost: 0, cost_partial: false };
  const roster = agentRow(terminalView, summary, () => "otter");
  assert.equal(roster.time_wrapped, true); assert.deepEqual(roster.dispatch_notes, notes); compact(roster);
  assert.equal(roster.reasoning_difficulty, 3); assert.equal(Object.hasOwn(roster, "difficulty"), false);
  assert.equal(taskReply(base, () => "otter").dispatch_notes, undefined);
  assert.equal(taskReply({ ...base, dispatch_notes: [] }, () => "otter").dispatch_notes, undefined);
});

test("dispatch error replies name concrete raw or normalized paths with a bounded 512-unit whole-declaration projection", () => {
  const raw = "a".repeat(510) + "/x";
  for (const code of ["PREFLIGHT_DENIED", "DISPATCH_INPUT_MISSING", "INVALID_DISPATCH"]) {
    const result = errorReply({ code, details: { key: "inputs", requested: raw, path: "/tmp/" + raw } }).error;
    assert.equal(result.parameter, "inputs"); assert.equal(result.path, raw, "every legal 512-unit raw declaration remains visible, even with a longer normalized alias");
    assert.equal(result.requested, raw.slice(0, 128), "the existing abstract-choice field retains its published bound");
  }
  for (const code of ["RESOURCE_OWNED", "BUILD_TREE_BUSY"]) {
    const path = "/" + "normalized".repeat(100), result = errorReply({ code, details: { path } }).error;
    assert.equal(result.path, path.slice(0, 512)); assert.equal(result.requested, undefined);
  }
  const compatibility = errorReply({ code: "INVALID_DISPATCH", details: { parameter: "ownership", requested: "src/file.ts" } }).error;
  assert.equal(compatibility.parameter, "ownership"); assert.equal(compatibility.path, "src/file.ts");
  assert.equal(errorReply({ code: "INVALID_DISPATCH", details: { key: "tree", parameter: "ownership" } }).error.parameter, "tree");
  const paired = "x".repeat(510) + "🚀", clipped = "x".repeat(511) + "🚀";
  assert.equal(errorReply({ code: "DISPATCH_TREE_TYPE", details: { requested: paired } }).error.path, paired);
  assert.equal(errorReply({ code: "BUILD_TREE_BUSY", details: { path: clipped } }).error.path, "x".repeat(511));
  assert.equal(errorReply({ code: "INVALID_MODEL", details: { requested: raw } }).error.path, undefined, "routing choices do not become filesystem declarations");
});

test("Esc abort is not task interruption, and neither consumes finished presentation", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  c.cancel(run.run_id); assert.equal(taskReply(c.view(run.run_id), namesOf(c)).status, "interrupting");
  const aborted = await observe(c, { kind: "wait", agent_ids: [run.agent_id] }, AbortSignal.abort());
  assert.equal(aborted.reason, "aborted"); assert.equal(aborted.finished, undefined);
  ports[0].finish("partial", "aborted"); await ended(c, run);
  const reply = await wait(c, [run]); assert.equal(reply.reason, "task_issue"); assert.equal(reply.agents[0].status, "interrupted");
});

test("historical stopped questions remain readable without actionable token; send never answers", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("orca")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("factor?"); c.cancel(a.run_id); ports[0].finish("partial", "aborted"); await ended(c, a);
  const page = await read(c, a); assert.equal(page.agents[0].question, "factor?");
  assert.equal(page.agents[0].question_id, undefined); assert.equal(page.agents[0].has_question, undefined);
  assert.equal(agentRow(c.view(a.run_id), c.agentSummary(a.agent_id), namesOf(c)).has_question, undefined);
  assert.equal((await c.send("s", a.agent_id, "answer")).delivery, "not_delivered");
  const b = await c.submit("b", named("otter")); await until(() => ports[1]?.streaming);
  ports[1].callbacks.question("why?"); ports[1].finish("asked"); await ended(c, b);
  assert.equal((await c.send("s2", b.agent_id, "because")).delivery, "not_delivered");
  const question = (await read(c, b)).agents[0]; assert.equal(question.has_question, true); assert(question.question_id);
  const next = await c.answer("answer", b.agent_id, question.question_id, "because"); assert.equal(next.task, 2);
});
