#!/usr/bin/env node
// Real footer composition with synthetic SDK data and an in-memory TUI.
// No session files, credentials, real provider calls or terminal interaction.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { resolve, join } from "node:path";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSessionProjection, Theme } from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_INDICATOR,
  HEALTH_INDICATOR,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
} from "../../src/shared/overlay-protocol.mjs";

import { STATS_WORKER_ATTACH } from "../../src/shared/stats-protocol.mjs";

const root = resolve(import.meta.dirname, "../..");
const importStats = () =>
  createJiti(import.meta.url, { moduleCache: false }).import(join(root, "src/extensions/stats.ts"));
let statsFactory;
let statsFixture;
let statsGeneration = 0;
const importFooter = () =>
  createJiti(import.meta.url, { moduleCache: false }).import(
    join(root, "src/extensions/status-footer.ts"),
  );
let { default: extension } = await importFooter();
let handlers, events, commands;
// Each call registers a genuinely fresh footer factory. Replacement also tests
// module re-evaluation, matching the SDK loader's moduleCache:false setting.
const registerFooterFactory = () => {
  handlers = new Map();
  events = new Map();
  commands = new Map();
  extension({
    on: (name, handler) => subscribe(handlers, name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, handler) => subscribe(events, name, handler), emit: broadcast },
  });
};
const subscribe = (map, event, handler) => {
  const rows = map.get(event) ?? [];
  rows.push(handler);
  map.set(event, rows);
  return () =>
    map.set(
      event,
      (map.get(event) ?? []).filter((h) => h !== handler),
    );
};
const emit = async (event, payload = {}) => {
  for (const handler of [...(handlers.get(event) ?? [])]) await handler(payload, ctx);
};
const broadcast = (event, payload) => {
  for (const handler of [...(events.get(event) ?? [])]) handler(payload);
};
const notifications = [],
  overlays = [];
let footer,
  renders = 0,
  totalReads = 0,
  projectionReads = 0;
let currentUsage = { tokens: 357421, contextWindow: 500000, percent: 71.4842 };
let sessionGeneration = 0;
let focused;
const theme = new Theme(
  {
    accent: "#8fb9f1",
    text: "#cbd4df",
    muted: "#7b899c",
    dim: "#3c4859",
    success: "#92bf99",
    warning: "#d7b778",
    error: "#d48e91",
    borderAccent: "#75849a",
    borderMuted: "#475469",
    thinkingXhigh: "#8fb9f1",
  },
  { userMessageBg: "#191e26", selectedBg: "#344254" },
  "truecolor",
  { appearance: "dark" },
);
const tui = {
  mode: "fullscreen",
  terminal: { rows: 36, columns: 160 },
  render: () => [],
  requestRender() {
    renders++;
  },
  showOverlay(component, options) {
    const item = { component, options, alive: true, preFocus: focused };
    const handle = {
      hide() {
        if (!item.alive) return;
        item.alive = false;
        if (focused === component) focused = item.preFocus;
      },
      focus() {
        if (item.alive && options.visible?.() !== false) focused = component;
      },
      unfocus() {
        if (focused === component) focused = item.preFocus;
      },
      isFocused: () => focused === component,
      isHidden: () => !item.alive,
    };
    item.handle = handle;
    overlays.push(item);
    if (!options.nonCapturing && options.visible?.() !== false) focused = component;
    return handle;
  },
};
const usage = {
  input: 100,
  output: 80,
  cacheRead: 2000,
  cacheWrite: 0,
  reasoning: 50,
  totalTokens: 2180,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const entries = [
  {
    type: "message",
    id: "system",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "system",
      content: "RAW_UNSENT_SYSTEM",
      sections: {},
      toolsAdded: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      timestamp: 0,
    },
  },
  {
    type: "message",
    id: "user",
    parentId: "system",
    timestamp: "2026-01-01T00:00:01Z",
    message: { role: "user", content: "PRIVATE_USER_BODY", timestamp: 1 },
  },
  {
    type: "message",
    id: "assistant",
    parentId: "user",
    timestamp: "2026-01-01T00:00:02Z",
    message: {
      role: "assistant",
      provider: "synthetic",
      api: "openai-responses",
      model: "fixture-model",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "PRIVATE_ASSISTANT_BODY" },
        {
          type: "thinking",
          thinking: "PRIVATE_REASONING_BODY",
          thinkingSignature: "OPAQUE_NOT_A_REAL_SIGNATURE",
        },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "docs/fixture.md" } },
      ],
      usage,
      timestamp: 2,
    },
  },
  {
    type: "message",
    id: "result",
    parentId: "assistant",
    timestamp: "2026-01-01T00:00:03Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "PRIVATE_RESULT_BODY" }],
      details: { password: "PRIVATE_DETAIL" },
      timestamp: 3,
    },
  },
];
const statuses = [
  [APPROVAL_INDICATOR, "approval: manual"],
  [HEALTH_INDICATOR, "●"],
];
const ctx = {
  cwd: "/synthetic/project",
  hasUI: true,
  mode: "tui",
  thinkingLevel: "high",
  model: {
    provider: "synthetic",
    id: "fixture-model",
    api: "openai-responses",
    reasoning: true,
    contextWindow: 500000,
  },
  modelRegistry: {
    isUsingOAuth: () => false,
    getProvider: () => undefined,
    getApiKeyAndHeaders() {
      throw new Error("Context display must never resolve auth");
    },
  },
  getSystemPrompt: () => "RUNTIME_EFFECTIVE_SYSTEM",
  getContextUsage() {
    totalReads++;
    return { ...currentUsage };
  },
  sessionManager: {
    getSessionId: () => `synthetic-context-footer-${sessionGeneration}`,
    getLeafId: () => entries.at(-1)?.id,
    getEntryCount: () => entries.length,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    getEntries: () => entries,
    getBranch: () => entries,
    buildSessionProjection() {
      projectionReads++;
      return buildSessionProjection(entries, entries.at(-1)?.id);
    },
  },
  ui: {
    theme,
    notify(message) {
      notifications.push(message);
    },
    setFooter(factory) {
      footer?.dispose();
      footer = factory(tui, theme, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => statuses,
        onBranchChange: () => () => {},
      });
    },
  },
};
const editor = { editor: true };
focused = editor;
const originalFetch = globalThis.fetch;
const originalPerformance = globalThis.performance;
const originalSetInterval = globalThis.setInterval,
  originalClearInterval = globalThis.clearInterval;
const intervals = new Map();
let clock = 0;
globalThis.performance = { now: () => clock };
globalThis.setInterval = (callback, milliseconds) => {
  const handle = { unref() {} };
  intervals.set(handle, { callback, milliseconds });
  return handle;
};
globalThis.clearInterval = (handle) => {
  intervals.delete(handle);
};
globalThis.fetch = () => {
  throw new Error("Context UI must not fetch");
};
const plain = (text) => stripVTControlCharacters(text);
const paintFooter = (width = 160) => {
  const lines = footer.render(width);
  assert.equal(lines.length, 1);
  assert(visibleWidth(plain(lines[0])) <= width);
  return plain(lines[0]);
};
const live = () => overlays.filter((o) => o.alive);
const paintPanel = (item) => item.component.render(item.options.width).map(plain).join("\n");
const clickContext = () => {
  const line = paintFooter();
  const index = line.indexOf("357k/500k");
  assert(index >= 0, line);
  footer.handleMouse({
    type: "click",
    button: "left",
    x: visibleWidth(line.slice(0, index)) + 1,
    y: 0,
  });
};
const previousSummary = {
  preparation: { tokensBefore: 357421, previousSummary: "PREVIOUS_SUMMARY" },
  branchEntries: [{ type: "compaction", summary: "PREVIOUS_SUMMARY", usage: { output: 9000 } }],
  reason: "threshold",
};
const reportedSummary = (output = 9000) => ({
  fromExtension: false,
  compactionEntry: { type: "compaction", summary: "REPORTED_SUMMARY", usage: { output } },
});
const replaceFooterFactory = async (reloadModule = false) => {
  const oldHandlers = handlers,
    oldEvents = events,
    oldCommands = commands,
    oldFooter = footer;
  await emit("session_shutdown");
  assert.equal(intervals.size, 0, "old factory shutdown clears its active timer");
  oldFooter.dispose();
  assert.equal(live().length, 0, "old factory panels are disposed before replacement");
  footer = undefined;
  sessionGeneration++;
  if (reloadModule) {
    const oldExtension = extension;
    ({ default: extension } = await importFooter());
    assert.notEqual(extension, oldExtension, "uncached Jiti import re-evaluates the footer module");
  }
  registerFooterFactory();
  assert.notEqual(handlers, oldHandlers);
  assert.notEqual(events, oldEvents);
  assert.notEqual(commands, oldCommands);
  await emit("session_start");
  assert.notEqual(footer, oldFooter);
  assert.equal(intervals.size, 0, "fresh factory inherits no active observation or timer");
  assert.equal(live().length, 0, "fresh factory inherits no pinned UI");
  assert.doesNotMatch(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|≈\d+%/);
};
// Separate registrations and a headless context exercise Stats' real event
// binding without adding its UI refresh interval to the footer timer counts.
const registerStatsFactory = async (reloadModule = false) => {
  if (!statsFactory || reloadModule) {
    const previous = statsFactory;
    ({ default: statsFactory } = await importStats());
    if (previous) assert.notEqual(statsFactory, previous, "Stats module is genuinely re-evaluated");
  }
  const bindings = new Map(),
    channels = new Map(),
    registeredCommands = new Map();
  const parentId = `synthetic-stats-${statsGeneration++}`;
  let retired = false,
    retiredReads = 0,
    uiCalls = 0;
  const context = new Proxy(
    {
      ...ctx,
      hasUI: false,
      mode: "rpc",
      sessionManager: { getSessionId: () => parentId },
      ui: {
        setStatus: () => uiCalls++,
        setWidget: () => uiCalls++,
        notify: () => uiCalls++,
      },
    },
    {
      get(target, key, receiver) {
        if (retired) {
          retiredReads++;
          throw new Error("Retired Stats context must not be read");
        }
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const send = async (event, payload = {}) => {
    for (const callback of [...(bindings.get(event) ?? [])]) await callback(payload, context);
  };
  const publish = (event, payload) => {
    for (const callback of [...(channels.get(event) ?? [])]) callback(payload);
  };
  statsFactory({
    on: (event, callback) => subscribe(bindings, event, callback),
    registerCommand: (name, command) => registeredCommands.set(name, command),
    events: { on: (event, callback) => subscribe(channels, event, callback), emit: publish },
  });
  const beforeTimers = intervals.size;
  await send("session_start");
  assert.equal(intervals.size, beforeTimers, "headless Stats owns no refresh timer");
  assert.equal(uiCalls, 0, "headless Stats initialization does not paint UI");
  return {
    context,
    send,
    publish,
    parentId,
    async shutdown() {
      if (retired) return;
      // Keep callbacks the SDK could already have copied for dispatch. Removing
      // subscriptions alone is insufficient: these old closures must be inert.
      const stale = [...bindings].filter(([name]) => !name.startsWith("session_"));
      const staleChannels = [...channels];
      const beforeShutdownTimers = intervals.size;
      await send("session_shutdown");
      assert.equal(intervals.size, beforeShutdownTimers, "Stats teardown preserves footer timers");
      assert([...channels.values()].every((rows) => rows.length === 0));
      retired = true;
      const beforeUI = uiCalls;
      for (const [name, callbacks] of stale) {
        const payload =
          name === "message_end"
            ? { message: mainResponse(999999) }
            : { assistantMessageEvent: { type: "text_delta", delta: "STALE" } };
        for (const callback of callbacks) await callback(payload, context);
      }
      for (const [, callbacks] of staleChannels) {
        for (const callback of callbacks) callback({ parentId, workerId: "stale-worker" });
      }
      await registeredCommands.get("stats").handler("", context);
      assert.equal(retiredReads, 0, "old Stats callbacks no longer consult session/context");
      assert.equal(uiCalls, beforeUI, "old Stats callbacks retain no live UI activity");
      assert.equal(intervals.size, beforeShutdownTimers, "old Stats callbacks cannot rearm timers");
    },
  };
};
const throughputHistory = () =>
  globalThis[Symbol.for("pi-alehouse:compaction-progress:history:v1")];
const assertSharedHistoryData = () => {
  const history = throughputHistory();
  assert.deepEqual(Object.keys(history).sort(), ["compaction", "response"]);
  for (const samples of [history.compaction, history.response]) {
    assert(Array.isArray(samples));
    assert(samples.length <= 64, "each source stays globally bounded");
    const counts = new Map();
    for (const sample of samples) {
      assert.deepEqual(
        Object.keys(sample).sort(),
        ["elapsedMs", "modelKey", "outputTokens"],
        "history contains throughput metadata only, never UI/session references",
      );
      assert.equal(typeof sample.modelKey, "string");
      for (const value of [sample.outputTokens, sample.elapsedMs]) {
        assert(typeof value === "number" && Number.isFinite(value) && value > 0);
      }
      counts.set(sample.modelKey, (counts.get(sample.modelKey) ?? 0) + 1);
    }
    assert(
      [...counts.values()].every((count) => count <= 8),
      "each model history stays bounded per source",
    );
  }
};
const mainResponse = (output = 100, extra = {}) => ({
  role: "assistant",
  provider: "synthetic",
  api: "openai-responses",
  model: "main-baseline-regression",
  responseModel: "provider-response-alias",
  thinkingLevel: "high",
  stopReason: "stop",
  usage: { ...usage, output },
  ...extra,
});
const ordinaryResponse = async (output, elapsedMs, extra = {}) => {
  await statsFixture.send("agent_start");
  await statsFixture.send("turn_start");
  clock += elapsedMs;
  await statsFixture.send("message_end", { message: mainResponse(output, extra) });
  await statsFixture.send("agent_settled");
};
try {
  registerFooterFactory();
  await emit("session_start");
  const beforeInitial = projectionReads;
  const reads = totalReads;
  assert.match(paintFooter(), /357k\/500k/);
  assert.equal(totalReads, reads + 1, "first footer paint reads one SDK total");
  for (let frame = 0; frame < 100; frame++) paintFooter();
  assert.equal(totalReads, reads + 1, "idle animation frames reuse the SDK total");
  assert.equal(
    projectionReads,
    beforeInitial,
    "closed context panels do not materialize their tables",
  );
  clickContext();
  assert.equal(live().length, 1, "context click opens exactly the context panel");
  let contextPanel = live()[0];
  assert.equal(focused, editor, "click-to-pin does not take the editor keyboard");
  const beforePanelRead = totalReads;
  const firstPanel = paintPanel(contextPanel);
  assert.equal(totalReads, beforePanelRead, "panel uses its footer frame's captured SDK total");
  assert.match(firstPanel, /Context/);
  assert.match(firstPanel, /357k\s*\/\s*500k/);
  assert.match(firstPanel, /≈|estimate/i);
  assert.doesNotMatch(firstPanel, /PRIVATE_|RAW_UNSENT|RUNTIME_EFFECTIVE|OPAQUE_NOT/);
  const toolsTab = firstPanel.split("\n")[0].indexOf("Tools");
  assert(toolsTab >= 0);
  contextPanel.component.handleMouse({
    type: "click",
    button: "left",
    x: toolsTab,
    y: 0,
    width: contextPanel.options.width,
    height: 9,
  });
  const filtered = paintPanel(contextPanel);
  assert.match(filtered, /357k\s*\/\s*500k/);
  assert.match(filtered, /read/);
  assert.doesNotMatch(
    filtered.split("\n").slice(3, -1).join("\n"),
    /Effective system prompt|User message/,
  );
  assert.equal(focused, editor, "tab clicks keep editor focus and the pinned panel");
  contextPanel.component.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 0,
    width: contextPanel.options.width,
    height: 9,
  });
  paintPanel(contextPanel);
  const cachedReads = projectionReads;
  paintFooter();
  paintPanel(contextPanel);
  paintPanel(contextPanel);
  assert.equal(
    projectionReads,
    cachedReads,
    "idle repaint and width queries reuse one context collection",
  );

  // Ordinary usage remains a separate pinned stack member.
  const line = paintFooter();
  const up = line.indexOf("↑");
  assert(up >= 0);
  footer.handleMouse({
    type: "click",
    button: "left",
    x: visibleWidth(line.slice(0, up)) + 1,
    y: 0,
  });
  assert.equal(live().length, 2, "usage and context can stay pinned together");
  assert.equal(live()[0], contextPanel);
  for (const item of live()) item.component.render(item.options.width);
  assert.equal(live()[0].options.width, live()[1].options.width, "one shared column width");

  await commands.get("context").handler("", ctx);
  assert.equal(focused, contextPanel.component, "slash command focuses the existing context panel");
  assert.equal(live().length, 2, "focus does not duplicate the panel");
  await emit("ui_prompt_start", { kind: "confirm" });
  assert(!contextPanel.alive, "context yields while a prompt owns the UI");
  await emit("ui_prompt_end", { kind: "confirm" });
  contextPanel = live().find((item) => item.component === contextPanel.component);
  assert(contextPanel, "pinned context returns after the prompt");
  assert.notEqual(focused, contextPanel.component, "restoration never steals keyboard focus");

  currentUsage = { tokens: 400123, contextWindow: 500000, percent: 80.0246 };
  await emit("message_end", {});
  assert.match(paintFooter(), /400k\/500k/);
  assert.match(paintPanel(contextPanel), /400k\s*\/\s*500k/);
  assert(projectionReads > cachedReads, "content changes invalidate the collected table");

  // Only compaction-start captures the snapshot; there is no synthetic token decline.
  currentUsage = { tokens: 357421, contextWindow: 500000, percent: 71.4842 };
  await emit("before_agent_start", {
    systemPromptOptions: { forceSystemPrompt: "RUNTIME_EFFECTIVE_SYSTEM" },
  });
  await emit("session_before_compact", { preparation: { tokensBefore: 357421 }, reason: "manual" });
  assert.equal(intervals.size, 1, "only active compaction has an animation timer");
  const frozenReads = projectionReads;
  // A later projection change before the first paint cannot rewrite the frozen composition.
  entries.push({
    type: "branch_summary",
    id: "post-start",
    parentId: "result",
    timestamp: "2026-01-01T00:00:04Z",
    summary: "POST_START_NOT_IN_FROZEN_SNAPSHOT",
    fromId: "result",
  });
  clock += 10000;
  currentUsage = { tokens: 10000, contextWindow: 500000, percent: 2 };
  const compacting = paintFooter();
  assert.match(compacting, /357k\/500k/);
  assert.match(compacting, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.match(compacting, /10s/);
  const frozenPanel = paintPanel(contextPanel);
  assert.match(frozenPanel, /357k\s*\/\s*500k/);
  assert.doesNotMatch(frozenPanel.split("\n")[0], /Summary/);
  assert.equal(projectionReads, frozenReads, "composition froze synchronously in the start hook");
  entries.pop();
  currentUsage = { tokens: null, contextWindow: 500000, percent: null };
  await emit("session_compact", {});
  assert.equal(intervals.size, 0);
  assert.match(paintFooter(), /\?\/500k/);
  assert.doesNotMatch(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.doesNotMatch(paintPanel(contextPanel), /0\.0%/);

  for (const aborted of [true, false]) {
    currentUsage = { tokens: 357421, contextWindow: 500000, percent: 71.4842 };
    await emit("session_before_compact", {
      preparation: { tokensBefore: 357421 },
      reason: "manual",
    });
    clock += 2000;
    assert.equal(intervals.size, 1);
    currentUsage = { tokens: 10000, contextWindow: 500000, percent: 2 };
    await emit("session_compact_failed", { aborted });
    assert.equal(intervals.size, 0, "active failure/cancel retires the animation timer");
    assert.match(paintFooter(), /10k\/500k/);
    assert.doesNotMatch(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    assert.match(paintPanel(contextPanel), /10k\s*\/\s*500k/);
  }
  // Extension-provided summaries are successful, but are not timing samples for this model.
  currentUsage = { tokens: 357421, contextWindow: 500000, percent: 71.4842 };
  for (let i = 0; i < 3; i++) {
    await emit("session_before_compact", {
      preparation: { tokensBefore: 357421 },
      reason: "manual",
    });
    clock += 10000;
    await emit("session_compact", { ...reportedSummary(), fromExtension: true });
  }
  await emit("session_before_compact", { preparation: { tokensBefore: 357421 }, reason: "manual" });
  clock += 5000;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "extension summaries cannot create a model ETA");
  await emit("session_compact_failed", { aborted: true });
  assert.equal(intervals.size, 0);
  // A previous summary sizes the next output, but cannot invent throughput.
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "prior summary alone cannot create an ETA");
  await emit("session_compact_failed", { aborted: true });
  for (const output of [undefined, 0, -1, NaN]) {
    await emit("session_before_compact", previousSummary);
    clock += 1000;
    const result = reportedSummary(output);
    if (output === undefined) delete result.compactionEntry.usage;
    result.compactionEntry.summary = "UNREPORTED_SUMMARY".repeat(1000);
    await emit("session_compact", result);
  }
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "text/invalid usage never trains throughput");
  await emit("session_compact_failed", { aborted: false });

  // Successful native compaction: 9000 / 240s = 37.5 effective output TPS.
  await emit("session_before_compact", { preparation: { tokensBefore: 357421 } });
  clock += 240000;
  await emit("session_compact", reportedSummary());
  assert.equal(intervals.size, 0);
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.match(paintFooter(), /≈50% 2m18s/, "10350 estimated output / observed TPS = 276s");
  assert.match(paintPanel(contextPanel), /≈50% 2m18s/, "panel shares the actual-throughput ETA");
  clock += 124200;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "95% retires the estimate, not the spinner");
  assert.match(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  await emit("session_compact_failed", { aborted: true });
  assert.equal(intervals.size, 0);

  // Missing usage, failures, and extension results cannot pollute a valid sample.
  for (const outcome of ["unreported", "failed", "extension"]) {
    await emit("session_before_compact", previousSummary);
    clock += 1000;
    if (outcome === "failed") await emit("session_compact_failed", { aborted: false });
    else {
      const result = reportedSummary();
      if (outcome === "unreported") {
        delete result.compactionEntry.usage;
        result.compactionEntry.summary = "UNREPORTED_SUMMARY".repeat(1000);
      } else result.fromExtension = true;
      await emit("session_compact", result);
    }
    assert.equal(intervals.size, 0);
  }
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.match(paintFooter(), /≈50% 2m18s/, "excluded outcomes leave actual throughput unchanged");
  await emit("session_compact_failed", { aborted: true });

  for (const width of [1, 10, 20, 40, 80, 160]) paintFooter(width);
  const beforeSettlement = live().length;
  broadcast(HIDE_TRANSIENT_OVERLAYS_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(live().length, beforeSettlement, "cooperative settlement keeps both panel slots");

  // Real factory replacement, not another session_start on the original factory:
  // retain completed samples, but drop active timing, frozen totals and panels.
  await emit("session_before_compact", previousSummary);
  clock += 1000;
  currentUsage = { tokens: 10000, contextWindow: 500000, percent: 2 };
  assert.match(paintFooter(), /357k\/500k/, "old factory still owns its frozen total");
  await replaceFooterFactory();
  assert.match(paintFooter(), /10k\/500k/, "replacement does not inherit frozen context");
  currentUsage = { tokens: 357421, contextWindow: 500000, percent: 71.4842 };
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.match(
    paintFooter(),
    /≈50% 2m18s/,
    "completed history survives fresh factory registration",
  );
  await commands.get("context").handler("", ctx);
  assert.equal(live().length, 1, "new factory can open its own context panel");
  assert.notEqual(live()[0].component, contextPanel.component);
  await replaceFooterFactory(true);

  // A second requested model has no estimate until its own native sample exists.
  const firstModel = ctx.model;
  ctx.model = { ...firstModel, id: "second-model" };
  await emit("model_select");
  await emit("session_before_compact", previousSummary);
  clock += 276000;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "another model cannot borrow completed TPS");
  clock += 204000;
  await emit("session_compact", reportedSummary()); // 9000 / 480s = 18.75 TPS.
  await emit("session_before_compact", previousSummary);
  clock += 276000;
  assert.match(
    paintFooter(),
    /≈50% 4m36s/,
    "slower observed TPS predicts 552s, without a prior clamp",
  );
  await replaceFooterFactory(true);
  for (const [model, halfMs, expected] of [
    [firstModel, 138000, /≈50% 2m18s/],
    [{ ...firstModel, id: "second-model" }, 276000, /≈50% 4m36s/],
  ]) {
    ctx.model = model;
    await emit("model_select");
    await emit("session_before_compact", previousSummary);
    clock += halfMs;
    assert.match(paintFooter(), expected, "repeated replacement preserves isolated model history");
    await emit("session_compact_failed", { aborted: true });
    assert.equal(intervals.size, 0);
  }
  for (const [model, thinkingLevel] of [
    [firstModel, "low"],
    [{ ...firstModel, api: "anthropic-messages" }, "high"],
    [{ ...firstModel, api: "pi-virtual" }, "high"],
  ]) {
    ctx.model = model;
    ctx.thinkingLevel = thinkingLevel;
    await emit("model_select");
    await emit("session_before_compact", previousSummary);
    clock += 138000;
    assert.doesNotMatch(
      paintFooter(),
      /≈\d+%/,
      "API/thinking changes and virtual selections are isolated",
    );
    await emit("session_compact_failed", { aborted: true });
  }
  ctx.model = firstModel;
  ctx.thinkingLevel = "high";
  await emit("model_select");
  await emit("session_before_compact", previousSummary);
  clock += 138000;
  assert.match(paintFooter(), /≈50% 2m18s/, "original API/thinking history remains available");
  await emit("session_compact_failed", { aborted: true });

  // Ordinary foreground turns supply the fallback rate before this model has
  // ever compacted. Unequal durations distinguish weighted TPS from either
  // a median or an unweighted mean: (20 + 180) / (1s + 3s) = 50 TPS.
  const mainModel = { ...firstModel, id: "main-baseline-regression" };
  ctx.model = mainModel;
  await emit("model_select");
  statsFixture = await registerStatsFactory();
  for (let pair = 0; pair < 8; pair++) {
    await ordinaryResponse(20, 1000, { stopReason: "toolUse" });
    await ordinaryResponse(180, 3000, { stopReason: "length" });
  }
  const assertHalfEstimate = async (message, halfMs = 103500, expected = /≈50% 1m43s/) => {
    await emit("session_before_compact", previousSummary);
    clock += halfMs;
    assert.match(paintFooter(), expected, message);
    await emit("session_compact_failed", { aborted: true });
    assert.equal(intervals.size, 0);
  };
  await assertHalfEstimate("real Stats turns provide weighted50TPS before any native compaction");
  await emit("session_before_compact", { preparation: { tokensBefore: 357421 } });
  clock += 103500;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "main TPS cannot invent a first summary's size");
  assert.match(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  await emit("session_compact_failed", { aborted: true });

  // Requested identity, not provider-reported aliases or completion-time context.
  for (const [model, thinking] of [
    [{ ...mainModel, id: "provider-response-alias" }, "high"],
    [{ ...mainModel, provider: "another-provider" }, "high"],
    [{ ...mainModel, api: "anthropic-messages" }, "high"],
    [mainModel, "low"],
    [{ ...mainModel, api: "pi-virtual" }, "high"],
  ]) {
    ctx.model = model;
    ctx.thinkingLevel = thinking;
    await emit("model_select");
    await emit("session_before_compact", previousSummary);
    clock += 103500;
    assert.doesNotMatch(paintFooter(), /≈\d+%/, "requested provider/id/API/thinking is exact");
    await emit("session_compact_failed", { aborted: true });
  }
  ctx.model = mainModel;
  ctx.thinkingLevel = "high";
  await emit("model_select");
  const previousMainTail = throughputHistory().response.at(-1);
  await statsFixture.send("agent_start");
  await statsFixture.send("turn_start");
  statsFixture.context.model = { ...mainModel, id: "changed-after-request-start" };
  statsFixture.context.thinkingLevel = "low";
  clock += 1000;
  await statsFixture.send("message_end", { message: mainResponse(20) });
  await statsFixture.send("agent_settled");
  statsFixture.context.model = mainModel;
  statsFixture.context.thinkingLevel = "high";
  const capturedMain = throughputHistory().response.at(-1);
  assert.notEqual(capturedMain, previousMainTail, "successful response emitted one new sample");
  assert.deepEqual(capturedMain, {
    modelKey: JSON.stringify([mainModel.provider, mainModel.id, mainModel.api, "high"]),
    outputTokens: 20,
    elapsedMs: 1000,
  });
  await assertHalfEstimate("request-start identity survives a context change before message_end");

  // Bad responses cannot displace valid main samples. Nor may uncorrelated
  // warming events or managed-worker observations enter the throughput pool.
  for (const stopReason of ["error", "aborted", "unknown"]) {
    await ordinaryResponse(999999, 1000, { stopReason });
  }
  for (const output of [0, -1, NaN, Infinity, "1000000"]) {
    await ordinaryResponse(output, 1000);
  }
  await ordinaryResponse(999999, 0);
  await ordinaryResponse(100, 1000, { usage: undefined });
  for (const mismatch of [
    { model: "different-requested-model" },
    { provider: "different-provider" },
    { api: "anthropic-messages" },
    { thinkingLevel: "low" },
    { thinkingLevel: undefined },
  ]) {
    await ordinaryResponse(999999, 1000, mismatch);
  }
  await statsFixture.send("agent_start");
  await statsFixture.send("turn_start");
  clock += 1000;
  await statsFixture.send("agent_settled"); // unfinished request: no reported output
  await statsFixture.send("message_end", { message: mainResponse(999999) });
  await statsFixture.send("before_provider_request");
  clock += 1000;
  await statsFixture.send("message_end", { message: mainResponse(999999) });
  statsFixture.context.model = { ...mainModel, api: "pi-virtual" };
  await ordinaryResponse(999999, 1000, { api: "pi-virtual" });
  statsFixture.context.model = mainModel;
  const worker = { parentId: statsFixture.parentId, workerId: "synthetic-worker" };
  statsFixture.publish(STATS_WORKER_ATTACH, worker);
  assert(worker.sink, "real Stats factory accepts its worker telemetry attachment");
  worker.sink.beginRun();
  worker.sink.startActivity();
  worker.sink.requestStart(mainModel.id, mainModel.provider);
  clock += 1000;
  worker.sink.messageEnd({ ...mainResponse(999999), model: mainModel.id });
  worker.sink.settleActivity();
  worker.sink.endRun("success");
  await assertHalfEstimate(
    "invalid/error/abort/untimed/missing/virtual/worker data stays excluded",
  );

  await statsFixture.shutdown();
  assertSharedHistoryData();
  worker.sink.beginRun();
  worker.sink.startActivity();
  worker.sink.requestStart(mainModel.id, mainModel.provider);
  clock += 1000;
  worker.sink.messageEnd(mainResponse(999999));
  worker.sink.endRun("success");
  await replaceFooterFactory(true);
  statsFixture = await registerStatsFactory(true);
  await assertHalfEstimate("numeric history survives replacement of BOTH real extension modules");

  // Freeze the display estimate at compaction START. New ordinary turns during
  // compaction replace the ordinary-turn samples with 100 TPS, without rewriting
  // this ETA.
  await emit("session_before_compact", previousSummary);
  clock += 103500;
  assert.match(paintFooter(), /≈50% 1m43s/);
  for (let sample = 0; sample < 8; sample++) await ordinaryResponse(100, 1000);
  assert.equal(intervals.size, 1, "main observations create no extra compaction/Stats timers");
  assert.match(paintFooter(), /≈53% 1m51s/, "active207s estimate is frozen despite main100TPS");
  clock += 248500; // total native compaction time:360000ms, output9000=>25TPS
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "expired estimates still yield to the spinner");
  assert.match(paintFooter(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  await emit("session_compact", reportedSummary());
  assert.equal(intervals.size, 0);
  // The native completion is kept apart from ordinary turns and takes over:
  // 9000 tokens / 360s = 25 TPS gives a 414s estimate, not the 100 TPS turns.
  const ofModel = (samples) =>
    samples.filter((sample) => sample.modelKey === capturedMain.modelKey);
  assert.deepEqual(ofModel(throughputHistory().compaction), [
    { modelKey: capturedMain.modelKey, outputTokens: 9000, elapsedMs: 360000 },
  ]);
  assert.equal(ofModel(throughputHistory().response).length, 8);
  await assertHalfEstimate(
    "a native compaction sample replaces the ordinary-turn fallback",
    207000,
    /≈50% 3m27s/,
  );
  await statsFixture.shutdown();
  await replaceFooterFactory(true);
  statsFixture = await registerStatsFactory(true);
  await assertHalfEstimate("both sources survive module replacement", 207000, /≈50% 3m27s/);
  // Frequent ordinary turns can neither evict nor dilute the compaction sample.
  for (let sample = 0; sample < 72; sample++) await ordinaryResponse(100, 1000);
  assert.equal(ofModel(throughputHistory().compaction).length, 1);
  await assertHalfEstimate(
    "newer ordinary responses leave the native compaction rate in charge",
    207000,
    /≈50% 3m27s/,
  );
  await statsFixture.shutdown();
  assertSharedHistoryData();
  statsFixture = undefined;

  await emit("session_shutdown");
  assert(
    !live().some((item) => item.component === contextPanel.component),
    "session shutdown retires context overlays",
  );
  footer.dispose();
  assert.equal(live().length, 0);
  footer = undefined;
  tui.mode = "regular";
  await emit("session_start");
  await commands.get("context").handler("", ctx);
  assert.equal(
    live().length,
    0,
    "regular mode never draws a floating context panel into scrollback",
  );
  assert.match(notifications.at(-1), /Context/);
  assert.match(notifications.at(-1), /fullscreen/);
  assert(renders > 0);
  console.log("PASS: context footer integration (synthetic, no model/network)");
} finally {
  await statsFixture?.shutdown();
  await emit("session_shutdown");
  footer?.dispose();
  globalThis.fetch = originalFetch;
  globalThis.performance = originalPerformance;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}
