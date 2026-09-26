import type { WaitResult } from "../core/owner-controller.js";
import { terminal, validDifficulty, type AgentSummary, type ResultPage, type RunView } from "../core/contracts.js";
import { HarnessError } from "../core/ports.js";

const runtimeReply = (view: RunView) => {
  const runtime = view.runtime;
  // The controller retains its last observation for diagnostics. It is not
  // live activity once execution exits, even while history is still finishing.
  if (!runtime || view.execution_exited || terminal(view.status)) return undefined;
  const usage = view.usage ?? runtime.usage;
  return { activity: runtime.activity, ...(runtime.context ? { context: runtime.context } : {}),
    ...(usage ? { usage: { observed_cost: usage.total.cost,
      partial: usage.partial.includes("cost") } } : {}) };
};
/** Only what the caller chose. Preset, slot, model and effort are routing
 * details for the user's UI and journal; exposing them invites score tuning. */
const callerSettings = (settings: RunView["effective_settings"]) =>
  ({ profile: settings.profile, difficulty: settings.difficulty });
/** Model replies, not another state store. Full RunView stays host-only. */
export function runReply(view: RunView, showSettings = false) {
  const { run_id, agent_id, name, resumable, effective_settings: settings } = view;
  const model_stop_reason = view.model_stop_reason ?? view.outcome?.model_stop_reason;
  const runtime = runtimeReply(view);
  return { run_id, agent_id, ...(name ? { name } : {}), status: view.finalization_pending ? "finishing" : view.status, resumable,
    max_duration_ms: view.max_duration_ms,
    ...(view.execution_elapsed_ms === undefined ? {} : { execution_elapsed_ms: Math.round(view.execution_elapsed_ms) }),
    ...(runtime ? { runtime } : {}),
    ...(!view.execution_exited && !terminal(view.status) && view.drain ? {
      drain: { ...view.drain, elapsed_ms: Math.round(view.drain.elapsed_ms) } } : {}),
    // Qualifies `status`: a turn-capped Run still settles as "completed", and
    // without this the model reads a cut-off answer as a finished one.
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(model_stop_reason ? { model_stop_reason } : {}),
    ...(view.outcome?.question ? { has_question: true } : {}),
    ...(view.outcome?.error ? { error: utf16Prefix(view.outcome.error, 512) } : {}),
    ...(view.owner_error ? { owner_error: utf16Prefix(view.owner_error, 512) } : {}),
    ...(view.notification_drops ? { notification_drops: view.notification_drops } : {}),
    ...(view.pending_messages ? { pending_messages: view.pending_messages } : {}),
    ...((view.owner_blocked || (terminal(view.status) && !resumable)) ? { unavailable_reason: view.unavailable_reason } : {}),
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    ...(view.blocked_by?.length ? { blocked_by: view.blocked_by } : {}),
    ...(showSettings ? { settings: callerSettings(settings) } : {}) };
}
/** Caller-supplied task labels belong only in the on-demand roster, not every
 * receipt/result or an automatically injected context snapshot. */
export function listRunReply(view: RunView, summary?: AgentSummary) {
  const description = utf16Prefix(view.description, 256);
  return { ...runReply(view, true), description, description_truncated: description.length < view.description.length,
    ...(summary ? agentHistoryReply(summary) : {}) };
}
const EARLIER_TASKS_SHOWN = 4;
const TOUCHED_SHOWN = 8;
/** What the parent needs to choose resume versus a fresh Agent: what this
 * Agent already worked on, how full its context is, what it has cost and which
 * files it changed. Model, preset and effort stay hidden, as in callerSettings. */
function agentHistoryReply(summary: AgentSummary) {
  const earlier = summary.earlier_descriptions.slice(0, EARLIER_TASKS_SHOWN).map((text) => utf16Prefix(text, 120));
  const context = summary.context;
  const touched = summary.touched.slice(0, TOUCHED_SHOWN).map((path) => utf16Prefix(path, 160));
  const touchedOmitted = summary.touched.length - touched.length + summary.touched_omitted;
  return { runs: summary.runs,
    ...(earlier.length ? { earlier_tasks: earlier } : {}),
    ...(summary.earlier_descriptions.length > earlier.length ? { earlier_tasks_omitted: summary.earlier_descriptions.length - earlier.length } : {}),
    ...(context ? { context: { tokens: context.tokens, window: context.context_window,
      ...(context.tokens === null ? {} : { percent: Math.round(context.tokens / context.context_window * 100) }) } } : {}),
    observed_cost: Math.round(summary.observed_cost * 10000) / 10000,
    ...(summary.cost_partial ? { cost_partial: true } : {}),
    ...(touched.length ? { touched } : {}),
    ...(touchedOmitted ? { touched_omitted: touchedOmitted } : {}),
    ...(summary.pending_updates ? { pending_updates: summary.pending_updates } : {}),
    ...(summary.idle_ms === undefined ? {} : { idle_ms: Math.round(summary.idle_ms) }) };
}
/** One line per Run that settled since the parent's previous harness reply. */
export function changeReply(view: RunView) {
  return { run_id: view.run_id, agent_id: view.agent_id, ...(view.name ? { name: view.name } : {}),
    status: view.finalization_pending ? "finishing" : view.status,
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(view.outcome?.question ? { has_question: true } : {}) };
}
/** Identity and lifecycle only; optional names/settings/diagnostics cannot defeat
 * the final envelope bound, including outside a combined reply's wait object. */
export function compactRunReply(view: RunView) {
  const model_stop_reason = view.model_stop_reason ?? view.outcome?.model_stop_reason;
  return { run_id: view.run_id, agent_id: view.agent_id,
    status: view.finalization_pending ? "finishing" : view.status, resumable: view.resumable,
    max_duration_ms: view.max_duration_ms,
    ...(view.execution_elapsed_ms === undefined ? {} : { execution_elapsed_ms: Math.round(view.execution_elapsed_ms) }),
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(model_stop_reason ? { model_stop_reason } : {}),
    ...(view.outcome?.question ? { has_question: true } : {}),
    ...(view.pending_messages ? { pending_messages: view.pending_messages } : {}),
    ...(view.notification_drops ? { notification_drops: view.notification_drops } : {}),
    ...((view.outcome?.error || view.owner_error || view.outcome?.reason || view.drain) ? { diagnostic_omitted: true } : {}) };
}
const resultFields = (page: ResultPage) => ({ text: page.text, complete: page.complete, omitted_chars: page.total_chars - page.retained_chars,
  ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) });
export function resultReply(page: ResultPage) {
  return { ...runReply(page.snapshot), ...(page.snapshot.outcome?.question ? {
    question: page.snapshot.outcome.question, question_complete: true, question_omitted_chars: 0,
  } : {}), ...resultFields(page) };
}

export const WAIT_TEXT_BUDGET = 16384;
export const WAIT_RUN_TEXT_BUDGET = 4096;
export const WAIT_PROGRESS_TEXT_BUDGET = 2048;
/** UTF-8 ceiling for the projection's serialized content envelope, including
 * receipt wrappers and both JSON layers; excludes subsequently attached usage
 * and SDK metadata outside model content. */
export const WAIT_SERIALIZED_REPLY_LIMIT = 65536;
const utf16Prefix = (text: string, limit: number): string => {
  let end = Math.min(text.length, Math.max(0, limit));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(0, end);
};
export const waitEnvelopeBytes = (value: unknown): number => {
  const body = JSON.stringify(value);
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: body }] }), "utf8");
};
type ResultReader = (run_id: string, limit: number) => ResultPage;
export interface WaitProjectionHeader { reason: WaitResult["reason"]; metadata_compacted?: true }
type WaitWrapper = (reply: WaitProjectionHeader) => unknown;

/** A bounded model-facing projection. Complete questions come first, actual
 * terminal results second, and coalesced progress uses only what remains. The
 * wrapper lets submit/resume include their top-level accepted identity in the
 * same hard-envelope calculation. */
export function waitReply(value: WaitResult, readResult?: ResultReader, wrap: WaitWrapper = (reply) => reply) {
  const savedPages = new Map(value.results?.map((page) => [page.snapshot.run_id, page]));
  const terminalViews = value.snapshots.filter((view) => terminal(view.status));
  const pending_run_ids = value.snapshots.filter((view) => !terminal(view.status)).map((view) => view.run_id);
  const build = (textBudget: number) => {
    let remaining = textBudget;
    const runs = value.snapshots.map((view) => ({ ...runReply(view) }));
    const byRun = new Map(value.snapshots.map((view, index) => [view.run_id, runs[index]!]));

    const questions = terminalViews.filter((view) => !!view.outcome?.question);
    // Whole questions are actionable; partial prefixes require another get.
    // In input order, admit every whole question that fits before sharing any
    // leftover budget between the others. A large question cannot crowd out a
    // later short one, and an overfull batch need not make every question partial.
    const deferredQuestions: RunView[] = [];
    const showQuestion = (view: RunView, shown: string) => {
      const question = view.outcome!.question!;
      Object.assign(byRun.get(view.run_id)!, { question: shown, question_complete: shown.length === question.length,
        question_omitted_chars: question.length - shown.length,
        ...(shown.length < question.length ? { question_requires_get: true } : {}) });
      remaining -= shown.length;
    };
    for (const view of questions) {
      const question = view.outcome!.question!;
      if (question.length <= remaining) showQuestion(view, question);
      else deferredQuestions.push(view);
    }
    for (let index = 0; index < deferredQuestions.length; index++) {
      const view = deferredQuestions[index]!;
      showQuestion(view, utf16Prefix(view.outcome!.question!, Math.floor(remaining / (deferredQuestions.length - index))));
    }

    const resultsFit = terminalViews.reduce((sum, view) =>
      sum + Math.min(WAIT_RUN_TEXT_BUDGET, view.result_ref?.chars ?? savedPages.get(view.run_id)?.text.length ?? 0), 0) <= remaining;
    for (let index = 0; index < terminalViews.length; index++) {
      const view = terminalViews[index]!, reply = byRun.get(view.run_id)!;
      const quota = resultsFit ? WAIT_RUN_TEXT_BUDGET : Math.min(WAIT_RUN_TEXT_BUDGET, Math.floor(remaining / (terminalViews.length - index)));
      let page = quota > 0 ? (readResult ? readResult(view.run_id, quota) : savedPages.get(view.run_id)) : undefined;
      if (page && page.text.length > quota && readResult && quota > 1) page = readResult(view.run_id, quota - 1);
      if (page && page.text.length <= quota) {
        Object.assign(reply, resultFields(page));
        remaining -= page.text.length;
      } else if ((view.result_ref?.total_chars ?? 0) > 0) {
        Object.assign(reply, { result_available: true, result_requires_get: true });
      }
    }

    const claimed = value.progress ?? [];
    const selected: typeof claimed = [];
    const perRun = new Map<string, number>();
    // Keep at most the latest two per Run and sixteen total. Everything was
    // claimed atomically; omitted/coalesced counts make the lossy summary clear.
    for (let index = claimed.length - 1; index >= 0 && selected.length < 16; index--) {
      const event = claimed[index]!, count = perRun.get(event.run_id) ?? 0;
      if (count >= 2) continue;
      perRun.set(event.run_id, count + 1); selected.push(event);
    }
    selected.reverse();
    let progressRemaining = Math.min(remaining, WAIT_PROGRESS_TEXT_BUDGET);
    const progress = [];
    for (let index = 0; index < selected.length && progressRemaining > 0; index++) {
      const event = selected[index]!, quota = Math.min(512, Math.floor(progressRemaining / (selected.length - index)));
      const text = utf16Prefix(event.text, quota);
      if (!text.length) continue;
      progress.push({ event_id: event.event_id, run_id: event.run_id, text,
        complete: text.length === event.text.length, omitted_chars: event.text.length - text.length });
      progressRemaining -= text.length; remaining -= text.length;
    }
    const pendingProgress = value.snapshots.reduce((sum, view) => sum + view.pending_messages, 0);
    return { reason: value.reason, runs,
      ...(pending_run_ids.length ? { pending_run_ids } : {}),
      ...(progress.length ? { progress } : {}),
      ...(claimed.length ? { progress_claimed: claimed.length } : {}),
      ...(claimed.length > progress.length ? { progress_omitted: claimed.length - progress.length } : {}),
      ...(pendingProgress ? { progress_remaining: pendingProgress } : {}) };
  };
  const fits = (reply: WaitProjectionHeader) => waitEnvelopeBytes(wrap(reply)) <= WAIT_SERIALIZED_REPLY_LIMIT;
  const reply = build(WAIT_TEXT_BUDGET);
  if (fits(reply)) return reply;
  // Measure UTF-8 after both JSON escaping layers. The marker itself is inside
  // every measured restricted candidate, so adding it cannot cross the bound.
  // Complete-first allocation can change which questions fit at a threshold:
  // this finds a measured safe candidate, not a globally optimal byte packing.
  let low = 0, high = WAIT_TEXT_BUDGET - 1;
  let best: ReturnType<typeof build> | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...build(middle), response_limit_reached: true };
    if (fits(candidate)) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  if (best) return best;
  // Diagnostics and names are optional metadata. This compact fallback keeps
  // every lifecycle fact that affects orchestration and explicitly requires a
  // get whenever question/result text was omitted.
  const compact = { reason: value.reason, metadata_compacted: true as const,
    runs: value.snapshots.map((view) => ({ ...compactRunReply(view),
      ...(view.outcome?.question ? { question_complete: false, question_requires_get: true } : {}),
      ...((view.result_ref?.total_chars ?? 0) > 0 ? { result_available: true, result_requires_get: true } : {}) })),
    ...(pending_run_ids.length ? { pending_run_ids } : {}),
    ...(value.progress?.length ? { progress_claimed: value.progress.length, progress_omitted: value.progress.length } : {}),
    ...(value.snapshots.some((view) => view.pending_messages) ? {
      progress_remaining: value.snapshots.reduce((sum, view) => sum + view.pending_messages, 0) } : {}),
    response_limit_reached: true };
  // The wrapper must also compact optional outer metadata. Never return an
  // unmeasured fallback; malformed host wrappers fail closed. A singleton's
  // accepted identity is retained in the error as well as in normal replies.
  if (!fits(compact)) throw new HarnessError("WAIT_REPLY_TOO_LARGE", value.snapshots.length === 1 ? {
    run_id: value.snapshots[0]!.run_id, agent_id: value.snapshots[0]!.agent_id } : {});
  return compact;
}
const ALLOWED_SHOWN = 32;
/**
 * A silently cut list reads as the whole set of legal choices, so a model that
 * picks from it cannot tell it was handed a prefix. Report the remainder.
 */
const allowedFields = (raw: unknown) => {
  if (!Array.isArray(raw)) return {};
  const all = raw.filter((value): value is string => typeof value === "string");
  const allowed = all.slice(0, ALLOWED_SHOWN).map((value) => utf16Prefix(value, 128));
  return { allowed, ...(all.length > allowed.length ? { allowed_omitted: all.length - allowed.length } : {}) };
};
export function errorReply(error: { code?: string; details?: Record<string, unknown> }) {
  const settings = error.details?.effective_settings as RunView["effective_settings"] | undefined;
  return { error: { code: error.code ?? "TOOL_ERROR",
    ...(typeof error.details?.key === "string" ? { parameter: error.details.key } : {}),
    ...(typeof error.details?.run_id === "string" ? { run_id: error.details.run_id } : {}),
    ...(typeof error.details?.agent_id === "string" ? { agent_id: error.details.agent_id } : {}),
    ...(typeof error.details?.reason === "string" ? { reason: utf16Prefix(error.details.reason, 512) } : {}),
    ...(typeof error.details?.error === "string" ? { message: utf16Prefix(error.details.error, 512) } : {}),
    ...(typeof error.details?.resolution === "string" ? { resolution: utf16Prefix(error.details.resolution, 512) } : {}),
    ...(typeof error.details?.requested === "string" ? { requested: utf16Prefix(error.details.requested, 128) } : {}),
    ...(validDifficulty(error.details?.difficulty) ? { difficulty: error.details.difficulty } : {}),
    ...allowedFields(error.details?.allowed),
    ...(typeof error.details?.parent_thinking === "string" ? { parent_thinking: utf16Prefix(error.details.parent_thinking, 32) } : {}),
    ...(settings ? { settings: callerSettings(settings) } : {}) } };
}
