import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminal, type RunView } from "../core/contracts.js";
import { reported, type UsageComponent } from "../core/usage-ledger.js";
import { formatContextPercent, formatContextTokens, formatCost, formatDrain, formatMs, formatTokens, formatTurns,
  GLYPHS, SPINNER, withoutBreaks, type ActiveTool, type Theme, type TranscriptRows } from "./format.js";
import { POPOVER, isPopoverCloseClick, popoverInlay, popoverInlayWidth, popoverSide } from "./popover.js";

/** Label column, so every field's value starts at the same place. */
const LABEL = 10;
/** A label as wide as its own column would run into the value, so clamp it here
 * rather than trusting every call site to stay short. */
const key = (label: string): string => label.length >= LABEL ? `${label.slice(0, LABEL - 1)} ` : label.padEnd(LABEL);
/** Upstream has no warning glyph and documents why — a glyph no monospace font
 * covers is drawn by a proportional fallback that overruns its cell, and East
 * Asian Width cannot detect that. So every severity here is a word, not a symbol. */

/**
 * Wraps PLAIN text by display columns: CJK breaks anywhere, latin prefers the
 * last space. Styling is applied to the produced lines, never before — an ANSI
 * sequence has no width and would be cut in half here.
 */
export function wrapText(text: string, columns: number): string[] {
  if (columns <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "", used = 0, breakAt = -1;
    // A newline is a paragraph break here, but a tab or a stray carriage return
    // moves the cursor without costing a column, so the arithmetic below would
    // be measuring one thing and the terminal drawing another.
    for (const char of paragraph.replace(/[\t\v\f\r\u0085\u2028\u2029]+/g, " ")) {
      const w = visibleWidth(char);
      if (used + w > columns) {
        if (breakAt > 0) { out.push(line.slice(0, breakAt)); line = line.slice(breakAt + 1); }
        else { out.push(line); line = ""; }
        used = visibleWidth(line);
        breakAt = -1;
      }
      if (char === " ") breakAt = line.length;
      line += char;
      used += w;
    }
    out.push(line);
  }
  return out;
}

/** Live child state the pane shows beside the Run projection. */
export interface DetailLive {
  active_tools: readonly ActiveTool[];
  tool_uses: number;
  preview: string;
}
export interface DetailInput { view: RunView; live: DetailLive }
/**
 * The transcript's rows, supplied by the SDK/TUI layer (`transcript.ts`). Kept
 * structural so this module renders without importing Pi's components, which is
 * what lets the field rendering above stay a pure, directly testable function.
 */
const shortId = (value: string): string => value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
const statusWord = (view: RunView): string =>
  view.status === "running" && view.finalization_pending ? "finishing" : view.status;

/**
 * Joins the two halves of a chrome row. Framed, the space between them is part
 * of the border, so it is drawn as rule: an inlay that stops mid-row leaves the
 * top and bottom of the box open. Docked there is no border to continue, and a
 * rule would read as a divider the pane does not have.
 */
const spanRow = (left: string, right: string, width: number, theme: Theme, rule: boolean): string => {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  // A rule needs the two spaces that keep it off the text; below that, only spaces fit.
  // Framed, the gap is the same accent rule as the rest of the outer edge.
  const filler = rule && gap >= 3 ? ` ${theme.fg("borderAccent", POPOVER.h.repeat(gap - 2))} ` : " ".repeat(gap);
  return truncateToWidth(left + filler + right, width);
};

/** The pane's own title row: who this is and what it is doing right now. */
export function renderDetailTitle(input: DetailInput, spinnerFrame: number, theme: Theme, width: number,
  rule = false): string {
  const { view } = input;
  // The title is one row -- inlaid into the top border when the pane floats, so
  // a line break in it would break the frame, not just the line.
  const name = withoutBreaks(view.name || view.effective_settings.profile);
  // Without a nickname the profile is already the title; repeating it as a tag
  // would label one fact twice, the same way the widget row avoids it.
  const tags = [view.name ? view.effective_settings.profile : ""].filter(Boolean).map(withoutBreaks);
  const running = !terminal(view.status);
  const icon = running ? theme.fg("accent", SPINNER[spinnerFrame % SPINNER.length]!) :
    view.status === "completed" ? theme.fg("success", GLYPHS.success) :
    view.status === "needs_input" ? theme.fg("warning", GLYPHS.question) :
    view.status === "cancelled" ? theme.fg("dim", GLYPHS.stopped) : theme.fg("error", GLYPHS.failure);
  const identity = tags.length ? `${theme.bold(name)} ${theme.fg("dim", `(${tags.join(" · ")})`)}` : theme.bold(name);
  const right = `${icon} ${theme.fg(running ? "accent" : "dim", statusWord(view))}`;
  // The task follows the identity and tags in the title. The widget adds
  // model/signals too; this is not a copy of its whole row. The chrome never
  // scrolls: the `task` field can be scrolled out of the body, and
  // a profile like `reader` names a capability, never the work. It
  // takes only the room the identity and the status leave, so it can crowd out
  // neither -- below that it is dropped rather than shown as an ellipsis.
  const room = width - visibleWidth(identity) - visibleWidth(right) - 6;
  const task = view.description && room >= 12 ?
    `  ${theme.fg("muted", truncateToWidth(withoutBreaks(view.description), room))}` : "";
  return spanRow(identity + task, right, width, theme, rule);
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
  const blank = (): void => { if (out.length && out[out.length - 1] !== "") out.push(""); };

  if (view.description) { field("task", view.description); blank(); }
  field("run", `${shortId(view.run_id)} · agent ${shortId(view.agent_id)}` +
    (view.history_ref ? ` · session ${shortId(view.history_ref.session_id)}` : ""));
  const s = view.effective_settings;
  const resolution = s.thinking_resolution === "preset_fixed" ? "preset fixed" :
    s.thinking_resolution === "preset_mapping" ? `${s.parent_thinking}→${s.thinking} (preset map)` : "parent identity";
  const source = s.effort_source === "user_override" ? "user override" :
    s.effort_source === "preset" ? "preset" : undefined;
  field("routing", `${s.preset}@${s.preset_version} · d${s.difficulty}→${s.strength}`);
  field("effort", `${s.thinking} · ${resolution}${source ? ` · source: ${source}` : ""} · fixed at creation`);
  field("model", s.model);
  field("cwd", s.cwd);
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
  field("deadline", view.execution_elapsed_ms === undefined ?
    `not started · ${formatMs(view.max_duration_ms)} execution limit` :
    `${formatMs(view.execution_elapsed_ms)} / ${formatMs(view.max_duration_ms)} execution (requests stop, not exit)`);
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
  // Reported to the host once, when the Run settles, so it reaches Pi's own
  // footer and cost breakdown rather than vanishing with the child session.
  const spent = reported(u, "cost");
  field("cost", spent === undefined ? "not reported"
    : `${u?.partial.includes("cost") ? "≥ " : ""}${formatCost(spent)}`);
  field("calls", `${live.tool_uses} use${live.tool_uses === 1 ? "" : "s"}` +
    (live.active_tools.length ? ` · ${live.active_tools.length} running` : ""));

  if (live.active_tools.length) {
    blank();
    for (const [i, tool] of live.active_tools.entries()) {
      field(i === 0 ? "active" : "", `${tool.name} ${tool.detail ?? "…"}`, "accent");
    }
  }
  if (live.preview.trim()) { blank(); field("draft", live.preview.trim(), "muted"); }

  // Label, colour, text. Ordered by what stops progress soonest.
  const notes: [string, string, string][] = [];
  if (view.outcome?.question) notes.push(["asked", "warning", view.outcome.question]);
  if (view.outcome?.error) notes.push(["error", "error", view.outcome.error]);
  else if (view.outcome?.reason) notes.push(["reason", "dim", view.outcome.reason]);
  if (view.outcome?.limit_reached) notes.push(["limit", "warning", "stopped at the turn limit"]);
  if (view.unavailable_reason) notes.push(["session", "error", view.unavailable_reason]);
  if (view.owner_error) notes.push(["owner", "error", view.owner_error]);
  if (view.history_error) notes.push(["history", "warning", view.history_error]);
  if (view.pending_messages > 0) notes.push(["queued", "warning", `${view.pending_messages} message(s) waiting for this Run`]);
  if (view.notification_drops > 0) notes.push(["dropped", "error", `${view.notification_drops} notification(s) never reached you`]);
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
      this.options.done();
      return;
    }
    if (!this.options.snapshot().some((entry) => entry.agent_id === agent_id)) return;
    this.adopt(agent_id);
    this.options.tui.requestRender();
  }

  handleInput(data: string): void {
    // Pi's focused-input dispatcher requests an immediate render on return.
    // The 120 ms timer animates live activity; it does not gate keyboard paints.
    if (matchesKey(data, "escape")) {
      this.closed = true;
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
    // Home and End state an intent about the tail; the relative keys infer one.
    if (matchesKey(data, "home")) { this.scrollOffset = 0; this.followTail = false; return; }
    if (matchesKey(data, "end")) { this.scrollOffset = maxScroll; this.followTail = true; return; }
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
    else return;
    this.followTail = this.scrollOffset >= maxScroll;
  }

  /**
   * Wheel over the pane. The alternate-screen renderer offers every wheel event
   * to the overlay under the pointer before it reaches the conversation, and a
   * handled result stops it there, so the page behind never scrolls along.
   * `wheelDelta` is already in logical lines and already carries the terminal's
   * own step -- Alt multiplies it by five upstream -- so it is used as given.
   */
  handleMouse(event: PaneMouseEvent): { handled: boolean } | undefined {
    if (this.options.frame && !this.closed && event.x !== undefined && event.y !== undefined &&
        isPopoverCloseClick({ type: event.type, button: event.button, x: event.x, y: event.y }, this.paintedWidth)) {
      this.closed = true;
      this.options.done();
      return { handled: true };
    }
    if (event.type !== "wheel" || !event.wheelDelta || this.painted === 0) return undefined;
    const { maxScroll } = this.bounds(this.painted);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + event.wheelDelta));
    // Same rule as the keys: reaching the end resumes following the live tail.
    this.followTail = this.scrollOffset >= maxScroll;
    this.options.tui.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    if (width < 12) return [];
    // Floating, the two side columns come out of the body's width.
    const inner = this.options.frame ? width - 2 : width;
    if (inner < 10) return [];
    // Framed, the title and footer are inlaid between the corners, so they get
    // two columns less than the body they sit above and below.
    const chrome = this.options.frame ? inner - 4 : inner;
    if (chrome < 8) return [];
    // Framed, the title shares the top edge with the close control.
    const titleWidth = this.options.frame ? popoverInlayWidth(width, "top", true) : chrome;
    this.paintedWidth = this.options.frame ? width : 0;
    const { entries, index } = this.current();
    const entry = entries[index];
    if (!entry) {
      this.painted = 0; // No visible body for keys/wheel to scroll against.
      return this.dress(this.options.theme.fg("dim", "harness"),
        [truncateToWidth(this.options.theme.fg("dim", "No agents are available to inspect."), inner)],
        this.footer(chrome, 0, 0, 0, 0), width, inner);
    }
    // Fields first, then a rule, then the transcript Pi's own components render.
    const fields = renderDetailFields(entry.input, this.options.theme, inner);
    const rows = this.options.transcript(entry.agent_id);
    const transcript = rows?.lineCount(inner) ?? 0;
    const total = fields.length + 1 + transcript;
    this.painted = total;
    const { viewportHeight, maxScroll } = this.bounds(total);
    // A live transcript grows under the reader; only follow when they are at the end.
    // Clamped, not merely read: a body that SHRANK -- compaction, a resize, an
    // Agent with a shorter transcript -- would otherwise leave the offset above
    // the new maximum, and the next key up would still be `>= maxScroll` and so
    // re-engage following instead of scrolling.
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    if (this.followTail) this.scrollOffset = maxScroll;
    const start = this.scrollOffset;
    return this.dress(renderDetailTitle(entry.input, this.frame, this.options.theme, titleWidth, !!this.options.frame),
      this.window(fields, rows, inner, start, viewportHeight),
      this.footer(chrome, index + 1, entries.length, start + viewportHeight, total), width, inner);
  }

  invalidate(): void {}
  dispose(): void {
    this.closed = true;
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
    out.push(...rows.slice(width, from, remaining).map((row) => truncateToWidth(row, width)));
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
  private bounds(total: number): { viewportHeight: number; maxScroll: number } {
    const cap = Math.floor((this.options.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100) - CHROME_LINES;
    const viewportHeight = Math.max(MIN_VIEWPORT, Math.min(total, cap));
    return { viewportHeight, maxScroll: Math.max(0, total - viewportHeight) };
  }
  private footer(width: number, position: number, count: number, shown: number, total: number): string {
    const th = this.options.theme;
    const left = th.fg("dim", count ? `${position}/${count} agents · ${Math.min(shown, total)}/${total} lines` : "no agents");
    const right = th.fg("dim", "←→ agent · ↑↓ scroll · Esc close");
    return spanRow(left, right, width, th, !!this.options.frame);
  }
}
