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
  const emit = async (event, payload, provider) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, { model: { provider } });
  };
  await emit("after_provider_response", {}, "xai");
  await emit("agent_settled", {}, "xai");
  await emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "2000000000" } }, "openai-codex");
  await new Promise((done) => setTimeout(done, 10));
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
  }
  console.log(`PASS: footer privacy ${mode}`);
} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
