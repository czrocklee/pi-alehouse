import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { validDifficulty, type RunView } from "../core/contracts.js";
import { reported, type UsageComponent } from "../core/usage-ledger.js";
import { profileLabel } from "../tools/tool-names.js";
import type { ActiveTool, GenerationPreview } from "../runtime/activity-types.js";
import { formatContextPercent, formatContextTokens, formatCost, formatDrain, formatMs, formatTokens, formatTurns, generationLine, shortPath,
  type Theme, type TranscriptRows } from "./format.js";
import { POPOVER, isPopoverCloseClick, popoverInlay, popoverInlayWidth, popoverSide } from "./popover.js";
import { clipPlainText, singleLineText, wrapPlainText as wrapText } from "./text.js";
import { activityPresentation, runPresentation } from "./run-presentation.js";
export { wrapText };

/** Label column, so every field's value starts at the same place. */
const LABEL = 10;
const STOP_LABEL = "[S Stop]";
const CONFIRM_LABEL = "[Confirm stop]";
const CONFIRM_HELP = "best-effort · Ctrl+S · Esc cancel";
const CONFIRM_HINT = `${CONFIRM_HELP} · ${CONFIRM_LABEL}`;
const CONFIRM_LIFETIME_MS = 10_000;
type StopTarget = Pick<RunView, "owner_id" | "generation" | "agent_id" | "run_id">;
interface PaintDimensions { columns: number; rows: number; width: number }
interface StopAction { kind: "stop" | "confirm"; from: number; to: number }
interface StopPaint { target: StopTarget; action: StopAction; dimensions: PaintDimensions }
interface StopConfirmation { target: StopTarget; expiresAt: number; dimensions: PaintDimensions }
interface FooterFrame { text: string; action?: StopAction }
interface TranscriptAnchor { target: StopTarget; width: number; start: number }
const sameStop = (target: StopTarget, view: RunView | undefined, selected: string): boolean =>
  selected === target.agent_id && !!view && view.agent_id === target.agent_id &&
  view.owner_id === target.owner_id && view.generation === target.generation &&
  view.run_id === target.run_id && stoppable(view);
/** Stop requests only apply to live execution, never settled or draining work. */
const stoppable = (view: RunView): boolean =>
  (view.status === "queued" || view.status === "running") && !view.execution_exited && !view.stop_reason;
/** A label as wide as its own column would run into the value, so clamp it here
 * rather than trusting every call site to stay short. */
const key = (label: string): string => label.length >= LABEL ? `${label.slice(0, LABEL - 1)} ` : label.padEnd(LABEL);
/** Upstream has no warning glyph and documents why — a glyph no monospace font
 * covers is drawn by a proportional fallback that overruns its cell, and East
 * Asian Width cannot detect that. So every severity here is a word, not a symbol. */

/** Live child state the pane shows beside the Run projection. */
export interface DetailLive extends GenerationPreview {
  active_tools: readonly ActiveTool[];
  tool_uses: number;
}
export interface DetailInput { view: RunView; live: DetailLive }
/**
 * The transcript's rows, supplied by the SDK/TUI layer (`transcript.ts`). Kept
 * structural so this module renders without importing Pi's components, which is
 * what lets the field rendering above stay a pure, directly testable function.
 */
const shortId = (value: string): string => value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
/** Every dispatch note, spelled out; the parent model is shown only tree_shared. */
const DISPATCH_NOTES: ReadonlyMap<string, string> = new Map([
  ["tree_shared", "another session holds this build tree"],
  ["tree_lock_unknown", "build-tree lock could not be confirmed"],
  ["source_state_unknown", "source state for the declared checks was not captured"],
]);
/**
 * Joins the two halves of a chrome row. Framed, the space between them is part
 * of the border, so it is drawn as rule: an inlay that stops mid-row leaves the
 * top and bottom of the box open. Docked there is no border to continue, and a
 * rule would read as a divider the pane does not have.
 */
const spanRow = (left: string, right: string, width: number, theme: Theme, rule: boolean): string => {
  const rightWidth = visibleWidth(right);
  const gap = Math.max(rightWidth ? 1 : 0, width - visibleWidth(left) - rightWidth);
  // A trailing rule has no right label to separate: run it to the inlay's end,
  // rather than leaving extra spaces beside the frame's close control.
  const tail = rightWidth ? " " : "";
  const filler = rule && gap >= 3 ? ` ${theme.fg("borderAccent", POPOVER.h.repeat(gap - 1 - tail.length))}${tail}` :
    rule && !rightWidth ? theme.fg("borderAccent", POPOVER.h.repeat(gap)) : " ".repeat(gap);
  return truncateToWidth(left + filler + right, width);
};

/** Live status chrome, shared by docked and framed lower-left footers. */
const renderDetailStatus = (view: RunView, spinnerFrame: number, theme: Theme, width: number): string => {
  const state = runPresentation(view.status, spinnerFrame, view.finalization_pending);
  const label = visibleWidth(state.label) + 2 <= width ? state.label : state.compact;
  return `${theme.fg(state.color, state.glyph)} ${theme.fg(state.color, label)}`;
};

/** The pane's own title row: identity and task, without live status. */
export function renderDetailTitle(input: DetailInput, _spinnerFrame: number, theme: Theme, width: number,
  rule = false): string {
  const { view } = input;
  const profile = singleLineText(profileLabel(view.effective_settings.profile));
  const name = singleLineText(view.name || profile);
  const task = singleLineText(view.description).trim() || "task";
  const marker = Number.isSafeInteger(view.task) && view.task > 0 ? `#${view.task}` : shortId(singleLineText(view.run_id));
  const suffix = ` · ${marker}`;
  // The task/Run cue never scrolls away. Sacrifice nickname/profile space first
  // so Agent reuse cannot leave two different tasks with identical chrome.
  const minimumContext = Math.min(8, visibleWidth(task)) + visibleWidth(suffix);
  let tag = view.name ? ` (${profile})` : "";
  let nameRoom = width - minimumContext - 2 - visibleWidth(tag);
  if (nameRoom < 3) { tag = ""; nameRoom = width - minimumContext - 2; }
  const shortName = truncateToWidth(name, Math.max(1, Math.min(32, nameRoom)), "…");
  const identity = theme.bold(shortName) + (tag ? theme.fg("dim", tag) : "");
  const taskRoom = width - visibleWidth(identity) - 2 - visibleWidth(suffix);
  const text = taskRoom > 0 ? identity + "  " + theme.fg("muted", truncateToWidth(task, taskRoom, "…")) +
    theme.fg("dim", suffix) : theme.fg("muted", truncateToWidth(`${marker} ${task}`, width, "…"));
  return spanRow(text, "", width, theme, rule);
}

/**
 * Everything the widget's one line cannot hold: identity, configuration,
 * lifecycle, usage, every active tool with its argument, and each stalling
 * condition under its own label. The transcript follows these rows and is
 * rendered by Pi's own components, not here.
 */
export function renderDetailFields(input: DetailInput, theme: Theme, width: number): string[] {
  const { view, live } = input;
  const inner = Math.max(8, width - LABEL - 2);
  const out: string[] = [];
  const field = (label: string, value: string, color = "text"): void => {
    for (const [i, line] of wrapText(value, inner).entries()) {
      out.push(truncateToWidth(`  ${theme.fg("dim", i === 0 ? key(label) : " ".repeat(LABEL))}` +
        (color === "text" ? line : theme.fg(color, line)), width));
    }
  };
  const lineRoom = Math.max(0, width - LABEL - 2);
  const oneLineField = (label: string, value: string, color = "muted"): void => {
    out.push(theme.fg("dim", clipPlainText(`  ${key(label)}`, Math.max(0, width))) +
      theme.fg(color, clipPlainText(singleLineText(value), lineRoom)));
  };
  const blank = (): void => { if (out.length && out[out.length - 1] !== "") out.push(""); };

  if (view.description) { field("task", view.description); blank(); }
  field("run", `${shortId(singleLineText(view.run_id))} · agent ${shortId(singleLineText(view.agent_id))}` +
    (view.history_ref ? ` · session ${shortId(singleLineText(view.history_ref.session_id))}` : ""));
  const s = view.effective_settings;
  const resolution = s.thinking_resolution === "preset_fixed" ? "preset fixed" :
    s.thinking_resolution === "automatic_mapping" ? `${s.parent_thinking}→${s.thinking} (auto map)` :
    s.thinking_resolution === "preset_mapping" ? `${s.parent_thinking}→${s.thinking} (preset map)` : "parent identity";
  const source = s.effort_source === "user_override" ? "user override" :
    s.effort_source === "preset" ? "preset" : undefined;
  // New matching slots need no redundant dN→dN; historical routes stay literal.
  // A missing/invalid historical rating cannot acquire an inferred difficulty.
  const route = validDifficulty(s.difficulty) && s.strength !== `d${s.difficulty}`
    ? `d${s.difficulty}→${s.strength}` : s.strength;
  field("routing", `${s.preset}@${s.preset_version} · ${route}`);
  field("effort", `${s.thinking} · ${resolution}${source ? ` · source: ${source}` : ""} · fixed at creation`);
  field("model", s.model);
  // Working-copy metadata is observational, not an isolation or cleanup grant.
  // Admission cwd remains the source; do not present it as a pending worktree.
  if (view.workspace) {
    field("workspace", "worktree working copy");
    field("cwd", view.workspace.cwd);
    field("source", view.workspace.source_cwd);
    field("base", view.workspace.base_commit);
    if (view.workspace_details) {
      if (view.workspace_details.checkout_root !== view.workspace.cwd) field("checkout", view.workspace_details.checkout_root);
      field("manifest", view.workspace_details.recovery_manifest);
    }
  } else if (view.recovery) {
    // Recovery belongs to this original Run. A verified checkout is not a
    // successful SDK/session binding; partial targets need not exist at all.
    const recovery = view.recovery;
    field("workspace", recovery.state === "checkout_ready" ? "worktree · retained verified checkout" : "worktree · partial setup");
    field("session", "SDK session unavailable");
    field("source", recovery.source_cwd);
    if (recovery.state === "checkout_ready") {
      if (recovery.cwd) field("cwd", recovery.cwd);
      if (recovery.base_commit) field("base", recovery.base_commit);
      if (recovery.checkout_root && recovery.checkout_root !== recovery.cwd) field("checkout", recovery.checkout_root);
    } else if (recovery.allocated_path) field("allocated", recovery.allocated_path);
    if (recovery.recovery_manifest) field("manifest", recovery.recovery_manifest);
  } else if (view.isolation === "worktree") {
    field("workspace", "worktree · not initialized");
    field("source", s.cwd);
  } else {
    field("workspace", "shared working copy");
    field("cwd", s.cwd);
  }
  field("tools", s.tools.join(" "));
  field("phase", [view.phase, view.resumable ? "resumable" : "", view.execution_exited ? "exited" : ""].filter(Boolean).join(" · "));
  if (!view.execution_exited && view.drain) field("drain", formatDrain(view.drain), "warning");
  else if (!view.execution_exited && view.runtime) field("activity", view.runtime.activity);
  if (view.model_stop_reason) field("model stop", view.model_stop_reason);
  const context = view.runtime?.context;
  if (context) field("context", `${context.tokens === null ? "unknown" : `≈${formatContextTokens(context.tokens)}`}/` +
    `${formatContextTokens(context.context_window)} tokens · ${formatContextPercent(context)}`);

  blank();
  const clock = view.turn_elapsed_ms !== undefined ? ` · this turn ${formatMs(view.turn_elapsed_ms)}` : "";
  field("turns", `${formatTurns(view.turns, view.max_turns)}${clock} · total ${formatMs(view.elapsed_ms)}`);
  field("execution", view.execution_elapsed_ms === undefined ? "not started" : formatMs(view.execution_elapsed_ms));
  const u = view.usage;
  // `?` is nothing reported at all; `≥` is a real figure that some response
  // left out of, so it is a floor. Collapsing the two would hide either the
  // money that WAS reported or the fact that more of it went unpriced.
  const count = (key: UsageComponent): string => {
    const value = reported(u, key);
    return value === undefined ? "?" : `${u?.partial.includes(key) ? "≥" : ""}${formatTokens(value, "")}`;
  };
  field("tokens", u ? `in ${count("input")} · out ${count("output")} · ` +
    `cache r ${count("cache_read")} · w ${count("cache_write")}` : "not reported");
  // Observed spend reaches the host through a later tool_result usage hook.
  // Rendering neither drains that accounting nor acknowledges communication.
  const spent = reported(u, "cost");
  field("cost", spent === undefined ? "not reported"
    : `${u?.partial.includes("cost") ? "≥ " : ""}${formatCost(spent)}`);
  field("calls", `${live.tool_uses} use${live.tool_uses === 1 ? "" : "s"}` +
    (live.active_tools.length ? ` · ${live.active_tools.length} running` : ""));

  if (live.active_tools.length) {
    blank();
    for (const [i, tool] of live.active_tools.entries()) {
      const name = singleLineText(tool.name);
      let detail = singleLineText(tool.detail ?? "…");
      if (["read", "edit", "write", "ls"].includes(name)) {
        detail = shortPath(detail, view.workspace?.cwd ?? s.cwd, Math.max(0, lineRoom - visibleWidth(`${name} `)));
      }
      oneLineField(i === 0 ? "active" : "", `${name} ${detail}`, "accent");
    }
  }
  if (activityPresentation({ ...view, finishing: view.finalization_pending }).showGeneration) {
    // The native transcript already holds the full streaming message. Keep each
    // supplemental preview to one row, clipping plain text before theme styling.
    const thinking = generationLine(live.thinking ?? ""), draft = generationLine(live.preview);
    if (thinking) { blank(); oneLineField("thinking", thinking); }
    if (draft) { blank(); oneLineField("draft", draft); }
    if (live.preparing_tool !== undefined) { blank(); oneLineField("preparing", singleLineText(live.preparing_tool) || "tool"); }
  }

  // Label, colour, text. Ordered by what stops progress soonest.
  const notes: [string, string, string][] = [];
  if (view.outcome?.question) notes.push(["asked", "warning", view.outcome.question]);
  if (view.outcome?.error) notes.push(["error", "error", view.outcome.error]);
  else if (view.outcome?.reason) notes.push(["reason", "dim", view.outcome.reason]);
  if (view.outcome?.limit_reached) notes.push(["limit", "warning", "stopped at the turn limit"]);
  for (const note of view.dispatch_notes ?? []) notes.push(["dispatch", "warning", DISPATCH_NOTES.get(note) ?? note]);
  if (view.unavailable_reason) notes.push(["session", "error", view.unavailable_reason]);
  if (view.owner_error) notes.push(["owner", "error", view.owner_error]);
  if (view.history_error) notes.push(["history", "warning", view.history_error]);
  if (view.pending_messages > 0) notes.push(["pending", "warning", `${view.pending_messages} alert(s) from this Run awaiting local presentation`]);
  for (const note of view.cleanup_errors) notes.push(["cleanup", "error", note]);
  for (const note of view.discarded_inputs) notes.push(["discarded", "warning", note]);
  if (notes.length) {
    blank();
    for (const [label, color, text] of notes) field(label, text, color);
  }

  return out;
}

/** The divider between the fields and the transcript, sized to the width. It
 * spans the whole row: stopping short of the right edge reads as a frayed rule
 * beside a frame that does reach it. */
export function transcriptRule(theme: Theme, width: number): string {
  const head = `${POPOVER.h}${POPOVER.h} transcript `;
  return truncateToWidth(theme.fg("borderMuted", head + POPOVER.h.repeat(Math.max(0, width - visibleWidth(head)))), width);
}

/**
 * Chrome: two rows, whether docked or floating. Docked, they are a title row and
 * a footer row; floating, the same two strings ride on the top and bottom border
 * so a frame costs no extra height -- only the two side columns.
 */
const CHROME_LINES = 2;
const MIN_VIEWPORT = 3;
const VIEWPORT_HEIGHT_PCT = 70;

/** Pads a styled row to `columns` display columns; ANSI has no width of its own. */
const padTo = (line: string, columns: number): string =>
  line + " ".repeat(Math.max(0, columns - visibleWidth(line)));

export interface PaneTui {
  readonly terminal: { readonly columns: number; readonly rows: number };
  requestRender(): void;
}
/** The pointer event as the pane reads it; a structural subset of pi-tui's. */
export interface PaneMouseEvent {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  wheelDelta?: number;
  /** Consecutive clicks reported by the host's normalized mouse dispatcher. */
  clickCount?: number;
}
export interface DetailPaneOptions {
  tui: PaneTui;
  theme: Theme;
  /** Re-read every frame, so the pane cannot disagree with the widget or the tools. */
  snapshot: () => { agent_id: string; input: DetailInput }[];
  /** One Agent's transcript rows, created once per Agent and reused; undefined
   * when its child session has not started and there is nothing to render. */
  transcript: (agent_id: string) => TranscriptRows | undefined;
  initial: string;
  done: () => void;
  /** The Agent on screen changed. Lets a caller that reopens the pane -- after
   * yielding to a permission dialog -- come back to what was being watched. */
  onSelect?: (agent_id: string) => void;
  /** Request cancellation through the host's Owner. Bound to the painted Run,
   * not whichever task this Agent might be running when a later callback fires. */
  onStop?: (run_id: string) => void;
  /**
   * Draw a border. Set when the pane floats as a centred overlay, where nothing
   * brackets it; docked it sits between the agents widget and Pi's footer, which
   * already bound it, so a frame would cost columns for nothing.
   */
  frame?: boolean;
}

/**
 * The docked detail pane: one agent at a time, ←/→ between them, ↑/↓ through the
 * body, Esc to close. Mounted through `ui.custom`'s NON-overlay path — Pi's
 * regular-mode renderer composites overlays into the buffer that backs
 * scrollback, so an overlay would bake this pane's rows into terminal history.
 */
export class DetailPane {
  private scrollOffset = 0;
  /** Follow the live tail, as the main conversation does, until the reader
   * scrolls away from the end; reaching the end again resumes following. */
  private followTail = true;
  private selected: string;
  private closed = false;
  /** Body height as last painted. Keys scroll what is on screen, so they read
   * this instead of rendering a second copy of a transcript that can run long. */
  private painted = 0;
  /** Width of the last framed paint; the close control's hit area follows it. */
  private paintedWidth = 0;
  private paintedHeight = 0;
  /** Previous field/transcript boundary, scoped to one Run and wrapping width. */
  private transcriptAnchor: TranscriptAnchor | undefined;
  private stopPaint: StopPaint | undefined;
  private confirmation: StopConfirmation | undefined;
  private frame = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: DetailPaneOptions) {
    this.selected = options.initial;
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.frame++;
      this.options.tui.requestRender();
    }, 120);
  }

  /**
   * The agent on screen, and where it sits in the list. When the selected one
   * has exited, the first row is not merely painted: it is SELECTED, so the
   * footer's position, the left/right neighbours and the host's notion of which
   * agent is open all describe the same agent as the body does.
   */
  private current(): { entries: { agent_id: string; input: DetailInput }[]; index: number } {
    const entries = this.options.snapshot();
    const index = entries.findIndex((entry) => entry.agent_id === this.selected);
    if (index === -1 && entries[0]) this.adopt(entries[0].agent_id);
    return { entries, index: index === -1 ? 0 : index };
  }
  /** Move the selection, resetting everything that described the old one. */
  private adopt(agent_id: string): void {
    this.selected = agent_id;
    this.scrollOffset = 0;
    this.followTail = true;
    this.painted = 0;
    this.transcriptAnchor = undefined;
    this.resetStopInteraction();
    this.options.onSelect?.(agent_id);
  }
  private select(entries: { agent_id: string }[], index: number): void {
    const next = entries[(index + entries.length) % entries.length];
    if (!next || next.agent_id === this.selected) return;
    this.adopt(next.agent_id);
  }

  /** A widget-row click is a direct selection, and clicking the selected row
   * again is the mouse equivalent of Esc. */
  activate(agent_id: string): void {
    if (this.closed) return;
    if (agent_id === this.selected) {
      this.closed = true;
      this.resetStopInteraction();
      this.options.done();
      return;
    }
    if (!this.options.snapshot().some((entry) => entry.agent_id === agent_id)) return;
    this.adopt(agent_id);
    this.options.tui.requestRender();
  }

  isOpen(): boolean { return !this.closed; }

  /** Hiding/yielding must discard intent as well as stale hit geometry. */
  resetStopInteraction(): void {
    this.stopPaint = undefined;
    this.confirmation = undefined;
  }

  /** Never reuse geometry after resize or an intent after its monotonic expiry.
   * Input checks this too: a delayed repaint cannot extend confirmation. */
  private retireStopPaint(width?: number): void {
    const painted = this.stopPaint?.dimensions ?? this.confirmation?.dimensions;
    const terminal = this.options.tui.terminal;
    if ((this.confirmation && performance.now() >= this.confirmation.expiresAt) ||
        (painted && (painted.columns !== terminal.columns || painted.rows !== terminal.rows ||
          (width !== undefined && painted.width !== width)))) this.resetStopInteraction();
  }

  /** Actions get fresh authority; rendering reuses its one captured snapshot. */
  private validStop(target: StopTarget): boolean {
    const entry = this.options.snapshot().find((entry) => entry.agent_id === target.agent_id);
    return sameStop(target, entry?.input.view, this.selected);
  }

  private requestStop(): void {
    const paint = this.stopPaint;
    if (!paint || paint.action.kind !== "stop" || !this.options.onStop || !this.validStop(paint.target)) {
      this.resetStopInteraction();
      return;
    }
    this.resetStopInteraction();
    this.confirmation = { target: paint.target, dimensions: paint.dimensions,
      expiresAt: performance.now() + CONFIRM_LIFETIME_MS };
    this.options.tui.requestRender();
  }

  private confirmStop(): void {
    const confirmation = this.confirmation, paint = this.stopPaint;
    if (!confirmation || !paint || paint.action.kind !== "confirm" ||
        paint.target !== confirmation.target || !this.options.onStop) return;
    const valid = performance.now() < confirmation.expiresAt && this.validStop(confirmation.target);
    // Consume intent before invoking a host callback, including a throwing one.
    this.resetStopInteraction();
    if (valid) this.options.onStop(confirmation.target.run_id);
    this.options.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+s")) {
      this.retireStopPaint();
      this.confirmStop();
      return;
    }
    if (matchesKey(data, "s") || matchesKey(data, "shift+s")) {
      this.retireStopPaint();
      if (!this.confirmation) this.requestStop();
      return;
    }
    // Pi's focused-input dispatcher requests an immediate render on return.
    // The 120 ms timer animates live activity; it does not gate keyboard paints.
    if (matchesKey(data, "escape")) {
      if (this.confirmation) {
        this.resetStopInteraction();
        this.options.tui.requestRender();
        return;
      }
      this.closed = true;
      this.resetStopInteraction();
      this.options.done();
      return;
    }
    const { entries, index } = this.current();
    if (matchesKey(data, "left") || matchesKey(data, "h")) return this.select(entries, index - 1);
    if (matchesKey(data, "right") || matchesKey(data, "l") || matchesKey(data, "tab")) return this.select(entries, index + 1);

    // Nothing has been laid out yet, so there is no geometry to scroll against.
    // Acting on `painted === 0` would read maxScroll as 0 and mistake every key
    // for "already at the end", silently turning the follow back on.
    if (this.painted === 0) return;
    const { viewportHeight, maxScroll } = this.bounds(this.painted);
    // Deliberate reading/navigation ends a pending cancellation decision;
    // background transcript growth does not. Home/End explicitly set follow.
    if (matchesKey(data, "home")) { this.scrollOffset = 0; this.followTail = false; }
    else if (matchesKey(data, "end")) { this.scrollOffset = maxScroll; this.followTail = true; }
    else {
      if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      else return;
      this.followTail = this.scrollOffset >= maxScroll;
    }
    this.resetStopInteraction();
    this.options.tui.requestRender();
  }

  /**
   * Wheel over the pane. The alternate-screen renderer offers every wheel event
   * to the overlay under the pointer before it reaches the conversation, and a
   * handled result stops it there, so the page behind never scrolls along.
   * `wheelDelta` is already in logical lines and already carries the terminal's
   * own step -- Alt multiplies it by five upstream -- so it is used as given.
   */
  handleMouse(event: PaneMouseEvent): { handled: boolean } | undefined {
    if (this.closed) return undefined;
    this.retireStopPaint();
    const action = this.stopPaint?.action;
    if ((event.type === "press" || event.type === "click") && event.button === "left" && event.y === this.paintedHeight - 1 &&
        event.x !== undefined && action && event.x >= action.from && event.x < action.to) {
      // Claim button presses so the SDK counts clicks by component/position,
      // not by text-selection words that change when the label is repainted.
      // Presses and subsequent clicks in one multi-click gesture never confirm.
      if (event.type === "click" && (event.clickCount ?? 1) === 1) {
        if (this.confirmation) this.confirmStop();
        else this.requestStop();
      }
      return { handled: true };
    }
    if (this.options.frame && !this.closed && event.x !== undefined && event.y !== undefined &&
        isPopoverCloseClick({ type: event.type, button: event.button, x: event.x, y: event.y }, this.paintedWidth)) {
      this.closed = true;
      this.resetStopInteraction();
      this.options.done();
      return { handled: true };
    }
    if (event.type !== "wheel" || !event.wheelDelta || this.painted === 0) return undefined;
    this.resetStopInteraction();
    const { maxScroll } = this.bounds(this.painted);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + event.wheelDelta));
    // Same rule as the keys: reaching the end resumes following the live tail.
    this.followTail = this.scrollOffset >= maxScroll;
    this.options.tui.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    this.retireStopPaint(width);
    this.stopPaint = undefined;
    this.paintedHeight = 0;
    if (this.closed || !Number.isFinite(width) || width < 12) {
      this.transcriptAnchor = undefined;
      this.resetStopInteraction(); return [];
    }
    // Floating, the two side columns come out of the body's width.
    const inner = this.options.frame ? width - 2 : width;
    if (inner < 10) { this.transcriptAnchor = undefined; this.resetStopInteraction(); return []; }
    // Framed, the title and footer are inlaid between the corners, so they get
    // two columns less than the body they sit above and below.
    const chrome = this.options.frame ? inner - 4 : inner;
    if (chrome < 8) { this.transcriptAnchor = undefined; this.resetStopInteraction(); return []; }
    // Framed, the title shares the top edge with the close control.
    const titleWidth = this.options.frame ? popoverInlayWidth(width, "top", true) : chrome;
    this.paintedWidth = this.options.frame ? width : 0;
    const { entries, index } = this.current();
    const entry = entries[index];
    if (!entry) {
      this.resetStopInteraction();
      this.painted = 0; // No visible body for keys/wheel to scroll against.
      this.transcriptAnchor = undefined;
      this.paintedHeight = CHROME_LINES + 1;
      return this.dress(this.options.theme.fg("dim", "harness"),
        [truncateToWidth(this.options.theme.fg("dim", "No agents are available to inspect."), inner)],
        this.footer(chrome, 0, 0, 0, 0, undefined, false, false).text, width, inner);
    }
    const view = entry.input.view;
    if (this.confirmation && !sameStop(this.confirmation.target, view, this.selected)) this.resetStopInteraction();
    const { owner_id, generation, agent_id, run_id } = view;
    const target = this.confirmation?.target ?? { owner_id, generation, agent_id, run_id };
    // Confirmation changes only the footer action. Keep the same selected Run,
    // title, transcript and scroll position instead of replacing the pane.
    // Fields first, then a rule, then the transcript Pi's own components render.
    const fields = renderDetailFields(entry.input, this.options.theme, inner);
    const rows = this.options.transcript(entry.agent_id);
    const transcript = rows?.lineCount(inner) ?? 0;
    const transcriptStart = fields.length + 1;
    const previous = this.transcriptAnchor;
    if (!this.followTail && previous?.width === inner && this.scrollOffset >= previous.start &&
        previous.target.owner_id === owner_id && previous.target.generation === generation &&
        previous.target.agent_id === agent_id && previous.target.run_id === run_id) {
      // Fields can appear/disappear between messages. A reader already in the
      // transcript should keep seeing the same transcript row, not those fields.
      this.scrollOffset += transcriptStart - previous.start;
    }
    this.transcriptAnchor = { target: { owner_id, generation, agent_id, run_id }, width: inner, start: transcriptStart };
    const total = transcriptStart + transcript;
    this.painted = total;
    const { viewportHeight, maxScroll, fits } = this.bounds(total);
    // A live transcript grows under the reader; only follow when they are at the end.
    // Clamped, not merely read: a body that SHRANK -- compaction, a resize, an
    // Agent with a shorter transcript -- would otherwise leave the offset above
    // the new maximum, and the next key up would still be `>= maxScroll` and so
    // re-engage following instead of scrolling.
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    if (this.followTail) this.scrollOffset = maxScroll;
    const start = this.scrollOffset;
    const footer = this.footer(chrome, index + 1, entries.length, start + viewportHeight, total, view,
      fits && Number.isFinite(this.options.tui.terminal.columns) && this.options.tui.terminal.columns > 0 &&
        !!this.options.onStop && stoppable(view), !!this.confirmation);
    this.paintedHeight = viewportHeight + CHROME_LINES;
    // Geometry is published once for this frame; formatting has no interaction
    // side effects. A hidden/unrenderable control cannot remain armed.
    if (footer.action) this.stopPaint = { target, action: footer.action,
      dimensions: { columns: this.options.tui.terminal.columns, rows: this.options.tui.terminal.rows, width } };
    else this.resetStopInteraction();
    return this.dress(renderDetailTitle(entry.input, this.frame, this.options.theme, titleWidth, !!this.options.frame),
      this.window(fields, rows, inner, start, viewportHeight), footer.text, width, inner);
  }

  invalidate(): void { this.resetStopInteraction(); }
  dispose(): void {
    this.closed = true;
    this.resetStopInteraction();
    clearInterval(this.timer);
  }

  // ---- Private ----

  /**
   * The visible slice across the two halves of the body. The fields are strings
   * this module produced; the transcript is sliced by its own owner, which
   * renders each settled message once per width rather than on every scroll.
   */
  private window(fields: string[], rows: TranscriptRows | undefined, width: number, start: number, height: number): string[] {
    const out: string[] = [];
    for (let i = start; i < start + height; i++) {
      if (i < fields.length) out.push(fields[i]!);
      else if (i === fields.length) out.push(transcriptRule(this.options.theme, width));
      else break;
    }
    const remaining = height - out.length;
    if (remaining <= 0 || !rows) {
      while (out.length < height) out.push("");
      return out;
    }
    const from = Math.max(0, start - fields.length - 1);
    out.push(...rows.slice(width, from, remaining).slice(0, remaining).map((row) => truncateToWidth(row, width)));
    while (out.length < height) out.push("");
    return out;
  }

  /**
   * Chrome around the body. Docked, the title and footer are plain rows. Framed,
   * they are inlaid into the border rows, so the frame costs two columns and no
   * rows at all -- a floating pane that spent two of its rows on bare rules
   * would show that much less transcript.
   */
  private dress(title: string, body: string[], footer: string, width: number, inner: number): string[] {
    if (!this.options.frame) return [truncateToWidth(title, width), ...body, footer];
    const th = this.options.theme;
    const side = popoverSide(th);
    return [popoverInlay(th, width, title, "top", true),
      ...body.map((line) => side + padTo(truncateToWidth(line, inner), inner) + side),
      popoverInlay(th, width, footer, "bottom")];
  }

  /** The one place a row count becomes a viewport, so `render` and `handleInput`
   * cannot disagree about how far the pane scrolls. Content-sized and capped at
   * a share of the terminal, never a fixed reservation of blank rows. */
  private bounds(total: number): { viewportHeight: number; maxScroll: number; fits: boolean } {
    const rows = this.options.tui.terminal.rows;
    const budget = Number.isFinite(rows) ? Math.max(0, Math.floor(rows * VIEWPORT_HEIGHT_PCT / 100)) : 0;
    const viewportHeight = Math.max(MIN_VIEWPORT, Math.min(total, Math.max(0, budget - CHROME_LINES)));
    return { viewportHeight, maxScroll: Math.max(0, total - viewportHeight), fits: viewportHeight + CHROME_LINES <= budget };
  }

  /** Pure chrome layout. Only render publishes its optional painted action. */
  private footer(width: number, position: number, count: number, shown: number, total: number,
    view: RunView | undefined, available: boolean, confirming: boolean): FooterFrame {
    const th = this.options.theme;
    const counts = th.fg("dim", count ? `${position}/${count} agents · ${Math.min(shown, total)}/${total} lines` : "no agents");
    const confirmRoom = width - visibleWidth(CONFIRM_HINT) - 1;
    const canStop = available && view && visibleWidth(renderDetailStatus(view, this.frame, th, confirmRoom)) <= confirmRoom;
    const action = canStop ? (confirming ? CONFIRM_LABEL : STOP_LABEL) : "";
    const required = action && confirming ? CONFIRM_HINT : action;
    const reserved = required ? visibleWidth(required) + 1 : 0;
    const status = view ? renderDetailStatus(view, this.frame, th, width - reserved) : undefined;
    const left = status === undefined ? counts : visibleWidth(status) + 3 + visibleWidth(counts) + reserved > width ? status :
      `${status}${th.fg("dim", " · ")}${counts}`;
    const navigation = confirming && action ? [CONFIRM_HELP] : ["←→ agent · ↑↓ scroll · Esc close", "←→ · ↑↓ · Esc", "Esc"];
    const choices = action ? [...navigation.map((text) => `${text} · ${action}`), ...(confirming ? [] : [action]), ""] : [...navigation, ""];
    const hints = choices.find((text) => visibleWidth(left) + 1 + visibleWidth(text) <= width) ?? "";
    const painted = !!action && hints.endsWith(action);
    const right = painted ? th.fg("dim", hints.slice(0, -action.length)) +
      (confirming ? th.bold(th.fg("warning", action)) : th.fg("dim", action)) : th.fg("dim", hints);
    const from = (this.options.frame ? 3 : 0) + width - visibleWidth(action);
    return { text: spanRow(left, right, width, th, !!this.options.frame),
      ...(painted ? { action: { kind: confirming ? "confirm" : "stop", from, to: from + visibleWidth(action) } } : {}) };
  }
}
