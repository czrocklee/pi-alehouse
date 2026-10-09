import assert from "node:assert/strict";
import test from "node:test";
import {
  alertAdmissionBudget, COMMUNICATION_LIMITS, communicationBudget, communicationEnvelopeBytes,
  communicationTextUnits, modelTaskStatus, retainedEnvelopeFixture,
} from "../../dist/core/communication-envelope.js";

// Checked-in, independent transcription of the spec's conservative proof shape.
// This is not a packer, a production observation, or persistent communication state.
function expectedRetainedShape(message) {
  return {
    reason: "nothing_pending",
    action: { type: "agent_answer", agent: "a".repeat(24), task: Number.MAX_SAFE_INTEGER, delivery: "not_delivered" },
    agents: Array.from({ length: 16 }, () => ({
      agent: "a".repeat(24), task: Number.MAX_SAFE_INTEGER, status: "interrupting",
      has_question: true, limit_reached: true, unavailable: true,
      question_truncated: true, result_omitted: true, result_truncated: true,
    })),
    alerts: [{ agent: "a".repeat(24), task: Number.MAX_SAFE_INTEGER, label: "\u0000".repeat(120), message }],
    pending: Array.from({ length: 16 }, () => "a".repeat(24)),
    workers_disabled: true,
    alerts_pending: Number.MAX_SAFE_INTEGER,
    finished_pending: Number.MAX_SAFE_INTEGER,
    response_limit_reached: true,
  };
}

function actualEnvelope(message = "") {
  const fixture = retainedEnvelopeFixture(message, true);
  // The proof action is deliberately impossible. Real send is two units shorter.
  return { ...fixture, action: { ...fixture.action, type: "agent_send" } };
}

function independentBytes(value) {
  const serialized = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] });
  return new TextEncoder().encode(serialized).byteLength;
}

test("model task status translates cancellation without changing retained vocabulary", () => {
  for (const [internal, displayed] of [
    ["queued", "queued"], ["running", "running"], ["cancelling", "interrupting"],
    ["completed", "completed"], ["needs_input", "needs_input"], ["failed", "failed"], ["cancelled", "interrupted"],
  ]) assert.equal(modelTaskStatus(internal), displayed);
});

test("model bounds are frozen separately from general-purpose core capacity", () => {
  assert.deepEqual(COMMUNICATION_LIMITS, {
    agents: 16, pending: 16, finished: 8, text_units: 16384, envelope_bytes: 65536,
    agent_name_units: 24, label_units: 120, child_text_units: 8192, agent_alerts: 16, owner_alerts: 64,
  });
  assert(Object.isFrozen(COMMUNICATION_LIMITS));
  assert.throws(() => { COMMUNICATION_LIMITS.agents = 17; }, TypeError);
});

test("retained proof fixes every control key, 16 complete rows, and 16 pending names", () => {
  const value = retainedEnvelopeFixture("");
  assert.deepEqual(value, expectedRetainedShape(""));
  assert.equal(communicationEnvelopeBytes(value), 5605);
  assert.equal(independentBytes(value), 5605);
  assert(5605 <= 65536 - 8192 * 7);
  for (const row of value.agents) {
    assert.equal(row.agent.length, 24);
    assert.equal(row.task, Number.MAX_SAFE_INTEGER);
    for (const flag of ["has_question", "limit_reached", "unavailable", "question_truncated", "result_omitted", "result_truncated"])
      assert.equal(row[flag], true);
  }
  assert.equal(value.alerts[0].label.length, 120);
  assert.equal(value.alerts_pending, Number.MAX_SAFE_INTEGER);
  assert.equal(value.finished_pending, Number.MAX_SAFE_INTEGER);
  assert(!Object.hasOwn(value, "agents_omitted"));
  assert(!Object.hasOwn(value, "pending_omitted"));
});

for (const [name, message, bytes] of [
  ["NUL", "\u0000".repeat(8192), 62949],
  ["lone high surrogate", "\ud800".repeat(8192), 62949],
  ["lone low surrogate", "\udfff".repeat(8192), 62949],
  ["quote", "\"".repeat(8192), 38373],
  ["backslash", "\\".repeat(8192), 38373],
  ["ASCII", "a".repeat(8192), 13797],
  ["CJK", "字".repeat(8192), 30181],
  ["surrogate pairs", "😀".repeat(4096), 21989],
]) {
  test(`maximal retained controls deliver one complete 8192-unit ${name} alert`, () => {
    const value = retainedEnvelopeFixture(message);
    assert.equal(message.length, 8192);
    assert.deepEqual(value, expectedRetainedShape(message));
    assert.equal(communicationEnvelopeBytes(value), bytes);
    assert.equal(independentBytes(value), bytes);
    assert(bytes <= 65536);
    assert(bytes - 5605 <= 8192 * 7);
    const parsed = JSON.parse(JSON.parse(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] })).content[0].text);
    assert.equal(parsed.alerts[0].message, message, "no replacement, truncation, or omitted alert");
    assert.equal(parsed.agents.length, 16);
    assert.equal(parsed.pending.length, 16);
    const admission = alertAdmissionBudget(message);
    assert.deepEqual(admission, { text_units: 8192, envelope_bytes: bytes + 2096, fits: true });
  });
}

test("all 16 question IDs still fit alongside worst-case controls and the whole alert", () => {
  const value = retainedEnvelopeFixture("\u0000".repeat(8192), true);
  for (const row of value.agents) assert.equal(row.question_id, "q_" + "f".repeat(32));
  assert.equal(communicationEnvelopeBytes(value), 63829);
  assert.equal(independentBytes(value), 63829);
  assert.equal(65536 - communicationEnvelopeBytes(value), 1707);
  assert.equal(communicationTextUnits(value), 8192, "labels and question IDs are not body text");
});

for (const message of ["\0".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192)])
  test(`retained recovery proof includes sixteen fixed-width cursors and empty question fields (${message.charCodeAt(0)})`, () => {
    const value = retainedEnvelopeFixture(message, true, true);
    for (const row of value.agents) {
      assert.match(row.next_cursor, /^r1_[A-Za-z0-9_-]{22}\.2gosa7pa2gv$/);
      assert.equal(row.next_cursor.length, 37); assert.equal(row.question, "");
    }
    assert.equal(communicationEnvelopeBytes(value), 65045);
    assert.equal(independentBytes(value), 65045); assert.equal(65536 - independentBytes(value), 491);
    assert.deepEqual(alertAdmissionBudget(message), { text_units: 8192, envelope_bytes: 65045, fits: true });
    assert.equal(communicationTextUnits(value), 8192, "cursor recovery metadata never spends body units");
  });

test("optional warning bytes do not alter the 65045-byte mandatory fixture or turn it into a seven-flag reservation", () => {
  const retained = retainedEnvelopeFixture("\0".repeat(8192), true, true), before = structuredClone(retained);
  const optional = { ...retained, agents: retained.agents.map((row) => ({ ...row, time_wrapped: true })) };
  assert.equal(communicationEnvelopeBytes(retained), 65045);
  assert.equal(communicationEnvelopeBytes(optional), 65045 + 16 * 22, "an optional flag only spends double-JSON bytes");
  assert(communicationBudget(optional).fits); assert.equal(communicationTextUnits(optional), 8192);
  assert.deepEqual(retained, before);
  assert(retained.agents.every((row) => !Object.hasOwn(row, "time_wrapped")));
  assert.equal(communicationEnvelopeBytes(retainedEnvelopeFixture("\0".repeat(8192), true, true)), 65045);
});

test("admission measures a complete retained envelope, not message-only JSON", () => {
  const message = "\u0000".repeat(8192);
  const admitted = alertAdmissionBudget(message);
  assert.equal(admitted.envelope_bytes, communicationEnvelopeBytes(retainedEnvelopeFixture(message, true, true)));
  assert(admitted.envelope_bytes > communicationEnvelopeBytes({ message }));
  assert.deepEqual(alertAdmissionBudget("x"), { text_units: 1, envelope_bytes: 7702, fits: true });
  assert.equal(alertAdmissionBudget("").fits, false);
  assert.equal(alertAdmissionBudget("a".repeat(8193)).fits, false, "text cap applies even when bytes fit");
  assert.equal(alertAdmissionBudget("\u0000".repeat(16384)).fits, false);
});

test("UTF-16 body accounting includes only questions, results, and alert messages", () => {
  const value = {
    reason: "snapshot", workers_disabled: true, alerts_pending: 2,
    action: { type: "agent_run", agent: "otter", task: 2 },
    agents: [{ agent: "otter", task: 2, status: "running", question_id: "q_" + "f".repeat(32),
      question: "😀", result: "甲😀乙", next_cursor: "opaque cursor", omitted_chars: 99,
      error: "diagnostic", owner_error: "owner diagnostic", unavailable_reason: "not reusable",
      time_wrapped: true, dispatch_notes: ["\0".repeat(120), "\ud800".repeat(120)] }],
    alerts: [{ agent: "otter", task: 1, label: "\u0000".repeat(120), message: "ab" }],
    pending: ["otter"], finished: [{ agent: "otter", task: 1, status: "completed" }], finished_pending: 99,
  };
  assert.equal(communicationTextUnits(value), 2 + 4 + 2);
  assert.deepEqual(communicationBudget(value), { text_units: 8, envelope_bytes: independentBytes(value), fits: true });
});

test("text budget is inclusive and independent of the UTF-8 envelope budget", () => {
  const value = { reason: "snapshot", alerts_pending: 0,
    agents: [{ agent: "otter", task: 1, status: "completed", question: "q".repeat(8192), result: "r".repeat(8192) }] };
  assert.equal(communicationTextUnits(value), 16384);
  assert(communicationBudget(value).fits);
  value.agents[0].result += "x";
  const budget = communicationBudget(value);
  assert.equal(budget.text_units, 16385);
  assert(budget.envelope_bytes < 65536);
  assert.equal(budget.fits, false);
});

test("a complete worst-case question plus alert cannot both be promised in every envelope", () => {
  const value = actualEnvelope("\u0000".repeat(8192));
  value.agents[0].question = "\ud800".repeat(8192);
  const before = structuredClone(value);
  const budget = communicationBudget(value);
  assert.equal(budget.text_units, 16384);
  assert(budget.envelope_bytes > 65536);
  assert.equal(budget.fits, false);
  assert.deepEqual(value, before, "measurement is not a compacting fallback or consuming packer");
});

test("fat diagnostics spend bytes but not body units and must yield to retained controls", () => {
  const value = actualEnvelope("\u0000".repeat(8192));
  value.agents[0].error = "\u0000".repeat(512);
  value.agents[1].owner_error = "\udfff".repeat(512);
  const before = structuredClone(value);
  assert.equal(communicationTextUnits(value), 8192);
  assert.equal(communicationBudget(value).fits, false);
  assert.deepEqual(value, before, "budget failure never silently drops controls, diagnostics, or an alert");
  delete value.agents[0].error;
  delete value.agents[1].owner_error;
  assert(communicationBudget(value).fits);
});

test("envelope byte ceiling is inclusive and actually measures both JSON layers", () => {
  const value = { reason: "snapshot", agents: [{ agent: "otter", task: 1, status: "running", error: "" }], alerts_pending: 0 };
  const overhead = independentBytes(value);
  value.agents[0].error = "x".repeat(65536 - overhead);
  assert.equal(communicationEnvelopeBytes(value), 65536);
  assert(communicationBudget(value).fits);
  value.agents[0].error += "x";
  assert.equal(communicationEnvelopeBytes(value), 65537);
  assert.equal(communicationBudget(value).fits, false);
  const escaped = { message: "\u0000\ud800\udfff\"\\" };
  assert.equal(communicationEnvelopeBytes(escaped), independentBytes(escaped));
  assert(communicationEnvelopeBytes(escaped) > Buffer.byteLength(JSON.stringify(escaped), "utf8"));
});

for (const [field, limit] of [["agents", 16], ["pending", 16], ["finished", 8], ["alerts", 64]]) {
  test(`${field} cap rejects overflow without silently trimming projection rows`, () => {
    const value = { reason: "snapshot", agents: [], alerts_pending: 0 };
    const item = field === "pending" ? "otter" : field === "alerts" ?
      { agent: "otter", task: 1, label: "", message: "x" } : { agent: "otter", task: 1, status: "completed" };
    value[field] = Array.from({ length: limit }, () => structuredClone(item));
    assert(communicationBudget(value).fits);
    value[field].push(structuredClone(item));
    const before = structuredClone(value);
    assert.equal(communicationBudget(value).fits, false);
    assert.deepEqual(value, before);
  });
}

test("dual JSON serialization errors propagate instead of reporting a misleading size", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const invalid of [undefined, () => {}, Symbol("not JSON"), 1n, cyclic]) {
    assert.throws(() => communicationEnvelopeBytes(invalid), TypeError);
  }
  assert.equal(communicationEnvelopeBytes(null), independentBytes(null));
});

test("proof/admission helpers allocate fresh data and never cache FIFO or presentation state", () => {
  const first = retainedEnvelopeFixture("first", true);
  const second = retainedEnvelopeFixture("second", true);
  assert.notEqual(first, second);
  assert.notEqual(first.agents, second.agents);
  assert.notEqual(first.agents[0], second.agents[0]);
  assert.notEqual(first.alerts[0], second.alerts[0]);
  first.agents.pop();
  first.alerts[0].message = "mutated";
  assert.deepEqual(retainedEnvelopeFixture(""), expectedRetainedShape(""));
  assert.equal(second.agents.length, 16);
  assert.equal(second.alerts[0].message, "second");
  assert.deepEqual(alertAdmissionBudget("next"), alertAdmissionBudget("next"));
});
