import assert from "node:assert/strict";
import test from "node:test";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { PiRunJournal as SdkRunHistory } from "../../dist/history/run-journal.js";
import { SessionUnavailableError } from "../../dist/core/ports.js";
import { deferred, ended, fixture, task, until } from "../support/controller-fixture.mjs";

/**
 * The narrowest AgentSession the port needs to complete one Run. `prompt()`
 * replays the assistant messages a provider would have streamed back, which is
 * the only place per-response spend is ever seen.
 */
const stubSession = (messages) => {
  const listeners = new Set();
  const emit = (event) => { for (const listener of [...listeners]) listener(event); };
  return {
    sessionId: "stub-session",
    isIdle: true,
    isStreaming: false,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    listenerCount: () => listeners.size,
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    waitForIdle: async () => {},
    abort: async () => {},
    prompt: async () => {
      for (const message of messages) {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], ...message } });
      }
    },
  };
};
test("the child warming veto is unconditional in every Run state, and touches no settings", () => {
  const gate = new RunInputGate(), handlers = new Map(), registered = [];
  // Only `on` is provided: a guard that tried to persist a global settings
  // change instead of vetoing per decision would throw here.
  gate.extension({ on: (name, handler) => { registered.push(name); handlers.set(name, handler); } });
  assert.deepEqual(registered.filter((name) => name === "cache_warming_decision"), ["cache_warming_decision"],
    "exactly one decision handler, registered unconditionally at bind time");
  const decide = handlers.get("cache_warming_decision"); assert.equal(typeof decide, "function");
  // Set both flags directly to cover all four combinations, including the
  // not-accepting/not-stopped state a resident idle Agent sits in and the
  // accepting/stopped pair that is only transient in a real Run.
  for (const accepting of [false, true]) for (const stopped of [false, true]) {
    gate.accepting = accepting; gate.stopped = stopped;
    for (const action of ["warm", "stop"]) {
      const event = { type: "cache_warming_decision", action, warmCost: 0.01, missCost: 1, continuationProbability: 1 };
      assert.deepEqual(decide(event), { action: "stop" }, `accepting=${accepting} stopped=${stopped} action=${action}`);
      assert.equal(event.action, action, "only a child-local result, not shared event mutation");
    }
  }
  // Nothing about the veto may depend on Run bookkeeping.
  assert.deepEqual(gate.observations, []);
  assert.equal(gate.tickets.size, 0);
});

const silentCallbacks = () => ({ inputEntered() {}, output() {}, turnStart() {}, turnEnd() {}, question() {}, notify() {} });
const run = async (messages) => {
  const gate = new RunInputGate();
  const port = new SdkRunPort({ session: stubSession(messages), parentBus: { emit() {} }, gate, readiness: () => {} });
  return await port.run("go", silentCallbacks());
};
const priced = (cost) => ({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });

for (const [label, started, result] of [
  ["priced", true, { usage: priced(0.5) }],
  ["missing usage", true, { summary: "summary without billing" }],
  ["failed", true, undefined],
  ["unpaired end", false, { usage: priced(0.5) }],
]) test(`compaction accounting pairs start/end explicitly: ${label}`, async () => {
  const session = stubSession([{ provider: "p", model: "m", usage: priced(2) }]);
  session.model = { provider: "p", id: "m" };
  const subscribe = session.subscribe, prompt = session.prompt; let emit;
  session.subscribe = (listener) => { emit = listener; return subscribe(listener); };
  session.prompt = async () => {
    await prompt();
    if (started) emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
  };
  const port = new SdkRunPort({ session, gate: new RunInputGate(), parentBus: { emit() {} }, readiness() {} });
  const facts = await port.run("go", silentCallbacks());
  assert.equal(facts.kind, "success"); assert.equal(facts.output.text, "ok"); assert.equal(facts.model_stop_reason, "stop");
  assert.equal(facts.usage.byModel["p/m"].cost, 2);
  if (started) {
    assert.equal(facts.usage.byModel["compaction/p/m"].cost, result?.usage ? 0.5 : 0);
    assert.deepEqual(facts.usage.partial, result?.usage ? [] : ["input", "output", "cache_read", "cache_write", "cost"]);
  } else {
    assert.equal(facts.usage.byModel["compaction/p/m"], undefined);
    assert.deepEqual(facts.usage.partial, [], "an unpaired end must not create unknown usage either");
  }
  assert.equal(facts.usage.total.cost, started && result?.usage ? 2.5 : 2);
  assert.equal(session.listenerCount(), 0);
});

test("missing compaction end retains unknown spend and clears retry telemetry before cleanup", async () => {
  let listener, unsubscribed = false;
  const session = { ...stubSession([]), model: { provider: "p", id: "m" },
    subscribe(fn) { listener = fn; return () => { unsubscribed = true; }; },
    async prompt() {
      listener({ type: "compaction_start", reason: "threshold" });
      listener({ type: "summarization_retry_scheduled" });
      throw new Error("synthetic SDK failure without compaction_end");
    } };
  const snapshots = [], port = new SdkRunPort({ session, parentBus: { emit() {} }, gate: new RunInputGate(), readiness: () => {} });
  await assert.rejects(port.run("go", { ...silentCallbacks(), runtime: (snapshot) => snapshots.push(snapshot) }), (error) => {
    assert(error instanceof SessionUnavailableError); assert(error.usage.partial.includes("cost")); return true;
  });
  assert.equal(unsubscribed, true); assert.equal(snapshots.at(-1).activity, "generating");
});

test("final SDK stop reasons are classified explicitly and preserved", async () => {
  for (const [stopReason, kind] of [["stop", "success"], ["toolUse", "success"], ["length", "error"],
    ["pending", "error"], ["deferred", "error"], ["future_reason", "error"]]) {
    const facts = await run([{ provider: "p", model: "m", stopReason, content: [{ type: "text", text: "partial" }] }]);
    assert.equal(facts.kind, kind, stopReason);
    assert.equal(facts.model_stop_reason, stopReason, stopReason);
    assert.equal(facts.output.text, "partial", stopReason);
  }
});

for (const fails of [false, true]) test(`approval is revoked before drain even if revocation throws (${fails})`, async () => {
  const gate = new RunInputGate(), session = stubSession([{ provider: "p", model: "m" }]);
  let revoked = false, drained = false;
  session.waitForIdle = async () => { assert(revoked); assert.equal(gate.accepting, false); drained = true; };
  const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate, readiness() {},
    invalidateApproval() { revoked = true; if (fails) throw new Error("revocation failed"); } });
  if (fails) await assert.rejects(port.run("go", silentCallbacks()), /approval_revocation_failed/);
  else await port.run("go", silentCallbacks());
  assert(drained); assert.equal(session.listenerCount(), 0);
});

test("stop still closes input and aborts when approval revocation throws", async () => {
  const gate = new RunInputGate(), session = stubSession([]);
  gate.accepting = true;
  let aborted = false;
  session.abort = async () => { assert.equal(gate.accepting, false); assert.equal(gate.stopped, true); aborted = true; };
  const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate, readiness() {},
    invalidateApproval() { throw new Error("stop revocation failure"); } });
  await assert.rejects(port.stop(), /approval_revocation_failed/);
  assert(aborted);
  assert.throws(() => port.clearInputs(), /approval_revocation_failed/);
});

for (const synchronous of [false, true]) test(`Controller quarantines a ${synchronous ? "throwing" : "rejecting"} SDK abort until execution exits`, async (t) => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
  const prompt = session.prompt;
  session.prompt = async () => {
    session.isIdle = false; entered.resolve();
    try { await finish.promise; await prompt(); } finally { session.isIdle = true; }
  };
  const failure = new Error("synthetic abort failure");
  session.abort = () => { if (synchronous) throw failure; return Promise.reject(failure); };
  const port = new SdkRunPort({ session, gate: new RunInputGate(), parentBus: { emit() {} }, readiness() {} });
  let disposed = 0;
  port.dispose = async () => {
    assert.equal(session.isIdle, true); disposed++;
    return { shutdownExited: true, errors: [] };
  };
  const { controller: c } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("abort-failure", task("go")); await entered.promise;
  c.cancel(run.run_id);
  await until(() => c.view(run.run_id).cleanup_errors.some((error) => error.includes(failure.message)));
  assert.equal(c.view(run.run_id).execution_exited, false);
  assert.equal(c.stats().active, 1); assert.equal(c.stats().resident, 1);
  assert.equal(disposed, 0, "a failed stop must not prove exit or release the session");
  finish.resolve(); await ended(c, run);
  const settled = c.view(run.run_id);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.unavailable_reason, "stop_uncertain");
  assert.equal(settled.resumable, false); assert.equal(settled.resident, false);
  assert.equal(disposed, 1); assert.equal(c.drainUsage().total.cost, 1);
  await assert.rejects(c.submit("resume", { resume: run.agent_id, prompt: "must not run" }), { code: "AGENT_UNAVAILABLE" });
});

/**
 * A Run is many responses, and a provider may price some and not others. The
 * whole Run's cost used to collapse to null the moment one response arrived
 * unpriced, so a real bill reached the footer as $0.
 */
test("a response that arrives unpriced does not erase what the others billed", async () => {
  const facts = await run([
    { provider: "openai-codex", model: "gpt-5.6-sol", usage: priced(1) },
    { provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { provider: "openai-codex", model: "gpt-5.6-sol", usage: priced(0.25) },
  ]);
  assert.equal(facts.usage.total.cost, 1.25, "every dollar anyone reported is still there");
  assert.equal(facts.usage.total.input, 250, "and so is every token");
  // The gap is remembered rather than papered over: this is a floor, not the bill.
  assert.deepEqual(facts.usage.partial, ["cost"]);
});

/** A router alias is not a model: billing one would make the breakdown lie. */
test("spend is attributed to the model that answered, not to the alias asked for", async () => {
  const facts = await run([
    { provider: "openai-codex", model: "auto", responseModel: "gpt-5.6-sol", usage: priced(1) },
    { provider: "openai-codex", model: "auto", responseModel: "fixture-strong-model", usage: priced(2) },
    { provider: "openai-codex", model: "auto", responseModel: "gpt-5.6-sol", usage: priced(0.5) },
  ]);
  assert.deepEqual(Object.keys(facts.usage.byModel), ["openai-codex/gpt-5.6-sol", "openai-codex/fixture-strong-model"]);
  assert.equal(facts.usage.byModel["openai-codex/gpt-5.6-sol"].cost, 1.5);
  assert.equal(facts.usage.byModel["openai-codex/fixture-strong-model"].cost, 2);
  assert(!Object.keys(facts.usage.byModel).some((key) => key.includes("auto")), "the alias never becomes a row");
  // The split still adds back up to what the host will be billed.
  const summed = Object.values(facts.usage.byModel).reduce((sum, share) => sum + share.cost, 0);
  assert.equal(summed, facts.usage.total.cost);
});

/**
 * The drain in `finally` can fail. If it takes the rest of the block with it,
 * the port never unsubscribes and never stops calling itself active, so every
 * later run(), clearInputs() and dispose() throws and the Agent is dead.
 */
test("a port whose drain fails still lets go of the session it was running", async () => {
  const gate = new RunInputGate();
  const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
  session.waitForIdle = async () => { throw new Error("drain failed"); };
  const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate, readiness: () => {} });
  await assert.rejects(port.run("go", silentCallbacks()), (error) => {
    assert.ok(error instanceof SessionUnavailableError);
    assert.match(error.message, /drain failed/);
    assert.equal(error.usage.total.cost, 1);
    assert.equal(error.usage.byModel["p/m"].cost, 1);
    return true;
  });
  assert.equal(session.listenerCount(), 0);
  assert.equal(gate.accepting, false);
  assert.equal(port.canInput(), false);
  // Active was released, but an uncertain drain must never permit reuse.
  assert.throws(() => port.clearInputs(), SessionUnavailableError);
  await assert.rejects(port.run("again", silentCallbacks()), SessionUnavailableError);
  // dispose() reaches the child teardown instead of refusing at its own guard;
  // the stub has no teardown, which is a different failure from a wedged port.
  const disposed = await port.dispose().then(() => undefined, (error) => String(error));
  assert.ok(!disposed?.includes("EXECUTION_NOT_EXITED"), disposed);
});

for (const failure of ["first clear", "second clear", "seal", "unsubscribe"]) {
  test(`a failure in ${failure} preserves observed spend and quarantines the port`, async () => {
    const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
    const history = { seal() {}, invalidate(error) { this.error ??= String(error); } };
    const broken = () => { throw new Error(failure); };
    if (failure.endsWith("clear")) {
      let calls = 0;
      session.clearQueue = () => {
        // The first clear is the pre-run clearInputs, before there is usage.
        if (++calls === (failure === "first clear" ? 2 : 3)) broken();
        return { steering: [], followUp: [] };
      };
    } else if (failure === "seal") history.seal = broken;
    else {
      const subscribe = session.subscribe;
      session.subscribe = (listener) => {
        const off = subscribe(listener);
        return () => { off(); broken(); };
      };
    }
    const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate: new RunInputGate(), history, readiness() {} });
    await assert.rejects(port.run("go", silentCallbacks()), (error) => {
      assert.ok(error instanceof SessionUnavailableError);
      assert.equal(error.usage.total.cost, 1);
      assert.match(error.message, new RegExp(failure));
      return true;
    });
    assert.equal(session.listenerCount(), 0);
    assert.match(history.error, new RegExp(failure));
    assert.throws(() => port.clearInputs(), SessionUnavailableError, "not the active guard");
  });
}

test("a rejected prompt still carries spend when its drain succeeds", async () => {
  const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
  const prompt = session.prompt;
  session.prompt = async () => { await prompt(); throw new Error("prompt failed"); };
  const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate: new RunInputGate(), readiness() {} });
  await assert.rejects(port.run("go", silentCallbacks()), (error) => {
    assert.ok(error instanceof SessionUnavailableError);
    assert.equal(error.reason, "sdk_error");
    assert.equal(error.usage.total.cost, 1);
    return true;
  });
  assert.equal(session.listenerCount(), 0);
});

test("prompt and drain failures retain both causes and the billed responses", async () => {
  const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
  const prompt = session.prompt, original = new Error("prompt failed"), drain = new Error("drain failed");
  session.prompt = async () => { await prompt(); throw original; };
  session.waitForIdle = async () => { throw drain; };
  const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate: new RunInputGate(), readiness() {} });
  await assert.rejects(port.run("go", silentCallbacks()), (error) => {
    assert.ok(error instanceof SessionUnavailableError);
    assert.equal(error.reason, "sdk_error", "keep the original quarantine reason");
    assert.match(error.message, /prompt failed.*drain failed/);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0].cause, original);
    assert.equal(error.cause.errors[1], drain);
    assert.equal(error.usage.total.cost, 1);
    return true;
  });
});

for (const withHistory of [false, true]) {
  test(`the Controller accounts a drain failure exactly once and releases the unavailable agent (history=${withHistory})`, async (t) => {
    const session = stubSession([{ provider: "p", model: "m", usage: priced(1) }]);
    session.waitForIdle = async () => { throw new Error("drain failed"); };
    // Real history invalidation, with persistence disabled so no disk fixture is
    // needed. Production always carries history, even in an ephemeral session.
    const history = withHistory ? new SdkRunHistory({ parent: { isPersisted: () => false }, session: {} }) : undefined;
    const port = new SdkRunPort({ session, parentBus: { emit() {} }, gate: new RunInputGate(), history, readiness() {} });
    // Only teardown is stubbed: execution, error handling, accounting and release
    // use the real adapter and Controller together.
    let disposed = 0;
    port.dispose = async () => { disposed++; return { shutdownExited: true, errors: [] }; };
    const { controller } = await fixture(t, { controller: { createSession: async () => port } });
    const run = await controller.submit("drain-accounting", task("go"));
    await ended(controller, run);
    const view = controller.view(run.run_id);
    assert.equal(view.status, "failed");
    assert.equal(view.resumable, false);
    assert.equal(view.resident, false);
    // History uncertainty is recorded too; clearInputs reasserts the port's
    // unavailable reason before Controller releases the Agent.
    assert.equal(view.unavailable_reason, "sdk_drain_failed");
    if (withHistory) assert.match(view.history_error, /drain failed/);
    assert.match(view.outcome.error, /sdk_drain_failed.*drain failed/);
    assert.equal(view.usage.total.cost, 1);
    assert.equal(controller.drainUsage().total.cost, 1);
    assert.equal(controller.drainUsage(), undefined);
    assert.equal(disposed, 1);
  });
}

test("a Run whose responses carried no usage at all reports a floor of nothing", async () => {
  const facts = await run([{ provider: "openai-codex", model: "gpt-5.6-sol" }]);
  assert.equal(facts.usage.total.cost, 0);
  assert.deepEqual(facts.usage.partial, ["input", "output", "cache_read", "cache_write", "cost"]);
  // A Run with no assistant response at all owes nothing and says so.
  assert.equal((await run([])).usage, undefined);
});
