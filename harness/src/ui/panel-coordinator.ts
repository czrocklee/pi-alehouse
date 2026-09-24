import { buildContextEntries, sessionEntryToContextMessages, getMarkdownTheme, type EventBus, type ExtensionAPI, type ExtensionContext,
  type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR, type FooterIndicatorClick }
  from "../../../lib/overlay-protocol.mjs";
import { focusOrigin, focusRevealed, joinPopoverStack, stackedOverlayOptions, type StackMember } from "../../../lib/popover-stack.mjs";
import type { EffortOverrides, PresetCandidate, PresetRouter, PresetSnapshot, Strength } from "../routing.js";
import { DetailPane, type DetailInput } from "./agent-detail.js";
import { HarnessWidget, type AgentDetail } from "./agent-widget.js";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "./overlay-request.js";
import { ApprovalWatch, mountable, PaneRequest, PaneYield, paneYieldHandlers } from "./permission-dialog-yield.js";
import { PRESET_PICKER_MIN_ROWS, PresetPicker, PresetPickerRequest, type EffortCapabilities, type PresetChoice } from "./preset-picker.js";
import { TranscriptContent } from "./transcript.js";

export interface PanelCoordinatorOptions {
  pi: ExtensionAPI;
  widget: HarnessWidget;
  ready(): boolean;
  router(): PresetRouter;
  publish(candidate: PresetCandidate, name: string, ctx: Pick<ExtensionContext, "ui">, overrides?: EffortOverrides): void;
  showError(error: unknown, ctx: Pick<ExtensionContext, "ui">): void;
  efforts?: (preset: PresetSnapshot, slot: Strength) => EffortCapabilities;
}

/** Owns only parent UI mounting, selection and approval-yield state. */
export class PanelCoordinator {
  private paneOpen = false;
  private pickerOpen = false;
  private closePane: (() => void) | undefined;
  private detailPane: DetailPane | undefined;
  private closePreset: (() => void) | undefined;
  private paneOverlay: OverlayHandle | undefined;
  private readonly yielding = new PaneYield();
  private host: Pick<ExtensionContext, "ui" | "mode"> | undefined;
  private hostAttached = false;
  private tui: Pick<TUI, "mode"> | undefined;
  private clearHostWidget: (() => void) | undefined;
  private paneAgent: string | undefined;
  private unwatchApprovals: (() => void) | undefined;
  private unwatchIndicator: (() => void) | undefined;
  private yieldTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly approvals: ApprovalWatch;
  private readonly yieldHandlers;

  constructor(private readonly options: PanelCoordinatorOptions) {
    this.yieldHandlers = paneYieldHandlers(this.yielding, {
      open: () => this.paneOpen,
      overlay: () => this.paneOverlay,
      close: () => this.closePane,
      pending: () => this.approvals.pending,
      reopen: () => { this.mount(this.paneAgent).catch((error: unknown) => this.observeDetailError(error)); },
      // One pending pane-reopen intent, not a general deferred-task queue.
      // Repeated idle notifications coalesce; disposal cancels the last intent.
      defer: (task) => {
        if (this.yieldTimer) clearTimeout(this.yieldTimer);
        this.yieldTimer = setTimeout(() => {
          this.yieldTimer = undefined;
          try { task(); } catch (error) { this.observeDetailError(error); }
        }, 0);
      },
    });
    this.approvals = new ApprovalWatch({
      onPrompt: (pending) => { this.closePreset?.(); this.yieldHandlers.onPrompt(pending); },
      onIdle: () => this.yieldHandlers.onIdle(),
    });
    options.pi.registerShortcut("alt+a", {
      description: "Open the harness agent detail pane",
      handler: () => this.mount(),
    });
    options.pi.registerShortcut("alt+s", {
      description: "Toggle the harness worker preset picker",
      // The SDK observes returned shortcut promises without blocking input,
      // including failures of our error-notification UI itself.
      handler: () => this.togglePreset(),
    });
  }

  /** Alt+S and the footer's worker indicator are the same toggle. */
  private togglePreset(): Promise<void> | undefined {
    if (this.pickerOpen) { this.closePreset?.(); return; }
    if (this.host && this.options.ready()) return this.selectPreset("", this.host);
  }

  attachHost(ctx: Pick<ExtensionContext, "ui" | "mode">, bus: EventBus): void {
    // One coordinator belongs to one host lifetime, even after disposal. Reject
    // before changing widget callbacks or orphaning the previous subscriptions.
    if (this.hostAttached) throw new Error("PANEL_HOST_ALREADY_ATTACHED");
    this.hostAttached = true;
    this.host = ctx;
    this.options.widget.onOpen((agent_id) => {
      this.activateFromWidget(agent_id).catch((error: unknown) => this.observeDetailError(error));
    });
    // The footer paints our status; a click on it is ours to answer, and
    // claiming it synchronously keeps the footer from opening its own panel.
    this.unwatchIndicator = bus.on(FOOTER_INDICATOR_CLICK_EVENT, (data) => {
      const click = data as FooterIndicatorClick | undefined;
      if (click?.key !== WORKER_PRESET_INDICATOR) return;
      click.handled = true;
      this.togglePreset()?.catch((error: unknown) => this.observeDetailError(error, ctx));
    });
    this.unwatchApprovals = this.approvals.bind({
      emit: (channel, data) => bus.emit(channel, data),
      on: (channel, handler) => {
        const unsubscribe = bus.on(channel, handler);
        // The watch must reach every unsubscriber and clear its pending asks,
        // even when a host callback fails partway through unbinding.
        return () => { try { unsubscribe(); } catch (error) { this.observeDetailError(error, ctx); } };
      },
    });
    // The Agent roster mounts only when there is activity. It cannot tell us
    // which renderer a fresh/Off session uses before its first Agent exists.
    // Capture the host independently, without a visible row, timer or roster.
    if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
      // Own cleanup before invoking a setter that could partially apply.
      this.clearHostWidget = () => ctx.ui.setWidget("harness-panel-host", undefined);
      ctx.ui.setWidget("harness-panel-host", (tui) => {
        if (this.host === ctx) this.tui = tui;
        return { render: () => [], invalidate() {} };
      });
    }
  }

  private floating(): boolean {
    // Hosts without a widget API retain the old conservative fallback. If the
    // captured renderer itself has no mode, do not assume fullscreen.
    return (this.tui ? this.tui.mode : this.options.widget.tuiMode()) === "fullscreen";
  }

  dispose(): void {
    const ctx = this.host;
    const cleanups = [this.unwatchIndicator, this.unwatchApprovals, this.closePreset, this.closePane,
      () => this.options.widget.onOpen(undefined), this.clearHostWidget];
    // Detach first: failed host cleanup and already-queued callbacks cannot
    // reopen a panel or keep the old UI binding alive through this coordinator.
    this.host = undefined;
    this.tui = undefined;
    this.clearHostWidget = undefined;
    this.unwatchApprovals = undefined;
    this.unwatchIndicator = undefined;
    this.closePreset = undefined;
    this.closePane = undefined;
    this.detailPane = undefined;
    this.paneOverlay = undefined;
    this.paneAgent = undefined;
    this.paneOpen = false;
    this.pickerOpen = false;
    this.yielding.end();
    if (this.yieldTimer) { clearTimeout(this.yieldTimer); this.yieldTimer = undefined; }
    for (const cleanup of cleanups) {
      try { cleanup?.(); } catch (error) { this.observeDetailError(error, ctx); }
    }
  }

  async selectPreset(requested: string, ctx: Pick<ExtensionContext, "ui" | "mode">): Promise<void> {
    try {
      const candidate = this.options.router().prepare();
      let name = requested === "reload" ? candidate.activeName : requested;
      let overrides: EffortOverrides | undefined;
      if (!requested) {
        const selected = await this.choosePreset(candidate, ctx);
        if (!selected) return;
        if (typeof selected === "string") name = selected;
        else { name = selected.name; overrides = selected.effort_overrides; }
      }
      this.options.publish(candidate, name, ctx, overrides);
    } catch (error) { this.options.showError(error, ctx); }
  }

  private messagesOf(agent: AgentDetail): readonly unknown[] {
    const entries = agent.entries();
    if (!entries) return [];
    // Display raw attempts within the compaction-aware branch, not the edited
    // model projection: a retry omission must not erase diagnostic transcript.
    try { return buildContextEntries(entries as SessionEntry[]).flatMap(sessionEntryToContextMessages); } catch { return []; }
  }

  private async openDetail(agent_id?: string): Promise<void> {
    if (this.paneOpen || this.pickerOpen || !this.options.ready() || !this.host) return;
    const ctx = this.host;
    if (!mountable(this.yielding, this.approvals.pending)) return;
    const agents = this.options.widget.agents();
    if (!agents.length) { ctx.ui.notify("No agents are available to inspect.", "info"); return; }
    if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
      ctx.ui.notify("The agent detail pane needs the interactive TUI.", "warning");
      return;
    }
    this.paneOpen = true;
    const request = new PaneRequest(() => this.options.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}));
    this.closePane = request.close;
    const mounted = new Map<string, TranscriptContent>();
    try {
      const floating = this.floating();
      const markdownTheme = getMarkdownTheme();
      this.paneAgent = agent_id ?? agents[0]!.agent_id;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        if (!request.mount(() => done(undefined), this.yielding, this.approvals.pending)) {
          return { render: () => [], invalidate() {} };
        }
        const pane = new DetailPane({
          tui, theme, done: request.close,
          initial: this.paneAgent!,
          snapshot: () => {
            const agents = this.options.widget.agents();
            const visible = new Set(agents.map((agent) => agent.agent_id));
            for (const [id, content] of mounted) if (!visible.has(id)) { content.dispose(); mounted.delete(id); }
            return agents.map((agent) => ({ agent_id: agent.agent_id,
              input: { view: agent.view, live: agent.live } satisfies DetailInput }));
          },
          transcript: (id) => {
            const agent = this.options.widget.agents().find((candidate) => candidate.agent_id === id);
            if (!agent) return undefined;
            let content = mounted.get(id);
            if (!content) {
              content = new TranscriptContent({ tui, cwd: agent.cwd, markdownTheme, source: {
                messages: () => this.messagesOf(agent),
                inFlight: () => agent.inFlight(),
                toolDefinition: () => undefined,
              } });
              mounted.set(id, content);
            }
            return content;
          },
          onSelect: (id) => { this.paneAgent = id; },
          frame: floating,
        });
        this.detailPane = pane;
        return request.own(pane);
      }, floating
        ? { overlay: true,
            overlayOptions: () => ({ anchor: "center", width: "80%", maxHeight: "70%", minWidth: 40 }),
            onHandle: (handle) => { this.paneOverlay = handle; } }
        : { overlay: false });
    } finally {
      for (const cleanup of [() => request.dispose(), ...[...mounted.values()].map((content) => () => content.dispose())]) {
        try { cleanup(); } catch (error) { this.observeDetailError(error, ctx); }
      }
      mounted.clear();
      this.paneOpen = false;
      this.closePane = undefined;
      this.detailPane = undefined;
      this.paneOverlay = undefined;
      this.yielding.unmounted();
      if (this.host && this.options.ready() && !this.approvals.pending) this.yieldHandlers.onIdle();
    }
  }

  private mount(agent_id?: string): Promise<void> {
    // Shortcut callers return this to Pi, including notification failures.
    return this.openDetail(agent_id).catch((error: unknown) => {
      this.host?.ui.notify(`The agent detail pane could not open: ${String(error)}`, "error");
    });
  }

  /** Last observer at mouse/timer boundaries, which have no Promise consumer.
   * Formatting and notification are both fallible; nothing may escape here. */
  private observeDetailError(error: unknown, ctx = this.host): void {
    try { ctx?.ui.notify(`Harness panel UI failed: ${String(error)}`, "error"); }
    catch { /* even error reporting is best-effort at a void host boundary */ }
  }

  private async activateFromWidget(agent_id: string): Promise<void> {
    if (this.paneOpen && agent_id) {
      if (this.detailPane) this.detailPane.activate(agent_id);
      else if (agent_id === this.paneAgent) this.closePane?.();
      else this.paneAgent = agent_id;
      return;
    }
    await this.mount(agent_id);
  }

  private async choosePreset(candidate: PresetCandidate,
    ctx: Pick<ExtensionContext, "ui" | "mode">): Promise<PresetChoice | null> {
    const live = this.options.router();
    if (this.pickerOpen) {
      ctx.ui.notify("A worker preset picker is already open.", "warning");
      return null;
    }
    if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
      this.pickerOpen = true;
      try {
        const selected = await ctx.ui.select("Worker preset (off disables new work)", candidate.names.map((item) =>
          item === candidate.activeName ? `${item} (active)` : item));
        return selected?.replace(/ \(active\)$/, "") ?? null;
      } finally { this.pickerOpen = false; }
    }
    if (!this.host || !this.options.ready() || this.paneOpen || !mountable(this.yielding, this.approvals.pending)) {
      ctx.ui.notify("Worker preset picker is unavailable while another harness panel or approval is active.", "warning");
      return null;
    }
    const presets = live.inspect(candidate);
    this.pickerOpen = true;
    const request = new PresetPickerRequest(() => this.options.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}));
    this.closePreset = request.close;
    // Floating, the picker joins the bottom-right popover column above the
    // footer indicator that opens it, beside whatever is already pinned there.
    let place: StackMember | undefined;
    let handle: OverlayHandle | undefined;
    let reveal: (() => void) | undefined;
    try {
      const floating = this.floating();
      return await this.host.ui.custom<PresetChoice | null>((tui, theme, keybindings, done) => {
        if (!request.mount(done, this.paneOpen || !this.options.ready() || !mountable(this.yielding, this.approvals.pending)))
          return { render: () => [], invalidate() {} };
        const stacked = floating ? (place = joinPopoverStack(tui)) : undefined;
        // Opened behind taller popovers, it waits off screen; when room
        // appears it takes the keyboard it would have had, unless a dialog
        // has taken it since.
        const openedFrom = focusOrigin(tui);
        reveal = () => { if (handle) focusRevealed(tui, handle, openedFrom); };
        return request.own(new PresetPicker({ tui, theme, keybindings, presets,
          activeName: candidate.activeName, done: request.choose, pointer: floating, efforts: this.options.efforts,
          ...(stacked ? { rows: () => stacked.available(), onRender: (height: number) => stacked.measure(height) } : {}) }));
      }, floating
        ? { overlay: true, onHandle: (mounted) => { handle = mounted; }, overlayOptions: () => place
          ? stackedOverlayOptions(place, { width: 76, minWidth: 34, minRows: PRESET_PICKER_MIN_ROWS,
            onReveal: () => reveal?.() })
          : { anchor: "center", width: 76, minWidth: 34, maxHeight: "80%", margin: 1 } }
        : { overlay: false });
    } finally {
      try { request.dispose(); }
      finally { reveal = undefined; place?.leave(); this.closePreset = undefined; this.pickerOpen = false; }
    }
  }
}
