/** Request that transient overlays step aside for a coordinated settlement.
 * Dismissing a single centered panel via its backdrop does not broadcast this. */
export const HIDE_TRANSIENT_OVERLAYS_EVENT = "pi-alehouse:hide-transient-overlays";

/** UI-only display hold for pinned popovers, not permission or Owner authority.
 * Holders retain their opaque token until the display hold ends; consumers
 * track tokens so overlapping holds release independently. Ordinary stacked
 * popovers, including the floating Delegation picker, do not acquire a hold.
 * @typedef {{ token: object, active: boolean }} PinnedPopoverYield
 */
export const PINNED_POPOVER_YIELD_EVENT = "pi-alehouse:pinned-popover-yield";

/** A footer status segment was clicked; the payload is `{ key, handled }`.
 * The extension that owns `key` claims the click by setting `handled`
 * synchronously. An unclaimed click falls back to the footer's usage panel. */
export const FOOTER_INDICATOR_CLICK_EVENT = "pi-footer:indicator-click";
/** A visual prefix of the current model, not a pinned or clickable control. */
export const FAST_MODEL_INDICATOR = "alehouse-fast";
export const FAST_MODEL_GLYPH = "⚡";
export const ULTRAFAST_MODEL_GLYPH = "⚡⚡";
/** Alehouse's worker-routing status, leftmost in the pinned corner group. */
export const WORKER_PRESET_INDICATOR = "alehouse-preset";
/** The approval indicator's status (approval-mode.ts). */
export const APPROVAL_INDICATOR = "approval";
/** Observed main-session activity/attention; opens the separate Stats view. */
export const HEALTH_INDICATOR = "session-health";
/** Left-to-right corner order; health stays at the right edge. Independent of
 * popover stacking, which continues to follow opening order. */
export const PINNED_INDICATORS =
  /** @type {readonly ["alehouse-preset", "approval", "session-health"]} */ (
    Object.freeze([WORKER_PRESET_INDICATOR, APPROVAL_INDICATOR, HEALTH_INDICATOR])
  );
