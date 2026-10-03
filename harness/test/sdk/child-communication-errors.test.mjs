// Real pinned SDK argument validation/execution/error serialization and real Owner
// FIFO admission/publication. Only the lease and SessionPort IO are in-memory
// fakes: no SDK session, provider, credentials, network, host or filesystem lease.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { ALERT_QUEUE_FULL_RESOLUTION } from "../../dist/core/communication-state.js";
import { createChildTools } from "../../dist/tools/child-tools.js";
import { FakePort, task, until } from "../support/controller-fixture.mjs";

// Resolve agent-core from the development SDK, not an ambient/global runtime.
// Its main export is import-only: anchor via the public package.json export,
// then load that selected package's declared ESM entry, never require its main.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);
const corePackageURL = pathToFileURL(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
const corePackage = JSON.parse(readFileSync(corePackageURL, "utf8"));
assert.equal(corePackage.name, "@earendil-works/pi-agent-core");
assert.equal(corePackage.exports["."].import, "./dist/index.js", "review a changed pinned SDK ESM entry");
const { runToolCall } = await import(new URL(corePackage.exports["."].import, corePackageURL));
const { wrapToolDefinitions } = await import(new URL("core/tools/tool-definition-wrapper.js", sdkEntry));
const sdkVersion = JSON.parse(readFileSync(new URL("../package.json", sdkEntry), "utf8")).version;
const coreVersion = corePackage.version;
const resolution = "Do not retry in a loop; keep the information in your final result and continue work you can do. If you truly need a parent decision, use ask_parent and end this task.";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function ownerFixture(t, concurrency) {
  assert.equal(sdkVersion, "1.0.0"); assert.equal(coreVersion, "1.0.0");
  assert.equal(ALERT_QUEUE_FULL_RESOLUTION, resolution, "shared core guidance must preserve the exact SDK text contract");
  t.mock.method(globalThis, "fetch", () => { assert.fail("child communication fixture attempted network IO"); });
  let held = true;
  const owner = { owner_id: randomUUID(), generation: randomUUID(),
    assertHeld() { assert.equal(held, true, "fixture lease remains held until confirmed closure"); },
    close() { held = false; } };
  const ports = [];
  const controller = await OwnerController.open({ owner, concurrency, resident_limit: 8,
    createSession: async () => { const port = new FakePort(); ports.push(port); return port; } });
  t.after(async () => {
    for (const port of ports) {
      port.autoStop = true;
      if (port.streaming) port.finish("fixture cleanup", "aborted");
    }
    const report = await controller.shutdown(3000);
    assert.equal(report.closed, true, `fixture must prove Owner closure: ${JSON.stringify(report)}`);
    assert.equal(held, false);
  });
  return { c: controller, ports };
}
async function started(c, ports, name) {
  const run = await c.submit(name, task(name, { name }));
  await until(() => ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id));
  return { run, port: ports.find((port) => port.calls.at(-1)?.identity.run_id === run.run_id) };
}
const toolsFor = (port) => wrapToolDefinitions(createChildTools(() => port.callbacks, { accepting: true, stopped: false }));
async function invoke(tools, name, args, id) {
  const toolCall = { type: "toolCall", id, name, arguments: args };
  const assistantMessage = { role: "assistant", api: "fixture", provider: "fixture", model: "controlled",
    content: [toolCall], stopReason: "toolUse", usage, timestamp: 0 };
  return runToolCall(toolCall, { tools, assistantMessage, context: { messages: [assistantMessage], tools } });
}
async function acceptAlert(tools, message) {
  const outcome = await invoke(tools, "alert_parent", { message }, message);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.result, { content: [{ type: "text", text: "Alert queued. Continue working." }], details: undefined });
}
function queueFailure(outcome, scope, limit, forbidden) {
  assert.equal(outcome.isError, true, "SDK marks rejection as a tool error, not queued success");
  assert.deepEqual(outcome.result.content, [{ type: "text", text: `ALERT_QUEUE_FULL (scope=${scope}, limit=${limit}): ${resolution}` }]);
  assert.deepEqual(outcome.result.details, {}, "the SDK carries no HarnessError.details: all required guidance must be in content");
  const text = outcome.result.content[0].text;
  assert(text.length < 512);
  for (const value of forbidden) assert(!text.includes(value), "no rejected message or internal identity is exposed");
}
function coreQueueFailure(port, scope, limit) {
  assert.throws(() => port.callbacks.alert("core-guidance-probe"), (error) => {
    assert.equal(error.code, "ALERT_QUEUE_FULL");
    assert.equal(error.message, "ALERT_QUEUE_FULL", "only the child boundary projects model-facing text");
    assert.deepEqual(error.details, { scope, limit, resolution: ALERT_QUEUE_FULL_RESOLUTION });
    return true;
  });
}
function sameFIFO(c, accepted) {
  // Read original authoritative event references only; never inject/mutate a
  // private queue. Publication below independently proves the full FIFO text.
  assert.equal(c.alerts.length, accepted.length);
  accepted.forEach((event, index) => assert.equal(c.alerts[index], event, "rejection must not replace, reorder or evict an accepted event"));
}
const publication = async (c) => JSON.parse((await c.observe({ kind: "wait", wait_ms: 0 }, { validate() {} })).content[0].text);

test("pinned SDK exposes Agent16 queue rejection across reused Runs and preserves every accepted FIFO event", async (t) => {
  const { c, ports } = await ownerFixture(t, 1), { run: original, port } = await started(c, ports, "otter");
  const tools = toolsFor(port), expected = [];
  for (let index = 0; index < 10; index++) {
    const message = `original-${index}`; await acceptAlert(tools, message);
    expected.push({ agent: "otter", task: 1, label: "otter", message });
  }
  port.finish("original result");
  assert.equal(await c.waitForRuns([original.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
  const current = await c.submit("reuse", { resume: original.agent_id, prompt: "next", description: "next" });
  await until(() => port.calls.length === 2 && port.streaming);
  for (let index = 0; index < 6; index++) {
    const message = `current-${index}`; await acceptAlert(tools, message);
    expected.push({ agent: "otter", task: 2, label: "next", message });
  }
  const accepted = c.alerts.slice(), rejected = "PRIVATE-REJECTED-MESSAGE";
  coreQueueFailure(port, "agent", 16);
  queueFailure(await invoke(tools, "alert_parent", { message: rejected }, "seventeenth"), "agent", 16,
    [rejected, c.identity.owner_id, c.identity.generation, original.run_id, current.run_id]);
  sameFIFO(c, accepted);
  assert.equal(c.view(original.run_id).pending_messages, 10);
  assert.equal(c.view(current.run_id).pending_messages, 6);
  assert.equal(port.stopped, 0); assert.equal(port.streaming, true, "queue rejection does not stop child work");

  // The suggested recovery remains available even at capacity, and the real
  // SDK keeps first-write-wins receipts distinct without replacing the question.
  const first = await invoke(tools, "ask_parent", { question: "Which option?" }, "first-question");
  const second = await invoke(tools, "ask_parent", { question: "Different valid question?" }, "second-question");
  assert.equal(first.isError, false); assert.equal(second.isError, false);
  assert.equal(first.result.content[0].text, "Question recorded. Finish this task now.");
  assert.equal(second.result.content[0].text, "This task already has a question; it was not replaced. Finish this task now.");
  sameFIFO(c, accepted);
  port.finish("awaiting decision");
  assert.equal(await c.waitForRuns([current.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
  assert.equal(c.view(current.run_id).outcome.question, "Which option?");
  sameFIFO(c, accepted);
  const observed = await publication(c);
  assert.deepEqual(observed.alerts, expected, "all sixteen original events still publish in cross-Run FIFO order");
  assert.equal(observed.alerts_pending, 0); assert.equal(c.alerts.length, 0);
});

test("pinned SDK exposes Owner64 before Agent16, denies a fifth Agent without reserved space and never evicts", async (t) => {
  const { c, ports } = await ownerFixture(t, 5), entries = [], expected = [];
  for (const name of ["otter", "orca", "lynx", "marten"]) entries.push(await started(c, ports, name));
  for (const { run, port } of entries) {
    const tools = toolsFor(port);
    for (let index = 0; index < 16; index++) {
      const message = `${run.name}-${index}`; await acceptAlert(tools, message);
      expected.push({ agent: run.name, task: 1, label: run.name, message });
    }
  }
  const accepted = c.alerts.slice(), newcomer = await started(c, ports, "badger");
  for (const { run, port } of [entries[0], newcomer]) {
    const rejected = `PRIVATE-REJECTED-${run.name}`;
    coreQueueFailure(port, "owner", 64);
    queueFailure(await invoke(toolsFor(port), "alert_parent", { message: rejected }, `owner-full-${run.name}`), "owner", 64,
      [rejected, c.identity.owner_id, c.identity.generation, run.run_id, run.agent_id]);
    sameFIFO(c, accepted);
    assert.equal(port.stopped, 0); assert.equal(port.streaming, true);
  }
  assert.deepEqual(entries.map(({ run }) => c.view(run.run_id).pending_messages), [16, 16, 16, 16]);
  assert.equal(c.view(newcomer.run.run_id).pending_messages, 0);
  const observed = await publication(c);
  assert.equal(observed.reason, "alert");
  assert.deepEqual(observed.alerts, expected, "all sixty-four original events survive both rejected admissions in FIFO order");
  assert.equal(observed.alerts_pending, 0); assert.equal(c.alerts.length, 0);
  await acceptAlert(toolsFor(newcomer.port), "capacity released by publication");
  assert.equal(c.view(newcomer.run.run_id).pending_messages, 1);
});
