/**
 * Well-formed `alert_parent` / `ask_parent` calls render as right-aligned
 * cards, with a neutral title above the host's `userMessageBg`, message prose
 * in `customMessageLabel`, and the right-side receipt outside any background.
 *
 * The production source is loaded through jiti (`fsCache: false`), never a
 * stale dist build. The host theme is the real SDK singleton, initialized
 * through the public `initTheme()` with the built-in dark theme and a public
 * true-color capability override, so `userMessageBg` is distinct from the
 * generic tool-card backgrounds; every expected sequence is read back from
 * the real `Theme` instance the SDK hands to tool renderers through the
 * public `ToolRenderers` contract, never from a private cache.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

// Make token-color assertions deterministic: 256-color quantization can map
// userMessageBg and toolSuccessBg to the same sequence on a headless runner.
setCapabilityOverrides({ trueColor: true });
initTheme("dark", false);

// Load the production source, not a potentially stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { CommunicationBubble, CommunicationCard } = await jiti.import(
  "../../src/orchestration/ui/communication-bubble.ts",
);
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { humanSteerLead } = await jiti.import(
  "../../src/orchestration/presentation/human-steer-text.ts",
);

// ---- The component on its own, over a recording leaf theme ----

/** Zero-visible-width ANSI markers with a distinct opener per known token, so
 * exact row structure stays checkable and a wrong token would change the
 * rows. Every style request is recorded. */
const recordingTheme = () => {
  const calls = [];
  const open = {
    userMessageText: "\u001b[31m",
    customMessageLabel: "\u001b[35m",
    userMessageBg: "\u001b[41m",
  };
  const mark = (kind, close) => (color, text) => {
    calls.push([kind, color]);
    return `${open[color] ?? "\u001b[97m"}${text}${close}`;
  };
  return {
    calls,
    fg: mark("fg", "\u001b[39m"),
    bg: mark("bg", "\u001b[49m"),
    bold(text) {
      calls.push(["bold", text]);
      return text;
    },
    italic(text) {
      calls.push(["italic", text]);
      return text;
    },
  };
};

const BG = "\u001b[41m";
const BG_CLOSE = "\u001b[49m";
const TITLE_FG = "\u001b[31m";
const BODY_FG = "\u001b[35m";
const FG_CLOSE = "\u001b[39m";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

test("the inner block paints a distinct title and body over its allocated width", () => {
  const theme = recordingTheme();
  const rows = new CommunicationBubble("Alert to parent", "BODY_TEXT", theme).render(60);
  assert.equal(
    rows.length,
    4,
    "the title above, then one backgrounded padding row above and below the body",
  );
  // The title sits right-aligned ABOVE the background block: a one-cell inset
  // on each side keeps the body's inner edge and the old in-box right edge,
  // but the row carries no userMessageBg of its own.
  assert.equal(rows[0], ` ${" ".repeat(43)}${TITLE_FG}Alert to parent${FG_CLOSE} `);
  // The whole padding/body row, inner-edge padding included, carries the
  // background, and every row closes it again so the color cannot bleed into
  // the transcript.
  assert.equal(rows[1], `${BG}${" ".repeat(60)}${BG_CLOSE}`);
  assert.equal(rows[3], rows[1]);
  // The body's foreground opens and closes around the already-clipped,
  // content-padded row; the Box adds the last padding cell inside the background.
  assert.equal(rows[2], `${BG} ${BODY_FG}BODY_TEXT${" ".repeat(49)}${FG_CLOSE} ${BG_CLOSE}`);
  for (const [index, row] of rows.entries()) {
    if (index === 0) {
      assert.ok(
        !row.includes(BG) && !row.includes(BG_CLOSE),
        "the title row stays outside the background",
      );
    } else {
      assert.ok(
        row.startsWith(BG) && row.endsWith(BG_CLOSE),
        `each block row closes its background`,
      );
    }
    assert.equal(visibleWidth(row), 60);
    assert.doesNotMatch(row, /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/, "no frame or border is drawn around the block");
  }
  assert.deepEqual(
    new Set(theme.calls.map(([kind, color]) => `${kind}:${color}`)),
    new Set(["fg:userMessageText", "fg:customMessageLabel", "bg:userMessageBg"]),
  );
});

test("recorded line breaks survive; every paragraph keeps the block background", () => {
  const rows = new CommunicationBubble(
    "Title",
    "line one\nline two\n\nline four",
    recordingTheme(),
  );
  assert.deepEqual(rows.render(20).map(stripTerminalSequences), [
    `${" ".repeat(14)}Title `,
    " ".repeat(20),
    ` line one${" ".repeat(11)}`,
    ` line two${" ".repeat(11)}`,
    " ".repeat(20),
    ` line four${" ".repeat(10)}`,
    " ".repeat(20),
  ]);
});

test("wrapping breaks between words and keeps each row a full block line", () => {
  const rows = new CommunicationBubble("L", `a${FAMILY}b 你好`, recordingTheme()).render(6);
  assert.deepEqual(rows.map(stripTerminalSequences), [
    "    L ",
    " ".repeat(6),
    ` a${FAMILY}b `,
    " 你好 ",
    " ".repeat(6),
  ]);
});

test("CJK and emoji clusters wrap cell-safely at every width from 1 to 200", () => {
  const body = `你好世界检查测试 ok ${FAMILY}`;
  for (let width = 1; width <= 200; width++) {
    const rows = new CommunicationBubble("Alert to parent", body, recordingTheme()).render(width);
    const stripped = rows.map(stripTerminalSequences).join("\n");
    // A grapheme too wide for the row is dropped whole, never split: every
    // cluster fragment that survives belongs to a complete cluster. Below two
    // columns the two-cell family cluster cannot fit, so it is dropped.
    const whole = stripped.split(FAMILY).length - 1;
    assert.equal(
      stripped.split("\u{1F468}").length - 1,
      whole,
      `no cluster fragment survives without the whole family at width ${width}`,
    );
    assert.equal(whole, width >= 2 ? 1 : 0, `the whole cluster at width ${width}`);
    for (const [index, row] of rows.entries()) {
      if (index === 0) {
        assert.ok(
          !row.includes(BG) && !row.includes(BG_CLOSE),
          `the title row stays outside the background at ${width}`,
        );
      } else {
        assert.ok(
          row.startsWith(BG) && row.endsWith(BG_CLOSE),
          `row closes its background at ${width}`,
        );
      }
      assert.ok(visibleWidth(row) <= width, `row of width ${visibleWidth(row)} fits ${width}`);
      if (width >= 2) assert.equal(visibleWidth(row), width, `row fills the block at ${width}`);
    }
  }
});

test("the body is plain text, never markdown", () => {
  const rows = new CommunicationBubble("Title", "**bold** # heading `code`", recordingTheme());
  const body = rows
    .render(30)
    .map(stripTerminalSequences)
    .find((row) => row.includes("**bold**"));
  assert.ok(body, "**bold** survives byte-literally");
  assert.ok(body.includes("# heading `code`"), "and so do headings and code spans");
});

test("an overlong title truncates by cells and stays right-aligned", () => {
  const rows = new CommunicationBubble("A very long label that cannot fit", "x", recordingTheme());
  assert.deepEqual(rows.render(20).map(stripTerminalSequences), [
    " A very long label… ",
    " ".repeat(20),
    ` x${" ".repeat(18)}`,
    " ".repeat(20),
  ]);
});

test("degenerate widths render nothing instead of throwing", () => {
  const bubble = new CommunicationBubble("T", "b", recordingTheme());
  assert.deepEqual(bubble.render(0), []);
  assert.deepEqual(bubble.render(-3), []);
  assert.deepEqual(bubble.render(2.5), []);
});

test("invalidate() drops caches without changing the block", () => {
  const bubble = new CommunicationBubble("Title", "body", recordingTheme());
  const before = bubble.render(30);
  bubble.invalidate();
  assert.deepEqual(bubble.render(30), before);
});

/** Walk a row's SGR state cell by cell: which marker is active on each visible
 * cell, whether a hard reset appears anywhere, and what state the row leaves
 * open. Guards the self-closing styling order: the clip runs before the
 * foreground, the background wraps last, and neither a title truncator's
 * internal reset nor an extreme-narrow slice may break that. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const sgrWalk = (row) => {
  const cells = [];
  let fg = null;
  let bg = null;
  let sawReset = false;
  // eslint-disable-next-line no-control-regex -- inspect trusted theme SGR spans
  const re = /\u001b\[([0-9;]*)m/g;
  const consume = (text) => {
    for (const { segment } of graphemes.segment(text)) {
      for (let i = 0; i < visibleWidth(segment); i++) cells.push({ ch: segment, fg, bg });
    }
  };
  let last = 0;
  let match;
  while ((match = re.exec(row)) !== null) {
    consume(row.slice(last, match.index));
    const params = match[1].split(";");
    for (let i = 0; i < params.length; i++) {
      const code = Number(params[i]);
      if (code === 0) {
        sawReset = true;
        fg = null;
        bg = null;
      } else if (code === 39) fg = null;
      else if (code === 49) bg = null;
      else if (code === 38 || code === 48) {
        const end = i + (params[i + 1] === "2" ? 5 : 3);
        const color = `\u001b[${params.slice(i, end).join(";")}m`;
        if (code === 38) fg = color;
        else bg = color;
        i = end - 1;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        fg = `\u001b[${code}m`;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        bg = `\u001b[${code}m`;
      }
    }
    last = re.lastIndex;
  }
  consume(row.slice(last));
  return { cells, fg, bg, sawReset };
};

test("a truncated title stays outside the background: no mid-row reset", () => {
  const titles = { 8: "Alert…", 12: "Alert to …", 20: "Alert to parent" };
  for (const width of [8, 12, 20]) {
    const rows = new CommunicationBubble("Alert to parent", "BODY", recordingTheme()).render(width);
    const title = rows[0];
    const walk = sgrWalk(title);
    assert.ok(!walk.sawReset, `no hard reset inside the title row at width ${width}`);
    assert.ok(walk.cells.length > 0, `the title row has visible cells at width ${width}`);
    for (const cell of walk.cells)
      assert.equal(
        cell.bg,
        null,
        `no background under any title cell, right padding included, at width ${width}`,
      );
    // The foreground paints exactly the clipped title, nothing more.
    assert.equal(
      walk.cells
        .filter((cell) => cell.fg === TITLE_FG)
        .map((cell) => cell.ch)
        .join(""),
      titles[width],
      `the foreground covers the clipped title at width ${width}`,
    );
    assert.ok(
      !title.includes(BG) && !title.includes(BG_CLOSE),
      `no background sequence appears on the title row at width ${width}`,
    );
    assert.equal(walk.fg, null, `the title row leaves no foreground open at width ${width}`);
    assert.equal(walk.bg, null, `the title row leaves no background open at width ${width}`);
  }
});

test("below four columns the title drops its inset instead of starving the row", () => {
  // Same cell-safe clip as the body's extreme-narrow path: the ellipsis
  // replaces what cannot fit, and no inset remains at widths 1..3.
  const titles = { 1: "…", 2: "A…", 3: "Al…" };
  for (const [width, title] of Object.entries(titles)) {
    const rows = new CommunicationBubble("Alert to parent", "BODY", recordingTheme()).render(
      Number(width),
    );
    assert.equal(stripTerminalSequences(rows[0]), title, `the clipped title at width ${width}`);
    assert.ok(
      !rows[0].includes(BG) && !rows[0].includes(BG_CLOSE),
      `no background on the narrow title at width ${width}`,
    );
    assert.equal(visibleWidth(rows[0]), Number(width), `the narrow title fills width ${width}`);
  }
});

test("an extreme-narrow clip still closes the body foreground inside the row", () => {
  const rows = new CommunicationBubble("L", "你好", recordingTheme()).render(1);
  assert.ok(!rows[0].includes(BG), "the title stays outside the background even at width 1");
  // After the outside title and the block's top padding row: the body rows
  // where the two-cell graphemes were dropped whole by the width-1 clip.
  const body = rows.slice(2, -1);
  assert.ok(body.length > 0, "the width-1 body renders rows");
  for (const row of body) {
    const walk = sgrWalk(row);
    assert.ok(row.includes(FG_CLOSE), "the narrow clip does not drop the foreground closer");
    assert.ok(!walk.sawReset, "no hard reset inside a clipped body row");
    for (const cell of walk.cells)
      assert.equal(cell.bg, BG, "the background stays active under every cell");
    assert.ok(
      row.lastIndexOf(FG_CLOSE) < row.lastIndexOf(BG_CLOSE),
      "the foreground closes before the row's final background close",
    );
    assert.equal(walk.fg, null, "no foreground stays open past the row");
    assert.equal(walk.bg, null, "no background stays open past the row");
  }
});

test("right cards preserve readable content and safe cell bounds across narrow widths", () => {
  const label = "Alert to parent";
  const text = `你${FAMILY} LONG_MESSAGE_BODY`;
  const bubble = new CommunicationBubble(label, text, recordingTheme());
  const card = new CommunicationCard(Math.max(visibleWidth(label), visibleWidth(text)), bubble);
  for (const width of [0, -1, 2.5]) assert.deepEqual(card.render(width), []);
  for (const width of [1, 2, 3, 4, 5, 6, 7, 10, 25, 27]) {
    const rows = card.render(width);
    const backgroundRows = rows.filter((row) => row.includes(BG));
    assert.ok(backgroundRows.length > 0, `width ${width}: still has a body`);
    const plain = backgroundRows.map(stripTerminalSequences).join("\n");
    assert.equal(plain.includes(FAMILY), width >= 2, `width ${width}: fits a whole grapheme`);
    assert.match(plain, /L/, `width ${width}: prose is visible`);
    for (const row of rows) assert.ok(visibleWidth(row) <= width);
    for (const row of backgroundRows) {
      const { cells, bg } = sgrWalk(row);
      assert.equal(cells.length, width, "the body still reaches the right edge");
      assert.equal(bg, null, "the right edge closes the background");
      const gap = cells.findIndex((cell) => cell.bg === BG);
      assert.ok(gap >= 0 && cells.slice(gap).every((cell) => cell.bg === BG));
      assert.ok(cells.slice(0, gap).every((cell) => cell.ch === " " && cell.bg === null));
      if (width >= 6) assert.ok(gap >= 2, `width ${width}: opposing gutter when feasible`);
    }
  }
  // More generous than 80% on these narrow viewports: enough room for a
  // short phrase instead of squashing an already narrow prose column.
  for (const width of [25, 27]) {
    const padding = card.render(width).find((row) => row.includes(BG));
    assert.equal(sgrWalk(padding).cells.filter((cell) => cell.bg === BG).length, width - 3);
  }
});

// ---- The pane integration, over the real SDK host theme ----

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  ...extra,
});
const result = (id, text, isError = false, toolName = "alert_parent") => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: text === null ? [] : [{ type: "text", text }],
  isError,
});
const contentOver = (messages, toolDefinition) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: toolDefinition ?? (() => undefined),
    },
  });
const rowsAt = (content, width = 70) => content.slice(width, 0, content.lineCount(width));

/** The SDK hands its real host Theme to every tool renderer; capture that
 * public instance once, so the expected sequences below come from the theme
 * itself rather than hardcoded colors. */
let hostTheme;
{
  const capture = contentOver([assistant([call("theme-probe", "probe_theme", {})])], (name) =>
    name === "probe_theme"
      ? {
          renderCall: (_args, theme) => {
            hostTheme = theme;
            return { render: () => ["PROBE"], invalidate() {} };
          },
        }
      : undefined,
  );
  rowsAt(capture);
  capture.dispose();
}
const bubbleBg = hostTheme.getBgAnsi("userMessageBg");
const bubbleRows = (rows) => rows.filter((row) => row.includes(bubbleBg));

function assertRightBackground(row, paneWidth, cardWidth) {
  const { cells, fg, bg } = sgrWalk(row);
  assert.equal(cells.length, paneWidth, "the card reaches the right edge of the pane");
  const gap = paneWidth - cardWidth;
  assert.ok(gap >= 2, "at least two cells of breathing room on the opposite side");
  assert.ok(
    cells.slice(0, gap).every((cell) => cell.ch === " " && cell.bg === null),
    "the opposite gap is outside the background",
  );
  assert.ok(
    cells.slice(gap).every((cell) => cell.bg === bubbleBg),
    "the whole card is painted",
  );
  assert.equal(fg, null, "the foreground does not leak past the row");
  assert.equal(bg, null, "the background does not leak past the row");
  return cells;
}

test("short alert and ask cards fit their widest line or title, with actual ink colors", () => {
  const titleFg = hostTheme.getFgAnsi("userMessageText");
  const bodyFg = hostTheme.getFgAnsi("customMessageLabel");
  assert.notEqual(bodyFg, titleFg, "the real theme distinguishes title and communication prose");
  for (const token of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
    assert.notEqual(bubbleBg, hostTheme.getBgAnsi(token));
  }

  // The alert's title decides its width. The ask's widest line decides its
  // width in terminal cells, not in UTF-16 units or total paragraph length.
  const alert = "ALERT";
  const question = `QUESTION_你好你好你好${FAMILY}`;
  const messages = [
    assistant([call("a1", "alert_parent", { message: alert })]),
    result("a1", "Alert queued. Continue working."),
    assistant([call("q1", "ask_parent", { question: `SHORT_LINE\n${question}` })]),
    result("q1", "Question recorded. End your turn now.", false, "ask_parent"),
  ];
  const content = contentOver(messages);
  try {
    const width = 70;
    const rows = rowsAt(content, width);
    assert.equal(bubbleRows(rows).length, 7, "two blocks with padding and three body rows total");
    for (const [label, lines, receipt] of [
      ["Alert to parent", [alert], "Alert queued. Continue working."],
      ["Question to parent", ["SHORT_LINE", question], "Question recorded. End your turn now."],
    ]) {
      const cardWidth = Math.max(...[label, ...lines].map(visibleWidth)) + 2;
      const titleIndex = rows.findIndex((row) => stripTerminalSequences(row).endsWith(`${label} `));
      assert.notEqual(titleIndex, -1, `${label} reaches the card's right inset`);
      const title = sgrWalk(rows[titleIndex]);
      assert.equal(title.cells.length, width);
      assert.ok(
        title.cells.every((cell) => cell.bg === null),
        "the title stays above the BG",
      );
      assert.ok(title.cells.slice(-label.length - 1, -1).every((cell) => cell.fg === titleFg));
      const block = rows.slice(titleIndex + 1, titleIndex + lines.length + 3);
      for (const row of block) {
        assertRightBackground(row, width, cardWidth);
        assert.doesNotMatch(row, /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/, "no border around the card");
      }
      for (const [index, line] of lines.entries()) {
        const row = block[index + 1];
        assert.ok(
          stripTerminalSequences(row).startsWith(`${" ".repeat(width - cardWidth + 1)}${line}`),
        );
        const start = width - cardWidth + 1;
        assert.ok(
          sgrWalk(row)
            .cells.slice(start, start + visibleWidth(line))
            .every((cell) => cell.fg === bodyFg && cell.bg === bubbleBg),
          "the actual body cells, including wide graphemes, carry the communication foreground",
        );
      }
      const row = rows[titleIndex + lines.length + 3];
      const indent = width - Math.max(cardWidth, visibleWidth(receipt) + 2) + 1;
      assert.equal(stripTerminalSequences(row).trimEnd(), `${" ".repeat(indent)}${receipt}`);
      const walk = sgrWalk(row);
      assert.ok(
        walk.cells.every((cell) => cell.bg === null),
        "no background under the receipt",
      );
    }
  } finally {
    content.dispose();
  }
});

test("a wrapped multiline receipt uses one right-hand reading edge, even on narrow panes", (t) => {
  const text = `FIRST row has words to wrap at narrow widths\n\n${FAMILY} 你好\nlast line`;
  const content = contentOver([
    assistant([call("wrapped", "ask_parent", { question: "SHORT_BODY" })]),
    result("wrapped", text, true, "ask_parent"),
  ]);
  t.after(() => content.dispose());
  const receiptRows = (rows) => rows.slice(rows.findLastIndex((row) => row.includes(bubbleBg)) + 1);
  const width = 36;
  const rows = rowsAt(content, width);
  const cardGutter = sgrWalk(rows.find((row) => row.includes(bubbleBg))).cells.findIndex(
    (cell) => cell.bg === bubbleBg,
  );
  const indent = width - Math.floor(width * 0.8) + 1;
  assert.ok(
    indent < cardGutter + 1,
    "the receipt widens leftward instead of squeezing to the body",
  );
  assert.deepEqual(
    receiptRows(rows).map((row) => stripTerminalSequences(row).trimEnd()),
    ["FIRST row has words to", "wrap at narrow widths", "", `${FAMILY} 你好`, "last line"].map(
      (line) => (line ? " ".repeat(indent) + line : ""),
    ),
    "wrapped fragments and original lines stay left-reading at a common gutter",
  );

  const errorFg = hostTheme.getFgAnsi("error");
  for (const narrow of [1, 2, 3, 4, 5, 7, 18, 25, width, 70]) {
    const allRows = rowsAt(content, narrow);
    assert.ok(
      allRows.every((row) => visibleWidth(row) <= narrow),
      `every row fits width ${narrow}`,
    );
    const receipt = receiptRows(allRows);
    const plain = receipt.map(stripTerminalSequences).join("\n");
    assert.equal(plain.includes(FAMILY), narrow >= 2, `whole emoji at width ${narrow}`);
    assert.equal(
      plain.includes("\u{1F468}"),
      plain.includes(FAMILY),
      `no partial emoji at width ${narrow}`,
    );
    assert.match(plain.replace(/\s/gu, ""), /FIRSTrowhaswordstowrapatnarrowwidths.*lastline/);
    for (const row of receipt) {
      const walk = sgrWalk(row);
      assert.ok(
        walk.cells.every((cell) => cell.bg === null),
        "no receipt background",
      );
      assert.ok(walk.cells.every((cell) => cell.ch === " " || cell.fg === errorFg));
      assert.equal(walk.fg, null, "each wrapped row closes its error foreground");
    }
  }
});

test("receipts stay outside the block: dim when normal, red on error, never lost", () => {
  const messages = [
    assistant([call("n1", "alert_parent", { message: "NORMAL_BODY" })]),
    result("n1", "Alert queued. Continue working."),
    assistant([call("e1", "alert_parent", { message: "ERROR_BODY" })]),
    result("e1", "COMMAND_FAILED_MARKER", true),
    // Three error results with nothing readable recorded: no content blocks,
    // an empty text block, and a whitespace-only text block.
    assistant([call("x1", "ask_parent", { question: "EMPTY_ERROR_BODY" })]),
    result("x1", null, true, "ask_parent"),
    assistant([call("y1", "ask_parent", { question: "EMPTY_STRING_BODY" })]),
    result("y1", "", true, "ask_parent"),
    assistant([call("z1", "alert_parent", { message: "WHITESPACE_BODY" })]),
    result("z1", " \n\t", true),
    // A whitespace-only normal result stays empty; no receipt is invented.
    assistant([call("w1", "alert_parent", { message: "WHITESPACE_NORMAL_BODY" })]),
    result("w1", " \n\t", false),
  ];
  const content = contentOver(messages);
  try {
    const rows = rowsAt(content);
    const receiptRow = (text) => rows.find((row) => stripTerminalSequences(row).includes(text));
    const normal = receiptRow("Alert queued. Continue working.");
    assert.ok(normal, "the normal receipt is on screen");
    assert.ok(!normal.includes(bubbleBg), "outside the block background");
    assert.ok(
      normal.includes(hostTheme.fg("dim", "Alert queued. Continue working.")),
      "a normal receipt is dim",
    );
    const failed = receiptRow("COMMAND_FAILED_MARKER");
    assert.ok(failed, "the error receipt is on screen");
    assert.ok(!failed.includes(bubbleBg), "also outside the block background");
    assert.ok(
      failed.includes(hostTheme.fg("error", "COMMAND_FAILED_MARKER")),
      "an error receipt is red",
    );
    for (const body of ["EMPTY_ERROR_BODY", "EMPTY_STRING_BODY"]) {
      const bodyIndex = rows.findIndex((row) => stripTerminalSequences(row).includes(body));
      const indent = stripTerminalSequences(rows[bodyIndex]).indexOf(body);
      const marker = stripTerminalSequences(rows[bodyIndex + 2]).trimEnd();
      assert.equal(marker, `${" ".repeat(indent)}Error`, "short markers follow the card inset");
    }
    // Each unreadable error result still says Error, once, in the error color;
    // a whitespace-only normal result invents no receipt text of its own.
    const errorRows = rows.filter((row) => stripTerminalSequences(row).includes("Error"));
    assert.equal(errorRows.length, 3, "one Error per unreadable error result, no more");
    for (const row of errorRows) {
      assert.ok(row.includes(hostTheme.fg("error", "Error")), "each Error is red");
      assert.ok(!row.includes(bubbleBg), "and outside the block background");
    }
    assert.doesNotMatch(
      rows.map(stripTerminalSequences).join("\n"),
      /read by parent|seen by parent|delivered to parent|acknowledged/i,
      "the pane adds no read or delivery claim of its own",
    );
  } finally {
    content.dispose();
  }
});

test("a generation interrupted mid-call reports its failure clearly outside the block", () => {
  const messages = [
    assistant([call("ab1", "alert_parent", { message: "ABORTED_BODY" })], {
      stopReason: "aborted",
    }),
    assistant([call("er1", "ask_parent", { question: "ERROR_BODY" })], {
      stopReason: "error",
      errorMessage: "overloaded_error",
    }),
    assistant([call("er2", "alert_parent", { message: "BARE_BODY" })], { stopReason: "error" }),
  ];
  const content = contentOver(messages);
  try {
    const rows = rowsAt(content);
    const receiptRow = (text) => rows.find((row) => stripTerminalSequences(row).includes(text));
    for (const [text, body] of [
      ["Operation aborted", "ABORTED_BODY"],
      ["overloaded_error", "ERROR_BODY"],
      ["Error", "BARE_BODY"],
    ]) {
      const receipt = receiptRow(text);
      assert.ok(receipt, `${text} is reported, not swallowed`);
      assert.ok(!receipt.includes(bubbleBg), `${text} sits outside the block`);
      assert.ok(receipt.includes(hostTheme.fg("error", text)), `${text} is red`);
      const bubble = rows.find((row) => stripTerminalSequences(row).includes(body));
      assert.ok(bubble?.includes(bubbleBg), `${body} keeps its block`);
    }
  } finally {
    content.dispose();
  }
});

test("the tools-expanded toggle never hides a communication message or its receipt", () => {
  const messages = [
    assistant([call("t1", "alert_parent", { message: "TOGGLE_BODY" })]),
    result("t1", "TOGGLE_RECEIPT"),
  ];
  const content = contentOver(messages);
  try {
    const paint = () => rowsAt(content).map(stripTerminalSequences).join("\n");
    paint();
    content.setToolsExpanded(true);
    const expanded = paint();
    content.setToolsExpanded(false);
    const collapsed = paint();
    for (const [name, text] of [
      ["expanded", expanded],
      ["collapsed", collapsed],
    ]) {
      assert.ok(text.includes("Alert to parent"), `the title survives the ${name} mode`);
      assert.ok(text.includes("TOGGLE_BODY"), `the body survives the ${name} mode`);
      assert.ok(text.includes("TOGGLE_RECEIPT"), `the receipt survives the ${name} mode`);
    }
    assert.equal(expanded, collapsed, "the block ignores the card expansion mode");
    assert.equal(
      bubbleRows(rowsAt(content)).length,
      3,
      "the block is still painted after both toggles (title outside the background)",
    );
  } finally {
    content.dispose();
  }
});

test("long CJK bodies wrap inside the block; control characters never reach the pane", () => {
  const osc52 = "\x1b]52;c;CLIPBOARD_PAYLOAD\x07";
  const csi = "\x1b[2J";
  const bidi = "R\u2068everse\u2069";
  const payload = `START${osc52}${csi}${bidi}${FAMILY}END`;
  const long = `${"你好世界检查测试 ".repeat(6)}tail words here`;
  const messages = [
    assistant([call("w1", "alert_parent", { message: long })]),
    result("w1", "Wrapped receipt."),
    assistant([call("s1", "ask_parent", { question: payload })]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const width = 36;
    const rows = rowsAt(content, width);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, "no row overflows the pane");
    const block = bubbleRows(rows);
    assert.ok(block.length > 4, "the long bodies wrap across several block rows");
    for (const row of block) assertRightBackground(row, width, Math.floor(0.8 * width));
    const stripped = rows.map(stripTerminalSequences).join("\n");
    assert.equal(stripped.match(/你/g)?.length, 6, "every CJK repetition survives wrapping");
    assert.equal(stripped.split(FAMILY).length - 1, 1, "the emoji cluster is never split");
    for (const raw of ["\x1b]52", "\x1b[2J", "\u2068", "\u2069"])
      assert.ok(!rows.some((row) => row.includes(raw)), `raw ${JSON.stringify(raw)} survived`);
    assert.ok(stripped.includes("\\u2068"), "bidi isolates are explicitly escaped");
    const receipt = rows.find((row) => stripTerminalSequences(row).includes("Wrapped receipt."));
    assert.ok(receipt, "the wrapped call's receipt is on screen");
    assert.ok(!receipt.includes(bubbleBg), "outside the block");
    assert.deepEqual(messages, before, "rendering rewrites no recorded source byte");
  } finally {
    content.dispose();
  }
});

test("malformed arguments and retired names keep the generic raw card, not the block", () => {
  const pendingBg = hostTheme.getBgAnsi("toolPendingBg");
  const messages = [
    assistant([call("m1", "alert_parent", { message: 42 })]),
    assistant([call("m2", "alert_parent", { message: "two", extra: "keys" })]),
    assistant([call("m3", "alert_parent", { message: "" })]),
    assistant([call("old", "notify_parent", { message: "OLD_NOTICE" })]),
  ];
  const content = contentOver(messages);
  try {
    const rows = rowsAt(content);
    const stripped = rows.map(stripTerminalSequences).join("\n");
    assert.equal(bubbleRows(rows).length, 0, "no malformed or retired call gets the message block");
    assert.doesNotMatch(stripped, /Alert to parent|Question to parent/);
    for (const literal of ["alert_parent", "message: 42", "extra", "notify_parent", "OLD_NOTICE"])
      assert.ok(stripped.includes(literal), `${literal} stays raw data`);
    assert.ok(
      rows.some((row) => stripTerminalSequences(row).trimEnd() === "   message:"),
      "an empty-string argument stays raw data too",
    );
    for (const literal of ["message: 42", "OLD_NOTICE"]) {
      const row = rows.find((r) => stripTerminalSequences(r).includes(literal));
      assert.ok(row?.startsWith(pendingBg), `${literal} keeps the generic card background`);
    }
  } finally {
    content.dispose();
  }
});

test("user labels stay neutral and no parent origin is invented", () => {
  const steered = `${humanSteerLead}\n\nCHANGE_TABS_TO_SPACES`;
  const messages = [
    { role: "user", content: "GENERIC_TASK_TEXT", timestamp: 0 },
    assistant([call("a1", "alert_parent", { message: "BUBBLE_BODY" })]),
    result("a1", "Alert queued."),
    { role: "user", content: steered, timestamp: 2 },
  ];
  const content = contentOver(messages);
  try {
    const text = rowsAt(content, 160).map(stripTerminalSequences).join("\n");
    assert.match(text, /Input/, "a generic user message keeps its neutral label");
    assert.match(
      text,
      /Steering input \(human lead\)/,
      "the exact steering lead keeps its qualified label",
    );
    assert.equal(text.match(/Input/g)?.length, 1, "no user message is relabeled");
    assert.equal(text.match(/Alert to parent/g)?.length, 1, "the block title appears once");
    assert.doesNotMatch(text, /From parent/i, "no parent origin is claimed without metadata");
    assert.doesNotMatch(
      text,
      /read by parent|delivered to parent|acknowledged/i,
      "no read or delivery claim is added",
    );
  } finally {
    content.dispose();
  }
});
