/** Optional presentation adapter; unsupported hosts retain ordinary close controls. */
export interface PopoverCloseHover {
  readonly hovered: boolean;
  /** Publish actual close visibility; geometry changes silently clear hover.
   * Omitted height preserves the previous value during preliminary layout. */
  paint(width: number, enabled?: boolean, paintedHeight?: number): void;
  /** Observe without consuming, focusing, capturing or activating any control.
   * Every event acknowledges delivery within the current native dispatch. */
  mouse(event: { type: string; button?: string; x?: number; y?: number }): void;
  /** Observe native dispatch even without hover. A dispatch not delivering a
   * mouse event to this tracker calls onGestureInterrupted. No raw input parsing
   * or additional global input listener is installed. */
  watchGesture(active: boolean): void;
  /** Retire geometry until the next paint, including during a temporary hide.
   * Gesture observation is independent and remains active while requested.
   * Pass false when the caller already owns the repaint. */
  reset(render?: boolean): void;
  dispose(): void;
}
export function createPopoverCloseHover(options: {
  host?: object;
  requestRender(): void;
  /** Shared frame hit test, injected so the tracker remains dependency-free. */
  closeHit(width: number): { x: number; width: number } | undefined;
  /** Best-effort interruption notification; callback errors cannot affect input. */
  onGestureInterrupted?(): void;
}): PopoverCloseHover;
