import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Direct source import: this regression must not depend on a build.
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailActionsMenu } = await jiti.import(
  "../../src/orchestration/ui/detail-actions-menu.ts",
);

const plain = { fg: (_color, text) => text, bold: (text) => text };
const ansi = {
  fg: (color, text) =>
    `\x1b[${color === "accent" ? 36 : color === "muted" ? 2 : 34}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
/** A theme that paints with visible CJK-width decoration, not zero-width ANSI. */
const cjk = { fg: (_color, text) => `「${text}」`, bold: (text) => text };

const menu = (overrides = {}) =>
  renderDetailActionsMenu({
    width: 40,
    height: 6,
    info: false,
    toolsExpanded: false,
    theme: plain,
    ...overrides,
  });

const stripped = (rows) => rows.map((row) => stripTerminalSequences(row));
const label = (out, index) => {
  const item = out.items[index];
  return stripped(out.rows)[item.y].slice(item.from, item.to);
};

test("menu is undefined below or at the minimum viewport and for invalid dimensions", () => {
  for (const width of [0, 1, 7, 15, -3, Number.NaN, Number.POSITIVE_INFINITY, 15.9])
    assert.equal(menu({ width }), undefined, `width ${width}`);
  for (const height of [0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.9])
    assert.equal(menu({ height }), undefined, `height ${height}`);
  for (const width of [undefined, null, "40", Number("x")])
    assert.equal(menu({ width }), undefined, `non-number width ${String(width)}`);
  // Fractional viewports floor to whole cells: 16.9 cells is 16.
  assert.ok(menu({ width: 16.9 }), "16.9 floors to a usable 16");
  assert.equal(menu({ width: 15.9 }), undefined, "15.9 floors to an unusable 15");
});

test("sizes 1..200: every row spans the viewport and every item stays inside it", () => {
  for (let width = 1; width <= 200; width++) {
    const out = menu({ width });
    if (width < 16) {
      assert.equal(out, undefined, `width ${width}`);
      continue;
    }
    assert.equal(out.rows.length, 4, `width ${width} keeps the compact box`);
    for (const row of out.rows) assert.equal(visibleWidth(row), width, `width ${width}`);
    assert.deepEqual(
      out.items.map((item) => item.kind),
      ["info", "tools"],
      `width ${width}`,
    );
    for (const item of out.items) {
      assert.ok(item.from >= 0 && item.from < item.to && item.to <= width, `width ${width}`);
      const cells = stripped(out.rows)[item.y].slice(item.from, item.to);
      assert.ok(cells.length > 0 && !cells.includes("│"), `width ${width} targets only text`);
    }
    // Everything left of the popup edge is pure padding a caller may skip.
    assert.ok(out.from >= 0 && out.from < width, `width ${width}`);
    for (const row of stripped(out.rows))
      assert.match(row.slice(0, out.from), /^ *$/, `width ${width} keeps left cells blank`);
    // Keyboard discoverability is part of the contract at every width.
    assert.match(label(out, 0), /^(Info( \+\d+)?|Transcript)( \[I\]| {2}I)$/, `width ${width}`);
    assert.match(
      label(out, 1),
      /^(Expand tools|Collapse tools|Tools)( \[T\]| {2}T)$/,
      `width ${width}`,
    );
  }
  for (let height = 1; height <= 200; height++) {
    const out = menu({ height });
    if (height < 2) {
      assert.equal(out, undefined, `height ${height}`);
      continue;
    }
    assert.equal(out.rows.length, height >= 4 ? 4 : 2, `height ${height}`);
    for (const row of out.rows) assert.equal(visibleWidth(row), 40, `height ${height}`);
    assert.deepEqual(
      out.items.map((item) => item.y),
      height >= 4 ? [1, 2] : [0, 1],
      `height ${height}`,
    );
  }
});

test("sizes 1..200: click ranges slice exactly to the painted labels and hints", () => {
  for (let width = 16; width <= 200; width++) {
    const out = menu({ width, height: 2 });
    assert.equal(label(out, 0), "Info [I]", `width ${width}`);
    // `Expand tools [T]` is exactly 16 cells, so the borderless floor keeps
    // the bracketed hint; only the longer Collapse state ever degrades.
    assert.equal(label(out, 1), "Expand tools [T]", `width ${width}`);
  }
});

test("every option carries a visible shortcut hint, bracketed when it fits", () => {
  assert.equal(label(menu({}), 0), "Info [I]");
  assert.equal(label(menu({}), 1), "Expand tools [T]");
  assert.equal(label(menu({ info: true }), 0), "Transcript [I]");
  assert.equal(label(menu({ toolsExpanded: true }), 1), "Collapse tools [T]");
  // Ladder of whole-word narrowing as the box shrinks; no ellipsis ever.
  for (const [width, expected] of [
    [16, "Tools [T]"],
    [17, "Tools [T]"],
    [18, "Tools [T]"],
    [19, "Expand tools  T"],
    [20, "Expand tools [T]"],
    [21, "Expand tools [T]"],
    [22, "Expand tools [T]"],
  ])
    assert.equal(label(menu({ width }), 1), expected, `tools option at width ${width}`);
  assert.ok(
    !stripped(menu({ width: 16 }).rows)
      .join("")
      .includes("…"),
    "no ellipsis at the floor",
  );
  // The longer Collapse state narrows later: 17 cells for the plain hint.
  for (const [width, expected] of [
    [16, "Tools [T]"],
    [19, "Tools [T]"],
    [20, "Tools [T]"],
    [21, "Collapse tools  T"],
    [22, "Collapse tools [T]"],
  ])
    assert.equal(
      label(menu({ width, toolsExpanded: true }), 1),
      expected,
      `collapse option at width ${width}`,
    );
});

test("Info and Transcript swap by page, and the tools label follows its state", () => {
  const transcript = menu({ info: true });
  assert.equal(transcript.items[0].kind, "transcript");
  assert.equal(label(transcript, 0), "Transcript [I]");
  const info = menu({});
  assert.equal(info.items[0].kind, "info");
  assert.equal(label(info, 0), "Info [I]");
  assert.equal(label(info, 1), "Expand tools [T]");
  assert.equal(label(menu({ toolsExpanded: true }), 1), "Collapse tools [T]");
});

test("attention diagnostics ride Info as +N and are dropped whole when they cannot fit", () => {
  assert.equal(label(menu({ hiddenNotes: 5 }), 0), "Info +5 [I]");
  // The Transcript row never carries the count.
  assert.equal(menu({ info: true, hiddenNotes: 5 }).items[0].kind, "transcript");
  // The count survives hint degradation before it goes whole: at 12 inner
  // cells `Info +5  I` still fits when the bracket does not.
  assert.equal(label(menu({ width: 16, hiddenNotes: 5 }), 0), "Info +5 [I]");
  // A count that does not fit disappears whole: never a partial `+1` fact,
  // and the shortcut hint always survives it.
  // Box mode bounds options to 12 inner cells at this width, borderless to 16.
  for (const [height, counts] of [
    [4, [1e9, 1e10, Number.MAX_SAFE_INTEGER]],
    [2, [1e10, Number.MAX_SAFE_INTEGER]],
  ])
    for (const hiddenNotes of counts) {
      const out = menu({ width: 16, height, hiddenNotes });
      assert.ok(!stripped(out.rows).join("").includes("+"), `+${hiddenNotes} drops whole`);
      assert.equal(label(out, 0), "Info [I]", `count dropped, hint kept (${height})`);
    }
  const fraction = menu({ hiddenNotes: 0.9 });
  assert.ok(fraction, "a fraction of a note is no note");
  assert.equal(fraction.items[0].kind, "info");
  assert.ok(!stripped(fraction.rows).join("").includes("+"), "no count renders for a fraction");
});

test("the selected row paints accent and bold; the other stays muted", () => {
  for (const selected of [0, 1]) {
    const out = menu({ theme: ansi, selected });
    const active = out.rows[selected === 0 ? 1 : 2];
    const idle = out.rows[selected === 0 ? 2 : 1];
    assert.ok(active.includes("\x1b[1m\x1b[36m"), `selected ${selected} is accent and bold`);
    assert.ok(!active.includes("\x1b[2m"), `selected ${selected} is not muted`);
    assert.ok(idle.includes("\x1b[2m"), `unselected row of ${selected} is muted`);
    assert.ok(!idle.includes("\x1b[1m"), `unselected row of ${selected} is not bold`);
    assert.equal(visibleWidth(out.rows[1]), 40, "styling never widens a row");
  }
  assert.deepEqual(menu({ selected: 7 }), menu({ selected: 0 }), "unknown selection defaults");
  assert.deepEqual(menu({}), menu({ selected: 0 }), "selection defaults to the first row");
});

test("the menu anchors at the right edge with padding and borders never targeted", () => {
  const out = menu({ width: 60 });
  const rows = stripped(out.rows);
  // The box hugs its widest hinted option: `Expand tools [T]` plus frame.
  assert.equal(rows[0], `${" ".repeat(40)}╭${"─".repeat(18)}╮`);
  assert.equal(rows[3], `${" ".repeat(40)}╰${"─".repeat(18)}╯`);
  assert.ok(rows[1].startsWith(" ".repeat(40)), "the box hugs the right edge");
  assert.equal(rows[1].trimEnd().endsWith("│"), true, "the box closes at the viewport edge");
  for (const item of out.items) {
    assert.equal(item.from, 42, "options start inside the border and pad");
    assert.ok(rows[item.y][item.from - 1] === " " && rows[item.y][item.to] === " ");
    assert.equal(rows[item.y][item.from - 2], "│", "the border itself never targets");
  }
  const bare = menu({ width: 60, height: 2 });
  assert.equal(stripped(bare.rows)[0].endsWith("Info [I]"), true, "borderless rows hug right");
  assert.equal(bare.items[0].to, 60, "the option ends flush at the viewport edge");
});

test("from reports the popup's left edge so callers can overlay only from there", () => {
  // Boxed: the box's left border column.
  const boxed = menu({ width: 60 });
  assert.equal(boxed.from, 40);
  assert.equal(stripped(boxed.rows)[0][boxed.from], "╭");
  assert.equal(stripped(boxed.rows)[2].slice(boxed.from, 42), "│ ");
  // Borderless: the leftmost option start across both rows.
  const bare = menu({ width: 40, height: 2 });
  assert.equal(bare.from, Math.min(bare.items[0].from, bare.items[1].from));
  assert.equal(bare.from, 40 - visibleWidth("Expand tools [T]"));
  assert.equal(stripped(bare.rows)[0].slice(0, bare.from), " ".repeat(bare.from));
  // At the floor the capped box spans the whole viewport, so its left edge
  // is column 0 even though the option text starts inside at column 2.
  const floor = menu({ width: 16 });
  assert.equal(floor.from, 0);
  assert.equal(stripped(floor.rows)[2][2], "T");
});

test("the width floor keeps a readable Tools option beside its hint", () => {
  // 16 columns cap the box at 12 inner cells; the action words drop whole
  // instead of clipping, and the T hint stays visible.
  for (const toolsExpanded of [false, true]) {
    const out = menu({ width: 16, toolsExpanded });
    assert.equal(visibleWidth(out.rows[0]), 16);
    assert.equal(label(out, 1), "Tools [T]");
    assert.equal(out.items[1].to, 11, "the option ends before the inner pad and border");
  }
});

test("metrics stay cell-based through real ANSI and CJK-width decoration", () => {
  const styled = menu({ theme: ansi, hiddenNotes: 3, selected: 1 });
  for (const row of styled.rows) assert.equal(visibleWidth(row), 40, "ANSI is zero-width");
  assert.equal(label(styled, 0), "Info +3 [I]", "ranges are terminal columns, not indices");
  // A theme that paints visible wide glyphs keeps borderless rows exact and
  // ranges pointing at the painted option, because padding follows cells.
  const decorated = menu({ theme: cjk, height: 2, selected: 0 });
  assert.equal(visibleWidth(decorated.rows[0]), 40);
  assert.equal(visibleWidth(decorated.rows[1]), 40);
  assert.equal(
    stripped(decorated.rows)[0].slice(decorated.items[0].from, decorated.items[0].to),
    "「Info [I]」",
  );
  assert.doesNotThrow(() => menu({ theme: cjk }), "wide decoration never crashes the box");
});
