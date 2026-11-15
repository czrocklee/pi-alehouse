import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import {
  focusOrigin,
  focusRevealed,
  joinPopoverStack,
  stackedOverlayOptions,
  type StackHost,
  type StackMember,
} from "../../shared/popover-stack.mjs";
import { presetPickerMinRows } from "./preset-picker.ts";

const PRESET_OVERLAY_WIDTH = 76;
const PRESET_OVERLAY_MIN_WIDTH = 34;

export interface PresetOverlayPlacement {
  rows(): number;
  measure(height: number): void;
  /** Compare the last completed paint to live placement before pointer actions. */
  pointerCurrent(): boolean;
}
type PresetStackHost = StackHost & { readonly terminal: { readonly columns?: number } };
type PresetCustomOptions =
  | { overlay: false }
  | {
      overlay: true;
      onHandle: (handle: OverlayHandle) => void;
      overlayOptions: () => OverlayOptions;
    };

/**
 * Floating preset-picker overlay only: stack place and reveal.
 * Not a general overlay manager. The coordinator still owns the picker lock.
 */
export interface PresetOverlayHost {
  readonly floating: boolean;
  customOptions(): PresetCustomOptions;
  /** Before the picker mounts. Docked opens do not join the stack. */
  attach(tui: PresetStackHost): PresetOverlayPlacement | undefined;
  /** Clear reveal and leave the stack. Idempotent. */
  release(): void;
}

export function createPresetOverlayHost(options: {
  floating: boolean;
  /** Stack hiding skips component.render; retire pointer targets and capture,
   * not keyboard readiness (which checks the current row budget separately). */
  onHide?: () => void;
  /** Retire pointer targets after a lower member translates this panel. */
  onMove?: () => void;
}): PresetOverlayHost {
  let place: StackMember | undefined;
  let placement: OverlayOptions | undefined;
  let handle: OverlayHandle | undefined;
  let reveal: (() => void) | undefined;
  return {
    floating: options.floating,
    customOptions() {
      if (!options.floating) return { overlay: false };
      return {
        overlay: true,
        onHandle: (mounted) => {
          handle = mounted;
        },
        overlayOptions: (): OverlayOptions =>
          place
            ? (placement ??= stackedOverlayOptions(place, {
                width: PRESET_OVERLAY_WIDTH,
                minWidth: PRESET_OVERLAY_MIN_WIDTH,
                // The reveal floor follows the current title chrome: the
                // shared switch owns the delta, so the waiting notice and the
                // stack agree on how many rows the picker needs.
                minRows: presetPickerMinRows,
                onReveal: () => reveal?.(),
                onHide: options.onHide,
                onMove: options.onMove,
              }))
            : {
                anchor: "center",
                width: PRESET_OVERLAY_WIDTH,
                minWidth: PRESET_OVERLAY_MIN_WIDTH,
                maxHeight: "80%",
                margin: 1,
              },
      };
    },
    attach(tui) {
      if (options.floating) {
        place = joinPopoverStack(tui);
        placement = undefined;
      }
      const openedFrom = focusOrigin(tui);
      reveal = () => {
        if (handle) focusRevealed(tui, handle, openedFrom);
      };
      const member = place;
      if (!member) return undefined;
      const position = () =>
        `${tui.terminal.columns}:${tui.terminal.rows}:${member.bottom}:${member.width}`;
      let paintedPosition: string | undefined;
      return {
        rows: () => member.available(),
        measure: (height) => {
          paintedPosition = position();
          member.measure(height);
        },
        pointerCurrent: () => place === member && paintedPosition === position(),
      };
    },
    release() {
      reveal = undefined;
      try {
        place?.leave();
      } finally {
        place = undefined;
        placement = undefined;
      }
    },
  };
}
