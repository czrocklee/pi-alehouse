/**
 * Unit regressions for the final styled-row display filter
 * `safeStyledRow(text)` (src/orchestration/ui/styled-row.ts).
 *
 * Source-only through jiti (`fsCache: false`), never a stale dist build. The
 * paneRow wiring that calls this leaf lives in format.ts with the parent;
 * these tests cover only the leaf's own contract:
 *
 * - trusted theme SGR (reset, truecolor, `:` subparameters) and complete
 *   OSC 8 hyperlinks (BEL and ST terminated) survive verbatim, and C1
 *   spellings of those same display commands are canonicalized to ESC form;
 * - every other complete or unterminated string protocol (OSC 133, OSC 52,
 *   titles, APC/DCS/SOS/PM, both ESC and C1 spellings) and its payload is
 *   gone, including payloads that merely look like safe SGR/OSC 8;
 * - non-SGR CSI (clear, cursor moves, private/malformed parameters) drops
 *   without leaking partial parameters from an unterminated body;
 * - a lone ESC and every remaining C0/C1/DEL byte stay visible as `\xNN`,
 *   bidi controls as `\uXXXX`, and ordinary Unicode (CJK, emoji, ZWJ/ZWNJ,
 *   variation selectors, combining marks) stays verbatim;
 * - output is bounded (6x the input, the widest escape).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { safeStyledRow } = await jiti.import("../../src/orchestration/ui/styled-row.ts");

test("trusted theme SGR survives verbatim", () => {
  const rows = [
    "\x1b[31mred\x1b[0m",
    "\x1b[38;2;255;0;0mtruecolor\x1b[0m plain",
    "\x1b[38:2::255:0:0mcolon-subparameters\x1b[m",
    "\x1b[1;4;91mstyled\x1b[0m tail",
    "\x1b[m",
    "no escape sequences at all",
  ];
  for (const row of rows) assert.equal(safeStyledRow(row), row);
});

test("OSC 8 hyperlinks survive verbatim (BEL and ST)", () => {
  const rows = [
    "\x1b]8;;https://example.com\x07Example\x1b]8;;\x07",
    "\x1b]8;id=42;https://example.com\x1b\\Example\x1b]8;;\x1b\\",
    "plain \x1b]8;;https://example.com\x07link\x1b]8;;\x07 text",
  ];
  for (const row of rows) assert.equal(safeStyledRow(row), row);
});

test("allowed SGR semantics include conceal, not a visibility guarantee", () => {
  const row = "\x1b[8mconcealed\x1b[0m";
  assert.equal(safeStyledRow(row), row);
});

test("preserved OSC 8 payloads may contain Unicode bidi, unlike ordinary row text", () => {
  const link = "\x1b]8;id=\u2066;https://example.com/\u202e\x07label\x1b]8;;\x07";
  assert.equal(safeStyledRow(link), link);
  assert.equal(safeStyledRow("outside\u2066\u202e"), "outside\\u2066\\u202e");
});

test("OSC 133 turn markers disappear", () => {
  assert.equal(safeStyledRow("\x1b]133;A\x07prompt\x1b]133;B\x1b\\"), "prompt");
  assert.equal(safeStyledRow("\x1b]133;C\x1b\\"), "");
});

test("OSC 52 clipboard writes and their payload disappear", () => {
  assert.equal(safeStyledRow("\x1b]52;c;c2VjcmV0\x07"), "");
  assert.equal(safeStyledRow("before\x1b]52;c;c2VjcmV0\x1b\\after"), "beforeafter");
  assert.ok(!safeStyledRow("x\x1b]52;c;c2VjcmV0\x07y").includes("c2VjcmV0"));
  assert.equal(safeStyledRow("\x1b]0;window title\x07gone"), "gone");
});

test("non-SGR CSI drops: clear, cursor moves, invalid parameters", () => {
  assert.equal(safeStyledRow("\x1b[2J\x1b[H\x1b[?25lleftover"), "leftover");
  assert.equal(safeStyledRow("keep\x1b[1;2Hdrop"), "keepdrop");
  assert.equal(safeStyledRow("\x1b[?1049h"), "");
  // A final `m` with non-SGR parameters is still not display SGR.
  assert.equal(safeStyledRow("\x1b[>1m"), "");
});

test("unterminated CSI never leaks partial parameters", () => {
  assert.equal(safeStyledRow("pre\x1b[31"), "pre");
  assert.equal(safeStyledRow("pre\x1b[31\npost"), "pre\\x0apost");
  assert.equal(safeStyledRow("\u009b31"), "");
});

test("C1 spellings: SGR canonicalizes, other protocols drop", () => {
  assert.equal(safeStyledRow("\u009b31mred"), "\x1b[31mred");
  assert.equal(safeStyledRow("\u009b38;2;0;255;0mgreen"), "\x1b[38;2;0;255;0mgreen");
  assert.equal(safeStyledRow("\u009b2Jclear"), "clear");
  assert.equal(safeStyledRow("\u009b?25lhide"), "hide");
  assert.equal(safeStyledRow("\u009d0;title\u009c"), "");
  assert.equal(safeStyledRow("\u009d52;c;c2VjcmV0\u009c"), "");
  assert.equal(safeStyledRow("\u0090DCS-payload\u009c"), "");
  assert.equal(safeStyledRow("\u0098SOS-payload\u009c"), "");
  assert.equal(safeStyledRow("\u009ePM-payload\u009c"), "");
  assert.equal(safeStyledRow("\u009fAPC-payload\u009c"), "");
});

test("C1 OSC 8 canonicalizes to the ESC spelling with an ST terminator", () => {
  assert.equal(
    safeStyledRow("\u009d8;;https://example.com\u009clink\u009d8;;\u009c"),
    "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
  );
  // An ESC-spelled OSC 8 with a C1 ST terminator is canonicalized too.
  assert.equal(
    safeStyledRow("\x1b]8;;https://example.com\u009clink"),
    "\x1b]8;;https://example.com\x1b\\link",
  );
});

test("leftover C1 controls stay visible and inert", () => {
  assert.equal(safeStyledRow("a\u0085b"), "a\\x85b");
  assert.equal(safeStyledRow("x\u009c"), "x\\x9c"); // C1 ST outside any protocol
});

test("unterminated protocols die with the rest of the row", () => {
  assert.equal(safeStyledRow("\x1b]52;c;never-terminated"), "");
  assert.equal(safeStyledRow("visible\x1b]8;;https://x"), "visible");
  assert.equal(safeStyledRow("\x1b_apc-payload"), "");
  assert.equal(safeStyledRow("\x1b]8;;https://x\x1b"), "");
});

test("safe-looking sequences inside unsafe payloads never escape", () => {
  // Fake SGR inside a complete OSC 52 payload:
  assert.equal(safeStyledRow("\x1b]52;c;evil\x1b[31m\x07"), "");
  // Fake SGR inside an unterminated payload:
  assert.equal(safeStyledRow("\x1b]52;c;evil\x1b[31m"), "");
  // Fake SGR inside an APC body terminated by C1 ST:
  assert.equal(safeStyledRow("\x1b_P\x1b[31m\u009c"), "");
  // BEL inside APC/DCS/SOS/PM is payload, not a terminator:
  assert.equal(safeStyledRow("\x1b_bel-is-payload\x1b\\"), "");
  // A fake hyperlink inside a dropped OSC payload:
  assert.equal(safeStyledRow("\x1b]52;c;\x1b]8;;https://evil\x07tail"), "tail");
});

test("unknown, malformed or control-carrying OSC 8 drops its payload", () => {
  assert.equal(safeStyledRow("\x1b]8;no-uri\x07"), "");
  assert.equal(safeStyledRow("\x1b]9;other\x07"), "");
  assert.equal(safeStyledRow("\x1b]8;id\x01;https://x\x07"), ""); // control in params
  assert.equal(safeStyledRow("\x1b]8;;https://x\x0b\x07"), ""); // control in URI
  assert.equal(safeStyledRow("\x1b]8;;https://x\n\x07"), "");
});

test("controls stay visible escaped, never executable", () => {
  assert.equal(safeStyledRow("a\tb\rc\nd"), "a\\x09b\\x0dc\\x0ad");
  assert.equal(safeStyledRow("x\x00\x7fy"), "x\\x00\\x7fy");
  assert.equal(safeStyledRow("a\x1b"), "a\\x1b"); // lone ESC at row end
  assert.equal(safeStyledRow("a\x1b\nb"), "a\\x1b\\x0ab"); // ESC + control
  assert.equal(safeStyledRow("a\x1b\x1b[31mb"), "a\\x1b\x1b[31mb"); // ESC ESC
  assert.equal(safeStyledRow("\x1b(Btext"), "text"); // complete charset sequence
  assert.equal(safeStyledRow("pre\x1b("), "pre\\x1b("); // never-completed one
  assert.equal(safeStyledRow("\x1b7\x1b8kept"), "kept"); // cursor save/restore
});

test("bidi controls stay visible as \\uXXXX", () => {
  assert.equal(safeStyledRow("a\u202eb\u061c"), "a\\u202eb\\u061c");
  assert.equal(safeStyledRow("\u2066isolated\u2069"), "\\u2066isolated\\u2069");
});

test("ordinary Unicode stays verbatim: CJK, emoji, joiners, selectors", () => {
  const rows = [
    "你好，世界",
    "family 👨‍👩‍👧‍👦 emoji",
    "e\u0301 combining ❤️ variation",
    "zero-width ‌‍ joiners",
    "\u00a0nbsp is not a control",
  ];
  for (const row of rows) assert.equal(safeStyledRow(row), row);
});

test("multiple protocols in one row filter independently", () => {
  const row =
    "\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b]52;c;steal\x07\x1b[2J tail \u009b1mbold";
  assert.equal(
    safeStyledRow(row),
    "\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07  tail \x1b[1mbold",
  );
});

test("output stays bounded at 6x the input", () => {
  const bidi = "\u202e".repeat(5000);
  assert.equal(safeStyledRow(bidi).length, bidi.length * 6);
  const mixed =
    "\x1b[31mtext\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07 你好\t\n".repeat(5000);
  const filtered = safeStyledRow(mixed);
  assert.ok(filtered.length <= mixed.length * 6);
  assert.ok(filtered.includes("link\x1b]8;;\x07 你好"));
});

test("empty and control-only rows", () => {
  assert.equal(safeStyledRow(""), "");
  assert.equal(safeStyledRow("\x00\x01\x02"), "\\x00\\x01\\x02");
});
