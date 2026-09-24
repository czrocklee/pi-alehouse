export const HIDE_TRANSIENT_OVERLAYS_EVENT: "pi-harness:hide-transient-overlays";
export const FOOTER_INDICATOR_CLICK_EVENT: "pi-footer:indicator-click";
export const WORKER_PRESET_INDICATOR: "harness-preset";
export const APPROVAL_INDICATOR: "approval";
export const HEALTH_INDICATOR: "session-health";
export const PINNED_INDICATORS: readonly ["harness-preset", "approval", "session-health"];
export interface FooterIndicatorClick {
  readonly key: string;
  handled: boolean;
}
