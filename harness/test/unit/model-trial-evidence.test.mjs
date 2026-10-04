import assert from "node:assert/strict";
import test from "node:test";
import { dialogueFailures, parentRoundEvidence, questionFailures } from "../support/model-trial-evidence.mjs";
import { assertThinkingSupported } from "../support/host.mjs";

const expected = { modelSpec: "fixture/calculator", parentThinking: "off", thinking: "off" };
const missingAnswer = "parent did not retrieve and report the answer task's output";
const noAnswer = ["user answer did not complete a second task on the same Agent", missingAnswer];
const inconsistentReference = "question references for the same task did not match the original Run";
const questionId = `q_${"1".repeat(32)}`;
const otherQuestionId = `q_${"2".repeat(32)}`;
const envelope = (row, extra = {}) => ({ reason: "snapshot", agents: [row], alerts_pending: 0, ...extra });
function evidence() {
  const settings = { provider: "fixture", model: "calculator", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "reader", difficulty: 3, definition_digest: "fixture" };
  const question = { run_id: "question", agent_id: "worker-id", name: "worker", task: 1, status: "needs_input", execution_exited: true,
    question_id: questionId, effective_settings: settings, outcome: { question: "factor?" } };
  const answer = { ...question, run_id: "answer", task: 2, question_id: undefined, status: "completed", outcome: { status: "completed" } };
  const first = { runStates: [question], final: "factor?", stop_reason: "stop",
    calls: [{ name: "agent_read", is_error: false, args: { agent: "worker" },
      value: envelope({ agent: "worker", task: 1, status: "needs_input", question_id: questionId, question: "factor?", result: "" }) }],
    childCalls: [{ name: "read", is_error: false, run_id: "question", fixture_match: "source.txt" }] };
  return structuredClone({ first, runStates: [question, answer], final: "7 × 11 × 3 = 231", stop_reason: "stop",
    stats: { active: 0, queued: 0, finalizing: 0, cleaning: 0, cleanup_uncertain: false },
    calls: [...first.calls,
      { name: "agent_answer", is_error: false, args: { agent: "worker", question_id: questionId, answer: "3" },
        value: envelope({ agent: "worker", task: 2, status: "running" }, { action: { type: "agent_answer", agent: "worker", task: 2 } }) },
      { name: "agent_read", is_error: false, args: { agent: "worker" },
        value: envelope({ agent: "worker", task: 2, status: "completed", result: "7 × 11 × 3 = 231" }) }] });
}
function retrieval(copy, name) {
  if (name === "agent_answer") {
    const result = copy.calls.pop().value.agents[0];
    const answer = copy.calls.findLast((call) => call.name === name);
    answer.args.wait_ms = 60000; answer.value = envelope(result, { reason: "done", action: answer.value.action });
    return answer.value.agents[0];
  }
  const call = copy.calls.at(-1);
  if (name === "agent_wait") {
    call.name = name; call.args = { agents: ["worker"] }; call.value.reason = "done";
  }
  return call.value.agents[0];
}

const ordinaryFollowup = (copy) => {
  const question = copy.first.runStates[0];
  question.status = "completed"; question.outcome = { status: "completed" }; delete question.question_id;
  copy.runStates[0] = structuredClone(question);
  const row = copy.first.calls[0].value.agents[0];
  Object.assign(row, { status: "completed", result: "factor?" }); delete row.question; delete row.question_id;
  const answer = copy.calls.find((call) => call.name === "agent_answer");
  answer.name = "agent_run"; answer.args = { agent: "worker", prompt: "3" }; answer.value.action.type = "agent_run";
  return row;
};

test("full question/reference is separate from assistant-output preview completeness", () => {
  assert.deepEqual(questionFailures(evidence().first), []);
});
test("a spawn observation may supply the complete question without a read", () => {
  const copy = evidence().first;
  copy.calls = [{ name: "agent_spawn", is_error: false, args: { agent: "worker", profile: "reader", reasoning_difficulty: 3, wait_ms: 60000 },
    value: envelope({ agent: "worker", task: 1, status: "needs_input", question_id: questionId, question: "factor?", result: "please answer" },
      { reason: "question", action: { type: "agent_spawn", agent: "worker", task: 1 } }) }];
  assert.deepEqual(questionFailures(copy), []);
});
for (const name of ["agent_read", "agent_wait", "agent_spawn"]) {
  for (const [label, mutate] of [
    ["truncation flag alone", (value) => { value.question_truncated = true; }],
    ["shortened question", (value) => { value.question = "factor"; }],
    ["another Agent", (value) => { value.agent = "otter"; }],
    ["another task of the same Agent", (value) => { value.task = 2; }],
    ["missing reference", (value) => { delete value.question_id; }],
    ["different reference", (value) => { value.question_id = `q_${"2".repeat(32)}`; }],
  ]) test(`${name}: rejects question ${label}`, () => {
    const copy = evidence().first, call = copy.calls[0], question = call.value.agents[0];
    if (name !== "agent_read") {
      call.name = name;
      call.args = name === "agent_wait" ? { agents: ["worker"] } : { agent: "worker", profile: "reader", reasoning_difficulty: 3, wait_ms: 60000 };
      call.value.reason = "question";
    }
    assert.deepEqual(questionFailures(copy), []);
    mutate(question);
    assert.deepEqual(questionFailures(copy), ["parent did not retrieve that task's complete question",
      ...(label === "different reference" ? [inconsistentReference] : [])]);
  });
}
test("an explicit answer to the same reference may return the whole answer inline", () => {
  const copy = evidence(); retrieval(copy, "agent_answer");
  assert.deepEqual(dialogueFailures(copy, expected), []);
});
for (const [label, mutate] of [
  ["steering instead of explicit answer", (call) => { call.name = "agent_send"; call.value.action = { type: "agent_send", agent: "worker", task: 1, delivery: "steered" }; }],
  ["legacy send-answered", (call) => { call.name = "agent_send"; call.value = { agent: "worker", delivery: "answered", status: "completed", result: "231" }; }],
  ["new Agent", (call) => { call.name = "agent_spawn"; call.args.agent = "otter"; call.value.action = { type: "agent_spawn", agent: "otter", task: 1 }; }],
  ["wrong question token", (call) => { call.args.question_id = `q_${"2".repeat(32)}`; }],
  ["missing question token", (call) => { delete call.args.question_id; }],
  ["wrong continuation task", (call) => { call.value.action.task = 3; }],
  ["wrong action type", (call) => { call.value.action.type = "agent_run"; }],
]) test(`active trial rejects ${label}`, () => {
  const copy = evidence(); mutate(copy.calls.find((call) => call.name === "agent_answer"));
  assert.deepEqual(dialogueFailures(copy, expected), noAnswer);
});
// Record repeated model observations without changing the original Run facts.
// first.calls and calls are separately sampled in the host fixture.
function addReference(copy, row, { first = true, name = "agent_read", is_error = false, cursor } = {}) {
  const call = { name, is_error, args: { agent: row.agent, ...(cursor === undefined ? {} : { cursor }) }, value: envelope(row) };
  if (first) copy.first.calls.push(structuredClone(call));
  copy.calls.splice(copy.calls.findIndex((entry) => entry.value?.action?.type === "agent_answer"), 0, call);
}
const questionRow = (token = questionId, rest = {}) => ({ agent: "worker", task: 1, status: "needs_input",
  question: "factor?", question_id: token, ...rest });

for (const name of ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read"]) {
  for (const first of [true, false]) test(`${name}: correct Q1 then bad Q2 cannot authorize Q2 (${first ? "question" : "answer"} round)`, () => {
    const copy = evidence();
    addReference(copy, questionRow(otherQuestionId), { first, name });
    copy.calls.find((call) => call.value.action?.type === "agent_answer").args.question_id = otherQuestionId;
    assert.deepEqual(questionFailures(copy.first), first ? [inconsistentReference] : []);
    assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference, ...noAnswer]);
  });
}
test("a later correct Q1 cannot erase an inconsistent same-task Q2 observation", () => {
  const copy = evidence();
  addReference(copy, questionRow(otherQuestionId));
  addReference(copy, questionRow());
  assert.deepEqual(questionFailures(copy.first), [inconsistentReference]);
  assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference], "even a correct answer cannot certify inconsistent evidence");
  copy.calls.find((call) => call.value.action?.type === "agent_answer").args.question_id = otherQuestionId;
  assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference, ...noAnswer]);
});
test("repeated consistent Q1 observations and historical rows without tokens remain valid", () => {
  const copy = evidence();
  addReference(copy, questionRow());
  addReference(copy, { agent: "worker", task: 1, status: "needs_input", question: "factor?" });
  addReference(copy, questionRow(), { first: false, name: "agent_wait" });
  assert.deepEqual(dialogueFailures(copy, expected), []);
});
for (const token of [otherQuestionId, "not-a-token", null, `${questionId}\n`]) {
  test(`a paged same-task reference cannot hide inconsistency: ${JSON.stringify(token)}`, () => {
    const copy = evidence();
    addReference(copy, questionRow(token), { first: false, cursor: "historical-page" });
    assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference]);
  });
}
for (const row of [questionRow(otherQuestionId, { agent: "otter" }), questionRow(otherQuestionId, { task: 3 })]) {
  test(`another Agent/task reference does not replace original Q1: ${row.agent}/${row.task}`, () => {
    const copy = evidence(); addReference(copy, row);
    assert.deepEqual(dialogueFailures(copy, expected), []);
    copy.calls.find((call) => call.value.action?.type === "agent_answer").args.question_id = otherQuestionId;
    assert.deepEqual(dialogueFailures(copy, expected), noAnswer);
  });
}
test("errored and non-observation replies cannot replace the original reference", () => {
  const copy = evidence();
  addReference(copy, questionRow(otherQuestionId), { is_error: true });
  addReference(copy, questionRow(otherQuestionId), { name: "agent_list" });
  assert.deepEqual(dialogueFailures(copy, expected), []);
  copy.calls.find((call) => call.value.action?.type === "agent_answer").args.question_id = otherQuestionId;
  assert.deepEqual(dialogueFailures(copy, expected), noAnswer);
});
test("a malformed original Run token cannot authorize a matching answer", () => {
  const copy = evidence(), token = `${questionId}\n`;
  copy.first.runStates[0].question_id = token;
  copy.first.calls[0].value.agents[0].question_id = token;
  copy.calls[0].value.agents[0].question_id = token;
  copy.calls.find((call) => call.value.action?.type === "agent_answer").args.question_id = token;
  assert.deepEqual(dialogueFailures(copy, expected), ["parent did not retrieve that task's complete question", inconsistentReference, ...noAnswer]);
});

for (const name of ["agent_read", "agent_wait", "agent_answer"]) {
  test(`${name}: a complete terminal result satisfies the short dialogue`, () => {
    const copy = evidence(); retrieval(copy, name);
    assert.deepEqual(dialogueFailures(copy, expected), []);
  });
  for (const [label, mutate] of [
    ["old running partial despite eventual completion", (value) => { value.status = "running"; value.result = "我来计算一下"; }],
    ["unread next page", (value) => { value.next_cursor = "next-page"; }],
    ["omitted output", (value) => { value.omitted_chars = 1; }],
    ["result left for agent_read", (value) => { delete value.result; value.result_omitted = true; }],
    ["truncated preview", (value) => { value.result_truncated = true; }],
    ["another Agent", (value) => { value.agent = "otter"; }],
    ["old task of the same Agent", (value) => { value.task = 1; }],
    ["empty final result", (value) => { value.result = " "; }],
  ]) test(`${name}: rejects ${label}`, () => {
    const copy = evidence(); mutate(retrieval(copy, name));
    assert.equal(copy.runStates[1].status, "completed");
    assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
  });
}
test("flattened historical replies cannot certify active matched-protocol retrieval", () => {
  const copy = evidence(); copy.calls.at(-1).value = copy.calls.at(-1).value.agents[0];
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
});
test("a reply read before the answer task started cannot stand in for its result", () => {
  const copy = evidence(), stale = structuredClone(copy.calls.at(-1));
  copy.calls.pop(); copy.calls.splice(1, 0, stale);
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
});
test("a timed-out answer observation does not hide a later complete read", () => {
  const copy = evidence(); retrieval(copy, "agent_answer");
  const completed = copy.calls.at(-1), timedOut = structuredClone(completed);
  timedOut.value = envelope({ agent: "worker", task: 2, status: "running" }, { reason: "timeout", action: completed.value.action });
  copy.calls.splice(copy.calls.length - 1, 1, timedOut, { name: "agent_read", is_error: false, args: { agent: "worker" },
    value: envelope(completed.value.agents[0]) });
  assert.deepEqual(dialogueFailures(copy, expected), [], "later complete retrieval satisfies the oracle");
  copy.calls.pop(); assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer], "timeout alone never proves retrieval");
});
test("a later page does not prove a whole result was retrieved", () => {
  const copy = evidence(); copy.calls.at(-1).args.cursor = "last-page";
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
});
test("no retrieval and an errored retrieval are rejected", () => {
  for (const drop of [true, false]) {
    const copy = evidence();
    if (drop) copy.calls.pop(); else copy.calls.at(-1).is_error = true;
    assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
  }
});
test("ordinary parent clarification uses agent_run and still requires whole first-task output", () => {
  const copy = evidence(), row = ordinaryFollowup(copy);
  assert.deepEqual(dialogueFailures(copy, expected), []);
  row.status = "running";
  assert.deepEqual(dialogueFailures(copy, expected), ["parent did not retrieve the first task's output before asking the user"]);
});
test("an alert alone does not certify question retrieval before a later wait", () => {
  const copy = evidence().first, full = copy.calls[0];
  copy.calls = [{ name: "agent_spawn", is_error: false, args: { agent: "worker", wait_ms: 60000 },
    value: envelope({ agent: "worker", task: 1, status: "running" }, { reason: "alert", action: { type: "agent_spawn", agent: "worker", task: 1 },
      alerts: [{ agent: "worker", task: 1, label: "calculate", message: "missing factor" }] }) }];
  assert.deepEqual(questionFailures(copy), ["parent did not retrieve that task's complete question"]);
  copy.calls.push({ ...full, name: "agent_wait", args: { agents: ["worker"] } });
  assert.deepEqual(questionFailures(copy), []);
});
for (const [field, changed, scopeFailure] of [
  ["definition_digest", "changed-definition", false], ["model", "other-model", true],
  ["parent_thinking", "low", true], ["thinking", "low", true], ["thinking_resolution", "other", true],
]) test(`reference consistency never replaces the fixed Agent settings check: ${field}`, () => {
  for (const inconsistent of [false, true]) {
    const copy = evidence();
    if (inconsistent) addReference(copy, questionRow(otherQuestionId));
    copy.runStates[1].effective_settings = { ...copy.runStates[1].effective_settings, [field]: changed };
    assert.deepEqual(dialogueFailures(copy, expected), [...(inconsistent ? [inconsistentReference] : []),
      "reused Agent settings changed", ...(scopeFailure ? ["task execution/budget/model scope was not satisfied"] : [])]);
  }
});
test("reference consistency never replaces the task budget check", () => {
  const copy = evidence(); addReference(copy, questionRow(otherQuestionId));
  copy.runStates[1].outcome.limit_reached = true;
  assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference, "task execution/budget/model scope was not satisfied"]);
});
for (const field of ["active", "queued", "finalizing", "cleaning", "cleanup_uncertain", "parent_error", "internal_error"]) {
  test(`reference consistency never replaces the ownership check: ${field}`, () => {
    const copy = evidence(); addReference(copy, questionRow(otherQuestionId)); copy.stats[field] = true;
    assert.deepEqual(dialogueFailures(copy, expected), [inconsistentReference, "active work or uncertain ownership remained before host cleanup"]);
  });
}
for (const stage of ["question", "answer"]) for (const reason of ["error", "aborted", "length", "toolUse", "pending", "deferred", undefined]) {
  test(`parent ${stage}: nonempty text cannot hide stop reason ${reason}`, () => {
    const copy = evidence(), round = stage === "question" ? copy.first : copy;
    round.stop_reason = reason; round.error_message = "synthetic provider failure";
    assert.deepEqual(dialogueFailures(copy, expected), [`parent ${stage} did not finish with stop`]);
  });
}
test("round sampling never falls back to a previous round or previous nonempty assistant", () => {
  const messages = [{ role: "assistant", stopReason: "stop", content: "old answer" }, { role: "user", content: "new question" }];
  assert.deepEqual(parentRoundEvidence(messages, 1), { final: "", stop_reason: undefined, error_message: undefined });
  messages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "working" }] },
    { role: "assistant", stopReason: "error", errorMessage: "provider failed", content: [] });
  assert.deepEqual(parentRoundEvidence(messages, 1), { final: "", stop_reason: "error", error_message: "provider failed" });
  assert.throws(() => parentRoundEvidence(messages), /INVALID_PARENT_ROUND_START/);
  assert.throws(() => parentRoundEvidence(messages, messages.length + 1), /INVALID_PARENT_ROUND_START/);
});
test("round sampling retains correct text plus provider failure diagnostics", () => {
  const sampled = parentRoundEvidence([{ role: "assistant", content: [{ type: "text", text: "231" }],
    stopReason: "error", errorMessage: "provider failed after output" }], 0);
  assert.deepEqual(sampled, { final: "231", stop_reason: "error", error_message: "provider failed after output" });
});
test("thinking validation uses the selected model helper, including max when supported", () => {
  const model = { id: "synthetic-max-model" };
  const supported = (actual) => { assert.equal(actual, model); return ["off", "max"]; };
  assertThinkingSupported(model, "max", supported);
  assert.throws(() => assertThinkingSupported(model, "xhigh", supported), /UNSUPPORTED_THINKING/);
  assert.throws(() => assertThinkingSupported(model, "typo", supported), /UNSUPPORTED_THINKING/);
  assert.throws(() => assertThinkingSupported(model, "max", () => ["off"]), /UNSUPPORTED_THINKING/);
});
