import assert from "node:assert/strict";
import { terminal } from "../../dist/core/contracts.js";
import { DELIVERY_LOG_LIMIT, INBOX_CHARS, INBOX_LIMIT } from "../../dist/core/owner-controller.js";

// Test-only invariant pass over the OwnerController's private graph, run from
// the fixture teardown after shutdown so every unit test doubles as an
// invariant fuzzer. TS `private` is compile-time only; the runtime fields are
// read directly and NOTHING here may require a production hook.
// Quiescent-state formulations only (see the audit report, item 3): a latched
// fail-closed owner is legal state, and `reserved_by` is checked in its weak
// form because the answer-reservation window legitimately outlives statuses.

export function assertOwnerInvariants(controller, where = "teardown") {
  const violations = [];
  const bad = (label) => violations.push(label);
  const { runs, agents, requests, deliveries, queue } = controller;
  const { limits } = controller;

  // I1: requests <-> runs bijection (both grow only in admit).
  if (requests.size !== runs.size) bad(`requests size ${requests.size} != runs ${runs.size}`);
  for (const [requestId, runId] of requests) {
    const run = runs.get(runId);
    if (!run || run.record.request_id !== requestId) bad(`requests entry ${requestId}`);
  }
  // I8: admission sequence covers exactly 1..sequence; runs are never evicted.
  if (runs.size !== controller.sequence) bad(`sequence ${controller.sequence} != runs ${runs.size}`);
  const sequences = new Set();
  for (const run of runs.values()) {
    const seq = run.record.enqueue_sequence;
    if (!Number.isInteger(seq) || seq < 1 || seq > controller.sequence || sequences.has(seq)) bad(`enqueue_sequence ${seq}`);
    sequences.add(seq);
  }

  // I2/I3/I11: agent pointers and inboxes.
  let resident = 0;
  for (const agent of agents.values()) {
    if (agent.resident) resident++;
    if (agent.inbox.length > INBOX_LIMIT) bad(`inbox count ${agent.id}`);
    if (agent.inbox.reduce((sum, text) => sum + text.length, 0) > INBOX_CHARS) bad(`inbox chars ${agent.id}`);
    if (agent.current) {
      const current = runs.get(agent.current);
      if (!current || current.record.agent_id !== agent.id || terminal(current.record.status)) bad(`agent.current ${agent.id}`);
    }
    // Weak form only: the reserving run may itself be stopping, and the
    // question's own run is terminal while an answer is queued or running.
    if (agent.question) {
      if (!runs.has(agent.question.run_id)) bad(`question run ${agent.id}`);
      if (agent.question.reserved_by !== undefined && agent.question.reserved_by !== agent.current) bad(`reserved_by ${agent.id}`);
    }
  }
  if (resident > limits.resident) bad(`resident ${resident} > ${limits.resident}`);

  // I4/I5: output accounting — the one cross-structure scalar-vs-fold pair.
  let reservedCount = 0, retainedSum = 0;
  for (const run of runs.values()) {
    if (run.outputReserved) reservedCount++;
    else retainedSum += run.output.text.length;
  }
  if (controller.reservedOutputChars !== reservedCount * limits.output) {
    bad(`reserved ${controller.reservedOutputChars} != ${reservedCount}x${limits.output}`);
  }
  if (controller.retainedOutputChars !== retainedSum) bad(`retained ${controller.retainedOutputChars} != ${retainedSum}`);

  // I6: active counter and its flag pairing.
  let activeCount = 0;
  for (const run of runs.values()) {
    if (run.active) {
      activeCount++;
      if (run.record.execution_exited || run.record.status !== "running") bad(`active ${run.record.run_id}`);
    }
    if (run.record.status === "running" && !run.active && !run.record.execution_exited) bad(`running ${run.record.run_id}`);
  }
  if (controller.active !== activeCount) bad(`active ${controller.active} != ${activeCount}`);

  // I7: queue membership iff queued and not yet exited; no duplicates.
  const inQueue = new Set(queue);
  if (inQueue.size !== queue.length) bad("queue duplicates");
  for (const id of queue) {
    const run = runs.get(id);
    if (!run || run.record.status !== "queued" || run.record.execution_exited) bad(`queue entry ${id}`);
  }
  for (const run of runs.values()) {
    if (run.record.status === "queued" && !run.record.execution_exited && !inQueue.has(run.record.run_id)) {
      bad(`queued not in queue ${run.record.run_id}`);
    }
  }

  // I9: bounded delivery log whose entries name live runs.
  if (deliveries.size > DELIVERY_LOG_LIMIT) bad(`delivery log ${deliveries.size}`);
  for (const entry of deliveries.values()) if (!runs.has(entry.run_id)) bad("delivery names a dead run");

  // I10: settlement sequence lives on each original Run, without a second log.
  const settledSequences = [];
  for (const run of runs.values()) {
    const settled = terminal(run.record.status);
    if (typeof run.finished_presented !== "boolean") bad(`finished bit ${run.record.run_id}`);
    if (run.finished_presented && !settled) bad(`presented unsettled ${run.record.run_id}`);
    if (settled !== (run.settled_seq !== undefined)) bad(`settled sequence presence ${run.record.run_id}`);
    if (run.settled_seq !== undefined) settledSequences.push(run.settled_seq);
  }
  settledSequences.sort((a, b) => a - b);
  if (settledSequences.some((seq, index) => seq !== index + 1)) bad("settlement sequence gaps or duplicates");
  if (controller.settledSeq !== settledSequences.length) bad(`settledSeq ${controller.settledSeq} != ${settledSequences.length}`);

  // Pending alerts retain original Run identity; quotas are derived from the FIFO.
  if (controller.alerts.length > 64) bad("Owner alert quota");
  for (const alert of controller.alerts) {
    if (runs.get(alert.run.record.run_id) !== alert.run) bad("alert names a dead Run");
  }
  for (const agent of agents.values()) {
    if (controller.alerts.filter((alert) => alert.run.record.agent_id === agent.id).length > 16) bad(`Agent alert quota ${agent.id}`);
  }

  // I13/I14: release bookkeeping and closed implications.
  if (!Number.isInteger(controller.cleaning) || controller.cleaning < 0) bad("cleaning counter");
  if (controller.closed) {
    if (!controller.closing) bad("closed without closing");
    if (queue.length) bad("closed with queued work");
    if (controller.active !== 0) bad("closed with active work");
    for (const run of runs.values()) if (!terminal(run.record.status)) bad(`closed with unsettled ${run.record.run_id}`);
  }
  assert.deepEqual(violations, [], `owner invariants (${where}): ${violations.join("; ")}`);
}
