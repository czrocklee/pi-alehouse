/** Painted hit and presentation-only hover for the shared single-cell close control.
 * Both hover and gestures use this one live hit. Pi 1.5's fullscreen listener
 * consumes mouse input before extension listeners, and components receive no
 * mouse-leave event. This optional adapter observes
 * the native viewport dispatch without parsing, consuming or retargeting input.
 * Gesture observation stays attached independently of the visible highlight.
 * Missing/nonreplaceable host support leaves the existing controls unchanged.
 * Consumers provide the shared frame's hit test, so this SDK-free leaf need
 * not know the frame's geometry constants. */

const REGISTRY_KEY = Symbol.for("pi-alehouse.popover-close-hover.v1");
const METHOD = "handleViewportInput";

/** @typedef {{ hovered: boolean, seen?: object, watching?: boolean,
 * gestureSeen?: object, interrupted?(): void, clear(render?: boolean): void }} Member */
/** @typedef {{ members: Set<Member>, active?: Member, token?: object,
 * original: (...args: unknown[]) => unknown, wrapper: (...args: unknown[]) => unknown,
 * descriptor?: PropertyDescriptor }} Bridge */
/** @typedef {{ host?: object, requestRender(): void,
 * closeHit(width: number): {x: number, width: number, y?: number} | undefined,
 * onGestureInterrupted?(): void }} HoverOptions */
/** @typedef {{ type: string, button?: string, x?: number, y?: number, width?: number }} PopoverCloseMouseEvent */
/** @typedef {{ width: number, hit: {x: number, width: number, y: number},
 * dimensions: unknown[] }} PaintedHit */

/** @returns {WeakMap<object, Bridge> | undefined} */
function registry() {
  const globals = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const existing = globals[REGISTRY_KEY];
  if (existing === undefined) globals[REGISTRY_KEY] = new WeakMap();
  const value = globals[REGISTRY_KEY];
  return value instanceof WeakMap ? value : undefined;
}

/** Restore only our own property; never overwrite a later host/extension change.
 * @param {object} host
 * @param {Bridge} bridge
 */
function detach(host, bridge) {
  try {
    if (Reflect.get(host, METHOD) === bridge.wrapper) {
      if (bridge.descriptor) Object.defineProperty(host, METHOD, bridge.descriptor);
      else Reflect.deleteProperty(host, METHOD);
    }
  } catch {
    // Hover cleanup cannot change the native dispatch's return or exception.
  }
  const bridges = registry();
  if (bridges?.get(host) === bridge) bridges.delete(host);
}

/** @param {object} host @param {Member} member @returns {Bridge | undefined} */
function join(host, member) {
  try {
    const bridges = registry();
    if (!bridges) return undefined;
    const existing = bridges.get(host);
    if (existing) {
      if (Reflect.get(host, METHOD) !== existing.wrapper) {
        for (const previous of [...existing.members]) {
          try {
            previous.interrupted?.();
          } catch {
            // One observer cannot prevent another member's cleanup.
          }
          try {
            previous.clear();
          } catch {
            // Ignore cleanup exceptions from another bundle's member.
          }
        }
        return undefined;
      }
      existing.members.add(member);
      return existing;
    }
    const original = Reflect.get(host, METHOD);
    const descriptor = Object.getOwnPropertyDescriptor(host, METHOD);
    if (
      typeof original !== "function" ||
      (descriptor &&
        (!("value" in descriptor) || (!descriptor.writable && !descriptor.configurable)))
    )
      return undefined;
    /** @type {Bridge} */
    const bridge = {
      members: new Set([member]),
      original,
      descriptor,
      wrapper: function (...args) {
        // Nested dispatches acknowledge their parent too: the latest pointer
        // observation wins, without clearing a freshly revalidated child hover.
        const parent = bridge.token;
        const token = {};
        bridge.token = token;
        try {
          return Reflect.apply(bridge.original, this, args);
        } finally {
          try {
            const members = [...bridge.members];
            try {
              const active = bridge.active;
              if (active && active.seen !== token) active.clear();
              else if (active) active.seen = parent;
            } catch {
              // Visual cleanup cannot suppress gesture observers.
            }
            for (const observer of members) {
              try {
                // A callback may dispose/rejoin members or install a new bridge.
                // An old wrapper must never interrupt that new membership.
                if (!bridge.members.has(observer) || !observer.watching) continue;
                if (observer.gestureSeen === token) observer.gestureSeen = parent;
                else observer.interrupted?.();
              } catch {
                // Preserve native result/throw and continue with other members.
              }
            }
          } catch {
            // Observation must preserve the native result/error even on teardown.
          } finally {
            bridge.token = parent;
          }
        }
      },
    };
    Object.defineProperty(host, METHOD, {
      ...(descriptor ?? { configurable: true, writable: true, enumerable: false }),
      value: bridge.wrapper,
    });
    bridges.set(host, bridge);
    return bridge;
  } catch {
    return undefined;
  }
}

/** @param {object | undefined} host @returns {unknown[]} */
function dimensions(host) {
  const terminal = /** @type {{terminal?: {columns?: unknown, rows?: unknown}} | undefined} */ (
    host
  )?.terminal;
  return [terminal?.columns, terminal?.rows];
}

/** One instance per visible panel, not per paint. No timers or model/session IO.
 * `paint` publishes actual close visibility, not merely a sufficiently wide box.
 * `reset` retires that geometry until another paint; pointer leave only clears
 * the highlight. Pass false when the caller already owns the repaint. Geometry
 * changes published by `paint` are always silent: its caller is painting now.
 * `mouse` reports whether the event matches the painted hit, even if native
 * hover is unsupported, so gestures don't redo the hit test.
 * Dispose at final teardown, reset when hiding/yielding.
 * @param {HoverOptions} options
 */
export function createPopoverCloseHover(options) {
  let disposed = false;
  /** @type {PaintedHit | undefined} */
  let painted;
  /** @type {number | undefined} */
  let paintedHeight;
  /** @type {Bridge | undefined} */
  let bridge;
  const redraw = () => {
    try {
      options.requestRender();
    } catch {
      // Pure feedback must never interfere with native input or close actions.
    }
  };
  const leave = () => {
    const previous = bridge;
    bridge = undefined;
    if (!previous) return;
    previous.members.delete(member);
    if (previous.active === member) previous.active = undefined;
    if (!previous.members.size && options.host) detach(options.host, previous);
  };
  /** @type {Member} */
  const member = {
    hovered: false,
    watching: false,
    interrupted() {
      if (member.watching) options.onGestureInterrupted?.();
    },
    clear(render = true) {
      if (bridge?.active === member) bridge.active = undefined;
      member.seen = undefined;
      // Press/reset may clear feedback, but the claimed gesture still needs
      // native dispatch observation until its terminal event or interruption.
      if (!member.watching) leave();
      if (!member.hovered) return;
      member.hovered = false;
      if (render) redraw();
    },
  };
  /** @param {boolean} [render] */
  const reset = (render = true) => {
    painted = undefined;
    paintedHeight = undefined;
    member.clear(render);
  };
  /** @param {PaintedHit} snapshot @param {PopoverCloseMouseEvent} event */
  const matches = (snapshot, event) => {
    const { width, hit } = snapshot;
    if (
      event.y !== hit.y ||
      event.x === undefined ||
      !Number.isFinite(event.x) ||
      event.x < hit.x ||
      event.x >= hit.x + hit.width ||
      (event.width !== undefined && event.width !== width)
    )
      return false;
    if (dimensions(options.host).some((value, index) => value !== snapshot.dimensions[index])) {
      reset(); // A live terminal resize needs a fresh paint, not just another event.
      return false;
    }
    const current = options.closeHit(width);
    return (
      !!current && current.x === hit.x && current.width === hit.width && (current.y ?? 0) === hit.y
    );
  };
  /** @param {boolean} highlight */
  const observeHover = (highlight) => {
    if (!highlight) {
      member.clear();
      return;
    }
    if (!options.host) return;
    if (bridge && Reflect.get(options.host, METHOD) !== bridge.wrapper) {
      member.clear();
      return;
    }
    bridge ??= join(options.host, member);
    if (!bridge) return;
    if (bridge.active !== member) bridge.active?.clear();
    bridge.active = member;
    member.seen = bridge.token;
    if (!member.hovered) {
      member.hovered = true;
      redraw();
    }
  };
  return {
    get hovered() {
      return member.hovered;
    },
    /** @param {number} width @param {boolean} [enabled] @param {number} [height] */
    paint(width, enabled = true, height) {
      if (disposed) return false;
      try {
        const next = dimensions(options.host);
        const hit = options.closeHit(width);
        const y = hit?.y ?? 0;
        const valid =
          enabled &&
          width > 0 &&
          Number.isInteger(width) &&
          !!hit &&
          Number.isInteger(y) &&
          y >= 0 &&
          (height === undefined || (Number.isInteger(height) && height > y));
        const changed =
          !valid ||
          !painted ||
          width !== painted.width ||
          hit.x !== painted.hit.x ||
          hit.width !== painted.hit.width ||
          y !== painted.hit.y ||
          (height !== undefined && height !== paintedHeight) ||
          next.some((value, index) => value !== painted?.dimensions[index]);
        if (changed) {
          painted = valid
            ? { width, hit: { x: hit.x, width: hit.width, y }, dimensions: next }
            : undefined;
          member.clear(false);
        }
        if (height !== undefined) paintedHeight = height;
        return changed;
      } catch {
        reset(false);
        return true;
      }
    },
    /** @param {boolean} active */
    watchGesture(active) {
      if (disposed || member.watching === active) return;
      member.watching = active;
      if (!active) {
        if (!member.hovered) leave();
        return;
      }
      try {
        if (!options.host) return;
        bridge ??= join(options.host, member);
        // A watch can begin inside native dispatch, after mouse() already
        // cleared its visual membership. That new watch belongs to this scope.
        member.gestureSeen = bridge?.token;
      } catch {
        // Optional observation cannot make structural-host controls unusable.
      }
    },
    /** @param {PopoverCloseMouseEvent} event @param {boolean} [active] */
    mouse(event, active = true) {
      if (disposed) return false;
      // Every delivered event acknowledges the current native scope, even a
      // press, wheel or release that clears the presentation-only highlight.
      member.gestureSeen = bridge?.token;
      const snapshot = painted;
      let inside = false;
      try {
        inside = active && !!snapshot && matches(snapshot, event);
      } catch {
        reset();
      }
      try {
        observeHover(
          inside &&
            event.type === "move" &&
            (event.button === undefined || event.button === "none"),
        );
      } catch {
        member.clear(); // Optional native observation cannot invalidate an ordinary hit.
      }
      // A synchronous feedback repaint may have retired the hit in the meantime.
      return inside && painted === snapshot;
    },
    reset,
    dispose() {
      disposed = true;
      member.watching = false;
      reset();
    },
  };
}
