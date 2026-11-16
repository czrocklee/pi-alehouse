export type BorderLabelPlacement = "border" | "inside" | "plain";

/** Theme roles the shared chrome paints with. `bold` is required. */
export interface ChromeTheme {
  fg(color: "borderAccent" | "borderMuted" | "muted" | "accent", text: string): string;
  bold(text: string): string;
}

/** Injected terminal metrics; keeps this leaf free of an SDK dependency. */
export interface ChromeMetrics {
  clip(text: string, columns: number): string;
  width(text: string): number;
}

export interface ChromeBand {
  placement: BorderLabelPlacement;
  rows: number;
  labelY: number;
}

export interface ChromeLayout {
  top: ChromeBand;
  bottom: ChromeBand;
  rows: number;
  bodyY: number;
  footerFromBottom: number;
}

export interface InlayFlush {
  start?: boolean;
  end?: boolean;
}

/** Shared cross-bundle preference; defaults to enabled. */
export function borderLabelsEnabled(): boolean;
export function setBorderLabelsEnabled(enabled: boolean): void;
/** Returns an idempotent disposer; observer failures are isolated. */
export function onBorderLabelsChange(listener: () => void): () => void;

/** Columns `popoverInlay` leaves for its inlay at this width. */
export function popoverInlayWidth(
  width: number,
  kind: "top" | "bottom",
  closable?: boolean,
): number;

/** Exact legacy inlay renderer, with terminal metrics injected. */
export function popoverInlay(
  theme: ChromeTheme,
  width: number,
  inlay: string,
  kind: "top" | "bottom",
  metrics: ChromeMetrics,
  closable?: boolean,
  closeHovered?: boolean,
  flush?: InlayFlush,
): string;

/** Three-row inset band used when the label is off the border. */
export function popoverInsetLabelRows(
  theme: ChromeTheme,
  width: number,
  label: string,
  kind: "top" | "bottom",
  metrics: ChromeMetrics,
  options?: { closable?: boolean; closeHovered?: boolean },
): [string, string, string];

/**
 * Custom top/bottom label rows: legacy inlay (one row) when border labels are
 * on, shared inset band (three rows) when off. `flush` only affects the border
 * form.
 */
export function popoverLabelRows(
  theme: ChromeTheme,
  width: number,
  styledLabel: string,
  kind: "top" | "bottom",
  metrics: ChromeMetrics,
  options?: { closable?: boolean; closeHovered?: boolean; flush?: InlayFlush },
): string[];

/** Title rows: legacy title primitive (one row) or shared inset band. */
export function popoverTitleRows(
  theme: ChromeTheme,
  width: number,
  title: string,
  metrics: ChromeMetrics,
  closable?: boolean,
  hovered?: boolean,
): string[];

/** Shared close hit with the row for the current placement. */
export function popoverChromeCloseHit(
  width: number,
): { x: number; y: number; width: number } | undefined;

/** Chrome row budgets for a framed or unframed panel. The shared switch
 * chooses the placement; there is no per-chrome override. */
export function popoverChromeLayout(options?: { framed?: boolean }): ChromeLayout;

/** Painted text cells inside the shared frame, excluding chrome and gutters.
 * Invalid/empty geometry has no selection region. */
export function popoverTextRect(
  width: number,
  height: number,
  options?: { inset?: number; top?: number; bottom?: number },
): { x: number; y: number; width: number; height: number } | undefined;
