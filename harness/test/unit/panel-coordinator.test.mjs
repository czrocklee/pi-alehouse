import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";
import { ChildActivityRegistry } from "../../dist/runtime/activity-observer.js";
import { settings } from "../support/controller-fixture.mjs";
import { starterPath } from "../support/preset-config.mjs";

initTheme(undefined, false);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const theme = { fg: (_color, text) => text, bold: (text) => text };
import { PanelCoordinator } from "../../dist/ui/panel-coordinator.js";

for (const brokenNotification of [false, true]) test(`preset shortcut returns its Promise when error notification ${brokenNotification ? "throws" : "succeeds"}`, async (t) => {
  const shortcuts = new Map(), notices = [];
  const failure = new Error("synthetic preset failure"), notification = new Error("synthetic UI failure");
  const panels = new PanelCoordinator({
    pi: { registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget: { onOpen() {} }, ready: () => true,
    router() { throw failure; },
    publish() { assert.fail("failed selection must not publish"); },
    showError(error) { notices.push(error); if (brokenNotification) throw notification; },
  });
  panels.attachHost({ mode: "tui", ui: {} }, { on: () => () => {} });
  t.after(() => panels.dispose());
  const handled = shortcuts.get("alt+s").handler();
  assert(handled instanceof Promise, "Pi must be able to observe completion and notification failure");
  if (brokenNotification) await assert.rejects(handled, (error) => error === notification);
  else await handled;
  assert.deepEqual(notices, [failure]);
});

function panelFixture(t, { agents = [], notify = () => {}, custom, bus = createEventBus() } = {}) {
  const shortcuts = new Map();
  let clicked;
  const widget = { agents: () => agents, tuiMode: () => "regular", onOpen(handler) { clicked = handler; } };
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) }, widget,
    ready: () => true, router() { throw new Error("unused"); }, publish() {}, showError() {},
  });
  const ctx = { mode: "tui", ui: { notify, custom } };
  panels.attachHost(ctx, bus);
  t.after(() => panels.dispose());
  return { panels, shortcuts, bus, ctx, click: (id) => clicked?.(id), bound: () => !!clicked };
}

test("a coordinator rejects every second host attachment without orphaning its first binding", async (t) => {
  const bus = createEventBus(), on = bus.on.bind(bus);
  let subscriptions = 0, active = 0, notices = 0, foreignSubscriptions = 0;
  bus.on = (channel, listener) => {
    subscriptions++; active++;
    const off = on(channel, listener);
    return () => { active--; off(); };
  };
  const h = panelFixture(t, { bus, notify() { notices++; } });
  const foreign = { on() { foreignSubscriptions++; return () => {}; } };
  assert.equal(active, 4, "approval prompt, decision, UI settlement and footer indicator");
  for (const [ctx, events] of [[h.ctx, bus], [h.ctx, foreign],
    [{ mode: "tui", ui: { notify() { assert.fail("host was replaced"); } } }, foreign]]) {
    assert.throws(() => h.panels.attachHost(ctx, events), /PANEL_HOST_ALREADY_ATTACHED/);
    assert.equal(subscriptions, 4); assert.equal(active, 4); assert.equal(foreignSubscriptions, 0);
  }
  h.click("a"); await tick();
  assert.equal(notices, 1, "the original widget callback and host are still bound");
  h.panels.dispose();
  assert.equal(active, 0); assert.equal(h.bound(), false);
  assert.throws(() => h.panels.attachHost(h.ctx, bus), /PANEL_HOST_ALREADY_ATTACHED/);
  assert.equal(subscriptions, 4); assert.equal(h.bound(), false);
});

for (const empty of [false, true]) for (const brokenNotification of [false, true]) {
  test(`Alt+A returns an observed Promise (empty=${empty}, broken notify=${brokenNotification})`, async (t) => {
    const notification = new Error("NOTIFY_FAILED"), notices = [];
    const h = panelFixture(t, {
      agents: empty ? [] : [{ agent_id: "a" }],
      custom: async () => { throw new Error("CUSTOM_FAILED"); },
      notify(message) { notices.push(message); if (brokenNotification) throw notification; },
    });
    const opening = h.shortcuts.get("alt+a").handler();
    assert(opening instanceof Promise, "the SDK, not a detached catch, observes notification failures");
    if (brokenNotification) await assert.rejects(opening, (error) => error === notification);
    else await opening;
    assert(notices.some((message) => message.includes(empty ? "No agents" : "CUSTOM_FAILED")));
  });
}

for (const hostileError of [false, true]) test(`row-click final observer cannot reject (hostile error=${hostileError})`, async (t) => {
  let reported = 0;
  const failure = hostileError ? { toString() { throw new Error("FORMAT_FAILED"); } } : new Error("NOTIFY_FAILED");
  const h = panelFixture(t, {
    agents: [{ agent_id: "a" }], custom: async () => { throw new Error("CUSTOM_FAILED"); },
    notify() { reported++; throw failure; },
  });
  assert.equal(h.click("a"), undefined, "mouse callbacks have no Promise consumer");
  await tick(); await tick(); // node:test fails on unhandled rejections, including after test completion.
  assert.equal(reported, hostileError ? 1 : 2, "the last observer contains formatting as well as notifier failures");
});

test("row-click on an open pane observes synchronous close and notification failures", async (t) => {
  let reports = 0;
  const h = panelFixture(t, {
    agents: [{ agent_id: "a" }],
    custom(factory) {
      return new Promise((resolve) => factory({ terminal: { columns: 100, rows: 40 }, requestRender() {} }, theme, {},
        () => { resolve(); throw new Error("CLOSE_FAILED"); }));
    },
    notify() { reports++; throw new Error("NOTIFY_FAILED"); },
  });
  const opening = h.shortcuts.get("alt+a").handler();
  assert.doesNotThrow(() => h.click("a"));
  await opening; await tick();
  assert.equal(reports, 1, "the void callback has a non-throwing final observer even without mounting again");
});

test("docked yield observes reopen rejection and disposal cancels a pending reopen timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, reports = 0;
  const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} };
  const h = panelFixture(t, {
    agents: [{ agent_id: "a" }],
    custom(factory) {
      if (++calls === 2) return Promise.reject(new Error("REOPEN_FAILED"));
      return new Promise((resolve) => factory(tui, theme, {}, resolve));
    },
    notify() { reports++; throw new Error("NOTIFY_FAILED"); },
  });
  const opening = h.shortcuts.get("alt+a").handler();
  h.bus.emit("permissions:ui_prompt", { requestId: "first" });
  await opening;
  h.bus.emit("permissions:decision", { requestId: "first" });
  t.mock.timers.tick(1);
  await tick(); await tick();
  assert.equal(calls, 2); assert.equal(reports, 2);
  const again = h.shortcuts.get("alt+a").handler();
  h.bus.emit("permissions:ui_prompt", { requestId: "second" });
  await again;
  h.bus.emit("permissions:decision", { requestId: "second" });
  h.panels.dispose();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(calls, 3, "shutdown must cancel the deferred reopen, not create another pane");
  assert.equal(h.bound(), false);
});

test("panel disposal tries every unsubscriber and closes a throwing pane before detaching", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const bus = createEventBus(), originalOn = bus.on.bind(bus), unbound = [];
  bus.on = (channel, handler) => {
    const off = originalOn(channel, handler);
    return () => { unbound.push(channel); off(); throw new Error(`UNSUBSCRIBE_FAILED:${channel}`); };
  };
  let renders = 0, doneCalls = 0;
  const h = panelFixture(t, {
    bus, agents: [{ agent_id: "a" }],
    notify() { throw new Error("NOTIFY_FAILED"); },
    custom(factory) {
      return new Promise((resolve) => factory({ terminal: { columns: 100, rows: 40 }, requestRender() { renders++; } },
        theme, {}, () => { doneCalls++; resolve(); throw new Error("DONE_FAILED"); }));
    },
  });
  const opening = h.shortcuts.get("alt+a").handler();
  t.mock.timers.tick(120);
  assert.equal(renders, 1);
  assert.doesNotThrow(() => h.panels.dispose());
  await opening;
  assert.deepEqual(unbound, ["pi-footer:indicator-click", "permissions:ui_prompt", "permissions:decision", "managed-permissions:ui_prompt_end:v1"]);
  assert.equal(doneCalls, 1); assert.equal(h.bound(), false);
  t.mock.timers.tick(1000);
  await h.shortcuts.get("alt+a").handler();
  h.panels.dispose();
  assert.equal(doneCalls, 1); assert.equal(unbound.length, 4); assert.equal(renders, 1);
});

test("an open queued pane follows late child history and streaming without remounting", async (t) => {
  const activities = new ChildActivityRegistry();
  const view = { agent_id: "a", run_id: "r", name: "scout", description: "queued fixture", status: "queued",
    phase: "queued", execution_exited: false, finalization_pending: false, resident: true, resumable: false,
    owner_blocked: false, notification_drops: 0, pending_messages: 0, isolation: "shared", elapsed_ms: 1,
    turns: 0, max_turns: 8, cleanup_errors: [], discarded_inputs: [], effective_settings: settings };
  const widget = new HarnessWidget({ list: () => [view], stats: () => ({ resident: 1, cleanup_uncertain: false }) },
    8, activities.observations, (ids) => activities.retain(ids));
  const retained = widget.agents()[0];
  const shortcuts = new Map(), bus = createEventBus();
  const panels = new PanelCoordinator({ pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget, ready: () => true, router() {}, publish() {}, showError() {} });
  let pane, mounts = 0;
  panels.attachHost({ mode: "tui", ui: {
    notify() { assert.fail("no UI errors expected"); },
    custom(factory) {
      mounts++;
      return new Promise((resolve) => { pane = factory({ terminal: { columns: 120, rows: 100 }, requestRender() {} }, theme, {}, resolve); });
    },
  } }, bus);
  t.after(() => { panels.dispose(); widget.dispose(); activities.clear(); });
  const opening = shortcuts.get("alt+a").handler();
  assert.match(pane.render(120).join("\n"), /queued/);
  assert.equal(retained.entries(), undefined);
  view.status = "running"; view.phase = "initializing";
  const child = activities.track("a", settings.cwd), handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  assert.doesNotThrow(() => pane.render(120)); // Observer exists, SDK session not bound yet.
  const sessionManager = SessionManager.inMemory(settings.cwd);
  const user = sessionManager.appendMessage({ role: "user", content: "LATE_CHILD_HISTORY", timestamp: 0 });
  handlers.get("session_start")({}, { sessionManager });
  view.phase = "streaming";
  const draft = { role: "assistant", content: [{ type: "text", text: "LATE_CHILD_STREAM" }], stopReason: "pending" };
  handlers.get("message_update")({ message: draft, assistantMessageEvent: { type: "text_delta", delta: "LATE_CHILD_STREAM" } });
  assert.deepEqual(retained.entries(), sessionManager.getEntries());
  assert.equal(retained.inFlight(), draft);
  // Match the transcript, not the independently refreshed activity preview.
  const transcript = () => pane.render(120).join("\n").split(" transcript ")[1];
  assert.match(transcript(), /LATE_CHILD_HISTORY/); assert.match(transcript(), /LATE_CHILD_STREAM/);
  sessionManager.appendMessage({ ...draft, stopReason: "stop" });
  handlers.get("message_end")({ message: draft });
  assert.equal(transcript().match(/LATE_CHILD_STREAM/g)?.length, 1, "settlement does not duplicate the live tail");
  const failed = sessionManager.appendMessage({ role: "assistant", stopReason: "error", timestamp: 1,
    content: [{ type: "text", text: "FAILED_ATTEMPT_STAYS_VISIBLE" }], errorMessage: "retryable fixture" });
  sessionManager.appendContextEdit(failed, null);
  sessionManager.appendContextEdit(user, { content: "MODEL_ONLY_REPLACEMENT" });
  sessionManager.appendMessage({ role: "assistant", stopReason: "stop", timestamp: 2,
    content: [{ type: "text", text: "SUCCESSFUL_RETRY" }] });
  assert.match(transcript(), /FAILED_ATTEMPT_STAYS_VISIBLE/, "context omission is not transcript deletion");
  assert.match(transcript(), /LATE_CHILD_HISTORY/, "raw user text stays visible after a context edit");
  assert.doesNotMatch(transcript(), /MODEL_ONLY_REPLACEMENT/);
  assert.match(transcript(), /SUCCESSFUL_RETRY/);
  assert.equal(mounts, 1);
  pane.handleInput("\x1b");
  await opening;
  const reopening = shortcuts.get("alt+a").handler();
  assert.equal(mounts, 2);
  // A fresh transcript must also use raw text, not just retain an older cached
  // user component after the SDK's model projection replaced its content.
  assert.match(transcript(), /LATE_CHILD_HISTORY/);
  assert.doesNotMatch(transcript(), /MODEL_ONLY_REPLACEMENT/);
  assert.match(transcript(), /FAILED_ATTEMPT_STAYS_VISIBLE/);
  panels.dispose();
  await reopening;
});

test("the footer's worker indicator toggles a picker stacked in the bottom-right column", async (t) => {
  const { PresetRouter } = await import("../../dist/routing.js");
  const { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR } = await import("../../../lib/overlay-protocol.mjs");
  const bus = createEventBus(), published = [], mounts = [];
  const router = new PresetRouter(starterPath);
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut() {} },
    widget: { onOpen() {}, agents: () => [], tuiMode: () => "fullscreen" },
    ready: () => true, router: () => router,
    publish: (_candidate, name) => published.push(name), showError: (error) => assert.fail(String(error)),
  });
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {} };
  panels.attachHost({ mode: "tui", ui: { notify() {}, custom(factory, options) {
    return new Promise((resolve) => {
      const component = factory(tui, { ...theme, bg: (_color, text) => text }, { matches: () => false }, resolve);
      mounts.push({ component, options: options.overlayOptions() });
    });
  } } }, bus);
  t.after(() => panels.dispose());
  const click = (key) => { const event = { key, handled: false }; bus.emit(FOOTER_INDICATOR_CLICK_EVENT, event); return event; };

  assert.equal(click("some-other-status").handled, false, "other statuses stay the footer's");
  assert.equal(mounts.length, 0);
  assert.equal(click(WORKER_PRESET_INDICATOR).handled, true);
  await tick();
  assert.equal(mounts.length, 1);
  const { component, options } = mounts[0];
  assert.equal(options.anchor, "bottom-right");
  assert.equal(options.margin.bottom, 1, "rests on the footer row when nothing else is pinned");
  assert.equal(options.nonCapturing, false, "a picker takes the keyboard");
  assert.match(component.render(76)[0], /× ─╮$/, "floating, it closes from the pointer");

  assert.equal(click(WORKER_PRESET_INDICATOR).handled, true);
  await tick();
  assert.deepEqual(published, [], "the second click closes without applying");
  assert.equal(mounts.length, 1);

  click(WORKER_PRESET_INDICATOR);
  await tick();
  const lines = mounts[1].component.render(76);
  const row = lines.findIndex((line) => line.includes("fixture-light"));
  mounts[1].component.handleMouse({ type: "click", button: "left", x: 6, y: row });
  await tick();
  assert.deepEqual(published, ["fixture-light"], "a clicked preset is applied through the audited publish path");
});

for (const action of ["apply", "cancel", "approval", "stale"]) test(`effort editor coordinator forwards an audited draft only on apply (${action})`, { timeout: 2000 }, async (t) => {
  const { PresetRouter, thinkingLevels } = await import("../../dist/routing.js");
  const bus = createEventBus(), router = new PresetRouter(starterPath);
  const before = router.current(), audits = [], errors = [];
  let component, capabilities = 0;
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut() {} }, widget: { onOpen() {}, agents: () => [], tuiMode: () => "regular" },
    ready: () => true, router: () => router,
    // Test coordinator transactions, not a particular built-in effort table.
    efforts() { capabilities++; return { levels: thinkingLevels, inherited: "high" }; },
    publish: (candidate, name, _ctx, overrides) => router.apply(candidate, name, (snapshot) => audits.push(snapshot), overrides),
    showError: (error) => errors.push(error),
  });
  const keys = { matches: (data, binding) => matchesKey(data, {
    "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape",
  }[binding] ?? "f12") };
  const ctx = { mode: "tui", ui: { notify() {}, custom(factory) {
    return new Promise((resolve) => { component = factory({ terminal: { columns: 100, rows: 40 }, requestRender() {} },
      { ...theme, bg: (_color, text) => text }, keys, resolve); });
  } } };
  panels.attachHost(ctx, bus); t.after(() => panels.dispose());
  const opening = panels.selectPreset("", ctx);
  component.handleInput("e"); component.render(76);
  component.handleInput("\u001b[C"); // preset default -> explicit inherit
  assert.equal(audits.length, 0, "editing is draft-only");
  assert.deepEqual(router.current(), before);
  assert(capabilities > 0, "coordinator must forward registry capabilities to the picker");
  if (action === "cancel") component.handleInput("\u001bs");
  else if (action === "approval") bus.emit("permissions:ui_prompt", { requestId: "effort-approval" });
  else {
    if (action === "stale") router.select("fixture-light");
    component.handleInput("\r");
  }
  await opening;
  if (action === "apply") {
    assert.equal(audits.length, 1); assert.deepEqual(router.current().effort_overrides, { light: "inherit" });
    assert.deepEqual(errors, []);
  } else {
    assert.deepEqual(audits, []);
    assert.deepEqual(router.current().effort_overrides, {});
    assert.equal(errors.length, action === "stale" ? 1 : 0);
    if (action === "stale") assert.equal(errors[0].code, "STALE_PRESET_SELECTION");
    else assert.deepEqual(router.current(), before);
  }
});

test("a picker opened behind a tall usage panel appears with the keyboard when that panel closes", async (t) => {
  const { TuiAltScreen } = await import("@earendil-works/pi-tui");
  const { PresetRouter } = await import("../../dist/routing.js");
  const { joinPopoverStack } = await import("../../../lib/popover-stack.mjs");
  const { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR } = await import("../../../lib/overlay-protocol.mjs");
  const bus = createEventBus();
  const router = new PresetRouter(starterPath);
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut() {} },
    widget: { onOpen() {}, agents: () => [], tuiMode: () => "fullscreen" },
    ready: () => true, router: () => router,
    publish() {}, showError: (error) => assert.fail(String(error)),
  });
  // The review's repro: a 12-row terminal with a 9-row usage panel pinned.
  const terminal = { rows: 12, columns: 100, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  tui.requestRender = () => {};
  const paint = () => { for (let pass = 0; pass < 2; pass++) tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows); };
  const editor = { render: () => [], invalidate() {}, handleInput() {} };
  tui.setFocus(editor);
  const usage = joinPopoverStack(tui);
  usage.measure(9);
  let picker;
  // Pi's ui.custom for an overlay: build, show, then hand out the handle.
  panels.attachHost({ mode: "tui", ui: { notify() {}, custom(factory, options) {
    return new Promise((resolve) => {
      let handle;
      picker = factory(tui, { ...theme, bg: (_color, text) => text }, { matches: () => false },
        (value) => { handle?.hide(); resolve(value); });
      handle = tui.showOverlay(picker, options.overlayOptions());
      options.onHandle?.(handle);
    });
  } } }, bus);
  t.after(() => panels.dispose());
  bus.emit(FOOTER_INDICATOR_CLICK_EVENT, { key: WORKER_PRESET_INDICATOR, handled: false });
  await tick();
  paint();
  assert.equal(tui.getFocusedComponent(), editor, "no room: the picker waits off screen, the editor keeps typing");

  usage.leave();
  paint();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tui.getFocusedComponent(), picker, "revealed, ↑↓ Enter Esc reach the picker, not the editor");
  const lines = picker.render(76);
  assert.match(lines.at(-1), /╰─+╯$/, "painted whole, bottom edge included");
  picker.handleInput("\u001b");
  await tick();
});
