// Structural dialogue checks only. Natural-language correctness is reviewed
// from the saved replies, not inferred from a number appearing in free text.
export const messageText = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

export function parentRoundEvidence(messages, start) {
  if (!Number.isInteger(start) || start < 0 || start > messages.length) throw new Error("INVALID_PARENT_ROUND_START");
  const last = messages.slice(start).findLast((message) => message.role === "assistant");
  return { final: messageText(last), stop_reason: last?.stopReason, error_message: last?.errorMessage };
}

const waitPayload = (call) => call.name === "wait_runs" ? call.value :
  (["spawn_agent", "resume_agent"].includes(call.name) && call.args?.wait_ms > 0 ? call.value?.wait : undefined);

function retrievedOutput(calls, run) {
  // This short task requires one whole terminal reply, not a pagination audit.
  // complete also labels a last page, so a get with an input cursor cannot prove
  // the parent retrieved the whole answer. Wait projections always start at zero,
  // including the optional wait nested under an accepted create/resume reply.
  const whole = (value) => value?.run_id === run.run_id && value.status === "completed" &&
    value.complete === true && value.next_cursor === undefined && value.omitted_chars === 0 && value.text?.trim();
  return run && calls.some((call) => call.is_error === false &&
    ((call.name === "read_run" && call.args?.cursor === undefined && whole(call.value)) ||
     waitPayload(call)?.runs?.some(whole)));
}

function retrievedQuestion(calls, run) {
  const whole = (value) => value?.run_id === run.run_id && value.question === run.outcome.question &&
    value.question_complete === true && value.question_omitted_chars === 0;
  return calls.some((call) => call.is_error === false &&
    ((call.name === "read_run" && whole(call.value)) || waitPayload(call)?.runs?.some(whole)));
}

export function questionFailures({ calls, runStates, childCalls, final, stop_reason }) {
  const failures = [];
  const question = runStates.length === 1 && runStates[0];
  if (!question || !["needs_input", "completed"].includes(question.status) || !question.execution_exited) {
    failures.push("one delegated Run must settle before the user supplies the missing factor");
  }
  if (question?.status === "needs_input") {
    if (!question.outcome?.question || !retrievedQuestion(calls, question)) {
      failures.push("parent did not retrieve that Run's complete question");
    }
  } else if (!retrievedOutput(calls, question)) {
    failures.push("parent did not retrieve the first Run's output before asking the user");
  }
  if (!childCalls.some((call) => call.run_id === question?.run_id && call.fixture_match === "source.txt")) {
    failures.push("question Run did not read the synthetic source through SDK read");
  }
  if (!final?.trim()) failures.push("parent did not return a question to the user");
  if (stop_reason !== "stop") failures.push("parent question did not finish with stop");
  return failures;
}

export function dialogueFailures(evidence, { modelSpec, parentThinking, thinking }) {
  const { first, calls, runStates, stats, final } = evidence;
  const failures = questionFailures(first);
  const question = first.runStates[0];
  const answer = calls.find((call) => call.name === "resume_agent" && call.is_error === false &&
    call.args?.agent_id === question?.agent_id &&
    (question?.status !== "needs_input" || call.args?.answer_to_run_id === question.run_id) &&
    call.value?.agent_id === question?.agent_id && call.value?.run_id !== question?.run_id);
  const answerRun = answer && runStates.find((run) => run.run_id === answer.value.run_id);
  if (runStates.length !== 2 || answerRun?.status !== "completed" || !answerRun.execution_exited) {
    failures.push("user answer did not complete a second Run on the same Agent (answer_to_run_id is required for needs_input)");
  }
  if (answerRun && JSON.stringify(answerRun.effective_settings) !== JSON.stringify(question.effective_settings)) {
    failures.push("reused Agent settings changed");
  }
  if (!retrievedOutput(calls, answerRun) || !final?.trim()) failures.push("parent did not retrieve and report the answer Run's output");
  if (evidence.stop_reason !== "stop") failures.push("parent answer did not finish with stop");
  if (runStates.some((run) => !run.execution_exited || run.outcome?.limit_reached ||
      `${run.effective_settings.provider}/${run.effective_settings.model}` !== modelSpec ||
      run.effective_settings.parent_thinking !== parentThinking || run.effective_settings.thinking !== thinking ||
      run.effective_settings.thinking_resolution !== "identity")) {
    failures.push("Run execution/budget/model scope was not satisfied");
  }
  // An idle reusable Agent is expected here, not a leak. Host shutdown owns its
  // final disposal; requiring the model to release it would add another task.
  if (stats.active || stats.queued || stats.finalizing || stats.cleaning || stats.cleanup_uncertain || stats.parent_error || stats.internal_error) {
    failures.push("active work or uncertain ownership remained before host cleanup");
  }
  return failures;
}
