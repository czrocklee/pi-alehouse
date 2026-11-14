import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
import { managedBlockToolNames } from "../../src/shared/managed-block-tools.mjs";
import { flock } from "../support/flock.mjs";

// Source-import regression for a normal busy Agent: `agent_busy` describes
// reuse availability, never a session fault. It must not reach the attention
// collection, the Info diagnostics, the agent-tab markers or the footer's
// `!N`/`Info +N` alarms -- while real session errors, history/cleanup faults
// and questions keep alarming. The core fact stays literal: a busy Agent's
// older Run is still not resumable. Direct source via Jiti, no build, and a
// real OwnerController fixture for the genuine projected view.
const jiti = createJiti(import.meta.url, { fsCache: false });
const {
  getDetailAttentionNotes,
  renderDetailAttention,
  renderDetailFields,
  renderDetailInfo,
  renderDetailAgentStrip,
  renderDetailFooter,
} = await jiti.import("../../src/orchestration/ui/agent-detail-fields.ts");
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { OwnerController } = await jiti.import("../../src/orchestration/core/owner-controller.ts");
const { FileOwnerLease } = await jiti.import("../../src/orchestration/runtime/owner-lease.ts");
const { boundedOutput } = await jiti.import("../../src/orchestration/core/result-text.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
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
const task = (prompt, rest = {}) => ({ prompt, description: prompt, settings, ...rest });

/** The fake session port of the shared controller fixture, inlined so this
 * lane never depends on a built dist copy. */
class FakePort {
  session_id = randomUUID();
  calls = [];
  inputs = [];
  streaming = false;
  async run(prompt, callbacks) {
    const done = Promise.withResolvers();
    this.callbacks = callbacks;
    this.streaming = true;
    this.calls.push({ prompt, done });
    callbacks.inputEntered();
    callbacks.turnStart();
    try {
      return await done.promise;
    } finally {
      this.streaming = false;
    }
  }
  canInput() {
    return this.streaming;
  }
  finish(text = "done", kind = "success") {
    this.callbacks.output(boundedOutput(text, 1_048_576));
    this.callbacks.turnEnd();
    this.calls.at(-1).done.resolve({ kind, output: boundedOutput(text, 1_048_576) });
  }
  async steer(_message, valid) {
    return valid();
  }
  async stop() {}
  clearInputs() {
    return this.inputs.splice(0);
  }
  async dispose() {
    return { shutdownExited: true, errors: [] };
  }
}

const tick = async () => new Promise((resolve) => setImmediate(resolve));
const until = async (predicate) => {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("fixture condition timed out");
    await tick();
  }
};

/** A real OwnerController over a temp lease directory. Its `view()` is the
 * genuine core projection, not a hand-crafted RunView. */
async function busyFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-alehouse-busy-"));
  const ports = [];
  const owner = await FileOwnerLease.open({ directory, owner_id: randomUUID(), flock });
  const controller = await OwnerController.open({
    owner,
    concurrency: 1,
    resident_limit: 8,
    queue_limit: 16,
    managedBlockTools: managedBlockToolNames,
    createSession: async () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
  });
  t.after(async () => {
    for (const port of ports) if (port.streaming) port.finish("test cleanup", "aborted");
    const report = await controller.shutdown(1000);
    assert.equal(report.closed, true);
    await rm(directory, { recursive: true, force: true });
  });
  return { controller, ports };
}

/** A synthetic view of the same shape the controller projects. */
const view = (id, extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: id,
  run_id: `run-${id}`,
  name: id,
  task: 1,
  description: "Current task",
  status: "completed",
  phase: "settled",
  execution_exited: true,
  finalization_pending: false,
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
    model: "model",
    thinking: "high",
    parent_thinking: "high",
    thinking_resolution: "identity",
    preset: "default",
    preset_version: "v1",
    strength: "d3",
    difficulty: 3,
    tools: ["read"],
    cwd: "/workspace",
    context_mode: "none",
  },
  ...extra,
});

const transcript = () => ({
  lineCount: () => 3,
  slice: (_width, from, take) =>
    Array.from({ length: Math.max(0, Math.min(take, 3 - from)) }, (_v, i) => `ROW${from + i}`),
  invalidate() {},
});

/** A complete short pane: the geometry where hidden notes become `!N` and
 * `Info +N` cues, so a false alarm cannot hide behind a row budget. */
const shortPane = (t, entries, chosen) => {
  const p = new DetailPane({
    tui: { terminal: { columns: 60, rows: 6 }, requestRender() {} },
    theme,
    frame: true,
    initial: chosen,
    done() {},
    snapshot: () => entries,
    transcript,
  });
  t.after(() => p.dispose());
  return p;
};

test("real busy Agent views carry agent_busy without faults, completed or executing", async (t) => {
  const { controller, ports } = await busyFixture(t);
  const first = await controller.submit("busy-first", task("first task", { name: "月兔" }));
  await until(() => ports[0]?.streaming);
  ports[0].finish("first result");
  assert.equal(
    await controller.waitForRuns([first.run_id], { mode: "all", timeout_ms: 3000 }),
    "ready",
  );
  const reuse = await controller.submit("busy-reuse", {
    resume: first.agent_id,
    prompt: "follow up",
  });
  await until(() => ports[0].calls.length === 2);
  const busy = controller.view(first.run_id);
  // Core facts stay literal: the older Run is completed and NOT resumable
  // while its Agent runs newer work; agent_busy is a normal observation.
  assert.equal(busy.unavailable_reason, "agent_busy");
  assert.equal(busy.resumable, false);
  assert.equal(busy.status, "completed");
  assert.notEqual(reuse.run_id, first.run_id);
  const input = { view: busy, live };
  // The pure attention collection is empty: no session error note at all.
  assert.deepEqual(getDetailAttentionNotes(input), []);
  // Info lists every attention fact, so it shows no session diagnostic line.
  for (const width of [90, 120]) {
    const text = renderDetailInfo(input, theme, width).join("\n");
    assert.doesNotMatch(text, /^ {2}session\s/m, `${width}: ${text}`);
    assert.doesNotMatch(text, /agent_busy/, `${width}: ${text}`);
  }
  // The agent tab carries no false `?`/`!` marker for the busy reuse.
  const strip = renderDetailAgentStrip({
    entries: [
      { agent_id: busy.agent_id, input },
      { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
    ],
    selected: busy.agent_id,
    width: 60,
    spinnerFrame: 0,
    theme,
  });
  assert.doesNotMatch(strip.text, /[?!]/, strip.text);
  assert.equal(strip.markerVisible, false);
  const frame = renderDetailFooter({
    width: 60,
    entries: [
      { agent_id: busy.agent_id, input },
      { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
    ],
    selected: busy.agent_id,
    below: 0,
    view: busy,
    available: false,
    confirming: false,
    messaging: true,
    spinnerFrame: 0,
    theme,
    framed: false,
  });
  assert.doesNotMatch(frame.text, /[?!]/, frame.text);
  // A short pane counts hidden notes into `!N`/`Info +N`: a busy Agent must
  // not manufacture one.
  const p = shortPane(
    t,
    [
      { agent_id: busy.agent_id, input },
      { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
    ],
    busy.agent_id,
  );
  const flat = p.render(60).join("\n");
  assert.doesNotMatch(flat, /agent_busy/, flat);
  assert.doesNotMatch(flat, /!\d/, flat);
  assert.doesNotMatch(flat, /\+\d/, flat);
  assert.doesNotMatch(p.render(60).at(-1), /[?!]/, "the busy tab carries no marker");
  // The user-visible case: the Agent's CURRENT run is executing normally,
  // and its own view also carries agent_busy while it runs. The same normal
  // observation, not a fault: the running spinner stays and nothing alarms.
  const current = controller.view(reuse.run_id);
  assert.equal(current.status, "running");
  assert.equal(current.unavailable_reason, "agent_busy");
  assert.equal(current.resumable, false);
  assert.equal(current.execution_exited, false);
  const currentInput = { view: current, live };
  assert.deepEqual(getDetailAttentionNotes(currentInput), []);
  const currentInfo = renderDetailInfo(currentInput, theme, 120).join("\n");
  assert.doesNotMatch(currentInfo, /^ {2}session\s/m, currentInfo);
  assert.doesNotMatch(currentInfo, /agent_busy/, currentInfo);
  const currentEntries = [
    { agent_id: current.agent_id, input: currentInput },
    { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
  ];
  const currentStrip = renderDetailAgentStrip({
    entries: currentEntries,
    selected: current.agent_id,
    width: 60,
    spinnerFrame: 0,
    theme,
  });
  assert.match(currentStrip.text, /⠋/, "the running spinner stays on the tab");
  assert.doesNotMatch(currentStrip.text, /[?!]/, currentStrip.text);
  assert.equal(currentStrip.markerVisible, false);
  const currentPane = shortPane(t, currentEntries, current.agent_id);
  const currentFlat = currentPane.render(60).join("\n");
  assert.ok(currentFlat.includes("⠋"), "the pane keeps the running spinner");
  assert.doesNotMatch(currentFlat, /agent_busy/, currentFlat);
  assert.doesNotMatch(currentFlat, /!\d/, currentFlat);
  assert.doesNotMatch(currentFlat, /\+\d/, currentFlat);
  assert.doesNotMatch(
    currentPane.render(60).at(-1),
    /[?!]/,
    "the executing tab carries no false marker",
  );
});

test("a busy Agent's real warnings and questions are not suppressed", async (t) => {
  const { controller, ports } = await busyFixture(t);
  const first = await controller.submit("busy-first", task("first task", { name: "月兔" }));
  await until(() => ports[0]?.streaming);
  ports[0].finish("first result");
  assert.equal(
    await controller.waitForRuns([first.run_id], { mode: "all", timeout_ms: 3000 }),
    "ready",
  );
  await controller.submit("busy-reuse", { resume: first.agent_id, prompt: "follow up" });
  await until(() => ports[0].calls.length === 2);
  const busy = controller.view(first.run_id);
  assert.equal(busy.unavailable_reason, "agent_busy");
  // Real facts beside the busy observation: a question and a history warning.
  const mixed = {
    ...busy,
    history_error: "cold read failed",
    outcome: { status: "needs_input", question: "Which branch?", limit_reached: false },
  };
  const input = { view: mixed, live };
  const notes = getDetailAttentionNotes(input);
  assert.deepEqual(
    notes.map((note) => note.key),
    ["asked", "history"],
    "the busy observation adds no session note and removes no real one",
  );
  assert.equal(notes[0].severity, "question");
  assert.equal(notes[1].severity, "warning");
  const rows = renderDetailAttention(input, theme, 100);
  assert.match(rows[0], /\? asked: Which branch\?/);
  assert.match(rows[1], /! history: cold read failed/);
  // The tab keeps its `?!` marker, and a short pane still alarms.
  const entries = [
    { agent_id: mixed.agent_id, input },
    { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
  ];
  const strip = renderDetailAgentStrip({
    entries,
    selected: mixed.agent_id,
    width: 60,
    spinnerFrame: 0,
    theme,
  });
  assert.match(strip.text, /\?!/, strip.text);
  assert.equal(strip.markerVisible, true);
  const p = shortPane(t, entries, mixed.agent_id);
  assert.match(p.render(60).at(-1), /\?!/, "the real question and warning still alarm");
});

test("a real session error still alarms beside the busy exclusion", (t) => {
  const down = view("aspen", { unavailable_reason: "SESSION_UNAVAILABLE" });
  const input = { view: down, live };
  const notes = getDetailAttentionNotes(input);
  assert.deepEqual(
    notes.map((note) => [note.key, note.severity]),
    [["session", "error"]],
    "only agent_busy is excluded, never a real session error",
  );
  // Info shows the session diagnostic in its error colour.
  const marked = {
    fg: (color, text) => (color === "error" ? `«${text}»` : text),
    bold: (text) => text,
  };
  const text = renderDetailFields(input, marked, 90).join("\n");
  assert.match(text, /session\s+«SESSION_UNAVAILABLE»/, text);
  // The tab and a short pane still alarm for it.
  const entries = [
    { agent_id: "aspen", input },
    { agent_id: "peer", input: { view: view("peer", { status: "running" }), live } },
  ];
  const strip = renderDetailAgentStrip({
    entries,
    selected: "aspen",
    width: 60,
    spinnerFrame: 0,
    theme,
  });
  assert.match(strip.text, /aspen !/, strip.text);
  assert.equal(strip.markerVisible, true);
  const p = shortPane(t, entries, "aspen");
  assert.match(p.render(60).at(-1), /!/, "the session error keeps its alarm");
});

test("history and cleanup faults still alarm on a busy Agent's Run", () => {
  for (const [field, key, severity] of [
    [{ history_error: "cold read failed" }, "history", "warning"],
    [{ cleanup_errors: ["child did not exit"] }, "cleanup", "error"],
  ]) {
    const busy = view("aspen", { unavailable_reason: "agent_busy", ...field });
    const notes = getDetailAttentionNotes({ view: busy, live });
    assert.deepEqual(
      notes.map((note) => [note.key, note.severity]),
      [[key, severity]],
      "the busy observation neither adds a session note nor hides the fault",
    );
    const text = renderDetailFields({ view: busy, live }, theme, 90).join("\n");
    assert.doesNotMatch(text, /agent_busy/, text);
    assert.doesNotMatch(text, /^ {2}session\s/m, text);
  }
});

test("completed and old runs carrying agent_busy are equally non-faults", () => {
  for (const extra of [
    { status: "completed", execution_exited: true },
    { status: "cancelled", execution_exited: true },
  ]) {
    const busy = view("aspen", { unavailable_reason: "agent_busy", ...extra });
    const input = { view: busy, live };
    assert.deepEqual(getDetailAttentionNotes(input), []);
    const text = renderDetailInfo(input, theme, 120).join("\n");
    assert.doesNotMatch(text, /^ {2}session\s/m, text);
    assert.doesNotMatch(text, /agent_busy/, text);
  }
});
