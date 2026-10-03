import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { HarnessError, ParentHistoryError } from "../../dist/core/ports.js";
import { questionId } from "../../dist/core/question-id.js";
import { decodeResultCursor, encodeResultCursor } from "../../dist/core/result-cursor.js";
import { emptyLedger } from "../../dist/core/usage-ledger.js";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { FakePort, deferred, task, tick, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

// Real OwnerController lifecycle, admission, one FIFO, snapshot, packer and
// commit; only SessionPort/history IO are controlled mocks. No shadow inbox,
// question registry or mutation of the controller's private Run/Agent records.
// This is NOT host SDK, provider, human-approval or OS-isolation evidence.
async function ownerFixture(t, { controller = {}, history, createPort = () => new FakePort(), owner_id = randomUUID() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-owner-communication-")), ports = [], events = [], holds = [];
  const owner = await FileOwnerLease.open({ directory, owner_id, flock });
  const c = await OwnerController.open({ owner, concurrency: 1, resident_limit: 16,
    createSession: async (agent) => {
      const port = createPort(agent); ports.push(port);
      if (history) port.history = {
        begin: async (run) => { await history("begin", run); return { ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }; },
        finish: async (ref, outcome, output) => { await history("finish", outcome, output); return { ...ref, end_entry_id: "bbbbbbbb" }; },
      };
      return port;
    }, onContextChange: (event) => { events.push(event); }, ...controller });
  t.after(async () => {
    for (const hold of holds) hold.resolve();
    for (const port of ports) {
      port.deliveryGate?.resolve(); port.autoStop = true;
      if (port.streaming) port.finish("fixture cleanup", "aborted");
    }
    const report = await c.shutdown(3000);
    assert.equal(report.closed, true, `fixture must prove controller closure: ${JSON.stringify(report)}`);
    await rm(directory, { recursive: true, force: true });
  });
  return { c, owner, ports, events, hold() { const gate = deferred(); holds.push(gate); return gate; } };
}
const hasCode = (code, details = {}) => (error) => {
  assert(error instanceof HarnessError); assert.equal(error.code, code);
  for (const [key, value] of Object.entries(details)) assert.equal(error.details[key], value);
  return true;
};
const harnessFailure = (error) => { assert(error instanceof HarnessError); return true; };
const context = (validate = () => {}, signal) => ({ validate, ...(signal ? { signal } : {}) });
const body = (result) => {
  assert.deepEqual(Object.keys(result).sort(), ["content", "details"]);
  assert.equal(result.details, undefined); assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
};
const observe = async (c, request, options = context()) => body(await c.observe(request, options));
const wait = (c, agent_ids, wait_ms = 0, options = context()) => observe(c, { kind: "wait", ...(agent_ids ? { agent_ids } : {}), wait_ms }, options);
const read = (c, run, rest = {}, options = context()) => observe(c, { kind: "read", agent_id: run.agent_id, ...rest }, options);
const inline = (c, run, type = "agent_run", wait_ms = 0, options = context()) =>
  observe(c, { kind: "action", run_id: run.run_id, action: { type }, wait_ms }, options);
async function settled(c, run) {
  assert.equal(await c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
  assert.equal(c.view(run.run_id).phase, "settled");
}
async function started(c, ports, id, name, rest = {}) {
  const run = await c.submit(id, task(id, { name, ...rest }));
  await until(() => ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id));
  return { run, port: ports.find((port) => port.calls.at(-1)?.identity.run_id === run.run_id) };
}
async function question(c, ports, id = "question", name = "otter", rest = {}) {
  const { run, port } = await started(c, ports, id, name, rest);
  assert.equal(port.callbacks.question("Original decision?"), "recorded");
  port.finish("Please decide"); await settled(c, run);
  const view = c.view(run.run_id); assert.match(view.question_id, /^q_[0-9a-f]{32}$/);
  return { run, port, token: view.question_id };
}
const pendingCount = (c, runs) => runs.reduce((sum, run) => sum + c.view(run.run_id).pending_messages, 0);
const finishedBit = (c, run) => c.runs.get(run.run_id).finished_presented; // Inspect ONLY original Run presentation evidence.

test("unlatched lease loss removes question tokens from both views and explicit observations without admitting an answer", async (t) => {
  const { c, ports, owner } = await ownerFixture(t), { run, token } = await question(c, ports);
  owner.close(); // Authority loss is not child-exit evidence; fixture still shuts down the Controller.
  assert.equal(c.view(run.run_id).question_id, undefined);
  assert.equal(c.view(run.run_id).unavailable_reason, "owner_lease_lost");
  const inspected = await read(c, run);
  assert.equal(inspected.agents[0].question_id, undefined);
  assert.equal(inspected.agents[0].question, "Original decision?");
  assert.equal(c.stats().internal_error, undefined, "inspection must not latch execution authority loss");
  await assert.rejects(c.answer("lost", run.agent_id, token, "answer"), { message: "OWNER_LOCK_CLOSED" });
  assert.match(c.stats().internal_error, /OWNER_LOCK_CLOSED/);
  assert.equal(c.stats().runs, 1);
});

test("async answer/send preparation cannot admit a continuation or cache delivery before validation", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, token } = await question(c, ports);
  const prepare = async () => { throw new Error("ASYNC_PREPARATION"); };
  await assert.rejects(c.send("async-send", run.agent_id, "not an answer", { prepare }), hasCode("ASYNC_OBSERVATION_PORT"));
  await assert.rejects(c.answer("async-answer", run.agent_id, token, "answer", { prepare }), hasCode("ASYNC_OBSERVATION_PORT"));
  assert.equal(c.stats().runs, 1); assert.equal(c.view(run.run_id).question_id, token);
  assert.equal((await c.send("async-send", run.agent_id, "not an answer")).delivery, "not_delivered");
  const accepted = await c.answer("async-answer", run.agent_id, token, "answer");
  assert.equal(accepted.task, 2); assert.equal(c.stats().runs, 2);
  await tick();
});

test("async observation/admission readers reject without consuming or leaking a native rejection; commands fail closed", async (t) => {
  let invalidAdmission = false;
  const { c, ports } = await ownerFixture(t, { controller: { admission: () => invalidAdmission ?
    Promise.reject(new Error("ASYNC_ADMISSION")) : { enabled: true, revision: 0 } } });
  const { run, port } = await started(c, ports, "async-ports", "otter");
  port.callbacks.alert("retained before context validation");
  assert.throws(() => c.observe({ kind: "read", agent_id: run.agent_id }, {
    validate: async () => { throw new Error("ASYNC_CONTEXT"); },
  }), hasCode("ASYNC_OBSERVATION_PORT"));
  invalidAdmission = true;
  await assert.rejects(read(c, run), hasCode("ASYNC_OBSERVATION_PORT"));
  assert.equal(c.view(run.run_id).pending_messages, 1);
  assert.equal(finishedBit(c, run), false);
  await assert.rejects(c.submit("disabled", task("disabled", { name: "orca" })), hasCode("WORKERS_DISABLED"));
  assert.equal((await c.submit("async-ports", task("async-ports", { name: "otter" }))).run_id, run.run_id,
    "accepted command replay survives a broken admission reader");
  await tick(); // Node's test runner also fails on any unhandled Promise rejection.
  invalidAdmission = false;
  assert.equal(c.stats().internal_error, undefined);
  assert.equal((await read(c, run)).alerts[0].message, "retained before context validation");
});

// Deliberately replace only this fixture's lock pathname, keeping the locked
// inode alive. Restore synchronously in finally BEFORE fixture shutdown/cleanup.
function replaceLeasePath(owner) {
  const saved = `${owner.path}.saved`;
  renameSync(owner.path, saved);
  try { writeFileSync(owner.path, "replacement inode", { flag: "wx", mode: 0o600 }); }
  catch (error) { renameSync(saved, owner.path); throw error; }
  return () => { unlinkSync(owner.path); renameSync(saved, owner.path); };
}

for (const lossAt of ["entry", "prepare"]) test(`new answer latches real temporary lease loss at ${lossAt}; restoration never readmits work but old answers replay`, async (t) => {
  const { c, ports, owner } = await ownerFixture(t), first = await question(c, ports);
  const accepted = await c.answer("accepted-answer", first.run.agent_id, first.token, "first answer");
  await until(() => first.port.calls.length === 2 && first.port.streaming);
  first.port.callbacks.question("Second decision?"); first.port.finish("second decision"); await settled(c, accepted);
  const token = c.view(accepted.run_id).question_id;
  assert.match(token, /^q_[0-9a-f]{32}$/);
  const idle = await started(c, ports, "idle-peer", "orca");
  idle.port.finish("idle"); await settled(c, idle.run);
  const before = c.stats().runs;
  let restore;
  try {
    if (lossAt === "entry") {
      restore = replaceLeasePath(owner);
      assert.throws(() => owner.assertHeld(), { message: "LOCK_INODE_CHANGED" });
      assert.equal(c.view(accepted.run_id).question_id, undefined);
      const inspected = await read(c, accepted);
      assert.equal(inspected.agents[0].question_id, undefined);
      assert.equal(inspected.agents[0].question, "Second decision?");
      assert.equal(c.stats().internal_error, undefined);
    }
    let preparations = 0;
    await assert.rejects(c.answer("lost-answer", first.run.agent_id, token, "second answer", { prepare: () => {
      preparations++;
      assert.equal(c.view(accepted.run_id).question_id, token);
      restore = replaceLeasePath(owner);
    } }), { message: "LOCK_INODE_CHANGED" });
    assert.equal(preparations, lossAt === "prepare" ? 1 : 0);
    assert.match(c.stats().internal_error, /LOCK_INODE_CHANGED/);
  } finally { restore?.(); }
  assert.doesNotThrow(() => owner.assertHeld(), "the real lease now looks healthy again");
  assert.equal(c.view(accepted.run_id).question_id, undefined, "sticky command loss cannot restore the token");
  await assert.rejects(c.answer("later-answer", first.run.agent_id, token, "second answer"), hasCode("OWNER_INTERNAL_ERROR"));
  await assert.rejects(c.submit("later-spawn", task("new", { name: "lynx" })), hasCode("OWNER_INTERNAL_ERROR"));
  await assert.rejects(c.submit("later-run", { resume: idle.run.agent_id, prompt: "new" }), hasCode("OWNER_INTERNAL_ERROR"));
  const replay = await c.answer("accepted-answer", first.run.agent_id, first.token, "first answer", {
    prepare: () => assert.fail("accepted replay must not prepare again"),
  });
  assert.equal(replay.run_id, accepted.run_id); assert.equal(replay.task, 2);
  assert.equal(c.stats().runs, before); assert.equal(first.port.calls.length, 2); assert.equal(idle.port.calls.length, 1);
});

const admissionFailures = {
  throw: () => { throw new Error("ADMISSION_READER_FAILED"); },
  rejectedPromise: () => Promise.reject(new Error("ADMISSION_READER_FAILED")),
  invalidShape: () => ({ enabled: "yes", revision: 0 }),
};
const admissionFailure = (stage, kind) => kind === "throw" ?
  (stage === "ENTRY" ? { message: "ADMISSION_READER_FAILED" } : hasCode("OBSERVATION_FAILED")) :
  hasCode(kind === "rejectedPromise" ? "ASYNC_OBSERVATION_PORT" : "INVALID_ADMISSION_STATE");

for (const stage of ["ENTRY", "READY"]) for (const [kind, failure] of Object.entries(admissionFailures))
  test(`${stage}-only ${kind} admission failure rejects with zero alert/finished/fault commit and preserves On question binding`, async (t) => {
    let failIn = 0, enabled = true;
    const { c, ports } = await ownerFixture(t, { controller: { admission: () => {
      if (failIn > 0 && --failIn === 0) return failure();
      return { enabled, revision: 0 };
    } } });
    const { run, port } = await started(c, ports, "strict-admission", "otter");
    port.callbacks.alert("must survive reader failure"); port.callbacks.question("Original decision?");
    port.finish("needs input"); await settled(c, run);
    const token = c.view(run.run_id).question_id;
    failIn = stage === "ENTRY" ? 1 : 2;
    await assert.rejects(wait(c, undefined), admissionFailure(stage, kind));
    assert.equal(failIn, 0, "only the intended reader call failed; the next read is healthy");
    assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
    assert.equal(c.view(run.run_id).question_id, token);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().parent_error, undefined);
    assert.equal(c.stats().cleanup_uncertain, false);
    const on = await wait(c, undefined);
    assert.equal(on.reason, "question"); assert.equal(on.workers_disabled, undefined);
    assert.equal(on.agents[0].question_id, token); assert.equal(on.alerts[0].message, "must survive reader failure");
    enabled = false;
    const off = await read(c, run);
    assert.equal(off.workers_disabled, true); assert.equal(off.agents[0].question_id, token);
    assert.equal((await wait(c, undefined)).reason, "nothing_pending");
    enabled = true;
    assert.equal((await wait(c, undefined)).agents[0].question_id, token);
    c.latchParentHistoryFailure(new ParentHistoryError("real existing fault edge"));
    const parentError = c.stats().parent_error;
    failIn = stage === "ENTRY" ? 1 : 2;
    await assert.rejects(wait(c, [run.agent_id]), admissionFailure(stage, kind));
    assert.equal(c.stats().parent_error, parentError); assert.equal(c.stats().internal_error, undefined);
    assert.equal((await wait(c, [run.agent_id])).reason, "owner_blocked", "failed validation cannot acknowledge the edge");
    assert.notEqual((await wait(c, [run.agent_id])).reason, "owner_blocked");
    await tick();
  });

for (const [kind, failure] of Object.entries(admissionFailures))
  test(`registered ${kind} admission failure isolates its observer from peer publication and real lifecycle settlement`, async (t) => {
    let failNext = false;
    const { c, ports } = await ownerFixture(t, { controller: { admission: () => {
      if (failNext) { failNext = false; return failure(); }
      return { enabled: true, revision: 0 };
    } } });
    const { run, port } = await started(c, ports, "admission-isolation", "otter");
    const bad = wait(c, [run.agent_id], 3000), rejected = assert.rejects(bad, admissionFailure("READY", kind));
    const peer = wait(c, [run.agent_id], 3000), lifecycle = c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 });
    failNext = true;
    assert.doesNotThrow(() => port.callbacks.alert("accepted despite invalid reader"));
    await rejected;
    const published = await peer;
    assert.equal(published.reason, "alert"); assert.equal(published.alerts[0].message, "accepted despite invalid reader");
    assert.equal(finishedBit(c, run), false); assert.equal(c.view(run.run_id).status, "running");
    assert.doesNotThrow(() => port.finish("normal result"));
    assert.equal(await lifecycle, "ready"); await settled(c, run);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().parent_error, undefined);
    assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().finalizing, 0);
    assert.equal(finishedBit(c, run), false, "lifecycle settlement does not present finished");
    await tick();
  });

test("command admission fail-closed catch cannot hide swallowed readonly reentry", async (t) => {
  let reenter;
  const { c, ports } = await ownerFixture(t, { controller: { admission: () => {
    reenter?.(); return { enabled: true, revision: 0 };
  } } });
  const { run, port } = await started(c, ports, "command-reentry", "otter");
  reenter = () => { assert.throws(() => c.cancel(run.run_id), hasCode("OBSERVATION_REENTRANCY")); };
  assert.throws(() => c.submit("forbidden", task("forbidden", { name: "orca" })), hasCode("OBSERVATION_REENTRANCY"));
  reenter = undefined;
  assert.equal(c.stats().runs, 1); assert.equal(c.view(run.run_id).status, "running"); assert.equal(port.stopped, 0);
  assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
});

test("accepted alert wakes an observation before execution ends; no waiter leaves it pending and repeats remain distinct", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "early", "otter");
  const watching = wait(c, [run.agent_id], 3000);
  assert.doesNotThrow(() => port.callbacks.alert("important"));
  const first = await watching;
  assert.equal(first.reason, "alert"); assert.deepEqual(first.alerts, [{ agent: "otter", task: 1, label: "early", message: "important" }]);
  assert.equal(first.alerts_pending, 0); assert.equal(c.view(run.run_id).status, "running"); assert.equal(port.stopped, 0);
  port.callbacks.alert("same body"); port.callbacks.alert("same body");
  assert.equal(c.view(run.run_id).pending_messages, 2);
  const snapshot = await read(c, run);
  assert.equal(snapshot.reason, "snapshot"); assert.deepEqual(snapshot.alerts.map(({ message }) => message), ["same body", "same body"]);
  assert.equal(snapshot.alerts_pending, 0); assert.equal((await read(c, run)).alerts, undefined);
  assert.equal(finishedBit(c, run), false); assert.equal(c.stats().active, 1);
});

test("same-alert A/B contention consumes once while B stays registered; abort neither ends child work nor consumes later pending messages", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "contended", "otter"), abortB = new AbortController();
  const a = wait(c, [run.agent_id], 3000), b = wait(c, [run.agent_id], 3000, context(() => {}, abortB.signal));
  let bResolved = false;
  const trackedB = b.then((value) => { bResolved = true; return value; });
  port.callbacks.alert("one event");
  assert.equal((await a).alerts[0].message, "one event"); await tick();
  assert.equal(bResolved, false); assert.equal(c.view(run.run_id).pending_messages, 0); assert.equal(c.view(run.run_id).status, "running");
  abortB.abort(); const aborted = await trackedB;
  assert.equal(aborted.reason, "aborted"); assert.equal(aborted.alerts, undefined); assert.equal(aborted.finished, undefined);
  port.callbacks.alert("after detached B");
  assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(port.stopped, 0);
  assert.equal((await read(c, run)).alerts[0].message, "after detached B");
});

test("real FIFO enforces Agent 16 across reused Runs, no eviction, and lifecycle kill consumes nothing", async (t) => {
  const { c, ports } = await ownerFixture(t), { run: old, port } = await started(c, ports, "old", "otter");
  const oldCallbacks = port.callbacks;
  for (let index = 0; index < 10; index++) oldCallbacks.alert(`old-${index}`);
  port.finish("old result"); await settled(c, old);
  const next = await c.submit("reuse", { resume: old.agent_id, prompt: "next", description: "next" });
  await until(() => port.calls.length === 2 && port.streaming);
  for (let index = 0; index < 6; index++) port.callbacks.alert(`next-${index}`);
  assert.equal(next.task, 2);
  assert.throws(() => port.callbacks.alert("seventeenth"), hasCode("ALERT_QUEUE_FULL", { scope: "agent", limit: 16 }));
  assert.equal(c.view(old.run_id).pending_messages, 10); assert.equal(c.view(next.run_id).pending_messages, 6);
  assert.throws(() => oldCallbacks.alert("stale callback cannot succeed"), harnessFailure);
  port.autoStop = true;
  assert.equal((await c.kill(next.agent_id, 1000)).state, "released");
  await settled(c, next);
  assert.equal(pendingCount(c, [old, next]), 16); assert.equal(finishedBit(c, old), false); assert.equal(finishedBit(c, next), false);
  const publication = await wait(c, undefined);
  assert.equal(publication.reason, "alert"); assert.deepEqual(publication.agents, []);
  assert.deepEqual(publication.alerts.map(({ task }) => task), [...Array(10).fill(1), ...Array(6).fill(2)]);
  assert.equal(publication.alerts_pending, 0); assert.equal(pendingCount(c, [old, next]), 0);
});

test("Owner 64 quota precedes Agent quota; killed history still blocks a newly admitted Agent until publication", async (t) => {
  const { c, ports } = await ownerFixture(t, { controller: { concurrency: 4 } }), running = [];
  for (const name of ["otter", "orca", "lynx", "marten"]) running.push(await started(c, ports, name, name));
  for (const { port, run } of running) for (let index = 0; index < 16; index++) port.callbacks.alert(`${run.name}-${index}`);
  assert.throws(() => running[0].port.callbacks.alert("both full"), hasCode("ALERT_QUEUE_FULL", { scope: "owner", limit: 64 }));
  running[0].port.autoStop = true; await c.kill(running[0].run.agent_id, 1000);
  assert.equal(pendingCount(c, running.map(({ run }) => run)), 64);
  const newcomer = await started(c, ports, "newcomer", "badger");
  assert.throws(() => newcomer.port.callbacks.alert("no reserved space"), hasCode("ALERT_QUEUE_FULL", { scope: "owner", limit: 64 }));
  assert.equal(c.view(newcomer.run.run_id).pending_messages, 0);
  const history = await read(c, running[0].run);
  assert.equal(history.alerts.length, 16); assert.equal(history.alerts_pending, 0);
  assert.equal(pendingCount(c, running.map(({ run }) => run)), 48);
  assert.doesNotThrow(() => newcomer.port.callbacks.alert("publication released capacity"));
  assert.equal(c.view(newcomer.run.run_id).pending_messages, 1);
});

test("invalid/closed child communication never reports acceptance or mutates already queued messages", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "validation", "otter");
  port.callbacks.alert("accepted"); assert.equal(port.callbacks.question("first?"), "recorded");
  for (const invalid of [null, "", " \t\n", "x".repeat(8193)]) {
    assert.throws(() => port.callbacks.alert(invalid), harnessFailure);
    assert.throws(() => port.callbacks.question(invalid), hasCode("INVALID_QUESTION"));
  }
  assert.equal(port.callbacks.question("first?"), "already_recorded");
  assert.equal(port.callbacks.question("different valid question?"), "already_recorded");
  const saved = port.callbacks; c.cancel(run.run_id);
  assert.throws(() => saved.alert("after stop"), harnessFailure); assert.throws(() => saved.question("after stop?"), harnessFailure);
  port.finish("cancelled", "aborted"); await settled(c, run);
  assert.throws(() => saved.alert("after exit"), harnessFailure);
  const historical = await read(c, run);
  assert.equal(historical.agents[0].question, "first?"); assert.equal(historical.agents[0].question_id, undefined);
  assert.deepEqual(historical.alerts.map(({ message }) => message), ["accepted"]);
  assert.equal(c.view(run.run_id).has_question, false); assert.equal(c.view(run.run_id).question_id, undefined);
  assert.equal(Object.hasOwn(c.view(run.run_id), "notification_drops"), false);
});

test("action snapshots/waits bind exactly the new Run while cursor read keeps original result and Agent-wide alerts", async (t) => {
  const { c, ports } = await ownerFixture(t), { run: old, port } = await started(c, ports, "original", "otter");
  port.callbacks.alert("old task alert"); port.finish("abcdefghij"); await settled(c, old);
  const page = c.getResult(old.run_id, { limit: 3 }); assert.equal(page.text, "abc"); assert(page.next_cursor);
  const current = await c.submit("current", { resume: old.agent_id, prompt: "current", description: "current" });
  await until(() => port.calls.length === 2 && port.streaming);
  const immediate = await inline(c, current);
  assert.equal(immediate.reason, "snapshot"); assert.deepEqual(immediate.action, { type: "agent_run", agent: "otter", task: 2 });
  assert.equal(immediate.alerts, undefined); assert.equal(immediate.alerts_pending, 0); assert.equal(c.view(old.run_id).pending_messages, 1);
  let resolved = false;
  const positive = inline(c, current, "agent_run", 3000).then((value) => { resolved = true; return value; });
  await tick(); assert.equal(resolved, false, "old same-Agent message cannot intercept inline wait");
  port.callbacks.alert("current task alert");
  const early = await positive; assert.equal(early.reason, "alert"); assert.deepEqual(early.alerts.map(({ task }) => task), [2]);
  assert.equal(c.view(old.run_id).pending_messages, 1);
  port.callbacks.alert("new message for Agent read");
  const cursorRead = await read(c, old, { cursor: page.next_cursor, max_chars: 3 });
  assert.equal(cursorRead.reason, "snapshot"); assert.equal(cursorRead.action, undefined);
  assert.equal(cursorRead.agents[0].task, 1); assert.equal(cursorRead.agents[0].result, "def");
  assert.deepEqual(cursorRead.alerts.map(({ task, message }) => [task, message]), [[1, "old task alert"], [2, "new message for Agent read"]]);
  assert.equal(cursorRead.alerts_pending, 0);
  assert.equal(decodeResultCursor(cursorRead.agents[0].next_cursor).offset, 6);
  const latest = await read(c, current); assert.equal(latest.agents[0].task, 2); assert.equal(latest.agents[0].status, "running");
});

test("compact cursor binding rejects foreign fingerprints and invalid retained offsets without committing alerts or finished; EOF pins the old Run", async (t) => {
  const { c, ports } = await ownerFixture(t), { run: original, port } = await started(c, ports, "cursor-original", "otter");
  const text = "a😀z";
  port.callbacks.alert("original pending alert"); port.finish(text); await settled(c, original);
  const identity = { owner: c.identity.owner_id, generation: c.identity.generation, run: original.run_id,
    version: c.view(original.run_id).result_ref.digest };
  const current = await c.submit("cursor-reuse", { resume: original.agent_id, prompt: "current task" });
  await until(() => port.calls.length === 2 && port.streaming);
  port.callbacks.alert("current pending alert");
  const valid = encodeResultCursor(identity, 0), [prefix, encodedOffset] = valid.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = `${prefix.slice(0, -1)}${alphabet[alphabet.indexOf(prefix.at(-1)) + 1]}.${encodedOffset}`;
  const invalid = [
    ...["owner", "generation", "run", "version"].map((field) => [field,
      encodeResultCursor({ ...identity, [field]: field === "version" ?
        `${identity.version[0] === "0" ? "1" : "0"}${identity.version.slice(1)}` : randomUUID() }, 0)]),
    ["malformed prefix", valid.replace(/^r1_/, "r2_")],
    ["noncanonical fingerprint", noncanonical],
    ["past retained end", encodeResultCursor(identity, text.length + 1)],
    ["surrogate interior", encodeResultCursor(identity, 2)],
  ];
  for (const [label, cursor] of invalid) {
    if (label === "past retained end" || label === "surrogate interior") {
      assert.doesNotThrow(() => decodeResultCursor(cursor), "valid codec input must still undergo retained-result binding checks");
    }
    const guided = (error) => {
      assert(hasCode("INVALID_CURSOR")(error));
      assert.match(error.details.resolution, /agent and next_cursor exactly as returned together/);
      assert.match(error.details.resolution, /does not recover a specific older task/);
      assert.doesNotMatch(error.details.resolution, /Re-read.*without a cursor/);
      return true;
    };
    await assert.rejects(read(c, original, { cursor }), guided, label);
    assert.throws(() => c.getResult(original.run_id, { cursor }), guided, `${label}: same core recovery guidance`);
    assert.equal(c.view(original.run_id).pending_messages, 1, `${label}: original alert remains pending`);
    assert.equal(c.view(current.run_id).pending_messages, 1, `${label}: Agent-wide current alert remains pending`);
    assert.equal(finishedBit(c, original), false, `${label}: original terminal row was not presented`);
    assert.equal(finishedBit(c, current), false);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
  }
  const eof = await read(c, current, { cursor: encodeResultCursor(identity, text.length) });
  assert.equal(eof.reason, "snapshot"); assert.equal(eof.agents[0].task, 1); assert.equal(eof.agents[0].status, "completed");
  assert.equal(eof.agents[0].result, ""); assert.equal(Object.hasOwn(eof.agents[0], "next_cursor"), false);
  assert.equal(eof.agents[0].result_omitted, undefined);
  assert.deepEqual(eof.alerts.map(({ task, message }) => [task, message]), [[1, "original pending alert"], [2, "current pending alert"]]);
  assert.equal(finishedBit(c, original), true); assert.equal(finishedBit(c, current), false);
  assert.equal(c.view(current.run_id).status, "running");
  assert.equal((await read(c, current)).agents[0].task, 2, "without the EOF cursor the Agent still addresses its current Run");
});

test("a runtime compact cursor cannot cross fresh Owner generations with the same Owner ID, Agent name, task and result", async (t) => {
  const owner_id = randomUUID(), first = await ownerFixture(t, { owner_id }), second = await ownerFixture(t, { owner_id });
  assert.equal(first.c.identity.owner_id, second.c.identity.owner_id);
  assert.notEqual(first.c.identity.generation, second.c.identity.generation);
  const a = await started(first.c, first.ports, "same-task", "otter"), b = await started(second.c, second.ports, "same-task", "otter");
  const text = "identical retained result";
  a.port.finish(text); await settled(first.c, a.run);
  b.port.callbacks.alert("second Owner original pending alert"); b.port.finish(text); await settled(second.c, b.run);
  assert.equal(first.c.view(a.run.run_id).result_ref.digest, second.c.view(b.run.run_id).result_ref.digest);
  const issued = await read(first.c, a.run, { max_chars: 1 }), cursor = issued.agents[0].next_cursor;
  assert.equal(issued.agents[0].task, 1); assert.equal(decodeResultCursor(cursor).offset, 1);
  assert.equal(second.c.view(b.run.run_id).task, 1);
  await assert.rejects(read(second.c, b.run, { cursor }), hasCode("INVALID_CURSOR"));
  assert.equal(second.c.view(b.run.run_id).pending_messages, 1); assert.equal(finishedBit(second.c, b.run), false);
  assert.equal(second.c.stats().internal_error, undefined); assert.equal(second.c.stats().cleanup_uncertain, false);
  const local = await read(second.c, b.run);
  assert.equal(local.agents[0].result, text); assert.equal(local.alerts[0].message, "second Owner original pending alert");
  assert.equal(finishedBit(second.c, b.run), true);
});

for (const [budget, aText] of [["escaped-byte", "\u0000".repeat(16000)], ["text", "A".repeat(16384)]])
  test(`bound old result limited by ${budget} budget after reuse keeps a model cursor, including Off/killed reads and legacy interoperability`, async (t) => {
  let admission = { enabled: true, revision: 0 };
  const { c, ports } = await ownerFixture(t, { controller: { concurrency: 2, admission: () => admission } });
  const a = await started(c, ports, "large-result", "otter"), b = await started(c, ports, "old-result", "orca");
  let published = false;
  const bound = wait(c, [a.run.agent_id, b.run.agent_id], 3000).then((value) => { published = true; return value; });
  const originalText = "oldB result ".repeat(200); // Exactly 2400 retained UTF-16 units.
  assert.equal(originalText.length, 2400);
  b.port.finish(originalText); await settled(c, b.run); await tick();
  assert.equal(published, false, "all-mode still waits for A");
  const reused = await c.submit("reuse-b", { resume: b.run.agent_id, prompt: "new B task" });
  await until(() => b.port.calls.length === 2 && b.port.streaming);
  a.port.finish(aText); await settled(c, a.run);
  const result = await bound;
  assert.equal(result.reason, "done");
  assert.deepEqual(result.agents.map(({ agent, task }) => [agent, task]), [["otter", 1], ["orca", 1]]);
  const [large, omitted] = result.agents;
  if (budget === "escaped-byte") {
    assert(large.result.length > 0 && large.result.length < aText.length);
    assert.equal(decodeResultCursor(large.next_cursor).offset, large.result.length);
  } else {
    assert.equal(large.result, aText); assert.equal(Object.hasOwn(large, "next_cursor"), false);
    assert.equal(omitted.result, undefined); assert.equal(omitted.result_omitted, true);
  }
  // Cursor reservation may let a few B bytes fit in the original NUL repro;
  // text-budget exhaustion independently exercises a wholly omitted B page.
  const displayed = omitted.result ?? "", offset = displayed.length;
  assert(offset < originalText.length); assert.equal(displayed, originalText.slice(0, offset));
  assert.match(omitted.next_cursor, /^r1_[A-Za-z0-9_-]{22}\.[0-9a-z]{11}$/);
  assert.equal(omitted.next_cursor.length, 37); assert.equal(decodeResultCursor(omitted.next_cursor).offset, offset);
  assert.equal((await read(c, reused)).agents[0].task, 2, "ordinary Agent addressing has moved on");
  await assert.rejects(read(c, a.run, { cursor: omitted.next_cursor }), hasCode("INVALID_CURSOR"));
  const first = await read(c, b.run, { cursor: omitted.next_cursor, max_chars: 1000 });
  assert.equal(first.agents[0].task, 1); assert.equal(first.agents[0].result, originalText.slice(offset, offset + 1000));
  assert.equal(decodeResultCursor(first.agents[0].next_cursor).offset, offset + 1000);
  admission = { enabled: false, revision: 1 };
  b.port.autoStop = true; assert.equal((await c.kill(b.run.agent_id, 1000)).state, "released"); await settled(c, reused);
  const final = await read(c, b.run, { cursor: first.agents[0].next_cursor, max_chars: 16384 });
  assert.equal(final.workers_disabled, true); assert.equal(final.agents[0].task, 1);
  assert.equal(displayed + first.agents[0].result + final.agents[0].result, originalText);
  assert.equal(Object.hasOwn(final.agents[0], "next_cursor"), false, "EOF removes even the pre-reserved cursor");
  const reread = await read(c, b.run, { cursor: omitted.next_cursor });
  assert.equal(reread.agents[0].result, originalText.slice(offset)); assert.equal(reread.workers_disabled, true);
  assert.equal(Object.hasOwn(reread.agents[0], "next_cursor"), false);
  // Public legacy result paging can consume a compact model cursor and vice versa.
  const legacy = c.getResult(b.run.run_id, { cursor: omitted.next_cursor, limit: 600 });
  assert.equal(legacy.text, originalText.slice(offset, offset + 600)); assert(legacy.next_cursor);
  assert.equal(JSON.parse(Buffer.from(legacy.next_cursor, "base64url").toString()).offset, offset + 600);
  const fromLegacy = await read(c, b.run, { cursor: legacy.next_cursor, max_chars: 600 });
  assert.equal(fromLegacy.agents[0].task, 1); assert.equal(fromLegacy.agents[0].result, originalText.slice(offset + 600, offset + 1200));
  assert.equal(decodeResultCursor(fromLegacy.agents[0].next_cursor).offset, offset + 1200);
  const toLegacy = c.getResult(b.run.run_id, { cursor: fromLegacy.agents[0].next_cursor, limit: 1200 });
  assert.equal(toLegacy.text, originalText.slice(offset + 1200)); assert.equal(toLegacy.next_cursor, undefined);
});

for (const wait_ms of [0, 300000]) test(`default empty wait returns nothing_pending without arming a timer (${wait_ms})`, async (t) => {
  const { c } = await ownerFixture(t);
  const native = globalThis.setTimeout; let armed = 0;
  t.mock.method(globalThis, "setTimeout", (...args) => { armed++; return native(...args); });
  const empty = await wait(c, undefined, wait_ms);
  t.mock.restoreAll();
  assert.equal(empty.reason, "nothing_pending"); assert.deepEqual(empty.agents, []); assert.equal(empty.alerts_pending, 0); assert.equal(armed, 0);
});

test("Off initial default binding excludes existing question, stays bound across On/new work, and does not drift", async (t) => {
  let admission = { enabled: true, revision: 0 };
  const { c, ports } = await ownerFixture(t, { controller: { concurrency: 2, admission: () => admission } });
  const asking = await question(c, ports), peer = await started(c, ports, "peer", "orca");
  admission = { enabled: false, revision: 1 };
  const boundOff = wait(c, undefined, 3000);
  admission = { enabled: true, revision: 2 };
  const later = await started(c, ports, "later", "marten");
  peer.port.finish("peer done"); await settled(c, peer.run);
  const result = await boundOff;
  assert.equal(result.reason, "done"); assert.deepEqual(result.agents.map(({ agent }) => agent), ["orca"]);
  assert.equal(result.workers_disabled, undefined); assert.equal(c.view(later.run.run_id).status, "running");
  const nextOn = await wait(c, undefined);
  assert.equal(nextOn.reason, "question"); assert.deepEqual(nextOn.agents.map(({ agent }) => agent), ["otter", "marten"]);
  assert.equal(nextOn.agents[0].question_id, asking.token);
});

test("On-bound running task that asks after Off still returns question; Off explicit reads retain identity", async (t) => {
  let admission = { enabled: true, revision: 0 };
  const { c, ports } = await ownerFixture(t, { controller: { admission: () => admission } }), { run, port } = await started(c, ports, "later-question", "otter");
  const boundOn = wait(c, undefined, 3000);
  admission = { enabled: false, revision: 1 };
  port.callbacks.question("question while accepted work continues Off?"); port.finish("need input"); await settled(c, run);
  const result = await boundOn, token = result.agents[0].question_id;
  assert.equal(result.reason, "question"); assert.equal(result.workers_disabled, true); assert.match(token, /^q_[0-9a-f]{32}$/);
  assert.equal((await wait(c, undefined)).reason, "nothing_pending");
  const explicit = await wait(c, [run.agent_id]); assert.equal(explicit.reason, "question"); assert.equal(explicit.workers_disabled, true);
  assert.equal(explicit.agents[0].question_id, token); assert.equal((await read(c, run)).agents[0].question_id, token);
  await assert.rejects(c.answer("off-answer", run.agent_id, token, "yes"), hasCode("WORKERS_DISABLED"));
  admission = { enabled: true, revision: 2 };
  assert.equal((await wait(c, undefined)).agents[0].question_id, token);
  assert.equal((await wait(c, undefined)).reason, "question", "finished presentation is not question consumption");
});

test("atomic question reference: pre-settlement/foreign/stale answers do not allocate; send/run never answer implicitly", async (t) => {
  const { c, ports } = await ownerFixture(t, { controller: { concurrency: 2 } }), { run, port } = await started(c, ports, "q1", "otter");
  port.callbacks.question("Q1?");
  const earlyToken = questionId(c.identity.owner_id, c.identity.generation, run.run_id), before = c.stats().runs;
  assert.equal(c.view(run.run_id).question_id, undefined);
  await assert.rejects(c.answer("too-early", run.agent_id, earlyToken, "yes"), harnessFailure);
  assert.equal(c.stats().runs, before); assert.equal(port.streaming, true);
  port.finish("Q1 waiting"); await settled(c, run);
  const token = c.view(run.run_id).question_id, other = await question(c, ports, "q2", "orca");
  await assert.rejects(c.answer("wrong-agent", other.run.agent_id, token, "yes"), harnessFailure);
  await assert.rejects(c.answer("wrong-id", run.agent_id, "q_" + "0".repeat(32), "yes"), harnessFailure);
  assert.equal(c.stats().runs, before + 1);
  const notDelivered = await c.send("send-not-answer", run.agent_id, "answer-looking text");
  assert.equal(notDelivered.delivery, "not_delivered"); assert.equal(notDelivered.view.run_id, run.run_id);
  const sendBody = await observe(c, { kind: "action", run_id: notDelivered.view.run_id,
    action: { type: "agent_send", delivery: notDelivered.delivery } });
  assert.equal(sendBody.agents[0].question_id, token); assert.equal(sendBody.action.task, 1); assert.equal(c.stats().runs, before + 1);
  await assert.rejects(c.submit("run-not-answer", { resume: run.agent_id, prompt: "unrelated" }), hasCode("PENDING_QUESTION"));
});

test("answer identity replays exactly once, conflicts reject, and two new request IDs compete for one reservation", async (t) => {
  const { c, ports } = await ownerFixture(t), asking = await question(c, ports, "fixed-question", "otter", { max_turns: 7, max_duration_ms: 123456 });
  let prepared = 0;
  const accepted = c.answer("answer-a", asking.run.agent_id, asking.token, "chosen", { prepare: () => { prepared++; } });
  const competing = c.answer("answer-b", asking.run.agent_id, asking.token, "alternative");
  const [one, two] = await Promise.allSettled([accepted, competing]);
  assert.equal(one.status, "fulfilled"); assert.equal(two.status, "rejected"); harnessFailure(two.reason);
  const continuation = one.value; assert.equal(prepared, 1); assert.equal(c.stats().runs, 2); assert.equal(continuation.task, 2);
  assert.equal(continuation.description, asking.run.description); assert.equal(continuation.max_turns, 7); assert.equal(continuation.max_duration_ms, 123456);
  assert.deepEqual(continuation.effective_settings, asking.run.effective_settings);
  const replay = await c.answer("answer-a", asking.run.agent_id, asking.token, "chosen", { prepare: () => { prepared++; } });
  assert.equal(replay.run_id, continuation.run_id); assert.equal(prepared, 1);
  await assert.rejects(c.answer("answer-a", asking.run.agent_id, asking.token, "changed"), hasCode("REQUEST_CONFLICT"));
  assert.equal(c.view(asking.run.run_id).question_id, undefined);
  await until(() => asking.port.calls.length === 2 && asking.port.streaming);
  asking.port.finish("answered"); await settled(c, continuation);
  await assert.rejects(c.answer("stale-after-input", asking.run.agent_id, asking.token, "again"), harnessFailure);
  assert.equal(c.stats().runs, 2); assert.equal(c.view(asking.run.run_id).has_question, false);
});

// A controlled port exposes the real inputEntered boundary instead of lying
// about Controller state. The Controller still owns reservation and settlement.
class DelayedInputPort extends FakePort {
  deferNextInput = false;
  run(prompt, callbacks, identity) {
    if (!this.deferNextInput) return super.run(prompt, callbacks, identity);
    this.deferNextInput = false;
    this.enterInput = callbacks.inputEntered;
    return super.run(prompt, { ...callbacks, inputEntered() {} }, identity);
  }
}

test("inputEntered-before/after boundary: pre-input cancellation restores original token only after finalizing, even after finished was presented", async (t) => {
  let holdHistory = false;
  const entered = deferred(); let gate;
  const { c, ports, hold } = await ownerFixture(t, { createPort: () => new DelayedInputPort(), history: async (point) => {
    if (point === "finish" && holdHistory) { entered.resolve(); await gate.promise; }
  } });
  gate = hold();
  const asking = await question(c, ports);
  assert.equal((await read(c, asking.run)).agents[0].question_id, asking.token); assert.equal(finishedBit(c, asking.run), true);
  asking.port.deferNextInput = true;
  const continuation = await c.answer("pre-input", asking.run.agent_id, asking.token, "yes");
  await until(() => asking.port.calls.length === 2 && asking.port.streaming);
  assert.equal(c.view(asking.run.run_id).question_id, undefined);
  holdHistory = true; c.cancel(continuation.run_id); asking.port.finish("cancelled before input", "aborted"); await entered.promise;
  assert.equal(c.view(continuation.run_id).phase, "finalizing");
  assert.equal(c.view(asking.run.run_id).question_id, undefined);
  const whileFinalizing = await wait(c, undefined);
  assert.equal(whileFinalizing.reason, "timeout"); assert.deepEqual(whileFinalizing.agents.map(({ task }) => task), [2]);
  assert.equal(whileFinalizing.agents[0].question_id, undefined);
  holdHistory = false; gate.resolve(); await settled(c, continuation);
  const restored = await wait(c, undefined);
  assert.equal(restored.reason, "question"); assert.deepEqual(restored.agents.map(({ task }) => task), [1]);
  assert.equal(restored.agents[0].question_id, asking.token); assert.equal(finishedBit(c, asking.run), true);
  assert.equal((await c.answer("pre-input", asking.run.agent_id, asking.token, "yes")).run_id, continuation.run_id);
  assert.equal(c.stats().runs, 2, "old request ID replays the cancelled continuation, not new answer work");
  const afterInput = await c.answer("new-answer", asking.run.agent_id, asking.token, "no");
  await until(() => asking.port.calls.length === 3 && asking.port.streaming);
  assert.equal(c.view(asking.run.run_id).has_question, false);
  asking.port.finish("failure after input", "error", "synthetic provider failure"); await settled(c, afterInput);
  assert.equal(c.view(asking.run.run_id).question_id, undefined);
  assert.equal((await wait(c, undefined)).reason, "nothing_pending");
  await assert.rejects(c.answer("cannot-reopen", asking.run.agent_id, asking.token, "again"), harnessFailure);
});

test("queued answer cancellation restores the same question; it does not create a child prompt or consume old alerts", async (t) => {
  const { c, ports } = await ownerFixture(t), asking = await started(c, ports, "queued-question", "otter");
  asking.port.callbacks.alert("pending from original question Run"); asking.port.callbacks.question("choose?");
  asking.port.finish("choose"); await settled(c, asking.run); asking.token = c.view(asking.run.run_id).question_id;
  const blocker = await started(c, ports, "blocker", "orca");
  const answer = await c.answer("queued-answer", asking.run.agent_id, asking.token, "yes");
  assert.equal(answer.status, "queued"); c.cancel(answer.run_id); await settled(c, answer);
  assert.equal(asking.port.calls.length, 1); assert.equal(c.view(asking.run.run_id).question_id, asking.token);
  assert.equal(c.view(asking.run.run_id).pending_messages, 1); assert.equal(finishedBit(c, asking.run), false);
  const next = await c.answer("retry-new-id", asking.run.agent_id, asking.token, "no");
  blocker.port.finish("unblocks"); await settled(c, blocker.run);
  await until(() => asking.port.calls.length === 2 && asking.port.streaming);
  assert.equal(asking.port.calls[1].prompt, "no"); asking.port.finish("no"); await settled(c, next);
});

test("same name/task in another Owner generation cannot accept the prior question token", async (t) => {
  const owner_id = randomUUID(), first = await ownerFixture(t, { owner_id }), second = await ownerFixture(t, { owner_id });
  const q1 = await question(first.c, first.ports), q2 = await question(second.c, second.ports);
  assert.notEqual(first.c.identity.generation, second.c.identity.generation); assert.notEqual(q1.token, q2.token);
  assert.equal(first.c.view(q1.run.run_id).task, 1); assert.equal(second.c.view(q2.run.run_id).task, 1);
  await assert.rejects(second.c.answer("cross-generation", q2.run.agent_id, q1.token, "yes"), harnessFailure);
  assert.equal(second.c.stats().runs, 1); assert.equal(second.c.view(q2.run.run_id).question_id, q2.token);
  await second.c.kill(q2.run.agent_id, 1000);
  assert.equal(second.c.view(q2.run.run_id).question_id, undefined);
  await assert.rejects(second.c.answer("killed", q2.run.agent_id, q2.token, "yes"), harnessFailure);
});

for (const effect of ["submit", "send", "answer", "cancel", "observe", "lifecycle", "kill", "shutdown", "release", "steer",
  "drainUsage", "returnUsage", "alert", "question", "output", "inputEntered", "runtime", "drain", "turnStart", "turnEnd", "touched", "fault"])
  test(`guarded entry validator forbids swallowed ${effect} reentry before ANY effects`, async (t) => {
    const { c, ports, events } = await ownerFixture(t), { run, port } = await started(c, ports, "gate", "otter");
    let nestedValidation = 0;
    const operations = {
      submit: () => c.submit("forbidden-submit", task("forbidden", { name: "orca" })),
      send: () => c.send("forbidden-send", run.agent_id, "forbidden"),
      answer: () => c.answer("forbidden-answer", run.agent_id, questionId(c.identity.owner_id, c.identity.generation, run.run_id), "forbidden"),
      cancel: () => c.cancel(run.run_id),
      observe: () => c.observe({ kind: "read", agent_id: run.agent_id }, context(() => { nestedValidation++; })),
      lifecycle: () => c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 1 }),
      kill: () => c.kill(run.agent_id, 1),
      shutdown: () => c.shutdown(1),
      release: () => c.release(run.agent_id),
      steer: () => c.steer(run.run_id, "forbidden"),
      drainUsage: () => c.drainUsage(),
      returnUsage: () => c.returnUsage(emptyLedger()),
      alert: () => port.callbacks.alert("forbidden"),
      question: () => port.callbacks.question("forbidden?"),
      output: () => port.callbacks.output({ text: "forbidden", total_chars: 9, truncated: false }),
      inputEntered: () => port.callbacks.inputEntered(),
      runtime: () => port.callbacks.runtime({ activity: "tool" }),
      drain: () => port.callbacks.drain("deliveries"),
      turnStart: () => port.callbacks.turnStart(),
      turnEnd: () => port.callbacks.turnEnd(true),
      touched: () => port.callbacks.touched("forbidden.txt"),
      fault: () => c.latchParentHistoryFailure(new ParentHistoryError("forbidden")),
    };
    const eventCount = events.length, initialTurns = c.view(run.run_id).turns;
    await assert.rejects(async () => c.observe({ kind: "read", agent_id: run.agent_id }, context(() => {
      assert.throws(operations[effect], hasCode("OBSERVATION_REENTRANCY"));
    })), hasCode("OBSERVATION_REENTRANCY"));
    await tick();
    assert.equal(c.stats().runs, 1); assert.equal(c.stats().active, 1); assert.equal(c.closing, false);
    assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().parent_error, undefined);
    assert.equal(c.view(run.run_id).status, "running"); assert.equal(c.view(run.run_id).pending_messages, 0);
    assert.equal(c.getResult(run.run_id).text, ""); assert.equal(c.view(run.run_id).outcome, undefined);
    assert.equal(c.view(run.run_id).turns, initialTurns); assert.equal(c.view(run.run_id).runtime, undefined);
    assert.equal(c.view(run.run_id).drain, undefined); assert.deepEqual(c.agentSummary(run.agent_id).touched, []);
    assert.equal(c.stats().unreported_usage, undefined);
    assert.equal(nestedValidation, 0); assert.equal(events.length, eventCount); assert.deepEqual(port.inputs, []); assert.equal(port.stopped, 0);
    port.finish("normal after rejected reentry"); await settled(c, run);
    assert.equal(c.view(run.run_id).status, "completed");
  });

test("registered validator failure rejects only its observation: accepted child alert succeeds, peer sees it and lifecycle finish settles", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "isolation", "otter");
  let fail = false, validationCalls = 0;
  const bad = c.observe({ kind: "wait", agent_ids: [run.agent_id], wait_ms: 3000 }, context(() => {
    validationCalls++; if (fail) throw new Error("synthetic observer validator failure");
  }));
  const rejected = assert.rejects(bad, hasCode("OBSERVATION_FAILED")), good = wait(c, [run.agent_id], 3000),
    lifecycle = c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 });
  fail = true;
  assert.doesNotThrow(() => port.callbacks.alert("accepted despite broken observer"));
  await rejected;
  const publication = await good; assert.equal(publication.reason, "alert");
  assert.equal(publication.alerts[0].message, "accepted despite broken observer");
  assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().parent_error, undefined);
  const beforeFinish = validationCalls;
  assert.doesNotThrow(() => port.finish("execution still completes")); assert.equal(await lifecycle, "ready"); await settled(c, run);
  assert.equal(c.view(run.run_id).status, "completed"); assert.equal(c.stats().finalizing, 0); assert.equal(validationCalls, beforeFinish);
});

test("real finish() wake with a failing observer does not poison tracking, finalization or Owner closure", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "finish-isolation", "otter");
  let fail = false;
  const bad = c.observe({ kind: "wait", agent_ids: [run.agent_id], wait_ms: 3000 }, context(() => { if (fail) throw new Error("finish publication failure"); }));
  const rejected = assert.rejects(bad, hasCode("OBSERVATION_FAILED")); fail = true;
  port.finish("settled retained output"); await rejected; await settled(c, run);
  assert.equal(finishedBit(c, run), false); assert.equal(c.getResult(run.run_id).text, "settled retained output");
  assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined);
  assert.equal((await c.shutdown(3000)).closed, true);
});

test("failed context and pre-aborted action preserve queued alert and finished state while accepted command fact remains", async (t) => {
  const { c, ports } = await ownerFixture(t), { run, port } = await started(c, ports, "abort-action", "otter");
  port.callbacks.alert("pending"); port.finish("retained"); await settled(c, run);
  await assert.rejects(async () => c.observe({ kind: "read", agent_id: run.agent_id }, context(() => { throw new HarnessError("STALE_CONTEXT"); })), hasCode("STALE_CONTEXT"));
  assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
  const aborted = await inline(c, run, "agent_spawn", 0, context(() => {}, AbortSignal.abort()));
  assert.equal(aborted.reason, "aborted"); assert.deepEqual(aborted.action, { type: "agent_spawn", agent: "otter", task: 1 });
  assert.equal(aborted.alerts, undefined); assert.equal(aborted.finished, undefined);
  assert.equal(c.view(run.run_id).pending_messages, 1); assert.equal(finishedBit(c, run), false);
  const real = await read(c, run); assert.equal(real.alerts[0].message, "pending"); assert.equal(finishedBit(c, run), true);
});

test("finished is original task identity: current running task 3 plus old task alert/name cannot consume undisplayed task 1", async (t) => {
  const { c, ports } = await ownerFixture(t), otherRuns = [];
  for (const name of ["orca", "lynx", "marten", "badger", "ibis", "rook", "wren", "hare"]) {
    const entry = await started(c, ports, name, name); entry.port.finish(`${name} result`); await settled(c, entry.run); otherRuns.push(entry.run);
  }
  const { run: first, port } = await started(c, ports, "otter-first", "otter");
  port.callbacks.alert("original first task alert"); port.finish("first-result"); await settled(c, first);
  const cursor = c.getResult(first.run_id, { limit: 1 }).next_cursor;
  const second = await c.submit("otter-second", { resume: first.agent_id, prompt: "second" });
  await until(() => port.calls.length === 2 && port.streaming); port.finish("second-result"); await settled(c, second);
  const current = await c.submit("otter-third", { resume: first.agent_id, prompt: "third" });
  await until(() => port.calls.length === 3 && port.streaming);
  assert.equal(c.view(current.run_id).task, 3); assert.equal(finishedBit(c, first), false); assert.equal(finishedBit(c, second), false);
  c.list({ include_released: true }); assert.equal(finishedBit(c, first), false, "roster is non-consuming");
  const publication = await wait(c, [first.agent_id]);
  assert.equal(publication.reason, "alert"); assert.equal(publication.agents[0].task, 3); assert.equal(publication.agents[0].status, "running");
  assert.deepEqual(publication.pending, ["otter"]); assert.equal(publication.alerts[0].task, 1);
  assert.equal(publication.finished.length, 8); assert(publication.finished.every(({ agent }) => agent !== "otter"));
  assert(otherRuns.every((run) => finishedBit(c, run))); assert.equal(finishedBit(c, first), false); assert.equal(finishedBit(c, second), false);
  assert.equal(publication.finished_pending, 2); assert.equal(finishedBit(c, current), false);
  const explicitOriginal = await read(c, first, { cursor, max_chars: 2 });
  assert.equal(explicitOriginal.agents[0].task, 1); assert.equal(explicitOriginal.agents[0].status, "completed");
  assert.equal(finishedBit(c, first), true); assert.equal(finishedBit(c, current), false);
});

for (const [space, aText] of [["ample", "A original result"], ["byte pressure", "\u0000".repeat(16000)]])
  test(`same-name distinct Agents keep original-Run finished association under ${space}`, async (t) => {
    // Core permits duplicate legal names. UUID addressing, not these equal
    // display values, determines which original Run a task row presents.
    const { c, ports } = await ownerFixture(t), a = await started(c, ports, "original-a", "otter");
    a.port.finish(aText); await settled(c, a.run);
    const firstA = await read(c, a.run);
    assert.equal(firstA.agents[0].task, 1); assert.equal(finishedBit(c, a.run), true);
    if (space === "byte pressure") {
      assert(firstA.agents[0].result.length > 0 && firstA.agents[0].result.length < aText.length);
      assert(firstA.agents[0].next_cursor, "present A's terminal row with only a partial result before B exists");
    }
    const b = await started(c, ports, "original-b", "otter"), bText = "B distinct original result";
    b.port.finish(bText); await settled(c, b.run);
    assert.notEqual(a.run.agent_id, b.run.agent_id); assert.notEqual(a.run.run_id, b.run.run_id);
    assert.equal(c.stats().agents, 2);
    assert.deepEqual([c.view(a.run.run_id).name, c.view(a.run.run_id).task], ["otter", 1]);
    assert.deepEqual([c.view(b.run.run_id).name, c.view(b.run.run_id).task], ["otter", 1]);
    assert.equal(finishedBit(c, b.run), false);
    const secondA = await read(c, a.run);
    assert.equal(secondA.agents.length, 1); assert.equal(secondA.agents[0].result, firstA.agents[0].result);
    assert.equal(finishedBit(c, a.run), true);
    if (space === "ample") {
      assert.deepEqual(secondA.finished, [{ agent: "otter", task: 1, status: "completed" }],
        "B is the only unpresented candidate: it needs its own explicit finished row, not an implicit link to A");
      assert.equal(finishedBit(c, b.run), true); assert.equal(secondA.finished_pending, 0);
    } else {
      assert.equal(secondA.response_limit_reached, true); assert.equal(secondA.finished, undefined);
      assert.equal(finishedBit(c, b.run), false, "A's same-name/task/status row must not commit undisplayed B");
      assert.equal(secondA.finished_pending, 1);
    }
    const actualB = await read(c, b.run);
    assert.equal(actualB.agents.length, 1); assert.equal(actualB.agents[0].result, bText);
    assert.equal(actualB.agents[0].task, 1); assert.equal(actualB.agents[0].status, "completed");
    assert.equal(actualB.finished, undefined); assert.equal(actualB.finished_pending, 0);
    assert.equal(finishedBit(c, b.run), true); assert.equal(finishedBit(c, a.run), true);
    assert.equal(c.getResult(a.run.run_id).text, aText.slice(0, 4096));
    assert.equal(c.getResult(b.run.run_id).text, bText);
  });

test("Owner fault broadcasts to A/B captured before edge; later waits do not repeatedly report the same fault", async (t) => {
  const { c, ports } = await ownerFixture(t, { controller: { concurrency: 2 } }), a = await started(c, ports, "a", "otter"), b = await started(c, ports, "b", "orca");
  const beforeA = wait(c, [a.run.agent_id], 3000), beforeB = wait(c, [b.run.agent_id], 3000);
  c.latchParentHistoryFailure(new ParentHistoryError("controlled shared parent write failure"));
  assert.deepEqual((await Promise.all([beforeA, beforeB])).map(({ reason }) => reason), ["owner_blocked", "owner_blocked"]);
  const later = await wait(c, [a.run.agent_id, b.run.agent_id]); assert.equal(later.reason, "timeout");
  assert.equal(a.port.stopped, 0); assert.equal(b.port.stopped, 0); assert.equal(c.stats().active, 2);
});

test("snapshot read does not consume waiting-only fault edge; failure to validate does not acknowledge it", async (t) => {
  const { c, ports } = await ownerFixture(t), { run } = await started(c, ports, "fault-read", "otter");
  c.latchParentHistoryFailure(new ParentHistoryError("unreported edge"));
  assert.equal((await read(c, run)).reason, "snapshot");
  await assert.rejects(async () => c.observe({ kind: "wait", agent_ids: [run.agent_id], wait_ms: 0 }, context(() => { throw new HarnessError("STALE_CONTEXT"); })), hasCode("STALE_CONTEXT"));
  assert.equal((await wait(c, [run.agent_id])).reason, "owner_blocked"); assert.equal((await wait(c, [run.agent_id])).reason, "timeout");
});

test("agent_answer retries replay the accepted continuation action, not its already consumed alerts", async (t) => {
  const { c, ports } = await ownerFixture(t), asking = await question(c, ports);
  const continuation = await c.answer("answer-action", asking.run.agent_id, asking.token, "yes");
  await until(() => asking.port.calls.length === 2 && asking.port.streaming);
  asking.port.callbacks.alert("continuation alert");
  const first = await inline(c, continuation, "agent_answer");
  assert.deepEqual(first.action, { type: "agent_answer", agent: "otter", task: 2 }); assert.equal(first.alerts[0].task, 2);
  const replay = await c.answer("answer-action", asking.run.agent_id, asking.token, "yes"), second = await inline(c, replay, "agent_answer");
  assert.equal(replay.run_id, continuation.run_id); assert.deepEqual(second.action, first.action); assert.equal(second.alerts, undefined); assert.equal(c.stats().runs, 2);
});

test("accepted spawn/run/send retries replay action facts but never cached consumed alerts", async (t) => {
  const { c, ports } = await ownerFixture(t), input = task("spawn identity", { name: "otter" }), run = await c.submit("spawn-id", input);
  await until(() => ports[0]?.streaming); const port = ports[0]; port.callbacks.alert("first spawn alert");
  const first = await inline(c, run, "agent_spawn"); assert.equal(first.alerts[0].message, "first spawn alert");
  const replay = await c.submit("spawn-id", input), second = await inline(c, replay, "agent_spawn");
  assert.deepEqual(second.action, first.action); assert.equal(second.alerts, undefined); assert.equal(c.stats().runs, 1);
  let prepared = 0;
  const delivered = await c.send("send-id", run.agent_id, "steer once", { prepare: () => { prepared++; } });
  assert.equal(delivered.delivery, "steered"); await until(() => port.inputs.includes("steer once"));
  port.callbacks.alert("first send alert");
  const sendRequest = { kind: "action", run_id: delivered.view.run_id, action: { type: "agent_send", delivery: delivered.delivery } };
  const sent = await observe(c, sendRequest); assert.equal(sent.alerts[0].message, "first send alert");
  const resent = await c.send("send-id", run.agent_id, "steer once", { prepare: () => { prepared++; } });
  assert.equal(resent.view.run_id, run.run_id); assert.equal(prepared, 1); assert.equal(port.inputs.filter((value) => value === "steer once").length, 1);
  const retried = await observe(c, sendRequest); assert.deepEqual(retried.action, sent.action); assert.equal(retried.alerts, undefined);
  port.finish("first result"); await settled(c, run);
  const nextInput = { resume: run.agent_id, prompt: "next" }, next = await c.submit("run-id", nextInput);
  await until(() => port.calls.length === 2 && port.streaming); port.callbacks.alert("first run alert");
  const nextObservation = await inline(c, next); assert.equal(nextObservation.alerts[0].task, 2);
  const nextReplay = await c.submit("run-id", nextInput), nextRetried = await inline(c, nextReplay);
  assert.deepEqual(nextRetried.action, nextObservation.action); assert.equal(nextRetried.alerts, undefined); assert.equal(c.stats().runs, 2);
});
