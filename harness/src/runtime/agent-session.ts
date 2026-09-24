import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { AgentSession, EventBus, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DrainWait, ExecutionFacts, Output } from "../core/contracts.js";
import { SessionUnavailableError, type AgentSessionPort, type HistoryPort, type RunCallbacks } from "../core/ports.js";
import { boundedOutput } from "../core/result-text.js";
import { addToLedger, normalizeUsage, type UsageLedger } from "../core/usage-ledger.js";
import { disposeChildSession } from "./child-session.js";

/** The adapter needs only the live journal controls beyond the core history port. */
export interface RunJournalPort extends HistoryPort {
  invalidate(error: unknown): void;
  seal(): void;
}

interface Ticket { prefix: string; valid(): boolean; passed: boolean; }

/** Diagnostics must not skip drain when an extension throws an opaque object. */
const printableFailure = (cause: unknown): unknown => {
  try { String(cause); return cause; }
  catch { return new Error("Unprintable failure", { cause }); }
};

/** Child Run gate, loaded LAST by the trusted child assembly.
 * Not an atomic run-token admission API: Pi 0.87.1 still awaits after this
 * handler before queue mutation. We drain every dispatch, close early, and
 * quarantine crossings; the accepted cooperative contract does not fix this race.
 */
export class ChildRunGate {
  readonly tickets = new Set<Ticket>();
  accepting = false;
  stopped = false;
  uncertain = false;
  readonly observations: Array<{ admitted: boolean; reason: string }> = [];
  readonly extension: ExtensionFactory = (pi) => {
    // Child-only: warming can issue billed model calls outside the Run's turns
    // and assistant-message ledger, including while a resident Agent is idle.
    // The SDK reads this setting from globalSettings, so applyOverrides({
    // cacheWarming: "off" }) would not disable it. Stop at the public decision
    // hook instead, without changing the parent's persisted warming policy.
    pi.on("cache_warming_decision", () => ({ action: "stop" }));
    pi.on("input", (event) => {
      const ticket = [...this.tickets].find((t) => event.text.startsWith(t.prefix));
      const admitted = !!ticket && this.accepting && !this.stopped && ticket.valid();
      this.observations.push({ admitted, reason: admitted ? "fixture_guard_passed" : "input_closed_or_unowned" });
      if (this.observations.length > 128) this.observations.shift();
      if (!admitted || !ticket) return { action: "handled" };
      ticket.passed = true;
      return { action: "transform", text: event.text.slice(ticket.prefix.length) };
    });
    pi.on("tool_call", () => {
      if (!this.accepting || this.stopped) return { block: true, reason: "Fixture Run is no longer accepting execution" };
    });
  };
}

/** SDK execution only: the child factory's AgentSessionPort wrapper consumes
 * and binds RunExecutionIdentity before invoking this two-argument run method. */
type PiExecutionPort = Omit<AgentSessionPort, "run"> & {
  run(prompt: string, callbacks: RunCallbacks): Promise<ExecutionFacts>;
};

/** Real SDK port for isolated experiments only; SDK/module instances are injected. */
export class PiAgentSessionAdapter implements PiExecutionPort {
  private active = false;
  private unavailable?: SessionUnavailableError;
  private readonly deliveries = new Set<Promise<boolean>>();
  private readonly discarded: string[] = [];
  readonly session_id: string;
  readonly history?: RunJournalPort;
  constructor(private readonly options: {
    session: AgentSession;
    parentBus: EventBus;
    gate: ChildRunGate;
    readiness(): void;
    /** Synchronous revocation before stop/exit/drain; never extends Run life. */
    invalidateApproval?(): void;
    outputChars?: number;
    shutdownTimeoutMs?: number;
    history?: RunJournalPort;
  }) { this.session_id = options.session.sessionId; this.history = options.history; }

  private abortTracked(): void {
    const stopping = this.options.session.abort().then(() => false, () => { this.options.gate.uncertain = true; return false; });
    this.deliveries.add(stopping);
    // Abort rejection already marks uncertainty above; observe settlement
    // without creating an unhandled rejection through a detached finally().
    void stopping.then(() => this.deliveries.delete(stopping), () => this.deliveries.delete(stopping));
  }
  private assertReady(): void {
    if (this.unavailable) throw this.unavailable;
    try { this.options.readiness(); }
    catch (cause) {
      this.unavailable = new SessionUnavailableError("readiness_failed", cause);
      this.options.gate.accepting = false; this.options.gate.stopped = true;
      if (this.active) this.abortTracked();
      throw this.unavailable;
    }
  }
  canInput(): boolean {
    return !this.unavailable && this.active && this.options.gate.accepting && !this.options.gate.stopped && this.options.session.isStreaming;
  }
  private clear(): void {
    const queue = this.options.session.clearQueue();
    this.discarded.push(...queue.steering, ...queue.followUp);
  }
  clearInputs(): string[] {
    if (this.active || this.deliveries.size || !this.options.session.isIdle) throw new Error("INPUT_DRAIN_NOT_FINISHED");
    this.clear();
    if (this.unavailable) throw this.unavailable;
    if (this.options.session.getSteeringMessages().length || this.options.session.getFollowUpMessages().length) throw new Error("INPUT_QUEUE_NOT_EMPTY");
    if (this.options.gate.uncertain) throw new Error("INPUT_BOUNDARY_UNCERTAIN");
    return this.discarded.splice(0);
  }
  private async send(text: string, valid: () => boolean, steer: boolean): Promise<boolean> {
    const { session, gate } = this.options;
    if (!valid() || !gate.accepting || gate.stopped) return false;
    this.assertReady();
    const ticket: Ticket = { prefix: `[harness-fixture-input:${randomUUID()}]\n`, valid, passed: false };
    gate.tickets.add(ticket);
    try {
      // prompt() traverses permission input and supplies the Run-owned ticket.
      // The SDK also routes direct steer()/followUp() through input handlers.
      await session.prompt(ticket.prefix + text, { expandPromptTemplates: false, source: "extension",
        ...(steer ? { streamingBehavior: "steer" as const } : {}) });
      if (steer && ticket.passed && (!gate.accepting || gate.stopped)) gate.uncertain = true;
      return ticket.passed;
    } finally { gate.tickets.delete(ticket); }
  }
  async steer(text: string, valid: () => boolean): Promise<boolean> {
    if (!this.canInput() || !valid()) return false;
    const delivery = this.send(text, valid, true);
    this.deliveries.add(delivery);
    try { return await delivery; } finally { this.deliveries.delete(delivery); }
  }
  async stop(): Promise<void> {
    const errors: unknown[] = [];
    try { this.options.invalidateApproval?.(); }
    catch (error) { this.quarantine("approval_revocation_failed", error); errors.push(this.unavailable); }
    this.options.gate.accepting = false; this.options.gate.stopped = true;
    try { this.clear(); } catch (error) { errors.push(printableFailure(error)); }
    // Queue failure cannot suppress abort. Propagate every failure to the core's
    // tracked stop path, which retains ownership and prevents uncertain reuse.
    try { await this.options.session.abort(); } catch (error) { errors.push(printableFailure(error)); }
    try { this.clear(); } catch (error) { errors.push(printableFailure(error)); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `SDK stop failed: ${errors.map(String).join("; ")}`);
  }

  /** Execution and drain failures share one exit, including both diagnostics
   * when cleanup fails after the SDK already rejected the prompt. */
  private quarantine(reason: string, cause: unknown): void {
    cause = printableFailure(cause);
    try { this.history?.invalidate(cause); }
    catch (error) {
      cause = new AggregateError([cause, error], `History invalidation failed: ${String(printableFailure(error))}`, { cause });
    }
    const previous = this.unavailable;
    this.unavailable = new SessionUnavailableError(previous?.reason ?? reason, previous
      ? new AggregateError([previous, cause], `${previous.message}; ${reason}: ${String(cause)}`, { cause: previous })
      : cause);
    this.options.gate.accepting = false; this.options.gate.stopped = true;
  }

  async run(prompt: string, callbacks: RunCallbacks): Promise<ExecutionFacts> {
    const { session, gate } = this.options;
    if (this.active || !session.isIdle || this.deliveries.size) throw new Error("SESSION_NOT_IDLE");
    this.assertReady();
    this.clearInputs(); // Check previous Run, never silently revive a quarantined port.
    this.active = true; gate.accepting = true; gate.stopped = false;
    const cap = this.options.outputChars ?? 1_048_576;
    let revision = 0;
    let output: Output = { text: "", total_chars: 0, truncated: false, revision };
    // A trailing high surrogate is provisional until the next delta arrives.
    // While withheld, Output.truncated is true (retained text is shorter than
    // observed text); this alone does not permanently close prefix retention.
    let pendingHigh = "", retentionClosed = false;
    let lastReason: string | undefined, lastError: string | undefined;
    let inputEntered = false, sawAssistant = false;
    let usage: UsageLedger | undefined;
    let compaction: { model: string; retried: boolean } | undefined;
    let retrying = false;
    const tools = new Set<string>();
    const accrue = (raw: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined, model: string): void => {
      usage = addToLedger(usage, normalizeUsage({ input: raw?.input, output: raw?.output,
        cache_read: raw?.cacheRead, cache_write: raw?.cacheWrite, cost: raw?.cost?.total }), model);
    };
    const publish = (): void => {
      // This is SDK context occupancy, not the Run's cumulative billed tokens.
      // Immediately after compaction Pi may report unknown until a new response.
      let context: { tokens: number | null; context_window: number } | undefined;
      try {
        const current = session.getContextUsage();
        if (current) context = { tokens: current.tokens, context_window: current.contextWindow };
      } catch { /* Telemetry is optional; it cannot break execution or accounting. */ }
      try {
        callbacks.runtime?.({ activity: retrying ? "retrying" : compaction ? "compacting" : tools.size ? "tool" : "generating",
          ...(context ? { context } : {}), ...(usage ? { usage } : {}) });
      } catch { /* A telemetry observer cannot prevent unsubscribe/idle cleanup. */ }
    };
    let callbackFailed = false;
    const control = (invoke: () => void): void => {
      if (callbackFailed) return;
      try { invoke(); }
      catch (error) {
        // Unlike optional telemetry, these callbacks maintain Owner state.
        // Do not let SDK error recovery turn their failure into a reusable Run,
        // or skip the rest of a message_end event's already-observed usage.
        callbackFailed = true;
        this.quarantine("run_callback_failed", error);
        try { this.options.invalidateApproval?.(); }
        catch (caught) { this.quarantine("approval_revocation_failed", caught); }
        this.abortTracked();
      }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start") {
        // SDK summary usage does not expose responseModel. Use an explicit
        // operation/requested-model bucket, never pretend it is a routed model.
        const model = session.model;
        compaction = { model: model ? `compaction/${model.provider}/${model.id}` : "compaction/unknown", retried: false };
        retrying = false;
      }
      if (event.type === "summarization_retry_scheduled" && compaction) { compaction.retried = true; retrying = true; }
      if (event.type === "summarization_retry_attempt_start" || event.type === "summarization_retry_finished") retrying = false;
      if (event.type === "auto_retry_start") retrying = true;
      if (event.type === "auto_retry_end") retrying = false;
      if (event.type === "compaction_end" && compaction) {
        // One authoritative event only; success already combines both split
        // summaries. Failed/cancelled or retried attempts can have hidden spend.
        // An unpaired end (overflow recovery exhausted) made no summary call.
        accrue(event.result?.usage, compaction.model);
        if (compaction.retried && event.result?.usage) accrue(undefined, compaction.model);
        compaction = undefined; retrying = false;
      }
      if (event.type === "tool_execution_start") tools.add(event.toolCallId);
      if (event.type === "tool_execution_end") tools.delete(event.toolCallId);
      if (event.type === "turn_start") control(() => callbacks.turnStart());
      if (event.type === "turn_end") control(() => callbacks.turnEnd(event.message.role === "assistant" && event.message.stopReason === "toolUse"));
      if (event.type === "message_start" && event.message.role === "assistant") {
        // A new attempt/turn replaces the previous candidate, including failed
        // drafts and tool-use commentary. The result is not a transcript.
        output = { text: "", total_chars: 0, truncated: false, revision: ++revision };
        pendingHigh = ""; retentionClosed = false;
        lastReason = lastError = undefined;
        control(() => callbacks.output(output));
      }
      if (event.type === "message_start" && event.message.role === "user" && !gate.accepting) {
        gate.uncertain = true;
        // Best-effort stop of an escaped public-API dispatch; it remains tracked
        // below and cannot be misreported as exit or reused by the next Run.
        this.abortTracked();
      }
      // SDK accepts messages at message_end; this callback is NOT a disk receipt.
      if (event.type === "message_end" && event.message.role === "user" && !inputEntered) {
        inputEntered = true; control(() => callbacks.inputEntered());
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        let text = output.text;
        if (!retentionClosed) {
          const growing = text + pendingHigh + delta;
          pendingHigh = /[\uD800-\uDBFF]$/.test(growing) ? growing.slice(-1) : "";
          const bounded = boundedOutput(growing.slice(0, growing.length - pendingHigh.length), cap);
          text = bounded.text; retentionClosed = bounded.truncated;
          if (retentionClosed) pendingHigh = "";
        }
        const total_chars = output.total_chars + delta.length;
        output = { text, total_chars, truncated: text.length < total_chars, revision };
        control(() => callbacks.output(output));
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        sawAssistant = true;
        const message = event.message;
        output = { ...boundedOutput(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), cap), revision };
        control(() => callbacks.output(output));
        lastReason = message.stopReason; lastError = message.errorMessage;
        // Per-request spend, which is what the provider bills: cache reads are
        // charged on every call that re-reads the prefix, so this sum is the
        // money figure even though the token counts double-count that prefix.
        //
        // Accrued per response, and against the model that actually answered:
        // a router alias is not a model, and billing one response's silence to
        // the whole Run would discard what every other response did report.
        const model = `${message.provider}/${message.responseModel ?? message.model}`;
        accrue(message.usage, model);
        // Failed/aborted streams may retain SDK-initialized zero usage without
        // receiving a provider usage frame. Preserve figures, not false certainty.
        if (message.stopReason === "error" || message.stopReason === "aborted") accrue(undefined, model);
      }
      if (["turn_start", "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "compaction_start", "compaction_end",
        "auto_retry_start", "auto_retry_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"].includes(event.type)) publish();
    });
    try { publish(); await this.send(prompt, () => this.active && gate.accepting && !gate.stopped, false); }
    catch (caught) {
      // An unexpected SDK rejection may leave its in-memory log ahead of disk.
      // Do not retry the writer or call it a known filesystem fault; quarantine.
      this.quarantine("sdk_error", caught);
    }
    finally {
      // Root prompt exit closes admission AND approval before any drain await.
      // agent_end alone is insufficient (SDK retry/post-run loops can continue).
      gate.accepting = false;
      try { this.options.invalidateApproval?.(); }
      catch (caught) { this.quarantine("approval_revocation_failed", caught); }
      // A failed queue clear is diagnostic, never execution-exit evidence.
      try { this.clear(); } catch (caught) { this.quarantine("sdk_drain_failed", caught); }
      let waitingFor: DrainWait | undefined;
      const reportDrain = (next: DrainWait): void => {
        if (waitingFor === next) return;
        waitingFor = next;
        try { callbacks.drain?.(next); } catch { /* Observation cannot bypass drain. */ }
      };
      while (this.deliveries.size) {
        reportDrain("deliveries");
        await Promise.allSettled([...this.deliveries]);
      }
      reportDrain("sdk_idle");
      try { await session.waitForIdle(); } catch (caught) { this.quarantine("sdk_drain_failed", caught); }
      let idleErrorReported = false;
      const idle = (): boolean => {
        try { return session.isIdle; }
        catch (caught) {
          if (!idleErrorReported) this.quarantine("sdk_drain_failed", caught);
          idleErrorReported = true;
          return false;
        }
      };
      // If the SDK wait itself fails, keep the Run, controls and usage listener
      // alive until public idle state proves exit. This observes a quarantined
      // session; it does not retry execution, disposal or owner release.
      for (;;) {
        // Tracked aborts/input can arrive during waitForIdle(). They are our
        // drain obligation, not evidence that the SDK's idle wait was wrong.
        while (this.deliveries.size) {
          reportDrain("deliveries");
          await Promise.allSettled([...this.deliveries]);
        }
        reportDrain("sdk_idle");
        // A diagnostic observer may reenter; its new work must also drain.
        if (this.deliveries.size) continue;
        if (idle()) {
          if (!this.deliveries.size) break;
          continue;
        }
        if (!idleErrorReported) this.quarantine("sdk_drain_failed", new Error("SDK_IDLE_NOT_CONFIRMED"));
        idleErrorReported = true;
        await pause(25);
      }
      try {
        try { this.history?.seal(); } catch (caught) { this.quarantine("sdk_drain_failed", caught); }
        try { this.clear(); } catch (caught) { this.quarantine("sdk_drain_failed", caught); }
      } finally {
        // A rejected SDK operation may leave no terminal compaction event.
        if (compaction) { accrue(undefined, compaction.model); compaction = undefined; retrying = false; publish(); }
        try { unsubscribe(); }
        catch (caught) { this.quarantine("sdk_unsubscribe_failed", caught); }
        finally { this.active = false; }
      }
    }
    // Whatever the responses billed before the session went bad is still owed;
    // the throw path returns no facts, so it rides out on the error instead.
    if (this.unavailable) { this.unavailable.usage ??= usage; throw this.unavailable; }
    // Pi's normal terminal reasons are explicit. `toolUse` can be the final
    // assistant message when a terminating tool batch tells the SDK not to make
    // another model call, so it is successful just like `stop`. A final
    // `length` is an unrecovered provider output limit; pending/deferred and
    // future unknown reasons must not become completed merely because they are
    // neither `error` nor `aborted`.
    const kind: ExecutionFacts["kind"] = gate.stopped || lastReason === "aborted" ? "aborted" :
      sawAssistant && (lastReason === "stop" || lastReason === "toolUse") ? "success" : "error";
    const classificationError = !sawAssistant || !lastReason ? "NO_FINAL_ASSISTANT" :
      lastReason === "length" ? "MODEL_OUTPUT_LIMIT" :
      !["stop", "toolUse", "error", "aborted"].includes(lastReason) ? `UNEXPECTED_MODEL_STOP_REASON: ${lastReason}` : undefined;
    return { kind, output, ...(lastReason ? { model_stop_reason: lastReason } : {}),
      error: lastError ?? classificationError, ...(usage ? { usage } : {}) };
  }

  async dispose() {
    if (this.active || this.deliveries.size) throw new Error("EXECUTION_NOT_EXITED");
    const report = await disposeChildSession(this.options.session, this.options.parentBus, this.options.shutdownTimeoutMs);
    return { shutdownExited: report.shutdownExited, errors: report.errors };
  }
}
