import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
