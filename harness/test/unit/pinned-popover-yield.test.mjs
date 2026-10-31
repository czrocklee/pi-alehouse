import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { HIDE_TRANSIENT_OVERLAYS_EVENT, PINNED_POPOVER_YIELD_EVENT } from "../../../lib/overlay-protocol.mjs";
import { joinPopoverStack } from "../../../lib/popover-stack.mjs";

// Exercise source without building or trusting a potentially stale shared dist.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { PanelCoordinator } = await jiti.import("../../src/ui/panel-coordinator.ts");
const { PresetPicker } = await jiti.import("../../src/ui/preset-picker.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const stackSize = (tui) => globalThis[Symbol.for("nixos-config.pi.popover-stack.v1")]?.get(tui)?.length ?? 0;

function eventBus() {
  const listeners = new Map(), events = [];
  return {
    events,
    on(channel, handler) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler); listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    emit(channel, payload) {
      events.push({ channel, payload });
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
  };
}

function fixture(t, { floating = true, queued = false, delayed = false, presets = [],
  bus = eventBus(), tui = { terminal: { rows: 24, columns: 100 }, requestRender() {} } } = {}) {
  const shortcuts = new Map(), errors = [], holds = [], lifecycle = [];
  const lower = joinPopoverStack(tui);
  lower.preferWidth(() => 96); lower.measure(9);
  let ready = true, dequeue, finishCustom, component, hidden = false;
  const candidate = { activeName: "off", names: ["off"] };
  const router = { prepare: () => candidate, inspect: () => presets, isCurrent: () => true };
  const off = bus.on(PINNED_POPOVER_YIELD_EVENT, (payload) => {
    holds.push({ ...payload, members: stackSize(tui) });
    lifecycle.push(payload.active ? "hold" : "release");
  });
  const ctx = { mode: "tui", ui: {
    notify() { assert.fail("unexpected UI notice"); },
    custom(factory, options) {
      lifecycle.push("queued");
      return new Promise((resolve, reject) => {
        dequeue = () => {
          lifecycle.push("factory");
          try {
            component = factory(tui, theme, { matches: (data, key) => data === "\x1b" && key === "tui.select.cancel" },
              (choice) => {
                lifecycle.push("done");
                finishCustom = () => resolve(choice);
                if (!delayed) finishCustom();
              });
            lifecycle.push("constructed");
            if (options.overlay) {
              options.onHandle({ hide() { hidden = true; }, isHidden: () => hidden,
                isFocused: () => false, focus() {} });
              options.overlayOptions();
            }
          } catch (error) { reject(error); }
        };
        if (!queued) dequeue();
      });
    },
  } };
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget: { onOpen() {}, tuiMode: () => floating ? "fullscreen" : "regular" },
    ready: () => ready, router: () => router,
    publish() { assert.fail("UI cancellation must not publish routing or Owner changes"); },
    showError(error) { errors.push(error); },
  });
  panels.attachHost(ctx, bus);
  t.after(() => { panels.dispose(); finishCustom?.(); lower.leave(); off(); });
  return { panels, bus, tui, lower, errors, holds, lifecycle,
    open: () => shortcuts.get("alt+s").handler(),
    dequeue: () => dequeue(), releaseCustom: () => finishCustom(),
    component: () => component, setReady: (value) => { ready = value; },
    hide: () => { hidden = true; },
  };
}

function paired(h, members = [1, 1]) {
  assert.deepEqual(h.holds.map(({ active }) => active), [true, false]);
  assert.equal(h.holds[0].token, h.holds[1].token);
  assert.equal(typeof h.holds[0].token, "object");
  assert.deepEqual(h.holds.map((hold) => hold.members), members,
    "start precedes join and release follows the actual member's leave");
}

test("floating mount holds before join, across hidden/settled async UI, then releases after leave", async (t) => {
  const h = fixture(t, { queued: true, delayed: true });
  const opening = h.open();
  assert.deepEqual(h.holds, [], "queue admission is not a mounted picker");
  h.dequeue();
  assert(h.component() instanceof PresetPicker, "the real picker is constructed");
  assert.deepEqual(h.lifecycle, ["queued", "factory", "hold", "constructed"]);
  assert.equal(stackSize(h.tui), 2);
  assert.equal(h.lower.width, 96);
  h.hide(); await tick();
  assert.deepEqual(h.holds.map((hold) => hold.active), [true]);
  h.component().handleInput("\x1b");
  await tick();
  assert.deepEqual(h.holds.map((hold) => hold.active), [true], "done alone does not release an async custom slot");
  assert.equal(stackSize(h.tui), 2);
  assert(h.bus.events.some(({ channel }) => channel === HIDE_TRANSIENT_OVERLAYS_EVENT), "settlement protocol is preserved");
  h.releaseCustom(); await opening;
  paired(h);
  assert.equal(h.lower.width, 96, "the pinned member retains its width and place");
  assert.deepEqual(h.errors, []);
});

for (const reason of ["close", "permission", "dispose"]) {
  test(`mounted floating picker pairs release on ${reason}, repeated disposal stays inert`, async (t) => {
    const h = fixture(t);
    const opening = h.open();
    assert.equal(stackSize(h.tui), 2);
    if (reason === "close") h.open();
    else if (reason === "permission") h.bus.emit("permissions:ui_prompt", { requestId: "synthetic-ask" });
    else h.panels.dispose();
    await opening;
    h.panels.dispose(); h.panels.dispose();
    paired(h);
    assert.deepEqual(h.errors, []);
  });
}

for (const reason of ["cancel", "blocked", "dispose"]) {
  test(`queued ${reason} never mounts or starts a hold`, async (t) => {
    const h = fixture(t, { queued: true });
    const opening = h.open();
    if (reason === "cancel") h.open();
    else if (reason === "blocked") h.setReady(false);
    else h.panels.dispose();
    h.dequeue(); await opening;
    assert.deepEqual(h.holds, []);
    assert.equal(stackSize(h.tui), 1);
    assert(!(h.component() instanceof PresetPicker));
    assert.deepEqual(h.errors, []);
  });
}

test("real picker construction failure releases a successfully mounted floating request", async (t) => {
  const failure = new Error("synthetic picker construction failure");
  const h = fixture(t, { presets: { [Symbol.iterator]() { throw failure; } } });
  await h.open();
  paired(h);
  assert.deepEqual(h.errors, [failure]);
});

for (const active of [true, false]) {
  test(`throwing ${active ? "start" : "release"} emit still pairs the hold and clears picker state`, async (t) => {
    const h = fixture(t);
    const failure = new Error("synthetic event emission failure");
    const off = h.bus.on(PINNED_POPOVER_YIELD_EVENT, (payload) => { if (payload.active === active) throw failure; });
    const opening = h.open();
    if (!active) h.component().handleInput("\x1b");
    await opening;
    paired(h);
    assert.deepEqual(h.errors, [failure]);
    off();
    const again = h.open();
    h.component().handleInput("\x1b"); await again;
    assert.deepEqual(h.holds.map((hold) => hold.active), [true, false, true, false]);
    assert.notEqual(h.holds[0].token, h.holds[2].token);
  });
}

test("ordinary docked picker never acquires a pinned popover hold", async (t) => {
  const h = fixture(t, { floating: false });
  const opening = h.open();
  assert(h.component() instanceof PresetPicker);
  assert.deepEqual(h.holds, []);
  assert.equal(stackSize(h.tui), 1);
  h.component().handleInput("\x1b"); await opening;
  assert.deepEqual(h.holds, []);
  assert.deepEqual(h.errors, []);
});

test("overlapping mounted requests have independent opaque tokens", async (t) => {
  const first = fixture(t, { delayed: true });
  const second = fixture(t, { delayed: true, bus: first.bus, tui: first.tui });
  const a = first.open(), b = second.open();
  const starts = first.holds.filter((hold) => hold.active);
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].token, starts[1].token);
  first.component().handleInput("\x1b"); first.releaseCustom(); await a;
  assert.equal(first.holds.at(-1).token, starts[0].token);
  assert.equal(first.holds.at(-1).active, false);
  assert.equal(stackSize(first.tui), 3, "the second picker and both lower members remain");
  second.component().handleInput("\x1b"); second.releaseCustom(); await b;
  assert.equal(first.holds.at(-1).token, starts[1].token);
  assert.equal(stackSize(first.tui), 2);
  assert.deepEqual(first.errors, []); assert.deepEqual(second.errors, []);
});
