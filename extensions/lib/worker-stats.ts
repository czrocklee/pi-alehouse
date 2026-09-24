import type { WorkerStatsMessage, WorkerStatsSink } from "../../lib/stats-protocol.mjs";
import {
  SessionStats,
  type SessionHealth,
  type SessionModelStats,
  type SessionStatsSnapshot,
  type SessionToolStats,
} from "./session-stats.ts";

export interface WorkerStatsSnapshot {
  /** Worker lifetimes; harness release is permanent and Agent IDs are never reused. */
  observed: number;
  resident: number;
  running: number;
  /** Sum of worker busy intervals. Parallel workers are deliberately additive. */
  busyMs: number;
  llmMs: number;
  toolMs: number;
  activeRequests: number;
  activeTools: number;
  health: SessionHealth;
  partial: boolean;
  models: SessionModelStats[];
  tools: SessionToolStats[];
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

interface WorkerRecord {
  readonly id: string;
  readonly stats: SessionStats;
  readonly sink: WorkerStatsSink;
  running: boolean;
  failed: boolean;
  partial: boolean;
  disposed: boolean;
}

const MAX_RESIDENT_WORKERS = 32;
const MAX_AGGREGATE_ROWS = 32;
const MAX_ID_LENGTH = 512;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const OVERFLOW = "(other)";

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_NUMBER)
    : undefined;

const amount = (value: unknown): number => finiteNonNegative(value) ?? 0;
const addBounded = (left: number, right: number): number =>
  Math.min(MAX_NUMBER, left + right);
const multiplyBounded = (left: number, right: number): number =>
  Math.min(MAX_NUMBER, left * right);

function validWorkerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function modelKey(provider: string | undefined, model: string): string {
  return `${provider ?? ""}\u0000${model}`;
}

function modelAggregate(
  values: Map<string, ModelAggregate>,
  provider: string | undefined,
  model: string,
): { value: ModelAggregate; overflow: boolean } {
  const key = modelKey(provider, model);
  const found = values.get(key);
  if (found) return { value: found, overflow: found.model === OVERFLOW && !found.provider };

  const explicitOverflow = model === OVERFLOW && provider === undefined;
  if (!explicitOverflow && values.size < MAX_AGGREGATE_ROWS - 1) {
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
    return { value: created, overflow: false };
  }

  const overflowKey = modelKey(undefined, OVERFLOW);
  const foundOverflow = values.get(overflowKey);
  if (foundOverflow) return { value: foundOverflow, overflow: true };
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
  return { value: created, overflow: true };
}

function mergeModel(values: Map<string, ModelAggregate>, source: SessionModelStats): boolean {
  const { value, overflow } = modelAggregate(values, source.provider, source.model);
  value.requests = addBounded(value.requests, amount(source.requests));
  value.errors = addBounded(value.errors, amount(source.errors));
  value.llmMs = addBounded(value.llmMs, amount(source.llmMs));
  value.ttftSamples = addBounded(value.ttftSamples, amount(source.ttftSamples));
  if (source.ttftMs !== undefined && source.ttftSamples > 0) {
    value.ttftTotalMs = addBounded(
      value.ttftTotalMs,
      multiplyBounded(amount(source.ttftMs), amount(source.ttftSamples)),
    );
  } else if (source.ttftSamples > 0) {
    value.partial = true;
  }
  value.tpsTokens = addBounded(value.tpsTokens, amount(source.timedOutputTokens));
  value.tpsMs = addBounded(value.tpsMs, amount(source.timedOutputMs));
  if (source.outputTokens !== undefined) {
    value.outputTokens = addBounded(value.outputTokens ?? 0, amount(source.outputTokens));
  }
  if (source.cost !== undefined) value.cost = addBounded(value.cost ?? 0, amount(source.cost));
  value.partial ||= source.partial || overflow;
  return overflow;
}

function toolAggregate(
  values: Map<string, ToolAggregate>,
  tool: string,
): { value: ToolAggregate; overflow: boolean } {
  const found = values.get(tool);
  if (found) return { value: found, overflow: found.tool === OVERFLOW };
  if (tool !== OVERFLOW && values.size < MAX_AGGREGATE_ROWS - 1) {
    const created: ToolAggregate = {
      tool,
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      partial: false,
    };
    values.set(tool, created);
    return { value: created, overflow: false };
  }
  const foundOverflow = values.get(OVERFLOW);
  if (foundOverflow) return { value: foundOverflow, overflow: true };
  const created: ToolAggregate = {
    tool: OVERFLOW,
    calls: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    partial: true,
  };
  values.set(OVERFLOW, created);
  return { value: created, overflow: true };
}

function mergeTool(values: Map<string, ToolAggregate>, source: SessionToolStats): boolean {
  const { value, overflow } = toolAggregate(values, source.tool);
  value.calls = addBounded(value.calls, amount(source.calls));
  value.errors = addBounded(value.errors, amount(source.errors));
  value.totalMs = addBounded(value.totalMs, amount(source.totalMs));
  value.maxMs = Math.max(value.maxMs, amount(source.maxMs));
  value.partial ||= source.partial || overflow;
  return overflow;
}

function publicModels(values: Map<string, ModelAggregate>): SessionModelStats[] {
  return [...values.values()].map((value) => ({
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
}

/**
 * Bounded worker telemetry store. Each resident worker delegates event
 * collection to SessionStats; retirement folds only its numeric aggregates into
 * bounded maps, so historical worker IDs and collectors are not retained.
 */
export class WorkerStats {
  readonly #clock: () => number;
  readonly #changed: () => void;
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #models = new Map<string, ModelAggregate>();
  readonly #tools = new Map<string, ToolAggregate>();
  #observed = 0;
  #busyMs = 0;
  #llmMs = 0;
  #toolMs = 0;
  #partial = false;
  #disposed = false;
  #notifiedHealth: SessionHealth = "unknown";

  constructor(
    now: () => number = () => performance.now(),
    changed: () => void = () => {},
  ) {
    this.#clock = now;
    this.#changed = changed;
  }

  /** Bounded resident-state scan only; never collects model/tool snapshots. */
  get health(): SessionHealth {
    let running = false;
    for (const record of this.#workers.values()) {
      if (record.failed) return "error";
      running ||= record.running;
    }
    return running ? "busy" : this.#observed > 0 ? "idle" : "unknown";
  }

  attach(workerId: string): WorkerStatsSink | undefined {
    // One attachment per observer lifetime, including across resident resumes.
    // The harness rejects resume after release, so historical ID tombstones
    // would only add unbounded retention, not deduplicate a supported lifecycle.
    if (this.#disposed) return undefined;
    if (!validWorkerId(workerId)) {
      this.#markPartial();
      return undefined;
    }
    const existing = this.#workers.get(workerId);
    if (existing) return existing.sink;

    this.#observed = addBounded(this.#observed, 1);
    if (this.#workers.size >= MAX_RESIDENT_WORKERS) {
      this.#markPartial();
      return undefined;
    }

    try {
      let record: WorkerRecord;
      const sink: WorkerStatsSink = {
        beginRun: () => this.#beginRun(record),
        startActivity: () => this.#observe(record, (stats) => stats.startActivity()),
        settleActivity: () => this.#observe(record, (stats) => stats.settleActivity()),
        requestStart: (model, provider) =>
          this.#observe(record, (stats) => stats.requestStart(model, provider)),
        delta: (kind) => this.#observe(record, (stats) => stats.delta(kind, "observed")),
        messageEnd: (message) => this.#messageEnd(record, message),
        toolStart: (id, name) => this.#observe(record, (stats) => stats.toolStart(id, name)),
        toolEnd: (id, isError) => this.#toolEnd(record, id, isError),
        endRun: (kind) => this.#endRun(record, kind),
        dispose: () => this.#retire(record, true),
      };
      record = {
        id: workerId,
        stats: new SessionStats(this.#clock),
        sink,
        running: false,
        failed: false,
        partial: false,
        disposed: false,
      };
      this.#workers.set(workerId, record);
      this.#notify();
      return sink;
    } catch {
      this.#markPartial();
      return undefined;
    }
  }

  snapshot(): WorkerStatsSnapshot {
    try {
      return this.#snapshot();
    } catch {
      return {
        observed: this.#observed,
        resident: this.#workers.size,
        running: 0,
        busyMs: this.#busyMs,
        llmMs: this.#llmMs,
        toolMs: this.#toolMs,
        activeRequests: 0,
        activeTools: 0,
        health: this.health,
        partial: true,
        models: publicModels(this.#models),
        tools: [...this.#tools.values()].map((value) => ({ ...value })),
      };
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of [...this.#workers.values()]) this.#retire(record, false);
    this.#notify();
  }

  #beginRun(record: WorkerRecord): void {
    if (this.#disposed || record.disposed || record.running) return;
    record.running = true;
    // Failure is a latest-resident-run indicator; cumulative error counters stay.
    record.failed = false;
    this.#notify();
  }

  #observe(record: WorkerRecord, operation: (stats: SessionStats) => void): void {
    if (this.#disposed || record.disposed || !record.running) return;
    try {
      operation(record.stats);
    } catch {
      record.partial = true;
    }
    this.#notify();
  }

  #messageEnd(record: WorkerRecord, message: WorkerStatsMessage): void {
    if (this.#disposed || record.disposed || !record.running) return;
    try {
      record.stats.messageEnd(message);
      if (message?.stopReason === "error") record.failed = true;
    } catch {
      record.partial = true;
    }
    this.#notify();
  }

  #toolEnd(record: WorkerRecord, id: string, isError: boolean): void {
    if (this.#disposed || record.disposed || !record.running) return;
    try {
      // Recoverable tool errors belong in counters, not a sticky Run failure.
      record.stats.toolEnd(id, isError);
    } catch {
      record.partial = true;
    }
    this.#notify();
  }

  #endRun(record: WorkerRecord, kind: "success" | "error" | "aborted"): void {
    if (this.#disposed || record.disposed || !record.running) return;
    try {
      if (kind !== "success") record.partial = true;
      if (kind === "error") record.failed = true;
      if (kind !== "success" && kind !== "error" && kind !== "aborted") record.partial = true;
      // This is deliberately independent of a possibly missing SDK settlement.
      // SessionStats closes only spans that actually started and invents no usage.
      record.stats.settleActivity();
    } catch {
      record.partial = true;
    }
    record.running = false;
    this.#notify();
  }

  #retire(record: WorkerRecord, notify: boolean): void {
    if (record.disposed) return;
    record.disposed = true;
    if (record.running) {
      record.running = false;
      record.partial = true;
      try {
        record.stats.settleActivity();
      } catch {
        record.partial = true;
      }
    }
    this.#workers.delete(record.id);
    try {
      this.#archive(record.stats.snapshot(), record.partial);
    } catch {
      this.#partial = true;
    }
    if (notify) this.#notify();
  }

  #archive(snapshot: SessionStatsSnapshot, recordPartial: boolean): void {
    this.#busyMs = addBounded(this.#busyMs, amount(snapshot.busyMs));
    this.#llmMs = addBounded(this.#llmMs, amount(snapshot.llmMs));
    this.#toolMs = addBounded(this.#toolMs, amount(snapshot.toolMs));
    this.#partial ||= recordPartial || snapshot.partial;
    for (const model of snapshot.models) {
      const overflow = mergeModel(this.#models, model);
      this.#partial ||= overflow;
    }
    for (const tool of snapshot.tools) {
      const overflow = mergeTool(this.#tools, tool);
      this.#partial ||= overflow;
    }
  }

  #snapshot(): WorkerStatsSnapshot {
    let busyMs = this.#busyMs;
    let llmMs = this.#llmMs;
    let toolMs = this.#toolMs;
    let activeRequests = 0;
    let activeTools = 0;
    let running = 0;
    let partial = this.#partial;
    const models = new Map(
      [...this.#models].map(([key, value]) => [key, { ...value }]),
    );
    const tools = new Map(
      [...this.#tools].map(([key, value]) => [key, { ...value }]),
    );

    for (const record of this.#workers.values()) {
      const snapshot = record.stats.snapshot();
      busyMs = addBounded(busyMs, amount(snapshot.busyMs));
      llmMs = addBounded(llmMs, amount(snapshot.llmMs));
      toolMs = addBounded(toolMs, amount(snapshot.toolMs));
      activeRequests = addBounded(activeRequests, amount(snapshot.activeRequests));
      activeTools = addBounded(activeTools, amount(snapshot.activeTools));
      if (record.running) running++;
      partial ||= record.partial || snapshot.partial;
      for (const model of snapshot.models) {
        const overflow = mergeModel(models, model);
        partial ||= overflow;
      }
      for (const tool of snapshot.tools) {
        const overflow = mergeTool(tools, tool);
        partial ||= overflow;
      }
    }

    return {
      observed: this.#observed,
      resident: this.#workers.size,
      running,
      busyMs,
      llmMs,
      toolMs,
      activeRequests,
      activeTools,
      health: this.health,
      partial,
      models: publicModels(models),
      tools: [...tools.values()].map((value) => ({ ...value })),
    };
  }

  #markPartial(): void {
    this.#partial = true;
    this.#notify();
  }

  #notify(): void {
    // Stream deltas can be extremely frequent. The owner already refreshes
    // numeric metrics on its timer, so request an immediate paint only for the
    // cheap status signal that is visible outside the details view.
    const health = this.health;
    if (health === this.#notifiedHealth) return;
    this.#notifiedHealth = health;
    try {
      this.#changed();
    } catch {
      // Rendering is optional; telemetry must never affect worker execution.
    }
  }
}
