import assert from "node:assert/strict";
import test from "node:test";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { ParentHistoryError, SessionUnavailableError } from "../../dist/core/ports.js";
import { FakePort, deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

test("submission is memory-only; cancelled queued work never needs a journal/session", async (t) => {
  const gate = deferred(), entered = deferred(); const writes = [];
  const { controller: c, ports, directory, owner_id } = await fixture(t, { history: async (point) => {
    writes.push(point); if (point === "begin") { entered.resolve(); await gate.promise; }
  } });
  const a = await c.submit("a", task("a")); await entered.promise;
  assert.equal(a.history_ref, undefined); assert.equal(ports[0].calls.length, 0);
  const b = await c.submit("b", task("b")); c.cancel(b.run_id); await ended(c, b);
  assert.equal(c.view(b.run_id).history_ref, undefined); assert.deepEqual(writes, ["begin"]);
  assert.equal((await c.shutdown(5)).closed, false);
  await assert.rejects(FileOwnerLease.open({ directory, owner_id, flock }), /OWNER_LOCKED/);
  gate.resolve(); await ended(c, a);
  assert.equal(ports[0].calls.length, 0); assert.equal((await c.shutdown()).closed, true);
});

test("Run keeps its port through input drain and END, then leaves session ownership with the Agent", async (t) => {
  const delivery = deferred(), history = deferred(); let finishes = 0;
  const { controller: c, ports, owner } = await fixture(t, { history: async (point) => {
    if (point === "finish") { finishes++; await history.promise; }
  } });
  try {
    const run = await c.submit("owned", task("owned")); await until(() => ports[0]?.streaming);
    const port = ports[0]; port.deliveryGate = delivery;
    c.steer(run.run_id, "pending delivery"); port.finish("kept result");
    await until(() => c.view(run.run_id).phase === "finalizing");
    assert.equal(finishes, 0); assert.equal(c.runs.get(run.run_id).session, port);
    assert.equal((await c.shutdown(5)).closed, false); owner.assertHeld();
    assert.equal(c.runs.get(run.run_id).session, port);
    delivery.resolve(); await until(() => finishes === 1);
    assert.equal(c.runs.get(run.run_id).session, port);
    assert.equal(c.agents.get(run.agent_id).session, port);
    history.resolve(); await ended(c, run);
    assert.equal(c.runs.get(run.run_id).session, undefined);
    assert.equal(c.getResult(run.run_id).text, "kept result");
    assert.equal((await c.shutdown()).closed, true); assert.equal(port.disposed, 1);
    assert.equal(c.agents.get(run.agent_id).session, undefined);
  } finally { delivery.resolve(); history.resolve(); }
});

test("child SDK writer failure isolates that Agent, not healthy peers", async (t) => {
  const { controller: c, ports } = await fixture(t, { history: () => {} });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  const b = await c.submit("b", task("b"));
  ports[0].history.error = "SDK callback failure";
  ports[0].history.finish = () => { throw new Error("SDK callback failure"); };
  ports[0].calls[0].done.reject(new SessionUnavailableError("sdk_error", new Error("SDK callback failure")));
  await until(() => ports[1]?.streaming); await ended(c, a);
  assert.equal(c.view(a.run_id).owner_blocked, false); assert.equal(c.view(a.run_id).resumable, false);
  await assert.rejects(c.submit("reuse", { resume: a.agent_id, prompt: "reuse" }), errorCode("AGENT_UNAVAILABLE"));
  ports[1].finish("healthy result"); assert.equal((await ended(c, b)).results[0].text, "healthy result");
});

for (const kind of ["success", "invalid"]) test(`pending child END after ${kind} does not stall peers, but its Agent stays busy`, async (t) => {
  const hold = deferred(), entered = deferred(); let first = true;
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish" && first) { first = false; entered.resolve(); await hold.promise; throw new Error("END append failure"); }
  } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("live answer", kind); await entered.promise;
  await assert.rejects(c.submit("reuse", { resume: a.agent_id, prompt: "reuse" }), errorCode("AGENT_BUSY"));
  const b = await c.submit("b", task("b")); await until(() => ports[1]?.streaming);
  assert.equal(c.view(a.run_id).phase, "finalizing"); assert.equal(c.stats().active, 1);
  assert.equal(c.runs.get(a.run_id).session, ports[0]);
  hold.resolve(); await ended(c, a);
  assert.equal(c.runs.get(a.run_id).session, undefined);
  assert.equal(c.view(a.run_id).status, kind === "success" ? "completed" : "failed"); assert.equal(c.getResult(a.run_id).text, "live answer");
  assert.equal(c.view(a.run_id).resumable, false); assert.equal(c.view(b.run_id).status, "running");
  ports[1].finish("peer result"); await ended(c, b);
});

for (const parentFailure of [false, true]) {
  test(`synchronous reused START failure is ${parentFailure ? "owner-blocking for parent damage" : "local for child damage"}`, async (t) => {
    const { controller: c, ports } = await fixture(t, { history: () => {} });
    const warm = await c.submit("warm", task("warm")); await until(() => ports[0]?.streaming);
    ports[0].finish("warm"); await ended(c, warm);
    await c.submit("blocker", task("blocker")); await until(() => ports[1]?.streaming);
    const damaged = await c.submit("reuse", { resume: warm.agent_id, prompt: "reuse" });
    const queued = await c.submit("queued", task("queued"));
    ports[0].history.begin = () => { throw parentFailure ? new ParentHistoryError("shared SDK write failed") : new Error("child SDK write failed"); };
    ports[1].finish("unblock"); await until(() => c.view(damaged.run_id).phase === "settled");
    assert.equal(ports[0].calls.length, 1); assert.equal(c.view(damaged.run_id).resumable, false);
    if (parentFailure) {
      assert.equal(c.view(queued.run_id).status, "queued"); assert.equal(ports.length, 2);
      assert.equal((await c.wait([queued.run_id], { mode: "all" })).reason, "owner_blocked");
      await assert.rejects(c.submit("new", task("new")), errorCode("OWNER_PARENT_UNAVAILABLE"));
    } else {
      await until(() => ports[2]?.streaming); ports[2].finish("healthy"); await ended(c, queued);
      assert.equal(c.stats().parent_error, undefined);
    }
    assert.equal((await c.shutdown()).closed, true);
  });
}

test("external parent audit failure blocks sessions returning from initialization and queued execution", async (t) => {
  const initialized = deferred(), release = deferred(), warmPort = new FakePort(), port = new FakePort();
  let creates = 0;
  const { controller: c } = await fixture(t, { controller: { concurrency: 1, createSession: async () => {
    if (creates++ === 0) return warmPort;
    initialized.resolve(); await release.promise; return port;
  } } });
  const warm = await c.submit("warm-before-audit-fault", task("warm"));
  await until(() => warmPort.streaming); warmPort.finish("inspectable"); await ended(c, warm);
  const awaiting = await c.submit("awaiting-audit-fault", task("must not run"));
  const queued = await c.submit("queued-audit-fault", task("must stay queued"));
  await initialized.promise;
  c.latchParentHistoryFailure(new Error("PRESET_AUDIT_APPEND_AMBIGUOUS"));
  release.resolve();
  await until(() => c.view(awaiting.run_id).phase === "settled");
  const failed = c.view(awaiting.run_id);
  assert.equal(port.calls.length, 0, "a session returning after the latch cannot enter port.run");
  assert.equal(failed.owner_blocked, true); assert.match(failed.owner_error, /PRESET_AUDIT_APPEND_AMBIGUOUS/);
  assert.equal(c.view(queued.run_id).status, "queued");
  await assert.rejects(c.submit("apparent-recovery", task("still blocked")), errorCode("OWNER_PARENT_UNAVAILABLE"));
  assert.equal((await c.wait([queued.run_id], { mode: "all" })).reason, "owner_blocked");
  assert.equal(c.getResult(warm.run_id).text, "inspectable", "result inspection remains available");
  assert.equal((await c.release(warm.agent_id)).released, true, "idle Agent release remains available");
  c.cancel(queued.run_id); assert.equal((await ended(c, queued)).snapshots[0].status, "cancelled");
  assert.doesNotThrow(() => c.drainUsage(), "accounting drain remains available");
  assert.equal((await c.shutdown()).closed, true, "cancel/drain/shutdown remain available after the latch");
});

test("shared parent failure blocks new work without suppressing a running peer's child END", async (t) => {
  let starts = 0; const ends = [];
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 }, history: (point, record, output) => {
    if (point === "begin" && ++starts === 3) throw new ParentHistoryError("shared parent failed");
    if (point === "finish") ends.push({ record, output });
  } });
  await c.submit("a", task("a")); const b = await c.submit("b", task("b"));
  await until(() => ports[0]?.streaming && ports[1]?.streaming);
  const damaged = await c.submit("damaged", task("damaged")), queued = await c.submit("queued", task("queued"));
  ports[0].finish("a"); await until(() => c.view(damaged.run_id).phase === "settled");
  assert.equal(c.view(b.run_id).status, "running"); assert.equal(c.view(queued.run_id).status, "queued");
  ports[1].finish("healthy peer"); await until(() => c.view(b.run_id).phase === "settled");
  const peer = c.view(b.run_id);
  assert.equal(peer.status, "completed"); assert.equal(c.getResult(b.run_id).text, "healthy peer");
  assert.equal(peer.outcome.status, "completed"); assert.equal(peer.history_error, undefined);
  assert(ends.some(({ output }) => output.text === "healthy peer"), "running peer must retain its child END audit");
  assert.equal(c.view(queued.run_id).status, "queued");
  await assert.rejects(c.submit("new", task("new")), errorCode("OWNER_PARENT_UNAVAILABLE"));
  assert.equal((await c.shutdown()).closed, true);
});

for (const withHistory of [false, true]) {
  test(`owner loss after async initialization blocks execution ${withHistory ? "with" : "without"} history`, async (t) => {
    const initialized = deferred(), release = deferred(), port = new FakePort();
    let begins = 0;
    if (withHistory) port.history = {
      begin() { begins++; assert.fail("history must not begin after owner loss"); },
      finish() { assert.fail("history must not finish without a reference"); },
    };
    const { controller: c, owner } = await fixture(t, { controller: { createSession: async () => {
      initialized.resolve(); await release.promise; return port;
    } } });
    const run = await c.submit(`init-${withHistory}`, task("initializing")); await initialized.promise;
    const broken = t.mock.method(owner, "assertHeld", () => { throw new Error("LOCK_LOST_AFTER_INIT"); });
    release.resolve();
    const done = (await ended(c, run)).snapshots[0];
    assert.equal(port.calls.length, 0); assert.equal(begins, 0);
    assert.equal(done.owner_blocked, true); assert.match(done.owner_error, /LOCK_LOST_AFTER_INIT/);
    assert.equal(done.history_error, undefined); assert.equal(c.stats().internal_error.includes("LOCK_LOST_AFTER_INIT"), true);
    broken.mock.restore();
    await assert.rejects(c.submit(`sticky-${withHistory}`, task("new work")), errorCode("OWNER_INTERNAL_ERROR"));
  });
}

test("external parent audit failure while child history begin awaits blocks port.run", async (t) => {
  const beginGate = deferred(), beginEntered = deferred(), port = new FakePort(); let finishes = 0;
  port.history = {
    async begin(run) { beginEntered.resolve(); await beginGate.promise; return { ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }; },
    async finish(ref) { finishes++; return { ...ref, end_entry_id: "bbbbbbbb" }; },
  };
  const { controller: c } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("parent-fault-during-begin", task("must not run")); await beginEntered.promise;
  c.latchParentHistoryFailure(new Error("PRESET_AUDIT_FAILED_DURING_BEGIN"));
  beginGate.resolve();
  await until(() => c.view(run.run_id).phase === "settled");
  const done = c.view(run.run_id);
  assert.equal(port.calls.length, 0); assert.equal(finishes, 1, "child START still receives its failed pre-run END");
  assert.equal(done.history_error, undefined);
  assert.equal(done.owner_blocked, true); assert.match(done.owner_error, /PRESET_AUDIT_FAILED_DURING_BEGIN/);
  await assert.rejects(c.submit("after-parent-begin-fault", task("still blocked")), errorCode("OWNER_PARENT_UNAVAILABLE"));
});

test("owner loss while history begin awaits is latched before run and remains sticky for peers", async (t) => {
  const beginGate = deferred(), beginEntered = deferred(), peerGate = deferred();
  const ports = [new FakePort(), new FakePort()];
  let creates = 0;
  ports[0].history = {
    async begin(run) { beginEntered.resolve(); await beginGate.promise; return { ...run, session_id: ports[0].session_id, start_entry_id: "aaaaaaaa" }; },
    async finish() { assert.fail("END must be skipped after owner loss"); },
  };
  const { controller: c, owner } = await fixture(t, { controller: { concurrency: 2, createSession: async () => {
    const index = creates++;
    if (index === 1) await peerGate.promise;
    return ports[index];
  } } });
  const damaged = await c.submit("begin-loss", task("begin loss"));
  const peer = await c.submit("peer-init", task("peer init"));
  await beginEntered.promise;
  const broken = t.mock.method(owner, "assertHeld", () => { throw new Error("LOCK_LOST_DURING_BEGIN"); });
  beginGate.resolve();
  await until(() => !!c.stats().internal_error);
  broken.mock.restore();
  peerGate.resolve();
  const [damagedDone, peerDone] = await Promise.all([ended(c, damaged), ended(c, peer)]);
  assert.equal(ports[0].calls.length, 0); assert.equal(ports[1].calls.length, 0,
    "a peer returning from initialization cannot pass a sticky owner failure");
  assert.equal(damagedDone.snapshots[0].owner_blocked, true); assert.equal(peerDone.snapshots[0].owner_blocked, true);
  assert.match(c.stats().internal_error, /LOCK_LOST_DURING_BEGIN/);
  await assert.rejects(c.submit("after-begin-loss", task("new work")), errorCode("OWNER_INTERNAL_ERROR"));
});

test("owner loss wins over a concurrently rejected child history begin", async (t) => {
  const gate = deferred(), entered = deferred(), port = new FakePort();
  port.history = {
    async begin() { entered.resolve(); await gate.promise; throw new Error("CHILD_BEGIN_FAILURE"); },
    async finish() { assert.fail("failed START has no END"); },
  };
  const { controller: c, owner } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("rejected-begin-owner-loss", task("begin")); await entered.promise;
  const broken = t.mock.method(owner, "assertHeld", () => { throw new Error("LOCK_LOST_WITH_BEGIN_REJECTION"); });
  gate.resolve();
  const done = (await ended(c, run)).snapshots[0];
  assert.equal(port.calls.length, 0); assert.equal(done.history_error, undefined);
  assert.match(done.owner_error, /LOCK_LOST_WITH_BEGIN_REJECTION/);
  assert.doesNotMatch(done.owner_error, /CHILD_BEGIN_FAILURE/);
  broken.mock.restore();
});

for (const where of ["begin", "finish"]) {
  test(`local journal ${where} failure has no retry or owner-wide poison`, async (t) => {
    const writes = []; let injected = false;
    const { controller: c, ports } = await fixture(t, { history: (point) => {
      writes.push(point); if (point === where && !injected) { injected = true; throw new Error("synthetic history unavailable"); }
    } });
    const a = await c.submit("a", task("a"));
    if (where === "finish") { await until(() => ports[0]?.streaming); ports[0].finish("live answer"); }
    await until(() => c.view(a.run_id).phase === "settled");
    const view = c.view(a.run_id);
    assert.match(view.history_error, /history unavailable/); assert.equal(view.owner_blocked, false);
    assert.equal(view.status, where === "begin" ? "failed" : "completed");
    if (where === "finish") assert.equal(c.getResult(a.run_id).text, "live answer");
    else assert.equal(ports[0].calls.length, 0);
    assert.equal((await c.submit("a", task("a"))).run_id, a.run_id);
    assert.equal(writes.filter((point) => point === where).length, 1);
    const b = await c.submit("new", task("new")); await until(() => ports[1]?.streaming);
    ports[1].finish("peer"); await ended(c, b);
    assert.equal((await c.shutdown()).closed, true); assert.equal(ports[0].disposed, 1);
  });
}
