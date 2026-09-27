import type { WaitResult } from "../core/owner-controller.js";
import { terminal, validDifficulty, type AgentSummary, type ResultPage, type RunView } from "../core/contracts.js";
import { HarnessError } from "../core/ports.js";

// Model-facing projections. The model addresses Agents by name and calls each
// assignment a task; Run and Agent IDs, routing and diagnostics stay host-only.

export const WAIT_TEXT_BUDGET = 16384;
export const WAIT_RUN_TEXT_BUDGET = 4096;
export const WAIT_PROGRESS_TEXT_BUDGET = 2048;
/** UTF-8 ceiling for the projection's serialized content envelope, including
 * both JSON layers; excludes subsequently attached usage and SDK metadata. */
export const WAIT_SERIALIZED_REPLY_LIMIT = 65536;

export const utf16Prefix = (text: string, limit: number): string => {
  let end = Math.min(text.length, Math.max(0, limit));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(0, end);
};
export const waitEnvelopeBytes = (value: unknown): number => {
  const body = JSON.stringify(value);
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: body }] }), "utf8");
};
/** Agent name of a Run; blocked_by and error details carry Run IDs. */
export type NameOf = (run_id: string) => string;

// The parent's verb is interrupt, so its statuses say so.
const statusOf = (view: RunView) => view.finalization_pending ? "finishing" :
  view.status === "cancelled" ? "interrupted" : view.status === "cancelling" ? "interrupting" : view.status;

/** One Agent's current or latest task: lifecycle facts only. */
export function taskReply(view: RunView, nameOf: NameOf) {
  const unavailable = view.owner_blocked || (terminal(view.status) && !view.resumable) ? view.unavailable_reason : undefined;
  return { agent: view.name, status: statusOf(view),
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    // Qualifies `status`: a turn-capped task still settles as "completed".
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(view.outcome?.error ? { error: utf16Prefix(view.outcome.error, 512) } : {}),
    ...(view.owner_error ? { owner_error: utf16Prefix(view.owner_error, 512) } : {}),
    ...(view.blocked_by?.length ? { waiting_for: view.blocked_by.map(nameOf) } : {}),
    ...(unavailable ? { unavailable } : {}) };
}
/** Settled since last shown; the parent reads the result with agent_wait or agent_read. */
export function finishedReply(view: RunView) {
  return { agent: view.name, status: statusOf(view),
    ...(view.outcome?.reason ? { reason: view.outcome.reason } : {}),
    ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
    ...(view.outcome?.question ? { has_question: true } : {}) };
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
  return { agent, profile: view.effective_settings.profile, difficulty: view.effective_settings.difficulty,
    label: utf16Prefix(view.description, 120), ...task,
    ...(view.outcome?.question ? { has_question: true } : {}),
    ...(running && view.execution_elapsed_ms !== undefined ? { elapsed_s: Math.round(view.execution_elapsed_ms / 1000) } : {}),
    tasks: summary.runs,
    ...(earlier.length ? { earlier_labels: earlier } : {}),
    ...(context && context.tokens !== null ? { context_pct: Math.round(context.tokens / context.context_window * 100) } : {}),
    cost_usd: Math.round(summary.observed_cost * 1000) / 1000,
    // Observed spend only: some responses reported no cost.
    ...(summary.cost_partial ? { cost_partial: true } : {}),
    ...(touched.length ? { touched } : {}),
    ...(touchedOmitted ? { touched_omitted: touchedOmitted } : {}),
    ...(summary.idle_ms === undefined ? {} : { idle_s: Math.round(summary.idle_ms / 1000) }) };
}

const pageFields = (page: ResultPage) => {
  const omitted = page.total_chars - page.retained_chars;
  return { result: page.text, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
    ...(omitted > 0 ? { omitted_chars: omitted } : {}) };
};
/** agent_read: the whole recorded question plus one page of the result. */
export function resultReply(page: ResultPage, nameOf: NameOf) {
  return { ...taskReply(page.snapshot, nameOf),
    ...(page.snapshot.outcome?.question ? { question: page.snapshot.outcome.question } : {}), ...pageFields(page) };
}

type ResultReader = (run_id: string, limit: number) => ResultPage;
export type WaitReason = "done" | "aborted" | Exclude<WaitResult["reason"], "condition" | "interrupted">;

/** A bounded wait projection. Whole questions come first, results second, and
 * coalesced progress uses only what remains. A wrapper that embeds the reply
 * is measured too, so its envelope stays within the hard bound. */
export function waitReply(value: WaitResult, readResult: ResultReader | undefined, nameOf: NameOf,
  wrap: (reply: object) => unknown = (reply) => reply) {
  // "interrupted" is a task status here; an Esc-stopped wait is "aborted".
  const reason: WaitReason = value.reason === "condition" ? "done" : value.reason === "interrupted" ? "aborted" : value.reason;
  const savedPages = new Map(value.results?.map((page) => [page.snapshot.run_id, page]));
  const terminalViews = value.snapshots.filter((view) => terminal(view.status));
  const pending = value.snapshots.filter((view) => !terminal(view.status)).map((view) => view.name);
  const build = (textBudget: number) => {
    let remaining = textBudget;
    const agents: Array<Record<string, unknown>> = value.snapshots.map((view) => ({ ...taskReply(view, nameOf) }));
    const byRun = new Map(value.snapshots.map((view, index) => [view.run_id, agents[index]!]));

    const questions = terminalViews.filter((view) => !!view.outcome?.question);
    // Whole questions are actionable. Admit every whole question that fits, in
    // order, before sharing the rest; a long one cannot crowd out a short one.
    const deferred: RunView[] = [];
    const showQuestion = (view: RunView, shown: string) => {
      const question = view.outcome!.question!;
      Object.assign(byRun.get(view.run_id)!, { question: shown, ...(shown.length < question.length ? { question_truncated: true } : {}) });
      remaining -= shown.length;
    };
    for (const view of questions) {
      if (view.outcome!.question!.length <= remaining) showQuestion(view, view.outcome!.question!);
      else deferred.push(view);
    }
    for (let index = 0; index < deferred.length; index++) {
      const view = deferred[index]!;
      showQuestion(view, utf16Prefix(view.outcome!.question!, Math.floor(remaining / (deferred.length - index))));
    }

    // A lone result may use the whole budget; a batch shares it, 4096 each at least.
    const perRun = Math.max(WAIT_RUN_TEXT_BUDGET, Math.floor(textBudget / Math.max(1, terminalViews.length)));
    const resultsFit = terminalViews.reduce((sum, view) =>
      sum + Math.min(perRun, view.result_ref?.chars ?? savedPages.get(view.run_id)?.text.length ?? 0), 0) <= remaining;
    for (let index = 0; index < terminalViews.length; index++) {
      const view = terminalViews[index]!, reply = byRun.get(view.run_id)!;
      const quota = resultsFit ? perRun : Math.min(perRun, Math.floor(remaining / (terminalViews.length - index)));
      let page = quota > 0 ? (readResult ? readResult(view.run_id, quota) : savedPages.get(view.run_id)) : undefined;
      if (page && page.text.length > quota && readResult && quota > 1) page = readResult(view.run_id, quota - 1);
      if (page && page.text.length <= quota) {
        Object.assign(reply, pageFields(page));
        remaining -= page.text.length;
      } else if ((view.result_ref?.total_chars ?? 0) > 0) Object.assign(reply, { result_omitted: true });
    }

    const claimed = value.progress ?? [];
    const selected: typeof claimed = [];
    const perTask = new Map<string, number>();
    // At most the latest two per task and sixteen total; the rest is counted.
    for (let index = claimed.length - 1; index >= 0 && selected.length < 16; index--) {
      const event = claimed[index]!, count = perTask.get(event.run_id) ?? 0;
      if (count >= 2) continue;
      perTask.set(event.run_id, count + 1); selected.push(event);
    }
    selected.reverse();
    let progressRemaining = Math.min(remaining, WAIT_PROGRESS_TEXT_BUDGET), shownProgress = 0;
    for (let index = 0; index < selected.length && progressRemaining > 1; index++) {
      const event = selected[index]!, reply = byRun.get(event.run_id);
      const quota = Math.min(512, Math.floor(progressRemaining / (selected.length - index)));
      if (!reply || quota < 2) continue;
      const text = event.text.length <= quota ? event.text : `${utf16Prefix(event.text, quota - 1)}…`;
      ((reply.progress ??= []) as string[]).push(text);
      shownProgress++; progressRemaining -= text.length; remaining -= text.length;
    }
    return { reason, agents, ...(pending.length ? { pending } : {}),
      ...(claimed.length > shownProgress ? { progress_omitted: claimed.length - shownProgress } : {}) };
  };
  const fits = (reply: object) => waitEnvelopeBytes(wrap(reply)) <= WAIT_SERIALIZED_REPLY_LIMIT;
  const reply = build(WAIT_TEXT_BUDGET);
  if (fits(reply)) return reply;
  // Measure UTF-8 after both JSON layers; the marker is inside every measured
  // candidate. This finds a safe candidate, not an optimal byte packing.
  let low = 0, high = WAIT_TEXT_BUDGET - 1;
  let best: object | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...build(middle), response_limit_reached: true };
    if (fits(candidate)) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  if (best) return best;
  // Errors are optional metadata. This fallback keeps every lifecycle fact that
  // affects orchestration and marks each question/result agent_read must fetch.
  const compact = { reason,
    agents: value.snapshots.map((view) => ({ agent: view.name, status: statusOf(view),
      ...(view.outcome?.limit_reached ? { limit_reached: true } : {}),
      ...(view.outcome?.question ? { question_truncated: true } : {}),
      ...((view.result_ref?.total_chars ?? 0) > 0 ? { result_omitted: true } : {}) })),
    ...(pending.length ? { pending } : {}),
    ...(value.progress?.length ? { progress_omitted: value.progress.length } : {}),
    response_limit_reached: true };
  if (!fits(compact)) throw new HarnessError("WAIT_REPLY_TOO_LARGE");
  return compact;
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
  return { error: { code: error.code ?? "TOOL_ERROR",
    ...(agent ? { agent: utf16Prefix(agent, 64) } : {}),
    ...(typeof d.key === "string" ? { parameter: d.key } : {}),
    ...(typeof d.reason === "string" ? { reason: utf16Prefix(d.reason, 512) } : {}),
    ...(typeof d.error === "string" ? { message: utf16Prefix(d.error, 512) } : {}),
    ...(typeof d.resolution === "string" ? { resolution: utf16Prefix(d.resolution, 512) } : {}),
    ...(typeof d.requested === "string" ? { requested: utf16Prefix(d.requested, 128) } : {}),
    ...(validDifficulty(d.difficulty) ? { difficulty: d.difficulty } : {}),
    ...allowedFields(d.allowed),
    ...(typeof d.parent_thinking === "string" ? { parent_thinking: utf16Prefix(d.parent_thinking, 32) } : {}) } };
}
