import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createEventBus, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "../../src/shared/overlay-protocol.mjs";
import { detailView, plainTheme } from "../support/detail-fixture.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
const { ModelSelectionSession } = await jiti.import(
  "../../src/orchestration/ui/model-selection-session.ts",
);
const { default: statsExtension } = await jiti.import("../../src/extensions/stats.ts");
initTheme(undefined, false);

const url = "https://example.invalid/transcript";
// Zero-based screen cells, outside every panel in this fixture.
const link = [1, 2];
const rootControl = [1, 4];
const draft = "unsent fixture message";
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The real pinned SDK mounts/removes the overlay around its async factory
// handoff. Only the terminal and surrounding session/UI services are inert.
function fixture(t) {
  const terminal = { columns: 100, rows: 30, write() {}, hideCursor() {} };
  const opened = [],
    settled = [],
    notices = [],
    hideEvents = [],
    rootClicks = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copyOnSelect: false,
    openUrl: (value) => opened.push(value),
  });
  const nativeDispatch = tui.dispatchMouseToOverlay;
  tui.requestRender = () => {};
  tui.requestViewRender = () => {};
  const root = {
    render: () =>
      Array.from({ length: terminal.rows }, (_, row) => {
        if (row === link[1]) return `\x1b]8;;${url}\x1b\\Transcript link\x1b]8;;\x1b\\`;
        return row === rootControl[1] ? "Root control" : "Main transcript text";
      }),
    handleMouse({ type, x, y }) {
      if (type !== "click" || x !== rootControl[0] || y !== rootControl[1]) return;
      rootClicks.push([x, y]);
      return { handled: true };
    },
    invalidate() {},
  };
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  tui.beforeTerminalStart();
  t.after(() => {
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });

  const ref = createInteractiveTuiReference(() => tui);
  const host = {
    ui: ref,
    editor: { getText: () => "" },
    keybindings: {},
    extensionOverlays: new Map(),
  };
  const ui = {
    theme: plainTheme,
    notify: (...args) => notices.push(args),
    setStatus() {},
    setWidget: (_key, factory) => factory?.(ref),
    custom: (factory, options) =>
      InteractiveMode.prototype.showExtensionCustom.call(
        host,
        (tui, theme, keys, done) =>
          factory(tui, theme, keys, (value) => {
            settled.push(value);
            done(value);
          }),
        options,
      ),
  };
  const bus = createEventBus();
  t.after(bus.on(HIDE_TRANSIENT_OVERLAYS_EVENT, (event) => hideEvents.push(event)));
  const input = (data) => tui.handleTerminalInput(data);
  const pointer = ([x, y], release) => input(`\x1b[<0;${x + 1};${y + 1}${release ? "m" : "M"}`);
  const press = (point = link) => pointer(point, false);
  const release = (point = link) => pointer(point, true);
  const click = (point = link) => {
    press(point);
    release(point);
  };
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const releaseAcrossNativeSearch = async () => {
    const panel = tui.getFocusedComponent();
    assert.ok(panel && panel !== root, "the panel has focus before the backdrop press");
    press();
    input("\x1b[102;6u"); // Kitty Ctrl+Shift+F, Pi's default transcript search binding.
    const searchPainted = () => paint().some((line) => line.includes("Find in transcript"));
    assert.ok(searchPainted(), "Pi painted its native transcript search");
    const search = tui.getFocusedComponent();
    assert.ok(search && search !== panel && search !== root, "search took focus from the panel");
    input("\x1b"); // Esc closes native search, not the panel.
    assert.equal(searchPainted(), false, "Esc closed native search");
    assert.equal(tui.getFocusedComponent(), panel, "Esc restored focus to the same panel");
    release(); // Release on the original backdrop cell with no intervening press.
    await tick(); // Let any owner settlement from the release propagate before a fresh click.
    assert.deepEqual(opened, [], "the stale release did not activate the link underneath");
  };
  const nativeMouse = () => tui.dispatchMouseToOverlay === nativeDispatch;
  const visibleHandle = () => {
    assert.equal(host.extensionOverlays.size, 1, "SDK mounted exactly one custom overlay");
    const [handle] = host.extensionOverlays.keys();
    assert.ok(handle.isFocused() && handle.getBounds(), "overlay is focused and painted");
    return handle;
  };
  const assertDismissedLink = () => {
    assert.equal(tui.hasOverlay(), false, "the owner removed the overlay");
    assert.deepEqual(opened, [], "dismissal did not activate the underlying link");
    // A watcher on a dead handle could still leak even if the link works again.
    assert.equal(tui.dispatchMouseToOverlay, nativeDispatch, "backdrop was unwatched");
    paint();
    click();
    assert.deepEqual(opened, [url], "the same visible link receives a new native click");
    assert.deepEqual(notices, []);
  };
  return {
    bus,
    ui,
    paint,
    input,
    press,
    release,
    click,
    releaseAcrossNativeSearch,
    nativeMouse,
    opened,
    settled,
    hideEvents,
    rootClicks,
    visibleHandle,
    assertDismissedLink,
  };
}

function mountDetails(t, f) {
  const shortcuts = new Map(),
    sent = [],
    stopped = [];
  const agent_id = "fixture-agent";
  const agents = [
    {
      agent_id,
      cwd: "/workspace",
      view: detailView(agent_id, {
        status: "running",
        phase: "executing",
        execution_exited: false,
      }),
      live: { active_tools: [], tool_uses: 0, preview: "" },
      entries: () => undefined,
      inFlight: () => undefined,
    },
  ];
  const panels = new PanelCoordinator({
    pi: { events: f.bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget: {
      agents: () => agents,
      tuiMode: () => "fullscreen",
      onOpen() {},
      wake() {},
    },
    ready: () => true,
    router: () => assert.fail("unexpected routing"),
    publish: () => assert.fail("unexpected publication"),
    showError: (error) => assert.fail(String(error)),
    steerRun(id, text) {
      sent.push([id, text]);
      return { accepted: true };
    },
    stopRun(id) {
      stopped.push(id);
      return { result: "cancel_requested", already_stopping: false };
    },
  });
  panels.attachHost({ mode: "tui", ui: f.ui }, f.bus);
  let current;
  t.after(async () => {
    panels.dispose();
    await current;
  });
  const open = () => (current = shortcuts.get("alt+a").handler());
  return { open, sent, stopped };
}

for (const [scenario, sequence] of [
  ["direct", "no permission prompt"],
  ["hidden", "click while hidden"],
  ["interrupted", "press before hide, release after restore"],
  ["search", "press before native search, release after Esc"],
]) {
  test(`Details real onHandle: ${sequence} keeps the draft until a fresh backdrop click`, async (t) => {
    const f = fixture(t);
    const { open, sent, stopped } = mountDetails(t, f);
    const done = open();
    await tick(); // A real SDK turn, including onHandle after the factory.
    f.paint();
    const handle = f.visibleHandle();
    f.input("m");
    f.input(draft);
    const draftPainted = () => f.paint().some((line) => line.includes(draft));
    assert.ok(draftPainted(), "the pane is composing an unsent draft");

    if (scenario === "search") {
      await f.releaseAcrossNativeSearch();
    } else if (scenario !== "direct") {
      if (scenario === "interrupted") f.press();
      const permission = { requestId: "fixture-ask" };
      f.bus.emit("permissions:ui_prompt", permission);
      assert.equal(draftPainted(), false, "the draft is out of the way during the ask");
      assert.equal(handle.isHidden(), true);
      assert.equal(handle.isFocused(), false);
      assert.ok(f.nativeMouse(), "a hidden pane leaves Pi's mouse dispatch unwrapped");
      if (scenario === "hidden") {
        f.click(rootControl);
        assert.deepEqual(f.rootClicks, [rootControl], "a click while hidden is routed natively");
      }
      assert.equal(f.settled.length, 0, "yield does not complete the custom request");
      f.bus.emit("permissions:decision", permission);
      assert.ok(draftPainted(), "the draft returned with the same Run");
      assert.equal(f.visibleHandle(), handle, "the Details pane was restored in place");
      assert.equal(f.nativeMouse(), false, "the restored pane registers its backdrop again");

      if (scenario === "interrupted") {
        f.release();
        assert.deepEqual(f.opened, [], "the trailing release cannot click through either");
      }
    }
    if (scenario === "interrupted" || scenario === "search") {
      assert.equal(f.settled.length, 0, "an interrupted gesture cannot close on release");
      assert.ok(draftPainted(), "the trailing release did not drop the draft");
      assert.equal(f.visibleHandle(), handle, "the same Details pane stays open");
    }

    f.press();
    assert.equal(f.settled.length, 0, "a fresh press alone does not dismiss");
    f.release();
    assert.equal(f.settled.length, 1, "a fresh backdrop click settles exactly once");
    await done;
    assert.deepEqual(f.hideEvents, [], "backdrop settlement is local to Details");
    f.assertDismissedLink();
    assert.deepEqual(sent, [], "dismissing does not send the draft");
    assert.deepEqual(stopped, [], "dismissing does not request Stop");

    open();
    await tick();
    assert.equal(draftPainted(), false, "a deliberate close discards the draft on reopening");
    f.visibleHandle();
  });
}

for (const [description, crossSearch] of [
  ["mounts and unwatches its own backdrop", false],
  ["stays visible until a fresh backdrop click after native search", true],
]) {
  test(`Stats command ${description}`, async (t) => {
    const f = fixture(t);
    const commands = new Map(),
      events = new EventEmitter();
    statsExtension({
      events: f.bus,
      registerCommand: (name, spec) => commands.set(name, spec),
      on(name, handler) {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
    });
    t.after(() => events.emit("session_shutdown", {}));
    // Session events use a separate subscription surface; only this synthetic
    // start is driven here, not real telemetry or an approval flow.
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: f.ui,
      sessionManager: { getSessionId: () => "fixture-session" },
    };
    events.emit("session_start", {}, ctx);
    await commands.get("stats").handler("", ctx);
    const statsPainted = () => f.paint().some((line) => line.includes("Stats"));
    assert.ok(statsPainted(), "Stats was painted");
    if (crossSearch) {
      await f.releaseAcrossNativeSearch();
      assert.ok(statsPainted(), "the stale release did not close Stats");
    }
    f.click();
    f.assertDismissedLink();
  });
}

const model = { id: "fixture-model", name: "Fixture Model", provider: "fixture", api: "test" };
const modelLabel = `${model.id} [${model.provider}]`;
function makeSelector() {
  // Give the real model popover one choice in Pi's public component-tree
  // shape, without loading a real model registry or refreshing providers.
  const native = new Container(),
    list = new Container();
  native.addChild(new Text("> search", 0, 0));
  list.addChild(new Text(`→   ${modelLabel}`, 0, 0));
  native.addChild(list);
  native.focused = false;
  native.dispose = () => {};
  return native;
}

for (const [description, position, crossSearch] of [
  ["centered backdrop cancels without publishing", undefined, false],
  ["centered backdrop needs a fresh click after native search", undefined, true],
  ["positioned leaves the link native", { row: 7, col: 8 }, false],
]) {
  test(`ModelSelectionSession real onHandle: ${description}`, async (t) => {
    const f = fixture(t);
    const session = new ModelSelectionSession(
      {
        ctx: { mode: "tui", ui: f.ui, scopedModels: [], modelRegistry: { getAll: () => [model] } },
        createModelSelector: makeSelector,
        modelPopover: () => true,
        // Same settlement callback as the orchestration extension.
        beforeModelClose: () => f.bus.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}),
      },
      () => {},
    );
    const result = session.select("fixture", "d3", "", [model], position);
    t.after(async () => {
      session.cancel();
      await result;
    });
    await tick();
    const lines = f.paint();
    const handle = f.visibleHandle();
    const row = lines.findIndex((line) => line.includes(modelLabel));
    assert.ok(row >= 0, "the model choice is painted");
    if (position) {
      const bounds = handle.getBounds();
      assert.equal(bounds.row, position.row + 1, "mounted below the requested origin");
      assert.equal(bounds.col, position.col);
      f.click();
      assert.equal(f.settled.length, 0, "outside click leaves the positioned chooser open");
      assert.deepEqual(f.opened, [url], "a positioned chooser has no backdrop interception");
      assert.equal(f.visibleHandle(), handle);

      const x = visibleWidth(lines[row].slice(0, lines[row].indexOf(modelLabel)));
      f.click([x, row]);
      assert.deepEqual(f.settled, [model], "a click on the painted choice can still select it");
      assert.equal(await result, `${model.provider}/${model.id}`);
    } else {
      if (crossSearch) {
        await f.releaseAcrossNativeSearch();
        assert.deepEqual(f.settled, [], "the stale release neither selects nor cancels");
        assert.ok(
          f.paint().some((line) => line.includes(modelLabel)),
          "the model choice is still painted",
        );
        assert.equal(f.visibleHandle(), handle, "the same model chooser stays open");
      }
      f.click();
      assert.deepEqual(f.settled, [undefined], "backdrop closes with no model selection");
      assert.equal(await result, undefined, "no model is returned to the caller for publication");
      assert.deepEqual(f.hideEvents, [], "backdrop settlement is local to the model chooser");
      f.assertDismissedLink();
    }
  });
}
