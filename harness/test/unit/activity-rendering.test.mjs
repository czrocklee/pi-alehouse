import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChildActivity } from "../../dist/runtime/activity-observer.js";
import { generationLine, renderActivity } from "../../dist/ui/format.js";
import { renderRunningLines, renderWidget } from "../../dist/ui/agent-widget.js";
import { clipPlainText, previewText } from "../../dist/ui/text.js";
import { activityPresentation } from "../../dist/ui/run-presentation.js";

const plain = { fg: (_color, value) => value, bold: value => value };
const colored = { fg: (color, value) => `\x1b[${color === "dim" ? 90 : 37}m${value}\x1b[0m`, bold: value => value };
const output = { preview: "" };
function cells(text) {
  let color = "default", from = 0;
  // eslint-disable-next-line no-control-regex -- inspect trusted theme SGR spans
  const result = [], codes = /\x1b\[([0-9;]*)m/g;
  const add = value => { for (const char of value) result.push({ char, color }); };
  for (const match of text.matchAll(codes)) {
    add(text.slice(from, match.index));
    color = match[1] === "0" ? "default" : match[1];
    from = match.index + match[0].length;
  }
  add(text.slice(from));
  return result;
}

for (const tools of [[{ name: "bash", detail: "npm test " + "X".repeat(100) }],
  [{ name: "bash", detail: "X".repeat(100) }, { name: "read", detail: "/long/".repeat(30) + "file.ts" }]]) {
  test(`every ellipsis keeps its semantic color (${tools.length} tools)`, () => {
    const painted = renderActivity(tools, output, colored, 48);
    const ellipses = cells(painted).filter(cell => cell.char === "…");
    assert(ellipses.length > 0);
    assert(ellipses.every(cell => cell.color === "37"), "content ellipses must not reset to terminal default");
    assert(visibleWidth(painted) <= 48);
  });
}

test("generation ellipses are styled after pure clipping, including the label-only narrow fallback", () => {
  for (const width of [1, 5, 12, 30, 80]) {
    const painted = renderActivity([], { preview: "word ".repeat(100), channel: "text" }, colored, width);
    const ellipses = cells(painted).filter(cell => cell.char === "…");
    assert(ellipses.length > 0);
    assert(ellipses.every(cell => cell.color !== "default"));
    assert(visibleWidth(painted) <= width);
  }
  assert.equal(clipPlainText("x".repeat(100), 12), "x".repeat(11) + "…");
  assert(!clipPlainText("x".repeat(100), 12).includes("\x1b"));
});

test("parallel tools donate unused short-call width to the long call", () => {
  const tools = [{ name: "read", detail: "a.ts" }, { name: "bash", detail: "npm test " + "X".repeat(100) }];
  const text = renderActivity(tools, output, plain, 80);
  assert(text.startsWith("reading a.ts, running npm test "));
  assert.equal(visibleWidth(text), 80, "the old equal split used only 53 of 80 columns");
  const reverse = renderActivity([...tools].reverse(), output, plain, 80);
  assert(reverse.endsWith(", reading a.ts"));
  assert.equal(visibleWidth(reverse), 80);
  assert.equal(renderActivity([{ name: "read", detail: "a.ts" }, { name: "read", detail: "b.ts" }], output, plain, 80),
    "reading a.ts, reading b.ts", "natural-sized calls are not padded into a table");
});

test("tool capture retains bounded identifying metadata, not a 72-column paint decision", () => {
  const child = new ChildActivity("/w"), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  const command = "npm test " + "X".repeat(130) + " END_MARKER";
  handlers.get("tool_execution_start")({ toolCallId: "b", toolName: "bash", args: { command } });
  const snapshot = child.snapshot();
  assert.equal(snapshot.active_tools[0].detail, command);
  assert(renderActivity(snapshot.active_tools, snapshot, plain, 300).endsWith(" END_MARKER"));
  const narrow = renderActivity(snapshot.active_tools, snapshot, plain, 40);
  assert.equal(visibleWidth(narrow), 40);
  assert(narrow.endsWith("…") && !narrow.endsWith("..."));
  handlers.get("tool_execution_start")({ toolCallId: "r", toolName: "read", args: {
    path: "/w/" + "long/".repeat(50) + "retained-file.ts", content: "NEVER_RENDER_CONTENT" } });
  const paired = child.snapshot();
  assert(renderActivity(paired.active_tools, paired, plain, 80).includes("retained-file.ts"));
  assert(!renderActivity(paired.active_tools, paired, plain, 500).includes("NEVER_RENDER_CONTENT"));
  handlers.get("tool_execution_start")({ toolCallId: "big", toolName: "bash", args: { command: "👩‍💻".repeat(4000) } });
  const bounded = child.snapshot().active_tools.at(-1).detail;
  assert(bounded.length <= 4097 && bounded.endsWith("…"));
  assert(!bounded.includes("\x1b"));
});

for (const raw of ["src/**/foo and test/**/bar", "2**3 + 4**5", "foo(*a, **b, **c)", "2024. was a year",
  "**/*.ts", "**/*.ts files changed", "**/foo/**", "**/foo/** files changed"]) {
  test(`compact Markdown never rewrites inline code: ${raw}`, () => {
    for (const channel of ["thinking", "text"]) {
      const live = { preview: raw, thinking: raw, channel };
      assert.equal(generationLine(raw), raw);
      assert.equal(renderActivity([], live, plain, 200), `${channel === "text" ? "replying" : "thinking"}: ${raw}`);
    }
  });
}

test("streamed leading Markdown has a stable left edge before and after closing emphasis", () => {
  for (const prefix of ["", "## ", "- ", "1. "]) for (const title of ["Inspecting the lifecycle", "检查生命周期", "2 tests remain"]) {
    const before = generationLine(prefix + "**" + title);
    const after = generationLine(prefix + "**" + title + "**");
    assert.equal(before, title);
    assert.equal(after, before);
  }
  assert.equal(generationLine("**kwargs"), "kwargs", "leading letter-like code remains an explicitly documented markup heuristic");
});

for (const prefix of ["\x1b]0;", "\x1b_pi:c;", "\x1bP", "\x9d0;"]) {
  test(`incomplete multiline protocol cannot expose a false last line (${JSON.stringify(prefix)})`, () => {
    const raw = "visible before\n" + prefix + "hidden\nsecret-payload";
    assert.equal(previewText(raw), "visible before\n");
    assert.equal(generationLine(raw), "visible before");
    assert.equal(previewText(raw + "\x1b\\visible after"), "visible before\nvisible after");
  });
}

for (const open of ["\x1b_", "\x1bP", "\x1bX", "\x1b^", "\x9f", "\x90", "\x98", "\x9e"]) {
  test(`BEL inside an unfinished string protocol cannot reveal payload (${JSON.stringify(open)})`, () => {
    const raw = "visible\n" + open + "hidden\x07secret-payload";
    assert.equal(previewText(raw), "visible\n", "BEL closes OSC, not APC/DCS/SOS/PM");
    assert.equal(previewText(raw + "\x1b\\public"), "visible\npublic");
    const child = new ChildActivity("/w"), handlers = new Map();
    child.extension({ on: (name, handler) => handlers.set(name, handler) });
    const block = { type: "thinking", thinking: "" }, message = { role: "assistant", content: [block] };
    handlers.get("message_start")({ message });
    for (const delta of ["visible\n", ...open, "hidden\x07", "secret-payload", "\x1b", "\\public"]) {
      block.thinking += delta;
      handlers.get("message_update")({ message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message } });
      assert.doesNotMatch(child.snapshot().thinking ?? "", /hidden|secret-payload/);
    }
    assert.equal(child.snapshot().thinking, "public");
  });
}

const run = extra => ({ agent_id: "a", run_id: "r", resident: true, name: "orca", profile: "editor", difficulty: 3,
  model: "m", effort: "high", description: "task", status: "running", finishing: false, turns: 1, max_turns: 8,
  elapsed_ms: 0, tool_uses: 0, active_tools: [], preview: "", channel: "thinking", thinking: "ordinary thought",
  question: false, limit_reached: false, pending_messages: 0, has_run_warnings: false, ...extra });
const owner = { blocked: false, resident: 1, resident_limit: 12 };

for (const payload of ["literal ├─ stays literal", "literal │  stays literal", "├─ │  └─"]) {
  for (const channel of ["thinking", "text"]) test(`tree closure uses row structure, not ${channel} content: ${payload}`, () => {
    const frame = renderWidget({ runs: [run({ channel, preview: payload, thinking: payload })], owner,
      spinnerFrame: 0, width: 120, theme: colored, maxLines: 6, shouldShowFinished: () => true });
    const lines = frame.lines.map(stripTerminalSequences);
    assert(lines[1].startsWith("└─ "), "the actual final Agent owns the closing branch");
    assert(lines[2].startsWith("     ⎿  "));
    assert(lines[2].endsWith(payload), "tree glyphs in the model's content must never be rewritten");
    assert.deepEqual(frame.hits, [undefined, "a", "a"]);
  });
}

test("one shared state rule suppresses only generated content and never removes actual tools", () => {
  const tool = { name: "bash", detail: "npm test" };
  for (const state of [{ status: "cancelling" }, { finishing: true, execution_exited: true },
    { drain: { waiting_for: "sdk_idle", elapsed_ms: 2000 } }, { runtime: { activity: "retrying" } },
    { runtime: { activity: "compacting" } }]) {
    const row = run(state), before = structuredClone(row);
    assert.equal(activityPresentation(row).showGeneration, false);
    assert(!renderRunningLines(row, 0, plain, 120)[1].includes("ordinary thought"));
    assert(renderRunningLines({ ...row, active_tools: [tool] }, 0, plain, 120)[1].endsWith("running npm test"));
    assert.deepEqual(row, before);
  }
});

test("actual tool and preparing states remain distinct at every usable width", () => {
  for (const width of [0, 1, 8, 20, 40, 80]) {
    for (const tools of [[], [{ name: "read", detail: "中文/👩‍💻/a.ts" }],
      [{ name: "read", detail: "a.ts" }, { name: "bash", detail: "命令 ".repeat(100) }]]) {
      const painted = renderActivity(tools, { preview: "old prose", preparing_tool: "write" }, colored, width);
      assert(visibleWidth(painted) <= width);
      if (width >= 20 && tools.length === 0) assert(stripTerminalSequences(painted).startsWith("preparing write…"));
      if (width >= 20 && tools.length > 0) assert(!stripTerminalSequences(painted).includes("preparing"));
    }
  }
});
