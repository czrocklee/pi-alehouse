import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { PaneRequest, PaneYield } from "../../dist/ui/permission-dialog-yield.js";
import { DetailPane } from "../../dist/ui/agent-detail.js";

// Exercise the actual SDK handoff, including its Promise.resolve(factory).then
// window. Only the editor/container/TUI are fakes; no terminal or provider runs.
const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js",
  import.meta.resolve("@earendil-works/pi-coding-agent")));
const source = readFileSync(new URL("../../../extensions/ui-prompt-queue.ts", import.meta.url), "utf8");
const { default: promptQueue } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);
const STALL_MS = 10 * 60 * 1000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const intervals = new Set();
  const setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    const timer = setInterval(...args); intervals.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => { intervals.delete(timer); clearInterval(timer); });
  const queueKey = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");
  delete globalThis[queueKey];
  t.after(() => { delete globalThis[queueKey]; });
  const log = [];
  let current, overlay, request, lastRequest, pane, lateDone, answer, renders = 0, rawDoneCalls = 0, failMount = false;
  const editor = { getText: () => "draft", setText: (text) => assert.equal(text, "draft") };
  const dialog = { render: () => ["approval"], invalidate() {} };
  current = editor;
  const label = (component) => component === editor ? "editor" : component === dialog ? "dialog" : "pane";
  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => { renders++; },
    setFocus() {},
    showOverlay(component) { overlay = component; log.push("overlay"); return { setHidden() {} }; },
    hideOverlay() { overlay = undefined; log.push("hide-overlay"); },
  };
  const host = {
    editor, ui: tui, keybindings: {}, disposeActiveSelector() {},
    editorContainer: {
      clear() { current = undefined; },
      addChild(component) {
        if (failMount && component instanceof DetailPane) throw new Error("mount failed");
        current = component; log.push(label(component));
      },
    },
  };
  const rawCustom = (factory, options) => InteractiveMode.prototype.showExtensionCustom.call(host,
    (tui, theme, kb, done) => factory(tui, theme, kb, (value) => { rawDoneCalls++; done(value); }), options);
  const ui = {
    custom: rawCustom,
    confirm: () => rawCustom((_tui, _theme, _kb, done) => { answer = () => done(true); return dialog; }),
    input: async () => undefined, select: async () => undefined, editor: async () => undefined,
  };
  promptQueue({ on: (_event, handler) => handler({}, { mode: "tui", hasUI: true, ui }) });
  const open = async ({ cancelBeforeMount = false, overlay = false, failFactory = false, gate } = {}) => {
    const attempt = request = lastRequest = new PaneRequest();
    const yielding = new PaneYield();
    try {
      await ui.custom((tui, _theme, _kb, done) => {
        lateDone = done;
        assert.equal(attempt.mount(() => done(undefined), yielding, 0), true);
        const build = () => {
          pane = attempt.own(new DetailPane({ tui, theme: { fg: (_color, text) => text, bold: (text) => text },
            initial: "a", done: attempt.close, snapshot: () => [], transcript: () => undefined }));
          if (cancelBeforeMount) queueMicrotask(attempt.close);
          if (failFactory) throw new Error("factory failed");
          return pane;
        };
        return gate ? gate.then(build) : build();
      }, { overlay });
    } finally {
      // Same owner-side protocol as extension.ts: dispose resources, never do
      // a late raw UI close after the queue might have given the slot away.
      attempt.dispose();
      request = undefined;
    }
  };
  t.after(() => { request?.close(); pane?.dispose(); });
  return { ui, open, log, editor, dialog, intervals, pane: () => pane,
    current: () => current, overlay: () => overlay, hasOwner: () => !!request,
    renders: () => renders, rawDoneCalls: () => rawDoneCalls,
    close: () => lastRequest?.close(), lateDone: () => lateDone?.("late"),
    answer: () => answer(), failMount: () => { failMount = true; } };
}

test("pane requests coordinate queued, blocked and mounted settlement exactly", () => {
  const yielding = new PaneYield();
  let notices = 0;
  const queuedValues = [], queued = new PaneRequest(() => notices++);
  queued.close();
  assert.equal(queued.mount(() => queuedValues.push("done"), yielding, 0), false);
  queued.close();
  assert.deepEqual(queuedValues, ["done"]);
  assert.equal(notices, 2, "queued cancellation coordinates immediately and again at dequeue");

  let blockedNotices = 0, blockedDone = 0;
  const blocked = new PaneRequest(() => blockedNotices++);
  assert.equal(blocked.mount(() => blockedDone++, yielding, 1), false);
  blocked.close();
  assert.equal(blockedDone, 1); assert.equal(blockedNotices, 1);

  let mountedNotices = 0, mountedDone = 0;
  const mounted = new PaneRequest(() => mountedNotices++);
  assert.equal(mounted.mount(() => mountedDone++, new PaneYield(), 0), true);
  mounted.close(); mounted.close();
  assert.equal(mountedDone, 1); assert.equal(mountedNotices, 1);
});

for (const trigger of ["escape", "external close"]) {
  test(`real detail overlay ${trigger} preserves focus and removes newer transient overlays`, async () => {
    const layers = [];
    const editor = { getText: () => "draft", setText: () => {} };
    let focus = editor, pane, transient, transientHides = 0;
    const tui = {
      terminal: { columns: 100, rows: 30 }, requestRender() {},
      setFocus(component) { focus = component; },
      showOverlay(component, options = {}) {
        const layer = { component, options }; layers.push(layer);
        if (!options.nonCapturing) focus = component;
        return { hide() {
          const index = layers.indexOf(layer);
          if (index >= 0) layers.splice(index, 1);
          if (focus === component) focus = editor;
        }, setHidden() {} };
      },
      hideOverlay() {
        const removed = layers.pop();
        if (removed && focus === removed.component) focus = editor;
      },
    };
    const host = { editor, ui: tui, keybindings: {}, disposeActiveSelector() {},
      editorContainer: { clear() {}, addChild() {} } };
    const request = new PaneRequest(() => { transientHides++; transient?.hide(); });
    const opening = InteractiveMode.prototype.showExtensionCustom.call(host, (_tui, _theme, _keys, done) => {
      assert.equal(request.mount(() => done(undefined), new PaneYield(), 0), true);
      pane = request.own(new DetailPane({ tui, theme: { fg: (_color, text) => text, bold: (text) => text },
        initial: "agent", done: request.close, snapshot: () => [], transcript: () => undefined, frame: true }));
      return pane;
    }, { overlay: true });
    await tick();
    assert.deepEqual(layers.map(({ component }) => component), [pane]); assert.equal(focus, pane);
    const footer = { render: () => ["footer"], invalidate() {} };
    transient = tui.showOverlay(footer, { nonCapturing: true });
    assert.deepEqual(layers.map(({ component }) => component), [pane, footer]); assert.equal(focus, pane);

    if (trigger === "escape") pane.handleInput("\x1b"); else request.close();
    await opening; request.dispose();
    assert.equal(transientHides, 1); assert.deepEqual(layers, []); assert.equal(focus, editor);

    const approval = { render: () => ["approval"], invalidate() {} };
    tui.showOverlay(approval); request.close();
    assert.deepEqual(layers.map(({ component }) => component), [approval]);
    assert.equal(focus, approval, "stale pane close cannot pop the successor");
    tui.hideOverlay();
  });
}

test("a docked pane's ten-minute timeout closes the real UI even with no successor", async (t) => {
  const h = fixture(t);
  const expired = assert.rejects(h.open(), { name: "PromptQueueStallError" });
  await tick();
  assert.equal(h.current(), h.pane());
  assert.equal(h.intervals.size, 1);
  t.mock.timers.tick(STALL_MS);
  await expired;
  assert.equal(h.hasOwner(), false);
  assert.equal(h.current(), h.editor);
  assert.equal(h.intervals.size, 0, "no constructor timer outlives the attempt");
  const next = h.ui.confirm();
  await tick();
  h.answer();
  await next;
  const renders = h.renders();
  t.mock.timers.tick(360);
  assert.equal(h.renders(), renders, "the old pane cannot keep requesting redraws");
});

test("timeout cleanup precedes handing the queue to an approval, and late done is inert", async (t) => {
  const h = fixture(t);
  const expired = assert.rejects(h.open(), { name: "PromptQueueStallError" });
  await tick();
  const next = h.ui.confirm();
  t.mock.timers.tick(STALL_MS);
  await expired;
  await tick();
  assert.deepEqual(h.log, ["pane", "editor", "dialog"]);
  assert.equal(h.current(), h.dialog);
  assert.equal(h.intervals.size, 0);
  h.close(); h.lateDone();
  await tick();
  assert.equal(h.current(), h.dialog, "old callbacks cannot restore editor over the new dialog");
  assert.equal(h.rawDoneCalls(), 1, "the wrapper blocks late done before it even reaches Pi's own closed guard");
  const renders = h.renders();
  t.mock.timers.tick(360);
  assert.equal(h.renders(), renders);
  h.answer();
  assert.equal(await next, true);
});

for (const overlay of [false, true]) {
  test(`cancel after construction but before SDK handoff disposes the unmounted pane (overlay=${overlay})`, async (t) => {
    const h = fixture(t);
    await h.open({ cancelBeforeMount: true, overlay });
    await tick();
    assert.ok(h.pane(), "the component really was constructed");
    assert.ok(!h.log.includes("pane") && !h.log.includes("overlay"), "Pi never received it");
    assert.equal(h.current(), h.editor);
    assert.equal(h.overlay(), undefined);
    assert.equal(h.intervals.size, 0);
    const renders = h.renders();
    t.mock.timers.tick(360);
    assert.equal(h.renders(), renders);
  });
}

for (const failure of ["factory", "mount"]) {
  test(`${failure} rejection closes before the next dialog and releases the owned pane`, async (t) => {
    const h = fixture(t);
    if (failure === "mount") h.failMount();
    const rejected = assert.rejects(h.open({ failFactory: failure === "factory" }), new RegExp(`${failure} failed`));
    const next = h.ui.confirm();
    await rejected;
    await tick();
    assert.equal(h.current(), h.dialog);
    assert.equal(h.intervals.size, 0);
    h.close(); h.lateDone();
    assert.equal(h.current(), h.dialog);
    h.answer();
    await next;
  });
}

test("a component produced after timeout is immediately disposed, never mounted", async (t) => {
  const h = fixture(t), gate = Promise.withResolvers();
  const expired = assert.rejects(h.open({ gate: gate.promise }), { name: "PromptQueueStallError" });
  await tick();
  t.mock.timers.tick(STALL_MS);
  await expired;
  const next = h.ui.confirm();
  await tick();
  gate.resolve();
  await tick();
  assert.ok(h.pane());
  assert.equal(h.current(), h.dialog);
  assert.equal(h.intervals.size, 0);
  h.close(); h.lateDone();
  assert.equal(h.current(), h.dialog);
  h.answer();
  await next;
});

test("normal Esc closure is idempotent and cannot later time out or close another dialog", async (t) => {
  const h = fixture(t), opening = h.open();
  await tick();
  h.pane().handleInput("\x1b");
  await opening;
  assert.equal(h.intervals.size, 0);
  const next = h.ui.confirm();
  await tick();
  h.close(); h.lateDone(); h.pane().dispose();
  assert.equal(h.current(), h.dialog);
  h.answer();
  await next;
  const renders = h.renders();
  t.mock.timers.tick(STALL_MS + 360);
  await tick();
  assert.equal(h.renders(), renders);
});

test("a throwing timeout cleanup preserves both errors and cannot strand the queue", async (t) => {
  fixture(t);
  const queue = globalThis[Symbol.for("nixos-config.pi.ui-prompt-queue.v1")];
  const operation = Promise.withResolvers(), log = [], cleanup = new Error("cleanup failed");
  const expired = assert.rejects(queue.enqueue(() => operation.promise, () => { log.push("cancel"); throw cleanup; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause.name, "PromptQueueStallError");
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  const next = queue.enqueue(async () => { log.push("next"); return "ok"; });
  await tick();
  t.mock.timers.tick(STALL_MS);
  await expired;
  assert.equal(await next, "ok");
  assert.deepEqual(log, ["cancel", "next"]);
  operation.reject(new Error("late operation rejection"));
  await tick(); // The test runner also rejects unhandled-rejection leaks.
});

test("normal custom results and spread-context idempotence survive the cancellation wrapper", async (t) => {
  const h = fixture(t), copy = { ...h.ui };
  promptQueue({ on: (_event, handler) => handler({}, { mode: "tui", hasUI: true, ui: copy }) });
  assert.equal(copy.custom, h.ui.custom, "do not double-enqueue a spread context");
  const result = await copy.custom((_tui, _theme, _kb, done) => {
    done("answer");
    return { render: () => [], invalidate() {} };
  });
  assert.equal(result, "answer");
  const renders = h.renders();
  t.mock.timers.tick(STALL_MS);
  await tick();
  assert.equal(h.renders(), renders, "normal settlement clears its watchdog");
});

test("a floating pane is not subject to the inline queue's stall bound", async (t) => {
  const h = fixture(t), opening = h.open({ overlay: true });
  await tick();
  t.mock.timers.tick(STALL_MS);
  await tick();
  assert.equal(h.hasOwner(), true);
  assert.equal(h.overlay(), h.pane());
  assert.equal(h.intervals.size, 1);
  h.close();
  await opening;
  assert.equal(h.intervals.size, 0);
});
