import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { ObservationScheduler } from "../../dist/core/observation-scheduler.js";
import { HarnessError } from "../../dist/core/ports.js";
import { FakePort, task, tick, until } from "../support/controller-fixture.mjs";

// In-process Owner lifecycle/projection evidence only. The counted lease and
// controlled SessionPort do not prove real locking, host/provider or UI safety.
class FakeLease {
  owner_id = randomUUID();
  generation = randomUUID();
  held = true;
  probes = 0;
  closed = false;
  assertHeld() {
    this.probes++;
    if (!this.held || this.closed) throw new Error("FIXTURE_LEASE_LOST");
  }
  close() { this.closed = true; }
}

async function fixture(t, options = {}) {
  const owner = new FakeLease(), ports = [];
  const c = await OwnerController.open({ owner, concurrency: 1, resident_limit: 8,
    createSession: async () => { const port = new FakePort(); ports.push(port); return port; }, ...options });
  t.after(async () => {
    owner.held = true;
    for (const port of ports) {
      port.autoStop = true;
      if (port.streaming) port.finish("fixture cleanup", "aborted");
    }
    const report = await c.shutdown(3000);
    assert.equal(report.closed, true, `controlled execution and cleanup must close: ${JSON.stringify(report)}`);
    assert.equal(owner.closed, true);
  });
  return { c, owner, ports };
}

async function start(c, ports, id, name = "otter") {
  const run = await c.submit(id, task(id, { name }));
  await until(() => ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id));
  return { run, port: ports.find((port) => port.calls.at(-1)?.identity.run_id === run.run_id) };
}
async function settle(c, run) {
  assert.equal(await c.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
  assert.equal(c.view(run.run_id).phase, "settled");
}
function lifecycleCalls(t) {
  const calls = [], original = ObservationScheduler.prototype.observeLifecycle;
  const spy = t.mock.method(ObservationScheduler.prototype, "observeLifecycle", function (options) {
    calls.push({ ...options });
    return original.call(this, options); // Observe/forward only; do not replace readiness or timers.
  });
  return { calls, restore: () => spy.mock.restore() };
}
const invalidTimeouts = [-1, NaN, Infinity, 2147483648];
const harnessFailure = (error) => { assert(error instanceof HarnessError); return true; };

for (const timeout_ms of [0.5, 300001, 2147483647])
  test(`public lifecycle wait accepts finite timeout ${timeout_ms} independently of the model wait cap`, async (t) => {
    const { c, ports } = await fixture(t), { run, port } = await start(c, ports, "lifecycle");
    const watching = c.waitForRuns([run.run_id], { mode: "all", timeout_ms });
    // Finish in this turn: no long real-time sleep or fractional-timer race.
    port.finish("ready before the timer");
    assert.equal(await watching, "ready");
    assert.equal(c.stats().internal_error, undefined);
  });

test("omitted lifecycle timeout reaches the shared scheduler as unbounded, not a five-minute default", async (t) => {
  const { c, ports } = await fixture(t), { run, port } = await start(c, ports, "unbounded");
  const recording = lifecycleCalls(t);
  try {
    const watching = c.waitForRuns([run.run_id], { mode: "all" });
    assert.equal(recording.calls.length, 1);
    assert.equal(recording.calls[0].wait_ms, undefined);
    port.finish("unbounded wait still wakes on real settlement");
    assert.equal(await watching, "ready");
  } finally { recording.restore(); }
});

for (const timeout_ms of invalidTimeouts)
  test(`public lifecycle wait rejects invalid timeout ${timeout_ms} without changing execution`, async (t) => {
    const { c, ports } = await fixture(t), { run, port } = await start(c, ports, "invalid-wait");
    await assert.rejects(async () => c.waitForRuns([run.run_id], { mode: "all", timeout_ms }), harnessFailure);
    assert.equal(port.stopped, 0); assert.equal(port.disposed, 0);
    assert.equal(c.view(run.run_id).status, "running"); assert.equal(c.stats().resident, 1);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
    port.finish("normal completion"); await settle(c, run);
  });

function publicEffects(c, run, ports) {
  const view = c.view(run.run_id), stats = c.stats();
  return {
    status: view.status, phase: view.phase, stop_reason: view.stop_reason,
    unavailable_reason: view.unavailable_reason, has_question: view.has_question, question_id: view.question_id,
    resident: stats.resident, active: stats.active, queued: stats.queued, cleaning: stats.cleaning,
    finalizing: stats.finalizing, runs: stats.runs, requests: stats.requests,
    resident_ids: c.list({ include_released: false }).map((row) => row.agent_id),
    ports: ports.map((port) => ({ stopped: port.stopped, disposed: port.disposed, calls: port.calls.length })),
  };
}

for (const state of ["busy", "queued", "idle question", "released"]) for (const settle_ms of invalidTimeouts)
  test(`kill validates ${settle_ms} before effects on an Agent that is ${state}`, async (t) => {
    const { c, ports } = await fixture(t);
    let run;
    if (state === "queued") {
      await start(c, ports, "blocker", "orca");
      run = await c.submit("queued", task("queued", { name: "otter" }));
      assert.equal(run.status, "queued");
    } else {
      const entry = await start(c, ports, "target"); run = entry.run;
      if (state !== "busy") {
        if (state === "idle question") entry.port.callbacks.question("Keep this original question?");
        entry.port.finish("settled target"); await settle(c, run);
        if (state === "released") assert.equal((await c.release(run.agent_id)).released, true);
      }
    }
    const before = publicEffects(c, run, ports);
    if (state === "idle question") assert.match(before.question_id, /^q_[0-9a-f]{32}$/);
    const outcome = await Promise.resolve().then(() => c.kill(run.agent_id, settle_ms))
      .then((value) => ({ value }), (error) => ({ error }));
    await tick(); // Catch stop/disposal work incorrectly enqueued before validation too.
    assert.deepEqual(publicEffects(c, run, ports), before,
      "invalid kill cannot stop, mark exiting, clear questions, release/dispose or change reservations");
    assert(outcome.error, "invalid parameters must reject even when the Agent was already released");
    harnessFailure(outcome.error);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
  });

for (const settle_ms of [0.5, 300001, 2147483647, undefined])
  test(`kill accepts ${settle_ms ?? "default 10000"} with a quick controlled stop and cleanup`, async (t) => {
    const { c, ports } = await fixture(t), { run, port } = await start(c, ports, "quick-stop");
    port.autoStop = true;
    const recording = lifecycleCalls(t);
    try {
      const result = await c.kill(run.agent_id, settle_ms);
      assert.equal(recording.calls[0].wait_ms, settle_ms ?? 10000);
      assert(["released", "exiting"].includes(result.state)); // A tiny valid deadline may precede cleanup.
      await until(() => c.stats().resident === 0);
      assert.equal(port.stopped, 1); assert.equal(port.disposed, 1);
      assert.equal(c.view(run.run_id).phase, "settled");
      assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
    } finally { recording.restore(); }
  });

async function historyFixture(t) {
  const f = await fixture(t), { c, ports } = f, released = [], residents = [], firstRuns = [];
  for (let index = 0; index < 2; index++) {
    const entry = await start(c, ports, `released-${index}`, "otter");
    entry.port.finish("historical first task"); await settle(c, entry.run); firstRuns.push(entry.run);
    const next = await c.submit(`released-next-${index}`, { resume: entry.run.agent_id, prompt: "historical second task" });
    await until(() => entry.port.calls.length === 2 && entry.port.streaming);
    entry.port.finish("historical second result"); await settle(c, next);
    assert.equal((await c.release(next.agent_id)).released, true); released.push(next);
  }
  for (const [index, name] of ["otter", "otter", "orca", "lynx", "ibis", "rook", "wren", "hare"].entries()) {
    const entry = await start(c, ports, `resident-${index}`, name); firstRuns.push(entry.run);
    let latest = entry.run;
    if (index % 2) {
      entry.port.finish("resident first result"); await settle(c, entry.run);
      latest = await c.submit(`resident-next-${index}`, { resume: entry.run.agent_id, prompt: "resident second task" });
      await until(() => entry.port.calls.length === 2 && entry.port.streaming);
    }
    entry.port.callbacks.question(`Question for resident ${index}?`);
    entry.port.finish("pending question"); await settle(c, latest);
    residents.push({ run: latest, port: entry.port, task: index % 2 ? 2 : 1, token: c.view(latest.run_id).question_id });
  }
  assert.equal(c.stats().resident, 8); assert.equal(c.stats().agents, 10);
  return { ...f, released, residents, firstRuns };
}

function assertOrdinals(rows, released, residents) {
  const byAgent = new Map(rows.map((row) => [row.agent_id, row]));
  assert.equal(byAgent.size, rows.length, "equal names must not merge distinct UUID-addressed Agents");
  for (const { run, task: ordinal } of residents) {
    assert.equal(byAgent.get(run.agent_id).run_id, run.run_id); assert.equal(byAgent.get(run.agent_id).task, ordinal);
  }
  for (const run of released) {
    assert.equal(byAgent.get(run.agent_id).run_id, run.run_id); assert.equal(byAgent.get(run.agent_id).task, 2);
  }
}

test("list samples lease authority once for eight residents and released history, retaining per-Agent ordinals", async (t) => {
  const { c, owner, released, residents, firstRuns } = await historyFixture(t);
  for (const include_released of [true, false]) {
    owner.probes = 0;
    const rows = c.list({ include_released });
    assert.equal(owner.probes, 1, "a roster projection is one lease sample, not one per row");
    assert.equal(rows.length, include_released ? 10 : 8);
    assertOrdinals(rows, include_released ? released : [], residents);
  }
  for (const run of firstRuns) assert.equal(c.view(run.run_id).task, 1);
});

test("one list projection does not repeat full-history ordinal filtering for each Agent and observes later Runs freshly", async (t) => {
  const { c, released, residents } = await historyFixture(t), historySize = c.stats().runs;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "filter"), nativeFilter = descriptor.value;
  let historyFilters = 0, rows;
  // node:test's method helper rejects Array.prototype as an array target.
  // Only count public built-in calls over a full-history-sized array during
  // this synchronous list call; never inspect private Run objects or maps.
  Object.defineProperty(Array.prototype, "filter", { ...descriptor, value: function (...args) {
    if (this.length === historySize) historyFilters++;
    return nativeFilter.apply(this, args);
  } });
  try { rows = c.list({ include_released: true }); }
  finally { Object.defineProperty(Array.prototype, "filter", descriptor); }
  // A shared per-call ordinal derivation may use one filter or a linear pass,
  // but must not repeat the old full-history rank filter for every view.
  assert(historyFilters <= 1, `one projection repeated full-history ordinal filtering ${historyFilters} times`);
  assertOrdinals(rows, released, residents);
  const first = residents[0], continuation = await c.answer("fresh-ordinal", first.run.agent_id, first.token, "answer");
  await until(() => first.port.calls.length === 2 && first.port.streaming);
  first.port.finish("second task result"); await settle(c, continuation);
  const later = c.list().find((row) => row.agent_id === first.run.agent_id);
  assert.equal(later.run_id, continuation.run_id); assert.equal(later.task, 2);
  assert.equal(c.view(first.run.run_id).task, 1);
});

test("fresh list and view lease samples suppress and restore read-only question authority without latching Owner failure", async (t) => {
  const { c, owner, residents } = await historyFixture(t);
  owner.held = false; owner.probes = 0;
  const lost = c.list({ include_released: true }), lostProbes = owner.probes;
  assert(lost.every((row) => row.question_id === undefined && row.unavailable_reason === "owner_lease_lost"));
  assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
  owner.held = true; owner.probes = 0;
  const restored = c.list({ include_released: false }), restoredProbes = owner.probes;
  for (const { run, token } of residents) {
    assert.equal(restored.find((row) => row.agent_id === run.agent_id).question_id, token);
  }
  const first = residents[0];
  owner.held = false; owner.probes = 0;
  assert.equal(c.view(first.run.run_id).question_id, undefined); assert.equal(owner.probes, 1);
  owner.held = true; owner.probes = 0;
  assert.equal(c.view(first.run.run_id).question_id, first.token); assert.equal(owner.probes, 1);
  assert.equal(c.stats().internal_error, undefined, "read-only inspection does not acquire execution fault authority");
  assert.equal(lostProbes, 1); assert.equal(restoredProbes, 1);
});
