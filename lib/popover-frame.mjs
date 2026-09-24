/** Pure framing primitives shared by separately bundled Pi extensions.
 * No SDK import or mutable runtime state: consumers provide their own theme. */
export const POPOVER = Object.freeze({
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  v: "│", h: "─", ml: "├", mr: "┤",
  close: "×",
});

/** Every popover closes from the right end of its top edge: `╭─ Title ─ × ─╮`.
 * These are the columns of that ` × ─╮` tail, which is also the hit area. */
export const POPOVER_CLOSE_COLUMNS = 5;
/** Narrower than this, an inlaid edge (`╭─ … × ─╮`) has no room left for the
 * control; the popover then paints none, rather than a fragment that cannot be
 * hit. Titles and inlays share the bound so hit tests need not know which. */
const MIN_CLOSABLE_WIDTH = 9;

/** @typedef {{ fg: (color: "borderAccent" | "borderMuted", text: string) => string }} FrameTheme */
/** @typedef {{ fg: (color: "borderAccent" | "muted", text: string) => string }} CloseTheme */

/**
 * @param {FrameTheme} theme
 * @param {number} width
 * @param {"top" | "bottom" | "divider"} kind
 */
export function popoverRule(theme, width, kind) {
  /** @type {[string, string, "borderAccent" | "borderMuted"]} */
  const [left, right, color] = kind === "top" ? [POPOVER.tl, POPOVER.tr, "borderAccent"]
    : kind === "bottom" ? [POPOVER.bl, POPOVER.br, "borderAccent"]
    : [POPOVER.ml, POPOVER.mr, "borderMuted"];
  return theme.fg(color, left + POPOVER.h.repeat(Math.max(0, width - 2)) + right);
}

/** @param {FrameTheme} theme */
export function popoverSide(theme) {
  return theme.fg("borderMuted", POPOVER.v);
}

/**
 * The close control's columns on row 0 of a popover painted `width` columns
 * wide, or undefined when it is too narrow to carry one. Painting and hit
 * testing both ask this, so they cannot disagree about where the control is.
 * @param {number} width
 * @returns {{ x: number, width: number } | undefined}
 */
export function popoverCloseHit(width) {
  return width >= MIN_CLOSABLE_WIDTH ? { x: width - POPOVER_CLOSE_COLUMNS, width: POPOVER_CLOSE_COLUMNS } : undefined;
}

/** The top edge's closing tail, ` × ─╮`, exactly POPOVER_CLOSE_COLUMNS wide.
 * @param {CloseTheme} theme */
export function popoverCloseTail(theme) {
  return " " + theme.fg("muted", POPOVER.close) + " " + theme.fg("borderAccent", POPOVER.h + POPOVER.tr);
}

/**
 * A left click on the close control. `width` is what the popover last painted
 * at, never the event's own bounds, which a renderer may have clipped.
 * @param {{ type: string, button?: string, x: number, y: number }} event
 * @param {number} width
 */
export function isPopoverCloseClick(event, width) {
  const hit = popoverCloseHit(width);
  return !!hit && event.type === "click" && event.button === "left" && event.y === 0 &&
    event.x >= hit.x && event.x < hit.x + hit.width;
}
