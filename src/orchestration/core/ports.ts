import type {
  AdmittedAgentConfig,
  DrainWait,
  ExecutionFacts,
  HistoryRef,
  Outcome,
  Output,
  OutputDelta,
  RunExecutionIdentity,
  RunIdentity,
  RunTelemetry,
} from "./contracts.ts";
import type { UsageLedger } from "./usage-ledger.ts";
import type { ValidationReceipt } from "./dispatch.ts";

export interface HistoryPort {
  /** Local SDK writer uncertainty. It does not by itself stop other Agents. */
  readonly error?: string;
  begin(
    run: RunIdentity,
    settings?: AdmittedAgentConfig,
  ): HistoryRef | undefined | Promise<HistoryRef | undefined>;
  /** Optional receipt rejection is reported during finish, not a failed end.
   * The diagnostic callback must return normally; append uncertainty still fails. */
  finish(
    ref: HistoryRef,
    outcome: Outcome,
    output: Output,
    usage?: UsageLedger,
    receipt?: ValidationReceipt,
    onReceiptRejected?: () => void,
  ): HistoryRef | Promise<HistoryRef>;
}
/** Trusted adapter telemetry only. Core validates its configured exact-tool vocabulary;
 * no tool input, denial reason, arbitrary message or caller-selected origin. */
export interface RepeatedManagedBlock {
  readonly toolName: string;
}
export interface RunCallbacks {
  inputEntered(): void;
  output(output: Output): void;
  /** Required incremental execution seam. The Owner computes totals and caps;
   * final output still validates the observed prefix in the same revision.
   * A consumer that cannot receive deltas fails closed at the first reset. */
  outputDelta(delta: OutputDelta): void;
  runtime?(snapshot: RunTelemetry): void;
  /** Diagnostic observation only. Does not settle, cancel or release execution. */
  drain?(waiting_for: DrainWait): void;
  turnStart(): void;
  turnEnd(continuing?: boolean): void;
  question(text: string): "recorded" | "already_recorded";
  alert(text: string): void;
  /** Owner feedback; never registered as a child tool. */
  managedBlock?(fact: RepeatedManagedBlock): void;
}
export interface AgentSessionPort {
  readonly session_id: string;
  readonly history?: HistoryPort;
  canInput(): boolean;
  run(
    prompt: string,
    callbacks: RunCallbacks,
    identity: RunExecutionIdentity,
  ): Promise<ExecutionFacts>;
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

export class OrchestrationError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "OrchestrationError";
  }
}
/** One shared model-facing shape for the delegation-off gate, used by the core
 * admission checks and the trusted routing module alike. */
export const workersDisabled = (): OrchestrationError =>
  new OrchestrationError("WORKERS_DISABLED", {
    resolution:
      "Worker delegation is off in the user's configuration; ask the user to enable it. Already accepted tasks are unaffected.",
  });
/** A failed write to the shared parent SDK session. */
export class ParentHistoryError extends Error {
  constructor(cause: unknown) {
    super(`PARENT_HISTORY_UNAVAILABLE: ${String(cause)}`, { cause });
  }
}
export class SessionInitializationError extends AggregateError {
  readonly code = "CHILD_INITIALIZATION_FAILED";
  constructor(original: unknown, cleanup: unknown) {
    super(
      [original, cleanup],
      `CHILD_INITIALIZATION_FAILED: ${String(original)}; ${String(cleanup)}`,
      { cause: original },
    );
  }
}
export class SessionUnavailableError extends Error {
  usage?: UsageLedger;
  constructor(
    readonly reason: string,
    cause: unknown,
  ) {
    super(`SESSION_UNAVAILABLE (${reason}): ${String(cause)}`, { cause });
  }
}
