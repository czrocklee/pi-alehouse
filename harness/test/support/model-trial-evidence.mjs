// Structural dialogue checks only. Natural-language correctness is reviewed
// from the saved replies, not inferred from a number appearing in free text.
export const messageText = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

export function parentRoundEvidence(messages, start) {
  if (!Number.isInteger(start) || start < 0 || start > messages.length) throw new Error("INVALID_PARENT_ROUND_START");
  const last = messages.slice(start).findLast((message) => message.role === "assistant");
  return { final: messageText(last), stop_reason: last?.stopReason, error_message: last?.errorMessage };
}

// Replies name the Agent, never a task ID, so each reply is attributed to the
// Agent's task that was current when it was produced: callers pass only calls
// made after that task started. Wait projections always start at offset zero,
// including the one agent_spawn, agent_run or agent_send returns with wait_ms.
const projections = (call, { paged = false } = {}) => {
  if (call.is_error !== false) return [];
  if (call.name === "agent_wait") return call.value?.agents ?? [];
  if (["agent_spawn", "agent_run", "agent_send"].includes(call.name)) return call.args?.wait_ms > 0 ? [call.value] : [];
  if (call.name === "agent_read") return paged || call.args?.cursor === undefined ? [call.value] : [];
  return [];
};

function retrievedOutput(calls, run) {
  // This short task requires one whole terminal reply, not a pagination audit.
  // A read with an input cursor is only a later page, never proof of the whole.
  const whole = (value) => value?.agent === run.name && value.status === "completed" && value.result?.trim() &&
    value.next_cursor === undefined && !value.omitted_chars && !value.result_omitted;
  return run && calls.some((call) => projections(call).some(whole));
}

function retrievedQuestion(calls, run) {
  const whole = (value) => value?.agent === run.name && value.question === run.outcome.question && !value.question_truncated;
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
  // A send that answers the same Agent's question starts the answer task.
  const answerIndex = calls.findIndex((call) => call.name === "agent_send" && call.is_error === false &&
    call.args?.agent === question?.name && call.value?.delivery === "answered" && call.value?.agent === question?.name);
  const answerRun = answerIndex >= 0 && runStates.find((run) => run.name === question.name && run.run_id !== question.run_id);
  if (runStates.length !== 2 || answerRun?.status !== "completed" || !answerRun.execution_exited) {
    failures.push("user answer did not complete a second task on the same Agent");
  }
  if (answerRun && JSON.stringify(answerRun.effective_settings) !== JSON.stringify(question.effective_settings)) {
    failures.push("reused Agent settings changed");
  }
  if (!answerRun || !retrievedOutput(calls.slice(answerIndex), answerRun) || !final?.trim()) failures.push("parent did not retrieve and report the answer task's output");
  if (evidence.stop_reason !== "stop") failures.push("parent answer did not finish with stop");
  if (runStates.some((run) => !run.execution_exited || run.outcome?.limit_reached ||
      `${run.effective_settings.provider}/${run.effective_settings.model}` !== modelSpec ||
      run.effective_settings.parent_thinking !== parentThinking || run.effective_settings.thinking !== thinking ||
      run.effective_settings.thinking_resolution !== "identity")) {
    failures.push("task execution/budget/model scope was not satisfied");
  }
  // An idle reusable Agent is expected here, not a leak. Host shutdown owns its
  // final disposal; requiring the model to release it would add another task.
  if (stats.active || stats.queued || stats.finalizing || stats.cleaning || stats.cleanup_uncertain || stats.parent_error || stats.internal_error) {
    failures.push("active work or uncertain ownership remained before host cleanup");
  }
  return failures;
}
