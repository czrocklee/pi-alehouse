export const POPOVER_DOCK_ROWS: 1;
export const POPOVER_MIN_ROWS: 3;
export interface StackHost {
  readonly terminal: { readonly rows: number };
  requestRender(): void;
}
export interface StackMember {
  /** Rows under this popover: the footer plus every popover opened before it. */
  readonly bottom: number;
  /** Shared preferred column width; the renderer clamps it to terminal columns. */
  readonly width: number;
  /** Register this member's desired width before any member is painted. */
  preferWidth(width: () => number): void;
  /** Rows between the terminal top and this popover's bottom edge. */
  available(): number;
  measure(height: number): void;
  leave(): void;
}
export interface StackedOverlayOptions {
  anchor: "bottom-right";
  readonly width: number;
  minWidth: number;
  readonly margin: { bottom: number };
  readonly maxHeight: number;
  visible(): boolean;
  nonCapturing: boolean;
}
export function joinPopoverStack(host: StackHost): StackMember;
export function focusedComponent(host: object): unknown;
export function focusOrigin(host: object): unknown[] | undefined;
export function focusRevealed(host: object,
  handle: { isHidden(): boolean; isFocused(): boolean; focus(): void }, origin: unknown[] | undefined): void;
export function stackedOverlayOptions(member: StackMember,
  layout: { width: number | (() => number); minWidth?: number; minRows?: number; nonCapturing?: boolean;
    onReveal?: () => void }): StackedOverlayOptions;
