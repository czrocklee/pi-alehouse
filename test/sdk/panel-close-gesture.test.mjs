import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { Container, Text, TuiAltScreen, stripTerminalSequences } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");
const { PresetModelPopover } = await jiti.import(
  "../../src/orchestration/ui/preset-model-popover.ts",
);

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const model = { id: "model", name: "model", provider: "fixture", api: "test" };

// Real pinned compositor and raw SGR input with a fake terminal and synthetic
// panel data, not a started TTY/session/provider or real OS focus event. Keep
// callbacks mounted so the actual synthetic-click dispatch can also be checked.
function fixture(t, kind, { compose = false } = {}) {
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  tui.setLayoutRoot({ render: () => Array(45).fill("Transcript"), invalidate() {} });
  const closes = [],
    selections = [],
    drafts = [],
    stops = [],
    steers = [],
    events = [];
  const done = () => closes.push(true);
  let panel;
  if (kind === "Agents") {
    panel = new DetailPane({
      tui,
      theme,
      frame: true,
      initial: "worker",
      done,
      onSelect: (id) => selections.push(id),
      onStop: (id) => stops.push(id),
      onSteer: compose
        ? (id, text) => {
            steers.push({ id, text });
            return true;
          }
        : undefined,
      onDraft: (draft) => drafts.push(draft),
      snapshot: () =>
        ["worker", "peer"].map((id) => ({
          agent_id: id,
          input: {
            view: {
              owner_id: "owner",
              generation: "generation",
              agent_id: id,
              run_id: `run-${id}`,
              name: id,
              task: 1,
              description: "Fixture task",
              status: compose ? "running" : "completed",
              phase: compose ? "executing" : "settled",
              execution_exited: !compose,
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
            },
            live: { active_tools: [], tool_uses: 0, preview: "" },
          },
        })),
      transcript: () => undefined,
    });
  } else if (kind === "Delegation") {
    panel = new PresetPicker({
      tui,
      theme,
      pointer: true,
      presets: [{ name: "off", version: "off-v1", digest: "f".repeat(64) }],
      activeName: "off",
      keybindings: { matches: () => false },
      done: (choice) => (choice === null ? done() : selections.push(choice)),
    });
  } else {
    const native = new Container(),
      list = new Container();
    list.addChild(new Text("→   model [fixture]", 0, 0));
    native.addChild(new Text("> search", 0, 0));
    native.addChild(list);
    native.handleInput = () => {};
    native.dispose = () => {};
    panel = new PresetModelPopover({
      tui,
      theme,
      native,
      title: "Model",
      height: () => 16,
      models: () => [model],
      select: (selected) => selections.push(selected),
      cancel: done,
    });
  }
  const handleMouse = panel.handleMouse;
  panel.handleMouse = function (event) {
    const result = handleMouse.call(this, event);
    events.push({ event, result });
    return result;
  };
  const handle = tui.showOverlay(panel, { anchor: "top-left", row: 2, col: 5, width: 80 });
  tui.beforeTerminalStart();
  t.after(() => {
    panel.dispose();
    handle.hide();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => tui.doRender();
  paint();
  const bounds = handle.getBounds();
  assert(bounds);
  const x = bounds.col + bounds.width - 4,
    y = bounds.row;
  const input = (data) => {
    const before = events.length;
    tui.handleTerminalInput(data);
    return events.slice(before);
  };
  const pointer = (type, atX = x, atY = y, button = 0) =>
    input(
      `\x1b[<${type === "drag" ? button | 32 : type === "move" ? 35 : button};${atX + 1};${atY + 1}${type === "release" ? "m" : "M"}`,
    );
  const reset = () => {
    if (kind === "Agents") panel.resetCloseHover(false);
    else if (kind === "Delegation") panel.invalidatePointerPaint();
    else panel.invalidate();
  };
  const bodyTarget = () => {
    // Locate actual painted public labels, not private consumer hit maps.
    const lines = panel.render(bounds.width).map(stripTerminalSequences);
    const label = kind === "Agents" ? "peer" : kind === "Delegation" ? "off" : "model";
    const row = lines.findIndex(
      (line) => line.includes(label) && (kind !== "Delegation" || line.includes("›")),
    );
    assert(row > 0, `a real ${kind} body target must be painted`);
    return { x: lines[row].indexOf(label), y: row };
  };
  const startDraft = () => {
    input("m");
    input("synthetic unsent draft");
    assert.equal(drafts.at(-1)?.text, "synthetic unsent draft");
    assert.equal(drafts.length, 1);
    paint();
  };
  return {
    kind,
    panel,
    terminal,
    tui,
    closes,
    selections,
    drafts,
    stops,
    steers,
    events,
    x,
    y,
    pointer,
    input,
    paint,
    reset,
    bodyTarget,
    startDraft,
  };
}

function dispatched(events, type) {
  const found = events.find(({ event }) => event.type === type);
  assert(found, `the native compositor must dispatch ${type}`);
  return found;
}

function assertNoBodyAction(h) {
  assert.deepEqual(h.selections, []);
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.steers, []);
}

function assertClosingDispatch(h, events) {
  assert.equal(dispatched(events, "release").result?.handled, true);
  const click = dispatched(events, "click");
  assert.equal(click.event.button, "left");
  if (h.kind === "Delegation")
    assert.equal(click.result, undefined, "the settled picker rejects further mouse input");
  else assert.equal(click.result?.handled, true, "the trailing click is consumed");
}

function freshClose(h) {
  h.pointer("press");
  const events = h.pointer("release");
  assertClosingDispatch(h, events);
  assert.deepEqual(h.closes, [true], "a fresh close gesture still closes exactly once");
  assertNoBodyAction(h);
}

for (const kind of ["Agents", "Delegation", "Model"]) {
  for (const paintBeforeRelease of [false, true])
    test(`${kind}: close release consumes once and native click dispatch is checked (repaint=${paintBeforeRelease})`, (t) => {
      const h = fixture(t, kind);
      h.pointer("press");
      assert.deepEqual(h.closes, [], "press alone never closes");
      assert.equal(h.tui.hasActiveSelection(), false, "close press is not text selection");
      if (paintBeforeRelease) h.paint();
      h.pointer("drag"); // Same-cell motion preserves both repaint variants.
      const released = h.pointer("release");
      assertClosingDispatch(h, released);
      assert.deepEqual(h.closes, [true]);
      assertNoBodyAction(h);
    });

  for (const offset of [-1, 1, 2, 3])
    test(`${kind}: adjacent title cell ${offset} never closes`, (t) => {
      const h = fixture(t, kind);
      h.pointer("press", h.x + offset);
      h.pointer("release", h.x + offset);
      assert.deepEqual(h.closes, []);
      assertNoBodyAction(h);
    });

  for (const offset of [-1, 1])
    test(`${kind}: releasing into neighboring cell ${offset} cancels closing`, (t) => {
      const h = fixture(t, kind);
      h.pointer("press");
      assert.equal(dispatched(h.pointer("release", h.x + offset), "release").result?.handled, true);
      assert.deepEqual(h.closes, []);
      assertNoBodyAction(h);
    });

  test(`${kind}: an unmoved release and its synthetic click close exactly once`, (t) => {
    const h = fixture(t, kind);
    freshClose(h);
  });

  test(`${kind}: dragging outside then back cannot revive closing`, (t) => {
    const h = fixture(t, kind);
    h.pointer("press");
    h.pointer("drag", h.x - 4);
    h.pointer("drag");
    assert.equal(dispatched(h.pointer("release"), "release").result?.handled, true);
    assert.deepEqual(h.closes, []);
    assertNoBodyAction(h);
    freshClose(h);
  });

  test(`${kind}: release on a different row is consumed without closing`, (t) => {
    const h = fixture(t, kind);
    h.pointer("press");
    assert.equal(dispatched(h.pointer("release", h.x, h.y + 1), "release").result?.handled, true);
    assert.deepEqual(h.closes, []);
    assertNoBodyAction(h);
  });

  test(`${kind}: reset and repaint do not reactivate an old close gesture`, (t) => {
    const h = fixture(t, kind);
    h.pointer("press");
    h.reset();
    h.paint();
    h.pointer("release");
    assert.deepEqual(h.closes, []);
    assertNoBodyAction(h);
    freshClose(h);
  });

  test(`${kind}: terminal resize before repaint voids the old close target`, (t) => {
    const h = fixture(t, kind);
    h.pointer("press");
    h.terminal.columns--;
    h.pointer("release");
    assert.deepEqual(h.closes, []);
    assertNoBodyAction(h);
  });

  for (const cancelled of [false, true])
    test(`${kind}: native button-3 release ${cancelled ? "cannot revive a cancelled close" : "closes once"}`, (t) => {
      const h = fixture(t, kind);
      h.pointer("press");
      if (cancelled) {
        h.pointer("drag", h.x - 1);
        h.pointer("drag");
      }
      const events = h.pointer("release", h.x, h.y, 3);
      assert.equal(dispatched(events, "release").event.button, "none");
      assert.equal(dispatched(events, "release").result?.handled, true);
      assert.deepEqual(h.closes, cancelled ? [] : [true]);
      // The unmoved native echo uses the release's button, not a fabricated left click.
      if (!cancelled) assert.equal(dispatched(events, "click").event.button, "none");
      assertNoBodyAction(h);
    });

  test(`${kind}: structural cancelled release and click cannot activate a verified body target`, (t) => {
    const positive = fixture(t, kind);
    const target = positive.bodyTarget();
    assert.equal(
      positive.panel.handleMouse({ type: "click", button: "left", ...target })?.handled,
      true,
    );
    assert.deepEqual(
      positive.selections,
      [kind === "Agents" ? "peer" : kind === "Delegation" ? "off" : model],
      "the fresh body click must really invoke its callback",
    );
    assert.deepEqual(positive.closes, []);

    // Structural compatibility events, deliberately separate from native SGR.
    const h = fixture(t, kind),
      body = h.bodyTarget();
    assert.deepEqual(body, target);
    h.panel.handleMouse({ type: "press", button: "left", x: 76, y: 0 });
    h.panel.handleMouse({ type: "drag", button: "left", x: 75, y: 0 });
    assert.equal(
      h.panel.handleMouse({ type: "release", button: "left", ...body })?.handled,
      true,
      "the claimed cancelled release cannot fall through",
    );
    assert.equal(
      h.panel.handleMouse({ type: "click", button: "left", ...body })?.handled,
      true,
      "the structural trailing click must also be consumed",
    );
    assert.deepEqual(h.closes, []);
    assertNoBodyAction(h);
  });
}

function selectionEndingOnClose(h, { panePress = false } = {}) {
  h.pointer("press", panePress ? h.x - 20 : h.x, panePress ? h.y + 2 : h.y - 2);
  h.pointer("drag", h.x, h.y - 1);
  assert.equal(h.tui.hasActiveSelection(), true, "the fresh gesture really selects transcript");
  h.pointer("drag");
  const release = dispatched(h.pointer("release"), "release");
  assert.equal(release.result, undefined, "the unrelated selection release must not be claimed");
  assert.deepEqual(h.closes, []);
  assert.equal(h.tui.hasActiveSelection(), true, "finishing selection must retain its text");
  // Secondary pinned-SDK private-field diagnostic; the primary oracle is the
  // actual component release result above plus the public selection/callbacks.
  assert.equal(h.tui.selectionPressActive, false, "native selection press has ended");
  assertNoBodyAction(h);
}

for (const primedHover of [false, true])
  test(`Agents: focusout retires the old close before a new transcript selection (hover=${primedHover})`, (t) => {
    const h = fixture(t, "Agents", { compose: true });
    h.startDraft();
    if (primedHover) {
      const title = h.panel.render(80)[0];
      h.pointer("move");
      const hovered = h.panel.render(80)[0];
      assert.notEqual(hovered, title, "the actual close glyph must first be highlighted");
      assert.equal(stripTerminalSequences(hovered), stripTerminalSequences(title));
    }
    h.pointer("press");
    assert.deepEqual(h.input("\x1b[O"), [], "focusout is not a component mouse event");
    h.pointer("release", h.x, h.y - 2);
    selectionEndingOnClose(h);
    assert.equal(h.drafts.length, 1, "focus interruption must not discard the draft");
    assert.equal(h.drafts[0].text, "synthetic unsent draft");
    freshClose(h);
    assert.equal(h.drafts.at(-1), undefined, "a deliberate fresh close still discards it");
  });

for (const button of [1, 2])
  test(`Agents: button-${button} chord retires the prior close without swallowing a fresh selection release`, (t) => {
    const h = fixture(t, "Agents", { compose: true });
    h.startDraft();
    h.pointer("press");
    h.pointer("press", h.x, h.y, button);
    h.pointer("release", h.x, h.y, button);
    h.pointer("release", h.x, h.y - 2);
    selectionEndingOnClose(h);
    assert.equal(h.drafts.length, 1, "the chord cannot close or discard the draft");
    assert.equal(h.drafts[0].text, "synthetic unsent draft");
    freshClose(h);
  });

test("Agents: a transcript selection without any earlier close press ends normally on the close cell", (t) => {
  const h = fixture(t, "Agents");
  selectionEndingOnClose(h);
  freshClose(h);
});

test("Agents: a normally cancelled close cannot consume a later transcript selection release", (t) => {
  const h = fixture(t, "Agents");
  h.pointer("press");
  assert.equal(
    dispatched(h.pointer("release", h.x, h.y - 2), "release").result?.handled,
    true,
    "the original captured release is ours to consume",
  );
  selectionEndingOnClose(h);
  freshClose(h);
});

test("Agents: a fresh pane-body press after focusout cannot reactivate the old close", (t) => {
  const h = fixture(t, "Agents");
  h.pointer("press");
  h.input("\x1b[O");
  h.pointer("release", h.x, h.y - 2);
  selectionEndingOnClose(h, { panePress: true });
  freshClose(h);
});

test("Agents: keyboard interruption while native targeting remains cannot revive a synthetic left click", (t) => {
  const h = fixture(t, "Agents");
  h.pointer("press");
  h.input("z");
  const events = h.pointer("release");
  assert.equal(dispatched(events, "click").event.button, "left");
  assert.equal(dispatched(events, "click").result?.handled, true);
  assert.deepEqual(h.closes, [], "the old native synthetic click must not reactivate closing");
  assertNoBodyAction(h);
  freshClose(h);
});
