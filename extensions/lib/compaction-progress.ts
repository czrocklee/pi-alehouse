export interface CompactionProgressStart {
  modelKey?: string;
  tokensBefore: number;
}

export interface CompactionProgressSnapshot {
  text: string;
  elapsedMs: number;
  percent: number | undefined;
}

interface Sample {
  modelKey: string;
  tokens: number;
  durationMs: number;
}

interface Active {
  modelKey: string | undefined;
  tokens: number;
  startedAt: number | undefined;
  elapsedMs: number;
  clockReliable: boolean;
  estimateMs: number | undefined;
  upperMs: number | undefined;
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
  private samples: Sample[] = [];
  private active: Active | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(options: CompactionProgressStart): void {
    const modelKey = typeof options.modelKey === "string" && options.modelKey.length > 0
      ? options.modelKey : undefined;
    const tokens = options.tokensBefore;
    const comparable = modelKey && Number.isFinite(tokens) && tokens > 0
      ? this.samples.filter((sample) => sample.modelKey === modelKey
        && sample.tokens / tokens >= 0.5 && sample.tokens / tokens <= 2)
        .map((sample) => sample.durationMs).sort((a, b) => a - b)
      : [];
    const low = comparable[0];
    const upper = comparable[comparable.length - 1];
    // Require three comparable successes and a deliberately conservative spread.
    const reliable = comparable.length >= 3 && low !== undefined && upper !== undefined
      && upper / low <= 1.5;
    const middle = Math.floor(comparable.length / 2);
    const estimate = reliable
      ? (comparable.length % 2 === 0
        ? ((comparable[middle - 1] ?? 0) + (comparable[middle] ?? 0)) / 2
        : comparable[middle])
      : undefined;
    const startedAt = this.readClock();
    // Repeated starts discard, rather than train on, the unfinished observation.
    this.active = { modelKey, tokens, startedAt, elapsedMs: 0,
      clockReliable: startedAt !== undefined, estimateMs: estimate, upperMs: upper };
  }

  finish(success: boolean): void {
    const active = this.active;
    if (!active) return;
    this.measure(active);
    this.active = undefined;
    if (!success || !active.clockReliable || !active.modelKey
      || !Number.isFinite(active.tokens) || active.tokens <= 0 || active.elapsedMs <= 0) return;
    const sameKey = this.samples.filter((sample) => sample.modelKey === active.modelKey);
    if (sameKey.length >= 8) {
      const oldest = this.samples.findIndex((sample) => sample.modelKey === active.modelKey);
      this.samples.splice(oldest, 1);
    }
    this.samples.push({ modelKey: active.modelKey, tokens: active.tokens, durationMs: active.elapsedMs });
    if (this.samples.length > 64) this.samples.shift();
  }

  snapshot(): CompactionProgressSnapshot | undefined {
    const active = this.active;
    if (!active) return undefined;
    const elapsedMs = this.measure(active);
    let percent: number | undefined;
    if (active.estimateMs !== undefined && active.upperMs !== undefined) {
      const estimatedPercent = Math.floor(elapsedMs / active.estimateMs * 100);
      // Never park at 95%, and never resurrect an expired estimate.
      if (elapsedMs >= active.upperMs || estimatedPercent >= 95 || !active.clockReliable) {
        active.estimateMs = undefined;
      } else {
        percent = Math.max(0, estimatedPercent);
      }
    }
    const frame = FRAMES[Math.floor(elapsedMs / 100) % FRAMES.length] ?? FRAMES[0];
    return { text: `${frame} ${percent === undefined ? "" : `≈${percent}% `}${duration(elapsedMs)}`,
      elapsedMs, percent };
  }

  reset(): void {
    this.active = undefined;
    this.samples = [];
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
    const elapsed = current !== undefined && active.startedAt !== undefined
      ? current - active.startedAt : NaN;
    if (!Number.isFinite(elapsed) || elapsed < active.elapsedMs) {
      active.clockReliable = false;
    } else {
      active.elapsedMs = elapsed;
    }
    return active.elapsedMs;
  }
}
