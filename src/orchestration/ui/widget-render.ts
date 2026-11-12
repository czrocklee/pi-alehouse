import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminal, type RunView } from "../core/contracts.ts";
import { renderActivity, GLYPHS, withoutBreaks, type Theme } from "./format.ts";
import { clipPlainText, singleLineText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";
import {
  renderHeader,
  widgetColumns,
  prepareWidgetRow,
  turnClock,
  type WidgetColumns,
  type WidgetRow,
} from "./widget-row.ts";
import type { WidgetOwner, WidgetRun } from "./agent-widget.ts";

const BRANCH = "├─",
  LAST = "└─",
  TRUNK = "│  ";
const WIDGET_TITLE = "Subagents";

const active = (run: WidgetRun): boolean => !terminal(run.status);
const ROW_ELLIPSIS = "…";
const attention = (run: WidgetRun): boolean =>
  run.has_run_warnings || run.pending_messages > 0 || run.limit_reached;
const live = (run: WidgetRun): boolean => active(run) && run.status !== "queued";
// One order and vocabulary for grouping, allocation and truthful overflow counts.
const ROW_STATES = [
  { state: "needs input", short: "input", signal: "?" },
  { state: "running", short: "run" },
  { state: "attention", short: "attn", signal: "!" },
  { state: "queued", short: "queue" },
  { state: "failed", short: "fail", signal: "✗" },
  { state: "finished", short: "fin" },
] as const;
type RowState = (typeof ROW_STATES)[number]["state"];
function stateOf(run: WidgetRun): RowState {
  if (run.status === "needs_input") return "needs input";
  if (live(run)) return "running";
  // A limit/warning flag must not relabel a real failure as generic attention.
  if (run.status === "failed") return "failed";
  if (attention(run)) return "attention";
  return run.status === "queued" ? "queued" : "finished";
}
const priority = (state: RowState): number =>
  ROW_STATES.findIndex((entry) => entry.state === state);

export function renderFinishedLine(
  run: WidgetRun,
  theme: Theme,
  width = Infinity,
  columns?: WidgetColumns | null,
  row: WidgetRow = prepareWidgetRow(run),
): string {
  columns = columns === undefined ? (widgetColumns([row], width) ?? null) : columns;
  const presentation = runPresentation(run.status);
  const icon = theme.fg(
    run.status === "completed" && run.limit_reached ? "warning" : presentation.color,
    presentation.glyph,
  );
  return renderHeader(run, icon, row.state, false, theme, width, columns, row);
}

export function renderRunningLines(
  run: WidgetRun,
  spinnerFrame: number,
  theme: Theme,
  width = Infinity,
  columns?: WidgetColumns | null,
  row: WidgetRow = prepareWidgetRow(run),
): [header: string, activity: string] {
  columns = columns === undefined ? (widgetColumns([row], width) ?? null) : columns;
  const header = renderRunningHeader(run, spinnerFrame, theme, width, columns, row);
  return [header, renderRunningActivity(run, theme, width, row.headerClock)];
}

function renderRunningHeader(
  run: WidgetRun,
  spinnerFrame: number,
  theme: Theme,
  width: number,
  columns: WidgetColumns | null,
  row: WidgetRow,
): string {
  const presentation = runPresentation(run.status, spinnerFrame, run.finishing);
  // "finishing" and "cancelling" are distinct facts: the first is our own
  // finalization, the second is a request whose exit is not yet observed.
  return renderHeader(
    run,
    theme.fg(presentation.color, presentation.glyph),
    row.state,
    true,
    theme,
    width,
    columns,
    row,
  );
}

function renderRunningActivity(
  run: WidgetRun,
  theme: Theme,
  width: number,
  headerClock: boolean,
): string {
  const { system, showGeneration } = activityPresentation(run);
  const prefix = theme.fg("dim", `  ${GLYPHS.subLine}  `);
  // This is the turn clock, not the duration of the displayed tool/thought.
  const clock = headerClock ? undefined : turnClock(run);
  const turn = clock ? theme.fg(clock.color, clock.text) + " " : "";
  const room = Math.max(0, width - visibleWidth(prefix + turn));
  const activity =
    run.active_tools.length || showGeneration
      ? renderActivity(run.active_tools, run, theme, room)
      : theme.fg("dim", clipPlainText(singleLineText(system ?? "thinking…"), room));
  return prefix + turn + activity;
}

// Heading + the default twelve-Agent roster, without a pagination row.
const MAX_WIDGET_LINES = 13;
/**
 * Conservative fullscreen baseline, not a measurement of this host: widget
 * spacer 1 + editor minimum 3 + footer 2 + status 1 + one queued prompt 3
 * (SDK spacer, message, and dequeue hint) + transcript 2. A taller editor,
 * more queued prompts, or other extension widgets can still shrink the dock;
 * this budget does not probe private SDK layout.
 */
const INPUT_CHROME_RESERVE = 12;
/** Missing or non-finite height uses a conservative six-line budget. */
export const lineBudget = (rows?: number): number =>
  Number.isFinite(rows)
    ? Math.max(0, Math.min(MAX_WIDGET_LINES, Math.floor(rows! / 3), rows! - INPUT_CHROME_RESERVE))
    : 6;

/** One rendered row plus the Agent it belongs to; `agent` is what turns a click
 * at row N into "open that Agent". Chrome carries none: the heading has its own
 * expansion action, while aggregate queued/overflow/owner rows are inert. */
interface Row {
  line: string;
  agent?: string;
  kind?: "branch" | "activity";
}
interface RowGroup {
  run?: WidgetRun;
  state: RowState;
  count: number;
  activity: boolean;
}
interface AllocatedGroup {
  group: RowGroup;
  activity: boolean;
}
/** Geometry belongs to one paint, not the Owner or the shared widget binding. */
export interface WidgetFrame {
  lines: string[];
  hits: (string | undefined)[];
  headingWidth?: number;
  pagination?: {
    page: number;
    pages: number;
    row: number;
    prev?: [number, number];
    next?: [number, number];
  };
}

/** Pure body rendering. Returns the rows to display, already clipped to width. */
export function renderWidget(params: {
  runs: readonly WidgetRun[];
  owner: WidgetOwner;
  spinnerFrame: number;
  width: number;
  theme: Theme;
  shouldShowFinished: (agent_id: string, status: RunView["status"]) => boolean;
  /** Explicit inspection pages through the complete projected roster. */
  expanded?: boolean;
  /** Total budget including heading, warning and controls; always capped at 13. */
  maxLines?: number;
  page?: number;
  /** Mouse inspection entry: regular/unknown modes need no ordinary idle heading. */
  disclosure?: boolean;
  /** Opt-in Easter egg; normal disclosure uses arrows. */
  beerMugs?: boolean;
}): WidgetFrame {
  const {
    runs,
    owner,
    spinnerFrame,
    width,
    theme,
    shouldShowFinished,
    expanded = false,
    disclosure = true,
    beerMugs = false,
  } = params;
  const maxLines = Number.isFinite(params.maxLines)
    ? Math.max(0, Math.min(MAX_WIDGET_LINES, Math.floor(params.maxLines!)))
    : 6;
  if (maxLines === 0) return { lines: [], hits: [] };
  const eligible = runs
    .filter(
      (run) =>
        active(run) ||
        expanded ||
        run.status === "needs_input" ||
        run.pending_messages > 0 ||
        shouldShowFinished(run.agent_id, run.status),
    )
    .map((run): RowGroup => ({ run, state: stateOf(run), count: 1, activity: live(run) }))
    .toSorted((a, b) => priority(a.state) - priority(b.state));
  const hasActive = runs.some(active);
  // A full roster is itself the news: the next delegation will be refused, and
  // the heading carrying "(full)" is the only place that is visible.
  const saturated = owner.resident_limit > 0 && owner.resident >= owner.resident_limit;
  if (
    !hasActive &&
    !eligible.length &&
    !owner.blocked &&
    !saturated &&
    (!disclosure || owner.resident === 0)
  )
    return { lines: [], hits: [] };

  const clip = (line: string) => truncateToWidth(withoutBreaks(line), width, ROW_ELLIPSIS);
  const color = owner.blocked ? "error" : hasActive ? "accent" : "dim";
  // Status counts describe the same resident population as capacity. Released
  // failure diagnostics still retain their body rows, inspection and clicks.
  const counts = new Map<WidgetRun["status"], number>();
  const residents = runs.filter((run) => run.resident);
  for (const run of residents) {
    const status = live(run) ? "running" : run.status;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const states = ["needs_input", "running", "queued", "completed", "failed", "cancelled"] as const;
  const summary = states
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => {
      const count = counts.get(status) ?? 0;
      // Keep summary glyphs static; animation belongs to individual Agent rows.
      if (status === "running") return theme.fg("accent", `${GLYPHS.running}${count}`);
      const presentation = runPresentation(status);
      return theme.fg(
        status === "completed" ? "dim" : presentation.color,
        `${presentation.glyph}${count}`,
      );
    })
    .join(" ");
  const capacity = saturated ? theme.fg("warning", " (full)") : "";
  // Reserve warning space before body allocation, never at the clipped bottom.
  const chrome = 1 + (owner.blocked && maxLines > 1 ? 1 : 0);
  const bodyBudget = maxLines - chrome;
  const rosterCost = runs.reduce((sum, run) => sum + (live(run) ? 2 : 1), 0);
  const needsPages = rosterCost > bodyBudget;
  const controlWidth = visibleWidth(`[Prev] ${runs.length}/${runs.length} [Next]`);
  const inspectable =
    runs.length > 0 &&
    bodyBudget >= (needsPages ? 2 : 1) &&
    width >= (needsPages ? controlWidth : 16);
  const disclosureGlyph = beerMugs ? (expanded ? "🍻" : "🍺") : expanded ? "▾" : "▸";
  const canDisclose =
    disclosure &&
    inspectable &&
    visibleWidth(`${disclosureGlyph} ${WIDGET_TITLE}${saturated ? " full" : ""}`) <= width;
  // Unavailable headings keep status dots by default. The opt-in Easter egg
  // keeps a single mug for branding, never an unavailable expanded marker.
  const glyph = canDisclose
    ? disclosureGlyph
    : beerMugs
      ? "🍺"
      : hasActive
        ? GLYPHS.agentsActive
        : GLYPHS.agentsIdle;
  const baseTitle = `${theme.fg(color, glyph)} ${theme.fg(color, WIDGET_TITLE)}`;
  const ownerError = owner.error ? singleLineText(owner.error).slice(0, 80) : "";
  const warning = theme.fg("error", `owner blocked${ownerError ? `: ${ownerError}` : ""}`);
  // The leading marker never moves. Keep capacity before optional counts;
  // drop counts first, then compact capacity if needed.
  const fallback = disclosure && runs.length && !canDisclose ? theme.fg("dim", " · Alt+A") : "";
  const prefix = baseTitle + capacity;
  const title = prefix + (summary ? theme.fg("dim", " · ") + summary : "") + fallback;
  const shortTitle = baseTitle + (saturated ? theme.fg("warning", " full") : "") + fallback;
  const headingTitle =
    visibleWidth(title) <= width
      ? title
      : visibleWidth(prefix + fallback) <= width
        ? prefix + fallback
        : shortTitle;
  const headingText = maxLines === 1 && owner.blocked ? warning : headingTitle;
  const heading = clip(headingText);
  const headingWidth =
    canDisclose && visibleWidth(headingText) <= width ? visibleWidth(heading) : 0;

  const ordinaryQueued = eligible.filter((group) => group.state === "queued");
  const groups = expanded
    ? eligible
    : eligible.flatMap((group): RowGroup[] =>
        group.state !== "queued"
          ? [group]
          : group === ordinaryQueued[0]
            ? [{ state: "queued", count: ordinaryQueued.length, activity: false }]
            : [],
      );
  // Allocate identities, previews and complete pages BEFORE preparing metrics.
  // A surviving header gets the turn clock only when its activity will be absent.
  let shown: AllocatedGroup[] = [];
  let hidden: RowGroup[] = [];
  let pages: AllocatedGroup[][] = [];
  let page = 0;
  if (expanded && inspectable) {
    const budget = bodyBudget - (needsPages ? 1 : 0);
    pages = [[]];
    let used = 0;
    for (const group of groups) {
      const activity = group.activity && budget >= 2;
      const cost = activity ? 2 : 1;
      if (used + cost > budget) {
        pages.push([]);
        used = 0;
      }
      pages[pages.length - 1]!.push({ group, activity });
      used += cost;
    }
    page = Math.max(0, Math.min(pages.length - 1, Math.floor(params.page ?? 0) || 0));
    shown = pages[page]!;
  } else if (!expanded) {
    ({ shown, hidden } = fitGroups(groups, bodyBudget));
  }
  const headerClocks = new Set(
    (expanded ? pages.flat() : shown)
      .filter(({ group, activity }) => group.activity && !activity)
      .map(({ group }) => group.run),
  );
  // Aggregated queue/overflow rows carry no individually painted metadata.
  // Expanded inspection deliberately shares geometry across its complete roster;
  // an expanded roster too small to inspect paints no Agent rows at all.
  const layoutRuns = (
    expanded ? (inspectable ? eligible : []) : shown.map(({ group }) => group)
  ).flatMap(({ run }) => (run ? [run] : []));
  const prepared = new Map<WidgetRun, WidgetRow>(
    layoutRuns.map((run) => [run, prepareWidgetRow(run, headerClocks.has(run))]),
  );
  const rowWidth = Math.max(0, width - visibleWidth(BRANCH) - 1);
  // Compact columns follow painted Agent headers; expanded columns span pages.
  const columns = prepared.size ? (widgetColumns([...prepared.values()], rowWidth) ?? null) : null;
  const paint = ({ group, activity }: AllocatedGroup): Row[] => {
    const run = group.run;
    if (!run) {
      const presentation = runPresentation("queued");
      return [
        {
          line: clip(
            `${theme.fg("dim", BRANCH)} ${theme.fg(presentation.color, presentation.glyph)} ${theme.fg("dim", `${group.count} queued`)}`,
          ),
          kind: "branch",
        },
      ];
    }
    const row = prepared.get(run)!;
    const header = group.activity
      ? renderRunningHeader(run, spinnerFrame, theme, rowWidth, columns, row)
      : renderFinishedLine(run, theme, rowWidth, columns, row);
    return [
      { line: clip(`${theme.fg("dim", BRANCH)} ${header}`), agent: run.agent_id, kind: "branch" },
      ...(activity
        ? [
            {
              line: clip(
                theme.fg("dim", TRUNK) +
                  renderRunningActivity(run, theme, rowWidth, row.headerClock),
              ),
              agent: run.agent_id,
              kind: "activity" as const,
            },
          ]
        : []),
    ];
  };
  const rows: Row[] = [{ line: heading }];
  if (owner.blocked && maxLines > 1)
    rows.push({
      line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("error", GLYPHS.failure)} ${warning}`),
      kind: "branch",
    });
  let pagination: WidgetFrame["pagination"];
  if (expanded && inspectable) {
    rows.push(...shown.flatMap(paint));
    if (needsPages) {
      const prefix = `[Prev] ${page + 1}/${pages.length} `;
      pagination = {
        page,
        pages: pages.length,
        row: rows.length,
        ...(page > 0 ? { prev: [0, 6] as [number, number] } : {}),
        ...(page + 1 < pages.length
          ? { next: [visibleWidth(prefix), visibleWidth(prefix) + 6] as [number, number] }
          : {}),
      };
      rows.push({ line: theme.fg("dim", `${prefix}[Next]`) });
    }
  } else if (expanded) {
    if (runs.length > 0 && bodyBudget > 0)
      rows.push({ line: clip(theme.fg("dim", "Alt+A to inspect")) });
  } else {
    rows.push(...shown.flatMap(paint));
    if (hidden.length) rows.push(renderOverflow(hidden, width, clip, theme));
  }
  const closed = closeLast(rows);
  return {
    lines: closed.map((row) => row.line),
    hits: closed.map((row) => row.agent),
    headingWidth,
    ...(pagination ? { pagination } : {}),
  };
}
/** Lines only, for callers that do not route clicks. */
export const renderWidgetLines = (params: Parameters<typeof renderWidget>[0]): string[] =>
  renderWidget(params).lines;

function fitGroups(
  groups: readonly RowGroup[],
  maxBody: number,
): { shown: AllocatedGroup[]; hidden: RowGroup[] } {
  if (maxBody <= 0) return { shown: [], hidden: [] };
  const overflow = groups.length > maxBody;
  const slots = Math.max(0, maxBody - (overflow ? 1 : 0));
  const selected = groups.slice(0, slots);
  // Even many unanswered questions must not hide every executing identity when
  // there is room for a header and an honest hidden-state summary.
  if (slots > 0 && !selected.some((group) => group.activity)) {
    const executing = groups.find((group) => group.activity);
    if (executing) selected[selected.length - 1] = executing;
  }
  const selectedSet = new Set(selected);
  const hidden = groups.filter((group) => !selectedSet.has(group));
  let activityRoom = maxBody - selected.length - (hidden.length ? 1 : 0);
  const shown = selected.map((group) => ({
    group,
    activity: group.activity && activityRoom-- > 0,
  }));
  return { shown, hidden };
}

function renderOverflow(
  groups: readonly RowGroup[],
  width: number,
  clip: (line: string) => string,
  theme: Theme,
): Row {
  const count = (state: RowState) =>
    groups.filter((group) => group.state === state).reduce((sum, group) => sum + group.count, 0);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const states = ROW_STATES.map((entry) => ({ ...entry, count: count(entry.state) }));
  const hidden = states.filter((entry) => entry.count > 0);
  const other = states
    .filter((entry) => !("signal" in entry))
    .reduce((sum, entry) => sum + entry.count, 0);
  const signals = hidden.flatMap((entry) =>
    "signal" in entry ? [`${entry.signal}${entry.count}`] : [],
  );
  const choices = [
    `+${total} more (${hidden.map(({ state, count }) => `${count} ${state}`).join(", ")})`,
    `+${total} more (${hidden.map(({ short, count }) => `${short}${count}`).join(" ")})`,
    `+${total} (${[...signals, ...(other ? [`other${other}`] : [])].join(" ")})`,
  ];
  const text = choices.find((text) => visibleWidth(`${BRANCH} ${text}`) <= width) ?? choices[2]!;
  return {
    line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("dim", text)}`),
    kind: "branch",
  };
}
/**
 * Close the tree: the final branch becomes └─, and a trailing activity line
 * loses its trunk to the header above it, which owns the corner instead.
 *
 * Which of the two applies is read off the rows, never predicted from what went
 * into them: on overflow the last row is the "+N more" count rather than the
 * activity line a running Agent would otherwise have ended on, and a prediction
 * closed the wrong row -- that is, closed nothing, and left ├─ dangling.
 */
function closeLast(rows: Row[]): Row[] {
  const last = rows.findLastIndex((row) => row.kind !== undefined);
  if (last < 1) return rows;
  const trailing = rows[last]!;
  if (trailing.kind === "activity" && rows[last - 1]?.kind === "branch") {
    rows[last - 1]!.line = rows[last - 1]!.line.replace(BRANCH, LAST);
    trailing.line = trailing.line.replace(TRUNK, "   ");
  } else trailing.line = trailing.line.replace(BRANCH, LAST);
  return rows;
}
