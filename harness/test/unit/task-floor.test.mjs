import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { OwnerController, softBudgetMessage } from "../../dist/core/owner-controller.js";
import { HarnessError } from "../../dist/core/ports.js";
import { ApprovalBindings } from "../../dist/permissions/approval-provenance.js";
import { createChildTools } from "../../dist/tools/child-tools.js";
import { FakePort, deferred, task, settings, errorCode, ended, tick, until } from "../support/controller-fixture.mjs";
import { assertOwnerInvariants } from "../support/owner-invariants.mjs";

// In-memory host seams only: no Git, filesystem preflight, flock, SDK or provider.
// Reuse the existing lifecycle fixture's port/waits/invariants, but not its OS lease.
async function memoryFixture(t, options = {}) {
  let held = true;
  const owner = { owner_id: "task-floor-owner", generation: "task-floor-generation", closes: 0,
    assertHeld() { if (!held) throw new HarnessError("OWNER_LOCK_CLOSED"); },
    close() { held = false; this.closes++; } };
  const ports = [], events = [];
  const controller = await OwnerController.open({ owner, concurrency: 1, resident_limit: 8, queue_limit: 16,
    createSession: async () => {
      const port = new FakePort(); ports.push(port);
      options.configurePort?.(port);
      if (options.history) port.history = options.history(port);
      await options.sessionGate?.promise;
      return port;
    },
    onContextChange: (event) => { events.push(event); }, ...options.controller });
  t.after(async () => {
    options.sessionGate?.resolve();
    await tick();
    for (const port of ports) {
      port.deliveryGate?.resolve();
      if (port.streaming) port.finish("test cleanup", "aborted");
    }
    const report = await controller.shutdown(1000);
    assertOwnerInvariants(controller);
    if (options.cleanupUncertainExpected) {
      assert.equal(report.closed, false);
      assert.equal(report.cleanup_uncertain, true);
      assert.equal(report.active + report.finalizing + report.cleaning, 0);
      owner.assertHeld();
      owner.close(); // Only releases this test's handle-free simulated lease.
    } else assert.equal(report.closed, true, JSON.stringify(report));
  });
  return { controller, owner, ports, events };
}

function dispatchPort(options = {}) {
  const prepares = [], starts = [];
  const path = (word, cwd) => {
    const absolute = resolve(cwd, word);
    return { path: absolute, canonical: options.canonical?.(absolute) ?? absolute };
  };
  return { prepares, starts,
    prepare(declaration, context) {
      prepares.push(structuredClone({ declaration, context }));
      options.preflight?.(declaration, context);
      return { declaration: structuredClone(declaration),
        inputs: (declaration.inputs ?? []).map(word => path(word, context.cwd)),
        ownership: (declaration.ownership ?? []).map(word => path(word, context.cwd)),
        ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree, context.cwd) }) };
    },
    async start(prepared, context) {
      starts.push(structuredClone({ prepared, context }));
      return await options.start?.(prepared, context) ?? {};
    } };
}
function treeLease() {
  return { closes: 0, checks: 0,
    assertHeld() { this.checks++; assert.equal(this.closes, 0); },
    close() { this.closes++; assert.equal(this.closes, 1, "a lineage closes its lease exactly once"); } };
}
const claimFor = (c, run) => [...c.claims].find(claim => claim.agent_id === run.agent_id);
const envelope = result => JSON.parse(result.content[0].text);

async function ask(port, question = "Which safe next step?") {
  const tools = createChildTools(() => port.callbacks, { accepting: true, stopped: false });
  const receipt = await tools.find(tool => tool.name === "ask_parent").execute("ask", { question });
  assert.equal(receipt.content[0].text, "Question recorded. Stop calling tools and end your turn now.");
}

const serial = { concurrency: false };
const twoDays = 2 * 24 * 60 * 60 * 1000;

test("retired execution duration is rejected before admission, including on reuse", serial, async t => {
  const { controller: c, ports } = await memoryFixture(t);
  for (const value of [1, 300000, 1800000, null]) {
    await assert.rejects(c.submit(`retired-${String(value)}`, task("invalid", { max_duration_ms: value })), errorCode("UNSUPPORTED_PARAMETER"));
  }
  assert.equal(c.stats().runs, 0); assert.equal(ports.length, 0);
  const first = await c.submit("first", task("ordinary")); await until(() => ports[0]?.streaming);
  ports[0].finish(); await ended(c, first);
  await assert.rejects(c.submit("retired-reuse", { resume: first.agent_id, prompt: "next", max_duration_ms: 300000 }), errorCode("UNSUPPORTED_PARAMETER"));
  assert.equal(c.stats().runs, 1); assert.equal(c.view(first.run_id).resumable, true);
});

test("initialization has no execution timer; explicit cancellation still prevents child input", serial, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gate = deferred(), scheduled = [], nativeSet = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    scheduled.push(delay); return nativeSet(callback, delay, ...args);
  });
  const { controller: c, ports, events } = await memoryFixture(t, { sessionGate: gate });
  const run = await c.submit("initializing", task("initialize"));
  assert.equal(c.view(run.run_id).phase, "initializing");
  assert.deepEqual(scheduled, [], "taking a slot must not arm a hard or soft execution deadline");
  t.mock.timers.tick(twoDays); await tick();
  assert.equal(c.view(run.run_id).status, "running"); assert.equal(c.view(run.run_id).stop_reason, undefined);
  assert.equal(ports[0].stopped, 0); assert.equal(c.stats().active, 1);
  assert.deepEqual(events.map(event => event.kind), ["submit"]);
  c.cancel(run.run_id); gate.resolve(); await ended(c, run);
  assert.equal(ports[0].calls.length, 0); assert.equal(c.view(run.run_id).status, "cancelled");
});

test("long execution keeps claims and approval; observation timeout cannot stop the task", serial, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch: dispatchPort(),
    clock: { wall: () => Date.now(), mono: () => Date.now() } } });
  const busEvents = [], bindings = new ApprovalBindings({ emit: (name, payload) => busEvents.push({ name, payload }) }, c.identity);
  c.options.onContextChange = bindings.contextChanged;
  const run = await c.submit("long", task("long command", { name: "worker", max_turns: 1, dispatch: { ownership: ["output"] } }));
  await until(() => ports[0]?.streaming);
  const port = ports[0], identity = port.calls[0].identity;
  assert.equal(bindings.begin(identity, { sessionId: port.session_id, cwd: settings.cwd,
    profile: settings.profile, definitionDigest: settings.definition_digest, prompt: port.calls[0].prompt }), true);
  t.after(() => bindings.end(port.session_id, identity));
  const facts = globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")].get(port.session_id);
  t.mock.timers.tick(twoDays); await tick();
  port.callbacks.inputEntered(); await tick();
  const view = c.view(run.run_id);
  assert.equal(view.status, "running"); assert.equal(view.execution_elapsed_ms, twoDays);
  assert.equal(view.stop_reason, undefined); assert.equal(c.runs.get(run.run_id).record.limit_reached, false);
  assert.equal(Object.hasOwn(view, "max_duration_ms"), false); assert.equal(Object.hasOwn(view, "time_wrapped"), false);
  assert.equal(facts.contextChanged, false); assert.deepEqual(port.inputs, []); assert.equal(port.stopped, 0);
  assert.equal(c.claims.size, 1); assert.equal(c.stats().active, 1);
  const waiting = c.observe({ kind: "wait", agent_ids: [run.agent_id], wait_ms: 5 }, { validate() {} });
  t.mock.timers.tick(5);
  assert.equal(envelope(await waiting).reason, "timeout");
  assert.equal(c.view(run.run_id).status, "running"); assert.equal(port.stopped, 0);
  port.callbacks.turnEnd(true); await tick();
  assert.deepEqual(port.inputs, [softBudgetMessage], "the turn-limit reminder remains");
  assert.equal(facts.contextChanged, true);
  assert.equal(busEvents.filter(event => event.name === "pi-harness:approval:invalidated").length, 1);
  port.finish("finished after long command"); await ended(c, run);
  assert.equal(c.view(run.run_id).outcome.limit_reached, true);
  assert.equal(Object.hasOwn(c.view(run.run_id).outcome, "time_wrapped"), false);
  assert.equal(Object.hasOwn(c.stats(), "time_wrapped_attempts"), false);
  assert.equal(c.claims.size, 0);
});

test("follow-ups and answer continuations retain only the turn limit, with no timed input", serial, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { controller: c, ports, events } = await memoryFixture(t);
  const first = await c.submit("first", task("first", { max_turns: 7 })); await until(() => ports[0]?.streaming);
  t.mock.timers.tick(twoDays); await tick();
  ports[0].finish("first done"); await ended(c, first);
  const next = await c.submit("next", { resume: first.agent_id, prompt: "follow up" });
  await until(() => ports[0].calls.length === 2);
  t.mock.timers.tick(twoDays); await tick();
  assert.equal(c.view(next.run_id).max_turns, 7); assert.equal(ports[0].stopped, 0); assert.deepEqual(ports[0].inputs, []);
  await ask(ports[0]); ports[0].finish("waiting"); await ended(c, next);
  const answer = await c.answer("answer", next.agent_id, c.view(next.run_id).question_id, "continue");
  await until(() => ports[0].calls.length === 3);
  t.mock.timers.tick(twoDays); await tick();
  assert.equal(c.view(answer.run_id).max_turns, 7); assert.equal(c.view(answer.run_id).status, "running");
  assert.equal(c.agents.get(first.agent_id).question, undefined, "real answer input still consumes the old reservation");
  assert.equal(ports[0].stopped, 0); assert.deepEqual(ports[0].inputs, []);
  assert(events.every(event => !["soft_budget", "deadline"].includes(event.kind)));
  ports[0].finish("answer done"); await ended(c, answer);
  assert.equal(c.view(answer.run_id).status, "completed"); assert.equal(ports.length, 1);
});

test("direct dispatch without host port fails before acceptance; no-dispatch remains usable", serial, async t => {
  const { controller: c, ports } = await memoryFixture(t);
  await assert.rejects(c.submit("no-port", task("dispatch", { dispatch: { ownership: ["out"] } })), errorCode("DISPATCH_UNAVAILABLE"));
  assert.equal(c.stats().runs, 0); assert.equal(c.stats().resident, 0); assert.equal(ports.length, 0);
  const ordinary = await c.submit("ordinary", task("ordinary"));
  await until(() => ports[0]?.streaming);
  assert.equal(c.view(ordinary.run_id).dispatch, undefined);
  ports[0].finish(); await ended(c, ordinary);
});

test("prepare is synchronous/read-only, cannot reserve or swallow reentrant effects; replay does not reprepare", serial, async t => {
  let c, sabotage = false;
  const observations = [];
  const dispatch = dispatchPort({ preflight() {
    observations.push({ claims: c.claims.size, runs: c.stats().runs });
    if (sabotage) { try { c.cancel(c.list()[0].run_id); } catch { /* outer readonly frame must still reject */ } }
  } });
  ({ controller: c } = await memoryFixture(t, { controller: { dispatch } }));
  let hostPrepares = 0;
  const input = task("prepare", { dispatch: { ownership: ["out"], checks: ["unit"] } });
  const prepare = value => { hostPrepares++; return value; };
  const run = await c.submitPrepared("same", input, prepare);
  await until(() => c.view(run.run_id).phase === "executing");
  assert.deepEqual(observations, [{ claims: 0, runs: 0 }, { claims: 1, runs: 1 }], "only atomic admission installs a claim");
  const count = dispatch.prepares.length, starts = dispatch.starts.length;
  assert.equal((await c.submitPrepared("same", input, prepare)).run_id, run.run_id);
  assert.equal(hostPrepares, 1); assert.equal(dispatch.prepares.length, count); assert.equal(dispatch.starts.length, starts);
  sabotage = true;
  await assert.rejects(c.submit("nested", task("nested", { dispatch: { ownership: ["other"] } })), errorCode("OBSERVATION_REENTRANCY"));
  assert.equal(c.stats().runs, 1); assert.equal(c.claims.size, 1);
  assert.equal(c.view(run.run_id).stop_reason, undefined);
  sabotage = false;
});

for (const [held, wanted, code] of [
  [{ ownership: ["src"] }, { ownership: ["src/file.mjs"] }, "RESOURCE_OWNED"],
  [{ ownership: ["src/file.mjs"] }, { ownership: ["src"] }, "RESOURCE_OWNED"],
  [{ tree: "build" }, { ownership: ["build/cache"] }, "RESOURCE_OWNED"],
  [{ ownership: ["build/cache"] }, { tree: "build" }, "RESOURCE_OWNED"],
  [{ tree: "build" }, { tree: "build/nested" }, "BUILD_TREE_BUSY"],
  [{ tree: "build" }, { tree: "build" }, "BUILD_TREE_BUSY"],
  [{ ownership: ["alias/new"] }, { ownership: ["actual/new/child"] }, "RESOURCE_OWNED"],
  [{ tree: "alias/new" }, { tree: "actual/new" }, "BUILD_TREE_BUSY"],
]) {
  test(`all resource kinds check prefix/canonical aliases: ${JSON.stringify(held)} versus ${JSON.stringify(wanted)}`, serial, async t => {
    const dispatch = dispatchPort({ canonical: path => path.replace(/^\/tmp\/alias(?=\/|$)/, "/tmp/actual") });
    const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
    const first = await c.submit("held", task("held", { dispatch: held }));
    await until(() => ports[0]?.streaming);
    await assert.rejects(c.submit("conflict", task("conflict", { dispatch: wanted })), errorCode(code));
    assert.equal(c.stats().runs, 1); assert.equal(c.claims.size, 1);
    ports[0].finish(); await ended(c, first);
    assert.equal(c.claims.size, 0);
    const later = await c.submit("later", task("later", { dispatch: wanted }));
    await until(() => ports[1]?.streaming);
    ports[1].finish(); await ended(c, later);
  });
}

test("async or malformed dispatch preparers reject before acceptance without leaking rejected promises", serial, async t => {
  const dispatch = dispatchPort();
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  dispatch.prepare = async () => { throw new Error("invalid async preflight"); };
  await assert.rejects(c.submit("async", task("async", { dispatch: { ownership: ["out"] } })), errorCode("ASYNC_OBSERVATION_PORT"));
  dispatch.prepare = () => ({ declaration: {}, inputs: [], ownership: [{ path: "relative", canonical: "/tmp/out" }] });
  await assert.rejects(c.submit("malformed", task("malformed", { dispatch: { ownership: ["out"] } })), errorCode("INVALID_PREPARED_DISPATCH"));
  dispatch.prepare = () => ({ declaration: {}, inputs: [], ownership: new Array(1) });
  await assert.rejects(c.submit("sparse-prepared", task("sparse-prepared", { dispatch: { ownership: ["out"] } })), errorCode("INVALID_PREPARED_DISPATCH"));
  // Sparse caller arrays fail the existing canonical identity encoder before
  // dispatch validation; sparse host-prepared arrays above hit its own guard.
  for (const dispatch of [{ inputs: new Array(1) }, { ownership: new Array(1) }, { checks: new Array(1) }])
    await assert.rejects(c.submit("bad-declaration", task("bad-declaration", { dispatch })), errorCode("INVALID_SUBMIT"));
  await assert.rejects(c.submit("bad-path", task("bad-path", { dispatch: { tree: " out " } })), errorCode("INVALID_DISPATCH"));
  await tick();
  assert.equal(c.stats().runs, 0); assert.equal(c.claims.size, 0); assert.equal(ports.length, 0);
  assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined);
});

test("known input permission denial is not deferred by after and does not install claims", serial, async t => {
  const dispatch = dispatchPort({ preflight(declaration) {
    if (declaration.inputs?.length) throw new HarnessError("PREFLIGHT_DENIED", { path: "private-input" });
  } });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  await assert.rejects(c.submit("denied", task("denied", { after: [a.run_id],
    dispatch: { inputs: ["private-input"], ownership: ["out"] } })), errorCode("PREFLIGHT_DENIED"));
  assert.equal(dispatch.prepares[0].context.deferInputs, true);
  assert.equal(c.stats().runs, 1); assert.equal(c.claims.size, 0); assert.equal(ports.length, 1);
  ports[0].finish(); await ended(c, a);
});

test("prefix comparison respects separator boundaries and concurrent admissions reserve atomically", serial, async t => {
  const dispatch = dispatchPort();
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const [left, right] = await Promise.allSettled([
    c.submit("left", task("left", { dispatch: { ownership: ["src"] } })),
    c.submit("right", task("right", { dispatch: { ownership: ["src/file"] } })),
  ]);
  assert.equal(left.status, "fulfilled"); assert.equal(right.status, "rejected"); assert.equal(right.reason.code, "RESOURCE_OWNED");
  const sibling = await c.submit("sibling", task("sibling", { dispatch: { ownership: ["src-other"] } }));
  assert.equal(sibling.status, "queued"); assert.equal(c.claims.size, 2);
  c.cancel(sibling.run_id); await ended(c, sibling);
  await until(() => ports[0]?.streaming);
  ports[0].finish(); await ended(c, left.value);
});

test("fixed A→B→C after closure exempts predecessors and future reservations, not unordered siblings", serial, async t => {
  const dispatch = dispatchPort(), declaration = { ownership: ["out"], tree: "build" };
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const a = await c.submit("a", task("a", { name: "a", dispatch: declaration }));
  await until(() => ports[0]?.streaming);
  const b = await c.submit("b", task("b", { name: "b", after: [a.run_id], dispatch: declaration }));
  const child = await c.submit("c", task("c", { name: "c", after: [b.run_id], dispatch: declaration }));
  assert.equal(c.claims.size, 3);
  assert.deepEqual(c.view(child.run_id).after, [b.run_id]);
  await assert.rejects(c.submit("sibling", task("sibling", { after: [a.run_id], dispatch: declaration })), errorCode("RESOURCE_OWNED"));
  ports[0].finish("A artifact"); await ended(c, a);
  await until(() => ports[1]?.streaming);
  assert.equal(c.view(b.run_id).status, "running", "C's future claim cannot prevent B starting");
  assert.equal(c.view(child.run_id).status, "queued");
  assert.match(ports[1].calls[0].prompt, /A artifact/);
  ports[1].finish("B artifact"); await ended(c, b);
  await until(() => ports[2]?.streaming);
  assert.equal(c.view(child.run_id).status, "running");
  ports[2].finish(); await ended(c, child);
  assert.equal(c.claims.size, 0);
});

test("a questioned predecessor fails its fixed-after successors at once, freeing their reservations before the answer", serial, async t => {
  const dispatch = dispatchPort(), declaration = { ownership: ["x"] };
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const a = await c.submit("a", task("a", { name: "a", dispatch: declaration }));
  await until(() => ports[0]?.streaming);
  const peer = await c.submit("peer", task("peer", { name: "peer" }));
  const b = await c.submit("b", task("b", { name: "b", after: [a.run_id], dispatch: declaration }));
  const child = await c.submit("c", task("c", { name: "c", after: [b.run_id], dispatch: declaration }));
  const originalClaim = claimFor(c, a);
  assert.equal(c.claims.size, 3);
  await ask(ports[0]); ports[0].finish("need a decision"); await ended(c, a);
  await ended(c, b); await ended(c, child);
  assert.equal(c.view(a.run_id).status, "needs_input");
  assert.equal(c.view(peer.run_id).status, "running");
  assert.equal(c.stats().active, 1, "the earlier unclaimed peer occupies the only slot; failing successors needs none");
  assert.equal(c.view(b.run_id).outcome.error, "DEPENDENCY_NOT_COMPLETED: a (needs_input)");
  assert.equal(c.view(child.run_id).outcome.error, "DEPENDENCY_NOT_COMPLETED: b (failed)", "the failure cascades without a slot");
  assert.equal(c.claims.size, 1, "only the pending question keeps its claim");
  assert.equal(claimFor(c, a), originalClaim);
  const answer = await c.answer("answer", a.agent_id, c.view(a.run_id).question_id, "continue safely");
  assert.equal(answer.status, "queued");
  assert.equal(claimFor(c, answer), originalClaim); assert.equal(originalClaim.run_id, answer.run_id);
  assert.deepEqual(answer.dispatch, declaration);
  ports[1].finish(); await ended(c, peer);
  await until(() => ports[0].calls.length === 2);
  assert.equal(c.view(answer.run_id).status, "running");
  assert.equal(ports.length, 2, "neither failed successor starts a session");
  ports[0].finish("answered"); await ended(c, answer);
  assert.equal(c.view(answer.run_id).status, "completed");
  for (const successor of [b, child]) {
    const view = c.view(successor.run_id);
    assert.equal(view.status, "failed"); assert.equal(view.outcome.reason, "dependency_not_completed");
    assert.equal(view.resumable, true); assert.equal(view.history_ref, undefined);
  }
  assert.deepEqual(c.view(b.run_id).after, [a.run_id], "answer never rebinds B to A's continuation");
  assert.deepEqual(c.view(child.run_id).after, [b.run_id], "transitive dependency stays bound to the original B Run");
  assert.equal(c.stats().settled_reasons["failed/dependency_not_completed"], 2);
  assert.equal(c.claims.size, 0); assert.equal(ports.length, 2);
});

test("accepted context-change failure releases its claim through finish and request replay retains the failed Run", serial, async t => {
  let c, fail = true, hostPrepares = 0;
  const accepted = [], dispatch = dispatchPort();
  ({ controller: c } = await memoryFixture(t, { controller: { dispatch, onContextChange: event => {
    accepted.push({ run_id: event.run_id, claims: c.claims.size, requests: c.stats().requests });
    if (fail) throw new Error("accepted witness failure");
  } } }));
  const input = task("accepted failure", { dispatch: { ownership: ["x"] } });
  const prepare = value => { hostPrepares++; return value; };
  const run = await c.submitPrepared("changed", input, prepare);
  await ended(c, run);
  assert.deepEqual(accepted, [{ run_id: run.run_id, claims: 1, requests: 1 }], "failure occurs after atomic acceptance/claim installation");
  assert.equal(c.view(run.run_id).status, "failed");
  assert.equal(c.view(run.run_id).outcome.reason, "context_change_failed");
  assert.equal(c.claims.size, 0); assert.equal(c.stats().requests, 1); assert.equal(c.stats().runs, 1);
  assert.equal(dispatch.prepares.length, 1); assert.equal(dispatch.starts.length, 0);
  fail = false;
  const next = await c.submit("new-owner", task("new owner", { dispatch: { ownership: ["x"] } }));
  await until(() => c.view(next.run_id).phase === "executing");
  const preflightCount = dispatch.prepares.length, acceptedCount = accepted.length;
  const replay = await c.submitPrepared("changed", input, prepare);
  assert.equal(replay.run_id, run.run_id); assert.equal(replay.status, "failed");
  assert.equal(replay.outcome.reason, "context_change_failed");
  assert.equal(hostPrepares, 1); assert.equal(dispatch.prepares.length, preflightCount);
  assert.equal(accepted.length, acceptedCount, "replay never retries the failed context change");
  assert.equal(c.stats().runs, 2); assert.equal(c.claims.size, 1, "the new owner, not replay, holds x");
});

for (const failure of ["DISPATCH_INPUT_MISSING", "PREFLIGHT_DENIED", "host interface failure"]) {
  test(`after deferred ${failure} is typed, starts no session, and retains the first-task Agent`, serial, async t => {
    let fail = true;
    const dispatch = dispatchPort({ preflight(declaration, context) {
      if (declaration.inputs?.length && !context.deferInputs && fail) {
        if (failure === "host interface failure") throw new Error(failure);
        throw new HarnessError(failure, { path: "artifact" });
      }
    } });
    const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
    const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
    const b = await c.submit("b", task("b", { after: [a.run_id], dispatch: { inputs: ["artifact"], ownership: ["out"] } }));
    assert.equal(dispatch.prepares[0].context.deferInputs, true);
    assert.equal(c.view(b.run_id).status, "queued");
    ports[0].finish(); await ended(c, a); await ended(c, b);
    const reason = failure === "DISPATCH_INPUT_MISSING" ? "dependency_input_missing" : "dispatch_preflight_failed";
    const view = c.view(b.run_id);
    assert.equal(view.status, "failed"); assert.equal(view.outcome.reason, reason);
    assert.equal(view.resident, true); assert.equal(view.resumable, true);
    assert.equal(view.history_ref, undefined); assert.equal(ports.length, 1);
    assert.equal(c.stats().active, 0); assert.equal(c.claims.size, 0);
    assert.equal(c.stats().settled_reasons[`failed/${reason}`], 1);
    assert.equal(dispatch.prepares[1].context.deferInputs, false);
    fail = false;
    const resumed = await c.submit("resume", { resume: b.agent_id, prompt: "try an available task" });
    await until(() => ports[1]?.streaming);
    ports[1].finish(); await ended(c, resumed);
    assert.equal(c.view(resumed.run_id).status, "completed");
  });
}

test("every dispatched Run rechecks preflight in pump, even without after", serial, async t => {
  let calls = 0;
  const dispatch = dispatchPort({ preflight() { if (++calls === 2) throw new HarnessError("PREFLIGHT_DENIED"); } });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const run = await c.submit("direct", task("direct", { dispatch: { inputs: ["input"] } }));
  await ended(c, run);
  assert.equal(c.view(run.run_id).outcome.reason, "dispatch_preflight_failed");
  assert.equal(c.view(run.run_id).resumable, true); assert.equal(ports.length, 0);
});

test("pending question → queued answer cancel restores the same claim/lease → answer success releases", serial, async t => {
  const lease = treeLease(), declaration = { ownership: ["out"], tree: "build", checks: ["focused"] };
  const dispatch = dispatchPort({ start: (_prepared, context) => context.acquireTree ? { lease } : {} });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  const question = await c.submit("question", task("question", { name: "worker", dispatch: declaration }));
  await until(() => ports[0]?.streaming);
  for (const prompt of [ports[0].calls[0].prompt, ports[0].calls[0].identity.task_prompt]) {
    assert.match(prompt, /Parent dispatch.*scope.*planned checks/i);
    assert.match(prompt, /not permissions or execution evidence/i);
    assert(prompt.includes(`Execution cwd: ${JSON.stringify(settings.cwd)}`));
    assert.match(prompt, /Relative inputs, ownership, and tree paths resolve from this execution cwd/);
    assert(prompt.includes(`Policy and settings inherit from source cwd (${JSON.stringify(settings.cwd)})`));
    assert.match(prompt, /declarations grant no permissions/);
    assert.match(prompt, /focused/);
  }
  await ask(ports[0]); ports[0].finish("waiting"); await ended(c, question);
  const originalClaim = claimFor(c, question), questionId = c.view(question.run_id).question_id;
  assert(questionId); assert.equal(originalClaim.lease, lease); assert.equal(lease.closes, 0);
  await assert.rejects(c.submit("steal-pending", task("steal", { dispatch: declaration })), error => {
    assert.equal(error.code, "RESOURCE_OWNED");
    assert.equal(error.details.agent, "worker");
    assert.equal(error.details.key, "ownership"); assert.equal(error.details.requested, "out");
    assert.match(error.details.resolution, /agent_answer/); assert.match(error.details.resolution, /agent_kill/);
    assert.match(error.details.resolution, /confirmed release/);
    assert.doesNotMatch(error.details.resolution, /declare an after dependency/i);
    assert.match(error.details.resolution, /in after is rejected/i);
    return true;
  });
  const blocker = await c.submit("blocker", task("blocker")); await until(() => ports[1]?.streaming);
  const answer = await c.answer("answer", question.agent_id, questionId, "yes");
  assert.equal(answer.status, "queued"); assert.deepEqual(answer.dispatch, declaration);
  assert.equal(claimFor(c, answer), originalClaim); assert.equal(originalClaim.run_id, answer.run_id);
  assert.equal(c.view(question.run_id).question_id, undefined);
  c.cancel(answer.run_id); await ended(c, answer);
  assert.equal(ports[0].calls.length, 1); assert.equal(lease.closes, 0);
  assert.equal(c.view(question.run_id).question_id, questionId);
  assert.equal(claimFor(c, question), originalClaim); assert.equal(originalClaim.run_id, question.run_id);
  await assert.rejects(c.submit("steal-rollback", task("steal", { dispatch: declaration })), errorCode("RESOURCE_OWNED"));
  const retry = await c.answer("retry", question.agent_id, questionId, "continue");
  ports[1].finish(); await ended(c, blocker); await until(() => ports[0].calls.length === 2);
  assert.deepEqual(dispatch.starts.map(entry => entry.context.acquireTree), [true, false], "continuation never reacquires its existing lease");
  assert.equal(lease.checks, 1);
  ports[0].finish("delivered"); await ended(c, retry);
  assert.equal(c.claims.size, 0); assert.equal(lease.closes, 1);
  assert.equal(c.view(question.run_id).question_id, undefined);
  const next = await c.submit("next-owner", task("next owner", { dispatch: { ownership: ["out"] } }));
  await until(() => ports[2]?.streaming); ports[2].finish(); await ended(c, next);
});

for (const uncertain of [false, true]) {
  test(`kill of pending question keeps resource through ${uncertain ? "uncertain" : "confirmed"} cleanup`, serial, async t => {
    const gate = deferred(), lease = treeLease();
    const dispatch = dispatchPort({ start: () => ({ lease }) });
    const { controller: c, ports, owner } = await memoryFixture(t, { cleanupUncertainExpected: uncertain, controller: { dispatch } });
    t.after(() => gate.resolve({ shutdownExited: !uncertain, errors: [] }));
    const run = await c.submit("question", task("question", { dispatch: { ownership: ["out"], tree: "build" } }));
    await until(() => ports[0]?.streaming);
    await ask(ports[0]); ports[0].finish("waiting"); await ended(c, run);
    const claim = claimFor(c, run);
    ports[0].dispose = async () => { ports[0].disposed++; return await gate.promise; };
    const result = await c.kill(run.agent_id, 0);
    assert.equal(result.state, "exiting");
    await until(() => ports[0].disposed === 1);
    assert.equal(c.view(run.run_id).question_id, undefined);
    assert.equal(claimFor(c, run), claim); assert.equal(lease.closes, 0);
    await assert.rejects(c.submit("steal-during-cleanup", task("steal", { dispatch: { ownership: ["out"] } })), errorCode("RESOURCE_OWNED"));
    gate.resolve({ shutdownExited: !uncertain, errors: [] }); await until(() => c.stats().cleaning === 0);
    if (uncertain) {
      assert.equal(claimFor(c, run), claim); assert.equal(lease.closes, 0);
      assert.equal(c.stats().cleanup_uncertain, true);
      assert.equal((await c.shutdown(20)).closed, false); owner.assertHeld();
    } else {
      assert.equal(c.claims.size, 0); assert.equal(lease.closes, 1);
      assert.equal(c.view(run.run_id).resident, false);
    }
  });
}

for (const status of ["completed", "needs_input"]) {
  test(`optional receipt diagnostic preserves a normal history end and ${status} outcome`, serial, async t => {
    const ends = [], dispatch = dispatchPort();
    const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch }, history: port => ({
      begin: async run => ({ ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }),
      finish: async (ref, outcome, output, usage, receipt, onReceiptRejected) => {
        assert.equal(typeof onReceiptRejected, "function");
        assert.deepEqual(receipt.checks, ["focused"]);
        assert.equal(receipt.outcome.status, outcome.status);
        const before = structuredClone(outcome);
        assert.doesNotThrow(() => onReceiptRejected());
        assert.doesNotThrow(() => onReceiptRejected(), "duplicate rejection feedback is deduplicated");
        assert.deepEqual(outcome, before, "receipt feedback cannot rewrite the outcome sent to history");
        const end = { ...ref, end_entry_id: "bbbbbbbb" };
        ends.push({ end, outcome: before, output, usage });
        return end;
      },
    }) });
    const run = await c.submit("receipt", task("receipt", { dispatch: { ownership: ["x"], checks: ["focused"] } }));
    await until(() => ports[0]?.streaming);
    if (status === "needs_input") await ask(ports[0]);
    ports[0].finish("normal final report"); await ended(c, run);
    const view = c.view(run.run_id);
    assert.equal(view.status, status); assert.equal(view.outcome.status, status);
    assert.equal(view.outcome.reason, undefined);
    assert.deepEqual(view.cleanup_errors, ["VALIDATION_RECEIPT_INVALID"]);
    assert.equal(view.history_ref.end_entry_id, "bbbbbbbb"); assert.equal(view.history_error, undefined);
    assert.equal(ends.length, 1); assert.deepEqual(ends[0].outcome, view.outcome);
    assert.equal(c.getResult(run.run_id).text, "normal final report");
    assert.equal(ports[0].disposed, 0);
    assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined);
    if (status === "needs_input") {
      assert(view.question_id); assert.equal(c.claims.size, 1);
      const answer = await c.answer("receipt-answer", run.agent_id, view.question_id, "continue");
      await until(() => ports[0].calls.length === 2);
      ports[0].finish("answered"); await ended(c, answer);
      assert.equal(c.view(answer.run_id).status, "completed"); assert.equal(c.claims.size, 0);
      assert.equal(ends.length, 2, "the answer has its own normal history boundary/end");
    } else {
      assert.equal(view.resumable, true); assert.equal(c.claims.size, 0);
    }
  });
}

for (const boundary of ["settlement", "idle release"]) test(`tree claim release failure invalidates presentation through ${boundary}`, serial, async t => {
  let revisionAtFailure;
  const lease = { assertHeld() {}, close() {
    revisionAtFailure = c.presentationRevision;
    throw new Error("synthetic tree close uncertainty");
  } };
  const dispatch = dispatchPort({ start: () => ({ lease }) });
  const { controller: c, ports } = await memoryFixture(t, {
    cleanupUncertainExpected: true, controller: { dispatch },
  });
  const run = await c.submit("release-presentation", task("release presentation", {
    dispatch: { ownership: ["output"], tree: "build" },
  }));
  await until(() => ports[0]?.streaming);
  if (boundary === "idle release") await ask(ports[0]);
  ports[0].finish("execution complete"); await ended(c, run);
  if (boundary === "idle release") {
    assert.equal(revisionAtFailure, undefined, "a pending question retains its claim");
    assert.equal(c.view(run.run_id).status, "needs_input");
    await c.release(run.agent_id);
  }
  assert.equal(typeof revisionAtFailure, "number", "the failing close actually ran");
  assert(c.presentationRevision > revisionAtFailure, "the caller wakes presentation after the synchronous failure");
  assert.equal(c.stats().cleanup_uncertain, true);
  const row = c.list()[0];
  assert.equal(row.owner_blocked, true);
  assert.equal(row.unavailable_reason, "owner_cleanup_uncertain");
  assert.equal(row.resident, true);
  assert.match(row.cleanup_errors.join("\n"), /TREE_RELEASE_FAILED/);
});

test("tree lease close failure is sticky even when a later close would no-op and SDK cleanup succeeds", serial, async t => {
  const lease = { closes: 0, assertHeld() {}, close() {
    this.closes++;
    if (this.closes === 1) throw new Error("tree close result uncertain");
    // Deliberately no-op on subsequent calls: retry must not erase uncertainty.
  } };
  const dispatch = dispatchPort({ start: () => ({ lease }) });
  const { controller: c, ports, owner } = await memoryFixture(t, {
    cleanupUncertainExpected: true, controller: { dispatch },
  });
  const run = await c.submit("close-failure", task("close failure", { dispatch: { ownership: ["x"], tree: "build" } }));
  await until(() => ports[0]?.streaming);
  const claim = claimFor(c, run);
  ports[0].finish("execution complete"); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "completed", "execution completion is separate from resource release uncertainty");
  assert.equal(lease.closes, 1); assert.equal(claim.releaseFailed, true);
  assert.equal(claimFor(c, run), claim); assert.equal(claim.lease, lease);
  assert.equal(c.claims.size, 1); assert.equal(c.view(run.run_id).resident, true);
  assert.equal(c.stats().cleanup_uncertain, true);
  assert.match(c.view(run.run_id).cleanup_errors.join("\n"), /TREE_RELEASE_FAILED/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await c.shutdown(20);
    assert.equal(report.closed, false); assert.equal(report.cleanup_uncertain, true);
    assert.equal(report.resident, 1); assert.equal(report.active + report.finalizing + report.cleaning, 0);
    assert.equal(ports[0].disposed, 1, "SDK disposal succeeds once but cannot confirm the independent tree resource");
    assert.equal(c.agents.get(run.agent_id).cleanupComplete, true);
    assert.equal(c.view(run.run_id).resident, true);
    assert.equal(claim.releaseFailed, true); assert.equal(claimFor(c, run), claim);
    assert.equal(claim.lease, lease); assert.equal(c.claims.size, 1);
    assert.equal(lease.closes, 1, "shutdown never retries the failed close, even if retry would report no error");
    assert.equal(owner.closes, 0); owner.assertHeld();
  }
});

test("confirmed execution exit does not release claims/lease before history finalization", serial, async t => {
  const gate = deferred(), lease = treeLease(), dispatch = dispatchPort({ start: () => ({ lease }) });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch }, history: port => ({
    begin: async run => ({ ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }),
    finish: async ref => { await gate.promise; return { ...ref, end_entry_id: "bbbbbbbb" }; },
  }) });
  t.after(() => gate.resolve());
  const run = await c.submit("finalize", task("finalize", { dispatch: { ownership: ["out"], tree: "build" } }));
  await until(() => ports[0]?.streaming);
  ports[0].finish(); await until(() => c.stats().finalizing_waits?.some(wait => wait.wait === "history"));
  const claim = claimFor(c, run);
  assert.equal(c.view(run.run_id).execution_exited, true); assert.equal(c.stats().active, 0);
  assert.equal(c.view(run.run_id).finalization_pending, true); assert.equal(lease.closes, 0);
  await assert.rejects(c.submit("steal-finalizing", task("steal", { dispatch: { ownership: ["out"] } })), errorCode("RESOURCE_OWNED"));
  assert.equal(claimFor(c, run), claim);
  gate.resolve(); await ended(c, run);
  assert.equal(c.claims.size, 0); assert.equal(lease.closes, 1);
});

test("late observation after cancellation opens no session and closes the late tree lease", serial, async t => {
  const observation = deferred(), lease = treeLease();
  const dispatch = dispatchPort({ start: () => observation.promise });
  const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
  t.after(() => observation.resolve({ lease }));
  const run = await c.submit("late", task("late", { dispatch: { tree: "build", checks: ["focused"] } }));
  await until(() => dispatch.starts.length === 1);
  c.cancel(run.run_id);
  assert.equal(c.stats().active, 1); assert.equal(c.claims.size, 1); assert.equal(ports.length, 0);
  assert.equal((await c.shutdown(5)).closed, false, "an outstanding observation is tracked execution");
  observation.resolve({ lease, source_state: { state: "unknown", reason: "fixture" } });
  await ended(c, run);
  assert.equal(ports.length, 0); assert.equal(lease.closes, 1); assert.equal(c.claims.size, 0);
  assert.equal(c.view(run.run_id).status, "cancelled");
  assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined);
  assert.equal((await c.shutdown(1000)).closed, true);
});

test("optional start observation rejection records notes but does not poison Owner or strand claims", serial, async t => {
  // Each note names what stayed unconfirmed, not the tree/no-tree guess at why.
  for (const [declaration, expected] of [
    [{ tree: "build", checks: ["unit"] }, ["tree_lock_unknown", "source_state_unknown"]],
    [{ tree: "build" }, ["tree_lock_unknown"]],
    [{ checks: ["unit"] }, ["source_state_unknown"]],
  ]) {
    const dispatch = dispatchPort({ start: async () => { throw new Error("optional capture failed"); } });
    const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
    const run = await c.submit("optional", task("optional", { dispatch: declaration }));
    await until(() => ports[0]?.streaming);
    assert.deepEqual(c.view(run.run_id).dispatch_notes, expected, JSON.stringify(declaration));
    ports[0].finish(); await ended(c, run);
    assert.equal(c.view(run.run_id).status, "completed"); assert.equal(c.claims.size, 0);
    assert.equal(c.stats().cleanup_uncertain, false); assert.equal(c.stats().internal_error, undefined);
  }
});

test("model observations show only tree_shared; private hidden notes never spend reply budget", serial, async t => {
  // One settled Agent per Owner, so no other task's finished row shares the
  // envelope. Each "\0" costs seven bytes there, so a page that exactly fills
  // the byte cap leaves less room than any note would take.
  const settledWith = async notes => {
    const dispatch = dispatchPort({ start: async () => ({ notes }) });
    const { controller: c, ports } = await memoryFixture(t, { controller: { dispatch } });
    const run = await c.submit("noted", task("noted", { name: "otter", dispatch: { tree: "build" } }));
    await until(() => ports[0]?.streaming);
    ports[0].finish("\0".repeat(12_000)); await ended(c, run);
    const read = async max_chars => envelope(await c.observe({ kind: "read", agent_id: run.agent_id, max_chars }, { validate() {} }));
    return { c, run, read };
  };
  const hidden = await settledWith(["tree_lock_unknown", "source_state_unknown"]);
  assert.deepEqual(hidden.c.view(hidden.run.run_id).dispatch_notes, ["tree_lock_unknown", "source_state_unknown"],
    "the Run keeps every note for the host");
  const saturated = await hidden.read(16_384);
  assert.equal(saturated.response_limit_reached, true, "the full result cannot fit");
  const fill = saturated.agents[0].result.length;
  const exact = await hidden.read(fill);
  assert.equal(exact.agents[0].result.length, fill);
  assert.equal(exact.response_limit_reached, undefined, "hidden notes do not compete for the remaining bytes");
  assert.equal(Object.hasOwn(exact.agents[0], "dispatch_notes"), false);

  const shown = await settledWith(["tree_shared", "tree_lock_unknown"]);
  assert.deepEqual((await shown.read(100)).agents[0].dispatch_notes, ["tree_shared"]);
  const crowded = await shown.read(fill);
  assert.equal(crowded.agents[0].result.length, fill);
  assert.equal(crowded.response_limit_reached, true, "a note that reaches packing and cannot fit does set the flag");
  assert.equal(Object.hasOwn(crowded.agents[0], "dispatch_notes"), false);
});
