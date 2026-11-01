import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunView } from "../core/contracts.js";
import { formatTokenCount } from "../../../lib/token-format.mjs";
import { plainText, singleLineText } from "./text.js";

export const GLYPHS = {
  turns: "↻", success: "✓", failure: "✗", stopped: "■", question: "?",
  subLine: "⎿", toolCall: "▸", running: "▹", queued: "◦", agentsActive: "●", agentsIdle: "○",
} as const;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export type Theme = { fg(color: string, text: string): string; bold(text: string): string };
export interface ActiveTool { name: string; detail?: string }

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
  return truncateToWidth(parts.length ? `…/${tail}` : tail, columns);
}

export function describeToolArgs(name: string, args: unknown, cwd: string, columns: number): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const str = (key: string): string | undefined => typeof input[key] === "string" ? input[key] : undefined;
  const path = (key: string): string | undefined => {
    const value = str(key);
    return value ? shortPath(value, cwd, columns) : undefined;
  };
  const bounded = (text: string): string => truncateToWidth(singleLineText(text), columns);
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
const phrase = (tool: ActiveTool, columns: number): string => {
  const name = singleLineText(tool.name), detail = tool.detail ? singleLineText(tool.detail) : "";
  const action = TOOL_ACTION[name];
  const verb = action?.verb ?? name;
  return detail ? truncateToWidth(`${verb}${action?.joiner ?? " "}${detail}`, columns) : `${verb}…`;
};

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

export function describeActivity(tools: readonly ActiveTool[], preview: string): string {
  if (tools.length === 1) return phrase(tools[0]!, 72);
  if (tools.length === 2) return tools.map((tool) => phrase(tool, 34)).join(", ");
  if (tools.length > 2) {
    const groups = new Map<string, number>();
    for (const tool of tools) {
      const name = singleLineText(tool.name);
      groups.set(name, (groups.get(name) ?? 0) + 1);
    }
    return [...groups].map(([name, count]) => {
      const action = TOOL_ACTION[name];
      return count > 1 && action?.noun ? `${action.verb} ${count} ${action.noun}` : action?.verb ?? name;
    }).join(", ") + "…";
  }
  const line = plainText(preview).split("\n").findLast((text) => text.trim())?.trim() ?? "";
  return line ? truncateToWidth(line, 72) : "thinking…";
}

/** Fold row breaks without removing already-applied theme styling. This is
 * deliberately NOT a sanitizer: raw fields must pass through plainText or
 * singleLineText before styling, measuring or assembling a rendered row. */
const ROW_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
export const withoutBreaks = (text: string): string => text.replace(ROW_BREAKS, " ");

export interface TranscriptRows {
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
