import { randomUUID } from "node:crypto";
import { normalizeFacts, normalizeRuntime, terminal, validSettings, type AdmittedAgentConfig, type ExecutionFacts,
  type HistoryRef, type ModelStopReason, type Outcome, type Output, type Phase, type ResultPage, type ResultRef,
  type RunStatus, type RunTelemetry, type RunView, type StopReason, type SubmitRequest } from "./contracts.js";
import { HarnessError, ParentHistoryError, SessionInitializationError, SessionUnavailableError,
  type AgentSessionPort, type OwnerLease, type RunCallbacks } from "./ports.js";
import { boundedOutput, describeResult, sha256, validOutput } from "./result-text.js";
import { mergeLedgers, totalOf, USAGE_COMPONENTS, type UsageLedger } from "./usage-ledger.js";

interface RunRecord {
  owner_id: string;
  generation: string;
  run_id: string;
  agent_id: string;
  request_id: string;
  request_digest: string;
  enqueue_sequence: number;
  name: string;
  settings: AdmittedAgentConfig;
  prompt: string;
  description: string;
  max_turns: number;
  max_duration_ms: number;
  answer_to_run_id?: string;
  input_entered: boolean;
  status: RunStatus;
  phase: Phase;
  execution_exited: boolean;
  history_ref?: HistoryRef;
  history_error?: string;
  submitted_at: number;
  started_at?: number;
  exited_at?: number;
  finished_at?: number;
  elapsed_ms?: number;
  execution_elapsed_ms?: number;
  turns: number;
  limit_reached: boolean;
  stop_reason?: StopReason;
  model_stop_reason?: ModelStopReason;
  outcome?: Outcome;
  result?: ResultRef;
  usage?: ExecutionFacts["usage"];
  cleanup_errors: string[];
  discarded_inputs: string[];
}
interface Agent {
  id: string; name: string; settings: AdmittedAgentConfig; resident: boolean;
  current?: string; session?: AgentSessionPort; unavailable?: string; release?: Promise<void>;
  /** Confirmed disposal; the reservation can still await current Run finalization. */
  cleanupComplete?: true;
  question?: { run_id: string; reserved_by?: string };
}
interface ManagedRun {
  record: RunRecord; output: Output; submittedMono: number;
  executionStartedMono?: number; deadlineTimer?: ReturnType<typeof setTimeout>;
  turnStarted?: number; inputOpen: boolean; active: boolean; outputReserved: boolean;
  inputs: Set<Promise<void>>; inputCount: number; notificationDrops: number; question?: string;
  runtime?: RunTelemetry; session?: AgentSessionPort; hadSession: boolean; quarantine?: string; cleanup?: Promise<void>;
  drain?: { waiting_for: NonNullable<RunView["drain"]>["waiting_for"]; startedMono: number };
}
export interface ContextChange {
  event_id: string; owner_id: string; generation: string; agent_id: string; run_id: string;
  session_id?: string; kind: "submit" | "resume" | "steer" | "soft_budget" | "cancel" | "hard_budget" | "deadline";
}
export interface OwnerControllerOptions {
  owner: OwnerLease;
  createSession: (agent: { agent_id: string; name: string; settings: AdmittedAgentConfig }) => Promise<AgentSessionPort>;
  /** Synchronous post-accept/pre-dispatch effect, not an admission transaction.
   * Must return undefined; failure prevents dispatch, never rolls back a Run ID. */
  onContextChange?: (event: ContextChange) => undefined;
  concurrency?: number;
  resident_limit?: number;
  queue_limit?: number;
  grace_turns?: number;
  output_chars?: number;
  /** Cumulative Run count, not a byte/RSS quota; no eviction is performed. */
  history_run_limit?: number;
  /** Retained/reserved RESULT text only, in UTF-16 code units; must fit output_chars.
   * Excludes prompts, settings/context snapshots, other metadata and SDK heap. */
  history_output_chars?: number;
  /** Timestamp/elapsed observation only. Deadlines and wait timeouts use real
   * event-loop timers; advancing an injected clock does not fire them. */
  clock?: { wall(): number; mono(): number };
  /** Read-only host admission state. Omission retains the always-enabled
   * legacy behavior; an invalid or throwing supplied reader fails closed. */
  admission?: () => { enabled: boolean; revision: number };
}
export interface ProgressEvent { event_id: string; run_id: string; text: string }
export interface WaitResult {
  reason: "condition" | "attention" | "timeout" | "interrupted" | "owner_blocked";
  snapshots: RunView[];
  results?: ResultPage[];
  /** Atomically claimed, at-most-once progress. Timeout/interruption never claim. */
  progress?: ProgressEvent[];
}
const stable = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("Non-JSON request identity");
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error("Non-JSON request identity");
  ancestors.add(value);
  try {
    // Object undefined means omitted, as before; array undefined/holes, NaN,
    // cycles and non-JSON objects are rejected rather than colliding with null/{}.
    if (Array.isArray(value)) return `[${Array.from(value, (v) => stable(v, ancestors)).join(",")}]`;
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
};
const errorText = (error: unknown): string => {
  // Diagnostics cannot reject cleanup/finalization. Even instanceof and error
  // property access may throw for a proxy or an extension-supplied getter.
  try {
    if (error instanceof HarnessError) {
      const detail = error.details.error;
      if (typeof detail === "string") return `${error.code}: ${detail}`.slice(0, 2048);
    }
    return String(error).slice(0, 2048);
  } catch { return "Unprintable failure"; }
};
const emptyOutput = (): Output => ({ text: "", total_chars: 0, truncated: false });
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const cumulativeUsage = (previous: UsageLedger | undefined, next: UsageLedger): UsageLedger => {
  if (!previous) return next;
  // Cumulative observations are not deltas. Keep every observed floor, even
  // when a faulty final snapshot regresses one model but adds another.
  const byModel = structuredClone(previous.byModel);
  for (const [model, after] of Object.entries(next.byModel)) {
    const before = byModel[model];
    if (!before) { byModel[model] = { ...after }; continue; }
    for (const key of USAGE_COMPONENTS) before[key] = Math.max(before[key], after[key]);
  }
  return { byModel, total: totalOf(byModel), partial: USAGE_COMPONENTS.filter((key) => previous.partial.includes(key) || next.partial.includes(key)) };
};
export const softBudgetMessage = "The turn budget has been reached. Finish now with your best supported final answer, noting unfinished work. Do not start new work.";
const settingsView = (settings: AdmittedAgentConfig): RunView["effective_settings"] => {
  const { context_snapshot, ...visible } = settings;
  return { ...visible, context_mode: context_snapshot === undefined ? "none" : "text_snapshot",
    ...(context_snapshot === undefined ? {} : { context_digest: sha256(context_snapshot), context_bytes: Buffer.byteLength(context_snapshot) }) };
};

/** Owner-local live state, NOT a Pi extension or production service handle.
 * Submission/idempotence are memory-only. SDK journals retain optional history;
 * no manifests, result copies, save retries or reconstruction of live Runs.
 * Execution, dispatch and cleanup still own the lease until confirmed finished.
 */
export class OwnerController {
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, ManagedRun>();
  private readonly requests = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly tasks = new Set<Promise<void>>();
  private readonly watchers = new Set<() => void>();
  // Bounded owner-local inbox. Matching wait atomically claims a message, not
  // an acknowledged/retryable delivery; no model cursor or durable event store.
  private readonly messages: ProgressEvent[] = [];
  private reportedBlock?: string;
  private submitTail: Promise<unknown> = Promise.resolve();
  private active = 0;
  /** Settled child spend the host has not taken yet. See `drainUsage`. */
  private unreported: UsageLedger | undefined;
  private sequence = 0;
  private retainedOutputChars = 0;
  private reservedOutputChars = 0;
  private closing = false;
  private closed = false;
  private cleanupUncertain = false;
  private cleaning = 0;
  private parentError?: string;
  private internalError?: string;
  private readonly limits;
  private readonly clock;

  private constructor(private readonly options: OwnerControllerOptions) {
    this.limits = { concurrency: options.concurrency ?? 4, resident: options.resident_limit ?? 8,
      queue: options.queue_limit ?? 16, grace: options.grace_turns ?? 5, output: options.output_chars ?? 1_048_576,
      historyRuns: options.history_run_limit ?? 512, historyOutput: options.history_output_chars ?? 64 * 1024 * 1024 };
    if (![this.limits.concurrency, this.limits.resident, this.limits.queue, this.limits.output,
      this.limits.historyRuns, this.limits.historyOutput].every(positive) ||
        !Number.isSafeInteger(this.limits.grace) || this.limits.grace < 0 ||
        this.limits.historyOutput < this.limits.output) throw new HarnessError("INVALID_LIMIT");
    this.clock = options.clock ?? { wall: Date.now, mono: () => performance.now() };
  }

  static async open(options: OwnerControllerOptions): Promise<OwnerController> {
    try {
      options.owner.assertHeld();
      return new OwnerController(options); // Deliberately never hydrates/replays history.
    } catch (error) { options.owner.close(); throw error; }
  }

  private requireRun(id: string): ManagedRun {
    const run = this.runs.get(id);
    if (!run) throw new HarnessError("RUN_NOT_FOUND", { run_id: id, owner_id: this.options.owner.owner_id });
    return run;
  }
  private requireAgent(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new HarnessError("AGENT_NOT_FOUND", { agent_id: id, owner_id: this.options.owner.owner_id });
    return agent;
  }
  private current(run: ManagedRun): boolean {
    return !this.closed && run.record.generation === this.options.owner.generation &&
      this.runs.get(run.record.run_id) === run && this.agents.get(run.record.agent_id)?.current === run.record.run_id;
  }
  private changed(kind: ContextChange["kind"], run: ManagedRun): string {
    const event_id = randomUUID();
    try {
      const result: unknown = this.options.onContextChange?.({ event_id, kind, owner_id: this.options.owner.owner_id,
        generation: this.options.owner.generation, agent_id: run.record.agent_id, run_id: run.record.run_id,
        session_id: run.session?.session_id });
      if (result !== undefined) {
        // Reject async consumers without leaking their rejected promises. This
        // cannot undo side effects or cancel work they started before returning.
        void Promise.resolve(result).catch(() => {});
        throw new Error("onContextChange must synchronously return undefined");
      }
    } catch (error) { throw new HarnessError("CONTEXT_CHANGE_FAILED", { error: errorText(error) }); }
    return event_id;
  }
  private wake(): void { for (const watcher of [...this.watchers]) watcher(); }
  private historyFailed(run: ManagedRun, error: unknown): string {
    run.quarantine = "history_error";
    // A child writer is local. Only a failed SHARED parent SDK write blocks the owner.
    if (error instanceof ParentHistoryError) this.latchParentHistoryFailure(error);
    return run.record.history_error ??= errorText(error);
  }
  private track(promise: Promise<void>): void {
    const tracked = promise.catch((error: unknown) => { this.cleanupUncertain = true; this.internalError = errorText(error); this.wake(); });
    this.tasks.add(tracked);
    // Classification above owns failures; this observer only forgets settled
    // work, including rejection while notifying a watcher. Do not fork an
    // unobserved rejecting promise with finally().
    void tracked.then(() => { this.tasks.delete(tracked); }, () => { this.tasks.delete(tracked); });
  }

  private validate(request: SubmitRequest): void {
    const reuse = "resume" in request;
    const allowed = reuse ? ["resume", "prompt", "description", "max_turns", "max_duration_ms", "answer_to_run_id"] :
      ["prompt", "description", "max_turns", "max_duration_ms", "name", "settings"];
    for (const key of Object.keys(request)) {
      if (allowed.includes(key)) continue;
      if (reuse && ["settings", "model", "provider", "thinking", "effort", "effort_source", "effort_overrides", "difficulty", "strength", "preset", "subagent_type", "profile", "inherit_context", "cwd", "tools", "name"].includes(key)) {
        throw new HarnessError("IMMUTABLE_SETTING", { key, effective_settings: settingsView(this.requireAgent(request.resume).settings) });
      }
      throw new HarnessError("UNSUPPORTED_PARAMETER", { key, allowed });
    }
    for (const [key, value, required, max] of [
      ["prompt", request.prompt, true, 131072], ["description", request.description, !reuse, 4096],
      ...(!reuse ? [["name", request.name, false, 256]] : []),
    ] as Array<[string, unknown, boolean, number]>) {
      if ((required || value !== undefined) && (typeof value !== "string" || !value.trim() || value.length > max)) {
        throw new HarnessError("INVALID_PARAMETER", { key });
      }
    }
    if (request.max_turns !== undefined && (!positive(request.max_turns) || request.max_turns > 10000)) throw new HarnessError("INVALID_PARAMETER", { key: "max_turns" });
    if (request.max_duration_ms !== undefined && (!positive(request.max_duration_ms) || request.max_duration_ms > 86_400_000))
      throw new HarnessError("INVALID_PARAMETER", { key: "max_duration_ms" });
    if (!reuse && !validSettings(request.settings)) throw new HarnessError("INVALID_EFFECTIVE_SETTINGS");
  }

  get identity() { return { owner_id: this.options.owner.owner_id, generation: this.options.owner.generation }; }
  /** Monotonic acceptance fact for tool exposure/replacement confirmation.
   * Run records are never evicted; this is not proof of Owner closure. */
  get hasAcceptedRuns(): boolean { return this.runs.size > 0; }

  /** A synchronous SDK append to the shared parent threw. The SDK may already
   * have changed memory or disk, so this is a sticky safety latch, not rollback. */
  latchParentHistoryFailure(error: unknown): void {
    const failure = error instanceof ParentHistoryError ? error : new ParentHistoryError(error);
    this.parentError ??= errorText(failure);
    this.wake();
  }

  /** Shared gate for anything that must not begin once any peer has observed
   * owner loss: parent-session writes outside Run history (the preset audit)
   * and every asynchronous boundary inside execute(). Sticky by design, so
   * apparent recovery cannot admit later work. Inspection, cancellation,
   * release, result reads and drain all remain available. */
  assertOwnerAvailable(): void {
    if (this.closed || this.closing) throw new HarnessError("OWNER_CLOSED");
    if (this.cleanupUncertain) throw new HarnessError("OWNER_CLEANUP_UNCERTAIN");
    if (this.internalError) throw new HarnessError("OWNER_INTERNAL_ERROR", { error: this.internalError });
    if (this.parentError) throw new HarnessError("OWNER_PARENT_UNAVAILABLE", { error: this.parentError });
    try { this.options.owner.assertHeld(); }
    catch (error) { this.internalError ??= errorText(error); this.wake(); throw error; }
  }

  private admissionState(): { enabled: boolean; revision: number } | undefined {
    try {
      const reader = this.options.admission;
      if (reader === undefined) return { enabled: true, revision: 0 };
      if (typeof reader !== "function") return undefined;
      const state: unknown = reader();
      if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
      const { enabled, revision } = state as { enabled?: unknown; revision?: unknown };
      if (typeof enabled !== "boolean" || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined;
      return { enabled, revision };
    } catch { return undefined; }
  }
  private assertNewWorkAdmission(captured: { enabled: boolean; revision: number } | undefined): void {
    const current = this.admissionState();
    if (!captured?.enabled || !current?.enabled || current.revision !== captured.revision) throw new HarnessError("WORKERS_DISABLED");
  }
  private assertExternalSteerAdmission(): void {
    if (!this.admissionState()?.enabled) throw new HarnessError("WORKERS_DISABLED");
  }

  submit(request_id: string, input: SubmitRequest): Promise<RunView> {
    return this.submitPrepared(request_id, input, (request) => request);
  }

  /** Trusted synchronous preparation, not another queue or request cache.
   * Identity is the caller's explicit input; defaults must be captured by the
   * host before this call. A retry never prepares again. No SDK types in core. */
  submitPrepared<T extends object>(request_id: string, input: T, prepare: (identity: T) => SubmitRequest): Promise<RunView> {
    if (typeof request_id !== "string" || !request_id || request_id.length > 256) return Promise.reject(new HarnessError("INVALID_REQUEST_ID"));
    // Capture before awaiting another admission; caller mutation cannot drift it.
    let captured: { request: T; request_digest: string };
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      const encoded = stable(structuredClone(input));
      // Prepare the SAME normalized value whose identity was hashed, so it
      // cannot distinguish omitted/undefined properties or shared references.
      const request = JSON.parse(encoded) as T;
      captured = { request, request_digest: sha256(encoded) };
    } catch { return Promise.reject(new HarnessError("INVALID_SUBMIT")); }
    const { request_digest } = captured;
    // A request cannot wait behind another admission and cross an Off -> On
    // transition. Existing request identity still wins before this gate.
    const admission = this.admissionState();
    const submission = this.submitTail.then(async () => {
      const old = this.requests.get(request_id);
      if (old) {
        if (this.requireRun(old).record.request_digest !== request_digest) throw new HarnessError("REQUEST_CONFLICT");
        return this.view(old); // Owner-local idempotence precedes busy/capacity/error gates.
      }
      this.assertNewWorkAdmission(admission);
      const prepared = prepare(structuredClone(captured.request));
      if (prepared && (typeof prepared === "object" || typeof prepared === "function") && "then" in prepared) {
        void Promise.resolve(prepared).catch(() => {});
        throw new HarnessError("ASYNC_PREPARE");
      }
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) throw new HarnessError("INVALID_SUBMIT");
      const request = structuredClone(prepared);
      // A trusted preparer can synchronously reenter the host and change the
      // selected preset. Do not allocate a Run after that transition.
      this.assertNewWorkAdmission(admission);
      // Recheck after preparation, including sticky loss first observed here.
      this.assertOwnerAvailable();
      this.validate(request);
      if (this.runs.size >= this.limits.historyRuns ||
          this.limits.output > this.limits.historyOutput - this.retainedOutputChars - this.reservedOutputChars) {
        throw new HarnessError("OWNER_HISTORY_LIMIT", { agents: this.agents.size, runs: this.runs.size, requests: this.requests.size,
          run_limit: this.limits.historyRuns, retained_output_chars: this.retainedOutputChars,
          reserved_output_chars: this.reservedOutputChars, output_char_limit: this.limits.historyOutput,
          resolution: "Close this owner and start a fresh session; retained Runs are never evicted." });
      }
      if (this.queue.length >= this.limits.queue) throw new HarnessError("QUEUE_FULL");
      const reuse = "resume" in request;
      // An unnamed Agent stays unnamed. Every surface falls back to the profile,
      // which tells the operator more than a synthesized `worker-<uuid>` handle.
      const agent: Agent = reuse ? this.requireAgent(request.resume) : {
        id: randomUUID(), name: request.name ?? "", settings: structuredClone(request.settings), resident: true,
      };
      if (agent.current) throw new HarnessError("AGENT_BUSY", { run_id: agent.current });
      if (reuse && (!agent.session || agent.unavailable)) throw new HarnessError("AGENT_UNAVAILABLE", { reason: agent.unavailable });
      if (!reuse && [...this.agents.values()].filter((a) => a.resident).length >= this.limits.resident) throw new HarnessError("RESIDENT_LIMIT");
      if (agent.question) {
        if (!reuse || !request.answer_to_run_id) throw new HarnessError("PENDING_QUESTION", { run_id: agent.question.run_id });
        if (request.answer_to_run_id !== agent.question.run_id || agent.question.reserved_by) throw new HarnessError("STALE_ANSWER");
      } else if (reuse && request.answer_to_run_id) throw new HarnessError("STALE_ANSWER");
      const record: RunRecord = {
        owner_id: this.options.owner.owner_id, generation: this.options.owner.generation,
        run_id: randomUUID(), agent_id: agent.id, request_id, request_digest, enqueue_sequence: ++this.sequence,
        name: agent.name, settings: structuredClone(agent.settings), prompt: request.prompt,
        description: request.description ?? "Follow-up task", max_turns: request.max_turns ?? 256,
        max_duration_ms: request.max_duration_ms ?? 1_800_000,
        ...(reuse && request.answer_to_run_id ? { answer_to_run_id: request.answer_to_run_id } : {}),
        input_entered: false, status: "queued", phase: "queued", execution_exited: false,
        submitted_at: this.clock.wall(), turns: 0, limit_reached: false, cleanup_errors: [], discarded_inputs: [],
      };
      const run: ManagedRun = { record, output: emptyOutput(), submittedMono: this.clock.mono(), inputOpen: false,
        active: false, outputReserved: true, inputs: new Set(), inputCount: 0, notificationDrops: 0,
        hadSession: !!agent.session, session: agent.session };
      agent.current = record.run_id;
      if (agent.question) agent.question.reserved_by = record.run_id;
      this.agents.set(agent.id, agent);
      this.reservedOutputChars += this.limits.output;
      this.runs.set(record.run_id, run); this.requests.set(request_id, record.run_id); this.queue.push(record.run_id);
      try { this.changed(reuse ? "resume" : "submit", run); }
      catch (error) {
        run.quarantine = "context_change_failed";
        this.removeQueued(record.run_id);
        this.track(this.finish(run, { kind: "error", error: errorText(error), output: emptyOutput() }));
      }
      if (this.closing) this.cancel(record.run_id);
      this.pump(); this.wake();
      return this.view(record.run_id);
    });
    this.submitTail = submission.catch(() => {});
    return submission;
  }

  private removeQueued(id: string): void {
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
  }
  private pump(): void {
    while (this.active < this.limits.concurrency && this.queue.length) {
      // Recheck every iteration: execute/begin may throw synchronously and
      // release its slot while this very pump still has queued work.
      if (this.closing || this.closed || this.parentError || this.internalError || this.cleanupUncertain) return;
      try { this.options.owner.assertHeld(); }
      catch (error) { this.internalError = errorText(error); this.wake(); return; }
      const run = this.requireRun(this.queue.shift()!);
      if (run.record.status !== "queued") continue;
      run.active = true; this.active++;
      run.executionStartedMono = this.clock.mono();
      run.record.status = "running"; run.record.phase = "initializing"; run.record.started_at = this.clock.wall();
      // Real event-loop time, like wait(): a stop request, not a hard interrupt.
      // A late callback cannot demote a Run whose execution exit was recorded.
      run.deadlineTimer = setTimeout(() => this.stop(run, "deadline"), run.record.max_duration_ms);
      run.deadlineTimer.unref?.();
      this.track(this.execute(run));
    }
  }
  private output(run: ManagedRun, value: Output): boolean {
    if (!validOutput(value)) {
      run.quarantine = "invalid_execution_facts";
      run.record.cleanup_errors.push("INVALID_OUTPUT");
      return false;
    }
    const revision = value.revision ?? 0, previous = run.output.revision ?? 0;
    if (revision < previous) return false;
    if (revision === previous && (value.total_chars < run.output.total_chars || !value.text.startsWith(run.output.text))) return false;
    const bounded = boundedOutput(value.text, this.limits.output);
    run.output = { ...bounded, total_chars: value.total_chars, truncated: value.truncated || bounded.truncated, revision };
    return true;
  }
  private wrapUp(run: ManagedRun): void {
    if (run.record.limit_reached || run.record.stop_reason || run.record.execution_exited) return;
    run.record.limit_reached = true;
    try { this.dispatchInput(run, softBudgetMessage, "soft_budget"); }
    catch (error) { run.record.cleanup_errors.push(`SOFT_BUDGET_MESSAGE_REJECTED: ${errorText(error)}`); }
  }
  private async execute(run: ManagedRun): Promise<void> {
    const agent = this.requireAgent(run.record.agent_id);
    let facts: ExecutionFacts;
    try {
      const port = agent.session ?? await this.options.createSession({ agent_id: agent.id, name: agent.name, settings: structuredClone(agent.settings) });
      agent.session = run.session = port;
      // Session creation can await arbitrary SDK initialization. Recheck even
      // without a journal, and keep owner loss out of child-history diagnosis.
      this.assertOwnerAvailable();
      if (!run.record.stop_reason && port.history) {
        try {
          run.record.history_ref = await port.history.begin({ owner_id: run.record.owner_id, generation: run.record.generation,
            agent_id: agent.id, run_id: run.record.run_id }, run.record.settings);
        } catch (error) {
          // A rejected begin is still an async boundary. Prefer a sticky/shared
          // owner loss over misclassifying this Run as a damaged child writer.
          this.assertOwnerAvailable();
          this.historyFailed(run, error);
          throw error;
        }
        // begin() is another async boundary. A peer may have latched owner loss
        // while this writer was awaiting it; no prompt may be admitted after.
        this.assertOwnerAvailable();
      }
      if (run.record.stop_reason) {
        facts = { kind: "aborted", output: emptyOutput() };
      } else {
        this.assertOwnerAvailable();
        run.record.phase = "executing"; run.inputOpen = true;
        const callbacks: RunCallbacks = {
          inputEntered: () => {
            if (!this.current(run) || run.record.execution_exited) return;
            run.record.input_entered = true;
            if (agent.question?.reserved_by === run.record.run_id) agent.question = undefined;
          },
          output: (value) => { if (this.current(run) && !run.record.execution_exited) this.output(run, value); },
          runtime: (value) => {
            if (!this.current(run) || run.record.execution_exited) return;
            let next: RunTelemetry | undefined;
            try { next = normalizeRuntime(structuredClone(value)); } catch { return; }
            if (!next) return;
            const previous = run.runtime;
            run.runtime = { activity: next.activity, context: next.context ?? previous?.context,
              usage: next.usage ? cumulativeUsage(previous?.usage, next.usage) : previous?.usage };
          },
          drain: (waiting_for) => {
            if (!this.current(run) || run.record.execution_exited || !["deliveries", "sdk_idle"].includes(waiting_for)) return;
            run.drain = { waiting_for, startedMono: run.drain?.startedMono ?? this.clock.mono() };
          },
          turnStart: () => {
            if (!this.current(run) || run.record.execution_exited) return;
            run.record.turns++; run.turnStarted = this.clock.mono();
            if (run.record.turns > run.record.max_turns + this.limits.grace) {
              run.record.limit_reached = true; this.stop(run, "hard_budget");
            } else if (run.record.turns > run.record.max_turns) this.wrapUp(run);
          },
          turnEnd: (continuing) => {
            if (!this.current(run)) return;
            // Kept until the next turn starts or execution exits, so the UI reads
            // "time since the last turn began" instead of blinking out between turns.
            if (continuing && run.record.turns >= run.record.max_turns) this.wrapUp(run);
          },
          question: (text) => {
            if (!this.current(run) || run.record.execution_exited) return;
            // A question must remain answerable in full, including for trusted
            // ports that do not use the model tool schema. Reject, never slice.
            if (typeof text !== "string" || !text.trim() || text.length > 8192) throw new HarnessError("INVALID_QUESTION");
            run.question = text;
          },
          notify: (text) => {
            if (!this.current(run) || run.record.execution_exited) return;
            if (this.messages.length === 64) this.requireRun(this.messages.shift()!.run_id).notificationDrops++;
            this.messages.push({ event_id: randomUUID(), run_id: run.record.run_id, text: boundedOutput(text, 8192).text });
            // Progress is visible through the polling widget and is collected by
            // the next meaningful wait result. It never wakes the parent model.
          },
        };
        const prompt = !run.hadSession && run.record.settings.context_snapshot ?
          `${run.record.settings.context_snapshot}\n\n${run.record.prompt}` : run.record.prompt;
        facts = await port.run(prompt, callbacks, { owner_id: run.record.owner_id, generation: run.record.generation,
          agent_id: run.record.agent_id, run_id: run.record.run_id, task_prompt: run.record.prompt });
      }
    } catch (error) {
      if (error instanceof SessionUnavailableError) run.quarantine = error.reason;
      // Record the affected writer's uncertainty without poisoning healthy peers.
      if (run.session?.history?.error) this.historyFailed(run, run.session.history.error);
      if (error instanceof SessionInitializationError) {
        this.cleanupUncertain = true;
        run.quarantine = "cleanup_uncertain";
        run.record.cleanup_errors.push(errorText(error));
      }
      facts = { kind: "error", error: errorText(error), output: run.output,
        // A quarantined session may still have billed for what it did stream.
        ...(error instanceof SessionUnavailableError && error.usage ? { usage: error.usage } : {}) };
    }
    await this.finish(run, facts);
  }

  private async finish(run: ManagedRun, facts: ExecutionFacts): Promise<void> {
    if (!this.current(run) || run.record.execution_exited) return;
    run.inputOpen = false; run.record.execution_exited = true;
    clearTimeout(run.deadlineTimer); run.deadlineTimer = undefined;
    run.record.exited_at = this.clock.wall(); run.record.phase = "finalizing"; run.turnStarted = undefined;
    run.record.execution_elapsed_ms = run.executionStartedMono === undefined ? undefined :
      Math.max(0, this.clock.mono() - run.executionStartedMono);
    if (run.active) { run.active = false; this.active--; }
    const normalized = normalizeFacts(facts, run.output);
    facts = normalized.facts;
    if (normalized.invalid) run.quarantine = "invalid_execution_facts";
    // A port may preserve a new SDK stop reason before this controller knows
    // its semantics. Only Pi's explicit normal terminal reasons can support a
    // successful outcome; absence remains compatible with non-SDK ports.
    if (facts.kind === "success" && facts.model_stop_reason &&
        !["stop", "toolUse"].includes(facts.model_stop_reason)) facts = { ...facts, kind: "error",
      error: facts.error ?? (facts.model_stop_reason === "length" ? "MODEL_OUTPUT_LIMIT" :
        `UNEXPECTED_MODEL_STOP_REASON: ${facts.model_stop_reason}`) };
    if (!this.output(run, facts.output)) {
      // Different messages may replace each other; a final report may not erase
      // the last observed prefix within the SAME message revision.
      run.output = { ...run.output, truncated: true };
      run.quarantine = "output_uncertain"; run.record.cleanup_errors.push("EXECUTION_OUTPUT_REGRESSED");
      if (facts.kind === "success") facts = { ...facts, kind: "error", error: "EXECUTION_OUTPUT_REGRESSED" };
    }
    if (run.quarantine === "invalid_execution_facts") facts = { ...facts, kind: "error", error: "INVALID_EXECUTION_FACTS" };
    run.record.usage = facts.usage ? cumulativeUsage(run.runtime?.usage, facts.usage) : run.runtime?.usage;
    run.record.model_stop_reason = facts.model_stop_reason;
    // Settling is the one moment a Run's spend becomes final, so accruing here
    // reports every Run exactly once — including the cancelled and failed ones,
    // which cost real money, and the ones whose result the model never fetches.
    // Already split by responding model: the port sees each response, this
    // only rolls settled Runs together. Attributing here would bill a router
    // alias instead of whatever answered behind it.
    this.unreported = mergeLedgers(this.unreported, run.record.usage);
    const agent = this.requireAgent(run.record.agent_id);
    if (agent.question?.reserved_by === run.record.run_id && !run.record.input_entered) agent.question.reserved_by = undefined;
    const stopped = run.record.stop_reason;
    run.record.outcome = {
      status: stopped === "user_cancel" ? "cancelled" : stopped === "hard_budget" || stopped === "deadline" || facts.kind !== "success" ? "failed" : run.question ? "needs_input" : "completed",
      model_stop_reason: facts.model_stop_reason,
      reason: stopped === "hard_budget" ? "turn_limit" : stopped === "deadline" ? "deadline" : stopped ? undefined :
        facts.model_stop_reason === "length" ? "output_limit" :
        run.quarantine === "context_change_failed" ? "context_change_failed" : facts.kind === "aborted" ? "unexpected_abort" :
          facts.kind === "error" ? "execution_error" : undefined,
      error: facts.error?.slice(0, 2048), question: run.question, limit_reached: run.record.limit_reached,
    };
    // A freed execution slot belongs to healthy peers, even while this Run's
    // input/finalization/isolated session cleanup drains. Its own Agent stays busy.
    this.wake(); this.pump();
    // No new input can be accepted now. Already accepted async deliveries must
    // settle before SDK queue clearing or reuse. A hung delivery keeps ownership.
    await Promise.all([...run.inputs]);
    if (run.session) {
      try { run.record.discarded_inputs.push(...run.session.clearInputs()); }
      catch (error) { run.quarantine = error instanceof SessionUnavailableError ? error.reason : "input_cleanup_uncertain"; run.record.cleanup_errors.push(errorText(error)); }
    }
    if (facts.kind === "success" && !run.record.input_entered) {
      run.quarantine = "input_not_observed";
      if (!stopped) run.record.outcome = { ...run.record.outcome, status: "failed", reason: "input_not_observed" };
    }
    if (run.quarantine || (!run.hadSession && !run.record.input_entered)) {
      run.cleanup = this.releaseAgent(agent, run.quarantine ?? (run.record.stop_reason === "user_cancel" ? "cancelled_before_start" : "initialization_failed"), run);
      await run.cleanup; // Known cleanup facts precede optional history metadata.
    }
    const finished: RunRecord = { ...run.record, status: run.record.outcome.status,
      phase: "settled", finished_at: this.clock.wall(), result: describeResult(run.record.run_id, run.output),
      elapsed_ms: Math.max(0, this.clock.mono() - run.submittedMono) };
    if (finished.history_ref && run.session?.history) {
      try {
        // An earlier loss is sticky even if the lock path later looks healthy.
        if (this.internalError) throw new HarnessError("OWNER_INTERNAL_ERROR", { error: this.internalError });
        try { this.options.owner.assertHeld(); }
        catch (error) {
          // Loss of shared authority blocks the entire owner, not only this
          // child writer. Skip the write, but still settle proven-exited work
          // and its output reservation; never leave it stuck in finalizing.
          this.internalError ??= errorText(error);
          throw error;
        }
        finished.history_ref = await run.session.history.finish(finished.history_ref, { ...finished.outcome! }, { ...run.output }, finished.usage);
      } catch (error) { finished.history_error = this.historyFailed(run, error); }
    }
    // Input drain and history no longer need this per-Run reference. The Agent
    // or an in-flight release owns the port, never the retained result record.
    run.session = undefined;
    if (run.outputReserved) {
      this.reservedOutputChars -= this.limits.output;
      this.retainedOutputChars += run.output.text.length;
      run.outputReserved = false;
    }
    run.record = finished; // Completion is live state, NOT a durability promise.
    if (run.quarantine && !agent.release) {
      run.cleanup = this.releaseAgent(agent, run.quarantine, run);
      this.track(run.cleanup); // Volatile results may be observed while cleanup drains.
    }
    if (run.record.status === "needs_input" && agent.session && !agent.unavailable) agent.question = { run_id: run.record.run_id };
    agent.current = undefined;
    if (agent.cleanupComplete) agent.resident = false;
    if (!agent.session && !agent.release) { agent.resident = false; agent.unavailable = "initialization_failed"; }
    this.wake(); this.pump();
  }

  private acceptsInput(run: ManagedRun): boolean {
    return this.current(run) && run.inputOpen && !run.record.execution_exited && run.record.status === "running" && !run.record.stop_reason && !!run.session?.canInput();
  }
  steer(run_id: string, message: string): { accepted: true; event_id: string } {
    return this.dispatchInput(this.requireRun(run_id), message, "steer");
  }
  private assertInputOpen(run: ManagedRun): void {
    if (this.cleanupUncertain) throw new HarnessError("OWNER_CLEANUP_UNCERTAIN");
    if (this.internalError) throw new HarnessError("OWNER_INTERNAL_ERROR", { error: this.internalError });
    if (this.parentError) throw new HarnessError("OWNER_PARENT_UNAVAILABLE", { error: this.parentError });
    if (!this.acceptsInput(run)) throw new HarnessError("RUN_INPUT_CLOSED");
  }
  private dispatchInput(run: ManagedRun, message: string, kind: "steer" | "soft_budget"): { accepted: true; event_id: string } {
    this.assertInputOpen(run);
    // Resolve unknown/closed input first, preserving terminal-result replies even
    // through cached tools while Off. Only new external input needs admission;
    // internal finish-budget input remains allowed for already accepted work.
    if (kind === "steer") {
      this.assertExternalSteerAdmission();
      // The trusted admission callback may reenter; retain the original post-
      // callback Owner/input guards before recording or scheduling delivery.
      this.assertInputOpen(run);
    }
    if (typeof message !== "string" || !message.trim() || message.length > 16384) throw new HarnessError("INVALID_MESSAGE");
    if (kind === "steer" && run.inputCount >= 64) throw new HarnessError("INPUT_LIMIT");
    const event_id = this.changed(kind, run);
    if (kind === "steer") run.inputCount++;
    // Schedule after recording the reservation, so synchronous port exceptions
    // and very fast exits are handled exactly like asynchronous preparation.
    const delivery = Promise.resolve().then(() => run.session!.steer(message, () => this.acceptsInput(run))).then((queued) => {
      if (!queued) run.record.discarded_inputs.push(message);
    }).catch((error: unknown) => {
      run.record.cleanup_errors.push(errorText(error)); run.quarantine = "input_delivery_uncertain";
    });
    run.inputs.add(delivery);
    // Delivery failure was classified above; cleanup observes both outcomes.
    void delivery.then(() => run.inputs.delete(delivery), () => run.inputs.delete(delivery));
    return { accepted: true, event_id };
  }
  private stop(run: ManagedRun, reason: StopReason): void {
    if (run.record.execution_exited || terminal(run.record.status) || run.record.stop_reason) return;
    // Freeze before calling a consumer, which may throw or reenter cancel().
    run.record.stop_reason = reason; run.inputOpen = false;
    try { this.changed(reason === "user_cancel" ? "cancel" : reason, run); }
    catch (error) { run.quarantine = "context_change_failed"; run.record.cleanup_errors.push(errorText(error)); }
    const queued = run.record.status === "queued";
    run.record.status = "cancelling";
    if (queued) {
      this.removeQueued(run.record.run_id);
      this.track(this.finish(run, { kind: "aborted", output: run.output }));
    } else if (run.session) {
      // stop() may hang; only run() completion is execution-exit evidence.
      const stopping = Promise.resolve().then(() => run.session!.stop()).catch((error: unknown) => {
        run.quarantine = "stop_uncertain"; run.record.cleanup_errors.push(errorText(error));
      });
      run.inputs.add(stopping);
      // Stop failure was classified above; cleanup is not another stop owner.
      void stopping.then(() => run.inputs.delete(stopping), () => run.inputs.delete(stopping));
    }
    this.wake();
  }
  cancel(run_id: string) {
    const run = this.requireRun(run_id);
    const result = terminal(run.record.status) ? "already_terminal" : run.record.execution_exited ? "already_exited" : "cancel_requested";
    const already_stopping = !!run.record.stop_reason;
    if (result === "cancel_requested") this.stop(run, "user_cancel");
    const snapshot = this.view(run_id);
    return { result, already_stopping, execution_exited: snapshot.execution_exited,
      finalization_pending: snapshot.finalization_pending, stop_reason: snapshot.stop_reason, snapshot };
  }

  private drainView(run: ManagedRun): RunView["drain"] {
    return run.record.execution_exited || !run.drain ? undefined : {
      waiting_for: run.drain.waiting_for, elapsed_ms: Math.max(0, this.clock.mono() - run.drain.startedMono) };
  }

  view(run_id: string): RunView {
    const run = this.requireRun(run_id), record = run.record, agent = this.requireAgent(record.agent_id);
    const unavailable = this.closed || this.closing ? "owner_closed" : this.cleanupUncertain ? "owner_cleanup_uncertain" : this.internalError ? "owner_internal_error" : this.parentError ? "owner_parent_unavailable" :
      agent.unavailable ?? (agent.current ? "agent_busy" : !agent.session ? "session_unavailable" : undefined);
    return structuredClone({ owner_id: record.owner_id, generation: record.generation, run_id, agent_id: record.agent_id,
      name: record.name, description: record.description, effective_settings: settingsView(record.settings),
      status: record.status, phase: record.phase, execution_exited: record.execution_exited,
      history_ref: record.history_ref, history_error: record.history_error, drain: this.drainView(run),
      finalization_pending: record.execution_exited && !terminal(record.status), resident: agent.resident, resumable: !unavailable,
      unavailable_reason: unavailable, owner_error: this.parentError ?? this.internalError,
      owner_blocked: !!this.parentError || !!this.internalError || this.cleanupUncertain,
      isolation: "shared", elapsed_ms: record.elapsed_ms ?? Math.max(0, this.clock.mono() - run.submittedMono),
      turn_elapsed_ms: run.turnStarted === undefined ? undefined : Math.max(0, this.clock.mono() - run.turnStarted),
      turns: record.turns, max_turns: record.max_turns, max_duration_ms: record.max_duration_ms,
      execution_elapsed_ms: record.execution_elapsed_ms ?? (run.executionStartedMono === undefined ? undefined :
        Math.max(0, this.clock.mono() - run.executionStartedMono)), runtime: run.runtime,
      stop_reason: record.stop_reason, model_stop_reason: record.model_stop_reason, outcome: record.outcome,
      usage: record.usage ?? run.runtime?.usage, result_ref: record.result,
      cleanup_errors: record.cleanup_errors, discarded_inputs: record.discarded_inputs,
      notification_drops: run.notificationDrops, pending_messages: this.messages.filter((m) => m.run_id === run_id).length });
  }
  /**
   * Child spend observed since the last drain, for the host to attribute to its
   * own accounting. Draining clears it, so the caller must actually report what
   * it takes; nothing is accrued twice and nothing is replayed.
   *
   * Residue after the parent's last tool result is not merged into Pi totals.
   * stats().unreported_usage exposes it without draining; the Pi adapter records
   * non-additive close/shutdown audit snapshots, and Run END metadata retains
   * observed usage independently. These records do not bill Pi's footer and
   * abrupt process loss can still prevent final checkpoints. See README,
   * "Remaining parent-total gap".
   */
  drainUsage(): UsageLedger | undefined {
    const pending = this.unreported;
    this.unreported = undefined;
    return pending;
  }
  /** Puts a drained ledger back, for a caller that could not deliver it. The
   * drain is destructive by design, so the only way a failed handover is not a
   * silent loss is for the caller to hand the money back. */
  returnUsage(ledger: UsageLedger | undefined): void {
    this.unreported = mergeLedgers(this.unreported, ledger);
  }
  list(options: { include_released?: boolean } = {}): RunView[] {
    const latest = new Map<string, string>();
    for (const run of this.runs.values()) {
      if (options.include_released === false && !this.requireAgent(run.record.agent_id).resident) continue;
      latest.set(run.record.agent_id, run.record.run_id);
    }
    return [...latest.values()].map((id) => this.view(id));
  }
  stats() {
    const draining = [...this.runs.values()].flatMap((run) => {
      const drain = this.drainView(run);
      return drain ? [{ run_id: run.record.run_id, agent_id: run.record.agent_id, ...drain }] : [];
    });
    return { active: this.active, queued: this.queue.length, ...(draining.length ? { draining } : {}),
    resident: [...this.agents.values()].filter((a) => a.resident).length,
    agents: this.agents.size, runs: this.runs.size, requests: this.requests.size,
    retained_output_chars: this.retainedOutputChars, reserved_output_chars: this.reservedOutputChars,
    unreported_usage: this.unreported ? structuredClone(this.unreported) : undefined,
    finalizing: [...this.runs.values()].filter((r) => r.record.execution_exited && !terminal(r.record.status)).length,
    parent_error: this.parentError, internal_error: this.internalError, cleanup_uncertain: this.cleanupUncertain, cleaning: this.cleaning, closed: this.closed }; }

  getResult(run_id: string, options: { cursor?: string; limit?: number } = {}): ResultPage {
    const run = this.requireRun(run_id), limit = options.limit ?? 4096;
    if (!positive(limit) || limit > 16384) throw new HarnessError("INVALID_LIMIT");
    let offset = 0;
    const version = run.record.result?.digest ?? sha256(run.output.text);
    if (options.cursor) {
      if (typeof options.cursor !== "string" || options.cursor.length > 1024) throw new HarnessError("INVALID_CURSOR");
      if (!terminal(run.record.status)) throw new HarnessError("RESULT_NOT_FINAL");
      try {
        const c = JSON.parse(Buffer.from(options.cursor, "base64url").toString()) as Record<string, unknown>;
        if (c.owner !== this.options.owner.owner_id || c.run !== run_id || c.version !== version ||
            typeof c.offset !== "number" || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > run.output.text.length ||
            (c.offset > 0 && /[\uD800-\uDBFF]/.test(run.output.text[c.offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(run.output.text[c.offset] ?? ""))) throw new Error();
        offset = c.offset;
      } catch { throw new HarnessError("INVALID_CURSOR"); }
    }
    // A one-character page may need two UTF-16 units for a supplementary glyph.
    let end = Math.min(run.output.text.length, offset + limit);
    if (/[\uD800-\uDBFF]/.test(run.output.text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(run.output.text[end] ?? "")) end++;
    const truncated = end < run.output.text.length || run.output.truncated;
    const final = terminal(run.record.status);
    return { snapshot: this.view(run_id), text: run.output.text.slice(offset, end), complete: final && !truncated,
      truncated, retained_chars: run.output.text.length, total_chars: run.output.total_chars, result_ref: run.record.result,
      ...(final && end < run.output.text.length ? { next_cursor: Buffer.from(JSON.stringify({ owner: this.options.owner.owner_id, run: run_id, version, offset: end })).toString("base64url") } : {}) };
  }

  async wait(run_ids: string[], options: { mode: "any" | "all"; timeout_ms?: number; signal?: AbortSignal; include_results?: boolean; result_limit?: number }): Promise<WaitResult> {
    const ids = [...new Set(run_ids)], limit = options.result_limit ?? 1024;
    if (!ids.length || ids.length > 16 || !["any", "all"].includes(options.mode) || !positive(limit) || limit > 16384 ||
        (options.timeout_ms !== undefined && (!Number.isFinite(options.timeout_ms) || options.timeout_ms < 0 || options.timeout_ms > 2147483647))) return Promise.reject(new HarnessError("INVALID_WAIT"));
    for (const id of ids) this.requireRun(id);
    return new Promise((resolve) => {
      // Broadcast a new fault to every already-pending waiter, even when the
      // first one reports it synchronously. Later waits still see a consumed
      // owner edge rather than immediately returning the same fault forever.
      const reportedBlockAtStart = this.reportedBlock;
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const claimProgress = (): ProgressEvent[] | undefined => {
        const claimed: ProgressEvent[] = [];
        // Drain matching terminal Runs only. A peer's completion must not
        // consume another, still-running Run's progress through the lossy
        // model projection. The owner inbox remains bounded at 64 events.
        for (let index = 0; index < this.messages.length;) {
          const run_id = this.messages[index]!.run_id;
          if (!ids.includes(run_id) || !terminal(this.requireRun(run_id).record.status)) { index++; continue; }
          claimed.push(this.messages.splice(index, 1)[0]!);
        }
        return claimed.length ? claimed : undefined;
      };
      const finish = (reason: WaitResult["reason"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); this.watchers.delete(check); options.signal?.removeEventListener("abort", interrupted);
        // Timeout and Esc preserve buffered progress for the next normal return.
        const progress = reason === "timeout" || reason === "interrupted" ? undefined : claimProgress();
        resolve({ reason, snapshots: ids.map((id) => this.view(id)), progress,
          ...(options.include_results === false ? {} : { results: ids.filter((id) => terminal(this.requireRun(id).record.status)).map((id) => this.getResult(id, { limit })) }) });
      };
      const interrupted = () => finish("interrupted");
      const check = (): boolean => {
        if (settled) return true;
        const runs = ids.map((id) => this.requireRun(id));
        const flags = runs.map((run) => terminal(run.record.status));
        const condition = options.mode === "all" ? flags.every(Boolean) : flags.some(Boolean);
        // Attention is terminal-state based. An early outcome/question callback
        // while a Run is finalizing cannot make its Agent reusable or wake all.
        const attention = runs.some((run) => run.record.status === "needs_input" || run.record.status === "failed" ||
          run.record.status === "cancelled" || (run.record.status === "completed" && !!run.record.outcome?.limit_reached));
        const blocked = this.cleanupUncertain ? "cleanup_uncertain" : this.internalError ?? this.parentError;
        const newBlock = !!blocked && blocked !== reportedBlockAtStart;
        // Preserve any's level semantics, including Runs terminal before this
        // call. For all, a normal completed peer does not end the wait; an
        // attention terminal does. Attention is level-triggered too: one waiter
        // must not consume another's readiness (or lose it with a stale reply).
        // Callers remove handled Runs from the next wait, using pending_run_ids.
        // A satisfied condition may still say condition.
        const reason: WaitResult["reason"] | undefined = condition ? "condition" : attention ? "attention" :
          newBlock ? "owner_blocked" : undefined;
        if (!reason) return false;
        if (reason === "owner_blocked") this.reportedBlock = blocked;
        finish(reason);
        return true;
      };
      // One synchronous state read + subscription: no completion can fall in a gap.
      if (options.signal?.aborted) { interrupted(); return; }
      if (check()) return;
      this.watchers.add(check); options.signal?.addEventListener("abort", interrupted, { once: true });
      if (options.timeout_ms !== undefined) timer = setTimeout(() => finish("timeout"), options.timeout_ms);
    });
  }

  private releaseAgent(agent: Agent, reason: string, run?: ManagedRun): Promise<void> {
    if (agent.release) return agent.release;
    if (agent.current && !(run?.record.execution_exited && agent.current === run.record.run_id)) throw new HarnessError("AGENT_BUSY");
    agent.unavailable = reason; agent.question = undefined;
    const port = agent.session; agent.session = undefined;
    // Explicit release / idle shutdown happen after END. Keep their diagnostics
    // on the latest Run's live view without rewriting its task outcome/history.
    const diagnosticRun = run ?? [...this.runs.values()].findLast((candidate) => candidate.record.agent_id === agent.id);
    const recordErrors = (errors: readonly unknown[]): void => {
      const shown = errors.slice(0, 16).map(errorText);
      if (errors.length > 16) shown.push(`CLEANUP_ERRORS_OMITTED: ${errors.length - 16}`);
      diagnosticRun?.record.cleanup_errors.push(...shown);
    };
    this.cleaning++;
    const releasing = Promise.resolve().then(async () => {
      let clean = reason !== "cleanup_uncertain";
      try {
        if (port) {
          const report = await port.dispose();
          if (!report.shutdownExited || report.errors.length) {
            clean = false;
            recordErrors(report.errors);
            if (!report.shutdownExited) diagnosticRun?.record.cleanup_errors.push("shutdown_not_exited");
          }
        }
      } catch (error) { clean = false; recordErrors([error]); }
      finally {
        if (clean) {
          agent.cleanupComplete = true;
          if (!agent.current) agent.resident = false;
        } else { this.cleanupUncertain = true; agent.unavailable = "cleanup_uncertain"; }
        // Unknown shutdown retains its reservation AND the owner lock, regardless
        // of whether history is available. There is no retry/force-unlock API.
        this.cleaning--; this.wake(); this.pump();
      }
    });
    agent.release = releasing; // Publish before port.dispose() can synchronously reenter.
    return releasing;
  }
  /** Explicit parent-host release. The reply describes the actual reservation,
   * not just completion of a cleanup attempt. Never automatic TTL/LRU eviction. */
  async release(agent_id: string) {
    const agent = this.requireAgent(agent_id);
    if (agent.current) throw new HarnessError("AGENT_BUSY", { run_id: agent.current });
    const task = this.releaseAgent(agent, "explicitly_released"); this.track(task); await task;
    return { agent_id, released: !agent.resident, ...(agent.resident ? { reason: "cleanup_uncertain" } : {}) };
  }

  async shutdown(timeout_ms = 2000) {
    if (!Number.isFinite(timeout_ms) || timeout_ms < 0) throw new HarnessError("INVALID_LIMIT");
    if (this.closed) return this.stats();
    this.closing = true;
    for (const run of this.runs.values()) this.cancel(run.record.run_id);
    const settle = (async () => {
      await this.submitTail;
      while (this.tasks.size) await Promise.all([...this.tasks]);
      for (const agent of this.agents.values()) if (agent.resident) await this.releaseAgent(agent, "owner_closed");
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([settle.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeout_ms); })]);
    clearTimeout(timer);
    if (done && !this.tasks.size && !this.cleaning && !this.cleanupUncertain && !this.active && !this.stats().finalizing) {
      // Unsaved history may be lost. It does not require keeping a fully drained
      // owner alive; uncertain execution/cleanup still absolutely does.
      this.options.owner.close(); this.closed = true;
    }
    return this.stats(); // Timeout never unlocks a still-owned execution/finalization.
  }
}
