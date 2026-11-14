import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { profileLabel } from "../tools/tool-names.ts";
import { contextPercent, formatMs, GLYPHS, type Theme } from "./format.ts";
import { clipPlainText, singleLineText } from "./text.ts";
import { runPresentation } from "./run-presentation.ts";
import type { WidgetRun } from "./agent-widget.ts";
import { isObservedCost, widgetCost } from "./widget-cost.ts";

export interface HeaderState {
  text: string;
  color: string;
  detail?: string;
  compact?: string;
}
/** Lifecycle state and reached-limit observations are independent: a soft-limit
 * wrap-up can still be running, ask a question, fail or be cancelled. */
export function headerState(run: WidgetRun): HeaderState | undefined {
  const presentation = runPresentation(run.status);
  switch (run.status) {
    case "running":
      return run.finishing
        ? { text: "finishing", compact: runPresentation("running", 0, true).compact, color: "dim" }
        : undefined;
    case "completed":
      return undefined;
    case "needs_input":
      return {
        text: run.question ? "needs answer" : "needs input",
        compact: run.question ? "answer?" : "input?",
        color: "warning",
      };
    case "queued":
    case "cancelling":
    case "cancelled":
      return {
        text: presentation.label,
        compact: presentation.compact,
        color: presentation.color,
      };
    case "failed":
      return {
        text: presentation.label,
        color: presentation.color,
        detail: run.error ?? run.reason,
      };
  }
}
const plainTheme: Theme = { fg: (_color, text) => text, bold: (text) => text };
type Metric = "turns" | "turnClock" | "context" | "cost" | "elapsed";
interface Cell {
  text: string;
  color: string;
  /** A non-applicable turn clock is blank, not an unknown observation. */
  blank?: boolean;
}
export interface WidgetColumns {
  name: number;
  tag: number;
  model: number;
  task: number;
  taskStyle: 0 | 1 | 2;
  metrics: { key: Metric; width: number }[];
}
/** Detached, paint-local pure values. Width allocation and drawing reuse the
 * same observations instead of recomputing every metric in both passes. */
export interface WidgetRow {
  run: WidgetRun;
  headerClock: boolean;
  name: string;
  tag: string;
  model: string;
  description: string;
  state?: HeaderState;
  context?: number;
  cells: Record<Metric, Cell>;
}

/** Preserve severity order within the suffix; complete facts take allocation
 * priority over optional title/configuration/telemetry. */
function attentionText(
  run: WidgetRun,
  state: HeaderState | undefined,
  theme: Theme,
  compact: 0 | 1 | 2,
  detailRoom = 60,
): string {
  const signals: string[] = [];
  if (run.has_run_warnings)
    signals.push(theme.fg("error", compact === 0 ? "run warning" : compact === 1 ? "warn" : "!"));
  if (run.pending_messages > 0)
    signals.push(
      theme.fg("warning", `${run.pending_messages}${compact === 2 ? "pend" : " pending"}`),
    );
  if (state) {
    const cause =
      compact === 0 && state.detail ? readableText(singleLineText(state.detail), detailRoom) : "";
    const detail = cause ? `: ${cause}` : "";
    signals.push(
      theme.fg(state.color, (compact === 2 ? (state.compact ?? state.text) : state.text) + detail),
    );
  }
  return signals.join(theme.fg("dim", compact === 0 ? " · " : " "));
}

/** Current-turn elapsed time, painted once per Agent: in its activity subline,
 * or in its header when that subline is omitted. Exited or finishing execution
 * has no current turn. */
export function turnClock(run: WidgetRun): { text: string; color: string } | undefined {
  if (
    run.status !== "running" ||
    run.execution_exited ||
    run.finishing ||
    run.turn_elapsed_ms === undefined
  )
    return undefined;
  return {
    text: formatMs(run.turn_elapsed_ms),
    color: run.turn_elapsed_ms >= 60_000 ? "warning" : "dim",
  };
}

export function prepareWidgetRow(run: WidgetRun, headerClock = false): WidgetRow {
  const profile = singleLineText(profileLabel(singleLineText(run.profile)));
  const name = singleLineText(run.name);
  const difficulty =
    Number.isInteger(run.difficulty) && run.difficulty >= 1 && run.difficulty <= 5
      ? `d${run.difficulty}`
      : "";
  const context = contextPercent(run.runtime?.context);
  // Whole percentages, but rounding never crosses a tint threshold the
  // observation has not reached: 69.9% reads "ctx 69%" untinted, not "ctx 70%".
  const shownContext =
    context === undefined
      ? undefined
      : [90, 70].reduce(
          (shown, limit) => (context < limit && shown >= limit ? limit - 1 : shown),
          Math.round(context),
        );
  const cost = run.cost;
  const state = headerState(run);
  const clock = headerClock ? turnClock(run) : undefined;
  return {
    run,
    headerClock: clock !== undefined,
    name: name || profile,
    tag: name ? [profile, difficulty].filter(Boolean).join("/") : difficulty,
    model: [run.model, run.effort].filter(Boolean).map(singleLineText).filter(Boolean).join("/"),
    description: singleLineText(run.description),
    state,
    context,
    cells: {
      turns: {
        text: `${GLYPHS.turns}${run.turns}/${run.max_turns}`,
        color: run.max_turns > 0 && run.turns / run.max_turns >= 0.8 ? "warning" : "dim",
      },
      turnClock: { text: clock?.text ?? "", color: clock?.color ?? "dim", blank: true },
      context: {
        text: run.runtime?.context
          ? `ctx ${shownContext === undefined ? "?" : `${shownContext}%`}`
          : "",
        color:
          context === undefined
            ? "dim"
            : context >= 90
              ? "error"
              : context >= 70
                ? "warning"
                : "dim",
      },
      cost: {
        text: isObservedCost(cost) ? widgetCost(cost, run.cost_partial) : "",
        color: "dim",
      },
      elapsed: { text: formatMs(run.elapsed_ms), color: "dim" },
    },
  };
}
const METRICS: readonly Metric[] = ["turns", "turnClock", "context", "cost", "elapsed"];
const LIMIT_SUFFIX = "(turn limit reached)";
const SHORT_LIMIT_SUFFIX = "(limit)";
/** Facts belong to this task, never to a separately padded roster column. */
function taskSuffix(
  row: WidgetRow,
  theme: Theme,
  style: 0 | 1 | 2,
  detailRoom: number,
  limit = LIMIT_SUFFIX,
  state = row.state,
): string {
  const attention = attentionText(row.run, state, theme, style, detailRoom);
  const facts = attention ? theme.fg("dim", "(") + attention + theme.fg("dim", ")") : "";
  return [facts, row.run.limit_reached && limit ? theme.fg("warning", limit) : ""]
    .filter(Boolean)
    .join(" ");
}

/** A short label fits whole; an ellipsized label needs four literal cells,
 * excluding the ellipsis. A one-cell title fragment is not useful content. */
function readableText(text: string, width: number): string {
  if (!(width > 0) || visibleWidth(text) === 0) return "";
  const clipped = clipPlainText(text, width);
  if (clipped === text) return text;
  const prefix = clipped.endsWith("…") ? clipped.slice(0, -1) : clipped;
  return visibleWidth(prefix) >= Math.min(4, visibleWidth(text)) ? clipped : "";
}
const readableMinimum = (text: string): number => {
  const width = visibleWidth(text);
  return width <= 4 ? width : 5;
};
const taskWidth = (
  row: WidgetRow,
  style: 0 | 1 | 2 = 0,
  detailRoom = 60,
  titleRoom = Infinity,
  limit = LIMIT_SUFFIX,
): number => {
  const title = Math.min(titleRoom, visibleWidth(row.description));
  const suffix = visibleWidth(taskSuffix(row, plainTheme, style, detailRoom, limit));
  return title + suffix + (title && suffix ? 1 : 0);
};

/** One row's actual task budget, shared by measurement and painting. The
 * complete short limit participates in fit before facts/cause are shortened;
 * it can disappear only as a whole when even that marker cannot fit. */
function planTask(
  row: WidgetRow,
  width: number,
  style: 0 | 1 | 2,
  state = row.state,
  allowOmitLimit = true,
) {
  const suffixWidth = (detail: number, limit: string): number =>
    visibleWidth(taskSuffix(row, plainTheme, style, detail, limit, state));
  const cause = style === 0 && state?.detail ? singleLineText(state.detail) : "";
  const maximumDetail = Math.min(60, visibleWidth(cause));
  const minimumDetail = readableMinimum(cause);
  const minimumTitle = readableMinimum(row.description);
  let limit = row.run.limit_reached ? LIMIT_SUFFIX : "";
  const titleGap = minimumTitle ? minimumTitle + (suffixWidth(maximumDetail, limit) ? 1 : 0) : 0;
  if (row.run.limit_reached && suffixWidth(maximumDetail, limit) + titleGap > width)
    limit = SHORT_LIMIT_SUFFIX;
  if (suffixWidth(0, limit) > width) {
    if (!allowOmitLimit) return undefined;
    limit = "";
  }
  const base = suffixWidth(0, limit);
  if (base > width) return undefined;
  // A readable title is a soft floor. If it cannot coexist with a useful
  // cause, the title yields; extra title space never displaces cause cells.
  const titleReserve =
    minimumTitle &&
    base + minimumTitle + (base ? 1 : 0) + (maximumDetail ? 2 + minimumDetail : 0) <= width
      ? minimumTitle + (base ? 1 : 0)
      : 0;
  let detailRoom = maximumDetail
    ? Math.min(maximumDetail, Math.max(0, width - base - titleReserve - 2))
    : 0;
  if (detailRoom < minimumDetail) detailRoom = 0;
  const suffix = suffixWidth(detailRoom, limit);
  const title = readableText(row.description, width - suffix - (suffix ? 1 : 0));
  return { title, detailRoom, limit };
}

/** Paint only a fitting plan: no count, parenthetical fact or limit marker is
 * handed to the outer row clip as an oversized/truncated fragment. */
function taskText(
  row: WidgetRow,
  theme: Theme,
  tint: string,
  width: number,
  style: 0 | 1 | 2 = 0,
  state = row.state,
): string {
  const plan = planTask(row, width, style, state);
  if (!plan) return "";
  const suffix = taskSuffix(row, theme, style, plan.detailRoom, plan.limit, state);
  return (
    (plan.title ? theme.fg(tint, plan.title) : "") + (plan.title && suffix ? " " : "") + suffix
  );
}
// truncateToWidth's padding covers left-aligned cells; right-aligned numeric
// cells still need leading spaces, measured in terminal cells rather than UTF16.
const pad = (text: string, width: number, right = false): string =>
  right
    ? " ".repeat(Math.max(0, width - visibleWidth(text))) + text
    : truncateToWidth(text, width, "…", true);

/** The caller supplies painted compact headers or the complete expanded roster.
 * One geometry spans those rows; task facts and a fallback turn clock never
 * yield to optional model/context columns. */
export function widgetColumns(
  rows: readonly WidgetRow[],
  width: number,
): WidgetColumns | undefined {
  if (!Number.isFinite(width) || width < 80 || rows.length === 0) return undefined;
  const name = Math.min(24, Math.max(...rows.map((row) => visibleWidth(row.name))));
  const tag = Math.max(...rows.map((row) => visibleWidth(row.tag)));
  let model = Math.max(...rows.map((row) => visibleWidth(row.model)));
  let metrics = METRICS.map((key) => ({
    key,
    width: Math.max(0, ...rows.map((row) => visibleWidth(row.cells[key].text))),
  })).filter((column) => column.width > 0);
  // Fixed columns hug their contents. The 24-cell preference belongs to the
  // title itself, not a title+facts total. Each row gets its own bounded cause.
  const naturalTask = Math.max(...rows.map((row) => taskWidth(row)));
  const minimumTask = (style: 0 | 1 | 2): number =>
    Math.max(...rows.map((row) => taskWidth(row, style, 0, 0, SHORT_LIMIT_SUFFIX)));
  const wantedTask = Math.max(
    ...rows.map((row) =>
      taskWidth(row, 0, 60, Math.min(24, visibleWidth(row.description)), LIMIT_SUFFIX),
    ),
  );
  const contentRoom = () =>
    width -
    2 -
    name -
    (tag ? tag + 2 : 0) -
    (model ? model + 2 : 0) -
    metrics.reduce((sum, column) => sum + column.width + 2, 0) -
    (naturalTask ? 2 : 0);
  if (contentRoom() < wantedTask) model = 0;
  for (const key of ["context", "elapsed", "cost", "turns"] as const)
    if (contentRoom() < wantedTask) metrics = metrics.filter((column) => column.key !== key);
  const taskStyle = ([0, 1, 2] as const).find((style) => contentRoom() >= minimumTask(style));
  if (taskStyle === undefined) return undefined;
  const task = Math.min(naturalTask, contentRoom());
  return { name, tag, model, task, taskStyle, metrics };
}

export function renderHeader(
  run: WidgetRun,
  icon: string,
  state: HeaderState | undefined,
  running: boolean,
  theme: Theme,
  width: number,
  columns?: WidgetColumns | null,
  row = prepareWidgetRow(run),
): string {
  width = Math.max(0, Math.floor(width));
  if (!(width > 0)) return "";
  const { name, tag, model, description } = row;
  const tint = running ? "text" : "muted";
  if (columns) {
    const shortName = truncateToWidth(name, columns.name, "…");
    const head =
      `${icon} ${pad(running ? theme.bold(shortName) : theme.fg("muted", shortName), columns.name)}` +
      (columns.tag
        ? `  ${pad(theme.fg(run.profile === "researcher" ? "muted" : "dim", tag), columns.tag)}`
        : "") +
      (columns.model ? `  ${pad(theme.fg("dim", model), columns.model)}` : "");
    return (
      head +
      columns.metrics
        .map(({ key, width }) => {
          const cell = row.cells[key];
          return (
            "  " + theme.fg(cell.color, pad(cell.text || (cell.blank ? "" : "—"), width, true))
          );
        })
        .join("") +
      (columns.task
        ? "  " + taskText(row, theme, tint, columns.task, columns.taskStyle, state)
        : "")
    );
  }

  const separator = theme.fg("dim", " · ");
  const wantedName = Math.min(8, visibleWidth(name));
  const minimumName = Math.min(3, wantedName);
  const iconRoom = visibleWidth(icon) + 1;
  const clockCell = row.cells.turnClock;
  let clockText = clockCell.text ? separator + theme.fg(clockCell.color, clockCell.text) : "";
  const hasFacts = attentionText(run, state, plainTheme, 2, 0) !== "";
  const taskGap = hasFacts ? "  " : theme.fg("dim", " → ");
  const gapRoom = visibleWidth(taskGap);
  let limit = run.limit_reached ? SHORT_LIMIT_SUFFIX : "";
  const suffixWidth = (style: 0 | 1 | 2, detail = 0, marker = limit): number =>
    visibleWidth(taskSuffix(row, plainTheme, style, detail, marker, state));
  let minimumSuffix = suffixWidth(2);
  let tagText = tag ? ` ${theme.fg("dim", `(${tag})`)}` : "";
  const requiredGap = (): number => (minimumSuffix ? gapRoom : 0);
  // A clock is useful telemetry, never a reason to cut a count or the name.
  // Shorten facts before a nickname/tag, and drop the clock before either.
  if (
    width - iconRoom - visibleWidth(tagText + clockText) - wantedName - requiredGap() <
    minimumSuffix
  )
    clockText = "";
  const clockRoom = visibleWidth(clockText);
  if (
    width - iconRoom - visibleWidth(tagText) - minimumName - clockRoom - requiredGap() <
    minimumSuffix
  )
    tagText = "";
  if (width - iconRoom - minimumName - clockRoom - requiredGap() < minimumSuffix) {
    limit = "";
    minimumSuffix = suffixWidth(2);
  }
  if (
    width < iconRoom + minimumName ||
    width - iconRoom - minimumName - clockRoom - requiredGap() < minimumSuffix
  ) {
    // Impossible budgets keep only an identity, not a clipped numeric fact or
    // half a parenthetical. The unchanged outer row clip handles tree chrome.
    const label = clipPlainText(name, Math.max(0, Math.min(32, width - iconRoom)));
    return label
      ? `${icon} ${running ? theme.bold(label) : theme.fg("muted", label)}`
      : truncateToWidth(icon, width, "");
  }
  const factsRoom = width - iconRoom - visibleWidth(tagText) - wantedName - clockRoom - gapRoom;
  const taskStyle = ([0, 1, 2] as const).find((style) => suffixWidth(style) <= factsRoom) ?? 2;
  const preferred = planTask(row, factsRoom, taskStyle, state, false);
  const detailRoom = preferred?.detailRoom ?? 0;
  const marker = preferred?.limit ?? limit;
  const suffixRoom = suffixWidth(taskStyle, detailRoom, marker);
  // Optional title space is computed only AFTER the wanted name, never from
  // the smaller emergency nickname floor. No readable prefix means no title.
  const titleReserve = preferred?.title ? readableMinimum(description) : 0;
  const taskReserve =
    (suffixRoom || titleReserve ? gapRoom : 0) +
    suffixRoom +
    titleReserve +
    (suffixRoom && titleReserve ? 1 : 0);
  const availableName = width - iconRoom - visibleWidth(tagText) - clockRoom - taskReserve;
  const shortName = clipPlainText(name, Math.max(minimumName, Math.min(32, availableName)));
  const head = `${icon} ${running ? theme.bold(shortName) : theme.fg("muted", shortName)}${tagText}${clockText}`;
  let cells = METRICS.filter((key) => key !== "turnClock")
    .map((key) => ({ key, ...row.cells[key] }))
    .filter((cell) => cell.text);
  const renderMetrics = (): string =>
    cells.length
      ? separator + cells.map((cell) => theme.fg(cell.color, cell.text)).join(separator)
      : "";
  const minimumTitle = width >= 48 ? Math.min(12, visibleWidth(description)) : titleReserve;
  const taskMinimum = suffixRoom + minimumTitle + (suffixRoom && minimumTitle ? 1 : 0);
  const elevated = (key: Metric): boolean =>
    (key === "context" && (row.context ?? 0) >= 70) ||
    (key === "turns" && run.max_turns > 0 && run.turns / run.max_turns >= 0.8);
  const optionalOrder: Metric[] = ["context", "turns", "elapsed", "cost"];
  for (const key of [
    ...optionalOrder.filter((key) => !elevated(key)),
    ...optionalOrder.filter(elevated),
  ]) {
    if (width - visibleWidth(head + renderMetrics()) - gapRoom >= taskMinimum) break;
    cells = cells.filter((cell) => cell.key !== key);
  }
  const metrics = renderMetrics();
  const allocation = model ? ` ${theme.fg("dim", `[${model}]`)}` : "";
  const wantedTitle = Math.min(24, visibleWidth(description));
  const wantedTask = Math.max(24, suffixRoom + wantedTitle + (suffixRoom && wantedTitle ? 1 : 0));
  const allocationText =
    width - visibleWidth(head + allocation + metrics) - gapRoom >= wantedTask ? allocation : "";
  const room = width - visibleWidth(head + allocationText + metrics) - gapRoom;
  const body = taskText(row, theme, tint, room, taskStyle, state);
  return head + allocationText + metrics + (body ? taskGap + body : "");
}
