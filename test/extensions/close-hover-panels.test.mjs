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
const hasCloseAccent = (line) => line.includes("\x1b[36m✕") || line.includes("\x1b[36m\x1b[1m✕");
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
    move(x = width - 4, y = 0, extra = {}) {
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
    assert.match(plain(normal[0]), /✕/);
    const actions = h.actions;
    const before = h.renders;
    assert.equal(h.move(), undefined, "hover never captures or requests focus");
    assert.equal(h.renders, before + 1);
    const hovered = h.paint();
    assert.notEqual(hovered[0], normal[0]);
    assert.deepEqual(hovered.map(plain), normal.map(plain));
    assert.deepEqual(hovered.slice(1), normal.slice(1));
    for (const x of [75, 77, 78, 79]) {
      h.move();
      const entered = h.renders;
      assert.equal(h.move(x), undefined);
      assert.equal(h.renders, entered + 1, `adjacent tail column ${x} never holds the hover`);
    }
    assert.equal(h.move(), undefined);
    const back = h.renders;
    assert.equal(h.move(), undefined);
    assert.equal(h.renders, back, "same-cell motion is not another repaint");
    assert.equal(h.move(74), undefined);
    assert.equal(h.renders, back + 1);
    assert.deepEqual(h.paint(), normal);
    h.move(74);
    assert.equal(h.renders, back + 1);
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
    h.move(75);
    h.view.invalidate();
    assert.equal(h.tui.handleViewportInput, h.original);
    const normal = h.paint(79);
    h.move(75);
    assert.notEqual(h.paint()[0], normal[0]);
    h.paint(0);
    assert.equal(h.tui.handleViewportInput, h.original);
    h.paint(79);
    h.move(75);
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
    assert.match(plain(lines[0]), /✕/);
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
    assert.doesNotMatch(plain(lines[0]), /✕/);
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
    assert.match(plain(normal[0]), /✕/);
    h.move(5);
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
    h.tui.handleViewportInput({ type: "click", button: "left", x: 76, y: 0 });
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

for (const [label, action] of [
  ["human approval", "selected"],
  ["Save as global default", "saves"],
]) {
  test(`Approval: a cancelled close consumes a structural click on the painted ${action} target`, (t) => {
    const h = mount("Approval");
    t.after(() => h.dispose());
    const lines = h.paint().map(plain);
    const y = lines.findIndex((line) => line.includes(label));
    assert(y > 0, `missing painted ${label} target`);
    const closeX = visibleWidth(lines[0].slice(0, lines[0].indexOf("✕")));
    const mouse = (type, x, row) =>
      h.view.handleMouse({ type, button: "left", x, y: row, width: 80, height: lines.length });
    assert.equal(mouse("press", closeX, 0)?.handled, true);
    assert.equal(mouse("release", 5, y)?.handled, true);
    // Explicit structural click: a raw SDK release at a different coordinate
    // does not synthesize this event. The component must still swallow it.
    assert.equal(mouse("click", 5, y)?.handled, true);
    assert.deepEqual(h.actions, { closes: 0, selected: 0, saves: 0 });
    mouse("press", 5, y);
    mouse("click", 5, y);
    assert.deepEqual(
      h.actions,
      {
        closes: 0,
        selected: action === "selected" ? 1 : 0,
        saves: action === "saves" ? 1 : 0,
      },
      "a fresh structural click really activates this same painted body target",
    );
  });
}

// Real pinned SDK compositor and native input, with source-loaded extension
// owners. No terminal starts, provider calls, approval choices or session files.
function nativeFixture(t, kind, { below = false, scheduler = false } = {}) {
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  let requests = 0,
    frames = 0,
    closeCount = 0,
    chooseCount = 0,
    saveCount = 0,
    bodyActions = 0;
  let panels, view;
  const mouseDispatches = [];
  const showOverlay = tui.showOverlay.bind(tui);
  tui.showOverlay = (component, options) => {
    const handle = showOverlay(component, options);
    if (kind === "Usage") {
      const hide = handle.hide.bind(handle);
      handle.hide = () => {
        if (component === view) closeCount++;
        return hide();
      };
    }
    return handle;
  };
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
  if (kind === "Approval") {
    approvalExtension(pi);
    listeners.emit("session_start", {}, ctx);
    events.emit(FOOTER_INDICATOR_CLICK_EVENT, { key: APPROVAL_INDICATOR, handled: false });
    view = tui.overlayStack.at(-1).component;
  } else if (kind === "Stats") {
    view = new StatsView({
      tui,
      theme,
      snapshot: () => stats,
      close() {},
    });
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
  // Count actual owner callbacks, not dispose calls: Approval and Context owners
  // may dispose again during close; Usage has no view.dispose or close callback.
  if (kind !== "Usage") {
    const close = view.options.close;
    view.options.close = (...args) => {
      closeCount++;
      return close(...args);
    };
  }
  if (kind === "Approval") {
    const choose = view.options.choose;
    view.options.choose = (...args) => {
      chooseCount++;
      return choose(...args);
    };
    if (view.options.save) {
      const save = view.options.save;
      view.options.save = (...args) => {
        saveCount++;
        return save(...args);
      };
    }
  }
  const bodyMethod = { Approval: "activate", Context: "open", Stats: "select" }[kind];
  if (bodyMethod) {
    const action = view[bodyMethod].bind(view);
    view[bodyMethod] = (...args) => {
      bodyActions++;
      return action(...args);
    };
  }
  const handleMouse = view.handleMouse;
  view.handleMouse = function (event) {
    const result = handleMouse.call(this, event);
    mouseDispatches.push({ view: this, event: { ...event }, result });
    return result;
  };
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
    const index = text.lastIndexOf("✕");
    assert(index >= 0, `missing ${kind} close`);
    return { y, x: visibleWidth(text.slice(0, index)), raw: screen[y], ...painted };
  };
  const hover = () => {
    const at = header();
    tui.handleTerminalInput(`\x1b[<35;${at.x + 1};${at.y + 1}M`);
    assert.ok(hasCloseAccent(header().raw), `${kind} native hover`);
    return at;
  };
  return {
    tui,
    view,
    entry,
    spend,
    stats,
    mouseDispatches,
    get actions() {
      return { closes: closeCount, chooses: chooseCount, saves: saveCount, bodyActions };
    },
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
    drag(x, y) {
      tui.handleTerminalInput(`\x1b[<32;${x + 1};${y + 1}M`);
    },
    motion(x, y) {
      tui.handleTerminalInput(`\x1b[<35;${x + 1};${y + 1}M`);
    },
    get closes() {
      return closeCount;
    },
    closed() {
      return kind === "Stats"
        ? closeCount > 0
        : !tui.overlayStack.some((entry) => entry.component === view);
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

for (const kind of ["Approval", "Context", "Stats", "Usage"]) {
  test(`native ${kind}: tail press claims without closing; an adjacent tail release cancels`, (t) => {
    const h = nativeFixture(t, kind);
    const at = h.header();
    h.pointer("press", at.x, at.y);
    assert.equal(h.closed(), false, "a claimed press never closes by itself");
    h.pointer("release", at.x + 2, at.y);
    assert.equal(h.closed(), false, "a release outside the ✕ cell cancels, never closes");
    if (kind === "Stats") assert.equal(h.closes, 0);
    h.pointer("press", at.x, at.y);
    h.pointer("release", at.x, at.y);
    assert.equal(h.closed(), true, "a fresh same-cell gesture still closes exactly once");
    if (kind === "Stats") assert.equal(h.closes, 1);
  });

  test(`native ${kind}: same-cell motion keeps the claimed press closable`, (t) => {
    const h = nativeFixture(t, kind);
    const at = h.header();
    h.pointer("press", at.x, at.y);
    h.motion(at.x, at.y);
    h.pointer("release", at.x, at.y);
    assert.equal(h.closed(), true, "stationary within-cell motion preserves the gesture");
    if (kind === "Stats") assert.equal(h.closes, 1);
  });

  test(`native ${kind}: the captured view consumes the synthetic click after its closing release`, (t) => {
    const h = nativeFixture(t, kind);
    const at = h.header();
    h.pointer("press", at.x, at.y);
    assert.deepEqual(h.actions, { closes: 0, chooses: 0, saves: 0, bodyActions: 0 });
    h.pointer("release", at.x, at.y);
    assert.equal(h.closed(), true, "the same-cell release closes");
    assert.deepEqual(
      h.mouseDispatches.map(({ event }) => [event.type, event.button]),
      [
        ["press", "left"],
        ["release", "left"],
        ["click", "left"],
      ],
      "the SDK really delivers a synthetic click, even after the close callback",
    );
    for (const dispatch of h.mouseDispatches) {
      assert.equal(dispatch.view, h.view, "dispatch stays with the original captured view");
      assert.equal(dispatch.event.y, 0);
      assert.equal(dispatch.result?.handled, true, `${dispatch.event.type} is consumed`);
    }
    assert.equal(h.mouseDispatches[2].event.clickCount, 1);
    // This asserts consumption at the component boundary, not which internal
    // guard consumed it. Shared-control consumption has its own unit oracles.
    assert.deepEqual(h.actions, { closes: 1, chooses: 0, saves: 0, bodyActions: 0 });
  });

  test(`native ${kind}: raw drag outside the tail spends the claimed press; returning cannot revive it`, (t) => {
    const h = nativeFixture(t, kind);
    const at = h.header();
    h.pointer("press", at.x, at.y);
    h.drag(at.x - 6, at.y + 2);
    h.drag(at.x, at.y);
    h.pointer("release", at.x, at.y);
    assert.equal(h.closed(), false, "a gesture that left the tail cannot close on return");
    if (kind === "Stats") assert.equal(h.closes, 0);
  });

  test(`native ${kind}: ordinary body movement never closes`, (t) => {
    const h = nativeFixture(t, kind);
    const at = h.header();
    for (const [x, y] of [
      [3, at.y + 2],
      [10, at.y],
      [20, at.y + 1],
      [40, at.y],
    ])
      h.motion(x, y);
    assert.equal(h.closed(), false, "body motion is never a close gesture");
    if (kind === "Stats") assert.equal(h.closes, 0);
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
    assert.ok(top.includes("\x1b[90m✕"), "the active frame already has cleared chrome");
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
  assert.ok(
    moved.raw.includes("\x1b[90m✕"),
    "new location must be muted without a new pointer observation",
  );
  h.hover();
  assert.ok(hasCloseAccent(h.header().raw), "unchanged repaint retains hover");
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
    assert.ok(moved.raw.includes("\x1b[90m✕"));
    before = h.hover();
    h.removeBelow();
    moved = h.header();
    assert.equal(moved.width, before.width);
    assert.equal(moved.height, before.height);
    assert(moved.y > before.y, "removing lower member drops the same-height panel");
    assert.ok(moved.raw.includes("\x1b[90m✕"));
    h.hover();
    assert.ok(hasCloseAccent(h.header().raw), "stable geometry does not clear every paint");
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
  assert.ok(moved.raw.includes("\x1b[90m✕"));
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
  assert.ok(moved.raw.includes("\x1b[90m✕"));
  h.hover();
});
