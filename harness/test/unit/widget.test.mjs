import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HarnessWidget, renderWidget, renderWidgetLines } from "../../dist/ui/agent-widget.js";
import { describeActivity, describeToolArgs, formatContextTokens, formatMs, formatTurns, shortPath }
  from "../../dist/ui/format.js";
import { ChildActivity, ChildActivityRegistry } from "../../dist/runtime/activity-observer.js";
import { DetailPane, renderDetailFields, renderDetailTitle } from "../../dist/ui/agent-detail.js";
import { addToLedger } from "../../dist/core/usage-ledger.js";
import { SessionUnavailableError } from "../../dist/core/ports.js";
import { ended, fixture, task, until } from "../support/controller-fixture.mjs";

const ROW_BREAK = new RegExp("[\\t\\n\\v\\f\\r\\u0085\\u2028\\u2029]");
// Plain text keeps the assertions about layout, not about escape sequences.
const theme = { fg: (_color, text) => text, bold: (text) => text };
const owner = { blocked: false, resident: 2, resident_limit: 8 };
const base = { turns: 3, max_turns: 256, elapsed_ms: 12400, tool_uses: 2, active_tools: [],
  preview: "", question: false, limit_reached: false, pending_messages: 0, notification_drops: 0,
  has_run_warnings: false, finishing: false, name: "", profile: "editor", model: "m", description: "Task" };
const run = (id, overrides) => ({ ...base, agent_id: id, run_id: `${id}-run`, ...overrides });
const render = (runs, options = {}) => renderWidgetLines({ runs, owner, spinnerFrame: 0, width: 120, theme,
  shouldShowFinished: () => true, ...options });

test("an empty, unblocked owner renders nothing at all", () => {
  assert.deepEqual(render([]), []);
  assert.deepEqual(render([run("a", { status: "completed" })], { shouldShowFinished: () => false }), []);
});

test("the body is ordered finished, running, queued and the tree closes exactly once", () => {
  const lines = render([run("q", { status: "queued" }), run("r", { status: "running", turn_elapsed_ms: 900 }),
    run("f", { status: "completed", name: "done" })]);
  assert.match(lines[0], /^● Agents 2 resident$/);
  assert.match(lines[1], /^├─ ✓ done/);
  assert.match(lines[2], /^├─ ⠋ editor/);
  assert.match(lines[3], /^│ {4}⎿ {2}thinking…$/);
  assert.match(lines[4], /^└─ ◦ 1 queued$/);
  assert.equal(lines.filter((line) => line.startsWith("└─")).length, 1);
});

test("a trailing activity line hands its corner to the header above it", () => {
  const lines = render([run("r", { status: "running", name: "solo" })]);
  assert.deepEqual(lines.slice(1), ["└─ ⠋ solo (editor) [m] → Task · ↻3≤256 · ▸2 · 12.4s",
    "   " + "  ⎿  thinking…"]);
  assert.equal(lines.filter((line) => line.includes("│")).length, 0);
});

test("each lifecycle state keeps its own glyph, and finishing differs from cancelling", () => {
  const state = (overrides) => render([run("a", overrides)])[1];
  assert.match(state({ status: "completed" }), /^└─ ✓ /);
  assert.match(state({ status: "completed", limit_reached: true }), /^└─ ✓ .*· \(turn limit\)/);
  assert.match(state({ status: "needs_input", question: true }), /^└─ \? .*· needs answer\b/);
  assert.match(state({ status: "failed", error: "SESSION_UNAVAILABLE" }), /^└─ ✗ .*· failed: SESSION_UNAVAILABLE\b/);
  assert.match(state({ status: "cancelled" }), /^└─ ■ .*· cancelled\b/);
  assert.match(state({ status: "running", finishing: true }), /· finishing\b/);
  assert.match(state({ status: "cancelling" }), /· cancelling\b/);
});

for (const [waiting_for, label] of [["sdk_idle", "SDK idle"], ["deliveries", "tracked inputs/abort"]]) {
  test(`widget and detail show live drain waits instead of stale activity (${waiting_for})`, (t) => {
    const view = viewOf("a", "cancelling");
    view.drain = { waiting_for, elapsed_ms: 5000 };
    view.runtime = { activity: "retrying" };
    const h = mounted([view]); t.after(() => h.widget.dispose());
    h.widget.wake();
    assert(h.lines().join("\n").includes(`draining 5.0s · awaiting ${label}`));
    assert.doesNotMatch(h.lines().join("\n"), /retrying provider request|thinking…/);
    const live = { active_tools: [], tool_uses: 0, preview: "" };
    assert(renderDetailFields({ view, live }, theme, 120).join("\n").includes(`draining 5.0s · awaiting ${label}`));
    view.drain.elapsed_ms = 8000;
    assert(h.lines().join("\n").includes(`draining 8.0s · awaiting ${label}`));
    for (const width of [20, 40, 80]) assert(h.lines(width).every((line) => visibleWidth(line) <= width));
    view.execution_exited = true;
    assert.doesNotMatch(renderDetailFields({ view, live }, theme, 120).join("\n"), /draining/);
  });
}

test("owner trouble is always the last line and survives an overflowing body", () => {
  const many = Array.from({ length: 9 }, (_, index) => run(`r${index}`, { status: "running" }));
  const lines = renderWidgetLines({ runs: many, spinnerFrame: 0, width: 120, theme, shouldShowFinished: () => true,
    owner: { blocked: true, error: "PARENT_HISTORY_UNAVAILABLE", resident: 8, resident_limit: 8 } });
  // A running Agent costs two rows, so the last row can stay unused rather than half-drawn.
  assert(lines.length <= 12, String(lines.length));
  assert.match(lines[0], /^✗ Agents 8 resident \(full\)$/);
  assert.match(lines.at(-2), /^├─ \+5 more \(5 running\)$/);
  assert.match(lines.at(-1), /^└─ ✗ owner blocked: PARENT_HISTORY_UNAVAILABLE$/);
});

test("overflow keeps running work and reports what it hid", () => {
  const runs = [...Array.from({ length: 6 }, (_, i) => run(`r${i}`, { status: "running" })),
    ...Array.from({ length: 4 }, (_, i) => run(`f${i}`, { status: "completed" })), run("q", { status: "queued" })];
  const lines = render(runs);
  assert.equal(lines.length, 12);
  assert.equal(lines.filter((line) => line.includes("⠋")).length, 5);
  assert.match(lines.at(-1), /^└─ \+6 more \(1 running, 1 queued, 4 finished\)$/);
});

test("every line fits the terminal, counting CJK by the columns it occupies", () => {
  const wide = "审查 controller.ts 的生命周期合同与取消语义，并核对结果分页";
  for (const width of [30, 46, 80]) {
    const lines = render([run("a", { status: "running", name: "复核者", description: wide, preview: wide,
      active_tools: [{ name: "read", detail: "模块/家目录/极长的中文路径片段/controller.ts" }] }),
      run("b", { status: "failed", description: wide, error: wide })], { width });
    for (const line of lines) assert(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${line}`);
  }
});

test("turns always carry their budget, written as upstream writes it", () => {
  assert.equal(formatTurns(3, 256), "↻3≤256");
  assert.equal(formatTurns(128, 256), "↻128≤256");
  assert.equal(formatTurns(0, 4), "↻0≤4");
});

test("both clocks show: time on the current turn beside the counter, total time last", () => {
  const live = render([run("a", { status: "running", name: "solo", turn_elapsed_ms: 2200, elapsed_ms: 12400 })])[1];
  assert.match(live, /↻3≤256 \(2\.2s\) · ▸2 · 12\.4s$/);
  // A settled Run has no current turn, so only the total remains.
  const done = render([run("a", { status: "completed", name: "solo", turn_elapsed_ms: 2200, elapsed_ms: 12400 })])[1];
  assert.match(done, /↻3≤256 · ▸2 · 12\.4s$/);
  const queued = render([run("a", { status: "queued", name: "solo" }), run("b", { status: "running" })])[3];
  assert.match(queued, /1 queued$/);
});

test("durations stay short below a minute and readable above it", () => {
  assert.equal(formatMs(0), "0.0s");
  assert.equal(formatMs(-5), "0.0s");
  assert.equal(formatMs(12400), "12.4s");
  assert.equal(formatMs(59949), "59.9s");
  assert.equal(formatMs(61500), "1m01s");
  assert.equal(formatMs(3_723_000), "62m03s");
});

const tool = (name, detail) => ({ name, detail });

test("activity prefers live tools, then streamed prose, then thinking", () => {
  assert.equal(describeActivity([tool("read", "src/core/controller.ts")], "ignored"), "reading src/core/controller.ts");
  assert.equal(describeActivity([tool("read")], ""), "reading…");
  assert.equal(describeActivity([tool("bash", "npm test")], ""), "running npm test");
  assert.equal(describeActivity([tool("ask_parent", "which factor?")], ""), "asking you: which factor?");
  assert.equal(describeActivity([tool("read", "a.ts"), tool("edit", "b.ts")], ""), "reading a.ts, editing b.ts");
  assert.equal(describeActivity([tool("grep", '"x"'), tool("grep", '"y"'), tool("read", "a")], ""),
    "searching 2 patterns, reading…");
  assert.equal(describeActivity([tool("read", "a"), tool("read", "b"), tool("bash", "ls")], ""),
    "reading 2 files, running…");
  // The line being written now, not the one scrolling out of the window above it.
  assert.equal(describeActivity([], "\n\n  first real line \nlast real line \n  "), "last real line");
  assert.equal(visibleWidth(describeActivity([], "x".repeat(200))), 72);
  assert.equal(describeActivity([], "   \n "), "thinking…");
});

/**
 * `ChildActivity` keeps the LAST 256 characters of the stream, so the first
 * non-empty line in that window is a fragment of a line already leaving it: it
 * loses a character on every delta and the text slides left each frame.
 */
test("the streamed preview holds still at its left edge as tokens arrive", () => {
  const child = new ChildActivity("/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  handlers.get("message_start")({ message: { role: "assistant" } });
  const stream = (delta) => handlers.get("message_update")({
    message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta } });
  stream("A line long enough to fill the preview window on its own.\n".repeat(6));
  const shown = [];
  for (const word of ["Now", " writing", " the", " newest", " line"]) {
    stream(word);
    shown.push(describeActivity([], child.snapshot().preview));
  }
  // Every frame starts the same way and only grows: nothing slid left.
  for (const [i, line] of shown.entries()) {
    assert.ok(line.startsWith("Now"), `frame ${i} lost its left edge: ${JSON.stringify(line)}`);
    if (i > 0) assert.ok(line.length >= shown[i - 1].length, `frame ${i} shrank: ${JSON.stringify(line)}`);
  }
  assert.equal(shown.at(-1), "Now writing the newest line");
});

test("each tool contributes the argument that identifies its work, and nothing else", () => {
  const cwd = "/work/project", at = (name, args) => describeToolArgs(name, args, cwd, 72);
  assert.equal(at("read", { path: `${cwd}/src/core/controller.ts`, offset: 40, limit: 20 }), "src/core/controller.ts");
  assert.equal(at("edit", { path: "src/ui/agent-widget.ts", edits: [{ oldText: "secret", newText: "other" }] }), "src/ui/agent-widget.ts");
  assert.equal(at("write", { path: `${cwd}/out.txt`, content: "never rendered" }), "out.txt");
  assert.equal(at("ls", {}), ".");
  assert.equal(at("bash", { command: "npm  test\n  --silent" }), "npm test --silent");
  assert.equal(at("grep", { pattern: "createOwnerTools", path: `${cwd}/src` }), '"createOwnerTools" in src');
  assert.equal(at("grep", { pattern: "x", glob: "**/*.ts" }), '"x" in **/*.ts');
  assert.equal(at("find", { pattern: "*.mjs" }), '"*.mjs"');
  assert.equal(at("ask_parent", { question: "factor 的值是多少？" }), "factor 的值是多少？");
  assert.equal(at("notify_parent", { message: "done" }), "done");
  // Absent, malformed and unknown inputs degrade to the bare verb, never to a crash.
  for (const args of [undefined, null, "string", 7, {}, { path: 3 }]) assert.equal(at("read", args), undefined);
  assert.equal(at("mystery", { path: "a" }), undefined);
  assert.equal(describeActivity([{ name: "mystery" }], ""), "mystery…");
});

test("a path that cannot fit keeps its tail, because the file name is the information", () => {
  const cwd = "/work/project", deep = `${cwd}/module/home/pi-resources/harness/src/core/controller.ts`;
  assert.equal(shortPath(deep, cwd, 72), "module/home/pi-resources/harness/src/core/controller.ts");
  // Segments are added back from the tail while they fit; the next one up would be 32 columns.
  assert.equal(shortPath(deep, cwd, 30), "…/src/core/controller.ts");
  assert.equal(shortPath(deep, cwd, 40), "…/harness/src/core/controller.ts");
  for (const columns of [12, 24, 30, 40]) assert(visibleWidth(shortPath(deep, cwd, columns)) <= columns);
  assert.equal(shortPath("/elsewhere/a.ts", cwd, 72), "/elsewhere/a.ts");
  assert(visibleWidth(shortPath(`${cwd}/${"n".repeat(90)}.ts`, cwd, 20)) <= 20);
});

test("pending messages, drops and recorded warnings are surfaced per Agent", () => {
  const line = render([run("a", { status: "needs_input", pending_messages: 2, notification_drops: 1,
    has_run_warnings: true })])[1];
  assert.match(line, /run warning · 1 dropped · 2 msg · needs input/);
  assert.ok(line.indexOf("run warning") < line.indexOf("↻"));
  assert.doesNotMatch(render([run("a", { status: "completed" })])[1], /msg|dropped|warning/);
});

test("a recorded Run issue does not claim that resources are still unclosed", (t) => {
  const view = { ...viewOf("a", "completed"), execution_exited: true, resumable: true,
    cleanup_errors: ["SOFT_BUDGET_MESSAGE_REJECTED: INPUT_CLOSED"] };
  const h = mounted([view]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.match(h.lines()[1], /run warning/);
  assert.doesNotMatch(h.lines().join("\n"), /cleanup uncertain|blocked/);
});

test("an Agent without a nickname is named by its profile, never labelled twice", () => {
  assert.match(render([run("a", { status: "completed" })])[1], /^└─ ✓ editor \[m\] → Task/);
  assert.match(render([run("a", { status: "completed", name: "scout" })])[1],
    /^└─ ✓ scout \(editor\) \[m\] → Task/);
});

test("a fixed nickname points to the current task, which can use more than forty columns", () => {
  const description = "Review GTK direct-entry safety after Windows foundation changes";
  for (const status of ["running", "completed"]) {
    const frame = renderWidget({ runs: [run("orca-id", { name: "orca", status, description })],
      owner, spinnerFrame: 0, width: 180, theme, shouldShowFinished: () => true });
    assert(frame.lines[1].includes(`orca (editor) [m] → ${description} · ↻`), frame.lines[1]);
    assert.match(frame.lines[1], /▸2 · 12\.4s$/);
    assert.equal(frame.hits[1], "orca-id", "labels and their new separator never become click identities");
    assert(frame.lines.every((line) => visibleWidth(line) <= 180));
  }
});

test("resuming keeps who stable while changing what the widget says they are doing", (t) => {
  const first = { ...viewOf("a", "completed", "first"), name: "orca", description: "Review Windows foundations" };
  const next = { ...viewOf("a", "running", "next"), name: "orca", description: "Review GTK direct-entry safety" };
  const before = structuredClone([first, next]);
  const h = mounted([first]); t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.match(h.lines()[1], /orca .*→ Review Windows foundations/);
  h.set([next]); h.widget.wake();
  assert.match(h.lines()[1], /orca .*→ Review GTK direct-entry safety/);
  assert.doesNotMatch(h.lines()[1], /Windows/);
  assert.deepEqual([first, next], before, "rendering does not rename the Agent or rewrite old Run labels");
});

test("an absent task or insufficient room leaves no dangling task separator", () => {
  for (const description of ["", "  \n\t  "]) {
    assert.doesNotMatch(render([run("a", { status: "running", name: "orca", description })])[1], /→/);
  }
  for (const width of [1, 10, 20]) {
    const lines = render([run("a", { status: "running", name: "orca", description: "Review GTK" })], { width });
    assert.doesNotMatch(lines[1], /→/);
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("tool counts use the compact tool-call glyph, including singular and zero", () => {
  for (const status of ["running", "completed"]) {
    for (const count of [0, 1, 77]) {
      const line = render([run("a", { status, tool_uses: count })])[1];
      if (count) assert.ok(line.includes(`▸${count}`));
      else assert.ok(!line.includes("▸"));
      assert.doesNotMatch(line, /tool uses?|tokens?/);
    }
  }
});

/** The row retains actual reported cost, not an estimate from token counts. */
test("a painted row keeps cost but leaves cumulative tokens to the detail pane", (t) => {
  const spend = (input, output, cache_read, cache_write, cost) =>
    addToLedger(undefined, { input, output, cache_read, cache_write, cost }, "p/m");
  const paint = (usage) => {
    const h = mounted([{ ...viewOf("a", "running"), usage }]);
    t.after(() => h.widget.dispose());
    h.widget.wake();
    return h.lines()[1] ?? "";
  };
  const line = paint(spend(100, 20, 9000, 10, 0.0042));
  assert.match(line, /\$0\.004/, line);
  assert.doesNotMatch(line, /130|9\.1k|token/, "no cumulative token figure is painted");
  // Unknown and a reported zero are different facts, and the row says which.
  assert.ok(!paint(spend(100, 20, 0, 10, null)).includes("$"), "an unpriced Run shows no cost");
  assert.match(paint(spend(100, 20, 0, 10, 0)), /\$0\.000/, "a Run that reported zero says zero");
  assert.ok(!paint(undefined).includes("token"), "a Run that reported nothing shows no figures");
});

test("model labels preserve model ids including hyphens and namespaces", () => {
  for (const model of ["gpt-5.6-sol", "fixture-strong-model", "gpt-5.6-terra", "gpt-5.6-luna",
    "claude-opus-5", "qwen3.8:27b", "org/custom-model"]) {
    for (const status of ["running", "completed"]) {
      assert.ok(render([run("a", { model, status })])[1].includes(`[${model}]`));
    }
  }
});

test("painted Agent rows show the resolved model and current context, not cumulative usage", (t) => {
  for (const status of ["running", "completed", "failed", "needs_input"]) {
    const view = viewOf("a", status);
    view.effective_settings = { ...view.effective_settings, provider: "openai-codex", model: "gpt-5.6-sol" };
    view.runtime = { activity: "generating", context: { tokens: 231000, context_window: 272000 } };
    view.usage = addToLedger(undefined, { input: 700000, output: 0, cache_read: 9000000, cache_write: 0, cost: 0.5 }, "openai-codex/gpt-5.6-sol");
    const before = structuredClone(view);
    const h = mounted([view]);
    t.after(() => h.widget.dispose());
    h.widget.wake();
    const line = h.lines()[1];
    assert.match(line, /\[gpt-5\.6-sol\]/);
    assert.match(line, /ctx 84\.9% · \$0\.500/);
    assert.doesNotMatch(line, /openai-codex|231k|272k|700|token/);
    assert.deepEqual(view, before, "presentation never changes routing or billing metadata");
  }
});

test("context distinguishes unknown, zero and over-window snapshots and fits narrow rows", () => {
  for (const [tokens, percent] of [[null, "?"], [0, "0.0%"], [299200, "110.0%"]]) {
    const a = run("a", { status: "running", model: "gpt-5.6-sol",
      runtime: { activity: "generating", context: { tokens, context_window: 272000 } } });
    assert.ok(render([a])[1].includes(`ctx ${percent}`));
    for (const width of [12, 40, 80]) {
      for (const line of render([a], { width })) assert.ok(visibleWidth(line) <= width);
    }
  }
  assert.doesNotMatch(render([run("a", { status: "running" })])[1], /ctx/, "no snapshot is not zero context");
});

test("invalid direct-render context fixtures cannot print Infinity or NaN percentages", () => {
  const contexts = [0, -1, NaN, Infinity, 0.5].map(context_window => ({ tokens: 1000, context_window }));
  contexts.push(...[-1, NaN, Infinity, 0.5].map(tokens => ({ tokens, context_window: 272000 })));
  for (const context of contexts) {
    const line = render([run("a", { status: "running", runtime: { activity: "generating", context } })])[1];
    assert.ok(line.includes("ctx ?"), line);
    assert.doesNotMatch(line, /Infinity|NaN/);
  }
});

test("context token formatting carries rounded thousands into millions", () => {
  for (const [count, expected] of [[0, "0"], [999, "999"], [1000, "1k"], [10000, "10k"], [231000, "231k"],
    [999499, "999k"], [999500, "1.0M"], [999999, "1.0M"], [1000000, "1.0M"], [1500000, "1.5M"]]) {
    assert.equal(formatContextTokens(count), expected, String(count));
  }
});

test("a long task yields to warnings and compact metrics at 120 and 160 columns", () => {
  const row = run("a", { status: "running", name: "reviewer", model: "gpt-5.6-sol", tool_uses: 77,
    description: "Review controller lifecycle and pending input ".repeat(10), cost: 0.5,
    pending_messages: 3, has_run_warnings: true,
    runtime: { activity: "generating", context: { tokens: 231000, context_window: 272000 } } });
  for (const width of [120, 160]) {
    const lines = render([row], { width });
    for (const text of ["reviewer", "[gpt-5.6-sol]", "run warning", "3 msg", "▸77", "ctx 84.9%", "$0.500", "12.4s"]) {
      assert.ok(lines[1].includes(text), `${width}: missing ${text}: ${lines[1]}`);
    }
    assert.ok(lines[1].indexOf("run warning") < lines[1].indexOf("[gpt-5.6-sol]"));
    assert.doesNotMatch(lines[1], /token|tool use/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("long identities and diagnostics cannot hide warnings, drops or pending messages", () => {
  const styled = { fg: (_color, text) => `\x1b[33m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[0m` };
  for (const status of ["running", "failed", "needs_input", "cancelling", "completed"]) {
    for (const width of [80, 120, 160]) {
      for (const th of [theme, styled]) {
        const frame = renderWidget({
          runs: [run("a", { status, name: "审查\n".repeat(80), model: "gpt-5.6-sol",
            description: "Review the entire workspace ".repeat(50), pending_messages: 3, notification_drops: 2,
            has_run_warnings: true, error: "SDK broke: ".repeat(40) })],
          width, owner, spinnerFrame: 0, theme: th, shouldShowFinished: () => true,
        });
        for (const text of ["run warning", "2 dropped", "3 msg"]) assert.ok(frame.lines[1].includes(text), frame.lines[1]);
        if (status === "failed") assert.ok(frame.lines[1].includes("failed: SDK broke"));
        if (status === "needs_input") assert.ok(frame.lines[1].includes("needs input"));
        if (status === "cancelling") assert.ok(frame.lines[1].includes("cancelling"));
        assert.equal(frame.hits[1], "a");
        assert.equal(frame.hits.length, frame.lines.length);
        for (const line of frame.lines) {
          assert.ok(visibleWidth(line) <= width);
          assert.doesNotMatch(line, ROW_BREAK);
        }
      }
    }
  }
});

test("cost is written the way Pi's own footer writes it, and is silent when nothing was reported", () => {
  const priced = render([run("a", { status: "running", cost: 1.2345 })])[1];
  assert.match(priced, /\$1\.234/);
  const unpriced = render([run("b", { status: "running" })])[1];
  assert.ok(!unpriced.includes("$"), "an unpriced Run shows no cost rather than $0.000");
  // A measured zero is a fact, not a missing one, and reads differently.
  assert.match(render([run("c", { status: "running", cost: 0 })])[1], /\$0\.000/);
});

test("the widget reports the renderer it painted into, so the pane can choose how to mount", (t) => {
  const run = { run_id: "r", agent_id: "a", name: "scout", description: "d",
    status: "running", phase: "streaming", execution_exited: false, finalization_pending: false,
    resident: true, resumable: false, owner_blocked: false, notification_drops: 0, pending_messages: 0,
    isolation: "shared", elapsed_ms: 1, turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [],
    effective_settings: { provider: "p", model: "m", thinking: "off", parent_thinking: "off",
      thinking_resolution: "identity", profile: "editor",
      difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64),
      cwd: "/tmp", tools: [], definition_digest: "0".repeat(64), context_mode: "none" } };
  const widget = new HarnessWidget({ list: () => [run],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  t.after(() => widget.dispose());
  // Nothing painted yet: the caller must read this as "assume the safe renderer".
  assert.equal(widget.tuiMode(), undefined);
  let factory;
  widget.setUi({ setWidget: (_key, content) => { factory = content; } });
  widget.update();
  assert.equal(typeof factory, "function");
  assert.equal(widget.tuiMode(), undefined, "still unpainted until the factory runs");
  factory({ terminal: { columns: 80 }, mode: "fullscreen", requestRender() {} }, theme);
  assert.equal(widget.tuiMode(), "fullscreen");
  // A host that predates the field must not be mistaken for the alternate screen.
  widget.setUi({ setWidget: (_key, content) => { factory = content; } });
  widget.update();
  factory({ terminal: { columns: 80 }, requestRender() {} }, theme);
  assert.equal(widget.tuiMode(), undefined);
});

/** A RunView as the controller projects one, with only the fields the widget reads. */
const viewOf = (agent_id, status, run_id = `${agent_id}-1`) => ({
  run_id, agent_id, name: "", description: "Task", status,
  phase: status === "running" ? "streaming" : "settled", execution_exited: false, finalization_pending: false,
  resident: true, resumable: false, owner_blocked: false, notification_drops: 0, pending_messages: 0, isolation: "shared",
  elapsed_ms: 1000, turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [],
  effective_settings: { provider: "p", model: "m", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "editor", difficulty: 3, strength: "standard",
    preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64), cwd: "/w",
    tools: [], definition_digest: "0".repeat(64), context_mode: "none" },
});
/** A widget wired to a host that mounts its component, as the TUI does. */
const mounted = (initial = []) => {
  let views = initial, renders = 0, content;
  const tui = { terminal: { columns: 120 }, mode: "regular", requestRender: () => { renders++; } };
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget({ list: (options) => views.filter((view) => options.include_released !== false || view.resident),
    stats: () => ({ resident: views.filter((view) => view.resident).length, cleanup_uncertain: false }) }, 8,
    activities.observations, (ids) => activities.retain(ids));
  widget.setUi({ setWidget: (_key, factory) => { content = factory ? factory(tui, theme) : undefined; } });
  return { widget, activities, set: (next) => { views = next; }, renders: () => renders,
    showing: () => !!content, lines: (width = 120) => content ? content.render(width) : [] };
};

test("the paint loop starts when a Run is there, not when delegation is only about to happen", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = mounted();
  t.after(() => h.widget.dispose());
  // A delegation tool_call fires BEFORE the tool runs, so this wake sees no Run.
  h.widget.wake();
  assert.equal(h.showing(), false);
  t.mock.timers.tick(1000);
  assert.equal(h.renders(), 0, "an empty wake leaves no loop running behind it");
  // The worker is admitted inside the tool, and the wake that follows the tool
  // paints it. No parent turn is involved: an interrupt here, or a slow sibling
  // tool, must not be what decides whether a running worker is visible.
  h.set([viewOf("a", "running")]);
  h.widget.wake();
  assert.match(h.lines()[1], /^└─ \S editor \[m\] → Task/, "the Run is on screen as soon as it exists");
  t.mock.timers.tick(240);
  assert.ok(h.renders() >= 3, `the spinner keeps animating (${h.renders()} frames)`);
  h.set([viewOf("a", "completed")]);
  t.mock.timers.tick(80);
  const settled = h.renders();
  t.mock.timers.tick(800);
  assert.equal(h.renders(), settled, "a finished Run animates nothing");
  assert.match(h.lines()[1], /✓ editor/, "but its result stays on screen for its linger");
});

test("a reused Agent lingers again for every Run, not only its first", (t) => {
  const h = mounted([viewOf("a", "completed", "a-1")]);
  t.after(() => h.widget.dispose());
  h.widget.update();
  assert.match(h.lines()[1], /✓ editor/);
  h.widget.onTurnStart();
  assert.equal(h.showing(), false, "one turn is the whole normal linger");
  // resume_agent: a new Run on the Agent that already spent a linger.
  h.set([viewOf("a", "running", "a-2")]);
  h.widget.update();
  h.set([viewOf("a", "completed", "a-2")]);
  h.widget.update();
  assert.match(h.lines()[1] ?? "", /✓ editor/, "the second result gets its own linger");
});

test("a Run that starts and finishes between paints gets its own linger", (t) => {
  const h = mounted([viewOf("a", "failed", "a-1")]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let i = 0; i < 3; i++) h.widget.onTurnStart();
  assert.equal(h.showing(), false);
  h.set([viewOf("a", "failed", "a-2")]);
  h.widget.wake();
  assert.equal(h.showing(), true);
});

test("released failures expire in both UI entry points without resurrecting", (t) => {
  const failed = { ...viewOf("a", "failed"), resident: false, unavailable_reason: "sdk_error",
    outcome: { status: "failed", error: "SDK broke" } };
  const h = mounted([failed, { ...viewOf("b", "completed"), resident: false }]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.equal(h.widget.agents().length, 1, "released successes do not reappear");
  assert.match(h.lines().join("\n"), /SDK broke/);
  for (let i = 0; i < 2; i++) {
    h.widget.onTurnStart();
    assert.equal(h.widget.agents().length, 1);
  }
  h.widget.onTurnStart();
  assert.equal(h.showing(), false);
  for (let i = 0; i < 5; i++) {
    h.widget.wake();
    h.widget.onTurnStart();
    assert.deepEqual(h.widget.agents(), []);
    assert.equal(h.showing(), false);
  }
});

test("a real Controller's automatic release frees capacity but retains clickable failure diagnostics", async (t) => {
  const { controller, ports } = await fixture(t);
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget(controller, 8, activities.observations, (ids) => activities.retain(ids));
  t.after(() => { widget.dispose(); activities.clear(); });
  let content, selected;
  widget.setUi({ setWidget: (_key, factory) => {
    content = factory?.({ terminal: { columns: 120 }, mode: "fullscreen", requestRender() {} }, theme);
  } });
  widget.onOpen((id) => { selected = id; });
  const run = await controller.submit("failure-ui", task("Check diagnostics"));
  await until(() => ports[0]?.streaming);
  const child = activities.track(run.agent_id, "/tmp");
  const entries = [{ type: "custom", customType: "test-transcript" }], handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  handlers.get("session_start")({}, { sessionManager: { getEntries: () => entries } });
  widget.wake();
  const pane = new DetailPane({
    tui: { terminal: { columns: 120, rows: 60 }, requestRender() {} }, theme,
    initial: run.agent_id, done() {},
    snapshot: () => widget.agents().map((agent) => ({ agent_id: agent.agent_id, input: { view: agent.view, live: agent.live } })),
    transcript: () => undefined,
  });
  t.after(() => pane.dispose());
  assert.match(pane.render(120)[0], /running/);
  ports[0].calls[0].done.reject(new SessionUnavailableError("sdk_error", new Error("SDK broke")));
  await ended(controller, run);
  widget.update();
  assert.equal(ports[0].disposed, 1);
  assert.equal(controller.stats().resident, 0);
  assert.deepEqual(controller.list({ include_released: false }), []);
  assert.equal(controller.stats().parent_error, undefined);
  const lines = content.render(120);
  assert.match(lines.join("\n"), /SDK broke/);
  assert.doesNotMatch(lines.join("\n"), /owner blocked/);
  content.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
  assert.equal(selected, run.agent_id);
  const agent = widget.agents()[0];
  assert.equal(agent.view.resident, false);
  assert.equal(agent.view.resumable, false);
  assert.deepEqual(agent.entries(), entries, "the existing transcript remains inspectable");
  assert.equal(activities.observations.get(run.agent_id), child, "release retains failure diagnostics through linger");
  assert.match(renderDetailFields({ view: agent.view, live: agent.live }, theme, 120).join("\n"), /SDK broke/);
  assert.match(pane.render(120)[0], /failed/, "the already-open pane retains the retired agent");
  assert.match(pane.render(120).join("\n"), /SDK broke/);
  for (let i = 0; i < 3; i++) widget.onTurnStart();
  assert.deepEqual(widget.agents(), []);
  assert.equal(content, undefined);
  assert.match(pane.render(120).join("\n"), /No agents are available to inspect/);
  assert.equal(activities.observations.get(run.agent_id), undefined, "expired diagnostics release the transcript-bearing observer");
});

test("runtime retains idle resident observations but prunes released successes", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => { h.widget.dispose(); h.activities.clear(); });
  const child = h.activities.track("a", "/w");
  h.widget.wake();
  for (let i = 0; i < 4; i++) h.widget.onTurnStart();
  assert.equal(h.showing(), false);
  assert.equal(h.activities.observations.get("a"), child, "a hidden idle Agent can still resume with its observer");
  h.set([{ ...viewOf("a", "completed"), resident: false }]);
  h.widget.wake();
  assert.equal(h.activities.observations.get("a"), undefined, "successful release needs no diagnostic linger");
});

test("disposing presentation alone does not dispose runtime observations", (t) => {
  const h = mounted([viewOf("a", "running")]);
  t.after(() => { h.widget.dispose(); h.activities.clear(); });
  const child = h.activities.track("a", "/w");
  h.widget.wake();
  h.widget.dispose();
  assert.equal(h.activities.observations.get("a"), child);
  h.activities.clear();
  assert.equal(h.activities.observations.get("a"), undefined);
});

test("painting reads a child's activity and never resets it", (t) => {
  const h = mounted([viewOf("a", "running")]);
  t.after(() => h.widget.dispose());
  const child = h.activities.track("a", "/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event, payload) => handlers.get(event)(payload);
  emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
  emit("tool_execution_start", { toolCallId: "t2", toolName: "read", args: { path: "/w/src/a.ts" } });
  emit("tool_execution_end", { toolCallId: "t2" });
  // Through the widget, not around it: project()/rows() is the tempting place to
  // reset a Run's activity, so the pin has to be a real frame.
  h.widget.wake();
  const painted = h.lines();
  assert.match(painted.join("\n"), /⎿ {2}running npm test/, painted.join("\n"));
  assert.match(painted[1], /▸1/, painted[1]);
  // A tool already running at that first paint still counts when it ends, and a
  // second frame reports it -- the paint read the activity, it did not clear it.
  emit("tool_execution_end", { toolCallId: "t1" });
  h.widget.wake();
  assert.match(h.lines()[1], /▸2/, h.lines()[1]);
  // Repainting is a read: the same numbers however many times they are asked for.
  assert.match(h.lines()[1], /▸2/);
  assert.equal(child.snapshot().tool_uses, 2);
});

/**
 * Runs share one session, so a resumed Agent has to start from zero -- but at
 * the submission, not at the next paint. A tool that starts before the first
 * paint of the new Run would otherwise be cleared out from under itself, and
 * its `tool_execution_end` would find nothing to delete and never count it.
 */
test("a resumed Agent starts its Run clean without losing what that Run already did", (t) => {
  const h = mounted();
  t.after(() => h.widget.dispose());
  const child = h.activities.track("a", "/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event, payload) => handlers.get(event)(payload);
  emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/w/a.ts" } });
  emit("tool_execution_end", { toolCallId: "t1" });
  assert.equal(child.snapshot().tool_uses, 1);

  child.begin();
  assert.deepEqual(child.snapshot(), { active_tools: [], tool_uses: 0, preview: "" }, "the previous Run is not this Run");
  // The resumed worker reports before anything paints, as it always does.
  emit("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: { command: "make" } });
  assert.deepEqual(child.snapshot().active_tools, [{ name: "bash", detail: "make" }],
    "work started before the first paint is still on screen");
  emit("tool_execution_end", { toolCallId: "t2" });
  assert.equal(child.snapshot().tool_uses, 1, "and still counts when it finishes");
});

/**
 * A row is one array element and one terminal line. Model-supplied names and
 * descriptions, tool arguments and `String(cause)` error text all reach these
 * rows, and any of them can carry a break: then the array and the screen
 * disagree about how many rows there are, and every hit index below the
 * offender names the wrong Agent.
 */
/**
 * `needs_input` is terminal but not finished: the Run is blocked on an answer
 * only the parent can give. Ageing it out of the widget hides the one row whose
 * absence stalls everything, and the parent has no other standing readout.
 */
test("an Agent waiting on an answer never ages out, however long the parent takes", (t) => {
  const h = mounted([viewOf("a", "needs_input")]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 12; turn++) h.widget.onTurnStart();
  assert.equal(h.showing(), true, "the blocked Agent is still on screen");
  assert.match(h.lines()[1] ?? "", /editor/, h.lines().join("\n"));
  // A finished one still goes, so this is not simply "nothing ever leaves".
  h.set([viewOf("b", "completed")]);
  h.widget.onTurnStart();
  h.widget.onTurnStart();
  assert.equal(h.showing(), false);
});

/**
 * A full roster refuses the next delegation. A widget that vanished because
 * every Agent went idle leaves no visible reason for that refusal.
 */
test("a saturated roster stays on screen even when every Agent is idle", (t) => {
  const idle = Array.from({ length: 8 }, (_, i) => viewOf(`a${i}`, "completed"));
  const h = mounted(idle);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 5; turn++) h.widget.onTurnStart();
  assert.equal(h.showing(), true, "capacity is still reported after the rows aged out");
  assert.match(h.lines()[0], /8 resident \(full\)/);
  // One slot free and all idle: nothing to say, so nothing on screen.
  h.set(idle.slice(0, 7));
  h.widget.onTurnStart();
  assert.equal(h.showing(), false);
});

test("nothing that reaches a row can end it early", () => {
  const frame = renderWidget({
    runs: [run("a", { status: "running", name: "rev\nbot", description: "Review the code\r\nand tests",
      active_tools: [{ name: "bash", detail: "make\ttest" }] })],
    owner: { blocked: true, error: "boom\n  at foo()\n  at bar()", resident: 1, resident_limit: 8 },
    spinnerFrame: 0, width: 120, theme, shouldShowFinished: () => true,
  });
  for (const line of frame.lines) {
    assert.doesNotMatch(line, ROW_BREAK, `row would break: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= 120);
  }
  assert.equal(frame.lines.length, frame.hits.length, "one hit per painted row");
  // Folded to spaces, not dropped: the text is still readable and still attributed.
  assert.match(frame.lines[1], /rev bot/);
  assert.match(frame.lines[1], /Review the code and tests/);
  assert.match(frame.lines[2], /running make test/);
  assert.match(frame.lines[3], /owner blocked: boom +at foo\(\) +at bar\(\)/);
  assert.equal(frame.hits[1], "a");
});

test("a detail title stays one row however it is labelled", () => {
  const view = { run_id: "r-1", agent_id: "a-1", name: "rev\nbot",
    description: "Check\nthe\ttests", status: "running", turns: 1, max_turns: 8, elapsed_ms: 10,
    effective_settings: { provider: "p", model: "m", thinking: "high", parent_thinking: "high",
      thinking_resolution: "identity", profile: "worker\nreadonly",
      difficulty: 5, strength: "strong", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64),
      cwd: "/w", tools: [], context_mode: "none" },
    owner_blocked: false, notification_drops: 0, pending_messages: 0, cleanup_errors: [], discarded_inputs: [],
    execution_exited: false, finalization_pending: false, resumable: true, isolation: "shared", phase: "executing" };
  const live = { active_tools: [], tool_uses: 0, preview: "" };
  const title = renderDetailTitle({ view, live }, 0, theme, 120);
  assert.doesNotMatch(title, /[\t\n\v\f\r]/, `title would break the frame: ${JSON.stringify(title)}`);
  assert.ok(visibleWidth(title) <= 120);
});

function refreshFixture(t, status = "running") {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let views = [viewOf("a", status)], component, failure, removalFails = false;
  let mounts = 0, removals = 0, renders = 0, reads = 0, opens = 0;
  const widget = new HarnessWidget({ list: () => { reads++; return views; },
    stats: () => ({ resident: views.length, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120 }, mode: "fullscreen", requestRender() { renders++; } };
  widget.onOpen(() => { opens++; });
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) {
      removals++;
      if (removalFails) throw new Error("WIDGET_CLEAR_FAILED");
      component = undefined; return;
    }
    mounts++;
    const fault = failure; failure = undefined;
    if (fault === "retained") throw new Error("WIDGET_REFRESH_FAILED");
    component = undefined;
    if (fault === "removed") throw new Error("WIDGET_REFRESH_FAILED");
    component = factory(tui, theme);
    if (fault === "installed" || fault === "invalidated") {
      component.render(120);
      if (fault === "invalidated") component.invalidate();
      throw new Error("WIDGET_REFRESH_FAILED");
    }
  } });
  t.after(() => { removalFails = false; widget.dispose(); });
  return { widget, component: () => component, fail: (phase) => { failure = phase; },
    failRemoval: () => { removalFails = true; }, set: (next) => { views = next; },
    counts: () => ({ mounts, removals, renders, reads, opens }) };
}

for (const status of ["running", "completed"]) for (const phase of ["retained", "removed", "installed"]) {
  test(`failed theme refresh recovers on a later wake (status=${status}, host=${phase})`, (t) => {
    const h = refreshFixture(t, status);
    h.widget.wake(); const old = h.component(); old.render(120);
    h.fail(phase); old.invalidate(); old.invalidate();
    assert.doesNotThrow(() => t.mock.timers.tick(1), "the scheduled refresh must contain host errors");
    assert.equal(h.counts().mounts, 2, "repeated invalidation coalesces into one attempt");
    assert.equal(h.widget.tuiMode(), "fullscreen", "losing a component does not lose the renderer mode");
    const held = h.counts();
    t.mock.timers.tick(1000);
    assert.deepEqual(h.counts(), held, "failure stops animation instead of spinning on a broken host");
    h.component()?.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
    assert.equal(h.counts().opens, 0, "failed replacement drops stale hit targets");
    assert.doesNotThrow(() => h.widget.wake());
    assert.equal(h.counts().mounts, 3, "a normal wake retries registration, not an absent TUI render");
    assert.notEqual(h.component(), old);
    assert.match(h.component().render(120).join("\n"), /editor/);
    h.component().handleMouse({ type: "click", button: "left", x: 0, y: 1 });
    assert.equal(h.counts().opens, 1, "the recovered component is interactive");
    h.widget.wake(); assert.equal(h.counts().mounts, 3, "successful registration clears the refresh intent");
    const rendered = h.counts().renders;
    t.mock.timers.tick(160);
    assert.equal(h.counts().renders - rendered, status === "running" ? 2 : 0,
      "only a running widget resumes animation, without duplicate intervals");
  });
}

for (const phase of ["retained", "removed", "installed"]) {
  test(`idle after failed theme refresh still clears the host (host=${phase})`, (t) => {
    const h = refreshFixture(t);
    h.widget.wake(); h.fail(phase); h.component().invalidate();
    assert.doesNotThrow(() => t.mock.timers.tick(1));
    h.set([]); h.widget.wake();
    assert.equal(h.counts().removals, 1); assert.equal(h.component(), undefined);
    const cleared = h.counts(); t.mock.timers.tick(1000);
    assert.deepEqual(h.counts(), cleared);
    h.set([viewOf("b", "running")]); h.widget.wake();
    assert.equal(h.counts().mounts, 3, "fresh activity can mount after idle cleanup");
    assert(h.component());
  });
  for (const removalFails of [false, true]) {
    test(`dispose after failed theme refresh detaches everything (host=${phase}, clearThrows=${removalFails})`, (t) => {
      const h = refreshFixture(t);
      h.widget.wake(); const old = h.component(); old.render(120);
      h.fail(phase); old.invalidate();
      assert.doesNotThrow(() => t.mock.timers.tick(1));
      old.invalidate(); // Even a host retaining the old component cannot outlive disposal.
      if (removalFails) {
        h.failRemoval(); assert.throws(() => h.widget.dispose(), /WIDGET_CLEAR_FAILED/);
      } else assert.doesNotThrow(() => h.widget.dispose());
      assert.equal(h.counts().removals, 1); assert.equal(h.widget.tuiMode(), undefined);
      const disposed = h.counts();
      old.invalidate(); old.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
      h.widget.wake(); h.widget.dispose(); t.mock.timers.tick(1000);
      assert.deepEqual(h.counts(), disposed, "no timer, mount, click or repeated clear survives disposal");
    });
  }
}

test("failed theme refresh cancels invalidation scheduled during partial installation", (t) => {
  const h = refreshFixture(t);
  h.widget.wake(); h.fail("invalidated"); h.component().invalidate();
  assert.doesNotThrow(() => t.mock.timers.tick(1));
  assert.equal(h.counts().mounts, 2);
  const failed = h.counts(); t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), failed, "a failed host cannot leave a self-retrying repaint timer");
  h.widget.wake(); assert.equal(h.counts().mounts, 3);
});

test("scheduled idle removal failure is contained without leaving a paint loop", (t) => {
  const h = refreshFixture(t);
  h.widget.wake(); h.component().invalidate(); h.set([]); h.failRemoval();
  assert.doesNotThrow(() => t.mock.timers.tick(1));
  assert.equal(h.counts().removals, 1);
  const failed = h.counts(); t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), failed);
});

test("a partially installed initial widget is still removed on disposal", (t) => {
  const h = refreshFixture(t);
  h.fail("installed"); assert.throws(() => h.widget.wake(), /WIDGET_REFRESH_FAILED/);
  assert(h.component());
  h.widget.dispose();
  assert.equal(h.counts().removals, 1); assert.equal(h.component(), undefined);
  const disposed = h.counts(); t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), disposed);
});

test("a queued theme refresh still removes a widget that became idle before repaint", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let views = [viewOf("a", "running")], component, removals = 0;
  const widget = new HarnessWidget({ list: () => views,
    stats: () => ({ resident: views.length, cleanup_uncertain: false }) }, 8);
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) removals++;
    component = factory?.({ terminal: { columns: 120 }, requestRender() {} }, theme);
  } });
  t.after(() => widget.dispose());
  widget.wake(); component.invalidate();
  views = [];
  t.mock.timers.tick(1);
  assert.equal(component, undefined); assert.equal(removals, 1);
});

for (const invalidated of [false, true]) test(`throwing widget removal still releases timers and bindings (invalidated=${invalidated})`, (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const timers = new Set();
  for (const [start, stop] of [["setInterval", "clearInterval"], ["setTimeout", "clearTimeout"]]) {
    const schedule = globalThis[start], cancel = globalThis[stop];
    t.mock.method(globalThis, start, (...args) => { const timer = schedule(...args); timers.add(timer); return timer; });
    t.mock.method(globalThis, stop, (timer) => { timers.delete(timer); cancel(timer); });
  }
  let component, paints = 0, removals = 0, opens = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "running")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  widget.onOpen(() => { opens++; });
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) { removals++; throw new Error("WIDGET_CLEAR_FAILED"); }
    paints++;
    component = factory({ terminal: { columns: 120 }, mode: "fullscreen", requestRender() { paints++; } }, theme);
  } });
  t.after(() => widget.dispose());
  widget.wake(); component.render(120);
  assert.equal(timers.size, 1);
  if (invalidated) { component.invalidate(); assert.equal(timers.size, 2); }
  assert.throws(() => widget.dispose(), /WIDGET_CLEAR_FAILED/);
  assert.equal(removals, 1);
  assert.equal(timers.size, 0, "both animation and deferred repaint are cancelled before the setter");
  assert.equal(widget.tuiMode(), undefined);
  const painted = paints;
  widget.wake(); component.invalidate();
  component.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
  widget.dispose(); t.mock.timers.tick(1000);
  assert.equal(removals, 1); assert.equal(timers.size, 0);
  assert.equal(paints, painted); assert.equal(opens, 0, "a host retaining its broken component cannot call the detached panel");
});
