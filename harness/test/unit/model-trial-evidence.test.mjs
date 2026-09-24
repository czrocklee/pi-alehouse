import assert from "node:assert/strict";
import test from "node:test";
import { dialogueFailures, parentRoundEvidence, questionFailures } from "../support/model-trial-evidence.mjs";
import { assertThinkingSupported } from "../support/host.mjs";

const expected = { modelSpec: "fixture/calculator", parentThinking: "off", thinking: "off" };
const missingAnswer = "parent did not retrieve and report the answer Run's output";
function evidence() {
  const settings = { provider: "fixture", model: "calculator", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "reader", difficulty: 3, definition_digest: "fixture" };
  const question = { run_id: "question", agent_id: "worker", status: "needs_input", execution_exited: true,
    effective_settings: settings, outcome: { question: "factor?" } };
  const answer = { ...question, run_id: "answer", status: "completed", outcome: { status: "completed" } };
  const first = { runStates: [question], final: "factor?", stop_reason: "stop",
    calls: [{ name: "read_run", is_error: false, args: { run_id: "question" },
      value: { run_id: "question", status: "needs_input", question: "factor?", question_complete: true,
        question_omitted_chars: 0, text: "", complete: false, omitted_chars: 0 } }],
    childCalls: [{ name: "read", is_error: false, run_id: "question", fixture_match: "source.txt" }] };
  return structuredClone({ first, runStates: [question, answer], final: "7 × 11 × 3 = 231", stop_reason: "stop",
    stats: { active: 0, queued: 0, finalizing: 0, cleaning: 0, cleanup_uncertain: false },
    calls: [...first.calls,
      { name: "resume_agent", is_error: false, args: { agent_id: "worker", answer_to_run_id: "question" }, value: { run_id: "answer", agent_id: "worker" } },
      { name: "read_run", is_error: false, args: { run_id: "answer" },
        value: { run_id: "answer", status: "completed", complete: true, omitted_chars: 0, text: "7 × 11 × 3 = 231" } }] });
}
function retrieval(copy, name) {
  if (name === "resume_agent") {
    const result = copy.calls.pop().value;
    const resume = copy.calls.find((call) => call.name === name);
    resume.args.wait_ms = 60000;
    resume.value.wait = { reason: "condition", runs: [result] };
    return result;
  }
  const call = copy.calls.at(-1);
  if (name === "wait_runs") {
    call.name = name;
    call.args = { run_ids: ["answer"], mode: "all" };
    call.value = { reason: "condition", runs: [call.value] };
    return call.value.runs[0];
  }
  return call.value;
}

test("full question is separate from the assistant-output preview completeness", () => {
  assert.deepEqual(questionFailures(evidence().first), []);
});
test("accepted create wait may supply the complete question without a get", () => {
  const copy = evidence().first;
  copy.calls = [{ name: "spawn_agent", is_error: false, args: { wait_ms: 60000 }, value: {
    run_id: "question", agent_id: "worker", wait: { reason: "condition", runs: [{
      run_id: "question", status: "needs_input", question: "factor?", question_complete: true,
      question_omitted_chars: 0, complete: true, omitted_chars: 0, text: "please answer",
    }] },
  } }];
  assert.deepEqual(questionFailures(copy), []);
});
for (const name of ["read_run", "wait_runs", "spawn_agent"]) {
  for (const [label, mutate] of [
    ["incomplete flag alone", (value) => { value.question_complete = false; }],
    ["omitted characters alone", (value) => { value.question_omitted_chars = 2; }],
    ["missing omission count", (value) => { delete value.question_omitted_chars; }],
    ["shortened question despite complete metadata", (value) => { value.question = "factor"; }],
  ]) test(`${name}: rejects question ${label}`, () => {
    const copy = evidence().first, call = copy.calls[0], question = call.value;
    if (name !== "read_run") {
      call.name = name;
      const wait = { reason: "condition", runs: [question] };
      call.args = name === "wait_runs" ? { run_ids: ["question"], mode: "all" } : { wait_ms: 60000 };
      call.value = name === "wait_runs" ? wait : { run_id: "question", agent_id: "worker", wait };
    }
    assert.deepEqual(questionFailures(copy), []);
    mutate(question);
    assert.deepEqual(questionFailures(copy), ["parent did not retrieve that Run's complete question"]);
  });
}
test("accepted resume wait keeps top-level identity and may supply the whole answer", () => {
  const copy = evidence();
  const resume = copy.calls.find((call) => call.name === "resume_agent");
  resume.args.wait_ms = 60000;
  resume.value.wait = { reason: "condition", runs: [copy.calls.at(-1).value] };
  copy.calls.pop();
  assert.equal(resume.value.agent_id, "worker"); assert.equal(resume.value.run_id, "answer");
  assert.deepEqual(dialogueFailures(copy, expected), []);
});
for (const name of ["read_run", "wait_runs", "resume_agent"]) {
  test(`${name}: a complete terminal result satisfies the short dialogue`, () => {
    const copy = evidence(); retrieval(copy, name);
    assert.deepEqual(dialogueFailures(copy, expected), []);
  });
  for (const [label, mutate] of [
    ["old running partial despite eventual completion", (value) => { value.status = "running"; value.complete = false; value.text = "我来计算一下"; }],
    ["unread next page", (value) => { value.complete = false; value.next_cursor = "next-page"; }],
    ["inconsistent complete with cursor", (value) => { value.next_cursor = "next-page"; }],
    ["omitted output", (value) => { value.omitted_chars = 1; }],
    ["missing completeness", (value) => { delete value.complete; }],
    ["wrong Run", (value) => { value.run_id = "another-run"; }],
    ["empty final result", (value) => { value.text = " "; }],
  ]) test(`${name}: rejects ${label}`, () => {
    const copy = evidence(); mutate(retrieval(copy, name));
    assert.equal(copy.runStates[1].status, "completed");
    assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer]);
  });
}
test("a timed-out resume receipt does not hide a later complete retry of the same Run", () => {
  const copy = evidence(); retrieval(copy, "resume_agent");
  const completed = copy.calls.at(-1), timedOut = structuredClone(completed);
  timedOut.value.status = "running";
  timedOut.value.wait = { reason: "timeout", pending_run_ids: ["answer"], runs: [{ run_id: "answer", status: "running" }] };
  copy.calls.splice(copy.calls.length - 1, 0, timedOut);
  assert.deepEqual(dialogueFailures(copy, expected), [], "final Run state and any complete retrieval satisfy the oracle");
  copy.calls.pop();
  assert.deepEqual(dialogueFailures(copy, expected), [missingAnswer], "timeout alone never proves retrieval");
});
test("a last page marked complete does not prove a whole result was retrieved", () => {
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
test("ordinary parent follow-up also requires the first Run's whole terminal output", () => {
  const copy = evidence(), question = copy.first.runStates[0];
  question.status = "completed"; question.outcome = { status: "completed" };
  copy.runStates[0] = structuredClone(question);
  const reply = copy.first.calls[0].value;
  Object.assign(reply, { status: "completed", complete: true, text: "factor?" }); delete reply.question;
  delete copy.calls.find((call) => call.name === "resume_agent").args.answer_to_run_id;
  assert.deepEqual(dialogueFailures(copy, expected), []);
  reply.status = "running"; reply.complete = false;
  assert.deepEqual(dialogueFailures(copy, expected), ["parent did not retrieve the first Run's output before asking the user"]);
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
