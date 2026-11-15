import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { popoverRule, popoverSide, popoverTitleRow } from "../../shared/popover-frame.mjs";
import {
  popoverInlay as sharedPopoverInlay,
  popoverInlayWidth as sharedPopoverInlayWidth,
  popoverLabelRows as sharedPopoverLabelRows,
  popoverTitleRows as sharedPopoverTitleRows,
} from "../../shared/popover-chrome.mjs";

export { POPOVER, popoverCloseHit, popoverSide } from "../../shared/popover-frame.mjs";
export { popoverChromeCloseHit } from "../../shared/popover-chrome.mjs";

/**
 * Rounded chrome for every orchestration / status popover. Top and bottom edges are
 * `borderAccent`; sides and interior dividers are `borderMuted`; a simple title
 * is `accent` and bold. The floating detail pane inlays its own title/footer
 * into the same outer edge rather than spending extra rows on bare rules.
 * A popover the pointer can reach closes from its top chrome: the ` ✕ ─╮`
 * tail of the inlaid edge, or the close cell of the inner title row when the
 * process-wide border-label switch is off. `popoverChromeCloseHit` supplies
 * the glyph's single-cell geometry including its row; consumers use the shared
 * close control to own press/release gestures.
 *
 * This module only adapts the SDK-free shared chrome primitives (and the
 * legacy inlaid edge they centralized) to Pi's terminal metrics. The
 * independent status-footer bundle shares only the neutral framing
 * primitives in src/shared, never this Alehouse UI module.
 */

export type PopoverTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** Pi terminal metrics for the shared, SDK-free chrome primitives. */
const metrics = {
  clip: (text: string, columns: number) => truncateToWidth(text, columns, "…"),
  width: (text: string) => visibleWidth(text),
};
/** Inlays historically use the SDK's default three-cell ellipsis; titles
 * deliberately use the single-cell variant above. Keep that distinction. */
const inlayMetrics = {
  ...metrics,
  clip: (text: string, columns: number) => truncateToWidth(text, columns),
};

/** `╭─ Title ─────────╮`, or `╭─ Title ───── ✕ ─╮` when closable. */
export function popoverTitle(
  theme: PopoverTheme,
  width: number,
  title: string,
  closable = false,
  closeHovered = false,
): string {
  return popoverTitleRow(theme, width, title, metrics, closable, closeHovered);
}

/**
 * Title chrome under the process-wide border-label switch: the inlaid edge row
 * when labels are on, or a bare top edge, an inner title row (with the close
 * cell when closable) and a separator when labels are off. The outer border is
 * retained either way; only its labels move.
 */
export function popoverTitleRows(
  theme: PopoverTheme,
  width: number,
  title: string,
  closable = false,
  closeHovered = false,
): string[] {
  return sharedPopoverTitleRows(theme, width, title, metrics, closable, closeHovered);
}

export function popoverBottom(theme: PopoverTheme, width: number): string {
  return popoverRule(theme, width, "bottom");
}

export function popoverDivider(theme: PopoverTheme, width: number): string {
  return popoverRule(theme, width, "divider");
}

export function popoverRow(theme: PopoverTheme, content: string, width: number): string {
  const border = popoverSide(theme);
  return border + truncateToWidth(content, Math.max(0, width), "…", true) + border;
}

/**
 * Labeled edge chrome under the same switch: the legacy inlaid edge row when
 * labels are on, or a separator, an inner label row and a bare edge when
 * labels are off. `styledLabel` arrives pre-styled; only its columns matter.
 */
export function popoverLabelRows(
  theme: PopoverTheme,
  width: number,
  styledLabel: string,
  kind: "top" | "bottom",
  closable = false,
  closeHovered = false,
  flush: { start?: boolean; end?: boolean } = {},
): string[] {
  return sharedPopoverLabelRows(theme, width, styledLabel, kind, inlayMetrics, {
    closable,
    closeHovered,
    flush,
  });
}

/** Columns `popoverInlay` leaves for its inlay at this width. */
export function popoverInlayWidth(width: number, kind: "top" | "bottom", closable = false): number {
  return sharedPopoverInlayWidth(width, kind, closable);
}

/**
 * Top or bottom edge with chrome inlaid between the corners, exactly as
 * before the shared centralization. Unused columns are rule, so the box
 * cannot trail off into the conversation behind it. A closable top edge
 * ends in the close control instead of `─╮`. An inlay that begins
 * (`flush.start`) or ends (`flush.end`) in rule of its own has that pad
 * column drawn as rule too, so the edge meets the corner unbroken while
 * every inlay column stays put.
 */
export function popoverInlay(
  theme: PopoverTheme,
  width: number,
  inlay: string,
  kind: "top" | "bottom",
  closable = false,
  closeHovered = false,
  flush: { start?: boolean; end?: boolean } = {},
): string {
  return sharedPopoverInlay(theme, width, inlay, kind, inlayMetrics, closable, closeHovered, flush);
}
