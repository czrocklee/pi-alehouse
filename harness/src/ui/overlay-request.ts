/**
 * Pi's `ui.custom` completion pops the TOP of the global overlay stack rather
 * than the handle it was handed. A newer non-capturing overlay -- the status
 * footer's spend panel, say -- would therefore be popped in place of the panel
 * that actually finished, stranding the disposed one on screen. Every harness
 * panel announces this channel before it settles so cooperating extensions can
 * step aside first.
 *
 * The protocol is shared as a neutral constant and independently bundled into
 * both consumers. The UI regression lane still tests their actual interaction.
 */
export { HIDE_TRANSIENT_OVERLAYS_EVENT } from "../../../lib/overlay-protocol.mjs";

/**
 * One `ui.custom` attempt, cancellable before its factory has a done handle.
 * A cancelled queued attempt still dequeues, but settles without building a
 * component. Owns that component from construction, because Pi may close before
 * receiving the object.
 *
 * Every settlement runs `beforeSettle` first. A cancellation that arrives while
 * the attempt is still queued coordinates immediately AND again at dequeue,
 * because another transient overlay may open in the gap between the two.
 *
 * Both harness panels share this so their settlement seams cannot drift apart:
 * the overlay-stack coordination is only correct while they behave identically.
 */
export class OverlayRequest<T> {
  private cancelled = false;
  private cancellationNotified = false;
  private finish?: (value: T) => void;
  private component?: { dispose(): void };

  constructor(private readonly beforeSettle: () => void, private readonly cancelValue: T) {}

  readonly close = (): void => {
    this.cancelled = true;
    try {
      if (this.finish) this.finish(this.cancelValue);
      else if (!this.cancellationNotified) {
        this.cancellationNotified = true;
        this.beforeSettle();
      }
    } finally { this.dispose(); }
  };

  /** A settlement the mounted component asked for. Cancellation always wins:
   * a closed request can never commit the choice its component was showing. */
  protected settle(value: T): void {
    if (!this.cancelled) this.finish?.(value);
  }

  /** Component `dispose` is idempotent: host cleanup and our cleanup can race. */
  own<C extends { dispose(): void }>(component: C): C {
    if (this.cancelled) component.dispose();
    else this.component = component;
    return component;
  }

  /** Resource cleanup only. Never call a raw UI close after its queue slot was
   * handed on; the queue owns that ordering on failure/timeout. */
  dispose(): void {
    this.cancelled = true;
    this.finish = undefined;
    const component = this.component;
    this.component = undefined;
    component?.dispose();
  }

  /**
   * Publish the done handle as the factory dequeues. `blocked` asks again, now,
   * the admission question the caller answered before queueing; `onBlocked`
   * runs before the empty settlement so a caller can re-arm whatever it was
   * holding open. Returns false when the caller must return an inert component.
   */
  protected attach(done: (value: T) => void, blocked: boolean, onBlocked?: () => void): boolean {
    let settled = false;
    this.finish = (value) => {
      if (settled) return;
      settled = true;
      this.cancellationNotified = true;
      this.beforeSettle();
      done(value);
    };
    if (this.cancelled || blocked) {
      onBlocked?.();
      this.finish(this.cancelValue);
      return false;
    }
    return true;
  }
}
