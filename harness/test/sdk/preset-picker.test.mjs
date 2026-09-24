import assert from "node:assert/strict";
import test from "node:test";
import { Container, matchesKey, stripTerminalSequences, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { PresetPicker, PresetPickerRequest } from "../../dist/ui/preset-picker.js";
import { PanelCoordinator } from "../../dist/ui/panel-coordinator.js";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";
import { PresetRouter } from "../../dist/routing.js";
import { starterPath } from "../support/preset-config.mjs";
import { joinPopoverStack, stackedOverlayOptions } from "../../../lib/popover-stack.mjs";
import { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR, HIDE_TRANSIENT_OVERLAYS_EVENT }
  from "../../../lib/overlay-protocol.mjs";

// Exercise Pi's real ui.custom completion, whose overlay branch closes by
// popping the top of the global stack rather than the component's own handle.
const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js",
  import.meta.resolve("@earendil-works/pi-coding-agent")));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
};
const keys = {
  matches(data, binding) {
    const map = {
      "tui.select.up": "up", "tui.select.down": "down",
      "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown",
      "tui.select.confirm": "enter", "tui.select.cancel": ["escape", "ctrl+c"],
    };
    const expected = map[binding];
    return (Array.isArray(expected) ? expected : [expected]).some((key) => matchesKey(data, key));
  },
};
const preset = (name, version = "starter-v2", suffix = name) => ({
  name, version, digest: "0".repeat(64), models: {
    light: `provider/${suffix}-light`, standard: `provider/${suffix}-standard`, strong: `provider/${suffix}-strong`,
  }, thinking: { light: { low: "medium" }, standard: {}, strong: {} },
});
const offPreset = () => ({ name: "off", version: "off-v1", digest: "f".repeat(64) });
const fixture = ({ rows = 24, presets = [preset("alpha"), preset("beta"), preset("gamma")], activeName = "beta", theme: th = theme,
  ...extra } = {}) => {
  const result = [], tui = { terminal: { columns: 120, rows }, renders: 0, requestRender() { this.renders++; } };
  const picker = new PresetPicker({ tui, theme: th, keybindings: keys, presets, activeName, done: (value) => result.push(value), ...extra });
  return { picker, tui, result };
};
const mouse = (type, x, y, extra = {}) => ({ type, button: "left", x, y, ...extra });

// The real empty Agent widget never mounts. Exercise the SDK widget factory and
// ui.custom dispatch as well as the compositor: a canned fullscreen widget mock
// would mask the first-open bug before the picker ever reaches the shared stack.
function emptyOwnerPanels(t, mode = "fullscreen") {
  initTheme(undefined, false);
  const terminal = { columns: 120, rows: 50, hideCursor() {} };
  const tui = mode === "fullscreen" ? new TuiAltScreen(terminal, false, undefined, {}) : new TuiMainScreen(terminal, false);
  tui.requestRender = () => {};
  const editor = { render: () => [], invalidate() {}, getText: () => "draft", setText() {} };
  tui.setFocus(editor);
  const host = { ui: tui, editor, keybindings: keys, editorContainer: new Container(),
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    renderWidgets: InteractiveMode.prototype.renderWidgets,
    renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer, disposeActiveSelector() {} };
  host.editorContainer.addChild(editor);
  const bus = createEventBus(), shortcuts = new Map(), mounts = [], widgets = [], published = [];
  const router = new PresetRouter(starterPath);
  router.select("off");
  const ui = {
    notify() { assert.fail("unexpected UI notification"); },
    setWidget(key, content, options) {
      widgets.push({ key, content });
      InteractiveMode.prototype.setExtensionWidget.call(host, key, content, options);
    },
    custom(factory, options) {
      const mount = { options };
      mounts.push(mount);
      return InteractiveMode.prototype.showExtensionCustom.call(host, (...args) => {
        mount.component = factory(...args); return mount.component;
      }, { ...options, onHandle(handle) { mount.handle = handle; options.onHandle?.(handle); } });
    },
  };
  const widget = new HarnessWidget({ list: () => [], stats: () => ({ resident: 0, cleanup_uncertain: false }) }, 8);
  widget.setUi(ui); widget.update();
  assert.equal(widget.tuiMode(), undefined);
  assert.equal(widgets.length, 0, "no Agent rows have ever mounted");
  const panels = new PanelCoordinator({ pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget, ready: () => true, router: () => router, publish: (_candidate, name) => published.push(name),
    showError: (error) => assert.fail(String(error)) });
  const ctx = { mode: "tui", ui };
  t.after(() => { panels.dispose(); widget.dispose(); });
  const paint = () => { for (let i = 0; i < 3; i++) tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows); };
  const click = () => {
    const event = { key: WORKER_PRESET_INDICATOR, handled: false };
    bus.emit(FOOTER_INDICATOR_CLICK_EVENT, event); assert.equal(event.handled, true);
  };
  return { panels, widget, host, ctx, tui, terminal, bus, shortcuts, mounts, widgets, published, paint, click };
}

for (const order of [["usage", "approval", "workers"], ["usage", "workers", "approval"],
  ["approval", "usage", "workers"], ["approval", "workers", "usage"],
  ["workers", "usage", "approval"], ["workers", "approval", "usage"]]) {
  test(`fresh empty Owner stacks workers at shared width via actual SDK: ${order.join(" → ")}`, async (t) => {
    const h = emptyOwnerPanels(t), others = new Map();
    const clearOthers = () => { for (const { handle, member } of others.values()) { handle.hide(); member.leave(); } };
    h.bus.on(HIDE_TRANSIENT_OVERLAYS_EVENT, clearOthers);
    t.after(clearOthers);
    h.panels.attachHost(h.ctx, h.bus);
    for (const name of order) {
      if (name === "workers") { h.click(); await tick(); }
      else {
        const member = joinPopoverStack(h.tui), height = name === "usage" ? 5 : 7;
        const component = { render(width) { member.measure(height); return Array(height).fill("x".repeat(width)); }, invalidate() {} };
        const handle = h.tui.showOverlay(component, stackedOverlayOptions(member,
          { width: name === "usage" ? 52 : 68, nonCapturing: true }));
        others.set(name, { handle, member });
      }
      h.paint();
    }
    const mount = h.mounts[0];
    assert.equal(mount.options.overlay, true, "first open must float even though no Agent widget ever supplied a mode");
    assert.equal(h.widget.tuiMode(), undefined, "opening routing must not manufacture an Agent row");
    assert.deepEqual(h.widgets.map(({ key }) => key), ["harness-panel-host"]);
    assert.deepEqual(h.host.extensionWidgetsAbove.get("harness-panel-host").render(120), []);
    assert.equal(h.host.widgetContainerAbove.render(120).length, 1, "only the SDK's existing spacer, no extra visible row");
    assert.equal(h.host.editorContainer.children[0], h.host.editor, "the picker must not replace the editor");
    assert.equal(h.tui.getFocusedComponent(), mount.component);
    for (const columns of [120, 42, 160]) {
      h.terminal.columns = columns; h.paint();
      const bounds = order.map((name) => (name === "workers" ? mount : others.get(name)).handle.getBounds());
      let bottom = h.terminal.rows - 1;
      for (const box of bounds) {
        assert.equal(box.width, Math.min(76, columns));
        assert.equal(box.col + box.width, columns);
        assert.equal(box.row + box.height, bottom, "opening order, without gaps or overlap");
        bottom = box.row;
      }
    }
    for (const component of h.host.extensionWidgetsAbove.values()) component.invalidate();
    h.click(); await tick();
    assert.equal(mount.handle.getBounds(), undefined);
    assert.deepEqual(h.published, [], "close must not select a preset");
    const reopening = h.shortcuts.get("alt+s").handler(); await tick(); h.paint();
    assert.equal(h.mounts[1].options.overlay, true, "idle reopen via keyboard still floats");
    assert.equal(h.mounts[1].handle.getBounds().width, 76);
    h.panels.dispose(); await reopening;
    assert.equal(h.host.extensionWidgetsAbove.size, 0, "shutdown removes the invisible host too");
    assert.equal(h.widgets.filter(({ content }) => content === undefined).length, 1);
  });
}

for (const mode of ["regular", "unknown"]) test(`empty Owner keeps ${mode} renderer routing docked`, async (t) => {
  const h = emptyOwnerPanels(t, "regular");
  if (mode === "unknown") h.tui.mode = undefined;
  h.panels.attachHost(h.ctx, h.bus);
  const opening = h.shortcuts.get("alt+s").handler(); await tick();
  const mount = h.mounts[0];
  assert.equal(mount.options.overlay, false);
  assert.equal(mount.handle, undefined);
  assert.equal(h.host.editorContainer.children[0], mount.component);
  assert.doesNotMatch(stripTerminalSequences(mount.component.render(120)[0]), /×/);
  mount.component.handleInput("\u001b"); await opening;
  assert.equal(h.host.editorContainer.children[0], h.host.editor);
});

for (const fault of ["mount", "clear"]) test(`panel host cleanup survives a partially applied ${fault} failure`, (t) => {
  const h = emptyOwnerPanels(t), notices = [];
  const setWidget = h.ctx.ui.setWidget;
  h.ctx.ui.notify = (message) => notices.push(message);
  h.ctx.ui.setWidget = (...args) => {
    setWidget(...args);
    if ((fault === "mount") === (args[1] !== undefined)) throw new Error("HOST_WIDGET_FAILURE");
  };
  if (fault === "mount") assert.throws(() => h.panels.attachHost(h.ctx, h.bus), /HOST_WIDGET_FAILURE/);
  else h.panels.attachHost(h.ctx, h.bus);
  const lateFactory = h.widgets[0].content;
  assert.doesNotThrow(() => h.panels.dispose());
  assert.equal(h.host.extensionWidgetsAbove.size, 0);
  const event = { key: WORKER_PRESET_INDICATOR, handled: false };
  h.bus.emit(FOOTER_INDICATOR_CLICK_EVENT, event);
  assert.equal(event.handled, false, "the retired coordinator no longer owns footer clicks");
  assert.equal(notices.length, fault === "clear" ? 1 : 0);
  // An old factory or repeated disposal must not reacquire the host or remove
  // a widget that a later UI lifetime installed under the same key.
  const replacement = { render: () => [], invalidate() {} };
  setWidget("harness-panel-host", () => replacement);
  lateFactory(h.tui, theme);
  assert.equal(h.panels.tui, undefined);
  h.panels.dispose();
  assert.equal(h.host.extensionWidgetsAbove.get("harness-panel-host"), replacement);
});

test("a queued picker can be cancelled before mount and settles only once", () => {
  let beforeNotices = 0;
  const before = new PresetPickerRequest(() => beforeNotices++), early = [];
  before.close();
  assert.equal(before.mount((value) => early.push(value), false), false);
  before.choose("alpha");
  assert.deepEqual(early, [null]);
  assert.equal(beforeNotices, 2,
    "deferred cancellation coordinates immediately and again before Pi closes the dequeued factory");

  let mountedNotices = 0;
  const mounted = new PresetPickerRequest(() => mountedNotices++), values = [];
  assert.equal(mounted.mount((value) => values.push(value), false), true);
  mounted.choose("beta"); mounted.close(); mounted.choose("gamma");
  assert.deepEqual(values, ["beta"]);
  assert.equal(mountedNotices, 1, "apply coordinates overlays once");

  let blockedNotices = 0;
  const blocked = new PresetPickerRequest(() => blockedNotices++), denied = [];
  assert.equal(blocked.mount((value) => denied.push(value), true), false);
  assert.deepEqual(denied, [null]);
  assert.equal(blockedNotices, 1, "a blocked factory coordinates overlays once");
});

for (const trigger of ["approval", "shutdown"]) {
  test(`a newer transient overlay cannot strand the picker during ${trigger}`, async () => {
    const layers = [];
    const editor = { getText: () => "draft", setText: () => {} };
    let focus = editor, doneCalls = 0, transientHides = 0, commits = 0;
    const tui = {
      requestRender() {},
      setFocus(component) { focus = component; },
      showOverlay(component, options = {}) {
        const layer = { component, options };
        layers.push(layer);
        if (!options.nonCapturing) focus = component;
        return {
          hide() {
            const index = layers.indexOf(layer);
            if (index >= 0) layers.splice(index, 1);
            if (focus === component) focus = editor;
          },
          setHidden() {},
        };
      },
      hideOverlay() {
        const removed = layers.pop();
        if (removed && focus === removed.component) focus = editor;
      },
    };
    const host = {
      editor, ui: tui, keybindings: {}, disposeActiveSelector() {},
      editorContainer: { clear() {}, addChild() {} },
    };
    let transient;
    const request = new PresetPickerRequest(() => {
      transientHides++;
      transient?.hide();
    });
    const picker = { render: () => ["picker"], invalidate() {} };
    const opening = InteractiveMode.prototype.showExtensionCustom.call(host,
      (_tui, _theme, _keys, done) => {
        assert.equal(request.mount((value) => { doneCalls++; done(value); }, false), true);
        return picker;
      }, { overlay: true });
    await tick();
    assert.deepEqual(layers.map(({ component }) => component), [picker]);

    const footer = { render: () => ["footer"], invalidate() {} };
    transient = tui.showOverlay(footer, { nonCapturing: true });
    assert.deepEqual(layers.map(({ component }) => component), [picker, footer]);
    assert.equal(focus, picker, "the noncapturing footer does not steal picker focus");

    request.close();
    request.close();
    const selected = await opening;
    if (selected) commits++;

    assert.equal(transientHides, 1, "coordination runs once before ui.custom completion");
    assert.equal(doneCalls, 1, "the picker settles once");
    assert.equal(commits, 0, "programmatic cancellation cannot commit a selection");
    assert.deepEqual(layers, [], "footer and picker overlays are both removed");

    if (trigger === "approval") {
      const approval = { render: () => ["approval"], invalidate() {} };
      tui.showOverlay(approval);
      assert.deepEqual(layers.map(({ component }) => component), [approval]);
      assert.equal(focus, approval, "the approval retains focus after picker cleanup");
    }
  });
}

test("preset dashboard fits narrow, normal and wide terminals without hiding slot identities", () => {
  const long = preset("custom-preset-name-that-is-intentionally-long-for-a-small-terminal", "2026-10-01-release", "model-id-that-is-also-intentionally-long");
  for (const rows of [8, 12, 24]) {
    for (const width of [18, 34, 76, 120]) {
      const { picker } = fixture({ rows, presets: [long], activeName: long.name });
      const lines = picker.render(width);
      assert.ok(lines.length <= Math.max(7, Math.floor(rows * 0.8)), `height ${rows}x${width}: ${lines.length}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${rows}x${width}: ${JSON.stringify(line)}`);
      const plain = stripTerminalSequences(lines.join("\n"));
      for (const slot of ["light", "standard", "strong"]) assert.match(plain, new RegExp(slot), `${rows}x${width}`);
      assert.match(plain, /Alt\+S/);
    }
  }
});

test("the picker frame uses accent chrome and muted sides", () => {
  const colors = [];
  const recording = {
    fg: (color, text) => { colors.push(color); return text; },
    bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, strikethrough: (text) => text,
  };
  const { picker } = fixture({ theme: recording });
  const lines = picker.render(76);
  assert.match(lines[0], /^╭─/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.ok(colors.includes("borderAccent"));
  assert.ok(colors.includes("borderMuted"));
  assert.ok(colors.includes("accent"));
  assert.ok(!colors.includes("border"));
  assert.ok(!colors.includes("dim") || colors.indexOf("borderAccent") < colors.indexOf("dim"),
    "the outer frame is painted before any dim interior text");
});

test("list and detail versions align at the right border", () => {
  for (const width of [60, 76, 110]) {
    const { picker } = fixture();
    const rows = picker.render(width).map(stripTerminalSequences).filter((line) => line.includes("starter-v2"));
    assert.equal(rows.length, 4, "three list rows and the detail heading");
    assert.equal(new Set(rows.map((line) => visibleWidth(line.slice(0, line.indexOf("starter-v2"))))).size, 1);
    assert(rows.every((line) => line.endsWith("starter-v2│")), `versions reach the right border at width ${width}`);
  }
});

test("active marker, version and all exact model IDs follow the highlighted preset", () => {
  const { picker } = fixture();
  let text = picker.render(76).join("\n");
  assert.match(text, /beta.*● active/);
  assert.match(text, /provider\/beta-light/);
  assert.match(text, /provider\/beta-standard/);
  assert.match(text, /provider\/beta-strong/);
  picker.handleInput("\u001b[B");
  text = picker.render(76).join("\n");
  assert.equal(picker.selection(), "gamma");
  assert.match(text, /gamma.*○ inactive/);
  assert.match(text, /provider\/gamma-standard/);
  assert.match(text, /think low→medium/, "explicit compatibility policy is visible before selection");
});

test("off has no routing slots in full or compact layouts and selects by keyboard or pointer", () => {
  const off = offPreset();
  const full = fixture({ presets: [off, preset("alpha")], activeName: "alpha" });
  full.picker.render(76);
  full.picker.handleInput("\u001b[A");
  assert.equal(full.picker.selection(), "off");
  const fullText = stripTerminalSequences(full.picker.render(76).join("\n"));
  assert.match(fullText, /No new, resumed, or steered work\./);
  assert.match(fullText, /Accepted work continues\./);
  assert.doesNotMatch(fullText, /provider\//);
  assert.doesNotMatch(fullText, /light|standard|strong|think/);
  full.picker.handleInput("\r");
  assert.deepEqual(full.result, ["off"]);

  const compact = fixture({ pointer: true, rows: 10, presets: [off], activeName: "off" });
  const lines = compact.picker.render(60).map(stripTerminalSequences);
  const compactText = lines.join("\n"), target = lines.findIndex((line) => line.includes("› off"));
  assert.match(compactText, /No new, resumed, or steered work\./);
  assert.match(compactText, /Accepted work continues\./);
  assert.doesNotMatch(compactText, /provider\//);
  assert.doesNotMatch(compactText, /light|standard|strong|think/);
  assert(target > 0, compactText);
  compact.picker.handleMouse(mouse("click", 5, target));
  assert.deepEqual(compact.result, ["off"]);
});

test("focused Alt+S closes the picker without applying or changing its selection", () => {
  const cancelled = fixture();
  const selected = cancelled.picker.selection();
  cancelled.picker.handleInput("\u001bs");
  cancelled.picker.handleInput("\r");
  assert.equal(cancelled.picker.selection(), selected);
  assert.deepEqual(cancelled.result, [null]);
  assert.match(stripTerminalSequences(fixture().picker.render(76).join("\n")), /Alt\+S close/);
});

test("configured selection keys navigate, page, apply once and cancel without applying", () => {
  const many = Array.from({ length: 18 }, (_, index) => preset(`team-${String(index).padStart(2, "0")}`));
  const applied = fixture({ presets: many, activeName: "team-00" });
  applied.picker.render(50);
  applied.picker.handleInput("\u001b[6~");
  assert.ok(Number(applied.picker.selection().slice(-2)) > 0, "PageDown uses the painted viewport");
  applied.picker.handleInput("\r");
  applied.picker.handleInput("\r");
  assert.deepEqual(applied.result, [applied.picker.selection()], "settlement is idempotent");

  const cancelled = fixture();
  cancelled.picker.handleInput("\u001b");
  assert.deepEqual(cancelled.result, [null]);
  assert.equal(cancelled.tui.renders, 0);
});

test("a floating picker closes from its × and applies a clicked preset like a menu", () => {
  const closing = fixture({ pointer: true });
  let lines = closing.picker.render(76).map(stripTerminalSequences);
  assert.match(lines[0], /^╭─ Worker routing ─+ × ─╮$/);
  assert.equal(closing.picker.handleMouse(mouse("click", 73, 1)).handled, true, "the body swallows clicks");
  assert.deepEqual(closing.result, []);
  closing.picker.handleMouse(mouse("click", lines[0].indexOf("×"), 0));
  assert.deepEqual(closing.result, [null], "× cancels without applying");

  const applying = fixture({ pointer: true });
  lines = applying.picker.render(76).map(stripTerminalSequences);
  const gamma = lines.findIndex((line) => /^│[› ] . gamma /.test(line));
  applying.picker.handleMouse(mouse("click", 10, gamma, { button: "right" }));
  assert.deepEqual(applying.result, [], "only a left click applies");
  applying.picker.handleMouse(mouse("click", 10, gamma));
  applying.picker.handleMouse(mouse("click", 10, gamma));
  assert.deepEqual(applying.result, ["gamma"], "the row on screen is applied, once");

  // Compact layout: the single visible preset row is still a target.
  const compact = fixture({ pointer: true, rows: 10 });
  lines = compact.picker.render(60).map(stripTerminalSequences);
  const current = lines.findIndex((line) => line.includes("› beta"));
  assert(current > 0, lines.join("\n"));
  compact.picker.handleMouse(mouse("click", 5, current));
  assert.deepEqual(compact.result, ["beta"]);
});

test("the wheel moves the highlight; a docked picker leaves the pointer alone", () => {
  const { picker, tui, result } = fixture({ pointer: true });
  picker.render(76);
  assert.deepEqual(picker.handleMouse(mouse("wheel", 5, 5, { wheelDelta: 3 })), { handled: true });
  assert.equal(picker.selection(), "gamma", "one step per wheel event, clamped");
  picker.handleMouse(mouse("wheel", 5, 5, { wheelDelta: -1 }));
  assert.equal(picker.selection(), "beta");
  assert.equal(tui.renders, 2); assert.deepEqual(result, []);

  const docked = fixture();
  const lines = docked.picker.render(76).map(stripTerminalSequences);
  assert(!lines[0].includes("×"), "no pointer, no control to click");
  assert.equal(docked.picker.handleMouse(mouse("click", lines[0].length - 3, 0)), undefined);
  assert.deepEqual(docked.result, []);
});

test("a stacked picker fits the rows left for it and reports what it painted", () => {
  const tui = { terminal: { columns: 120, rows: 40 }, requestRender() {} };
  const presets = Array.from({ length: 12 }, (_, index) => preset(`team-${index}`));
  const heights = [];
  const make = (room) => new PresetPicker({ tui, theme, keybindings: keys, presets, activeName: "team-0", done() {},
    pointer: true, rows: room === undefined ? undefined : () => room, onRender: (height) => heights.push(height) });
  const free = make().render(76).length;
  assert.equal(free, 22, "unconstrained, the terminal share decides");
  for (const room of [16, 11, 9]) {
    const lines = make(room).render(76);
    assert.equal(heights.at(-1), lines.length);
    assert.ok(lines.length <= room, `${room} rows: ${lines.length}`);
  }
});

test("all configured presets show versions, including fixture names and overridden selections", () => {
  const builtIn = { ...preset("fixture-balanced", "fixture-v3"), effort_overrides: { light: "high" } };
  const { picker } = fixture({ presets: [builtIn, preset("fixture-light", "fixture-v1"),
    { ...preset("mine", "v7"), effort_overrides: { strong: "low" } }], activeName: "fixture-balanced" });
  const text = picker.render(76).map(stripTerminalSequences);
  assert(text.some((line) => line.includes("fixture-v3")), text.join("\n"));
  assert(text.some((line) => line.includes("fixture-v1")), text.join("\n"));
  assert(text.some((line) => line.includes("fixture-balanced*")), text.join("\n"));
  assert(text.some((line) => line.includes("mine*") && line.endsWith("v7│")), text.join("\n"));
  const compact = fixture({ rows: 10, presets: [builtIn], activeName: "fixture-balanced" });
  const row = compact.picker.render(60).map(stripTerminalSequences).find((line) => line.includes("› fixture-balanced*"));
  assert(row.endsWith("fixture-v3 · 1/1│"), row);
});

const effortPreset = (name = "alpha") => ({ ...preset(name),
  effort: { light: "high", standard: "inherit", strong: "low" },
  effort_defaults: { light: "high", standard: "inherit", strong: "low" },
  effort_overrides: { light: "high" },
});
const effortCaps = (_preset, slot) => ({ levels: slot === "strong" ? ["off", "low", "high"] : ["off", "low", "medium", "high"],
  inherited: slot === "strong" ? "low" : "medium" });
const painted = (picker, width = 76) => picker.render(width).map(stripTerminalSequences);
const clickText = (picker, label, width = 76) => {
  const lines = painted(picker, width);
  const y = lines.findIndex((line) => line.includes(label));
  assert(y >= 0, `missing clickable ${label}: ${lines.join("\n")}`);
  picker.handleMouse(mouse("click", lines[y].indexOf(label), y));
};

test("legacy hosts remain read-only, while editor stages independent overrides and discards on Esc", () => {
  const selected = effortPreset();
  const legacy = fixture({ presets: [selected] });
  legacy.picker.handleInput("e");
  assert.doesNotMatch(painted(legacy.picker).join("\n"), /Apply & enable|R reset/);
  legacy.picker.handleInput("\r");
  assert.deepEqual(legacy.result, ["alpha"]);

  const original = structuredClone(selected);
  const edit = fixture({ presets: [selected], activeName: "alpha", efforts: effortCaps });
  assert.match(painted(edit.picker).join("\n"), /light.*high\*/);
  edit.picker.handleInput("e");
  let text = painted(edit.picker).join("\n");
  assert.match(text, /New Agents only; main unchanged/);
  assert.match(text, /source: preset defaults \+ session overrides/);
  assert.match(text, /default: high · inherit → medium/);
  assert.match(text, /Apply/);
  edit.picker.handleInput("\u001b[C"); // high override -> next supported level, bounded at high
  edit.picker.handleInput("\u001b[D"); // medium
  assert.match(painted(edit.picker).join("\n"), /light:medium/);
  edit.picker.handleInput("\u001b"); // discard, return to list
  assert.equal(edit.picker.selection(), "alpha");
  assert.match(painted(edit.picker).join("\n"), /light.*high\*/);
  assert.deepEqual(selected, original);
  edit.picker.handleInput("e");
  edit.picker.handleInput("\u001b[D"); // high -> medium
  edit.picker.handleInput("\r");
  assert.deepEqual(edit.result, [{ name: "alpha", effort_overrides: { light: "medium" } }]);
  assert.deepEqual(selected, original, "the committed draft is a copy, never an edit of a snapshot");
});

test("pointer controls edit, step, reset and apply; inactive selection enables without selecting early", () => {
  const selected = effortPreset();
  const { picker, result } = fixture({ pointer: true, presets: [selected], activeName: "elsewhere", efforts: effortCaps });
  clickText(picker, "Edit effort");
  let lines = painted(picker);
  assert.match(lines.join("\n"), /Apply & enable/);
  const y = lines.findIndex((line) => line.includes("‹light:high›"));
  assert(y > 0);
  picker.handleMouse(mouse("click", lines[y].indexOf("‹"), y));
  assert.match(painted(picker).join("\n"), /light:medium/);
  clickText(picker, "R reset");
  lines = painted(picker);
  assert.match(lines.join("\n"), /light:default/);
  const defaultRow = lines.findIndex((line) => line.includes("‹light:default›"));
  picker.handleMouse(mouse("click", lines[defaultRow].indexOf("default"), defaultRow));
  assert.match(painted(picker).join("\n"), /light:default/, "clicking the value only selects the slot");
  lines = painted(picker);
  picker.handleMouse(mouse("click", lines[defaultRow].indexOf("›", lines[defaultRow].indexOf("‹")), defaultRow));
  assert.match(painted(picker).join("\n"), /light:inherit/, "clicking the painted next arrow adjusts");
  clickText(picker, "R reset");
  assert.deepEqual(result, [], "reset is still a draft until Apply");
  clickText(picker, "Apply & enable");
  assert.deepEqual(result, [{ name: "alpha", effort_overrides: {} }]);

  const back = fixture({ pointer: true, presets: [selected], efforts: effortCaps });
  clickText(back.picker, "Edit effort");
  clickText(back.picker, "Esc back");
  assert.deepEqual(back.result, []);
  assert.match(painted(back.picker).join("\n"), /Worker routing/);
  clickText(back.picker, "Edit effort");
  const top = painted(back.picker)[0];
  back.picker.handleMouse(mouse("click", top.indexOf("×"), 0));
  assert.deepEqual(back.result, [null], "× cancels the whole picker from either page");
});

test("effort row label, value, model and blank clicks select only; the painted arrows alone adjust", () => {
  const { picker, result } = fixture({ pointer: true, presets: [effortPreset()], activeName: "alpha", efforts: effortCaps });
  picker.handleInput("e");
  picker.handleInput("\u001b[B"); // select standard, then select light by mouse
  for (const target of ["light", "high", "provider/alpha-light"]) {
    const lines = painted(picker);
    const y = lines.findIndex((line) => line.includes("‹light:high›"));
    assert(y >= 0, lines.join("\n"));
    picker.handleMouse(mouse("click", lines[y].indexOf(target), y));
    assert.match(painted(picker)[y], /›‹light:high›/, `${target} selects light without editing it`);
  }
  let lines = painted(picker);
  let y = lines.findIndex((line) => line.includes("‹light:high›"));
  picker.handleMouse(mouse("click", 74, y)); // padding beyond the model
  assert.match(painted(picker)[y], /light:high/);
  lines = painted(picker); y = lines.findIndex((line) => line.includes("‹light:high›"));
  picker.handleMouse(mouse("click", lines[y].indexOf("‹"), y));
  assert.match(painted(picker)[y], /light:medium/);
  lines = painted(picker); y = lines.findIndex((line) => line.includes("‹light:medium›"));
  picker.handleMouse(mouse("click", lines[y].indexOf("›", lines[y].indexOf("‹")), y));
  assert.match(painted(picker)[y], /light:high/);
  picker.handleInput("\r");
  assert.deepEqual(result, [{ name: "alpha", effort_overrides: { light: "high" } }]);
});

test("clipped effort arrows never create invisible pointer controls at narrow widths", () => {
  for (const width of [8, 10, 12, 14, 18, 34]) {
    const { picker } = fixture({ pointer: true, rows: 8, presets: [effortPreset()], efforts: effortCaps });
    picker.handleInput("e");
    picker.handleInput("\u001b[D"); // medium; next arrow should return to high if visible
    const lines = painted(picker, width);
    const y = lines.findIndex((line) => line.includes("‹"));
    assert(y > 0, lines.join("\n"));
    const prev = lines[y].indexOf("‹"), next = lines[y].indexOf("›", prev + 1);
    picker.handleMouse(mouse("click", width + 3, y)); // theoretical offscreen next arrow
    assert.match(painted(picker, 76).join("\n"), /‹light:medium›/, `offscreen click at ${width}`);
    const narrow = painted(picker, width);
    picker.handleMouse(mouse("click", width - 1, y)); // right border, not an arrow
    assert.match(painted(picker, 76).join("\n"), /‹light:medium›/, `border click at ${width}`);
    if (next < 0) {
      assert(!narrow[y].includes("›", prev + 1), `next is clipped at ${width}`);
    } else {
      painted(picker, width); // restore narrow pointer targets after wider inspection
      picker.handleMouse(mouse("click", next, y));
      assert.match(painted(picker, 76).join("\n"), /‹light:high›/, `visible next arrow at ${width}`);
    }
  }
});

test("Off never enters an effort editor; Alt+S cancels the whole edit draft", () => {
  const off = fixture({ presets: [offPreset()], activeName: "off", efforts: effortCaps });
  off.picker.handleInput("e");
  assert.doesNotMatch(painted(off.picker).join("\n"), /Apply & enable|R reset/);
  off.picker.handleInput("\r");
  assert.deepEqual(off.result, ["off"]);

  const cancelled = fixture({ presets: [effortPreset()], efforts: effortCaps });
  cancelled.picker.handleInput("e");
  cancelled.picker.handleInput("\u001b[D");
  cancelled.picker.handleInput("\u001bs");
  assert.deepEqual(cancelled.result, [null]);
});

test("default and explicit inherit remain distinct even when default is literal inherit", () => {
  const selected = effortPreset();
  const { picker, result } = fixture({ presets: [selected], activeName: "alpha", efforts: effortCaps });
  picker.handleInput("e");
  picker.handleInput("\u001b[B"); // standard configured default inherit
  assert.match(painted(picker).join("\n"), /default: inherit · inherit → medium/);
  picker.handleInput("\u001b[C"); // stage explicit inherit, not deletion
  assert.match(painted(picker).join("\n"), /standard:inherit/);
  picker.handleInput("\r");
  assert.deepEqual(result, [{ name: "alpha", effort_overrides: { light: "high", standard: "inherit" } }]);
});

test("unsupported fixed effort and missing fixed model block Apply, independently of inheritance previews", () => {
  const selected = { ...effortPreset(), effort_overrides: { light: "max", standard: "inherit" } };
  let unavailable = false;
  const caps = (_preset, slot) => slot === "light" ? { levels: ["low", "high"], inherited: "low" } :
    slot === "standard" ? { levels: ["off", "low", "high"], inheritError: "Parent thinking unavailable" } :
      unavailable ? { levels: [], error: "Missing model" } : { levels: ["low", "high"], inherited: "low" };
  const { picker, result } = fixture({ presets: [selected], efforts: caps });
  picker.handleInput("e");
  assert.match(painted(picker).join("\n"), /Unsupported effort: max/);
  picker.handleInput("\r"); assert.deepEqual(result, []);
  picker.handleInput("\u001b[D"); // invalid -> preset default high
  picker.handleInput("\u001b[B"); // standard
  assert.match(painted(picker).join("\n"), /Parent thinking unavailable/);
  picker.handleInput("\u001b[C"); // explicit inherit -> off fixed, supported despite inherit error
  unavailable = true;
  assert.match(painted(picker).join("\n"), /Missing model/);
  picker.handleInput("\r"); assert.deepEqual(result, []);
  unavailable = false;
  picker.handleInput("\r");
  assert.deepEqual(result, [{ name: "alpha", effort_overrides: { standard: "off" } }]);
});

test("inherit warnings never block editing another slot, explicit inherit, or resetting to inherited defaults", () => {
  const inherited = { light: "inherit", standard: "inherit", strong: "inherit" };
  for (const warning of [
    { levels: ["high"], inheritError: "Parent off is unsupported" },
    { levels: ["high"], inheritError: "Parent thinking unavailable" },
    { levels: [], error: "Missing model" },
    { levels: [], error: "Ambiguous model" },
  ]) {
    const selected = { ...preset("alpha"), effort: { ...inherited }, effort_defaults: { ...inherited }, effort_overrides: {} };
    const caps = (_preset, slot) => slot === "light" ? { levels: ["high"], inherited: "high" } : warning;
    const { picker, result } = fixture({ presets: [selected], efforts: caps });
    picker.handleInput("e");
    picker.handleInput("\u001b[C"); // default -> explicit inherit
    picker.handleInput("\u001b[C"); // -> high
    const text = painted(picker, 120).join("\n");
    assert.match(text, /Preview only; checked at spawn/);
    assert.doesNotMatch(text, /Cannot apply/);
    picker.handleInput("\r");
    assert.deepEqual(result, [{ name: "alpha", effort_overrides: { light: "high" } }]);

    const reset = fixture({ presets: [{ ...selected, effort_overrides: { standard: "max" } }], efforts: caps });
    reset.picker.handleInput("e"); reset.picker.handleInput("\r");
    assert.deepEqual(reset.result, [], "a fixed unsupported value still blocks Apply");
    reset.picker.handleInput("r"); reset.picker.handleInput("\r");
    assert.deepEqual(reset.result, [{ name: "alpha", effort_overrides: {} }]);

    const explicit = fixture({ presets: [selected], efforts: caps });
    explicit.picker.handleInput("e"); explicit.picker.handleInput("\u001b[B");
    explicit.picker.handleInput("\u001b[C"); explicit.picker.handleInput("\r");
    assert.deepEqual(explicit.result, [{ name: "alpha", effort_overrides: { standard: "inherit" } }]);
  }
});

test("compact/narrow editor keeps three editable rows, bounded paint and live controls", () => {
  for (const rows of [8, 10, 12, 24]) for (const width of [18, 34, 76, 120]) {
    const { picker, result } = fixture({ pointer: true, rows, presets: [effortPreset()], activeName: "alpha",
      efforts: effortCaps });
    picker.handleInput("e");
    let lines = painted(picker, width);
    assert(lines.length <= Math.max(7, Math.floor(rows * 0.8)), `${rows}x${width}`);
    assert(lines.every((line) => visibleWidth(line) <= width), `${rows}x${width}: ${lines.join("\n")}`);
    assert.match(lines.join("\n"), /light:high/);
    assert.match(lines.join("\n"), /Apply/);
    const value = lines.findIndex((line) => line.includes("‹light:high›"));
    assert(value > 0, lines.join("\n"));
    picker.handleMouse(mouse("click", lines[value].indexOf("‹"), value));
    lines = painted(picker, width);
    assert.match(lines.join("\n"), /light:medium/);
    clickText(picker, "Apply", width);
    assert.deepEqual(result, [{ name: "alpha", effort_overrides: { light: "medium" } }]);
  }
});
