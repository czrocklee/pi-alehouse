import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { borderLabelsEnabled, setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";
import { detailView, plainTheme } from "../support/detail-fixture.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
initTheme(undefined, false);

const F2 = "\x1bOQ";
const ESC = "\x1b";
const ENTER = "\r";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const draft = "unsent resize fixture hjklz";

// The pinned SDK mounts the real coordinator's custom overlay and dispatches
// raw SGR events. No actual TTY, model, permission dialog or clipboard is used.
async function fixture(t, labels, { transcriptRows = 0, agentView = {} } = {}) {
  const previous = borderLabelsEnabled();
  setBorderLabelsEnabled(labels);
  t.after(() => setBorderLabelsEnabled(previous));
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  tui.requestViewRender = () => {};
  const root = { render: () => Array(terminal.rows).fill("Main transcript"), invalidate() {} };
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  tui.beforeTerminalStart();
  t.after(() => {
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });

  const ref = createInteractiveTuiReference(() => tui);
  const host = {
    ui: ref,
    editor: { getText: () => "" },
    keybindings: {},
    extensionOverlays: new Map(),
  };
  const bus = createEventBus();
  const shortcuts = new Map();
  const notices = [],
    stopped = [],
    sent = [];
  const agent_id = "fixture-worker";
  const entries = [];
  const appendTranscript = (rows) => {
    entries.push({
      type: "message",
      id: `fixture-message-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "user",
        content: [
          "```",
          ...Array.from({ length: rows }, (_, row) => `Transcript ─ row ${row}`),
          "```",
        ].join("\n"),
        timestamp: 0,
      },
    });
  };
  if (transcriptRows) appendTranscript(transcriptRows);
  const agent = {
    agent_id,
    cwd: "/workspace",
    view: detailView(agent_id, {
      status: "running",
      phase: "executing",
      execution_exited: false,
      ...agentView,
    }),
    live: { active_tools: [], tool_uses: 0, preview: "" },
    entries: () => (entries.length ? entries : undefined),
    inFlight: () => undefined,
  };
  const peer = {
    ...agent,
    agent_id: "peer",
    view: detailView("peer", { name: "peer─name" }),
  };
  const ui = {
    theme: plainTheme,
    notify: (message, kind) => notices.push({ message, kind }),
    setWidget: (_name, factory) => factory?.(ref),
    custom: (factory, options) =>
      InteractiveMode.prototype.showExtensionCustom.call(host, factory, options),
  };
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (key, spec) => shortcuts.set(key, spec) },
    widget: { agents: () => [agent, peer], onOpen() {}, wake() {} },
    ready: () => true,
    router: () => assert.fail("unexpected routing"),
    publish: () => assert.fail("unexpected publication"),
    showError: (error) => assert.fail(String(error)),
    stopRun(id) {
      stopped.push(id);
      return { result: "cancel_requested", already_stopping: false };
    },
    steerRun(id, text) {
      sent.push([id, text]);
      return { accepted: true };
    },
  });
  panels.attachHost({ mode: "tui", ui }, bus);
  const done = shortcuts.get("alt+a").handler();
  t.after(async () => {
    panels.dispose();
    await done;
    assert.equal(
      notices.some(({ kind }) => kind === "error"),
      false,
      JSON.stringify(notices),
    );
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.extensionOverlays.size, 1);
  const [handle] = host.extensionOverlays.keys();
  const paint = () => {
    tui.doRender();
    assert.deepEqual([...host.extensionOverlays.keys()], [handle], "resize keeps the same mount");
    const box = handle.getBounds();
    assert.ok(box?.height, "the Agents frame was painted");
    assert.equal(box.col, Math.floor((terminal.columns - box.width) / 2));
    assert.equal(box.row, Math.floor((terminal.rows - box.height) / 2));
    const lines = tui
      .getScreenLines()
      .slice(box.row, box.row + box.height)
      .map((row) => sliceByColumn(stripTerminalSequences(row), box.col, box.width));
    assert.match(lines[0], /^[╭╒╓╔].*[╮╕╖╗]$/u);
    assert.match(lines.at(-1), /^[╰╘╙╚].*[╯╛╜╝]$/u);
    assert.ok(lines.every((line) => visibleWidth(line) === box.width));
    return { box, lines };
  };
  const input = (data) => tui.handleTerminalInput(data);
  const pointer = (kind, { x, y }) =>
    input(`\x1b[<${kind === "drag" ? 32 : 0};${x + 1};${y + 1}${kind === "release" ? "m" : "M"}`);
  const click = (point) => {
    pointer("press", point);
    pointer("release", point);
  };
  return {
    bus,
    terminal,
    handle,
    tui,
    input,
    paint,
    pointer,
    click,
    stopped,
    sent,
    appendTranscript,
  };
}

function target({ box, lines }, label) {
  const row = lines.findIndex((line) => line.includes(label));
  assert.ok(row >= 0, `missing painted ${label}`);
  const x = visibleWidth(lines[row].slice(0, lines[row].indexOf(label)));
  return { x: box.col + x, y: box.row + row };
}

for (const labels of [true, false]) {
  test(`Agents title keeps the full Run cue beside maximize (border labels=${labels})`, async (t) => {
    const h = await fixture(t, labels, {
      agentView: { task: 1234, description: "A long task description ".repeat(10) },
    });
    const title = h.paint().lines[labels ? 0 : 1];
    assert.match(title, /A long task description.*… · #1234 +□.*✕/u);
  });

  test(`Agents resize moves the real frame and preserves deliberate Stop (border labels=${labels})`, async (t) => {
    const h = await fixture(t, labels);
    const initial = h.paint();
    const title = initial.lines[labels ? 0 : 1];
    assert.match(title, /□.*✕/u);
    assert.doesNotMatch(title, /≡|Resize/u);
    assert.equal(initial.box.width, 88);
    assert.ok(initial.box.height < 20, "a short transcript is initially content-sized");
    h.terminal.columns = 110;
    const automatic = h.paint();
    assert.equal(automatic.box.width, 96, "default width reacts without reopening");

    h.input("s");
    const armed = h.paint();
    target(armed, "confirm stop");
    const corner = bottomRight(armed);
    h.pointer("press", corner);
    const held = h.paint();
    assert.deepEqual(held.box, armed.box);
    assert.match(held.lines.at(-1), /^╘═.*═╝$/u);
    assert.match(held.lines[0], /^╭.*╖$/u);
    target(held, "confirm stop");
    h.pointer("release", corner);
    const released = h.paint();
    assert.match(released.lines.at(-1), /^╰.*╯$/u);
    target(released, "confirm stop");
    assert.deepEqual(h.stopped, [], "a stationary resize press keeps Stop armed without acting");
    h.input(F2);
    const editing = h.paint();
    assert.match(editing.lines[0], /^╔.*╗$/u);
    assert.match(editing.lines.at(-1), /^╚.*╝$/u);
    assert.match(editing.lines[labels ? 0 : 1], labels ? /Resize/u : /^║.*Resize.*║$/u);
    h.input(RIGHT);
    h.input(DOWN);
    const preview = h.paint();
    target(preview, "Resize");
    const middle = { x: preview.box.col + 6, y: preview.box.row + (labels ? 2 : 4) };
    h.pointer("press", middle);
    const end = { x: middle.x + 10, y: middle.y };
    h.pointer("drag", end);
    h.pointer("release", end);
    assert.equal(h.tui.hasActiveSelection(), false, "modal resize excludes body selection");
    assert.equal(preview.box.width, automatic.box.width + 2);
    assert.ok(
      preview.box.height > automatic.box.height,
      "the short frame gains real visible height",
    );
    h.input(ESC);
    const restored = h.paint();
    assert.deepEqual(restored.box, automatic.box, "Esc restores automatic sizing without closing");
    h.input("\x13"); // Ctrl+S must not confirm the intent from before resizing.
    assert.deepEqual(h.stopped, []);

    h.click(target(restored, "□"));
    assert.deepEqual(h.paint().box, { row: 1, col: 1, width: 108, height: 38 });
    h.terminal.columns = 41;
    h.terminal.rows = 16;
    assert.deepEqual(h.paint().box, { row: 1, col: 1, width: 39, height: 14 });
    h.terminal.columns = 110;
    h.terminal.rows = 40;
    const maximized = h.paint();
    assert.deepEqual(maximized.box, { row: 1, col: 1, width: 108, height: 38 });
    const stop = target(maximized, "stop");
    assert.equal(stop.y, maximized.box.row + maximized.box.height - (labels ? 1 : 2));
    h.click(stop);
    target(h.paint(), "confirm stop");
    h.input("\x13");
    assert.deepEqual(
      h.stopped,
      ["run-fixture-worker"],
      "the new footer has live action coordinates",
    );
    h.click(target(h.paint(), "▣"));
    assert.deepEqual(h.paint().box, automatic.box, "restore restores both automatic dimensions");
  });
}

const bottomRight = ({ box }) => ({ x: box.col + box.width - 1, y: box.row + box.height - 1 });

test("Agents keyboard width keeps height fitted to new transcript rows", async (t) => {
  const h = await fixture(t, true);
  const initial = h.paint();
  h.input(F2);
  h.input(RIGHT);
  h.input(ENTER);
  const resized = h.paint();
  assert.equal(resized.box.width, initial.box.width + 2);
  assert.equal(resized.box.height, initial.box.height, "width alone does not set a height");

  h.appendTranscript(8);
  const grown = h.paint();
  assert.equal(grown.box.width, resized.box.width);
  assert.ok(grown.box.height > resized.box.height, "new transcript rows grow the frame");
  target(grown, "Transcript ─ row 7");
});

test("Agents border drag sets only width and remains centered as the transcript grows", async (t) => {
  const h = await fixture(t, false);
  const initial = h.paint();
  const edge = { x: initial.box.col, y: initial.box.row + 1 };
  const end = { x: edge.x - 3, y: edge.y + 1 };
  h.pointer("press", edge);
  h.pointer("drag", end);
  const dragged = h.paint();
  assert.equal(dragged.box.width, initial.box.width + 6);
  assert.equal(dragged.box.height, initial.box.height);
  h.pointer("release", end);
  assert.deepEqual(h.paint().box, dragged.box);

  h.appendTranscript(8);
  const grown = h.paint();
  assert.equal(grown.box.width, dragged.box.width);
  assert.ok(grown.box.height > dragged.box.height, "a width-only drag leaves height fitted");
  target(grown, "Transcript ─ row 7");
});

test("Agents explicit height stays fixed while width remains automatic", async (t) => {
  const h = await fixture(t, true);
  const initial = h.paint();
  h.input(F2);
  h.input(DOWN);
  h.input(ENTER);
  const resized = h.paint();
  assert.equal(resized.box.height, initial.box.height + 2);
  assert.equal(resized.box.width, initial.box.width);

  h.appendTranscript(8);
  const updated = h.paint();
  assert.deepEqual(
    updated.box,
    resized.box,
    "new transcript rows cannot expand an explicit height",
  );
  target(updated, "Transcript ─ row 7");
  h.terminal.columns = 110;
  const wider = h.paint();
  assert.equal(wider.box.width, 96, "the untouched width responds to the terminal");
  assert.equal(wider.box.height, resized.box.height);
});

test("Agents maximize restore and keyboard undo recover a partially automatic size", async (t) => {
  const h = await fixture(t, true, { transcriptRows: 4 });
  h.paint();
  h.input(F2);
  h.input(RIGHT);
  h.input(ENTER);
  const resized = h.paint();

  h.click(target(resized, "□"));
  assert.deepEqual(h.paint().box, { row: 1, col: 1, width: 98, height: 38 });
  h.appendTranscript(8);
  const maximized = h.paint();
  target(maximized, "Transcript ─ row 7");
  h.click(target(maximized, "▣"));
  const restored = h.paint();
  assert.equal(restored.box.width, resized.box.width);
  assert.ok(
    restored.box.height > resized.box.height,
    "restore fits the transcript that grew while maximized",
  );
  assert.ok(restored.box.height < maximized.box.height);

  h.input(F2);
  h.input(DOWN);
  const preview = h.paint();
  target(preview, "Resize");
  assert.equal(preview.box.height, restored.box.height + 2);
  h.appendTranscript(12);
  assert.deepEqual(h.paint().box, preview.box, "the preview holds its explicitly adjusted height");
  h.input(ESC);
  const undone = h.paint();
  assert.equal(undone.box.width, resized.box.width);
  assert.ok(
    undone.box.height > preview.box.height,
    "undo fits the transcript that grew during resize",
  );
  target(undone, "Transcript ─ row 11");
});

test("Agents right-edge highlight leaves the transcript and scroll thumb intact", async (t) => {
  const h = await fixture(t, false, { transcriptRows: 80 });
  const initial = h.paint();
  const transcriptY = initial.lines.findIndex((line) => line.includes("Transcript ─ row"));
  assert.ok(transcriptY > 0, "a real transcript row is visible");
  assert.ok(
    initial.lines.some((line) => line.endsWith("┃")),
    "scroll thumb is visible",
  );
  assert.ok(initial.lines[transcriptY].endsWith("│"), "the target is track, not thumb");
  const edge = { x: initial.box.col + initial.box.width - 1, y: initial.box.row + transcriptY };
  h.pointer("press", edge);
  const held = h.paint();
  assert.deepEqual(held.box, initial.box);
  assert.match(held.lines[transcriptY], /^│.*Transcript ─ row.*║$/u);
  assert.match(held.lines[2], /^├─.*╢$/u, "inset separator joins the active vertical edge");
  for (const [index, line] of initial.lines.entries()) {
    if (line.endsWith("┃")) assert.equal(held.lines[index].at(-1), "┃");
  }
  h.input("\x1b[O");
  const unfocused = h.paint();
  assert.deepEqual(unfocused.box, initial.box);
  assert.match(unfocused.lines[transcriptY], /│$/u, "terminal focus-out clears the highlight");
  h.input("\x1b[I");
  h.pointer("release", edge);
});

test("Agents corner drag resizes in place, preserves the draft, and cannot outlive a permission yield", async (t) => {
  const h = await fixture(t, true);
  h.paint();
  h.input("m");
  const composing = h.paint();
  for (const key of draft) h.input(key);
  const typed = h.paint();
  target(typed, draft);
  assert.deepEqual(typed.box, composing.box, "typing in a draft does not resize");
  assert.doesNotMatch(typed.lines[0], /Resize/u);

  h.input(F2);
  const editing = h.paint();
  target(editing, "Resize");
  const modalPaste = "pasted while resizing hjklz";
  h.input(`\x1b[200~${modalPaste}${ENTER}${ESC}\x1b[201~`);
  const afterPaste = h.paint();
  target(afterPaste, "Resize");
  assert.deepEqual(afterPaste.box, editing.box, "paste does not adjust or exit keyboard resize");
  assert.ok(
    !afterPaste.lines.some((line) => line.includes(modalPaste)),
    "a paste during keyboard resize does not enter the draft",
  );
  h.input(ESC);
  const initial = h.paint();
  target(initial, draft);
  const corner = bottomRight(initial);
  h.pointer("press", corner);
  const moved = { x: corner.x + 2, y: corner.y + 3 };
  h.pointer("drag", moved);
  h.input(ENTER); // No new composer paint yet.
  assert.deepEqual(h.sent, [], "stale composer geometry must not send");
  const grown = h.paint();
  assert.ok(grown.box.width > initial.box.width && grown.box.height > initial.box.height);
  assert.equal(h.tui.hasActiveSelection(), false, "a border drag is not text selection");
  target(grown, draft);
  h.pointer("release", moved);
  assert.deepEqual(h.paint().box, grown.box);

  const nextCorner = bottomRight(grown);
  h.pointer("press", nextCorner);
  const permission = { requestId: "resize-fixture" };
  h.bus.emit("permissions:ui_prompt", permission);
  assert.equal(h.handle.isHidden(), true);
  h.bus.emit("permissions:decision", permission);
  assert.equal(h.handle.isHidden(), false);
  h.paint();
  const later = { x: nextCorner.x - 3, y: nextCorner.y - 3 };
  h.pointer("drag", later);
  h.pointer("release", later);
  const restored = h.paint();
  assert.deepEqual(restored.box, grown.box, "a drag from before the yield cannot resume");
  target(restored, draft);
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.sent, []);
  h.input(ENTER);
  assert.deepEqual(
    h.sent,
    [["run-fixture-worker", draft]],
    "the painted original draft can still send",
  );
});

test("Agents bottom edge does not resize from rule-shaped draft text in the compact footer", async (t) => {
  const h = await fixture(t, true);
  h.terminal.rows = 11;
  h.paint();
  h.input("m");
  const text = "draft─text";
  h.input(text);
  const compact = h.paint();
  const draftStart = target(compact, text);
  const point = { x: draftStart.x + visibleWidth("draft"), y: draftStart.y };
  assert.equal(point.y, compact.box.row + compact.box.height - 1, "draft is inlaid in the frame");
  const dragDown = (start) => {
    const end = { x: start.x, y: start.y + 1 };
    h.pointer("press", start);
    h.pointer("drag", end);
    h.pointer("release", end);
  };
  dragDown(point);
  assert.deepEqual(h.paint().box, compact.box, "a draft glyph cannot start a resize");
  const corner = bottomRight(compact);
  h.pointer("press", corner);
  const held = h.paint();
  assert.match(held.lines.at(-1), /^╘═.*draft─text.*═╝$/u);
  h.pointer("release", corner);
  dragDown(corner);
  const grown = h.paint();
  assert.equal(grown.box.height, compact.box.height + 2, "the adjacent corner can still resize");
  target(grown, text);
});

test("Agents Actions menu does not turn a visible tab nickname into a resize handle", async (t) => {
  const h = await fixture(t, true);
  const initial = h.paint();
  for (const repaint of [true, false]) {
    h.input(".");
    const menu = repaint ? h.paint() : initial;
    if (repaint) target(menu, "Expand tools");
    const tab = target(menu, "peer─name");
    assert.equal(tab.y, menu.box.row + menu.box.height - 1);
    const point = { x: tab.x + visibleWidth("peer"), y: tab.y };
    h.pointer("press", point);
    const afterPress = h.paint();
    assert.match(afterPress.lines.at(-1), /^╰.*peer─name.*╯$/u, "no resize capture or highlight");
    assert.ok(
      !afterPress.lines.some((line) => line.includes("Expand tools")),
      "press dismisses the menu",
    );
    const end = { x: point.x, y: point.y + 3 };
    h.pointer("drag", end);
    h.pointer("release", end);
    const afterDrag = h.paint();
    assert.deepEqual(afterDrag.box, initial.box, "outside press did not resize");
    assert.doesNotMatch(afterDrag.lines[0], /peer─name/u, "menu dismissal did not select the tab");
  }
});

test("Agents resizes on bare rules but not on a rule-shaped nickname in the tab or title", async (t) => {
  const h = await fixture(t, true);
  const initial = h.paint();
  const peer = target(initial, "peer─name");
  h.click({ x: peer.x + visibleWidth("peer"), y: peer.y });
  const selected = h.paint();
  assert.match(selected.lines[0], /peer─name/, "the click selected the actual tab");
  assert.equal(selected.box.width, initial.box.width);

  const title = target(selected, "peer─name");
  const literal = { x: title.x + visibleWidth("peer"), y: title.y };
  h.pointer("press", literal);
  assert.match(h.paint().lines[0], /^╭─.*peer─name.*╮$/u);
  const outside = { x: literal.x, y: literal.y - 2 };
  h.pointer("drag", outside);
  h.pointer("release", outside);
  assert.deepEqual(h.paint().box, selected.box, "a title glyph cannot start a resize");

  const rule = { x: selected.box.col + 1, y: selected.box.row };
  h.pointer("press", rule);
  assert.match(h.paint().lines[0], /^╒═.*peer─name.*═╕$/u);
  h.pointer("release", rule);

  const side = { x: selected.box.col, y: selected.box.row + 1 };
  h.pointer("press", side);
  h.pointer("drag", { x: side.x - 3, y: side.y });
  const widened = h.paint();
  h.pointer("release", { x: side.x - 3, y: side.y });
  assert.equal(widened.box.width, selected.box.width + 6);
  assert.equal(widened.box.height, selected.box.height);

  const bottom = { x: widened.box.col + 1, y: widened.box.row + widened.box.height - 1 };
  h.pointer("press", bottom);
  const held = h.paint();
  assert.match(held.lines.at(-1), /^╘═.*peer─name.*══.*═╛$/u);
  const end = { x: bottom.x, y: bottom.y + 3 };
  h.pointer("drag", end);
  h.pointer("release", end);
  const heightened = h.paint();
  assert.equal(heightened.box.width, widened.box.width);
  assert.equal(heightened.box.height, widened.box.height + 6);
});
