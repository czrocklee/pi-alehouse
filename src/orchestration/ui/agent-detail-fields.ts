import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { validDifficulty, type RunView } from "../core/contracts.ts";
import { reported, type UsageComponent } from "../core/usage-ledger.ts";
import { profileLabel } from "../tools/tool-names.ts";
import type { ActiveTool, GenerationPreview } from "../runtime/activity-types.ts";
import { singleLineToolArgumentDisplay } from "../presentation/tool-argument-text.ts";
import {
  contextPercent,
  formatContextPercent,
  formatContextTokens,
  formatCost,
  formatDrain,
  formatMs,
  formatTokens,
  formatTurns,
  generationLine,
  GLYPHS,
  renderActivity,
  shortDisplayPath,
  type Theme,
} from "./format.ts";
import { POPOVER } from "./popover.ts";
import { clipPlainText, singleLineText, wrapPlainText as wrapText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";

/** Label column, so every field's value starts at the same place. */
const LABEL = 10;
const STOP_LABEL = "[S Stop]";
/** While composing, S is draft text: the control stays clickable, keyless. */
const STOP_CLICK_LABEL = "[Stop]";
const CONFIRM_LABEL = "[Confirm stop]";
const CONFIRM_HELP = "best-effort · Ctrl+S · Esc cancel";
const CONFIRM_HINT = `${CONFIRM_HELP} · ${CONFIRM_LABEL}`;

/** A label as wide as its own column would run into the value, so clamp it here
 * rather than trusting every call site to stay short. */
const key = (label: string): string =>
  label.length >= LABEL ? `${label.slice(0, LABEL - 1)} ` : label.padEnd(LABEL);

/** Live child state the pane shows beside the Run projection. */
export interface DetailLive extends GenerationPreview {
  active_tools: readonly ActiveTool[];
  tool_uses: number;
}
export interface DetailInput {
  view: RunView;
  live: DetailLive;
}

/** A heuristic estimate, marked as approximate wherever it is shown. */
const approxContextTokens = (tokens: number | null, unknown: string): string =>
  tokens === null ? unknown : `≈${formatContextTokens(tokens)}`;
const shortId = (value: string): string =>
  value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
/** Busy describes reuse availability, not a session fault. Keep the core fact
 * unchanged while excluding it from both the Info diagnostics and attention. */
const sessionProblem = (view: RunView): string | undefined =>
  view.unavailable_reason === "agent_busy" ? undefined : view.unavailable_reason;
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
const spanRow = (
  left: string,
  right: string,
  width: number,
  theme: Theme,
  rule: boolean,
): string => {
  const rightWidth = visibleWidth(right);
  const gap = Math.max(rightWidth ? 1 : 0, width - visibleWidth(left) - rightWidth);
  // A trailing rule has no right label to separate: run it to the inlay's end,
  // rather than leaving extra spaces beside the frame's close control.
  const tail = rightWidth ? " " : "";
  const filler =
    rule && gap >= 3
      ? ` ${theme.fg("borderAccent", POPOVER.h.repeat(gap - 1 - tail.length))}${tail}`
      : rule && !rightWidth
        ? theme.fg("borderAccent", POPOVER.h.repeat(gap))
        : " ".repeat(gap);
  return truncateToWidth(left + filler + right, width);
};

/** The pane's own title row: identity and task at the left, live status at the
 * right end, so a status change or an Agent switch never shifts the name. The
 * status glyph and the task/Run cue never scroll away; nickname, profile and
 * finally task text yield space first, so Agent reuse cannot leave two
 * different tasks with identical chrome and a settled Run cannot wear a live
 * glyph. Framed, a short rule separates the status from the close control. */
export function renderDetailTitle(
  input: DetailInput,
  spinnerFrame: number,
  theme: Theme,
  width: number,
  rule = false,
): string {
  const { view } = input;
  const state = runPresentation(view.status, spinnerFrame, view.finalization_pending);
  const glyph = theme.fg(state.color, state.glyph);
  const profile = singleLineText(profileLabel(view.effective_settings.profile));
  const name = singleLineText(view.name || profile);
  const task = singleLineText(view.description).trim() || "task";
  const marker =
    Number.isSafeInteger(view.task) && view.task > 0
      ? `#${view.task}`
      : shortId(singleLineText(view.run_id));
  const suffix = ` · ${marker}`;
  const taskFloor = Math.min(8, visibleWidth(task));
  // The gap a framed edge needs to draw at least one rule column between halves.
  const gap = rule ? 3 : 2;
  const end = rule ? ` ${theme.fg("borderAccent", POPOVER.h)}` : "";
  const identity = (nameRoom: number, tag: string): string =>
    theme.bold(clipPlainText(name, Math.max(1, Math.min(32, nameRoom)))) +
    (tag ? theme.fg("dim", tag) : "");
  const taskText = (room: number): string =>
    `${theme.fg("muted", clipPlainText(task, room))}${theme.fg("dim", suffix)}`;
  // Identity yields before the task text, the status label before the identity;
  // the status glyph and the task/Run cue outlast everything else.
  const withIdentity = (status: string, tag: string, minName: number): string | undefined => {
    const room = width - visibleWidth(status) - visibleWidth(end) - gap;
    const nameRoom = room - taskFloor - visibleWidth(suffix) - 2 - visibleWidth(tag);
    if (nameRoom < minName) return undefined;
    const head = identity(nameRoom, tag);
    const taskRoom = room - visibleWidth(head) - 2 - visibleWidth(suffix);
    return taskRoom > 0
      ? spanRow(`${head}  ${taskText(taskRoom)}`, status + end, width, theme, rule)
      : undefined;
  };
  const withoutIdentity = (status: string): string | undefined => {
    const taskRoom = width - visibleWidth(status) - visibleWidth(end) - gap - visibleWidth(suffix);
    if (taskRoom < 1) return undefined;
    return spanRow(taskText(taskRoom), status + end, width, theme, rule);
  };
  const status = (label: string): string => `${glyph} ${theme.fg(state.color, label)}`;
  const tag = view.name ? ` (${profile})` : "";
  return (
    withIdentity(status(state.label), tag, 3) ??
    withIdentity(status(state.label), "", 1) ??
    withIdentity(status(state.compact), tag, 3) ??
    withIdentity(status(state.compact), "", 1) ??
    withoutIdentity(status(state.compact)) ??
    withoutIdentity(glyph) ??
    spanRow(
      truncateToWidth(`${glyph} ${theme.fg("dim", marker)}`, width, "…"),
      "",
      width,
      theme,
      rule,
    )
  );
}

/**
 * Everything the widget's one line cannot hold: identity, configuration,
 * lifecycle, usage, every active tool with its argument, and each stalling
 * condition under its own label. The transcript follows these rows and is
 * rendered by Pi's own components, not here.
 */
export function renderDetailFields(
  input: DetailInput,
  theme: Theme,
  width: number,
  wrap = wrapText,
): string[] {
  const { view, live } = input;
  const inner = Math.max(8, width - LABEL - 2);
  const out: string[] = [];
  const field = (label: string, value: string, color = "text"): void => {
    for (const [i, line] of wrap(value, inner).entries()) {
      out.push(
        truncateToWidth(
          `  ${theme.fg("dim", i === 0 ? key(label) : " ".repeat(LABEL))}` +
            (color === "text" ? line : theme.fg(color, line)),
          width,
        ),
      );
    }
  };
  const lineRoom = Math.max(0, width - LABEL - 2);
  const oneLineField = (
    label: string,
    value: string,
    color = "muted",
    display = singleLineText,
  ): void => {
    out.push(
      theme.fg("dim", clipPlainText(`  ${key(label)}`, Math.max(0, width))) +
        theme.fg(color, clipPlainText(display(value), lineRoom)),
    );
  };
  const blank = (): void => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };

  if (view.description) {
    field("task", view.description);
    blank();
  }
  field(
    "run",
    `${shortId(singleLineText(view.run_id))} · agent ${shortId(singleLineText(view.agent_id))}` +
      (view.history_ref
        ? ` · session ${shortId(singleLineText(view.history_ref.session_id))}`
        : ""),
  );
  const s = view.effective_settings;
  const resolution =
    s.thinking_resolution === "preset_fixed"
      ? "preset fixed"
      : s.thinking_resolution === "automatic_mapping"
        ? `${s.parent_thinking}→${s.thinking} (auto map)`
        : "parent identity";
  const source =
    s.effort_source === "user_override"
      ? "user override"
      : s.effort_source === "preset"
        ? "preset"
        : undefined;
  // New matching slots need no redundant dN→dN; historical routes stay literal.
  // A missing/invalid historical rating cannot acquire an inferred difficulty.
  const route =
    validDifficulty(s.difficulty) && s.strength !== `d${s.difficulty}`
      ? `d${s.difficulty}→${s.strength}`
      : s.strength;
  field("routing", `${s.preset}@${s.preset_version} · ${route}`);
  field(
    "effort",
    `${s.thinking} · ${resolution}${source ? ` · source: ${source}` : ""} · fixed at creation`,
  );
  field("model", s.model);
  field("cwd", s.cwd);
  field("tools", s.tools.join(" "));
  field(
    "phase",
    [view.phase, view.resumable ? "resumable" : "", view.execution_exited ? "exited" : ""]
      .filter(Boolean)
      .join(" · "),
  );
  if (!view.execution_exited && view.drain) field("drain", formatDrain(view.drain), "warning");
  else if (!view.execution_exited && view.runtime) field("activity", view.runtime.activity);
  if (view.model_stop_reason) field("model stop", view.model_stop_reason);
  const context = view.runtime?.context;
  if (context)
    field(
      "context",
      `${approxContextTokens(context.tokens, "unknown")}/` +
        `${formatContextTokens(context.context_window)} tokens · ${formatContextPercent(context)}`,
    );

  blank();
  const clock =
    view.turn_elapsed_ms !== undefined ? ` · this turn ${formatMs(view.turn_elapsed_ms)}` : "";
  field(
    "turns",
    `${formatTurns(view.turns, view.max_turns)}${clock} · total ${formatMs(view.elapsed_ms)}`,
  );
  field(
    "execution",
    view.execution_elapsed_ms === undefined ? "not started" : formatMs(view.execution_elapsed_ms),
  );
  const u = view.usage;
  // `?` is nothing reported at all; `≥` is a real figure that some response
  // left out of, so it is a floor. Collapsing the two would hide either the
  // money that WAS reported or the fact that more of it went unpriced.
  const count = (name: UsageComponent): string => {
    const value = reported(u, name);
    return value === undefined
      ? "?"
      : `${u?.partial.includes(name) ? "≥" : ""}${formatTokens(value, "")}`;
  };
  field(
    "tokens",
    u
      ? `in ${count("input")} · out ${count("output")} · ` +
          `cache r ${count("cache_read")} · w ${count("cache_write")}`
      : "not reported",
  );
  // Observed spend reaches the host through a later tool_result usage hook.
  // Rendering neither drains that accounting nor acknowledges communication.
  const spent = reported(u, "cost");
  field(
    "cost",
    spent === undefined
      ? "not reported"
      : `${u?.partial.includes("cost") ? "≥ " : ""}${formatCost(spent)}`,
  );
  field(
    "calls",
    `${live.tool_uses} use${live.tool_uses === 1 ? "" : "s"}` +
      (live.active_tools.length ? ` · ${live.active_tools.length} running` : ""),
  );

  if (live.active_tools.length) {
    blank();
    for (const [i, tool] of live.active_tools.entries()) {
      const name = singleLineText(tool.name);
      let detail = singleLineToolArgumentDisplay(tool.detail ?? "…");
      if (["read", "edit", "write", "ls"].includes(name)) {
        detail = shortDisplayPath(detail, s.cwd, Math.max(0, lineRoom - visibleWidth(`${name} `)));
      }
      oneLineField(
        i === 0 ? "active" : "",
        `${name} ${detail}`,
        "accent",
        singleLineToolArgumentDisplay,
      );
    }
  }
  if (activityPresentation({ ...view, finishing: view.finalization_pending }).showGeneration) {
    // The native transcript already holds the full streaming message. Keep each
    // supplemental preview to one row, clipping plain text before theme styling.
    const thinking = generationLine(live.thinking ?? ""),
      draft = generationLine(live.preview);
    if (thinking) {
      blank();
      oneLineField("thinking", thinking);
    }
    if (draft) {
      blank();
      oneLineField("draft", draft);
    }
    if (live.preparing_tool !== undefined) {
      blank();
      oneLineField("preparing", singleLineText(live.preparing_tool) || "tool");
    }
  }

  // Label, colour, text. Ordered by what stops progress soonest.
  const notes: [string, string, string][] = [];
  if (view.outcome?.question) notes.push(["asked", "warning", view.outcome.question]);
  if (view.outcome?.error) notes.push(["error", "error", view.outcome.error]);
  else if (view.outcome?.reason) notes.push(["reason", "dim", view.outcome.reason]);
  if (view.outcome?.limit_reached) notes.push(["limit", "warning", "stopped at the turn limit"]);
  for (const note of view.dispatch_notes ?? [])
    notes.push(["dispatch", "warning", DISPATCH_NOTES.get(note) ?? note]);
  const unavailable = sessionProblem(view);
  if (unavailable) notes.push(["session", "error", unavailable]);
  if (view.owner_error) notes.push(["owner", "error", view.owner_error]);
  if (view.history_error) notes.push(["history", "warning", view.history_error]);
  if (view.pending_messages > 0)
    notes.push([
      "pending",
      "warning",
      `${view.pending_messages} alert(s) from this Run awaiting local presentation`,
    ]);
  for (const note of view.cleanup_errors) notes.push(["cleanup", "error", note]);
  for (const note of view.discarded_inputs) notes.push(["discarded", "warning", note]);
  // Admission only, as in the attention rows; Info lists every attention fact.
  if (view.human_steered) notes.push(["steer", "dim", "human steer admitted"]);
  if (notes.length) {
    blank();
    for (const [label, color, text] of notes) field(label, text, color);
  }

  return out;
}

interface SummarySegment {
  key: string;
  text: string;
  color: string;
}

/** Compact live metrics for the pane's pinned header: one metrics row plus at
 * most one bounded activity row. The task lives in the title, so it is not
 * repeated here. Figures drop from the least urgent end when the row is
 * narrow; a figure some response left out stays a floor (`≥`), never zero.
 * `options.activity === false` skips the activity row entirely for callers
 * that have not allocated a row for it; the metrics row is unchanged. */
export function renderDetailSummary(
  input: DetailInput,
  theme: Theme,
  width: number,
  options: { activity?: boolean } = {},
): string[] {
  const { view, live } = input;
  const s = view.effective_settings;
  const segments: SummarySegment[] = [];
  const model = [singleLineText(s.model), singleLineText(s.thinking)].filter(Boolean).join("/");
  if (model) segments.push({ key: "model", text: model, color: "dim" });
  segments.push({
    key: "turns",
    text: formatTurns(view.turns, view.max_turns),
    color: view.max_turns > 0 && view.turns / view.max_turns >= 0.8 ? "warning" : "dim",
  });
  if (live.tool_uses > 0)
    segments.push({ key: "calls", text: `${GLYPHS.toolCall}${live.tool_uses}`, color: "dim" });
  const context = view.runtime?.context;
  const percent = contextPercent(context);
  if (context)
    segments.push({
      key: "ctx",
      text: `ctx ${approxContextTokens(context.tokens, "?")}/${formatContextTokens(context.context_window)}`,
      color:
        percent === undefined ? "dim" : percent >= 90 ? "error" : percent >= 70 ? "warning" : "dim",
    });
  const spent = reported(view.usage, "cost");
  if (spent !== undefined)
    segments.push({
      key: "cost",
      text: `${view.usage?.partial.includes("cost") ? "≥" : ""}${formatCost(spent)}`,
      color: "dim",
    });
  segments.push({ key: "elapsed", text: formatMs(view.elapsed_ms), color: "dim" });
  const total = (list: readonly SummarySegment[]): number =>
    list.reduce((sum, segment, index) => sum + visibleWidth(segment.text) + (index ? 3 : 0), 0);
  // Retention hierarchy, explicit: elevated context/turn pressure first, the
  // routine model/effort figure next, then the remaining routine figures
  // least-urgent first. Elevated pressure therefore outlasts the model name.
  const elevated = (key: string): boolean =>
    (key === "ctx" && (percent ?? 0) >= 70) ||
    (key === "turns" && view.max_turns > 0 && view.turns / view.max_turns >= 0.8);
  let kept = [...segments];
  const fits = (): boolean => total(kept) <= width;
  const drop = (key: string): void => {
    kept = kept.filter((segment) => segment.key !== key);
  };
  for (const key of ["elapsed", "cost", "calls", "ctx", "turns", "model"] as const) {
    if (fits()) break;
    if (kept.length <= 1) break;
    if (elevated(key)) continue;
    drop(key);
  }
  // An elevated context figure compacts to its whole percent before it
  // yields, so a narrow row keeps the real pressure instead of losing it.
  if (!fits() && percent !== undefined)
    kept = kept.map((segment) =>
      segment.key === "ctx" && (percent ?? 0) >= 70
        ? { ...segment, text: `ctx ${Math.round(percent)}%` }
        : segment,
    );
  for (const key of ["ctx", "turns"] as const) {
    if (fits()) break;
    if (kept.length <= 1) break;
    if (!elevated(key)) continue;
    drop(key);
  }
  const metrics =
    kept.length === 1 && total(kept) > width
      ? theme.fg(kept[0]!.color, clipPlainText(kept[0]!.text, width))
      : kept.map((segment) => theme.fg(segment.color, segment.text)).join(theme.fg("dim", " · "));
  const out = [metrics];
  if (options.activity === false) return out;
  // One bounded activity row, never the full streaming text: the transcript
  // below already holds it, and actual running tools stay observable even
  // while finishing or draining.
  const presentation = activityPresentation({ ...view, finishing: view.finalization_pending });
  if (live.active_tools.length || presentation.showGeneration)
    out.push(renderActivity(live.active_tools, live, theme, width));
  return out;
}

/** One operator-facing attention fact. `severity` classifies the fact for tab
 * markers: a question or an informational admission is never a warning `!`. */
export interface DetailAttentionNote {
  key: string;
  priority: number;
  glyph: string;
  color: string;
  text: string;
  severity?: "error" | "warning" | "question" | "info";
}

/** The pure attention collection, ordered by what blocks progress soonest.
 * One source for the attention rows, the agent-tab markers and the caller's
 * own overflow counts, so their predicates cannot drift apart. Collecting a
 * note is a projection only: it acknowledges and consumes nothing. */
export function getDetailAttentionNotes(input: DetailInput): readonly DetailAttentionNote[] {
  const { view } = input;
  const notes: DetailAttentionNote[] = [];
  if (view.outcome?.question)
    notes.push({
      key: "asked",
      priority: 1,
      glyph: GLYPHS.question,
      color: "warning",
      text: `asked: ${view.outcome.question}`,
      severity: "question",
    });
  if (view.outcome?.error)
    notes.push({
      key: "error",
      priority: 2,
      glyph: GLYPHS.failure,
      color: "error",
      text: `error: ${view.outcome.error}`,
      severity: "error",
    });
  if (view.owner_error)
    notes.push({
      key: "owner",
      priority: 3,
      glyph: GLYPHS.failure,
      color: "error",
      text: `owner: ${view.owner_error}`,
      severity: "error",
    });
  const unavailable = sessionProblem(view);
  if (unavailable)
    notes.push({
      key: "session",
      priority: 4,
      glyph: GLYPHS.failure,
      color: "error",
      text: `session: ${unavailable}`,
      severity: "error",
    });
  for (const error of view.cleanup_errors)
    notes.push({
      key: "cleanup",
      priority: 5,
      glyph: GLYPHS.failure,
      color: "error",
      text: `cleanup: ${error}`,
      severity: "error",
    });
  if (!view.execution_exited && view.drain)
    notes.push({
      key: "drain",
      priority: 6,
      glyph: "!",
      color: "warning",
      text: formatDrain(view.drain),
      severity: "warning",
    });
  if (view.outcome?.limit_reached)
    notes.push({
      key: "turn-limit",
      priority: 7,
      glyph: "!",
      color: "warning",
      text: "stopped at the turn limit",
      severity: "warning",
    });
  if (view.history_error)
    notes.push({
      key: "history",
      priority: 8,
      glyph: "!",
      color: "warning",
      text: `history: ${view.history_error}`,
      severity: "warning",
    });
  if (view.pending_messages > 0)
    notes.push({
      key: "pending-alerts",
      priority: 9,
      glyph: "!",
      color: "warning",
      text: `${view.pending_messages} alert(s) awaiting presentation`,
      severity: "warning",
    });
  for (const note of view.dispatch_notes ?? [])
    notes.push({
      key: "dispatch",
      priority: 10,
      glyph: "!",
      color: "warning",
      text: DISPATCH_NOTES.get(note) ?? note,
      severity: "warning",
    });
  for (const note of view.discarded_inputs)
    notes.push({
      key: "discarded",
      priority: 11,
      glyph: "!",
      color: "warning",
      text: `discarded: ${note}`,
      severity: "warning",
    });
  // Admission only: a human steer was accepted into the input path, never
  // that it was delivered or answered.
  if (view.human_steered)
    notes.push({
      key: "human-steer",
      priority: 12,
      glyph: GLYPHS.success,
      color: "dim",
      text: "human steer admitted",
      severity: "info",
    });
  return notes
    .map((note, order) => ({ note, order }))
    .sort((a, b) => a.note.priority - b.note.priority || a.order - b.order)
    .map((entry) => entry.note);
}

export interface DetailAttentionOptions {
  /** Info is already open: overflow counts must not advertise opening it. */
  info?: boolean;
  /** Rows painted before the rest are counted; the default is two, zero none. */
  maxRows?: number;
  /** An already-collected base collection, e.g. getDetailAttentionNotes(input). */
  notes?: readonly DetailAttentionNote[];
  /** Transient facts merged after the base collection at equal priority. */
  extraNotes?: readonly DetailAttentionNote[];
}

/** At most `maxRows` (default two) bounded single-line rows for what the
 * operator must not miss, ordered by what blocks progress soonest. Notes
 * beyond the last shown row are counted (`+N`), with the Info key only when
 * that page is not already open; with zero rows the caller presents that cue from the
 * collected notes. Rendering a note is a projection only: it acknowledges
 * and consumes nothing. */
export function renderDetailAttention(
  input: DetailInput,
  theme: Theme,
  width: number,
  options: DetailAttentionOptions = {},
): string[] {
  const base = options.notes ?? getDetailAttentionNotes(input);
  const ordered = [...base, ...(options.extraNotes ?? [])]
    .map((note, order) => ({ note, order }))
    .sort((a, b) => a.note.priority - b.note.priority || a.order - b.order)
    .map((entry) => entry.note);
  const shown = ordered.slice(0, Math.max(0, options.maxRows ?? 2));
  const hidden = ordered.length - shown.length;
  if (!shown.length) return [];
  const plain = (note: DetailAttentionNote): string => singleLineText(`${note.glyph} ${note.text}`);
  return shown.map((note, index) => {
    const last = index === shown.length - 1;
    // The hidden-note counter yields its wording before the note text does,
    // but the count itself stays as long as one column of text remains.
    const suffixes =
      hidden > 0 && last
        ? [
            ...(!options.info ? [` · +${hidden} · I info`, ` +${hidden} · I info`] : []),
            ` · +${hidden}`,
            ` +${hidden}`,
            "",
          ]
        : [""];
    for (const suffix of suffixes) {
      const room = width - visibleWidth(suffix);
      if (room >= 4)
        return theme.fg(note.color, clipPlainText(plain(note), room)) + theme.fg("dim", suffix);
    }
    return theme.fg(note.color, clipPlainText(plain(note), width));
  });
}

/** The complete low-frequency fields view, laid out as two balanced columns
 * when the pane is wide and the existing single column otherwise. Wrapping, so
 * no field's data is truncated away; this is a separately scrollable page.
 * The optional `wrap` callback is the caller's own bounded wrapping cache, the
 * same seam renderDetailFields exposes; pass nothing for the default. */
export function renderDetailInfo(
  input: DetailInput,
  theme: Theme,
  width: number,
  wrap = wrapText,
): string[] {
  if (!(width >= 110)) return renderDetailFields(input, theme, width, wrap);
  const column = Math.floor((width - 2) / 2);
  const rows = renderDetailFields(input, theme, column, wrap);
  if (rows.length < 2) return rows;
  // Split on the group boundary nearest the middle, so each column starts at
  // a field group rather than mid-group.
  const half = rows.length / 2;
  let split = -1;
  for (let i = 1; i < rows.length; i++)
    if (rows[i] === "" && (split === -1 || Math.abs(i - half) < Math.abs(split - half))) split = i;
  const left = split === -1 ? rows.slice(0, Math.ceil(rows.length / 2)) : rows.slice(0, split);
  const right = split === -1 ? rows.slice(Math.ceil(rows.length / 2)) : rows.slice(split + 1);
  if (!right.length) return rows;
  const out: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const first = left[i] ?? "";
    out.push(
      first + " ".repeat(Math.max(0, column - visibleWidth(first))) + "  " + (right[i] ?? ""),
    );
  }
  return out;
}

export interface DetailAgentStripItem {
  agent_id: string;
  from: number;
  to: number;
}
export interface DetailAgentStrip {
  text: string;
  items: DetailAgentStripItem[];
  /** Not even the selected tab fit whole beside its summaries: it was clipped. */
  clipped?: boolean;
  /** The text begins and ends in a tab's own padding space, not an arrow. */
  padded?: boolean;
  /** The selected tab's own `?`/`!` marker is actually painted, not just
   * implied by its attention facts: the footer's `!N` cue may not repeat it
   * only while this is true. */
  markerVisible?: boolean;
}

/** One tab never claims more than this, so a long nickname cannot crowd out peers. */
const TAB_LABEL_MAX = 16;

/**
 * The agent tabs, painted only when there is more than one agent. Each tab is
 * padded by a space on either side, and its click range includes that padding.
 * On a frame edge the tabs are joined by rule; docked their padding alone
 * separates them. The selected tab is always visible, with an accent, bold,
 * optionally underlined nickname and no background fill; hidden peers are
 * summarized as clickable `+N` with
 * attention counts, and optional `‹ ›` step to the previous/next Agent. Hit
 * ranges are relative to the returned text, so the caller adds its own offsets.
 */
export function renderDetailAgentStrip(input: {
  entries: readonly { agent_id: string; input: DetailInput }[];
  selected: string;
  width: number;
  spinnerFrame: number;
  theme: Theme;
  /** On a border the joins are rule; docked, the tabs' own padding separates them. */
  framed?: boolean;
  /** Paint `‹ ›` previous/next controls at the ends. */
  arrows?: boolean;
  /** Only the selected tab, every peer summarized: an armed Stop names one target. */
  collapse?: boolean;
}): DetailAgentStrip {
  const { entries, selected, width, spinnerFrame, theme } = input;
  if (entries.length <= 1 || !(width >= 1)) return { text: "", items: [], markerVisible: false };
  const tabs = entries.map((entry) => {
    const view = entry.input.view;
    const state = runPresentation(view.status, spinnerFrame, view.finalization_pending);
    // One collection decides both the attention rows and the tab markers, so
    // a draining or errored peer can never lose its `!` to predicate drift.
    const notes = getDetailAttentionNotes(entry.input);
    const question = notes.some((note) => note.severity === "question");
    const warning = notes.some((note) => note.severity === "error" || note.severity === "warning");
    return {
      agent_id: entry.agent_id,
      glyph: state.glyph,
      color: state.color,
      label: clipPlainText(
        singleLineText(view.name || profileLabel(view.effective_settings.profile)),
        TAB_LABEL_MAX,
      ),
      question,
      warning,
      marker: (question ? "?" : "") + (warning ? "!" : ""),
      selected: entry.agent_id === selected,
    };
  });
  type Tab = (typeof tabs)[number];
  const n = tabs.length;
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.selected),
  );
  const unit = (tab: Tab): string =>
    ` ${tab.glyph} ${tab.label}${tab.marker ? ` ${tab.marker}` : ""} `;
  const widths = tabs.map((tab) => visibleWidth(unit(tab)));
  const summary = (hidden: readonly Tab[]): string => {
    const questions = hidden.filter((tab) => tab.question).length;
    const warnings = hidden.filter((tab) => tab.warning).length;
    return ` +${hidden.length}${questions ? ` ?${questions}` : ""}${warnings ? ` !${warnings}` : ""} `;
  };
  const join = input.framed ? 1 : 0;
  const arrows = input.arrows ? 2 : 0;
  const windowWidth = (start: number, end: number): number => {
    const parts = widths.slice(start, end + 1);
    if (start > 0) parts.push(visibleWidth(summary(tabs.slice(0, start))));
    if (end < n - 1) parts.push(visibleWidth(summary(tabs.slice(end + 1))));
    return parts.reduce((sum, part) => sum + part, 0) + join * (parts.length - 1) + arrows;
  };
  const found = (() => {
    if (input.collapse)
      return windowWidth(selectedIndex, selectedIndex) <= width
        ? { start: selectedIndex, end: selectedIndex }
        : undefined;
    if (windowWidth(0, n - 1) <= width) return { start: 0, end: n - 1 };
    // Prefer the widest window in stable order: farthest end first, then the
    // earliest start that still fits beside it.
    for (let end = n - 1; end >= selectedIndex; end--)
      for (let start = 0; start <= selectedIndex; start++)
        if (windowWidth(start, end) <= width) return { start, end };
    return undefined;
  })();
  const selectedText = (text: string): string => {
    const bold = theme.bold(text);
    return theme.underline ? theme.underline(bold) : bold;
  };
  const paintName = (tab: Tab, label: string): string =>
    !label ? "" : tab.selected ? selectedText(theme.fg("accent", label)) : theme.fg("muted", label);
  // Glyph-only clipping still identifies the selection without repainting its
  // lifecycle color. Markers and padding never inherit the name's underline.
  const paintGlyph = (tab: Tab, selectedOnly = false): string => {
    const glyph = theme.fg(tab.color, tab.glyph);
    return selectedOnly && tab.selected ? selectedText(glyph) : glyph;
  };
  if (!found) {
    // Not even the selected tab fits whole beside its summaries: clip it alone,
    // and keep its hit range inside what was actually painted. The glyph
    // stays first, then the `?`/`!` marker, then whatever label columns
    // remain: a question or warning outranks the nickname, so the clipped
    // tab keeps the cue the footer's `!N` suppression counts on. The marker
    // keeps the whole strip's semantics -- `?` warning-coloured, `!`
    // error-coloured -- so neither the glyph's lifecycle colour nor the
    // selected nickname's accent can repaint a warning as success.
    const tab = tabs[selectedIndex]!;
    const marker = tab.marker ? ` ${tab.marker}` : "";
    // Styled only where it is painted, so an unpainted marker styles nothing.
    const markerStyled = (): string =>
      ` ${tab.question ? theme.fg("warning", "?") : ""}${
        tab.warning ? theme.fg("error", "!") : ""
      }`;
    const budget = Math.max(0, width - 2);
    const markerWidth = visibleWidth(marker);
    const labelRoom = budget - 2 - markerWidth;
    // The glyph is a fixed, single-cell lifecycle symbol. Split only that
    // known plain prefix, after cell-aware clipping, to preserve every old
    // padding/hit column while styling the nickname separately.
    const unmarked = clipPlainText(`${tab.glyph} ${tab.label}`, budget);
    const tail = unmarked.slice(tab.glyph.length);
    const space = tail.startsWith(" ") ? " " : "";
    const label = tail.slice(space.length);
    const tiny = clipPlainText(`${tab.glyph}${marker}`, budget);
    const text =
      width < 4
        ? paintGlyph(tab, true)
        : !marker
          ? ` ${paintGlyph(tab, !label)}${space}${paintName(tab, label)} `
          : labelRoom >= 1
            ? ` ${paintGlyph(tab)} ${paintName(tab, clipPlainText(tab.label, labelRoom))}${markerStyled()} `
            : budget >= 1 + markerWidth
              ? ` ${paintGlyph(tab, true)}${markerStyled()} `
              : ` ${paintGlyph(tab, true)}${theme.fg(tab.color, tiny.slice(tab.glyph.length))} `;
    return {
      text,
      items: text ? [{ agent_id: tab.agent_id, from: 0, to: visibleWidth(text) }] : [],
      clipped: true,
      padded: width >= 4,
      markerVisible: !!marker && width >= 4 && budget >= 1 + markerWidth,
    };
  }
  const elements: { text: string; agent_id: string }[] = [];
  if (found.start > 0)
    elements.push({
      text: theme.fg("dim", summary(tabs.slice(0, found.start))),
      agent_id: tabs[found.start - 1]!.agent_id,
    });
  for (let i = found.start; i <= found.end; i++) {
    const tab = tabs[i]!;
    elements.push({
      text:
        " " +
        paintGlyph(tab) +
        " " +
        paintName(tab, tab.label) +
        (tab.marker
          ? " " +
            (tab.question ? theme.fg("warning", "?") : "") +
            (tab.warning ? theme.fg("error", "!") : "")
          : "") +
        " ",
      agent_id: tab.agent_id,
    });
  }
  if (found.end < n - 1)
    elements.push({
      text: theme.fg("dim", summary(tabs.slice(found.end + 1))),
      agent_id: tabs[found.end + 1]!.agent_id,
    });
  if (input.arrows) {
    elements.unshift({
      text: theme.fg("dim", "‹"),
      agent_id: tabs[(selectedIndex - 1 + n) % n]!.agent_id,
    });
    elements.push({
      text: theme.fg("dim", "›"),
      agent_id: tabs[(selectedIndex + 1) % n]!.agent_id,
    });
  }
  const separator = input.framed ? theme.fg("borderAccent", POPOVER.h) : "";
  const items: DetailAgentStripItem[] = [];
  let text = "";
  let offset = 0;
  for (const [index, element] of elements.entries()) {
    // The arrows sit flush against the padded tabs beside them.
    const arrow = input.arrows && (index === 1 || index === elements.length - 1);
    if (index && !arrow) {
      text += separator;
      offset += join;
    }
    const from = offset;
    text += element.text;
    offset += visibleWidth(element.text);
    items.push({ agent_id: element.agent_id, from, to: offset });
  }
  // The selected tab is always inside the window, so its marker is painted
  // exactly when it has one.
  return {
    text,
    items,
    padded: !input.arrows,
    markerVisible: tabs[selectedIndex]!.marker !== "",
  };
}

/** A plain divider sized to the width. It spans the whole row: stopping short
 * of the right edge reads as a frayed rule beside a frame that does reach it.
 * The label is sanitized like every other chrome fragment. */
export function transcriptRule(theme: Theme, width: number, label = "transcript"): string {
  const head = `${POPOVER.h}${POPOVER.h} ${singleLineText(label)} `;
  return truncateToWidth(
    theme.fg("borderMuted", head + POPOVER.h.repeat(Math.max(0, width - visibleWidth(head)))),
    width,
  );
}

export interface DetailRuleItem {
  kind: "transcript" | "info" | "tools";
  from: number;
  to: number;
}

type DetailControlPart = { text: string; width: number; kind?: DetailRuleItem["kind"] };
interface DetailControlOptions {
  theme: Theme;
  info: boolean;
  toolsExpanded: boolean;
  hiddenNotes?: number;
  keys: boolean;
}

/** Both header layouts paint the same labels, keys and attention count. */
function detailControlParts(input: DetailControlOptions) {
  const { theme: th, info, keys } = input;
  const hidden = input.hiddenNotes && input.hiddenNotes > 0 ? input.hiddenNotes : 0;
  const page = (label: string, active: boolean, key: boolean): string => {
    const style = (text: string): string =>
      active ? th.bold(th.fg("muted", text)) : th.fg("dim", text);
    return key && keys ? th.fg("accent", label[0]!) + style(label.slice(1)) : style(label);
  };
  const transcript: DetailControlPart = {
    text: page("Transcript", !info, false),
    width: 10,
    kind: "transcript",
  };
  const infoPart: DetailControlPart = {
    text: page("Info", info, true) + (hidden ? th.fg("warning", ` +${hidden}`) : ""),
    width: 4 + (hidden ? visibleWidth(` +${hidden}`) : 0),
    kind: "info",
  };
  const dot: DetailControlPart = { text: th.fg("dim", " · "), width: 3 };
  const state = input.toolsExpanded ? "expanded" : "collapsed";
  const tools = (long: boolean): DetailControlPart => ({
    text: page("Tools", false, true) + (long ? th.fg("dim", ` ${state}`) : ""),
    width: 5 + (long ? 1 + state.length : 0),
    kind: "tools",
  });
  return { hidden, transcript, infoPart, dot, tools };
}

/** Merge complete metrics with right-aligned body controls only when both fit.
 * A dim, isolated vertical separator belongs to the controls, with two spaces
 * on each side and any remaining space before it. Narrow rows retain the old
 * separate section-rule layout rather than sacrificing another metric. Reserve
 * the full Transcript group and longest Tools state on both pages, so switching
 * page/state cannot move a control or change the merge decision. */
export function renderDetailToolbar(
  input: DetailControlOptions & { metrics: string; width: number },
): { text: string; items: DetailRuleItem[]; divider: string } | undefined {
  const { theme, width, metrics } = input;
  if (!Number.isInteger(width) || width < 1) return undefined;
  const { transcript, infoPart, dot, tools } = detailControlParts(input);
  const toolsWidth = Math.max("Tools collapsed".length, "Tools expanded".length);
  const parts = [transcript, dot, infoPart, { text: "   ", width: 3 }];
  if (input.info) parts.push({ text: " ".repeat(toolsWidth), width: toolsWidth });
  else {
    const tool = tools(true);
    // The visible label owns its hit range; reserved blank cells do not.
    const padding = toolsWidth - tool.width;
    parts.push(tool, { text: " ".repeat(padding), width: padding });
  }
  const rightWidth = parts.reduce((sum, part) => sum + part.width, 0);
  const gap = width - visibleWidth(metrics) - rightWidth;
  if (gap < 5) return undefined;
  const items: DetailRuleItem[] = [];
  let offset = width - rightWidth;
  for (const part of parts) {
    if (part.kind) items.push({ kind: part.kind, from: offset, to: offset + part.width });
    offset += part.width;
  }
  return {
    text:
      metrics +
      " ".repeat(gap - 3) +
      theme.fg("borderMuted", "│") +
      "  " +
      parts.map((part) => part.text).join(""),
    items,
    divider: theme.fg("borderMuted", POPOVER.h.repeat(width)),
  };
}

/**
 * The divider between the fields and the body, carrying the body's own
 * controls: `Transcript · Info` (the page shown is brighter) at the left and
 * the tools-expansion state at the right. Live keys are accented by their
 * letter, I on Info and T on Tools -- never the T of Transcript, which T does
 * not select. While a draft owns the keyboard those letters are text, so the
 * accents go. Attention notes that have no pinned row are counted as `Info +N`.
 * Hit ranges are relative to the returned text.
 */
export function renderDetailRule(input: {
  theme: Theme;
  width: number;
  info: boolean;
  toolsExpanded: boolean;
  hiddenNotes?: number;
  keys: boolean;
}): { text: string; items: DetailRuleItem[] } {
  const { theme: th, width, info } = input;
  const { hidden, transcript, infoPart, dot, tools } = detailControlParts(input);
  const rule = (count: number): string => th.fg("borderMuted", POPOVER.h.repeat(count));
  type Part = DetailControlPart;
  const compose = (
    left: Part[],
    right: Part | undefined,
  ): ReturnType<typeof renderDetailRule> | undefined => {
    const leftWidth = left.reduce((sum, part) => sum + part.width, 0);
    const fill = width - 3 - leftWidth - 1 - (right ? 1 + right.width + 3 : 0);
    if (fill < (right ? 2 : 1)) return undefined;
    const items: DetailRuleItem[] = [];
    let text = rule(2) + " ";
    let offset = 3;
    for (const part of [...left, undefined, ...(right ? [right] : [])]) {
      if (!part) {
        text += " " + rule(fill) + (right ? " " : "");
        offset += 1 + fill + (right ? 1 : 0);
        continue;
      }
      if (part.kind) items.push({ kind: part.kind, from: offset, to: offset + part.width });
      text += part.text;
      offset += part.width;
    }
    if (right) text += " " + rule(2);
    return { text, items };
  };
  const full = [transcript, dot, infoPart];
  // Compact keeps the page that is already shown; hidden notes are the one
  // exception, keeping Info because it is the page that lists them.
  const compact = info || hidden ? [infoPart] : [transcript];
  const tool = info ? [] : [tools(true), tools(false)];
  for (const right of tool) {
    const done = compose(full, right);
    if (done) return done;
  }
  return (
    compose(full, undefined) ??
    compose(compact, undefined) ?? {
      text: transcriptRule(
        th,
        width,
        info || hidden ? `Info${hidden ? ` +${hidden}` : ""}` : "Transcript",
      ),
      items: [],
    }
  );
}

export interface DetailFooterAction {
  kind: "stop" | "confirm";
  from: number;
  to: number;
}
export interface DetailFooterMessageAction {
  kind: "message";
  from: number;
  to: number;
}
/** Footer chrome only. The pane alone stores, expires, and clears actions. */
export interface DetailFooterFrame {
  text: string;
  action?: DetailFooterAction;
  messageAction?: DetailFooterMessageAction;
  /** Agent tabs, `+N` summaries and `‹ ›`, each naming the Agent a click selects. */
  tabs?: DetailAgentStripItem[];
  /** `↓ N more`: a click jumps to the tail and resumes following. */
  tail?: { from: number; to: number };
  /** The text begins/ends in rule (or a padded tab): the frame's pad column
   * beside it is drawn as rule, so the edge meets each corner unbroken. */
  flush?: { start?: boolean; end?: boolean };
}

/** Message mode replaces the footer with one input row; nothing else moves.
 * The hint yields whole before the input does. A stale target keeps the text
 * on screen but says plainly that Enter no longer sends it. */
export function renderComposeFooter(input: {
  width: number;
  input: (room: number) => string;
  sendable: boolean;
  /** Enter refused an empty/whitespace draft; retained until its next edit. */
  empty?: boolean;
  /** The trimmed draft exceeds what one human message may carry. */
  tooLong?: boolean;
  /** Attention without space for either a pinned row or section rule. */
  hiddenNotes?: number;
  /** The retained input cannot currently submit in the painted geometry. */
  unavailable?: "geometry";
  theme: Theme;
}): string {
  const { width, theme: th } = input;
  const cue =
    input.hiddenNotes && input.hiddenNotes > 0
      ? th.fg("warning", clipPlainText(`!${input.hiddenNotes}`, Math.max(0, width - 2))) + " "
      : "";
  const available = width - visibleWidth(cue);
  const hints =
    input.unavailable === "geometry"
      ? ["pane too small · Esc discard", "too small · Esc", ""]
      : !input.sendable
        ? ["task no longer running · Esc cancel", "not running · Esc", ""]
        : input.tooLong
          ? ["message too long · Esc cancel", "too long · Esc", "too long"]
          : input.empty
            ? ["message is empty · Esc cancel", "empty · Esc", "empty"]
            : ["Enter send · Esc cancel", "Enter · Esc", ""];
  const refused = !input.sendable || !!input.empty || !!input.tooLong;
  const hint =
    hints.find(
      (text) =>
        !text || available - visibleWidth(text) - 2 >= (input.empty || input.tooLong ? 1 : 16),
    ) ?? "";
  const room = hint ? available - visibleWidth(hint) - 2 : available;
  const row = cue + input.input(room);
  return hint ? `${row}  ${th.fg(refused ? "warning" : "dim", hint)}` : row;
}

/** The compose heading row above the input: who is being steered, and what
 * Enter/Esc do. The input itself is the caller's own full-width body row. */
export function renderDetailComposeHeading(input: {
  width: number;
  name: string;
  task?: number;
  sendable: boolean;
  /** Enter refused an empty/whitespace draft; retained until its next edit. */
  empty?: boolean;
  /** The trimmed draft exceeds what one human message may carry. */
  tooLong?: boolean;
  theme: Theme;
}): string {
  const { width, theme: th } = input;
  const name = singleLineText(input.name);
  const task = input.task;
  const marker =
    typeof task === "number" && Number.isSafeInteger(task) && task > 0 ? ` #${task}` : "";
  const hints = !input.sendable
    ? ["task ended · Esc discard", "ended · Esc", "Esc"]
    : input.tooLong
      ? ["message too long · Esc discard", "too long · Esc", "too long"]
      : input.empty
        ? ["message is empty · Esc discard", "empty · Esc", "empty"]
        : ["Enter send · Esc discard", "Enter · Esc", ""];
  const hint = hints.find((text) => width - visibleWidth(text) - 2 >= 8) ?? hints.at(-1)!;
  const room = width - visibleWidth(hint) - 2;
  const left =
    room >= 8 + visibleWidth(marker) + Math.min(visibleWidth(name), 32)
      ? `${th.fg("dim", "Steer")} ${th.bold(name)}${marker ? th.fg("dim", marker) : ""}`
      : th.fg("dim", clipPlainText(`Steer ${name}${marker}`, Math.max(1, room)));
  return spanRow(
    left,
    th.fg(input.sendable && !input.empty && !input.tooLong ? "dim" : "warning", hint),
    width,
    th,
    false,
  );
}

/** Pure bottom-edge layout. Confirmation lifetime and painted hit geometry stay with the pane.
 *
 * The edge is the pane's navigation and action bar in one row: agent tabs at
 * the left, and at the right the jump back to the tail (`↓ N more`), then
 * `[M message]` and `[S Stop]`, Stop always outermost. Counters, the scroll
 * position, following and the static key legend are not repeated here: the
 * tabs, the scrollbar, the section rule and the close control already say
 * them. Docked, with no close control, an `Esc` hint precedes the actions.
 *
 * Under width pressure the parts yield in a fixed order: peer tabs fold into
 * `+N` first, then the `‹ ›` arrows, then the tail cue (framed, where the
 * scrollbar also shows position) or `[M message]` (docked, where the cue is
 * the only position left), and finally the other of those two. The selected
 * tab and an available Stop/confirmation never yield. Every hit range is in
 * pane columns, including the frame's `╰─ ` offset.
 */
export function renderDetailFooter(input: {
  width: number;
  entries: readonly { agent_id: string; input: DetailInput }[];
  selected: string;
  /** Body rows below the viewport; a positive count offers the jump to the tail. */
  below: number;
  /** The body below is still growing (a live Run's transcript). */
  live?: boolean;
  view: RunView | undefined;
  available: boolean;
  confirming: boolean;
  /** The shown Run accepts a human message; advertises the M key. */
  messaging?: boolean;
  /** A draft owns the keyboard: M/S/←/→ are text, so only clicks remain. */
  composing?: boolean;
  /** Attention notes hidden because no row and no section rule could present
   * them. The selected tab's own `?`/`!` marker already flags them; with no
   * marker to carry them, a `!N` cue leads the edge instead. */
  hiddenNotes?: number;
  spinnerFrame: number;
  theme: Theme;
  framed: boolean;
}): DetailFooterFrame {
  const {
    width,
    entries,
    selected,
    below,
    view,
    available,
    confirming,
    messaging,
    composing,
    hiddenNotes,
    spinnerFrame,
    theme: th,
    framed,
  } = input;
  const base = framed ? 3 : 0;
  const multi = entries.length > 1;
  const offerMessage = !!messaging && !composing && !confirming;
  const entry = entries.find((candidate) => candidate.agent_id === selected);
  const marked =
    multi &&
    !!entry &&
    getDetailAttentionNotes(entry.input).some(
      (note) =>
        note.severity === "question" || note.severity === "error" || note.severity === "warning",
    );
  // The `!N` cue repeats what the selected tab's own `?`/`!` marker says --
  // but only if that marker is actually painted. A clipped strip can drop
  // it, so the choice below re-runs with the cue forced when it did.
  const cueText = (force: boolean): string =>
    hiddenNotes && hiddenNotes > 0 && (!marked || force) ? `!${hiddenNotes}` : "";
  // Stop is offered only where its whole confirmation fits beside a minimal
  // selected tab, so an armed Stop can never be painted without its warning.
  // The live status needs no room here: the title row keeps it.
  const TAB_FLOOR = multi ? 1 + 4 : 0;
  const canStop = available && !!view && visibleWidth(CONFIRM_HINT) + TAB_FLOOR <= width;
  const action = canStop
    ? confirming
      ? CONFIRM_LABEL
      : composing
        ? STOP_CLICK_LABEL
        : STOP_LABEL
    : "";
  const armed = confirming && !!action;
  const esc = !framed && !composing && !armed ? "Esc" : "";
  type Piece = { text: string; width: number; kind?: "tail" | "message" | "action" };
  const assemble = (tailForm: number, messageForm: number): Piece[] => {
    const groups: Piece[][] = [];
    if (armed) {
      groups.push([
        { text: th.fg("dim", `${CONFIRM_HELP} · `), width: visibleWidth(CONFIRM_HELP) + 3 },
        {
          text: th.bold(th.fg("warning", CONFIRM_LABEL)),
          width: visibleWidth(CONFIRM_LABEL),
          kind: "action",
        },
      ]);
    } else {
      const tail = below > 0 ? [`↓ ${below} more`, `↓${below}`, ""][tailForm]! : "";
      if (tail)
        groups.push([
          {
            text: th.fg(input.live ? "accent" : "dim", tail),
            width: visibleWidth(tail),
            kind: "tail",
          },
        ]);
      const actions: Piece[] = [];
      const message = offerMessage ? ["[M message]", "[M msg]", ""][messageForm]! : "";
      if (message)
        actions.push({
          text: th.fg("muted", message),
          width: visibleWidth(message),
          kind: "message",
        });
      if (action) {
        if (actions.length) actions.push({ text: " ", width: 1 });
        actions.push({ text: th.fg("dim", action), width: visibleWidth(action), kind: "action" });
      }
      // Docked there is no close control: `Esc` precedes the actions, so
      // Stop stays outermost in every form.
      if (esc) groups.push([{ text: th.fg("dim", esc), width: visibleWidth(esc) }]);
      if (actions.length) groups.push(actions);
    }
    const out: Piece[] = [];
    for (const [index, group] of groups.entries()) {
      if (index)
        out.push(
          framed
            ? { text: ` ${th.fg("borderAccent", POPOVER.h)} `, width: 3 }
            : { text: "  ", width: 2 },
        );
      out.push(...group);
    }
    return out;
  };
  // [arrows, tail form, message form]; forms count up as they shorten.
  const order: readonly (readonly [boolean, number, number])[] = framed
    ? [
        [true, 0, 0],
        [false, 0, 0],
        [false, 1, 0],
        [false, 2, 0],
        [false, 2, 1],
        [false, 2, 2],
      ]
    : [
        [true, 0, 0],
        [false, 0, 0],
        [false, 0, 1],
        [false, 0, 2],
        [false, 1, 2],
        [false, 2, 2],
      ];
  const sum = (pieces: readonly Piece[]): number =>
    pieces.reduce((total, piece) => total + piece.width, 0);
  const choose = (forceCue: boolean): { right: Piece[]; strip: DetailAgentStrip; cue: string } => {
    const required = cueText(forceCue);
    let chosen: { right: Piece[]; strip: DetailAgentStrip; cue: string } | undefined;
    for (const [index, [arrows, tailForm, messageForm]] of order.entries()) {
      const right = assemble(tailForm, messageForm);
      const rightWidth = sum(right);
      const last = index === order.length - 1;
      // One column separates the halves, and only when both have content. The
      // cue is required: it clips only against the right side.
      const sep = rightWidth ? 1 : 0;
      const cue = required ? clipPlainText(required, Math.max(0, width - rightWidth - sep)) : "";
      const room = multi
        ? width - rightWidth - sep - visibleWidth(cue) - (cue ? 1 : 0)
        : width - rightWidth - (cue ? visibleWidth(cue) + sep : 0);
      // The cue is required: optional parts yield before it ever clips.
      if (!last && cue !== required) continue;
      if (!multi) {
        if (room >= 0 || last) {
          chosen = { right, strip: { text: "", items: [] }, cue };
          break;
        }
        continue;
      }
      const strip = renderDetailAgentStrip({
        entries,
        selected,
        width: Math.max(0, room),
        spinnerFrame,
        theme: th,
        framed,
        arrows: arrows && !composing && !armed,
        collapse: armed,
      });
      if ((strip.text && !strip.clipped) || last) {
        chosen = { right, strip, cue };
        break;
      }
    }
    // The last rung always accepts, so a choice exists for every width.
    return chosen!;
  };
  let chosen = choose(false);
  // The marker the suppression assumed was clipped away after all: the cue
  // is required, so lay the edge out again with it forced.
  if (marked && hiddenNotes && hiddenNotes > 0 && !chosen.strip.markerVisible)
    chosen = choose(true);
  const { right, strip, cue } = chosen;
  const leftText = (cue ? th.fg("warning", cue) + (strip.text ? " " : "") : "") + strip.text;
  const leftWidth = visibleWidth(leftText);
  const stripFrom = base + leftWidth - visibleWidth(strip.text);
  const rightWidth = sum(right);
  const gap = Math.max(leftWidth && rightWidth ? 1 : 0, width - leftWidth - rightWidth);
  // Framed, the gap is border: a padded tab already ends in a space, and with
  // nothing at the left the rule meets the corner itself. With nothing at the
  // right, the frame's own pad and rule finish the edge.
  const lead = leftWidth === 0 || (strip.text && strip.padded) ? 0 : 1;
  const trail = rightWidth ? 1 : 0;
  const filler = !rightWidth
    ? ""
    : framed && gap - lead - trail >= 1
      ? " ".repeat(lead) +
        th.fg("borderAccent", POPOVER.h.repeat(gap - lead - trail)) +
        " ".repeat(trail)
      : " ".repeat(gap);
  const rightFrom = base + leftWidth + gap;
  let offset = rightFrom;
  let actionRange: DetailFooterAction | undefined;
  let messageRange: DetailFooterMessageAction | undefined;
  let tailRange: { from: number; to: number } | undefined;
  for (const piece of right) {
    const from = offset;
    offset += piece.width;
    if (piece.kind === "action")
      actionRange = { kind: armed ? "confirm" : "stop", from, to: offset };
    else if (piece.kind === "message") messageRange = { kind: "message", from, to: offset };
    else if (piece.kind === "tail") tailRange = { from, to: offset };
  }
  return {
    // An edge with nothing on it is plain border, drawn by the frame itself.
    text:
      leftWidth || rightWidth
        ? truncateToWidth(leftText + filler + right.map((piece) => piece.text).join(""), width)
        : "",
    // A padded tab at either end, like an empty side, continues the corner's
    // rule: `╰── +5 ─ ⠋ elm ─`, never a doubled space beside the corner.
    ...(framed
      ? {
          flush: {
            start: leftWidth ? !cue && !!strip.padded : rightWidth > 0,
            end: !rightWidth && leftWidth > 0 && !lead,
          },
        }
      : {}),
    tabs: strip.items.map((item) => ({
      agent_id: item.agent_id,
      from: item.from + stripFrom,
      to: item.to + stripFrom,
    })),
    ...(actionRange ? { action: actionRange } : {}),
    ...(messageRange ? { messageAction: messageRange } : {}),
    ...(tailRange ? { tail: tailRange } : {}),
  };
}
