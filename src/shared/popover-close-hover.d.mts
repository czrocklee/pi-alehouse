/** Best-effort native interruption observation for a captured press. */
export function watchPopoverCapture(
  host: object | undefined,
  component: object,
  lost: (redraw: boolean) => void,
): { current(): boolean; held(): boolean; dispose(): void } | undefined;

export interface PopoverCloseMouseEvent {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  width?: number;
}

/** Single painted hit for gestures and optional native hover feedback. */
export interface PopoverCloseHover {
  readonly hovered: boolean;
  /** Publish actual close visibility; return true if geometry changed or is
   * unavailable. Clear hover silently on change. Omitted height preserves the
   * previous value during preliminary layout. */
  paint(width: number, enabled?: boolean, paintedHeight?: number): boolean;
  /** Acknowledge every delivered event without consuming, focusing or capturing.
   * Return whether an active event matches the live painted hit, including width
   * when supplied. Only button-free moves can show native hover feedback, and
   * missing native support does not affect the returned hit. */
  mouse(event: PopoverCloseMouseEvent, active?: boolean): boolean;
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
  closeHit(width: number): { x: number; width: number; y?: number } | undefined;
  /** Best-effort interruption notification; callback errors cannot affect input. */
  onGestureInterrupted?(): void;
}): PopoverCloseHover;
