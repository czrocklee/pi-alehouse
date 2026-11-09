import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import {
  matchesKey,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { joinPopoverStack } from "../../src/shared/popover-stack.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { createPresetOverlayHost } = await jiti.import(
  "../../src/orchestration/ui/preset-overlay-host.ts",
);
const theme = {
  fg: (color, text) =>
    `\x1b[${color === "muted" ? 90 : color === "error" ? 31 : 36}m${text}\x1b[39m`,
  bg: (_color, text) => text,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const move = (x, y = 0) => ({ type: "move", button: "none", x, y });

function fixture(t, extra = {}) {
  const selected = [],
    applied = [],
    delegated = [];
  let renders = 0,
    component;
  let delegation = { mode: "manual", eagerness: "normal" };
  const tui = extra.tui ?? {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => renders++,
    handleViewportInput: (event) => component?.handleMouse(event),
  };
  const originalDispatch = tui.handleViewportInput;
  const preset = {
    name: "team",
    version: "fixture",
    digest: "0".repeat(64),
    models: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d${n}`, "fixture/model"])),
  };
  component = new PresetPicker({
    tui,
    theme,
    pointer: true,
    presets: [preset],
    activeName: "team",
    keybindings: {
      matches: (data, binding) =>
        matchesKey(
          data,
          {
            "tui.select.confirm": "enter",
            "tui.select.cancel": "escape",
            "tui.select.up": "up",
            "tui.select.down": "down",
            "tui.select.pageUp": "pageUp",
            "tui.select.pageDown": "pageDown",
          }[binding] ?? "escape",
        ),
    },
    done: (value) => selected.push(value),
    efforts: () => ({ levels: ["off", "low", "high"], inherited: "low" }),
    setEffort: (name, effort_overrides) => {
      applied.push(effort_overrides);
      return { ...preset, name, effort_overrides };
    },
    delegation: {
      current: () => delegation,
      set: (value) => {
        delegated.push(value);
        delegation = value;
      },
      guideline: () => "Fixture guideline",
    },
    ...extra,
  });
  t.after(() => component.dispose());
  return { component, tui, originalDispatch, selected, applied, delegated, renders: () => renders };
}

for (const editing of [false, true]) {
  test(`picker ${editing ? "effort" : "list"} close hover is feedback only and survives repaint`, (t) => {
    const f = fixture(t, { startInEffort: editing });
    const initial = f.component.render(80);
    assert(initial[0].includes("×"));
    const before = f.renders();
    assert.equal(f.tui.handleViewportInput(move(76)), undefined);
    assert.equal(f.renders(), before + 1);
    const hovered = f.component.render(80);
    assert.notEqual(hovered[0], initial[0]);
    assert.equal(stripTerminalSequences(hovered[0]), stripTerminalSequences(initial[0]));
    assert.deepEqual(hovered.slice(1), initial.slice(1), "only the top close chrome changes");
    assert(hovered.every((line) => visibleWidth(line) <= 80));
    f.tui.handleViewportInput(move(78));
    assert.equal(f.renders(), before + 1, "repeated movement is render-deduplicated");
    assert.deepEqual(f.component.render(80), hovered);
    f.tui.handleViewportInput(move(5, 2));
    assert.deepEqual(f.component.render(80), initial, "moving within the panel clears hover");
    f.tui.handleViewportInput(move(76));
    assert.notEqual(f.tui.handleViewportInput, f.originalDispatch);
    f.component.dispose();
    assert.equal(f.tui.handleViewportInput, f.originalDispatch);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.applied, []);
    assert.deepEqual(f.delegated, []);
    assert.equal(f.component.selection(), "team");
  });
}

for (const editing of [false, true]) {
  test(`picker ${editing ? "effort" : "list"} height-only relayout clears the returned close highlight`, (t) => {
    const measured = [];
    const f = fixture(t, { startInEffort: editing, onRender: (height) => measured.push(height) });
    const initial = f.component.render(80);
    f.tui.handleViewportInput(move(76));
    assert.notEqual(f.component.render(80)[0], initial[0]);
    f.component.options.rows = () => 7;
    let layouts = 0;
    const layout = f.component.layout.bind(f.component);
    f.component.layout = (...args) => {
      layouts++;
      return layout(...args);
    };
    const next = f.component.render(80);
    assert.equal(layouts, 1, "height cleanup does not recompute the page or its pointer maps");
    assert.notEqual(next.length, initial.length);
    assert.equal(next[0], initial[0], "the same paint returns unhighlighted chrome");
    assert.deepEqual(
      measured,
      [initial.length, initial.length, next.length],
      "one measurement per paint, including title-only cleanup",
    );
    assert.equal(f.tui.handleViewportInput, f.originalDispatch);
    f.tui.handleViewportInput(move(76));
    const hovered = f.component.render(80);
    assert.notEqual(hovered[0], next[0]);
    assert.deepEqual(f.component.render(80), hovered, "stable short height preserves hover");
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.applied, []);
    assert.deepEqual(f.delegated, []);
  });
}

test("picker empty/narrow/docked paints and invalidation retire hover without hidden close actions", (t) => {
  const f = fixture(t);
  const initial = f.component.render(80);
  const enter = () => f.tui.handleViewportInput(move(76));
  enter();
  f.component.invalidate();
  assert.equal(f.tui.handleViewportInput, f.originalDispatch);
  assert.deepEqual(f.component.render(80), initial);
  enter();
  f.component.options.rows = () => 0;
  assert.deepEqual(f.component.render(80), []);
  const before = f.renders();
  enter();
  f.tui.handleViewportInput({ type: "click", button: "left", x: 76, y: 0 });
  assert.equal(f.renders(), before);
  assert.deepEqual(f.selected, []);
  f.component.options.rows = () => 20;
  f.component.render(80);
  enter();
  assert.deepEqual(f.component.render(7), []);
  assert.equal(f.tui.handleViewportInput, f.originalDispatch);
  const docked = fixture(t, { pointer: false });
  const lines = docked.component.render(80);
  assert(!lines[0].includes("×"));
  docked.tui.handleViewportInput(move(76));
  assert.deepEqual(docked.component.render(80), lines);
});

test("a host without viewport dispatch leaves picker close clicks usable without hover", (t) => {
  const f = fixture(t);
  delete f.tui.handleViewportInput;
  const initial = f.component.render(80);
  f.component.handleMouse(move(76));
  assert.deepEqual(f.component.render(80), initial);
  assert.deepEqual(f.component.handleMouse({ type: "click", button: "left", x: 76, y: 0 }), {
    handled: true,
  });
  assert.deepEqual(f.selected, [null]);
});

const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  "shift+right": "\x1b[1;2C",
  "alt+s": "\x1bs",
  "ctrl+c": "\x03",
};
const management = {
  summary: () => "Fixture settings",
  settings: true,
  presets: true,
  models: true,
  saveDefaults: true,
  canSaveWorkspace: () => true,
};
const presets = ["alpha", "team", "zulu"].map((name) => ({
  name,
  version: "fixture",
  digest: "0".repeat(64),
  models: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d${n}`, "fixture/model"])),
  effort_overrides: { d5: "high" },
}));
const state = (f) => ({
  selection: f.component.selection(),
  editing: f.component.editing,
  slotIndex: f.component.slotIndex,
  selected: f.selected,
  applied: f.applied,
  delegated: f.delegated,
});

for (const pointer of [false, true]) {
  for (const editing of [false, true]) {
    test(`${pointer ? "floating" : "docked"} ${editing ? "effort" : "list"} keys survive invalidate without repaint`, (t) => {
      const inputs = editing
        ? ["up", "down", "tab", "shift+tab", "1", "5", "left", "right", "r"]
        : [
            "up",
            "down",
            "pageUp",
            "pageDown",
            "home",
            "end",
            "tab",
            "shift+tab",
            "e",
            "p",
            "n",
            "c",
            "1",
            "5",
            "left",
            "right",
            "shift+right",
          ];
      for (const key of [...inputs, "g", "w", "enter", "escape", "alt+s", "ctrl+c"]) {
        const extra = { pointer, startInEffort: editing, presets, management };
        const normal = fixture(t, extra),
          invalidated = fixture(t, extra);
        normal.component.render(80);
        invalidated.component.render(80);
        invalidated.component.invalidate();
        normal.component.handleInput(keys[key] ?? key);
        invalidated.component.handleInput(keys[key] ?? key);
        assert.deepEqual(state(invalidated), state(normal), key);
      }
      const f = fixture(t, { pointer, startInEffort: editing, presets });
      f.component.render(80);
      f.component.invalidate();
      f.component.handleInput(keys.down);
      if (editing) {
        assert.equal(f.component.slotIndex, 1);
        f.component.handleInput(keys.right);
        assert.deepEqual(f.applied, [{ d5: "high", d4: "inherit" }]);
      } else {
        assert.equal(f.component.selection(), "zulu");
        f.component.handleInput(keys.enter);
        assert.deepEqual(f.selected, ["zulu"]);
      }
    });
  }
}

for (const editing of [false, true]) {
  test(`${editing ? "effort" : "list"} invalidation never revives unusable keyboard or pointer targets`, (t) => {
    for (const kind of ["rows", "columns", "budget", "empty paint"]) {
      for (const painted of [false, true]) {
        const f = fixture(t, { startInEffort: editing, presets, management });
        if (painted) f.component.render(80);
        if (kind === "rows") f.tui.terminal.rows = 6;
        if (kind === "columns") f.tui.terminal.columns = 7;
        if (kind === "budget") f.component.options.rows = () => 0;
        if (kind === "empty paint") assert.deepEqual(f.component.render(7), []);
        f.component.invalidate();
        const before = structuredClone(state(f));
        for (const key of ["down", "right", "5", "e", "r", "p", "n", "c", "g", "w"])
          f.component.handleInput(keys[key] ?? key);
        if (!editing) f.component.handleInput(keys.enter);
        f.component.handleMouse({ type: "click", button: "left", x: 76, y: 0 });
        assert.deepEqual(state(f), before, `${kind}, painted=${painted}`);
        f.component.handleInput(keys.escape);
        assert.deepEqual(f.selected, editing ? [] : [null]);
        assert.equal(f.component.editing, false, "back/cancel remains usable");
      }
    }
  });
}

function stackedFixture(t, editing = false) {
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  let requests = 0;
  tui.requestRender = () => requests++;
  tui.requestImmediateRender = () => {};
  tui.setLayoutRoot({ render: () => Array(50).fill("Transcript"), invalidate() {} });
  tui.beforeTerminalStart();
  const lower = joinPopoverStack(tui);
  lower.measure(5);
  let component;
  const overlay = createPresetOverlayHost({
    floating: true,
    emitPinned() {},
    onHide: () => component?.invalidatePointerPaint(),
    onMove: () => component?.invalidatePointerPaint(),
  });
  const placement = overlay.attach(tui);
  const f = fixture(t, {
    tui,
    presets,
    management,
    startInEffort: editing,
    rows: () => placement.rows(),
    onRender: (height) => placement.measure(height),
    pointerCurrent: () => placement.pointerCurrent(),
  });
  component = f.component;
  const options = overlay.customOptions();
  const handle = tui.showOverlay(component, options.overlayOptions());
  options.onHandle(handle);
  t.after(() => {
    handle.hide();
    overlay.release();
    lower.leave();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => tui.compositeOverlays(Array(terminal.rows).fill(""), 100, 40);
  const dispatch = (event, bounds = handle.getBounds()) =>
    tui.dispatchMouseToOverlay({
      button: "left",
      ...event,
      screenX: bounds.col + event.x,
      screenY: bounds.row + event.y,
    });
  const repaint = () => tui.doRender();
  const raw = (button, x, y, release = false, bounds = handle.getBounds()) =>
    tui.handleTerminalInput(
      `\x1b[<${button};${bounds.col + x + 1};${bounds.row + y + 1}${release ? "m" : "M"}`,
    );
  repaint();
  return { ...f, lower, options, handle, paint, dispatch, repaint, raw, requests: () => requests };
}

for (const editing of [false, true]) {
  test(`pinned SDK stack move preserves the first ${editing ? "effort" : "list"} key before repaint`, (t) => {
    const f = stackedFixture(t, editing);
    f.lower.measure(6);
    f.tui.handleTerminalInput(keys.down);
    if (editing) {
      assert.equal(f.component.slotIndex, 1);
      f.tui.handleTerminalInput(keys.right);
      assert.deepEqual(f.applied, [{ d5: "high", d4: "inherit" }]);
    } else {
      assert.equal(f.component.selection(), "zulu");
      f.tui.handleTerminalInput(keys.enter);
      assert.deepEqual(f.selected, ["zulu"]);
    }
  });

  for (const change of ["hide", "move"]) {
    test(`pinned SDK ${change} rejects stale ${editing ? "effort" : "list"} pointer targets until repaint`, (t) => {
      const f = stackedFixture(t, editing);
      const oldBounds = f.handle.getBounds();
      const events = [
        { type: "click", x: oldBounds.width - 4, y: 0 },
        { type: "wheel", x: 1, y: 1, wheelDelta: 1 },
      ];
      for (const [kind, map] of Object.entries(f.component.paint)) {
        for (const [y, targets] of map) {
          if (kind === "rows") events.push({ type: "click", x: 1, y });
          else
            for (const target of Array.isArray(targets) ? targets : [targets]) {
              const x = target.start ?? target.x ?? target.next;
              if (x !== undefined) events.push({ type: "click", x, y });
            }
        }
      }
      f.lower.measure(change === "hide" ? 39 : 6);
      assert.equal(f.options.overlayOptions().visible(), change !== "hide");
      const before = structuredClone(state(f));
      for (const event of events) {
        assert.equal(f.dispatch(event, oldBounds).hit, true, "SDK still has the old hit layout");
        assert.deepEqual(state(f), before, JSON.stringify(event));
      }
      if (change === "hide") {
        f.lower.measure(5);
        assert.equal(f.options.overlayOptions().visible(), true);
        for (const event of events) f.dispatch(event, oldBounds);
        assert.deepEqual(state(f), before, "reveal alone cannot revive pointer targets");
      }
      f.paint();
      const y = editing
        ? f.component.paint.slots.keys().next().value
        : f.component.paint.rows.keys().next().value;
      const x = editing
        ? (f.component.paint.slots.get(y).prev ?? f.component.paint.slots.get(y).next)
        : 1;
      f.dispatch({ type: "click", x, y });
      if (editing) assert.equal(f.applied.length, 1, "fresh effort arrow is usable");
      else assert.equal(f.selected.length, 1, "fresh list row is usable");
    });
  }
}

test("the production coordinator wires the placement-current guard into its picker", () => {
  const source = readFileSync(
    new URL("../../src/orchestration/ui/panel-coordinator.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /pointerCurrent:\s*\(\) => stacked\.pointerCurrent\(\)/);
});

for (const editing of [false, true]) {
  for (const change of ["hide", "move"]) {
    test(`native raw wheel rejects a stale ${editing ? "effort" : "list"} ${change} before SDK visibility checks`, (t) => {
      const f = stackedFixture(t, editing);
      const bounds = f.handle.getBounds();
      const before = structuredClone(state(f));
      f.lower.measure(change === "hide" ? 39 : 6);
      f.raw(65, 1, 1, false, bounds);
      assert.deepEqual(state(f), before, "raw input cannot use cached pointer placement");
      f.lower.measure(5);
      f.repaint();
      f.raw(65, 1, 1);
      if (editing) assert.equal(f.component.slotIndex, 1);
      else assert.equal(f.component.selection(), "zulu");
    });
  }
}

for (const change of ["hide", "move"]) {
  test(`native captured release rejects a stale ${change} before SDK visibility checks`, (t) => {
    const f = stackedFixture(t);
    const bounds = f.handle.getBounds();
    const [y, nodes] = f.component.paint.modes.entries().next().value;
    const x = nodes.find(({ mode }) => mode === "lead").start;
    f.raw(0, x, y);
    assert(f.tui.mouseCapture, "raw native press captured the slider");
    f.lower.measure(change === "hide" ? 39 : 6);
    f.raw(0, x, y, true, bounds);
    assert.deepEqual(f.delegated, [], "captured native release cannot commit a stale preview");
    f.lower.measure(5);
    f.repaint();
    f.raw(0, x, y);
    f.raw(0, x, y, true);
    assert.equal(f.delegated.length, 1, "a fresh native press/release commits after repaint");
  });
}

for (const editing of [false, true]) {
  for (const change of ["hide", "move", "invalidate"]) {
    test(`native pending ${editing ? "effort" : "list"} close press is retired across ${change} and repaint`, (t) => {
      const f = stackedFixture(t, editing);
      const x = f.handle.getBounds().width - 4;
      f.raw(0, x, 0);
      if (change === "hide") {
        f.lower.measure(39);
        // A completed hidden frame observes the hide, then restoration paints
        // new bounds before the native release synthesizes its old click.
        f.repaint();
        f.lower.measure(5);
      } else if (change === "move") f.lower.measure(6);
      else f.component.invalidate();
      f.repaint();
      f.raw(0, x, 0, true);
      assert.deepEqual(f.selected, [], "the old press cannot activate the fresh close target");
      f.raw(0, x, 0);
      f.raw(0, x, 0, true);
      assert.deepEqual(f.selected, [null], "a fresh native close gesture still works");
    });
  }
}

test("a native press rejected before fresh paint cannot activate on a post-paint release", (t) => {
  const f = stackedFixture(t);
  const x = f.handle.getBounds().width - 4;
  f.component.invalidate();
  f.raw(0, x, 0);
  f.repaint();
  f.raw(0, x, 0, true);
  assert.deepEqual(f.selected, [], "repaint cannot validate an unseen press retroactively");
  f.raw(0, x, 0);
  f.raw(0, x, 0, true);
  assert.deepEqual(f.selected, [null]);
});

test("held native slider cleanup during a moving composite is silent, keyboard interruption is not", (t) => {
  const f = stackedFixture(t);
  const [y, nodes] = f.component.paint.modes.entries().next().value;
  const x = nodes.find(({ mode }) => mode === "lead").start;
  f.raw(0, x, y);
  f.lower.measure(6);
  const before = f.requests();
  f.paint();
  assert.equal(f.requests(), before, "the current paint already clears the preview");
  assert.equal(f.component.delegation.previewMode, undefined);
  f.raw(0, x, y, true);
  assert.deepEqual(f.delegated, []);
  f.raw(0, x, y);
  const keyBefore = f.requests();
  f.component.handleInput("?");
  assert.equal(f.requests(), keyBefore + 1, "a key interrupt still requests preview cleanup");
});

for (const change of ["hide", "move", "invalidate"]) {
  test(`${change} retires a captured slider and its synthetic click even after repaint`, (t) => {
    const f = stackedFixture(t);
    const bounds = f.handle.getBounds();
    const [y, nodes] = f.component.paint.modes.entries().next().value;
    const target = nodes.find(({ mode }) => mode === "lead");
    assert(target, "full paint has a slider");
    const point = { x: target.start, y };
    assert.equal(f.dispatch({ type: "press", ...point }).result.capture, true);
    if (change === "invalidate") f.component.invalidate();
    else {
      f.lower.measure(change === "hide" ? 39 : 6);
      f.options.overlayOptions().visible();
    }
    const before = structuredClone(state(f));
    for (const type of ["drag", "release", "click"]) f.dispatch({ type, ...point }, bounds);
    assert.deepEqual(state(f), before, "stale capture cannot publish before repaint");
    // Start another capture to exercise cancellation that spans a fresh paint.
    if (change === "hide") f.lower.measure(5);
    f.paint();
    const [nextY, nextNodes] = f.component.paint.modes.entries().next().value;
    const nextPoint = { x: nextNodes.find(({ mode }) => mode === "lead").start, y: nextY };
    f.dispatch({ type: "press", ...nextPoint });
    f.component.invalidate();
    f.paint();
    for (const type of ["drag", "release", "click"]) f.dispatch({ type, ...nextPoint });
    assert.deepEqual(state(f), before, "repaint does not resurrect the cancelled press");
    f.dispatch({ type: "click", ...nextPoint });
    assert.equal(f.delegated.length, 1, "a fresh click works after repaint");
    f.dispatch({ type: "click", x: f.handle.getBounds().width - 4, y: 0 });
    assert.deepEqual(f.selected, [null], "fresh close target works too");
  });
}
