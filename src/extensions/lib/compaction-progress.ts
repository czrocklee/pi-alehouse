export interface CompactionProgressStart {
  modelKey?: string;
  /** Output tokens of the summary this compaction updates; absent on a first compaction. */
  previousOutputTokens?: number;
}

export interface CompactionProgressSnapshot {
  text: string;
  elapsedMs: number;
  percent: number | undefined;
}

/**
 * Output tokens of the summary a compaction is about to update. The stored entry
 * carries the reported usage; a summary found nowhere on the branch is sized
 * from its text.
 */
export function previousSummaryTokens(
  previousSummary: string | undefined,
  branchEntries: readonly { type: string; summary?: unknown; usage?: { output?: unknown } }[],
): number | undefined {
  if (!previousSummary) return undefined;
  const entry = branchEntries.findLast(
    (candidate) => candidate.type === "compaction" && candidate.summary === previousSummary,
  );
  return summaryOutputTokens(entry) ?? Math.ceil(previousSummary.length / 4);
}

export interface CompactionSample {
  modelKey: string;
  outputTokens: number;
  elapsedMs: number;
}

/** Requested identity, not a provider's optional response-model display alias. */
export function compactionModelKey(
  model: { provider: string; id: string; api: string } | undefined,
  thinkingLevel?: string,
): string | undefined {
  if (!model?.provider || !model.id || !model.api || model.api === "pi-virtual") return undefined;
  return JSON.stringify([model.provider, model.id, model.api, thinkingLevel]);
}

interface Active {
  modelKey: string | undefined;
  startedAt: number | undefined;
  elapsedMs: number;
  clockReliable: boolean;
  estimateMs: number | undefined;
}

/** Summary length remains a heuristic even when throughput has been observed. */
const SUMMARY_GROWTH = 1.15;
const positive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Successful observations per throughput source; each source is bounded on its own. */
export interface CompactionHistoryData {
  compaction: CompactionSample[];
  response: CompactionSample[];
}

function appendSample(samples: CompactionSample[], sample: CompactionSample): void {
  if (samples.filter((value) => value.modelKey === sample.modelKey).length >= 8) {
    samples.splice(
      samples.findIndex((value) => value.modelKey === sample.modelKey),
      1,
    );
  }
  samples.push(sample);
  if (samples.length > 64) samples.shift();
}

/** Total reported output over total corresponding duration, not a mean of ratios. */
function outputRate(samples: readonly CompactionSample[], modelKey: string): number | undefined {
  let tokens = 0;
  let ms = 0;
  for (const sample of samples) {
    if (sample.modelKey !== modelKey) continue;
    tokens += sample.outputTokens;
    ms += sample.elapsedMs;
  }
  const rate = (tokens / ms) * 1000;
  return positive(rate) ? rate : undefined;
}

const validSample = (outputTokens: number, elapsedMs: number): boolean =>
  positive(outputTokens) &&
  positive(elapsedMs) &&
  outputTokens <= Number.MAX_SAFE_INTEGER &&
  elapsedMs <= Number.MAX_SAFE_INTEGER &&
  positive((outputTokens / elapsedMs) * 1000);

/**
 * End-to-end output rates for one requested model identity, from two sources
 * kept apart. The same model runs slower end to end on ordinary turns than on
 * a summary: turns carry the whole conversation as context, and per-request
 * waiting dominates their short outputs. So native compactions are preferred
 * once one exists, and successful foreground Stats timings only cover a cold
 * start. Separate bounds keep frequent turns from evicting compaction samples.
 * Neither source observes pure decoding speed. No sessions or text are retained.
 */
export class CompactionHistory {
  constructor(private readonly data: CompactionHistoryData = { compaction: [], response: [] }) {}

  estimateMs(modelKey: string, previousOutputTokens: number): number | undefined {
    if (!positive(previousOutputTokens) || previousOutputTokens > Number.MAX_SAFE_INTEGER)
      return undefined;
    const rate =
      outputRate(this.data.compaction, modelKey) ?? outputRate(this.data.response, modelKey);
    if (rate === undefined) return undefined;
    const estimate = (previousOutputTokens / rate) * SUMMARY_GROWTH * 1000;
    return positive(estimate) ? estimate : undefined;
  }

  /** A successful native compaction: the request shape being estimated. */
  recordCompaction(modelKey: string, outputTokens: number, elapsedMs: number): void {
    if (modelKey && validSample(outputTokens, elapsedMs))
      appendSample(this.data.compaction, { modelKey, outputTokens, elapsedMs });
  }

  /** A successful ordinary main-model response: a cold-start fallback only. */
  recordResponse(modelKey: string, outputTokens: number, elapsedMs: number): void {
    if (modelKey && validSample(outputTokens, elapsedMs))
      appendSample(this.data.response, { modelKey, outputTokens, elapsedMs });
  }

  clear(): void {
    this.data.compaction.length = 0;
    this.data.response.length = 0;
  }
}

// Stable process-local data only: Pi can re-evaluate independently bundled
// modules on session replacement. Never retain observers, callbacks or sessions.
const COMPACTION_HISTORY_KEY = Symbol.for("pi-alehouse:compaction-progress:history:v1");

const isHistoryData = (value: unknown): value is CompactionHistoryData =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as Partial<CompactionHistoryData>).compaction) &&
  Array.isArray((value as Partial<CompactionHistoryData>).response);

export function sharedCompactionHistory(): CompactionHistory {
  const globals = globalThis as unknown as { [COMPACTION_HISTORY_KEY]?: unknown };
  globals[COMPACTION_HISTORY_KEY] ??= { compaction: [], response: [] };
  const data = globals[COMPACTION_HISTORY_KEY];
  // A foreign or stale value is left alone: estimates then stay local to this
  // module instance instead of throwing inside a compaction hook.
  return new CompactionHistory(isHistoryData(data) ? data : undefined);
}

/** Reported output usage only; a text-length guess must never train real TPS. */
export function summaryOutputTokens(
  entry: { summary?: unknown; usage?: { output?: unknown } } | undefined,
): number | undefined {
  if (!entry) return undefined;
  const reported = entry.usage?.output;
  return typeof reported === "number" && positive(reported) ? reported : undefined;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor(seconds / 60) % 60}m`;
}

/** Pure UI observation only: no timers, IO, events, or compaction control. */
export class CompactionProgress {
  private active: Active | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly history = new CompactionHistory(),
  ) {}

  start(options: CompactionProgressStart): void {
    const modelKey =
      typeof options.modelKey === "string" && options.modelKey.length > 0
        ? options.modelKey
        : undefined;
    // No summary size, no observed model throughput, or virtual routing means
    // elapsed-only. There is no fixed TPS prior to present as measured progress.
    const estimate =
      modelKey && positive(options.previousOutputTokens)
        ? this.history.estimateMs(modelKey, options.previousOutputTokens)
        : undefined;
    const startedAt = this.readClock();
    // Repeated starts discard, rather than train on, the unfinished observation.
    this.active = {
      modelKey,
      startedAt,
      elapsedMs: 0,
      clockReliable: startedAt !== undefined,
      estimateMs: estimate,
    };
  }

  /** `outputTokens` is the finished summary's size; without it nothing is learned. */
  finish(success: boolean, outputTokens?: number): void {
    const active = this.active;
    if (!active) return;
    this.measure(active);
    this.active = undefined;
    if (
      !success ||
      !active.clockReliable ||
      !active.modelKey ||
      !positive(outputTokens) ||
      active.elapsedMs <= 0
    )
      return;
    this.history.recordCompaction(active.modelKey, outputTokens, active.elapsedMs);
  }

  snapshot(): CompactionProgressSnapshot | undefined {
    const active = this.active;
    if (!active) return undefined;
    const elapsedMs = this.measure(active);
    let percent: number | undefined;
    if (active.estimateMs !== undefined) {
      const estimatedPercent = Math.floor((elapsedMs / active.estimateMs) * 100);
      // Never park at 95%, and never resurrect an expired estimate.
      if (estimatedPercent >= 95 || !active.clockReliable) {
        active.estimateMs = undefined;
      } else {
        percent = Math.max(0, estimatedPercent);
      }
    }
    const frame = FRAMES[Math.floor(elapsedMs / 100) % FRAMES.length] ?? FRAMES[0];
    return {
      text: `${frame} ${percent === undefined ? "" : `≈${percent}% `}${duration(elapsedMs)}`,
      elapsedMs,
      percent,
    };
  }

  /** Explicitly clear calibration too; session teardown uses finish(false). */
  reset(): void {
    this.active = undefined;
    this.history.clear();
  }

  private readClock(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private measure(active: Active): number {
    const current = this.readClock();
    const elapsed =
      current !== undefined && active.startedAt !== undefined ? current - active.startedAt : NaN;
    if (!Number.isFinite(elapsed) || elapsed < active.elapsedMs) {
      active.clockReliable = false;
    } else {
      active.elapsedMs = elapsed;
    }
    return active.elapsedMs;
  }
}
