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
  pending_messages: number;
  notification_drops: number;
  /** Recorded cleanup/input/output issues, not proof that resources remain held. */
  has_run_warnings: boolean;
}
export interface WidgetOwner { blocked: boolean; error?: string; resident: number; resident_limit: number }

const active = (run: WidgetRun): boolean => !terminal(run.status);
/** The Agent's nickname when the model gave one, else its profile — never both. */
const label = (run: WidgetRun): { name: string; tag: string } => ({
  name: run.name || run.profile,
  tag: run.name ? run.profile : "",
});
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
const notes = (run: WidgetRun, theme: Theme): string[] => {
  const out: string[] = [];
  if (run.has_run_warnings) out.push(theme.fg("error", "run warning"));
  if (run.notification_drops > 0) out.push(theme.fg("error", `${run.notification_drops} dropped`));
  if (run.pending_messages > 0) out.push(theme.fg("warning", `${run.pending_messages} msg`));
  return out;
};

/** Keep attention signals ahead of optional text. Names yield to those signals;
 * the current task uses all room left after the compact statistics, rather than
 * an arbitrary short cap. The arrow separates stable identity from this Run's
 * work. The final row clip handles tiny terminals/diagnostics, never extra rows. */
function renderHeader(run: WidgetRun, icon: string, state: string, running: boolean, theme: Theme, width: number): string {
  const { name, tag } = label(run);
  const separator = theme.fg("dim", " · ");
  const signals = [...notes(run, theme), state].filter(Boolean);
  const attention = signals.length ? separator + signals.join(separator) : "";
  // Reserve the final clip marker too: trailing metadata must not replace the
  // last characters of an attention signal with an ellipsis.
  const nameRoom = Math.max(8, Math.min(32, width - visibleWidth(withoutBreaks(attention)) - 2 - visibleWidth(ROW_ELLIPSIS)));
  const shortName = truncateToWidth(withoutBreaks(name), nameRoom, "…");
  const identity = `${icon} ${running ? theme.bold(shortName) : theme.fg("dim", shortName)}${attention}`;
  const tagText = tag ? ` ${theme.fg("dim", `(${withoutBreaks(tag)})`)}` : "";
  const model = run.model ? ` ${theme.fg("dim", `[${withoutBreaks(run.model)}]`)}` : "";
  const metrics = separator + theme.fg("dim", stats(run, running).join(" · "));
  const taskLead = theme.fg("dim", " → ");
  const room = width - visibleWidth(withoutBreaks(identity + tagText + model + metrics + taskLead));
  const description = withoutBreaks(run.description).trim();
  const task = room >= 4 && description ?
    taskLead + theme.fg(running ? "muted" : "dim", truncateToWidth(description, room, "…")) : "";
  return identity + tagText + model + task + metrics;
}

export function renderFinishedLine(run: WidgetRun, theme: Theme, width = Infinity): string {
  let icon: string, state: string;
  if (run.status === "completed") {
    icon = theme.fg(run.limit_reached ? "warning" : "success", GLYPHS.success);
    state = run.limit_reached ? theme.fg("warning", "(turn limit)") : "";
  } else if (run.status === "needs_input") {
    icon = theme.fg("warning", GLYPHS.question);
    state = theme.fg("warning", run.question ? "needs answer" : "needs input");
  } else if (run.status === "cancelled") {
    icon = theme.fg("dim", GLYPHS.stopped);
    state = theme.fg("dim", "cancelled");
  } else {
    icon = theme.fg("error", GLYPHS.failure);
    const detail = run.error ?? run.reason;
    state = theme.fg("error", `failed${detail ? `: ${truncateToWidth(withoutBreaks(detail), 60, "…")}` : ""}`);
  }
  return renderHeader(run, icon, state, false, theme, width);
}

export function renderRunningLines(run: WidgetRun, spinnerFrame: number, theme: Theme, width = Infinity): [header: string, activity: string] {
  const frame = SPINNER[spinnerFrame % SPINNER.length]!;
  // "finishing" and "cancelling" are distinct facts: the first is our own
  // finalization, the second is a request whose exit is not yet observed.
  const state = run.status === "cancelling" ? theme.fg("warning", "cancelling") :
    run.finishing ? theme.fg("dim", "finishing") : "";
  const header = renderHeader(run, theme.fg("accent", frame), state, true, theme, width);
  const activity = run.drain && !run.finishing ? formatDrain(run.drain) :
    run.runtime?.activity === "compacting" ? "compacting context…" :
    run.runtime?.activity === "retrying" ? "retrying provider request…" : describeActivity(run.active_tools, run.preview);
  return [header, theme.fg("dim", `  ${GLYPHS.subLine}  ${activity}`)];
}

const MAX_WIDGET_LINES = 12;

/** One rendered row plus the Agent it belongs to; `agent` is what turns a click
 * at row N into "open that Agent". Chrome rows (heading, queued, overflow,
 * owner) carry none, so clicking them does nothing rather than something wrong. */
interface Row { line: string; agent?: string }
/** The lines to paint, and the Agent behind each one, by index. */
export interface WidgetFrame { lines: string[]; hits: (string | undefined)[] }

/** Pure body rendering. Returns the rows to display, already clipped to width. */
export function renderWidget(params: {
  runs: readonly WidgetRun[];
  owner: WidgetOwner;
  spinnerFrame: number;
  width: number;
  theme: Theme;
  shouldShowFinished: (agent_id: string, status: RunView["status"]) => boolean;
}): WidgetFrame {
  const { runs, owner, spinnerFrame, width, theme, shouldShowFinished } = params;
  const queued = runs.filter((run) => run.status === "queued");
  const running = runs.filter((run) => active(run) && run.status !== "queued");
  const finished = runs.filter((run) => terminal(run.status) && shouldShowFinished(run.agent_id, run.status));
  const hasActive = running.length > 0 || queued.length > 0;
  // A full roster is itself the news: the next delegation will be refused, and
  // the heading carrying "(full)" is the only place that is visible.
  const saturated = owner.resident_limit > 0 && owner.resident >= owner.resident_limit;
  if (!hasActive && !finished.length && !owner.blocked && !saturated) return { lines: [], hits: [] };

  const clip = (line: string) => truncateToWidth(withoutBreaks(line), width, ROW_ELLIPSIS);
  const color = owner.blocked ? "error" : hasActive ? "accent" : "dim";
  // `1/8` reads as eight assistants rather than one. The count is the fact; the
  // ceiling only matters once it blocks the next Agent, so it arrives as "full".
  const capacity = theme.fg("dim", ` ${owner.resident} resident`) +
    (saturated ? theme.fg("warning", " (full)") : "");
  const heading = clip(`${theme.fg(color, owner.blocked ? GLYPHS.failure : hasActive ? GLYPHS.agentsActive : GLYPHS.agentsIdle)} ` +
    `${theme.fg(color, "Agents")}${capacity}`);

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
  // The owner note is last and never dropped: it explains why nothing progresses.
  const ownerRow: Row | undefined = owner.blocked ? { line: clip(`${theme.fg("dim", BRANCH)} ${theme.fg("error", GLYPHS.failure)} ` +
    `${theme.fg("error", `owner blocked${owner.error ? `: ${owner.error.slice(0, 80)}` : ""}`)}`) } : undefined;

  const maxBody = MAX_WIDGET_LINES - 1 - (ownerRow ? 1 : 0);
  const body = finishedRows.length + runningRows.length * 2 + (queuedRow ? 1 : 0);
  const rows = body <= maxBody ?
    withinBudget(heading, runningRows, queuedRow, finishedRows) :
    overflow(heading, runningRows, [queuedRow, queued.length], finishedRows, maxBody, clip, theme);
  if (ownerRow) rows.push(ownerRow);
  const closed = closeLast(rows);
  return { lines: closed.map((row) => row.line), hits: closed.map((row) => row.agent) };
}
/** Lines only, for callers that do not route clicks. */
export const renderWidgetLines = (params: Parameters<typeof renderWidget>[0]): string[] => renderWidget(params).lines;

function withinBudget(heading: string, running: [Row, Row][], queued: Row | undefined, finished: Row[]): Row[] {
  const rows: Row[] = [{ line: heading }, ...finished];
  for (const pair of running) rows.push(...pair);
  if (queued) rows.push(queued);
  return rows;
}
function overflow(heading: string, running: [Row, Row][], queued: [row: Row | undefined, count: number],
  finished: Row[], maxBody: number, clip: (line: string) => string, theme: Theme): Row[] {
  const rows: Row[] = [{ line: heading }];
  // Priority inverts the calm order: still-running work matters most when space runs out.
  let budget = maxBody - 1, hiddenRunning = 0, hiddenFinished = 0, hiddenQueued = queued[1];
  for (const pair of running) {
    if (budget >= 2) { rows.push(...pair); budget -= 2; } else hiddenRunning++;
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
  const last = rows.length - 1;
  if (last < 1) return rows;
  const trailing = rows[last]!.line;
  if (last >= 2 && trailing.includes(TRUNK) && !trailing.includes(BRANCH)) {
    rows[last - 1]!.line = rows[last - 1]!.line.replace(BRANCH, LAST);
    rows[last]!.line = trailing.replace(TRUNK, "   ");
  } else rows[last]!.line = trailing.replace(BRANCH, LAST);
  return rows;
}

export interface WidgetTui {
  readonly terminal: { readonly columns: number };
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
 * (see WidgetUi). It owns no Run state — every frame is a fresh projection of
 * `list()`/`stats()` — so it cannot disagree with the tools.
 */
export class HarnessWidget {
  private ui?: WidgetUi;
  private tui?: WidgetTui;
  private lastMode?: string;
  /** The host may own a component even if its last replacement threw. */
  private registered = false;
  private needsRefresh = false;
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private repaint?: ReturnType<typeof setTimeout>;
  /** Per-line Agent ids from the last paint; a click at row N reads this. */
  private hits: (string | undefined)[] = [];
  private open?: (agent_id: string) => void;
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
    this.ui = ui;
    this.registered = false;
    this.needsRefresh = false;
    this.tui = undefined;
  }
  /** What a click on an Agent row does. Unset until the host can mount a pane. */
  onOpen(handler: ((agent_id: string) => void) | undefined): void { this.open = handler; }
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
      model: view.effective_settings.model, description: view.description, status: view.status, finishing: view.finalization_pending,
      turns: view.turns, max_turns: view.max_turns, elapsed_ms: view.elapsed_ms, turn_elapsed_ms: view.turn_elapsed_ms,
      cost: reported(view.usage, "cost"), cost_partial: view.usage?.partial.includes("cost"), runtime: view.runtime, drain: view.drain,
      question: !!view.outcome?.question, limit_reached: !!view.outcome?.limit_reached,
      error: view.outcome?.error, reason: view.outcome?.reason, pending_messages: view.pending_messages,
      notification_drops: view.notification_drops, has_run_warnings: view.cleanup_errors.length > 0, ...live };
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
    let snapshot: { runs: WidgetRun[]; owner: WidgetOwner };
    // A closed or failing owner must not take the parent UI down with it.
    try { snapshot = this.rows(); } catch { this.clear(); return; }
    const { runs, owner } = snapshot;
    const running = runs.filter((run) => !terminal(run.status) && run.status !== "queued").length;
    const queued = runs.filter((run) => run.status === "queued").length;
    // Same rule the renderer applies: a full roster is news on its own, so the
    // widget must not unmount while the heading still has "(full)" to say.
    const saturated = owner.resident_limit > 0 && owner.resident >= owner.resident_limit;
    const showing = running + queued > 0 || owner.blocked || saturated ||
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
    if (typeof this.ui.setWidget !== "function") return;
    if (this.registered && !refresh && !this.needsRefresh) { this.tui?.requestRender(); return; }
    // Track possible host ownership before calling a partially applying setter.
    // Only a successful return certifies that ordinary paints can reuse it.
    this.registered = true;
    this.needsRefresh = true;
    this.ui.setWidget("harness-agents", (tui, theme) => {
      this.tui = tui; this.lastMode = tui.mode;
      return {
        render: (width: number) => {
          const frame = renderWidget({ ...this.rows(), spinnerFrame: this.frame,
            width: width || tui.terminal.columns, theme, shouldShowFinished: (id, status) => this.lingering(id, status) });
          this.hits = frame.hits;
          return frame.lines;
        },
        // Pi normalizes the row to this component, so `y` indexes the last paint
        // directly. Only reachable on the alternate screen: the regular-mode
        // renderer never enables mouse reporting, where the shortcut is the way in.
        handleMouse: (event) => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          const agent = this.hits[event.y];
          if (!agent || !this.open) return undefined;
          this.open(agent);
          return { handled: true };
        },
        // A theme change invalidates the captured theme, so re-register instead.
        // Only `update()` re-registers, and the loop that would call it stops as
        // soon as nothing is running -- so schedule one, or a lingering finished
        // row keeps painting through the dead component with the old theme. A
        // macrotask: this runs inside pi-tui's own invalidation walk.
        invalidate: () => {
          if (!this.ui) return;
          this.tui = undefined;
          if (this.repaint) clearTimeout(this.repaint);
          this.repaint = setTimeout(() => { this.repaint = undefined; if (this.ui) this.updateFromTimer(true); }, 0);
        },
      };
    }, { placement: "aboveEditor" });
    this.needsRefresh = false;
  }

  private updateFromTimer(refresh = false): void {
    try { this.update(refresh); }
    catch {
      // Optional presentation must not throw out of a timer or spin on a broken
      // host. Keep possible host ownership for clear/dispose; a later external
      // wake can retry registration without trusting the failed replacement.
      this.needsRefresh = true;
      this.tui = undefined;
      this.hits = [];
      this.stopTimer();
      if (this.repaint) { clearTimeout(this.repaint); this.repaint = undefined; }
    }
  }

  /** Idle: drop the widget and the timer, but keep the binding. */
  private clear(): void {
    const registered = this.registered;
    this.registered = false;
    this.needsRefresh = false;
    this.tui = undefined;
    this.hits = [];
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
      this.lastMode = undefined;
      this.age.clear();
    }
  }
}
