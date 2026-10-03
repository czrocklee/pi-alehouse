// Active matched-protocol dialogue checks only. Natural-language correctness is
// reviewed from saved replies, not inferred from a number in free text. Old
// notify/progress/send-answered journals remain archive data, not active trials.
export const messageText = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

export function parentRoundEvidence(messages, start) {
  if (!Number.isInteger(start) || start < 0 || start > messages.length) throw new Error("INVALID_PARENT_ROUND_START");
  const last = messages.slice(start).findLast((message) => message.role === "assistant");
  return { final: messageText(last), stop_reason: last?.stopReason, error_message: last?.errorMessage };
}

// All six model observations have agents rows. Agent/task identify the original
// Run; action is a command fact, never a flattened observation. Zero-wait
// snapshots can also retrieve already settled text. No legacy active fallback.
const observations = new Set(["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read"]);
const projections = (call, { paged = false } = {}) => {
  if (call.is_error !== false || !observations.has(call.name) || !Array.isArray(call.value?.agents)) return [];
  if (call.name === "agent_read" && !paged && call.args?.cursor !== undefined) return [];
  return call.value.agents;
};
const sameTask = (value, run) => value?.agent === run?.name && value?.task === run?.task;
const isQuestionReference = (value) => typeof value === "string" && /^q_[0-9a-f]{32}$/.exec(value)?.[0] === value;
const inconsistentReference = "question references for the same task did not match the original Run";
const hasInconsistentReference = (calls, run) => calls.some((call) => projections(call, { paged: true })
  .some((value) => sameTask(value, run) && value.question_id !== undefined &&
    (!isQuestionReference(value.question_id) || value.question_id !== run.question_id)));

function retrievedOutput(calls, run) {
  // This short task needs one whole terminal reply, not a pagination audit.
  // A read with an input cursor is only a later page, never proof of the whole.
  const whole = (value) => sameTask(value, run) && value.status === "completed" && value.result?.trim() &&
    value.next_cursor === undefined && !value.omitted_chars && !value.result_omitted && !value.result_truncated;
  return run && calls.some((call) => projections(call).some(whole));
}

function retrievedQuestion(calls, run) {
  const whole = (value) => sameTask(value, run) && value.question === run.outcome.question && !value.question_truncated &&
    value.question_id === run.question_id && isQuestionReference(value.question_id);
  return calls.some((call) => projections(call, { paged: true }).some(whole));
}

export function questionFailures({ calls, runStates, childCalls, final, stop_reason }) {
  const failures = [];
  const question = runStates.length === 1 && runStates[0];
  if (!question || !["needs_input", "completed"].includes(question.status) || !question.execution_exited) {
    failures.push("one delegated task must settle before the user supplies the missing factor");
  }
  if (question?.status === "needs_input") {
    if (!question.outcome?.question || !retrievedQuestion(calls, question)) {
      failures.push("parent did not retrieve that task's complete question");
    }
    if (hasInconsistentReference(calls, question)) failures.push(inconsistentReference);
  } else if (!retrievedOutput(calls, question)) {
    failures.push("parent did not retrieve the first task's output before asking the user");
  }
  if (!childCalls.some((call) => call.run_id === question?.run_id && call.fixture_match === "source.txt")) {
    failures.push("question task did not read the synthetic source through SDK read");
  }
  if (!final?.trim()) failures.push("parent did not return a question to the user");
  if (stop_reason !== "stop") failures.push("parent question did not finish with stop");
  return failures;
}

export function dialogueFailures(evidence, { modelSpec, parentThinking, thinking }) {
  const { first, calls, runStates, stats, final } = evidence;
  const failures = questionFailures(first);
  const question = first.runStates[0];
  const needsAnswer = question?.status === "needs_input";
  const expectedTool = needsAnswer ? "agent_answer" : "agent_run";
  // The original Run is authoritative. A later syntactically valid projection
  // must never replace its token, even after a correct full question was read.
  const token = isQuestionReference(question?.question_id) ? question.question_id : undefined;
  if (needsAnswer && hasInconsistentReference(calls, question) && !failures.includes(inconsistentReference)) {
    failures.push(inconsistentReference);
  }
  const answerRun = question && runStates.find((run) => run.name === question.name && run.run_id !== question.run_id &&
    run.task === question.task + 1);
  const answerIndex = calls.findIndex((call) => call.name === expectedTool && call.is_error === false &&
    call.args?.agent === question?.name && (needsAnswer ? call.args.question_id === token && token !== undefined : true) &&
    call.value?.action?.type === expectedTool && call.value.action.agent === question?.name &&
    call.value.action.task === answerRun?.task);
  const acceptedAnswer = answerIndex >= 0 && answerRun;
  if (runStates.length !== 2 || !acceptedAnswer || answerRun.status !== "completed" || !answerRun.execution_exited) {
    failures.push("user answer did not complete a second task on the same Agent");
  }
  if (answerRun && JSON.stringify(answerRun.effective_settings) !== JSON.stringify(question.effective_settings)) {
    failures.push("reused Agent settings changed");
  }
  if (!acceptedAnswer || !retrievedOutput(calls.slice(answerIndex), answerRun) || !final?.trim()) failures.push("parent did not retrieve and report the answer task's output");
  if (evidence.stop_reason !== "stop") failures.push("parent answer did not finish with stop");
  if (runStates.some((run) => !run.execution_exited || run.outcome?.limit_reached ||
      `${run.effective_settings.provider}/${run.effective_settings.model}` !== modelSpec ||
      run.effective_settings.parent_thinking !== parentThinking || run.effective_settings.thinking !== thinking ||
      run.effective_settings.thinking_resolution !== "identity")) {
    failures.push("task execution/budget/model scope was not satisfied");
  }
  // An idle reusable Agent is expected, not a leak. Host shutdown owns disposal;
  // requiring the model to kill it would add another task.
  if (stats.active || stats.queued || stats.finalizing || stats.cleaning || stats.cleanup_uncertain || stats.parent_error || stats.internal_error) {
    failures.push("active work or uncertain ownership remained before host cleanup");
  }
  return failures;
}
