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
    // Keyboard discoverability is part of the contract at every width. The
    // mnemonic lives inside the label, so no bracket keycap or trailing repeat.
    assert.match(label(out, 0), /^(Info( \+\d+)?|Transcript)$/, `width ${width}`);
    assert.match(label(out, 1), /^(Expand tools|Collapse tools|Tools)$/, `width ${width}`);
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

test("sizes 1..200: click ranges slice exactly to the painted labels", () => {
  for (let width = 16; width <= 200; width++) {
    const out = menu({ width, height: 2 });
    assert.equal(label(out, 0), "Info", `width ${width}`);
    // `Expand tools` is exactly 12 cells, so the borderless floor keeps the
    // full label; only the longer Collapse state ever degrades at 16.
    assert.equal(label(out, 1), "Expand tools", `width ${width}`);
  }
});

test("every option paints its mnemonic inline, without brackets or a repeat", () => {
  assert.equal(label(menu({}), 0), "Info");
  assert.equal(label(menu({}), 1), "Expand tools");
  assert.equal(label(menu({ info: true }), 0), "Transcript");
  assert.equal(label(menu({ toolsExpanded: true }), 1), "Collapse tools");
  // Inline hints add no columns, so the full labels survive the box floor.
  for (const [width, expected] of [
    [16, "Expand tools"],
    [17, "Expand tools"],
    [18, "Expand tools"],
    [19, "Expand tools"],
    [20, "Expand tools"],
    [22, "Expand tools"],
  ])
    assert.equal(label(menu({ width }), 1), expected, `tools option at width ${width}`);
  assert.ok(
    !stripped(menu({ width: 16 }).rows)
      .join("")
      .includes("…"),
    "no ellipsis at the floor",
  );
  // The longer Collapse state needs 14 inner cells; below that it drops to
  // the whole-word `Tools` label rather than clipping.
  for (const [width, expected] of [
    [16, "Tools"],
    [17, "Tools"],
    [18, "Collapse tools"],
    [19, "Collapse tools"],
    [20, "Collapse tools"],
    [22, "Collapse tools"],
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
  assert.equal(label(transcript, 0), "Transcript");
  const info = menu({});
  assert.equal(info.items[0].kind, "info");
  assert.equal(label(info, 0), "Info");
  assert.equal(label(info, 1), "Expand tools");
  assert.equal(label(menu({ toolsExpanded: true }), 1), "Collapse tools");
});

test("attention diagnostics ride Info as +N and are dropped whole when they cannot fit", () => {
  assert.equal(label(menu({ hiddenNotes: 5 }), 0), "Info +5");
  // The Transcript row never carries the count.
  assert.equal(menu({ info: true, hiddenNotes: 5 }).items[0].kind, "transcript");
  // The count survives the box floor while the inline hint keeps its cells.
  assert.equal(label(menu({ width: 16, hiddenNotes: 5 }), 0), "Info +5");
  // A count that does not fit disappears whole: never a partial `+1` fact,
  // and the mnemonic always survives it.
  for (const [height, counts] of [
    [4, [1e9, 1e10, Number.MAX_SAFE_INTEGER]],
    [2, [1e10, Number.MAX_SAFE_INTEGER]],
  ])
    for (const hiddenNotes of counts) {
      const out = menu({ width: 16, height, hiddenNotes });
      assert.ok(!stripped(out.rows).join("").includes("+"), `+${hiddenNotes} drops whole`);
      assert.equal(label(out, 0), "Info", `count dropped, hint kept (${height})`);
    }
  const fraction = menu({ hiddenNotes: 0.9 });
  assert.ok(fraction, "a fraction of a note is no note");
  assert.equal(fraction.items[0].kind, "info");
  assert.ok(!stripped(fraction.rows).join("").includes("+"), "no count renders for a fraction");
});

test("the selected row paints accent and bold; the other keeps a muted body with an accented key", () => {
  for (const selected of [0, 1]) {
    const out = menu({ theme: ansi, selected });
    const active = out.rows[selected === 0 ? 1 : 2];
    const idle = out.rows[selected === 0 ? 2 : 1];
    assert.ok(active.includes("\x1b[1m\x1b[36m"), `selected ${selected} is accent and bold`);
    assert.ok(!active.includes("\x1b[2m"), `selected ${selected} is not muted`);
    assert.ok(idle.includes("\x1b[2m"), `unselected row of ${selected} is muted`);
    assert.ok(
      idle.includes("\x1b[36m\x1b[1m") || idle.includes("\x1b[1m\x1b[36m"),
      `unselected row of ${selected} keeps its mnemonic accented and bold`,
    );
    assert.equal(visibleWidth(out.rows[1]), 40, "styling never widens a row");
  }
  assert.deepEqual(menu({ selected: 7 }), menu({ selected: 0 }), "unknown selection defaults");
  assert.deepEqual(menu({}), menu({ selected: 0 }), "selection defaults to the first row");
});

test("the selected row keeps its mnemonic identifiable when underline is available", () => {
  const underline = {
    ...ansi,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
  };
  const out = menu({ theme: underline, selected: 0 });
  assert.ok(out.rows[1].includes("\x1b[4mI\x1b[24m"), "selected mnemonic is underlined");
  assert.ok(!out.rows[2].includes("\x1b[4m"), "unselected row stays un-underlined");
});

test("the menu anchors at the right edge with padding and borders never targeted", () => {
  const out = menu({ width: 60 });
  const rows = stripped(out.rows);
  // The box hugs its widest hinted option: `Expand tools` plus frame.
  assert.equal(rows[0], `${" ".repeat(44)}╭${"─".repeat(14)}╮`);
  assert.equal(rows[3], `${" ".repeat(44)}╰${"─".repeat(14)}╯`);
  assert.ok(rows[1].startsWith(" ".repeat(44)), "the box hugs the right edge");
  assert.equal(rows[1].trimEnd().endsWith("│"), true, "the box closes at the viewport edge");
  for (const item of out.items) {
    assert.equal(item.from, 46, "options start inside the border and pad");
    assert.ok(rows[item.y][item.from - 1] === " " && rows[item.y][item.to] === " ");
    assert.equal(rows[item.y][item.from - 2], "│", "the border itself never targets");
  }
  const bare = menu({ width: 60, height: 2 });
  assert.equal(stripped(bare.rows)[0].endsWith("Info"), true, "borderless rows hug right");
  assert.equal(bare.items[0].to, 60, "the option ends flush at the viewport edge");
});

test("from reports the popup's left edge so callers can overlay only from there", () => {
  // Boxed: the box's left border column.
  const boxed = menu({ width: 60 });
  assert.equal(boxed.from, 44);
  assert.equal(stripped(boxed.rows)[0][boxed.from], "╭");
  assert.equal(stripped(boxed.rows)[2].slice(boxed.from, 46), "│ ");
  // Borderless: the leftmost option start across both rows.
  const bare = menu({ width: 40, height: 2 });
  assert.equal(bare.from, Math.min(bare.items[0].from, bare.items[1].from));
  assert.equal(bare.from, 40 - visibleWidth("Expand tools"));
  assert.equal(stripped(bare.rows)[0].slice(0, bare.from), " ".repeat(bare.from));
  // At the floor the capped box spans the whole viewport, so its left edge
  // is column 0 even though the option text starts inside at column 2.
  const floor = menu({ width: 16 });
  assert.equal(floor.from, 0);
  assert.equal(stripped(floor.rows)[2][2], "E");
});

test("the width floor keeps a readable Tools option beside its mnemonic", () => {
  // 16 columns cap the box at 12 inner cells; `Expand tools` fits whole,
  // while the longer Collapse state drops to `Tools` instead of clipping.
  for (const [toolsExpanded, expected, to] of [
    [false, "Expand tools", 14],
    [true, "Tools", 7],
  ]) {
    const out = menu({ width: 16, toolsExpanded });
    assert.equal(visibleWidth(out.rows[0]), 16);
    assert.equal(label(out, 1), expected);
    assert.equal(out.items[1].to, to, "the option ends before the inner pad and border");
  }
});

test("metrics stay cell-based through real ANSI and CJK-width decoration", () => {
  const styled = menu({ theme: ansi, hiddenNotes: 3, selected: 1 });
  for (const row of styled.rows) assert.equal(visibleWidth(row), 40, "ANSI is zero-width");
  assert.equal(label(styled, 0), "Info +3", "ranges are terminal columns, not indices");
  // A theme that paints visible wide glyphs keeps borderless rows exact and
  // ranges pointing at the painted option, because padding follows cells.
  const decorated = menu({ theme: cjk, height: 2, hiddenNotes: 3, selected: 0 });
  assert.equal(visibleWidth(decorated.rows[0]), 40);
  assert.equal(visibleWidth(decorated.rows[1]), 40);
  assert.equal(label(decorated, 0), "「I」「nfo +3」");
  assert.equal(label(decorated, 1), "「Expand 」「t」「ools」");
  assert.doesNotThrow(() => menu({ theme: cjk }), "wide decoration never crashes the box");
});
