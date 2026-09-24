/** Cross-extension settlement protocol. Keep the event name stable: the
 * independently bundled footer must step aside before a harness panel closes. */
export const HIDE_TRANSIENT_OVERLAYS_EVENT = "pi-harness:hide-transient-overlays";

/** A footer status segment was clicked; the payload is `{ key, handled }`.
 * The extension that owns `key` claims the click by setting `handled`
 * synchronously. An unclaimed click falls back to the footer's usage panel. */
export const FOOTER_INDICATOR_CLICK_EVENT = "pi-footer:indicator-click";
/** The harness's worker-routing status, leftmost in the pinned corner group. */
export const WORKER_PRESET_INDICATOR = "harness-preset";
/** The approval indicator's status (approval-mode.ts). */
export const APPROVAL_INDICATOR = "approval";
/** Observed main-session activity/attention; opens the separate Stats view. */
export const HEALTH_INDICATOR = "session-health";
/** Left-to-right corner order; health stays at the right edge. Independent of
 * popover stacking, which continues to follow opening order. */
export const PINNED_INDICATORS = /** @type {readonly ["harness-preset", "approval", "session-health"]} */ (
  Object.freeze([WORKER_PRESET_INDICATOR, APPROVAL_INDICATOR, HEALTH_INDICATOR]));
