import assert from "node:assert/strict";
import test from "node:test";
import { packCommunication } from "../../dist/core/communication-packer.js";
import { decodeResultCursor, resultCursorKey } from "../../dist/core/result-cursor.js";

// Pure captured-data packing, not Owner lifecycle, publication commit, SDK
// delivery or production migration evidence. Inputs are frozen independently.
const questionId = (n = 1) => `q_${n.toString(16).padStart(32, "0")}`;
const cursorIdentity = Object.freeze({ owner: "11111111-1111-4111-8111-111111111111", generation: "generation-1",
  run: "22222222-2222-4222-8222-222222222222", version: "a".repeat(64) });
const controls = Object.freeze({ has_question: true, limit_reached: true, unavailable: true,
  question_truncated: true, result_omitted: true, result_truncated: true });
const row = (agent = "otter", task = 1, status = "running", flags = {}) => ({ agent, task, status, ...flags });
const task = (entry = row(), rest = {}) => ({ row: entry,
  settled: ["completed", "needs_input", "failed", "interrupted"].includes(entry.status), ...rest });
const alert = (message, ordinal = 1, agent = "otter", label = "") => ({ agent, task: ordinal, label, message });
const window = (text, rest = {}) => ({ text, offset: 0, retained_chars: text.length, total_chars: text.length, ...rest });
const snapshot = (rest = {}) => ({ reason: "snapshot", tasks: [], alerts: [], finished: [], ...rest });
const key = (entry) => `${entry.agent}/${entry.task}/${entry.status}`;
const bytes = (value) => new TextEncoder().encode(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] })).byteLength;
const bodyUnits = (value) => value.agents.reduce((sum, entry) => sum + (entry.question?.length ?? 0) + (entry.result?.length ?? 0), 0) +
  (value.alerts ?? []).reduce((sum, entry) => sum + entry.message.length, 0);
const visibleReason = (reason) => ["snapshot", "done"].includes(reason) ? undefined : reason;
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function pack(input) {
  const before = structuredClone(input); deepFreeze(input);
  const packed = packCommunication(input), { envelope, result, references } = packed;
  assert.deepEqual(input, before, "packing may never mutate a captured snapshot");
  assert.equal(envelope.agents.length, input.tasks.length, "all bound rows remain complete");
  assert.equal(envelope.reason, visibleReason(input.reason));
  assert.equal(Object.hasOwn(envelope, "reason"), visibleReason(input.reason) !== undefined);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(envelope) }]);
  assert.equal(result.details, undefined);
  assert.equal(new TextEncoder().encode(JSON.stringify(result)).byteLength, bytes(envelope));
  assert(bytes(envelope) <= 65536); assert(bodyUnits(envelope) <= 16384);
  assert((envelope.finished?.length ?? 0) <= 8);
  for (const field of ["pending", "agents_omitted", "pending_omitted"]) assert(!Object.hasOwn(envelope, field));
  for (const entry of envelope.agents) {
    for (const field of ["context_tokens", "time_wrapped", "recovery_hint", "recovery", "metadata"]) assert(!Object.hasOwn(entry, field));
    if (entry.result !== undefined) assert(entry.result.length > 0, "no empty result scaffold");
  }
  assert.deepEqual(references.alerts, Array.from({ length: references.alerts.length }, (_, index) => index));
  assert.equal(envelope.alerts_pending ?? 0, input.alerts.length - references.alerts.length);
  assert.equal(Object.hasOwn(envelope, "alerts_pending"), input.alerts.length > references.alerts.length);
  assert.deepEqual(envelope.alerts ?? [], references.alerts.map((index) => input.alerts[index]), "complete FIFO-prefix alerts only");
  assert.equal(new Set(references.finished).size, references.finished.length);
  for (const index of references.finished) {
    assert(Number.isInteger(index) && index >= 0 && index < input.finished.length);
    const candidate = input.finished[index], link = candidate.task_index;
    const bound = link !== undefined && input.tasks[link].settled && key(envelope.agents[link]) === key(candidate.row);
    const listed = (envelope.finished ?? []).some((entry) => key(entry) === key(candidate.row));
    assert(bound || listed, "a reference needs its exact original row shown");
  }
  assert.equal(envelope.finished_pending ?? 0, input.finished.length - references.finished.length);
  assert.equal(Object.hasOwn(envelope, "finished_pending"), input.finished.length > references.finished.length);
  if (input.reason !== "owner_blocked") assert.equal(references.blocked, undefined);
  return packed;
}
function decodeCursor(encoded, identity = cursorIdentity) {
  assert.equal(typeof encoded, "string"); assert.equal(encoded.length, 37);
  const decoded = decodeResultCursor(encoded);
  assert.equal(decoded.key, resultCursorKey(identity));
  return decoded.offset;
}
function maximalSnapshot(message) {
  const tasks = Array.from({ length: 16 }, (_, index) => task(
    row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "interrupting", controls),
    { question_id: questionId(index + 1) }));
  return snapshot({ reason: "alert", workers_disabled: true, tasks,
    action: { type: "agent_send", agent: tasks[0].row.agent, task: Number.MAX_SAFE_INTEGER, delivery: "not_delivered" },
    alerts: [{ ...alert(message, Number.MAX_SAFE_INTEGER, tasks[0].row.agent, "\0".repeat(120)), source: "harness" },
      alert("\0".repeat(8192), Number.MAX_SAFE_INTEGER, tasks[1].row.agent)] });
}
function byteSaturatedSnapshot() {
  const input = maximalSnapshot("\0".repeat(8192)); input.alerts = input.alerts.slice(0, 1); input.tasks[0].question = "q";
  const seed = pack(input).envelope, remaining = 65536 - bytes({ ...seed, response_limit_reached: true });
  assert(remaining > 0 && remaining < 8192);
  const full = structuredClone(input); full.tasks[0].question = "q".repeat(1 + remaining);
  const complete = pack(full);
  assert.equal(complete.envelope.agents[0].question, full.tasks[0].question);
  assert.equal(complete.envelope.response_limit_reached, undefined);
  assert.equal(bytes({ ...complete.envelope, response_limit_reached: true }), 65536);
  return { input: full, complete };
}

test("ordinary snapshot/done omit reason and zero counts, without losing action acceptance/delivery facts", () => {
  assert.deepEqual(pack(snapshot()).envelope, { agents: [] });
  for (const reason of ["snapshot", "done"]) for (const action of [
    { type: "agent_spawn", agent: "otter", task: 1 }, { type: "agent_run", agent: "otter", task: 1 },
    { type: "agent_answer", agent: "otter", task: 1 },
    ...["joined", "steered", "not_delivered"].map(delivery => ({ type: "agent_send", agent: "otter", task: 1, delivery })),
  ]) {
    const original = row("otter", 1, "completed");
    const { envelope, references } = pack(snapshot({ reason, action, tasks: [task(original)],
      finished: [{ row: original, task_index: 0 }] }));
    assert.deepEqual(envelope, { action, agents: [original] });
    assert.deepEqual(references, { alerts: [], finished: [0] });
  }
});

test("positive pending reminders and exceptional events remain visible", () => {
  for (const reason of ["aborted", "owner_blocked", "question", "task_issue", "alert", "nothing_pending", "timeout"]) {
    const input = snapshot({ reason, blocked: "fault-edge", alerts: [alert("event")],
      finished: Array.from({ length: 10 }, (_, index) => ({ row: row("otter", index + 1, "completed") })) });
    const { envelope, references } = pack(input);
    assert.equal(envelope.reason, reason);
    const suppressed = ["aborted", "timeout"].includes(reason);
    assert.equal(envelope.alerts_pending, suppressed ? 1 : undefined);
    assert.equal(envelope.finished_pending, suppressed ? 10 : 2);
    if (reason === "owner_blocked") assert.equal(references.blocked, "fault-edge");
  }
});

for (const message of ["\0".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192)])
  test(`sixteen maximal control rows/tokens preserve a whole worst-byte alert (${message.charCodeAt(0)})`, () => {
    const input = maximalSnapshot(message), { envelope, references, result } = pack(input);
    assert.equal(envelope.reason, "alert"); assert.deepEqual(envelope.action, input.action);
    assert.equal(envelope.workers_disabled, true);
    for (const [index, entry] of envelope.agents.entries()) {
      for (const [field, value] of Object.entries(input.tasks[index].row)) assert.equal(entry[field], value);
      assert.equal(entry.question_id, input.tasks[index].question_id);
    }
    assert.equal(envelope.alerts.length, 1); assert.equal(envelope.alerts[0].message, message);
    assert.equal(envelope.alerts[0].label, "\0".repeat(120));
    assert.equal(envelope.alerts_pending, 1); assert.deepEqual(references.alerts, [0]);
    assert.deepEqual(references.finished, []); assert.equal(bodyUnits(envelope), 8192);
    assert.equal(JSON.parse(result.content[0].text).alerts[0].message, message);
  });

for (const field of ["error", "owner_error", "unavailable_reason"]) for (const length of [512, 513, 2048])
  test(`${field} ${length}-unit diagnostic has a fixed, nonpageable 512-unit projection`, () => {
    const text = `${field}:`.padEnd(length, "x"), input = snapshot({ tasks: [task(row("otter", 1, "failed"), { diagnostics: { [field]: text } })] });
    const first = pack(input), entry = first.envelope.agents[0];
    assert.equal(entry[field], text.slice(0, 512)); assert.equal(first.envelope.response_limit_reached, undefined);
    for (const key of ["next_cursor", "result_omitted", "result_truncated", "omitted_chars"]) assert.equal(entry[key], undefined);
    assert.deepEqual(pack(input), first, "a repeated read cannot recover the diagnostic tail");
  });

test("diagnostic truncation preserves pairs; only actual byte pressure sets response_limit_reached", () => {
  const { envelope } = pack(snapshot({ tasks: [task(row("otter", 1, "failed"), { diagnostics: { error: "x".repeat(511) + "🚀" } })] }));
  assert.equal(envelope.agents[0].error, "x".repeat(511)); assert.equal(envelope.response_limit_reached, undefined);
  const { input, complete } = byteSaturatedSnapshot(), pressured = structuredClone(input);
  pressured.tasks[1].diagnostics = { owner_error: "bounded", unavailable_reason: "bounded" };
  const packed = pack(pressured);
  assert.deepEqual(packed.envelope.agents, complete.envelope.agents);
  assert.equal(packed.envelope.response_limit_reached, true); assert.equal(bytes(packed.envelope), 65536);
  const partial = maximalSnapshot("\0".repeat(8192)); partial.alerts = partial.alerts.slice(0, 1);
  partial.tasks[0].diagnostics = { error: "\0".repeat(2048) };
  const entry = pack(partial).envelope.agents[0];
  assert(entry.error.length > 0 && entry.error.length < 512);
});

test("question priority leaves an unfit alert queued; alert priority reserves the first complete message", () => {
  const base = snapshot({ reason: "question", workers_disabled: true, tasks: [task(row("otter", 2, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "\0".repeat(8192) })], alerts: [alert("\ud800".repeat(8192))] });
  const read = pack(base);
  assert.equal(read.envelope.agents[0].question, base.tasks[0].question);
  assert.equal(read.envelope.agents[0].question_truncated, undefined);
  assert.deepEqual(read.references.alerts, []); assert.equal(read.envelope.alerts_pending, 1);
  const waiting = structuredClone(base); waiting.reason = "alert";
  const { envelope, references } = pack(waiting), entry = envelope.agents[0];
  assert.equal(envelope.alerts[0].message, waiting.alerts[0].message); assert.deepEqual(references.alerts, [0]);
  assert(entry.question.length > 0 && entry.question.length < 8192);
  assert.equal(entry.question, waiting.tasks[0].question.slice(0, entry.question.length));
  assert.equal(entry.question_truncated, true); assert.equal(entry.has_question, true); assert.equal(entry.question_id, questionId());
});

test("full ASCII question plus alert uses 16384 body units and leaves a displaced result addressable", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question: "q".repeat(8192),
    result: window("unshown", { offset: 11, retained_chars: 100, total_chars: 125, cursor: cursorIdentity }),
  })], alerts: [alert("a".repeat(8192), 1, "otter", "\0".repeat(120))] });
  const { envelope, references } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.question, input.tasks[0].question); assert.deepEqual(envelope.alerts, input.alerts);
  assert.equal(bodyUnits(envelope), 16384); assert.deepEqual(references.alerts, [0]);
  assert.equal(entry.result, undefined); assert.equal(entry.result_omitted, true);
  assert.equal(decodeCursor(entry.next_cursor), 11); assert.equal(entry.omitted_chars, 25);
});

test("FIFO packing stops at an unfit head rather than skipping to a smaller tail", () => {
  const input = snapshot({ reason: "alert", tasks: [task(row("otter", 1, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "\0".repeat(4096) })],
  alerts: [alert("first"), alert("\0".repeat(8192), 2), alert("small-tail", 3)] });
  const { envelope, references } = pack(input);
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  assert.deepEqual(envelope.alerts, [input.alerts[0]]); assert.deepEqual(references.alerts, [0]); assert.equal(envelope.alerts_pending, 2);
  const illegalSkip = { ...envelope, alerts: [...envelope.alerts, input.alerts[2]], alerts_pending: 1 };
  assert(bytes(illegalSkip) < 65536 && bodyUnits(illegalSkip) < 16384);
});

test("all question identities and controls remain when multiple worst-byte questions are shortened", () => {
  const input = snapshot({ reason: "question", tasks: Array.from({ length: 3 }, (_, index) =>
    task(row(`worker-${index}`, 1, "needs_input", { has_question: true }), { question_id: questionId(index + 1), question: "\0".repeat(8192) })) });
  const { envelope } = pack(input);
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  for (const [index, entry] of envelope.agents.entries()) {
    assert.equal(entry.question_id, input.tasks[index].question_id); assert.equal(entry.has_question, true);
    assert.equal(entry.question, input.tasks[index].question.slice(0, entry.question.length));
    if (entry.question.length < 8192) assert.equal(entry.question_truncated, true);
  }
  assert(envelope.agents.some(entry => entry.question_truncated));
});

test("abort/timeout preserve action/control facts but no alert/finished bodies or consumption references", () => {
  for (const reason of ["aborted", "timeout"]) {
    const original = row("otter", 3, "completed", { limit_reached: true }), action = { type: "agent_answer", agent: "otter", task: 3 };
    const { envelope, references } = pack(snapshot({ reason, action, workers_disabled: true, blocked: "edge",
      tasks: [task(original)], alerts: [alert("retained", 2)],
      finished: [{ row: { ...original }, task_index: 0 }, { row: row("otter", 1, "failed") }] }));
    assert.deepEqual(envelope.action, action); assert.deepEqual(envelope.agents, [original]);
    assert.equal(envelope.alerts, undefined); assert.equal(envelope.finished, undefined);
    assert.equal(envelope.alerts_pending, 1); assert.equal(envelope.finished_pending, 2);
    assert.deepEqual(references, { alerts: [], finished: [] });
  }
});

test("bound terminal rows link original indices; other same-Agent tasks get separate oldest-first rows", () => {
  const otter = row("otter", 3, "completed"), orca = row("orca", 2, "needs_input", { has_question: true });
  const old = row("otter", 1, "completed"), middle = row("otter", 2, "failed");
  const { envelope, references } = pack(snapshot({ reason: "done", tasks: [task(otter), task(orca)], finished: [
    { row: old }, { row: { ...orca }, task_index: 1 }, { row: { ...otter }, task_index: 0 }, { row: middle },
  ] }));
  assert.deepEqual(envelope.agents, [otter, orca]); assert.deepEqual(envelope.finished, [old, middle]);
  assert.deepEqual(references.finished, [0, 1, 2, 3]); assert.equal(envelope.finished_pending, undefined);
  const unlinked = pack(snapshot({ tasks: [task(otter)], finished: [{ row: { ...otter } }] }));
  assert.deepEqual(unlinked.envelope.finished, [otter], "display equality cannot invent an original-Run link");
});

test("a current row or historical alert never consumes an unshown finished original", () => {
  const current = row("otter", 3, "running"), old = row("otter", 1, "completed");
  const { envelope, references } = pack(snapshot({ reason: "alert", tasks: [task(current),
    task(row("orca", 1, "needs_input", { has_question: true }), { question_id: questionId(), question: "\0".repeat(8192) })],
  alerts: [alert("\0".repeat(8192), 1)], finished: [{ row: old }] }));
  assert.deepEqual(envelope.agents[0], current); assert.equal(envelope.alerts[0].task, 1);
  assert.equal(envelope.finished, undefined); assert.deepEqual(references.finished, []); assert.equal(envelope.finished_pending, 1);
});

test("eight-row finished prefix is independent of bound presentation, including label omission", () => {
  const bound = row("otter", 99, "completed"), input = snapshot({ reason: "done", tasks: [task(bound)],
    finished: [{ row: { ...bound }, task_index: 0 }, ...Array.from({ length: 11 }, (_, index) => ({ row: row("otter", index + 1, "completed") }))] });
  const { envelope, references } = pack(input);
  assert.deepEqual(envelope.finished, input.finished.slice(1, 9).map(entry => entry.row));
  assert.deepEqual(references.finished, Array.from({ length: 9 }, (_, index) => index)); assert.equal(envelope.finished_pending, 3);
  const reminder = pack(snapshot({ reason: "nothing_pending", finished: [{ row: row("otter", 1, "interrupted"), label: "finished task", cancellation_source: "human" }] }));
  assert.equal(reminder.envelope.reason, "nothing_pending"); assert.deepEqual(reminder.envelope.agents, []);
  assert.equal(reminder.envelope.finished[0].label, "finished task"); assert.equal(reminder.envelope.finished[0].cancellation_source, "human");
  assert.deepEqual(reminder.references.finished, [0]); assert.equal(reminder.envelope.finished_pending, undefined);
  const { input: full } = byteSaturatedSnapshot(), pressured = structuredClone(full);
  pressured.tasks[0].question = pressured.tasks[0].question.slice(0, -220);
  pressured.finished = [{ row: row("orca", 1, "completed"), label: "\0".repeat(120) },
    { row: row("dolphin", 1, "completed"), label: "\ud800".repeat(120) }];
  const omitted = pack(pressured);
  assert.deepEqual(omitted.envelope.finished, pressured.finished.map(candidate => candidate.row));
  assert.deepEqual(omitted.references.finished, [0, 1]); assert.equal(omitted.envelope.response_limit_reached, true);
});

test("stable result cursor advances to the actual shown endpoint and EOF removes only the locator", () => {
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window("abcd🚀ef", { offset: 7, retained_chars: 30, total_chars: 42, cursor: cursorIdentity }),
  })] });
  const entry = pack(input).envelope.agents[0];
  assert.equal(entry.result, "abcd🚀ef"); assert.equal(decodeCursor(entry.next_cursor), 15); assert.equal(entry.omitted_chars, 12);
  assert.equal(entry.result_omitted, undefined); assert.equal(entry.result_truncated, undefined);
  const eof = pack(snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window("last", { offset: 6, retained_chars: 10, total_chars: 15, cursor: cursorIdentity }),
  })] })).envelope.agents[0];
  assert.equal(eof.result, "last"); assert.equal(eof.next_cursor, undefined); assert.equal(eof.omitted_chars, 5);
});

const handoffNotice = "Result from pine has been returned to cedar (task 2).";
function noticeOnly(entry, expected) {
  assert.equal(entry.result, expected);
  for (const field of ["result_notice", "result_omitted", "result_truncated", "next_cursor", "omitted_chars"])
    assert(!Object.hasOwn(entry, field), `${field} is not a notice projection`);
}

test("private whole notices use ordinary result priority without changing ordinary stable paging", () => {
  const text = "ordinary result ".repeat(1400), ordinaryIdentity = { ...cursorIdentity, run: "ordinary-run" };
  const input = snapshot({ tasks: [task(row("pine", 1, "completed"), { result_notice: handoffNotice }),
    task(row("otter", 1, "completed"), { result: window(text, { cursor: ordinaryIdentity }) })] });
  const { envelope, result } = pack(input), ordinary = envelope.agents[1];
  noticeOnly(envelope.agents[0], handoffNotice);
  assert.doesNotMatch(result.content[0].text, /result_notice|ordinary-run/);
  const endpoint = 16384 - handoffNotice.length;
  assert.equal(ordinary.result, text.slice(0, endpoint));
  assert.equal(decodeCursor(ordinary.next_cursor, ordinaryIdentity), endpoint);
  assert.equal(ordinary.result_omitted, undefined); assert.equal(ordinary.result_truncated, undefined);
  assert.equal(ordinary.omitted_chars, undefined); assert.equal(envelope.response_limit_reached, true);
  const next = pack(snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window(text.slice(endpoint), { offset: endpoint, retained_chars: text.length,
      total_chars: text.length, cursor: ordinaryIdentity }),
  })] })).envelope;
  assert.equal(next.agents[0].result, text.slice(endpoint));
  assert.equal(next.agents[0].next_cursor, undefined); assert.equal(next.response_limit_reached, undefined);
  for (const status of ["queued", "running", "finishing", "completed", "failed", "interrupted", "needs_input"]) {
    const only = pack(snapshot({ tasks: [task(row("pine", 1, status), { result_notice: handoffNotice })] })).envelope;
    noticeOnly(only.agents[0], handoffNotice);
    assert.equal(only.response_limit_reached, undefined);
  }
  const bounded = pack(snapshot({ tasks: [task(row(), { result_notice: "n".repeat(512) })] })).envelope;
  noticeOnly(bounded.agents[0], "n".repeat(512));
  assert.equal(bounded.response_limit_reached, undefined);
});

test("notice yields whole, never a prefix or cursor, under text and serialized-byte pressure", () => {
  // Earlier ordinary results retain priority; even one missing unit drops the whole notice.
  for (const remaining of [0, handoffNotice.length - 1, handoffNotice.length]) {
    const text = "r".repeat(16384 - remaining);
    const packed = pack(snapshot({ tasks: [task(row("otter", 1, "completed"), {
      result: window(text, { cursor: cursorIdentity }),
    }), task(row("pine", 1, "completed"), { result_notice: handoffNotice })] })).envelope;
    assert.equal(packed.agents[0].result, text);
    noticeOnly(packed.agents[1], remaining === handoffNotice.length ? handoffNotice : undefined);
    assert.equal(packed.response_limit_reached, remaining === handoffNotice.length ? undefined : true);
  }
  // Questions and alerts precede both result kinds, rather than notices reserving body space.
  const crowded = pack(snapshot({ tasks: [task(row("pine", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question: "q".repeat(8192), result_notice: handoffNotice,
  })], alerts: [alert("a".repeat(8192))] })).envelope;
  assert.equal(crowded.agents[0].question.length, 8192); assert.equal(crowded.alerts[0].message.length, 8192);
  noticeOnly(crowded.agents[0], undefined); assert.equal(crowded.response_limit_reached, true);
  const { input } = byteSaturatedSnapshot(), baseline = structuredClone(input);
  delete baseline.tasks[1].row.result_omitted; delete baseline.tasks[1].row.result_truncated;
  const seed = pack(structuredClone(baseline)).envelope;
  baseline.tasks[0].question += "q".repeat(65536 - bytes({ ...seed, response_limit_reached: true }));
  const complete = pack(baseline), pressured = structuredClone(baseline);
  pressured.tasks[1].result_notice = handoffNotice;
  const omitted = pack(pressured);
  assert.deepEqual(omitted.envelope.agents, complete.envelope.agents);
  noticeOnly(omitted.envelope.agents[1], undefined);
  assert.equal(omitted.envelope.response_limit_reached, true); assert.equal(bytes(omitted.envelope), 65536);
});

test("invalid private notice shapes, mixed result windows and result flags reject without publication", () => {
  const invalid = [
    ...[null, false, 1, {}, [], "", " \n\t", "n".repeat(513)].map(result_notice =>
      snapshot({ tasks: [task(row(), { result_notice })] })),
    snapshot({ tasks: [task(row(), { result_notice: handoffNotice, result: window("") })] }),
    snapshot({ tasks: [task(row("pine", 1, "completed"), {
      result_notice: handoffNotice, result: window("raw", { cursor: cursorIdentity }),
    })] }),
    ...["result_omitted", "result_truncated"].map(flag =>
      snapshot({ tasks: [task(row("pine", 1, "completed", { [flag]: true }), { result_notice: handoffNotice })] })),
    snapshot({ tasks: [task(row("pine", 1, "completed", { result_notice: handoffNotice }))] }),
  ];
  for (const input of invalid) {
    const before = structuredClone(input); deepFreeze(input); let published;
    assert.throws(() => { published = packCommunication(input); }, { code: "INVALID_COMMUNICATION_SNAPSHOT" });
    assert.equal(published, undefined); assert.deepEqual(input, before);
  }
});

test("empty result windows omit result scaffolding but retain controls and real unshown-text cursors", () => {
  for (const status of ["running", "completed", "failed", "interrupted", "needs_input"]) {
    const settled = status !== "running", input = snapshot({ tasks: [task(row("otter", 1, status), {
      result: window("", settled ? { cursor: cursorIdentity } : {}),
    })] });
    const entry = pack(input).envelope.agents[0];
    for (const field of ["result", "result_omitted", "result_truncated", "next_cursor"]) assert(!Object.hasOwn(entry, field));
  }
  const unshown = pack(snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window("", { offset: 3, retained_chars: 10, total_chars: 10, cursor: cursorIdentity }),
  })] })).envelope.agents[0];
  assert.equal(unshown.result, undefined); assert.equal(unshown.result_omitted, true); assert.equal(decodeCursor(unshown.next_cursor), 3);
  const partial = pack(snapshot({ tasks: [task(row("otter", 1, "failed", { result_truncated: true }), {
    result: window("", { total_chars: 15, cursor: cursorIdentity }), diagnostics: { error: "failed after partial output" },
  })] })).envelope.agents[0];
  assert.equal(partial.result, undefined); assert.equal(partial.result_truncated, true); assert.equal(partial.omitted_chars, 15);
  assert.equal(partial.error, "failed after partial output");
});

test("body-limited stable page backs off a pair boundary; live preview uses truncation instead of a cursor", () => {
  const text = "r".repeat(8190) + "🚀tail", offset = 23;
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question: "q".repeat(8192), result: window(text, { offset,
      retained_chars: offset + text.length + 100, total_chars: offset + text.length + 133, cursor: cursorIdentity }),
  })], alerts: [alert("a")] });
  const entry = pack(input).envelope.agents[0];
  assert.equal(entry.result, "r".repeat(8190)); assert(entry.result.isWellFormed());
  assert.equal(decodeCursor(entry.next_cursor), offset + entry.result.length); assert.equal(entry.omitted_chars, 33);
  assert.equal(entry.result_truncated, undefined);
  const live = snapshot({ tasks: [task(row(), { question: "q".repeat(8192), result: window("l".repeat(10000),
    { retained_chars: 20000, total_chars: 30000 }) })], alerts: [alert("a")] });
  const preview = pack(live).envelope.agents[0];
  assert.equal(preview.result, "l".repeat(8191)); assert.equal(preview.result_truncated, true);
  assert.equal(preview.next_cursor, undefined); assert.equal(preview.omitted_chars, 10000);
});

for (const message of ["\0".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192)])
  test(`worst-byte alert cannot displace sixteen original stable-result locators (${message.charCodeAt(0)})`, () => {
    const tasks = Array.from({ length: 16 }, (_, index) => task(
      row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "needs_input", controls), {
        question_id: questionId(index + 1), question: "Q".repeat(8192),
        result: window("retained", { offset: Number.MAX_SAFE_INTEGER - 1000, retained_chars: Number.MAX_SAFE_INTEGER,
          total_chars: Number.MAX_SAFE_INTEGER, cursor: { ...cursorIdentity, run: `old-run-${index}` } }),
      }));
    const { envelope } = pack(snapshot({ reason: "alert", tasks, workers_disabled: true,
      alerts: [alert(message, Number.MAX_SAFE_INTEGER, "a".repeat(24), "\0".repeat(120))] }));
    assert.equal(envelope.alerts[0].message, message);
    for (const [index, entry] of envelope.agents.entries())
      assert.equal(decodeCursor(entry.next_cursor, tasks[index].result.cursor), tasks[index].result.offset + (entry.result?.length ?? 0));
  });

for (const [name, glyph, byteLimited] of [["ASCII", "a", false], ["CJK", "字", false], ["NUL", "\0", true], ["backslash", "\\", true]])
  test(`long ${name} result obeys both budgets with an exact real next_cursor`, () => {
    const text = glyph.repeat(20000), input = snapshot({ tasks: [task(row("otter", 1, "completed"), {
      result: window(text, { cursor: cursorIdentity }),
    })] });
    const { envelope } = pack(input), entry = envelope.agents[0];
    assert.equal(entry.result, text.slice(0, entry.result.length)); assert.equal(entry.result_omitted, undefined);
    assert.equal(entry.result_truncated, undefined); assert.equal(entry.omitted_chars, undefined);
    assert.equal(decodeCursor(entry.next_cursor), entry.result.length); assert.equal(envelope.response_limit_reached, true);
    if (byteLimited) { assert(entry.result.length < 16384); assert(bytes(envelope) > 65536 - 7); }
    else assert.equal(entry.result.length, 16384);
  });

test("fault references are emitted only with the actual exceptional owner_blocked reason", () => {
  const fault = pack(snapshot({ reason: "owner_blocked", blocked: "fault-edge" }));
  assert.equal(fault.references.blocked, "fault-edge");
  assert.equal(pack(snapshot({ blocked: "fault-edge" })).references.blocked, undefined);
});

test("malformed controls, action facts, window identities and alert provenance reject without publication", () => {
  const invalid = [
    snapshot({ tasks: Array.from({ length: 17 }, (_, index) => task(row(`a${index}`))) }),
    ...["a".repeat(25), "Not-An-Agent", "otter\n"].map(agent => snapshot({ tasks: [task(row(agent))] })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(ordinal => snapshot({ tasks: [task(row("otter", ordinal))] })),
    snapshot({ tasks: [task(row("otter", 1, "settled"))] }),
    snapshot({ tasks: [task(row("otter", 1, "running", { unavailable: false }))] }),
    snapshot({ tasks: [task(row("otter", 1, "running", { error: "not thin" }))] }),
    snapshot({ tasks: [task(row(), { question_id: "q_bad" })] }),
    snapshot({ action: { type: "agent_send", agent: "otter", task: 1, delivery: "answered" } }),
    snapshot({ workers_disabled: false }), snapshot({ reason: "alert" }), snapshot({ reason: "owner_blocked" }),
    snapshot({ tasks: [task(row("otter", 1, "completed"), { result: window("stable without identity") })] }),
    snapshot({ tasks: [task(row(), { result: window("live", { cursor: cursorIdentity }) })] }),
    snapshot({ tasks: [task(row("otter", 1, "completed"), { settled: false })] }),
    ...[{ offset: -1 }, { retained_chars: 2 }, { retained_chars: 4, total_chars: 3 }].map(rest =>
      snapshot({ tasks: [task(row("otter", 1, "completed"), { result: window("abc", { cursor: cursorIdentity, ...rest }) })] })),
    snapshot({ alerts: [alert("x".repeat(8193))] }),
    ...["child", "system", false, null, 1].map(source => snapshot({ alerts: [{ ...alert("kept"), source }] })),
    snapshot({ alerts: [{ ...alert("kept"), kind: "managed_block" }] }),
    snapshot({ tasks: [task(row())], finished: [{ row: row("otter", 1, "completed"), task_index: 0 }] }),
    snapshot({ tasks: [task(row("otter", 2, "completed"))], finished: [{ row: row("otter", 1, "completed"), task_index: 0 }] }),
  ];
  for (const input of invalid) {
    const before = structuredClone(input); deepFreeze(input); let published;
    assert.throws(() => { published = packCommunication(input); }, { code: "INVALID_COMMUNICATION_SNAPSHOT" });
    assert.equal(published, undefined); assert.deepEqual(input, before);
  }
});

test("queued wait is mandatory whole control metadata, never provider telemetry or an optional diagnostic", () => {
  for (const wait of ["dependencies", "capacity"]) {
    const packed = pack(snapshot({ tasks: [task(row("otter", 1, "queued", { wait }))], alerts: [alert("kept")] }));
    assert.equal(packed.envelope.agents[0].wait, wait); assert.deepEqual(packed.references, { alerts: [0], finished: [] });
  }
  for (const status of ["running", "interrupting", "finishing", "completed", "needs_input", "failed", "interrupted"])
    assert.throws(() => packCommunication(snapshot({ tasks: [task(row("otter", 1, status, { wait: "dependencies" }))] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
  for (const wait of ["provider", "openai/gpt-4", "concurrency", "4", 4, "", "Dependencies", null, false, ["dependencies"]])
    assert.throws(() => packCommunication(snapshot({ tasks: [task(row("otter", 1, "queued", { wait }))] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
  const tasks = Array.from({ length: 16 }, (_, index) => task(row(`worker-${index}`, 1, "queued", { ...controls, wait: "dependencies" }),
    { question_id: questionId(index + 1), question: "Q".repeat(8192), diagnostics: { error: "\0".repeat(512) } }));
  const { envelope } = pack(snapshot({ reason: "alert", tasks, alerts: [alert("\0".repeat(8192))] }));
  assert(envelope.agents.every(entry => entry.wait === "dependencies" && entry.status === "queued"));
  assert.equal(envelope.response_limit_reached, true);
});

test("host-only telemetry is never projected, even if supplied by a stale structural snapshot", () => {
  const plain = snapshot({ tasks: [task(row("otter", 1, "failed"), {
    result: window("result", { cursor: cursorIdentity }), diagnostics: { error: "failure" },
  })] });
  const expected = pack(plain), legacy = structuredClone(plain);
  Object.assign(legacy.tasks[0], { context_tokens: 391000, time_wrapped: true, recovery_hint: "host-only hint" });
  assert.deepEqual(pack(legacy), expected, "hidden telemetry spends no bytes and cannot cause packing loss");
  for (const field of ["context_tokens", "time_wrapped", "recovery_hint"]) {
    assert.throws(() => packCommunication(snapshot({ tasks: [task(row("otter", 1, "failed", { [field]: true }))] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
    assert.throws(() => packCommunication(snapshot({ finished: [{ row: row("otter", 1, "failed", { [field]: true }) }] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
  }
});

test("only actionable tree_shared notes are shown, before serialization and without hidden-note packing loss", () => {
  const plain = pack(snapshot({ tasks: [task(row())] }));
  for (const notes of [[], ["tree_lock_unknown"], ["source_state_unknown"], ["tree_lock_unknown", "source_state_unknown"]])
    assert.deepEqual(pack(snapshot({ tasks: [task(row(), { dispatch_notes: notes })] })), plain);
  const input = snapshot({ tasks: [task(row(), { dispatch_notes: ["source_state_unknown", "tree_shared"] })] });
  const packed = pack(input); assert.deepEqual(packed.envelope.agents[0].dispatch_notes, ["tree_shared"]);
  assert.deepEqual(JSON.parse(packed.result.content[0].text).agents[0].dispatch_notes, ["tree_shared"]);
  assert.notEqual(packed.envelope.agents[0].dispatch_notes, input.tasks[0].dispatch_notes);
  const { input: full, complete } = byteSaturatedSnapshot(), pressured = structuredClone(full);
  for (const entry of pressured.tasks) entry.dispatch_notes = ["tree_shared"];
  const omitted = pack(pressured);
  assert.equal(omitted.envelope.response_limit_reached, true); assert.equal(bytes(omitted.envelope), 65536);
  assert.deepEqual(omitted.envelope.agents, complete.envelope.agents); assert.deepEqual(omitted.references, complete.references);
});

for (const notes of ["tree_shared", null, ["a", "b", "c"], ["x".repeat(121)], [""], [" "], [42], [null], [undefined], Array(1)])
  test(`malformed bounded dispatch notes reject (${JSON.stringify(notes)})`, () => {
    assert.throws(() => packCommunication(snapshot({ tasks: [task(row(), { dispatch_notes: notes })] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
  });

test("labels precede results without losing controls", () => {
  const label = "\0".repeat(120);
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), { label,
    result: window("r".repeat(20000), { cursor: cursorIdentity }) }), task(row("orca", 1, "completed"), { label: "second label" })] });
  const { envelope } = pack(input);
  assert.equal(envelope.agents[0].label, label); assert.equal(envelope.agents[1].label, "second label");
  assert.equal(envelope.agents[0].result.length, 16384); assert.equal(envelope.response_limit_reached, true);
});

test("whole summary fields and human cancellation detach from input and yield independently at byte saturation", () => {
  const metadata = { label: "\ud800".repeat(120), cancellation_source: "human" };
  const input = snapshot({ tasks: [task(row(), metadata)] }), packed = pack(input);
  for (const field of ["label", "cancellation_source"]) assert.deepEqual(packed.envelope.agents[0][field], metadata[field]);
  assert.equal(bodyUnits(packed.envelope), 0); assert.equal(packed.envelope.response_limit_reached, undefined);
  const { input: full, complete } = byteSaturatedSnapshot(), saturated = structuredClone(full);
  for (const entry of saturated.tasks) Object.assign(entry, metadata);
  const omitted = pack(saturated);
  assert.deepEqual(omitted.envelope.agents, complete.envelope.agents); assert.deepEqual(omitted.references, complete.references);
  assert.equal(omitted.envelope.response_limit_reached, true); assert.equal(bytes(omitted.envelope), 65536);
});

for (const metadata of [{ label: "x".repeat(121) }, { label: null }, { label: 42 },
  { cancellation_source: "model" }])
  test(`malformed optional summary rejects before publication (${JSON.stringify(metadata)})`, () => {
    assert.throws(() => packCommunication(snapshot({ tasks: [task(row(), metadata)] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
  });

test("all eighty mixed-source alerts fit in FIFO order; overflow fails without an alias or eviction", () => {
  const alerts = Array.from({ length: 80 }, (_, index) => ({ ...alert(`message-${index}`, index + 1), ...(index < 16 ? { source: "harness" } : {}) }));
  const packed = pack(snapshot({ reason: "alert", alerts }));
  assert.deepEqual(packed.envelope.alerts, alerts); assert.equal(packed.envelope.alerts_pending, undefined);
  assert.throws(() => packCommunication(snapshot({ alerts: [...alerts, alert("eighty-first")] })), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
});

test("packing is deterministic and independent across invocations with no output-array mutation of input", () => {
  const input = snapshot({ reason: "alert", tasks: [task(row())], alerts: [alert("repeatable")], finished: [{ row: row("otter", 1, "completed") }] });
  const first = pack(input), second = pack(input);
  assert.deepEqual(first, second); assert.notEqual(first.result, second.result);
  assert.notEqual(first.envelope.agents, second.envelope.agents); assert.notEqual(first.references.alerts, second.references.alerts);
  assert(Object.isFrozen(input)); assert(Object.isFrozen(input.alerts[0]));
});
