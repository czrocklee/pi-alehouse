import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import {
  borderLabelsEnabled,
  popoverChromeCloseHit,
  setBorderLabelsEnabled,
} from "../../src/shared/popover-chrome.mjs";
import { frameGlyphs, popoverRule, popoverSide } from "../../src/shared/popover-frame.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { popoverBottom, popoverInlay, popoverLabelRows, popoverRow, popoverTitleRows } =
  await jiti.import("../../src/orchestration/ui/popover.ts");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const ordinary = { top: false, bottom: false, left: false, right: false };
const edges = { ...ordinary, top: true, bottom: true, right: true };
const label = "─│╭╮╰╯─";
const styledLabel = `\x1b[4m${label}\x1b[24m`;

function usePlacement(t, onBorder) {
  const previous = borderLabelsEnabled();
  t.after(() => setBorderLabelsEnabled(previous));
  setBorderLabelsEnabled(onBorder);
}

test("glyph selection joins every corner to its two independently emphasized edges", () => {
  const keys = ["tl", "tr", "bl", "br", "top", "bottom", "left", "right", "ml", "mr"];
  const all = { top: true, bottom: true, left: true, right: true };
  for (const [mask, expected] of [
    [undefined, "╭╮╰╯──││├┤"],
    [ordinary, "╭╮╰╯──││├┤"],
    [{ ...ordinary, top: true }, "╒╕╰╯═─││├┤"],
    [{ ...ordinary, bottom: true }, "╭╮╘╛─═││├┤"],
    [{ ...ordinary, left: true }, "╓╮╙╯──║│╟┤"],
    [{ ...ordinary, right: true }, "╭╖╰╜──│║├╢"],
    [all, "╔╗╚╝══║║╟╢"],
  ]) {
    assert.deepEqual(
      frameGlyphs(mask),
      Object.fromEntries(keys.map((key, i) => [key, expected[i]])),
    );
  }
});

test("rules use themed one-cell glyphs and divider horizontals stay thin", () => {
  const styled = { fg: (role, text) => `${role}:${text}` };
  assert.equal(popoverRule(styled, 5, "top", edges), "borderAccent:╒═══╗");
  assert.equal(popoverRule(styled, 1, "top", edges), "borderAccent:═");
  assert.equal(popoverRule(styled, 0, "top", edges), "");
  assert.equal(popoverRule(styled, 5, "divider", edges), "borderMuted:├───╢");
  assert.equal(popoverRule(styled, 1, "divider", edges), "borderMuted:─");
  assert.equal(popoverSide(styled, edges), "borderMuted:│");
  assert.equal(popoverSide(styled, edges, "right"), "borderMuted:║");
  assert.equal(popoverBottom(theme, 5, edges), "╘═══╝");
});

test("border chrome emphasizes only its own edges, fills and flush pads", (t) => {
  usePlacement(t, true);
  const flush = { start: true, end: true };
  const footer = `╘══${styledLabel}══════╝`;
  assert.deepEqual(popoverLabelRows(theme, 17, styledLabel, "bottom", false, false, flush, edges), [
    footer,
  ]);
  assert.equal(
    popoverInlay(theme, 18, styledLabel, "top", true, false, flush, edges),
    `╒══${styledLabel} ══ ✕ ═╗`,
  );
  assert.equal(popoverInlay(theme, 5, styledLabel, "bottom", false, false, flush, edges), "╘═══╝");
  assert.deepEqual(popoverTitleRows(theme, 18, label, true, false, edges), [`╒═ ${label} ══ ✕ ═╗`]);
  assert.deepEqual(popoverTitleRows(theme, 2, label, true, false, edges), ["╒╗"]);
  assert.equal(popoverRow(theme, styledLabel, 9, edges), `│${styledLabel}  ║`);
});

test("inset chrome keeps arbitrary box drawing in labels and uses separate side glyphs", (t) => {
  usePlacement(t, false);
  assert.deepEqual(
    popoverLabelRows(theme, 17, styledLabel, "bottom", false, false, undefined, edges),
    [`├${"─".repeat(15)}╢`, `│  ${styledLabel}      ║`, `╘${"═".repeat(15)}╝`],
  );
  assert.deepEqual(popoverTitleRows(theme, 18, label, true, false, edges), [
    `╒${"═".repeat(16)}╗`,
    `│  ${label}    ✕  ║`,
    `├${"─".repeat(16)}╢`,
  ]);
  assert.deepEqual(popoverTitleRows(theme, 2, label, true, false, edges), ["╒╗", "│║", "├╢"]);
});

for (const onBorder of [true, false])
  test(`emphasis preserves widths and close hit geometry (${onBorder ? "border" : "inset"})`, (t) => {
    usePlacement(t, onBorder);
    for (let width = 0; width <= 24; width++) {
      const titles = popoverTitleRows(theme, width, label, true, true, edges);
      const inlays = popoverLabelRows(
        theme,
        width,
        styledLabel,
        "top",
        true,
        true,
        undefined,
        edges,
      );
      const hit = popoverChromeCloseHit(width);
      for (const rows of [titles, inlays]) {
        assert.equal(rows.length, onBorder ? 1 : 3);
        assert.ok(rows.every((row) => visibleWidth(row) === width));
        const row = stripTerminalSequences(rows[onBorder ? 0 : 1]);
        if (width >= 9) {
          assert.deepEqual(hit, { x: width - 4, y: onBorder ? 0 : 1, width: 1 });
          assert.equal(row.indexOf("✕"), hit.x);
        } else {
          assert.equal(hit, undefined);
          assert.ok(!row.includes("✕"));
        }
      }
    }
  });
