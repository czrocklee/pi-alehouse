import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane, renderDetailFields } from "../../dist/ui/agent-detail.js";
import { ChildActivity } from "../../dist/runtime/activity-observer.js";
import { settings } from "../support/controller-fixture.mjs";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const view = (extra = {}) => ({
  owner_id: "owner", generation: "generation", agent_id: "a", run_id: "run-a", name: "a",
  description: "Preview fixture", effective_settings: settings, status: "running", phase: "executing",
  execution_exited: false, finalization_pending: false, resident: true, resumable: false,
  owner_blocked: false, pending_messages: 0, isolation: "shared", elapsed_ms: 0,
  turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [], ...extra,
});
const live = (extra = {}) => ({ active_tools: [], tool_uses: 0, preview: "", ...extra });
const fields = (state, generation = live(), width = 100, palette = theme) =>
  renderDetailFields({ view: state, live: generation }, palette, width);
const rowFor = (rows, label) => rows.find((line) => stripTerminalSequences(line).startsWith(`  ${label} `));
const body = (paint) => paint.slice(1, -1).map((line) => stripTerminalSequences(line).replace(/^│(.*)│$/u, "$1").trimEnd());
const firstTranscript = (paint) => Number(body(paint).find((line) => /^transcript-\d+$/.test(line))?.slice("transcript-".length));

function paneFixture(t, frame = false) {
  const state = view(), generation = live(), terminal = { columns: 100, rows: 40 };
  const transcript = { count: 180 };
  const rows = { lineCount: () => transcript.count, slice: (_width, start, take) =>
    Array.from({ length: Math.max(0, Math.min(take, transcript.count - start)) }, (_, i) => `transcript-${start + i}`) };
  const stopped = [];
  const entries = [{ agent_id: "a", input: { view: state, live: generation } }];
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} }, theme, frame, initial: "a", snapshot: () => entries,
    transcript: () => rows, done() {}, onStop: (id) => stopped.push(id),
  });
  t.after(() => pane.dispose());
  return { pane, state, generation, terminal, transcript, stopped, entries };
}

for (const channel of ["thinking", "text"]) test(`100-column detail bounds both 1024-character previews (${channel})`, () => {
  const state = view(), baseline = fields(state);
  const input = live({ channel, thinking: "Thought " + "測".repeat(1024), preview: "Reply " + "x".repeat(1024) });
  const rendered = fields(state, input);
  assert.equal(rendered.length, baseline.length + 4, "each preview adds one blank and one display row, never wraps");
  assert.equal(rendered.filter((line) => /^ {2}thinking /.test(line)).length, 1);
  assert.equal(rendered.filter((line) => /^ {2}draft /.test(line)).length, 1);
  assert.match(stripTerminalSequences(rowFor(rendered, "thinking")), /Thought 測+…$/);
  assert.match(stripTerminalSequences(rowFor(rendered, "draft")), /Reply x+…$/);
  assert(rendered.every((line) => visibleWidth(line) <= 100));
  assert.equal(input.thinking.length, 1032, "display clipping never mutates observer data");
  assert.equal(input.preview.length, 1030);
});

test("real tool capture keeps short bash and an 8KB heredoc to the same one-row detail budget", () => {
  const state = view(), baseline = fields(state);
  const child = new ChildActivity(settings.cwd), handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  assert.equal(fields(state, child.snapshot()).length, baseline.length);
  const command = "python <<'PY'\n" + "x".repeat(8192) + "\nPY";
  for (const [index, input] of ["npm test", command].entries()) {
    handlers.get("tool_execution_start")({ toolCallId: "bash", toolName: "bash", args: { command: input } });
    const snapshot = child.snapshot(), rendered = fields(state, snapshot);
    assert.equal(snapshot.active_tools.length, 1);
    assert.equal(rendered.length, baseline.length + 2, "one separator and one active row regardless of capture size");
    assert(rendered.every((line) => visibleWidth(line) <= 100));
    if (index === 0) assert.match(rowFor(rendered, "active"), /bash npm test$/);
    else {
      assert.equal(snapshot.active_tools[0].detail.length, 4097, "the real observer bounded the 8KB input at 4096 plus ellipsis");
      assert.match(rowFor(rendered, "active"), /bash python <<'PY' x+…$/);
    }
    handlers.get("tool_execution_end")({ toolCallId: "bash" });
  }
  assert.equal(fields(state, child.snapshot()).length, baseline.length, "ending tools removes only the compact active section");
});

test("parallel active tools add exactly one row apiece even with long captured arguments", () => {
  const state = view(), baseline = fields(state);
  const tools = ["bash", "read", "edit", "write"].map((name) => ({ name, detail: "segment/".repeat(500) + "target.ts" }));
  const rendered = fields(state, live({ active_tools: tools }));
  assert.equal(rendered.length, baseline.length + 1 + tools.length);
  const active = rendered.slice(baseline.length + 1);
  assert.equal(active.length, tools.length);
  for (const [index, tool] of tools.entries()) {
    assert(active[index].slice(12).startsWith(tool.name + " "));
    assert(visibleWidth(active[index]) <= 100);
  }
});

for (const name of ["read", "edit", "write", "ls"]) test(`active ${name} shortens a path using remaining columns and keeps its filename`, () => {
  const path = "dir/".repeat(200) + "recognizable-file.ts";
  const state = view({ workspace: { cwd: "/actual/worktree", source_cwd: settings.cwd, base_commit: "base" } });
  for (const detail of [path, "/actual/worktree/" + path]) {
    const rendered = fields(state, live({ active_tools: [{ name, detail }] }), 50);
    const active = rowFor(rendered, "active");
    assert.match(active, /…\/.*recognizable-file\.ts$/);
    assert(visibleWidth(active) <= 50);
  }
});

test("active tool names and arguments are sanitized before measuring and styling", () => {
  const rendered = fields(view(), live({ active_tools: [{ name: "\x1b[8mbash\x1b[0m",
    detail: "\x1b]0;hidden-title\x07npm\ntest\x08 " + "測".repeat(100) }] }));
  const active = rowFor(rendered, "active");
  assert.match(active, /bash npm test\\x08 測+…$/);
  assert(!active.includes("hidden-title"));
  assert(!/\p{Cc}/u.test(active));
  assert(visibleWidth(active) <= 100);
});

test("active tool clipping bounds zero and tiny widths without splitting CJK or emoji clusters", () => {
  for (const width of [0, 1, 8, 12, 13, 17, 18, 19, 30, 100]) for (const name of ["bash", "測"]) {
    for (const cluster of ["測", "👩\u200d💻", "e\u0301"]) {
      const active = fields(view(), live({ active_tools: [{ name, detail: cluster.repeat(100) }] }), width).at(-1);
      assert(visibleWidth(active) <= width, `active row overflows ${width} columns`);
      const content = stripTerminalSequences(active).slice(12).replace(/…$/, "");
      if (content.startsWith(name + " ")) {
        assert.equal(content.slice(name.length + 1).replaceAll(cluster, ""), "", "argument grapheme clusters remain whole");
      }
    }
  }
});

test("active tool ellipsis stays in the argument's accent color", () => {
  const palette = { fg: (color, text) => color === "accent" ? `\x1b[38;2;80;90;100m${text}\x1b[39m` : text,
    bold: (text) => text };
  const active = rowFor(fields(view(), live({ active_tools: [{ name: "bash", detail: "x".repeat(4096) }] }), 100, palette), "active");
  assert.equal(active.slice(12), `\x1b[38;2;80;90;100mbash ${"x".repeat(82)}…\x1b[39m`);
});

test("thinking and draft are independent last-logical-line fields", () => {
  const state = view();
  const both = fields(state, live({ channel: "text", thinking: "older thought\n**Current thought**\n", preview: "old reply\nCurrent reply\n" }));
  assert.match(rowFor(both, "thinking"), /Current thought$/);
  assert.match(rowFor(both, "draft"), /Current reply$/);
  assert(!both.join("\n").includes("older thought"));
  const thoughtOnly = fields(state, live({ thinking: "Thought alone", channel: "thinking" }));
  assert.match(rowFor(thoughtOnly, "thinking"), /Thought alone$/);
  assert.equal(rowFor(thoughtOnly, "draft"), undefined);
  const textOnly = fields(state, live({ preview: "Reply alone", channel: "text" }));
  assert.equal(rowFor(textOnly, "thinking"), undefined);
  assert.match(rowFor(textOnly, "draft"), /Reply alone$/);
});

test("preview content and its ellipsis are clipped before muted styling", () => {
  const painted = [];
  const palette = { fg: (color, text) => {
    painted.push({ color, text });
    return color === "muted" ? `\x1b[38;2;90;90;90m${text}\x1b[39m` : text;
  }, bold: (text) => text };
  const rendered = fields(view(), live({ thinking: "x".repeat(1024) }), 100, palette);
  assert.equal(rowFor(rendered, "thinking").slice(12), `\x1b[38;2;90;90;90m${"x".repeat(87)}…\x1b[39m`,
    "the rendered ellipsis stays inside the same muted color span as the content");
  const content = painted.find(({ color, text }) => color === "muted" && text.startsWith("xxx"));
  assert(content);
  assert.equal(visibleWidth(content.text), 88);
  assert.match(content.text, /^x+…$/);
  assert(!/\p{Cc}/u.test(content.text), "SDK truncation reset markers cannot override the content's color");
  assert(painted.some(({ color, text }) => color === "dim" && text.trim() === "thinking"));
});

test("ordinary detail metadata still wraps completely", () => {
  const description = "long task ".repeat(200).trim();
  const rendered = fields(view({ description }), live({ preview: "x".repeat(1024) }));
  const task = rendered.slice(0, rendered.indexOf(""));
  assert(task.length > 2);
  assert.equal(task.map((line) => line.slice(12)).join(" ").replace(/\s+/g, " ").trim(), description);
  assert.equal(rendered.filter((line) => /^ {2}draft /.test(line)).length, 1);
});

for (const preparing_tool of ["write", ""]) test(`preparing tool is a separate bounded field (${JSON.stringify(preparing_tool)})`, () => {
  const rendered = fields(view(), live({ preparing_tool }));
  assert.equal(stripTerminalSequences(rowFor(rendered, "preparing")).trim(), `preparing ${preparing_tool || "tool"}`);
  assert.equal(rowFor(rendered, "thinking"), undefined);
  assert.equal(rowFor(rendered, "draft"), undefined);
});

for (const state of [
  { status: "cancelling" }, { status: "completed", execution_exited: true },
  { finalization_pending: true }, { execution_exited: true },
  { drain: { elapsed_ms: 5, waiting_for: "sdk_idle" } },
  { runtime: { activity: "retrying" } }, { runtime: { activity: "compacting" } },
]) test(`system activity hides generation but retains genuine active tools (${JSON.stringify(state)})`, () => {
  const rendered = fields(view(state), live({ thinking: "Old thought", preview: "Old reply", preparing_tool: "write",
    active_tools: [{ name: "bash", detail: "npm test" }] }));
  assert.match(rowFor(rendered, "active"), /bash npm test$/);
  if (state.drain) assert.match(rowFor(rendered, "drain"), /draining .*awaiting SDK idle$/);
  for (const label of ["thinking", "draft", "preparing"]) assert.equal(rowFor(rendered, label), undefined);
});

for (const frame of [false, true]) test(`scrolled transcript stays anchored as preview fields change (frame=${frame})`, (t) => {
  const h = paneFixture(t, frame), width = frame ? 102 : 100;
  h.pane.render(width); h.pane.handleInput("\x1b[5~");
  const before = h.pane.render(width), expected = body(before);
  assert(Number.isFinite(firstTranscript(before)));
  Object.assign(h.generation, { thinking: "x".repeat(1024), preview: "y".repeat(1024), channel: "text" });
  assert.deepEqual(body(h.pane.render(width)), expected, "adding thinking and draft does not move transcript rows");
  h.generation.preparing_tool = "write";
  assert.deepEqual(body(h.pane.render(width)), expected, "tool preparation does not move transcript rows");
  h.generation.thinking = ""; h.generation.preview = ""; delete h.generation.preparing_tool;
  h.transcript.count += 3;
  assert.deepEqual(body(h.pane.render(width)), expected, "removing fields and live transcript growth preserve the reading window");
});

test("field changes do not scroll a reader who is still in metadata", (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[H");
  const before = h.pane.render(100);
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  const after = h.pane.render(100);
  assert.equal(body(after)[0], body(before)[0]);
  assert.match(body(after)[0], /^ {2}task /);
});

test("the first transcript row is included in scroll anchoring", (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[H");
  for (let i = 0; i < fields(h.state, h.generation).length + 1; i++) h.pane.handleInput("\x1b[B");
  const before = body(h.pane.render(100));
  assert.equal(before[0], "transcript-0");
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  assert.deepEqual(body(h.pane.render(100)), before);
});

test("follow-tail still follows live transcript through preview changes", (t) => {
  const h = paneFixture(t);
  assert.match(body(h.pane.render(100)).at(-1), /transcript-179$/);
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  h.transcript.count++;
  assert.match(body(h.pane.render(100)).at(-1), /transcript-180$/);
  h.pane.handleInput("\x1b[5~"); h.pane.render(100);
  h.pane.handleInput("\x1b[F");
  h.generation.thinking = ""; h.generation.preview = ""; h.transcript.count++;
  assert.match(body(h.pane.render(100)).at(-1), /transcript-181$/);
});

test("resize discards the previous width's transcript anchor", (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[5~");
  const before = firstTranscript(h.pane.render(100));
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  h.terminal.columns = 120;
  const resized = firstTranscript(h.pane.render(120));
  assert.equal(resized, before - 4, "a changed wrapping width cannot borrow the old boundary delta");
  h.generation.thinking = ""; h.generation.preview = "";
  assert.equal(firstTranscript(h.pane.render(120)), resized, "the new width establishes its own anchor");
});

for (const interruption of ["unrenderable-width", "empty-roster"]) test(`interrupted paint retires the previous transcript anchor (${interruption})`, (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[5~");
  const before = firstTranscript(h.pane.render(100));
  if (interruption === "unrenderable-width") assert.deepEqual(h.pane.render(8), []);
  else {
    const [original] = h.entries.splice(0);
    assert.match(h.pane.render(100).join("\n"), /No agents are available/);
    h.entries.push(original);
  }
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  assert.equal(firstTranscript(h.pane.render(100)), before - 4,
    "restoring the original width or roster cannot revive the retired anchor");
});

for (const identity of ["owner_id", "generation", "run_id"]) test(`Run replacement cannot borrow a transcript anchor (${identity})`, (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[5~");
  const before = firstTranscript(h.pane.render(100));
  h.state[identity] = `new-${identity}`;
  h.generation.thinking = "New thought"; h.generation.preview = "New reply";
  assert.equal(firstTranscript(h.pane.render(100)), before - 4);
});

test("Agent selection resets transcript following instead of borrowing the previous anchor", (t) => {
  const h = paneFixture(t);
  h.entries.push({ agent_id: "b", input: { view: view({ agent_id: "b", run_id: "run-b", name: "b" }),
    live: live({ thinking: "New thought", preview: "New reply" }) } });
  h.pane.render(100); h.pane.handleInput("\x1b[5~"); h.pane.render(100);
  h.pane.activate("b");
  assert.match(body(h.pane.render(100)).at(-1), /transcript-179$/);
});

test("automatic Agent fallback resets following when the previous selection disappears", (t) => {
  const h = paneFixture(t);
  h.pane.render(100); h.pane.handleInput("\x1b[5~"); h.pane.render(100);
  h.entries.splice(0, 1, { agent_id: "b", input: { view: view({ agent_id: "b", run_id: "run-b", name: "b" }),
    live: live({ thinking: "New thought", preview: "New reply" }) } });
  const rendered = h.pane.render(100);
  assert.match(stripTerminalSequences(rendered[0]), /^b /);
  assert.match(body(rendered).at(-1), /transcript-179$/);
});

for (const frame of [false, true]) test(`preview changes preserve inline Stop geometry and bound confirmation (frame=${frame})`, (t) => {
  const h = paneFixture(t, frame), width = frame ? 102 : 100;
  h.pane.render(width); h.pane.handleInput("\x1b[5~");
  const before = h.pane.render(width);
  assert.match(before.at(-1), /\[S Stop\]/);
  h.pane.handleInput("s");
  const armed = h.pane.render(width);
  assert.deepEqual(armed.slice(0, -1), before.slice(0, -1));
  Object.assign(h.generation, { thinking: "x".repeat(1024), preview: "y".repeat(1024) });
  const changed = h.pane.render(width);
  assert.equal(changed.length, armed.length);
  assert.deepEqual(body(changed), body(armed));
  assert.match(changed.at(-1), /best-effort · Ctrl\+S · Esc cancel · \[Confirm stop\]/);
  h.pane.handleInput("\x13"); h.pane.handleInput("\x13");
  assert.deepEqual(h.stopped, ["run-a"], "only the originally painted target is cancelled, once");
});
