import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_OWNER_LIMITS, OwnerController } from "./core/owner-controller.ts";
import {
  defaultDelegation,
  delegationGuideline,
  delegationLabel,
  delegationStatus,
  isDelegationSetting,
  parseDelegation,
  restoreDelegation,
  type DelegationSetting,
} from "./delegation.ts";
import { OrchestrationError } from "./core/ports.ts";
import { historicalRunsCommand } from "./history/history-command.ts";
import { reportUnreportedUsage } from "./history/usage-audit.ts";
import { ApprovalBindings } from "./permissions/approval-provenance.ts";
import {
  isOffPreset,
  presetLabel,
  PresetRouter,
  type EffortOverrides,
  type PresetCandidate,
  type PresetPublication,
  type PresetSelection,
} from "./routing.ts";
import { ChildActivityRegistry } from "./runtime/activity-observer.ts";
import { createChildSessionFactory } from "./runtime/child-factory.ts";
import { ChildWebModules, nativeWebLoader } from "./runtime/child-web.ts";
import { configureChildRuntime } from "./runtime/execution-policy.ts";
import type { ManagedBlockSubscription } from "./runtime/permission-blocks.ts";
import { createDispatchRuntime } from "./runtime/dispatch-runtime.ts";
import { researcherHostModules } from "./runtime/host-modules.ts";
import { requestHumanStop } from "./runtime/human-stop.ts";
import { FileOwnerLease } from "./runtime/owner-lease.ts";
import { ownerSessionReplacementGuard } from "./runtime/owner-lifecycle.ts";
import {
  auditDelegationSelection,
  commitPresetSelection,
  validateWorkerEfforts,
  workerEffortCapabilities,
} from "./runtime/preset-publication.ts";
import { restorePresetDefinitions, restorePresetRouter } from "./runtime/preset-restoration.ts";
import { registerOrderFreeToolSchemas } from "./runtime/provider-schema.ts";
import { createPresetModelSelector } from "./runtime/preset-model-selector.ts";
import { hostUsage } from "./runtime/tool-usage.ts";
import { createOwnerTools } from "./tools/parent-tools.ts";
import {
  agentProfileNames,
  blockedDelegationToolNames,
  managementToolNames,
  webProfileNames,
  webToolNames,
  workerToolSelection,
} from "./tools/tool-names.ts";
import { AgentWidget } from "./ui/agent-widget.ts";
import { PanelCoordinator } from "./ui/panel-coordinator.ts";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "./ui/overlay-request.ts";
import { PreferencesControls, stageWorkerSelection } from "./ui/preferences-controls.ts";
import {
  SettingsStore,
  registerSettingsStore,
  type PresetDefinition,
  type SettingsDocument,
} from "../shared/settings-store.mjs";
import { managedBlockToolNames } from "../shared/managed-block-tools.mjs";

export {
  applyAuditedPreset,
  validateWorkerEfforts,
  workerEffortCapabilities,
} from "./runtime/preset-publication.ts";
export { restorePresetDefinitions, restorePresetRouter } from "./runtime/preset-restoration.ts";

const localTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const presetEntry = "alehouse:preset-selection:v1";
const delegationEntry = "alehouse:delegation-mode:v1";

/** The already-loaded matched authority, supplied by the guarded composition.
 * Resolve session services per use; never cache an authority service here. */
export interface OrchestrationStartup {
  permission: {
    getPermissionsService: (id: string) => unknown;
    subscribeManagedBlocks: ManagedBlockSubscription;
  };
  /** Tools the parent's own pi-web-access registered, under its configured
   * names, as composition observed them. Read per use: it registers later. */
  parentWebTools: () => readonly string[];
}

/** Model-facing refusal for a parent web call while scouts own web research. */
export const PARENT_WEB_OFF_REASON =
  "Direct web tools are unavailable in this delegation mode. Use a scout for external research.";

/** Request-only projection over every tool delta, including a resumed or
 * compacted head. Keep the canonical transcript and active selection intact:
 * Manual and Off must recover pi-web-access's own selection, not a recorded
 * removal. Only declarations are filtered; historical calls/results stay. */
export function hideParentWebDeclarations(
  messages: readonly ContextWithSystemEvent["messages"][number][],
  webTools: readonly string[],
): ContextWithSystemEvent["messages"] {
  const hidden = new Set(webTools);
  return messages.map((message) => {
    if (message.role !== "system") return message;
    return {
      ...message,
      ...(message.toolsAdded
        ? { toolsAdded: message.toolsAdded.filter((tool) => !hidden.has(tool.name)) }
        : {}),
      ...(message.toolsRemoved
        ? { toolsRemoved: message.toolsRemoved.filter((tool) => !hidden.has(tool.name)) }
        : {}),
    };
  });
}

function branchCustom(ctx: ExtensionContext, customType: string): unknown[] {
  return ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === customType ? [entry.data] : [],
    );
}

function settingsLoadFailure(error: unknown, agentDir: string, cwd: string): OrchestrationError {
  return new OrchestrationError("SETTINGS_LOAD_FAILED", {
    error: String(error).slice(0, 1024),
    config_paths: [
      join(agentDir, "extensions/pi-alehouse/config.json"),
      join(cwd, ".pi/extensions/pi-alehouse/config.json"),
    ],
    resolution:
      "Repair the named preferences file; no existing configuration was overwritten. Restart Pi afterward.",
  });
}

function presetRestoreFailure(error: unknown, presetPath: string): OrchestrationError {
  const savedRecord =
    error instanceof OrchestrationError &&
    (error.code === "INVALID_SAVED_PRESETS" || error.code === "INVALID_SAVED_EFFORT");
  return new OrchestrationError(error instanceof OrchestrationError ? error.code : "PRESET_ERROR", {
    ...(error instanceof OrchestrationError
      ? error.details
      : { error: String(error).slice(0, 512) }),
    ...(savedRecord ? {} : { config_path: presetPath }),
    resolution:
      error instanceof OrchestrationError && typeof error.details.resolution === "string"
        ? error.details.resolution
        : "Fix the preset configuration or restore the saved preset, then restart Pi. Alehouse is not initialized.",
  });
}

function delegationRestoreFailure(error: unknown): OrchestrationError {
  return new OrchestrationError(
    error instanceof OrchestrationError ? error.code : "INVALID_SAVED_DELEGATION",
    {
      record: delegationEntry,
      resolution: `A saved ${delegationEntry} entry on this branch is invalid. Restore or fork the session from before it, then restart Pi. Alehouse is not initialized.`,
    },
  );
}

function requireLauncherPaths(): { permissionRoot: string; policyRoot: string; flock: string } {
  const permissionRoot = process.env.PI_ALEHOUSE_PERMISSION_ROOT,
    policyRoot = process.env.PI_ALEHOUSE_POLICY_ROOT;
  const flock = process.env.PI_ALEHOUSE_FLOCK;
  assert(
    permissionRoot &&
      isAbsolute(permissionRoot) &&
      policyRoot &&
      isAbsolute(policyRoot) &&
      flock &&
      isAbsolute(flock),
    "Use the pi-alehouse launcher",
  );
  return { permissionRoot, policyRoot, flock };
}

function requireStartupPermission(
  startup: OrchestrationStartup | undefined,
): OrchestrationStartup["permission"] {
  const permission = startup?.permission;
  assert(
    permission && typeof permission.getPermissionsService === "function",
    "Use the pi-alehouse composition with its matched permission interface; no SDK or authority fallback is supported",
  );
  assert(
    typeof permission.subscribeManagedBlocks === "function",
    "Managed block observations are unavailable; restart with a matched pi-alehouse runtime",
  );
  assert(
    typeof startup?.parentWebTools === "function",
    "Use the pi-alehouse composition: the parent web tool registry is unavailable",
  );
  return permission;
}

function requireHostModelRuntime(ctx: ExtensionContext): ModelRuntime {
  // No public canonical-runtime getter: reuse the parent's runtime, not copied auth.
  const runtime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
  assert(
    runtime &&
      typeof runtime.getModel === "function" &&
      typeof runtime.getPhysicalModel === "function" &&
      typeof runtime.streamSimple === "function",
    "SDK ModelRegistry.runtime physical-model capabilities are unavailable",
  );
  return runtime;
}

function loadAdmittedProfiles(
  agentDir: string,
): Record<
  (typeof agentProfileNames)[number],
  { definition: string; body: string; tools: string[] }
> {
  return Object.fromEntries(
    agentProfileNames.map((name) => {
      const definition = readFileSync(join(agentDir, "agents", `${name}.md`), "utf8");
      const parsed = parseFrontmatter<{ tools: string[] }>(definition);
      assert(Array.isArray(parsed.frontmatter.tools), `Invalid tools in ${name}`);
      // Declared definitions may list web tools; only web profiles receive
      // them, and those must have every web tool and no Bash or direct edits.
      const web = webProfileNames.includes(name);
      const tools = parsed.frontmatter.tools.filter(
        (tool) => localTools.has(tool) || (web && webToolNames.includes(tool)),
      );
      if (web) {
        assert(
          webToolNames.every((tool) => tools.includes(tool)) &&
            !["bash", "edit", "write"].some((tool) => tools.includes(tool)),
          `Invalid tools in ${name}`,
        );
      }
      return [
        name,
        { definition, body: parsed.body, tools: [...tools, "alert_parent", "ask_parent"] },
      ];
    }),
  ) as Record<
    (typeof agentProfileNames)[number],
    { definition: string; body: string; tools: string[] }
  >;
}

function openResearcherWeb(): ChildWebModules | undefined {
  // The launcher's verified pi-web-access entry; a researcher spawn fails
  // closed without it. Each researcher session loads its own instance, which
  // imports the Pi SDK modules this extension received from the host.
  const webEntry = process.env.PI_ALEHOUSE_WEB_ENTRY;
  return webEntry && isAbsolute(webEntry)
    ? new ChildWebModules(webEntry, nativeWebLoader(researcherHostModules))
    : undefined;
}

function stageSettings(action: () => void, ctx: Pick<ExtensionContext, "ui">): void {
  try {
    action();
  } catch (error) {
    try {
      ctx.ui.notify(
        `The session change is live, but defaults were not queued: ${String(error).slice(0, 512)}`,
        "warning",
      );
    } catch {
      /* persistence feedback cannot undo a live audited choice */
    }
  }
}

/** Best-effort paint after a committed preset. Failures do not roll back. */
function presentPresetSelection(input: {
  snapshot: PresetSelection;
  delegation: DelegationSetting;
  syncTools: () => void;
  setStatus: () => void;
  notify: (message: string, level: "info" | "warning") => void;
}): void {
  const issues: string[] = [];
  const failed = (part: string, error: unknown): void => {
    let detail = "unprintable error";
    try {
      detail = String(error).slice(0, 256);
    } catch {
      /* diagnostics cannot undo selection */
    }
    issues.push(`${part} could not update: ${detail}`);
  };
  try {
    input.syncTools();
  } catch (error) {
    failed("tool visibility", error);
  }
  try {
    input.setStatus();
  } catch (error) {
    failed("the footer", error);
  }
  try {
    input.notify(
      issues.length
        ? `Model preset ${presetLabel(input.snapshot)} selected; existing agents are unchanged, but ${issues.join("; ")}`
        : input.snapshot.name === "off"
          ? "Delegation off: new tasks, answers and steering are disabled; accepted work continues and results remain available."
          : `Model preset ${presetLabel(input.snapshot)} selected; existing agents are unchanged.`,
      issues.length ? "warning" : "info",
    );
  } catch {
    /* best-effort UI after a successful selection */
  }
}

function retryPublishedGuideline(input: {
  syncGuideline: () => void;
  notify: (message: string, level: "warning") => void;
}): void {
  try {
    input.syncGuideline();
  } catch (error) {
    try {
      input.notify(
        `The model-facing guideline could not update: ${String(error).slice(0, 256)}`,
        "warning",
      );
    } catch {
      /* best-effort UI */
    }
  }
}

function presentDelegationChange(input: {
  setting: DelegationSetting;
  syncGuideline: () => void;
  setStatus: () => void;
  notify: (message: string, level: "warning") => void;
}): void {
  const issues: string[] = [];
  try {
    input.syncGuideline();
  } catch (error) {
    issues.push(`the model-facing guideline could not update: ${String(error).slice(0, 256)}`);
  }
  try {
    input.setStatus();
  } catch (error) {
    issues.push(`the footer could not update: ${String(error).slice(0, 256)}`);
  }
  if (issues.length) {
    try {
      input.notify(
        `Delegation ${delegationLabel(input.setting)} selected, but ${issues.join("; ")}`,
        "warning",
      );
    } catch {
      /* best-effort UI after a successful selection */
    }
  }
}

/** Explicit launcher only: no global discovery, settings migration or old-backend fallback. */
export default function orchestrationExtension(pi: ExtensionAPI, startup?: OrchestrationStartup) {
  let controller: OwnerController | undefined,
    ready = false;
  let router: PresetRouter | undefined;
  let routingContext: ExtensionContext | undefined;
  let settingsStore: SettingsStore | undefined, settingsUi: PreferencesControls | undefined;
  let unregisterSettings: (() => void) | undefined;
  let sessionDefinitions: Record<string, PresetDefinition> = {};
  const effortInputs = () => {
    if (!ready || !routingContext) throw new OrchestrationError("ORCHESTRATION_NOT_READY");
    return {
      parentThinking: routingContext.thinkingLevel,
      models: routingContext.modelRegistry.getAll(),
      supportedThinking: getSupportedThinkingLevels,
    };
  };
  let parentPermission: () => unknown = () => undefined;
  const residentLimit = DEFAULT_OWNER_LIMITS.resident;
  registerOrderFreeToolSchemas(pi);
  historicalRunsCommand(pi);
  let delegation: DelegationSetting = { ...defaultDelegation };
  /** Autonomous modes route web research to scouts; Off and Manual keep the
   * parent's web tools regardless of whether any Agents are working. */
  const parentWebHidden = (): boolean =>
    ready && !!router && router.admissionState().enabled && delegation.mode !== "manual";
  const parentWebTools = (): readonly string[] => startup?.parentWebTools() ?? [];
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
    const active = (pendingActive ??= pi.getActiveTools());
    if (publishedGuideline !== wanted) {
      pi.registerTool({ ...spawnTool, promptGuidelines: [wanted] });
      publishedGuideline = wanted;
    }
    if (!sameTools(pi.getActiveTools(), active)) pi.setActiveTools(active);
    pendingActive = undefined;
    // A snapshot kept across a failure may predate an admission change;
    // management tools follow the current admission, not the snapshot.
    syncWorkerTools();
  };
  const syncWorkerTools = (): void => {
    if (!controller || !router) return;
    const current = pi.getActiveTools();
    const selected = workerToolSelection(
      current,
      router.admissionState().enabled,
      controller.hasAcceptedRuns,
    );
    if (
      current.length !== selected.length ||
      current.some((name, index) => name !== selected[index])
    )
      pi.setActiveTools(selected);
  };
  const showPresetError = (error: unknown, ctx: Pick<ExtensionContext, "ui">): void => {
    const body =
      error instanceof OrchestrationError
        ? { code: error.code, ...error.details }
        : { code: "PRESET_ERROR", message: String(error).slice(0, 512) };
    ctx.ui.notify(JSON.stringify(body), "error");
  };
  const publishPreset = (
    candidate: PresetCandidate,
    name: string,
    ctx: Pick<ExtensionContext, "ui">,
    effort_overrides?: EffortOverrides,
    definition?: PresetDefinition,
  ): PresetPublication => {
    if (!ready || !controller || !router) throw new OrchestrationError("ORCHESTRATION_NOT_READY");
    const committed = commitPresetSelection({
      controller,
      router,
      candidate,
      name,
      effort_overrides,
      definition,
      sessionDefinitions,
      effortInputs,
      appendAudit: (record) => pi.appendEntry(presetEntry, record),
    });
    sessionDefinitions = committed.nextDefinitions;
    if (settingsStore)
      stageSettings(() => {
        const store = settingsStore!;
        // A remembered name must not depend on a session-only or workspace-only
        // definition absent from its target scope on the next fresh startup.
        const definitions = router!.customPresets();
        const rememberedDefinition = Object.hasOwn(definitions, name)
          ? definitions[name]
          : undefined;
        if (rememberedDefinition && store.scope !== "session")
          store.stage(store.scope, ["presets", name], rememberedDefinition);
        stageWorkerSelection(
          store,
          committed.publication.selection,
          committed.previous,
          effort_overrides !== undefined,
          committed.previousEfforts,
        );
      }, ctx);
    // Tool exposure is not the execution gate. A stale SDK tool handle still
    // reaches the Controller's current selection/disable-revision checks.
    presentPresetSelection({
      snapshot: committed.publication.selection,
      delegation,
      syncTools: syncWorkerTools,
      setStatus: () =>
        ctx.ui.setStatus(
          "alehouse-preset",
          delegationStatus(committed.publication.selection, delegation),
        ),
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    return committed.publication;
  };
  /** Audit, then re-register agent_spawn with the new guideline (one
   * prompt-cache miss). Pi applies it from the next run; a run already in
   * progress keeps its prompt. Running Agents are unchanged. Returns whether
   * the setting changed. */
  const publishDelegation = (
    next: DelegationSetting,
    ctx: Pick<ExtensionContext, "ui">,
  ): boolean => {
    if (!ready || !controller || !router || !spawnTool)
      throw new OrchestrationError("ORCHESTRATION_NOT_READY", {
        resolution:
          "Fix the reported startup error and restart Pi before changing the delegation mode.",
      });
    if (!isDelegationSetting(next)) throw new OrchestrationError("INVALID_DELEGATION");
    const setting: DelegationSetting = { mode: next.mode, eagerness: next.eagerness };
    if (setting.mode === delegation.mode && setting.eagerness === delegation.eagerness) {
      // Unchanged, but repair an earlier failed re-registration.
      retryPublishedGuideline({
        syncGuideline,
        notify: (message, level) => ctx.ui.notify(message, level),
      });
      return false;
    }
    auditDelegationSelection(controller, () =>
      pi.appendEntry(delegationEntry, { ...setting, selected_at: Date.now() }),
    );
    const previous = delegation;
    delegation = setting;
    if (settingsStore && settingsStore.scope !== "session")
      stageSettings(() => {
        const store = settingsStore!;
        if (store.scope === "session") return;
        if (previous.mode !== setting.mode)
          store.stage(store.scope, ["delegation", "mode"], setting.mode);
        if (previous.eagerness !== setting.eagerness)
          store.stage(store.scope, ["delegation", "eagerness"], setting.eagerness);
      }, ctx);
    // A failure here is retried on the next reselect and before each run.
    presentDelegationChange({
      setting,
      syncGuideline,
      setStatus: () =>
        ctx.ui.setStatus("alehouse-preset", delegationStatus(router!.current(), setting)),
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    return true;
  };
  /** The only readiness gate preset work has: the catalogue is meaningless
   * until session_start resolved the saved selection against disk. */
  const requireRouter = (): PresetRouter => {
    if (!ready || !router)
      throw new OrchestrationError("ORCHESTRATION_NOT_READY", {
        resolution:
          "Fix the reported startup error and restart Pi before selecting a worker preset.",
      });
    return router;
  };
  const activities = new ChildActivityRegistry();
  const widget = new AgentWidget(
    {
      list: (options) => controller?.list(options) ?? [],
      stats: () => controller?.stats() ?? { resident: 0, cleanup_uncertain: false },
    },
    residentLimit,
    activities.observations,
    (ids) => activities.retain(ids),
  );
  const panels = new PanelCoordinator({
    pi,
    widget,
    ready: () => ready,
    router: requireRouter,
    publish: publishPreset,
    showError: showPresetError,
    stopRun: (run_id) => {
      if (!ready || !controller) throw new OrchestrationError("ORCHESTRATION_NOT_READY");
      return requestHumanStop(controller, pi, run_id);
    },
    delegation: {
      current: () => ({ ...delegation }),
      set: publishDelegation,
      guideline: delegationGuideline,
    },
    management: {
      summary: () => settingsUi?.summary() ?? "Save: session",
      settings: async () => {
        await settingsUi?.open();
      },
      saveDefault: async (scope) => {
        await settingsUi?.saveDefault(scope);
      },
      canSaveWorkspace: () => settingsStore?.canWriteWorkspace() === true,
      editPreset: async (name?: string) => {
        await settingsUi?.editPreset(name);
      },
      editModel: async (name, slot, position) => {
        await settingsUi?.editModel(name, slot, position);
      },
      cancelModelSelection: () => {
        settingsUi?.cancelModelSelection();
      },
    },
    efforts: (preset, slot) => {
      try {
        return workerEffortCapabilities(preset, slot, effortInputs());
      } catch {
        return {
          levels: [],
          error: "Host model metadata is unavailable; reopen the delegation panel.",
        };
      }
    },
  });
  pi.registerCommand("alehouse-preset", {
    description: "Select a model preset, 'off' to disable new work, or 'reload' to reread presets",
    handler: async (args, ctx) => {
      const requested = args.trim();
      // A host with no UI cannot show a picker, so the bare command reports the
      // catalogue instead of silently doing nothing.
      if (!requested && !ctx.hasUI) {
        try {
          const live = requireRouter();
          ctx.ui.notify(
            JSON.stringify({ active: live.activePresetName(), presets: live.names() }),
            "info",
          );
        } catch (error) {
          showPresetError(error, ctx);
        }
        return;
      }
      await panels.selectPreset(requested, ctx);
    },
  });
  pi.registerCommand("alehouse-mode", {
    description:
      "Set the delegation mode (manual, co-worker, lead, supervisor) and/or eagerness (reserved, balanced, eager)",
    handler: async (args, ctx) => {
      let notice: string;
      try {
        requireRouter();
        if (!args.trim())
          notice = JSON.stringify({ ...delegation, guideline: delegationGuideline(delegation) });
        else {
          const changed = publishDelegation(parseDelegation(args, delegation), ctx);
          notice = `Delegation: ${delegationLabel(delegation)}${changed ? "" : " (unchanged)"}`;
        }
      } catch (error) {
        showPresetError(error, ctx);
        return;
      }
      // The change already took effect; its notice is best-effort.
      try {
        ctx.ui.notify(notice, "info");
      } catch {
        /* best-effort UI */
      }
    },
  });
  pi.registerCommand("alehouse-settings", {
    description:
      "Choose Session/Global/Workspace save scope, remember settings, save now or discard pending writes",
    handler: async (_args, ctx) => {
      try {
        requireRouter();
        await panels.withManagement(async () => {
          await settingsUi?.open();
        });
      } catch (error) {
        showPresetError(error, ctx);
      }
    },
  });
  pi.registerCommand("alehouse-preset-edit", {
    description:
      "Create a model preset (no args) or edit a named preset; permission profiles stay fixed",
    handler: async (args, ctx) => {
      try {
        requireRouter();
        await panels.withManagement(async () => {
          await settingsUi?.editPreset(args.trim() || undefined);
        });
      } catch (error) {
        showPresetError(error, ctx);
      }
    },
  });
  // Reads the controller every frame instead of holding a second copy of Run state.
  pi.on("tool_call", (event) => {
    if (!ready || !parentPermission())
      return {
        block: true,
        reason: "Alehouse or parent permissions are not ready; inspect the startup error.",
      };
    // Hidden declarations stay callable, e.g. a name recalled from earlier turns.
    if (parentWebHidden() && parentWebTools().includes(event.toolName))
      return { block: true, reason: PARENT_WEB_OFF_REASON };
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
    try {
      return { usage: hostUsage(child, event.usage) };
    } catch {
      controller?.returnUsage(child);
      return undefined;
    }
  });

  // Defense in depth: the native loadout hook below only runs while spawn is
  // active. Keep request hiding even when host exclusions/permissions withhold
  // it. Both paths use the same live mode and registry, never the active set.
  // This projection leaves canonical history and tool selection untouched.
  pi.on("context_with_system", (event) => {
    if (!parentWebHidden()) return;
    return { messages: hideParentWebDeclarations(event.messages, parentWebTools()) };
  });
  // Reconcile after startup/SDK restoration and before the first request, but
  // never inject orchestration text or an Off message into model context: the
  // delegation guideline belongs to agent_spawn and follows its visibility.
  pi.on("before_agent_start", (event) => {
    if (!ready) return;
    try {
      syncGuideline();
    } catch {
      /* reported when it first failed; retried next run */
    }
    syncWorkerTools();
    // Pi snapshots the run's prompt options before this event: a re-registration
    // recovered here reaches the registry, not this run's rules, so update them.
    if (spawnTool && publishedGuideline !== undefined) {
      event.systemPromptOptions.toolGuidelines[spawnTool.name] = [publishedGuideline];
    }
    // The authority can restore currently inactive web tools later in this
    // event. Give its prompt renderer the complete registry, not the pre-
    // authority active set. SDK loadout preparation may reset hiddenTools;
    // request declarations are independently filtered by context_with_system.
    const hiddenWeb = parentWebHidden() ? parentWebTools() : [];
    if (hiddenWeb.length)
      event.systemPromptOptions.hiddenTools = [
        ...new Set([...event.systemPromptOptions.hiddenTools, ...hiddenWeb]),
      ];
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ready = false;
    routingContext = undefined;
    settingsUi?.dispose();
    settingsStore?.seal();
    // Save preferences independently of child drain, which may never confirm
    // closure. No process-exit hook, background write or timeout-as-cancellation.
    try {
      for (const result of settingsStore?.flush() ?? [])
        if (result.error) {
          const message = `Settings not saved: ${result.path}: ${result.error}`;
          try {
            if (ctx.hasUI) ctx.ui.notify(message, "error");
            else console.error(message);
          } catch {
            console.error(message);
          }
        }
    } catch (error) {
      console.error(`Settings flush failed: ${String(error).slice(0, 512)}`);
    } finally {
      unregisterSettings?.();
      unregisterSettings = undefined;
    }
    // Presentation failures cannot replace Owner drain. Attempt every cleanup
    // independently before awaiting shutdown, while parent authority still exists.
    for (const cleanup of [
      () => ctx.ui.setStatus("alehouse-preset", undefined),
      () => panels.dispose(),
      () => widget.dispose(),
      () => activities.clear(),
    ]) {
      try {
        cleanup();
      } catch {
        /* best-effort presentation teardown */
      }
    }
    if (controller && !(await controller.shutdown(5000)).closed) {
      ctx.ui.notify(
        "Alehouse cleanup is incomplete. Do not reuse this parent; inspect outstanding work before restarting Pi.",
        "error",
      );
    }
    if (controller) reportUnreportedUsage(pi, ctx, controller);
  });
  pi.registerCommand("alehouse-status", {
    description: "Show this parent's Alehouse capacity and shutdown state",
    handler: async (_args, ctx) =>
      ctx.ui.notify(JSON.stringify(controller?.stats() ?? { ready: false }), "info"),
  });
  pi.on("session_start", async (_event, ctx) => {
    assert(!controller, "An Alehouse owner cannot be rebound to another parent");
    assert(
      !pi.getAllTools().some((tool) => blockedDelegationToolNames.includes(tool.name)),
      "Old and new delegation backends must not be co-loaded",
    );
    const agentDir = getAgentDir(),
      parentId = ctx.sessionManager.getSessionId();
    const presetPath = join(agentDir, "alehouse-presets.json");
    let preferences: SettingsDocument;
    try {
      settingsStore = new SettingsStore({
        agentDir,
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      preferences = settingsStore.effective();
    } catch (error) {
      showPresetError(settingsLoadFailure(error, agentDir, ctx.cwd), ctx);
      return;
    }
    try {
      const selections = branchCustom(ctx, presetEntry);
      sessionDefinitions = restorePresetDefinitions(selections);
      router = restorePresetRouter(presetPath, selections, preferences);
    } catch (error) {
      // A bad branch record is not a defect in the base catalogue. Attaching
      // that file's path sends the operator to the wrong place to repair it.
      showPresetError(presetRestoreFailure(error, presetPath), ctx);
      return;
    }
    try {
      delegation = restoreDelegation(branchCustom(ctx, delegationEntry), {
        ...router.defaultDelegation,
        ...preferences.delegation,
      });
    } catch (error) {
      // A session record, not the preset file: say which.
      router = undefined;
      showPresetError(delegationRestoreFailure(error), ctx);
      return;
    }
    const { permissionRoot, policyRoot, flock } = requireLauncherPaths();
    const permission = requireStartupPermission(startup);
    // The launcher loads us first so shutdown drains children BEFORE tearing
    // down the parent authority. Permission session_start runs after ours;
    // tool admission and child creation check its readiness, not this hook.
    parentPermission = () => permission.getPermissionsService(parentId);
    const runtime = requireHostModelRuntime(ctx);
    const profiles = loadAdmittedProfiles(agentDir);
    const web = openResearcherWeb();
    const settings = () => {
      const manager = SettingsManager.create(ctx.cwd, agentDir, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      // Native recovery remains inside the same Run and its accounting/drain.
      configureChildRuntime(manager);
      return manager;
    };
    const parentHistory = {
      getSessionId: () => parentId,
      isPersisted: () => !!ctx.sessionManager.getSessionFile(),
      appendCustomEntry: (type: string, data: unknown) => pi.appendEntry(type, data),
    };
    const owner = await FileOwnerLease.open({
      directory: join(agentDir, "alehouse-owners"),
      owner_id: parentId,
      flock,
    });
    const approvalBindings = new ApprovalBindings(pi.events, owner);
    const createSession = createChildSessionFactory({
      ctx,
      parentBus: pi.events,
      agentDir,
      permissionRoot,
      policyRoot,
      parentId,
      runtime,
      profiles,
      settings,
      parentHistory,
      approvalBindings,
      activities,
      parentPermission,
      getPermissionsService: permission.getPermissionsService,
      subscribeManagedBlocks: permission.subscribeManagedBlocks,
      web,
    });
    try {
      controller = await OwnerController.open({
        owner,
        managedBlockTools: managedBlockToolNames,
        admission: () => router!.admissionState(),
        onContextChange: approvalBindings.contextChanged,
        dispatch: createDispatchRuntime({
          agentDir,
          flock,
          git: process.env.PI_ALEHOUSE_GIT,
          getPermissionsService: parentPermission,
        }),
        createSession,
      });
      ownerSessionReplacementGuard(controller)(pi);
      for (const tool of createOwnerTools({
        controller,
        context: ctx,
        profiles,
        getSupportedThinkingLevels,
        getPreset: () => router!.current(),
        parentPermission,
        // Admission happens before an optional tool-local wait. Paint the new
        // reservation immediately; tool_result remains the sole usage drain.
        // Keep best-effort visibility repair here too: this callback also runs
        // on accepted-request retries while Off, not only new enabled admissions.
        onRunAccepted: () => {
          syncWorkerTools();
          widget.wake();
        },
        guideline: delegationGuideline(delegation),
      })) {
        if (tool.name !== "agent_spawn") {
          pi.registerTool(tool);
          continue;
        }
        // Use Pi's native projection while spawn is active so SDK-generated
        // prompt sections also omit web tools. The request hook above covers
        // filtered-out spawn; neither path deactivates or removes web tools.
        spawnTool = {
          ...tool,
          prepareLoadout: () =>
            parentWebHidden() ? { hiddenDeclarations: parentWebTools() } : undefined,
        } as ToolDefinition;
        publishedGuideline = delegationGuideline(delegation);
        pi.registerTool(spawnTool);
      }
      // Register once, then hide inactive tools before any model request. Later
      // registration of another extension's tools must not reactivate ours.
      syncWorkerTools();
      widget.setBeerMugs(preferences.ui?.beerMugs === true);
      widget.setUi(ctx.ui);
      // Panels always mount through the session-start context wrapped by the
      // prompt queue, and observe approvals on the parent bus.
      panels.attachHost(ctx, pi.events);
      // Publish the worker selection only after initialization has completed.
      // Agent activity and capacity stay in the widget.
      ctx.ui.setStatus("alehouse-preset", delegationStatus(router.current(), delegation));
      routingContext = ctx;
      ready = true;
      unregisterSettings = registerSettingsStore(parentId, settingsStore);
      settingsUi = new PreferencesControls({
        ctx,
        store: settingsStore,
        ready: () => ready && routingContext === ctx,
        beerMugs: {
          current: () => widget.beerMugsEnabled,
          set: (enabled) => widget.setBeerMugs(enabled),
        },
        createModelSelector: (options) => createPresetModelSelector({ ...options, runtime }),
        modelPopover: () => panels.isFullscreen(),
        modelSelectionAllowed: () => panels.modelSelectionAllowed(),
        beforeModelClose: () => pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}),
        router: requireRouter,
        delegation: () => ({ ...delegation }),
        publishDefinition: (candidate, name, definition) => {
          const selected = requireRouter()
            .inspect(candidate)
            .find((preset) => preset.name === name);
          publishPreset(
            candidate,
            name,
            ctx,
            selected && !isOffPreset(selected) ? selected.effort_overrides : {},
            definition,
          );
        },
      });
      if (!ctx.isProjectTrusted())
        ctx.ui.notify(
          "Workspace preferences are not loaded or writable until this project is trusted.",
          "info",
        );
      const current = router.current();
      if (!isOffPreset(current) && Object.keys(current.effort_overrides).length) {
        // Fixed-policy model support may have changed since saving. Inherit
        // remains spawn-time only, not a startup warning about parent thinking.
        // Keep the explicit policy visible/editable; never clamp or erase it.
        try {
          validateWorkerEfforts(current, effortInputs());
        } catch (error) {
          try {
            ctx.ui.notify(
              `Saved worker effort needs attention: ${String(error)}. Open Alt+S to edit it; existing settings were not changed.`,
              "warning",
            );
          } catch {
            /* a warning cannot undo successful initialization */
          }
        }
      }
    } catch (error) {
      ready = false;
      router = undefined;
      routingContext = undefined;
      settingsUi?.dispose();
      settingsStore?.seal();
      unregisterSettings?.();
      unregisterSettings = undefined;
      // Startup can fail after UI binding too; presentation must not skip drain.
      for (const cleanup of [
        () => panels.dispose(),
        () => widget.dispose(),
        () => activities.clear(),
      ]) {
        try {
          cleanup();
        } catch {
          /* continue Owner teardown */
        }
      }
      if (controller) await controller.shutdown(5000);
      else owner.close();
      throw error;
    }
  });
}
