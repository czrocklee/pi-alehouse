import assert from "node:assert/strict";
import test from "node:test";
import {
  communicationEnvelopeBytes,
  retainedEnvelopeFixture,
} from "../../dist/core/communication-envelope.js";
import { packCommunication } from "../../dist/core/communication-packer.js";
import { decodeResultCursor, resultCursorKey } from "../../dist/core/result-cursor.js";

// Synthetic captured-data regression only: references are proposed local ACKs,
// not Owner commits, SDK/model receipt, host acceptance or public release proof.
// Tool schema descriptions/provider token costs are NOT part of this reply cap.
const bytes = (value) =>
  Buffer.byteLength(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    "utf8",
  );
const units = (value) =>
  value.agents.reduce(
    (sum, row) => sum + (row.question?.length ?? 0) + (row.result?.length ?? 0),
    0,
  ) + (value.alerts ?? []).reduce((sum, alert) => sum + alert.message.length, 0);
const seeds = [0x1, 0x5eed, 0xc0ffee, 0xdeadbeef];
function random(seed) {
  let state = seed >>> 0;
  return (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
}
const glyphs = [
  "x",
  "字",
  "😀",
  '"',
  "\\",
  "\0",
  "\u001f",
  "\ud800",
  "\udfff",
  "\n",
  "\t",
  "\u2028",
];
function unicode(next, length) {
  let text = "x"; // Nonblank even for control-heavy generated child text.
  while (text.length < length) text += glyphs[next(glyphs.length)];
  return text.slice(0, length);
}
function assertPrefix(shown, original) {
  assert.equal(shown, original.slice(0, shown.length));
  const end = shown.length;
  assert(
    !(
      end > 0 &&
      /[\uD800-\uDBFF]/.test(original[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(original[end] ?? "")
    ),
    "packing must not split a pair present in the original (original lone surrogates remain literal)",
  );
}
function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const identity = (seed, index) => ({
  owner: "budget-owner",
  generation: `seed-${seed}`,
  run: `old-run-${index}`,
  version: "v1",
});
const name = (index) => `a${String(index).padStart(2, "0")}${"x".repeat(21)}`;

// Incremental ledger of the EXACT conservative proof object, not a sum of
// independently serialized fragments (commas and both escaping layers count).
// Preconditions: 16 rows; one full 8192-unit alert; max-safe task/count/offset;
// max 24-unit names / 120-unit alert label; all optional controls coexist.
// Deliberately impossible action and wait/status pairing are a ceiling only.
// Arbitrary optional labels/diagnostics and finished rows are NOT
// promised alongside this ceiling; the real packer must make them yield.
test("budget contribution ledger reconstructs the 65006-byte conservative envelope from actual fields", () => {
  const proof = retainedEnvelopeFixture("\0".repeat(8192), true, true);
  const value = { agents: [] },
    contributions = { empty_reply_with_agents: bytes(value) };
  function add(label, change) {
    const before = bytes(value);
    change();
    contributions[label] = bytes(value) - before;
    assert(contributions[label] > 0, label);
  }
  add("sixteen_identity_status_rows", () => {
    value.agents = proof.agents.map(({ agent, task, status }) => ({ agent, task, status }));
  });
  for (const field of [
    "has_question",
    "limit_reached",
    "unavailable",
    "question_truncated",
    "result_omitted",
    "result_truncated",
    "wait",
    "question_id",
    "question",
    "next_cursor",
  ])
    add(`sixteen_${field}`, () =>
      value.agents.forEach((row, index) => {
        row[field] = proof.agents[index][field];
      }),
    );
  for (const field of [
    "reason",
    "action",
    "workers_disabled",
    "alerts_pending",
    "finished_pending",
    "response_limit_reached",
  ])
    add(field, () => {
      value[field] = structuredClone(proof[field]);
    });
  add("first_alert_identity_and_empty_text", () => {
    const { agent, task } = proof.alerts[0];
    value.alerts = [{ agent, task, label: "", message: "" }];
  });
  for (const field of ["label", "source", "message"])
    add(`first_alert_${field}`, () => {
      value.alerts[0][field] = proof.alerts[0][field];
    });
  assert.deepEqual(value, proof);
  assert.equal(contributions.sixteen_wait, 416);
  assert.equal(contributions.sixteen_question_id, 880);
  assert.equal(contributions.first_alert_label, 120 * 7);
  assert.equal(contributions.first_alert_source, 23);
  assert.equal(contributions.first_alert_message, 8192 * 7);
  assert.equal(
    Object.values(contributions).reduce((sum, cost) => sum + cost, 0),
    65006,
  );
  assert.equal(bytes(value), 65006);
  assert.equal(communicationEnvelopeBytes(value), bytes(value));
  assert.equal(65536 - bytes(value), 530);
});

function generatedSnapshot(seed, scenario) {
  const next = random(seed),
    reasons = ["alert", "question", "snapshot", "aborted"];
  const tasks = Array.from({ length: 16 }, (_, index) => {
    const pending = index % 4 === 0;
    const status = pending ? "queued" : index % 4 === 1 ? "running" : "needs_input";
    const row = {
      agent: name(index),
      task: Number.MAX_SAFE_INTEGER - index,
      status,
      has_question: true,
      limit_reached: true,
      unavailable: true,
      ...(pending ? { wait: index % 8 ? "capacity" : "dependencies" } : {}),
    };
    const settled = status === "needs_input";
    // A mix of at-EOF captured pages and windows whose tail is not captured.
    const text = unicode(next, [1, 8192, 16384, 20000][(index + scenario) % 4]);
    const offset = next(100),
      retained_chars = offset + text.length + (index % 2 ? 71 : 0);
    const entry = {
      row,
      settled,
      question_id: `q_${(index + 1).toString(16).padStart(32, "0")}`,
      result: {
        text,
        offset,
        retained_chars,
        total_chars: retained_chars + 13,
        ...(settled ? { cursor: identity(seed, index) } : {}),
      },
    };
    // All sixteen questions stress preservation of identities even when text
    // is empty/truncated; scenario 2 leaves body space for result progress.
    if (scenario !== 2 || index === 2) entry.question = unicode(next, scenario === 2 ? 1 : 8192);
    if (index % 2) entry.label = unicode(next, 120);
    if (index % 3 === 0) entry.cancellation_source = "human";
    entry.diagnostics = { error: unicode(next, 513) };
    entry.dispatch_notes = ["tree_shared"];
    return entry;
  });
  // Exactly 64 child + 16 harness entries, four child and one harness per
  // Agent; maximal physical FIFO count without inventing an invalid quota mix.
  const alerts = Array.from({ length: 80 }, (_, index) => ({
    agent: name(index % 16),
    task: index + 1,
    label: unicode(next, 120),
    message: unicode(next, index < 2 ? 8192 : [1, 120, 8192][next(3)]),
    ...(index >= 64 ? { source: "harness" } : {}),
  }));
  const finished = tasks.flatMap((entry, task_index) =>
    entry.settled ? [{ row: entry.row, task_index }] : [],
  );
  finished.push(
    ...Array.from({ length: 10 }, (_, index) => ({
      row: { agent: name(index), task: index + 1, status: "completed" },
      label: unicode(next, 120),
    })),
  );
  return {
    reason: reasons[scenario],
    tasks,
    alerts,
    finished,
    workers_disabled: true,
    action: {
      type: "agent_send",
      agent: name(0),
      task: tasks[0].row.task,
      delivery: "not_delivered",
    },
  };
}

for (const seed of seeds)
  for (let scenario = 0; scenario < 4; scenario++)
    test(`seed=0x${seed.toString(16)} scenario=${scenario}: Unicode/control/FIFO combinations obey both budgets`, () => {
      const input = generatedSnapshot(seed, scenario),
        before = structuredClone(input);
      freeze(input);
      const packed = packCommunication(input),
        { envelope, result, references } = packed;
      assert.deepEqual(input, before, "packing must neither consume nor mutate captured facts");
      assert.deepEqual(
        packCommunication(input),
        packed,
        "the seed and snapshot fully reproduce packing",
      );
      assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), bytes(envelope));
      assert.equal(communicationEnvelopeBytes(envelope), bytes(envelope));
      assert(bytes(envelope) <= 65536);
      assert(units(envelope) <= 16384);
      assert.deepEqual(JSON.parse(JSON.parse(JSON.stringify(result)).content[0].text), envelope);
      assert.equal(envelope.agents.length, 16);
      assert.deepEqual(envelope.action, input.action);
      assert.equal(envelope.workers_disabled, true);
      assert.equal(
        envelope.response_limit_reached,
        true,
        "generated combinations intentionally exceed optional capacity",
      );
      for (const [index, row] of envelope.agents.entries()) {
        const original = input.tasks[index];
        for (const [field, value] of Object.entries(original.row))
          assert.equal(row[field], value, `required ${field} at ${index}`);
        assert.equal(row.question_id, original.question_id);
        if (original.question !== undefined) {
          assert.equal(typeof row.question, "string");
          assertPrefix(row.question, original.question);
          if (row.question.length < original.question.length)
            assert.equal(row.question_truncated, true);
        }
        const shown = row.result ?? "",
          window = original.result;
        assertPrefix(shown, window.text);
        if (original.settled && window.offset + shown.length < window.retained_chars) {
          assert.equal(row.next_cursor.length, 37);
          assert.deepEqual(decodeResultCursor(row.next_cursor), {
            key: resultCursorKey(window.cursor),
            offset: window.offset + shown.length,
          });
          if (!shown.length) assert.equal(row.result_omitted, true);
        } else
          assert.equal(row.next_cursor, undefined, "live previews and EOF do not invent locators");
        if (!original.settled && window.offset + shown.length < window.retained_chars)
          assert.equal(row.result_truncated, true);
        // Optional summary fields yield whole, never as clipped facts.
        for (const field of ["label", "cancellation_source"])
          if (Object.hasOwn(row, field))
            assert.deepEqual(row[field], original[field], `${field} must remain exact`);
      }
      assert.deepEqual(
        references.alerts,
        Array.from({ length: references.alerts.length }, (_, index) => index),
      );
      assert.deepEqual(envelope.alerts ?? [], input.alerts.slice(0, references.alerts.length));
      assert.equal(envelope.alerts_pending ?? 0, 80 - references.alerts.length);
      if (input.reason === "alert")
        assert(references.alerts.length >= 1, "first complete alert is reserved");
      if (input.reason === "aborted") {
        assert.deepEqual(references, { alerts: [], finished: [] });
        assert.equal(envelope.alerts, undefined);
      }
      assert.equal(new Set(references.finished).size, references.finished.length);
      for (const index of references.finished) {
        const candidate = input.finished[index];
        assert(candidate, "every presentation reference addresses an original candidate");
        if (candidate.task_index !== undefined) {
          for (const [field, value] of Object.entries(candidate.row))
            assert.equal(envelope.agents[candidate.task_index][field], value);
        } else
          assert(
            (envelope.finished ?? []).some(
              (row) =>
                row.agent === candidate.row.agent &&
                row.task === candidate.row.task &&
                row.status === candidate.row.status,
            ),
          );
      }
      const unbound = input.finished.flatMap((candidate, index) =>
        candidate.task_index === undefined ? [index] : [],
      );
      const shownUnbound = references.finished.filter(
        (index) => input.finished[index].task_index === undefined,
      );
      assert.deepEqual(
        shownUnbound,
        unbound.slice(0, shownUnbound.length),
        "unlinked finished originals also form a FIFO prefix",
      );
      assert.equal(
        envelope.finished_pending ?? 0,
        input.finished.length - references.finished.length,
      );
      assert((envelope.finished?.length ?? 0) <= 8);
    });

for (const seed of seeds)
  test(`seed=0x${seed.toString(16)}: proposed ACKs drain only displayed FIFO prefixes and retained cursors recover exact Unicode`, () => {
    const next = random(seed),
      original = generatedSnapshot(seed, 0).alerts.slice(0, 5);
    // Pin a worst-escaped middle entry followed by a tiny tail: a smaller tail
    // may never leapfrog the head left behind by an earlier packed observation.
    original[1].message = "\0".repeat(8192);
    original[2].message = "tiny-tail";
    let pending = structuredClone(original),
      delivered = [];
    while (pending.length) {
      const { envelope, references } = packCommunication({
        reason: "alert",
        tasks: [],
        alerts: pending,
        finished: [],
      });
      assert(bytes(envelope) <= 65536 && units(envelope) <= 16384);
      assert(references.alerts.length > 0);
      assert.deepEqual(envelope.alerts, pending.slice(0, references.alerts.length));
      delivered.push(...envelope.alerts);
      pending = pending.slice(references.alerts.length); // Simulate only proposed local ACKs.
      assert.equal(envelope.alerts_pending ?? 0, pending.length);
    }
    assert.deepEqual(
      delivered,
      original,
      "no accepted body disappears, repeats or changes source/label",
    );

    const text = unicode(next, 40000),
      cursor = identity(seed, 99);
    let offset = 0,
      recovered = "",
      pages = 0;
    while (offset < text.length) {
      const input = {
        reason: "snapshot",
        tasks: [
          {
            row: { agent: name(0), task: 1, status: "completed" },
            settled: true,
            result: {
              text: text.slice(offset),
              offset,
              retained_chars: text.length,
              total_chars: text.length,
              cursor,
            },
          },
        ],
        alerts: [],
        finished: [],
      };
      const { envelope } = packCommunication(input),
        row = envelope.agents[0];
      assert(bytes(envelope) <= 65536 && units(envelope) <= 16384);
      assert(row.result.length > 0);
      assertPrefix(row.result, text.slice(offset));
      recovered += row.result;
      offset += row.result.length;
      if (offset < text.length) {
        assert.deepEqual(decodeResultCursor(row.next_cursor), {
          key: resultCursorKey(cursor),
          offset,
        });
      } else assert.equal(row.next_cursor, undefined);
      assert.equal(envelope.response_limit_reached, offset < text.length ? true : undefined);
      assert(++pages < 20, "bounded progress, not a cursor loop");
    }
    assert.equal(recovered, text, "all original UTF-16 units survive the UTF-8/double-JSON pages");
  });
