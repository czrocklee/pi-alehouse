import { terminal, validDifficulty, type RunView } from "../core/contracts.ts";
import { isQueueWait, modelDispatchNotes, modelTaskStatus, type QueueWait } from "../core/communication-envelope.ts";
import { profileLabel } from "./tool-names.ts";
import { taskMetadata } from "../core/task-metadata.ts";

// Model-facing projections. The model addresses Agents by name and calls each
// assignment a task; Run and Agent IDs, routing and diagnostics stay host-only.

export const utf16Prefix = (text: string, limit: number): string => {
  let end = Math.min(text.length, Math.max(0, limit));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(0, end);
};
/** Agent name of a Run; blocked_by and error details carry Run IDs. */
export type NameOf = (run_id: string) => string;

// The parent's verb is interrupt, so its statuses say so.
const statusOf = (view: RunView) => view.finalization_pending ? "finishing" :
  modelTaskStatus(view.status);
/** Host RunView.queued_for, renamed. Only a queued projection may carry it, and
 * only the two enum values: a provider id or count is omitted, never copied. */
const queueWait = (view: RunView): QueueWait | undefined => {
  if (statusOf(view) !== "queued") return undefined;
  return isQueueWait(view.queued_for) ? view.queued_for : undefined;
};

/** Independent interrupt/roster projection. Only roster inspection opts in to
 * task-local workspace/pending facts; the RunView supplies original status/exit.
 * Communication observations serialize in core before presentation commit. */
export function taskReply(view: RunView, nameOf: NameOf, inspectWorkspace = false) {
  const unavailable = view.owner_blocked || (terminal(view.status) && !view.resumable) ||
    !!(view.unavailable_reason && view.unavailable_reason !== "agent_busy");
  const dispatch_notes = modelDispatchNotes(view.dispatch_notes);
  const wait = queueWait(view);
  return { agent: view.name, task: view.task, status: statusOf(view), ...taskMetadata(view, inspectWorkspace),
    ...(wait === undefined ? {} : { wait }),
    ...(view.has_question ? { has_question: true } : {}),
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    ...(view.cancellation_source === "human" || view.outcome?.cancellation_source === "human" ? { cancellation_source: "human" as const } : {}),
    // Qualifies `status`: a turn-capped task still settles as "completed".
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(dispatch_notes ? { dispatch_notes } : {}),
    ...(view.outcome?.error ? { error: utf16Prefix(view.outcome.error, 512) } : {}),
    ...(view.owner_error ? { owner_error: utf16Prefix(view.owner_error, 512) } : {}),
    // Dependency names stay; wait is only the queued reason, not a replacement.
    ...(view.blocked_by?.length ? { waiting_for: view.blocked_by.map(nameOf) } : {}),
    ...(unavailable ? { unavailable: true } : {}),
    ...(unavailable && view.unavailable_reason ? { unavailable_reason: utf16Prefix(view.unavailable_reason, 512) } : {}) };
}

/** Current identity, capability and work location; history/usage stay in the UI. */
export function agentRow(view: RunView, nameOf: NameOf) {
  return { profile: profileLabel(view.effective_settings.profile), reasoning_difficulty: view.effective_settings.difficulty,
    ...taskReply(view, nameOf, true) };
}

const ALLOWED_SHOWN = 32;
/** A silently cut list reads as the whole set of legal choices. */
const allowedFields = (raw: unknown) => {
  if (!Array.isArray(raw)) return {};
  const all = raw.filter((value): value is string => typeof value === "string");
  if (!all.length) return {};
  const allowed = all.slice(0, ALLOWED_SHOWN).map((value) => utf16Prefix(value, 128));
  return { allowed, ...(all.length > allowed.length ? { allowed_omitted: all.length - allowed.length } : {}) };
};
/** Error details carry internal IDs; the model sees Agent names. */
export interface ErrorNames { agent(agent_id: string): string | undefined; run(run_id: string): string | undefined }
export function errorReply(error: { code?: string; details?: Record<string, unknown> }, names?: ErrorNames) {
  const d = error.details ?? {};
  const safe = (lookup: () => string | undefined) => { try { return lookup(); } catch { return undefined; } };
  const agent = typeof d.agent === "string" ? d.agent :
    typeof d.agent_id === "string" ? safe(() => names?.agent(d.agent_id as string)) :
      typeof d.run_id === "string" ? safe(() => names?.run(d.run_id as string)) : undefined;
  const internalParameter = typeof d.key === "string" ? d.key : typeof d.parameter === "string" ? d.parameter : undefined;
  // The caller vocabulary is separate from admitted settings and journal keys.
  const parameter = internalParameter === "difficulty" ? "reasoning_difficulty" : internalParameter;
  const dispatchError = error.code === "INVALID_DISPATCH" || error.code?.startsWith("DISPATCH_") ||
    ["PREFLIGHT_DENIED", "RESOURCE_OWNED", "BUILD_TREE_BUSY"].includes(error.code ?? "");
  // Keep abstract requested choices at their existing 128-unit cap. Dispatch
  // failures additionally show the concrete declaration/normalized path, with
  // a 512-unit prefix (whole legal raw declarations, bounded resolved paths).
  const path = dispatchError && typeof d.requested === "string" ? d.requested : typeof d.path === "string" ? d.path : undefined;
  return { error: { code: error.code ?? "TOOL_ERROR",
    ...(agent ? { agent: utf16Prefix(agent, 64) } : {}),
    ...(parameter === undefined ? {} : { parameter }),
    ...(path === undefined ? {} : { path: utf16Prefix(path, 512) }),
    // Dispatch failures additionally show which permission surface was checked
    // and for which target profile, bounded; filesystem missing/type errors
    // carry no surface from the runtime and gain none here.
    ...(dispatchError && typeof d.surface === "string" ? { surface: utf16Prefix(d.surface, 32) } : {}),
    ...(dispatchError && typeof d.profile === "string" ? { profile: utf16Prefix(profileLabel(d.profile), 16) } : {}),
    ...(typeof d.reason === "string" ? { reason: utf16Prefix(d.reason, 512) } : {}),
    ...(typeof d.error === "string" ? { message: utf16Prefix(d.error, 512) } : {}),
    ...(typeof d.resolution === "string" ? { resolution: utf16Prefix(d.resolution, 512) } : {}),
    ...(typeof d.requested === "string" ? { requested: utf16Prefix(d.requested, 128) } : {}),
    ...(validDifficulty(d.difficulty) ? { reasoning_difficulty: d.difficulty } : {}),
    ...allowedFields(d.allowed),
    ...(typeof d.parent_thinking === "string" ? { parent_thinking: utf16Prefix(d.parent_thinking, 32) } : {}) } };
}
