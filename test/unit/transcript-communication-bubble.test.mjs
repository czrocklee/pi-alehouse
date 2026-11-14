/**
 * The child-to-parent communication display: well-formed `alert_parent` /
 * `ask_parent` calls render as Input-style message blocks over the host
 * theme's real `userMessageBg`/`userMessageText` tokens, with the recorded
 * receipt kept outside that background.
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
const { CommunicationBubble } = await jiti.import(
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
  const open = { userMessageText: "\u001b[31m", userMessageBg: "\u001b[41m" };
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
const FG = "\u001b[31m";
const FG_CLOSE = "\u001b[39m";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

test("the block paints exactly the user-message tokens, padded, framed nothing, closed per row", () => {
  const theme = recordingTheme();
  const rows = new CommunicationBubble("Alert to parent", "BODY_TEXT", theme).render(60);
  assert.equal(rows.length, 4, "one backgrounded padding row above and below the content");
  // The whole row, inner-edge padding included, carries the background, and
  // every row closes it again so the color cannot bleed into the transcript.
  assert.equal(rows[0], `${BG}${" ".repeat(60)}${BG_CLOSE}`);
  assert.equal(rows[3], rows[0]);
  // The title sits right-aligned on the first inside row (60 columns minus
  // two padding cells); the body follows left-aligned one padding cell in.
  assert.equal(rows[1], `${BG} ${" ".repeat(43)}${FG}Alert to parent${FG_CLOSE} ${BG_CLOSE}`);
  // The body's foreground opens and closes around the already-clipped,
  // content-padded row; the Box adds the last padding cell inside the background.
  assert.equal(rows[2], `${BG} ${FG}BODY_TEXT${" ".repeat(49)}${FG_CLOSE} ${BG_CLOSE}`);
  for (const row of rows) {
    assert.ok(row.startsWith(BG) && row.endsWith(BG_CLOSE), `each row closes its background`);
    assert.equal(visibleWidth(row), 60);
    assert.doesNotMatch(row, /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/, "no frame or border is drawn around the block");
  }
  for (const [kind, color] of theme.calls)
    assert.ok(
      (kind === "fg" || kind === "bg") &&
        (color === "userMessageText" || color === "userMessageBg"),
      `only the user-message tokens are requested, not ${kind} ${color}`,
    );
  assert.ok(
    !theme.calls.some(([kind]) => kind === "bold" || kind === "italic"),
    "the title is plain text, not bold or italic",
  );
});

test("recorded line breaks survive; every paragraph keeps the block background", () => {
  const rows = new CommunicationBubble(
    "Title",
    "line one\nline two\n\nline four",
    recordingTheme(),
  );
  assert.deepEqual(rows.render(20).map(stripTerminalSequences), [
    " ".repeat(20),
    `${" ".repeat(14)}Title `,
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
    " ".repeat(6),
    "    L ",
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
    for (const row of rows) {
      assert.ok(
        row.startsWith(BG) && row.endsWith(BG_CLOSE),
        `row closes its background at ${width}`,
      );
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
    " ".repeat(20),
    " A very long label… ",
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
const sgrWalk = (row) => {
  const cells = [];
  let fg = null;
  let bg = null;
  let sawReset = false;
  // eslint-disable-next-line no-control-regex -- inspect trusted theme SGR spans
  const re = /\u001b\[([0-9;]*)m/g;
  const consume = (text) => {
    for (const ch of text) cells.push({ ch, fg, bg });
  };
  let last = 0;
  let match;
  while ((match = re.exec(row)) !== null) {
    consume(row.slice(last, match.index));
    for (const param of match[1].split(";")) {
      if (param === "" || param === "0") {
        sawReset = true;
        fg = null;
        bg = null;
      } else if (param === "31" || param === "97") fg = `\u001b[${param}m`;
      else if (param === "39") fg = null;
      else if (param === "41") bg = BG;
      else if (param === "49") bg = null;
    }
    last = re.lastIndex;
  }
  consume(row.slice(last));
  return { cells, fg, bg, sawReset };
};

test("a truncated title keeps its background under the right padding: no mid-row reset", () => {
  const titles = { 8: "Alert…", 12: "Alert to …", 20: "Alert to parent" };
  for (const width of [8, 12, 20]) {
    const rows = new CommunicationBubble("Alert to parent", "BODY", recordingTheme()).render(width);
    const title = rows[1];
    const walk = sgrWalk(title);
    assert.ok(!walk.sawReset, `no hard reset inside the title row at width ${width}`);
    assert.ok(walk.cells.length > 0, `the title row has visible cells at width ${width}`);
    for (const cell of walk.cells)
      assert.equal(
        cell.bg,
        BG,
        `the background stays active under every cell, right padding included, at width ${width}`,
      );
    // The foreground paints exactly the clipped title, nothing more.
    assert.equal(
      walk.cells
        .filter((cell) => cell.fg === FG)
        .map((cell) => cell.ch)
        .join(""),
      titles[width],
      `the foreground covers the clipped title at width ${width}`,
    );
    assert.ok(
      title.lastIndexOf(FG_CLOSE) < title.lastIndexOf(BG_CLOSE),
      `the foreground closes before the row's final background close at width ${width}`,
    );
    assert.equal(walk.fg, null, `the title row leaves no foreground open at width ${width}`);
    assert.equal(walk.bg, null, `the title row leaves no background open at width ${width}`);
  }
});

test("an extreme-narrow clip still closes the body foreground inside the row", () => {
  const rows = new CommunicationBubble("L", "你好", recordingTheme()).render(1);
  // Between the block's padding rows: the title, then the body rows where the
  // two-cell graphemes were dropped whole by the width-1 clip.
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
const bubbleBgClose = hostTheme
  .bg("userMessageBg", "PROBE")
  .slice(bubbleBg.length + "PROBE".length);

test("well-formed alert and ask calls render as message blocks over the real userMessageBg", () => {
  // The dark theme gives the token a concrete sequence, distinct from the
  // generic card backgrounds, so the checks below recognize the actual
  // userMessageBg rather than just any ANSI.
  assert.ok(bubbleBg, "userMessageBg resolves to a concrete opening sequence");
  assert.ok(bubbleBgClose, "theme.bg closes the background again");
  assert.notEqual(bubbleBg, hostTheme.getBgAnsi("toolPendingBg"));
  assert.notEqual(bubbleBg, hostTheme.getBgAnsi("toolSuccessBg"));
  assert.notEqual(bubbleBg, hostTheme.getBgAnsi("toolErrorBg"));

  const messages = [
    assistant([call("a1", "alert_parent", { message: "ALERT_BODY_TEXT" })]),
    result("a1", "Alert queued. Continue working."),
    assistant([call("q1", "ask_parent", { question: "QUESTION_BODY_TEXT" })]),
    result("q1", "Question recorded. End your turn now.", false, "ask_parent"),
  ];
  const content = contentOver(messages);
  try {
    const rows = rowsAt(content);
    const block = rows.filter((row) => row.startsWith(bubbleBg));
    // Two calls, one block each: padding, title, body, padding.
    assert.equal(block.length, 8, JSON.stringify(rows));
    for (const row of block) {
      assert.ok(row.endsWith(bubbleBgClose), "every block row closes its background");
      assert.equal(visibleWidth(row), 70, "the block spans the full pane width");
      assert.doesNotMatch(row, /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]/, "no frame or border around the block");
    }
    const stripped = rows.map(stripTerminalSequences);
    for (const [label, body] of [
      ["Alert to parent", "ALERT_BODY_TEXT"],
      ["Question to parent", "QUESTION_BODY_TEXT"],
    ]) {
      const title = stripped.find((row) => row.endsWith(`${label} `));
      assert.ok(title, `${label} is the right-aligned title of its block`);
      assert.match(title, new RegExp(`^ *${label} $`), "the title row is padding plus the label");
      const bodyRow = rows.find((row) => stripTerminalSequences(row).startsWith(` ${body}`));
      assert.ok(bodyRow, `${body} is left-aligned inside its block`);
      assert.ok(bodyRow.startsWith(bubbleBg), "the body carries the block background");
    }
    for (const receipt of [
      "Alert queued. Continue working.",
      "Question recorded. End your turn now.",
    ]) {
      const row = rows.find((r) => stripTerminalSequences(r).includes(receipt));
      assert.ok(row, `${receipt} is on screen`);
      assert.ok(!row.startsWith(bubbleBg), "the receipt sits outside the message block");
    }
  } finally {
    content.dispose();
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
      assert.ok(bubble?.startsWith(bubbleBg), `${body} keeps its block`);
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
      rowsAt(content).filter((row) => row.startsWith(bubbleBg)).length,
      4,
      "the block is still painted after both toggles",
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
    const rows = rowsAt(content, 36);
    for (const row of rows) assert.ok(visibleWidth(row) <= 36, "no row overflows the pane width");
    const block = rows.filter((row) => row.startsWith(bubbleBg));
    assert.ok(block.length > 4, "the long body wraps across several block rows");
    for (const row of block) assert.ok(visibleWidth(row) === 36, "block rows fill the pane width");
    const stripped = rows.map(stripTerminalSequences).join("\n");
    for (let i = 0; i < 6; i++)
      assert.ok(stripped.includes("你"), "the CJK body survives wrapping");
    assert.equal(stripped.split(FAMILY).length - 1, 1, "the emoji cluster is never split");
    for (const raw of ["\x1b]52", "\x1b[2J", "\u2068", "\u2069"])
      assert.ok(!stripped.includes(raw), `raw ${JSON.stringify(raw)} survived into the pane`);
    assert.ok(stripped.includes("\\u2068"), "bidi isolates are explicitly escaped");
    const receipt = rows.find((row) => stripTerminalSequences(row).includes("Wrapped receipt."));
    assert.ok(receipt, "the wrapped call's receipt is on screen");
    assert.ok(!receipt.startsWith(bubbleBg), "outside the block");
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
    assert.equal(
      rows.filter((row) => row.startsWith(bubbleBg)).length,
      0,
      "no malformed or retired call gets the message block",
    );
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
