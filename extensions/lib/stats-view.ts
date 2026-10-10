import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { POPOVER, isPopoverCloseClick, popoverCloseHit, popoverCloseTail, popoverRule, popoverSide }
  from "../../lib/popover-frame.mjs";
import { formatTokenCount } from "../../lib/token-format.mjs";
import type { SessionErrorStats, SessionModelStats, SessionStatsSnapshot, SessionToolStats } from "./session-stats.ts";
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
type ThemeColor = Parameters<Theme["fg"]>[0];

const TABS = ["Overview", "Models", "Tools"] as const;
const TITLE = "Stats · main session + managed workers";
/** Top edge, tab row, divider and the bottom edge, which carries the footer. */
const CHROME_ROWS = 4;
const MIN_FULL_FRAME_ROWS = CHROME_ROWS + 1;
/** Columns between table cells, and the indent of rows under a section title. */
const GAP = 2;
const INDENT = "  ";
/** Columns between Overview tables placed side by side. */
const BLOCK_GAP = 4;
/** A table gives up its least useful columns before names get narrower than this. */
const MIN_KEY = 20;
const LEGEND = "— not reported · 0 observed zero · * partial";
/** Recent errors: the message is why anyone looks, so it gets the room. */
const ERROR_ROWS = 5;
const ERROR_LINES = 3;
const ERROR_MESSAGE_MAX = 72;
const ERROR_MESSAGE_MIN = 24;
const ERROR_MODEL_MAX = 32;
const ERROR_WHERE_MAX = 20;

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

/** Bare figure for a `tok/s` column; the unit lives in the header. */
const formatRate = (value: unknown): string => {
  const tps = nonNegative(value);
  if (tps === undefined) return "—";
  if (tps >= 100) return `${Math.round(tps)}`;
  if (tps >= 10) return tps.toFixed(1);
  return tps.toFixed(2);
};

const formatTps = (value: unknown): string => {
  const rate = formatRate(value);
  return rate === "—" ? rate : `${rate} tok/s`;
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

const healthColor = (health: SessionStatsSnapshot["health"]): ThemeColor =>
  health === "busy" ? "accent" : health === "waiting" ? "warning" : health === "error" ? "error" : "dim";

/** The footer's dot, in the same color, with its state spelled out: activity
 * and attention, not a score. */
const healthText = (health: SessionStatsSnapshot["health"]): string =>
  health === "busy" ? "● busy" : health === "waiting" ? "● waiting" : health === "error" ? "● error"
    : health === "idle" ? "● idle" : "● no activity yet";

/** A real zero recedes, so the rows that did fail stand out. */
const errorTone = (value: unknown): ThemeColor | undefined => {
  const errors = nonNegative(value);
  return errors === undefined ? undefined : errors > 0 ? "error" : "dim";
};

const padEnd = (text: string, size: number): string =>
  text + " ".repeat(Math.max(0, size - visibleWidth(text)));

const padStart = (text: string, size: number): string =>
  " ".repeat(Math.max(0, size - visibleWidth(text))) + text;

const list = <T>(value: readonly T[] | undefined): readonly T[] => Array.isArray(value) ? value : [];

/** Notes read as prose: wrap on words, and leave a word too wide for the row to the row's clip. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (!line || visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Breaks a run of text with no spaces, such as a JSON error body, at the width. */
function chunk(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const character of Array.from(text)) {
    if (line && visibleWidth(line + character) > width) {
      lines.push(line);
      line = "";
    }
    line += character;
  }
  if (line) lines.push(line);
  return lines;
}

/** Word wrap, hard-break what is still too wide, and end a cut message in "…". */
function wrapLines(text: string, width: number, max: number): string[] {
  const lines = wrap(text, width).flatMap((line) => chunk(line, width));
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  const last = kept[max - 1]!;
  kept[max - 1] = (visibleWidth(last) >= width ? chunk(last, Math.max(1, width - 1))[0]! : last) + "…";
  return kept;
}

/** A row name. Provider prefixes are the first thing a narrow table gives up. */
interface RowKey { name: string; prefix?: string; partial?: boolean }

interface Column<Row> {
  header: string;
  /** Lower numbers give way first on a narrow terminal; 0 never does. */
  drop: number;
  cell: (row: Row) => string;
  /** Text by default. A figure that was not reported is always dim. */
  tone?: (row: Row) => ThemeColor | undefined;
}

interface Section<Row> {
  /** Untitled, the rows sit directly under the header, without an indent. */
  title?: string;
  rows: readonly Row[];
  empty?: string;
}

interface Grid<Row> {
  /** Header of the name column, or with `titled` the name of the whole table. */
  header: string;
  titled?: boolean;
  key: (row: Row) => RowKey;
  columns: readonly Column<Row>[];
  sections: readonly Section<Row>[];
}

const keyLabel = (key: RowKey, prefixed: boolean): string =>
  `${prefixed && key.prefix ? key.prefix : ""}${key.name}${key.partial ? "*" : ""}`;

function keyCell(theme: StatsTheme, key: RowKey, room: number, prefixed: boolean): string {
  if (room <= 0) return "";
  const mark = key.partial ? "*" : "";
  const space = room - mark.length;
  // The prefix may be all that tells two rows apart: it is cut last.
  const prefix = prefixed && key.prefix ? truncateToWidth(key.prefix, space, "…") : "";
  const name = truncateToWidth(key.name, Math.max(0, space - visibleWidth(prefix)), "…");
  const used = visibleWidth(prefix) + visibleWidth(name) + mark.length;
  return (prefix ? theme.fg("dim", prefix) : "") + theme.fg("text", name) +
    (mark ? theme.fg("warning", mark) : "") + " ".repeat(Math.max(0, room - used));
}

/**
 * Left-aligned names, right-aligned figures, one row per entry. Sizes come
 * from the plain cell text before any color is applied. A narrow terminal
 * gives up columns before it starts eating names; with nothing left to give
 * up, names take whatever remains and the row clip has the final say.
 */
function grid<Row>(theme: StatsTheme, width: number, table: Grid<Row>): string[] {
  const sections = table.sections.map((section) => ({
    section,
    indent: section.title ? INDENT : "",
    rows: section.rows.map((row) => ({ row, key: table.key(row), cells: table.columns.map((column) => column.cell(row)) })),
  }));
  const entries = sections.flatMap(({ indent, rows }) => rows.map((entry) => ({ ...entry, indent })));
  const sizes = table.columns.map((column, index) =>
    entries.reduce((max, { cells }) => Math.max(max, visibleWidth(cells[index]!)), visibleWidth(column.header)));
  let shown = table.columns.map((_, index) => index);
  const figures = (): number => shown.reduce((sum, index) => sum + GAP + sizes[index]!, 0);
  // Only as wide as the longest name: figures sit next to what they describe
  // instead of drifting to the far edge of a wide terminal.
  const wanted = (prefixed: boolean): number => entries.reduce((max, { key, indent }) =>
    Math.max(max, indent.length + visibleWidth(keyLabel(key, prefixed))), visibleWidth(table.header));
  // All rows or none: a prefix on only the rows short enough for one would
  // read as a difference between them. Same names in one section are told
  // apart only by it, so then optional columns give way to it instead.
  const ambiguous = sections.some(({ rows }) => new Set(rows.map(({ key }) => key.name)).size < rows.length);
  const prefixed = ambiguous || wanted(true) + figures() <= width;
  const prefixRoom = ambiguous ? entries.reduce((max, { key }) => Math.max(max, visibleWidth(key.prefix ?? "")), 0) : 0;
  while (Math.min(wanted(prefixed), MIN_KEY + prefixRoom) + figures() > width) {
    const victim = shown.filter((index) => table.columns[index]!.drop > 0)
      .sort((a, b) => table.columns[a]!.drop - table.columns[b]!.drop)[0];
    if (victim === undefined) break;
    shown = shown.filter((index) => index !== victim);
  }
  const keyWidth = Math.max(1, Math.min(wanted(prefixed), width - figures()));
  const gap = " ".repeat(GAP);

  const head = padEnd(truncateToWidth(table.header, keyWidth, "…"), keyWidth);
  const lines = [(table.titled ? theme.fg("accent", theme.bold(head)) : theme.fg("muted", head)) +
    theme.fg("muted", shown.map((index) => gap + padStart(table.columns[index]!.header, sizes[index]!)).join(""))];
  for (const { section, indent, rows } of sections) {
    if (section.title) lines.push(theme.fg("accent", theme.bold(section.title)));
    if (rows.length === 0 && section.empty) lines.push(indent + theme.fg("dim", section.empty));
    for (const { row, key, cells } of rows) {
      lines.push(indent + keyCell(theme, key, keyWidth - indent.length, prefixed) + shown.map((index) => {
        const text = cells[index]!;
        const tone = text === "—" ? "dim" : table.columns[index]!.tone?.(row) ?? "text";
        return gap + theme.fg(tone, padStart(text, sizes[index]!));
      }).join(""));
    }
  }
  return lines;
}

/** Small tables side by side while they fit, wrapping to a new band below. */
function beside(blocks: readonly string[][], width: number): string[] {
  const lines: string[] = [];
  let band: { block: string[]; width: number }[] = [];
  const bandWidth = (): number => band.reduce((sum, { width }) => sum + width, Math.max(0, band.length - 1) * BLOCK_GAP);
  const flush = (): void => {
    if (band.length === 0) return;
    if (lines.length > 0) lines.push("");
    const height = Math.max(...band.map(({ block }) => block.length));
    for (let row = 0; row < height; row++) {
      lines.push(band.map(({ block, width }, index) =>
        index === band.length - 1 ? block[row] ?? "" : padEnd(block[row] ?? "", width)).join(" ".repeat(BLOCK_GAP)));
    }
    band = [];
  };
  for (const block of blocks) {
    const blockWidth = block.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    if (band.length > 0 && bandWidth() + BLOCK_GAP + blockWidth > width) flush();
    band.push({ block, width: blockWidth });
  }
  flush();
  return lines;
}

interface ErrorRow { where: string; error: SessionErrorStats }

/** Main and worker failures, newest first. */
function recentErrors(snapshot: StatsDashboardSnapshot): ErrorRow[] {
  return [
    ...list(snapshot.recentErrors).map((error) => ({ where: "main", error })),
    ...list(snapshot.workers?.recentErrors).map((error) => ({ where: oneLine(error.workerId) || "worker", error })),
  ].sort((a, b) => (nonNegative(a.error.ageMs) ?? 0) - (nonNegative(b.error.ageMs) ?? 0)).slice(0, ERROR_ROWS);
}

/**
 * Where, when, which model and what the provider said. `!` still holds the
 * indicator red; `·` was cleared by something that succeeded after it.
 */
function errorTable(theme: StatsTheme, width: number, rows: readonly ErrorRow[]): string[] {
  const cells = rows.map(({ where, error }) => {
    const provider = oneLine(error.provider);
    const model = oneLine(error.model);
    return { cleared: error.cleared === true, where, when: formatAge(error.ageMs),
      model: model ? `${provider ? `${provider}/` : ""}${model}` : "—",
      message: oneLine(error.message) || "No error text reported." };
  });
  const title = "Recent errors";
  // Indent, the mark and its space come before the name.
  const keyWidth = Math.max(visibleWidth(title),
    ...cells.map(({ where }) => INDENT.length + 2 + Math.min(ERROR_WHERE_MAX, visibleWidth(where))));
  const whenWidth = Math.max(visibleWidth("When"), ...cells.map(({ when }) => visibleWidth(when)));
  let modelWidth = Math.min(ERROR_MODEL_MAX, Math.max(visibleWidth("Model"), ...cells.map(({ model }) => visibleWidth(model))));
  const lead = (): number => keyWidth + GAP + whenWidth + (modelWidth ? GAP + modelWidth : 0) + GAP;
  if (width - lead() < ERROR_MESSAGE_MIN) modelWidth = 0;
  const messageWidth = Math.max(1, Math.min(ERROR_MESSAGE_MAX, width - lead()));
  const gap = " ".repeat(GAP);
  const nameWidth = keyWidth - INDENT.length - 2;

  const lines = [theme.fg("accent", theme.bold(padEnd(title, keyWidth))) + theme.fg("muted",
    gap + padStart("When", whenWidth) + (modelWidth ? gap + padEnd("Model", modelWidth) : "") + gap + "Message")];
  for (const cell of cells) {
    const tone = cell.cleared ? "dim" : "text";
    const [first = "", ...rest] = wrapLines(cell.message, messageWidth, ERROR_LINES);
    lines.push(INDENT + theme.fg(cell.cleared ? "dim" : "error", cell.cleared ? "·" : "!") + " " +
      theme.fg(tone, padEnd(truncateToWidth(cell.where, nameWidth, "…"), nameWidth)) +
      gap + theme.fg(tone, padStart(cell.when, whenWidth)) +
      (modelWidth ? gap + theme.fg(tone, padEnd(truncateToWidth(cell.model, modelWidth, "…"), modelWidth)) : "") +
      gap + theme.fg(tone, first));
    for (const line of rest) lines.push(" ".repeat(lead()) + theme.fg(tone, line));
  }
  return lines;
}

/** An empty cell is "does not apply", unlike "—", which was not reported. */
interface OverviewRow { label: string; main: string; workers?: string }

function overviewGrids(snapshot: StatsDashboardSnapshot): Grid<OverviewRow>[] {
  const w = snapshot.workers;
  const worker = (value: (workers: WorkerStatsSnapshot) => string): string => w ? value(w) : "—";
  const table = (title: string, sides: readonly ("main" | "workers")[], rows: OverviewRow[]): Grid<OverviewRow> => ({
    header: title,
    titled: true,
    key: (row) => ({ name: row.label }),
    columns: sides.map((side) => ({ header: side === "main" ? "Main" : "Workers", drop: 0, cell: (row) => row[side] ?? "" })),
    sections: [{ rows }],
  });
  return [
    table("Time", ["main", "workers"], [
      { label: "Busy", main: formatMs(snapshot.busyMs), workers: worker((w) => formatMs(w.busyMs)) },
      { label: "Idle", main: formatMs(snapshot.idleMs) },
      { label: "LLM Σ", main: formatMs(snapshot.llmMs), workers: worker((w) => formatMs(w.llmMs)) },
      { label: "Tools Σ", main: formatMs(snapshot.toolMs), workers: worker((w) => formatMs(w.toolMs)) },
      { label: "Approval wait", main: formatMs(snapshot.approvalMs) },
    ]),
    table("Now", ["main", "workers"], [
      { label: "Agents running", main: "", workers: worker((w) => `${formatCount(w.running)} of ${formatCount(w.resident)}`) },
      { label: "Requests", main: formatCount(snapshot.activeRequests), workers: worker((w) => formatCount(w.activeRequests)) },
      { label: "Tool calls", main: formatCount(snapshot.activeTools), workers: worker((w) => formatCount(w.activeTools)) },
      { label: "Approvals pending", main: formatCount(snapshot.pendingApprovals) },
      { label: "Last event", main: formatAge(snapshot.lastActivityMs) },
    ]),
    table("Last main request", ["main"], [
      { label: "TTFT", main: formatMs(snapshot.lastTtftMs) },
      { label: "First text", main: formatMs(snapshot.lastTextMs) },
      { label: "Output speed", main: formatTps(snapshot.lastTps) },
    ]),
  ];
}

const MODEL_COLUMNS: readonly Column<SessionModelStats>[] = [
  { header: "Req", drop: 4, cell: (entry) => formatCount(entry.requests) },
  { header: "Err", drop: 3, cell: (entry) => formatCount(entry.errors), tone: (entry) => errorTone(entry.errors) },
  { header: "LLM Σ", drop: 5, cell: (entry) => formatMs(entry.llmMs) },
  // The collector already publishes the mean; without samples there is none.
  { header: "TTFT", drop: 0,
    cell: (entry) => (nonNegative(entry.ttftSamples) ?? 0) === 0 ? "—" : formatMs(entry.ttftMs) },
  { header: "tok/s", drop: 6, cell: (entry) => formatRate(entry.tps) },
  { header: "Out", drop: 1, cell: (entry) => formatCount(entry.outputTokens) },
  { header: "Cost", drop: 2, cell: (entry) => formatCost(entry.cost) },
];

const TOOL_COLUMNS: readonly Column<SessionToolStats>[] = [
  { header: "Calls", drop: 4, cell: (entry) => formatCount(entry.calls) },
  { header: "Err", drop: 2, cell: (entry) => formatCount(entry.errors), tone: (entry) => errorTone(entry.errors) },
  { header: "Σ time", drop: 0, cell: (entry) => formatMs(entry.totalMs) },
  { header: "Avg", drop: 1, cell: (entry) => {
    const calls = nonNegative(entry.calls);
    const total = nonNegative(entry.totalMs);
    return calls && total !== undefined ? formatMs(total / calls) : "—";
  } },
  { header: "Max", drop: 3, cell: (entry) => formatMs(entry.maxMs) },
];

const observedWorkers = (workers: WorkerStatsSnapshot | undefined): string =>
  !workers ? "no observed workers" : `${formatCount(workers.observed)} observed worker${workers.observed === 1 ? "" : "s"}`;

/**
 * The Overview's "Time" table alone, as plain text. Regular-mode Pi has no
 * overlay for the full view, so it gets this summary as a notice instead.
 */
export function statsSummary(snapshot: StatsDashboardSnapshot): string[] {
  const plain: StatsTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
  const errors = recentErrors(snapshot);
  return [...grid(plain, 60, overviewGrids(snapshot)[0]!),
    ...(errors.length > 0 ? ["", ...errorTable(plain, 100, errors)] : [])].map((line) => line.trimEnd());
}

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
  /** Widest content seen while open; see `preferredWidth`. */
  private wanted = 0;

  constructor(private readonly options: StatsViewOptions) {}

  /**
   * Columns the content wants, at most `max`. The box hugs its tables rather
   * than stretching a few narrow columns across a wide terminal, and it is
   * sized for its widest tab so it does not move when the tab changes. It
   * never narrows while open: a figure losing a digit must not make the
   * centered box twitch at the next refresh.
   */
  preferredWidth(max: number): number {
    const limit = Math.max(1, Math.floor(finite(max) ?? 1));
    if (this.disposed) return limit;
    const snapshot = this.readSnapshot();
    const figures = ([0, 1, 2] as const).flatMap((tab) => this.content(snapshot, tab, Math.max(1, limit - 4)).figures);
    const tabs = this.tabLabels(Number.MAX_SAFE_INTEGER).reduce((sum, label) => sum + visibleWidth(label) + 2, 0);
    this.wanted = Math.max(this.wanted,
      4 + figures.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0),
      4 + tabs + (snapshot ? GAP + visibleWidth(this.status(snapshot)) : 0),
      // `╭─`, the padded title, one rule column and the ` × ─╮` close tail.
      2 + visibleWidth(TITLE) + 2 + 1 + 5);
    return Math.min(limit, this.wanted);
  }

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
    const inner = Math.max(1, columns - 4);
    // Sized to the longest tab, never a fixed reservation of blank rows, so
    // the centered box neither jumps between tabs nor pads a short one to 75%.
    const bodies = ([0, 1, 2] as const).map((tab) => {
      const { figures, notes } = this.content(snapshot, tab, inner);
      return [...figures, ...this.notes(notes, inner)];
    });
    const content = bodies[this.tab];
    const viewport = Math.max(1, Math.min(budget - CHROME_ROWS, Math.max(...bodies.map((body) => body.length))));
    const maxScroll = Math.max(0, content.length - viewport);
    const offset = Math.min(this.offsets[this.tab], maxScroll);
    this.offsets[this.tab] = offset;
    this.paintedViewport = viewport;
    this.paintedMaxScroll = maxScroll;

    const lines = [this.top(columns), this.tabs(columns, snapshot), popoverRule(this.options.theme, columns, "divider")];
    for (const line of content.slice(offset, offset + viewport)) lines.push(this.row(line, columns));
    while (lines.length < 3 + viewport) lines.push(this.row("", columns));
    lines.push(this.bottom(columns, content.length, offset, viewport));
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

  /** The tables, and the caveats that qualify them, to be shown quietly below. */
  private content(snapshot: StatsDashboardSnapshot | undefined, tab: Tab, width: number): { figures: string[]; notes: string[] } {
    const theme = this.options.theme;
    if (!snapshot) return { figures: [theme.fg("error", "Statistics are unavailable.")], notes: [LEGEND] };
    if (tab === 0) {
      const errors = recentErrors(snapshot);
      return {
        figures: [...beside(overviewGrids(snapshot).map((table) => grid(theme, width, table)), width),
          ...(errors.length > 0 ? ["", ...errorTable(theme, width, errors)] : [])],
        notes: [
          ...(errors.length > 0
            ? ["Errors: ! still holds the indicator red, · no longer does. Red clears when a later response " +
              "succeeds or the next run starts; a worker's also on release or when a parent run ends on an answer."] : []),
          `Worker figures add up ${observedWorkers(snapshot.workers)}. ` +
            "LLM/tool sums overlap; they are not additive wall-time parts.",
          "Approval wait includes forwarded worker asks, counted once. " +
            "Latency starts at SDK turn start (includes preflight), not transport-only.",
          "No replay; compaction, cache warming and hidden retries excluded.",
          LEGEND,
        ],
      };
    }
    if (tab === 1) return {
      figures: this.models(snapshot, width),
      notes: [
        "TTFT is the mean from SDK turn start (includes preflight). " +
          "E2E tok/s = reported output / SDK turn time, not decoder speed.",
        LEGEND,
      ],
    };
    return {
      figures: this.tools(snapshot, width),
      notes: ["Σ adds parallel calls and can exceed wall time. Avg = Σ / calls.", LEGEND],
    };
  }

  /** Wrapped to the row, below a blank line, dim: present, but not competing with the figures. */
  private notes(notes: string[], width: number): string[] {
    return ["", ...notes.flatMap((note) => wrap(note, width)).map((line) => this.options.theme.fg("dim", line))];
  }

  private models(snapshot: StatsDashboardSnapshot, width: number): string[] {
    return grid(this.options.theme, width, {
      header: "Model",
      // The collector keys by provider + model; the prefix keeps distinct rows
      // with the same raw model id apart, and shows wherever there is room.
      key: (entry) => {
        const provider = oneLine(entry.provider);
        return { name: oneLine(entry.model) || "unnamed model", ...(provider ? { prefix: `${provider}/` } : {}),
          partial: entry.partial === true };
      },
      columns: MODEL_COLUMNS,
      sections: [
        { title: "Main", rows: list(snapshot.models), empty: "No observed model requests yet." },
        { title: "Workers", rows: list(snapshot.workers?.models),
          empty: snapshot.workers ? "No observed worker requests yet." : "Workers not observed." },
      ],
    });
  }

  private tools(snapshot: StatsDashboardSnapshot, width: number): string[] {
    return grid(this.options.theme, width, {
      header: "Tool",
      key: (entry) => ({ name: oneLine(entry.tool) || "unnamed tool", partial: entry.partial === true }),
      columns: TOOL_COLUMNS,
      sections: [
        { title: "Main", rows: list(snapshot.tools), empty: "No observed tool calls yet." },
        { title: "Workers", rows: list(snapshot.workers?.tools),
          empty: snapshot.workers ? "No observed worker tool calls yet." : "Workers not observed." },
      ],
    });
  }

  private compact(width: number, budget: number): string[] {
    this.paintedViewport = 0;
    this.paintedMaxScroll = 0;
    const middle = [this.tabs(width, undefined), this.row(this.options.theme.fg("dim", "Terminal too short for Stats"), width)];
    const lines = [this.top(width), ...middle.slice(0, Math.max(0, budget - 2))];
    while (lines.length < budget - 1) lines.push(this.row("", width));
    if (budget > 1) lines.push(this.bottom(width, 0, 0, 0));
    return lines.map((line) => this.fit(line, width));
  }

  private top(width: number): string {
    if (width < 3) return this.fit(this.options.theme.fg("borderAccent", POPOVER.h.repeat(width)), width);
    const closable = !!popoverCloseHit(width);
    const tailWidth = closable ? 5 : 1;
    const room = width - 2 - tailWidth;
    if (room < 1) return popoverRule(this.options.theme, width, "top");
    const label = truncateToWidth(` ${TITLE} `, room, "…");
    const fill = POPOVER.h.repeat(Math.max(0, room - visibleWidth(label)));
    const head = this.options.theme.fg("borderAccent", POPOVER.tl + POPOVER.h) +
      this.options.theme.fg("accent", this.options.theme.bold(label)) +
      this.options.theme.fg("borderAccent", fill);
    return head + (closable ? popoverCloseTail(this.options.theme) : this.options.theme.fg("borderAccent", POPOVER.tr));
  }

  /** Tabs on the left; on the right, what the dock indicator said, and for how long. */
  private tabs(width: number, snapshot: StatsDashboardSnapshot | undefined): string {
    const theme = this.options.theme;
    const inner = Math.max(0, width - 4);
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
        ? theme.bg?.("selectedBg", theme.fg("accent", theme.bold(raw))) ?? theme.fg("accent", theme.bold(raw))
        : theme.fg("muted", raw);
      pieces.push(styled);
      // Content starts after the side border and its one-column pad.
      this.tabTargets.push({ start: 2 + used, end: 2 + used + segmentWidth, tab });
      used += segmentWidth;
    }
    const left = pieces.join("");
    if (!snapshot) return this.row(left, width);
    const fits = (text: string): boolean => used + GAP + visibleWidth(text) <= inner;
    const full = this.status(snapshot);
    const right = fits(full) ? full : [this.status(snapshot, false)].find(fits);
    return this.row(right ? left + " ".repeat(inner - used - visibleWidth(right)) + right : left, width);
  }

  /** What the dock indicator says, and for how long the window has been observing. */
  private status(snapshot: StatsDashboardSnapshot, elapsed = true): string {
    const theme = this.options.theme;
    return theme.fg(healthColor(snapshot.health), healthText(snapshot.health)) +
      (elapsed ? theme.fg("dim", ` · open ${formatMs(snapshot.elapsedMs)}`) : "") +
      (snapshot.partial ? theme.fg("warning", " *") : "");
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

  /**
   * The footer is inlaid into the bottom edge, `╰─ keys ──── 12/31 lines ─╯`,
   * like the agent detail pane's, rather than spending a divider and a row.
   * It names only the keys that do something now and shortens before it clips.
   */
  private bottom(width: number, total: number, offset: number, viewport: number): string {
    const theme = this.options.theme;
    if (width < 8) return popoverRule(theme, width, "bottom");
    const scrollable = total > viewport && viewport > 0;
    let right = scrollable ? ` ${Math.min(total, offset + viewport)}/${total} lines ` : "";
    // Room for the hint between `╰─` and `─╯`: its two pads and at least one rule column.
    const room = (): number => width - 4 - visibleWidth(right) - 3;
    if (right && room() < 3) right = "";
    const hints = scrollable ? ["1-3/Tab view · ↑↓ PgUp/PgDn scroll · Esc close", "Tab · ↑↓ · Esc", "Esc"]
      : ["1-3/Tab view · Esc close", "Tab · Esc", "Esc"];
    const hint = hints.find((text) => visibleWidth(text) <= room());
    const left = hint ? ` ${hint} ` : "";
    const fill = Math.max(0, width - 4 - visibleWidth(left) - visibleWidth(right));
    const edge = (text: string): string => theme.fg("borderAccent", text);
    return edge(POPOVER.bl + POPOVER.h) + theme.fg("dim", left) + edge(POPOVER.h.repeat(fill)) +
      theme.fg("dim", right) + edge(POPOVER.h + POPOVER.br);
  }

  private row(content: string, width: number): string {
    if (width < 4) return this.fit(content, width);
    const inner = width - 4;
    const clipped = truncateToWidth(content, inner, "…");
    const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return `${popoverSide(this.options.theme)} ${padded} ${popoverSide(this.options.theme)}`;
  }

  private fit(line: string, width: number): string {
    const clipped = truncateToWidth(line, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}
