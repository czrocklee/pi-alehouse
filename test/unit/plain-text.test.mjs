import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { plainText, singleLineText, wrapPlainText } = await jiti.import(
  "../../src/orchestration/ui/text.ts",
);
const { renderActivity, describeToolArgs, paneRow, shortPath, SPINNER, withoutBreaks } =
  await jiti.import("../../src/orchestration/ui/format.ts");
const { runPresentation } = await jiti.import("../../src/orchestration/ui/run-presentation.ts");

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

test("a separator run consumed by a soft wrap cannot split the next word", () => {
  for (const [input, width, expected] of [
    ["a    abc", 3, ["a", "abc"]],
    ["abc    def", 3, ["abc", "def"]],
    ["é\t \u00a0 abc", 3, ["é", "abc"]],
    ["\x1b[31mé\x1b[0m    👩‍💻b", 3, ["é", "👩‍💻b"]],
    ["a      \u0301b", 3, ["a", " \u0301b"]],
    ["  a  b    c  ", 6, ["  a  b", "c  "]],
    ["  é  b    文  ", 6, ["  é  b", "文  "]],
    ["  ab", 3, ["  a", "b"]],
    ["  éb", 3, ["  é", "b"]],
    ["  b  \n   ", 5, ["  b  ", "   "]],
    ["a      \n\n  b  ", 5, ["a", "", "  b  "]],
    ["é       \n\n  文  ", 6, ["é", "", "  文  "]],
  ]) {
    const rows = wrapPlainText(input, width);
    assert.deepEqual(rows, expected, `${JSON.stringify(input)} @${width}`);
    assert(rows.every((row) => visibleWidth(row) <= width));
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
  // Deliberately unoptimized oracle: measure the whole candidate each time.
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
        const parts = Array.from(segmenter.segment(paragraph), ({ segment }) => segment);
        for (let at = 0; at < parts.length; at++) {
          const segment = parts[at];
          const cluster = visibleWidth(segment) > width ? "…" : segment;
          let separator = false;
          while (visibleWidth(line.join("") + cluster) > width) {
            if (cluster === " ") {
              if (line.some((part) => part !== " ")) {
                while (parts[at + 1] === " ") at++;
              }
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
    "a narrow row\n\n  indented   text with trailing spaces     \n",
    "         a         b          ",
    "01234".repeat(31),
    "  A\tB\r\nC\x1b[31mstyle\x1b[0mD",
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

test("tool arguments and paths visibly escape protocols before width and path decisions", () => {
  const argumentEscapes = [
    "\\x1b]8;;https://example.invalid\\x1b\\\\X\\x1b]8;;\\x1b\\\\",
    "\\x1b]0;title\\x07X",
    "\\x1b]2;title\\x1b\\\\X",
    "\\x1b]52;c;WA==\\x07X",
    "\\x1b[2J\\x1b[10;10HX\\x1b[1G\\x1b[K",
    "\\x1b[8mX\\x1b[0m",
    "\\x1b_pi:c\\x07X",
    "\\x1b[2AX",
    "\\x1b]0;unfinished",
    "\\x1bPpayload\\x1b\\\\X",
    "\\x9b2JX",
    "\\x9d52;c;WA==\\x9cX",
    "\\x00\\x08\\x7f\\x80\\x9fX",
  ];
  assert.equal(argumentEscapes.length, protocols.length);
  for (const [index, [kind, input]] of protocols.entries()) {
    const expected = argumentEscapes[index];
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
    "make\\x09check\\x0d\\n  --offline",
  );
  assert.equal(
    describeToolArgs("grep", { pattern: "x", glob: "\x1b]0;title\x07**/*.ts" }, "/w", 72),
    '"x" in \\x1b]0;title\\x07**/*.ts',
  );
  assert.equal(shortPath("/w/a\u202eb.ts", "/w", 72), "a\\u202eb.ts");
  assert.equal(shortPath("/w/a\u00a0\u3000b.ts", "/w", 72), "a\u00a0\u3000b.ts");
  assert.equal(
    describeToolArgs("bash", { command: "  echo\u00a0\u3000x  " }, "/w", 72),
    "  echo\u00a0\u3000x  ",
  );
});

test("already-escaped activity paths are tail-clipped without escaping backslashes again", () => {
  const theme = { fg: (_color, text) => text };
  const detail = describeToolArgs(
    "read",
    { path: "/w/long-directory/dir\\name/\tfile.ts" },
    "/w",
    Infinity,
  );
  assert.equal(detail, "long-directory/dir\\\\name/\\x09file.ts");
  assert.equal(
    renderActivity([{ name: "read", detail }], { preview: "" }, theme, 200),
    `reading ${detail}`,
  );
  assert.equal(
    renderActivity([{ name: "read", detail }], { preview: "" }, theme, 35),
    "reading …/dir\\\\name/\\x09file.ts",
  );
});

test("activity details visibly neutralize controls while metadata and preview protocols keep their own contracts", () => {
  const theme = { fg: (_color, text) => text };
  const defensiveDetails = [
    "\\x1b]8;;https://example.invalid\\x1b\\X\\x1b]8;;\\x1b\\",
    "\\x1b]0;title\\x07X",
    "\\x1b]2;title\\x1b\\X",
    "\\x1b]52;c;WA==\\x07X",
    "\\x1b[2J\\x1b[10;10HX\\x1b[1G\\x1b[K",
    "\\x1b[8mX\\x1b[0m",
    "\\x1b_pi:c\\x07X",
    "\\x1b[2AX",
    "\\x1b]0;unfinished",
    "\\x1bPpayload\\x1b\\X",
    "\\x9b2JX",
    "\\x9d52;c;WA==\\x9cX",
    "\\x00\\x08\\x7f\\x80\\x9fX",
  ];
  assert.equal(defensiveDetails.length, protocols.length);
  for (const [index, [kind, input, expected]] of protocols.entries()) {
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
      `running ${defensiveDetails[index]}`,
      `${kind}: activity detail controls stay visible, unlike ordinary metadata protocols`,
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
  assert(argument.startsWith("\\x1b]52;"), "raw argument payload remains visible before clipping");
  const styled = renderActivity([{ name: "bash", detail: argument }], { preview: "" }, theme, 72);
  assert(styled.startsWith("\x1b[33m"));
  assert(styled.endsWith("\x1b[0m"));
  assert(styled.includes("\\x1b]52;"), "styling does not erase the escaped payload");
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
