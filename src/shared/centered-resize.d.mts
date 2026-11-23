import type { ChromeTheme } from "./popover-chrome.mjs";
import type { FrameEdges } from "./popover-frame.mjs";

/** Title cells left after reserving maximize and the shared close tail. */
export function centeredPanelTitleWidth(width: number): number;

export interface ResizeMouse {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  screenX?: number;
  screenY?: number;
  width?: number;
  height?: number;
  alt?: boolean;
  ctrl?: boolean;
  shift?: boolean;
}
export interface ResizeMouseHandled {
  handled: true;
  render: false;
  capture?: never;
  target?: never;
}
export interface ResizeMouseDispatchTarget {
  component: {
    render(width: number): readonly string[];
    invalidate(): void;
    handleMouse(event: ResizeMouse): ResizeMouseHandled;
  };
  originX: number;
  originY: number;
  width: number;
  height: number;
}
export interface ResizeMouseDispatchResult {
  handled: true;
  render: false;
  capture: true;
  target: ResizeMouseDispatchTarget;
}
export type ResizeMouseResult = ResizeMouseHandled | ResizeMouseDispatchResult;
export interface CenteredResize {
  /** Undefined keeps the view's original automatic dimension. */
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly modal: boolean;
  /** Emphasize only frame-owned strokes, never glyphs in the panel's text. */
  readonly edges: FrameEdges | undefined;
  /** Publish a complete frame (or [] to retire it). Exclude user title cells from resize hits. */
  paint(lines: string[], width: number, titleColumns?: number): string[];
  input(data: string): boolean;
  /** Pass false for cells owned by other border controls; title controls still work. */
  mouse(event: ResizeMouse, allowBorder?: boolean): ResizeMouseResult | undefined;
  /** Retire old painted geometry/gestures on hide, blur, or chrome placement change. */
  reset(): void;
}
export interface CenteredPanelLayout {
  host?: object;
  theme: ChromeTheme;
  /** Repaint a grabbed/released edge without changing body geometry. */
  requestRender(): void;
  terminal(): { columns: number; rows: number };
  minWidth: number;
  minHeight: number;
  /** Keep an untouched automatic dimension content/terminal-sized instead of freezing it. */
  independentAxes?: boolean;
  /** Retire stale body input targets/selection; request another render (do not call resize.reset here). */
  changed(): void;
}
export interface ResizeToolkit {
  matchesKey(
    data: string,
    key:
      "f2" | "left" | "right" | "up" | "down" | "h" | "j" | "k" | "l" | "z" | "return" | "escape",
  ): boolean;
  visibleWidth(text: string): number;
  stripTerminalSequences(text: string): string;
  sliceByColumn(text: string, start: number, length: number): string;
  truncateToWidth(text: string, width: number, ellipsis: string, pad: boolean): string;
}
export function createCenteredResize(
  layout: CenteredPanelLayout,
  toolkit: ResizeToolkit,
): CenteredResize;
