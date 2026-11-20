// Real Alehouse composition and child Codex transport; all responses are synthetic.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import * as ai from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { initialize } from "../../../scripts/init.mjs";
import { controlledProvider } from "../../support/host.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR,
  home = process.env.HOME;
assert(agentDir && home);
const modelId = "gpt-6.2-sol",
  childModelId = "gpt-6.2-astra",
  primary = "openai-codex",
  secondary = "openai-codex-2";
const codexBase = "http://127.0.0.1:1/backend-api";
const childWire = [];
let unexpectedRequests = 0;
globalThis.fetch = async (url, init) => {
  if (url !== `${codexBase}/codex/responses` || init?.method !== "POST") {
    unexpectedRequests++;
    throw new Error("Unexpected request in Fast fixture");
  }
  const headers = new Headers(init.headers);
  const body = JSON.parse(
    headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(init.body).toString()
      : init.body,
  );
  childWire.push({ body, sessionId: headers.get("session-id") });
  const id = childWire.length;
  const events = [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: `msg_fixture_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "child done", annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: { id: `resp_fixture_${id}`, status: "completed", output: [] },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
};
initialize({ agentDir });
initTheme(undefined, false);
// Pin the real child transport to fetch, never WebSocket. This is isolated fixture state.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ transport: "sse" }));
writeFileSync(
  join(agentDir, "alehouse-codex-speeds.json"),
  JSON.stringify({ [`${primary}/${modelId}`]: "ultrafast", [childModelId]: "fast" }),
);
const slot = { model: `${secondary}/${childModelId}`, effort: "off" };
writeFileSync(
  join(agentDir, "alehouse-presets.json"),
  JSON.stringify({
    version: 3,
    defaultPreset: "fast-fixture",
    presets: {
      "fast-fixture": { version: "1", slots: { d1: slot, d2: slot, d3: slot, d4: slot, d5: slot } },
    },
  }),
);
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false,
});
const fake = controlledProvider(ai);
const parentWire = [];
runtime.registerProvider(primary, {
  ...fake.config,
  api: "openai-codex-responses",
  models: [{ ...fake.config.models[0], id: modelId }],
  streamSimple(model, context, options) {
    const body = { model: model.id };
    parentWire.push({ body, result: options?.onPayload?.(body, model) });
    return fake.config.streamSimple(model, context, options);
  },
});
const claims = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64");
runtime.registerProvider(secondary, {
  baseUrl: codexBase,
  apiKey: `fixture.${claims}.fixture`,
  api: "openai-codex-responses",
  models: [{ ...fake.config.models[0], id: childModelId }],
});
const model = runtime.getModel(primary, modelId);
assert(model);

const cwd = join(home, "project"),
  sessions = join(home, "sessions");
mkdirSync(join(cwd, ".pi"), { recursive: true });
// Project-local speed settings are untrusted and must not override the global file.
writeFileSync(
  join(cwd, ".pi", "alehouse-codex-speeds.json"),
  JSON.stringify({ [`${primary}/${modelId}`]: "fast", [childModelId]: "ultrafast" }),
);
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
  cacheWarming: "off",
});
const compositionPath = join(packageRoot, "src/composition.ts");
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  additionalExtensionPaths: [compositionPath],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader: loader,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  settingsManager,
  sessionManager: SessionManager.create(cwd, sessions),
  tools: ["agent_spawn", "agent_run"],
});
const agentSessions = new Map();
const errors = [];
async function runTurn(turn, { agent, spawn, tier, childTier = tier }) {
  const parentStart = parentWire.length,
    childStart = childWire.length;
  const tool = spawn ? "agent_spawn" : "agent_run";
  const args = { agent, prompt: `Fixture task ${turn}`, label: `Task ${turn}`, wait_ms: 60000 };
  fake.respond(async ({ context }) => {
    if (context.messages.at(-1)?.role === "toolResult") return { text: "parent done" };
    return {
      tools: [
        {
          type: "toolCall",
          id: `fixture-${turn}`,
          name: tool,
          arguments: spawn
            ? { ...args, profile: "worker", reasoning_difficulty: 1 }
            : { ...args, continues: "Continue the previous fixture task" },
        },
      ],
    };
  });
  await session.prompt(`Run fixture task ${turn}`, { expandPromptTemplates: false });
  const result = session.messages.findLast((message) => message.toolCallId === `fixture-${turn}`);
  assert.equal(result?.isError, false, JSON.stringify({ result, errors }));
  const reply = JSON.parse(result.content[0].text);
  assert.equal(reply.reason, "done", JSON.stringify(reply));
  assert.equal(reply.tasks[0].result, "child done");
  const parentRequests = parentWire.slice(parentStart);
  assert.equal(parentRequests.length, 2);
  for (const { body, result } of parentRequests)
    assert.deepEqual((await result) ?? body, tier ? { ...body, service_tier: tier } : body);

  const childRequests = childWire.slice(childStart);
  assert.equal(childRequests.length, 1);
  const { body, sessionId } = childRequests[0];
  assert.equal(body.model, childModelId, "the numbered slot sent a real Codex Astra body");
  assert.equal(body.service_tier, childTier);
  assert.equal(Object.hasOwn(body, "service_tier"), childTier !== undefined);
  assert(sessionId && sessionId !== session.sessionId);
  if (spawn) {
    assert(![...agentSessions.values()].includes(sessionId));
    agentSessions.set(agent, sessionId);
  } else {
    assert.equal(sessionId, agentSessions.get(agent), "follow-up reuses the same child session");
  }
}
try {
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  // Pi can expose duplicate extension commands as /fast:1, /fast:2, etc.
  assert.deepEqual(
    session.extensionRunner
      .getRegisteredCommands()
      .filter(({ name, invocationName }) => name === "fast" || invocationName.startsWith("fast:"))
      .map(({ name, invocationName, sourceInfo }) => [name, invocationName, sourceInfo.path]),
    [["fast", "fast", compositionPath]],
    "the real Alehouse composition owns the sole /fast registration, with no renamed conflicts",
  );
  await runTurn(1, { agent: "swift", spawn: true });
  await session.prompt("/fast on");
  await session.prompt("/fast on");
  await session.prompt("/fast status");
  await runTurn(2, { agent: "swift", tier: "priority" });
  await runTurn(3, { agent: "tern", spawn: true, tier: "priority" });
  await session.prompt("/fast ultrafast");
  await runTurn(4, { agent: "swift", tier: "ultrafast", childTier: "priority" });
  await runTurn(5, { agent: "lark", spawn: true, tier: "ultrafast", childTier: "priority" });
  await session.prompt("/fast on");
  await runTurn(6, { agent: "lark", tier: "priority" });
  await session.prompt("/fast ultrafast");
  await session.prompt("/fast off");
  await session.prompt("/fast off");
  await runTurn(7, { agent: "tern" });
  await session.prompt("/fast ultrafast");
  await session.prompt("/fast");
  await runTurn(8, { agent: "lark" });
  assert.deepEqual(errors, []);
  assert.equal(unexpectedRequests, 0);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
console.log(
  "PASS: one parent /fast changes parent requests and serialized Codex requests from existing and new Agents, offline",
);
