import type { QuestionId } from "./question-id.js";
import { encodeResultCursor } from "./result-cursor.js";

/** Fixed model-facing bounds, not limits on a general-purpose OwnerController. */
export const COMMUNICATION_LIMITS = Object.freeze({
  agents: 16,
  pending: 16,
  finished: 8,
  text_units: 16384,
  envelope_bytes: 65536,
  agent_name_units: 24, // Existing [a-z][a-z0-9-]* name alphabet needs no escaping.
  label_units: 120,
  child_text_units: 8192,
  agent_alerts: 16, // Across all of an Agent's Runs in the same Owner FIFO.
  owner_alerts: 64,
});

export const MODEL_AGENT_NAME_PATTERN = "^[a-z][a-z0-9-]{0,23}$";
const modelAgentName = new RegExp(MODEL_AGENT_NAME_PATTERN);
/** Shared model projection/admission rule, not the generic core name contract. */
export const isModelAgentName = (value: unknown): value is string => typeof value === "string" &&
  value.length <= COMMUNICATION_LIMITS.agent_name_units && modelAgentName.exec(value)?.[0] === value;

export type TaskStatus = "queued" | "running" | "interrupting" | "finishing" |
  "completed" | "needs_input" | "failed" | "interrupted";
export type CommunicationReason = "snapshot" | "aborted" | "owner_blocked" | "question" |
  "task_issue" | "done" | "alert" | "nothing_pending" | "timeout";

/** Required retained facts. No diagnostics or arbitrary strings may be added here.
 * agent matches ^[a-z][a-z0-9-]{0,23}$; task is a positive safe integer. */
export interface ThinTaskEntry {
  readonly agent: string;
  readonly task: number;
  readonly status: TaskStatus;
  readonly has_question?: true;
  readonly limit_reached?: true;
  readonly unavailable?: true;
  readonly question_truncated?: true;
  readonly result_omitted?: true;
  readonly result_truncated?: true;
}

/** Optional text/metadata can yield to the retained control layer when packing. */
export interface TaskEntry extends ThinTaskEntry {
  /** Whole bounded notes (at most two, each 1..120 nonblank UTF-16 units).
   * Optional diagnostics yield to retained controls/body; no recovery promise. */
  readonly dispatch_notes?: readonly string[];
  /** Warning was attempted, not proof of delivery or a checkpoint. */
  readonly time_wrapped?: true;
  readonly question_id?: QuestionId;
  readonly question?: string;
  readonly result?: string;
  readonly next_cursor?: string;
  readonly omitted_chars?: number; // Text never retained, not text displaced by packing.
  readonly error?: string;
  readonly owner_error?: string;
  readonly unavailable_reason?: string;
}

export type CommunicationAction = {
  readonly type: "agent_spawn" | "agent_run" | "agent_answer";
  readonly agent: string;
  readonly task: number;
} | {
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
}
export type FinishedEntry = ThinTaskEntry;

/** Projection only; these arrays must never become another persistent registry.
 * Counts are nonnegative safe integers. Arrays are bounded by COMMUNICATION_LIMITS. */
export interface RetainedEnvelope {
  readonly action?: CommunicationAction;
  readonly reason: CommunicationReason;
  readonly workers_disabled?: true;
  readonly agents: readonly ThinTaskEntry[];
  readonly alerts?: readonly AlertEntry[];
  readonly alerts_pending: number;
  readonly pending?: readonly string[];
  readonly finished_pending?: number;
  readonly response_limit_reached?: true;
}

export interface CommunicationEnvelope extends RetainedEnvelope {
  readonly agents: readonly TaskEntry[];
  readonly finished?: readonly FinishedEntry[];
}

/** Exact UTF-8 size of {content:[{type:"text",text:JSON.stringify(value)}]}.
 * Both JSON layers count; usage and any later SDK metadata do not. Serialization
 * failures propagate, so a caller must check before any publication commit. */
export function communicationEnvelopeBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("Communication envelope must have a JSON representation");
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] }), "utf8");
}

/** Only question, result and alert.message spend the UTF-16 body budget. */
export function communicationTextUnits(value: CommunicationEnvelope): number {
  return value.agents.reduce((sum, row) => sum + (row.question?.length ?? 0) + (row.result?.length ?? 0), 0) +
    (value.alerts ?? []).reduce((sum, alert) => sum + alert.message.length, 0);
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
  return { text_units, envelope_bytes,
    fits: text_units <= COMMUNICATION_LIMITS.text_units && envelope_bytes <= COMMUNICATION_LIMITS.envelope_bytes &&
      value.agents.length <= COMMUNICATION_LIMITS.agents && (value.pending?.length ?? 0) <= COMMUNICATION_LIMITS.pending &&
      (value.finished?.length ?? 0) <= COMMUNICATION_LIMITS.finished &&
      (value.alerts?.length ?? 0) <= COMMUNICATION_LIMITS.owner_alerts };
}

/** Intentionally impossible action combines the longest verb with delivery.
 * This conservative fixture is NOT a valid action for actual tool replies.
 * Optional question IDs provide a separate, stronger metadata bound. */
export interface RetainedEnvelopeBound extends Omit<RetainedEnvelope, "action" | "agents"> {
  readonly action: {
    readonly type: "agent_answer";
    readonly agent: string;
    readonly task: number;
    readonly delivery: "not_delivered";
  };
  readonly agents: readonly (ThinTaskEntry & { readonly question_id?: QuestionId; readonly question?: string; readonly next_cursor?: string })[];
}

/** Fresh pure proof data, with one complete alert and every bounded control
 * at its maximum. Six flags coexist conservatively; no stored Owner/Run state.
 * The proof depends on these exact keys and bounds, not arbitrary JSON data. */
export function retainedEnvelopeFixture(message: string, withQuestionIds = false, withResultCursors = false): RetainedEnvelopeBound {
  const name = "a".repeat(COMMUNICATION_LIMITS.agent_name_units);
  const max = Number.MAX_SAFE_INTEGER;
  return {
    reason: "nothing_pending",
    action: { type: "agent_answer", agent: name, task: max, delivery: "not_delivered" },
    agents: Array.from({ length: COMMUNICATION_LIMITS.agents }, () => ({
      agent: name, task: max, status: "interrupting",
      has_question: true, limit_reached: true, unavailable: true,
      question_truncated: true, result_omitted: true, result_truncated: true,
      ...(withQuestionIds ? { question_id: `q_${"f".repeat(32)}` } : {}),
      ...(withResultCursors ? { next_cursor: encodeResultCursor({ owner: "owner", generation: "generation", run: "run", version: "version" }, max),
        ...(withQuestionIds ? { question: "" } : {}) } : {}),
    })),
    alerts: [{ agent: name, task: max, label: "\u0000".repeat(COMMUNICATION_LIMITS.label_units), message }],
    pending: Array.from({ length: COMMUNICATION_LIMITS.pending }, () => name),
    workers_disabled: true,
    alerts_pending: max,
    finished_pending: max,
    response_limit_reached: true,
  };
}

/** Enqueue size admission uses the entire worst-case retained shape, including
 * 16 question IDs, empty question fields and fixed-width result cursors, not
 * message-only JSON. Whole omitted results remain historically addressable. Callers still validate nonblank
 * text, source Run/generation/gate, and Owner-first/Agent-second FIFO quotas.
 * A false size admission can be mapped to ALERT_TOO_LARGE without enqueuing.
 * This helper does not allocate a queue, cache counts, or claim delivery. */
export function alertAdmissionBudget(message: string): CommunicationBudget {
  const text_units = message.length;
  const envelope_bytes = communicationEnvelopeBytes(retainedEnvelopeFixture(message, true, true));
  return { text_units, envelope_bytes,
    fits: text_units >= 1 && text_units <= COMMUNICATION_LIMITS.child_text_units &&
      text_units <= COMMUNICATION_LIMITS.text_units && envelope_bytes <= COMMUNICATION_LIMITS.envelope_bytes };
}
