import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { CURSOR_MARKER, Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  borderLabelsEnabled,
  onBorderLabelsChange,
  popoverChromeCloseHit,
  setBorderLabelsEnabled,
} from "../../src/shared/popover-chrome.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { PresetModelPopover } = await jiti.import(
  "../../src/orchestration/ui/preset-model-popover.ts",
);
const { presetPickerMinRows } = await jiti.import("../../src/orchestration/ui/preset-list-page.ts");
const { popoverInlay, popoverLabelRows, popoverTitle, popoverTitleRows } = await jiti.import(
  "../../src/orchestration/ui/popover.ts",
);

/** Focused direct-source coverage for the process-wide border-label switch on
 * the orchestration pickers: default-on byte parity, the all-or-none off
 * layout, geometry budgets under resize and live switches, and subscription
 * lifecycle. The shared chrome module owns the actual row painting. */

const theme = {
  fg: (color, text) =>
    `\x1b[${color === "muted" ? 90 : color === "error" ? 31 : 36}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  bg: (_color, text) => text,
};
const plain = (lines) => lines.map(stripTerminalSequences);
const restore = () => setBorderLabelsEnabled(true);

function pickerView(t, extra = {}) {
  let renders = 0;
  const choices = [];
  const presets = [
    { name: "off" },
    {
      name: "team",
      version: "v1",
      models: {
        d1: "fixture/d1",
        d2: "fixture/d2",
        d3: "fixture/d3",
        d4: "fixture/d4",
        d5: "fixture/d5",
      },
    },
  ];
  const tui = {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => renders++,
  };
  const view = new PresetPicker({
    tui,
    theme,
    presets,
    activeName: "team",
    pointer: true,
    keybindings: { matches: () => false },
    done: (value) => choices.push(value),
    ...extra,
  });
  t.after(() => view.dispose());
  return { tui, view, choices, presets, renders: () => renders };
}

const model = { id: "model", name: "model", provider: "fixture", api: "test" };
function modelView(t) {
  let renders = 0;
  const tree = new Container(),
    list = new Container();
  let height = 20;
  list.addChild(new Text("→   model [fixture]", 0, 0));
  tree.addChild(new Text(`> search${CURSOR_MARKER}`, 0, 0));
  tree.addChild(list);
  const native = {
    children: tree.children,
    addChild: (child) => tree.addChild(child),
    get focused() {
      return false;
    },
    set focused(value) {
      tree.invalidate();
    },
    capturesViewportInput: true,
    render: (width) => tree.render(width),
    invalidate: () => tree.invalidate(),
    handleInput: () => {},
    dispose: () => {},
  };
  const selected = [],
    cancelled = [];
  const tui = {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => renders++,
  };
  const view = new PresetModelPopover({
    native,
    tui,
    theme,
    title: "d3 model",
    height: () => height,
    models: () => [model],
    select: (value) => selected.push(value),
    cancel: () => cancelled.push(true),
  });
  t.after(() => view.dispose());
  return {
    tui,
    view,
    selected,
    cancelled,
    renders: () => renders,
    height: (value) => {
      height = value;
    },
  };
}

test("border labels default on: wrappers keep the exact legacy single-row chrome", (t) => {
  assert.equal(borderLabelsEnabled(), true, "process default stays on");
  const f = pickerView(t);
  const lines = f.view.render(80);
  const legacy = popoverTitle(theme, 80, "Delegation", true);
  assert.equal(lines[0], legacy, "picker paints the legacy inlaid title edge");
  assert.deepEqual(popoverTitleRows(theme, 80, "Delegation", true), [legacy]);
  const label = theme.fg("muted", "↑↓ choose · Enter apply · Esc cancel");
  const labeled = popoverLabelRows(theme, 80, label, "bottom");
  assert.equal(labeled.length, 1);
  assert.equal(labeled[0], popoverInlay(theme, 80, label, "bottom"));
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, y: 0, width: 1 });
});

test("labels off moves the picker title and close hit into inner rows", (t) => {
  const f = pickerView(t);
  const on = f.view.render(80);
  setBorderLabelsEnabled(false);
  t.after(restore);
  const off = f.view.render(80);
  assert.equal(off.length, on.length + 2, "the title band costs two extra rows");
  const rows = plain(off);
  assert.match(rows[0], /^╭─+╮$/, "outer top border is retained without labels");
  assert.ok(!rows[0].includes("Delegation"));
  assert.ok(rows[1].includes("Delegation"), "title moves to an inner row");
  assert.ok(rows[1].includes("✕"), "the close control moves with it");
  assert.match(rows[2], /^├─+┤$/);
  assert.match(rows.at(-1), /^╰─+╯$/);
  assert.deepEqual(off.slice(3), on.slice(1), "content rows are unchanged");
  assert.ok(off.length <= 32, "the terminal row share still bounds the paint");
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, y: 1, width: 1 });
  setBorderLabelsEnabled(true);
  assert.deepEqual(f.view.render(80), on, "switching back restores the on paint");
});

test("labels off shifts painted preset rows and clicks still pick the painted row", (t) => {
  setBorderLabelsEnabled(false);
  t.after(restore);
  const f = pickerView(t);
  const rows = plain(f.view.render(80));
  const y = rows.findIndex((line) => line.includes("team"));
  assert.ok(y >= 3, "preset rows start below the three-row title band");
  f.view.handleMouse({ type: "click", button: "left", x: 5, y: 1 });
  assert.deepEqual(f.choices, [], "the inner title row is never a preset target");
  f.view.handleMouse({ type: "click", button: "left", x: 5, y });
  assert.deepEqual(f.choices, ["team"], "the repainted target map stays authoritative");
});

test("labels off keeps the effort editor inside its row budget", (t) => {
  setBorderLabelsEnabled(false);
  t.after(restore);
  const f = pickerView(t, {
    efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
    setEffort: (_name, overrides) => ({ ...f.presets[1], effort_overrides: overrides }),
    startInEffort: true,
  });
  const lines = f.view.render(80);
  const rows = plain(lines);
  assert.match(rows[0], /^╭─+╮$/);
  assert.ok(rows[1].includes("Effort · team"));
  assert.match(rows[2], /^├─+┤$/);
  assert.ok(lines.length <= 32, "editor content compresses, never overflows");
  assert.ok(
    rows.some((line) => line.includes("‹d5:")),
    "slot rows survive the extra chrome",
  );
});

test("labels off moves the model popover title and bottom label together", (t) => {
  const f = modelView(t);
  const on = f.view.render(80);
  assert.ok(plain(on)[0].includes("d3 model"));
  setBorderLabelsEnabled(false);
  t.after(restore);
  const off = f.view.render(80);
  assert.equal(off.length, on.length + 4, "title and bottom each cost two rows");
  const rows = plain(off);
  assert.ok(!rows[0].includes("d3 model"));
  assert.ok(rows[1].includes("d3 model"));
  assert.match(rows[2], /^├─+┤$/);
  assert.match(rows.at(-3), /^├─+┤$/);
  assert.ok(rows.at(-2).includes("↑↓ choose"), "the bottom label becomes an inner row");
  assert.match(rows.at(-1), /^╰─+╯$/, "outer bottom border is retained");
  assert.ok(off.length <= 20, "the body budget absorbs the chrome band");
  assert.deepEqual(popoverChromeCloseHit(80), { x: 76, y: 1, width: 1 });
});

test("labels off raises the model popover's too-small floor with its chrome band", (t) => {
  const f = modelView(t);
  setBorderLabelsEnabled(false);
  f.height(6);
  const tiny = f.view.render(80);
  assert.equal(tiny.length, 1);
  assert.ok(plain(tiny)[0].includes("Too small"));
  f.height(7);
  const fitted = f.view.render(80);
  assert.ok(fitted.length > 1);
  assert.ok(fitted.length <= 7, "the paint never exceeds the granted height");
  setBorderLabelsEnabled(true);
  f.height(5);
  const on = f.view.render(80);
  assert.ok(on.length > 1, "the on floor of five rows is unchanged");
  assert.ok(on.length <= 5);
});

test("a live switch repaints subscribed views and disposal unsubscribes them", (t) => {
  const f = pickerView(t);
  f.view.render(80);
  const before = f.renders();
  setBorderLabelsEnabled(false);
  t.after(restore);
  assert.ok(f.renders() > before, "the picker requests a repaint on the switch");
  // Stale pointer targets die with the switch: the pre-switch close geometry
  // cannot finish the picker before the repaint.
  f.view.handleMouse({ type: "click", button: "left", x: 76, y: 0 });
  assert.deepEqual(f.choices, []);
  f.view.dispose();
  const disposed = f.renders();
  setBorderLabelsEnabled(true);
  setBorderLabelsEnabled(false);
  assert.equal(f.renders(), disposed, "a disposed view no longer repaints");

  const g = modelView(t);
  g.view.render(80);
  const modelBefore = g.renders();
  setBorderLabelsEnabled(true);
  assert.ok(g.renders() > modelBefore, "the model popover repaints on the same switch");
  g.view.dispose();
  const modelDisposed = g.renders();
  setBorderLabelsEnabled(false);
  assert.equal(g.renders(), modelDisposed, "a disposed model popover no longer repaints");
  setBorderLabelsEnabled(true);
});

test("onBorderLabelsChange disposer stops future notifications", () => {
  setBorderLabelsEnabled(true);
  let calls = 0;
  const unsubscribe = onBorderLabelsChange(() => calls++);
  setBorderLabelsEnabled(false);
  unsubscribe();
  unsubscribe();
  setBorderLabelsEnabled(true);
  assert.equal(calls, 1);
});

test("presetPickerMinRows keeps the on floor and adds the chrome band when off", () => {
  setBorderLabelsEnabled(true);
  assert.equal(presetPickerMinRows(), 7);
  setBorderLabelsEnabled(false);
  try {
    assert.equal(presetPickerMinRows(), 9);
  } finally {
    setBorderLabelsEnabled(true);
  }
});

test("the picker survives resize and a mid-flight switch without losing selection", (t) => {
  const f = pickerView(t);
  f.view.render(80);
  setBorderLabelsEnabled(false);
  t.after(restore);
  f.view.render(80);
  const narrow = f.view.render(40);
  assert.ok(narrow.length <= 32);
  assert.equal(f.view.selection(), "team");
  f.view.handleMouse({ type: "click", button: "left", x: 5, y: 2 });
  assert.deepEqual(f.choices, [], "the separator row is never a preset target");
  setBorderLabelsEnabled(true);
  f.view.render(40);
  assert.equal(f.view.selection(), "team", "the highlight survives the live switch");
});
