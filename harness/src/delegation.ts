import { HarnessError } from "./core/ports.js";
import type { PresetSelection } from "./routing.js";

/** How Main divides work with Agents, ordered by how much it hands off. */
export const delegationModes = ["manual", "co-worker", "lead", "supervisor"] as const;
export type DelegationMode = (typeof delegationModes)[number];
/** How small a piece is still worth handing off, and how many run at once. */
export const eagernessLevels = ["reserved", "balanced", "eager"] as const;
export type Eagerness = (typeof eagernessLevels)[number];

export interface DelegationSetting {
  mode: DelegationMode;
  eagerness: Eagerness;
}

export const defaultDelegation: Readonly<DelegationSetting> = Object.freeze({ mode: "co-worker", eagerness: "balanced" });

export const modeLabels: Readonly<Record<DelegationMode, string>> =
  Object.freeze({ manual: "Manual", "co-worker": "Co-worker", lead: "Lead", supervisor: "Supervisor" });

// Organization strategy only: what each tool does and accepts stays in its
// schema. Each autonomous line is one division-of-work sentence plus one
// eagerness sentence, so either axis reads the same in every combination.
const manualText = "Start or assign Agent work only when the user asks for it; when delegation would clearly help, suggest it briefly. " +
  "Answer, wait for and collect results from Agents already at work.";
const modeText: Readonly<Record<Exclude<DelegationMode, "manual">, string>> = Object.freeze({
  "co-worker": "Work alongside Agents: you and they each take parts of the task.",
  lead: "Lead the work: keep the critical path and key decisions yourself; Agents take the rest.",
  supervisor: "Supervise the work: split it into tasks for Agents, and spend your own effort on planning, " +
    "answering their questions, and reviewing and integrating their results.",
});
const eagernessText: Readonly<Record<Eagerness, string>> = Object.freeze({
  reserved: "Hand off only substantial, clearly separable work; keep small pieces, which cost more to delegate than to do.",
  balanced: "Hand off independent pieces that would take you longer to do than to explain.",
  eager: "Hand off any piece that can proceed independently of your own work, even small ones, and keep several Agents running in parallel.",
});

/** The single line agent_spawn contributes to the parent system prompt. */
export function delegationGuideline(setting: DelegationSetting): string {
  return setting.mode === "manual" ? manualText : `${modeText[setting.mode]} ${eagernessText[setting.eagerness]}`;
}

/** Whether eagerness changes anything in this mode. */
export const usesEagerness = (mode: DelegationMode): boolean => mode !== "manual";

/** Compact label: the mode, plus eagerness only when it is not the default. */
export function delegationLabel(setting: DelegationSetting): string {
  return setting.eagerness === defaultDelegation.eagerness || !usesEagerness(setting.mode)
    ? setting.mode : `${setting.mode}·${setting.eagerness}`;
}

/** Footer status: `co-worker/gpt-medium`, `lead·eager/gpt-medium*`, or `off`; never preset versions. */
export function delegationStatus(preset: PresetSelection, setting: DelegationSetting): string {
  // Type-only routing import: routing parses the configured default from here.
  if (!("models" in preset)) return "delegation: off";
  const marked = Object.keys(preset.effort_overrides).length > 0 ? "*" : "";
  return `delegation: ${delegationLabel(setting)}/${preset.name}${marked}`;
}

export function isDelegationSetting(value: unknown): value is DelegationSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { mode, eagerness } = value as Record<string, unknown>;
  return (delegationModes as readonly unknown[]).includes(mode) && (eagernessLevels as readonly unknown[]).includes(eagerness);
}

/** The active branch's last saved setting, else the configured default. The
 * caller must pass getBranch() entries of the delegation type only. */
export function restoreDelegation(saved: readonly unknown[], fallback: DelegationSetting): DelegationSetting {
  let current: DelegationSetting = { ...fallback };
  for (const entry of saved) {
    if (!isDelegationSetting(entry)) throw new HarnessError("INVALID_SAVED_DELEGATION", {
      resolution: "Repair the saved delegation mode in this session before restoring it.",
    });
    current = { mode: entry.mode, eagerness: entry.eagerness };
  }
  return current;
}

/** Parse `/harness-mode` arguments: a mode, an eagerness, or both, in any order. */
export function parseDelegation(args: string, current: DelegationSetting): DelegationSetting {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const next = { ...current };
  const seen = new Set<string>();
  for (const word of words) {
    const kind = (delegationModes as readonly string[]).includes(word) ? "mode"
      : (eagernessLevels as readonly string[]).includes(word) ? "eagerness" : undefined;
    if (!kind || seen.has(kind)) throw new HarnessError("INVALID_DELEGATION", {
      allowed_modes: [...delegationModes], allowed_eagerness: [...eagernessLevels],
      resolution: "Give a mode, an eagerness, or one of each.",
    });
    seen.add(kind);
    if (kind === "mode") next.mode = word as DelegationMode;
    else next.eagerness = word as Eagerness;
  }
  if (!words.length) throw new HarnessError("INVALID_DELEGATION", {
    allowed_modes: [...delegationModes], allowed_eagerness: [...eagernessLevels],
    resolution: "Give a mode, an eagerness, or one of each.",
  });
  return next;
}
