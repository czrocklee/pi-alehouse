import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminal, type RunView } from "../core/contracts.ts";
import { reported } from "../core/usage-ledger.ts";
import { profileLabel } from "../tools/tool-names.ts";
import type { ActivityHistoryState, ActivityObservationSource, ChildActivityObservation, ChildActivitySnapshot } from "../runtime/activity-observer.ts";
import type { ActiveTool, GenerationPreview } from "../runtime/activity-types.ts";
import { renderActivity, formatContextPercent, formatCost, formatMs, formatTurns, GLYPHS,
  withoutBreaks, type Theme } from "./format.ts";
import { clipPlainText, singleLineText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";

const BRANCH = "├─", LAST = "└─", TRUNK = "│  ";
const WIDGET_TITLE = "Subagents";

/** One rendered Agent row: the Agent's latest Run plus its ephemeral activity. */
export interface WidgetRun extends GenerationPreview {
  agent_id: string;
  run_id: string;
  resident: boolean;
  name: string;
  profile: string;
  model: string;
  /** Creation-time task assessment; distinct from the resolved model slot. */
  difficulty: number;
  /** Effective creation-time effort/thinking level. */
  effort: string;
  description: string;
  status: RunView["status"];
  /** Execution exited but the Run has not settled: shown as "finishing". */
  finishing: boolean;
  execution_exited?: boolean;
  turns: number;
  max_turns: number;
  elapsed_ms: number;
  turn_elapsed_ms?: number;
  /** Provider-reported spend in USD, or undefined when nothing was reported. */
  cost?: number;
  cost_partial?: boolean;
  runtime?: RunView["runtime"];
  drain?: RunView["drain"];
  tool_uses: number;
  active_tools: readonly ActiveTool[];
  question: boolean;
  limit_reached: boolean;
  error?: string;
  reason?: string;
  /** Accepted alerts still pending from this Run; not a delivery-loss count. */
  pending_messages: number;
  /** Recorded cleanup/input/output issues, not proof that resources remain held. */
  has_run_warnings: boolean;
}
export interface WidgetOwner { blocked: boolean; error?: string; resident: number; resident_limit: number }

const active = (run: WidgetRun): boolean => !terminal(run.status);
/** The Agent's nickname when the model gave one, else its profile — never both. */
const label = (run: WidgetRun): { name: string; tag: string } => {
  const difficulty = Number.isInteger(run.difficulty) && run.difficulty >= 1 && run.difficulty <= 5 ?
    `d${run.difficulty}` : "";
  const profile = singleLineText(profileLabel(singleLineText(run.profile)));
  const name = singleLineText(run.name);
  const tag = name ? (difficulty ? `${profile}/${difficulty}` : profile) : difficulty;
  return { name: name || profile, tag };
};
const ROW_ELLIPSIS = "…";

const stats = (run: WidgetRun, running: boolean): string[] => {
  // Dual timing. Time on the current turn sits beside the turn counter it belongs
  // to; total time since submission stays last, where upstream puts its duration.
  const turn = running && run.turn_elapsed_ms !== undefined ? ` (${formatMs(run.turn_elapsed_ms)})` : "";
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
  if (run.has_run_warnings) out.push(theme.fg("error", compact === 0 ? "run warning" : compact === 1 ? "warn" : "!"));
  if (run.pending_messages > 0) out.push(theme.fg("warning", compact === 2 ? `${run.pending_messages}pend` : `${run.pending_messages} pending`));
  return out;
};
interface HeaderState { text: string; color: string; detail?: string; compact?: string }

/** Identity and attention precede optional model/task/metrics. Compact warning
 * labels and failed explanations before sacrificing a recognizable name or a
 * complete profile/difficulty tag. At impossible widths keep a name prefix and
 * severity/attention first, omit the whole tag, then let the final clip bound it. */
function renderHeader(run: WidgetRun, icon: string, state: HeaderState | undefined, running: boolean, theme: Theme, width: number): string {
  const { name, tag } = label(run);
  const separator = theme.fg("dim", " · ");
  const attentionText = (compact: 0 | 1 | 2, detailRoom = 60): string => {
    const joiner = compact === 0 ? separator : theme.fg("dim", " ");
    const detail = compact === 0 && state?.detail && detailRoom > 1 ?
      `: ${truncateToWidth(singleLineText(state.detail), detailRoom, "…")}` : "";
    const text = state ? (compact === 2 ? state.compact ?? state.text : state.text) + detail : "";
    const signals = [...notes(run, theme, compact), ...(state ? [theme.fg(state.color, text)] : [])];
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
  const allocation = [run.model, run.effort].filter(Boolean).map(singleLineText).filter(Boolean).join("/");
  const allocationText = allocation ? ` ${theme.fg("dim", `[${allocation}]`)}` : "";
  const metrics = separator + theme.fg("dim", stats(run, running).join(" · "));
  const taskLead = theme.fg("dim", " → ");
  const room = width - visibleWidth(withoutBreaks(identity + tagText + allocationText + metrics + taskLead));
  const description = singleLineText(run.description);
  const task = room >= 4 && description ?
    taskLead + theme.fg(running ? "muted" : "dim", truncateToWidth(description, room, "…")) : "";
  return identity + tagText + allocationText + task + metrics;
}

export function renderFinishedLine(run: WidgetRun, theme: Theme, width = Infinity): string {
  const presentation = runPresentation(run.status);
  const icon = theme.fg(run.status === "completed" && run.limit_reached ? "warning" : presentation.color, presentation.glyph);
  let state: HeaderState | undefined;
  if (run.status === "completed") {
    state = run.limit_reached ? { text: "(turn limit)", compact: "limit", color: "warning" } : undefined;
  } else if (run.status === "needs_input") {
    state = { text: run.question ? "needs answer" : "needs input", compact: run.question ? "answer?" : "input?", color: "warning" };
  } else if (run.status === "cancelled") {
    state = { text: presentation.label, color: presentation.color };
  } else {
    state = { text: presentation.label, detail: run.error ?? run.reason, color: presentation.color };
  }
  return renderHeader(run, icon, state, false, theme, width);
}

export function renderRunningLines(run: WidgetRun, spinnerFrame: number, theme: Theme, width = Infinity): [header: string, activity: string] {
  const presentation = runPresentation(run.status, spinnerFrame, run.finishing);
  // "finishing" and "cancelling" are distinct facts: the first is our own
  // finalization, the second is a request whose exit is not yet observed.
  const state: HeaderState | undefined = run.status === "cancelling" ? { text: "cancelling", color: "warning" } :
    run.finishing ? { text: "finishing", color: "dim" } : undefined;
  const header = renderHeader(run, theme.fg(presentation.color, presentation.glyph), state, true, theme, width);
  const { system, showGeneration } = activityPresentation(run);
  const prefix = `  ${GLYPHS.subLine}  `;
  const columns = Math.max(0, width - visibleWidth(prefix));
  const activity = run.active_tools.length || showGeneration ? renderActivity(run.active_tools, run, theme, columns) :
    theme.fg("dim", clipPlainText(singleLineText(system ?? "thinking…"), columns));
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
const lineBudget = (rows?: number): number => Number.isFinite(rows) ?
  Math.max(0, Math.min(MAX_WIDGET_LINES, Math.floor(rows! / 3), rows! - INPUT_CHROME_RESERVE)) : 6;

/** Queued Agents have identities too; the compact count is only a summary. */
function renderQueuedLine(run: WidgetRun, theme: Theme, width: number): string {
  const presentation = runPresentation(run.status);
  return renderHeader(run, theme.fg(presentation.color, presentation.glyph),
    { text: presentation.label, color: presentation.color }, false, theme, width);
}

/** One rendered row plus the Agent it belongs to; `agent` is what turns a click
 * at row N into "open that Agent". Chrome carries none: the heading has its own
 * expansion action, while aggregate queued/overflow/owner rows are inert. */
interface Row { line: string; agent?: string; kind?: "branch" | "activity" }
/** Geometry belongs to one paint, not the Owner or the shared widget binding. */
export interface WidgetFrame {
  lines: string[];
  hits: (string | undefined)[];
  headingWidth?: number;
  pagination?: { page: number; pages: number; row: number; prev?: [number, number]; next?: [number, number] };
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
  const { runs, owner, spinnerFrame, width, theme, shouldShowFinished, expanded = false, disclosure = true, beerMugs = false } = params;
  const maxLines = Number.isFinite(params.maxLines) ?
    Math.max(0, Math.min(MAX_WIDGET_LINES, Math.floor(params.maxLines!))) : 6;
  if (maxLines === 0) return { lines: [], hits: [] };
  const queued = runs.filter((run) => run.status === "queued");
  const running = runs.filter((run) => active(run) && run.status !== "queued");
  const finished = runs.filter((run) => terminal(run.status) && (expanded || shouldShowFinished(run.agent_id, run.status)));
  const hasActive = running.length > 0 || queued.length > 0;
  // A full roster is itself the news: the next delegation will be refused, and
  // the heading carrying "(full)" is the only place that is visible.
  const saturated = owner.resident_limit > 0 && owner.resident >= owner.resident_limit;
  if (!hasActive && !finished.length && !owner.blocked && !saturated &&
      (!disclosure || owner.resident === 0)) return { lines: [], hits: [] };

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
  const summary = states.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => {
    const count = counts.get(status) ?? 0;
    // The rollup should be calm and readable; motion belongs to Agent rows.
    if (status === "running") return theme.fg("dim", `${GLYPHS.running}${count}`);
    const presentation = runPresentation(status);
    return theme.fg(status === "completed" ? "dim" : presentation.color, `${presentation.glyph}${count}`);
  }).join(" ");
  const capacity = saturated ? theme.fg("warning", " (full)") : "";
  // Reserve warning space before body allocation, never at the clipped bottom.
  const chrome = 1 + (owner.blocked && maxLines > 1 ? 1 : 0);
  const bodyBudget = maxLines - chrome;
  const rosterCost = runs.reduce((sum, run) => sum + (active(run) && run.status !== "queued" ? 2 : 1), 0);
  const needsPages = rosterCost > bodyBudget;
  const controlWidth = visibleWidth(`[Prev] ${runs.length}/${runs.length} [Next]`);
  const inspectable = runs.length > 0 && bodyBudget >= (needsPages ? 2 : 1) &&
    width >= (needsPages ? controlWidth : 16);
  const disclosureGlyph = beerMugs ? (expanded ? "🍻" : "🍺") : (expanded ? "▾" : "▸");
  const canDisclose = disclosure && inspectable &&
    visibleWidth(`${disclosureGlyph} ${WIDGET_TITLE}${saturated ? " full" : ""}`) <= width;
  // Unavailable headings keep status dots by default. The opt-in Easter egg
  // keeps a single mug for branding, never an unavailable expanded marker.
  const glyph = canDisclose ? disclosureGlyph : beerMugs ? "🍺" : hasActive ? GLYPHS.agentsActive : GLYPHS.agentsIdle;
  const baseTitle = `${theme.fg(color, glyph)} ${theme.fg(color, WIDGET_TITLE)}`;
  const ownerError = owner.error ? singleLineText(owner.error).slice(0, 80) : "";
  const warning = theme.fg("error", `owner blocked${ownerError ? `: ${ownerError}` : ""}`);
  // The leading marker never moves. Keep capacity before optional counts;
  // drop counts first, then compact capacity if needed.
  const fallback = disclosure && runs.length && !canDisclose ? theme.fg("dim", " · Alt+A") : "";
  const prefix = baseTitle + capacity;
  const title = prefix + (summary ? theme.fg("dim", " · ") + summary : "") + fallback;
  const shortTitle = baseTitle + (saturated ? theme.fg("warning", " full") : "") + fallback;
  const headingTitle = visibleWidth(title) <= width ? title :
    visibleWidth(prefix + fallback) <= width ? prefix + fallback : shortTitle;
  const headingText = maxLines === 1 && owner.blocked ? warning : headingTitle;
  const heading = clip(headingText);
  const headingWidth = canDisclose && visibleWidth(headingText) <= width ? visibleWidth(heading) : 0;

  const rowWidth = Math.max(0, width - visibleWidth(BRANCH) - 1);
  const finishedRows: Row[] = finished.map((run) =>
    ({ line: clip(`${theme.fg("dim", BRANCH)} ${renderFinishedLine(run, theme, rowWidth)}`), agent: run.agent_id, kind: "branch" }));
  const runningRows: [Row, Row][] = running.map((run) => {
    const [header, activity] = renderRunningLines(run, spinnerFrame, theme, rowWidth);
    // The activity line answers for the same Agent as its header, so clicking
    // "⎿ reading src/core/controller.ts" opens the Agent doing the reading.
    return [{ line: clip(`${theme.fg("dim", BRANCH)} ${header}`), agent: run.agent_id, kind: "branch" },
      { line: clip(theme.fg("dim", TRUNK) + activity), agent: run.agent_id, kind: "activity" }];
  });
  const queuedPresentation = runPresentation("queued", spinnerFrame);
  const queuedRow: Row | undefined = queued.length ? { line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg(queuedPresentation.color, queuedPresentation.glyph)} ` +
    `${theme.fg("dim", `${queued.length} queued`)}`), kind: "branch" } : undefined;
  const rows: Row[] = [{ line: heading }];
  if (owner.blocked && maxLines > 1) rows.push({ line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("error", GLYPHS.failure)} ${warning}`), kind: "branch" });
  let pagination: WidgetFrame["pagination"];
  if (expanded && inspectable) {
    const budget = bodyBudget - (needsPages ? 1 : 0);
    // Whole Agents, not line offsets: a tiny page still shows a clickable name.
    // Keep the activity subline whenever the viewport can afford a pair.
    const groups: Row[][] = [...finishedRows.map((row) => [row]),
      ...runningRows.map((pair) => budget >= 2 ? pair : [pair[0]]),
      ...queued.map((run): Row[] => [{ line: clip(`${theme.fg("dim", BRANCH)} ${renderQueuedLine(run, theme, rowWidth)}`), agent: run.agent_id, kind: "branch" }])];
    const pages: Row[][] = [[]];
    for (const group of groups) {
      if (pages[pages.length - 1]!.length + group.length > budget) pages.push([]);
      pages[pages.length - 1]!.push(...group);
    }
    const page = Math.max(0, Math.min(pages.length - 1, Math.floor(params.page ?? 0) || 0));
    rows.push(...pages[page]!);
    if (needsPages) {
      const prefix = `[Prev] ${page + 1}/${pages.length} `;
      pagination = { page, pages: pages.length, row: rows.length,
        ...(page > 0 ? { prev: [0, 6] as [number, number] } : {}),
        ...(page + 1 < pages.length ? { next: [visibleWidth(prefix), visibleWidth(prefix) + 6] as [number, number] } : {}) };
      rows.push({ line: theme.fg("dim", `${prefix}[Next]`) });
    }
  } else if (expanded) {
    if (runs.length > 0 && bodyBudget > 0) rows.push({ line: clip(theme.fg("dim", "Alt+A to inspect")) });
  } else {
    const body = finishedRows.length + runningRows.length * 2 + (queuedRow ? 1 : 0);
    if (body <= bodyBudget) rows.push(...finishedRows, ...runningRows.flat(), ...(queuedRow ? [queuedRow] : []));
    else rows.push(...overflow(runningRows, [queuedRow, queued.length], finishedRows, bodyBudget, clip, theme));
  }
  const closed = closeLast(rows);
  return { lines: closed.map((row) => row.line), hits: closed.map((row) => row.agent), headingWidth,
    ...(pagination ? { pagination } : {}) };
}
/** Lines only, for callers that do not route clicks. */
export const renderWidgetLines = (params: Parameters<typeof renderWidget>[0]): string[] => renderWidget(params).lines;

function overflow(running: [Row, Row][], queued: [row: Row | undefined, count: number],
  finished: Row[], maxBody: number, clip: (line: string) => string, theme: Theme): Row[] {
  const rows: Row[] = [];
  if (maxBody <= 0) return rows;
  // Priority inverts the calm order: still-running work matters most when space runs out.
  let budget = maxBody - 1, hiddenRunning = 0, hiddenFinished = 0, hiddenQueued = queued[1];
  for (const pair of running) {
    if (budget >= 2) { rows.push(...pair); budget -= 2; }
    else if (budget === 1 && maxBody <= 2) { rows.push(pair[0]); budget--; }
    else hiddenRunning++;
  }
  if (queued[0] && budget >= 1) { rows.push(queued[0]); budget--; hiddenQueued = 0; }
  for (const row of finished) {
    if (budget >= 1) { rows.push(row); budget--; } else hiddenFinished++;
  }
  // The queued row is itself a count, so dropping it silently would lose the fact.
  const hidden = [hiddenRunning ? `${hiddenRunning} running` : "", hiddenQueued ? `${hiddenQueued} queued` : "",
    hiddenFinished ? `${hiddenFinished} finished` : ""].filter(Boolean);
  const total = hiddenRunning + hiddenQueued + hiddenFinished;
  rows.push({ line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("dim", `+${total} more (${hidden.join(", ")})`)}`), kind: "branch" });
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

export interface WidgetTui {
  readonly terminal: { readonly columns: number; readonly rows?: number };
  /** "regular" or "fullscreen"; absent on a host that predates the field. */
  readonly mode?: string;
  requestRender(): void;
}
/** Structural subset of pi-tui's normalized mouse event. `y` is already local to
 * this component, which is exactly the widget row that was clicked. */
export interface WidgetMouseEvent { type: string; button: string; x: number; y: number }
export interface WidgetComponent {
  render(width: number): string[];
  invalidate(): void;
  handleMouse?(event: WidgetMouseEvent): { handled?: boolean; render?: boolean } | undefined;
}
/**
 * Agent activity and capacity stay in the widget above the editor rather than
 * being duplicated in a footer entry. Worker routing separately publishes the
 * compact `harness-preset` status, and `/harness-status` answers on demand for
 * hosts with no widget.
 */
export interface WidgetUi {
  /** Optional: a headless host may carry no widget surface at all. */
  setWidget?(key: string, content: ((tui: WidgetTui, theme: Theme) => WidgetComponent) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}
/** One Agent as the detail pane needs it: the Run projection, its live render
 * state, and a thunk for the child transcript the caller knows how to project. */
export interface AgentDetail {
  agent_id: string;
  view: RunView;
  live: GenerationPreview & { active_tools: ActiveTool[]; tool_uses: number };
  cwd: string;
  entries(): unknown[] | undefined;
  historyState?(): ActivityHistoryState | undefined;
  inFlight(): unknown;
}
interface WidgetController {
  /** Presentation hint only. Commands and explicit inspection remain fresh. */
  readonly presentationRevision?: number;
  list(options: { include_released?: boolean }): RunView[];
  stats(): { resident: number; parent_error?: string; internal_error?: string; cleanup_uncertain: boolean };
}
/** Each setter attempt is an identity token and possible host ownership, even
 * after a partial failure. Absence means there is no widget left to remove. */
interface WidgetMount {
  phase: "installing" | "ready" | "retry";
  pendingWake: boolean;
  instance?: WidgetInstance;
}
/** A factory may be invoked more than once. Only its current instance owns the
 * renderer and hit geometry; replacing either identity retires old callbacks. */
interface WidgetInstance {
  tui: WidgetTui;
  page: number;
  paint?: { frame: WidgetFrame; columns: number; rows?: number; width: number; theme: Theme };
}
/**
 * The main-screen display: a tree above the editor, and nothing in the footer
 * (see WidgetUi). Detached UI snapshots refresh on explicit ticks/inspection,
 * never editor renders. This cache is presentation only; agents() stays fresh.
 */
export class HarnessWidget {
  private ui?: WidgetUi;
  private lastMode?: string;
  private mount?: WidgetMount;
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private repaint?: ReturnType<typeof setTimeout>;
  private snapshot?: { runs: WidgetRun[]; owner: WidgetOwner };
  private sampled?: { runs: WidgetRun[]; owner: WidgetOwner };
  private sampledAt = 0;
  private revision?: number;
  private rosterEpoch = 0;
  private detailIds: string[] = [];
  private detailCache?: { revision: number; epoch: number; at: number; views: RunView[] };
  private version = 0;
  private versionKey: unknown[] = [];
  private readonly liveCache = new Map<string, { child: ChildActivityObservation; revision: number; live: ChildActivitySnapshot }>();
  private expanded = false;
  private beerMugs = false;
  private open?: (agent_id: string) => void;
  private rosterUpdate?: (inspectableCount: number) => void;
  /** Latest Run's linger per Agent. Expired ages remain as small tombstones so
   * reading a retained released result cannot start its linger over again. */
  private readonly age = new Map<string, { run_id: string; turns: number }>();
  private static readonly LINGER = { normal: 1, error: 3 };

  constructor(private readonly controller: WidgetController, private readonly residentLimit: number,
    private readonly activities: ActivityObservationSource = { get: () => undefined },
    private readonly onVisibleAgents?: (ids: ReadonlySet<string>) => void) {}

  /** Bound at session_start; a different context means the old widget is gone. */
  setUi(ui: WidgetUi): void {
    if (ui === this.ui) return;
    this.detachMount();
    this.ui = ui;
    this.snapshot = undefined;
    this.sampled = undefined;
    this.detailCache = undefined;
    this.lastMode = undefined;
    this.expanded = false;
  }
  /** Read-only appearance projection for the settings menu. */
  get beerMugsEnabled(): boolean { return this.beerMugs; }
  /** Appearance only: retire hit geometry without refreshing Owner projections. */
  setBeerMugs(enabled: boolean): void {
    if (this.beerMugs === enabled) return;
    this.beerMugs = enabled;
    const mount = this.mount, instance = mount?.instance;
    if (!mount || !instance) return;
    instance.paint = undefined;
    try { instance.tui.requestRender(); }
    catch (error) { this.retryMount(mount); throw error; }
  }
  /** What a click on an Agent row does. Unset until the host can mount a pane. */
  onOpen(handler: ((agent_id: string) => void) | undefined): void { this.open = handler; }
  /** Update projections notify pane coordination, never paint/inspection reads. */
  onRosterUpdate(handler: ((inspectableCount: number) => void) | undefined): void { this.rosterUpdate = handler; }
  /**
   * The renderer this session is running, captured from the widget's own paint.
   * The detail pane needs it BEFORE it mounts -- only the alternate screen can
   * carry a floating pane safely -- and `ui.custom` does not hand a TUI over
   * until its factory runs, which is already too late to choose. Undefined
   * until the widget has painted once, which the caller must treat as "regular".
   */
  /** The renderer last painted into. Falls back to the last one seen: going
   * idle or invalidating drops the component, not the renderer, and a mode read
   * as unknown would dock a pane the alternate screen should float. */
  tuiMode(): string | undefined { return this.mount?.instance?.tui.mode ?? this.lastMode; }
  /** Resident Agents plus released failures still in their diagnostic linger. */
  agents(): AgentDetail[] { return this.details(this.views()); }
  /** Pane animation reads detached presentation data, never admission evidence. */
  presentationAgents(): AgentDetail[] {
    const revision = this.controller.presentationRevision;
    if (revision === undefined) return this.agents();
    let cached = this.detailCache;
    if (!cached || cached.revision !== revision || cached.epoch !== this.rosterEpoch) {
      const views = this.views();
      cached = this.detailCache ?? { revision, epoch: this.rosterEpoch, at: performance.now(), views };
    }
    const delta = Math.max(0, performance.now() - cached.at);
    return this.details(cached.views.map((view) => terminal(view.status) ? view : {
      ...view, elapsed_ms: view.elapsed_ms + delta,
      ...(view.turn_elapsed_ms === undefined ? {} : { turn_elapsed_ms: view.turn_elapsed_ms + delta }),
      ...(view.execution_elapsed_ms === undefined || view.execution_exited ? {} : { execution_elapsed_ms: view.execution_elapsed_ms + delta }),
      ...(view.drain ? { drain: { ...view.drain, elapsed_ms: view.drain.elapsed_ms + delta } } : {}),
    }));
  }
  /** Cheap pane wake key. Undefined asks structural/legacy sources to poll fresh. */
  presentationVersion(): number | undefined {
    const revision = this.controller.presentationRevision;
    if (revision === undefined) return undefined;
    const key: unknown[] = [revision, this.rosterEpoch];
    for (const id of this.detailIds) {
      const child = this.activities.get(id);
      const history = child?.historyState?.();
      if (child && (child.presentationRevision === undefined || !history)) return undefined;
      key.push(id, child, child?.presentationRevision, history);
    }
    if (key.length !== this.versionKey.length || key.some((part, i) => part !== this.versionKey[i])) {
      this.versionKey = key; this.version++;
    }
    return this.version;
  }
  private details(views: RunView[]): AgentDetail[] {
    this.detailIds = views.map((view) => view.agent_id);
    return views.map((view) => {
      return { agent_id: view.agent_id, view, live: this.live(view.agent_id),
        cwd: view.effective_settings.cwd,
        // Resolve observations lazily as sessions start and retain diagnostics.
        entries: () => this.activities.get(view.agent_id)?.entries(),
        historyState: () => this.activities.get(view.agent_id)?.historyState?.(),
        inFlight: () => this.activities.get(view.agent_id)?.inFlight() };
    });
  }
  private live(id: string): ChildActivitySnapshot {
    const child = this.activities.get(id);
    if (!child) { this.liveCache.delete(id); return { active_tools: [], tool_uses: 0, preview: "" }; }
    const revision = child.presentationRevision, cached = this.liveCache.get(id);
    if (revision !== undefined && cached?.child === child && cached.revision === revision) return cached.live;
    const snapshot = child.snapshot(), live = { ...snapshot, active_tools: snapshot.active_tools.map((tool) => ({ ...tool })) };
    if (revision !== undefined) this.liveCache.set(id, { child, revision, live });
    return live;
  }
  /**
   * Any delegation tool may have changed the picture; `update` owns the loop and
   * decides what to do about it. A wake before admission is legitimately a
   * no-op -- the Run does not exist yet, so there is nothing to animate and the
   * loop would stop itself on this very call -- which is why the caller wakes
   * again once the tool has returned, rather than leaving the first paint to
   * whatever turn happens next.
   */
  wake(): void { this.update(); }
  onTurnStart(): void {
    this.rosterEpoch++;
    for (const age of this.age.values()) age.turns = Math.min(age.turns + 1, HarnessWidget.LINGER.error);
    this.update();
  }

  private lingering(agent_id: string, status: RunView["status"]): boolean {
    // `needs_input` is terminal but not finished: the Run is blocked on an
    // answer only the parent can give, and the widget is where that is noticed.
    // Ageing it out hides the one row whose absence stalls everything.
    if (status === "needs_input") return true;
    const limit = status === "failed" ? HarnessWidget.LINGER.error : HarnessWidget.LINGER.normal;
    return (this.age.get(agent_id)?.turns ?? 0) < limit;
  }
  private project(view: RunView): WidgetRun {
    const live = this.live(view.agent_id);
    return { agent_id: view.agent_id, run_id: view.run_id, resident: view.resident, name: view.name, profile: view.effective_settings.profile,
      difficulty: view.effective_settings.difficulty, model: view.effective_settings.model,
      effort: view.effective_settings.thinking,
      description: view.description, status: view.status, finishing: view.finalization_pending, execution_exited: view.execution_exited,
      turns: view.turns, max_turns: view.max_turns, elapsed_ms: view.elapsed_ms, turn_elapsed_ms: view.turn_elapsed_ms,
      cost: reported(view.usage, "cost"), cost_partial: view.usage?.partial.includes("cost"), runtime: view.runtime ? { ...view.runtime, context: view.runtime.context ? { ...view.runtime.context } : undefined } : undefined,
      drain: view.drain ? { ...view.drain } : undefined,
      question: !!view.outcome?.question, limit_reached: !!view.outcome?.limit_reached,
      error: view.outcome?.error, reason: view.outcome?.reason, pending_messages: view.pending_messages,
      has_run_warnings: view.cleanup_errors.length > 0, ...live };
  }
  private views(): RunView[] {
    // Always resample lease health on fresh reads, including Stop/inspection.
    // Retire the wake hint even without an Owner revision edge; the same fresh
    // detached batch becomes the pane's next presentation baseline below.
    this.detailCache = undefined;
    this.versionKey = [];
    const revision = this.controller.presentationRevision;
    const all = this.controller.list({ include_released: true });
    const at = performance.now();
    const known = new Set(all.map((view) => view.agent_id));
    for (const id of this.age.keys()) if (!known.has(id)) this.age.delete(id);
    for (const id of this.liveCache.keys()) if (!known.has(id)) this.liveCache.delete(id);
    for (const view of all) {
      if (!terminal(view.status)) this.age.delete(view.agent_id);
      else if (this.age.get(view.agent_id)?.run_id !== view.run_id) {
        // Even a Run that started AND settled between paints gets a fresh linger.
        this.age.set(view.agent_id, { run_id: view.run_id, turns: 0 });
      }
    }
    const views = all.filter((view) => view.resident ||
      ((view.status === "failed" || view.outcome?.status === "failed") && this.lingering(view.agent_id, "failed")));
    this.detailCache = revision === undefined ? undefined : { revision, epoch: this.rosterEpoch, at, views };
    // Report presentation retention without owning observers or SDK sessions.
    // Released failure transcripts survive only their diagnostic linger.
    this.onVisibleAgents?.(new Set(views.map((view) => view.agent_id)));
    return views;
  }
  private rows(): { runs: WidgetRun[]; owner: WidgetOwner } {
    const views = this.views();
    const stats = this.controller.stats();
    const error = stats.parent_error ?? stats.internal_error ?? (stats.cleanup_uncertain ? "cleanup uncertain" : undefined);
    return { runs: views.map((view) => this.project(view)),
      owner: { blocked: !!error, error, resident: stats.resident, resident_limit: this.residentLimit } };
  }

  update(refresh = false): void {
    if (!this.ui) return;
    if (this.mount?.phase === "installing") {
      // Synchronous wakes share the outer setter. A competing nested factory
      // could otherwise be overwritten by the older one when that setter returns.
      this.mount.pendingWake = true;
      return;
    }
    let snapshot: { runs: WidgetRun[]; owner: WidgetOwner };
    // A closed or failing owner must not take the parent UI down with it.
    try { snapshot = this.rows(); } catch { this.clear(); return; }
    this.revision = this.controller.presentationRevision;
    this.sampledAt = performance.now();
    this.sampled = snapshot;
    this.snapshot = snapshot;
    if (this.mount?.instance) this.mount.instance.paint = undefined;
    // Best-effort UI coordination uses this projection, including hidden idle
    // residents and lingering released failures, before any show/clear decision.
    try { this.rosterUpdate?.(snapshot.runs.length); } catch { /* Optional subscriber cannot break widget updates. */ }
    const { runs, owner } = snapshot;
    const running = runs.filter((run) => !terminal(run.status) && run.status !== "queued").length;
    const queued = runs.filter((run) => run.status === "queued").length;
    // Keep the cached component available for renderer discovery/inspection.
    // Only fullscreen paints an ordinary idle heading; other modes retain
    // capacity/attention facts, not a mouse entry they cannot activate.
    const showing = running + queued > 0 || owner.blocked || owner.resident > 0 ||
      runs.some((run) => terminal(run.status) && this.lingering(run.agent_id, run.status));
    if (!showing) { this.clear(); return; }
    // Only active work animates; a static idle or lingering roster has no loop.
    if (running || queued) this.timer ??= setInterval(() => this.updateFromTimer(), 80);
    else this.stopTimer();

    this.frame++;
    // RPC/print hosts can omit the widget and inspect /harness-status instead.
    const ui = this.ui;
    if (typeof ui.setWidget !== "function") return;
    const mount = this.mount;
    if (mount?.phase === "ready" && !refresh) {
      try { mount.instance?.tui.requestRender(); }
      catch (error) { this.retryMount(mount); throw error; }
      return;
    }
    this.install(ui);
  }

  private install(ui: WidgetUi): void {
    // Publish possible host ownership before a partially applying setter. The
    // token stays on failure for one eventual removal, but old callbacks die.
    const mount: WidgetMount = { phase: "installing", pendingWake: false };
    this.mount = mount;
    try {
      ui.setWidget!("harness-agents", (tui, theme) => this.createComponent(mount, tui, theme), { placement: "aboveEditor" });
      if (this.mount !== mount) return; // A setter may dispose/rebind synchronously.
      const pendingWake = mount.pendingWake;
      mount.phase = "ready";
      mount.pendingWake = false;
      if (pendingWake) this.update(); // One ordinary projection, never a second factory.
    } catch (error) { this.retryMount(mount); throw error; }
  }

  private createComponent(mount: WidgetMount, tui: WidgetTui, theme: Theme): WidgetComponent {
    if (this.mount !== mount || mount.phase === "retry") return { render: () => [], invalidate() {} };
    const instance: WidgetInstance = { tui, page: 0 };
    mount.instance = instance;
    this.lastMode = tui.mode;
    const current = () => this.mount === mount && mount.instance === instance;
    return {
      render: (width: number) => {
        if (!current() || !this.snapshot) return [];
        const frame = renderWidget({ ...this.snapshot, spinnerFrame: this.frame, expanded: this.expanded && tui.mode === "fullscreen",
          maxLines: lineBudget(tui.terminal.rows), page: instance.page, disclosure: tui.mode === "fullscreen", beerMugs: this.beerMugs,
          width: width || tui.terminal.columns, theme, shouldShowFinished: (id, status) => this.lingering(id, status) });
        instance.page = frame.pagination?.page ?? 0;
        instance.paint = { frame, columns: tui.terminal.columns, rows: tui.terminal.rows, width: width || tui.terminal.columns, theme };
        return frame.lines;
      },
      // Pi normalizes `y` to this component. Regular mode leaves the mouse to
      // the terminal; its keyboard inspection entry is Alt+A.
      handleMouse: (event) => {
        const paint = instance.paint;
        if (!current() || mount.phase !== "ready" || !paint || tui.mode !== "fullscreen" ||
          event.type !== "click" || event.button !== "left" || paint.columns !== tui.terminal.columns || paint.rows !== tui.terminal.rows ||
          !Number.isInteger(event.y) || !Number.isFinite(event.x) || event.x < 0) return undefined;
        const { frame } = paint;
        if (event.y === 0 && event.x < (frame.headingWidth ?? 0)) {
          // Explicit inspection refreshes presentation, never model-facing ACKs.
          try {
            this.snapshot = this.rows(); this.sampled = this.snapshot;
            this.sampledAt = performance.now(); this.revision = this.controller.presentationRevision;
          } catch { this.clear(); return undefined; }
          if (!this.snapshot.runs.length && !this.snapshot.owner.blocked && !this.snapshot.owner.resident) {
            this.clear(); return undefined;
          }
          this.expanded = !this.expanded;
          instance.page = 0; instance.paint = undefined; tui.requestRender();
          return { handled: true, render: true };
        }
        const nav = frame.pagination;
        if (nav && event.y === nav.row) {
          const inside = (range?: [number, number]) => range && event.x >= range[0] && event.x < range[1];
          if (inside(nav.prev)) instance.page--;
          else if (inside(nav.next)) instance.page++;
          else return undefined;
          instance.paint = undefined; tui.requestRender();
          return { handled: true, render: true };
        }
        const agent = frame.hits[event.y];
        if (!agent || !this.open || event.x >= visibleWidth(frame.lines[event.y]!)) return undefined;
        this.open(agent);
        return { handled: true };
      },
      invalidate: () => {
        if (!current()) return;
        mount.instance = undefined;
        // Theme replacement must leave pi-tui's invalidation walk first. Idle
        // widgets have no animation tick to perform this refresh for them.
        if (this.repaint) clearTimeout(this.repaint);
        this.repaint = setTimeout(() => {
          this.repaint = undefined;
          if (this.mount === mount) this.updateFromTimer(true);
        }, 0);
      },
    };
  }

  /** Failure retains removal ownership and cached content, but no live instance
   * or autonomous retry. A later external wake installs a new identity. */
  private retryMount(mount: WidgetMount): void {
    if (this.mount !== mount) return;
    mount.phase = "retry";
    mount.pendingWake = false;
    mount.instance = undefined;
    this.pausePainting();
  }

  private updateFromTimer(refresh = false): void {
    try {
      if (refresh || !this.sampled || this.controller.presentationRevision === undefined ||
          this.controller.presentationRevision !== this.revision) { this.update(refresh); return; }
      // No list/stats/clones on an animation tick. Clocks and activity have
      // independent invalidation; an unchanged Owner revision cannot hide them.
      const delta = Math.max(0, performance.now() - this.sampledAt);
      this.snapshot = { owner: this.sampled.owner, runs: this.sampled.runs.map((run) => {
        const live = this.live(run.agent_id);
        return { ...run, ...live,
          // Omitted live fields mean cleared, not inherited from the sampled row.
          thinking: live.thinking, channel: live.channel, preparing_tool: live.preparing_tool,
          elapsed_ms: run.elapsed_ms + (active(run) ? delta : 0),
          ...(run.turn_elapsed_ms === undefined ? {} : { turn_elapsed_ms: run.turn_elapsed_ms + delta }),
          ...(run.drain ? { drain: { ...run.drain, elapsed_ms: run.drain.elapsed_ms + delta } } : {}),
        };
      }) };
      this.frame++;
      const mount = this.mount, instance = mount?.instance;
      if (!mount || !instance || mount.phase !== "ready") return;
      const paint = instance.paint;
      if (paint) {
        const next = renderWidget({ ...this.snapshot, spinnerFrame: this.frame,
          expanded: this.expanded && instance.tui.mode === "fullscreen", maxLines: lineBudget(instance.tui.terminal.rows),
          page: instance.page, disclosure: instance.tui.mode === "fullscreen", beerMugs: this.beerMugs,
          width: paint.width, theme: paint.theme, shouldShowFinished: (id, status) => this.lingering(id, status) });
        if (next.lines.length === paint.frame.lines.length && next.lines.every((line, i) => line === paint.frame.lines[i])) return;
      }
      instance.paint = undefined;
      try { instance.tui.requestRender(); } catch (error) { this.retryMount(mount); throw error; }
    } catch { /* The failing setter/render request retired its own mount before throwing. */ }
  }

  /** Retire before host removal/rebinding, including when that host throws. */
  private detachMount(): WidgetMount | undefined {
    const mount = this.mount;
    this.mount = undefined;
    this.pausePainting();
    return mount;
  }
  private pausePainting(): void {
    this.stopTimer();
    if (this.repaint) { clearTimeout(this.repaint); this.repaint = undefined; }
  }
  /** Empty or unavailable: drop the widget and timer, but keep the binding. */
  private clear(): void {
    const mount = this.detachMount();
    this.snapshot = undefined;
    this.sampled = undefined;
    this.expanded = false;
    if (mount) this.ui?.setWidget?.("harness-agents", undefined);
  }
  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  dispose(): void {
    try { this.clear(); }
    finally {
      this.ui = undefined;
      this.open = undefined;
      this.rosterUpdate = undefined;
      this.lastMode = undefined;
      this.age.clear();
      this.liveCache.clear();
      this.detailCache = undefined;
      this.detailIds = [];
      this.versionKey = [];
    }
  }
}
