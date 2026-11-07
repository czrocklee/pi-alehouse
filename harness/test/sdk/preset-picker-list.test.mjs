import {
  InteractiveMode,
  tick,
  theme,
  keys,
  preset,
  offPreset,
  fixture,
  mouse,
  emptyOwnerPanels,
  effortCaps,
  painted,
  managementOption,
} from "../support/preset-picker-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { strengths } from "../../dist/routing.js";
import { PresetPicker, PresetPickerRequest } from "../../dist/ui/preset-picker.js";
import { joinPopoverStack, stackedOverlayOptions } from "../../../lib/popover-stack.mjs";
import {
  FOOTER_INDICATOR_CLICK_EVENT,
  WORKER_PRESET_INDICATOR,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
} from "../../../lib/overlay-protocol.mjs";

for (const order of [
  ["usage", "approval", "workers"],
  ["usage", "workers", "approval"],
  ["approval", "usage", "workers"],
  ["approval", "workers", "usage"],
  ["workers", "usage", "approval"],
  ["workers", "approval", "usage"],
]) {
  test(`fresh empty Owner stacks workers at shared width via actual SDK: ${order.join(" → ")}`, async (t) => {
    const h = emptyOwnerPanels(t),
      others = new Map();
    const clearOthers = () => {
      for (const { handle, member } of others.values()) {
        handle.hide();
        member.leave();
      }
    };
    h.bus.on(HIDE_TRANSIENT_OVERLAYS_EVENT, clearOthers);
    t.after(clearOthers);
    h.panels.attachHost(h.ctx, h.bus);
    for (const name of order) {
      if (name === "workers") {
        h.click();
        await tick();
      } else {
        const member = joinPopoverStack(h.tui),
          height = name === "usage" ? 5 : 7;
        const component = {
          render(width) {
            member.measure(height);
            return Array(height).fill("x".repeat(width));
          },
          invalidate() {},
        };
        const handle = h.tui.showOverlay(
          component,
          stackedOverlayOptions(member, { width: name === "usage" ? 52 : 68, nonCapturing: true }),
        );
        others.set(name, { handle, member });
      }
      h.paint();
    }
    const mount = h.mounts[0];
    assert.equal(
      mount.options.overlay,
      true,
      "first open must float even though no Agent widget ever supplied a mode",
    );
    assert.equal(
      h.widget.tuiMode(),
      undefined,
      "opening routing must not manufacture an Agent row",
    );
    assert.deepEqual(
      h.widgets.map(({ key }) => key),
      ["harness-panel-host"],
    );
    assert.deepEqual(h.host.extensionWidgetsAbove.get("harness-panel-host").render(120), []);
    assert.equal(
      h.host.widgetContainerAbove.render(120).length,
      1,
      "only the SDK's existing spacer, no extra visible row",
    );
    assert.equal(
      h.host.editorContainer.children[0],
      h.host.editor,
      "the picker must not replace the editor",
    );
    assert.equal(h.tui.getFocusedComponent(), mount.component);
    for (const columns of [120, 42, 160]) {
      h.terminal.columns = columns;
      h.paint();
      const bounds = order.map((name) =>
        (name === "workers" ? mount : others.get(name)).handle.getBounds(),
      );
      let bottom = h.terminal.rows - 1;
      for (const box of bounds) {
        assert.equal(box.width, Math.min(76, columns));
        assert.equal(box.col + box.width, columns);
        assert.equal(box.row + box.height, bottom, "opening order, without gaps or overlap");
        bottom = box.row;
      }
    }
    for (const component of h.host.extensionWidgetsAbove.values()) component.invalidate();
    h.click();
    await tick();
    assert.equal(mount.handle.getBounds(), undefined);
    assert.deepEqual(h.published, [], "close must not select a preset");
    const reopening = h.shortcuts.get("alt+s").handler();
    await tick();
    h.paint();
    assert.equal(h.mounts[1].options.overlay, true, "idle reopen via keyboard still floats");
    assert.equal(h.mounts[1].handle.getBounds().width, 76);
    h.panels.dispose();
    await reopening;
    assert.equal(h.host.extensionWidgetsAbove.size, 0, "shutdown removes the invisible host too");
    assert.equal(h.widgets.filter(({ content }) => content === undefined).length, 1);
  });
}

for (const mode of ["regular", "unknown"])
  test(`empty Owner keeps ${mode} renderer routing docked`, async (t) => {
    const h = emptyOwnerPanels(t, "regular");
    if (mode === "unknown") h.tui.mode = undefined;
    h.panels.attachHost(h.ctx, h.bus);
    const opening = h.shortcuts.get("alt+s").handler();
    await tick();
    const mount = h.mounts[0];
    assert.equal(mount.options.overlay, false);
    assert.equal(mount.handle, undefined);
    assert.equal(h.host.editorContainer.children[0], mount.component);
    assert.doesNotMatch(stripTerminalSequences(mount.component.render(120)[0]), /×/);
    mount.component.handleInput("\u001b");
    await opening;
    assert.equal(h.host.editorContainer.children[0], h.host.editor);
  });

for (const fault of ["mount", "clear"])
  test(`panel host cleanup survives a partially applied ${fault} failure`, (t) => {
    const h = emptyOwnerPanels(t),
      notices = [];
    const setWidget = h.ctx.ui.setWidget;
    h.ctx.ui.notify = (message) => notices.push(message);
    h.ctx.ui.setWidget = (...args) => {
      setWidget(...args);
      if ((fault === "mount") === (args[1] !== undefined)) throw new Error("HOST_WIDGET_FAILURE");
    };
    if (fault === "mount")
      assert.throws(() => h.panels.attachHost(h.ctx, h.bus), /HOST_WIDGET_FAILURE/);
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
  const before = new PresetPickerRequest(() => beforeNotices++),
    early = [];
  before.close();
  assert.equal(
    before.mount((value) => early.push(value), false),
    false,
  );
  before.choose("alpha");
  assert.deepEqual(early, [null]);
  assert.equal(
    beforeNotices,
    2,
    "deferred cancellation coordinates immediately and again before Pi closes the dequeued factory",
  );

  let mountedNotices = 0;
  const mounted = new PresetPickerRequest(() => mountedNotices++),
    values = [];
  assert.equal(
    mounted.mount((value) => values.push(value), false),
    true,
  );
  mounted.choose("beta");
  mounted.close();
  mounted.choose("gamma");
  assert.deepEqual(values, ["beta"]);
  assert.equal(mountedNotices, 1, "apply coordinates overlays once");

  let blockedNotices = 0;
  const blocked = new PresetPickerRequest(() => blockedNotices++),
    denied = [];
  assert.equal(
    blocked.mount((value) => denied.push(value), true),
    false,
  );
  assert.deepEqual(denied, [null]);
  assert.equal(blockedNotices, 1, "a blocked factory coordinates overlays once");
});

for (const trigger of ["approval", "shutdown"]) {
  test(`a newer transient overlay cannot strand the picker during ${trigger}`, async () => {
    const layers = [];
    const editor = { getText: () => "draft", setText: () => {} };
    let focus = editor,
      doneCalls = 0,
      transientHides = 0,
      commits = 0;
    const tui = {
      requestRender() {},
      setFocus(component) {
        focus = component;
      },
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
      editor,
      ui: tui,
      keybindings: {},
      disposeActiveSelector() {},
      editorContainer: { clear() {}, addChild() {} },
    };
    let transient;
    const request = new PresetPickerRequest(() => {
      transientHides++;
      transient?.hide();
    });
    const picker = { render: () => ["picker"], invalidate() {} };
    const opening = InteractiveMode.prototype.showExtensionCustom.call(
      host,
      (_tui, _theme, _keys, done) => {
        assert.equal(
          request.mount((value) => {
            doneCalls++;
            done(value);
          }, false),
          true,
        );
        return picker;
      },
      { overlay: true },
    );
    await tick();
    assert.deepEqual(
      layers.map(({ component }) => component),
      [picker],
    );

    const footer = { render: () => ["footer"], invalidate() {} };
    transient = tui.showOverlay(footer, { nonCapturing: true });
    assert.deepEqual(
      layers.map(({ component }) => component),
      [picker, footer],
    );
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
      assert.deepEqual(
        layers.map(({ component }) => component),
        [approval],
      );
      assert.equal(focus, approval, "the approval retains focus after picker cleanup");
    }
  });
}

test("preset dashboard fits narrow, normal and wide terminals without hiding slot identities", () => {
  const long = preset(
    "custom-preset-name-that-is-intentionally-long-for-a-small-terminal",
    "2026-10-01-release",
    "model-id-that-is-also-intentionally-long",
  );
  for (const rows of [8, 12, 24]) {
    for (const width of [18, 34, 76, 120]) {
      const { picker } = fixture({ rows, presets: [long], activeName: long.name });
      const lines = picker.render(width);
      assert.ok(
        lines.length <= Math.max(7, Math.floor(rows * 0.8)),
        `height ${rows}x${width}: ${lines.length}`,
      );
      for (const line of lines)
        assert.ok(visibleWidth(line) <= width, `${rows}x${width}: ${JSON.stringify(line)}`);
      const plain = stripTerminalSequences(lines.join("\n"));
      const seen = new Set();
      for (let index = 0; index < strengths.length; index++) {
        const frame = picker.render(width).map(stripTerminalSequences).join("\n");
        for (const slot of strengths) if (frame.includes(slot)) seen.add(slot);
        picker.handleInput("\t");
      }
      assert.deepEqual([...seen].sort(), strengths, `${rows}x${width}: Tab reaches all five slots`);
      assert.match(plain, /Alt\+S/);
    }
  }
});

test("the picker frame uses accent chrome and muted sides", () => {
  const colors = [];
  const recording = {
    fg: (color, text) => {
      colors.push(color);
      return text;
    },
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
  };
  const { picker } = fixture({ theme: recording });
  const lines = picker.render(76);
  assert.match(lines[0], /^╭─/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.ok(colors.includes("borderAccent"));
  assert.ok(colors.includes("borderMuted"));
  assert.ok(colors.includes("accent"));
  assert.ok(!colors.includes("border"));
  assert.ok(
    !colors.includes("dim") || colors.indexOf("borderAccent") < colors.indexOf("dim"),
    "the outer frame is painted before any dim interior text",
  );
});

test("list and detail versions align at the right border", () => {
  for (const width of [60, 76, 110]) {
    const { picker } = fixture();
    const rows = picker
      .render(width)
      .map(stripTerminalSequences)
      .filter((line) => line.includes("starter-v2"));
    assert.equal(rows.length, 4, "three list rows and the detail heading");
    assert.equal(
      new Set(rows.map((line) => visibleWidth(line.slice(0, line.indexOf("starter-v2"))))).size,
      1,
    );
    assert(
      rows.every((line) => line.endsWith("starter-v2│")),
      `versions reach the right border at width ${width}`,
    );
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
  assert.doesNotMatch(text, /think |→/, "auto-preview prints no config map");
  assert.match(text, /d1.*inherit/, "the slot row shows only the current effective level");
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
  assert.doesNotMatch(fullText, /d[1-5]|think/);
  full.picker.handleInput("\r");
  assert.deepEqual(full.result, ["off"]);

  const compact = fixture({ pointer: true, rows: 10, presets: [off], activeName: "off" });
  const lines = compact.picker.render(60).map(stripTerminalSequences);
  const compactText = lines.join("\n"),
    target = lines.findIndex((line) => line.includes("› off"));
  assert.match(compactText, /No new, resumed, or steered work\./);
  assert.match(compactText, /Accepted work continues\./);
  assert.doesNotMatch(compactText, /provider\//);
  assert.doesNotMatch(compactText, /d[1-5]|think/);
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
  const many = Array.from({ length: 18 }, (_, index) =>
    preset(`team-${String(index).padStart(2, "0")}`),
  );
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
  assert.match(lines[0], /^╭─ Delegation ─+ × ─╮$/);
  assert.equal(
    closing.picker.handleMouse(mouse("click", 73, 1)).handled,
    true,
    "the body swallows clicks",
  );
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
  assert.equal(tui.renders, 2);
  assert.deepEqual(result, []);

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
  const make = (room) =>
    new PresetPicker({
      tui,
      theme,
      keybindings: keys,
      presets,
      activeName: "team-0",
      done() {},
      pointer: true,
      rows: room === undefined ? undefined : () => room,
      onRender: (height) => heights.push(height),
    });
  const free = make().render(76).length;
  assert.equal(free, 24, "unconstrained, the five-slot detail decides");
  for (const room of [16, 11, 9]) {
    const lines = make(room).render(76);
    assert.equal(heights.at(-1), lines.length);
    assert.ok(lines.length <= room, `${room} rows: ${lines.length}`);
  }
});

test("all configured presets show versions, including fixture names and overridden selections", () => {
  const builtIn = { ...preset("fixture-balanced", "fixture-v3"), effort_overrides: { d1: "high" } };
  const { picker } = fixture({
    presets: [
      builtIn,
      preset("fixture-light", "fixture-v1"),
      { ...preset("mine", "v7"), effort_overrides: { d5: "low" } },
    ],
    activeName: "fixture-balanced",
  });
  const text = picker.render(76).map(stripTerminalSequences);
  assert(
    text.some((line) => line.includes("fixture-v3")),
    text.join("\n"),
  );
  assert(
    text.some((line) => line.includes("fixture-v1")),
    text.join("\n"),
  );
  assert(
    text.some((line) => line.includes("fixture-balanced*")),
    text.join("\n"),
  );
  assert(
    text.some((line) => line.includes("mine*") && line.endsWith("v7│")),
    text.join("\n"),
  );
  const compact = fixture({ rows: 10, presets: [builtIn], activeName: "fixture-balanced" });
  const row = compact.picker
    .render(60)
    .map(stripTerminalSequences)
    .find((line) => line.includes("› fixture-balanced*"));
  assert(row.endsWith("fixture-v3 · 1/1│"), row);
});

for (const movement of ["keyboard", "wheel"]) {
  test(`model mouse targets keep their painted preset before a ${movement} repaint`, () => {
    const h = fixture({
      rows: 40,
      activeName: "alpha",
      pointer: true,
      management: managementOption({ models: true }),
    });
    const lines = painted(h.picker, 76);
    const y = lines.findIndex((line) => line.includes("provider/alpha-light"));
    assert(y > 0);
    const x = lines[y].indexOf("provider/alpha-light");
    if (movement === "keyboard") h.picker.handleInput("\u001b[B");
    else h.picker.handleMouse(mouse("wheel", x, y, { wheelDelta: 1 }));
    assert.equal(h.picker.selection(), "beta");
    h.picker.handleMouse(mouse("click", x, y)); // No repaint: alpha is still displayed.
    assert.deepEqual(h.result, [{ action: "edit-model", name: "alpha", slot: "d1" }]);
  });
}

test("digits 1–5 route the highlighted preset's independent slot models on the list page only", () => {
  for (const [index, slot] of strengths.entries()) {
    const key = String(index + 1);
    const routed = fixture({ management: managementOption({ models: true }) });
    routed.picker.render(76);
    routed.picker.handleInput(key);
    assert.deepEqual(
      routed.result,
      [{ action: "edit-model", name: "beta", slot }],
      `${key} routes ${slot}`,
    );
  }
  const off = fixture({
    management: managementOption({ models: true }),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  off.picker.render(76);
  off.picker.handleInput("\u001b[A"); // highlight off
  off.picker.handleInput("1");
  assert.deepEqual(off.result, [], "off is a control state with no slot models");
  const legacy = fixture({ management: managementOption() });
  legacy.picker.render(76);
  legacy.picker.handleInput("1");
  assert.deepEqual(legacy.result, [], "without the models gate the digits are inert");
  const editing = fixture({ management: managementOption({ models: true }), efforts: effortCaps });
  editing.picker.handleInput("e");
  editing.picker.handleInput("1");
  assert.deepEqual(editing.result, [], "the effort editor keeps its own keys");
});

test("painted model text is the only click target; labels, values and ellipses are not", () => {
  const full = fixture({ pointer: true, management: managementOption({ models: true }) });
  let lines = painted(full.picker, 76);
  let y = lines.findIndex((line) => line.includes("provider/beta-light"));
  assert(y > 0, lines.join("\n"));
  full.picker.handleMouse(
    mouse("click", lines[y].indexOf("provider/beta-light") - 1, y, { screenX: 40, screenY: 12 }),
  ); // the space before the model: not a target
  assert.deepEqual(full.result, []);
  full.picker.handleMouse(
    mouse("click", lines[y].indexOf("provider/beta-light"), y, { screenX: 40, screenY: 12 }),
  );
  assert.deepEqual(
    full.result,
    [{ action: "edit-model", name: "beta", slot: "d1", position: { row: 12, col: 40 } }],
    "a model click routes the slot with the pointer's absolute position",
  );

  const noScreen = fixture({ pointer: true, management: managementOption({ models: true }) });
  lines = painted(noScreen.picker, 76);
  y = lines.findIndex((line) => line.includes("provider/beta-standard"));
  noScreen.picker.handleMouse(mouse("click", lines[y].indexOf("provider/beta-standard"), y));
  assert.deepEqual(
    noScreen.result,
    [{ action: "edit-model", name: "beta", slot: "d3" }],
    "without screen coordinates the route carries no position, so the host centers its popover",
  );

  const value = fixture({ pointer: true, management: managementOption({ models: true }) });
  lines = painted(value.picker, 76);
  y = lines.findIndex((line) => line.includes("provider/beta-strong"));
  value.picker.handleMouse(mouse("click", lines[y].indexOf("inherit"), y));
  assert.deepEqual(value.result, [], "the effective level on the right is not a model target");

  // A truncated row keeps a target for exactly the painted prefix, never the ellipsis.
  const clipped = fixture({ pointer: true, management: managementOption({ models: true }) });
  lines = painted(clipped.picker, 30);
  y = lines.findIndex((line) => line.includes("provider/"));
  assert(y > 0, lines.join("\n"));
  assert(lines[y].includes("…"), "the model text is clipped at this width");
  const start = lines[y].indexOf("provider/");
  clipped.picker.handleMouse(mouse("click", start, y, { screenX: 7, screenY: 4 }));
  assert.deepEqual(
    clipped.result,
    [{ action: "edit-model", name: "beta", slot: "d5", position: { row: 4, col: 7 } }],
    "the painted prefix is a target",
  );
  clipped.result.length = 0;
  clipped.picker.handleMouse(mouse("click", start + 9, y, { screenX: 20, screenY: 4 })); // the ellipsis column
  assert.deepEqual(clipped.result, [], "the ellipsis itself is not model text");

  // The compact layout's slot rows are the same targets.
  const compact = fixture({
    pointer: true,
    management: managementOption({ models: true }),
    rows: 10,
  });
  lines = painted(compact.picker, 60);
  y = lines.findIndex((line) => line.includes("provider/beta-strong"));
  assert(y > 0, lines.join("\n"));
  compact.picker.handleMouse(
    mouse("click", lines[y].indexOf("provider/beta-strong"), y, { screenX: 2, screenY: 30 }),
  );
  assert.deepEqual(compact.result, [
    { action: "edit-model", name: "beta", slot: "d5", position: { row: 30, col: 2 } },
  ]);

  // Read-only hosts keep the old behavior: model text never routes.
  const readOnly = fixture({ pointer: true, management: managementOption() });
  lines = painted(readOnly.picker, 76);
  y = lines.findIndex((line) => line.includes("provider/beta-light"));
  readOnly.picker.handleMouse(mouse("click", lines[y].indexOf("provider/beta-light"), y));
  assert.deepEqual(readOnly.result, [], "without the models gate a model click is not a route");

  // Below the model tier nothing is painted, so nothing is clickable.
  const minimum = fixture({ pointer: true, management: managementOption({ models: true }) });
  lines = painted(minimum.picker, 24);
  assert(!lines.join("\n").includes("provider/"), "no model text survives this width");
  minimum.picker.handleMouse(
    mouse(
      "click",
      11,
      lines.findIndex((line) => line.includes("d1:")),
    ),
  );
  assert.deepEqual(minimum.result, []);
});

test("the controls hint mentions the model digits only while the gate and the room allow it", () => {
  const wide = fixture({ management: managementOption({ models: true }) });
  assert.match(painted(wide.picker, 120).join("\n"), /1\/2\/3\/4\/5 model/);
  assert.match(
    painted(wide.picker, 76).join("\n"),
    / · 12345/,
    "a shorter hint appears when the full one cannot fit",
  );
  const narrow = painted(fixture({ management: managementOption({ models: true }) }).picker, 26);
  assert.doesNotMatch(
    narrow.join("\n"),
    /12345/,
    "no hint without room, but the keys stay reachable",
  );
  const off = fixture({
    management: managementOption({ models: true }),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  off.picker.render(76);
  off.picker.handleInput("\u001b[A"); // highlight off
  assert.doesNotMatch(
    painted(off.picker, 120).join("\n"),
    /1\/2\/3\/4\/5 model| · 12345/,
    "off highlights no model hint",
  );
  const legacy = fixture({ management: managementOption() });
  assert.doesNotMatch(
    painted(legacy.picker, 120).join("\n"),
    /1\/2\/3\/4\/5 model| · 12345/,
    "no gate, no hint",
  );
});

test("a CJK model clipped at a wide-character boundary never makes the ellipsis or padding clickable", () => {
  const cjk = {
    ...preset("cjk"),
    models: { ...preset("cjk").models, d1: `fixture/${"中".repeat(10)}` },
  };
  const clipped = fixture({
    pointer: true,
    management: managementOption({ models: true }),
    presets: [cjk],
    activeName: "cjk",
  });
  const lines = painted(clipped.picker, 38);
  const y = lines.findIndex((line) => /d1\s+fixture\//.test(line));
  assert(y > 0, lines.join("\n"));
  const line = lines[y];
  assert(line.includes("…"), "the model is clipped at this width");
  const modelStart = line.indexOf("fixture/");
  const ellipsis = line.indexOf("…");
  assert.equal(
    visibleWidth(line.slice(modelStart, ellipsis)),
    16,
    "four double-width characters fit; the fifth would cross the boundary",
  );
  // The dropped wide character leaves the fitted row shorter than its room:
  // only real model columns may answer, not the ellipsis or the padding.
  clipped.picker.handleMouse(mouse("click", modelStart, y, { screenX: 0, screenY: 5 }));
  assert.deepEqual(
    clipped.result,
    [{ action: "edit-model", name: "cjk", slot: "d1", position: { row: 5, col: 0 } }],
    "a painted model character is a target",
  );
  clipped.result.length = 0;
  clipped.picker.handleMouse(mouse("click", ellipsis, y));
  clipped.picker.handleMouse(mouse("click", ellipsis + 1, y));
  clipped.picker.handleMouse(mouse("click", ellipsis + 2, y));
  assert.deepEqual(clipped.result, [], "the ellipsis and the padding never route");
});
