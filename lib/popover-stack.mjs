/**
 * One column of popovers in the bottom-right corner, shared by separately
 * bundled extensions. The first popover opened rests on the footer and later
 * ones stack upward without shifting existing popovers vertically; when one
 * closes, those above it drop into its place. Every popover uses the same
 * column width: the widest currently open member's preferred width (including
 * its minimum), clamped to the terminal by the renderer. Both edges line up.
 *
 * The footer and the harness are distinct module instances, so the column
 * lives in a process-wide registry keyed by the TUI both of them draw into.
 */
const REGISTRY_KEY = Symbol.for("nixos-config.pi.popover-stack.v1");
/** The one-row status footer the column rests on. */
export const POPOVER_DOCK_ROWS = 1;
/** Below this the column has no room for even a framed row; the popover waits
 * off screen instead of painting a sliver of border. A popover whose smallest
 * usable layout is taller passes its own `minRows`. */
export const POPOVER_MIN_ROWS = 3;

/** @typedef {{ readonly terminal: { readonly rows: number }, requestRender(): void }} StackHost */
/**
 * @typedef {{
 *   readonly bottom: number,
 *   readonly width: number,
 *   preferWidth(width: () => number): void,
 *   available(): number,
 *   measure(height: number): void,
 *   leave(): void,
 * }} StackMember
 */
/** @typedef {{ height: number, preferredWidth?: () => number }} Slot */

/** @param {StackHost} host @returns {Slot[]} */
function column(host) {
  const globals = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  let registry = globals[REGISTRY_KEY];
  if (!(registry instanceof WeakMap)) {
    registry = new WeakMap();
    globals[REGISTRY_KEY] = registry;
  }
  const stacks = /** @type {WeakMap<StackHost, Slot[]>} */ (registry);
  let slots = stacks.get(host);
  if (!slots) {
    slots = [];
    stacks.set(host, slots);
  }
  return slots;
}

/**
 * Take the next place up the column. Keep the member for as long as the
 * popover is logically open -- including while it briefly steps aside -- so
 * its place is held; `leave` gives the place up.
 * @param {StackHost} host
 * @returns {StackMember}
 */
export function joinPopoverStack(host) {
  const slots = column(host);
  /** @type {Slot} */
  const slot = { height: 0 };
  slots.push(slot);
  const below = () => {
    let rows = POPOVER_DOCK_ROWS;
    for (const other of slots) {
      if (other === slot) break;
      rows += other.height;
    }
    return rows;
  };
  const available = () => Math.max(0, host.terminal.rows - below());
  // Register preferences before layout, not while painting: even the first
  // member rendered must already know the width wanted by the last one.
  const width = () => Math.max(1, ...slots.map((other) => other.preferredWidth?.() ?? 1));
  return {
    get bottom() { return below(); },
    get width() { return width(); },
    preferWidth(preferredWidth) {
      if (!slots.includes(slot)) return;
      const before = width();
      slot.preferredWidth = preferredWidth;
      if (width() !== before) host.requestRender();
    },
    available,
    /** Record the rows this popover last painted. Only popovers above read it,
     * and the renderer may already have placed them this frame, so a change
     * asks for one more layout; heights flow upward only, so this settles. */
    measure(height) {
      if (!slots.includes(slot)) return;
      const next = Math.max(0, Math.min(height, available()));
      if (next === slot.height) return;
      slot.height = next;
      if (slots.indexOf(slot) < slots.length - 1) host.requestRender();
    },
    leave() {
      const index = slots.indexOf(slot);
      if (index < 0) return;
      const before = width();
      slots.splice(index, 1);
      // A top/hidden member can still be the widest. Closing it must repaint
      // the remaining column even when it frees no vertical space below them.
      if ((slot.height > 0 && index < slots.length) || (slots.length && width() !== before)) host.requestRender();
    },
  };
}

/**
 * The component holding the keyboard. Pi's renderers all have the method, but
 * its public `TUI` interface does not promise it; without it, `undefined`.
 * @param {object} host
 * @returns {unknown}
 */
export function focusedComponent(host) {
  const read = /** @type {{ getFocusedComponent?: () => unknown }} */ (host).getFocusedComponent;
  return typeof read === "function" ? read.call(host) : undefined;
}

/** @param {object} host @returns {{ component: unknown, preFocus?: unknown }[] | undefined} */
function overlayEntries(host) {
  // Pi's renderers keep their overlays here; the field is not public API, so
  // without it only the first link of a focus origin is ever used.
  const stack = /** @type {{ overlayStack?: unknown }} */ (host).overlayStack;
  return Array.isArray(stack) ? stack : undefined;
}

/**
 * Where the keyboard is when a popover opens, and where it goes back to as
 * the overlays holding it close: the focused component, then each overlay's
 * own previous focus. Take it before showing the popover.
 * @param {object} host
 * @returns {unknown[] | undefined}
 */
export function focusOrigin(host) {
  const first = focusedComponent(host);
  if (first === undefined) return undefined;
  const chain = [first];
  const entries = overlayEntries(host) ?? [];
  for (;;) {
    const next = entries.find((entry) => entry.component === chain.at(-1))?.preFocus;
    if (next === undefined || next === null || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}

/**
 * Give a popover that was just revealed the keyboard it would have had if it
 * had opened on screen. Focus must still be at its origin: overlays that held
 * the keyboard then and have closed since are skipped, since Pi handed their
 * focus back; one still open, or anything that took the keyboard meanwhile,
 * keeps it. When focus cannot be read, it is left alone.
 * @param {object} host
 * @param {{ isHidden(): boolean, isFocused(): boolean, focus(): void }} handle
 * @param {unknown[] | undefined} origin `focusOrigin(host)` when the popover opened
 */
export function focusRevealed(host, handle, origin) {
  if (!origin || handle.isHidden() || handle.isFocused()) return;
  const focused = focusedComponent(host);
  const entries = overlayEntries(host);
  for (const component of origin) {
    if (component === focused) {
      handle.focus();
      return;
    }
    // Still open (shown or stepped aside) but not focused: not ours to take.
    if (!entries || entries.some((entry) => entry.component === component)) return;
  }
}

/**
 * Overlay options for a stacked popover. Pi reads these on every layout, so
 * the getters follow the popovers below it, terminal resizes and the shared
 * column width, all without remounting. A temporary hide keeps both its place
 * and width preference until the member leaves.
 *
 * A popover waits off screen until `minRows` fit, so it never paints with its
 * controls or bottom edge cut off. Pi focuses a capturing overlay only when it
 * is shown visible; `onReveal` runs (outside the layout pass) each time the
 * popover comes back from off screen, so its owner can take the keyboard.
 * @param {StackMember} member
 * @param {{ width: number | (() => number), minWidth?: number, minRows?: number,
 *   nonCapturing?: boolean, onReveal?: () => void }} layout
 */
export function stackedOverlayOptions(member, layout) {
  const minRows = Math.max(POPOVER_MIN_ROWS, layout.minRows ?? 0);
  member.preferWidth(() => Math.max(layout.minWidth ?? 1,
    typeof layout.width === "function" ? layout.width() : layout.width));
  /** @type {boolean | undefined} */
  let shown;
  return {
    anchor: /** @type {const} */ ("bottom-right"),
    get width() { return member.width; },
    minWidth: layout.minWidth ?? 1,
    get margin() { return { bottom: member.bottom }; },
    get maxHeight() { return Math.max(1, member.available()); },
    visible() {
      const room = member.available() >= minRows;
      // Off screen it covers no rows, so nothing above should leave a gap for it.
      if (!room) member.measure(0);
      // Pi calls this mid-layout and mid-input; focus must change after it.
      if (room && shown === false && layout.onReveal) void Promise.resolve().then(layout.onReveal);
      shown = room;
      return room;
    },
    nonCapturing: layout.nonCapturing === true,
  };
}
