import { visibleWidth } from "@earendil-works/pi-tui";
import { shortcutHint } from "../../shared/shortcut-hint.mjs";
import { POPOVER } from "./popover.ts";
import type { Theme } from "./format.ts";
import { clipPlainText } from "./text.ts";

export type DetailActionsItem = {
  kind: "info" | "transcript" | "tools";
  y: number;
  from: number;
  to: number;
};

export type DetailActionsMenu = {
  rows: string[];
  items: DetailActionsItem[];
  /** The popup's left edge in viewport columns: everything left of it is
   * untouched padding, so a caller can overlay from here and keep the
   * underlying transcript visible. */
  from: number;
};

type DetailActionsTheme = Pick<Theme, "fg" | "bold" | "underline">;

const MIN_WIDTH = 16;
const MIN_HEIGHT = 2;

const wholeCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value >= 1 ? Math.floor(value) : 0;
};

/** The first candidate whose hinted paint fits `columns` cells wins; the bare
 * base clips only as an unreachable-at-valid-sizes last resort. All fitting
 * measures cells, never code points, so CJK and styled text keep their
 * geometry. */
const fitHint = (
  theme: DetailActionsTheme,
  candidates: string[],
  base: string,
  key: string,
  columns: number,
): string =>
  candidates.find((label) => visibleWidth(shortcutHint(theme, label, key)) <= columns) ??
  clipPlainText(base, columns);

/**
 * The detail pane's compact actions menu, anchored at the RIGHT of the
 * available content viewport. Two options: the page that is not shown
 * (`Info`, carrying ` +N` attention diagnostics when any exist, or
 * `Transcript` while the Info page is open; shortcut I) and the tools
 * toggle (`Expand tools` / `Collapse tools`; shortcut T). Each option paints
 * its mnemonic inline when the label contains it (`Info`, `Transcript`,
 * `Expand tools`), otherwise as an explicit key prefix; there is no bracket
 * keycap or duplicated trailing letter. Narrowing drops whole words (never
 * an ellipsis) before any hint is lost, so the width floor keeps a readable
 * `Tools` option. The numeric `+N` count is still dropped whole rather than
 * clipped into a partial fact. The selected row paints accent and bold and
 * underlines its mnemonic when the host theme supports it; the other is muted
 * with an accented mnemonic. With room for a frame
 * (`height >= 4`) the menu is a compact rounded box; below that it degrades
 * to a borderless two-row menu with safely bounded labels.
 *
 * Every returned row spans the full viewport width, left-padded with spaces;
 * `from` reports the popup's left edge (boxed: the box's left border,
 * borderless: the leftmost option start), so a caller can overlay only the
 * columns from there onward and keep the underlying transcript visible.
 * Items carry the exact visible-cell range of each option's label and hint
 * within that width; padding and box borders are never part of a target.
 * Returns undefined for invalid or too-small dimensions rather than painting
 * a fragment.
 *
 * `hiddenNotes` is the caller's diagnostic overflow count -- notes the pane
 * could not pin as rows -- supplied separately rather than recomputed here.
 * It is painted whole as ` +N` on the Info option only while Info is not
 * shown, and never clipped into a partial fact. The caller owns the fallback
 * cue for the case where no note row was painted at all.
 */
export function renderDetailActionsMenu(input: {
  width: number;
  height: number;
  info: boolean;
  toolsExpanded: boolean;
  hiddenNotes?: number;
  selected?: number;
  theme: DetailActionsTheme;
}): DetailActionsMenu | undefined {
  const width = typeof input.width === "number" ? Math.floor(input.width) : Number.NaN;
  const height = typeof input.height === "number" ? Math.floor(input.height) : Number.NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return undefined;
  const { theme: th, info, toolsExpanded } = input;
  const hidden = wholeCount(input.hiddenNotes);
  const selected = input.selected === 1 ? 1 : 0;
  // Row 0 offers the page that is not shown; row 1 toggles tool expansion.
  // Only Info carries the attention count, and only when it is not shown.
  const page = info ? "Transcript" : "Info";
  const counted = page + (!info && hidden ? ` +${hidden}` : "");
  const tools = toolsExpanded ? "Collapse tools" : "Expand tools";
  const kinds: DetailActionsItem["kind"][] = [info ? "transcript" : "info", "tools"];
  // Hinted options, widest first. The mnemonic is inline when the label owns
  // it; otherwise it stays an explicit prefix. Narrowing drops whole words —
  // the attention count only goes whole.
  const pageOptions = [counted, page];
  const toolsOptions = [tools, "Tools"];
  const hintedWidth = (label: string, key: string): number =>
    visibleWidth(shortcutHint(th, label, key));
  // Keep the selected row accent/bold while its mnemonic stays identifiable:
  // the body is bold, and the key adds underline when the host theme has it.
  const selectedTheme = {
    fg: (color: string, text: string) => th.bold(th.fg(color, text)),
    bold: (text: string) => (th.underline ? th.bold(th.underline(text)) : th.bold(text)),
  };
  const paint = (label: string, key: string, active: boolean): string =>
    active
      ? shortcutHint(selectedTheme, label, key, { color: "accent", keyColor: "accent" })
      : shortcutHint(th, label, key);

  const boxed = height >= 4;
  // The compact box hugs its widest hinted option; the viewport caps it.
  // Inside the box a one-cell pad separates each option from the border,
  // which never targets.
  const box = boxed
    ? Math.min(
        width,
        Math.max(hintedWidth(pageOptions[0]!, "I"), hintedWidth(toolsOptions[0]!, "T")) + 4,
      )
    : width;
  const columns = box - (boxed ? 4 : 0);
  const options = [
    paint(fitHint(th, pageOptions, page, "I", columns), "I", selected === 0),
    paint(fitHint(th, toolsOptions, tools, "T", columns), "T", selected === 1),
  ];

  const rows: string[] = [];
  const items: DetailActionsItem[] = [];
  let from: number;
  if (boxed) {
    from = width - box;
    const pad = " ".repeat(Math.max(0, from));
    const edge = (left: string, right: string): string =>
      th.fg("borderAccent", left + POPOVER.h.repeat(box - 2) + right);
    const side = th.fg("borderMuted", POPOVER.v);
    rows.push(pad + edge(POPOVER.tl, POPOVER.tr));
    options.forEach((option, index) => {
      const from = width - box + 2;
      items.push({ kind: kinds[index]!, y: index + 1, from, to: from + visibleWidth(option) });
      rows.push(
        pad +
          side +
          " " +
          option +
          " ".repeat(Math.max(0, columns - visibleWidth(option))) +
          " " +
          side,
      );
    });
    rows.push(pad + edge(POPOVER.bl, POPOVER.br));
  } else {
    from = width;
    options.forEach((option, index) => {
      const start = Math.max(0, width - visibleWidth(option));
      from = Math.min(from, start);
      items.push({ kind: kinds[index]!, y: index, from: start, to: width });
      rows.push(" ".repeat(start) + option);
    });
  }
  return { rows, items, from };
}
