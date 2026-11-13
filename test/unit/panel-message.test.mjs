import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { PanelCoordinator } from "../../dist/orchestration/ui/panel-coordinator.js";
import { settings } from "../support/controller-fixture.mjs";

initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const view = (agent_id) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  description: `Task for ${agent_id}`,
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  isolation: "shared",
  elapsed_ms: 0,
  turns: 1,
  max_turns: 8,
  cleanup_errors: [],
  discarded_inputs: [],
});

function fixture(t, { mode = "regular", failure, brokenNotify = false, brokenWake = false } = {}) {
  const shortcuts = new Map(),
    bus = createEventBus(),
    notices = [],
    sent = [],
    hidden = [],
    panes = [];
  let clicked,
    wakes = 0;
  const agents = ["a", "b"].map((agent_id) => ({
    agent_id,
    cwd: settings.cwd,
    view: view(agent_id),
    live: { active_tools: [], tool_uses: 0, preview: "" },
    entries: () => undefined,
    inFlight: () => undefined,
  }));
  const panels = new PanelCoordinator({
    pi: {
      events: bus,
      registerShortcut: (name, spec) => shortcuts.set(name, spec),
      sendMessage() {
        assert.fail("human steering must not publish a parent message");
      },
    },
    widget: {
      agents: () => agents,
      tuiMode: () => mode,
      onOpen: (handler) => {
        clicked = handler;
      },
      wake() {
        wakes++;
        if (brokenWake) throw new Error("REFRESH_FAILED");
      },
    },
    ready: () => true,
    router() {
      assert.fail("human steering does not resolve routing");
    },
    publish() {},
    showError() {},
    steerRun(run_id, message) {
      sent.push([run_id, message]);
      if (failure) throw new Error(failure);
      return { accepted: true };
    },
  });
  panels.attachHost(
    {
      mode: "tui",
      ui: {
        notify(message, kind) {
          notices.push({ message, kind });
          if (brokenNotify) throw new Error("NOTIFY_FAILED");
        },
        custom(factory, options) {
          return new Promise((resolve) => {
            const pane = factory(
              { mode, terminal: { columns: 120, rows: 40 }, requestRender() {} },
              theme,
              {},
              resolve,
            );
            panes.push(pane);
            options.onHandle?.({ setHidden: (value) => hidden.push(value) });
          });
        },
      },
    },
    bus,
  );
  t.after(() => panels.dispose());
  const current = () => panes.at(-1);
  const type = (text) => {
    for (const ch of text) current().handleInput(ch);
  };
  return {
    panels,
    agents,
    bus,
    panes,
    hidden,
    notices,
    sent,
    open: () => shortcuts.get("alt+a").handler(),
    click: (id) => clicked?.(id),
    pane: current,
    footer: () => stripTerminalSequences(current().render(120).at(-1)),
    type,
    compose(text) {
      current().render(120);
      current().handleInput("m");
      type(text);
    },
    get wakes() {
      return wakes;
    },
  };
}

for (const mode of ["regular", "fullscreen"])
  test(`a permission yield preserves a same-Run draft and its continuation editing (${mode})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const h = fixture(t, { mode });
    h.click("b");
    h.compose("keep this draft");
    const original = h.pane();
    h.bus.emit("permissions:ui_prompt", { requestId: "ask" });
    await tick();
    assert.deepEqual(h.sent, []);
    if (mode === "regular") assert.equal(original.isOpen(), false);
    else assert.deepEqual(h.hidden, [true]);
    h.bus.emit("permissions:decision", { requestId: "ask" });
    t.mock.timers.tick(1);
    await tick();
    if (mode === "regular") assert.notEqual(h.pane(), original);
    else assert.deepEqual(h.hidden, [true, false]);
    assert.match(h.footer(), /keep this draft/);
    h.type("!");
    h.pane().handleInput("\r");
    assert.deepEqual(h.sent, [["run-b", "keep this draft!"]]);
    assert.equal(h.notices.at(-1).kind, "info");
    assert.match(h.notices.at(-1).message, /^Message queued.*delivery is not confirmed/);
    h.panels.dispose();
    await tick();
  });

test("opening another Agent before a docked yield reopens discards the old host-held draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = fixture(t);
  h.click("b");
  h.compose("discard this draft");
  h.bus.emit("permissions:ui_prompt", { requestId: "ask" });
  await tick();
  h.bus.emit("permissions:decision", { requestId: "ask" });
  // An explicit selection wins the deferred permission-reopen callback.
  h.click("a");
  t.mock.timers.tick(1);
  await tick();
  assert.equal(h.panes.length, 2);
  assert.doesNotMatch(h.footer(), /discard this draft|›/);
  h.pane().handleInput("\x1b");
  await tick();
  h.click("b");
  assert.doesNotMatch(h.footer(), /discard this draft|›/);
  h.pane().handleInput("\r");
  assert.deepEqual(h.sent, []);
});

test("an explicit opening consumes an older permission-reopen timer before the user closes it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = fixture(t);
  h.click("b");
  h.compose("discard this draft");
  h.bus.emit("permissions:ui_prompt", { requestId: "ask" });
  await tick();
  h.bus.emit("permissions:decision", { requestId: "ask" });
  h.click("a");
  h.pane().handleInput("\x1b");
  await tick();
  assert.equal(h.pane().isOpen(), false);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(h.panes.length, 2, "the superseded timer must not reopen the closed pane");
  assert.equal(h.pane().isOpen(), false);
  h.click("b");
  assert.doesNotMatch(h.footer(), /discard this draft|›/);
  assert.deepEqual(h.sent, []);
});

test("a docked yield never restores a draft onto a replacement Run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = fixture(t);
  h.click("b");
  h.compose("for the original task");
  h.bus.emit("permissions:ui_prompt", { requestId: "ask" });
  await tick();
  h.agents[1].view = { ...h.agents[1].view, run_id: "replacement-run-b", task: 2 };
  h.bus.emit("permissions:decision", { requestId: "ask" });
  t.mock.timers.tick(1);
  await tick();
  assert.doesNotMatch(h.footer(), /for the original task|›/);
  h.pane().handleInput("\r");
  assert.deepEqual(h.sent, []);
});

for (const [failure, reason] of [
  ["DELEGATION_OFF", "delegation is off"],
  ["RUN_INPUT_CLOSED", "not accepting input"],
  ["INPUT_LIMIT", "input limit"],
  ["INVALID_MESSAGE", "empty or too long"],
])
  for (const brokenNotify of [false, true])
    test(`message rejection keeps the draft and explains ${failure} (broken notify=${brokenNotify})`, async (t) => {
      const h = fixture(t, { failure, brokenNotify });
      const opening = h.open();
      h.compose("keep the refused message");
      assert.doesNotThrow(() => h.pane().handleInput("\r"));
      assert.deepEqual(h.sent, [["run-a", "keep the refused message"]]);
      assert.equal(h.wakes, 0);
      assert.match(h.footer(), /keep the refused message/);
      assert.equal(h.notices.at(-1).kind, "warning");
      assert(h.notices.at(-1).message.includes(reason));
      assert.match(h.notices.at(-1).message, /Your text is kept/);
      h.panels.dispose();
      await opening;
    });

for (const brokenNotify of [false, true])
  for (const brokenWake of [false, true])
    test(`accepted human input is never resent after display errors (notify=${brokenNotify}, wake=${brokenWake})`, async (t) => {
      const h = fixture(t, { brokenNotify, brokenWake });
      const opening = h.open();
      h.compose("one human correction");
      assert.doesNotThrow(() => h.pane().handleInput("\r"));
      assert.doesNotMatch(h.footer(), /›|one human correction/);
      h.pane().handleInput("\r");
      assert.deepEqual(h.sent, [["run-a", "one human correction"]]);
      assert.equal(h.wakes, 1);
      assert.match(h.notices.at(-1).message, /^Message queued.*delivery is not confirmed/);
      assert.equal(h.notices.at(-1).kind, brokenWake ? "warning" : "info");
      if (brokenWake) assert.match(h.notices.at(-1).message, /display refresh failed/);
      h.panels.dispose();
      await opening;
    });
