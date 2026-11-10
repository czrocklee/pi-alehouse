import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane } from "../../dist/orchestration/ui/agent-detail.js";
import { renderDetailFooter } from "../../dist/orchestration/ui/agent-detail-fields.js";
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
const footer = (overrides = {}) =>
  renderDetailFooter({
    width: 120,
    position: 1,
    count: 2,
    shown: 20,
    total: 200,
    view: view({ runtime: { activity: "generating", context: context() } }),
    available: false,
    confirming: false,
    spinnerFrame: 0,
    theme,
    framed: false,
    ...overrides,
  });

for (const [tokens, expected] of [
  [45000, "ctx ≈45k/500k"],
  [null, "ctx ?/500k"],
  [0, "ctx ≈0/500k"],
]) {
  test(`detail footer renders current context as ${expected} without changing the snapshot`, () => {
    const current = view({ runtime: { activity: "generating", context: context(tokens) } });
    const before = structuredClone(current);
    const rendered = footer({ view: current });
    assert.match(rendered.text, /^⠋ running · ctx /);
    assert.ok(rendered.text.includes(expected), rendered.text);
    assert.ok(rendered.text.indexOf(expected) < rendered.text.indexOf("1/2 agents"));
    assert.match(rendered.text, /20\/200 lines/);
    assert.match(rendered.text, /←→ agent · ↑↓ scroll · Esc close$/);
    assert.ok(visibleWidth(rendered.text) <= 120);
    assert.deepEqual(current, before, "formatting is a read-only projection");
  });
}

test("absent context preserves the previous footer, not an invented zero or unknown", () => {
  const left = "⠋ running · 1/2 agents · 20/200 lines";
  const right = "←→ agent · ↑↓ scroll · Esc close";
  const expected = left + " ".repeat(120 - visibleWidth(left) - visibleWidth(right)) + right;
  for (const current of [view(), view({ runtime: { activity: "generating" } })]) {
    assert.deepEqual(footer({ view: current }), { text: expected });
  }
  const empty = footer({ view: undefined, count: 0 });
  assert.match(empty.text, /^no agents/);
  assert.doesNotMatch(empty.text, /ctx/);
});

test("context yields after status but before agent and line counters under width pressure", () => {
  const rendered = footer({ width: 40 });
  assert.match(rendered.text, /^⠋ running · ctx ≈45k\/500k/);
  assert.doesNotMatch(rendered.text, /agents|lines/);
  assert.ok(visibleWidth(rendered.text) <= 40);
  for (const width of [22, 14, 8]) {
    const tight = footer({ width });
    assert.match(tight.text, /^⠋ (?:running|run)/);
    assert.doesNotMatch(tight.text, /ctx|agents|lines|…/);
    assert.ok(visibleWidth(tight.text) <= width);
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
  test(`context persists offscreen while scrolling and following the transcript (frame=${frame})`, (t) => {
    const h = paneFixture(t, frame);
    const check = (last) => {
      const lines = h.paint();
      assert.match(lines.at(-1), /ctx ≈45k\/500k/);
      assert.ok(lines.at(-2).includes(last), lines.at(-2));
      assert.doesNotMatch(lines.slice(1, -1).join("\n"), /context\s/);
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
    assert.match(h.paint().at(-1), /ctx ≈45k\/500k/);
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
    assert.match(h.paint().at(-1), /ctx ≈90k\/500k/);
    h.pane.handleInput("\u001b[C");
    assert.match(h.paint().at(-1), /ctx ≈12k\/200k/);
    assert.doesNotMatch(h.paint().at(-1), /500k/);
    h.pane.handleInput("\u001b[C");
    assert.doesNotMatch(h.paint().at(-1), /ctx/);
    h.pane.handleInput("\u001b[D");
    assert.match(h.paint().at(-1), /ctx ≈12k\/200k/);
    h.replace([]);
    assert.doesNotMatch(h.paint().at(-1), /ctx/);
    assert.deepEqual(entries, before);
  });

  for (const fits of [false, true]) {
    const width = (frame ? 62 : 56) - (fits ? 0 : 1);
    test(`context never displaces protected Stop confirmation (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, frame, { width, onStop: (id) => stopped.push(id) });
      const initial = h.paint();
      assert.ok(initial.every((line) => visibleWidth(line) <= width));
      assert.match(initial.at(-1), /⠋ (?:running|run)/);
      if (!fits) {
        assert.doesNotMatch(initial.at(-1), /\[S Stop\]/);
        h.pane.handleInput("s");
        h.paint();
        h.pane.handleInput("\x13");
        assert.deepEqual(stopped, []);
        return;
      }
      assert.match(initial.at(-1), /\[S Stop\]/);
      h.pane.handleInput("s");
      const armed = h.paint();
      assert.equal(armed.length, initial.length);
      assert.match(armed.at(-1), /⠋ run/);
      assert.match(armed.at(-1), /best-effort · Ctrl\+S · Esc cancel · \[Confirm stop\]/);
      assert.doesNotMatch(armed.at(-1), /ctx|agents|lines/);
      assert.ok(armed.every((line) => visibleWidth(line) <= width));
      h.pane.handleInput("\x13");
      assert.deepEqual(stopped, ["run-a"]);
    });
  }
}
