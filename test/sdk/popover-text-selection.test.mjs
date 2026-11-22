import assert from "node:assert/strict";
import test from "node:test";
import {
  stripTerminalSequences,
  truncateToWidth,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createPopoverTextSelection } from "../../src/shared/popover-text-selection.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

const BODY = [
  "alpha bravo charlie",
  "delta echo foxtrot",
  "golf hotel india",
  "juliet kilo lima",
  "mike november oscar",
  "papa quebec romeo",
];

// Real pinned TuiAltScreen, fake terminal and synthetic panels. Input is raw
// SGR; copy goes to an injected collector, never the OS clipboard.
function fixture(t, { copyOnSelect = true, columns = 80, rows = 30, rootLines } = {}) {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const terminal = { columns, rows, write() {}, hideCursor() {} };
  const copied = [];
  const opened = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copyOnSelect,
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
    openUrl: (url) => opened.push(url),
  });
  let renders = 0;
  tui.requestRender = () => renders++;
  tui.requestImmediateRender = () => renders++;
  const native = {
    handleSelectionMouseEvent: tui.handleSelectionMouseEvent,
    getSelectionPoint: tui.getSelectionPoint,
    getWordSelection: tui.getWordSelection,
    getLineSelection: tui.getLineSelection,
    getSelectionColumns: tui.getSelectionColumns,
    getSelectionBounds: tui.getSelectionBounds,
  };
  const resets = [];
  const nativeReset = tui.resetTextSelection.bind(tui);
  tui.resetTextSelection = () => {
    resets.push(true);
    nativeReset();
  };
  const root = {
    render: () =>
      Array.from({ length: 60 }, (_, index) =>
        rootLines === undefined ? `Root row ${index}` : rootLines,
      ),
    invalidate() {},
    handleMouse() {},
  };
  tui.setLayoutRoot(root);
  const overlays = [];
  function overlay({ name, row, col, width, height, body = BODY, handled, host = tui }) {
    const events = [];
    let bodyRect = { x: 1, y: 1, width: width - 2, height: height - 2 };
    let viewportKey = `${name}:0`;
    let panelHeight = height;
    let panelBody = body;
    let tracker;
    const panel = {
      render(panelWidth) {
        tracker.paint(bodyRect, viewportKey);
        const inner = Math.max(0, panelWidth - 2);
        const lines = ["+" + "-".repeat(inner) + "+"];
        for (let index = 0; index < panelHeight - 2; index++) {
          const text = panelBody[index] ?? "";
          const fitted = truncateToWidth(text, inner, "");
          lines.push("|" + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + "|");
        }
        lines.push("+" + "-".repeat(inner) + "+");
        return lines;
      },
      invalidate() {},
      handleMouse(event) {
        events.push(event);
        if (handled?.(event)) return { handled: true };
        return undefined;
      },
      handleInput() {},
    };
    tracker = createPopoverTextSelection({ host, component: panel });
    const options = { anchor: "top-left", row, col, width };
    const handle = host.showOverlay(panel, options);
    const result = {
      name,
      panel,
      handle,
      tracker,
      events,
      options,
      row,
      col,
      width,
      height,
      get bodyRect() {
        return bodyRect;
      },
      setBodyRect(rect) {
        bodyRect = rect;
      },
      setViewportKey(key) {
        viewportKey = key;
      },
      setPanelHeight(value) {
        panelHeight = value;
      },
      setBody(value) {
        panelBody = value;
      },
    };
    overlays.push(result);
    // Publish the native layout and the panel's first painted rectangle before
    // the test sends input, matching a real frame between showOverlay and use.
    tui.doRender();
    return result;
  }
  tui.beforeTerminalStart();
  t.after(() => {
    for (const item of overlays) item.tracker.dispose();
    for (const item of overlays) item.handle.hide();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines();
  };
  const send = (button, x, y, release = false) =>
    tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const press = (x, y, button = 0) => send(button, x, y, false);
  const drag = (x, y, button = 0) => send(button | 32, x, y, false);
  const release = (x, y, button = 0) => send(button, x, y, true);
  const move = (x, y) => send(35, x, y, false);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    tui,
    terminal,
    native,
    copied,
    opened,
    resets,
    overlays,
    overlay,
    paint,
    send,
    press,
    drag,
    release,
    move,
    tick,
    get renders() {
      return renders;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Text actually covered by the native reverse-video selection style. */
function highlighted(line) {
  let reverse = false;
  let text = "";
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[7m", index)) {
      reverse = true;
      index += 4;
      continue;
    }
    if (line.startsWith("\x1b[27m", index)) {
      reverse = false;
      index += 5;
      continue;
    }
    if (line[index] === "\x1b") {
      if (line.startsWith("\x1b[", index)) {
        let end = index + 2;
        while (end < line.length) {
          const code = line.charCodeAt(end);
          end += 1;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        index = end;
        continue;
      }
      if (line.startsWith("\x1b]", index)) {
        const bel = line.indexOf("\x07", index + 2);
        const st = line.indexOf("\x1b\\", index + 2);
        index = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : line.length;
        continue;
      }
      index += 1;
      continue;
    }
    if (reverse) text += line[index];
    index += 1;
  }
  return text;
}

function bodyPoint(panel, x, y) {
  return { x: panel.col + panel.bodyRect.x + x, y: panel.row + panel.bodyRect.y + y };
}

test("the pinned interactive reference bounds native highlight and copy to the popover body", async (t) => {
  const h = fixture(t);
  const ref = createInteractiveTuiReference(() => h.tui);
  const p = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8, host: ref });
  for (const [method, native] of Object.entries(h.native)) {
    assert.notEqual(h.tui[method], native, method);
    assert.equal(Object.hasOwn(ref, method), false, `${method}: no inert proxy property`);
  }
  const start = bodyPoint(p, 0, 0);
  for (const [x, y] of [
    [p.col + p.width - 1, p.row + p.height - 1],
    [40, 14],
  ]) {
    h.press(start.x, start.y);
    h.drag(x, y);
    const selected = h
      .paint()
      .map(highlighted)
      .map((text) => text.trimEnd())
      .filter(Boolean);
    assert.deepEqual(selected, BODY, "native highlight excludes the frame and root");
    h.release(x, y);
    await h.tick();
    assert.equal(h.copied.at(-1), BODY.join("\n"));
    h.tui.flashes.dispose(); // Don't include the native copy toast in the next highlight.
    h.paint();
  }
  assert.equal(h.copied.length, 2);
  p.tracker.dispose();
  assert.equal(h.tui.hasActiveSelection(), false);
  for (const [method, native] of Object.entries(h.native)) {
    assert.equal(h.tui[method], native, method);
    assert.equal(Object.hasOwn(h.tui, method), false, `${method}: native descriptor restored`);
  }
});

test("old selection reset and disposal are renderer-local after a stable reference swap", async (t) => {
  const old = fixture(t, { copyOnSelect: false });
  const next = fixture(t, { copyOnSelect: false });
  let current = old.tui;
  const ref = createInteractiveTuiReference(() => current);
  const geometry = { name: "A", row: 2, col: 5, width: 30, height: 8, host: ref };
  const a = old.overlay(geometry);
  const start = bodyPoint(a, 0, 0);
  const dragBody = (h) => {
    h.press(start.x, start.y);
    h.drag(40, 14);
    assert.equal(h.tui.hasActiveSelection(), true);
  };
  dragBody(old);
  current = next.tui;
  assert.equal(ref.valueOf(), next.tui);
  for (const [method, native] of Object.entries(next.native))
    assert.equal(next.tui[method], native, `${method}: old hooks do not migrate`);
  const b = next.overlay(geometry);
  dragBody(next);
  const nextHooks = Object.keys(next.native).map((method) => next.tui[method]);
  const renders = [old.renders, next.renders];

  a.tracker.reset();
  assert.equal(old.resets.length, 1, "cleanup targets the old owned anchor");
  assert.equal(old.tui.hasActiveSelection(), false);
  a.tracker.dispose();
  for (const [method, native] of Object.entries(old.native)) assert.equal(old.tui[method], native);
  assert.deepEqual(
    Object.keys(next.native).map((method) => next.tui[method]),
    nextHooks,
  );
  assert.deepEqual([old.renders, next.renders], renders, "old cleanup asks neither TUI to paint");
  assert.equal(next.resets.length, 0);
  next.release(40, 14);
  assert.equal(await next.tui.copyActiveSelectionToClipboard(), true);
  assert.deepEqual(next.copied, [BODY.join("\n")]);
  b.tracker.dispose();
  for (const [method, native] of Object.entries(next.native))
    assert.equal(next.tui[method], native);
});

test("multi-row selection highlights and copies only the painted body", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 1);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  const screen = h.paint();

  assert.deepEqual(h.copied, ["alpha bravo charlie\ndelta"]);
  assert.equal(highlighted(screen[start.y]).trimEnd(), "alpha bravo charlie");
  assert.equal(highlighted(screen[end.y]).trimEnd(), "delta");
  assert.equal(highlighted(screen[panel.row]), "", "the top border is outside the body");
  assert.equal(
    highlighted(screen[panel.row + panel.height - 1]),
    "",
    "the bottom border is outside",
  );
  assert.equal(highlighted(screen[panel.row + 12]), "", "root rows are outside");
  assert(stripTerminalSequences(screen[start.y]).includes("|alpha bravo charlie"));
});

test("reverse and out-of-bounds drags stay inside the body and never leak borders", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const topLeft = bodyPoint(panel, 0, 0);
  const bottomRight = bodyPoint(panel, panel.bodyRect.width - 1, panel.bodyRect.height - 1);

  // Reverse drag: press at the bottom-right, drag beyond the top-left.
  h.press(bottomRight.x, bottomRight.y);
  h.drag(0, 0);
  h.release(0, 0);
  await h.tick();
  let screen = h.paint();
  assert.deepEqual(h.copied.at(-1), BODY.join("\n"));
  for (let index = 0; index < BODY.length; index++) {
    assert.equal(highlighted(screen[panel.row + 1 + index]).trimEnd(), BODY[index]);
  }
  assert.equal(highlighted(screen[panel.row]), "");
  assert.equal(highlighted(screen[panel.row + panel.height - 1]), "");
  assert(!h.copied.at(-1).includes("|"));
  assert(!h.copied.at(-1).includes("+"));

  // Forward drag beyond the terminal clamps to the body's bottom-right.
  h.press(topLeft.x, topLeft.y);
  h.drag(200, 200);
  h.release(200, 200);
  await h.tick();
  screen = h.paint();
  assert.deepEqual(h.copied.at(-1), BODY.join("\n"));
  assert.equal(highlighted(screen[panel.row + 1]).trimEnd(), BODY[0]);
  assert.equal(highlighted(screen[panel.row + panel.height - 2]).trimEnd(), BODY.at(-1));
});

test("CJK, emoji ZWJ and combining text keep native grapheme boundaries", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({
    name: "A",
    row: 2,
    col: 5,
    width: 30,
    height: 8,
    body: ["A中B👩‍💻C", "e\u0301cole", "plain", "fourth", "fifth", "sixth"],
  });
  const point = bodyPoint(panel, 0, 0);
  for (let click = 0; click < 3; click++) {
    h.press(point.x, point.y);
    h.release(point.x, point.y);
    h.advance(50);
  }
  await h.tick();
  const screen = h.paint();
  assert.equal(h.copied.at(-1), "A中B👩‍💻C");
  assert.equal(highlighted(screen[point.y]).trimEnd(), "A中B👩‍💻C");

  const second = bodyPoint(panel, 0, 1);
  for (let click = 0; click < 3; click++) {
    h.press(second.x, second.y);
    h.release(second.x, second.y);
    h.advance(50);
  }
  await h.tick();
  assert.equal(h.copied.at(-1), "e\u0301cole");
});

test("double-click selects a word and triple-click selects the line", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const bravo = bodyPoint(panel, 6, 0);
  for (let click = 0; click < 2; click++) {
    h.press(bravo.x, bravo.y);
    h.release(bravo.x, bravo.y);
    h.advance(50);
  }
  await h.tick();
  assert.equal(h.copied.at(-1), "bravo");

  h.advance(600);
  const linePoint = bodyPoint(panel, 0, 1);
  for (let click = 0; click < 3; click++) {
    h.press(linePoint.x, linePoint.y);
    h.release(linePoint.x, linePoint.y);
    h.advance(50);
  }
  await h.tick();
  assert.equal(h.copied.at(-1), "delta echo foxtrot");
});

test("OSC8 links keep native activation and selection text", async (t) => {
  const link = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
  const h = fixture(t);
  const panel = h.overlay({
    name: "A",
    row: 2,
    col: 5,
    width: 30,
    height: 8,
    body: [`${link} after`, "second", "third", "fourth", "fifth", "sixth"],
  });
  const at = bodyPoint(panel, 0, 0);
  h.press(at.x, at.y);
  h.release(at.x, at.y);
  await h.tick();
  assert.deepEqual(h.opened, ["https://example.com"], "a native link click still opens");
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), false, "the native click clears its selection");

  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 11, 0);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.equal(h.copied.at(-1), "link after");
  assert(!h.copied.at(-1).includes("\x1b]8"));
});

test("handled controls and fresh root selections are not clamped by a stale domain", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({
    name: "A",
    row: 2,
    col: 5,
    width: 30,
    height: 8,
    handled: (event) =>
      event.type === "press" && event.button === "left" && event.x === 2 && event.y === 2,
  });
  const control = { x: panel.col + 2, y: panel.row + 2 };
  h.press(control.x, control.y);
  h.release(control.x, control.y);
  await h.tick();
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), false, "a handled control press is not a selection");
  assert.deepEqual(h.copied, []);

  const rootStart = { x: 0, y: 15 };
  const rootEnd = { x: 20, y: 16 };
  h.press(rootStart.x, rootStart.y);
  h.drag(rootEnd.x, rootEnd.y);
  h.release(rootEnd.x, rootEnd.y);
  await h.tick();
  assert(h.copied.at(-1).includes("Root row 15"));
  assert(h.copied.at(-1).includes("Root row 16"));
  assert(!h.copied.at(-1).includes("alpha"));

  // A previous body selection must not clamp a later root selection either.
  const body = bodyPoint(panel, 0, 0);
  h.press(body.x, body.y);
  h.drag(body.x + 5, body.y);
  h.release(body.x + 5, body.y);
  await h.tick();
  assert.equal(h.copied.at(-1), "alpha");
  h.press(rootStart.x, rootStart.y);
  h.drag(rootEnd.x, rootEnd.y);
  h.release(rootEnd.x, rootEnd.y);
  await h.tick();
  assert(h.copied.at(-1).includes("Root row 15"));
  assert(!h.copied.at(-1).includes("alpha"));
});

test("two panels keep their own bodies and replace the single native selection", async (t) => {
  const h = fixture(t);
  const first = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const second = h.overlay({
    name: "B",
    row: 12,
    col: 5,
    width: 30,
    height: 8,
    body: ["one two three", "four five six", "seven", "eight", "nine", "ten"],
  });
  const a = bodyPoint(first, 0, 0);
  h.press(a.x, a.y);
  h.drag(a.x + 4, a.y);
  h.release(a.x + 4, a.y);
  await h.tick();
  assert.equal(h.copied.at(-1), "alpha");

  const b = bodyPoint(second, 0, 1);
  h.press(b.x, b.y);
  h.drag(b.x + 3, b.y);
  h.release(b.x + 3, b.y);
  await h.tick();
  assert.equal(h.copied.at(-1), "four");
  assert(!h.copied.at(-1).includes("alpha"));
  const screen = h.paint();
  assert.equal(highlighted(screen[a.y]).trimEnd(), "");
  assert.equal(highlighted(screen[b.y]).trimEnd(), "four");
});

test("hide, move, resize and overlap cancel before copy and leave no highlight", async (t) => {
  for (const kind of ["hide", "move", "resize", "overlap"]) {
    const h = fixture(t);
    const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
    const start = bodyPoint(panel, 0, 0);
    const end = bodyPoint(panel, 5, 1);
    h.press(start.x, start.y);
    h.drag(end.x, end.y);
    h.paint();
    assert.equal(
      h.tui.hasActiveSelection(),
      true,
      `${kind}: selection is live before invalidation`,
    );

    if (kind === "hide") panel.handle.setHidden(true);
    if (kind === "move") panel.options.row += 4;
    if (kind === "resize") {
      panel.setPanelHeight(10);
      panel.setBodyRect({ x: 1, y: 1, width: 28, height: 8 });
    }
    if (kind === "overlap") {
      h.overlay({ name: "B", row: 2, col: 5, width: 30, height: 8 });
    }
    const screen = h.paint();
    assert.equal(h.tui.hasActiveSelection(), false, `${kind}: invalidation cancels the selection`);
    assert.equal(h.resets.length > 0, true, `${kind}: public resetTextSelection is used`);
    assert.equal(highlighted(screen[start.y]).trimEnd(), "", `${kind}: no stale highlight`);
    assert.equal(await h.tui.copyActiveSelectionToClipboard(), false, `${kind}: copy is empty`);
    h.release(end.x, end.y);
    await h.tick();
    assert.deepEqual(h.copied, [], `${kind}: release cannot copy an invalidated selection`);
  }
});

test("a newer non-overlapping panel preserves the bound selection", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 1);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  h.overlay({ name: "B", row: 12, col: 5, width: 30, height: 8 });
  const screen = h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);
  assert.equal(highlighted(screen[start.y]).trimEnd(), "alpha bravo charlie");
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
  assert.equal(h.copied.at(-1), "alpha bravo charlie\ndelta");
});

test("reset and dispose retire admission and cancel the owned native selection", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 1);

  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);
  panel.tracker.reset();
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.equal(h.resets.length, 1);

  // No painted rectangle means no admission: the fresh native selection is
  // unbounded until the panel paints again.
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert(h.copied.at(-1).includes("|"), "an unadmitted selection reaches the border");

  h.paint();
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);
  panel.tracker.dispose();
  assert.equal(h.tui.hasActiveSelection(), false);
  h.paint();
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.equal(h.copied.at(-1).includes("|"), true, "disposed selection stays unbounded");
});

test("copyOnSelect false preserves the selection for an explicit public copy", async (t) => {
  const h = fixture(t, { copyOnSelect: false });
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 1);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.deepEqual(h.copied, []);
  assert.equal(h.tui.hasActiveSelection(), true);
  const screen = h.paint();
  assert.equal(highlighted(screen[start.y]).trimEnd(), "alpha bravo charlie");
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
  assert.deepEqual(h.copied, ["alpha bravo charlie\ndelta"]);
});

test("an unhandled title or border press cannot start an overflowing selection", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  for (const chrome of [
    { x: panel.col + 2, y: panel.row },
    { x: panel.col, y: panel.row + 2 },
    { x: panel.col + 2, y: panel.row + panel.height - 1 },
  ]) {
    h.press(chrome.x, chrome.y);
    h.drag(panel.col + 10, panel.row + 3);
    h.release(panel.col + 10, panel.row + 3);
    await h.tick();
    const screen = h.paint();
    assert.deepEqual(h.copied, [], `${chrome.x},${chrome.y}: chrome press copies nothing`);
    assert.equal(h.tui.hasActiveSelection(), false);
    assert.equal(highlighted(screen[panel.row + 1]).trimEnd(), "");
  }

  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 0);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.equal(h.copied.at(-1), "alpha", "a later body press still selects normally");
});

test("a native drag that starts outside panels stays native over a panel", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  h.press(0, 15);
  h.drag(panel.col + 10, panel.row + 2);
  h.release(panel.col + 10, panel.row + 2);
  await h.tick();
  const text = h.copied.at(-1);
  assert(text.includes("Root row 10"), "the root end of the native selection is retained");
  assert(text.includes("golf hotel india"), "the drag passing over the panel is not suppressed");
  assert(!text.startsWith("delta"), "the selection is not clamped to the panel body");
});

test("a partial hook takeover cancels before public copy and preserves the foreign method", async (t) => {
  const h = fixture(t, { copyOnSelect: false });
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 2);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);

  h.tui.getSelectionColumns = h.native.getSelectionColumns;
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  assert.deepEqual(h.copied, [], "takeover cannot leak the frame or background");
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.equal(
    h.tui.getSelectionColumns,
    h.native.getSelectionColumns,
    "the foreign replacement is retained",
  );
  assert.equal(
    h.tui.getSelectionBounds,
    h.native.getSelectionBounds,
    "still-owned hooks are restored",
  );
  const screen = h.paint();
  assert.equal(highlighted(screen[start.y]).trimEnd(), "");

  panel.tracker.dispose();
  assert.equal(h.tui.getSelectionColumns, h.native.getSelectionColumns);
});

test("a no-op live reset falls back to the captured native reset for reset and cleanup", async (t) => {
  const h = fixture(t, { copyOnSelect: false });
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 5, 2);
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);

  h.tui.resetTextSelection = () => {};
  panel.tracker.reset();
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  assert.deepEqual(h.copied, [], "reset cannot leak the frame or background");

  h.paint();
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.paint();
  assert.equal(h.tui.hasActiveSelection(), true);
  h.tui.resetTextSelection = () => {};
  panel.tracker.dispose();
  assert.equal(h.tui.hasActiveSelection(), false, "dispose also falls back to the captured reset");
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  assert.deepEqual(h.copied, []);
});

test("an unpainted terminal resize suppresses a fresh body press until repaint", async (t) => {
  const h = fixture(t, { copyOnSelect: false });
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const start = bodyPoint(panel, 0, 0);
  const end = bodyPoint(panel, 17, 2);

  h.terminal.columns -= 1;
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.equal(h.tui.hasActiveSelection(), false, "stale paint is not admitted");
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  assert.deepEqual(h.copied, [], "no frame or background leak before repaint");

  h.paint();
  h.press(start.x, start.y);
  h.drag(end.x, end.y);
  h.release(end.x, end.y);
  await h.tick();
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
  assert.equal(
    h.copied.at(-1),
    "alpha bravo charlie\ndelta echo foxtrot\ngolf hotel india",
    "repaint admits the body again",
  );
  assert(!h.copied.at(-1).includes("Root"));
  assert(!h.copied.at(-1).includes("|"));
});

for (const kind of ["takeover", "no-op reset"]) {
  test(`review geometry: ${kind} cannot copy BACKGROUND or frame`, async (t) => {
    const h = fixture(t, { copyOnSelect: false, rootLines: "BACKGROUND".repeat(10) });
    const panel = h.overlay({
      name: "A",
      row: 3,
      col: 5,
      width: 20,
      height: 5,
      body: ["one", "two", "three"],
    });
    const start = bodyPoint(panel, 0, 0);
    const end = bodyPoint(panel, 5, 2);
    h.press(start.x, start.y);
    h.drag(end.x, end.y);
    h.paint();
    assert.equal(h.tui.hasActiveSelection(), true);

    if (kind === "takeover") h.tui.getSelectionColumns = h.native.getSelectionColumns;
    else {
      h.tui.resetTextSelection = () => {};
      panel.tracker.reset();
    }
    assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
    assert.deepEqual(h.copied, []);
    const screen = h.paint();
    assert.equal(highlighted(screen[start.y]).trimEnd(), "");
  });
}

test("empty chrome domains preserve native rapid click synthesis without selecting", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const chrome = { x: panel.col + 5, y: panel.row };
  for (let click = 0; click < 3; click++) {
    h.press(chrome.x, chrome.y);
    assert.equal(h.tui.hasActiveSelection(), false);
    h.release(chrome.x, chrome.y);
    await h.tick();
    const screen = h.paint();
    assert(
      screen.every((line) => highlighted(line) === ""),
      "chrome never highlights a word/line",
    );
    assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
    h.advance(50);
  }
  assert.deepEqual(
    panel.events
      .filter((event) => event.type === "click")
      .map((event) => ({
        x: event.x,
        y: event.y,
        count: event.clickCount,
      })),
    [1, 2, 3].map((count) => ({ x: 5, y: 0, count })),
  );
  assert.deepEqual(h.copied, []);
});

test("an empty chrome gesture cannot click a different release cell without motion reports", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  h.press(panel.col + 5, panel.row);
  h.release(panel.col + 12, panel.row);
  await h.tick();
  assert.deepEqual(
    panel.events.filter((event) => event.type === "click"),
    [],
  );
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.deepEqual(h.copied, []);
});

for (const action of ["hide", "reset", "dispose"])
  test(`empty chrome domains retain lifecycle ownership on ${action}`, async (t) => {
    const h = fixture(t);
    const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
    h.press(panel.col + 5, panel.row);
    if (action === "hide") panel.handle.setHidden(true);
    else panel.tracker[action]();
    h.release(panel.col + 5, panel.row);
    await h.tick();
    assert.equal(h.tui.hasActiveSelection(), false);
    assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
    assert.deepEqual(
      panel.events.filter((event) => event.type === "click"),
      [],
    );
    assert.deepEqual(h.copied, []);
  });

for (const alreadySelected of [false, true])
  test(`a rendered zero-row overlay never covers a panel body (selected=${alreadySelected})`, async (t) => {
    const h = fixture(t, { copyOnSelect: false });
    const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
    const start = bodyPoint(panel, 0, 0),
      end = bodyPoint(panel, 5, 1);
    if (alreadySelected) {
      h.press(start.x, start.y);
      h.drag(end.x, end.y);
      h.release(end.x, end.y);
      assert.equal(h.tui.hasActiveSelection(), true);
    }
    // Deliberately inside the body: a zero-height rectangle here must have no
    // overlap, not merely pass because it is in another corner of the screen.
    const empty = h.tui.showOverlay(
      { render: () => [], invalidate() {} },
      {
        row: panel.row + 2,
        col: panel.col + 2,
        width: 10,
      },
    );
    t.after(() => empty.hide());
    h.paint();
    assert.equal(empty.getBounds()?.height, 0, "the native layout exists with zero rows");
    if (!alreadySelected) {
      h.press(start.x, start.y);
      h.drag(end.x, end.y);
      h.release(end.x, end.y);
    }
    assert.equal(h.tui.hasActiveSelection(), true);
    assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
    assert.deepEqual(h.copied, ["alpha bravo charlie\ndelta"]);
    const screen = h.paint();
    assert.equal(highlighted(screen[start.y]).trimEnd(), "alpha bravo charlie");
    assert.equal(highlighted(screen[end.y]).trimEnd(), "delta");
  });

for (const kind of ["body-only", "unpainted"])
  test(`an empty chrome click survives a newer ${kind} overlay`, async (t) => {
    const h = fixture(t);
    const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
    const newer = h.tui.showOverlay(
      { render: () => ["COVER"], invalidate() {} },
      {
        row: panel.row + 2,
        col: panel.col + 2,
        width: 10,
      },
    );
    t.after(() => newer.hide());
    if (kind === "body-only") h.paint();
    h.press(panel.col + 5, panel.row);
    h.release(panel.col + 5, panel.row);
    await h.tick();
    assert.equal(
      panel.events.filter((event) => event.type === "click").length,
      1,
      "coverage away from the pressed chrome cell must not swallow its native click",
    );
    assert.equal(h.tui.hasActiveSelection(), false);
    assert.deepEqual(h.copied, []);
  });

test("covering the pressed chrome cell cancels rather than retargets its click", async (t) => {
  const h = fixture(t);
  const panel = h.overlay({ name: "A", row: 2, col: 5, width: 30, height: 8 });
  const coveredEvents = [];
  h.press(panel.col + 5, panel.row);
  const cover = h.tui.showOverlay(
    {
      render: () => ["COVER"],
      invalidate() {},
      handleMouse(event) {
        coveredEvents.push(event);
      },
    },
    { row: panel.row, col: panel.col + 5, width: 10 },
  );
  t.after(() => cover.hide());
  h.paint();
  h.release(panel.col + 5, panel.row);
  await h.tick();
  assert.deepEqual(
    panel.events.filter((event) => event.type === "click"),
    [],
  );
  assert.deepEqual(
    coveredEvents.filter((event) => event.type === "click"),
    [],
  );
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.deepEqual(h.copied, []);
});
