import assert from "node:assert/strict";
import test from "node:test";
import { deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";

test("prepared submission shares admission and raw-identity idempotence; one preparation", async (t) => {
  const { controller, ports } = await fixture(t);
  const input = { prompt: "original" };
  const resolved = task("original");
  let calls = 0;
  const first = controller.submitPrepared("same", input, (copy) => {
    calls++; assert.equal(copy.prompt, "original"); copy.prompt = "local mutation"; return resolved;
  });
  input.prompt = "caller mutation";
  const duplicate = controller.submitPrepared("same", { prompt: "original" }, () => { throw new Error("must not prepare twice"); });
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.run_id, b.run_id); assert.equal(calls, 1);
  resolved.settings = { ...resolved.settings, model: "changed after return" };
  assert.notEqual(controller.view(a.run_id).effective_settings.model, resolved.settings.model);
  await assert.rejects(controller.submitPrepared("same", { prompt: "changed" }, () => task("changed")), errorCode("REQUEST_CONFLICT"));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, a);
  await controller.shutdown();
  assert.equal((await controller.submitPrepared("same", { prompt: "original" }, () => { throw new Error(); })).run_id, a.run_id);
  await assert.rejects(controller.submitPrepared("new", {}, () => task("closed")), errorCode("OWNER_CLOSED"));
});

test("prepare failures are pre-accept, observe async rejection, and do not poison the queue", async (t) => {
  const { controller, ports } = await fixture(t);
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener); t.after(() => process.off("unhandledRejection", listener));
  const late = deferred();
  for (const [id, prepare, code] of [
    ["throw", () => { throw new Error("bad parse"); }],
    ["resolve", async () => task("not executed"), "ASYNC_PREPARE"],
    ["reject", async () => { throw new Error("rejected parse"); }, "ASYNC_PREPARE"],
    ["thenable", () => ({ then: (resolve, reject) => late.promise.then(resolve, reject) }), "ASYNC_PREPARE"],
    ["then-getter", () => Object.defineProperty({}, "then", { get() { throw new Error("then getter"); } }), "ASYNC_PREPARE"],
    ["then-field", () => ({ then: "not a function" }), "ASYNC_PREPARE"],
    ["null", () => null, "INVALID_SUBMIT"],
    ["invalid", () => ({ prompt: "missing description/settings" }), "INVALID_PARAMETER"],
  ]) await assert.rejects(controller.submitPrepared(id, {}, prepare), code ? errorCode(code) : /bad parse/);
  late.reject(new Error("late rejection")); await tick();
  assert.deepEqual(unhandled, []); assert.deepEqual(controller.list(), []);
  assert.equal(controller.stats().resident, 0); assert.equal(controller.stats().queued, 0); assert.equal(ports.length, 0);
  const good = await controller.submitPrepared("throw", {}, () => task("corrected without an old reservation"));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, good);
});

test("reentrant shutdown from a preparer cannot admit a Run", async (t) => {
  const { controller, ports } = await fixture(t);
  let closing;
  await assert.rejects(controller.submitPrepared("reentry", {}, () => {
    closing = controller.shutdown(); return task("must not start");
  }), errorCode("OWNER_CLOSED"));
  assert.equal((await closing).closed, true); assert.equal(ports.length, 0); assert.deepEqual(controller.list(), []);
});

test("identity is copied; completed Runs retain results but not ports across reuse and release churn", async (t) => {
  const { controller, owner, ports } = await fixture(t);
  const identity = controller.identity; identity.generation = "cannot change the owner";
  assert.equal(controller.identity.generation, owner.generation);
  const results = new Map();
  for (let i = 0; i < 3; i++) {
    const run = await controller.submit(`create-${i}`, task("first Run"));
    await until(() => ports[i]?.streaming);
    const port = ports[i];
    await assert.rejects(controller.release(run.agent_id), errorCode("AGENT_BUSY"));
    port.finish(`first result ${i}`); await ended(controller, run);
    results.set(run.run_id, `first result ${i}`);
    // Inspect the actual strong-reference edges, not GC timing. The fixture's
    // ports array intentionally retains its own references for these assertions.
    assert.equal(controller.runs.get(run.run_id).session, undefined);
    assert.equal(controller.agents.get(run.agent_id).session, port);
    const reused = await controller.submit(`reuse-${i}`, { resume: run.agent_id, prompt: "second Run" });
    await until(() => port.calls.length === 2);
    assert.equal(controller.runs.get(reused.run_id).session, port);
    port.finish(`second result ${i}`); await ended(controller, reused);
    results.set(reused.run_id, `second result ${i}`);
    const expected = { agent_id: run.agent_id, released: true };
    assert.deepEqual(await controller.release(run.agent_id), expected);
    assert.deepEqual(await controller.release(run.agent_id), expected);
    assert.equal(port.disposed, 1); assert.equal(controller.stats().resident, 0);
    assert.equal(controller.agents.get(run.agent_id).session, undefined);
    assert([...controller.runs.values()].every((record) => record.session === undefined));
    for (const [id, text] of results) assert.equal(controller.getResult(id).text, text);
  }
});

test("uncertain release never returns a release certificate or retries disposal", async (t) => {
  const { controller, owner, ports } = await fixture(t, { cleanupUncertainExpected: true });
  const run = await controller.submit("uncertain", task("uncertain"));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, run);
  let attempts = 0;
  ports[0].dispose = async () => { attempts++; return { shutdownExited: false, errors: ["uncertain"] }; };
  const expected = { agent_id: run.agent_id, released: false, reason: "cleanup_uncertain" };
  assert.deepEqual(await controller.release(run.agent_id), expected);
  assert.deepEqual(await controller.release(run.agent_id), expected);
  assert.equal(attempts, 1); assert.equal(controller.stats().resident, 1);
  assert.equal(controller.runs.get(run.run_id).session, undefined);
  assert.equal(controller.stats().cleanup_uncertain, true);
  assert.equal((await controller.shutdown()).closed, false); owner.assertHeld();
});

test("canonical identities reject non-JSON collisions and prepare normalized optional fields", async (t) => {
  const { controller, ports } = await fixture(t);
  const cycle = {}; cycle.self = cycle;
  for (const x of [NaN, Infinity, [undefined], Array(1), new Map(), new Date(), new Set(), cycle, 1n]) {
    await assert.rejects(controller.submitPrepared("json", { x }, () => task("not executed")), errorCode("INVALID_SUBMIT"));
  }
  let calls = 0;
  const a = await controller.submitPrepared("json", { x: undefined }, (input) => {
    assert.deepEqual(input, {}); calls++; return task("normalized");
  });
  const b = await controller.submitPrepared("json", {}, () => { throw new Error("same canonical request"); });
  assert.equal(a.run_id, b.run_id); assert.equal(calls, 1);
  for (const x of [null, [null], [], NaN]) {
    await assert.rejects(controller.submitPrepared("json", { x }, () => task("different")), errorCode(Number.isNaN(x) ? "INVALID_SUBMIT" : "REQUEST_CONFLICT"));
  }
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, a);
  const zero = await controller.submitPrepared("zero", { x: -0 }, () => task("negative zero"));
  await assert.rejects(controller.submitPrepared("zero", { x: 0 }, () => task("positive zero")), errorCode("REQUEST_CONFLICT"));
  await until(() => ports[1]?.streaming); ports[1].finish(); await ended(controller, zero);
});

test("canonical preparation removes alias identity, and equal JSON values reuse the accepted Run", async (t) => {
  const { controller, ports } = await fixture(t);
  const shared = { value: 1 };
  const a = await controller.submitPrepared("alias", { a: shared, b: shared }, (input) => {
    assert.notEqual(input.a, input.b);
    assert.deepEqual(input, { a: { value: 1 }, b: { value: 1 } });
    return task("alias normalized");
  });
  const b = await controller.submitPrepared("alias", { a: { value: 1 }, b: { value: 1 } }, () => { throw new Error("no second preparation"); });
  assert.equal(a.run_id, b.run_id);
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, a);
});

test("same-ID synchronous preparation reentry is still only one accepted Run", async (t) => {
  const { controller, ports } = await fixture(t);
  let sibling, calls = 0;
  const a = await controller.submitPrepared("reentrant-id", {}, () => {
    calls++;
    sibling = controller.submitPrepared("reentrant-id", {}, () => { calls++; return task("must not execute"); });
    return task("one");
  });
  const b = await sibling;
  assert.equal(a.run_id, b.run_id); assert.equal(calls, 1);
  await until(() => ports[0]?.streaming); assert.equal(ports.length, 1);
  ports[0].finish(); await ended(controller, a);
});

test("dispose reentry observes published single-flight and cannot falsely release uncertainty", async (t) => {
  const { controller, ports } = await fixture(t, { cleanupUncertainExpected: true });
  const run = await controller.submit("reentrant-release", task("one"));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(controller, run);
  let nested, calls = 0;
  ports[0].dispose = async () => {
    calls++; nested = controller.release(run.agent_id);
    return { shutdownExited: false, errors: ["uncertain"] };
  };
  const first = await controller.release(run.agent_id);
  assert.deepEqual(await nested, first); assert.equal(first.released, false);
  assert.equal(calls, 1); assert.equal(controller.stats().cleaning, 0);
  assert.equal(controller.stats().resident, 1); assert.equal(controller.stats().cleanup_uncertain, true);
});
