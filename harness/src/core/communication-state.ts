import { COMMUNICATION_LIMITS, alertAdmissionBudget, modelTaskStatus, type CommunicationEnvelope, type ThinTaskEntry } from "./communication-envelope.js";
import type { CommunicationReferences, CommunicationSnapshot } from "./communication-snapshot.js";
import { terminal, type Phase, type RunStatus } from "./contracts.js";
import type { CoreObservationReason } from "./observation-scheduler.js";
import { HarnessError, type RepeatedManagedBlock } from "./ports.js";
import { boundedOutput } from "./result-text.js";
import { questionId, type QuestionId } from "./question-id.js";

/** Structural views of ORIGINAL Owner objects, not another set of records.
 * The production controller satisfies these interfaces directly. These
 * helpers create only transient selections/snapshots; the Owner owns storage.
 * Callers supply authoritative current-Owner/generation objects, not model
 * input. Effecting callers must pass the scheduler gate before mutations;
 * child acceptance additionally checks current Run, input gate, stop and exit. */
export interface CommunicationRun {
  readonly record: {
    readonly owner_id: string;
    readonly generation: string;
    readonly run_id: string;
    readonly agent_id: string;
    readonly enqueue_sequence: number;
    readonly name: string;
    readonly description: string;
    readonly status: RunStatus;
    readonly phase: Phase;
    readonly execution_exited: boolean;
    readonly outcome?: { readonly limit_reached: boolean };
  };
  question?: string;
  readonly quarantine?: string;
  finished_presented: boolean;
  settled_seq?: number;
}
export interface CommunicationAgent {
  readonly id: string;
  readonly current?: string;
  readonly resident: boolean;
  readonly unavailable?: string;
  readonly exiting?: true;
  readonly question?: { readonly run_id: string; readonly reserved_by?: string };
}
export interface PendingAlert<Run extends CommunicationRun = CommunicationRun> {
  readonly run: Run;
  readonly message: string;
  /** Only the trusted managed-block admission path can assign this tag. */
  readonly source?: "harness";
}
/** Alert origin is not the completion target. Agent scope deliberately crosses
 * Runs; Owner scope deliberately includes killed/historical Agent messages. */
export type AlertScope<Run extends CommunicationRun = CommunicationRun> =
  { readonly kind: "owner" } |
  { readonly kind: "agents"; readonly agent_ids: readonly string[] } |
  { readonly kind: "run"; readonly run: Run };

export function scopedAlerts<Run extends CommunicationRun>(pending: readonly PendingAlert<Run>[], scope: AlertScope<Run>): PendingAlert<Run>[] {
  return pending.filter((alert) => scope.kind === "owner" || (scope.kind === "run" ?
    alert.run === scope.run : scope.agent_ids.includes(alert.run.record.agent_id)));
}
/** Shared original-record/RunView predicate. Owner installs terminal status and
 * settled phase together, but structural callers can supply partial views.
 * A retained Outcome, or absence of finalization_pending alone, is not proof. */
export function isSettledRecord(record: {
  readonly phase?: Phase; readonly status?: RunStatus; readonly execution_exited?: boolean;
  readonly finalization_pending?: boolean;
}): boolean {
  return record.phase === "settled" && record.execution_exited === true &&
    (record.finalization_pending === undefined || record.finalization_pending === false) &&
    record.status !== undefined && terminal(record.status);
}
export const isCommunicationSettled = (run: CommunicationRun): boolean => isSettledRecord(run.record);

/** Health is a pure core fact and EXCLUDES delegation admission. Off may hide
 * answer but must not erase a pending question's identity in explicit reads. */
export function canAnswerQuestion(agent: CommunicationAgent, run: CommunicationRun, ownerHealthy: boolean): boolean {
  return ownerHealthy && agent.id === run.record.agent_id && agent.resident && agent.unavailable === undefined &&
    !agent.exiting && agent.current === undefined && agent.question?.run_id === run.record.run_id &&
    agent.question.reserved_by === undefined && isCommunicationSettled(run) && run.record.status === "needs_input" &&
    run.question !== undefined && run.quarantine === undefined;
}
export function actionableQuestionId(agent: CommunicationAgent, run: CommunicationRun, ownerHealthy: boolean): QuestionId | undefined {
  return canAnswerQuestion(agent, run, ownerHealthy) ?
    questionId(run.record.owner_id, run.record.generation, run.record.run_id) : undefined;
}

/** Never compare question bodies on replay; even a later identical body must
 * still pass validation. Run/generation/input gate checks precede this helper. */
export function recordFirstQuestion(run: CommunicationRun, text: unknown): "recorded" | "already_recorded" {
  if (typeof text !== "string" || text.length < 1 || text.length > COMMUNICATION_LIMITS.child_text_units || !/\S/.test(text)) {
    throw new HarnessError("INVALID_QUESTION", { limit: COMMUNICATION_LIMITS.child_text_units });
  }
  if (run.question !== undefined) return "already_recorded";
  run.question = text;
  return "recorded";
}

/** Fixed SDK-free recovery guidance shared by core rejection and child error projection. */
export const ALERT_QUEUE_FULL_RESOLUTION = "Do not retry in a loop; keep the information in your final result and continue work you can do. If you truly need a parent decision, use ask_parent and end this task.";
/** The sole FIFO is supplied by the Owner. No child call-ID cache, counter,
 * queue eviction, wake, or execution stop lives in this admission primitive. */
export function enqueueAlert<Run extends CommunicationRun>(pending: PendingAlert<Run>[], run: Run, message: unknown): PendingAlert<Run> {
  if (typeof message !== "string" || !message.length || !/\S/.test(message)) throw new HarnessError("INVALID_ALERT");
  if (message.length > COMMUNICATION_LIMITS.child_text_units) {
    throw new HarnessError("ALERT_TOO_LARGE", { limit: COMMUNICATION_LIMITS.child_text_units });
  }
  const childAlerts = pending.filter((alert) => alert.source === undefined);
  if (childAlerts.length >= COMMUNICATION_LIMITS.owner_alerts) {
    throw new HarnessError("ALERT_QUEUE_FULL", { scope: "owner", limit: COMMUNICATION_LIMITS.owner_alerts, resolution: ALERT_QUEUE_FULL_RESOLUTION });
  }
  if (childAlerts.filter((alert) => alert.run.record.agent_id === run.record.agent_id).length >= COMMUNICATION_LIMITS.agent_alerts) {
    throw new HarnessError("ALERT_QUEUE_FULL", { scope: "agent", limit: COMMUNICATION_LIMITS.agent_alerts, resolution: ALERT_QUEUE_FULL_RESOLUTION });
  }
  if (!alertAdmissionBudget(message).fits) throw new HarnessError("ALERT_TOO_LARGE", { limit: COMMUNICATION_LIMITS.envelope_bytes });
  const alert = Object.freeze({ run, message });
  pending.push(alert);
  return alert;
}

/** Pure-data host configuration, snapshotted once at Owner construction. This
 * is a telemetry vocabulary, not a permission/tool grant or a runtime import.
 * Missing/empty configuration disables feedback. Accessor elements and holes
 * are rejected without invoking them; the caller's array/iterator is not kept. */
export function snapshotManagedBlockTools(input: readonly string[] | undefined): ReadonlySet<string> {
  const tools = new Set<string>();
  if (input === undefined) return tools;
  if (!Array.isArray(input) || input.length > 32) throw new HarnessError("INVALID_MANAGED_BLOCK_TOOLS");
  for (let index = 0; index < input.length; index++) {
    const element = Object.getOwnPropertyDescriptor(input, String(index));
    const tool: unknown = element?.value;
    if (!element || !("value" in element) || typeof tool !== "string" ||
        /^[a-z][a-z0-9_]{0,63}$/.exec(tool)?.[0] !== tool || tools.has(tool)) throw new HarnessError("INVALID_MANAGED_BLOCK_TOOLS");
    tools.add(tool);
  }
  return tools;
}

/** Same FIFO/scopes/publication as child alerts, with independently bounded
 * optional capacity. Full feedback is suppressed, never evicts or retries, and
 * never spends a child's allowance. The caller first guards the Run input gate. */
export function enqueueManagedBlock<Run extends CommunicationRun>(pending: PendingAlert<Run>[], run: Run,
  fact: RepeatedManagedBlock, tools: ReadonlySet<string>): PendingAlert<Run> | undefined {
  if (!tools.size) return undefined; // Disabled telemetry does not inspect metadata.
  if (!fact || typeof fact !== "object") throw new HarnessError("INVALID_MANAGED_BLOCK");
  const toolName = fact.toolName;
  if (typeof toolName !== "string" || !tools.has(toolName) || Object.keys(fact).some((key) => key !== "toolName")) throw new HarnessError("INVALID_MANAGED_BLOCK");
  const harnessAlerts = pending.filter((alert) => alert.source === "harness");
  if (harnessAlerts.length >= COMMUNICATION_LIMITS.harness_owner_alerts ||
      harnessAlerts.filter((alert) => alert.run.record.agent_id === run.record.agent_id).length >= COMMUNICATION_LIMITS.harness_agent_alerts) return undefined;
  const message = `Managed authority blocked '${toolName}' on two distinct calls. Reasons and operation equivalence are unknown; coverage is partial. Parent: assess whether to steer this task or report the limit.`;
  if (!alertAdmissionBudget(message).fits) throw new HarnessError("ALERT_TOO_LARGE", { limit: COMMUNICATION_LIMITS.envelope_bytes });
  const alert = Object.freeze({ run, message, source: "harness" as const });
  pending.push(alert);
  return alert;
}

/** Derived 1-based rank across ALL retained Runs for this Agent. Label and
 * current task never replace the original assignment's identity. */
export function taskOrdinal(run: CommunicationRun, runs: readonly CommunicationRun[]): number {
  if (!runs.includes(run)) throw new HarnessError("INVALID_COMMUNICATION_RUN");
  return 1 + runs.filter((candidate) => candidate.record.agent_id === run.record.agent_id &&
    candidate.record.enqueue_sequence < run.record.enqueue_sequence).length;
}
export function finishedCandidates<Run extends CommunicationRun>(runs: readonly Run[]): Run[] {
  const candidates = runs.filter((run) => isCommunicationSettled(run) && !run.finished_presented);
  if (candidates.some((run) => !Number.isSafeInteger(run.settled_seq) || run.settled_seq! <= 0)) {
    throw new HarnessError("INVALID_SETTLEMENT_SEQUENCE");
  }
  return candidates.sort((a, b) => a.settled_seq! - b.settled_seq!);
}

/** Bind once. Each Agent contributes at most one Run. A current continuation
 * suppresses an old question even after its reservation has been released. */
export function defaultObservationTargets<Run extends CommunicationRun>(agents: readonly CommunicationAgent[], runs: readonly Run[],
  admissionEnabled: boolean, ownerHealthy: boolean): Run[] {
  const byId = new Map(runs.map((run) => [run.record.run_id, run]));
  const targets: Run[] = [];
  for (const agent of agents) {
    if (agent.current !== undefined) {
      const current = byId.get(agent.current);
      if (!current || current.record.agent_id !== agent.id) throw new HarnessError("INVALID_COMMUNICATION_RUN");
      if (!terminal(current.record.status)) targets.push(current);
      continue;
    }
    const question = agent.question && byId.get(agent.question.run_id);
    if (admissionEnabled && question && canAnswerQuestion(agent, question, ownerHealthy)) targets.push(question);
  }
  return targets;
}

/** Pure core prefilter. Abort/deadline and snapshot policy belong to the shared
 * scheduler; registration captures reportedBlockAtStart, never consumes it. */
export function communicationReadiness<Run extends CommunicationRun>(options: {
  readonly targets: readonly Run[];
  readonly agents: readonly CommunicationAgent[];
  readonly mode: "all" | "any";
  readonly ownerHealthy: boolean;
  readonly currentBlocked?: string;
  readonly reportedBlockAtStart?: string;
  readonly pending: readonly PendingAlert<Run>[];
  readonly scope: AlertScope<Run>;
}): CoreObservationReason | undefined {
  if (options.currentBlocked !== undefined && options.currentBlocked !== options.reportedBlockAtStart) return "owner_blocked";
  const agents = new Map(options.agents.map((agent) => [agent.id, agent]));
  if (options.targets.some((run) => {
    const agent = agents.get(run.record.agent_id);
    return agent !== undefined && canAnswerQuestion(agent, run, options.ownerHealthy);
  })) return "question";
  const settled = options.targets.filter(isCommunicationSettled);
  if (settled.some((run) => run.record.status === "failed" || run.record.status === "cancelled" || run.record.outcome?.limit_reached)) {
    return "task_issue";
  }
  if (options.targets.length && (options.mode === "any" ? settled.length > 0 : settled.length === options.targets.length)) return "done";
  if (scopedAlerts(options.pending, options.scope).length) return "alert";
  return options.targets.length ? undefined : "nothing_pending";
}

/** Private snapshot provenance retained by the Owner. The publisher receives
 * ONLY data, never these original mutable Run references. Arrays align by index. */
export interface CommunicationCommitSnapshot<Run extends CommunicationRun> {
  readonly data: CommunicationSnapshot;
  /** Original bound Runs aligned with data.tasks, private to the Owner. */
  readonly targets: readonly Run[];
  readonly alerts: readonly PendingAlert<Run>[];
  readonly finished: readonly Run[];
  readonly reportedBlockAtStart?: string;
}
/** Ephemeral validated plan, used synchronously and immediately, never queued. */
export interface CommunicationCommitPlan<Run extends CommunicationRun> {
  readonly alert_indices: readonly number[];
  readonly finished: readonly Run[];
  readonly blocked?: string;
}
function invalidCommit(): never { throw new HarnessError("INVALID_COMMUNICATION_COMMIT"); }
const sameRow = (a: ThinTaskEntry, b: ThinTaskEntry): boolean =>
  a.agent === b.agent && a.task === b.task && a.status === b.status;
/** Compare a projection with a KNOWN original, never discover identity from it. */
const matchesRun = (run: CommunicationRun, row: ThinTaskEntry, runs: readonly CommunicationRun[]): boolean => {
  const record = run.record;
  const status = record.execution_exited && !terminal(record.status) ? "finishing" :
    modelTaskStatus(record.status);
  return record.name === row.agent && taskOrdinal(run, runs) === row.task && status === row.status;
};

/** All checks precede ALL mutation. This is pure, SDK-free reference checking,
 * not an effecting port or a retry loop. The final body was already serialized.
 * reportedBlock itself is deliberately NOT checked: pre-edge A/B both qualify. */
export function validateCommunicationCommit<Run extends CommunicationRun>(options: {
  /** Authoritative original Owner Runs, independently of snapshot projections. */
  readonly runs: readonly Run[];
  readonly pending: readonly PendingAlert<Run>[];
  readonly scope: AlertScope<Run>;
  readonly snapshot: CommunicationCommitSnapshot<Run>;
  readonly references: CommunicationReferences;
  readonly envelope: CommunicationEnvelope;
  readonly currentBlocked?: string;
}): CommunicationCommitPlan<Run> {
  const { pending, snapshot, references, envelope } = options;
  const data = snapshot.data;
  if (data.reason !== envelope.reason || data.alerts.length !== snapshot.alerts.length || data.finished.length !== snapshot.finished.length ||
    snapshot.targets.length !== data.tasks.length || envelope.agents.length !== snapshot.targets.length) invalidCommit();
  const suppressed = data.reason === "aborted" || data.reason === "timeout";
  if (suppressed) {
    if (references.alerts.length || references.finished.length || references.blocked !== undefined ||
      envelope.alerts?.length || envelope.finished?.length) invalidCommit();
    return { alert_indices: [], finished: [] };
  }
  const scoped = scopedAlerts(pending, options.scope);
  const shownAlerts = envelope.alerts ?? [];
  if ((data.reason === "alert" && references.alerts.length === 0) || references.alerts.length !== shownAlerts.length ||
      envelope.alerts_pending !== scoped.length - references.alerts.length) invalidCommit();
  const alert_indices: number[] = [];
  const seenAlerts = new Set<PendingAlert<Run>>();
  for (const [index, reference] of references.alerts.entries()) {
    // Prefix positions also prove uniqueness, integer bounds and FIFO order.
    if (reference !== index) invalidCommit();
    const alert = snapshot.alerts[reference], projected = data.alerts[reference], shown = shownAlerts[index];
    if (!alert || seenAlerts.has(alert) || !projected || !shown || scoped[index] !== alert || alert.message !== projected.message ||
      !options.runs.includes(alert.run) || alert.run.record.name !== projected.agent ||
      taskOrdinal(alert.run, options.runs) !== projected.task ||
      boundedOutput(alert.run.record.description, COMMUNICATION_LIMITS.label_units).text !== projected.label ||
      alert.source !== projected.source || projected.source !== shown.source ||
      projected.message !== shown.message || projected.label !== shown.label ||
      projected.agent !== shown.agent || projected.task !== shown.task) invalidCommit();
    seenAlerts.add(alert);
    alert_indices.push(pending.indexOf(alert));
  }
  const boundIndices = new Map<Run, number>();
  for (const [index, run] of snapshot.targets.entries()) {
    const task = data.tasks[index]!, shown = envelope.agents[index]!;
    if (!task || !shown || boundIndices.has(run) || !options.runs.includes(run) || task.settled !== isCommunicationSettled(run) ||
      !matchesRun(run, task.row, options.runs) || !sameRow(task.row, shown)) invalidCommit();
    boundIndices.set(run, index);
  }
  const seen = new Set<number>();
  for (const reference of references.finished) {
    if (!Number.isSafeInteger(reference) || reference < 0 || reference >= snapshot.finished.length || seen.has(reference)) invalidCommit();
    seen.add(reference);
  }
  const finished: Run[] = [], rows = envelope.finished ?? [];
  if (rows.length > COMMUNICATION_LIMITS.finished) invalidCommit();
  const seenRuns = new Set<Run>();
  let nextRow = 0;
  for (const [index, candidate] of data.finished.entries()) {
    const run = snapshot.finished[index]!;
    if (!candidate || !run || seenRuns.has(run) || !options.runs.includes(run) || !isCommunicationSettled(run) ||
      run.finished_presented || !matchesRun(run, candidate.row, options.runs)) invalidCommit();
    seenRuns.add(run);
    // The explicit link must identify THIS original Run, not another Agent
    // whose display name, per-Agent ordinal and status happen to be equal.
    const targetIndex = boundIndices.get(run);
    if (candidate.task_index !== targetIndex) invalidCommit();
    // Convenience rows are the ordered prefix after excluding bound originals.
    // Position establishes provenance; field equality only checks that known
    // original's projection. One row can never stand in for two original Runs.
    const listed = targetIndex === undefined && nextRow < rows.length;
    const presented = targetIndex !== undefined || listed;
    if (seen.has(index) !== presented) invalidCommit();
    if (!presented) continue;
    if (listed && !sameRow(rows[nextRow++]!, candidate.row)) invalidCommit();
    finished.push(run);
  }
  if (nextRow !== rows.length) invalidCommit();
  if ((envelope.finished_pending ?? 0) !== snapshot.finished.length - finished.length) invalidCommit();
  if (data.reason === "owner_blocked") {
    if (data.blocked === undefined || data.blocked === snapshot.reportedBlockAtStart || references.blocked !== data.blocked ||
        options.currentBlocked !== data.blocked) invalidCommit();
  } else if (references.blocked !== undefined) invalidCommit();
  return { alert_indices: alert_indices.sort((a, b) => b - a), finished,
    ...(references.blocked === undefined ? {} : { blocked: references.blocked }) };
}

/** Caller has just validated, with no await/callback between these steps. Do
 * not export this helper as a model entry or pass it as a plugin callback.
 * Owner fault marker assignment belongs in the same straight-line commit. */
export function applyCommunicationCommit<Run extends CommunicationRun>(pending: PendingAlert<Run>[], plan: CommunicationCommitPlan<Run>): void {
  for (const index of plan.alert_indices) pending.splice(index, 1);
  for (const run of plan.finished) run.finished_presented = true;
}
