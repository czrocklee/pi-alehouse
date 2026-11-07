/** Pure approval choices and restoration rules. No live session or grant state. */
import type { ApprovalPreference } from "../../shared/settings-store.mjs";
import { judgeModeRank, type JudgeMode, type JudgeName } from "./approval-protocol.ts";

/** Session record of each approval change; the last one on the branch wins. */
export const APPROVAL_ENTRY = "approval-mode:choice:v1";
export type ChoiceId = ApprovalPreference;
export type Choice = { id: ChoiceId; label: string; detail: string };

/** What the popover offers: the judge's three modes when one is loaded, and yolo. */
export function approvalChoices(judge: JudgeName | undefined): Choice[] {
  if (!judge) {
    return [
      { id: "manual", label: "manual", detail: "every ask comes to you" },
      { id: "yolo", label: "yolo", detail: "allow eligible asks, in-process subagents too" },
    ];
  }
  return [
    { id: "manual", label: "manual", detail: `${judge} observes; every ask comes to you` },
    { id: "judge", label: judge, detail: `${judge} decides main-session asks` },
    { id: "judge+sub", label: `${judge} + sub`, detail: "...and asks subagents forward" },
    { id: "yolo", label: "yolo", detail: "allow eligible asks, in-process subagents too" },
  ];
}

export const CHOICE_RANK: Record<ChoiceId, number> = {
  manual: 0,
  judge: 1,
  "judge+sub": 2,
  yolo: 3,
};
/** Rows a confirmation warning takes in the popover. */
export const CONFIRM_ROWS = 3;

/**
 * The warning a choice must be confirmed with, or undefined when it does not
 * widen what is approved without asking (narrowing, or already current).
 */
export function confirmationFor(
  id: ChoiceId,
  judge: JudgeName | undefined,
  current: ChoiceId,
): string[] | undefined {
  if (CHOICE_RANK[id] <= CHOICE_RANK[current]) return undefined;
  if (id === "yolo") {
    return [
      " Yolo auto-allows Bash/Git asks, destructive writes too.",
      " It bypasses Jev and hard checkpoints; denies, the floor",
      " and static guard stay. Choose yolo again to turn it on.",
    ];
  }
  const name = judge ?? "the judge";
  return [
    id === "judge+sub"
      ? ` ${name} may decide asks here and from subagents.`
      : ` ${name} may approve or deny this session's asks.`,
    " Denies hold; checkpoints keep eligible asks human.",
    ` Choose ${id === "judge+sub" ? `${name} + sub` : name} again to turn it on.`,
  ];
}

export function currentChoice(judge: JudgeMode | undefined, yolo: boolean): ChoiceId {
  if (yolo) return "yolo";
  if (!judge || judge.mode === "shadow") return "manual";
  return judge.includeSubagents ? "judge+sub" : "judge";
}

export const judgeModeFor = (id: Exclude<ChoiceId, "yolo">): JudgeMode =>
  id === "manual"
    ? { mode: "shadow", includeSubagents: false }
    : { mode: "enforce", includeSubagents: id === "judge+sub" };

/** What a session records about its approval choice. */
export interface RecordedChoice {
  yolo: boolean;
  /** The judge's mode, when a judge was loaded. */
  judge?: JudgeMode;
}

export const sameJudge = (a: JudgeMode | undefined, b: JudgeMode | undefined): boolean =>
  a === b || (!!a && !!b && a.mode === b.mode && a.includeSubagents === b.includeSubagents);

const readJudge = (value: unknown): JudgeMode | undefined => {
  const mode = value as Partial<JudgeMode> | undefined;
  if (!mode || typeof mode !== "object" || typeof mode.includeSubagents !== "boolean")
    return undefined;
  if (mode.mode === "shadow") return { mode: "shadow", includeSubagents: false };
  return mode.mode === "enforce"
    ? { mode: "enforce", includeSubagents: mode.includeSubagents }
    : undefined;
};

/**
 * The last choice this session recorded on this branch. Only a record naming
 * this very session counts: one copied by a fork or clone from another
 * session id, or a malformed one, means nothing was recorded.
 *
 * A record is a request, never authority: resuming offers yolo back behind a
 * confirmation and restores a judge mode no wider than the launch default,
 * so a record planted in the session file can at most ask or narrow.
 */
export function restoredChoice(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
  sessionId: string | undefined,
): RecordedChoice | undefined {
  if (!sessionId) return undefined;
  const last = entries
    .filter((entry) => entry.type === "custom" && entry.customType === APPROVAL_ENTRY)
    .at(-1);
  const record = last?.data as { sessionId?: unknown; yolo?: unknown; judge?: unknown } | undefined;
  if (!record || record.sessionId !== sessionId || typeof record.yolo !== "boolean")
    return undefined;
  const judge = readJudge(record.judge);
  return judge ? { yolo: record.yolo, judge } : { yolo: record.yolo };
}

/** The narrower of two judge modes. */
export function narrowerJudge(a: JudgeMode, b: JudgeMode): JudgeMode {
  return judgeModeRank(a) <= judgeModeRank(b) ? a : b;
}

export const YOLO_WARNING =
  "Approval: YOLO. Eligible permission asks in this session and its in-process subagents are allowed " +
  "without review, worker Bash commands included. Normal Git mutations are auto-allowed the same way: a subagent may " +
  "commit, push (force included) or reset --hard, and a yolo allow is not re-reviewed by Jev or held at a hard " +
  "checkpoint. Existing configured allows also bypass those checkpoints; explicit denies, the fail-closed " +
  "floor and the static safety guard still apply. Opaque programs can " +
  "still write files internally. Subagents outside this process keep asking.";

/** The confirmation Pi's dialog shows before a widening change. */
export function confirmDialog(
  id: ChoiceId,
  judge: JudgeName | undefined,
): { title: string; text: string } {
  if (id === "yolo") return { title: "Turn on yolo for this session?", text: YOLO_WARNING };
  const name = judge ?? "the judge";
  return id === "judge+sub"
    ? {
        title: `Let ${name} approve asks here and from subagents?`,
        text:
          `${name} may allow or deny eligible permission asks from this session and its registered in-process ` +
          "subagents without asking you. Explicit denies hold, and checkpoints keep eligible asks human (an allow your " +
          "config already grants, or yolo, never asks, so no checkpoint sees it). " +
          "This lasts for the current session.",
      }
    : {
        title: `Let ${name} approve this session's asks?`,
        text:
          `${name} may allow or deny eligible permission asks from this session without asking you; subagent asks ` +
          `are not decided by ${name}. Explicit denies hold, and checkpoints keep eligible asks human (an allow your ` +
          "config already grants, or yolo, never asks, so no checkpoint sees it). " +
          "This lasts for the current session.",
      };
}
