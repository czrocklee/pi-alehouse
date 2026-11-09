import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { Container, CURSOR_MARKER, Text, stripTerminalSequences } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { PresetModelPopover } = await jiti.import(
  "../../src/orchestration/ui/preset-model-popover.ts",
);
const { ModelSelectionSession } = await jiti.import(
  "../../src/orchestration/ui/model-selection-session.ts",
);
const { createPresetOverlayHost } = await jiti.import(
  "../../src/orchestration/ui/preset-overlay-host.ts",
);
const { joinPopoverStack } = await import("../../src/shared/popover-stack.mjs");
const theme = {
  fg: (color, text) =>
    `\x1b[${color === "muted" ? 90 : color === "error" ? 31 : 36}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const move = (x = 76, y = 0) => ({ type: "move", button: "none", x, y });
function host() {
  let component,
    renders = 0;
  const tui = {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => renders++,
    handleViewportInput: (event) => (event.outside ? "outside" : component?.handleMouse(event)),
  };
  return {
    tui,
    original: tui.handleViewportInput,
    renders: () => renders,
    mount: (view) => {
      component = view;
    },
  };
}
function hover(t, f, component) {
  f.mount(component);
  t.after(() => component.dispose());
  const initial = component.render(80);
  const before = f.renders();
  f.tui.handleViewportInput(move());
  assert.equal(f.renders(), before + 1);
  const hovered = component.render(80);
  assert.notEqual(hovered[0], initial[0]);
  assert.equal(stripTerminalSequences(hovered[0]), stripTerminalSequences(initial[0]));
  assert.deepEqual(hovered.slice(1), initial.slice(1));
  f.tui.handleViewportInput(move(78));
  assert.equal(f.renders(), before + 1);
  assert.deepEqual(component.render(80), hovered, "normal repaint preserves hover");
  f.tui.handleViewportInput(move(5, 2));
  assert.deepEqual(component.render(80), initial, "within-panel leave clears hover");
  f.tui.handleViewportInput(move());
  assert.equal(f.tui.handleViewportInput({ outside: true }), "outside");
  assert.deepEqual(
    component.render(80),
    initial,
    "other components clear hover without retargeting",
  );
  assert.equal(f.tui.handleViewportInput, f.original);
  return initial;
}
function detail(t, extra = {}) {
  const f = host(),
    stops = [],
    closes = [];
  const view = {
    owner_id: "owner",
    generation: "generation",
    agent_id: "agent",
    run_id: "run",
    name: "worker",
    description: "Fixture task",
    status: "running",
    phase: "executing",
    execution_exited: false,
    finalization_pending: false,
    elapsed_ms: 0,
    turns: 0,
    cleanup_errors: [],
    discarded_inputs: [],
    effective_settings: {
      profile: "editor",
      preset: "fixture",
      preset_version: "v1",
      strength: "d3",
      thinking: "low",
      model: "fixture/model",
      cwd: "/fixture",
      tools: [],
    },
  };
  const pane = new DetailPane({
    tui: f.tui,
    theme,
    frame: true,
    initial: "agent",
    snapshot: () => [
      { agent_id: "agent", input: { view, live: { active_tools: [], tool_uses: 0, preview: "" } } },
    ],
    transcript: () => undefined,
    done: () => closes.push(true),
    onStop: (run) => stops.push(run),
    ...extra,
  });
  t.after(() => pane.dispose());
  f.mount(pane);
  return { ...f, pane, view, stops, closes };
}

test("DetailPane hover affects only close chrome, never Stop intent or selection", (t) => {
  const f = detail(t);
  hover(t, f, f.pane);
  f.pane.handleInput("s");
  const armed = f.pane.render(80);
  assert(stripTerminalSequences(armed.at(-1)).includes("[Confirm stop]"));
  f.tui.handleViewportInput(move());
  const hovered = f.pane.render(80);
  assert.deepEqual(hovered.slice(1), armed.slice(1), "hover does not cancel or confirm Stop");
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.closes, []);
  assert.equal(f.pane.selected, "agent");
  f.pane.resetCloseHover();
  assert.equal(f.tui.handleViewportInput, f.original, "approval hiding detaches hover immediately");
  f.tui.handleViewportInput(move());
  assert.equal(f.tui.handleViewportInput, f.original, "hidden geometry cannot reenter hover");
  f.tui.handleViewportInput({ type: "click", button: "left", x: 76, y: 0 });
  assert.deepEqual(f.closes, []);
  assert.deepEqual(f.pane.render(80), armed, "reveal repaints without stale close hover");
});

test("DetailPane height-only relayout clears returned hover without Stop or selection effects", (t) => {
  let count = 0;
  const f = detail(t, {
    transcript: () => ({
      lineCount: () => count,
      slice: (_width, _start, size) => Array(size).fill("Transcript row"),
    }),
  });
  const initial = f.pane.render(80);
  f.tui.handleViewportInput(move());
  assert.notEqual(f.pane.render(80)[0], initial[0]);
  count = 30;
  const grown = f.pane.render(80);
  assert.notEqual(grown.length, initial.length);
  assert.equal(grown[0], initial[0], "first grown paint is not stale-highlighted");
  assert.equal(f.tui.handleViewportInput, f.original);
  f.tui.handleViewportInput(move());
  const hovered = f.pane.render(80);
  assert.notEqual(hovered[0], grown[0]);
  assert.deepEqual(f.pane.render(80), hovered, "unchanged actual height retains hover");
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.closes, []);
  assert.equal(f.pane.selected, "agent");
});

test("DetailPane narrow, invalidated, docked and disposed geometry never keeps hover", (t) => {
  const f = detail(t);
  f.pane.render(80);
  f.tui.handleViewportInput(move());
  assert.deepEqual(f.pane.render(10), []);
  assert.equal(f.tui.handleViewportInput, f.original);
  f.tui.handleViewportInput(move());
  assert.equal(f.tui.handleViewportInput, f.original);
  f.pane.render(80);
  f.tui.handleViewportInput(move());
  f.pane.invalidate();
  assert.equal(f.tui.handleViewportInput, f.original);
  f.pane.render(80);
  f.tui.handleViewportInput(move());
  f.pane.dispose();
  assert.equal(f.tui.handleViewportInput, f.original);
  assert.deepEqual(f.pane.render(80), []);
  const docked = detail(t, { frame: false });
  const initial = docked.pane.render(80);
  docked.tui.handleViewportInput(move());
  assert.deepEqual(docked.pane.render(80), initial);
  assert.equal(docked.tui.handleViewportInput, docked.original);
});

const model = { id: "model", name: "model", provider: "fixture", api: "test" };
function nativeSelector({ frozen = false, input = () => {} } = {}) {
  const tree = new Container(),
    list = new Container();
  let disposes = 0,
    disposeCalls = 0,
    closed = false,
    focused = false,
    inputs = 0;
  list.addChild(new Text("→   model [fixture]", 0, 0));
  tree.addChild(new Text(`> search${CURSOR_MARKER}`, 0, 0));
  tree.addChild(list);
  // Structural host double: native cleanup is idempotent, independently of
  // calls made by native Enter/Esc and by Alehouse's owner/host cleanup.
  const native = {
    children: tree.children,
    addChild: (child) => tree.addChild(child),
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
    },
    capturesViewportInput: true,
    render: (width) => tree.render(width),
    invalidate: () => tree.invalidate(),
    handleInput(data) {
      inputs++;
      input(data, native);
    },
    dispose() {
      disposeCalls++;
      if (closed) return;
      closed = true;
      disposes++;
    },
  };
  if (frozen) Object.freeze(native);
  return {
    native,
    disposes: () => disposes,
    disposeCalls: () => disposeCalls,
    inputs: () => inputs,
  };
}
function modelView(t) {
  const f = host(),
    n = nativeSelector(),
    selected = [],
    cancelled = [];
  let height = 20;
  const view = new PresetModelPopover({
    native: n.native,
    tui: f.tui,
    theme,
    title: "d3 model",
    height: () => height,
    models: () => [model],
    select: (value) => selected.push(value),
    cancel: () => cancelled.push(true),
  });
  f.mount(view);
  t.after(() => view.dispose());
  return {
    ...f,
    ...n,
    view,
    selected,
    cancelled,
    height: (value) => {
      height = value;
    },
  };
}

test("model selector close hover preserves native focus, input and model identity", (t) => {
  const f = modelView(t);
  hover(t, f, f.view);
  assert.equal(f.view.focused, false);
  assert.equal(f.inputs(), 0);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.cancelled, []);
  f.tui.handleViewportInput(move());
  const hovered = f.view.render(80);
  assert.equal(f.view.canSelect(model), true);
  assert.deepEqual(f.view.render(80), hovered, "dry identity rechecks do not reset painted hover");
  f.view.dispose();
  f.view.dispose();
  assert.equal(f.disposes(), 1);
  assert.equal(f.tui.handleViewportInput, f.original);
});

test("model native-body height changes clear returned hover but dry rechecks do not publish geometry", (t) => {
  const f = modelView(t);
  const initial = f.view.render(80);
  f.tui.handleViewportInput(move());
  assert.notEqual(f.view.render(80)[0], initial[0]);
  f.native.addChild(new Text("New catalogue status", 0, 0));
  assert.equal(f.view.canSelect(model), true);
  assert.notEqual(
    f.tui.handleViewportInput,
    f.original,
    "dry layout retains the last actual paint token",
  );
  const grown = f.view.render(80);
  assert.notEqual(grown.length, initial.length);
  assert.equal(
    grown[0],
    initial[0],
    "actual new-height paint clears before constructing the title",
  );
  assert.equal(f.tui.handleViewportInput, f.original);
  f.tui.handleViewportInput(move());
  const hovered = f.view.render(80);
  assert.notEqual(hovered[0], grown[0]);
  assert.deepEqual(f.view.render(80), hovered);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.cancelled, []);
  assert.equal(f.inputs(), 0);
  assert.equal(f.view.focused, false);
});

test("model selector too-small/invalidation paints clear hover and unseen close clicks", (t) => {
  const f = modelView(t);
  f.view.render(80);
  f.tui.handleViewportInput(move());
  f.height(4);
  assert(!f.view.render(80)[0].includes("×"));
  assert.equal(f.view.canSelect(model), false, "too-small paint cannot confirm unseen selection");
  assert.equal(f.tui.handleViewportInput, f.original);
  f.tui.handleViewportInput(move());
  f.tui.handleViewportInput({ type: "click", button: "left", x: 76, y: 0 });
  assert.deepEqual(f.cancelled, []);
  f.height(20);
  f.view.render(80);
  f.tui.handleViewportInput(move());
  f.view.invalidate();
  assert.equal(f.tui.handleViewportInput, f.original);
  f.view.render(80);
  f.tui.handleViewportInput(move());
  assert(!f.view.render(11)[0].includes("×"));
  f.tui.handleViewportInput({ type: "click", button: "left", x: 7, y: 0 });
  assert.equal(f.tui.handleViewportInput, f.original);
  assert.deepEqual(f.cancelled, [], "narrow paint also has no invisible close target");
  assert.deepEqual(f.selected, []);
  f.view.handleInput("escape");
  assert.equal(f.inputs(), 1, "too-small mode still forwards native keyboard cancellation");
});

function modelSession({ floating, frozen, closeThrows = false }) {
  const f = host(),
    closes = [],
    completions = [],
    notifications = [],
    scopedModels = [{ model }];
  let mounted, settleHost, callbacks;
  const n = nativeSelector({
    frozen,
    input(data, native) {
      if (data === "enter" || data === "escape") {
        native.dispose();
        if (data === "enter") callbacks.select(model);
        else callbacks.cancel();
      }
    },
  });
  const methods = Object.fromEntries(
    ["dispose", "render", "invalidate", "handleInput"].map((key) => [key, n.native[key]]),
  );
  const session = new ModelSelectionSession(
    {
      ctx: {
        mode: "tui",
        scopedModels,
        modelRegistry: { getAll: () => [model] },
        ui: {
          custom: (factory) =>
            new Promise((resolve) => {
              settleHost = resolve;
              mounted = factory(f.tui, theme, {}, (value) => {
                assert.equal(n.disposes(), 1, "native resources released before done");
                assert.equal(f.tui.handleViewportInput, f.original, "hover released before done");
                completions.push(value);
                mounted.dispose(); // The host also tears down synchronously on done.
                resolve(value);
              });
              f.mount(mounted);
            }),
          notify: (...args) => notifications.push(args),
        },
      },
      beforeModelClose() {
        closes.push(true);
        if (closeThrows) throw new Error("fixture close failure");
      },
      modelPopover: () => floating,
      createModelSelector(options) {
        assert.equal(options.tui, f.tui);
        assert.equal(options.scopedModels, scopedModels, "read-only host scope is forwarded");
        assert.equal(options.current, model);
        callbacks = options;
        return n.native;
      },
    },
    () => {},
  );
  const result = session.select("team", "d3", "fixture/model", [model]);
  return {
    ...f,
    ...n,
    session,
    result,
    mounted,
    callbacks,
    settleHost,
    closes,
    completions,
    notifications,
    assertNativeMethods() {
      for (const [key, method] of Object.entries(methods)) {
        assert.equal(n.native[key], method, `native ${key} method identity is preserved`);
      }
    },
  };
}

for (const floating of [false, true]) {
  for (const frozen of [false, true]) {
    const label = `${floating ? "floating" : "docked"}/${frozen ? "frozen" : "mutable"}`;
    for (const action of [
      "select",
      "native-select",
      "native-cancel",
      "cancel",
      "host",
      "finally",
    ]) {
      test(`model session ${label} ${action} preserves native methods and cleans owned resources`, async (t) => {
        const f = modelSession({ floating, frozen });
        t.after(() => f.mounted.dispose());
        f.assertNativeMethods();
        assert.equal(Object.isFrozen(f.native), frozen);
        assert.equal(f.mounted.focused, false);
        f.mounted.focused = true;
        assert.equal(f.native.focused, true, "focus setter survives frozen structural hosts");
        assert.equal(f.mounted.capturesViewportInput, true);
        assert(f.mounted.render(80).some((line) => line.includes(CURSOR_MARKER)));
        if (floating) {
          f.tui.handleViewportInput(move());
          assert.notEqual(f.tui.handleViewportInput, f.original);
        }
        if (action === "select") {
          f.callbacks.select(model);
        } else if (action.startsWith("native-")) {
          f.mounted.handleInput(action === "native-select" ? "enter" : "escape");
        } else if (action === "cancel") {
          f.session.cancel();
          f.session.cancel();
        } else {
          if (action === "host") {
            f.mounted.dispose();
            f.mounted.dispose();
          }
          // Host return without a callback also reaches the request's finally.
          f.settleHost(undefined);
        }
        assert.equal(
          await f.result,
          action === "select" || action === "native-select" ? "fixture/model" : undefined,
        );
        f.mounted.dispose();
        f.mounted.dispose();
        f.session.cancel();
        if (action !== "host" && action !== "finally") {
          f.callbacks.cancel();
          f.callbacks.select(model);
        }
        assert.equal(f.disposes(), 1, "one effective native cleanup, even after self-disposal");
        if (action.startsWith("native-")) {
          assert(f.disposeCalls() >= 2, "native self-disposal is not an owner-method override");
        }
        assert.equal(f.tui.handleViewportInput, f.original, "wrapper hover observer is released");
        if (floating) assert.deepEqual(f.mounted.render(80), []);
        const callbackClose = action !== "host" && action !== "finally";
        assert.equal(f.closes.length, callbackClose ? 1 : 0, "close hook semantics unchanged");
        assert.equal(f.completions.length, callbackClose ? 1 : 0, "completion is once-only");
        assert.deepEqual(f.notifications, []);
        f.assertNativeMethods();
      });
    }
  }
}

test("model session owner cleanup is idempotent across docked host, cancel and finally", async () => {
  const f = modelSession({ floating: false, frozen: true });
  f.mounted.dispose();
  const calls = f.disposeCalls();
  f.mounted.dispose();
  f.session.cancel();
  await f.result;
  f.mounted.dispose();
  assert.equal(f.disposeCalls(), calls, "only the request owner is guarded, not native.dispose");
  assert.equal(f.disposes(), 1);
  assert.deepEqual(f.closes, [true]);
  assert.deepEqual(f.completions, [undefined]);
  f.assertNativeMethods();
});

test("model session rejected native identity still frees wrapper after self-disposal", async () => {
  const f = modelSession({ floating: true, frozen: true, closeThrows: true });
  f.mounted.render(80);
  f.tui.handleViewportInput(move());
  f.native.dispose();
  f.callbacks.select({ ...model, id: "not-painted" });
  assert.equal(await f.result, undefined);
  assert.equal(f.disposes(), 1);
  assert.equal(f.tui.handleViewportInput, f.original);
  assert.deepEqual(f.mounted.render(80), []);
  assert.deepEqual(f.closes, [true], "a throwing close hook still completes cleanup");
  assert.deepEqual(f.completions, [undefined]);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0][1], "warning");
  f.mounted.dispose();
  f.session.cancel();
  f.assertNativeMethods();
});

test("preset stack hide notifies close-geometry owner even when component is not rendered", (t) => {
  const f = host();
  let hidden = 0;
  const lower = joinPopoverStack(f.tui);
  t.after(() => lower.leave());
  lower.measure(39);
  const overlay = createPresetOverlayHost({
    floating: true,
    emitPinned() {},
    onHide: () => hidden++,
  });
  overlay.attach(f.tui);
  t.after(() => overlay.release());
  const options = overlay.customOptions().overlayOptions();
  assert.equal(options.visible(), false);
  assert.equal(hidden, 1);
  assert.equal(
    overlay.customOptions().overlayOptions(),
    options,
    "the attached member retains visibility history",
  );
  overlay.customOptions().overlayOptions().visible();
  assert.equal(hidden, 1, "hidden transition is reported once");
});

test("preset stack movement retires hover across repeated overlay option queries", (t) => {
  const f = host(),
    choices = [];
  const picker = new PresetPicker({
    tui: f.tui,
    theme,
    presets: [],
    activeName: "off",
    pointer: true,
    keybindings: { matches: () => false },
    done: (value) => choices.push(value),
  });
  f.mount(picker);
  t.after(() => picker.dispose());
  const lower = joinPopoverStack(f.tui);
  t.after(() => lower.leave());
  lower.measure(2);
  let moved = 0;
  const overlay = createPresetOverlayHost({
    floating: true,
    emitPinned() {},
    onMove: () => {
      moved++;
      picker.resetCloseHover();
    },
  });
  overlay.attach(f.tui);
  t.after(() => overlay.release());
  const config = overlay.customOptions();
  const options = config.overlayOptions();
  assert.equal(options.visible(), true);
  const initial = picker.render(80);
  f.tui.handleViewportInput(move());
  const hovered = picker.render(80);
  assert.notEqual(hovered[0], initial[0]);
  assert.equal(config.overlayOptions(), options);
  assert.equal(config.overlayOptions().visible(), true);
  assert.equal(moved, 0, "unchanged stack bottom retains hover");
  lower.measure(5);
  assert.equal(config.overlayOptions().margin.bottom, 6, "responsive getter is retained");
  assert.equal(config.overlayOptions().visible(), true);
  assert.equal(moved, 1);
  assert.equal(f.tui.handleViewportInput, f.original);
  assert.deepEqual(
    picker.render(80),
    initial,
    "same-size translated panel returns unhighlighted chrome",
  );
  config.overlayOptions().visible();
  assert.equal(moved, 1, "movement is latched across option callbacks");
  assert.deepEqual(choices, []);
});
