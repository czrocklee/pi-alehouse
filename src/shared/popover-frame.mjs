/** Pure framing primitives shared by separately bundled Pi extensions.
 * No SDK import or mutable runtime state: consumers provide their own theme. */
export const POPOVER = Object.freeze({
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  v: "│",
  h: "─",
  ml: "├",
  mr: "┤",
  close: "✕",
});

/** Every popover closes from the right end of its top edge: `╭─ Title ─ ✕ ─╮`.
 * These are the layout columns of the ` ✕ ─╮` tail; only the glyph is a hit. */
export const POPOVER_CLOSE_COLUMNS = 5;
/** Narrower than this, an inlaid edge (`╭─ … ✕ ─╮`) has no room left for the
 * control; the popover then paints none, rather than a fragment that cannot be
 * hit. Titles and inlays share the bound so hit tests need not know which. */
const MIN_CLOSABLE_WIDTH = 9;

/** @typedef {Readonly<{ top: boolean, bottom: boolean, left: boolean, right: boolean }>} FrameEdges */
/** @typedef {{ fg: (color: "borderAccent" | "borderMuted", text: string) => string }} FrameTheme */
/** @typedef {{ fg: (color: "borderAccent" | "muted" | "accent", text: string) => string, bold?: (text: string) => string }} CloseTheme */

/** @param {boolean | undefined} emphasized */
const sideGlyph = (emphasized) => (emphasized ? "║" : POPOVER.v);

/** Select only the glyphs owned by the frame. Corners match both adjacent
 * edges; dividers join the sides but keep their own horizontal rule thin.
 * @param {FrameEdges} [edges]
 */
export function frameGlyphs(edges) {
  const { top, bottom, left, right } = edges ?? {};
  return {
    tl: top ? (left ? "╔" : "╒") : left ? "╓" : POPOVER.tl,
    tr: top ? (right ? "╗" : "╕") : right ? "╖" : POPOVER.tr,
    bl: bottom ? (left ? "╚" : "╘") : left ? "╙" : POPOVER.bl,
    br: bottom ? (right ? "╝" : "╛") : right ? "╜" : POPOVER.br,
    top: top ? "═" : POPOVER.h,
    bottom: bottom ? "═" : POPOVER.h,
    left: sideGlyph(left),
    right: sideGlyph(right),
    ml: left ? "╟" : POPOVER.ml,
    mr: right ? "╢" : POPOVER.mr,
  };
}

/**
 * @param {FrameTheme} theme
 * @param {number} width
 * @param {"top" | "bottom" | "divider"} kind
 * @param {FrameEdges} [edges]
 */
export function popoverRule(theme, width, kind, edges) {
  if (width <= 0) return "";
  const { tl, tr, bl, br, top, bottom, ml, mr } = frameGlyphs(edges);
  /** @type {[string, string, string, "borderAccent" | "borderMuted"]} */
  const [left, rule, right, color] =
    kind === "top"
      ? [tl, top, tr, "borderAccent"]
      : kind === "bottom"
        ? [bl, bottom, br, "borderAccent"]
        : [ml, POPOVER.h, mr, "borderMuted"];
  if (width === 1) return theme.fg(color, rule);
  return theme.fg(color, left + rule.repeat(Math.max(0, width - 2)) + right);
}

/**
 * @param {FrameTheme} theme
 * @param {FrameEdges} [edges]
 * @param {"left" | "right"} [side]
 */
export function popoverSide(theme, edges, side = "left") {
  return theme.fg("borderMuted", sideGlyph(edges?.[side]));
}

/**
 * The close glyph's single cell on row 0 of a popover painted `width` columns
 * wide, or undefined when it is too narrow to carry one. Painting and hit
 * testing both ask this, so they cannot disagree about where the control is.
 * @param {number} width
 * @returns {{ x: number, width: number } | undefined}
 */
export function popoverCloseHit(width) {
  return width >= MIN_CLOSABLE_WIDTH
    ? { x: width - POPOVER_CLOSE_COLUMNS + 1, width: 1 }
    : undefined;
}

/** The top edge's closing tail, ` ✕ ─╮`, exactly POPOVER_CLOSE_COLUMNS wide.
 * Hover changes only the glyph's emphasis, never the border or hit geometry.
 * @param {CloseTheme} theme
 * @param {boolean} [hovered]
 * @param {FrameEdges} [edges]
 */
export function popoverCloseTail(theme, hovered = false, edges) {
  const { top, tr } = frameGlyphs(edges);
  const glyph = hovered ? (theme.bold?.(POPOVER.close) ?? POPOVER.close) : POPOVER.close;
  return (
    " " + theme.fg(hovered ? "accent" : "muted", glyph) + " " + theme.fg("borderAccent", top + tr)
  );
}

/** Shared simple title edge, without inlaid actions or additional hit targets.
 * Consumers supply terminal metrics so this leaf has no SDK dependency.
 * Always exactly `width` columns (empty at 0 or less): below room for a
 * one-column label it degrades to a bare edge instead of overflowing.
 * @param {{fg: (color: "borderAccent" | "muted" | "accent", text: string) => string, bold: (text: string) => string}} theme
 * @param {number} width
 * @param {string} title
 * @param {{clip: (text: string, columns: number) => string, width: (text: string) => number}} metrics
 * @param {boolean} [closable]
 * @param {boolean} [closeHovered]
 * @param {FrameEdges} [edges]
 */
export function popoverTitleRow(
  theme,
  width,
  title,
  metrics,
  closable = false,
  closeHovered = false,
  edges,
) {
  if (width <= 0) return "";
  const { tl, tr, top } = frameGlyphs(edges);
  const close = closable && !!popoverCloseHit(width);
  const tailWidth = close ? POPOVER_CLOSE_COLUMNS : 1;
  if (width < tailWidth + 3) {
    if (width === 1) return theme.fg("borderAccent", top);
    return theme.fg("borderAccent", tl + top.repeat(width - 2) + tr);
  }
  const room = width - 1 - tailWidth;
  const label = metrics.clip(` ${title} `, Math.max(1, room - 1));
  return (
    theme.fg("borderAccent", tl + top) +
    theme.fg("accent", theme.bold(label)) +
    theme.fg("borderAccent", top.repeat(Math.max(0, room - metrics.width(label) - 1))) +
    (close ? popoverCloseTail(theme, closeHovered, edges) : theme.fg("borderAccent", tr))
  );
}

/**
 * Low-level border-only click helper for `popoverTitleRow` (row 0), not a
 * placement-aware panel control. Interactive panels use
 * `createPopoverCloseControl` with `popoverChromeCloseHit` instead, so inset
 * rows and press/release cancellation share painted geometry.
 * `width` is what the popover last painted at, never the event's own bounds,
 * which a renderer may have clipped.
 * @param {{ type: string, button?: string, x: number, y: number }} event
 * @param {number} width
 */
export function isPopoverCloseClick(event, width) {
  const hit = popoverCloseHit(width);
  return (
    !!hit &&
    event.type === "click" &&
    event.button === "left" &&
    event.y === 0 &&
    event.x >= hit.x &&
    event.x < hit.x + hit.width
  );
}
