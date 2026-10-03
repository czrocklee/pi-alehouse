import assert from "node:assert/strict";
import test from "node:test";
import {
  actionableQuestionId, applyCommunicationCommit, canAnswerQuestion, communicationReadiness,
  defaultObservationTargets, enqueueAlert, finishedCandidates, isCommunicationSettled,
  recordFirstQuestion, scopedAlerts, taskOrdinal, validateCommunicationCommit,
} from "../../dist/core/communication-state.js";
import { HarnessError } from "../../dist/core/ports.js";
import { boundedOutput } from "../../dist/core/result-text.js";
import { ObservationScheduler } from "../../dist/core/observation-scheduler.js";
import { packCommunication } from "../../dist/core/communication-packer.js";

// Preparatory SDK-free state tests. Every alert/question/finished reference is
// an ORIGINAL structural Run object in this fixture's sole retained Runs array.
// No parallel question/finished registry, counters, or simulated Owner lifecycle.
// Transient snapshots below test provenance/commit; they are not a fake packer.
// Caller Run/generation/Owner identity, input/gate checks, and lifecycle changes
// are NOT implemented by these helpers or proven by synthetic fact transitions.
// Integrated cases use the real pure packer, not production Owner/tool wiring.
function originalRun(name, sequence, { agent_id = `agent-${name}`, run_id = `${agent_id}-run-${sequence}`,
  owner_id = "owner-1", generation = "generation-1", status = "running", phase = "executing",
  execution_exited = false, description = "same label", question, finished_presented = false,
  settled_seq, limit_reached = false } = {}) {
  return { record: { owner_id, generation, run_id, agent_id, enqueue_sequence: sequence,
    name, description, status, phase, execution_exited, outcome: { limit_reached } },
  question, finished_presented, settled_seq };
}
function settledRun(name, sequence, options = {}) {
  return originalRun(name, sequence, { status: "completed", phase: "settled", execution_exited: true,
    settled_seq: sequence, ...options });
}
function originalAgent(run, options = {}) {
  return { id: run.record.agent_id, resident: true, ...options };
}
function pendingQuestion() {
  const run = settledRun("otter", 1, { run_id: "run-1", status: "needs_input", question: "Original decision?" });
  const agent = originalAgent(run, { question: { run_id: run.record.run_id } });
  return { run, agent };
}
const hasCode = (code, details = {}) => (error) => {
  assert(error instanceof HarnessError);
  assert.equal(error.code, code);
  for (const [key, value] of Object.entries(details)) assert.equal(error.details[key], value);
  return true;
};
function unchanged(state, effect, code, details) {
  const before = structuredClone(state), refs = state.pending?.slice();
  assert.throws(effect, hasCode(code, details));
  assert.deepEqual(state, before, "failed operation must not alter any authoritative fact");
  refs?.forEach((ref, index) => assert.equal(state.pending[index], ref, "original pending event identity survives"));
}
const ownerScope = { kind: "owner" };
const agentScope = (run) => ({ kind: "agents", agent_ids: [run.record.agent_id] });
const runScope = (run) => ({ kind: "run", run });

// Public statuses are projections, not another task record.
function thinRow(run, runs) {
  const status = run.record.status === "cancelled" ? "interrupted" : run.record.status === "cancelling" ?
    "interrupting" : run.record.phase === "finalizing" ? "finishing" : run.record.status;
  return { agent: run.record.name, task: taskOrdinal(run, runs), status };
}
function capture(state, options = {}) {
  const { scope = ownerScope, targets = [], reason = "snapshot" } = options;
  // Explicit undefined is the pre-fault registration fact, not permission to
  // reread the now-reported marker after another observer has committed it.
  const reportedBlockAtStart = Object.hasOwn(options, "reportedBlockAtStart") ? options.reportedBlockAtStart : state.reportedBlock;
  const alerts = scopedAlerts(state.pending, scope), finished = finishedCandidates(state.runs);
  const data = { reason, tasks: targets.map((run) => ({ row: thinRow(run, state.runs), settled: isCommunicationSettled(run) })),
    alerts: alerts.map(({ run, message }) => ({ agent: run.record.name, task: taskOrdinal(run, state.runs),
      label: boundedOutput(run.record.description, 120).text, message })),
    finished: finished.map((run) => ({ row: thinRow(run, state.runs),
      ...(targets.includes(run) ? { task_index: targets.indexOf(run) } : {}) })), blocked: state.blocked };
  return { data, targets, alerts, finished, reportedBlockAtStart };
}
function body(snapshot, { alertRefs = [], finishedRows = [], taskRows = snapshot.data.tasks.map(({ row }) => row) } = {}) {
  const bound = snapshot.data.finished.flatMap(({ task_index }, index) => task_index === undefined ? [] : [index]);
  const listed = snapshot.data.finished.flatMap(({ task_index }, index) => task_index === undefined ? [index] : [])
    .slice(0, finishedRows.length);
  const finishedRefs = [...bound, ...listed].sort((a, b) => a - b);
  const envelope = { reason: snapshot.data.reason, agents: taskRows,
    ...(alertRefs.length ? { alerts: alertRefs.map((index) => ({ ...snapshot.data.alerts[index] })) } : {}),
    alerts_pending: snapshot.alerts.length - alertRefs.length,
    ...(finishedRows.length ? { finished: finishedRows } : {}), finished_pending: snapshot.finished.length - finishedRefs.length };
  const references = { alerts: alertRefs, finished: finishedRefs,
    ...(envelope.reason === "owner_blocked" ? { blocked: snapshot.data.blocked } : {}) };
  return { envelope, references };
}
function validate(state, snapshot, publication, scope = ownerScope) {
  return validateCommunicationCommit({ runs: state.runs, pending: state.pending, scope, snapshot, ...publication, currentBlocked: state.blocked });
}
function commit(state, snapshot, publication, scope = ownerScope) {
  const plan = validate(state, snapshot, publication, scope);
  // Straight-line commit: no callback or await between full validation and effects.
  applyCommunicationCommit(state.pending, plan);
  if (plan.blocked !== undefined) state.reportedBlock = plan.blocked;
  return plan;
}

test("one FIFO: identical repeated alert bodies are distinct original-Run events in enqueue order", () => {
  const older = settledRun("otter", 3), current = originalRun("otter", 20), other = originalRun("orca", 4);
  const state = { pending: [], runs: [current, other, older] };
  const a = enqueueAlert(state.pending, older, "same message"), outside = enqueueAlert(state.pending, other, "outside"),
    b = enqueueAlert(state.pending, current, "same message"), repeat = enqueueAlert(state.pending, current, "same message");
  assert.notEqual(a, b); assert.notEqual(b, repeat);
  assert.equal(a.run, older); assert.equal(b.run, current); assert.equal(repeat.run, current);
  assert(Object.isFrozen(a)); assert(Object.isFrozen(repeat));
  assert.deepEqual(state.pending, [a, outside, b, repeat]);
  assert.deepEqual(scopedAlerts(state.pending, agentScope(current)), [a, b, repeat]);
  assert.deepEqual(Object.keys(a).sort(), ["message", "run"], "no copied mutable Agent/task fields or dedupe ID");
});

test("Agent quota is 16 across older Runs; rejected 17th neither shifts nor changes a Run", () => {
  const older = settledRun("otter", 1), current = originalRun("otter", 9), other = originalRun("orca", 2);
  const state = { pending: [], runs: [older, current, other] };
  for (let index = 0; index < 16; index++) enqueueAlert(state.pending, index < 10 ? older : current, `accepted-${index}`);
  unchanged(state, () => enqueueAlert(state.pending, current, "seventeenth"), "ALERT_QUEUE_FULL", { scope: "agent", limit: 16 });
  assert.equal(enqueueAlert(state.pending, other, "another Agent").run, other);
  assert.equal(state.pending.length, 17);
});

test("Owner quota is 64, checked before an already-full Agent; no reserved space for a fifth Agent", () => {
  const runs = ["otter", "orca", "marten", "lynx", "badger"].map((name, index) => originalRun(name, index + 1));
  const state = { pending: [], runs };
  for (const run of runs.slice(0, 4)) for (let index = 0; index < 16; index++) enqueueAlert(state.pending, run, `${run.record.name}-${index}`);
  for (const run of [runs[0], runs[4]]) {
    let failure;
    unchanged(state, () => { try { enqueueAlert(state.pending, run, "overflow"); } catch (error) { failure = error; throw error; } },
      "ALERT_QUEUE_FULL", { scope: "owner", limit: 64 });
    assert.match(failure.details.resolution, /Do not retry in a loop/);
    assert.match(failure.details.resolution, /final result/);
    assert.match(failure.details.resolution, /ask_parent and end this task/);
  }
});

test("kill/reuse facts cannot clear cross-Run quota; only successful publication frees capacity", () => {
  const older = settledRun("otter", 1), reused = originalRun("otter", 5), agent = originalAgent(older);
  const state = { pending: [], runs: [older, reused], agents: [agent] };
  for (let index = 0; index < 16; index++) enqueueAlert(state.pending, older, `history-${index}`);
  agent.resident = false; agent.unavailable = "killed";
  assert.equal(scopedAlerts(state.pending, ownerScope).length, 16, "killed Agent alerts remain visible");
  unchanged(state, () => enqueueAlert(state.pending, reused, "new assignment"), "ALERT_QUEUE_FULL", { scope: "agent", limit: 16 });
  agent.resident = true; delete agent.unavailable; agent.current = reused.record.run_id;
  unchanged(state, () => enqueueAlert(state.pending, reused, "reuse"), "ALERT_QUEUE_FULL", { scope: "agent", limit: 16 });
  const snapshot = capture(state, { scope: runScope(older) }), publication = body(snapshot, { alertRefs: [0] });
  commit(state, snapshot, publication, runScope(older));
  assert.equal(state.pending.length, 15); assert.equal(older.finished_presented, false, "an alert is not a finished body");
  const accepted = enqueueAlert(state.pending, reused, "after actual commit");
  assert.equal(state.pending.length, 16); assert.equal(state.pending.at(-1), accepted);
});

for (const [description, message, code] of [
  ["undefined", undefined, "INVALID_ALERT"], ["object", { message: "text" }, "INVALID_ALERT"],
  ["empty", "", "INVALID_ALERT"], ["whitespace", " \t\n", "INVALID_ALERT"],
  ["8193 units", "a".repeat(8193), "ALERT_TOO_LARGE"], ["4097 emoji", "😀".repeat(4097), "ALERT_TOO_LARGE"],
]) test(`failed alert admission (${description}) has zero queue/Run modifications`, () => {
  const run = originalRun("otter", 1), state = { pending: [], runs: [run] };
  enqueueAlert(state.pending, run, "already accepted");
  unchanged(state, () => enqueueAlert(state.pending, run, message), code);
});

for (const message of ["\u0000".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192), "😀".repeat(4096)])
  test(`whole legal 8192-unit alert is admitted (${message.charCodeAt(0).toString(16)})`, () => {
    const run = originalRun("otter", 1), pending = [], accepted = enqueueAlert(pending, run, message);
    assert.equal(accepted.message, message); assert.equal(accepted.message.length, 8192);
    assert.equal(accepted.run, run); assert.deepEqual(pending, [accepted]);
  });

test("first-write question wins on original Run before Agent pending pointer exists, without comparing repeats", () => {
  const run = originalRun("otter", 1), agent = originalAgent(run, { current: run.record.run_id });
  assert.equal(agent.question, undefined);
  assert.equal(recordFirstQuestion(run, "first?"), "recorded");
  for (const repeat of ["first?", "different?", "z".repeat(8192), "😀".repeat(4096)]) {
    assert.equal(recordFirstQuestion(run, repeat), "already_recorded");
    assert.equal(run.question, "first?"); assert.equal(agent.question, undefined);
  }
});

for (const alreadyRecorded of [false, true]) test(`every ask validates text before first-write handling (recorded=${alreadyRecorded})`, () => {
  const run = originalRun("otter", 1), state = { pending: [], runs: [run] };
  if (alreadyRecorded) recordFirstQuestion(run, "original?");
  for (const invalid of [undefined, null, 42, {}, [], "", " \n\t", "a".repeat(8193), "😀".repeat(4097)])
    unchanged(state, () => recordFirstQuestion(run, invalid), "INVALID_QUESTION");
  if (!alreadyRecorded) {
    const maximum = "q".repeat(8192);
    assert.equal(recordFirstQuestion(run, maximum), "recorded"); assert.equal(run.question, maximum);
  } else assert.equal(run.question, "original?");
});

test("actionable token uses original Run owner/generation and does not depend on body or finished bit", () => {
  const { run, agent } = pendingQuestion();
  assert(canAnswerQuestion(agent, run, true));
  assert.equal(actionableQuestionId(agent, run, true), "q_0dd7797d66c42bf3ef2b77a85ee5899c");
  run.finished_presented = true; run.question = "Body is not identity";
  assert.equal(actionableQuestionId(agent, run, true), "q_0dd7797d66c42bf3ef2b77a85ee5899c");
  const nextGeneration = { ...run, record: { ...run.record, generation: "generation-2" } };
  assert.notEqual(actionableQuestionId(agent, nextGeneration, true), actionableQuestionId(agent, run, true));
  const nextOwner = { ...run, record: { ...run.record, owner_id: "owner-2" } };
  assert.notEqual(actionableQuestionId(agent, nextOwner, true), actionableQuestionId(agent, run, true));
});

for (const [description, change] of [
  ["no pending pointer", ({ agent }) => { delete agent.question; }],
  ["pointer to another Run", ({ agent }) => { agent.question.run_id = "another-run"; }],
  ["reservation", ({ agent }) => { agent.question.reserved_by = "continuation"; }],
  ["current continuation", ({ agent }) => { agent.current = "continuation"; }],
  ["wrong Agent", ({ agent }) => { agent.id = "agent-orca"; }],
  ["nonresident/killed", ({ agent }) => { agent.resident = false; }],
  ["killed diagnostic", ({ agent }) => { agent.unavailable = "killed"; }],
  ["Agent quarantine", ({ agent }) => { agent.unavailable = "quarantined"; }],
  ["original Run quarantine", ({ run }) => { run.quarantine = "guard-crossing"; }],
  ["exiting", ({ agent }) => { agent.exiting = true; }],
  ["finalizing", ({ run }) => { run.record.phase = "finalizing"; }],
  ["execution has not exited", ({ run }) => { run.record.execution_exited = false; }],
  ["running", ({ run }) => { run.record.status = "running"; }],
  ["failed with historical question", ({ run }) => { run.record.status = "failed"; }],
  ["cancelled with historical question", ({ run }) => { run.record.status = "cancelled"; }],
  ["completed with historical question", ({ run }) => { run.record.status = "completed"; }],
  ["no Run question", ({ run }) => { delete run.question; }],
]) test(`canAnswer/token requires all current core facts: ${description}`, () => {
  const fixture = pendingQuestion(); change(fixture);
  assert.equal(canAnswerQuestion(fixture.agent, fixture.run, true), false);
  assert.equal(actionableQuestionId(fixture.agent, fixture.run, true), undefined);
});

test("Owner loss/closing/fault health blocks token; Off admission is separate and does not erase identity", () => {
  const { run, agent } = pendingQuestion(), before = structuredClone({ run, agent });
  assert.equal(canAnswerQuestion(agent, run, false), false);
  assert.equal(actionableQuestionId(agent, run, false), undefined);
  assert.deepEqual(defaultObservationTargets([agent], [run], false, true), []);
  assert.equal(actionableQuestionId(agent, run, true), "q_0dd7797d66c42bf3ef2b77a85ee5899c", "explicit Off read remains actionable identity");
  assert.deepEqual({ run, agent }, before);
});

test("default On/Off binds current first, only On adds healthy settled questions, never two targets per Agent", () => {
  const { run: question, agent: asking } = pendingQuestion();
  question.finished_presented = true;
  const current = originalRun("otter", 7), running = originalRun("orca", 4), idle = settledRun("marten", 2);
  const agents = [asking, originalAgent(running, { current: running.record.run_id }), originalAgent(idle)];
  const runs = [current, idle, question, running];
  assert.deepEqual(defaultObservationTargets(agents, runs, true, true), [question, running]);
  assert.deepEqual(defaultObservationTargets(agents, runs, false, true), [running]);
  asking.current = current.record.run_id;
  assert.deepEqual(defaultObservationTargets(agents, runs, true, true), [current, running]);
  assert.deepEqual(defaultObservationTargets(agents, runs, false, true), [current, running]);
  current.record.status = "completed"; current.record.phase = "finalizing"; current.record.execution_exited = true;
  assert.deepEqual(defaultObservationTargets(agents, runs, true, true), [running], "terminal current still suppresses historical question");
});

test("pre-input answer cancellation facts restore the original question regardless of finished, not during finalizing", () => {
  const { run: original, agent } = pendingQuestion(), token = actionableQuestionId(agent, original, true);
  original.finished_presented = true;
  const continuation = originalRun("otter", 8), runs = [continuation, original];
  agent.question.reserved_by = continuation.record.run_id; agent.current = continuation.record.run_id;
  assert.deepEqual(defaultObservationTargets([agent], runs, true, true), [continuation]);
  assert.equal(actionableQuestionId(agent, original, true), undefined);
  // Synthetic facts at pre-input cancellation; this does not exercise Owner.answer.
  continuation.record.status = "cancelled"; continuation.record.phase = "finalizing"; continuation.record.execution_exited = true;
  delete agent.question.reserved_by;
  assert.deepEqual(defaultObservationTargets([agent], runs, true, true), []);
  assert.equal(actionableQuestionId(agent, original, true), undefined, "reservation release alone does not restore token");
  continuation.record.phase = "settled"; continuation.settled_seq = 2; delete agent.current;
  assert.deepEqual(defaultObservationTargets([agent], runs, true, true), [original]);
  assert.deepEqual(defaultObservationTargets([agent], runs, false, true), []);
  assert.equal(actionableQuestionId(agent, original, true), token); assert.equal(original.finished_presented, true);
  // After inputEntered the original pending pointer is consumed, not reopened.
  delete agent.question;
  assert.deepEqual(defaultObservationTargets([agent], runs, true, true), []);
  assert.equal(actionableQuestionId(agent, original, true), undefined);
});

test("default selection is a once-bound array: Off/On changes and newly enqueued Runs do not drift it", () => {
  const { run: question, agent: asking } = pendingQuestion(), current = originalRun("orca", 2);
  const agents = [asking, originalAgent(current, { current: current.record.run_id })], runs = [question, current];
  const offBound = defaultObservationTargets(agents, runs, false, true), onBound = defaultObservationTargets(agents, runs, true, true);
  const newRun = originalRun("marten", 3); runs.push(newRun); agents.push(originalAgent(newRun, { current: newRun.record.run_id }));
  assert.deepEqual(offBound, [current]); assert.deepEqual(onBound, [question, current]);
  assert.deepEqual(defaultObservationTargets(agents, runs, true, true), [question, current, newRun]);
  assert.deepEqual(defaultObservationTargets(agents, runs, false, true), [current, newRun]);
  current.record.status = "needs_input"; current.record.phase = "settled"; current.record.execution_exited = true;
  current.question = "Question after Off binding?"; current.settled_seq = 2;
  delete agents[1].current; agents[1].question = { run_id: current.record.run_id };
  assert.equal(communicationReadiness({ targets: offBound, agents, mode: "all", ownerHealthy: true,
    pending: [], scope: ownerScope }), "question", "Off affects initial selection, not the selected Run's later readiness");
});

test("default selection fails closed on missing or another Agent's current Run, with no state changes", () => {
  const run = originalRun("otter", 1), other = originalRun("orca", 2), agent = originalAgent(run, { current: "missing" });
  const state = { runs: [run, other], agents: [agent] };
  unchanged(state, () => defaultObservationTargets(state.agents, state.runs, true, true), "INVALID_COMMUNICATION_RUN");
  agent.current = other.record.run_id;
  unchanged(state, () => defaultObservationTargets(state.agents, state.runs, true, true), "INVALID_COMMUNICATION_RUN");
});

test("task ordinal derives per-Agent rank from global enqueue_sequence across retained historical Runs", () => {
  const old = settledRun("otter", 10), other = originalRun("orca", 5), current = originalRun("otter", 90),
    middle = settledRun("otter", 40, { status: "failed" }), otherNext = settledRun("orca", 70),
    sameNameDifferentAgent = originalRun("otter", 20, { agent_id: "different-otter" });
  const runs = [current, otherNext, sameNameDifferentAgent, middle, old, other];
  assert.equal(taskOrdinal(old, runs), 1); assert.equal(taskOrdinal(middle, runs), 2); assert.equal(taskOrdinal(current, runs), 3);
  assert.equal(taskOrdinal(other, runs), 1); assert.equal(taskOrdinal(otherNext, runs), 2);
  assert.equal(taskOrdinal(sameNameDifferentAgent, runs), 1, "identity is Agent ID, not reused display name");
  assert.throws(() => taskOrdinal(structuredClone(old), runs), hasCode("INVALID_COMMUNICATION_RUN"));
  assert.deepEqual(runs, [current, otherNext, sameNameDifferentAgent, middle, old, other], "projection never sorts storage");
});

test("finished candidates require true settlement and sort by Owner settled_seq, not enqueue/name/status", () => {
  const late = settledRun("otter", 1, { settled_seq: 5 }), early = settledRun("orca", 50, { settled_seq: 1, status: "needs_input" }),
    failed = settledRun("marten", 4, { settled_seq: 3, status: "failed" }), stopped = settledRun("lynx", 3, { settled_seq: 2, status: "cancelled" }),
    shown = settledRun("badger", 2, { settled_seq: 4, finished_presented: true }),
    finalizing = settledRun("ibis", 8, { phase: "finalizing", settled_seq: undefined }),
    notExited = settledRun("wren", 9, { execution_exited: false, settled_seq: undefined }),
    running = originalRun("rook", 10, { phase: "settled", execution_exited: true });
  const runs = [late, shown, finalizing, early, running, notExited, stopped, failed], before = runs.slice();
  assert.deepEqual(finishedCandidates(runs), [early, stopped, failed, late]);
  assert.deepEqual(runs, before); for (const run of [finalizing, notExited, running]) assert.equal(isCommunicationSettled(run), false);
});

for (const sequence of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  test(`missing/invalid settled_seq ${sequence} rejects candidate projection without marking it`, () => {
    const run = settledRun("otter", 1, { settled_seq: sequence });
    assert.throws(() => finishedCandidates([run]), hasCode("INVALID_SETTLEMENT_SEQUENCE"));
    assert.equal(run.finished_presented, false);
  });

test("waiting readiness priority is fault > actionable question > issue > done > alert > nothing", () => {
  const { run: question, agent: asking } = pendingQuestion(), issue = settledRun("orca", 2, { status: "failed" }),
    done = settledRun("marten", 3), live = originalRun("lynx", 4), pending = [];
  enqueueAlert(pending, live, "inbox");
  const options = { targets: [question, issue, done, live], agents: [asking, originalAgent(issue), originalAgent(done), originalAgent(live)],
    mode: "any", ownerHealthy: true, pending, scope: ownerScope, currentBlocked: "fault", reportedBlockAtStart: undefined };
  assert.equal(communicationReadiness(options), "owner_blocked");
  options.reportedBlockAtStart = "fault";
  assert.equal(communicationReadiness(options), "question");
  delete asking.question;
  assert.equal(communicationReadiness(options), "task_issue");
  issue.record.phase = "finalizing";
  assert.equal(communicationReadiness(options), "done");
  options.mode = "all";
  assert.equal(communicationReadiness(options), "alert");
  pending.length = 0;
  assert.equal(communicationReadiness(options), undefined);
  options.targets = [];
  assert.equal(communicationReadiness(options), "nothing_pending");
});

for (const status of ["failed", "cancelled", "completed"]) test(`only settled task issues can outrank completion (${status})`, () => {
  const issue = settledRun("otter", 1, { status, limit_reached: status === "completed" });
  const options = { targets: [issue], agents: [], mode: "all", ownerHealthy: true, pending: [], scope: ownerScope };
  assert.equal(communicationReadiness(options), "task_issue");
  issue.record.phase = "finalizing";
  assert.equal(communicationReadiness(options), undefined);
  issue.record.phase = "settled"; issue.record.execution_exited = false;
  assert.equal(communicationReadiness(options), undefined);
});

for (const mode of ["all", "any"]) test(`empty ${mode} never uses every([]) to declare done; historical inbox can still wake`, () => {
  const historical = settledRun("otter", 1), pending = [], options = {
    targets: [], agents: [originalAgent(historical, { resident: false, unavailable: "killed" })],
    mode, ownerHealthy: true, pending, scope: ownerScope };
  assert.equal(communicationReadiness(options), "nothing_pending");
  enqueueAlert(pending, historical, "retained after kill");
  assert.equal(communicationReadiness(options), "alert");
  options.scope = { kind: "agents", agent_ids: ["different-Agent"] };
  assert.equal(communicationReadiness(options), "nothing_pending");
});

test("historical/reserved needs_input cannot masquerade as actionable question readiness", () => {
  const { run, agent } = pendingQuestion(), options = { targets: [run], agents: [agent], mode: "all",
    ownerHealthy: true, pending: [], scope: ownerScope };
  for (const pointer of [undefined, { run_id: "new-question" }, { run_id: run.record.run_id, reserved_by: "answer" }]) {
    agent.question = pointer;
    assert.equal(communicationReadiness(options), "done");
  }
  agent.question = { run_id: run.record.run_id }; run.finished_presented = true;
  assert.equal(communicationReadiness(options), "question", "presentation does not silence a pending question");
});

test("typed Owner/Agents/Run scopes separate inbox from task targets and retain scope-filtered FIFO", () => {
  const older = settledRun("otter", 1), current = originalRun("otter", 9), other = originalRun("orca", 2), pending = [];
  const a = enqueueAlert(pending, older, "old"), outside = enqueueAlert(pending, other, "other"), b = enqueueAlert(pending, current, "current");
  assert.deepEqual(scopedAlerts(pending, ownerScope), [a, outside, b]);
  assert.deepEqual(scopedAlerts(pending, agentScope(current)), [a, b]);
  assert.deepEqual(scopedAlerts(pending, runScope(current)), [b]);
  assert.deepEqual(scopedAlerts(pending, runScope(structuredClone(current))), [], "Run scope is original identity, not UUID-shaped clone");
  const options = { targets: [current], agents: [originalAgent(current)], mode: "all", ownerHealthy: true, pending, scope: agentScope(current) };
  assert.equal(communicationReadiness(options), "alert");
  pending.pop(); options.scope = runScope(current);
  assert.equal(communicationReadiness(options), undefined, "inline wait cannot be intercepted by older same-Agent alert");
  options.scope = agentScope(current);
  assert.equal(communicationReadiness(options), "alert", "read/explicit Agent wait crosses Runs without changing target");
  assert.deepEqual(options.targets, [current]);
});

test("commit accepts scope-filtered prefix at nonadjacent Owner indices; pending counts are post-commit actuals", () => {
  const old = settledRun("otter", 1), current = originalRun("otter", 5), outsideRun = originalRun("orca", 2), state = {
    pending: [], runs: [old, outsideRun, current] };
  const outsideA = enqueueAlert(state.pending, outsideRun, "outside-A"), first = enqueueAlert(state.pending, old, "first"),
    outsideB = enqueueAlert(state.pending, outsideRun, "outside-B"), second = enqueueAlert(state.pending, current, "second"),
    third = enqueueAlert(state.pending, old, "third");
  const scope = agentScope(current), snapshot = capture(state, { scope, targets: [current] }), publication = body(snapshot, { alertRefs: [0, 1] });
  const before = state.pending.slice(), plan = validate(state, snapshot, publication, scope);
  assert.deepEqual(plan.alert_indices, [3, 1]); assert.deepEqual(state.pending, before, "validation alone is pure");
  assert.equal(publication.envelope.alerts_pending, 1); assert.equal(publication.envelope.finished_pending, 1);
  commit(state, snapshot, publication, scope);
  assert.deepEqual(state.pending, [outsideA, outsideB, third]);
  assert.equal(scopedAlerts(state.pending, scope).length, publication.envelope.alerts_pending);
  assert.equal(finishedCandidates(state.runs).length, publication.envelope.finished_pending);
  assert.equal(old.finished_presented, false); assert.equal(current.finished_presented, false);
  assert.equal(first.run, old); assert.equal(second.run, current);
});

test("a snapshot from a broader inbox cannot commit outside a typed Run/Agent subscope", () => {
  const old = settledRun("otter", 1), current = originalRun("otter", 4), other = originalRun("orca", 2), state = {
    pending: [], runs: [old, other, current] };
  enqueueAlert(state.pending, other, "foreign first"); enqueueAlert(state.pending, old, "old otter"); enqueueAlert(state.pending, current, "inline");
  const snapshot = capture(state), publication = body(snapshot, { alertRefs: [0] });
  for (const scope of [agentScope(current), runScope(current)]) {
    publication.envelope.alerts_pending = scopedAlerts(state.pending, scope).length - 1;
    unchanged(state, () => commit(state, snapshot, publication, scope), "INVALID_COMMUNICATION_COMMIT");
  }
  const inlineSnapshot = capture(state, { scope: runScope(current), targets: [current] }), inlineBody = body(inlineSnapshot, { alertRefs: [0] });
  commit(state, inlineSnapshot, inlineBody, runScope(current));
  assert.deepEqual(state.pending.map(({ message }) => message), ["foreign first", "old otter"]);
});

test("same Agent's current running task/pending name/historical alert must not mark unshown old finished Run", () => {
  const old = settledRun("otter", 1), middle = settledRun("otter", 3), current = originalRun("otter", 8), state = {
    pending: [], runs: [middle, current, old] };
  enqueueAlert(state.pending, old, "old-task alert");
  const snapshot = capture(state, { targets: [current] }), publication = body(snapshot, { alertRefs: [0] });
  publication.envelope.pending = ["otter"];
  assert.deepEqual(publication.envelope.agents, [{ agent: "otter", task: 3, status: "running" }]);
  assert.deepEqual(publication.envelope.alerts.map(({ agent, task }) => ({ agent, task })), [{ agent: "otter", task: 1 }]);
  assert.deepEqual(publication.references.finished, []); commit(state, snapshot, publication);
  assert.equal(old.finished_presented, false); assert.equal(middle.finished_presented, false); assert.equal(current.finished_presented, false);
  assert.equal(publication.envelope.finished_pending, 2);
  const next = capture(state, { targets: [middle] }), explicit = body(next);
  assert.deepEqual(explicit.references.finished, [1]); commit(state, next, explicit);
  assert.equal(middle.finished_presented, true); assert.equal(old.finished_presented, false);
  assert.equal(explicit.envelope.finished_pending, 1);
  const last = capture(state), finishedBody = body(last, { finishedRows: [last.data.finished[0].row] });
  commit(state, last, finishedBody);
  assert.equal(old.finished_presented, true); assert.equal(finishedBody.envelope.finished_pending, 0);
});

function validCommitFixture() {
  const old = settledRun("otter", 1), second = settledRun("otter", 2), current = originalRun("otter", 3), state = {
    pending: [], runs: [old, second, current], blocked: "edge-1", reportedBlock: undefined };
  enqueueAlert(state.pending, old, "first"); enqueueAlert(state.pending, current, "second");
  const snapshot = capture(state, { targets: [current], reason: "owner_blocked" });
  const publication = body(snapshot, { alertRefs: [0], finishedRows: [snapshot.data.finished[0].row] });
  return { state, snapshot, publication, old, second, current };
}

for (const [description, corrupt] of [
  ["duplicate alert", ({ publication }) => {
    publication.references.alerts = [0, 0]; publication.envelope.alerts.push(publication.envelope.alerts[0]); publication.envelope.alerts_pending = 0;
  }],
  ["skip first alert", ({ snapshot, publication }) => {
    publication.references.alerts = [1]; publication.envelope.alerts = [snapshot.data.alerts[1]];
  }],
  ["noninteger alert", ({ publication }) => { publication.references.alerts = [0.5]; }],
  ["string alert index", ({ publication }) => { publication.references.alerts = ["0"]; }],
  ["foreign alert index", ({ publication }) => { publication.references.alerts = [2]; }],
  ["equal-shaped alert not original pending event", ({ snapshot }) => { snapshot.alerts[0] = { ...snapshot.alerts[0] }; }],
  ["changed alert body", ({ publication }) => { publication.envelope.alerts[0].message = "edited"; }],
  ["changed alert task", ({ publication }) => { publication.envelope.alerts[0].task = 3; }],
  ["changed alert label", ({ publication }) => { publication.envelope.alerts[0].label = "other"; }],
  ["duplicate finished", ({ publication }) => { publication.references.finished = [0, 0]; publication.envelope.finished_pending = 0; }],
  ["negative finished index", ({ publication }) => { publication.references.finished = [-1]; }],
  ["foreign finished index", ({ publication }) => { publication.references.finished = [10]; }],
  ["noninteger finished index", ({ publication }) => { publication.references.finished = [0.5]; }],
  ["old finished reference with only current same-name running row", ({ publication }) => { delete publication.envelope.finished; }],
  ["explicit finished body without its commit reference", ({ publication }) => { publication.references.finished = []; publication.envelope.finished_pending = 2; }],
  ["finished candidate not truly settled", ({ old }) => { old.record.phase = "finalizing"; }],
  ["finished candidate has not exited", ({ old }) => { old.record.execution_exited = false; }],
  ["finished candidate already presented", ({ old }) => { old.finished_presented = true; }],
  ["finished row has wrong terminal status", ({ publication }) => { publication.envelope.finished[0] = { agent: "otter", task: 1, status: "failed" }; }],
  ["alert count reports global/history rather than actual remaining", ({ publication }) => { publication.envelope.alerts_pending = 64; }],
  ["finished count reports historical rather than actual remaining", ({ publication }) => { publication.envelope.finished_pending = 12; }],
  ["snapshot alert provenance dimension mismatch", ({ snapshot }) => { snapshot.alerts.pop(); }],
  ["snapshot finished provenance dimension mismatch", ({ snapshot }) => { snapshot.finished.pop(); }],
  ["snapshot bound provenance dimension mismatch", ({ snapshot }) => { snapshot.targets.pop(); }],
  ["bound row without its original target", ({ snapshot }) => { snapshot.targets[0] = structuredClone(snapshot.targets[0]); }],
  ["bound source/body forged task ordinal", ({ snapshot }) => { snapshot.data.tasks[0].row.task = 42; }],
  ["bound source/body forged terminal status", ({ snapshot }) => { snapshot.data.tasks[0].row.status = "completed"; }],
  ["bound body omitted", ({ publication }) => { publication.envelope.agents = []; }],
  ["body reason mismatch", ({ publication }) => { publication.envelope.reason = "snapshot"; }],
  ["current blocked edge changed", ({ state }) => { state.blocked = "edge-2"; }],
  ["wrong blocked reference", ({ publication }) => { publication.references.blocked = "edge-2"; }],
  ["missing blocked reference", ({ publication }) => { delete publication.references.blocked; }],
  ["edge already reported at registration", ({ snapshot }) => { snapshot.reportedBlockAtStart = "edge-1"; }],
]) test(`invalid commit (${description}) validates all refs before ANY alert/finished/fault modification`, () => {
  const fixture = validCommitFixture(); corrupt(fixture);
  unchanged(fixture.state, () => commit(fixture.state, fixture.snapshot, fixture.publication), "INVALID_COMMUNICATION_COMMIT");
  assert.equal(fixture.state.reportedBlock, undefined);
});

for (const mismatch of ["alert-task", "alert-label", "finished-task", "finished-original", "alert-nonoriginal", "finished-nonoriginal"])
  test(`snapshot/body agreement cannot forge authoritative Run provenance: ${mismatch}`, () => {
    const { state, snapshot, old, second } = validCommitFixture();
    // Forge BOTH plain snapshot and final serialized body through the real
    // packer. Independent original-Run authority, not self-consistency, rejects.
    if (mismatch === "alert-task") snapshot.data.alerts[0].task = 2;
    if (mismatch === "alert-label") snapshot.data.alerts[0].label = "forged label";
    if (mismatch === "finished-task") {
      snapshot.data.finished[0].row.task = 2;
      snapshot.data.finished[1].row.task = 1;
    }
    if (mismatch === "finished-original") snapshot.finished = [second, old];
    if (mismatch === "alert-nonoriginal") {
      const clone = structuredClone(old);
      state.pending[0] = { run: clone, message: state.pending[0].message };
      snapshot.alerts[0] = state.pending[0];
    }
    if (mismatch === "finished-nonoriginal") snapshot.finished[0] = structuredClone(old);
    const packed = packCommunication(snapshot.data);
    unchanged(state, () => commit(state, snapshot, packed), "INVALID_COMMUNICATION_COMMIT");
    assert.equal(old.finished_presented, false); assert.equal(second.finished_presented, false);
    assert.equal(state.reportedBlock, undefined);
  });

function sameDisplayFixture() {
  const shown = settledRun("otter", 1, { agent_id: "first-agent", finished_presented: true });
  const unshown = settledRun("otter", 2, { agent_id: "second-agent" });
  const state = { pending: [], runs: [shown, unshown], blocked: "edge-1", reportedBlock: undefined };
  enqueueAlert(state.pending, unshown, "accepted fact must survive a bad finished reference");
  const snapshot = capture(state, { targets: [shown], reason: "owner_blocked" });
  assert.deepEqual(snapshot.data.tasks[0].row, snapshot.data.finished[0].row);
  assert.notEqual(shown.record.agent_id, unshown.record.agent_id);
  return { state, snapshot, shown, unshown };
}

for (const forgedLink of [false, true]) test(`same display fields cannot claim another original Run (explicit forged link=${forgedLink})`, () => {
  const { state, snapshot, shown, unshown } = sameDisplayFixture();
  let publication;
  if (forgedLink) {
    snapshot.data.finished[0].task_index = 0;
    // The pure packer can check projected fields, not original identity. The
    // Owner must reject this B -> A link before any alert/finished/fault commit.
    publication = packCommunication(snapshot.data);
  } else {
    publication = body(snapshot, { alertRefs: [0] });
    publication.references.finished = [0]; publication.envelope.finished_pending = 0;
  }
  assert.deepEqual(publication.references.finished, [0]); assert.equal(publication.envelope.finished, undefined);
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
  assert.equal(shown.finished_presented, true); assert.equal(unshown.finished_presented, false);
  assert.equal(state.reportedBlock, undefined); assert.equal(state.pending.length, 1);
});

test("same display fields commit the other original only through its separately emitted finished row", () => {
  const { state, snapshot, shown, unshown } = sameDisplayFixture(), packed = packCommunication(snapshot.data);
  assert.deepEqual(packed.envelope.finished, [snapshot.data.finished[0].row]);
  const plan = commit(state, snapshot, packed);
  assert.deepEqual(plan.finished, [unshown]); assert.equal(plan.finished[0], unshown);
  assert.equal(shown.finished_presented, true); assert.equal(unshown.finished_presented, true);
  assert.equal(state.pending.length, 0); assert.equal(state.reportedBlock, "edge-1");
});

test("a single convenience row cannot commit two distinct original Runs with equal display fields", () => {
  const first = settledRun("otter", 1, { agent_id: "first-agent" }), second = settledRun("otter", 2, { agent_id: "second-agent" });
  const state = { pending: [], runs: [first, second] };
  enqueueAlert(state.pending, first, "retained");
  const snapshot = capture(state), publication = body(snapshot, { alertRefs: [0], finishedRows: [snapshot.data.finished[0].row] });
  // Deliberately malformed candidate/body data, tested independently of the
  // packer's duplicate-display validation: one row is not two original facts.
  publication.references.finished = [0, 1]; publication.envelope.finished_pending = 0;
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
});

test("a missing original-Run link cannot be repaired by matching display fields", () => {
  const run = settledRun("otter", 1), state = { pending: [], runs: [run] };
  enqueueAlert(state.pending, run, "retained");
  const snapshot = capture(state, { targets: [run] });
  delete snapshot.data.finished[0].task_index;
  const packed = packCommunication(snapshot.data);
  unchanged(state, () => commit(state, snapshot, packed), "INVALID_COMMUNICATION_COMMIT");
});

test("authoritative alert labels use surrogate-safe truncation before reference validation", () => {
  const run = originalRun("otter", 1, { description: "a".repeat(119) + "🚀" }), state = { pending: [], runs: [run] };
  enqueueAlert(state.pending, run, "label provenance");
  const snapshot = capture(state, { reason: "alert" }), packed = packCommunication(snapshot.data);
  assert.equal(packed.envelope.alerts[0].label, "a".repeat(119));
  commit(state, snapshot, packed);
  assert.equal(state.pending.length, 0);
});

test("duplicated actual PendingAlert object at distinct FIFO/snapshot indices cannot be deleted twice", () => {
  const fixture = validCommitFixture(), { state } = fixture, alert = state.pending[0];
  // Deliberately malformed authoritative/provenance arrays, not an enqueue path:
  // both numeric prefix indices look valid but denote the SAME event object.
  state.pending[1] = alert;
  const snapshot = capture(state, { reason: "owner_blocked", targets: [fixture.current] }), publication = body(snapshot, {
    alertRefs: [0, 1], finishedRows: [snapshot.data.finished[0].row] });
  assert.deepEqual(publication.references.alerts, [0, 1]); assert.equal(snapshot.alerts[0], snapshot.alerts[1]);
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
});

test("duplicated original finished Run in malicious provenance cannot commit through different numeric indices", () => {
  const { state, snapshot, current } = validCommitFixture();
  snapshot.finished[1] = snapshot.finished[0]; snapshot.data.finished[1] = { row: { ...snapshot.data.finished[0].row } };
  const publication = body(snapshot, { alertRefs: [0], finishedRows: [snapshot.data.finished[0].row] });
  publication.references.finished = [0, 1]; publication.envelope.finished_pending = 0;
  assert.equal(snapshot.finished[0], snapshot.finished[1]);
  assert.equal(current.finished_presented, false);
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
});

test("distinct original alert objects with identical body still both commit as a valid prefix", () => {
  const run = originalRun("otter", 1), state = { pending: [], runs: [run] };
  const first = enqueueAlert(state.pending, run, "repeat"), second = enqueueAlert(state.pending, run, "repeat");
  assert.notEqual(first, second);
  const snapshot = capture(state, { reason: "alert" }), publication = body(snapshot, { alertRefs: [0, 1] });
  commit(state, snapshot, publication);
  assert.deepEqual(state.pending, []); assert.equal(publication.envelope.alerts_pending, 0); assert.equal(run.finished_presented, false);
});

test("alert reason with zero selected messages is invalid even with a correct remaining count", () => {
  const { state, current } = validCommitFixture(), snapshot = capture(state, { reason: "alert", targets: [current] }), publication = body(snapshot);
  assert.equal(publication.envelope.alerts_pending, state.pending.length);
  assert.deepEqual(publication.references.alerts, []);
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
  const deliverable = body(snapshot, { alertRefs: [0] });
  commit(state, snapshot, deliverable);
  assert.equal(state.pending.length, 1); assert.equal(state.pending[0].message, "second");
});

for (const [originalStatus, projectedStatus] of [["completed", "failed"], ["needs_input", "completed"], ["cancelled", "failed"], ["cancelled", "cancelled"]])
  test(`finished source/body agreement cannot override original terminal status (${originalStatus} as ${projectedStatus})`, () => {
    const run = settledRun("otter", 1, { status: originalStatus }), state = { pending: [], runs: [run] };
    const snapshot = capture(state);
    snapshot.data.finished[0].row.status = projectedStatus;
    const publication = body(snapshot, { finishedRows: [{ ...snapshot.data.finished[0].row }] });
    assert.equal(publication.envelope.finished[0].status, snapshot.data.finished[0].row.status, "forged source and body agree");
    unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
  });

test("cancelled original Run is explicitly presented as interrupted and commits that exact Run", () => {
  const cancelled = settledRun("otter", 1, { status: "cancelled" }), live = originalRun("otter", 2), state = { pending: [], runs: [live, cancelled] };
  const snapshot = capture(state, { targets: [cancelled] }), publication = body(snapshot);
  assert.deepEqual(publication.envelope.agents, [{ agent: "otter", task: 1, status: "interrupted" }]);
  commit(state, snapshot, publication);
  assert.equal(cancelled.finished_presented, true); assert.equal(live.finished_presented, false);
});

test("currentBlocked vs snapshot validates broadcast A/B; another successful reporter is not a stale-ref failure", () => {
  const live = originalRun("otter", 1), state = { pending: [], runs: [live], blocked: "edge", reportedBlock: undefined };
  const snapshotA = capture(state, { reason: "owner_blocked", targets: [live] }),
    snapshotB = capture(state, { reason: "owner_blocked", targets: [live] });
  commit(state, snapshotA, body(snapshotA)); assert.equal(state.reportedBlock, "edge");
  commit(state, snapshotB, body(snapshotB)); assert.equal(state.reportedBlock, "edge", "B captured pre-edge eligibility, not the mutable reported marker");
  assert.equal(communicationReadiness({ targets: [live], agents: [], mode: "all", ownerHealthy: false,
    currentBlocked: state.blocked, reportedBlockAtStart: state.reportedBlock, pending: [], scope: ownerScope }), undefined);
  const stale = capture(state, { reason: "owner_blocked", reportedBlockAtStart: undefined }), staleBody = body(stale);
  state.blocked = "new-edge";
  unchanged(state, () => commit(state, stale, staleBody), "INVALID_COMMUNICATION_COMMIT");
});

test("snapshot policy never reports/consumes waiting-only Owner fault edge", () => {
  const run = originalRun("otter", 1), state = { pending: [], runs: [run], blocked: "edge", reportedBlock: undefined };
  enqueueAlert(state.pending, run, "readable");
  const snapshot = capture(state, { targets: [run] }), publication = body(snapshot, { alertRefs: [0] });
  publication.references.blocked = "edge";
  unchanged(state, () => commit(state, snapshot, publication), "INVALID_COMMUNICATION_COMMIT");
  delete publication.references.blocked;
  commit(state, snapshot, publication);
  assert.equal(state.reportedBlock, undefined); assert.deepEqual(state.pending, []);
});

for (const reason of ["aborted", "timeout"]) test(`${reason} cannot submit alert/finished/fault presentation references`, () => {
  const { state, old } = validCommitFixture(), snapshot = capture(state, { reason }), publication = body(snapshot);
  assert.deepEqual(validate(state, snapshot, publication), { alert_indices: [], finished: [] });
  for (const field of ["alerts", "finished", "blocked"]) {
    const refs = { ...publication.references, [field]: field === "blocked" ? "edge-1" : [0] };
    unchanged(state, () => commit(state, snapshot, { ...publication, references: refs }), "INVALID_COMMUNICATION_COMMIT");
  }
  assert.equal(state.pending.length, 2); assert.equal(old.finished_presented, false); assert.equal(state.reportedBlock, undefined);
});

// These are substantive pure-module integration fixtures. The scheduler's real
// ports call real readiness, real packing and real full-reference validation.
// Only snapshot construction and native clock delivery are synthetic; no real
// Owner admission, answer reservation, execution, cleanup, SDK or UI is involved.
function deterministicClock() {
  let now = 100, next = 0;
  const active = new Map(), history = new Map(), scheduled = [], cleared = [];
  return { scheduled, cleared, now: () => now, ids: () => [...active.keys()],
    advance(ms) { now += ms; },
    setTimeout(callback, delay) {
      const id = ++next;
      const timer = { id, callback, delay, at: now };
      active.set(id, timer); history.set(id, timer); scheduled.push(timer);
      return id;
    },
    clearTimeout(id) { active.delete(id); cleared.push(id); },
    fire(id) { assert(history.has(id)); active.delete(id); history.get(id).callback(); },
  };
}
function integratedFixture(t, runs, agents = []) {
  const clock = deterministicClock(), scheduler = new ObservationScheduler(clock), state = {
    runs, agents, pending: [], blocked: undefined, reportedBlock: undefined, ownerHealthy: true };
  t.after(() => assert.deepEqual(clock.ids(), [], "fixture leaves no registered timer"));
  function observe({ targets = [], scope = ownerScope, mode = "all", policy = { kind: "waiting", wait_ms: 80 },
    signal, action, abortDuringPublication } = {}) {
    const reportedBlockAtStart = state.reportedBlock, calls = { validate: 0, snapshot: 0, publish: 0, validateCommit: 0, commit: 0 };
    const publications = [];
    let snapshot, packed, plan;
    const promise = scheduler.observe({ policy, signal,
      ready: () => communicationReadiness({ targets, agents: state.agents, mode, ownerHealthy: state.ownerHealthy,
        currentBlocked: state.blocked, reportedBlockAtStart, pending: state.pending, scope }),
      validate() { calls.validate++; return { workersEnabled: true }; },
      snapshot(reason, validation) {
        calls.snapshot++; assert.equal(validation.workersEnabled, true);
        snapshot = capture(state, { targets, scope, reason, reportedBlockAtStart });
        if (action) snapshot.data.action = { ...action };
        return snapshot.data; // Original Run provenance does not cross this port.
      },
      publish(data) {
        calls.publish++; packed = packCommunication(data); publications.push(packed);
        // Fault injection is a real native signal AFTER packing, not an effect
        // supplied to the pure packer. The scheduler must discard that candidate.
        if (data.reason !== "aborted") abortDuringPublication?.abort();
        return { result: packed.result, references: packed.references };
      },
      validateCommit(references) {
        calls.validateCommit++;
        plan = validateCommunicationCommit({ runs: state.runs, pending: state.pending, scope, snapshot, references,
          envelope: packed.envelope, currentBlocked: state.blocked });
      },
      commit(_references) {
        calls.commit++;
        applyCommunicationCommit(state.pending, plan);
        if (plan.blocked !== undefined) state.reportedBlock = plan.blocked;
      },
    });
    return { promise, calls, publications };
  }
  function enqueue(run, message) {
    scheduler.assertEffectAllowed();
    const accepted = enqueueAlert(state.pending, run, message);
    scheduler.requestDrain();
    return accepted;
  }
  return { state, clock, scheduler, observe, enqueue };
}
const finalBody = (result) => JSON.parse(result.content[0].text);

test("real scheduler+state+packer: concurrent A/B consumes once; B keeps its timer through scope-excluded history and timeout", async (t) => {
  const old = settledRun("otter", 1, { phase: "finalizing", settled_seq: undefined }), live = originalRun("otter", 9),
    agent = originalAgent(live, { current: live.record.run_id }), f = integratedFixture(t, [old, live], [agent]);
  const a = f.observe({ targets: [live], scope: runScope(live), policy: { kind: "waiting", wait_ms: 40 } }),
    b = f.observe({ targets: [live], scope: runScope(live), policy: { kind: "waiting", wait_ms: 80 } });
  let bResolved = false;
  const watchedB = b.promise.then((value) => { bResolved = true; return value; });
  const [timerA, timerB] = f.clock.ids(); f.clock.advance(7);
  const accepted = f.enqueue(live, "one concurrent event");
  const resultA = await a.promise, bodyA = finalBody(resultA);
  assert.equal(resultA, a.publications[0].result, "no post-commit wrapping");
  assert.equal(bodyA.reason, "alert"); assert.equal(bodyA.alerts[0].message, accepted.message);
  assert.equal(bodyA.alerts[0].task, 2); assert.equal(bodyA.alerts_pending, 0);
  assert.deepEqual(f.state.pending, []); assert.equal(live.finished_presented, false);
  await Promise.resolve(); assert.equal(bResolved, false); assert.equal(b.calls.validate, 0);
  assert.deepEqual(f.clock.ids(), [timerB]); assert.deepEqual(f.clock.cleared, [timerA]);
  assert.deepEqual(f.clock.scheduled.map(({ delay, at }) => ({ delay, at })), [{ delay: 40, at: 100 }, { delay: 80, at: 100 }]);
  f.scheduler.assertEffectAllowed(); old.record.phase = "settled"; old.settled_seq = 1;
  const historical = f.enqueue(old, "not this inline inbox");
  f.scheduler.requestDrain(); assert.equal(f.clock.scheduled.length, 2); assert.equal(b.calls.validate, 0);
  f.clock.fire(timerB);
  const bodyB = finalBody(await watchedB);
  assert.equal(f.clock.now(), 107, "an early native callback still latches timeout");
  assert.equal(bodyB.reason, "timeout"); assert.equal(bodyB.alerts, undefined); assert.equal(bodyB.finished, undefined);
  assert.equal(bodyB.alerts_pending, 0); assert.equal(bodyB.finished_pending, 1);
  assert.equal(b.calls.validateCommit, 0); assert.equal(b.calls.commit, 0);
  assert.deepEqual(f.state.pending, [historical]); assert.equal(old.finished_presented, false);
});

test("real scheduler+state+packer: abort after packing discards all alert/finished/fault refs but preserves accepted action", async (t) => {
  const old = settledRun("otter", 1), live = originalRun("otter", 2), f = integratedFixture(t, [old, live]),
    abort = new AbortController(), action = { type: "agent_run", agent: "otter", task: 2 };
  const observation = f.observe({ targets: [live], signal: abort.signal, action, abortDuringPublication: abort });
  f.state.blocked = "fault-before-publication";
  const accepted = f.enqueue(live, "must stay pending"), result = await observation.promise, envelope = finalBody(result);
  assert.deepEqual(observation.publications.map(({ envelope: value }) => value.reason), ["owner_blocked", "aborted"]);
  assert.deepEqual(observation.publications[0].references, { alerts: [0], finished: [0], blocked: "fault-before-publication" });
  assert.equal(envelope.reason, "aborted"); assert.deepEqual(envelope.action, action);
  assert.equal(envelope.alerts, undefined); assert.equal(envelope.finished, undefined);
  assert.equal(envelope.alerts_pending, 1); assert.equal(envelope.finished_pending, 1);
  assert.deepEqual(f.state.pending, [accepted]); assert.equal(old.finished_presented, false); assert.equal(live.finished_presented, false);
  assert.equal(f.state.reportedBlock, undefined); assert.equal(observation.calls.validateCommit, 0); assert.equal(observation.calls.commit, 0);
});

test("real scheduler+state+packer: timeout never consumes global finished convenience or another Run's inbox", async (t) => {
  const old = settledRun("otter", 1), live = originalRun("otter", 2), f = integratedFixture(t, [old, live]);
  const retained = f.enqueue(old, "old Run message"), observation = f.observe({ targets: [live], scope: runScope(live) });
  const [timer] = f.clock.ids(); f.clock.fire(timer);
  const envelope = finalBody(await observation.promise);
  assert.equal(envelope.reason, "timeout"); assert.equal(envelope.finished, undefined); assert.equal(envelope.finished_pending, 1);
  assert.equal(envelope.alerts, undefined); assert.equal(envelope.alerts_pending, 0);
  assert.deepEqual(f.state.pending, [retained]); assert.equal(old.finished_presented, false);
  assert.equal(observation.calls.validateCommit, 0); assert.equal(observation.calls.commit, 0);
});

test("real scheduler+state+packer: finished cap leaves same-name old task untouched until its original Run is explicit", async (t) => {
  const old = settledRun("otter", 1, { settled_seq: 9 }), live = originalRun("otter", 20),
    earlierFinished = ["orca", "marten", "lynx", "badger", "ibis", "rook", "wren", "hare"].map((name, index) =>
      settledRun(name, index + 2, { settled_seq: index + 1 })),
    f = integratedFixture(t, [old, live, ...earlierFinished], [originalAgent(live, { current: live.record.run_id })]);
  f.enqueue(old, "historical alert is not a finished presentation");
  const observation = f.observe({ targets: [live], scope: agentScope(live) }), envelope = finalBody(await observation.promise);
  assert.equal(envelope.reason, "alert"); assert.deepEqual(envelope.agents, [{ agent: "otter", task: 2, status: "running" }]);
  assert.deepEqual(envelope.pending, ["otter"]); assert.equal(envelope.alerts[0].task, 1);
  assert.equal(envelope.finished.length, 8); assert(envelope.finished.every(({ agent }) => agent !== "otter"));
  assert(earlierFinished.every((run) => run.finished_presented)); assert.equal(old.finished_presented, false); assert.equal(live.finished_presented, false);
  assert.equal(envelope.finished_pending, finishedCandidates(f.state.runs).length); assert.equal(envelope.finished_pending, 1);
  assert.equal(envelope.alerts_pending, scopedAlerts(f.state.pending, agentScope(live)).length);
  const read = f.observe({ targets: [old], scope: agentScope(old), policy: { kind: "snapshot" } }), readBody = finalBody(await read.promise);
  assert.deepEqual(readBody.agents, [{ agent: "otter", task: 1, status: "completed" }]);
  assert.deepEqual(read.publications[0].references.finished, [0]); assert.equal(readBody.finished, undefined, "bound original Run needs no duplicate convenience row");
  assert.equal(old.finished_presented, true); assert.equal(live.finished_presented, false); assert.equal(readBody.finished_pending, 0);
});

test("real scheduler+state+packer: A/B fault broadcast uses registration marker; later wait retains timer", async (t) => {
  const live = originalRun("otter", 1), f = integratedFixture(t, [live]), a = f.observe({ targets: [live] }), b = f.observe({ targets: [live] });
  f.state.blocked = "edge-1"; f.state.ownerHealthy = false; f.scheduler.requestDrain();
  assert.equal(finalBody(await a.promise).reason, "owner_blocked"); assert.equal(finalBody(await b.promise).reason, "owner_blocked");
  assert.equal(a.calls.commit, 1); assert.equal(b.calls.commit, 1); assert.equal(f.state.reportedBlock, "edge-1");
  const later = f.observe({ targets: [live] }); assert.equal(later.calls.validate, 0);
  const [timer] = f.clock.ids(); f.clock.fire(timer);
  assert.equal(finalBody(await later.promise).reason, "timeout"); assert.equal(later.calls.commit, 0);
});

for (const policy of [{ kind: "waiting", wait_ms: 0 }, { kind: "waiting", wait_ms: 300000 }])
  test(`real scheduler+state+packer: empty targets/inbox returns nothing before timer (${policy.wait_ms})`, async (t) => {
    const f = integratedFixture(t, []), observation = f.observe({ policy });
    const envelope = finalBody(await observation.promise);
    assert.equal(envelope.reason, "nothing_pending"); assert.deepEqual(envelope.agents, []);
    assert.equal(envelope.alerts_pending, 0); assert.equal(envelope.finished_pending, 0); assert.equal(f.clock.scheduled.length, 0);
  });
