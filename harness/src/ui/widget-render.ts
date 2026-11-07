import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminal, type RunView } from "../core/contracts.ts";
import { profileLabel } from "../tools/tool-names.ts";
import {
  renderActivity,
  formatContextPercent,
  formatCost,
  formatMs,
  formatTurns,
  GLYPHS,
  withoutBreaks,
  type Theme,
} from "./format.ts";
import { clipPlainText, singleLineText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";
import type { WidgetOwner, WidgetRun } from "./agent-widget.ts";

const BRANCH = "├─",
  LAST = "└─",
  TRUNK = "│  ";
const WIDGET_TITLE = "Subagents";

const active = (run: WidgetRun): boolean => !terminal(run.status);
/** The Agent's nickname when the model gave one, else its profile — never both. */
const label = (run: WidgetRun): { name: string; tag: string } => {
  const difficulty =
    Number.isInteger(run.difficulty) && run.difficulty >= 1 && run.difficulty <= 5
      ? `d${run.difficulty}`
      : "";
  const profile = singleLineText(profileLabel(singleLineText(run.profile)));
  const name = singleLineText(run.name);
  const tag = name ? (difficulty ? `${profile}/${difficulty}` : profile) : difficulty;
  return { name: name || profile, tag };
};
const ROW_ELLIPSIS = "…";

const stats = (run: WidgetRun, running: boolean): string[] => {
  // Dual timing. Time on the current turn sits beside the turn counter it belongs
  // to; total time since submission stays last, where upstream puts its duration.
  const turn =
    running && run.turn_elapsed_ms !== undefined ? ` (${formatMs(run.turn_elapsed_ms)})` : "";
  const parts = [formatTurns(run.turns, run.max_turns) + turn];
  if (run.tool_uses > 0) parts.push(`${GLYPHS.toolCall}${run.tool_uses}`);
  if (run.runtime?.context) parts.push(`ctx ${formatContextPercent(run.runtime.context)}`);
  // `undefined` is the only "nobody priced this": a Run that genuinely billed
  // zero says so, or the row would re-collapse the distinction `reported()` and
  // the ledger exist to keep.
  if (run.cost !== undefined) parts.push(`${run.cost_partial ? "≥" : ""}${formatCost(run.cost)}`);
  parts.push(formatMs(run.elapsed_ms));
  return parts;
};
/** Highest-severity notes first, before ordinary metadata and statistics. */
const notes = (run: WidgetRun, theme: Theme, compact: 0 | 1 | 2): string[] => {
  const out: string[] = [];
  if (run.has_run_warnings)
    out.push(theme.fg("error", compact === 0 ? "run warning" : compact === 1 ? "warn" : "!"));
  if (run.pending_messages > 0)
    out.push(
      theme.fg(
        "warning",
        compact === 2 ? `${run.pending_messages}pend` : `${run.pending_messages} pending`,
      ),
    );
  return out;
};
interface HeaderState {
  text: string;
  color: string;
  detail?: string;
  compact?: string;
}

/** Identity and attention precede optional model/task/metrics. Compact warning
 * labels and failed explanations before sacrificing a recognizable name or a
 * complete profile/difficulty tag. At impossible widths keep a name prefix and
 * severity/attention first, omit the whole tag, then let the final clip bound it. */
function renderHeader(
  run: WidgetRun,
  icon: string,
  state: HeaderState | undefined,
  running: boolean,
  theme: Theme,
  width: number,
): string {
  const { name, tag } = label(run);
  const separator = theme.fg("dim", " · ");
  const attentionText = (compact: 0 | 1 | 2, detailRoom = 60): string => {
    const joiner = compact === 0 ? separator : theme.fg("dim", " ");
    const detail =
      compact === 0 && state?.detail && detailRoom > 1
        ? `: ${truncateToWidth(singleLineText(state.detail), detailRoom, "…")}`
        : "";
    const text = state ? (compact === 2 ? (state.compact ?? state.text) : state.text) + detail : "";
    const signals = [
      ...notes(run, theme, compact),
      ...(state ? [theme.fg(state.color, text)] : []),
    ];
    return signals.length ? joiner + signals.join(joiner) : "";
  };
  const nameText = name;
  const wantedName = Math.min(8, visibleWidth(nameText));
  const minimumName = Math.min(3, wantedName);
  const iconRoom = visibleWidth(icon) + 1;
  const clipRoom = visibleWidth(ROW_ELLIPSIS);
  let tagText = tag ? ` ${theme.fg("dim", `(${tag})`)}` : "";
  const attentionRoom = width - iconRoom - visibleWidth(tagText) - wantedName - clipRoom;
  let attention = attentionText(0);
  if (visibleWidth(attention) > attentionRoom && state?.detail) {
    // Strip/truncate only the explanation, never the failed state or earlier
    // warning/pending facts. Full-width wording remains byte-for-byte unchanged.
    const detailRoom = Math.floor(attentionRoom - visibleWidth(attentionText(0, 0)) - 2);
    attention = attentionText(0, detailRoom);
  }
  if (visibleWidth(attention) > attentionRoom) attention = attentionText(1);
  if (visibleWidth(attention) > attentionRoom) attention = attentionText(2);
  let availableName = width - iconRoom - visibleWidth(attention + tagText) - clipRoom;
  if (availableName < minimumName) {
    tagText = ""; // Never retain a misleading clipped profile/difficulty tag.
    availableName = width - iconRoom - visibleWidth(attention) - clipRoom;
  }
  const tinyPrefix = Math.min(minimumName, Math.max(1, width - iconRoom - clipRoom));
  const nameRoom = Math.max(tinyPrefix, Math.min(32, availableName));
  const shortName = truncateToWidth(nameText, nameRoom, "…");
  const identity = `${icon} ${running ? theme.bold(shortName) : theme.fg("dim", shortName)}${attention}`;
  const allocation = [run.model, run.effort]
    .filter(Boolean)
    .map(singleLineText)
    .filter(Boolean)
    .join("/");
  const allocationText = allocation ? ` ${theme.fg("dim", `[${allocation}]`)}` : "";
  const metrics = separator + theme.fg("dim", stats(run, running).join(" · "));
  const taskLead = theme.fg("dim", " → ");
  const room =
    width - visibleWidth(withoutBreaks(identity + tagText + allocationText + metrics + taskLead));
  const description = singleLineText(run.description);
  const task =
    room >= 4 && description
      ? taskLead + theme.fg(running ? "muted" : "dim", truncateToWidth(description, room, "…"))
      : "";
  return identity + tagText + allocationText + task + metrics;
}

export function renderFinishedLine(run: WidgetRun, theme: Theme, width = Infinity): string {
  const presentation = runPresentation(run.status);
  const icon = theme.fg(
    run.status === "completed" && run.limit_reached ? "warning" : presentation.color,
    presentation.glyph,
  );
  let state: HeaderState | undefined;
  if (run.status === "completed") {
    state = run.limit_reached
      ? { text: "(turn limit)", compact: "limit", color: "warning" }
      : undefined;
  } else if (run.status === "needs_input") {
    state = {
      text: run.question ? "needs answer" : "needs input",
      compact: run.question ? "answer?" : "input?",
      color: "warning",
    };
  } else if (run.status === "cancelled") {
    state = { text: presentation.label, color: presentation.color };
  } else {
    state = {
      text: presentation.label,
      detail: run.error ?? run.reason,
      color: presentation.color,
    };
  }
  return renderHeader(run, icon, state, false, theme, width);
}

export function renderRunningLines(
  run: WidgetRun,
  spinnerFrame: number,
  theme: Theme,
  width = Infinity,
): [header: string, activity: string] {
  const presentation = runPresentation(run.status, spinnerFrame, run.finishing);
  // "finishing" and "cancelling" are distinct facts: the first is our own
  // finalization, the second is a request whose exit is not yet observed.
  const state: HeaderState | undefined =
    run.status === "cancelling"
      ? { text: "cancelling", color: "warning" }
      : run.finishing
        ? { text: "finishing", color: "dim" }
        : undefined;
  const header = renderHeader(
    run,
    theme.fg(presentation.color, presentation.glyph),
    state,
    true,
    theme,
    width,
  );
  const { system, showGeneration } = activityPresentation(run);
  const prefix = `  ${GLYPHS.subLine}  `;
  const columns = Math.max(0, width - visibleWidth(prefix));
  const activity =
    run.active_tools.length || showGeneration
      ? renderActivity(run.active_tools, run, theme, columns)
      : theme.fg("dim", clipPlainText(singleLineText(system ?? "thinking…"), columns));
  return [header, theme.fg("dim", prefix) + activity];
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
/** Missing or non-finite height stays the legacy six-line default. */
export const lineBudget = (rows?: number): number =>
  Number.isFinite(rows)
    ? Math.max(0, Math.min(MAX_WIDGET_LINES, Math.floor(rows! / 3), rows! - INPUT_CHROME_RESERVE))
    : 6;

/** Queued Agents have identities too; the compact count is only a summary. */
function renderQueuedLine(run: WidgetRun, theme: Theme, width: number): string {
  const presentation = runPresentation(run.status);
  return renderHeader(
    run,
    theme.fg(presentation.color, presentation.glyph),
    { text: presentation.label, color: presentation.color },
    false,
    theme,
    width,
  );
}

/** One rendered row plus the Agent it belongs to; `agent` is what turns a click
 * at row N into "open that Agent". Chrome carries none: the heading has its own
 * expansion action, while aggregate queued/overflow/owner rows are inert. */
interface Row {
  line: string;
  agent?: string;
  kind?: "branch" | "activity";
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
  const queued = runs.filter((run) => run.status === "queued");
  const running = runs.filter((run) => active(run) && run.status !== "queued");
  const finished = runs.filter(
    (run) => terminal(run.status) && (expanded || shouldShowFinished(run.agent_id, run.status)),
  );
  const hasActive = running.length > 0 || queued.length > 0;
  // A full roster is itself the news: the next delegation will be refused, and
  // the heading carrying "(full)" is the only place that is visible.
  const saturated = owner.resident_limit > 0 && owner.resident >= owner.resident_limit;
  if (
    !hasActive &&
    !finished.length &&
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
  for (const run of runs.filter((run) => run.resident)) {
    const status = active(run) && run.status !== "queued" ? "running" : run.status;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const states = ["needs_input", "running", "queued", "completed", "failed", "cancelled"] as const;
  const summary = states
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => {
      const count = counts.get(status) ?? 0;
      // The rollup should be calm and readable; motion belongs to Agent rows.
      if (status === "running") return theme.fg("dim", `${GLYPHS.running}${count}`);
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
  const rosterCost = runs.reduce(
    (sum, run) => sum + (active(run) && run.status !== "queued" ? 2 : 1),
    0,
  );
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

  const rowWidth = Math.max(0, width - visibleWidth(BRANCH) - 1);
  const finishedRows: Row[] = finished.map((run) => ({
    line: clip(`${theme.fg("dim", BRANCH)} ${renderFinishedLine(run, theme, rowWidth)}`),
    agent: run.agent_id,
    kind: "branch",
  }));
  const runningRows: [Row, Row][] = running.map((run) => {
    const [header, activity] = renderRunningLines(run, spinnerFrame, theme, rowWidth);
    // The activity line answers for the same Agent as its header, so clicking
    // "⎿ reading src/core/controller.ts" opens the Agent doing the reading.
    return [
      { line: clip(`${theme.fg("dim", BRANCH)} ${header}`), agent: run.agent_id, kind: "branch" },
      { line: clip(theme.fg("dim", TRUNK) + activity), agent: run.agent_id, kind: "activity" },
    ];
  });
  const queuedPresentation = runPresentation("queued", spinnerFrame);
  const queuedRow: Row | undefined = queued.length
    ? {
        line: clip(
          `${theme.fg("dim", BRANCH)} ${theme.fg(queuedPresentation.color, queuedPresentation.glyph)} ` +
            `${theme.fg("dim", `${queued.length} queued`)}`,
        ),
        kind: "branch",
      }
    : undefined;
  const rows: Row[] = [{ line: heading }];
  if (owner.blocked && maxLines > 1)
    rows.push({
      line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("error", GLYPHS.failure)} ${warning}`),
      kind: "branch",
    });
  let pagination: WidgetFrame["pagination"];
  if (expanded && inspectable) {
    const budget = bodyBudget - (needsPages ? 1 : 0);
    // Whole Agents, not line offsets: a tiny page still shows a clickable name.
    // Keep the activity subline whenever the viewport can afford a pair.
    const groups: Row[][] = [
      ...finishedRows.map((row) => [row]),
      ...runningRows.map((pair) => (budget >= 2 ? pair : [pair[0]])),
      ...queued.map((run): Row[] => [
        {
          line: clip(`${theme.fg("dim", BRANCH)} ${renderQueuedLine(run, theme, rowWidth)}`),
          agent: run.agent_id,
          kind: "branch",
        },
      ]),
    ];
    const pages: Row[][] = [[]];
    for (const group of groups) {
      if (pages[pages.length - 1]!.length + group.length > budget) pages.push([]);
      pages[pages.length - 1]!.push(...group);
    }
    const page = Math.max(0, Math.min(pages.length - 1, Math.floor(params.page ?? 0) || 0));
    rows.push(...pages[page]!);
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
    const body = finishedRows.length + runningRows.length * 2 + (queuedRow ? 1 : 0);
    if (body <= bodyBudget)
      rows.push(...finishedRows, ...runningRows.flat(), ...(queuedRow ? [queuedRow] : []));
    else
      rows.push(
        ...overflow(runningRows, [queuedRow, queued.length], finishedRows, bodyBudget, clip, theme),
      );
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

function overflow(
  running: [Row, Row][],
  queued: [row: Row | undefined, count: number],
  finished: Row[],
  maxBody: number,
  clip: (line: string) => string,
  theme: Theme,
): Row[] {
  const rows: Row[] = [];
  if (maxBody <= 0) return rows;
  // Priority inverts the calm order: still-running work matters most when space runs out.
  let budget = maxBody - 1,
    hiddenRunning = 0,
    hiddenFinished = 0,
    hiddenQueued = queued[1];
  for (const pair of running) {
    if (budget >= 2) {
      rows.push(...pair);
      budget -= 2;
    } else if (budget === 1 && maxBody <= 2) {
      rows.push(pair[0]);
      budget--;
    } else hiddenRunning++;
  }
  if (queued[0] && budget >= 1) {
    rows.push(queued[0]);
    budget--;
    hiddenQueued = 0;
  }
  for (const row of finished) {
    if (budget >= 1) {
      rows.push(row);
      budget--;
    } else hiddenFinished++;
  }
  // The queued row is itself a count, so dropping it silently would lose the fact.
  const hidden = [
    hiddenRunning ? `${hiddenRunning} running` : "",
    hiddenQueued ? `${hiddenQueued} queued` : "",
    hiddenFinished ? `${hiddenFinished} finished` : "",
  ].filter(Boolean);
  const total = hiddenRunning + hiddenQueued + hiddenFinished;
  rows.push({
    line: clip(
      `${theme.fg("dim", BRANCH)} ${theme.fg("dim", `+${total} more (${hidden.join(", ")})`)}`,
    ),
    kind: "branch",
  });
  return rows;
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
