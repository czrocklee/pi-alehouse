// Source-loaded border-label regressions: no generated runtime, sessions,
// providers, host UI, network or publication. The shared chrome module owns the
// process switch; tests only drive it and observe these panels' source output.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

// One module cache for the whole file so the panels and this test share the
// exact same process-wide border-label switch instance.
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: true });
const { ApprovalPopover } = await jiti.import("../../src/extensions/lib/approval-view.ts");
const { breakdownChromeRows, breakdownFrame, breakdownTable, breakdownTitle } = await jiti.import(
  "../../src/extensions/lib/footer-layout.ts",
);
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

function footerFixture(spend = [spendRow]) {
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
    theme,
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
    paint() {
      return overlays.length ? overlays.at(-1).component.render(80) : [];
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
