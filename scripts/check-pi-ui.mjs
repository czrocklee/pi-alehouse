#!/usr/bin/env node
// Local UI regressions against the installed Pi runtime; no model or network calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

const [piExecutable, footerEntry] = process.argv.slice(2);
assert(piExecutable, "Usage: node script/check-pi-ui.mjs PI_EXECUTABLE [BUILT_FOOTER]");
const root = resolve(import.meta.dirname, "..");
const require = createRequire(realpathSync(piExecutable));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
});
const extensions = join(root, "extensions");
const { default: titleExtension } = await jiti.import(join(extensions, "terminal-title-status.ts"));
const { default: footerExtension } = await jiti.import(footerEntry ?? join(extensions, "status-footer.ts"));
const { default: approvalExtension, ApprovalPopover, APPROVAL_ENTRY, approvalChoices, approvalStatus, currentChoice } =
  await jiti.import(join(extensions, "approval-mode.ts"));
const { SESSION_YOLO_KEY } = await jiti.import(join(extensions, "lib/approval-protocol.ts"));
const { managedSessionYolo } = await jiti.import(join(root, "permission-system/managed-session-yolo.ts"));
const { default: statsExtension, healthStatus } = await jiti.import(join(extensions, "stats.ts"));
const { SessionStats } = await jiti.import(join(extensions, "lib/session-stats.ts"));
const { WorkerStats } = await jiti.import(join(extensions, "lib/worker-stats.ts"));
// Drive the independently loaded footer through the harness's exported shared
// protocol. This checks their interaction, not merely equality of source text.
const { HIDE_TRANSIENT_OVERLAYS_EVENT } = await jiti.import(
  join(root, "harness/src/ui/overlay-request.ts"));
const { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR, HEALTH_INDICATOR } = await import(
  pathToFileURL(join(root, "lib/overlay-protocol.mjs")).href);
// The harness joins the same column from its own bundle; so does this script.
const { joinPopoverStack, stackedOverlayOptions } = await import(
  pathToFileURL(join(root, "lib/popover-stack.mjs")).href);
const { POPOVER } = await jiti.import(
  join(root, "harness/src/ui/popover.ts"));
const { PresetPicker } = await jiti.import(
  join(root, "harness/src/ui/preset-picker.ts"));
const { TuiAltScreen, visibleWidth } = await import(require.resolve("@earendil-works/pi-tui"));
// Pi's package export is import-only; resolve its SDK beside the selected CLI,
// including the installed bundled CLI layout, rather than using dev dependencies.
let sdkRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(sdkRoot, "package.json"))) {
  assert.notEqual(sdkRoot, dirname(sdkRoot), "Pi package not found");
  sdkRoot = dirname(sdkRoot);
}
assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).name, "@earendil-works/pi-coding-agent");
const { SessionManager, AgentSession, createEventBus, ExtensionRunner } = await import(pathToFileURL(join(sdkRoot, "dist/index.js")));
const { STATS_WORKER_ATTACH } = await import(pathToFileURL(join(root, "lib/stats-protocol.mjs")));

function fixture(mode = "tui", sdkDispatch = false) {
  const handlers = new Map(), errors = [];
  const listeners = new Map();
  const titles = [];
  const widgets = new Map();
  const terminal = { setTitle: (title) => titles.push(title) };
  const originalSetTitle = terminal.setTitle;
  let name;
  const ctx = {
    mode,
    cwd: "/fixture/project",
    ui: {
      setTitle: (title) => terminal.setTitle(title),
      setWidget(key, factory) {
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        if (factory) widgets.set(key, factory({ terminal }));
      },
    },
  };
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
    },
    getSessionName: () => name,
    events: {
      on(event, handler) {
        const list = listeners.get(event) ?? new Set();
        list.add(handler);
        listeners.set(event, list);
        return () => list.delete(handler);
      },
      emit(event, value) {
        for (const handler of listeners.get(event) ?? []) handler(value);
      },
    },
  };
  if (sdkDispatch) pi.events = createEventBus();
  return {
    pi, ctx, titles, listeners, terminal, originalSetTitle, widgets, errors,
    rename: (value) => { name = value; },
    async emit(event, value = {}) {
      if (sdkDispatch) return ExtensionRunner.prototype.emit.call({
        extensions: [{ path: "ui-fixture", handlers }], createContext: () => ctx,
        isSessionBeforeEvent: ExtensionRunner.prototype.isSessionBeforeEvent,
        emitError: (error) => errors.push(error),
      }, { ...value, type: event });
      for (const handler of [...(handlers.get(event) ?? [])]) await handler(value, ctx);
    },
  };
}

const plainTitle = (title) => title.replace(/[\u0332\u0333]/g, "");

test("title keeps π while working and replaces it with ! during approval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  titleExtension(f.pi);
  t.after(() => f.emit("session_shutdown"));
  await f.emit("session_start");
  assert.equal(f.titles.at(-1), "π - project");
  // Pi core writes its default title after all session_start handlers finish.
  f.terminal.setTitle("π - project - default");
  assert.equal(f.titles.at(-1), "π - project");
  assert.deepEqual([...f.widgets.values()][0].render(80), []);
  await f.emit("agent_start");
  t.mock.timers.tick(33 * 8);
  assert.match(f.titles.at(-1), /[\u0332\u0333]/);
  assert.equal(plainTitle(f.titles.at(-1)), "π - project");
  // A core title write during streaming must preserve the current frame too.
  const animated = f.titles.at(-1);
  f.terminal.setTitle("π - project");
  assert.equal(f.titles.at(-1), animated);
  f.rename("新任务");
  f.terminal.setTitle("π - 新任务 - project");
  await f.emit("session_info_changed");
  assert.equal(plainTitle(f.titles.at(-1)), "π - 新任务");
  f.pi.events.emit("permissions:ui_prompt", { requestId: "a" });
  f.pi.events.emit("permissions:ui_prompt", { requestId: "b" });
  assert.equal(f.titles.at(-1), "! - 新任务");
  const pausedCount = f.titles.length;
  t.mock.timers.tick(330);
  assert.equal(f.titles.length, pausedCount, "approval pauses animation");
  f.pi.events.emit("permissions:decision", { requestId: "a" });
  assert.equal(f.titles.at(-1), "! - 新任务");
  f.pi.events.emit("permissions:decision", { requestId: "b" });
  t.mock.timers.tick(33 * 8);
  assert.match(f.titles.at(-1), /[\u0332\u0333]/);
  await f.emit("agent_settled");
  assert.equal(f.titles.at(-1), "π - 新任务");
  const settledCount = f.titles.length;
  t.mock.timers.tick(330);
  assert.equal(f.titles.length, settledCount, "settlement stops animation");
  assert(f.titles.every((title) => /^(π|!) - /.test(title)));
});

for (const running of [false, true]) {
  test(`expired approval restores the ${running ? "working" : "idle"} title without a matching decision`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture();
    titleExtension(f.pi);
    t.after(() => f.emit("session_shutdown"));
    await f.emit("session_start");
    if (running) await f.emit("agent_start");
    f.pi.events.emit("permissions:ui_prompt", { requestId: "expired" });
    assert.equal(f.titles.at(-1), "! - project");
    // Upstream's fail-closed exception boundary mints a different request ID.
    f.pi.events.emit("permissions:decision", { requestId: "gate-error", resolution: "gate_error", result: "deny" });
    assert.equal(f.titles.at(-1), "! - project");
    f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "expired" });
    assert.equal(plainTitle(f.titles.at(-1)), "π - project");
    t.mock.timers.tick(33 * 8);
    assert.equal(/[\u0332\u0333]/.test(f.titles.at(-1)), running, "only actual work resumes animation");
    f.terminal.setTitle("core rewrite");
    assert.equal(plainTitle(f.titles.at(-1)), "π - project", "core writes cannot resurrect the expired marker");
  });
}

test("ending one approval never clears another, including a worker ask after parent settlement", async (t) => {
  const f = fixture();
  titleExtension(f.pi);
  t.after(() => f.emit("session_shutdown"));
  await f.emit("session_start");
  f.pi.events.emit("permissions:ui_prompt", { requestId: "local" });
  f.pi.events.emit("permissions:ui_prompt", { requestId: "worker", forwarding: { requesterSessionId: "child" } });
  await f.emit("agent_settled");
  await f.emit("ui_prompt_end", { kind: "custom" });
  for (const value of [null, undefined, {}, { requestId: "" }, { requestId: 7 }, { requestId: "unrelated" }]) {
    f.pi.events.emit("managed-permissions:ui_prompt_end:v1", value);
  }
  assert.equal(f.titles.at(-1), "! - project");
  f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
  f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
  f.pi.events.emit("permissions:decision", { requestId: "local" });
  assert.equal(f.titles.at(-1), "! - project", "late/duplicate local events leave the worker ask intact");
  f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "worker" });
  assert.equal(f.titles.at(-1), "π - project");
  const writes = f.titles.length;
  f.pi.events.emit("permissions:decision", { requestId: "worker" });
  assert.equal(f.titles.length, writes, "the eventual decision is an idempotent fallback");
});

test("title sanitizes labels and releases timers/listeners at shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  titleExtension(f.pi);
  f.rename("abcdefghijklmnop\n\x07");
  await f.emit("session_start");
  assert.equal(f.titles.at(-1), "π - abcdefghijk…");
  await f.emit("agent_start");
  t.mock.timers.tick(330);
  await f.emit("session_shutdown");
  assert.equal(f.titles.at(-1), "π - abcdefghijk…");
  const count = f.titles.length;
  t.mock.timers.tick(330);
  f.pi.events.emit("permissions:ui_prompt", { requestId: "late" });
  assert.equal(f.titles.length, count);
  assert([...f.listeners.values()].every((set) => set.size === 0));
  assert.equal(f.terminal.setTitle, f.originalSetTitle);
  assert.equal(f.widgets.size, 0);
});

test("non-TUI sessions do not set terminal titles", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const mode of ["rpc", "json", "print"]) {
    const f = fixture(mode);
    titleExtension(f.pi);
    await f.emit("session_start");
    await f.emit("agent_start");
    t.mock.timers.tick(330);
    await f.emit("session_info_changed");
    await f.emit("agent_settled");
    await f.emit("session_shutdown");
    assert.deepEqual(f.titles, []);
  }
});

const MARKER = "\u0000pi-status-footer\u0000";
const FOOTER_ROWS = 24;
/** The footer occupies one row, which is what the overlay must clear. */
const FOOTER_HEIGHT = 1;
const FOOTER_COLUMNS = 300;

function usage(input, output, cacheRead, cacheWrite, cost) {
  return {
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

/** Every payer the overlay listed, in the order it listed them. */
const spendKeys = (lines) => lines.slice(1, -1)
  .map((line) => line.replace(/^\s*│ ?/, "").split(/\s{2,}/)[0].trim())
  .filter((key) => key && !/^[\u2500-\u257f]+$/.test(key));

/** The × closes every popover from the right end of its top edge. */
const CLOSE_TAIL = ` ${POPOVER.close} ${POPOVER.h}${POPOVER.tr}`;
/** Visible column of the × on a painted top edge, ANSI or not. */
const closeColumn = (top) => stripVTControlCharacters(top).indexOf(POPOVER.close);
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Real footer and SDK overlay compositor; no terminal I/O or scheduled paints. */
async function mountFooter({ mode = "regular", entries = [], sessionManager, statuses = new Map(), theme } = {}) {
  const f = fixture();
  const overlays = [];
  const inputHandlers = new Set();
  const originalRender = () => [];
  const terminal = { rows: FOOTER_ROWS, columns: FOOTER_COLUMNS, hideCursor() {} };
  const compositor = new TuiAltScreen(terminal, false, undefined, {});
  compositor.requestRender = () => {};
  let unsubscribed = false;
  const tui = {
    mode,
    render: originalRender,
    requestRender() {},
    terminal,
    showOverlay(component, options) {
      const entry = { component, options, hidden: false, lines: [], handle: undefined };
      const handle = compositor.showOverlay({ ...component, render(width) {
        entry.lines = component.render(width);
        return entry.lines;
      } }, options);
      entry.handle = handle;
      overlays.push(entry);
      return { hide: () => { entry.hidden = true; handle.hide(); }, getBounds: () => handle.getBounds() };
    },
  };
  theme ??= { fg: (_color, text) => text, bold: (text) => text };
  let footer;
  f.ctx.ui.setFooter = (factory) => {
    footer = factory(tui, theme, {
      getGitBranch: () => "main",
      getExtensionStatuses: () => statuses,
      onBranchChange: () => () => { unsubscribed = true; },
    });
  };
  f.ctx.ui.onTerminalInput = (handler) => {
    inputHandlers.add(handler);
    return () => inputHandlers.delete(handler);
  };
  f.ctx.sessionManager = sessionManager ?? { getEntries: () => entries };
  f.ctx.getContextUsage = () => ({ tokens: 100, contextWindow: 1000, percent: 10 });
  f.ctx.model = { id: "test-model", provider: "fixture", reasoning: true };
  f.ctx.thinkingLevel = "high";
  footerExtension(f.pi);
  await f.emit("session_start");
  const visible = () => overlays.filter((entry) => !entry.hidden);
  const paintOverlay = () => {
    const base = Array(terminal.rows).fill(" ".repeat(terminal.columns));
    base[terminal.rows - 1] = footer.render(terminal.columns)[0];
    // Exercise real width resolution, terminal clamping and bottom anchoring.
    return compositor.compositeOverlays(base, terminal.columns, terminal.rows);
  };
  return {
    f, footer, tui, overlays, visible, paintOverlay,
    bounds: () => visible().at(-1).handle.getBounds(),
    originalRender,
    line: (width = FOOTER_COLUMNS) => footer.render(width)[0].replace(MARKER, ""),
    wasUnsubscribed: () => unsubscribed,
    inputHandlers,
    feed: (data) => { for (const handler of inputHandlers) handler(data); },
    // The footer is the last row; a pointer over it arrives with local coordinates.
    hover: (x = 0) => footer.handleMouse({
      type: "move", button: "none", x, y: 0, screenX: x, screenY: terminal.rows - 1,
      width: terminal.columns, height: FOOTER_HEIGHT, shift: false, alt: false, ctrl: false,
    }),
    clickFooter: (x = 0) => footer.handleMouse({
      type: "click", button: "left", x, y: 0, screenX: x, screenY: terminal.rows - 1,
      width: terminal.columns, height: FOOTER_HEIGHT, shift: false, alt: false, ctrl: false,
    }),
    clickOverlay: (x = 1, y = 1, button = "left") => visible().at(-1).component.handleMouse({
      type: "click", button, x, y, screenX: x, screenY: y,
      width: visible().at(-1).options.width, height: 10, shift: false, alt: false, ctrl: false,
    }),
    overlayLines: (width) => {
      if (width !== undefined) return visible().at(-1).component.render(width);
      paintOverlay();
      return visible().at(-1).lines;
    },
  };
}

test("footer hides subagent indicators but retains unrelated status and metrics", async () => {
  const mounted = await mountFooter({
    statuses: new Map([
      ["subagents", "HIDDEN_RUNNING"],
      ["other-extension", "OTHER_STATUS\n ready"],
    ]),
  });
  const { f, footer, tui, originalRender } = mounted;
  try {
    f.pi.events.emit("subagents:created", { id: "child" });
    const line = mounted.line();
    assert(!line.includes("HIDDEN"));
    assert(!line.includes("sub 1"));
    for (const expected of ["test-model", "(high)", "100/1.0k", "OTHER_STATUS ready", "(main)"]) {
      assert(line.includes(expected), `Missing footer content: ${expected}`);
    }
    for (const width of [1, 20, 80, 300]) {
      assert(visibleWidth(footer.render(width)[0].replace(MARKER, "")) <= width);
    }
    assert.equal(f.listeners.get("subagents:created"), undefined, "footer does not track subagent activity");
    assert.equal(f.listeners.get(HIDE_TRANSIENT_OVERLAYS_EVENT)?.size, 1);
  } finally {
    footer.dispose();
  }
  assert([...f.listeners.values()].every((listeners) => listeners.size === 0));
  assert(mounted.wasUnsubscribed());
  // The original function is restored via its bound wrapper.
  assert.deepEqual(tui.render(80), originalRender(80));
});

// Four payers in entry order, so the overlay has to do the cost ordering itself.
const spendEntries = [
  { type: "message", message: { role: "assistant", provider: "openai-codex", model: "fixture-strong-model", usage: usage(1000, 200, 5000, 100, 0.25) } },
  { type: "message", message: { role: "assistant", provider: "openai-codex", model: "auto", responseModel: "gpt-5.6-luna", usage: usage(10, 20, 0, 0, 0.01) } },
  { type: "message", message: { role: "toolResult", usage: usage(50, 60, 0, 0, 0.5) } },
  { type: "compaction", usage: usage(7, 8, 0, 0, 0.02) },
  // Output with no prompt at all: a hit rate of nothing is unknown, not zero.
  { type: "message", message: { role: "assistant", provider: "ollama", model: "qwen3.8:27b", usage: usage(0, 500, 0, 0, 0) } },
];

test("clicking the footer breaks tokens and cost down by model id without providers", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  const { footer } = mounted;
  try {
    assert.deepEqual(mounted.visible(), [], "no overlay before the click");
    mounted.clickFooter();
    assert.equal(mounted.visible().length, 1);
    const lines = mounted.overlayLines();
    const rows = lines.map((line) => line.trim());
    assert(rows[0].includes("usage by model"));
    // Ordered by cost, so the answer to "where did the money go" is the top row.
    // Every payer, in full: filtering to the expected set would let the overlay
    // grow a bogus row, or double one, without the gate noticing.
    assert.deepEqual(spendKeys(lines), ["model", "tools", "fixture-strong-model", "main · compact/summaries",
      "gpt-5.6-luna", "qwen3.8:27b", "total"]);
    assert(!lines.some((line) => /openai-codex|ollama/.test(line)));
    assert(stripVTControlCharacters(lines[0]).endsWith(CLOSE_TAIL), "the × replaces the old Dismiss row");
    assert(!lines[1].includes(" W "), "cache-write is already included in prompt tokens and need not be an all-zero column");
    // `responseModel` is what answered; the `auto` alias never appears.
    assert(!lines.some((line) => /\bauto\b/.test(line)));
    const total = lines.find((line) => line.includes("total"));
    assert(total.includes("0.780"), total);
    // The row the pointer is on must agree with the total the overlay shows,
    // for the cache hit rate as much as for the money.
    assert(mounted.line().includes("$0.780"));
    assert(total.includes("81.1%"), total);
    assert(mounted.line().includes("81.1%"));
    // Per model, the rate is that model's own prompt, not the session's.
    const astra = lines.find((line) => line.includes("fixture-strong-model"));
    assert(astra.includes("82.0%"), astra);
    const local = lines.find((line) => line.includes("qwen3.8:27b"));
    assert(local.includes("?"), local);
    assert(lines.some((line) => line.includes("6.1k")), "cached prompt tokens are rolled up");
    // A pinned panel is not a dialog: it must not take the keyboard, and it
    // must leave the footer row reachable for the next click.
    const options = mounted.visible().at(-1).options;
    assert.equal(options.nonCapturing, true, "a capturing overlay would steal the editor");
    assert.equal(options.anchor, "bottom-right");
    assert.equal(options.margin.bottom, FOOTER_HEIGHT, "a smaller margin would sit on the footer itself");

    // An overlay wider than the terminal, or one row tall, must still be a box.
    for (const width of [1, 12, 20, 40, 80, 300]) {
      for (const line of mounted.overlayLines(width)) {
        assert(visibleWidth(line) <= width, `overlay line exceeds ${width}: ${line}`);
      }
    }
    // Clipping to a sliver is not the same as still being a box, so check the
    // frame at a width that has room for one.
    const framed = mounted.overlayLines(60);
    assert(framed[0].startsWith(POPOVER.tl + POPOVER.h) && framed[0].includes(POPOVER.tr), framed[0]);
    // Body rows and the rule that separates the total both carry their verticals.
    for (const line of framed.slice(1, -1)) {
      assert(line.startsWith(POPOVER.v) || line.startsWith(POPOVER.ml), line);
      assert(line.trimEnd().endsWith(POPOVER.v) || line.trimEnd().endsWith(POPOVER.mr), line);
    }
    assert(framed.at(-1).startsWith(POPOVER.bl) && framed.at(-1).endsWith(POPOVER.br), framed.at(-1));
  } finally {
    footer.dispose();
  }
});

test("native SDK UsageEntries, including unknown kinds, match session totals without double billing", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("footer accounting must not call the network"); });
  const manager = SessionManager.inMemory("/fixture/project");
  const first = manager.appendMessage({ role: "user", content: "accounting fixture", timestamp: 0 });
  manager.appendMessage({ role: "assistant", provider: "p", model: "alias", responseModel: "shared-model",
    api: "fixture", content: [], stopReason: "stop", timestamp: 1, usage: usage(100, 20, 30, 40, 1) });
  manager.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "bash", content: [], isError: false,
    timestamp: 2, usage: { ...usage(50, 6, 7, 8, 2), harnessModels: [workerRow("p/shared-model", 25, 1)] } });
  manager.appendCompaction("fixture summary", first, 100, undefined, false, usage(9, 10, 11, 12, 0.25));
  manager.branchWithSummary(manager.getLeafId(), "fixture branch summary", undefined, false, usage(13, 14, 15, 16, 0.5));
  manager.appendUsage("cache_warm", "p", "shared-model", usage(17, 18, 19, 20, 0.125));
  manager.appendUsage("cache_warm", "q", "shared-model", usage(21, 22, 23, 24, 0.75));
  manager.appendUsage("future-kind", "p", "warm-only", usage(0, 0, 5, 0, 0));
  const mounted = await mountFooter({ mode: "fullscreen", sessionManager: manager });
  try {
    mounted.clickFooter(); mounted.overlayLines();
    // A new kind arrives while the popover stays open. It is ordinary spend,
    // not a reason to drop the entry or add a separate same-model row.
    manager.appendUsage("unknown-operation", "p", "shared-model", usage(1, 2, 3, 4, 0.0625));
    const before = structuredClone(manager.getEntries());
    const native = AgentSession.prototype.getSessionStats.call({ sessionManager: manager,
      sessionId: manager.getSessionId(), getContextUsage: () => undefined });
    assert.equal(native.cost, 4.6875);
    for (const [key, value] of Object.entries({ input: 211, output: 92, cacheRead: 113, cacheWrite: 124 })) {
      assert.equal(native.tokens[key], value);
    }
    const prompt = native.tokens.input + native.tokens.cacheRead + native.tokens.cacheWrite;
    const line = mounted.line(), lines = mounted.overlayLines();
    assert(line.includes(`↑ ${prompt} (${native.tokens.cacheRead} +${native.tokens.cacheWrite}, 25.2%)`), line);
    assert(line.includes(`↓ ${native.tokens.output}`), line);
    assert(line.includes(`$${native.cost.toFixed(3)}`), line);
    assert.deepEqual(spendKeys(lines), ["model", "shared-model", "tools", "main · compact/summaries", "shared-model", "warm-only", "total"]);
    const cells = (line) => line.replace(/^│\s*/, "").replace(/\s*│$/, "").split(/\s{2,}/);
    assert.deepEqual(lines.filter((line) => line.includes("shared-model")).map(cells), [
      ["shared-model", "259", "52", "20.1%", "40", "2.188"],
      ["shared-model", "68", "23", "33.8%", "22", "0.750"],
    ], "same provider/model merges assistant + worker + warming; other providers stay separate");
    assert.deepEqual(cells(lines.find((line) => line.includes("total"))), ["total", "448", "113", "25.2%", "92", "4.688"]);
    assert.equal(mounted.visible().length, 1);
    assert.deepEqual(manager.getEntries(), before, "footer only reads the SDK accounting source");
  } finally { mounted.footer.dispose(); }
});

test("the usage overlay uses the same popover chrome as the worker picker", async () => {
  const colors = [];
  const mounted = await mountFooter({
    mode: "fullscreen", entries: spendEntries,
    theme: { fg: (color, text) => { colors.push(color); return text; }, bold: (text) => text },
  });
  try {
    mounted.clickFooter();
    mounted.overlayLines(60);
    assert.ok(colors.includes("borderAccent"), "outer frame matches the picker");
    assert.ok(colors.includes("borderMuted"), "sides and dividers match the picker");
    assert.ok(colors.includes("accent"), "the title is accent like the picker label");
    assert.ok(!colors.includes("border"), "the old generic border color is not used");
    assert.equal(colors[0], "borderAccent");
  } finally { mounted.footer.dispose(); }
});

test("footer and usage counts carry rounded thousands into millions", async () => {
  const entry = { type: "message", message: { role: "assistant", provider: "fixture", model: "boundary-model",
    usage: usage(999499, 0, 0, 0, 1) } };
  const mounted = await mountFooter({ mode: "fullscreen", entries: [entry] });
  try {
    mounted.clickFooter();
    for (const [tokens, expected] of [[1000, "1.0k"], [999499, "999k"], [999500, "1.0M"],
      [999949, "1.0M"], [999950, "1.0M"], [999999, "1.0M"], [1000000, "1.0M"]]) {
      entry.message.usage = usage(tokens, 0, 0, 0, 1);
      mounted.f.ctx.getContextUsage = () => ({ tokens, contextWindow: 2000000, percent: tokens / 20000 });
      assert(mounted.line().includes(`${expected}/2.0M`));
      const lines = mounted.overlayLines(60);
      assert(lines.some((line) => line.includes(expected)));
      assert(!lines.some((line) => line.includes("1000k")));
    }
  } finally { mounted.footer.dispose(); }
});

test("the footer remains one physical row with long labels, paths and statuses", async () => {
  const breaks = /[\t\n\v\f\r\u0085\u2028\u2029]/;
  const mounted = await mountFooter({ mode: "fullscreen", statuses: new Map([["other", "status\n\t\u2028".repeat(100)]]) });
  try {
    mounted.f.ctx.cwd = "/fixture/长路径\n".repeat(80);
    mounted.f.ctx.model.id = "long-model\r\u2029".repeat(80);
    for (const width of [1, 12, 20, 80, 120, 300, 4000]) {
      const lines = mounted.footer.render(width);
      assert.equal(lines.length, FOOTER_HEIGHT);
      assert.doesNotMatch(lines[0], breaks);
      assert(visibleWidth(lines[0]) <= width);
    }
  } finally { mounted.footer.dispose(); }
});

test("footer model labels preserve the selected model id without providers", async () => {
  const mounted = await mountFooter();
  try {
    for (const id of ["gpt-5.6-sol", "fixture-strong-model", "gpt-5.6-terra", "gpt-5.6-luna",
      "qwen3.8:27b", "org/custom-model"]) {
      mounted.f.ctx.model = { id, provider: "hidden-provider", reasoning: true };
      assert(mounted.line().includes(`${id} (high)`));
      assert(!mounted.line().includes("hidden-provider"));
      assert.equal(mounted.f.ctx.model.id, id);
    }
  } finally { mounted.footer.dispose(); }
});

test("hiding providers does not merge their spend or strip model namespaces", async () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "p", model: "gpt-5.6-sol", usage: usage(100, 0, 0, 0, 1) } },
    { type: "message", message: { role: "assistant", provider: "q", model: "gpt-5.6-sol", usage: usage(200, 0, 0, 0, 2) } },
    { type: "message", message: { role: "assistant", provider: "router", model: "org/custom-model", usage: usage(300, 0, 0, 0, 3) } },
  ];
  const before = structuredClone(entries);
  const mounted = await mountFooter({ mode: "fullscreen", entries });
  try {
    mounted.clickFooter();
    const lines = mounted.overlayLines();
    assert.deepEqual(spendKeys(lines), ["model", "org/custom-model", "gpt-5.6-sol", "gpt-5.6-sol", "total"]);
    const sol = lines.filter((line) => line.includes("gpt-5.6-sol"));
    assert(sol[0].includes("2.000")); assert(sol[1].includes("1.000"));
    assert(mounted.line().includes("$6.000"));
    assert.deepEqual(entries, before);
  } finally { mounted.footer.dispose(); }
});

test("the pinned panel stays live and fits its × and chrome on empty and crowded screens", async () => {
  const entries = [];
  const mounted = await mountFooter({ mode: "fullscreen", entries });
  try {
    mounted.clickFooter();
    assert(mounted.overlayLines().some((line) => line.includes("no usage recorded")));
    assert(stripVTControlCharacters(mounted.overlayLines()[0]).endsWith(CLOSE_TAIL));
    for (let i = 0; i < 40; i++) entries.push({ type: "message", message: { role: "assistant",
      provider: "hidden-provider", model: `model-${i}`, usage: usage(100, 0, 0, 0, 1) } });
    for (const rows of [12, 24, 50]) {
      mounted.tui.terminal.rows = rows;
      const lines = mounted.overlayLines();
      const bounds = mounted.bounds();
      assert.equal(bounds.row + bounds.height, rows - FOOTER_HEIGHT, "the SDK anchors above the single footer row");
      assert.equal(bounds.col + bounds.width, mounted.tui.terminal.columns);
      assert.equal(bounds.height, lines.length, "all chrome fits above the footer, nothing is clipped");
      assert(lines.some((line) => line.includes("40.000")), "the total includes hidden rows");
      assert(stripVTControlCharacters(lines[0]).endsWith(CLOSE_TAIL));
      assert(lines.at(-1).startsWith(POPOVER.bl), "the frame still closes at the bottom");
      assert.equal(mounted.overlays.length, 1, "usage updates and resizing do not remount the panel");
    }
    const lines = mounted.overlayLines(60);
    mounted.clickOverlay(closeColumn(lines[0]), 0);
    assert.deepEqual(mounted.visible(), [], "× hit geometry follows the latest paint");
  } finally { mounted.footer.dispose(); }
});

test("a pinned panel follows real SDK resize layout and widens for new model usage", async () => {
  const entries = [];
  const mounted = await mountFooter({ mode: "fullscreen", entries });
  try {
    mounted.tui.terminal.columns = 20;
    mounted.clickFooter();
    mounted.overlayLines();
    assert.equal(mounted.bounds().width, 20);
    mounted.tui.terminal.columns = 120;
    mounted.overlayLines();
    const emptyWidth = mounted.bounds().width;
    assert(emptyWidth > 20, "widening cannot retain the opening-click width");
    const model = "a-much-longer-model-identity-after-the-panel-opened";
    entries.push({ type: "message", message: { role: "assistant", provider: "fixture", model, usage: usage(1000, 1, 0, 0, 1) } });
    let lines = mounted.overlayLines();
    const fullWidth = mounted.bounds().width;
    assert(fullWidth > emptyWidth, "new usage changes the panel's desired width without a reopen");
    assert(lines.some(line => line.includes(model)));
    for (const columns of [12, 20, 120, 300, 120]) {
      mounted.tui.terminal.columns = columns;
      const screen = mounted.paintOverlay();
      const bounds = mounted.bounds();
      assert.equal(bounds.width, Math.min(fullWidth, columns));
      assert.equal(bounds.col + bounds.width, columns);
      assert.equal(bounds.row + bounds.height, mounted.tui.terminal.rows - FOOTER_HEIGHT);
      assert.equal(screen.at(-1), mounted.footer.render(columns)[0], "the overlay never covers the footer");
      assert.equal(mounted.overlays.length, 1, "layout does not remount or lose the pinned state");
    }
    lines = mounted.overlayLines();
    mounted.clickOverlay(closeColumn(lines[0]), 0);
    assert.deepEqual(mounted.visible(), [], "the × follows the last layout");
  } finally { mounted.footer.dispose(); }
});

test("usage preferred width shares one fresh spend walk across a three-popover native frame", async () => {
  const entries = [];
  let entryReads = 0;
  const mounted = await mountFooter({ mode: "fullscreen", sessionManager: {
    getEntries() { entryReads++; return entries; },
  } });
  const extra = [];
  const addPanel = (preferredWidth) => {
    const member = joinPopoverStack(mounted.tui);
    const component = {
      render(width) { const lines = Array(4).fill("p".repeat(width)); member.measure(lines.length); return lines; },
      invalidate() {},
    };
    const options = stackedOverlayOptions(member, { width: preferredWidth, nonCapturing: true });
    const handle = mounted.tui.showOverlay(component, options);
    extra.push({ member, component, options, handle });
  };
  try {
    mounted.clickFooter();
    addPanel(30); addPanel(44);
    const usagePanel = mounted.visible().at(-1);
    const panels = [{ component: usagePanel.component, options: usagePanel.options }, ...extra];
    // Pi renders the root footer before compositeOverlays. Its one walk serves
    // footer totals, all three width getters, and their component renders.
    entryReads = 0;
    for (let frame = 0; frame < 4; frame++) {
      const before = entryReads;
      mounted.paintOverlay();
      assert.equal(entryReads, before + 1, "one getEntries/collectSpend per native frame, not per panel getter");
    }
    const initialWidth = mounted.bounds().width;

    // Streaming has no finalized usage entry, so direct width/paint probes do
    // not walk the transcript again between frames.
    const beforeStreaming = entryReads;
    for (let update = 0; update < 8; update++) {
      await mounted.f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "live" } });
      for (const panel of panels) { void panel.options.width; void panel.options.maxHeight; panel.component.render(panel.options.width); }
    }
    assert.equal(entryReads, beforeStreaming, "streaming probes reuse the current frame snapshot");

    const longModel = "model-added-after-the-last-frame-".repeat(3);
    entries.push({ type: "message", message: { role: "assistant", provider: "fixture", model: longModel,
      usage: usage(10, 1, 0, 0, 1) } });
    await mounted.f.emit("message_end", { message: entries.at(-1).message });
    const beforeFirstWidth = entryReads;
    const grownWidth = usagePanel.options.width;
    assert.equal(entryReads, beforeFirstWidth + 1, "a width getter first after finalization refreshes the snapshot");
    assert(grownWidth > initialWidth, "new finalized usage widens before the panel paints");
    assert(usagePanel.component.render(grownWidth).length > 0, "the already fresh width paints immediately");
    assert.equal(entryReads, beforeFirstWidth + 1, "the first paint shares the width getter's work");

    entries.length = 0;
    await mounted.f.emit("session_tree");
    const shrunkenWidth = usagePanel.options.width;
    assert(shrunkenWidth < grownWidth, "an invalidated snapshot can shrink without remounting");
    mounted.tui.terminal.columns = 20;
    mounted.paintOverlay();
    assert.equal(mounted.bounds().width, 20, "resize still clamps the shared live width");
  } finally {
    for (const panel of extra.reverse()) { panel.handle.hide(); panel.member.leave(); }
    mounted.footer.dispose();
  }
});

/** A tool result whose usage names the models behind it. `input`/`cost` here
 * are the flat figures Pi counts; the rows say how much of them was delegated,
 * and anything they leave over is the tool's own work. */
const delegated = (flat, rows) => ({
  type: "message",
  message: { role: "toolResult", toolName: "bash", usage: { ...flat, harnessModels: rows } },
});
const workerRow = (model, input, cost) => ({ model, input, output: 0, cacheRead: 0, cacheWrite: 0, cost });

test("a worker's spend is billed to the model that ran it, not to a tools lump", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: [
    { type: "message", message: { role: "assistant", provider: "openai-codex", model: "fixture-strong-model", usage: usage(100, 0, 0, 0, 0.5) } },
    delegated(usage(300, 0, 0, 0, 3), [
      workerRow("openai-codex/gpt-5.6-sol", 180, 2),
      // Same model as the parent: "by model" means one row, not two.
      workerRow("openai-codex/fixture-strong-model", 100, 0.75),
    ]),
  ] });
  const { footer } = mounted;
  try {
    mounted.clickFooter();
    const lines = mounted.overlayLines(60);
    const sol = lines.find((line) => line.includes("gpt-5.6-sol"));
    assert(sol && sol.includes("2.000"), `worker row missing its own cost: ${sol}`);
    const astra = lines.find((line) => line.includes("fixture-strong-model"));
    assert(astra.includes("1.250"), `parent and worker on one model share a row: ${astra}`);
    // 300 - 180 - 100 input and 3 - 2 - 0.75 cost were nobody's worker: the
    // tool's own, which still has to be shown or the rows stop adding up.
    const tools = lines.find((line) => /│ ?tools/.test(line));
    assert(tools && tools.includes("0.250"), `unclaimed remainder lost: ${tools}`);
    const total = lines.find((line) => line.includes("total"));
    assert(total.includes("3.500"), total);
    assert(mounted.line().includes("$3.500"), "the line the pointer is on still agrees");
  } finally {
    footer.dispose();
  }
});

test("main and worker compaction rows name their different sources", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: [
    { type: "compaction", usage: usage(100, 20, 0, 0, 0.2) },
    delegated(usage(200, 0, 0, 0, 0.3), [
      workerRow("compaction/openai-codex/gpt-5.6-sol", 200, 0.3),
    ]),
  ] });
  try {
    mounted.clickFooter();
    const lines = mounted.overlayLines();
    assert.deepEqual(spendKeys(lines), [
      "model",
      "worker compact · gpt-5.6-sol",
      "main · compact/summaries",
      "total",
    ]);
  } finally {
    mounted.footer.dispose();
  }
});

test("a split that is not a real division of the usage is ignored, not believed", async () => {
  // Session entries are data. Each of these claims more than the tool reported,
  // or is not a spend row at all; every one must fall back to the lump.
  const bogus = [
    [workerRow("openai-codex/gpt-5.6-sol", 400, 1)],
    [workerRow("openai-codex/gpt-5.6-sol", 10, 9)],
    [workerRow("", 10, 1)],
    [workerRow("openai-codex/gpt-5.6-sol", -10, 1)],
    [workerRow("openai-codex/gpt-5.6-sol", 10, Number.NaN)],
    [{ model: "openai-codex/gpt-5.6-sol", input: 10 }],
    [null],
    ["openai-codex/gpt-5.6-sol"],
  ];
  for (const rows of bogus) {
    const mounted = await mountFooter({ mode: "fullscreen", entries: [delegated(usage(300, 0, 0, 0, 3), rows)] });
    try {
      mounted.clickFooter();
      const lines = mounted.overlayLines(60);
      assert(!lines.some((line) => line.includes("gpt-5.6-sol")), `believed a bad split: ${JSON.stringify(rows)}`);
      const tools = lines.find((line) => /│ ?tools/.test(line));
      assert(tools && tools.includes("3.000"), `lump lost the spend: ${tools}`);
      assert(mounted.line().includes("$3.000"));
    } finally {
      mounted.footer.dispose();
    }
  }
});

/**
 * Session entries are data on disk, written by whatever Pi version or extension
 * was running at the time, and `collectSpend` runs inside `footer.render` on
 * every frame. One entry missing a field must cost that entry, not the display.
 */
test("a malformed session entry costs its own figures, never the frame", async () => {
  const malformed = [
    { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", message: { role: "toolResult", usage: { input: 5, cost: null } } },
    { type: "message", message: { role: "toolResult", usage: { input: 7, cost: { total: "free" } } } },
    { type: "compaction", usage: { input: Number.NaN, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { type: "message", message: { role: "assistant", provider: "p", model: "n", usage: usage(10, 2, 0, 0, 0.25) } },
  ];
  const mounted = await mountFooter({ mode: "fullscreen", entries: malformed });
  try {
    const line = mounted.line();
    assert.ok(!/NaN|undefined/.test(line), `the footer line printed a non-figure: ${line}`);
    assert.ok(line.includes("$0.260"), `what WAS reported still adds up: ${line}`);
    mounted.clickFooter();
    const lines = mounted.overlayLines(60);
    for (const row of lines) assert.ok(!/NaN|undefined/.test(row), row);
    assert.ok(lines.some((row) => row.includes("0.250")), lines.join("\n"));
  } finally {
    mounted.footer.dispose();
  }
});

/** A claim cannot be checked against a figure that is not one, so an entry
 * missing a component must not wave the whole split through. */
test("a split riding on a malformed entry is refused like any other bad claim", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: [
    { type: "message", message: { role: "toolResult", toolName: "bash",
      usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0,
        harnessModels: [workerRow("openai-codex/gpt-5.6-sol", 180, 2)] } } },
  ] });
  try {
    mounted.clickFooter();
    const lines = mounted.overlayLines(60);
    assert.ok(!lines.some((row) => row.includes("gpt-5.6-sol")), lines.join("\n"));
    for (const row of lines) assert.ok(!/NaN/.test(row), row);
  } finally {
    mounted.footer.dispose();
  }
});

test("the breakdown is click-to-pin, with only the footer and its × toggling it closed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  const { footer } = mounted;
  try {
    mounted.hover();
    assert.deepEqual(mounted.visible(), [], "hover never opens the panel");
    mounted.clickFooter();
    assert.equal(mounted.visible().length, 1);
    for (let column = 1; column < 6; column++) mounted.hover(column);
    for (const data of ["a", "\u001b[200~paste\u001b[201~", "\u001b", "\u001b[5~"]) mounted.feed(data);
    mounted.clickOverlay();
    assert.equal(mounted.visible().length, 1, "motion, typing, paste, Esc and table clicks leave it pinned");
    assert.equal(mounted.inputHandlers.size, 0, "no keyboard interception is needed");
    mounted.clickFooter();
    assert.deepEqual(mounted.visible(), [], "the second footer click dismisses it");
    t.mock.timers.tick(5000);
    mounted.hover();
    assert.deepEqual(mounted.visible(), [], "hover cannot undo a dismissal, even later");

    mounted.clickFooter();
    for (const width of [60, 20]) {
      const lines = mounted.overlayLines(width);
      const x = closeColumn(lines[0]);
      assert.equal(x, width - 4, "the × sits at the right end of the top edge");
      mounted.clickOverlay(width - 6, 0);
      mounted.clickOverlay(x, 1);
      mounted.clickOverlay(x, 0, "right");
      assert.equal(mounted.visible().length, 1, "only a left click on the × tail closes");
      mounted.clickOverlay(width - 1, 0);
      assert.deepEqual(mounted.visible(), [], "the whole ` × ─╮` tail is the target");
      mounted.hover();
      assert.deepEqual(mounted.visible(), []);
      mounted.clickFooter();
    }
  } finally {
    footer.dispose();
  }
  assert.deepEqual(mounted.visible(), [], "dispose takes the overlay down");
  assert.equal(mounted.inputHandlers.size, 0);
});

test("the pinned panel steps aside while a harness panel closes, then returns to its place", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  try {
    mounted.clickFooter();
    mounted.paintOverlay();
    const place = mounted.bounds();
    mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
    assert.deepEqual(mounted.visible(), [], "off the overlay stack before the harness pops its own");
    // The column keeps its place meanwhile: a harness popover above it cannot drop into the gap.
    const above = joinPopoverStack(mounted.tui);
    assert.equal(above.bottom, FOOTER_HEIGHT + place.height);
    above.leave();
    await nextTick();
    assert.equal(mounted.visible().length, 1, "back once the harness close has run");
    mounted.paintOverlay();
    assert.deepEqual(mounted.bounds(), place);
    mounted.clickFooter();
    assert.deepEqual(mounted.visible(), [], "a returned panel still toggles closed");

    mounted.clickFooter();
    mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
    mounted.clickFooter();
    await nextTick();
    assert.deepEqual(mounted.visible(), [], "closing while stepped aside cancels the return");
    mounted.clickFooter();
    mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
    mounted.footer.dispose();
    await nextTick();
    assert.deepEqual(mounted.visible(), [], "teardown cancels the return");
  } finally { mounted.footer.dispose(); }
});

test("the usage panel and a harness popover share one bottom-right column", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  const { tui } = mounted;
  try {
    mounted.clickFooter();
    // A harness popover joining from its own bundle, exactly as the picker does.
    const member = joinPopoverStack(tui);
    const picker = { render: (width) => { const lines = Array(8).fill("p".repeat(width)); member.measure(8); return lines; },
      invalidate() {} };
    const handle = tui.showOverlay(picker, stackedOverlayOptions(member, { width: 50 }));
    mounted.paintOverlay(); mounted.paintOverlay();
    const [usagePanel, harness] = mounted.visible().map((entry) => entry.handle.getBounds());
    assert.equal(usagePanel.row + usagePanel.height, tui.terminal.rows - FOOTER_HEIGHT, "the older panel keeps the footer");
    assert.equal(harness.row + harness.height, usagePanel.row, "the newer popover rests directly on it");
    for (const bounds of [usagePanel, harness]) assert.equal(bounds.col + bounds.width, tui.terminal.columns);
    assert.equal(usagePanel.width, harness.width, "both independently bundled panels use the column width");
    assert.equal(usagePanel.col, harness.col);

    // Closing the lower one drops the upper one onto the footer.
    mounted.clickFooter();
    mounted.paintOverlay();
    const dropped = handle.getBounds();
    assert.equal(dropped.row + dropped.height, tui.terminal.rows - FOOTER_HEIGHT);
    // Reopened, the usage panel queues above the popover already there.
    mounted.clickFooter();
    mounted.paintOverlay(); mounted.paintOverlay();
    const reopened = mounted.visible().at(-1).handle.getBounds();
    assert.equal(reopened.row + reopened.height, dropped.row);
    handle.hide(); member.leave();
  } finally { mounted.footer.dispose(); }
});

for (const order of [
  ["usage", "approval", "routing"], ["usage", "routing", "approval"],
  ["approval", "usage", "routing"], ["approval", "routing", "usage"],
  ["routing", "usage", "approval"], ["routing", "approval", "usage"],
]) test(`real popovers form a width-aligned upward column: ${order.join(" → ")}`, async () => {
  const entries = [...spendEntries];
  const mounted = await mountFooter({ mode: "fullscreen", entries });
  const { tui } = mounted;
  tui.terminal.rows = 50;
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const panels = [];
  const paint = () => { for (let pass = 0; pass < 3; pass++) mounted.paintOverlay(); };
  const check = () => {
    paint();
    const bounds = panels.map((panel) => panel.bounds());
    let bottom = tui.terminal.rows - FOOTER_HEIGHT;
    for (const box of bounds) {
      assert(box, "every open panel fits on screen");
      assert.equal(box.row + box.height, bottom, "stack directly upward, never overlap or leave a gap");
      assert.equal(box.col + box.width, tui.terminal.columns);
      assert.equal(box.width, bounds[0].width);
      assert.equal(box.col, bounds[0].col, "both edges aligned");
      bottom = box.row;
    }
    for (const entry of mounted.visible()) {
      const width = entry.handle.getBounds().width;
      assert(entry.lines.every((line) => visibleWidth(line) === width), "every painted border/body fills the common width");
      assert(entry.lines[0].endsWith(CLOSE_TAIL), "the close control stays at the right edge");
      assert.match(entry.lines.at(-1), /^╰─+╯$/);
    }
  };
  try {
    for (const kind of order) {
      if (kind === "usage") {
        mounted.clickFooter();
        const entry = mounted.visible().at(-1);
        panels.push({ bounds: () => entry.handle.getBounds(), close: () => mounted.clickFooter() });
      } else {
        const member = joinPopoverStack(tui);
        let handle;
        const close = () => { handle.hide(); member.leave(); };
        const component = kind === "approval"
          ? new ApprovalPopover({ theme, choices: () => approvalChoices("jev"), current: () => "manual", warning: () => undefined,
            choose() {}, close, requestRender() {}, onRender: (height) => member.measure(height) })
          : new PresetPicker({ tui, theme, keybindings: { matches: () => false }, activeName: "fixture", pointer: true,
            presets: [{ name: "fixture", version: "starter-v2", models: { light: "fixture/light", standard: "fixture/standard", strong: "fixture/strong" },
              thinking: { light: {}, standard: {}, strong: {} } }],
            done: close, rows: () => member.available(), onRender: (height) => member.measure(height) });
        handle = tui.showOverlay(component, stackedOverlayOptions(member, { width: kind === "approval" ? 60 : 76 }));
        panels.push({ bounds: () => handle.getBounds(), close });
      }
      check();
    }
    for (const columns of [120, 38, 200]) { tui.terminal.columns = columns; check(); }
    const before = panels[0].bounds().width;
    entries.push({ type: "message", message: { role: "assistant", provider: "fixture", model: "long-model-name-".repeat(7), usage: usage(1, 1, 0, 0, 1) } });
    check();
    assert(panels[0].bounds().width > before, "new usage widens the entire column without reopening");
    panels.splice(1, 1)[0].close(); check();
    panels.shift().close(); check();
  } finally {
    for (const panel of panels.reverse()) panel.close();
    mounted.footer.dispose();
  }
});

test("the worker indicator sits in the corner and hands its clicks to the harness", async () => {
  const statuses = new Map([[WORKER_PRESET_INDICATOR, "workers: fixture-balanced"], ["other-extension", "OTHER"]]);
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries, statuses });
  const claimed = [];
  let claim = true;
  const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => {
    claimed.push(click.key);
    if (claim && click.key === WORKER_PRESET_INDICATOR) click.handled = true;
  });
  try {
    for (const columns of [300, 120]) {
      mounted.tui.terminal.columns = columns;
      const line = mounted.line(columns);
      assert(line.endsWith("fixture-balanced ▴"), `pinned to the far right: ${line}`);
      assert(!line.includes("workers:"), "the dock shows the preset value without its label");
      assert(line.indexOf("OTHER") < line.indexOf("fixture-balanced"), "after every other status");
      claimed.length = 0;
      mounted.clickFooter(columns - 1);
      mounted.clickFooter(line.indexOf("fixture-balanced"));
      assert.deepEqual(claimed, [WORKER_PRESET_INDICATOR, WORKER_PRESET_INDICATOR]);
      assert.deepEqual(mounted.visible(), [], "a claimed click does not open the usage panel");
    }
    const line = mounted.line();
    mounted.clickFooter(line.indexOf("OTHER"));
    assert.deepEqual(claimed.at(-1), "other-extension", "every status is offered its click");
    assert.equal(mounted.visible().length, 1, "an unclaimed click falls back to the usage panel");
    mounted.clickFooter(line.indexOf("$"));
    assert.deepEqual(mounted.visible(), [], "the usage figures still toggle it");
    const before = claimed.length;
    mounted.clickFooter(0);
    assert.equal(claimed.length, before, "the left side is nobody's indicator");
    assert.equal(mounted.visible().length, 1);
    mounted.clickFooter(0);
    claim = false;
    mounted.clickFooter(mounted.line().length - 1);
    assert.equal(mounted.visible().length, 1, "with no harness to claim it, the corner still opens usage");
    // Narrowing sheds usage before the worker control; its drawn caret still
    // belongs to the indicator, rather than a clipped off-screen hit region.
    const narrow = 40;
    const cut = stripVTControlCharacters(mounted.line(narrow));
    assert(cut.endsWith(" ▴"), cut);
    claimed.length = 0;
    mounted.clickFooter(narrow - 1);
    assert.deepEqual(claimed, [WORKER_PRESET_INDICATOR]);
  } finally { off(); mounted.footer.dispose(); }
});

test("× hit-testing uses visual columns even when the theme adds ANSI escapes", async () => {
  const theme = { fg: (_color, text) => `\x1b[33m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[0m` };
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries, theme });
  try {
    for (const columns of [60, 13]) {
      mounted.tui.terminal.columns = columns;
      mounted.clickFooter();
      const lines = mounted.overlayLines();
      const x = closeColumn(lines[0]);
      assert.equal(x, mounted.bounds().width - 4, "ANSI does not shift the control");
      assert(lines[0].indexOf(POPOVER.close) > x, "string offsets differ from visible columns");
      mounted.clickOverlay(x - 2, 0);
      assert.equal(mounted.visible().length, 1);
      mounted.clickOverlay(x, 0);
      assert.deepEqual(mounted.visible(), []);
    }
  } finally { mounted.footer.dispose(); }
});

test("a narrow usage panel omits the × instead of painting a non-clickable fragment", async () => {
  const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  try {
    mounted.clickFooter();
    const wide = mounted.overlayLines(60);
    const x = closeColumn(wide[0]);
    assert(x >= 0);
    for (const width of [8, 4, 1]) {
      const lines = mounted.overlayLines(width);
      assert(!lines.some((line) => stripVTControlCharacters(line).includes(POPOVER.close)), `partial control at width ${width}`);
      for (const line of lines) assert(visibleWidth(line) <= width);
      mounted.clickOverlay(x, 0);
      mounted.clickOverlay(width - 1, 0);
      assert.equal(mounted.visible().length, 1, "the old hit was cleared by the narrower paint");
    }
    mounted.clickFooter();
    assert.deepEqual(mounted.visible(), [], "the footer still closes a panel too narrow for the ×");
    mounted.clickFooter();
    const fits = mounted.overlayLines(9);
    assert(stripVTControlCharacters(fits[0]).endsWith(CLOSE_TAIL), "the control fits at exactly 9 columns");
    mounted.clickOverlay(closeColumn(fits[0]), 0);
    assert.deepEqual(mounted.visible(), []);
  } finally { mounted.footer.dispose(); }
});

test("the renderer consumes mouse and focus reports before extension listeners", () => {
  let onInput;
  const terminal = {
    start(handler) { onInput = handler; }, stop() {}, async drainInput() {}, write() {},
    get columns() { return 80; }, get rows() { return 24; }, get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, on() {}, off() {},
  };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  tui.start();
  const seen = [];
  try {
    // Exactly how the footer shows its breakdown, so the check covers the
    // overlay being up rather than only a bare renderer.
    tui.showOverlay({ render: (width) => ["x".repeat(width)], invalidate() {} },
      { anchor: "bottom-right", width: 20, nonCapturing: true });
    tui.addInputListener((data) => { seen.push(data); return undefined; });
    onInput("\u001b[<35;10;24M");  // pointer move
    onInput("\u001b[<0;10;24M");   // press
    onInput("\u001b[O");           // focus out
    onInput("a");                   // keystroke
    onInput("\u001b[200~x\u001b[201~"); // paste
  } finally {
    tui.stop();
  }
  assert.deepEqual(seen, ["a", "\u001b[200~x\u001b[201~"]);
});

test("the breakdown and the bottom-row marker are regular/fullscreen exclusive", async () => {
  const regular = await mountFooter({ entries: spendEntries });
  try {
    // Mouse reports never reach a regular-mode footer, but a host that sent one
    // must not get an overlay composited into the lines backing scrollback.
    regular.hover();
    regular.clickFooter();
    assert.deepEqual(regular.visible(), []);
    assert(regular.footer.render(80)[0].includes(MARKER), "the padding shim needs its marker");
  } finally {
    regular.footer.dispose();
  }
  const full = await mountFooter({ mode: "fullscreen", entries: spendEntries });
  try {
    // The alternate screen lays the dock out from its layout root and never
    // calls the wrapped render(), so an unstripped marker would be printed.
    assert(!full.footer.render(80)[0].includes("pi-status-footer"));
  } finally {
    full.footer.dispose();
  }
});

const plainTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
const yoloSet = () => globalThis[SESSION_YOLO_KEY] ?? new Set();

test("approval choices follow the loaded judge, and yolo is always offered", () => {
  assert.deepEqual(approvalChoices(undefined).map((choice) => choice.id), ["manual", "yolo"]);
  assert.deepEqual(approvalChoices("jev").map((choice) => choice.label), ["manual", "jev", "jev + sub", "yolo"]);
  assert.deepEqual(approvalChoices("luna").map((choice) => choice.label), ["manual", "luna", "luna + sub", "yolo"]);
  const jev = (mode, includeSubagents) => ({ judge: "jev", mode, includeSubagents, shown: true });
  assert.equal(currentChoice(undefined, false), "manual");
  assert.equal(currentChoice(jev("shadow", false), false), "manual");
  assert.equal(currentChoice(jev("enforce", false), false), "judge");
  assert.equal(currentChoice(jev("enforce", true), false), "judge+sub");
  assert.equal(currentChoice(jev("enforce", true), true), "yolo", "yolo wins over any judge mode");
  const colors = [];
  const recording = { fg: (color, text) => { colors.push(color); return `<${color}>${text}`; }, bold: (text) => text };
  assert.equal(approvalStatus(recording, jev("enforce", true), false), "approval: jev+sub");
  assert.equal(approvalStatus(recording, jev("enforce", false), false), "approval: jev");
  assert.equal(approvalStatus(recording, undefined, false), "approval: manual");
  assert.equal(approvalStatus(recording, jev("enforce", true), true), "approval: <error>YOLO", "yolo is loud");
});

/** A session record as approval-mode writes it. */
const choiceEntry = (sessionId, yolo, judge) => ({ type: "custom", customType: APPROVAL_ENTRY,
  data: { sessionId, yolo, ...(judge ? { judge } : {}) } });
const SUB = { mode: "enforce", includeSubagents: true };
const ROOT = { mode: "enforce", includeSubagents: false };
const MANUAL = { mode: "shadow", includeSubagents: false };

/** The approval extension on a real alternate-screen compositor. */
async function mountApproval({ branch = [], mode = "fullscreen", judges = true, judgeFirst = false, launch = SUB,
  confirm = true, select, appendThrows = false, sessionId: initial = "approval-root", sdkDispatch = false } = {}) {
  const f = fixture("tui", sdkDispatch);
  const entries = [], notices = [], statuses = new Map(), commands = new Map(), setRequests = [], dialogs = [];
  const terminal = { rows: 30, columns: 120, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  Object.defineProperty(tui, "mode", { value: mode });
  tui.requestRender = () => {};
  const failing = { append: appendThrows };
  f.pi.registerCommand = (name, command) => commands.set(name, command);
  f.pi.appendEntry = (customType, data) => {
    if (failing.append) throw new Error("disk full");
    entries.push({ type: "custom", customType, data });
  };
  let sessionId = initial;
  // The fixture hands its own context to every handler it emits to.
  const ctx = Object.assign(f.ctx, {
    mode: "tui", hasUI: true, cwd: "/fixture",
    ui: {
      theme: plainTheme,
      setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify: (message, level) => notices.push({ level, message }),
      setWidget: (_key, factory) => { factory?.(tui, plainTheme); },
      select: async (_title, options) => select?.(options),
      confirm: async (title, text) => { dialogs.push({ title, text }); return typeof confirm === "function" ? confirm(title) : confirm; },
    },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [...branch, ...entries] },
  });
  approvalExtension(f.pi);
  // A stand-in judge that owns its mode, as jev and Luna do: each session
  // starts from the launch mode, and every publish names its session.
  const judge = { judge: "jev", ...launch };
  const publish = () => f.pi.events.emit("approval:judge-state", { ...judge, sessionId, shown: false });
  if (judges) f.pi.events.on("approval:set-judge", (request) => {
    setRequests.push({ mode: request.mode, includeSubagents: request.includeSubagents });
    request.applied = true;
    Object.assign(judge, { mode: request.mode, includeSubagents: request.includeSubagents });
    publish();
  });
  const start = async () => {
    Object.assign(judge, launch);
    if (judges && judgeFirst) publish();
    await f.emit("session_start", {});
    if (judges && !judgeFirst) publish();
    await nextTick();
  };
  await start();
  const overlays = () => tui.overlayStack.filter((entry) => !entry.hidden);
  const popover = () => overlays().map((entry) => entry.component).find((component) => component instanceof ApprovalPopover);
  const lines = () => popover()?.render(60).map((line) => stripVTControlCharacters(line)) ?? [];
  const click = (x, y, extra = {}) => popover().handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 60, height: 10, shift: false, alt: false, ctrl: false, ...extra });
  const clickRow = (label) => {
    const rows = lines();
    const y = rows.findIndex((line) => new RegExp(`^│. . ${label.replace(/[+]/g, "\\+")} `).test(line));
    assert(y > 0, `row ${label} in ${rows.join("\n")}`);
    click(5, y);
  };
  const indicator = () => {
    const click = { key: "approval", handled: false };
    f.pi.events.emit("pi-footer:indicator-click", click);
    return click.handled;
  };
  /** Open the popover and pick a row, twice when it arms first. */
  const pick = (label) => {
    if (!popover()) indicator();
    clickRow(label);
    if (popover()?.isArmed()) clickRow(label);
  };
  return { f, tui, ctx, entries, notices, statuses, commands, setRequests, dialogs, judge, publish, popover, lines, click, clickRow,
    indicator, pick, failing,
    switchSession: async (id, restored = []) => { sessionId = id; branch = restored; entries.length = 0; await start(); },
    /** /tree: the leaf moves to the first `length` entries of the current branch. */
    navigate: async (length) => { branch = [...branch, ...entries].slice(0, length); entries.length = 0; await f.emit("session_tree", {}); },
    history: () => [...branch, ...entries],
    shutdown: () => f.emit("session_shutdown", {}) };
}

/** Fail real compositor/column cleanup, not a stand-in close implementation. */
function failApprovalTeardown(m, point) {
  const calls = [], grantsDuringUi = [];
  let armed = false, insideHide = false, afterHideRenders = 0, originalHide;
  const show = m.tui.showOverlay.bind(m.tui), render = m.tui.requestRender;
  const setStatus = m.ctx.ui.setStatus, setWidget = m.ctx.ui.setWidget;
  const hit = (part) => {
    if (!armed) return;
    calls.push(part);
    grantsDuringUi.push(managedSessionYolo("approval-root", new Map()) || managedSessionYolo("approval-next", new Map()));
    if (point === part || point === "all") throw new Error(`UI_${part.toUpperCase()}`);
  };
  m.tui.showOverlay = (...args) => {
    const handle = show(...args);
    originalHide = handle.hide.bind(handle);
    handle.hide = () => {
      hit("hide"); insideHide = true;
      try { originalHide(); } finally { insideHide = false; }
    };
    return handle;
  };
  m.indicator(); m.lines();
  const component = m.popover();
  // A member above the measured approval pane makes its leave() request a
  // repaint. This tests a throwing real leave(), separately from hide/render.
  const above = joinPopoverStack(m.tui); above.measure(2);
  m.tui.requestRender = () => {
    if (!armed) return render();
    if (insideHide) { calls.push("hide-render"); return; }
    hit(++afterHideRenders === 1 ? "leave" : "render");
  };
  m.ctx.ui.setStatus = (...args) => { hit("status"); return setStatus(...args); };
  m.ctx.ui.setWidget = (...args) => { hit("widget"); return setWidget(...args); };
  return { calls, grantsDuringUi, above, component,
    arm() { armed = true; },
    restore() {
      armed = false;
      m.tui.showOverlay = show; m.tui.requestRender = render;
      m.ctx.ui.setStatus = setStatus; m.ctx.ui.setWidget = setWidget;
      originalHide?.(); above.leave();
    },
  };
}

for (const point of ["hide", "leave", "render", "status", "widget", "all"]) {
  test(`approval shutdown revokes before UI cleanup and attempts every cleanup despite ${point} failure`, async () => {
    const m = await mountApproval({ sdkDispatch: true });
    m.pick("yolo");
    const chain = new Map([["approval-child", { parentSessionId: "approval-root" }]]);
    assert.equal(managedSessionYolo("approval-child", chain), true);
    const fault = failApprovalTeardown(m, point);
    try {
      fault.arm(); await m.shutdown();
      assert.equal(managedSessionYolo("approval-root", chain), false);
      assert.equal(managedSessionYolo("approval-child", chain), false);
      assert(fault.grantsDuringUi.every((granted) => !granted), "revocation precedes the first UI call");
      for (const part of ["hide", "leave", "render", "status", "widget"]) assert(fault.calls.includes(part), `${part}: ${fault.calls}`);
      assert.equal(fault.above.bottom, 1, "failed hide/leave must not retain the column slot");
      assert.deepEqual(m.f.errors, [], "expected UI failures are contained, not left to the dispatcher");
    } finally { fault.restore(); await m.shutdown(); }
  });
}

for (const source of ["command", "restore"]) for (const leave of ["switch", "shutdown"]) for (const point of ["hide", "render"]) {
  test(`late ${source} confirmation and stale popover cannot grant after ${leave} with ${point} failure`, async () => {
    let answer;
    const m = await mountApproval({ sdkDispatch: true,
      branch: source === "restore" ? [choiceEntry("approval-root", true, SUB)] : [],
      confirm: () => new Promise((resolve) => { answer = resolve; }) });
    const fault = failApprovalTeardown(m, point);
    const pending = source === "command" ? m.commands.get("approval").handler("yolo", m.ctx) : undefined;
    await nextTick();
    // Arm the old popover too. Its retained callback must not act for a new
    // session even if a failed hide leaves that component on the old renderer.
    fault.component.handleInput("\u001b[F"); fault.component.handleInput("\r");
    assert.equal(fault.component.isArmed(), true);
    try {
      fault.arm();
      if (leave === "switch") await m.switchSession("approval-next"); else await m.shutdown();
      answer(true); await pending; await nextTick();
      fault.component.handleInput("\r");
      assert.equal(managedSessionYolo("approval-root", new Map()), false);
      assert.equal(managedSessionYolo("approval-next", new Map()), false);
      assert.equal(m.entries.some((entry) => entry.data?.yolo), false);
      assert.deepEqual(m.f.errors, []);
    } finally { fault.restore(); await m.shutdown(); }
  });
}

test("session start revokes old and stale incoming grants before a failing old popover is touched", async () => {
  const m = await mountApproval({ sdkDispatch: true });
  m.pick("yolo");
  const fault = failApprovalTeardown(m, "hide");
  yoloSet().add("approval-next");
  try {
    fault.arm(); await m.switchSession("approval-next");
    assert(fault.grantsDuringUi.every((granted) => !granted));
    assert.equal(managedSessionYolo("approval-root", new Map()), false);
    assert.equal(managedSessionYolo("approval-next", new Map()), false);
    assert.equal(m.statuses.get("approval"), "approval: jev+sub");
    assert.deepEqual(m.f.errors, []);
  } finally {
    fault.restore(); await m.shutdown();
    yoloSet().delete("approval-next"); // Isolate even the unfixed startup negative control.
  }
});

test("a fresh approval instance clears a stale same-ID grant rather than displaying manual over YOLO", async () => {
  yoloSet().add("approval-root");
  const m = await mountApproval({ sdkDispatch: true, judges: false });
  try {
    assert.equal(managedSessionYolo("approval-root", new Map()), false);
    assert.equal(m.statuses.get("approval"), "approval: manual");
  } finally { await m.shutdown(); }
});

test("the approval indicator renders the judge's mode and claims it from the judge", async () => {
  const m = await mountApproval();
  try {
    assert.equal(m.statuses.get("approval"), "approval: jev+sub");
    const state = { judge: "luna", mode: "shadow", includeSubagents: false, sessionId: "approval-root", shown: false };
    m.f.pi.events.emit("approval:judge-state", state);
    assert.equal(state.shown, true, "an indicator that renders the mode claims it, so the judge drops its own status");
    assert.equal(m.statuses.get("approval"), "approval: manual");
    m.f.pi.events.emit("approval:judge-state", { judge: "other", mode: "enforce", shown: false });
    assert.equal(m.statuses.get("approval"), "approval: manual", "malformed judge state is ignored");
  } finally { await m.shutdown(); }
  assert.equal(m.statuses.has("approval"), false, "shutdown clears the indicator");
});

test("the approval popover is a menu: narrowing applies at once, widening takes a second choice", async () => {
  const m = await mountApproval();
  try {
    assert.equal(m.indicator(), true, "the footer click is claimed");
    const lines = m.lines();
    assert.match(lines[0], /^╭─ Approval ─+ × ─╮$/);
    assert.deepEqual(lines.slice(1, 5).map((line) => line.slice(1, 16).trim()),
      ["○ manual", "○ jev", "› ● jev + sub", "○ yolo"]);
    m.clickRow("jev");
    assert.deepEqual(m.setRequests.at(-1), ROOT, "jev + sub to jev narrows: one click");
    assert.equal(m.statuses.get("approval"), "approval: jev");
    assert.equal(m.popover(), undefined, "choosing closes it");
    m.indicator();
    m.clickRow("manual");
    assert.deepEqual(m.setRequests.at(-1), MANUAL);
    assert.equal(m.statuses.get("approval"), "approval: manual");

    // manual to jev lets the judge grant: the first choice only says so.
    m.indicator();
    m.clickRow("jev");
    assert.equal(m.popover().isArmed(), true);
    assert.equal(m.setRequests.length, 2, "nothing applied yet");
    assert(m.lines().some((line) => line.includes("jev may approve or deny this session's asks")), m.lines().join("\n"));
    assert(m.lines().some((line) => line.includes("Choose jev again to turn it on")));
    m.clickRow("jev");
    assert.deepEqual(m.setRequests.at(-1), ROOT);
    m.indicator();
    m.clickRow("jev + sub");
    assert.equal(m.popover().isArmed(), true, "adding subagents widens too");
    assert(m.lines().some((line) => line.includes("jev may decide asks here and from subagents")), m.lines().join("\n"));
    m.popover().handleInput("\u001b[B");
    assert.equal(m.popover().isArmed(), false, "moving away disarms");
    m.popover().handleInput("\u001b");
    assert.deepEqual(m.setRequests.at(-1), ROOT);
  } finally { await m.shutdown(); }
});

test("yolo needs a second choice, reaches the authority's set, and is recorded in the session", async () => {
  const m = await mountApproval();
  try {
    m.indicator();
    m.clickRow("yolo");
    assert.equal(m.popover().isArmed(), true, "the first choice only arms");
    assert.equal(yoloSet().has("approval-root"), false);
    for (const warning of ["reader/subagent Bash asks", "fail-closed floor and static guard", "Opaque code can write files"]) {
      assert(m.lines().some((line) => line.includes(warning)), m.lines().join("\n"));
    }
    assert(m.lines().at(-1).startsWith("╰"), "the warning fits above the bottom edge");
    m.clickRow("yolo");
    assert.equal(yoloSet().has("approval-root"), true, "the managed authority now allows this session's asks");
    assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", true, SUB), "the judge mode under yolo is recorded with it");
    assert.equal(m.statuses.get("approval"), "approval: YOLO");
    assert.equal(m.notices.at(-1).level, "warning");
    assert.match(m.notices.at(-1).message, /in-process subagents/);
    assert.deepEqual(m.setRequests, [], "yolo leaves the judge's own mode alone");

    // Arming is for the row it was given on.
    m.indicator();
    m.popover().handleInput("\u001b[A");
    assert.equal(m.popover().isArmed(), false);
    // Any judge mode is narrower than yolo: one click turns it off and says so.
    m.clickRow("jev + sub");
    assert.equal(yoloSet().has("approval-root"), false);
    assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", false, SUB));
    assert.equal(m.statuses.get("approval"), "approval: jev+sub");
    assert.match(m.notices.at(-1).message, /yolo is off/);
  } finally { await m.shutdown(); }
});

test("keyboard, × and permission dialogs all close the approval popover without applying", async () => {
  const m = await mountApproval();
  try {
    m.indicator();
    m.popover().handleInput("\u001b");
    assert.equal(m.popover(), undefined, "Esc closes");
    m.indicator();
    m.popover().handleInput("\u001b[A");
    m.popover().handleInput("\r");
    assert.deepEqual(m.setRequests.at(-1), ROOT, "↑ then Enter applies the (narrower) row above");
    m.indicator();
    const top = m.lines()[0];
    m.click(top.indexOf("×"), 0);
    assert.equal(m.popover(), undefined, "× closes");
    m.indicator();
    m.f.pi.events.emit("permissions:ui_prompt", { requestId: "r1" });
    assert.equal(m.popover(), undefined, "a permission dialog takes the keyboard back");
    assert.equal(m.setRequests.length, 1);
    m.indicator();
    assert.equal(m.indicator(), true);
    assert.equal(m.popover(), undefined, "a second indicator click toggles it closed");
  } finally { await m.shutdown(); }
});

test("the approval popover joins the bottom-right column and steps aside for harness panels", async () => {
  const m = await mountApproval();
  try {
    const below = joinPopoverStack(m.tui);
    below.measure(6);
    m.indicator();
    const paint = () => m.tui.compositeOverlays(Array(m.tui.terminal.rows).fill(""), m.tui.terminal.columns, m.tui.terminal.rows);
    paint(); paint();
    const entry = m.tui.overlayStack.find((candidate) => candidate.component === m.popover());
    assert.equal(entry.bounds.row + entry.bounds.height, m.tui.terminal.rows - FOOTER_HEIGHT - 6, "above what was already open");
    assert.equal(entry.bounds.col + entry.bounds.width, m.tui.terminal.columns);
    assert.equal(entry.options.nonCapturing, false, "it takes the keyboard for ↑↓ Enter Esc");
    m.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
    assert.equal(m.popover(), undefined, "off the overlay stack while a harness panel closes");
    await nextTick();
    assert(m.popover(), "back on the next tick");
    // A column too short for every row plus a warning keeps it off screen,
    // rather than clipping the warning under a clickable armed row.
    below.measure(m.tui.terminal.rows - 1 - 9);
    paint(); paint();
    assert.equal(m.tui.overlayStack.find((candidate) => candidate.component === m.popover())?.bounds, undefined);
    below.leave();
  } finally { await m.shutdown(); }
});

for (const judgeFirst of [false, true]) {
  test(`resuming restores the judge mode, never wider than the launch (judge loaded ${judgeFirst ? "first" : "second"})`, async () => {
    const m = await mountApproval({ judgeFirst, branch: [choiceEntry("approval-root", false, MANUAL)] });
    try {
      assert.deepEqual(m.setRequests, [MANUAL], "a manual pick survives resume");
      assert.equal(m.statuses.get("approval"), "approval: manual");
      assert.deepEqual(m.entries, [], "a restored mode that matches the record writes nothing");
      await m.switchSession("approval-wide", [choiceEntry("approval-wide", false, SUB)]);
      assert.deepEqual(m.setRequests.at(-1), MANUAL, "(unchanged)");
      assert.equal(m.statuses.get("approval"), "approval: jev+sub", "a pick equal to the launch mode needs no request");
    } finally { await m.shutdown(); }
    const narrow = await mountApproval({ judgeFirst, launch: MANUAL, branch: [choiceEntry("approval-root", false, SUB)] });
    try {
      assert.deepEqual(narrow.setRequests, [], "an explicit shadow launch wins over a wider recorded pick");
      assert.equal(narrow.statuses.get("approval"), "approval: manual");
    } finally { await narrow.shutdown(); }
    const between = await mountApproval({ judgeFirst, launch: ROOT, branch: [choiceEntry("approval-root", false, SUB)] });
    try {
      assert.deepEqual(between.setRequests, [], "jev + sub recorded, jev launched: stays jev");
      assert.deepEqual(between.entries.at(-1), undefined);
    } finally { await between.shutdown(); }
  });
}

test("resuming offers yolo back behind a confirmation instead of resuming it", async () => {
  const declined = await mountApproval({ confirm: false, branch: [choiceEntry("approval-root", true, MANUAL)] });
  try {
    assert.equal(yoloSet().has("approval-root"), false, "declined: every ask still goes through review");
    assert.equal(declined.dialogs.at(-1)?.title, "Resume yolo for this session?");
    assert.deepEqual(declined.setRequests, [MANUAL], "the judge mode under yolo is restored");
    assert.deepEqual(declined.entries.at(-1), choiceEntry("approval-root", false, MANUAL), "the answer is recorded, so it is not asked again");
    assert.equal(declined.statuses.get("approval"), "approval: manual", "turning yolo down returns to the mode that was picked");
  } finally { await declined.shutdown(); }

  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const accepted = await mountApproval({ confirm: () => pending, branch: [choiceEntry("approval-root", true, SUB)] });
  try {
    assert.equal(yoloSet().has("approval-root"), false, "until it is answered, yolo is off");
    answer(true);
    await nextTick();
    assert.equal(yoloSet().has("approval-root"), true, "accepted: yolo resumes");
    assert.equal(accepted.statuses.get("approval"), "approval: YOLO");
    await accepted.switchSession("approval-other");
    assert.equal(yoloSet().has("approval-root"), false, "the previous session's grant does not outlive the switch");
    assert.equal(yoloSet().has("approval-other"), false, "a new session starts from the launch default");
  } finally { await accepted.shutdown(); }
  assert.equal(yoloSet().size, 0, "shutdown leaves no grant behind");

  const headless = await mountApproval({ branch: [choiceEntry("approval-root", true)] });
  try {
    headless.ctx.hasUI = false;
    await headless.switchSession("approval-root", [choiceEntry("approval-root", true)]);
    assert.equal(yoloSet().has("approval-root"), false, "with nobody to confirm, yolo is not resumed");
  } finally { await headless.shutdown(); }
});

test("a fork, clone or foreign record restores nothing", async () => {
  const m = await mountApproval({ branch: [choiceEntry("approval-parent", true, MANUAL)] });
  try {
    assert.equal(m.dialogs.length, 0, "a record copied from another session id is not offered");
    assert.deepEqual(m.setRequests, [], "nor is its judge mode");
    assert.equal(m.statuses.get("approval"), "approval: jev+sub");
    await m.switchSession("approval-legacy", [{ type: "custom", customType: APPROVAL_ENTRY, data: { yolo: true } }]);
    assert.equal(m.dialogs.length, 0, "a record naming no session restores nothing");
  } finally { await m.shutdown(); }
});

test("/tree keeps the live state and makes the new branch's record agree", async () => {
  const m = await mountApproval();
  try {
    // The first review's repro: on, then manual, then back to before the revocation.
    m.pick("yolo");
    m.pick("manual");
    assert.equal(m.history().length, 2);
    await m.navigate(1);
    assert.equal(yoloSet().has("approval-root"), false, "navigation does not turn yolo on");
    assert.equal(m.statuses.get("approval"), "approval: manual");
    assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", false, MANUAL), "the stale record is revoked at once");
    await m.switchSession("approval-root", m.history());
    assert.equal(m.dialogs.length, 0, "reopening the session has no yolo to offer");

    // The other direction: live yolo, moved to before it was granted.
    m.pick("yolo");
    const before = m.history().length - 1;
    await m.navigate(before);
    assert.equal(yoloSet().has("approval-root"), true, "live yolo stays on and the indicator still says so");
    assert.equal(m.statuses.get("approval"), "approval: YOLO");
    assert.equal(m.entries.at(-1).data.yolo, true);
    const recorded = m.history().length;
    await m.navigate(recorded);
    assert.equal(m.history().length, recorded, "a branch that already agrees gets no new record");
  } finally { await m.shutdown(); }
});

test("a change made elsewhere is recorded; a failed record is said out loud and never fails open", async () => {
  const m = await mountApproval();
  try {
    // /auto-approval or another path changing the judge directly.
    Object.assign(m.judge, MANUAL);
    m.publish();
    assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", false, MANUAL));
    m.pick("yolo");
    assert.equal(m.entries.at(-1).data.yolo, true);
    // The second review's case: the revocation cannot be written.
    m.failing.append = true;
    m.pick("manual");
    assert.equal(yoloSet().has("approval-root"), false, "turning yolo off is live even when the record fails");
    assert(m.notices.some((notice) => notice.level === "warning" && /could not be recorded/.test(notice.message)),
      JSON.stringify(m.notices));
    m.failing.append = false;
    // The branch still says yolo; resuming only offers it back.
    await m.switchSession("approval-root", m.history());
    assert.equal(yoloSet().has("approval-root"), true, "(the fixture confirms by default)");
    assert.equal(m.dialogs.at(-1).title, "Resume yolo for this session?", "a stale record reaches nothing without a confirmation");
  } finally { await m.shutdown(); }
});

test("a confirmation answered after the session changed grants nothing to either session", async () => {
  // The third review's repro: /approval yolo waits, the session switches, the
  // old dialog then answers Yes, and the old session is resumed.
  for (const leave of ["switch", "shutdown"]) {
    let answer;
    const m = await mountApproval({ confirm: () => new Promise((resolve) => { answer = resolve; }) });
    const pending = m.commands.get("approval").handler("yolo", m.ctx);
    await nextTick();
    if (leave === "switch") await m.switchSession("approval-next");
    else await m.shutdown();
    answer(true);
    await pending;
    assert.equal(yoloSet().has("approval-root"), false, `${leave}: the old session is not granted`);
    assert.equal(yoloSet().has("approval-next"), false, `${leave}: nor is the new one`);
    assert.equal(m.entries.some((entry) => entry.data?.yolo === true), false, `${leave}: nothing is recorded`);
    if (leave === "switch") {
      await m.switchSession("approval-root", m.history());
      assert.equal(yoloSet().has("approval-root"), false, "resuming the old session finds no yolo");
      assert.equal(m.statuses.get("approval"), "approval: jev+sub");
      await m.shutdown();
    }
  }
});

test("/approval takes a mode by name and confirms every widening; the regular renderer uses dialogs", async () => {
  const declined = await mountApproval({ confirm: false });
  try {
    const run = (args) => declined.commands.get("approval").handler(args, declined.ctx);
    await run("yolo");
    assert.equal(yoloSet().has("approval-root"), false, "a declined confirmation changes nothing");
    await run("manual");
    assert.deepEqual(declined.setRequests.at(-1), MANUAL, "narrowing asks nothing");
    const dialogs = declined.dialogs.length;
    await run("jev");
    assert.equal(declined.dialogs.length, dialogs + 1, "widening to the judge asks");
    assert.match(declined.dialogs.at(-1).title, /Let jev approve/);
    assert.deepEqual(declined.setRequests.at(-1), MANUAL, "and a No keeps manual");
    await run("sometimes");
    assert.equal(declined.notices.at(-1).level, "error");
  } finally { await declined.shutdown(); }
  const regular = await mountApproval({ mode: "regular", select: (options) => options.find((option) => option.startsWith("yolo")) });
  try {
    assert.equal(regular.indicator(), true);
    await nextTick();
    assert.equal(regular.popover(), undefined, "no overlay on the regular renderer");
    assert.equal(yoloSet().has("approval-root"), true, "Pi's select and confirm dialogs stand in for the popover");
  } finally { await regular.shutdown(); }
  const unjudged = await mountApproval({ judges: false });
  try {
    unjudged.f.pi.events.emit("approval:judge-state", undefined);
    unjudged.indicator();
    assert.deepEqual(unjudged.lines().slice(1, 3).map((line) => line.slice(1).trim().split(/ {2,}/)[0]), ["› ● manual", "○ yolo"]);
  } finally { await unjudged.shutdown(); }
});

test("approval sits to the right of worker routing in the footer's corner", async () => {
  const statuses = new Map([["harness-preset", "workers: fixture-balanced"], ["approval", "approval: jev+sub"], ["other-extension", "OTHER"]]);
  const mounted = await mountFooter({ mode: "fullscreen", statuses });
  const claimed = [];
  const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => { claimed.push(click.key); click.handled = true; });
  try {
    const line = mounted.line();
    assert(line.endsWith("OTHER · fixture-balanced ▴ · jev+sub ▴"), line);
    mounted.clickFooter(line.indexOf("jev+sub"));
    assert.deepEqual(claimed, ["approval"]);
  } finally { off(); mounted.footer.dispose(); }
});

test("compact corner indicators preserve styled values and route clicks by their unchanged keys", async () => {
  const themed = {
    fg: (color, text) => color === "error" ? `\x1b[31m${text}\x1b[39m` : text,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const yolo = approvalStatus(themed, undefined, true);
  const statuses = new Map([[WORKER_PRESET_INDICATOR, "workers: fixture-strong"], ["approval", yolo],
    ["other-extension", "workers: unrelated"]]);
  const mounted = await mountFooter({ mode: "fullscreen", statuses });
  const claimed = [];
  const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => { claimed.push(click.key); click.handled = true; });
  try {
    for (const columns of [300, 100]) {
      mounted.tui.terminal.columns = columns;
      const painted = mounted.line(columns);
      const line = stripVTControlCharacters(painted);
      assert(line.endsWith("workers: unrelated · fixture-strong ▴ · YOLO ▴"), line);
      assert(painted.includes("\x1b[31m\x1b[1mYOLO\x1b[22m\x1b[39m"), "YOLO keeps its red/bold styling");
      claimed.length = 0;
      for (const label of ["YOLO", "fixture-strong"]) {
        const start = line.indexOf(label);
        mounted.clickFooter(start);
        mounted.clickFooter(start + visibleWidth(label) + 1); // The caret is clickable too.
      }
      assert.deepEqual(claimed, ["approval", "approval", WORKER_PRESET_INDICATOR, WORKER_PRESET_INDICATOR]);
      assert.deepEqual(mounted.visible(), [], "claimed clicks never open the usage panel");
    }
    assert.equal(statuses.get("approval"), yolo, "only the footer presentation changed, not published statuses");
    statuses.set("approval", "manual");
    statuses.set(WORKER_PRESET_INDICATOR, "custom@v2");
    assert(mounted.line().endsWith("custom@v2 ▴ · manual ▴"), "already compact values pass through unchanged");
  } finally { off(); mounted.footer.dispose(); }
});

test("footer keeps worker/approval/health order and the health edge stable across status changes", async () => {
  const theme = { fg: (_color, text) => text };
  const statuses = new Map([[HEALTH_INDICATOR, "○ idle"], ["approval", "approval: jev+sub"],
    [WORKER_PRESET_INDICATOR, "workers: off"]]);
  const mounted = await mountFooter({ mode: "fullscreen", statuses });
  try {
    for (const preset of ["off", "fixture-balanced", "研究团队-custom@revision-42"]) {
      statuses.set(WORKER_PRESET_INDICATOR, `workers: ${preset}`);
      for (const state of ["idle", "busy", "waiting", "error", "unknown"]) {
        const health = healthStatus(theme, state);
        statuses.set(HEALTH_INDICATOR, health);
        const line = mounted.line(120);
        assert(line.endsWith(`${preset} ▴ · jev+sub ▴ · ${health} ▴`), line);
        assert.equal(visibleWidth(line), 120, "health remains flush right");
      }
    }
  } finally { mounted.footer.dispose(); }
});

test("footer sheds cache detail before complete usage figures or corner controls", async () => {
  const statuses = new Map([[WORKER_PRESET_INDICATOR, "workers: fixture-balanced"],
    ["approval", "approval: manual"], [HEALTH_INDICATOR, "○ idle"]]);
  const mounted = await mountFooter({ mode: "fullscreen", statuses, entries: spendEntries });
  try {
    const full = mounted.line(300);
    const right = full.slice(full.indexOf("↑"));
    const narrow = stripVTControlCharacters(mounted.line(visibleWidth(right) - 1));
    assert(narrow.endsWith("↑ 6.2k · ↓ 788 · $0.780 · fixture-balanced ▴ · manual ▴ · ○ idle ▴"), narrow);
    assert.equal(mounted.line(300), full, "resize restores full cache detail");
  } finally { mounted.footer.dispose(); }
});

test("footer fitting stays bounded with any subset of pinned extensions in either renderer", async () => {
  const pinned = [[WORKER_PRESET_INDICATOR, "workers: custom-long-preset@v2"],
    ["approval", "approval: jev+sub"], [HEALTH_INDICATOR, "? wait"]];
  for (const mode of ["fullscreen", "regular"]) for (let mask = 0; mask < 8; mask++) {
    const statuses = new Map([["other", "EXTERNAL_STATUS ".repeat(10)],
      ...pinned.filter((_entry, index) => mask & (1 << index))]);
    const mounted = await mountFooter({ mode, statuses, entries: spendEntries });
    try {
      for (let columns = 0; columns <= 120; columns++) {
        const line = stripVTControlCharacters(mounted.line(columns));
        assert(visibleWidth(line) <= columns, `${mode}/${mask}/${columns}: ${line}`);
        if (mask & 4 && columns >= 8) assert(line.endsWith("? wait ▴") || line.endsWith("? wait") || line.endsWith("?"), line);
        if (mask & 2 && columns >= 22) assert(line.includes("jev+sub"), "ordinary Pi also retains approval");
      }
    } finally { mounted.footer.dispose(); }
  }
});

test("narrow footer preserves styled approval and health, with exact ANSI/CJK click geometry after resize", async () => {
  const theme = { fg: (color, text) => `\x1b[${color === "error" ? 31 : 36}m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m` };
  const yolo = approvalStatus(theme, undefined, true);
  const statuses = new Map([[WORKER_PRESET_INDICATOR, `workers: ${theme.fg("accent", "研究团队".repeat(30) + "@v2")}`],
    ["approval", yolo], [HEALTH_INDICATOR, healthStatus(theme, "error")]]);
  const before = [...statuses];
  const mounted = await mountFooter({ mode: "fullscreen", statuses, theme, entries: spendEntries });
  const claimed = [];
  const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => { claimed.push(click.key); click.handled = true; });
  try {
    for (const columns of [500, 80, 40, 32, 24, 18, 12, 8, 7, 1, 0, 120, 500]) {
      const painted = mounted.line(columns), line = stripVTControlCharacters(painted);
      assert(visibleWidth(line) <= columns, `${columns}: ${line}`);
      claimed.length = 0;
      if (columns === 0) {
        assert.equal(line, "");
        mounted.clickFooter(0);
        assert.deepEqual(claimed, [], "no stale indicator hit after a zero-width paint");
        continue;
      }
      if (columns >= 18) assert(line.endsWith("! error ▴"), `${columns}: ${line}`);
      else assert(line.endsWith("!"), `${columns}: ${line}`);
      mounted.clickFooter(columns - 1);
      assert.deepEqual(claimed, [HEALTH_INDICATOR], "rightmost drawn cell always routes to health");
      if (columns >= 8) {
        assert(line.includes("YOLO"), `${columns}: ${line}`);
        assert(painted.includes("\x1b[31m\x1b[1mYOLO\x1b[22m\x1b[39m"), "narrowing retains the full red/bold warning");
        mounted.clickFooter(visibleWidth(line.slice(0, line.indexOf("YOLO"))));
        assert.equal(claimed.at(-1), "approval");
      } else {
        assert(!line.includes("YO"), "never show a misleading fragment of the approval mode");
      }
      if (line.includes("研究")) {
        const start = visibleWidth(line.slice(0, line.indexOf("研究")));
        const end = visibleWidth(line.slice(0, line.indexOf(" ▴", line.indexOf("研究")))) + 2;
        claimed.length = 0;
        for (let x = start; x < end; x++) mounted.clickFooter(x);
        assert(claimed.length > 0 && claimed.every((key) => key === WORKER_PRESET_INDICATOR),
          "wide glyphs, a shortened label's ellipsis, and its caret all belong to the worker control");
        if (columns < 500) assert(line.slice(0, line.indexOf("YOLO")).includes("…"), "long preset is visibly shortened");
      } else assert(!claimed.includes(WORKER_PRESET_INDICATOR), "hidden worker control has no phantom hit");
      if (columns === 500) assert(line.includes("研究团队".repeat(30) + "@v2"), "expansion restores the original label");
    }
    assert.deepEqual([...statuses], before, "fitting never mutates published status values");
  } finally { off(); mounted.footer.dispose(); }
});

async function mountStats(mode = "fullscreen", hasUI = true) {
  const f = fixture();
  const terminal = { rows: 40, columns: 120, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  tui.requestRender = () => {};
  const host = mode === "fullscreen" ? tui : { mode, terminal, render: () => [], requestRender() {} };
  const editor = { render: () => [], invalidate() {}, handleInput() {} };
  tui.setFocus(editor);
  const theme = { fg: (_role, text) => text, bold: (text) => text, bg: (_role, text) => text };
  const statuses = new Map([["approval", "approval: manual"], [WORKER_PRESET_INDICATOR, "workers: fixture-strong"]]);
  const commands = new Map(), notices = [];
  f.pi.registerCommand = (name, command) => commands.set(name, command);
  f.ctx.hasUI = hasUI;
  f.ctx.sessionManager = { getEntries: () => [], getSessionId: () => "stats-root" };
  f.ctx.model = { provider: "fixture", id: "requested", reasoning: false };
  f.ctx.getContextUsage = () => undefined;
  let footer;
  Object.assign(f.ctx.ui, { theme,
    setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
    notify: (message, level) => notices.push({ message, level }),
    setWidget(key, factory) {
      f.widgets.delete(key);
      if (factory) f.widgets.set(key, factory(host, theme));
    },
    setFooter(factory) {
      footer?.dispose();
      footer = factory(host, theme, { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} });
    },
  });
  footerExtension(f.pi);
  statsExtension(f.pi);
  await f.emit("session_start");
  const line = () => footer.render(terminal.columns)[0];
  return { f, tui, terminal, statuses, commands, notices, editor, line,
    pane: () => tui.overlayStack.find((entry) => entry.component.constructor.name === "StatsView")?.component,
    click() {
      const text = line(), label = statuses.get(HEALTH_INDICATOR);
      return footer.handleMouse({ type: "click", button: "left", x: text.indexOf(label), y: 0 });
    },
    paint() { return tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows); },
    async close() { await f.emit("session_shutdown"); footer.dispose(); },
  };
}

test("health is a compact attention indicator, not a fabricated green performance score", () => {
  const theme = { fg: (role, text) => `${role}:${text}` };
  assert.equal(healthStatus(theme, "unknown"), "dim:○ —");
  assert.equal(healthStatus(theme, "idle"), "dim:○ idle");
  assert.equal(healthStatus(theme, "busy"), "accent:● busy");
  assert.equal(healthStatus(theme, "waiting"), "warning:? wait");
  assert.equal(healthStatus(theme, "error"), "error:! error");
});

test("the health footer opens a separate Stats view and closes without popping another overlay", async () => {
  const m = await mountStats();
  try {
    assert(m.line().endsWith("fixture-strong ▴ · manual ▴ · ○ — ▴"));
    assert.equal(m.click().handled, true);
    m.paint();
    const pane = m.pane();
    assert(pane);
    const entry = m.tui.overlayStack.find((entry) => entry.component === pane);
    assert.equal(entry.options.anchor, "center", "Stats is not another small stacked popover");
    assert.match(pane.render(100).join("\n"), /Stats/);
    assert.equal(m.tui.getFocusedComponent(), pane);
    const unrelated = { render: () => ["unrelated"], invalidate() {} };
    const handle = m.tui.showOverlay(unrelated, { anchor: "top-left", width: 20, nonCapturing: true });
    await m.commands.get("stats").handler("", m.f.ctx);
    assert.equal(m.pane(), undefined);
    assert(m.tui.overlayStack.some((entry) => entry.component === unrelated), "exact-handle close leaves newer overlays alone");
    handle.hide();
    assert.equal(m.tui.getFocusedComponent(), m.editor);
    m.click(); m.paint();
    m.pane().handleInput("\u001b");
    assert.equal(m.pane(), undefined);
  } finally { await m.close(); }
});

test("Stats yields to approvals and other dialogs, and never reopens from a stale notification", async () => {
  const m = await mountStats();
  try {
    m.click();
    m.f.pi.events.emit("permissions:ui_prompt", { requestId: "ask" });
    assert.equal(m.pane(), undefined);
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "? wait");
    m.click();
    assert.equal(m.pane(), undefined, "cannot cover an active approval");
    m.f.pi.events.emit("permissions:decision", { requestId: "ask" });
    assert.equal(m.pane(), undefined, "a stats window is not a reopen intent");
    m.click(); assert(m.pane());
    await m.f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
    assert.equal(m.pane(), undefined);
    m.click(); assert.equal(m.pane(), undefined);
    await m.f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
    m.click(); assert(m.pane());
    m.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
    assert.equal(m.pane(), undefined, "gets out of the way before ui.custom pops the global top");
  } finally { await m.close(); }
});

test("Stats session replacement clears live observations and shutdown retires listeners and refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const m = await mountStats();
  try {
    await m.f.emit("agent_start");
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "● busy");
    await m.f.emit("turn_start", { turnIndex: 0 });
    await m.f.emit("before_provider_request", { payload: {} });
    await m.f.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "NOT_RETAINED" } });
    await m.f.emit("message_end", { message: { role: "assistant", provider: "fixture", model: "requested", responseModel: "answered",
      stopReason: "stop", usage: { output: 10, cost: { total: 0.01 } } } });
    await m.f.emit("agent_settled");
    m.click(); assert(m.pane());
    await m.f.emit("session_start");
    assert.equal(m.pane(), undefined);
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "○ —");
    assert.equal(m.f.listeners.get(FOOTER_INDICATOR_CLICK_EVENT).size, 1, "replacement never duplicates the toggle");
    m.click(); assert(m.pane());
    await m.f.emit("session_shutdown");
    assert.equal(m.pane(), undefined);
    assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
    assert.equal(m.f.widgets.has("stats-host"), false);
    t.mock.timers.tick(5000);
    assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
    const click = { key: HEALTH_INDICATOR, handled: false };
    m.f.pi.events.emit(FOOTER_INDICATOR_CLICK_EVENT, click);
    assert.equal(click.handled, false);
    assert.equal(m.pane(), undefined);
  } finally { await m.close(); }
});

test("regular Stats uses a non-modal summary and no-UI sessions mount nothing", async () => {
  for (const hasUI of [true, false]) {
    const m = await mountStats("regular", hasUI);
    try {
      await m.commands.get("stats").handler("", m.f.ctx);
      assert.equal(m.pane(), undefined);
      assert.equal(m.notices.length, hasUI ? 1 : 0);
      if (hasUI) assert.match(m.notices[0].message, /main session and workers since opening/);
      else assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
    } finally { await m.close(); }
  }
});

test("Stats includes owned workers, retains released metrics and rejects foreign/stale attachments", async () => {
  const m = await mountStats();
  const attach = (parentId, workerId) => {
    const request = { parentId, workerId };
    m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
    return request.sink;
  };
  try {
    assert.equal(attach("another-owner", "agent-a"), undefined);
    const sink = attach("stats-root", "agent-a");
    assert(sink);
    assert.equal(attach("stats-root", "agent-a"), sink, "duplicate attachment does not reset or duplicate a collector");
    sink.beginRun();
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "● busy", "a worker keeps health busy even while the parent is idle");
    sink.startActivity();
    sink.requestStart("requested", "fixture");
    sink.delta("thinking_delta");
    sink.messageEnd({ role: "assistant", provider: "fixture", model: "requested", responseModel: "worker-actual",
      stopReason: "stop", usage: { output: 20, cost: { total: 0.03 } } });
    sink.toolStart("call-a", "read"); sink.toolEnd("call-a", false);
    sink.endRun("success");
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "○ idle");
    m.click(); m.pane().handleInput("2");
    assert.match(m.pane().render(140).join("\n"), /\[worker\] fixture\/worker-actual.*1 req/);
    sink.dispose(); sink.dispose();
    const saved = m.pane().render(140).join("\n");
    assert.match(saved, /\[worker\] fixture\/worker-actual.*1 req/, "release retains historical totals, not the SDK session");
    sink.beginRun(); sink.requestStart("STALE_MODEL", "fixture");
    sink.messageEnd({ role: "assistant", model: "STALE_MODEL", stopReason: "stop", usage: { output: 999 } });
    assert.doesNotMatch(m.pane().render(140).join("\n"), /STALE_MODEL/);
    const late = attach("stats-root", "agent-b"); late.beginRun();
    await m.f.emit("session_start");
    late.requestStart("OLD_WINDOW", "fixture"); late.endRun("error"); late.dispose();
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "○ —", "callbacks from the old window cannot revive worker health");
    m.click(); m.pane().handleInput("2");
    assert.doesNotMatch(m.pane().render(140).join("\n"), /worker-actual|OLD_WINDOW/);
  } finally { await m.close(); }
});

test("health transitions and streaming never build detail snapshots; tool errors stay in counters", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mainSnapshot = SessionStats.prototype.snapshot, workerSnapshot = WorkerStats.prototype.snapshot;
  let mainReads = 0, workerReads = 0;
  t.mock.method(SessionStats.prototype, "snapshot", function () { mainReads++; return mainSnapshot.call(this); });
  t.mock.method(WorkerStats.prototype, "snapshot", function () { workerReads++; return workerSnapshot.call(this); });
  const m = await mountStats();
  try {
    const request = { parentId: "stats-root", workerId: "live-worker" };
    m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
    const sink = request.sink;
    sink.beginRun(); sink.startActivity(); sink.requestStart("worker", "fixture");
    await m.f.emit("agent_start"); await m.f.emit("turn_start", { turnIndex: 0 });
    for (let index = 0; index < 1000; index++) {
      await m.f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "observed" } });
      sink.delta("text_delta");
    }
    await m.f.emit("tool_execution_start", { toolCallId: "check", toolName: "bash" });
    await m.f.emit("tool_execution_end", { toolCallId: "check", isError: true });
    sink.toolStart("worker-check", "bash"); sink.toolEnd("worker-check", true);
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "● busy", "neither tool error is a fatal health signal");
    const failure = (model) => ({ role: "assistant", provider: "fixture", model, stopReason: "error" });
    await m.f.emit("message_end", { message: failure("requested") });
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "! error");
    m.f.pi.events.emit("permissions:ui_prompt", { requestId: "permission" });
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "? wait");
    m.f.pi.events.emit("permissions:decision", { requestId: "permission", decision: "deny" });
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "! error");
    await m.f.emit("agent_settled"); await m.f.emit("agent_start"); await m.f.emit("agent_settled");
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "● busy", "worker is still running after parent recovery");
    sink.messageEnd(failure("worker")); sink.endRun("error");
    assert.equal(m.statuses.get(HEALTH_INDICATOR), "! error", "actual worker failure is immediately visible");
    t.mock.timers.tick(3000);
    sink.beginRun(); assert.equal(m.statuses.get(HEALTH_INDICATOR), "● busy");
    sink.endRun("success"); assert.equal(m.statuses.get(HEALTH_INDICATOR), "○ idle");
    assert.deepEqual([mainReads, workerReads], [0, 0], "streaming, transitions and refresh use only cheap health reads");
    m.click(); m.pane().handleInput("3");
    const details = m.pane().render(140).join("\n");
    assert.match(details, /\[main\] bash/); assert.match(details, /\[worker\] bash/);
    assert.equal((details.match(/1 errors/g) ?? []).length, 2, "both tool error counts remain visible");
    assert(mainReads > 0 && workerReads > 0, "full snapshots are requested when the details view actually paints");
  } finally { await m.close(); }
});

test("removed task-list extension is neither deployed nor permitted", () => {
  assert(!existsSync(join(extensions, "todo.ts")));
  const composition = readFileSync(join(root, "composition.ts"), "utf8");
  assert(!composition.includes("extensions/todo.ts"));
  const config = JSON.parse(readFileSync(join(root, "resources/permissions.json"), "utf8"));
  assert(!Object.hasOwn(config.permission, "todo"));
});
