import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { CURSOR_MARKER, Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { popoverChromeCloseHit } from "../../src/shared/popover-chrome.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { PresetModelPopover } = await jiti.import(
  "../../src/orchestration/ui/preset-model-popover.ts",
);

const ANCHOR_KEY = Symbol.for("pi-alehouse.popover-text-selection.anchor.v1");
/** A small native-like host exposing the pi-tui 1.6.1 selection seams,
 * so a fresh press exercises the same wrapper path as the real TUI. */
function selectionHost() {
  const entry = { component: {}, hidden: false, options: {}, focusOrder: 1 };
  const layout = { entry, row: 2, col: 5, width: 80, height: 10 };
  const host = {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => {},
    overlayStack: [entry],
    renderedOverlayLayouts: [layout],
    selectionAnchor: undefined,
    selectionFocus: undefined,
    selectionPressActive: false,
    resetCalls: 0,
    handleSelectionMouseEvent(event) {
      const anchorScrollView = this.selectionAnchor?.scrollView;
      const point = this.getSelectionPoint(event, anchorScrollView);
      if (event.release) {
        if (!this.selectionPressActive) return;
        this.selectionPressActive = false;
        this.selectionFocus = point;
        return;
      }
      if ((event.button & 32) !== 0) {
        this.selectionFocus = point;
        return;
      }
      this.selectionPressActive = true;
      const anchor = this.getSelectionPoint(event, undefined);
      this.selectionAnchor = anchor;
      this.selectionFocus = anchor;
    },
    getSelectionPoint(event, scrollView) {
      const point = { row: event.y, col: event.x };
      if (scrollView) point.scrollView = scrollView;
      return point;
    },
    getWordSelection(point) {
      return { start: { ...point, col: 0 }, end: { ...point, col: 5 } };
    },
    getLineSelection(point) {
      return { start: { ...point, col: 0 }, end: { ...point, col: 80 } };
    },
    getSelectionColumns(line, row, selection, minColumn = 0, maxColumn = line.length) {
      let start = Math.max(0, minColumn);
      let end = Math.min(line.length, maxColumn);
      if (row === selection.start.row) start = Math.max(start, selection.start.col);
      if (row === selection.end.row) end = Math.min(end, selection.end.col + 1);
      return { start, end };
    },
    getSelectionBounds() {
      if (!this.selectionAnchor || !this.selectionFocus) return undefined;
      return { start: this.selectionAnchor, end: this.selectionFocus };
    },
    resetTextSelection() {
      this.resetCalls += 1;
      this.selectionAnchor = undefined;
      this.selectionFocus = undefined;
      this.selectionPressActive = false;
    },
  };
  return { host, entry, layout };
}

const theme = {
  fg: (color, text) => `\x1b[${color === "muted" ? 90 : 36}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  bg: (_color, text) => text,
};
const plain = (lines) => lines.map(stripTerminalSequences);

/** A pointer picker mounted in a native-like overlay layout on the host. */
function pickerFixture(t, { effort = false, pointer = true } = {}) {
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
  const choices = [];
  const { host, entry, layout } = selectionHost();
  const view = new PresetPicker({
    tui: host,
    theme,
    presets,
    activeName: "team",
    pointer,
    keybindings: { matches: () => false },
    done: (value) => choices.push(value),
    ...(effort
      ? {
          efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
          setEffort: (_name, overrides) => ({ ...presets[1], effort_overrides: overrides }),
        }
      : {}),
  });
  t.after(() => view.dispose());
  const mount = (lines) => {
    entry.component = view;
    layout.entry = entry;
    layout.width = 80;
    layout.height = lines.length;
  };
  return { host, view, choices, presets, mount };
}

const model = { id: "model", name: "model", provider: "fixture", api: "test" };

/** A model popover over a structured native selector, on the same host. */
function modelFixture(t) {
  const tree = new Container(),
    list = new Container();
  let height = 20;
  list.addChild(new Text("→   model [fixture]", 0, 0));
  tree.addChild(new Text(`> search${CURSOR_MARKER}`, 0, 0));
  tree.addChild(list);
  const native = {
    children: tree.children,
    get focused() {
      return false;
    },
    set focused(_value) {
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
  const { host, entry, layout } = selectionHost();
  const view = new PresetModelPopover({
    native,
    tui: host,
    theme,
    title: "d3 model",
    height: () => height,
    models: () => [model],
    select: (value) => selected.push(value),
    cancel: () => cancelled.push(true),
  });
  t.after(() => view.dispose());
  const mount = (lines) => {
    entry.component = view;
    layout.entry = entry;
    layout.width = 80;
    layout.height = lines.length;
  };
  return { host, view, selected, cancelled, mount, height: (value) => (height = value) };
}

const press = (host, x, y) => host.handleSelectionMouseEvent({ button: 0, x, y, release: false });
const bound = (host) => !!host.selectionAnchor && host.selectionAnchor[ANCHOR_KEY] !== undefined;

test("picker binds body text and keeps chrome gestures empty without cancelling clicks", (t) => {
  const f = pickerFixture(t);
  const lines = f.view.render(80);
  f.mount(lines);
  // Body row below the one-row title band and above the bare bottom rule.
  press(f.host, 15, 3);
  assert.ok(bound(f.host), "an unhandled body press binds a domain-tagged anchor");
  // Chrome has an owned empty domain: it selects nothing, but the native
  // press stays live so its released click can still activate controls.
  const resets = f.host.resetCalls;
  press(f.host, 15, 2);
  assert.equal(f.host.getSelectionBounds(), undefined, "a title-band press selects no text");
  assert.equal(
    f.host.selectionPressActive,
    true,
    "release still belongs to native click synthesis",
  );
  assert.equal(f.host.resetCalls, resets, "healthy chrome does not reset the native press");
  // The bare bottom rule is chrome too.
  press(f.host, 15, 2 + lines.length - 1);
  assert.equal(f.host.getSelectionBounds(), undefined, "a bottom-rule press selects no text");
});

test("picker keeps binding across stable repaints and cancels on route changes", (t) => {
  const f = pickerFixture(t, { effort: true });
  const lines = f.view.render(80);
  f.mount(lines);
  press(f.host, 15, 3);
  assert.ok(bound(f.host));
  const resets = f.host.resetCalls;
  f.view.render(80);
  assert.equal(f.host.resetCalls, resets, "a stable repaint keeps the bound selection");
  f.view.handleInput("e");
  f.view.render(80);
  assert.ok(f.host.resetCalls > resets, "the effort route change cancels the selection");
  assert.equal(f.host.selectionAnchor, undefined);
  // Rebind on the editor paint, then invalidate must cancel again.
  const editor = f.view.render(80);
  f.mount(editor);
  press(f.host, 15, 3);
  assert.ok(bound(f.host), "the editor body admits selection again");
  const before = f.host.resetCalls;
  f.view.invalidate();
  assert.ok(f.host.resetCalls > before, "invalidate cancels the bound selection");
  assert.equal(f.host.selectionAnchor, undefined);
});

test("pointer-disabled picker renders retire admission entirely", (t) => {
  const f = pickerFixture(t, { pointer: false });
  const lines = f.view.render(80);
  f.mount(lines);
  press(f.host, 15, 3);
  assert.ok(!bound(f.host), "a docked picker never admits a selection domain");
});

test("model popover keeps item and close clicks while body presses stay selectable", (t) => {
  const f = modelFixture(t);
  const lines = f.view.render(80);
  const rows = plain(lines);
  const itemY = rows.findIndex((line) => line.includes("model [fixture]"));
  const searchY = rows.findIndex((line) => line.includes("> search"));
  assert.ok(itemY > 0 && searchY > 0);
  assert.deepEqual(f.view.handleMouse({ type: "click", button: "none", x: 6, y: itemY }), {
    handled: true,
    focus: true,
  });
  assert.deepEqual(f.selected, [], "a native buttonless click must not apply a model");
  // A press on the painted model item stays claimed (control, not prose).
  assert.deepEqual(f.view.handleMouse({ type: "press", button: "left", x: 6, y: itemY }), {
    handled: true,
  });
  // The verified item click still selects and keeps focus.
  const click = f.view.handleMouse({ type: "click", button: "left", x: 6, y: itemY });
  assert.equal(click.handled, true);
  assert.equal(click.focus, true);
  assert.deepEqual(f.selected, [model]);
  // A press outside the item hit stays unhandled for the shared bridge.
  assert.equal(f.view.handleMouse({ type: "press", button: "left", x: 3, y: itemY }), undefined);
  assert.equal(f.view.handleMouse({ type: "press", button: "left", x: 4, y: searchY }), undefined);
  // A missed click still claims and focuses, exactly as before.
  const miss = f.view.handleMouse({ type: "click", button: "left", x: 4, y: searchY });
  assert.equal(miss.handled, true);
  assert.equal(miss.focus, true);
  assert.deepEqual(f.selected, [model], "a missed click never selects a replacement");
  // Wheel stays consumed; right/middle stay consumed as before.
  assert.deepEqual(f.view.handleMouse({ type: "wheel", button: "none", x: 6, y: searchY }), {
    handled: true,
  });
  assert.deepEqual(f.view.handleMouse({ type: "click", button: "right", x: 6, y: itemY }), {
    handled: true,
  });
  assert.deepEqual(f.view.handleMouse({ type: "press", button: "middle", x: 6, y: searchY }), {
    handled: true,
  });
  // Primary drags and buttonless releases stay unhandled for native selection.
  assert.equal(f.view.handleMouse({ type: "drag", button: "left", x: 4, y: searchY }), undefined);
  assert.equal(
    f.view.handleMouse({ type: "release", button: "left", x: 4, y: searchY }),
    undefined,
  );
  assert.equal(
    f.view.handleMouse({ type: "release", button: "none", x: 4, y: searchY }),
    undefined,
  );
  // The close gesture still closes: press then release on the painted hit.
  const hit = popoverChromeCloseHit(80);
  assert.deepEqual(f.view.handleMouse({ type: "press", button: "left", x: hit.x, y: hit.y }), {
    handled: true,
  });
  assert.deepEqual(f.cancelled, [], "a close press arms without closing");
  assert.deepEqual(f.view.handleMouse({ type: "release", button: "left", x: hit.x, y: hit.y }), {
    handled: true,
  });
  assert.deepEqual(f.cancelled, [true], "the close release still closes");
});

test("model popover admits the note and native body, not title or footer", (t) => {
  const f = modelFixture(t);
  const lines = f.view.render(80);
  f.mount(lines);
  const rows = plain(lines);
  const noteY = rows.findIndex((line) => line.includes("New Agents only"));
  assert.ok(noteY > 0, "the wrapper note is a body row");
  press(f.host, 15, 2 + noteY);
  assert.ok(bound(f.host), "the context note is selectable body prose");
  // Native input can scroll or refilter the list: it must cancel at once.
  const resets = f.host.resetCalls;
  f.view.handleInput("x");
  assert.ok(f.host.resetCalls > resets, "native input cancels the bound selection");
  assert.equal(f.host.selectionAnchor, undefined);
  // The repaint after input re-admits the body before the next press.
  f.mount(f.view.render(80));
  press(f.host, 15, 2 + noteY);
  assert.ok(bound(f.host), "the body re-admits after the input repaint");
  // Invalidate must cancel too.
  const before = f.host.resetCalls;
  f.view.invalidate();
  assert.ok(f.host.resetCalls > before, "invalidate cancels the bound selection");
  f.mount(f.view.render(80));
  // Title and footer gestures remain empty without disabling native click
  // synthesis (e.g. clicking wrapper chrome to focus the model chooser).
  press(f.host, 15, 2);
  assert.equal(f.host.getSelectionBounds(), undefined, "the title band selects no text");
  assert.equal(f.host.selectionPressActive, true);
  press(f.host, 15, 2 + lines.length - 1);
  assert.equal(f.host.getSelectionBounds(), undefined, "the labeled bottom selects no text");
  assert.equal(f.host.selectionPressActive, true);
});
