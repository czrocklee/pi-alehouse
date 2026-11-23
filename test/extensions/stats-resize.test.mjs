import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TuiAltScreen, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { borderLabelsEnabled, setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";

// Source-loaded owner and real pinned compositor; no terminal or provider IO.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { default: statsExtension } = await jiti.import("../../src/extensions/stats.ts");
const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const KEY = {
  f2: "\x1bOQ",
  enter: "\r",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  pageDown: "\x1b[6~",
};

function fixture(t, { labels = true, rows = 72 } = {}) {
  const previousLabels = borderLabelsEnabled();
  setBorderLabelsEnabled(labels);
  const terminal = { columns: 140, rows, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  tui.requestViewRender = () => {};
  tui.setLayoutRoot({
    render: () => Array.from({ length: terminal.rows }, () => "Transcript"),
    invalidate() {},
  });
  tui.beforeTerminalStart();
  const session = new EventEmitter();
  const events = new EventEmitter();
  const subscribe = (emitter) => (name, handler) => {
    emitter.on(name, handler);
    return () => emitter.off(name, handler);
  };
  const { showOverlay } = tui;
  const notices = [];
  let handle, command;
  tui.showOverlay = (component, options) => (handle = showOverlay.call(tui, component, options));
  const host = createInteractiveTuiReference(() => tui);
  const text = (_tone, value) => value;
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "stats-resize" },
    ui: {
      theme: { fg: text, bg: text, bold: (value) => value },
      setWidget: (_key, factory) => factory?.(host),
      setStatus() {},
      notify: (message) => notices.push(message),
    },
  };
  statsExtension({
    on: subscribe(session),
    events: { on: subscribe(events) },
    registerCommand(name, spec) {
      assert.equal(name, "stats");
      command = spec;
    },
  });
  session.emit("session_start", {}, ctx);
  t.after(() => {
    session.emit("session_shutdown", {});
    setBorderLabelsEnabled(previousLabels);
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });

  const input = (key) => tui.handleTerminalInput(key);
  const pointer = (x, y, button, release = false) =>
    input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const paint = () => {
    tui.doRender();
    const box = handle?.getBounds();
    assert.ok(box, "Stats has a painted overlay");
    const { row, col, height, width } = box;
    const lines = tui
      .getScreenLines()
      .slice(row, row + height)
      .map((line) => sliceByColumn(stripTerminalSequences(line), col, width));
    return { ...box, lines };
  };
  return {
    terminal,
    async open() {
      await command.handler("", ctx);
      assert.deepEqual(notices, [], "opening Stats emits no errors");
    },
    visible: () => tui.hasOverlay(),
    input,
    paint,
    pointer,
    click(x, y) {
      pointer(x, y, 0);
      pointer(x, y, 0, true);
    },
    beginResize() {
      input(KEY.f2);
      const editing = paint();
      assert.match(editing.lines.join("\n"), /Resize/u);
      assert.match(editing.lines[0], /^╔═.*╗$/u);
      assert.match(editing.lines.at(-1), /^╚═.*═╝$/u);
      const tabY = labels ? 1 : 3;
      assert.match(editing.lines[tabY], /^║.*║$/u);
      assert.match(editing.lines[tabY + 1], /^╟─.*╢$/u);
      return editing;
    },
    tools(count) {
      session.emit("agent_start", {});
      for (let i = 0; i < count; i++) {
        const toolCallId = `call-${i}`;
        session.emit("tool_execution_start", { toolCallId, toolName: `tool-${i}` });
        session.emit("tool_execution_end", { toolCallId, isError: false, durationMs: 10 });
      }
      session.emit("agent_settled", {});
    },
  };
}

function assertCentered(box, terminal) {
  assert.equal(box.row, Math.floor((terminal.rows - box.height) / 2));
  assert.equal(box.col, Math.floor((terminal.columns - box.width) / 2));
}

function assertFrame(box) {
  assert.equal(box.lines.length, box.height);
  assert.match(box.lines[0], /^╭/);
  assert.match(box.lines.at(-1), /^╰.*╯$/);
}

const dimensions = ({ width, height }) => ({ width, height });

test("centered Stats keyboard resize fills the requested height and reopens at its natural size", async (t) => {
  // Automatic width includes elapsed time. Keep the same content on both
  // opens: crossing a digit boundary under CI load legitimately adds a cell.
  t.mock.method(performance, "now", () => 1_000);
  const f = fixture(t);
  await f.open();
  const initial = f.paint();
  assertFrame(initial);
  assertCentered(initial, f.terminal);
  assert.match(initial.lines[0], /□.*✕/u);
  assert.doesNotMatch(initial.lines[0], /≡|Resize/u);
  assert.ok(initial.height < Math.floor(f.terminal.rows * 0.75), "auto height hugs content");
  assert.ok(initial.width < Math.floor(f.terminal.columns * 0.85), "auto width hugs tables");

  assert.deepEqual(dimensions(f.beginResize()), dimensions(initial));
  f.input("l");
  f.input("j");
  f.input("j");
  const preview = { width: initial.width + 2, height: initial.height + 4 };
  assert.deepEqual(dimensions(f.paint()), preview, "letter keys adjust without Enter");
  f.input("z");
  const maximized = f.paint();
  assert.deepEqual(dimensions(maximized), { width: 138, height: 70 });
  assert.match(maximized.lines[0], /Resize/u, "maximize is still a keyboard preview");
  f.input("z");
  const restored = f.paint();
  assert.deepEqual(dimensions(restored), preview, "z restores the previous preview");
  assert.match(restored.lines[0], /Resize/u);
  f.input(KEY.enter);
  const grown = f.paint();
  assert.deepEqual(dimensions(grown), preview);
  assert.doesNotMatch(grown.lines[0], /Resize/u);
  assertCentered(grown, f.terminal);
  assertFrame(grown);
  f.input("3");
  const tools = f.paint();
  assert.match(tools.lines[1], /›3 Tools‹/);
  assert.deepEqual(dimensions(tools), dimensions(grown));
  assert.match(tools.lines.at(-2), /^│ +│$/, "short tab paints padding inside the box");

  f.beginResize();
  f.input(KEY.left);
  assert.equal(f.paint().width, grown.width - 2);
  f.input(KEY.f2);
  const reverted = f.paint();
  assert.deepEqual(dimensions(reverted), dimensions(grown), "F2 reverts the preview");
  assert.doesNotMatch(reverted.lines[0], /Resize/u);
  f.input(KEY.esc);
  assert.equal(f.visible(), false, "Escape still closes Stats outside resize mode");
  await f.open();
  assert.deepEqual(dimensions(f.paint()), dimensions(initial), "a reopened Stats starts automatic");
});

test("centered Stats corner drag, maximize/restore and inset close use live painted geometry", async (t) => {
  const f = fixture(t, { labels: false });
  await f.open();
  const initial = f.paint();
  assert.equal(initial.lines[1][initial.width - 6], "□");
  assert.doesNotMatch(initial.lines[1], /≡|Resize/u);
  assert.equal(initial.lines.at(-1).at(-1), "╯", "ordinary corners serve as drag targets");
  const right = initial.col + initial.width - 1;
  const bottom = initial.row + initial.height - 1;
  f.pointer(right, bottom, 0);
  const held = f.paint();
  assert.deepEqual(dimensions(held), dimensions(initial));
  assert.match(held.lines[0], /^╭─.*╖$/u);
  assert.match(held.lines[1], /^│.*✕.*║$/u);
  assert.match(held.lines[2], /^├─.*╢$/u);
  assert.match(held.lines[3], /^│.*›1 Overview‹.*║$/u);
  assert.match(held.lines[4], /^├─.*╢$/u);
  assert.match(held.lines.at(-3), /^├─.*╢$/u);
  assert.match(held.lines.at(-2), /^│.*Esc.*║$/u);
  assert.match(held.lines.at(-1), /^╘═.*═╝$/u);
  f.pointer(right + 3, bottom + 3, 32);
  const preview = f.paint();
  assert.match(preview.lines.at(-1), /^╘═.*═╝$/u);
  f.pointer(right + 3, bottom + 3, 0, true);
  const manual = f.paint();
  assert.ok(manual.width > initial.width && manual.height > initial.height);
  assertCentered(manual, f.terminal);
  assertFrame(manual);
  const editing = f.beginResize();
  assert.match(editing.lines[1], /^║.*Resize.*║$/u);
  f.input(KEY.esc);
  assert.deepEqual(dimensions(f.paint()), dimensions(manual));

  f.click(manual.col + manual.width - 6, manual.row + 1);
  const fullscreen = f.paint();
  assert.deepEqual(dimensions(fullscreen), { width: 138, height: 70 });
  assertCentered(fullscreen, f.terminal);
  assert.equal(fullscreen.lines[1][fullscreen.width - 6], "▣");

  f.terminal.columns = 62;
  f.terminal.rows = 20;
  const clamped = f.paint();
  assert.deepEqual(dimensions(clamped), { width: 60, height: 18 });
  assertCentered(clamped, f.terminal);
  assertFrame(clamped);

  f.terminal.rows = 6;
  const tiny = f.paint();
  assert.equal(tiny.height, 4, "compact fallback still paints the bounded user height");
  assertFrame(tiny);
  assert.doesNotMatch(tiny.lines.join("\n"), /[≡□▣✕]/, "tiny fallback has no invisible targets");
  f.terminal.columns = 140;
  f.terminal.rows = 72;
  const max = f.paint();
  f.click(max.col + max.width - 6, max.row + 1);
  const restored = f.paint();
  assert.deepEqual(dimensions(restored), dimensions(manual));
  f.click(restored.col + restored.width - 4, restored.row + 1);
  assert.equal(f.visible(), false, "the inset close glyph still closes the resized overlay");
});

for (const labels of [true, false]) {
  const placement = labels ? "border" : "inset";
  const titleY = labels ? 0 : 1;
  const tabY = labels ? 1 : 3;

  test(`narrow centered Stats keeps its ${placement} title and controls at 42 and 40 columns`, async (t) => {
    const f = fixture(t, { labels, rows: 40 });
    f.terminal.columns = 50; // The automatic 85% cap is 42 columns.
    await f.open();
    const checkTitle = (box, width) => {
      assertFrame(box);
      assertCentered(box, f.terminal);
      assert.equal(box.width, width);
      const title = box.lines[titleY];
      assert.equal(title.slice(3, width - 7).replace(/[ ─]+$/u, ""), "Stats · main + workers");
      assert.equal(title[width - 6], "□");
      assert.equal(title[width - 4], "✕");
    };
    checkTitle(f.paint(), 42);
    f.beginResize();
    f.input(KEY.left);
    f.input(KEY.enter);
    const narrow = f.paint();
    checkTitle(narrow, 40);

    if (labels) {
      // The visible rule after the short title is still a top-edge handle,
      // even where the unabridged title would have occupied the row.
      const rule = narrow.lines[titleY].indexOf("─", 3);
      assert.ok(rule >= 3 && rule < narrow.width - 7);
      f.pointer(narrow.col + rule, narrow.row + titleY, 0);
      assert.match(f.paint().lines[titleY], /^╒═/u);
      f.pointer(narrow.col + rule, narrow.row + titleY, 0, true);
    }
    f.click(narrow.col + narrow.width - 6, narrow.row + titleY);
    const maximized = f.paint();
    assert.equal(maximized.lines[titleY][maximized.width - 6], "▣");
    f.click(maximized.col + maximized.width - 6, maximized.row + titleY);
    const restored = f.paint();
    checkTitle(restored, 40);
    f.click(restored.col + restored.width - 4, restored.row + titleY);
    assert.equal(f.visible(), false);
  });

  test(`centered Stats keeps one body row at the ${placement} resize minimum`, async (t) => {
    const f = fixture(t, { labels, rows: 40 });
    await f.open();
    f.paint();
    f.beginResize();
    for (let i = 0; i < 16; i++) f.input(KEY.up);
    f.input(KEY.enter);
    const minimum = labels ? 5 : 9;
    const box = f.paint();
    assertFrame(box);
    assert.equal(box.height, minimum);
    assert.match(box.lines[tabY], /›1 Overview‹/u);
    assert.match(box.lines[tabY + 1], /^├─+┤$/u);
    assert.match(box.lines[tabY + 2], /Time .*Main .*Workers/u);
    f.input(KEY.down);
    assert.match(f.paint().lines[tabY + 2], /Busy/u, "the single body row still scrolls");

    f.terminal.rows = minimum + 2;
    assert.equal(f.paint().height, minimum);
    assert.equal(f.beginResize().height, minimum, "resize works at the terminal height limit");
  });
}

test("mounted Stats adapts a five-row manual size to inset labels and restores it on switch back", async (t) => {
  const f = fixture(t, { rows: 40 });
  await f.open();
  f.paint();
  f.beginResize();
  for (let i = 0; i < 16; i++) f.input(KEY.up);
  f.input(KEY.enter);
  const bordered = f.paint();
  assert.equal(bordered.height, 5);

  setBorderLabelsEnabled(false);
  const inset = f.paint();
  assertFrame(inset);
  assertCentered(inset, f.terminal);
  assert.equal(inset.height, 9, "inset bands still leave room for the normal tab and body rows");
  assert.equal(inset.lines[1][inset.width - 6], "□");
  assert.equal(inset.lines[1][inset.width - 4], "✕");
  assert.match(inset.lines[3], /›1 Overview‹/u);
  assert.match(inset.lines[4], /^├─+┤$/u);
  assert.match(inset.lines[5], /Time .*Main .*Workers/u);
  assert.match(
    inset.lines[6],
    /^├─+┤$/u,
    "the footer band immediately follows the single body row",
  );

  f.input(KEY.f2);
  assert.match(f.paint().lines[1], /^║.*Resize.*║$/u);
  f.input(KEY.esc);
  assert.deepEqual(dimensions(f.paint()), dimensions(inset));
  f.click(inset.col + inset.width - 6, inset.row + 1);
  const maximized = f.paint();
  assert.ok(maximized.height > inset.height);
  assert.equal(maximized.lines[1][maximized.width - 6], "▣");
  f.click(maximized.col + maximized.width - 6, maximized.row + 1);
  assert.deepEqual(dimensions(f.paint()), dimensions(inset));

  setBorderLabelsEnabled(true);
  const restored = f.paint();
  assertFrame(restored);
  assert.deepEqual(dimensions(restored), dimensions(bordered), "the inset minimum is not stored");
  assert.match(restored.lines[1], /›1 Overview‹/u);
  assert.match(restored.lines[3], /Time .*Main .*Workers/u);
});

test("vertical Stats resize keeps the full width of a 40-column automatic frame", async (t) => {
  const f = fixture(t, { rows: 40 });
  f.terminal.columns = 40;
  await f.open();
  const initial = f.paint();
  assert.equal(initial.width, 40);
  assertCentered(initial, f.terminal);

  f.beginResize();
  f.input("j");
  assert.deepEqual(dimensions(f.paint()), { width: initial.width, height: initial.height + 2 });
  f.input(KEY.esc);
  assert.deepEqual(dimensions(f.paint()), dimensions(initial));

  const x = initial.col + 1;
  const y = initial.row + initial.height - 1;
  f.pointer(x, y, 0);
  f.pointer(x, y + 2, 32);
  const dragged = { width: initial.width, height: initial.height + 4 };
  assert.deepEqual(dimensions(f.paint()), dragged);
  f.pointer(x, y + 2, 0, true);
  assert.deepEqual(dimensions(f.paint()), dragged);
});

test("Stats preserves scroll offset and uses the resized viewport for page navigation", async (t) => {
  const f = fixture(t, { rows: 40 });
  f.tools(31);
  await f.open();
  f.input("3");
  const initial = f.paint();
  assert.equal(initial.height, 30, "automatic height retains the 75% cap");
  const range = (box) => {
    const match = /(\d+)\/(\d+) lines/.exec(box.lines.at(-1));
    assert.ok(match, "footer reports the scroll range");
    return [Number(match[1]), Number(match[2])];
  };
  const [end, total] = range(initial);
  assert.equal(end, 26, "four rows of chrome lie outside the body");
  f.input(KEY.down);
  f.input(KEY.down);
  f.input(KEY.down);
  const scrolled = f.paint();
  assert.deepEqual(range(scrolled), [end + 3, total]);
  const x = scrolled.col + 1;
  const y = scrolled.row + scrolled.height - 1;
  f.pointer(x, y, 0);
  const held = f.paint();
  assert.match(held.lines.at(-1), /^╘═.*══.*═╛$/u);
  assert.deepEqual(range(held), [end + 3, total]);
  f.pointer(x, y, 0, true);
  assertFrame(f.paint());

  f.beginResize();
  for (let i = 0; i < 6; i++) f.input(KEY.up);
  f.input(KEY.enter);
  const compact = f.paint();
  assertFrame(compact);
  assert.equal(compact.height, 18);
  assert.deepEqual(range(compact), [17, total], "the existing three-row offset fits the new body");
  f.input(KEY.pageDown);
  assert.deepEqual(range(f.paint()), [31, total], "PageDown moves by the new fourteen-row body");
});
