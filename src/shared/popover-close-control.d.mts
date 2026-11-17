import type { PopoverCloseMouseEvent } from "./popover-close-hover.mjs";

/** Presentation-only close control: forgiving press/release gesture plus hover.
 * Unsupported hosts retain ordinary close controls, but cannot observe native
 * interruptions that are not delivered to the component. */
export interface PopoverCloseControl {
  readonly hovered: boolean;
  /** Publish actual close visibility; geometry changes silently clear hover and
   * cancel an armed gesture, suppressing its stale release/click. Omitted
   * height preserves the previous value during preliminary layout. */
  paint(width: number, enabled?: boolean, paintedHeight?: number): void;
  /** Track one gesture on the painted close hit. Returns `{ handled: true }`
   * for a claimed or consumed event, with `close` true only when the caller
   * should close now. When supplied, event width must agree with the paint
   * for both hover and gestures. `active` false clears hover and cancels and
   * consumes an old gesture without activating one. Every fresh press ends
   * prior ownership; only left can arm close. An undelivered native dispatch
   * retires ownership without claiming an unrelated selection's release, while
   * consuming the next left click at any coordinates in case native capture
   * survived the interruption. */
  mouse(
    event: PopoverCloseMouseEvent,
    active?: boolean,
  ): { handled: true; close: boolean } | undefined;
  /** Retire geometry until the next paint, including during a temporary hide.
   * A pending claimed gesture remains observed until its click or interruption.
   * Pass false when the caller already owns the repaint. */
  reset(render?: boolean): void;
  /** Detach observation permanently, while still consuming a trailing click
   * already captured by the native host for a claimed gesture. */
  dispose(): void;
}
export function createPopoverCloseControl(options: {
  host?: object;
  requestRender(): void;
  /** Shared frame hit test used for both hover and gestures. */
  closeHit(width: number): { x: number; width: number; y?: number } | undefined;
}): PopoverCloseControl;
