import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, getPackageDir, parseFrontmatter, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OwnerController } from "./core/owner-controller.js";
import { HarnessError } from "./core/ports.js";
import { historicalRunsCommand } from "./history/history-command.js";
import { reportUnreportedUsage } from "./history/usage-audit.js";
import { ApprovalBindings } from "./permissions/approval-provenance.js";
import { isOffPreset, presetLabel, PresetRouter, resolveSlotRoute, strengths, thinkingLevels, validEffortOverrides,
  type EffortOverrides, type PresetCandidate, type PresetSelection, type PresetSnapshot, type Strength } from "./routing.js";
import { ChildActivityRegistry } from "./runtime/activity-observer.js";
import { createChildSessionFactory } from "./runtime/child-factory.js";
import { configureChildRuntime } from "./runtime/execution-policy.js";
import { FileOwnerLease } from "./runtime/owner-lease.js";
import { ownerSessionReplacementGuard } from "./runtime/owner-lifecycle.js";
import { hostUsage } from "./runtime/tool-usage.js";
import { createOwnerTools } from "./tools/parent-tools.js";
import { agentProfileNames, blockedDelegationToolNames, managementToolNames, workerToolSelection } from "./tools/tool-names.js";
import { HarnessWidget } from "./ui/agent-widget.js";
import { PanelCoordinator } from "./ui/panel-coordinator.js";
import type { EffortCapabilities } from "./ui/preset-picker.js";
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

/** Reconstruct only the active branch's per-preset overrides. Older selection
 * entries have no override field; they retain their original name-only meaning.
 * The caller must pass getBranch(), never the entire session tree. */
export function restorePresetRouter(path: string, selections: readonly unknown[]): PresetRouter {
  const overrides = new Map<string, EffortOverrides>();
  let selected: string | undefined;
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    if (typeof data.name === "string") selected = data.name;
    if (!Object.hasOwn(data, "effort_overrides")) continue;
    if (typeof data.name !== "string" || data.name === "off" || !validEffortOverrides(data.effort_overrides))
      throw new HarnessError("INVALID_SAVED_EFFORT", { resolution: "Repair the saved worker effort selection before restoring this session." });
    overrides.set(data.name, structuredClone(data.effort_overrides));
  }
  const router = new PresetRouter(path, overrides);
  // Fresh sessions use the configured default; a saved name takes precedence.
  // A removed saved preset is still an error, never a default fallback.
  if (selected !== undefined) router.select(selected);
  return router;
}

type EffortModels<M extends { provider: string; id: string }> = {
  models: readonly M[];
  parentThinking: string | undefined;
  supportedThinking: (model: M) => readonly string[];
};
/** Operator feedback must not suggest changing model-facing tool arguments. */
function effortIssue(error: unknown): string {
  if (error instanceof HarnessError) {
    if (error.code === "PARENT_THINKING_UNAVAILABLE") return "Parent thinking is unavailable.";
    if (error.code === "PRESET_MODEL_UNAVAILABLE") return "Worker model is unavailable or ambiguous in Pi's registry.";
    if (error.code === "THINKING_INCOMPATIBLE") return error.details.reason === "fixed_effort_unsupported"
      ? "The worker model does not support this fixed effort."
      : "Current parent thinking has no supported inherited level or compatibility mapping.";
  }
  return "Worker effort could not be checked.";
}

/** UI capability data comes from the host registry, not another model catalogue.
 * Inherited effort is advisory only; admission resolves it at spawn time. */
export function workerEffortCapabilities<M extends { provider: string; id: string }>(
  preset: PresetSnapshot, slot: Strength, input: EffortModels<M>,
): EffortCapabilities {
  const models = input.models.filter((model) => `${model.provider}/${model.id}` === preset.models[slot]);
  if (models.length !== 1) return { levels: [], error: "Worker model is unavailable or ambiguous in Pi's registry." };
  const supported = input.supportedThinking(models[0]!);
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
  const effortInputs = () => {
    if (!ready || !routingContext) throw new HarnessError("HARNESS_NOT_READY");
    return { parentThinking: routingContext.thinkingLevel, models: routingContext.modelRegistry.getAll(),
      supportedThinking: getSupportedThinkingLevels };
  };
  let parentPermission: () => unknown = () => undefined;
  const residentLimit = 8;
  historicalRunsCommand(pi);
  const presetEntry = "harness:preset-selection:v1";
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
    effort_overrides?: EffortOverrides): void => {
    if (!controller || !router) throw new HarnessError("HARNESS_NOT_READY");
    const snapshot = applyAuditedPreset({ controller, router, candidate, name, effort_overrides,
      ...(effort_overrides === undefined ? {} : { validate: (selected: PresetSelection) => validateWorkerEfforts(selected, effortInputs()) }),
      // Full immutable slot selection is user audit metadata, never model context.
      // Success means this synchronous SDK call returned; it is not an fsync or
      // a rollback guarantee if the SDK itself throws after changing state.
      audit: (selected) => pi.appendEntry(presetEntry, { ...selected, selected_at: Date.now() }),
    });
    // Tool exposure is not the execution gate. A stale SDK tool handle still
    // reaches the Controller's current selection/disable-revision checks.
    const issues: string[] = [];
    const failed = (part: string, error: unknown): void => {
      let detail = "unprintable error";
      try { detail = String(error).slice(0, 256); } catch { /* diagnostics cannot undo selection */ }
      issues.push(`${part} could not update: ${detail}`);
    };
    try { syncWorkerTools(); } catch (error) { failed("tool visibility", error); }
    try { ctx.ui.setStatus("harness-preset", `workers: ${presetLabel(snapshot)}`); }
    catch (error) { failed("the footer", error); }
    // Audit and live selection already succeeded. Report either presentation
    // failure without pretending the selection rolled back; preflight retries
    // tool reconciliation, while core admission remains authoritative now.
    try { ctx.ui.notify(issues.length
      ? `Worker preset ${presetLabel(snapshot)} selected; existing agents are unchanged, but ${issues.join("; ")}`
      : snapshot.name === "off"
        ? "Workers off: new, resumed and steered work is disabled; accepted work continues and results remain available."
        : `Worker preset ${presetLabel(snapshot)} selected; existing agents are unchanged.`, issues.length ? "warning" : "info"); }
    catch { /* best-effort UI after a successful selection */ }
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
    efforts: (preset, slot) => {
      try { return workerEffortCapabilities(preset, slot, effortInputs()); }
      catch { return { levels: [], error: "Host model metadata is unavailable; reopen the worker picker." }; }
    } });
  pi.registerCommand("harness-preset", {
    description: "Select a worker preset, 'off' to disable new work, or 'reload' to reread presets",
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
  // never inject orchestration text or an Off message into model context.
  pi.on("before_agent_start", () => { if (ready) syncWorkerTools(); });
  pi.on("session_shutdown", async (_event, ctx) => {
    ready = false; routingContext = undefined;
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
    try {
      const selections = ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom" && entry.customType === presetEntry ? [entry.data] : []);
      router = restorePresetRouter(presetPath, selections);
    } catch (error) {
      showPresetError(new HarnessError(error instanceof HarnessError ? error.code : "PRESET_ERROR", {
        ...(error instanceof HarnessError ? error.details : { error: String(error).slice(0, 512) }),
        config_path: presetPath,
        resolution: "Fix the preset configuration or restore the saved preset, then restart Pi. The harness is not initialized.",
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
    assert(runtime && typeof runtime.getModel === "function" && typeof runtime.streamSimple === "function", "SDK ModelRegistry.runtime is unavailable");
    const profiles = Object.fromEntries(agentProfileNames.map((name) => {
      const definition = readFileSync(join(agentDir, "agents", `${name}.md`), "utf8");
      const parsed = parseFrontmatter<{ tools: string[] }>(definition);
      assert(Array.isArray(parsed.frontmatter.tools), `Invalid tools in ${name}`);
      return [name, { definition, body: parsed.body,
        tools: [...parsed.frontmatter.tools.filter((tool) => localTools.has(tool)), "notify_parent", "ask_parent"] }];
    })) as Record<typeof agentProfileNames[number], { definition: string; body: string; tools: string[] }>;
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
      parentPermission, getPermissionsService: permission.getPermissionsService });
    try {
      controller = await OwnerController.open({ owner, concurrency: 4, resident_limit: residentLimit, grace_turns: 5,
        admission: () => router!.admissionState(),
        onContextChange: approvalBindings.contextChanged,
        createSession });
      ownerSessionReplacementGuard(controller)(pi);
      for (const tool of createOwnerTools({ controller, context: ctx, profiles, getSupportedThinkingLevels,
        getPreset: () => router!.current(),
        // Admission happens before an optional tool-local wait. Paint the new
        // reservation immediately; tool_result remains the sole usage drain.
        // Keep best-effort visibility repair here too: this callback also runs
        // on accepted-request retries while Off, not only new enabled admissions.
        onRunAccepted: () => { syncWorkerTools(); widget.wake(); },
      })) pi.registerTool(tool);
      // Register once, then hide inactive tools before any model request. Later
      // registration of another extension's tools must not reactivate ours.
      syncWorkerTools();
      widget.setUi(ctx.ui);
      // Panels always mount through the session-start context wrapped by the
      // prompt queue, and observe approvals on the parent bus.
      panels.attachHost(ctx, pi.events);
      // Publish the worker selection only after initialization has completed.
      // Agent activity and capacity stay in the widget.
      ctx.ui.setStatus("harness-preset", `workers: ${presetLabel(router.current())}`);
      routingContext = ctx;
      ready = true;
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
