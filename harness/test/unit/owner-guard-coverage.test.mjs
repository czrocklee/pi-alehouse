import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { HarnessError, ParentHistoryError } from "../../dist/core/ports.js";
import { questionId } from "../../dist/core/question-id.js";
import { addToLedger, emptyLedger } from "../../dist/core/usage-ledger.js";
import { fixture, task, tick, until } from "../support/controller-fixture.mjs";

// Source inventory proves classification completeness, NOT that the chosen
// classifications are correct or that arbitrary projections are effect-free.
// Real Owner/scheduler/lease; controlled SessionPort, no SDK/provider evidence.
const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
function sourceSurface(url, declarationName) {
  const source = ts.createSourceFile(fileURLToPath(url), readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.filter((node) =>
    (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === declarationName);
  assert.equal(declarations.length, 1, `Find exactly one ${declarationName}`);
  const declaration = declarations[0];
  assert.equal(declaration.heritageClauses?.length ?? 0, 0, "Review inherited API inventory");
  const entries = new Map();
  for (const member of declaration.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (!ts.isParameterPropertyDeclaration(parameter, member)) continue;
        assert(hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) || hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword),
          "Review public constructor parameter properties");
      }
      continue;
    }
    if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(member, ts.SyntaxKind.ProtectedKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) continue;
    // Optional callbacks count too. Fields/setters/overloads/non-identifier
    // names must demand explicit review, rather than disappear from discovery.
    const shape = ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? "method" :
      ts.isGetAccessorDeclaration(member) ? "getter" : undefined;
    assert(shape, `Review public member shape: ${member.getText(source)}`);
    assert(member.name && ts.isIdentifier(member.name), "Review non-identifier API names");
    const name = member.name.text;
    assert(!entries.has(name), `Review duplicate/overloaded API: ${name}`);
    entries.set(name, { shape, async: hasModifier(member, ts.SyntaxKind.AsyncKeyword) });
  }
  return entries;
}
function assertCoverage(surface, cases) {
  assert.deepEqual([...surface.keys()].sort(), Object.keys(cases).sort(),
    "Every public entry needs an explicit classification and invocation case");
  for (const [name, entry] of surface) {
    const specimen = cases[name];
    assert(["effect", "gate", "projection"].includes(specimen.kind), `${name}: explicit classification`);
    assert.equal(specimen.shape ?? "method", entry.shape, `${name}: member shape`);
    if (entry.shape === "method") assert.equal(typeof specimen.args, "function", `${name}: argument factory`);
    if (specimen.kind === "projection") assert.equal(typeof specimen.check, "function", `${name}: positive check`);
    else {
      assert.equal(entry.shape, "method");
      assert.equal(entry.async, false, `${name} needs a synchronous facade`);
    }
  }
}

// This ONE name-keyed matrix also determines the actual member invoked below.
// In particular, submitPrepared cannot accidentally exercise submit instead.
const ownerCases = {
  bindModelCommunication: { kind: "effect", args: () => [] },
  latchParentHistoryFailure: { kind: "effect", args: () => [new ParentHistoryError("forbidden")] },
  assertOwnerAvailable: { kind: "effect", args: () => [] },
  submit: { kind: "effect", args: () => ["forbidden-submit", task("forbidden", { name: "orca" })] },
  submitPrepared: { kind: "effect", args: (f) => ["forbidden-prepared", task("forbidden", { name: "orca" }), f.prepareRequest,
    { settle: { agent_id: f.run.agent_id, ms: 1 } }] },
  answer: { kind: "effect", args: (f) => ["forbidden-answer", f.run.agent_id,
    questionId(f.c.identity.owner_id, f.c.identity.generation, f.run.run_id), "forbidden", { prepare: f.prepareVoid }] },
  steer: { kind: "effect", args: (f) => [f.run.run_id, "forbidden"] },
  send: { kind: "effect", args: (f) => ["forbidden-send", f.run.agent_id, "forbidden", { prepare: f.prepareVoid }] },
  cancel: { kind: "effect", args: (f) => [f.run.run_id] },
  drainUsage: { kind: "effect", args: () => [] },
  returnUsage: { kind: "effect", args: () => [ledger()] },
  waitForRuns: { kind: "effect", args: (f) => [[f.run.run_id], { mode: "all", timeout_ms: 1 }] },
  observe: { kind: "effect", args: (f) => [{ kind: "read", agent_id: f.run.agent_id }, { validate: f.nestedRead }] },
  release: { kind: "effect", args: (f) => [f.run.agent_id] },
  kill: { kind: "effect", args: (f) => [f.run.agent_id, 1] },
  shutdown: { kind: "effect", args: () => [1] },
  assertEffectAllowed: { kind: "gate", args: () => [] },
  validateObservationEntry: { kind: "gate", args: (f) => [f.nestedRead] },
  view: { kind: "projection", args: (f) => [f.run.run_id], check: (value, f) => {
    assert.equal(value.run_id, f.run.run_id); assert.equal(value.status, "running");
  } },
  agentSummary: { kind: "projection", args: (f) => [f.run.agent_id], check: (value, f) => {
    assert.equal(value.agent_id, f.run.agent_id); assert.equal(value.runs, 1);
  } },
  findAgent: { kind: "projection", args: () => ["otter"], check: (value, f) => {
    assert.deepEqual(value, { agent_id: f.run.agent_id, run_id: f.run.run_id });
  } },
  agentName: { kind: "projection", args: (f) => [f.run.agent_id], check: (value) => assert.equal(value, "otter") },
  list: { kind: "projection", args: () => [{ include_released: true }], check: (value, f) => {
    assert.deepEqual(value.map(({ run_id }) => run_id), [f.run.run_id]);
  } },
  stats: { kind: "projection", args: () => [], check: (value) => {
    assert.equal(value.runs, 1); assert.equal(value.active, 1); assert.equal(value.internal_error, undefined);
    assert.equal(value.unreported_usage.total.cost, 0.25);
  } },
  getResult: { kind: "projection", args: (f) => [f.run.run_id, { limit: 16 }], check: (value, f) => {
    assert.equal(value.snapshot.run_id, f.run.run_id); assert.equal(value.text, ""); assert.equal(value.complete, false);
  } },
  identity: { kind: "projection", shape: "getter", check: (value, f) => {
    assert.deepEqual(value, { owner_id: f.owner.owner_id, generation: f.owner.generation });
  } },
  hasAcceptedRuns: { kind: "projection", shape: "getter", check: (value) => assert.equal(value, true) },
};
const callbackCases = {
  inputEntered: { kind: "effect", args: () => [] },
  output: { kind: "effect", args: () => [{ text: "forbidden", total_chars: 9, truncated: false }] },
  runtime: { kind: "effect", args: () => [{ activity: "tool", usage: ledger() }] },
  drain: { kind: "effect", args: () => ["deliveries"] },
  turnStart: { kind: "effect", args: () => [] },
  turnEnd: { kind: "effect", args: () => [true] },
  question: { kind: "effect", args: () => ["forbidden?"] },
  alert: { kind: "effect", args: () => ["forbidden"] },
  touched: { kind: "effect", args: () => ["forbidden.txt"] },
};
const surfaces = [
  { label: "OwnerController", surface: sourceSurface(new URL("../../src/core/owner-controller.ts", import.meta.url), "OwnerController"),
    cases: ownerCases, receiver: (f) => f.c },
  { label: "RunCallbacks", surface: sourceSurface(new URL("../../src/core/ports.ts", import.meta.url), "RunCallbacks"),
    cases: callbackCases, receiver: (f) => f.port.callbacks },
];
test("source API inventory exactly matches the explicit guard classification and dynamic cases", () => {
  for (const { surface, cases } of surfaces) assertCoverage(surface, cases);
});

function ledger() {
  return addToLedger(emptyLedger(), { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.25 }, "fixture/controlled");
}
async function guardFixture(t) {
  const f = await fixture(t);
  const c = f.controller;
  // Nonzero residue detects destructive drain AND an illicit return/merge.
  c.returnUsage(ledger());
  const run = await c.submit("guard-running", task("guard-running", { name: "otter", max_turns: 1 }));
  await until(() => f.ports[0]?.streaming);
  const spies = { prepare: 0, nestedRead: 0 };
  return { ...f, c, run, port: f.ports[0], spies,
    prepareRequest: (request) => { spies.prepare++; return request; },
    prepareVoid: () => { spies.prepare++; },
    nestedRead: () => { spies.nestedRead++; },
  };
}
const pick = (value, names) => Object.fromEntries(names.split(" ").map((name) => [name, value[name]]));
function stableState(f) {
  const view = f.c.view(f.run.run_id), retained = f.c.runs.get(f.run.run_id);
  // Inspect selected stable facts only, never compare evolving clock fields or
  // mutate private Runs. Include facts projections intentionally do not expose.
  return {
    stats: pick(f.c.stats(), "active queued resident agents runs requests retained_output_chars reserved_output_chars unreported_usage finalizing parent_error internal_error cleanup_uncertain cleaning closed"),
    run: pick(view, "status phase execution_exited finalization_pending resident unavailable_reason owner_error owner_blocked turns stop_reason outcome usage runtime cleanup_errors discarded_inputs has_question question_id pending_messages delivered_updates"),
    drain: view.drain?.waiting_for,
    result: pick(f.c.getResult(f.run.run_id), "text truncated retained_chars total_chars"),
    agent: pick(f.c.agentSummary(f.run.agent_id), "runs touched touched_omitted pending_updates observed_cost cost_partial"),
    question: retained.question, finished_presented: retained.finished_presented,
    input_entered: retained.record.input_entered, input_count: retained.inputCount, pending_inputs: retained.inputs.size,
    alerts: f.c.alerts.map(({ run, message }) => ({ run_id: run.record.run_id, message })),
    model_communication: f.c.modelCommunication, closing: f.c.closing, reported_block: f.c.reportedBlock,
    ports: f.ports.map((port) => ({ calls: port.calls.length, inputs: [...port.inputs], stopped: port.stopped,
      disposed: port.disposed, streaming: port.streaming })),
    events: f.events.length,
  };
}
function withWake(before, f, message) {
  return { ...before, run: { ...before.run, pending_messages: before.run.pending_messages + 1 },
    alerts: [...before.alerts, { run_id: f.run.run_id, message }] };
}
const hasCode = (code) => (error) => {
  assert(error instanceof HarnessError); assert.equal(error.code, code); assert.equal(error.details.phase, "validation");
  return true;
};
const sinkPromise = (value) => { if (value instanceof Promise) void value.catch(() => {}); };
function invocation(receiver, name, specimen, f, tripwire) {
  // JavaScript caller-side argument evaluation is outside the guard's remit.
  // All argument construction and wrapping happen BEFORE the source phase.
  const args = specimen.shape === "getter" ? [] : specimen.args(f);
  const inspected = [];
  const guardedArgs = tripwire ? args.map((arg, index) => {
    if (arg === null || typeof arg !== "object") return arg;
    const trap = (kind) => () => { inspected.push({ index, kind }); throw new Error("ARGUMENT_INSPECTED_BEFORE_GUARD"); };
    return new Proxy(arg, { get: trap("get"), ownKeys: trap("ownKeys"),
      getOwnPropertyDescriptor: trap("getOwnPropertyDescriptor"), getPrototypeOf: trap("getPrototypeOf") });
  }) : args;
  return { inspected, invoke: specimen.shape === "getter" ? () => Reflect.get(receiver, name) :
    () => Reflect.apply(receiver[name], receiver, guardedArgs) };
}
function swallowedAttempt(invoke) {
  const noReturn = Symbol("no return"), state = { calls: 0, returned: noReturn, error: undefined };
  return { state, attempt() {
    state.calls++;
    try { state.returned = invoke(); } catch (error) { state.error = error; }
    sinkPromise(state.returned); // Sink an accidentally async facade's rejection on regression.
  }, check() {
    assert.equal(state.calls, 1, "attempt ran only in the intended validation phase");
    assert.equal(state.returned, noReturn, "must throw synchronously, before returning even a Promise");
    assert(hasCode("OBSERVATION_REENTRANCY")(state.error));
  } };
}
const waitRequest = (f) => ({ kind: "wait", agent_ids: [f.run.agent_id], wait_ms: 3000 });
function watch(f, signal, validate = () => {}) {
  const result = f.c.observe(waitRequest(f), { validate, signal });
  sinkPromise(result);
  return result;
}
function lifecycleWatch(f, signal) {
  const state = { settled: false };
  const result = f.c.waitForRuns([f.run.run_id], { mode: "all", timeout_ms: 3000, signal });
  sinkPromise(result);
  void result.then(() => { state.settled = true; }, () => { state.settled = true; });
  return { result, state };
}
function envelope(result) {
  assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}
async function completeNormally(f, lifecycle) {
  assert.equal(lifecycle.state.settled, false, "observer failure must not complete or abort child lifecycle work");
  assert.doesNotThrow(() => f.port.finish("normal after rejected reentry"));
  assert.equal(await lifecycle.result, "ready");
  assert.equal(f.c.view(f.run.run_id).status, "completed");
  assert.equal(f.c.view(f.run.run_id).phase, "settled");
  const stats = f.c.stats();
  assert.equal(stats.active, 0); assert.equal(stats.finalizing, 0);
  assert.equal(stats.internal_error, undefined); assert.equal(stats.parent_error, undefined);
  assert.equal(stats.cleanup_uncertain, false);
}

for (const { label, cases, receiver } of surfaces) for (const [name, specimen] of Object.entries(cases)) {
  if (specimen.kind === "projection") continue;
  for (const phase of ["ENTRY", "READY"]) for (const tripwire of [false, true])
    test(`${label}.${name} (${specimen.kind}) rejects swallowed ${phase} reentry before effects${tripwire ? " or object inspection" : ""}`, async (t) => {
      const abort = new AbortController(); t.after(() => abort.abort());
      const f = await guardFixture(t), before = stableState(f);
      const { invoke, inspected } = invocation(receiver(f), name, specimen, f, tripwire);
      const swallowed = swallowedAttempt(invoke), message = "accepted wake for healthy peer";
      const readyState = withWake(before, f, message);
      let armed = false, validations = 0, peerReadyChecks = 0;
      let rejected;
      if (phase === "READY") {
        const origin = watch(f, abort.signal, () => { validations++; if (armed) swallowed.attempt(); });
        rejected = assert.rejects(origin, hasCode("OBSERVATION_REENTRANCY"));
        assert.equal(validations, 1, "only entry validation ran; origin is still registered, not READY");
      }
      const peer = watch(f, abort.signal, () => {
        if (!armed) return;
        peerReadyChecks++;
        assert.deepEqual(stableState(f), readyState, "failed origin must not consume the real alert or change retained facts");
      });
      const lifecycle = lifecycleWatch(f, abort.signal);
      if (phase === "ENTRY") {
        assert.throws(() => {
          const unexpected = f.c.observe({ kind: "read", agent_id: f.run.agent_id }, { validate: swallowed.attempt });
          sinkPromise(unexpected);
        }, hasCode("OBSERVATION_REENTRANCY"));
        swallowed.check();
        await tick();
        assert.deepEqual(stableState(f), before, "entry rejected before any work, including deferred effects");
      } else {
        await tick();
        assert.equal(validations, 1, "non-ready drains must not run registered validation");
        assert.equal(swallowed.state.calls, 0);
      }
      armed = true;
      assert.doesNotThrow(() => f.port.callbacks.alert(message), "accepted child wake must not inherit origin failure");
      if (rejected) await rejected;
      swallowed.check();
      const published = envelope(await peer);
      assert.equal(published.reason, "alert"); assert.deepEqual(published.alerts.map(({ message }) => message), [message]);
      assert.equal(peerReadyChecks, 1, "already registered peer publishes normally");
      await tick();
      assert.deepEqual(stableState(f), before, "after healthy peer consumes its real wake, no forbidden effects remain");
      assert.deepEqual(inspected, [], "guard precedes all object argument getters/reflection");
      assert.deepEqual(f.spies, { prepare: 0, nestedRead: 0 });
      await completeNormally(f, lifecycle);
      if (phase === "READY") assert.equal(validations, 2, "rejected origin detached and never retried on lifecycle wake");
      if (label === "OwnerController" && name === "bindModelCommunication") {
        // Prove through public behavior (not merely stats/private flags) that
        // the rejected binding did not secretly restrict this generic Owner.
        // Peer publication and the original lifecycle are finished first.
        for (const [index, genericName] of [undefined, "🦦 調査"].entries()) {
          const generic = await f.c.submit(`generic-binding-check-${index}`,
            task("generic control", genericName === undefined ? {} : { name: genericName }));
          assert.equal(generic.name, genericName ?? "", "unnamed/Unicode generic submissions must still be accepted");
          await until(() => f.ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === generic.run_id));
          f.ports.find((port) => port.calls.at(-1)?.identity.run_id === generic.run_id).finish("normal generic control");
          assert.equal(await f.c.waitForRuns([generic.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
          assert.equal(f.c.view(generic.run_id).status, "completed");
        }
      }
      assert.deepEqual(inspected, []); assert.deepEqual(f.spies, { prepare: 0, nestedRead: 0 });
    });
}

for (const { label, cases, receiver } of surfaces) for (const [name, specimen] of Object.entries(cases)) {
  if (specimen.kind !== "projection") continue;
  for (const phase of ["ENTRY", "READY"]) test(`${label}.${name} projection succeeds in ${phase} readonly validation without consuming facts`, async (t) => {
    const abort = new AbortController(); t.after(() => abort.abort());
    const f = await guardFixture(t);
    const { invoke } = invocation(receiver(f), name, specimen, f, false);
    const before = stableState(f), message = "retained during projection";
    const readyState = withWake(before, f, message);
    let value, calls = 0, armed = false;
    const project = () => { calls++; value = invoke(); };
    if (phase === "ENTRY") {
      f.port.callbacks.alert(message);
      assert.doesNotThrow(() => f.c.validateObservationEntry(project));
      await tick();
      assert.deepEqual(stableState(f), readyState, "projection must not acknowledge even a retained alert");
    } else {
      const origin = watch(f, abort.signal, () => {
        if (!armed) return;
        project();
        assert.deepEqual(stableState(f), readyState, "projection ran before publication with all facts intact");
      });
      assert.equal(calls, 0, "positive case runs only after registration becomes READY");
      armed = true; f.port.callbacks.alert(message);
      assert.equal(envelope(await origin).reason, "alert");
      await tick();
      assert.deepEqual(stableState(f), before, "only ordinary publication consumed the wake");
    }
    assert.equal(calls, 1); specimen.check(value, f);
    assert.deepEqual(f.spies, { prepare: 0, nestedRead: 0 });
  });
}

test("AgentSessionPort.canInput is a separate pure port projection, not a RunCallback", async (t) => {
  const f = await guardFixture(t);
  f.port.callbacks.alert("retained while checking input availability");
  const before = stableState(f);
  assert.equal(f.c.validateObservationEntry(() => f.port.canInput()), true);
  await tick();
  assert.deepEqual(stableState(f), before);
});
