import { OrchestrationError } from "../core/ports.ts";
import {
  PresetRouter,
  decodeRecordedPreset,
  validEffortOverrides,
  type EffortOverrides,
  type PresetSnapshot,
} from "../routing.ts";
import { presetEntry } from "./routing-records.ts";
import {
  validateSettings,
  type PresetDefinition,
  type SettingsDocument,
} from "../../shared/settings-store.mjs";

const savedPresetResolution =
  "The saved alehouse:preset-selection:v1 branch record failed worker configuration validation. Every enabled selection must record its explicit effort overrides; Off selections record none. Effort overrides require a named non-Off preset and valid policies; custom definitions require valid preset versions and all five nested slots d1, d2, d3, d4, d5 with model and optional effort under version-2 settings rules; per-slot thinking fields are unsupported, including empty maps. Correct configuration files explicitly, then start a fresh session or fork from before the invalid alehouse:preset-selection:v1 record and restart Pi. Do not rewrite historical journal records.";

/** Reconstruct only the active branch's per-preset definitions. A selection
 * entry without custom_presets is a legal current absence.
 * The caller must pass getBranch(), never the entire session tree. */
export function restorePresetDefinitions(
  selections: readonly unknown[],
): Record<string, PresetDefinition> {
  let definitions: Record<string, PresetDefinition> = {};
  for (const entry of selections) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("custom_presets" in entry) ||
      !Object.hasOwn(entry, "custom_presets")
    )
      continue;
    try {
      definitions = validateSettings({ version: 2, presets: entry.custom_presets }).presets ?? {};
    } catch {
      throw new OrchestrationError("INVALID_SAVED_PRESETS", {
        record: presetEntry,
        resolution: savedPresetResolution,
      });
    }
  }
  return definitions;
}

export function restorePresetRouter(
  path: string,
  selections: readonly unknown[],
  preferences?: SettingsDocument,
): PresetRouter {
  return restorePresetState(path, selections, preferences).router;
}

export function restorePresetState(
  path: string,
  selections: readonly unknown[],
  preferences?: SettingsDocument,
) {
  const definitions = restorePresetDefinitions(selections);
  const overrides = new Map<string, EffortOverrides>();
  for (const [name, slots] of Object.entries(preferences?.effort ?? {})) {
    overrides.set(
      name,
      Object.fromEntries(Object.entries(slots).filter(([, value]) => value !== null)),
    );
  }
  let selected: string | undefined;
  let snapshot: PresetSnapshot | undefined;
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    const hasOverrides = Object.hasOwn(data, "effort_overrides");
    // Records without a name carry no selection (for example custom_presets
    // only); they are not enabled selections and stay skipped.
    if (
      typeof data.name !== "string" &&
      !hasOverrides &&
      !["models", "effort_defaults", "effort"].some((key) => Object.hasOwn(data, key))
    )
      continue;
    // Off is the one current selection without overrides; every enabled
    // selection must record its explicit effort overrides. Later records keep
    // their recorded order; fresh preferences seed only names not reselected.
    const effort =
      typeof data.name === "string" &&
      data.name !== "off" &&
      hasOverrides &&
      validEffortOverrides(data.effort_overrides)
        ? data.effort_overrides
        : undefined;
    if (
      typeof data.name !== "string" ||
      (data.name === "off" ? hasOverrides : effort === undefined)
    )
      throw new OrchestrationError("INVALID_SAVED_EFFORT", {
        record: presetEntry,
        resolution: savedPresetResolution,
      });
    selected = data.name;
    try {
      snapshot = decodeRecordedPreset(data);
    } catch {
      throw new OrchestrationError("INVALID_SAVED_SNAPSHOT", {
        record: presetEntry,
        resolution:
          "The recorded worker snapshot is incomplete or inconsistent. Use /new or fork from before the invalid selection. Do not rewrite historical journal records.",
      });
    }
    if (effort !== undefined) overrides.set(data.name, structuredClone(effort));
  }
  const router = new PresetRouter(
    path,
    overrides,
    { ...preferences?.presets, ...definitions },
    snapshot,
  );
  // A compact record supplies only its name/overrides. Resolve those with
  // the normal catalogue, never pretend it contained historical model IDs.
  const name = selected ?? preferences?.preset;
  if (!snapshot && name !== undefined) router.select(name);
  return { router, definitions, hasExactSelection: selected === "off" || snapshot !== undefined };
}
