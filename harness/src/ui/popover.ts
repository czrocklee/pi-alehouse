import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { POPOVER, POPOVER_CLOSE_COLUMNS, popoverCloseHit, popoverCloseTail, popoverRule, popoverSide }
  from "../../../lib/popover-frame.mjs";
export { POPOVER, isPopoverCloseClick, popoverCloseHit, popoverSide } from "../../../lib/popover-frame.mjs";

/**
 * Rounded chrome for every harness / status popover. Top and bottom edges are
 * `borderAccent`; sides and interior dividers are `borderMuted`; a simple title
 * is `accent` and bold. The floating detail pane inlays its own title/footer
 * into the same outer edge rather than spending extra rows on bare rules.
 * A popover the pointer can reach closes from ` × ─╮` at the right end of its
 * top edge; `isPopoverCloseClick` hit-tests those same columns.
 *
 * The independent status-footer bundle shares only the neutral framing
 * primitives in pi-resources/lib, never this harness UI module.
 */

export type PopoverTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

const outer = (theme: PopoverTheme, text: string): string => theme.fg("borderAccent", text);

/** The top edge's right end: the close control when asked for and it fits. */
const topTail = (theme: PopoverTheme, width: number, closable: boolean): { text: string; width: number } =>
  closable && popoverCloseHit(width)
    ? { text: popoverCloseTail(theme), width: POPOVER_CLOSE_COLUMNS }
    : { text: outer(theme, POPOVER.tr), width: 1 };

/** `╭─ Title ─────────╮`, or `╭─ Title ───── × ─╮` when closable. */
export function popoverTitle(theme: PopoverTheme, width: number, title: string, closable = false): string {
  const tail = topTail(theme, width, closable);
  const room = Math.max(1, width - 1 - tail.width);
  const label = truncateToWidth(` ${title} `, Math.max(1, room - 1), "…");
  return outer(theme, POPOVER.tl + POPOVER.h) + theme.fg("accent", theme.bold(label)) +
    outer(theme, POPOVER.h.repeat(Math.max(0, room - visibleWidth(label) - 1))) + tail.text;
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

const inlayClosable = (width: number, kind: "top" | "bottom", closable: boolean): boolean =>
  kind === "top" && closable && !!popoverCloseHit(width);

/** Columns `popoverInlay` leaves for its inlay at this width. */
export function popoverInlayWidth(width: number, kind: "top" | "bottom", closable = false): number {
  return Math.max(0, width - (inlayClosable(width, kind, closable) ? 4 + POPOVER_CLOSE_COLUMNS : 6));
}

/**
 * Top or bottom edge with chrome inlaid between the corners. Unused columns
 * are rule, so the box cannot trail off into the conversation behind it. A
 * closable top edge ends in the close control instead of `─╮`.
 */
export function popoverInlay(theme: PopoverTheme, width: number, inlay: string, kind: "top" | "bottom",
  closable = false): string {
  const chrome = popoverInlayWidth(width, kind, closable);
  const text = truncateToWidth(inlay, chrome);
  const fill = POPOVER.h.repeat(Math.max(0, chrome - visibleWidth(text)));
  const left = outer(theme, (kind === "top" ? POPOVER.tl : POPOVER.bl) + POPOVER.h) + " " + text + " ";
  if (inlayClosable(width, kind, closable)) return left + outer(theme, fill) + popoverCloseTail(theme);
  return left + outer(theme, fill + POPOVER.h + (kind === "top" ? POPOVER.tr : POPOVER.br));
}
