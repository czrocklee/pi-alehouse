/** Public TranscriptContent integration, loaded from source. Custom callbacks
 * are deliberately hostile to their working copies, never to private fields. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "alehouse-pristine-fallback-"));
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ...["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
    `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
    join(home, "xdg", kind.toLowerCase()),
  ]),
]) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { createJiti } = await import("jiti");
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text } = await import("@earendil-works/pi-tui");
initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");

const callMessage = (id, name, args) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  stopReason: "toolUse",
  timestamp: 1,
});
const resultMessage = (text = "ORIGINAL_RESULT") => ({
  role: "toolResult",
  toolCallId: "subject",
  toolName: "specimen",
  content: [{ type: "text", text }],
  details: { nested: { label: "ORIGINAL_DETAILS" } },
  isError: false,
});
const originalArgs = () => ({ path: "ORIGINAL_ARGUMENT", nested: { label: "ORIGINAL_NESTED" } });

function paint(content) {
  const frame = content.frame(180);
  return frame.slice(0, frame.lineCount).join("\n");
}

function fixture(t, renderers, { settled = true, args = originalArgs() } = {}) {
  const messages = [
    { role: "user", content: "RETAINED_USER_TEXT", timestamp: 0 },
    callMessage("sibling", "healthy_sibling", { path: "sibling.txt" }),
    callMessage("subject", "specimen", args),
    ...(settled ? [resultMessage()] : []),
  ];
  let expected = structuredClone(messages);
  const sibling = new Text("HEALTHY_SIBLING", 0, 0);
  const siblingRender = t.mock.method(sibling, "render");
  const revision = {};
  const content = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 180, rows: 40 } },
    cwd: join(home, "recorded-cwd"),
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: (name) =>
        name === "healthy_sibling" ? { renderCall: () => sibling } : renderers,
      toolRenderersRevision: () => revision,
    },
  });
  t.after(() => {
    content.dispose();
    assert.deepEqual(messages, expected, "renderer mutation cannot rewrite retained history");
  });
  return {
    content,
    messages,
    siblingRender,
    appendResult(text) {
      messages.push(resultMessage(text));
      expected = [...expected, resultMessage(text)];
    },
    intact() {
      assert.deepEqual(messages, expected, "history content/details/arguments remain literal data");
    },
  };
}

function assertRaw(pane, expectedResult = "ORIGINAL_RESULT") {
  const text = paint(pane.content);
  for (const literal of [
    "specimen",
    "ORIGINAL_ARGUMENT",
    "ORIGINAL_NESTED",
    expectedResult,
    "HEALTHY_SIBLING",
    "RETAINED_USER_TEXT",
  ])
    assert.ok(text.includes(literal), `raw fallback retains ${literal}`);
  assert.doesNotMatch(text, /POISON|CUSTOM_SUBJECT/, "no failed renderer data contaminates raw");
  pane.intact();
  return text;
}

function poisonArgs(args, label = "POISON_ARGS") {
  args.path = label;
  args.nested.label = label;
}
function poisonResult(received, label = "POISON_RESULT") {
  received.content[0].text = label;
  received.content.push({ type: "text", text: label });
  received.details.nested.label = label;
}

test("renderCall mutation then throw falls back to pristine args, including later mutations", (t) => {
  const retained = [];
  const pane = fixture(t, {
    renderCall(args, _theme, context) {
      assert.equal(args, context.args);
      retained.push(args);
      poisonArgs(args);
      poisonArgs(context.args, "POISON_CONTEXT_ARGS");
      throw new Error("call failure");
    },
  });
  assertRaw(pane);
  assert.ok(retained.length > 0, "the failing callback actually ran");
  for (const args of retained) poisonArgs(args, "POISON_LATE_ARGS");
  pane.content.invalidate();
  assertRaw(pane);
});

test("renderResult mutation then throw preserves original content/details and raw result", (t) => {
  const argsRefs = [];
  const resultRefs = [];
  const pane = fixture(t, {
    renderCall(args, _theme, context) {
      assert.equal(context.args, args);
      argsRefs.push(args);
      return new Text("CUSTOM_SUBJECT", 0, 0);
    },
    renderResult(received, _options, _theme, context) {
      resultRefs.push(received);
      argsRefs.push(context.args);
      poisonArgs(context.args);
      poisonResult(received);
      throw new Error("result failure");
    },
  });
  assertRaw(pane);
  assert.ok(resultRefs.length > 0);
  for (const args of argsRefs) poisonArgs(args, "POISON_LATE_ARGS");
  for (const received of resultRefs) poisonResult(received, "POISON_LATE_RESULT");
  pane.content.invalidate();
  assertRaw(pane);
});

for (const phase of ["render", "invalidate"]) {
  test(`lazy component.${phase} mutation then throw cannot contaminate raw or siblings`, (t) => {
    let armed = false;
    let savedInvalidate;
    const argsRefs = [];
    const resultRefs = [];
    const poisonAndThrow = () => {
      if (!armed) return;
      for (const args of argsRefs) poisonArgs(args);
      for (const received of resultRefs) poisonResult(received);
      throw new Error(`lazy ${phase} failure`);
    };
    const component = {
      render() {
        if (phase === "render") poisonAndThrow();
        return ["CUSTOM_SUBJECT"];
      },
      invalidate() {
        if (phase === "invalidate") poisonAndThrow();
      },
    };
    const pane = fixture(t, {
      renderCall(args, _theme, context) {
        assert.equal(context.args, args);
        argsRefs.push(args);
        savedInvalidate ??= context.invalidate;
        return component;
      },
      renderResult(received, _options, _theme, context) {
        argsRefs.push(context.args);
        resultRefs.push(received);
        return new Text("CUSTOM_SUBJECT_RESULT", 0, 0);
      },
    });
    assert.match(paint(pane.content), /CUSTOM_SUBJECT/);
    assert.ok(resultRefs.length > 0, "lazy failure retains an actual result callback copy");
    const siblingPaints = pane.siblingRender.mock.callCount();
    armed = true;
    savedInvalidate();
    assertRaw(pane);
    assert.equal(
      pane.siblingRender.mock.callCount(),
      siblingPaints,
      "subject failure does not repaint a healthy cached sibling",
    );
    for (const args of argsRefs) poisonArgs(args, "POISON_LATE_ARGS");
    for (const received of resultRefs) poisonResult(received, "POISON_LATE_RESULT");
    pane.content.invalidate();
    assertRaw(pane);
  });
}

test("healthy recomputes get fresh args/result while state and lastComponent persist", (t) => {
  const calls = [];
  const results = [];
  const argsSeen = new Set();
  const resultContentSeen = new Set();
  const resultDetailsSeen = new Set();
  let savedInvalidate;
  let sharedState;
  const observe = (context) => {
    savedInvalidate ??= context.invalidate;
    sharedState ??= context.state;
    assert.equal(context.state, sharedState, "state identity persists across both callbacks");
    sharedState.label ??= "HEALTHY_FIRST";
    assert.deepEqual(context.args, originalArgs(), "each callback starts from pristine args");
    assert.ok(!argsSeen.has(context.args), "a prior callback's mutable args are not reused");
    argsSeen.add(context.args);
  };
  const pane = fixture(t, {
    renderCall(args, _theme, context) {
      observe(context);
      assert.equal(args, context.args);
      const view = context.lastComponent ?? new Text("", 0, 0);
      calls.push({ last: context.lastComponent, view });
      view.setText(sharedState.label);
      poisonArgs(args);
      return view;
    },
    renderResult(received, _options, _theme, context) {
      observe(context);
      assert.deepEqual(received.content, [{ type: "text", text: "ORIGINAL_RESULT" }]);
      assert.deepEqual(received.details, { nested: { label: "ORIGINAL_DETAILS" } });
      assert.ok(!resultContentSeen.has(received.content));
      assert.ok(!resultDetailsSeen.has(received.details));
      resultContentSeen.add(received.content);
      resultDetailsSeen.add(received.details);
      const view = context.lastComponent ?? new Text("", 0, 0);
      results.push({ last: context.lastComponent, view });
      view.setText(`${sharedState.label}_RESULT`);
      poisonArgs(context.args);
      poisonResult(received);
      return view;
    },
  });
  assert.match(paint(pane.content), /HEALTHY_FIRST_RESULT/);
  pane.intact();
  const before = { calls: calls.length, results: results.length };
  const siblingPaints = pane.siblingRender.mock.callCount();
  sharedState.label = "HEALTHY_REFRESHED";
  savedInvalidate();
  const next = paint(pane.content);
  assert.match(next, /HEALTHY_REFRESHED_RESULT/);
  assert.ok(calls.length > before.calls && results.length > before.results);
  for (const entries of [calls, results]) {
    assert.ok(entries.length >= 2);
    for (const entry of entries.slice(1)) {
      assert.equal(
        entry.last,
        entries[0].view,
        "lastComponent stays the original public component",
      );
      assert.equal(entry.view, entries[0].view);
    }
  }
  assert.match(next, /HEALTHY_SIBLING/);
  assert.equal(pane.siblingRender.mock.callCount(), siblingPaints);
  pane.intact();
});

test("a result arriving after call failure updates raw with the latest settled record", (t) => {
  let savedArgs;
  const pane = fixture(
    t,
    {
      renderCall(args) {
        savedArgs = args;
        poisonArgs(args);
        throw new Error("call fails before settlement");
      },
    },
    { settled: false },
  );
  assert.match(paint(pane.content), /ORIGINAL_ARGUMENT/);
  pane.appendResult("LATEST_SETTLED_RESULT");
  assertRaw(pane, "LATEST_SETTLED_RESULT");
  poisonArgs(savedArgs, "POISON_AFTER_SETTLEMENT");
  pane.content.invalidate();
  const text = assertRaw(pane, "LATEST_SETTLED_RESULT");
  assert.doesNotMatch(text, /ORIGINAL_RESULT/, "no stale or invented result replaces settlement");
});

test("result-triggered failure falls back to the arriving record, not a pre-result snapshot", (t) => {
  let savedResult;
  const pane = fixture(
    t,
    {
      renderCall: () => new Text("CUSTOM_SUBJECT", 0, 0),
      renderResult(received) {
        savedResult = received;
        poisonResult(received);
        throw new Error("failure on latest result");
      },
    },
    { settled: false },
  );
  assert.match(paint(pane.content), /CUSTOM_SUBJECT/);
  pane.appendResult("LATEST_SETTLED_RESULT");
  assertRaw(pane, "LATEST_SETTLED_RESULT");
  poisonResult(savedResult, "POISON_LATE_RESULT");
  pane.content.invalidate();
  assertRaw(pane, "LATEST_SETTLED_RESULT");
});

test("fallback preserves projected structural markers without rereading the original record", (t) => {
  let getterCalls = 0;
  const args = originalArgs();
  Object.defineProperty(args.nested, "blocked", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "MUST_NOT_READ_RECORD_GETTER";
    },
  });
  // This descriptor-bearing record intentionally cannot use fixture's
  // structuredClone (which reads getters). Observe it directly, passively.
  const messages = [callMessage("subject", "specimen", args), resultMessage()];
  const before = Object.getOwnPropertyDescriptors(args.nested);
  const content = new TranscriptContent({
    tui: { requestRender() {} },
    cwd: home,
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => ({
        renderCall(received) {
          assert.equal(received.nested.blocked, "[accessor property]");
          received.nested.blocked = "POISON_MARKER";
          throw new Error("failure after marker mutation");
        },
      }),
    },
  });
  t.after(() => content.dispose());
  content.setToolsExpanded(true);
  const text = paint(content);
  assert.ok(text.includes("[accessor property]"));
  assert.doesNotMatch(text, /POISON_MARKER|MUST_NOT_READ_RECORD_GETTER/);
  assert.equal(getterCalls, 0, "snapshot/raw use the passive projection, never source getters");
  assert.deepEqual(Object.getOwnPropertyDescriptors(args.nested), before);
  assert.equal(messages[0].content[0].arguments, args);
  assert.equal(messages[1].content[0].text, "ORIGINAL_RESULT");
});
