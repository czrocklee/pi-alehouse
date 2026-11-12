import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { profileLabel } from "../tools/tool-names.ts";
import { contextPercent, formatMs, GLYPHS, type Theme } from "./format.ts";
import { singleLineText } from "./text.ts";
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
      return run.finishing ? { text: "finishing", color: "dim" } : undefined;
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
      return { text: presentation.label, color: presentation.color };
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
  attention: number;
  attentionStyle: 0 | 1 | 2;
  attentionDetailRoom: number;
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

/** Highest-severity facts precede optional task/configuration/telemetry. */
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
    const detail =
      compact === 0 && state.detail && detailRoom > 1
        ? `: ${truncateToWidth(singleLineText(state.detail), detailRoom, "…")}`
        : "";
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
const taskWidth = (row: WidgetRow): number =>
  visibleWidth(row.description) +
  (row.run.limit_reached ? visibleWidth(LIMIT_SUFFIX) + (row.description ? 1 : 0) : 0);

/** Reserve the observation before clipping the title, and tint only the suffix.
 * Empty labels still carry the fact; tiny viewports retain the existing clipping
 * fallback rather than inventing an unrecognizable partial marker. */
function taskText(row: WidgetRow, theme: Theme, tint: string, width: number): string {
  if (!row.run.limit_reached) return theme.fg(tint, truncateToWidth(row.description, width, "…"));
  const titleMinimum = row.description ? Math.min(4, visibleWidth(row.description)) + 1 : 0;
  const suffix =
    width >= visibleWidth(LIMIT_SUFFIX) + titleMinimum ? LIMIT_SUFFIX : SHORT_LIMIT_SUFFIX;
  const room = width - visibleWidth(suffix) - (row.description ? 1 : 0);
  const title = room > 0 ? truncateToWidth(row.description, room, "…") : "";
  return (title ? theme.fg(tint, title) + " " : "") + theme.fg("warning", suffix);
}
// truncateToWidth's padding covers left-aligned cells; right-aligned numeric
// cells still need leading spaces, measured in terminal cells rather than UTF16.
const pad = (text: string, width: number, right = false): string =>
  right
    ? " ".repeat(Math.max(0, width - visibleWidth(text))) + text
    : truncateToWidth(text, width, "…", true);

/** The caller supplies painted compact headers or the complete expanded roster.
 * One geometry spans those rows; attention and a fallback turn clock never
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
  // Fixed columns hug their contents. The trailing label uses only its natural
  // width, or the available room for a longer label; it never pads later cells.
  const naturalTask = Math.max(...rows.map(taskWidth));
  const minimumTask = Math.max(
    ...rows.map(
      (row) =>
        Math.min(12, visibleWidth(row.description)) +
        (row.run.limit_reached ? visibleWidth(LIMIT_SUFFIX) + (row.description ? 1 : 0) : 0),
    ),
  );
  const wantedTask = Math.max(Math.min(24, naturalTask), minimumTask);
  const attentionWidths = ([0, 1, 2] as const).map((style) =>
    Math.max(
      ...rows.map((row) => visibleWidth(attentionText(row.run, row.state, plainTheme, style, 0))),
    ),
  );
  // Prefer the bounded failure explanation before optional model/telemetry;
  // wrappers can carry the identifying cause after a long error-code prefix.
  const preferredAttention = Math.max(
    ...rows.map((row) => visibleWidth(attentionText(row.run, row.state, plainTheme, 0))),
  );
  const contentRoom = (attention = preferredAttention) =>
    width -
    2 -
    name -
    (tag ? tag + 2 : 0) -
    (model ? model + 2 : 0) -
    metrics.reduce((sum, column) => sum + column.width + 2, 0) -
    (attention ? attention + 2 : 0) -
    (naturalTask ? 2 : 0);
  if (contentRoom() < wantedTask) model = 0;
  for (const key of ["context", "elapsed", "cost", "turns"] as const)
    if (contentRoom() < wantedTask) metrics = metrics.filter((column) => column.key !== key);
  const attentionStyle = ([0, 1, 2] as const).find(
    (style) => contentRoom(attentionWidths[style]) >= minimumTask,
  );
  if (attentionStyle === undefined) return undefined;
  // Complete attention facts and a recognizable trailing task survive even
  // when the preferred explanation cannot fit. Quiet rows share the same anchor.
  const attentionDetailRoom =
    attentionStyle === 0
      ? Math.min(60, Math.max(0, contentRoom(attentionWidths[0]) - minimumTask - 2))
      : 0;
  const attention = Math.max(
    ...rows.map((row) =>
      visibleWidth(
        attentionText(row.run, row.state, plainTheme, attentionStyle, attentionDetailRoom),
      ),
    ),
  );
  const task = Math.min(naturalTask, contentRoom(attention));
  return { name, tag, model, task, attention, attentionStyle, attentionDetailRoom, metrics };
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
  const { name, tag, model, description } = row;
  const tint = running ? "text" : "muted";
  if (columns) {
    const attention = attentionText(
      run,
      state,
      theme,
      columns.attentionStyle,
      columns.attentionDetailRoom,
    );
    if (visibleWidth(attention) <= columns.attention) {
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
        (columns.attention ? "  " + pad(attention, columns.attention) : "") +
        (columns.task ? "  " + taskText(row, theme, tint, columns.task) : "")
      );
    }
  }

  const separator = theme.fg("dim", " · ");
  const wantedName = Math.min(8, visibleWidth(name));
  const minimumName = Math.min(3, wantedName);
  const iconRoom = visibleWidth(icon) + 1;
  const clockCell = row.cells.turnClock;
  const clockText = clockCell.text ? separator + theme.fg(clockCell.color, clockCell.text) : "";
  const clockRoom = visibleWidth(clockText);
  // The short marker is mandatory at usable narrow widths. Optional tags and
  // ordinary numbers yield before it; attention keeps its independent priority.
  const limitTaskMinimum =
    visibleWidth(SHORT_LIMIT_SUFFIX) +
    (description ? Math.min(4, visibleWidth(description)) + 1 : 0);
  const limitRoom = run.limit_reached ? limitTaskMinimum + 3 : 0;
  let tagText = tag ? ` ${theme.fg("dim", `(${tag})`)}` : "";
  if (
    run.limit_reached &&
    width -
      iconRoom -
      visibleWidth(tagText) -
      minimumName -
      clockRoom -
      visibleWidth(attentionText(run, state, plainTheme, 2, 0)) -
      1 <
      limitRoom
  )
    tagText = "";
  const attentionRoom =
    width - iconRoom - visibleWidth(tagText) - wantedName - clockRoom - 1 - limitRoom;
  const signal = (compact: 0 | 1 | 2, room = 60): string => {
    const text = attentionText(run, state, theme, compact, room);
    return text ? (compact === 0 ? separator : " ") + text : "";
  };
  let attention = signal(0);
  if (visibleWidth(attention) > attentionRoom && state?.detail)
    attention = signal(0, Math.floor(attentionRoom - visibleWidth(signal(0, 0)) - 2));
  if (visibleWidth(attention) > attentionRoom) attention = signal(1);
  if (visibleWidth(attention) > attentionRoom) attention = signal(2);
  const safetyRoom = run.limit_reached ? 0 : 1;
  let availableName =
    width - iconRoom - visibleWidth(attention + tagText) - clockRoom - safetyRoom - limitRoom;
  if (availableName < minimumName) {
    tagText = "";
    availableName = width - iconRoom - visibleWidth(attention) - clockRoom - safetyRoom - limitRoom;
  }
  const tinyPrefix = Math.min(minimumName, Math.max(1, width - iconRoom - 1));
  const shortName = truncateToWidth(name, Math.max(tinyPrefix, Math.min(32, availableName)), "…");
  const head = `${icon} ${running ? theme.bold(shortName) : theme.fg("muted", shortName)}${attention}${tagText}${clockText}`;
  let cells = METRICS.filter((key) => key !== "turnClock")
    .map((key) => ({ key, ...row.cells[key] }))
    .filter((cell) => cell.text);
  const renderMetrics = (): string =>
    cells.length
      ? separator + cells.map((cell) => theme.fg(cell.color, cell.text)).join(separator)
      : "";
  const taskMinimum = run.limit_reached
    ? limitTaskMinimum
    : width >= 48 && description
      ? Math.min(12, visibleWidth(description))
      : 0;
  const elevated = (key: Metric): boolean =>
    (key === "context" && (row.context ?? 0) >= 70) ||
    (key === "turns" && run.max_turns > 0 && run.turns / run.max_turns >= 0.8);
  const optionalOrder: Metric[] = ["context", "turns", "elapsed", "cost"];
  for (const key of [
    ...optionalOrder.filter((key) => !elevated(key)),
    ...optionalOrder.filter(elevated),
  ]) {
    if (width - visibleWidth(head + renderMetrics()) - 3 >= taskMinimum) break;
    cells = cells.filter((cell) => cell.key !== key);
  }
  const metrics = renderMetrics();
  const allocation = model ? ` ${theme.fg("dim", `[${model}]`)}` : "";
  const allocationText =
    width - visibleWidth(head + allocation + metrics) >= Math.max(24, taskMinimum + 3)
      ? allocation
      : "";
  const room = width - visibleWidth(head + allocationText + metrics) - 3;
  const task =
    room >= (run.limit_reached ? visibleWidth(SHORT_LIMIT_SUFFIX) : 4) &&
    (description || run.limit_reached)
      ? theme.fg("dim", " → ") + taskText(row, theme, tint, room)
      : "";
  return head + allocationText + metrics + task;
}
