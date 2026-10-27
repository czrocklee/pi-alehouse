import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane, wrapText } from "../../dist/ui/agent-detail.js";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";
import { PanelCoordinator } from "../../dist/ui/panel-coordinator.js";
import { ended, fixture, settings, task, until } from "../support/controller-fixture.mjs";

initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
// Raw Ctrl+S works without Kitty; plain CR/LF must never substitute for it.
const CONFIRM = "\x13";
const accepted = { result: "cancel_requested", already_stopping: false };
const view = (agent_id = "a", extra = {}) => ({
  owner_id: "owner", generation: "generation", agent_id, run_id: `run-${agent_id}`, name: agent_id,
  description: "Stop fixture", effective_settings: settings, status: "running", phase: "executing",
  execution_exited: false, finalization_pending: false, resident: true, resumable: false,
  owner_blocked: false, pending_messages: 0, isolation: "shared", elapsed_ms: 0,
  turns: 1, max_turns: 8, max_duration_ms: 300000, cleanup_errors: [], discarded_inputs: [], ...extra,
});
const entry = (v) => ({ agent_id: v.agent_id, input: { view: v, live } });
function paneFixture(t, { frame = false, onStop, views = [view()] } = {}) {
  let closes = 0;
  const terminal = { columns: 120, rows: 40 };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} }, theme, frame,
    initial: views[0]?.agent_id ?? "a", snapshot: () => views.map(entry), transcript: () => undefined,
    done: () => { closes++; }, onStop,
  });
  t.after(() => pane.dispose());
  return { pane, views, terminal, get closes() { return closes; } };
}
function clickLabel(pane, lines, label, offset = 0) {
  const footer = lines.at(-1), at = footer.indexOf(label);
  assert(at >= 0, `expected painted ${label}`);
  return pane.handleMouse({ type: "click", button: "left",
    x: visibleWidth(footer.slice(0, at)) + offset, y: lines.length - 1 });
}
function arm(pane, width = 120, key = "s") {
  assert.match(pane.render(width).at(-1), /\[S Stop\]/);
  pane.handleInput(key);
  const lines = pane.render(width);
  assert.match(lines.at(-1), /\[Confirm stop\].*Ctrl\+S.*Esc back/);
  return lines;
}

for (const frame of [false, true]) for (const key of ["s", "S"]) {
  test(`Stop intent requires painted deliberate confirmation (frame=${frame}, key=${key})`, (t) => {
    const stopped = [];
    const h = paneFixture(t, { frame, onStop: (id) => {
      stopped.push(id); h.views[0].status = "cancelling"; h.views[0].stop_reason = "user_cancel";
    } });
    h.pane.handleInput(key); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [], "before paint there is no displayed target");
    h.pane.render(120); h.pane.handleInput(key); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [], "unpainted confirmation is not actionable");
    const lines = h.pane.render(120), text = lines.join("\n");
    assert.match(text, /Agent: a \(a\)/); assert.match(text, /Run: run-a/); assert.match(text, /Task: Stop fixture/);
    for (const input of ["s", "S", "\r", "\n", "\x1b[13;5u", "sure", "please"]) h.pane.handleInput(input);
    assert.deepEqual(stopped, [], "printing and Enter never execute Stop");
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 0, "Esc cancels confirmation, not the pane");
    h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, []);
    arm(h.pane, 120, key); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, ["run-a"]);
    assert.equal(h.closes, 0);
    const footer = h.pane.render(120).at(-1);
    assert.match(footer, /cancelling/); assert.doesNotMatch(footer, /\[S Stop\]/);
    h.pane.handleInput(key); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, ["run-a"], "already-stopping work is not stopped again");
    h.pane.handleInput("\x1b"); h.pane.handleInput(key); h.pane.handleInput(CONFIRM);
    assert.equal(h.closes, 1);
    assert.deepEqual(stopped, ["run-a"], "retired input is inert");
  });
}

for (const frame of [false, true]) for (const word of ["sure", "please", "Sure", "Please"]) {
  test(`typing ${word} and Enter cannot cancel (frame=${frame})`, (t) => {
    const h = paneFixture(t, { frame, onStop: () => assert.fail("typing is not confirmation") });
    h.pane.render(120);
    // Per-key rendering simulates the focused dispatcher, not just a pasted word.
    for (const char of word) { h.pane.handleInput(char); h.pane.render(120); }
    h.pane.handleInput("\r"); h.pane.render(120); h.pane.handleInput("\n");
    assert.equal(h.closes, 0);
  });
}

for (const frame of [false, true]) test(`Stop and confirm click geometry follows painting (frame=${frame})`, (t) => {
  const stopped = [];
  const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
  for (const width of [120, 80, 61, 46]) {
    for (const offset of [0, "[S Stop]".length - 1]) {
      const lines = h.pane.render(width), before = stopped.length;
      assert(lines.every((line) => visibleWidth(line) <= width));
      const footer = lines.at(-1), x = visibleWidth(footer.slice(0, footer.indexOf("[S Stop]"))), y = lines.length - 1;
      assert.equal(h.pane.handleMouse({ type: "click", button: "right", x, y }), undefined);
      assert.equal(h.pane.handleMouse({ type: "click", button: "left", x, y: y - 1 }), undefined);
      assert.deepEqual(clickLabel(h.pane, lines, "[S Stop]", offset), { handled: true });
      assert.equal(stopped.length, before, "the first click only opens intent");
      const confirmation = h.pane.render(width);
      assert(confirmation.every((line) => visibleWidth(line) <= width));
      assert.deepEqual(clickLabel(h.pane, confirmation, "[Confirm stop]", offset ? "[Confirm stop]".length - 1 : 0), { handled: true });
      assert.equal(stopped.length, before + 1);
      assert.equal(stopped.at(-1), "run-a");
    }
    assert.equal(h.closes, 0);
  }
});

for (const frame of [false, true]) for (const width of [8, 14, 24, 32]) {
  test(`narrow/unrenderable confirmation drops intent (frame=${frame}, width=${width})`, (t) => {
    const stopped = [];
    const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
    const confirmation = arm(h.pane);
    const oldFooter = confirmation.at(-1), oldX = oldFooter.indexOf("[Confirm stop]");
    const lines = h.pane.render(width);
    assert(lines.every((line) => visibleWidth(line) <= width));
    assert(!lines.some((line) => line.includes("[Confirm stop]")));
    h.pane.handleInput(CONFIRM);
    h.pane.handleMouse({ type: "click", button: "left", x: oldX, y: confirmation.length - 1 });
    h.pane.render(120); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [], "widening must not restore old intent");
    arm(h.pane); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, ["run-a"], "a fresh deliberate interaction works");
  });
}

for (const frame of [false, true]) for (const stage of ["intent", "confirmation"]) {
  for (const change of ["columns", "rows", "invalidate"]) for (const pointer of [false, true]) {
    test(`stale paint is retired before input (frame=${frame}, stage=${stage}, change=${change}, pointer=${pointer})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
      const lines = stage === "confirmation" ? arm(h.pane) : h.pane.render(120);
      const label = stage === "confirmation" ? "[Confirm stop]" : "[S Stop]";
      if (change === "invalidate") h.pane.invalidate();
      else h.terminal[change] = change === "rows" ? 4 : 12;
      // No render between changing the terminal/invalidation and old input.
      if (pointer) clickLabel(h.pane, lines, label);
      else h.pane.handleInput(stage === "confirmation" ? CONFIRM : "S");
      assert.deepEqual(stopped, []);
      assert.equal(h.closes, 0);
      h.terminal.columns = 120; h.terminal.rows = 40;
      h.pane.handleInput(CONFIRM);
      assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/,
        "restored dimensions and repaint cannot resurrect old intent");
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, []);
      arm(h.pane); h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, ["run-a"], "only a fresh deliberate interaction executes");
    });
  }
}

for (const change of ["columns", "rows"]) test(`resize followed by repaint alone drops confirmation (${change})`, (t) => {
  const h = paneFixture(t, { onStop: () => assert.fail("old confirmation was retired") });
  arm(h.pane);
  h.terminal[change]++;
  // The new terminal still has room, but its old confirmation intent is stale.
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
  h.terminal.columns = 120; h.terminal.rows = 40;
  h.pane.render(120); h.pane.handleInput(CONFIRM);
});

for (const change of ["columns", "rows"]) test(`Esc still backs out before resized confirmation repaints (${change})`, (t) => {
  const h = paneFixture(t, { onStop: () => assert.fail("Esc is never Stop") });
  arm(h.pane); h.terminal[change] = 4;
  h.pane.handleInput("\x1b");
  assert.equal(h.closes, 0, "first Esc backs out of confirmation");
  h.pane.handleInput("\x1b");
  assert.equal(h.closes, 1, "second Esc closes the pane");
});

for (const { label, prefix, suffix, plainPrefix = "", plainSuffix = "" } of [
  { label: "CSI conceal", prefix: "\x1b[8m", suffix: "\x1b[0m" },
  { label: "CSI erase/cursor", prefix: "\x1b[2J\x1b[10;10H", suffix: "\x1b[1G\x1b[K" },
  { label: "OSC8", prefix: "\x1b]8;;https://example.invalid/hidden\x1b\\", suffix: "\x1b]8;;\x1b\\" },
  { label: "OSC title", prefix: "\x1b]0;spoof title\x07", suffix: "\x1b]2;another title\x1b\\" },
  { label: "raw C0/DEL/C1", prefix: "\x00\x08\t\r\n\x7f\x85\x9b", suffix: "\x01\x9f",
    plainPrefix: "\\x00\\x08\\x09\\x0d\\x0a\\x7f\\x85\\x9b", plainSuffix: "\\x01\\x9f" },
]) for (const frame of [false, true]) test(`confirmation interpolations are plain terminal text (${label}, frame=${frame})`, (t) => {
  const decorate = (text) => prefix + text + suffix;
  const plain = (text) => plainPrefix + text + plainSuffix;
  const agent_id = decorate("agent");
  const h = paneFixture(t, { frame, views: [view(agent_id, {
    name: decorate("name"), run_id: decorate("run"), description: decorate("task"),
  })], onStop: () => {} });
  const lines = arm(h.pane);
  assert(lines.every((line) => !/\p{Cc}/u.test(line)), "no ANSI/OSC/raw controls may reach confirmation output");
  const body = lines.slice(1, -1).join("\n");
  assert(body.includes(`Agent: ${plain("name")} (${plain("agent")})`));
  assert(body.includes(`Run: ${plain("run")}`));
  assert(body.includes(`Task: ${plain("task")}`));
  assert(!body.includes("spoof title")); assert(!body.includes("https://example.invalid"));
  assert(lines.every((line) => visibleWidth(line) <= 120));
});

for (const field of ["name", "description", "agent_id", "run_id"]) {
  test(`fit is measured after raw-control escaping (${field})`, (t) => {
    const h = paneFixture(t, { views: [view("a", { [field]: "\x08".repeat(1000) })],
      onStop: () => assert.fail("full sanitized identity/task does not fit") });
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/, "expanded controls do not fit, so Stop is not offered");
    h.pane.handleInput("s");
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
    h.pane.handleInput(CONFIRM);
  });
}

test("an unpainted Stop hint disables S, even when the body is renderable", (t) => {
  const h = paneFixture(t, { frame: true, onStop: () => assert.fail("Stop hint is not painted") });
  const lines = h.pane.render(14);
  assert(lines.length > 0); assert.doesNotMatch(lines.at(-1), /\[S Stop\]/);
  h.pane.handleInput("s"); h.pane.render(120); h.pane.handleInput(CONFIRM);
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
});

function assertNoStopAction(h, width) {
  const lines = h.pane.render(width);
  assert(lines.length > 0, "the pane still renders when Stop does not fit");
  assert(lines.every((line) => visibleWidth(line) <= width));
  assert(!lines.some((line) => line.includes("[S Stop]") || line.includes("[Confirm stop]")));
  h.pane.handleInput("s"); h.pane.handleInput("S"); h.pane.handleInput(CONFIRM); h.pane.handleInput("\r");
  const y = lines.length - 1;
  h.pane.handleMouse({ type: "click", button: "left", x: 0, y });
  h.pane.handleMouse({ type: "click", button: "left", x: Math.max(0, width - 1), y });
  assert.equal(h.closes, 0);
  const again = h.pane.render(width);
  assert(!again.some((line) => line.includes("[S Stop]") || line.includes("[Confirm stop]")));
  h.pane.handleInput(CONFIRM);
}
function assertStopFits(h, width, stopped, identity) {
  const lines = arm(h.pane, width);
  assert(lines.every((line) => visibleWidth(line) <= width));
  const text = lines.join("\n");
  assert.match(text, /\[Confirm stop\].*Ctrl\+S.*Esc back/);
  assert.match(text, /Stop this task\?/);
  assert.match(text, /best-effort\./);
  for (const piece of identity) assert(text.includes(piece), `missing ${piece}`);
  assert(!lines.some((line) => /\p{Cc}/u.test(line)), "confirmation stays plain text");
  h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, ["run-a"]);
}

// [S Stop] is eight columns and used to appear from width 24. Offer it only when
// the full confirmation fits: docked hint needs 34, framed chrome is width-6.
for (const [frame, width] of [[false, 24], [false, 30], [false, 32], [false, 33], [true, 24], [true, 32], [true, 34], [true, 39]]) {
  test(`unfittable confirmation is not offered (frame=${frame}, width=${width})`, (t) => {
    const h = paneFixture(t, { frame, onStop: () => assert.fail("hidden Stop is not actionable") });
    assertNoStopAction(h, width);
  });
}
for (const [frame, width] of [[false, 34], [true, 40], [false, 80], [true, 80]]) {
  test(`Stop is offered only when the exact confirmation fits (frame=${frame}, width=${width})`, (t) => {
    const stopped = [];
    const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
    assertStopFits(h, width, stopped, ["Agent: a (a)", "Run: run-a", "Task: Stop fixture"]);
  });
}
for (const rows of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`non-finite terminal rows do not advertise Stop (${rows})`, (t) => {
    const h = paneFixture(t, { onStop: () => assert.fail("malformed geometry is not a Stop affordance") });
    h.terminal.rows = rows;
    assertNoStopAction(h, 120);
  });
}
for (const rows of [8, 9]) test(`default confirmation height boundary suppresses before S (rows=${rows})`, (t) => {
  const stopped = [];
  const h = paneFixture(t, { onStop: (id) => stopped.push(id) });
  h.terminal.rows = rows;
  if (rows < 9) assertNoStopAction(h, 80);
  else assertStopFits(h, 80, stopped, ["Agent: a (a)", "Run: run-a", "Task: Stop fixture"]);
  assert.deepEqual(stopped, rows < 9 ? [] : ["run-a"]);
});
test("long description on a short terminal suppresses the initial Stop action", (t) => {
  const h = paneFixture(t, { views: [view("a", { description: "full task ".repeat(500) })],
    onStop: () => assert.fail("a task that cannot be shown in full is not cancellable from here") });
  h.terminal.rows = 10;
  assertNoStopAction(h, 120);
  h.terminal.rows = 40;
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/, "40 rows still cannot hold the wrapped task");
  h.views[0].description = "Stop fixture";
  assert.match(h.pane.render(120).at(-1), /\[S Stop\]/, "a later identity that fits is rechecked, not latched off");
});
for (const [count, rows, offered] of [[34, 9, true], [35, 9, false], [35, 10, true]]) {
  test(`CJK identity is not clipped to enable Stop (count=${count}, rows=${rows})`, (t) => {
    const name = "\u6d4b".repeat(count);
    const stopped = [];
    const h = paneFixture(t, { views: [view("a", { name })], onStop: (id) => stopped.push(id) });
    h.terminal.rows = rows;
    if (!offered) {
      assertNoStopAction(h, 80);
      assert.deepEqual(stopped, []);
      return;
    }
    assertStopFits(h, 80, stopped, [name, "(a)", "Task: Stop fixture"]);
  });
}
const combiningTask = "a".repeat(73) + " \u0301 " + "測".repeat(39) + "A測";

test("word wrapping rechecks a wide character after a combining-only word break", () => {
  const source = `Task: ${combiningTask}`, lines = wrapText(source, 80);
  assert(lines.every((line) => visibleWidth(line) <= 80), "a word break must not leave an 81-column remainder");
  assert.equal(lines.join("").replace(/ /g, ""), source.replace(/ /g, ""), "wrapping does not drop task characters");
});

for (const frame of [false, true]) test(`combining-prefix task remains fully visible before confirmation (frame=${frame})`, (t) => {
  const stopped = [], width = frame ? 82 : 80;
  const h = paneFixture(t, { frame, views: [view("a", { description: combiningTask })],
    onStop: (id) => stopped.push(id) });
  h.terminal.columns = width;
  const lines = arm(h.pane, width);
  assert(lines.every((line) => visibleWidth(line) <= width));
  const body = lines.slice(1, -1).map((line) => frame ? line.slice(1, -1) : line);
  const start = body.findIndex((line) => line.startsWith("Task: "));
  assert(start >= 0);
  assert.equal(body.slice(start).join("").replace(/\s/gu, ""), `Task: ${combiningTask}`.replace(/\s/gu, ""),
    "the confirmed task is neither clipped nor replaced with an ellipsis");
  h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, ["run-a"]);
});

test("ANSI and raw controls are measured after sanitizing before Stop is offered", (t) => {
  const concealed = `\x1b[8m${"\u6d4b".repeat(10)}\x1b[0m`;
  const stripped = [];
  const plain = paneFixture(t, { views: [view("a", { name: concealed, description: "\x1b[31mStop fixture\x1b[0m" })],
    onStop: (id) => stripped.push(id) });
  plain.terminal.rows = 9;
  // CSI is stripped before the fit measurement; the confirmation shows the CJK, not the protocol.
  assertStopFits(plain, 80, stripped, ["\u6d4b".repeat(10), "Task: Stop fixture"]);
  const expanded = paneFixture(t, { views: [view("a", { description: "\x08".repeat(19) })],
    onStop: () => assert.fail("sanitized expansion does not fit") });
  expanded.terminal.rows = 9;
  assertNoStopAction(expanded, 80);
  const escaped = [];
  const fitting = paneFixture(t, { views: [view("a", { description: "\x08".repeat(18) })],
    onStop: (id) => escaped.push(id) });
  fitting.terminal.rows = 9;
  assertStopFits(fitting, 80, escaped, ["\\x08".repeat(18)]);
});

for (const change of ["short", "long-task"]) test(`confirmation cannot hide identity rows (${change})`, (t) => {
  const h = paneFixture(t, { views: [view("a", change === "long-task" ? { description: "full task ".repeat(500) } : {})],
    onStop: () => assert.fail("confirmation does not fit") });
  h.pane.render(120); h.pane.handleInput("s");
  if (change === "short") h.terminal.rows = 6;
  assert(!h.pane.render(120).some((line) => line.includes("[Confirm stop]")));
  h.pane.handleInput(CONFIRM);
  h.terminal.rows = 40;
  h.pane.render(120); h.pane.handleInput(CONFIRM);
});

for (const overrides of [
  { status: "completed", execution_exited: true }, { status: "failed", execution_exited: true },
  { status: "needs_input", execution_exited: true }, { status: "cancelled", execution_exited: true },
  { status: "cancelling" }, { execution_exited: true, finalization_pending: true },
  ...["deadline", "hard_budget", "user_cancel"].map((stop_reason) => ({ stop_reason })),
]) test(`settled, draining and already-stopping work has no Stop action (${JSON.stringify(overrides)})`, (t) => {
  const h = paneFixture(t, { views: [view("a", overrides)], onStop: () => assert.fail("no live execution to stop") });
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
  h.pane.handleInput("s"); h.pane.handleInput(CONFIRM);
});

for (const stage of ["intent", "confirmation"]) for (const change of [
  "new-run", "owner", "generation", "agent-identity", "removed", "other-agent", "settled", "stopping", "selection", "navigation",
]) test(`stale ${stage} never targets replacement work (${change})`, (t) => {
  const stopped = [];
  const h = paneFixture(t, { views: [view("a"), view("b")], onStop: (id) => stopped.push(id) });
  const lines = stage === "confirmation" ? arm(h.pane) : h.pane.render(120);
  const label = stage === "confirmation" ? "[Confirm stop]" : "[S Stop]";
  if (change === "new-run") h.views[0].run_id = "new-run-a";
  else if (change === "owner") h.views[0].owner_id = "replacement-owner";
  else if (change === "generation") h.views[0].generation = "replacement-generation";
  else if (change === "agent-identity") h.views[0].agent_id = "replacement-agent";
  else if (change === "removed") h.views.splice(0);
  else if (change === "other-agent") h.views.shift();
  else if (change === "settled") h.views[0].execution_exited = true;
  else if (change === "stopping") h.views[0].stop_reason = "deadline";
  else if (change === "selection") h.pane.activate("b");
  else h.pane.handleInput("\x1b[C");
  // Exercise old pointer geometry first, then keys, without a repaint.
  clickLabel(h.pane, lines, label);
  h.pane.handleInput("s"); h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, [], "no fallback or retargeting before repaint");
  h.pane.render(120); h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, [], "repaint cannot re-arm a stale confirmation");
});

test("empty roster with Stop handler and read-only panes offer no Stop", (t) => {
  for (const options of [{ views: [], onStop: () => assert.fail("empty roster") }, { onStop: undefined }]) {
    const h = paneFixture(t, options);
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
    h.pane.handleInput("s"); h.pane.handleInput(CONFIRM); h.pane.handleInput("\x1b");
    assert.equal(h.closes, 1);
  }
});

for (const close of ["dispose", "activate", "frame-close"]) test(`closing discards confirmation (${close})`, (t) => {
  const h = paneFixture(t, { frame: true, onStop: () => assert.fail("closed pane") });
  arm(h.pane);
  if (close === "dispose") h.pane.dispose();
  else if (close === "activate") h.pane.activate("a");
  else h.pane.handleMouse({ type: "click", button: "left", x: 117, y: 0 });
  h.pane.handleInput(CONFIRM);
  assert.deepEqual(h.pane.render(120), []);
});

function mockWidget(v = view(), { wake = () => {}, mode = "regular" } = {}) {
  return { agents: () => [{ agent_id: v.agent_id, view: v, live, cwd: settings.cwd, entries: () => undefined, inFlight: () => undefined }],
    onOpen() {}, tuiMode: () => mode, wake };
}
function panelFixture(t, { widget, stopRun, notify = () => {}, ready = () => true, mode = "regular" }) {
  const bus = createEventBus(), shortcuts = new Map();
  let pane, closes = 0;
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (key, spec) => shortcuts.set(key, spec) }, widget,
    ready, router() { assert.fail("Stop does not need a routing selection"); }, publish() {}, showError() {}, stopRun,
  });
  panels.attachHost({ mode: "tui", ui: { notify, custom(factory, options) {
    return new Promise((resolve) => {
      pane = factory({ terminal: { columns: 120, rows: 40 }, requestRender() {} }, theme, {}, () => { closes++; resolve(); });
      if (mode === "fullscreen") options.onHandle?.({ setHidden() {} });
    });
  } } }, bus);
  t.after(() => panels.dispose());
  return { panels, bus, open: () => shortcuts.get("alt+a").handler(),
    get pane() { return pane; }, get closes() { return closes; } };
}

for (const queued of [false, true]) test(`panel Stop uses the real Owner path while Off (queued=${queued})`, async (t) => {
  const admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => ({ ...admission }) } });
  const first = await f.controller.submit("first", task("first"));
  await until(() => f.ports[0]?.streaming);
  const second = queued ? await f.controller.submit("second", task("second")) : undefined;
  const widget = new HarnessWidget(f.controller, 8);
  widget.tuiMode = () => "regular";
  const stopped = [], notices = [];
  const h = panelFixture(t, { widget, stopRun: (id) => { stopped.push(id); return f.controller.cancel(id, { source: "human" }); },
    notify: (message) => notices.push(message) });
  t.after(() => widget.dispose());
  const opening = h.open(), target = second ?? first;
  if (widget.agents()[0].agent_id !== target.agent_id) h.pane.activate(target.agent_id);
  arm(h.pane);
  admission.enabled = false; admission.revision++;
  h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, [target.run_id]); assert.equal(h.closes, 0);
  assert.match(notices.at(-1), /^Cancellation requested/);
  if (queued) {
    await ended(f.controller, target);
    assert.equal(f.controller.view(first.run_id).status, "running", "the sibling is untouched");
    assert.equal(f.ports[0].stopped, 0);
    assert.equal(f.ports.length, 1, "the queued child was never created");
  } else {
    await until(() => f.ports[0].stopped === 1);
    assert.equal(f.controller.view(target.run_id).status, "cancelling");
    assert.equal(f.controller.view(target.run_id).execution_exited, false, "a request is not confirmed exit");
    assert.equal(f.controller.stats().active, 1, "ownership remains until actual execution exit");
    h.pane.handleInput("s"); h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [target.run_id]);
    f.ports[0].finish("partial", "aborted"); await ended(f.controller, target);
  }
  assert.equal(f.controller.view(target.run_id).status, "cancelled");
  assert.equal(f.controller.view(target.run_id).cancellation_source, "human");
  assert.equal(f.controller.stats().resident, queued ? 2 : 1, "Stop is not Agent kill or Owner shutdown");
  assert.equal(f.controller.stats().closed, false);
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
  h.panels.dispose(); await opening;
});

for (const brokenNotify of [false, true]) for (const pointer of [false, true]) {
  test(`command failure is contained (broken notify=${brokenNotify}, pointer=${pointer})`, async (t) => {
    const notices = []; let stops = 0, wakes = 0;
    const h = panelFixture(t, { widget: mockWidget(view(), { wake: () => { wakes++; } }),
      stopRun: () => { stops++; throw new Error("CONTROLLED_STOP_FAILURE"); },
      notify: (message) => { notices.push(message); if (brokenNotify) throw new Error("NOTIFY_FAILED"); } });
    const opening = h.open(), lines = arm(h.pane);
    assert.doesNotThrow(() => pointer ? clickLabel(h.pane, lines, "[Confirm stop]") : h.pane.handleInput(CONFIRM));
    h.pane.handleInput(CONFIRM);
    assert.equal(stops, 1); assert.equal(wakes, 0); assert.equal(h.closes, 0);
    assert.equal(notices.length, 1); assert.match(notices[0], /Cancellation request failed:.*CONTROLLED_STOP_FAILURE/);
    h.panels.dispose(); await opening;
  });
}

for (const brokenNotify of [false, true]) test(`accepted cancellation survives refresh failure (broken notify=${brokenNotify})`, async (t) => {
  let stops = 0, wakes = 0;
  const notices = [];
  const h = panelFixture(t, { widget: mockWidget(view(), { wake: () => { wakes++; throw new Error("REFRESH_FAILED"); } }),
    stopRun: () => { stops++; return accepted; },
    notify: (message) => { notices.push(message); if (brokenNotify) throw new Error("NOTIFY_FAILED"); } });
  const opening = h.open(); arm(h.pane);
  assert.doesNotThrow(() => h.pane.handleInput(CONFIRM)); h.pane.handleInput(CONFIRM);
  assert.equal(stops, 1); assert.equal(wakes, 1);
  assert.deepEqual(notices, ["Cancellation requested; display refresh failed"]);
  h.panels.dispose(); await opening;
});

for (const [result, expected] of [
  [accepted, "Cancellation requested"],
  [{ ...accepted, already_stopping: true }, "Cancellation already requested; still stopping"],
  [{ result: "already_terminal", already_stopping: false }, "Task already finished; no cancellation needed"],
  [{ result: "already_exited", already_stopping: false }, "Task execution already exited; no cancellation needed"],
  [{ ...accepted, warnings: ["CONTROLLED_WARNING"] }, "Cancellation requested; CONTROLLED_WARNING"],
]) test(`Stop result has useful feedback (${expected})`, async (t) => {
  const notices = []; let stops = 0, wakes = 0;
  const h = panelFixture(t, { widget: mockWidget(view(), { wake: () => { wakes++; } }),
    stopRun: () => { stops++; return result; }, notify: (message, kind) => notices.push({ message, kind }) });
  const opening = h.open(); arm(h.pane); h.pane.handleInput(CONFIRM);
  assert.equal(stops, 1); assert.equal(wakes, 1);
  assert.deepEqual(notices, [{ message: expected, kind: result.warnings?.length ? "warning" : "info" }]);
  h.panels.dispose(); await opening;
});

for (const mode of ["regular", "fullscreen"]) test(`current blocked actions explain; retired callbacks stay silent (${mode})`, async (t) => {
  let ready = true, stopped = 0;
  const notices = [];
  const h = panelFixture(t, { widget: mockWidget(view(), { mode }), mode, ready: () => ready,
    stopRun: () => { stopped++; return accepted; }, notify: (message) => notices.push(message) });
  const opening = h.open(); arm(h.pane);
  ready = false; h.pane.handleInput(CONFIRM);
  assert.equal(stopped, 0); assert.match(notices.at(-1), /not ready/);
  ready = true; arm(h.pane);
  // Capture the host-bound callback to exercise its own guard independently of
  // the pane's deliberately redundant identity/paint checks.
  const callback = h.pane.options.onStop;
  h.bus.emit("permissions:ui_prompt", { requestId: "stop-test-ask" });
  h.pane.handleInput(CONFIRM);
  assert.equal(stopped, 0, "hiding/closing clears confirmation immediately");
  const beforeBlockedCallback = notices.length;
  callback("run-a");
  if (mode === "regular") assert.equal(notices.length, beforeBlockedCallback, "retired pane callback is silent");
  if (mode === "fullscreen") {
    assert.match(notices.at(-1), /permission dialog/);
    h.bus.emit("permissions:decision", { requestId: "stop-test-ask" });
    h.pane.render(120); h.pane.handleInput(CONFIRM);
    assert.equal(stopped, 0, "reshowing does not restore confirmation");
  }
  h.panels.dispose();
  const before = notices.length;
  callback("run-a"); h.pane.handleInput("s"); h.pane.handleInput(CONFIRM);
  assert.equal(stopped, 0); assert.equal(notices.length, before, "retired host cannot be notified");
  await opening;
});

test("command that retires its host produces no refresh or retired notification", async (t) => {
  let wakes = 0, stops = 0;
  const notices = [];
  const h = panelFixture(t, { widget: mockWidget(view(), { wake: () => { wakes++; } }),
    stopRun: () => { stops++; h.panels.dispose(); return accepted; }, notify: (message) => notices.push(message) });
  const opening = h.open(); arm(h.pane); h.pane.handleInput(CONFIRM);
  assert.equal(stops, 1); assert.equal(wakes, 0); assert.deepEqual(notices, []);
  await opening;
});
