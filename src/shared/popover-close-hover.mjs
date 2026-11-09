/** Presentation-only hover state for the shared five-column close control.
 * Pi 1.5's fullscreen listener consumes mouse input before extension listeners,
 * and components receive no mouse-leave event. This optional adapter observes
 * the native viewport dispatch without parsing, consuming or retargeting input.
 * Missing/nonreplaceable host support leaves the existing controls unchanged.
 * Consumers inject the shared frame's hit test, keeping this an SDK-free,
 * dependency-free leaf without duplicating geometry constants. */

const REGISTRY_KEY = Symbol.for("pi-alehouse.popover-close-hover.v1");
const METHOD = "handleViewportInput";

/** @typedef {{ hovered: boolean, seen?: object, clear(render?: boolean): void }} Member */
/** @typedef {{ members: Set<Member>, active?: Member, token?: object,
 * original: (...args: unknown[]) => unknown, wrapper: (...args: unknown[]) => unknown,
 * descriptor?: PropertyDescriptor }} Bridge */
/** @typedef {{ host?: object, requestRender(): void,
 * closeHit(width: number): {x: number, width: number} | undefined }} HoverOptions */
/** @typedef {{ type: string, button?: string, x?: number, y?: number }} HoverMouseEvent */

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
        for (const previous of [...existing.members]) previous.clear();
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
            const active = bridge.active;
            if (active && active.seen !== token) active.clear();
            else if (active) active.seen = parent;
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
 * Dispose at final teardown, reset when hiding/yielding.
 * @param {HoverOptions} options
 */
export function createPopoverCloseHover(options) {
  let disposed = false;
  let paintedWidth = 0;
  /** @type {number | undefined} */
  let paintedHeight;
  /** @type {unknown[]} */
  let paintedDimensions = [];
  /** @type {Bridge | undefined} */
  let bridge;
  const redraw = () => {
    try {
      options.requestRender();
    } catch {
      // Pure feedback must never interfere with native input or close actions.
    }
  };
  /** @type {Member} */
  const member = {
    hovered: false,
    clear(render = true) {
      const previous = bridge;
      bridge = undefined;
      if (previous) {
        previous.members.delete(member);
        if (previous.active === member) previous.active = undefined;
        if (!previous.members.size && options.host) detach(options.host, previous);
      }
      if (!member.hovered) return;
      member.hovered = false;
      member.seen = undefined;
      if (render) redraw();
    },
  };
  /** @param {boolean} [render] */
  const reset = (render = true) => {
    paintedWidth = 0;
    paintedHeight = undefined;
    paintedDimensions = [];
    member.clear(render);
  };
  return {
    get hovered() {
      return member.hovered;
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
          member.clear(false);
        paintedWidth = valid ? width : 0;
        if (height !== undefined) paintedHeight = height;
        paintedDimensions = next;
      } catch {
        reset(false);
      }
    },
    /** @param {HoverMouseEvent} event */
    mouse(event) {
      if (disposed) return;
      const hit = options.closeHit(paintedWidth);
      if (
        !hit ||
        event.type !== "move" ||
        (event.button !== undefined && event.button !== "none") ||
        event.y !== 0 ||
        event.x === undefined ||
        !Number.isFinite(event.x) ||
        event.x < hit.x ||
        event.x >= hit.x + hit.width
      ) {
        member.clear();
        return;
      }
      try {
        const current = dimensions(options.host);
        if (current.some((value, index) => value !== paintedDimensions[index])) return reset();
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
      } catch {
        reset();
      }
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
