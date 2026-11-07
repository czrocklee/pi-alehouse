import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type { PinnedPopoverYield } from "../../shared/overlay-protocol.mjs";
import {
  focusOrigin,
  focusRevealed,
  joinPopoverStack,
  stackedOverlayOptions,
  type StackHost,
  type StackMember,
} from "../../shared/popover-stack.mjs";
import { PRESET_PICKER_MIN_ROWS } from "./preset-picker.ts";

const PRESET_OVERLAY_WIDTH = 76;
const PRESET_OVERLAY_MIN_WIDTH = 34;

export interface PresetOverlayPlacement {
  rows(): number;
  measure(height: number): void;
}
type PresetCustomOptions =
  | { overlay: false }
  | {
      overlay: true;
      onHandle: (handle: OverlayHandle) => void;
      overlayOptions: () => OverlayOptions;
    };

/**
 * Floating preset-picker overlay only: pinned yield, stack place, and reveal.
 * Not a general overlay manager. The coordinator still owns the picker lock.
 */
export interface PresetOverlayHost {
  readonly floating: boolean;
  customOptions(): PresetCustomOptions;
  /** After the custom factory has mounted. Docked opens do not join the stack. */
  attach(tui: StackHost): PresetOverlayPlacement | undefined;
  /** Clear reveal, leave the stack, then release the pinned yield. Idempotent. */
  release(): void;
}

export function createPresetOverlayHost(options: {
  floating: boolean;
  emitPinned: (data: PinnedPopoverYield) => void;
}): PresetOverlayHost {
  let place: StackMember | undefined;
  let handle: OverlayHandle | undefined;
  let reveal: (() => void) | undefined;
  let releasePinned: (() => void) | undefined;
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
            ? stackedOverlayOptions(place, {
                width: PRESET_OVERLAY_WIDTH,
                minWidth: PRESET_OVERLAY_MIN_WIDTH,
                minRows: PRESET_PICKER_MIN_ROWS,
                onReveal: () => reveal?.(),
              })
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
        const token = {};
        // Own the release before publishing: even a throwing start must be paired.
        releasePinned = () => {
          releasePinned = undefined;
          options.emitPinned({ token, active: false });
        };
        options.emitPinned({ token, active: true });
        place = joinPopoverStack(tui);
      }
      const openedFrom = focusOrigin(tui);
      reveal = () => {
        if (handle) focusRevealed(tui, handle, openedFrom);
      };
      const member = place;
      return member
        ? { rows: () => member.available(), measure: (height) => member.measure(height) }
        : undefined;
    },
    release() {
      reveal = undefined;
      try {
        place?.leave();
      } finally {
        place = undefined;
        const finish = releasePinned;
        releasePinned = undefined;
        finish?.();
      }
    },
  };
}
