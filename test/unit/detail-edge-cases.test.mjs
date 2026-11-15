import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { settings } from "../support/controller-fixture.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane, renderDetailFields } = await jiti.import(
  "../../src/orchestration/ui/agent-detail.ts",
);
const { graphemes } = await jiti.import("../../src/orchestration/presentation/plain-text.ts");
initTheme(undefined, false);
const plain = (lines) => lines.map(stripTerminalSequences);
const view = (extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: "amber",
  run_id: "run-amber",
  name: "amber",
  task: 1,
  description: "Study detail panel layout",
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});
function fixture(
  t,
  {
    width = 120,
    height = 40,
    count = 500,
    current = view(),
    frame = false,
    transcript,
    peers = [],
  } = {},
) {
  const terminal = { columns: width, rows: height };
  let accept = true;
  const sent = [];
  const source = transcript ?? {
    count,
    lineCount() {
      return this.count;
    },
    slice(_width, start, take) {
      return Array.from(
        { length: Math.max(0, Math.min(take, this.count - start)) },
        (_, i) => `ROW${start + i}`,
      );
    },
    invalidate() {},
  };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    frame,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    initial: "amber",
    done() {},
    snapshot: () =>
      [current, ...peers].map((v) => ({
        agent_id: v.agent_id,
        input: { view: v, live: { active_tools: [], tool_uses: 1, preview: "" } },
      })),
    transcript: () => source,
    onStop() {},
    onSteer(run, text) {
      sent.push([run, text]);
      return accept;
    },
  });
  t.after(() => pane.dispose());
  return {
    pane,
    current,
    source,
    terminal,
    sent,
    refuse() {
      accept = false;
    },
    paint: () => plain(pane.render(terminal.columns)),
  };
}
function send(f, text = "wrap up") {
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput(text);
  f.pane.handleInput("\r");
  assert.equal(f.sent.length, 1);
}

test("accepted-steer notices cannot exceed narrow docked widths", (t) => {
  for (let width = 12; width <= 36; width++) {
    const f = fixture(t, { width });
    send(f);
    for (const line of f.paint()) assert(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test("one available attention row still counts every omitted note", (t) => {
  const f = fixture(t, {
    height: 12,
    current: view({
      outcome: { question: "Which branch?", error: "execution fault" },
      owner_error: "owner fault",
    }),
  });
  const lines = f.paint();
  assert(lines.some((line) => line.includes("Which branch?")));
  assert(
    lines.some((line) => /\+2(?:\b|\s)/.test(line)),
    lines.join("\n"),
  );
});

for (const count of [0, 1, 4])
  test(`tall terminals use a stable tray for ${count} transcript rows`, (t) => {
    const f = fixture(t, { count });
    const before = f.paint();
    f.pane.handleInput("m");
    f.pane.handleInput("draft");
    const short = f.paint();
    assert.equal(short.length, before.length, "opening a composer retains outer height");
    assert(short.at(-2).includes("› draft"), short.join("\n"));
    assert(short.at(-3).includes("Enter send"));
    assert(short.at(-1).includes("[Stop]"));
    f.source.count = 200;
    const grown = f.paint();
    assert(grown.at(-2).includes("› draft"));
    assert(grown.at(-3).includes("Enter send"));
    f.source.count = 1;
    assert(
      f.paint().at(-2).includes("› draft"),
      "compaction cannot move the input into the footer",
    );
  });

test("unrenderable geometry never advertises an inert message control", (t) => {
  const f = fixture(t, { height: 7 });
  assert(!f.paint().at(-1).includes("[M"));
  f.pane.handleInput("m");
  assert(!f.paint().some((line) => line.includes("›")));
  assert.deepEqual(f.sent, []);
});

test("a retained footer composer still exposes hidden notes after shrink", (t) => {
  const f = fixture(t, { current: view({ cleanup_errors: ["first fault", "second fault"] }) });
  f.paint();
  f.pane.handleInput("m");
  f.pane.handleInput("keep draft");
  assert(f.paint().at(-2).includes("keep draft"));
  f.terminal.rows = 7;
  const small = f.paint();
  assert(small.at(-1).includes("!2"), small.join("\n"));
  assert(small.at(-1).includes("keep draft"));
  assert(!small.at(-1).includes("Enter"));
  f.pane.handleInput("\r");
  assert.deepEqual(f.sent, []);
  f.terminal.rows = 40;
  assert(f.paint().at(-2).includes("keep draft"));
});

test("transient acceptance does not duplicate the admitted Run fact", (t) => {
  const f = fixture(t);
  send(f);
  f.current.human_steered = true;
  const lines = f.paint();
  assert.equal(lines.filter((line) => /Steer accepted|human steer admitted/.test(line)).length, 1);
});

test("acceptance clears on a new draft, refusal and Run end", (t) => {
  const f = fixture(t);
  send(f);
  assert(f.paint().some((line) => line.includes("Steer accepted")));
  f.pane.handleInput("m");
  assert(!f.paint().some((line) => line.includes("Steer accepted")));
  f.refuse();
  f.pane.handleInput("refused input");
  f.pane.handleInput("\r");
  assert(!f.paint().some((line) => line.includes("Steer accepted")));
  f.pane.handleInput("\x1b");
  f.current.status = "completed";
  f.current.execution_exited = true;
  assert(!f.paint().some((line) => line.includes("Steer accepted")));
});

test("transient admission feedback expires without claiming delivery", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const f = fixture(t);
  send(f);
  assert(f.paint().some((line) => line.includes("Steer accepted")));
  now += 6000;
  assert(!f.paint().some((line) => line.includes("Steer accepted")));
});

test("every accepted steer takes over the one admission row", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const f = fixture(t);
  const admission = () =>
    f.paint().filter((line) => /Steer accepted|human steer admitted/.test(line));
  // As in production, the Owner records the marker synchronously on admission,
  // before the pane's next paint.
  const steer = (text) => {
    f.paint();
    f.pane.handleInput("m");
    f.pane.handleInput(text);
    f.pane.handleInput("\r");
    f.current.human_steered = true;
  };
  for (const text of ["first", "second"]) {
    steer(text);
    const fresh = admission();
    assert.equal(fresh.length, 1, fresh.join("\n"));
    assert.match(fresh[0], /Steer accepted · delivery unconfirmed/);
    now += 6000;
    const settled = admission();
    assert.equal(settled.length, 1, settled.join("\n"));
    assert.match(settled[0], /human steer admitted/);
  }
  assert.equal(f.sent.length, 2);
});

test("an open Info page keeps the hidden count on the footer cue, and Esc returns from it", (t) => {
  // Nine docked rows leave room for the dock but no attention row or back link.
  const f = fixture(t, {
    height: 9,
    current: view({ cleanup_errors: ["first fault", "second fault"] }),
  });
  assert.match(f.paint().at(-1), /!2/, "the footer cue counts every hidden note");
  assert.ok(!f.paint().join("\n").includes("Transcript · Info"), "no constant page row");
  f.pane.handleInput("i");
  const info = f.paint();
  assert.match(info.at(-1), /!2/, "the count survives the page switch");
  assert.ok(
    info.some((line) => /^ {2}task\b/.test(line)),
    "the fields page is shown",
  );
  // The notes are listed on that page, at its own scroll position.
  f.pane.handleInput("\x1b[F");
  assert.ok(
    f.paint().some((line) => line.includes("second fault")),
    "Info lists the notes",
  );
  // Esc unwinds the Info layer before it ever closes the pane.
  f.pane.handleInput("\x1b");
  assert.equal(f.pane.isOpen(), true);
  assert.match(f.paint().at(-1), /!2/);
  assert.ok(
    f.paint().some((line) => /ROW\d+/.test(line)),
    "the transcript returns",
  );
});

for (const height of [12, 40])
  test(`Info keeps the hidden-note count without offering I info at height ${height}`, (t) => {
    const f = fixture(t, {
      height,
      current: view({ cleanup_errors: ["first fault", "second fault", "third fault"] }),
    });
    assert(
      f.paint().some((line) => line.includes("I info")),
      f.paint().join("\n"),
    );
    f.pane.handleInput("i");
    const info = f.paint();
    const flat = info.join("\n");
    assert.doesNotMatch(flat, /I info\b/, "Info is already open: no redundant key hint");
    assert.match(flat, /\+\d|!\d/, `the omitted notes stay counted: ${flat}`);
    assert.doesNotMatch(flat, /Transcript · Info/, "no constant page row");
    f.pane.handleInput("i");
    assert(f.paint().some((line) => line.includes("I info")));
  });

test("Info lists the human-steer admission the attention rows count", () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const rows = plain(
    renderDetailFields(
      {
        view: view({ human_steered: true }),
        live: {
          active_tools: [],
          tool_uses: 0,
          preview: "",
        },
      },
      theme,
      100,
    ),
  );
  assert(
    rows.some((row) => /steer\s+human steer admitted/.test(row)),
    rows.join("\n"),
  );
  assert(
    !plain(
      renderDetailFields(
        { view: view(), live: { active_tools: [], tool_uses: 0, preview: "" } },
        theme,
        100,
      ),
    ).some((row) => row.includes("human steer")),
  );
});

test("tool toggles preserve the painted message, including from Info", (t) => {
  let expanded = false;
  const source = {
    setToolsExpanded(value) {
      expanded = value;
    },
    frame() {
      const toolRows = expanded ? 80 : 10;
      const text = Array.from({ length: toolRows }, (_, i) => `TOOL${i}`).concat(
        Array.from({ length: 100 }, (_, i) => `HELD${i}`),
      );
      return {
        lineCount: text.length,
        slice: (start, take) => text.slice(start, start + take),
        anchorAt: (row) =>
          row < toolRows
            ? { block: "tool", offset: row }
            : { block: "held", offset: row - toolRows },
        resolveAnchor: (anchor) =>
          anchor.block === "held"
            ? toolRows + anchor.offset
            : Math.min(anchor.offset, toolRows - 1),
      };
    },
    lineCount() {
      throw new Error("the pane must use its captured frame");
    },
    slice() {
      throw new Error("the pane must use its captured frame");
    },
    invalidate() {},
  };
  const f = fixture(t, { transcript: source });
  const firstRow = () => f.paint().find((line) => /^(?:TOOL|HELD)\d+$/.test(line));
  f.paint();
  f.pane.handleInput("\x1b[H");
  f.paint();
  for (let i = 0; i < 10; i++) f.pane.handleInput("\x1b[B");
  assert.equal(firstRow(), "HELD0");
  f.pane.handleInput("t");
  assert.equal(firstRow(), "HELD0", "expanding previous output keeps the same message first");
  f.pane.handleInput("i");
  f.paint();
  f.pane.handleInput("t");
  f.paint();
  f.pane.handleInput("i");
  assert.equal(firstRow(), "HELD0", "Info returns to the same message after collapsing");
  f.pane.handleInput("\x1b[F");
  f.paint();
  f.pane.handleInput("t");
  assert.equal(
    f
      .paint()
      .filter((line) => /^HELD\d+$/.test(line))
      .at(-1),
    "HELD99",
  );
});

test("an unpaintable pane does not format its hidden summary", (t) => {
  const current = view();
  current.effective_settings = { ...settings };
  Object.defineProperty(current.effective_settings, "model", {
    get() {
      throw new Error("hidden summary was formatted");
    },
  });
  const f = fixture(t, { current, height: 4 });
  assert.deepEqual(f.paint(), [], "the two-row budget cannot fit title/status/footer");
});

test("compact drafts skip hidden tabs while keeping visible bottom metrics", (t) => {
  const current = view();
  current.effective_settings = { ...settings };
  let modelReads = 0;
  Object.defineProperty(current.effective_settings, "model", {
    get() {
      modelReads++;
      return settings.model;
    },
  });
  let hidden = false;
  const peer = view({ agent_id: "cobalt", run_id: "run-cobalt" });
  Object.defineProperty(peer, "name", {
    get() {
      if (hidden) throw new Error("hidden tab was formatted");
      return "cobalt";
    },
  });
  const f = fixture(t, { current, peers: [peer], height: 8 });
  // The bottom metrics now survive this height; tabs still ride the edge.
  const before = f.paint();
  assert.match(before.at(-1), /cobalt/);
  assert.match(before.at(-2), /running/);
  assert.ok(modelReads > 0, "the visible summary is formatted");
  // A compact draft owns that edge: only the hidden tabs skip formatting.
  f.pane.handleInput("m");
  hidden = true;
  const previousReads = modelReads;
  const composing = f.paint();
  assert.match(composing.at(-1), /^› /);
  assert.doesNotMatch(composing.at(-1), /cobalt/);
  assert.match(composing.at(-2), /running/);
  assert.ok(modelReads > previousReads, "the summary remains visible beside a compact draft");
});

test("retiring Stop state does not retire still-painted tabs", (t) => {
  const peer = view({ agent_id: "cobalt", run_id: "run-cobalt", name: "cobalt" });
  const f = fixture(t, { peers: [peer] });
  const lines = f.paint();
  const y = lines.findIndex((line) => line.includes("cobalt"));
  assert(y >= 0);
  const x = visibleWidth(lines[y].slice(0, lines[y].indexOf("cobalt")));
  f.pane.resetStopInteraction();
  assert.deepEqual(f.pane.handleMouse({ type: "click", button: "left", x, y }), { handled: true });
  assert(f.paint()[0].includes("cobalt"));
});

test("stable Info paragraphs reuse wrapping across spinner/clock paints", (t) => {
  const text = "INFO_WRAP_SENTINEL ".repeat(150);
  const original = graphemes.segment;
  let paragraphs = 0;
  t.mock.method(graphemes, "segment", function (value) {
    if (value === text) paragraphs++;
    return original.call(this, value);
  });
  const f = fixture(t, { current: view({ cleanup_errors: [text] }) });
  f.paint();
  f.pane.handleInput("i");
  f.paint();
  assert(paragraphs > 0, "the first Info paint actually wrapped the paragraph");
  paragraphs = 0;
  f.current.elapsed_ms += 120;
  f.paint();
  assert.equal(paragraphs, 0, "only changing clock text needs fresh wrapping");
  f.pane.invalidate();
  f.paint();
  assert(paragraphs > 0, "explicit layout/theme invalidation retires wrapping cache");
});
