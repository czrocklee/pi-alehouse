/** Review06F1: binding-reader failures keep recorded cards visible, without
 * consulting custom renderers. Tokens are stable identities until a real binding
 * change; these public-pane tests do not support allocating a token per read or
 * claim isolation from arbitrary extension code/Proxy traps. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolate SDK module initialization as well as source imports. The focused
// invocation also supplies an isolated shell environment before Node starts.
const home = mkdtempSync(join(tmpdir(), "alehouse-binding-failure-"));
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ["XDG_CONFIG_HOME", join(home, "config")],
  ["XDG_DATA_HOME", join(home, "data")],
  ["XDG_STATE_HOME", join(home, "state")],
  ["XDG_CACHE_HOME", join(home, "cache")],
  ["XDG_RUNTIME_DIR", join(home, "runtime")],
  ["TMPDIR", join(home, "tmp")],
  ["TMP", join(home, "tmp")],
  ["TEMP", join(home, "tmp")],
]) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { createJiti } = await import("jiti");
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text } = await import("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
initTheme(undefined, false);

const WIDTH = 180;
const UNREADABLE = Symbol("fixture reader throws");
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  timestamp: 1,
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, text) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
});
const ordinaryMessages = () => [
  user("BEFORE_CARD_NEIGHBOR"),
  assistant([call("p1", "review_probe", { command: "printf RAW_ARG" })]),
  result("p1", "review_probe", "RECORDED_RESULT"),
  user("AFTER_CARD_NEIGHBOR"),
];
const paint = (content, width = WIDTH) => {
  const frame = content.frame(width);
  return frame.slice(0, frame.lineCount).join("\n");
};

function fixture(t, options = {}) {
  const { registry = "custom", reader = "method" } = options;
  // Explicit undefined is a legal token, distinct from the default throw state.
  const token = Object.hasOwn(options, "token") ? options.token : UNREADABLE;
  const messages = options.messages ?? ordinaryMessages();
  const before = structuredClone(messages);
  const lookups = [];
  const callbacks = [];
  const handles = new Set();
  const activity = { componentInvalidates: 0, renders: 0 };
  let binding = token;
  let streaming;
  class ProbeText extends Text {
    invalidate() {
      activity.componentInvalidates++;
      super.invalidate();
    }
  }
  const renderers = {
    renderCall(_args, _theme, context) {
      callbacks.push({ slot: "call", binding });
      handles.add(context.invalidate);
      const view =
        context.lastComponent instanceof ProbeText
          ? context.lastComponent
          : new ProbeText("CUSTOM_CALL", 0, 0);
      return view;
    },
    renderResult(received, _options, _theme, context) {
      callbacks.push({ slot: "result", binding });
      handles.add(context.invalidate);
      const view =
        context.lastComponent instanceof ProbeText
          ? context.lastComponent
          : new ProbeText("", 0, 0);
      view.setText(`CUSTOM_RESULT\n${received.content.map((part) => part.text ?? "").join("\n")}`);
      return view;
    },
  };
  const read = () => {
    if (binding === UNREADABLE) throw new Error("BINDING_READER_UNAVAILABLE");
    return binding;
  };
  const source = {
    messages: () => messages,
    inFlight: () => streaming,
    toolDefinition(name) {
      lookups.push(name);
      return registry === "custom" ? renderers : undefined;
    },
  };
  if (reader === "method") source.toolRenderersRevision = read;
  if (reader === "getter")
    Object.defineProperty(source, "toolRenderersRevision", {
      get() {
        if (binding === UNREADABLE) throw new Error("BINDING_PROPERTY_UNAVAILABLE");
        return read;
      },
    });
  const content = new TranscriptContent({
    tui: {
      requestRender() {
        activity.renders++;
      },
      terminal: { columns: WIDTH, rows: 40 },
    },
    cwd: "/recorded-child",
    markdownTheme: getMarkdownTheme(),
    source,
  });
  t.after(() => {
    content.dispose();
    assert.deepEqual(messages, before, "recorded messages stay unchanged");
  });
  return {
    content,
    callbacks,
    lookups,
    handles,
    activity,
    bind(next) {
      binding = next;
    },
    stream(text) {
      streaming = assistant([{ type: "text", text }]);
    },
  };
}

function assertNeighbors(text) {
  assert.match(text, /BEFORE_CARD_NEIGHBOR/);
  assert.match(text, /AFTER_CARD_NEIGHBOR/);
}
function assertRaw(text, expanded = false) {
  assertNeighbors(text);
  assert.match(text, /review_probe/, "recorded tool name stays visible");
  assert.match(
    text,
    expanded ? /command: printf RAW_ARG/ : /command="printf RAW_ARG"/,
    "recorded arguments stay visible in the SDK's expanded/collapsed format",
  );
  assert.match(text, /RECORDED_RESULT/, "recorded result stays visible");
  assert.doesNotMatch(text, /CUSTOM_CALL|CUSTOM_RESULT/);
}
function assertCustom(text) {
  assertNeighbors(text);
  assert.match(text, /CUSTOM_CALL/);
  assert.match(text, /CUSTOM_RESULT/);
  assert.match(text, /RECORDED_RESULT/);
}
function snapshot(pane) {
  return {
    callbacks: pane.callbacks.length,
    renders: pane.activity.renders,
    componentInvalidates: pane.activity.componentInvalidates,
  };
}
function assertDead(pane, saved, why) {
  const prior = snapshot(pane);
  assert.ok(saved.length > 0, "custom callbacks supplied handles");
  assert.doesNotThrow(() => saved.forEach((invalidate) => invalidate()));
  assert.deepEqual(snapshot(pane), prior, `${why}: no callback, render request or component entry`);
}

for (const registry of ["custom", "missing"])
  test(`persistent throwing binding reader preserves raw call/result with ${registry} lookup`, (t) => {
    const pane = fixture(t, { registry });
    assertRaw(paint(pane.content));
    assertRaw(paint(pane.content));
    assert.deepEqual(pane.lookups, [], "an unavailable epoch never consults the registry");
    assert.equal(pane.callbacks.length, 0);
  });

test("throwing binding reader keeps communication calls raw and their results visible", (t) => {
  const messages = [
    user("BEFORE_CARD_NEIGHBOR"),
    assistant([
      call("a1", "alert_parent", { message: "RECORDED_ALERT" }),
      call("q1", "ask_parent", { question: "RECORDED_QUESTION" }),
    ]),
    result("a1", "alert_parent", "ALERT_RECEIPT"),
    result("q1", "ask_parent", "QUESTION_RECEIPT"),
    user("AFTER_CARD_NEIGHBOR"),
  ];
  const pane = fixture(t, { messages });
  const text = paint(pane.content);
  assertNeighbors(text);
  for (const marker of [
    "alert_parent",
    "ask_parent",
    "RECORDED_ALERT",
    "RECORDED_QUESTION",
    "ALERT_RECEIPT",
    "QUESTION_RECEIPT",
  ])
    assert.ok(text.includes(marker), `${marker} stays visible`);
  assert.doesNotMatch(text, /Alert to parent|Question to parent|CUSTOM_CALL|CUSTOM_RESULT/);
  assert.deepEqual(pane.lookups, []);
  assert.equal(pane.callbacks.length, 0);
});

for (const [label, recovered] of [
  ["stable object A", { generation: "A" }],
  ["legal undefined", undefined],
])
  test(`initial throwing reader recovers to ${label} on the same pane/history`, (t) => {
    const pane = fixture(t);
    // Do not replace the messages or force a theme reset to make recovery work.
    paint(pane.content);
    const queries = pane.lookups.length;
    pane.bind(recovered);
    assertCustom(paint(pane.content));
    assert.equal(pane.lookups.length, queries + 1, "recovery re-queries this recorded call");
    assert.ok(pane.callbacks.some((entry) => entry.slot === "result"));
  });

test("A to throw kills saved handles before pane work, consumes raw, and recovers without revival", (t) => {
  const pane = fixture(t, { token: { generation: "A" } });
  assertCustom(paint(pane.content));
  const saved = [...pane.handles];
  const callbacks = pane.callbacks.length;
  const queries = pane.lookups.length;
  pane.bind(UNREADABLE);
  assertDead(pane, saved, "before any pane operation");
  assertRaw(paint(pane.content));
  assert.equal(pane.callbacks.length, callbacks, "the failing epoch invokes no custom callbacks");
  assert.equal(pane.lookups.length, queries, "the failing epoch invokes no registry lookup");
  assertDead(pane, saved, "after raw replay");
  pane.bind(undefined);
  assertCustom(paint(pane.content));
  assert.equal(pane.lookups.length, queries + 1);
  assert.ok(pane.callbacks.length > callbacks, "new custom callbacks paint the recovered result");
  assertDead(pane, saved, "after recovery to legal undefined");
});

for (const [label, original] of [
  ["same object A", { generation: "A" }],
  ["legal undefined", undefined],
])
  test(`${label} to throw to original token replays results without reviving saved handles`, (t) => {
    const pane = fixture(t, { token: original });
    assertCustom(paint(pane.content));
    const saved = [...pane.handles];
    const prior = snapshot(pane);
    const queries = pane.lookups.length;
    pane.bind(UNREADABLE);
    // Only the saved handle observes the failure. No frame/render/sync or other
    // pane method may retire the old card before the original token returns.
    assertDead(pane, saved, "saved handle alone observes the unavailable epoch");
    assert.equal(pane.callbacks.length, prior.callbacks, "failure invokes no custom callbacks");
    assert.equal(pane.lookups.length, queries, "failure invokes no registry lookup");
    pane.bind(original);
    assertDead(pane, saved, "original token restored before any pane operation");
    assertCustom(paint(pane.content));
    assert.equal(pane.lookups.length, queries + 1, "returning to the original token re-queries");
    const replay = pane.callbacks.slice(prior.callbacks);
    assert.ok(replay.some((entry) => entry.slot === "call" && entry.binding === original));
    assert.ok(replay.some((entry) => entry.slot === "result" && entry.binding === original));
    assertDead(pane, saved, "original token restored after result replay");
  });

test("A to B kills saved handles before pane work and mounts replacement callbacks", (t) => {
  const pane = fixture(t, { token: { generation: "A" } });
  assertCustom(paint(pane.content));
  const saved = [...pane.handles];
  const callbacks = pane.callbacks.length;
  const queries = pane.lookups.length;
  const next = { generation: "B" };
  pane.bind(next);
  assertDead(pane, saved, "A to B before any pane operation");
  assertCustom(paint(pane.content));
  assert.equal(pane.lookups.length, queries + 1);
  assert.ok(pane.callbacks.slice(callbacks).some((entry) => entry.binding === next));
  assertDead(pane, saved, "after B mounted");
});

for (const [label, options] of [
  ["same object identity", { token: { generation: "A" } }],
  ["no token reader", { reader: "absent" }],
  ["legal undefined token", { token: undefined }],
])
  test(`${label} keeps custom callbacks and settled cards cached during streaming`, (t) => {
    const pane = fixture(t, options);
    assertCustom(paint(pane.content));
    assert.deepEqual(pane.lookups, ["review_probe"]);
    const prior = snapshot(pane);
    pane.stream("STREAM_ONE");
    assert.match(paint(pane.content), /STREAM_ONE/);
    pane.stream("STREAM_TWO");
    const text = paint(pane.content);
    assertCustom(text);
    assert.match(text, /STREAM_TWO/);
    assert.deepEqual(snapshot(pane), prior, "streaming does not rebuild settled callbacks");
    assert.deepEqual(pane.lookups, ["review_probe"]);
  });

test("raw unavailable epoch survives expansion, invalidation, layout, width and theme changes", (t) => {
  const pane = fixture(t);
  assertRaw(paint(pane.content));
  pane.content.setToolsExpanded(true);
  assertRaw(paint(pane.content), true);
  const anchor = pane.content.captureAnchor(WIDTH, 0);
  for (const [change, expanded] of [
    [() => pane.content.invalidate(), true],
    [() => pane.content.invalidateLayout(), true],
    [() => pane.content.setToolsExpanded(false), false],
  ]) {
    assert.doesNotThrow(change);
    assertRaw(paint(pane.content), expanded);
    assert.equal(typeof pane.content.resolveAnchor(WIDTH, anchor), "number");
  }
  assertRaw(paint(pane.content, 100));
  pane.content.setTheme({ ...getMarkdownTheme() });
  assertRaw(paint(pane.content));
  assert.deepEqual(pane.lookups, [], "presentation changes never query the unavailable registry");
  assert.equal(pane.callbacks.length, 0);
});

test("a throwing token-reader property getter is guarded and can recover to undefined", (t) => {
  const pane = fixture(t, { reader: "getter" });
  assertRaw(paint(pane.content));
  assert.deepEqual(pane.lookups, []);
  pane.bind(undefined);
  assertCustom(paint(pane.content));
  assert.deepEqual(pane.lookups, ["review_probe"]);
});
