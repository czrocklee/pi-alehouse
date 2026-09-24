import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { validDifficulty, type AdmittedAgentConfig, type Difficulty, type HistoryRef,
  type Outcome, type Output, type RunIdentity } from "../core/contracts.js";
import { HarnessError, ParentHistoryError, type HistoryPort } from "../core/ports.js";
import { describeResult, isId } from "../core/result-text.js";
import { normalizeLedger, type UsageLedger } from "../core/usage-ledger.js";

export const historyTypes = { link: "harness:run-link:v1", start: "harness:run-start:v1", end: "harness:run-end:v1" } as const;
export const invalidHistory = (): never => { throw new HarnessError("INVALID_SDK_HISTORY"); };
export const sameRun = (a: RunIdentity, b: RunIdentity): boolean =>
  a.owner_id === b.owner_id && a.generation === b.generation && a.agent_id === b.agent_id && a.run_id === b.run_id;
export const validIdentity = (value: unknown): value is RunIdentity => {
  const r = value as RunIdentity | undefined;
  return !!r && [r.owner_id, r.generation, r.agent_id, r.run_id].every(isId);
};
export const entryId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
export interface HistoricalRouting {
  preset: string; preset_version: string; selection_digest: string;
  strength: "light" | "standard" | "strong"; thinking: string; provider: string; model: string; profile: string;
  /** Absent in older journals; never infer a rating from their slot. */
  difficulty?: Difficulty;
  parent_thinking?: string;
  thinking_resolution?: "identity" | "preset_mapping" | "preset_fixed";
  /** Absent in older journals; never infer provenance from a preset name. */
  effort_source?: "preset" | "user_override";
}
const routingOf = (settings: AdmittedAgentConfig): HistoricalRouting => ({ preset: settings.preset,
  preset_version: settings.preset_version, selection_digest: settings.selection_digest,
  difficulty: settings.difficulty, strength: settings.strength,
  thinking: settings.thinking,
  ...(settings.parent_thinking !== undefined ? { parent_thinking: settings.parent_thinking } : {}),
  thinking_resolution: settings.thinking_resolution,
  ...(settings.effort_source !== undefined ? { effort_source: settings.effort_source } : {}),
  provider: settings.provider, model: settings.model, profile: settings.profile });
export const validRouting = (value: unknown): value is HistoricalRouting => {
  const r = value as HistoricalRouting | undefined;
  const legacy = !Object.hasOwn(r ?? {}, "parent_thinking") && !Object.hasOwn(r ?? {}, "thinking_resolution") &&
    !Object.hasOwn(r ?? {}, "effort_source");
  const fixed = r?.thinking_resolution === "preset_fixed" &&
    (!Object.hasOwn(r, "parent_thinking") || (typeof r.parent_thinking === "string" && !!r.parent_thinking));
  const inherited = ["identity", "preset_mapping"].includes(r?.thinking_resolution ?? "") &&
    typeof r?.parent_thinking === "string" && !!r.parent_thinking;
  return !!r && [r.preset, r.preset_version, r.thinking, r.provider, r.model, r.profile].every((v) => typeof v === "string" && !!v) &&
    (legacy || fixed || inherited) &&
    (!Object.hasOwn(r, "effort_source") || ["preset", "user_override"].includes(r.effort_source ?? "")) &&
    (!Object.hasOwn(r, "difficulty") || validDifficulty(r.difficulty)) &&
    ["light", "standard", "strong"].includes(r.strength) && /^[0-9a-f]{64}$/.test(r.selection_digest);
};
export const validModelStopReason = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128);
export const validRef = (value: unknown): value is HistoryRef => {
  const r = value as HistoryRef | undefined;
  return validIdentity(r) && isId(r.session_id) && entryId(r.start_entry_id) &&
    (r.end_entry_id === undefined || entryId(r.end_entry_id));
};
export const dataOf = (entry: SessionEntry | undefined, kind: string): unknown =>
  entry?.type === "custom" && entry.customType === kind ? entry.data : undefined;
export const finalMessage = (manager: SessionManager, start: string, through: string, boundary = through) => {
  const branch = manager.getBranch(boundary), index = branch.findIndex((e) => e.id === start);
  const exit = branch.findIndex((e) => e.id === through);
  if (index < 0 || exit < index || branch.slice(index + 1).some((e) => e.type === "custom" && e.customType === historyTypes.start)) invalidHistory();
  return branch.slice(index + 1, exit + 1).filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
};
export const textOf = (entry: SessionEntry | undefined): string => entry?.type === "message" && entry.message.role === "assistant"
  ? entry.message.content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";

/** Live SDK append-only journal. Appended IDs are not disk receipts. */
export class PiRunJournal implements HistoryPort {
  private active?: { ref: HistoryRef; through?: string };
  private failure?: string;
  constructor(private readonly options: { parent: {
    getSessionId(): string; isPersisted(): boolean;
    appendCustomEntry(type: string, data: unknown): unknown;
  }; session: SessionManager }) {}
  get error(): string | undefined { return this.failure; }
  invalidate(error: unknown): void { this.failure ??= String(error).slice(0, 2048); }
  private usable(): void { if (this.failure) throw new HarnessError("SDK_HISTORY_UNCERTAIN", { error: this.failure }); }
  begin(run: RunIdentity, settings?: AdmittedAgentConfig): HistoryRef | undefined {
    this.usable();
    const { parent, session } = this.options;
    if (!parent.isPersisted() || !session.isPersisted()) return undefined;
    if (!validIdentity(run) || run.owner_id !== parent.getSessionId() || this.active) invalidHistory();
    try {
      const routing = settings ? routingOf(settings) : undefined;
      const start_entry_id = session.appendCustomEntry(historyTypes.start, { ...run, ...(routing ? { routing } : {}) });
      const ref = { ...run, session_id: session.getSessionId(), start_entry_id };
      try { parent.appendCustomEntry(historyTypes.link, { ref, session_file: session.getSessionFile(), ...(routing ? { routing } : {}) }); }
      catch (error) { throw new ParentHistoryError(error); }
      this.active = { ref };
      return { ...ref };
    } catch (error) { this.invalidate(error); throw error; }
  }
  /** Capture the full prompt boundary before later extension shutdown entries. */
  seal(): void {
    if (this.active && !this.failure) this.active.through = this.options.session.getLeafId() ?? undefined;
  }
  finish(ref: HistoryRef, outcome: Outcome, output: Output, usage?: UsageLedger): HistoryRef {
    this.usable();
    const { session } = this.options, active = this.active;
    if (!active || !validRef(ref) || !sameRun(ref, active.ref) ||
        ref.session_id !== session.getSessionId() || ref.start_entry_id !== active.ref.start_entry_id) invalidHistory();
    try {
      const through = active!.through ?? (session.getLeafId() === ref.start_entry_id ? ref.start_entry_id : invalidHistory());
      const final = finalMessage(session, ref.start_entry_id, through, session.getLeafId() ?? invalidHistory());
      const text = textOf(final);
      if (text.slice(0, output.text.length) !== output.text || text.length !== output.total_chars) invalidHistory();
      const observedUsage = normalizeLedger(usage);
      const end_entry_id = session.appendCustomEntry(historyTypes.end, { ref: active!.ref, through,
        final_entry_id: final?.id ?? null, result: describeResult(ref.run_id, output), outcome,
        ...(observedUsage ? { usage: observedUsage } : {}) });
      this.active = undefined;
      return { ...ref, end_entry_id };
    } catch (error) { this.invalidate(error); throw error; }
  }
}
