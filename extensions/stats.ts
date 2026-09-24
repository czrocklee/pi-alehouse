/** Main/managed-worker performance observations. Presentation only: never a health
 * probe, permission decision, lifecycle authority or provider request of its own. */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { FOOTER_INDICATOR_CLICK_EVENT, HEALTH_INDICATOR, HIDE_TRANSIENT_OVERLAYS_EVENT,
  type FooterIndicatorClick } from "../lib/overlay-protocol.mjs";
import { bindStatsEvents, SessionStats, type SessionHealth } from "./lib/session-stats.ts";
import { WorkerStats } from "./lib/worker-stats.ts";
import { STATS_WORKER_ATTACH, type WorkerStatsAttachment } from "../lib/stats-protocol.mjs";
import { StatsView, type StatsDashboardSnapshot } from "./lib/stats-view.ts";

const WIDGET_KEY = "stats-host";

/** Activity/attention, not an invented green health score or latency threshold. */
export function healthStatus(theme: Pick<Theme, "fg">, health: SessionHealth): string {
  switch (health) {
    case "busy": return theme.fg("accent", "● busy");
    case "waiting": return theme.fg("warning", "? wait");
    case "error": return theme.fg("error", "! error");
    case "idle": return theme.fg("dim", "○ idle");
    default: return theme.fg("dim", "○ —");
  }
}

function combinedHealth(main: SessionHealth, workers?: SessionHealth): SessionHealth {
  // Only the parent observes permission dialogs, including forwarded child asks.
  if (main === "waiting") return "waiting";
  if (main === "error" || workers === "error") return "error";
  if (main === "busy" || workers === "busy") return "busy";
  return main === "idle" || workers === "idle" ? "idle" : "unknown";
}

export default function statsExtension(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let stats: SessionStats | undefined;
  let workers: WorkerStats | undefined;
  let tui: TUI | undefined;
  let open: { view: StatsView; handle: OverlayHandle } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unbind: (() => void) | undefined;
  let off: (() => void)[] = [];
  let prompts = 0;
  let lastStatus: string | undefined;

  const close = (): void => {
    const previous = open;
    open = undefined;
    if (!previous) return;
    try { previous.handle.hide(); } finally { previous.view.dispose(); }
  };
  const snapshot = (main: SessionStats, group: WorkerStats | undefined): StatsDashboardSnapshot => {
    const s = main.snapshot();
    const w = group?.snapshot();
    // Parent permission dialogs already include forwarded child asks. Do not
    // count those waits again in each worker, or mistake sums for wall time.
    const health = combinedHealth(s.health, w?.health);
    return { ...s, health, partial: s.partial || w?.partial === true, ...(w ? { workers: w } : {}) };
  };
  const paint = (): void => {
    if (!ctx?.hasUI || !stats) return;
    try {
      // Footer paints never materialize the details tables, even on refresh or
      // theme invalidation. Only the separate view/summary needs full snapshots.
      const status = healthStatus(ctx.ui.theme, combinedHealth(stats.health, workers?.health));
      if (status !== lastStatus) {
        ctx.ui.setStatus(HEALTH_INDICATOR, status);
        lastStatus = status;
      }
    } catch { /* Observations must not affect the work they describe. */ }
  };
  const cleanup = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    const context = ctx;
    const retiredWorkers = workers;
    workers = undefined;
    ctx = undefined;
    stats = undefined;
    tui = undefined;
    prompts = 0;
    lastStatus = undefined;
    const cleanups = [close, unbind, ...off, () => retiredWorkers?.dispose(),
      () => context?.ui.setStatus(HEALTH_INDICATOR, undefined),
      () => { if (context?.mode === "tui") context.ui.setWidget(WIDGET_KEY, undefined); }];
    unbind = undefined;
    off = [];
    for (const cleanup of cleanups) {
      try { cleanup?.(); } catch { /* Reach every cleanup even if the UI is gone. */ }
    }
  };
  const toggle = (): void => {
    if (open) return close();
    if (!ctx || !stats || !ctx.hasUI) return;
    if (prompts || stats.health === "waiting") return;
    if (ctx.mode !== "tui" || !tui || tui.mode !== "fullscreen") {
      // Regular-mode overlays get baked into terminal scrollback. A non-modal
      // summary is safer than occupying the shared approval prompt queue.
      const s = snapshot(stats, workers);
      const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
      ctx.ui.notify(`Stats · main session and workers since opening\n` +
        `Open ${seconds(s.elapsedMs)} · active ${seconds(s.busyMs)} · idle ${seconds(s.idleMs)}\n` +
        `LLM Σ ${seconds(s.llmMs)} · tools Σ ${seconds(s.toolMs)} (overlap) · approval ${seconds(s.approvalMs)}\n` +
        `Workers: ${s.workers?.running ?? 0} running · LLM Σ ${seconds(s.workers?.llmMs ?? 0)} · tools Σ ${seconds(s.workers?.toolMs ?? 0)}\n` +
        "The interactive Stats view needs fullscreen TUI. Compaction, cache warming and historical timing are not observed.", "info");
      return;
    }
    const context = ctx;
    const observed = stats;
    const group = workers;
    const host = tui;
    const view = new StatsView({ tui: host, get theme() { return context.ui.theme; },
      snapshot: () => snapshot(observed, group), close });
    try {
      // A separate, readable details surface. It is deliberately NOT another
      // member of the small bottom-right popover column.
      const handle = host.showOverlay(view, { anchor: "center", width: "85%", maxHeight: "75%", minWidth: 40 });
      open = { view, handle };
      host.requestRender();
    } catch (error) { view.dispose(); throw error; }
  };
  const toggleSafely = (): void => {
    try { toggle(); }
    catch (error) {
      try { ctx?.ui.notify(`Stats view could not open: ${String(error)}`, "error"); } catch { /* best effort */ }
    }
  };

  pi.registerCommand("stats", {
    description: "Main and worker performance: elapsed time, request latency, throughput and tools",
    handler: async () => { toggleSafely(); },
  });
  pi.on("session_start", (_event, context) => {
    cleanup();
    ctx = context;
    const observed = new SessionStats();
    stats = observed;
    const group = new WorkerStats(undefined, paint);
    workers = group;
    const parentId = context.sessionManager.getSessionId();
    const current = (): boolean => stats === observed;
    unbind = bindStatsEvents(pi, () => current() ? observed : undefined, paint);
    const closeCurrent = (): void => { if (current()) close(); };
    off = [
      pi.events.on(STATS_WORKER_ATTACH, (raw) => {
        // An old/different owner cannot attach observations to this window.
        // Only small metadata methods cross this optional handshake.
        try {
          const request = raw as WorkerStatsAttachment | undefined;
          if (!current() || !request || request.parentId !== parentId || request.sink !== undefined) return;
          request.sink = group.attach(request.workerId);
          paint();
        } catch { /* A broken telemetry consumer must not prevent child creation. */ }
      }),
      pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (raw) => {
        const click = raw as FooterIndicatorClick | undefined;
        if (!current() || click?.key !== HEALTH_INDICATOR) return;
        click.handled = true;
        toggleSafely();
      }),
      // Raw overlays can remove their exact handle. Step off before a harness
      // ui.custom completion pops the global top; never strand another panel.
      pi.events.on(HIDE_TRANSIENT_OVERLAYS_EVENT, closeCurrent),
      pi.events.on("permissions:ui_prompt", closeCurrent),
      pi.on("ui_prompt_start", () => { if (current()) { prompts++; close(); } }),
      pi.on("ui_prompt_end", () => { if (current()) prompts = Math.max(0, prompts - 1); }),
    ];
    if (context.mode === "tui" && context.hasUI) {
      context.ui.setWidget(WIDGET_KEY, (host) => {
        if (current()) tui = host;
        return { render: () => [], invalidate: () => { if (current()) paint(); } };
      });
      timer = setInterval(() => {
        paint();
        try { if (open) tui?.requestRender(); } catch { /* TUI may be shutting down. */ }
      }, 1000);
      timer.unref?.();
    }
    paint();
  });
  pi.on("session_shutdown", cleanup);
}
