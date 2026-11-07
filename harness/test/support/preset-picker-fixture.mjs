import assert from "node:assert/strict";
import {
  Container,
  matchesKey,
  stripTerminalSequences,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";
import { delegationGuideline } from "../../dist/delegation.js";
import { PresetRouter, strengths, thinkingLevels } from "../../dist/routing.js";
import { PresetPicker } from "../../dist/ui/preset-picker.js";
import { PanelCoordinator } from "../../dist/ui/panel-coordinator.js";
import {
  FOOTER_INDICATOR_CLICK_EVENT,
  WORKER_PRESET_INDICATOR,
} from "../../../lib/overlay-protocol.mjs";
import { starterPath } from "./preset-config.mjs";

// Exercise Pi's real ui.custom completion: overlays close their own handle,
// while inline dialogs use the SDK's editor-slot stack.
export const { InteractiveMode } = await import(
  new URL(
    "modes/interactive/interactive-mode.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  )
);

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
};

export const keys = {
  matches(data, binding) {
    const map = {
      "tui.select.up": "up",
      "tui.select.down": "down",
      "tui.select.pageUp": "pageUp",
      "tui.select.pageDown": "pageDown",
      "tui.select.confirm": "enter",
      "tui.select.cancel": ["escape", "ctrl+c"],
    };
    const expected = map[binding];
    return (Array.isArray(expected) ? expected : [expected]).some((key) => matchesKey(data, key));
  },
};

export const preset = (name, version = "starter-v2", suffix = name) => ({
  name,
  version,
  digest: "0".repeat(64),
  models: {
    d1: `provider/${suffix}-light`,
    d2: `provider/${suffix}-d2`,
    d3: `provider/${suffix}-standard`,
    d4: `provider/${suffix}-d4`,
    d5: `provider/${suffix}-strong`,
  },
});

export const offPreset = () => ({ name: "off", version: "off-v1", digest: "f".repeat(64) });

export const fixture = ({
  rows = 24,
  presets = [preset("alpha"), preset("beta"), preset("gamma")],
  activeName,
  theme: th = theme,
  ...extra
} = {}) => {
  const result = [],
    applied = [],
    tui = {
      terminal: { columns: 120, rows },
      renders: 0,
      requestRender() {
        this.renders++;
      },
    };
  const active =
    activeName ?? presets.find((item) => item.name === "beta")?.name ?? presets[0]?.name ?? "off";
  const picker = new PresetPicker({
    tui,
    theme: th,
    keybindings: keys,
    presets,
    activeName: active,
    done: (value) => result.push(value),
    ...(extra.efforts
      ? {
          setEffort: (name, overrides) => {
            const selected = presets.find((item) => item.name === name);
            assert(selected && selected.name !== "off");
            const snapshot = {
              ...structuredClone(selected),
              effort_overrides: { ...overrides },
              effort: Object.fromEntries(
                strengths.map((slot) => [
                  slot,
                  overrides[slot] ?? selected.effort_defaults?.[slot] ?? "inherit",
                ]),
              ),
            };
            applied.push(snapshot);
            return snapshot;
          },
        }
      : {}),
    ...extra,
  });
  return { picker, tui, result, applied };
};

export const mouse = (type, x, y, extra = {}) => ({ type, button: "left", x, y, ...extra });

// The real empty Agent widget never mounts. Exercise the SDK widget factory and
// ui.custom dispatch as well as the compositor: a canned fullscreen widget mock
// would mask the first-open bug before the picker ever reaches the shared stack.
export function emptyOwnerPanels(t, mode = "fullscreen", management, liveEffort = false) {
  initTheme(undefined, false);
  const terminal = { columns: 120, rows: 50, hideCursor() {} };
  const tui =
    mode === "fullscreen"
      ? new TuiAltScreen(terminal, false, undefined, {})
      : new TuiMainScreen(terminal, false);
  tui.requestRender = () => {};
  const editor = { render: () => [], invalidate() {}, getText: () => "draft", setText() {} };
  tui.setFocus(editor);
  const host = {
    ui: tui,
    editor,
    keybindings: keys,
    editorContainer: new Container(),
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(),
    widgetContainerBelow: new Container(),
    renderWidgets: InteractiveMode.prototype.renderWidgets,
    renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer,
    showExtensionSelector: InteractiveMode.prototype.showExtensionSelector,
    extensionDialogs: [],
    disposeActiveSelector() {},
    pushExtensionDialog: InteractiveMode.prototype.pushExtensionDialog,
    removeExtensionDialog: InteractiveMode.prototype.removeExtensionDialog,
    showTopExtensionDialog: InteractiveMode.prototype.showTopExtensionDialog,
    programStatus: { setBlocked() {} },
  };
  host.editorContainer.addChild(editor);
  const bus = createEventBus(),
    shortcuts = new Map(),
    mounts = [],
    widgets = [],
    published = [];
  const router = new PresetRouter(starterPath);
  router.select("off");
  const ui = {
    notify() {
      assert.fail("unexpected UI notification");
    },
    setWidget(key, content, options) {
      widgets.push({ key, content });
      InteractiveMode.prototype.setExtensionWidget.call(host, key, content, options);
    },
    custom(factory, options) {
      const mount = { options };
      mounts.push(mount);
      return InteractiveMode.prototype.showExtensionCustom.call(
        host,
        (...args) => {
          mount.component = factory(...args);
          return mount.component;
        },
        {
          ...options,
          onHandle(handle) {
            mount.handle = handle;
            options.onHandle?.(handle);
          },
        },
      );
    },
  };
  const widget = new HarnessWidget(
    { list: () => [], stats: () => ({ resident: 0, cleanup_uncertain: false }) },
    8,
  );
  widget.setUi(ui);
  widget.update();
  assert.equal(widget.tuiMode(), undefined);
  assert.equal(widgets.length, 0, "no Agent rows have ever mounted");
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget,
    ready: () => true,
    router: () => router,
    publish: (candidate, name, _ctx, overrides) => {
      const selection = router.apply(candidate, name, () => {}, overrides);
      const publication = { selection, candidate: router.rebase(candidate) };
      published.push(name);
      return publication;
    },
    ...(liveEffort ? { efforts: () => ({ levels: thinkingLevels, inherited: "high" }) } : {}),
    showError: (error) => assert.fail(String(error)),
    ...(management ? { management } : {}),
  });
  const ctx = { mode: "tui", ui };
  t.after(() => {
    panels.dispose();
    widget.dispose();
  });
  const paint = () => {
    for (let i = 0; i < 3; i++)
      tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows);
  };
  const click = () => {
    const event = { key: WORKER_PRESET_INDICATOR, handled: false };
    bus.emit(FOOTER_INDICATOR_CLICK_EVENT, event);
    assert.equal(event.handled, true);
  };
  return {
    panels,
    widget,
    host,
    ctx,
    tui,
    terminal,
    bus,
    shortcuts,
    mounts,
    widgets,
    published,
    paint,
    click,
    router,
  };
}

export const effortPreset = (name = "alpha") => ({
  ...preset(name),
  effort: { d1: "high", d2: "inherit", d3: "inherit", d4: "inherit", d5: "low" },
  effort_defaults: { d1: "high", d2: "inherit", d3: "inherit", d4: "inherit", d5: "low" },
  effort_overrides: { d1: "high" },
});

export const effortCaps = (_preset, slot) => ({
  levels: slot === "d5" ? ["off", "low", "high"] : ["off", "low", "medium", "high"],
  inherited: slot === "d5" ? "low" : "medium",
});

export const painted = (picker, width = 76) => picker.render(width).map(stripTerminalSequences);

export const clickText = (picker, label, width = 76) => {
  const lines = painted(picker, width);
  const y = lines.findIndex((line) => line.includes(label));
  assert(y >= 0, `missing clickable ${label}: ${lines.join("\n")}`);
  picker.handleMouse(mouse("click", lines[y].indexOf(label), y));
};

export const descendingSlots = ["d5", "d4", "d3", "d2", "d1"];

export const paintedSlots = (lines) =>
  lines.flatMap((line) => {
    const slot = line.match(/^│[ ›]?(d[1-5])(?:\s|:)/)?.[1] ?? line.match(/‹(d[1-5]):/)?.[1];
    return slot ? [slot] : [];
  });

// Delegation mode: a slider and an eagerness box above the model presets.
// Unlike a preset, a mode change applies at once and keeps the panel open.
export const delegationState = (initial = { mode: "co-worker", eagerness: "balanced" }) => {
  const state = { current: { ...initial }, sets: [] };
  state.option = {
    current: () => ({ ...state.current }),
    guideline: (setting) => delegationGuideline(setting),
    set: (next) => {
      state.sets.push(next);
      state.current = { ...next };
    },
  };
  return state;
};

export const nodeColumn = (line, label) => line.indexOf(label);

// Settings/preset management routes: the picker only routes to the host's
// dialogs. None of these choices applies or publishes a preset.
export const managementOption = (extra = {}) => ({
  summary: () => " presets: controlled fixture · pending: none",
  settings: true,
  presets: true,
  ...extra,
});

export const savingOption = (trusted = true) =>
  managementOption({ saveDefaults: true, canSaveWorkspace: () => trusted });

export const invisibleKeys = [
  "g",
  "G",
  "w",
  "W",
  "p",
  "P",
  "n",
  "N",
  "c",
  "C",
  "e",
  "E",
  "1",
  "5",
  "r",
  "\t",
  "\u001b[Z",
  "\u001b[A",
  "\u001b[B",
  "\u001b[C",
  "\u001b[D",
  "\u001b[1;2C",
  "\u001b[1;2D",
];

export const hidePicker = (h, kind) => {
  if (kind === "terminal rows") h.tui.terminal.rows = 6;
  else if (kind === "terminal width") h.tui.terminal.columns = 7;
  else if (kind === "allocation rows") h.picker.options.rows = () => 6;
  else painted(h.picker, kind === "zero paint width" ? 0 : 7);
};

export const restoreViewport = (h) => {
  h.tui.terminal.rows = 40;
  h.tui.terminal.columns = 120;
  h.picker.options.rows = undefined;
};
