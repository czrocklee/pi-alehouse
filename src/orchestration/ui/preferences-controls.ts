import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  type PersistentScope,
  type PresetDefinition,
  type SettingsChange,
  type SettingsStore,
  type SettingsDocument,
  validateSettings,
} from "../../shared/settings-store.mjs";
import type { DelegationSetting } from "../delegation.ts";
import { OrchestrationError } from "../core/ports.ts";
import {
  isOffPreset,
  strengths,
  thinkingLevels,
  type PresetCandidate,
  type PresetRouter,
  type PresetSelection,
  type EffortOverrides,
  type Effort,
  type Strength,
} from "../routing.ts";
import { workerSlotDisplayOrder, type ModelPickerPosition } from "./preset-picker.ts";
import { ModelSelectionSession, type ModelSelectionOptions } from "./model-selection-session.ts";

/** Appearance-only controls: session scope applies live, a persistent scope
 * queues just the named `ui` leaf. */
export interface AppearancePreferenceControl {
  current(): boolean;
  set(enabled: boolean): void;
}
interface AppearanceAction {
  key: "beerMugs" | "borderLabels";
  label: string;
  /** Scope hint shown in the menu row and its notifications. */
  detail?: string;
  control: AppearancePreferenceControl;
  action: string;
}
const describeAppearance = (entry: Pick<AppearanceAction, "label" | "detail">, enabled: boolean) =>
  `${entry.label}: ${enabled ? "on" : "off"}${entry.detail ? ` (${entry.detail})` : ""}`;

export interface PreferencesControlsOptions extends ModelSelectionOptions {
  store: SettingsStore;
  beerMugs: AppearancePreferenceControl;
  borderLabels: AppearancePreferenceControl;
  childSkills: {
    current(): boolean;
    set(enabled: boolean): void;
    /** Invocation-only suppression; changing saved preferences cannot enable this launch. */
    disabledReason?(): string | undefined;
  };
  ready(): boolean;
  router(): PresetRouter;
  delegation(): DelegationSetting;
  publishDefinition(candidate: PresetCandidate, name: string, definition: PresetDefinition): void;
}

const scopes = ["global", "workspace"] as const;
/** Operator dialogs only. No model tool and no permission-profile editing.
 * The picker has settled before these standard dialogs enter the UI queue. */
export class PreferencesControls {
  private alive = true;
  private busy = false;
  private readonly models: ModelSelectionSession;
  constructor(private readonly options: PreferencesControlsOptions) {
    this.models = new ModelSelectionSession(options, () => this.assertLive());
  }

  dispose(): void {
    this.alive = false;
    this.cancelModelSelection();
  }
  /** Yield only our model dialog to a permission prompt, without disposing
   * these session controls. Also marks a queued factory as cancelled. */
  cancelModelSelection(): void {
    this.models.cancel();
  }
  private live(): boolean {
    return this.alive && this.options.ready();
  }
  private assertLive(): void {
    if (!this.live()) throw new OrchestrationError("SETTINGS_SESSION_CHANGED");
  }
  summary(): string {
    const store = this.options.store;
    return `Save: ${store.scope} · ${store.pending().length ? `${store.pending().length} pending until exit` : "no pending writes"}`;
  }

  private async interaction(action: () => Promise<void>): Promise<void> {
    if (this.busy || !this.live()) return;
    if (!this.options.ctx.hasUI) throw new OrchestrationError("SETTINGS_UI_REQUIRED");
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
  }

  private async target(): Promise<PersistentScope | undefined> {
    const { ctx, store } = this.options;
    const selected = await ctx.ui.select("Remember for", ["global", "workspace"]);
    this.assertLive();
    if (!scopes.includes(selected as PersistentScope)) return undefined;
    const scope = selected as PersistentScope;
    if (scope === "workspace" && !store.canWriteWorkspace())
      throw new OrchestrationError("PROJECT_NOT_TRUSTED");
    return scope;
  }

  private async confirm(scope: PersistentScope, description: string): Promise<boolean> {
    const { ctx, store } = this.options;
    if (scope === "workspace" && !store.canWriteWorkspace())
      throw new OrchestrationError("PROJECT_NOT_TRUSTED");
    const accepted = await ctx.ui.confirm(
      `Remember in ${scope}?`,
      `${description}\n\n${store.paths[scope]}\n` +
        "Only explicit changes are queued; the file is created or updated on normal exit (or Save now). " +
        (scope === "workspace"
          ? "This is a workspace file: it may appear in Git and be shared if committed. Pi may ask for project trust next time. Saving does not grant trust."
          : "Workspace overrides can still replace these defaults. Existing sessions keep their recorded choices."),
    );
    this.assertLive();
    return accepted === true;
  }

  /** Both appearance rows share one live/staging path; only their label and
   * preference leaf differ. */
  private appearanceActions(): AppearanceAction[] {
    const entries: Omit<AppearanceAction, "action">[] = [
      { key: "beerMugs", label: "Beer mugs", control: this.options.beerMugs },
      {
        key: "borderLabels",
        label: "Border labels",
        detail: "all Alehouse panels",
        control: this.options.borderLabels,
      },
    ];
    return entries.map((entry) => ({
      ...entry,
      action: describeAppearance(entry, entry.control.current()),
    }));
  }
  /** Apply the live choice first so a failed queue never hides the toggle. A
   * global save still explains a more specific workspace override. */
  private toggleAppearance(entry: AppearanceAction): void {
    const { key, control } = entry;
    const { ctx, store } = this.options;
    const enabled = !control.current();
    control.set(enabled);
    const description = describeAppearance(entry, enabled);
    if (store.scope === "session") {
      ctx.ui.notify(`${description} (session only; no configuration write).`, "info");
      return;
    }
    try {
      store.stage(store.scope, ["ui", key], enabled);
    } catch (error) {
      ctx.ui.notify(
        `${description} is live for this session, but defaults were not queued: ${String(error).slice(0, 512)}`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(`${description}. ${this.summary()}`, "info");
    const workspace =
      store.scope === "global" && store.canWriteWorkspace()
        ? store.get("workspace").ui?.[key]
        : undefined;
    if (workspace !== undefined) {
      ctx.ui.notify(
        `Current session: ${description}. Save scope: global. ` +
          `Next startup after saving pending writes, if any: ${describeAppearance(entry, workspace)}. ` +
          `The workspace ui.${key} override takes precedence over the global default; it was not removed.`,
        "info",
      );
    }
  }

  private notifyPending(): void {
    const { store, ctx } = this.options;
    ctx.ui.notify(this.summary(), "info");
    if (
      store.scope === "global" &&
      Object.keys(store.get("workspace")).some((key) => key !== "version")
    ) {
      ctx.ui.notify(
        "This workspace has overrides; overlapping global defaults will remain shadowed here.",
        "info",
      );
    }
  }

  async open(): Promise<void> {
    await this.interaction(async () => {
      const { ctx, store } = this.options;
      const appearance = this.appearanceActions();
      const childSkillsReason = this.options.childSkills.disabledReason?.();
      const childSkillsAction = `Agent skills: ${this.options.childSkills.current() ? "on" : "off"}${childSkillsReason ? ` (${childSkillsReason})` : ""}`;
      const action = await ctx.ui.select(`Alehouse settings · ${this.summary()}`, [
        ...appearance.map((entry) => entry.action),
        childSkillsAction,
        "Change save scope",
        "Remember current worker settings",
        "Save pending now",
        "Discard pending writes",
        "Remove a saved override",
        "Show paths and pending changes",
      ]);
      this.assertLive();
      const appearanceAction = appearance.find((entry) => entry.action === action);
      if (appearanceAction) {
        this.toggleAppearance(appearanceAction);
      } else if (action === childSkillsAction) {
        const disabledReason = this.options.childSkills.disabledReason?.();
        if (disabledReason) {
          ctx.ui.notify(
            `Agent skills are disabled for this launch by ${disabledReason} (-ns). ` +
              "Start Pi without that option to change child skill discovery. Saved preferences are unchanged.",
            "info",
          );
          return;
        }
        const enabled = !this.options.childSkills.current();
        this.options.childSkills.set(enabled);
        const description = `Agent skills: ${enabled ? "on" : "off"}`;
        const effect =
          "New child sessions only; already-created sessions retain their loaded skill catalogue. " +
          "Queued Agents without a session use the choice at session creation. " +
          "Off disables skill discovery, not file reads or permissions.";
        if (store.scope === "session") {
          ctx.ui.notify(`${description} (session only; no configuration write). ${effect}`, "info");
        } else {
          try {
            store.stage(store.scope, ["childSkills"], enabled);
          } catch (error) {
            ctx.ui.notify(
              `${description} is live for new child sessions, but defaults were not queued: ${String(error).slice(0, 512)}. ${effect}`,
              "warning",
            );
            return;
          }
          ctx.ui.notify(`${description}. ${effect} ${this.summary()}`, "info");
          const workspace =
            store.scope === "global" && store.canWriteWorkspace()
              ? store.get("workspace").childSkills
              : undefined;
          if (workspace !== undefined) {
            ctx.ui.notify(
              `Current session: ${description}. Save scope: global. ` +
                `Next startup after saving pending writes, if any: Agent skills: ${workspace ? "on" : "off"}. ` +
                "The workspace childSkills override takes precedence over the global default; it was not removed.",
              "info",
            );
          }
        }
      } else if (action === "Change save scope") {
        const scope = await ctx.ui.select("Future explicit changes in this session save to", [
          "session",
          "global",
          "workspace",
        ]);
        this.assertLive();
        if (scope === "session") store.setScope("session");
        else if (
          scopes.includes(scope as PersistentScope) &&
          (await this.confirm(
            scope as PersistentScope,
            "Future applied worker, approval, appearance and Agent skills choices in this session will also update defaults. Switching scope alone copies nothing.",
          ))
        ) {
          store.setScope(scope as PersistentScope);
        }
        this.notifyPending();
      } else if (action === "Remember current worker settings") {
        const scope = await this.target();
        if (!scope) return;
        await this.rememberWorkerSettings(scope);
      } else if (action === "Save pending now") {
        this.reportFlush();
      } else if (action === "Discard pending writes") {
        if (
          await ctx.ui.confirm(
            "Discard pending configuration writes?",
            "Current session choices stay unchanged. " +
              "Next startup follows the existing on-disk global/workspace defaults, not the discarded changes. Nothing on disk is deleted.",
          )
        ) {
          this.assertLive();
          store.discard();
          ctx.ui.notify(
            "Pending writes discarded. Current session choices stay unchanged; next startup follows the existing on-disk defaults.",
            "info",
          );
        }
      } else if (action === "Remove a saved override") {
        const scope = await this.target();
        if (!scope) return;
        const layer = store.get(scope);
        const paths: string[][] = [];
        if (layer.preset !== undefined) paths.push(["preset"]);
        if (layer.approval !== undefined) paths.push(["approval"]);
        if (layer.childSkills !== undefined) paths.push(["childSkills"]);
        if (layer.ui?.beerMugs !== undefined) paths.push(["ui", "beerMugs"]);
        if (layer.ui?.borderLabels !== undefined) paths.push(["ui", "borderLabels"]);
        for (const key of Object.keys(layer.delegation ?? {})) paths.push(["delegation", key]);
        for (const [name, slots] of Object.entries(layer.effort ?? {}))
          for (const key of Object.keys(slots)) paths.push(["effort", name, key]);
        for (const name of Object.keys(layer.presets ?? {})) paths.push(["presets", name]);
        if (!paths.length) {
          ctx.ui.notify("No overrides in this scope.", "info");
          return;
        }
        const labels = paths.map((path) => JSON.stringify(path));
        const chosen = await ctx.ui.select(
          "Remove this scope's override; after saving, next startup follows remaining layers",
          labels,
        );
        this.assertLive();
        const index = labels.indexOf(chosen ?? "");
        if (index < 0) return;
        if (
          await this.confirm(
            scope,
            `Remove ${labels[index]}. Current session choices are unchanged. ` +
              "After saving pending writes, next startup follows the remaining saved layers or defaults; higher-priority overrides still apply. " +
              "Removing a custom preset may require changing its saved selection too.",
          )
        ) {
          store.stage(scope, paths[index]!, undefined);
          ctx.ui.notify(
            `Override removal staged for ${scope}. ${this.summary()}. Current session choices stay unchanged. ` +
              "After saving pending writes, next startup follows the remaining saved layers or defaults; higher-priority overrides still apply.",
            "info",
          );
        }
      } else if (action === "Show paths and pending changes") {
        ctx.ui.notify(
          JSON.stringify(
            {
              scope: store.scope,
              paths: store.paths,
              workspaceTrusted: store.canWriteWorkspace(),
              pending: store.pending(),
              defaults: store.effective(),
            },
            null,
            2,
          ),
          "info",
        );
      }
    });
  }

  /** One-shot save of the live worker choices, never a picker highlight or
   * editor draft. It changes neither the active choices nor future save scope. */
  async saveDefault(scope: PersistentScope): Promise<void> {
    await this.interaction(async () => {
      await this.rememberWorkerSettings(scope);
    });
  }

  private workerSnapshot(router: PresetRouter): SettingsDocument {
    const current = router.current(),
      definitions = router.customPresets();
    const body = Object.hasOwn(definitions, current.name) ? definitions[current.name] : undefined;
    return {
      version: 2,
      preset: current.name,
      delegation: { ...this.options.delegation() },
      ...(!isOffPreset(current)
        ? {
            effort: {
              [current.name]: Object.fromEntries(
                strengths.map((slot) => [slot, current.effort_overrides[slot] ?? null]),
              ),
            },
          }
        : {}),
      ...(body ? { presets: { [current.name]: body } } : {}),
    };
  }

  private async rememberWorkerSettings(scope: PersistentScope): Promise<void> {
    this.assertLive();
    const { ctx, store } = this.options;
    const router = this.options.router(),
      revision = router.prepare().revision;
    const path = store.paths[scope],
      selection = this.workerSnapshot(router);
    const snapshot = JSON.stringify(selection);
    const patches: SettingsChange[] = [
      { path: ["preset"], value: selection.preset },
      { path: ["delegation", "mode"], value: selection.delegation!.mode },
      { path: ["delegation", "eagerness"], value: selection.delegation!.eagerness },
    ];
    for (const [name, slots] of Object.entries(selection.effort ?? {}))
      for (const [slot, value] of Object.entries(slots))
        patches.push({ path: ["effort", name, slot], value });
    for (const [name, body] of Object.entries(selection.presets ?? {}))
      patches.unshift({ path: ["presets", name], value: body });
    if (
      !(await this.confirm(
        scope,
        `Save the current applied worker settings (not a highlighted preset, slider preview or live parent thinking):\n${JSON.stringify(patches, null, 2)}`,
      ))
    )
      return;
    if (
      this.options.router() !== router ||
      router.prepare().revision !== revision ||
      JSON.stringify(this.workerSnapshot(router)) !== snapshot ||
      store.paths[scope] !== path
    ) {
      ctx.ui.notify(
        "Worker settings changed while confirming; nothing was staged. Try again.",
        "warning",
      );
      return;
    }
    if (scope === "workspace" && !store.canWriteWorkspace())
      throw new OrchestrationError("PROJECT_NOT_TRUSTED");
    store.stageBatch(scope, patches);
    ctx.ui.notify(
      `Worker defaults queued for ${scope} on normal exit; current choices and save scope are unchanged. ` +
        "Save approval defaults from the approval menu (/approval save).",
      "info",
    );
  }

  reportFlush(): void {
    const { ctx, store } = this.options;
    const results = store.flush();
    if (!results.length) {
      ctx.ui.notify("No pending configuration writes.", "info");
      return;
    }
    for (const result of results)
      ctx.ui.notify(
        result.error
          ? `Settings not saved: ${result.path}: ${result.error}`
          : `Settings saved: ${result.path}`,
        result.error ? "error" : "info",
      );
  }

  /** Edit just the clicked model. Selecting in the native picker is the
   * explicit Apply for an active preset; enabling another needs confirmation. */
  async editModel(name: string, slot: Strength, position?: ModelPickerPosition): Promise<void> {
    await this.interaction(async () => {
      const { ctx } = this.options,
        router = this.options.router();
      if (!strengths.includes(slot)) throw new OrchestrationError("INVALID_PRESET_SLOT", { slot });
      const existing = router.definition(name);
      if (!existing || name === "off")
        throw new OrchestrationError("INVALID_PRESET_NAME", { name });
      const originalCandidate = router.prepare();
      const models = ctx.modelRegistry.getAll().filter((model) => model.api !== "pi-virtual");
      if (!models.length) throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE");
      const previous = existing.slots[slot].model;
      const selected = await this.models.select(name, slot, previous, models, position);
      this.assertLive();
      if (!selected || selected === previous) return;
      const matches = ctx.modelRegistry
        .getAll()
        .filter(
          (model) => model.api !== "pi-virtual" && `${model.provider}/${model.id}` === selected,
        );
      if (matches.length !== 1) throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE");
      const body = structuredClone(existing);
      body.slots[slot].model = selected;
      body.version = `user-${Date.now()}`;
      validateSettings({ version: 2, presets: { [name]: body } });
      if (
        router.current().name !== name &&
        !(await ctx.ui.confirm(
          `Change ${slot} model and enable ${name}?`,
          `${previous} → ${selected}\nThis replaces the current active preset.\n` +
            "New Agents only; existing Agents and main model are unchanged.\n" +
            "Other models, default efforts and session effort overrides are kept.\n" +
            `Save scope: ${this.options.store.scope}. The base alehouse-presets.json and permission profiles are never modified.`,
        ))
      )
        return;
      this.assertLive();
      if (
        this.options.router() !== router ||
        router.prepare().revision !== originalCandidate.revision
      )
        throw new OrchestrationError("STALE_PRESET_SELECTION");
      const candidate = router.prepare({ ...router.customPresets(), [name]: body });
      this.options.publishDefinition(candidate, name, body);
    });
  }

  async editPreset(name?: string): Promise<void> {
    await this.interaction(async () => {
      const { ctx } = this.options,
        router = this.options.router();
      // Capture the revision before any dialog: another command must make this
      // editor stale, not let it overwrite a newer selection/catalogue.
      const originalCandidate = router.prepare();
      const existing = name === undefined ? undefined : router.definition(name);
      const entered =
        name ??
        (await ctx.ui.input(
          "New worker model preset name",
          "letters, digits, . _ -; not off or reload",
        ));
      this.assertLive();
      if (entered === undefined) return;
      const target = entered.trim();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target) ||
        ["off", "reload", "__proto__", "constructor", "prototype"].includes(target)
      ) {
        throw new OrchestrationError("INVALID_PRESET_NAME", {
          resolution:
            "Use 1–64 letters, digits, dots, underscores or hyphens; off and reload are reserved.",
        });
      }
      if (name === undefined && router.names().includes(target))
        throw new OrchestrationError("PRESET_ALREADY_EXISTS", { name: target });
      const models = ctx.modelRegistry.getAll().filter((model) => model.api !== "pi-virtual");
      if (!models.length) throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE");
      const body: PresetDefinition = existing
        ? structuredClone(existing)
        : {
            version: "1",
            slots: {
              d1: { model: "" },
              d2: { model: "" },
              d3: { model: "" },
              d4: { model: "" },
              d5: { model: "" },
            },
          };
      for (const slot of workerSlotDisplayOrder) {
        const previous = body.slots[slot].model;
        const selected = await this.models.select(target, slot, previous, models);
        this.assertLive();
        if (!selected) return;
        body.slots[slot].model = selected;
        // /model may refresh the host catalog while open: validate against the
        // new snapshot, not the stale list captured before its first dialog.
        const model = ctx.modelRegistry
          .getAll()
          .find(
            (candidate) =>
              candidate.api !== "pi-virtual" &&
              `${candidate.provider}/${candidate.id}` === selected,
          );
        if (!model) throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE");
        const levels = getSupportedThinkingLevels(model);
        const policies: Effort[] = [
          "inherit",
          ...thinkingLevels.filter((level) => levels.includes(level)),
        ];
        const old = body.slots[slot].effort ?? "inherit";
        const keepEffort = policies.includes(old) ? `Keep ${old}` : undefined;
        const effort = await ctx.ui.select(`${target}: ${slot} default effort`, [
          ...(keepEffort ? [keepEffort] : []),
          ...policies,
        ]);
        this.assertLive();
        if (!effort) return;
        const chosen = policies.find((policy) => policy === (effort === keepEffort ? old : effort));
        if (chosen === undefined)
          throw new OrchestrationError("THINKING_INCOMPATIBLE", {
            slot,
            reason: "fixed_effort_unsupported",
            resolution: "Choose an effort policy supported by this slot's model, or inherit.",
          });
        body.slots[slot].effort = chosen;
      }
      body.version = `user-${Date.now()}`;
      validateSettings({ version: 2, presets: { [target]: body } });
      if (
        !(await ctx.ui.confirm(
          `${name ? "Edit" : "Create"} and select ${target}?`,
          `${JSON.stringify(body, null, 2)}\nNew Agents only; existing Agents and main model are unchanged.\n` +
            "Existing session effort overrides are kept; use Edit effort to reset them.\n" +
            `Save scope: ${this.options.store.scope}. The base alehouse-presets.json and permission profiles are never modified.`,
        ))
      )
        return;
      this.assertLive();
      if (router.prepare().revision !== originalCandidate.revision)
        throw new OrchestrationError("STALE_PRESET_SELECTION");
      const candidate = router.prepare({ ...router.customPresets(), [target]: body });
      this.options.publishDefinition(candidate, target, body);
    });
  }
}

/** Queue the definition, if needed, and explicitly changed selection fields
 * together. `null` masks a lower-layer pin with the catalogue default. */
export function stageWorkerSelection(
  store: SettingsStore,
  selection: PresetSelection,
  previous: PresetSelection,
  changedEfforts: boolean,
  previousEfforts: EffortOverrides = {},
  rememberedDefinition?: PresetDefinition,
): void {
  const scope = store.scope;
  if (scope === "session") return;
  const changes: SettingsChange[] = [];
  if (rememberedDefinition)
    changes.push({ path: ["presets", selection.name], value: rememberedDefinition });
  if (selection.name !== previous.name) changes.push({ path: ["preset"], value: selection.name });
  if (changedEfforts && !isOffPreset(selection))
    for (const slot of strengths) {
      const before = previousEfforts[slot];
      const after = selection.effort_overrides[slot];
      if (before !== after)
        changes.push({ path: ["effort", selection.name, slot], value: after ?? null });
    }
  if (changes.length > 0) store.stageBatch(scope, changes);
}
