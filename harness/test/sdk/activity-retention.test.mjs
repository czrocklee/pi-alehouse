// Real pinned SDK + scripted local provider only. No live model, credentials,
// network, installed-runtime or human-terminal acceptance claims.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { ChildActivity } from "../../dist/runtime/activity-observer.js";
import { ChildRunGate, PiAgentSessionAdapter } from "../../dist/runtime/agent-session.js";
import { renderDetailFields } from "../../dist/ui/agent-detail.js";
import { TranscriptContent } from "../../dist/ui/transcript.js";
import { deferred, until } from "../support/controller-fixture.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const theme = { fg: (_color, text) => text, bold: text => text };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };

async function fixture(t, respond, { retry = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-activity-lifecycle-"));
  const network = t.mock.method(globalThis, "fetch", () => { assert.fail("scripted activity fixture attempted network IO"); });
  let session, owner;
  t.after(async () => {
    if (owner) {
      const report = await owner.shutdown(2000);
      assert.equal(report.closed, true, "fixture must confirm shutdown");
    } else session?.dispose();
    try { assert.equal(network.mock.callCount(), 0); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const activity = new ChildActivity(root), gate = new ChildRunGate(), events = [];
  let attempts = 0, shutdowns = 0;
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerProvider("activity-lifecycle", { api: "activity-lifecycle", apiKey: "synthetic-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "controlled", name: "Controlled activity lifecycle", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model) {
      const attempt = ++attempts, stream = ai.createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "pending", usage: structuredClone(usage), timestamp: Date.now() };
      void (async () => {
        stream.push({ type: "start", partial: message });
        try {
          await respond({ attempt, stream, message });
          if (message.stopReason === "pending") message.stopReason = "stop";
        } catch (error) { message.stopReason = "error"; message.errorMessage = String(error); }
        if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })();
      return stream;
    } });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1, provider: { maxRetries: 0 } } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Only answer the synthetic fixture.",
    extensionFactories: [activity.extension, pi => pi.on("session_shutdown", () => { shutdowns++; }), gate.extension] });
  await loader.reload();
  const created = await sdk.createAgentSession({ cwd: root, agentDir: root, settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(root), resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("activity-lifecycle", "controlled"), tools: [] });
  session = created.session;
  await session.bindExtensions({});
  session.subscribe(event => events.push(event.type));
  const port = new PiAgentSessionAdapter({ session, parentBus: { emit() {} }, gate, readiness() {} });
  owner = await OwnerController.open({ owner: { owner_id: randomUUID(), generation: randomUUID(), assertHeld() {}, close() {} },
    createSession: async () => port });
  const submit = () => {
    activity.begin();
    return owner.submit(randomUUID(), { prompt: "Synthetic task", description: "controlled activity task", settings: {
      provider: "activity-lifecycle", model: "controlled", thinking: "off", parent_thinking: "off",
      thinking_resolution: "identity", profile: "editor", difficulty: 3, strength: "d3", preset: "fixture", preset_version: "v1",
      selection_digest: "b".repeat(64), cwd: root, tools: [], definition_digest: "a".repeat(64) } });
  };
  const end = async run => {
    assert.equal(await owner.waitForRuns([run.run_id], { mode: "all", timeout_ms: 3000 }), "ready");
    return owner.view(run.run_id);
  };
  return { root, activity, session, port, owner, events, submit, end, shutdowns: () => shutdowns };
}

test("activity public observation types expose stable cheap history identities and retain them at shutdown", t => {
  const child = new ChildActivity("/synthetic"), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  /** @type {import("../../dist/runtime/activity-observer.js").ChildActivityObservation} */
  const observation = child;
  const historyState = () => observation.historyState?.();
  assert.equal(historyState(), undefined, "queued observations have no session identity");
  const sessionManager = sdk.SessionManager.inMemory("/synthetic");
  const entries = t.mock.method(sessionManager, "getEntries", sessionManager.getEntries.bind(sessionManager));
  handlers.get("session_start")({}, { sessionManager });
  const empty = historyState();
  assert(empty);
  assert.equal(empty.session_id, sessionManager.getSessionId());
  assert.equal(empty.session, sessionManager); assert.equal(empty.count, 0); assert.equal(empty.leaf, null);
  assert.equal(historyState(), empty, "unchanged stamps keep object identity");
  assert.equal(entries.mock.callCount(), 0, "stamp reads never copy entries");
  const leaf = sessionManager.appendMessage({ role: "user", content: "RETAINED_ENTRY", timestamp: 0 });
  const appended = historyState();
  assert(appended);
  assert.notEqual(appended, empty); assert.equal(appended.leaf, leaf); assert.equal(appended.count, 1);
  const revision = observation.presentationRevision;
  handlers.get("session_shutdown")();
  const afterRevision = observation.presentationRevision;
  assert(typeof revision === "number" && typeof afterRevision === "number" && afterRevision > revision);
  assert.equal(historyState(), appended, "shutdown retires live activity, not retained history");
  assert.equal(observation.entries()?.length, 1);
  const before = historyState();
  sessionManager.resetLeaf();
  assert.notEqual(historyState(), before, "branch changes invalidate without an entry-count change");
});

function textDelta(stream, message, text, index = 0) {
  const part = { type: "text", text };
  message.content[index] = part;
  stream.push({ type: "text_start", contentIndex: index, partial: message });
  stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: message });
}

test("real SDK: retry response restores Owner generating and detail previews before auto_retry_end", { timeout: 10000 }, async t => {
  const started = deferred(), thinking = deferred(), draft = deferred();
  const allowThinking = deferred(), allowDraft = deferred(), allowEnd = deferred();
  t.after(() => { allowThinking.resolve(); allowDraft.resolve(); allowEnd.resolve(); });
  const f = await fixture(t, async ({ attempt, stream, message }) => {
    if (attempt === 1) { message.stopReason = "error"; message.errorMessage = "503 service unavailable"; return; }
    await tick(); started.resolve(); await allowThinking.promise;
    const part = { type: "thinking", thinking: "Inspecting the retry response" };
    message.content.push(part);
    stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: part.thinking, partial: message });
    await tick(); thinking.resolve(); await allowDraft.promise;
    stream.push({ type: "thinking_end", contentIndex: 0, content: part.thinking, partial: message });
    textDelta(stream, message, "RETRY_STREAM_DRAFT", 1);
    await tick(); draft.resolve(); await allowEnd.promise;
    stream.push({ type: "text_end", contentIndex: 1, content: "RETRY_STREAM_DRAFT", partial: message });
  }, { retry: true });
  const run = await f.submit();
  await started.promise;
  await until(() => f.owner.view(run.run_id).runtime?.activity === "generating");
  assert(f.events.includes("auto_retry_start"), "the SDK actually entered automatic retry");
  assert(!f.events.includes("auto_retry_end"), "the SDK has not yet completed its retried response");
  assert.equal(f.session.isStreaming, true);
  allowThinking.resolve(); await thinking.promise;
  await until(() => f.activity.snapshot().thinking === "Inspecting the retry response");
  let input = { view: f.owner.view(run.run_id), live: f.activity.snapshot() };
  assert.equal(input.view.runtime.activity, "generating");
  assert.equal(input.live.channel, "thinking");
  assert.match(renderDetailFields(input, theme, 100).join("\n"), /thinking\s+Inspecting the retry response/);
  assert(!f.events.includes("auto_retry_end"));
  allowDraft.resolve(); await draft.promise;
  await until(() => f.activity.snapshot().preview === "RETRY_STREAM_DRAFT");
  input = { view: f.owner.view(run.run_id), live: f.activity.snapshot() };
  assert.equal(input.view.runtime.activity, "generating");
  assert.equal(input.live.channel, "text");
  assert.match(renderDetailFields(input, theme, 100).join("\n"), /draft\s+RETRY_STREAM_DRAFT/);
  assert(!f.events.includes("auto_retry_end"), "draft is visible during retry, not only after completion");
  allowEnd.resolve();
  const result = await f.end(run);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.total.cost, 2, "both ordinary attempts remain billed");
  assert.deepEqual(result.usage.partial, ["input", "output", "cache_read", "cache_write", "cost"]);
  assert(f.events.includes("auto_retry_end"));
});

test("real SDK: a released failed Agent retains entries and its already-open native transcript after shutdown", { timeout: 10000 }, async t => {
  const streaming = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, async ({ stream, message }) => {
    textDelta(stream, message, "RETAINED_TRANSCRIPT_MARKER");
    await tick(); streaming.resolve(); await release.promise;
    stream.push({ type: "text_end", contentIndex: 0, content: "RETAINED_TRANSCRIPT_MARKER", partial: message });
  });
  const original = f.port.run.bind(f.port);
  t.mock.method(f.port, "run", (prompt, callbacks) => original(prompt, { ...callbacks,
    turnEnd(...args) { callbacks.turnEnd(...args); throw new Error("CONTROLLED_TERMINAL_CALLBACK_FAILURE"); },
  }));
  const disposed = t.mock.method(f.session, "dispose", f.session.dispose.bind(f.session));
  const run = await f.submit(); await streaming.promise;
  sdk.initTheme(undefined, false);
  const transcript = new TranscriptContent({ tui: { requestRender() {}, terminal: { columns: 100, rows: 30 } },
    cwd: f.root, markdownTheme: sdk.getMarkdownTheme(), source: {
      messages: () => sdk.buildContextEntries(f.activity.entries() ?? []).flatMap(sdk.sessionEntryToContextMessages),
      inFlight: () => f.activity.inFlight(), toolDefinition: () => undefined,
    } });
  t.after(() => transcript.dispose());
  const paint = width => transcript.slice(width, 0, transcript.lineCount(width)).join("\n");
  assert.match(paint(100), /RETAINED_TRANSCRIPT_MARKER/, "pane was already open during streaming");
  release.resolve();
  const result = await f.end(run);
  assert.equal(result.status, "failed");
  assert.equal(result.unavailable_reason, "run_callback_failed");
  assert.equal(result.resident, false, "Owner released the failed session, not just ended its Run");
  assert.equal(result.execution_exited, true);
  assert.equal(f.shutdowns(), 1, "the real SDK session_shutdown hook ran");
  assert.equal(disposed.mock.callCount(), 1);
  assert.equal(f.activity.inFlight(), undefined);
  const entries = f.activity.entries();
  assert(entries?.some(entry => entry.type === "message" && entry.message.role === "assistant" &&
    entry.message.content.some(part => part.type === "text" && part.text === "RETAINED_TRANSCRIPT_MARKER")),
  "shutdown must not sever the retained SessionManager reference");
  transcript.invalidate();
  assert.match(paint(100), /RETAINED_TRANSCRIPT_MARKER/, "the same pane can repaint after disposal");
  assert.match(paint(72), /RETAINED_TRANSCRIPT_MARKER/, "a width change still re-reads retained settled entries");
});
