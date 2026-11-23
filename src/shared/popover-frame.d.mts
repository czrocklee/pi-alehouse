export const POPOVER: Readonly<{
  tl: "╭";
  tr: "╮";
  bl: "╰";
  br: "╯";
  v: "│";
  h: "─";
  ml: "├";
  mr: "┤";
  close: "✕";
}>;
export const POPOVER_CLOSE_COLUMNS: 5;

/** Which outer edges are emphasized in a frame paint. */
export type FrameEdges = {
  readonly top: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
  readonly right: boolean;
};
export function frameGlyphs(edges?: FrameEdges): {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  top: string;
  bottom: string;
  left: string;
  right: string;
  ml: string;
  mr: string;
};

export interface FrameTheme {
  fg(color: "borderAccent" | "borderMuted", text: string): string;
}
export function popoverRule(
  theme: FrameTheme,
  width: number,
  kind: "top" | "bottom" | "divider",
  edges?: FrameEdges,
): string;
export function popoverSide(theme: FrameTheme, edges?: FrameEdges, side?: "left" | "right"): string;
export interface CloseTheme {
  fg(color: "borderAccent" | "muted" | "accent", text: string): string;
  bold?(text: string): string;
}
export function popoverCloseHit(width: number): { x: number; width: number } | undefined;
export function popoverCloseTail(theme: CloseTheme, hovered?: boolean, edges?: FrameEdges): string;
export function popoverTitleRow(
  theme: {
    fg(color: "borderAccent" | "muted" | "accent", text: string): string;
    bold(text: string): string;
  },
  width: number,
  title: string,
  metrics: { clip(text: string, columns: number): string; width(text: string): number },
  closable?: boolean,
  closeHovered?: boolean,
  edges?: FrameEdges,
): string;
/** Border-only row-0 primitive. Panels use createPopoverCloseControl with
 * popoverChromeCloseHit for placement-aware painted gestures. */
export function isPopoverCloseClick(
  event: { type: string; button?: string; x: number; y: number },
  width: number,
): boolean;
