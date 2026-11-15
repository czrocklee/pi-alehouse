import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  borderLabelsEnabled,
  onBorderLabelsChange,
  popoverChromeCloseHit,
  popoverChromeLayout,
  popoverInlay,
  popoverInlayWidth,
  popoverInsetLabelRows,
  popoverLabelRows,
  popoverTitleRows,
  setBorderLabelsEnabled,
} from "../../src/shared/popover-chrome.mjs";
import { popoverCloseHit, popoverRule, popoverTitleRow } from "../../src/shared/popover-frame.mjs";

const inlayMetrics = {
  clip: (text, columns) => truncateToWidth(text, columns),
  width: visibleWidth,
};
const titleMetrics = {
  clip: (text, columns) => truncateToWidth(text, columns, "…"),
  width: visibleWidth,
};
const theme = { fg: (_color, text) => text, bold: (text) => text };
const ansi = {
  fg: (color, text) =>
    `\x1b[${color === "accent" ? 36 : color === "borderAccent" ? 34 : 2}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

const original = borderLabelsEnabled();
afterEach(() => setBorderLabelsEnabled(original));

test("border labels default to enabled and validate the setter", () => {
  assert.equal(borderLabelsEnabled(), true);
  setBorderLabelsEnabled(false);
  assert.equal(borderLabelsEnabled(), false);
  setBorderLabelsEnabled(true);
  assert.equal(borderLabelsEnabled(), true);
  assert.throws(() => setBorderLabelsEnabled("yes"), TypeError);
  assert.throws(() => setBorderLabelsEnabled(1), TypeError);
  assert.throws(() => setBorderLabelsEnabled(null), TypeError);
  assert.equal(borderLabelsEnabled(), true);
});

test("setBorderLabelsEnabled notifies only real changes and isolates observer failures", (t) => {
  const calls = [];
  const offA = onBorderLabelsChange(() => calls.push("a"));
  const offThrow = onBorderLabelsChange(() => {
    throw new Error("boom");
  });
  const offB = onBorderLabelsChange(() => calls.push("b"));
  t.after(() => {
    offA();
    offThrow();
    offB();
  });
  setBorderLabelsEnabled(true);
  assert.deepEqual(calls, []);
  setBorderLabelsEnabled(false);
  assert.deepEqual(calls, ["a", "b"]);
  offA();
  offA();
  offThrow();
  offB();
  setBorderLabelsEnabled(true);
  assert.deepEqual(calls, ["a", "b"]);
});

test("onBorderLabelsChange validates listeners and disposes idempotently", () => {
  assert.throws(() => onBorderLabelsChange("nope"), TypeError);
  let calls = 0;
  const off = onBorderLabelsChange(() => {
    calls += 1;
  });
  off();
  off();
  setBorderLabelsEnabled(false);
  assert.equal(calls, 0);
});

test("cross-bundle state shares the versioned global symbol", async () => {
  const other = await import(
    new URL("../../src/shared/popover-chrome.mjs?bundle=2", import.meta.url).href
  );
  assert.equal(typeof globalThis[Symbol.for("pi-alehouse:border-labels:v1")], "object");
  setBorderLabelsEnabled(false);
  assert.equal(other.borderLabelsEnabled(), false);
  other.setBorderLabelsEnabled(true);
  assert.equal(borderLabelsEnabled(), true);
});

test("popoverChromeLayout defaults to unframed plain chrome", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(popoverChromeLayout(), {
    top: { placement: "plain", rows: 1, labelY: 0 },
    bottom: { placement: "plain", rows: 1, labelY: 0 },
    rows: 2,
    bodyY: 1,
    footerFromBottom: 1,
  });
});

test("popoverChromeLayout follows the global switch for framed chrome", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(popoverChromeLayout({ framed: true }), {
    top: { placement: "border", rows: 1, labelY: 0 },
    bottom: { placement: "border", rows: 1, labelY: 0 },
    rows: 2,
    bodyY: 1,
    footerFromBottom: 1,
  });
  setBorderLabelsEnabled(false);
  assert.deepEqual(popoverChromeLayout({ framed: true }), {
    top: { placement: "inside", rows: 3, labelY: 1 },
    bottom: { placement: "inside", rows: 3, labelY: 1 },
    rows: 6,
    bodyY: 3,
    footerFromBottom: 2,
  });
});

test("popoverChromeLayout ignores unexpected borderLabels overrides", () => {
  // JavaScript callers can still pass the retired option; the shared switch
  // must remain the only placement authority.
  setBorderLabelsEnabled(false);
  assert.equal(popoverChromeLayout({ framed: true, borderLabels: true }).top.placement, "inside");
  setBorderLabelsEnabled(true);
  assert.equal(popoverChromeLayout({ framed: true, borderLabels: false }).top.placement, "border");
});

test("popoverChromeLayout bands count independently", () => {
  setBorderLabelsEnabled(false);
  const layout = popoverChromeLayout({ framed: true });
  assert.equal(layout.rows, layout.top.rows + layout.bottom.rows);
  assert.equal(layout.bodyY, layout.top.rows);
  assert.equal(layout.footerFromBottom, layout.bottom.rows - layout.bottom.labelY);
  assert.equal(layout.top.rows, 3);
  assert.equal(layout.bottom.rows, 3);
});

test("popoverChromeCloseHit moves the shared hit's row with the global switch", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(popoverChromeCloseHit(40), { x: 36, y: 0, width: 1 });
  assert.deepEqual(popoverChromeCloseHit(9), { x: 5, y: 0, width: 1 });
  assert.equal(popoverChromeCloseHit(8), undefined);
  setBorderLabelsEnabled(false);
  assert.deepEqual(popoverChromeCloseHit(40), { x: 36, y: 1, width: 1 });
  assert.deepEqual(popoverChromeCloseHit(9), { x: 5, y: 1, width: 1 });
  assert.equal(popoverChromeCloseHit(8), undefined);
});

test("popoverChromeCloseHit normalizes nonfinite and narrow widths", () => {
  for (const width of [NaN, Infinity, -Infinity, -5, 0, 8])
    assert.equal(popoverChromeCloseHit(width), undefined);
  assert.deepEqual(popoverChromeCloseHit(9), { x: 5, y: 0, width: 1 });
  assert.deepEqual(popoverChromeCloseHit(9.9), { x: 5, y: 0, width: 1 });
});

test("popoverInlayWidth keeps the legacy capacity and closable bound", () => {
  assert.equal(popoverInlayWidth(40, "top", true), 32);
  assert.equal(popoverInlayWidth(40, "top", false), 34);
  assert.equal(popoverInlayWidth(40, "bottom", true), 34);
  assert.equal(popoverInlayWidth(9, "top", true), 1);
  assert.equal(popoverInlayWidth(8, "top", true), 2);
  assert.equal(popoverInlayWidth(0, "top", false), 0);
  assert.equal(popoverInlayWidth(-5, "top", false), 0);
});

test("popoverInlayWidth normalizes nonfinite, negative and fractional widths", () => {
  for (const width of [NaN, Infinity, -Infinity, -5, -0.5])
    assert.equal(popoverInlayWidth(width, "top", false), 0);
  assert.equal(popoverInlayWidth(5, "top", false), 0);
  assert.equal(popoverInlayWidth(6, "top", false), 0);
  assert.equal(popoverInlayWidth(7, "top", false), 1);
  assert.equal(popoverInlayWidth(8, "top", false), 2);
  assert.equal(popoverInlayWidth(9, "top", false), 3);
  assert.equal(popoverInlayWidth(8.9, "top", false), 2);
  assert.equal(popoverInlayWidth(9.9, "top", true), 1);
});

test("popoverInlay keeps the legacy border geometry and close tail", () => {
  const bottom = popoverInlay(theme, 40, "footer", "bottom", inlayMetrics);
  assert.equal(bottom, "╰─ footer " + "─".repeat(29) + "╯");
  assert.equal(visibleWidth(bottom), 40);

  const top = popoverInlay(theme, 40, "title", "top", inlayMetrics, true);
  assert.equal(top, "╭─ title " + "─".repeat(26) + " ✕ ─╮");
  assert.equal(visibleWidth(top), 40);

  const flushStart = popoverInlay(theme, 40, "title", "top", inlayMetrics, true, false, {
    start: true,
  });
  assert.equal(flushStart, "╭──title " + "─".repeat(26) + " ✕ ─╮");

  const flushEnd = popoverInlay(theme, 40, "footer", "bottom", inlayMetrics, false, false, {
    end: true,
  });
  assert.equal(flushEnd, "╰─ footer" + "─".repeat(30) + "╯");

  const both = popoverInlay(theme, 40, "footer", "bottom", inlayMetrics, false, false, {
    start: true,
    end: true,
  });
  assert.equal(both, "╰──footer" + "─".repeat(30) + "╯");
});

test("popoverInlay degrades to a bare rule below six columns", () => {
  for (const width of [0, 1, 2, 3, 4, 5])
    for (const kind of ["top", "bottom"]) {
      const row = popoverInlay(theme, width, "title", kind, inlayMetrics, true, true, {
        start: true,
        end: true,
      });
      assert.equal(row, popoverRule(theme, width, kind));
      assert.equal(visibleWidth(row), width);
    }
  // Six and seven columns still fit the legacy inlay chrome.
  assert.equal(popoverInlay(theme, 6, "x", "top", inlayMetrics), "╭─  ─╮");
  assert.equal(popoverInlay(theme, 7, "x", "top", inlayMetrics), "╭─ x ─╮");
  assert.equal(visibleWidth(popoverInlay(theme, 6, "x", "top", inlayMetrics)), 6);
});

test("popoverInlay normalizes nonfinite geometry instead of overflowing", () => {
  for (const width of [NaN, Infinity, -Infinity, -5])
    for (const kind of ["top", "bottom"]) {
      const row = popoverInlay(theme, width, "title", kind, inlayMetrics, true, true, {
        start: true,
      });
      assert.equal(row, popoverRule(theme, 0, kind));
      assert.equal(visibleWidth(row), 0);
    }
});

test("popoverInlay keeps legacy bytes at supported eight-plus widths", () => {
  const expected = [
    [8, "╭─ x ──╮"],
    [9, "╭─ x ───╮"],
    [10, "╭─ x ────╮"],
    [11, "╭─ x ─────╮"],
    [12, "╭─ x ──────╮"],
  ];
  for (const [width, row] of expected) {
    assert.equal(popoverInlay(theme, width, "x", "top", inlayMetrics), row);
    assert.equal(visibleWidth(row), width);
  }
  assert.equal(popoverInlay(theme, 9, "x", "top", inlayMetrics, true), "╭─ x ✕ ─╮");
});

test("popoverInlay bounds long and wide labels without overflow", () => {
  for (const width of [9, 14, 24, 40, 80])
    for (const label of ["x".repeat(200), "标题".repeat(40), ""]) {
      const row = popoverInlay(theme, width, label, "top", inlayMetrics, true);
      assert.equal(visibleWidth(row), width);
      assert.ok(stripTerminalSequences(row).endsWith(" ✕ ─╮"));
    }
});

const labels = [
  "Stats",
  "用量 · 👩‍💻",
  "a very long label that must be clipped",
  "\x1b[31mred\x1b[39m",
];

for (const [name, th] of [
  ["plain", theme],
  ["ANSI", ansi],
])
  for (const kind of ["top", "bottom"])
    test(`inset label rows preserve width and chrome: ${name}/${kind}`, () => {
      for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 64])
        for (const label of labels)
          for (const closable of [false, true]) {
            const rows = popoverInsetLabelRows(th, width, label, kind, titleMetrics, { closable });
            assert.equal(rows.length, 3);
            assert.equal(rows[0], popoverRule(th, width, kind === "top" ? "top" : "divider"));
            assert.equal(rows[2], popoverRule(th, width, kind === "top" ? "divider" : "bottom"));
            for (const row of rows) assert.equal(visibleWidth(row), width);
            const body = stripTerminalSequences(rows[1]);
            if (width === 0) {
              assert.equal(body, "");
              continue;
            }
            assert.equal(body[0], "│");
            assert.equal(body[body.length - 1], "│");
            if (width >= 7) assert.ok(body.startsWith("│  "));
            const close = kind === "top" && closable && popoverCloseHit(width);
            if (close) {
              const index = body.indexOf("✕");
              assert.ok(index >= 0);
              assert.equal(visibleWidth(body.slice(0, index)), width - 4);
              assert.equal(close.x, width - 4);
              assert.ok(body.endsWith("✕  │"));
              assert.ok(!body.includes("─"));
            } else {
              assert.ok(!body.includes("✕"));
              if (width >= 7) assert.ok(body.endsWith("  │"));
            }
          }
    });

test("inset label rows degrade to blank bodies at tiny widths", () => {
  for (const [width, expected] of [
    [0, ""],
    [1, "│"],
    [2, "││"],
    [3, "│ │"],
    [4, "│  │"],
    [5, "│   │"],
    [6, "│    │"],
  ]) {
    const rows = popoverInsetLabelRows(theme, width, "Stats", "top", titleMetrics, {
      closable: true,
    });
    assert.equal(stripTerminalSequences(rows[1]), expected);
    assert.equal(visibleWidth(rows[1]), width);
  }
});

test("inset label rows reject nonfinite geometry without overflow", () => {
  for (const width of [NaN, Infinity, -Infinity, -5]) {
    const rows = popoverInsetLabelRows(theme, width, "Stats", "top", titleMetrics, {
      closable: true,
    });
    assert.deepEqual(rows, ["", "", ""]);
  }
});

test("inset label starts at the shared inlay column", () => {
  for (const width of [24, 64])
    for (const closable of [false, true]) {
      const rows = popoverInsetLabelRows(theme, width, "Stats", "top", titleMetrics, { closable });
      const body = stripTerminalSequences(rows[1]);
      assert.ok(body.startsWith("│  Stats"));
      assert.equal(body.indexOf("Stats"), 3);
    }
});

test("close glyph keeps the shared x and moves to the inset row", () => {
  for (const width of [9, 10, 11, 24, 64]) {
    const rows = popoverInsetLabelRows(theme, width, "Stats", "top", titleMetrics, {
      closable: true,
    });
    const body = stripTerminalSequences(rows[1]);
    const index = body.indexOf("✕");
    assert.equal(index, width - 4);
    assert.equal(popoverCloseHit(width).x, index);
    setBorderLabelsEnabled(false);
    assert.deepEqual(popoverChromeCloseHit(width), { x: index, y: 1, width: 1 });
    setBorderLabelsEnabled(true);
    assert.deepEqual(popoverChromeCloseHit(width), { x: index, y: 0, width: 1 });
  }
});

test("bottom inset rows never draw the close glyph", () => {
  for (const width of [9, 24, 64]) {
    const rows = popoverInsetLabelRows(theme, width, "Stats", "bottom", titleMetrics, {
      closable: true,
    });
    assert.ok(!stripTerminalSequences(rows[1]).includes("✕"));
  }
});

test("close hover changes only glyph emphasis in the inset row", () => {
  for (const width of [9, 10, 24, 64]) {
    const idle = popoverInsetLabelRows(ansi, width, "Stats", "top", titleMetrics, {
      closable: true,
    });
    const hovered = popoverInsetLabelRows(ansi, width, "Stats", "top", titleMetrics, {
      closable: true,
      closeHovered: true,
    });
    assert.equal(stripTerminalSequences(hovered[1]), stripTerminalSequences(idle[1]));
    assert.equal(visibleWidth(hovered[1]), width);
    assert.notEqual(hovered[1], idle[1]);
    assert.ok(idle[1].includes("\x1b[2m✕\x1b[39m"));
    assert.ok(hovered[1].includes("\x1b[36m\x1b[1m✕\x1b[22m\x1b[39m"));
  }
  const idle = popoverInsetLabelRows(theme, 24, "Stats", "top", titleMetrics, { closable: true });
  const hovered = popoverInsetLabelRows(theme, 24, "Stats", "top", titleMetrics, {
    closable: true,
    closeHovered: true,
  });
  assert.deepEqual(hovered, idle);
});

test("popoverLabelRows uses the legacy inlay on and the inset band off", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(
    popoverLabelRows(theme, 40, "footer", "bottom", inlayMetrics, { closable: false }),
    [popoverInlay(theme, 40, "footer", "bottom", inlayMetrics, false, false, {})],
  );
  assert.deepEqual(
    popoverLabelRows(theme, 40, "title", "top", inlayMetrics, {
      closable: true,
      closeHovered: true,
      flush: { start: true },
    }),
    [popoverInlay(theme, 40, "title", "top", inlayMetrics, true, true, { start: true })],
  );
  setBorderLabelsEnabled(false);
  assert.deepEqual(
    popoverLabelRows(theme, 40, "footer", "bottom", inlayMetrics, { closable: false }),
    popoverInsetLabelRows(theme, 40, "footer", "bottom", inlayMetrics, {
      closable: false,
      closeHovered: false,
    }),
  );
  assert.deepEqual(
    popoverLabelRows(theme, 40, "title", "top", inlayMetrics, {
      closable: true,
      flush: { start: true },
    }),
    popoverInsetLabelRows(theme, 40, "title", "top", inlayMetrics, {
      closable: true,
      closeHovered: false,
    }),
  );
});

test("popoverTitleRows uses the title primitive on and the inset band off", () => {
  setBorderLabelsEnabled(true);
  assert.deepEqual(popoverTitleRows(theme, 40, "Stats", titleMetrics, true, false), [
    popoverTitleRow(theme, 40, "Stats", titleMetrics, true, false),
  ]);
  setBorderLabelsEnabled(false);
  assert.deepEqual(
    popoverTitleRows(theme, 40, "Stats", titleMetrics, true, false),
    popoverInsetLabelRows(theme, 40, theme.fg("accent", theme.bold("Stats")), "top", titleMetrics, {
      closable: true,
      closeHovered: false,
    }),
  );
});

test("popoverTitleRows keeps the close glyph on the border or the inset row", () => {
  for (const width of [9, 24, 64]) {
    setBorderLabelsEnabled(true);
    const on = popoverTitleRows(theme, width, "Stats", titleMetrics, true, false);
    assert.equal(on.length, 1);
    assert.equal(stripTerminalSequences(on[0]).indexOf("✕"), width - 4);
    assert.deepEqual(popoverChromeCloseHit(width), { x: width - 4, y: 0, width: 1 });
    setBorderLabelsEnabled(false);
    const off = popoverTitleRows(theme, width, "Stats", titleMetrics, true, false);
    assert.equal(off.length, 3);
    assert.equal(stripTerminalSequences(off[1]).indexOf("✕"), width - 4);
    assert.deepEqual(popoverChromeCloseHit(width), { x: width - 4, y: 1, width: 1 });
  }
});

test("popoverTitleRows bounds every row at the requested width", () => {
  for (const global of [true, false]) {
    setBorderLabelsEnabled(global);
    for (const width of [0, 1, 8, 9, 24, 64])
      for (const closable of [false, true]) {
        const rows = popoverTitleRows(theme, width, "Stats", titleMetrics, closable, false);
        for (const row of rows) assert.equal(visibleWidth(row), width);
      }
  }
});

test("popoverTitleRows normalizes nonfinite geometry in both modes", () => {
  for (const global of [true, false]) {
    setBorderLabelsEnabled(global);
    for (const width of [NaN, Infinity, -Infinity, -5]) {
      const rows = popoverTitleRows(theme, width, "Stats", titleMetrics, true, false);
      for (const row of rows) assert.equal(visibleWidth(row), 0);
    }
  }
});

test("popoverLabelRows normalizes nonfinite geometry in both modes", () => {
  for (const global of [true, false]) {
    setBorderLabelsEnabled(global);
    for (const width of [NaN, Infinity, -Infinity, -5]) {
      const rows = popoverLabelRows(theme, width, "Stats", "top", inlayMetrics, {
        closable: true,
      });
      for (const row of rows) assert.equal(visibleWidth(row), 0);
    }
  }
});

test("popoverLabelRows bounds both modes across zero through twelve", () => {
  for (const global of [true, false]) {
    setBorderLabelsEnabled(global);
    for (let width = 0; width <= 12; width++)
      for (const kind of ["top", "bottom"])
        for (const closable of [false, true]) {
          const rows = popoverLabelRows(theme, width, "Stats", kind, inlayMetrics, {
            closable,
          });
          for (const row of rows) assert.equal(visibleWidth(row), width);
        }
  }
});
