#!/usr/bin/env node
// Synthetic footer contract: no credentials, no network, no auth mutation.
// Subscription comes only from registry getProvider().auth.oauth.isSubscription
// plus isUsingOAuth, with the verified kimi-coding API-key exception.
// A virtual selection shows the latest settled physical assistant on the active
// branch after that selection; failed, omitted, abandoned, and pre-selection
// calls are not the current route. Codex quota headers stay on openai-codex.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const directory = mkdtempSync(join(tmpdir(), "alehouse-footer-route-"));
process.env.HOME = directory;
process.env.PI_CODING_AGENT_DIR = join(directory, "custom-agent");
delete process.env.AGENT_DASHBOARD_URL;
delete process.env.PI_ALEHOUSE_GROK_BILLING;
delete process.env.GROK_CLI_CHAT_PROXY_BASE_URL;

const authReads = [];
const requests = [];
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (String(path).endsWith("/auth.json") || String(path).endsWith("\\auth.json")) authReads.push(String(path));
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  throw new Error(`footer route test must not fetch ${url}`);
};

const forbidden = [];
const registryCalls = [];
const oauthProviders = new Set();
const providers = {};
const registry = {
  isUsingOAuth(model) {
    registryCalls.push(["isUsingOAuth", model?.provider]);
    return oauthProviders.has(model?.provider);
  },
  getProvider(id) {
    registryCalls.push(["getProvider", id]);
    return providers[id];
  },
  getApiKeyForProvider(id) {
    forbidden.push(["getApiKeyForProvider", id]);
    throw new Error("footer must not read provider keys");
  },
  getProviderAuth(id) {
    forbidden.push(["getProviderAuth", id]);
    throw new Error("footer must not resolve provider auth");
  },
  getApiKeyAndHeaders(model) {
    forbidden.push(["getApiKeyAndHeaders", model?.provider]);
    throw new Error("footer must not resolve request auth");
  },
};

const branch = [];
const abandoned = [];
const ctx = {
  cwd: directory,
  hasUI: false,
  mode: "tui",
  model: undefined,
  thinkingLevel: "off",
  modelRegistry: registry,
  sessionManager: {
    getEntries: () => [...abandoned, ...branch],
    getBranch: () => branch,
  },
  getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
  ui: {},
};
const handlers = new Map();
let footer;
const theme = { fg: (_color, text) => text, bold: (text) => text };
const tui = {
  mode: "fullscreen",
  render: () => [],
  requestRender() {},
  terminal: { rows: 24, columns: 120 },
};

const { default: extension } = await createJiti(import.meta.url).import(
  join(resolve(import.meta.dirname, ".."), "extensions/status-footer.ts"),
);
extension({
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  events: { on() { return () => {}; }, emit() {} },
});
ctx.ui.setFooter = (factory) => {
  footer = factory(tui, theme, {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => [],
    onBranchChange: () => () => {},
  });
};
const start = handlers.get("session_start") ?? [];
assert.equal(start.length, 1);
await start[0]({}, ctx);
assert.equal(typeof footer?.render, "function");

const line = () => footer.render(160)[0];
const emit = async (event, payload) => {
  for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
};
const useModel = (provider, id, extra = {}) => {
  ctx.model = { provider, id, reasoning: true, ...extra };
  ctx.thinkingLevel = extra.thinkingLevel ?? "high";
};
const providerAuth = (isSubscription) => ({ auth: { oauth: { name: "synthetic", isSubscription } } });
const assistant = (id, model, stopReason, extra = {}) => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    api: extra.api ?? "openai-responses",
    provider: extra.provider ?? "openai",
    model,
    thinkingLevel: extra.thinkingLevel,
    stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  },
});
const select = (id, provider, modelId) => ({ type: "model_change", id, provider, modelId });
const replaceBranch = (entries) => {
  branch.length = 0;
  branch.push(...entries);
};

try {
  useModel("openai", "gpt-5.6");
  oauthProviders.add("openai");
  providers.openai = providerAuth(true);
  assert.match(line(), /\$0\.000 sub\b/, "ChatGPT subscription OAuth shows the subscription marker");
  assert.deepEqual(registryCalls.at(-2), ["isUsingOAuth", "openai"]);
  assert.deepEqual(registryCalls.at(-1), ["getProvider", "openai"]);

  oauthProviders.delete("openai");
  assert.doesNotMatch(line(), / sub\b/, "OpenAI API key is not a subscription even when OAuth is marked isSubscription");
  assert.equal(registryCalls.at(-1)?.[0], "isUsingOAuth", "API-key auth must not consult provider metadata for a marker");

  oauthProviders.add("openai");
  providers.openai = providerAuth(false);
  assert.doesNotMatch(line(), / sub\b/, "non-subscription OAuth does not show the marker");
  providers.openai = { auth: { oauth: { name: "generic account" } } };
  assert.doesNotMatch(line(), / sub\b/, "OAuth without isSubscription is not a subscription");
  providers.openai = providerAuth(true);

  useModel("kimi-coding", "kimi-for-coding");
  oauthProviders.delete("kimi-coding");
  const callsBeforeKimi = registryCalls.length;
  assert.match(line(), /\$0\.000 sub\b/, "kimi-coding stays subscription-backed on API-key auth");
  assert.equal(registryCalls.length, callsBeforeKimi, "kimi special case must not read the registry");

  useModel("openai-codex", "gpt-5.6-codex");
  oauthProviders.delete("openai-codex");
  assert.doesNotMatch(line(), / sub\b/, "openai-codex is not hardcoded; API-key-shaped auth has no marker");
  oauthProviders.add("openai-codex");
  providers["openai-codex"] = providerAuth(true);
  assert.match(line(), /\$0\.000 sub\b/, "openai-codex subscription still comes from the registry");

  useModel("router", "auto", { api: "pi-virtual", thinkingLevel: "high" });
  replaceBranch([
    assistant("stale-before", "pre-selection-model", "stop", { thinkingLevel: "low" }),
    select("selection", "router", "auto"),
    assistant("routed", "gpt-5.6-luna", "stop", { thinkingLevel: "medium", provider: "openai" }),
  ]);
  abandoned.push(assistant("abandoned", "stale-abandoned-model", "stop", { thinkingLevel: "max" }));
  const routed = line();
  assert.match(routed, /auto \(high\) → gpt-5\.6-luna \(medium\)/);
  assert.doesNotMatch(routed, /pre-selection-model|stale-abandoned-model/);

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("older", "gpt-5.6-luna", "stop", { thinkingLevel: "medium" }),
    assistant("failed", "failed-route-model", "error", { thinkingLevel: "high" }),
  ]);
  assert.doesNotMatch(line(), /→|failed-route-model|gpt-5\.6-luna/, "a failed latest call is not the current route");

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("aborted", "aborted-route-model", "aborted"),
  ]);
  assert.doesNotMatch(line(), /→|aborted-route-model/);

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("pending", "pending-route-model", "pending"),
  ]);
  assert.doesNotMatch(line(), /→|pending-route-model/);

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("unrouted", "auto", "error", { api: "pi-virtual" }),
  ]);
  assert.doesNotMatch(line(), /→/, "failed routing leaves the virtual model and is not a physical route");

  replaceBranch([
    select("other", "router", "other-auto"),
    assistant("foreign", "foreign-route-model", "stop", { thinkingLevel: "low" }),
  ]);
  assert.doesNotMatch(line(), /→|foreign-route-model/, "a selection the branch has not recorded has no route");

  replaceBranch([
    assistant("unscoped", "unscoped-route-model", "stop", { thinkingLevel: "low" }),
  ]);
  assert.doesNotMatch(line(), /→|unscoped-route-model/, "without this selection's model_change the call is not its route");

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("omitted-fail", "omitted-fail-model", "error", { thinkingLevel: "low" }),
    { type: "context_edit", id: "omit-fail", targetId: "omitted-fail", replacement: null },
    assistant("after-omit", "gpt-5.6-sol", "toolUse", { thinkingLevel: "high" }),
  ]);
  assert.match(line(), /auto \(high\) → gpt-5\.6-sol \(high\)/);
  assert.doesNotMatch(line(), /omitted-fail-model/);

  replaceBranch([
    select("selection", "router", "auto"),
    assistant("previous", "previous-route-model", "stop", { thinkingLevel: "low" }),
    assistant("omitted-latest", "omitted-latest-model", "error"),
    { type: "context_edit", id: "omit-latest", targetId: "omitted-latest", replacement: null },
  ]);
  assert.doesNotMatch(line(), /→|previous-route-model|omitted-latest-model/, "an omitted failure does not revive an older route");

  const active = [
    select("selection", "router", "auto"),
    assistant("leaf", "branch-leaf-model", "length", { thinkingLevel: "minimal" }),
  ];
  const other = [
    select("selection-b", "router", "auto"),
    assistant("other-leaf", "other-leaf-model", "stop", { thinkingLevel: "xhigh" }),
  ];
  replaceBranch(active);
  assert.match(line(), /→ branch-leaf-model \(minimal\)/);
  replaceBranch(other);
  const switched = line();
  assert.match(switched, /→ other-leaf-model \(xhigh\)/);
  assert.doesNotMatch(switched, /branch-leaf-model/, "tree navigation follows the active branch, not a stale leaf");

  useModel("openai", "gpt-5.6", { api: "openai-responses" });
  replaceBranch([
    select("physical", "openai", "gpt-5.6"),
    assistant("physical-answer", "different-physical-model", "stop", { thinkingLevel: "low" }),
  ]);
  const physical = line();
  assert.match(physical, /gpt-5\.6 \(high\)/);
  assert.doesNotMatch(physical, /→|different-physical-model/, "a physical selection does not borrow another call as its route");

  useModel("openai-codex", "gpt-5.6-codex");
  oauthProviders.add("openai-codex");
  const weeklyHeaders = {
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "2000000000",
  };
  await emit("after_provider_response", { headers: weeklyHeaders });
  assert.match(line(), /W 90%/, "openai-codex still displays its own weekly quota headers");
  useModel("openai", "gpt-5.6");
  oauthProviders.add("openai");
  providers.openai = providerAuth(true);
  await emit("after_provider_response", { headers: weeklyHeaders });
  const openaiLine = line();
  assert.match(openaiLine, /\$0\.000 sub\b/);
  assert.doesNotMatch(openaiLine, /W 90%|x-codex/, "ChatGPT subscription does not display Codex quota headers");

  assert.deepEqual(forbidden, []);
  assert.deepEqual(authReads, []);
  assert.deepEqual(requests, []);
  console.log("PASS: footer subscription route");
} finally {
  footer?.dispose();
  fs.readFileSync = read;
  syncBuiltinESMExports();
  fs.rmSync(directory, { recursive: true, force: true });
}
