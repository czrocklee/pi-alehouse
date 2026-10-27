import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminal, type RunView } from "../core/contracts.js";
import { reported } from "../core/usage-ledger.js";
import type { ActivityObservationSource } from "../runtime/activity-observer.js";
import { describeActivity, formatContextPercent, formatCost, formatDrain, formatMs, formatTurns, GLYPHS, SPINNER,
  withoutBreaks, type ActiveTool, type Theme } from "./format.js";

const BRANCH = "├─", LAST = "└─", TRUNK = "│  ";

/** One rendered Agent row: the Agent's latest Run plus its ephemeral activity. */
export interface WidgetRun {
  agent_id: string;
  run_id: string;
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
  preview: string;
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
  const tag = run.name ? (difficulty ? `${run.profile}/${difficulty}` : run.profile) : difficulty;
  return { name: run.name || run.profile, tag };
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
      `: ${truncateToWidth(withoutBreaks(state.detail), detailRoom, "…")}` : "";
    const text = state ? (compact === 2 ? state.compact ?? state.text : state.text) + detail : "";
    const signals = [...notes(run, theme, compact), ...(state ? [theme.fg(state.color, text)] : [])];
    return signals.length ? joiner + signals.join(joiner) : "";
  };
  const nameText = withoutBreaks(name);
  const wantedName = Math.min(8, visibleWidth(nameText));
  const minimumName = Math.min(3, wantedName);
  const iconRoom = visibleWidth(icon) + 1;
  const clipRoom = visibleWidth(ROW_ELLIPSIS);
  let tagText = tag ? ` ${theme.fg("dim", `(${withoutBreaks(tag)})`)}` : "";
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
  const allocation = [run.model, run.effort].filter(Boolean).map(withoutBreaks).join("/");
  const allocationText = allocation ? ` ${theme.fg("dim", `[${allocation}]`)}` : "";
  const metrics = separator + theme.fg("dim", stats(run, running).join(" · "));
  const taskLead = theme.fg("dim", " → ");
  const room = width - visibleWidth(withoutBreaks(identity + tagText + allocationText + metrics + taskLead));
  const description = withoutBreaks(run.description).trim();
  const task = room >= 4 && description ?
    taskLead + theme.fg(running ? "muted" : "dim", truncateToWidth(description, room, "…")) : "";
  return identity + tagText + allocationText + task + metrics;
}

export function renderFinishedLine(run: WidgetRun, theme: Theme, width = Infinity): string {
  let icon: string, state: HeaderState | undefined;
  if (run.status === "completed") {
    icon = theme.fg(run.limit_reached ? "warning" : "success", GLYPHS.success);
    state = run.limit_reached ? { text: "(turn limit)", compact: "limit", color: "warning" } : undefined;
  } else if (run.status === "needs_input") {
    icon = theme.fg("warning", GLYPHS.question);
    state = { text: run.question ? "needs answer" : "needs input", compact: run.question ? "answer?" : "input?", color: "warning" };
  } else if (run.status === "cancelled") {
    icon = theme.fg("dim", GLYPHS.stopped);
    state = { text: "cancelled", color: "dim" };
  } else {
    icon = theme.fg("error", GLYPHS.failure);
    state = { text: "failed", detail: run.error ?? run.reason, color: "error" };
  }
  return renderHeader(run, icon, state, false, theme, width);
}

export function renderRunningLines(run: WidgetRun, spinnerFrame: number, theme: Theme, width = Infinity): [header: string, activity: string] {
  const frame = SPINNER[spinnerFrame % SPINNER.length]!;
  // "finishing" and "cancelling" are distinct facts: the first is our own
  // finalization, the second is a request whose exit is not yet observed.
  const state: HeaderState | undefined = run.status === "cancelling" ? { text: "cancelling", color: "warning" } :
    run.finishing ? { text: "finishing", color: "dim" } : undefined;
  const header = renderHeader(run, theme.fg("accent", frame), state, true, theme, width);
  const activity = run.drain && !run.finishing ? formatDrain(run.drain) :
    run.runtime?.activity === "compacting" ? "compacting context…" :
    run.runtime?.activity === "retrying" ? "retrying provider request…" : describeActivity(run.active_tools, run.preview);
  return [header, theme.fg("dim", `  ${GLYPHS.subLine}  ${activity}`)];
}

const MAX_WIDGET_LINES = 12;
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
  return renderHeader(run, theme.fg("muted", GLYPHS.queued), { text: "queued", color: "muted" }, false, theme, width);
}

/** One rendered row plus the Agent it belongs to; `agent` is what turns a click
 * at row N into "open that Agent". Chrome carries none: the heading has its own
 * expansion action, while aggregate queued/overflow/owner rows are inert. */
interface Row { line: string; agent?: string }
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
  /** Total budget including heading, warning and controls; always capped at 12. */
  maxLines?: number;
  page?: number;
  /** Mouse inspection entry: regular/unknown modes need no ordinary idle heading. */
  disclosure?: boolean;
}): WidgetFrame {
  const { runs, owner, spinnerFrame, width, theme, shouldShowFinished, expanded = false, disclosure = true } = params;
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
  // `1/8` reads as eight assistants rather than one. The count is the fact; the
  // ceiling only matters once it blocks the next Agent, so it arrives as "full".
  const capacity = theme.fg("dim", ` ${owner.resident} resident`) +
    (saturated ? theme.fg("warning", " (full)") : "");
  const glyph = owner.blocked ? GLYPHS.failure : hasActive ? GLYPHS.agentsActive : GLYPHS.agentsIdle;
  const title = `${theme.fg(color, glyph)} ${theme.fg(color, "Agents")}${capacity}`;
  // Reserve warning space before body allocation, never at the clipped bottom.
  const chrome = 1 + (owner.blocked && maxLines > 1 ? 1 : 0);
  const bodyBudget = maxLines - chrome;
  const rosterCost = runs.reduce((sum, run) => sum + (active(run) && run.status !== "queued" ? 2 : 1), 0);
  const needsPages = rosterCost > bodyBudget;
  const controlWidth = visibleWidth(`[Prev] ${runs.length}/${runs.length} [Next]`);
  const inspectable = runs.length > 0 && bodyBudget >= (needsPages ? 2 : 1) &&
    width >= (needsPages ? controlWidth : 16);
  const disclosureText = disclosure && inspectable ? theme.fg("dim", expanded ? " ▾" : " ▸") : "";
  const warning = theme.fg("error", `owner blocked${owner.error ? `: ${owner.error.slice(0, 80)}` : ""}`);
  // Keep the disclosure readable before optional wording on narrow terminals.
  const shortTitle = `${theme.fg(color, `${glyph} Agents`)}${theme.fg("dim", ` ${owner.resident}`)}` +
    (saturated ? theme.fg("warning", " full") : "");
  const headingTitle = disclosureText && visibleWidth(title + disclosureText) > width ? shortTitle : title;
  const fallback = disclosure && runs.length && !inspectable ? theme.fg("dim", " · Alt+A") : "";
  const headingText = maxLines === 1 && owner.blocked ? warning : headingTitle + disclosureText + fallback;
  const heading = clip(headingText);
  const headingWidth = disclosureText && visibleWidth(headingText) <= width ? visibleWidth(heading) : 0;

  const rowWidth = Math.max(0, width - visibleWidth(BRANCH) - 1);
  const finishedRows: Row[] = finished.map((run) =>
    ({ line: clip(`${theme.fg("dim", BRANCH)} ${renderFinishedLine(run, theme, rowWidth)}`), agent: run.agent_id }));
  const runningRows: [Row, Row][] = running.map((run) => {
    const [header, activity] = renderRunningLines(run, spinnerFrame, theme, rowWidth);
    // The activity line answers for the same Agent as its header, so clicking
    // "⎿ reading src/core/controller.ts" opens the Agent doing the reading.
    return [{ line: clip(`${theme.fg("dim", BRANCH)} ${header}`), agent: run.agent_id },
      { line: clip(theme.fg("dim", TRUNK) + activity), agent: run.agent_id }];
  });
  const queuedRow: Row | undefined = queued.length ? { line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("muted", GLYPHS.queued)} ` +
    `${theme.fg("dim", `${queued.length} queued`)}`) } : undefined;
  const rows: Row[] = [{ line: heading }];
  if (owner.blocked && maxLines > 1) rows.push({ line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("error", GLYPHS.failure)} ${warning}`) });
  let pagination: WidgetFrame["pagination"];
  if (expanded && inspectable) {
    const budget = bodyBudget - (needsPages ? 1 : 0);
    // Whole Agents, not line offsets: a tiny page still shows a clickable name.
    // Keep the activity subline whenever the viewport can afford a pair.
    const groups: Row[][] = [...finishedRows.map((row) => [row]),
      ...runningRows.map((pair) => budget >= 2 ? pair : [pair[0]]),
      ...queued.map((run) => [{ line: clip(`${theme.fg("dim", BRANCH)} ${renderQueuedLine(run, theme, rowWidth)}`), agent: run.agent_id }])];
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
  rows.push({ line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("dim", `+${total} more (${hidden.join(", ")})`)}`) });
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
  let last = rows.length - 1;
  while (last > 0 && !rows[last]!.line.includes(BRANCH) && !rows[last]!.line.includes(TRUNK)) last--;
  if (last < 1) return rows;
  const trailing = rows[last]!.line;
  if (last >= 2 && trailing.includes(TRUNK) && !trailing.includes(BRANCH)) {
    rows[last - 1]!.line = rows[last - 1]!.line.replace(BRANCH, LAST);
    rows[last]!.line = trailing.replace(TRUNK, "   ");
  } else rows[last]!.line = trailing.replace(BRANCH, LAST);
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
  live: { active_tools: ActiveTool[]; tool_uses: number; preview: string };
  cwd: string;
  entries(): unknown[] | undefined;
  inFlight(): unknown;
}
interface WidgetController {
  list(options: { include_released?: boolean }): RunView[];
  stats(): { resident: number; parent_error?: string; internal_error?: string; cleanup_uncertain: boolean };
}
/**
 * The main-screen display: a tree above the editor, and nothing in the footer
 * (see WidgetUi). Detached UI snapshots refresh on explicit ticks/inspection,
 * never editor renders. This cache is presentation only; agents() stays fresh.
 */
export class HarnessWidget {
  private ui?: WidgetUi;
  private tui?: WidgetTui;
  private lastMode?: string;
  /** The host may own a component even if its last replacement threw. */
  private registered = false;
  private needsRefresh = false;
  /**
   * Set only while the outer setWidget call is on the stack. A synchronous
   * wake before that setter applies its factory must not install another one:
   * the nested call would publish epoch N+1 and the outer factory N would
   * overwrite it, leaving registered, needsRefresh false, and a blank widget.
   * Latch one pending wake instead so the outer factory stays current; after
   * a successful install, refresh the detached projection and request paint.
   * No second factory and no recursive registration. Failure and clear release
   * the latch; recovery is a later external wake, not an autonomous retry.
   * Nested forced refresh is the factory already being installed. Deferred
   * invalidation stays a separate macrotask and is not coalesced here.
   */
  private registration?: { pendingWake: boolean };
  /** Retired host components must not read or act on a replacement's hits. */
  private componentEpoch = 0;
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private repaint?: ReturnType<typeof setTimeout>;
  private snapshot?: { runs: WidgetRun[]; owner: WidgetOwner };
  /** Retire component-local geometry before updates and failed replacements. */
  private retire?: () => void;
  private forgetPaint?: () => void;
  private expanded = false;
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
    this.retire?.(); this.retire = undefined;
    this.forgetPaint = undefined;
    this.stopTimer();
    if (this.repaint) { clearTimeout(this.repaint); this.repaint = undefined; }
    this.ui = ui;
    this.registration = undefined;
    this.componentEpoch++;
    this.registered = false;
    this.needsRefresh = false;
    this.tui = undefined;
    this.snapshot = undefined;
    this.lastMode = undefined;
    this.expanded = false;
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
  tuiMode(): string | undefined { return this.tui?.mode ?? this.lastMode; }
  /** Resident Agents plus released failures still in their diagnostic linger. */
  agents(): AgentDetail[] {
    return this.views().map((view) => {
      const child = this.activities.get(view.agent_id);
      return { agent_id: view.agent_id, view,
        live: child?.snapshot() ?? { active_tools: [], tool_uses: 0, preview: "" },
        cwd: child?.workspace ?? view.effective_settings.cwd,
        // A pane may retain these thunks while a queued Agent has no child yet.
        entries: () => this.activities.get(view.agent_id)?.entries(),
        inFlight: () => this.activities.get(view.agent_id)?.inFlight() };
    });
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
    const live = this.activities.get(view.agent_id)?.snapshot() ?? { active_tools: [], tool_uses: 0, preview: "" };
    return { agent_id: view.agent_id, run_id: view.run_id, name: view.name, profile: view.effective_settings.profile,
      difficulty: view.effective_settings.difficulty, model: view.effective_settings.model,
      effort: view.effective_settings.thinking,
      description: view.description, status: view.status, finishing: view.finalization_pending,
      turns: view.turns, max_turns: view.max_turns, elapsed_ms: view.elapsed_ms, turn_elapsed_ms: view.turn_elapsed_ms,
      cost: reported(view.usage, "cost"), cost_partial: view.usage?.partial.includes("cost"), runtime: view.runtime, drain: view.drain,
      question: !!view.outcome?.question, limit_reached: !!view.outcome?.limit_reached,
      error: view.outcome?.error, reason: view.outcome?.reason, pending_messages: view.pending_messages,
      has_run_warnings: view.cleanup_errors.length > 0, ...live };
  }
  private views(): RunView[] {
    const all = this.controller.list({ include_released: true });
    const known = new Set(all.map((view) => view.agent_id));
    for (const id of this.age.keys()) if (!known.has(id)) this.age.delete(id);
    for (const view of all) {
      if (!terminal(view.status)) this.age.delete(view.agent_id);
      else if (this.age.get(view.agent_id)?.run_id !== view.run_id) {
        // Even a Run that started AND settled between paints gets a fresh linger.
        this.age.set(view.agent_id, { run_id: view.run_id, turns: 0 });
      }
    }
    const views = all.filter((view) => view.resident ||
      ((view.status === "failed" || view.outcome?.status === "failed") && this.lingering(view.agent_id, "failed")));
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
    if (this.registration) {
      // Coalesce into the in-flight outer factory; do not publish epoch N+1.
      this.registration.pendingWake = true;
      return;
    }
    let snapshot: { runs: WidgetRun[]; owner: WidgetOwner };
    // A closed or failing owner must not take the parent UI down with it.
    try { snapshot = structuredClone(this.rows()); } catch { this.clear(); return; }
    this.snapshot = snapshot;
    this.forgetPaint?.();
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
    // Only the spinner animates. Lingering rows and the blocked line are static,
    // so the loop stops as soon as nothing is running or queued -- and starts
    // whenever work is there, whichever paint noticed it first.
    if (running || queued) this.timer ??= setInterval(() => this.updateFromTimer(), 80);
    else this.stopTimer();

    this.frame++;
    // A non-interactive host (RPC/print) may carry no widget surface. There is
    // no agent-capacity footer fallback by design, so such a host simply shows
    // no widget and reads capacity from /harness-status instead of throwing.
    const ui = this.ui;
    if (typeof ui.setWidget !== "function") return;
    if (this.registered && !refresh && !this.needsRefresh) { this.tui?.requestRender(); return; }
    // Track possible host ownership before calling a partially applying setter.
    // Only a successful return certifies that ordinary paints can reuse it.
    this.registered = true;
    this.needsRefresh = true;
    const epoch = ++this.componentEpoch;
    this.retire?.();
    const registration = { pendingWake: false };
    this.registration = registration;
    const factory = (tui: WidgetTui, theme: Theme): WidgetComponent => {
      if (!this.ui || epoch !== this.componentEpoch) return { render: () => [], invalidate() {} };
      this.tui = tui; this.lastMode = tui.mode;
      this.retire?.();
      let painted: WidgetFrame | undefined, page = 0, paintedColumns = 0, paintedRows: number | undefined;
      let retired = false;
      const clearGeometry = () => { painted = undefined; };
      this.forgetPaint = clearGeometry;
      this.retire = () => { retired = true; clearGeometry(); };
      return {
        render: (width: number) => {
          if (!this.ui || retired || epoch !== this.componentEpoch || !this.snapshot) return [];
          painted = renderWidget({ ...this.snapshot, spinnerFrame: this.frame, expanded: this.expanded && tui.mode === "fullscreen",
            maxLines: lineBudget(tui.terminal.rows), page, disclosure: tui.mode === "fullscreen",
            width: width || tui.terminal.columns, theme, shouldShowFinished: (id, status) => this.lingering(id, status) });
          page = painted.pagination?.page ?? 0;
          paintedColumns = tui.terminal.columns; paintedRows = tui.terminal.rows;
          return painted.lines;
        },
        // Pi normalizes the row to this component, so `y` indexes the last paint
        // directly. Only reachable on the alternate screen: the regular-mode
        // renderer never enables mouse reporting, where the shortcut is the way in.
        handleMouse: (event) => {
          if (event.type !== "click" || event.button !== "left" || tui.mode !== "fullscreen" || !this.ui || retired ||
            !this.registered || this.needsRefresh || epoch !== this.componentEpoch || !painted ||
            paintedColumns !== tui.terminal.columns || paintedRows !== tui.terminal.rows ||
            !Number.isInteger(event.y) || !Number.isFinite(event.x) || event.x < 0) return undefined;
          if (event.y === 0 && event.x < (painted.headingWidth ?? 0)) {
            // Explicit inspection can sample newer facts, but never publishes a
            // roster notification, consumes alerts or starts an idle timer.
            try { this.snapshot = structuredClone(this.rows()); } catch { this.clear(); return undefined; }
            if (!this.snapshot.runs.length && !this.snapshot.owner.blocked && !this.snapshot.owner.resident) {
              this.clear(); return undefined;
            }
            this.expanded = !this.expanded;
            page = 0; clearGeometry(); tui.requestRender();
            return { handled: true, render: true };
          }
          const nav = painted.pagination;
          if (nav && event.y === nav.row) {
            const inside = (range?: [number, number]) => range && event.x >= range[0] && event.x < range[1];
            if (inside(nav.prev)) page--;
            else if (inside(nav.next)) page++;
            else return undefined;
            clearGeometry(); tui.requestRender();
            return { handled: true, render: true };
          }
          const agent = painted.hits[event.y];
          if (!agent || !this.open || event.x >= visibleWidth(painted.lines[event.y]!)) return undefined;
          this.open(agent);
          return { handled: true };
        },
        // A theme change invalidates the captured theme, so re-register instead.
        // Only `update()` re-registers, and the loop that would call it stops as
        // soon as nothing is running -- so schedule one, or a lingering finished
        // row keeps painting through the dead component with the old theme. A
        // macrotask: this runs inside pi-tui's own invalidation walk.
        invalidate: () => {
          if (!this.ui || retired || epoch !== this.componentEpoch) return;
          retired = true; clearGeometry();
          this.tui = undefined;
          if (this.repaint) clearTimeout(this.repaint);
          this.repaint = setTimeout(() => { this.repaint = undefined; if (this.ui) this.updateFromTimer(true); }, 0);
        },
      };
    };
    let pendingWake = false;
    try {
      ui.setWidget("harness-agents", factory, { placement: "aboveEditor" });
      if (this.ui === ui && epoch === this.componentEpoch && this.registration === registration) {
        this.needsRefresh = false;
        pendingWake = registration.pendingWake;
      }
    } finally {
      // A setter can retire/rebind this widget; never touch a newer lifetime's
      // latch or read through shared state that teardown may have cleared.
      if (this.registration === registration) this.registration = undefined;
    }
    if (pendingWake && this.ui === ui && epoch === this.componentEpoch) this.update();
  }

  private updateFromTimer(refresh = false): void {
    try { this.update(refresh); }
    catch {
      // Optional presentation must not throw out of a timer or spin on a broken
      // host. Keep possible host ownership for clear/dispose; a later external
      // wake can retry registration without trusting the failed replacement.
      this.needsRefresh = true;
      this.tui = undefined;
      this.componentEpoch++;
      this.retire?.(); this.retire = undefined;
      this.forgetPaint = undefined;
      this.stopTimer();
      if (this.repaint) { clearTimeout(this.repaint); this.repaint = undefined; }
    }
  }

  /** Empty or unavailable: drop the widget and timer, but keep the binding. */
  private clear(): void {
    if (this.registration) this.registration.pendingWake = false;
    const registered = this.registered;
    this.componentEpoch++;
    this.registered = false;
    this.needsRefresh = false;
    this.tui = undefined;
    this.retire?.(); this.retire = undefined;
    this.forgetPaint = undefined;
    this.snapshot = undefined;
    this.expanded = false;
    this.stopTimer();
    if (this.repaint) { clearTimeout(this.repaint); this.repaint = undefined; }
    if (registered) this.ui?.setWidget?.("harness-agents", undefined);
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
    }
  }
}
