import assert from "node:assert/strict";
import test from "node:test";
import {
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { TranscriptContent } from "../../dist/orchestration/ui/transcript.js";
import { humanSteerLead } from "../../dist/orchestration/runtime/human-steer.js";

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

/** A pane over a fixed message list, read back as the text it would paint. */
const paneOver = (messages, width = 80) => {
  const content = contentOver(messages);
  return () => content.slice(width, 0, content.lineCount(width)).join("\n");
};

/** The pane itself, for tests that drive its presentation-only controls. */
const contentOver = (messages) => {
  const content = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
    },
  });
  return content;
};

test("a branch rewrite before an unchanged last message replaces the consumed prefix", () => {
  const last = { role: "user", content: "UNCHANGED_LAST_MESSAGE", timestamp: 1 };
  let messages = [{ role: "user", content: "OLD_BRANCH_PREFIX", timestamp: 0 }, last];
  const content = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
    },
  });
  try {
    let frame = content.frame(120);
    assert.match(frame.slice(0, frame.lineCount).join("\n"), /OLD_BRANCH_PREFIX/);
    messages = [{ role: "user", content: "NEW_BRANCH_PREFIX", timestamp: 2 }, last];
    frame = content.frame(120);
    const text = frame.slice(0, frame.lineCount).join("\n");
    assert.match(text, /NEW_BRANCH_PREFIX/);
    assert.match(text, /UNCHANGED_LAST_MESSAGE/);
    assert.doesNotMatch(text, /OLD_BRANCH_PREFIX/);
  } finally {
    content.dispose();
  }
});

const call = (id, name = "bash") => ({
  type: "toolCall",
  id,
  name,
  arguments: { command: "npm test" },
});
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  ...extra,
});

test("historical notification/progress/send-answer data renders literally without mutation", () => {
  const messages = [
    assistant([
      {
        type: "toolCall",
        id: "old-notify",
        name: "notify_parent",
        arguments: { message: "OLD_NOTICE" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "old-notify",
      toolName: "notify_parent",
      content: [{ type: "text", text: "OLD_NOTICE_RECORDED" }],
      isError: false,
    },
    assistant([
      {
        type: "toolCall",
        id: "old-send",
        name: "agent_send",
        arguments: { agent: "otter", message: "answer" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "old-send",
      toolName: "agent_send",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            delivery: "answered",
            agent: "otter",
            status: "completed",
            progress: ["OLD_PROGRESS"],
          }),
        },
      ],
      isError: false,
    },
  ];
  const before = structuredClone(messages),
    render = paneOver(messages, 160); // Keep literal markers clear of line wrapping.
  for (let paint = 0; paint < 2; paint++) {
    const text = render();
    for (const literal of ["notify_parent", "OLD_NOTICE", "answered", "progress", "OLD_PROGRESS"])
      assert.ok(text.includes(literal), text);
    assert.doesNotMatch(text, /alert_parent|question_id|alerts_pending/);
  }
  assert.deepEqual(
    messages,
    before,
    "rendering does not rewrite historical records or hydrate live communication",
  );
});

test("a tool call still waiting for its result keeps rendering as pending", () => {
  const text = paneOver([assistant([call("t1")])])();
  assert.match(text, /npm test/, "the call itself is on screen");
  assert.doesNotMatch(text, /aborted|Error/i, "nothing has failed yet");
});

/**
 * Pi's assistant component prints no abort/error text when the message carries
 * tool calls -- it delegates that to the cards. A card that never finalizes
 * therefore spins forever AND swallows the only report of the failure.
 */
test("a call interrupted mid-generation finalizes instead of spinning forever", () => {
  const aborted = paneOver([assistant([call("t1")], { stopReason: "aborted" })])();
  assert.match(aborted, /Operation aborted/, "the abort is reported on the card Pi defers to");

  const failed = paneOver([
    assistant([call("t1")], { stopReason: "error", errorMessage: "overloaded_error" }),
  ])();
  assert.match(failed, /overloaded_error/, "a provider error reaches the card verbatim");

  const bare = paneOver([assistant([call("t1")], { stopReason: "error" })])();
  assert.match(bare, /Error/, "an error with no message still says so");
});

test("a result that does arrive still finalizes its own card and no other", () => {
  const text = paneOver([
    assistant([call("t1"), call("t2", "read")]),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "TESTS_PASSED" }],
      isError: false,
    },
  ])();
  // Once, on one card: applying a result to every pending call would print it
  // twice and finalize a read that is still waiting for its own answer.
  assert.equal(text.match(/TESTS_PASSED/g)?.length, 1, text);
  assert.match(text, /npm test/, "the answered call keeps its own header");
  assert.match(text, /read/, "and the unanswered one is still on screen");
  assert.doesNotMatch(text, /Operation aborted/);

  // The same list with nothing answered: the bash card carries no result, which
  // is what makes the single match above a real pin rather than an accident.
  const pending = paneOver([assistant([call("t1"), call("t2", "read")])])();
  assert.doesNotMatch(pending, /TESTS_PASSED/);
});

const result = (id, text, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError,
});

test("settled successful cards collapse by default and follow the pane's toggle", () => {
  const output = Array.from({ length: 15 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  const messages = [assistant([call("t1")]), result("t1", output)];
  const content = contentOver(messages);
  try {
    const paint = () => content.slice(160, 0, content.lineCount(160)).join("\n");
    const collapsed = paint();
    assert.match(collapsed, /command="npm test"/, "collapsed shows the bounded argument preview");
    assert.doesNotMatch(collapsed, /command: npm test/, "not the expanded key-value form");
    assert.match(collapsed, /OUT_LINE_9/, "the collapsed result keeps its preview lines");
    assert.match(collapsed, /5 more lines/, "and says the rest is hidden");
    assert.doesNotMatch(collapsed, /OUT_LINE_14/);
    const collapsedRows = content.lineCount(160);

    content.setToolsExpanded(true);
    const expanded = paint();
    assert.match(expanded, /command: npm test/, "expanded shows the full argument form");
    assert.match(expanded, /OUT_LINE_14/, "and the whole result");
    assert.doesNotMatch(expanded, /more lines/);
    const expandedRows = content.lineCount(160);
    assert.ok(
      collapsedRows < expandedRows,
      `collapsed ${collapsedRows} rows < expanded ${expandedRows} rows`,
    );

    content.setToolsExpanded(false);
    assert.equal(paint(), collapsed, "toggling back reproduces the collapsed rows");
  } finally {
    content.dispose();
  }
});

test("active and failed cards stay expanded whatever the pane's mode says", () => {
  // Still waiting for its result: full arguments even in collapsed mode.
  const active = contentOver([assistant([call("t1")])]);
  try {
    const paint = () => active.slice(160, 0, active.lineCount(160)).join("\n");
    assert.match(paint(), /command: npm test/, "an incomplete card is expanded");
    active.setToolsExpanded(false);
    assert.match(paint(), /command: npm test/, "and the collapsed mode cannot hide it");
  } finally {
    active.dispose();
  }

  // A failed result: expanded, with the error text visible.
  const failed = contentOver([
    assistant([call("t1")]),
    result("t1", "COMMAND_FAILED_MARKER", true),
  ]);
  try {
    const paint = () => failed.slice(160, 0, failed.lineCount(160)).join("\n");
    const text = paint();
    assert.match(text, /command: npm test/, "a failed card is expanded");
    assert.match(text, /COMMAND_FAILED_MARKER/, "and its error stays visible");
    failed.setToolsExpanded(false);
    assert.match(paint(), /COMMAND_FAILED_MARKER/, "the collapsed mode keeps errors visible");
  } finally {
    failed.dispose();
  }

  // A generation that died mid-call: the card itself reports the failure.
  const aborted = paneOver([assistant([call("t1")], { stopReason: "aborted" })], 160)();
  assert.match(aborted, /command: npm test/, "the interrupted card is expanded");
  assert.match(aborted, /Operation aborted/);
});

test("cards that settle while the pane is open follow the pane's mode", () => {
  const messages = [assistant([call("t1")])];
  const content = contentOver(messages);
  try {
    const paint = () => content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.match(paint(), /command: npm test/, "a fresh card starts expanded");
    messages.push(result("t1", "DONE_MARKER"));
    assert.match(
      paint(),
      /command="npm test"/,
      "a successful result collapses the card in the default mode",
    );
    assert.doesNotMatch(paint(), /command: npm test/);
    content.setToolsExpanded(true);
    assert.match(paint(), /command: npm test/, "the expanded mode is honored as cards settle");
  } finally {
    content.dispose();
  }
});

test("user messages get neutral labels; only the exact steering lead is qualified", () => {
  const steered = `${humanSteerLead}\n\nCHANGE_TABS_TO_SPACES`;
  const messages = [
    { role: "user", content: "INITIAL_TASK_TEXT", timestamp: 0 },
    assistant([{ type: "text", text: "ack" }], { stopReason: "stop" }),
    { role: "user", content: steered, timestamp: 2 },
    { role: "user", content: `reminder quoting the lead: ${humanSteerLead}`, timestamp: 3 },
  ];
  const before = structuredClone(messages);
  const text = paneOver(messages, 160)();
  assert.doesNotMatch(text, /Task input/, "no user message is labeled as the task input");
  assert.equal(
    text.match(/Input/g)?.length,
    2,
    "every generic user message gets the same neutral Input label",
  );
  assert.match(text, /Steering input \(human lead\)/, "the exact lead gets its qualified label");
  assert.match(text, /CHANGE_TABS_TO_SPACES/, "the steered text itself is shown");
  // The lead's boilerplate is dropped for the exact prefix, and only there: the
  // fourth message merely quotes it, so it renders byte-literally as plain input.
  assert.equal(
    text.match(/Direct message from the human user/g)?.length,
    1,
    "only the non-prefixed message shows the lead bytes",
  );
  assert.match(text, /reminder quoting the lead:/, "a quoted lead is not stripped");
  assert.deepEqual(messages, before, "rendering rewrites no source bytes");
});

test("a compaction or branch rewrite never relabels a remaining user message", () => {
  // Compaction: the source history is replaced by a summary plus a later
  // user message. The first user message the pane now renders is NOT the
  // original task input, and the pane must not claim it was.
  let messages = [
    { role: "user", content: "ORIGINAL_TASK_TEXT", timestamp: 0 },
    assistant([{ type: "text", text: "work" }], { stopReason: "stop" }),
  ];
  const content = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
    },
  });
  try {
    const paint = () => content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.match(paint(), /ORIGINAL_TASK_TEXT/);
    messages = [
      { role: "compactionSummary", summary: "COMPACTED_SUMMARY_TEXT", tokensBefore: 12345 },
      { role: "user", content: "POST_COMPACTION_MESSAGE", timestamp: 1 },
    ];
    const compacted = paint();
    assert.match(compacted, /POST_COMPACTION_MESSAGE/, "the remaining user message renders");
    assert.doesNotMatch(
      compacted,
      /Task input/,
      "the first user message after a compaction is not relabeled as the task input",
    );
    assert.match(compacted, /Input/, "it keeps the neutral label");

    // A branch rewrite is the same situation from the other direction.
    messages = [
      { role: "user", content: "BRANCH_TASK_TEXT", timestamp: 2 },
      { role: "user", content: "BRANCH_SECOND_MESSAGE", timestamp: 3 },
    ];
    const branched = paint();
    assert.doesNotMatch(branched, /Task input/, "a branched history labels nothing as task input");
    assert.equal(
      branched.match(/Input/g)?.length,
      2,
      "every generic user message keeps the same neutral label",
    );
  } finally {
    content.dispose();
  }
});

test("current communication tools get labeled blocks; malformed and retired names stay raw", () => {
  const messages = [
    assistant([
      {
        type: "toolCall",
        id: "a1",
        name: "alert_parent",
        arguments: { message: "ALERT_TEXT_SENT" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "a1",
      toolName: "alert_parent",
      content: [{ type: "text", text: "Alert queued. Continue working." }],
      isError: false,
    },
    assistant([
      {
        type: "toolCall",
        id: "q1",
        name: "ask_parent",
        arguments: { question: "QUESTION_TEXT_SENT" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "q1",
      toolName: "ask_parent",
      content: [
        { type: "text", text: "Question recorded. Stop calling tools and end your turn now." },
      ],
      isError: false,
    },
    // Malformed: the recognized name with a non-string argument.
    assistant([{ type: "toolCall", id: "m1", name: "alert_parent", arguments: { message: 42 } }]),
    // Retired literal name from history.
    assistant([
      { type: "toolCall", id: "old", name: "notify_parent", arguments: { message: "OLD_NOTICE" } },
    ]),
  ];
  const before = structuredClone(messages);
  const text = paneOver(messages, 200)();
  assert.match(text, /Alert to parent/, "a well-formed alert gets its labeled block");
  assert.match(text, /ALERT_TEXT_SENT/);
  assert.match(text, /Question to parent/, "and a well-formed question too");
  assert.match(text, /QUESTION_TEXT_SENT/);
  assert.match(text, /Alert queued\. Continue working\./, "the recorded receipt is preserved");
  assert.match(
    text,
    /Question recorded\. Stop calling tools and end your turn now\./,
    "including the question receipt, verbatim",
  );
  assert.doesNotMatch(
    text,
    /read by parent|seen by parent|delivered to parent|acknowledged/i,
    "the pane adds no receipt claim of its own",
  );
  // The labeled blocks replace the bare JSON card for the well-formed calls only.
  assert.equal(text.match(/Alert to parent/g)?.length, 1, text);
  assert.equal(text.match(/Question to parent/g)?.length, 1, text);
  assert.match(text, /alert_parent/, "a malformed call keeps the raw tool name");
  assert.match(text, /message: 42/, "and its raw argument data");
  assert.match(text, /notify_parent/, "a retired name stays raw");
  assert.match(text, /OLD_NOTICE/);
  assert.deepEqual(messages, before, "rendering hydrates nothing and rewrites no record");
});

test("the expansion toggle re-renders only blocks that hold tool cards", (t) => {
  const messages = [
    { role: "user", content: "USER_BLOCK_ONE", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "DONE_MARKER"),
    { role: "user", content: "USER_BLOCK_TWO", timestamp: 3 },
  ];
  const content = contentOver(messages);
  t.after(() => content.dispose());
  const users = t.mock.method(
    UserMessageComponent.prototype,
    "render",
    UserMessageComponent.prototype.render,
  );
  const cards = t.mock.method(
    ToolExecutionComponent.prototype,
    "render",
    ToolExecutionComponent.prototype.render,
  );
  const paint = () => content.slice(160, 0, content.lineCount(160)).join("\n");
  paint();
  const userRenders = users.mock.callCount(),
    cardRenders = cards.mock.callCount();
  content.setToolsExpanded(true);
  paint();
  assert.equal(
    users.mock.callCount(),
    userRenders,
    "user blocks keep their cached rows across the toggle",
  );
  assert.ok(cards.mock.callCount() > cardRenders, "the tool card re-renders for the new mode");
  const afterToggle = cards.mock.callCount();
  content.setToolsExpanded(true);
  paint();
  assert.equal(cards.mock.callCount(), afterToggle, "a same-value toggle invalidates nothing");
});

test("terminal protocols, bidi controls and emoji in tool data are neutralized for display", () => {
  const osc52 = `\x1b]52;c;CLIPBOARD_PAYLOAD\x07`,
    csi = "\x1b[2J",
    unterminated = "\x1b]8;;http://unterminated.example",
    c1Osc = "\u009d52;c;C1_PAYLOAD",
    bidi = "R\u2068everse\u2069",
    emoji = "\u{1F44D} ok \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
    payload = `START${osc52}${csi}${unterminated}${c1Osc}${bidi}${emoji}END`;
  const messages = [
    assistant([
      { type: "toolCall", id: "a1", name: "alert_parent", arguments: { message: payload } },
    ]),
    {
      role: "toolResult",
      toolCallId: "a1",
      toolName: "alert_parent",
      content: [
        { type: "text", text: `RESULT_${payload}` },
        { type: "text", text: "PART_TWO" },
      ],
      isError: false,
    },
    // A generic card: pending, so its expanded raw-argument form is on screen,
    // under a tool name that itself carries a control character.
    assistant([
      {
        type: "toolCall",
        id: "g1",
        name: "weird\x07tool",
        arguments: { command: payload },
      },
    ]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const text = content.slice(200, 0, content.lineCount(200)).join("\n");
    for (const raw of ["\x1b]52", "\x1b[2J", "\x1b]8", "\u009d", "\u2068", "\u2069"])
      assert.ok(!text.includes(raw), `raw ${JSON.stringify(raw)} survived into the pane`);
    assert.ok(
      text.includes("\\u2068"),
      "bidi isolates are explicitly escaped, not silently dropped",
    );
    assert.ok(text.includes("weird\\x07tool"), "a control character in a tool name is escaped");
    assert.ok(
      text.includes("\u{1F44D}") &&
        text.includes("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"),
      "emoji and grapheme clusters survive sanitization",
    );
    assert.match(text, /command: START/, "the generic card's expanded arguments are sanitized");
    assert.match(text, /END[^\n]*\n/, "the communication result's blocks join with a newline");
    assert.match(text, /\n[^\n]*PART_TWO/, "so separate text blocks stay separate lines");
    assert.match(text, /Alert to parent/, "the labeled block itself still renders");
    assert.deepEqual(
      messages,
      before,
      "sanitization is a detached projection; the recorded source is untouched",
    );
  } finally {
    content.dispose();
  }
});

test("a theme rebuild keeps the pane's expansion mode and labels", () => {
  const messages = [
    { role: "user", content: "THEME_TASK_INPUT", timestamp: 0 },
    assistant([call("t1")]),
    result("t1", "DONE_MARKER"),
  ];
  const content = contentOver(messages);
  try {
    const paint = () => content.slice(160, 0, content.lineCount(160)).join("\n");
    content.setToolsExpanded(true);
    assert.match(paint(), /command: npm test/);
    content.setTheme({ ...getMarkdownTheme() });
    const text = paint();
    assert.match(text, /command: npm test/, "the expanded mode survives the rebuild");
    assert.match(text, /Input/, "and so do the neutral labels");
  } finally {
    content.dispose();
  }
});
