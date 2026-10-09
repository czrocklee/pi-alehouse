import { terminal, validDifficulty, type AgentSummary, type RunView } from "../core/contracts.js";
import { modelTaskStatus } from "../core/communication-envelope.js";

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

/** Independent interrupt/roster projection. Communication observations are
 * projected and serialized in core before their presentation commit. */
export function taskReply(view: RunView, nameOf: NameOf) {
  const unavailable = view.owner_blocked || (terminal(view.status) && !view.resumable) ||
    !!(view.unavailable_reason && view.unavailable_reason !== "agent_busy");
  return { agent: view.name, task: view.task, status: statusOf(view),
    ...(view.has_question ? { has_question: true } : {}),
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    // Qualifies `status`: a turn-capped task still settles as "completed".
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(view.time_wrapped || view.outcome?.time_wrapped ? { time_wrapped: true } : {}),
    ...(view.dispatch_notes?.length ? { dispatch_notes: [...view.dispatch_notes] } : {}),
    ...(view.outcome?.error ? { error: utf16Prefix(view.outcome.error, 512) } : {}),
    ...(view.owner_error ? { owner_error: utf16Prefix(view.owner_error, 512) } : {}),
    ...(view.blocked_by?.length ? { waiting_for: view.blocked_by.map(nameOf) } : {}),
    ...(unavailable ? { unavailable: true } : {}),
    ...(unavailable && view.unavailable_reason ? { unavailable_reason: utf16Prefix(view.unavailable_reason, 512) } : {}) };
}

const EARLIER_SHOWN = 4;
const TOUCHED_SHOWN = 8;
/** A roster row: what the parent needs to choose between reusing this Agent
 * and creating another. Model, preset and effort stay hidden: exposing them
 * invites tuning difficulty to pick a model. */
export function agentRow(view: RunView, summary: AgentSummary, nameOf: NameOf) {
  const earlier = summary.earlier_descriptions.slice(0, EARLIER_SHOWN).map((text) => utf16Prefix(text, 120));
  const context = summary.context;
  const touched = summary.touched.slice(0, TOUCHED_SHOWN).map((path) => utf16Prefix(path, 160));
  const touchedOmitted = summary.touched.length - touched.length + summary.touched_omitted;
  const running = view.status === "running" && !view.execution_exited;
  const { agent, ...task } = taskReply(view, nameOf);
  return { agent, profile: view.effective_settings.profile, reasoning_difficulty: view.effective_settings.difficulty,
    label: utf16Prefix(view.description, 120), ...task,
    ...(running && view.execution_elapsed_ms !== undefined ? { elapsed_s: Math.round(view.execution_elapsed_ms / 1000) } : {}),
    tasks: summary.runs,
    ...(earlier.length ? { earlier_labels: earlier } : {}),
    // Absolute size, not a share of the window: a large window makes a costly
    // conversation look small, and every turn of the next task re-reads all of it.
    ...(context && context.tokens !== null ? { context_tokens: context.tokens } : {}),
    cost_usd: Math.round(summary.observed_cost * 1000) / 1000,
    // Observed spend only: some responses reported no cost.
    ...(summary.cost_partial ? { cost_partial: true } : {}),
    ...(touched.length ? { touched } : {}),
    ...(touchedOmitted ? { touched_omitted: touchedOmitted } : {}),
    ...(summary.idle_ms === undefined ? {} : { idle_s: Math.round(summary.idle_ms / 1000) }) };
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
    ...(typeof d.reason === "string" ? { reason: utf16Prefix(d.reason, 512) } : {}),
    ...(typeof d.error === "string" ? { message: utf16Prefix(d.error, 512) } : {}),
    ...(typeof d.resolution === "string" ? { resolution: utf16Prefix(d.resolution, 512) } : {}),
    ...(typeof d.requested === "string" ? { requested: utf16Prefix(d.requested, 128) } : {}),
    ...(validDifficulty(d.difficulty) ? { reasoning_difficulty: d.difficulty } : {}),
    ...allowedFields(d.allowed),
    ...(typeof d.parent_thinking === "string" ? { parent_thinking: utf16Prefix(d.parent_thinking, 32) } : {}) } };
}
