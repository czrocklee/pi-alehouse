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
const { StatsView, statsSummary } = await jiti.import(join(root, "extensions/lib/stats-view.ts"));
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
  assert.match(view, /main session \+ managed workers/);
  assert.match(view, /compaction, cache warming and hidden retries excluded/);
  assert.match(view, /LLM\/tool sums overlap; they are not additive/);
  assert.match(view, /— not reported · 0 observed zero · \* partial/);
  assert.match(view, /Output speed +12\.5 tok\/s/);
  assert.match(view, /Latency starts at SDK turn start \(includes preflight\)/);
  assert(!view.includes("top-secret output"), "the view only renders the stats contract, never output bodies");
});

test("overview tables share a band when they fit and stack when they do not", () => {
  const mounted = mount({ rows: 40, data: snapshot({ workers: { observed: 1, resident: 1, running: 1, busyMs: 1000,
    llmMs: 500, toolMs: 100, activeRequests: 1, activeTools: 0, health: "busy", partial: false, models: [], tools: [] } }) });
  const wide = paint(mounted, 140).map(plain);
  const header = wide.find((line) => /Time +Main +Workers/.test(line));
  assert(header?.includes("Now") && header.includes("Last main request"), wide.join("\n"));
  assert(wide.some((line) => /Busy +1m +1\.0s +Agents running +1 of 1 +TTFT +250ms/.test(line)), wide.join("\n"));
  const narrow = paint(mounted, 50).map(plain);
  const at = (pattern) => narrow.findIndex((line) => pattern.test(line));
  assert(at(/Time +Main +Workers/) >= 0 && at(/Now +Main +Workers/) > at(/Approval wait/), narrow.join("\n"));
  assert(at(/Last main request +Main/) > at(/Last event/), narrow.join("\n"));
  for (const line of narrow) assert.equal(visibleWidth(line), 50);
});

test("health uses neutral idle and semantic busy/waiting/error colors without thresholds", () => {
  for (const [health, phrase, expected] of [
    ["unknown", "● no activity yet", "dim"],
    ["idle", "● idle", "dim"],
    ["busy", "● busy", "accent"],
    ["waiting", "● waiting", "warning"],
    ["error", "● error", "error"],
  ]) {
    const calls = [];
    const mounted = mount({ data: snapshot({ health }), theme: styledTheme(calls) });
    const lines = paint(mounted, 100);
    const healthCalls = calls.filter(({ text }) => text === phrase);
    assert.deepEqual(healthCalls, [{ color: expected, text: phrase }],
      `${health}: inspect the health phrase itself, not colors used by unrelated chrome`);
    const status = lines.find((line) => plain(line).includes("open 3m"));
    assert(status?.includes(`\x1b[38;5;39m${phrase}\x1b[0m`), "the styled health phrase is actually painted beside the tabs");
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
  const before = paint(mounted, 100).map(plain);
  assert(!before.join("\n").includes("model-39") && !before.join("\n").includes("model-0 "), before.join("\n"));
  mounted.data = snapshot({ models: manyModels, lastTps: 99 });
  assert.deepEqual(paint(mounted, 100).map(plain), before, "refresh keeps the reader's scroll position instead of resetting it");
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
  const modelLines = paint(mounted, 140).map(plain);
  const rendered = modelLines.join("\n");
  assert.match(rendered, /Model +Req +Err +LLM Σ +TTFT +tok\/s +Out +Cost/);
  // Partial marks the row; zero stays a figure; no samples means no mean.
  assert.match(rendered, /evil-red model\* +0 +0 +0ms +— +0\.00 +0 +\$0\.000 /);
  assert.match(rendered, /missing +2 +0 +12s +800ms +— +— +— /, "ttftMs is already the reported mean");
  assert(modelLines.every((line) => !/\x1b|\n|\r/.test(line)), `control sequence escaped into view: ${JSON.stringify(modelLines)}`);
  assert(rendered.includes("provider-a/same-model"));
  assert(rendered.includes("provider-b/same-model"));

  mounted.view.handleInput("3");
  const tools = paint(mounted, 140).map(plain).join("\n");
  assert.match(tools, /Tool +Calls +Err +Σ time +Avg +Max/);
  assert.match(tools, /tool-name next +2 +0 +800ms +400ms +500ms /, tools);
});

test("narrow tables drop provider prefixes on every row, then optional columns, never the key figure", () => {
  const mounted = mount({ rows: 40, data: snapshot({
    models: [model("long-model-name", { provider: "some-provider" }), model("m", { provider: "p" })],
    tools: [tool("read")],
  }) });
  mounted.view.handleInput("2");
  const roomy = paint(mounted, 120).map(plain).join("\n");
  assert(roomy.includes("some-provider/long-model-name") && roomy.includes("p/m "), roomy);
  const tight = paint(mounted, 50).map(plain).join("\n");
  assert(!tight.includes("some-provider/") && !tight.includes("p/m"), "a prefix on only some rows would read as a difference");
  assert.match(tight, /Model +.*TTFT/);
  assert.doesNotMatch(tight, / Out /, "output tokens give way before latency");
  mounted.view.handleInput("3");
  assert.match(paint(mounted, 24).map(plain).join("\n"), /Σ time/);
});

test("same model ids from different providers keep their prefixes; optional columns give way first", () => {
  const mounted = mount({ rows: 40, data: snapshot({
    models: [model("same-model", { provider: "provider-a" }), model("same-model", { provider: "provider-b" }),
      model("other", { provider: "provider-a" })],
  }) });
  mounted.view.handleInput("2");
  for (const width of [64, 50, 40]) {
    const text = paint(mounted, width).map(plain).join("\n");
    assert.match(text, /provider-a\/same-model /, text);
    assert.match(text, /provider-b\/same-model /, text);
    assert.match(text, /provider-a\/other /, "all rows or none");
    assert.match(text, /TTFT/, "the key figure stays");
  }
  const tight = paint(mounted, 40).map(plain).join("\n");
  assert.doesNotMatch(tight, / Out | Cost /, tight);
});

test("main and worker metrics stay separate even for identical model/tool names", () => {
  const mounted = mount({ rows: 40, data: snapshot({ elapsedMs: 1000, busyMs: 500, idleMs: 500, longestActiveToolMs: 65000,
    models: [model("same", { provider: "p", outputTokens: 10 })], tools: [tool("read")],
    workers: { observed: 3, resident: 2, running: 2, busyMs: 3000, llmMs: 2000, toolMs: 800,
      activeRequests: 2, activeTools: 1, longestActiveToolMs: 4000, health: "busy", partial: false,
      models: [model("same", { provider: "p", outputTokens: 90 })], tools: [tool("read", { calls: 9 })] },
  }) });
  let lines = paint(mounted, 140).map(plain);
  let text = lines.join("\n");
  assert.match(text, /Busy +500ms +3\.0s/);
  assert.match(text, /Idle +500ms +[│ ]/, "worker busy is a sum, so it has no idle counterpart");
  assert.match(text, /Agents running +2 of 2/);
  assert.match(text, /Oldest tool call +1m ago +4s ago/, "running calls' age is apart from Tools Σ");
  assert.match(text, /Worker figures add up 3 observed workers\./);
  assert.match(text, /Approval wait includes forwarded worker asks, counted once/);
  const order = (...patterns) => patterns.map((pattern) => lines.findIndex((line) => pattern.test(line)));
  mounted.view.handleInput("2"); lines = paint(mounted, 140).map(plain);
  const [main, mainRow, workers, workerRow] = order(/│ Main /, /p\/same .* 10 /, /│ Workers /, /p\/same .* 90 /);
  assert(main >= 0 && main < mainRow && mainRow < workers && workers < workerRow, lines.join("\n"));
  mounted.view.handleInput("3"); lines = paint(mounted, 140).map(plain);
  const [toolMain, mainRead, toolWorkers, workerRead] = order(/│ Main /, /read +2 /, /│ Workers /, /read +9 /);
  assert(toolMain >= 0 && toolMain < mainRead && mainRead < toolWorkers && toolWorkers < workerRead, lines.join("\n"));
});

test("the footer is inlaid in the bottom edge and names only keys that do something", () => {
  const mounted = mount({ rows: 40 });
  let bottom = plain(paint(mounted, 100).at(-1));
  assert.match(bottom, /^╰─ 1-3\/Tab view · Esc close ─+╯$/);
  const many = mount({ rows: 24, data: snapshot({ models: Array.from({ length: 40 }, (_, index) => model(`model-${index}`)) }) });
  many.view.handleInput("2");
  bottom = plain(paint(many, 100).at(-1));
  assert.match(bottom, /^╰─ 1-3\/Tab view · ↑↓ PgUp\/PgDn scroll · Esc close ─+ \d+\/\d+ lines ─╯$/);
  // Narrower, the keys shorten before the position gives way, as in the agent detail pane.
  assert.match(plain(paint(many, 40).at(-1)), /^╰─ Tab · ↑↓ · Esc ─+ \d+\/\d+ lines ─╯$/);
  assert.match(plain(paint(many, 30).at(-1)), /^╰─ Esc ─+ \d+\/\d+ lines ─╯$/);
  for (const width of [8, 12, 30, 60]) assert.equal(visibleWidth(paint(many, width).at(-1)), width);
});

test("the box is sized to its content: no blank 75% reservation, no width or height jumps between tabs", () => {
  const mounted = mount({ rows: 60 });
  const heights = ["1", "2", "3"].map((key) => { mounted.view.handleInput(key); return paint(mounted, 100).length; });
  assert.equal(new Set(heights).size, 1, `tabs share one height: ${heights}`);
  assert(heights[0] < Math.floor(60 * 0.75), "short content is not padded out to the height cap");

  const width = mounted.view.preferredWidth(300);
  assert(width >= 40 && width < 300, `hugs its tables: ${width}`);
  assert.equal(mounted.view.preferredWidth(30), 30, "never wider than the caller allows");
  mounted.data = snapshot({ models: [model(`long-${"x".repeat(150)}`, { provider: "provider" })] });
  const grown = mounted.view.preferredWidth(300);
  assert(grown > width, "grows with a wider table");
  mounted.data = snapshot();
  assert.equal(mounted.view.preferredWidth(300), grown, "never narrows while open");
});

test("recent errors say where, when, which model and what failed, newest first", () => {
  const long = "429 Rate limit reached for requests. Limit: 60 requests per minute. Please retry after 20 seconds, then try again.";
  const data = snapshot({ health: "error",
    recentErrors: [{ ageMs: 754000, provider: "anthropic", model: "opus", message: "overloaded", cleared: true }],
    workers: { observed: 1, resident: 1, running: 0, busyMs: 0, llmMs: 0, toolMs: 0, activeRequests: 0, activeTools: 0,
      health: "error", partial: false, models: [], tools: [], recentErrors: [
        { ageMs: 12000, workerId: "a7\x1b[31m", provider: "zai", model: "glm", message: long, cleared: false },
        { ageMs: 30000, workerId: "b2", message: "Run failed without a provider error", cleared: false },
      ] } });
  const lines = paint(mount({ rows: 60, data }), 140).map(plain);
  const text = lines.join("\n");
  assert.match(text, /Recent errors +When +Model +Message/);
  const row = (pattern) => lines.findIndex((line) => pattern.test(line));
  const a7 = row(/! a7 +12s ago +zai\/glm +429 Rate limit/);
  assert(a7 >= 0, text);
  assert.match(lines[a7 + 1], /^│ +\S/, "a long message wraps under its own column");
  assert(a7 < row(/! b2 +30s ago +— +Run failed/) && row(/! b2/) < row(/· main +12m ago +anthropic\/opus +overloaded/),
    "newest first, whatever the source");
  assert.match(text, /! still holds the indicator red, · no longer does\. Red clears when a later response\s/);

  const narrow = paint(mount({ rows: 60, data }), 60).map(plain).join("\n");
  assert.match(narrow, /Recent errors +When +Message/, "the model gives way before the message does");
  assert.doesNotMatch(narrow, /zai\/glm/);
  assert(statsSummary(data).some((line) => /^ {2}! a7 +12s ago +zai\/glm +429 Rate limit/.test(line)));
  assert.doesNotMatch(paint(mount({ rows: 60 }), 140).map(plain).join("\n"), /Recent errors/, "no errors, no table");
});

test("the regular-mode summary is the plain Time table", () => {
  const lines = statsSummary(snapshot({ workers: { observed: 1, resident: 1, running: 0, busyMs: 1000, llmMs: 500,
    toolMs: 100, activeRequests: 0, activeTools: 0, health: "idle", partial: false, models: [], tools: [] } }));
  assert.match(lines[0], /^Time +Main +Workers$/);
  assert.match(lines[1], /^Busy +1m +1\.0s$/);
  assert.match(lines[2], /^Idle +2m$/);
  assert(lines.every((line) => !/\x1b/.test(line)));
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
