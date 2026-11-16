import assert from "node:assert/strict";
import test from "node:test";
import { modelOutcomeReason } from "../../dist/orchestration/core/communication-envelope.js";
import { communicationRow } from "../../dist/orchestration/core/owner-projection.js";

// Focused source of the bounded terminal outcome-reason projection: the shared
// mapper later reused by parent list/interrupt, and the shared thin-row
// projection rule (true settled terminal rows only). Packer shape validation,
// commit provenance and budget retention are covered by their own lanes.

const knownReasons = [
  "turn_limit",
  "output_limit",
  "context_change_failed",
  "dependency_not_completed",
  "dependency_input_missing",
  "dispatch_preflight_failed",
  "unexpected_abort",
  "execution_error",
  "finalization_failed",
  "input_not_observed",
];

test("every current core outcome reason projects to itself, never to a decoder or a rename", () => {
  for (const reason of knownReasons) assert.equal(modelOutcomeReason(reason), reason);
  // The projected vocabulary is closed: "other" stays "other" instead of
  // double-mapping or resurrecting a historical raw reason.
  assert.equal(modelOutcomeReason("other"), "other");
});

test("any other nonempty reason projects to other; no raw historical string passes through", () => {
  for (const raw of [
    "deadline",
    "length",
    "EXECUTION_ERROR",
    "execution_error ",
    " execution_error",
    "turn_limit\0",
    "a".repeat(4096),
    " ",
    "\t\n",
  ])
    assert.equal(modelOutcomeReason(raw), "other");
});

test("absent, empty and non-string reasons project to no fact", () => {
  for (const absent of [undefined, "", null, false, 0, 42, {}, [], Symbol("reason")])
    assert.equal(modelOutcomeReason(absent), undefined);
});

const source = (record = {}) => ({
  record: {
    owner_id: "owner",
    generation: "generation",
    run_id: "run",
    agent_id: "agent",
    name: "otter",
    description: "original label",
    status: "failed",
    phase: "settled",
    execution_exited: true,
    outcome: { limit_reached: false },
    dispatch_notes: [],
    limit_reached: false,
    ...record,
  },
});
const agent = { id: "agent", resident: true };

test("the shared row projection carries a reason only on true settled terminal rows", () => {
  for (const [reason, projected] of [
    ...knownReasons.map((reason) => [reason, reason]),
    ["unknown historical fault", "other"],
  ]) {
    const row = communicationRow(
      source({ outcome: { limit_reached: false, reason } }),
      agent,
      1,
      true,
      undefined,
    );
    assert.equal(row.status, "failed");
    assert.equal(row.outcome_reason, projected);
    assert.equal(Object.hasOwn(row, "queued_for"), false);
  }
  // Reasonless settled rows, including an explicit empty reason, stay bare.
  for (const outcome of [{ limit_reached: false }, { limit_reached: false, reason: "" }]) {
    const row = communicationRow(source({ outcome }), agent, 1, true, undefined);
    assert.equal(row.status, "failed");
    assert.equal(Object.hasOwn(row, "outcome_reason"), false);
  }
});

test("finalizing, queued and running rows never show an installed outcome reason early", () => {
  const reason = { limit_reached: false, reason: "finalization_failed" };
  // A finalizing Run may already hold its Outcome, but settlement has not
  // installed the terminal phase: its row is "finishing" and stays bare.
  const finalizing = communicationRow(
    source({ status: "cancelling", phase: "finalizing", outcome: reason }),
    agent,
    1,
    true,
    undefined,
  );
  assert.deepEqual(finalizing, { agent: "otter", task: 1, status: "finishing" });
  for (const [status, phase, queued_for] of [
    ["queued", "queued", "dependencies"],
    ["running", "executing", undefined],
  ]) {
    const row = communicationRow(
      source({ status, phase, execution_exited: false, outcome: reason }),
      agent,
      1,
      true,
      queued_for,
    );
    assert.equal(row.status, status);
    assert.equal(row.outcome_reason, undefined);
    assert.equal(row.queued_for, queued_for);
  }
  // An exited record whose settled phase is not installed yet is not a
  // settled terminal fact either: no reason may leak from outcome alone.
  const exited = communicationRow(
    source({ phase: "finalizing", outcome: reason }),
    agent,
    1,
    true,
    undefined,
  );
  assert.equal(exited.status, "failed");
  assert.equal(Object.hasOwn(exited, "outcome_reason"), false);
});

test("settled completed, needs-input and cancelled rows without reasons stay bare", () => {
  for (const status of ["completed", "needs_input", "cancelled"]) {
    const row = communicationRow(source({ status }), agent, 1, true, undefined);
    assert.equal(row.status, status === "cancelled" ? "interrupted" : status);
    assert.equal(Object.hasOwn(row, "outcome_reason"), false);
  }
});
