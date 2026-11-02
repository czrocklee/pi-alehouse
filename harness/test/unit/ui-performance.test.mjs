import assert from "node:assert/strict";
import test from "node:test";
import { Marked } from "marked";
import { Markdown, MouseRegion, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, createEventBus, getMarkdownTheme, initTheme, SessionManager,
  sessionEntryToContextMessages, UserMessageComponent }
  from "@earendil-works/pi-coding-agent";
import { ChildActivityRegistry } from "../../dist/runtime/activity-observer.js";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";
import { DetailPane } from "../../dist/ui/agent-detail.js";
import { PanelCoordinator } from "../../dist/ui/panel-coordinator.js";
import { TranscriptContent } from "../../dist/ui/transcript.js";
import { wrapPlainText } from "../../dist/ui/text.js";
import { settings } from "../support/controller-fixture.mjs";

initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: text => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
const view = (extra = {}) => ({ owner_id: "owner", generation: "generation", agent_id: "a", run_id: "r", task: 1,
  name: "orca", description: "Synthetic performance fixture", status: "running", phase: "executing",
  execution_exited: false, finalization_pending: false, resident: true, resumable: false,
  owner_blocked: false, pending_messages: 0, has_question: false, isolation: "shared", elapsed_ms: 1000,
  execution_elapsed_ms: 200, turn_elapsed_ms: 300, turns: 1, max_turns: 8, cleanup_errors: [], discarded_inputs: [],
  effective_settings: { ...settings, context_mode: "none" }, ...extra });
const detail = v => [{ agent_id: v.agent_id, input: { view: v, live } }];
function clock(t) {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  return { advance(ms) { now += ms; } };
}
function widgetFixture(t, initial = view()) {
  let current = initial, revision = 0, lists = 0, stats = 0, renders = 0, component;
  const controller = { get presentationRevision() { return revision; },
    list() { lists++; return [structuredClone(current)]; },
    stats() { stats++; return { resident: Number(current.resident), cleanup_uncertain: false }; } };
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget(controller, 12, activities.observations, ids => activities.retain(ids));
  const tui = { mode: "fullscreen", terminal: { columns: 160, rows: 60 }, requestRender() { renders++; } };
  widget.setUi({ setWidget(_key, factory) { component = factory?.(tui, theme); } });
  t.after(() => { widget.dispose(); activities.clear(); });
  return { widget, activities, tui, counts: () => ({ lists, stats, renders }),
    component: () => component, paint: () => component?.render(tui.terminal.columns) ?? [],
    change(next, bumpRevision = true) { current = next; if (bumpRevision) revision++; } };
}

test("animation ticks avoid roster/stats/clones while clocks and independent activity keep changing", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const time = clock(t), h = widgetFixture(t);
  const child = h.activities.track("a", settings.cwd), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  const snapshots = t.mock.method(child, "snapshot", child.snapshot.bind(child));
  h.widget.wake(); h.paint();
  const held = h.counts();
  for (let i = 0; i < 20; i++) { time.advance(80); t.mock.timers.tick(80); h.paint(); }
  assert.equal(h.counts().lists, held.lists); assert.equal(h.counts().stats, held.stats);
  assert.equal(snapshots.mock.callCount(), 1, "spinner ticks do not resample unchanged activity");
  assert(h.counts().renders > held.renders, "visible animation has not been slowed or dropped");
  assert.match(h.paint().join("\n"), /2\.6s/);
  const message = { role: "assistant", content: [{ type: "text", text: "INDEPENDENT_PREVIEW" }] };
  handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta", contentIndex: 0,
    partial: message, delta: "INDEPENDENT_PREVIEW" } });
  t.mock.timers.tick(80);
  assert.match(h.paint().join("\n"), /INDEPENDENT_PREVIEW/);
  handlers.get("tool_execution_start")({ toolCallId: "tool", toolName: "read", args: { path: "/tmp/visible.ts" } });
  t.mock.timers.tick(80);
  assert.match(h.paint().join("\n"), /reading visible\.ts/);
  handlers.get("tool_execution_end")({ toolCallId: "tool" }); t.mock.timers.tick(80);
  assert.match(h.paint().join("\n"), /▸1/);
  assert.equal(h.counts().lists, held.lists); assert.equal(h.counts().stats, held.stats);
  h.change(view({ turns: 4, drain: { waiting_for: "sdk_idle", elapsed_ms: 500 } }));
  t.mock.timers.tick(80); h.paint();
  assert.equal(h.counts().lists, held.lists + 1); assert.equal(h.counts().stats, held.stats + 1);
  assert.match(h.paint().join("\n"), /↻4≤8|draining/);
  const first = h.widget.presentationAgents()[0].view, count = h.counts().lists;
  time.advance(1000);
  const later = h.widget.presentationAgents()[0].view;
  assert.equal(h.counts().lists, count);
  assert.equal(later.elapsed_ms - first.elapsed_ms, 1000);
  assert.equal(later.turn_elapsed_ms - first.turn_elapsed_ms, 1000);
  assert.equal(later.execution_elapsed_ms - first.execution_elapsed_ms, 1000);
  assert.equal(later.drain.elapsed_ms - first.drain.elapsed_ms, 1000);
  h.change(view({ status: "completed", execution_exited: true })); t.mock.timers.tick(80); h.paint();
  const idle = h.counts(); time.advance(20000); t.mock.timers.tick(20000);
  assert.deepEqual(h.counts(), idle, "settlement stops autonomous widget ticks");
  h.widget.wake(); assert.equal(h.counts().lists, idle.lists + 1, "explicit wake stays fresh");
  h.widget.agents(); assert.equal(h.counts().lists, idle.lists + 2, "explicit inspection stays fresh");
});

for (const kind of ["thinking", "text", "preparing"]) test(`same-Owner-revision timer clears sampled ${kind} fields when live omits them`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const time = clock(t), h = widgetFixture(t, view({ pending_messages: 3,
    runtime: { activity: "generating", context: { tokens: 17, context_window: 100 } } }));
  const child = h.activities.track("a", settings.cwd), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  const part = kind === "thinking" ? { type: "thinking", thinking: "SAMPLED_THOUGHT" } :
    kind === "text" ? { type: "text", text: "SAMPLED_PROSE" } :
    { type: "toolCall", id: "draft", name: "write", arguments: {} };
  const message = { role: "assistant", content: [part] };
  handlers.get("message_update")({ message, assistantMessageEvent: {
    type: kind === "preparing" ? "toolcall_start" : `${kind}_delta`, contentIndex: 0, partial: message,
    delta: kind === "thinking" ? "SAMPLED_THOUGHT" : "SAMPLED_PROSE",
  } });
  const sampled = child.snapshot();
  if (kind === "thinking") { assert.equal(sampled.thinking, "SAMPLED_THOUGHT"); assert.equal(sampled.channel, "thinking"); }
  else if (kind === "text") assert.equal(sampled.channel, "text");
  else assert.equal(sampled.preparing_tool, "write");
  const snapshots = t.mock.method(child, "snapshot", child.snapshot.bind(child));
  h.widget.wake();
  assert.match(h.paint()[2], kind === "thinking" ? /thinking: SAMPLED_THOUGHT/ :
    kind === "text" ? /replying: SAMPLED_PROSE/ : /preparing write…/);
  const held = h.counts();
  child.begin();
  const cleared = child.snapshot();
  for (const field of ["thinking", "channel", "preparing_tool"])
    assert.equal(Object.hasOwn(cleared, field), false, `the real observer omits cleared ${field}`);
  time.advance(80); t.mock.timers.tick(80);
  assert.match(h.paint()[2], /thinking…$/, "the next animation frame must use the cleared live state");
  assert.doesNotMatch(h.paint()[2], /SAMPLED_THOUGHT|SAMPLED_PROSE|replying|preparing/);
  const clearReads = snapshots.mock.callCount();
  for (let i = 0; i < 5; i++) { time.advance(80); t.mock.timers.tick(80); h.paint(); }
  assert.equal(snapshots.mock.callCount(), clearReads, "unchanged animation reuses the cleared activity snapshot");
  const draft = { role: "assistant", content: [{ type: "text", text: "NEW_DELTA" }] };
  handlers.get("message_update")({ message: draft, assistantMessageEvent: { type: "text_delta", contentIndex: 0,
    partial: draft, delta: "NEW_DELTA" } });
  time.advance(80); t.mock.timers.tick(80);
  assert.match(h.paint()[2], /replying: NEW_DELTA/);
  handlers.get("tool_execution_start")({ toolCallId: "read", toolName: "read", args: { path: "/tmp/fresh.ts" } });
  time.advance(80); t.mock.timers.tick(80); assert.match(h.paint()[2], /reading fresh\.ts/);
  handlers.get("tool_execution_end")({ toolCallId: "read" });
  time.advance(80); t.mock.timers.tick(80);
  const lines = h.paint();
  assert.match(lines[1], /▸1/); assert.match(lines[1], /ctx 17\.0%/); assert.match(lines[1], /3 pending/);
  assert.match(lines[2], /replying: NEW_DELTA/);
  assert.equal(h.counts().lists, held.lists); assert.equal(h.counts().stats, held.stats);
  assert(h.counts().renders > held.renders, "live clearing and later updates retain visible animation without Owner rescans");
});

for (const refresh of ["agents", "wake"]) test(`explicit ${refresh} refresh retires pane caches without an Owner revision edge`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = widgetFixture(t, view({ status: "completed", execution_exited: true }));
  h.widget.wake();
  assert.equal(h.widget.presentationAgents()[0].view.unavailable_reason, undefined);
  const beforeVersion = h.widget.presentationVersion();
  const pane = new DetailPane({ tui: h.tui, theme, initial: "a", done() {},
    revision: () => h.widget.presentationVersion(),
    snapshot: () => h.widget.presentationAgents().map(agent => ({ agent_id: agent.agent_id,
      input: { view: agent.view, live: agent.live } })),
    transcript: () => undefined });
  t.after(() => pane.dispose());
  pane.render(160);
  h.change(view({ status: "completed", execution_exited: true, unavailable_reason: "LEASE_HEALTH_CHANGED" }), false);
  assert.equal(h.widget.presentationAgents()[0].view.unavailable_reason, undefined,
    "presentation alone retains the detached snapshot until an explicit fresh read");
  const beforeFresh = h.counts();
  if (refresh === "agents") assert.equal(h.widget.agents()[0].view.unavailable_reason, "LEASE_HEALTH_CHANGED");
  else h.widget.wake();
  assert.equal(h.counts().lists, beforeFresh.lists + 1, "explicit freshness still resamples the controller/lease");
  assert.equal(h.counts().stats, beforeFresh.stats + Number(refresh === "wake"));
  assert.notEqual(h.widget.presentationVersion(), beforeVersion, "explicit freshness must also wake an already-open idle pane");
  const fresh = h.counts();
  t.mock.timers.tick(120);
  assert(h.counts().renders > fresh.renders, "the idle pane must not suppress the explicit refresh repaint");
  assert.equal(h.widget.presentationAgents()[0].view.unavailable_reason, "LEASE_HEALTH_CHANGED");
  assert.match(pane.render(160).join("\n"), /LEASE_HEALTH_CHANGED/);
  assert.equal(h.counts().lists, fresh.lists, "the fresh batch is shared with the pane instead of listing again");
  assert.equal(h.counts().stats, fresh.stats);
  const cached = h.counts(), stableVersion = h.widget.presentationVersion();
  for (let i = 0; i < 10; i++) {
    h.widget.presentationAgents();
    assert.equal(h.widget.presentationVersion(), stableVersion);
  }
  t.mock.timers.tick(1200);
  assert.deepEqual(h.counts(), cached, "freshness invalidation does not turn animation/pane reads into repeated roster/stats scans");
});

test("fresh views seed pane clocks once, while Stop still takes an independent fresh read", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const time = clock(t), h = widgetFixture(t);
  h.widget.wake(); h.widget.presentationAgents();
  time.advance(500);
  h.change(view({ elapsed_ms: 9000, execution_elapsed_ms: 2000, turn_elapsed_ms: 1000,
    drain: { waiting_for: "sdk_idle", elapsed_ms: 500 } }), false);
  const before = h.counts();
  const fresh = h.widget.agents()[0].view;
  assert.equal(h.counts().lists, before.lists + 1);
  assert.deepEqual(h.widget.presentationAgents()[0].view, fresh);
  time.advance(250);
  const later = h.widget.presentationAgents()[0].view;
  assert.equal(later.elapsed_ms, 9250); assert.equal(later.execution_elapsed_ms, 2250);
  assert.equal(later.turn_elapsed_ms, 1250); assert.equal(later.drain.elapsed_ms, 750);
  assert.equal(h.counts().lists, before.lists + 1, "clock paints do not resample the shared fresh batch");

  // A paint is not command evidence, even when that paint's batch was just refreshed.
  const stopped = [], pane = new DetailPane({ tui: h.tui, theme, initial: "a", done() {},
    snapshot: () => h.widget.presentationAgents().map(agent => ({ agent_id: agent.agent_id,
      input: { view: agent.view, live: agent.live } })),
    freshSnapshot: () => h.widget.agents().map(agent => ({ agent_id: agent.agent_id,
      input: { view: agent.view, live: agent.live } })), transcript: () => undefined,
    onStop: id => stopped.push(id) });
  t.after(() => pane.dispose());
  pane.render(160);
  h.change(view({ run_id: "replacement" }), false);
  const painted = h.counts();
  pane.handleInput("s");
  assert.equal(h.counts().lists, painted.lists + 1, "Stop cannot reuse the valid-looking presentation cache");
  assert.doesNotMatch(pane.render(160).at(-1), /Confirm stop/);
  assert.deepEqual(stopped, [], "the stale painted Run cannot redirect Stop to replacement work");
  assert.equal(h.widget.presentationAgents()[0].view.run_id, "replacement");
  assert.equal(h.counts().lists, painted.lists + 1, "the fresh Stop read also becomes the next pane baseline");
});

test("an off-screen widget animation never requests a whole-TUI repaint", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = widgetFixture(t); h.tui.terminal.rows = 0;
  h.widget.wake(); assert.deepEqual(h.paint(), []);
  const held = h.counts(); t.mock.timers.tick(800);
  assert.deepEqual(h.counts(), held);
});

test("pane frames capture one snapshot and one transcript frame; idle/hidden ticks do not repaint", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let revision = 0, snapshots = 0, frames = 0, renders = 0, visible = true;
  let current = view({ status: "completed", execution_exited: true });
  const pane = new DetailPane({ tui: { terminal: { columns: 120, rows: 40 }, requestRender() { renders++; } },
    theme, initial: "a", done() {}, revision: () => revision, visible: () => visible,
    snapshot: () => { snapshots++; return detail(current); }, transcript: () => ({
      frame() { frames++; return { lineCount: 40, slice: (start, count) => Array.from({ length: count }, (_, i) => `T${start + i}`) }; },
      lineCount() { assert.fail("frame-aware pane must not project twice"); },
      slice() { assert.fail("frame-aware pane must reuse its captured transcript"); }, invalidate() {},
    }) });
  t.after(() => pane.dispose());
  pane.render(120); assert.equal(snapshots, 1); assert.equal(frames, 1);
  t.mock.timers.tick(1200); assert.equal(renders, 0); assert.equal(snapshots, 1);
  revision++; t.mock.timers.tick(120); assert.equal(renders, 1);
  pane.render(120); assert.equal(snapshots, 2); assert.equal(frames, 2);
  current = view(); revision++; t.mock.timers.tick(120); pane.render(120);
  const active = renders; t.mock.timers.tick(120); assert.equal(renders, active + 1);
  visible = false; const hidden = renders; t.mock.timers.tick(1200); assert.equal(renders, hidden);
  pane.dispose(); t.mock.timers.tick(1200); assert.equal(renders, hidden);
});

test("Stop bypasses presentation caches, and expiry is checked and repainted on input without a timer", t => {
  const time = clock(t), cached = view();
  let fresh = view({ status: "completed", execution_exited: true }), stops = 0, renders = 0, freshReads = 0;
  const pane = new DetailPane({ tui: { terminal: { columns: 120, rows: 40 }, requestRender() { renders++; } },
    theme, initial: "a", done() {}, snapshot: () => detail(cached), revision: () => 1,
    freshSnapshot: () => { freshReads++; return detail(fresh); }, transcript: () => undefined, onStop() { stops++; } });
  t.after(() => pane.dispose());
  pane.render(120); pane.handleInput("s");
  assert.doesNotMatch(pane.render(120).at(-1), /Confirm stop/, "stale running presentation is not authority");
  assert.equal(freshReads, 1);
  fresh = view(); pane.handleInput("s"); assert.match(pane.render(120).at(-1), /Confirm stop/);
  const held = renders; time.advance(10000); pane.handleInput("\x13");
  assert.equal(stops, 0); assert(renders > held, "expiry updates the visible hint even without a background repaint");
  assert.match(pane.render(120).at(-1), /\[S Stop\]/);
  pane.handleInput("s"); pane.render(120); fresh = view({ run_id: "replacement" }); pane.handleInput("\x13");
  assert.equal(stops, 0, "confirmation cannot follow replacement work");
});

test("transcript frame samples messages and streaming once, with stable settled components across frames", t => {
  let messagesReads = 0, tailReads = 0;
  const messages = [{ role: "user", content: "SETTLED_BLOCK", timestamp: 0 }];
  const streaming = { role: "assistant", stopReason: "pending", content: [{ type: "text", text: "STREAM_ONE" }] };
  const render = t.mock.method(UserMessageComponent.prototype, "render", UserMessageComponent.prototype.render);
  const content = new TranscriptContent({ tui: { requestRender() {}, terminal: { columns: 120, rows: 40 } },
    cwd: settings.cwd, markdownTheme: getMarkdownTheme(), source: {
      messages() { messagesReads++; return messages; }, inFlight() { tailReads++; return streaming; }, toolDefinition() {},
    } });
  t.after(() => content.dispose());
  let frame = content.frame(120);
  assert.match(frame.slice(0, frame.lineCount).join("\n"), /STREAM_ONE/);
  frame.slice(0, 2); frame.slice(2, 2);
  assert.equal(messagesReads, 1); assert.equal(tailReads, 1);
  const settledRenders = render.mock.callCount();
  streaming.content[0].text = "STREAM_TWO";
  frame = content.frame(120);
  assert.match(frame.slice(0, frame.lineCount).join("\n"), /STREAM_TWO/);
  assert.equal(render.mock.callCount(), settledRenders, "streaming cannot rebuild settled blocks");
  const replacement = { ...getMarkdownTheme(), heading: text => `\x1b[35m${text}\x1b[39m` };
  content.setTheme(replacement); content.frame(120);
  assert(render.mock.callCount() > settledRenders, "an explicit custom MarkdownTheme replacement rebuilds captured components");
});

test("ordinary pane invalidation keeps assistant Markdown/parse caches; real palette changes rebuild ANSI correctly", async t => {
  initTheme("dark", false);
  t.after(() => initTheme(undefined, false));
  const h = widgetFixture(t, view({ status: "completed", execution_exited: true }));
  const child = h.activities.track("a", settings.cwd), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  const session = SessionManager.inMemory(settings.cwd);
  session.appendMessage({ role: "user", timestamp: 0,
    content: "# THEME_HEADING\n\n**Static content** and `inline` after resets\n\n```javascript\nconst palette = 1;\n```" });
  session.appendMessage({ role: "assistant", timestamp: 1, stopReason: "stop", content: [
    { type: "thinking", thinking: "**THINKING_STYLE** and restored text" },
    { type: "text", text: "# ASSISTANT_HEADING\n\n**Assistant prose** and `inline` restored" },
  ] });
  session.appendMessage({ role: "assistant", timestamp: 2, stopReason: "error", errorMessage: "ERROR_ANSI_MARKER",
    content: [{ type: "text", text: "PARTIAL_ERROR_RESPONSE" }] });
  handlers.get("session_start")({}, { sessionManager: session });
  const users = new Set(), markdowns = new Set();
  const originalUserRender = UserMessageComponent.prototype.render, originalMarkdownRender = Markdown.prototype.render;
  t.mock.method(UserMessageComponent.prototype, "render", function (width) {
    users.add(this); return originalUserRender.call(this, width);
  });
  t.mock.method(Markdown.prototype, "render", function (width) {
    markdowns.add(this); return originalMarkdownRender.call(this, width);
  });
  const updates = t.mock.method(AssistantMessageComponent.prototype, "updateContent", AssistantMessageComponent.prototype.updateContent);
  const regions = t.mock.method(MouseRegion.prototype, "invalidate", MouseRegion.prototype.invalidate);
  const lexer = t.mock.method(Marked.prototype, "lexer", Marked.prototype.lexer);
  const replacements = t.mock.method(TranscriptContent.prototype, "setTheme", TranscriptContent.prototype.setTheme);
  let transcriptRows;
  const originalFrame = TranscriptContent.prototype.frame;
  t.mock.method(TranscriptContent.prototype, "frame", function (width) {
    const frame = originalFrame.call(this, width);
    transcriptRows = frame.slice(0, frame.lineCount).join("\n");
    return frame;
  });
  // Model the SDK's public immutable colors-generation getter. Its containing
  // Theme projection stays identical; only a real palette edge advances it.
  let palette = Object.freeze({});
  const paneTheme = { ...theme, get colors() { return palette; } };
  const shortcuts = new Map(), bus = createEventBus();
  const panels = new PanelCoordinator({ pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget: h.widget, ready: () => true, router() {}, publish() {}, showError() {} });
  let pane;
  panels.attachHost({ mode: "tui", ui: { notify() { assert.fail("synthetic theme panel unexpectedly notified"); },
    custom(factory) { return new Promise(resolve => { pane = factory(h.tui, paneTheme, {}, resolve); }); } } }, bus);
  t.after(() => panels.dispose());
  const opening = shortcuts.get("alt+a").handler();
  const paint = () => pane.render(160).join("\n");
  const markdownTheme = getMarkdownTheme(), darkHeading = markdownTheme.heading("PROBE");
  const darkCode = markdownTheme.highlightCode("const palette = 1;", "javascript").join("\n");
  const dark = paint(), darkTranscript = transcriptRows, reads = h.counts().lists;
  for (const marker of ["THEME_HEADING", "ASSISTANT_HEADING", "THINKING_STYLE", "ERROR_ANSI_MARKER"])
    assert(stripTerminalSequences(darkTranscript).includes(marker));
  assert.equal(users.size, 1); assert(markdowns.size >= 4);
  assert(updates.mock.callCount() >= 2 && lexer.mock.callCount() > 0, "assistant rebuild and real SDK Markdown parsing are instrumented");
  const parses = lexer.mock.callCount(), assistantUpdates = updates.mock.callCount(), components = markdowns.size;
  const regionInvalidations = regions.mock.callCount();
  // Keep this burst synchronous: weak token caches may be collected after a
  // job, but layout invalidation must not discard them or their Markdown owner.
  for (let i = 0; i < 10; i++) { pane.invalidate(); assert.equal(paint(), dark); }
  assert.equal(users.size, 1);
  assert(regions.mock.callCount() > regionInvalidations, "the real assistant thinking wrapper uses public MouseRegion.invalidate");
  assert.equal(markdowns.size, components, "layout invalidation does not reconstruct assistant/thinking Markdown");
  assert.equal(updates.mock.callCount(), assistantUpdates, "layout invalidation bypasses native Assistant.invalidate rebuilding");
  assert.equal(lexer.mock.callCount(), parses, "ordinary invalidation retains both user and assistant token caches");
  assert.equal(replacements.mock.callCount(), 0);

  initTheme("light", false); palette = Object.freeze({});
  assert.notEqual(markdownTheme.heading("PROBE"), darkHeading);
  assert.notEqual(markdownTheme.highlightCode("const palette = 1;", "javascript").join("\n"), darkCode);
  pane.invalidate();
  const light = paint(), lightTranscript = transcriptRows;
  assert.notEqual(light, dark); assert.equal(stripTerminalSequences(light), stripTerminalSequences(dark));
  assert.equal(replacements.mock.callCount(), 1, "the immutable palette generation, not the Theme reference, triggers rebuild");
  assert(updates.mock.callCount() > assistantUpdates && markdowns.size > components);
  const reference = new TranscriptContent({ tui: h.tui, cwd: settings.cwd, markdownTheme: getMarkdownTheme(), source: {
    messages: () => session.buildContextEntries().flatMap(sessionEntryToContextMessages), inFlight: () => undefined, toolDefinition() {},
  } });
  try {
    const frame = reference.frame(160);
    assert.equal(lightTranscript, frame.slice(0, frame.lineCount).join("\n"),
      "all default-style prefixes, thinking, syntax and literal error ANSI equal a fresh real-light-theme transcript");
  } finally { reference.dispose(); }
  initTheme("dark", false); palette = Object.freeze({}); pane.invalidate();
  assert.equal(paint(), dark); assert.equal(transcriptRows, darkTranscript);
  assert.equal(replacements.mock.callCount(), 2);
  palette = undefined; pane.invalidate(); paint();
  assert.equal(replacements.mock.callCount(), 3, "missing colors capability conservatively rebuilds");
  palette = {}; pane.invalidate(); paint();
  assert.equal(replacements.mock.callCount(), 4, "mutable palette capabilities cannot safely serve as generations");
  assert.equal(h.counts().lists, reads, "invalidating native components does not resample the Owner");
  panels.dispose(); await opening;
});

test("child history caches by session/leaf/count, including custom tails, branches and compaction", async t => {
  const h = widgetFixture(t, view({ status: "completed", execution_exited: true }));
  const child = h.activities.track("a", settings.cwd), handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  const session = SessionManager.inMemory(settings.cwd);
  const root = session.appendMessage({ role: "user", content: "BRANCH_ROOT", timestamp: 0 });
  session.appendMessage({ role: "user", content: "ABANDONED_BRANCH", timestamp: 1 });
  session.appendCustomMessageEntry("fixture", "CUSTOM_TAIL", true);
  handlers.get("session_start")({}, { sessionManager: session });
  const entries = t.mock.method(session, "getEntries", session.getEntries.bind(session));
  const userRender = t.mock.method(UserMessageComponent.prototype, "render", UserMessageComponent.prototype.render);
  const shortcuts = new Map(), bus = createEventBus();
  const panels = new PanelCoordinator({ pi: { events: bus, registerShortcut: (name, spec) => shortcuts.set(name, spec) },
    widget: h.widget, ready: () => true, router() {}, publish() {}, showError() {} });
  let pane;
  panels.attachHost({ mode: "tui", ui: { notify() { assert.fail("synthetic panel unexpectedly notified"); },
    custom(factory) { return new Promise(resolve => { pane = factory(h.tui, theme, {}, resolve); }); } } }, bus);
  t.after(() => panels.dispose());
  const opening = shortcuts.get("alt+a").handler();
  const paint = () => pane.render(160).join("\n");
  assert.match(paint(), /ABANDONED_BRANCH/);
  const held = { lists: h.counts().lists, entries: entries.mock.callCount(), renders: userRender.mock.callCount() };
  for (let i = 0; i < 30; i++) paint();
  assert.equal(h.counts().lists, held.lists, "one cached roster, not two per frame");
  assert.equal(entries.mock.callCount(), held.entries, "no copies/projections on unchanged history");
  assert.equal(userRender.mock.callCount(), held.renders, "custom_message tail cannot trigger identity rewrites");
  session.branch(root); // Entry count is unchanged; leaf identity must invalidate.
  assert.doesNotMatch(paint(), /ABANDONED_BRANCH/);
  session.appendMessage({ role: "user", content: "REPLACEMENT_BRANCH", timestamp: 2 });
  assert.match(paint(), /REPLACEMENT_BRANCH/);
  session.branchWithSummary(root, "BRANCH_SUMMARY_MARKER");
  assert.match(paint(), /BRANCH_SUMMARY_MARKER/);
  const summaries = userRender.mock.callCount(); paint(); assert.equal(userRender.mock.callCount(), summaries);
  session.appendCompaction("COMPACTION_MARKER", null, 100);
  assert.match(paint(), /COMPACTION_MARKER/);
  const afterCompaction = entries.mock.callCount(); for (let i = 0; i < 10; i++) paint();
  assert.equal(entries.mock.callCount(), afterCompaction);
  pane.invalidate(); assert.match(paint(), /COMPACTION_MARKER/);
  assert.equal(entries.mock.callCount(), afterCompaction, "theme invalidation does not reread unchanged history");
  const other = SessionManager.inMemory(settings.cwd);
  other.appendMessage({ role: "user", content: "NEW_SESSION_MARKER", timestamp: 3 });
  handlers.get("session_start")({}, { sessionManager: other });
  assert.match(paint(), /NEW_SESSION_MARKER/); assert.doesNotMatch(paint(), /COMPACTION_MARKER/);
  panels.dispose(); await opening;
});

test("wide Unicode wrapping measures linear-sized grapheme/row inputs, not every growing candidate", t => {
  const original = Intl.Segmenter.prototype.segment;
  let measured = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (text) { measured += text.length; return original.call(this, text); });
  const text = "漢字👩‍💻e\u0301 ".repeat(1000);
  const rows = wrapPlainText(text, 4000);
  assert(rows.length > 1);
  assert(measured < text.length * 12, `${measured} measured UTF-16 units for ${text.length} input units`);
});
