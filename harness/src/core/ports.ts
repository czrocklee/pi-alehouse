import type { AdmittedAgentConfig, DrainWait, ExecutionFacts, HistoryRef, Outcome, Output, RunExecutionIdentity, RunIdentity, RunTelemetry } from "./contracts.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { ValidationReceipt } from "./dispatch.js";

export interface HistoryPort {
  /** Local SDK writer uncertainty. It does not by itself stop other Agents. */
  readonly error?: string;
  begin(run: RunIdentity, settings?: AdmittedAgentConfig): HistoryRef | undefined | Promise<HistoryRef | undefined>;
  /** Optional receipt rejection is reported during finish, not a failed end.
   * The diagnostic callback must return normally; append uncertainty still fails. */
  finish(ref: HistoryRef, outcome: Outcome, output: Output, usage?: UsageLedger, receipt?: ValidationReceipt,
    onReceiptRejected?: () => void): HistoryRef | Promise<HistoryRef>;
}
export interface RunCallbacks {
  inputEntered(): void;
  output(output: Output): void;
  runtime?(snapshot: RunTelemetry): void;
  /** Diagnostic observation only. Does not settle, cancel or release execution. */
  drain?(waiting_for: DrainWait): void;
  turnStart(): void;
  turnEnd(continuing?: boolean): void;
  question(text: string): "recorded" | "already_recorded";
  alert(text: string): void;
  /** Observation only: a successful edit/write tool call's path argument. */
  touched?(path: string): void;
}
export interface AgentSessionPort {
  readonly session_id: string;
  readonly history?: HistoryPort;
  canInput(): boolean;
  run(prompt: string, callbacks: RunCallbacks, identity: RunExecutionIdentity): Promise<ExecutionFacts>;
  steer(message: string, valid: () => boolean): Promise<boolean>;
  stop(): Promise<void>;
  clearInputs(): string[];
  dispose(): Promise<{ shutdownExited: boolean; errors: string[] }>;
}
/** Execution lease only. No result files, durable acceptance or restart replay. */
export interface OwnerLease {
  readonly owner_id: string;
  readonly generation: string;
  assertHeld(): void;
  close(): void;
}

export class HarnessError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "HarnessError";
  }
}
/** One shared model-facing shape for the delegation-off gate, used by the core
 * admission checks and the trusted routing module alike. */
export const workersDisabled = (): HarnessError => new HarnessError("WORKERS_DISABLED",
  { resolution: "Worker delegation is off in the user's configuration; ask the user to enable it. Already accepted tasks are unaffected." });
/** A failed write to the shared parent SDK session. */
export class ParentHistoryError extends Error {
  constructor(cause: unknown) { super(`PARENT_HISTORY_UNAVAILABLE: ${String(cause)}`, { cause }); }
}
export class SessionInitializationError extends AggregateError {
  readonly code = "CHILD_INITIALIZATION_FAILED";
  constructor(original: unknown, cleanup: unknown) {
    super([original, cleanup], `CHILD_INITIALIZATION_FAILED: ${String(original)}; ${String(cleanup)}`, { cause: original });
  }
}
export class SessionUnavailableError extends Error {
  usage?: UsageLedger;
  constructor(readonly reason: string, cause: unknown) {
    super(`SESSION_UNAVAILABLE (${reason}): ${String(cause)}`, { cause });
  }
}
