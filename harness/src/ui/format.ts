import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunView } from "../core/contracts.ts";
import { formatTokenCount } from "../../../lib/token-format.mjs";
import type { ActiveTool, GenerationPreview } from "../runtime/activity-types.ts";
import { clipPlainText, previewText, singleLineText } from "./text.ts";

export const GLYPHS = {
  turns: "↻", success: "✓", failure: "✗", stopped: "■", question: "?",
  subLine: "⎿", toolCall: "▸", running: "▹", queued: "◦", agentsActive: "●", agentsIdle: "○",
} as const;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export type Theme = { fg(color: string, text: string): string; bold(text: string): string };

const TOOL_ACTION: Record<string, { verb: string; noun?: string; joiner?: string }> = {
  read: { verb: "reading", noun: "files" }, bash: { verb: "running", noun: "commands" },
  edit: { verb: "editing", noun: "files" }, write: { verb: "writing", noun: "files" },
  grep: { verb: "searching", noun: "patterns" }, find: { verb: "finding", noun: "patterns" },
  ls: { verb: "listing", noun: "directories" },
  ask_parent: { verb: "asking you", joiner: ": " }, alert_parent: { verb: "alerting you", joiner: ": " },
  // Historical journals only: display the retired name without registering it.
  notify_parent: { verb: "notifying you", joiner: ": " },
};
export function shortPath(value: string, cwd: string, columns: number): string {
  const path = singleLineText(value), base = singleLineText(cwd);
  const relative = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
  if (visibleWidth(relative) <= columns) return relative;
  const parts = relative.split("/");
  let tail = parts.pop() ?? relative;
  while (parts.length && visibleWidth(`…/${parts[parts.length - 1]}/${tail}`) <= columns) tail = `${parts.pop()}/${tail}`;
  return clipPlainText(parts.length ? `…/${tail}` : tail, columns);
}

export function describeToolArgs(name: string, args: unknown, cwd: string, columns: number): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const str = (key: string): string | undefined => typeof input[key] === "string" ? input[key] : undefined;
  const path = (key: string): string | undefined => {
    const value = str(key);
    return value ? shortPath(value, cwd, columns) : undefined;
  };
  const bounded = (text: string): string => clipPlainText(singleLineText(text), columns);
  switch (singleLineText(name)) {
    case "read": case "edit": case "write": return path("path");
    case "ls": return path("path") ?? ".";
    case "bash": { const command = str("command"); return command ? bounded(command) : undefined; }
    case "grep": case "find": {
      const pattern = str("pattern");
      if (!pattern) return undefined;
      const where = path("path") ?? str("glob");
      return bounded(`"${pattern}"${where ? ` in ${where}` : ""}`);
    }
    case "ask_parent": { const question = str("question"); return question ? bounded(question) : undefined; }
    case "alert_parent": case "notify_parent": { const message = str("message"); return message ? bounded(message) : undefined; }
    default: return undefined;
  }
}
interface ActivityPart { action: string; detail?: string; path?: boolean }

/** Compact prose only. Simplify leading Markdown, never inline code, globs or
 * arithmetic. Removing an unfinished leading ** also keeps its left edge steady
 * when the matching closing marker arrives. */
export function generationLine(text: string): string {
  const line = previewText(text).split("\n").findLast((part) => part.trim())?.trim() ?? "";
  return line.replace(/^(?:#{1,6}\s+|[-+*]\s+|\d{1,3}[.)]\s+)/, "")
    .replace(/^\*\*((?=[\p{L}\p{N}])\S(?:[^*]*\S)?)\*\*/u, "$1")
    .replace(/^\*\*(?=[\p{L}\p{N}])/u, "");
}

function activityParts(tools: readonly ActiveTool[], live: GenerationPreview): ActivityPart[] {
  if (tools.length <= 2 && tools.length > 0) return tools.map((tool) => {
    const name = singleLineText(tool.name), detail = tool.detail ? singleLineText(tool.detail) : "";
    const action = TOOL_ACTION[name];
    return { action: `${action?.verb ?? name}${detail ? action?.joiner ?? " " : "…"}`, detail,
      path: ["read", "edit", "write", "ls"].includes(name) };
  });
  if (tools.length > 2) {
    const groups = new Map<string, number>();
    for (const tool of tools) {
      const name = singleLineText(tool.name);
      groups.set(name, (groups.get(name) ?? 0) + 1);
    }
    const parts = [...groups].map(([name, count]): ActivityPart => {
      const action = TOOL_ACTION[name];
      return { action: action?.verb ?? name, detail: count > 1 && action?.noun ? ` ${count} ${action.noun}` : "" };
    });
    parts[parts.length - 1]!.detail += "…";
    return parts;
  }
  if (live.preparing_tool !== undefined) return [{ action: "preparing ", detail: `${singleLineText(live.preparing_tool) || "tool"}…` }];
  if (!live.channel) return [{ action: "thinking…" }];
  const thinking = live.channel === "thinking";
  const line = generationLine(thinking ? live.thinking ?? "" : live.preview);
  return line ? [{ action: thinking ? "thinking: " : "replying: ", detail: line }] :
    [{ action: thinking ? "thinking…" : "replying…" }];
}

/** Small calls get their natural width; the remaining columns go to long calls
 * rather than reserving an unused half-row for e.g. `reading a.ts`. */
function activityWidths(parts: readonly ActivityPart[], columns: number): number[] {
  const available = Math.max(0, columns - (parts.length - 1) * 2);
  const widths = parts.map((part) => visibleWidth(part.action + (part.detail ?? "")));
  if (widths.reduce((sum, width) => sum + width, 0) <= available) return widths;
  const result = new Array<number>(parts.length).fill(0);
  let remaining = available, count = parts.length;
  for (const index of widths.map((_, index) => index).sort((a, b) => widths[a]! - widths[b]!)) {
    const room = Math.min(widths[index]!, Math.floor(remaining / count));
    result[index] = room;
    remaining -= room;
    count--;
  }
  return result;
}

function activityText(parts: readonly ActivityPart[], columns: number, theme: Theme): string {
  if (columns < (parts.length - 1) * 2) return theme.fg("dim", clipPlainText(
    parts.map((part) => part.action + (part.detail ?? "")).join(", "), columns));
  const widths = activityWidths(parts, columns);
  return parts.map((part, index) => {
    const room = widths[index]!;
    const detailRoom = Math.max(0, room - visibleWidth(part.action));
    const detail = part.path && part.detail ? shortPath(part.detail, "", detailRoom) : part.detail ?? "";
    const clipped = clipPlainText(part.action + detail, room);
    const action = clipped.startsWith(part.action) ? part.action : clipped;
    // Clip plain strings first, then color every visible cell, including ….
    return theme.fg("dim", action) + (clipped.length > action.length ? theme.fg("muted", clipped.slice(action.length)) : "");
  }).join(theme.fg("dim", ", "));
}

export const formatTokens = (count: number, unit = " token"): string =>
  formatTokenCount(count, { precision: "detailed" }) + unit;
export function formatContextPercent(context: NonNullable<RunView["runtime"]>["context"]): string {
  if (context?.tokens == null || !Number.isSafeInteger(context.tokens) || context.tokens < 0 ||
      !Number.isSafeInteger(context.context_window) || context.context_window <= 0) return "?";
  return `${((context.tokens / context.context_window) * 100).toFixed(1)}%`;
}
export const formatContextTokens = (count: number): string =>
  formatTokenCount(count, { precision: "compact", trimKZero: true });
export function formatMs(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}
export const formatDrain = (drain: NonNullable<RunView["drain"]>): string =>
  `draining ${formatMs(drain.elapsed_ms)} · awaiting ${drain.waiting_for === "sdk_idle" ? "SDK idle" : "tracked inputs/abort"}`;
export const formatCost = (cost: number): string => `$${cost.toFixed(3)}`;
export const formatTurns = (turns: number, max: number): string => `${GLYPHS.turns}${turns}≤${max}`;

/** The sole activity rendering path, shared by production and regression tests.
 * Snapshots contain plain observations; styling and width decisions happen here. */
export function renderActivity(tools: readonly ActiveTool[], live: GenerationPreview, theme: Theme, columns: number): string {
  const width = columns === Infinity ? Infinity : Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  return activityText(activityParts(tools, live), width, theme);
}

/** Fold row breaks without removing already-applied theme styling. This is
 * deliberately NOT a sanitizer: raw fields must pass through plainText or
 * singleLineText before styling, measuring or assembling a rendered row. */
const ROW_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
export const withoutBreaks = (text: string): string => text.replace(ROW_BREAKS, " ");

export interface TranscriptFrame {
  readonly lineCount: number;
  slice(start: number, count: number): string[];
}
export interface TranscriptRows {
  /** Capture settled history and the streaming tail once for a pane frame. */
  frame?(width: number): TranscriptFrame;
  lineCount(width: number): number;
  slice(width: number, start: number, count: number): string[];
  invalidate(): void;
}
/**
 * OSC 133 zone markers, as Pi's message components emit them
 * (`assistant-message.js`, `user-message.js`). They tell a terminal where a
 * conversation turn begins and ends, so it can offer "jump to previous prompt".
 *
 * True of the main conversation, which emits each marker once as it appends.
 * False here: a pane re-emits its visible rows on every scroll and on every
 * frame of a streaming reply, which would fill the terminal's mark list with
 * prompt positions that are really just rows of a scrolling viewport. They
 * carry no visual meaning, so they go. OSC 8 hyperlinks stay — those are content.
 */
// eslint-disable-next-line no-control-regex -- intentionally match terminal OSC control sequences
const OSC133 = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;
/** One row as the pane paints it: no turn markers, clipped to the width. */
export const paneRow = (line: string, width: number): string =>
  truncateToWidth(line.replace(OSC133, ""), width);
