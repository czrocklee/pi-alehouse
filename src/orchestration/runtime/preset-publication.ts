import type { OwnerController } from "../core/owner-controller.ts";
import { OrchestrationError } from "../core/ports.ts";
import {
  isOffPreset,
  PresetRouter,
  resolveSlotRoute,
  selectPhysicalWorkerModel,
  strengths,
  thinkingLevels,
  type EffortCapabilities,
  type EffortOverrides,
  type PresetCandidate,
  type PresetPublication,
  type PresetSelection,
  type PresetSnapshot,
  type Strength,
} from "../routing.ts";
import { validateSettings, type PresetDefinition } from "../../shared/settings-store.mjs";

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
    return input.router.apply(
      input.candidate,
      input.name,
      (snapshot) => {
        // Validation can fail after the picker opened, before any audit IO. It is
        // not an ambiguous parent-history failure and must not poison the Owner.
        input.validate?.(snapshot);
        auditAttempted = true;
        input.audit(snapshot);
      },
      input.effort_overrides,
    );
  } catch (error) {
    // Candidate/name/staleness failures happen before the callback and are not
    // parent-history failures. Once append was called, however, the SDK may
    // have changed memory or disk before throwing; latch rather than guessing.
    if (!auditAttempted) throw error;
    input.controller.latchParentHistoryFailure(error);
    throw new OrchestrationError("PRESET_AUDIT_FAILED", {
      error: String(error).slice(0, 512),
      resolution:
        "The synchronous parent-session audit call failed or had an ambiguous outcome. The live worker preset was not published. Inspect the parent session and restart Pi before more delegation or preset changes.",
    });
  }
}

type EffortModels<M extends { provider: string; id: string; api?: string }> = {
  models: readonly M[];
  parentThinking: string | undefined;
  supportedThinking: (model: M) => readonly string[];
};
/** Operator feedback must not suggest changing model-facing tool arguments. */
function effortIssue(error: unknown): string {
  if (error instanceof OrchestrationError) {
    if (error.code === "PARENT_THINKING_UNAVAILABLE") return "Parent thinking is unavailable.";
    if (error.code === "PRESET_MODEL_UNAVAILABLE")
      return error.details.reason === "virtual_model"
        ? "Choose a physical worker model; virtual models route each request."
        : "Worker model is unavailable or ambiguous in Pi's registry.";
    if (error.code === "THINKING_INCOMPATIBLE")
      return error.details.reason === "fixed_effort_unsupported"
        ? "The worker model does not support this fixed effort."
        : "Current parent thinking has no supported inherited level under the automatic rule.";
  }
  return "Worker effort could not be checked.";
}

/** UI capability data comes from the host registry, not another model catalogue.
 * Inherited effort is advisory only; admission resolves it at spawn time. */
export function workerEffortCapabilities<M extends { provider: string; id: string; api?: string }>(
  preset: PresetSnapshot,
  slot: Strength,
  input: EffortModels<M>,
): EffortCapabilities {
  let model: M;
  try {
    model = selectPhysicalWorkerModel(input.models, preset.models[slot], preset);
  } catch (error) {
    if (!(error instanceof OrchestrationError)) throw error;
    return { levels: [], error: effortIssue(error) };
  }
  const supported = input.supportedThinking(model);
  const levels = thinkingLevels.filter((level) => supported.includes(level));
  try {
    const inherited = resolveSlotRoute({
      ...input,
      strength: slot,
      preset: { ...preset, effort: { ...preset.effort, [slot]: "inherit" } },
    }).thinking;
    return { levels, inherited };
  } catch (error) {
    return { levels, inheritError: effortIssue(error) };
  }
}

/** Validate saved fixed policies, not transient parent thinking. Inherit is
 * checked only when admitting an Agent, even if its model is missing now. */
export function validateWorkerEfforts<M extends { provider: string; id: string }>(
  preset: PresetSelection,
  input: EffortModels<M>,
): void {
  if (isOffPreset(preset)) throw new OrchestrationError("WORKERS_DISABLED");
  for (const strength of strengths) {
    if (preset.effort[strength] === "inherit") continue;
    try {
      resolveSlotRoute({ ...input, preset, strength });
    } catch (error) {
      if (!(error instanceof OrchestrationError)) throw error;
      throw new OrchestrationError(error.code, {
        preset: preset.name,
        slot: strength,
        error: effortIssue(error),
        resolution:
          "Choose a supported fixed level or inherit, or update the worker model configuration.",
      });
    }
  }
}

/** Audited catalogue commit. Callers stage preferences and paint UI only after
 * this returns; a thrown audit failure has already latched the Owner. */
export function commitPresetSelection<
  M extends { provider: string; id: string; api?: string },
>(input: {
  controller: OwnerController;
  router: PresetRouter;
  candidate: PresetCandidate;
  name: string;
  sessionDefinitions: Record<string, PresetDefinition>;
  effortInputs: () => EffortModels<M>;
  appendAudit: (
    record: PresetSelection & {
      selected_at: number;
      custom_presets?: Record<string, PresetDefinition>;
    },
  ) => void;
  effort_overrides?: EffortOverrides;
  definition?: PresetDefinition;
}): {
  publication: PresetPublication;
  nextDefinitions: Record<string, PresetDefinition>;
  previous: PresetSelection;
  previousEfforts: EffortOverrides;
} {
  const previous = input.router.current();
  const targetBefore = input.router
    .inspect(input.candidate)
    .find((preset) => preset.name === input.name);
  const nextDefinitions = input.definition
    ? (validateSettings({
        version: 2,
        presets: { ...input.sessionDefinitions, [input.name]: input.definition },
      }).presets ?? {})
    : input.sessionDefinitions;
  const snapshot = applyAuditedPreset({
    controller: input.controller,
    router: input.router,
    candidate: input.candidate,
    name: input.name,
    effort_overrides: input.effort_overrides,
    ...(input.effort_overrides === undefined && !input.definition
      ? {}
      : {
          validate: (selected: PresetSelection) => {
            if (input.definition && !isOffPreset(selected))
              for (const slot of strengths) {
                selectPhysicalWorkerModel(
                  input.effortInputs().models,
                  selected.models[slot],
                  selected,
                );
              }
            validateWorkerEfforts(selected, input.effortInputs());
          },
        }),
    // Full immutable slot selection is user audit metadata, never model context.
    // Success means this synchronous SDK call returned; it is not an fsync or
    // a rollback guarantee if the SDK itself throws after changing state.
    audit: (selected) =>
      input.appendAudit({
        ...selected,
        selected_at: Date.now(),
        ...(Object.keys(nextDefinitions).length
          ? { custom_presets: structuredClone(nextDefinitions) }
          : {}),
      }),
  });
  return {
    publication: { selection: snapshot, candidate: input.router.rebase(input.candidate) },
    nextDefinitions,
    previous,
    previousEfforts:
      targetBefore && !isOffPreset(targetBefore) ? targetBefore.effort_overrides : {},
  };
}

/** Parent-session audit for a delegation change. Validation failures before
 * append are not history failures; a throw from append latches the Owner. */
export function auditDelegationSelection(controller: OwnerController, append: () => void): void {
  controller.assertOwnerAvailable();
  try {
    append();
  } catch (error) {
    controller.latchParentHistoryFailure(error);
    throw new OrchestrationError("DELEGATION_AUDIT_FAILED", {
      error: String(error).slice(0, 512),
      resolution:
        "The parent-session audit call failed or had an ambiguous outcome. The delegation mode was not changed. Inspect the parent session and restart Pi before more delegation or mode changes.",
    });
  }
}
