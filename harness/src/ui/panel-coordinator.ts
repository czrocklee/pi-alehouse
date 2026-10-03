import type { PersistentScope } from "../../../lib/settings-store.mjs";
import { buildContextEntries, sessionEntryToContextMessages, getMarkdownTheme, type EventBus, type ExtensionAPI, type ExtensionContext,
  type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR, type FooterIndicatorClick }
  from "../../../lib/overlay-protocol.mjs";
import { focusOrigin, focusRevealed, joinPopoverStack, stackedOverlayOptions, type StackMember } from "../../../lib/popover-stack.mjs";
import type { DelegationSetting } from "../delegation.js";
import { HarnessError } from "../core/ports.js";
import type { EffortOverrides, PresetCandidate, PresetPublication, PresetRouter, PresetSnapshot, Strength } from "../routing.js";
import { DetailPane, type DetailInput } from "./agent-detail.js";
import { HarnessWidget, type AgentDetail } from "./agent-widget.js";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "./overlay-request.js";
import { ApprovalWatch, mountable, PaneRequest, PaneYield, paneYieldHandlers } from "./permission-dialog-yield.js";
import { PRESET_PICKER_MIN_ROWS, PresetPicker, PresetPickerRequest,
  type EffortCapabilities, type ModelPickerPosition, type PresetChoice } from "./preset-picker.js";
import { TranscriptContent } from "./transcript.js";

export interface PanelCoordinatorOptions {
  pi: ExtensionAPI;
  widget: HarnessWidget;
  ready(): boolean;
  router(): PresetRouter;
  publish(candidate: PresetCandidate, name: string, ctx: Pick<ExtensionContext, "ui">, overrides?: EffortOverrides): PresetPublication;
  showError(error: unknown, ctx: Pick<ExtensionContext, "ui">): void;
  efforts?: (preset: PresetSnapshot, slot: Strength) => EffortCapabilities;
  /** Delegation mode: read live, and applied at once by the panel's slider. */
  delegation?: {
    current(): DelegationSetting;
    set(next: DelegationSetting, ctx: Pick<ExtensionContext, "ui">): void;
    guideline(setting: DelegationSetting): string;
  };
  /** Settings/preset management, implemented by the host integration with
   * standard Pi dialogs. The coordinator only routes a picker action to them
   * after the picker has fully settled; it never publishes a candidate for
   * them and never runs two dialog sequences at once. `editModel` receives
   * the slot and, when available, the click's screen position; its presence
   * alone gates the picker's model routes, which is a UI gate, not
   * authorization. The picker is not reopened afterwards. */
  management?: {
    summary(): string;
    settings(): Promise<void>;
    saveDefault?(scope: PersistentScope): Promise<void>;
    canSaveWorkspace?(): boolean;
    editPreset(name?: string): Promise<void>;
    editModel?(name: string, slot: Strength, position?: ModelPickerPosition): Promise<void>;
    /** Release a model selector that holds the custom queue, so a permission
     * dialog can be shown. Best-effort: a failure never blocks the ordinary
     * picker close, the pane yield or later asks. */
    cancelModelSelection?(): void;
  };
}

type PickerState = { router: PresetRouter; candidate: PresetCandidate };

/** Owns only parent UI mounting, selection and approval-yield state. */
export class PanelCoordinator {
  private paneOpen = false;
  private pickerOpen = false;
  /** One management dialog sequence at a time; released when its callback settles. */
  private managementOpen = false;
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
      onPrompt: (pending) => {
        // An ask for permission must reach the human: cancel any open model
        // selection first, but never let that best-effort cleanup block the
        // ordinary close/yield or the ask's own registration.
        try { this.options.management?.cancelModelSelection?.(); }
        catch (error) { this.observeDetailError(error); }
        this.closePreset?.();
        this.yieldHandlers.onPrompt(pending);
      },
      onIdle: () => this.yieldHandlers.onIdle(),
    });
    options.pi.registerShortcut("alt+a", {
      description: "Open the harness agent detail pane",
      handler: () => this.mount(),
    });
    options.pi.registerShortcut("alt+s", {
      description: "Toggle the harness delegation panel (mode and model preset)",
      // The SDK observes returned shortcut promises without blocking input,
      // including failures of our error-notification UI itself.
      handler: () => this.togglePreset(),
    });
  }

  /** Alt+S and the footer's worker indicator are the same toggle. */
  private togglePreset(): Promise<void> | undefined {
    if (this.pickerOpen) { this.closePreset?.(); return; }
    // A management dialog owns the interaction until it settles; the picker
    // must not open over it.
    if (this.managementOpen) return;
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

  /** Readonly renderer projection for other controls (a model popover is
   * fullscreen-only, so regular scrollback is never polluted). */
  isFullscreen(): boolean { return this.floating(); }

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
    this.managementOpen = false;
    this.yielding.end();
    if (this.yieldTimer) { clearTimeout(this.yieldTimer); this.yieldTimer = undefined; }
    for (const cleanup of cleanups) {
      try { cleanup?.(); } catch (error) { this.observeDetailError(error, ctx); }
    }
  }

  async selectPreset(requested: string, ctx: Pick<ExtensionContext, "ui" | "mode">): Promise<void> {
    try {
      const router = this.options.router(), candidate = router.prepare();
      if (requested) this.options.publish(candidate, requested === "reload" ? candidate.activeName : requested, ctx);
      else await this.pickPreset({ router, candidate }, ctx);
    } catch (error) { this.options.showError(error, ctx); }
  }

  private async pickPreset(state: PickerState, ctx: Pick<ExtensionContext, "ui" | "mode">,
    startInEffort = false): Promise<void> {
    const host = this.host;
    const selected = await this.choosePreset(state, ctx, startInEffort);
    if (!selected || this.host !== host || !this.options.ready()) return;
    if (typeof selected === "string") {
      if (!this.modelSelectionAllowed()) return;
      if (this.options.router() !== state.router) throw new HarnessError("STALE_PRESET_SELECTION");
      this.options.publish(state.candidate, selected, ctx);
    } else if (selected.action === "edit-effort") {
      await this.enableEffortEditor(selected.name, state, host, ctx);
    } else {
      // choosePreset's finally has released the custom queue before any dialog.
      await this.runManagement(selected, host);
    }
  }

  private async enableEffortEditor(name: string, state: PickerState,
    host: Pick<ExtensionContext, "ui" | "mode"> | undefined, ctx: Pick<ExtensionContext, "ui" | "mode">): Promise<void> {
    if (!host || this.host !== host || !this.options.ready()) return;
    let enabled = false;
    await this.withManagement(async () => {
      if (this.options.router() !== state.router || !state.router.isCurrent(state.candidate)) throw new HarnessError("STALE_PRESET_SELECTION");
      const accepted = await host.ui.confirm(`Enable ${name} to edit effort?`,
        `This replaces the active preset (${state.candidate.activeName}) and enables new worker work.\n` +
        "Effort changes then apply immediately. Existing Agents and the main model are unchanged.");
      if (accepted !== true || this.host !== host || !this.modelSelectionAllowed()) return;
      if (this.options.router() !== state.router || !state.router.isCurrent(state.candidate)) throw new HarnessError("STALE_PRESET_SELECTION");
      const publication = this.options.publish(state.candidate, name, ctx);
      state.candidate = publication.candidate;
      enabled = true;
    });
    // Release management ownership before re-entering the custom queue. Keep
    // the same audited catalogue; reopening must not reread or adopt new files.
    if (enabled && this.host === host && this.options.router() === state.router && state.router.isCurrent(state.candidate) && this.modelSelectionAllowed())
      await this.pickPreset(state, ctx, true);
  }

  /** One settings/preset management route: dialog sequences never overlap,
   * the latch releases in finally, a disposed or replaced host drops the
   * request, and errors surface through showError rather than a publish. */
  private async runManagement(action: Exclude<Extract<PresetChoice, { action: string }>, { action: "edit-effort" }>,
    host: Pick<ExtensionContext, "ui" | "mode"> | undefined): Promise<void> {
    const management = this.options.management;
    if (!management || this.host !== host || !this.options.ready()) return;
    await this.withManagement(async () => {
      if (action.action === "settings") {
        if (typeof management.settings === "function") await management.settings();
      } else if (action.action === "save-default") {
        if (action.scope === "workspace" && management.canSaveWorkspace?.() !== true) return;
        if (typeof management.saveDefault === "function") await management.saveDefault(action.scope);
      } else if (action.action === "edit-model") {
        if (typeof management.editModel === "function") await management.editModel(action.name, action.slot, action.position);
      } else if (typeof management.editPreset === "function") {
        await management.editPreset(action.action === "edit-preset" ? action.name : undefined);
      }
    });
  }

  /** One UI owner for both slash commands and picker routes. Acquire before
   * any await so footer/widget clicks cannot stack another harness custom UI. */
  async withManagement(action: () => Promise<void>): Promise<void> {
    const host = this.host;
    if (!host || !this.options.ready() || this.managementOpen || this.pickerOpen || this.paneOpen ||
        !this.modelSelectionAllowed()) return;
    this.managementOpen = true;
    try { await action(); }
    catch (error) {
      if (this.host !== host) return; // No callbacks through a retired host.
      throw error;
    } finally { this.managementOpen = false; }
  }

  /** A management sequence may span several dialogs. Recheck the permission
   * yield before every model factory, not just when that sequence starts. */
  modelSelectionAllowed(): boolean {
    return !!this.host && this.options.ready() && mountable(this.yielding, this.approvals.pending);
  }

  private messagesOf(agent: AgentDetail): readonly unknown[] {
    const entries = agent.entries();
    if (!entries) return [];
    // Display raw attempts within the compaction-aware branch, not the edited
    // model projection: a retry omission must not erase diagnostic transcript.
    try { return buildContextEntries(entries as SessionEntry[]).flatMap(sessionEntryToContextMessages); } catch { return []; }
  }

  private async openDetail(agent_id?: string): Promise<void> {
    if (this.paneOpen || this.pickerOpen || this.managementOpen || !this.options.ready() || !this.host) return;
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

  private async choosePreset(state: PickerState,
    ctx: Pick<ExtensionContext, "ui" | "mode">, startInEffort: boolean): Promise<PresetChoice | null> {
    const live = state.router, candidate = state.candidate;
    if (this.pickerOpen) {
      ctx.ui.notify("The delegation panel is already open.", "warning");
      return null;
    }
    if (this.managementOpen) {
      ctx.ui.notify("The delegation panel is unavailable while a settings or preset dialog is open.", "warning");
      return null;
    }
    if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
      this.pickerOpen = true;
      try {
        const selected = await ctx.ui.select("Model preset (off disables new work)", candidate.names.map((item) =>
          item === candidate.activeName ? `${item} (active)` : item));
        return selected?.replace(/ \(active\)$/, "") ?? null;
      } finally { this.pickerOpen = false; }
    }
    if (!this.host || !this.options.ready() || this.paneOpen || !mountable(this.yielding, this.approvals.pending)) {
      ctx.ui.notify("The delegation panel is unavailable while another harness panel or approval is active.", "warning");
      return null;
    }
    const presets = live.inspect(candidate);
    this.pickerOpen = true;
    const request = new PresetPickerRequest(() => this.options.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}));
    this.closePreset = request.close;
    // Floating, the picker joins the bottom-right popover column above the
    // footer indicator that opens it, beside whatever is already pinned there.
    const host = this.host;
    let picker: PresetPicker | undefined;
    let place: StackMember | undefined;
    let handle: OverlayHandle | undefined;
    let reveal: (() => void) | undefined;
    try {
      const floating = this.floating();
      return await this.host.ui.custom<PresetChoice | null>((tui, theme, keybindings, done) => {
        if (!request.mount(done, this.host !== host || this.options.router() !== live || !live.isCurrent(state.candidate) ||
            this.paneOpen || !this.options.ready() || !mountable(this.yielding, this.approvals.pending)))
          return { render: () => [], invalidate() {} };
        const stacked = floating ? (place = joinPopoverStack(tui)) : undefined;
        // Opened behind taller popovers, it waits off screen; when room
        // appears it takes the keyboard it would have had, unless a dialog
        // has taken it since.
        const openedFrom = focusOrigin(tui);
        reveal = () => { if (handle) focusRevealed(tui, handle, openedFrom); };
        const delegation = this.options.delegation;
        const management = this.options.management;
        return request.own(picker = new PresetPicker({ tui, theme, keybindings, presets,
          activeName: candidate.activeName, done: request.choose, pointer: floating, efforts: this.options.efforts, startInEffort,
          ...(this.options.efforts ? { setEffort: (name: string, overrides: EffortOverrides) => {
            if (!picker?.isOpen() || this.host !== host || this.closePreset !== request.close || !this.modelSelectionAllowed()) return undefined;
            try {
              if (this.options.router() !== live || !live.isCurrent(state.candidate) || name !== state.candidate.activeName) throw new HarnessError("STALE_PRESET_SELECTION");
              const publication = this.options.publish(state.candidate, name, ctx, overrides);
              state.candidate = publication.candidate;
              return publication.selection;
            } catch (error) {
              try { this.options.showError(error, ctx); } catch { /* notification cannot escape a pointer/key callback */ }
              return undefined;
            }
          } } : {}),
          ...(management ? { management: {
            summary: () => management.summary(),
            settings: typeof management.settings === "function",
            presets: typeof management.editPreset === "function",
            models: typeof management.editModel === "function",
            saveDefaults: typeof management.saveDefault === "function",
            canSaveWorkspace: () => management.canSaveWorkspace?.() === true,
          } } : {}),
          ...(delegation ? { delegation: { current: () => delegation.current(), guideline: (setting: DelegationSetting) => delegation.guideline(setting),
            set: (next: DelegationSetting) => {
              // A pointer or key handler: nothing may escape into pi-tui's dispatch.
              try { delegation.set(next, ctx); }
              catch (error) { try { this.options.showError(error, ctx); } catch { /* notification is fallible too */ } }
            } } } : {}),
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
