/** Review03 display regressions over public TranscriptContent and the real SDK
 * theme. Run with shell-isolated HOME/XDG/PI_CODING_AGENT_DIR before imports.
 * No tool execution, child session, provider, network, host or PTY is involved.
 * Source is loaded directly with jiti, never dist or an on-disk jiti cache. */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

// The real theme's token colors must be distinct for background classification;
// do not let headless 256-color quantization alias userMessageBg/toolSuccessBg.
setCapabilityOverrides({ trueColor: true });
initTheme("dark", false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { COMMUNICATION_LIMITS } = await jiti.import(
  "../../src/orchestration/core/communication-envelope.ts",
);

const tui = { requestRender() {}, terminal: { columns: 100, rows: 30 } };
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
const contentOver = (messages, toolDefinition = () => undefined) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: typeof messages === "function" ? messages : () => messages,
      inFlight: () => undefined,
      toolDefinition,
    },
  });
const rowsAt = (content, width = 100) => content.slice(width, 0, content.lineCount(width));
const plainRows = (rows) => rows.map(stripTerminalSequences);
const screen = (rows) => plainRows(rows).join("\n");
const pane = (t, messages, lookup) => {
  const content = contentOver(messages, lookup);
  t.after(() => content.dispose());
  return content;
};

// Capture only the public Theme instance handed to an ordinary tool renderer,
// as in transcript-communication-bubble.test.mjs; no private singleton imports.
let hostTheme;
{
  const capture = contentOver([assistant([call("probe", "probe_theme", {})])], () => ({
    renderCall: (_args, theme) => {
      hostTheme = theme;
      return { render: () => ["PROBE"], invalidate() {} };
    },
  }));
  try {
    rowsAt(capture);
  } finally {
    capture.dispose();
  }
}
const bubbleBg = hostTheme.getBgAnsi("userMessageBg");
const pendingBg = hostTheme.getBgAnsi("toolPendingBg");
const errorOpen = hostTheme.fg("error", "PROBE").split("PROBE")[0];
const bubbleRows = (rows) => rows.filter((row) => row.startsWith(bubbleBg));
const noResult = "No recorded result";
const noticeRows = (rows) => rows.filter((row) => stripTerminalSequences(row).includes(noResult));
const tools = [
  { name: "alert_parent", key: "message", title: "Alert to parent" },
  { name: "ask_parent", key: "question", title: "Question to parent" },
];

// F1: Literal expectations, not an oracle calling the encoder under test.
const bodyCases = [
  {
    label: "real BEL differs from its literal escape spelling",
    tool: tools[0],
    raw: "A\x07B | literal \\x07",
    expected: ["A\\x07B | literal \\\\x07"],
  },
  {
    label: "OSC52 and CSI payloads stay visible rather than disappearing",
    tool: tools[1],
    raw: "O\x1b]52;c;CLIPBOARD_PAYLOAD\x07C\x1b[2JD\u009b31mE",
    expected: ["O\\x1b]52;c;CLIPBOARD_PAYLOAD\\x07C\\x1b[2JD\\x9b31mE"],
  },
  {
    label: "C0, C1 and bidi controls have explicit distinct spellings",
    tool: tools[0],
    raw: "A\0\r\v\f\u0085\u009f\u202eB\u2068C\u2069",
    expected: ["A\\x00\\x0d\\x0b\\x0c\\x85\\x9f\\u202eB\\u2068C\\u2069"],
  },
  {
    label: "tabs are visible while indentation, NBSP and ideographic space survive",
    tool: tools[1],
    raw: "  INDENT\tA\u00a0B\u3000C",
    expected: ["  INDENT\\x09A\u00a0B\u3000C"],
  },
  {
    label: "LF paragraphs and Markdown-looking data remain literal",
    tool: tools[0],
    raw: "  **bold** # heading `code`\n\n    second \\n paragraph",
    expected: ["  **bold** # heading `code`", "", "    second \\\\n paragraph"],
  },
];
for (const { label, tool, raw, expected } of bodyCases) {
  test(`F1: ${label}`, (t) => {
    const messages = [assistant([call("body", tool.name, { [tool.key]: raw })])];
    const before = structuredClone(messages);
    const content = pane(t, messages);
    const width = 160;
    const paneRows = rowsAt(content, width);
    const block = plainRows(paneRows.filter((row) => row.startsWith(bubbleBg)));
    assert.equal(block.length, expected.length + 2, "padding, body paragraphs, padding");
    const title = paneRows.find((row) => stripTerminalSequences(row).endsWith(`${tool.title} `));
    assert.ok(title, "the right-aligned title renders above its block");
    assert.ok(!title.startsWith(bubbleBg), "the title sits outside the body background");
    assert.equal(visibleWidth(title), width, "the title spans the pane width");
    assert.deepEqual(
      block.slice(1, -1),
      expected.map((line) => ` ${line}${" ".repeat(width - visibleWidth(line) - 1)}`),
      "only display escaping changes recorded body bytes",
    );
    assert.deepEqual(messages, before, "no source bytes are rewritten");
  });
}

// F2: A bounded matrix, with both current tools represented, not a Cartesian
// expansion. The raw UTF-16 limit and raw /\S/ rule precede display encoding.
const limit = COMMUNICATION_LIMITS.child_text_units;
assert.equal(limit, 8192);
const schemaCases = [
  ["ASCII at 8192", tools[0], { message: "a".repeat(limit) }, true],
  ["ASCII at 8193", tools[0], { message: "a".repeat(limit + 1) }, false],
  ["astral at 4096 (8192 units)", tools[1], { question: "😀".repeat(4096) }, true],
  ["astral at 4097 (8194 units)", tools[1], { question: "😀".repeat(4097) }, false],
  ["empty", tools[0], { message: "" }, false],
  ["ASCII blank", tools[1], { question: "   " }, false],
  ["LF and tab blank", tools[0], { message: "\n\t" }, false],
  ["Unicode blank", tools[1], { question: "\u00a0\u3000" }, false],
  ["raw control is nonblank", tools[0], { message: "\0" }, true],
  ["zero-width raw string is nonblank", tools[1], { question: "\u200b" }, true],
  ["inherited field", tools[0], Object.create({ message: "INHERITED" }), false],
  ["extra enumerable field", tools[1], { question: "EXTRA", extra: true }, false],
  [
    "nonenumerable expected field",
    tools[0],
    Object.defineProperty({}, "message", { value: "HIDDEN_FIELD" }),
    false,
  ],
  [
    "extra hidden own key",
    tools[1],
    Object.defineProperty({ question: "HIDDEN_EXTRA" }, "hidden", { value: true }),
    false,
  ],
  ["extra symbol own key", tools[0], { message: "SYMBOL_EXTRA", [Symbol("extra")]: true }, false],
  [
    "readonly enumerable data is allowed",
    tools[1],
    Object.defineProperty({}, "question", { value: "READONLY_DATA", enumerable: true }),
    true,
  ],
  [
    "null prototype own data is allowed",
    tools[0],
    Object.assign(Object.create(null), { message: "OWN_DATA" }),
    true,
  ],
];
for (const [label, tool, args, accepted] of schemaCases) {
  test(`F2: ${label}`, (t) => {
    let lookups = 0;
    const content = pane(t, [assistant([call("schema", tool.name, args)])], () => {
      lookups++;
      throw new Error("communication records must not consult the live registry");
    });
    const rows = rowsAt(content);
    assert.equal(lookups, 0, "neither valid nor malformed communication calls use lookup");
    assert.equal(bubbleRows(rows).length > 0, accepted, label);
    if (!accepted) {
      assert.ok(screen(rows).includes(tool.name), "the malformed call stays on the raw path");
      assert.doesNotMatch(screen(rows), /Alert to parent|Question to parent/);
      assert.ok(
        rows.some((row) => row.startsWith(pendingBg)),
        "raw pending card framing remains",
      );
    }
  });
}

for (const tool of tools) {
  test(`F2: ${tool.name} accessor is raw and its getter is never read`, (t) => {
    let reads = 0;
    let lookups = 0;
    const args = Object.defineProperty({}, tool.key, {
      enumerable: true,
      get() {
        reads++;
        return "GETTER_MUST_NOT_RUN";
      },
    });
    const content = pane(t, [assistant([call("getter", tool.name, args)])], () => {
      lookups++;
      return undefined;
    });
    const rows = rowsAt(content);
    assert.equal(reads, 0, "matching and detached raw projection use descriptors, never getters");
    assert.equal(lookups, 0);
    assert.equal(bubbleRows(rows).length, 0);
    assert.ok(screen(rows).includes(tool.name));
    assert.ok(screen(rows).includes("[accessor property]"));
  });
}

test("retired communication names stay raw without consulting a live resolver", (t) => {
  let lookups = 0;
  const rows = rowsAt(
    pane(
      t,
      [
        assistant([call("retired", "notify_parent", { message: "HISTORICAL_NOTICE" })]),
        result("retired", "HISTORICAL_RECEIPT", false, "notify_parent"),
      ],
      () => {
        lookups++;
        throw new Error("retired records must not consult the live registry");
      },
    ),
  );
  assert.equal(lookups, 0);
  assert.equal(bubbleRows(rows).length, 0);
  for (const literal of ["notify_parent", "HISTORICAL_NOTICE", "HISTORICAL_RECEIPT"])
    assert.ok(screen(rows).includes(literal));
});

// F3: These are measured SDK zero-cell strings, not whitespace according to
// /\S/. Mixing in whitespace must not trick the unreadable-error check.
for (const [label, zero] of [
  ["ZWSP", "\u200b"],
  ["ZWNJ", "\u200c"],
  ["ZWJ", "\u200d"],
  ["WORD JOINER", "\u2060"],
  ["SOFT HYPHEN", "\u00ad"],
]) {
  test(`F3: ${label} error receipts (alone or amid whitespace) show Error`, (t) => {
    assert.equal(visibleWidth(zero), 0, "the real pinned SDK measures zero cells");
    assert.match(zero, /\S/u);
    const messages = [];
    for (const [index, text] of [zero, ` \n\t${zero}\u00a0\u3000 `].entries()) {
      const tool = tools[index];
      messages.push(
        assistant([call(`zero-${index}`, tool.name, { [tool.key]: "ERROR_BODY" })]),
        result(`zero-${index}`, text, true, tool.name),
      );
    }
    const rows = rowsAt(pane(t, messages));
    const errors = rows.filter((row) => stripTerminalSequences(row).trim() === "Error");
    assert.equal(errors.length, 2, "one explicit Error per unreadable error receipt");
    for (const row of errors) {
      assert.ok(row.includes(`${errorOpen}Error`));
      assert.ok(!row.includes(bubbleBg), "receipt stays outside the body background");
    }
    assert.equal(noticeRows(rows).length, 0, "an error result is still a recorded result");
  });
}

test("F3: ordinary spaces between zero-cell characters cannot hide the Error marker", (t) => {
  const receipts = ["\u200b \u200b", "\u2060 \u2060", "\u00ad \u00ad"];
  const messages = [];
  for (const [index, receipt] of receipts.entries()) {
    assert.ok(visibleWidth(receipt.trim()) > 0, "trim alone retains the interior space cell");
    assert.equal(visibleWidth(receipt.replace(/\s/gu, "")), 0);
    messages.push(
      assistant([call(`interior-${index}`, "ask_parent", { question: "INTERIOR_SPACE_BODY" })]),
      result(`interior-${index}`, receipt, true, "ask_parent"),
    );
  }
  const rows = rowsAt(pane(t, messages));
  const errors = rows.flatMap((row, index) =>
    stripTerminalSequences(row).trim() === "Error" ? [index] : [],
  );
  assert.equal(
    errors.length,
    receipts.length,
    "an independent Error for each interior-space receipt",
  );
  for (const [index, errorRow] of errors.entries()) {
    assert.ok(rows[errorRow].includes(`${errorOpen}Error`));
    assert.ok(!rows[errorRow].includes(bubbleBg));
    const retained = rows[errorRow + 1];
    assert.ok(
      stripTerminalSequences(retained).includes(receipts[index]),
      "normalized receipt follows Error unchanged",
    );
    assert.ok(!retained.includes(bubbleBg));
  }
  assert.equal(noticeRows(rows).length, 0);
});

test("F3: combining-only receipts keep possible ink below an independent Error marker", (t) => {
  // Zero measured non-whitespace cells is not proof of no painted ink. Do not
  // erase combining marks or claim detection of every blank-looking glyph.
  const receipts = ["\u0301", " \u0301"];
  const messages = [];
  for (const [index, receipt] of receipts.entries()) {
    assert.equal(visibleWidth(receipt.replace(/\s/gu, "")), 0);
    messages.push(
      assistant([call(`combining-${index}`, "alert_parent", { message: "COMBINING_BODY" })]),
      result(`combining-${index}`, receipt, true),
    );
  }
  const rows = rowsAt(pane(t, messages));
  const errors = rows.flatMap((row, index) =>
    stripTerminalSequences(row).trim() === "Error" ? [index] : [],
  );
  assert.equal(errors.length, 2, "Error is independently readable for each receipt");
  for (const [index, errorRow] of errors.entries()) {
    assert.ok(rows[errorRow].includes(`${errorOpen}Error`));
    assert.ok(!rows[errorRow].includes(bubbleBg));
    const retained = rows[errorRow + 1];
    assert.ok(
      stripTerminalSequences(retained).includes(receipts[index]),
      "recorded text follows Error",
    );
    assert.ok(!retained.includes(bubbleBg), "retained receipt stays outside the body");
  }
  assert.equal(noticeRows(rows).length, 0);
});

test("F3: readable Unicode receipt is not rewritten to repair invisible neighbors", (t) => {
  const receipt = "\u200b 回执 e\u0301 👩‍💻 \u200c";
  assert.ok(visibleWidth(receipt.replace(/\s/gu, "")) > 0);
  const rows = rowsAt(
    pane(t, [
      assistant([call("readable", "ask_parent", { question: "READABLE_BODY" })]),
      result("readable", receipt, true, "ask_parent"),
    ]),
  );
  const row = rows.find((line) => stripTerminalSequences(line).includes(receipt));
  assert.ok(row, "readable receipt, including joiners, is preserved");
  assert.ok(row.includes(hostTheme.fg("error", receipt)));
  assert.ok(!row.includes(bubbleBg));
  assert.equal(noticeRows(rows).length, 0);
});

test("F3: empty normal results invent neither success nor Error nor missing-result notices", (t) => {
  const messages = [];
  for (const [index, text] of [null, "", " \n\t", "\u200b"].entries()) {
    messages.push(
      assistant([call(`normal-${index}`, "alert_parent", { message: "NORMAL_BODY" })]),
      result(`normal-${index}`, text),
    );
  }
  const rows = rowsAt(pane(t, messages));
  // Four calls, one block each: padding, body, padding — titles sit outside.
  assert.equal(bubbleRows(rows).length, 12);
  assert.equal(noticeRows(rows).length, 0);
  assert.doesNotMatch(screen(rows), /Error|success|queued|delivered|acknowledged/i);
});

// F4: These deliberately throwing matching traps test local fallback only.
// Proxy traps can themselves have arbitrary side effects; no general purity or
// sandbox guarantee is asserted. Neighbors share the SAME assistant message.
for (const trap of ["ownKeys", "getOwnPropertyDescriptor"]) {
  test(`F4: throwing ${trap} keeps the raw call and both same-message neighbors`, (t) => {
    let lookups = 0;
    const hostile = new Proxy(
      { message: "TRAPPED_BODY" },
      {
        [trap]() {
          throw new Error(`fixture ${trap} failure`);
        },
      },
    );
    const messages = [
      assistant([
        call("before", "alert_parent", { message: "BEFORE_NEIGHBOR" }),
        call("trap", "alert_parent", hostile),
        call("after", "ask_parent", { question: "AFTER_NEIGHBOR" }),
      ]),
      result("before", "BEFORE_RECEIPT"),
      result("trap", "TRAP_RECEIPT", true),
      result("after", "AFTER_RECEIPT", false, "ask_parent"),
    ];
    const rows = rowsAt(
      pane(t, messages, () => {
        lookups++;
        return undefined;
      }),
    );
    const text = screen(rows);
    assert.equal(lookups, 0);
    assert.ok(text.includes("AFTER_NEIGHBOR"), "a matching failure cannot swallow the next call");
    assert.ok(text.includes("BEFORE_NEIGHBOR"));
    assert.equal(bubbleRows(rows).length, 6, "only the two healthy neighbors receive bubbles");
    for (const literal of [
      "alert_parent",
      "[unrenderable]",
      "BEFORE_RECEIPT",
      "TRAP_RECEIPT",
      "AFTER_RECEIPT",
    ])
      assert.ok(text.includes(literal), `${literal} remains visible`);
    const receipt = rows.find((row) => stripTerminalSequences(row).includes("TRAP_RECEIPT"));
    assert.ok(receipt.startsWith(hostTheme.getBgAnsi("toolErrorBg")), "raw error-card styling");
    assert.ok(!receipt.includes(bubbleBg));
  });
}

// F5: A missing recorded result is a neutral history observation, not running,
// delivery, model receipt or human acknowledgement evidence.
for (const tool of tools) {
  test(`F5: unresolved ${tool.name} has one dim neutral notice outside the bubble`, (t) => {
    const content = pane(t, [
      assistant([
        call("missing", tool.name, { [tool.key]: "UNRESOLVED_BODY" }),
        call("generic", "generic_tool", { value: "GENERIC_PENDING_ARGUMENT" }),
      ]),
    ]);
    for (const expanded of [false, true, false]) {
      content.setToolsExpanded(expanded);
      content.invalidateLayout();
      const rows = rowsAt(content);
      const notices = noticeRows(rows);
      assert.equal(notices.length, 1, "expansion never hides or duplicates the neutral notice");
      assert.ok(notices[0].includes(hostTheme.fg("dim", noResult)));
      assert.ok(!notices[0].includes(bubbleBg));
      assert.ok(!notices[0].includes(pendingBg), "not generic pending-card styling");
      assert.equal(
        bubbleRows(rows).length,
        3,
        "padding plus body only; the title and the notice are not body rows",
      );
      const generic = rows.find((row) =>
        stripTerminalSequences(row).includes("GENERIC_PENDING_ARGUMENT"),
      );
      assert.ok(generic?.startsWith(pendingBg), "the generic pending control still uses its card");
      assert.doesNotMatch(
        screen(rows),
        /running|delivered|read by parent|seen by parent|acknowledged/i,
      );
    }
  });
}

for (const [label, text, isError] of [
  ["success", "RECORDED_RECEIPT", false],
  ["failure", "RECORDED_FAILURE", true],
  ["empty content", null, false],
  ["empty text", "", false],
]) {
  test(`F5: appending ${label} to the same pane clears the missing-result observation`, (t) => {
    const messages = [assistant([call("append", "alert_parent", { message: "APPEND_BODY" })])];
    const content = pane(t, messages);
    rowsAt(content); // Paint the unresolved call before appending, not a fresh settled-only pane.
    messages.push(result("append", text, isError));
    for (const expanded of [false, true, false]) {
      content.setToolsExpanded(expanded);
      const rows = rowsAt(content);
      assert.equal(noticeRows(rows).length, 0);
      assert.equal(bubbleRows(rows).length, 3);
      if (text) {
        const row = rows.find((line) => stripTerminalSequences(line).includes(text));
        assert.ok(row?.includes(hostTheme.fg(isError ? "error" : "dim", text)));
        assert.ok(!row.includes(bubbleBg), "receipt stays separate");
      } else {
        assert.doesNotMatch(
          screen(rows),
          /Error|success|queued/i,
          "no success receipt is fabricated",
        );
      }
    }
  });
}

test("F3: synthetic provider errorMessage containing only WORD JOINER still shows Error", (t) => {
  const calls = [call("provider-zero", "ask_parent", { question: "PROVIDER_ZERO_BODY" })];
  let messages = [assistant(calls)];
  const content = pane(t, () => messages);
  assert.equal(
    noticeRows(rowsAt(content)).length,
    1,
    "paint unresolved state in the same pane first",
  );
  messages = [assistant(calls, { stopReason: "error", errorMessage: "\u2060" })];
  const rows = rowsAt(content);
  const errors = rows.flatMap((row, index) =>
    stripTerminalSequences(row).trim() === "Error" ? [index] : [],
  );
  assert.equal(errors.length, 1, "the synthetic receipt gets an independent readable marker");
  const errorRow = errors[0];
  assert.ok(rows[errorRow].includes(`${errorOpen}Error`));
  assert.ok(!rows[errorRow].includes(bubbleBg));
  assert.ok(
    stripTerminalSequences(rows[errorRow + 1]).includes("\u2060"),
    "retain recorded WORD JOINER below Error",
  );
  assert.ok(!rows[errorRow + 1].includes(bubbleBg));
  assert.equal(bubbleRows(rows).length, 3);
  assert.equal(noticeRows(rows).length, 0, "synthetic failure clears missing-result observation");
});

for (const [stopReason, extra, receipt] of [
  ["aborted", {}, "Operation aborted"],
  ["error", { errorMessage: "SYNTHETIC_FAILURE" }, "SYNTHETIC_FAILURE"],
  ["error", {}, "Error"],
]) {
  test(`F5: same-pane assistant ${stopReason}/${receipt} synthesizes failure, not a missing result`, (t) => {
    const calls = [call("synthetic", "ask_parent", { question: "SYNTHETIC_BODY" })];
    let messages = [assistant(calls)];
    const content = pane(t, () => messages);
    rowsAt(content);
    // A changed settled history uses a new array identity, as the public
    // source does for a rewritten prefix; no in-place same-length mutation.
    messages = [assistant(calls, { stopReason, ...extra })];
    const rows = rowsAt(content);
    assert.equal(noticeRows(rows).length, 0);
    assert.equal(bubbleRows(rows).length, 3);
    const row = rows.find((line) => stripTerminalSequences(line).includes(receipt));
    assert.ok(row?.includes(hostTheme.fg("error", receipt)));
    assert.ok(!row.includes(bubbleBg));
  });
}
