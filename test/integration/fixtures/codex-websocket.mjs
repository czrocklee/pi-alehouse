// Real SDK transport and composition against loopback only; no real account or endpoint.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { initialize } from "../../../scripts/init.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR,
  home = process.env.HOME;
assert(agentDir && home);
const provider = "openai-codex",
  modelId = "gpt-6.2-sol",
  codexPath = "/backend-api/codex/responses",
  resetAt = Math.floor(Date.now() / 1_000) + 3600;
const readingKey = Symbol.for("pi-alehouse:quota-reading:v1");
const wsBodies = [],
  sseBodies = [],
  readings = [],
  unexpected = [];
let upgrades = 0,
  allowUpgrade = true;

function responseEvents(id, text) {
  return [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: `msg_fixture_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: { id: `resp_fixture_${id}`, status: "completed", output: [] },
    },
  ];
}
const quotaHeaders = (percent) => ({
  "x-codex-primary-used-percent": String(percent),
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(resetAt),
});
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url === codexPath && !allowUpgrade) {
      const raw = Buffer.concat(chunks);
      const body = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
      sseBodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream", ...quotaHeaders(12) });
      res.end(
        responseEvents("sse", "SSE response")
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    } else {
      unexpected.push([req.method, req.url]);
      res.writeHead(404).end();
    }
  });
});
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== codexPath) {
    unexpected.push(["upgrade", req.url]);
    socket.destroy();
    return;
  }
  upgrades++;
  if (allowUpgrade) {
    sockets.handleUpgrade(req, socket, head, (peer) => sockets.emit("connection", peer, req));
  } else {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  }
});
sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    wsBodies.push(JSON.parse(raw));
    const turn = wsBodies.length;
    socket.send(
      JSON.stringify({
        type: "codex.rate_limits",
        limit_name: "codex",
        rate_limits: {
          primary: { used_percent: turn < 3 ? 10 : 11, window_minutes: 300, reset_at: resetAt },
        },
        credits: { has_credits: true, unlimited: false, balance: "9.25" },
      }),
    );
    for (const event of responseEvents(turn, `WS response ${turn}`))
      socket.send(JSON.stringify(event));
  });
});
server.listen(0, "127.0.0.1");
try {
  await once(server, "listening");
} catch (error) {
  // A sandbox may forbid even an ephemeral IPv4 loopback listener. Only an
  // explicit permission denial at bind time skips this transport fixture.
  if (error.code === "EACCES" || error.code === "EPERM") process.exit(77);
  throw error;
}
const base = `http://127.0.0.1:${server.address().port}`;
const fetchLoopback = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) !== base + codexPath) {
    unexpected.push(["fetch", "non-fixture endpoint"]);
    throw new Error("Attempted fetch outside the loopback fixture");
  }
  return fetchLoopback(url, init);
};

let session;
try {
  initialize({ agentDir });
  writeFileSync(
    join(agentDir, "alehouse-codex-speeds.json"),
    JSON.stringify({ [`${provider}/${modelId}`]: "ultrafast" }),
  );
  initTheme(undefined, false);
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    transport: "auto",
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
  ).toString("base64");
  runtime.registerProvider(provider, {
    baseUrl: `${base}/backend-api`,
    apiKey: `fixture.${claims}.fixture`,
  });
  const model = runtime.getModel(provider, modelId);
  assert.equal(model?.baseUrl, `${base}/backend-api`, "use Pi's bundled Sol on loopback only");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [join(packageRoot, "src/composition.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  }));
  const errors = [];
  await session.bindExtensions({ mode: "rpc", onError: ({ error }) => errors.push(error) });
  globalThis[readingKey] = (reading) => {
    readings.push(reading);
  };
  for (const turn of [1, 2, 3, 4, 5, 6, 7]) {
    if (turn === 2 || turn === 7) await session.prompt("/fast");
    if (turn === 4) await session.prompt("/fast ultrafast");
    if (turn === 6) await session.prompt("/fast on");
    await session.prompt(`Fixture prompt ${turn}`);
    assert.equal(session.getLastAssistantText(), `WS response ${turn}`);
  }
  assert.equal(upgrades, 1, "the seven turns must reuse one actual WebSocket connection");
  assert.equal(wsBodies.length, 7);
  // A speed change must not lower the normal session's output or reasoning budget.
  // Pi sends the initial effort on the request; only later changes need an input item.
  const assertBudget = (body) => {
    assert.equal(body.max_output_tokens, model.maxTokens);
    assert.equal(body.reasoning?.effort, "high");
    for (const item of body.input) {
      if (item.type === "configuration_update") assert.equal(item.reasoning?.effort, "high");
    }
  };
  assert(model.maxTokens > 2048);
  for (const body of wsBodies) {
    assert.equal(body.type, "response.create");
    assert.equal(body.model, modelId);
    assertBudget(body);
  }
  assert.deepEqual(
    wsBodies.map((body) => body.service_tier),
    [undefined, "priority", "priority", "ultrafast", "ultrafast", "priority", undefined],
  );
  assert.deepEqual(
    wsBodies.map((body) => body.previous_response_id),
    [undefined, undefined, "resp_fixture_2", undefined, "resp_fixture_4", undefined, undefined],
    "continuation is reused only while the tier is unchanged",
  );

  const [peer] = sockets.clients;
  assert(peer);
  allowUpgrade = false;
  const closed = once(peer, "close");
  peer.close();
  await closed;
  await session.prompt("/fast ultrafast");
  await session.prompt("Fixture fallback prompt");
  assert.equal(session.getLastAssistantText(), "SSE response");
  assert.equal(upgrades, 2, "auto tries a new WebSocket before falling back");
  assert.equal(sseBodies.length, 1);
  assert.equal(sseBodies[0].model, modelId);
  assert.equal(sseBodies[0].service_tier, "ultrafast");
  assertBudget(sseBodies[0]);

  assert.deepEqual(
    readings.map(({ observedAt, ...reading }) => {
      assert.ok(observedAt > resetAt - 3601 && observedAt < resetAt);
      return reading;
    }),
    [10, 10, 11, 11, 11, 11, 11, 12].map((percent) => ({
      provider,
      windows: [
        {
          pool: "codex",
          window: "primary",
          used_pct: percent,
          duration_s: 18000,
          resets_at: resetAt,
        },
      ],
    })),
    "the synchronous sink sees each real reading from either transport, not credits or auth",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "PASS: Codex auto reuses WebSocket across /fast changes and emits quota readings before and after SSE fallback, loopback only",
  );
} finally {
  try {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    delete globalThis[readingKey];
    globalThis.fetch = fetchLoopback;
    for (const peer of sockets.clients) peer.terminate();
    sockets.close();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}
