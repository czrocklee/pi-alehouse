import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { createJiti } from "jiti";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { PINNED_POPOVER_YIELD_EVENT } from "../../src/shared/overlay-protocol.mjs";
import { joinPopoverStack } from "../../src/shared/popover-stack.mjs";

// Source owners and real SDK layout/input; no generated output or provider/session IO.
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
const { createFooterPanels } = await jiti.import("../../src/extensions/lib/footer-panels.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const theme = {
  fg: (_tone, text) => text,
  bg: (_tone, text) => text,
  bold: (text) => text,
};
const snapshot = {
  usage: { tokens: 300, contextWindow: 1000, percent: 30 },
  categories: ["system", "messages", "tools"].map((id) => ({
    id,
    label: id,
    rawTokens: 100,
    tokens: 100,
    count: 1,
  })),
  items: ["system", "messages", "tools"].map((category) => ({
    id: `${category}:1`,
    category,
    label: `${category} item`,
    kind: category,
    rawTokens: 100,
    tokens: 100,
    count: 1,
    rawState: "estimate",
  })),
  allocation: "proportional",
  attribution: "complete",
  replay: "selected",
  rawTokens: 300,
  note: "Controlled context estimate",
};

function fixture(t, rows = 60) {
  const terminal = { columns: 100, rows, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = tui.requestImmediateRender = () => {};
  const editor = { render: () => ["Editor"], invalidate() {}, handleInput() {} };
  tui.setLayoutRoot({ render: () => Array(terminal.rows).fill("Transcript"), invalidate() {} });
  tui.setFocus(editor);
  const events = new EventEmitter(),
    prompts = new EventEmitter(),
    shortcuts = new Map();
  const on = (emitter) => (name, fn) => {
    emitter.on(name, fn);
    return () => emitter.off(name, fn);
  };
  const pi = {
    events: { on: on(events), emit: events.emit.bind(events) },
    on: on(prompts),
    registerShortcut: (key, spec) => shortcuts.set(key, spec),
  };
  let yieldCount = 0;
  events.on(PINNED_POPOVER_YIELD_EVENT, () => yieldCount++);
  const widgets = new Map();
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify() {},
      onTerminalInput: (listener) => tui.addInputListener(listener),
      custom() {
        assert.fail("fullscreen Routing must not acquire the SDK prompt queue");
      },
      setWidget(key, factory) {
        if (factory) widgets.set(key, factory(tui, theme));
        else widgets.delete(key);
      },
    },
  };
  const candidate = { activeName: "off", names: ["off"] };
  const router = {
    prepare: () => candidate,
    isCurrent: (value) => value === candidate,
    inspect: () => [{ name: "off", version: "off-v1", digest: "f".repeat(64) }],
  };
  const coordinator = new PanelCoordinator({
    pi,
    widget: { onOpen() {}, onRosterUpdate() {}, agents: () => [], tuiMode: () => undefined },
    ready: () => true,
    router: () => router,
    publish() {
      assert.fail("no preset selection in this fixture");
    },
    showError(error) {
      assert.fail(String(error));
    },
  });
  coordinator.attachHost(ctx, pi.events);
  const footer = createFooterPanels({
    pi,
    ctx,
    tui,
    theme,
    currentFooter: () => true,
    contextSnapshot: () => snapshot,
    compaction: () => undefined,
    spend: () => [
      { key: "controlled/model", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    ],
  });
  const pending = [];
  const routing = () => {
    const promise = shortcuts.get("alt+s").handler();
    if (promise) pending.push(promise);
    return tui.overlayStack.at(-1);
  };
  const context = () => {
    footer.inspectContext(true);
    return tui.overlayStack.at(-1);
  };
  const paint = () => {
    // Heights flow upward, so settle the native compositor's subsequent layout passes.
    for (let i = 0; i < 4; i++) tui.doRender();
    return tui.getScreenLines().map(plain).join("\n");
  };
  tui.beforeTerminalStart();
  t.after(async () => {
    coordinator.dispose();
    footer.dispose(() => {});
    await Promise.all(pending);
    tui.stopped = true;
    tui.cancelRenderTimer();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  return {
    tui,
    terminal,
    events,
    prompts,
    coordinator,
    footer,
    widgets,
    pending,
    routing,
    context,
    paint,
    get yieldCount() {
      return yieldCount;
    },
  };
}

function column(h, entries) {
  const screen = h.paint();
  for (const title of ["Context", "Delegation", "usage by model"])
    assert(screen.includes(title), `missing ${title}`);
  const bounds = entries.map((entry) => entry.bounds);
  assert(bounds.every(Boolean), "every open panel is painted");
  for (const box of bounds) {
    assert.equal(box.col, bounds[0].col, "left edges align");
    assert.equal(box.width, bounds[0].width, "shared column width");
    assert.equal(box.col + box.width, h.terminal.columns, "right edge is terminal edge");
  }
  assert.equal(bounds[0].row + bounds[0].height, h.terminal.rows - 1, "footer dock");
  for (let i = 1; i < bounds.length; i++)
    assert.equal(
      bounds[i].row + bounds[i].height,
      bounds[i - 1].row,
      "opening order, no overlap/gap",
    );
}

for (const first of ["Context", "Routing"]) {
  test(`${first} first: Context, Usage and Routing share one live column`, async (t) => {
    const h = fixture(t);
    h.footer.toggleBreakdown();
    const usage = h.tui.overlayStack.at(-1);
    const lower = first === "Context" ? h.context() : h.routing();
    h.paint();
    if (first === "Context") {
      h.tui.handleTerminalInput("\t");
      h.paint();
      assert.equal(lower.component.selected, "system");
      h.tui.handleTerminalInput("\r");
      h.paint();
    }
    const upper = first === "Context" ? h.routing() : h.context();
    const context = first === "Context" ? lower : upper;
    const routing = first === "Routing" ? lower : upper;
    if (first === "Routing") {
      h.paint();
      h.tui.handleTerminalInput("\t");
      h.paint();
      h.tui.handleTerminalInput("\r");
    }
    column(h, [usage, lower, upper]);
    assert(h.tui.overlayStack.includes(context), "Context stays mounted");
    assert.equal(context.component.selected, "system");
    assert.equal(context.component.detail?.id, "system:1");
    assert(h.tui.overlayStack.includes(usage), "Usage stays mounted");
    assert.equal(h.yieldCount, 0, "Routing is not a blocking pinned-popover yield");
    const selected = context.component.selected;
    const detail = context.component.detail;
    const before = usage.bounds.row;
    const contextFocused = h.tui.getFocusedComponent() === context.component;
    assert.equal(contextFocused, first === "Routing", "Context-after owns keyboard focus");
    h.routing(); // Explicit Alt+S close, also when Context has keyboard focus.
    assert(h.tui.overlayStack.includes(context), "Routing close never detaches Context");
    assert(h.tui.overlayStack.includes(usage), "Routing close never detaches Usage");
    if (contextFocused)
      assert(h.tui.getFocusedComponent() === context.component, "Context keeps keyboard focus");
    await Promise.all(h.pending);
    await tick();
    const screen = h.paint();
    assert(!h.tui.overlayStack.includes(routing));
    assert(!screen.includes("Delegation"));
    assert(h.tui.overlayStack.includes(context), "same Context overlay stays mounted");
    assert(h.tui.overlayStack.includes(usage), "same Usage overlay stays mounted");
    assert.equal(context.component.selected, selected, "Context navigation survives");
    assert.equal(context.component.detail, detail, "Context detail page survives");
    if (contextFocused)
      assert(
        h.tui.getFocusedComponent() === context.component,
        "settlement preserves Context focus",
      );
    assert.equal(h.yieldCount, 0, "Routing open/close never acquires pinned-popover holds");
    assert.equal(
      context.bounds.row + context.bounds.height,
      h.terminal.rows - 1 - usage.bounds.height,
      "stack collapses into Routing's space",
    );
    assert.equal(usage.bounds.row, before, "bottom pin never shifts vertically");
  });

  test(`${first} first: small terminal hides the later panel and reveals it when space returns`, async (t) => {
    const h = fixture(t, 12);
    const lower = first === "Context" ? h.context() : h.routing();
    h.paint();
    const upper = first === "Context" ? h.routing() : h.context();
    h.paint();
    assert.equal(
      upper.options.visible(),
      false,
      "later panel waits offscreen, not a border sliver",
    );
    assert.equal(upper.bounds, undefined);
    assert(h.tui.overlayStack.includes(upper), "offscreen is still logically mounted");
    h.terminal.rows = 60;
    h.paint();
    await Promise.resolve(); // Native reveal callback restores eligible keyboard focus.
    assert.equal(upper.options.visible(), true);
    assert(upper.bounds);
    assert(
      h.tui.getFocusedComponent() === upper.component,
      "revealed explicit request takes focus",
    );
    assert.equal(upper.bounds.row + upper.bounds.height, lower.bounds.row);
  });
}

test("SDK prompt notifications close raw Routing and hold Context/Usage until final end", async (t) => {
  const h = fixture(t);
  const context = h.context();
  h.footer.toggleBreakdown();
  const routing = h.routing();
  h.paint();
  h.prompts.emit("ui_prompt_start");
  assert(
    !h.tui.overlayStack.includes(routing),
    "Routing closes when the prompt notification is delivered",
  );
  assert.equal(h.tui.overlayStack.length, 0, "blocking prompt hides all pins");
  // Robustness simulation of nested notifications, not native prompt coalescing evidence.
  h.prompts.emit("ui_prompt_start");
  h.prompts.emit("ui_prompt_end");
  await tick();
  assert.equal(h.tui.overlayStack.length, 0, "nested prompt still owns UI");
  h.prompts.emit("ui_prompt_end");
  const screen = h.paint();
  assert(screen.includes("Context") && screen.includes("usage by model"));
  assert(h.tui.overlayStack.some((entry) => entry.component === context.component));
  assert(!screen.includes("Delegation"), "Routing never automatically reopens");
});

test("permission broadcast closes raw Routing synchronously; disposal releases stack and listeners", async (t) => {
  const h = fixture(t);
  h.context();
  h.footer.toggleBreakdown();
  const routing = h.routing();
  h.paint();
  h.events.emit("permissions:ui_prompt", { requestId: "controlled-ask" });
  assert(!h.tui.overlayStack.includes(routing), "no await before permission can open");
  await Promise.all(h.pending);
  await tick();
  h.paint();
  h.events.emit("permissions:decision", { requestId: "controlled-ask" });
  h.routing();
  h.paint();
  h.coordinator.dispose();
  h.footer.dispose(() => {});
  await Promise.all(h.pending);
  await tick();
  assert.equal(h.tui.overlayStack.length, 0);
  assert.equal(h.widgets.size, 0);
  assert.equal(h.prompts.eventNames().length, 0);
  assert.deepEqual(h.events.eventNames(), [PINNED_POPOVER_YIELD_EVENT]);
  const probe = joinPopoverStack(h.tui);
  assert.equal(probe.bottom, 1, "no leaked stack heights");
  assert.equal(probe.width, 1, "no leaked width preference");
  probe.leave();
  h.prompts.emit("ui_prompt_end");
  h.events.emit("permissions:decision", { requestId: "controlled-ask" });
  assert.equal(h.tui.overlayStack.length, 0, "retired callbacks cannot reopen panels");
});
