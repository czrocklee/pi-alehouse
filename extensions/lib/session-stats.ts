import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SessionHealth = "unknown" | "idle" | "busy" | "waiting" | "error";

export interface SessionModelStats {
  /** Provider-reported identity. Omitted for the explicit overflow bucket. */
  provider?: string;
  /** Actual response model when the provider reports one, otherwise the requested model. */
  model: string;
  /** Observed foreground SDK turns only; provider-internal retries are not observable. */
  requests: number;
  errors: number;
  /** Omitted until at least one response reports usage. Zero is retained. */
  outputTokens?: number;
  /** Provider-reported cost. Omitted until reported; zero is retained. */
  cost?: number;
  /** SDK-turn end-to-end time from turn_start, including preflight and live time. */
  llmMs: number;
  /** Mean time to first non-empty effective output over observed samples. */
  ttftMs?: number;
  ttftSamples: number;
  /** Output tokens from reports with a positive corresponding request duration. */
  timedOutputTokens: number;
  /** Positive request durations corresponding exactly to timedOutputTokens. */
  timedOutputMs: number;
  /** Reported timed output tokens / their corresponding end-to-end request time. */
  tps?: number;
  /** At least one request is unfinished, aborted, missing usage, or overflowed. */
  partial: boolean;
}

export interface SessionToolStats {
  /** Tool name, or `(other)` for the bounded overflow bucket. */
  tool: string;
  calls: number;
  errors: number;
  /** Cumulative per-call time. Parallel calls are additive and may exceed wall time. */
  totalMs: number;
  maxMs: number;
  /** At least one call is still running or could not be paired. */
  partial: boolean;
}

export interface SessionStatsSnapshot {
  /** This collector never backfills history and covers one instrumented session. */
  scope: "foreground-observed";
  /** Human-readable accuracy constraints suitable for a details panel. */
  limitations: readonly string[];
  elapsedMs: number;
  /** Union of foreground agent_start -> agent_settled intervals. */
  busyMs: number;
  idleMs: number;
  /** Cumulative SDK-turn time from turn_start; includes preflight and is not transport-only. */
  llmMs: number;
  /** Cumulative per-tool time; parallel tools are additive. */
  toolMs: number;
  /** Union time across overlapping permission prompts. */
  approvalMs: number;
  activeRequests: number;
  activeTools: number;
  pendingApprovals: number;
  health: SessionHealth;
  /** Whether an agent_start has established foreground lifecycle evidence. */
  observedActivity: boolean;
  /** Age of the most recent observed foreground event. */
  lastActivityMs?: number;
  /** Most recently completed request's effective-output latency. */
  lastTtftMs?: number;
  /** Most recently completed request's first non-empty text latency. */
  lastTextMs?: number;
  /** Most recently completed request's end-to-end reported-token rate. */
  lastTps?: number;
  /** True only for live/incomplete/missing/overflowed observations, not merely this window's scope. */
  partial: boolean;
  models: SessionModelStats[];
  tools: SessionToolStats[];
}

interface ActiveRequest {
  readonly startedAt: number;
  readonly model: string;
  readonly provider?: string;
  firstOutputAt?: number;
  firstTextAt?: number;
}

interface ActiveTool {
  readonly startedAt: number;
  readonly tool: string;
}

interface ModelAggregate {
  provider?: string;
  model: string;
  requests: number;
  errors: number;
  outputTokens?: number;
  cost?: number;
  llmMs: number;
  ttftTotalMs: number;
  ttftSamples: number;
  tpsTokens: number;
  tpsMs: number;
  partial: boolean;
}

interface ToolAggregate {
  tool: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  partial: boolean;
}

const MAX_AGGREGATE_ROWS = 32;
const MAX_ACTIVE_TOOLS = 128;
const MAX_PENDING_APPROVALS = 128;
const MAX_LABEL_LENGTH = 160;
const MAX_ID_LENGTH = 512;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const OVERFLOW = "(other)";
const UNKNOWN = "(unknown)";

const LIMITATIONS = Object.freeze([
  "Current observation window only; no historical backfill.",
  "Single instrumented foreground session; compaction and cache warming are excluded.",
  "Requests are foreground SDK turns; provider-internal retries are not observable.",
  "LLM time starts at turn_start, includes SDK preflight, and is not transport-only latency.",
  "TPS is reported output tokens divided by end-to-end request time, not decoding speed.",
]);

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_NUMBER)
    : undefined;
}

function addBounded(left: number, right: number): number {
  return Math.min(MAX_NUMBER, left + right);
}

function label(value: unknown, fallback = UNKNOWN): string {
  if (typeof value !== "string") return fallback;
  const clean = Array.from(value)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && point !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback;
  const characters = Array.from(clean);
  return characters.length <= MAX_LABEL_LENGTH
    ? clean
    : `${characters.slice(0, MAX_LABEL_LENGTH - 1).join("")}…`;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function cloneModel(value: ModelAggregate): ModelAggregate {
  return { ...value };
}

function cloneTool(value: ToolAggregate): ToolAggregate {
  return { ...value };
}

/**
 * Timer-free, bounded, in-memory observations for one currently open Pi session.
 *
 * The supplied clock must be monotonic. Samples are still clamped against
 * backwards/non-finite values so a broken test clock or suspend anomaly cannot
 * produce negative durations. The default deliberately uses performance.now(),
 * never wall-clock time.
 *
 * Provider-error health is latched through the current foreground activity and recovers
 * deliberately at the next startActivity(). A pending approval has display
 * precedence because it is immediately actionable.
 */
export class SessionStats {
  readonly #clock: () => number;
  readonly #openedAt: number;
  #lastNow: number;
  #lastEventAt?: number;
  #activityStartedAt?: number;
  #busyMs = 0;
  #hasActivityEvidence = false;
  #errorLatched = false;
  #request?: ActiveRequest;
  readonly #activeTools = new Map<string, ActiveTool>();
  readonly #pendingApprovals = new Set<string>();
  #approvalStartedAt?: number;
  #approvalMs = 0;
  #llmMs = 0;
  #toolMs = 0;
  #lastTtftMs?: number;
  #lastTextMs?: number;
  #lastTps?: number;
  #partial = false;
  readonly #models = new Map<string, ModelAggregate>();
  readonly #tools = new Map<string, ToolAggregate>();

  constructor(now: () => number = () => performance.now()) {
    this.#clock = now;
    const openedAt = this.#readClock(0);
    this.#openedAt = openedAt;
    this.#lastNow = openedAt;
  }

  #readClock(fallback: number): number {
    try {
      const sampled = this.#clock();
      return finiteNonNegative(sampled) ?? fallback;
    } catch {
      return fallback;
    }
  }

  #now(): number {
    const sampled = this.#readClock(this.#lastNow);
    this.#lastNow = Math.max(this.#lastNow, sampled);
    return this.#lastNow;
  }

  #touch(now: number): void {
    this.#lastEventAt = now;
  }

  #duration(startedAt: number, now: number): number {
    return Math.max(0, Math.min(MAX_NUMBER, now - startedAt));
  }

  /** Constant-time status read: no clock sampling, copies or aggregate traversal. */
  get health(): SessionHealth {
    return this.#pendingApprovals.size > 0 ? "waiting" : this.#errorLatched ? "error" :
      this.#activityStartedAt !== undefined ? "busy" : this.#hasActivityEvidence ? "idle" : "unknown";
  }

  startActivity(): void {
    const now = this.#now();
    this.#touch(now);
    if (this.#activityStartedAt !== undefined) return;
    this.#activityStartedAt = now;
    this.#hasActivityEvidence = true;
    // A new foreground run is the deliberate recovery boundary. Errors remain
    // visible after settlement and are not erased by unrelated successful tools.
    this.#errorLatched = false;
  }

  settleActivity(): void {
    const now = this.#now();
    if (this.#activityStartedAt === undefined) return;
    this.#touch(now);
    this.#busyMs = addBounded(this.#busyMs, this.#duration(this.#activityStartedAt, now));
    this.#activityStartedAt = undefined;
    if (this.#request) this.#finishRequest(undefined, now, true);
    for (const id of [...this.#activeTools.keys()]) this.#finishTool(id, false, now, true);
    // Permission prompts belong to the parent UI, not the agent loop. A prompt
    // can outlive settlement (or originate while idle), so only its matching
    // decision or collector destruction may close it.
  }

  requestStart(model: string, provider?: string): void {
    const now = this.#now();
    if (this.#activityStartedAt === undefined) return;
    this.#touch(now);
    if (this.#request) this.#finishRequest(undefined, now, true);
    this.#request = {
      startedAt: now,
      model: label(model),
      ...(provider ? { provider: label(provider) } : {}),
    };
  }

  delta(kind: string, delta: string): void {
    if (!this.#request || typeof delta !== "string" || delta.length === 0) return;
    if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
    const now = this.#now();
    this.#touch(now);
    this.#request.firstOutputAt ??= now;
    if (kind === "text_delta") this.#request.firstTextAt ??= now;
  }

  messageEnd(message: unknown): void {
    if (!this.#request) return;
    let role: unknown;
    try {
      role = record(message)?.role;
    } catch {
      this.#partial = true;
      return;
    }
    if (role !== "assistant") return;
    const now = this.#now();
    this.#touch(now);
    this.#finishRequest(message, now, false);
  }

  toolStart(id: string, name: string): void {
    const now = this.#now();
    if (this.#activityStartedAt === undefined) return;
    const safeId = identifier(id);
    if (!safeId || this.#activeTools.size >= MAX_ACTIVE_TOOLS) {
      this.#partial = true;
      return;
    }
    this.#touch(now);
    if (this.#activeTools.has(safeId)) {
      this.#partial = true;
      return;
    }
    this.#activeTools.set(safeId, { startedAt: now, tool: label(name) });
  }

  toolEnd(id: string, isError: boolean): void {
    const safeId = identifier(id);
    if (!safeId || !this.#activeTools.has(safeId)) return;
    const now = this.#now();
    this.#touch(now);
    this.#finishTool(safeId, isError === true, now, false);
  }

  approvalStart(id: string): void {
    const now = this.#now();
    const safeId = identifier(id);
    if (!safeId || this.#pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      this.#partial = true;
      return;
    }
    if (this.#pendingApprovals.has(safeId)) return;
    this.#touch(now);
    if (this.#pendingApprovals.size === 0) this.#approvalStartedAt = now;
    this.#pendingApprovals.add(safeId);
  }

  approvalEnd(id: string): void {
    const safeId = identifier(id);
    if (!safeId || !this.#pendingApprovals.has(safeId)) return;
    const now = this.#now();
    this.#touch(now);
    this.#pendingApprovals.delete(safeId);
    if (this.#pendingApprovals.size === 0) this.#closeApprovalInterval(now);
  }

  #modelKey(provider: string | undefined, model: string): string {
    return `${provider ?? ""}\u0000${model}`;
  }

  #modelAggregate(
    values: Map<string, ModelAggregate>,
    provider: string | undefined,
    model: string,
  ): ModelAggregate {
    const key = this.#modelKey(provider, model);
    const found = values.get(key);
    if (found) return found;

    if (values.size < MAX_AGGREGATE_ROWS - 1) {
      const created: ModelAggregate = {
        ...(provider ? { provider } : {}),
        model,
        requests: 0,
        errors: 0,
        llmMs: 0,
        ttftTotalMs: 0,
        ttftSamples: 0,
        tpsTokens: 0,
        tpsMs: 0,
        partial: false,
      };
      values.set(key, created);
      return created;
    }

    const overflowKey = this.#modelKey(undefined, OVERFLOW);
    const overflow = values.get(overflowKey);
    if (overflow) return overflow;
    const created: ModelAggregate = {
      model: OVERFLOW,
      requests: 0,
      errors: 0,
      llmMs: 0,
      ttftTotalMs: 0,
      ttftSamples: 0,
      tpsTokens: 0,
      tpsMs: 0,
      partial: true,
    };
    values.set(overflowKey, created);
    return created;
  }

  #toolAggregate(values: Map<string, ToolAggregate>, tool: string): ToolAggregate {
    const found = values.get(tool);
    if (found) return found;
    if (values.size < MAX_AGGREGATE_ROWS - 1) {
      const created: ToolAggregate = {
        tool,
        calls: 0,
        errors: 0,
        totalMs: 0,
        maxMs: 0,
        partial: false,
      };
      values.set(tool, created);
      return created;
    }
    const overflow = values.get(OVERFLOW);
    if (overflow) return overflow;
    const created: ToolAggregate = {
      tool: OVERFLOW,
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      partial: true,
    };
    values.set(OVERFLOW, created);
    return created;
  }

  #finishRequest(message: unknown, now: number, forcedPartial: boolean): void {
    const active = this.#request;
    if (!active) return;
    this.#request = undefined;
    const duration = this.#duration(active.startedAt, now);
    this.#llmMs = addBounded(this.#llmMs, duration);

    let provider = active.provider;
    let model = active.model;
    let stopReason: unknown;
    let outputTokens: number | undefined;
    let cost: number | undefined;
    let malformed = false;
    if (message !== undefined) {
      try {
        const response = record(message);
        if (!response) {
          malformed = true;
        } else {
          provider = label(response.provider, provider ?? UNKNOWN);
          model = label(response.responseModel ?? response.model, model);
          stopReason = response.stopReason;
          const usage = record(response.usage);
          outputTokens = finiteNonNegative(usage?.output);
          cost = finiteNonNegative(record(usage?.cost)?.total);
        }
      } catch {
        malformed = true;
      }
    }

    const isError = stopReason === "error";
    const aborted = stopReason === "aborted";
    const missingUsage = outputTokens === undefined || cost === undefined;
    const partial = forcedPartial || malformed || aborted || isError || missingUsage;
    const aggregate = this.#modelAggregate(this.#models, provider, model);
    aggregate.requests = addBounded(aggregate.requests, 1);
    aggregate.errors = addBounded(aggregate.errors, isError ? 1 : 0);
    aggregate.llmMs = addBounded(aggregate.llmMs, duration);
    aggregate.partial ||= partial || aggregate.model === OVERFLOW;

    if (outputTokens !== undefined) {
      aggregate.outputTokens = addBounded(aggregate.outputTokens ?? 0, outputTokens);
      if (duration > 0) {
        aggregate.tpsTokens = addBounded(aggregate.tpsTokens, outputTokens);
        aggregate.tpsMs = addBounded(aggregate.tpsMs, duration);
        this.#lastTps = outputTokens / (duration / 1_000);
      } else {
        this.#lastTps = undefined;
      }
    } else {
      this.#lastTps = undefined;
    }
    if (cost !== undefined) aggregate.cost = addBounded(aggregate.cost ?? 0, cost);

    if (active.firstOutputAt !== undefined) {
      const ttft = this.#duration(active.startedAt, active.firstOutputAt);
      aggregate.ttftTotalMs = addBounded(aggregate.ttftTotalMs, ttft);
      aggregate.ttftSamples = addBounded(aggregate.ttftSamples, 1);
      this.#lastTtftMs = ttft;
    } else {
      this.#lastTtftMs = undefined;
    }
    this.#lastTextMs = active.firstTextAt === undefined
      ? undefined
      : this.#duration(active.startedAt, active.firstTextAt);

    if (isError) this.#errorLatched = true;
    if (partial || aggregate.model === OVERFLOW) this.#partial = true;
  }

  #finishTool(id: string, isError: boolean, now: number, forcedPartial: boolean): void {
    const active = this.#activeTools.get(id);
    if (!active) return;
    this.#activeTools.delete(id);
    const duration = this.#duration(active.startedAt, now);
    this.#toolMs = addBounded(this.#toolMs, duration);
    const aggregate = this.#toolAggregate(this.#tools, active.tool);
    aggregate.calls = addBounded(aggregate.calls, 1);
    aggregate.errors = addBounded(aggregate.errors, isError ? 1 : 0);
    aggregate.totalMs = addBounded(aggregate.totalMs, duration);
    aggregate.maxMs = Math.max(aggregate.maxMs, duration);
    aggregate.partial ||= forcedPartial || aggregate.tool === OVERFLOW;
    // Nonzero shell exits, denied permissions and fixable builds are tool
    // outcomes, not provider/Run failures. Retain their counts without red health.
    if (forcedPartial || aggregate.tool === OVERFLOW) this.#partial = true;
  }

  #closeApprovalInterval(now: number): void {
    if (this.#approvalStartedAt === undefined) return;
    this.#approvalMs = addBounded(
      this.#approvalMs,
      this.#duration(this.#approvalStartedAt, now),
    );
    this.#approvalStartedAt = undefined;
  }

  snapshot(): SessionStatsSnapshot {
    const now = this.#now();
    const elapsedMs = this.#duration(this.#openedAt, now);
    const liveBusyMs = this.#activityStartedAt === undefined
      ? 0
      : this.#duration(this.#activityStartedAt, now);
    const busyMs = Math.min(elapsedMs, addBounded(this.#busyMs, liveBusyMs));
    const modelValues = new Map(
      [...this.#models].map(([key, value]) => [key, cloneModel(value)]),
    );
    const toolValues = new Map(
      [...this.#tools].map(([key, value]) => [key, cloneTool(value)]),
    );

    let llmMs = this.#llmMs;
    if (this.#request) {
      const duration = this.#duration(this.#request.startedAt, now);
      llmMs = addBounded(llmMs, duration);
      const aggregate = this.#modelAggregate(
        modelValues,
        this.#request.provider,
        this.#request.model,
      );
      aggregate.requests = addBounded(aggregate.requests, 1);
      aggregate.llmMs = addBounded(aggregate.llmMs, duration);
      aggregate.partial = true;
    }

    let toolMs = this.#toolMs;
    for (const active of this.#activeTools.values()) {
      const duration = this.#duration(active.startedAt, now);
      toolMs = addBounded(toolMs, duration);
      const aggregate = this.#toolAggregate(toolValues, active.tool);
      aggregate.calls = addBounded(aggregate.calls, 1);
      aggregate.totalMs = addBounded(aggregate.totalMs, duration);
      aggregate.maxMs = Math.max(aggregate.maxMs, duration);
      aggregate.partial = true;
    }

    const approvalMs = this.#approvalStartedAt === undefined
      ? this.#approvalMs
      : addBounded(this.#approvalMs, this.#duration(this.#approvalStartedAt, now));
    const models: SessionModelStats[] = [...modelValues.values()].map((value) => ({
      ...(value.provider ? { provider: value.provider } : {}),
      model: value.model,
      requests: value.requests,
      errors: value.errors,
      ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens } : {}),
      ...(value.cost !== undefined ? { cost: value.cost } : {}),
      llmMs: value.llmMs,
      ...(value.ttftSamples > 0 ? { ttftMs: value.ttftTotalMs / value.ttftSamples } : {}),
      ttftSamples: value.ttftSamples,
      timedOutputTokens: value.tpsTokens,
      timedOutputMs: value.tpsMs,
      ...(value.tpsMs > 0 ? { tps: value.tpsTokens / (value.tpsMs / 1_000) } : {}),
      partial: value.partial,
    }));
    const tools: SessionToolStats[] = [...toolValues.values()].map((value) => ({ ...value }));

    return {
      scope: "foreground-observed",
      limitations: LIMITATIONS,
      elapsedMs,
      busyMs,
      idleMs: Math.max(0, elapsedMs - busyMs),
      llmMs,
      toolMs,
      approvalMs,
      activeRequests: this.#request ? 1 : 0,
      activeTools: this.#activeTools.size,
      pendingApprovals: this.#pendingApprovals.size,
      health: this.health,
      observedActivity: this.#hasActivityEvidence,
      ...(this.#lastEventAt === undefined
        ? {}
        : { lastActivityMs: this.#duration(this.#lastEventAt, now) }),
      ...(this.#lastTtftMs === undefined ? {} : { lastTtftMs: this.#lastTtftMs }),
      ...(this.#lastTextMs === undefined ? {} : { lastTextMs: this.#lastTextMs }),
      ...(this.#lastTps === undefined ? {} : { lastTps: this.#lastTps }),
      partial: this.#partial || Boolean(this.#request) || this.#activeTools.size > 0,
      models,
      tools,
    };
  }
}

function requestIdFrom(value: unknown): string | undefined {
  try {
    return identifier(record(value)?.requestId);
  } catch {
    return undefined;
  }
}

/**
 * Bind foreground-only observations. Every callback is fail-open: malformed
 * telemetry or a throwing redraw callback must never block a provider request,
 * tool, approval prompt, or lifecycle transition. Notify only health transitions;
 * the owner refreshes numeric metrics on its timer and when the view renders.
 */
export function bindStatsEvents(
  pi: ExtensionAPI,
  getStats: () => SessionStats | undefined,
  changed: () => void,
): () => void {
  const unsubscribers: Array<() => void> = [];
  let disposed = false;

  const observe = (operation: (stats: SessionStats) => void): void => {
    if (disposed) return;
    try {
      const stats = getStats();
      if (!stats) return;
      const before = stats.health;
      operation(stats);
      if (stats.health === before) return;
      try {
        changed();
      } catch {
        // Rendering is less important than the event being observed fail-open.
      }
    } catch {
      // Telemetry must never become lifecycle authority.
    }
  };

  const register = (subscribe: () => unknown): void => {
    try {
      const unsubscribe = subscribe();
      if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe as () => void);
    } catch {
      // A missing optional channel must not prevent the remaining observations.
    }
  };

  register(() => pi.on("agent_start", () => observe((stats) => stats.startActivity())));
  register(() => pi.on("agent_settled", () => observe((stats) => stats.settleActivity())));
  // turn_start is the foreground SDK attempt boundary. before_provider_request
  // is deliberately not observed: cache warming reuses onPayload and can emit it
  // concurrently with a foreground turn, without a request id to correlate it.
  register(() => pi.on("turn_start", (_event, ctx) => observe((stats) => {
    const model = ctx.model;
    stats.requestStart(model?.id ?? UNKNOWN, model?.provider);
  })));
  register(() => pi.on("message_update", (event) => observe((stats) => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
      stats.delta(update.type, update.delta);
    }
  })));
  register(() => pi.on("message_end", (event) => observe((stats) => stats.messageEnd(event.message))));
  register(() => pi.on("tool_execution_start", (event) => observe((stats) => {
    stats.toolStart(event.toolCallId, event.toolName);
  })));
  register(() => pi.on("tool_execution_end", (event) => observe((stats) => {
    stats.toolEnd(event.toolCallId, event.isError);
  })));
  register(() => pi.events.on("permissions:ui_prompt", (value) => {
    const requestId = requestIdFrom(value);
    if (requestId) observe((stats) => stats.approvalStart(requestId));
  }));
  // UI settlement is not a permission verdict. Timeout/error paths can emit a
  // gate_error under a different ID; their original wait nevertheless ended.
  for (const channel of ["permissions:decision", "managed-permissions:ui_prompt_end:v1"]) {
    register(() => pi.events.on(channel, (value) => {
      const requestId = requestIdFrom(value);
      if (requestId) observe((stats) => stats.approvalEnd(requestId));
    }));
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0).reverse()) {
      try {
        unsubscribe();
      } catch {
        // Idempotent fail-open teardown.
      }
    }
  };
}
