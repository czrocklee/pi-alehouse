#!/usr/bin/env node
// Child-only privacy/billing probe: every response and credential is fabricated.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
const [mode, directory] = process.argv.slice(2);
assert(["default", "billing", "dashboard"].includes(mode) && directory);
process.env.HOME = directory;
process.env.PI_CODING_AGENT_DIR = join(directory, "custom-agent");
process.env.GROK_HOME = join(directory, "grok");
delete process.env.AGENT_DASHBOARD_URL;
delete process.env.PI_ALEHOUSE_GROK_BILLING;
if (mode === "billing") process.env.PI_ALEHOUSE_GROK_BILLING = "1";
if (mode === "dashboard") process.env.AGENT_DASHBOARD_URL = "https://dashboard.invalid";
process.env.GROK_CLI_CHAT_PROXY_BASE_URL = "https://billing.invalid/v1";
const authPath = join(process.env.PI_CODING_AGENT_DIR, "auth.json");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(
  authPath,
  JSON.stringify({ xai: { type: "oauth", access: "SYNTHETIC-NOT-A-CREDENTIAL" } }),
);
const authReads = [],
  requests = [],
  read = fs.readFileSync;
const realSetTimeout = globalThis.setTimeout,
  realClearTimeout = globalThis.clearTimeout;
const realPerformance = globalThis.performance;
let now = 0,
  holdBilling = mode === "billing",
  releaseBilling,
  billingOK = true,
  billedPercent = 25;
const timers = new Map();
const flush = () => new Promise((done) => realSetTimeout(done, 0));
const advance = async (value) => {
  now = value;
  for (const [handle, timer] of [...timers])
    if (timer.at <= now) {
      timers.delete(handle);
      timer.callback();
    }
  await flush();
};
fs.readFileSync = function (path, ...args) {
  if (String(path).endsWith("/auth.json")) {
    authReads.push(String(path));
    assert.equal(String(path), authPath, "Never consult a hardcoded or ambient auth path");
  }
  return read.call(this, path, ...args);
};
const forbiddenNetwork = () => {
  throw new Error("Only the strict synthetic fetch fixture is allowed");
};
http.request =
  http.get =
  https.request =
  https.get =
  net.connect =
  net.createConnection =
  tls.connect =
    forbiddenNetwork;
net.Socket.prototype.connect = forbiddenNetwork;
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  assert(
    [
      "https://billing.invalid/v1/billing?format=credits",
      "https://dashboard.invalid/api/usage/codex",
    ].includes(String(url)),
    `Unexpected fixture network destination: ${url}`,
  );
  requests.push({ url: String(url), options });
  const percent = billedPercent,
    ok = billingOK;
  if (holdBilling && String(url).includes("/billing?"))
    await new Promise((done) => {
      releaseBilling = done;
    });
  return { ok, json: async () => ({ config: { creditUsagePercent: percent } }) };
};
try {
  const { default: extension } = await createJiti(import.meta.url).import(
    join(resolve(import.meta.dirname, "../.."), "src/extensions/status-footer.ts"),
  );
  const handlers = new Map();
  if (mode === "billing") {
    globalThis.performance = { now: () => now };
    globalThis.setTimeout = (callback, milliseconds) => {
      const handle = { unref() {} };
      timers.set(handle, { callback, at: now + milliseconds });
      return handle;
    };
    globalThis.clearTimeout = (handle) => timers.delete(handle);
  }
  let footer;
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  let renderThrows = false,
    renderFailures = 0;
  const tui = {
    mode: "fullscreen",
    terminal: { rows: 24, columns: 400 },
    render: () => [],
    requestRender() {
      if (renderThrows) {
        renderFailures++;
        throw new Error("synthetic-render-failure");
      }
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: false,
    cwd: directory,
    model: { provider: "xai", id: "synthetic", api: "openai-responses", contextWindow: 1000 },
    modelRegistry: { isUsingOAuth: () => false },
    getSystemPrompt: () => "",
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
    sessionManager: {
      getSessionId: () => "synthetic-privacy",
      getLeafId: () => null,
      getEntryCount: () => 0,
      getEntries: () => [],
    },
    ui: {
      setFooter(factory) {
        footer = factory(tui, theme, {
          getGitBranch: () => undefined,
          getExtensionStatuses: () => [],
          onBranchChange: () => () => {},
        });
      },
    },
  };
  extension({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on: () => () => {}, emit() {} },
  });
  const emit = async (event, payload = {}, provider = ctx.model.provider, api = ctx.model.api) => {
    Object.assign(ctx.model, { provider, api });
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const paint = () => footer.render(400)[0];
  await emit("session_start");
  if (mode === "billing") assert.match(paint(), /billing \[not checked\]/);
  else assert.doesNotMatch(paint(), /billing|updated \d+s ago/);
  assert.equal(authReads.length, 0, "enabling the display alone does not read auth");
  await emit("after_provider_response", {}, "xai");
  await emit("agent_settled", {}, "xai");
  if (mode === "billing") {
    assert.match(
      paint(),
      /billing \[pending\]/,
      "no fabricated quota before the first successful sample",
    );
    holdBilling = false;
    releaseBilling();
  }
  await flush();
  const codexHeaders = {
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "2000000000",
  };
  const paidHeaders = {
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
    "x-codex-credits-balance": "123.4500",
  };
  const combinedHeaders = { ...codexHeaders, ...paidHeaders },
    combinedBefore = structuredClone(combinedHeaders);
  await emit(
    "after_provider_response",
    { headers: combinedHeaders },
    "openai-codex",
    "openai-codex-responses",
  );
  assert.deepEqual(
    combinedHeaders,
    combinedBefore,
    "dashboard filtering must not mutate source headers",
  );
  // Other accounts cannot overwrite the account-less dashboard payload. OpenAI
  // ChatGPT auth is not a Codex quota source and cannot trigger auth resolution.
  await emit(
    "after_provider_response",
    { headers: { ...codexHeaders, "x-codex-primary-used-percent": "40" } },
    "openai-codex-2",
    "openai-codex-responses",
  );
  await emit("after_provider_response", { headers: codexHeaders }, "openai", "openai-responses");
  await flush();
  const requestCount = requests.length,
    authReadCount = authReads.length;
  await emit(
    "after_provider_response",
    { headers: paidHeaders },
    "openai-codex",
    "openai-codex-responses",
  );
  await emit(
    "after_provider_response",
    { headers: { ...codexHeaders, ...paidHeaders, "x-codex-credits-balance": "9" } },
    "openai-codex",
    "openai-codex-responses",
  );
  for (const provider of ["openai-codex", "openai-codex-2"]) {
    const data = {
      type: "codex.rate_limits",
      credits: { has_credits: true, unlimited: false, balance: "17.5" },
      rate_limits: { primary: { used_percent: 90, window_minutes: 300, reset_at: 2000000000 } },
    };
    const before = structuredClone(data);
    await emit(
      "provider_stream_event",
      { provider, api: "openai-codex-responses", model: "synthetic-codex", data },
      "openai",
      "openai-responses",
    );
    assert.deepEqual(data, before, "raw stream payloads are not mutated");
  }
  await flush();
  assert.equal(
    requests.length,
    requestCount,
    "credits-only changes and stream updates never publish or fetch",
  );
  assert.equal(authReads.length, authReadCount, "paid credits never trigger an auth read");
  if (mode === "default") {
    assert.deepEqual(authReads, []);
    assert.deepEqual(requests, []);
  }
  if (mode === "billing") {
    await emit("model_select", {}, "xai", "openai-responses");
    assert.match(paint(), /W 75% \[pending; updated 0s ago\]/);
    assert.equal(requests.length, 1);
    assert.equal(authReads.length, 1);
    for (let turn = 0; turn < 100; turn++) await emit("agent_settled");
    assert.equal(timers.size, 1, "duplicate idle events do not accumulate work or timers");
    await advance(9999);
    assert.equal(requests.length, 1);
    assert.match(
      paint(),
      /pending; updated 9s ago/,
      "throttled quota visibly states its successful sample age",
    );
    holdBilling = true;
    billedPercent = 40;
    renderThrows = true;
    await advance(10000);
    assert.equal(requests.length, 2);
    renderThrows = false;
    for (let turn = 0; turn < 20; turn++) await emit("agent_settled");
    assert.equal(requests.length, 2, "inflight requests coalesce");
    renderThrows = true;
    holdBilling = false;
    releaseBilling();
    await flush();
    renderThrows = false;
    assert(
      renderFailures >= 2,
      "failed start/finish repaint cannot strand billing or escape its async boundary",
    );
    assert.match(paint(), /W 60% \[updated 0s ago\]/);
    assert.equal(
      timers.size,
      0,
      "a final sample covering all dirty work leaves no unnecessary trailing fetch",
    );
    await advance(20000);
    assert.equal(requests.length, 2);

    await emit("after_provider_response");
    assert.equal(
      [...timers.values()][0].at,
      70000,
      "ordinary refresh retains its sixty-second minimum",
    );
    holdBilling = true;
    await emit("agent_settled");
    assert.equal(requests.length, 3);
    await emit("after_provider_response");
    await emit("agent_settled");
    assert.equal(
      requests.length,
      3,
      "new activity during a billing request does not create parallel requests",
    );
    holdBilling = false;
    releaseBilling();
    await flush();
    assert.match(
      paint(),
      /W 60% \[pending; updated 0s ago\]/,
      "an unchanged valid quota still updates its successful sample timestamp",
    );
    assert.equal(timers.size, 1);
    assert.equal(
      [...timers.values()][0].at,
      30000,
      "new final activity coalesces into exactly one ten-second trailing refresh",
    );
    await advance(29999);
    assert.equal(requests.length, 3);
    billedPercent = 55;
    await advance(30000);
    assert.equal(requests.length, 4);
    assert.match(paint(), /W 45% \[updated 0s ago\]/);
    assert.equal(timers.size, 0);
    await advance(40000);
    assert.equal(requests.length, 4);

    await emit("after_provider_response");
    assert.equal(timers.size, 1);
    const authBeforeLeave = authReads.length;
    await emit("model_select", {}, "other", "openai-responses");
    assert.equal(timers.size, 0, "leaving xai cancels delayed billing before it reads credentials");
    assert.doesNotMatch(paint(), /W 45%|updated \d+s ago/);
    await advance(100000);
    assert.equal(requests.length, 4);
    assert.equal(authReads.length, authBeforeLeave);
    billedPercent = 65;
    await emit("model_select", {}, "xai");
    await flush();
    assert.equal(
      requests.length,
      5,
      "returning resumes the outstanding final activity, not a lost quota update",
    );
    assert.match(paint(), /W 35% \[updated 0s ago\]/);
    await emit("model_select", {}, "other");
    await emit("model_select", {}, "xai");
    await flush();
    assert.equal(requests.length, 5, "a clean leave/return does not invent another refresh");

    await emit("after_provider_response");
    await emit("agent_settled");
    billingOK = false;
    await advance(110000);
    assert.equal(requests.length, 6);
    assert.match(
      paint(),
      /W 35% \[stale; updated 10s ago\]/,
      "failed attempts never reset the last successful sample age",
    );
    assert.equal(timers.size, 0, "failures do not create autonomous retry polling");
    await advance(171000);
    assert.equal(requests.length, 6);
    assert.match(paint(), /stale; updated 71s ago/);

    holdBilling = true;
    billingOK = true;
    billedPercent = 80;
    await emit("after_provider_response");
    await emit("agent_settled");
    assert.equal(requests.length, 7);
    await emit("model_select", {}, "other");
    await emit("model_select", {}, "xai");
    holdBilling = false;
    releaseBilling();
    await flush();
    assert.match(
      paint(),
      /W 35% \[pending; updated 71s ago\]/,
      "a retired in-flight snapshot cannot publish after a model round trip",
    );
    assert.equal(requests.length, 7);
    await advance(181000);
    assert.equal(requests.length, 8);
    assert.match(paint(), /W 20% \[updated 0s ago\]/);
    await emit("after_provider_response");
    await emit("agent_settled");
    assert.equal(timers.size, 1);
    await emit("session_shutdown");
    assert.equal(timers.size, 0);
    await advance(250000);
    await emit("agent_settled");
    assert.equal(requests.length, 8, "shutdown retires all queued billing work");
    assert.equal(
      authReads.length,
      8,
      "only the actual throttled attempts read the synthetic auth file",
    );
    assert(
      requests.every(
        ({ url, options }) =>
          url === "https://billing.invalid/v1/billing?format=credits" &&
          options.headers.Authorization === "Bearer SYNTHETIC-NOT-A-CREDENTIAL",
      ),
    );
  }
  if (mode === "dashboard") {
    assert.deepEqual(authReads, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://dashboard.invalid/api/usage/codex");
    assert.equal(requests[0].options.method, "POST");
    assert(!requests[0].options.headers.Authorization);
    assert.deepEqual(
      JSON.parse(requests[0].options.body),
      { headers: codexHeaders },
      "dashboard receives quota headers only",
    );
    assert.doesNotMatch(
      requests[0].options.body,
      /credits|123\.4500/,
      "no paid-credit details cross the dashboard boundary",
    );
  }
  await emit("session_shutdown");
  footer.dispose();
  console.log(`PASS: footer privacy ${mode}`);
} finally {
  fs.readFileSync = read;
  syncBuiltinESMExports();
  globalThis.performance = realPerformance;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  // Native network hard-fail guards and synthetic fetch remain until exit.
}
