import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { POPOVER, isPopoverCloseClick, popoverCloseHit, popoverCloseTail, popoverRule, popoverSide }
  from "../../lib/popover-frame.mjs";
import { formatTokenCount } from "../../lib/token-format.mjs";
import type { SessionStatsSnapshot } from "./session-stats.ts";
import type { WorkerStatsSnapshot } from "./worker-stats.ts";

/** Main wall time and cumulative worker time are deliberately separate. */
export interface StatsDashboardSnapshot extends SessionStatsSnapshot {
  workers?: WorkerStatsSnapshot;
}

/** The small structural subset of Pi's theme the view needs. */
type StatsTheme = Pick<Theme, "fg" | "bold" | "bg">;

type StatsTui = {
  readonly terminal: { readonly rows: number };
  requestRender(): void;
};

export interface StatsViewOptions {
  tui: StatsTui;
  theme: StatsTheme;
  /** Read at paint time. The owner, rather than this component, owns refresh. */
  snapshot: () => StatsDashboardSnapshot;
  close: () => void;
}

type Tab = 0 | 1 | 2;

const TABS = ["Overview", "Models", "Tools"] as const;
const CHROME_ROWS = 6;
const MIN_FULL_FRAME_ROWS = CHROME_ROWS + 1;
const CONTROL_TEXT = "1/2/3 or Tab view · ↑↓ PgUp/PgDn Home/End scroll · Esc close";
const LEGEND = "— not reported · 0 observed zero · * partial";
const SCOPE = "Scope: main + managed workers · since observation window opened";
const EXCLUSIONS = "No replay; compaction, cache warming and hidden retries excluded";
const LATENCY = "Latency starts at SDK turn start (includes preflight), not transport-only.";

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegative = (value: unknown): number | undefined => {
  const number = finite(value);
  return number === undefined || number < 0 ? undefined : number;
};

/** Snapshot strings are data; none may inject a terminal control sequence. */
const oneLine = (value: unknown): string =>
  typeof value === "string"
    ? stripVTControlCharacters(value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ +/g, " ").trim()
    : "";

const formatCount = (value: unknown): string => {
  const number = nonNegative(value);
  if (number === undefined) return "—";
  return formatTokenCount(number, { precision: "compact", trimKZero: true });
};

const formatMs = (value: unknown): string => {
  const milliseconds = nonNegative(value);
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const formatTps = (value: unknown): string => {
  const tps = nonNegative(value);
  if (tps === undefined) return "—";
  if (tps >= 100) return `${Math.round(tps)} tok/s`;
  if (tps >= 10) return `${tps.toFixed(1)} tok/s`;
  return `${tps.toFixed(2)} tok/s`;
};

const formatCost = (value: unknown): string => {
  const cost = nonNegative(value);
  return cost === undefined ? "—" : `$${cost.toFixed(3)}`;
};

/** The collector exposes the age of the latest foreground event, not a wall timestamp. */
const formatAge = (value: unknown): string => {
  const elapsed = nonNegative(value);
  if (elapsed === undefined) return "—";
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
};

type ThemeColor = Parameters<Theme["fg"]>[0];

const healthColor = (health: SessionStatsSnapshot["health"]): ThemeColor =>
  health === "busy" ? "accent" : health === "waiting" ? "warning" : health === "error" ? "error" : "dim";

const healthText = (health: SessionStatsSnapshot["health"]): string =>
  health === "idle" ? "idle (no current activity)" : health === "unknown" ? "no activity observed" : health;

const partial = (row: { partial: boolean }): string => row.partial ? "*" : "";

/** A separate, keyboard-owning view for main and managed-worker observations. */
export class StatsView {
  private tab: Tab = 0;
  /** Per-tab positions survive refreshes and a trip through another tab. */
  private readonly offsets: [number, number, number] = [0, 0, 0];
  private disposed = false;
  private paintedWidth = 0;
  private paintedTabRow = -1;
  private paintedViewport = 0;
  private paintedMaxScroll = 0;
  private tabTargets: { start: number; end: number; tab: Tab }[] = [];

  constructor(private readonly options: StatsViewOptions) {}

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape")) return this.finish();
    if (matchesKey(data, "1")) return this.select(0);
    if (matchesKey(data, "2")) return this.select(1);
    if (matchesKey(data, "3")) return this.select(2);
    if (matchesKey(data, "tab")) return this.select(((this.tab + 1) % TABS.length) as Tab);
    if (matchesKey(data, "shift+tab")) return this.select(((this.tab + TABS.length - 1) % TABS.length) as Tab);
    if (this.paintedViewport === 0) return;

    if (matchesKey(data, "home")) return this.scrollTo(0);
    if (matchesKey(data, "end")) return this.scrollTo(this.paintedMaxScroll);
    if (matchesKey(data, "up")) return this.scrollBy(-1);
    if (matchesKey(data, "down")) return this.scrollBy(1);
    if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) return this.scrollBy(-this.paintedViewport);
    if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) return this.scrollBy(this.paintedViewport);
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (this.disposed) return undefined;
    if (isPopoverCloseClick(event, this.paintedWidth)) {
      this.finish();
      return { handled: true };
    }
    if (event.type === "wheel") {
      const delta = finite(event.wheelDelta);
      if (delta !== undefined && delta !== 0) this.scrollBy(Math.trunc(delta));
      // Keep a wheel over this modal view out of the transcript behind it.
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (event.y === this.paintedTabRow) {
      const target = this.tabTargets.find(({ start, end }) => event.x >= start && event.x < end);
      if (target) this.select(target.tab);
    }
    return { handled: true };
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const columns = Math.max(0, Math.floor(finite(width) ?? 0));
    const rows = Math.max(0, Math.floor(nonNegative(this.options.tui.terminal.rows) ?? 0));
    if (columns === 0 || rows === 0) return [];

    this.paintedWidth = columns;
    this.paintedTabRow = -1;
    this.tabTargets = [];
    const budget = Math.floor(rows * 0.75);
    if (budget === 0) return [];
    if (budget < MIN_FULL_FRAME_ROWS) return this.compact(columns, budget);

    const snapshot = this.readSnapshot();
    const content = this.body(snapshot);
    const viewport = budget - CHROME_ROWS;
    const maxScroll = Math.max(0, content.length - viewport);
    const offset = Math.min(this.offsets[this.tab], maxScroll);
    this.offsets[this.tab] = offset;
    this.paintedViewport = viewport;
    this.paintedMaxScroll = maxScroll;

    const lines = [this.top(columns), this.tabs(columns), popoverRule(this.options.theme, columns, "divider")];
    for (const line of content.slice(offset, offset + viewport)) lines.push(this.row(line, columns));
    while (lines.length < 3 + viewport) lines.push(this.row("", columns));
    lines.push(popoverRule(this.options.theme, columns, "divider"));
    lines.push(this.row(this.footer(content.length, offset, viewport), columns));
    lines.push(popoverRule(this.options.theme, columns, "bottom"));
    return lines.map((line) => this.fit(line, columns));
  }

  /** Pi calls this on theme/data invalidation; refresh ownership remains outside. */
  invalidate(): void {
    if (!this.disposed) this.options.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.tabTargets = [];
    this.paintedViewport = 0;
    this.paintedMaxScroll = 0;
  }

  private finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tabTargets = [];
    this.paintedViewport = 0;
    this.paintedMaxScroll = 0;
    this.options.close();
  }

  private select(next: Tab): void {
    if (this.disposed || next === this.tab) return;
    this.tab = next;
    this.options.tui.requestRender();
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.offsets[this.tab] + delta);
  }

  private scrollTo(next: number): void {
    if (this.disposed) return;
    const offset = Math.max(0, Math.min(this.paintedMaxScroll, Math.floor(next)));
    if (offset === this.offsets[this.tab]) return;
    this.offsets[this.tab] = offset;
    this.options.tui.requestRender();
  }

  private readSnapshot(): StatsDashboardSnapshot | undefined {
    try {
      return this.options.snapshot();
    } catch {
      // The view deliberately reports no exception text: a provider/tool may
      // have placed sensitive text in it, and statistics are not an error log.
      return undefined;
    }
  }

  private body(snapshot: StatsDashboardSnapshot | undefined): string[] {
    if (!snapshot) return [this.options.theme.fg("error", "Statistics are unavailable."), SCOPE, LEGEND];
    if (this.tab === 0) return this.overview(snapshot);
    if (this.tab === 1) return this.models(snapshot);
    return this.tools(snapshot);
  }

  private overview(snapshot: StatsDashboardSnapshot): string[] {
    const theme = this.options.theme;
    const health = theme.fg(healthColor(snapshot.health), healthText(snapshot.health));
    const w = snapshot.workers;
    return [
      SCOPE,
      `Open ${formatMs(snapshot.elapsedMs)} · ${health}${snapshot.partial ? " · * partial" : ""}`,
      `Main wall: busy ${formatMs(snapshot.busyMs)} · idle ${formatMs(snapshot.idleMs)} · activity ${formatAge(snapshot.lastActivityMs)}`,
      `Main Σ: LLM ${formatMs(snapshot.llmMs)} · tools ${formatMs(snapshot.toolMs)}`,
      w ? `Workers: ${formatCount(w.running)} running / ${formatCount(w.resident)} tracked · ${formatCount(w.observed)} observed · busy Σ ${formatMs(w.busyMs)}`
        : "Workers: not observed",
      `Worker Σ: LLM ${formatMs(w?.llmMs)} · tools ${formatMs(w?.toolMs)}`,
      `Live: main ${formatCount(snapshot.activeRequests)} req / ${formatCount(snapshot.activeTools)} tools · workers ${formatCount(w?.activeRequests)} req / ${formatCount(w?.activeTools)} tools`,
      `Parent approval wait: ${formatMs(snapshot.approvalMs)} · ${formatCount(snapshot.pendingApprovals)} pending (counted once)`,
      `Last main: TTFT ${formatMs(snapshot.lastTtftMs)} · text ${formatMs(snapshot.lastTextMs)} · E2E TPS ${formatTps(snapshot.lastTps)}`,
      theme.fg("dim", "LLM/tool sums overlap; they are not additive wall-time parts."),
      theme.fg("dim", LATENCY),
      EXCLUSIONS,
      LEGEND,
    ];
  }

  private models(snapshot: StatsDashboardSnapshot): string[] {
    const models = [
      ...(Array.isArray(snapshot.models) ? snapshot.models : []).map((entry) => ({ source: "main", entry })),
      ...(snapshot.workers?.models ?? []).map((entry) => ({ source: "worker", entry })),
    ];
    const lines = [
      SCOPE,
      this.options.theme.fg("dim", "E2E TPS = reported output / SDK turn time, not decoder speed."),
      this.options.theme.fg("dim", LATENCY),
    ];
    if (models.length === 0) {
      lines.push(this.options.theme.fg("dim", "No observed model requests yet."));
    }
    for (const { source, entry } of models) {
      const model = oneLine(entry.model) || "unnamed model";
      const provider = oneLine(entry.provider);
      // The collector keys by provider + model; hiding the provider would make
      // distinct rows with the same raw model id indistinguishable.
      const identity = provider ? `${provider}/${model}` : model;
      const samples = nonNegative(entry.ttftSamples) ?? 0;
      // The collector already publishes the mean; samples say how much evidence supports it.
      const averageTtft = samples === 0 ? "—" : formatMs(entry.ttftMs);
      const mark = partial(entry);
      lines.push(this.options.theme.fg("accent", `[${source}] ${identity}`) +
        ` · ${formatCount(entry.requests)} req · ${formatCount(entry.errors)} err · LLM ${formatMs(entry.llmMs)}`);
      lines.push(`  TTFT avg ${averageTtft} (${formatCount(samples)} samples) · E2E TPS ${formatTps(entry.tps)} · out ${formatCount(entry.outputTokens)}${mark} · ${formatCost(entry.cost)}${mark}`);
    }
    lines.push(LEGEND);
    return lines;
  }

  private tools(snapshot: StatsDashboardSnapshot): string[] {
    const tools = [
      ...(Array.isArray(snapshot.tools) ? snapshot.tools : []).map((entry) => ({ source: "main", entry })),
      ...(snapshot.workers?.tools ?? []).map((entry) => ({ source: "worker", entry })),
    ];
    const lines = [SCOPE];
    if (tools.length === 0) lines.push(this.options.theme.fg("dim", "No observed tool calls yet."));
    for (const { source, entry } of tools) {
      const tool = oneLine(entry.tool) || "unnamed tool";
      lines.push(this.options.theme.fg("accent", `[${source}] ${tool}${partial(entry)}`));
      lines.push(`  ${formatCount(entry.calls)} calls · total ${formatMs(entry.totalMs)} · max ${formatMs(entry.maxMs)} · ${formatCount(entry.errors)} errors`);
    }
    lines.push(LEGEND);
    return lines;
  }

  private compact(width: number, budget: number): string[] {
    this.paintedViewport = 0;
    this.paintedMaxScroll = 0;
    const middle = [this.tabs(width), this.row(this.options.theme.fg("dim", "Terminal too short for Stats"), width),
      this.row(CONTROL_TEXT, width)];
    const lines = [this.top(width), ...middle.slice(0, Math.max(0, budget - 2))];
    while (lines.length < budget - 1) lines.push(this.row("", width));
    if (budget > 1) lines.push(popoverRule(this.options.theme, width, "bottom"));
    return lines.map((line) => this.fit(line, width));
  }

  private top(width: number): string {
    if (width < 3) return this.fit(this.options.theme.fg("borderAccent", POPOVER.h.repeat(width)), width);
    const closable = !!popoverCloseHit(width);
    const tailWidth = closable ? 5 : 1;
    const room = width - 2 - tailWidth;
    if (room < 1) return popoverRule(this.options.theme, width, "top");
    const label = truncateToWidth(` Stats · ${TABS[this.tab]} `, room, "…");
    const fill = POPOVER.h.repeat(Math.max(0, room - visibleWidth(label)));
    const head = this.options.theme.fg("borderAccent", POPOVER.tl + POPOVER.h) +
      this.options.theme.fg("accent", this.options.theme.bold(label)) +
      this.options.theme.fg("borderAccent", fill);
    return head + (closable ? popoverCloseTail(this.options.theme) : this.options.theme.fg("borderAccent", POPOVER.tr));
  }

  private tabs(width: number): string {
    const inner = Math.max(0, width - 2);
    const choices = this.tabLabels(inner);
    let used = 0;
    const pieces: string[] = [];
    this.paintedTabRow = 1;
    for (let index = 0; index < choices.length; index++) {
      const label = choices[index]!;
      const tab = index as Tab;
      const raw = tab === this.tab ? `›${label}‹` : ` ${label} `;
      const segmentWidth = visibleWidth(raw);
      if (used + segmentWidth > inner) break;
      const styled = tab === this.tab
        ? this.options.theme.bg?.("selectedBg", this.options.theme.fg("accent", this.options.theme.bold(raw))) ??
          this.options.theme.fg("accent", this.options.theme.bold(raw))
        : this.options.theme.fg("muted", raw);
      pieces.push(styled);
      this.tabTargets.push({ start: 1 + used, end: 1 + used + segmentWidth, tab });
      used += segmentWidth;
    }
    return this.row(pieces.join(""), width);
  }

  private tabLabels(inner: number): readonly string[] {
    const full = ["1 Overview", "2 Models", "3 Tools"] as const;
    const short = ["1 Ovr", "2 Mod", "3 Tool"] as const;
    const tiny = ["1", "2", "3"] as const;
    const width = (labels: readonly string[]) => labels.reduce((sum, label) => sum + visibleWidth(label) + 2, 0);
    if (width(full) <= inner) return full;
    if (width(short) <= inner) return short;
    return tiny;
  }

  private footer(total: number, offset: number, viewport: number): string {
    const shown = total === 0 ? 0 : Math.min(total, offset + viewport);
    const position = `${shown}/${total} lines`;
    return `${this.options.theme.fg("dim", position)} · ${this.options.theme.fg("dim", CONTROL_TEXT)}`;
  }

  private row(content: string, width: number): string {
    if (width < 2) return this.fit(content, width);
    const inner = width - 2;
    const clipped = truncateToWidth(content, inner, "…");
    const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return popoverSide(this.options.theme) + padded + popoverSide(this.options.theme);
  }

  private fit(line: string, width: number): string {
    const clipped = truncateToWidth(line, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}
