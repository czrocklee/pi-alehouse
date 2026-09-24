#!/usr/bin/env node
// Stats-view UI regressions against the installed Pi TUI; no session or network calls.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

const [piExecutable] = process.argv.slice(2);
assert(piExecutable, "Usage: node script/check-pi-stats-view.mjs PI_EXECUTABLE");
const root = resolve(import.meta.dirname, "..");
const require = createRequire(realpathSync(piExecutable));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
});
const { StatsView } = await jiti.import(join(root, "extensions/lib/stats-view.ts"));
const { visibleWidth } = await import(require.resolve("@earendil-works/pi-tui"));

const plain = (line) => stripVTControlCharacters(line);
const styledTheme = (seen = []) => ({
  fg(color, text) {
    seen.push({ color, text });
    return `\x1b[38;5;39m${text}\x1b[0m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  bg: (_color, text) => `\x1b[48;5;237m${text}\x1b[0m`,
});
const plainTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };

function model(name, overrides = {}) {
  return {
    model: name,
    requests: 2,
    errors: 0,
    outputTokens: 1200,
    cost: 0.012,
    llmMs: 12000,
    ttftMs: 800,
    ttftSamples: 2,
    tps: 10,
    partial: false,
    ...overrides,
  };
}

function tool(name, overrides = {}) {
  return { tool: name, calls: 2, errors: 0, totalMs: 800, maxMs: 500, ...overrides };
}

function snapshot(overrides = {}) {
  return {
    elapsedMs: 180000,
    busyMs: 60000,
    idleMs: 120000,
    llmMs: 30000,
    toolMs: 18000,
    approvalMs: 2000,
    activeRequests: 1,
    activeTools: 2,
    pendingApprovals: 0,
    health: "busy",
    observedActivity: true,
    scope: "foreground-observed",
    limitations: [],
    partial: false,
    lastActivityMs: 4000,
    lastTtftMs: 250,
    lastTextMs: 200,
    lastTps: 12.5,
    models: [model("gpt-测试")],
    tools: [tool("read")],
    ...overrides,
  };
}

function mount({ rows = 24, data = snapshot(), theme = plainTheme } = {}) {
  let renders = 0;
  let closes = 0;
  const tui = { terminal: { rows }, requestRender: () => { renders++; } };
  const view = new StatsView({ tui, theme, snapshot: () => data, close: () => { closes++; } });
  return {
    view,
    tui,
    get data() { return data; },
    set data(value) { data = value; },
    renders: () => renders,
    closes: () => closes,
  };
}

function paint(mounted, width) {
  const lines = mounted.view.render(width);
  for (const line of lines) assert.equal(visibleWidth(line), width, `line does not fill ${width}: ${plain(line)}`);
  return lines;
}

function tabLine(mounted, width = 100) {
  return plain(paint(mounted, width)[1] ?? "");
}

function click(view, x, y) {
  return view.handleMouse({ type: "click", button: "left", x, y, width: 100, height: 30 });
}

test("frame is ANSI/unicode-safe and never exceeds 75% of terminal rows", () => {
  const colors = [];
  const mounted = mount({ rows: 24, theme: styledTheme(colors) });
  for (const width of [1, 2, 8, 9, 12, 40, 100]) {
    const lines = paint(mounted, width);
    assert(lines.length <= Math.floor(mounted.tui.terminal.rows * 0.75));
  }
  mounted.view.handleInput("2");
  const wide = paint(mounted, 100).map(plain);
  assert(wide[0].startsWith("╭") && wide.at(-1).endsWith("╯"));
  assert(wide.some((line) => line.includes("gpt-测试")), "wide Unicode labels stay visible");
  assert(colors.some(({ color }) => color === "accent"));

  for (const rows of [0, 1, 2, 3, 6, 8]) {
    const tiny = mount({ rows, theme: styledTheme() });
    const lines = paint(tiny, 40);
    assert(lines.length <= Math.floor(rows * 0.75), `${rows} rows overran the parent height cap`);
  }
});

test("overview declares observation scope, overlap and unknown-versus-zero legend", () => {
  const mounted = mount({ rows: 30, data: snapshot({ health: "idle", privateOutput: "top-secret output" }) });
  const view = paint(mounted, 120).map(plain).join("\n");
  assert.match(view, /main \+ managed workers/);
  assert.match(view, /compaction, cache warming and hidden retries excluded/);
  assert.match(view, /LLM\/tool sums overlap; they are not additive/);
  assert.match(view, /— not reported · 0 observed zero · \* partial/);
  assert.match(view, /E2E TPS/);
  assert(!view.includes("top-secret output"), "the view only renders the stats contract, never output bodies");
});

test("health uses neutral idle and semantic busy/waiting/error colors without thresholds", () => {
  for (const [health, phrase, expected] of [
    ["unknown", "no activity observed", "dim"],
    ["idle", "idle (no current activity)", "dim"],
    ["busy", "busy", "accent"],
    ["waiting", "waiting", "warning"],
    ["error", "error", "error"],
  ]) {
    const calls = [];
    const mounted = mount({ data: snapshot({ health }), theme: styledTheme(calls) });
    const lines = paint(mounted, 100);
    const healthCalls = calls.filter(({ text }) => text === phrase);
    assert.deepEqual(healthCalls, [{ color: expected, text: phrase }],
      `${health}: inspect the health phrase itself, not colors used by unrelated chrome`);
    const overview = lines.find((line) => plain(line).includes("Open "));
    assert(overview?.includes(`\x1b[38;5;39m${phrase}\x1b[0m`), "the styled health phrase is actually painted in Overview");
    assert(!healthCalls.some(({ color }) => color === "success"), "activity is not a fabricated green score");
  }
});

test("1/2/3, Tab/Shift+Tab and pointer tabs select all views", () => {
  const mounted = mount();
  tabLine(mounted);
  mounted.view.handleInput("2");
  assert.match(tabLine(mounted), /›2 Models‹/);
  mounted.view.handleInput("3");
  assert.match(tabLine(mounted), /›3 Tools‹/);
  mounted.view.handleInput("1");
  assert.match(tabLine(mounted), /›1 Overview‹/);
  mounted.view.handleInput("\t");
  assert.match(tabLine(mounted), /›2 Models‹/);
  mounted.view.handleInput("\x1b[Z");
  assert.match(tabLine(mounted), /›1 Overview‹/);

  const tabs = tabLine(mounted);
  const toolsX = tabs.indexOf("3 Tools");
  assert(toolsX >= 0, tabs);
  assert.deepEqual(click(mounted.view, toolsX, 1), { handled: true });
  assert.match(tabLine(mounted), /›3 Tools‹/);
});

test("arrows, pages, Home/End and wheel stay within the current tab's scroll bounds across refresh", () => {
  const manyModels = Array.from({ length: 40 }, (_, index) => model(`model-${index}`));
  const mounted = mount({ rows: 24, data: snapshot({ models: manyModels }) });
  mounted.view.handleInput("2");
  paint(mounted, 100);
  mounted.view.handleInput("\x1b[F");
  let rendered = paint(mounted, 100).map(plain).join("\n");
  assert(rendered.includes("model-39"), rendered);
  mounted.view.handleInput("\x1b[5~");
  mounted.data = snapshot({ models: manyModels, lastTps: 99 });
  rendered = paint(mounted, 100).map(plain).join("\n");
  assert(rendered.includes("model-33"), "refresh keeps the reader's scroll position instead of resetting it");
  mounted.view.handleInput("\x1b[H");
  rendered = paint(mounted, 100).map(plain).join("\n");
  assert(rendered.includes("model-0"), rendered);
  mounted.view.handleMouse({ type: "wheel", wheelDelta: 100, x: 2, y: 4, width: 100, height: 24 });
  rendered = paint(mounted, 100).map(plain).join("\n");
  assert(rendered.includes("model-39"), "wheel clamps at the end");
  mounted.view.handleInput("\x1b[B");
  mounted.view.handleInput("\x1b[6~");
  assert.equal(mounted.view.handleMouse({ type: "wheel", wheelDelta: -100, x: 2, y: 4, width: 100, height: 24 })?.handled, true);
  mounted.view.handleInput("\x1b[H");
  assert(paint(mounted, 100).map(plain).join("\n").includes("model-0"));
});

test("models mark real zero, missing reports and partial figures distinctly, and sanitize labels", () => {
  const escapedModel = "evil\x1b[31m-red\nmodel";
  const escapedTool = "tool\x1b]8;;https://example.invalid\x07-name\rnext";
  const mounted = mount({ data: snapshot({
    models: [
      model(escapedModel, { requests: 0, errors: 0, outputTokens: 0, cost: 0, llmMs: 0, ttftMs: 0,
        ttftSamples: 0, tps: 0, partial: true }),
      model("missing", { outputTokens: undefined, cost: undefined, ttftMs: 800, ttftSamples: 2, tps: undefined }),
      model("same-model", { provider: "provider-a" }),
      model("same-model", { provider: "provider-b" }),
    ],
    tools: [tool(escapedTool)],
  }) });
  mounted.view.handleInput("2");
  let modelLines = paint(mounted, 140).map(plain);
  let rendered = modelLines.join("\n");
  assert.match(rendered, /out 0\* · \$0\.000\*/);
  assert.match(rendered, /out — · —/);
  assert.match(rendered, /E2E TPS 0\.00 tok\/s/);
  assert.match(rendered, /TTFT avg 800ms \(2 samples\)/, "ttftMs is already the reported mean");
  assert(modelLines.every((line) => !/\x1b|\n|\r/.test(line)), `control sequence escaped into view: ${JSON.stringify(modelLines)}`);
  assert(rendered.includes("evil-red model"));
  assert(rendered.includes("provider-a/same-model"));
  assert(rendered.includes("provider-b/same-model"));

  mounted.view.handleInput("3");
  rendered = paint(mounted, 140).map(plain).join("\n");
  assert(rendered.includes("tool-name next"), rendered);
});

test("main and worker metrics stay separate even for identical model/tool names", () => {
  const mounted = mount({ rows: 40, data: snapshot({ elapsedMs: 1000, busyMs: 500, idleMs: 500,
    models: [model("same", { provider: "p", outputTokens: 10 })], tools: [tool("read")],
    workers: { observed: 3, resident: 2, running: 2, busyMs: 3000, llmMs: 2000, toolMs: 800,
      activeRequests: 2, activeTools: 1, health: "busy", partial: false,
      models: [model("same", { provider: "p", outputTokens: 90 })], tools: [tool("read", { calls: 9 })] },
  }) });
  let text = paint(mounted, 140).map(plain).join("\n");
  assert.match(text, /Main wall: busy 500ms · idle 500ms/);
  assert.match(text, /Workers: 2 running \/ 2 tracked · 3 observed · busy Σ 3\.0s/);
  assert.match(text, /Parent approval wait:.*counted once/);
  mounted.view.handleInput("2"); text = paint(mounted, 140).map(plain).join("\n");
  assert.match(text, /\[main\] p\/same/); assert.match(text, /\[worker\] p\/same/);
  assert.match(text, /out 10/); assert.match(text, /out 90/);
  mounted.view.handleInput("3"); text = paint(mounted, 140).map(plain).join("\n");
  assert.match(text, /\[main\] read/); assert.match(text, /\[worker\] read/); assert.match(text, /9 calls/);
});

test("Esc and × close once; invalidate/input/mouse callbacks are inert after disposal", () => {
  const mounted = mount();
  paint(mounted, 100);
  const before = mounted.renders();
  mounted.view.invalidate();
  assert.equal(mounted.renders(), before + 1);
  mounted.view.handleInput("2");
  assert.equal(mounted.renders(), before + 2);
  mounted.view.handleInput("\x1b");
  assert.equal(mounted.closes(), 1);
  const afterClose = mounted.renders();
  mounted.view.dispose();
  mounted.view.dispose();
  mounted.view.invalidate();
  mounted.view.handleInput("3");
  mounted.view.handleMouse({ type: "wheel", wheelDelta: 1, x: 2, y: 4, width: 100, height: 24 });
  assert.equal(mounted.renders(), afterClose);
  assert.equal(mounted.closes(), 1);

  const closeByPointer = mount();
  const top = plain(paint(closeByPointer, 100)[0]);
  const x = top.indexOf("×");
  assert(x >= 0, top);
  assert.deepEqual(click(closeByPointer.view, x, 0), { handled: true });
  assert.equal(closeByPointer.closes(), 1);
  click(closeByPointer.view, x, 0);
  assert.equal(closeByPointer.closes(), 1);
});
