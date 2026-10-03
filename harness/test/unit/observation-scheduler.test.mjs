import assert from "node:assert/strict";
import test from "node:test";
import { ObservationScheduler } from "../../dist/core/observation-scheduler.js";
import { HarnessError } from "../../dist/core/ports.js";

// Preparatory SDK-free seam tests only. This mock FIFO/ref commit is NOT
// production Owner, packing, execution/cleanup, or publication acceptance evidence.
function fakeClock(start = 100) {
  let now = start, next = 0;
  const active = new Map(), history = new Map();
  const scheduled = [], cleared = [], fired = [];
  return {
    scheduled, cleared, fired,
    now: () => now,
    advance(ms) { assert(ms >= 0); now += ms; },
    ids: () => [...active.keys()],
    setTimeout(callback, delay) {
      const id = ++next, timer = { id, callback, delay, at: now };
      active.set(id, timer); history.set(id, timer); scheduled.push(timer);
      return id;
    },
    clearTimeout(id) { cleared.push(id); active.delete(id); },
    // Explicitly delivers a native callback without advancing the clock. It
    // can also replay an already latched/stale callback to test signal guards.
    fire(id) {
      assert(history.has(id), `unknown fake timer ${id}`);
      active.delete(id); fired.push(id); history.get(id).callback();
    },
  };
}

function abortFixture() {
  const controller = new AbortController(), listeners = new Set();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  const calls = { added: 0, removed: 0 };
  signal.addEventListener = (type, listener, options) => {
    assert.equal(type, "abort"); calls.added++; listeners.add(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    assert.equal(type, "abort"); calls.removed++; listeners.delete(listener);
    return remove(type, listener, options);
  };
  return { signal, calls, listeners, abort: () => controller.abort() };
}

const alert = (id, agent = "otter") => Object.freeze({ id, agent, message: `message-${id}` });
const run = (id, settled = true) => ({ ref: Object.freeze({ id }), settled, finished_presented: false });
const tracked = (promise) => {
  const state = { settled: false, value: undefined, error: undefined };
  state.observed = promise.then((value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; });
  return state;
};
const hasCode = (code, phase) => (error) => {
  assert(error instanceof HarnessError);
  assert.equal(error.code, code);
  if (phase !== undefined) assert.equal(error.details.phase, phase);
  return true;
};

function fixture(t) {
  const clock = fakeClock(), scheduler = new ObservationScheduler(clock);
  const state = { inbox: [], runs: [], blocked: undefined, reportedBlock: undefined,
    question: false, issue: false, done: false, lifecycleReady: false };
  const events = [];
  t.after(() => assert.deepEqual(clock.ids(), [], "all original fixture timers must be detached"));

  function model({ label = "model", policy = { kind: "waiting", wait_ms: 50 }, signal,
    scope, bound = true, maxAlerts = Infinity, action, hooks = {} } = {}) {
    const calls = { ready: 0, validate: 0, snapshot: 0, publish: 0, validateCommit: 0, commit: 0 };
    const snapshots = [], publications = [], commits = [];
    const reportedBlockAtStart = state.reportedBlock;
    const inScope = (entry) => scope === undefined || entry.agent === scope;
    let candidate;
    const defaults = {
      ready() {
        if (state.blocked !== undefined && state.blocked !== reportedBlockAtStart) return "owner_blocked";
        if (state.question) return "question";
        if (state.issue) return "task_issue";
        if (bound && state.done) return "done";
        if (state.inbox.some(inScope)) return "alert";
        if (!bound) return "nothing_pending";
        return undefined;
      },
      validate: () => Object.freeze({ current: true }),
      snapshot(reason, validation) {
        assert.equal(validation.current, true);
        const presenting = reason !== "aborted" && reason !== "timeout";
        return Object.freeze({ reason, action, blocked: state.blocked,
          alerts: presenting ? state.inbox.filter(inScope).slice(0, maxAlerts).map((ref) => ({ ref, message: ref.message })) : [],
          finished: presenting ? state.runs.filter((entry) => entry.settled && !entry.finished_presented)
            .map((entry) => ({ ref: entry.ref, status: "completed" })) : [] });
      },
      publish(snapshot) {
        // Ordinary final values; no SDK ToolResult wrapper runs after commit.
        return { result: Object.freeze({ reason: snapshot.reason, action: snapshot.action,
          alerts: snapshot.alerts.map((entry) => entry.message), finished: snapshot.finished.map((entry) => entry.ref.id) }),
        references: { alerts: snapshot.alerts.map((entry) => entry.ref),
          finished: snapshot.finished.map((entry) => entry.ref),
          blocked: snapshot.reason === "owner_blocked" ? snapshot.blocked : undefined } };
      },
      validateCommit(references) {
        const scoped = state.inbox.filter(inScope);
        assert.equal(new Set(references.alerts).size, references.alerts.length, "duplicate alert ref");
        for (const [index, ref] of references.alerts.entries()) {
          assert(candidate.alerts.some((entry) => entry.ref === ref), "alert ref not in snapshot");
          assert(state.inbox.includes(ref), "alert ref no longer pending");
          assert.equal(scoped[index], ref, "not the scoped FIFO prefix");
        }
        assert.equal(new Set(references.finished).size, references.finished.length, "duplicate finished ref");
        for (const ref of references.finished) {
          assert(candidate.finished.some((entry) => entry.ref === ref), "finished ref not in snapshot/body");
          const entry = state.runs.find((value) => value.ref === ref);
          assert(entry?.settled && !entry.finished_presented, "finished ref not settled or already presented");
        }
        if (references.blocked !== undefined) {
          assert.equal(candidate.reason, "owner_blocked");
          assert.equal(references.blocked, candidate.blocked);
          assert.equal(state.blocked, candidate.blocked, "currentBlocked must equal snapshot.blocked");
          // Deliberately NOT reportedBlock === reportedBlockAtStart: broadcasts
          // registered before the edge may each commit it idempotently.
        }
      },
      commit(references) {
        // Trusted straight-line mock core commit, after ALL ref checks. No
        // arbitrary callback, async effect, or fault injection in this port.
        for (const ref of references.alerts) state.inbox.splice(state.inbox.indexOf(ref), 1);
        for (const entry of state.runs) if (references.finished.includes(entry.ref)) entry.finished_presented = true;
        if (references.blocked !== undefined) state.reportedBlock = references.blocked;
        commits.push(references);
      },
    };
    const options = { policy, signal };
    for (const name of Object.keys(calls)) options[name] = (...args) => {
      calls[name]++; events.push(`${label}.${name}`);
      const value = (hooks[name] ?? defaults[name])(...args);
      if (name === "snapshot") { candidate = value; snapshots.push(value); }
      if (name === "publish") publications.push(value);
      return value;
    };
    return { options, calls, defaults, hooks, snapshots, publications, commits };
  }

  function enqueue(entry) {
    scheduler.assertEffectAllowed();
    state.inbox.push(entry);
    scheduler.requestDrain();
    return "queued";
  }
  function finish() {
    scheduler.assertEffectAllowed();
    state.lifecycleReady = true;
    state.done = true;
    scheduler.requestDrain();
    return "settled";
  }
  return { clock, scheduler, state, events, model, enqueue, finish };
}

const noPresentation = (model) => {
  assert.equal(model.calls.validateCommit, 0, "no ref validation for aborted/timeout");
  assert.equal(model.calls.commit, 0, "no presentation commit for aborted/timeout");
};

test("model and lifecycle observations share one non-reentrant signal drain", async (t) => {
  const f = fixture(t), hooks = {};
  const model = f.model({ hooks }), result = f.scheduler.observe(model.options);
  let lifecycleChecks = 0, insidePublication = false;
  const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready() {
    assert.equal(insidePublication, false);
    lifecycleChecks++;
    f.events.push("lifecycle.ready");
    return f.state.lifecycleReady;
  } });
  const [modelTimer, lifecycleTimer] = f.clock.ids();
  hooks.publish = (snapshot) => {
    insidePublication = true;
    f.events.push("publication.begin");
    f.clock.fire(lifecycleTimer);
    assert.equal(lifecycleChecks, 1, "native signal only latches while publication is gated");
    f.events.push("publication.end");
    insidePublication = false;
    return model.defaults.publish(snapshot);
  };
  f.events.length = 0;
  assert.equal(f.enqueue(alert("one")), "queued");
  assert.equal((await result).reason, "alert");
  assert.equal(await lifecycle, "timeout");
  assert.deepEqual(f.events, ["model.ready", "model.validate", "model.ready", "model.snapshot", "model.publish",
    "publication.begin", "publication.end", "model.validateCommit", "model.commit", "lifecycle.ready"]);
  assert.deepEqual(f.clock.scheduled.map((entry) => entry.id), [modelTimer, lifecycleTimer]);
  assert.equal(model.calls.validate, 1);
  assert.equal(model.calls.publish, 1, "lifecycle never enters a model publisher");
});

test("contention: A consumes once; B stays pending with its original timer and budget", async (t) => {
  const f = fixture(t), abortB = abortFixture();
  const a = f.model({ label: "A", policy: { kind: "waiting", wait_ms: 40 } });
  const b = f.model({ label: "B", policy: { kind: "waiting", wait_ms: 80 }, signal: abortB.signal });
  const resultA = f.scheduler.observe(a.options), resultB = f.scheduler.observe(b.options);
  const pendingB = tracked(resultB), [timerA, timerB] = f.clock.ids();
  f.clock.advance(7);
  assert.equal(f.enqueue(alert("contended")), "queued");
  assert.deepEqual((await resultA).alerts, ["message-contended"]);
  await Promise.resolve();
  assert.equal(pendingB.settled, false);
  assert.equal(b.calls.validate, 0, "core readiness disappearing does not touch SDK validation");
  assert.deepEqual(f.clock.ids(), [timerB]);
  assert.deepEqual(f.clock.cleared, [timerA]);
  assert.equal(f.clock.scheduled.length, 2);
  assert.deepEqual(f.clock.scheduled.map(({ delay, at }) => ({ delay, at })), [{ delay: 40, at: 100 }, { delay: 80, at: 100 }]);
  for (let i = 0; i < 3; i++) f.scheduler.requestDrain();
  assert.equal(f.clock.scheduled.length, 2, "neither lost contention nor wakes rearm B");
  f.clock.fire(timerB);
  assert.equal(f.clock.now(), 107, "the callback can arrive before the clock's absolute deadline");
  assert.equal((await resultB).reason, "timeout");
  noPresentation(b);
  assert.equal(abortB.listeners.size, 0);
  assert.deepEqual(abortB.calls, { added: 1, removed: 1 });
});

test("scoped publication consumes a FIFO prefix and marks only displayed original runs", async (t) => {
  const f = fixture(t), outside = alert("outside", "orca"), first = alert("first"), second = alert("second");
  const old = run("old-task"), current = run("current-task", false);
  f.state.inbox.push(outside, first, second);
  f.state.runs.push(old, current);
  const read = f.model({ policy: { kind: "snapshot" }, scope: "otter", maxAlerts: 1 });
  const result = await f.scheduler.observe(read.options);
  assert.equal(result.reason, "snapshot");
  assert.deepEqual(result.alerts, [first.message]);
  assert.deepEqual(result.finished, ["old-task"]);
  assert.deepEqual(f.state.inbox, [outside, second]);
  assert.equal(old.finished_presented, true);
  assert.equal(current.finished_presented, false);
  assert.equal(read.calls.ready, 0, "snapshot policy does not consult waiting readiness");
  assert.equal(read.calls.commit, 1);
  assert.equal(f.clock.scheduled.length, 0);
});

for (const [name, policy, bound, seed, expected] of [
  ["snapshot pending", { kind: "snapshot" }, true, "none", "snapshot"],
  ["snapshot ready", { kind: "snapshot" }, true, "done", "snapshot"],
  ["zero pending", { kind: "waiting", wait_ms: 0 }, true, "none", "timeout"],
  ["zero ready", { kind: "waiting", wait_ms: 0 }, true, "done", "done"],
  ["zero inbox", { kind: "waiting", wait_ms: 0 }, true, "alert", "alert"],
  ["empty selection", { kind: "waiting", wait_ms: 200 }, false, "none", "nothing_pending"],
  ["zero empty selection", { kind: "waiting", wait_ms: 0 }, false, "none", "nothing_pending"],
  ["empty selection with historical inbox", { kind: "waiting", wait_ms: 200 }, false, "alert", "alert"],
]) test(`${name}: readiness/snapshot/empty resolves without arming a timer`, async (t) => {
  const f = fixture(t);
  if (seed === "done") f.state.done = true;
  if (seed === "alert") f.state.inbox.push(alert("historical"));
  const model = f.model({ policy, bound });
  assert.equal((await f.scheduler.observe(model.options)).reason, expected);
  assert.equal(f.clock.scheduled.length, 0);
  if (expected === "timeout") noPresentation(model);
});

for (const ready of [false, true]) test(`lifecycle zero wait (${ready}) does not arm a timer`, async (t) => {
  const f = fixture(t);
  assert.equal(await f.scheduler.observeLifecycle({ wait_ms: 0, ready: () => ready }), ready ? "ready" : "timeout");
  assert.equal(f.clock.scheduled.length, 0);
});

for (const kind of ["model", "lifecycle"]) test(`${kind}: an early timer callback latches expiry without clock advancement`, async (t) => {
  const f = fixture(t), model = f.model();
  const result = kind === "model" ? f.scheduler.observe(model.options) :
    f.scheduler.observeLifecycle({ wait_ms: 50, ready: () => false });
  const [id] = f.clock.ids();
  assert.equal(f.clock.scheduled[0].delay, 50);
  f.clock.fire(id);
  assert.equal(f.clock.now(), 100);
  const value = await result;
  assert.equal(kind === "model" ? value.reason : value, "timeout");
  noPresentation(model);
  assert.deepEqual(f.clock.cleared, [id]);
  assert.equal(f.clock.scheduled.length, 1);
});

for (const elapsed of [13, 50, 51]) test(`registration budget elapsed by ${elapsed}ms before arming is not reset`, async (t) => {
  const f = fixture(t);
  let advanceOnce = true;
  const model = f.model({ hooks: { ready() {
    if (advanceOnce) { advanceOnce = false; f.clock.advance(elapsed); }
    return undefined;
  } } });
  const result = f.scheduler.observe(model.options);
  if (elapsed < 50) {
    assert.equal(f.clock.scheduled.length, 1);
    assert.equal(f.clock.scheduled[0].delay, 50 - elapsed);
    assert.equal(f.clock.scheduled[0].at, 100 + elapsed);
    f.clock.fire(f.clock.ids()[0]);
  } else assert.equal(f.clock.scheduled.length, 0, "exhausted first-arm budget latches expiry instead of waiting again");
  assert.equal((await result).reason, "timeout");
  assert.equal(f.clock.now(), 100 + elapsed);
  noPresentation(model);
});

for (const reason of ["owner_blocked", "question", "task_issue", "done", "alert", "nothing_pending"])
  test(`core readiness ${reason} beats a latched timeout`, async (t) => {
    const f = fixture(t);
    let ready;
    const model = f.model({ hooks: { ready: () => ready } });
    const result = f.scheduler.observe(model.options), [id] = f.clock.ids();
    ready = reason;
    f.clock.fire(id);
    assert.equal((await result).reason, reason);
    assert.equal(model.calls.validateCommit, 1);
    assert.equal(model.calls.commit, 1);
  });

test("lifecycle readiness beats its latched timeout", async (t) => {
  const f = fixture(t);
  const result = f.scheduler.observeLifecycle({ wait_ms: 50, ready: () => f.state.lifecycleReady });
  f.state.lifecycleReady = true;
  f.clock.fire(f.clock.ids()[0]);
  assert.equal(await result, "ready");
});

for (const policy of [{ kind: "snapshot" }, { kind: "waiting", wait_ms: 0 }, { kind: "waiting", wait_ms: 50 }])
  test(`pre-aborted ${policy.kind}/${policy.wait_ms ?? "none"} validates context but ignores all readiness/presentation`, async (t) => {
    const f = fixture(t), abort = abortFixture();
    f.state.inbox.push(alert("retained")); f.state.runs.push(run("retained")); f.state.blocked = "edge";
    abort.abort();
    const model = f.model({ policy, signal: abort.signal, hooks: { ready() { assert.fail("abort must precede core readiness"); } } });
    const result = await f.scheduler.observe(model.options);
    assert.equal(result.reason, "aborted");
    assert.deepEqual(result.alerts, []); assert.deepEqual(result.finished, []);
    assert.equal(model.calls.validate, 1); assert.equal(model.calls.ready, 0);
    noPresentation(model);
    assert.equal(f.state.inbox.length, 1); assert.equal(f.state.runs[0].finished_presented, false);
    assert.equal(f.state.reportedBlock, undefined);
    assert.deepEqual(abort.calls, { added: 0, removed: 0 });
    assert.equal(f.clock.scheduled.length, 0);
  });

test("pending core readiness avoids guarded validation on registration and ordinary wakes", async (t) => {
  const f = fixture(t), model = f.model();
  const result = f.scheduler.observe(model.options), [id] = f.clock.ids();
  for (let i = 0; i < 5; i++) f.scheduler.requestDrain();
  assert.equal(model.calls.ready, 6);
  assert.equal(model.calls.validate, 0); assert.equal(model.calls.snapshot, 0); assert.equal(model.calls.publish, 0);
  assert.deepEqual(f.clock.ids(), [id]); assert.equal(f.clock.scheduled.length, 1);
  f.enqueue(alert("ready"));
  assert.equal((await result).reason, "alert");
  assert.equal(model.calls.validate, 1); assert.equal(model.calls.publish, 1);
});

test("readiness lost after validation keeps the same observer and timer without preparing a result", async (t) => {
  const f = fixture(t);
  let answers = [];
  // Scripted pure-core answers model a vanished candidate, not an SDK getter
  // mutating Owner through an unsupported back door.
  const model = f.model({ hooks: { ready: () => answers.shift() } });
  const result = f.scheduler.observe(model.options), pending = tracked(result), [id] = f.clock.ids();
  answers = ["alert", undefined];
  f.scheduler.requestDrain();
  await Promise.resolve();
  assert.equal(pending.settled, false);
  assert.equal(model.calls.validate, 1); assert.equal(model.calls.snapshot, 0);
  assert.deepEqual(f.clock.ids(), [id]); assert.equal(f.clock.scheduled.length, 1);
  answers = ["done", "done"];
  f.scheduler.requestDrain();
  assert.equal((await result).reason, "done");
  assert.equal(model.calls.validate, 2); assert.equal(model.calls.commit, 1);
});

for (const stage of ["ready", "validate", "snapshot", "publish", "validateCommit"])
  test(`${stage} exceptions reject only that observer; accepted enqueue and lifecycle finish continue`, async (t) => {
    const f = fixture(t), abort = abortFixture(), hooks = {};
    const bad = f.model({ label: "bad", signal: abort.signal, hooks });
    const good = f.model({ label: "good" });
    const badResult = f.scheduler.observe(bad.options), rejection = assert.rejects(badResult, (error) => {
      hasCode("OBSERVATION_FAILED")(error);
      assert.equal(error.details.cause, failure);
      return true;
    });
    const goodResult = f.scheduler.observe(good.options);
    const settled = run("settled", false); f.state.runs.push(settled);
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready: () => f.state.lifecycleReady });
    const [badTimer] = f.clock.ids();
    const failure = Object.create(null);
    Object.defineProperty(failure, "toString", { get() { return assert.fail("wake must not stringify observer diagnostics"); } });
    hooks[stage] = () => { throw failure; };
    good.hooks.snapshot = (reason, validation) => {
      assert.equal(bad.calls.commit, 0);
      assert.deepEqual(f.state.inbox.map((entry) => entry.id), ["accepted"]);
      assert.equal(settled.finished_presented, false);
      assert.equal(f.state.reportedBlock, undefined);
      return good.defaults.snapshot(reason, validation);
    };
    settled.settled = true; f.state.blocked = "fault-edge";
    let accepted;
    assert.doesNotThrow(() => { accepted = f.enqueue(alert("accepted")); });
    assert.equal(accepted, "queued", "an already accepted child message must not receive an observer failure");
    await rejection;
    const value = await goodResult;
    assert.equal(value.reason, "owner_blocked"); assert.deepEqual(value.alerts, ["message-accepted"]);
    assert.deepEqual(f.state.inbox, []); assert.equal(settled.finished_presented, true);
    assert.equal(f.state.reportedBlock, "fault-edge");
    assert(f.clock.cleared.includes(badTimer)); assert.equal(abort.listeners.size, 0);
    assert.equal(bad.calls.commit, 0);
    const before = { ...bad.calls };
    assert.doesNotThrow(() => f.scheduler.requestDrain());
    assert.deepEqual(bad.calls, before, "failed observer is detached, not retried");
    assert.doesNotThrow(() => assert.equal(f.finish(), "settled"));
    assert.equal(await lifecycle, "ready");
  });

test("a HarnessError from synchronous packing is retained and never consumes references", async (t) => {
  const f = fixture(t), failure = new HarnessError("WAIT_REPLY_TOO_LARGE", { bytes: 65537 });
  f.state.inbox.push(alert("retained")); f.state.runs.push(run("retained")); f.state.blocked = "edge";
  const bad = f.model({ hooks: { publish() { throw failure; } } });
  await assert.rejects(f.scheduler.observe(bad.options), (error) => { assert.equal(error, failure); return true; });
  assert.equal(bad.calls.commit, 0); assert.equal(bad.calls.validateCommit, 0);
  assert.equal(f.state.inbox.length, 1); assert.equal(f.state.runs[0].finished_presented, false);
  assert.equal(f.state.reportedBlock, undefined);
});

for (const corruption of ["duplicate-alert", "foreign-alert", "non-prefix-alert", "duplicate-finished", "foreign-finished", "fault-mismatch"])
  test(`invalid ${corruption} refs reject with all FIFO/finished/fault mutations still zero`, async (t) => {
    const f = fixture(t), first = alert("first"), second = alert("second"), finished = run("finished");
    f.state.inbox.push(first, second); f.state.runs.push(finished); f.state.blocked = "edge";
    const bad = f.model();
    bad.hooks.publish = (snapshot) => {
      const publication = bad.defaults.publish(snapshot), refs = publication.references;
      if (corruption === "duplicate-alert") refs.alerts = [first, first];
      if (corruption === "foreign-alert") refs.alerts = [alert("not-in-snapshot")];
      if (corruption === "non-prefix-alert") refs.alerts = [second];
      if (corruption === "duplicate-finished") refs.finished = [finished.ref, finished.ref];
      if (corruption === "foreign-finished") refs.finished = [run("not-shown").ref];
      if (corruption === "fault-mismatch") refs.blocked = "not-the-snapshot-fault";
      return publication;
    };
    await assert.rejects(f.scheduler.observe(bad.options), hasCode("OBSERVATION_FAILED"));
    assert.equal(bad.calls.validateCommit, 1); assert.equal(bad.calls.commit, 0);
    assert.deepEqual(f.state.inbox, [first, second]);
    assert.equal(finished.finished_presented, false); assert.equal(f.state.reportedBlock, undefined);
    f.scheduler.requestDrain();
    assert.equal(bad.calls.validateCommit, 1, "no automatic retry after invalid refs");
    const healthy = f.model();
    assert.equal((await f.scheduler.observe(healthy.options)).reason, "owner_blocked");
    assert.deepEqual(f.state.inbox, []); assert.equal(finished.finished_presented, true);
    assert.equal(f.state.reportedBlock, "edge");
  });

for (const stale of ["alert", "finished", "blocked"])
  test(`stale ${stale} snapshot refs fail the full validation before any commit`, async (t) => {
    const f = fixture(t), pending = alert("pending"), finished = run("finished"), unready = run("unsettled", false);
    f.state.inbox.push(pending); f.state.runs.push(finished, unready); f.state.blocked = "current-edge";
    const bad = f.model();
    bad.hooks.snapshot = (reason, validation) => {
      const snapshot = bad.defaults.snapshot(reason, validation);
      // Deliberately stale mock core snapshots, not supported SDK getter effects.
      if (stale === "alert") return { ...snapshot, alerts: [{ ref: alert("no-longer-pending"), message: "stale" }] };
      if (stale === "finished") return { ...snapshot, finished: [{ ref: unready.ref, status: "completed" }] };
      return { ...snapshot, blocked: "old-edge" };
    };
    await assert.rejects(f.scheduler.observe(bad.options), hasCode("OBSERVATION_FAILED"));
    assert.equal(bad.calls.validateCommit, 1); assert.equal(bad.calls.commit, 0);
    assert.deepEqual(f.state.inbox, [pending]);
    assert.equal(finished.finished_presented, false); assert.equal(unready.finished_presented, false);
    assert.equal(f.state.reportedBlock, undefined);
  });

test("fault edge broadcasts to both pre-edge waiters; snapshot and later waits do not consume it again", async (t) => {
  const f = fixture(t), a = f.model({ label: "A" }), b = f.model({ label: "B" });
  const resultA = f.scheduler.observe(a.options), resultB = f.scheduler.observe(b.options);
  f.state.blocked = "edge-1";
  const snapshot = f.model({ policy: { kind: "snapshot" } });
  // Registering a snapshot wakes the shared drain, including existing waiters.
  const snapshotResult = f.scheduler.observe(snapshot.options);
  assert.equal((await resultA).reason, "owner_blocked"); assert.equal((await resultB).reason, "owner_blocked");
  assert.equal(a.calls.commit, 1); assert.equal(b.calls.commit, 1);
  assert.equal(f.state.reportedBlock, "edge-1");
  assert.equal((await snapshotResult).reason, "snapshot");
  assert.equal(snapshot.commits[0].blocked, undefined, "snapshot never consumes a waiting-only fault edge");
  const later = f.model(), laterResult = f.scheduler.observe(later.options), pending = tracked(laterResult);
  await Promise.resolve(); assert.equal(pending.settled, false);
  assert.equal(later.calls.validate, 0);
  f.clock.fire(f.clock.ids()[0]);
  assert.equal((await laterResult).reason, "timeout"); noPresentation(later);
});

const reentrantKinds = ["requestDrain", "observe", "observeLifecycle", "validateEntry", "assertEffectAllowed"];
for (const phase of ["entry", "validate", "snapshot", "publish"]) for (const kind of reentrantKinds)
  test(`swallowed ${kind} reentry in ${phase} poisons only the outer gate, with no nested work`, async (t) => {
    const f = fixture(t), source = f.model({ label: "source" }), healthy = f.model({ label: "healthy" });
    const nested = f.model({ label: "nested", policy: { kind: "snapshot" } });
    let returned = 0, nestedReads = 0;
    const operations = {
      requestDrain: () => f.scheduler.requestDrain(),
      observe: () => f.scheduler.observe(nested.options),
      observeLifecycle: () => f.scheduler.observeLifecycle({ wait_ms: 40, ready() { nestedReads++; return true; } }),
      validateEntry: () => f.scheduler.validateEntry(() => { nestedReads++; return true; }),
      assertEffectAllowed: () => f.scheduler.assertEffectAllowed(),
    };
    const attempt = () => {
      // Consume the synchronous error as a guarded getter might. The source
      // phase must still reject because its violation cannot be washed away.
      assert.throws(() => { operations[kind](); returned++; },
        hasCode("OBSERVATION_REENTRANCY", phase === "entry" || phase === "validate" ? "validation" : "publication"));
    };
    let sourceRejection;
    if (phase !== "entry") {
      const result = f.scheduler.observe(source.options);
      sourceRejection = assert.rejects(result, hasCode("OBSERVATION_REENTRANCY",
        phase === "validate" ? "validation" : "publication"));
      source.hooks[phase] = (...args) => { attempt(); return source.defaults[phase](...args); };
    }
    const healthyResult = f.scheduler.observe(healthy.options);
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready: () => f.state.lifecycleReady });
    const schedulesBefore = f.clock.scheduled.length;
    if (phase === "entry") {
      const before = healthy.calls.ready;
      assert.throws(() => f.scheduler.validateEntry(() => { attempt(); return { current: true }; }),
        hasCode("OBSERVATION_REENTRANCY", "validation"));
      assert.equal(healthy.calls.ready, before, "illegal public wake did not schedule a deferred drain");
      assert.equal(source.calls.ready, 0, "entry validation registers no placeholder observer");
    }
    assert.equal(f.enqueue(alert("retained-for-healthy")), "queued");
    if (sourceRejection) await sourceRejection;
    assert.equal(returned, 0, "all reentrant APIs throw synchronously before returning or queueing");
    assert.equal(nestedReads, 0);
    assert.deepEqual(nested.calls, { ready: 0, validate: 0, snapshot: 0, publish: 0, validateCommit: 0, commit: 0 });
    assert.equal(source.calls.commit, 0);
    assert.equal(f.clock.scheduled.length, schedulesBefore, "no nested timer/registration");
    assert.deepEqual((await healthyResult).alerts, ["message-retained-for-healthy"]);
    assert.doesNotThrow(() => f.finish());
    assert.equal(await lifecycle, "ready");
  });

test("an async effect API must have a synchronous facade before enqueue/implementation start", async (t) => {
  const f = fixture(t), queued = [], executed = [];
  let started = 0;
  async function implementation(value) {
    started++;
    await Promise.resolve();
    executed.push(value);
    return value;
  }
  function command(value) {
    f.scheduler.assertEffectAllowed();
    queued.push(value);
    return implementation(value);
  }
  assert.throws(() => f.scheduler.validateEntry(() => {
    assert.throws(() => command("forbidden"), hasCode("OBSERVATION_REENTRANCY", "validation"));
    return "context";
  }), hasCode("OBSERVATION_REENTRANCY", "validation"));
  assert.deepEqual(queued, []); assert.deepEqual(executed, []); assert.equal(started, 0);
  const allowed = command("allowed");
  assert.deepEqual(queued, ["allowed"]); assert.equal(started, 1);
  assert.equal(await allowed, "allowed"); assert.deepEqual(executed, ["allowed"]);
  assert.equal(f.clock.scheduled.length, 0);
});

for (const stage of ["validate", "snapshot", "publish"])
  test(`abort during ${stage} discards the candidate and never invokes either commit port`, async (t) => {
    const f = fixture(t), abort = abortFixture(), action = Object.freeze({ type: "agent_run", agent: "otter", task: 2 });
    const hooks = {}, model = f.model({ signal: abort.signal, action, hooks });
    const result = f.scheduler.observe(model.options), [id] = f.clock.ids();
    hooks[stage] = (...args) => { abort.abort(); return model.defaults[stage](...args); };
    const pending = alert("pending"), finished = run("finished");
    f.state.runs.push(finished); f.state.blocked = "edge";
    f.enqueue(pending);
    const value = await result;
    assert.equal(value.reason, "aborted"); assert.equal(value.action, action, "accepted command fact survives abort");
    assert.deepEqual(value.alerts, []); assert.deepEqual(value.finished, []);
    assert.deepEqual(model.snapshots.map((snapshot) => snapshot.reason), stage === "validate" ? ["aborted"] : ["owner_blocked", "aborted"]);
    noPresentation(model);
    assert.deepEqual(f.state.inbox, [pending]); assert.equal(finished.finished_presented, false);
    assert.equal(f.state.reportedBlock, undefined);
    assert.equal(abort.listeners.size, 0); assert.deepEqual(f.clock.cleared, [id]);
    const healthy = f.model();
    assert.equal((await f.scheduler.observe(healthy.options)).reason, "owner_blocked");
    assert.deepEqual(f.state.inbox, []); assert.equal(finished.finished_presented, true);
  });

test("abort after synchronous commit but before Promise delivery never undoes the committed candidate", async (t) => {
  const f = fixture(t), abort = abortFixture(), finished = run("finished");
  f.state.inbox.push(alert("published")); f.state.runs.push(finished); f.state.blocked = "edge";
  const model = f.model({ signal: abort.signal });
  const result = f.scheduler.observe(model.options);
  assert.equal(model.calls.commit, 1, "commit completed inside observe, not in an outer await continuation");
  assert.deepEqual(f.state.inbox, []); assert.equal(finished.finished_presented, true);
  assert.equal(f.state.reportedBlock, "edge"); assert.equal(abort.listeners.size, 0);
  abort.abort();
  const value = await result;
  assert.equal(value, model.publications[0].result);
  assert.equal(value.reason, "owner_blocked"); assert.deepEqual(value.alerts, ["message-published"]);
  assert.equal(model.calls.commit, 1); assert.equal(model.calls.snapshot, 1);
  assert.equal(finished.finished_presented, true); assert.equal(f.state.reportedBlock, "edge");
});

for (const native of ["timer", "abort"])
  test(`native ${native} during entry validateEntry only drains AFTER its gate clears (draining was false)`, async (t) => {
    const f = fixture(t), abortModel = abortFixture(), abortLifecycle = abortFixture();
    const model = f.model({ signal: abortModel.signal }), result = f.scheduler.observe(model.options);
    let entryActive = false, lifecycleChecks = 0;
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, signal: abortLifecycle.signal, ready() {
      assert.equal(entryActive, false);
      assert.doesNotThrow(() => f.scheduler.assertEffectAllowed(), "entry frame must have cleared before lifecycle checking");
      lifecycleChecks++; f.events.push("lifecycle.ready"); return false;
    } });
    const [modelTimer, lifecycleTimer] = f.clock.ids();
    const modelReady = model.calls.ready, lifeReady = lifecycleChecks;
    model.hooks.ready = () => {
      assert.equal(entryActive, false);
      assert.doesNotThrow(() => f.scheduler.assertEffectAllowed(), "entry frame must clear before core readiness");
      return undefined;
    };
    f.events.length = 0;
    const context = f.scheduler.validateEntry(() => {
      entryActive = true; f.events.push("entry.begin");
      if (native === "timer") { f.clock.fire(modelTimer); f.clock.fire(lifecycleTimer); }
      else { abortModel.abort(); abortLifecycle.abort(); }
      f.events.push("entry.latched");
      assert.equal(model.calls.ready, modelReady); assert.equal(model.calls.validate, 0);
      assert.equal(lifecycleChecks, lifeReady, "listener must not directly check/finish the lifecycle observer");
      entryActive = false; f.events.push("entry.end");
      return "entry-context";
    });
    assert.equal(context, "entry-context");
    assert.equal(model.calls.validate, 1, "deferred shared drain runs as the entry gate exits");
    assert.deepEqual(f.events.slice(0, 3), ["entry.begin", "entry.latched", "entry.end"]);
    assert.equal((await result).reason, native === "timer" ? "timeout" : "aborted");
    assert.equal(await lifecycle, native === "timer" ? "timeout" : "aborted");
    noPresentation(model);
    assert.equal(abortModel.listeners.size, 0); assert.equal(abortLifecycle.listeners.size, 0);
    assert.equal(f.clock.scheduled.length, 2, "signal handling never creates replacement timers");
  });

test("repeated latched and detached native callbacks do not request another drain", async (t) => {
  const f = fixture(t), model = f.model(), abortTail = abortFixture();
  const result = f.scheduler.observe(model.options), [id] = f.clock.ids();
  let tailChecks = 0;
  const tail = f.scheduler.observeLifecycle({ wait_ms: 80, signal: abortTail.signal, ready() { tailChecks++; return false; } });
  const before = tailChecks;
  model.hooks.validate = () => {
    f.clock.fire(id); f.clock.fire(id); // deadline was already latched by the first callback
    return model.defaults.validate();
  };
  f.clock.fire(id);
  assert.equal((await result).reason, "timeout");
  assert.equal(tailChecks, before + 1, "duplicates during validation must not cause a second drain pass");
  f.clock.fire(id);
  assert.equal(tailChecks, before + 1, "a detached timer callback does not wake remaining observations");
  assert.equal(model.calls.validate, 1); noPresentation(model);
  abortTail.abort(); assert.equal(await tail, "aborted");
});

for (const kind of ["promise-publication", "thenable-publication", "thenable-result"])
  test(`${kind} is an invalid synchronous publisher, isolated before ref validation/commit`, async (t) => {
    const f = fixture(t), bad = f.model(), good = f.model({ label: "good" });
    const result = f.scheduler.observe(bad.options), rejection = assert.rejects(result, hasCode("ASYNC_OBSERVATION_PORT"));
    const goodResult = f.scheduler.observe(good.options);
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready: () => f.state.lifecycleReady });
    let assimilated = 0;
    const thenable = { then() { assimilated++; } };
    bad.hooks.publish = (snapshot) => {
      const publication = bad.defaults.publish(snapshot);
      if (kind === "promise-publication") return Promise.resolve(publication);
      if (kind === "thenable-publication") return thenable;
      return { ...publication, result: thenable };
    };
    assert.doesNotThrow(() => f.enqueue(alert("deliverable")));
    await rejection;
    assert.equal(assimilated, 0, "scheduler never awaits/assimilates an async port or final result");
    assert.equal(bad.calls.validateCommit, 0); assert.equal(bad.calls.commit, 0);
    assert.deepEqual((await goodResult).alerts, ["message-deliverable"]);
    assert.doesNotThrow(() => f.finish()); assert.equal(await lifecycle, "ready");
  });

test("a rejecting native async publisher is rejected without an unhandled process rejection", async (t) => {
  const f = fixture(t), bad = f.model(), good = f.model({ label: "good" });
  const unhandled = [], onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const failure = new Error("REJECTED_ASYNC_PUBLISHER");
  const result = f.scheduler.observe(bad.options), rejection = assert.rejects(result, hasCode("ASYNC_OBSERVATION_PORT"));
  const peer = f.scheduler.observe(good.options);
  bad.hooks.publish = async () => { throw failure; };
  assert.doesNotThrow(() => f.enqueue(alert("async-rejection")));
  await rejection;
  assert.equal(bad.calls.validateCommit, 0); assert.equal(bad.calls.commit, 0);
  assert.deepEqual((await peer).alerts, ["message-async-rejection"]);
  // One event-loop turn lets Node report an unsunk native Promise rejection;
  // this is not a real timeout or advancement of the scheduler's fake clock.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(f.clock.now(), 100);
});

for (const rejects of [false, true])
  test(`async validateCommit (rejects=${rejects}) is rejected before commit, with peer/lifecycle isolation`, async (t) => {
    const f = fixture(t), bad = f.model(), good = f.model({ label: "good" });
    const unhandled = [], onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const result = f.scheduler.observe(bad.options), rejection = assert.rejects(result, hasCode("ASYNC_OBSERVATION_PORT"));
    const peer = f.scheduler.observe(good.options);
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready: () => f.state.lifecycleReady });
    bad.hooks.validateCommit = async (references) => {
      bad.defaults.validateCommit(references);
      if (rejects) throw new Error("REJECTED_ASYNC_REF_VALIDATION");
      return undefined;
    };
    const finished = run("finished"); f.state.runs.push(finished); f.state.blocked = "edge";
    good.hooks.snapshot = (reason, validation) => {
      assert.equal(bad.calls.commit, 0);
      assert.equal(finished.finished_presented, false); assert.equal(f.state.reportedBlock, undefined);
      assert.deepEqual(f.state.inbox.map((entry) => entry.id), ["async-validation"]);
      return good.defaults.snapshot(reason, validation);
    };
    assert.doesNotThrow(() => f.enqueue(alert("async-validation")));
    await rejection;
    assert.equal(bad.calls.validateCommit, 1); assert.equal(bad.calls.commit, 0);
    assert.deepEqual((await peer).alerts, ["message-async-validation"]);
    assert.equal(finished.finished_presented, true); assert.equal(f.state.reportedBlock, "edge");
    assert.doesNotThrow(() => f.finish()); assert.equal(await lifecycle, "ready");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  });

for (const outcome of ["success", "observer-failure", "listener-failure"])
  test(`throwing timer teardown (${outcome}) never strands source/peer or skips abort-listener teardown`, async (t) => {
    const f = fixture(t), abortSource = abortFixture(), abortPeer = abortFixture();
    const source = f.model({ label: "source", signal: abortSource.signal });
    const peer = f.model({ label: "peer", signal: abortPeer.signal });
    const result = f.scheduler.observe(source.options);
    const rejection = outcome === "observer-failure" ? assert.rejects(result, hasCode("OBSERVATION_FAILED")) : undefined;
    const peerResult = f.scheduler.observe(peer.options);
    let lifecycleChecks = 0;
    const lifecycle = f.scheduler.observeLifecycle({ wait_ms: 80, ready() { lifecycleChecks++; return f.state.lifecycleReady; } });
    const timers = f.clock.ids(), clearAttempts = [];
    f.clock.clearTimeout = (id) => { clearAttempts.push(id); throw new Error("INJECTED_CLEAR_FAILURE"); };
    if (outcome === "listener-failure") {
      const remove = abortSource.signal.removeEventListener;
      abortSource.signal.removeEventListener = (...args) => { remove(...args); throw new Error("INJECTED_REMOVE_FAILURE"); };
    }
    if (outcome === "observer-failure") source.hooks.validate = () => { throw new Error("SOURCE_VALIDATOR_FAILED"); };
    const finished = run("finished"); f.state.runs.push(finished);
    f.state.inbox.push(alert("teardown")); f.state.done = true;
    assert.doesNotThrow(() => f.scheduler.requestDrain(), "detach failures must never escape a public/child wake");
    if (rejection) await rejection;
    else {
      assert.equal(await result, source.publications[0].result, "already committed publication still resolves successfully");
      assert.equal(source.calls.commit, 1);
    }
    assert.equal((await peerResult).reason, "done"); assert.equal(peer.calls.commit, 1);
    assert.deepEqual(clearAttempts, timers.slice(0, 2));
    assert.deepEqual(abortSource.calls, { added: 1, removed: 1 }, "listener removal attempted even though timer clear threw");
    assert.deepEqual(abortPeer.calls, { added: 1, removed: 1 });
    assert.equal(abortSource.listeners.size, 0); assert.equal(abortPeer.listeners.size, 0);
    assert.deepEqual(f.state.inbox, []); assert.equal(finished.finished_presented, true);
    assert.doesNotThrow(() => f.finish()); assert.equal(await lifecycle, "ready");
    assert.deepEqual(clearAttempts, timers);
    const before = [{ ...source.calls }, { ...peer.calls }, lifecycleChecks];
    // Teardown deliberately left fake native callbacks active. Delivery after
    // registry removal must be harmless and not cause another peer check.
    for (const id of timers) assert.doesNotThrow(() => f.clock.fire(id));
    abortSource.abort(); abortPeer.abort();
    assert.deepEqual([{ ...source.calls }, { ...peer.calls }, lifecycleChecks], before);
  });

for (const field of ["result", "references"])
  test(`swallowed effect reentry in publication.${field} getter is gated and prevents outer commit`, async (t) => {
    const f = fixture(t), bad = f.model(), good = f.model({ label: "good" });
    const result = f.scheduler.observe(bad.options), rejection = assert.rejects(result, hasCode("OBSERVATION_REENTRANCY", "publication"));
    const goodResult = f.scheduler.observe(good.options);
    bad.hooks.publish = (snapshot) => {
      const publication = bad.defaults.publish(snapshot);
      return Object.defineProperty({ ...publication }, field, { get() {
        assert.throws(() => f.scheduler.requestDrain(), hasCode("OBSERVATION_REENTRANCY", "publication"));
        return publication[field];
      } });
    };
    assert.doesNotThrow(() => f.enqueue(alert("not-consumed-by-bad")));
    await rejection;
    assert.equal(bad.calls.validateCommit, 0); assert.equal(bad.calls.commit, 0);
    assert.deepEqual((await goodResult).alerts, ["message-not-consumed-by-bad"]);
  });

test("publication fields are captured under the guard; final Promise value retains exact result identity", async (t) => {
  const f = fixture(t), model = f.model({ policy: { kind: "snapshot" } });
  f.state.inbox.push(alert("identity"));
  const final = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: "already serialized" })]),
    details: Object.freeze({ reason: "snapshot" }) });
  let resultReads = 0, referenceReads = 0;
  model.hooks.publish = (snapshot) => {
    const publication = model.defaults.publish(snapshot);
    return {
      get result() { assert.equal(model.calls.commit, 0, "no publication getter after commit"); resultReads++; return final; },
      get references() { assert.equal(model.calls.commit, 0, "no reference getter after commit"); referenceReads++; return publication.references; },
    };
  };
  const promise = f.scheduler.observe(model.options);
  assert(promise instanceof Promise);
  assert.equal(model.calls.commit, 1);
  assert(resultReads > 0); assert(referenceReads > 0);
  const readsAtCommit = [resultReads, referenceReads], callsAtCommit = { ...model.calls };
  assert.equal(await promise, final, "resolve returns the preconstructed result itself, without wrapping/serialization");
  assert.equal(await promise, final, "repeated Promise reads preserve object identity");
  assert.deepEqual([resultReads, referenceReads], readsAtCommit);
  assert.deepEqual(model.calls, callsAtCommit, "successful delivery performs no additional validator/snapshot/publisher work");
  assert.deepEqual(f.state.inbox, []);
});

for (const wait_ms of [-1, 0.5, 300001, NaN, Infinity])
  test(`invalid model wait ${wait_ms} fails synchronously before registration`, (t) => {
    const f = fixture(t), model = f.model({ policy: { kind: "waiting", wait_ms } });
    assert.throws(() => f.scheduler.observe(model.options), hasCode("INVALID_OBSERVATION_WAIT"));
    assert.equal(model.calls.ready, 0); assert.equal(f.clock.scheduled.length, 0);
  });

for (const wait_ms of [-1, NaN, Infinity, 2147483648, null, "1"])
  test(`invalid lifecycle wait ${String(wait_ms)} fails before registration`, (t) => {
    const f = fixture(t);
    assert.throws(() => f.scheduler.observeLifecycle({ wait_ms, ready() { assert.fail("must not register"); } }),
      hasCode("INVALID_OBSERVATION_WAIT"));
    assert.equal(f.clock.scheduled.length, 0);
  });

for (const wait_ms of [0.5, 300001, 2147483647])
  test(`lifecycle waits retain their original timer at duration ${wait_ms}`, async (t) => {
    const f = fixture(t), observed = f.scheduler.observeLifecycle({ wait_ms, ready: () => f.state.lifecycleReady });
    assert.equal(f.clock.scheduled.length, 1); assert.equal(f.clock.scheduled[0].delay, wait_ms);
    f.clock.advance(wait_ms / 2); f.scheduler.requestDrain();
    assert.equal(f.clock.scheduled.length, 1, "wake did not reset the deadline");
    f.clock.advance(wait_ms / 2); f.clock.fire(f.clock.scheduled[0].id);
    assert.equal(await observed, "timeout");
  });

test("omitted lifecycle timeout remains unbounded and creates no timer", async (t) => {
  const f = fixture(t), observed = tracked(f.scheduler.observeLifecycle({ ready: () => f.state.lifecycleReady }));
  f.clock.advance(2147483648); f.scheduler.requestDrain(); await Promise.resolve();
  assert.equal(observed.settled, false); assert.equal(f.clock.scheduled.length, 0);
  f.finish(); await observed.observed;
  assert.equal(observed.value, "ready"); assert.equal(f.clock.scheduled.length, 0);
});
