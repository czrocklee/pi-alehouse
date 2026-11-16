import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TuiMouseEvent, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease } from "@earendil-works/pi-tui";
import {
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  PINNED_POPOVER_YIELD_EVENT,
} from "../../shared/overlay-protocol.mjs";
import {
  borderLabelsEnabled,
  onBorderLabelsChange,
  popoverChromeCloseHit,
  popoverChromeLayout,
  popoverTextRect,
} from "../../shared/popover-chrome.mjs";
import { createPopoverCloseControl } from "../../shared/popover-close-control.mjs";
import { createPopoverCloseHover } from "../../shared/popover-close-hover.mjs";
import { createPopoverTextSelection } from "../../shared/popover-text-selection.mjs";
import {
  POPOVER_DOCK_ROWS,
  focusOrigin,
  focusRevealed,
  joinPopoverStack,
  stackedOverlayOptions,
  type StackMember,
} from "../../shared/popover-stack.mjs";
import { ContextView } from "./context-view.ts";
import type { ContextSnapshot } from "./context-stats.ts";
import type { ModelSpend } from "./session-spend.ts";
import {
  breakdownChromeRows,
  breakdownFrame,
  breakdownTable,
  breakdownTitle,
  breakdownWidth,
  contextSummary,
} from "./footer-layout.ts";

/** Private footer panels only; lifecycle and accounting stay with the caller. */
export function createFooterPanels(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  tui: TUI;
  theme: Theme;
  spend: () => ModelSpend[];
  contextSnapshot: () => ContextSnapshot;
  compaction: () => string | undefined;
  currentFooter: () => boolean;
}) {
  const { pi, ctx, tui, theme, spend, contextSnapshot, currentFooter } = options;
  // The per-model breakdown is a fullscreen-only affordance, and for two
  // reasons that happen to coincide: Pi reports mouse events only on the
  // alternate screen, and only its compositor repaints by absolute address.
  // The regular renderer draws into the array that backs scrollback, where
  // one append can commit a row of overlay chrome to terminal history.
  // Held while the panel is pinned, including while it briefly steps aside,
  // so it keeps its place in the bottom-right popover column.
  let member: StackMember | undefined;
  let overlay: OverlayHandle | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let promptDepth = 0;
  const pinnedHolds = new Set<object>();
  const panelsHeld = () => promptDepth > 0 || pinnedHolds.size > 0;
  /** Close-control geometry follows the latest paint, not event bounds. */
  let paintedWidth = 0;
  // Pi may dispatch using cached bounds before consulting visibility getters.
  const placement = (place: StackMember) =>
    `${place.bottom}:${tui.terminal.rows}:${tui.terminal.columns}`;
  let breakdownPlacement: string | undefined;
  let breakdownPressed = false;
  let suppressBreakdownClick = false;
  let breakdownHover: ReturnType<typeof createPopoverCloseControl> | undefined;
  /** One helper per pinned breakdown lifetime: created with the panel and
   * disposed with it, so a repeated show/hide never leaves a restored bridge. */
  let breakdownSelection: ReturnType<typeof createPopoverTextSelection> | undefined;
  const maxBreakdownRows = () =>
    (member?.available() ?? tui.terminal.rows - POPOVER_DOCK_ROWS) - breakdownChromeRows();
  /** The smallest complete frame this table can paint. ON keeps the shared
   * three-row floor; OFF includes both extra title rows and the bottom rule so
   * the stack hides rather than exposing controls above a clipped edge. */
  const breakdownMinRows = (): number => {
    if (borderLabelsEnabled()) return 0;
    const table = breakdownTable(spend(), maxBreakdownRows());
    const topRows = popoverChromeLayout({ framed: true }).top.rows;
    if (table.body.length === 0) return topRows + 2;
    const totals = table.body.reduce((sum, row) => sum + (row.kind === "total" ? 1 : 0), 0);
    return topRows + 1 + table.body.length + totals + (table.hidden > 0 ? 1 : 0) + 1;
  };
  const hideBreakdown = () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = undefined;
    const pinned = member !== undefined || overlay !== undefined;
    breakdownHover?.dispose();
    breakdownHover = undefined;
    breakdownSelection?.dispose();
    breakdownSelection = undefined;
    overlay?.hide();
    overlay = undefined;
    member?.leave();
    member = undefined;
    paintedWidth = 0;
    if (pinned) tui.requestRender();
  };
  const breakdown = {
    resetPointer() {
      breakdownHover?.reset(false);
      breakdownSelection?.reset();
      paintedWidth = 0;
      if (breakdownPressed) suppressBreakdownClick = true;
    },
    invalidate() {
      breakdown.resetPointer();
    },
    // Share the leaf/revision-keyed data with every stacked width getter;
    // layout and focus changes do not invalidate historical accounting.
    render: (width: number): string[] => {
      const closable = width > 0 && !!popoverChromeCloseHit(width);
      const table = breakdownTable(spend(), maxBreakdownRows());
      const lines = width > 0 ? breakdownFrame(table, theme, width) : [];
      breakdownHover?.paint(width, closable, lines.length);
      if (lines.length) {
        const title = breakdownTitle(theme, width, breakdownHover?.hovered);
        lines.splice(0, title.length, ...title);
      }
      paintedWidth = closable ? width : 0;
      breakdownPlacement = member && placement(member);
      member?.measure(lines.length);
      // Selectable text is the table body between the title band and the plain
      // bottom rule, inset past the frame and its gutter. The pinned panel has
      // no page or scroll state, so its viewport key is constant and the
      // helper retires on the painted geometry instead.
      breakdownSelection?.paint(
        lines.length ? popoverTextRect(width, lines.length, { inset: 2, bottom: 1 }) : undefined,
      );
      return lines;
    },
    handleMouse(event: TuiMouseEvent) {
      // Native dispatch can still send its captured synthetic click after the
      // release synchronously hid this panel and disposed its close control.
      // Consume it at the closed component boundary, not through a new panel.
      if (!member)
        return event.type === "click" && event.button === "left" ? { handled: true } : undefined;
      if (event.type === "press" && event.button === "left") {
        breakdownPressed = true;
        suppressBreakdownClick = false;
      }
      if (!member || breakdownPlacement !== placement(member)) breakdown.resetPointer();
      // Eligibility is a flag, not a gate: the control still observes the event
      // so it can cancel an in-progress gesture the panel would reject.
      const close = breakdownHover?.mouse(
        event,
        !!member && !!paintedWidth && !suppressBreakdownClick,
      );
      if (close) {
        if (event.type === "click") breakdownPressed = false;
        if (close.close) hideBreakdown();
        return { handled: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      breakdownPressed = false;
      if (suppressBreakdownClick) return undefined;
      // Only the close control closes; clicks on the table leave it pinned.
      return { handled: true };
    },
  };
  /** Context has a labeled top and bottom band; the shared layout adds four
   * rows when both move inside. The base six rows keep its existing floor, so
   * the stack hides rather than paints a readonly compact when it cannot fit. */
  const contextMinRows = (): number => 6 + popoverChromeLayout({ framed: true }).rows - 2;
  const unwatchBorderLabels = onBorderLabelsChange(() => {
    breakdown.invalidate();
    if (member) tui.requestRender();
  });
  const mountBreakdown = (place: StackMember) => {
    if (panelsHeld() || !currentFooter()) return;
    overlay = tui.showOverlay(
      breakdown,
      stackedOverlayOptions(place, {
        // Grows with new usage and follows resizes without remounting.
        width: () => breakdownWidth(breakdownTable(spend(), maxBreakdownRows())),
        minRows: breakdownMinRows,
        // The editor keeps the keyboard: this is a lightweight panel, not a dialog.
        nonCapturing: true,
        onHide: () => breakdown.resetPointer(),
        onMove: () => breakdown.resetPointer(),
      }),
    );
    tui.requestRender();
  };
  const showBreakdown = () => {
    if (member || tui.mode !== "fullscreen") return;
    breakdownPressed = suppressBreakdownClick = false;
    member = joinPopoverStack(tui);
    breakdownHover = createPopoverCloseControl({
      createHover: createPopoverCloseHover,
      closeHit: popoverChromeCloseHit,
      host: tui,
      requestRender: () => tui.requestRender(),
    });
    breakdownSelection = createPopoverTextSelection({ host: tui, component: breakdown });
    mountBreakdown(member);
  };
  // Cooperatively step aside during agent panel settlement, then return
  // to the same place. This is presentation coordination, not a workaround
  // for current Pi: ui.custom completion removes its own overlay entry.
  const pauseBreakdown = () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = undefined;
    breakdown.resetPointer();
    overlay?.hide();
    overlay = undefined;
    member?.measure(0);
  };
  const stepAside = () => {
    if (!overlay) return;
    pauseBreakdown();
    if (!panelsHeld())
      restoreTimer = setTimeout(() => {
        restoreTimer = undefined;
        if (member && !overlay && tui.mode === "fullscreen") mountBreakdown(member);
      }, 0);
  };
  let contextPanel: { member: StackMember; view: ContextView; handle?: OverlayHandle } | undefined;
  let contextRestore: ReturnType<typeof setTimeout> | undefined;
  let pendingContextFocus: { view: ContextView; origin: unknown[] | undefined } | undefined;
  let unsubscribeContextInput: (() => void) | undefined;
  const cancelPendingContextFocus = () => {
    pendingContextFocus = undefined;
    unsubscribeContextInput?.();
    unsubscribeContextInput = undefined;
  };
  const revealContext = () => {
    const pending = pendingContextFocus,
      panel = contextPanel;
    if (
      !pending ||
      !panel?.handle ||
      pending.view !== panel.view ||
      !currentFooter() ||
      panelsHeld()
    )
      return;
    if (panel.member.available() < contextMinRows()) return;
    focusRevealed(tui, panel.handle, pending.origin);
    // A different focus owner wins permanently, not merely until resize.
    cancelPendingContextFocus();
  };
  const hideContext = () => {
    cancelPendingContextFocus();
    if (contextRestore) clearTimeout(contextRestore);
    contextRestore = undefined;
    const previous = contextPanel;
    contextPanel = undefined;
    if (!previous) return;
    try {
      previous.handle?.hide();
    } finally {
      try {
        previous.view.dispose();
      } finally {
        previous.member.leave();
      }
    }
    tui.requestRender();
  };
  const mountContext = () => {
    if (
      !currentFooter() ||
      !contextPanel ||
      contextPanel.handle ||
      panelsHeld() ||
      tui.mode !== "fullscreen"
    )
      return;
    const panel = contextPanel;
    panel.handle = tui.showOverlay(
      panel.view,
      stackedOverlayOptions(panel.member, {
        width: () => panel.view.preferredWidth(Math.max(1, tui.terminal.columns - 4)),
        minRows: contextMinRows,
        nonCapturing: true,
        onReveal: () => {
          if (contextPanel === panel) revealContext();
        },
        onHide: () => panel.view.resetPointer(),
        onMove: () => panel.view.resetPointer(),
      }),
    );
    tui.requestRender();
  };
  const showContext = (focus: boolean) => {
    if (!currentFooter() || tui.mode !== "fullscreen") return;
    if (panelsHeld()) {
      if (focus && ctx.hasUI)
        ctx.ui.notify(
          contextSummary(
            contextSnapshot(),
            "Context is unavailable while another dialog owns the UI; retry /context after it closes.",
          ),
          "info",
        );
      return;
    }
    if (!contextPanel) {
      const place = joinPopoverStack(tui);
      let paintedPlacement: string | undefined;
      const view = new ContextView({
        tui,
        theme,
        snapshot: contextSnapshot,
        availableRows: () => place.available(),
        requestRender: () => {
          if (currentFooter()) tui.requestRender();
        },
        close: hideContext,
        isFocused: () => contextPanel?.handle?.isFocused() === true,
        pointerCurrent: () => paintedPlacement === placement(place),
        onRender: (height) => {
          paintedPlacement = placement(place);
          place.measure(height);
        },
        compaction: options.compaction,
      });
      contextPanel = { member: place, view };
    }
    if (focus) {
      cancelPendingContextFocus();
      pendingContextFocus = { view: contextPanel.view, origin: focusOrigin(tui) };
    }
    mountContext();
    if (focus) {
      contextPanel.handle?.focus();
      if (contextPanel.handle?.isFocused()) cancelPendingContextFocus();
      else {
        // Observe input only while an explicit off-screen request is pending;
        // passive pins never install a standing keyboard listener.
        unsubscribeContextInput = ctx.ui.onTerminalInput?.((data) => {
          if (data && !isKeyRelease(data)) cancelPendingContextFocus();
          return undefined;
        });
        if (!unsubscribeContextInput) cancelPendingContextFocus();
        if (ctx.hasUI)
          ctx.ui.notify(
            contextSummary(
              contextSnapshot(),
              "Context is pinned but needs at least 6 free rows. Close another popover or enlarge the terminal; later input cancels delayed keyboard focus.",
            ),
            "info",
          );
      }
    }
  };
  const inspect = (focus: boolean) => {
    if (tui.mode === "fullscreen") showContext(focus);
    else if (ctx.hasUI) {
      ctx.ui.notify(
        contextSummary(contextSnapshot(), "The pinned context panel requires fullscreen Pi."),
        "info",
      );
    }
  };
  const pauseContext = () => {
    cancelPendingContextFocus();
    if (contextRestore) clearTimeout(contextRestore);
    contextRestore = undefined;
    if (!contextPanel) return;
    contextPanel.view.resetPointer();
    contextPanel.handle?.hide();
    contextPanel.handle = undefined;
    contextPanel.member.measure(0);
  };
  const stepContextAside = () => {
    if (!contextPanel?.handle) return;
    pauseContext();
    if (!panelsHeld())
      contextRestore = setTimeout(() => {
        contextRestore = undefined;
        mountContext();
      }, 0);
  };
  const resumePinned = () => {
    if (!currentFooter() || panelsHeld()) return;
    if (member && !overlay && tui.mode === "fullscreen") mountBreakdown(member);
    mountContext(); // Always passive; old keyboard intent was retired on yield.
  };
  const unsubscribePinnedYield = pi.events.on(PINNED_POPOVER_YIELD_EVENT, (value) => {
    if (!currentFooter()) return;
    const data =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const token = data?.token;
    if (!token || typeof token !== "object" || typeof data?.active !== "boolean") return;
    if (data.active) {
      if (pinnedHolds.has(token)) return;
      pinnedHolds.add(token);
      pauseBreakdown();
      pauseContext();
    } else if (pinnedHolds.delete(token)) resumePinned();
  });
  const unsubscribePromptStart = pi.on("ui_prompt_start", () => {
    if (!currentFooter()) return;
    promptDepth++;
    pauseBreakdown();
    pauseContext();
  });
  const unsubscribePromptEnd = pi.on("ui_prompt_end", () => {
    if (!currentFooter()) return;
    promptDepth = Math.max(0, promptDepth - 1);
    resumePinned();
  });
  const unsubscribeTransientOverlayHide = pi.events.on(HIDE_TRANSIENT_OVERLAYS_EVENT, () => {
    stepAside();
    stepContextAside();
  });

  return {
    inspectContext: inspect,
    hideContext,
    hasContext: () => contextPanel !== undefined,
    toggleContext() {
      if (contextPanel) hideContext();
      else showContext(false);
    },
    toggleBreakdown() {
      if (member) hideBreakdown();
      else showBreakdown();
    },
    dispose(retireContext: () => void) {
      hideContext();
      unsubscribePromptStart?.();
      unsubscribePromptEnd?.();
      unsubscribePinnedYield();
      pinnedHolds.clear();
      // Preserve host callback/timer retirement before unmounting usage chrome.
      retireContext();
      hideBreakdown();
      unwatchBorderLabels();
      unsubscribeTransientOverlayHide();
    },
  };
}
