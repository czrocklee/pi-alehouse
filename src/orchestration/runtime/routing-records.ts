import type { PresetDefinition } from "../../shared/settings-store.mjs";
import type { DelegationSetting } from "../delegation.ts";
import type { PresetSelection } from "../routing.ts";

export const presetEntry = "alehouse:preset-selection:v1";
export const delegationEntry = "alehouse:delegation-mode:v1";

/** Used for initial choices, explicit selections and /clear. The full selected
 * route is independent of custom_presets, which contains actual branch edits. */
export function selectionRecord(
  selection: PresetSelection,
  definitions?: Readonly<Record<string, PresetDefinition>>,
) {
  return {
    ...selection,
    selected_at: Date.now(),
    ...(definitions && Object.keys(definitions).length
      ? { custom_presets: structuredClone(definitions) }
      : {}),
  };
}

export function delegationRecord({ mode, eagerness }: DelegationSetting) {
  return { mode, eagerness, selected_at: Date.now() };
}
