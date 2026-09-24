import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { POPOVER, isPopoverCloseClick, popoverBottom, popoverCloseHit, popoverDivider, popoverInlay, popoverInlayWidth,
  popoverRow, popoverSide, popoverTitle } from "../../dist/ui/popover.js";

const record = () => {
  const colors = [];
  const theme = { fg: (color, text) => { colors.push(color); return text; }, bold: (text) => text };
  return { colors, theme };
};

test("popover chrome is a rounded accent frame with muted sides", () => {
  const { colors, theme } = record();
  const top = popoverTitle(theme, 24, "Worker routing");
  assert.match(top, new RegExp(`^${POPOVER.tl}${POPOVER.h}`));
  assert.match(top, new RegExp(`${POPOVER.tr}$`));
  assert.ok(top.includes(" Worker routing "));
  assert.deepEqual([...new Set(colors)], ["borderAccent", "accent"]);
  assert.equal(visibleWidth(top), 24);

  colors.length = 0;
  const row = popoverRow(theme, " hello", 10);
  assert.equal(row[0], POPOVER.v);
  assert.equal(row.at(-1), POPOVER.v);
  assert.equal(colors[0], "borderMuted");
  assert.equal(visibleWidth(row), 12);

  colors.length = 0;
  const divider = popoverDivider(theme, 24);
  assert.match(divider, new RegExp(`^${POPOVER.ml}${POPOVER.h}+${POPOVER.mr}$`));
  assert.deepEqual(colors, ["borderMuted"]);

  colors.length = 0;
  const bottom = popoverBottom(theme, 24);
  assert.match(bottom, new RegExp(`^${POPOVER.bl}${POPOVER.h}+${POPOVER.br}$`));
  assert.deepEqual(colors, ["borderAccent"]);
  assert.equal(popoverSide(theme), POPOVER.v);
});

test("an inlaid edge keeps the same outer colors and never leaves the box open", () => {
  const { colors, theme } = record();
  for (const width of [20, 40, 80]) {
    colors.length = 0;
    const top = popoverInlay(theme, width, "reviewer  ⠋ running", "top");
    const bottom = popoverInlay(theme, width, "1/1 agents", "bottom");
    assert.equal(visibleWidth(top), width);
    assert.equal(visibleWidth(bottom), width);
    assert.match(top, new RegExp(`^${POPOVER.tl}${POPOVER.h} `));
    assert.match(bottom, new RegExp(`^${POPOVER.bl}${POPOVER.h} `));
    assert.doesNotMatch(top, / {3}/);
    assert.doesNotMatch(bottom, / {3}/);
    assert.ok(colors.every((color) => color === "borderAccent"));
  }
});

test("a closable edge ends in ` × ─╮` exactly where the shared hit test looks", () => {
  const { theme } = record();
  for (const width of [9, 24, 80]) {
    const title = popoverTitle(theme, width, "Worker routing", true);
    const inlay = popoverInlay(theme, width, "reviewer", "top", true);
    for (const top of [title, inlay]) {
      assert.equal(visibleWidth(top), width, top);
      assert.ok(top.endsWith(` ${POPOVER.close} ${POPOVER.h}${POPOVER.tr}`), top);
      const x = visibleWidth(top.slice(0, top.indexOf(POPOVER.close)));
      assert.ok(isPopoverCloseClick({ type: "click", button: "left", x, y: 0 }, width));
    }
    assert.equal(visibleWidth(popoverInlay(theme, width, "x".repeat(200), "top", true)), width);
  }
  const click = (x, extra = {}) => isPopoverCloseClick({ type: "click", button: "left", x, y: 0, ...extra }, 24);
  assert.ok(click(19) && click(23), "the whole ` × ─╮` tail is the target");
  assert.ok(!click(18) && !click(24), "nothing outside the tail");
  assert.ok(!click(21, { y: 1 }) && !click(21, { button: "right" }) && !click(21, { type: "move" }));
  // Too narrow to carry the control: plain corner, and no invisible hit area.
  assert.equal(popoverCloseHit(8), undefined);
  for (const top of [popoverTitle(theme, 8, "Worker routing", true), popoverInlay(theme, 8, "reviewer", "top", true)]) {
    assert.equal(visibleWidth(top), 8, top);
    assert.ok(top.endsWith(POPOVER.tr) && !top.includes(POPOVER.close), top);
  }
  assert.ok(!isPopoverCloseClick({ type: "click", button: "left", x: 4, y: 0 }, 8));
  // Bottom edges never carry it, and opting out keeps the old edge.
  assert.ok(!popoverInlay(theme, 40, "footer", "bottom", true).includes(POPOVER.close));
  assert.ok(!popoverTitle(theme, 40, "Worker routing").includes(POPOVER.close));
  assert.equal(popoverInlayWidth(40, "top", true), 31);
  assert.equal(popoverInlayWidth(40, "top"), 34);
});
