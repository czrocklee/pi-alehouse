import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { PINNED_POPOVER_YIELD_EVENT } from "../../src/shared/overlay-protocol.mjs";
import { joinPopoverStack } from "../../src/shared/popover-stack.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const stackSize = (tui) =>
  globalThis[Symbol.for("nixos-config.pi.popover-stack.v1")]?.get(tui)?.length ?? 0;

function eventBus() {
  const listeners = new Map(),
    events = [];
  return {
    events,
    on(channel, handler) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    emit(channel, payload) {
      events.push({ channel, payload });
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
  };
}

function fixture(t, { floating = true, queued = false, delayed = false, presets = [] } = {}) {
  const bus = eventBus(),
    lifecycle = eventBus(),
    shortcuts = new Map(),
    errors = [],
    notices = [];
  let ready = true,
    dequeue,
    finishCustom,
    component,
    customCalls = 0,
    hidden = false,
    showFailure;
  const tui = {
    mode: floating ? "fullscreen" : "regular",
    terminal: { rows: 24, columns: 100 },
    requestRender() {},
    showOverlay(view, options) {
      if (showFailure) throw showFailure;
      component = view;
      options.visible?.();
      return {
        hide() {
          hidden = true;
        },
        isHidden: () => hidden,
        isFocused: () => false,
        focus() {},
      };
    },
  };
  const lower = joinPopoverStack(tui);
  lower.preferWidth(() => 96);
  lower.measure(9);
  const candidate = { activeName: "off", names: ["off"] };
  const router = { prepare: () => candidate, inspect: () => presets, isCurrent: () => true };
  const ctx = {
    mode: "tui",
    ui: {
      theme,
      notify: (message) => notices.push(message),
      setWidget(_key, factory) {
        if (typeof factory === "function") factory(tui, theme);
      },
      custom(factory, options) {
        customCalls++;
        assert.equal(options.overlay, false, "only regular-mode pickers use custom prompts");
        return new Promise((resolve, reject) => {
          dequeue = () => {
            try {
              component = factory(
                tui,
                theme,
                { matches: (data, key) => data === "\x1b" && key === "tui.select.cancel" },
                (choice) => {
                  finishCustom = () => resolve(choice);
                  if (!delayed) finishCustom();
                },
              );
            } catch (error) {
              reject(error);
            }
          };
          if (!queued) dequeue();
        });
      },
    },
  };
  const panels = new PanelCoordinator({
    pi: {
      events: bus,
      on: lifecycle.on,
      registerShortcut: (name, spec) => shortcuts.set(name, spec),
    },
    widget: { onOpen() {}, tuiMode: () => tui.mode },
    ready: () => ready,
    router: () => router,
    publish() {
      assert.fail("UI cancellation must not publish routing or Owner changes");
    },
    showError: (error) => errors.push(error),
  });
  panels.attachHost(ctx, bus);
  t.after(() => {
    panels.dispose();
    finishCustom?.();
    lower.leave();
  });
  return {
    panels,
    bus,
    lifecycle,
    tui,
    lower,
    errors,
    notices,
    open: () => shortcuts.get("alt+s").handler(),
    dequeue: () => dequeue(),
    releaseCustom: () => finishCustom(),
    component: () => component,
    customCalls: () => customCalls,
    hidden: () => hidden,
    setReady: (value) => {
      ready = value;
    },
    failShow: (error) => {
      showFailure = error;
    },
  };
}

function noHold(h) {
  assert.deepEqual(
    h.bus.events.filter(({ channel }) => channel === PINNED_POPOVER_YIELD_EVENT),
    [],
    "a Routing popover never asks pinned Context/Usage members to yield",
  );
}

for (const reason of ["close", "permission", "prompt", "dispose"]) {
  test(`floating picker stacks without a custom prompt and cleans up on ${reason}`, async (t) => {
    const h = fixture(t);
    const opening = h.open();
    assert(h.component() instanceof PresetPicker);
    assert.equal(h.customCalls(), 0);
    assert.equal(stackSize(h.tui), 2);
    assert.equal(h.lower.width, 96);
    if (reason === "close") h.open();
    else if (reason === "permission")
      h.bus.emit("permissions:ui_prompt", { requestId: "synthetic-ask" });
    else if (reason === "prompt") h.lifecycle.emit("ui_prompt_start", { kind: "confirm" });
    else h.panels.dispose();
    await opening;
    assert.equal(h.hidden(), true);
    assert.equal(h.component().isOpen(), false);
    assert.equal(stackSize(h.tui), 1);
    assert.equal(h.lower.width, 96, "the pinned member retains its width and place");
    h.panels.dispose();
    h.panels.dispose();
    noHold(h);
    assert.deepEqual(h.errors, []);
  });
}

for (const kind of ["confirm", "custom"]) {
  test(`an existing ${kind} prompt blocks floating picker admission until prompt end`, async (t) => {
    const h = fixture(t);
    h.lifecycle.emit("ui_prompt_start", { kind });
    await h.open();
    assert.equal(h.component(), undefined);
    assert.equal(stackSize(h.tui), 1);
    assert.equal(h.notices.length, 1);
    h.lifecycle.emit("ui_prompt_end", { kind });
    const opening = h.open();
    assert(h.component() instanceof PresetPicker);
    h.component().handleInput("\x1b");
    await opening;
    noHold(h);
    assert.deepEqual(h.errors, []);
  });
}

for (const failureAt of ["construction", "show"]) {
  test(`floating picker ${failureAt} failure releases its stack member and resets admission`, async (t) => {
    const failure = new Error(`synthetic ${failureAt} failure`);
    const h = fixture(t, {
      ...(failureAt === "construction"
        ? {
            presets: {
              [Symbol.iterator]() {
                throw failure;
              },
            },
          }
        : {}),
    });
    if (failureAt === "show") h.failShow(failure);
    await h.open();
    assert.equal(stackSize(h.tui), 1);
    assert.deepEqual(h.errors, [failure]);
    await h.open();
    assert.deepEqual(h.errors, [failure, failure], "failure does not leave the picker lock set");
    noHold(h);
  });
}

for (const reason of ["cancel", "blocked", "dispose"]) {
  test(`queued regular picker ${reason} never constructs a live component`, async (t) => {
    const h = fixture(t, { floating: false, queued: true });
    const opening = h.open();
    if (reason === "cancel") h.open();
    else if (reason === "blocked") h.setReady(false);
    else h.panels.dispose();
    h.dequeue();
    await opening;
    assert.equal(h.customCalls(), 1);
    assert.equal(stackSize(h.tui), 1);
    assert(!(h.component() instanceof PresetPicker));
    noHold(h);
    assert.deepEqual(h.errors, []);
  });
}

test("regular picker retains its custom prompt until asynchronous completion", async (t) => {
  const h = fixture(t, { floating: false, delayed: true });
  const opening = h.open();
  assert(h.component() instanceof PresetPicker);
  h.lifecycle.emit("ui_prompt_start", { kind: "custom" });
  assert.equal(h.component().isOpen(), true, "the docked picker does not close its own prompt");
  h.component().handleInput("\x1b");
  await tick();
  h.releaseCustom();
  await opening;
  h.lifecycle.emit("ui_prompt_end", { kind: "custom" });
  assert.equal(stackSize(h.tui), 1);
  noHold(h);
  assert.deepEqual(h.errors, []);
});
