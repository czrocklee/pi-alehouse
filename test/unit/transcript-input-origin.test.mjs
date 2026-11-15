import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

// Load the production source, not a potentially stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { humanSteerLead } = await jiti.import(
  "../../src/orchestration/presentation/human-steer-text.ts",
);

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const WIDTH = 200;

/** Every label the pane can print above a user message. */
const LABELS = [
  "From parent",
  "From user",
  "Alehouse input",
  "Input",
  "Steering input (human lead)",
];

/** A pane over a fixed message list, with an optional origin lookup. */
const contentOver = (messages, inputOrigin) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
      ...(inputOrigin ? { inputOrigin } : {}),
    },
  });

// eslint-disable-next-line no-control-regex -- strip the theme's own SGR spans
const SGR = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text) => text.replace(SGR, "");

/** The pane's rows, trimmed and free of styling, so labels compare literally. */
const rowsOf = (content, width = WIDTH) =>
  content
    .slice(width, 0, content.lineCount(width))
    .map(stripAnsi)
    .map((row) => row.trim());

const paint = (content, width = WIDTH) => rowsOf(content, width).join("\n");

/** The user-message labels in painted order, which is also the assertion that
 * no other label was printed for any message. */
const labelSequence = (content, width = WIDTH) =>
  rowsOf(content, width).filter((row) => LABELS.includes(row));

const user = (text) => ({ role: "user", content: text, timestamp: 1 });

/** An origin lookup over the exact message objects, by identity. */
const origins = (map) => (message) => map.get(message);

test("each confirmed origin gets its own label, with no content inference", () => {
  const fromParent = user("PARENT_TEXT"),
    fromHuman = user("HUMAN_TEXT"),
    fromOrchestration = user("ORCHESTRATION_TEXT");
  const messages = [fromParent, fromHuman, fromOrchestration];
  const content = contentOver(
    messages,
    origins(
      new Map([
        [fromParent, "parent"],
        [fromHuman, "human"],
        [fromOrchestration, "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user", "Alehouse input"]);
    const text = paint(content);
    for (const body of ["PARENT_TEXT", "HUMAN_TEXT", "ORCHESTRATION_TEXT"])
      assert.match(text, new RegExp(body), `${body} is still shown`);
  } finally {
    content.dispose();
  }
});

test("parent and orchestration text carrying the human lead is neither relabeled nor stripped", () => {
  const lead = `${humanSteerLead}\n\nDO_NOT_STRIP`;
  const fromParent = user(lead),
    fromOrchestration = user(lead);
  const content = contentOver(
    [fromParent, fromOrchestration],
    origins(
      new Map([
        [fromParent, "parent"],
        [fromOrchestration, "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "Alehouse input"]);
    const text = paint(content);
    assert.doesNotMatch(text, /Steering input \(human lead\)/);
    assert.equal(
      text.match(/Direct message from the human user/g)?.length,
      2,
      "the lead bytes stay for both non-human origins",
    );
    assert.equal(text.match(/DO_NOT_STRIP/g)?.length, 2);
  } finally {
    content.dispose();
  }
});

test("a confirmed human origin names the speaker and drops only the exact lead", () => {
  const steered = user(`${humanSteerLead}\n\nCHANGE_TABS_TO_SPACES`),
    plain = user("PLAIN_HUMAN_TEXT"),
    quoted = user(`reminder quoting the lead: ${humanSteerLead}`);
  const messages = [steered, plain, quoted];
  const content = contentOver(
    messages,
    origins(
      new Map([
        [steered, "human"],
        [plain, "human"],
        [quoted, "human"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From user", "From user", "From user"]);
    const text = paint(content);
    assert.match(text, /CHANGE_TABS_TO_SPACES/);
    assert.match(text, /PLAIN_HUMAN_TEXT/);
    assert.equal(
      text.match(/Direct message from the human user/g)?.length,
      1,
      "only the mid-text quotation keeps the lead bytes",
    );
    assert.doesNotMatch(text, /Steering input \(human lead\)/);
  } finally {
    content.dispose();
  }
});

test("unknown, absent, throwing and unrecognized origins keep the existing labels", () => {
  const steered = () => user(`${humanSteerLead}\n\nSTEERED_BODY`);
  const cases = [
    ["absent lookup", undefined],
    ["undefined result", () => undefined],
    [
      "throwing lookup",
      () => {
        throw new Error("origin unavailable");
      },
    ],
    ["unrecognized value", () => "system"],
  ];
  for (const [name, inputOrigin] of cases) {
    const plain = user("GENERIC_TEXT"),
      lead = steered();
    const content = contentOver([plain, lead], inputOrigin);
    try {
      assert.deepEqual(
        labelSequence(content),
        ["Input", "Steering input (human lead)"],
        `${name} keeps the neutral and lead-qualified fallbacks`,
      );
      const text = paint(content);
      assert.match(text, /GENERIC_TEXT/, `${name} still renders the generic message`);
      assert.match(text, /STEERED_BODY/, `${name} still renders the lead message`);
      assert.equal(
        text.match(/Direct message from the human user/g),
        null,
        `${name} strips the exact lead prefix, as before`,
      );
    } finally {
      content.dispose();
    }
  }
});

test("identical text with different recorded origins stays distinct by message identity", () => {
  const parentCopy = user("IDENTICAL_TEXT"),
    humanCopy = user("IDENTICAL_TEXT");
  assert.notEqual(parentCopy, humanCopy);
  const received = [];
  const content = contentOver([parentCopy, humanCopy], (message) => {
    received.push(message);
    return message === parentCopy ? "parent" : message === humanCopy ? "human" : undefined;
  });
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user"]);
    assert.deepEqual(
      received,
      [parentCopy, humanCopy],
      "the lookup is asked about the exact message objects, never their text",
    );
    assert.equal(
      paint(content).match(/IDENTICAL_TEXT/g)?.length,
      2,
      "both bodies render literally",
    );
  } finally {
    content.dispose();
  }
});

test("a compaction or branch rewrite re-reads each retained message's own origin", () => {
  let messages = [user("SAME_TEXT"), user("SAME_TEXT")];
  const first = messages[0],
    second = messages[1];
  const byObject = new Map([
    [first, "parent"],
    [second, "human"],
  ]);
  let reads = 0;
  // The source reads the live binding, so a rewrite is actually observed.
  const content = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
      inputOrigin: (message) => {
        reads++;
        return byObject.get(message);
      },
    },
  });
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user"]);
    const beforeBranch = reads;

    // Branch rewrite: the same text at the same index is now a different
    // message with a different origin. Nothing may carry over from the old one.
    const branchCopy = user("SAME_TEXT");
    byObject.set(branchCopy, "human");
    messages = [branchCopy, second];
    assert.deepEqual(labelSequence(content), ["From user", "From user"]);
    assert.ok(reads > beforeBranch, "the rewritten prefix is re-read");

    // Compaction: the prefix is replaced by a summary, and the retained user
    // message keeps its own confirmed origin rather than a neutral label.
    const postCompaction = user("POST_COMPACTION_TEXT");
    byObject.set(postCompaction, "orchestration");
    messages = [
      { role: "compactionSummary", summary: "COMPACTED_SUMMARY_TEXT", tokensBefore: 12345 },
      postCompaction,
      second,
    ];
    const compacted = paint(content);
    assert.match(compacted, /COMPACTED_SUMMARY_TEXT/);
    assert.match(compacted, /POST_COMPACTION_TEXT/);
    assert.deepEqual(labelSequence(content), ["Alehouse input", "From user"]);
    assert.doesNotMatch(compacted, /Task input/);
  } finally {
    content.dispose();
  }
});

test("origin labels rewrite no source bytes and keep skills/native bodies intact", () => {
  const skillText =
    '<skill name="review" location="/skills/review.md">\nSKILL_CONTENT\n</skill>\n\nSKILL_USER_MESSAGE';
  const messages = [
    user("PARENT_TEXT"),
    user(`${humanSteerLead}\n\nHUMAN_STEER_BODY`),
    user(skillText),
  ];
  const before = structuredClone(messages);
  const content = contentOver(
    messages,
    origins(
      new Map([
        [messages[0], "parent"],
        [messages[1], "human"],
        [messages[2], "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user", "Alehouse input"]);
    const text = paint(content);
    assert.match(text, /SKILL_CONTENT/, "a skill block still renders through the SDK component");
    assert.match(text, /SKILL_USER_MESSAGE/);
    assert.deepEqual(messages, before, "rendering rewrites no source message");
  } finally {
    content.dispose();
  }
});

test("origin labels leave the pane's geometry and read anchor unchanged", () => {
  const labeled = user("ANCHORED_LABELED_TEXT"),
    assistant = { role: "assistant", content: [{ type: "text", text: "ACK" }], stopReason: "stop" };
  const messages = [labeled, assistant];
  const withOrigin = contentOver(messages, origins(new Map([[labeled, "parent"]])));
  const withoutOrigin = contentOver(messages);
  try {
    assert.deepEqual(
      rowsOf(withOrigin).length,
      rowsOf(withoutOrigin).length,
      "a label names the speaker without changing the block's height",
    );
    assert.deepEqual(labelSequence(withOrigin), ["From parent"]);
    assert.deepEqual(labelSequence(withoutOrigin), ["Input"]);

    const labelRow = rowsOf(withOrigin).indexOf("From parent");
    assert.ok(labelRow >= 0, "the label is its own row");
    const anchor = withOrigin.captureAnchor(WIDTH, labelRow);
    assert.notEqual(anchor, undefined, "a labeled user block is anchorable");
    assert.equal(
      withOrigin.resolveAnchor(WIDTH, anchor),
      labelRow,
      "the anchor round-trips to the same labeled block",
    );
    assert.equal(withOrigin.captureAnchor(WIDTH, -1), undefined);
    assert.equal(withOrigin.resolveAnchor(WIDTH, { kind: "block", offset: 0 }), undefined);
    assert.equal(
      withOrigin.lineCount(WIDTH),
      withoutOrigin.lineCount(WIDTH),
      "no chrome rows are added by a confirmed origin",
    );
  } finally {
    withOrigin.dispose();
    withoutOrigin.dispose();
  }
});
