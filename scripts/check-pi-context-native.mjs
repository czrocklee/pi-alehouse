#!/usr/bin/env node
// Native pinned compositor/input routing with synthetic data only. Never start a
// terminal, create a session, resolve credentials or call a provider.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "../lib/token-format.mjs";
import { joinPopoverStack, stackedOverlayOptions } from "../lib/popover-stack.mjs";
import {
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  PINNED_POPOVER_YIELD_EVENT,
} from "../lib/overlay-protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { default: extension } = await jiti.import(join(root, "extensions/status-footer.ts"));
const { PresetPicker } = await jiti.import(join(root, "harness/src/ui/preset-picker.ts"));
const { PanelCoordinator } = await jiti.import(join(root, "harness/src/ui/panel-coordinator.ts"));
const theme = { fg: (_name, text) => text, bold: (text) => text, bg: (_name, text) => text };
const plain = (text) => stripVTControlCharacters(text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const totals = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 7000,
  cost: { total: 0.1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const fixtures = [];
let checks = 0;

async function fixture(rows = 24, columns = 120) {
  const handlers = new Map(),
    events = new Map(),
    commands = new Map();
  const sessionId = `synthetic-context-native-${fixtures.length}`;
  const state = {
    entries: ["a", "b", "c"].map((id, index, ids) => ({
      type: "message",
      id,
      parentId: index > 0 ? ids[index - 1] : null,
      message: {
        role: "assistant",
        provider: "fixture",
        model: id,
        api: "openai-responses",
        content: [],
        stopReason: "stop",
        usage: { ...totals },
      },
    })),
    projection: [],
    usage: { tokens: 357421, contextWindow: 500000, percent: 71.4842 },
    entriesReads: 0,
    entryReads: 0,
    usageReads: 0,
    projectionReads: 0,
  };
  const terminal = { rows, columns, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  tui.requestRender = () => {};
  tui.requestImmediateRender = () => {};
  const editor = {
    inputs: [],
    render: () => [],
    invalidate() {},
    handleInput(data) {
      this.inputs.push(data);
    },
  };
  tui.addChild(editor);
  tui.setFocus(editor);
  const opened = [],
    notifications = [];
  const show = tui.showOverlay.bind(tui);
  tui.showOverlay = (component, options) => {
    const handle = show(component, options);
    opened.push({ component, options, handle });
    return handle;
  };
  const subscribe = (map, name, callback) => {
    const set = map.get(name) ?? new Set();
    set.add(callback);
    map.set(name, set);
    return () => set.delete(callback);
  };
  const broadcast = (name, value = {}) => {
    for (const fn of [...(events.get(name) ?? [])]) fn(value);
  };
  let footer;
  const ctx = {
    cwd: "/p",
    mode: "tui",
    hasUI: true,
    thinkingLevel: "off",
    model: { id: "m", provider: "fixture", api: "openai-codex-responses", contextWindow: 500000 },
    modelRegistry: {
      isUsingOAuth: () => false,
      getProvider: () => undefined,
      getApiKeyAndHeaders() {
        throw new Error("Credential resolution is forbidden");
      },
    },
    getContextUsage() {
      state.usageReads++;
      return { ...state.usage };
    },
    getSystemPrompt: () => "SYNTHETIC SYSTEM BODY",
    sessionManager: {
      getEntries() {
        state.entriesReads++;
        return state.entries.slice();
      },
      getBranch: () => [],
      // Model the public append-only SDK seam. A leaf alone is not reliable
      // session identity, and incremental accounting must verify the new chain.
      getSessionId: () => sessionId,
      getEntryCount: () => state.entries.length,
      getEntry(id) {
        state.entryReads++;
        return state.entries.find((entry) => entry.id === id);
      },
      getLeafId: () => state.entries.at(-1)?.id ?? null,
      buildSessionProjection() {
        state.projectionReads++;
        return { entries: state.projection };
      },
    },
    ui: {
      notify(message) {
        notifications.push(message);
      },
      onTerminalInput: (callback) => tui.addInputListener(callback),
      setFooter(factory) {
        footer = factory(tui, theme, {
          onBranchChange: () => () => {},
          getGitBranch: () => undefined,
          getExtensionStatuses: () => [],
        });
      },
    },
  };
  const emit = async (name, value = {}) => {
    for (const fn of [...(handlers.get(name) ?? [])]) await fn(value, ctx);
  };
  const pi = {
    on: (name, fn) => subscribe(handlers, name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, fn) => subscribe(events, name, fn), emit: broadcast },
  };
  extension(pi);
  await emit("session_start");
  const paint = () => {
    let lines;
    for (let pass = 0; pass < 4; pass++) {
      const base = Array(terminal.rows).fill("");
      base[terminal.rows - 1] = footer.render(terminal.columns)[0];
      lines = tui.compositeOverlays(base, terminal.columns, terminal.rows);
    }
    return lines.map(plain);
  };
  const clickFooter = (needle) => {
    const line = plain(footer.render(terminal.columns)[0]),
      index = line.indexOf(needle);
    assert(index >= 0, `footer missing ${needle}: ${line}`);
    footer.handleMouse({
      type: "click",
      button: "left",
      x: visibleWidth(line.slice(0, index)) + 1,
      y: 0,
    });
    paint();
    return opened.at(-1);
  };
  const h = {
    state,
    terminal,
    tui,
    editor,
    ctx,
    pi,
    emit,
    broadcast,
    notifications,
    opened,
    paint,
    get footer() {
      return footer;
    },
    openUsage: () => clickFooter("↑"),
    openContext: () => clickFooter("357k/500k"),
    async command() {
      await commands.get("context").handler("", ctx);
      paint();
      return opened.at(-1);
    },
    snapshot(panel) {
      return panel.component.options.snapshot();
    },
    async dispose() {
      await emit("session_shutdown");
      footer.dispose();
    },
  };
  fixtures.push(h);
  return h;
}
function picker(h) {
  const member = joinPopoverStack(h.tui);
  const component = new PresetPicker({
    tui: h.tui,
    theme,
    keybindings: { matches: () => false },
    presets: [{ name: "off" }],
    activeName: "off",
    pointer: true,
    done() {},
    rows: () => member.available(),
    onRender: (height) => member.measure(height),
  });
  const handle = h.tui.showOverlay(
    component,
    stackedOverlayOptions(member, { width: 76, minWidth: 34, minRows: 7 }),
  );
  return {
    member,
    component,
    handle,
    close() {
      handle.hide();
      member.leave();
    },
  };
}
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network is forbidden in Context UI checks");
};
try {
  // A passive pin must not advertise editor keys, including the detail page.
  {
    const h = await fixture();
    const panel = h.openContext();
    assert.equal(h.tui.getFocusedComponent(), h.editor);
    let lines = panel.component.render(panel.options.width).map(plain);
    assert.doesNotMatch(lines.at(-1), /Esc|Enter|Tab|↑↓/);
    await h.command();
    assert.equal(h.tui.getFocusedComponent(), panel.component);
    lines = panel.component.render(panel.options.width).map(plain);
    assert.match(lines.at(-1), /Esc/);
    h.tui.setFocus(h.editor);
    assert.doesNotMatch(
      panel.component.render(panel.options.width).map(plain).at(-1),
      /Esc|Enter|Tab|↑↓/,
    );
    checks++;
  }
  // Hidden explicit requests notify, then reveal at most once if input still belongs to the request.
  for (const later of [
    "none",
    "editor-input",
    "key-release",
    "arrow-release",
    "key-repeat",
    "paste",
    "dialog",
    "closed",
  ]) {
    const h = await fixture(14),
      usage = h.openUsage();
    assert.equal(usage.handle.getBounds().height, 8);
    const panel = await h.command();
    assert.equal(panel.handle.getBounds(), undefined);
    assert.match(h.notifications.at(-1), /6 free rows|space|terminal/i);
    assert.equal(h.tui.getFocusedComponent(), h.editor);
    const dialog = { render: () => [], invalidate() {}, handleInput() {} };
    if (later === "editor-input") h.tui.handleTerminalInput("x");
    if (later === "key-release") h.tui.handleTerminalInput("\x1b[116;1:3u");
    if (later === "arrow-release") h.tui.handleTerminalInput("\x1b[1;1:3A");
    if (later === "key-repeat") h.tui.handleTerminalInput("\x1b[116;1:2u");
    if (later === "paste") h.tui.handleTerminalInput("\x1b[200~synthetic :3u\x1b[201~");
    if (later === "dialog") h.tui.setFocus(dialog);
    if (later === "closed") h.openContext();
    h.terminal.rows = 24;
    h.paint();
    await tick();
    h.paint();
    if (later === "none" || later === "key-release" || later === "arrow-release") {
      assert.equal(h.tui.getFocusedComponent(), panel.component);
      assert.deepEqual(h.editor.inputs, [], "release did not submit new editor input");
    } else assert.equal(h.tui.getFocusedComponent(), later === "dialog" ? dialog : h.editor);
    if (later === "editor-input") assert.deepEqual(h.editor.inputs, ["x"]);
    if (later === "key-repeat" || later === "paste") assert.equal(h.editor.inputs.length, 1);
    if (later === "dialog") {
      h.tui.setFocus(h.editor);
      h.terminal.rows = 14;
      h.paint();
      h.terminal.rows = 24;
      h.paint();
      await tick();
      assert.equal(
        h.tui.getFocusedComponent(),
        h.editor,
        "a later dialog permanently retires delayed focus",
      );
    }
    checks++;
  }
  // Releasing a lower slot also reveals a pending explicit request.
  {
    const h = await fixture(14);
    h.openUsage();
    const panel = await h.command();
    h.openUsage();
    h.paint();
    await tick();
    assert(panel.handle.getBounds());
    assert.equal(h.tui.getFocusedComponent(), panel.component);
    checks++;
  }
  // Holds span initial picker layout, settlement microtasks and restoration timers.
  for (const withUsage of [false, true]) {
    const h = await fixture(withUsage ? 24 : 16);
    if (withUsage) h.openUsage();
    const context = h.openContext(),
      before = context.handle.getBounds();
    const token = {},
      nested = {};
    h.broadcast(PINNED_POPOVER_YIELD_EVENT, { token, active: true });
    h.broadcast(PINNED_POPOVER_YIELD_EVENT, { token: nested, active: true });
    assert(!h.tui.overlayStack.some((entry) => entry.component === context.component));
    const pick = picker(h);
    h.paint();
    pick.handle.focus();
    assert(pick.handle.getBounds());
    assert(pick.member.available() >= 7);
    h.broadcast(HIDE_TRANSIENT_OVERLAYS_EVENT);
    await tick();
    h.paint();
    assert(pick.handle.getBounds(), "0ms settlement timer cannot remount held Context");
    h.broadcast(PINNED_POPOVER_YIELD_EVENT, { token, active: false });
    h.paint();
    assert(pick.handle.getBounds());
    assert(!h.tui.overlayStack.some((entry) => entry.component === context.component));
    pick.close();
    await h.emit("ui_prompt_start");
    h.broadcast(PINNED_POPOVER_YIELD_EVENT, { token: nested, active: false });
    h.paint();
    assert(!h.tui.overlayStack.some((entry) => entry.component === context.component));
    await h.emit("ui_prompt_end");
    h.paint();
    await tick();
    const restored = h.opened.filter((entry) => entry.component === context.component).at(-1);
    assert.deepEqual(
      restored.handle.getBounds(),
      before,
      "member order and original placement survive the hold",
    );
    assert.equal(h.tui.getFocusedComponent(), h.editor, "restoration stays passive");
    checks++;
  }
  // Real coordinator -> shared event -> real footer -> native compositor. This
  // exercises the actual open/hold/settle/close path, not only manual hold events.
  for (const withUsage of [false, true]) {
    const h = await fixture(withUsage ? 24 : 16),
      shortcuts = new Map();
    if (withUsage) h.openUsage();
    const context = h.openContext(),
      before = context.handle.getBounds();
    const candidate = { activeName: "off", names: ["off"] };
    const router = {
      prepare: () => candidate,
      inspect: () => [{ name: "off" }],
      isCurrent: () => true,
    };
    h.pi.registerShortcut = (name, spec) => shortcuts.set(name, spec);
    let mountedPicker;
    h.ctx.ui.custom = (factory, options) =>
      new Promise((resolve, reject) => {
        let handle;
        try {
          const component = factory(
            h.tui,
            theme,
            { matches: (data, key) => data === "\x1b" && key === "tui.select.cancel" },
            (choice) => {
              handle?.hide();
              resolve(choice);
            },
          );
          handle = h.tui.showOverlay(component, options.overlayOptions());
          mountedPicker = { component, handle };
          options.onHandle?.(handle);
        } catch (error) {
          reject(error);
        }
      });
    const panels = new PanelCoordinator({
      pi: h.pi,
      widget: { onOpen() {}, tuiMode: () => "fullscreen" },
      ready: () => true,
      router: () => router,
      publish() {
        assert.fail("UI cancellation must not publish routing or Owner changes");
      },
      showError(error) {
        throw error;
      },
    });
    panels.attachHost(h.ctx, h.pi.events);
    try {
      const opening = shortcuts.get("alt+s").handler();
      h.paint();
      const pick = mountedPicker;
      assert(pick?.handle.getBounds(), "actual picker is visible at its first native layout");
      assert(!h.tui.overlayStack.some((entry) => entry.component === context.component));
      await tick();
      h.paint();
      assert(pick.handle.getBounds(), "picker stays visible across the old 0ms restore boundary");
      assert.equal(h.tui.getFocusedComponent(), pick.component);
      pick.component.handleInput("\x1b");
      await opening;
      h.paint();
      await tick();
      h.paint();
      const restored = h.opened.filter((entry) => entry.component === context.component).at(-1);
      assert.deepEqual(restored.handle.getBounds(), before);
      assert.equal(h.tui.getFocusedComponent(), h.editor);
      checks++;
    } finally {
      panels.dispose();
    }
  }
  // Only same-turn foreground assistant metadata can supply a replay identity.
  {
    const h = await fixture();
    h.ctx.model = { provider: "router", id: "virtual", api: "pi-virtual", contextWindow: 500000 };
    const assistant = {
      role: "assistant",
      provider: "fixture",
      api: "openai-codex-responses",
      model: "physical-a",
      responseModel: "server-alias",
      stopReason: "stop",
      usage: totals,
      content: [
        {
          type: "thinking",
          thinking: "SYNTHETIC REASONING BODY",
          thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_synthetic", summary: [] }),
        },
        { type: "text", text: "SYNTHETIC TEXT BODY" },
      ],
      timestamp: 1,
    };
    h.state.projection = [
      {
        sourceEntry: { type: "message", id: "reasoning", message: assistant },
        messages: [assistant],
      },
    ];
    await h.emit("model_select");
    const panel = await h.command();
    assert.equal(h.snapshot(panel).replay, "unknown");
    assert.equal(h.snapshot(panel).allocation, "unattributed");
    await h.emit("turn_start");
    await h.emit("provider_stream_event", {
      provider: "fixture",
      api: "openai-codex-responses",
      model: "physical-a",
      data: {},
    });
    assert.equal(
      h.snapshot(panel).replay,
      "unknown",
      "uncorrelated provider hooks cannot supply a route",
    );
    await h.emit("message_start", { message: assistant });
    h.paint();
    assert.equal(h.snapshot(panel).replay, "observed");
    assert(h.snapshot(panel).items.some((row) => row.kind === "reasoning" && row.tokens > 0));
    await h.emit("message_end", { message: assistant });
    h.paint();
    assert.equal(h.snapshot(panel).replay, "observed");
    await h.emit("turn_start");
    h.paint();
    assert.equal(h.snapshot(panel).replay, "unknown", "last turn does not predict the next route");
    await h.emit("message_start", { message: { ...assistant, model: "physical-b" } });
    h.paint();
    assert.equal(h.snapshot(panel).replay, "observed");
    assert(!h.snapshot(panel).items.some((row) => row.kind === "reasoning"));
    await h.emit("message_end", {
      message: { ...assistant, model: "physical-b", stopReason: "aborted" },
    });
    h.paint();
    assert.equal(h.snapshot(panel).replay, "unknown");
    checks++;
  }
  // One opaque block must not erase otherwise available raw estimates from the
  // native footer panel; SDK attribution remains deliberately unattributed.
  {
    const h = await fixture();
    h.ctx.model = {
      provider: "fixture",
      id: "anthropic-physical",
      api: "anthropic-messages",
      contextWindow: 200000,
    };
    h.state.usage = { tokens: 120000, contextWindow: 200000, percent: 60 };
    const projection = [];
    for (let i = 0; i < 41; i++) {
      const message = {
        role: "assistant",
        provider: "fixture",
        model: "anthropic-physical",
        api: "anthropic-messages",
        stopReason: "toolUse",
        usage: { ...totals, reasoning: undefined },
        timestamp: i,
        content: [
          { type: "text", text: "SYNTHETIC TEXT ".repeat(10) },
          {
            type: "toolCall",
            id: `raw-call-${i}`,
            name: "read",
            arguments: { path: `synthetic/file-${i}.md` },
          },
        ],
      };
      projection.push({
        sourceEntry: { type: "message", id: `raw-assistant-${i}`, message },
        messages: [message],
      });
      const result = {
        role: "toolResult",
        toolCallId: `raw-call-${i}`,
        toolName: "read",
        timestamp: i,
        content: [{ type: "text", text: "SYNTHETIC RESULT ".repeat(50) }],
      };
      projection.push({
        sourceEntry: { type: "message", id: `raw-result-${i}`, message: result },
        messages: [result],
      });
    }
    const opaque = {
      role: "assistant",
      provider: "fixture",
      model: "anthropic-physical",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: { ...totals, reasoning: undefined },
      timestamp: 42,
      content: [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          redacted: true,
          thinkingSignature: "SYNTHETIC_OPAQUE",
        },
      ],
    };
    projection.push({
      sourceEntry: { type: "message", id: "opaque", message: opaque },
      messages: [opaque],
    });
    h.state.projection = projection;
    const panel = await h.command(),
      snapshot = h.snapshot(panel);
    assert.equal(snapshot.allocation, "unattributed");
    assert.equal(snapshot.categories.find((row) => row.id === "other").tokens, 120000);
    assert(snapshot.items.filter((row) => row.rawState === "estimate").length > 100);
    assert(
      snapshot.items.filter((row) => row.category !== "other").every((row) => row.tokens === null),
    );
    const lines = panel.component.render(panel.options.width).map(plain);
    assert.match(lines[2], /≈raw/);
    assert.doesNotMatch(lines[2], /%used/);
    const known = panel.component.rows
      .slice(panel.component.offset, panel.component.offset + panel.component.viewport)
      .find((row) => row.rawState === "estimate" && row.rawTokens > 0);
    assert(known, "visible source list retains known raw sources");
    const sourceLine = lines.find((line) => line.includes(known.label));
    assert(sourceLine?.includes(formatTokenCount(known.rawTokens, { precision: "compact" })));
    assert.match(lines.join("\n"), /120k\/200k/);
    assert.match(plain(h.footer.render(120)[0]), /120k\/200k/);
    assert(
      snapshot.items.some((row) => row.kind === "reasoning-unknown" && row.rawState === "unknown"),
    );
    checks++;
  }
  // Whole quota values only, across every integer width, plus exact Context formatting.
  {
    const h = await fixture();
    await h.emit("after_provider_response", {
      headers: {
        "x-codex-primary-used-percent": "88",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-window-minutes": "300",
        "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
        "x-codex-secondary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
    for (let width = 20; width <= 160; width++) {
      const line = plain(h.footer.render(width)[0]);
      assert(visibleWidth(line) <= width);
      if (/\bW\b/.test(line)) assert.match(line, /W 12%/);
      if (/\b5h\b/.test(line)) assert.match(line, /5h 80%/);
    }
    h.state.usage = { tokens: 5040, contextWindow: 10000, percent: 50.4 };
    await h.emit("turn_end"); // New SDK totals arrive at a public context boundary.
    const panel = await h.command();
    assert.match(plain(h.footer.render(120)[0]), /5\.0k\/10k/);
    assert.match(panel.component.render(panel.options.width).map(plain).join("\n"), /5\.0k\/10k/);
    h.state.usage = { tokens: null, contextWindow: 10000, percent: null };
    await h.emit("turn_end");
    h.paint();
    assert.match(plain(h.footer.render(120)[0]), /\?\/10k/);
    assert.match(panel.component.render(panel.options.width).map(plain).join("\n"), /\?\/10k/);
    checks++;
  }
  // Animation reuses spend, but an independent usage append must invalidate it.
  {
    const h = await fixture();
    h.openContext();
    h.paint();
    const realInterval = globalThis.setInterval,
      realClear = globalThis.clearInterval;
    let callback;
    globalThis.setInterval = (fn, interval) => {
      assert.equal(interval, 100);
      callback = fn;
      return { unref() {} };
    };
    globalThis.clearInterval = () => {
      callback = undefined;
    };
    try {
      await h.emit("session_before_compact", {
        preparation: { tokensBefore: 357421 },
        reason: "manual",
      });
      const baseline = h.state.entriesReads,
        projected = h.state.projectionReads;
      const lookups = h.state.entryReads,
        usageReads = h.state.usageReads;
      assert.match(plain(h.footer.render(120)[0]), /\$0\.300/);
      for (let i = 0; i < 10; i++) {
        callback();
        h.paint();
      }
      assert.equal(
        h.state.entriesReads,
        baseline,
        "unchanged leaf does not rescan spend on 10Hz paints",
      );
      assert.equal(
        h.state.entryReads,
        lookups,
        "unchanged leaf does not repeat incremental lookups either",
      );
      assert.equal(
        h.state.usageReads,
        usageReads,
        "compaction animation shares its frozen SDK total",
      );
      assert.equal(h.state.projectionReads, projected, "frozen composition is not recollected");
      h.state.entries.push({
        type: "usage",
        id: "warm",
        parentId: h.ctx.sessionManager.getLeafId(),
        provider: "fixture",
        model: "warming",
        usage: totals,
      });
      h.paint();
      assert.equal(
        h.state.entriesReads,
        baseline,
        "usage-only append avoids rescanning historical spend",
      );
      assert.equal(
        h.state.entryReads,
        lookups + 1,
        "usage-only leaf append refreshes spend exactly once",
      );
      assert.match(
        plain(h.footer.render(120)[0]),
        /\$0\.400/,
        "independent usage is included in the rendered total",
      );
      h.paint();
      assert.equal(
        h.state.entryReads,
        lookups + 1,
        "later paints reuse the refreshed independent usage",
      );
      await h.emit("session_compact_failed", { aborted: true });
      assert.equal(callback, undefined);
    } finally {
      globalThis.setInterval = realInterval;
      globalThis.clearInterval = realClear;
    }
    const getLeafId = h.ctx.sessionManager.getLeafId;
    delete h.ctx.sessionManager.getLeafId;
    let baseline = h.state.entriesReads;
    h.footer.render(120);
    h.footer.render(120);
    assert.equal(
      h.state.entriesReads,
      baseline + 2,
      "no-leaf hosts retain a fresh per-frame fallback",
    );
    h.ctx.sessionManager.getLeafId = getLeafId;
    delete h.ctx.sessionManager.getSessionId;
    baseline = h.state.entriesReads;
    const usageReads = h.state.usageReads;
    h.footer.render(120);
    h.footer.render(120);
    assert.equal(
      h.state.entriesReads,
      baseline + 2,
      "a leaf without session identity must also read spend freshly",
    );
    assert.equal(
      h.state.usageReads,
      usageReads + 2,
      "a leaf without session identity cannot cache SDK context usage",
    );
    checks++;
  }
  console.log(
    `PASS: ${checks} native Context lifecycle/focus/route/quota/cache scenarios (offline synthetic, no terminal/model/network)`,
  );
} finally {
  for (const h of fixtures) await h.dispose();
  globalThis.fetch = realFetch;
}
