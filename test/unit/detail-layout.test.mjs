import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { settings } from "../support/controller-fixture.mjs";

const jiti = createJiti(import.meta.url);
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { floatingPaneWidth } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const plain = (lines) => lines.map(stripTerminalSequences);
const ESC = "\x1b";
const HOME = "\x1b[H";
const END = "\x1b[F";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const view = (name = "amber", extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: name,
  run_id: `run-${name}`,
  name,
  task: 1,
  description: "Review lifecycle changes",
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 95000,
  turns: 3,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});
function setup(t, { frame = true, views = [view()], count = 500, rows = 40, expandToolsKey } = {}) {
  const sent = [],
    stops = [],
    modes = [];
  const terminal = { columns: 120, rows };
  const source = {
    count,
    lineCount() {
      return this.count;
    },
    slice(_width, from, take) {
      return Array.from(
        { length: Math.max(0, Math.min(take, this.count - from)) },
        (_, i) => `T${from + i}`,
      );
    },
    setToolsExpanded(expanded) {
      modes.push(expanded);
    },
    invalidate() {},
  };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    snapshot: () =>
      views.map((v) => ({
        agent_id: v.agent_id,
        input: { view: v, live: { active_tools: [], tool_uses: 12, preview: "" } },
      })),
    transcript: () => source,
    initial: views[0].agent_id,
    done() {},
    onSteer(run, text) {
      sent.push([run, text]);
      return true;
    },
    onStop(run) {
      stops.push(run);
    },
    expandToolsKey,
  });
  t.after(() => pane.dispose());
  return {
    pane,
    views,
    source,
    sent,
    stops,
    modes,
    terminal,
    paint: () => plain(pane.render(120)),
  };
}
const transcriptRows = (lines) =>
  lines.map((line) => line.match(/(?:^|\s)(T\d+)(?=\s|$)/)?.[1]).filter(Boolean);
function click(pane, lines, label) {
  const y = lines.findIndex((line) => line.includes(label));
  assert(y >= 0, `missing ${label}`);
  const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(label)));
  return pane.handleMouse({ type: "click", button: "left", x, y, clickCount: 1 });
}

test("floating detail width is capped without relying on an unsupported maxWidth option", () => {
  for (const [columns, width] of [
    [100, 88],
    [186, 163],
    [200, 164],
    [600, 164],
  ])
    assert.equal(floatingPaneWidth(columns), width);
  for (const columns of [undefined, 0, -1, NaN, Infinity])
    assert.equal(floatingPaneWidth(columns), "88%");
});

test("observations stay pinned while only the transcript scrolls", (t) => {
  const f = setup(t, { views: [view("amber", { outcome: { question: "Which branch?" } })] });
  const tail = f.paint();
  // Normal running work leads the dock with its lifecycle glyph alone.
  assert(tail.at(-2).includes("⠋"), tail.at(-2));
  assert(!tail.at(-2).includes("running"), tail.at(-2));
  assert(tail.some((line) => line.includes("Which branch?")));
  assert.equal(transcriptRows(tail).at(-1), "T499");
  f.pane.handleInput(HOME);
  const head = f.paint();
  assert.equal(transcriptRows(head)[0], "T0");
  assert.deepEqual(
    head.slice(
      0,
      head.findIndex((line) => /T0\s/.test(line)),
    ),
    tail.slice(
      0,
      head.findIndex((line) => /T0\s/.test(line)),
    ),
  );
  assert(head.every((line) => visibleWidth(line) <= 120));
  assert(head.filter((line) => /T\d/.test(line)).every((line) => line.startsWith("│  ")));
  assert(
    head.some((line) => line.endsWith("┃")),
    "the border shows the scroll thumb",
  );
});

test("info is a separate page and restores the held transcript position", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput(HOME);
  f.paint();
  for (let i = 0; i < 10; i++) f.pane.handleInput(DOWN);
  assert.equal(transcriptRows(f.paint())[0], "T10");
  f.pane.handleInput("i");
  const info = f.paint();
  assert.equal(transcriptRows(info).length, 0);
  assert(info.some((line) => line.includes("routing")));
  f.pane.handleInput(END);
  f.paint();
  f.pane.handleInput("i");
  assert.equal(transcriptRows(f.paint())[0], "T10");
  f.source.count += 100;
  assert.equal(transcriptRows(f.paint())[0], "T10", "Info navigation did not turn following on");
});

test("a changing bottom-docked warning cannot shift the first held transcript row", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput(HOME);
  f.paint();
  for (let i = 0; i < 8; i++) f.pane.handleInput(DOWN);
  const before = transcriptRows(f.paint())[0];
  f.views[0].cleanup_errors.push("cleanup observation");
  const after = f.paint();
  assert(after.some((line) => line.includes("cleanup observation")));
  assert.equal(transcriptRows(after)[0], before);
});

for (const frame of [false, true])
  test(`composer borrows transcript rows without resizing and retains Stop (frame=${frame})`, (t) => {
    const f = setup(t, { frame });
    const before = f.paint();
    f.pane.handleInput("m");
    f.pane.handleInput("\x1b[200~check alpha\nbeta\x1b[201~");
    const composing = f.paint();
    assert.equal(composing.length, before.length);
    assert(composing.at(-1).includes("stop"));
    // While composing S is draft text, never the Stop shortcut: typing it
    // appends to the draft and leaves no armed confirmation.
    f.pane.handleInput("s");
    assert(f.paint().at(-2).includes("check alpha betas"));
    assert(!f.paint().at(-1).includes("confirm stop"));
    f.pane.handleInput("\x7f");
    assert(f.paint().at(-2).includes("check alpha beta"));
    assert(composing.at(-3).includes("Enter send"));
    assert(composing.at(-2).includes("› check alpha beta"));
    assert.equal(transcriptRows(composing).length, transcriptRows(before).length - 2);
    f.pane.handleInput(UP);
    assert(f.paint().at(-2).includes("check alpha beta"));
    f.pane.handleInput("\r");
    assert.deepEqual(f.sent, [["run-amber", "check alpha beta"]]);
    assert(f.paint().some((line) => line.includes("Steer accepted · delivery unconfirmed")));
    assert.deepEqual(f.stops, []);
  });

test("Stop confirmation in a composer never consumes or submits its draft", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("keep draft");
  let lines = f.paint();
  assert.deepEqual(click(f.pane, lines, "stop"), { handled: true });
  lines = f.paint();
  assert(lines.at(-1).includes("confirm stop"));
  assert(lines.at(-2).includes("keep draft"));
  f.pane.handleInput(ESC);
  assert(f.paint().at(-2).includes("keep draft"));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.stops, []);
  click(f.pane, f.paint(), "stop");
  f.paint();
  f.pane.handleInput("\x13");
  assert.deepEqual(f.stops, ["run-amber"]);
  assert(f.paint().at(-2).includes("keep draft"));
});

test("compaction cannot silently retire Stop confirmation over an open draft", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("draft");
  click(f.pane, f.paint(), "stop");
  assert(f.paint().at(-1).includes("confirm stop"));
  f.source.count = 1;
  assert(f.paint().at(-1).includes("confirm stop"));
  f.pane.handleInput("\x13");
  assert.deepEqual(f.stops, ["run-amber"]);
  assert.deepEqual(f.sent, []);
  assert(f.paint().at(-2).includes("draft"));
});

test("Enter over Stop confirmation only cancels intent, never submits the draft", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("draft");
  click(f.pane, f.paint(), "stop");
  f.source.count = 1;
  f.paint();
  f.pane.handleInput("\r");
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.sent, []);
  assert(f.paint().at(-2).includes("draft"));
});

test("paste chunks remain data even if the pointer arms Stop between chunks", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("\x1b[200~");
  click(f.pane, f.paint(), "stop");
  assert(f.paint().at(-1).includes("confirm stop"));
  for (const chunk of ["\x13", "\x1b", "\r"]) f.pane.handleInput(chunk);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.sent, []);
  f.pane.handleInput("\x1b[201~");
  assert(f.paint().at(-2).includes("\\x13"), "control bytes were sanitized into draft text");
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.sent, []);
  assert(!f.paint().at(-1).includes("confirm stop"));
});

test("the host tools-expand key aliases T, including a custom binding", (t) => {
  const f = setup(t, { expandToolsKey: (data) => data === "\x18" });
  f.paint();
  assert.equal(f.modes.at(-1), false);
  f.pane.handleInput("\x18");
  f.paint();
  assert.equal(f.modes.at(-1), true);
  f.pane.handleInput("t");
  f.paint();
  assert.equal(f.modes.at(-1), false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.stops, []);
});

test("clickable message and agent tabs use painted text coordinates", (t) => {
  const f = setup(t, { views: [view(), view("cobalt")] });
  let lines = f.paint();
  const messageLabel = lines.at(-1).includes("message") ? "message" : "msg";
  assert.deepEqual(click(f.pane, lines, messageLabel), { handled: true });
  assert(f.paint().at(-3).includes("Steer amber"));
  f.pane.handleInput(ESC);
  lines = f.paint();
  assert.deepEqual(click(f.pane, lines, "cobalt"), { handled: true });
  assert(f.paint()[0].includes("cobalt"));
});

test("tab clicks require a fresh paint after geometry or interaction retirement", (t) => {
  const f = setup(t, { views: [view(), view("cobalt")] });
  const old = f.paint();
  f.terminal.columns = 119;
  assert.equal(click(f.pane, old, "cobalt"), undefined);
  f.terminal.columns = 120;
  assert(f.paint()[0].includes("amber"));
  const current = f.paint();
  f.pane.resetCloseHover();
  assert.equal(click(f.pane, current, "cobalt"), undefined);
  assert(f.paint()[0].includes("amber"));
});

test("an ended draft names its original task, never the replacement task", (t) => {
  const f = setup(t);
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("old instructions");
  f.views[0] = view("amber", { run_id: "replacement", task: 2 });
  const ended = f.paint();
  assert(ended.at(-3).includes("Steer original task"));
  assert(ended.at(-3).includes("task ended"));
  assert(!ended.at(-3).includes("#2"));
  assert(!ended.at(-1).includes("Enter"), "the footer cannot advertise sending to a replacement");
  f.pane.handleInput("\r");
  assert.deepEqual(f.sent, []);
  assert(f.paint().at(-2).includes("old instructions"));
});

test("T changes only transcript projection and End resumes following", (t) => {
  const f = setup(t);
  f.paint();
  assert.equal(f.modes.at(-1), false);
  f.pane.handleInput("t");
  f.paint();
  assert.equal(f.modes.at(-1), true);
  f.pane.handleInput("t");
  f.paint();
  assert.equal(f.modes.at(-1), false);
  f.pane.handleInput(UP);
  f.paint();
  f.source.count += 20;
  assert.equal(transcriptRows(f.paint()).at(-1), "T498");
  f.pane.handleInput(END);
  assert.equal(transcriptRows(f.paint()).at(-1), "T519");
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.stops, []);
});
