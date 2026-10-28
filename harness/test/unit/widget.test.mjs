import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
  preview: "", question: false, limit_reached: false, pending_messages: 0,
  has_run_warnings: false, finishing: false, name: "", profile: "editor", difficulty: 3, model: "m",
  effort: "high", description: "Task" };
const run = (id, overrides) => ({ ...base, agent_id: id, run_id: `${id}-run`, ...overrides });
const render = (runs, options = {}) => renderWidgetLines({ runs, owner, spinnerFrame: 0, width: 120, theme,
  maxLines: 12, shouldShowFinished: () => true, ...options });

test("an empty, unblocked owner renders nothing at all", () => {
  const empty = { ...owner, resident: 0 };
  assert.deepEqual(render([], { owner: empty }), []);
  assert.deepEqual(render([run("a", { status: "completed" })],
    { owner: empty, shouldShowFinished: () => false }), []);
});

test("the body is ordered finished, running, queued and the tree closes exactly once", () => {
  const lines = render([run("q", { status: "queued" }), run("r", { status: "running", turn_elapsed_ms: 900 }),
    run("f", { status: "completed", name: "done" })]);
  assert.match(lines[0], /^● Agents 2 resident ▸$/);
  assert.match(lines[1], /^├─ ✓ done/);
  assert.match(lines[2], /^├─ ⠋ editor/);
  assert.match(lines[3], /^│ {4}⎿ {2}thinking…$/);
  assert.match(lines[4], /^└─ ◦ 1 queued$/);
  assert.equal(lines.filter((line) => line.startsWith("└─")).length, 1);
});

test("a trailing activity line hands its corner to the header above it", () => {
  const lines = render([run("r", { status: "running", name: "solo" })]);
  assert.deepEqual(lines.slice(1), ["└─ ⠋ solo (editor/d3) [m/high] → Task · ↻3≤256 · ▸2 · 12.4s",
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
    assert(h.lines().join("\n").includes(`draining 5.0s · awaiting ${label}`), "render uses the detached tick snapshot");
    h.widget.wake();
    assert(h.lines().join("\n").includes(`draining 8.0s · awaiting ${label}`));
    for (const width of [20, 40, 80]) assert(h.lines(width).every((line) => visibleWidth(line) <= width));
    view.execution_exited = true;
    assert.doesNotMatch(renderDetailFields({ view, live }, theme, 120).join("\n"), /draining/);
  });
}

test("owner trouble is directly after the heading and survives an overflowing body", () => {
  const many = Array.from({ length: 9 }, (_, index) => run(`r${index}`, { status: "running" }));
  const lines = renderWidgetLines({ runs: many, spinnerFrame: 0, width: 120, maxLines: 12, theme, shouldShowFinished: () => true,
    owner: { blocked: true, error: "PARENT_HISTORY_UNAVAILABLE", resident: 8, resident_limit: 8 } });
  // A running Agent costs two rows, so the last row can stay unused rather than half-drawn.
  assert(lines.length <= 12, String(lines.length));
  assert.match(lines[0], /^✗ Agents 8 resident \(full\) ▸$/);
  assert.match(lines[1], /^├─ ✗ owner blocked: PARENT_HISTORY_UNAVAILABLE$/);
  assert.match(lines.at(-1), /^└─ \+5 more \(5 running\)$/);
});

test("overflow keeps running work and reports what it hid", () => {
  const runs = [...Array.from({ length: 6 }, (_, i) => run(`r${i}`, { status: "running" })),
    ...Array.from({ length: 4 }, (_, i) => run(`f${i}`, { status: "completed" })), run("q", { status: "queued" })];
  const lines = render(runs);
  assert.equal(lines.length, 12);
  assert.equal(lines.filter((line) => line.includes("⠋")).length, 5);
  assert.match(lines.at(-1), /^└─ \+6 more \(1 running, 1 queued, 4 finished\)$/);
});

test("a single available row prioritizes the Owner warning over body or disclosure", () => {
  const frame = renderWidget({ runs: [run("a", { status: "running" })],
    owner: { ...owner, blocked: true, error: "BROKEN" }, maxLines: 1, expanded: true,
    width: 80, theme, spinnerFrame: 0, shouldShowFinished: () => true });
  assert.deepEqual(frame.lines, ["owner blocked: BROKEN"]);
  assert.deepEqual(frame.hits, [undefined]);
  assert.equal(frame.headingWidth, 0);
  assert.equal(frame.pagination, undefined);
});

test("resident headings remain discoverable without visible idle rows, even below capacity", () => {
  for (const resident of [1, 2, 7]) {
    const options = { owner: { ...owner, resident }, shouldShowFinished: () => false };
    assert.deepEqual(render([run("idle", { status: "completed" })], options),
      [`○ Agents ${resident} resident ▸`]);
    assert.deepEqual(render([], options), [`○ Agents ${resident} resident`], "no projected runs means no disclosure");
  }
  for (const expanded of [false, true]) {
    assert.deepEqual(render([], { owner: { ...owner, resident: 0, blocked: true, error: "BROKEN" }, expanded }),
      ["✗ Agents 0 resident", "└─ ✗ owner blocked: BROKEN"], "blocked empty headings have no disclosure");
  }
});

test("expanded rendering pages every projected Agent within the bounded budget", () => {
  const finished = Array.from({ length: 12 }, (_, i) => run(`idle-${i}`, { status: "completed", name: `idle${i}` }));
  const runs = [...finished, run("busy", { status: "running", name: "busy" })];
  const params = { runs, owner: { ...owner, resident: 13, resident_limit: 16 }, spinnerFrame: 0,
    width: 120, maxLines: 12, theme, shouldShowFinished: () => false };
  const compact = renderWidget(params);
  assert.deepEqual(compact, renderWidget({ ...params, expanded: false }));
  assert.equal(compact.lines.length, 3, "ordinary rendering still filters aged-out results");
  assert.deepEqual(compact.hits, [undefined, "busy", "busy"]);
  assert.match(compact.lines[0], / ▸$/);
  const seen = new Set();
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ ...params, expanded: true, page });
    pages = frame.pagination.pages;
    assert.equal(frame.pagination.page, page);
    assert(frame.lines.length <= 12);
    assert.match(frame.lines[0], / ▾$/);
    for (const id of frame.hits.filter(Boolean)) seen.add(id);
    assert.doesNotMatch(frame.lines.join("\n"), /\+\d+ more/);
    assert(frame.lines.every((line) => visibleWidth(line) <= 120));
  }
  assert.deepEqual([...seen], runs.map((row) => row.agent_id));
});

test("expanded queued Agents each have their own clickable identity instead of an aggregate", () => {
  const queued = Array.from({ length: 13 }, (_, i) => run(`queue-id-${i}`, { status: "queued", name: `queue${i}` }));
  const params = { runs: queued, owner, spinnerFrame: 0, width: 120, theme, shouldShowFinished: () => false };
  const compact = renderWidget(params);
  assert.deepEqual(compact.hits, [undefined, undefined]);
  assert.match(compact.lines[1], /^└─ ◦ 13 queued$/);
  const seen = [];
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ ...params, expanded: true, page });
    pages = frame.pagination.pages;
    assert(frame.lines.length <= 6, "legacy/default rendering has a safe six-line budget");
    for (const [y, id] of frame.hits.entries()) if (id) {
      const row = queued.find((run) => run.agent_id === id);
      assert.match(frame.lines[y], /^[├└]─ ◦ /);
      assert(frame.lines[y].includes(`${row.name} `));
      seen.push(id);
    }
    assert.doesNotMatch(frame.lines.join("\n"), /13 queued|\+\d+ more/);
  }
  assert.deepEqual(seen, queued.map((row) => row.agent_id));
});

test("every expanded page protects owner trouble above the bounded body", () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(`r${i}`, { status: "running" }));
  const seen = new Set();
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ runs, expanded: true, page, owner: { ...owner, blocked: true, error: "BROKEN" },
      spinnerFrame: 0, width: 80, theme, shouldShowFinished: () => false });
    pages = frame.pagination.pages;
    assert(frame.lines.length <= 6);
    assert.match(frame.lines[1], /^├─ ✗ owner blocked: BROKEN$/);
    assert(frame.lines.some((line) => /⎿ {2}thinking…/.test(line)), "activity survives when a pair fits");
    for (const id of frame.hits.filter(Boolean)) seen.add(id);
    assert(frame.lines.every((line) => visibleWidth(line) <= 80));
  }
  assert.deepEqual([...seen], runs.map((row) => row.agent_id));
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
  assert.equal(describeActivity([tool("alert_parent", "interface changed")], ""), "alerting you: interface changed");
  assert.equal(describeActivity([tool("notify_parent", "old progress")], ""), "notifying you: old progress");
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
  assert.equal(at("alert_parent", { message: "interface changed" }), "interface changed");
  assert.equal(at("notify_parent", { message: "done" }), "done", "historical name is display-only");
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

test("pending alerts and recorded warnings are surfaced per Agent", () => {
  const line = render([run("a", { status: "needs_input", pending_messages: 2,
    has_run_warnings: true })])[1];
  assert.match(line, /run warning · 2 pending · needs input/);
  assert.ok(line.indexOf("run warning") < line.indexOf("↻"));
  assert.doesNotMatch(line, /dropped|never reached/);
  assert.doesNotMatch(render([run("a", { status: "completed" })])[1], /pending|warning/);
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
  assert.match(render([run("a", { status: "completed" })])[1], /^└─ ✓ editor \(d3\) \[m\/high\] → Task/);
  assert.match(render([run("a", { status: "completed", name: "scout" })])[1],
    /^└─ ✓ scout \(editor\/d3\) \[m\/high\] → Task/);
});

test("the widget shows every profile's admitted difficulty beside its nickname in every Run state", () => {
  const profiles = ["reader", "editor", "researcher"];
  const statuses = ["running", "completed", "failed"];
  for (const profile of profiles) for (const difficulty of [1, 2, 3, 4, 5]) for (const status of statuses) {
    const line = render([run("a", { name: "orca", profile, difficulty, status })])[1];
    const identity = `orca${status === "failed" ? " · failed" : ""} (${profile}/d${difficulty})`;
    assert.ok(line.includes(identity), `${status} ${profile}/d${difficulty}: ${line}`);
  }

  const styled = { fg: (_color, text) => `\x1b[33m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[0m` };
  for (const width of [8, 16, 24, 40]) {
    const lines = render([run("a", { name: "orca", profile: "researcher", difficulty: 5,
      status: "running", description: "Review source and tests" })], { width, theme: styled });
    for (const line of lines) assert(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${line}`);
  }
});

test("the main widget projects difficulty from effective settings without changing or reusing them", (t) => {
  const view = viewOf("orca-id", "running");
  view.name = "orca";
  // Deliberately unlike the slot: the UI must show the assessment, not infer it.
  view.effective_settings = { ...view.effective_settings, profile: "researcher", difficulty: 5,
    strength: "d3", thinking: "xhigh" };
  const before = structuredClone(view);
  const h = mounted([view]); t.after(() => h.widget.dispose());
  h.widget.wake();
  const line = h.lines()[1];
  assert.match(line, /orca \(researcher\/d5\) \[m\/xhigh\]/);
  assert.equal(h.lines()[1], line, "repainting the same Run reuses its admitted difficulty");
  assert.deepEqual(view, before, "projection never rewrites effective settings or the Run");
});

test("a long nickname yields before the difficulty tag", () => {
  const line = render([run("a", { name: "n".repeat(32), status: "completed", description: "" })], { width: 40 })[1];
  assert.match(line, /\(editor\/d3\)/, line);
  assert.ok(visibleWidth(line) <= 40, line);
  assert.doesNotMatch(line, /n{32}/);
});

test("crowded 40/56-column warning rows keep a name prefix, complete tag and counted pending facts", () => {
  const styled = { fg: (color, text) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : 90}m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m` };
  for (const width of [40, 56]) for (const name of ["otter", "复核者", "复核审查者".repeat(8)]) {
    for (const status of ["completed", "failed"]) for (const th of [theme, styled]) {
      const row = run("immutable-id", { name, profile: "reader", difficulty: 3, status,
        has_run_warnings: true, pending_messages: 1, error: "SDK broke: 失败说明".repeat(20) });
      const before = structuredClone(row);
      const frame = renderWidget({ runs: [row], width, theme: th, owner, spinnerFrame: 0, shouldShowFinished: () => true });
      const text = stripTerminalSequences(frame.lines[1]);
      assert(text.includes(name === "otter" ? "ott" : "复"), text);
      assert(text.includes("(reader/d3)"), text);
      const warning = text.match(/run warning|warn|!/)?.index;
      const pending = text.match(/1 pending|1pend/)?.index;
      assert.notEqual(warning, undefined, text);
      assert.notEqual(pending, undefined, text);
      assert(warning < pending, text);
      if (status === "failed") {
        assert.match(text, /failed/);
        assert(pending < text.indexOf("failed"), text);
        assert.doesNotMatch(text, /SDK broke: 失败说明SDK broke: 失败说明/);
      }
      for (const optional of ["[m/high]", "→", "↻"]) {
        if (text.includes(optional)) assert(pending < text.indexOf(optional), text);
      }
      assert.doesNotMatch(text, /dropped|lost|never reached/);
      if (th === styled) assert(["run warning", "warn", "!"].some((signal) =>
        frame.lines[1].includes(styled.fg("error", signal))), frame.lines[1]);
      assert.equal(frame.hits[1], "immutable-id");
      assert.deepEqual(row, before);
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("crowded attention retains questions, cancellation, finishing and turn limits before optional metadata", () => {
  for (const width of [40, 56]) for (const [status, extra, state] of [
    ["needs_input", { question: true }, /needs answer|answer\?/],
    ["needs_input", { question: false }, /needs input|input\?/],
    ["cancelling", {}, /cancelling/],
    ["running", { finishing: true }, /finishing/],
    ["completed", { limit_reached: true }, /turn limit|limit/],
    ["cancelled", {}, /cancelled/],
  ]) {
    const frame = renderWidget({ runs: [run("identity", { name: "otter", profile: "reader", difficulty: 3,
      status, ...extra, has_run_warnings: true, pending_messages: 1 })], width, theme, owner,
    spinnerFrame: 0, shouldShowFinished: () => true });
    const text = stripTerminalSequences(frame.lines[1]);
    assert.match(text, /ot(?:t|…)/);
    assert.match(text, /\(reader\/d3\)/);
    assert.match(text, /run warning|warn|!/);
    assert.match(text, /1 pending|1pend/);
    assert.match(text, state);
    assert(text.search(/1 pending|1pend/) < text.search(state), text);
    assert.equal(frame.hits[1], "identity");
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
  }
});

test("wide attention wording and failed explanation stay unchanged", () => {
  for (const [status, state] of [["completed", ""], ["failed", " · failed: SDK broke"]]) {
    const line = render([run("a", { name: "otter", profile: "reader", difficulty: 3, status,
      has_run_warnings: true, pending_messages: 1, error: "SDK broke" })], { width: 180 })[1];
    assert.equal(line, `└─ ${status === "failed" ? "✗" : "✓"} otter · run warning · 1 pending${state} (reader/d3) [m/high] → Task · ↻3≤256 · ▸2 · 12.4s`);
  }
});

test("impossible-width rows keep a nickname prefix before clipped attention and omit the whole tag", () => {
  for (const width of [8, 12, 20]) {
    const lines = render([run("a", { name: "otter", profile: "researcher", difficulty: 5, status: "failed",
      has_run_warnings: true, pending_messages: 1, error: "Detailed failure" })], { width });
    assert.match(lines[1], /^└─ ✗ o/);
    assert.doesNotMatch(lines[1], /\(research/);
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("a fixed nickname points to the current task, which can use more than forty columns", () => {
  const description = "Review GTK direct-entry safety after Windows foundation changes";
  for (const status of ["running", "completed"]) {
    const frame = renderWidget({ runs: [run("orca-id", { name: "orca", status, description })],
      owner, spinnerFrame: 0, width: 180, theme, shouldShowFinished: () => true });
    assert(frame.lines[1].includes(`orca (editor/d3) [m/high] → ${description} · ↻`), frame.lines[1]);
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

test("allocation labels preserve model IDs and show creation-time effort", () => {
  for (const model of ["gpt-5.6-sol", "fixture-strong-model", "gpt-5.6-terra", "gpt-5.6-luna",
    "claude-opus-5", "qwen3.8:27b", "org/custom-model"]) {
    for (const status of ["running", "completed"]) {
      assert.ok(render([run("a", { model, effort: "xhigh", status })])[1].includes(`[${model}/xhigh]`));
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
    assert.match(line, /\[gpt-5\.6-sol\/off\]/);
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
    for (const text of ["reviewer", "[gpt-5.6-sol/high]", "run warning", "3 pending", "▸77", "ctx 84.9%", "$0.500", "12.4s"]) {
      assert.ok(lines[1].includes(text), `${width}: missing ${text}: ${lines[1]}`);
    }
    assert.ok(lines[1].indexOf("run warning") < lines[1].indexOf("[gpt-5.6-sol/high]"));
    assert.doesNotMatch(lines[1], /token|tool use/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("long identities and diagnostics cannot hide warnings or pending alerts", () => {
  const styled = { fg: (_color, text) => `\x1b[33m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[0m` };
  for (const status of ["running", "failed", "needs_input", "cancelling", "completed"]) {
    for (const width of [80, 120, 160]) {
      for (const th of [theme, styled]) {
        const frame = renderWidget({
          runs: [run("a", { status, name: "审查\n".repeat(80), model: "gpt-5.6-sol",
            description: "Review the entire workspace ".repeat(50), pending_messages: 3,
            has_run_warnings: true, error: "SDK broke: ".repeat(40) })],
          width, owner, spinnerFrame: 0, theme: th, shouldShowFinished: () => true,
        });
        for (const text of ["run warning", "3 pending"]) assert.ok(frame.lines[1].includes(text), frame.lines[1]);
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
    resident: true, resumable: false, owner_blocked: false, pending_messages: 0,
    isolation: "shared", elapsed_ms: 1, turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [],
    effective_settings: { provider: "p", model: "m", thinking: "off", parent_thinking: "off",
      thinking_resolution: "identity", profile: "editor",
      difficulty: 3, strength: "d3", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64),
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
  resident: true, resumable: false, owner_blocked: false, pending_messages: 0, isolation: "shared",
  elapsed_ms: 1000, turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [],
  effective_settings: { provider: "p", model: "m", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "editor", difficulty: 3, strength: "d3",
    preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64), cwd: "/w",
    tools: [], definition_digest: "0".repeat(64), context_mode: "none" },
});
/** A widget wired to a host that mounts its component, as the TUI does. */
const mounted = (initial = [], residentLimit = 8) => {
  let views = initial, renders = 0, reads = 0, statsReads = 0, content;
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender: () => { renders++; } };
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget({ list: (options) => {
    reads++;
    return views.filter((view) => options.include_released !== false || view.resident);
  }, stats: () => {
    statsReads++;
    return { resident: views.filter((view) => view.resident).length, cleanup_uncertain: false };
  } }, residentLimit,
    activities.observations, (ids) => activities.retain(ids));
  const ui = { setWidget: (_key, factory) => { content = factory ? factory(tui, theme) : undefined; } };
  widget.setUi(ui);
  return { widget, activities, ui, tui, component: () => content, set: (next) => { views = next; },
    renders: () => renders, reads: () => reads, statsReads: () => statsReads,
    showing: () => !!content, lines: (width = 120) => content ? content.render(width) : [] };
};

const headingClick = { type: "click", button: "left", x: 0, y: 0 };
const pageClick = (h, direction = "Next") => {
  const lines = h.lines(), y = lines.findIndex((line) => line.includes("[Next]"));
  assert(y >= 0, "page controls must be painted");
  return h.component().handleMouse({ ...headingClick, y, x: lines[y].indexOf(`[${direction}]`) });
};

test("idle editor renders reuse detached projections without Owner reads or observer pruning", (t) => {
  const view = { ...viewOf("idle", "completed"), name: "before", pending_messages: 2 };
  const h = mounted([view]), counts = [];
  t.after(() => h.widget.dispose());
  const retain = t.mock.method(h.activities, "retain");
  h.widget.onRosterUpdate((count) => { counts.push(count); });
  h.widget.wake();
  const initial = h.lines();
  const held = { list: h.reads(), stats: h.statsReads(), retain: retain.mock.callCount() };
  view.name = "after"; view.pending_messages = 9;
  for (let i = 0; i < 100; i++) assert.deepEqual(h.lines(), initial);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads(), retain: retain.mock.callCount() }, held);
  assert.deepEqual(counts, [1]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.reads(), held.list + 1);
  assert.equal(h.statsReads(), held.stats + 1);
  assert.match(h.lines()[1], /after · 9 pending/);
  assert.deepEqual(counts, [1], "inspection cannot publish roster updates or model-facing acknowledgements");
  h.set([{ ...viewOf("new", "completed"), name: "new-resident" }]);
  assert.equal(h.widget.agents()[0].agent_id, "new", "operations still read current Owner state");
  assert.match(h.lines()[1], /after/, "an operation's fresh projection does not silently replace the UI cache");
  h.widget.wake();
  assert.match(h.lines()[1], /new-resident/);
});

test("explicit expansion sees newly admitted idle residents without a lifecycle wake", (t) => {
  const h = mounted([viewOf("old", "completed")]);
  t.after(() => h.widget.dispose());
  h.widget.wake(); h.widget.onTurnStart(); h.lines();
  h.set([viewOf("old", "completed"), { ...viewOf("new", "completed"), name: "new-resident" }]);
  const held = { list: h.reads(), stats: h.statsReads() };
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  h.component().handleMouse(headingClick);
  assert.match(h.lines()[0], /2 resident ▾$/);
  assert.match(h.lines()[2], /new-resident/);
});

test("active timer ticks refresh cached activity and stop once idle", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = { ...viewOf("busy", "running"), name: "busy" }, h = mounted([view]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  const before = h.lines(), held = { list: h.reads(), stats: h.statsReads() };
  view.turns = 6;
  for (let i = 0; i < 20; i++) assert.deepEqual(h.lines(), before);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  t.mock.timers.tick(80);
  assert.equal(h.reads(), held.list + 1); assert.equal(h.statsReads(), held.stats + 1);
  assert.match(h.lines()[1], /↻6≤8/);
  h.set([viewOf("busy", "completed")]); t.mock.timers.tick(80);
  const idle = { list: h.reads(), stats: h.statsReads(), renders: h.renders() };
  t.mock.timers.tick(10000); h.lines();
  assert.deepEqual({ list: h.reads(), stats: h.statsReads(), renders: h.renders() }, idle);
});

for (const mode of ["regular", undefined]) test(`nonfullscreen widgets advertise no disclosure and reject mouse input (mode=${mode})`, (t) => {
  const h = mounted([viewOf("idle", "completed")]), opened = [];
  t.after(() => h.widget.dispose());
  h.tui.mode = mode; h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake();
  assert.doesNotMatch(h.lines().join("\n"), /[▸▾]/);
  const held = { list: h.reads(), stats: h.statsReads(), renders: h.renders() };
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads(), renders: h.renders() }, held);
  assert.deepEqual(opened, []);
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), [], "ordinary idle headings have no purpose without mouse inspection");
  const idleReads = { list: h.reads(), stats: h.statsReads() };
  for (let i = 0; i < 20; i++) assert.deepEqual(h.lines(), []);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, idleReads, "hidden cached paints stay read-only");
  assert.equal(h.widget.agents()[0].agent_id, "idle", "Alt+A's inspection projection remains available");
});

for (const mode of ["regular", undefined]) test(`nonfullscreen idle still reports full capacity (mode=${mode})`, (t) => {
  const h = mounted([viewOf("idle", "completed")], 1);
  t.after(() => h.widget.dispose());
  h.tui.mode = mode;
  h.widget.wake(); h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 1 resident (full)"], "full is a capacity fact, not a mouse-only entry");
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.equal(h.widget.agents()[0].agent_id, "idle");
});

test("suppressing mouse-only idle headings preserves attention facts", () => {
  const options = { disclosure: false, shouldShowFinished: () => false };
  assert.deepEqual(render([run("idle", { status: "completed" })], options), []);
  assert.deepEqual(render([run("idle", { status: "completed" })], {
    ...options, owner: { ...owner, blocked: true, error: "BROKEN" },
  }), ["✗ Agents 2 resident", "└─ ✗ owner blocked: BROKEN"]);
  assert.match(render([run("busy", { status: "running" })], options)[1], /⠋/);
  assert.match(render([run("asked", { status: "needs_input" })], {
    ...options, shouldShowFinished: (_id, status) => status === "needs_input",
  })[1], /needs input/);
});

for (const blocked of [false, true]) test(`tiny readable pages reach every resident and released diagnostic (blocked=${blocked})`, () => {
  const runs = [...Array.from({ length: 12 }, (_, i) => run(`id-${i}`, { status: i % 2 ? "queued" : "running", name: `复核${i}` })),
    run("linger", { status: "failed", name: "故障", error: "SDK broke" })];
  const seen = new Set(), maxLines = blocked ? 4 : 3;
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ runs, owner: { ...owner, resident: 12, resident_limit: 12, blocked, error: "BROKEN" },
      spinnerFrame: 0, width: 20, theme, maxLines, page, expanded: true, shouldShowFinished: () => false });
    pages = frame.pagination.pages;
    assert.equal(pages, 13, "one readable Agent per tiny page, never a hidden remainder");
    assert(frame.headingWidth > 0, "the shortened heading retains a visible disclosure");
    assert.equal(frame.lines.length, maxLines);
    assert(frame.lines.every((line) => visibleWidth(line) <= 20));
    if (blocked) assert.match(frame.lines[1], /owner blocked/);
    assert.equal(frame.pagination.prev === undefined, page === 0);
    assert.equal(frame.pagination.next === undefined, page === pages - 1);
    for (const id of frame.hits.filter(Boolean)) seen.add(id);
  }
  assert.deepEqual([...seen].sort(), runs.map((run) => run.agent_id).sort());
});

test("unreadable tiny controls refuse unseen actions, and extreme line budgets stay bounded", (t) => {
  const h = mounted(Array.from({ length: 12 }, (_, i) => viewOf(`id-${i}`, "completed")), 12);
  t.after(() => h.widget.dispose());
  // spacer 1 + editor 3 + footer 2 + status 1 + one queued prompt 3 + transcript 2.
  const budget = (rows) => Math.max(0, Math.min(12, Math.floor(rows / 3), rows - 12));
  h.tui.terminal.rows = 9;
  h.widget.wake(); h.widget.onTurnStart();
  assert.deepEqual(h.lines(), [], "rows 9 reserves input chrome and does not advertise nav");
  assert.equal(h.widget.agents().length, 12, "Alt+A inspection remains available without a painted control");
  const held = { list: h.reads(), stats: h.statsReads() };
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  h.tui.terminal.rows = 13;
  assert.match(h.lines()[0], /Alt\+A/);
  assert.doesNotMatch(h.lines()[0], /[▸▾]/);
  assert.equal(h.component().handleMouse(headingClick), undefined, "a one-line budget must not expand into clipped nav");
  for (const rows of [0, 1, 3, 6, 9, 12]) {
    h.tui.terminal.rows = rows;
    assert.deepEqual(h.lines(), [], `rows ${rows} stay inside the reserved chrome`);
  }
  for (const rows of [13, 15, 16, 18, 36, 300]) {
    h.tui.terminal.rows = rows;
    assert(h.lines().length <= budget(rows), `rows ${rows}`);
    assert(h.lines().length <= Math.min(12, Math.floor(rows / 3)));
  }
  h.tui.terminal.rows = 18; h.tui.terminal.columns = 12;
  assert(h.lines(12).every((line) => visibleWidth(line) <= 12), "narrow headings stay clipped to the viewport");
  assert.doesNotMatch(h.lines(12)[0], /[▸▾]/);
  assert.equal(h.component().handleMouse(headingClick), undefined);
  delete h.tui.terminal.rows;
  assert(h.lines(120).length <= 6, "legacy hosts without rows remain bounded");
  for (const rows of [Number.NaN, Number.POSITIVE_INFINITY]) {
    h.tui.terminal.rows = rows;
    assert(h.lines(120).length <= 6, "non-finite height keeps the legacy six-line budget");
  }
});

test("page geometry is paint-local across resizing, page changes and roster shrink", (t) => {
  const idle = Array.from({ length: 12 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` }));
  const h = mounted(idle, 12), opened = [];
  t.after(() => h.widget.dispose());
  h.tui.terminal.rows = 18;
  h.widget.onOpen((id) => { opened.push(id); }); h.widget.wake(); h.widget.onTurnStart(); h.lines();
  h.component().handleMouse(headingClick);
  const first = h.lines(), y = first.length - 1, x = first[y].indexOf("[Next]");
  assert.equal(first.length, 6);
  h.tui.terminal.rows = 9;
  assert.equal(h.component().handleMouse({ ...headingClick, y, x }), undefined, "resize before repaint retires old controls");
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.lines(), [], "rows 9 does not keep a nav the dock would clip");
  assert.equal(h.component().handleMouse(headingClick), undefined);
  h.tui.terminal.rows = 15;
  assert.equal(h.lines().length, 3, "unblocked pages start once the reserve leaves three widget rows");
  pageClick(h);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "old page hits are gone before repaint");
  assert.match(h.lines()[1], /idle1 /);
  h.tui.terminal.columns = 80;
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "column-only resizes are guarded too");
  assert.equal(h.lines(80).length, 3);
  h.set(idle.slice(0, 1)); h.widget.wake();
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "updates retire stale Agent targets");
  assert.equal(h.lines().length, 2);
  h.component().handleMouse({ ...headingClick, y: 1 });
  assert.deepEqual(opened, ["id-0"], "the clamped replacement page opens the painted immutable Agent ID");
});

test("twelve idle residents have a compact heading and a bounded complete static roster", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const interval = t.mock.method(globalThis, "setInterval"), timeout = t.mock.method(globalThis, "setTimeout");
  const idle = Array.from({ length: 12 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` }));
  const h = mounted(idle, 12);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 5; turn++) h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 12 resident (full) ▸"]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.lines().length, 12);
  assert.match(h.lines()[0], / ▾$/);
  assert.match(h.lines().at(-1), /1\/2 \[Next\]$/);
  assert.deepEqual(pageClick(h), { handled: true, render: true });
  assert.match(h.lines()[1], /✓ idle10 /);
  assert.match(h.lines()[2], /✓ idle11 /);
  assert.match(h.lines().at(-1), /2\/2 \[Next\]$/);
  assert.equal(pageClick(h), undefined, "Next on the last page is inert");
  assert.deepEqual(pageClick(h, "Prev"), { handled: true, render: true });
  h.lines();
  const held = { renders: h.renders(), reads: h.reads() };
  t.mock.timers.tick(10000);
  assert.deepEqual({ renders: h.renders(), reads: h.reads() }, held, "expanded idle rows never start a paint loop");
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0, "a disclosure click schedules no idle work");
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.deepEqual(h.lines(), ["○ Agents 12 resident (full) ▸"]);
});

test("nonfull idle rosters expand and every painted Agent row opens its immutable id", (t) => {
  const idle = Array.from({ length: 7 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` }));
  const h = mounted(idle, 12), opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake(); h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 7 resident ▸"]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.lines().length, 8);
  for (let y = 1; y <= idle.length; y++) {
    assert.deepEqual(h.component().handleMouse({ ...headingClick, y }), { handled: true });
  }
  assert.deepEqual(opened, idle.map((view) => view.agent_id));
});

test("expanded queued rows open each Agent and toggles invalidate old row targets until repaint", (t) => {
  const queued = Array.from({ length: 13 }, (_, i) => ({ ...viewOf(`queued-id-${i}`, "queued"), name: "same-label" }));
  const h = mounted(queued, 16), opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake();
  assert.match(h.lines()[1], /13 queued$/);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "an aggregate is not an Agent");
  h.component().handleMouse(headingClick);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "the old compact hits are discarded");
  assert.equal(h.lines().length, 12);
  for (let y = 1; y <= 10; y++) h.component().handleMouse({ ...headingClick, y });
  assert.deepEqual(pageClick(h), { handled: true, render: true });
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined, "page changes retire old row hits before repaint");
  assert.equal(h.lines().length, 5);
  for (let y = 1; y <= 3; y++) h.component().handleMouse({ ...headingClick, y });
  assert.deepEqual(opened, queued.map((view) => view.agent_id), "neither duplicate labels nor the line budget lose identity");
  h.component().handleMouse(headingClick);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 13 }), undefined,
    "a formerly expanded Agent row is not live before the compact repaint");
  assert.match(h.lines()[1], /13 queued$/);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
});

test("a blocked but empty painted heading cannot toggle", (t) => {
  let component, renders = 0;
  const widget = new HarnessWidget({ list: () => [],
    stats: () => ({ resident: 0, parent_error: "BROKEN", cleanup_uncertain: false }) }, 12);
  t.after(() => widget.dispose());
  widget.setUi({ setWidget: (_key, factory) => {
    component = factory?.({ terminal: { columns: 120 }, requestRender: () => { renders++; } }, theme);
  } });
  widget.wake();
  assert.deepEqual(component.render(120), ["✗ Agents 0 resident", "└─ ✗ owner blocked: BROKEN"]);
  assert.equal(component.handleMouse(headingClick), undefined);
  assert.equal(component.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.equal(renders, 0);
});

test("heading inspection refreshes explicitly; unseen controls and other events never project or notify", (t) => {
  const view = { ...viewOf("immutable-id", "completed"), name: "otter", pending_messages: 2 };
  const before = structuredClone(view), h = mounted([view]), counts = [], opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onRosterUpdate((count) => { counts.push(count); });
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake();
  const component = h.component(), unpainted = { reads: h.reads(), renders: h.renders() };
  assert.equal(component.handleMouse(headingClick), undefined, "registration is not a paint");
  assert.equal(component.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual({ reads: h.reads(), renders: h.renders() }, unpainted);
  const heading = h.lines()[0], width = visibleWidth(heading);
  const held = { reads: h.reads(), renders: h.renders(), counts: [...counts] };
  for (const event of [
    { x: -1 }, { x: width }, { x: 119 }, { x: NaN }, { x: Infinity }, { y: -1 }, { y: 99 },
    { button: "right" }, { button: "middle" }, { type: "release" }, { type: "move" }, { type: "scroll" },
  ]) assert.equal(component.handleMouse({ ...headingClick, ...event }), undefined);
  assert.deepEqual({ reads: h.reads(), renders: h.renders(), counts }, held);
  assert.deepEqual(component.handleMouse({ ...headingClick, x: width - 1 }), { handled: true, render: true });
  assert.equal(h.renders(), held.renders + 1, "the toggle requests one immediate render");
  assert.equal(h.reads(), held.reads + 1, "explicit inspection refreshes the projection once");
  assert.deepEqual(counts, held.counts, "a local disclosure is not a roster update");
  assert.deepEqual(opened, [], "the heading is never an Agent hit");
  assert.deepEqual(view, before, "pending model-facing facts remain untouched");
  assert.match(h.lines()[0], / ▾$/);
  assert.deepEqual(component.handleMouse({ ...headingClick, y: 1 }), { handled: true });
  assert.deepEqual(opened, ["immutable-id"]);

  const narrow = h.lines(10)[0], narrowRenders = h.renders();
  assert.equal(component.handleMouse({ ...headingClick, x: visibleWidth(narrow) }), undefined,
    "resizing replaces the old heading's wider hit box");
  assert.equal(h.renders(), narrowRenders);
  assert.equal(component.handleMouse({ ...headingClick, x: visibleWidth(narrow) - 1 }), undefined,
    "a clipped disclosure is not an unseen action; Alt+A remains the inspection fallback");
  assert.match(h.lines()[0], / ▾$/);
});

test("collapse restores automatic lingering and attention rows instead of hiding active work", (t) => {
  const h = mounted([viewOf("idle", "completed"), viewOf("busy", "running"),
    viewOf("question", "needs_input"), viewOf("queue", "queued")]);
  t.after(() => h.widget.dispose());
  h.widget.wake(); h.widget.onTurnStart();
  const compact = h.lines();
  assert.doesNotMatch(compact.join("\n"), /✓ editor/);
  assert.match(compact.join("\n"), /needs input/);
  assert.match(compact.at(-1), /1 queued$/);
  h.component().handleMouse(headingClick);
  assert(h.lines().some((line) => line.includes("✓ editor")));
  h.widget.onTurnStart(); h.widget.wake();
  assert.match(h.lines()[0], / ▾$/, "turn starts and activity wakes preserve expansion");
  h.component().handleMouse(headingClick);
  const collapsed = h.lines();
  assert.match(collapsed[0], / ▸$/);
  assert.doesNotMatch(collapsed.join("\n"), /✓ editor/);
  assert.match(collapsed.join("\n"), /needs input/);
  assert.match(collapsed.join("\n"), /thinking…/);
  assert.match(collapsed.at(-1), /1 queued$/);
  // A new result still gets the normal linger after collapsing.
  h.set([viewOf("fresh", "completed")]); h.widget.wake();
  assert.match(h.lines()[1], /✓ editor/);
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
});

test("multiple host instances from one factory never share hit or heading authority", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeout = t.mock.method(globalThis, "setTimeout");
  let factory, renders = 0;
  const opened = [], widget = new HarnessWidget({ list: () => [viewOf("id", "completed")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 12);
  t.after(() => widget.dispose());
  widget.onOpen((id) => { opened.push(id); });
  widget.setUi({ setWidget: (_key, content) => { factory = content; } }); widget.wake();
  const tui = { terminal: { columns: 120, rows: 18 }, mode: "fullscreen", requestRender() { renders++; } };
  const old = factory(tui, theme); old.render(120);
  const current = factory(tui, theme); current.render(120);
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  old.invalidate();
  assert.equal(timeout.mock.callCount(), 0, "an already retired sibling cannot schedule a replacement");
  assert.deepEqual(old.render(120), []);
  assert.equal(renders, 0); assert.deepEqual(opened, []);
  assert.deepEqual(current.handleMouse(headingClick), { handled: true, render: true });
  assert.match(current.render(120)[0], / ▾$/);
});

test("expansion is binding-local and stale components cannot toggle or open after a rebind", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => h.widget.dispose());
  const opened = [];
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake(); h.lines();
  const old = h.component(); old.handleMouse(headingClick);
  assert.match(h.lines()[0], / ▾$/);
  h.widget.setUi(h.ui); h.widget.wake();
  assert.match(h.lines()[0], / ▾$/, "the identical binding is not a reset");
  h.widget.setUi({ ...h.ui }); h.widget.wake();
  const current = h.component();
  assert.notEqual(current, old);
  assert.equal(current.handleMouse(headingClick), undefined, "a new binding must paint its own heading");
  assert.match(h.lines()[0], / ▸$/);
  const held = h.renders();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.equal(h.renders(), held);
  assert.deepEqual(opened, []);
  assert.match(h.lines()[0], / ▸$/);
});

for (const reset of ["empty", "dispose"]) test(`a ${reset} reset drops disclosure state and stale hit targets`, (t) => {
  const h = mounted([viewOf("a", "completed")]), opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake(); h.lines();
  const old = h.component(); old.handleMouse(headingClick); h.lines();
  if (reset === "empty") { h.set([]); h.widget.wake(); }
  else h.widget.dispose();
  assert.equal(h.showing(), false);
  const held = h.renders();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.equal(h.renders(), held);
  if (reset === "dispose") h.widget.setUi({ ...h.ui });
  h.set([viewOf("b", "completed")]); h.widget.wake();
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.match(h.lines()[0], / ▸$/);
  assert.equal(old.handleMouse(headingClick), undefined, "even a newly painted replacement cannot revive the old component");
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(opened, []);
});

for (const hidden of [false, true]) test(`wake notifies release to empty without a paint (hidden=${hidden})`, (t) => {
  const view = viewOf("a", "completed");
  const h = mounted([view]);
  t.after(() => h.widget.dispose());
  const counts = [], showingAtEmpty = [];
  h.widget.onRosterUpdate((count) => {
    counts.push(count);
    if (count === 0) showingAtEmpty.push(h.showing());
  });
  h.widget.wake();
  if (hidden) h.widget.onTurnStart();
  assert.equal(h.showing(), true, "idle residents retain their heading after their rows age out");
  h.set([{ ...view, resident: false }]);
  h.widget.wake();
  assert.deepEqual(counts, hidden ? [1, 1, 0] : [1, 0]);
  assert.deepEqual(showingAtEmpty, [true], "notification precedes widget removal");
  assert.equal(h.showing(), false);
  assert.equal(h.renders(), hidden ? 1 : 0, "only the retained heading's turn update requests a render");
});

test("roster notifications count released failure linger and expire it on turn start", (t) => {
  const h = mounted([viewOf("idle", "completed"), { ...viewOf("failed", "failed"), resident: false },
    { ...viewOf("released", "completed"), resident: false }]);
  t.after(() => h.widget.dispose());
  const counts = [];
  h.widget.onRosterUpdate((count) => { counts.push(count); });
  h.widget.wake();
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.deepEqual(counts, [2, 2, 2, 1], "inspectable includes diagnostics, not just residents or painted rows");
  assert.equal(h.showing(), true, "the idle resident keeps the heading mounted");
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
});

test("every explicit empty update notifies even when the count is unchanged", (t) => {
  const h = mounted();
  t.after(() => h.widget.dispose());
  const counts = [];
  h.widget.onRosterUpdate((count) => { counts.push(count); });
  h.widget.update(); h.widget.wake(); h.widget.update(true);
  assert.deepEqual(counts, [0, 0, 0], "a pane may have opened since the previous empty update");
});

test("roster notifications use one successful update projection, never render or inspection reads", (t) => {
  let reads = 0, fail = false, component;
  const counts = [], setterCounts = [];
  const widget = new HarnessWidget({ list: () => {
    reads++;
    if (fail) throw new Error("PROJECTION_FAILED");
    return [viewOf("a", "completed")];
  }, stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  t.after(() => widget.dispose());
  widget.onRosterUpdate((count) => { counts.push(count); });
  widget.update();
  assert.equal(reads, 0, "an update before UI binding remains a no-op");
  widget.setUi({ setWidget: (_key, factory) => {
    setterCounts.push([...counts]);
    component = factory?.({ terminal: { columns: 120 }, requestRender() {} }, theme);
  } });
  widget.agents();
  assert.deepEqual(counts, []);
  widget.wake();
  assert.equal(reads, 2, "the update scans the controller only once");
  assert.deepEqual(setterCounts, [[1]], "notification precedes widget registration");
  component.render(120); component.render(120);
  widget.agents(); widget.tuiMode();
  assert.deepEqual(counts, [1], "projection reads do not notify");
  fail = true;
  widget.wake();
  assert.deepEqual(counts, [1], "failed projection does not notify an invented empty roster");
  assert.equal(component, undefined);
});

test("roster subscriber failures cannot block showing or clearing and can be detached", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => h.widget.dispose());
  let calls = 0;
  h.widget.onRosterUpdate(() => { calls++; throw new Error("SUBSCRIBER_FAILED"); });
  assert.doesNotThrow(() => h.widget.wake());
  assert.equal(h.showing(), true);
  h.set([]);
  assert.doesNotThrow(() => h.widget.wake());
  assert.equal(h.showing(), false);
  assert.equal(calls, 2);
  h.widget.onRosterUpdate(undefined);
  h.widget.update();
  assert.equal(calls, 2);
});

for (const clearThrows of [false, true]) test(`dispose detaches the roster subscriber (clearThrows=${clearThrows})`, (t) => {
  const h = refreshFixture(t, "completed");
  const counts = [];
  h.widget.onRosterUpdate((count) => { counts.push(count); });
  h.widget.wake();
  if (clearThrows) {
    h.failRemoval();
    assert.throws(() => h.widget.dispose(), /WIDGET_CLEAR_FAILED/);
  } else h.widget.dispose();
  // Rebinding ensures this proves subscriber detachment, not just the no-UI guard.
  h.widget.setUi({});
  h.widget.wake();
  assert.deepEqual(counts, [1]);
});

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
  assert.match(h.lines()[1], /^└─ \S editor \(d3\) \[m\/off\] → Task/, "the Run is on screen as soon as it exists");
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
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"], "one turn is the whole normal row linger");
  // delegate to an existing Agent: a new Run on the Agent that already spent a linger.
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
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
  h.set([viewOf("a", "failed", "a-2")]);
  h.widget.wake();
  assert.match(h.lines()[1], /✗ editor/, "the second failure gets a new row linger, not just a retained heading");
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

test("expansion does not resurrect released successes or extend released failure linger", (t) => {
  const idle = viewOf("idle", "completed"), failed = { ...viewOf("failed", "failed"), resident: false,
    outcome: { status: "failed", error: "expired diagnostic" } };
  const h = mounted([idle, failed, { ...viewOf("success", "completed"), resident: false }]);
  t.after(() => h.widget.dispose());
  h.widget.wake(); h.lines(); h.component().handleMouse(headingClick);
  assert.match(h.lines().join("\n"), /expired diagnostic/);
  assert.deepEqual(h.widget.agents().map((agent) => agent.agent_id), ["idle", "failed"]);
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.match(h.lines()[0], / ▾$/);
  assert.equal(h.lines().length, 2, "the idle resident remains expanded but the released diagnostic expires");
  assert.doesNotMatch(h.lines().join("\n"), /expired diagnostic/);
  for (let cycle = 0; cycle < 3; cycle++) {
    h.component().handleMouse(headingClick);
    assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"], "ages continued advancing while expanded");
    h.widget.wake(); h.widget.onTurnStart();
    assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"], "explicit updates require freshly painted heading geometry");
    h.component().handleMouse(headingClick);
    assert.equal(h.lines().length, 2);
    assert.deepEqual(h.widget.agents().map((agent) => agent.agent_id), ["idle"]);
  }
  h.set([failed, { ...viewOf("success", "completed"), resident: false }]); h.widget.wake();
  assert.equal(h.showing(), false, "expired released history alone cannot retain a heading");
  assert.deepEqual(h.widget.agents(), []);
});

test("a released failure expiring on a later page retires its old hit without extending linger", (t) => {
  const idle = Array.from({ length: 12 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` }));
  const h = mounted([...idle, { ...viewOf("failed", "failed"), resident: false,
    outcome: { status: "failed", error: "expired diagnostic" } }], 12), opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => { opened.push(id); });
  h.widget.wake(); h.lines(); h.component().handleMouse(headingClick);
  pageClick(h);
  assert.match(h.lines()[3], /expired diagnostic/);
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.equal(h.component().handleMouse({ ...headingClick, y: 3, x: 7 }), undefined);
  assert.doesNotMatch(h.lines().join("\n"), /expired diagnostic/);
  assert.equal(h.lines().length, 4, "later pages shrink but the idle roster remains expanded");
  assert.equal(h.component().handleMouse({ ...headingClick, y: 3, x: 7 }), undefined, "the old failure row is now inert page-chrome whitespace");
  assert.deepEqual(opened, []);
  assert.deepEqual(h.widget.agents().map((agent) => agent.agent_id), idle.map((view) => view.agent_id));
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
  const runningPane = pane.render(120);
  assert.match(runningPane.at(-1), /running/);
  assert.doesNotMatch(runningPane[0], /running/);
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
  const failedPane = pane.render(120);
  assert.match(failedPane.at(-1), /failed/, "the already-open pane retains the retired agent in its lower-left status");
  assert.doesNotMatch(failedPane[0], /failed/);
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
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
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
  // A finished row still goes; its resident heading remains available to expand.
  h.set([viewOf("b", "completed")]);
  h.widget.onTurnStart();
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 1 resident ▸"]);
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
  // A nonfull idle roster remains discoverable too, without claiming saturation.
  h.set(idle.slice(0, 7));
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["○ Agents 7 resident ▸"]);
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
  assert.match(frame.lines[1], /owner blocked: boom +at foo\(\) +at bar\(\)/);
  assert.match(frame.lines[2], /rev bot/);
  assert.match(frame.lines[2], /Review the code and tests/);
  assert.match(frame.lines[3], /running make test/);
  assert.equal(frame.hits[2], "a");
});

test("a detail title stays one row however it is labelled", () => {
  const view = { run_id: "r-1", agent_id: "a-1", name: "rev\nbot",
    description: "Check\nthe\ttests", status: "running", turns: 1, max_turns: 8, elapsed_ms: 10,
    effective_settings: { provider: "p", model: "m", thinking: "high", parent_thinking: "high",
      thinking_resolution: "identity", profile: "worker\nreadonly",
      difficulty: 5, strength: "d5", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64),
      cwd: "/w", tools: [], context_mode: "none" },
    owner_blocked: false, pending_messages: 0, cleanup_errors: [], discarded_inputs: [],
    execution_exited: false, finalization_pending: false, resumable: true, isolation: "shared", phase: "executing" };
  const live = { active_tools: [], tool_uses: 0, preview: "" };
  const title = renderDetailTitle({ view, live }, 0, theme, 120);
  assert.doesNotMatch(title, /[\t\n\v\f\r]/, `title would break the frame: ${JSON.stringify(title)}`);
  assert.ok(visibleWidth(title) <= 120);
});

function refreshFixture(t, status = "running") {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let views = [viewOf("a", status)], component, failure, removalFails = false, projectionFails = false;
  let mounts = 0, removals = 0, renders = 0, reads = 0, opens = 0;
  const widget = new HarnessWidget({ list: () => {
    reads++;
    if (projectionFails) throw new Error("PROJECTION_FAILED");
    return views;
  },
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
    failProjection: (fail) => { projectionFails = fail; },
    failRemoval: () => { removalFails = true; }, set: (next) => { views = next; },
    counts: () => ({ mounts, removals, renders, reads, opens }) };
}

test("expanded idle state survives resizing and a successful theme replacement without reviving stale hits", (t) => {
  const h = refreshFixture(t, "completed");
  h.widget.wake(); const old = h.component(); old.render(120); old.handleMouse(headingClick);
  h.widget.onTurnStart();
  assert.match(old.render(40)[0], / ▾$/);
  assert.equal(old.render(40).length, 2, "expanded idle rows ignore normal linger expiry");
  old.invalidate();
  const invalidated = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.counts(), invalidated, "invalidation immediately drops heading and Agent targets");
  t.mock.timers.tick(1);
  const current = h.component();
  assert.notEqual(current, old);
  assert.equal(current.handleMouse(headingClick), undefined, "replacement has no heading bounds before paint");
  assert.match(current.render(120)[0], / ▾$/);
  const held = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.counts(), held);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), held, "a completed roster does not start animating after refresh");
  current.handleMouse(headingClick);
  assert.deepEqual(current.render(120), ["○ Agents 1 resident ▸"]);
});

test("theme replacement retires page controls immediately and preserves roster expansion", (t) => {
  const h = refreshFixture(t, "completed");
  h.set(Array.from({ length: 12 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` })));
  h.widget.wake(); const old = h.component(); old.render(120); old.handleMouse(headingClick);
  const lines = old.render(120), y = lines.length - 1, x = lines[y].indexOf("[Next]");
  assert.deepEqual(old.handleMouse({ ...headingClick, y, x }), { handled: true, render: true });
  assert.match(old.render(120)[1], /idle4 /);
  old.invalidate();
  assert.equal(old.handleMouse({ ...headingClick, y, x }), undefined);
  t.mock.timers.tick(1);
  const current = h.component();
  assert.equal(current.handleMouse({ ...headingClick, y, x }), undefined, "new geometry requires a paint");
  assert.match(current.render(120)[0], / ▾$/);
  assert.equal(old.handleMouse(headingClick), undefined, "retired page callbacks cannot collapse the replacement");
  assert.equal(old.handleMouse({ ...headingClick, y, x }), undefined);
  assert.match(current.render(120)[1], /idle0 /);
});

for (const phase of ["retained", "removed", "installed"]) {
  test(`failed refresh disables heading clicks but preserves expansion for recovery (host=${phase})`, (t) => {
    const h = refreshFixture(t, "completed");
    h.widget.wake(); const old = h.component(); old.render(120); old.handleMouse(headingClick); old.render(120);
    h.widget.onTurnStart();
    h.fail(phase); old.invalidate(); t.mock.timers.tick(1);
    const failed = h.counts();
    assert.equal(old.handleMouse(headingClick), undefined);
    assert.equal(h.component()?.handleMouse(headingClick), undefined);
    assert.deepEqual(h.counts(), failed, "failed registration cannot accept a stale heading click");
    h.widget.wake();
    const current = h.component();
    assert.equal(current.handleMouse(headingClick), undefined);
    assert.match(current.render(120)[0], / ▾$/);
    assert.equal(current.render(120).length, 2);
    current.handleMouse(headingClick);
    assert.deepEqual(current.render(120), ["○ Agents 1 resident ▸"]);
  });
}

test("failed Owner projection clears heading targets and resets expansion", (t) => {
  const h = refreshFixture(t, "completed");
  h.widget.wake(); const old = h.component(); old.render(120); old.handleMouse(headingClick); old.render(120);
  h.failProjection(true); h.widget.wake();
  assert.equal(h.component(), undefined);
  const failed = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.counts(), failed);
  h.failProjection(false); h.widget.wake();
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.match(h.component().render(120)[0], / ▸$/);
});

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

function reentryHost(t, views) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component, mounts = 0, removals = 0, renders = 0, opens = 0, mode = "apply";
  const widget = new HarnessWidget({ list: () => views,
    stats: () => ({ resident: views.length, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() { renders++; } };
  widget.onOpen(() => { opens++; });
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) { removals++; component = undefined; return; }
    mounts++;
    if (mode === "before") widget.wake();
    if (mode === "refresh") widget.update(true);
    const installed = factory(tui, theme);
    if (mode === "after") widget.wake();
    component = installed;
  } });
  t.after(() => widget.dispose());
  return { widget, tui, component: () => component, setMode: (next) => { mode = next; },
    counts: () => ({ mounts, removals, renders, opens }) };
}

test("a wake before setWidget applies its factory does not install a competing one", (t) => {
  const views = [viewOf("a", "completed")];
  const h = reentryHost(t, views);
  h.setMode("before");
  h.widget.wake();
  assert.equal(h.counts().mounts, 1, "the nested wake stays on the outer registration");
  const installed = h.component();
  assert.match(installed.render(120).join("\n"), /Agents/, "the outer factory remains current, not a blank epoch mismatch");
  assert.deepEqual(installed.handleMouse(headingClick), { handled: true, render: true });
  const paints = h.counts().renders;
  h.widget.wake();
  assert.equal(h.counts().mounts, 1, "successful outer registration is reused");
  assert.ok(h.counts().renders > paints, "a later wake only requests paint");
  h.setMode("refresh");
  h.widget.update(true);
  assert.equal(h.counts().mounts, 2, "a later forced refresh still replaces the factory");
  assert.equal(installed.handleMouse(headingClick), undefined, "the retired factory cannot act");
});

test("a pending wake refreshes the detached cache after the outer factory is installed", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const views = [{ ...viewOf("a", "completed"), name: "before" }];
  let component, mounts = 0, reads = 0, renders = 0;
  const widget = new HarnessWidget({ list: () => { reads++; return views; },
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() { renders++; } };
  t.after(() => widget.dispose());
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) { component = undefined; return; }
    mounts++;
    views[0] = { ...views[0], name: "during", description: "fresh task" };
    widget.wake(); widget.update(true);
    component = factory(tui, theme);
  } });
  widget.wake();
  assert.equal(mounts, 1, "nested ordinary and forced wakes coalesce into the current factory");
  assert.equal(reads, 2, "one post-install projection observes changes made by the setter");
  const painted = component.render(120);
  assert.match(painted[1], /during .*fresh task/);
  for (let i = 0; i < 10; i++) assert.deepEqual(component.render(120), painted);
  const held = { mounts, reads, renders };
  t.mock.timers.tick(1000);
  assert.deepEqual({ mounts, reads, renders }, held, "idle registration leaves no autonomous retry or animation");
});

test("a wake after the factory is created still leaves one current component", (t) => {
  const h = reentryHost(t, [viewOf("a", "completed")]);
  h.setMode("after"); h.widget.wake();
  assert.equal(h.counts().mounts, 1);
  assert.match(h.component().render(120).join("\n"), /Agents/);
  h.widget.wake();
  assert.equal(h.counts().mounts, 1);
});

test("a failed reentrant setter drops pending retries and recovers on an external wake", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component, fail = true, mounts = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "completed")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) { component = undefined; return; }
    mounts++; widget.wake(); component = factory(tui, theme);
    if (fail) throw new Error("REENTRANT_SETTER_FAILED");
  } });
  assert.throws(() => widget.wake(), /REENTRANT_SETTER_FAILED/);
  component.render(120);
  assert.equal(component.handleMouse(headingClick), undefined);
  t.mock.timers.tick(1000);
  assert.equal(mounts, 1, "failure does not retry itself");
  fail = false; widget.wake();
  assert.equal(mounts, 2);
  assert.match(component.render(120).join("\n"), /Agents/);
  assert.deepEqual(component.handleMouse(headingClick), { handled: true, render: true });
});

for (const stage of ["before", "after"]) test(`a setter can dispose during factory application (${stage})`, (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component, mounts = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "completed")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) { component = undefined; return; }
    mounts++; widget.wake();
    if (stage === "before") widget.dispose();
    const installed = factory(tui, theme);
    if (stage === "after") widget.dispose();
    component = installed; // A partially applying host may retain a retired component.
  } });
  assert.doesNotThrow(() => widget.wake());
  assert.deepEqual(component.render(120), []);
  assert.equal(component.handleMouse?.(headingClick), undefined);
  component.invalidate(); widget.wake(); t.mock.timers.tick(1000);
  assert.equal(mounts, 1, "retirement cannot trigger another registration");
});

test("an old setter cannot clear a replacement UI's registration state", (t) => {
  let oldComponent, current, mounts = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "completed")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  const replacement = { setWidget(_key, factory) {
    if (!factory) { current = undefined; return; }
    mounts++; widget.wake(); current = factory(tui, theme);
  } };
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) return;
    widget.setUi(replacement); widget.wake(); oldComponent = factory(tui, theme);
  } });
  assert.doesNotThrow(() => widget.wake());
  assert.equal(mounts, 1);
  assert.deepEqual(oldComponent.render(120), []);
  assert.match(current.render(120).join("\n"), /Agents/);
  widget.wake();
  assert.equal(mounts, 1, "the replacement's installed component is still current");
});

test("a failed mount retains removal ownership but cannot revive its factory or instance", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let factory, component, fail = true, mounts = 0, removals = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "completed")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  widget.setUi({ setWidget(_key, content) {
    if (!content) { removals++; return; }
    mounts++; factory = content; component = content(tui, theme);
    if (fail) throw new Error("PARTIAL_MOUNT_FAILED");
  } });
  assert.throws(() => widget.wake(), /PARTIAL_MOUNT_FAILED/);
  const oldFactory = factory, old = component;
  assert.deepEqual(old.render(120), [], "a partially applied component is retired on failure");
  const late = oldFactory({ ...tui, mode: "regular" }, theme);
  assert.deepEqual(late.render(120), [], "the failed factory cannot reacquire an instance");
  old.invalidate(); late.invalidate();
  t.mock.timers.tick(1000);
  assert.equal(mounts, 1, "failure cannot schedule its own retry");
  assert.equal(widget.tuiMode(), "fullscreen", "stale factory calls cannot change the last known renderer");
  fail = false; widget.wake();
  assert.equal(mounts, 2);
  assert.match(component.render(120)[0], /Agents/);
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.deepEqual(oldFactory(tui, theme).render(120), []);
  widget.dispose(); widget.dispose();
  assert.equal(removals, 1, "all failed/ready attempts share the one host slot");
});

for (const timer of [false, true]) test(`a failed render request retires only its mount (timer=${timer})`, (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component, fail = false, mounts = 0, reads = 0, renders = 0;
  const widget = new HarnessWidget({ list: () => { reads++; return [viewOf("a", "running")]; },
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {
    renders++;
    if (fail) throw new Error("RENDER_REQUEST_FAILED");
  } };
  t.after(() => widget.dispose());
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) return;
    mounts++; component = factory(tui, theme);
  } });
  widget.wake(); const old = component; old.render(120);
  fail = true;
  if (timer) assert.doesNotThrow(() => t.mock.timers.tick(80));
  else assert.throws(() => widget.wake(), /RENDER_REQUEST_FAILED/);
  assert.deepEqual(old.render(120), []);
  assert.equal(old.handleMouse(headingClick), undefined);
  const held = { mounts, reads, renders };
  old.invalidate(); t.mock.timers.tick(1000);
  assert.deepEqual({ mounts, reads, renders }, held, "the failed request leaves no live animation/repaint");
  assert.equal(widget.tuiMode(), "fullscreen");
  fail = false; widget.wake();
  assert.equal(mounts, 2);
  assert.match(component.render(120)[0], /Agents/);
  assert.equal(old.handleMouse(headingClick), undefined);
});

test("an older setter failure cannot retire a synchronously rebound ready mount", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component, mounts = 0, renders = 0;
  const widget = new HarnessWidget({ list: () => [viewOf("a", "running")],
    stats: () => ({ resident: 1, cleanup_uncertain: false }) }, 8);
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() { renders++; } };
  t.after(() => widget.dispose());
  const replacement = { setWidget(_key, factory) {
    if (!factory) return;
    mounts++; component = factory(tui, theme);
  } };
  widget.setUi({ setWidget(_key, factory) {
    if (!factory) return;
    widget.setUi(replacement); widget.wake();
    throw new Error("RETIRED_SETTER_FAILED");
  } });
  assert.throws(() => widget.wake(), /RETIRED_SETTER_FAILED/);
  assert.match(component.render(120)[0], /Agents/);
  const before = renders;
  t.mock.timers.tick(160);
  assert.equal(renders - before, 2, "the older exception cannot stop the new lifetime's timer");
  widget.wake();
  assert.equal(mounts, 1, "the new ready mount does not need repair");
});
