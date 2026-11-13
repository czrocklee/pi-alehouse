import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

// Direct source import: this regression must not depend on a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const settings = {
  provider: "fixture",
  model: "controlled",
  thinking: "off",
  parent_thinking: "off",
  thinking_resolution: "identity",
  profile: "editor",
  difficulty: 3,
  strength: "d3",
  preset: "fixture",
  preset_version: "v1",
  selection_digest: "2".repeat(64),
  cwd: "/tmp",
  tools: ["read"],
  definition_digest: "1".repeat(64),
};
const live = { active_tools: [], tool_uses: 0, preview: "" };
const view = (agent_id) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  task: 1,
  description: `Task ${agent_id}`,
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
});
const entries = ["p0", "p1", "p2"].map((id) => ({
  agent_id: id,
  input: { view: view(id), live },
}));

function fixture(t, { width = 120, visible } = {}) {
  const tui = { terminal: { columns: width, rows: 40 }, requestRender() {} };
  const selections = [];
  const pane = new DetailPane({
    tui,
    theme,
    initial: "p0",
    done() {},
    snapshot: () => entries,
    onSelect: (id) => selections.push(id),
    transcript: () => undefined,
    visible,
  });
  t.after(() => pane.dispose());
  const paint = (w = tui.terminal.columns) => pane.render(w);
  const locate = (label, lines = paint()) => {
    const y = lines.findIndex((line) => line.includes(label));
    assert.ok(y >= 0, `missing ${label}`);
    return { x: visibleWidth(lines[y].slice(0, lines[y].indexOf(label))), y };
  };
  const press = (x, y) => pane.handleMouse({ type: "press", button: "left", x, y });
  const click = (x, y) => pane.handleMouse({ type: "click", button: "left", x, y });
  return { pane, tui, selections, paint, locate, press, click };
}

test("a painted chrome press is claimed; only the click activates", (t) => {
  const h = fixture(t);
  const arrow = h.locate("›");
  assert.deepEqual(h.press(arrow.x, arrow.y), { handled: true });
  assert.deepEqual(h.selections, [], "press alone never navigates");
  assert.deepEqual(h.click(arrow.x, arrow.y), { handled: true });
  assert.deepEqual(h.selections, ["p1"]);
  // A repeated rapid click navigates again: activation is per click.
  const fresh = h.locate("›");
  h.click(fresh.x, fresh.y);
  assert.deepEqual(h.selections, ["p1", "p2"]);
});

test("presses over the body keep ordinary selection behavior", (t) => {
  const h = fixture(t);
  h.paint();
  assert.equal(h.press(2, 2), undefined, "a non-control press is not claimed");
  assert.equal(h.click(2, 2), undefined, "a non-control click is not claimed");
  assert.deepEqual(h.selections, []);
});

test("stale geometry voids painted chrome hits", (t) => {
  const h = fixture(t);
  const arrow = h.locate("›");
  h.tui.terminal.columns = 100; // Resize without an intervening repaint.
  assert.equal(h.press(arrow.x, arrow.y), undefined);
  assert.equal(h.click(arrow.x, arrow.y), undefined);
  assert.deepEqual(h.selections, []);
  const fresh = h.locate("›");
  assert.deepEqual(h.click(fresh.x, fresh.y), { handled: true });
  assert.deepEqual(h.selections, ["p1"]);
});

test("a mid-gesture page transition voids the painted chrome target", (t) => {
  const h = fixture(t);
  const arrow = h.locate("›");
  assert.deepEqual(h.press(arrow.x, arrow.y), { handled: true });
  h.pane.handleInput("i"); // The page flips before the release.
  assert.equal(h.click(arrow.x, arrow.y), undefined);
  assert.deepEqual(h.selections, []);
  const fresh = h.locate("›");
  assert.deepEqual(h.click(fresh.x, fresh.y), { handled: true });
  assert.deepEqual(h.selections, ["p1"]);
});

test("a hidden pane never claims or activates chrome", (t) => {
  let shown = true;
  const h = fixture(t, { visible: () => shown });
  const arrow = h.locate("›");
  shown = false; // Permission yield hides the mounted pane without disposing it.
  assert.equal(h.press(arrow.x, arrow.y), undefined);
  assert.equal(h.click(arrow.x, arrow.y), undefined);
  assert.deepEqual(h.selections, []);
  shown = true;
  const fresh = h.locate("›");
  assert.deepEqual(h.click(fresh.x, fresh.y), { handled: true });
  assert.deepEqual(h.selections, ["p1"]);
});
