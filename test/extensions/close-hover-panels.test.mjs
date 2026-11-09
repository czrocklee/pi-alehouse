import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { createJiti } from "jiti";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
  APPROVAL_INDICATOR,
  FOOTER_INDICATOR_CLICK_EVENT,
  PINNED_POPOVER_YIELD_EVENT,
} from "../../src/shared/overlay-protocol.mjs";
import { joinPopoverStack, stackedOverlayOptions } from "../../src/shared/popover-stack.mjs";

// Source-loaded views: no generated runtime, sessions, providers or approval IO.
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { ApprovalPopover } = await jiti.import("../../src/extensions/lib/approval-view.ts");
const { ContextView } = await jiti.import("../../src/extensions/lib/context-view.ts");
const { StatsView } = await jiti.import("../../src/extensions/lib/stats-view.ts");
const { createFooterPanels } = await jiti.import("../../src/extensions/lib/footer-panels.ts");
const { default: approvalExtension } = await jiti.import("../../src/extensions/approval-mode.ts");
const theme = {
  fg: (tone, text) => `\x1b[${tone === "accent" ? 36 : tone === "muted" ? 90 : 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  bg: (_tone, text) => `\x1b[44m${text}\x1b[0m`,
};
const choices = [
  { id: "manual", label: "manual", detail: "human approval" },
  { id: "yolo", label: "YOLO", detail: "session asks" },
];
const contextSnapshot = () => ({
  usage: { tokens: 100, contextWindow: 1000, percent: 10 },
  categories: [{ id: "system", label: "System", rawTokens: 100, tokens: 100, count: 1 }],
  items: [
    {
      id: "system:1",
      category: "system",
      label: "Instructions",
      kind: "system",
      rawTokens: 100,
      tokens: 100,
      count: 1,
      rawState: "estimate",
    },
  ],
  allocation: "proportional",
  attribution: "complete",
  replay: "selected",
  rawTokens: 100,
  note: "Estimates only",
});

function mount(kind, { supported = true, owner = false } = {}) {
  let renders = 0,
    closes = 0,
    selected = 0,
    saves = 0;
  let view,
    panels,
    width = 80,
    height = 0,
    available = 30,
    unavailable = false;
  const data = contextSnapshot();
  const events = new EventEmitter();
  const listeners = new EventEmitter();
  const overlays = [];
  const tui = {
    mode: "fullscreen",
    terminal: { rows: 40, columns: 100 },
    requestRender() {
      renders++;
    },
    // Match the optional native adapter seam; normalized events are routed to
    // the local component by the host, not parsed or swallowed by the tracker.
    ...(supported
      ? {
          handleViewportInput(event) {
            return view.handleMouse({ width, height, ...event });
          },
        }
      : {}),
    showOverlay(component, options) {
      view = component;
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return {
        hide() {
          entry.hidden = true;
        },
        isFocused: () => false,
        isHidden: () => entry.hidden,
        focus() {},
      };
    },
  };
  const original = tui.handleViewportInput;
  const options = {
    tui,
    theme,
    close: () => {
      closes++;
    },
    requestRender: () => tui.requestRender(),
  };
  if (kind === "Approval")
    view = new ApprovalPopover({
      ...options,
      choices: () => choices,
      current: () => "manual",
      warning: (id) => (id === "yolo" ? ["Confirm wider approval"] : undefined),
      choose: () => {
        selected++;
      },
      save: () => {
        saves++;
      },
      canSaveWorkspace: () => true,
    });
  else if (kind === "Context" && !owner)
    view = new ContextView({
      ...options,
      snapshot: () => {
        if (unavailable) throw Error("unavailable");
        return data;
      },
      availableRows: () => available,
    });
  else if (kind === "Stats")
    view = new StatsView({
      ...options,
      snapshot: () => ({ health: "idle", models: [], tools: [], recentErrors: [] }),
    });
  else {
    const on = (emitter) => (name, fn) => {
      emitter.on(name, fn);
      return () => emitter.off(name, fn);
    };
    panels = createFooterPanels({
      pi: { events: { on: on(events) }, on: on(listeners) },
      ctx: { hasUI: true, ui: {} },
      tui,
      theme,
      spend: () => [],
      contextSnapshot: () => data,
      compaction: () => undefined,
      currentFooter: () => true,
    });
    if (kind === "Context") panels.toggleContext();
    else panels.toggleBreakdown();
  }
  return {
    view,
    tui,
    original,
    events,
    overlays,
    get renders() {
      return renders;
    },
    get actions() {
      return { closes, selected, saves };
    },
    get panels() {
      return panels;
    },
    set available(value) {
      available = value;
    },
    set unavailable(value) {
      unavailable = value;
    },
    paint(columns = width) {
      width = columns;
      const lines = view.render(width);
      height = lines.length;
      return lines;
    },
    move(x = width - 5, y = 0, extra = {}) {
      const event = { type: "move", button: "none", x, y, ...extra };
      return supported
        ? tui.handleViewportInput(event)
        : view.handleMouse({ width, height, ...event });
    },
    dispose() {
      if (panels) panels.dispose(() => {});
      else view.dispose();
    },
  };
}

for (const kind of ["Approval", "Context", "Stats", "Usage"]) {
  test(`${kind}: close hover changes only chrome, coalesces moves and clears within-panel leave`, (t) => {
    const h = mount(kind);
    t.after(() => h.dispose());
    const normal = h.paint();
    assert.match(plain(normal[0]), /×/);
    const actions = h.actions;
    const before = h.renders;
    assert.equal(h.move(), undefined, "hover never captures or requests focus");
    assert.equal(h.renders, before + 1);
    const hovered = h.paint();
    assert.notEqual(hovered[0], normal[0]);
    assert.deepEqual(hovered.map(plain), normal.map(plain));
    assert.deepEqual(hovered.slice(1), normal.slice(1));
    for (const x of [75, 76, 77, 78, 79]) assert.equal(h.move(x), undefined);
    assert.equal(h.renders, before + 1, "same tail is not another repaint");
    assert.equal(h.move(74), undefined);
    assert.equal(h.renders, before + 2);
    assert.deepEqual(h.paint(), normal);
    h.move(74);
    assert.equal(h.renders, before + 2);
    assert.deepEqual(h.actions, actions);
    assert.equal(h.tui.handleViewportInput, h.original, "leave retires the optional observer");
  });

  test(`${kind}: resize, invalidation, empty paint and teardown retire hover`, (t) => {
    const h = mount(kind);
    t.after(() => h.dispose());
    h.paint();
    h.move();
    const resized = h.paint(79);
    assert.deepEqual(h.paint(79), resized);
    h.move(74);
    h.view.invalidate();
    assert.equal(h.tui.handleViewportInput, h.original);
    const normal = h.paint(79);
    h.move(74);
    assert.notEqual(h.paint()[0], normal[0]);
    h.paint(0);
    assert.equal(h.tui.handleViewportInput, h.original);
    h.paint(79);
    h.move(74);
    h.dispose();
    assert.equal(h.tui.handleViewportInput, h.original);
    assert.deepEqual(h.actions, { closes: 0, selected: 0, saves: 0 });
  });

  test(`${kind}: unsupported host keeps original bytes and actions`, (t) => {
    const h = mount(kind, { supported: false });
    t.after(() => h.dispose());
    const normal = h.paint();
    const before = h.renders;
    h.move();
    assert.deepEqual(h.paint(), normal);
    assert.equal(h.renders, before);
    assert.deepEqual(h.actions, { closes: 0, selected: 0, saves: 0 });
  });
}

test("Approval: tiny paint has no close target; clipped titles keep visible close and explicit choices", (t) => {
  const h = mount("Approval");
  t.after(() => h.dispose());
  h.paint();
  h.move();
  assert.deepEqual(h.paint(11), []);
  const before = h.renders;
  h.move(6);
  assert.equal(h.renders, before);
  h.tui.handleViewportInput({ type: "click", button: "left", x: 6, y: 0 });
  assert.equal(h.actions.closes, 0);
  for (const width of [12, 16, 17, 80]) {
    const lines = h.paint(width);
    assert.match(plain(lines[0]), /×/);
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
  h.view.handleInput("\x1b[B");
  h.view.handleInput("\r");
  assert.equal(h.view.isArmed(), true);
  const armed = h.paint();
  h.move();
  h.paint();
  h.move(74);
  h.view.invalidate();
  assert.equal(h.view.isArmed(), true);
  assert.deepEqual(h.paint(), armed);
  assert.deepEqual(h.actions, { closes: 0, selected: 0, saves: 0 });
  h.view.handleInput("g");
  assert.deepEqual(h.actions, { closes: 0, selected: 0, saves: 1 });
  h.view.handleInput("\r");
  assert.equal(h.actions.selected, 0, "saving never confirms the armed choice");
  h.view.handleInput("\r");
  assert.equal(h.actions.selected, 1, "only explicit confirmation chooses");
});

test("Context: readonly width/height/unavailable fallbacks have no hover geometry", (t) => {
  const h = mount("Context");
  t.after(() => h.dispose());
  for (const fallback of ["width", "height", "unavailable"]) {
    h.available = 30;
    h.unavailable = false;
    h.paint(80);
    h.move();
    if (fallback === "height") h.available = 3;
    if (fallback === "unavailable") h.unavailable = true;
    const lines = h.paint(fallback === "width" ? 27 : 80);
    assert.doesNotMatch(plain(lines[0]), /×/);
    assert.equal(h.tui.handleViewportInput, h.original);
    const before = h.renders;
    h.move();
    assert.equal(h.renders, before);
    for (const key of ["\x1b[B", "\t", "\r", "n"]) h.view.handleInput(key);
    assert.equal(h.view.detail, undefined);
    assert.equal(h.view.selected, undefined);
    assert.equal(h.view.showingNote, false, "readonly fallback cannot activate unseen content");
    assert.deepEqual(h.paint(), lines);
  }
});

test("Stats and Usage: narrow rules are inert, while compact/untitled visible closes hover", (t) => {
  for (const kind of ["Stats", "Usage"]) {
    const h = mount(kind);
    t.after(() => h.dispose());
    h.paint(8);
    const before = h.renders;
    h.move(3);
    assert.equal(h.renders, before);
    if (kind === "Stats") h.tui.terminal.rows = 3;
    const normal = h.paint(9);
    assert.match(plain(normal[0]), /×/);
    h.move(4);
    assert.notEqual(h.paint()[0], normal[0]);
    if (kind === "Stats") {
      h.tui.terminal.rows = 0;
      assert.deepEqual(h.paint(), []);
      assert.equal(h.tui.handleViewportInput, h.original);
    }
  }
});

for (const kind of ["Context", "Usage"]) {
  test(`${kind}: yielded pinned view detaches and remounts without stale hover`, (t) => {
    const h = mount(kind, { owner: true });
    t.after(() => h.dispose());
    const normal = h.paint();
    h.move();
    const token = {};
    h.events.emit(PINNED_POPOVER_YIELD_EVENT, { token, active: true });
    assert.equal(h.tui.handleViewportInput, h.original);
    h.events.emit(PINNED_POPOVER_YIELD_EVENT, { token, active: false });
    assert.equal(h.overlays.length, 2);
    assert.equal(h.overlays[0].component, h.overlays[1].component);
    assert.deepEqual(h.paint(), normal);
    h.move();
    assert.notEqual(h.paint()[0], normal[0]);
  });

  test(`${kind}: stack offscreen geometry retires the leave observer`, (t) => {
    const h = mount(kind, { owner: true });
    t.after(() => h.dispose());
    const normal = h.paint();
    h.move();
    h.tui.terminal.rows = 1;
    assert.equal(h.overlays[0].options.visible(), false);
    assert.equal(h.tui.handleViewportInput, h.original);
    h.tui.terminal.rows = 40;
    assert.equal(h.overlays[0].options.visible(), true);
    assert.deepEqual(h.paint(), normal);
  });
}

for (const kind of ["Approval", "Context", "Stats", "Usage"]) {
  test(`${kind}: only an explicit close click closes and disposes the observer`, (t) => {
    const h = mount(kind);
    t.after(() => h.dispose());
    h.paint();
    h.move();
    h.tui.handleViewportInput({ type: "click", button: "left", x: 75, y: 0 });
    assert.equal(h.tui.handleViewportInput, h.original);
    assert.deepEqual(h.actions, { closes: kind === "Usage" ? 0 : 1, selected: 0, saves: 0 });
    if (kind === "Usage") {
      assert.equal(h.overlays[0].hidden, true);
      h.panels.toggleBreakdown();
      const normal = h.paint();
      h.move();
      assert.notEqual(h.paint()[0], normal[0], "a new pin gets a fresh tracker");
    }
  });
}

// Real pinned SDK compositor and native input, with source-loaded extension
// owners. No terminal starts, provider calls, approval choices or session files.
function nativeFixture(t, kind, { below = false, scheduler = false } = {}) {
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  let requests = 0,
    frames = 0;
  const requestRender = tui.requestRender.bind(tui);
  const immediateRender = tui.requestImmediateRender.bind(tui);
  const doRender = tui.doRender.bind(tui);
  tui.requestRender = (...args) => {
    requests++;
    if (scheduler) requestRender(...args);
  };
  tui.requestImmediateRender = (...args) => {
    if (scheduler) immediateRender(...args);
  };
  tui.doRender = () => {
    frames++;
    return doRender();
  };
  tui.setLayoutRoot({
    render: () => Array.from({ length: 50 }, () => "Transcript"),
    invalidate() {},
  });
  const events = new EventEmitter(),
    listeners = new EventEmitter();
  const on = (emitter) => (name, fn) => {
    emitter.on(name, fn);
    return () => emitter.off(name, fn);
  };
  const pi = {
    events: { on: on(events), emit: events.emit.bind(events) },
    on: on(listeners),
    registerCommand() {},
    appendEntry() {
      assert.fail("no approval choice may be recorded");
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "close-hover-native", getBranch: () => [] },
    ui: {
      theme,
      setStatus() {},
      setWidget(_key, factory) {
        factory?.(tui, theme);
      },
      notify() {},
    },
  };
  let lowerHeight = 3;
  const lower = below ? joinPopoverStack(tui) : undefined;
  lower?.measure(lowerHeight);
  const lowerHandle =
    lower &&
    tui.showOverlay(
      {
        render() {
          lower.measure(lowerHeight);
          return Array.from({ length: lowerHeight }, () => "Lower pinned panel");
        },
        invalidate() {},
      },
      stackedOverlayOptions(lower, { width: 1, nonCapturing: true }),
    );
  let data = contextSnapshot();
  data.items = ["system", "messages", "tools"].map((category) => ({
    ...data.items[0],
    id: `${category}:1`,
    category,
    label: `${category} item`,
  }));
  data.categories = data.items.map((item) => ({ ...item, id: item.category }));
  const spend = [
    { key: "provider/model-a", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
  ];
  const stats = { health: "idle", models: [], tools: [], recentErrors: [] };
  let panels, view;
  if (kind === "Approval") {
    approvalExtension(pi);
    listeners.emit("session_start", {}, ctx);
    events.emit(FOOTER_INDICATOR_CLICK_EVENT, { key: APPROVAL_INDICATOR, handled: false });
    view = tui.overlayStack.at(-1).component;
  } else if (kind === "Stats") {
    view = new StatsView({ tui, theme, snapshot: () => stats, close() {} });
    tui.showOverlay(view, { anchor: "center", width: 80, maxHeight: "75%" });
  } else {
    panels = createFooterPanels({
      pi,
      ctx,
      tui,
      theme,
      spend: () => spend,
      contextSnapshot: () => data,
      compaction: () => undefined,
      currentFooter: () => true,
    });
    if (kind === "Usage") panels.toggleBreakdown();
    else panels.inspectContext(true);
    view = tui.overlayStack.at(-1).component;
  }
  const entry = tui.overlayStack.at(-1);
  let painted = { width: 0, height: 0 };
  const render = view.render.bind(view);
  view.render = (width) => {
    const lines = render(width);
    painted = { width, height: lines.length };
    return lines;
  };
  tui.beforeTerminalStart();
  t.after(() => {
    tui.stopped = true;
    tui.cancelRenderTimer();
    if (kind === "Approval") listeners.emit("session_shutdown", {}, ctx);
    else if (panels) panels.dispose(() => {});
    else view.dispose();
    lowerHandle?.hide();
    lower?.leave();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines();
  };
  const header = () => {
    const screen = paint();
    const y = screen.findIndex((line) =>
      plain(line).includes(kind === "Usage" ? "usage by model" : kind),
    );
    assert(y >= 0, `missing ${kind} header`);
    const text = plain(screen[y]);
    const index = text.lastIndexOf("×");
    assert(index >= 0, `missing ${kind} close`);
    return { y, x: visibleWidth(text.slice(0, index)), raw: screen[y], ...painted };
  };
  const hover = () => {
    const at = header();
    tui.handleTerminalInput(`\x1b[<35;${at.x + 1};${at.y + 1}M`);
    assert.match(header().raw, /\x1b\[36m(?:\x1b\[1m)?×/, `${kind} native hover`);
    return at;
  };
  return {
    tui,
    view,
    entry,
    spend,
    stats,
    get requests() {
      return requests;
    },
    get frames() {
      return frames;
    },
    get snapshot() {
      return data;
    },
    set snapshot(value) {
      data = value;
    },
    input(key) {
      tui.handleTerminalInput(key);
    },
    pointer(type, x, y) {
      tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}${type === "release" ? "m" : "M"}`);
    },
    header,
    hover,
    paint,
    events,
    growBelow() {
      lowerHeight = 6;
      lower.measure(lowerHeight);
    },
    removeBelow() {
      lowerHandle.hide();
      lower.leave();
    },
  };
}

const KEYS = { Up: "\x1b[A", Down: "\x1b[B", Tab: "\t", Enter: "\r" };

for (const change of ["growBelow", "removeBelow"]) {
  for (const key of Object.keys(KEYS)) {
    test(`native Context: ${change} preserves first ${key} without hover or intermediate paint`, (t) => {
      const h = nativeFixture(t, "Context", { below: true });
      h.paint();
      if (key === "Up") {
        h.input(KEYS.Down);
        h.paint();
      }
      const cursor = h.view.cursor;
      const item = h.view.rows[cursor];
      h[change]();
      h.input(KEYS[key]);
      if (key === "Up") assert.equal(h.view.cursor, cursor - 1);
      if (key === "Down") assert.equal(h.view.cursor, cursor + 1);
      if (key === "Tab") assert.equal(h.view.selected, "system");
      if (key === "Enter") assert.equal(h.view.detail?.id, item.id);
      const screen = h.paint().map(plain).join("\n");
      if (key === "Enter") assert.match(screen, new RegExp(`Source ${item.label}`));
      else assert.equal(h.view.navigationReady, true, "active frame commits the keyboard layout");
    });
  }
}

for (const change of ["growBelow", "removeBelow"]) {
  for (const key of ["Up", "Down", "Enter"]) {
    test(`native Approval: ${change} preserves first ${key} and its explicit choice state`, (t) => {
      const h = nativeFixture(t, "Approval", { below: true });
      h.paint();
      if (key !== "Down") {
        h.input(KEYS.Down);
        h.paint();
      }
      h[change]();
      h.input(KEYS[key]);
      assert.equal(h.view.selected, key === "Up" ? 0 : 1);
      assert.equal(h.view.isArmed(), key === "Enter");
      h.paint();
      assert.equal(h.view.isArmed(), key === "Enter", "pointer cleanup does not disarm a choice");
    });
  }
}

for (const kind of ["Approval", "Context", "Usage"]) {
  for (const change of ["growBelow", "removeBelow", "hide"]) {
    for (const target of kind === "Usage" ? ["close"] : ["row", "close"]) {
      test(`native ${kind}: ${change} rejects stale ${target} click before repaint`, (t) => {
        const h = nativeFixture(t, kind, { below: true });
        const at = h.header();
        const x = target === "close" ? at.x : h.entry.bounds.col + 5;
        const y = at.y + (target === "close" ? 0 : kind === "Approval" ? 2 : 3);
        if (change === "hide") {
          h.tui.terminal.rows = 1;
          assert.equal(h.entry.options.visible(), false);
        } else h[change]();
        h.pointer("press", x, y);
        h.pointer("release", x, y);
        assert(h.tui.overlayStack.includes(h.entry), "stale close never removes the panel");
        if (kind === "Approval") assert.equal(h.view.isArmed(), false);
        if (kind === "Context") assert.equal(h.view.detail, undefined);
      });
    }
  }

  test(`native ${kind}: pending close press cannot activate after hide and repaint`, (t) => {
    const h = nativeFixture(t, kind, { below: true });
    const at = h.header();
    h.pointer("press", at.x, at.y);
    // Exercise offscreen hiding for Approval and owner yield/remount for pinned views.
    if (kind === "Approval") {
      h.tui.terminal.rows = 1;
      assert.equal(h.entry.options.visible(), false);
      h.tui.terminal.rows = 40;
    } else {
      const token = {};
      h.events.emit(PINNED_POPOVER_YIELD_EVENT, { token, active: true });
      h.events.emit(PINNED_POPOVER_YIELD_EVENT, { token, active: false });
    }
    h.paint();
    h.pointer("release", at.x, at.y);
    assert(h.tui.overlayStack.some((entry) => entry.component === h.view));
    const fresh = h.header();
    h.pointer("press", fresh.x, fresh.y);
    h.pointer("release", fresh.x, fresh.y);
    assert(
      !h.tui.overlayStack.some((entry) => entry.component === h.view),
      "fresh click still closes",
    );
  });
}

test("native Context: pointer cleanup preserves true snapshot and data-epoch activation guards", (t) => {
  const h = nativeFixture(t, "Context", { below: true });
  h.paint();
  h.snapshot = { ...h.snapshot };
  h.growBelow();
  for (const key of [KEYS.Down, KEYS.Tab, KEYS.Enter]) h.input(key);
  assert.equal(h.view.cursor, 0);
  assert.equal(h.view.selected, undefined);
  assert.equal(h.view.detail, undefined);
  h.paint();
  h.input(KEYS.Down);
  h.input(KEYS.Enter);
  assert.equal(h.view.cursor, 1);
  assert.equal(h.view.detail, undefined, "unpainted cursor cannot activate a row");
  h.paint();
  h.input(KEYS.Enter);
  assert.equal(h.view.detail?.id, h.view.rows[1].id);
});

for (const hovered of [false, true]) {
  test(`native Context: stack movement clears chrome in the active frame, no extra frame (hover=${hovered})`, async (t) => {
    const h = nativeFixture(t, "Context", { below: true, scheduler: true });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    if (hovered) {
      h.hover();
      await settle();
    }
    const frames = h.frames;
    h.growBelow();
    await settle();
    assert.equal(h.frames - frames, 1, "one stack layout request, no repaint from pointer cleanup");
    const top = h.tui.getScreenLines().find((line) => plain(line).includes(" Context "));
    assert.match(top, /\x1b\[90m×/, "the active frame already has cleared chrome");
  });
}

test("native Usage: same-width spend growth clears hover before emitting its translated top", (t) => {
  const h = nativeFixture(t, "Usage");
  const before = h.hover();
  h.spend.push({ ...h.spend[0], key: "provider/model-b" });
  const moved = h.header();
  assert.equal(moved.width, before.width);
  assert(moved.height > before.height);
  assert(moved.y < before.y, "adding spend rows raises the bottom-anchored top");
  assert.match(
    moved.raw,
    /\x1b\[90m×/,
    "new location must be muted without a new pointer observation",
  );
  h.hover();
  assert.match(h.header().raw, /\x1b\[36m(?:\x1b\[1m)?×/, "unchanged repaint retains hover");
});

for (const kind of ["Approval", "Context", "Usage"]) {
  test(`native ${kind}: lower pinned member growth/removal clears same-size translated hover`, (t) => {
    const h = nativeFixture(t, kind, { below: true });
    let before = h.hover();
    h.growBelow();
    let moved = h.header();
    assert.equal(moved.width, before.width);
    assert.equal(moved.height, before.height);
    assert(moved.y < before.y, "lower member growth raises the same-height panel");
    assert.match(moved.raw, /\x1b\[90m×/);
    before = h.hover();
    h.removeBelow();
    moved = h.header();
    assert.equal(moved.width, before.width);
    assert.equal(moved.height, before.height);
    assert(moved.y > before.y, "removing lower member drops the same-height panel");
    assert.match(moved.raw, /\x1b\[90m×/);
    h.hover();
    assert.match(
      h.header().raw,
      /\x1b\[36m(?:\x1b\[1m)?×/,
      "stable geometry does not clear every paint",
    );
  });
}

test("native Stats: centered content-height growth clears hover at the new top", (t) => {
  const h = nativeFixture(t, "Stats");
  const before = h.hover();
  h.stats.models = Array.from({ length: 40 }, (_, index) => ({
    model: `model-${index}`,
    requests: 1,
  }));
  const moved = h.header();
  assert.equal(moved.width, before.width);
  assert(moved.height > before.height);
  assert(moved.y < before.y, "more model rows enlarge and translate the centered Stats panel");
  assert.match(moved.raw, /\x1b\[90m×/);
  h.hover();
});

test("native Approval: newly observed judge choices clear hover when the frame grows", (t) => {
  const h = nativeFixture(t, "Approval");
  const before = h.hover();
  h.events.emit("approval:judge-state", {
    judge: "jev",
    mode: "shadow",
    includeSubagents: false,
    sessionId: "close-hover-native",
    shown: false,
  });
  const moved = h.header();
  assert.equal(moved.width, before.width);
  assert(moved.height > before.height);
  assert(moved.y < before.y, "new judge choices increase bottom-anchored Approval height");
  assert.match(moved.raw, /\x1b\[90m×/);
  h.hover();
});
