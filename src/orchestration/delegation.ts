import { OrchestrationError } from "./core/ports.ts";
import type { PresetSelection } from "./routing.ts";

/** How Main divides work with Agents, ordered by how much it hands off. */
export const delegationModes = ["manual", "co-worker", "lead", "supervisor"] as const;
export type DelegationMode = (typeof delegationModes)[number];
/** How small a piece is still worth handing off in Co-worker and Lead, and how many run at once. */
export const eagernessLevels = ["reserved", "balanced", "eager"] as const;
export type Eagerness = (typeof eagernessLevels)[number];

export interface DelegationSetting {
  mode: DelegationMode;
  eagerness: Eagerness;
}

export const defaultDelegation: Readonly<DelegationSetting> = Object.freeze({
  mode: "co-worker",
  eagerness: "balanced",
});

export const modeLabels: Readonly<Record<DelegationMode, string>> = Object.freeze({
  manual: "Manual",
  "co-worker": "Co-worker",
  lead: "Lead",
  supervisor: "Supervisor",
});

// Organization strategy only: what each tool does and accepts stays in its
// schema. Manual and Supervisor fix their handoff boundaries; Co-worker and
// Lead combine a division-of-work sentence with an eagerness threshold, and all
// three autonomous modes append the fixed web-routing sentence.
const manualText =
  "Start or assign Agent work only when the user asks for it; when delegation would clearly help, suggest it briefly. " +
  "Answer questions from Agents already at work, and wait for and collect their results.";
const hybridModeText: Readonly<Record<"co-worker" | "lead", string>> = Object.freeze({
  "co-worker":
    "Work alongside Agents: take your own disjoint share of the task in parallel while they do theirs.",
  lead: "Lead the work: own key decisions and core hands-on work; delegate separable diagnosis, implementation, verification and review.",
});
const supervisorText =
  "Supervise the work: delegate diagnosis, design, implementation, verification and review rather than doing them yourself. " +
  "When scope is unclear, delegate discovery first; run independent tasks in parallel, answer Agents' questions, close gaps with follow-up tasks, and synthesize results.";
const eagernessText: Readonly<Record<Eagerness, string>> = Object.freeze({
  reserved:
    "Hand off only substantial, clearly separable work; keep small pieces, which cost more to delegate than to do.",
  balanced: "Hand off independent pieces that would take you longer to do than to explain.",
  eager:
    "Hand off any separable piece that can proceed independently of your own work, even small ones, and keep several Agents running in parallel.",
});
/** Whatever the eagerness: the parent's web tools are hidden in these modes. */
export const autonomousWebText =
  "Scouts do all web research, even small lookups; do not fetch pages through Bash.";

/** The single line agent_spawn contributes to the parent system prompt. */
export function delegationGuideline(setting: DelegationSetting): string {
  if (setting.mode === "manual") return manualText;
  if (setting.mode === "supervisor") return `${supervisorText} ${autonomousWebText}`;
  return `${hybridModeText[setting.mode]} ${eagernessText[setting.eagerness]} ${autonomousWebText}`;
}

/** Whether eagerness changes anything in this mode. */
export const usesEagerness = (mode: DelegationMode): boolean =>
  mode === "co-worker" || mode === "lead";

/** Compact label: the mode, plus eagerness only when it is not the default. */
export function delegationLabel(setting: DelegationSetting): string {
  return setting.eagerness === defaultDelegation.eagerness || !usesEagerness(setting.mode)
    ? setting.mode
    : `${setting.mode}·${setting.eagerness}`;
}

/** Footer status: `co-worker/gpt-medium`, `lead·eager/gpt-medium*`, or `off`; never preset versions. */
export function delegationStatus(preset: PresetSelection, setting: DelegationSetting): string {
  // Type-only routing import: routing parses the configured default from here.
  if (!("models" in preset)) return "delegation: off";
  const marked = Object.keys(preset.effort_overrides).length > 0 ? "*" : "";
  return `delegation: ${delegationLabel(setting)}/${preset.name}${marked}`;
}

/** `/alehouse-mode` notice: notes when an explicit eagerness is stored for Co-worker/Lead. */
export function delegationCommandNotice(
  args: string,
  setting: DelegationSetting,
  changed: boolean,
): string {
  const namedEagerness = args
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some((word) => (eagernessLevels as readonly string[]).includes(word));
  if (usesEagerness(setting.mode) || !namedEagerness)
    return `Delegation: ${delegationLabel(setting)}${changed ? "" : " (unchanged)"}`;
  const note = `${setting.eagerness} saved for Co-worker/Lead`;
  return `Delegation: ${delegationLabel(setting)} (${changed ? note : `unchanged; ${note}`})`;
}

export function isDelegationSetting(value: unknown): value is DelegationSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { mode, eagerness } = value as Record<string, unknown>;
  return (
    (delegationModes as readonly unknown[]).includes(mode) &&
    (eagernessLevels as readonly unknown[]).includes(eagerness)
  );
}

/** The active branch's last saved setting, else the configured default. The
 * caller must pass getBranch() entries of the delegation type only. */
export function restoreDelegation(
  saved: readonly unknown[],
  fallback: DelegationSetting,
): DelegationSetting {
  let current: DelegationSetting = { ...fallback };
  for (const entry of saved) {
    if (!isDelegationSetting(entry))
      throw new OrchestrationError("INVALID_SAVED_DELEGATION", {
        resolution: "Repair the saved delegation mode in this session before restoring it.",
      });
    current = { mode: entry.mode, eagerness: entry.eagerness };
  }
  return current;
}

/** Parse `/alehouse-mode` arguments: a mode, an eagerness, or both, in any order. */
export function parseDelegation(args: string, current: DelegationSetting): DelegationSetting {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const next = { ...current };
  const seen = new Set<string>();
  for (const word of words) {
    const kind = (delegationModes as readonly string[]).includes(word)
      ? "mode"
      : (eagernessLevels as readonly string[]).includes(word)
        ? "eagerness"
        : undefined;
    if (!kind || seen.has(kind))
      throw new OrchestrationError("INVALID_DELEGATION", {
        allowed_modes: [...delegationModes],
        allowed_eagerness: [...eagernessLevels],
        resolution: "Give a mode, an eagerness, or one of each.",
      });
    seen.add(kind);
    if (kind === "mode") next.mode = word as DelegationMode;
    else next.eagerness = word as Eagerness;
  }
  if (!words.length)
    throw new OrchestrationError("INVALID_DELEGATION", {
      allowed_modes: [...delegationModes],
      allowed_eagerness: [...eagernessLevels],
      resolution: "Give a mode, an eagerness, or one of each.",
    });
  return next;
}
