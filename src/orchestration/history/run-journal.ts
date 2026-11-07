import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  validModelStopReason as validModelStopReasonRecord,
  validOutcome as validOutcomeRecord,
  validRouting as validRoutingRecord,
} from "../../shared/history-codec.mjs";
import {
  type AdmittedAgentConfig,
  type Difficulty,
  type HistoryRef,
  type Outcome,
  type Output,
  type RunIdentity,
  type WorkerSlot,
} from "../core/contracts.ts";
import { OrchestrationError, ParentHistoryError, type HistoryPort } from "../core/ports.ts";
import { validValidationReceipt, type ValidationReceipt } from "../core/dispatch.ts";
import { describeResult, isId } from "../core/result-text.ts";
import { normalizeLedger, type UsageLedger } from "../core/usage-ledger.ts";

export const historyTypes = {
  link: "alehouse:run-link:v1",
  start: "alehouse:run-start:v1",
  end: "alehouse:run-end:v1",
} as const;
export const invalidHistory = (): never => {
  throw new OrchestrationError("INVALID_SDK_HISTORY");
};
export const sameRun = (a: RunIdentity, b: RunIdentity): boolean =>
  a.owner_id === b.owner_id &&
  a.generation === b.generation &&
  a.agent_id === b.agent_id &&
  a.run_id === b.run_id;
export const validIdentity = (value: unknown): value is RunIdentity => {
  const r = value as RunIdentity | undefined;
  return !!r && [r.owner_id, r.generation, r.agent_id, r.run_id].every(isId);
};
export const entryId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
export interface HistoricalRouting {
  preset: string;
  preset_version: string;
  selection_digest: string;
  strength: WorkerSlot;
  thinking: string;
  provider: string;
  model: string;
  profile: string;
  difficulty: Difficulty;
  parent_thinking?: string;
  thinking_resolution: "identity" | "automatic_mapping" | "preset_fixed";
  /** Optional in current generic core settings; never inferred from a preset name. */
  effort_source?: "preset" | "user_override";
}
const routingOf = (settings: AdmittedAgentConfig): HistoricalRouting => ({
  preset: settings.preset,
  preset_version: settings.preset_version,
  selection_digest: settings.selection_digest,
  difficulty: settings.difficulty,
  strength: settings.strength,
  thinking: settings.thinking,
  ...(settings.parent_thinking !== undefined ? { parent_thinking: settings.parent_thinking } : {}),
  thinking_resolution: settings.thinking_resolution,
  ...(settings.effort_source !== undefined ? { effort_source: settings.effort_source } : {}),
  provider: settings.provider,
  model: settings.model,
  profile: settings.profile,
});
/** Current routing codec only: retired slot names, missing ratings and removed
 * resolution values are unsupported data, never reinterpreted or converted.
 * The lib predicate is the single codec source shared with the offline
 * analyzer; this wrapper only narrows it to the orchestration routing type. */
export const validRouting = (value: unknown): value is HistoricalRouting =>
  validRoutingRecord(value);
export const validationReceiptError = "invalid_validation_receipt" as const;
/** Receipts are declarations/observations, never proof of executed or passed checks. */
export function receiptOf(value: unknown, outcome: Outcome): ValidationReceipt {
  if (
    !validValidationReceipt(value) ||
    value.outcome.status !== outcome.status ||
    value.outcome.reason !== outcome.reason
  )
    invalidHistory();
  const r = value as ValidationReceipt,
    s = r.source_state;
  return {
    version: 1,
    checks: [...r.checks],
    cwd: r.cwd,
    ...(r.tree !== undefined ? { tree: r.tree } : {}),
    source_state:
      s.state === "unknown"
        ? { state: "unknown", reason: s.reason }
        : {
            state: "observed",
            scope: s.scope,
            submodules: s.submodules,
            head: s.head,
            dirty: s.dirty,
            status_digest: s.status_digest,
            observed_at: s.observed_at,
          },
    outcome: {
      status: r.outcome.status,
      ...(r.outcome.reason !== undefined ? { reason: r.outcome.reason } : {}),
    },
  };
}
export const validModelStopReason = (value: unknown): value is string | undefined =>
  validModelStopReasonRecord(value);
/** Current outcome codec: a closed field set with current optionality. Unknown
 * and retired historical fields are unsupported data, not silently accepted.
 * The lib predicate is the single codec source shared with the offline
 * analyzer; this wrapper only narrows it to the orchestration outcome type. */
export const validOutcome = (value: unknown): value is Outcome => validOutcomeRecord(value);
export const validRef = (value: unknown): value is HistoryRef => {
  const r = value as HistoryRef | undefined;
  return (
    validIdentity(r) &&
    isId(r.session_id) &&
    entryId(r.start_entry_id) &&
    (r.end_entry_id === undefined || entryId(r.end_entry_id))
  );
};
export const dataOf = (entry: SessionEntry | undefined, kind: string): unknown =>
  entry?.type === "custom" && entry.customType === kind ? entry.data : undefined;
export const finalMessage = (
  manager: SessionManager,
  start: string,
  through: string,
  boundary = through,
) => {
  const branch = manager.getBranch(boundary),
    index = branch.findIndex((e) => e.id === start);
  const exit = branch.findIndex((e) => e.id === through);
  if (
    index < 0 ||
    exit < index ||
    branch.slice(index + 1).some((e) => e.type === "custom" && e.customType === historyTypes.start)
  )
    invalidHistory();
  return branch
    .slice(index + 1, exit + 1)
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .at(-1);
};
export const textOf = (entry: SessionEntry | undefined): string =>
  entry?.type === "message" && entry.message.role === "assistant"
    ? entry.message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
    : "";

/** Live SDK append-only journal. Appended IDs are not disk receipts. */
export class PiRunJournal implements HistoryPort {
  private active?: { ref: HistoryRef; through?: string };
  private failure?: string;
  constructor(
    private readonly options: {
      parent: {
        getSessionId(): string;
        isPersisted(): boolean;
        appendCustomEntry(type: string, data: unknown): unknown;
      };
      session: SessionManager;
    },
  ) {}
  get error(): string | undefined {
    return this.failure;
  }
  invalidate(error: unknown): void {
    this.failure ??= String(error).slice(0, 2048);
  }
  private usable(): void {
    if (this.failure)
      throw new OrchestrationError("SDK_HISTORY_UNCERTAIN", { error: this.failure });
  }
  begin(run: RunIdentity, settings?: AdmittedAgentConfig): HistoryRef | undefined {
    this.usable();
    const { parent, session } = this.options;
    if (!parent.isPersisted() || !session.isPersisted()) return undefined;
    if (!validIdentity(run) || run.owner_id !== parent.getSessionId() || this.active)
      invalidHistory();
    try {
      const routing = settings ? routingOf(settings) : undefined;
      // The writer is the first codec gate: never append a routing record the
      // current reader would reject, including retired shapes from the
      // direct JS API. A settings-omitted begin records no routing and stays legal.
      if (routing !== undefined && !validRouting(routing)) invalidHistory();
      const start_entry_id = session.appendCustomEntry(historyTypes.start, {
        ...run,
        ...(routing ? { routing } : {}),
      });
      const ref = { ...run, session_id: session.getSessionId(), start_entry_id };
      try {
        parent.appendCustomEntry(historyTypes.link, {
          ref,
          session_file: session.getSessionFile(),
          ...(routing ? { routing } : {}),
        });
      } catch (error) {
        throw new ParentHistoryError(error);
      }
      this.active = { ref };
      return { ...ref };
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }
  /** Capture the full prompt boundary before later extension shutdown entries. */
  seal(): void {
    if (this.active && !this.failure)
      this.active.through = this.options.session.getLeafId() ?? undefined;
  }
  finish(
    ref: HistoryRef,
    outcome: Outcome,
    output: Output,
    usage?: UsageLedger,
    receipt?: ValidationReceipt,
    onReceiptRejected?: () => void,
  ): HistoryRef {
    this.usable();
    const { session } = this.options,
      active = this.active;
    if (
      !active ||
      !validRef(ref) ||
      !sameRun(ref, active.ref) ||
      ref.session_id !== session.getSessionId() ||
      ref.start_entry_id !== active.ref.start_entry_id
    )
      invalidHistory();
    try {
      // The writer is the first codec gate: never append an outcome record the
      // current reader would reject. A mandatory outcome rejection never
      // invokes the optional receipt callback.
      if (!validOutcome(outcome)) invalidHistory();
      const through =
        active!.through ??
        (session.getLeafId() === ref.start_entry_id ? ref.start_entry_id : invalidHistory());
      const final = finalMessage(
        session,
        ref.start_entry_id,
        through,
        session.getLeafId() ?? invalidHistory(),
      );
      const text = textOf(final);
      if (text.slice(0, output.text.length) !== output.text || text.length !== output.total_chars)
        invalidHistory();
      const observedUsage = normalizeLedger(usage),
        result = describeResult(ref.run_id, output);
      let validation_receipt: ValidationReceipt | undefined,
        rejected = false;
      if (receipt !== undefined) {
        try {
          validation_receipt = receiptOf(receipt, outcome);
        } catch {
          rejected = true;
        }
      }
      // Only optional normalization is isolated. A diagnostic port exception is
      // an interface failure, not another optional error to silently discard.
      // Invoke before the sole append; never retry an uncertain append.
      if (rejected) onReceiptRejected?.();
      const end_entry_id = session.appendCustomEntry(historyTypes.end, {
        ref: active!.ref,
        through,
        final_entry_id: final?.id ?? null,
        result,
        outcome,
        ...(observedUsage ? { usage: observedUsage } : {}),
        ...(validation_receipt ? { validation_receipt } : {}),
        ...(rejected ? { validation_receipt_error: validationReceiptError } : {}),
      });
      this.active = undefined;
      return { ...ref, end_entry_id };
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }
}
