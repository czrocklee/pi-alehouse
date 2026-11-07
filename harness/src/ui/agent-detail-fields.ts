import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { validDifficulty, type RunView } from "../core/contracts.ts";
import { reported, type UsageComponent } from "../core/usage-ledger.ts";
import { profileLabel } from "../tools/tool-names.ts";
import type { ActiveTool, GenerationPreview } from "../runtime/activity-types.ts";
import {
  formatContextPercent,
  formatContextTokens,
  formatCost,
  formatDrain,
  formatMs,
  formatTokens,
  formatTurns,
  generationLine,
  shortPath,
  type Theme,
} from "./format.ts";
import { POPOVER } from "./popover.ts";
import { clipPlainText, singleLineText, wrapPlainText as wrapText } from "./text.ts";
import { activityPresentation, runPresentation } from "./run-presentation.ts";

/** Label column, so every field's value starts at the same place. */
const LABEL = 10;
const STOP_LABEL = "[S Stop]";
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

const shortId = (value: string): string =>
  value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
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

/** Live status chrome, shared by docked and framed lower-left footers. */
export function renderDetailStatus(
  view: RunView,
  spinnerFrame: number,
  theme: Theme,
  width: number,
): string {
  const state = runPresentation(view.status, spinnerFrame, view.finalization_pending);
  const label = visibleWidth(state.label) + 2 <= width ? state.label : state.compact;
  return `${theme.fg(state.color, state.glyph)} ${theme.fg(state.color, label)}`;
}

/** The pane's own title row: identity and task, without live status. */
export function renderDetailTitle(
  input: DetailInput,
  _spinnerFrame: number,
  theme: Theme,
  width: number,
  rule = false,
): string {
  const { view } = input;
  const profile = singleLineText(profileLabel(view.effective_settings.profile));
  const name = singleLineText(view.name || profile);
  const task = singleLineText(view.description).trim() || "task";
  const marker =
    Number.isSafeInteger(view.task) && view.task > 0
      ? `#${view.task}`
      : shortId(singleLineText(view.run_id));
  const suffix = ` · ${marker}`;
  // The task/Run cue never scrolls away. Sacrifice nickname/profile space first
  // so Agent reuse cannot leave two different tasks with identical chrome.
  const minimumContext = Math.min(8, visibleWidth(task)) + visibleWidth(suffix);
  let tag = view.name ? ` (${profile})` : "";
  let nameRoom = width - minimumContext - 2 - visibleWidth(tag);
  if (nameRoom < 3) {
    tag = "";
    nameRoom = width - minimumContext - 2;
  }
  const shortName = truncateToWidth(name, Math.max(1, Math.min(32, nameRoom)), "…");
  const identity = theme.bold(shortName) + (tag ? theme.fg("dim", tag) : "");
  const taskRoom = width - visibleWidth(identity) - 2 - visibleWidth(suffix);
  const text =
    taskRoom > 0
      ? identity +
        "  " +
        theme.fg("muted", truncateToWidth(task, taskRoom, "…")) +
        theme.fg("dim", suffix)
      : theme.fg("muted", truncateToWidth(`${marker} ${task}`, width, "…"));
  return spanRow(text, "", width, theme, rule);
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
  const oneLineField = (label: string, value: string, color = "muted"): void => {
    out.push(
      theme.fg("dim", clipPlainText(`  ${key(label)}`, Math.max(0, width))) +
        theme.fg(color, clipPlainText(singleLineText(value), lineRoom)),
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
        : s.thinking_resolution === "preset_mapping"
          ? `${s.parent_thinking}→${s.thinking} (preset map)`
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
      `${context.tokens === null ? "unknown" : `≈${formatContextTokens(context.tokens)}`}/` +
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
      let detail = singleLineText(tool.detail ?? "…");
      if (["read", "edit", "write", "ls"].includes(name)) {
        detail = shortPath(detail, s.cwd, Math.max(0, lineRoom - visibleWidth(`${name} `)));
      }
      oneLineField(i === 0 ? "active" : "", `${name} ${detail}`, "accent");
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
  if (view.unavailable_reason) notes.push(["session", "error", view.unavailable_reason]);
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
  return truncateToWidth(
    theme.fg("borderMuted", head + POPOVER.h.repeat(Math.max(0, width - visibleWidth(head)))),
    width,
  );
}

export interface DetailFooterAction {
  kind: "stop" | "confirm";
  from: number;
  to: number;
}
/** Footer chrome only. The pane alone stores, expires, and clears this action. */
export interface DetailFooterFrame {
  text: string;
  action?: DetailFooterAction;
}

/** Pure footer layout. Confirmation lifetime and painted hit geometry stay with the pane. */
export function renderDetailFooter(input: {
  width: number;
  position: number;
  count: number;
  shown: number;
  total: number;
  view: RunView | undefined;
  available: boolean;
  confirming: boolean;
  spinnerFrame: number;
  theme: Theme;
  framed: boolean;
}): DetailFooterFrame {
  const {
    width,
    position,
    count,
    shown,
    total,
    view,
    available,
    confirming,
    spinnerFrame,
    theme: th,
    framed,
  } = input;
  const counts = th.fg(
    "dim",
    count ? `${position}/${count} agents · ${Math.min(shown, total)}/${total} lines` : "no agents",
  );
  const confirmRoom = width - visibleWidth(CONFIRM_HINT) - 1;
  const canStop =
    available &&
    view &&
    visibleWidth(renderDetailStatus(view, spinnerFrame, th, confirmRoom)) <= confirmRoom;
  const action = canStop ? (confirming ? CONFIRM_LABEL : STOP_LABEL) : "";
  const required = action && confirming ? CONFIRM_HINT : action;
  const reserved = required ? visibleWidth(required) + 1 : 0;
  const status = view ? renderDetailStatus(view, spinnerFrame, th, width - reserved) : undefined;
  const left =
    status === undefined
      ? counts
      : visibleWidth(status) + 3 + visibleWidth(counts) + reserved > width
        ? status
        : `${status}${th.fg("dim", " · ")}${counts}`;
  const navigation =
    confirming && action
      ? [CONFIRM_HELP]
      : ["←→ agent · ↑↓ scroll · Esc close", "←→ · ↑↓ · Esc", "Esc"];
  const choices = action
    ? [...navigation.map((text) => `${text} · ${action}`), ...(confirming ? [] : [action]), ""]
    : [...navigation, ""];
  const hints = choices.find((text) => visibleWidth(left) + 1 + visibleWidth(text) <= width) ?? "";
  const painted = !!action && hints.endsWith(action);
  const right = painted
    ? th.fg("dim", hints.slice(0, -action.length)) +
      (confirming ? th.bold(th.fg("warning", action)) : th.fg("dim", action))
    : th.fg("dim", hints);
  const from = (framed ? 3 : 0) + width - visibleWidth(action);
  return {
    text: spanRow(left, right, width, th, framed),
    ...(painted
      ? {
          action: {
            kind: confirming ? "confirm" : "stop",
            from,
            to: from + visibleWidth(action),
          } satisfies DetailFooterAction,
        }
      : {}),
  };
}
