#!/usr/bin/env node
// Child-only privacy probe: every response and credential is fabricated.
import assert from "node:assert/strict";
import fs from "node:fs";
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
fs.writeFileSync(authPath, JSON.stringify({ xai: { type: "oauth", access: "SYNTHETIC-NOT-A-CREDENTIAL" } }));
const authReads = [], requests = [], read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (String(path).endsWith("/auth.json")) {
    authReads.push(String(path));
    assert.equal(String(path), authPath, "Never consult a hardcoded or ambient auth path");
  }
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  return { ok: true, json: async () => ({ config: { creditUsagePercent: 25 } }) };
};
try {
  const { default: footer } = await createJiti(import.meta.url).import(join(resolve(import.meta.dirname, ".."), "extensions/status-footer.ts"));
  const handlers = new Map();
  footer({ on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } });
  const emit = async (event, payload, provider, api) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, { model: { provider, api } });
  };
  const codexHeaders = { "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "2000000000" };
  await emit("after_provider_response", {}, "xai");
  await emit("agent_settled", {}, "xai");
  const paidHeaders = {
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
    "x-codex-credits-balance": "123.4500",
  };
  const combinedHeaders = { ...codexHeaders, ...paidHeaders };
  const combinedBefore = structuredClone(combinedHeaders);
  await emit("after_provider_response", { headers: combinedHeaders }, "openai-codex", "openai-codex-responses");
  assert.deepEqual(combinedHeaders, combinedBefore, "dashboard filtering must not mutate source headers");
  // A second Codex account displays its quota but never publishes it: the
  // dashboard payload names no account, so it would overwrite the first.
  await emit("after_provider_response", { headers: { ...codexHeaders, "x-codex-primary-used-percent": "40" } }, "openai-codex-2", "openai-codex-responses");
  // OpenAI ChatGPT auth is not a Codex quota source. The same headers must not
  // publish, and must not read a credential, just because the provider is openai.
  await emit("after_provider_response", { headers: codexHeaders }, "openai", "openai-responses");
  await new Promise((done) => setTimeout(done, 10));
  const requestCount = requests.length;
  const authReadCount = authReads.length;
  // Paid credit changes are local footer state, never dashboard publications
  // or an excuse to resolve auth / make additional billing requests.
  await emit("after_provider_response", { headers: paidHeaders }, "openai-codex", "openai-codex-responses");
  await emit("after_provider_response", { headers: { ...codexHeaders, ...paidHeaders, "x-codex-credits-balance": "9" } }, "openai-codex", "openai-codex-responses");
  for (const provider of ["openai-codex", "openai-codex-2"]) {
    const data = {
      type: "codex.rate_limits",
      credits: { has_credits: true, unlimited: false, balance: "17.5" },
      // Even a stream carrying quota information must not add a new publisher.
      rate_limits: { primary: { used_percent: 90, window_minutes: 300, reset_at: 2000000000 } },
    };
    const before = structuredClone(data);
    await emit("provider_stream_event", { provider, api: "openai-codex-responses", model: "synthetic-codex", data }, "openai", "openai-responses");
    assert.deepEqual(data, before, "raw stream payloads are not mutated");
  }
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(requests.length, requestCount, "credits-only changes and stream updates never publish or fetch");
  assert.equal(authReads.length, authReadCount, "paid credits never trigger an auth read");
  if (mode === "default") { assert.deepEqual(authReads, []); assert.deepEqual(requests, []); }
  if (mode === "billing") {
    assert(authReads.length > 0); assert(authReads.every((path) => path === authPath));
    assert(requests.length > 0);
    assert(requests.every(({ url, options }) => url === "https://billing.invalid/v1/billing?format=credits" && options.headers.Authorization === "Bearer SYNTHETIC-NOT-A-CREDENTIAL"));
  }
  if (mode === "dashboard") {
    assert.deepEqual(authReads, []); assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://dashboard.invalid/api/usage/codex");
    assert.equal(requests[0].options.method, "POST");
    assert(!requests[0].options.headers.Authorization);
    assert.deepEqual(JSON.parse(requests[0].options.body), { headers: codexHeaders }, "dashboard receives only existing quota headers, never paid-credit headers");
    assert.doesNotMatch(requests[0].options.body, /credits|123\.4500/, "no paid-credit details cross the dashboard boundary");
  }
  console.log(`PASS: footer privacy ${mode}`);
} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
