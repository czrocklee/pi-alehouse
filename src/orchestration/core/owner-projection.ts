import {
  modelOutcomeReason,
  modelTaskStatus,
  type ThinTaskEntry,
} from "./communication-envelope.ts";
import type { TaskSnapshot } from "./communication-snapshot.ts";
import { isSettledRecord, type CommunicationAgent } from "./communication-state.ts";
import { terminal, type RunView } from "./contracts.ts";
import { taskMetadata } from "./task-metadata.ts";
import { reported } from "./usage-ledger.ts";

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
  | "human_steered"
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
    | "enqueue_sequence"
    | "stop_reason"
    | "model_stop_reason"
    | "outcome"
    | "cancellation_source"
    | "human_steered"
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
const usageOf = (run: ViewSource) => run.record.usage ?? run.runtime?.usage;

/** One ephemeral, enqueue-ordered fold per Agent. A live cumulative snapshot
 * and its settled replacement represent the same Run, not two charges. */
export interface AgentRunTotals {
  task: number;
  cost?: number;
  partial: boolean;
}
export function includeRun(
  totals: AgentRunTotals,
  run: ViewSource & { readonly sessionRunAttempted?: true },
): void {
  totals.task++;
  const usage = usageOf(run);
  const cost = reported(usage, "cost");
  if (cost !== undefined) totals.cost = (totals.cost ?? 0) + cost;
  // Queueing and initialization alone don't incur Run spend. Once the session
  // has been invoked, silence isn't evidence of zero, even without inputEntered.
  totals.partial ||= usage?.partial.includes("cost") ?? !!run.sessionRunAttempted;
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
  | "agent_cost"
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
    enqueue_sequence: record.enqueue_sequence,
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
    ...(record.human_steered ? { human_steered: true as const } : {}),
    usage: usageOf(run),
    ...(facts.agent_cost ? { agent_cost: facts.agent_cost } : {}),
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
  queued_for: ThinTaskEntry["queued_for"],
): ThinTaskEntry {
  const record = run.record;
  const unavailable =
    !healthy || !agent.resident || !!agent.unavailable || !!agent.exiting || !!run.quarantine;
  // True settlement only: a finalizing Run may already hold its Outcome, but
  // its row is not terminal until the Owner installs the settled phase.
  const outcome_reason = isSettledRecord(record)
    ? modelOutcomeReason(record.outcome?.reason)
    : undefined;
  return {
    agent: record.name,
    task,
    ...(queued_for ? { queued_for } : {}),
    status:
      record.execution_exited && !terminal(record.status)
        ? "finishing"
        : modelTaskStatus(record.status),
    ...(outcome_reason ? { outcome_reason } : {}),
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
    ...(run.record.human_steered ? { human_steered: true as const } : {}),
    diagnostics: facts.diagnostics,
  };
}

/** Caller resolves the sticky exact continuation, never an Agent's latest Run.
 * Input entry is permanent delivery evidence, even after later failure/kill.
 * `omitted` counts retained source UTF-16 units the delivered handoff left out.
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
    read = `agent_read({ agent: ${JSON.stringify(source)}, task: ${sourceTask} })`;
  if (continuation.input_entered)
    return omitted > 0
      ? {
          readable: true,
          text: `Result from ${source} has been returned to ${destination}, but the handoff omitted its last ${omitted} characters; ${read} shows the retained result.`,
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
