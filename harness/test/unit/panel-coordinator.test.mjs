import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresetRouter, thinkingLevels } from "../../dist/routing.js";
import { applyAuditedPreset } from "../../dist/extension.js";
import { SettingsStore } from "../../../lib/settings-store.mjs";
import { stageWorkerSelection } from "../../dist/ui/preferences-controls.js";
import { createEventBus, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
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

function liveEffortPanels(t, options = {}) {
  const bus = createEventBus(), audits = [], errors = [], notices = [], latched = [], components = [], factories = [], confirmations = [];
  let router = options.router ?? new PresetRouter(starterPath), ready = true, capabilities = 0;
  const controller = { assertOwnerAvailable() {
    if (latched.length) throw Object.assign(new Error("OWNER_FAILED"), { code: "PARENT_SESSION_UNAVAILABLE" });
  }, latchParentHistoryFailure: (error) => latched.push(error) };
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut() {} }, widget: { onOpen() {}, agents: () => [], tuiMode: () => "regular" },
    ready: () => ready, router: () => router,
    efforts() { capabilities++; return { levels: thinkingLevels, inherited: "high" }; },
    publish: (candidate, name, _ctx, overrides) => {
      const before = router.current(), targetBefore = router.inspect(candidate).find((item) => item.name === name);
      const selection = applyAuditedPreset({ controller, router, candidate, name, effort_overrides: overrides,
        validate: () => { if (options.validationError) throw options.validationError; },
        audit: (snapshot) => { if (options.auditError) throw options.auditError; audits.push(structuredClone(snapshot)); } });
      const publication = { selection, candidate: router.rebase(candidate) };
      try {
        if (options.store) stageWorkerSelection(options.store, selection, before, overrides !== undefined, targetBefore?.effort_overrides ?? {});
        options.afterCommit?.(selection);
      } catch (error) { notices.push(String(error)); } // presentation/persistence warning, never rollback
      return publication;
    },
    showError: (error) => errors.push(error),
    ...(options.management ? { management: options.management } : {}),
  });
  const keys = { matches: (data, binding) => matchesKey(data, {
    "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape",
  }[binding] ?? "f12") };
  const ctx = { mode: "tui", ui: { notify: (text) => notices.push(text),
    confirm: async (title, text) => { confirmations.push({ title, text, closed: components.at(-1)?.isOpen() === false });
      return await options.confirm?.(title, text) ?? false; },
    custom(factory) {
      return new Promise((resolve) => {
        const mount = () => components.push(factory({ terminal: { columns: 100, rows: 40 }, requestRender() {} },
          { ...theme, bg: (_color, text) => text }, keys, resolve));
        if (options.deferMount) factories.push(mount); else mount();
      });
    } } };
  panels.attachHost(ctx, bus); t.after(() => panels.dispose());
  return { panels, ctx, bus, audits, errors, notices, latched, components, confirmations,
    get router() { return router; }, get component() { return components.at(-1); }, get capabilities() { return capabilities; },
    replaceRouter: (value) => { router = value; }, retire: () => { ready = false; }, mount: () => factories.shift()?.() };
}

for (const closing of ["escape", "toggle", "approval"]) test(`immediate effort audits survive ${closing} without an extra Apply`, async (t) => {
  const h = liveEffortPanels(t), before = h.router.current(), opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("e"); h.component.handleInput("\u001b[C");
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.router.current().effort_overrides, { light: "inherit" });
  assert.deepEqual(before.effort_overrides, {}, "an already allocated snapshot is unchanged");
  assert(h.capabilities > 0);
  if (closing === "escape") { h.component.handleInput("\u001b"); h.component.handleInput("\u001b"); }
  else if (closing === "toggle") h.component.handleInput("\u001bs");
  else h.bus.emit("permissions:ui_prompt", { requestId: "effort-approval" });
  await opening;
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.router.current().effort_overrides, { light: "inherit" });
  assert.deepEqual(h.errors, []);
});

test("multiple live edits, reset, Enter/back and later preset selection use the latest own commit", async (t) => {
  const h = liveEffortPanels(t), opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("e"); h.component.handleInput("\u001b[C");
  h.component.handleInput("\u001b[B"); h.component.handleInput("\u001b[C");
  assert.deepEqual(h.router.current().effort_overrides, { light: "inherit", standard: "inherit" });
  h.component.handleInput("r");
  assert.deepEqual(h.router.current().effort_overrides, {});
  assert.equal(h.audits.length, 3);
  h.component.handleInput("\r"); // back, not publication
  assert.equal(h.audits.length, 3);
  const names = h.router.names(), next = names[names.indexOf(h.router.current().name) + 1];
  h.component.handleInput("\u001b[B"); h.component.handleInput("\r");
  await opening;
  assert.equal(h.router.current().name, next);
  assert.equal(h.audits.length, 4);
  assert.deepEqual(h.errors, []);
});

for (const failure of ["validation", "audit"]) test(`a live ${failure} failure paints only the last committed values`, async (t) => {
  const error = Object.assign(new Error("CONTROLLED_REJECTION"), { code: "THINKING_INCOMPATIBLE" });
  const h = liveEffortPanels(t, { [failure === "validation" ? "validationError" : "auditError"]: error });
  const before = h.router.current(), opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("e");
  assert.doesNotThrow(() => h.component.handleInput("\u001b[C"));
  assert.deepEqual(h.router.current(), before);
  assert.deepEqual(h.audits, []);
  assert.equal(h.errors[0].code, failure === "validation" ? "THINKING_INCOMPATIBLE" : "PRESET_AUDIT_FAILED");
  assert.equal(h.latched.length, failure === "audit" ? 1 : 0);
  assert.match(h.component.render(76).join("\n"), /light:default/);
  assert.match(h.component.render(76).join("\n"), /Change not applied/);
  h.component.handleInput("\u001bs"); await opening;
});

for (const invalidation of ["external", "round-trip", "router", "retire", "dispose", "settled"]) {
  test(`old effort callbacks cannot publish after ${invalidation}`, async (t) => {
    const h = liveEffortPanels(t), original = h.router, opening = h.panels.selectPreset("", h.ctx);
    const setter = h.component.options.setEffort;
    if (invalidation === "external") h.router.select("fixture-light");
    else if (invalidation === "round-trip") { h.router.select("fixture-light"); h.router.select("fixture-balanced"); }
    else if (invalidation === "router") h.replaceRouter(new PresetRouter(starterPath));
    else if (invalidation === "retire") h.retire();
    else if (invalidation === "dispose") h.panels.dispose();
    else h.component.handleInput("\u001b"); // settled, before the awaiting continuation runs
    const before = original.current();
    assert.equal(setter("fixture-balanced", { light: "off" }), undefined);
    assert.deepEqual(original.current(), before);
    assert.deepEqual(h.audits, []);
    if (h.component.isOpen()) h.component.handleInput("\u001bs");
    await opening;
  });
}

test("a queued factory drops an externally invalidated effort editor before it mounts", async (t) => {
  const h = liveEffortPanels(t, { deferMount: true }), opening = h.panels.selectPreset("", h.ctx);
  h.router.select("fixture-light"); h.mount(); await opening;
  assert.deepEqual(h.audits, []);
  assert.equal(h.component.isOpen, undefined, "the obsolete factory returns an inert component");
});

for (const accepted of [false, true]) test(`inactive effort entry confirms after picker closure (accepted=${accepted})`, async (t) => {
  const h = liveEffortPanels(t, { confirm: async () => accepted }); h.router.select("off");
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("\u001b[B"); h.component.handleInput("e");
  await tick();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].closed, true, "standard confirm never nests under custom");
  if (!accepted) {
    await opening;
    assert.equal(h.router.current().name, "off"); assert.deepEqual(h.audits, []); assert.equal(h.components.length, 1);
  } else {
    assert.equal(h.components.length, 2, "confirmed selection reopens directly on its effort page");
    assert.match(h.component.render(76).join("\n"), /Effort · fixture-balanced/);
    assert.equal(h.audits.length, 1, "enabling is explicitly audited once");
    h.component.handleInput("\u001b[C");
    assert.deepEqual(h.router.current().effort_overrides, { light: "inherit" });
    assert.equal(h.audits.length, 2);
    h.component.handleInput("\u001bs"); await opening;
  }
  assert.deepEqual(h.errors, []);
});

for (const invalidation of ["external", "round-trip", "router", "retire", "dispose", "approval"]) {
  test(`inactive effort consent cannot enable after ${invalidation}`, async (t) => {
    let answer;
    const h = liveEffortPanels(t, { confirm: () => new Promise((resolve) => { answer = resolve; }) });
    h.router.select("off");
    const opening = h.panels.selectPreset("", h.ctx);
    h.component.handleInput("\u001b[B"); h.component.handleInput("e"); await tick();
    let entered = false;
    await h.panels.withManagement(async () => { entered = true; });
    assert.equal(entered, false, "consent owns the management latch");
    if (invalidation === "external") h.router.select("fixture-light");
    else if (invalidation === "round-trip") { h.router.select("fixture-light"); h.router.select("off"); }
    else if (invalidation === "router") h.replaceRouter(new PresetRouter(starterPath));
    else if (invalidation === "retire") h.retire();
    else if (invalidation === "dispose") h.panels.dispose();
    else h.bus.emit("permissions:ui_prompt", { requestId: "inactive-effort-ask" });
    answer(true); await opening;
    assert.deepEqual(h.audits, []);
    assert.equal(h.components.length, 1, "no obsolete reopen");
  });
}

test("live effort continuations do not reread changed or missing catalogue files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-live-effort-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "presets.json"), body = { version: "v1", models: { light: "fixture/old", standard: "fixture/old", strong: "fixture/old" } };
  await writeFile(path, JSON.stringify({ version: 2, defaultPreset: "team", presets: { team: body, other: body } }));
  const h = liveEffortPanels(t, { router: new PresetRouter(path) }), opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("e"); h.component.handleInput("\u001b[C");
  await writeFile(path, "invalid JSON must not be reread");
  h.component.handleInput("\u001b[B"); h.component.handleInput("\u001b[C");
  assert.deepEqual(h.router.current().effort_overrides, { light: "inherit", standard: "inherit" });
  assert.equal(h.router.current().models.light, "fixture/old");
  await rm(path);
  h.component.handleInput("r"); h.component.handleInput("\r"); h.component.handleInput("\u001b[A"); h.component.handleInput("\r");
  await opening;
  assert.equal(h.router.current().name, "other");
  assert.deepEqual(h.errors, []);
});

test("immediate efforts stage explicit persistent leaves without writing files or undoing on close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-live-effort-settings-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore({ agentDir: join(root, "agent"), cwd: root, projectTrusted: true }); store.setScope("workspace");
  const h = liveEffortPanels(t, { store, afterCommit: () => { throw new Error("FOOTER_FAILED_AFTER_COMMIT"); } });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("e"); h.component.handleInput("\u001b[C");
  assert.deepEqual(store.get("workspace").effort["fixture-balanced"], { light: "inherit" });
  assert.match(h.component.render(76).join("\n"), /light:inherit/);
  h.component.handleInput("r");
  assert.equal(store.get("workspace").effort["fixture-balanced"].light, null);
  h.component.handleInput("\u001bs"); await opening;
  assert.deepEqual(h.router.current().effort_overrides, {});
  assert.equal(h.audits.length, 2);
  assert.deepEqual(h.errors, []);
  assert(h.notices.some((notice) => notice.includes("FOOTER_FAILED_AFTER_COMMIT")));
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

// Settings/preset management routing: the coordinator forwards the picker's
// management choices to the host integration's standard dialogs, only after
// the ui.custom interaction has fully settled, and never publishes for them.
async function managementPanels(t, overrides = {}) {
  const { PresetRouter } = await import("../../dist/routing.js");
  const bus = createEventBus(), router = new PresetRouter(starterPath);
  const notices = [], errors = [], published = [], calls = [];
  let component, settled = false, mounts = 0, ready = true;
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut() {} },
    widget: { onOpen() {}, agents: () => [], tuiMode: () => overrides.fullscreen ? "fullscreen" : "regular" },
    ready: () => ready, router: () => router,
    publish: (_candidate, name) => published.push(name),
    showError: (error) => errors.push(error),
    management: {
      summary: () => " presets: controlled fixture · pending: none",
      // Overrides wrap the recording, so a test can defer or fail the dialog
      // while the route itself stays observable.
      settings: async () => { await overrides.settings?.(); calls.push(["settings", undefined, settled, mounts]); },
      ...(overrides.saveDefault ? {
        saveDefault: async (scope) => { await overrides.saveDefault(scope); calls.push(["save", scope, settled, mounts]); },
        canSaveWorkspace: () => overrides.canSaveWorkspace?.() ?? true,
      } : {}),
      editPreset: overrides.editPreset === null ? undefined
        : async (name) => { await overrides.editPreset?.(name); calls.push(["edit", name, settled, mounts]); },
      editModel: overrides.editModel === null ? undefined
        : async (name, slot, position) => { await overrides.editModel?.(name, slot, position);
          calls.push(["editModel", name, slot, position, settled, mounts]); },
      ...(overrides.cancelModelSelection === null ? {} : {
        cancelModelSelection: () => { overrides.cancelModelSelection?.(); },
      }),
    },
  });
  const keys = { matches: (data, binding) => matchesKey(data, {
    "tui.select.up": "up", "tui.select.down": "down",
    "tui.select.confirm": "enter", "tui.select.cancel": "escape",
  }[binding] ?? "f12") };
  const ctx = { mode: "tui", ui: { notify: (message) => notices.push(message), custom(factory) {
    mounts++;
    return new Promise((resolve) => { component = factory({ terminal: { columns: 100, rows: 40 }, requestRender() {} },
      { ...theme, bg: (_color, text) => text }, keys, (value) => { settled = true; resolve(value); }); });
  } } };
  panels.attachHost(ctx, bus);
  t.after(() => panels.dispose());
  return { panels, bus, ctx, calls, errors, published, notices,
    get component() { return component; }, get mounts() { return mounts; },
    loseReadiness: () => { ready = false; } };
}

test("management routes run the host dialogs after the picker settles, never publishing", async (t) => {
  const settings = await managementPanels(t);
  const opening = settings.panels.selectPreset("", settings.ctx);
  assert.match(settings.component.render(76).join("\n"), /controlled fixture · pending: none/,
    "the coordinator forwards the summary to the picker");
  settings.component.handleInput("p");
  await opening;
  assert.deepEqual(settings.calls, [["settings", undefined, true, 1]],
    "the dialog runs only after ui.custom settled, with no reopen");
  assert.deepEqual(settings.published, [], "a management route never publishes a candidate");
  assert.deepEqual(settings.errors, []); assert.deepEqual(settings.notices, []);
  assert.equal(settings.mounts, 1, "no automatic reopen after the dialog");

  const created = await managementPanels(t);
  const creating = created.panels.selectPreset("", created.ctx);
  created.component.handleInput("n");
  await creating;
  assert.deepEqual(created.calls, [["edit", undefined, true, 1]], "create reaches editPreset(undefined)");

  const edited = await managementPanels(t);
  const editing = edited.panels.selectPreset("", edited.ctx);
  edited.component.render(76);
  edited.component.handleInput("c"); // the highlighted active preset
  await editing;
  assert.deepEqual(edited.calls.map(([kind, name]) => [kind, name]), [["edit", "fixture-balanced"]],
    "edit-preset carries the highlighted preset's name");
});

test("a host without the preset dialog keeps preset routes inert, settings still routes", async (t) => {
  const h = await managementPanels(t, { editPreset: null });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.render(76);
  h.component.handleInput("n"); // inert: the picker stays open
  h.component.handleInput("c");
  assert.deepEqual(h.calls, []);
  h.component.handleInput("p");
  await opening;
  assert.deepEqual(h.calls.map(([kind]) => [kind]), [["settings"]]);
  assert.deepEqual(h.published, []); assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
});

test("worker save routes settle before the host callback and do not carry an inactive highlight", async (t) => {
  for (const [key, scope] of [["g", "global"], ["w", "workspace"]]) {
    const h = await managementPanels(t, { saveDefault: async () => {} });
    const opening = h.panels.selectPreset("", h.ctx);
    h.component.handleInput("\u001b[B");
    h.component.handleInput(key);
    await opening;
    assert.deepEqual(h.calls, [["save", scope, true, 1]]);
    assert.deepEqual(h.published, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.mounts, 1);
  }
});

for (const interruption of ["trust", "readiness", "dispose", "approval"]) {
  test(`a settled worker save route is dropped on ${interruption} before its dialog`, async (t) => {
    let trusted = true;
    const h = await managementPanels(t, { saveDefault: async () => {}, canSaveWorkspace: () => trusted });
    const opening = h.panels.selectPreset("", h.ctx);
    h.component.handleInput("w");
    if (interruption === "trust") trusted = false;
    else if (interruption === "readiness") h.loseReadiness();
    else if (interruption === "dispose") h.panels.dispose();
    else h.bus.emit("permissions:ui_prompt", { requestId: "worker-save-ask" });
    await opening;
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.published, []);
    assert.deepEqual(h.errors, []);
    if (interruption === "approval") h.bus.emit("permissions:decision", { requestId: "worker-save-ask" });
  });
}

test("worker save dialogs share the management latch and release it after errors", async (t) => {
  let reject;
  const failure = new Error("SAVE_DIALOG_FAILED");
  const h = await managementPanels(t, { saveDefault: () => new Promise((_resolve, decline) => { reject = decline; }) });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("g");
  await tick();
  let entered = false;
  await h.panels.withManagement(async () => { entered = true; });
  await h.panels.selectPreset("", h.ctx);
  assert.equal(entered, false);
  assert.equal(h.mounts, 1, "a pending save owns the interaction");
  reject(failure); await opening;
  assert.deepEqual(h.errors, [failure]);
  await h.panels.withManagement(async () => { entered = true; });
  assert(entered, "the failed save released the latch");
  assert.deepEqual(h.published, []);
});

test("the management latch serializes dialog sequences and releases afterwards", async (t) => {
  let release;
  const h = await managementPanels(t, { settings: () => new Promise((resolve) => { release = resolve; }) });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("p");
  await tick(); // let the settled picker hand the route to the latched sequence
  const blocked = h.panels.selectPreset("", h.ctx); // a second picker over the dialog
  await blocked;
  assert.ok(h.notices.some((message) => message.includes("unavailable")),
    "the picker refuses to open while a management dialog is active");
  assert.equal(h.mounts, 1);
  assert.deepEqual(h.published, []); assert.deepEqual(h.errors, []);
  release();
  await opening;
  assert.deepEqual(h.calls.map(([kind]) => [kind]), [["settings"]], "exactly one dialog sequence ran");

  const again = h.panels.selectPreset("", h.ctx); // the latch released
  assert.equal(h.mounts, 2);
  assert.deepEqual(h.notices.filter((message) => message.includes("unavailable")).length, 1);
  h.component.handleInput("p");
  await tick();
  release();
  await again;
  assert.deepEqual(h.calls.map(([kind]) => [kind]), [["settings"], ["settings"]]);
});

test("direct management uses the same latch and releases it on error, permission yield and disposal", async (t) => {
  const h = await managementPanels(t);
  let release;
  const active = h.panels.withManagement(() => new Promise((resolve) => { release = resolve; }));
  let entered = false;
  await h.panels.withManagement(async () => { entered = true; });
  await h.panels.selectPreset("", h.ctx);
  assert.equal(entered, false);
  assert.equal(h.mounts, 0, "direct dialogs block competing picker mounts");
  release(); await active;
  const failure = new Error("DIRECT_MANAGEMENT_FAILED");
  await assert.rejects(h.panels.withManagement(async () => { throw failure; }), (error) => error === failure);
  await h.panels.withManagement(async () => { entered = true; });
  assert(entered, "failure releases the shared latch");
  h.bus.emit("permissions:ui_prompt", { requestId: "direct-management-ask" });
  assert.equal(h.panels.modelSelectionAllowed(), false);
  entered = false;
  await h.panels.withManagement(async () => { entered = true; });
  assert.equal(entered, false, "new direct dialogs cannot cover a pending ask");
  h.bus.emit("permissions:decision", { requestId: "direct-management-ask" });
  assert.equal(h.panels.modelSelectionAllowed(), true);
  let reject;
  const stale = h.panels.withManagement(() => new Promise((_resolve, decline) => { reject = decline; }));
  h.panels.dispose(); reject(failure);
  await stale; // A retired host cannot receive the late error callback.
  assert.equal(h.panels.modelSelectionAllowed(), false);
  assert.deepEqual(h.errors, []);
});

test("a failing management dialog reports through showError and releases the latch", async (t) => {
  const failure = new Error("SETTINGS_DIALOG_FAILED");
  const h = await managementPanels(t, { settings: async () => { throw failure; } });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("p");
  await opening;
  assert.deepEqual(h.errors, [failure], "dialog failures surface through showError");
  assert.deepEqual(h.published, []); assert.deepEqual(h.notices, []);
  const again = h.panels.selectPreset("", h.ctx);
  assert.equal(h.mounts, 2, "the latch released despite the failure");
  h.component.handleInput("\u001b");
  await again;
  assert.deepEqual(h.calls, []);
});

test("routes chosen across teardown or lost readiness never reach the dialogs", async (t) => {
  const stale = await managementPanels(t);
  const opening = stale.panels.selectPreset("", stale.ctx);
  stale.component.handleInput("p");
  stale.loseReadiness(); // the Owner went away after the picker settled
  await opening;
  assert.deepEqual(stale.calls, [], "no dialog after readiness was lost");
  assert.deepEqual(stale.published, []); assert.deepEqual(stale.errors, []);

  const disposed = await managementPanels(t);
  const pending = disposed.panels.selectPreset("", disposed.ctx);
  disposed.panels.dispose(); // closes the open picker
  disposed.component.handleInput("p"); // a retained component: already cancelled
  await pending;
  assert.deepEqual(disposed.calls, [], "an old picker cannot invoke a newer session's callbacks");
  assert.deepEqual(disposed.published, []); assert.deepEqual(disposed.errors, []);
  assert.deepEqual(disposed.notices, []);
});

test("disposing mid-dialog ends the sequence without publishes or reopens", async (t) => {
  let release;
  const h = await managementPanels(t, { settings: () => new Promise((resolve) => { release = resolve; }) });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("p");
  await tick();
  h.panels.dispose();
  release();
  await opening;
  assert.deepEqual(h.calls.map(([kind]) => [kind]), [["settings"]], "the host's own dialog completes");
  assert.deepEqual(h.published, [], "nothing is published after teardown");
  assert.deepEqual(h.errors, []);
  assert.equal(h.mounts, 1, "no reopen after the dialog or the teardown");
});

test("a host disposed while the dialog was awaited receives no further callbacks", async (t) => {
  let reject;
  const failure = new Error("DIALOG_FAILED_AFTER_DISPOSE");
  const h = await managementPanels(t, { settings: () => new Promise((_resolve, decline) => { reject = decline; }) });
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.handleInput("p");
  await tick();
  h.panels.dispose(); // the host goes away mid-dialog
  reject(failure); // the host's own dialog then fails against the retired UI
  await opening;
  assert.deepEqual(h.calls, [], "the route is not recorded as completed for the retired host");
  assert.deepEqual(h.errors, [], "no showError callback through the disposed host, nothing reported after teardown");
  assert.deepEqual(h.published, []);
  assert.equal(h.mounts, 1);
});

test("an edit-model route reaches the host callback after the picker settles with exact slot and position", async (t) => {
  const keyboard = await managementPanels(t);
  const opening = keyboard.panels.selectPreset("", keyboard.ctx);
  assert.match(keyboard.component.render(76).join("\n"), /123/, "the callback's presence gates the picker's model routes");
  keyboard.component.handleInput("2"); // keyboard: the standard slot, no position
  await opening;
  assert.deepEqual(keyboard.calls.map(([kind, name, slot, position]) => [kind, name, slot, position]),
    [["editModel", "fixture-balanced", "standard", undefined]]);
  assert.equal(keyboard.calls[0][4], true, "the dialog runs only after ui.custom settled");
  assert.equal(keyboard.calls[0][5], 1, "no automatic reopen of the worker panel");
  assert.deepEqual(keyboard.published, [], "a model route never publishes a candidate");
  assert.deepEqual(keyboard.errors, []); assert.deepEqual(keyboard.notices, []);

  // A floating click carries the pointer's absolute screen position through.
  const clicked = await managementPanels(t, { fullscreen: true });
  const clickOpening = clicked.panels.selectPreset("", clicked.ctx);
  assert.equal(clicked.panels.isFullscreen(), true, "the renderer projection reads the captured mode");
  const lines = clicked.component.render(76).map(stripTerminalSequences);
  const y = lines.findIndex((line) => line.includes("fixture-light-model"));
  assert(y > 0, lines.join("\n"));
  clicked.component.handleMouse({ type: "click", button: "left",
    x: lines[y].indexOf("fixture-light-model"), y, screenX: 33, screenY: 9 });
  await clickOpening;
  assert.deepEqual(clicked.calls.map(([kind, name, slot, position]) => [kind, name, slot, position]),
    [["editModel", "fixture-balanced", "light", { row: 9, col: 33 }]],
    "the click's absolute coordinates reach the callback verbatim");
  assert.deepEqual(clicked.published, []);
});

test("model routes share the management latch, error reporting and stale-host guards", async (t) => {
  const failure = new Error("MODEL_DIALOG_FAILED");
  const failing = await managementPanels(t, { editModel: async () => { throw failure; } });
  const opening = failing.panels.selectPreset("", failing.ctx);
  failing.component.render(76);
  failing.component.handleInput("1");
  await opening;
  assert.deepEqual(failing.errors, [failure], "model dialog failures surface through showError");
  assert.deepEqual(failing.published, []);
  const again = failing.panels.selectPreset("", failing.ctx);
  assert.equal(failing.mounts, 2, "the latch released despite the failure");
  assert.deepEqual(failing.notices.filter((message) => message.includes("unavailable")), []);
  failing.component.handleInput("\u001b");
  await again;

  const stale = await managementPanels(t);
  const staleOpening = stale.panels.selectPreset("", stale.ctx);
  stale.component.render(76);
  stale.component.handleInput("3");
  stale.loseReadiness();
  await staleOpening;
  assert.deepEqual(stale.calls, [], "no dialog after readiness was lost");
  assert.deepEqual(stale.published, []);

  const denied = await managementPanels(t, { editModel: null });
  const deniedOpening = denied.panels.selectPreset("", denied.ctx);
  const text = denied.component.render(76).join("\n");
  assert.doesNotMatch(text, /123/, "no model hint without the host callback");
  denied.component.handleInput("1"); // gated off: the picker stays open
  denied.component.handleInput("\u001b");
  await deniedOpening;
  assert.deepEqual(denied.calls, []);
  assert.deepEqual(denied.published, []);
});

test("a permission ask releases an open model selection first, best-effort", async (t) => {
  const cancelled = [];
  const h = await managementPanels(t, { cancelModelSelection: () => cancelled.push("cancel") });
  const opening = h.panels.selectPreset("", h.ctx);
  h.bus.emit("permissions:ui_prompt", { requestId: "model-ask" });
  await opening;
  assert.deepEqual(cancelled, ["cancel"], "the model selection is cancelled before the ordinary yield");
  assert.deepEqual(h.published, [], "the cancelled selection publishes nothing");
  assert.deepEqual(h.errors, []);
  // The ask itself still registered and holds the queue.
  await h.panels.selectPreset("", h.ctx);
  assert(h.notices.some((message) => message.includes("unavailable")), "the pending ask refuses a new picker");
  assert.equal(h.mounts, 1);
  h.bus.emit("permissions:decision", { requestId: "model-ask" });
  const reopened = h.panels.selectPreset("", h.ctx);
  assert.equal(h.mounts, 2, "the decision frees the queue again");
  h.component.handleInput("\u001b");
  await reopened;
});

test("a throwing model-selection cancel never blocks the yield or later asks", async (t) => {
  const h = await managementPanels(t, { cancelModelSelection: () => { throw new Error("CANCEL_MODEL_FAILED"); } });
  const opening = h.panels.selectPreset("", h.ctx);
  h.bus.emit("permissions:ui_prompt", { requestId: "model-ask" });
  await opening;
  assert(h.notices.some((message) => message.includes("CANCEL_MODEL_FAILED")),
    "the cleanup failure is reported through the observer, not thrown");
  assert.deepEqual(h.published, []);
  await h.panels.selectPreset("", h.ctx);
  assert(h.notices.some((message) => message.includes("unavailable")), "the ask registered despite the throwing cancel");
  assert.equal(h.mounts, 1, "the picker still closed");
  h.bus.emit("permissions:decision", { requestId: "model-ask" });
  const reopened = h.panels.selectPreset("", h.ctx);
  assert.equal(h.mounts, 2, "the queue recovered from the failed cleanup");
  h.component.handleInput("\u001b");
  await reopened;
});

test("without the cancel callback a permission ask just yields as before", async (t) => {
  const h = await managementPanels(t, { cancelModelSelection: null });
  const opening = h.panels.selectPreset("", h.ctx);
  h.bus.emit("permissions:ui_prompt", { requestId: "plain-ask" });
  await opening;
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.errors, []);
  assert(h.notices.every(({ message }) => !message.includes("Harness panel UI failed")), "no cleanup failure is invented");
  h.bus.emit("permissions:decision", { requestId: "plain-ask" });
  const reopened = h.panels.selectPreset("", h.ctx);
  assert.equal(h.mounts, 2);
  h.component.handleInput("\u001b");
  await reopened;
});

test("a route finishing while a permission ask appears is dropped, and works again after idle", async (t) => {
  const h = await managementPanels(t);
  const opening = h.panels.selectPreset("", h.ctx);
  h.component.render(76);
  h.component.handleInput("1"); // the picker finishes an edit-model route
  h.bus.emit("permissions:ui_prompt", { requestId: "race-ask" }); // before the route's dialog runs
  await opening;
  assert.deepEqual(h.calls, [], "the model route is dropped while the ask is pending");
  assert.deepEqual(h.published, [], "nothing is published for a dropped route");
  h.bus.emit("permissions:decision", { requestId: "race-ask" });
  const next = h.panels.selectPreset("", h.ctx);
  h.component.render(76);
  h.component.handleInput("1");
  await next;
  assert.deepEqual(h.calls.map(([kind, name, slot]) => [kind, name, slot]),
    [["editModel", "fixture-balanced", "light"]], "the route works once the ask has settled");
  assert.deepEqual(h.published, []);

  // The same pane gate drops a settings route finishing into a pending ask.
  const settings = await managementPanels(t);
  const settingsOpening = settings.panels.selectPreset("", settings.ctx);
  settings.component.render(76);
  settings.component.handleInput("p");
  settings.bus.emit("permissions:ui_prompt", { requestId: "settings-ask" });
  await settingsOpening;
  assert.deepEqual(settings.calls, [], "a settings route never covers the pending ask either");
  assert.deepEqual(settings.published, []);
  settings.bus.emit("permissions:decision", { requestId: "settings-ask" });
});
