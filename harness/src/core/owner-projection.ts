import { modelTaskStatus, type ThinTaskEntry } from "./communication-envelope.ts";
import type { TaskSnapshot } from "./communication-snapshot.ts";
import { isSettledRecord, type CommunicationAgent } from "./communication-state.ts";
import { terminal, type RunView } from "./contracts.ts";
import { taskMetadata } from "./task-metadata.ts";

/** Read-only structural inputs, not another Run store. The Owner resolves
 * originals, health, queue occupancy, lease and clocks before calling these
 * projections. No ports, lifecycle transitions or retained caches live here. */
type TaskRecord = Pick<
  RunView,
  | "run_id"
  | "name"
  | "description"
  | "status"
  | "phase"
  | "execution_exited"
  | "outcome"
  | "dispatch_notes"
  | "cancellation_source"
> & { readonly limit_reached: boolean };
interface TaskSource {
  readonly record: TaskRecord;
  readonly question?: string;
  readonly quarantine?: string;
}
interface ViewSource {
  readonly record: Pick<
    RunView,
    | "owner_id"
    | "generation"
    | "run_id"
    | "agent_id"
    | "name"
    | "description"
    | "return_to_run_id"
    | "status"
    | "phase"
    | "execution_exited"
    | "history_ref"
    | "history_error"
    | "turns"
    | "max_turns"
    | "stop_reason"
    | "model_stop_reason"
    | "outcome"
    | "cancellation_source"
    | "usage"
    | "cleanup_errors"
    | "discarded_inputs"
    | "dispatch"
    | "dispatch_notes"
    | "after"
    | "delivered_updates"
  > & { readonly result?: RunView["result_ref"] };
  readonly effectiveSettings: RunView["effective_settings"];
  readonly runtime?: RunView["runtime"];
}
/** Only already-derived view facts, never a generic Owner/private-state context. */
type RunProjectionFacts = Pick<
  RunView,
  | "drain"
  | "resident"
  | "unavailable_reason"
  | "owner_error"
  | "owner_blocked"
  | "elapsed_ms"
  | "turn_elapsed_ms"
  | "execution_elapsed_ms"
  | "task"
  | "has_question"
  | "question_id"
  | "pending_messages"
  | "blocked_by"
  | "queued_for"
>;
export function projectRun(run: ViewSource, facts: RunProjectionFacts): RunView {
  const record = run.record;
  return structuredClone({
    owner_id: record.owner_id,
    generation: record.generation,
    run_id: record.run_id,
    agent_id: record.agent_id,
    name: record.name,
    description: record.description,
    effective_settings: run.effectiveSettings,
    ...(record.return_to_run_id ? { return_to_run_id: record.return_to_run_id } : {}),
    status: record.status,
    phase: record.phase,
    execution_exited: record.execution_exited,
    history_ref: record.history_ref,
    history_error: record.history_error,
    drain: facts.drain,
    finalization_pending: record.execution_exited && !terminal(record.status),
    resident: facts.resident,
    resumable: !facts.unavailable_reason,
    unavailable_reason: facts.unavailable_reason,
    owner_error: facts.owner_error,
    owner_blocked: facts.owner_blocked,
    elapsed_ms: facts.elapsed_ms,
    turn_elapsed_ms: facts.turn_elapsed_ms,
    turns: record.turns,
    max_turns: record.max_turns,
    execution_elapsed_ms: facts.execution_elapsed_ms,
    runtime: run.runtime,
    stop_reason: record.stop_reason,
    model_stop_reason: record.model_stop_reason,
    outcome: record.outcome,
    ...(record.cancellation_source ? { cancellation_source: record.cancellation_source } : {}),
    usage: record.usage ?? run.runtime?.usage,
    result_ref: record.result,
    cleanup_errors: record.cleanup_errors,
    discarded_inputs: record.discarded_inputs,
    ...(record.dispatch === undefined ? {} : { dispatch: record.dispatch }),
    ...(record.dispatch_notes?.length ? { dispatch_notes: record.dispatch_notes } : {}),
    task: facts.task,
    has_question: facts.has_question,
    question_id: facts.question_id,
    pending_messages: facts.pending_messages,
    ...(record.after ? { after: record.after } : {}),
    ...(facts.blocked_by?.length ? { blocked_by: facts.blocked_by } : {}),
    ...(facts.queued_for ? { queued_for: facts.queued_for } : {}),
    ...(record.delivered_updates ? { delivered_updates: record.delivered_updates } : {}),
  });
}

export function communicationRow(
  run: TaskSource,
  agent: CommunicationAgent,
  task: number,
  healthy: boolean,
  wait: ThinTaskEntry["wait"],
): ThinTaskEntry {
  const record = run.record;
  const unavailable =
    !healthy || !agent.resident || !!agent.unavailable || !!agent.exiting || !!run.quarantine;
  return {
    agent: record.name,
    task,
    ...(wait ? { wait } : {}),
    status:
      record.execution_exited && !terminal(record.status)
        ? "finishing"
        : modelTaskStatus(record.status),
    ...(agent.question?.run_id === record.run_id ? { has_question: true } : {}),
    ...(record.limit_reached ? { limit_reached: true } : {}),
    ...(unavailable ? { unavailable: true } : {}),
  };
}

type TaskProjectionFacts = Pick<
  TaskSnapshot,
  "row" | "question_id" | "result" | "result_notice" | "diagnostics"
>;
export function communicationTask(
  run: TaskSource,
  historical: boolean,
  facts: TaskProjectionFacts,
): TaskSnapshot {
  const settled = isSettledRecord(run.record);
  // Keep host diagnostics in the private capture; only the final packer owns
  // the model-visible note allowlist and reply budget.
  const dispatch_notes = run.record.dispatch_notes?.slice();
  return {
    row: facts.row,
    settled,
    ...taskMetadata(run.record),
    ...(facts.question_id ? { question_id: facts.question_id } : {}),
    ...(run.question !== undefined && (historical || settled) ? { question: run.question } : {}),
    ...(facts.result_notice === undefined
      ? { result: facts.result }
      : { result_notice: facts.result_notice }),
    ...(dispatch_notes ? { dispatch_notes } : {}),
    ...(run.record.cancellation_source
      ? { cancellation_source: run.record.cancellation_source }
      : {}),
    diagnostics: facts.diagnostics,
  };
}

/** Caller resolves the sticky exact continuation, never an Agent's latest Run.
 * Input entry is permanent delivery evidence, even after later failure/kill.
 * `omitted` counts retained source characters the delivered handoff left out.
 * readable: an explicit read returns the retained result, because the worker
 * never received it or the bounded handoff omitted retained text. */
export function returnToNotice(
  source: string,
  continuation: Pick<RunView, "name" | "execution_exited" | "status"> & {
    readonly input_entered: boolean;
  },
  task: number,
  sourceTask: number,
  omitted: number,
): { text: string; readable: boolean } {
  const destination = `${continuation.name} (task ${task})`,
    read = `agent_read ${source} task ${sourceTask}`;
  if (continuation.input_entered)
    return omitted > 0
      ? {
          readable: true,
          text: `Result from ${source} has been returned to ${destination}, but the handoff omitted its last ${omitted} retained characters; ${read} shows the full result.`,
        }
      : { readable: false, text: `Result from ${source} has been returned to ${destination}.` };
  if (continuation.execution_exited || terminal(continuation.status))
    return {
      readable: true,
      text: `Result from ${source} was not returned to ${destination}: the worker continuation ended before receiving input; ${read} shows the result.`,
    };
  return {
    readable: false,
    text: `Result from ${source} is assigned to ${destination}; handoff is pending.`,
  };
}
