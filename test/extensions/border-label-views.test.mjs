// Focused border-label layout regressions for the Context and Stats views.
// Direct source via jiti: no generated runtime, build, sessions, providers or
// network. The shared chrome state lives behind a process-wide symbol, so the
// test toggles the same switch the views subscribe to.
import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  borderLabelsEnabled,
  onBorderLabelsChange,
  popoverChromeCloseHit,
  setBorderLabelsEnabled,
} from "../../src/shared/popover-chrome.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { ContextView } = await jiti.import("../../src/extensions/lib/context-view.ts");
const { StatsView } = await jiti.import("../../src/extensions/lib/stats-view.ts");

const theme = { fg: (_tone, text) => text, bold: (text) => text, bg: (_tone, text) => text };

/** A pure rule edge or divider: no label, tab, close or figure anywhere. */
const isBareRule = (line, left, right) => {
  const text = plain(line);
  return (
    text.length > 0 &&
    text[0] === left &&
    text[text.length - 1] === right &&
    text
      .slice(1, -1)
      .split("")
      .every((character) => character === "─")
  );
};
const bareTop = (line) => isBareRule(line, "╭", "╮");
const bareBottom = (line) => isBareRule(line, "╰", "╯");
const bareDivider = (line) => isBareRule(line, "├", "┤");
/** Column of a glyph inside a plain-rendered row. */
const columnOf = (rows, y, text) => plain(rows[y]).indexOf(text);
const click = (view, x, y, width = 80) =>
  view.handleMouse({ type: "click", button: "left", x, y, width });
const press = (view, x, y, width = 80) =>
  view.handleMouse({ type: "press", button: "left", x, y, width });
const release = (view, x, y, width = 80) =>
  view.handleMouse({ type: "release", button: "left", x, y, width });

const CATEGORIES = ["system", "summary", "messages", "tools", "other"];
const contextSnapshot = (items = 12) => ({
  usage: { tokens: 5000, contextWindow: 10000, percent: 50 },
  rawTokens: 10000,
  categories: CATEGORIES.map((id) => ({ id, label: id, rawTokens: 2000, tokens: 1000, count: 1 })),
  items: Array.from({ length: items }, (_, index) => ({
    id: `item:${index}`,
    category: CATEGORIES[index % 4],
    label: `source ${index}`,
    kind: "metadata",
    rawTokens: 2000,
    tokens: 1000,
    count: 1,
    rawState: "estimate",
    detail: ["Safe metadata"],
  })),
  allocation: "proportional",
  attribution: "complete",
  replay: "selected",
  note: "proportional estimates",
});

function mountContext({ rows = 30, items = 12, focused = true } = {}) {
  let renders = 0;
  let closes = 0;
  const data = contextSnapshot(items);
  const view = new ContextView({
    theme,
    snapshot: () => data,
    availableRows: () => rows,
    requestRender: () => renders++,
    close: () => closes++,
    isFocused: () => focused,
  });
  return { view, renders: () => renders, closes: () => closes };
}

const models = Array.from({ length: 20 }, (_, index) => ({
  model: `m${index}`,
  provider: "p",
  requests: 2,
  errors: index % 3 === 0 ? 1 : 0,
  outputTokens: 10,
  cost: 0.1,
  llmMs: 100,
  tps: 5,
  ttftMs: 10,
  ttftSamples: 1,
}));
const tools = Array.from({ length: 8 }, (_, index) => ({
  tool: `tool${index}`,
  calls: 3,
  errors: 0,
  totalMs: 100,
  maxMs: 20,
}));
const statsSnapshot = () => ({
  health: "busy",
  elapsedMs: 60000,
  busyMs: 1000,
  idleMs: 2000,
  llmMs: 3000,
  toolMs: 400,
  approvalMs: 50,
  activeRequests: 1,
  activeTools: 0,
  pendingApprovals: 0,
  lastActivityMs: 5000,
  lastTtftMs: 100,
  lastTextMs: 900,
  lastTps: 12.5,
  partial: true,
  models,
  tools,
  recentErrors: [{ ageMs: 4000, provider: "p", model: "m0", message: "boom", cleared: false }],
});

function mountStats(rows = 24) {
  let renders = 0;
  let closes = 0;
  const terminal = { rows };
  const view = new StatsView({
    tui: { terminal, requestRender: () => renders++ },
    theme,
    snapshot: statsSnapshot,
    close: () => closes++,
  });
  return {
    view,
    renders: () => renders,
    closes: () => closes,
    setRows: (next) => {
      terminal.rows = next;
    },
  };
}

test("popoverChromeCloseHit keeps the glyph column and moves only its row", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, width: 1, y: 0 });
  setBorderLabelsEnabled(false);
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, width: 1, y: 1 });
  assert.equal(popoverChromeCloseHit(8), undefined);
  assert.equal(popoverChromeCloseHit(0), undefined);
  setBorderLabelsEnabled(true);
});

test("onBorderLabelsChange notifies only actual changes and unsubscribes", () => {
  setBorderLabelsEnabled(true);
  let calls = 0;
  const unsubscribe = onBorderLabelsChange(() => calls++);
  setBorderLabelsEnabled(false);
  setBorderLabelsEnabled(false); // same value: no notification
  assert.equal(calls, 1);
  setBorderLabelsEnabled(true);
  assert.equal(calls, 2);
  unsubscribe();
  unsubscribe(); // idempotent
  setBorderLabelsEnabled(false);
  assert.equal(calls, 2);
  setBorderLabelsEnabled(true);
});

test("context ON baseline keeps border labels and byte geometry", () => {
  setBorderLabelsEnabled(true);
  const { view, closes } = mountContext();
  const rows = view.render(80);
  assert.equal(rows.length, 9);
  assert.ok(plain(rows[0]).includes("Context"));
  assert.ok(plain(rows[0]).includes("System"));
  assert.equal(columnOf(rows, 0, "✕"), 76);
  // Close activates at the border row when labels are on.
  press(view, 76, 0);
  release(view, 76, 0);
  assert.equal(closes(), 1);
  view.dispose();
});

test("context OFF moves all chrome off the border lines", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountContext();
  const rows = view.render(80);
  assert.equal(rows.length, 13);
  assert.ok(bareTop(rows[0]));
  assert.ok(bareDivider(rows[2]));
  assert.ok(bareDivider(rows[10]));
  assert.ok(bareBottom(rows[12]));
  for (const [y, row] of rows.entries()) assert.equal(visibleWidth(row), 80, `row ${y}`);
  // The label row carries title, tabs and the close glyph at the shared column.
  const label = plain(rows[1]);
  assert.equal(label.indexOf("Context"), 3);
  assert.ok(label.includes("System"));
  assert.equal(columnOf(rows, 1, "✕"), 76);
  // Content keeps its interior rows: bar, header and table.
  assert.ok(plain(rows[3]).includes("5.0k/10k"));
  assert.ok(plain(rows[4]).includes("Source"));
  assert.ok(plain(rows[5]).includes("Other (unattributed)"));
  assert.ok(plain(rows[6]).includes("source 0"));
  // The pager label row sits above the bare bottom edge.
  assert.ok(plain(rows[11]).includes("1-5/13"));
  view.dispose();
});

test("context OFF close target lives on the inset label row only", () => {
  setBorderLabelsEnabled(false);
  const { view, closes } = mountContext();
  view.render(80);
  // The old border-row position is inert when labels are off.
  click(view, 76, 0);
  assert.equal(closes(), 0);
  press(view, 76, 1);
  release(view, 76, 1);
  assert.equal(closes(), 1);
  view.dispose();
});

test("context OFF tab and title targets follow the inset label row", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountContext();
  view.render(80);
  const systemX = columnOf(view.render(80), 1, "System");
  click(view, systemX, 1);
  const selected = view.render(80).map(plain);
  assert.ok(selected[1].includes("›System‹"), "tab click selects");
  // The title target resets the selection back to the overview.
  click(view, 3, 1);
  const overview = view.render(80).map(plain);
  assert.ok(!overview[1].includes("›System‹"), "title click resets");
  view.dispose();
});

test("context OFF body rows open details at their shifted coordinates", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountContext();
  view.render(80);
  click(view, 2, 6);
  const detail = view.render(80).map(plain);
  assert.ok(detail[4].includes("source 0"), "detail label row moved below the band");
  assert.ok(detail.some((row) => row.includes("Source source 0")));
  // Escape returns to the table; the body target works again after repaint.
  view.handleInput("\x1b");
  click(view, 2, 7);
  assert.ok(view.render(80).some((row) => plain(row).includes("source 1")));
  view.dispose();
});

test("context OFF pager and note targets sit on the footer label row", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountContext();
  view.render(80);
  const pager = view.render(80).map(plain);
  const nextX = columnOf(pager, 11, "Next");
  assert.ok(nextX > 0, "next pager painted");
  click(view, nextX, 11);
  const scrolled = view.render(80).map(plain);
  assert.ok(scrolled[11].includes("6-10/13"), "next page target");
  const prevX = columnOf(scrolled, 11, "Prev");
  click(view, prevX, 11);
  assert.ok(view.render(80).map(plain)[11].includes("1-5/13"), "prev page target");
  // The estimate qualifier remains a note-page target on the label row.
  const noteX = columnOf(scrolled, 11, "≈");
  click(view, noteX, 11);
  assert.ok(
    view
      .render(80)
      .map(plain)
      .some((row) => row.includes("Estimation note")),
  );
  view.dispose();
});

test("context OFF width bound falls back to a text-free readonly frame", () => {
  setBorderLabelsEnabled(false);
  const { view, closes } = mountContext();
  const narrow = view.render(27);
  assert.equal(narrow.length, 3);
  assert.ok(bareTop(narrow[0]));
  assert.ok(bareBottom(narrow[2]));
  assert.ok(plain(narrow[1]).includes("Context"), "readonly fallback text row");
  // No close, tab, row or footer targets exist in the fallback.
  click(view, 23, 0);
  click(view, 5, 1);
  assert.equal(closes(), 0);
  const full = view.render(28);
  assert.equal(full.length, 13);
  assert.ok(plain(full[1]).includes("Context"));
  view.dispose();
});

test("context OFF height bounds: full frame from 10 rows, minimal below", () => {
  setBorderLabelsEnabled(false);
  const full = mountContext({ rows: 10 });
  const fullRows = full.view.render(80);
  assert.equal(fullRows.length, 10);
  assert.ok(bareTop(fullRows[0]));
  assert.ok(bareBottom(fullRows[9]));
  assert.ok(plain(fullRows[1]).includes("Context"));
  full.view.dispose();

  const compact = mountContext({ rows: 9 });
  const compactRows = compact.view.render(80);
  assert.equal(compactRows.length, 3);
  assert.ok(bareTop(compactRows[0]));
  assert.ok(bareBottom(compactRows[2]));
  compact.view.dispose();

  const clipped = mountContext({ rows: 2 });
  const clippedRows = clipped.view.render(80);
  assert.equal(clippedRows.length, 1);
  assert.ok(plain(clippedRows[0]).includes("readonly"));
  clipped.view.dispose();
});

test("context stale targets die with the border-label switch until repaint", () => {
  setBorderLabelsEnabled(true);
  const { view, renders } = mountContext();
  view.render(80);
  const before = renders();
  setBorderLabelsEnabled(false);
  assert.ok(renders() > before, "the switch requests a repaint");
  // Old border-row coordinates and keyboard activation are inert pre-repaint.
  click(view, 12, 0);
  view.handleInput("\r");
  const afterToggle = view.render(80).map(plain);
  assert.ok(!afterToggle[1].includes("›System‹"), "stale tab click did nothing");
  assert.ok(!afterToggle.some((row) => row.includes("Source source")), "stale enter did nothing");
  // After the repaint the same intent works at the new coordinates.
  const systemX = columnOf(afterToggle, 1, "System");
  click(view, systemX, 1);
  assert.ok(view.render(80).map(plain)[1].includes("›System‹"));
  view.dispose();
});

test("context OFF round trip restores the ON layout byte for byte", () => {
  setBorderLabelsEnabled(true);
  const baseline = mountContext();
  const expected = baseline.view.render(80);
  setBorderLabelsEnabled(false);
  const off = mountContext();
  off.view.render(80);
  off.view.dispose();
  setBorderLabelsEnabled(true);
  const restored = baseline.view.render(80);
  assert.deepEqual(restored, expected);
  baseline.view.dispose();
});

test("stats ON baseline keeps the border title, tabs and footer inlay", () => {
  setBorderLabelsEnabled(true);
  const { view, closes } = mountStats();
  const rows = view.render(80);
  assert.equal(rows.length, 18);
  assert.ok(plain(rows[0]).includes("Stats · main session + managed workers"));
  assert.equal(columnOf(rows, 0, "✕"), 76);
  assert.ok(plain(rows[1]).includes("1 Overview"));
  assert.ok(bareDivider(rows[2]));
  assert.ok(plain(rows[rows.length - 1]).includes("Esc"));
  press(view, 76, 0);
  release(view, 76, 0);
  assert.equal(closes(), 1);
  view.dispose();
});

test("stats OFF moves title, close and hints off the border lines", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountStats();
  const rows = view.render(80);
  assert.equal(rows.length, 18, "the frame still fits the 75% budget");
  const height = rows.length;
  assert.ok(bareTop(rows[0]));
  assert.ok(bareDivider(rows[2]));
  assert.ok(bareDivider(rows[4]));
  assert.ok(bareDivider(rows[height - 3]));
  assert.ok(bareBottom(rows[height - 1]));
  for (const [y, row] of rows.entries()) assert.equal(visibleWidth(row), 80, `row ${y}`);
  // Title and close moved to the inset label row; the interior tab row stayed.
  const title = plain(rows[1]);
  assert.equal(title.indexOf("Stats"), 3);
  assert.equal(columnOf(rows, 1, "✕"), 76);
  assert.ok(plain(rows[3]).includes("1 Overview"));
  // The footer hint and line counter moved above the bare bottom edge.
  const footer = plain(rows[height - 2]);
  assert.ok(footer.includes("Esc"));
  assert.ok(footer.includes("lines"), "scroll counter on the label row");
  view.dispose();
});

test("stats OFF close and tab targets follow the shifted rows", () => {
  setBorderLabelsEnabled(false);
  const { view, closes } = mountStats();
  view.render(80);
  click(view, 76, 0); // old border-row position is inert
  assert.equal(closes(), 0);
  press(view, 76, 1);
  release(view, 76, 1);
  assert.equal(closes(), 1);

  const tabs = mountStats();
  tabs.view.render(80);
  click(tabs.view, columnOf(tabs.view.render(80), 3, "2 Models"), 3);
  const selected = tabs.view.render(80).map(plain);
  assert.ok(selected[3].includes("›2 Models‹"), "tab click selects");
  // The footer label row owns no hit targets.
  click(tabs.view, 10, selected.length - 2);
  assert.ok(tabs.view.render(80).map(plain)[3].includes("›2 Models‹"));
  tabs.view.dispose();
  view.dispose();
});

test("stats OFF scrolls by wheel after the repaint", () => {
  setBorderLabelsEnabled(false);
  const { view } = mountStats();
  view.render(80);
  view.handleInput("2"); // Models tab is taller than the viewport
  const before = view.render(80).map(plain);
  view.handleMouse({ type: "wheel", wheelDelta: 4, width: 80 });
  const after = view.render(80).map(plain);
  assert.notEqual(before[5], after[5], "wheel scrolls the OFF frame");
  assert.ok(after[after.length - 2].includes("lines"));
  view.dispose();
});

test("stats OFF compact bounds frame full bands, then a readonly minimal frame", () => {
  setBorderLabelsEnabled(false);
  // budget 8: both inset bands plus the tab row and the shortness message.
  const rich = mountStats(11);
  const richRows = rich.view.render(80);
  assert.equal(richRows.length, 8);
  assert.ok(bareTop(richRows[0]));
  assert.ok(plain(richRows[1]).includes("Stats"));
  assert.ok(plain(richRows[3]).includes("1 Overview"));
  assert.ok(
    richRows.includes("Terminal too short for Stats") ||
      richRows.some((r) => plain(r).includes("Terminal too short")),
  );
  assert.ok(bareBottom(richRows[7]));
  press(rich.view, 76, 1);
  release(rich.view, 76, 1);
  assert.equal(rich.closes(), 1, "close works when the title band is painted");
  rich.view.dispose();

  // budget 6: both bands, no interior rows.
  const bands = mountStats(8);
  const bandRows = bands.view.render(80);
  assert.equal(bandRows.length, 6);
  assert.ok(bareTop(bandRows[0]));
  assert.ok(plain(bandRows[1]).includes("Stats"));
  assert.ok(bareBottom(bandRows[5]));
  bands.view.dispose();

  // budget 5..3: readonly minimal frame, no partial inset, no close glyph.
  for (const term of [7, 6, 5]) {
    const tiny = mountStats(term);
    const tinyRows = tiny.view.render(80);
    assert.equal(tinyRows.length, 3, `term ${term}`);
    assert.ok(bareTop(tinyRows[0]));
    assert.ok(plain(tinyRows[1]).includes("Terminal too short for Stats"));
    assert.ok(bareBottom(tinyRows[2]));
    click(tiny.view, 76, 1);
    assert.equal(tiny.closes(), 0, "no invisible close control");
    tiny.view.dispose();
  }

  // budget 2..1: a single clipped text row, like the Context fallback.
  for (const term of [3, 2]) {
    const row = mountStats(term);
    const rows = row.view.render(80);
    assert.equal(rows.length, 1);
    assert.ok(plain(rows[0]).includes("Terminal too short for Stats"));
    row.view.dispose();
  }
  setBorderLabelsEnabled(true);
});

test("stats compact leaves no phantom tab targets on dropped rows", () => {
  // A dropped tab row must not publish targets for whatever row the budget
  // paints in its place. Selection state is verified by expanding the
  // terminal and reading the real tab row, not private fields.
  const stillOverview = (row) => {
    assert.ok(row.includes("›1 Overview‹"), "overview still selected");
    assert.ok(!row.includes("›3 Tools‹"), "phantom click selected nothing");
  };

  setBorderLabelsEnabled(true);
  // ON budget 1 and 2: only the frame fits; the tab row is dropped. The old
  // code left its targets on the bottom edge (budget 2) or beyond the panel.
  for (const [term, painted] of [
    [2, 1],
    [3, 2],
  ]) {
    const hidden = mountStats(term);
    const rows = hidden.view.render(80);
    assert.equal(rows.length, painted, `term ${term} paints ${painted} rows`);
    click(hidden.view, 24, 1); // "3 Tools" column on a painted tab row
    hidden.setRows(24);
    stillOverview(hidden.view.render(80).map(plain)[1]);
    hidden.view.dispose();
  }
  // ON budget 3: the smallest frame that paints the tab row keeps it live.
  const visible = mountStats(4);
  const visibleRows = visible.view.render(80);
  assert.equal(visibleRows.length, 3);
  click(visible.view, columnOf(visibleRows, 1, "2 Models"), 1);
  visible.setRows(24);
  assert.ok(visible.view.render(80).map(plain)[1].includes("›2 Models‹"));
  visible.view.dispose();

  setBorderLabelsEnabled(false);
  // OFF budget 6: both inset bands fill the frame and the tab row is dropped;
  // its would-be column lands on the bottom band's separator.
  const offHidden = mountStats(8);
  const offHiddenRows = offHidden.view.render(80);
  assert.equal(offHiddenRows.length, 6);
  assert.ok(bareDivider(offHiddenRows[3]), "no tab row painted at y=3");
  click(offHidden.view, 24, 3);
  offHidden.setRows(24);
  stillOverview(offHidden.view.render(80).map(plain)[3]);
  offHidden.view.dispose();
  // OFF budget 5: the readonly minimal frame paints no tab row either.
  const offTiny = mountStats(7);
  assert.equal(offTiny.view.render(80).length, 3);
  click(offTiny.view, 24, 1);
  offTiny.setRows(24);
  stillOverview(offTiny.view.render(80).map(plain)[3]);
  offTiny.view.dispose();
  // OFF budget 7: the smallest OFF frame that paints the tab row keeps it live.
  const offVisible = mountStats(10);
  const offVisibleRows = offVisible.view.render(80);
  assert.equal(offVisibleRows.length, 7);
  click(offVisible.view, columnOf(offVisibleRows, 3, "2 Models"), 3);
  offVisible.setRows(24);
  assert.ok(offVisible.view.render(80).map(plain)[3].includes("›2 Models‹"));
  offVisible.view.dispose();
  setBorderLabelsEnabled(true);
});

test("stats ON compact keeps its border-labeled frame", () => {
  setBorderLabelsEnabled(true);
  const { view } = mountStats(6); // budget 4
  const rows = view.render(80);
  assert.equal(rows.length, 4);
  assert.ok(plain(rows[0]).includes("Stats · main session + managed workers"));
  assert.ok(plain(rows[1]).includes("1 Overview"));
  assert.ok(plain(rows[3]).includes("Esc"));
  view.dispose();
});

test("stats stale targets die with the border-label switch until repaint", () => {
  setBorderLabelsEnabled(true);
  const { view, renders } = mountStats();
  view.render(80);
  view.handleInput("2"); // Models tab, taller than the viewport
  view.render(80);
  view.handleMouse({ type: "wheel", wheelDelta: 3, width: 80 });
  const scrolled = view.render(80).map(plain);
  const before = renders();
  setBorderLabelsEnabled(false);
  assert.ok(renders() > before, "the switch requests a repaint");
  // Old tab-row coordinates are inert pre-repaint.
  click(view, columnOf(scrolled, 1, "2 Models"), 1);
  // A wheel over retired geometry cannot keep the old scroll either.
  view.handleMouse({ type: "wheel", wheelDelta: 5, width: 80 });
  const after = view.render(80).map(plain);
  assert.ok(after[3].includes("1 Overview"), "stale tab click did nothing");
  assert.ok(after[3].includes("2 Models"), "tab selection unchanged");
  assert.ok(after[5].includes("Model"), "scroll reset to the top of the retired layout");
  // After the repaint the tab row lives at its new coordinate.
  click(view, columnOf(after, 3, "2 Models"), 3);
  assert.ok(view.render(80).map(plain)[3].includes("›2 Models‹"));
  view.dispose();
});

test("views stop observing the switch after dispose", () => {
  setBorderLabelsEnabled(true);
  const context = mountContext();
  context.view.render(80);
  context.view.dispose();
  const stats = mountStats();
  stats.view.render(80);
  stats.view.dispose();
  const beforeContext = context.renders();
  const beforeStats = stats.renders();
  setBorderLabelsEnabled(false);
  setBorderLabelsEnabled(true);
  assert.equal(context.renders(), beforeContext, "context unsubscribed");
  assert.equal(stats.renders(), beforeStats, "stats unsubscribed");
});
