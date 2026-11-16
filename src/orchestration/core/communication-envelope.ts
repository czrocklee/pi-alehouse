import type { CancellationSource, RunStatus } from "./contracts.ts";
import type { QuestionId } from "./question-id.ts";
import { encodeResultCursor } from "./result-cursor.ts";
import type { TaskMetadata } from "./task-metadata.ts";

/** Fixed model-facing bounds, not limits on a general-purpose OwnerController. */
export const COMMUNICATION_LIMITS = Object.freeze({
  agents: 16,
  finished: 8,
  text_units: 16384,
  envelope_bytes: 65536,
  agent_name_units: 24, // Existing [a-z][a-z0-9-]* name alphabet needs no escaping.
  label_units: 120,
  child_text_units: 8192,
  agent_alerts: 16, // Across all of an Agent's Runs in the same Owner FIFO.
  owner_alerts: 64, // Child-origin allowance only.
  owner_feedback_alerts: 16,
  agent_feedback_alerts: 1,
  pending_alerts: 80, // One physical FIFO: 64 child + 16 Owner feedback entries.
});

export const MODEL_AGENT_NAME_PATTERN = "^[a-z][a-z0-9-]{0,23}$";
const modelAgentName = new RegExp(MODEL_AGENT_NAME_PATTERN);
/** Shared model projection/admission rule, not the generic core name contract. */
export const isModelAgentName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= COMMUNICATION_LIMITS.agent_name_units &&
  modelAgentName.exec(value)?.[0] === value;
/** A taken name is often the caller's own repeated spawn: check before spawning
 * the same work twice. Otherwise it still wants a NEW Agent; never redirect it to reuse. */
export const AGENT_EXISTS_RESOLUTION =
  "This name is taken; check agent_list, it may be your own earlier spawn of this task. Names are never reused, even after agent_kill: for a new Agent, choose another name.";

export type TaskStatus =
  | "queued"
  | "running"
  | "interrupting"
  | "finishing"
  | "completed"
  | "needs_input"
  | "failed"
  | "interrupted";
/** Why a queued task has not started. Not a provider id, model, or queue depth. */
export type QueueWait = "dependencies" | "provider_capacity";
/** Host RunView.queued_for value to the model's self-describing one. */
export const modelQueueWait = (value: unknown): QueueWait | undefined =>
  value === "dependencies" ? value : value === "capacity" ? "provider_capacity" : undefined;
export const isQueueWait = (value: unknown): value is QueueWait =>
  value === "dependencies" || value === "provider_capacity";
/** The reply explains the gate itself; fixed text, so its bytes are bounded. */
export const DELEGATION_OFF =
  "Ask the user to enable delegation before new work, steering or answers; accepted work continues.";
/** Parent vocabulary only; retained Run statuses stay unchanged. Finalizing
 * projections add `finishing` separately, based on confirmed execution exit. */
export const modelTaskStatus = (status: RunStatus): Exclude<TaskStatus, "finishing"> =>
  status === "cancelled" ? "interrupted" : status === "cancelling" ? "interrupting" : status;
/** Single runtime source of the current core outcome-reason vocabulary. The
 * projected type, the admission predicate, the mapper and the conservative
 * fixture's longest value all derive from this one tuple, so a new reason can
 * never silently invalidate the proved byte bound. A raw historical reason
 * never resurrects a retired decoder or record schema. */
const CORE_OUTCOME_REASONS = [
  "turn_limit",
  "output_limit",
  "context_change_failed",
  "dependency_not_completed",
  "dependency_input_missing",
  "dispatch_preflight_failed",
  "unexpected_abort",
  "execution_error",
  "finalization_failed",
  "input_not_observed",
] as const;
export type OutcomeReason = (typeof CORE_OUTCOME_REASONS)[number] | "other";
const MODEL_OUTCOME_REASONS: ReadonlySet<string> = new Set<string>([
  ...CORE_OUTCOME_REASONS,
  "other",
]);
/** Bounded admission predicate for the projected vocabulary, including the
 * `other` bucket; raw historical reason strings are not members. */
export const isOutcomeReason = (value: unknown): value is OutcomeReason =>
  typeof value === "string" && MODEL_OUTCOME_REASONS.has(value);
/** Shared projection/admission rule for terminal outcome reasons, reused by
 * parent list/interrupt projections. Not a historical-reason decoder: any
 * other nonempty reason projects to `other`, and absent/empty/non-string
 * values project to no fact. */
export const modelOutcomeReason = (value: unknown): OutcomeReason | undefined =>
  typeof value !== "string" || !value ? undefined : isOutcomeReason(value) ? value : "other";
/** Longest current vocabulary value, derived so a longer future reason grows
 * the conservative proof and fails its exact byte assertions instead of
 * silently under-reserving the envelope. */
const LONGEST_OUTCOME_REASON = CORE_OUTCOME_REASONS.reduce((longest, reason) =>
  reason.length > longest.length ? reason : longest,
);
export type CommunicationReason =
  | "snapshot"
  | "aborted"
  | "owner_blocked"
  | "question"
  | "task_issue"
  | "done"
  | "alert"
  | "nothing_pending"
  | "timeout";

/** Dispatch notes the parent can act on: raw tree_shared means another session
 * holds the declared build tree. The public model wording is build_dir_shared;
 * the private Run vocabulary and its runtime producer keep tree_shared, and
 * unknown notes are omitted exactly as before. Lock and source-capture
 * uncertainty stay host diagnostics on the Run. Each final serializer filters
 * and maps before fitting, so a hidden note never spends envelope bytes or
 * sets response_limit_reached. */
const MODEL_DISPATCH_NOTES: ReadonlySet<string> = new Set(["tree_shared"]);
const MODEL_DISPATCH_NOTE_WORDING: Readonly<Record<string, string>> = {
  tree_shared: "build_dir_shared",
};
export const modelDispatchNotes = (notes: readonly string[] | undefined): string[] | undefined => {
  const shown = notes
    ?.filter((note) => MODEL_DISPATCH_NOTES.has(note))
    .map((note) => MODEL_DISPATCH_NOTE_WORDING[note]!);
  return shown?.length ? shown : undefined;
};

/** Required retained facts. No diagnostics or arbitrary strings may be added here.
 * agent matches ^[a-z][a-z0-9-]{0,23}$; task is a positive safe integer. */
export interface ThinTaskEntry {
  readonly agent: string;
  readonly task: number;
  readonly status: TaskStatus;
  /** Queued rows only. Mandatory when set: packing must not yield it. */
  readonly queued_for?: QueueWait;
  /** True settled terminal rows only; never with queued_for or a nonterminal
   * status. Required when the authoritative settled Run carries a nonempty
   * outcome reason; packing reserves it and can never yield it. */
  readonly outcome_reason?: OutcomeReason;
  readonly has_question?: true;
  readonly limit_reached?: true;
  readonly unavailable?: true;
  readonly question_truncated?: true;
  /** The shown result is incomplete and has no cursor: a live preview. A final
   * result with more to read carries next_cursor instead. */
  readonly result_truncated?: true;
}

/** Optional text/metadata can yield to the retained control layer when packing. */
export interface TaskEntry extends ThinTaskEntry, Partial<TaskMetadata> {
  /** Explicit human Stop provenance in its fixed public wording; the private
   * capture and core domain keep cancellation_source. Optional metadata may
   * yield at saturation. */
  readonly interrupted_by?: CancellationSource;
  /** The user messaged this task directly, so its result may deliberately differ
   * from the brief. Admission only; optional metadata may yield at saturation. */
  readonly human_steered?: true;
  /** Whole bounded notes (at most two, each 1..120 nonblank UTF-16 units).
   * Optional diagnostics yield to retained controls/body; no recovery promise. */
  readonly dispatch_notes?: readonly string[];
  readonly question_id?: QuestionId;
  readonly question?: string;
  readonly result?: string;
  readonly next_cursor?: string;
  readonly lost_chars?: number; // Text never retained, not text displaced by packing.
  readonly error?: string;
  readonly owner_error?: string;
  readonly unavailable_reason?: string;
}

export type CommunicationAction =
  | {
      readonly type: "agent_spawn" | "agent_run" | "agent_answer";
      readonly agent: string;
      readonly task: number;
    }
  | {
      readonly type: "agent_send";
      readonly agent: string;
      readonly task: number;
      readonly delivery: "joined" | "steered" | "not_delivered";
    };

export interface AlertEntry {
  readonly agent: string;
  readonly task: number;
  readonly label: string; // At most 120 UTF-16 units, outside the text budget.
  readonly message: string; // 1..8192 non-whitespace UTF-16 units, always shown whole.
  /** Absent on child-authored text, even if it imitates Owner feedback. */
  readonly source?: "managed";
}
export interface FinishedEntry extends ThinTaskEntry {
  /** Optional independently of the thin row and its presentation commit. */
  readonly label?: string;
  /** May yield independently of the finished row and its presentation commit.
   * Fixed public wording; the private capture keeps cancellation_source. */
  readonly interrupted_by?: CancellationSource;
  readonly human_steered?: true;
}

/** Projection only; these arrays must never become another persistent registry.
 * Counts are safe integers, emitted only when positive. Arrays are bounded by COMMUNICATION_LIMITS. */
export interface RetainedEnvelope {
  readonly action?: CommunicationAction;
  readonly reason: CommunicationReason;
  readonly delegation_off?: typeof DELEGATION_OFF;
  readonly tasks: readonly ThinTaskEntry[];
  readonly alerts?: readonly AlertEntry[];
  readonly alerts_pending?: number;
  readonly finished_pending?: number;
  readonly response_limit_reached?: true;
}

export interface CommunicationEnvelope extends RetainedEnvelope {
  readonly tasks: readonly TaskEntry[];
  readonly finished?: readonly FinishedEntry[];
}

/** Exact UTF-8 size of {content:[{type:"text",text:JSON.stringify(value)}]}.
 * Both JSON layers count; usage and any later SDK metadata do not. Serialization
 * failures propagate, so a caller must check before any publication commit. */
export function communicationEnvelopeBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined)
    throw new TypeError("Communication envelope must have a JSON representation");
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] }), "utf8");
}

/** Only question, result and alert.message spend the body budget. */
export function communicationTextUnits(value: CommunicationEnvelope): number {
  return (
    value.tasks.reduce(
      (sum, row) => sum + (row.question?.length ?? 0) + (row.result?.length ?? 0),
      0,
    ) + (value.alerts ?? []).reduce((sum, alert) => sum + alert.message.length, 0)
  );
}

export interface CommunicationBudget {
  readonly text_units: number;
  readonly envelope_bytes: number;
  readonly fits: boolean;
}

/** Budget/array-cap check, not a schema validator or packer. Callers provide
 * ordinary typed projection data with bounded names, labels, tokens and scalars.
 * In particular, it never silently truncates rows, fields, or alert bodies. */
export function communicationBudget(value: CommunicationEnvelope): CommunicationBudget {
  const text_units = communicationTextUnits(value);
  const envelope_bytes = communicationEnvelopeBytes(value);
  return {
    text_units,
    envelope_bytes,
    fits:
      text_units <= COMMUNICATION_LIMITS.text_units &&
      envelope_bytes <= COMMUNICATION_LIMITS.envelope_bytes &&
      value.tasks.length <= COMMUNICATION_LIMITS.agents &&
      (value.finished?.length ?? 0) <= COMMUNICATION_LIMITS.finished &&
      (value.alerts?.length ?? 0) <= COMMUNICATION_LIMITS.pending_alerts,
  };
}

/** Intentionally impossible action combines the longest verb with delivery.
 * This conservative fixture is NOT a valid action for actual tool replies.
 * Optional question IDs provide a separate, stronger metadata bound. */
export interface RetainedEnvelopeBound extends Omit<RetainedEnvelope, "action" | "tasks"> {
  readonly action: {
    readonly type: "agent_answer";
    readonly agent: string;
    readonly task: number;
    readonly delivery: "not_delivered";
  };
  readonly tasks: readonly (ThinTaskEntry & {
    readonly outcome_reason: OutcomeReason;
    readonly question_id?: QuestionId;
    readonly question?: string;
    readonly next_cursor?: string;
  })[];
}

/** Fresh pure proof data, with one complete alert and every bounded control
 * at its maximum, including the fixed feedback source tag even for a worst-escaped
 * child-sized body. Five flags coexist conservatively with the longest outcome
 * reason (derived from the single vocabulary tuple) on the longest terminal
 * status; that pairing is a byte ceiling, not a
 * legal packed row. This terminal outcome shape is also the ceiling for the
 * nonterminal scheduling shape: a maximal row's outcome_reason (49 double-JSON
 * bytes) exceeds its queued_for (37) plus the 1-byte longer nonterminal status,
 * so queued_for never coexists here with a terminal cause. No stored Owner/Run state.
 * The bound excludes any redundant pending-name array. Every reply
 * carries a reason; this fixture reserves the longest one. Including
 * all question IDs/cursors/empty question fields and an 8192-NUL alert costs
 * 65067 double-JSON bytes (469 spare).
 * The proof depends on these exact keys and bounds, not arbitrary JSON data. */
export function retainedEnvelopeFixture(
  message: string,
  withQuestionIds = false,
  withResultCursors = false,
): RetainedEnvelopeBound {
  const name = "a".repeat(COMMUNICATION_LIMITS.agent_name_units);
  const max = Number.MAX_SAFE_INTEGER;
  return {
    reason: "nothing_pending",
    action: { type: "agent_answer", agent: name, task: max, delivery: "not_delivered" },
    tasks: Array.from({ length: COMMUNICATION_LIMITS.agents }, () => ({
      agent: name,
      task: max,
      status: "interrupted",
      outcome_reason: LONGEST_OUTCOME_REASON,
      has_question: true,
      limit_reached: true,
      unavailable: true,
      question_truncated: true,
      result_truncated: true,
      ...(withQuestionIds ? { question_id: `q_${"f".repeat(32)}` } : {}),
      ...(withResultCursors
        ? {
            next_cursor: encodeResultCursor(
              { owner: "owner", generation: "generation", run: "run", version: "version" },
              max,
            ),
            ...(withQuestionIds ? { question: "" } : {}),
          }
        : {}),
    })),
    alerts: [
      {
        agent: name,
        task: max,
        label: "\u0000".repeat(COMMUNICATION_LIMITS.label_units),
        message,
        source: "managed",
      },
    ],
    delegation_off: DELEGATION_OFF,
    alerts_pending: max,
    finished_pending: max,
    response_limit_reached: true,
  };
}

/** Enqueue size admission uses the entire worst-case retained shape, including
 * question IDs, empty question fields and fixed-width result cursors, not
 * message-only JSON. Whole omitted results remain historically addressable. Callers still validate nonblank
 * text, source Run/generation/gate, and Owner-first/Agent-second FIFO quotas.
 * A false size admission can be mapped to ALERT_TOO_LARGE without enqueuing.
 * This helper does not allocate a queue, cache counts, or claim delivery. */
export function alertAdmissionBudget(message: string): CommunicationBudget {
  const text_units = message.length;
  const envelope_bytes = communicationEnvelopeBytes(retainedEnvelopeFixture(message, true, true));
  return {
    text_units,
    envelope_bytes,
    fits:
      text_units >= 1 &&
      text_units <= COMMUNICATION_LIMITS.child_text_units &&
      text_units <= COMMUNICATION_LIMITS.text_units &&
      envelope_bytes <= COMMUNICATION_LIMITS.envelope_bytes,
  };
}
