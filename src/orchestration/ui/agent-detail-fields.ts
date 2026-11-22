import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { validDifficulty, type RunView } from "../core/contracts.ts";
import { reported, type UsageComponent } from "../core/usage-ledger.ts";
import { formatTokenCount } from "../../shared/token-format.mjs";
import { shortcutHint } from "../../shared/shortcut-hint.mjs";
import type { SpeedModelGlyph } from "../../shared/overlay-protocol.mjs";
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
  SPINNER,
  type Theme,
} from "./format.ts";
import { POPOVER } from "./popover.ts";
import { clipPlainText, singleLineText, wrapPlainText as wrapText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";
import { isObservedCost, widgetCost } from "./widget-cost.ts";

/** Label column, so every field's value starts at the same place. */
const LABEL = 10;
/** Plain control bodies: the shortcut helper paints the key inline. */
const STOP_PLAIN = "stop";
const CONFIRM_PLAIN = "confirm stop";
const CONFIRM_HELP = "best-effort · Ctrl+S · Esc cancel";
const CONFIRM_HINT = `${CONFIRM_HELP} · ${CONFIRM_PLAIN}`;
/** The pane's actions menu control, painted before Message and Stop. */
const MENU_PLAIN = ". more";
/** A shortened model name never drops below a readable fragment: four
 * literal cells beside the ellipsis. */
const MODEL_FLOOR = 5;

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

/** The pane's own title row: identity and task at the left. The lifecycle
 * status lives in the bottom metrics row and the frame's close control is the
 * pane's own, so this row is content only. The task/Run cue never scrolls
 * away: task text truncates first, then the identity shortens. The tag yields
 * before the name falls below three terminal cells including the ellipsis;
 * a shorter name can keep the tag while it still fits whole. */
export function renderDetailTitle(input: DetailInput, theme: Theme, width: number): string {
  const { view } = input;
  const settings = view.effective_settings;
  const profile = singleLineText(profileLabel(settings.profile));
  const name = singleLineText(view.name || profile);
  const difficulty = validDifficulty(settings.difficulty) ? `d${settings.difficulty}` : "";
  const tag = view.name ? [profile, difficulty].filter(Boolean).join("/") : difficulty;
  const task = singleLineText(view.description).trim() || "task";
  const marker =
    Number.isSafeInteger(view.task) && view.task > 0
      ? `#${view.task}`
      : shortId(singleLineText(view.run_id));
  const room = Math.max(0, Math.floor(width));
  if (room < 1) return "";
  const cue = theme.fg("dim", ` · ${marker}`);
  const cueWidth = 3 + visibleWidth(marker);
  const tagText = tag ? theme.fg("dim", ` (${tag})`) : "";
  const tagWidth = tag ? visibleWidth(` (${tag})`) : 0;
  // A task-bearing title reserves readable task context and name cells. If
  // both cannot fit, keep identity plus Run cue rather than a bare-ellipsis name.
  const taskFloor = Math.min(8, visibleWidth(task));
  const identity = (nameRoom: number): string =>
    theme.bold(clipPlainText(name, Math.max(1, Math.min(32, nameRoom))));
  // With or without a tag, reserve three terminal cells including the
  // ellipsis; a name that is itself shorter keeps all of it.
  const nameFloor = Math.min(3, visibleWidth(name));
  const withTask = (nameRoom: number, nameTag: string): string | undefined => {
    if (nameRoom < nameFloor) return undefined;
    const head = identity(nameRoom) + nameTag;
    const taskRoom = room - visibleWidth(head) - 2 - cueWidth;
    if (taskRoom < taskFloor) return undefined;
    return head + "  " + theme.fg("muted", clipPlainText(task, taskRoom)) + cue;
  };
  // A narrower row drops the tag before the identity falls below that floor,
  // then the task yields, and finally the cue alone remains, clipped.
  return (
    withTask(room - tagWidth - cueWidth - 2 - taskFloor, tagText) ??
    withTask(room - cueWidth - 2 - taskFloor, "") ??
    (room - cueWidth >= 1 ? identity(room - cueWidth) + cue : undefined) ??
    truncateToWidth(cue, room, "…")
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

  // Label, colour, text: the same facts the attention rows collect, listed
  // here in the Info page's own fixed order rather than by attention priority.
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
      `${view.pending_messages} pending alert${view.pending_messages === 1 ? "" : "s"}` +
        " from this Run awaiting local presentation",
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

/** The live-turn clock in whole, floored seconds: `18s`, `1m02s`. One spelling
 * per magnitude keeps every tick the same shape. */
const turnClockText = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};
interface DockSegment {
  key: "status" | "model" | "turns" | "context" | "usage" | "cost" | "elapsed" | "clock";
  /** Plain visible text, kept for re-clipping: only the model shortens. */
  plain: string;
  /** Painted text. */
  text: string;
  /** Painted cells. The trailing clock reserves nothing after it. */
  width: number;
}

/** Compact live metrics for the pane's bottom dock: exactly one metrics row.
 * Normal running/completed work leads with its lifecycle glyph alone; an
 * ambiguous state keeps a readable label. The live current-turn clock closes
 * the row after the bare cumulative elapsed time, while the Run is actually
 * running (not finishing, not exited). The task lives in the title, so it is
 * not repeated here. Figures drop from the least urgent end when the row is
 * narrow; a figure some response left out stays a floor (`≥`) or unknown
 * (`?`), never zero, and no numeric fact is clipped mid-figure.
 * `options.activity === true` adds the bounded activity row back for callers
 * that still allocate one; the default dock is the metrics row alone. */
export function renderDetailSummary(
  input: DetailInput,
  theme: Theme,
  width: number,
  options: { activity?: boolean; spinnerFrame?: number; modelSpeedGlyph?: SpeedModelGlyph } = {},
): string[] {
  const { view, live } = input;
  const s = view.effective_settings;
  const room = Math.max(0, Math.floor(width));
  const state = runPresentation(view.status, options.spinnerFrame ?? 0, view.finalization_pending);
  // The current-turn clock is live only while the Run is actually running:
  // finishing or exited execution has no current turn to time.
  const clockMs =
    view.status === "running" && !view.finalization_pending && !view.execution_exited
      ? view.turn_elapsed_ms
      : undefined;
  // The main widget spells a pending question humanely; the dock shares
  // that wording instead of the raw status key. Every other status keeps the
  // shared runPresentation labels.
  const asked = !!view.outcome?.question;
  const label =
    view.status === "needs_input" ? (asked ? "needs answer" : "needs input") : state.label;
  const compact = view.status === "needs_input" ? (asked ? "answer?" : "input?") : state.compact;
  // Normal running/completed work is unambiguous from its glyph alone; every
  // ambiguous lifecycle state keeps a readable label.
  const normal =
    view.status === "completed" ||
    (view.status === "running" && !view.finalization_pending && !view.execution_exited);
  const status = (text: string): DockSegment => ({
    key: "status",
    plain: text,
    text: theme.fg(state.color, text),
    width: visibleWidth(text),
  });
  const labelledStatus = (text: string): DockSegment => status(`${state.glyph} ${text}`);
  const glyphStatus = (): DockSegment => status(state.glyph);
  const segments: DockSegment[] = [];
  const push = (key: DockSegment["key"], plain: string, color: string): void => {
    segments.push({ key, plain, text: theme.fg(color, plain), width: visibleWidth(plain) });
  };
  segments.push(normal ? glyphStatus() : labelledStatus(label));
  const model = [singleLineText(s.model), singleLineText(s.thinking)].filter(Boolean).join("/");
  if (model) push("model", model, "dim");
  push(
    "turns",
    `${GLYPHS.turns}${view.turns}/${view.max_turns}`,
    view.max_turns > 0 && view.turns / view.max_turns >= 0.8 ? "warning" : "dim",
  );
  const context = view.runtime?.context;
  const percent = contextPercent(context);
  if (context)
    push(
      "context",
      `ctx ${approxContextTokens(context.tokens, "?")}/${formatContextTokens(context.context_window)}`,
      percent === undefined ? "dim" : percent >= 90 ? "error" : percent >= 70 ? "warning" : "dim",
    );
  const usage = view.usage;
  // Cumulative current-Run tokens: the input figure sums plain input and both
  // cache directions, and the hit ratio needs all three components complete
  // and known -- a partial or unknown figure would fabricate a rate.
  const usageText = (withRatio: boolean): string | undefined => {
    if (!usage) return undefined;
    const inputTokens = reported(usage, "input");
    const cacheRead = reported(usage, "cache_read");
    const cacheWrite = reported(usage, "cache_write");
    const sum =
      inputTokens !== undefined && cacheRead !== undefined && cacheWrite !== undefined
        ? inputTokens + cacheRead + cacheWrite
        : undefined;
    const partial = (["input", "cache_read", "cache_write"] as const).some((name) =>
      usage.partial.includes(name),
    );
    // An overflowed sum is unknown, not a rate: the ratio needs a finite
    // denominator, and an invalid computed figure reads "?", never 0.0%.
    const ratio =
      withRatio && sum !== undefined && !partial && Number.isFinite(sum) && sum > 0
        ? `${((cacheRead! / sum) * 100).toFixed(1)}%`
        : undefined;
    const output = reported(usage, "output");
    const figure = (value: number | undefined, floor: boolean): string =>
      value === undefined || !Number.isFinite(value) || value < 0
        ? "?"
        : // The footer's own compact spelling, without trimKZero: the usage
          // figures read identically in both places. Context keeps its own
          // trimKZero form.
          `${floor ? "≥" : ""}${formatTokenCount(value, { precision: "compact" })}`;
    return `↑${figure(sum, partial)}${ratio ? ` (${ratio})` : ""} ↓${figure(
      output,
      usage.partial.includes("output"),
    )}`;
  };
  const usagePlain = usageText(true);
  if (usagePlain) push("usage", usagePlain, "dim");
  const spent = reported(view.usage, "cost");
  if (spent !== undefined && isObservedCost(spent))
    push("cost", widgetCost(spent, view.usage?.partial.includes("cost") ?? false), "dim");
  // Bare cumulative elapsed time: the label and parentheses are retired.
  push("elapsed", formatMs(view.elapsed_ms), "dim");
  // The live turn clock closes the row. It is last, so nothing after it needs
  // a reservation: its own ticks never leave a trailing hole.
  const clockSegment: DockSegment | undefined =
    clockMs === undefined
      ? undefined
      : (() => {
          const plain = `turn ${turnClockText(clockMs)}`;
          return {
            key: "clock",
            plain,
            text: theme.fg(clockMs >= 60_000 ? "warning" : "dim", plain),
            width: visibleWidth(plain),
          };
        })();
  if (clockSegment) segments.push(clockSegment);

  const SEP = 3;
  const total = (list: readonly DockSegment[]): number =>
    list.reduce((sum, segment, index) => sum + segment.width + (index ? SEP : 0), 0);
  let kept = segments;
  const fits = (): boolean => total(kept) <= room;
  const drop = (key: DockSegment["key"]): void => {
    kept = kept.filter((segment) => segment.key !== key);
  };
  const replace = (key: DockSegment["key"], next: DockSegment): void => {
    kept = kept.map((segment) => (segment.key === key ? next : segment));
  };
  // The model shortens before any whole figure yields, never below a
  // readable fragment.
  if (!fits()) {
    const overflow = total(kept) - room;
    const current = kept.find((segment) => segment.key === "model");
    if (current && current.width > MODEL_FLOOR) {
      const plain = clipPlainText(current.plain, Math.max(MODEL_FLOOR, current.width - overflow));
      kept = kept.map((segment) =>
        segment === current
          ? { ...segment, plain, text: theme.fg("dim", plain), width: visibleWidth(plain) }
          : segment,
      );
    }
  }
  // Whole figures then yield, least urgent first: the cumulative elapsed time,
  // the cache percentage, the usage group, cost, turns (elevated turn pressure
  // lasts longer), the shortened model, and finally the context. Ambiguous
  // status wording compacts to its glyph before the context ever yields -- the
  // window is essential. The live clock outlasts every routine figure, then
  // yields before the context; once the context must yield, the freed row
  // takes back the most readable status that fits, and the clock beside it.
  if (!fits()) drop("elapsed");
  if (!fits()) {
    const plain = usageText(false);
    if (plain)
      replace("usage", {
        key: "usage",
        plain,
        text: theme.fg("dim", plain),
        width: visibleWidth(plain),
      });
  }
  if (!fits()) drop("usage");
  if (!fits()) drop("cost");
  const elevatedTurns = view.max_turns > 0 && view.turns / view.max_turns >= 0.8;
  if (!fits() && !elevatedTurns) drop("turns");
  if (!fits()) drop("model");
  if (!fits()) drop("turns");
  if (!fits() && !normal) {
    for (const form of [labelledStatus(compact), glyphStatus()]) {
      replace("status", form);
      if (fits()) break;
    }
  }
  if (!fits()) drop("clock");
  if (!fits()) {
    drop("context");
    // No status form could hold the context: the freed row takes back the most
    // readable status that fits it, never a needless glyph alone, and brings
    // the live clock back when both still fit.
    const statusForms = normal
      ? [glyphStatus()]
      : [labelledStatus(label), labelledStatus(compact), glyphStatus()];
    const rest = kept.filter((segment) => segment.key !== "status");
    const candidates: DockSegment[][] = [];
    for (const form of statusForms) {
      if (clockSegment) candidates.push([form, ...rest, clockSegment]);
      candidates.push([form, ...rest]);
    }
    kept = candidates.find((candidate) => total(candidate) <= room) ?? [glyphStatus(), ...rest];
  }
  // Dropping whole figures can free more than the initial model shortening
  // needed. Give those cells back to a surviving model, without restoring any
  // dropped field or borrowing from the live clock.
  const keptModel = kept.find((segment) => segment.key === "model");
  if (keptModel && fits()) {
    const modelRoom = Math.min(visibleWidth(model), keptModel.width + room - total(kept));
    const label = clipPlainText(model, modelRoom);
    const glyph = options.modelSpeedGlyph;
    const prefix =
      glyph &&
      label === model &&
      total(kept) - keptModel.width + visibleWidth(`${glyph} ${label}`) <= room
        ? `${glyph} `
        : "";
    const plain = prefix + label;
    replace("model", {
      ...keptModel,
      plain,
      text: (prefix && glyph ? `${theme.fg("warning", glyph)} ` : "") + theme.fg("dim", label),
      width: visibleWidth(plain),
    });
  }
  // No segment reserves trailing cells: the clock is last, so its ticks only
  // change its own painted width and never leave a hole.
  const metrics = fits()
    ? kept.map((segment) => segment.text).join(theme.fg("dim", " · "))
    : theme.fg(state.color, clipPlainText(state.glyph, room));
  const out = [metrics];
  if (options.activity !== true) return out;
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
      text: `${view.pending_messages} pending alert${view.pending_messages === 1 ? "" : "s"}`,
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
  // The inline key is the same shortcut styling the footer controls use.
  const info = shortcutHint(theme, "info", "I", { color: "dim" });
  return shown.map((note, index) => {
    const last = index === shown.length - 1;
    // The hidden-note counter yields its wording before the note text does,
    // but the count itself stays as long as one column of text remains.
    const suffixes =
      hidden > 0 && last
        ? [
            ...(!options.info
              ? [
                  theme.fg("dim", ` · +${hidden} · `) + info,
                  theme.fg("dim", ` +${hidden} · `) + info,
                ]
              : []),
            theme.fg("dim", ` · +${hidden}`),
            theme.fg("dim", ` +${hidden}`),
            "",
          ]
        : [""];
    for (const suffix of suffixes) {
      const room = width - visibleWidth(suffix);
      if (room >= 4) return theme.fg(note.color, clipPlainText(plain(note), room)) + suffix;
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
 * That padding alone separates neighbours on every edge: there is no ASCII
 * pipe join. The selected tab is always visible, with an accent, bold,
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
  /** Kept for callers that distinguish the edge; joins are padding either way. */
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
    const error = notes.some((note) => note.severity === "error");
    const warning = notes.some((note) => note.severity === "warning");
    const selectedHere = entry.agent_id === selected;
    return {
      agent_id: entry.agent_id,
      glyph: state.glyph,
      color: state.color,
      label: clipPlainText(
        singleLineText(view.name || profileLabel(view.effective_settings.profile)),
        TAB_LABEL_MAX,
      ),
      question,
      error,
      warning,
      // A completed peer with nothing to flag is ordinary background: its
      // glyph dims. Selection or any attention keeps the lifecycle colour.
      dimGlyph: !selectedHere && view.status === "completed" && !question && !error && !warning,
      marker: (question ? "?" : "") + (error || warning ? "!" : ""),
      selected: selectedHere,
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
    const warnings = hidden.filter((tab) => tab.error || tab.warning).length;
    return ` +${hidden.length}${questions ? ` ?${questions}` : ""}${warnings ? ` !${warnings}` : ""} `;
  };
  const arrows = input.arrows ? 2 : 0;
  const windowWidth = (start: number, end: number): number => {
    const parts = widths.slice(start, end + 1);
    if (start > 0) parts.push(visibleWidth(summary(tabs.slice(0, start))));
    if (end < n - 1) parts.push(visibleWidth(summary(tabs.slice(end + 1))));
    return parts.reduce((sum, part) => sum + part, 0) + arrows;
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
  // Motion alone marks an active peer; the selected spinner keeps its lifecycle colour.
  // At glyph-only widths, bold/underline still identify the selected tab.
  const paintGlyph = (tab: Tab, selectedOnly = false): string => {
    const glyph =
      !tab.selected && SPINNER.includes(tab.glyph)
        ? tab.glyph
        : theme.fg(tab.dimGlyph ? "dim" : tab.color, tab.glyph);
    return selectedOnly && tab.selected ? selectedText(glyph) : glyph;
  };
  // `?` is a question (warning); `!` is an actual error, else a warning.
  const paintMarker = (tab: Tab): string =>
    (tab.question ? theme.fg("warning", "?") : "") +
    (tab.error || tab.warning ? theme.fg(tab.error ? "error" : "warning", "!") : "");
  if (!found) {
    // Not even the selected tab fits whole beside its summaries: clip it alone,
    // and keep its hit range inside what was actually painted. The glyph
    // stays first, then the `?`/`!` marker, then whatever label columns
    // remain: a question or warning outranks the nickname, so the clipped
    // tab keeps the cue the footer's `!N` suppression counts on. The marker
    // keeps the whole strip's semantics -- `?` warning-coloured, `!`
    // error-coloured, or warning-coloured for an ordinary warning -- so
    // neither the glyph's lifecycle colour nor the selected nickname's accent
    // can repaint a warning as success.
    const tab = tabs[selectedIndex]!;
    const marker = tab.marker ? ` ${tab.marker}` : "";
    // Styled only where it is painted, so an unpainted marker styles nothing.
    const markerStyled = (): string => ` ${paintMarker(tab)}`;
    const budget = Math.max(0, width - 2);
    const markerWidth = visibleWidth(marker);
    const labelRoom = budget - 2 - markerWidth;
    // When even the complete marker cannot fit, keep the glyph's priority
    // order and paint only the marker cells that do, each in its own colour.
    const clippedMarker = tab.marker.slice(0, Math.max(0, budget - 1));
    const clippedMarkerStyled = (): string =>
      (clippedMarker.includes("?") ? theme.fg("warning", "?") : "") +
      (clippedMarker.includes("!") ? theme.fg(tab.error ? "error" : "warning", "!") : "");
    // The glyph is a fixed, single-cell lifecycle symbol. Split only that
    // known plain prefix, after cell-aware clipping, to preserve every old
    // padding/hit column while styling the nickname separately.
    const unmarked = clipPlainText(`${tab.glyph} ${tab.label}`, budget);
    const tail = unmarked.slice(tab.glyph.length);
    const space = tail.startsWith(" ") ? " " : "";
    const label = tail.slice(space.length);
    const text =
      width < 4
        ? paintGlyph(tab, true)
        : !marker
          ? ` ${paintGlyph(tab, !label)}${space}${paintName(tab, label)} `
          : labelRoom >= 1
            ? ` ${paintGlyph(tab)} ${paintName(tab, clipPlainText(tab.label, labelRoom))}${markerStyled()} `
            : budget >= 1 + markerWidth
              ? ` ${paintGlyph(tab, true)}${markerStyled()} `
              : ` ${paintGlyph(tab, true)}${clippedMarkerStyled()} `;
    return {
      text,
      items: text ? [{ agent_id: tab.agent_id, from: 0, to: visibleWidth(text) }] : [],
      clipped: true,
      padded: width >= 4,
      // A complete marker is the bare `?`/`!` cells after the glyph; the
      // leading space above is layout padding, not part of the marker itself.
      markerVisible: !!tab.marker && width >= 4 && budget >= 1 + tab.marker.length,
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
        (tab.marker ? " " + paintMarker(tab) : "") +
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
  const items: DetailAgentStripItem[] = [];
  let text = "";
  let offset = 0;
  for (const element of elements) {
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
  /** The optional actions menu `. more`, painted before Message and Stop. */
  menu?: { from: number; to: number };
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
  /** Attention without space for a pinned row. */
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
  const refused = !input.sendable || !!input.empty || !!input.tooLong;
  const color = refused ? "warning" : "dim";
  const join = th.fg(color, " · ");
  const body = (text: string): string => th.fg(color, text);
  const chord = (label: string, key: string): string => shortcutHint(th, label, key, { color });
  const keyOnly = (key: string): string => shortcutHint(th, "", key, { color });
  const hints =
    input.unavailable === "geometry"
      ? [
          `${body("pane too small")}${join}${chord("discard", "Esc")}`,
          `${body("too small")}${join}${keyOnly("Esc")}`,
          "",
        ]
      : !input.sendable
        ? [
            `${body("task no longer running")}${join}${chord("cancel", "Esc")}`,
            `${body("not running")}${join}${keyOnly("Esc")}`,
            "",
          ]
        : input.tooLong
          ? [
              `${body("message too long")}${join}${chord("cancel", "Esc")}`,
              `${body("too long")}${join}${keyOnly("Esc")}`,
              body("too long"),
            ]
          : input.empty
            ? [
                `${body("message is empty")}${join}${chord("cancel", "Esc")}`,
                `${body("empty")}${join}${keyOnly("Esc")}`,
                body("empty"),
              ]
            : [
                `${chord("send", "Enter")}${join}${chord("cancel", "Esc")}`,
                `${keyOnly("Enter")}${join}${keyOnly("Esc")}`,
                "",
              ];
  const hint =
    hints.find(
      (text) =>
        !text || available - visibleWidth(text) - 2 >= (input.empty || input.tooLong ? 1 : 16),
    ) ?? "";
  const room = hint ? available - visibleWidth(hint) - 2 : available;
  const row = cue + input.input(room);
  return hint ? `${row}  ${hint}` : row;
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
  const color = input.sendable && !input.empty && !input.tooLong ? "dim" : "warning";
  const join = th.fg(color, " · ");
  const body = (text: string): string => th.fg(color, text);
  const chord = (label: string, key: string): string => shortcutHint(th, label, key, { color });
  const keyOnly = (key: string): string => shortcutHint(th, "", key, { color });
  const hints = !input.sendable
    ? [
        `${body("task ended")}${join}${chord("discard", "Esc")}`,
        `${body("ended")}${join}${keyOnly("Esc")}`,
        keyOnly("Esc"),
      ]
    : input.tooLong
      ? [
          `${body("message too long")}${join}${chord("discard", "Esc")}`,
          `${body("too long")}${join}${keyOnly("Esc")}`,
          body("too long"),
        ]
      : input.empty
        ? [
            `${body("message is empty")}${join}${chord("discard", "Esc")}`,
            `${body("empty")}${join}${keyOnly("Esc")}`,
            body("empty"),
          ]
        : [
            `${chord("send", "Enter")}${join}${chord("discard", "Esc")}`,
            `${keyOnly("Enter")}${join}${keyOnly("Esc")}`,
            "",
          ];
  const hint = hints.find((text) => width - visibleWidth(text) - 2 >= 8) ?? hints.at(-1)!;
  const room = width - visibleWidth(hint) - 2;
  const left =
    room >= 8 + visibleWidth(marker) + Math.min(visibleWidth(name), 32)
      ? `${th.fg("dim", "Steer")} ${th.bold(name)}${marker ? th.fg("dim", marker) : ""}`
      : th.fg("dim", clipPlainText(`Steer ${name}${marker}`, Math.max(1, room)));
  return spanRow(left, hint, width, th, false);
}

/** Pure bottom-edge layout. Confirmation lifetime and painted hit geometry stay with the pane.
 *
 * The edge is the pane's navigation and action bar in one row: agent tabs at
 * the left, and at the right the jump back to the tail (`↓ N more`), then the
 * optional `. more` actions menu, `message` and `stop`, Stop always
 * outermost. An armed Stop confirmation hides the menu and the message, so
 * only the final row changes. Counters, the scroll
 * position, following and the static key legend are not repeated here: the
 * tabs, the scrollbar and the close control already say them. Docked, with no
 * close control, an `Esc` hint precedes the actions.
 *
 * Under width pressure the parts yield in a fixed order: peer tabs fold into
 * `+N` first, then the `‹ ›` arrows, then the tail cue (framed, where the
 * scrollbar also shows position) or `message` (docked, where the cue is
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
  /** Paint the `. more` actions menu before Message/Stop. An armed Stop
   * confirmation hides it; only the final row changes. */
  menu?: boolean;
  /** Attention notes hidden because no attention row could present them. The
   * selected tab's own `?`/`!` marker already flags them; with no marker to
   * carry them, a `!N` cue leads the edge instead. */
  hiddenNotes?: number;
  spinnerFrame: number;
  theme: Theme;
  framed: boolean;
  /** A framed row can be interior chrome rather than an inlaid edge. */
  borderLabels?: boolean;
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
    menu,
    hiddenNotes,
    spinnerFrame,
    theme: th,
    framed,
  } = input;
  const base = framed ? 3 : 0;
  const inlaid = framed && input.borderLabels !== false;
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
  // The live status needs no room here: the bottom metrics row keeps it.
  const TAB_FLOOR = multi ? 1 + 4 : 0;
  const canStop = available && !!view && visibleWidth(CONFIRM_HINT) + TAB_FLOOR <= width;
  const stopKind = canStop
    ? confirming
      ? ("confirm" as const)
      : composing
        ? ("click" as const)
        : ("stop" as const)
    : undefined;
  const armed = stopKind === "confirm";
  const esc = !framed && !composing && !armed ? "Esc" : "";
  const keyOnly = (key: string, color = "dim"): string => shortcutHint(th, "", key, { color });
  // The confirmation legend keeps its exact wording while the explicit
  // chords use the shared shortcut emphasis.
  const confirmHelp =
    th.fg("dim", "best-effort") +
    th.fg("dim", " · ") +
    keyOnly("Ctrl+S") +
    th.fg("dim", " · ") +
    shortcutHint(th, "cancel", "Esc", { color: "dim" });
  type Piece = { text: string; width: number; kind?: "tail" | "message" | "action" | "menu" };
  const assemble = (tailForm: number, messageForm: number): Piece[] => {
    const groups: Piece[][] = [];
    if (armed) {
      groups.push([
        { text: `${confirmHelp}${th.fg("dim", " · ")}`, width: visibleWidth(CONFIRM_HELP) + 3 },
        {
          // Click-only label beside the explicit Ctrl+S chord: plain S only
          // arms the confirmation, so the label never advertises it.
          text: th.bold(shortcutHint(th, CONFIRM_PLAIN, undefined, { color: "warning" })),
          width: visibleWidth(CONFIRM_PLAIN),
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
      // The menu is reserved: the optional peers, message and tail forms yield
      // before it ever does, and it is never clipped to a partial label.
      if (menu)
        actions.push({
          text: shortcutHint(th, "more", ".", { color: "dim" }),
          width: visibleWidth(MENU_PLAIN),
          kind: "menu",
        });
      const message = offerMessage ? ["message", "msg", ""][messageForm]! : "";
      if (message) {
        if (actions.length) actions.push({ text: " ", width: 1 });
        actions.push({
          text: shortcutHint(th, message, "m"),
          width: visibleWidth(message),
          kind: "message",
        });
      }
      if (stopKind) {
        if (actions.length) actions.push({ text: " ", width: 1 });
        actions.push({
          // While composing, S is draft text: the control stays clickable,
          // keyless.
          text:
            stopKind === "click"
              ? shortcutHint(th, STOP_PLAIN, undefined, { color: "dim" })
              : shortcutHint(th, STOP_PLAIN, "s", { color: "dim" }),
          width: visibleWidth(STOP_PLAIN),
          kind: "action",
        });
      }
      // Docked there is no close control: `Esc` precedes the actions, so
      // Stop stays outermost in every form.
      if (esc) groups.push([{ text: keyOnly(esc), width: visibleWidth(esc) }]);
      if (actions.length) groups.push(actions);
    }
    const out: Piece[] = [];
    for (const [index, group] of groups.entries()) {
      if (index)
        out.push(
          inlaid
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
        framed: inlaid,
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
    : inlaid && gap - lead - trail >= 1
      ? " ".repeat(lead) +
        th.fg("borderAccent", POPOVER.h.repeat(gap - lead - trail)) +
        " ".repeat(trail)
      : " ".repeat(gap);
  const rightFrom = base + leftWidth + gap;
  let offset = rightFrom;
  let actionRange: DetailFooterAction | undefined;
  let messageRange: DetailFooterMessageAction | undefined;
  let menuRange: { from: number; to: number } | undefined;
  let tailRange: { from: number; to: number } | undefined;
  for (const piece of right) {
    const from = offset;
    offset += piece.width;
    if (piece.kind === "action")
      actionRange = { kind: armed ? "confirm" : "stop", from, to: offset };
    else if (piece.kind === "message") messageRange = { kind: "message", from, to: offset };
    else if (piece.kind === "menu") menuRange = { from, to: offset };
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
    ...(inlaid
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
    ...(menuRange ? { menu: menuRange } : {}),
    ...(tailRange ? { tail: tailRange } : {}),
  };
}
