import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { HarnessError } from "../../dist/core/ports.js";
import { FakePort, deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

test("authority loss first observed during admission latches, wakes waiters and preserves replay", async (t) => {
  const { controller: c, ports, owner } = await fixture(t);
  const live = await c.submit("live", task("live")); await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", task("queued"));
  const waiting = c.wait([queued.run_id], { mode: "all", timeout_ms: 3000 });
  const broken = t.mock.method(owner, "assertHeld", () => { throw new Error("ADMISSION_AUTHORITY_FAILURE"); });
  await assert.rejects(c.submit("rejected", task("rejected")), /ADMISSION_AUTHORITY_FAILURE/);
  broken.mock.restore();
  assert.equal((await waiting).reason, "owner_blocked");
  assert.match(c.stats().internal_error, /ADMISSION_AUTHORITY_FAILURE/);
  await assert.rejects(c.submit("after-recovery", task("after-recovery")), errorCode("OWNER_INTERNAL_ERROR"));
  assert.equal((await c.submit("live", task("live"))).run_id, live.run_id);
  assert.equal(c.stats().runs, 2); assert.equal(c.view(queued.run_id).status, "queued");
  ports[0].finish("retained"); await ended(c, live);
  assert.equal(c.getResult(live.run_id).text, "retained");
  c.cancel(queued.run_id); await ended(c, queued);
  assert.equal((await c.shutdown()).closed, true);
});

for (const finishFails of [false, true]) test(`reservation survives successful disposal until history settles (failure=${finishFails})`, async (t) => {
  const hold = deferred(), entered = deferred(); let first = true;
  t.after(() => hold.resolve());
  const { controller: c, ports, owner } = await fixture(t, { controller: { resident_limit: 1 }, history: async (point) => {
    if (point === "finish" && first) {
      first = false; entered.resolve(); await hold.promise;
      if (finishFails) throw new Error("END_FAILED");
    }
  } });
  const run = await c.submit("isolated", task("isolated")); await until(() => ports[0]?.streaming);
  ports[0].finish("retained", "invalid"); await entered.promise;
  assert.equal(ports[0].disposed, 1, "SDK disposal can precede history completion");
  assert.equal(c.stats().active, 0); assert.equal(c.stats().finalizing, 1);
  assert.equal(c.stats().resident, 1); assert.equal(c.view(run.run_id).resident, true);
  assert.equal(c.list({ include_released: false })[0].run_id, run.run_id);
  await assert.rejects(c.submit("too-early", task("too-early")), errorCode("RESIDENT_LIMIT"));
  await assert.rejects(c.release(run.agent_id), errorCode("AGENT_BUSY"));
  owner.assertHeld();
  hold.resolve(); await until(() => c.view(run.run_id).phase === "settled");
  assert.equal(c.stats().resident, 0); assert.equal(c.view(run.run_id).resident, false);
  assert.equal(c.getResult(run.run_id).text, "retained");
  if (finishFails) assert.match(c.view(run.run_id).history_error, /END_FAILED/);
  const next = await c.submit("after-end", task("after-end")); await until(() => ports[1]?.streaming);
  ports[1].finish(); await ended(c, next);
});

for (const shutdown of [false, true]) for (const throws of [false, true]) {
  test(`idle ${shutdown ? "shutdown" : "release"} keeps ${throws ? "thrown" : "reported"} cleanup failure on latest Run`, async (t) => {
    const { controller: c, ports, owner } = await fixture(t, { cleanupUncertainExpected: true });
    const first = await c.submit("first", task("first")); await until(() => ports[0]?.streaming);
    ports[0].finish("first result"); await ended(c, first);
    const last = await c.submit("last", { resume: first.agent_id, prompt: "last" }); await until(() => ports[0]?.streaming);
    ports[0].finish("last result"); await ended(c, last);
    let attempts = 0;
    ports[0].dispose = async () => {
      attempts++;
      if (throws) throw new Error("UNIQUE_DISPOSE_FAILURE");
      return { shutdownExited: false, errors: ["UNIQUE_DISPOSE_FAILURE"] };
    };
    if (shutdown) assert.equal((await c.shutdown()).closed, false);
    else assert.equal((await c.release(last.agent_id)).released, false);
    const view = c.view(last.run_id);
    assert(view.cleanup_errors.some((error) => error.includes("UNIQUE_DISPOSE_FAILURE")));
    if (!throws) assert(view.cleanup_errors.includes("shutdown_not_exited"));
    assert.deepEqual(c.view(first.run_id).cleanup_errors, []);
    assert.equal(view.status, "completed"); assert.equal(view.outcome.status, "completed");
    assert.equal(c.getResult(last.run_id).text, "last result");
    assert.equal(view.resident, true); assert.equal(view.resumable, false);
    assert.equal(c.stats().cleanup_uncertain, true); owner.assertHeld();
    assert.equal((await c.shutdown()).closed, false); assert.equal(attempts, 1);
  });
}

for (const shutdownExited of [true, false]) test(`idle-cleanup diagnostics are bounded without losing shutdown state (${shutdownExited})`, async (t) => {
  const { controller: c, ports } = await fixture(t, { cleanupUncertainExpected: true });
  const run = await c.submit("bounded", task("bounded")); await until(() => ports[0]?.streaming);
  ports[0].finish(); await ended(c, run);
  ports[0].dispose = async () => ({ shutdownExited, errors: Array.from({ length: 20 }, (_, i) => `${i}:${"x".repeat(5000)}`) });
  await c.release(run.agent_id);
  const errors = c.view(run.run_id).cleanup_errors;
  assert.equal(errors.length, shutdownExited ? 17 : 18);
  assert(errors.includes("CLEANUP_ERRORS_OMITTED: 4"));
  assert.equal(errors.includes("shutdown_not_exited"), !shutdownExited);
  assert(errors.every((error) => error.length <= 2048));
});

const opaqueFailures = {
  nullPrototype: () => Object.create(null),
  throwingCoercion: () => ({ toString() { throw new Error("COERCION_FAILED"); } }),
  throwingPrototype: () => new Proxy({}, { getPrototypeOf() { throw new Error("PROTOTYPE_FAILED"); } }),
  throwingDetails: () => new HarnessError("BAD_DETAILS", { get error() { throw new Error("DETAILS_FAILED"); } }),
};
for (const [name, failure] of Object.entries(opaqueFailures)) for (const phase of ["finalizing", "release", "shutdown"]) {
  test(`opaque cleanup rejection settles without freeing uncertain ownership (${name}, ${phase})`, async () => {
    // No live child or OS lease: faults below deliberately model an untrusted
    // rejection value, including values that break instanceof/property access.
    let held = true, disposals = 0;
    const owner = { owner_id: randomUUID(), generation: randomUUID(),
      assertHeld() { assert(held); }, close() { held = false; } };
    const port = new FakePort();
    port.dispose = async () => { disposals++; throw failure(); };
    const c = await OwnerController.open({ owner, createSession: async () => port });
    const run = await c.submit("opaque", task("opaque")); await until(() => port.streaming);
    port.finish("retained result", phase === "finalizing" ? "invalid" : "success");
    await ended(c, run);
    // Cleanup uncertainty can wake wait_runs before finalization completes.
    await until(() => c.view(run.run_id).phase === "settled");
    if (phase === "release") assert.equal((await c.release(run.agent_id)).released, false);
    if (phase === "shutdown") assert.equal((await c.shutdown(20)).closed, false);
    const view = c.view(run.run_id);
    assert.equal(view.phase, "settled"); assert.equal(view.finalization_pending, false);
    assert.equal(view.status, phase === "finalizing" ? "failed" : "completed");
    assert.equal(c.getResult(run.run_id).text, "retained result");
    assert(view.cleanup_errors.includes("Unprintable failure"));
    assert.equal(view.resident, true); assert.equal(view.resumable, false);
    assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, true);
    assert.equal((await c.shutdown(20)).closed, false);
    assert.equal(disposals, 1); owner.assertHeld();
  });
}

test("one opaque reported cleanup error cannot erase its siblings or shutdown marker", async (t) => {
  const { controller: c, ports, owner } = await fixture(t, { cleanupUncertainExpected: true });
  const run = await c.submit("reported-opaque", task("reported-opaque")); await until(() => ports[0]?.streaming);
  ports[0].finish(); await ended(c, run);
  ports[0].dispose = async () => ({ shutdownExited: false, errors: ["before", Object.create(null), "after"] });
  assert.equal((await c.release(run.agent_id)).released, false);
  assert.deepEqual(c.view(run.run_id).cleanup_errors, ["before", "Unprintable failure", "after", "shutdown_not_exited"]);
  assert.equal(c.view(run.run_id).phase, "settled"); owner.assertHeld();
});
