import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const theme = { fg: (_color, text) => text, bold: (text) => text };

function fixture(
  t,
  { enabled = false, frame = true, width = 120, rows = 40, agents = 2, status = "running" } = {},
) {
  setBorderLabelsEnabled(enabled);
  const terminal = { columns: width, rows };
  const selected = [],
    stops = [],
    sent = [],
    closes = [];
  const entries = ["amber", "birch"].slice(0, agents).map((id) => ({
    agent_id: id,
    input: {
      view: {
        owner_id: "owner",
        generation: "generation",
        agent_id: id,
        run_id: `run-${id}`,
        name: id,
        task: 1,
        description: "Inspect 界面 layout",
        status,
        phase: status === "running" ? "executing" : "settled",
        execution_exited: status !== "running",
        finalization_pending: false,
        resident: true,
        resumable: false,
        pending_messages: 0,
        elapsed_ms: 1000,
        turns: 1,
        max_turns: 80,
        cleanup_errors: [],
        discarded_inputs: [],
        effective_settings: {
          profile: "editor",
          difficulty: 3,
          model: "controlled",
          thinking: "off",
          tools: ["read"],
          cwd: "/tmp",
        },
      },
      live: { active_tools: [], tool_uses: 0, preview: "" },
    },
  }));
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    initial: "amber",
    snapshot: () => entries,
    transcript: () => ({
      lineCount: () => 80,
      slice: (_width, from, count) =>
        Array.from({ length: count }, (_, index) => `ROW${from + index}`),
    }),
    done: () => closes.push(true),
    onSelect: (id) => selected.push(id),
    onStop: (id) => stops.push(id),
    onSteer: (id, text) => {
      sent.push([id, text]);
      return true;
    },
  });
  t.after(() => {
    pane.dispose();
    setBorderLabelsEnabled(true);
  });
  const paint = () => pane.render(terminal.columns).map(stripTerminalSequences);
  const locate = (label, lines = paint(), last = false) => {
    const y = last
      ? lines.findLastIndex((line) => line.includes(label))
      : lines.findIndex((line) => line.includes(label));
    assert.ok(y >= 0, `missing ${label}:\n${lines.join("\n")}`);
    return { x: visibleWidth(lines[y].slice(0, lines[y].indexOf(label))), y };
  };
  const click = ({ x, y }) => pane.handleMouse({ type: "click", button: "left", x, y });
  return { pane, terminal, selected, stops, sent, closes, paint, locate, click };
}

test("off keeps a clean frame, moving both label bands and close inside", (t) => {
  const h = fixture(t);
  const lines = h.paint();
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.match(lines[2], /^├─+┤$/);
  assert.match(lines.at(-3), /^├─+┤$/);
  assert.match(lines[1], /amber.*Inspect.*#1/);
  assert.match(lines.at(-2), /amber.*birch.*stop/);
  assert.doesNotMatch(lines.at(-2), /─/);
  assert.deepEqual(h.locate("✕", lines), { x: 116, y: 1 });
  assert.ok(lines.every((line) => visibleWidth(line) === 120));
  h.click(h.locate("birch", lines, true));
  assert.deepEqual(h.selected, ["birch"]);
});

test("a narrow empty footer keeps its reserved inset band without hidden controls", (t) => {
  const h = fixture(t, { agents: 1, width: 14, status: "completed" });
  for (const width of [14, 16]) {
    h.terminal.columns = width;
    const lines = h.paint();
    assert.match(lines.at(-3), /^├─+┤$/);
    assert.match(lines.at(-2), /^│ +│$/);
    assert.match(lines.at(-1), /^╰─+╯$/);
    for (let x = 0; x < width; x++) {
      h.click({ x, y: lines.length - 2 });
      h.click({ x, y: lines.length - 1 });
    }
    h.pane.handleInput("s");
    h.pane.handleInput("\x13");
    h.pane.handleInput("m");
    h.pane.handleInput("\r");
    assert.deepEqual(h.stops, []);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.closes, []);
  }
});

test("the shared switch updates a mounted pane and retires old command evidence", (t) => {
  const h = fixture(t, { enabled: true });
  const before = h.paint();
  const stop = h.locate("stop", before);
  const close = h.locate("✕", before);
  assert.equal(close.y, 0);
  h.pane.handleInput("s");
  assert.match(h.paint().at(-1), /confirm stop/);
  setBorderLabelsEnabled(false);
  h.click(close);
  h.click(stop);
  h.pane.handleInput("\x13");
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.closes, []);
  const after = h.paint();
  assert.match(after[0], /^╭─+╮$/);
  assert.doesNotMatch(after.at(-2), /confirm stop/);
  h.click(h.locate("stop", after));
  const confirm = h.locate("confirm stop");
  assert.equal(confirm.y, h.paint().length - 2);
  h.click(confirm);
  assert.deepEqual(h.stops, ["run-amber"]);
});

test("off menu items and the Info return link follow the shared body origin", (t) => {
  const h = fixture(t);
  h.click(h.locate(". more"));
  h.click(h.locate("Info"));
  const lines = h.paint();
  const back = h.locate("← Transcript", lines);
  assert.equal(back.y, 3);
  h.click(back);
  assert.ok(h.paint().some((line) => /\bROW79\b/.test(line)));
});

test("appearance changes preserve scrolling and unsent drafts without submitting", (t) => {
  const h = fixture(t, { enabled: true });
  h.paint();
  h.pane.handleInput("\x1b[H");
  assert.ok(h.paint().some((line) => /\bROW0\b/.test(line)));
  setBorderLabelsEnabled(false);
  assert.ok(h.paint().some((line) => /\bROW0\b/.test(line)));
  h.pane.handleInput("m");
  h.pane.handleInput("keep this draft");
  assert.ok(h.paint().some((line) => line.includes("keep this draft")));
  setBorderLabelsEnabled(true);
  assert.ok(h.paint().some((line) => line.includes("keep this draft")));
  assert.deepEqual(h.sent, []);
});

test("an in-flight close gesture cannot move from the border to the title row", (t) => {
  const h = fixture(t, { enabled: true });
  const close = h.locate("✕");
  h.pane.handleMouse({ type: "press", button: "left", ...close });
  setBorderLabelsEnabled(false);
  const next = h.locate("✕");
  h.pane.handleMouse({ type: "release", button: "left", ...next });
  h.click(next);
  assert.deepEqual(h.closes, []);
  h.click(next);
  assert.deepEqual(h.closes, [true]);
});

test("off respects finite small-height budgets instead of painting unseen controls", (t) => {
  const h = fixture(t);
  for (const width of [12, 20, 40, 120]) {
    h.terminal.columns = width;
    for (let rows = 1; rows <= 24; rows++) {
      h.terminal.rows = rows;
      const lines = h.paint();
      const budget = Math.floor(rows * 0.84);
      assert.ok(lines.length <= budget, `${width}x${rows}: ${lines.length} > ${budget}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (budget < 9) {
        assert.doesNotMatch(lines.join("\n"), /\[S Stop\]|\[M message\]|\[⋯\]/);
        h.pane.handleInput("s");
        h.pane.handleInput("\x13");
        h.pane.handleInput("m");
        h.pane.handleInput("\r");
        assert.deepEqual(h.stops, []);
        assert.deepEqual(h.sent, []);
      }
    }
  }
});

test("the docked form already has content rows and does not gain a second frame", (t) => {
  const h = fixture(t, { enabled: true, frame: false });
  const before = h.paint();
  setBorderLabelsEnabled(false);
  assert.deepEqual(h.paint(), before);
});
