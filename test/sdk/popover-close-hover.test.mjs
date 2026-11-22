import assert from "node:assert/strict";
import test from "node:test";
import {
  stripTerminalSequences,
  truncateToWidth,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createPopoverCloseControl } from "../../src/shared/popover-close-control.mjs";
import { createPopoverCloseHover } from "../../src/shared/popover-close-hover.mjs";
import {
  isPopoverCloseClick,
  popoverCloseHit,
  popoverRule,
  popoverTitleRow,
} from "../../src/shared/popover-frame.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

const theme = {
  fg(color, text) {
    const code = { borderAccent: 34, borderMuted: 90, muted: 90, accent: 36 }[color];
    return `\x1b[${code}m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const metrics = { clip: truncateToWidth, width: visibleWidth };

// Controlled private SDK seams only: no terminal is started, writes are dropped,
// and each paint is synchronous. Input still goes through the real native first
// listener, including its consuming mouse/focus/wheel paths.
function fixture(
  t,
  {
    overlap = false,
    bottomAnchored = false,
    otherFactory = createPopoverCloseHover,
    hostFor = (tui) => tui,
    closeControl = false,
  } = {},
) {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const terminal = { columns: 80, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  const host = hostFor(tui);
  let renders = 0;
  tui.requestRender = () => renders++;
  tui.requestImmediateRender = () => renders++;
  const original = tui.handleViewportInput;
  const rootEvents = [];
  const root = {
    render: () => Array.from({ length: 60 }, (_, i) => `Root transcript row ${i}`),
    invalidate() {},
    handleMouse(event) {
      rootEvents.push(event);
    },
  };
  tui.setLayoutRoot(root);
  const overlays = [];
  function overlay(title, row, col, factory = createPopoverCloseHover, anchor = "top-left") {
    const events = [];
    const clicks = [];
    const keys = [];
    let width = 24;
    let height = 3;
    const tracker = factory({
      host,
      closeHit: popoverCloseHit,
      requestRender: () => host.requestRender(),
    });
    const panel = {
      render(columns) {
        width = columns;
        tracker.paint(columns);
        tracker.paint(columns, true, height);
        return [
          popoverTitleRow(theme, columns, title, metrics, true, tracker.hovered),
          ...Array.from({ length: height - 2 }, () => `│${" ".repeat(columns - 2)}│`),
          popoverRule(theme, columns, "bottom"),
        ];
      },
      invalidate() {},
      handleInput(data) {
        keys.push(data);
      },
      handleMouse(event) {
        const result = tracker.mouse(event);
        events.push(event);
        if (factory === createPopoverCloseControl) {
          if (result?.close) clicks.push(event.type);
          return result;
        }
        if (isPopoverCloseClick(event, width)) {
          clicks.push(event.clickCount);
          return { handled: true };
        }
        // The panel claims presses exactly like the shared 1×1 close cell.
        if (
          event.type === "press" &&
          event.button === "left" &&
          event.y === 0 &&
          event.x === width - 4
        ) {
          return { handled: true };
        }
        return undefined;
      },
    };
    const handle = host.showOverlay(panel, {
      anchor,
      ...(anchor === "top-left" ? { row } : {}),
      col,
      width,
    });
    const result = {
      panel,
      handle,
      tracker,
      events,
      clicks,
      keys,
      row,
      col,
      x: col + width - 4,
      setHeight(value) {
        height = value;
      },
    };
    overlays.push(result);
    return result;
  }
  const a = overlay(
    "Agents",
    2,
    3,
    closeControl ? createPopoverCloseControl : createPopoverCloseHover,
    bottomAnchored ? "bottom-left" : "top-left",
  );
  const b = overlay("Usage", overlap ? 2 : 10, overlap ? 14 : 40, otherFactory);
  tui.beforeTerminalStart();
  t.after(() => {
    for (const item of overlays) item.tracker.dispose();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const lateInput = [];
  const removeListener = tui.addInputListener((data) => {
    lateInput.push(data);
  });
  t.after(removeListener);
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines();
  };
  const send = (button, x, y, release = false) =>
    tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const move = (item) => send(35, item.x, item.row);
  const gestureState = () => ({
    focus: tui.getFocusedComponent(),
    capture: tui.mouseCapture,
    pressTarget: tui.mousePressTarget,
    selectionAnchor: tui.selectionAnchor,
    selectionFocus: tui.selectionFocus,
    selectionPressActive: tui.selectionPressActive,
    lastComponentClick: tui.lastComponentClick,
  });
  paint();
  return {
    tui,
    original,
    a,
    b,
    rootEvents,
    lateInput,
    paint,
    send,
    move,
    gestureState,
    advance: (ms) => (now += ms),
    get renders() {
      return renders;
    },
  };
}

test("raw native motion changes only the close style and transfers between two overlays", (t) => {
  const h = fixture(t);
  const before = h.paint();
  const state = h.gestureState();
  const renderCount = h.renders;
  h.move(h.a);
  assert.equal(h.a.tracker.hovered, true);
  assert.equal(h.b.tracker.hovered, false);
  assert.equal(h.renders, renderCount + 1);
  const hovered = h.paint();
  assert.notEqual(hovered[h.a.row], before[h.a.row], "the real painted close style changes");
  assert.equal(stripTerminalSequences(hovered[h.a.row]), stripTerminalSequences(before[h.a.row]));
  assert(hovered[h.a.row].includes(theme.fg("accent", theme.bold("✕"))));
  assert(before[h.a.row].includes(theme.fg("muted", "✕")));
  assert.deepEqual(h.gestureState(), state, "hover does not focus, capture, press or select");
  assert.deepEqual(h.a.clicks, []);
  assert.deepEqual(h.b.clicks, []);
  assert.deepEqual(h.a.keys, []);
  assert.deepEqual(h.lateInput, [], "native consumes mouse before ordinary listeners can see it");
  assert.equal(h.a.events.at(-1).type, "move");
  assert.equal(h.a.events.at(-1).button, "none");
  assert.equal(h.a.events.at(-1).y, 0, "the SDK normalizes overlay-local coordinates");
  const stationary = h.renders;
  h.move(h.a);
  h.move(h.a);
  assert.equal(h.renders, stationary, "stationary repeated motion requests no extra render");
  assert.deepEqual(h.paint(), hovered);
  h.move(h.b);
  assert.equal(h.a.tracker.hovered, false);
  assert.equal(h.b.tracker.hovered, true);
  const transferred = h.paint();
  assert.equal(transferred[h.a.row], before[h.a.row]);
  assert(transferred[h.b.row].includes(theme.fg("accent", theme.bold("✕"))));
  assert.deepEqual(h.gestureState(), state);
  assert.deepEqual(h.lateInput, []);
});

test("outside/root moves and native-consumed wheel/focus paths retire hover", (t) => {
  const h = fixture(t);
  const idle = h.paint()[h.a.row];
  for (const [label, dispatch] of [
    ["same panel body", () => h.send(35, h.a.x, h.a.row + 1)],
    ["root motion", () => h.send(35, 20, 30)],
    ["outside viewport", () => h.send(35, 100, 50)],
    ["root wheel", () => h.send(64, 20, 30)],
    ["overlay wheel", () => h.send(65, h.b.x, h.b.row)],
    ["focus out", () => h.tui.handleTerminalInput("\x1b[O")],
    ["focus in", () => h.tui.handleTerminalInput("\x1b[I")],
    ["unrecognized native mouse", () => h.tui.handleTerminalInput("\x1b[Mabc")],
  ]) {
    h.move(h.a);
    h.paint();
    assert.equal(h.a.tracker.hovered, true);
    const eventCount = h.a.events.length;
    dispatch();
    assert.equal(h.a.tracker.hovered, false, label);
    assert.equal(h.paint()[h.a.row], idle, label);
    if (label !== "same panel body") {
      assert.equal(
        h.a.events.length,
        eventCount,
        `${label} never revalidates through the old panel`,
      );
    }
  }
  assert(h.rootEvents.some((event) => event.type === "move"));
  assert.deepEqual(h.lateInput, [], "every listed native path was consumed before late listeners");
  assert.deepEqual(h.a.clicks, []);
  assert.deepEqual(h.b.clicks, []);
});

test("an overlapping overlay retires the old hover even at the same screen coordinates", (t) => {
  const h = fixture(t, { overlap: true });
  h.a.handle.focus();
  h.paint();
  h.move(h.a);
  assert.equal(h.a.tracker.hovered, true);
  const aEvents = h.a.events.length;
  h.b.handle.focus();
  h.paint();
  const state = h.gestureState();
  h.move(h.a);
  assert.equal(h.a.events.length, aEvents, "the now-covered panel gets no synthetic leave");
  assert.equal(h.a.tracker.hovered, false);
  assert.equal(h.b.tracker.hovered, false, "the overlapping title is not its own close tail");
  assert.equal(h.b.events.at(-1).type, "move");
  assert.deepEqual(h.gestureState(), state, "hover does not undo the explicit overlay focus");
  h.move(h.b);
  assert.equal(h.b.tracker.hovered, true);
  assert.deepEqual(h.a.clicks, []);
  assert.deepEqual(h.b.clicks, []);
  assert.deepEqual(h.lateInput, []);
});

test("independent helper module copies share the real SDK's native observation seam", async (t) => {
  const { createPopoverCloseHover: otherFactory } =
    await import("../../src/shared/popover-close-hover.mjs?sdk-separate-hover-test-instance");
  const h = fixture(t, { otherFactory });
  h.move(h.a);
  const wrapper = h.tui.handleViewportInput;
  h.move(h.b);
  assert.equal(h.tui.handleViewportInput, wrapper);
  assert.equal(h.a.tracker.hovered, false);
  assert.equal(h.b.tracker.hovered, true);
  h.a.tracker.dispose();
  assert.equal(h.tui.handleViewportInput, wrapper);
  h.b.tracker.dispose();
  assert.equal(h.tui.handleViewportInput, h.original);
});

test("keyboard dispatch clears hover while preserving native keyboard delivery", (t) => {
  const h = fixture(t);
  h.move(h.a);
  h.tui.handleTerminalInput("q");
  assert.equal(h.a.tracker.hovered, false);
  assert.deepEqual(h.lateInput, ["q"]);
  assert.deepEqual(h.b.keys, ["q"], "the focused overlay still receives the original key");
  assert.deepEqual(h.a.clicks, []);
  assert.deepEqual(h.b.clicks, []);
});

test("ordinary close gestures retain SDK press/release, click count and moved-release semantics", (t) => {
  const h = fixture(t);
  h.move(h.a);
  h.send(0, h.a.x, h.a.row);
  assert.equal(h.a.tracker.hovered, false, "press retires hover without closing");
  assert.deepEqual(h.a.clicks, []);
  h.send(0, h.a.x, h.a.row, true);
  assert.deepEqual(h.a.clicks, [1]);
  for (const count of [2, 3]) {
    h.advance(50);
    h.send(0, h.a.x, h.a.row);
    h.send(0, h.a.x, h.a.row, true);
    assert.equal(h.a.clicks.at(-1), count);
  }
  h.advance(501);
  h.send(0, h.a.x, h.a.row);
  h.send(0, h.a.x + 1, h.a.row, true);
  assert.deepEqual(h.a.clicks, [1, 2, 3], "a moved release does not become a close click");
  h.send(2, h.a.x, h.a.row);
  h.send(2, h.a.x, h.a.row, true);
  assert.deepEqual(h.a.clicks, [1, 2, 3], "right clicks do not close");
  h.advance(501);
  h.send(0, h.a.x, h.a.row);
  h.send(0, h.a.x, h.a.row, true);
  assert.deepEqual(h.a.clicks, [1, 2, 3, 1]);
  assert.deepEqual(h.b.clicks, []);
});

test("height-only growth retires hover when the SDK compositor moves a bottom-anchored top", (t) => {
  const h = fixture(t, { bottomAnchored: true });
  const before = h.a.handle.getBounds();
  assert(before);
  assert.equal(before.height, 3);
  h.send(35, h.a.x, before.row);
  assert.equal(h.a.tracker.hovered, true);
  assert(h.paint()[before.row].includes(theme.fg("accent", theme.bold("✕"))));
  const state = h.gestureState();
  const eventCount = h.a.events.length;
  const renders = h.renders;
  h.a.setHeight(7);
  const screen = h.paint();
  const after = h.a.handle.getBounds();
  assert(after);
  assert.equal(after.width, before.width);
  assert.equal(after.height, 7);
  assert.equal(after.row, before.row - 4, "the native compositor moves the top edge on growth");
  assert.equal(h.a.tracker.hovered, false, "no pointer event revalidated the moved close control");
  assert.equal(h.a.events.length, eventCount, "growth does not invent a mouse event");
  assert.equal(h.renders, renders, "the current geometry paint needs no follow-up hover frame");
  assert(screen[after.row].includes(theme.fg("muted", "✕")));
  assert(!screen[after.row].includes(theme.fg("accent", theme.bold("✕"))));
  assert.equal(h.tui.handleViewportInput, h.original);
  assert.deepEqual(h.gestureState(), state);
  assert.deepEqual(h.a.clicks, []);
  assert.deepEqual(h.b.clicks, []);
  assert.deepEqual(h.lateInput, []);
  h.send(35, h.a.x, before.row);
  assert.equal(h.a.tracker.hovered, false, "the old close position is now only panel body");
  h.send(35, h.a.x, after.row);
  assert.equal(h.a.tracker.hovered, true, "fresh native motion can enter the moved close control");
  const stationary = h.renders;
  assert(h.paint()[after.row].includes(theme.fg("accent", theme.bold("✕"))));
  h.send(35, h.a.x, after.row);
  assert.equal(h.renders, stationary, "stable actual height preserves stationary hover");
});

test("the pinned interactive reference clears real close hover and interrupts native gestures", (t) => {
  const h = fixture(t, {
    hostFor: (tui) => createInteractiveTuiReference(() => tui),
    closeControl: true,
  });
  const { a } = h;
  const idle = h.paint()[a.row];
  h.move(a);
  assert.notEqual(h.tui.handleViewportInput, h.original);
  const hovered = h.paint()[a.row];
  assert(hovered.includes(theme.fg("accent", theme.bold("✕"))));
  assert.equal(stripTerminalSequences(hovered), stripTerminalSequences(idle));
  const renders = h.renders;
  h.move(a);
  assert.equal(h.renders, renders);

  const events = a.events.length;
  h.send(35, 20, 30);
  assert.equal(a.events.length, events, "native root motion never reaches the overlay");
  assert.equal(h.rootEvents.at(-1).type, "move");
  assert.equal(h.paint()[a.row], idle);
  h.move(a);
  h.tui.handleTerminalInput("\x1b[O");
  assert.equal(h.paint()[a.row], idle, "native terminal focus loss retires the highlight");

  a.handle.focus();
  h.send(0, a.x, a.row);
  h.tui.handleTerminalInput("q");
  h.send(0, a.x, a.row, true);
  assert.deepEqual(a.keys, ["q"]);
  assert.deepEqual(
    a.events.slice(-3).map((event) => event.type),
    ["press", "release", "click"],
  );
  assert.deepEqual(a.clicks, [], "neither the old release nor its native click closes");

  h.send(0, a.x, a.row);
  h.tui.handleTerminalInput("\x1b[O");
  h.send(0, a.x, a.row - 1, true);
  h.send(0, 0, 1);
  h.send(32, a.x, a.row);
  h.send(0, a.x, a.row, true);
  assert.deepEqual(a.clicks, [], "a root selection can end on the glyph without closing");
  assert.equal(h.tui.selectionPressActive, false, "close did not steal the selection release");
  assert.equal(h.tui.hasActiveSelection(), true);

  h.send(0, a.x, a.row);
  h.send(0, a.x, a.row, true);
  assert.deepEqual(a.clicks, ["release"], "a fresh gesture still closes exactly once");
});

test("old hover cleanup cannot redraw or detach the replacement behind a stable reference", (t) => {
  let current;
  const ref = createInteractiveTuiReference(() => current);
  const hostFor = (tui) => {
    current = tui;
    return ref;
  };
  const old = fixture(t, { hostFor, closeControl: true });
  old.move(old.a);
  old.move(old.b);
  assert.notEqual(old.tui.handleViewportInput, old.original);
  assert.equal(old.b.tracker.hovered, true);
  assert.equal(Object.hasOwn(ref, "handleViewportInput"), false, "no inert proxy property");

  const next = fixture(t, { hostFor });
  assert.equal(ref.valueOf(), next.tui);
  assert.equal(next.tui.handleViewportInput, next.original, "hover is not migrated");
  next.move(next.a);
  const nextWrapper = next.tui.handleViewportInput;
  const renders = [old.renders, next.renders];

  // Deliberately drive retired native input: its leave and any trailing close
  // must not notify the replacement through the still-live proxy callback.
  old.send(35, 20, 30);
  assert.equal(old.b.tracker.hovered, false);
  assert.equal(old.tui.handleViewportInput, old.original);
  assert.equal(Object.hasOwn(old.tui, "handleViewportInput"), false);
  assert.deepEqual([old.renders, next.renders], renders);
  old.send(0, old.a.x, old.a.row);
  old.send(0, old.a.x, old.a.row, true);
  assert.deepEqual(old.a.clicks, []);
  old.a.tracker.dispose();
  old.b.tracker.dispose();
  assert.equal(next.tui.handleViewportInput, nextWrapper);
  assert(next.paint()[next.a.row].includes(theme.fg("accent", theme.bold("✕"))));
  next.a.tracker.dispose();
  assert.equal(next.tui.handleViewportInput, next.original);
});

test("last tracker disposal restores the original pinned SDK method", (t) => {
  const h = fixture(t);
  assert.equal(
    h.tui.handleViewportInput,
    h.original,
    "paint alone leaves native dispatch untouched",
  );
  h.move(h.a);
  const wrapper = h.tui.handleViewportInput;
  assert.notEqual(wrapper, h.original);
  h.move(h.b);
  h.a.tracker.dispose();
  assert.equal(h.a.tracker.hovered, false);
  assert.equal(h.tui.handleViewportInput, wrapper);
  h.move(h.b);
  assert.equal(h.b.tracker.hovered, true);
  h.b.tracker.dispose();
  assert.equal(h.b.tracker.hovered, false);
  assert.equal(h.tui.handleViewportInput, h.original);
  h.send(35, 20, 30);
  assert.equal(h.tui.handleViewportInput, h.original, "ordinary native dispatch still works");
});
