import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRunJournal, historyTypes } from "../../dist/history/run-journal.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { historicalRunsCommand } from "../../dist/history/history-command.js";

const message = text => ({ role: "assistant", api: "fixture", provider: "p", model: "m", content: [{ type: "text", text }],
  stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() });
const output = { text: "result", total_chars: 6, truncated: false };
const receipt = (cwd, o) => ({ version: 1, checks: ["focused:receipt"], cwd, tree: join(cwd, "build"),
  source_state: { state: "observed", scope: "superproject_only", submodules: "ignored", head: "a".repeat(40),
    dirty: true, status_digest: "b".repeat(64), observed_at: 1 },
  outcome: { status: o.status, ...(o.reason !== undefined ? { reason: o.reason } : {}), ...(o.time_wrapped ? { time_wrapped: true } : {}) } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-receipt-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  parent.appendMessage(message("parent"));
  const journal = new PiRunJournal({ parent, session: child });
  const ref = journal.begin({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
  child.appendMessage(message(output.text)); journal.seal();
  const query = () => readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(), sessionDirectory: root, ref });
  const ends = () => child.getEntries().filter(entry => entry.type === "custom" && entry.customType === historyTypes.end);
  return { root, parent, child, journal, ref, query, ends };
}

for (const [name, outcome] of [
  ["legacy/no checks", { status: "completed", limit_reached: false }],
  ["completed", { status: "completed", limit_reached: false }],
  ["failed", { status: "failed", reason: "execution_error", limit_reached: false }],
  ["deadline", { status: "failed", reason: "deadline", limit_reached: false, time_wrapped: true }],
  ["needs_input", { status: "needs_input", question: "which check?", limit_reached: false }],
  ["cancelled", { status: "cancelled", limit_reached: false }],
]) test(`optional validation receipt round-trips ${name} on the sole end append`, async t => {
  const f = await fixture(t), r = name === "legacy/no checks" ? undefined : receipt(f.root, outcome);
  if (r && name === "failed") r.source_state = { state: "unknown", reason: "git_unavailable" };
  const ended = f.journal.finish(f.ref, outcome, output, undefined, r);
  assert.equal(f.ends().length, 1); assert.equal(ended.end_entry_id, f.ends()[0].id);
  assert.equal(Object.hasOwn(f.ends()[0].data, "validation_receipt"), !!r);
  assert.deepEqual(f.ends()[0].data.validation_receipt, r);
  const cold = await f.query(); assert.equal(cold.state, "recorded", JSON.stringify(cold));
  assert.deepEqual(cold.validation_receipt, r); assert.deepEqual(cold.outcome, outcome);
  assert.equal(Object.hasOwn(cold, "validation_receipt"), !!r);
  assert.equal(cold.validation_receipt_error, undefined); assert.equal(f.journal.error, undefined);
  assert.throws(() => f.journal.finish(f.ref, outcome, output, undefined, r), /INVALID_SDK_HISTORY/);
  assert.equal(f.ends().length, 1, "no second end append or new record type");
});

test("writer rejects only optional receipts, notifying before the sole valid end with a fixed marker", async t => {
  for (const mutate of [r => { r.checks = []; }, r => { r.outcome.status = "completed"; },
    r => { r.outcome.reason = "different"; }, r => { r.outcome.time_wrapped = true; },
    r => { r.source_state.scope = "whole_tree"; }, r => { r.cwd = "relative"; },
    r => { Object.defineProperty(r, "cwd", { get() { throw new Error("private optional failure details"); } }); }]) {
    const f = await fixture(t), outcome = { status: "needs_input", question: "which check?", limit_reached: false }, r = receipt(f.root, outcome);
    mutate(r); let rejected = 0;
    const ref = f.journal.finish(f.ref, outcome, output, undefined, r, () => {
      assert.equal(f.ends().length, 0, "notify before append"); rejected++;
    });
    assert.equal(rejected, 1); assert.equal(f.ends().length, 1); assert.equal(f.journal.error, undefined);
    assert.equal(ref.end_entry_id, f.ends()[0].id);
    assert.equal(f.ends()[0].data.validation_receipt, undefined);
    assert.equal(f.ends()[0].data.validation_receipt_error, "invalid_validation_receipt");
    assert.deepEqual(f.ends()[0].data.outcome, outcome);
    const cold = await f.query(); assert.equal(cold.state, "recorded");
    assert.deepEqual(cold.outcome, outcome); assert.equal(cold.output.text, output.text);
    assert.equal(cold.validation_receipt_error, "invalid_validation_receipt");
    assert.equal(cold.validation_receipt, undefined);
  }
});

test("optional rejection callbacks are absent for valid/legacy receipts; callback faults propagate as interface errors", async t => {
  for (const present of [false, true]) {
    const f = await fixture(t), outcome = { status: "completed", limit_reached: false };
    f.journal.finish(f.ref, outcome, output, undefined, present ? receipt(f.root, outcome) : undefined,
      () => assert.fail("valid/absent receipt must not reject"));
    assert.equal(f.ends().length, 1);
  }
  const f = await fixture(t), outcome = { status: "completed", limit_reached: false }, r = receipt(f.root, outcome);
  r.checks = []; let rejected = 0;
  assert.throws(() => f.journal.finish(f.ref, outcome, output, undefined, r, () => {
    rejected++; throw new Error("diagnostic interface failed");
  }), /diagnostic interface failed/);
  assert.equal(rejected, 1); assert.equal(f.ends().length, 0); assert.match(f.journal.error, /diagnostic interface failed/);
  assert.throws(() => f.journal.finish(f.ref, outcome, output), /SDK_HISTORY_UNCERTAIN/);
});

test("failed end append attempts once with valid or rejected receipt; no compensating append", async t => {
  for (const invalid of [false, true]) {
    const f = await fixture(t), outcome = { status: "failed", reason: "deadline", limit_reached: false }, r = receipt(f.root, outcome);
    if (invalid) r.checks = [];
    const original = f.child.appendCustomEntry.bind(f.child); let attempts = 0, rejected = 0;
    t.mock.method(f.child, "appendCustomEntry", (type, data) => {
      if (type === historyTypes.end) {
        attempts++; assert.equal(!!data.validation_receipt, !invalid);
        assert.equal(data.validation_receipt_error, invalid ? "invalid_validation_receipt" : undefined);
        throw new Error("fixture append failed");
      }
      return original(type, data);
    });
    assert.throws(() => f.journal.finish(f.ref, outcome, output, undefined, r, () => { rejected++; }), /fixture append failed/);
    assert.throws(() => f.journal.finish(f.ref, outcome, output), /SDK_HISTORY_UNCERTAIN/);
    assert.equal(attempts, 1); assert.equal(rejected, invalid ? 1 : 0); assert.equal(f.ends().length, 0);
  }
});

test("cold reader isolates invalid receipts and projects only fixed fields, preserving old absent field", async t => {
  const f = await fixture(t), outcome = { status: "failed", reason: "deadline", limit_reached: false }, r = receipt(f.root, outcome);
  f.journal.finish(f.ref, outcome, output, undefined, r);
  const file = f.child.getSessionFile(), lines = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const data = lines.find(entry => entry.customType === historyTypes.end).data;
  const persist = () => writeFile(file, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  for (const invalid of [null, { ...r, checks: [] }, { ...r, outcome: { status: "completed" } },
    { ...r, outcome: { ...r.outcome, time_wrapped: true } }, { ...r, source_state: { state: "unknown", reason: "" } }]) {
    data.validation_receipt = invalid; await persist();
    const cold = await f.query(); assert.equal(cold.state, "recorded"); assert.equal(cold.error, undefined);
    assert.equal(cold.validation_receipt_error, "invalid_validation_receipt");
    assert.deepEqual(cold.outcome, outcome); assert.equal(cold.output.text, output.text);
    assert.equal(cold.validation_receipt, undefined);
  }
  data.validation_receipt = { ...r, ignored: "not projected", source_state: { ...r.source_state, ignored: "not projected" },
    outcome: { ...r.outcome, ignored: "not projected" } };
  await persist(); assert.deepEqual((await f.query()).validation_receipt, r);
  for (const marker of ["invalid_validation_receipt", "unknown optional marker", null]) {
    data.validation_receipt_error = marker;
    // Presence of any error marker excludes even an otherwise valid receipt.
    data.validation_receipt = r; await persist();
    const both = await f.query(); assert.equal(both.state, "recorded"); assert.equal(both.validation_receipt, undefined);
    assert.equal(both.validation_receipt_error, "invalid_validation_receipt");
    delete data.validation_receipt; await persist();
    assert.equal((await f.query()).validation_receipt_error, "invalid_validation_receipt");
  }
  delete data.validation_receipt_error; await persist();
  const legacy = await f.query(); assert.equal(legacy.state, "recorded"); assert.equal(Object.hasOwn(legacy, "validation_receipt"), false);
  assert.equal(Object.hasOwn(legacy, "validation_receipt_error"), false);
});

test("mandatory writer/reader faults remain fatal even alongside an invalid optional receipt", async t => {
  const writer = await fixture(t), outcome = { status: "completed", limit_reached: false }, r = receipt(writer.root, outcome);
  r.checks = []; let rejected = 0;
  assert.throws(() => writer.journal.finish(writer.ref, outcome, { ...output, text: "wrong!" }, undefined, r,
    () => { rejected++; }), /INVALID_SDK_HISTORY/);
  assert.equal(rejected, 0); assert.equal(writer.ends().length, 0);
  for (const mutate of [data => { data.result.digest = "f".repeat(64); },
    data => { data.ref.start_entry_id = "ffffffff"; }, data => { data.outcome.status = "not_terminal"; },
    data => { data.usage = { byModel: {} }; }]) {
    const f = await fixture(t); f.journal.finish(f.ref, outcome, output);
    const file = f.child.getSessionFile(), lines = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const data = lines.find(entry => entry.customType === historyTypes.end).data;
    data.validation_receipt = null; mutate(data);
    await writeFile(file, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const cold = await f.query(); assert.equal(cold.state, "unavailable"); assert.equal(cold.error, "INVALID_SDK_HISTORY");
    assert.equal(cold.validation_receipt_error, undefined);
  }
});

test("human history reports a rejected optional receipt as warning while retaining recorded output", async t => {
  const f = await fixture(t), outcome = { status: "needs_input", question: "which check?", limit_reached: false }, r = receipt(f.root, outcome);
  r.checks = []; f.journal.finish(f.ref, outcome, output, undefined, r);
  let handler, notice, level;
  historicalRunsCommand({ registerCommand: (_name, command) => { handler = command.handler; } });
  await handler(f.ref.run_id, { sessionManager: f.parent, ui: { notify: (value, type) => { notice = JSON.parse(value); level = type; } } });
  assert.equal(level, "warning"); assert.equal(notice.state, "recorded"); assert.equal(notice.output.text, output.text);
  assert.equal(notice.validation_receipt_error, "invalid_validation_receipt");
  assert.equal(notice.validation_receipt, undefined); assert.equal(notice.validation_observation, undefined);
});

test("human history shows planned checks and short scoped observations, never a validation pass", async t => {
  const f = await fixture(t), outcome = { status: "completed", limit_reached: false };
  f.journal.finish(f.ref, outcome, output, undefined, receipt(f.root, outcome));
  let handler, notice;
  historicalRunsCommand({ registerCommand: (_name, command) => { handler = command.handler; } });
  await handler(f.ref.run_id, { sessionManager: f.parent, ui: { notify: value => { notice = JSON.parse(value); } } });
  assert.equal(notice.validation_receipt, undefined);
  assert.deepEqual(notice.validation_observation.planned_checks, ["focused:receipt"]);
  assert.equal(notice.validation_observation.source.scope, "superproject_only");
  assert.equal(notice.validation_observation.source.submodules, "ignored");
  assert.equal(notice.validation_observation.source.head.length, 12);
  assert.equal(notice.validation_observation.source.status_digest, undefined);
  assert.match(notice.validation_observation.note, /not executed\/passed validation/);
});

test("nonpersistent histories and missing boundaries do not forge receipt records", () => {
  let appends = 0;
  const session = SessionManager.inMemory(), parent = { getSessionId: () => randomUUID(), isPersisted: () => false,
    appendCustomEntry() { appends++; assert.fail("must not append"); } };
  const journal = new PiRunJournal({ parent, session }), who = { owner_id: randomUUID(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() };
  assert.equal(journal.begin(who), undefined);
  const o = { status: "failed", reason: "deadline", limit_reached: false };
  assert.throws(() => journal.finish({ ...who, session_id: session.getSessionId(), start_entry_id: "aaaaaaaa" }, o, output,
    undefined, receipt("/cwd", o)), /INVALID_SDK_HISTORY/);
  assert.equal(appends, 0); assert.equal(session.getEntries().length, 0);
});
