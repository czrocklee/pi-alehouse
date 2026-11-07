import { OrchestrationError } from "../core/ports.ts";
import { PresetRouter, validEffortOverrides, type EffortOverrides } from "../routing.ts";
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
        record: "alehouse:preset-selection:v1",
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
  const overrides = new Map<string, EffortOverrides>();
  for (const [name, slots] of Object.entries(preferences?.effort ?? {})) {
    overrides.set(
      name,
      Object.fromEntries(Object.entries(slots).filter(([, value]) => value !== null)),
    );
  }
  let selected: string | undefined;
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    const hasOverrides = Object.hasOwn(data, "effort_overrides");
    // Records without a name carry no selection (for example custom_presets
    // only); they are not enabled selections and stay skipped.
    if (typeof data.name !== "string" && !hasOverrides) continue;
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
        record: "alehouse:preset-selection:v1",
        resolution: savedPresetResolution,
      });
    selected = data.name;
    if (effort !== undefined) overrides.set(data.name, structuredClone(effort));
  }
  const router = new PresetRouter(path, overrides, {
    ...preferences?.presets,
    ...restorePresetDefinitions(selections),
  });
  // Fresh sessions use explicitly saved preferences, then catalogue defaults.
  // A removed saved preset is still an error, never a default fallback.
  const name = selected ?? preferences?.preset;
  if (name !== undefined) router.select(name);
  return router;
}
