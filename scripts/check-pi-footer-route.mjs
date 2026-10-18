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
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

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
let renderRequests = 0;
const tui = {
  mode: "fullscreen",
  render: () => [],
  requestRender() { renderRequests++; },
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

  const codexApi = { api: "openai-codex-responses" };
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  oauthProviders.add("openai-codex");
  const weeklyHeaders = {
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "2000000000",
  };
  await emit("after_provider_response", { headers: weeklyHeaders });
  assert.match(line(), /W 90%/, "openai-codex still displays its own weekly quota headers");
  // A provider alias cloning openai-codex is another account on the same API.
  useModel("openai-codex-2", "gpt-6.1-sol", codexApi);
  oauthProviders.add("openai-codex-2");
  assert.doesNotMatch(line(), /W \d+%/, "an account shows no quota before its own response");
  await emit("after_provider_response", { headers: { ...weeklyHeaders, "x-codex-primary-used-percent": "40" } });
  assert.match(line(), /W 60%/, "a Codex provider alias displays its own weekly quota");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  assert.match(line(), /W 90%/, "switching back shows the first account's quota, not the alias's");
  // Only a plan that reports a shorter window shows it, before the weekly one.
  const fiveHourHeaders = {
    "x-codex-primary-used-percent": "30",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "2000000000",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "2000000000",
  };
  useModel("openai-codex-2", "gpt-6.1-sol", codexApi);
  await emit("after_provider_response", { headers: fiveHourHeaders });
  assert.match(line(), /5h 70% W 60%/, "an account reporting a 5h window shows it beside its weekly quota");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  assert.doesNotMatch(line(), /5h/, "an account without a 5h window shows only its weekly quota");
  useModel("openai-codex-2", "gpt-6.1-sol", codexApi);
  await emit("after_provider_response", { headers: { ...fiveHourHeaders, "x-codex-primary-reset-at": "1000000000" } });
  const lapsed = line();
  assert.match(lapsed, /W 60%/);
  assert.doesNotMatch(lapsed, /5h/, "a 5h window past its reset is not shown as current");
  useModel("openai", "gpt-5.6");
  oauthProviders.add("openai");
  providers.openai = providerAuth(true);
  await emit("after_provider_response", { headers: weeklyHeaders });
  const openaiLine = line();
  assert.match(openaiLine, /\$0\.000 sub\b/);
  assert.doesNotMatch(openaiLine, /W 90%|x-codex/, "ChatGPT subscription does not display Codex quota headers");

  // Credits are a separate last-reported account snapshot, not rate quota.
  const creditsHeaders = (balance, extra = {}) => ({
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
    ...(balance === undefined ? {} : { "x-codex-credits-balance": balance }),
    ...extra,
  });
  const creditResponse = (headers) => emit("after_provider_response", { headers });
  const creditStream = (data, provider = "openai-codex", api = codexApi.api) =>
    emit("provider_stream_event", { provider, api, model: "synthetic-codex", data });
  const streamSnapshot = (balance, extra = {}) => ({
    type: "codex.rate_limits",
    credits: { has_credits: true, unlimited: false, ...(balance === undefined ? {} : { balance }) },
    ...extra,
  });
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  assert.doesNotMatch(line(), /Cr /, "quota alone never invents a credit balance");
  const exhausted = {
    ...fiveHourHeaders,
    "x-codex-primary-used-percent": "100",
    "x-codex-secondary-used-percent": "100",
    ...creditsHeaders("123.45"),
  };
  const headersBefore = structuredClone(exhausted);
  const beforeCreditsRender = renderRequests;
  await creditResponse(exhausted);
  assert.deepEqual(exhausted, headersBefore, "response headers are not mutated");
  assert.match(line(), /5h 0% W 0%/);
  assert.match(line(), /Cr 123\b/, "paid credits remain available beside exhausted rate windows");
  assert.doesNotMatch(line(), /Cr \$/, "credits are not converted to dollars");
  assert(renderRequests > beforeCreditsRender, "changed credits request a render");

  useModel("openai-codex-2", "gpt-6.1-sol", codexApi);
  assert.doesNotMatch(line(), /Cr /, "another account does not inherit credits");
  await creditResponse(creditsHeaders("7.25"));
  assert.doesNotMatch(line(), /Cr /, "credits-only headers cache the balance but positive quota keeps it hidden");
  await creditResponse({ ...weeklyHeaders, "x-codex-primary-used-percent": "100" });
  assert.match(line(), /Cr 7\b/, "a later exhausted weekly window reveals the cached balance");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  assert.match(line(), /Cr 123\b/, "switching back restores only that account's credits");
  const beforeBalanceRender = renderRequests;
  await creditResponse({
    "X-CODEX-CREDITS-HAS-CREDITS": "TrUe",
    "X-Codex-Credits-Unlimited": "FaLsE",
    "X-Codex-Credits-Balance": "0.125",
  });
  assert.match(line(), /Cr 0\b/, "header names and boolean strings are case insensitive");
  assert(renderRequests > beforeBalanceRender, "credits-only changes request a render");
  const unchangedHeadersRender = renderRequests;
  await creditResponse(creditsHeaders("0.125"));
  assert.equal(renderRequests, unchangedHeadersRender, "unchanged credit headers do not request another render");
  await creditResponse(creditsHeaders("12345678901234567890.1234500"));
  assert.match(line(), /Cr 12345678901234567890\b/, "whole-credit display keeps huge balances exact without Number conversion");
  await creditResponse(creditsHeaders("0", { "x-codex-credits-has-credits": "false" }));
  assert.match(line(), /Cr 0\b/, "a reported zero is distinct from an unknown balance");
  await creditResponse(creditsHeaders("0.00000001"));
  assert.match(line(), /Cr 0\b/, "a tiny positive balance validates and displays as zero whole credits");
  await creditResponse(creditsHeaders(undefined, { "x-codex-credits-unlimited": "TRUE" }));
  assert.match(line(), /Cr ∞/, "unlimited credits need no numeric balance");
  await creditResponse(creditsHeaders("2.5", {
    "x-codex-credits-has-credits": "1", "x-codex-credits-unlimited": "0",
  }));
  assert.match(line(), /Cr 3\b/, "boolean 1/0 headers are accepted");
  for (const balance of [undefined, "", " ", "not-a-number", "NaN", "Infinity", "-1", "1e999", "1\n2", "1\u001b[31m2"]) {
    await creditResponse(creditsHeaders("9"));
    await creditResponse(creditsHeaders(balance));
    assert.doesNotMatch(line(), /Cr /, `fresh unknown/invalid balance ${String(balance)} replaces the old number`);
  }
  await creditResponse(creditsHeaders("8.5"));
  for (const headers of [{}, { "content-type": "text/event-stream" }]) {
    await creditResponse(headers);
    assert.match(line(), /Cr 9\b/, "absent credit headers retain last reported credits");
  }
  const quotaHeaders = (shortUsed, weeklyUsed, reset = "2000000000") => ({
    ...fiveHourHeaders,
    "x-codex-primary-used-percent": String(shortUsed),
    "x-codex-secondary-used-percent": String(weeklyUsed),
    "x-codex-primary-reset-at": reset,
    "x-codex-secondary-reset-at": reset,
  });
  await creditResponse(quotaHeaders(20, 30));
  assert.doesNotMatch(line(), /Cr /, "recovered quota hides the cached balance again");
  await creditResponse(creditsHeaders("8.5"));
  assert.doesNotMatch(line(), /Cr /, "credits-only refresh cannot override positive quota");
  await creditResponse(quotaHeaders(99.6, 99.6));
  assert.match(line(), /5h 0% W 0%/, "remaining percentages can round to zero");
  assert.doesNotMatch(line(), /Cr /, "rounded zero with actual quota remaining is not exhaustion");
  await creditResponse(quotaHeaders(100, 30));
  assert.match(line(), /Cr 9\b/, "only the short window needs to be truly exhausted");
  await creditResponse(quotaHeaders(20, 100));
  assert.match(line(), /Cr 9\b/, "only the weekly window needs to be truly exhausted");
  await creditResponse(quotaHeaders(100, 100, "1000000000"));
  assert.doesNotMatch(line(), /Cr /, "expired exhausted windows cannot expose credits");
  await creditResponse(quotaHeaders(100, 100));
  assert.match(line(), /Cr 9\b/, "current exhaustion reveals the retained last-reported balance");

  // WebSocket-only accounts must report real current exhaustion, not just credits.
  const streamWindow = (used, minutes = 300, reset = 2000000000) => ({
    used_percent: used, window_minutes: minutes, reset_at: reset,
  });
  const streamQuota = (primary, secondary) => ({
    type: "codex.rate_limits",
    rate_limits: { primary, ...(secondary === undefined ? {} : { secondary }) },
  });
  const streamAccount = "websocket-codex";
  useModel(streamAccount, "synthetic", codexApi);
  await creditResponse(creditsHeaders("17.125"));
  assert.doesNotMatch(line(), /Cr /, "header credits with unknown quota stay hidden");
  await creditStream(streamSnapshot("18.125"), streamAccount);
  assert.doesNotMatch(line(), /Cr /, "stream credits with unknown quota stay hidden");
  await creditStream(streamSnapshot(undefined, { credits: { has_credits: true, unlimited: true } }), streamAccount);
  assert.doesNotMatch(line(), /Cr /, "unlimited credits do not imply exhausted subscription quota");
  await creditStream(streamSnapshot("18.125"), streamAccount);
  for (const data of [
    streamQuota(undefined),
    streamQuota({ window_minutes: 300 }),
    streamQuota(streamWindow("100")),
    streamQuota(streamWindow(Number.NaN)),
    streamQuota(streamWindow(100, "300")),
    streamQuota(streamWindow(100, 0)),
    { ...streamQuota(streamWindow(100)), type: "response.completed" },
    { ...streamQuota(streamWindow(100)), limit_name: "other" },
    { ...streamQuota(streamWindow(100)), metered_limit_name: "other", limit_name: "codex" },
  ]) {
    await creditStream(data, streamAccount);
    assert.doesNotMatch(line(), /Cr /, "unknown, malformed and unrelated stream windows cannot fabricate exhaustion");
  }
  await creditStream(streamQuota(streamWindow(100, 300, 1000000000)), streamAccount);
  assert.doesNotMatch(line(), /Cr /, "expired stream exhaustion cannot reveal cached credits");
  await creditStream(streamQuota(streamWindow(99.6)), streamAccount);
  assert.match(line(), /5h 0%/);
  assert.doesNotMatch(line(), /Cr /, "stream percentage rounding does not fabricate actual exhaustion");
  await creditStream(streamQuota(streamWindow(100)), streamAccount, "openai-responses");
  assert.doesNotMatch(line(), /Cr /, "wrong outer stream API cannot supply exhaustion");
  useModel("openai", "gpt-5.6", { api: "openai-responses" });
  const websocketZero = {
    ...streamSnapshot("19.125"),
    ...streamQuota(streamWindow(100), streamWindow(20, 10080)),
    provider: "wrong-inner-provider", api: "openai-responses",
  };
  const websocketBefore = structuredClone(websocketZero);
  await creditStream(websocketZero, streamAccount);
  assert.deepEqual(websocketZero, websocketBefore, "stream window ingestion does not mutate raw events");
  assert.doesNotMatch(line(), /Cr /, "stream quota and credits do not leak to the selected account");
  useModel(streamAccount, "synthetic", codexApi);
  assert.match(line(), /5h 0% W 80%/);
  assert.match(line(), /Cr 19\b/, "outer provider/API routes WebSocket-only exhaustion and credits together");
  const unchangedWindowRender = renderRequests;
  await creditStream(websocketZero, streamAccount);
  assert.equal(renderRequests, unchangedWindowRender, "unchanged stream windows and credits do not request another render");
  await creditStream(streamQuota(streamWindow(10), streamWindow(20, 10080)), streamAccount);
  assert.match(line(), /5h 90% W 80%/);
  assert.doesNotMatch(line(), /Cr /, "positive stream quota re-hides credits after recovery");
  await creditStream(streamQuota(streamWindow(10), streamWindow(100, 10080)), streamAccount);
  assert.match(line(), /Cr 19\b/, "weekly-only stream exhaustion reveals cached credits without a new balance");
  await creditStream(streamQuota(streamWindow(10), streamWindow(20, 10080)), streamAccount);
  assert.doesNotMatch(line(), /Cr /, "weekly stream recovery hides credits again");

  // Partial WebSocket windows retain bucket metadata, never stale exhaustion.
  const partialAccount = "partial-websocket-codex";
  useModel(partialAccount, "synthetic", codexApi);
  await creditStream(streamSnapshot("23.5"), partialAccount);
  await creditStream(streamQuota({ used_percent: 100 }), partialAccount);
  assert.doesNotMatch(line(), /Cr |5h |W \d+%/, "unknown window duration cannot turn partial100 into exhaustion");
  const realDateNow = Date.now;
  let partialNow = 1900000000000;
  Date.now = () => partialNow;
  try {
    const nearReset = partialNow / 1000 + 60;
    await creditStream(streamQuota(streamWindow(100, 300, nearReset), streamWindow(20, 10080)), partialAccount);
    assert.match(line(), /5h 0% W 80%/);
    assert.match(line(), /Cr 24\b/);
    await creditStream(streamQuota({ used_percent: 50 }), partialAccount);
    assert.match(line(), /5h 50% W 80%/, "partial recovery retains duration and absent secondary bucket");
    assert.doesNotMatch(line(), /Cr /, "known exhausted window followed by partial50 hides credits");
    await creditStream(streamQuota({ used_percent: 100, window_minutes: null, reset_at: null }), partialAccount);
    assert.match(line(), /5h 0% W 80%/);
    assert.match(line(), /Cr 24\b/, "partial100 reuses known duration and null optional metadata");
    await creditStream(streamSnapshot("24.5"), partialAccount);
    assert.match(line(), /Cr 25\b/, "credits-only stream preserves current exhausted windows");
    partialNow += 61000;
    assert.doesNotMatch(line(), /Cr |5h /, "partial updates retain the reset deadline rather than creating indefinite exhaustion");
    assert.match(line(), /W 80%/, "expiration of primary leaves secondary intact");
    await creditStream(streamQuota({ used_percent: 100 }), partialAccount);
    assert.doesNotMatch(line(), /Cr |5h /, "omitted reset metadata remains expired on later partial100");
    for (const reset of ["2000000000", Number.NaN, Infinity, -1, 2000000000.5]) {
      await creditStream(streamQuota(streamWindow(100, 300, nearReset), streamWindow(20, 10080)), partialAccount);
      assert.doesNotMatch(line(), /Cr |5h /, "expired exhausted primary starts hidden");
      await creditStream(streamQuota({ used_percent: 100, reset_at: reset }), partialAccount);
      assert.doesNotMatch(line(), /Cr |5h /, `invalid reset ${String(reset)} cannot resurrect an expired exhausted window`);
      assert.match(line(), /W 80%/, "invalid primary reset leaves the valid secondary bucket intact");
      await creditStream({ type: "codex.rate_limits", rate_limits: { secondary: { used_percent: 100 } } }, partialAccount);
      assert.match(line(), /W 0%/);
      assert.match(line(), /Cr 25\b/, "invalid primary reset does not prevent independent weekly exhaustion");
      assert.doesNotMatch(line(), /5h /, "weekly update cannot revive the invalidated primary");
      useModel("openai-codex", "gpt-5.6-codex", codexApi);
      assert.match(line(), /5h 0% W 0%/);
      assert.match(line(), /Cr 9\b/, "malformed reset leaves another account's valid quota and credits intact");
      useModel(partialAccount, "synthetic", codexApi);
    }
    for (const primary of [null, "malformed", {}, { used_percent: "50" }]) {
      await creditStream(streamQuota(streamWindow(100), streamWindow(20, 10080)), partialAccount);
      assert.match(line(), /Cr 25\b/);
      await creditStream(streamQuota(primary), partialAccount);
      assert.doesNotMatch(line(), /Cr |5h /, "explicit null or malformed supplied primary invalidates stale exhaustion");
      assert.match(line(), /W 80%/, "invalidating primary does not discard the absent secondary bucket");
    }
    await creditStream(streamQuota(streamWindow(100), streamWindow(100, 10080)), partialAccount);
    await creditStream(streamQuota(null), partialAccount);
    assert.doesNotMatch(line(), /5h /);
    assert.match(line(), /W 0%/);
    assert.match(line(), /Cr 25\b/, "null primary leaves independent weekly exhaustion eligible");
    useModel("openai-codex", "gpt-5.6-codex", codexApi);
    assert.match(line(), /5h 0% W 0%/);
    assert.match(line(), /Cr 9\b/, "partial and invalid stream buckets never alter another account");
  } finally {
    Date.now = realDateNow;
  }

  // Stream identity, not the current selection, determines the credit account.
  useModel("openai", "gpt-5.6", { api: "openai-responses" });
  const rawStream = streamSnapshot("42.75");
  const rawBefore = structuredClone(rawStream);
  const beforeStreamRender = renderRequests;
  await creditStream(rawStream);
  assert.deepEqual(rawStream, rawBefore, "raw stream events are not mutated");
  assert.doesNotMatch(line(), /Cr /, "Codex stream credits do not leak into the active non-Codex model");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  assert.match(line(), /Cr 43\b/, "stream outer provider/api wins over ctx.model");
  assert(renderRequests > beforeStreamRender, "stream credit changes request a render");
  const unchangedStreamRender = renderRequests;
  await creditStream(rawStream);
  assert.equal(renderRequests, unchangedStreamRender, "unchanged stream snapshot does not request another render");
  useModel("openai-codex-2", "gpt-6.1-sol", codexApi);
  assert.match(line(), /Cr 7\b/, "stream updates leave the other account intact");
  await creditStream(streamSnapshot("11.5"), "openai-codex-2");
  assert.match(line(), /Cr 12\b/, "stream credit tracking supports provider aliases");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  for (const data of [
    streamSnapshot("99", { type: "response.completed" }),
    streamSnapshot("99", { type: "codex.rate_limits.extra" }),
    streamSnapshot("99", { limit_name: "other" }),
    streamSnapshot("99", { metered_limit_name: "other", limit_name: "codex" }),
    { type: "codex.rate_limits" },
    { type: "codex.rate_limits", credits: { has_credits: true, balance: "99" } },
    { type: "codex.rate_limits", credits: { unlimited: false, balance: "99" } },
    { type: "codex.rate_limits", credits: { has_credits: "true", unlimited: false, balance: "99" } },
  ]) {
    await creditStream(data);
    assert.match(line(), /Cr 43\b/, "unrelated stream types, limits and absent credits preserve the snapshot");
  }
  await creditStream(streamSnapshot("99"), "openai-codex", "openai-responses");
  assert.match(line(), /Cr 43\b/, "non-Codex outer API cannot change a Codex account");
  await creditStream(streamSnapshot("4.25", { metered_limit_name: "codex", limit_name: "other" }));
  assert.match(line(), /Cr 4\b/, "metered limit name takes precedence");
  await creditStream(streamSnapshot("3.25", { limit_name: " CoDeX " }));
  assert.match(line(), /Cr 3\b/, "legacy limit_name identifies Codex after whitespace/case normalization");
  for (const balance of [undefined, null, "bad", "-0.1", "Infinity", "1\n2", "1\u001b[31m2"]) {
    await creditStream(streamSnapshot("6"));
    await creditStream(streamSnapshot(balance));
    assert.doesNotMatch(line(), /Cr /, "partial stream snapshot replaces rather than merges a stale numeric balance");
  }
  await creditStream({ type: "codex.rate_limits", credits: { has_credits: true, unlimited: true, balance: null } });
  assert.match(line(), /Cr ∞/);
  await creditStream({ type: "codex.rate_limits", credits: { has_credits: false, unlimited: false, balance: "0" } });
  assert.match(line(), /Cr 0\b/);

  // The API, not just a familiar provider name, gates both collection and display.
  useModel("non-codex", "synthetic", { api: "openai-responses" });
  await creditResponse(creditsHeaders("91"));
  await creditStream(streamSnapshot("92"), "non-codex", "openai-responses");
  assert.doesNotMatch(line(), /Cr /);
  useModel("non-codex", "synthetic", codexApi);
  assert.doesNotMatch(line(), /Cr /, "non-Codex API events were not cached for later display");
  useModel("openai-codex", "gpt-5.6-codex", { api: "openai-responses" });
  assert.doesNotMatch(line(), /Cr /, "even an existing account's credits are hidden on a different API");
  useModel("openai-codex", "gpt-5.6-codex", codexApi);
  await creditResponse({ ...exhausted, ...creditsHeaders("123.45") });
  for (const mode of ["regular", "fullscreen"]) {
    tui.mode = mode;
    for (const width of [20, 40, 80, 160]) {
      const rows = footer.render(width);
      assert.equal(rows.length, 1, `${mode} footer remains one row at width ${width}`);
      // The regular renderer consumes this out-of-band routing marker before paint.
      const painted = rows[0].replace("\u0000pi-status-footer\u0000", "");
      assert(visibleWidth(painted) <= width, `${mode} footer stays within width ${width}`);
    }
    for (let width = 20; width <= 160; width++) {
      const painted = stripVTControlCharacters(footer.render(width)[0].replace("\u0000pi-status-footer\u0000", ""));
      const creditLabel = /(?:^|[ ·])(?:C|Cr)(?:\s|…|$)/;
      if (creditLabel.test(painted)) {
        assert.match(painted, /Cr 123\b/, `${mode} credit balance is whole or absent at width ${width}`);
      }
    }
    assert.match(line(), /Cr 123\b/, `${mode} footer renders paid credits`);
    assert.doesNotMatch(line(), /\bcredits\b/, `${mode} footer does not render the full word credits`);
    assert.match(line(), /5h 0% W 0%/);
  }

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
