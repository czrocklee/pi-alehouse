import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { TranscriptContent } from "../../dist/orchestration/ui/transcript.js";

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

const contentOver = (source) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source,
  });

/** A pane over a fixed message list. */
const fixedOver = (messages) =>
  contentOver({
    messages: () => messages,
    inFlight: () => undefined,
    toolDefinition: () => undefined,
  });

const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  ...extra,
});
const call = (id, name = "bash") => ({
  type: "toolCall",
  id,
  name,
  arguments: { command: "npm test" },
});
const result = (id, text, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError,
});

/** First row whose text contains the needle, or -1. */
const rowOf = (content, width, needle) => {
  const total = content.lineCount(width);
  for (let row = 0; row < total; row++)
    if ((content.slice(width, row, 1)[0] ?? "").includes(needle)) return row;
  return -1;
};

/**
 * The pane's presentation-only read anchor: the parent captures which message
 * block a row falls inside before a height-changing toggle, then resolves the
 * same block afterwards, so the first visible message survives the toggle.
 */
test("expanding a huge settled tool output keeps the held message underneath first visible", () => {
  const output = Array.from({ length: 40 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  const messages = [
    assistant([call("t1")]),
    result("t1", output),
    { role: "user", content: "HELD_USER_MESSAGE", timestamp: 9 },
  ];
  const before = structuredClone(messages);
  const content = fixedOver(messages);
  try {
    const width = 80,
      paint = () => content.slice(width, 0, content.lineCount(width)).join("\n");
    const heldRow = rowOf(content, width, "HELD_USER_MESSAGE"),
      labelRow = rowOf(content, width, "Input");
    assert.ok(heldRow > 0 && labelRow > 0, paint());

    // Capture before the toggle: the anchor remembers WHICH block the row was
    // in, plus its offset inside that block.
    const heldAnchor = content.captureAnchor(width, heldRow),
      labelAnchor = content.captureAnchor(width, labelRow);
    assert.ok(heldAnchor && labelAnchor, "both rows capture an anchor");

    content.setToolsExpanded(true);
    const resolvedHeld = content.resolveAnchor(width, heldAnchor),
      resolvedLabel = content.resolveAnchor(width, labelAnchor);
    assert.ok(resolvedHeld > heldRow, "expansion added rows above the held message");
    assert.ok(
      (content.slice(width, resolvedHeld, 1)[0] ?? "").includes("HELD_USER_MESSAGE"),
      "the held message is still the first visible message at its anchor",
    );
    assert.ok(
      (content.slice(width, resolvedLabel, 1)[0] ?? "").includes("Input"),
      "the block's own first row (its label) is preserved too",
    );

    // Collapsing back reproduces the original geometry.
    content.setToolsExpanded(false);
    assert.equal(content.resolveAnchor(width, heldAnchor), heldRow);
    assert.equal(content.resolveAnchor(width, labelAnchor), labelRow);
    assert.deepEqual(messages, before, "anchoring is a read; no source mutation");
  } finally {
    content.dispose();
  }
});

test("an anchor inside a tool block clamps to that block when it collapses", () => {
  const output = Array.from({ length: 40 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  const messages = [
    { role: "user", content: "FIRST_USER_MESSAGE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", output),
    { role: "user", content: "AFTER_USER_MESSAGE", timestamp: 9 },
  ];
  const content = fixedOver(messages);
  try {
    const width = 80;
    content.setToolsExpanded(true);
    const deepRow = rowOf(content, width, "OUT_LINE_30");
    assert.ok(deepRow > 0, "the expanded output row is on screen");
    const anchor = content.captureAnchor(width, deepRow);
    assert.ok(anchor, "a row deep inside the tool block captures");

    content.setToolsExpanded(false);
    const resolved = content.resolveAnchor(width, anchor);
    assert.equal(
      content.captureAnchor(width, resolved)?.kind,
      "block",
      "the clamped row is still inside a retained block",
    );
    const afterRow = rowOf(content, width, "AFTER_USER_MESSAGE");
    assert.ok(resolved < afterRow, "the clamp never drifts into the next message");
    assert.match(
      content.slice(width, Math.max(0, resolved - 2), 2).join("\n"),
      /more lines/,
      "it lands on the collapsed card's own last rows, not the next message",
    );

    // A card that settles between capture and resolve is the same situation:
    // the block is retained, so the anchor clamps inside it, not past it.
    const pendingMessages = [
      { role: "user", content: "PENDING_FIRST_USER", timestamp: 0 },
      assistant([call("t2")]),
    ];
    const pending = fixedOver(pendingMessages);
    try {
      const activeRow = rowOf(pending, width, "command: npm test");
      const activeAnchor = pending.captureAnchor(width, activeRow);
      assert.ok(activeAnchor, "the active card captures");
      pendingMessages.push(result("t2", "SETTLED_RESULT_MARKER"));
      pendingMessages.push({ role: "user", content: "PENDING_AFTER_USER", timestamp: 9 });
      const settled = pending.resolveAnchor(width, activeAnchor);
      assert.ok(settled !== undefined, "a retained block still resolves");
      assert.ok(
        settled < rowOf(pending, width, "PENDING_AFTER_USER"),
        "and stays inside its own message",
      );
    } finally {
      pending.dispose();
    }
  } finally {
    content.dispose();
  }
});

test("plain user and assistant text rows are stable across the toggle", () => {
  const messages = [
    { role: "user", content: "PLAIN_USER_TEXT", timestamp: 0 },
    assistant([{ type: "text", text: "PLAIN_ASSISTANT_PROSE" }], { stopReason: "stop" }),
    { role: "user", content: "PLAIN_USER_TEXT_TWO", timestamp: 2 },
  ];
  const content = fixedOver(messages);
  try {
    const width = 80,
      userRow = rowOf(content, width, "PLAIN_USER_TEXT"),
      proseRow = rowOf(content, width, "PLAIN_ASSISTANT_PROSE");
    const userAnchor = content.captureAnchor(width, userRow),
      proseAnchor = content.captureAnchor(width, proseRow);
    const before = content.slice(width, 0, content.lineCount(width)).join("\n");
    for (const expanded of [true, false, true]) {
      content.setToolsExpanded(expanded);
      assert.equal(content.resolveAnchor(width, userAnchor), userRow);
      assert.equal(content.resolveAnchor(width, proseAnchor), proseRow);
    }
    // Reads: the pane paints identically and nothing was mutated.
    assert.equal(content.slice(width, 0, content.lineCount(width)).join("\n"), before);
  } finally {
    content.dispose();
  }
});

test("the streaming tail anchors by component identity", () => {
  const settled = [{ role: "user", content: "TAIL_BASE_MESSAGE", timestamp: 0 }];
  let streaming = {
    role: "assistant",
    content: [{ type: "text", text: "STREAMING_REPLY_TEXT" }],
  };
  const content = contentOver({
    messages: () => settled,
    inFlight: () => streaming,
    toolDefinition: () => undefined,
  });
  try {
    const width = 80;
    const row = rowOf(content, width, "STREAMING_REPLY_TEXT");
    assert.ok(row >= 0, "the streaming reply is on screen");
    const anchor = content.captureAnchor(width, row);
    assert.ok(anchor, "a tail row captures");
    const resolved = content.resolveAnchor(width, anchor);
    assert.equal(resolved, row, "the same streaming component resolves to the same row");
    assert.ok(
      (content.slice(width, resolved, 1)[0] ?? "").includes("STREAMING_REPLY_TEXT"),
      "the resolved row is still the streaming reply",
    );
    // The reply grew: the anchor keeps pointing at its block, clamped inside it.
    streaming = {
      role: "assistant",
      content: [{ type: "text", text: "STREAMING_REPLY_TEXT\nMORE_STREAMING_ROWS" }],
    };
    const grown = content.resolveAnchor(width, anchor);
    assert.ok(grown !== undefined, "the same component still resolves");
    // Streaming ended: the component is gone, so there is no position to keep.
    streaming = undefined;
    content.slice(width, 0, content.lineCount(width));
    assert.equal(
      content.resolveAnchor(width, anchor),
      undefined,
      "a finished stream leaves the anchor with nothing to point at",
    );
  } finally {
    content.dispose();
  }
});

test("invalid, forged and out-of-range anchors resolve to nothing", () => {
  const messages = [
    { role: "user", content: "INVALID_ANCHOR_BASE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "DONE_MARKER"),
  ];
  const content = fixedOver(messages);
  try {
    const width = 80;
    const row = rowOf(content, width, "DONE_MARKER"),
      anchor = content.captureAnchor(width, row);
    assert.ok(anchor, "a valid anchor captures first");
    for (const bad of [
      undefined,
      null,
      42,
      "anchor",
      {},
      { kind: "block", offset: 0, target: {} },
      { kind: "block", offset: -1, target: {} },
      { kind: "nope", offset: 0, target: null },
      { kind: "inFlight", offset: 0, target: {} },
      { kind: "block", offset: 0.5, target: {} },
      { kind: "block", target: {} },
    ])
      assert.equal(content.resolveAnchor(width, bad), undefined, `anchor ${JSON.stringify(bad)}`);
    // A zero width or a non-integer/negative/out-of-content row captures nothing.
    assert.equal(content.captureAnchor(0, row), undefined);
    assert.equal(content.captureAnchor(width, -1), undefined);
    assert.equal(content.captureAnchor(width, 1.5), undefined);
    assert.equal(content.captureAnchor(width, content.lineCount(width) + 50), undefined);
    // The one valid anchor still resolves after all that.
    assert.ok(content.resolveAnchor(width, anchor) !== undefined);
  } finally {
    content.dispose();
  }
});

test("anchors are scoped to the pane and its retained history", () => {
  const messages = [
    { role: "user", content: "SCOPE_FIRST_MESSAGE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "DONE_MARKER"),
    { role: "user", content: "SCOPE_HELD_MESSAGE", timestamp: 9 },
  ];
  // Cross-pane: the same source rows, but a different pane's blocks.
  const mine = fixedOver(messages),
    theirs = fixedOver(messages);
  try {
    const width = 80,
      row = rowOf(mine, width, "SCOPE_HELD_MESSAGE"),
      anchor = mine.captureAnchor(width, row);
    assert.ok(anchor, "my pane captures");
    assert.equal(
      theirs.resolveAnchor(width, anchor),
      undefined,
      "another pane has no block with that identity",
    );
    assert.ok(mine.resolveAnchor(width, anchor) !== undefined, "my own pane still resolves");

    // Compacted/branched away: the rewrite rebuilds every block, so the old
    // block object is no longer retained and no position is invented.
    let history = messages;
    const rewritten = contentOver({
      messages: () => history,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
    });
    try {
      const anchor2 = rewritten.captureAnchor(width, rowOf(rewritten, width, "SCOPE_HELD_MESSAGE"));
      assert.ok(anchor2, "captures before the rewrite");
      history = [
        { role: "compactionSummary", summary: "REWRITE_SUMMARY", tokensBefore: 12345 },
        { role: "user", content: "REWRITTEN_LATER_MESSAGE", timestamp: 20 },
      ];
      rewritten.slice(width, 0, rewritten.lineCount(width));
      assert.equal(
        rewritten.resolveAnchor(width, anchor2),
        undefined,
        "an anchor into compacted-away history resolves to nothing",
      );
    } finally {
      rewritten.dispose();
    }
  } finally {
    mine.dispose();
    theirs.dispose();
  }
});

test("frame anchor closures never resample the source", () => {
  const output = Array.from({ length: 30 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  let streaming = {
    role: "assistant",
    content: [{ type: "text", text: "FRAME_STREAMING_TEXT" }],
  };
  const messages = [
    { role: "user", content: "FRAME_FIRST_MESSAGE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", output),
    { role: "user", content: "FRAME_HELD_MESSAGE", timestamp: 9 },
  ];
  let messageReads = 0,
    inFlightReads = 0;
  const content = contentOver({
    messages: () => {
      messageReads++;
      return messages;
    },
    inFlight: () => {
      inFlightReads++;
      return streaming;
    },
    toolDefinition: () => undefined,
  });
  try {
    // One frame: one settled sample and one tail sample, like every paint.
    const frame = content.frame(80);
    assert.equal(frame.lineCount, content.lineCount(80));
    const reads = [messageReads, inFlightReads];
    // Any number of anchor reads and resolves on that frame cost no sample.
    const anchors = [0, 5, 20, frame.lineCount - 1].map((row) => frame.anchorAt(row));
    for (const anchor of anchors) frame.resolveAnchor(anchor);
    frame.resolveAnchor(undefined);
    frame.resolveAnchor({ kind: "block", offset: 0, target: {} });
    frame.anchorAt(-1);
    frame.slice(0, frame.lineCount);
    assert.deepEqual(
      [messageReads, inFlightReads],
      reads,
      "anchorAt/resolveAnchor/slice on a held frame never reread the source",
    );
    // A new frame is a new sample — that is the paint, not the anchor reads.
    content.frame(80);
    assert.equal(messageReads, reads[0] + 1);
    assert.equal(inFlightReads, reads[1] + 1);

    // The anchors a frame produces are the same opaque values the pane-wide
    // helpers accept, and vice versa.
    const heldRow = rowOf(content, 80, "FRAME_HELD_MESSAGE");
    const frameAnchor = frame.anchorAt(heldRow),
      helperAnchor = content.captureAnchor(80, heldRow);
    assert.ok(frameAnchor && helperAnchor);
    assert.equal(content.resolveAnchor(80, frameAnchor), heldRow);
    assert.equal(frame.resolveAnchor(helperAnchor), heldRow);
  } finally {
    content.dispose();
  }
});

test("frame closures keep their scope when the source changes under them", () => {
  let history = [
    { role: "user", content: "SCOPE_FRAME_FIRST", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "FRAME_DONE_MARKER"),
    { role: "user", content: "SCOPE_FRAME_HELD", timestamp: 9 },
  ];
  const content = contentOver({
    messages: () => history,
    inFlight: () => undefined,
    toolDefinition: () => undefined,
  });
  try {
    const width = 80;
    const painted = content.frame(width);
    const heldRow = rowOf(content, width, "SCOPE_FRAME_HELD");
    const anchor = painted.anchorAt(heldRow);
    assert.ok(anchor, "the painted frame captures the held message");

    // The history is rewritten after that paint. The old frame keeps its own
    // scope — its closures still answer from its captured snapshot — while a
    // fresh frame of the rewritten history no longer contains that block.
    history = [
      { role: "compactionSummary", summary: "FRAME_REWRITE_SUMMARY", tokensBefore: 12345 },
      { role: "user", content: "FRAME_REWRITTEN_LATER", timestamp: 20 },
    ];
    const repainted = content.frame(width);
    assert.equal(
      repainted.resolveAnchor(anchor),
      undefined,
      "a rewritten history has no block with the old frame's identity",
    );
    const stillScoped = painted.resolveAnchor(anchor);
    assert.equal(
      stillScoped,
      heldRow,
      "the old frame keeps answering from its own captured snapshot",
    );
  } finally {
    content.dispose();
  }
});

test("a non-positive width has no stale blocks to anchor into", () => {
  const messages = [
    { role: "user", content: "STALE_WIDTH_FIRST", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "STALE_WIDTH_DONE"),
  ];
  const content = fixedOver(messages);
  try {
    // Paint wide first, so blocks and rows exist to be stale about.
    const wide = content.frame(80);
    const anchor = wide.anchorAt(0);
    assert.ok(anchor, "the wide frame captures");
    const empty = content.frame(0);
    assert.equal(empty.lineCount, 0);
    assert.equal(empty.anchorAt(0), undefined, "no block exists at width 0");
    assert.equal(
      empty.resolveAnchor(anchor),
      undefined,
      "an anchor does not resolve against a zero-width frame",
    );
    assert.equal(content.captureAnchor(0, 0), undefined);
    assert.equal(content.resolveAnchor(0, anchor), undefined);
  } finally {
    content.dispose();
  }
});

test("an unchanged settled history reuses the block index across frames", (t) => {
  const messages = [
    { role: "user", content: "INDEX_FIRST_MESSAGE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "INDEX_DONE_MARKER"),
    { role: "user", content: "INDEX_HELD_MESSAGE", timestamp: 9 },
  ];
  let streaming = {
    role: "assistant",
    content: [{ type: "text", text: "INDEX_STREAM_START" }],
  };
  const content = contentOver({
    messages: () => messages,
    inFlight: () => streaming,
    toolDefinition: () => undefined,
  });
  t.after(() => content.dispose());
  // The pane reindexes its settled blocks only when the settled rows array is
  // rebuilt; a repaint — streaming tokens included — must reuse it.
  const builds = t.mock.method(TranscriptContent.prototype, "buildBlockLayout");
  content.frame(80);
  assert.equal(builds.mock.callCount(), 1, "the first frame builds the index once");
  for (const token of ["INDEX_TOKEN_A", "INDEX_TOKEN_B", "INDEX_TOKEN_C"]) {
    streaming = { role: "assistant", content: [{ type: "text", text: token }] };
    const frame = content.frame(80);
    assert.ok(
      frame.slice(0, frame.lineCount).join("\n").includes(token),
      "the streaming tail stays fresh",
    );
  }
  assert.equal(
    builds.mock.callCount(),
    1,
    "streaming repaints reuse the settled block index without reindexing",
  );
  const anchor = content.frame(80).anchorAt(2);
  assert.ok(anchor, "anchors still capture on a reused index");
  assert.equal(builds.mock.callCount(), 1);
  // A height-changing toggle replaces the settled rows: exactly one rebuild.
  content.setToolsExpanded(true);
  content.frame(80);
  assert.equal(builds.mock.callCount(), 2, "the toggle reindexes once");
  // New settled content replaces them again: exactly one rebuild.
  messages.push({ role: "user", content: "INDEX_APPENDED_MESSAGE", timestamp: 30 });
  content.frame(80);
  assert.equal(builds.mock.callCount(), 3, "appended content reindexes once");
});

test("every painted row anchors and resolves back to itself", () => {
  // A mixed transcript: user, settled tool card, user, compaction summary,
  // user — so the row search crosses blocks of very different heights,
  // including block boundaries.
  const messages = [
    { role: "user", content: "ROUND_FIRST_MESSAGE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "ROUND_RESULT_MARKER"),
    { role: "user", content: "ROUND_MIDDLE_MESSAGE", timestamp: 5 },
    { role: "compactionSummary", summary: "ROUND_SUMMARY_TEXT", tokensBefore: 999 },
    { role: "user", content: "ROUND_LAST_MESSAGE", timestamp: 9 },
  ];
  const content = fixedOver(messages);
  try {
    for (const expanded of [false, true]) {
      content.setToolsExpanded(expanded);
      const frame = content.frame(80);
      for (let row = 0; row < frame.lineCount; row++) {
        const anchor = frame.anchorAt(row);
        assert.ok(anchor !== undefined, `row ${row} captures an anchor`);
        assert.equal(
          frame.resolveAnchor(anchor),
          row,
          `row ${row} resolves back to exactly itself`,
        );
      }
    }
  } finally {
    content.dispose();
  }
});

test("capture works before any paint and across a width change", () => {
  const output = Array.from({ length: 30 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  const messages = [
    assistant([call("t1")]),
    result("t1", output),
    { role: "user", content: "WIDTH_HELD_MESSAGE", timestamp: 9 },
  ];
  const content = fixedOver(messages);
  try {
    // No slice/lineCount yet: capture itself renders what it needs to read.
    // Row 0 is the first block's own first row, so it stays row 0 after the
    // toggle grows the card below it.
    const anchor = content.captureAnchor(80, 0);
    assert.ok(anchor, "capturing before any paint works");
    content.setToolsExpanded(true);
    assert.equal(content.resolveAnchor(80, anchor), 0, "resolves after the toggle");
    // A different width re-wraps the same retained block; the anchor follows it.
    assert.equal(content.resolveAnchor(60, anchor), 0, "the same block resolves at a new width");
    // And a row captured inside the held message follows it across a width
    // change too: same block, re-wrapped.
    const heldRow = rowOf(content, 80, "WIDTH_HELD_MESSAGE");
    const heldAnchor = content.captureAnchor(80, heldRow);
    const narrow = content.resolveAnchor(60, heldAnchor);
    assert.ok(narrow !== undefined, "the held message's block resolves at a new width");
    assert.ok(
      content.slice(60, narrow, 8).join("\n").includes("WIDTH_HELD"),
      "the resolved position is still inside the held message's block",
    );
  } finally {
    content.dispose();
  }
});
