import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
  Container,
  Text,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { PresetModelPopover } = await jiti.import(
  "../../src/orchestration/ui/preset-model-popover.ts",
);
const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
const transcript = ["Copyable first line", "Second body line", "Last transcript line"];

// Controlled pinned SDK compositor/input/clipboard callback only: no real TTY,
// provider, credentials, OS clipboard or human interaction is exercised.
function fixture(t, kind, borderLabels, { scrollable = false, nonCapturing = false } = {}) {
  setBorderLabelsEnabled(borderLabels);
  const terminal = { columns: 110, rows: 50, write() {}, hideCursor() {} };
  const copies = [],
    actions = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copySelection: async (text) => {
      copies.push(text);
      return true;
    },
  });
  tui.requestRender = () => {};
  tui.setLayoutRoot({
    render: () => Array(50).fill("BACKGROUND ".repeat(10)),
    invalidate() {},
  });
  let panel, first, last;
  if (kind === "Agents") {
    const body = scrollable
      ? [
          ...transcript,
          ...Array.from({ length: 60 }, (_, index) => `Extra transcript row ${index}`),
        ]
      : transcript;
    const view = {
      owner_id: "owner",
      generation: "generation",
      agent_id: "worker",
      run_id: "run-worker",
      name: "worker",
      task: 1,
      description: "Fixture task",
      status: "completed",
      phase: "settled",
      execution_exited: true,
      finalization_pending: false,
      turns: 1,
      elapsed_ms: 100,
      cleanup_errors: [],
      discarded_inputs: [],
      effective_settings: {
        profile: "editor",
        model: "fixture/model",
        thinking: "off",
        tools: [],
      },
    };
    panel = new DetailPane({
      tui,
      theme,
      frame: true,
      initial: "worker",
      done: () => actions.push("close"),
      snapshot: () => [{ agent_id: "worker", input: { view } }],
      transcript: () => ({
        lineCount: () => body.length,
        slice: (_width, start, count) => body.slice(start, start + count),
      }),
    });
    first = transcript[0];
    last = transcript[2];
  } else if (kind === "Delegation") {
    panel = new PresetPicker({
      tui,
      theme,
      pointer: true,
      presets: [{ name: "off", version: "off-v1", digest: "f".repeat(64) }],
      activeName: "off",
      keybindings: { matches: () => false },
      done: (choice) => actions.push(choice),
      delegation: {
        current: () => ({ mode: "co-worker", eagerness: "balanced" }),
        set: () => actions.push("setting"),
        guideline: () => "Copyable guideline. ".repeat(12),
      },
    });
    first = "Copyable guideline.";
    last = first;
  } else {
    const native = new Container();
    native.addChild(new Text("> fixture search", 0, 0));
    const list = new Container();
    list.addChild(new Text("→   model [fixture]", 0, 0));
    native.addChild(list);
    native.handleInput = () => {};
    native.dispose = () => {};
    panel = new PresetModelPopover({
      tui,
      theme,
      native,
      title: "Model",
      height: () => 16,
      models: () => [{ id: "model", name: "model", provider: "fixture", api: "test" }],
      select: () => actions.push("model"),
      cancel: () => actions.push("close"),
    });
    first = "New Agents only; main unchanged";
    last = "> fixture search";
  }
  const handle = tui.showOverlay(panel, { row: 3, col: 7, width: 80, nonCapturing });
  tui.beforeTerminalStart();
  t.after(() => {
    panel.dispose();
    handle.hide();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
    setBorderLabelsEnabled(true);
  });
  const paint = () => tui.doRender();
  paint();
  if (scrollable) {
    tui.handleTerminalInput("\x1b[H");
    paint();
  }
  const bounds = handle.getBounds();
  assert(bounds);
  const lines = tui.getScreenLines().map(stripTerminalSequences);
  const top = lines.findIndex((line) => line.includes(first));
  const bottom =
    kind === "Delegation"
      ? lines.findLastIndex((line) => line.includes(last))
      : lines.findIndex((line) => line.includes(last));
  assert(top >= 0 && bottom > top, `${kind} must paint at least two selectable text rows`);
  const start = { x: lines[top].indexOf(first), y: top };
  const end = { x: lines[bottom].trimEnd().length - 2, y: bottom };
  const pointer = (type, point) =>
    tui.handleTerminalInput(
      `\x1b[<${type === "drag" ? 32 : 0};${point.x + 1};${point.y + 1}${type === "release" ? "m" : "M"}`,
    );
  return { tui, panel, handle, copies, actions, bounds, paint, pointer, start, end };
}

function assertHighlightInside(h) {
  let highlighted = 0;
  for (const [row, line] of h.tui.getScreenLines().entries()) {
    const begin = line.indexOf("\x1b[7m");
    if (begin < 0) continue;
    highlighted++;
    const end = line.lastIndexOf("\x1b[27m");
    assert(end > begin);
    const from = visibleWidth(line.slice(0, begin));
    const to = visibleWidth(line.slice(0, end));
    assert(row >= h.start.y && row <= h.end.y);
    assert(from > h.bounds.col, "left frame/background must not be highlighted");
    assert(to < h.bounds.col + h.bounds.width, "right frame/background must not be highlighted");
  }
  assert(highlighted >= 2, "multiple actual screen rows must be highlighted");
}

for (const kind of ["Agents", "Delegation", "Model"])
  for (const borderLabels of [true, false])
    test(`${kind}: shared body selection bounds native highlight and copy (labels=${borderLabels})`, async (t) => {
      const h = fixture(t, kind, borderLabels);
      if (kind === "Agents")
        assert.equal(
          h.start.x,
          h.bounds.col + 2,
          "transcript begins after frame and one gutter cell",
        );
      h.pointer("press", h.start);
      h.pointer("drag", h.end);
      h.paint();
      assertHighlightInside(h);
      h.pointer("release", h.end);
      await Promise.resolve();
      assert.equal(h.copies.length, 1, "native copy-on-select path must run");
      const copied = h.copies[0];
      assert(copied.includes("\n"));
      assert(!/BACKGROUND|[│┃╭╮╰╯✕]/u.test(copied), copied);
      if (kind === "Agents") assert.equal(copied, transcript.join("\n"));
      assert.deepEqual(h.actions, [], "selecting text must not activate a control");
    });

test("Model: clicking title chrome still gives a passive chooser keyboard focus", async (t) => {
  const h = fixture(t, "Model", true, { nonCapturing: true });
  assert.equal(h.handle.isFocused(), false);
  const title = { x: h.bounds.col + 10, y: h.bounds.row };
  h.pointer("press", title);
  h.pointer("release", title);
  assert.equal(h.handle.isFocused(), true, "native click dispatch still transfers focus");
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.deepEqual(h.actions, [], "focusing chrome cannot apply a model");
  assert.deepEqual(h.copies, []);
});

test("Agents: actual transcript scrolling cancels selection before release or copy", async (t) => {
  const h = fixture(t, "Agents", true, { scrollable: true });
  h.pointer("press", h.start);
  h.pointer("drag", h.end);
  assert.equal(h.tui.hasActiveSelection(), true);
  h.tui.handleTerminalInput("\x1b[B");
  h.paint();
  assert(
    !h.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes(transcript[0])),
    "Down must actually move away from the first transcript row",
  );
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  h.pointer("release", h.end);
  assert.deepEqual(h.copies, []);
});

test("Agents: page navigation retires native text selection", async (t) => {
  const h = fixture(t, "Agents", true);
  h.pointer("press", h.start);
  h.pointer("drag", h.end);
  assert.equal(h.tui.hasActiveSelection(), true);
  h.panel.handleInput("i");
  assert.equal(h.tui.hasActiveSelection(), false);
  assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
  assert.deepEqual(h.copies, []);
});
