import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { communicationEnvelopeBytes, retainedEnvelopeFixture } from "../../dist/core/communication-envelope.js";
import { packCommunication } from "../../dist/core/communication-packer.js";
import { historyTypes, PiRunJournal } from "../../dist/history/run-journal.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { agentRow, taskReply } from "../../dist/tools/replies.js";
import { deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";

// Controlled Owner/SessionPort and local SDK JSONL only: no provider IO,
// notification delivery, human acknowledgement or atomic stop guarantee.
const human = Object.freeze({ source: "human" });
const body = (result) => JSON.parse(result.content[0].text);
const read = async (c, run) => body(await c.observe({ kind: "read", agent_id: run.agent_id }, { validate() {} }));
function attributed(view) {
  assert.equal(view.cancellation_source, "human");
  if (view.outcome) assert.equal(view.outcome.cancellation_source, "human");
}
function unattributed(view) {
  assert.equal(Object.hasOwn(view, "cancellation_source"), false);
  if (view.outcome) assert.equal(Object.hasOwn(view.outcome, "cancellation_source"), false);
}

test("queued human Stop creates no session and exposes optional provenance in wait/read", async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const active = await c.submit("active", task("active", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", task("queued", { name: "orca" }));
  const result = c.cancel(queued.run_id, human);
  assert.equal(result.result, "cancel_requested"); assert.equal(result.already_stopping, false);
  assert.equal(result.execution_exited, true); attributed(result.snapshot);
  await ended(c, queued);
  const view = c.view(queued.run_id);
  assert.equal(view.status, "cancelled"); assert.equal(view.stop_reason, "user_cancel");
  assert.equal(view.outcome.reason, undefined); attributed(view);
  assert.equal(view.history_ref, undefined); assert.equal(ports.length, 1);
  assert.deepEqual(events.map(({ kind }) => kind), ["submit", "submit", "cancel"]);
  const waited = body(await c.observe({ kind: "wait", agent_ids: [queued.agent_id], wait_ms: 0 }, { validate() {} }));
  assert.equal(waited.reason, "task_issue"); assert.equal(waited.agents[0].status, "interrupted");
  assert.equal(waited.agents[0].cancellation_source, "human");
  assert.equal(c.runs.get(queued.run_id).finished_presented, true);
  assert.equal((await read(c, queued)).agents[0].cancellation_source, "human");
  unattributed(c.view(active.run_id));
});

test("running human Stop retains the live execution slot and first provenance across repeats", async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const run = await c.submit("running", task("running", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", task("queued", { name: "orca" }));
  const first = c.cancel(run.run_id, human);
  assert.equal(first.result, "cancel_requested"); assert.equal(first.already_stopping, false);
  assert.equal(first.execution_exited, false); assert.equal(first.snapshot.status, "cancelling"); attributed(first.snapshot);
  for (const options of [undefined, human, human]) {
    const repeat = c.cancel(run.run_id, options);
    assert.equal(repeat.already_stopping, true); attributed(repeat.snapshot);
  }
  await tick();
  assert.equal(ports[0].stopped, 1); assert.equal(c.stats().active, 1);
  assert.equal(c.view(queued.run_id).status, "queued"); assert.equal(ports.length, 1);
  const projected = await read(c, run);
  assert.equal(projected.agents[0].status, "interrupting"); assert.equal(projected.agents[0].cancellation_source, "human");
  ports[0].finish("partial", "aborted"); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "cancelled"); attributed(c.view(run.run_id));
  assert.equal(events.filter(({ kind }) => kind === "cancel").length, 1);
  await until(() => ports[1]?.streaming);
  ports[1].finish("peer"); await ended(c, queued);
});

for (const firstSource of [undefined, human]) test(`context-change reentry cannot rewrite ${firstSource ? "human" : "model"} first-writer provenance`, async (t) => {
  let c, reentered = 0;
  const f = await fixture(t, { controller: { onContextChange(event) {
    if (event.kind !== "cancel") return;
    reentered++;
    const view = c.view(event.run_id);
    assert.equal(view.stop_reason, "user_cancel");
    assert.equal(view.cancellation_source, firstSource?.source, "latched before the callback");
    const nested = c.cancel(event.run_id, firstSource ? undefined : human);
    assert.equal(nested.already_stopping, true);
    assert.equal(nested.snapshot.cancellation_source, firstSource?.source);
  } } });
  c = f.controller;
  const run = await c.submit("reentry", task("reentry", { name: "otter" }));
  await until(() => f.ports[0]?.streaming);
  c.cancel(run.run_id, firstSource); c.cancel(run.run_id, human);
  f.ports[0].finish("partial", "aborted"); await ended(c, run);
  assert.equal(reentered, 1); assert.equal(c.view(run.run_id).status, "cancelled");
  assert.deepEqual(c.view(run.run_id).cleanup_errors, [], "callback assertions must not be swallowed as context-change faults");
  if (firstSource) attributed(c.view(run.run_id)); else unattributed(c.view(run.run_id));
});

for (const reason of ["hard_budget", "deadline"]) test(`earlier ${reason} wins over human Stop without attribution`, async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 0 } });
  const run = await c.submit(reason, task(reason, { name: "otter", max_turns: 1,
    ...(reason === "deadline" ? { max_duration_ms: 25 } : {}) }));
  await until(() => ports[0]?.streaming);
  if (reason === "hard_budget") ports[0].callbacks.turnStart();
  await until(() => c.view(run.run_id).stop_reason === reason);
  const result = c.cancel(run.run_id, human);
  assert.equal(result.already_stopping, true); assert.equal(result.stop_reason, reason); unattributed(result.snapshot);
  ports[0].finish("partial", "aborted"); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "failed"); unattributed(c.view(run.run_id));
  assert.equal(c.view(run.run_id).outcome.reason, reason === "hard_budget" ? "turn_limit" : "deadline");
});

test("human Stop before a later turn-limit callback keeps user_cancel and its attribution", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 0 } });
  const run = await c.submit("human-first", task("human-first", { name: "otter", max_turns: 1 }));
  await until(() => ports[0]?.streaming);
  c.cancel(run.run_id, human); ports[0].callbacks.turnStart();
  ports[0].finish("partial", "aborted"); await ended(c, run);
  assert.equal(c.view(run.run_id).stop_reason, "user_cancel"); attributed(c.view(run.run_id));
});

for (const status of ["completed", "needs_input", "failed", "cancelled"]) test(`terminal ${status} cannot acquire human provenance`, async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const run = await c.submit(status, task(status, { name: "otter" }));
  await until(() => ports[0]?.streaming);
  if (status === "needs_input") ports[0].callbacks.question("Which path?");
  if (status === "cancelled") c.cancel(run.run_id);
  ports[0].finish("final", status === "failed" ? "error" : status === "cancelled" ? "aborted" : "success");
  await ended(c, run);
  const before = c.view(run.run_id), eventCount = events.length;
  assert.equal(before.status, status);
  const result = c.cancel(run.run_id, human);
  assert.equal(result.result, "already_terminal"); unattributed(result.snapshot);
  assert.deepEqual(result.snapshot.outcome, before.outcome); assert.equal(events.length, eventCount);
});

test("execution exit before END completion cannot acquire late human provenance", async (t) => {
  const hold = deferred(), entered = deferred();
  const { controller: c, ports } = await fixture(t, { beforeShutdown: () => hold.resolve(), history: async (point) => {
    if (point === "finish") { entered.resolve(); await hold.promise; }
  } });
  const run = await c.submit("exited", task("exited", { name: "otter" }));
  await until(() => ports[0]?.streaming); ports[0].finish("already done"); await entered.promise;
  const result = c.cancel(run.run_id, human);
  assert.equal(result.result, "already_exited"); assert.equal(result.finalization_pending, true); unattributed(result.snapshot);
  hold.resolve(); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "completed"); unattributed(c.view(run.run_id));
});

test("finalization failure preserves human attribution alongside the existing failure reason", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("poison", task("poison", { name: "otter" }));
  await until(() => ports[0]?.streaming); c.cancel(run.run_id, human);
  ports[0].calls[0].done.resolve({ kind: "success", get output() { throw new Error("fixture unreadable output"); } });
  await ended(c, run);
  const view = c.view(run.run_id);
  assert.equal(view.status, "cancelled"); assert.equal(view.outcome.reason, "finalization_failed"); attributed(view);
  assert.equal(view.stop_reason, "user_cancel"); assert.equal(c.stats().reserved_output_chars, 0);
});

test("context callback and END failure do not erase accepted human provenance", async (t) => {
  let recorded, writes = 0;
  const { controller: c, ports } = await fixture(t, { controller: { onContextChange(event) {
    if (event.kind === "cancel") throw new Error("fixture context change failed");
  } }, history(point, outcome) {
    if (point === "finish") { writes++; recorded = structuredClone(outcome); throw new Error("fixture END failed"); }
  } });
  const run = await c.submit("failed-callback", task("failed-callback", { name: "otter" }));
  await until(() => ports[0]?.streaming); c.cancel(run.run_id, human);
  ports[0].finish("partial", "aborted"); await ended(c, run);
  const view = c.view(run.run_id);
  attributed(view); assert.equal(view.status, "cancelled"); assert.equal(recorded.cancellation_source, "human");
  assert.match(view.history_error, /fixture END failed/); assert.equal(writes, 1);
  assert(view.cleanup_errors.some((entry) => /fixture context change failed/.test(entry)));
});

test("invalid host-origin options fail without cancellation, getter invocation, callbacks or queued work", async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const run = await c.submit("invalid-options", task("invalid-options", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  let getters = 0;
  const invalid = [null, false, "human", [], {}, { source: "model" }, { source: undefined },
    { source: "human", extra: true }, { source: "human", [Symbol("extra")]: true },
    Object.create({ source: "human" }), { get source() { getters++; return "human"; } }];
  const before = structuredClone(c.runs.get(run.run_id).record), eventCount = events.length;
  for (const options of invalid) assert.throws(() => c.cancel(run.run_id, options), errorCode("INVALID_CANCEL_OPTIONS"));
  await tick();
  assert.deepEqual(c.runs.get(run.run_id).record, before); assert.equal(events.length, eventCount);
  assert.equal(ports[0].stopped, 0); assert.equal(getters, 0); assert.equal(c.stats().active, 1);
  assert.throws(() => c.cancel(randomUUID(), human), errorCode("RUN_NOT_FOUND"));
  unattributed(c.view(run.run_id));
});

test("option reflection cannot hide reentrant effects even when its proxy swallows the guard error", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("proxy-options", task("proxy-options", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  let trapped = 0;
  const options = new Proxy(human, { ownKeys(target) {
    trapped++;
    try { c.cancel(run.run_id); } catch (error) { assert.equal(error.code, "OBSERVATION_REENTRANCY"); }
    return Reflect.ownKeys(target);
  } });
  assert.throws(() => c.cancel(run.run_id, options), errorCode("OBSERVATION_REENTRANCY"));
  await tick(); assert.equal(trapped, 1); assert.equal(ports[0].stopped, 0);
  assert.equal(c.view(run.run_id).status, "running"); unattributed(c.view(run.run_id));
});

test("Off still accepts explicit human Stop, while default shutdown stays unattributed", async (t) => {
  let enabled = true;
  const { controller: c, ports } = await fixture(t, { controller: { admission: () => ({ enabled, revision: enabled ? 1 : 2 }) } });
  const run = await c.submit("off", task("off", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("shutdown", task("shutdown", { name: "orca" }));
  enabled = false;
  c.cancel(run.run_id, human);
  const projected = await read(c, run);
  assert.equal(projected.workers_disabled, true); assert.equal(projected.agents[0].cancellation_source, "human");
  ports[0].finish("partial", "aborted");
  assert.equal((await c.shutdown(3000)).closed, true);
  attributed(c.view(run.run_id)); unattributed(c.view(queued.run_id));
  assert.equal(c.view(queued.run_id).stop_reason, "user_cancel");
});

test("list/interrupt projection and an original finished reminder retain human origin after Agent reuse", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const original = await c.submit("original", task("original", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  c.cancel(original.run_id, human);
  assert.equal(taskReply(c.view(original.run_id), () => "otter").cancellation_source, "human");
  ports[0].finish("partial", "aborted"); await ended(c, original);
  const roster = c.list()[0];
  assert.equal(agentRow(roster, c.agentSummary(original.agent_id), () => "otter").cancellation_source, "human");
  const next = await c.submit("next", { resume: original.agent_id, prompt: "next" });
  await until(() => ports[0].calls.length === 2);
  const projected = await read(c, next);
  assert.equal(projected.agents[0].task, 2); assert.equal(projected.agents[0].cancellation_source, undefined);
  assert.equal(projected.finished[0].task, 1); assert.equal(projected.finished[0].cancellation_source, "human");
  assert.equal(c.runs.get(original.run_id).finished_presented, true);
  ports[0].finish("next result"); await ended(c, next);
  unattributed(c.view(next.run_id)); assert.equal(taskReply(c.view(next.run_id), () => "otter").cancellation_source, undefined);
});

const snapshot = (rest = {}) => ({ reason: "snapshot", tasks: [], alerts: [], finished: [], ...rest });
const row = (agent = "otter", status = "interrupted") => ({ agent, task: 1, status });
const stableWindow = { text: "", offset: Number.MAX_SAFE_INTEGER - 1000, retained_chars: Number.MAX_SAFE_INTEGER,
  total_chars: Number.MAX_SAFE_INTEGER, cursor: { owner: "owner", generation: "generation", run: "run", version: "version" } };
function saturated() {
  const controls = { has_question: true, limit_reached: true, unavailable: true,
    question_truncated: true, result_omitted: true, result_truncated: true };
  const tasks = Array.from({ length: 16 }, (_, index) => ({
    row: { ...row(`a${String(index).padStart(2, "0")}${"x".repeat(21)}`, index === 15 ? "running" : "interrupted"),
      task: Number.MAX_SAFE_INTEGER, ...controls },
    settled: index !== 15, question_id: `q_${index.toString(16).padStart(32, "0")}`,
    ...(index === 15 ? {} : { result: { ...stableWindow, cursor: { ...stableWindow.cursor, run: `run-${index}` } } }),
  }));
  tasks[0].question = "q";
  const input = snapshot({ reason: "alert", tasks, workers_disabled: true,
    action: { type: "agent_send", agent: tasks[0].row.agent, task: Number.MAX_SAFE_INTEGER, delivery: "not_delivered" },
    alerts: [{ agent: tasks[0].row.agent, task: Number.MAX_SAFE_INTEGER, label: "\0".repeat(120), message: "\0".repeat(8192), source: "harness" }],
    finished: [{ row: { ...tasks[0].row }, task_index: 0 }] });
  const seed = packCommunication(input), remaining = 65536 - communicationEnvelopeBytes({ ...seed.envelope, response_limit_reached: true });
  assert(remaining > 0 && remaining < 8192);
  tasks[0].question += "q".repeat(remaining);
  const packed = packCommunication(input);
  assert.equal(packed.envelope.agents[0].question, tasks[0].question);
  assert.equal(packed.envelope.response_limit_reached, undefined);
  assert.equal(communicationEnvelopeBytes({ ...packed.envelope, response_limit_reached: true }), 65536);
  return { input, packed };
}

test("provenance is optional bounded task/finished metadata, never a new thin control", () => {
  const input = snapshot({ tasks: [{ row: row(), settled: true, cancellation_source: "human" }],
    finished: [{ row: row(), task_index: 0, cancellation_source: "human" }, { row: row("orca"), cancellation_source: "human" }] });
  const packed = packCommunication(input);
  assert.equal(packed.envelope.agents[0].cancellation_source, "human");
  assert.equal(packed.envelope.finished[0].cancellation_source, "human");
  assert.deepEqual(packed.references.finished, [0, 1]);
  assert.equal(communicationEnvelopeBytes(retainedEnvelopeFixture("\0".repeat(8192), true, true)), 65484,
    "the reserved thin-shape proof is unchanged");
  const absent = snapshot({ tasks: [{ row: row(), settled: true }] });
  const explicitUndefined = structuredClone(absent); explicitUndefined.tasks[0].cancellation_source = undefined;
  assert.equal(packCommunication(explicitUndefined).result.content[0].text, packCommunication(absent).result.content[0].text,
    "absent provenance preserves serialized bytes");
  for (const value of [null, false, true, 42, {}, [], "", "model", "human "]) {
    for (const malformed of [snapshot({ tasks: [{ row: row(), settled: true, cancellation_source: value }] }),
      snapshot({ finished: [{ row: row(), cancellation_source: value }] })]) {
      assert.throws(() => packCommunication(malformed), errorCode("INVALID_COMMUNICATION_SNAPSHOT"));
    }
  }
  assert.throws(() => packCommunication(snapshot({ tasks: [{ row: { ...row(), cancellation_source: "human" }, settled: true }] })),
    errorCode("INVALID_COMMUNICATION_SNAPSHOT"));
});

test("human provenance is attempted before result bodies and spends no text units", () => {
  const text = "x".repeat(20000), first = row("otter", "completed"), second = row("orca");
  const input = snapshot({ tasks: [{ row: first, settled: true,
    result: { ...stableWindow, text, offset: 0, retained_chars: text.length, total_chars: text.length } },
  { row: second, settled: true, cancellation_source: "human" }],
  finished: [{ row: second, task_index: 1, cancellation_source: "human" }] });
  const packed = packCommunication(input);
  assert.equal(packed.envelope.agents[0].result.length, 16384);
  assert.equal(packed.envelope.agents[0].next_cursor.length, 37);
  assert.equal(packed.envelope.agents[1].cancellation_source, "human");
  assert.equal(packed.envelope.response_limit_reached, true);
  assert.deepEqual(packed.references.finished, [0]);
});

test("task provenance yields whole at exact byte saturation without changing controls, cursors or commit references", () => {
  const { input, packed: baseline } = saturated();
  for (const entry of input.tasks) entry.cancellation_source = "human";
  input.finished[0].cancellation_source = "human";
  const packed = packCommunication(input);
  assert.equal(packed.envelope.response_limit_reached, true);
  assert.equal(communicationEnvelopeBytes(packed.envelope), 65536);
  assert.deepEqual(packed.envelope.agents, baseline.envelope.agents);
  assert.deepEqual(packed.envelope.alerts, baseline.envelope.alerts);
  assert.deepEqual(packed.envelope.pending, baseline.envelope.pending);
  assert.deepEqual(packed.references, baseline.references);
  assert.deepEqual(packed.references, { alerts: [0], finished: [0] });
  for (const entry of input.tasks) delete entry.cancellation_source;
  input.tasks[0].cancellation_source = "human";
  const withSource = { ...baseline.envelope, response_limit_reached: true,
    agents: baseline.envelope.agents.map((entry, index) => index === 0 ? { ...entry, cancellation_source: "human" } : entry) };
  const cost = communicationEnvelopeBytes(withSource) - 65536;
  input.tasks[0].question = input.tasks[0].question.slice(0, -cost);
  assert.equal(packCommunication(input).envelope.agents[0].cancellation_source, "human", "whole field fits at the byte boundary");
  input.tasks[0].question += "q";
  assert.equal(packCommunication(input).envelope.agents[0].cancellation_source, undefined, "one byte less room omits the whole field");
});

test("a finished row still presents its original Run when only its provenance cannot fit", () => {
  const { input, packed: baseline } = saturated(), extra = row("orca");
  const withThin = { ...baseline.envelope, response_limit_reached: true, finished: [extra] };
  const cost = communicationEnvelopeBytes(withThin) - 65536;
  assert(cost > 0);
  input.tasks[0].question = input.tasks[0].question.slice(0, -cost);
  input.finished.push({ row: extra, cancellation_source: "human" });
  const packed = packCommunication(input);
  assert.deepEqual(packed.envelope.finished, [extra]); assert.equal(packed.envelope.response_limit_reached, true);
  assert.equal(communicationEnvelopeBytes(packed.envelope), 65536);
  assert.deepEqual(packed.references, { alerts: [0], finished: [0, 1] });
  assert.equal(packed.envelope.finished_pending, 0, "metadata omission is not a persistent retry/ACK obligation");
});

const message = (text) => ({ role: "assistant", api: "fixture", provider: "fixture", model: "controlled",
  content: [{ type: "text", text }], stopReason: "aborted", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
for (const source of [undefined, "human"]) test(`run-end journal roundtrips ${source ?? "legacy absent"} provenance without rewriting history`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-human-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  parent.appendMessage(message("parent"));
  const journal = new PiRunJournal({ parent, session: child });
  const ref = journal.begin({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
  child.appendMessage(message("partial")); journal.seal();
  const outcome = { status: "cancelled", limit_reached: false, ...(source ? { cancellation_source: source } : {}) };
  journal.finish(ref, outcome, { text: "partial", total_chars: 7, truncated: false });
  const file = child.getSessionFile(), before = await readFile(file);
  const query = () => readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(), sessionDirectory: root, ref });
  const cold = await query();
  assert.equal(cold.state, "recorded", JSON.stringify(cold)); assert.deepEqual(cold.outcome, outcome);
  assert.equal(Object.hasOwn(cold.outcome, "cancellation_source"), source !== undefined);
  assert.equal(cold.output.text, "partial"); assert.deepEqual(await readFile(file), before, "byte comparison: cold read never rewrites old records");
  const lines = before.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const ends = lines.filter((entry) => entry.customType === historyTypes.end);
  assert.equal(ends.length, 1); assert.deepEqual(ends[0].data.outcome, outcome);
  ends[0].data.outcome.cancellation_source = "model";
  await writeFile(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const invalid = await query();
  assert.equal(invalid.state, "unavailable"); assert.equal(invalid.error, "INVALID_SDK_HISTORY");
});
