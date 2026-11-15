import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const keys = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "alehouse-detail-height-"));
for (const key of keys) process.env[key] = join(home, key);
test.after(async () => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(home, { recursive: true, force: true });
});

const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const states = [
  ["queued", "queued"],
  ["running", "running"],
  ["cancelling", "cancelling"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["needs_input", "needs input"],
];

function fixture(t, { frame, rows, status = "completed", finalizing = false, commands = false }) {
  const terminal = { columns: 120, rows };
  const view = {
    owner_id: "owner",
    generation: "generation",
    agent_id: "amber",
    run_id: "run-amber",
    name: "amber",
    task: 1,
    description: "Inspect the task",
    status,
    phase: finalizing ? "finalizing" : "executing",
    execution_exited: finalizing || !["queued", "running", "cancelling"].includes(status),
    finalization_pending: finalizing,
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
      cwd: home,
    },
  };
  const stops = [];
  const sent = [];
  const state = {
    count: 80,
    entries: [
      {
        agent_id: view.agent_id,
        input: { view, live: { active_tools: [], tool_uses: 0, preview: "" } },
      },
    ],
  };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    initial: view.agent_id,
    snapshot: () => state.entries,
    transcript: () => ({
      lineCount: () => state.count,
      slice: (_width, from, count) =>
        Array.from({ length: count }, (_, index) => `ROW${from + index}`),
    }),
    done() {},
    ...(commands
      ? {
          onStop: (run) => stops.push(run),
          onSteer: (run, text) => {
            sent.push([run, text]);
            return true;
          },
        }
      : {}),
  });
  t.after(() => pane.dispose());
  return {
    pane,
    terminal,
    state,
    stops,
    sent,
    paint: () => pane.render(120).map(stripTerminalSequences),
  };
}

for (const frame of [false, true]) {
  for (const [status, label] of states) {
    test(`a lone ${status} keeps its bottom state at the old visibility boundary (frame=${frame})`, (t) => {
      const h = fixture(t, { frame, rows: frame ? 7 : 8, status });
      const lines = h.paint();
      assert.match(lines.at(-2), new RegExp(`\\b${label}\\b`), lines.join("\n"));
      assert.ok(!lines[0].includes(label), "the state stays out of the title");
      assert.ok(!lines.at(-1).includes(label), "a single Agent needs no status tab fallback");
      assert.equal(lines.length, 5);
    });
  }

  test(`finishing remains visible without reviving a running turn clock (frame=${frame})`, (t) => {
    const h = fixture(t, { frame, rows: frame ? 7 : 8, status: "running", finalizing: true });
    assert.match(h.paint().at(-2), /finishing/);
    assert.doesNotMatch(h.paint().at(-2), /running|\(\d/);
  });

  test(`the minimal state yields body rows, never overflows a known height (frame=${frame})`, (t) => {
    const h = fixture(t, { frame, rows: 40, status: "failed", commands: true });
    for (let rows = 1; rows <= 14; rows++) {
      h.terminal.rows = rows;
      const lines = h.paint();
      const budget = Math.floor((rows * (frame ? 84 : 70)) / 100);
      if (budget < 3) {
        assert.deepEqual(lines, [], `rows=${rows}: not even title/status/footer fit`);
        continue;
      }
      assert.ok(lines.length <= budget, `rows=${rows}: ${lines.length} > ${budget}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= 120));
      assert.match(lines.at(-2), /failed/, `rows=${rows}: state is the last body row`);
      if (budget < 5) {
        assert.doesNotMatch(lines.at(-1), /\[⋯\]|\[S Stop\]|\[M message\]/);
        h.pane.handleInput("s");
        h.pane.handleInput("\x13");
        h.pane.handleInput("m");
        h.pane.handleInput("unpainted");
        h.pane.handleInput("\r");
        assert.deepEqual(h.stops, []);
        assert.deepEqual(h.sent, []);
      }
    }
  });

  test(`relative scroll with no viewport preserves reading and following intent (frame=${frame})`, (t) => {
    const actions = [
      ...["\x1b[A", "\x1b[B", "j", "k", "\x1b[5~", "\x1b[6~", "\x1b[1;2A", "\x1b[1;2B"].map(
        (key) => [key, (pane) => pane.handleInput(key)],
      ),
      ["wheel up", (pane) => pane.handleMouse({ type: "wheel", wheelDelta: -1 })],
      ["wheel down", (pane) => pane.handleMouse({ type: "wheel", wheelDelta: 1 })],
    ];
    for (const following of [true, false]) {
      for (const [name, act] of actions) {
        const h = fixture(t, { frame, rows: 40 });
        h.paint();
        if (!following) {
          h.pane.handleInput("\x1b[H");
          assert.ok(h.paint().some((line) => /\bROW0\b/.test(line)));
        }
        h.terminal.rows = frame ? 4 : 5; // only title/status/footer, no body rows
        assert.ok(!h.paint().some((line) => /\bROW\d+\b/.test(line)));
        act(h.pane);
        h.terminal.rows = 40;
        h.paint();
        // Merely landing at the old tail after resize is insufficient: new
        // transcript rows must still follow if no visible scrolling occurred.
        h.state.count += 5;
        const grown = h.paint();
        assert.ok(
          grown.some((line) => (following ? /\bROW84\b/ : /\bROW0\b/).test(line)),
          `${name}, following=${following}: ${grown.join("\n")}`,
        );
      }
    }
  });

  test(`Home and End remain explicit choices with no viewport (frame=${frame})`, (t) => {
    const h = fixture(t, { frame, rows: 40 });
    h.paint();
    h.terminal.rows = frame ? 4 : 5;
    h.paint();
    h.pane.handleInput("\x1b[H");
    h.terminal.rows = 40;
    assert.ok(h.paint().some((line) => /\bROW0\b/.test(line)));
    h.terminal.rows = frame ? 4 : 5;
    h.paint();
    h.pane.handleInput("\x1b[F");
    h.state.count += 5;
    h.terminal.rows = 40;
    assert.ok(h.paint().some((line) => /\bROW84\b/.test(line)));
  });

  test(`an emptied roster does not paint an inert menu control (frame=${frame})`, (t) => {
    const h = fixture(t, { frame, rows: 40 });
    assert.match(h.paint().at(-1), /\[⋯\]/);
    h.state.entries.length = 0;
    const empty = h.paint();
    assert.ok(empty.some((line) => line.includes("No agents are available to inspect.")));
    assert.doesNotMatch(empty.at(-1), /\[⋯\]/);
    h.pane.handleInput(".");
    assert.deepEqual(h.paint(), empty);
  });

  test(`shrinking a running pane preserves the five-row command floor (frame=${frame})`, (t) => {
    const h = fixture(t, { frame, rows: 40, status: "running", commands: true });
    h.paint();
    h.terminal.rows = frame ? 5 : 7; // four-row budget, below existing admission floor
    const lines = h.paint();
    assert.equal(lines.length, 4);
    assert.match(lines.at(-2), /running/);
    assert.doesNotMatch(lines.at(-1), /\[S Stop\]|\[M message\]|\[⋯\]/);
    h.pane.handleInput("s");
    h.pane.handleInput("\x13");
    h.pane.handleInput("m");
    h.pane.handleInput("draft");
    h.pane.handleInput("\r");
    assert.deepEqual(h.stops, []);
    assert.deepEqual(h.sent, []);
    h.terminal.rows = 40;
    assert.match(h.paint().at(-1), /\[S Stop\]/, "fresh full paint restores normal controls");
  });
}
