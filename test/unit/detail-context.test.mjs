import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane } from "../../dist/orchestration/ui/agent-detail.js";
import {
  renderDetailFooter,
  renderDetailSummary,
} from "../../dist/orchestration/ui/agent-detail-fields.js";
import { settings } from "../support/controller-fixture.mjs";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const context = (tokens = 45000) => ({ tokens, context_window: 500000 });
const view = (overrides = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: "a",
  run_id: "run-a",
  name: "a",
  description: "Context footer fixture",
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resumable: true,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 0,
  turns: 1,
  max_turns: 8,
  cleanup_errors: [],
  discarded_inputs: [],
  ...overrides,
});
const live = { active_tools: [], tool_uses: 0, preview: "" };
const entryOf = (current) => ({ agent_id: current.agent_id, input: { view: current, live } });
const footer = (overrides = {}) => {
  const current =
    "view" in overrides
      ? overrides.view
      : view({ runtime: { activity: "generating", context: context() } });
  return renderDetailFooter({
    width: 120,
    entries: current
      ? [entryOf(current), entryOf(view({ agent_id: "b", run_id: "run-b", name: "b" }))]
      : [],
    selected: "a",
    below: 0,
    view: current,
    available: false,
    confirming: false,
    spinnerFrame: 0,
    theme,
    framed: false,
    ...overrides,
  });
};

for (const [tokens, expected] of [
  [45000, "ctx ≈45k/500k"],
  [null, "ctx ?/500k"],
  [0, "ctx ≈0/500k"],
]) {
  test(`the bottom dock renders current context as ${expected} without changing the snapshot`, () => {
    const current = view({ runtime: { activity: "generating", context: context(tokens) } });
    const before = structuredClone(current);
    const [metrics] = renderDetailSummary({ view: current, live }, theme, 120, {
      activity: false,
    });
    assert.ok(metrics.includes(expected), metrics);
    assert.doesNotMatch(metrics, /≈\S+ \d+%/, "and never paints a context percent");
    // The edge is navigation and actions only: it never repeats the figure.
    const rendered = footer({ view: current });
    assert.doesNotMatch(rendered.text, /ctx|agents|lines|running/);
    assert.ok(visibleWidth(rendered.text) <= 120);
    assert.deepEqual(current, before, "formatting is a read-only projection");
  });
}

test("absent context is not invented as zero or unknown", () => {
  for (const current of [view(), view({ runtime: { activity: "generating" } })]) {
    const [metrics] = renderDetailSummary({ view: current, live }, theme, 120, {
      activity: false,
    });
    assert.doesNotMatch(metrics, /\?\/\d|≈\d/);
    assert.doesNotMatch(footer({ view: current }).text, /ctx/);
  }
  const empty = footer({ view: undefined });
  assert.doesNotMatch(empty.text, /ctx|agents/);
  assert.deepEqual(empty.tabs, []);
});

test("the edge carries no counters, status or context at any width", () => {
  for (const width of [120, 40, 32, 26, 14, 8]) {
    const rendered = footer({ width });
    assert.doesNotMatch(rendered.text, /ctx|agents|lines|\d+\/\d+|run/);
    assert.ok(visibleWidth(rendered.text) <= width);
  }
});

function paneFixture(t, frame, { width = 120, onStop } = {}) {
  let entries = [
    {
      agent_id: "a",
      input: { view: view({ runtime: { activity: "generating", context: context() } }), live },
    },
  ];
  const rows = {
    count: 200,
    lineCount() {
      return this.count;
    },
    slice(_width, start, take) {
      return Array.from(
        { length: Math.max(0, Math.min(take, this.count - start)) },
        (_, i) => `T${start + i}`,
      );
    },
    invalidate() {},
  };
  const pane = new DetailPane({
    tui: { terminal: { columns: width, rows: 30 }, requestRender() {} },
    theme,
    frame,
    initial: "a",
    done() {},
    onStop,
    snapshot: () => entries,
    transcript: () => rows,
  });
  t.after(() => pane.dispose());
  return {
    pane,
    rows,
    paint: () => pane.render(width),
    replace: (next) => {
      entries = next;
    },
  };
}

for (const frame of [false, true]) {
  test(`context stays pinned while scrolling and following the transcript (frame=${frame})`, (t) => {
    const h = paneFixture(t, frame);
    const check = (last) => {
      const lines = h.paint();
      // The one bottom dock row never scrolls away.
      assert.match(lines.at(-2), /ctx ≈45k\/500k/);
      assert.doesNotMatch(lines.at(-1), /ctx/);
      assert.ok(lines.at(-4).includes(last), lines.at(-4));
      assert.doesNotMatch(lines.slice(1, -3).join("\n"), /context\s/);
      assert.ok(lines.every((line) => visibleWidth(line) <= 120));
      return lines.length;
    };
    const height = check("T199");
    h.rows.count += 30;
    assert.equal(check("T229"), height, "tail growth does not add footer rows");
    h.pane.handleInput("\u001b[A");
    check("T228");
    h.rows.count += 30;
    check("T228");
    h.pane.handleMouse({ type: "wheel", wheelDelta: -4 });
    check("T224");
    h.pane.handleInput("\u001b[F");
    check("T259");
  });

  test(`context refresh and Agent selection use the currently selected snapshot (frame=${frame})`, (t) => {
    const h = paneFixture(t, frame);
    const metrics = () => h.paint().at(-2);
    assert.match(metrics(), /ctx ≈45k\/500k/);
    const entries = [
      {
        agent_id: "a",
        input: {
          view: view({ runtime: { activity: "generating", context: context(90000) } }),
          live,
        },
      },
      {
        agent_id: "b",
        input: {
          view: view({
            agent_id: "b",
            run_id: "run-b",
            runtime: { activity: "generating", context: { tokens: 12000, context_window: 200000 } },
          }),
          live,
        },
      },
      { agent_id: "c", input: { view: view({ agent_id: "c", run_id: "run-c" }), live } },
    ];
    const before = structuredClone(entries);
    h.replace(entries);
    assert.match(metrics(), /ctx ≈90k\/500k/);
    h.pane.handleInput("\u001b[C");
    assert.match(metrics(), /ctx ≈12k\/200k/);
    assert.doesNotMatch(h.paint().join("\n"), /500k/);
    h.pane.handleInput("\u001b[C");
    assert.doesNotMatch(h.paint().join("\n"), /≈\d+[kM]?\//);
    h.pane.handleInput("\u001b[D");
    assert.match(metrics(), /ctx ≈12k\/200k/);
    h.replace([]);
    assert.doesNotMatch(h.paint().join("\n"), /ctx/);
    assert.deepEqual(entries, before);
  });

  for (const fits of [false, true]) {
    // A lone Agent's edge needs only the 48-column confirmation (+6 framed).
    const width = (frame ? 54 : 48) - (fits ? 0 : 1);
    test(`context never displaces protected Stop confirmation (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, frame, { width, onStop: (id) => stopped.push(id) });
      const initial = h.paint();
      assert.ok(initial.every((line) => visibleWidth(line) <= width));
      assert.match(initial.at(-2), /⠋ · /, "the dock carries the live glyph");
      assert.doesNotMatch(initial.at(-2), /running/, "normal running work is glyph-only");
      if (!fits) {
        assert.doesNotMatch(initial.at(-1), /\bstop\b/);
        h.pane.handleInput("s");
        h.paint();
        h.pane.handleInput("\x13");
        assert.deepEqual(stopped, []);
        return;
      }
      assert.match(initial.at(-1), /\bstop\b/);
      h.pane.handleInput("s");
      const armed = h.paint();
      assert.equal(armed.length, initial.length);
      assert.match(armed.at(-2), /⠋ · /, "the sticky dock keeps the live glyph");
      assert.match(armed.at(-1), /best-effort · Ctrl\+S · Esc cancel · confirm stop/);
      assert.doesNotMatch(armed.at(-1), /ctx|agents|lines/);
      assert.ok(armed.every((line) => visibleWidth(line) <= width));
      h.pane.handleInput("\x13");
      assert.deepEqual(stopped, ["run-a"]);
    });
  }
}
