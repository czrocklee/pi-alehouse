// Real development SDK prompt assembly with deterministic provider IO; no
// credentials, network or live model. Proves the delegation guideline follows
// agent_spawn's visibility request by request, including a mid-run switch.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { delegationGuideline } from "../../dist/tools/parent-tools.js";
import { cleanupToolNames, managementToolNames, workerToolSelection } from "../../dist/tools/tool-names.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "harness-guideline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json") });
  runtime.registerProvider("harness-guideline", {
    api: "harness-guideline", apiKey: "synthetic-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "controlled", name: "Controlled", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
    streamSimple(model, context) {
      const request = { system: ai.getCurrentSystemPrompt(context.messages), tools: ai.getCurrentTools(context.messages).map((tool) => tool.name) };
      requests.push(request);
      const stream = ai.createAssistantMessageEventStream();
      const content = respond(request, requests.length);
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", usage, timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
  let pi;
  // Stand-ins with the harness names; only agent_spawn carries the real guideline,
  // as createOwnerTools does. `switch_off` plays a mid-run /harness-preset off.
  const stub = (name, extra = {}) => ({ name, label: name, description: `fixture ${name}`,
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }), ...extra });
  const extension = (api) => {
    pi = api;
    for (const name of managementToolNames) api.registerTool(stub(name, name === "agent_spawn" ? { promptGuidelines: [delegationGuideline] } : {}));
    api.registerTool(stub("switch_off", { execute: async () => {
      api.setActiveTools(workerToolSelection(api.getActiveTools(), false, true));
      return { content: [{ type: "text", text: "off" }] };
    } }));
  };
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [extension] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
    settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), modelRuntime: runtime,
    model: runtime.getModel("harness-guideline", "controlled") });
  await session.bindExtensions({});
  const select = (enabled, accepted) => pi.setActiveTools(workerToolSelection(pi.getActiveTools(), enabled, accepted));
  return { session, requests, select, pi };
}
const count = (text) => text.split(delegationGuideline).length - 1;
const stop = [{ type: "text", text: "done" }];

test("real SDK: the guideline is present exactly while agent_spawn is visible", { timeout: 10000 }, async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("guideline fixture attempted network IO"); });
  const f = await fixture(t, () => stop);
  f.select(false, false);
  await f.session.prompt("off, nothing accepted");
  f.select(true, false);
  await f.session.prompt("enabled");
  await f.session.prompt("enabled again");
  f.select(false, true);
  await f.session.prompt("off with retained results");
  const [off, on, again, cleanup] = f.requests;
  assert.equal(count(off.system), 0);
  assert(!off.tools.some((name) => managementToolNames.includes(name)));
  assert.equal(count(on.system), 1, "exactly one copy, in Guidelines");
  assert.match(on.system, new RegExp(`- ${delegationGuideline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert(on.tools.includes("agent_spawn"));
  assert.equal(again.system, on.system, "a stable mode renders byte-identical prompts for the prefix cache");
  assert.equal(count(cleanup.system), 0, "cleanup-only Off keeps no policy text");
  assert.deepEqual(cleanup.tools.filter((name) => managementToolNames.includes(name)), cleanupToolNames);
});

test("real SDK: a mid-run switch to Off drops the guideline in the same request as agent_spawn", { timeout: 10000 }, async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("guideline fixture attempted network IO"); });
  const f = await fixture(t, (_request, index) => index === 1
    ? [{ type: "toolCall", id: "switch", name: "switch_off", arguments: {} }] : stop);
  f.select(true, false);
  f.pi.setActiveTools([...f.pi.getActiveTools(), "switch_off"]);
  await f.session.prompt("switch presets while running");
  const [before, after] = f.requests;
  assert.equal(f.requests.length, 2, "one run, two requests");
  assert.equal(count(before.system), 1);
  assert(before.tools.includes("agent_spawn"));
  assert.equal(count(after.system), 0, "the next turn of the same run already lacks the guideline");
  assert(!after.tools.includes("agent_spawn"));
});
