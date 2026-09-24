import type { AdmittedAgentConfig, DrainWait, ExecutionFacts, HistoryRef, Outcome, Output, RunExecutionIdentity, RunIdentity, RunTelemetry } from "./contracts.js";
import type { UsageLedger } from "./usage-ledger.js";

export interface HistoryPort {
  /** Local SDK writer uncertainty. It does not by itself stop other Agents. */
  readonly error?: string;
  begin(run: RunIdentity, settings?: AdmittedAgentConfig): HistoryRef | undefined | Promise<HistoryRef | undefined>;
  finish(ref: HistoryRef, outcome: Outcome, output: Output, usage?: UsageLedger): HistoryRef | Promise<HistoryRef>;
}
export interface RunCallbacks {
  inputEntered(): void;
  output(output: Output): void;
  runtime?(snapshot: RunTelemetry): void;
  /** Diagnostic observation only. Does not settle, cancel or release execution. */
  drain?(waiting_for: DrainWait): void;
  turnStart(): void;
  turnEnd(continuing?: boolean): void;
  question(text: string): void;
  notify(text: string): void;
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
