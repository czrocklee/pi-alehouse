// Source-loaded panel regressions: no generated runtime, sessions, providers,
// host UI, network or publication.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import * as tuiSdk from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const { visibleWidth } = tuiSdk;
let finalFits;
// Use the normal source loader, observing only the SDK boundary. The final
// row fit uses an empty ellipsis; title/key fits use a nonempty one.
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: true,
  virtualModules: {
    "@earendil-works/pi-tui": {
      ...tuiSdk,
      truncateToWidth(input, width, ellipsis, pad) {
        const fitted = tuiSdk.truncateToWidth(input, width, ellipsis, pad);
        if (ellipsis === "") finalFits?.push({ input, width, fitted });
        return fitted;
      },
    },
  },
});
const { ApprovalPopover } = await jiti.import("../../src/extensions/lib/approval-view.ts");
const {
  breakdownChromeRows,
  breakdownFrame,
  breakdownTable,
  breakdownTitle,
  createBreakdownFramePainter,
} = await jiti.import("../../src/extensions/lib/footer-layout.ts");
const { createFooterPanels } = await jiti.import("../../src/extensions/lib/footer-panels.ts");
const { default: approvalMode } = await jiti.import("../../src/extensions/approval-mode.ts");
const { borderLabelsEnabled, popoverChromeCloseHit, setBorderLabelsEnabled } = await jiti.import(
  "../../src/shared/popover-chrome.mjs",
);
const { FOOTER_INDICATOR_CLICK_EVENT } = await import("../../src/shared/overlay-protocol.mjs");

const theme = {
  fg: (tone, text) => `\x1b[${tone === "accent" ? 36 : tone === "muted" ? 90 : 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  bg: (_tone, text) => `\x1b[44m${text}\x1b[0m`,
};
const choices = [
  { id: "manual", label: "manual", detail: "human approval" },
  { id: "yolo", label: "YOLO", detail: "session asks" },
];
const spendRow = {
  key: "anthropic/claude-sonnet",
  input: 1200,
  output: 200,
  cacheRead: 300,
  cacheWrite: 0,
  cost: 0.123,
};
const contextSnapshot = () => ({
  usage: { tokens: 100, contextWindow: 1000, percent: 10 },
  categories: [],
  items: [],
  allocation: "proportional",
  attribution: "complete",
  replay: "selected",
  rawTokens: 100,
  note: "estimates",
});

const withBorderLabels = (enabled) => {
  setBorderLabelsEnabled(enabled);
  return enabled;
};

function approvalFixture(width = 80) {
  let renders = 0;
  let closes = 0;
  const selected = [];
  const tui = {
    terminal: { columns: width, rows: 40 },
    requestRender() {
      renders++;
    },
  };
  const view = new ApprovalPopover({
    tui,
    theme,
    choices: () => choices,
    current: () => "manual",
    warning: (id) => (id === "yolo" ? ["Confirm wider approval"] : undefined),
    choose: (id) => selected.push(id),
    save: () => {},
    canSaveWorkspace: () => true,
    close: () => {
      closes++;
    },
    requestRender: () => tui.requestRender(),
  });
  return {
    view,
    tui,
    get renders() {
      return renders;
    },
    get closes() {
      return closes;
    },
    get selected() {
      return selected;
    },
  };
}

test("shared close hit stays put and moves from the border to the interior row", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  assert.equal(borderLabelsEnabled(), true);
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, width: 1, y: 0 });
  withBorderLabels(false);
  assert.equal(borderLabelsEnabled(), false);
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, width: 1, y: 1 });
});

test("approval keeps its geometry with labels on and inserts one top band with labels off", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const h = approvalFixture();
  t.after(() => h.view.dispose());
  const on = h.view.render(80);
  assert.equal(plain(on[0]).includes("Approval"), true);
  assert.equal(plain(on[0]).includes("✕"), true);
  assert.equal(plain(on[1]).includes("manual"), true, "choices follow the one-row title");

  withBorderLabels(false);
  const off = h.view.render(80);
  assert.equal(off.length, on.length + 2, "only the top band grows");
  assert.equal(plain(off[0]).includes("Approval"), false, "outer top frame loses the label");
  assert.match(plain(off[0]), /^╭─+╮$/);
  assert.equal(plain(off[1]).includes("Approval"), true, "title moves to the interior row");
  assert.equal(plain(off[1]).includes("✕"), true, "close moves with the title");
  assert.match(plain(off[2]), /^├─+┤$/);
  assert.equal(plain(off[3]).includes("manual"), true, "choices follow the three-row band");
  assert.equal(visibleWidth(off[1]), 80);
  for (const line of off) assert.equal(visibleWidth(line), 80);
});

test("labels off moves the close target to row 1 without a hidden hit on row 0", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(false);
  const h = approvalFixture();
  t.after(() => h.view.dispose());
  h.view.render(80);
  const hit = popoverChromeCloseHit(80);
  assert.equal(hit.y, 1);
  assert.deepEqual(h.view.handleMouse({ type: "click", button: "left", ...hit, width: 80 }), {
    handled: true,
  });
  assert.equal(h.closes, 1);
});

test("labels off never accepts the old border row as a close click", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(false);
  const h = approvalFixture();
  t.after(() => h.view.dispose());
  h.view.render(80);
  const hit = popoverChromeCloseHit(80);
  h.view.handleMouse({ type: "click", button: "left", width: 80, x: hit.x, y: 0 });
  assert.equal(h.closes, 0);
});

test("live approval views repaint when the switch flips and stop after teardown", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const h = approvalFixture();
  const on = h.view.render(80);
  const before = h.renders;
  withBorderLabels(false);
  assert.equal(h.renders, before + 1, "flag change repaints a live view");
  const off = h.view.render(80);
  assert.equal(off.length, on.length + 2);
  h.view.dispose();
  const afterDispose = h.renders;
  withBorderLabels(true);
  assert.equal(h.renders, afterDispose, "teardown unsubscribes the live listener");
});

test("usage breakdown title and chrome budget share the top band size", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  const table = breakdownTable([spendRow], 20);
  withBorderLabels(true);
  const onTitle = breakdownTitle(theme, 80);
  assert.equal(onTitle.length, 1);
  assert.equal(breakdownChromeRows(), 6);
  const onFrame = breakdownFrame(table, theme, 80);

  withBorderLabels(false);
  const offTitle = breakdownTitle(theme, 80);
  assert.equal(offTitle.length, 3);
  const offHover = breakdownTitle(theme, 80, true);
  assert.notDeepEqual(offHover, offTitle, "the close glyph still has a hover repaint");
  assert.equal(plain(offHover[1]).includes("✕"), true);
  assert.equal(breakdownChromeRows(), 8, "budget includes the two inserted rows");
  const offFrame = breakdownFrame(table, theme, 80);
  assert.equal(offFrame.length, onFrame.length + 2, "frame grows by exactly the band");
  assert.equal(plain(offFrame[0]).includes("usage by model"), false);
  assert.equal(plain(offFrame[1]).includes("usage by model"), true);
  assert.equal(plain(offFrame[1]).includes("✕"), true);
  assert.match(plain(offFrame[2]), /^├─+┤$/);
  for (const line of offFrame) assert.equal(visibleWidth(line), 80);
});

test("default usage titles retain their legacy narrow-width readability floor", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  for (let width = 8; width < 23; width++) {
    const [title] = breakdownTitle(theme, width).map(plain);
    assert.match(title, width >= 9 ? /^╭─+ ✕ ─╮$/ : /^╭─+╮$/);
    assert.equal(visibleWidth(title), width);
    assert.doesNotMatch(title, /usage|…/);
  }
  assert.match(plain(breakdownTitle(theme, 23)[0]), /usage by model/);
  withBorderLabels(false);
  assert.match(plain(breakdownTitle(theme, 20)[0]), /^╭─+╮$/);
  assert.match(plain(breakdownTitle(theme, 20)[1]), /usage/);
});

test("narrow widths keep exact line widths in both modes", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  const table = breakdownTable([spendRow], 20);
  for (const width of [1, 2, 3, 5, 6, 7, 8, 9, 12, 20]) {
    for (const enabled of [true, false]) {
      withBorderLabels(enabled);
      for (const line of breakdownTitle(theme, width)) assert.equal(visibleWidth(line), width);
      for (const line of breakdownFrame(table, theme, width))
        assert.equal(visibleWidth(line), width);
    }
  }
});

function footerFixture(spend = [spendRow], panelTheme = theme) {
  let renders = 0;
  const events = new EventEmitter();
  const listeners = new EventEmitter();
  const overlays = [];
  const tui = {
    mode: "fullscreen",
    terminal: { rows: 40, columns: 80 },
    requestRender() {
      renders++;
    },
    showOverlay(component, options) {
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return {
        hide() {
          entry.hidden = true;
        },
        isFocused: () => false,
        isHidden: () => entry.hidden,
        focus() {},
      };
    },
  };
  const on = (emitter) => (name, fn) => {
    emitter.on(name, fn);
    return () => emitter.off(name, fn);
  };
  const panels = createFooterPanels({
    pi: { events: { on: on(events) }, on: on(listeners) },
    ctx: { hasUI: true, ui: {} },
    tui,
    theme: panelTheme,
    spend: () => spend,
    contextSnapshot,
    compaction: () => undefined,
    currentFooter: () => true,
  });
  return {
    panels,
    overlays,
    tui,
    get renders() {
      return renders;
    },
    paint(width = 80) {
      return overlays.length ? overlays.at(-1).component.render(width) : [];
    },
  };
}

test("footer usage panel re-budgets and repaints on a live switch flip", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const h = footerFixture();
  t.after(() => h.panels.dispose(() => {}));
  h.panels.toggleBreakdown();
  const on = h.paint();
  const onRenders = h.renders;
  assert.equal(h.overlays.length, 1);

  withBorderLabels(false);
  assert.equal(h.renders, onRenders + 1, "open footer panel repaints on the switch");
  const off = h.paint();
  assert.equal(off.length, on.length + 2, "painted stack height tracks the new band");
  assert.equal(plain(off[0]).includes("usage by model"), false);
  assert.equal(plain(off[1]).includes("usage by model"), true);

  h.panels.dispose(() => {});
  const afterDispose = h.renders;
  withBorderLabels(true);
  assert.equal(h.renders, afterDispose, "footer teardown unsubscribes its listener");
});

test("repeated usage paints preserve exact styled bytes and follow live changes", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const spend = Array.from({ length: 8 }, (_, index) => ({
    ...spendRow,
    key: `fixture/\x1b]8;;https://example.invalid/\x1b\\模型 e\u0301 ${index} long label\x1b]8;;\x1b\\`,
  }));
  let accent = 36;
  const liveTheme = {
    ...theme,
    fg: (tone, text) =>
      tone === "accent" ? `\x1b[${accent}m${text}\x1b[0m` : theme.fg(tone, text),
  };
  const h = footerFixture(spend, liveTheme);
  t.after(() => h.panels.dispose(() => {}));
  h.panels.toggleBreakdown();
  const { component, options } = h.overlays[0];
  const checkPaint = () => {
    assert(options.visible());
    const { columns, rows } = h.tui.terminal;
    const width = Math.min(columns, options.width);
    const expected = breakdownFrame(
      breakdownTable(spend, rows - 1 - breakdownChromeRows()),
      liveTheme,
      width,
    );
    const actual = component.render(width);
    assert.deepEqual(actual, expected, "memoized paint must byte-match a fresh SDK fit");
    return actual;
  };
  const first = checkPaint();
  assert.notEqual(checkPaint(), first, "the returned render arrays are not reused");
  first[1] = "caller mutation";
  checkPaint();

  const oldTheme = checkPaint();
  accent = 35;
  assert.notDeepEqual(checkPaint(), oldTheme, "same theme object can produce new styling");
  const oldCost = checkPaint();
  spend[0].cost = 9.876;
  const newCost = checkPaint();
  assert.notDeepEqual(newCost, oldCost);
  assert.match(newCost.map(plain).join("\n"), /9\.876/);

  h.tui.terminal.columns = 25;
  h.tui.terminal.rows = 11;
  withBorderLabels(false);
  const small = checkPaint();
  assert.match(small.map(plain).join("\n"), /\+6 more/);
  assert(small.every((line) => visibleWidth(line) <= 25));
});

function traceFinalFits(paint) {
  const fits = [];
  finalFits = fits;
  try {
    return { lines: paint(), fits };
  } finally {
    finalFits = undefined;
  }
}

const linked = (text, path = "") =>
  `\x1b]8;;https://example.invalid/${path}\x1b\\${text}\x1b]8;;\x1b\\`;

test("usage panel clips styled overflow on a miss and reuses those exact bytes on a hit", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const spend = [{ ...spendRow, key: "fixture/e\u0301" }];
  const linkedTheme = {
    ...theme,
    fg: (tone, text) => (tone === "warning" ? linked(theme.fg(tone, text)) : theme.fg(tone, text)),
  };
  const h = footerFixture(spend, linkedTheme);
  t.after(() => h.panels.dispose(() => {}));
  h.tui.terminal.columns = 8;
  h.panels.toggleBreakdown();
  const paint = () => traceFinalFits(() => h.paint(h.tui.terminal.columns));

  const table = breakdownTable(spend, 20);
  const narrow = traceFinalFits(() => breakdownFrame(table, linkedTheme, 8));
  const model = narrow.fits[2];
  assert(visibleWidth(model.input) > 8, "the mandatory cost column overflows the raw row");
  assert.notEqual(model.fitted, model.input, "final clipping must actually change the bytes");
  assert.equal(visibleWidth(model.fitted), 8);

  assert.deepEqual(paint(), narrow, "cold paint uses the exact SDK fit");
  const warm = paint();
  assert.deepEqual(
    warm.lines,
    narrow.lines,
    "a cache hit must return the clipped bytes, not raw input",
  );
  assert.deepEqual(warm.fits, [], "an identical short frame skips all final fits");

  const wider = traceFinalFits(() => breakdownFrame(table, linkedTheme, 9));
  assert.equal(wider.fits[2].input, model.input, "resize leaves the raw model row unchanged");
  assert.notEqual(
    wider.lines[2],
    narrow.lines[2],
    "the same raw row clips differently at the new width",
  );
  h.tui.terminal.columns = 9;
  assert.deepEqual(paint(), wider, "resize refits even identical raw rows");
});

test("usage painter only reuses the first 32 rows of a stable frame", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const spend = Array.from({ length: 36 }, (_, i) => ({ ...spendRow, key: `fixture/model-${i}` }));
  const table = breakdownTable(spend, spend.length);
  const painter = createBreakdownFramePainter();
  const expected = traceFinalFits(() => breakdownFrame(table, theme, 80));
  assert(expected.fits.length > 32);
  assert(expected.fits.every(({ input, fitted }) => input.length <= 2048 && fitted.length <= 2048));
  assert.deepEqual(
    traceFinalFits(() => painter.paint(table, theme, 80)),
    expected,
  );

  const warm = traceFinalFits(() => painter.paint(table, theme, 80));
  assert.deepEqual(warm.lines, expected.lines, "uncached tail rows are still drawn normally");
  assert.deepEqual(
    warm.fits,
    expected.fits.slice(32),
    "index 31 is reused and index 32 is refitted",
  );
});

test("usage painter bounds both raw and fitted strings at 2048 UTF-16 units", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const table = breakdownTable([{ ...spendRow, key: "fixture/a" }], 1);
  const modelRow = 2;
  for (const [bounded, other, width] of [
    ["input", "fitted", 8],
    ["fitted", "input", 11],
  ]) {
    // To isolate the raw limit, put the long OSC bytes past the clip. To
    // isolate the fitted limit, keep the OSC bytes and clip just one plain
    // cell: the SDK appends a reset, so the fitted string actually grows.
    const paddedTheme = (path) => ({
      bold: (text) => text,
      fg(tone, text) {
        if (tone !== "warning") return text;
        return bounded === "input" ? text + linked("", path) : linked(text, path);
      },
    });
    const base = traceFinalFits(() => breakdownFrame(table, paddedTheme(""), width)).fits[modelRow];
    for (const units of [2048, 2049]) {
      const extra = units - base[bounded].length;
      const path = "😀".repeat(Math.floor(extra / 2)) + "a".repeat(extra % 2);
      const decorated = paddedTheme(path);
      const expected = traceFinalFits(() => breakdownFrame(table, decorated, width));
      const target = expected.fits[modelRow];
      const label = `${bounded} at ${units} units`;
      assert.equal(target[bounded].length, units, label);
      assert(target[other].length <= 2048, `${label}: only one bound is under test`);

      const painter = createBreakdownFramePainter();
      assert.deepEqual(
        traceFinalFits(() => painter.paint(table, decorated, width)),
        expected,
        label,
      );
      const warm = traceFinalFits(() => painter.paint(table, decorated, width));
      assert.deepEqual(warm.lines, expected.lines, `${label}: retention must not change display`);
      assert.deepEqual(warm.fits, units === 2048 ? [] : [target], `${label}: final refits`);
    }
  }
});

test("usage panel explicitly invalidates before repainting an unchanged frame", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const h = footerFixture();
  t.after(() => h.panels.dispose(() => {}));
  h.panels.toggleBreakdown();
  const paint = () => traceFinalFits(() => h.paint());
  const initial = paint();
  assert.equal(initial.fits.length, initial.lines.length);
  assert.deepEqual(paint().fits, []);

  // Do not paint between flips: the next raw frame matches the cached one,
  // so a refit proves explicit invalidation, not a changed cache key.
  withBorderLabels(false);
  withBorderLabels(true);
  assert.deepEqual(paint(), initial, "the chrome listener clears a byte-identical frame");
  assert.deepEqual(paint().fits, []);

  h.panels.toggleBreakdown();
  h.panels.toggleBreakdown();
  assert.deepEqual(paint(), initial, "closing the panel clears its cache before reopening");
});

test("usage tiny OFF hides the breakdown rather than clipping its bottom", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(false);
  const h = footerFixture([spendRow, { ...spendRow, key: "openai/gpt-5", cost: 0.2 }]);
  h.tui.terminal.rows = 10; // one dock row leaves nine stack rows
  t.after(() => h.panels.dispose(() => {}));
  h.panels.toggleBreakdown();
  const options = h.overlays[0].options;
  assert.equal(options.visible(), true, "the minimal OFF frame fits nine rows");
  const frame = h.paint();
  assert.equal(frame.length, 9, "the complete frame includes model, total and overflow");
  assert.match(plain(frame.at(-1)), /^╰─+╯$/, "the bottom edge is painted, not clipped");

  h.tui.terminal.rows = 9; // one row short of the complete frame
  assert.equal(options.visible(), false, "the stack hides instead of clipping the bottom");

  h.tui.terminal.rows = 10;
  assert.equal(options.visible(), true, "the same options reveal the complete frame again");
  assert.deepEqual(h.paint(), frame);
});

function approvalHostFixture() {
  const handlers = new Map();
  const listeners = new Map();
  let renders = 0;
  let overlayOptions;
  let hidden = false;
  const host = {
    mode: "fullscreen",
    terminal: { rows: 9, columns: 80 },
    requestRender() {
      renders++;
    },
    showOverlay(_component, options) {
      overlayOptions = options;
      return {
        hide() {
          hidden = true;
        },
        isFocused: () => false,
        isHidden: () => hidden,
        focus() {},
      };
    },
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
  const pi = {
    events: {
      on(name, handler) {
        const list = listeners.get(name) ?? [];
        list.push(handler);
        listeners.set(name, list);
      },
      emit(name, data) {
        for (const handler of listeners.get(name) ?? []) handler(data);
      },
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    appendEntry() {},
  };
  approvalMode(pi);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/fixture",
    sessionManager: { getSessionId: () => "border-label-session", getBranch: () => [] },
    ui: {
      theme,
      setStatus() {},
      setWidget(_key, factory) {
        factory?.(host, theme);
      },
      notify() {},
      confirm: async () => true,
      select: async () => undefined,
    },
  };
  handlers.get("session_start")({}, ctx);
  return {
    get options() {
      return overlayOptions;
    },
    get renders() {
      return renders;
    },
    open() {
      for (const handler of listeners.get(FOOTER_INDICATOR_CLICK_EVENT) ?? [])
        handler({ key: "approval", handled: false });
    },
    shutdown() {
      handlers.get("session_shutdown")({}, ctx);
    },
  };
}

test("context footer panel hides instead of compacting when the OFF bands cannot fit", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const h = footerFixture();
  h.tui.terminal.rows = 9;
  t.after(() => h.panels.dispose(() => {}));
  h.panels.toggleContext();
  assert.equal(h.overlays.length, 1);
  const options = h.overlays[0].options;
  assert.equal(options.visible(), true, "the six-row ON floor fits");
  const renders = h.renders;

  withBorderLabels(false);
  assert.equal(options.visible(), false, "the ten-row OFF floor hides the panel");
  assert.ok(h.renders > renders, "the host repaints after the switch");

  withBorderLabels(true);
  assert.equal(options.visible(), true, "the six-row ON floor fits again");

  h.panels.dispose(() => {});
  const afterDispose = h.renders;
  withBorderLabels(false);
  assert.equal(h.renders, afterDispose, "context teardown unsubscribes its listener");
});

test("approval host re-evaluates stack minRows when the shared band changes", (t) => {
  t.after(() => setBorderLabelsEnabled(true));
  withBorderLabels(true);
  const f = approvalHostFixture();
  t.after(() => f.shutdown());
  f.open();
  assert.ok(f.options, "the approval popover mounted");
  assert.equal(f.options.visible(), true, "the one-row band fits the nine-row host");
  const renders = f.renders;

  withBorderLabels(false);
  assert.equal(f.options.visible(), false, "the three-row band no longer fits");
  assert.ok(f.renders > renders, "the host repaints after the switch");

  withBorderLabels(true);
  assert.equal(f.options.visible(), true, "the one-row band fits again");

  f.shutdown();
  const afterShutdown = f.renders;
  withBorderLabels(false);
  assert.equal(f.renders, afterShutdown, "shutdown unsubscribes the host listener");
});
