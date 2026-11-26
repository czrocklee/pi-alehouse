import { resolveTuiRenderer } from "./tui-renderer-identity.mjs";

/** Fullscreen Pi 1.6.1 sends pointer events to a component only inside its
 * overlay. Add a hit on the unoccupied backdrop, *after* native overlay hit
 * testing but before root controls/links. The SDK still owns press tracking,
 * drag cancellation, focus loss and click synthesis. No raw input parsing. */
const METHOD = "dispatchMouseToOverlay";
const BRIDGE = Symbol.for("pi-alehouse.centered-dismiss.v1");
const noop = () => {};

/** @typedef {{ row: number, col: number, width: number, height: number }} Bounds */
/** @typedef {{ isFocused(): boolean, getBounds(): Bounds | undefined }} Handle */
/** @typedef {{ type: string, button: string, screenX: number, screenY: number,
 * width: number, height: number, alt?: boolean, ctrl?: boolean, shift?: boolean }} Mouse */
/** @typedef {(event: Mouse) => object | undefined} HitTest */
/** @typedef {{ tests: Set<HitTest>, restore(): void }} Bridge */

/** Share one optional dispatch hook across independently bundled panels.
 * @param {object} host @returns {Bridge | undefined} */
function bridgeFor(host) {
  const original = Reflect.get(host, METHOD);
  if (typeof original !== "function") return;
  const existing = Reflect.get(original, BRIDGE);
  if (existing) return existing;
  const descriptor = Object.getOwnPropertyDescriptor(host, METHOD);
  if (descriptor && !("value" in descriptor)) return;
  /** @type {Bridge} */
  const bridge = {
    tests: new Set(),
    restore() {
      if (Reflect.get(host, METHOD) !== dispatch) return;
      if (descriptor) Reflect.defineProperty(host, METHOD, descriptor);
      else Reflect.deleteProperty(host, METHOD);
    },
  };
  /** @this {object} @param {Mouse} event */
  function dispatch(event) {
    const native = Reflect.apply(original, this, [event]);
    if (
      native?.hit !== false ||
      event.type !== "press" ||
      event.button !== "left" ||
      event.alt ||
      event.ctrl ||
      event.shift
    )
      return native;
    for (const test of bridge.tests) {
      try {
        const result = test(event);
        if (result) return { hit: true, result };
      } catch {
        // One unavailable panel must not interrupt native input or other panels.
      }
    }
    return native;
  }
  Object.defineProperty(dispatch, BRIDGE, { value: bridge });
  Object.defineProperty(host, METHOD, {
    ...(descriptor ?? { configurable: true, writable: true }),
    value: dispatch,
  });
  return bridge;
}

/** @param {Bounds | undefined} box @returns {box is Bounds} */
function validBounds(box) {
  return (
    !!box &&
    Number.isInteger(box.row) &&
    Number.isInteger(box.col) &&
    Number.isInteger(box.width) &&
    box.width >= 0 &&
    Number.isInteger(box.height) &&
    box.height >= 0
  );
}

/** @param {Bounds} box @param {number} x @param {number} y */
function covers(box, x, y) {
  return x >= box.col && x < box.col + box.width && y >= box.row && y < box.row + box.height;
}

/** One tracker per panel. Forward Pi's public Focusable.focused setter to it:
 * a press belongs to one uninterrupted period of focus, even if the same panel
 * regains focus before release. Dispose the registration before hiding in place
 * or unmounting. Unsupported hosts keep Esc and the close control. */
export function createBackdropDismiss() {
  let focused = false;
  let revision = 0;
  return {
    get focused() {
      return focused;
    },
    set focused(value) {
      if (focused && !value) revision++;
      focused = value;
    },
    /** @param {object} host @param {Handle} handle @param {() => void} dismiss */
    attach(host, handle, dismiss) {
      return register(host, handle, dismiss, () => (focused ? revision : undefined));
    },
  };
}

/** @param {object} host @param {Handle} handle @param {() => void} dismiss
 * @param {() => number | undefined} focusRevision @returns {() => void} */
function register(host, handle, dismiss, focusRevision) {
  if (
    Reflect.get(host, "mode") !== "fullscreen" ||
    typeof handle?.isFocused !== "function" ||
    typeof handle.getBounds !== "function"
  )
    return noop;
  const renderer = resolveTuiRenderer(host);
  if (!renderer) return noop;
  let bridge;
  try {
    if (!Array.isArray(Reflect.get(renderer, "renderedOverlayLayouts"))) return noop;
    bridge = bridgeFor(renderer);
  } catch {
    return noop; // The optional native method may not be replaceable.
  }
  if (!bridge) return noop;
  let mounted = true;
  /** Check the actual cell, not the old box: a streaming panel can grow without
   * covering it. Pi keeps zero-line layouts, but those do not cover any cell.
   * Unknown geometry must not claim a new press or approve an old one.
   * @param {number} x @param {number} y */
  const isBackdrop = (x, y) => {
    if (!mounted || resolveTuiRenderer(host) !== renderer || !handle.isFocused()) return false;
    const box = handle.getBounds();
    if (!validBounds(box) || !box.width || !box.height || covers(box, x, y)) return false;
    const layouts = Reflect.get(renderer, "renderedOverlayLayouts");
    return (
      Array.isArray(layouts) &&
      layouts.length > 0 &&
      layouts.every((layout) => validBounds(layout) && !covers(layout, x, y))
    );
  };
  /** @type {HitTest} */
  const test = (press) => {
    const { screenX: x, screenY: y, width, height } = press;
    const revision = focusRevision();
    if (revision === undefined || x < 0 || y < 0 || x >= width || y >= height || !isBackdrop(x, y))
      return;
    const stillBackdrop = () => {
      try {
        const terminal = Reflect.get(renderer, "terminal");
        return (
          revision === focusRevision() &&
          terminal?.columns === width &&
          terminal.rows === height &&
          isBackdrop(x, y)
        );
      } catch {
        // The press was ours. Consume its release and let Pi clear its capture.
        return false;
      }
    };
    let eligible = true;
    const component = {
      /** @param {Mouse} event */
      handleMouse(event) {
        if (event.type === "press" || event.alt || event.ctrl || event.shift) eligible = false;
        if (
          eligible &&
          event.type === "click" &&
          (event.button === "left" || event.button === "none")
        ) {
          eligible = false;
          if (stillBackdrop()) {
            try {
              dismiss();
            } catch {
              // Teardown may already have removed the panel. Never replay it or
              // let its failure escape before Pi releases the native press target.
            }
          }
        }
        return { handled: true, render: false };
      },
    };
    return { handled: true, target: { component, originX: 0, originY: 0, width, height } };
  };
  bridge.tests.add(test);
  return () => {
    mounted = false;
    if (bridge.tests.delete(test) && !bridge.tests.size) bridge.restore();
  };
}
