// Shared offline fixture for /fast and child retry. Real composition and Codex
// transport; only the responses are synthetic.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const scenario = process.argv[2];
const retryFixture = scenario !== undefined;
assert(
  scenario === undefined || scenario === "retry-disk-enabled" || scenario === "retry-disk-disabled",
);
if (retryFixture) {
  assert.equal(process.env.ALEHOUSE_CHILD_RETRY_FIXTURE_HOME, home);
  assert.equal(agentDir, join(home, "agent"));
}
const diskRetryEnabled = scenario === "retry-disk-enabled";
const diskRetry = {
  enabled: diskRetryEnabled,
  maxRetries: diskRetryEnabled ? 3 : 5,
  baseDelayMs: 30,
  maxAgentDelayMs: 90,
  provider: { maxRetries: 2 },
};
const overloaded = "503 overloaded synthetic retry";
const modelId = "gpt-6.2-sol",
  childModelId = "gpt-6.2-astra",
  primary = "openai-codex",
  secondary = "openai-codex-2";
const codexBase = "http://127.0.0.1:1/backend-api";
const childWire = [];
const readingKey = Symbol.for("pi-alehouse:quota-reading:v1");
const readings = [];
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
  if (retryFixture) {
    // The real Codex transport can retry this HTTP failure internally. Make
    // those unwanted retries fast too, so they fail the counts, not a watchdog.
    return Response.json(
      { error: { message: overloaded } },
      {
        status: 503,
        headers: { "retry-after-ms": "0" },
      },
    );
  }
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
    headers: {
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": String(id + 0.25),
      "x-codex-primary-window-minutes": "300",
    },
  });
};
initialize({ agentDir });
initTheme(undefined, false);
// Pin the real child transport to fetch, never WebSocket. This is isolated fixture state.
const settingsPath = join(agentDir, "settings.json");
const userSettings = JSON.stringify({
  transport: "sse",
  ...(retryFixture && { retry: diskRetry, compaction: { enabled: false }, cacheWarming: "off" }),
});
writeFileSync(settingsPath, userSettings, { flag: "wx" });
writeFileSync(
  join(agentDir, "alehouse-codex-speeds.json"),
  JSON.stringify({ [`${primary}/${modelId}`]: "ultrafast", [childModelId]: "fast" }),
);
const slot = { model: `${secondary}/${childModelId}`, effort: "high" };
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
// Exercise the SDK's shipped GPT-6.2 capabilities, but never its remote endpoint.
const astra = runtime.getModel(primary, childModelId);
assert(astra && !ai.getSupportedThinkingLevels(astra).includes("off"));
const fake = controlledProvider(ai);
const parentWire = [];
runtime.registerProvider(primary, {
  baseUrl: fake.config.baseUrl,
  apiKey: fake.config.apiKey,
  api: "openai-codex-responses",
  streamSimple(model, context, options) {
    const body = { model: model.id };
    parentWire.push({
      body,
      result: options?.onPayload?.(body, model),
      maxRetries: options?.maxRetries,
    });
    return fake.config.streamSimple(model, context, options);
  },
});
const claims = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64");
const childAttempts = [];
const codexStreamSimple = retryFixture
  ? (await import("@earendil-works/pi-ai/api/openai-codex-responses")).streamSimple
  : undefined;
runtime.registerProvider(secondary, {
  baseUrl: codexBase,
  apiKey: `fixture.${claims}.fixture`,
  api: "openai-codex-responses",
  models: [{ ...astra, baseUrl: codexBase }],
  ...(codexStreamSimple && {
    streamSimple(model, context, options) {
      childAttempts.push({
        sessionId: options?.sessionId,
        maxRetries: options?.maxRetries,
      });
      // Do not let an accidental transport change escape the fetch stub.
      assert.equal(options?.transport, "sse");
      return codexStreamSimple(model, context, options);
    },
  }),
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
if (retryFixture) mkdirSync(join(cwd, ".git")); // Bound project discovery to the fixture.
const settingsManager = retryFixture
  ? SettingsManager.create(cwd, agentDir)
  : SettingsManager.inMemory({
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
  thinkingLevel: "low",
  settingsManager,
  sessionManager: SessionManager.create(cwd, sessions),
  tools: ["agent_spawn", "agent_run"],
});
const agentSessions = new Map();
const errors = [];
async function requestTask(turn, { agent, spawn }) {
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
  return JSON.parse(result.content[0].text);
}
async function runTurn(turn, { agent, spawn, tier, childTier = tier }) {
  const parentStart = parentWire.length,
    childStart = childWire.length,
    readingStart = readings.length;
  const reply = await requestTask(turn, { agent, spawn });
  assert.equal(reply.reason, "done", JSON.stringify(reply));
  assert.equal(reply.tasks[0].result, "child done");
  const parentRequests = parentWire.slice(parentStart);
  assert.equal(parentRequests.length, 2);
  for (const { body, result } of parentRequests)
    assert.deepEqual((await result) ?? body, tier ? { ...body, service_tier: tier } : body);

  const childRequests = childWire.slice(childStart);
  assert.equal(childRequests.length, 1);
  const { body, sessionId } = childRequests[0];
  assert.deepEqual(
    readings.slice(readingStart).map(({ observedAt, ...reading }) => {
      assert.ok(Number.isFinite(observedAt) && observedAt > 0);
      return reading;
    }),
    [
      {
        provider: secondary,
        windows: [
          { pool: "codex", window: "primary", used_pct: childStart + 1.25, duration_s: 18_000 },
        ],
      },
    ],
    "exactly the physical worker, not the selected parent model, supplied this quota reading",
  );
  assert.equal(body.model, childModelId, "the numbered slot sent a real Codex Astra body");
  assert.equal(body.max_output_tokens, astra.maxTokens);
  assert.equal(
    body.input.findLast((item) => item.type === "configuration_update")?.reasoning.effort,
    slot.effort,
    "the Agent keeps its configured effort independently of parent speed and thinking",
  );
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
async function assertRetryRun(turn, expectedAttempts, parentSettings) {
  const attemptStart = childAttempts.length;
  const wireStart = childWire.length;
  const parentStart = parentWire.length;
  const agent = `retry-worker-${turn}`;
  const reply = await requestTask(turn, { agent, spawn: true });
  const attempts = childAttempts.slice(attemptStart);
  const requests = childWire.slice(wireStart);
  assert(attempts.length > 0, "spawned worker reached the real Codex transport");
  for (const { maxRetries } of attempts)
    assert.equal(maxRetries, 0, "child transport retries must stay off after resource loading");
  assert.equal(attempts.length, expectedAttempts, "initial attempt plus SDK agent retries");
  assert.equal(requests.length, expectedAttempts, "one fetch per attempt; no transport retries");
  const [{ sessionId: childId }] = attempts;
  assert(childId && childId !== session.sessionId);
  assert(![...agentSessions.values()].includes(childId), "the spawn created a fresh SDK session");
  agentSessions.set(agent, childId);
  assert(
    attempts.every(({ sessionId }) => sessionId === childId),
    "SDK retried one child",
  );
  assert(requests.every(({ sessionId }) => sessionId === childId));
  assert.equal(reply.reason, "task_issue", JSON.stringify(reply));
  assert.equal(reply.tasks.length, 1);
  assert.equal(reply.tasks[0].status, "failed");
  assert.match(reply.tasks[0].error, /503 overloaded synthetic retry/);
  const parentBudget = parentSettings.retry.provider.maxRetries;
  assert.deepEqual(
    parentWire.slice(parentStart).map(({ maxRetries }) => maxRetries),
    [parentBudget, parentBudget],
    "the parent still uses its nonzero provider retry budget",
  );
  assert.deepEqual(
    settingsManager.getSettings(),
    parentSettings,
    "child left parent memory intact",
  );
}

let expectedParentSettings;
async function runRetryCases() {
  const diskSettings = settingsManager.getSettings();
  assert.deepEqual(diskSettings.retry, diskRetry, "parent started with file settings");
  if (diskRetryEnabled) await assertRetryRun(1, 4, diskSettings);

  // Apply after loader.reload() and the real session bind. The next spawn must
  // sample the live parent, not the file or a snapshot taken at parent startup.
  const liveRetry = {
    enabled: !diskRetryEnabled,
    maxRetries: diskRetryEnabled ? 4 : 2,
    baseDelayMs: 11,
    maxAgentDelayMs: 19,
    provider: { maxRetries: 4 },
  };
  settingsManager.applyOverrides({ retry: liveRetry });
  expectedParentSettings = { ...diskSettings, retry: liveRetry };
  assert.deepEqual(settingsManager.getSettings(), expectedParentSettings);
  // Pi emits auto_retry_start only to AgentSession subscribers, not extensions.
  // Assert request counts, not wall-clock timing; backoff policy is tested separately.
  await assertRetryRun(2, diskRetryEnabled ? 1 : 3, expectedParentSettings);
}
async function runFastCases() {
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
}
try {
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  if (retryFixture) await runRetryCases();
  else {
    globalThis[readingKey] = (reading) => {
      readings.push(reading);
    };
    await runFastCases();
  }
  assert.deepEqual(errors, []);
  assert.equal(unexpectedRequests, 0);
} finally {
  delete globalThis[readingKey];
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
if (retryFixture) {
  assert.deepEqual(
    settingsManager.getSettings(),
    expectedParentSettings,
    "parent memory survives quit",
  );
  assert.equal(readFileSync(settingsPath, "utf8"), userSettings, "Pi settings stay unchanged");
  console.log(`PASS: child ${scenario}, offline`);
} else {
  console.log(
    "PASS: one parent /fast changes parent requests and serialized Codex requests from existing and new Agents, offline",
  );
}
