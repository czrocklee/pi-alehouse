import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChildActivity } from "../../dist/orchestration/runtime/activity-observer.js";
import { generationLine, renderActivity } from "../../dist/orchestration/ui/format.js";
import { renderRunningLines, renderWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { renderDetailFields } from "../../dist/orchestration/ui/agent-detail.js";
import { settings } from "../support/controller-fixture.mjs";

const theme = { fg: (_color, value) => value, bold: (value) => value };
const styled = {
  fg: (color, value) => `\x1b[${color === "muted" ? 37 : 90}m${value}\x1b[0m`,
  bold: (value) => value,
};
function observer() {
  const child = new ChildActivity("/w"),
    handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (type, event = {}) => handlers.get(type)({ type, ...event });
  const message = { role: "assistant", content: [] };
  const update = (type, content = "", contentIndex = 0, extra = {}) => {
    const thinking = type.startsWith("thinking_");
    const previous = message.content[contentIndex];
    const before = thinking ? (previous?.thinking ?? "") : (previous?.text ?? "");
    message.content[contentIndex] = thinking
      ? { type: "thinking", thinking: content }
      : { type: "text", text: content };
    emit("message_update", {
      message,
      assistantMessageEvent: {
        type,
        contentIndex,
        partial: message,
        delta: content.slice(before.length),
        content,
        ...extra,
      },
    });
  };
  emit("message_start", { message });
  return { child, emit, update, message, snapshot: () => child.snapshot() };
}
const describe = (snapshot) => renderActivity(snapshot.active_tools, snapshot, theme, 120);

test("thinking and ordinary prose stay separate, and the latest channel supplies the activity label", () => {
  const h = observer();
  h.update("thinking_start");
  assert.equal(describe(h.snapshot()), "thinking…");
  h.update("thinking_delta", "Older line\n## **Inspecting the lifecycle**\n");
  assert.equal(describe(h.snapshot()), "thinking: Inspecting the lifecycle");
  h.update("text_start", "", 1);
  assert.equal(
    describe(h.snapshot()),
    "replying…",
    "an empty new text block must not revive old thinking",
  );
  h.update("text_delta", "running npm test", 1);
  const snapshot = h.snapshot();
  assert.equal(snapshot.thinking, "## **Inspecting the lifecycle**");
  assert.equal(snapshot.preview, "running npm test");
  assert.equal(snapshot.channel, "text");
  assert.equal(describe(snapshot), "replying: running npm test", "prose is not a real command");
  h.update("thinking_start", "", 2);
  assert.equal(describe(h.snapshot()), "thinking…", "new thinking must not revive old prose");
  h.update("thinking_delta", "Next thought", 2);
  assert.equal(describe(h.snapshot()), "thinking: Next thought");
  assert.equal(
    snapshot.thinking,
    "## **Inspecting the lifecycle**",
    "earlier display snapshots are detached strings",
  );
});

test("end content is authoritative, without replacing or modifying the native streaming message", () => {
  const h = observer();
  h.update("thinking_delta", "Draft thought");
  h.update("thinking_end", "Draft thought", 0, { content: "Corrected thought" });
  assert.equal(h.snapshot().thinking, "Corrected thought");
  assert.equal(h.child.inFlight(), h.message);
  assert.equal(h.message.content[0].thinking, "Draft thought");
  h.update("text_delta", "Draft prose", 1);
  h.update("text_end", "Draft prose", 1, { content: "Corrected prose" });
  assert.equal(h.snapshot().preview, "Corrected prose");
  h.emit("message_end", { message: h.message });
  assert.deepEqual(h.snapshot(), { active_tools: [], tool_uses: 0, preview: "" });
  assert.equal(h.child.inFlight(), undefined);
});

for (const type of ["thinking_start", "thinking_delta", "thinking_end"])
  test(`redacted ${type} never becomes a public preview`, () => {
    const h = observer();
    h.update("thinking_delta", "previous visible block");
    const redacted = { type: "thinking", thinking: "redacted placeholder", redacted: true };
    Object.defineProperty(redacted, "thinkingSignature", {
      get() {
        throw new Error("must not read signatures");
      },
    });
    h.message.content[1] = redacted;
    h.emit("message_update", {
      message: h.message,
      assistantMessageEvent: {
        type,
        partial: h.message,
        contentIndex: 1,
        delta: "not public",
        content: "not public",
      },
    });
    assert.equal(h.snapshot().thinking, undefined);
    assert.equal(describe(h.snapshot()), "thinking…");
  });

for (const boundary of [
  "turn_start",
  "agent_start",
  "agent_end",
  "session_before_compact",
  "agent_settled",
  "session_shutdown",
  "message_start",
  "message_end",
  "begin",
]) {
  test(`${boundary} retires both generation previews and the in-flight draft`, () => {
    const h = observer();
    h.update("thinking_delta", "private old thought");
    h.update("text_delta", "old prose", 1);
    const next = { role: "assistant" };
    if (boundary === "begin") h.child.begin();
    else h.emit(boundary, { message: next });
    assert.deepEqual(h.snapshot(), { active_tools: [], tool_uses: 0, preview: "" });
    assert.equal(describe(h.snapshot()), "thinking…");
    assert.equal(h.child.inFlight(), boundary === "message_start" ? next : undefined);
  });
}

test("non-assistant lifecycle messages cannot clear or pollute the current preview", () => {
  const h = observer();
  h.update("thinking_delta", "current thought");
  const before = h.snapshot(),
    streaming = h.child.inFlight();
  for (const type of ["message_start", "message_update", "message_end"])
    h.emit(type, {
      message: { role: "toolResult" },
      assistantMessageEvent: { type: "text_delta", delta: "tool output" },
    });
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.child.inFlight(), streaming);
});

test("actual tools win over generation, drafted tool arguments never count as execution", () => {
  const h = observer();
  h.update("thinking_delta", "current thought");
  h.emit("tool_execution_start", {
    toolCallId: "t",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(describe(h.snapshot()), "running npm test");
  h.emit("turn_start");
  assert.equal(
    describe(h.snapshot()),
    "running npm test",
    "a generation boundary must not clear actual active tools",
  );
  h.emit("tool_execution_end", { toolCallId: "t" });
  assert.equal(describe(h.snapshot()), "thinking…");
  assert.equal(h.snapshot().tool_uses, 1);
  h.update("text_delta", "I will run a command", 1);
  h.message.content[2] = {
    type: "toolCall",
    name: "write",
    id: "draft-write",
    arguments: { path: "a.ts", content: "NEVER_PREVIEW_FILE_BODY" },
  };
  for (const type of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
    h.emit("message_update", {
      message: h.message,
      assistantMessageEvent: { type, contentIndex: 2, partial: h.message },
    });
    assert.equal(describe(h.snapshot()), "preparing write…");
    assert.equal(h.snapshot().preparing_tool, "write");
  }
  assert.equal(h.snapshot().active_tools.length, 0);
  assert.equal(
    h.child.inFlight(),
    h.message,
    "argument drafting remains available to the native transcript",
  );
  h.emit("tool_execution_start", {
    toolCallId: "draft-write",
    toolName: "write",
    args: { path: "/w/a.ts", content: "NEVER_PREVIEW_FILE_BODY" },
  });
  assert.equal(
    h.snapshot().preparing_tool,
    undefined,
    "actual execution retires the preparation-only marker",
  );
  assert.equal(describe(h.snapshot()), "writing a.ts");
  h.emit("tool_execution_end", { toolCallId: "draft-write" });
  assert.equal(
    describe(h.snapshot()),
    "thinking…",
    "a completed tool cannot revive stale draft arguments",
  );
});

test("preparing unknown tools and hostile tool names remain bounded plain identifying metadata", () => {
  const h = observer();
  h.emit("message_update", {
    message: h.message,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: h.message },
  });
  assert.equal(describe(h.snapshot()), "preparing tool…");
  const name = "\x1b]0;hidden\x07write\n" + "名".repeat(500);
  h.message.content[0] = { type: "toolCall", name, id: "hostile", arguments: {} };
  h.emit("message_update", {
    message: h.message,
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, partial: h.message },
  });
  const prepared = h.snapshot().preparing_tool;
  assert(prepared.startsWith("write ") && prepared.length <= 257);
  assert.doesNotMatch(prepared, /[\p{Cc}\p{Bidi_Control}]|hidden/u);
  h.emit("tool_execution_start", { toolCallId: "hostile", toolName: name, args: {} });
  assert.equal(h.snapshot().active_tools[0].name, prepared);
});

for (const kind of ["text", "thinking"])
  test(`${kind} preview keeps its left edge even beyond the bounded buffer`, () => {
    const h = observer();
    const first = "ANCHOR " + "👩‍💻漢字 ".repeat(600);
    h.update(`${kind}_delta`, first);
    const before = h.snapshot();
    assert(describe(before).includes("ANCHOR "));
    const value = kind === "text" ? before.preview : before.thinking;
    assert(value.length <= 1025);
    assert(!value.endsWith("\ud83d…"), "bounded prefixes do not split surrogate pairs");
    h.update(`${kind}_delta`, first + " more tokens");
    assert.deepEqual(h.snapshot(), before);
    h.update(`${kind}_delta`, first + " more tokens\r\n\r\nA new line\n  ");
    assert.equal(
      describe(h.snapshot()),
      `${kind === "text" ? "replying" : "thinking"}: A new line`,
    );
  });

test("cumulative public blocks sanitize complete terminal protocols before selecting or bounding lines", () => {
  const h = observer();
  const control = `\x1b]0;hidden\n${"payload".repeat(1000)}\x07`;
  h.update("thinking_delta", control + "visible\u202eRTL\u202c");
  assert.equal(h.snapshot().thinking, "visible\\u202eRTL\\u202c");
  assert.doesNotMatch(describe(h.snapshot()), /hidden|payload|[\p{Cc}\p{Bidi_Control}]/u);
});

test("split terminal protocols are sanitized using cumulative public content", () => {
  const h = observer();
  h.update("thinking_delta", "\x1b]0;hidden");
  h.update("thinking_delta", "\x1b]0;hidden\nprotocol");
  h.update("thinking_delta", "\x1b]0;hidden\nprotocol\x07visible");
  assert.equal(h.snapshot().thinking, "visible");
  assert.equal(describe(h.snapshot()), "thinking: visible");
});

test("unfinished surrogate pairs wait for their next delta without corrupting the preview", () => {
  const h = observer();
  h.update("thinking_delta", "Hi \ud83d");
  assert.equal(h.snapshot().thinking, "Hi ");
  h.update("thinking_delta", "Hi \ud83d\ude80");
  assert.equal(h.snapshot().thinking, "Hi 🚀");
});

test("SDK deltas preserve line boundaries, empty tails and bounded left anchors", () => {
  const h = observer();
  let content = "";
  const delta = (value) => {
    content += value;
    h.update("thinking_delta", content);
  };
  delta("First line");
  delta("\r");
  delta("\n");
  assert.equal(describe(h.snapshot()), "thinking: First line");
  delta("Next");
  delta(" thought");
  assert.equal(describe(h.snapshot()), "thinking: Next thought");
  delta("x".repeat(3000));
  const before = h.snapshot();
  delta("after the cap");
  assert.deepEqual(h.snapshot(), before);
  delta("\nLast");
  assert.equal(describe(h.snapshot()), "thinking: Last");
});

test("Markdown cleanup is conservative and never applied to command or path arguments", () => {
  for (const [raw, expected] of [
    ["old\n## **New thought**", "New thought"],
    ["- **Check paths**", "Check paths"],
    ["1. Check arguments", "Check arguments"],
    ["C# a_b --flag /a_b/-file.ts", "C# a_b --flag /a_b/-file.ts"],
    ["**Unclosed", "Unclosed"],
    ["-7 is negative", "-7 is negative"],
    ["src/**/foo and test/**/bar", "src/**/foo and test/**/bar"],
    ["**/*.ts", "**/*.ts"],
    ["**/*.ts files changed", "**/*.ts files changed"],
    ["**/foo/**", "**/foo/**"],
    ["2**3 + 4**5", "2**3 + 4**5"],
    ["foo(*a, **b, **c)", "foo(*a, **b, **c)"],
    ["2024. was a year", "2024. was a year"],
  ])
    assert.equal(generationLine(raw), expected);
  assert.equal(
    renderActivity([{ name: "bash", detail: "# **keep** - --flag" }], { preview: "" }, theme, 120),
    "running # **keep** - --flag",
  );
  assert.equal(
    renderActivity([{ name: "read", detail: "a_b/**/file.ts" }], { preview: "" }, theme, 120),
    "reading a_b/**/file.ts",
  );
  assert.equal(
    generationLine("**Inspecting the lifecycle"),
    generationLine("**Inspecting the lifecycle**"),
  );
});

const row = (extra = {}) => ({
  agent_id: "a",
  run_id: "r",
  resident: true,
  name: "orca",
  profile: "editor",
  difficulty: 3,
  model: "m",
  effort: "high",
  description: "task",
  status: "running",
  finishing: false,
  turns: 1,
  max_turns: 8,
  elapsed_ms: 0,
  tool_uses: 0,
  active_tools: [],
  preview: "",
  thinking: "## **Visible thought**",
  channel: "thinking",
  question: false,
  limit_reached: false,
  pending_messages: 0,
  has_run_warnings: false,
  ...extra,
});

test("activity type labels stay dim while identifying content uses muted text", () => {
  assert.equal(
    renderActivity([{ name: "bash", detail: "npm test" }], { preview: "ignored" }, styled, 100),
    styled.fg("dim", "running ") + styled.fg("muted", "npm test"),
  );
  assert.equal(
    renderActivity([], row(), styled, 100),
    styled.fg("dim", "thinking: ") + styled.fg("muted", "Visible thought"),
  );
  assert.equal(
    renderActivity([], { preview: "running npm test", channel: "text" }, theme, 100),
    "replying: running npm test",
  );
});

test("widget keeps one activity row, uses available columns and fits narrow CJK/emoji layouts", () => {
  for (const width of [1, 8, 16, 24, 40, 80, 140, 400])
    for (const th of [theme, styled]) {
      const frame = renderWidget({
        runs: [row({ thinking: "锚定👩‍💻 " + "长段思考".repeat(100) })],
        owner: { blocked: false, resident: 1, resident_limit: 12 },
        spinnerFrame: 0,
        width,
        theme: th,
        maxLines: 6,
        shouldShowFinished: () => true,
      });
      assert.equal(frame.lines.length, 3);
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
      assert.equal(frame.hits[2], "a");
      const activity = stripTerminalSequences(frame.lines[2]);
      if (width >= 24) assert(activity.includes("thinking: 锚定"));
    }
  const long = "a".repeat(120);
  assert(
    renderRunningLines(row({ thinking: long }), 0, theme, 200)[1].endsWith(long),
    "no fixed 72-column generation cap",
  );
});

for (const [extra, expected] of [
  [{ finishing: true }, "finishing…"],
  [{ status: "cancelling" }, "cancelling…"],
  [{ runtime: { activity: "compacting" } }, "compacting context…"],
  [{ runtime: { activity: "retrying" } }, "retrying provider request…"],
  [{ drain: { elapsed_ms: 1000, waiting_for: "sdk_idle" } }, "draining 1.0s · awaiting SDK idle"],
]) {
  test(`${expected} hides only generation, while actual tools remain visible`, () => {
    const state = renderRunningLines(row(extra), 0, theme, 120)[1];
    assert(state.endsWith(expected));
    assert.doesNotMatch(state, /Visible thought|\[state\]/);
    const active = renderRunningLines(
      row({ active_tools: [{ name: "bash", detail: "npm test" }], ...extra }),
      0,
      theme,
      120,
    )[1];
    assert(active.endsWith("running npm test"));
    assert.doesNotMatch(active, /Visible thought/);
  });
}

const detailView = (extra = {}) => ({
  owner_id: "o",
  generation: "g",
  agent_id: "a",
  run_id: "r",
  name: "orca",
  status: "running",
  phase: "executing",
  effective_settings: settings,
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  isolation: "shared",
  elapsed_ms: 0,
  turns: 1,
  max_turns: 8,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});
const detailLive = {
  active_tools: [{ name: "bash", detail: "npm test" }],
  tool_uses: 1,
  thinking: "old\n## **Public summary👩‍💻**",
  preview: "old\nFinal prose",
  channel: "text",
};

test("details separate active tools, public thinking and ordinary draft without changing source values", () => {
  const input = { view: detailView(), live: detailLive },
    before = structuredClone(input);
  const text = renderDetailFields(input, theme, 120).join("\n");
  assert.match(text, /active\s+bash npm test/);
  assert.match(text, /thinking\s+Public summary👩‍💻/u);
  assert.match(text, /draft\s+Final prose/);
  assert.doesNotMatch(text, /\*\*|##|\bold\b/);
  assert.deepEqual(input, before);
});

for (const extra of [
  { status: "completed" },
  { status: "cancelling" },
  { execution_exited: true },
  { finalization_pending: true },
  { drain: { waiting_for: "sdk_idle", elapsed_ms: 1 } },
  { runtime: { activity: "retrying" } },
  { runtime: { activity: "compacting" } },
]) {
  test(`details suppress stale generation during ${JSON.stringify(extra)}`, () => {
    const text = renderDetailFields({ view: detailView(extra), live: detailLive }, theme, 120).join(
      "\n",
    );
    assert.doesNotMatch(text, /Public summary|Final prose|draft\s+/);
  });
}
