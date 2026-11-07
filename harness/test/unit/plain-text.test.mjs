import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { plainText, singleLineText, wrapPlainText } from "../../dist/ui/text.js";
import {
  renderActivity,
  describeToolArgs,
  paneRow,
  shortPath,
  SPINNER,
  withoutBreaks,
} from "../../dist/ui/format.js";
import { runPresentation } from "../../dist/ui/run-presentation.js";

const protocols = [
  ["OSC8", "\x1b]8;;https://example.invalid\x1b\\X\x1b]8;;\x1b\\", "X"],
  ["OSC title BEL", "\x1b]0;title\x07X", "X"],
  ["OSC title ST", "\x1b]2;title\x1b\\X", "X"],
  ["OSC52", "\x1b]52;c;WA==\x07X", "X"],
  ["CSI erase/cursor", "\x1b[2J\x1b[10;10HX\x1b[1G\x1b[K", "X"],
  ["CSI conceal", "\x1b[8mX\x1b[0m", "X"],
  ["APC marker", "\x1b_pi:c\x07X", "X"],
  ["unsupported CSI", "\x1b[2AX", "\\x1b[2AX"],
  ["incomplete OSC", "\x1b]0;unfinished", "\\x1b]0;unfinished"],
  ["DCS", "\x1bPpayload\x1b\\X", "\\x1bPpayload\\x1b\\X"],
  ["C1 CSI", "\x9b2JX", "\\x9b2JX"],
  ["C1 OSC/ST", "\x9d52;c;WA==\x9cX", "\\x9d52;c;WA==\\x9cX"],
  ["C0/DEL/C1", "\x00\x08\x7f\x80\x9fX", "\\x00\\x08\\x7f\\x80\\x9fX"],
];

for (const [kind, input, expected] of protocols)
  test(`plain fields neutralize ${kind}`, () => {
    assert.equal(plainText(input), expected);
    assert.equal(singleLineText(input), expected);
    assert.deepEqual(wrapPlainText(input, 200), [expected]);
    assert(!/\p{Cc}/u.test(expected));
    assert.equal(plainText(expected), expected, "already-normalized fields stay stable");
  });

test("paragraph breaks and tabs stay readable rather than becoming hex escapes", () => {
  const input =
    "first\r\nsecond\rthird\u0085fourth\u2028fifth\u2029sixth\tword\vnext\fend\u00a0last";
  const paragraphs = "first\nsecond\nthird\nfourth\nfifth\nsixth word next end last";
  assert.equal(plainText(input), paragraphs);
  assert.equal(singleLineText(input), "first second third fourth fifth sixth word next end last");
  assert.deepEqual(wrapPlainText("first\n\nsecond\tword\n", 80), ["first", "", "second word", ""]);
  assert.equal(plainText("  indented\ttext  "), "  indented text  ");
});

test("only bidi controls are explicitly escaped, not every format character", () => {
  const bidi = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const cp of bidi) {
    const expected = `a\\u${cp.toString(16).padStart(4, "0")}b`;
    assert.equal(plainText(`a${String.fromCodePoint(cp)}b`), expected);
    assert.equal(singleLineText(`a${String.fromCodePoint(cp)}b`), expected);
  }
  for (const input of ["👩‍💻", "👨‍👩‍👧‍👦", "می‌روم", "♥️", "e\u0301", "漢字"]) {
    assert.equal(plainText(input), input);
    assert.equal(singleLineText(input), input);
    assert.deepEqual(wrapPlainText(input, visibleWidth(input)), [input]);
  }
});

test("word wrapping prefers latin spaces but keeps every grapheme indivisible", () => {
  assert.deepEqual(wrapPlainText("alpha beta gamma", 10), ["alpha beta", "gamma"]);
  assert.deepEqual(wrapPlainText("alpha beta", 8), ["alpha", "beta"]);
  assert.deepEqual(wrapPlainText("abcdef", 2), ["ab", "cd", "ef"]);
  assert.deepEqual(wrapPlainText("漢字測試", 4), ["漢字", "測試"]);
  assert.deepEqual(wrapPlainText("👩‍💻X", 2), ["👩‍💻", "X"]);
  assert.deepEqual(wrapPlainText("♥️X", 2), ["♥️", "X"]);
  assert.deepEqual(wrapPlainText("e\u0301X", 1), ["e\u0301", "X"]);
  assert.deepEqual(
    wrapPlainText("a \u0301b", 2),
    ["a \u0301", "b"],
    "a marked space is one grapheme too",
  );
  for (const input of ["👩‍💻X", "♥️X", "漢字X"]) {
    assert.deepEqual(wrapPlainText(input, 1), input === "漢字X" ? ["…", "…", "X"] : ["…", "X"]);
  }
});

test("whole-candidate wrapping stays bounded without phantom empty rows", () => {
  const samples = [
    "👩‍💻♥️e\u0301漢字",
    "می‌روم",
    "a".repeat(73) + " \u0301 " + "測".repeat(39) + "A測",
    "  alpha   beta gamma",
    "\u0301漢字",
    " \u0301".repeat(12),
  ];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const input of samples)
    for (const width of [1, 2, 3, 8, 40, 80]) {
      const rows = wrapPlainText(input, width);
      assert(rows.every((row) => visibleWidth(row) <= width));
      assert(rows.every((row) => row !== ""));
      const original = [...segmenter.segment(plainText(input))].map(({ segment }) => segment);
      const expected = original
        .map((part) => (visibleWidth(part) > width ? "…" : part))
        .filter((part) => part !== " ");
      const actual = rows
        .flatMap((row) => [...segmenter.segment(row)].map(({ segment }) => segment))
        .filter((part) => part !== " ");
      assert.deepEqual(actual, expected, "wrapping does not split or lose non-space graphemes");
    }
  for (const width of [0, -1, NaN, 0.5]) assert.deepEqual(wrapPlainText("X", width), []);
  assert.deepEqual(wrapPlainText("X\nY", Infinity), ["X", "Y"]);
  assert.deepEqual(wrapPlainText("", 2), [""]);
});

test("grapheme-width fast wrapping preserves the whole-candidate boundary contract", () => {
  // Deliberately unoptimized oracle: the prior whole-candidate algorithm.
  const reference = (text, width) =>
    plainText(text)
      .split("\n")
      .flatMap((paragraph) => {
        const out = [],
          segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        let line = [];
        const emit = (parts) => {
          let end = parts.length;
          while (end && parts[end - 1] === " ") end--;
          const row = parts.slice(0, end).join("");
          if (row) out.push(row);
        };
        for (const { segment } of segmenter.segment(paragraph)) {
          const cluster = visibleWidth(segment) > width ? "…" : segment;
          let separator = false;
          while (visibleWidth(line.join("") + cluster) > width) {
            if (cluster === " ") {
              emit(line);
              line = [];
              separator = true;
              break;
            }
            const space = line.findLastIndex((part) => part === " "),
              head = line.slice(0, space);
            if (space > 0 && head.some((part) => part !== " ")) {
              emit(head);
              line = line.slice(space + 1);
              while (line[0] === " ") line.shift();
            } else {
              emit(line);
              line = [];
            }
          }
          if (!separator) line.push(cluster);
        }
        if (line.length || !out.length) out.push(line.join(""));
        return out;
      });
  const samples = [
    "  alpha   beta  gamma ",
    "a \u0301b",
    "👩‍💻♥️e\u0301漢字",
    "🇺🇸🇨🇦🇫🇷🇯",
    "\u0600A\u0301\u200cBC",
    "\u0301漢字",
    "می‌روم",
    "क्‍ष กำ",
    "a\n\n👨‍👩‍👧‍👦\n",
    " \u0301".repeat(25),
    "A".repeat(150) + " \u0301 " + "測".repeat(70) + "Z",
  ];
  for (const sample of samples)
    for (const width of [1, 2, 3, 4, 7, 8, 40, 80, 200])
      assert.deepEqual(
        wrapPlainText(sample, width),
        reference(sample, width),
        `${JSON.stringify(sample)} @${width}`,
      );
});

test("tool arguments and paths are normalized before width and path decisions", () => {
  for (const [kind, input, expected] of protocols) {
    const argsFor = {
      read: { path: input },
      edit: { path: input },
      write: { path: input },
      ls: { path: input },
      bash: { command: input },
      grep: { pattern: input },
      find: { pattern: input },
      ask_parent: { question: input },
      alert_parent: { message: input },
      notify_parent: { message: input },
    };
    for (const [name, args] of Object.entries(argsFor)) {
      const original = structuredClone(args);
      const result = describeToolArgs(name, args, "/w", 200);
      assert.equal(
        result,
        name === "grep" || name === "find" ? `"${expected}"` : expected,
        `${kind}: ${name}`,
      );
      assert.deepEqual(args, original, "display normalization never changes tool inputs");
    }
    assert.equal(shortPath(`/w/${input}`, "/w", 200), expected);
  }
  assert.equal(shortPath("\x1b[8m/w\x1b[0m/src/file.ts", "\x1b[8m/w\x1b[0m", 72), "src/file.ts");
  assert.equal(
    describeToolArgs("bash", { command: "make\tcheck\r\n  --offline" }, "/w", 72),
    "make check --offline",
  );
  assert.equal(
    describeToolArgs("grep", { pattern: "x", glob: "\x1b]0;title\x07**/*.ts" }, "/w", 72),
    '"x" in **/*.ts',
  );
  assert.equal(shortPath("/w/a\u202eb.ts", "/w", 72), "a\\u202eb.ts");
});

test("production activity rendering sanitizes raw tools and suppresses complete or unfinished preview protocols", () => {
  const theme = { fg: (_color, text) => text };
  for (const [kind, input, expected] of protocols) {
    const preview = ["incomplete OSC", "APC marker"].includes(kind)
      ? ""
      : ["DCS", "C1 OSC/ST"].includes(kind)
        ? "X"
        : kind === "C0/DEL/C1"
          ? "\\x00\\x08\\x7f\\x80"
          : expected;
    assert.equal(
      renderActivity([], { preview: input, channel: "text" }, theme, 200),
      preview ? `replying: ${preview}` : "replying…",
    );
    assert.equal(
      renderActivity([{ name: "bash", detail: input }], { preview: "" }, theme, 200),
      `running ${expected}`,
    );
    assert.equal(renderActivity([{ name: input }], { preview: "" }, theme, 200), `${expected}…`);
    assert.equal(
      renderActivity(
        [{ name: input }, { name: input }, { name: input }],
        { preview: "" },
        theme,
        200,
      ),
      `${expected}…`,
    );
  }
  assert.equal(
    renderActivity([], { preview: "old\r\nnew\tline\n  ", channel: "text" }, theme, 200),
    "replying: new line",
  );
  assert.equal(
    renderActivity(
      [],
      { preview: "\x1b]0;hidden\nprotocol\x07visible", channel: "text" },
      theme,
      200,
    ),
    "replying: visible",
  );
  assert.equal(
    renderActivity([], { preview: "abc\u202etxt\u202c", channel: "text" }, theme, 200),
    "replying: abc\\u202etxt\\u202c",
  );
});

test("raw-field sanitizing does not strip subsequently applied theme/SDK styling", () => {
  const payload = "\x1b]52;c;WA==\x07";
  const theme = { fg: (_color, text) => `\x1b[33m${text}\x1b[0m` };
  const raw = `${payload}${"long ".repeat(30)}`;
  const argument = describeToolArgs("bash", { command: raw }, "/w", 12);
  assert(
    !argument.includes("\x1b"),
    "plain clipping removes even SDK-issued resets before styling",
  );
  assert(argument.endsWith("…"));
  assert(!argument.includes("]52;"));
  const styled = renderActivity([{ name: "bash", detail: argument }], { preview: "" }, theme, 72);
  assert(styled.startsWith("\x1b[33m"));
  assert(styled.endsWith("\x1b[0m"));
  assert(!styled.includes("]52;"));
  assert.equal(withoutBreaks(styled), styled, "styled row folding is not a sanitizer");
  const linked = "\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\";
  assert.equal(paneRow(linked, 80), linked, "SDK transcript hyperlink contract stays separate");
  assert.equal(stripTerminalSequences(styled), "running " + stripTerminalSequences(argument));
});

for (const [status, glyph, color, label, compact] of [
  ["queued", "◦", "muted", "queued", "queued"],
  ["running", SPINNER[2], "accent", "running", "run"],
  ["cancelling", SPINNER[2], "warning", "cancelling", "cancel"],
  ["completed", "✓", "success", "completed", "done"],
  ["needs_input", "?", "warning", "needs_input", "input"],
  ["failed", "✗", "error", "failed", "failed"],
  ["cancelled", "■", "dim", "cancelled", "cancel"],
])
  test(`shared Run presentation defaults: ${status}`, () => {
    assert.deepEqual(runPresentation(status, 2), { glyph, color, label, compact });
    if (status !== "running")
      assert.deepEqual(runPresentation(status, 2, true), runPresentation(status, 2));
  });

test("finishing is a running-only presentation and spinner frames stay defined", () => {
  assert.deepEqual(runPresentation("running", 2, true), {
    glyph: SPINNER[2],
    color: "dim",
    label: "finishing",
    compact: "finish",
  });
  assert.equal(runPresentation("running", SPINNER.length + 2).glyph, SPINNER[2]);
  for (const frame of [-1, NaN, Infinity])
    assert.equal(runPresentation("running", frame).glyph, SPINNER[0]);
  const first = runPresentation("completed");
  first.glyph = "changed locally";
  assert.equal(runPresentation("completed").glyph, "✓");
});
