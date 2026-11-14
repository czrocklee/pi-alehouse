/**
 * Source-focused regressions for paneRow's styled-ASCII fit short-circuit
 * (src/orchestration/ui/format.ts).
 *
 * paneRow filters one row through safeStyledRow and then fits it to a width.
 * The optimization under test returns the filtered row unchanged when the
 * width is positive, the filtered row is pure ASCII (no U+0080..U+FFFF
 * UTF-16 unit) and it already fits, skipping the SDK truncator's per-run
 * grapheme segmentation. The contract it must preserve for every input and
 * width is byte equality with the unoptimized pipeline:
 *
 *   paneRow(line, width) === truncateToWidth(safeStyledRow(line), width)
 *
 * including the ANSI-split emoji row whose global visible width fits while
 * the SDK truncator — which segments ANSI-delimited runs separately — still
 * truncates it. That row must stay on the SDK path and keep its exact bytes.
 *
 * Oracles are the SDK root public truncateToWidth/visibleWidth plus the
 * source safeStyledRow leaf (a filter oracle, not a reimplementation).
 * Everything is imported from the current source through jiti
 * (`fsCache: false`), never a possibly stale dist build, and the SDK comes
 * from the package root public export, not internals. The performance claim
 * is checked by counting Intl.Segmenter.prototype.segment calls, never by
 * wall-clock timing; all oracle values inside that test are computed before
 * the spy is installed so only paneRow's own work is counted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { paneRow } = await jiti.import("../../src/orchestration/ui/format.ts");
const { safeStyledRow } = await jiti.import("../../src/orchestration/ui/styled-row.ts");

/** The unoptimized pipeline: filter, then the SDK truncator. */
const oracle = (line, width) => truncateToWidth(safeStyledRow(line), width);

/** The core contract: paneRow keeps the unoptimized pipeline's exact bytes. */
const assertRowMatchesOracle = (line, width) => {
  const expected = oracle(line, width);
  assert.equal(
    paneRow(line, width),
    expected,
    `paneRow must match truncateToWidth(safeStyledRow(line), width) for ${JSON.stringify(
      line,
    )} @ ${width}`,
  );
  return expected;
};

test("fitting ASCII styled rows return the filtered row byte-for-byte", () => {
  const rows = [
    "\x1b[31mred\x1b[0m",
    "\x1b[38;2;255;0;0mtruecolor\x1b[0m plain tail",
    "\x1b[1;4;91mstyled\x1b[0m with a longer plain tail",
    "no escape sequences at all",
    "x",
    "",
  ];
  for (const row of rows) {
    assert.equal(paneRow(row, 40), safeStyledRow(row), "fit rows return the filtered row");
    assertRowMatchesOracle(row, 40);
  }
  // Exact fits: plain length === width, styled visible width === width.
  assert.equal(paneRow("abcde", 5), "abcde");
  assert.equal(paneRow("\x1b[31mabcde\x1b[0m", 5), "\x1b[31mabcde\x1b[0m");
  // A styled row longer than the width in bytes still fits by visible width.
  assert.equal(paneRow("\x1b[31mred\x1b[0m", 5), "\x1b[31mred\x1b[0m");
});

test("overflowing ASCII rows still truncate through the SDK", () => {
  const rows = ["abcdef", "\x1b[31mabcdef\x1b[0m", "plain text well past the width"];
  for (const row of rows) {
    const safe = safeStyledRow(row);
    for (const width of [1, 3, 5, 8]) {
      assertRowMatchesOracle(row, width);
      if (visibleWidth(safe) > width) {
        assert.notEqual(
          paneRow(row, width),
          safe,
          `an overflowing row must be truncated at width ${width}`,
        );
      } else {
        assert.equal(
          paneRow(row, width),
          safe,
          `a fitting row returns unchanged at width ${width}`,
        );
      }
    }
  }
  // SDK ellipsis semantics for printable ASCII overflow: keep width-3 visible
  // columns and add "..." (wrapped in the SDK's own reset codes, exact bytes
  // verified against the oracle above).
  const clipped = paneRow("abcdef", 5);
  assert.ok(clipped.startsWith("ab") && clipped.includes("..."));
});

test("SGR variants keep exact SDK bytes across fit and overflow", () => {
  const rows = [
    "\x1b[38;2;255;0;0mtruecolor text\x1b[0m",
    "\x1b[38:2::255:0:0mcolon subparameters\x1b[m",
    "\x1b[1;4;91mstyled\x1b[0m tail",
    "\x1b[m",
    "\x1b[31m\x1b[0m", // ANSI-only: zero visible columns
  ];
  for (const row of rows) {
    for (const width of [1, 3, 5, 8, 40]) assertRowMatchesOracle(row, width);
  }
  // ANSI-only rows carry zero visible columns, so every positive width fits.
  for (const width of [1, 3, 5, 40]) {
    assert.equal(paneRow("\x1b[31m\x1b[0m", width), "\x1b[31m\x1b[0m");
  }
});

test("OSC 8 hyperlinks: ASCII fit short-circuits, Unicode URI stays on the SDK path", () => {
  const bel = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
  const st = "\x1b]8;id=7;https://example.com\x1b\\link\x1b]8;;\x1b\\";
  const unicodeUri = "\x1b]8;;https://例え.jp\x07リンク\x1b]8;;\x07";
  for (const row of [bel, st, unicodeUri]) {
    for (const width of [5, 8, 40]) assertRowMatchesOracle(row, width);
  }
  assert.equal(paneRow(bel, 40), bel, "ASCII hyperlink fit returns the row unchanged");
  assert.equal(paneRow(st, 40), st, "ST-terminated hyperlink fit returns the row unchanged");
  assert.equal(paneRow(unicodeUri, 40), unicodeUri, "a fitting Unicode row is unchanged too");
});

test("C1 spellings canonicalize before the ASCII fit check", () => {
  const rows = [
    "\u009b31mred", // C1 CSI SGR -> ESC [ ... m
    "\u009b38;2;0;255;0mgreen",
    "\u009d8;;https://x\u009clink\u009d8;;\u009c", // C1 OSC 8 -> ESC spelling, ST terminators
  ];
  for (const row of rows) {
    const safe = safeStyledRow(row);
    assert.ok(safe.includes("\x1b"), "C1 display commands canonicalize to the ESC spelling");
    for (const width of [3, 5, 8, 40]) assertRowMatchesOracle(row, width);
    assert.equal(paneRow(row, 40), safe);
  }
});

test("dropped protocols and unfinished sequences leave plain ASCII that short-circuits", () => {
  const rows = [
    "before\x1b]52;c;c2VjcmV0\x07after",
    "\x1b]52;c;evil\x1b[31m\x07", // fake SGR inside a dropped payload
    "\x1b]133;A\x07prompt\x1b]133;B\x1b\\",
    "\x1b[2J\x1b[Hleftover",
    "\x1b[?25lhidden",
    "\x1b[>1m",
    "\x1b]52;c;never-terminated",
    "visible\x1b]8;;https://x",
    "\x1b_apc-payload",
  ];
  for (const row of rows) {
    const safe = safeStyledRow(row);
    for (const width of [1, 5, 40]) assertRowMatchesOracle(row, width);
    assert.equal(paneRow(row, 40), safe, "the filtered remainder fits and returns unchanged");
  }
});

test("escaped controls and bidi are ASCII after filtering and fit unchanged", () => {
  const rows = ["a\tb\rc\nd", "x\x00\x7fy", "a\x1b", "a\u202eb\u061c", "\u2066isolated\u2069"];
  for (const row of rows) {
    const safe = safeStyledRow(row);
    assert.ok(!/[\u0080-\uffff]/.test(safe), "controls and bidi are spelled as ASCII escapes");
    for (const width of [1, 3, 8, 40]) assertRowMatchesOracle(row, width);
    assert.equal(paneRow(row, 40), safe);
  }
});

test("Unicode rows keep the SDK path even when they fit", () => {
  const rows = [
    "你好，世界",
    "family 👨‍👩‍👧‍👦 emoji",
    "e\u0301 combining ❤️ variation",
    "\ud83d lone surrogate",
    "zero-width ‌‍ joiners",
  ];
  for (const row of rows) {
    for (const width of [1, 3, 5, 8, 40]) assertRowMatchesOracle(row, width);
    assert.equal(paneRow(row, 40), safeStyledRow(row), "a fitting Unicode row is still unchanged");
  }
});

test("an ANSI-split emoji cluster defeats a naive global-width fit check", () => {
  // The family cluster is split by SGR: the row's global visible width is 5
  // (strip the ANSI first and the ZWJ sequence rejoins into one cluster), but
  // the SDK truncator segments the ANSI-delimited runs separately, sees
  // 3 + 2 + 2 columns and truncates. paneRow must keep those exact SDK bytes
  // instead of trusting a global "it fits" measurement.
  const row = "abc👨\x1b[31m‍👩‍👧‍👦\x1b[0m";
  const safe = safeStyledRow(row);
  assert.equal(safe, row, "SGR survives the filter");
  assert.ok(visibleWidth(safe) <= 5, "the whole row fits by global visible width");
  for (const width of [5, 6]) {
    const expected = assertRowMatchesOracle(row, width);
    assert.notEqual(expected, safe, `the SDK truncates this row at width ${width}`);
  }
  assertRowMatchesOracle(row, 7);
  assert.equal(paneRow(row, 7), safe, "width 7 fits without truncation");
});

test("special widths keep the exact SDK contract", () => {
  const rows = [
    "plain row",
    "\x1b[31mred\x1b[0m",
    "你好",
    "abc👨\x1b[31m‍👩‍👧‍👦\x1b[0m",
    "\x1b[31m\x1b[0m",
  ];
  const widths = [0, -0, -3, -Infinity, NaN, Infinity, 0.5, 5.5];
  for (const row of rows) {
    for (const width of widths) assertRowMatchesOracle(row, width);
    for (const width of [0, -0, -3, -Infinity]) {
      assert.equal(paneRow(row, width), "", "non-positive widths clip to an empty row");
    }
  }
  // Fractional and infinite widths return a fitting styled row unchanged.
  assert.equal(paneRow("\x1b[31mred\x1b[0m", 5.5), "\x1b[31mred\x1b[0m");
  assert.equal(paneRow("\x1b[31mred\x1b[0m", Infinity), "\x1b[31mred\x1b[0m");
  assert.equal(paneRow("你好", Infinity), "你好");
});

test("fitting ASCII styled rows skip grapheme segmentation; real SDK paths still segment", (t) => {
  // Expected values come from the oracle BEFORE the spy exists, so the spy
  // counts only paneRow's own work. All widths stay above 3: the SDK's
  // ellipsis early-return path (ellipsisWidth >= maxWidth) never segments,
  // so a width of 3 or less could mask the difference between the
  // short-circuit and the real truncator path.
  const red = "\x1b[31mred\x1b[0m";
  const link = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
  const plain = "plain ascii row";
  const overflowing = `\x1b[31m${"x".repeat(50)}\x1b[0m`;
  const cjk = "你好，世界";
  const expectRed = oracle(red, 40);
  const expectLink = oracle(link, 40);
  const expectPlain = oracle(plain, 40);
  const expectOverflowing = oracle(overflowing, 20);
  const expectCjk = oracle(cjk, 40);

  const original = Intl.Segmenter.prototype.segment;
  let measured = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (text) {
    measured++;
    return original.call(this, text);
  });

  // Without the short-circuit the SDK truncator segments every ANSI-delimited
  // run of a styled row even when it fits, so zero calls here is the proof.
  assert.equal(paneRow(red, 40), expectRed);
  assert.equal(paneRow(link, 40), expectLink);
  assert.equal(paneRow(plain, 40), expectPlain);
  assert.equal(measured, 0, "fitting ASCII styled rows must not segment graphemes");

  // Counterfactual: an overflowing styled ASCII row really reaches the SDK's
  // grapheme loop, so the spy can see SDK segmentation when it happens.
  assert.equal(paneRow(overflowing, 20), expectOverflowing);
  const afterOverflow = measured;
  assert.ok(afterOverflow > 0, "an overflowing styled ASCII row still segments in the SDK");

  // Unicode rows keep the SDK path even when they fit.
  assert.equal(paneRow(cjk, 40), expectCjk);
  assert.ok(measured > afterOverflow, "a fitting CJK row still takes the SDK grapheme path");
});

test("mixed corpus: every paneRow result equals the SDK oracle", () => {
  // Small, bounded, deterministic: fixed fragment list, stride-based row
  // assembly, no randomness. 20 distinct composite rows crossed with all 10
  // widths give 200 genuinely distinct line/width pairs. (Indexing both the
  // row and the width by a single loop counter would have period 20 and just
  // repeat the same 20 pairs ten times.)
  const fragments = [
    "plain words",
    "punctuation !? and spaces",
    "\x1b[31mred\x1b[0m",
    "\x1b[38;2;255;0;0mtruecolor\x1b[0m",
    "\x1b[38:2::1:2:3mcolon\x1b[m",
    "\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
    "\x1b]8;;https://例え.jp\x07リンク\x1b]8;;\x07",
    "\x1b]52;c;c2VjcmV0\x07dropped",
    "\x1b[2J\x1b[Hcleared",
    "\u009b1mbold",
    "\u009d8;;https://x\u009clink\u009d8;;\u009c",
    "中文汉字",
    "👨‍👩‍👧‍👦 family",
    "e\u0301 combining",
    "\ud83d",
    "a\tb\rc\nd",
    "a\u202eb\u061c bidi",
    "\x1b]133;A\x07marker",
    "\x1b[?25lhidden",
    "x".repeat(30),
  ];
  const widths = [0, -1, 1, 3, 5, 8, 40, NaN, Infinity, 4.5];
  assert.equal(fragments.length, 20, "strides below are chosen against this length");
  const lines = [];
  for (let r = 0; r < fragments.length; r++) {
    lines.push(
      fragments[(r * 7 + 1) % fragments.length] +
        fragments[(r * 11 + 3) % fragments.length] +
        fragments[(r * 13 + 7) % fragments.length],
    );
  }
  assert.equal(new Set(lines).size, lines.length, "the 20 composite rows are distinct");
  const pairs = new Set();
  for (const line of lines) {
    for (const width of widths) {
      pairs.add(`${JSON.stringify(line)} @ ${width}`);
      assertRowMatchesOracle(line, width);
    }
  }
  assert.equal(pairs.size, 200, "the corpus covers 200 distinct line/width pairs");
});
