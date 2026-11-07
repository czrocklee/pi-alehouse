export const POPOVER: Readonly<{
  tl: "╭";
  tr: "╮";
  bl: "╰";
  br: "╯";
  v: "│";
  h: "─";
  ml: "├";
  mr: "┤";
  close: "×";
}>;
export const POPOVER_CLOSE_COLUMNS: 5;
export interface FrameTheme {
  fg(color: "borderAccent" | "borderMuted", text: string): string;
}
export function popoverRule(
  theme: FrameTheme,
  width: number,
  kind: "top" | "bottom" | "divider",
): string;
export function popoverSide(theme: FrameTheme): string;
export interface CloseTheme {
  fg(color: "borderAccent" | "muted", text: string): string;
}
export function popoverCloseHit(width: number): { x: number; width: number } | undefined;
export function popoverCloseTail(theme: CloseTheme): string;
export function popoverTitleRow(
  theme: {
    fg(color: "borderAccent" | "muted" | "accent", text: string): string;
    bold(text: string): string;
  },
  width: number,
  title: string,
  metrics: { clip(text: string, columns: number): string; width(text: string): number },
  closable?: boolean,
): string;
export function isPopoverCloseClick(
  event: { type: string; button?: string; x: number; y: number },
  width: number,
): boolean;
