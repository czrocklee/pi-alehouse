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
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Make token-color assertions deterministic: 256-color quantization can map
// userMessageBg and toolSuccessBg to the same sequence on a headless runner.
setCapabilityOverrides({ trueColor: true });
initTheme("dark", false);

// Load the production source, not a potentially stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const {
  CommunicationBubble,
  CommunicationCard,
  CommunicationLayout,
  CommunicationReceipt,
  communicationPadding,
} = await jiti.import("../../src/orchestration/ui/communication-bubble.ts");
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
  // The title sits right-aligned ABOVE the background block: a two-cell inset
  // on each side keeps the body's inner edge, but the row carries no
  // userMessageBg of its own. Vertical padding is still one row.
  assert.equal(rows[0], `${" ".repeat(43)}${TITLE_FG}Alert to parent${FG_CLOSE}  `);
  // The whole padding/body row, inner-edge padding included, carries the
  // background, and every row closes it again so the color cannot bleed into
  // the transcript.
  assert.equal(rows[1], `${BG}${" ".repeat(60)}${BG_CLOSE}`);
  assert.equal(rows[3], rows[1]);
  // The body's foreground opens and closes around the already-clipped,
  // content-padded row; the Box adds the two-cell inset inside the background.
  assert.equal(rows[2], `${BG}  ${BODY_FG}BODY_TEXT${" ".repeat(47)}${FG_CLOSE}  ${BG_CLOSE}`);
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
    `${" ".repeat(13)}Title  `,
    " ".repeat(20),
    `  line one${" ".repeat(10)}`,
    `  line two${" ".repeat(10)}`,
    " ".repeat(20),
    `  line four${" ".repeat(9)}`,
    " ".repeat(20),
  ]);
});

test("wrapping breaks between words and keeps each row a full block line", () => {
  // Width 8 keeps four content cells under the two-cell inset, the old
  // width-6 content width, so the word break itself is unchanged.
  const rows = new CommunicationBubble("L", `a${FAMILY}b 你好`, recordingTheme()).render(8);
  assert.deepEqual(rows.map(stripTerminalSequences), [
    "     L  ",
    " ".repeat(8),
    `  a${FAMILY}b  `,
    "  你好  ",
    " ".repeat(8),
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
    "  A very long lab…  ",
    " ".repeat(20),
    `  x${" ".repeat(17)}`,
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
  // Content width is the row minus the 2/1/0 inset, so these clips move with it.
  const titles = { 8: "Ale…", 12: "Alert t…", 20: "Alert to parent" };
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

test("horizontal padding is 2/1/0 at width >=6/>=4/<4, and vertical padding stays", () => {
  const bubble = new CommunicationBubble("Alert to parent", "Hi", recordingTheme());
  const at = (width) => bubble.render(width).map(stripTerminalSequences);
  const wide = ["   Alert to parent  ", " ".repeat(20), `  Hi${" ".repeat(16)}`, " ".repeat(20)];
  assert.equal(communicationPadding(6), 2);
  assert.equal(communicationPadding(5), 1);
  assert.equal(communicationPadding(4), 1);
  assert.equal(communicationPadding(3), 0);
  assert.deepEqual(at(20), wide);
  assert.deepEqual(at(6), ["  A…  ", " ".repeat(6), "  Hi  ", " ".repeat(6)]);
  assert.deepEqual(at(5), [" Al… ", " ".repeat(5), " Hi  ", " ".repeat(5)]);
  assert.deepEqual(at(4), [" A… ", " ".repeat(4), " Hi ", " ".repeat(4)]);
  assert.deepEqual(at(3), ["Al…", " ".repeat(3), "Hi ", " ".repeat(3)]);
  // Same instance restores the two-cell inset, and still one blank row above
  // and below the body.
  assert.deepEqual(at(20), wide);
  for (const width of [20, 6, 5, 4, 3]) {
    const rows = at(width);
    assert.equal(rows.length, 4, `vertical padding is unchanged at width ${width}`);
    assert.equal(rows[1], " ".repeat(width));
    assert.equal(rows.at(-1), " ".repeat(width));
  }
});

test("tabs and CR/CRLF match the rendered text, and a one-cell card stays in the two-cell tier", () => {
  const raw = "A\tB\r\nC\rD";
  const rows = new CommunicationBubble("L", raw, recordingTheme()).render(30);
  assert.deepEqual(rows.map((row) => stripTerminalSequences(row).trim()).filter(Boolean), [
    "L",
    "A   B",
    "C",
    "D",
  ]);
  assert.equal(new CommunicationLayout("L", raw).width(80), visibleWidth("A   B") + 4);
  assert.equal(new CommunicationLayout("L", "A   B\nC\nD").width(80), visibleWidth("A   B") + 4);
  // A CR must end the line before the tab expands, or this measures one wider row.
  assert.equal(new CommunicationLayout("L", "A\r\tB").width(80), visibleWidth("   B") + 4);

  for (const [label, text] of [
    ["", ""],
    ["X", ""],
    ["", "Y"],
    ["X", "Y"],
  ]) {
    assert.equal(
      new CommunicationLayout(label, text).width(80),
      6,
      "a 0/1-cell message stays six columns wide so two-cell padding still applies",
    );
  }
  assert.equal(communicationPadding(6), 2);
  const empty = new CommunicationBubble("", "", recordingTheme()).render(80);
  assert.ok(
    empty.every((row) => !stripTerminalSequences(row).trim()),
    "empty raw label and text paint no body ink",
  );
  assert.deepEqual(
    new CommunicationBubble("X", "Y", recordingTheme()).render(6).map(stripTerminalSequences),
    ["   X  ", " ".repeat(6), "  Y   ", " ".repeat(6)],
  );
});

test("a CJK spacing-mark grapheme is not shrunk away while it still fits", () => {
  const cluster = "你\u0903";
  assert.equal(visibleWidth(cluster), 3);
  const text = `${cluster} x`;
  // Pane 10 can hold the cluster at the ceiling. The fit stops at its 3 cells
  // rather than a width that would drop the grapheme whole.
  assert.equal(new CommunicationLayout("L", text).width(10), 7);
  const kept = new CommunicationBubble("L", text, recordingTheme())
    .render(7)
    .map(stripTerminalSequences)
    .join("\n");
  assert.ok(kept.includes(cluster));
  const lost = new CommunicationBubble("L", text, recordingTheme())
    .render(6)
    .map(stripTerminalSequences)
    .join("\n");
  assert.ok(!lost.includes(cluster), "content width 2 drops the 3-cell grapheme");
  assert.ok(!lost.includes("你"));
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
  const card = new CommunicationCard(new CommunicationLayout(label, text), bubble);
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
  // LONG_MESSAGE_BODY is 17 cells. The fit stops there instead of using the
  // whole 90% ceiling (width - 3 at these panes).
  for (const width of [25, 27]) {
    const padding = card.render(width).find((row) => row.includes(BG));
    assert.equal(sgrWalk(padding).cells.filter((cell) => cell.bg === BG).length, 21);
    assert.ok(21 < width - 3, `width ${width}: fitted card sits inside the ceiling`);
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
/** 90% ceiling: at least a tenth of the pane and two columns, unless a four-column card would not fit. */
const cardCeiling = (available) => {
  const gutter = Math.max(2, Math.ceil(available / 10));
  return Math.min(available, Math.max(4, available - gutter));
};
/** Background rows of the card whose title ends at this label, plus the following receipt. */
function cardBlock(rows, title) {
  const index = rows.findIndex((row) => stripTerminalSequences(row).trimEnd().endsWith(title));
  if (index < 0) return { index: -1, block: [], receipt: [] };
  const block = [];
  let cursor = index + 1;
  for (; cursor < rows.length && rows[cursor].includes(bubbleBg); cursor++)
    block.push(rows[cursor]);
  const receipt = [];
  for (; cursor < rows.length && stripTerminalSequences(rows[cursor]).trim() !== ""; cursor++)
    receipt.push(rows[cursor]);
  return { index, block, receipt };
}

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
      // Ordinary cards use the two-cell inset; these lines fit under the ceiling.
      const cardWidth = Math.max(...[label, ...lines].map(visibleWidth)) + 4;
      assert.equal(communicationPadding(cardWidth), 2);
      const titleIndex = rows.findIndex((row) =>
        stripTerminalSequences(row).endsWith(`${label}  `),
      );
      assert.notEqual(titleIndex, -1, `${label} reaches the card's right inset`);
      const title = sgrWalk(rows[titleIndex]);
      assert.equal(title.cells.length, width);
      assert.ok(
        title.cells.every((cell) => cell.bg === null),
        "the title stays above the BG",
      );
      assert.ok(title.cells.slice(-label.length - 2, -2).every((cell) => cell.fg === titleFg));
      const block = rows.slice(titleIndex + 1, titleIndex + lines.length + 3);
      for (const row of block) {
        assertRightBackground(row, width, cardWidth);
        assert.doesNotMatch(row, /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/, "no border around the card");
      }
      for (const [index, line] of lines.entries()) {
        const row = block[index + 1];
        assert.ok(
          stripTerminalSequences(row).startsWith(`${" ".repeat(width - cardWidth + 2)}${line}`),
        );
        const start = width - cardWidth + 2;
        assert.ok(
          sgrWalk(row)
            .cells.slice(start, start + visibleWidth(line))
            .every((cell) => cell.fg === bodyFg && cell.bg === bubbleBg),
          "the actual body cells, including wide graphemes, carry the communication foreground",
        );
      }
      const row = rows[titleIndex + lines.length + 3];
      const cap = cardCeiling(width);
      const column = Math.max(
        cardWidth,
        Math.min(cap, visibleWidth(receipt) + 2 * communicationPadding(cap)),
      );
      const indent = width - column + communicationPadding(column);
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
  const cap = cardCeiling(width);
  const indent = width - cap + communicationPadding(cap);
  assert.equal(indent, 6, "two-cell padding on the 90% receipt column");
  const innerEdge = stripTerminalSequences(
    rows.find((row) => stripTerminalSequences(row).includes("SHORT_BODY")),
  ).indexOf("SHORT_BODY");
  const receiptStart = stripTerminalSequences(receiptRows(rows)[0]).search(/\S/u);
  assert.ok(
    receiptStart < innerEdge,
    "the receipt widens left of the card's inner edge instead of squeezing to the body",
  );
  assert.deepEqual(
    receiptRows(rows).map((row) => stripTerminalSequences(row).trimEnd()),
    ["FIRST row has words to wrap", "at narrow widths", "", `${FAMILY} 你好`, "last line"].map(
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

test("fitted prose gives back width without adding rows; receipts share that edge or widen", (t) => {
  const awkward = "alpha bravo charlie delta echo foxtrot";
  const shortReceipt = "Queued.";
  const longReceipt = "This receipt is deliberately wider than the fitted question card.";
  const content = contentOver([
    assistant([call("fit", "alert_parent", { message: awkward })]),
    result("fit", shortReceipt),
    assistant([call("wide", "ask_parent", { question: awkward })]),
    result("wide", longReceipt, false, "ask_parent"),
  ]);
  t.after(() => content.dispose());
  const width = 40;
  const cap = cardCeiling(width);
  const room = cap - 2 * communicationPadding(cap);
  const capLines = wrapTextWithAnsi(awkward, room);
  const fitted = ["alpha bravo charlie", "delta echo foxtrot"];
  assert.equal(capLines.length, fitted.length, "same row count as the 90% wrap");
  assert.notDeepEqual(capLines, fitted, "words move between rows instead of only trimming slack");
  assert.ok(capLines[0].includes("delta") && !fitted[0].includes("delta"));
  assert.equal(cap, 36);
  const rows = rowsAt(content, width);
  for (const title of ["Alert to parent", "Question to parent"]) {
    const { block } = cardBlock(rows, title);
    assert.equal(block.length, fitted.length + 2, `${title}: padding plus the fitted body`);
    for (const row of block) assertRightBackground(row, width, 23);
    assert.deepEqual(
      block.slice(1, -1).map((row) => stripTerminalSequences(row).trim()),
      fitted,
      `${title} redistributes onto the narrower card`,
    );
  }
  const alert = cardBlock(rows, "Alert to parent");
  const bodyStart = stripTerminalSequences(alert.block[1]).indexOf("alpha");
  assert.equal(bodyStart, width - 23 + 2, "body ink starts at the fitted inner edge");
  assert.equal(alert.receipt.length, 1);
  assert.equal(stripTerminalSequences(alert.receipt[0]).indexOf(shortReceipt), bodyStart);
  assert.ok(!alert.receipt[0].includes(bubbleBg), "the short receipt stays outside the card");
  const question = cardBlock(rows, "Question to parent");
  const longIndent = width - cap + communicationPadding(cap);
  assert.equal(longIndent, 6);
  assert.ok(longIndent < bodyStart, "the longer receipt widens leftward, as before");
  assert.deepEqual(
    question.receipt.map((row) => stripTerminalSequences(row).trimEnd()),
    ["This receipt is deliberately", "wider than the fitted question", "card."].map(
      (line) => " ".repeat(longIndent) + line,
    ),
  );
  assert.ok(question.receipt.every((row) => !row.includes(bubbleBg)));
});

test("unicode prose keeps the fitted edge across resize", (t) => {
  const text = `检查 ${FAMILY} alpha beta gamma delta epsilon zeta eta theta iota kappa`;
  const content = contentOver([
    assistant([call("uni", "ask_parent", { question: text })]),
    result("uni", "Ok.", false, "ask_parent"),
  ]);
  t.after(() => content.dispose());
  const paint = (width) => {
    const rows = rowsAt(content, width);
    const { block, receipt } = cardBlock(rows, "Question to parent");
    const cap = cardCeiling(width);
    const room = cap - 2 * communicationPadding(cap);
    const { cells } = sgrWalk(block[0]);
    const painted = cells.filter((cell) => cell.bg === bubbleBg).length;
    return {
      rows,
      block,
      painted,
      cap,
      body: block.slice(1, -1).map((row) => stripTerminalSequences(row).trim()),
      capLines: wrapTextWithAnsi(text, room),
      receipt: stripTerminalSequences(receipt[0] ?? ""),
    };
  };
  const at40 = paint(40);
  assert.equal(at40.painted, 28);
  assert.ok(at40.painted < at40.cap, "the card is visibly inside the ceiling");
  assert.equal(at40.body.length, at40.capLines.length);
  assert.notDeepEqual(at40.body, at40.capLines);
  assert.equal(at40.body.join("").includes(FAMILY), true);
  assert.ok(at40.body.join("").includes("检查"));
  const edge = stripTerminalSequences(at40.block[1]).search(/\S/u);
  assert.equal(edge, 40 - at40.painted + communicationPadding(at40.painted));
  assert.equal(at40.receipt.indexOf("Ok."), edge, "the short receipt shares the fitted inner edge");
  assert.ok(!at40.receipt.includes(bubbleBg));
  const at70 = paint(70);
  assert.equal(at70.painted, 37);
  assert.equal(at70.body.length, at70.capLines.length);
  assert.equal(at70.receipt.indexOf("Ok."), 70 - 37 + communicationPadding(37));
  const again = paint(40);
  assert.deepEqual(
    again.rows.map(stripTerminalSequences),
    at40.rows.map(stripTerminalSequences),
    "returning to the same width restores the fitted card",
  );
});

test("the label and an unspaced token that fits at the cap set the card's floor", () => {
  const label = "Question to parent";
  const prose = "aa bb cc dd ee ff gg hh ii jj kk ll";
  const labelCard = new CommunicationCard(
    new CommunicationLayout(label, prose),
    new CommunicationBubble(label, prose, recordingTheme()),
  );
  const labelRows = labelCard.render(40);
  const labelBg = labelRows.find((row) => row.includes(BG));
  assert.equal(sgrWalk(labelBg).cells.filter((cell) => cell.bg === BG).length, 22);
  assert.equal(
    stripTerminalSequences(labelRows[0]).trim(),
    label,
    "the title is not clipped to chase a tighter wrap",
  );
  assert.deepEqual(
    labelRows
      .filter((row) => row.includes(BG))
      .slice(1, -1)
      .map((row) => stripTerminalSequences(row).trim()),
    ["aa bb cc dd ee ff", "gg hh ii jj kk ll"],
  );

  const token = "PATH_TOKEN_ABCDEFGHIJ";
  const tokenText = `${token} xx yy zz ww vv uu`;
  const tokenCard = new CommunicationCard(
    new CommunicationLayout("Alert to parent", tokenText),
    new CommunicationBubble("Alert to parent", tokenText, recordingTheme()),
  );
  const tokenRows = tokenCard.render(40);
  const tokenBg = tokenRows.find((row) => row.includes(BG));
  assert.equal(sgrWalk(tokenBg).cells.filter((cell) => cell.bg === BG).length, 25);
  const tokenBody = tokenRows
    .filter((row) => row.includes(BG))
    .slice(1, -1)
    .map((row) => stripTerminalSequences(row).trim());
  assert.deepEqual(tokenBody, [token, "xx yy zz ww vv uu"]);
  // Splitting the token would keep the ceiling's row count, so the floor is what stops it.
  assert.equal(wrapTextWithAnsi(tokenText, 32).length, wrapTextWithAnsi(tokenText, 20).length);
  assert.ok(
    wrapTextWithAnsi(tokenText, 20).some((line) => line === "PATH_TOKEN_ABCDEFGHI"),
    "a narrower wrap would split the token without adding a row",
  );
});

test("a narrow communication receipt wraps before a word and styles complete rows", () => {
  const receipt = new CommunicationReceipt(new CommunicationLayout("Q", "a"));
  receipt.setText("a    abc", (row) => `\x1b[33m${row}\x1b[39m`);
  const rows = receipt.render(7); // Five-cell card, one-cell insets, three content cells.
  assert.deepEqual(rows, ["   \x1b[33ma\x1b[39m", "   \x1b[33mabc\x1b[39m"]);
  assert(rows.every((row) => visibleWidth(row) <= 7));
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
    const alertBlock = cardBlock(rows, "Alert to parent").block;
    const questionBlock = cardBlock(rows, "Question to parent").block;
    assert.ok(alertBlock.length > 2, "the CJK alert wraps inside its fitted card");
    // The alert gives space back under the ceiling. The payload is one unspaced
    // token wider than the room, so that card stays at the ceiling.
    for (const row of alertBlock) assertRightBackground(row, width, 28);
    for (const row of questionBlock) assertRightBackground(row, width, cardCeiling(width));
    assert.ok(28 < cardCeiling(width), "fitting gives the wrapped alert space back");
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
