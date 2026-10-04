import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, getPackageDir, parseFrontmatter, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OwnerController } from "./core/owner-controller.js";
import { defaultDelegation, delegationGuideline, delegationLabel, delegationStatus, isDelegationSetting, parseDelegation,
  restoreDelegation, type DelegationSetting } from "./delegation.js";
import { HarnessError } from "./core/ports.js";
import { historicalRunsCommand } from "./history/history-command.js";
import { reportUnreportedUsage } from "./history/usage-audit.js";
import { ApprovalBindings } from "./permissions/approval-provenance.js";
import { isOffPreset, presetLabel, PresetRouter, resolveSlotRoute, selectPhysicalWorkerModel, strengths, thinkingLevels, validEffortOverrides,
  type EffortOverrides, type PresetCandidate, type PresetPublication, type PresetSelection, type PresetSnapshot, type Strength } from "./routing.js";
import { ChildActivityRegistry } from "./runtime/activity-observer.js";
import { createChildSessionFactory } from "./runtime/child-factory.js";
import { ChildWebModules, nativeWebLoader } from "./runtime/child-web.js";
import { configureChildRuntime } from "./runtime/execution-policy.js";
import { createDispatchRuntime } from "./runtime/dispatch-runtime.js";
import { researcherHostModules } from "./runtime/host-modules.js";
import { FileOwnerLease } from "./runtime/owner-lease.js";
import { ownerSessionReplacementGuard } from "./runtime/owner-lifecycle.js";
import { registerOrderFreeToolSchemas } from "./runtime/provider-schema.js";
import { createPresetModelSelector } from "./runtime/preset-model-selector.js";
import { hostUsage } from "./runtime/tool-usage.js";
import { createOwnerTools } from "./tools/parent-tools.js";
import { agentProfileNames, blockedDelegationToolNames, managementToolNames, webProfileNames, webToolNames,
  workerToolSelection } from "./tools/tool-names.js";
import { HarnessWidget } from "./ui/agent-widget.js";
import { PanelCoordinator } from "./ui/panel-coordinator.js";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "./ui/overlay-request.js";
import type { EffortCapabilities } from "./ui/preset-picker.js";
import { PreferencesControls, stageWorkerSelection } from "./ui/preferences-controls.js";
import { SettingsStore, registerSettingsStore, validateSettings, type PresetDefinition, type SettingsDocument } from "../../lib/settings-store.mjs";
const localTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export function applyAuditedPreset(input: {
  controller: OwnerController;
  router: PresetRouter;
  candidate: PresetCandidate;
  name: string;
  audit: (snapshot: PresetSelection) => void;
  effort_overrides?: EffortOverrides;
  validate?: (snapshot: PresetSelection) => void;
}): PresetSelection {
  input.controller.assertOwnerAvailable();
  let auditAttempted = false;
  try {
    return input.router.apply(input.candidate, input.name, (snapshot) => {
      // Validation can fail after the picker opened, before any audit IO. It is
      // not an ambiguous parent-history failure and must not poison the Owner.
      input.validate?.(snapshot);
      auditAttempted = true;
      input.audit(snapshot);
    }, input.effort_overrides);
  } catch (error) {
    // Candidate/name/staleness failures happen before the callback and are not
    // parent-history failures. Once append was called, however, the SDK may
    // have changed memory or disk before throwing; latch rather than guessing.
    if (!auditAttempted) throw error;
    input.controller.latchParentHistoryFailure(error);
    throw new HarnessError("PRESET_AUDIT_FAILED", {
      error: String(error).slice(0, 512),
      resolution: "The synchronous parent-session audit call failed or had an ambiguous outcome. The live worker preset was not published. Inspect the parent session and restart Pi before more delegation or preset changes.",
    });
  }
}

const savedPresetResolution = "The saved harness:preset-selection:v1 branch record failed worker configuration validation. Effort overrides require a named non-Off preset and valid policies; custom definitions require valid preset versions and all five nested slots d1, d2, d3, d4, d5 with model and optional effort under version-2 settings rules; any per-slot thinking field is unsupported, including editor-generated empty thinking: {}. Correct configuration files explicitly, then start a fresh session or fork from before the invalid harness:preset-selection:v1 record and restart Pi. Do not rewrite historical journal records.";

/** Reconstruct only the active branch's per-preset overrides. Older selection
 * entries have no override field; they retain their original name-only meaning.
 * The caller must pass getBranch(), never the entire session tree. */
export function restorePresetDefinitions(selections: readonly unknown[]): Record<string, PresetDefinition> {
  let definitions: Record<string, PresetDefinition> = {};
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || !("custom_presets" in entry) || !Object.hasOwn(entry, "custom_presets")) continue;
    try { definitions = validateSettings({ version: 2, presets: entry.custom_presets }).presets ?? {}; }
    catch { throw new HarnessError("INVALID_SAVED_PRESETS", { record: "harness:preset-selection:v1", resolution: savedPresetResolution }); }
  }
  return definitions;
}

export function restorePresetRouter(path: string, selections: readonly unknown[], preferences?: SettingsDocument): PresetRouter {
  const overrides = new Map<string, EffortOverrides>();
  for (const [name, slots] of Object.entries(preferences?.effort ?? {})) {
    overrides.set(name, Object.fromEntries(Object.entries(slots).filter(([, value]) => value !== null)));
  }
  const historical = new Set<string>();
  let selected: string | undefined;
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    if (typeof data.name === "string") {
      selected = data.name;
      // Preferences seed fresh choices only. A historical name-only record
      // keeps its original catalogue-default meaning, not today's global pins.
      if (!historical.has(data.name)) { overrides.delete(data.name); historical.add(data.name); }
    }
    if (!Object.hasOwn(data, "effort_overrides")) continue;
    if (typeof data.name !== "string" || data.name === "off" || !validEffortOverrides(data.effort_overrides))
      throw new HarnessError("INVALID_SAVED_EFFORT", { record: "harness:preset-selection:v1", resolution: savedPresetResolution });
    overrides.set(data.name, structuredClone(data.effort_overrides));
  }
  const router = new PresetRouter(path, overrides, { ...preferences?.presets, ...restorePresetDefinitions(selections) });
  // Fresh sessions use explicitly saved preferences, then catalogue defaults.
  // A removed saved preset is still an error, never a default fallback.
  const name = selected ?? preferences?.preset;
  if (name !== undefined) router.select(name);
  return router;
}

type EffortModels<M extends { provider: string; id: string; api?: string }> = {
  models: readonly M[];
  parentThinking: string | undefined;
  supportedThinking: (model: M) => readonly string[];
};
/** Operator feedback must not suggest changing model-facing tool arguments. */
function effortIssue(error: unknown): string {
  if (error instanceof HarnessError) {
    if (error.code === "PARENT_THINKING_UNAVAILABLE") return "Parent thinking is unavailable.";
    if (error.code === "PRESET_MODEL_UNAVAILABLE") return error.details.reason === "virtual_model"
      ? "Choose a physical worker model; virtual models route each request."
      : "Worker model is unavailable or ambiguous in Pi's registry.";
    if (error.code === "THINKING_INCOMPATIBLE") return error.details.reason === "fixed_effort_unsupported"
      ? "The worker model does not support this fixed effort."
      : "Current parent thinking has no supported inherited level under the automatic rule.";
  }
  return "Worker effort could not be checked.";
}

/** UI capability data comes from the host registry, not another model catalogue.
 * Inherited effort is advisory only; admission resolves it at spawn time. */
export function workerEffortCapabilities<M extends { provider: string; id: string; api?: string }>(
  preset: PresetSnapshot, slot: Strength, input: EffortModels<M>,
): EffortCapabilities {
  let model: M;
  try { model = selectPhysicalWorkerModel(input.models, preset.models[slot], preset); }
  catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    return { levels: [], error: effortIssue(error) };
  }
  const supported = input.supportedThinking(model);
  const levels = thinkingLevels.filter((level) => supported.includes(level));
  try {
    const inherited = resolveSlotRoute({ ...input, strength: slot,
      preset: { ...preset, effort: { ...preset.effort, [slot]: "inherit" } } }).thinking;
    return { levels, inherited };
  } catch (error) {
    return { levels, inheritError: effortIssue(error) };
  }
}

/** Validate saved fixed policies, not transient parent thinking. Inherit is
 * checked only when admitting an Agent, even if its model is missing now. */
export function validateWorkerEfforts<M extends { provider: string; id: string }>(
  preset: PresetSelection, input: EffortModels<M>,
): void {
  if (isOffPreset(preset)) throw new HarnessError("WORKERS_DISABLED");
  for (const strength of strengths) {
    if (preset.effort[strength] === "inherit") continue;
    try { resolveSlotRoute({ ...input, preset, strength }); }
    catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      throw new HarnessError(error.code, { preset: preset.name, slot: strength,
        error: effortIssue(error),
        resolution: "Choose a supported fixed level or inherit, or update the worker model configuration." });
    }
  }
}

/** Explicit launcher only: no global discovery, settings migration or old-backend fallback. */
export default function harnessExtension(pi: ExtensionAPI) {
  let controller: OwnerController | undefined, ready = false;
  let router: PresetRouter | undefined;
  let routingContext: ExtensionContext | undefined;
  let settingsStore: SettingsStore | undefined, settingsUi: PreferencesControls | undefined;
  let unregisterSettings: (() => void) | undefined;
  let sessionDefinitions: Record<string, PresetDefinition> = {};
  const stageSettings = (action: () => void, ctx: Pick<ExtensionContext, "ui">): void => {
    try { action(); }
    catch (error) {
      try { ctx.ui.notify(`The session change is live, but defaults were not queued: ${String(error).slice(0, 512)}`, "warning"); }
      catch { /* persistence feedback cannot undo a live audited choice */ }
    }
  };
  const effortInputs = () => {
    if (!ready || !routingContext) throw new HarnessError("HARNESS_NOT_READY");
    return { parentThinking: routingContext.thinkingLevel, models: routingContext.modelRegistry.getAll(),
      supportedThinking: getSupportedThinkingLevels };
  };
  let parentPermission: () => unknown = () => undefined;
  const residentLimit = 8;
  registerOrderFreeToolSchemas(pi);
  historicalRunsCommand(pi);
  const presetEntry = "harness:preset-selection:v1";
  const delegationEntry = "harness:delegation-mode:v1";
  let delegation: DelegationSetting = { ...defaultDelegation };
  /** The registered agent_spawn; re-registered to carry a new guideline. */
  let spawnTool: ToolDefinition | undefined;
  /** The guideline agent_spawn actually carries, so a failed re-registration
   * is retried rather than hidden behind an unchanged setting. */
  let publishedGuideline: string | undefined;
  /** The active tools from before a re-registration, kept until they are
   * restored: with a tool allowlist (--tools), Pi's registry refresh
   * re-activates every allowed tool, and a failed restore must be retried. */
  let pendingActive: string[] | undefined;
  const sameTools = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((name, index) => name === b[index]);
  const syncGuideline = (): void => {
    const wanted = delegationGuideline(delegation);
    if (!spawnTool || (publishedGuideline === wanted && !pendingActive)) return;
    const active = pendingActive ??= pi.getActiveTools();
    if (publishedGuideline !== wanted) {
      pi.registerTool({ ...spawnTool, promptGuidelines: [wanted] });
      publishedGuideline = wanted;
    }
    if (!sameTools(pi.getActiveTools(), active)) pi.setActiveTools(active);
    pendingActive = undefined;
    // A snapshot kept across a failure may predate an admission change;
    // harness tools follow the current admission, not the snapshot.
    syncWorkerTools();
  };
  const syncWorkerTools = (): void => {
    if (!controller || !router) return;
    const current = pi.getActiveTools();
    const selected = workerToolSelection(current, router.admissionState().enabled, controller.hasAcceptedRuns);
    if (current.length !== selected.length || current.some((name, index) => name !== selected[index])) pi.setActiveTools(selected);
  };
  const showPresetError = (error: unknown, ctx: Pick<ExtensionContext, "ui">): void => {
    const body = error instanceof HarnessError ? { code: error.code, ...error.details } : { code: "PRESET_ERROR", message: String(error).slice(0, 512) };
    ctx.ui.notify(JSON.stringify(body), "error");
  };
  const publishPreset = (candidate: PresetCandidate, name: string, ctx: Pick<ExtensionContext, "ui">,
    effort_overrides?: EffortOverrides, definition?: PresetDefinition): PresetPublication => {
    if (!ready || !controller || !router) throw new HarnessError("HARNESS_NOT_READY");
    const previous = router.current();
    const targetBefore = router.inspect(candidate).find((preset) => preset.name === name);
    const nextDefinitions = definition
      ? validateSettings({ version: 2, presets: { ...sessionDefinitions, [name]: definition } }).presets ?? {}
      : sessionDefinitions;
    const snapshot = applyAuditedPreset({ controller, router, candidate, name, effort_overrides,
      ...(effort_overrides === undefined && !definition ? {} : { validate: (selected: PresetSelection) => {
        if (definition && !isOffPreset(selected)) for (const slot of strengths) {
          selectPhysicalWorkerModel(effortInputs().models, selected.models[slot], selected);
        }
        validateWorkerEfforts(selected, effortInputs());
      } }),
      // Full immutable slot selection is user audit metadata, never model context.
      // Success means this synchronous SDK call returned; it is not an fsync or
      // a rollback guarantee if the SDK itself throws after changing state.
      audit: (selected) => pi.appendEntry(presetEntry, { ...selected, selected_at: Date.now(),
        ...(Object.keys(nextDefinitions).length ? { custom_presets: structuredClone(nextDefinitions) } : {}) }),
    });
    const publication = { selection: snapshot, candidate: router.rebase(candidate) };
    sessionDefinitions = nextDefinitions;
    if (settingsStore) stageSettings(() => {
      const store = settingsStore!;
      // A remembered name must not depend on a session-only or workspace-only
      // definition absent from its target scope on the next fresh startup.
      const definitions = router!.customPresets();
      const rememberedDefinition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
      if (rememberedDefinition && store.scope !== "session") store.stage(store.scope, ["presets", name], rememberedDefinition);
      stageWorkerSelection(store, snapshot, previous, effort_overrides !== undefined,
        targetBefore && !isOffPreset(targetBefore) ? targetBefore.effort_overrides : {});
    }, ctx);
    // Tool exposure is not the execution gate. A stale SDK tool handle still
    // reaches the Controller's current selection/disable-revision checks.
    const issues: string[] = [];
    const failed = (part: string, error: unknown): void => {
      let detail = "unprintable error";
      try { detail = String(error).slice(0, 256); } catch { /* diagnostics cannot undo selection */ }
      issues.push(`${part} could not update: ${detail}`);
    };
    try { syncWorkerTools(); } catch (error) { failed("tool visibility", error); }
    try { ctx.ui.setStatus("harness-preset", delegationStatus(snapshot, delegation)); }
    catch (error) { failed("the footer", error); }
    // Audit and live selection already succeeded. Report either presentation
    // failure without pretending the selection rolled back; preflight retries
    // tool reconciliation, while core admission remains authoritative now.
    try { ctx.ui.notify(issues.length
      ? `Model preset ${presetLabel(snapshot)} selected; existing agents are unchanged, but ${issues.join("; ")}`
      : snapshot.name === "off"
        ? "Delegation off: new tasks, answers and steering are disabled; accepted work continues and results remain available."
        : `Model preset ${presetLabel(snapshot)} selected; existing agents are unchanged.`, issues.length ? "warning" : "info"); }
    catch { /* best-effort UI after a successful selection */ }
    return publication;
  };
  /** Audit, then re-register agent_spawn with the new guideline (one
   * prompt-cache miss). Pi applies it from the next run; a run already in
   * progress keeps its prompt. Running Agents are unchanged. Returns whether
   * the setting changed. */
  const publishDelegation = (next: DelegationSetting, ctx: Pick<ExtensionContext, "ui">): boolean => {
    if (!ready || !controller || !router || !spawnTool) throw new HarnessError("HARNESS_NOT_READY", {
      resolution: "Fix the reported startup error and restart Pi before changing the delegation mode.",
    });
    if (!isDelegationSetting(next)) throw new HarnessError("INVALID_DELEGATION");
    const setting: DelegationSetting = { mode: next.mode, eagerness: next.eagerness };
    if (setting.mode === delegation.mode && setting.eagerness === delegation.eagerness) {
      // Unchanged, but repair an earlier failed re-registration.
      try { syncGuideline(); } catch (error) {
        try { ctx.ui.notify(`The model-facing guideline could not update: ${String(error).slice(0, 256)}`, "warning"); }
        catch { /* best-effort UI */ }
      }
      return false;
    }
    controller.assertOwnerAvailable();
    try { pi.appendEntry(delegationEntry, { ...setting, selected_at: Date.now() }); }
    catch (error) {
      // As with presets: the SDK may have changed memory or disk before throwing.
      controller.latchParentHistoryFailure(error);
      throw new HarnessError("DELEGATION_AUDIT_FAILED", { error: String(error).slice(0, 512),
        resolution: "The parent-session audit call failed or had an ambiguous outcome. The delegation mode was not changed. Inspect the parent session and restart Pi before more delegation or mode changes." });
    }
    const previous = delegation;
    delegation = setting;
    if (settingsStore && settingsStore.scope !== "session") stageSettings(() => {
      const store = settingsStore!;
      if (store.scope === "session") return;
      if (previous.mode !== setting.mode) store.stage(store.scope, ["delegation", "mode"], setting.mode);
      if (previous.eagerness !== setting.eagerness) store.stage(store.scope, ["delegation", "eagerness"], setting.eagerness);
    }, ctx);
    const issues: string[] = [];
    // A failure here is retried on the next reselect and before each run.
    try { syncGuideline(); }
    catch (error) { issues.push(`the model-facing guideline could not update: ${String(error).slice(0, 256)}`); }
    try { ctx.ui.setStatus("harness-preset", delegationStatus(router.current(), setting)); }
    catch (error) { issues.push(`the footer could not update: ${String(error).slice(0, 256)}`); }
    if (issues.length) {
      try { ctx.ui.notify(`Delegation ${delegationLabel(setting)} selected, but ${issues.join("; ")}`, "warning"); }
      catch { /* best-effort UI after a successful selection */ }
    }
    return true;
  };
  /** The only readiness gate preset work has: the catalogue is meaningless
   * until session_start resolved the saved selection against disk. */
  const requireRouter = (): PresetRouter => {
    if (!ready || !router) throw new HarnessError("HARNESS_NOT_READY", {
      resolution: "Fix the reported startup error and restart Pi before selecting a worker preset.",
    });
    return router;
  };
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget({ list: (options) => controller?.list(options) ?? [],
    stats: () => controller?.stats() ?? { resident: 0, cleanup_uncertain: false } }, residentLimit,
    activities.observations, (ids) => activities.retain(ids));
  const panels = new PanelCoordinator({ pi, widget, ready: () => ready, router: requireRouter,
    publish: publishPreset, showError: showPresetError,
    delegation: { current: () => ({ ...delegation }), set: publishDelegation, guideline: delegationGuideline },
    management: { summary: () => settingsUi?.summary() ?? "Save: session",
      settings: async () => { await settingsUi?.open(); },
      saveDefault: async (scope) => { await settingsUi?.saveDefault(scope); },
      canSaveWorkspace: () => settingsStore?.canWriteWorkspace() === true,
      editPreset: async (name?: string) => { await settingsUi?.editPreset(name); },
      editModel: async (name, slot, position) => { await settingsUi?.editModel(name, slot, position); },
      cancelModelSelection: () => { settingsUi?.cancelModelSelection(); } },
    efforts: (preset, slot) => {
      try { return workerEffortCapabilities(preset, slot, effortInputs()); }
      catch { return { levels: [], error: "Host model metadata is unavailable; reopen the delegation panel." }; }
    } });
  pi.registerCommand("harness-preset", {
    description: "Select a model preset, 'off' to disable new work, or 'reload' to reread presets",
    handler: async (args, ctx) => {
      const requested = args.trim();
      // A host with no UI cannot show a picker, so the bare command reports the
      // catalogue instead of silently doing nothing.
      if (!requested && !ctx.hasUI) {
        try {
          const live = requireRouter();
          ctx.ui.notify(JSON.stringify({ active: live.activePresetName(), presets: live.names() }), "info");
        } catch (error) { showPresetError(error, ctx); }
        return;
      }
      await panels.selectPreset(requested, ctx);
    },
  });
  pi.registerCommand("harness-mode", {
    description: "Set the delegation mode (manual, co-worker, lead, supervisor) and/or eagerness (reserved, balanced, eager)",
    handler: async (args, ctx) => {
      let notice: string;
      try {
        requireRouter();
        if (!args.trim()) notice = JSON.stringify({ ...delegation, guideline: delegationGuideline(delegation) });
        else {
          const changed = publishDelegation(parseDelegation(args, delegation), ctx);
          notice = `Delegation: ${delegationLabel(delegation)}${changed ? "" : " (unchanged)"}`;
        }
      } catch (error) { showPresetError(error, ctx); return; }
      // The change already took effect; its notice is best-effort.
      try { ctx.ui.notify(notice, "info"); } catch { /* best-effort UI */ }
    },
  });
  pi.registerCommand("harness-settings", {
    description: "Choose Session/Global/Workspace save scope, remember settings, save now or discard pending writes",
    handler: async (_args, ctx) => {
      try { requireRouter(); await panels.withManagement(async () => { await settingsUi?.open(); }); }
      catch (error) { showPresetError(error, ctx); }
    },
  });
  pi.registerCommand("harness-preset-edit", {
    description: "Create a model preset (no args) or edit a named preset; permission profiles stay fixed",
    handler: async (args, ctx) => {
      try { requireRouter(); await panels.withManagement(async () => { await settingsUi?.editPreset(args.trim() || undefined); }); }
      catch (error) { showPresetError(error, ctx); }
    },
  });
  // Reads the controller every frame instead of holding a second copy of Run state.
  pi.on("tool_call", (event) => {
    if (!ready || !parentPermission()) return { block: true, reason: "Harness or parent permissions are not ready; inspect the startup error." };
    // Delegation may have changed the picture; the widget's loop stops itself when idle.
    if (managementToolNames.includes(event.toolName)) widget.wake();
  });
  pi.on("turn_start", () => {
    if (ready) syncWorkerTools();
    widget.onTurnStart();
  });
  // A tool result's `usage` is Pi's only seam for spend from a session it cannot
  // see, so the ledger rides out on the next tool result of ANY kind rather than
  // waiting for a delegation one. Returning `usage` alone is safe: the runner
  // merges into a copy of the event, so content, details and isError survive.
  // Communication publication already committed before this hook; usage is
  // separate accounting, never a body rewrite or a message acknowledgement.
  // See docs/architecture.md, "Accounting".
  pi.on("tool_result", (event) => {
    // Admission wakes the widget before any tool-local wait. Wake again for
    // other management changes (cancel/release) and the wait's final snapshot.
    if (managementToolNames.includes(event.toolName)) widget.wake();
    const child = controller?.drainUsage();
    if (!child) return undefined;
    // The runner swallows a throw from here, so an unprojectable `event.usage`
    // -- a partial one left by an earlier handler, say -- would burn the drain
    // silently. Commit only what was actually built.
    try { return { usage: hostUsage(child, event.usage) }; }
    catch { controller?.returnUsage(child); return undefined; }
  });

  // Reconcile after startup/SDK restoration and before the first request, but
  // never inject orchestration text or an Off message into model context: the
  // delegation guideline belongs to agent_spawn and follows its visibility.
  pi.on("before_agent_start", (event) => {
    if (!ready) return;
    try { syncGuideline(); } catch { /* reported when it first failed; retried next run */ }
    syncWorkerTools();
    // Pi snapshots the run's prompt options before this event: a re-registration
    // recovered here reaches the registry, not this run's rules, so update them.
    if (spawnTool && publishedGuideline !== undefined) {
      event.systemPromptOptions.toolGuidelines[spawnTool.name] = [publishedGuideline];
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ready = false; routingContext = undefined;
    settingsUi?.dispose();
    settingsStore?.seal();
    // Save preferences independently of child drain, which may never confirm
    // closure. No process-exit hook, background write or timeout-as-cancellation.
    try {
      for (const result of settingsStore?.flush() ?? []) if (result.error) {
        const message = `Settings not saved: ${result.path}: ${result.error}`;
        try { if (ctx.hasUI) ctx.ui.notify(message, "error"); else console.error(message); }
        catch { console.error(message); }
      }
    } catch (error) { console.error(`Settings flush failed: ${String(error).slice(0, 512)}`); }
    finally { unregisterSettings?.(); unregisterSettings = undefined; }
    // Presentation failures cannot replace Owner drain. Attempt every cleanup
    // independently before awaiting shutdown, while parent authority still exists.
    for (const cleanup of [() => ctx.ui.setStatus("harness-preset", undefined),
      () => panels.dispose(), () => widget.dispose(), () => activities.clear()]) {
      try { cleanup(); } catch { /* best-effort presentation teardown */ }
    }
    if (controller && !(await controller.shutdown(5000)).closed) {
      ctx.ui.notify("Harness cleanup is incomplete. Do not reuse this parent; inspect outstanding work before restarting Pi.", "error");
    }
    if (controller) reportUnreportedUsage(pi, ctx, controller);
  });
  pi.registerCommand("harness-status", {
    description: "Show this parent's harness capacity and shutdown state",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(controller?.stats() ?? { ready: false }), "info"),
  });
  pi.on("session_start", async (_event, ctx) => {
    assert(!controller, "A harness owner cannot be rebound to another parent");
    assert(!pi.getAllTools().some((tool) => blockedDelegationToolNames.includes(tool.name)), "Old and new delegation backends must not be co-loaded");
    const agentDir = getAgentDir(), parentId = ctx.sessionManager.getSessionId();
    const presetPath = join(agentDir, "harness-presets.json");
    let preferences: SettingsDocument;
    try {
      settingsStore = new SettingsStore({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
      preferences = settingsStore.effective();
    } catch (error) {
      showPresetError(new HarnessError("SETTINGS_LOAD_FAILED", {
        error: String(error).slice(0, 1024),
        config_paths: [join(agentDir, "extensions/pi-alehouse/config.json"), join(ctx.cwd, ".pi/extensions/pi-alehouse/config.json")],
        resolution: "Repair the named preferences file; no existing configuration was overwritten. Restart Pi afterward.",
      }), ctx);
      return;
    }
    try {
      const selections = ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom" && entry.customType === presetEntry ? [entry.data] : []);
      sessionDefinitions = restorePresetDefinitions(selections);
      router = restorePresetRouter(presetPath, selections, preferences);
    } catch (error) {
      // A bad branch record is not a defect in the base catalogue. Attaching
      // that file's path sends the operator to the wrong place to repair it.
      const savedRecord = error instanceof HarnessError &&
        (error.code === "INVALID_SAVED_PRESETS" || error.code === "INVALID_SAVED_EFFORT");
      showPresetError(new HarnessError(error instanceof HarnessError ? error.code : "PRESET_ERROR", {
        ...(error instanceof HarnessError ? error.details : { error: String(error).slice(0, 512) }),
        ...(savedRecord ? {} : { config_path: presetPath }),
        resolution: error instanceof HarnessError && typeof error.details.resolution === "string" ? error.details.resolution
          : "Fix the preset configuration or restore the saved preset, then restart Pi. The harness is not initialized.",
      }), ctx);
      return;
    }
    try {
      delegation = restoreDelegation(ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom" && entry.customType === delegationEntry ? [entry.data] : []),
        { ...router.defaultDelegation, ...preferences.delegation });
    } catch (error) {
      // A session record, not the preset file: say which.
      router = undefined;
      showPresetError(new HarnessError(error instanceof HarnessError ? error.code : "INVALID_SAVED_DELEGATION", {
        record: delegationEntry,
        resolution: `A saved ${delegationEntry} entry on this branch is invalid. Restore or fork the session from before it, then restart Pi. The harness is not initialized.`,
      }), ctx);
      return;
    }
    const permissionRoot = process.env.PI_HARNESS_PERMISSION_ROOT, policyRoot = process.env.PI_HARNESS_POLICY_ROOT;
    const flock = process.env.PI_HARNESS_FLOCK;
    assert(permissionRoot && isAbsolute(permissionRoot) && policyRoot && isAbsolute(policyRoot) && flock && isAbsolute(flock), "Use the pi-alehouse launcher");
    const hostRoot = getPackageDir(), hostRequire = createRequire(join(hostRoot, "package.json"));
    const { createJiti } = hostRequire("jiti") as typeof import("jiti");
    // Pi peers expose import-only exports and may be hoisted by npm. Resolve
    // ESM conditions from the actual host, not require() or a nested layout.
    const hostResolver = createJiti(join(hostRoot, "package.json"));
    const jiti = createJiti(import.meta.url, { alias: {
      "@earendil-works/pi-coding-agent": join(hostRoot, "dist/index.js"),
      "@earendil-works/pi-ai": fileURLToPath(hostResolver.esmResolve("@earendil-works/pi-ai")),
      "@earendil-works/pi-tui": fileURLToPath(hostResolver.esmResolve("@earendil-works/pi-tui")),
    } });
    const permission = await jiti.import<{
      getPermissionsService: (id: string) => unknown;
    }>(join(permissionRoot, "index.ts"));
    // The launcher loads us first so shutdown drains children BEFORE tearing
    // down the parent authority. Permission session_start runs after ours;
    // tool admission and child creation check its readiness, not this hook.
    parentPermission = () => permission.getPermissionsService(parentId);
    // No public canonical-runtime getter: reuse the parent's runtime, not copied auth.
    const runtime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
    assert(runtime && typeof runtime.getModel === "function" && typeof runtime.getPhysicalModel === "function" &&
      typeof runtime.streamSimple === "function", "SDK ModelRegistry.runtime physical-model capabilities are unavailable");
    const profiles = Object.fromEntries(agentProfileNames.map((name) => {
      const definition = readFileSync(join(agentDir, "agents", `${name}.md`), "utf8");
      const parsed = parseFrontmatter<{ tools: string[] }>(definition);
      assert(Array.isArray(parsed.frontmatter.tools), `Invalid tools in ${name}`);
      // Declared definitions may list web tools; only web profiles receive
      // them, and those must have every web tool and no Bash or direct edits.
      const web = webProfileNames.includes(name);
      const tools = parsed.frontmatter.tools.filter((tool) => localTools.has(tool) || (web && webToolNames.includes(tool)));
      if (web) {
        assert(webToolNames.every((tool) => tools.includes(tool)) && !["bash", "edit", "write"].some((tool) => tools.includes(tool)),
          `Invalid tools in ${name}`);
      }
      return [name, { definition, body: parsed.body, tools: [...tools, "alert_parent", "ask_parent"] }];
    })) as Record<typeof agentProfileNames[number], { definition: string; body: string; tools: string[] }>;
    // The launcher's verified pi-web-access entry; a researcher spawn fails
    // closed without it. Each researcher session loads its own instance, which
    // imports the Pi SDK modules this extension received from the host.
    const webEntry = process.env.PI_HARNESS_WEB_ENTRY;
    const web = webEntry && isAbsolute(webEntry) ? new ChildWebModules(webEntry, nativeWebLoader(researcherHostModules)) : undefined;
    const settings = () => {
      const manager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
      // Native recovery remains inside the same Run and its accounting/drain.
      configureChildRuntime(manager);
      return manager;
    };
    const parentHistory = { getSessionId: () => parentId, isPersisted: () => !!ctx.sessionManager.getSessionFile(),
      appendCustomEntry: (type: string, data: unknown) => pi.appendEntry(type, data) };
    const owner = await FileOwnerLease.open({ directory: join(agentDir, "harness-owners"), owner_id: parentId, flock });
    const approvalBindings = new ApprovalBindings(pi.events, owner);
    const createSession = createChildSessionFactory({ ctx, parentBus: pi.events, agentDir, permissionRoot, policyRoot,
      parentId, runtime, profiles, settings, parentHistory, approvalBindings, activities,
      parentPermission, getPermissionsService: permission.getPermissionsService, web });
    try {
      controller = await OwnerController.open({ owner, concurrency: 4, resident_limit: residentLimit, grace_turns: 5,
        admission: () => router!.admissionState(),
        onContextChange: approvalBindings.contextChanged,
        dispatch: createDispatchRuntime({ agentDir, flock, git: process.env.PI_HARNESS_GIT, getPermissionsService: parentPermission }),
        createSession });
      ownerSessionReplacementGuard(controller)(pi);
      for (const tool of createOwnerTools({ controller, context: ctx, profiles, getSupportedThinkingLevels,
        getPreset: () => router!.current(),
        // Admission happens before an optional tool-local wait. Paint the new
        // reservation immediately; tool_result remains the sole usage drain.
        // Keep best-effort visibility repair here too: this callback also runs
        // on accepted-request retries while Off, not only new enabled admissions.
        onRunAccepted: () => { syncWorkerTools(); widget.wake(); },
        guideline: delegationGuideline(delegation),
      })) {
        if (tool.name === "agent_spawn") { spawnTool = tool as ToolDefinition; publishedGuideline = delegationGuideline(delegation); }
        pi.registerTool(tool);
      }
      // Register once, then hide inactive tools before any model request. Later
      // registration of another extension's tools must not reactivate ours.
      syncWorkerTools();
      widget.setUi(ctx.ui);
      // Panels always mount through the session-start context wrapped by the
      // prompt queue, and observe approvals on the parent bus.
      panels.attachHost(ctx, pi.events);
      // Publish the worker selection only after initialization has completed.
      // Agent activity and capacity stay in the widget.
      ctx.ui.setStatus("harness-preset", delegationStatus(router.current(), delegation));
      routingContext = ctx;
      ready = true;
      unregisterSettings = registerSettingsStore(parentId, settingsStore);
      settingsUi = new PreferencesControls({ ctx, store: settingsStore, ready: () => ready && routingContext === ctx,
        createModelSelector: (options) => createPresetModelSelector({ ...options, runtime }),
        modelPopover: () => panels.isFullscreen(),
        modelSelectionAllowed: () => panels.modelSelectionAllowed(),
        beforeModelClose: () => pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}),
        router: requireRouter, delegation: () => ({ ...delegation }),
        publishDefinition: (candidate, name, definition) => {
          const selected = requireRouter().inspect(candidate).find((preset) => preset.name === name);
          publishPreset(candidate, name, ctx, selected && !isOffPreset(selected) ? selected.effort_overrides : {}, definition);
        } });
      if (!ctx.isProjectTrusted()) ctx.ui.notify("Workspace preferences are not loaded or writable until this project is trusted.", "info");
      const current = router.current();
      if (!isOffPreset(current) && Object.keys(current.effort_overrides).length) {
        // Fixed-policy model support may have changed since saving. Inherit
        // remains spawn-time only, not a startup warning about parent thinking.
        // Keep the explicit policy visible/editable; never clamp or erase it.
        try { validateWorkerEfforts(current, effortInputs()); }
        catch (error) {
          try { ctx.ui.notify(`Saved worker effort needs attention: ${String(error)}. Open Alt+S to edit it; existing settings were not changed.`, "warning"); }
          catch { /* a warning cannot undo successful initialization */ }
        }
      }
    } catch (error) {
      ready = false; router = undefined; routingContext = undefined;
      settingsUi?.dispose(); settingsStore?.seal(); unregisterSettings?.(); unregisterSettings = undefined;
      // Startup can fail after UI binding too; presentation must not skip drain.
      for (const cleanup of [() => panels.dispose(), () => widget.dispose(), () => activities.clear()]) {
        try { cleanup(); } catch { /* continue Owner teardown */ }
      }
      if (controller) await controller.shutdown(5000);
      else owner.close();
      throw error;
    }
  });
}
