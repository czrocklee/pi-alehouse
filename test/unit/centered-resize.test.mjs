import assert from "node:assert/strict";
import test from "node:test";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createCenteredResize } from "../../src/shared/centered-resize.mjs";
import { setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";
import { frameGlyphs } from "../../src/shared/popover-frame.mjs";

function panel({ independentAxes = false } = {}) {
  const terminal = { columns: 90, rows: 32 };
  const control = createCenteredResize(
    {
      terminal: () => terminal,
      minWidth: 30,
      minHeight: 8,
      independentAxes,
      theme: { fg: (_role, text) => text, bold: (text) => text },
      requestRender() {},
      changed() {},
    },
    {
      matchesKey: (a, b) => a === b,
      stripTerminalSequences,
      sliceByColumn,
      truncateToWidth,
      visibleWidth,
    },
  );
  function paint(w = control.width ?? 42, h = control.height ?? 14) {
    const edge = (a, fill, b) => a + fill.repeat(w - 2) + b;
    const g = frameGlyphs(control.edges);
    const lines = [
      `${g.tl}${g.top} Title ${g.top.repeat(w - 14)} ✕ ${g.top}${g.tr}`,
      ...Array(h - 2).fill(edge(g.left, " ", g.right)),
      edge(g.bl, g.bottom, g.br),
    ];
    lines[h - 1] = lines[h - 1].replace(g.bottom.repeat(5), " Stop");
    lines[3] = lines[3].slice(0, -1) + "┃";
    return control.paint(lines, w);
  }
  let capture;
  const mouse = (type, x, y, extra = {}) => {
    const event = { type, x, y, screenX: x + 20, screenY: y + 5, button: "left", ...extra };
    if (type === "press") {
      const result = control.mouse(event);
      capture = result?.target?.component;
      return result;
    }
    return capture && type !== "move" ? capture.handleMouse(event) : control.mouse(event);
  };
  return { terminal, control, paint, mouse, size: () => [control.width, control.height] };
}

test("only bare frame cells resize, in the direction of their edge", () => {
  for (const [x, y, sx, sy] of [
    [0, 2, -1, 0],
    [41, 2, 1, 0],
    [20, 0, 0, -1],
    [34, 0, 0, -1], // The old menu position is a bare border again.
    [20, 13, 0, 1],
    [0, 0, -1, -1],
    [41, 0, 1, -1],
    [0, 13, -1, 1],
    [41, 13, 1, 1],
  ]) {
    const f = panel();
    const out = f.paint();
    assert.match(out.at(-1), /╯$/);
    assert.equal(f.mouse("press", x, y)?.capture, true);
    const grabbed = { top: sy < 0, bottom: sy > 0, left: sx < 0, right: sx > 0 };
    assert.deepEqual(f.control.edges, grabbed);
    assert.equal(f.mouse("drag", x + 2, y + 2)?.handled, true);
    assert.deepEqual(f.size(), [42 + 4 * sx, 14 + 4 * sy]);
    assert.deepEqual(f.control.edges, grabbed);
    f.mouse("release", x, y, { button: "none" });
    assert.deepEqual(f.size(), [undefined, undefined], "returning to press restores auto sizing");
    assert.equal(f.control.edges, undefined);
  }
  const f = panel();
  const title = stripTerminalSequences(f.paint()[0]);
  assert.match(title, / □ ✕ ─╮$/u);
  assert.doesNotMatch(title, /≡/u);
  for (const [x, y] of [
    [4, 0],
    [2, 13],
    [1, 1],
    [41, 3],
    [38, 0],
  ]) {
    assert.equal(
      f.mouse("press", x, y),
      undefined,
      "title, footer label, body, thumb and close are not resize targets",
    );
  }
  assert.equal(f.mouse("press", 0, 0, { alt: true }), undefined);
  assert.equal(f.mouse("press", 0, 0, { width: 44 }), undefined);
  assert.equal(f.control.edges, undefined);
});

test("a held side uses the latest automatic height if live content reflows before motion", () => {
  const f = panel();
  f.paint();
  f.mouse("press", 41, 4);
  f.paint(42, 19);
  f.mouse("drag", 43, 4);
  assert.deepEqual(f.size(), [46, 19]);
  f.paint();
  f.mouse("release", 44, 4);
  assert.deepEqual(f.size(), [48, 19], "later motion still uses the press origin");
});

test("changing height leaves a terminal-wide automatic frame at its painted width", () => {
  const f = panel();
  f.terminal.columns = 40;
  f.paint(40);
  f.control.input("f2");
  f.control.input("j");
  assert.deepEqual(f.size(), [40, 16]);
  f.control.input("return");
  f.paint();
  f.mouse("press", 39, 2);
  f.mouse("release", 42, 2);
  assert.deepEqual(f.size(), [40, 16], "pulling an already flush edge out cannot shrink it");
});

test("modifier input cancels border emphasis without granting the stale capture a resize", () => {
  const f = panel();
  f.paint();
  assert.equal(f.mouse("press", 41, 13)?.capture, true);
  assert.ok(f.control.edges);
  assert.ok(f.mouse("drag", 43, 15, { shift: true })?.handled);
  assert.equal(f.control.edges, undefined);
  assert.ok(f.mouse("release", 43, 15)?.handled);
  assert.deepEqual(f.size(), [undefined, undefined]);
});

test("manual size survives maximize and terminal resize; blur rolls back a keyboard preview", () => {
  const f = panel();
  f.paint();
  f.mouse("press", 41, 13);
  f.mouse("release", 45, 15);
  assert.deepEqual(f.size(), [50, 18]);
  f.paint();
  assert.equal(f.control.input("f2"), true);
  assert.equal(f.control.input("z"), true);
  assert.equal(f.control.modal, true);
  assert.deepEqual(f.size(), [88, 30]);
  assert.equal(f.control.input("return"), true);
  assert.equal(f.control.modal, false);
  f.paint();
  f.control.input("f2");
  f.control.input("left");
  assert.deepEqual(f.size(), [86, 30]);
  f.control.reset();
  assert.equal(f.control.modal, false);
  assert.deepEqual(f.size(), [88, 30]);
  f.terminal.columns = 40;
  f.terminal.rows = 16;
  assert.deepEqual(f.size(), [38, 14]);
  f.paint();
  f.mouse("press", 32, 0);
  f.mouse("release", 32, 0);
  assert.deepEqual(f.size(), [38, 14]);
  f.terminal.rows = 32;
  f.paint();
  f.mouse("press", 20, 17);
  f.mouse("release", 20, 18); // Change height while the requested width is clamped.
  f.terminal.columns = 90;
  assert.deepEqual(f.size(), [50, 20]);
});

test("interrupted captures cannot become a click on the body; fresh input is unaffected", () => {
  const f = panel();
  f.paint();
  f.mouse("press", 41, 13);
  f.terminal.rows++;
  f.mouse("drag", 45, 15);
  f.terminal.rows--;
  f.paint();
  f.mouse("release", 45, 15);
  assert.deepEqual(f.size(), [undefined, undefined]);
  assert.ok(f.mouse("click", 20, 8)?.handled);
  assert.equal(f.mouse("press", 20, 8), undefined);
  f.mouse("press", 41, 13);
  f.mouse("release", 45, 15);
  f.paint();
  for (let i = 0; i < 2; i++)
    assert.equal(f.mouse("move", 20 + i, 8, { button: "none" }), undefined);
});

test("F2 enters resize directly, and Esc or F2 restores automatic sizing", () => {
  const f = panel();
  f.paint();
  for (const key of ["h", "j", "k", "l", "z"]) {
    assert.equal(f.control.input(key), false, `idle ${key} belongs to the panel`);
  }
  for (const finish of ["escape", "f2"]) {
    assert.equal(f.control.input("f2"), true);
    assert.equal(f.control.modal, true);
    assert.deepEqual(f.control.edges, { top: true, bottom: true, left: true, right: true });
    assert.match(stripTerminalSequences(f.paint()[0]), /\bResize\b/u);
    assert.equal(f.control.input("right"), true);
    assert.deepEqual(f.size(), [44, 14]);
    assert.equal(f.control.input("z"), true);
    assert.equal(f.control.modal, true);
    assert.deepEqual(f.size(), [88, 30]);
    assert.equal(f.control.input(finish), true);
    assert.equal(f.control.modal, false);
    assert.deepEqual(f.size(), [undefined, undefined], "cancel restores automatic sizing");
    assert.equal(f.control.edges, undefined);
    f.paint();
  }
});

test("a resize step immediately after unzoom uses the restored automatic dimensions", () => {
  const f = panel();
  f.paint();
  f.control.input("f2");
  f.control.input("z");
  f.paint();
  f.control.input("z");
  f.control.input("l");
  assert.deepEqual(f.size(), [44, 14]);
  f.control.input("escape");
  assert.deepEqual(f.size(), [undefined, undefined]);
});

test("independent axes unzoom to the latest partially automatic frame, even before repaint", () => {
  const f = panel({ independentAxes: true });
  f.paint();
  f.control.input("f2");
  f.control.input("l");
  f.control.input("return");
  assert.deepEqual(f.size(), [44, undefined]);
  f.paint(44, 23); // More content arrived at the new width.
  f.control.input("f2");
  f.control.input("z");
  f.paint();
  f.control.input("z");
  f.control.input("j");
  assert.deepEqual(f.size(), [44, 25]);
  f.control.input("escape");
  assert.deepEqual(f.size(), [44, undefined]);
});

test("independent axes claim only dimensions actually changed by a corner drag", () => {
  const f = panel({ independentAxes: true });
  f.paint(88, 14); // Already fills the permitted width.
  f.mouse("press", 87, 13);
  f.mouse("drag", 88, 15);
  assert.deepEqual(f.size(), [undefined, 18], "clamped horizontal motion cannot fix the width");
  f.mouse("drag", 86, 16);
  assert.deepEqual(f.size(), [86, 20]);
  f.mouse("release", 88, 13);
  assert.deepEqual(f.size(), [undefined, undefined], "both axes returned to the starting box");
});

test("a maximize press captured before F2 and Esc cannot resize on release", () => {
  const f = panel();
  f.paint();
  assert.ok(f.mouse("press", 36, 0)?.capture);
  f.control.input("f2");
  f.paint();
  f.control.input("escape");
  f.paint();
  assert.ok(f.mouse("release", 36, 0)?.handled);
  assert.equal(f.control.modal, false);
  assert.deepEqual(f.size(), [undefined, undefined]);
  assert.ok(f.mouse("press", 36, 0)?.capture);
  f.mouse("release", 36, 0);
  assert.deepEqual(f.size(), [88, 30], "a fresh maximize press still works");
});

test("compact terminals do not advertise an unusable maximize destination", () => {
  const f = panel();
  for (const [columns, rows, width, height] of [
    [31, 20, 31, 10],
    [80, 8, 42, 6],
  ]) {
    Object.assign(f.terminal, { columns, rows });
    assert.doesNotMatch(f.paint(width, height)[0], /[□≡]/u);
    assert.equal(f.control.input("f2"), false);
  }
});

test("controls stay aligned over wide labels, including inset chrome", () => {
  const f = panel();
  const w = 40;
  setBorderLabelsEnabled(false);
  try {
    const title = "│" + "字".repeat(17) + " ✕  │";
    const lines = ["╭" + "─".repeat(w - 2) + "╮", title, "╰" + "─".repeat(w - 2) + "╯"];
    const out = f.control.paint(lines, w);
    assert.equal(visibleWidth(out[1]), w);
    assert.doesNotMatch(stripTerminalSequences(out[1]), /≡/u);
    assert.equal(stripTerminalSequences(sliceByColumn(out[1], w - 7, 7)), " □ ✕  │");
    assert.equal(lines[1], title, "do not mutate Pi's cached lines");
    assert.ok(f.mouse("press", w - 6, 1)?.capture);
    f.mouse("release", w - 6, 1);
    assert.deepEqual(f.size(), [88, 30]);
  } finally {
    setBorderLabelsEnabled(true);
  }
});
