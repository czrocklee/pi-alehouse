/**
 * Guard lifetime for transcript tool cards, through public TranscriptContent
 * only. Display callbacks save `context.invalidate`; retirement is observed on
 * that handle, never on helper fields.
 *
 * Message text stays on the HEAD contract: user text, tool name, recorded
 * arguments and result text. These cases do not claim bubble chrome, result
 * detachment, terminal-row filtering, blocked-name handling, timer
 * cancellation, or a sandbox around a renderer that calls its own component.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const home = mkdtempSync(join(tmpdir(), "alehouse-transcript-lifecycle-"));
const xdg = join(home, "xdg");
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ["XDG_CONFIG_HOME", join(xdg, "config")],
  ["XDG_DATA_HOME", join(xdg, "data")],
  ["XDG_STATE_HOME", join(xdg, "state")],
  ["XDG_CACHE_HOME", join(xdg, "cache")],
  ["XDG_RUNTIME_DIR", join(xdg, "runtime")],
]) {
  if (key !== "HOME" && key !== "USERPROFILE") mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const runNode = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const transcriptPath = fileURLToPath(
  new URL("../../src/orchestration/ui/transcript.ts", import.meta.url),
);

const { createJiti } = await import("jiti");
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text, Container, Box } = await import("@earendil-works/pi-tui");

initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");

const WIDTH = 160;

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  timestamp: 1,
  ...extra,
});
const result = (id, name, text) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
});

const textOf = (content, width = WIDTH) => {
  const frame = content.frame(width);
  return frame.slice(0, frame.lineCount).join("\n");
};

function recordedText(received) {
  const content = received?.content;
  return (Array.isArray(content) ? content : [])
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** One bound `read` card. The saved call and result handles are the only
 * retirement probes; the pane's private card list is never read. */
function boundRead(t) {
  const log = [];
  let token = { generation: 1 };
  let bound = true;
  let callInvalidate;
  let resultInvalidate;
  let view;
  let invalidateMock;
  let messages = [
    { role: "user", content: "GUARD_USER_TEXT", timestamp: 0 },
    assistant([call("r1", "read", { path: "recorded/only.txt" })]),
    result("r1", "read", "RECORDED_OUTPUT"),
  ];
  const before = structuredClone(messages);
  const ui = {
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
    terminal: { columns: 80, rows: 24 },
  };
  const renderers = {
    renderCall(_args, _theme, context) {
      log.push("call");
      callInvalidate ??= context.invalidate;
      const next =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("READ_CALL", 0, 0);
      if (!view) {
        view = next;
        invalidateMock = t.mock.method(view, "invalidate");
      }
      return next;
    },
    renderResult(received, _options, _theme, context) {
      log.push("result");
      resultInvalidate ??= context.invalidate;
      const view =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      view.setText(`READ_RESULT\n${recordedText(received)}`);
      return view;
    },
  };
  const content = new TranscriptContent({
    tui: ui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => (bound ? renderers : undefined),
      toolRenderersRevision: () => token,
    },
  });
  t.after(() => content.dispose());
  return {
    content,
    ui,
    log,
    messages,
    before,
    saved() {
      callInvalidate();
      resultInvalidate();
    },
    invalidates: () => invalidateMock.mock.callCount(),
    replaceToken() {
      token = { generation: token.generation + 1 };
    },
    unbind() {
      bound = false;
      token = { generation: token.generation + 1 };
    },
    rewrite() {
      // HEAD notices a replaced history array, not an in-place element swap.
      messages = [
        { role: "user", content: "PREFIX_REWRITTEN", timestamp: 9 },
        messages[1],
        messages[2],
      ];
    },
  };
}

function snapshot(pane) {
  return {
    calls: pane.log.length,
    renders: pane.ui.renders,
    invalidates: pane.invalidates(),
  };
}

function assertHandleDead(pane, prior, why) {
  assert.doesNotThrow(() => pane.saved(), why);
  assert.equal(pane.log.length, prior.calls, `${why}: old call/result were not invoked`);
  assert.equal(pane.ui.renders, prior.renders, `${why}: requestRender stayed quiet`);
  assert.equal(
    pane.invalidates(),
    prior.invalidates,
    `${why}: the old component was not invalidated`,
  );
}

test("a live token change revokes saved invalidates before any pane method and after sync", (t) => {
  const pane = boundRead(t);
  assert.match(textOf(pane.content), /READ_CALL/);
  assert.match(textOf(pane.content), /READ_RESULT/);
  const prior = snapshot(pane);
  pane.replaceToken();
  assertHandleDead(pane, prior, "before any pane method");
  pane.content.invalidate();
  assertHandleDead(pane, prior, "after pane sync/reset");
  const text = textOf(pane.content);
  assert.match(text, /READ_CALL/, "the replacement binding renders a new card");
  assert.match(text, /READ_RESULT/);
  assert.match(text, /RECORDED_OUTPUT/, "the result callback still paints the recorded text");
  assert.match(text, /GUARD_USER_TEXT/);
  assert.ok(pane.log.length > prior.calls, "the new card, not the old handle, rendered");
  assertHandleDead(pane, snapshot(pane), "after the replacement card mounted");
  assert.deepEqual(pane.messages, pane.before, "rendering rewrites no recorded history");
});

test("an unbind revokes saved invalidates before any pane method and after sync", (t) => {
  const pane = boundRead(t);
  assert.match(textOf(pane.content), /READ_CALL/);
  const prior = snapshot(pane);
  pane.unbind();
  assertHandleDead(pane, prior, "before any pane method");
  pane.content.lineCount(WIDTH);
  assertHandleDead(pane, prior, "after pane sync/reset");
  const text = textOf(pane.content);
  assert.doesNotMatch(text, /READ_CALL|READ_RESULT/, "the retired callback paints nothing");
  assert.match(text, /read/);
  assert.match(text, /recorded\/only\.txt/, "bounded raw arguments stay visible");
  assert.match(text, /RECORDED_OUTPUT/, "the recorded result stays visible");
  assert.match(text, /GUARD_USER_TEXT/);
  assertHandleDead(pane, snapshot(pane), "after the raw card mounted");
  assert.deepEqual(pane.messages, pane.before);
});

for (const [label, retire] of [
  ["setTheme", (pane) => pane.content.setTheme({ ...getMarkdownTheme() })],
  ["dispose", (pane) => pane.content.dispose()],
  [
    "a history prefix rewrite",
    (pane) => {
      pane.rewrite();
      pane.content.lineCount(WIDTH);
    },
  ],
])
  test(`same-token ${label} revokes saved invalidates`, (t) => {
    const pane = boundRead(t);
    assert.match(textOf(pane.content), /READ_CALL/);
    retire(pane);
    assertHandleDead(pane, snapshot(pane), label);
    if (label === "dispose") return;
    const text = textOf(pane.content);
    assert.match(
      text,
      label === "a history prefix rewrite" ? /PREFIX_REWRITTEN/ : /GUARD_USER_TEXT/,
    );
    assert.match(text, /READ_RESULT/);
    assert.match(text, /RECORDED_OUTPUT/);
    assertHandleDead(pane, snapshot(pane), `${label} after the next frame`);
    if (label !== "a history prefix rewrite") assert.deepEqual(pane.messages, pane.before);
  });

test("an active invalidate refreshes that card's next frame and keeps a sibling cached", (t) => {
  let subjectInvalidate;
  let subjectState;
  let subjectView;
  let reenteredLast;
  let subjectCalls = 0;
  let siblingView;
  let siblingRender;
  const token = { generation: 1 };
  const messages = [
    { role: "user", content: "GUARD_USER_TEXT", timestamp: 0 },
    assistant([call("s1", "read", { path: "sibling/file.txt" })], { timestamp: 1 }),
    assistant([call("f1", "fail_native", { path: "fail/native.txt" })], { timestamp: 2 }),
  ];
  const before = structuredClone(messages);
  const content = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition(name) {
        if (name === "read") {
          return {
            renderCall(_args, _theme, context) {
              const view =
                context.lastComponent instanceof Text
                  ? context.lastComponent
                  : new Text("SIBLING_CARD", 0, 0);
              if (!siblingView) {
                siblingView = view;
                siblingRender = t.mock.method(view, "render");
              }
              return view;
            },
          };
        }
        return {
          renderShell: "self",
          renderCall(_args, _theme, context) {
            subjectCalls += 1;
            subjectInvalidate ??= context.invalidate;
            subjectState = context.state;
            subjectState.label ??= "SUBJECT_CARD";
            const view =
              context.lastComponent instanceof Text
                ? context.lastComponent
                : new Text(subjectState.label, 0, 0);
            if (subjectView) reenteredLast = context.lastComponent;
            subjectView ??= view;
            view.setText(subjectState.label);
            return view;
          },
        };
      },
      toolRenderersRevision: () => token,
    },
  });
  t.after(() => content.dispose());
  const first = textOf(content);
  assert.match(first, /SIBLING_CARD/);
  assert.match(first, /SUBJECT_CARD/);
  const cachedSiblingRenders = siblingRender.mock.callCount();
  const anchor = content.captureAnchor(WIDTH, content.lineCount(WIDTH) - 1);
  assert.equal(typeof anchor, "object");
  const callsBefore = subjectCalls;
  reenteredLast = undefined;
  subjectState.label = "SUBJECT_REFRESHED";
  subjectInvalidate();
  const frame = content.frame(WIDTH);
  const next = frame.slice(0, frame.lineCount).join("\n");
  assert.match(next, /SUBJECT_REFRESHED/, "the next frame shows the recomputed callback");
  assert.doesNotMatch(next, /SUBJECT_CARD/, "stale component text is not enough");
  assert.ok(subjectCalls > callsBefore, "invalidate re-entered the callback");
  assert.ok(subjectView instanceof Text);
  assert.equal(reenteredLast, subjectView, "recompute keeps the original Text");
  assert.match(next, /SIBLING_CARD/);
  assert.match(next, /GUARD_USER_TEXT/);
  assert.equal(
    siblingRender.mock.callCount(),
    cachedSiblingRenders,
    "a healthy sibling card keeps its cached rows",
  );
  assert.equal(
    typeof content.resolveAnchor(WIDTH, anchor),
    "number",
    "the card's block identity survives",
  );
  assert.equal(content.lineCount(WIDTH), frame.lineCount);
  assert.deepEqual(messages, before);
});

test("lastComponent keeps the original Text identity across call and result", (t) => {
  const seen = [];
  const token = { generation: 1 };
  const messages = [
    { role: "user", content: "GUARD_USER_TEXT", timestamp: 0 },
    assistant([call("r1", "read", { path: "recorded/only.txt" })]),
    result("r1", "read", "RECORDED_OUTPUT"),
  ];
  const before = structuredClone(messages);
  const content = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => ({
        renderCall(_args, _theme, context) {
          const view =
            context.lastComponent instanceof Text
              ? context.lastComponent
              : new Text("READ_CALL", 0, 0);
          seen.push({ slot: "call", last: context.lastComponent, view });
          return view;
        },
        renderResult(received, _options, _theme, context) {
          const view =
            context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
          view.setText(`READ_RESULT\n${recordedText(received)}`);
          seen.push({ slot: "result", last: context.lastComponent, view });
          return view;
        },
      }),
      toolRenderersRevision: () => token,
    },
  });
  t.after(() => content.dispose());
  assert.match(textOf(content), /READ_RESULT/);
  content.setToolsExpanded(true);
  assert.match(textOf(content), /READ_CALL/);
  for (const slot of ["call", "result"]) {
    const hits = seen.filter((entry) => entry.slot === slot);
    assert.ok(hits.length >= 2, `${slot} is re-entered with the previous component`);
    assert.ok(hits[0].view instanceof Text);
    assert.equal(hits.at(-1).last, hits[0].view, `${slot} lastComponent is the original Text`);
    assert.equal(hits.at(-1).view, hits[0].view, `${slot} returns that same component`);
  }
  assert.deepEqual(messages, before);
});

test("ordinary stream tokens do not rebuild a settled card or revoke its invalidate", (t) => {
  const log = [];
  let saved;
  let state;
  const token = { generation: 1 };
  let streaming = {
    role: "assistant",
    content: [{ type: "text", text: "STREAM_ONE" }],
    stopReason: "pending",
  };
  const messages = [
    { role: "user", content: "GUARD_USER_TEXT", timestamp: 0 },
    assistant([call("r1", "read", { path: "recorded/only.txt" })]),
    result("r1", "read", "RECORDED_OUTPUT"),
  ];
  const before = structuredClone(messages);
  const content = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => streaming,
      toolDefinition: () => ({
        renderCall(_args, _theme, context) {
          log.push("call");
          saved ??= context.invalidate;
          state = context.state;
          state.label ??= "READ_CALL";
          const view =
            context.lastComponent instanceof Text
              ? context.lastComponent
              : new Text(state.label, 0, 0);
          view.setText(state.label);
          return view;
        },
        renderResult: () => new Text("READ_RESULT", 0, 0),
      }),
      toolRenderersRevision: () => token,
    },
  });
  t.after(() => content.dispose());
  const first = textOf(content);
  assert.match(first, /READ_CALL/);
  assert.match(first, /STREAM_ONE/);
  const calls = log.length;
  const anchor = content.captureAnchor(WIDTH, 0);
  streaming = {
    role: "assistant",
    content: [{ type: "text", text: "STREAM_TWO" }],
    stopReason: "pending",
  };
  const second = textOf(content);
  assert.match(second, /STREAM_TWO/);
  assert.match(second, /READ_CALL/);
  assert.equal(log.length, calls, "streaming does not rebuild the settled card");
  assert.equal(content.resolveAnchor(WIDTH, anchor), 0);
  state.label = "AFTER_STREAM_MARKER";
  saved();
  assert.match(
    textOf(content),
    /AFTER_STREAM_MARKER/,
    "the settled handle recomputes the callback",
  );
  assert.ok(log.length > calls, "the live handle re-entered the settled callback");
  assert.deepEqual(messages, before);
});

test("public Container/Box removeChild and identity queries survive guarded traversal", (t) => {
  for (const Kind of [Container, Box]) {
    for (const phase of ["render", "invalidate"]) {
      const removed = new Text("CHILD_REMOVED", 0, 0);
      const kept = new Text("CHILD_KEEP", 0, 0);
      const queries = [];
      class Removing extends Kind {
        edited = false;
        updateChildren() {
          if (this.edited) return;
          this.edited = true;
          this.removeChild(removed);
          queries.push(
            this.children.indexOf(kept),
            this.children.includes(kept),
            this.children.lastIndexOf(kept),
            this.children.lastIndexOf(kept, undefined),
            this.children.indexOf(this.children[0]),
          );
        }
        render(width) {
          if (phase === "render") this.updateChildren();
          return super.render(width);
        }
        invalidate() {
          if (phase === "invalidate") this.updateChildren();
          return super.invalidate();
        }
      }
      const tree = new Removing();
      tree.addChild(removed);
      tree.addChild(kept);
      tree.addChild(kept);
      const children = tree.children;
      const token = {};
      const messages = [assistant([call("r1", "read", { path: "recorded/only.txt" })])];
      const content = new TranscriptContent({
        tui: { requestRender() {} },
        cwd: "/w",
        markdownTheme: getMarkdownTheme(),
        source: {
          messages: () => messages,
          inFlight: () => undefined,
          toolDefinition: () => ({ renderCall: () => tree }),
          toolRenderersRevision: () => token,
        },
      });
      t.after(() => content.dispose());
      textOf(content);
      if (phase === "invalidate") content.invalidate();
      const painted = textOf(content);
      assert.match(painted, /CHILD_KEEP/, `${Kind.name} ${phase} keeps custom rendering`);
      assert.doesNotMatch(painted, /CHILD_REMOVED/);
      assert.deepEqual(queries, [0, true, 1, 0, 0]);
      assert.equal(tree.children, children);
      assert.deepEqual(tree.children, [kept, kept]);
      assert.equal(Object.getOwnPropertyDescriptor(tree, "children").get, undefined);
    }
  }
});

test(
  "a synchronous invalidate during construct or update is deferred and coalesced",
  { timeout: 15000 },
  async () => {
    // A callback that invalidates itself can recurse or queue forever. Prove the
    // bound in a child so a microtask storm cannot hang this runner. This does
    // not claim that renderer-owned timers are cleared.
    const script = `
import { createJiti } from "jiti";
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text } = await import("@earendil-works/pi-tui");
initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import(process.env.ALEHOUSE_TRANSCRIPT);
const WIDTH = 160;
const token = { generation: 1 };
const CAP = 12;
let calls = 0;
let results = 0;
let renders = 0;
const messages = [
  { role: "user", content: "GUARD_USER_TEXT", timestamp: 0 },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "recorded/only.txt" } }],
    stopReason: "toolUse",
    timestamp: 1,
  },
];
const before = JSON.stringify(messages);
const content = new TranscriptContent({
  tui: {
    requestRender() { renders += 1; },
    terminal: { columns: 80, rows: 24 },
  },
  cwd: "/w",
  markdownTheme: getMarkdownTheme(),
  source: {
    messages: () => messages,
    inFlight: () => undefined,
    toolDefinition: () => ({
      renderShell: "self",
      renderCall(_args, _theme, context) {
        calls += 1;
        const state = context.state;
        const view = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        if (calls > CAP) {
          view.setText("RUNAWAY");
          return view;
        }
        state.passes = (state.passes ?? 0) + 1;
        // The construct/setExpanded pair must not be enough. Only a coalesced
        // follow-up recompute, after those two, paints the settled label.
        state.label = state.passes < 3 ? "COALESCE_PENDING" : "COALESCE_DONE";
        view.setText(state.label);
        if (state.passes === 1) {
          for (let n = 0; n < 5; n += 1) context.invalidate();
        }
        return view;
      },
      renderResult(_received, _options, _theme, context) {
        results += 1;
        const state = context.state;
        const view = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        if (results > CAP) {
          view.setText("RUNAWAY");
          return view;
        }
        state.resultPasses = (state.resultPasses ?? 0) + 1;
        const recorded = (Array.isArray(_received?.content) ? _received.content : [])
          .map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\\n");
        state.resultLabel = state.resultPasses < 3 ? "RESULT_PENDING" : "RESULT_DONE";
        view.setText(state.resultLabel + "\\n" + recorded);
        if (state.resultPasses === 1) {
          for (let n = 0; n < 5; n += 1) context.invalidate();
        }
        return view;
      },
    }),
    toolRenderersRevision: () => token,
  },
});
const paint = () => content.slice(WIDTH, 0, content.lineCount(WIDTH)).join("\\n");
paint();
await new Promise((resolve) => setTimeout(resolve, 40));
const afterConstruct = { calls, results, renders, text: paint() };
messages.push({
  role: "toolResult",
  toolCallId: "r1",
  toolName: "read",
  content: [{ type: "text", text: "RECORDED_OUTPUT" }],
  isError: false,
});
const withResult = JSON.stringify(messages);
paint();
await new Promise((resolve) => setTimeout(resolve, 40));
const afterUpdate = { calls, results, renders, text: paint() };
await new Promise((resolve) => setTimeout(resolve, 40));
const settled = { calls, results, renders };
content.dispose();
const report = { afterConstruct, afterUpdate, settled, intact: JSON.stringify(messages) === withResult };
console.log(JSON.stringify(report));
const grew = settled.calls !== afterUpdate.calls || settled.results !== afterUpdate.results || settled.renders !== afterUpdate.renders;
const bounded = afterConstruct.calls >= 3 && afterConstruct.calls <= 6
  && afterConstruct.renders <= 2
  && afterUpdate.results >= 3 && afterUpdate.results <= 6
  && afterUpdate.calls <= 8 && afterUpdate.renders <= 4;
const shown = afterConstruct.text.includes("COALESCE_DONE")
  && afterConstruct.text.includes("GUARD_USER_TEXT")
  && !afterConstruct.text.includes("RUNAWAY")
  && afterUpdate.text.includes("RESULT_DONE")
  && afterUpdate.text.includes("RECORDED_OUTPUT")
  && !afterUpdate.text.includes("RUNAWAY");
if (grew || !bounded || !shown || !report.intact) process.exitCode = 1;
`;
    const { stdout, stderr } = await runNode(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: repoRoot,
        env: { ...process.env, ALEHOUSE_TRANSCRIPT: transcriptPath },
        timeout: 8000,
        encoding: "utf8",
      },
    );
    assert.equal(stderr, "", "the isolated coalesce probe must not write errors");
    const report = JSON.parse(stdout);
    assert.equal(report.intact, true, "the pane does not rewrite the recorded result");
    assert.ok(
      report.afterConstruct.calls >= 3 && report.afterConstruct.calls <= 6,
      "construct invalidates recompute once, not once per nested call",
    );
    assert.ok(
      report.afterConstruct.renders <= 2,
      "five synchronous invalidates coalesce into one deferred wake",
    );
    assert.equal(report.afterConstruct.text.includes("COALESCE_DONE"), true);
    assert.ok(report.afterUpdate.results >= 3 && report.afterUpdate.results <= 6);
    assert.ok(report.afterUpdate.renders <= 4, "the update round coalesces too");
    assert.equal(report.afterUpdate.text.includes("RESULT_DONE"), true);
    assert.equal(report.settled.calls, report.afterUpdate.calls, "the coalesce chain stops");
    assert.equal(report.settled.renders, report.afterUpdate.renders, "no further wakes are queued");
  },
);
