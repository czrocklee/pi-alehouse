/** Component-local body rectangle actually rendered by the panel. */
export interface PopoverTextSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Native fullscreen text selection bounded to one painted panel body. */
export interface PopoverTextSelection {
  /** Register the body rectangle painted by the last render. `undefined`
   * retires admission until the next paint; geometry or key changes cancel
   * this member's bound native selection. */
  paint(rect: PopoverTextSelectionRect | undefined, viewportKey?: unknown): void;
  /** Retire geometry and cancel this member's bound native selection. */
  reset(): void;
  /** Cancel this member's selection and leave the shared host bridge. */
  dispose(): void;
}

/** Unsupported hosts keep ordinary native selection behavior. */
export function createPopoverTextSelection(options: {
  host?: object;
  component: object;
}): PopoverTextSelection;
