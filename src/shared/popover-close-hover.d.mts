/** Optional presentation adapter; unsupported hosts retain ordinary close controls. */
export interface PopoverCloseHover {
  readonly hovered: boolean;
  /** Publish actual close visibility; geometry changes silently clear hover.
   * Omitted height preserves the previous value during preliminary layout. */
  paint(width: number, enabled?: boolean, paintedHeight?: number): void;
  /** Observe without consuming, focusing, capturing or activating any control. */
  mouse(event: { type: string; button?: string; x?: number; y?: number }): void;
  /** Retire geometry until the next paint, including during a temporary hide.
   * Pass false when the caller already owns the repaint. */
  reset(render?: boolean): void;
  dispose(): void;
}
export function createPopoverCloseHover(options: {
  host?: object;
  requestRender(): void;
  /** Shared frame hit test, injected so the tracker remains dependency-free. */
  closeHit(width: number): { x: number; width: number } | undefined;
}): PopoverCloseHover;
