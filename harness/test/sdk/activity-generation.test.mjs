// Pinned development SDK + scripted stream only: no live model, user config,
// credentials, network, terminal acceptance or installed-runtime claims.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ChildActivity } from "../../dist/runtime/activity-observer.js";
import { renderActivity } from "../../dist/ui/format.js";

const theme = { fg: (_color, text) => text, bold: text => text };

const nextTick = () => new Promise(resolve => setImmediate(resolve));
test("real SDK forwards public thinking/text independently and retires previews at response completion", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-activity-generation-"));
  let childSession;
  t.after(async () => {
    try { childSession?.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const network = t.mock.method(globalThis, "fetch", () => { assert.fail("scripted preview test attempted network IO"); });
  const activity = new ChildActivity(root), observed = [];
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerProvider("activity-fixture", { api: "activity-fixture", apiKey: "synthetic-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "controlled", name: "Controlled preview", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "pending", timestamp: Date.now(),
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const script = async () => {
        stream.push({ type: "start", partial: message });
        const thinking = { type: "thinking", thinking: "" };
        message.content.push(thinking);
        stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
        await nextTick();
        for (const delta of ["## **Inspecting", " lifecycle**", "\nNext thought"]) {
          thinking.thinking += delta;
          stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message });
          await nextTick();
        }
        stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: message });
        const text = { type: "text", text: "" };
        message.content.push(text);
        stream.push({ type: "text_start", contentIndex: 1, partial: message });
        await nextTick();
        for (const delta of ["running npm test", "\nFinal answer"]) {
          text.text += delta;
          stream.push({ type: "text_delta", contentIndex: 1, delta, partial: message });
          await nextTick();
        }
        stream.push({ type: "text_end", contentIndex: 1, content: text.text, partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      script().catch(error => {
        message.stopReason = "error"; message.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: message }); stream.end();
      });
      return stream;
    } });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Only answer the synthetic fixture.",
    extensionFactories: [activity.extension, pi => {
      pi.on("message_update", event => {
        const snapshot = activity.snapshot();
        observed.push({ type: event.assistantMessageEvent.type, snapshot,
          line: renderActivity(snapshot.active_tools, snapshot, theme, 120) });
      });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("activity-fixture", "controlled"), tools: [] });
  childSession = session;
  await session.bindExtensions({});
  activity.begin();
  await session.prompt("Synthetic task");
  assert(observed.some(event => event.snapshot.channel === "thinking" && event.line === "thinking: Inspecting lifecycle"));
  assert(observed.some(event => event.line === "thinking: Next thought"));
  assert(observed.some(event => event.line === "replying…"));
  assert(observed.some(event => event.line === "replying: running npm test"));
  assert(observed.some(event => event.snapshot.channel === "text" && event.line === "replying: Final answer"));
  assert.deepEqual(activity.snapshot(), { active_tools: [], tool_uses: 0, preview: "" });
  assert.equal(activity.inFlight(), undefined);
  const assistant = session.messages.filter(message => message.role === "assistant").at(-1);
  assert.equal(assistant.content[0].thinking, "## **Inspecting lifecycle**\nNext thought", "native transcript is not simplified");
  assert.equal(assistant.content[1].text, "running npm test\nFinal answer");
  assert.equal(network.mock.callCount(), 0);
});
