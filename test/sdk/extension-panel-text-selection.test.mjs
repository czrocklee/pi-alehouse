// Focused panel-local text selection for the four extension-owned panels.
//
// Real pinned TuiAltScreen with a fake terminal and an injected `copySelection`,
// so the assertions read the text the host actually hands to the clipboard. No
// terminal is started, nothing is written to a device, no build is required and
// no provider/session/approval IO happens: the panels are source-loaded and fed
// synthetic snapshots.
//
// The contract under test is the integration, not the shared helper: each panel
// must publish only its painted body rectangle, so a drag inside that body copies
// body text and never the title, frame, gutter or footer, in both border-label
// placements. The copy assertion is exact: the clipboard text is compared cell
// for cell against the painted body rows through the native copy path, and the
// native highlight is checked to sit inside the same rectangle. An unhandled
// press on the panel's own chrome starts no selection at all; presses outside
// every registered panel stay native (covered by the shared helper's own SDK
// lane, not here).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import {
  sliceByColumn,
  stripTerminalSequences as plain,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  popoverChromeLayout,
  popoverTextRect,
  setBorderLabelsEnabled,
} from "../../src/shared/popover-chrome.mjs";

// Source-loaded views: no generated runtime, sessions, providers or approval IO.
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { ApprovalPopover } = await jiti.import("../../src/extensions/lib/approval-view.ts");
const { ContextView } = await jiti.import("../../src/extensions/lib/context-view.ts");
const { StatsView } = await jiti.import("../../src/extensions/lib/stats-view.ts");
const { createFooterPanels } = await jiti.import("../../src/extensions/lib/footer-panels.ts");

const theme = {
  fg(tone, text) {
    const code =
      {
        accent: 36,
        muted: 90,
        dim: 2,
        text: 37,
        borderAccent: 34,
        borderMuted: 90,
        warning: 33,
        error: 31,
        success: 32,
      }[tone] ?? 37;
    return `\x1b[${code}m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  bg: (_tone, text) => `\x1b[44m${text}\x1b[49m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
};

const contextSnapshot = () => ({
  usage: { tokens: 100, contextWindow: 1000, percent: 10 },
  categories: [{ id: "system", label: "System", rawTokens: 100, tokens: 100, count: 1 }],
  items: [
    {
      id: "system:1",
      category: "system",
      label: "Instructions",
      kind: "system",
      rawTokens: 100,
      tokens: 100,
      count: 1,
      rawState: "estimate",
    },
  ],
  allocation: "proportional",
  attribution: "complete",
  replay: "selected",
  rawTokens: 100,
  note: "Estimates only",
});
const statsSnapshot = () => ({ health: "idle", models: [], tools: [], recentErrors: [] });
const spendRows = () => [
  { key: "anthropic/claude-x", input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.42 },
];
const choices = [
  { id: "manual", label: "manual", detail: "human approval" },
  { id: "yolo", label: "YOLO", detail: "session asks" },
];

/** Tall synthetic context: two present tabs and more rows than the painted
 * viewport, so a page key really moves the painted window instead of no-opping. */
function tallContextSnapshot() {
  const item = (index, category, label) => ({
    id: `${category}:${index}`,
    category,
    label,
    kind: category,
    rawTokens: 1000 - index * 10,
    tokens: 1000 - index * 10,
    count: 1,
    rawState: "estimate",
  });
  return {
    usage: { tokens: 7000, contextWindow: 100000, percent: 7 },
    categories: [
      { id: "system", label: "System", rawTokens: 3940, tokens: 3940, count: 4 },
      { id: "messages", label: "Messages", rawTokens: 3060, tokens: 3060, count: 4 },
    ],
    items: [
      item(1, "system", "Sys item 1"),
      item(2, "system", "Sys item 2"),
      item(3, "system", "Sys item 3"),
      item(4, "system", "Sys item 4"),
      item(5, "messages", "Msg item 1"),
      item(6, "messages", "Msg item 2"),
      item(7, "messages", "Msg item 3"),
      item(8, "messages", "Msg item 4"),
    ],
    allocation: "proportional",
    attribution: "complete",
    replay: "selected",
    rawTokens: 7000,
    note: "Estimates only",
  };
}

/** Tall synthetic stats: the Models tab is longer than the painted viewport, so
 * both a tab switch and a page key really change the painted rows. */
function tallStatsSnapshot() {
  const models = Array.from({ length: 60 }, (_, index) => ({
    provider: "acme",
    model: `model-${String(index).padStart(2, "0")}`,
    requests: 1,
    errors: 0,
    outputTokens: 10,
    cost: 0,
    llmMs: 1000,
    ttftMs: 100,
    ttftSamples: 1,
    timedOutputTokens: 10,
    timedOutputMs: 1000,
    tps: 10,
    partial: false,
  }));
  return { ...statsSnapshot(), models };
}

const OVERLAY = { row: 5, col: 10 };
/** Outer frame, gutter and close control: never part of a body selection. */
const FRAME_GLYPHS = /[│╭╮╰╯✕]/;
/** Horizontal rule. Only the approval body paints interior dividers between its
 * choice and save groups, so only there is a rule row legitimate body content. */
const RULE_GLYPH = /─/;

/** Real fullscreen host, fake terminal, captured clipboard. */
function fixture(t) {
  const copied = [];
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copyOnSelect: false,
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
  });
  let renders = 0;
  tui.requestRender = () => renders++;
  tui.requestImmediateRender = () => renders++;
  const root = {
    render: () => Array.from({ length: 80 }, (_, index) => `Root transcript row ${index}`),
    invalidate() {},
    handleMouse() {},
  };
  tui.setLayoutRoot(root);
  tui.beforeTerminalStart();
  t.after(() => {
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines();
  };
  const send = (button, x, y, release = false) =>
    tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  return {
    tui,
    copied,
    paint,
    send,
    get renders() {
      return renders;
    },
  };
}

/** Body rectangle the integration is contracted to publish, from shared geometry. */
function bodyRect(kind, bounds) {
  const layout = popoverChromeLayout({ framed: true });
  if (kind === "Context")
    return popoverTextRect(bounds.width, bounds.height, {
      inset: 2,
      top: layout.top.rows + 1,
      bottom: layout.bottom.rows,
    });
  if (kind === "Stats")
    return popoverTextRect(bounds.width, bounds.height, {
      inset: 2,
      top: layout.top.rows + 2,
      bottom: layout.bottom.rows,
    });
  if (kind === "Approval")
    return popoverTextRect(bounds.width, bounds.height, {
      inset: 1,
      top: layout.top.rows,
      bottom: 1,
    });
  return popoverTextRect(bounds.width, bounds.height, { inset: 2, bottom: 1 });
}

/** The native highlight itself must stay inside the published body rectangle. */
function assertHighlightWithinBody(tui, bounds, rect) {
  const selection = tui.getSelectionBounds();
  assert.ok(selection, "a native highlight exists");
  const left = bounds.col + rect.x;
  const top = bounds.row + rect.y;
  for (const point of [selection.start, selection.end]) {
    assert.ok(
      point.row >= top && point.row < top + rect.height,
      `highlight row ${point.row} inside the body rows ${top}..${top + rect.height - 1}`,
    );
    assert.ok(
      point.col >= left && point.col < left + rect.width,
      `highlight column ${point.col} inside the body columns ${left}..${left + rect.width - 1}`,
    );
  }
}

/** The body rows as the native copy path slices them: frame and gutter excluded. */
function expectedBodyText(lines, bounds, rect) {
  return lines
    .slice(bounds.row + rect.y, bounds.row + rect.y + rect.height)
    .map((line) => plain(sliceByColumn(line, bounds.col + rect.x, rect.width, true)).trimEnd())
    .join("\n");
}

function mountOverlay(fx, component, width) {
  return fx.tui.showOverlay(component, {
    anchor: "top-left",
    row: OVERLAY.row,
    col: OVERLAY.col,
    width,
  });
}

function contextPanel(fx, { snapshot = contextSnapshot, available = 30 } = {}) {
  const component = new ContextView({
    tui: fx.tui,
    theme,
    snapshot,
    availableRows: () => available,
    requestRender: () => {},
    close: () => {},
  });
  return { component, handle: mountOverlay(fx, component, 60), dispose: () => component.dispose() };
}

function statsPanel(fx, { snapshot = statsSnapshot } = {}) {
  const component = new StatsView({
    tui: fx.tui,
    theme,
    snapshot,
    close: () => {},
  });
  return { component, handle: mountOverlay(fx, component, 70), dispose: () => component.dispose() };
}

function approvalPanel(fx) {
  const component = new ApprovalPopover({
    tui: fx.tui,
    theme,
    choices: () => choices,
    current: () => "manual",
    warning: (id) => (id === "yolo" ? ["Confirm wider approval"] : undefined),
    choose: () => {},
    close: () => {},
    requestRender: () => {},
  });
  return { component, handle: mountOverlay(fx, component, 56), dispose: () => component.dispose() };
}

function usagePanel(fx) {
  const events = new EventEmitter();
  const listeners = new EventEmitter();
  const on = (emitter) => (name, handler) => {
    emitter.on(name, handler);
    return () => emitter.off(name, handler);
  };
  const mounted = [];
  const original = fx.tui.showOverlay.bind(fx.tui);
  fx.tui.showOverlay = (component, options) => {
    const handle = original(component, options);
    mounted.push({ component, handle });
    return handle;
  };
  const panels = createFooterPanels({
    pi: { events: { on: on(events) }, on: on(listeners) },
    ctx: { hasUI: true, ui: {} },
    tui: fx.tui,
    theme,
    spend: spendRows,
    contextSnapshot,
    compaction: () => undefined,
    currentFooter: () => true,
  });
  panels.toggleBreakdown();
  const entry = mounted.at(-1);
  assert.ok(entry, "the usage breakdown mounted an overlay");
  return {
    component: entry.component,
    handle: entry.handle,
    dispose: () => panels.dispose(() => {}),
  };
}

const PANELS = {
  Context: {
    title: "Context",
    bodyToken: "Instructions",
    mount: contextPanel,
    // The totals/bar row is chrome and must stay out of the body.
    excludedBodyToken: "Estimates only",
  },
  Stats: { title: "Stats", bodyToken: "Busy", mount: statsPanel },
  Approval: {
    title: "Approval",
    bodyToken: "human approval",
    mount: approvalPanel,
    // Its body groups rows, so it paints interior dividers between them.
    interiorRules: true,
  },
  Usage: { title: "usage by model", bodyToken: "claude-x", mount: usagePanel },
};

/** A navigation repaint must leave no selection and write nothing to the clipboard. */
async function assertRetired(fx, copiesBefore, label) {
  assert.equal(fx.tui.hasActiveSelection(), false, `${label}: no active selection`);
  assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, `${label}: nothing to copy`);
  assert.equal(fx.copied.length, copiesBefore, `${label}: no clipboard write`);
}

/** Press in the first body cell, drag to the last, release, then copy. */
async function dragBody(fx, bounds, rect) {
  const from = { x: bounds.col + rect.x, y: bounds.row + rect.y };
  const to = {
    x: bounds.col + rect.x + rect.width - 1,
    y: bounds.row + rect.y + rect.height - 1,
  };
  fx.send(0, from.x, from.y);
  fx.send(32, to.x, to.y);
  fx.send(0, to.x, to.y, true);
  const copied = await fx.tui.copyActiveSelectionToClipboard();
  return copied;
}

for (const labels of [true, false]) {
  const placement = labels ? "border labels on" : "border labels off";

  for (const [kind, spec] of Object.entries(PANELS)) {
    test(`${kind}: a body drag copies only the painted body (${placement})`, async (t) => {
      setBorderLabelsEnabled(labels);
      t.after(() => setBorderLabelsEnabled(true));
      const fx = fixture(t);
      const panel = spec.mount(fx);
      t.after(() => panel.dispose());

      const lines = fx.paint();
      const bounds = panel.handle.getBounds();
      assert.ok(bounds, "the overlay painted visible bounds");
      const rect = bodyRect(kind, bounds);
      assert.ok(rect, "the painted body rectangle is non-empty");

      const copied = await dragBody(fx, bounds, rect);
      assert.equal(copied, true, "the native copy path accepted the body selection");
      const text = fx.copied.at(-1);
      assert.ok(text, "clipboard text was produced");

      // Exact native copy proof: the clipboard holds the painted body rows,
      // column-clipped to the body rectangle, and nothing else.
      assert.equal(text, expectedBodyText(lines, bounds, rect));
      assertHighlightWithinBody(fx.tui, bounds, rect);
      assert.ok(text.includes(spec.bodyToken), `body text present: ${spec.bodyToken}`);
      assert.ok(
        !text.includes(spec.title),
        `panel title excluded from the selection: ${spec.title}`,
      );
      if (spec.excludedBodyToken)
        assert.ok(
          !text.includes(spec.excludedBodyToken),
          `chrome row excluded from the selection: ${spec.excludedBodyToken}`,
        );
      for (const line of text.split("\n")) {
        assert.ok(!FRAME_GLYPHS.test(line), `no frame or close glyph: ${JSON.stringify(line)}`);
        if (!spec.interiorRules)
          assert.ok(!RULE_GLYPH.test(line), `no rule row in the body: ${JSON.stringify(line)}`);
        assert.ok(visibleWidth(line) <= rect.width, "body width is never exceeded");
      }
    });
  }
}

test("an unhandled press on the panel's own chrome starts no selection at all", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  const fx = fixture(t);
  const panel = contextPanel(fx);
  t.after(() => panel.dispose());
  fx.paint();
  const bounds = panel.handle.getBounds();
  assert.ok(bounds);
  // The title edge is overlay row 0: inside the registered panel, outside the
  // declared body rectangle. A fresh press there must not begin a whole-screen
  // selection, so nothing is highlighted and nothing reaches the clipboard.
  fx.send(0, bounds.col + 2, bounds.row);
  fx.send(32, bounds.col + bounds.width - 3, bounds.row);
  fx.send(0, bounds.col + bounds.width - 3, bounds.row, true);
  assert.equal(fx.tui.hasActiveSelection(), false, "chrome press starts no selection");
  assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "there is nothing to copy");
  assert.equal(fx.copied.length, 0, "no clipboard write happened");
});

test("Context: a real page move and a real tab switch retire the body selection", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  const snapshot = tallContextSnapshot();
  // A stable snapshot identity is what makes Context's navigation keys usable:
  // `ready()` compares the live read against the last painted snapshot.
  const fx = fixture(t);
  const panel = contextPanel(fx, { snapshot: () => snapshot });
  t.after(() => panel.dispose());
  const view = panel.component;

  const paintBody = () => {
    const lines = fx.paint();
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    const rect = bodyRect("Context", bounds);
    assert.ok(rect, "the painted body rectangle is non-empty");
    return { lines, bounds, rect, text: expectedBodyText(lines, bounds, rect) };
  };

  // --- page move: eight rows against a five-row viewport ---
  const first = paintBody();
  assert.ok(first.text.includes("Sys item 1"), "the overview starts at the first row");
  await dragBody(fx, first.bounds, first.rect);
  assert.equal(fx.tui.hasActiveSelection(), true, "a body selection is live before paging");
  let copies = fx.copied.length;

  view.handleInput("\x1b[6~"); // PageDown
  const paged = paintBody();
  assert.notEqual(
    paged.text,
    first.text,
    "the page key really moved the painted rows, not a no-op key",
  );
  assert.ok(paged.text.includes("Sys item 4"), "the paged window starts later in the roster");
  assert.equal(
    paged.bounds.height,
    first.bounds.height,
    "paging kept the same painted height, so only the viewport key changed",
  );
  await assertRetired(fx, copies, "Context page move");

  // --- tab switch: overview -> System ---
  await dragBody(fx, paged.bounds, paged.rect);
  assert.equal(fx.tui.hasActiveSelection(), true, "a body selection is live before switching tabs");
  copies = fx.copied.length;

  view.handleInput("\t"); // Tab
  const tabbed = paintBody();
  assert.ok(tabbed.text.includes("Sys item 1"), "the System tab is painted");
  assert.ok(
    !tabbed.text.includes("Msg item 1"),
    "the tab really changed the rows, not a no-op key",
  );
  assert.ok(
    plain(
      tabbed.lines.slice(tabbed.bounds.row, tabbed.bounds.row + tabbed.bounds.height).join("\n"),
    ).includes("›System‹"),
    "the painted tab marker moved to System",
  );
  assert.equal(
    tabbed.bounds.height,
    paged.bounds.height,
    "the tab switch kept the same painted height, so only the viewport key changed",
  );
  await assertRetired(fx, copies, "Context tab switch");
});

test("Stats: a real tab switch and a real scroll retire the body selection", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  const snapshot = tallStatsSnapshot();
  const fx = fixture(t);
  const panel = statsPanel(fx, { snapshot: () => snapshot });
  t.after(() => panel.dispose());
  const view = panel.component;

  const paintBody = () => {
    const lines = fx.paint();
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    const rect = bodyRect("Stats", bounds);
    assert.ok(rect, "the painted body rectangle is non-empty");
    return { lines, bounds, rect, text: expectedBodyText(lines, bounds, rect) };
  };

  // --- tab switch: Overview -> Models ---
  const overview = paintBody();
  assert.ok(!overview.text.includes("model-00"), "the overview is not the model table");
  await dragBody(fx, overview.bounds, overview.rect);
  assert.equal(fx.tui.hasActiveSelection(), true, "a body selection is live before switching tabs");
  let copies = fx.copied.length;

  view.handleInput("2");
  const models = paintBody();
  assert.ok(models.text.includes("model-00"), "the Models tab is painted");
  assert.equal(
    models.bounds.height,
    overview.bounds.height,
    "the tab switch kept the same painted height, so only the viewport key changed",
  );
  await assertRetired(fx, copies, "Stats tab switch");

  // --- scroll: the Models tab is taller than its viewport ---
  await dragBody(fx, models.bounds, models.rect);
  assert.equal(fx.tui.hasActiveSelection(), true, "a body selection is live before scrolling");
  copies = fx.copied.length;

  view.handleInput("\x1b[6~"); // PageDown
  const scrolled = paintBody();
  assert.notEqual(
    scrolled.text,
    models.text,
    "the page key really scrolled the viewport, not a no-op key",
  );
  assert.ok(scrolled.text.includes("model-26"), "the scrolled window starts later in the table");
  await assertRetired(fx, copies, "Stats scroll");
});

test("the border-label switch retires a bound selection in every panel", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  for (const [kind, spec] of Object.entries(PANELS)) {
    const fx = fixture(t);
    const panel = spec.mount(fx);
    try {
      fx.paint();
      const bounds = panel.handle.getBounds();
      assert.ok(bounds, `${kind} painted bounds`);
      const rect = bodyRect(kind, bounds);
      assert.ok(rect);
      await dragBody(fx, bounds, rect);
      assert.equal(fx.tui.hasActiveSelection(), true, `${kind} holds a live body selection`);

      // A live appearance change moves the body rows: the old domain must die
      // rather than be clipped onto the new frame.
      setBorderLabelsEnabled(false);
      assert.equal(
        fx.tui.hasActiveSelection(),
        false,
        `${kind} retired its selection on the border-label switch`,
      );
      setBorderLabelsEnabled(true);
    } finally {
      panel.dispose();
    }
  }
});

test("an empty or too-small paint retires the bound selection", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  const cases = [
    ["Context", contextPanel, 0],
    ["Stats", statsPanel, 0],
    ["Approval", approvalPanel, 8],
    ["Usage", usagePanel, 0],
  ];
  for (const [kind, mount, emptyWidth] of cases) {
    const fx = fixture(t);
    const panel = mount(fx);
    try {
      fx.paint();
      const bounds = panel.handle.getBounds();
      assert.ok(bounds, `${kind} painted bounds`);
      const rect = bodyRect(kind, bounds);
      assert.ok(rect);
      await dragBody(fx, bounds, rect);
      assert.equal(fx.tui.hasActiveSelection(), true, `${kind} holds a live body selection`);

      // No body was painted, so no domain may survive: the helper is told the
      // region is gone rather than left to clip a stale one.
      panel.component.render(emptyWidth);
      assert.equal(
        fx.tui.hasActiveSelection(),
        false,
        `${kind} retired its selection when no body was painted`,
      );
    } finally {
      panel.dispose();
    }
  }
});

test("repeated usage show/hide leaves no bound selection behind", async (t) => {
  setBorderLabelsEnabled(true);
  t.after(() => setBorderLabelsEnabled(true));
  const fx = fixture(t);
  const events = new EventEmitter();
  const listeners = new EventEmitter();
  const on = (emitter) => (name, handler) => {
    emitter.on(name, handler);
    return () => emitter.off(name, handler);
  };
  const panels = createFooterPanels({
    pi: { events: { on: on(events) }, on: on(listeners) },
    ctx: { hasUI: true, ui: {} },
    tui: fx.tui,
    theme,
    spend: spendRows,
    contextSnapshot,
    compaction: () => undefined,
    currentFooter: () => true,
  });
  t.after(() => panels.dispose(() => {}));

  for (let cycle = 0; cycle < 3; cycle++) {
    panels.toggleBreakdown();
    const lines = fx.paint();
    assert.ok(lines.length > 0);
    // The pinned panel is bottom-anchored; find its painted bounds through the
    // public overlay handle the footer keeps internally by re-reading the stack.
    const overlay = fx.tui.overlayStack.find(
      (entry) => entry.component && typeof entry.component.render === "function",
    );
    assert.ok(overlay, "the breakdown is on the overlay stack");
    const bounds = overlay.bounds;
    assert.ok(bounds, "the breakdown painted bounds");
    const rect = bodyRect("Usage", bounds);
    assert.ok(rect);
    await dragBody(fx, bounds, rect);
    assert.equal(fx.tui.hasActiveSelection(), true, `cycle ${cycle} selected the body`);

    // Hiding disposes the per-pinned-instance helper: the selection cannot
    // outlive the panel it was bound to.
    panels.toggleBreakdown();
    assert.equal(
      fx.tui.hasActiveSelection(),
      false,
      `cycle ${cycle} retired the selection when the panel closed`,
    );
  }
});

// --- Chrome controls stay clickable, and chrome never selects -----------------
//
// Native fullscreen selection owns the primary press before any component
// click is synthesized: a press the panel leaves unhandled must still reach the
// release as a click, or every tab and pager control goes dead. The shared
// adapter therefore pins an empty chrome domain for a press on a registered
// panel's own chrome: the gesture survives as a click, but no chrome cell can
// be highlighted or copied. These tests drive the real SGR listener, so a
// press-only regression cannot hide behind a direct handleInput/click call.

/** Plain painted screen rows from the real fullscreen host. */
function painted(fx) {
  return fx.paint().map(plain);
}

/** Absolute screen cell of the first painted occurrence of `label`. */
function locate(lines, label, row) {
  const y = row ?? lines.findIndex((line) => line.includes(label));
  assert.ok(y >= 0, `a painted row contains ${label}`);
  const index = lines[y].indexOf(label);
  assert.ok(index >= 0, `the painted row carries ${label}`);
  return { x: visibleWidth(lines[y].slice(0, index)), y };
}

/** One native SGR primary click: press and release on the same cell. */
function click(fx, point) {
  fx.send(0, point.x, point.y);
  fx.send(0, point.x, point.y, true);
}

/** A native press that leaves the control before release: never a click. */
function pressDragAway(fx, from, to) {
  fx.send(0, from.x, from.y);
  fx.send(32, to.x, to.y);
  fx.send(0, to.x, to.y, true);
}

/** A native press whose release moved to another cell with no drag report. */
function pressReleaseElsewhere(fx, from, to) {
  fx.send(0, from.x, from.y);
  fx.send(0, to.x, to.y, true);
}

for (const labels of [true, false]) {
  const placement = labels ? "border labels on" : "border labels off";

  test(`Stats: a native click on the top tab row switches tabs (${placement})`, async (t) => {
    setBorderLabelsEnabled(labels);
    t.after(() => setBorderLabelsEnabled(true));
    const fx = fixture(t);
    const panel = statsPanel(fx, { snapshot: () => tallStatsSnapshot() });
    t.after(() => panel.dispose());

    let lines = painted(fx);
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    assert.ok(
      lines.some((line) => line.includes("›1 Overview‹")),
      "the painted tab marker starts on Overview",
    );
    assert.ok(
      !lines.some((line) => line.includes("model-00")),
      "the Overview is not the model table",
    );

    click(fx, locate(lines, "2 Models"));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("›2 Models‹")),
      "the painted tab marker moved to Models",
    );
    assert.ok(
      lines.some((line) => line.includes("model-00")),
      "the Models rows are painted",
    );
    await assertRetired(fx, fx.copied.length, "Stats Models click");

    click(fx, locate(lines, "3 Tools"));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("›3 Tools‹")),
      "the painted tab marker moved to Tools",
    );
    await assertRetired(fx, fx.copied.length, "Stats Tools click");

    click(fx, locate(lines, "1 Overview"));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("›1 Overview‹")),
      "the painted tab marker returned to Overview",
    );
    assert.ok(
      lines.some((line) => line.includes("Busy")),
      "the Overview rows are painted again",
    );
    await assertRetired(fx, fx.copied.length, "Stats Overview click");
  });

  test(`Context: a native click on the title tab row switches tabs (${placement})`, async (t) => {
    setBorderLabelsEnabled(labels);
    t.after(() => setBorderLabelsEnabled(true));
    const fx = fixture(t);
    const snapshot = tallContextSnapshot();
    const panel = contextPanel(fx, { snapshot: () => snapshot });
    t.after(() => panel.dispose());

    let lines = painted(fx);
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    assert.ok(
      lines.some((line) => line.includes("System")),
      "the System tab is painted",
    );
    assert.ok(
      lines.some((line) => line.includes("Messages")),
      "the Messages tab is painted",
    );
    assert.ok(!lines.some((line) => line.includes("›")), "the overview has no selected tab marker");

    click(fx, locate(lines, "Messages"));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("›Messages‹")),
      "the painted tab marker moved to Messages",
    );
    assert.ok(
      lines.some((line) => line.includes("Msg item 1")),
      "the Messages rows are painted",
    );
    assert.ok(!lines.some((line) => line.includes("Sys item 1")), "the System rows are gone");
    await assertRetired(fx, fx.copied.length, "Context Messages click");

    click(fx, locate(lines, "System"));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("›System‹")),
      "the painted tab marker moved to System",
    );
    assert.ok(
      lines.some((line) => line.includes("Sys item 1")),
      "the System rows are painted",
    );
    await assertRetired(fx, fx.copied.length, "Context System click");

    // The title itself is a control: it returns to the overview.
    click(fx, locate(lines, "Context"));
    lines = painted(fx);
    assert.ok(
      !lines.some((line) => line.includes("›System‹") || line.includes("›Messages‹")),
      "the title click cleared the selected tab marker",
    );
    assert.ok(
      lines.some((line) => line.includes("Msg item 1")),
      "the overview shows every category",
    );
    await assertRetired(fx, fx.copied.length, "Context title click");

    // Row targets also extend into x=1, outside the inset-2 selectable text.
    // The owned empty gutter gesture must still open the row's detail page.
    click(fx, { ...locate(lines, "Sys item 1"), x: bounds.col + 1 });
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("Source Sys item 1")),
      "the row detail is painted",
    );
    assert.ok(
      lines.some((line) => line.includes("SDK allocation")),
      "the detail metadata is painted",
    );
    await assertRetired(fx, fx.copied.length, "Context row click");
  });

  test(`Context: native footer clicks page and open the estimate note (${placement})`, async (t) => {
    setBorderLabelsEnabled(labels);
    t.after(() => setBorderLabelsEnabled(true));
    const fx = fixture(t);
    const snapshot = tallContextSnapshot();
    const panel = contextPanel(fx, { snapshot: () => snapshot });
    t.after(() => panel.dispose());

    let lines = painted(fx);
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    const rect = bodyRect("Context", bounds);
    assert.ok(rect, "the painted body rectangle is non-empty");
    const pagerRow = () => {
      const row = lines.findIndex((line) => line.includes("Next") || line.includes("Prev"));
      assert.ok(row >= 0, "the painted pager row exists");
      return row;
    };

    // Eight rows against a five-row viewport: the first page offers only Next.
    let row = pagerRow();
    assert.ok(lines[row].includes("Next"), "the first page offers Next");
    assert.ok(!lines[row].includes("Prev"), "the first page has no Prev");
    const firstBody = expectedBodyText(lines, bounds, rect);
    assert.ok(firstBody.includes("Sys item 1"), "the first window starts at the first row");
    assert.ok(!firstBody.includes("Msg item 2"), "the first window stops before Msg item 2");

    click(fx, locate(lines, "Next", row));
    lines = painted(fx);
    row = pagerRow();
    assert.ok(lines[row].includes("Prev"), "the last page offers Prev");
    assert.ok(!lines[row].includes("Next"), "the last page has no Next");
    const lastBody = expectedBodyText(lines, bounds, rect);
    assert.notEqual(lastBody, firstBody, "the pager really moved the painted rows");
    assert.ok(lastBody.includes("Msg item 4"), "the last window reaches Msg item 4");
    assert.ok(!lastBody.includes("Sys item 1"), "the last window starts after Sys item 1");
    await assertRetired(fx, fx.copied.length, "Context Next click");

    click(fx, locate(lines, "Prev", row));
    lines = painted(fx);
    row = pagerRow();
    assert.ok(lines[row].includes("Next"), "Prev returned to the first page");
    assert.equal(
      expectedBodyText(lines, bounds, rect),
      firstBody,
      "the first window is painted again",
    );
    await assertRetired(fx, fx.copied.length, "Context Prev click");

    // The whole estimate qualifier is the note target.
    click(fx, locate(lines, "proportional", row));
    lines = painted(fx);
    assert.ok(
      lines.some((line) => line.includes("Estimation note")),
      "the note page is painted",
    );
    const noteBody = expectedBodyText(lines, bounds, rect);
    assert.ok(noteBody.includes("Allocation: proportional"), "the note explains the estimate");
    assert.ok(noteBody.includes("Estimates only"), "the note text is painted");
    await assertRetired(fx, fx.copied.length, "Context estimate click");
  });

  test(`Stats: chrome presses, drags and multi-clicks never select, copy or switch (${placement})`, async (t) => {
    setBorderLabelsEnabled(labels);
    t.after(() => setBorderLabelsEnabled(true));
    const fx = fixture(t);
    const panel = statsPanel(fx, { snapshot: () => tallStatsSnapshot() });
    t.after(() => panel.dispose());

    let lines = painted(fx);
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    const body = { x: bounds.col + 6, y: bounds.row + bounds.height - 4 };
    const marker = () => painted(fx).find((line) => line.includes("›"));
    const chrome = [
      locate(lines, "Stats"), // title edge
      locate(lines, "2 Models"), // tab row
      locate(lines, "Tab view"), // footer edge
    ];
    for (const point of chrome) {
      pressDragAway(fx, point, body);
      assert.equal(
        fx.tui.hasActiveSelection(),
        false,
        `a drag from chrome row ${point.y} starts no selection`,
      );
      assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "nothing to copy");
      assert.equal(fx.copied.length, 0, "no clipboard write");
      assert.ok(marker().includes("›1 Overview‹"), "the tab never changed");
    }

    // A quick double click on the frame is still chrome: no selection, no tab.
    const corner = { x: bounds.col + 1, y: bounds.row };
    click(fx, corner);
    click(fx, corner);
    assert.equal(fx.tui.hasActiveSelection(), false, "a chrome multi-click starts no selection");
    assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "there is nothing to copy");
    assert.equal(fx.copied.length, 0, "no clipboard write happened");
    assert.ok(marker().includes("›1 Overview‹"), "the multi-click never changed the tab");

    // A moved release with no intervening drag report is not a click on the
    // cell it lands on: it must not switch to the other tab or select chrome.
    lines = painted(fx);
    pressReleaseElsewhere(fx, locate(lines, "2 Models"), locate(lines, "3 Tools"));
    assert.equal(fx.tui.hasActiveSelection(), false, "a moved release starts no selection");
    assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "nothing to copy");
    assert.equal(fx.copied.length, 0, "no clipboard write");
    assert.ok(marker().includes("›1 Overview‹"), "the moved release never switched tabs");

    // The pinned chrome gesture must not poison a later body drag.
    lines = painted(fx);
    const rect = bodyRect("Stats", panel.handle.getBounds());
    assert.ok(rect, "the painted body rectangle is non-empty");
    const copied = await dragBody(fx, panel.handle.getBounds(), rect);
    assert.equal(copied, true, "a later body drag still copies");
    assert.equal(
      fx.copied.at(-1),
      expectedBodyText(lines, panel.handle.getBounds(), rect),
      "the body drag copies only the painted body",
    );
  });

  test(`Context: chrome presses, drags and multi-clicks never select, copy or act (${placement})`, async (t) => {
    setBorderLabelsEnabled(labels);
    t.after(() => setBorderLabelsEnabled(true));
    const fx = fixture(t);
    const snapshot = tallContextSnapshot();
    const panel = contextPanel(fx, { snapshot: () => snapshot });
    t.after(() => panel.dispose());

    let lines = painted(fx);
    const bounds = panel.handle.getBounds();
    assert.ok(bounds, "the overlay painted visible bounds");
    const rect = bodyRect("Context", bounds);
    assert.ok(rect, "the painted body rectangle is non-empty");
    const body = { x: bounds.col + 6, y: bounds.row + rect.y + 1 };
    const firstBody = expectedBodyText(lines, bounds, rect);
    const chrome = [
      locate(lines, "Context"), // title edge
      locate(lines, "Messages"), // tab row
      locate(lines, "Next"), // footer edge
    ];
    for (const point of chrome) {
      pressDragAway(fx, point, body);
      assert.equal(
        fx.tui.hasActiveSelection(),
        false,
        `a drag from chrome row ${point.y} starts no selection`,
      );
      assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "nothing to copy");
      assert.equal(fx.copied.length, 0, "no clipboard write");
      lines = painted(fx);
      assert.ok(!lines.some((line) => line.includes("›")), "the tab never changed");
      assert.equal(
        expectedBodyText(lines, bounds, rect),
        firstBody,
        "the pager never moved and the overview is unchanged",
      );
    }

    // A quick double click on the frame is still chrome: no selection, no page.
    const corner = { x: bounds.col + 1, y: bounds.row };
    click(fx, corner);
    click(fx, corner);
    assert.equal(fx.tui.hasActiveSelection(), false, "a chrome multi-click starts no selection");
    assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "there is nothing to copy");
    assert.equal(fx.copied.length, 0, "no clipboard write happened");
    lines = painted(fx);
    assert.equal(expectedBodyText(lines, bounds, rect), firstBody, "the multi-click never paged");

    // A moved release with no intervening drag report is not a click on the
    // cell it lands on: no tab switch, no page and no selection.
    pressReleaseElsewhere(fx, locate(lines, "Messages"), locate(lines, "System"));
    assert.equal(fx.tui.hasActiveSelection(), false, "a moved release starts no selection");
    assert.equal(await fx.tui.copyActiveSelectionToClipboard(), false, "nothing to copy");
    assert.equal(fx.copied.length, 0, "no clipboard write");
    lines = painted(fx);
    assert.ok(!lines.some((line) => line.includes("›")), "the moved release never switched tabs");
    assert.equal(expectedBodyText(lines, bounds, rect), firstBody, "the moved release never paged");

    // The pinned chrome gesture must not poison a later body drag.
    lines = painted(fx);
    const expected = expectedBodyText(lines, panel.handle.getBounds(), rect);
    const copied = await dragBody(fx, panel.handle.getBounds(), rect);
    assert.equal(copied, true, "a later body drag still copies");
    assert.equal(fx.copied.at(-1), expected, "the body drag copies only the painted body");
  });
}
