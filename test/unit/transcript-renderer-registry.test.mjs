import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Source-only through jiti (`fsCache: false`), never a stale dist build. The
// renderer registry contract under test is the pane's own: display callbacks
// only, detached projections in, bounded raw fallback for everything the
// registry cannot or must not answer. Real native renderer functions and the
// SDK session surface belong to the SDK/API lanes, not this UI projection.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { blockedDelegationToolNames } = await jiti.import(
  "../../src/orchestration/tools/tool-names.ts",
);
const { createChildToolRendererLookup } = await jiti.import(
  "../../src/orchestration/runtime/child-tool-renderers.ts",
);

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

const call = (id, name, args = { command: "npm test" }) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  ...extra,
});
const result = (id, name, text, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});

/** A pane over the given source, read back as the text it would paint. */
function contentOver(messages, { lookup, revision, inFlight, tui: ui = tui } = {}) {
  const lookups = [];
  const content = new TranscriptContent({
    tui: ui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => inFlight?.(),
      toolDefinition(name) {
        lookups.push(name);
        return lookup?.(name);
      },
      ...(revision ? { toolRenderersRevision: () => revision() } : {}),
    },
  });
  return { content, lookups };
}

const paint = (content, width = 160) =>
  content.slice(width, 0, content.lineCount(width)).join("\n");

/** Display-only renderer that records what the pane handed it. The `execute`
 * spy is hostile-source shape: the pane must never call it, because display
 * callbacks are all a transcript projection may invoke. */
function recordingRenderers(marker, log = []) {
  const calls = { execute: 0 };
  const renderers = {
    // Deliberately not a ToolRenderers key: the pane hands display callbacks
    // only, so an execution channel must stay untouched even if present.
    execute: () => {
      calls.execute++;
      throw new Error("transcript rendering must never execute a tool");
    },
    renderCall: (args, _theme, context) => {
      log.push({ slot: "call", marker, args, context });
      return new Text(`${marker}_CALL`);
    },
    renderResult: (received, _options, _theme, _context) => {
      log.push({ slot: "result", marker, received });
      return new Text(`${marker}_RESULT`);
    },
  };
  return { renderers, log, calls };
}

test("native public tool names select their registry renderers; execute is never called", () => {
  const native = ["read", "bash", "edit"];
  const registry = new Map();
  const logs = [];
  for (const name of native) {
    const { renderers, log } = recordingRenderers(`MARK_${name.toUpperCase()}`);
    registry.set(name, renderers);
    logs.push({ name, log });
  }
  const custom = recordingRenderers("MARK_CUSTOM", []);
  registry.set("mcp_docs__search", custom.renderers);
  const messages = [
    { role: "user", content: "REGISTRY_USER_TEXT", timestamp: 0 },
    assistant(
      [
        call("r1", "read", { path: "src/a.ts" }),
        call("b1", "bash", { command: "npm test" }),
        call("e1", "edit", { path: "src/a.ts", oldText: "a", newText: "b" }),
        call("c1", "mcp_docs__search", { query: "term" }),
      ],
      { timestamp: 1 },
    ),
    result("r1", "read", "READ_OUTPUT"),
    result("b1", "bash", "BASH_OUTPUT"),
    result("e1", "edit", "EDIT_OUTPUT"),
    result("c1", "mcp_docs__search", "CUSTOM_OUTPUT"),
  ];
  const before = structuredClone(messages);
  const { content, lookups } = contentOver(messages, {
    lookup: (name) => registry.get(name),
  });
  try {
    const text = paint(content);
    for (const marker of ["MARK_READ", "MARK_BASH", "MARK_EDIT", "MARK_CUSTOM"])
      assert.match(text, new RegExp(`${marker}_CALL`), `${marker} call is on screen`);
    for (const marker of ["MARK_READ", "MARK_BASH", "MARK_EDIT", "MARK_CUSTOM"])
      assert.match(text, new RegExp(`${marker}_RESULT`), `${marker} result is on screen`);
    assert.deepEqual(
      lookups,
      ["read", "bash", "edit", "mcp_docs__search"],
      "the registry is queried once per recorded call, by name",
    );
    assert.equal(custom.calls.execute, 0, "display rendering never executes a tool");
    for (const { log } of logs) assert.equal(log.length > 0, true);
    assert.deepEqual(messages, before, "rendering rewrites no recorded history");
  } finally {
    content.dispose();
  }
});

test("renderers receive the detached, terminal-safe argument projection", () => {
  const osc52 = "\x1b]52;c;CLIPBOARD_PAYLOAD\x07";
  const bidi = "R\u2068everse\u2069";
  const emoji = "\u{1F44D} ok \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  const arguments_ = { command: `echo ${osc52}\x07 ${bidi} ${emoji}` };
  const messages = [assistant([call("b1", "bash", arguments_)])];
  const before = structuredClone(messages);
  const { renderers, log } = recordingRenderers("MARK_SANITIZED");
  const { content } = contentOver(messages, { lookup: () => renderers });
  try {
    const text = paint(content);
    assert.match(text, /MARK_SANITIZED_CALL/);
    const seen = log.find((entry) => entry.slot === "call");
    assert.ok(seen, "the renderer was called");
    assert.notEqual(seen.args, arguments_, "the renderer never sees the recorded object");
    assert.notEqual(seen.args.command, arguments_.command, "nor the recorded string");
    assert.ok(!seen.args.command.includes("\x1b"), "no raw escape reaches display code");
    assert.ok(!seen.args.command.includes("\x07"), "no raw control character survives");
    assert.ok(seen.args.command.includes("\\x07"), "controls are explicitly escaped");
    assert.ok(seen.args.command.includes("\\u2068"), "bidi isolates are explicitly escaped");
    assert.ok(
      seen.args.command.includes("\u{1F44D}") &&
        seen.args.command.includes("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"),
      "emoji and grapheme clusters survive the projection",
    );
    assert.equal(seen.context.args, seen.args, "the context carries the same projection");
    assert.equal(seen.context.cwd, "/w", "the pane's cwd is the recorded child cwd");
    assert.deepEqual(messages, before, "the projection never mutates the record");
  } finally {
    content.dispose();
  }
});

test("historical cards are never marked args-complete or execution-started", (t) => {
  const complete = t.mock.method(
    ToolExecutionComponent.prototype,
    "setArgsComplete",
    ToolExecutionComponent.prototype.setArgsComplete,
  );
  const started = t.mock.method(
    ToolExecutionComponent.prototype,
    "markExecutionStarted",
    ToolExecutionComponent.prototype.markExecutionStarted,
  );
  const { renderers, log } = recordingRenderers("MARK_HISTORY");
  const messages = [assistant([call("b1", "bash")]), result("b1", "bash", "DONE_MARKER")];
  const { content } = contentOver(messages, { lookup: () => renderers });
  t.after(() => content.dispose());
  const seen = () => log.find((entry) => entry.slot === "call");
  assert.match(paint(content), /MARK_HISTORY_CALL/);
  assert.equal(seen().context.argsComplete, false, "recorded arguments are never complete");
  assert.equal(seen().context.executionStarted, false, "history never claims execution started");
  messages.push(assistant([call("b2", "bash")], { timestamp: 2 }));
  assert.match(paint(content), /MARK_HISTORY_CALL/);
  content.setToolsExpanded(true);
  assert.match(paint(content), /MARK_HISTORY_CALL/);
  content.setTheme({ ...getMarkdownTheme() });
  assert.match(paint(content), /MARK_HISTORY_CALL/);
  assert.equal(complete.mock.callCount(), 0, "setArgsComplete is never called by the pane");
  assert.equal(started.mock.callCount(), 0, "markExecutionStarted is never called by the pane");
});

test("well-formed communication calls take the labeled bubble without a registry query", () => {
  const { renderers, log } = recordingRenderers("MARK_ALERT");
  const messages = [
    assistant([call("a1", "alert_parent", { message: "ALERT_TEXT_SENT" })]),
    result("a1", "alert_parent", "Alert queued. Continue working."),
    assistant([call("q1", "ask_parent", { question: "QUESTION_TEXT_SENT" })]),
    result("q1", "ask_parent", "Question recorded."),
  ];
  const { content, lookups } = contentOver(messages, { lookup: () => renderers });
  try {
    const text = paint(content, 200);
    assert.match(text, /Alert to parent/, "a well-formed alert gets its labeled block");
    assert.match(text, /ALERT_TEXT_SENT/);
    assert.match(text, /Question to parent/, "and a well-formed question too");
    assert.match(text, /QUESTION_TEXT_SENT/);
    assert.doesNotMatch(text, /MARK_ALERT/, "the registry renderer did not paint it");
    assert.deepEqual(lookups, [], "communication names never query the registry");
    assert.equal(log.length, 0, "their renderers are never invoked");
  } finally {
    content.dispose();
  }
});

test("malformed communication records stay raw without a disguised resolver message", () => {
  const { renderers } = recordingRenderers("MARK_ALERT");
  const messages = [
    assistant([call("m1", "alert_parent", { message: 42 })]),
    assistant([call("m2", "ask_parent", { question: "q", extra: 1 })]),
    assistant([call("m3", "alert_parent", { message: "" })]),
  ];
  const { content, lookups } = contentOver(messages, { lookup: () => renderers });
  try {
    const text = paint(content, 200);
    assert.match(text, /alert_parent/, "a malformed call keeps the raw tool name");
    assert.match(text, /message: 42/, "and its raw argument data");
    assert.match(text, /ask_parent/);
    assert.match(text, /extra: 1/);
    assert.doesNotMatch(text, /Alert to parent|Question to parent|MARK_ALERT/);
    assert.deepEqual(lookups, [], "malformed communication names never query the registry");
  } finally {
    content.dispose();
  }
});

test("blocked delegation and retired management names never query the registry", () => {
  const { renderers } = recordingRenderers("MARK_ALLOWED");
  const messages = [
    assistant([
      call("n1", "notify_parent", { message: "OLD_NOTICE" }),
      call("s1", "agent_spawn", { prompt: "x" }),
      call("d1", "delegate", { task: "x" }),
      call("b1", "bash", { command: "npm test" }),
    ]),
  ];
  const { content, lookups } = contentOver(messages, { lookup: () => renderers });
  try {
    const text = paint(content, 200);
    for (const name of ["notify_parent", "agent_spawn", "delegate"]) {
      assert.ok(
        blockedDelegationToolNames.includes(name),
        `${name} is a deny-listed delegation name in this source`,
      );
      assert.match(text, new RegExp(name), `${name} stays raw on screen`);
    }
    assert.match(text, /OLD_NOTICE/, "the retired record's bytes are preserved");
    assert.match(text, /MARK_ALLOWED_CALL/, "an ordinary tool still uses the registry");
    assert.deepEqual(lookups, ["bash"], "only the unblocked name reaches the registry");
  } finally {
    content.dispose();
  }
});

test("a throwing registry lookup falls back to raw instead of dropping the record", () => {
  const messages = [
    assistant([call("b1", "bash", { command: "npm test" })]),
    result("b1", "bash", "RECORDED_OUTPUT"),
  ];
  const { content } = contentOver(messages, {
    lookup: () => {
      throw new Error("REGISTRY_LOOKUP_FAILED");
    },
  });
  try {
    const text = paint(content);
    assert.match(text, /bash/, "the recorded call stays on screen");
    assert.match(text, /command="npm test"/, "with its bounded raw argument preview");
    assert.match(text, /RECORDED_OUTPUT/, "and its recorded result still lands");
  } finally {
    content.dispose();
  }
});

test("throwing renderer callbacks fall back through the public SDK component", () => {
  const messages = [
    assistant([call("b1", "bash", { command: "npm test" })]),
    result("b1", "bash", "RECORDED_OUTPUT"),
  ];
  const { content } = contentOver(messages, {
    lookup: () => ({
      renderCall: () => {
        throw new Error("RENDER_CALL_FAILED");
      },
      renderResult: () => {
        throw new Error("RENDER_RESULT_FAILED");
      },
    }),
  });
  try {
    const text = paint(content);
    assert.match(text, /bash/, "the card survives a throwing call renderer");
    assert.match(text, /command="npm test"/, "through the SDK's own bounded fallback");
    assert.match(
      text,
      /RECORDED_OUTPUT/,
      "the recorded result survives a throwing result renderer",
    );
  } finally {
    content.dispose();
  }
});

test("renderer callbacks receive detached results, not the recorded history itself", () => {
  // The committed display projection and card snapshots detach renderer work
  // copies from retained history. Keep this assertion at the registry seam so
  // connecting a live child's renderers cannot bypass that isolation.
  const record = result("b1", "bash", "RECORDED_OUTPUT");
  const messages = [assistant([call("b1", "bash")]), record];
  let received;
  const { content } = contentOver(messages, {
    lookup: () => ({
      renderCall: () => new Text("MARK_DETACH_CALL"),
      renderResult: (result) => {
        received = result;
        return new Text("MARK_DETACH_RESULT");
      },
    }),
  });
  try {
    const before = structuredClone(messages);
    assert.match(paint(content), /MARK_DETACH_RESULT/);
    assert.ok(received, "the result renderer was called");
    assert.notEqual(received.content, record.content, "content is a detached projection");
    // A renderer that mutates what it was handed must not corrupt history.
    received.content.push({ type: "text", text: "INJECTED_HISTORY" });
    assert.deepEqual(messages, before, "recorded history is immune to renderer mutation");
  } finally {
    content.dispose();
  }
});

test("unknown tools keep the bounded raw fallback, not a definition-less dump", () => {
  const output = Array.from({ length: 15 }, (_, i) => `OUT_LINE_${i}`).join("\n");
  const messages = [
    assistant([call("u1", "mystery_tool", { payload: "x" })]),
    result("u1", "mystery_tool", output),
  ];
  const { content, lookups } = contentOver(messages, { lookup: () => undefined });
  try {
    const text = paint(content);
    assert.deepEqual(lookups, ["mystery_tool"], "the registry was queried and missed");
    assert.match(text, /payload="x"/, "the collapsed card shows the bounded argument preview");
    assert.match(text, /OUT_LINE_9/, "and a bounded result preview");
    assert.match(text, /5 more lines/, "without dumping the whole record");
    assert.doesNotMatch(text, /OUT_LINE_14/);
  } finally {
    content.dispose();
  }
});

test("a renderer binding token change rebuilds cards; an unchanged token never does", () => {
  const { renderers, log } = recordingRenderers("MARK_TOKEN");
  const messages = [
    { role: "user", content: "TOKEN_USER_TEXT", timestamp: 0 },
    assistant([call("b1", "bash")], { timestamp: 1 }),
  ];
  let token = { generation: 1 };
  const { content } = contentOver(messages, {
    lookup: () => renderers,
    revision: () => token,
  });
  try {
    assert.match(paint(content), /MARK_TOKEN_CALL/);
    const anchor = content.captureAnchor(160, 0);
    assert.equal(
      typeof content.resolveAnchor(160, anchor),
      "number",
      "an anchor resolves while the token holds",
    );
    const calls = log.length;
    assert.match(paint(content), /MARK_TOKEN_CALL/);
    assert.equal(log.length, calls, "an unchanged token never rebuilds settled cards");
    assert.equal(content.resolveAnchor(160, anchor), 0, "and the anchor stays stable");

    token = { generation: 2 };
    const rebuilt = paint(content);
    assert.match(rebuilt, /MARK_TOKEN_CALL/, "the rebuilt card uses the live binding");
    assert.match(rebuilt, /TOKEN_USER_TEXT/, "a binding change clears no recorded history");
    assert.ok(log.length > calls, "the token change rebuilt the cards");
    assert.equal(
      content.resolveAnchor(160, anchor),
      undefined,
      "an anchor from the old token generation is invalid",
    );
    const fresh = content.captureAnchor(160, 0);
    assert.equal(
      typeof content.resolveAnchor(160, fresh),
      "number",
      "a fresh anchor resolves against the rebuilt blocks",
    );
  } finally {
    content.dispose();
  }
});

test("an unbound registry falls back to raw, and a theme rebuild revives no callback", () => {
  const { renderers, log } = recordingRenderers("MARK_UNBOUND");
  const messages = [
    { role: "user", content: "UNBOUND_USER_TEXT", timestamp: 0 },
    assistant([call("b1", "bash", { command: "echo kept" })], { timestamp: 1 }),
  ];
  let bound = true,
    token = { generation: 1 };
  const { content } = contentOver(messages, {
    lookup: () => (bound ? renderers : undefined),
    revision: () => token,
  });
  try {
    assert.match(paint(content), /MARK_UNBOUND_CALL/);
    const calls = log.length;
    bound = false;
    token = { generation: 2 };
    const text = paint(content);
    assert.doesNotMatch(text, /MARK_UNBOUND/, "the retired callback paints nothing");
    assert.equal(log.length, calls, "and is never invoked again");
    assert.match(text, /bash/, "the card falls back to bounded raw rendering");
    assert.match(text, /command: echo kept/, "with its recorded arguments");
    assert.match(text, /UNBOUND_USER_TEXT/, "and the recorded history stays on screen");
    // A later theme rebuild re-creates the blocks but must not resurrect the
    // retired binding: the source still answers raw, the old callback stays
    // uninvoked, and the history survives it too.
    content.setTheme({ ...getMarkdownTheme() });
    const rebuilt = paint(content);
    assert.doesNotMatch(rebuilt, /MARK_UNBOUND/, "the theme rebuild stays generic");
    assert.equal(log.length, calls, "the retired callback is never revived");
    assert.match(rebuilt, /UNBOUND_USER_TEXT/);
  } finally {
    content.dispose();
  }
});

test("a theme switch keeps the current renderer binding", () => {
  const { renderers } = recordingRenderers("MARK_THEME");
  const messages = [assistant([call("b1", "bash")]), result("b1", "bash", "DONE_MARKER")];
  const { content } = contentOver(messages, { lookup: () => renderers });
  try {
    assert.match(paint(content), /MARK_THEME_CALL/);
    content.setTheme({ ...getMarkdownTheme() });
    const text = paint(content);
    assert.match(text, /MARK_THEME_CALL/, "the live renderer survives the theme rebuild");
    assert.match(text, /MARK_THEME_RESULT/);
  } finally {
    content.dispose();
  }
});

test("pure assistant streaming never rebuilds settled cards or clears history", () => {
  const { renderers, log } = recordingRenderers("MARK_STREAM");
  const messages = [
    { role: "user", content: "STREAM_USER_TEXT", timestamp: 0 },
    assistant([call("b1", "bash")], { timestamp: 1 }),
    result("b1", "bash", "DONE_MARKER"),
  ];
  let streaming = {
    role: "assistant",
    content: [{ type: "text", text: "STREAM_ONE" }],
    stopReason: "pending",
  };
  const token = { generation: 1 };
  const { content } = contentOver(messages, {
    lookup: () => renderers,
    revision: () => token,
    inFlight: () => streaming,
  });
  try {
    const first = paint(content);
    assert.match(first, /MARK_STREAM_CALL/);
    assert.match(first, /STREAM_ONE/);
    const anchor = content.captureAnchor(160, 0);
    const calls = log.length;
    streaming = {
      role: "assistant",
      content: [{ type: "text", text: "STREAM_TWO" }],
      stopReason: "pending",
    };
    const second = paint(content);
    const third = paint(content);
    for (const text of [second, third]) {
      assert.match(text, /MARK_STREAM_CALL/, "the settled card keeps its renderer");
      assert.match(text, /MARK_STREAM_RESULT/, "and its settled result rendering");
      assert.match(text, /STREAM_USER_TEXT/, "settled history is never cleared per token");
    }
    assert.match(third, /STREAM_TWO/, "the streaming tail advances");
    assert.equal(log.length, calls, "streaming never rebuilds the settled cards");
    assert.equal(
      content.resolveAnchor(160, anchor),
      0,
      "the anchor stays stable across streaming tokens",
    );
  } finally {
    content.dispose();
  }
});

/** A bound pane with one recorded tool card, unbindable without a frame. */
function syncFixture() {
  const { renderers, log } = recordingRenderers("MARK_SYNC");
  const messages = [
    { role: "user", content: "SYNC_USER_TEXT", timestamp: 0 },
    assistant([call("b1", "bash", { command: "echo kept" })], { timestamp: 1 }),
  ];
  let bound = true,
    token = { generation: 1 };
  const { content } = contentOver(messages, {
    lookup: () => (bound ? renderers : undefined),
    revision: () => token,
  });
  return {
    content,
    log,
    unbind: () => {
      bound = false;
      token = { generation: 2 };
    },
  };
}

// The production pane applies presentation controls before it frames: a pane
// render calls setToolsExpanded() and then frame(), and palette/size changes
// arrive as invalidate()/invalidateLayout(). After an unbind, each entry point
// must retire the old callback-bearing cards itself, before any SDK operation
// can render or invalidate them -- not wait for the next frame's consume().
for (const [entry, drive] of [
  ["setToolsExpanded(true)", (content) => content.setToolsExpanded(true)],
  ["a same-value setToolsExpanded(false)", (content) => content.setToolsExpanded(false)],
  ["invalidate()", (content) => content.invalidate()],
  ["invalidateLayout()", (content) => content.invalidateLayout()],
])
  test(`an unbind retires old callbacks at ${entry}, before the next frame`, () => {
    const pane = syncFixture();
    try {
      assert.match(paint(pane.content), /MARK_SYNC_CALL/);
      const calls = pane.log.length;
      pane.unbind();
      drive(pane.content);
      assert.equal(
        pane.log.length,
        calls,
        "the retired callback did not run while the entry was applied",
      );
      const text = paint(pane.content);
      assert.doesNotMatch(text, /MARK_SYNC/, "the next frame is generic raw");
      assert.match(text, /bash/, "the card falls back to bounded raw rendering");
      assert.match(text, /command: echo kept/, "with its recorded arguments");
      assert.match(text, /SYNC_USER_TEXT/, "and the recorded history stays on screen");
      assert.equal(pane.log.length, calls, "and the callback stays uninvoked after it");
    } finally {
      pane.content.dispose();
    }
  });

test("public native tool definitions render real callbacks without executing or reading the worktree", async (t) => {
  const cwd = "/w";
  const definitions = new Map(
    [
      ["read", createReadToolDefinition(cwd)],
      ["bash", createBashToolDefinition(cwd)],
      ["edit", createEditToolDefinition(cwd)],
    ].map(([name, definition]) => [
      name,
      // Any invocation of the execution path fails loudly instead of running.
      {
        ...definition,
        execute: () => {
          throw new Error(`NATIVE_${name.toUpperCase()}_EXECUTE_MUST_NOT_RUN`);
        },
      },
    ]),
  );
  // The production lookup: the public session read surface only, projected to
  // the three display keys. The native renderers must survive that projection.
  const lookup = createChildToolRendererLookup({
    getToolDefinition: (name) => definitions.get(name),
    extensionRunner: { resolveToolRenderers: (_name, base) => base() },
  });
  for (const name of ["read", "bash", "edit"]) {
    const projected = lookup(name);
    assert.ok(projected, `${name}'s native renderers survive the production projection`);
    assert.ok(!("execute" in projected), "the pane receives display callbacks only");
  }
  const messages = [
    { role: "user", content: "NATIVE_USER_TEXT", timestamp: 0 },
    assistant(
      [
        call("r1", "read", { path: "recorded/only.txt" }),
        call("b1", "bash", { command: "echo RECORDED_BASH_OUTPUT" }),
        call("e1", "edit", {
          path: "recorded/only.txt",
          edits: [{ oldText: "ORIGINAL_BASEMENT_TEXT", newText: "REPLACED_LOFT_TEXT" }],
        }),
      ],
      { timestamp: 1 },
    ),
    {
      role: "toolResult",
      toolCallId: "r1",
      toolName: "read",
      content: [{ type: "text", text: "RECORDED_FILE_LINE_ONE\nRECORDED_FILE_LINE_TWO" }],
      details: {
        truncation: { truncated: true, truncatedBy: "lines", outputLines: 2, totalLines: 5 },
      },
      isError: false,
    },
    result("b1", "bash", "RECORDED_BASH_OUTPUT"),
    {
      role: "toolResult",
      toolCallId: "e1",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in recorded/only.txt." }],
      details: {
        diff: "-3 ORIGINAL_BASEMENT_TEXT\n+3 REPLACED_LOFT_TEXT",
        firstChangedLine: 3,
      },
      isError: false,
    },
  ];
  const before = structuredClone(messages);
  const rendered = { requestRender: 0 };
  const { content } = contentOver(messages, {
    lookup,
    tui: {
      requestRender() {
        rendered.requestRender++;
      },
      terminal: { columns: 80, rows: 24 },
    },
  });
  t.after(() => content.dispose());
  const complete = t.mock.method(
    ToolExecutionComponent.prototype,
    "setArgsComplete",
    ToolExecutionComponent.prototype.setArgsComplete,
  );
  const started = t.mock.method(
    ToolExecutionComponent.prototype,
    "markExecutionStarted",
    ToolExecutionComponent.prototype.markExecutionStarted,
  );
  content.setToolsExpanded(true); // The read renderer shows results only expanded.
  const text = paint(content, 200);
  // read: the recorded call and result, from the record only -- the file does
  // not exist under the pane's cwd, so any worktree read would show nothing.
  assert.match(text, /recorded\/only\.txt/, "the read call shows its recorded path");
  assert.match(text, /RECORDED_FILE_LINE_ONE/);
  assert.match(text, /RECORDED_FILE_LINE_TWO/);
  assert.match(
    text,
    /\[Truncated: showing 2 of 5 lines/,
    "the recorded read details (truncation) render",
  );
  // bash: the native $ prompt and the recorded output text.
  assert.match(text, /\$ echo RECORDED_BASH_OUTPUT/);
  // edit: the recorded diff and firstChangedLine from the result details.
  assert.match(text, /ORIGINAL_BASEMENT_TEXT/, "the recorded removed line renders");
  assert.match(text, /REPLACED_LOFT_TEXT/, "and the recorded added line");
  assert.equal(complete.mock.callCount(), 0, "native rendering never completes arguments");
  assert.equal(started.mock.callCount(), 0, "native rendering never marks execution started");
  assert.deepEqual(messages, before, "rendering rewrites no recorded history");
  // The edit call renderer reads the worktree only once arguments are
  // complete; they never are here, so no async preview can even start.
  await new Promise((resolve) => setImmediate(resolve));
  paint(content, 200);
  assert.equal(
    rendered.requestRender,
    0,
    "no native renderer read the worktree or invalidated the pane",
  );
});

test("a native edit diff carrying terminal protocols is filtered in painted rows only", (t) => {
  const osc52 = "\x1b]52;c;CLIPBOARD_PAYLOAD\x07";
  const clearCsi = "\x1b[2J";
  const bidi = "\u2068BIDI\u2069";
  const cjkEmoji = "你好\u{1F44D}";
  // A real public native edit definition, with its result renderer wrapped by a
  // spy that records what the pane handed it before the real callback runs.
  const edit = createEditToolDefinition("/w");
  const nativeResult = edit.renderResult;
  let received;
  const definitions = new Map([
    [
      "edit",
      {
        ...edit,
        renderResult: (result, options, theme, context) => {
          received ??= result;
          return nativeResult(result, options, theme, context);
        },
      },
    ],
  ]);
  const lookup = createChildToolRendererLookup({
    getToolDefinition: (name) => definitions.get(name),
    extensionRunner: { resolveToolRenderers: (_name, base) => base() },
  });
  const diff = `-3 OLDPROTOCOLROW ${osc52}\n+3 NEWPROTOCOLROW ${clearCsi}${bidi} ${cjkEmoji}`;
  const messages = [
    { role: "user", content: "PROTOCOL_USER_TEXT", timestamp: 0 },
    assistant(
      [call("e1", "edit", { path: "recorded/only.txt", edits: [{ oldText: "a", newText: "b" }] })],
      { timestamp: 1 },
    ),
    {
      role: "toolResult",
      toolCallId: "e1",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in recorded/only.txt." }],
      details: { diff, firstChangedLine: 3 },
      isError: false,
    },
  ];
  const before = structuredClone(messages);
  const { content } = contentOver(messages, { lookup });
  t.after(() => content.dispose());
  const rows = paint(content, 200);
  // The recorded diff reaches the renderer literally, protocols included: the
  // filter owns painted rows, not the data the display callbacks consume.
  assert.ok(received, "the native result renderer was invoked");
  assert.ok(
    received.details.diff.includes(osc52) && received.details.diff.includes(clearCsi),
    "the renderer still receives the original diff bytes",
  );
  assert.ok(received.details.diff.includes("\u2068"), "including raw bidi controls");
  // Painted rows carry no clipboard protocol, no non-SGR commands, and no raw
  // bidi controls -- while the legitimate diff text, CJK and emoji survive.
  assert.ok(!rows.includes("\x1b]52"), "no OSC52 sequence reaches the pane rows");
  assert.ok(!rows.includes("CLIPBOARD_PAYLOAD"), "and no clipboard payload survives");
  assert.ok(!rows.includes("\x1b[2J"), "no non-SGR CSI command reaches the pane rows");
  assert.ok(!rows.includes("\u2068"), "no raw bidi control reaches the pane rows");
  assert.ok(rows.includes("\\u2068"), "remaining bidi controls stay explicit");
  assert.ok(rows.includes("OLDPROTOCOLROW"), "the legitimate removed line survives");
  assert.ok(rows.includes("NEWPROTOCOLROW"), "and the legitimate added line");
  assert.ok(rows.includes("你好"), "CJK text survives the row filter");
  assert.ok(rows.includes("\u{1F44D}"), "and emoji survive too");
  assert.deepEqual(messages, before, "the recorded history stays byte-literal");
});
