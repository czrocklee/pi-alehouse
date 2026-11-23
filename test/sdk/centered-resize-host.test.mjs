import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { createBackdropDismiss } from "../../src/shared/centered-dismiss.mjs";
import { createCenteredPanel } from "../../src/extensions/lib/centered-panel.ts";
import { borderLabelsEnabled, setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";
import { frameGlyphs } from "../../src/shared/popover-frame.mjs";

const F2 = "\x1b[12~";
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const FOCUS_OUT = "\x1b[O";
const FOCUS_IN = "\x1b[I";

// Exercise Pi's actual compositor and terminal-input routing without starting a TTY.
function fixture(t, { inset = false } = {}) {
  const previous = borderLabelsEnabled();
  setBorderLabelsEnabled(!inset);
  t.after(() => setBorderLabelsEnabled(previous));
  const terminal = { columns: 80, rows: 28, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  // Paint explicitly, keeping Pi's content invalidation separate from view-only requests.
  let viewRequests = 0;
  tui.requestViewRender = () => viewRequests++;
  tui.requestImmediateRender = () => tui.requestRender();
  let rootRenders = 0;
  const root = {
    render() {
      rootRenders++;
      return Array(terminal.rows).fill("Transcript");
    },
    invalidate() {},
  };
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  tui.beforeTerminalStart();

  const tracker = createBackdropDismiss();
  let bodyChanges = 0;
  const resize = createCenteredPanel({
    terminal: () => terminal,
    minWidth: 20,
    minHeight: 5,
    theme: { fg: (_role, text) => text, bold: (text) => text },
    host: tui,
    requestRender: () => tui.requestRender(),
    changed() {
      bodyChanges++;
      tui.requestRender();
    },
  });
  let dismissals = 0;
  let bodyClicks = 0;
  const bodyInput = [];
  const handle = tui.showOverlay(
    {
      get focused() {
        return tracker.focused;
      },
      set focused(value) {
        tracker.focused = value;
        if (!value) resize.reset();
      },
      render(width) {
        const height = resize.height ?? 10;
        const g = frameGlyphs(resize.edges);
        const top = inset
          ? `${g.tl}${g.top.repeat(width - 2)}${g.tr}`
          : `${g.tl}${g.top} Fixture ${g.top.repeat(width - 16)} ✕ ${g.top}${g.tr}`;
        const lines = [
          top,
          ...Array(height - 2).fill(`${g.left}${" ".repeat(width - 2)}${g.right}`),
          `${g.bl}${g.bottom.repeat(width - 2)}${g.br}`,
        ];
        if (inset) lines[1] = `${g.left}  Fixture ${" ".repeat(width - 16)} ✕  ${g.right}`;
        lines[2] = `${g.ml}${"─".repeat(width - 2)}${g.mr}`;
        return resize.paint(lines, width);
      },
      invalidate() {},
      handleInput(data) {
        if (resize.input(data)) return;
        if (matchesKey(data, "escape")) dismiss();
        else bodyInput.push(data);
      },
      handleMouse(event) {
        const result = resize.mouse(event);
        if (result) return result;
        if (event.type === "click" && event.y > 0) {
          bodyClicks++;
          return { handled: true };
        }
      },
    },
    {
      anchor: "center",
      get width() {
        return resize.width ?? 36;
      },
    },
  );
  const detach = tracker.attach(tui, handle, dismiss);
  function dismiss() {
    dismissals++;
    detach();
    handle.hide();
  }
  t.after(() => {
    detach();
    handle.hide();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });

  function paint() {
    tui.doRender();
    const bounds = handle.getBounds();
    assert.ok(bounds, "overlay is mounted and painted");
    return bounds;
  }
  const input = (data) => tui.handleTerminalInput(data);
  const send = ([x, y], code, end) => input(`\x1b[<${code};${x + 1};${y + 1}${end}`);
  const press = (point) => send(point, 0, "M");
  const drag = (point) => send(point, 32, "M");
  const release = (point) => send(point, 0, "m");
  const click = (point) => {
    press(point);
    release(point);
  };
  function glyph(x, y, expected) {
    assert.equal(
      stripTerminalSequences(sliceByColumn(tui.getScreenLines()[y], x, 1)),
      expected,
      `glyph at (${x}, ${y})`,
    );
    return [x, y];
  }
  return {
    tui,
    root,
    handle,
    resize,
    rootRenders: () => rootRenders,
    viewRequests: () => viewRequests,
    bodyChanges: () => bodyChanges,
    bodyClicks: () => bodyClicks,
    bodyInput,
    dismissals: () => dismissals,
    paint,
    input,
    press,
    drag,
    release,
    click,
    glyph,
  };
}

const expand = ({ col, row, width, height }, dx, dy) => ({
  col: col - dx,
  row: row - dy,
  width: width + 2 * dx,
  height: height + 2 * dy,
});

function frame(
  f,
  { col, row, width, height },
  { corners = "╭╮╰╯", sides = "││", divider = "├┤", top = "─", bottom = "─" } = {},
) {
  const right = col + width - 1;
  const bottomRow = row + height - 1;
  f.glyph(col, row, corners[0]);
  f.glyph(right, row, corners[1]);
  f.glyph(col, bottomRow, corners[2]);
  f.glyph(right, bottomRow, corners[3]);
  f.glyph(col, row + 2, divider[0]);
  f.glyph(right, row + 2, divider[1]);
  f.glyph(col, row + 4, sides[0]);
  f.glyph(right, row + 4, sides[1]);
  f.glyph(col + 1, row, top);
  f.glyph(right - 1, row, top);
  f.glyph(col + 3, bottomRow, bottom);
  f.glyph(col + 3, row + 2, "─");
}

const bottomRightFrame = { corners: "╭╖╘╝", sides: "│║", divider: "├╢", bottom: "═" };
const keyboardFrame = { corners: "╔╗╚╝", sides: "║║", divider: "╟╢", top: "═", bottom: "═" };

test("centered border drags survive repaint beyond the original bounds in fullscreen Pi", (t) => {
  const f = fixture(t);
  const before = f.paint();
  const corner = f.glyph(before.col + before.width - 1, before.row + before.height - 1, "╯");
  f.press(corner);
  assert.deepEqual(f.paint(), before, "a press alone does not resize");
  frame(f, before, bottomRightFrame);
  f.input("z");
  assert.deepEqual(f.bodyInput, ["z"], "an ordinary key still reaches the body during capture");
  assert.equal(f.resize.modal, false);
  assert.deepEqual(f.paint(), before);
  frame(f, before, bottomRightFrame); // Native capture still owns the corner.
  const beforeDrag = f.bodyChanges();
  f.drag([corner[0] + 4, corner[1] + 2]);
  assert.ok(f.bodyChanges() > beforeDrag, "a real geometry change still invalidates the body");
  const dragging = f.paint();
  assert.deepEqual(dragging, expand(before, 4, 2));
  frame(f, dragging, bottomRightFrame);
  const outside = [corner[0] + 7, corner[1] + 4];
  f.drag(outside);
  f.release(outside);
  const after = f.paint();
  assert.deepEqual(after, expand(before, 7, 4));
  frame(f, after);
  f.release(corner); // The old corner now lies over the body. An unmatched release is not a click.

  const left = f.glyph(after.col, after.row + 4, "│");
  const leftward = [left[0] - 3, left[1] + 2];
  f.press(left);
  frame(f, f.paint(), { corners: "╓╮╙╯", sides: "║│", divider: "╟┤" });
  f.drag(leftward);
  f.release(leftward);
  const wider = f.paint();
  assert.deepEqual(wider, expand(after, 3, 0), "a left-edge drag changes only width");
  frame(f, wider);
  assert.equal(f.bodyClicks(), 0);
  assert.equal(f.dismissals(), 0);
  assert.ok(f.handle.isFocused());
  assert.equal(f.tui.hasActiveSelection(), false);
  f.click([1, 1]);
  assert.equal(f.dismissals(), 1, "a fresh backdrop click still dismisses");
});

const maximizedBounds = ({ terminal }) => ({
  col: 1,
  row: 1,
  width: terminal.columns - 2,
  height: terminal.rows - 2,
});

test("a stationary right-edge press at the clamp only repaints the perimeter", (t) => {
  const f = fixture(t);
  const initial = f.paint();
  const initialRootRenders = f.rootRenders();
  f.click([initial.col + initial.width - 6, initial.row]);
  const before = f.paint();
  assert.deepEqual(before, maximizedBounds(f.tui));
  const rootRenders = f.rootRenders();
  assert.ok(rootRenders > initialRootRenders, "maximize invalidates Pi's cached root output");
  const right = f.glyph(before.col + before.width - 1, before.row + 4, "│");
  const bodyChanges = f.bodyChanges();
  const viewRequests = f.viewRequests();

  f.press(right);
  assert.ok(
    f.viewRequests() > viewRequests,
    "press requests a view repaint without waiting for drag",
  );
  assert.equal(f.bodyChanges(), bodyChanges);
  assert.deepEqual(f.paint(), before);
  frame(f, before, { corners: "╭╖╰╜", sides: "│║", divider: "├╢" });
  assert.equal(f.rootRenders(), rootRenders, "press reused Pi's cached root output");

  const beforeRelease = f.viewRequests();
  f.release(right);
  assert.ok(f.viewRequests() > beforeRelease, "stationary release requests a view repaint");
  assert.equal(f.bodyChanges(), bodyChanges);
  assert.deepEqual(f.paint(), before);
  frame(f, before);
  assert.equal(f.rootRenders(), rootRenders, "release and synthesized click reused the root");
  assert.equal(f.bodyClicks(), 0, "the synthesized click does not reach the panel body");
  assert.equal(f.dismissals(), 0);
  assert.equal(f.tui.hasActiveSelection(), false);
  f.click([before.col + before.width - 6, before.row]);
  assert.deepEqual(f.paint(), initial, "the no-op press leaves maximize's restore geometry intact");
});

test("interrupted border captures lose their highlight and cannot resize on stale input", async (t) => {
  for (const [label, interrupt] of [
    [
      "terminal focus-out",
      (f, before) => {
        const viewRequests = f.viewRequests();
        const bodyChanges = f.bodyChanges();
        f.input(FOCUS_OUT);
        assert.ok(f.handle.isFocused(), "native focus-out is not component blur");
        assert.ok(
          f.viewRequests() > viewRequests,
          "capture loss requests repaint without another event",
        );
        assert.equal(f.bodyChanges(), bodyChanges);
        assert.deepEqual(f.paint(), before);
        frame(f, before);
        f.input(FOCUS_IN);
      },
    ],
    [
      "terminal stop and restart without input",
      (f) => {
        f.tui.beforeTerminalStop({});
        f.tui.afterTerminalStop({ preserveScreen: true });
        f.tui.beforeTerminalStart();
        assert.ok(f.handle.isFocused(), "restarting the same TUI does not blur the overlay");
        // The common assertions repaint before sending any terminal input.
      },
    ],
    [
      "blur and refocus",
      (f) => {
        f.tui.setFocus(f.root);
        assert.equal(f.handle.isFocused(), false);
        f.handle.focus();
      },
    ],
    [
      "hide and reveal",
      (f) => {
        f.handle.setHidden(true);
        assert.equal(f.handle.isFocused(), false);
        f.tui.doRender();
        f.handle.setHidden(false);
      },
    ],
    [
      "terminal resize",
      (f) => {
        f.tui.terminal.columns -= 4;
        frame(f, f.paint());
        f.tui.terminal.columns += 4;
      },
    ],
    [
      "F2 keyboard resize",
      (f, before) => {
        f.input(F2);
        assert.ok(f.resize.modal);
        assert.deepEqual(f.paint(), before);
        frame(f, before, keyboardFrame);
        f.input(ESC);
        assert.equal(f.resize.modal, false);
      },
    ],
  ]) {
    await t.test(label, (subtest) => {
      const f = fixture(subtest);
      const before = f.paint();
      const corner = [before.col + before.width - 1, before.row + before.height - 1];
      const outside = [corner[0] + 2, corner[1] + 2];
      f.press(corner);
      frame(f, f.paint(), bottomRightFrame);
      interrupt(f, before);
      assert.deepEqual(f.paint(), before);
      frame(f, before);
      f.drag(outside);
      f.release(outside);
      assert.deepEqual(f.paint(), before, "the old press cannot resize after the interruption");
      assert.equal(f.bodyClicks(), 0);
      assert.equal(f.dismissals(), 0);
      assert.equal(f.tui.hasActiveSelection(), false);

      f.press(corner);
      f.release(outside);
      assert.deepEqual(f.paint(), expand(before, 2, 2), "a new press can still resize");
    });
  }
});

function title(f, { col, row, width }, inset = false) {
  return stripTerminalSequences(
    sliceByColumn(f.tui.getScreenLines()[row + Number(inset)], col, width),
  );
}

test("centered title maximize/restore works through fullscreen Pi", (t) => {
  const f = fixture(t);
  const before = f.paint();
  assert.match(title(f, before), / □ ✕ ─╮$/u);
  assert.doesNotMatch(title(f, before), /≡/u);
  f.glyph(before.col + before.width - 4, before.row, "✕");
  const maximize = f.glyph(before.col + before.width - 6, before.row, "□");
  f.press(maximize);
  f.tui.setFocus(f.root);
  f.handle.focus();
  f.paint();
  f.release(maximize);
  assert.deepEqual(f.paint(), before, "a click synthesized from the pre-blur press is stale");
  f.press(maximize);
  f.input(FOCUS_OUT); // Native terminal focus-out drops capture without blurring the component.
  f.input(FOCUS_IN);
  f.release(maximize);
  assert.deepEqual(f.paint(), before, "a release after terminal focus loss cannot maximize");
  f.click(maximize);
  const maximized = f.paint();
  assert.deepEqual(maximized, maximizedBounds(f.tui));
  f.click(f.glyph(maximized.col + maximized.width - 6, maximized.row, "▣"));
  assert.deepEqual(f.paint(), before, "restore returns to the automatic dimensions");
});

test("F2 resize decodes arrows and h/j/k/l around the same center in fullscreen Pi", (t) => {
  const f = fixture(t);
  const before = f.paint();
  const idleKeys = ["h", "j", "k", "l", "z", LEFT, RIGHT, UP, DOWN, ENTER, "\x1b[13~"];
  for (const key of idleKeys) f.input(key);
  assert.deepEqual(f.bodyInput, idleKeys);
  assert.deepEqual(f.paint(), before);
  assert.equal(f.resize.modal, false);

  f.input(F2);
  assert.deepEqual(f.paint(), before);
  assert.ok(f.resize.modal);
  assert.match(title(f, before), /\bResize\b/u);
  frame(f, before, keyboardFrame);
  f.input("x");
  f.click([before.col + 3, before.row + 4]);
  assert.equal(f.bodyClicks(), 0, "keyboard resize does not activate panel controls");
  let expected = before;
  for (const [arrow, letter, dx, dy] of [
    [LEFT, "h", -1, 0],
    [DOWN, "j", 0, 1],
    [UP, "k", 0, -1],
    [RIGHT, "l", 1, 0],
  ]) {
    for (const key of [arrow, letter]) {
      f.input(key);
      expected = expand(expected, dx, dy);
      assert.deepEqual(f.paint(), expected, `resize with ${JSON.stringify(key)}`);
    }
  }
  f.input(RIGHT);
  f.input(DOWN);
  const committed = expand(before, 1, 1);
  assert.deepEqual(f.paint(), committed);
  f.input(ENTER);
  assert.equal(f.resize.modal, false);
  assert.deepEqual(f.paint(), committed);
  frame(f, committed);

  for (const cancel of [ESC, F2]) {
    f.input(F2);
    f.input(LEFT);
    f.input(UP);
    assert.deepEqual(f.paint(), before);
    f.input(cancel);
    assert.equal(f.resize.modal, false);
    assert.deepEqual(f.paint(), committed, "cancel restores the previous manual bounds");
  }
  assert.deepEqual(f.bodyInput, idleKeys, "modal keys did not reach the panel content");
  assert.equal(f.dismissals(), 0, "modal Esc did not dismiss the overlay");
});

test("the inset F2 hint leaves the whole double perimeter visible", (t) => {
  const f = fixture(t, { inset: true });
  const before = f.paint();
  assert.match(title(f, before, true), /Fixture/);
  frame(f, before);
  f.input(F2);
  assert.deepEqual(f.paint(), before);
  frame(f, before, keyboardFrame);
  assert.match(title(f, before, true), /^║\s*Resize.*║$/u);
  f.input(ESC);
  assert.deepEqual(f.paint(), before);
  frame(f, before);
  assert.match(title(f, before, true), /Fixture/);
});

test("z previews maximize or restore without leaving F2 resize in fullscreen Pi", (t) => {
  const f = fixture(t);
  const before = f.paint();
  const maximized = maximizedBounds(f.tui);
  f.input(F2);
  f.input("z");
  assert.deepEqual(f.paint(), maximized);
  assert.ok(f.resize.modal);
  f.input("z");
  assert.deepEqual(f.paint(), before);
  assert.ok(f.resize.modal);
  f.input("z");
  assert.deepEqual(f.paint(), maximized);
  f.input(ENTER);
  assert.equal(f.resize.modal, false);
  assert.deepEqual(f.paint(), maximized);

  for (const cancel of [ESC, F2]) {
    f.input(F2);
    f.input("z");
    assert.deepEqual(f.paint(), before);
    assert.ok(f.resize.modal);
    f.input("l");
    assert.deepEqual(f.paint(), expand(before, 1, 0));
    f.input(cancel);
    assert.equal(f.resize.modal, false);
    assert.deepEqual(f.paint(), maximized, "cancel reinstates the original maximized state");
  }
  f.input(F2);
  f.input("z");
  f.input(ENTER);
  assert.equal(f.resize.modal, false);
  assert.deepEqual(f.paint(), before, "committing restore returns to the original normal size");
  assert.deepEqual(f.bodyInput, []);
  assert.equal(f.dismissals(), 0);
});
