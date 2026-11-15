import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createEventBus, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { settings } from "../support/controller-fixture.mjs";

// The UI bridge loads source through jiti (`fsCache: false`): ChildActivity
// renderer binding, AgentWidget detail projection, PanelCoordinator transcript
// source and the pane's captured factory. The settings fixture still statically
// imports dist; this is not an Owner lifecycle end-to-end test. Real native
// renderer functions and the SDK session surface belong to the SDK/API lanes;
// here the registry is a controlled display-callback stand-in.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
const { AgentWidget } = await jiti.import("../../src/orchestration/ui/agent-widget.ts");
const { ChildActivityRegistry } = await jiti.import(
  "../../src/orchestration/runtime/activity-observer.ts",
);

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const theme = { fg: (_color, text) => text, bold: (text) => text };

/** One resident Agent with a live in-memory child session and a bound
 * renderer registry, exactly as the runtime wires them: the observation owns
 * the binding, and the pane may only reach it through the widget's detail. */
function bridgedAgent(registry, id, toolName) {
  const activity = registry.track(id, settings.cwd);
  const handlers = new Map();
  activity.extension({ on: (event, handler) => handlers.set(event, handler) });
  const sessionManager = SessionManager.inMemory(settings.cwd);
  handlers.get("session_start")({}, { sessionManager });
  const calls = [];
  const renderers = {
    renderCall: (args, _theme, context) => {
      calls.push({ slot: "call", args, context });
      return new Text(`${id.toUpperCase()}_RENDERER_CALL`);
    },
    renderResult: (received, _options, _theme, _context) => {
      calls.push({ slot: "result", received });
      return new Text(`${id.toUpperCase()}_RENDERER_RESULT`);
    },
  };
  const lookup = (name) => {
    calls.push({ slot: "lookup", name });
    return name === toolName ? renderers : undefined;
  };
  // Bind after session_start: a new session retires any earlier binding.
  const unbind = activity.bindToolRenderers(lookup);
  sessionManager.appendMessage({ role: "user", content: `TASK_FOR_${id}`, timestamp: 0 });
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: `call-${id}`, name: toolName, arguments: { command: `echo ${id}` } },
    ],
    stopReason: "toolUse",
    timestamp: 1,
  });
  return { id, activity, sessionManager, calls, unbind };
}

/** The full bridge: registry-backed widget, coordinator, captured pane factory. */
function bridgedRoster(t, { ids = ["a", "b"], toolName = "bash", observe } = {}) {
  const activities = new ChildActivityRegistry();
  const agents = ids.map((id) => bridgedAgent(activities, id, toolName));
  const observations = observe?.(agents) ?? activities.observations;
  const paneTui = { terminal: { columns: 120, rows: 100 }, requestRender() {} };
  const views = agents.map(({ id }) => ({
    agent_id: id,
    run_id: `run-${id}`,
    name: `agent-${id}`,
    description: "renderer bridge fixture",
    status: "completed",
    phase: "settled",
    execution_exited: true,
    finalization_pending: false,
    resident: true,
    resumable: true,
    owner_blocked: false,
    pending_messages: 0,
    isolation: "shared",
    elapsed_ms: 1,
    turns: 1,
    max_turns: 8,
    cleanup_errors: [],
    discarded_inputs: [],
    effective_settings: settings,
  }));
  const widget = new AgentWidget(
    {
      presentationRevision: 1,
      list: () => views,
      stats: () => ({ resident: views.length, cleanup_uncertain: false }),
    },
    8,
    observations,
    (visible) => activities.retain(visible),
  );
  widget.setUi({}); // Projection updates work without mounting or painting a widget.
  const shortcuts = new Map(),
    bus = createEventBus(),
    notices = [];
  let pane;
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget,
    ready: () => true,
    router() {
      throw new Error("unused");
    },
    publish() {},
    showError() {},
  });
  panels.attachHost(
    {
      mode: "tui",
      ui: {
        notify(message) {
          notices.push(message);
        },
        custom(factory) {
          return new Promise((resolve) => {
            pane = factory(paneTui, theme, {}, resolve);
          });
        },
      },
    },
    bus,
  );
  t.after(() => {
    panels.dispose();
    widget.dispose();
    activities.clear();
    assert.deepEqual(notices, [], "no unexpected UI failures");
  });
  return {
    agents,
    widget,
    activities,
    paneTui,
    pane: () => pane,
    open: () => shortcuts.get("alt+a").handler(),
    transcript: () => pane.render(120).join("\n").split("Transcript · Info")[1] ?? "",
  };
}

test("the bridge renders the selected agent's registry renderer in the pane", async (t) => {
  const h = bridgedRoster(t);
  const opening = h.open();
  const a = h.agents[0];
  const text = h.transcript();
  assert.match(text, /A_RENDERER_CALL/, "the pane paints the registry's call renderer");
  assert.match(text, /TASK_FOR_a/, "and the recorded child history");
  const seen = a.calls.filter((entry) => entry.slot === "call");
  assert.ok(seen.length > 0, "the renderer was invoked through the whole bridge");
  assert.equal(seen[0].args.command, "echo a", "with the recorded arguments");
  assert.equal(seen[0].context.argsComplete, false, "history is never marked args-complete");
  assert.ok(
    a.calls.some((entry) => entry.slot === "lookup" && entry.name === "bash"),
    "the live session registry was queried by name",
  );
  h.pane().handleInput("\x1b");
  await opening;
});

test("the transcript source follows the pane's selection, not one shared registry", async (t) => {
  const h = bridgedRoster(t);
  const opening = h.open();
  const [a, b] = h.agents;
  assert.match(h.transcript(), /A_RENDERER_CALL/);
  const callsA = a.calls.length,
    callsB = b.calls.length;
  h.pane().activate("b");
  const switched = h.transcript();
  assert.match(switched, /B_RENDERER_CALL/, "the newly selected agent's renderer paints");
  assert.match(switched, /TASK_FOR_b/, "with its own recorded history");
  assert.doesNotMatch(switched, /A_RENDERER_CALL|TASK_FOR_a/, "not the previous agent's");
  assert.equal(a.calls.length, callsA, "the unselected agent's renderer is not invoked");
  assert.ok(b.calls.length > callsB, "the selected agent's registry answers instead");
  assert.ok(
    b.calls.some((entry) => entry.slot === "lookup" && entry.name === "bash"),
    "through its own observation binding",
  );
  h.pane().activate("a");
  assert.match(h.transcript(), /A_RENDERER_CALL/, "switching back repaints the first agent");
  h.pane().handleInput("\x1b");
  await opening;
});

test("an unbind changes presentation version and the next paint uses raw cards", async (t) => {
  const h = bridgedRoster(t);
  const opening = h.open();
  const a = h.agents[0];
  assert.match(h.transcript(), /A_RENDERER_CALL/);
  // Production unbind changes both activity revision and binding token; this
  // checks their combined invalidation, not which key entry caused it.
  h.widget.agents();
  const before = h.widget.presentationVersion();
  a.unbind();
  const after = h.widget.presentationVersion();
  assert.notEqual(after, before, "an unbind changes the presentation version");
  const lookups = a.calls.filter((entry) => entry.slot === "lookup").length;
  const renders = a.calls.filter((entry) => entry.slot === "call").length;
  h.widget.wake();
  const text = h.transcript();
  assert.doesNotMatch(text, /A_RENDERER_CALL/, "the retired callback paints nothing");
  assert.equal(
    a.calls.filter((entry) => entry.slot === "call").length,
    renders,
    "and is never invoked again",
  );
  assert.equal(
    a.calls.filter((entry) => entry.slot === "lookup").length,
    lookups,
    "an unbound session is not queried either",
  );
  assert.match(text, /bash/, "the card falls back to bounded raw rendering");
  assert.match(text, /echo a/, "with its recorded arguments");
  assert.match(text, /TASK_FOR_a/, "and the recorded history stays on screen");
  h.pane().handleInput("\x1b");
  await opening;
});

test("a binding token alone changes the version and requests a settled pane repaint", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let token = Object.freeze({}),
    bound = true,
    observation;
  const h = bridgedRoster(t, {
    ids: ["a"],
    observe: ([{ activity }]) => {
      const history = activity.historyState(),
        entries = activity.entries(),
        live = activity.snapshot();
      // Structural observations may keep their other presentation hints fixed.
      // Only this independent binding token/resolver changes in the test.
      observation = {
        presentationRevision: 7,
        historyState: () => history,
        entries: () => entries,
        snapshot: () => live,
        inFlight: () => undefined,
        get toolRenderersRevision() {
          return token;
        },
        toolRenderers: (name) => (bound ? activity.toolRenderers(name) : undefined),
      };
      return { get: (id) => (id === "a" ? observation : undefined) };
    },
  });
  const requests = t.mock.method(h.paneTui, "requestRender");
  const opening = h.open();
  assert.match(h.transcript(), /A_RENDERER_CALL/);
  const before = h.widget.presentationVersion(),
    history = observation.historyState(),
    entries = observation.entries(),
    renders = h.agents[0].calls.filter((entry) => entry.slot === "call").length;
  assert.ok(history, "history has a stable identity rather than forcing conservative polling");
  assert.ok(entries, "recorded entries remain available");
  t.mock.timers.tick(120);
  assert.equal(requests.mock.callCount(), 0, "an unchanged settled pane does not animate");

  // No wake(), fresh projection or manual paint until the timer request is
  // observed: those would invalidate the key independently and mask its loss.
  bound = false;
  token = Object.freeze({});
  assert.equal(observation.presentationRevision, 7);
  assert.equal(observation.historyState(), history);
  assert.equal(observation.entries(), entries);
  t.mock.timers.tick(119);
  assert.equal(requests.mock.callCount(), 0, "no repaint before the next pane timer tick");
  t.mock.timers.tick(1);
  assert.equal(requests.mock.callCount(), 1, "the 120ms pane timer calls requestRender");
  assert.notEqual(
    h.widget.presentationVersion(),
    before,
    "the binding token alone changes version",
  );

  // A requested repaint is not host scheduling/paint proof; inspect pixels
  // separately, only after the timer assertion above.
  const text = h.transcript();
  assert.doesNotMatch(text, /A_RENDERER_CALL/);
  assert.match(text, /echo a/);
  assert.match(text, /TASK_FOR_a/);
  assert.equal(h.agents[0].calls.filter((entry) => entry.slot === "call").length, renders);
  t.mock.timers.tick(120);
  assert.equal(requests.mock.callCount(), 1, "the repainted settled pane is quiet again");
  h.pane().handleInput("\x1b");
  await opening;
});

test("a pane T toggle after an unbind retires callbacks through the production render path", async (t) => {
  const h = bridgedRoster(t);
  const opening = h.open();
  const a = h.agents[0];
  assert.match(h.transcript(), /A_RENDERER_CALL/);
  // Switch agents, flip the pane's tools-expansion (the T key), then unbind the
  // first agent's registry before switching back to it.
  h.pane().activate("b");
  assert.match(h.transcript(), /B_RENDERER_CALL/);
  h.pane().handleInput("t");
  a.unbind();
  const calls = a.calls.filter((entry) => entry.slot === "call").length;
  h.pane().activate("a");
  // The pane's render applies setToolsExpanded() to the transcript BEFORE it
  // frames it: that entry must retire the unbound cards itself, so the old
  // callback never runs and the frame is generic raw with history intact.
  const text = h.transcript();
  assert.doesNotMatch(text, /A_RENDERER_CALL/, "the retired callback paints nothing");
  assert.equal(
    a.calls.filter((entry) => entry.slot === "call").length,
    calls,
    "and is never invoked again",
  );
  assert.match(text, /bash/, "the card falls back to bounded raw rendering");
  assert.match(text, /echo a/, "with its recorded arguments");
  assert.match(text, /TASK_FOR_a/, "and the recorded history stays on screen");
  h.pane().handleInput("\x1b");
  await opening;
});
