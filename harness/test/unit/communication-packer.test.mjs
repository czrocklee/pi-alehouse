import assert from "node:assert/strict";
import test from "node:test";
import { packCommunication } from "../../dist/core/communication-packer.js";
import { decodeResultCursor, resultCursorKey } from "../../dist/core/result-cursor.js";

// Pure packing of captured ordinary data. These are not live Owner/FIFO,
// publication-commit, SDK delivery, or production migration evidence.
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
const decodeCursor = (encoded) => {
  assert.equal(typeof encoded, "string", "a stable partial page must provide a next_cursor");
  const decoded = decodeResultCursor(encoded);
  assert.equal(decoded.key, resultCursorKey(cursorIdentity), "compact locator binds the captured Owner/generation/Run/version");
  return { ...cursorIdentity, offset: decoded.offset };
};
const bytes = (envelope) => new TextEncoder().encode(JSON.stringify({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
})).byteLength;
const bodyUnits = (envelope) => envelope.agents.reduce((sum, entry) =>
  sum + (entry.question?.length ?? 0) + (entry.result?.length ?? 0), 0) +
  (envelope.alerts ?? []).reduce((sum, entry) => sum + entry.message.length, 0);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function pack(input) {
  const before = structuredClone(input);
  deepFreeze(input);
  const packed = packCommunication(input), { envelope, result, references } = packed;
  assert.deepEqual(input, before, "packing may never mutate captured snapshot data");
  assert.equal(envelope.agents.length, input.tasks.length, "no bound task row may be silently omitted");
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(envelope) }]);
  assert.equal(result.details, undefined);
  assert.equal(new TextEncoder().encode(JSON.stringify(result)).byteLength, bytes(envelope), "measure the actual final content envelope");
  assert(bytes(envelope) <= 65536, "both JSON escaping layers must fit the UTF-8 byte budget");
  assert(bodyUnits(envelope) <= 16384, "question/result/message alone spend the UTF-16 body budget");
  assert((envelope.finished?.length ?? 0) <= 8);
  assert(!Object.hasOwn(envelope, "agents_omitted"));
  assert(!Object.hasOwn(envelope, "pending_omitted"));
  assert.deepEqual(references.alerts, Array.from({ length: references.alerts.length }, (_, index) => index), "alert refs are snapshot FIFO prefix indices");
  assert.equal(envelope.alerts_pending, input.alerts.length - references.alerts.length);
  assert.deepEqual(envelope.alerts ?? [], references.alerts.map((index) => input.alerts[index]), "referenced alerts are displayed completely");
  assert.equal(new Set(references.finished).size, references.finished.length);
  for (const index of references.finished) {
    assert(Number.isInteger(index) && index >= 0 && index < input.finished.length);
    const candidate = input.finished[index];
    const link = candidate.task_index;
    const displayedBound = link !== undefined && input.tasks[link].settled && key(envelope.agents[link]) === key(candidate.row);
    const displayedFinished = (envelope.finished ?? []).some((entry) => key(entry) === key(candidate.row));
    assert(displayedBound || displayedFinished, "finished ref must identify an exact original task explicitly shown");
  }
  if (envelope.finished_pending !== undefined)
    assert.equal(envelope.finished_pending, input.finished.length - references.finished.length);
  if (input.reason !== "owner_blocked") assert.equal(references.blocked, undefined);
  return packed;
}

function maximalSnapshot(message) {
  const tasks = Array.from({ length: 16 }, (_, index) => task(
    row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "interrupting", controls),
    { question_id: questionId(index + 1) }));
  return snapshot({ reason: "alert", workers_disabled: true, tasks,
    action: { type: "agent_send", agent: tasks[0].row.agent, task: Number.MAX_SAFE_INTEGER, delivery: "not_delivered" },
    alerts: [alert(message, Number.MAX_SAFE_INTEGER, tasks[0].row.agent, "\u0000".repeat(120)),
      alert("\u0000".repeat(8192), Number.MAX_SAFE_INTEGER, tasks[1].row.agent)] });
}

test("16 complete maximal control rows and tokens still fit a complete worst-case 8192-unit alert", () => {
  for (const message of ["\u0000".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192)]) {
    const input = maximalSnapshot(message), { envelope, references, result } = pack(input);
    assert.equal(envelope.reason, "alert"); assert.deepEqual(envelope.action, input.action);
    assert.equal(envelope.workers_disabled, true);
    assert.deepEqual(envelope.pending, input.tasks.map((entry) => entry.row.agent));
    for (const [index, entry] of envelope.agents.entries()) {
      for (const [field, value] of Object.entries(input.tasks[index].row)) assert.equal(entry[field], value);
      assert.equal(entry.question_id, input.tasks[index].question_id);
    }
    assert.equal(envelope.alerts.length, 1); assert.equal(envelope.alerts[0].message, message);
    assert.equal(envelope.alerts[0].label, "\u0000".repeat(120));
    assert.equal(envelope.alerts_pending, 1); assert.deepEqual(references.alerts, [0]);
    assert.deepEqual(references.finished, []); assert.equal(bodyUnits(envelope), 8192);
    assert.equal(JSON.parse(result.content[0].text).alerts[0].message, message, "serialization preserves lone surrogate/NUL units too");
  }
});

// A diagnostic cap is a fixed projection, not a pageable result or evidence
// that another cursorless read can recover its tail. Only envelope pressure
// below the bounded projection belongs to response_limit_reached.
for (const field of ["error", "owner_error", "unavailable_reason"]) for (const length of [512, 513, 2048]) {
  test(`${field} at ${length} units projects the same 512-unit prefix on repeated reads without a response-limit flag`, () => {
    const text = `${field}:`.padEnd(length, "x");
    const input = snapshot({ tasks: [task(row("otter", 1, "failed"), { diagnostics: { [field]: text } })] });
    const first = pack(input), second = pack(input), entry = first.envelope.agents[0];
    assert.equal(entry[field], text.slice(0, 512));
    assert.equal(entry[field].length, 512);
    assert.equal(first.envelope.response_limit_reached, undefined, "the fixed cap alone is not envelope pressure");
    assert.equal(entry.next_cursor, undefined, "diagnostics have no result continuation");
    assert.equal(entry.result_omitted, undefined); assert.equal(entry.result_truncated, undefined);
    assert.equal(entry.omitted_chars, undefined, "diagnostic clipping is not lost retained result text");
    assert.deepEqual(second, first, "an unchanged cursorless read repeats the same diagnostic prefix, never the tail");
  });
}

test("the fixed diagnostic cap preserves a surrogate pair boundary without inventing envelope pressure", () => {
  const text = "x".repeat(511) + "🚀";
  const input = snapshot({ tasks: [task(row("otter", 1, "failed"), { diagnostics: { error: text } })] });
  const { envelope } = pack(input);
  assert.equal(text.length, 513);
  assert.equal(envelope.agents[0].error, "x".repeat(511));
  assert.equal(envelope.agents[0].error.isWellFormed(), true);
  assert.equal(envelope.response_limit_reached, undefined, "compare fitted text with the already bounded 511-unit prefix");
});

test("envelope pressure that shortens a bounded diagnostic still sets response_limit_reached", () => {
  const input = maximalSnapshot("\u0000".repeat(8192));
  input.alerts = input.alerts.slice(0, 1); // No omitted alert or other packing loss can set the flag.
  assert.equal(pack(input).envelope.response_limit_reached, undefined);
  const pressured = structuredClone(input);
  pressured.tasks[0].diagnostics = { error: "\u0000".repeat(2048) };
  const { envelope } = pack(pressured), entry = envelope.agents[0];
  assert(entry.error.length > 0 && entry.error.length < 512, "actual byte pressure shortens even the fixed projection");
  assert.equal(entry.error, pressured.tasks[0].diagnostics.error.slice(0, entry.error.length));
  assert.equal(envelope.response_limit_reached, true);
  assert.deepEqual(envelope.alerts, input.alerts, "the complete alert remains reserved");
  const fullBounded = { ...envelope, agents: envelope.agents.map((current, index) => index === 0 ?
    { ...current, error: "\u0000".repeat(512) } : current) };
  assert(bytes(fullBounded) > 65536, "the bounded diagnostic genuinely cannot fit in the envelope");
});

test("entirely suppressed bounded diagnostics set the response-limit flag even with every body and control fully fitted", () => {
  const input = maximalSnapshot("\u0000".repeat(8192));
  input.alerts = input.alerts.slice(0, 1);
  input.tasks[0].question = "q";
  const seed = pack(input).envelope;
  assert.equal(seed.response_limit_reached, undefined);
  const remaining = 65536 - bytes({ ...seed, response_limit_reached: true });
  assert(Number.isSafeInteger(remaining) && remaining > 0);
  const full = structuredClone(input);
  full.tasks[0].question = "q".repeat(1 + remaining);
  const complete = pack(full).envelope;
  assert.equal(complete.agents[0].question, full.tasks[0].question);
  assert.equal(complete.response_limit_reached, undefined);
  assert.equal(bytes({ ...complete, response_limit_reached: true }), 65536, "all bytes are used, including the reserved flag");
  const pressured = structuredClone(full);
  pressured.tasks[1].diagnostics = { owner_error: "bounded", unavailable_reason: "bounded" };
  const { envelope } = pack(pressured);
  assert.equal(envelope.agents[1].owner_error, undefined);
  assert.equal(envelope.agents[1].unavailable_reason, undefined);
  assert.deepEqual(envelope.agents, complete.agents, "diagnostic suppression does not change any fitted task facts or body");
  assert.deepEqual(envelope.alerts, complete.alerts);
  assert.equal(envelope.response_limit_reached, true, "missing bounded diagnostics are the sole envelope limitation");
  assert.equal(bytes(envelope), 65536);
});

test("two fat diagnostic fields yield to complete alerts, all task controls, and pending names", () => {
  const input = maximalSnapshot("\u0000".repeat(8192));
  input.tasks[0].diagnostics = { error: "\u0000".repeat(512) };
  input.tasks[1].diagnostics = { owner_error: "\udfff".repeat(512), unavailable_reason: "not reusable" };
  const { envelope, references } = pack(input);
  assert.deepEqual(references.alerts, [0]); assert.equal(envelope.alerts[0].message, input.alerts[0].message);
  assert.deepEqual(envelope.pending, input.tasks.map((entry) => entry.row.agent));
  for (const [index, entry] of envelope.agents.entries()) {
    for (const [flag, value] of Object.entries(controls)) assert.equal(entry[flag], value);
    assert.equal(entry.question_id, input.tasks[index].question_id);
  }
  assert(envelope.agents[0].error !== input.tasks[0].diagnostics.error ||
    envelope.agents[1].owner_error !== input.tasks[1].diagnostics.owner_error, "both complete fat diagnostics cannot fit alongside the retained layer");
  assert.equal(envelope.response_limit_reached, true);
});

test("labels and question tokens do not spend body units: the full 16384-unit ASCII question plus alert fits", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "q".repeat(8192), result: window("displaced", { cursor: cursorIdentity }) })],
  alerts: [alert("a".repeat(8192), 1, "otter", "\u0000".repeat(120))] });
  const { envelope, references } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.question, input.tasks[0].question); assert.equal(entry.question_id, questionId());
  assert.equal(envelope.alerts[0].message, input.alerts[0].message);
  assert.equal(bodyUnits(envelope), 16384); assert.deepEqual(references.alerts, [0]);
  assert.equal(entry.result_omitted, true); assert.equal(entry.result ?? "", "");
});

test("non-alert question priority keeps the full question and leaves an unfit alert pending", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 2, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "\u0000".repeat(8192) })], alerts: [alert("\u0000".repeat(8192))] });
  const { envelope, references } = pack(input);
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  assert.equal(envelope.agents[0].question_id, questionId());
  assert.equal(envelope.agents[0].question_truncated, undefined);
  assert.deepEqual(envelope.alerts ?? [], []); assert.equal(envelope.alerts_pending, 1);
  assert.deepEqual(references.alerts, []);
});

test("alert reason reserves its first whole message before truncating a competing question", () => {
  const input = snapshot({ reason: "alert", tasks: [task(row("otter", 2, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "\u0000".repeat(8192) })], alerts: [alert("\ud800".repeat(8192))] });
  const { envelope, references } = pack(input), entry = envelope.agents[0];
  assert.equal(envelope.alerts[0].message, input.alerts[0].message); assert.deepEqual(references.alerts, [0]);
  assert(entry.question.length > 0 && entry.question.length < 8192);
  assert.equal(entry.question, input.tasks[0].question.slice(0, entry.question.length));
  assert.equal(entry.question_truncated, true); assert.equal(entry.has_question, true);
  assert.equal(entry.question_id, questionId()); assert.equal(envelope.response_limit_reached, true);
});

test("FIFO packing stops at a large unfit message instead of skipping to a later small one", () => {
  const input = snapshot({ reason: "alert", tasks: [task(row("otter", 1, "needs_input", { has_question: true }),
    { question_id: questionId(), question: "\u0000".repeat(4096) })],
  alerts: [alert("first"), alert("\u0000".repeat(8192), 2), alert("small-tail", 3)] });
  const { envelope, references } = pack(input);
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  assert.deepEqual(envelope.alerts, [input.alerts[0]]); assert.deepEqual(references.alerts, [0]);
  assert.equal(envelope.alerts_pending, 2);
  const illegalSkip = { ...envelope, alerts: [...envelope.alerts, input.alerts[2]], alerts_pending: 1 };
  assert(bytes(illegalSkip) < 65536 && bodyUnits(illegalSkip) < 16384, "the tail could fit, but skipping the FIFO head is forbidden");
});

test("question tokens remain visible on every bound row even when later question bodies are truncated", () => {
  const input = snapshot({ reason: "question", tasks: Array.from({ length: 3 }, (_, index) =>
    task(row(`worker-${index}`, 1, "needs_input", { has_question: true }),
      { question_id: questionId(index + 1), question: "\u0000".repeat(8192) })) });
  const { envelope } = pack(input);
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  for (const [index, entry] of envelope.agents.entries()) {
    assert.equal(entry.question_id, input.tasks[index].question_id); assert.equal(entry.has_question, true);
    const shown = entry.question ?? "";
    assert.equal(shown, input.tasks[index].question.slice(0, shown.length));
    if (shown.length < 8192) assert.equal(entry.question_truncated, true);
  }
  assert(envelope.agents.some((entry) => entry.question_truncated === true));
});

test("a read snapshot returns one full worst-case question even with historical alerts pending and workers Off", () => {
  const original = row("otter", 2, "needs_input", { has_question: true });
  const input = snapshot({ workers_disabled: true,
    tasks: [task(original, { question_id: questionId(), question: "\udfff".repeat(8192) })],
    alerts: [alert("\u0000".repeat(8192), 1)], finished: [{ row: { ...original }, task_index: 0 }] });
  const { envelope, references } = pack(input);
  assert.equal(envelope.reason, "snapshot"); assert.equal(envelope.action, undefined);
  assert.equal(envelope.workers_disabled, true); assert.equal(envelope.agents[0].question_id, questionId());
  assert.equal(envelope.agents[0].question, input.tasks[0].question);
  assert.equal(envelope.agents[0].question_truncated, undefined);
  assert.deepEqual(references.alerts, []); assert.equal(envelope.alerts_pending, 1);
  assert.deepEqual(references.finished, [0], "displayed settled question row identifies its exact original task");
});

test("abort/timeout retain accepted action and controls but never include alerts, finished bodies, or presentation refs", () => {
  for (const reason of ["aborted", "timeout"]) {
    const original = row("otter", 3, "completed", { limit_reached: true });
    const action = { type: "agent_answer", agent: "otter", task: 3 };
    const input = snapshot({ reason, action, workers_disabled: true, blocked: "edge",
      tasks: [task(original)], alerts: [alert("retained", 2)],
      finished: [{ row: { ...original }, task_index: 0 }, { row: row("otter", 1, "failed") }] });
    const { envelope, references } = pack(input);
    assert.equal(envelope.reason, reason); assert.deepEqual(envelope.action, action);
    assert.equal(envelope.workers_disabled, true); assert.deepEqual(envelope.agents[0], original);
    assert.deepEqual(envelope.alerts ?? [], []); assert.deepEqual(envelope.finished ?? [], []);
    assert.equal(envelope.alerts_pending, 1);
    assert.deepEqual(references.alerts, []); assert.deepEqual(references.finished, []);
    assert.equal(references.blocked, undefined);
  }
});

test("same Agent's running task/pending name/old alert never consume an unshown finished task", () => {
  const current = row("otter", 3, "running"), old = row("otter", 1, "completed");
  const input = snapshot({ reason: "alert", tasks: [task(current),
    task(row("orca", 1, "needs_input", { has_question: true }), { question_id: questionId(), question: "\u0000".repeat(8192) })],
  alerts: [alert("\u0000".repeat(8192), 1)], finished: [{ row: old }] });
  const { envelope, references } = pack(input);
  assert.deepEqual(envelope.agents[0], current); assert.deepEqual(envelope.pending, ["otter"]);
  assert.equal(envelope.alerts[0].task, 1, "old alert identity is not finished presentation");
  assert.deepEqual(envelope.finished ?? [], [], "finished convenience row must yield to the packed question/message");
  assert.deepEqual(references.finished, []); assert.equal(envelope.finished_pending, 1);
});

test("bound terminal rows mark only exact snapshot task indices; other same-Agent ordinals appear separately", () => {
  const otter = row("otter", 3, "completed"), orca = row("orca", 2, "needs_input", { has_question: true });
  const old = row("otter", 1, "completed"), middle = row("otter", 2, "failed");
  const input = snapshot({ reason: "done", tasks: [task(otter), task(orca)], finished: [
    { row: old }, { row: { ...orca }, task_index: 1 }, { row: { ...otter }, task_index: 0 }, { row: middle },
  ] });
  const { envelope, references } = pack(input);
  assert.deepEqual(envelope.agents, [otter, orca]);
  assert.deepEqual(envelope.finished, [old, middle], "already bound exact task rows are not duplicated under finished");
  assert.deepEqual([...references.finished].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(envelope.finished_pending, 0);
});

test("unlinked finished candidates need their own rows even when display fields match a bound task", () => {
  const current = row("otter", 3, "completed"), old = row("otter", 1, "completed");
  const input = snapshot({ reason: "done", tasks: [task(current)], finished: [{ row: old }, { row: { ...current } }] });
  const { envelope, references } = pack(input);
  assert.deepEqual(envelope.agents, [current]);
  assert.deepEqual(envelope.finished, [old, current], "equal display fields cannot substitute for an original-Run link");
  assert.deepEqual(references.finished, [0, 1]);
  assert.equal(envelope.finished_pending, 0);
});

test("an unlinked same-name/task/status candidate remains unpresented when its own finished row cannot fit", () => {
  const bound = row("otter", 1, "completed");
  const input = snapshot({ tasks: [task(bound, { result: window("\u0000".repeat(16000), { cursor: cursorIdentity }) })],
    finished: [{ row: { ...bound } }] });
  const { envelope, references } = pack(input);
  assert(envelope.agents[0].result.length > 0 && envelope.agents[0].result.length < 16000);
  assert(envelope.agents[0].next_cursor);
  assert.equal(envelope.finished, undefined);
  assert.deepEqual(references.finished, []); assert.equal(envelope.finished_pending, 1);
});

test("finished convenience list shows at most eight oldest rows; bound presentation does not steal its cap", () => {
  const bound = row("otter", 99, "completed");
  const input = snapshot({ reason: "done", tasks: [task(bound)], finished: [{ row: { ...bound }, task_index: 0 },
    ...Array.from({ length: 11 }, (_, index) => ({ row: row("otter", index + 1, "completed") }))] });
  const { envelope, references } = pack(input);
  assert.deepEqual(envelope.finished, input.finished.slice(1, 9).map((entry) => entry.row));
  assert.equal(envelope.finished.length, 8);
  assert.deepEqual([...references.finished].sort((a, b) => a - b), Array.from({ length: 9 }, (_, index) => index));
  assert.equal(envelope.finished_pending, 3);
});

test("nothing_pending can display and reference a finished convenience reminder without inventing task readiness", () => {
  const input = snapshot({ reason: "nothing_pending", finished: [{ row: row("otter", 1, "interrupted") }] });
  const { envelope, references } = pack(input);
  assert.equal(envelope.reason, "nothing_pending"); assert.deepEqual(envelope.agents, []);
  assert.deepEqual(envelope.finished, [input.finished[0].row]); assert.deepEqual(references.finished, [0]);
  assert.equal(envelope.finished_pending, 0);
});

test("a fully shown requested terminal window retains the next cursor and reports only never-retained omissions", () => {
  const text = "abcd🚀ef", offset = 7, retained = 30, total = 42;
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window(text, { offset, retained_chars: retained, total_chars: total, cursor: cursorIdentity }),
  })] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.result, text);
  assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: offset + text.length });
  assert.equal(entry.omitted_chars, total - retained, "requested paging is not lost output");
  assert.equal(entry.result_omitted, undefined); assert.equal(entry.result_truncated, undefined);
});

test("a terminal window ending at retained end omits its cursor but still reports original retention loss", () => {
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), {
    result: window("last", { offset: 6, retained_chars: 10, total_chars: 15, cursor: cursorIdentity }),
  })] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.result, "last"); assert.equal(entry.next_cursor, undefined);
  assert.equal(entry.omitted_chars, 5); assert.equal(entry.result_omitted, undefined);
});

test("body-limited terminal page backs off a surrogate boundary and advances only by the units actually shown", () => {
  const text = "r".repeat(8190) + "🚀tail", offset = 23, retained = offset + text.length + 100;
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question: "q".repeat(8192),
    result: window(text, { offset, retained_chars: retained, total_chars: retained + 33, cursor: cursorIdentity }),
  })], alerts: [alert("a")] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.question, input.tasks[0].question); assert.equal(envelope.alerts[0].message, "a");
  assert.equal(entry.result, "r".repeat(8190), "8191-unit capacity must not leave half of 🚀");
  assert.equal(entry.result.isWellFormed(), true);
  assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: offset + entry.result.length });
  assert.equal(entry.omitted_chars, 33); assert.equal(entry.result_omitted, undefined);
  assert.equal(entry.result_truncated, undefined, "stable output pages use an exact next_cursor, not a live preview flag");
});

test("byte-limited terminal page keeps the complete alert and an exact cursor without relabeling displaced text as lost", () => {
  const text = "\u0000".repeat(8192), offset = 9, retained = offset + text.length + 20;
  const input = snapshot({ reason: "alert", tasks: [task(row("otter", 2, "completed"), {
    result: window(text, { offset, retained_chars: retained, total_chars: retained + 77, cursor: cursorIdentity }),
  })], alerts: [alert("\udfff".repeat(8192), 1)] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(envelope.alerts[0].message, input.alerts[0].message);
  assert(entry.result.length > 0 && entry.result.length < text.length);
  assert.equal(entry.result, text.slice(0, entry.result.length));
  assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: offset + entry.result.length });
  assert.equal(entry.omitted_chars, 77); assert.equal(entry.result_omitted, undefined);
  assert.equal(envelope.response_limit_reached, true);
});

test("a wholly displaced result sets result_omitted and cannot move its stable cursor past unshown text", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question: "q".repeat(8192),
    result: window("unshown", { offset: 11, retained_chars: 100, total_chars: 125, cursor: cursorIdentity }),
  })], alerts: [alert("a".repeat(8192))] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(bodyUnits(envelope), 16384);
  assert.equal(entry.result ?? "", ""); assert.equal(entry.result_omitted, true);
  assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: 11 });
  assert.equal(entry.omitted_chars, 25); assert.equal(entry.question_id, questionId());
});

for (const message of ["\0".repeat(8192), "\ud800".repeat(8192), "\udfff".repeat(8192)])
  test(`mandatory alert and all sixteen omitted stable-result cursors survive worst-byte pressure ${message.charCodeAt(0)}`, () => {
    const tasks = Array.from({ length: 16 }, (_, index) => task(
      row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "needs_input", controls), {
        question_id: questionId(index + 1), question: "Q".repeat(8192),
        result: window("retained", { offset: Number.MAX_SAFE_INTEGER - 1000, retained_chars: Number.MAX_SAFE_INTEGER,
          total_chars: Number.MAX_SAFE_INTEGER, cursor: { ...cursorIdentity, run: `old-run-${index}` } }),
      }));
    const { envelope } = pack(snapshot({ reason: "alert", tasks, workers_disabled: true,
      alerts: [alert(message, Number.MAX_SAFE_INTEGER, "a".repeat(24), "\0".repeat(120))] }));
    assert.equal(envelope.alerts[0].message, message);
    for (const [index, entry] of envelope.agents.entries()) {
      const decoded = decodeResultCursor(entry.next_cursor);
      assert.equal(decoded.key, resultCursorKey(tasks[index].result.cursor));
      assert.equal(decoded.offset, tasks[index].result.offset + (entry.result?.length ?? 0));
      assert.equal(entry.next_cursor.length, 37);
    }
  });

test("single read preserves a full worst-byte question while reserving a terminal recovery cursor", () => {
  const question = "\0".repeat(8192), output = "\ud800".repeat(16384);
  const { envelope } = pack(snapshot({ tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    question_id: questionId(), question, result: window(output, { cursor: cursorIdentity }),
  })], alerts: [alert("\0".repeat(8192))] }));
  const entry = envelope.agents[0];
  assert.equal(entry.question, question); assert.equal(entry.question_truncated, undefined);
  assert.equal(envelope.alerts, undefined);
  assert.equal(decodeCursor(entry.next_cursor).offset, entry.result?.length ?? 0);
});

test("a shortened live preview has result_truncated, not a fabricated stable cursor or retention loss", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "running", { has_question: true }), {
    question: "q".repeat(8192), result: window("l".repeat(10000), { retained_chars: 20000, total_chars: 30000 }),
  })], alerts: [alert("a")] });
  const { envelope } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.result, "l".repeat(8191));
  assert.equal(entry.result_truncated, true); assert.equal(entry.result_omitted, undefined);
  assert.equal(entry.next_cursor, undefined); assert.equal(entry.omitted_chars, 10000);
});

test("fault commit reference exists only for an envelope actually reporting owner_blocked", () => {
  const input = snapshot({ reason: "owner_blocked", blocked: "fault-edge" });
  const first = pack(input);
  assert.equal(first.envelope.reason, "owner_blocked"); assert.equal(first.references.blocked, "fault-edge");
  const second = pack(snapshot({ blocked: "fault-edge" }));
  assert.equal(second.envelope.reason, "snapshot"); assert.equal(second.references.blocked, undefined);
  const third = pack(snapshot({ reason: "question", blocked: "fault-edge",
    tasks: [task(row("otter", 1, "needs_input", { has_question: true }), { question_id: questionId(), question: "decide?" })] }));
  assert.equal(third.references.blocked, undefined);
});

test("malformed retained controls fail instead of trimming/normalizing bad snapshots or mutating them", () => {
  const base = () => snapshot({ tasks: [task(row())] });
  const malformed = [
    { name: "17 bound rows", input: snapshot({ tasks: Array.from({ length: 17 }, (_, index) => task(row(`a${index}`))) }) },
    { name: "overlong name", change: (input) => { input.tasks[0].row.agent = "a".repeat(25); } },
    { name: "invalid name alphabet", change: (input) => { input.tasks[0].row.agent = "Not-An-Agent"; } },
    { name: "trailing newline name", change: (input) => { input.tasks[0].row.agent = "otter\n"; } },
    { name: "zero task ordinal", change: (input) => { input.tasks[0].row.task = 0; } },
    { name: "unsafe task ordinal", change: (input) => { input.tasks[0].row.task = Number.MAX_SAFE_INTEGER + 1; } },
    { name: "unknown status", change: (input) => { input.tasks[0].row.status = "settled"; } },
    { name: "false true-only flag", change: (input) => { input.tasks[0].row.unavailable = false; } },
    { name: "diagnostic in retained layer", change: (input) => { input.tasks[0].row.error = "not a thin control"; } },
    { name: "invalid question token", change: (input) => { input.tasks[0].question_id = "q_bad"; } },
    { name: "retired send answer delivery", change: (input) => { input.action = { type: "agent_send", agent: "otter", task: 1, delivery: "answered" }; } },
    { name: "false workers-disabled flag", change: (input) => { input.workers_disabled = false; } },
  ];
  for (const entry of malformed) {
    const input = entry.input ?? base(); entry.change?.(input);
    const before = structuredClone(input); deepFreeze(input);
    assert.throws(() => packCommunication(input), undefined, entry.name);
    assert.deepEqual(input, before, entry.name);
  }
});

test("inconsistent windows, oversize alerts, and wrong finished links fail without any returned reference candidate", () => {
  const terminal = row("otter", 2, "completed");
  const invalid = [
    snapshot({ tasks: [task(terminal, { result: window("x", { offset: -1, cursor: cursorIdentity }) })] }),
    snapshot({ tasks: [task(terminal, { result: window("stable output without paging identity") })] }),
    snapshot({ tasks: [task(row(), { result: window("live preview", { cursor: cursorIdentity }) })] }),
    snapshot({ tasks: [task(terminal, { settled: false })] }),
    snapshot({ tasks: [task(terminal, { result: window("abc", { retained_chars: 2, total_chars: 3, cursor: cursorIdentity }) })] }),
    snapshot({ tasks: [task(terminal, { result: window("x", { retained_chars: 3, total_chars: 2, cursor: cursorIdentity }) })] }),
    snapshot({ alerts: [alert("x".repeat(8193))] }),
    snapshot({ tasks: [task(terminal)], finished: [{ row: row("otter", 1, "completed"), task_index: 0 }] }),
    snapshot({ tasks: [task(row("otter", 2, "running"))], finished: [{ row: terminal, task_index: 0 }] }),
  ];
  for (const input of invalid) {
    const before = structuredClone(input); deepFreeze(input);
    assert.throws(() => packCommunication(input));
    assert.deepEqual(input, before);
  }
});

for (const [name, glyph, byteLimited] of [["ASCII", "a", false], ["CJK", "字", false], ["NUL", "\0", true], ["backslash", "\\", true]]) {
  test(`time warning precedes a long ${name} result while its cursor advances only by shown units`, () => {
    const text = glyph.repeat(20000), plain = snapshot({ tasks: [task(row("otter", 1, "completed"), {
      result: window(text, { cursor: cursorIdentity }),
    })] });
    const baseline = pack(plain), flagged = structuredClone(plain); flagged.tasks[0].time_wrapped = true;
    const { envelope } = pack(flagged), entry = envelope.agents[0];
    assert.equal(entry.time_wrapped, true, "result byte saturation cannot hide an already fitted warning attempt");
    assert.equal(entry.result, text.slice(0, entry.result.length));
    assert.equal(entry.result_omitted, undefined); assert.equal(entry.omitted_chars, undefined);
    assert.equal(entry.result_truncated, undefined, "stable paging uses the reserved original result cursor");
    assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: entry.result.length });
    assert.equal(entry.next_cursor.length, 37); assert.equal(envelope.response_limit_reached, true);
    if (byteLimited) {
      assert(entry.result.length < 16384);
      assert(entry.result.length < baseline.envelope.agents[0].result.length, "flag bytes reduce the page rather than being appended beyond the limit");
      assert(bytes(envelope) <= 65536 && bytes(envelope) > 65536 - 7, "packing still uses the available whole-glyph bytes");
    } else {
      assert.equal(entry.result.length, 16384); assert.equal(entry.result, baseline.envelope.agents[0].result);
    }
    assert.equal(bodyUnits(envelope), entry.result.length, "warning metadata does not spend body units");
  });
}

test("a full ASCII question and FIFO alert keep their bodies before an optional warning, even with an omitted result cursor", () => {
  const input = snapshot({ reason: "question", tasks: [task(row("otter", 1, "needs_input", { has_question: true }), {
    time_wrapped: true, question_id: questionId(), question: "Q".repeat(8192),
    result: window("retained", { offset: 5, retained_chars: 20, total_chars: 20, cursor: cursorIdentity }),
  })], alerts: [alert("A".repeat(8192))] });
  const { envelope, references } = pack(input), entry = envelope.agents[0];
  assert.equal(entry.question, input.tasks[0].question); assert.equal(envelope.alerts[0].message, input.alerts[0].message);
  assert.equal(bodyUnits(envelope), 16384); assert.deepEqual(references.alerts, [0]);
  assert.equal(entry.time_wrapped, true); assert.equal(entry.result_omitted, true);
  assert.deepEqual(decodeCursor(entry.next_cursor), { ...cursorIdentity, offset: 5 });
});

test("sixteen optional warnings can fit without displacing the mandatory worst-byte alert or reserved original cursors", () => {
  const tasks = Array.from({ length: 16 }, (_, index) => task(
    row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "needs_input", controls), {
      time_wrapped: true, question_id: questionId(index + 1),
      result: window("", { offset: Number.MAX_SAFE_INTEGER - 1000, retained_chars: Number.MAX_SAFE_INTEGER,
        total_chars: Number.MAX_SAFE_INTEGER, cursor: { ...cursorIdentity, run: `reserved-${index}` } }),
    }));
  const input = snapshot({ reason: "alert", tasks, workers_disabled: true,
    action: { type: "agent_send", agent: tasks[0].row.agent, task: Number.MAX_SAFE_INTEGER, delivery: "not_delivered" },
    alerts: [alert("\0".repeat(8192), Number.MAX_SAFE_INTEGER, tasks[0].row.agent, "\0".repeat(120))] });
  const { envelope } = pack(input);
  assert.equal(envelope.alerts[0].message, input.alerts[0].message);
  assert.equal(envelope.agents.length, 16);
  for (const [index, entry] of envelope.agents.entries()) {
    assert.equal(entry.time_wrapped, true);
    for (const [flag, value] of Object.entries(controls)) assert.equal(entry[flag], value);
    assert.equal(entry.next_cursor.length, 37);
    const decoded = decodeResultCursor(entry.next_cursor);
    assert.equal(decoded.key, resultCursorKey(tasks[index].result.cursor)); assert.equal(decoded.offset, tasks[index].result.offset);
  }
});

test("all task warning attempts are tried before any task's results or string diagnostics", () => {
  const tasks = [task(row("otter", 1, "completed"), { time_wrapped: true,
    result: window("\0".repeat(20000), { cursor: cursorIdentity }), diagnostics: { error: "\0".repeat(512) }, dispatch_notes: ["tree_shared"] }),
  task(row("orca", 1, "completed"), { time_wrapped: true,
    result: window("second", { offset: 5, retained_chars: 11, total_chars: 11, cursor: { ...cursorIdentity, run: "second" } }) }),
  task(row("dolphin", 1, "failed"), { time_wrapped: true, diagnostics: { owner_error: "\0".repeat(512) } })];
  const { envelope } = pack(snapshot({ tasks }));
  assert(envelope.agents.every((entry) => entry.time_wrapped === true), "a later task's warning must not wait behind the first result");
  assert((envelope.agents[0].error?.length ?? 0) < 512, "only remaining bytes may hold a diagnostic prefix");
  assert.equal(envelope.agents[0].dispatch_notes, undefined);
  assert((envelope.agents[2].owner_error?.length ?? 0) < 512, "string diagnostics remain below every warning attempt");
  const shown = envelope.agents[1].result ?? "";
  assert.equal(shown, "second".slice(0, shown.length));
  if (shown.length < 6) {
    assert.equal(decodeResultCursor(envelope.agents[1].next_cursor).offset, 5 + shown.length);
    assert.equal(decodeResultCursor(envelope.agents[1].next_cursor).key, resultCursorKey(tasks[1].result.cursor));
  } else {
    // Reaching EOF releases the reserved cursor's bytes; a small second result
    // and a short diagnostic prefix can then fit without displacing any flag.
    assert.equal(envelope.agents[1].next_cursor, undefined);
  }
  assert.equal(envelope.agents[2].next_cursor, undefined, "the flag introduces no result/notes recovery locator");
});

test("all warning attempts also precede a byte-saturating collection of string diagnostics", () => {
  const tasks = Array.from({ length: 16 }, (_, index) => task(row(`worker-${index}`, 1, "failed"), {
    time_wrapped: true, diagnostics: { error: "\0".repeat(512), owner_error: "\0".repeat(512), unavailable_reason: "\0".repeat(512) },
    dispatch_notes: ["\0".repeat(120)],
  }));
  const { envelope } = pack(snapshot({ tasks }));
  assert(envelope.agents.every((entry) => entry.time_wrapped === true));
  assert(envelope.agents.some((entry) => entry.error === undefined || entry.error.length < 512));
  assert.equal(envelope.response_limit_reached, true);
  assert(envelope.agents.every((entry) => entry.next_cursor === undefined && entry.limit_reached === undefined));
});

test("without a warning the rich question/alert/result/diagnostic publication bytes stay unchanged", () => {
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), { question_id: questionId(), question: "question",
    result: window("result", { cursor: cursorIdentity }), diagnostics: { error: "error" }, dispatch_notes: ["note"] })], alerts: [alert("alert")] });
  const expected = { reason: "snapshot", agents: [{ agent: "otter", task: 1, status: "completed", question_id: questionId(),
    question: "question", result: "result", error: "error", dispatch_notes: ["note"] }], alerts_pending: 0, finished_pending: 0, alerts: [alert("alert")] };
  const before = pack(input);
  assert.equal(before.result.content[0].text, JSON.stringify(expected), "preserve the prior key order, bodies and optional diagnostics exactly");
  const explicitUndefined = structuredClone(input); explicitUndefined.tasks[0].time_wrapped = undefined;
  assert.deepEqual(pack(explicitUndefined), before);
});

test("dispatch notes and time warning roundtrip as whole optional diagnostics, not body text or thin flags", () => {
  const notes = ["tree_shared", "x".repeat(118) + "🚀"];
  const input = snapshot({ tasks: [task(row("otter", 1, "completed"), { time_wrapped: true, dispatch_notes: notes })],
    finished: [{ row: row("otter", 1, "completed"), task_index: 0 }] });
  const first = pack(input), entry = first.envelope.agents[0];
  assert.equal(entry.time_wrapped, true); assert.deepEqual(entry.dispatch_notes, notes);
  assert.equal(entry.dispatch_notes[1].length, 120); assert.equal(bodyUnits(first.envelope), 0);
  assert.equal(entry.next_cursor, undefined); assert.equal(entry.result_omitted, undefined);
  assert.equal(first.envelope.response_limit_reached, undefined);
  assert.deepEqual(first.envelope.finished ?? [], [], "linked presentation still uses the thin original task identity");
  assert.deepEqual(JSON.parse(first.result.content[0].text).agents[0].dispatch_notes, notes);
  assert.notEqual(entry.dispatch_notes, input.tasks[0].dispatch_notes);
  entry.dispatch_notes[0] = "changed output";
  assert.equal(input.tasks[0].dispatch_notes[0], "tree_shared");
  assert.deepEqual(pack(input).envelope.agents[0].dispatch_notes, notes, "a later locatable observation can try to display the original notes again");
});

test("absent/empty optional notes preserve existing packed bytes without adding metadata or recovery cursors", () => {
  const input = snapshot({ tasks: [task(row())] }), before = pack(input);
  for (const rest of [{ time_wrapped: undefined, dispatch_notes: undefined }, { dispatch_notes: [] }]) {
    const next = pack(snapshot({ tasks: [task(row(), rest)] }));
    assert.deepEqual(next, before);
    assert.equal(next.envelope.agents[0].dispatch_notes, undefined);
    assert.equal(next.envelope.agents[0].time_wrapped, undefined);
    assert.equal(next.envelope.agents[0].next_cursor, undefined);
  }
});

test("malformed optional dispatch diagnostics fail before returning publication references", () => {
  for (const rest of [
    { time_wrapped: false }, { time_wrapped: 1 }, { time_wrapped: "true" },
    { dispatch_notes: "tree_shared" }, { dispatch_notes: null }, { dispatch_notes: ["a", "b", "c"] },
    { dispatch_notes: ["x".repeat(121)] }, { dispatch_notes: [""] }, { dispatch_notes: [" "] },
    { dispatch_notes: [42] }, { dispatch_notes: [null] }, { dispatch_notes: [undefined] }, { dispatch_notes: Array(1) },
    { diagnostics: { time_wrapped: true } }, { diagnostics: { dispatch_notes: ["tree_shared"] } },
  ]) {
    const input = snapshot({ tasks: [task(row(), rest)], alerts: [alert("preserved")], finished: [{ row: row("otter", 1, "completed") }] });
    const before = structuredClone(input); deepFreeze(input);
    assert.throws(() => packCommunication(input), { code: "INVALID_COMMUNICATION_SNAPSHOT" });
    assert.deepEqual(input, before);
  }
  for (const field of ["time_wrapped", "dispatch_notes"]) {
    const value = field === "time_wrapped" ? true : ["tree_shared"];
    for (const input of [snapshot({ tasks: [task(row("otter", 1, "running", { [field]: value }))] }),
      snapshot({ finished: [{ row: row("otter", 1, "completed", { [field]: value }) }] })])
      assert.throws(() => packCommunication(input), { code: "INVALID_COMMUNICATION_SNAPSHOT" }, "optional fields are NEVER thin controls or finished convenience fields");
  }
});

function byteSaturatedSnapshot() {
  const input = maximalSnapshot("\0".repeat(8192)); input.alerts = input.alerts.slice(0, 1);
  input.tasks[0].question = "q";
  const seed = pack(input).envelope;
  const remaining = 65536 - bytes({ ...seed, response_limit_reached: true });
  const full = structuredClone(input); full.tasks[0].question = "q".repeat(1 + remaining);
  const complete = pack(full);
  assert.equal(complete.envelope.agents[0].question, full.tasks[0].question);
  assert.equal(complete.envelope.response_limit_reached, undefined);
  assert.equal(bytes({ ...complete.envelope, response_limit_reached: true }), 65536);
  return { input: full, complete };
}

test("optional notes/time warning yield entirely at exact byte saturation and alone set response_limit_reached", () => {
  const { input, complete } = byteSaturatedSnapshot(), pressured = structuredClone(input);
  for (const entry of pressured.tasks) { entry.time_wrapped = true; entry.dispatch_notes = ["tree_shared", "tree_lock_unknown"]; }
  const packed = pack(pressured), { envelope } = packed;
  assert.equal(envelope.response_limit_reached, true, "optional diagnostics alone cause the limitation");
  assert.equal(bytes(envelope), 65536);
  assert.deepEqual(envelope.agents, complete.envelope.agents, "all control and question bodies remain identical");
  assert.deepEqual(envelope.alerts, complete.envelope.alerts);
  assert.deepEqual(envelope.pending, complete.envelope.pending);
  assert.deepEqual(packed.references, complete.references, "diagnostic displacement cannot change consumed presentation facts");
  for (const entry of envelope.agents) {
    assert.equal(entry.time_wrapped, undefined); assert.equal(entry.dispatch_notes, undefined);
    assert.equal(entry.next_cursor, undefined, "notes do not invent a recoverability locator");
  }
});

test("dispatch notes are packed as a whole prefix, never clipped to fit or skipped for a shorter tail", () => {
  const { input, complete } = byteSaturatedSnapshot(), first = "first complete note", second = "\0".repeat(120);
  const withFirst = { ...complete.envelope, response_limit_reached: true,
    agents: complete.envelope.agents.map((entry, index) => index === 1 ? { ...entry, dispatch_notes: [first] } : entry) };
  const cost = bytes(withFirst) - bytes({ ...complete.envelope, response_limit_reached: true });
  const pressured = structuredClone(input); pressured.tasks[0].question = pressured.tasks[0].question.slice(0, -cost);
  pressured.tasks[1].dispatch_notes = [first, second];
  const { envelope } = pack(pressured);
  assert.deepEqual(envelope.agents[1].dispatch_notes, [first]);
  assert.equal(envelope.agents[0].question, pressured.tasks[0].question);
  assert.equal(envelope.response_limit_reached, true); assert.equal(bytes(envelope), 65536);
  const omitFirst = structuredClone(pressured); omitFirst.tasks[1].dispatch_notes = [second, "small-tail"];
  assert.equal(pack(omitFirst).envelope.agents[1].dispatch_notes, undefined, "an unfit whole first note does not expose a misleading later-only fragment");
});

test("optional dispatch diagnostics never displace sixteen reserved stable cursors or a worst-case whole alert", () => {
  const tasks = Array.from({ length: 16 }, (_, index) => task(
    row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, Number.MAX_SAFE_INTEGER, "needs_input", controls), {
      question_id: questionId(index + 1), question: "Q".repeat(8192), time_wrapped: true,
      dispatch_notes: ["\0".repeat(120), "\ud800".repeat(120)],
      result: window("retained", { offset: Number.MAX_SAFE_INTEGER - 1000, retained_chars: Number.MAX_SAFE_INTEGER,
        total_chars: Number.MAX_SAFE_INTEGER, cursor: { ...cursorIdentity, run: `old-run-${index}` } }),
    }));
  const { envelope } = pack(snapshot({ reason: "alert", tasks, workers_disabled: true,
    alerts: [alert("\0".repeat(8192), Number.MAX_SAFE_INTEGER, "a".repeat(24), "\0".repeat(120))] }));
  assert.equal(envelope.alerts[0].message, "\0".repeat(8192));
  for (const [index, entry] of envelope.agents.entries()) {
    for (const [flag, value] of Object.entries(controls)) assert.equal(entry[flag], value);
    assert.equal(entry.next_cursor.length, 37);
    assert.equal(decodeResultCursor(entry.next_cursor).key, resultCursorKey(tasks[index].result.cursor));
    for (const note of entry.dispatch_notes ?? []) assert(tasks[index].dispatch_notes.includes(note), "only complete original notes may be displayed");
  }
  assert(envelope.agents.some((entry) => entry.dispatch_notes === undefined));
  assert.equal(envelope.response_limit_reached, true);
});

test("packing is deterministic and independent across invocations, with no mutation through output arrays", () => {
  const input = snapshot({ reason: "alert", tasks: [task(row())], alerts: [alert("repeatable")],
    finished: [{ row: row("otter", 1, "completed") }] });
  const first = pack(input), second = pack(input);
  assert.deepEqual(first, second);
  assert.notEqual(first.result, second.result); assert.notEqual(first.envelope.agents, second.envelope.agents);
  assert.notEqual(first.references.alerts, second.references.alerts);
  assert(Object.isFrozen(input)); assert(Object.isFrozen(input.alerts[0]));
});
