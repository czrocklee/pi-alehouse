/** Presentation-only close control for the shared popover frame.
 * Composes the hover adapter and adds one forgiving press gesture on the
 * painted close hit: a left press inside the hit claims the press (never
 * closes), a left or buttonless release inside the same hit closes, and the
 * release and native synthetic click of a cancelled gesture are consumed so
 * they can neither close twice nor fall through into body controls. The shared
 * SDK-free tracker owns the painted hit for both feedback and activation. */

import { createPopoverCloseHover } from "./popover-close-hover.mjs";

/** @typedef {{ host?: object, requestRender(): void,
 * closeHit(width: number): {x: number, width: number, y?: number} | undefined }} ControlOptions */
/** @typedef {import("./popover-close-hover.mjs").PopoverCloseMouseEvent} ControlMouseEvent */
/** One gesture in flight: "armed" claimed a press inside the hit, "spent" was
 * claimed but permanently cancelled, "closed" already closed on release, and
 * "outside" observed a fresh press that was not ours to claim. "interrupted"
 * no longer owns releases, but suppresses one potentially captured old click.
 * @typedef {"armed" | "spent" | "closed" | "outside" | "interrupted"} Gesture */

/** One instance per visible panel, not per paint. No timers or model/session IO.
 * `paint` publishes actual close visibility through the shared tracker. A
 * geometry change also cancels an armed gesture and suppresses its stale
 * release/click. `mouse` returns `{ handled: true, close }` for a claimed or
 * consumed event and undefined otherwise; `close` is true only when the caller
 * should close now. `active` false clears hover and cancels and consumes an
 * old gesture without activating one. Dispose at final teardown, reset when hiding/yielding.
 * @param {ControlOptions} options
 */
export function createPopoverCloseControl(options) {
  let disposed = false;
  /** @type {Gesture | undefined} */
  let gesture;
  const hover = createPopoverCloseHover({
    host: options.host,
    requestRender: options.requestRender,
    closeHit: options.closeHit,
    onGestureInterrupted() {
      // Native input no longer reached this control. Release ownership without
      // claiming a root selection's release, but consume an old captured click
      // even if layout changes have since moved its coordinates onto the body.
      if (gesture === "armed" || gesture === "spent" || gesture === "closed")
        setGesture("interrupted");
    },
  });
  /** @param {Gesture | undefined} next */
  function setGesture(next) {
    if (gesture === next) return;
    gesture = next;
    hover.watchGesture(!disposed && (next === "armed" || next === "spent" || next === "closed"));
  }
  /** @param {boolean} close @returns {{ handled: true, close: boolean }} */
  const claim = (close) => ({ handled: true, close });
  const cancel = () => {
    if (gesture === "armed") setGesture("spent");
  };
  /** @param {boolean} [render] */
  const reset = (render = true) => {
    cancel();
    hover.reset(render);
  };
  return {
    get hovered() {
      return hover.hovered;
    },
    /** @param {number} width @param {boolean} [enabled] @param {number} [height] */
    paint(width, enabled = true, height) {
      if (hover.paint(width, enabled, height)) cancel();
    },
    /** @param {ControlMouseEvent} event @param {boolean} [active]
     * @returns {{ handled: true, close: boolean } | undefined} */
    mouse(event, active = true) {
      try {
        // Observe every delivered event, including those that cannot activate close.
        const insideHit = hover.mouse(event, active);
        if (!active) cancel();
        if (event.type === "press") {
          // Every fresh press ends previous ownership, including another
          // button. It must not leave "spent" swallowing a new selection's
          // release. A non-left press may leave native left capture intact:
          // retain only its click tombstone, not ownership of future releases.
          if (event.button !== "left") {
            setGesture(gesture !== undefined && gesture !== "outside" ? "interrupted" : "outside");
            return undefined;
          }
          // A fresh left press always replaces that tombstone; body input is
          // ordinary again, and only a live press inside the hit can arm close.
          setGesture(insideHit ? "armed" : "outside");
          return gesture === "armed" ? claim(false) : undefined;
        }
        if (event.type === "release") {
          if (event.button !== "left" && event.button !== "none") return undefined;
          if (gesture === "armed") {
            if (insideHit) {
              setGesture("closed"); // The native synthetic click must not reclose.
              return claim(true);
            }
            setGesture("spent"); // We claimed this press: its release cannot fall through.
            return claim(false);
          }
          return gesture === "spent" || gesture === "closed" ? claim(false) : undefined;
        }
        if (event.type === "click" && event.button === "left") {
          if (gesture === "armed") {
            // Structural hosts press and then click without any release.
            if (insideHit) {
              setGesture(undefined);
              return claim(true);
            }
            setGesture(undefined); // Even a cancelled structural click ends this gesture.
            return claim(false);
          }
          if (gesture === "spent" || gesture === "closed" || gesture === "interrupted") {
            setGesture(undefined); // Consume the gesture's synthetic click exactly once.
            return claim(false);
          }
          if (gesture === "outside") {
            setGesture(undefined);
            return insideHit ? claim(false) : undefined;
          }
          return insideHit ? claim(true) : undefined;
        }
        if ((event.type === "move" || event.type === "drag") && gesture === "armed") {
          // Leaving the hit cancels permanently: moving back cannot revive it.
          if (!insideHit) setGesture("spent");
        }
        return undefined;
      } catch {
        reset();
        return undefined;
      }
    },
    reset,
    dispose() {
      disposed = true;
      cancel();
      // Detach observation, but retain the tombstone for a trailing synthetic
      // click already captured by the native host before synchronous teardown.
      hover.watchGesture(false);
      hover.dispose();
    },
  };
}
