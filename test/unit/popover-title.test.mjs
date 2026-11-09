import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { popoverCloseHit, popoverTitleRow } from "../../src/shared/popover-frame.mjs";
import { popoverTitle } from "../../dist/orchestration/ui/popover.js";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const metrics = {
  clip: (text, columns) => truncateToWidth(text, columns, "…"),
  width: visibleWidth,
};

for (const width of [0, 1, 2, 3, 4, 8, 9, 12, 24, 64])
  for (const title of ["Stats", "用量 · 👩‍💻", "a very long title that must be clipped"])
    test(`shared title frame preserves width and close placement: ${width}/${title}`, () => {
      const row = popoverTitleRow(theme, width, title, metrics, true);
      assert.equal(row, popoverTitle(theme, width, title, true));
      // Exactly the requested width: narrow edges degrade instead of overflowing.
      assert.equal(visibleWidth(row), width);
      if (width >= 4) assert(row.startsWith("╭─"));
      const close = popoverCloseHit(width);
      if (close) {
        assert(row.endsWith(" × ─╮"));
        assert.equal(close.x, width - 5);
      } else assert(!row.includes("×"));
    });

test("close hover emphasizes only the glyph without changing text, width or hit columns", () => {
  const styled = {
    fg: (color, text) =>
      `\x1b[${color === "accent" ? 36 : color === "muted" ? 2 : 34}m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  for (const width of [0, 1, 8, 9, 24, 64]) {
    const idle = popoverTitleRow(styled, width, "用量 · 👩‍💻", metrics, true);
    const hovered = popoverTitleRow(styled, width, "用量 · 👩‍💻", metrics, true, true);
    assert.equal(stripTerminalSequences(hovered), stripTerminalSequences(idle));
    assert.equal(visibleWidth(hovered), width);
    if (popoverCloseHit(width)) {
      assert.notEqual(hovered, idle);
      assert(hovered.includes("\x1b[36m\x1b[1m×\x1b[22m\x1b[39m"));
      assert(idle.includes("\x1b[2m×\x1b[39m"));
    } else assert.equal(hovered, idle, "no hover for an absent close control");
  }
});
