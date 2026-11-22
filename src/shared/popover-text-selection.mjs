/** Bounded body-text selection for fullscreen popovers.
 *
 * Pi's fullscreen TUI owns fallback mouse text selection. This
 * adapter keeps that native selection (grapheme/word/line handling, OSC8 links,
 * copyOnSelect and the verified clipboard path) and only bounds it to the body
 * rectangle a panel actually painted. It is SDK-free and installs no input
 * listener, timer, clipboard fallback or raw-terminal parser.
 *
 * The six private seams verified against pi-tui 1.6.0 are:
 * - handleSelectionMouseEvent: fallback after native mouse handling and viewport
 *   dispatch. A fresh primary press chooses the visually topmost native
 *   overlay layout under the pointer; only that exact component's declared body
 *   rectangle may become the active domain.
 * - getSelectionPoint: clamps native screen points into the active body domain.
 *   A fresh press invokes it twice (first with the previous anchor's scroll
 *   view), so both calls are handled without inheriting stale scroll geometry.
 * - getWordSelection/getLineSelection: keep chrome gestures empty even on
 *   rapid clicks, without suppressing native press/release/click synthesis.
 * - getSelectionColumns: intersects native grapheme-aware columns with the
 *   domain for both highlight rendering and native copy.
 * - getSelectionBounds: validates the bound entry before any highlight/copy.
 *   Hidden, moved, resized, covered, unregistered or key-invalid domains are
 *   cancelled through the public resetTextSelection rather than merely clipped.
 *
 * Native word/line point copies must preserve the enumerable ownership symbol;
 * method/shape checks are not a promise of compatibility with other signatures.
 * Separately bundled imports share one registry per concrete renderer. Only
 * the final member restores the method properties this bridge itself installed.
 */

import { resolveTuiRenderer } from "./tui-renderer-identity.mjs";

const REGISTRY_KEY = Symbol.for("pi-alehouse.popover-text-selection.v1");
const ANCHOR_KEY = Symbol.for("pi-alehouse.popover-text-selection.anchor.v1");
const HOOKS = [
  "handleSelectionMouseEvent",
  "getSelectionPoint",
  "getWordSelection",
  "getLineSelection",
  "getSelectionColumns",
  "getSelectionBounds",
];
const METHODS = [...HOOKS, "resetTextSelection"];

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ row: number, col: number, width: number, height: number }} LayoutRect */
/** @typedef {{ component: object, hidden?: boolean, options?: unknown, focusOrder?: number }} OverlayEntry */
/** @typedef {{ entry: OverlayEntry, row: number, col: number, width: number, height: number }} OverlayLayout */
/** @typedef {{ columns: number, rows: number }} Size */
/** @typedef {{ member: Member, entry: object, layout: LayoutRect, rect: Rect,
 * viewport?: Size, emptyPoint?: { row: number, col: number } }} Domain */
/** @typedef {{ host?: object, component: object, token: object, rect?: Rect,
 * viewportKey?: unknown, viewport?: Size, bridge?: Bridge, disposed: boolean,
 * unsupported?: boolean, isCurrent(): boolean }} Member */
/** @typedef {{ original: (...args: unknown[]) => unknown, descriptor?: PropertyDescriptor }} Method */
/** @typedef {{ members: Set<Member>, active?: Member, domain?: Domain,
 * pending?: Domain, cancelling: boolean, blocked?: boolean, suppressed?: boolean,
 * retired?: boolean,
 * originals: Map<string, Method>,
 * wrappers: Map<string, (this: object, ...args: unknown[]) => unknown> }} Bridge */

/** @returns {WeakMap<object, Bridge> | undefined} */
function registry() {
  const globals = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const existing = globals[REGISTRY_KEY];
  if (existing === undefined) {
    const next = new WeakMap();
    globals[REGISTRY_KEY] = next;
    return next;
  }
  return existing instanceof WeakMap ? existing : undefined;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} value @param {object} token @returns {boolean} */
function ownedAnchor(value, token) {
  return isObject(value) && /** @type {Record<symbol, unknown>} */ (value)[ANCHOR_KEY] === token;
}

/** @param {unknown} value @returns {value is number} */
function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}

/** @param {unknown} rect @returns {rect is Rect} */
function validRect(rect) {
  return (
    isObject(rect) &&
    isInteger(rect.x) &&
    isInteger(rect.y) &&
    isInteger(rect.width) &&
    isInteger(rect.height) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/** @param {Rect | undefined} left @param {Rect | undefined} right */
function sameRect(left, right) {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

/** @param {unknown} layout @returns {layout is OverlayLayout} */
function validLayout(layout) {
  return (
    isObject(layout) &&
    isObject(layout.entry) &&
    isObject(layout.entry.component) &&
    isInteger(layout.row) &&
    isInteger(layout.col) &&
    isInteger(layout.width) &&
    isInteger(layout.height) &&
    layout.row >= 0 &&
    layout.col >= 0 &&
    layout.width >= 0 &&
    layout.height >= 0
  );
}

/** @param {OverlayLayout} layout @returns {LayoutRect} */
function snapshotLayout(layout) {
  return { row: layout.row, col: layout.col, width: layout.width, height: layout.height };
}

/** @param {Domain} domain @returns {Rect} */
function screenRect(domain) {
  return {
    x: domain.layout.col + domain.rect.x,
    y: domain.layout.row + domain.rect.y,
    width: domain.rect.width,
    height: domain.rect.height,
  };
}

/** @param {Domain} domain */
function insideLayout(domain) {
  return (
    domain.rect.x >= 0 &&
    domain.rect.y >= 0 &&
    domain.rect.x + domain.rect.width <= domain.layout.width &&
    domain.rect.y + domain.rect.height <= domain.layout.height
  );
}

/** @param {object} host @param {OverlayLayout} layout @returns {Rect} */
function clippedLayout(host, layout) {
  let x = layout.col;
  let y = layout.row;
  let width = layout.width;
  let height = layout.height;
  const terminal = /** @type {{ columns?: unknown, rows?: unknown } | undefined} */ (
    /** @type {Record<string, unknown>} */ (host).terminal
  );
  if (isObject(terminal) && isInteger(terminal.columns) && isInteger(terminal.rows)) {
    const right = Math.min(x + width, terminal.columns);
    const bottom = Math.min(y + height, terminal.rows);
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.max(0, right - x);
    height = Math.max(0, bottom - y);
  }
  return { x, y, width, height };
}

/** @param {Rect} left @param {Rect} right */
function overlaps(left, right) {
  return (
    left.width > 0 &&
    left.height > 0 &&
    right.width > 0 &&
    right.height > 0 &&
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/** @param {object} host @param {object} entry */
function entryInStack(host, entry) {
  const stack = /** @type {{ overlayStack?: unknown }} */ (host).overlayStack;
  return Array.isArray(stack) && stack.includes(entry);
}

/** @param {object} host @param {object} entry */
function entryVisible(host, entry) {
  if (!isObject(entry) || entry.hidden === true) return false;
  const native = /** @type {{ isOverlayVisible?: unknown }} */ (host).isOverlayVisible;
  if (typeof native === "function") {
    try {
      return Reflect.apply(native, host, [entry]) === true;
    } catch {
      return false;
    }
  }
  const options = /** @type {{ options?: unknown }} */ (entry).options;
  if (!isObject(options) || typeof options.visible !== "function") return true;
  const terminal = /** @type {{ columns?: unknown, rows?: unknown } | undefined} */ (
    /** @type {Record<string, unknown>} */ (host).terminal
  );
  if (!isObject(terminal) || !isInteger(terminal.columns) || !isInteger(terminal.rows))
    return false;
  try {
    return Reflect.apply(options.visible, options, [terminal.columns, terminal.rows]) === true;
  } catch {
    return false;
  }
}

/** @param {object} host @param {object} entry @returns {{ layout: OverlayLayout, index: number } | undefined} */
function findLayout(host, entry) {
  const layouts = /** @type {{ renderedOverlayLayouts?: unknown }} */ (host).renderedOverlayLayouts;
  if (!Array.isArray(layouts)) return undefined;
  for (let index = layouts.length - 1; index >= 0; index--) {
    const layout = layouts[index];
    if (validLayout(layout) && layout.entry === entry) return { layout, index };
  }
  return undefined;
}

/** @param {Member} member */
function ownsAnchor(member) {
  const host = member.host;
  if (!isObject(host)) return false;
  const anchor = /** @type {{ selectionAnchor?: unknown }} */ (host).selectionAnchor;
  return ownedAnchor(anchor, member.token);
}

/** @param {object | undefined} host @returns {Size | undefined} */
function terminalSize(host) {
  if (!isObject(host)) return undefined;
  const terminal = /** @type {{ columns?: unknown, rows?: unknown } | undefined} */ (
    /** @type {Record<string, unknown>} */ (host).terminal
  );
  return isObject(terminal) && isInteger(terminal.columns) && isInteger(terminal.rows)
    ? { columns: terminal.columns, rows: terminal.rows }
    : undefined;
}

/** @param {Size | undefined} left @param {Size | undefined} right */
function sameSize(left, right) {
  return (
    left === right ||
    (!!left && !!right && left.columns === right.columns && left.rows === right.rows)
  );
}

/** @param {Bridge} bridge */
function clearActive(bridge) {
  bridge.active = undefined;
  bridge.domain = undefined;
  bridge.blocked = false;
  bridge.suppressed = false;
}

/** @param {object} host @returns {boolean} */
function anchorCleared(host) {
  try {
    return !isObject(/** @type {{ selectionAnchor?: unknown }} */ (host).selectionAnchor);
  } catch {
    return false;
  }
}

/** @param {object} host @param {Bridge} bridge @returns {boolean} */
function resetNative(host, bridge) {
  try {
    const live = /** @type {{ resetTextSelection?: unknown }} */ (host).resetTextSelection;
    if (typeof live === "function") {
      Reflect.apply(live, host, []);
      if (anchorCleared(host)) return true;
    }
  } catch {
    // Fall through to the method captured at install.
  }
  // A later extension may have replaced the public method with a no-op or a
  // throwing wrapper. Fall back to the captured method and verify the native
  // anchor is actually gone, not merely that the call returned.
  const original = bridge.originals.get("resetTextSelection")?.original;
  if (typeof original !== "function") return false;
  try {
    Reflect.apply(original, host, []);
    return anchorCleared(host);
  } catch {
    return false;
  }
}

/** @param {object} host */
function requestRender(host) {
  try {
    const render = /** @type {{ requestRender?: unknown }} */ (host).requestRender;
    if (typeof render === "function") Reflect.apply(render, host, []);
  } catch {
    // A cancelled selection must never break the caller or its render loop.
  }
}

/** @param {Bridge} bridge @param {object} host @param {Member} [owner] */
function cancel(bridge, host, owner = bridge.active) {
  if (bridge.cancelling) return false;
  bridge.cancelling = true;
  const reset = resetNative(host, bridge);
  bridge.cancelling = false;
  bridge.pending = undefined;
  if (reset) clearActive(bridge);
  // Both reset paths failed: retain the domain as a tombstone so bounds/copy
  // stay suppressed until a fresh native press replaces the owned anchor.
  else bridge.blocked = true;
  // Clear the old renderer's owned anchor, but don't repaint a retired renderer.
  if (owner?.isCurrent() !== false) requestRender(host);
  return reset;
}

/** @param {object} host @param {Bridge} bridge @returns {boolean} */
function installed(host, bridge) {
  for (const method of HOOKS) {
    if (Reflect.get(host, method) !== bridge.wrappers.get(method)) return false;
  }
  return true;
}

/** @param {Domain} domain @param {{ x?: unknown, y?: unknown, release?: unknown }} event @param {Member} member */
function domainPoint(domain, event, member) {
  const rect = screenRect(domain);
  const x = typeof event.x === "number" && Number.isFinite(event.x) ? Math.trunc(event.x) : rect.x;
  const y = typeof event.y === "number" && Number.isFinite(event.y) ? Math.trunc(event.y) : rect.y;
  const pin = domain.emptyPoint;
  // Pin an empty chrome drag, but preserve the native moved-release test even
  // when a terminal sends no intervening drag report. A different release
  // position must not turn into a click on another control.
  const movedRelease = pin && event.release === true && (x !== pin.col || y !== pin.row);
  const col = pin
    ? movedRelease
      ? x
      : pin.col
    : Math.max(rect.x, Math.min(rect.x + rect.width - 1, x));
  const row = pin
    ? movedRelease
      ? y
      : pin.row
    : Math.max(rect.y, Math.min(rect.y + rect.height - 1, y));
  const point = { row, col };
  Object.defineProperty(point, ANCHOR_KEY, {
    value: member.token,
    enumerable: true,
    configurable: true,
  });
  return point;
}

/** @param {object} host @param {Member} member @param {OverlayLayout} layout @param {{ x?: unknown, y?: unknown }} event @returns {Domain | undefined} */
function bindLayout(host, member, layout, event) {
  if (!validRect(member.rect)) return undefined;
  // Admission uses the viewport captured by the last paint. A terminal resize
  // without a repaint leaves the cached native layout and member.rect stale;
  // suppress the fresh gesture until the panel paints again.
  if (!sameSize(member.viewport, terminalSize(host))) return undefined;
  /** @type {Domain} */
  const domain = {
    member,
    entry: layout.entry,
    layout: snapshotLayout(layout),
    rect: { ...member.rect },
    viewport: member.viewport,
  };
  if (!insideLayout(domain)) return undefined;
  const rect = screenRect(domain);
  const clip = clippedLayout(host, layout);
  if (
    rect.x < clip.x ||
    rect.y < clip.y ||
    rect.x + rect.width > clip.x + clip.width ||
    rect.y + rect.height > clip.y + clip.height
  )
    return undefined;
  const x = typeof event.x === "number" ? event.x : NaN;
  const y = typeof event.y === "number" ? event.y : NaN;
  if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height)
    domain.emptyPoint = { row: y, col: x };
  return domain;
}

const SUPPRESS = Symbol("suppress");
/** @param {object} host @param {Bridge} bridge @param {{ x?: unknown, y?: unknown }} event @returns {Domain | typeof SUPPRESS | undefined} */
function resolvePress(host, bridge, event) {
  const layouts = /** @type {{ renderedOverlayLayouts?: unknown }} */ (host).renderedOverlayLayouts;
  if (!Array.isArray(layouts)) return undefined;
  const x = typeof event.x === "number" ? event.x : NaN;
  const y = typeof event.y === "number" ? event.y : NaN;
  if (!isInteger(x) || !isInteger(y)) return undefined;
  for (let index = layouts.length - 1; index >= 0; index--) {
    const layout = layouts[index];
    if (!validLayout(layout)) continue;
    if (
      x < layout.col ||
      x >= layout.col + layout.width ||
      y < layout.row ||
      y >= layout.row + layout.height
    )
      continue;
    // This is the visually topmost native layout under the pointer. A stale
    // hidden entry still wins here, exactly as native dispatch would.
    if (!entryInStack(host, layout.entry) || !entryVisible(host, layout.entry)) return undefined;
    let painted = false;
    for (const member of bridge.members) {
      if (member.disposed || member.component !== layout.entry.component || !member.isCurrent())
        continue;
      if (!validRect(member.rect)) continue;
      painted = true;
      const domain = bindLayout(host, member, layout, event);
      if (domain) return domain;
    }
    // Known but stale/invalid geometry admits neither text selection nor a
    // delayed click. Healthy chrome instead binds an owned empty domain above,
    // preserving the host's ordinary release/click path and panel lifecycle.
    return painted ? SUPPRESS : undefined;
  }
  return undefined;
}

/** @param {object} host @param {Domain} domain @param {number} ownerIndex */
function covered(host, domain, ownerIndex) {
  // An empty chrome gesture owns its pressed cell, not the text body below it.
  // A panel can still receive a tab/footer click while its body is covered.
  const rect = domain.emptyPoint
    ? { x: domain.emptyPoint.col, y: domain.emptyPoint.row, width: 1, height: 1 }
    : screenRect(domain);
  const layouts = /** @type {{ renderedOverlayLayouts?: unknown }} */ (host).renderedOverlayLayouts;
  if (Array.isArray(layouts)) {
    for (let index = ownerIndex + 1; index < layouts.length; index++) {
      const layout = layouts[index];
      if (!validLayout(layout)) continue;
      if (!entryInStack(host, layout.entry) || !entryVisible(host, layout.entry)) continue;
      if (
        overlaps(rect, { x: layout.col, y: layout.row, width: layout.width, height: layout.height })
      )
        return true;
    }
  }
  const stack = /** @type {{ overlayStack?: unknown }} */ (host).overlayStack;
  if (!Array.isArray(stack)) return false;
  const owner = /** @type {{ focusOrder?: unknown }} */ (domain.entry);
  const ownerOrder = isInteger(owner.focusOrder) ? owner.focusOrder : -Infinity;
  for (const entry of stack) {
    if (entry === domain.entry || !isObject(entry) || !entryVisible(host, entry)) continue;
    const order = /** @type {{ focusOrder?: unknown }} */ (entry).focusOrder;
    if (!isInteger(order) || order <= ownerOrder) continue;
    const found = findLayout(host, entry);
    // Unknown geometry may cover selected body text, so cancel conservatively.
    // Empty chrome has no selectable text; an unpainted overlay has no native
    // mouse hit yet and must not swallow a click on the currently painted UI.
    if (!found) {
      if (domain.emptyPoint) continue;
      return true;
    }
    if (
      overlaps(rect, {
        x: found.layout.col,
        y: found.layout.row,
        width: found.layout.width,
        height: found.layout.height,
      })
    )
      return true;
  }
  return false;
}

/** @param {object} host @param {Domain} domain */
function validDomain(host, domain) {
  const member = domain.member;
  if (member.disposed || !member.isCurrent()) return false;
  if (!sameSize(terminalSize(host), domain.viewport)) return false;
  if (!entryInStack(host, domain.entry) || !entryVisible(host, domain.entry)) return false;
  const found = findLayout(host, domain.entry);
  if (!found) return false;
  const layout = found.layout;
  const saved = domain.layout;
  if (
    layout.row !== saved.row ||
    layout.col !== saved.col ||
    layout.width !== saved.width ||
    layout.height !== saved.height
  )
    return false;
  if (!insideLayout(domain)) return false;
  const rect = screenRect(domain);
  const clip = clippedLayout(host, layout);
  if (
    rect.x < clip.x ||
    rect.y < clip.y ||
    rect.x + rect.width > clip.x + clip.width ||
    rect.y + rect.height > clip.y + clip.height
  )
    return false;
  return !covered(host, domain, found.index);
}

/** @param {object} host @param {Bridge} bridge @returns {Map<string, (this: object, ...args: unknown[]) => unknown>} */
function makeWrappers(host, bridge) {
  /** @type {Map<string, (this: object, ...args: unknown[]) => unknown>} */
  const wrappers = new Map();
  /** @param {string} method @returns {(...args: unknown[]) => unknown} */
  const original = (method) => {
    const fn = bridge.originals.get(method)?.original;
    if (typeof fn !== "function") throw new Error("missing native method");
    return fn;
  };

  /** @type {(this: object, ...args: unknown[]) => unknown} */
  const handleSelectionMouseEvent = function (...args) {
    const method = original("handleSelectionMouseEvent");
    const event = args[0];
    let suppress = false;
    if (!bridge.cancelling && isObject(event)) {
      const button = typeof event.button === "number" ? event.button : undefined;
      const fresh =
        event.release !== true && button !== undefined && (button & 32) === 0 && (button & 3) === 0;
      if (fresh) {
        const resolved = resolvePress(host, bridge, event);
        clearActive(bridge);
        bridge.pending = undefined;
        if (resolved && resolved !== SUPPRESS) {
          bridge.active = resolved.member;
          bridge.domain = resolved;
          bridge.pending = resolved;
        }
        if (resolved === SUPPRESS) suppress = true;
      }
    }
    try {
      return Reflect.apply(method, this, args);
    } finally {
      bridge.pending = undefined;
      if (suppress) {
        if (!resetNative(host, bridge)) bridge.suppressed = true;
        requestRender(host);
      }
    }
  };
  wrappers.set("handleSelectionMouseEvent", handleSelectionMouseEvent);

  /** @type {(this: object, ...args: unknown[]) => unknown} */
  const getSelectionPoint = function (...args) {
    const method = original("getSelectionPoint");
    if (bridge.cancelling) return Reflect.apply(method, this, args);
    const active = bridge.active;
    const domain = bridge.domain;
    if (!active || !domain) return Reflect.apply(method, this, args);
    if (bridge.pending)
      return domainPoint(domain, /** @type {{ x?: unknown, y?: unknown }} */ (args[0]), active);
    if (!ownsAnchor(active)) {
      clearActive(bridge);
      return Reflect.apply(method, this, args);
    }
    if (!validDomain(host, domain)) {
      cancel(bridge, host);
      return Reflect.apply(method, this, args);
    }
    return domainPoint(domain, /** @type {{ x?: unknown, y?: unknown }} */ (args[0]), active);
  };
  wrappers.set("getSelectionPoint", getSelectionPoint);

  for (const name of ["getWordSelection", "getLineSelection"]) {
    /** @type {(this: object, ...args: unknown[]) => unknown} */
    const getRange = function (...args) {
      const point = args[0];
      const active = bridge.active;
      if (
        !bridge.cancelling &&
        bridge.domain?.emptyPoint &&
        active &&
        ownedAnchor(point, active.token)
      )
        // Native double/triple selection must not move the anchor away from
        // the pinned press. A zero-length range still preserves click counts.
        return { start: point, end: point };
      return Reflect.apply(original(name), this, args);
    };
    wrappers.set(name, getRange);
  }

  /** @type {(this: object, ...args: unknown[]) => unknown} */
  const getSelectionColumns = function (...args) {
    const method = original("getSelectionColumns");
    if (bridge.cancelling) return Reflect.apply(method, this, args);
    if (!installed(host, bridge) || bridge.retired) {
      const active = bridge.active;
      const selection = args[2];
      const owned = !!active && isObject(selection) && ownedAnchor(selection.start, active.token);
      const suppress = owned || bridge.suppressed === true || bridge.blocked === true;
      retireBridge(host, bridge);
      if (suppress) return { start: 0, end: 0 };
      return Reflect.apply(method, this, args);
    }
    if (bridge.suppressed) return { start: 0, end: 0 };
    const active = bridge.active;
    const domain = bridge.domain;
    if (!active || !domain) return Reflect.apply(method, this, args);
    const selection = args[2];
    if (!isObject(selection) || !ownedAnchor(selection.start, active.token))
      return Reflect.apply(method, this, args);
    if (bridge.blocked || domain.emptyPoint) return { start: 0, end: 0 };
    const row = args[1];
    const rect = screenRect(domain);
    if (!isInteger(row) || row < rect.y || row >= rect.y + rect.height) return { start: 0, end: 0 };
    const columns = Reflect.apply(method, this, args);
    if (!isObject(columns) || typeof columns.start !== "number" || typeof columns.end !== "number")
      return columns;
    const start = Math.max(columns.start, rect.x);
    const end = Math.min(columns.end, rect.x + rect.width);
    return { start, end: Math.max(start, end) };
  };
  wrappers.set("getSelectionColumns", getSelectionColumns);

  /** @type {(this: object, ...args: unknown[]) => unknown} */
  const getSelectionBounds = function (...args) {
    const method = original("getSelectionBounds");
    if (bridge.cancelling) return Reflect.apply(method, this, args);
    if (!installed(host, bridge) || bridge.retired) {
      const active = bridge.active;
      const anchor = /** @type {{ selectionAnchor?: unknown }} */ (this).selectionAnchor;
      const owned = !!active && ownedAnchor(anchor, active.token);
      const suppress = owned || bridge.suppressed === true || bridge.blocked === true;
      retireBridge(host, bridge);
      if (suppress) return undefined;
      return Reflect.apply(method, this, args);
    }
    if (bridge.suppressed) {
      const anchor = /** @type {{ selectionAnchor?: unknown }} */ (this).selectionAnchor;
      if (isObject(anchor)) return undefined;
      bridge.suppressed = false;
      return Reflect.apply(method, this, args);
    }
    const active = bridge.active;
    const domain = bridge.domain;
    if (!active || !domain) return Reflect.apply(method, this, args);
    const anchor = /** @type {{ selectionAnchor?: unknown }} */ (this).selectionAnchor;
    if (!ownedAnchor(anchor, active.token)) {
      clearActive(bridge);
      return Reflect.apply(method, this, args);
    }
    if (bridge.blocked) return undefined;
    if (!validDomain(host, domain)) {
      cancel(bridge, host);
      return undefined;
    }
    if (domain.emptyPoint) return undefined;
    return Reflect.apply(method, this, args);
  };
  wrappers.set("getSelectionBounds", getSelectionBounds);

  return wrappers;
}

/** @param {PropertyDescriptor | undefined} descriptor */
function replaceable(descriptor) {
  if (!descriptor) return true;
  if ("value" in descriptor)
    return descriptor.writable === true || descriptor.configurable === true;
  return descriptor.configurable === true;
}

/** @param {object} host @returns {Bridge | undefined} */
function install(host) {
  const originals = new Map();
  for (const method of METHODS) {
    const original = Reflect.get(host, method);
    if (typeof original !== "function") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(host, method);
    if (!replaceable(descriptor)) return undefined;
    originals.set(method, { original, descriptor });
  }
  /** @type {Bridge} */
  const bridge = {
    members: new Set(),
    cancelling: false,
    originals,
    wrappers: new Map(),
  };
  const wrappers = makeWrappers(host, bridge);
  bridge.wrappers = wrappers;
  const installedMethods = [];
  try {
    for (const method of HOOKS) {
      const descriptor = originals.get(method)?.descriptor;
      const wrapper = wrappers.get(method);
      if (typeof wrapper !== "function") throw new Error("missing wrapper");
      const next = descriptor
        ? "value" in descriptor
          ? { ...descriptor, value: wrapper }
          : {
              configurable: descriptor.configurable,
              enumerable: descriptor.enumerable,
              writable: true,
              value: wrapper,
            }
        : { configurable: true, writable: true, enumerable: false, value: wrapper };
      Object.defineProperty(host, method, next);
      installedMethods.push(method);
    }
  } catch {
    for (const method of installedMethods.reverse()) {
      const descriptor = originals.get(method)?.descriptor;
      try {
        if (descriptor) Object.defineProperty(host, method, descriptor);
        else Reflect.deleteProperty(host, method);
      } catch {
        // Rollback is best-effort; the host remains usable.
      }
    }
    return undefined;
  }
  const bridges = registry();
  if (!bridges) {
    for (const method of installedMethods.reverse()) {
      const descriptor = originals.get(method)?.descriptor;
      try {
        if (descriptor) Object.defineProperty(host, method, descriptor);
        else Reflect.deleteProperty(host, method);
      } catch {
        // Rollback is best-effort.
      }
    }
    return undefined;
  }
  bridges.set(host, bridge);
  return bridge;
}

/** @param {object} host @param {Bridge} bridge */
function detach(host, bridge) {
  bridge.active = undefined;
  bridge.domain = undefined;
  bridge.pending = undefined;
  bridge.blocked = false;
  bridge.suppressed = false;
  for (const method of HOOKS) {
    try {
      if (Reflect.get(host, method) !== bridge.wrappers.get(method)) continue;
      const descriptor = bridge.originals.get(method)?.descriptor;
      if (descriptor) Object.defineProperty(host, method, descriptor);
      else Reflect.deleteProperty(host, method);
    } catch {
      // Never overwrite a later host/extension change during cleanup.
    }
  }
  const bridges = registry();
  if (bridges?.get(host) === bridge) bridges.delete(host);
}

/** A partial takeover means another wrapper now owns at least one hook. Cancel
 * our live domain, retire every lease, and detach only the hooks still ours.
 * Never stack a second bridge over the remainder or retry the takeover.
 * @param {object} host @param {Bridge} bridge @param {Member} [current] */
function retireBridge(host, bridge, current) {
  bridge.retired = true;
  const owned = bridge.active && ownsAnchor(bridge.active);
  const cancelled = !owned || cancel(bridge, host);
  if (!owned) clearActive(bridge);
  for (const other of bridge.members) {
    other.bridge = undefined;
    other.unsupported = true;
  }
  bridge.members.clear();
  if (current) {
    current.bridge = undefined;
    current.unsupported = true;
  }
  // If both reset paths failed, keep this bridge as a retired tombstone rather
  // than detaching and leaving a live tagged anchor unbounded. The retired flag
  // refuses new members even if a foreign hook is later restored to our wrapper,
  // and no second bridge is stacked over the partial takeover.
  if (cancelled) detach(host, bridge);
}

/** @param {Member} member @returns {Bridge | undefined} */
function ensureBridge(member) {
  if (member.disposed || member.unsupported) return undefined;
  if (!isObject(member.host)) {
    member.unsupported = true;
    return undefined;
  }
  const host = member.host;
  const existing = member.bridge;
  if (existing) {
    if (existing.retired) {
      retireBridge(host, existing);
      return undefined;
    }
    if (installed(host, existing)) return existing;
    retireBridge(host, existing);
    return undefined;
  }
  const bridges = registry();
  if (!bridges) {
    member.unsupported = true;
    return undefined;
  }
  const shared = bridges.get(host);
  if (shared) {
    if (shared.retired) {
      retireBridge(host, shared, member);
      return undefined;
    }
    if (installed(host, shared)) {
      shared.members.add(member);
      member.bridge = shared;
      return shared;
    }
    retireBridge(host, shared, member);
    return undefined;
  }
  const next = install(host);
  if (!next) {
    member.unsupported = true;
    return undefined;
  }
  next.members.add(member);
  member.bridge = next;
  return next;
}

/**
 * One instance per visible panel. `paint` publishes the body rectangle that was
 * actually rendered; no rectangle means no admission. Geometry or viewport-key
 * changes cancel this member's bound selection. `reset` retires the geometry
 * until the next paint. Dispose at final teardown.
 * @param {{ host?: object, component: object }} options
 */
export function createPopoverTextSelection(options) {
  const reference = options?.host;
  const host = resolveTuiRenderer(reference);
  /** @type {Member} */
  const member = {
    host,
    component: options?.component,
    token: {},
    disposed: false,
    isCurrent: () => host === reference || resolveTuiRenderer(reference) === host,
  };
  const cancelOwned = () => {
    const bridge = member.bridge;
    if (!bridge || !isObject(host)) return;
    if (ownsAnchor(member)) cancel(bridge, host, member);
    else if (bridge.active === member) clearActive(bridge);
  };
  if (isObject(host)) ensureBridge(member);
  return {
    /** @param {Rect | undefined} rect @param {unknown} [viewportKey] */
    paint(rect, viewportKey) {
      if (member.disposed || !isObject(host)) return;
      if (member.bridge && (!installed(host, member.bridge) || member.bridge.retired)) {
        retireBridge(host, member.bridge);
        member.bridge = undefined;
      }
      const next = validRect(rect)
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : undefined;
      const viewport = terminalSize(host);
      const changed =
        !sameRect(next, member.rect) ||
        !Object.is(viewportKey, member.viewportKey) ||
        !sameSize(viewport, member.viewport);
      member.rect = next;
      member.viewportKey = viewportKey;
      member.viewport = viewport;
      if (!changed) return;
      if (!member.bridge) ensureBridge(member);
      cancelOwned();
    },
    reset() {
      if (member.disposed || !isObject(host)) return;
      if (member.bridge && (!installed(host, member.bridge) || member.bridge.retired)) {
        retireBridge(host, member.bridge);
        member.bridge = undefined;
      }
      member.rect = undefined;
      member.viewportKey = undefined;
      member.viewport = undefined;
      if (!member.bridge) ensureBridge(member);
      cancelOwned();
    },
    dispose() {
      if (member.disposed) return;
      member.disposed = true;
      member.rect = undefined;
      member.viewportKey = undefined;
      member.viewport = undefined;
      if (!isObject(host)) return;
      if (member.bridge && (!installed(host, member.bridge) || member.bridge.retired)) {
        retireBridge(host, member.bridge);
        member.bridge = undefined;
      }
      const bridge = member.bridge;
      member.bridge = undefined;
      if (!bridge) return;
      let retained = false;
      if (ownsAnchor(member)) retained = !cancel(bridge, host, member);
      else if (bridge.active === member) clearActive(bridge);
      if (!retained) bridge.members.delete(member);
      if (bridge.members.size === 0 && !retained) detach(host, bridge);
    },
  };
}
