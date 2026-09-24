import assert from "node:assert/strict";
import test from "node:test";
import { PiAgentSessionAdapter, ChildRunGate } from "../../dist/runtime/agent-session.js";
import { USAGE_COMPONENTS } from "../../dist/core/usage-ledger.js";
import { ended, fixture, task } from "../support/controller-fixture.mjs";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const pricedUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
const message = (text, stopReason = "stop", usage = zeroUsage) => ({ role: "assistant", provider: "p", model: "m",
  stopReason, content: [{ type: "text", text }], usage });
function adapter(events, outputChars) {
  let listener;
  const session = { sessionId: "stream-fixture", isIdle: true, isStreaming: false,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    clearQueue: () => ({ steering: [], followUp: [] }), getSteeringMessages: () => [], getFollowUpMessages: () => [],
    async waitForIdle() {}, async prompt() {
      listener({ type: "message_end", message: { role: "user" } });
      for (const event of events) listener(event);
    } };
  const port = new PiAgentSessionAdapter({ session, gate: new ChildRunGate(), parentBus: { emit() {} }, readiness() {}, outputChars });
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

test("a successful explicitly zero-usage response is not forced partial", async () => {
  const facts = await adapter([start, { type: "message_end", message: message("ok") }]).run("go",
    { inputEntered() {}, turnStart() {}, turnEnd() {}, output() {} });
  assert.equal(facts.kind, "success"); assert.equal(facts.usage.total.cost, 0); assert.deepEqual(facts.usage.partial, []);
});
