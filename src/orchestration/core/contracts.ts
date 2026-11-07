import { isAbsolute } from "node:path";
import { normalizeLedger, type UsageLedger } from "./usage-ledger.ts";
import { validOutput } from "./result-text.ts";
import type { Dispatch } from "./dispatch.ts";

export type RunStatus =
  "queued" | "running" | "cancelling" | "completed" | "needs_input" | "failed" | "cancelled";
/** Accepted cooperative stop causes. */
export type StopReason = "user_cancel" | "hard_budget";
/** Explicit trusted-host human Stop only; absence makes no claim about origin. */
export type CancellationSource = "human";
/** Final provider/SDK assistant stop reason. */
export type ModelStopReason =
  "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "deferred" | (string & {});
export type Phase = "queued" | "initializing" | "executing" | "finalizing" | "settled";
/** Observation only: neither an exit acknowledgement nor a lifecycle phase. */
export type DrainWait = "deliveries" | "sdk_idle";

/** Parent's assessment of the initial assignment, not a per-Run resource knob. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;
/** Each reasoning rating has its own independently configured worker route. */
export const difficultySlots = Object.freeze(["d1", "d2", "d3", "d4", "d5"] as const);
export type WorkerSlot = (typeof difficultySlots)[number];
export const validDifficulty = (value: unknown): value is Difficulty =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;

/** Settings resolved by the trusted host at creation admission. */
export interface AdmittedAgentConfig {
  provider: string;
  model: string;
  thinking: string;
  /** Required for inherited effort, optional for a preset's fixed effort. */
  parent_thinking?: string;
  /** A fixed policy or the resolved inherited thinking route. */
  thinking_resolution: "identity" | "automatic_mapping" | "preset_fixed";
  /** Optional creation-time effort provenance. */
  effort_source?: "preset" | "user_override";
  profile: string;
  /** Creation-time assessment, retained unchanged on resume. */
  difficulty: Difficulty;
  /** Internal preset slot; not a model-facing choice. */
  strength: WorkerSlot;
  preset: string;
  preset_version: string;
  selection_digest: string;
  cwd: string;
  tools: string[];
  definition_digest: string;
  context_snapshot?: string;
}
/** Atomic scout creation plus continuation of one already-settled worker question. */
export interface ReturnTo {
  agent_id: string;
  question_id: string;
  answer: string;
}
export type SubmitRequest =
  | {
      prompt: string;
      description: string;
      name?: string;
      settings: AdmittedAgentConfig;
      return_to?: ReturnTo;
      max_turns?: number;
      dispatch?: Dispatch;
      after?: string[];
    }
  | {
      resume: string;
      prompt: string;
      description?: string;
      max_turns?: number;
      answer_to_run_id?: string;
      dispatch?: Dispatch;
      after?: string[];
    };
export interface Output {
  text: string;
  total_chars: number;
  truncated: boolean;
  /** Run-local assistant-message revision. */
  revision?: number;
}
/** Raw assistant text, never a cumulative string. Reset replaces the candidate;
 * append counts observed UTF-16 units even after prefix retention closes. */
export type OutputDelta =
  | { type: "reset"; revision: number; max_chars?: number }
  | { type: "append"; revision: number; text: string };
export type RunActivity = "generating" | "tool" | "compacting" | "retrying";
export interface RunTelemetry {
  activity: RunActivity;
  context?: { tokens: number | null; context_window: number };
  /** Cumulative Run snapshot, not a delta. */
  usage?: UsageLedger;
}
export interface ExecutionFacts {
  kind: "success" | "error" | "aborted";
  output: Output;
  model_stop_reason?: ModelStopReason;
  error?: string;
  usage?: UsageLedger;
}
export interface Outcome {
  status: "completed" | "needs_input" | "failed" | "cancelled";
  model_stop_reason?: ModelStopReason;
  reason?: string;
  /** First accepted cancellation, independent of finalization diagnostics. */
  cancellation_source?: CancellationSource;
  error?: string;
  question?: string;
  limit_reached: boolean;
}
export interface ResultRef {
  scope: "owner_memory";
  run_id: string;
  digest: string;
  chars: number;
  total_chars: number;
  truncated: boolean;
}
export interface RunIdentity {
  owner_id: string;
  generation: string;
  agent_id: string;
  run_id: string;
}
export interface RunExecutionIdentity extends RunIdentity {
  task_prompt: string;
}
export interface HistoryRef extends RunIdentity {
  session_id: string;
  start_entry_id: string;
  end_entry_id?: string;
}
export interface RunView {
  owner_id: string;
  generation: string;
  agent_id: string;
  run_id: string;
  name: string;
  description: string;
  /** Immutable compound linkage; internal identity, never a model address. */
  return_to_run_id?: string;
  effective_settings: Omit<AdmittedAgentConfig, "context_snapshot"> & {
    context_mode: "none" | "text_snapshot";
    context_digest?: string;
    context_bytes?: number;
  };
  status: RunStatus;
  phase: Phase;
  execution_exited: boolean;
  history_ref?: HistoryRef;
  history_error?: string;
  finalization_pending: boolean;
  resident: boolean;
  resumable: boolean;
  unavailable_reason?: string;
  owner_blocked: boolean;
  owner_error?: string;
  task: number;
  has_question: boolean;
  question_id?: string;
  pending_messages: number;
  dispatch?: Dispatch;
  dispatch_notes?: string[];
  elapsed_ms: number;
  execution_elapsed_ms?: number;
  turn_elapsed_ms?: number;
  /** Live exit-confirmation wait; absent after execution exits. */
  drain?: { waiting_for: DrainWait; elapsed_ms: number };
  turns: number;
  max_turns: number;
  runtime?: RunTelemetry;
  stop_reason?: StopReason;
  cancellation_source?: CancellationSource;
  model_stop_reason?: ModelStopReason;
  outcome?: Outcome;
  usage?: UsageLedger;
  result_ref?: ResultRef;
  cleanup_errors: string[];
  discarded_inputs: string[];
  /** Runs that must complete before this one starts; their retained
   * results prefix its prompt as reference material. */
  after?: string[];
  /** Queued only: dependencies that have not settled yet. */
  blocked_by?: string[];
  /** Scheduling wait, without exposing routing to the parent model. */
  queued_for?: "dependencies" | "capacity";
  /** Parent updates queued while idle and delivered with this Run's prompt. */
  delivered_updates?: number;
}
export interface ResultPage {
  snapshot: RunView;
  text: string;
  retained_chars: number;
  total_chars: number;
  complete: boolean;
  truncated: boolean;
  next_cursor?: string;
  result_ref?: ResultRef;
}

export const normalizeRuntime = (value: unknown): RunTelemetry | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<RunTelemetry>;
  if (!raw.activity || !["generating", "tool", "compacting", "retrying"].includes(raw.activity))
    return undefined;
  let context: RunTelemetry["context"];
  if (raw.context !== undefined) {
    if (
      !raw.context ||
      typeof raw.context !== "object" ||
      Array.isArray(raw.context) ||
      !(
        raw.context.tokens === null ||
        (Number.isSafeInteger(raw.context.tokens) && raw.context.tokens >= 0)
      ) ||
      !Number.isSafeInteger(raw.context.context_window) ||
      raw.context.context_window <= 0
    )
      return undefined;
    context = { tokens: raw.context.tokens, context_window: raw.context.context_window };
  }
  const usage = raw.usage === undefined ? undefined : normalizeLedger(raw.usage);
  if (raw.usage !== undefined && !usage) return undefined;
  return { activity: raw.activity, ...(context ? { context } : {}), ...(usage ? { usage } : {}) };
};
export const normalizeFacts = (
  value: unknown,
  fallback: Output,
): { facts: ExecutionFacts; invalid: boolean } => {
  const f = value as ExecutionFacts | undefined;
  if (
    !f ||
    !["success", "error", "aborted"].includes(f.kind) ||
    !validOutput(f.output) ||
    (f.error !== undefined && typeof f.error !== "string")
  ) {
    return {
      invalid: true,
      facts: { kind: "error", output: fallback, error: "INVALID_EXECUTION_FACTS" },
    };
  }
  if (
    f.model_stop_reason !== undefined &&
    (typeof f.model_stop_reason !== "string" ||
      !f.model_stop_reason ||
      f.model_stop_reason.length > 128)
  ) {
    return {
      invalid: true,
      facts: { kind: "error", output: fallback, error: "INVALID_EXECUTION_FACTS" },
    };
  }
  return {
    invalid: false,
    facts: {
      kind: f.kind,
      output: f.output,
      model_stop_reason: f.model_stop_reason,
      error: f.error?.slice(0, 2048),
      usage: normalizeLedger(f.usage),
    },
  };
};
export const terminal = (status: RunStatus): boolean =>
  !["queued", "running", "cancelling"].includes(status);
export const validSettings = (value: unknown): value is AdmittedAgentConfig => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as AdmittedAgentConfig;
  return (
    [
      s.provider,
      s.model,
      s.thinking,
      s.profile,
      s.preset,
      s.preset_version,
      s.cwd,
      s.definition_digest,
      s.selection_digest,
    ].every((v) => typeof v === "string" && !!v) &&
    ["identity", "automatic_mapping", "preset_fixed"].includes(s.thinking_resolution) &&
    (s.thinking_resolution === "preset_fixed"
      ? !Object.hasOwn(s, "parent_thinking") ||
        (typeof s.parent_thinking === "string" && !!s.parent_thinking)
      : typeof s.parent_thinking === "string" && !!s.parent_thinking) &&
    (!Object.hasOwn(s, "effort_source") ||
      ["preset", "user_override"].includes(s.effort_source ?? "")) &&
    validDifficulty(s.difficulty) &&
    difficultySlots[s.difficulty - 1] === s.strength &&
    isAbsolute(s.cwd) &&
    !Object.hasOwn(s, "workspace") &&
    Array.isArray(s.tools) &&
    s.tools.every((v) => typeof v === "string") &&
    /^[0-9a-f]{64}$/.test(s.definition_digest) &&
    /^[0-9a-f]{64}$/.test(s.selection_digest) &&
    (s.context_snapshot === undefined ||
      (typeof s.context_snapshot === "string" && Buffer.byteLength(s.context_snapshot) <= 65536))
  );
};
