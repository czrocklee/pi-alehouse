import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

const contentOver = (messages) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
    },
  });

const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  ...extra,
});

/**
 * The SDK's expanded fallback interpolates top-level string values raw and
 * stringifies nested ones through JSON.stringify — which emits C1 controls,
 * bidi controls and terminal payloads literally at every depth it reaches.
 * These regressions pin the pane's recursive display projection: every string
 * and every key is neutralized wherever it sits, while benign data survives
 * and the recorded source is never mutated.
 */
test("nested tool arguments are sanitized at every depth, source unchanged", () => {
  const osc52 = "\x1b]52;c;NESTED_CLIPBOARD\x07",
    c1Osc = "\u009d52;c;NESTED_C1_PAYLOAD",
    bidiIsolate = "R\u2068everse\u2069",
    bidiOverride = "NESTED\u202eRBO",
    nel = "line\u0085break",
    emoji = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  // Pending call, so the expanded raw-argument form is what is on screen.
  const messages = [
    assistant([
      {
        type: "toolCall",
        id: "e1",
        name: "edit",
        arguments: {
          file_path: "/w/a.ts",
          edits: [
            { oldText: `OLD${c1Osc}${bidiOverride}TAIL`, newText: `NEW${bidiIsolate}TAIL` },
            { "\u0093nested\u0094key": `VALUE${nel}` },
          ],
          deep: { matrix: [{ deeper: [osc52, null, 42, [emoji]] }] },
          benign: { keep: 7, empty: null, list: ["a", 1, true] },
        },
      },
    ]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const text = content.slice(200, 0, content.lineCount(200)).join("\n");
    // No raw control introducer survives to the terminal from any depth.
    // (Rows legitimately carry theme ANSI, so specific sequences are checked,
    // not a bare ESC; a C1-OSC's payload text stays as escaped-marker tail,
    // the same as any other escaped control character.)
    for (const raw of [
      "\x1b]52",
      "\x07",
      "\u009d",
      "\u0093",
      "\u0094",
      "\u0085",
      "\u2068",
      "\u2069",
      "\u202e",
    ])
      assert.ok(!text.includes(raw), `raw ${JSON.stringify(raw)} survived into the pane`);
    // Controls become visible spellings; their payload text is still part of
    // the recorded arguments, not disposable terminal-protocol metadata.
    for (const marker of ["x1b", "x07", "x85", "x9d", "x93", "x94", "u2068", "u2069", "u202e"])
      assert.ok(text.includes(marker), `escaped marker ${marker} is shown`);
    assert.ok(text.includes("NESTED_CLIPBOARD"), "ordinary protocol payload text is retained");
    // Benign structure survives: numbers, null, booleans, arrays, graphemes.
    assert.match(text, /"keep": 7/, "nested numbers survive sanitization");
    assert.match(text, /"empty": null/, "nested null survives");
    assert.match(text, /"list": \[/, "nested arrays survive");
    assert.match(text, /42/, "array elements survive");
    assert.ok(
      text.includes("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"),
      "grapheme clusters with joiners survive at depth",
    );
    assert.match(text, /"oldText":/, "the nested edit keys are still rendered");
    assert.deepEqual(
      messages,
      before,
      "the recursive projection is detached; the recorded source is untouched",
    );
  } finally {
    content.dispose();
  }
});

test("a top-level array argument is sanitized element by element", () => {
  const messages = [
    assistant([
      {
        type: "toolCall",
        id: "a1",
        name: "weird",
        arguments: ["\u009dARRAY_C1", { "\u0096key": "\u202eVALUE" }, "plain"],
      },
    ]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const text = content.slice(200, 0, content.lineCount(200)).join("\n");
    for (const raw of ["\u009d", "\u0096", "\u202e"])
      assert.ok(!text.includes(raw), `raw ${JSON.stringify(raw)} survived into the pane`);
    assert.ok(text.includes("x9d") && text.includes("x96") && text.includes("u202e"));
    assert.ok(text.includes("plain"), "benign array elements survive");
    assert.deepEqual(messages, before, "no source mutation");
  } finally {
    content.dispose();
  }
});

test("cyclic tool arguments render a bounded marker instead of throwing", () => {
  const arguments_ = { safe: "CYCLE_SAFE_TEXT" };
  arguments_.self = arguments_;
  arguments_.arr = [arguments_, "CYCLE_LIST_TEXT"];
  const messages = [
    assistant([{ type: "toolCall", id: "c1", name: "loop", arguments: arguments_ }]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const text = content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.ok(text.includes("[circular reference]"), text);
    assert.ok(text.includes("CYCLE_SAFE_TEXT") && text.includes("CYCLE_LIST_TEXT"), text);
    assert.deepEqual(messages, before, "the cycle is not rewritten in the source");
    assert.equal(arguments_.self, arguments_, "the source cycle stays intact");
  } finally {
    content.dispose();
  }
});

test("accessor and callable argument values are never invoked", () => {
  let getterCalls = 0;
  const element = ["ELEMENT_SAFE_TEXT"];
  Object.defineProperty(element, 1, {
    enumerable: true,
    get() {
      getterCalls++;
      return "\x1b]52;c;ELEMENT_GETTER_PAYLOAD\x07";
    },
  });
  const arguments_ = {
    safe: "GETTER_SAFE_TEXT",
    get boom() {
      getterCalls++;
      return "\x1b]52;c;GETTER_PAYLOAD\x07";
    },
    list: element,
  };
  const messages = [
    assistant([
      { type: "toolCall", id: "g1", name: "getters", arguments: arguments_ },
      {
        type: "toolCall",
        id: "g2",
        name: "callable",
        arguments: { fn: () => "\x1b]52;c;CALLABLE_PAYLOAD\x07" },
      },
    ]),
  ];
  const content = contentOver(messages);
  try {
    const text = content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.equal(getterCalls, 0, "the pane never invokes a recorded getter");
    assert.ok(text.includes("[accessor property]"), text);
    assert.ok(text.includes("[callable value]"), text);
    assert.ok(!text.includes("GETTER_PAYLOAD") && !text.includes("CALLABLE_PAYLOAD"), text);
    assert.ok(text.includes("GETTER_SAFE_TEXT"), text);
    assert.ok(text.includes("ELEMENT_SAFE_TEXT"), text);
  } finally {
    content.dispose();
  }
});

test("over-deep and over-large tool arguments stop at a bounded marker", () => {
  let deep = { leaf: "DEEP_LEAF_TEXT" };
  for (let i = 0; i < 5000; i++) deep = { deeper: deep };
  const wide = Array.from({ length: 30_000 }, (_, i) => `BULK_${i}`);
  const messages = [
    assistant([{ type: "toolCall", id: "d1", name: "deep", arguments: deep }]),
    assistant([{ type: "toolCall", id: "w1", name: "wide", arguments: { rows: wide } }]),
  ];
  const content = contentOver(messages);
  try {
    // Neither projection nor the SDK's own JSON dump may overflow the stack.
    const text = content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.ok(text.includes("[elided]"), "an over-budget structure shows the bounded marker");
    assert.ok(!text.includes("DEEP_LEAF_TEXT"), "the over-deep tail is not walked");
    assert.ok(text.includes("BULK_0"), "the budget keeps a bounded readable prefix");
  } finally {
    content.dispose();
  }
});

test("an own __proto__ key survives as an own key, sanitized", () => {
  const arguments_ = { keep: "PROTO_SIBLING_TEXT" };
  Object.defineProperty(arguments_, "__proto__", {
    value: "PROTO\u009dVALUE",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const messages = [
    assistant([{ type: "toolCall", id: "p1", name: "proto", arguments: arguments_ }]),
  ];
  const before = structuredClone(messages);
  const content = contentOver(messages);
  try {
    const text = content.slice(160, 0, content.lineCount(160)).join("\n");
    assert.ok(text.includes("PROTO"), text);
    assert.ok(!text.includes("\u009d"), "the own __proto__ value is sanitized too");
    assert.ok(
      Object.getOwnPropertyDescriptor(messages[0].content[0].arguments, "__proto__")?.value ===
        "PROTO\u009dVALUE",
      "the source keeps its own __proto__ data property byte-literally",
    );
    assert.deepEqual(messages, before, "no source mutation");
  } finally {
    content.dispose();
  }
});
