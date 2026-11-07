import { HarnessError } from "../core/ports.ts";
import { PresetRouter, validEffortOverrides, type EffortOverrides } from "../routing.ts";
import {
  validateSettings,
  type PresetDefinition,
  type SettingsDocument,
} from "../../../lib/settings-store.mjs";

const savedPresetResolution =
  "The saved harness:preset-selection:v1 branch record failed worker configuration validation. Effort overrides require a named non-Off preset and valid policies; custom definitions require valid preset versions and all five nested slots d1, d2, d3, d4, d5 with model and optional effort under version-2 settings rules; any per-slot thinking field is unsupported, including editor-generated empty thinking: {}. Correct configuration files explicitly, then start a fresh session or fork from before the invalid harness:preset-selection:v1 record and restart Pi. Do not rewrite historical journal records.";

/** Reconstruct only the active branch's per-preset overrides. Older selection
 * entries have no override field; they retain their original name-only meaning.
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
      throw new HarnessError("INVALID_SAVED_PRESETS", {
        record: "harness:preset-selection:v1",
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
  const historical = new Set<string>();
  let selected: string | undefined;
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    if (typeof data.name === "string") {
      selected = data.name;
      // Preferences seed fresh choices only. A historical name-only record
      // keeps its original catalogue-default meaning, not today's global pins.
      if (!historical.has(data.name)) {
        overrides.delete(data.name);
        historical.add(data.name);
      }
    }
    if (!Object.hasOwn(data, "effort_overrides")) continue;
    if (
      typeof data.name !== "string" ||
      data.name === "off" ||
      !validEffortOverrides(data.effort_overrides)
    )
      throw new HarnessError("INVALID_SAVED_EFFORT", {
        record: "harness:preset-selection:v1",
        resolution: savedPresetResolution,
      });
    overrides.set(data.name, structuredClone(data.effort_overrides));
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
