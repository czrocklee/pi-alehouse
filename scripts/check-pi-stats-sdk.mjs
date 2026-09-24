#!/usr/bin/env node
// Real SDK event order with an in-process provider and monotonic clock.
// No network, production credentials, live model or persistent user session.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piExecutable = process.argv[2];
assert(piExecutable, "Usage: node script/check-pi-stats-sdk.mjs PI_EXECUTABLE");
const require = createRequire(realpathSync(piExecutable));
let sdkRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(sdkRoot, "package.json"))) {
  assert.notEqual(sdkRoot, dirname(sdkRoot), "Pi package not found");
  sdkRoot = dirname(sdkRoot);
}
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")));
const ai = await import(pathToFileURL(join(dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(realpathSync(piExecutable)).href)), "dist/index.js")));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { SessionStats, bindStatsEvents } = await jiti.import(join(resolve(dirname(import.meta.filename), ".."),
  "extensions/lib/session-stats.ts"));
const { WorkerStats } = await jiti.import(join(resolve(dirname(import.meta.filename), ".."),
  "extensions/lib/worker-stats.ts"));
const { WorkerStatsObserver } = await jiti.import(join(resolve(dirname(import.meta.filename), ".."),
  "harness/src/runtime/worker-stats.ts"));
const { STATS_WORKER_ATTACH } = await import(pathToFileURL(join(resolve(dirname(import.meta.filename), ".."),
  "lib/stats-protocol.mjs")));
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const worker of [false, true]) for (const failedTool of [false, true]) test(
  `real SDK: ${worker ? "worker" : "main"} usage, timing and ${failedTool ? "nonzero Bash exit recovery" : "successful tool"}`,
  { timeout: 15000 }, async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Stats must never initiate network IO"); });
  const root = await mkdtemp(join(tmpdir(), "pi-stats-sdk-"));
  let now = 0, calls = 0, unbind;
  const toolName = failedTool ? "bash" : "probe";
  const stats = new SessionStats(() => now);
  const workers = new WorkerStats(() => now);
  const parentBus = sdk.createEventBus();
  parentBus.on(STATS_WORKER_ATTACH, (request) => {
    if (request.parentId === "stats-sdk-parent") request.sink = workers.attach(request.workerId);
  });
  const observer = worker ? new WorkerStatsObserver(parentBus, "stats-sdk-parent", "stats-sdk-worker") : undefined;
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json") });
  runtime.registerProvider("stats-fixture", {
    api: "stats-fixture", apiKey: "fixture-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "requested", name: "Stats fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple(model, _context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const index = calls++;
      void (async () => {
        // Custom providers must drive the same options callbacks as HTTP
        // providers. Merely pushing `start` does not prove request timing.
        await options.onPayload?.({ model: model.id });
        now += 50;
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          responseModel: "actually-answered", content: [], stopReason: "pending", timestamp: 0,
          usage: { input: 20, output: index === 0 ? 10 : 30, cacheRead: 0, cacheWrite: 0,
            totalTokens: index === 0 ? 30 : 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } };
        stream.push({ type: "start", partial: message }); await tick();
        stream.push({ type: "text_delta", delta: "", contentIndex: 0, partial: message }); await tick();
        now += 30;
        stream.push({ type: "thinking_delta", delta: "synthetic", contentIndex: 0, partial: message }); await tick();
        now += 20;
        stream.push({ type: "text_delta", delta: "synthetic", contentIndex: 0, partial: message }); await tick();
        now += index === 0 ? 200 : 400;
        message.content = index === 0 ? [{ type: "toolCall", id: "probe-call", name: toolName,
          arguments: failedTool ? { command: "test -f missing-fixture" } : {} }]
          : [{ type: "text", text: "done" }];
        message.stopReason = index === 0 ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      })().catch((error) => { stream.end(); assert.fail(String(error)); });
      return stream;
    },
  });
  const makeSettings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const makeLoader = (settingsManager, extensionFactories, eventBus) => new sdk.DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, eventBus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic stats fixture.", extensionFactories });
  const bindMain = (pi) => { unbind = bindStatsEvents(pi, () => stats, () => {}); };
  const settings = makeSettings();
  const loader = makeLoader(settings, observer ? [observer.extension] : [bindMain]);
  let session, parentSession;
  t.after(async () => {
    unbind?.();
    observer?.dispose();
    workers.dispose();
    for (const active of [session, parentSession]) {
      if (active) { await active.abort(); await active.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); active.dispose(); }
    }
    await rm(root, { recursive: true, force: true });
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
    settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), modelRuntime: runtime,
    model: runtime.getModel("stats-fixture", "requested"), tools: [toolName],
    // Drive the actual SDK Bash nonzero-exit → throw → isError path, without
    // starting a subprocess. The model then completes successfully in turn 2.
    customTools: failedTool ? [sdk.createBashToolDefinition(root, { operations: {
      exec: async (command) => { assert.equal(command, "test -f missing-fixture"); now += 70; return { exitCode: 1 }; },
    } })] : [{ name: "probe", description: "Synthetic clock advance", parameters: { type: "object", properties: {} },
      execute: async () => { now += 70; return { content: [{ type: "text", text: "probe done" }],
        // Aggregated tool-result spend must not be billed as another LLM response.
        usage: { input: 999, output: 999, cost: { total: 99 } } }; } }] }));
  await session.bindExtensions({});
  if (worker) {
    // Production has distinct parent and child extension runners. Bind the
    // parent collector for real; an unbound empty object proves no isolation.
    const parentSettings = makeSettings();
    const parentLoader = makeLoader(parentSettings, [bindMain], parentBus);
    await parentLoader.reload();
    ({ session: parentSession } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: parentLoader,
      settingsManager: parentSettings, sessionManager: sdk.SessionManager.inMemory(root), modelRuntime: runtime,
      model: runtime.getModel("stats-fixture", "requested"), tools: [] }));
    await parentSession.bindExtensions({});
    assert.notEqual(parentSession.extensionRunner, session.extensionRunner);
  }
  observer?.beginRun();
  await session.prompt(`Call ${toolName} once then finish.`);
  observer?.endRun("success");
  await tick();
  const view = worker ? workers.snapshot() : stats.snapshot();
  assert.equal(calls, 2);
  assert.equal(view.health, "idle");
  assert.equal(view.busyMs, 870);
  assert.equal(view.llmMs, 800);
  assert.equal(view.toolMs, 70);
  if (!worker) {
    assert.equal(view.lastTtftMs, 80, "stream start/empty chunks are not the first effective output");
    assert.equal(view.lastTextMs, 100);
  }
  assert.equal(view.models.length, 1);
  const model = view.models[0];
  assert.equal(model.provider, "stats-fixture");
  assert.equal(model.model, "actually-answered");
  assert.equal(model.requests, 2);
  assert.equal(model.ttftMs, 80);
  assert.equal(model.ttftSamples, 2);
  assert.equal(model.outputTokens, 40);
  assert.equal(model.tps, 50, "sum tokens / sum request durations, not an average of per-request rates");
  assert.equal(model.cost, 0.02);
  assert.equal(view.tools[0].tool, toolName);
  assert.equal(view.tools[0].calls, 1);
  assert.equal(view.tools[0].errors, failedTool ? 1 : 0);
  assert.equal(view.tools[0].totalMs, 70);
  assert(!JSON.stringify(view).includes("synthetic"), "drafts and arguments never enter metrics");
  if (worker) {
    assert.equal(stats.snapshot().models.length, 0, "the bound parent receives no child model requests");
    // Positive control: the same parent collector must observe its own real
    // prompt, while the already attached worker receives none of that usage.
    await parentSession.prompt("Finish a parent-only turn.");
    const parent = stats.snapshot();
    assert.equal(parent.models.length, 1, "positive control: the bound parent must collect its own request");
    assert.equal(parent.models[0].requests, 1);
    assert.equal(parent.models[0].outputTokens, 30);
    assert.equal(parent.models[0].cost, 0.01);
    assert.equal(parent.llmMs, 500);
    assert.deepEqual(workers.snapshot(), view, "parent events do not rebill the worker");
    observer.beginRun();
    await session.prompt("Continue this resident worker and finish.");
    observer.endRun("success");
    const resumed = workers.snapshot();
    assert.equal(resumed.observed, 1, "a resumed agent is not a second worker");
    assert.equal(resumed.models[0].requests, 3);
    assert.equal(resumed.models[0].outputTokens, 70);
    assert.equal(resumed.tools[0].calls, 1);
    assert.deepEqual(stats.snapshot().models, parent.models, "a later child Run cannot add to the proven-live parent collector");
    assert.equal(stats.snapshot().llmMs, parent.llmMs);
    assert.equal(stats.snapshot().busyMs, parent.busyMs);
    assert.equal(resumed.resident, 1);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = workers.snapshot();
    assert.equal(retired.resident, 0, "the real child shutdown event retires the sink without an explicit observer dispose");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    observer.beginRun(); observer.endRun("error"); // a retired observer cannot reattach its Agent ID
    assert.deepEqual(workers.snapshot(), retired, "repeat shutdown and late Run callbacks are already inert");
    observer.dispose(); observer.dispose();
    assert.deepEqual(workers.snapshot(), retired, "explicit dispose is only a final idempotence check");
    assert.equal(retired.observed, 1, "late resume attempts cannot double-count a retired worker");
    assert.equal(retired.models[0].requests, 3);
    assert.equal(retired.models[0].cost, 0.03, "release retains every response exactly once, not forwarded tool spend");
  }
});
