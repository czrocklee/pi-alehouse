/** Presentation-only close control for the shared popover frame.
 * Composes the hover adapter and adds one forgiving press gesture on the
 * painted close hit: a left press inside the hit claims the press (never
 * closes), a left or buttonless release inside the same hit closes, and the
 * release and native synthetic click of a cancelled gesture are consumed so
 * they can neither close twice nor fall through into body controls. Consumers
 * inject the hover factory and shared frame's hit test, keeping this an
 * SDK-free, dependency-free leaf without duplicating geometry constants. */

/** @typedef {{ host?: object, requestRender(): void,
 * closeHit(width: number): {x: number, width: number} | undefined,
 * createHover: typeof import("./popover-close-hover.mjs").createPopoverCloseHover }} ControlOptions */
/** @typedef {{ type: string, button?: string, x?: number, y?: number,
 * width?: number }} ControlMouseEvent */
/** One gesture in flight: "armed" claimed a press inside the hit, "spent" was
 * claimed but permanently cancelled, "closed" already closed on release, and
 * "outside" observed a fresh press that was not ours to claim. "interrupted"
 * no longer owns releases, but suppresses one potentially captured old click.
 * @typedef {"armed" | "spent" | "closed" | "outside" | "interrupted"} Gesture */

/** @param {object | undefined} host @returns {unknown[]} */
function dimensions(host) {
  const terminal = /** @type {{terminal?: {columns?: unknown, rows?: unknown}} | undefined} */ (
    host
  )?.terminal;
  return [terminal?.columns, terminal?.rows];
}

/** One instance per visible panel, not per paint. No timers or model/session IO.
 * `paint` publishes actual close visibility exactly like the composed hover; a
 * geometry change also cancels an armed gesture and suppresses its stale
 * release/click. `mouse` returns `{ handled: true, close }` for a claimed or
 * consumed event and undefined otherwise; `close` is true only when the caller
 * should close now. `active` false cancels and consumes an old gesture but
 * never activates one. Dispose at final teardown, reset when hiding/yielding.
 * @param {ControlOptions} options
 */
export function createPopoverCloseControl(options) {
  let disposed = false;
  let paintedWidth = 0;
  /** @type {number | undefined} */
  let paintedHeight;
  /** @type {unknown[]} */
  let paintedDimensions = [];
  /** @type {Gesture | undefined} */
  let gesture;
  const hover = options.createHover({
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
  /** The hit exactly as last painted, and only while that paint is still the
   * live geometry. event.width, when the host provides it, must agree with the
   * painted width; it never creates or widens the hit itself.
   * @param {ControlMouseEvent} event */
  const insideHit = (event) => {
    if (
      paintedWidth <= 0 ||
      event.y !== 0 ||
      event.x === undefined ||
      !Number.isFinite(event.x) ||
      !Number.isFinite(event.y) ||
      (event.width !== undefined && event.width !== paintedWidth)
    )
      return false;
    const hit = options.closeHit(paintedWidth);
    if (!hit || event.x < hit.x || event.x >= hit.x + hit.width) return false;
    const current = dimensions(options.host);
    return current.every((value, index) => value === paintedDimensions[index]);
  };
  const cancel = () => {
    if (gesture === "armed") setGesture("spent");
  };
  const retire = () => {
    paintedWidth = 0;
    paintedHeight = undefined;
    paintedDimensions = [];
    cancel();
  };
  /** @param {boolean} [render] */
  const reset = (render = true) => {
    retire();
    hover.reset(render);
  };
  return {
    get hovered() {
      return hover.hovered;
    },
    /** @param {number} width @param {boolean} [enabled] @param {number} [height] */
    paint(width, enabled = true, height) {
      if (disposed) return;
      try {
        const next = dimensions(options.host);
        const valid =
          enabled &&
          Number.isInteger(width) &&
          !!options.closeHit(width) &&
          (height === undefined || (Number.isInteger(height) && height > 0));
        if (
          !valid ||
          width !== paintedWidth ||
          (height !== undefined && height !== paintedHeight) ||
          next.some((value, index) => value !== paintedDimensions[index])
        )
          cancel(); // Geometry moved: the armed gesture dies, its events stay consumed.
        paintedWidth = valid ? width : 0;
        if (height !== undefined) paintedHeight = height;
        paintedDimensions = next;
        hover.paint(width, enabled, height);
      } catch {
        reset(false);
      }
    },
    /** @param {ControlMouseEvent} event @param {boolean} [active]
     * @returns {{ handled: true, close: boolean } | undefined} */
    mouse(event, active = true) {
      try {
        hover.mouse(event); // Acknowledge every delivered mouse event, not just hover.
        const live = active && !disposed;
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
          setGesture(live && insideHit(event) ? "armed" : "outside");
          return gesture === "armed" ? claim(false) : undefined;
        }
        if (event.type === "release") {
          if (event.button !== "left" && event.button !== "none") return undefined;
          if (gesture === "armed") {
            if (live && insideHit(event)) {
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
            if (live && insideHit(event)) {
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
            return live && insideHit(event) ? claim(false) : undefined;
          }
          return live && insideHit(event) ? claim(true) : undefined;
        }
        if ((event.type === "move" || event.type === "drag") && gesture === "armed") {
          // Leaving the hit cancels permanently: moving back cannot revive it.
          if (!insideHit(event)) setGesture("spent");
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
      retire();
      // Detach observation, but retain the tombstone for a trailing synthetic
      // click already captured by the native host before synchronous teardown.
      hover.watchGesture(false);
      hover.dispose();
    },
  };
}
