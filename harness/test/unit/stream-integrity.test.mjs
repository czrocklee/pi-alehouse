import assert from "node:assert/strict";
import test from "node:test";
import { PiAgentSessionAdapter, ChildRunGate } from "../../dist/runtime/agent-session.js";
import { USAGE_COMPONENTS } from "../../dist/core/usage-ledger.js";
import { ended, fixture, task } from "../support/controller-fixture.mjs";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const pricedUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
const message = (text, stopReason = "stop", usage = zeroUsage) => ({ role: "assistant", provider: "p", model: "m",
  stopReason, content: [{ type: "text", text }], usage });
function adapter(events, outputChars, { gate = new ChildRunGate(), abort = async () => {}, invalidateApproval } = {}) {
  let listener;
  const session = { sessionId: "stream-fixture", isIdle: true, isStreaming: false,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    clearQueue: () => ({ steering: [], followUp: [] }), getSteeringMessages: () => [], getFollowUpMessages: () => [],
    async waitForIdle() {}, abort, async prompt() {
      listener({ type: "message_end", message: { role: "user" } });
      for (const event of events) listener(event);
    } };
  const port = new PiAgentSessionAdapter({ session, gate, parentBus: { emit() {} }, readiness() {}, outputChars, invalidateApproval });
  port.dispose = async () => ({ shutdownExited: true, errors: [] });
  return port;
}
const start = { type: "message_start", message: { role: "assistant" } };
const delta = (text) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });

for (const [cap, chunks, text, expected] of [
  [2, ["a\ud83d", "\ude80z"], "a🚀z", "a"],
  [3, ["a\ud83d", "", "\ude80"], "a🚀", "a🚀"],
  [1, ["\ud83d", "\ude80", "z"], "🚀z", ""],
  [4, ["a", "\ud83d", "\ude80z"], "a🚀z", "a🚀z"],
]) test(`split surrogate stream keeps a stable prefix at cap ${cap}`, async (t) => {
  const port = adapter([start, ...chunks.map(delta), { type: "message_end", message: message(text) }], cap);
  const { controller: c } = await fixture(t, { controller: { output_chars: cap, createSession: async () => port } });
  const run = await c.submit("unicode", task("unicode")); await ended(c, run);
  const page = c.getResult(run.run_id);
  assert.equal(page.snapshot.status, "completed"); assert.equal(page.snapshot.resumable, true);
  assert.deepEqual(page.snapshot.cleanup_errors, []);
  assert.equal(page.text, expected); assert.equal(page.total_chars, text.length);
  assert.equal(page.retained_chars, expected.length); assert.equal(page.truncated, expected !== text);
  assert.equal(page.complete, expected === text);
});

test("provisional surrogate holdback reports truncation only until the pair arrives", async () => {
  const observed = [];
  const port = adapter([start, delta("a\ud83d"), delta("\ude80"),
    { type: "message_end", message: message("a🚀") }], 3);
  await port.run("go", { inputEntered() {}, turnStart() {}, turnEnd() {}, output(value) { observed.push(value); } });
  assert.deepEqual(observed[1], { text: "a", total_chars: 2, truncated: true, revision: 1 });
  assert.deepEqual(observed[2], { text: "a🚀", total_chars: 3, truncated: false, revision: 1 });
});

test("withheld surrogate state resets when another assistant message replaces the draft", async () => {
  const observed = [];
  const port = adapter([start, delta("\ud83d"), start, delta("ok"), { type: "message_end", message: message("ok") }], 2);
  const facts = await port.run("go", { inputEntered() {}, turnStart() {}, turnEnd() {}, output(value) { observed.push(value); } });
  assert.equal(observed[1].text, ""); assert.equal(observed[1].total_chars, 1);
  assert.equal(facts.output.text, "ok"); assert.equal(facts.output.total_chars, 2);
  assert.equal(facts.output.truncated, false); assert.equal(facts.output.revision, 2);
});

for (const stopReason of ["error", "aborted"]) for (const usage of [zeroUsage, pricedUsage]) {
  test(`${stopReason} usage remains a conservative floor, including after successful retry (cost=${usage.cost.total})`, async () => {
    const failure = { type: "message_end", message: message("text before the usage frame", stopReason, usage) };
    const callbacks = { inputEntered() {}, turnStart() {}, turnEnd() {}, output() {} };
    const failed = await adapter([start, failure]).run("go", callbacks);
    assert.equal(failed.usage.total.cost, usage.cost.total);
    assert.deepEqual(failed.usage.partial, USAGE_COMPONENTS);
    const recovered = await adapter([start, failure, { type: "auto_retry_start" }, start,
      { type: "message_end", message: message("recovered", "stop", pricedUsage) }, { type: "auto_retry_end" }]).run("go", callbacks);
    assert.equal(recovered.kind, "success"); assert.equal(recovered.usage.total.cost, usage.cost.total + 0.25);
    assert.equal(recovered.usage.total.input, usage.input + 10);
    assert.deepEqual(recovered.usage.partial, USAGE_COMPONENTS, "retry success cannot erase an earlier observation gap");
  });
}

test("incremental SDK callbacks never publish cumulative snapshots per delta", async () => {
  const deltas = [], snapshots = [];
  const text = "abcd".repeat(8192);
  const events = [start, ...Array.from({ length: 8192 }, () => delta("abcd")), { type: "message_end", message: message(text) }];
  const facts = await adapter(events).run("go", { inputEntered() {}, turnStart() {}, turnEnd() {},
    outputDelta(value) { deltas.push(value); }, output(value) { snapshots.push(value); } });
  assert.equal(deltas.length, 8193);
  assert.deepEqual(deltas[0], { type: "reset", revision: 1, max_chars: 1048576 });
  assert(deltas.slice(1).every((value) => value.type === "append" && value.text === "abcd" && value.revision === 1));
  assert.equal(snapshots.length, 1, "only message_end materializes a complete candidate");
  assert.equal(snapshots[0].text, text); assert.equal(facts.output.text, text);
});

for (const [adapterCap, ownerCap] of [[2, 8], [8, 2]]) test(`incremental retention respects independent adapter/core caps ${adapterCap}/${ownerCap}`, async (t) => {
  const text = "a🚀z";
  const port = adapter([start, delta("a\ud83d"), delta("\ude80z"), { type: "message_end", message: message(text) }], adapterCap);
  const { controller: c } = await fixture(t, { controller: { output_chars: ownerCap, createSession: async () => port } });
  const run = await c.submit("caps", task("caps")); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "completed");
  assert.equal(c.getResult(run.run_id).text, "a"); assert.equal(c.getResult(run.run_id).total_chars, 4);
});

test("same-revision final rewrite still fails closed and preserves the observed prefix", async (t) => {
  const port = adapter([start, delta("observed"), { type: "message_end", message: message("rewritten") }]);
  const { controller: c } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("regressed", task("regressed")); await ended(c, run);
  const view = c.view(run.run_id);
  assert.equal(view.status, "failed"); assert.equal(view.resumable, false);
  assert(view.cleanup_errors.includes("EXECUTION_OUTPUT_REGRESSED"));
  assert.equal(c.getResult(run.run_id).text, "observed");
});

test("incremental reset replaces earlier attempts and terminal lone surrogates retain legacy semantics", async (t) => {
  const port = adapter([start, delta("discard draft"), start, delta("\ud800"),
    { type: "message_end", message: message("\ud800") }]);
  const { controller: c } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("reset", task("reset")); await ended(c, run);
  assert.equal(c.view(run.run_id).status, "completed");
  assert.equal(c.getResult(run.run_id).text, "\ud800"); assert.equal(c.getResult(run.run_id).total_chars, 1);
});

test("throwing incremental control callbacks quarantine but preserve observed billed usage", async () => {
  const port = adapter([start, delta("billed"), { type: "message_end", message: message("billed", "stop", pricedUsage) }]);
  let calls = 0;
  await assert.rejects(port.run("go", { inputEntered() {}, turnStart() {}, turnEnd() {}, output() {},
    outputDelta() { calls++; throw new Error("broken incremental consumer"); } }), (error) => {
    assert.match(error.message, /run_callback_failed/); assert.equal(error.usage.total.cost, 0.25); return true;
  });
  assert.equal(calls, 1, "the first failed callback seals later control delivery");
});

test("an append callback failure seals delivery after an accepted prefix without losing prefix or spend", async (t) => {
  const gate = new ChildRunGate(), controls = [], aborts = [], revocations = [], snapshots = [];
  const text = "kept prefix rejected late";
  const port = adapter([start, delta("kept "), delta("prefix"), delta(" rejected"), delta(" late"),
    { type: "message_end", message: message(text, "stop", pricedUsage) }], undefined, {
    gate,
    abort: async () => { aborts.push({ accepting: gate.accepting, stopped: gate.stopped }); },
    invalidateApproval: () => { revocations.push({ accepting: gate.accepting, stopped: gate.stopped }); },
  });
  const execute = port.run.bind(port);
  port.run = (prompt, callbacks) => execute(prompt, { ...callbacks,
    outputDelta(value) {
      controls.push(value.type === "reset" ? "reset" : value.text);
      if (value.type === "append" && value.text === " rejected") throw new Error("append consumer failed after prefix");
      callbacks.outputDelta(value);
    },
    output(value) { snapshots.push(value); callbacks.output(value); },
  });
  const { controller: c } = await fixture(t, { controller: { createSession: async () => port } });
  const run = await c.submit("append-failure", task("append-failure")); await ended(c, run);
  assert.deepEqual(controls, ["reset", "kept ", "prefix", " rejected"],
    "reset and initial appends succeed; the failing append suppresses every later control callback");
  assert.deepEqual(snapshots, [], "message_end cannot replace the accepted prefix after callback failure");
  assert.deepEqual(aborts, [{ accepting: false, stopped: true }], "the failure closes the gate before tracked abort");
  assert(revocations.length > 0); assert(revocations.every(({ accepting, stopped }) => !accepting && stopped));
  assert.equal(gate.accepting, false); assert.equal(gate.stopped, true);
  assert.throws(() => port.clearInputs(), /run_callback_failed/, "the failed adapter remains quarantined");
  const view = c.view(run.run_id), page = c.getResult(run.run_id);
  assert.equal(view.status, "failed"); assert.equal(view.resumable, false);
  assert.equal(view.unavailable_reason, "run_callback_failed");
  assert.equal(page.text, "kept prefix"); assert.equal(page.total_chars, "kept prefix".length);
  assert.equal(page.retained_chars, "kept prefix".length); assert.equal(page.result_ref.chars, "kept prefix".length);
  assert.equal(view.usage.total.cost, 0.25); assert.equal(view.usage.total.input, 10);
  assert.deepEqual(view.usage.partial, []);
  assert.equal(c.drainUsage().total.cost, 0.25); assert.equal(c.drainUsage(), undefined, "usage settles exactly once");
  assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().cleanup_uncertain, false);
});

test("a successful explicitly zero-usage response is not forced partial", async () => {
  const facts = await adapter([start, { type: "message_end", message: message("ok") }]).run("go",
    { inputEntered() {}, turnStart() {}, turnEnd() {}, output() {} });
  assert.equal(facts.kind, "success"); assert.equal(facts.usage.total.cost, 0); assert.deepEqual(facts.usage.partial, []);
});
