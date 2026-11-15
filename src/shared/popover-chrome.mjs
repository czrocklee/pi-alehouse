/** Pure popover chrome shared by separately bundled Pi extensions.
 *
 * One global preference decides whether labels sit on the border or in a
 * three-row inset band below it. The border itself never disappears. The
 * cross-bundle state lives behind a versioned process-wide symbol so the
 * footer and orchestration bundles observe the same value. No SDK import and
 * no per-chrome policy: consumers inject terminal metrics and their own theme.
 */
import {
  POPOVER,
  POPOVER_CLOSE_COLUMNS,
  popoverCloseHit,
  popoverCloseTail,
  popoverRule,
  popoverSide,
  popoverTitleRow,
} from "./popover-frame.mjs";

const REGISTRY_KEY = Symbol.for("pi-alehouse:border-labels:v1");

/** @typedef {"border" | "inside" | "plain"} BorderLabelPlacement */
/** @typedef {{ fg: (color: "borderAccent" | "borderMuted" | "muted" | "accent", text: string) => string, bold: (text: string) => string }} ChromeTheme */
/** @typedef {{ clip: (text: string, columns: number) => string, width: (text: string) => number }} ChromeMetrics */
/** @typedef {{ placement: BorderLabelPlacement, rows: number, labelY: number }} ChromeBand */
/** @typedef {{ top: ChromeBand, bottom: ChromeBand, rows: number, bodyY: number, footerFromBottom: number }} ChromeLayout */
/** @typedef {{ enabled: boolean, listeners: Set<() => void> }} BorderLabelState */
/** @typedef {{ start?: boolean, end?: boolean }} InlayFlush */

/** @returns {BorderLabelState} */
function borderLabelState() {
  const globals = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const existing = globals[REGISTRY_KEY];
  if (existing && typeof existing === "object") {
    const state = /** @type {BorderLabelState} */ (existing);
    if (typeof state.enabled === "boolean" && state.listeners instanceof Set) return state;
  }
  /** @type {BorderLabelState} */
  const state = { enabled: true, listeners: new Set() };
  globals[REGISTRY_KEY] = state;
  return state;
}

/** Whether labels currently sit on the border. Defaults to enabled. */
export function borderLabelsEnabled() {
  return borderLabelState().enabled;
}

/**
 * Set the shared border-label preference. Only an actual change notifies;
 * observers are isolated so one broken subscriber cannot block the others or
 * the state change.
 * @param {boolean} enabled
 */
export function setBorderLabelsEnabled(enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("border labels must be a boolean");
  const state = borderLabelState();
  if (state.enabled === enabled) return;
  state.enabled = enabled;
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch {
      // A broken observer must not stop the others or the state change.
    }
  }
}

/**
 * Subscribe to preference changes. The returned disposer is idempotent and is
 * the only lifecycle handle: consumers call it when their panel is torn down.
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onBorderLabelsChange(listener) {
  if (typeof listener !== "function")
    throw new TypeError("border label listener must be a function");
  const state = borderLabelState();
  state.listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    state.listeners.delete(listener);
  };
}

/** @param {ChromeTheme} theme @param {string} text */
const outer = (theme, text) => theme.fg("borderAccent", text);

/**
 * Normalize caller geometry: floor finite widths, collapse everything else.
 * @param {number} width @returns {number}
 */
function normalizeWidth(width) {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/** @param {ChromeMetrics} metrics @param {string} text @returns {number} */
function measuredWidth(metrics, text) {
  try {
    const value = metrics.width(text);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** @param {ChromeMetrics} metrics @param {string} text @param {number} columns @returns {string} */
function clipped(metrics, text, columns) {
  if (columns <= 0) return "";
  try {
    const value = metrics.clip(text, columns);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** @param {number} width @param {"top" | "bottom"} kind @param {boolean} closable */
const inlayClosable = (width, kind, closable) =>
  kind === "top" && closable && !!popoverCloseHit(width);

/**
 * Columns `popoverInlay` leaves for its inlay at this width. This is the legacy
 * orchestration formula, now shared so every panel budgets the same label
 * capacity. Nonfinite, negative and fractional widths normalize to a finite
 * floor.
 * @param {number} width
 * @param {"top" | "bottom"} kind
 * @param {boolean} [closable]
 * @returns {number}
 */
export function popoverInlayWidth(width, kind, closable = false) {
  const columns = normalizeWidth(width);
  return Math.max(
    0,
    columns - (inlayClosable(columns, kind, closable) ? 3 + POPOVER_CLOSE_COLUMNS : 6),
  );
}

/**
 * Top or bottom edge with chrome inlaid between the corners. Unused columns
 * are rule, so the box cannot trail off into the conversation behind it. A
 * closable top edge ends in the close control instead of `─╮`. An inlay that
 * begins (`flush.start`) or ends (`flush.end`) in rule of its own has that
 * pad column drawn as rule too, so the edge meets the corner unbroken while
 * every inlay column stays put. Metrics are injected so this leaf has no SDK
 * dependency; the renderer itself is the exact legacy orchestration inlay.
 * Below six columns the edge degrades to a bare `popoverRule` instead of
 * overflowing the corner chrome.
 * @param {ChromeTheme} theme
 * @param {number} width
 * @param {string} inlay
 * @param {"top" | "bottom"} kind
 * @param {ChromeMetrics} metrics
 * @param {boolean} [closable]
 * @param {boolean} [closeHovered]
 * @param {InlayFlush} [flush]
 * @returns {string}
 */
export function popoverInlay(
  theme,
  width,
  inlay,
  kind,
  metrics,
  closable = false,
  closeHovered = false,
  flush = {},
) {
  const columns = normalizeWidth(width);
  // Below six columns even the corner/rule chrome cannot fit around a label;
  // degrade to the bare edge instead of the legacy six-column overflow.
  if (columns < 6) return popoverRule(theme, columns, kind);
  const chrome = popoverInlayWidth(columns, kind, closable);
  const text = clipped(metrics, typeof inlay === "string" ? inlay : "", chrome);
  const remaining = Math.max(0, chrome - measuredWidth(metrics, text));
  const options = flush ?? {};
  const left =
    outer(theme, (kind === "top" ? POPOVER.tl : POPOVER.bl) + POPOVER.h) +
    (options.start ? outer(theme, POPOVER.h) : " ") +
    text;
  if (inlayClosable(columns, kind, closable)) {
    // The close tail already starts with a space. Separate a short title from
    // the rule, but don't add another pad when the inlay fills its whole width.
    const fill =
      remaining >= 2
        ? " " + outer(theme, POPOVER.h.repeat(remaining - 1))
        : outer(theme, POPOVER.h.repeat(remaining));
    return left + fill + popoverCloseTail(theme, closeHovered);
  }
  return (
    left +
    (options.end ? "" : " ") +
    outer(
      theme,
      POPOVER.h.repeat(remaining + (options.end ? 1 : 0)) +
        POPOVER.h +
        (kind === "top" ? POPOVER.tr : POPOVER.br),
    )
  );
}

/**
 * The three-row inside band for a label that cannot sit on the border: a bare
 * outer rule, the label row, and a separator. The bottom band reverses the
 * order. The label starts at column 3 (`side` + two-space pad) and has the same
 * capacity as `popoverInlayWidth`; a closable top row keeps the close glyph at
 * its shared `width - 4` column, with the tail's remaining cells as padding
 * rather than rule. Tiny widths degrade to rules and a blank body, never an
 * overflow.
 * @param {ChromeTheme} theme
 * @param {number} width
 * @param {string} label
 * @param {"top" | "bottom"} kind
 * @param {ChromeMetrics} metrics
 * @param {{ closable?: boolean, closeHovered?: boolean }} [options]
 * @returns {[string, string, string]}
 */
export function popoverInsetLabelRows(theme, width, label, kind, metrics, options = {}) {
  const columns = normalizeWidth(width);
  const top = kind !== "bottom";
  const edge = popoverRule(theme, columns, top ? "top" : "bottom");
  const divider = popoverRule(theme, columns, "divider");
  const body = insetBodyRow(theme, columns, label, top, metrics, options ?? {});
  /** @type {[string, string, string]} */
  const rows = top ? [edge, body, divider] : [divider, body, edge];
  return rows;
}

/**
 * @param {ChromeTheme} theme
 * @param {number} width
 * @param {string} label
 * @param {boolean} top
 * @param {ChromeMetrics} metrics
 * @param {{ closable?: boolean, closeHovered?: boolean }} options
 * @returns {string}
 */
function insetBodyRow(theme, width, label, top, metrics, options) {
  if (width <= 0) return "";
  const side = popoverSide(theme);
  if (width === 1) return side;
  if (width === 2) return side + side;
  if (width < 7) return side + " ".repeat(width - 2) + side;
  const closable = top && options.closable === true && !!popoverCloseHit(width);
  const capacity = width - (closable ? 8 : 6);
  const text = typeof label === "string" ? label : "";
  let clippedText = clipped(metrics, text, capacity);
  let used = measuredWidth(metrics, clippedText);
  if (used > capacity) {
    clippedText = "";
    used = 0;
  }
  const pad = " ".repeat(Math.max(0, capacity - used));
  if (closable) {
    const hovered = options.closeHovered === true;
    const glyph = hovered ? theme.bold(POPOVER.close) : POPOVER.close;
    const close = theme.fg(hovered ? "accent" : "muted", glyph);
    return side + "  " + clippedText + pad + " " + close + "  " + side;
  }
  return side + "  " + clippedText + pad + "  " + side;
}

/**
 * The rows for a custom top or bottom label. On the border this is the exact
 * legacy inlay edge (one row); with border labels off it is the shared
 * three-row inset band. `flush` only affects the border form.
 * @param {ChromeTheme} theme
 * @param {number} width
 * @param {string} styledLabel
 * @param {"top" | "bottom"} kind
 * @param {ChromeMetrics} metrics
 * @param {{ closable?: boolean, closeHovered?: boolean, flush?: InlayFlush }} [options]
 * @returns {string[]}
 */
export function popoverLabelRows(theme, width, styledLabel, kind, metrics, options = {}) {
  const { closable = false, closeHovered = false, flush = {} } = options ?? {};
  return borderLabelsEnabled()
    ? [popoverInlay(theme, width, styledLabel, kind, metrics, closable, closeHovered, flush)]
    : popoverInsetLabelRows(theme, width, styledLabel, kind, metrics, { closable, closeHovered });
}

/**
 * The title rows for the current placement: the legacy title primitive's
 * single border row, or the shared inset band with the same accent/bold title
 * styling. Titles keep their existing border geometry when labels are on.
 * @param {ChromeTheme} theme
 * @param {number} width
 * @param {string} title
 * @param {ChromeMetrics} metrics
 * @param {boolean} [closable]
 * @param {boolean} [hovered]
 * @returns {string[]}
 */
export function popoverTitleRows(theme, width, title, metrics, closable = false, hovered = false) {
  const columns = normalizeWidth(width);
  return borderLabelsEnabled()
    ? [popoverTitleRow(theme, columns, title, metrics, closable, hovered)]
    : popoverInsetLabelRows(theme, columns, theme.fg("accent", theme.bold(title)), "top", metrics, {
        closable,
        closeHovered: hovered,
      });
}

/**
 * The shared close hit for the current placement. The glyph stays at the same
 * column; only its row moves into the inset band when the label is off the
 * border. Nonfinite or too-narrow widths return undefined. Consumers pass `y`
 * through their generic close control.
 * @param {number} width
 * @returns {{ x: number, y: number, width: number } | undefined}
 */
export function popoverChromeCloseHit(width) {
  const hit = popoverCloseHit(normalizeWidth(width));
  return hit ? { ...hit, y: borderLabelsEnabled() ? 0 : 1 } : undefined;
}

/** @param {BorderLabelPlacement} placement @returns {ChromeBand} */
function band(placement) {
  return placement === "inside"
    ? { placement, rows: 3, labelY: 1 }
    : { placement, rows: 1, labelY: 0 };
}

/**
 * Chrome rows for a framed panel. The one shared switch chooses the placement
 * for both edges; a panel without a labeled bottom can still use `top` and
 * `bottom` independently. There is no per-chrome or per-band override.
 * @param {{ framed?: boolean }} [options]
 * @returns {ChromeLayout}
 */
export function popoverChromeLayout(options = {}) {
  const { framed = false } = options ?? {};
  const placement = framed ? (borderLabelsEnabled() ? "border" : "inside") : "plain";
  const topBand = band(placement);
  const bottomBand = band(placement);
  return {
    top: topBand,
    bottom: bottomBand,
    rows: topBand.rows + bottomBand.rows,
    bodyY: topBand.rows,
    footerFromBottom: bottomBand.rows - bottomBand.labelY,
  };
}
