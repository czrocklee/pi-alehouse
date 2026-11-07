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

const root = resolve(import.meta.dirname, "../..");
const { default: extension } = await createJiti(import.meta.url).import(
  join(root, "src/extensions/status-footer.ts"),
);
const handlers = new Map(),
  events = new Map(),
  commands = new Map();
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
    getSessionId: () => "synthetic-context-footer",
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
try {
  extension({
    on: (name, handler) => subscribe(handlers, name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, handler) => subscribe(events, name, handler), emit: broadcast },
  });
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
    await emit("session_compact", { fromExtension: true });
  }
  await emit("session_before_compact", { preparation: { tokensBefore: 357421 }, reason: "manual" });
  clock += 5000;
  assert.doesNotMatch(paintFooter(), /≈\d+%/, "extension summaries cannot create a model ETA");
  await emit("session_compact_failed", { aborted: true });
  assert.equal(intervals.size, 0);

  for (const width of [1, 10, 20, 40, 80, 160]) paintFooter(width);
  const beforeSettlement = live().length;
  broadcast(HIDE_TRANSIENT_OVERLAYS_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(live().length, beforeSettlement, "cooperative settlement keeps both panel slots");

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
  await emit("session_shutdown");
  footer?.dispose();
  globalThis.fetch = originalFetch;
  globalThis.performance = originalPerformance;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}
