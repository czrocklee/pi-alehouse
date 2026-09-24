/**
 * Approval-mode protocol between the footer's approval indicator
 * (approval-mode.ts) and the model judges (jev, Luna).
 *
 * A shared helper, not an extension: the judges are deployed as loose files
 * beside this one, and the indicator bundles it. Keep it free of SDK imports.
 *
 * The judges keep sole ownership of their mode. They publish every change on
 * the session bus and accept a requested change on it; the indicator only
 * renders and asks. Session yolo is not a judge mode: it lives in the managed
 * permission authority, which reads SESSION_YOLO_KEY (see
 * permission-system/managed-session-yolo.ts) and never consults a judge.
 */

/** A judge's current mode, published on session start and after each change. */
export const APPROVAL_JUDGE_STATE_EVENT = "approval:judge-state";
/** A request for the judge to change mode, as its own command would. */
export const APPROVAL_SET_JUDGE_EVENT = "approval:set-judge";
/**
 * Process-global set of session ids whose permission asks are auto-allowed.
 * The managed authority reads it for the session and every in-process
 * ancestor, so a parent's yolo covers the subagents it spawned. The literal
 * is duplicated there; a check asserts the two agree.
 */
export const SESSION_YOLO_KEY = Symbol.for("@rocklee/managed-permissions:session-yolo");

export type JudgeName = "jev" | "luna";

export interface JudgeMode {
  mode: "shadow" | "enforce";
  includeSubagents: boolean;
}

/** `shown` is set synchronously by an indicator that renders this state; a
 * judge nobody claims keeps painting its own footer status. `sessionId` is the
 * session the mode belongs to, so a listener loaded before or after the judge
 * can tell a new session's launch mode from a stale one. */
export interface JudgeState extends JudgeMode {
  readonly judge: JudgeName;
  readonly sessionId?: string;
  shown: boolean;
}

/** `applied` is set synchronously by the judge that took the change. The
 * requester has already confirmed any change that widens what the judge may
 * approve; the judge applies it as its own command would after confirming. */
export interface SetJudgeMode extends JudgeMode {
  applied: boolean;
}

/** Publish a judge's mode; returns whether an indicator claimed rendering it. */
export function publishJudgeState(
  events: { emit(channel: string, data: unknown): void },
  judge: JudgeName,
  mode: JudgeMode,
  sessionId: string | undefined,
): boolean {
  const state: JudgeState = { judge, mode: mode.mode, includeSubagents: mode.includeSubagents,
    ...(sessionId ? { sessionId } : {}), shown: false };
  events.emit(APPROVAL_JUDGE_STATE_EVENT, state);
  return state.shown;
}

/** How much a mode lets the judge approve on its own: manual < root < root+subagents. */
export function judgeModeRank(mode: JudgeMode): number {
  return mode.mode === "shadow" ? 0 : mode.includeSubagents ? 2 : 1;
}

/** A well-formed mode request, or undefined for anything else on the channel. */
export function readSetJudgeMode(data: unknown): SetJudgeMode | undefined {
  const request = data as Partial<SetJudgeMode> | null | undefined;
  if (!request || typeof request !== "object") return undefined;
  if (request.mode !== "shadow" && request.mode !== "enforce") return undefined;
  if (typeof request.includeSubagents !== "boolean") return undefined;
  // Shadow never covers subagents; refuse a contradictory request outright.
  if (request.mode === "shadow" && request.includeSubagents) return undefined;
  return request as SetJudgeMode;
}

/** The process-global session-yolo set, created on first use. */
export function sessionYoloSet(): Set<string> {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[SESSION_YOLO_KEY];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  globals[SESSION_YOLO_KEY] = created;
  return created;
}
