import type { CommunicationReason } from "./communication-envelope.js";
import { HarnessError } from "./ports.js";

/** SDK-free communication scheduler. Each Owner owns one instance shared by
 * model AND lifecycle observations; no separate legacy wait path remains.
 *
 * Ports below are private trusted integration code, not plugin callbacks.
 * Readiness and snapshots must be read-only; snapshots/publications must be
 * ordinary data. Only commit may mutate presentation state, after validating
 * ALL references. Commit must be straight-line, callback-free and nonthrowing.
 * Real execution/cleanup promises, not this collection, prove Owner shutdown.
 */
export type ObservationReason = CommunicationReason;
export type CoreObservationReason = Exclude<ObservationReason, "snapshot" | "aborted" | "timeout">;
export type ObservationPolicy = { readonly kind: "snapshot" } | { readonly kind: "waiting"; readonly wait_ms: number };
export interface ObservationPublication<Result, References> {
  /** Already serialized/final tool result; never processed after commit. */
  readonly result: Result;
  readonly references: References;
}
export interface ModelObservation<Validation, Snapshot, References, Result> {
  readonly policy: ObservationPolicy;
  readonly signal?: AbortSignal;
  /** Pure core readiness, including fault/question/issue/condition/inbox/empty
   * precedence. Undefined means keep this observation and its original timer. */
  readonly ready: () => CoreObservationReason | undefined;
  /** Reads only captured parent context and admission. Never gets live Runs. */
  readonly validate: () => Validation;
  /** Core snapshot preparation: no live Owner/Run objects may escape. */
  readonly snapshot: (reason: ObservationReason, validation: Validation) => Snapshot;
  /** Pure projection, packing and BOTH JSON byte checks happen here. A promise
   * or thenable is an interface error, never an asynchronous publication. */
  readonly publish: (snapshot: Snapshot) => ObservationPublication<Result, References>;
  /** Pure synchronous SDK-free checking of ALL references, before mutation. */
  readonly validateCommit: (references: References) => undefined;
  /** Trusted core mutation only; cannot call ports, await, or throw partway. */
  readonly commit: (references: References) => undefined;
}
export interface LifecycleObservation {
  readonly ready: () => boolean;
  /** No timeout means no timer; lifecycle waits are not model-tool waits. */
  readonly wait_ms?: number;
  readonly signal?: AbortSignal;
}
export type LifecycleObservationResult = "ready" | "aborted" | "timeout";
/** Internal deterministic test seam. Production uses real event-loop timers. */
export interface ObservationClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Signals {
  aborted: boolean;
  deadlineReached: boolean;
}
interface PendingObservationState {
  readonly signals: Signals;
  readonly started: number;
  readonly wait_ms?: number;
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
  /** Returns only a final resolver. All publication/commit work is synchronous
   * inside check, and check is called ONLY by the drain. */
  check(): (() => void) | undefined;
  reject(error: HarnessError): void;
}
type PendingObservation = PendingObservationState & ({ readonly kind: "model" } | { readonly kind: "lifecycle" });
interface ReadOnlyFrame { phase: "validation" | "publication"; violation: boolean }
const nativeClock: ObservationClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
/** Internal trusted-port check, also used when a context reader is wrapped by
 * the Owner's admission reader. It must run inside the active readonly phase. */
export const synchronousObservationPort = <T>(value: T): T => {
  if (value !== null && (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function") {
    // Reject now, never await. The intrinsic brand-checks native Promises
    // (including another realm) without invoking an arbitrary thenable's then.
    // Sink a mistaken async port's rejection rather than faulting the process.
    try { Promise.prototype.then.call(value, undefined, () => undefined).catch(() => undefined); }
    catch { /* A non-native thenable is still an interface error. */ }
    throw new HarnessError("ASYNC_OBSERVATION_PORT");
  }
  return value;
};
/** Native timer range. Core lifecycle waits retain fractional durations and
 * optional unlimited waiting; model observations have their own tighter cap. */
export function validateLifecycleWait(wait_ms: number | undefined): void {
  if (wait_ms !== undefined && (!Number.isFinite(wait_ms) || wait_ms < 0 || wait_ms > 2_147_483_647)) {
    throw new HarnessError("INVALID_OBSERVATION_WAIT");
  }
}
const observationError = (error: unknown): HarnessError => {
  // Avoid invoking untrusted diagnostic getters/stringification during wake.
  try { if (error instanceof HarnessError) return error; } catch { /* revoked proxy */ }
  return new HarnessError("OBSERVATION_FAILED", { cause: error });
};

export class ObservationScheduler {
  private readonly observations = new Set<PendingObservation>();
  private draining = false;
  private wakeAgain = false;
  private frame?: ReadOnlyFrame;

  constructor(private readonly clock: ObservationClock = nativeClock) {}

  /** Synchronous facade guard for EVERY Owner effecting entry, including async
   * commands before enqueue/await and mutable Run callbacks before mutation.
   * Swallowing the nested error cannot clear the source frame's violation. */
  assertEffectAllowed(): void {
    if (!this.frame) return;
    this.frame.violation = true;
    throw new HarnessError("OBSERVATION_REENTRANCY", { phase: this.frame.phase });
  }

  /** Entry context checks and first default-selection admission reads use the
   * same transient gate BEFORE registering any observation. No placeholder. */
  validateEntry<T>(read: () => T): T {
    return this.inPhase("validation", read);
  }

  private inPhase<T>(phase: ReadOnlyFrame["phase"], read: () => T): T {
    this.assertEffectAllowed(); // Never replace an outer frame.
    const frame: ReadOnlyFrame = { phase, violation: false };
    this.frame = frame;
    try {
      const value = synchronousObservationPort(read());
      if (frame.violation) throw new HarnessError("OBSERVATION_REENTRANCY", { phase });
      return value;
    } finally {
      this.frame = undefined;
      // A real signal can arrive in entry validation with draining=false.
      // It only latched state; now it may enter the SAME drain.
      this.drain();
    }
  }

  /** Public/Owner wake is effecting. Only the private native listener path may
   * latch a signal during a guarded phase. Never call individual checkers. */
  requestDrain(): void {
    this.assertEffectAllowed();
    this.wakeAgain = true;
    this.drain();
  }

  /** This is deliberately not async: reject illegal reentry synchronously,
   * before a Promise executor can register or queue any nested work. */
  observe<Validation, Snapshot, References, Result>(
    options: ModelObservation<Validation, Snapshot, References, Result>,
  ): Promise<Result> {
    this.assertEffectAllowed();
    const policy = options.policy.kind;
    const wait_ms = options.policy.kind === "waiting" ? options.policy.wait_ms : undefined;
    this.checkWait(wait_ms);
    return this.register<Result>("model", wait_ms, options.signal, (signals, resolve) => () => {
      const reason = (): ObservationReason | undefined => signals.aborted ? "aborted" : policy === "snapshot" ? "snapshot" :
        options.ready() ?? (signals.deadlineReached ? "timeout" : undefined);
      // Do not touch guarded SDK getters on every wake while still waiting.
      if (reason() === undefined) return undefined;
      const validation = this.inPhase("validation", options.validate);
      const current = reason(); // Signals/readiness may have changed in validation.
      if (current === undefined) return undefined;
      const prepare = (why: ObservationReason) => this.inPhase("publication", () => {
        const snapshot = synchronousObservationPort(options.snapshot(why, validation));
        const publication = synchronousObservationPort(options.publish(snapshot));
        // Promise resolution must not assimilate a thenable after commit.
        const result = synchronousObservationPort(publication.result), references = publication.references;
        return { result, references };
      });
      let finalReason = current;
      let publication = prepare(finalReason);
      // Abort is monotonic: at most one replacement projection. The discarded
      // candidate commits NOTHING. The aborted snapshot must carry no alert or
      // finished references (while preserving any accepted command fact).
      if (signals.aborted && finalReason !== "aborted") {
        finalReason = "aborted";
        publication = prepare(finalReason);
      }
      if (finalReason !== "aborted" && finalReason !== "timeout") {
        synchronousObservationPort(options.validateCommit(publication.references));
        synchronousObservationPort(options.commit(publication.references));
      }
      return () => resolve(publication.result);
    });
  }

  /** settleGate/kill predicates share the registry/drain but never run a model
   * validator, publisher, or presentation commit. */
  observeLifecycle(options: LifecycleObservation): Promise<LifecycleObservationResult> {
    this.assertEffectAllowed();
    validateLifecycleWait(options.wait_ms);
    return this.register<LifecycleObservationResult>("lifecycle", options.wait_ms, options.signal, (signals, resolve) => () => {
      const value: LifecycleObservationResult | undefined = signals.aborted ? "aborted" :
        options.ready() ? "ready" : signals.deadlineReached ? "timeout" : undefined;
      return value === undefined ? undefined : () => resolve(value);
    });
  }

  private checkWait(wait_ms: number | undefined): void {
    if (wait_ms !== undefined && (!Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 300000)) {
      throw new HarnessError("INVALID_OBSERVATION_WAIT");
    }
  }

  private register<Result>(kind: PendingObservation["kind"], wait_ms: number | undefined,
    signal: AbortSignal | undefined,
    checker: (signals: Signals, resolve: (value: Result) => void) => PendingObservation["check"],
  ): Promise<Result> {
    const started = this.clock.now();
    return new Promise<Result>((resolve, reject) => {
      const signals = { aborted: signal?.aborted ?? false, deadlineReached: wait_ms === 0 };
      const observation: PendingObservation = { kind, signals, started, wait_ms,
        check: checker(signals, resolve), reject };
      this.observations.add(observation);
      try {
        if (signal && !signals.aborted) {
          const onAbort = () => this.signal(observation, "aborted");
          observation.detachAbort = () => signal.removeEventListener("abort", onAbort);
          signal.addEventListener("abort", onAbort, { once: true });
        }
        this.requestDrain();
      } catch (error) { this.rejectAndDetach(observation, error); }
    });
  }

  /** Native signals are the ONLY gate exception. Repeated notifications do
   * nothing. In particular a timer never compares its callback time to now(). */
  private signal(observation: PendingObservation, key: keyof Signals): void {
    if (!this.observations.has(observation) || observation.signals[key]) return;
    observation.signals[key] = true;
    this.wakeAgain = true;
    this.drain();
  }

  private armTimer(observation: PendingObservation): void {
    if (observation.wait_ms === undefined || observation.timer !== undefined || observation.signals.deadlineReached) return;
    const delay = observation.wait_ms - (this.clock.now() - observation.started);
    if (delay <= 0) { this.signal(observation, "deadlineReached"); return; }
    observation.timer = this.clock.setTimeout(() => this.signal(observation, "deadlineReached"), delay);
  }

  private detach(observation: PendingObservation): void {
    this.observations.delete(observation);
    // Native teardown is nonthrowing. Even a faulty injected clock/listener
    // must not strand promises, escape child wake, or block peer observations.
    // A leftover native signal is harmless: it checks collection membership.
    try { if (observation.timer !== undefined) this.clock.clearTimeout(observation.timer); } catch { /* detached */ }
    try { observation.detachAbort?.(); } catch { /* detached */ }
  }

  private rejectAndDetach(observation: PendingObservation, error: unknown): void {
    this.detach(observation);
    observation.reject(observationError(error));
  }

  private drain(): void {
    if (this.frame || this.draining || !this.wakeAgain) return;
    this.draining = true;
    try {
      do {
        this.wakeAgain = false;
        for (const observation of [...this.observations]) {
          if (!this.observations.has(observation)) continue;
          try {
            const complete = observation.check();
            if (complete) { this.detach(observation); complete(); }
            else this.armTimer(observation);
          } catch (error) {
            // Observer failure never escapes wake/accepted child callbacks and
            // never faults execution tracking or the Owner cleanup latch.
            this.rejectAndDetach(observation, error);
          }
        }
      } while (this.wakeAgain);
    } finally { this.draining = false; }
  }
}
