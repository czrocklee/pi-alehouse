import assert from "node:assert/strict";
import test from "node:test";
import { dialogueFailures, parentRoundEvidence, questionFailures } from "../support/model-trial-evidence.mjs";
import { assertThinkingSupported } from "../support/host.mjs";

const expected = { modelSpec: "fixture/calculator", parentThinking: "off", thinking: "off" };
const missingAnswer = "parent did not retrieve and report the answer task's output";
function evidence() {
  const settings = { provider: "fixture", model: "calculator", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "reader", difficulty: 3, definition_digest: "fixture" };
  const question = { run_id: "question", agent_id: "worker-id", name: "worker", status: "needs_input", execution_exited: true,
    effective_settings: settings, outcome: { question: "factor?" } };
  const answer = { ...question, run_id: "answer", status: "completed", outcome: { status: "completed" } };
  const first = { runStates: [question], final: "factor?", stop_reason: "stop",
    calls: [{ name: "agent_read", is_error: false, args: { agent: "worker" },
      value: { agent: "worker", status: "needs_input", question: "factor?", result: "" } }],
    childCalls: [{ name: "read", is_error: false, run_id: "question", fixture_match: "source.txt" }] };
  return structuredClone({ first, runStates: [question, answer], final: "7 × 11 × 3 = 231", stop_reason: "stop",
    stats: { active: 0, queued: 0, finalizing: 0, cleaning: 0, cleanup_uncertain: false },
    calls: [...first.calls,
      { name: "agent_send", is_error: false, args: { agent: "worker", message: "3" }, value: { delivery: "answered", agent: "worker", status: "running" } },
      { name: "agent_read", is_error: false, args: { agent: "worker" },
        value: { agent: "worker", status: "completed", result: "7 × 11 × 3 = 231" } }] });
}
function retrieval(copy, name) {
  if (name === "agent_send") {
    const result = copy.calls.pop().value;
    const answer = copy.calls.findLast((call) => call.name === name);
    answer.args.wait_ms = 60000; answer.value = { delivery: "answered", ...result };
    return answer.value;
  }
  const call = copy.calls.at(-1);
  if (name === "agent_wait") {
    call.name = name; call.args = { agents: ["worker"] };
    call.value = { reason: "done", agents: [call.value] };
    return call.value.agents[0];
  }
  return call.value;
}

test("full question is separate from the assistant-output preview completeness", () => {
  assert.deepEqual(questionFailures(evidence().first), []);
});
test("an accepted spawn wait may supply the complete question without a read", () => {
  const copy = evidence().first;
  copy.calls = [{ name: "agent_spawn", is_error: false, args: { agent: "worker", profile: "reader", difficulty: 3, wait_ms: 60000 },
    value: { agent: "worker", status: "needs_input", question: "factor?", result: "please answer" } }];
  assert.deepEqual(questionFailures(copy), []);
});
for (const name of ["agent_read", "agent_wait", "agent_spawn"]) {
  for (const [label, mutate] of [
    ["truncation flag alone", (value) => { value.question_truncated = true; }],
    ["shortened question", (value) => { value.question = "factor"; }],
    ["another Agent", (value) => { value.agent = "otter"; }],
  ]) test(`${name}: rejects question ${label}`, () => {
    const copy = evidence().first, call = copy.calls[0], question = call.value;
    if (name !== "agent_read") {
      call.name = name;
      call.args = name === "agent_wait" ? { agents: ["worker"] } : { agent: "worker", profile: "reader", difficulty: 3, wait_ms: 60000 };
      call.value = name === "agent_wait" ? { reason: "attention", agents: [question] } : question;
    }
    assert.deepEqual(questionFailures(copy), []);
    mutate(question);
    assert.deepEqual(questionFailures(copy), ["parent did not retrieve that task's complete question"]);
  });
}
test("a send to the same Agent answers it; its wait may supply the whole answer", () => {
  const copy = evidence(); retrieval(copy, "agent_send");
  assert.deepEqual(dialogueFailures(copy, expected), []);
});
test("an answer must be an answered send to the same Agent, not a new Agent or a steer", () => {
  const steered = evidence();
  steered.calls.find((call) => call.name === "agent_send").value.delivery = "steered";
  assert.deepEqual(dialogueFailures(steered, expected), ["user answer did not complete a second task on the same Agent", missingAnswer]);
  const copy = evidence();
  const answer = copy.calls.find((call) => call.name === "agent_send");
  answer.name = "agent_spawn"; Object.assign(answer.args, { agent: "otter", prompt: "3", profile: "reader", difficulty: 3 }); answer.value.agent = "otter";
  assert.deepEqual(dialogueFailures(copy, expected), ["user answer did not complete a second task on the same Agent", missingAnswer]);
});
for (const name of ["agent_read", "agent_wait", "agent_send"]) {
  test(`${name}: a complete terminal result satisfies the short dialogue`, () => {
    const copy = evidence(); retrieval(copy, name);
    assert.deepEqual(dialogueFailures(copy, expected), []);
  });
  for (const [label, mutate] of [
    ["old running partial despite eventual completion", (value) => { value.status = "running"; value.result = "我来计算一下"; }],
    ["unread next page", (value) => { value.next_cursor = "next-page"; }],
    ["omitted output", (value) => { value.omitted_chars = 1; }],
    ["result left for read_result", (value) => { delete value.result; value.result_omitted = true; }],
    ["another Agent", (value) => { value.agent = "otter"; }],
    ["empty final result", (value) => { value.result = " "; }],
  ].filter(([label]) => name !== "agent_send" || label !== "another Agent")) test(`${name}: rejects ${label}`, () => {
    const copy = evidence(); mutate(retrieval(copy, name));
    assert.equal(copy.runStates[1].status, "completed");
    assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
  });
}
test("a reply read before the answer task started cannot stand in for its result", () => {
  const copy = evidence(), stale = structuredClone(copy.calls.at(-1));
  copy.calls.pop(); copy.calls.splice(1, 0, stale);
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
});
test("a timed-out send wait does not hide a later complete read", () => {
  const copy = evidence(); retrieval(copy, "agent_send");
  const completed = copy.calls.at(-1), timedOut = structuredClone(completed);
  timedOut.value = { delivery: "answered", agent: "worker", status: "running" };
  copy.calls.splice(copy.calls.length - 1, 1, timedOut, { name: "agent_read", is_error: false, args: { agent: "worker" }, value: completed.value });
  assert.deepEqual(dialogueFailures(copy, expected), [], "final task state and any complete retrieval satisfy the oracle");
  copy.calls.pop();
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer], "a timeout alone never proves retrieval");
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
test("ordinary parent follow-up also requires the first task's whole terminal output", () => {
  const copy = evidence(), question = copy.first.runStates[0];
  question.status = "completed"; question.outcome = { status: "completed" };
  copy.runStates[0] = structuredClone(question);
  const reply = copy.first.calls[0].value;
  Object.assign(reply, { status: "completed", result: "factor?" }); delete reply.question;
  assert.deepEqual(dialogueFailures(copy, expected), []);
  reply.status = "running";
  assert.deepEqual(dialogueFailures(copy, expected), ["parent did not retrieve the first task's output before asking the user"]);
});
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
