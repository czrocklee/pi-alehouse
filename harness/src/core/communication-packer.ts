import {
  COMMUNICATION_LIMITS, communicationBudget, communicationEnvelopeBytes, communicationTextUnits, isModelAgentName as validName,
  isQueueWait, modelDispatchNotes, visibleCommunicationReason,
  type CommunicationAction, type CommunicationEnvelope, type CommunicationReason,
  type FinishedEntry, type TaskEntry, type TaskStatus, type ThinTaskEntry,
} from "./communication-envelope.ts";
import type {
  CommunicationSnapshot, CommunicationToolResult, PackedCommunication, ResultWindow,
} from "./communication-snapshot.ts";
import type { TaskMetadata } from "./task-metadata.ts";
import { isQuestionId } from "./question-id.ts";
import { encodeResultCursor } from "./result-cursor.ts";
import { HarnessError } from "./ports.ts";

type MutableRow = { -readonly [K in keyof TaskEntry]: TaskEntry[K] };
type PackingCode = "INVALID_COMMUNICATION_SNAPSHOT" | "COMMUNICATION_REPLY_TOO_LARGE";

export class CommunicationPackingError extends HarnessError {
  constructor(code: PackingCode, message: string) {
    super(code, { reason: message });
    this.message = `${code}: ${message}`;
    this.name = "CommunicationPackingError";
  }
}

const invalid = (message: string): never => {
  throw new CommunicationPackingError("INVALID_COMMUNICATION_SNAPSHOT", message);
};
const tooLarge = (): never => {
  throw new CommunicationPackingError("COMMUNICATION_REPLY_TOO_LARGE", "Required communication facts exceed the envelope budget");
};
const toolResult = (value: unknown): CommunicationToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(value) }], details: undefined });

/** Independent roster/lifecycle replies have no bodies, cursors or publication
 * references. Keep their existing optional-field priority separate from result
 * packing, but use the same byte cap, whole-field omission and final serializer.
 * This pure projection never mutates the captured object or consumes facts. */
export function packIndependentCommunication(captured: Record<string, unknown>): CommunicationToolResult {
  const value = structuredClone(captured);
  let limited = value.response_limit_reached === true;
  value.response_limit_reached = true;
  const rows = Array.isArray(value.agents) ? value.agents as Record<string, unknown>[] : [value];
  optionalFields: for (const field of ["error", "owner_error", "unavailable_reason", "dispatch_notes", "label"] as const) {
    for (const row of [...rows].reverse()) {
      if (communicationEnvelopeBytes(value) <= COMMUNICATION_LIMITS.envelope_bytes) break optionalFields;
      if (row[field] === undefined) continue;
      delete row[field]; limited = true;
    }
  }
  if (communicationEnvelopeBytes(value) > COMMUNICATION_LIMITS.envelope_bytes)
    throw new HarnessError("COMMUNICATION_REPLY_TOO_LARGE", { resolution: "Read one Agent/task instead of the roster. Required lifecycle facts could not fit; do not repeat a management command blindly." });
  if (!limited) delete value.response_limit_reached;
  return toolResult(value);
}

const flags = ["has_question", "limit_reached", "unavailable", "question_truncated", "result_omitted", "result_truncated"] as const;
const diagnostics = ["error", "owner_error", "unavailable_reason"] as const;
const statuses: Readonly<Record<TaskStatus, true>> = {
  queued: true, running: true, interrupting: true, finishing: true,
  completed: true, needs_input: true, failed: true, interrupted: true,
};
const reasons: Readonly<Record<CommunicationReason, true>> = {
  snapshot: true, aborted: true, owner_blocked: true, question: true, task_issue: true,
  done: true, alert: true, nothing_pending: true, timeout: true,
};
const terminalStatus = (status: TaskStatus): boolean =>
  status === "completed" || status === "needs_input" || status === "failed" || status === "interrupted";
const safeCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const nonblank = (value: string): boolean => typeof value === "string" && value.trim().length > 0;

/** Reject extra required-layer keys rather than accidentally copying arbitrary
 * strings into the fixed shape whose byte bound was proved. wait, when present,
 * is part of that shape: queued status only, and only dependencies or capacity. */
function copyRow(row: ThinTaskEntry): MutableRow {
  if (!row || typeof row !== "object" || !validName(row.agent) || !safeCount(row.task) || row.task === 0 ||
      !Object.hasOwn(statuses, row.status)) invalid("Invalid thin task identity or status");
  const allowed: readonly string[] = ["agent", "task", "status", "wait", ...flags];
  if (Object.keys(row).some((key) => !allowed.includes(key))) invalid("Unexpected thin task field");
  const result: MutableRow = { agent: row.agent, task: row.task, status: row.status };
  // Mandatory thin control, not optional metadata: a present reason is reserved
  // before any body or diagnostic can yield. Provider ids and counts are not keys.
  if (row.wait !== undefined) {
    if (row.status !== "queued" || !isQueueWait(row.wait)) invalid("Invalid queued wait reason");
    result.wait = row.wait;
  }
  for (const key of flags) {
    if (row[key] !== undefined && row[key] !== true) invalid(`Invalid ${key} control flag`);
    if (row[key] === true) result[key] = true;
  }
  return result;
}

function copyAction(action: CommunicationAction | undefined): CommunicationAction | undefined {
  if (action === undefined) return undefined;
  if (!action || typeof action !== "object" || !validName(action.agent) || !safeCount(action.task) || action.task === 0)
    invalid("Invalid action identity");
  const allowed = action.type === "agent_send" ? ["type", "agent", "task", "delivery"] : ["type", "agent", "task"];
  if (Object.keys(action).some((key) => !allowed.includes(key))) invalid("Unexpected action field");
  switch (action.type) {
    case "agent_spawn": case "agent_run": case "agent_answer":
      return { type: action.type, agent: action.agent, task: action.task };
    case "agent_send":
      if (!["joined", "steered", "not_delivered"].includes(action.delivery)) invalid("Invalid send delivery fact");
      return { type: action.type, agent: action.agent, task: action.task, delivery: action.delivery };
    default: return invalid("Invalid action type");
  }
}

function validateWindow(window: ResultWindow): void {
  if (!window || typeof window !== "object" || typeof window.text !== "string" ||
      !safeCount(window.offset) || !safeCount(window.retained_chars) || !safeCount(window.total_chars) ||
      window.total_chars < window.retained_chars || window.offset > window.retained_chars ||
      window.text.length > window.retained_chars - window.offset) invalid("Invalid result window bounds");
  if (window.cursor !== undefined && (!window.cursor || typeof window.cursor !== "object" ||
      !nonblank(window.cursor.owner) || !nonblank(window.cursor.generation) || !nonblank(window.cursor.run) || !nonblank(window.cursor.version)))
    invalid("Invalid stable result cursor identity");
}

function validateMetadata(metadata: Partial<TaskMetadata>): void {
  if (metadata.label !== undefined && (typeof metadata.label !== "string" || metadata.label.length > COMMUNICATION_LIMITS.label_units))
    invalid("Invalid bounded task label");
}

/** Preserve pairs in the original text, while keeping originally lone surrogates. */
function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, Math.max(0, limit));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(0, end);
}

function replaceRow(envelope: CommunicationEnvelope, index: number, row: TaskEntry): CommunicationEnvelope {
  return { ...envelope, agents: envelope.agents.map((current, at) => at === index ? row : current) };
}

/** Counts are reminders, not zero-valued scaffolding. Shape every trial before
 * measuring/serializing so optional omission cannot follow publication commit. */
function withCount(envelope: CommunicationEnvelope, field: "alerts_pending" | "finished_pending", count: number): CommunicationEnvelope {
  const result: { -readonly [K in keyof CommunicationEnvelope]: CommunicationEnvelope[K] } = { ...envelope };
  if (count > 0) result[field] = count;
  else delete result[field];
  return result;
}

/** Full text is tried separately: completing a page can remove a cursor or a
 * truncation flag, so that last candidate need not obey prefix-size monotonicity. */
function fitPrefix(text: string, maximum: number, minimum: number,
  build: (shown: string) => CommunicationEnvelope): { envelope: CommunicationEnvelope; shown: string } | undefined {
  if (text.length <= maximum) {
    const full = build(text);
    if (communicationBudget(full).fits) return { envelope: full, shown: text };
  }
  let low = minimum, high = Math.min(maximum, text.length - 1);
  let best: { envelope: CommunicationEnvelope; shown: string } | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shown = prefix(text, middle);
    const candidate = build(shown);
    if (communicationBudget(candidate).fits) {
      best = { envelope: candidate, shown };
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function cursorAt(window: ResultWindow, offset: number): string | undefined {
  if (!window.cursor || offset >= window.retained_chars) return undefined;
  return encodeResultCursor(window.cursor, offset);
}

/** Pure bounded projection from an ordinary immutable-by-contract snapshot.
 * No ports, callbacks from the caller, live Run references, queues, or commits.
 * Every trial reserves response_limit_reached and all potential thin flags so
 * later omissions cannot push previously accepted mandatory facts over budget.
 * A queued wait reason is copied with that thin row, never as optional metadata. */
export function packCommunication(snapshot: CommunicationSnapshot): PackedCommunication {
  if (!snapshot || typeof snapshot !== "object" || !Object.hasOwn(reasons, snapshot.reason) ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length > COMMUNICATION_LIMITS.agents ||
      !Array.isArray(snapshot.alerts) || snapshot.alerts.length > COMMUNICATION_LIMITS.pending_alerts ||
      !Array.isArray(snapshot.finished)) invalid("Invalid communication snapshot shape or model capacity");
  if (snapshot.workers_disabled !== undefined && snapshot.workers_disabled !== true) invalid("Invalid workers_disabled flag");
  if (snapshot.reason === "alert" && snapshot.alerts.length === 0) invalid("Alert reason requires a complete pending alert");
  if (snapshot.reason === "owner_blocked" && (snapshot.blocked === undefined || !nonblank(snapshot.blocked)))
    invalid("Owner-blocked publication requires its fault reference");

  const action = copyAction(snapshot.action);
  const taskKeys = new Set<string>();
  const agents = snapshot.tasks.map((task) => {
    if (!task || typeof task !== "object" || typeof task.settled !== "boolean") invalid("Invalid task snapshot");
    const row = copyRow(task.row);
    const key = `${row.agent}:${row.task}`;
    if (taskKeys.has(key)) invalid("Duplicate bound task");
    taskKeys.add(key);
    if (task.settled !== terminalStatus(row.status)) invalid("Task settlement must match its control status");
    validateMetadata(task);
    if (task.question_id !== undefined) {
      if (!isQuestionId(task.question_id)) invalid("Invalid bounded question identity");
      row.question_id = task.question_id;
    }
    if (task.question !== undefined) {
      if (!nonblank(task.question) || task.question.length > COMMUNICATION_LIMITS.child_text_units) invalid("Invalid question text bounds");
      row.question = "";
      row.question_truncated = true;
    }
    if (task.result_notice !== undefined && (!nonblank(task.result_notice) || task.result_notice.length > 512 ||
        task.result !== undefined || row.result_omitted || row.result_truncated)) invalid("Invalid bounded result notice");
    if (task.result !== undefined) {
      validateWindow(task.result);
      if ((task.result.cursor !== undefined) !== task.settled) invalid("Stable results require cursor identity; live previews cannot carry it");
      // Whole omitted terminal pages must remain addressable after Agent reuse.
      // Fixed-width cursors reserve every eventual offset before ANY body text.
      const cursor = cursorAt(task.result, task.result.offset);
      if (cursor !== undefined) row.next_cursor = cursor;
      row.result_omitted = true;
      if (!task.result.cursor && task.result.offset < task.result.retained_chars) row.result_truncated = true;
    }
    if (task.diagnostics !== undefined) {
      if (!task.diagnostics || typeof task.diagnostics !== "object" ||
          Object.keys(task.diagnostics).some((key) => !(diagnostics as readonly string[]).includes(key))) invalid("Invalid diagnostics shape");
      for (const key of diagnostics) if (task.diagnostics[key] !== undefined && typeof task.diagnostics[key] !== "string")
        invalid("Invalid diagnostic text");
    }
    if (task.cancellation_source !== undefined && task.cancellation_source !== "human") invalid("Invalid cancellation_source metadata");
    if (task.dispatch_notes !== undefined && (!Array.isArray(task.dispatch_notes) || task.dispatch_notes.length > 2 ||
        Array.from(task.dispatch_notes).some((note: unknown) => typeof note !== "string" || !nonblank(note) || note.length > 120))) invalid("Invalid bounded dispatch notes");
    return row;
  });
  const alerts = snapshot.alerts.map((alert) => {
    if (!alert || typeof alert !== "object" || !validName(alert.agent) || !safeCount(alert.task) || alert.task === 0 ||
        typeof alert.label !== "string" || alert.label.length > COMMUNICATION_LIMITS.label_units ||
        !nonblank(alert.message) || alert.message.length > COMMUNICATION_LIMITS.child_text_units ||
        (alert.source !== undefined && alert.source !== "harness") ||
        Object.keys(alert).some((key) => !["agent", "task", "label", "message", "source"].includes(key))) invalid("Invalid complete alert bounds");
    return { agent: alert.agent, task: alert.task, label: alert.label, message: alert.message,
      ...(alert.source === undefined ? {} : { source: alert.source }) };
  });
  const suppressPresentation = snapshot.reason === "aborted" || snapshot.reason === "timeout";
  const finishedKeys = new Set<string>();
  const presented = new Set<number>();
  const finished = snapshot.finished.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") invalid("Invalid finished candidate");
    const row = copyRow(candidate.row);
    if (!terminalStatus(row.status)) invalid("Finished candidate requires a terminal status");
    if (candidate.cancellation_source !== undefined && candidate.cancellation_source !== "human") invalid("Invalid finished cancellation_source metadata");
    validateMetadata({ label: candidate.label });
    const key = `${row.agent}:${row.task}`;
    if (finishedKeys.has(key)) invalid("Duplicate finished candidate");
    finishedKeys.add(key);
    // Only the Owner's explicit original-Run link can identify a bound row.
    // Equal display names/task ordinals/statuses do not establish identity;
    // an unlinked candidate needs its own finished row before it is presented.
    const taskIndex = candidate.task_index;
    if (taskIndex !== undefined) {
      if (!safeCount(taskIndex)) invalid("Invalid finished task index");
      const task = snapshot.tasks[taskIndex];
      if (!task || !task.settled || task.row.agent !== row.agent || task.row.task !== row.task || task.row.status !== row.status)
        invalid("Finished task index does not identify the exact bound settled task");
      if (!suppressPresentation) presented.add(index);
    }
    return row;
  });

  const reason = visibleCommunicationReason(snapshot.reason);
  let envelope: CommunicationEnvelope = {
    ...(reason === undefined ? {} : { reason }),
    ...(action ? { action } : {}),
    ...(snapshot.workers_disabled ? { workers_disabled: true } : {}),
    agents,
    ...(alerts.length ? { alerts_pending: alerts.length } : {}),
    ...(finished.length > presented.size ? { finished_pending: finished.length - presented.size } : {}),
    response_limit_reached: true,
  };
  let shownAlerts = 0;
  let limited = false;
  if (snapshot.reason === "alert") {
    envelope = withCount({ ...envelope, alerts: [alerts[0]!] }, "alerts_pending", alerts.length - 1);
    shownAlerts = 1;
  }
  if (!communicationBudget(envelope).fits) tooLarge();

  // Tokens and empty question fields were reserved in the control layer. All
  // question text is allocated before non-required alerts or any result pages.
  for (let index = 0; index < snapshot.tasks.length; index++) {
    const task = snapshot.tasks[index]!;
    if (task.question === undefined) continue;
    const base = envelope.agents[index]!;
    const fitted = fitPrefix(task.question, COMMUNICATION_LIMITS.text_units - communicationTextUnits(envelope), 0, (shown) => {
      const row: MutableRow = { ...base, question: shown };
      if (shown.length === task.question!.length && !task.row.question_truncated) delete row.question_truncated;
      else row.question_truncated = true;
      return replaceRow(envelope, index, row);
    });
    if (!fitted) return tooLarge(); // Even the empty field/flag was already reserved.
    envelope = fitted.envelope;
    if (fitted.shown.length < task.question.length) limited = true;
  }

  if (!suppressPresentation) {
    for (; shownAlerts < alerts.length; shownAlerts++) {
      const candidate = withCount({ ...envelope, alerts: alerts.slice(0, shownAlerts + 1) }, "alerts_pending", alerts.length - shownAlerts - 1);
      if (!communicationBudget(candidate).fits) { limited = true; break; }
      envelope = candidate;
    }
  }

  // Bounded labels and Stop attribution retain their priority.
  for (const field of ["cancellation_source", "label"] as const) {
    for (let index = 0; index < snapshot.tasks.length; index++) {
      const value = snapshot.tasks[index]![field];
      if (value === undefined) continue;
      const candidate = replaceRow(envelope, index, { ...envelope.agents[index]!, [field]: value });
      if (communicationBudget(candidate).fits) envelope = candidate;
      else limited = true;
    }
  }

  // A stable cursor describes the actual shown endpoint, not the captured
  // window's endpoint. Even wholly omitted terminal pages retain the reserved
  // original-Run cursor at the unchanged offset; no cursorless recovery guess.
  // Handoff notices are whole status text, not pages of the retained result.
  for (let index = 0; index < snapshot.tasks.length; index++) {
    const task = snapshot.tasks[index]!;
    if (task.result_notice !== undefined) {
      const candidate = replaceRow(envelope, index, { ...envelope.agents[index]!, result: task.result_notice });
      if (communicationBudget(candidate).fits) envelope = candidate;
      else limited = true;
      continue;
    }
    const window = task.result;
    if (!window) continue;
    const base = envelope.agents[index]!;
    const build = (shown: string): CommunicationEnvelope => {
      const row: MutableRow = { ...base };
      const hasRetainedText = window.offset < window.retained_chars;
      const omitted = shown.length === 0 && (window.text.length > 0 || hasRetainedText);
      if (shown.length > 0) row.result = shown;
      else delete row.result;
      if (omitted || task.row.result_omitted) row.result_omitted = true;
      else delete row.result_omitted;
      if (task.row.result_truncated || (!window.cursor && window.offset + shown.length < window.retained_chars)) row.result_truncated = true;
      else delete row.result_truncated;
      const cursor = cursorAt(window, window.offset + shown.length);
      if (cursor !== undefined) row.next_cursor = cursor;
      else delete row.next_cursor;
      const lost = window.total_chars - window.retained_chars;
      if (lost > 0) row.omitted_chars = lost;
      return replaceRow(envelope, index, row);
    };
    const firstUnits = /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(window.text) ? 2 : 1;
    const fitted = fitPrefix(window.text, COMMUNICATION_LIMITS.text_units - communicationTextUnits(envelope), firstUnits, build);
    if (fitted) {
      envelope = fitted.envelope;
      if (fitted.shown.length < window.text.length) limited = true;
    } else {
      const omitted = build("");
      if (communicationBudget(omitted).fits) envelope = omitted;
      limited = true;
    }
  }

  for (let index = 0; index < snapshot.tasks.length; index++) {
    const task = snapshot.tasks[index]!;
    for (const key of diagnostics) {
      const text = task.diagnostics?.[key];
      if (text === undefined) continue;
      // Diagnostics have a fixed, non-pageable 512-unit projection. Repeating
      // a read returns the same prefix, not the tail; that cap alone is not
      // envelope pressure or a promise of cursorless recovery. Only failure to
      // fit this bounded projection sets the response-limit flag.
      const bounded = prefix(text, 512);
      const base = envelope.agents[index]!;
      const fitted = fitPrefix(bounded, bounded.length, 1, (shown) => replaceRow(envelope, index, { ...base, [key]: shown }));
      if (fitted) envelope = fitted.envelope;
      if (!fitted || fitted.shown.length < bounded.length) limited = true;
    }
    // Notes remain low-priority whole diagnostics, not reserved controls.
    // A later locatable observation can try again, but no cursor is introduced.
    for (const note of modelDispatchNotes(task.dispatch_notes) ?? []) {
      const base = envelope.agents[index]!;
      const candidate = replaceRow(envelope, index, { ...base, dispatch_notes: [...(base.dispatch_notes ?? []), note] });
      if (!communicationBudget(candidate).fits) { limited = true; break; }
      envelope = candidate;
    }
  }

  if (!suppressPresentation) {
    const listed: FinishedEntry[] = [];
    for (let index = 0; index < finished.length; index++) {
      if (presented.has(index)) continue;
      if (listed.length === COMMUNICATION_LIMITS.finished) { limited = true; break; }
      const candidate = withCount({ ...envelope, finished: [...listed, finished[index]!] }, "finished_pending", finished.length - presented.size - 1);
      if (!communicationBudget(candidate).fits) { limited = true; break; }
      // Attribute only after the thin row fits. If metadata cannot fit, still
      // present/commit that original Run; no second reminder/ACK is invented.
      let row: FinishedEntry = finished[index]!;
      envelope = candidate;
      for (const field of ["cancellation_source", "label"] as const) {
        const value = snapshot.finished[index]![field];
        if (value === undefined) continue;
        const attributed = { ...row, [field]: value };
        const withMetadata = { ...envelope, finished: [...listed, attributed] };
        if (communicationBudget(withMetadata).fits) { envelope = withMetadata; row = attributed; }
        else limited = true;
      }
      listed.push(row);
      presented.add(index);
    }
  }

  if (!limited) {
    const { response_limit_reached: _reserved, ...complete } = envelope;
    envelope = complete;
  }
  if (!communicationBudget(envelope).fits) tooLarge();
  return {
    envelope,
    result: toolResult(envelope),
    references: {
      alerts: Array.from({ length: shownAlerts }, (_, index) => index),
      finished: [...presented].sort((left, right) => left - right),
      ...(snapshot.reason === "owner_blocked" && snapshot.blocked !== undefined ? { blocked: snapshot.blocked } : {}),
    },
  };
}
