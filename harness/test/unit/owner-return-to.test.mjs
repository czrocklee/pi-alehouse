import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { boundedOutput } from "../../dist/core/result-text.js";
import { questionId } from "../../dist/core/question-id.js";
import { decodeResultCursor } from "../../dist/core/result-cursor.js";
import { HarnessError } from "../../dist/core/ports.js";
import { FakePort, deferred, ended, errorCode, fixture, settings, task, tick, until } from "../support/controller-fixture.mjs";

// Real Owner/FIFO/lease with synthetic ports only; no SDK/provider or release evidence.
const scoutSettings = { ...settings, profile: "researcher" };
const observe = async (c, request, options = {}) => JSON.parse((await c.observe(request,
  { validate() {}, ...options })).content[0].text);
const action = (c, source, wait_ms = 0, options) => observe(c,
  { kind: "action", run_id: source.run_id, action: { type: "agent_spawn" }, wait_ms }, options);
const read = (c, run, extra = {}) => observe(c, { kind: "read", agent_id: run.agent_id, ...extra });
const wait = (c, agent_ids, extra = {}) => observe(c, { kind: "wait", agent_ids, wait_ms: 0, ...extra });
async function portFor(f, run) {
  await until(() => f.ports.some(port => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id));
  return f.ports.find(port => port.calls.at(-1)?.identity.run_id === run.run_id);
}
async function asking(f, rest = {}) {
  const run = await f.controller.submit("worker-question", task("original worker task", { name: "cedar", max_turns: 7, ...rest }));
  const port = await portFor(f, run);
  port.callbacks.question("Which evidence should I use?"); port.finish("waiting for parent");
  await ended(f.controller, run);
  return { run, port, token: f.controller.view(run.run_id).question_id };
}
function sourceTask(q, rest = {}) {
  return task("collect cited evidence", { name: "pine", settings: scoutSettings,
    return_to: { agent_id: q.run.agent_id, question_id: q.token, answer: "Use the scout evidence to finish the original task." }, ...rest });
}
const admit = (f, q, rest = {}, id = "compound") => f.controller.submit(id, sourceTask(q, rest));
function graph(f) {
  const c = f.controller;
  return { sequence: c.sequence, queue: [...c.queue], requests: [...c.requests],
    records: [...c.runs.values()].map(run => structuredClone(run.record)),
    claims: [...c.claims].map(claim => ({ run_id: claim.run_id, agent_id: claim.agent_id, prepared: structuredClone(claim.prepared) })),
    agents: [...c.agents.values()].map(agent => ({ id: agent.id, current: agent.current,
      question: structuredClone(agent.question), resident: agent.resident, inbox: [...agent.inbox] })),
    output: [c.retainedOutputChars, c.reservedOutputChars], events: f.events.length,
    calls: f.ports.map(port => port.calls.length) };
}
function prepared(declaration, { cwd }) {
  const path = value => ({ path: resolve(cwd, value), canonical: resolve(cwd, value) });
  return { declaration, inputs: (declaration.inputs ?? []).map(path), ownership: (declaration.ownership ?? []).map(path),
    ...(declaration.tree ? { tree: path(declaration.tree) } : {}) };
}

async function finishPair(f, source, text = "SCOUT_PRIVATE_RESULT") {
  const scout = await portFor(f, source); scout.finish(text); await ended(f.controller, source);
  const continuation = f.controller.view(source.return_to_run_id), worker = await portFor(f, continuation);
  worker.finish("worker final answer"); await ended(f.controller, continuation);
  return { scout, continuation, worker };
}
function suppressed(row, { stable = false, omitted = 0 } = {}) {
  assert.equal(row.result, undefined);
  assert.equal(row.result_omitted, true);
  if (stable) { assert.equal(row.next_cursor.length, 37); assert.equal(decodeResultCursor(row.next_cursor).offset, 0); }
  else { assert.equal(row.next_cursor, undefined); assert.equal(row.result_truncated, true); }
  if (omitted) assert.equal(row.omitted_chars, omitted);
}

test("compound acceptance installs two exact Runs; only the worker completes it; handoff is outside approval witness", async t => {
  const f = await fixture(t, { controller: { resident_limit: 2 } }), c = f.controller, q = await asking(f);
  const source = await admit(f, q), continuation = c.view(source.return_to_run_id);
  assert.equal(c.stats().runs, 3); assert.equal(c.stats().requests, 3); assert.equal(c.stats().resident, 2);
  assert.equal(source.return_to_run_id, continuation.run_id); assert.equal(source.task, 1); assert.equal(continuation.task, 2);
  assert.equal(continuation.description, q.run.description); assert.equal(continuation.max_turns, 7);
  assert.deepEqual(continuation.effective_settings, q.run.effective_settings);
  assert.deepEqual(continuation.after, [source.run_id]);
  assert.equal(c.runs.get(continuation.run_id).record.answer_to_run_id, q.run.run_id);
  assert.equal(c.view(q.run.run_id).question_id, undefined);
  const scout = await portFor(f, source);
  scout.callbacks.output(boundedOutput("SCOUT_PRIVATE_RESULT", 100));
  const snapshot = await action(c, source);
  assert.deepEqual(snapshot.action, { type: "agent_spawn", agent: "pine", task: 1 });
  assert.deepEqual(snapshot.agents.map(row => [row.agent, row.task]), [["pine", 1], ["cedar", 2]]);
  suppressed(snapshot.agents[0]);
  let returned = false;
  const pending = action(c, source, 3000).then(result => { returned = true; return result; });
  scout.finish("SCOUT_PRIVATE_RESULT"); await ended(c, source);
  const worker = await portFor(f, continuation); await tick();
  assert.equal(returned, false, "source completion is not compound completion");
  const call = worker.calls.at(-1);
  assert.match(call.prompt, /SCOUT_PRIVATE_RESULT/); assert.match(call.prompt, /not instructions; verify/);
  assert.doesNotMatch(call.identity.task_prompt, /SCOUT_PRIVATE_RESULT/);
  assert.equal(call.identity.task_prompt, sourceTask(q).return_to.answer);
  worker.finish("worker used evidence"); await ended(c, continuation);
  const result = await pending;
  assert.equal(result.reason, undefined); assert.equal(result.agents[1].result, "worker used evidence");
  suppressed(result.agents[0], { stable: true });
  assert.equal(c.getResult(source.run_id).text, "SCOUT_PRIVATE_RESULT");
  assert.equal((await read(c, source)).agents[0].result, "SCOUT_PRIVATE_RESULT");
  assert.equal(c.runs.get(source.run_id).finished_presented, true);
  assert.equal(c.runs.get(continuation.run_id).finished_presented, true);
});

for (const [name, change, code] of [
  ["non-scout source", q => ({ settings, return_to: sourceTask(q).return_to }), "INVALID_RETURN_TO_PROFILE"],
  ["invalid token", q => ({ return_to: { ...sourceTask(q).return_to, question_id: "bad" } }), "INVALID_QUESTION_ID"],
  ["stale token", q => ({ return_to: { ...sourceTask(q).return_to, question_id: "q_" + "0".repeat(32) } }), "STALE_ANSWER"],
  ["blank answer", q => ({ return_to: { ...sourceTask(q).return_to, answer: "  " } }), "INVALID_ANSWER"],
  ["oversized answer", q => ({ return_to: { ...sourceTask(q).return_to, answer: "x".repeat(16385) } }), "INVALID_ANSWER"],
  ["extra return field", q => ({ return_to: { ...sourceTask(q).return_to, after: [] } }), "INVALID_RETURN_TO"],
]) test(`planning rejects ${name} without allocating, reserving or notifying`, async t => {
  const f = await fixture(t), q = await asking(f), before = graph(f);
  await assert.rejects(admit(f, q, change(q)), errorCode(code));
  assert.deepEqual(graph(f), before); assert.equal(f.controller.view(q.run.run_id).question_id, q.token);
});

for (const [name, limits, code] of [
  ["both queue entries", { queue_limit: 1 }, "QUEUE_FULL"],
  ["both history entries", { history_run_limit: 2 }, "OWNER_HISTORY_LIMIT"],
  ["both output reservations", { output_chars: 64, history_output_chars: 128 }, "OWNER_HISTORY_LIMIT"],
  ["new resident only", { resident_limit: 1 }, "RESIDENT_LIMIT"],
]) test(`projected budget checks ${name} before any mutation`, async t => {
  const f = await fixture(t, { controller: limits }), q = await asking(f), before = graph(f);
  await assert.rejects(admit(f, q), errorCode(code)); assert.deepEqual(graph(f), before);
});

test("return_to refusals precede shared capacity; QUEUE_FULL names the two-entry need", async t => {
  const f = await fixture(t, { controller: { queue_limit: 1 } }), q = await asking(f), before = graph(f);
  for (const [change, code] of [
    [{ return_to: { ...sourceTask(q).return_to, question_id: "q_" + "0".repeat(32) } }, "STALE_ANSWER"],
    [{ settings }, "INVALID_RETURN_TO_PROFILE"],
    [{ return_to: { ...sourceTask(q).return_to, answer: " " } }, "INVALID_ANSWER"],
  ]) { await assert.rejects(admit(f, q, change), errorCode(code)); assert.deepEqual(graph(f), before); }
  await assert.rejects(admit(f, q), error => error.code === "QUEUE_FULL" && /two tasks/.test(error.details.resolution));
  assert.deepEqual(graph(f), before);
});

test("continuation turn limit matches agent_answer: the Agent's fixed limit, not the asking task's override", async t => {
  const f = await fixture(t), c = f.controller;
  const first = await c.submit("worker-first", task("first", { name: "cedar", max_turns: 7 }));
  (await portFor(f, first)).finish("done"); await ended(c, first);
  const asked = await c.submit("worker-override", { resume: first.agent_id, prompt: "override", max_turns: 50 }), port = await portFor(f, asked);
  port.callbacks.question("which evidence?"); port.finish("waiting"); await ended(c, asked);
  assert.equal(c.view(asked.run_id).max_turns, 50);
  const source = await admit(f, { run: asked, port, token: c.view(asked.run_id).question_id });
  assert.equal(c.view(source.return_to_run_id).max_turns, 7);
  await finishPair(f, source);
});

test("target must already be a settled healthy editor question, not a busy/future or scout question", async t => {
  const f = await fixture(t), c = f.controller;
  const run = await c.submit("worker-question", task("question still running", { name: "cedar" })), port = await portFor(f, run);
  port.callbacks.question("not settled yet");
  const q = { run, token: questionId(c.identity.owner_id, c.identity.generation, run.run_id) }, before = graph(f);
  await assert.rejects(admit(f, q), errorCode("STALE_ANSWER")); assert.deepEqual(graph(f), before);
  port.finish("waiting"); await ended(c, run);
  await c.kill(run.agent_id, 1000);
  const killed = graph(f); await assert.rejects(admit(f, q), errorCode("STALE_ANSWER")); assert.deepEqual(graph(f), killed);
  const scoutQuestion = await c.submit("scout-question", task("scout asks", { name: "birch", settings: scoutSettings }));
  const scout = await portFor(f, scoutQuestion); scout.callbacks.question("scout question"); scout.finish("waiting"); await ended(c, scoutQuestion);
  const beforeScout = graph(f);
  await assert.rejects(admit(f, { run: scoutQuestion, token: c.view(scoutQuestion.run_id).question_id }), error =>
    error.code === "INVALID_RETURN_TO_PROFILE" && error.details.key === "return_to" &&
    error.details.agent_id === scoutQuestion.agent_id && /agent_answer/.test(error.details.resolution));
  assert.deepEqual(graph(f), beforeScout);
  await assert.rejects(c.submit("run-return", { resume: scoutQuestion.agent_id, prompt: "no", return_to: sourceTask(q).return_to }), errorCode("UNSUPPORTED_PARAMETER"));
});

test("competing compound requests reserve one exact question only once", async t => {
  const f = await fixture(t), c = f.controller, q = await asking(f);
  const [first, second] = await Promise.allSettled([admit(f, q), admit(f, q, { name: "birch" }, "competing")]);
  assert.equal(first.status, "fulfilled"); assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "STALE_ANSWER"); assert.equal(c.stats().runs, 3); assert.equal(c.stats().agents, 2);
  assert.equal(c.findAgent("birch"), undefined); assert.equal(c.view(q.run.run_id).question_id, undefined);
  await finishPair(f, first.value);
});

test("already-uncompleted source predecessor rejects without allocating the pair", async t => {
  const f = await fixture(t), q = await asking(f), before = graph(f);
  await assert.rejects(admit(f, q, { after: [q.run.run_id] }), errorCode("DEPENDENCY_NOT_COMPLETED"));
  assert.deepEqual(graph(f), before);
});

test("Off transition during second-plan preflight rejects both admissions", async t => {
  let admission = { enabled: true, revision: 0 }, disable = false;
  const f = await fixture(t, { controller: { admission: () => admission, dispatch: { prepare(declaration, context) {
    if (disable && context.profile === "editor" && context.deferInputs) admission = { enabled: false, revision: 1 };
    return prepared(declaration, context);
  } } } }), q = await asking(f, { dispatch: { ownership: ["owned"] } });
  const before = graph(f); disable = true;
  await assert.rejects(admit(f, q), errorCode("WORKERS_DISABLED")); assert.deepEqual(graph(f), before);
});

test("second-plan preflight failure and swallowed reentrancy leave the original question/claim untouched", async t => {
  let fail = false, reenter, f;
  f = await fixture(t, { controller: { dispatch: { prepare(declaration, context) {
    if (fail && context.profile === "editor" && context.deferInputs) {
      if (reenter) { try { reenter(); } catch { /* guard must remember swallowed violation */ } }
      else throw new HarnessError("PREFLIGHT_DENIED");
    }
    return prepared(declaration, context);
  } } } });
  const q = await asking(f, { dispatch: { ownership: ["owned"] } }); fail = true;
  let before = graph(f); await assert.rejects(admit(f, q), errorCode("PREFLIGHT_DENIED")); assert.deepEqual(graph(f), before);
  reenter = () => f.controller.cancel(q.run.run_id);
  before = graph(f); await assert.rejects(admit(f, q), errorCode("OBSERVATION_REENTRANCY")); assert.deepEqual(graph(f), before);
});

test("claim/tree lineage is inherited, reservation retained, then restored with the same lease on scout failure", async t => {
  let acquired = 0, closed = 0;
  const lease = { assertHeld() {}, close() { closed++; } };
  const f = await fixture(t, { controller: { dispatch: { prepare: prepared,
    async start(_declaration, context) { if (context.acquireTree) { acquired++; return { lease }; } return {}; } } } });
  const c = f.controller, dispatch = { inputs: ["input"], ownership: ["owned"], tree: "build", checks: ["focused"] };
  const q = await asking(f, { dispatch }), claim = c.runs.get(q.run.run_id).claim;
  const source = await admit(f, q), continuation = c.view(source.return_to_run_id);
  assert.deepEqual(continuation.dispatch, dispatch); assert.equal(c.runs.get(continuation.run_id).claim, claim);
  assert.equal(claim.run_id, continuation.run_id); assert.equal(claim.lease, lease);
  const scout = await portFor(f, source); scout.finish("failed research", "error", "synthetic failure");
  await ended(c, source); await ended(c, continuation);
  assert.equal(c.view(continuation.run_id).outcome.reason, "dependency_not_completed");
  assert.equal(c.view(q.run.run_id).question_id, q.token); assert.equal(q.port.calls.length, 1);
  assert.equal(claim.run_id, q.run.run_id); assert.equal(claim.lease, lease); assert.equal(acquired, 1); assert.equal(closed, 0);
  await assert.rejects(c.submit("conflicting", task("other claim", { name: "oak", dispatch: { ownership: ["owned"] } })), errorCode("RESOURCE_OWNED"));
  const retry = await c.answer("fresh-answer", q.run.agent_id, q.token, "finish without research");
  const worker = await portFor(f, retry); worker.finish("finished"); await ended(c, retry);
  assert.equal(acquired, 1); assert.equal(closed, 1);
});

test("source claim conflict and inherited target resource drift reject the whole pair", async t => {
  let drift = false;
  const f = await fixture(t, { controller: { dispatch: { prepare(declaration, context) {
    const result = prepared(declaration, context);
    if (drift && context.profile === "editor" && context.deferInputs) result.ownership[0].canonical += "/changed";
    return result;
  } } } }), q = await asking(f, { dispatch: { ownership: ["owned"] } });
  let before = graph(f);
  await assert.rejects(admit(f, q, { dispatch: { ownership: ["owned"] } }), errorCode("RESOURCE_OWNED")); assert.deepEqual(graph(f), before);
  drift = true; before = graph(f);
  await assert.rejects(admit(f, q), errorCode("DISPATCH_RESOURCE_CHANGED")); assert.deepEqual(graph(f), before);
});

test("scout's own after is staged transitively and the worker follows only the new scout", async t => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), c = f.controller;
  const predecessor = await c.submit("predecessor", task("earlier research", { name: "oak" })), predecessorPort = await portFor(f, predecessor);
  const q = await asking(f), source = await admit(f, q, { after: [predecessor.run_id] }), continuation = c.view(source.return_to_run_id);
  assert.equal(source.status, "queued"); assert.deepEqual(source.after, [predecessor.run_id]); assert.deepEqual(continuation.after, [source.run_id]);
  predecessorPort.finish("earlier result"); await ended(c, predecessor);
  const scout = await portFor(f, source); assert.match(scout.calls[0].prompt, /earlier result/);
  await finishPair(f, source);
});

for (const failure of ["failed", "needs_input", "interrupted"]) test(`scout ${failure} fails dependent pre-input; the bound reply waits for that settlement and the token reopens`, async t => {
  const f = await fixture(t), c = f.controller, q = await asking(f), source = await admit(f, q), scout = await portFor(f, source);
  // Registered before the scout settles: the reply must never show a doomed worker as still queued.
  const pending = action(c, source, 3000);
  if (failure === "needs_input") scout.callbacks.question("Need a source decision?");
  if (failure === "interrupted") c.cancel(source.run_id);
  scout.finish("partial untrusted research", failure === "failed" ? "error" : failure === "interrupted" ? "aborted" : "success");
  const result = await pending, continuation = c.view(source.return_to_run_id);
  assert.equal(result.reason, "task_issue");
  assert.equal(result.agents[1].status, "failed"); assert.match(result.agents[1].error, /^DEPENDENCY_NOT_COMPLETED: pine \(/);
  assert.equal(c.view(continuation.run_id).outcome.reason, "dependency_not_completed"); assert.equal(q.port.calls.length, 1);
  assert.equal(c.view(q.run.run_id).question_id, q.token);
  suppressed(result.agents[0], { stable: true });
  if (failure === "needs_input") { assert.equal(result.agents[0].question, "Need a source decision?"); assert.match(result.agents[0].question_id, /^q_/); }
});

test("a turn-limited but completed scout hands off and does not end the compound wait early", async t => {
  const f = await fixture(t), c = f.controller, q = await asking(f), source = await admit(f, q, { max_turns: 1 }), scout = await portFor(f, source);
  let returned = false;
  const pending = action(c, source, 3000).then(result => { returned = true; return result; });
  scout.callbacks.turnEnd(true); scout.finish("limited research"); await ended(c, source);
  assert.equal(c.view(source.run_id).status, "completed"); assert.equal(c.view(source.run_id).outcome.limit_reached, true);
  const continuation = c.view(source.return_to_run_id), worker = await portFor(f, continuation); await tick();
  assert.equal(returned, false, "scout limit is not a compound task issue");
  assert.match(worker.calls.at(-1).prompt, /turn limit reached/);
  worker.finish("worker done"); await ended(c, continuation);
  const result = await pending;
  assert.equal(result.reason, undefined); assert.equal(result.agents[1].status, "completed");
  assert.equal(result.agents[0].limit_reached, true); suppressed(result.agents[0], { stable: true });
});

test("worker cancellation is independent; source suppression survives worker kill and all waits", async t => {
  const f = await fixture(t, { controller: { output_chars: 8, history_output_chars: 1024 } }), c = f.controller, q = await asking(f);
  const source = await admit(f, q), continuation = c.view(source.return_to_run_id), scout = await portFor(f, source);
  assert.equal(c.runs.get(source.run_id).record.result_visibility, "explicit_read");
  c.cancel(continuation.run_id); await ended(c, continuation);
  assert.equal(c.view(q.run.run_id).question_id, q.token); assert.equal(scout.stopped, 0); assert.equal(scout.streaming, true);
  await c.kill(q.run.agent_id, 1000);
  scout.finish("abcdefghNEVER_RETAINED"); await ended(c, source);
  for (const result of [await action(c, source), await wait(c, [source.agent_id]), await wait(c, [source.agent_id], { mode: "any" })])
    suppressed(result.agents.find(row => row.agent === "pine"), { stable: true, omitted: 14 });
  // A default waiter binds live work before it settles, not historical completed tasks.
  const body = await read(c, source); assert.equal(body.agents[0].result, "abcdefgh"); assert.equal(body.agents[0].omitted_chars, 14);
  assert.equal(c.getResult(source.run_id).text, "abcdefgh"); assert.equal(c.view(source.run_id).return_to_run_id, continuation.run_id);
});

test("default and explicit waits suppress live/final scout bodies but explicit read remains normal", async t => {
  const f = await fixture(t), c = f.controller, q = await asking(f), source = await admit(f, q), scout = await portFor(f, source);
  scout.callbacks.output(boundedOutput("private live preview", 100));
  for (const result of [await wait(c), await wait(c, [source.agent_id]), await action(c, source)]) suppressed(result.agents.find(row => row.agent === "pine"));
  assert.equal((await read(c, source)).agents[0].result, "private live preview");
  const bound = wait(c, undefined, { wait_ms: 3000 });
  scout.finish("private live preview"); await ended(c, source);
  const continuation = c.view(source.return_to_run_id), worker = await portFor(f, continuation);
  worker.finish("done"); await ended(c, continuation);
  suppressed((await bound).agents.find(row => row.agent === "pine"), { stable: true });
});

test("Off rejects before admission but never cancels an accepted pair", async t => {
  let admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => admission } }), c = f.controller, q = await asking(f);
  admission = { enabled: false, revision: 1 }; const before = graph(f);
  await assert.rejects(admit(f, q), errorCode("WORKERS_DISABLED")); assert.deepEqual(graph(f), before);
  admission = { enabled: true, revision: 2 }; const source = await admit(f, q);
  admission = { enabled: false, revision: 3 };
  await finishPair(f, source);
  const result = await action(c, source); assert.equal(result.workers_disabled, true); assert.equal(result.agents[1].status, "completed");
  assert.equal((await admit(f, q)).run_id, source.run_id, "replay remains before Off and stale eligibility");
});

test("replay/conflict bind the same original pair after both Agents are reused; secondary IDs cannot be impersonated", async t => {
  const f = await fixture(t), c = f.controller, q = await asking(f), input = sourceTask(q);
  let prepares = 0;
  const source = await c.submitPrepared("compound", input, request => { prepares++; return request; });
  const { continuation } = await finishPair(f, source);
  const laterSource = await c.submit("source-later", { resume: source.agent_id, prompt: "new scout task" });
  const scout = await portFor(f, laterSource); scout.callbacks.alert("later scout alert"); scout.finish("later scout body"); await ended(c, laterSource);
  const laterWorker = await c.submit("worker-later", { resume: q.run.agent_id, prompt: "new worker task" });
  const worker = await portFor(f, laterWorker); worker.callbacks.alert("later worker alert"); worker.finish("later worker body"); await ended(c, laterWorker);
  const replay = await c.submitPrepared("compound", input, () => { throw new Error("must not prepare replay"); });
  assert.equal(prepares, 1); assert.equal(replay.run_id, source.run_id); assert.equal(replay.return_to_run_id, continuation.run_id);
  const result = await action(c, replay);
  assert.deepEqual(result.agents.map(row => [row.agent, row.task]), [["pine", 1], ["cedar", 2]]);
  assert.equal(result.agents[1].result, "worker final answer"); assert.equal(result.alerts, undefined);
  const firstPage = await read(c, source, { cursor: result.agents[0].next_cursor, max_chars: 5 });
  assert.equal(firstPage.agents[0].task, 1); assert.equal(firstPage.agents[0].result, "SCOUT");
  // Explicit read spans Agent alerts, unlike the preceding compound action.
  assert.equal(c.alerts.length, 1); assert.equal(c.alerts[0].message, "later worker alert");
  assert.equal(c.view(laterSource.run_id).return_to_run_id, undefined);
  await assert.rejects(c.submit("compound", sourceTask(q, { return_to: { ...input.return_to, answer: "different" } })), errorCode("REQUEST_CONFLICT"));
  const secondary = c.runs.get(continuation.run_id).record;
  assert.notEqual(secondary.request_id, "compound"); assert.notEqual(secondary.request_digest, c.runs.get(source.run_id).record.request_digest);
  await assert.rejects(c.submit(secondary.request_id, task("impersonate", { name: "birch" })), errorCode("INVALID_REQUEST_ID"));
  await assert.rejects(c.send(secondary.request_id, source.agent_id, "impersonate"), errorCode("INVALID_REQUEST_ID"));
});

test("compound alert scope is the two exact Runs, not either Agent's prior or future history", async t => {
  const f = await fixture(t), c = f.controller;
  const first = await c.submit("worker-question", task("question with old alert", { name: "cedar" })), port = await portFor(f, first);
  port.callbacks.alert("old question alert"); port.callbacks.question("which evidence?"); port.finish("waiting"); await ended(c, first);
  const q = { run: first, port, token: c.view(first.run_id).question_id }, source = await admit(f, q), scout = await portFor(f, source);
  const pending = action(c, source, 3000); scout.callbacks.alert("source alert");
  const sourceWake = await pending; assert.equal(sourceWake.reason, "alert"); assert.deepEqual(sourceWake.alerts.map(row => row.message), ["source alert"]);
  assert.equal(c.alerts.length, 1); assert.equal(c.alerts[0].message, "old question alert");
  scout.finish("evidence"); await ended(c, source);
  const continuation = c.view(source.return_to_run_id), worker = await portFor(f, continuation);
  const workerPending = action(c, source, 3000); worker.callbacks.alert("worker continuation alert");
  const workerWake = await workerPending; assert.equal(workerWake.reason, "alert"); assert.deepEqual(workerWake.alerts.map(row => row.message), ["worker continuation alert"]);
  assert.equal(c.alerts.length, 1); worker.finish("done"); await ended(c, continuation);
});

for (const fault of ["submit", "resume", "both"]) test(`${fault} notification fault keeps both accepted records and sticky source link`, async t => {
  let armed = false, c, noticed = 0;
  const f = await fixture(t, { controller: { onContextChange(event) {
    if (!armed || !["submit", "resume"].includes(event.kind)) return;
    noticed++; assert.equal(c.stats().runs, 3); assert.equal(c.stats().requests, 3);
    const source = [...c.runs.values()].find(run => run.record.name === "pine");
    assert(source.record.return_to_run_id); assert(c.runs.has(source.record.return_to_run_id));
    if (fault === "both" || event.kind === fault) throw new Error("synthetic notice failure");
  } } });
  c = f.controller; const q = await asking(f); armed = true;
  const source = await admit(f, q), continuation = c.view(source.return_to_run_id);
  assert.equal(noticed, 2); assert.equal(c.stats().runs, 3); assert.equal(c.stats().requests, 3);
  const sourceFault = fault !== "resume", targetFault = fault !== "submit";
  if (!sourceFault) { const scout = await portFor(f, source); scout.finish("retained despite target fault"); }
  await ended(c, source); await ended(c, continuation);
  if (sourceFault) assert.equal(c.view(source.run_id).outcome.reason, "context_change_failed");
  assert.equal(c.view(continuation.run_id).outcome.reason, targetFault ? "context_change_failed" : "dependency_not_completed");
  assert.equal(c.view(source.run_id).return_to_run_id, continuation.run_id);
  const replay = await admit(f, q); assert.equal(replay.run_id, source.run_id); assert.equal(replay.return_to_run_id, continuation.run_id);
});

// A factory that holds scout sessions until released, recording each one.
function heldScoutSessions(f, gate, dispose) {
  const late = [];
  return { late, createSession: async ({ settings: value }) => {
    const port = new FakePort();
    if (value.profile !== "researcher") { f.ports.push(port); return port; }
    await gate.promise; late.push(port);
    if (dispose) port.dispose = async () => { port.disposed++; return dispose(); };
    return port;
  } };
}
const settleTicks = async () => { for (let i = 0; i < 20; i++) await tick(); };

test("a failed source notice is isolated before a peer notice can reenter cancel and start it", async t => {
  let armed = false, c, scoutFactory = 0;
  const gate = deferred(), holder = {};
  const f = await fixture(t, { controller: {
    createSession: (input) => { if (input.settings.profile === "researcher") scoutFactory++; return holder.factory.createSession(input); },
    onContextChange(event) {
      f.events.push(event);
      if (!armed) return;
      const source = [...c.runs.values()].find(run => run.record.name === "pine");
      if (event.kind === "submit" && event.run_id === source.record.run_id) throw new Error("synthetic source notice failure");
      // Cancelling the queued continuation settles it and pumps synchronously.
      if (event.kind === "resume") c.cancel(event.run_id);
    } } });
  holder.factory = heldScoutSessions(f, gate);
  c = f.controller; const q = await asking(f); armed = true;
  const source = await admit(f, q);
  assert.equal(c.queue.includes(source.run_id), false, "the failed source left the queue at once");
  assert.equal(scoutFactory, 0, "no session was requested for a Run whose notice failed");
  await ended(c, source); await ended(c, { run_id: source.return_to_run_id });
  assert.equal(c.view(source.run_id).outcome.reason, "context_change_failed");
  assert.equal(c.view(source.return_to_run_id).outcome.status, "cancelled");
  gate.resolve(); await settleTicks();
  assert.equal(scoutFactory, 0); assert.deepEqual(holder.factory.late, []);
  assert.equal(c.view(q.run.run_id).question_id, q.token, "the pre-input continuation reopened the question");
});

for (const fault of [false, true]) test(`no Run starts inside its own ${fault ? "failing " : ""}submit notice when a consumer reenters and pumps`, async t => {
  let armed = false, c, startedInNotice;
  const f = await fixture(t, { controller: { concurrency: 2, onContextChange(event) {
    f.events.push(event);
    if (!armed || event.kind !== "submit") return;
    armed = false;
    const blocked = [...c.runs.values()].find(run => run.record.name === "held");
    c.cancel(blocked.record.run_id); // Settles synchronously and pumps with a free slot.
    startedInNotice = c.runs.get(event.run_id).record.status !== "queued";
    if (fault) throw new Error("synthetic notice failure");
  } } });
  c = f.controller;
  const first = await c.submit("first", task("occupies one slot", { name: "oak" }));
  await until(() => f.ports.some(port => port.streaming));
  await c.submit("held", task("blocked by its dependency", { name: "held", after: [first.run_id] }));
  armed = true;
  const subject = await c.submit("subject", task("must wait for its notice", { name: "elm" }));
  assert.equal(startedInNotice, false);
  if (fault) {
    await ended(c, subject); await settleTicks();
    assert.equal(c.view(subject.run_id).outcome.reason, "context_change_failed");
    assert.equal(f.ports.filter(port => port.calls.some(call => call.identity.run_id === subject.run_id)).length, 0);
  } else {
    await until(() => f.ports.some(port => port.streaming && port.calls.at(-1)?.identity.run_id === subject.run_id));
    f.ports.find(port => port.calls.at(-1)?.identity.run_id === subject.run_id).finish("ok"); await ended(c, subject);
  }
  f.ports[0].finish("done"); await ended(c, first);
});

for (const clean of [true, false]) test(`a Run settled while its session factory is pending never runs; the ${clean ? "" : "unconfirmed "}orphan is disposed`, async t => {
  const gate = deferred(), holder = {};
  const f = await fixture(t, { cleanupUncertainExpected: !clean, controller: { createSession: input => holder.factory.createSession(input) } });
  holder.factory = heldScoutSessions(f, gate, clean ? undefined : () => ({ shutdownExited: false, errors: ["synthetic stuck shutdown"] }));
  const c = f.controller;
  const run = await c.submit("scout", task("held factory", { name: "pine", settings: scoutSettings }));
  await until(() => c.runs.get(run.run_id).active);
  // Defense in depth: settle it as failure handling would, factory still pending.
  c.finish(c.runs.get(run.run_id), { kind: "error", error: "synthetic pre-start failure", output: { text: "", total_chars: 0, truncated: false } });
  await ended(c, run);
  gate.resolve(); await until(() => holder.factory.late.length === 1);
  const [port] = holder.factory.late;
  await settleTicks();
  assert.equal(port.calls.length, 0, "a settled Run is never executed");
  assert.equal(port.disposed, 1, "the session no Agent owns is disposed");
  assert.equal(c.stats().cleanup_uncertain, !clean);
  if (!clean) assert(c.view(run.run_id).cleanup_errors.some(error => /synthetic stuck shutdown|shutdown_not_exited/.test(error)));
});

test("every lease probe is read-only: a reentrant adapter can neither release the worker nor commit a stale plan", async t => {
  for (let target = 1; ; target++) {
    let ran = false;
    await t.test(`reentry at probe ${target}`, async t => {
      const f = await fixture(t), c = f.controller, q = await asking(f), original = f.ports[0];
      const assertHeld = f.owner.assertHeld.bind(f.owner);
      let probes = 0, refusal;
      f.owner.assertHeld = () => {
        if (++probes === target) {
          ran = true;
          try { c.release(q.run.agent_id); } catch (error) { refusal = error.code; }
        }
        return assertHeld();
      };
      const outcome = await admit(f, q).then(view => ({ view }), error => ({ error }));
      if (!ran) { f.owner.assertHeld = assertHeld; if (outcome.view) await finishPair(f, outcome.view); return; }
      assert.equal(refusal, "OBSERVATION_REENTRANCY", "the reentrant effect is refused inside the probe");
      const worker = c.agents.get(q.run.agent_id);
      assert.equal(worker.unavailable, undefined, "the worker was not released");
      assert.equal(original.disposed, 0);
      if (outcome.error) {
        // A decision probe fails as a lost lease would: sticky, nothing installed.
        assert.equal(outcome.error.code, "OBSERVATION_REENTRANCY");
        assert.notEqual(c.stats().internal_error, undefined);
        assert.equal(c.findAgent("pine"), undefined);
        assert.equal(worker.current, undefined);
        assert.equal(worker.question?.run_id, q.run.run_id, "nothing was installed against the worker");
      } else {
        // Post-install probes (pump, execution, projection) only fault or report
        // not held; the continuation never runs on a session of its own.
        const continuation = outcome.view.return_to_run_id;
        assert(f.ports.every(port => port === original || !port.calls.some(call => call.identity.run_id === continuation)));
      }
      f.owner.assertHeld = assertHeld;
    });
    if (!ran) break;
    assert(target < 50, "probe inventory is bounded");
  }
});
