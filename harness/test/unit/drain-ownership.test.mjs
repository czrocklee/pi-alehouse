import assert from "node:assert/strict";
import test from "node:test";
import { PiAgentSessionAdapter, ChildRunGate } from "../../dist/runtime/agent-session.js";
import { FakePort, deferred, ended, fixture, task, until } from "../support/controller-fixture.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
const assistant = { role: "assistant", provider: "p", model: "m", stopReason: "stop",
  content: [{ type: "text", text: "late answer" }], usage };

function sessionFixture() {
  const listeners = new Set();
  const session = { sessionId: "offline-drain", isIdle: true, isStreaming: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    clearQueue: () => ({ steering: [], followUp: [] }), getSteeringMessages: () => [], getFollowUpMessages: () => [],
    async waitForIdle() {}, async abort() {} };
  return { session, listeners, emit(event) { for (const listener of listeners) listener(event); } };
}

test("queue-clear failure cannot release a slot before an accepted delivery exits", async (t) => {
  const root = deferred(), delivery = deferred(), peer = new FakePort();
  t.after(() => { root.resolve(); delivery.resolve(); if (peer.streaming) peer.finish(); });
  const { session, listeners, emit } = sessionFixture();
  let calls = 0, active = 0, clears = 0, waits = 0, created = 0, aborts = 0;
  session.abort = async () => { aborts++; };
  session.clearQueue = () => {
    if (++clears >= 2) throw new Error("PERSISTENT_CLEAR_FAILED");
    return { steering: [], followUp: [] };
  };
  session.waitForIdle = async () => { waits++; assert.equal(session.isIdle, true); };
  session.prompt = async () => {
    const number = ++calls; active++; session.isIdle = false; session.isStreaming = true;
    emit({ type: "message_end", message: { role: "user" } });
    try { await (number === 1 ? root.promise : delivery.promise); }
    finally { active--; session.isIdle = active === 0; session.isStreaming = active !== 0; }
  };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {} });
  port.dispose = async () => {
    assert(session.isIdle); assert.equal(listeners.size, 0);
    return { shutdownExited: true, errors: [] };
  };
  const { controller: c, owner } = await fixture(t, { controller: { concurrency: 1,
    createSession: async () => created++ === 0 ? port : peer } });
  const a = await c.submit("first", task("first")); await until(() => session.isStreaming);
  const b = await c.submit("peer", task("peer"));
  c.steer(a.run_id, "pending delivery"); await until(() => calls === 2);
  root.resolve(); await until(() => clears === 2);
  assert.equal(c.view(a.run_id).execution_exited, false);
  assert.equal(c.stats().active, 1); assert.equal(c.stats().resident, 2);
  assert.equal(c.view(b.run_id).status, "queued"); assert.equal(waits, 0);
  assert.equal(listeners.size, 1); owner.assertHeld();
  assert.equal(c.cancel(a.run_id).result, "cancel_requested");
  await until(() => aborts === 1);
  // Already accepted work is still observed, even after root prompt/clear failure.
  emit({ type: "message_end", message: assistant });
  delivery.resolve(); await until(() => peer.streaming); await ended(c, a);
  assert.equal(c.view(a.run_id).status, "cancelled");
  assert.equal(c.view(a.run_id).usage.total.cost, 0.25);
  assert.equal(c.view(a.run_id).resumable, false);
  assert.equal(waits, 1); assert.equal(listeners.size, 0);
  peer.finish(); await ended(c, b);
});

for (const [waitFails, idleThrows] of [[true, false], [false, false], [false, true]]) test(`unconfirmed SDK idle retains control (waitFails=${waitFails}, idleThrows=${idleThrows})`, async (t) => {
  const { session, listeners, emit } = sessionFixture();
  const confirmIdle = () => Object.defineProperty(session, "isIdle", { configurable: true, writable: true, value: true });
  t.after(confirmIdle);
  const waited = deferred(); let waits = 0, disposed = 0;
  session.prompt = async () => {
    session.isIdle = false;
    if (idleThrows) Object.defineProperty(session, "isIdle", { configurable: true, get() { throw Object.create(null); } });
    emit({ type: "message_end", message: { role: "user" } });
    emit({ type: "message_end", message: assistant });
  };
  session.waitForIdle = async () => { waits++; waited.resolve(); if (waitFails) throw new Error("IDLE_WAIT_FAILED"); };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {} });
  port.dispose = async () => { disposed++; assert(session.isIdle); return { shutdownExited: true, errors: [] }; };
  let mono = 100;
  const { controller: c, owner } = await fixture(t, { controller: { createSession: async () => port,
    clock: { wall: Date.now, mono: () => mono } } });
  const run = await c.submit("idle-proof", task("idle-proof")); await waited.promise;
  assert.equal((await c.wait([run.run_id], { mode: "all", timeout_ms: 10 })).reason, "timeout");
  assert.equal(c.view(run.run_id).execution_exited, false);
  mono += 5000;
  assert.deepEqual(c.view(run.run_id).drain, { waiting_for: "sdk_idle", elapsed_ms: 5000 });
  assert.deepEqual(c.stats().draining, [{ run_id: run.run_id, agent_id: run.agent_id, waiting_for: "sdk_idle", elapsed_ms: 5000 }]);
  assert.equal(c.stats().active, 1); assert.equal(listeners.size, 1); assert.equal(disposed, 0);
  assert.equal(c.cancel(run.run_id).result, "cancel_requested");
  assert.equal((await c.shutdown(5)).closed, false); owner.assertHeld();
  confirmIdle(); await ended(c, run);
  assert.equal(c.view(run.run_id).drain, undefined); assert.equal(c.stats().draining, undefined);
  assert.equal(c.view(run.run_id).resumable, false); assert.equal(c.view(run.run_id).resident, false);
  assert.equal(listeners.size, 0); assert.equal(disposed, 1);
  assert.equal(waits, 1, "an unreliable SDK wait is not retried in a busy loop");
  assert.equal(c.drainUsage().total.cost, 0.25);
});

for (const abortRejects of [false, true]) test(`late tracked abort preserves stop classification (rejects=${abortRejects})`, async (t) => {
  const { session, listeners, emit } = sessionFixture();
  const waiting = deferred(), idleWait = deferred(), abort = deferred();
  const gate = new ChildRunGate(); let settled = false;
  session.prompt = async () => { emit({ type: "message_end", message: { ...assistant, stopReason: "aborted" } }); };
  session.waitForIdle = async () => { waiting.resolve(); await idleWait.promise; };
  session.abort = async () => { await abort.promise; if (abortRejects) throw new Error("ABORT_FAILED"); };
  const port = new PiAgentSessionAdapter({ session, gate, parentBus: { emit() {} }, readiness() {} });
  const result = port.run("go", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {} });
  const observed = result.then(() => { settled = true; }, () => { settled = true; });
  t.after(async () => { idleWait.resolve(); abort.resolve(); await observed; });
  await waiting.promise;
  gate.stopped = true;
  emit({ type: "message_start", message: { role: "user" } });
  idleWait.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isIdle, true); assert.equal(settled, false); assert.equal(listeners.size, 1);
  abort.resolve();
  const facts = await result;
  assert.equal(facts.kind, "aborted"); assert.equal(facts.model_stop_reason, "aborted");
  assert.equal(facts.output.text, "late answer"); assert.equal(facts.usage.total.cost, 0.25);
  assert.throws(() => port.clearInputs(), /INPUT_BOUNDARY_UNCERTAIN/, "classification must not authorize reuse");
  assert.equal(listeners.size, 0);
});

test("SDK idle is rechecked after late deliveries settle", async (t) => {
  const { session, listeners, emit } = sessionFixture();
  const waiting = deferred(), idleWait = deferred(), abort = deferred();
  const gate = new ChildRunGate(), drains = []; let settled = false;
  session.prompt = async () => { emit({ type: "message_end", message: assistant }); };
  session.waitForIdle = async () => { waiting.resolve(); await idleWait.promise; };
  session.abort = async () => { await abort.promise; session.isIdle = false; };
  const port = new PiAgentSessionAdapter({ session, gate, parentBus: { emit() {} }, readiness() {} });
  const result = port.run("go", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {},
    drain(waitingFor) { drains.push(waitingFor); } });
  const observed = result.then(() => { settled = true; }, () => { settled = true; });
  t.after(async () => { idleWait.resolve(); abort.resolve(); await Promise.resolve(); session.isIdle = true; await observed; });
  await waiting.promise;
  emit({ type: "message_start", message: { role: "user" } });
  idleWait.resolve(); await new Promise((resolve) => setImmediate(resolve));
  abort.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(listeners.size, 1);
  assert.deepEqual(drains, ["sdk_idle", "deliveries", "sdk_idle"]);
  session.isIdle = true;
  await assert.rejects(result, /SDK_IDLE_NOT_CONFIRMED/);
  assert.equal(listeners.size, 0);
});

test("a reentrant drain observer's new abort drains before judging SDK idle", async (t) => {
  const { session, emit } = sessionFixture();
  const waiting = deferred(), idleWait = deferred(), first = deferred(), second = deferred(), injected = deferred();
  const gate = new ChildRunGate(); let aborts = 0, settled = false;
  session.prompt = async () => { emit({ type: "message_end", message: { ...assistant, stopReason: "aborted" } }); };
  session.waitForIdle = async () => { waiting.resolve(); await idleWait.promise; };
  session.abort = async () => {
    if (++aborts === 1) await first.promise;
    else { session.isIdle = false; injected.resolve(); await second.promise; session.isIdle = true; }
  };
  const port = new PiAgentSessionAdapter({ session, gate, parentBus: { emit() {} }, readiness() {} });
  const result = port.run("go", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {},
    drain(waitingFor) {
      if (waitingFor === "sdk_idle" && aborts === 1) emit({ type: "message_start", message: { role: "user" } });
    } });
  const observed = result.then(() => { settled = true; }, () => { settled = true; });
  t.after(async () => { idleWait.resolve(); first.resolve(); second.resolve(); await observed; });
  await waiting.promise;
  emit({ type: "message_start", message: { role: "user" } });
  idleWait.resolve(); await new Promise((resolve) => setImmediate(resolve));
  first.resolve(); await injected.promise; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(aborts, 2);
  second.resolve();
  const facts = await result;
  assert.equal(facts.kind, "aborted"); assert.equal(facts.model_stop_reason, "aborted");
  assert.throws(() => port.clearInputs(), /INPUT_BOUNDARY_UNCERTAIN/);
});

test("a throwing drain observer cannot interrupt SDK idle confirmation", async () => {
  const { session, emit } = sessionFixture(); let waited = false;
  session.prompt = async () => { emit({ type: "message_end", message: assistant }); };
  session.waitForIdle = async () => { waited = true; };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {} });
  const facts = await port.run("go", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {},
    drain() { throw Object.create(null); } });
  assert(waited); assert.equal(facts.kind, "success"); assert.equal(facts.usage.total.cost, 0.25);
});

test("stop attempts both queue clears and SDK abort, retaining all failures", async () => {
  const { session } = sessionFixture(); const calls = [];
  session.clearQueue = () => { calls.push("clear"); throw new Error("CLEAR_FAILED"); };
  session.abort = async () => { calls.push("abort"); throw new Error("ABORT_FAILED"); };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {} });
  await assert.rejects(port.stop(), (error) => {
    assert.deepEqual(error.errors.map((entry) => entry.message), ["CLEAR_FAILED", "ABORT_FAILED", "CLEAR_FAILED"]);
    assert.match(error.message, /CLEAR_FAILED.*ABORT_FAILED/); return true;
  });
  assert.deepEqual(calls, ["clear", "abort", "clear"]);
});

test("unprintable drain errors cannot bypass idle confirmation", async () => {
  const { session } = sessionFixture(); let clears = 0, waited = false;
  session.prompt = async () => {};
  session.clearQueue = () => {
    if (++clears === 2) throw { toString() { throw new Error("FORMAT_FAILED"); } };
    return { steering: [], followUp: [] };
  };
  session.waitForIdle = async () => { waited = true; };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {} });
  await assert.rejects(port.run("go", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {} }), /Unprintable failure/);
  assert(waited);
});

test("history invalidation failure cannot prevent delivery/idle drain", async () => {
  const { session, listeners, emit } = sessionFixture(); let clears = 0, drained = false;
  session.prompt = async () => { emit({ type: "message_end", message: assistant }); };
  session.clearQueue = () => {
    if (++clears === 2) throw new Error("QUEUE_FAILED");
    return { steering: [], followUp: [] };
  };
  session.waitForIdle = async () => { drained = true; };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {},
    history: { invalidate() { throw new Error("INVALIDATE_FAILED"); }, seal() {} } });
  await assert.rejects(port.run("task", { inputEntered() {}, output() {}, turnStart() {}, turnEnd() {} }), (error) => {
    assert.equal(error.reason, "sdk_drain_failed");
    assert.match(String(error.cause.errors[0]), /QUEUE_FAILED/);
    assert.match(String(error.cause.errors[1]), /INVALIDATE_FAILED/);
    assert.equal(error.usage.total.cost, 0.25); return true;
  });
  assert(drained); assert.equal(listeners.size, 0);
});
