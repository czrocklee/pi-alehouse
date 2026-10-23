import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import test from "node:test";
import ts from "typescript";
import { ApprovalWatch, PaneRequest, PaneYield, paneYieldHandlers, PERMISSION_UI_PROMPT, PERMISSION_DECISION } from "../../dist/ui/permission-dialog-yield.js";
import { DetailPane } from "../../dist/ui/agent-detail.js";

// Exercise the actual SDK handoff, including its Promise.resolve(factory).then
// window. Only the editor/container/TUI are fakes; no terminal or provider runs.
const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js",
  import.meta.resolve("@earendil-works/pi-coding-agent")));
const { createEventBus, initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
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
  let overlayHideCalls = 0, globalOverlayHideCalls = 0;
  const editor = { getText: () => "draft", setText: (text) => assert.equal(text, "draft") };
  const dialog = { render: () => ["approval"], invalidate() {} };
  current = editor;
  const label = (component) => component === editor ? "editor" : component === dialog ? "dialog" : "pane";
  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => { renders++; },
    setFocus() {},
    showOverlay(component) {
      overlay = component; log.push("overlay");
      return { hide() {
        overlayHideCalls++;
        if (overlay === component) { overlay = undefined; log.push("hide-overlay"); }
      }, setHidden() {} };
    },
    hideOverlay() { globalOverlayHideCalls++; overlay = undefined; log.push("hide-overlay"); },
  };
  const host = {
    editor, ui: tui, keybindings: {}, disposeActiveSelector() {},
    extensionDialogs: [], programStatus: { setBlocked() {} },
    pushExtensionDialog: InteractiveMode.prototype.pushExtensionDialog,
    removeExtensionDialog: InteractiveMode.prototype.removeExtensionDialog,
    showTopExtensionDialog: InteractiveMode.prototype.showTopExtensionDialog,
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
    overlayHideCalls: () => overlayHideCalls, globalOverlayHideCalls: () => globalOverlayHideCalls,
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

/** Native Pi 1.4 dialogs and stack, with synthetic terminal/container IO only. */
function nativeFixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const timeouts = new Set(), intervals = new Set();
  for (const [set, clear, pending] of [["setTimeout", "clearTimeout", timeouts], ["setInterval", "clearInterval", intervals]]) {
    const start = globalThis[set], stop = globalThis[clear];
    t.mock.method(globalThis, set, (callback, delay, ...args) => {
      const timer = start(() => {
        if (set === "setTimeout") pending.delete(timer);
        callback(...args);
      }, delay);
      pending.add(timer);
      return timer;
    });
    t.mock.method(globalThis, clear, (timer) => { pending.delete(timer); stop(timer); });
  }
  const key = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");
  delete globalThis[key];
  t.after(() => { delete globalThis[key]; });
  const editor = { getText: () => "draft", setText() {} }, log = [], options = [];
  let current = editor;
  const host = {
    editor, extensionDialogs: [], programStatus: { setBlocked() {} },
    ui: { requestRender() {}, setFocus() {} }, keybindings: { matches: () => false },
    settingsManager: { getExternalEditorCommand: () => undefined }, disposeActiveSelector() {},
    editorContainer: { clear() {}, addChild(component) { current = component; } },
    pushExtensionDialog(component, blocked) {
      log.push(["push", component]);
      InteractiveMode.prototype.pushExtensionDialog.call(this, component, blocked);
    },
    removeExtensionDialog(component) {
      log.push(["remove", component]);
      InteractiveMode.prototype.removeExtensionDialog.call(this, component);
    },
    showTopExtensionDialog: InteractiveMode.prototype.showTopExtensionDialog,
    showExtensionSelector: InteractiveMode.prototype.showExtensionSelector,
  };
  const raw = (method) => (...args) => {
    options.push(args[2]);
    return InteractiveMode.prototype[method].call(host, ...args);
  };
  const ui = {
    select: raw("showExtensionSelector"), confirm: raw("showExtensionConfirm"), input: raw("showExtensionInput"),
    editor: raw("showExtensionEditor"), custom: raw("showExtensionCustom"), ...overrides,
  };
  const rawUI = { ...ui };
  promptQueue({ on: (_event, handler) => handler({}, { mode: "tui", hasUI: true, ui }) });
  return { ui, rawUI, editor, log, options, timeouts, intervals, current: () => current,
    stack: () => host.extensionDialogs.map(({ component }) => component),
    shortcut: () => InteractiveMode.prototype.showExtensionSelector.call(host, "shortcut", ["Yes", "No"]),
    answer: (component = current) => component.onSelectCallback ? component.onSelectCallback("Yes") : component.onSubmitCallback("answer"),
    escape: (component = current) => component.onCancelCallback() };
}

const nativePrompt = (ui, method, opts) => ui[method]("title", method === "select" ? ["Yes", "No"] : "message", opts);

for (const method of ["select", "confirm", "input"]) {
  test(`stalled native ${method} is retired before FIFO advances and cannot resurrect or reply`, async (t) => {
    const h = nativeFixture(t);
    const expired = assert.rejects(nativePrompt(h.ui, method), { name: "PromptQueueStallError" });
    await tick();
    const abandoned = h.current(), next = h.ui.confirm("next", "approval");
    t.mock.timers.tick(STALL_MS);
    await expired;
    await tick();
    const successor = h.current();
    assert.notEqual(successor, abandoned);
    assert.deepEqual(h.stack(), [successor], "the abandoned dialog is not hidden below the successor");
    assert.ok(h.log.findIndex(([event, component]) => event === "remove" && component === abandoned)
      < h.log.findIndex(([event, component]) => event === "push" && component === successor));
    h.answer(abandoned);
    assert.equal(h.current(), successor, "stale native completion cannot disturb the current prompt");
    h.answer();
    assert.equal(await next, true);
    assert.deepEqual(h.stack(), []);
    assert.equal(h.current(), h.editor, "closing the next dialog must not resurrect the abandoned one");
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.intervals.size, 0);
  });
}

for (const method of ["select", "confirm", "input"]) {
  const cancelled = method === "confirm" ? false : undefined;
  for (const ending of ["answer", "escape", "caller abort", "native timeout", "stall"]) {
    test(`native ${method}: ${ending} closes without a successor and cleans up options/listeners/timers`, async (t) => {
      const h = nativeFixture(t), caller = new AbortController();
      const options = Object.freeze({ signal: caller.signal, timeout: ending === "native timeout" ? 1000 : STALL_MS * 2 });
      const result = nativePrompt(h.ui, method, options);
      const expired = ending === "stall" ? assert.rejects(result, { name: "PromptQueueStallError" }) : undefined;
      await tick();
      const passed = h.options[0];
      assert.notEqual(passed, options);
      assert.notEqual(passed.signal, caller.signal);
      assert.equal(passed.timeout, options.timeout);
      assert.equal(getEventListeners(caller.signal, "abort").length, 1);
      assert.equal(getEventListeners(passed.signal, "abort").length, 1);
      assert.equal(h.intervals.size, 1);
      if (ending === "answer") h.answer();
      else if (ending === "escape") h.escape();
      else if (ending === "caller abort") caller.abort("request withdrawn");
      else t.mock.timers.tick(ending === "stall" ? STALL_MS : 1000);
      if (expired) await expired;
      else assert.equal(await result, ending === "answer" ? { select: "Yes", confirm: true, input: "answer" }[method] : cancelled);
      if (ending === "caller abort") assert.equal(passed.signal.reason, "request withdrawn");
      assert.equal(caller.signal.aborted, ending === "caller abort", "queue cancellation never aborts its caller");
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      assert.equal(getEventListeners(passed.signal, "abort").length, 0);
      assert.deepEqual(h.stack(), []);
      assert.equal(h.current(), h.editor);
      assert.equal(h.timeouts.size, 0);
      assert.equal(h.intervals.size, 0);
      caller.abort("late abort");
      t.mock.timers.tick(STALL_MS * 3);
      await tick();
      assert.deepEqual(h.stack(), [], "no late abort or countdown can resurrect the dialog");
    });
  }

  for (const when of ["before enqueue", "while queued"]) {
    test(`native ${method} aborted ${when} is never displayed and preserves FIFO`, async (t) => {
      const h = nativeFixture(t), caller = new AbortController();
      const blocker = h.ui.confirm("blocker", "approval");
      await tick();
      const first = h.current();
      if (when === "before enqueue") caller.abort();
      const cancelledPrompt = nativePrompt(h.ui, method, { signal: caller.signal, timeout: 1000 });
      if (when === "while queued") caller.abort();
      const next = h.ui.confirm("next", "approval");
      t.mock.timers.tick(2000);
      assert.equal(h.current(), first);
      assert.equal(h.options.length, 1, "queued cancellation never starts a UI or countdown early");
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      h.answer();
      await blocker;
      assert.equal(await cancelledPrompt, cancelled);
      await tick();
      assert.equal(h.log.filter(([event]) => event === "push").length, 2, "only blocker and next were mounted");
      assert.equal(h.stack().length, 1);
      h.answer();
      assert.equal(await next, true);
      assert.equal(h.timeouts.size, 0);
      assert.equal(h.intervals.size, 0);
    });
  }

  test(`native ${method} caller timeout starts only at dequeue`, async (t) => {
    const h = nativeFixture(t), blocker = h.ui.confirm("blocker", "approval");
    await tick();
    const first = h.current(), result = nativePrompt(h.ui, method, { timeout: 1000 });
    t.mock.timers.tick(2000);
    assert.equal(h.current(), first);
    h.answer();
    await blocker;
    await tick();
    assert.notEqual(h.current(), first);
    t.mock.timers.tick(999);
    assert.equal(h.stack().length, 1);
    t.mock.timers.tick(1);
    assert.equal(await result, cancelled);
    assert.deepEqual(h.stack(), []);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.intervals.size, 0);
  });
}

test("stall retires a buried native dialog without closing an unqueued shortcut dialog", async (t) => {
  const h = nativeFixture(t), expired = assert.rejects(h.ui.confirm("stale", "approval"), { name: "PromptQueueStallError" });
  await tick();
  const stale = h.current(), shortcut = h.shortcut(), shortcutComponent = h.current();
  t.mock.timers.tick(STALL_MS);
  await expired;
  assert.equal(h.current(), shortcutComponent);
  assert.deepEqual(h.stack(), [shortcutComponent]);
  h.answer(stale);
  assert.equal(h.current(), shortcutComponent);
  h.answer();
  await shortcut;
  assert.deepEqual(h.stack(), []);
  assert.equal(h.current(), h.editor);
});

for (const order of ["abort settled first", "abort before stall in same turn", "stall first"]) {
  test(`native abort/stall race: ${order} stays fail-closed and cannot affect its successor`, async (t) => {
    const h = nativeFixture(t), caller = new AbortController();
    const result = h.ui.confirm("stale", "approval", { signal: caller.signal, timeout: STALL_MS });
    const outcome = result.then((value) => ({ value }), (error) => ({ error }));
    await tick();
    const stale = h.current(), next = h.ui.confirm("next", "approval");
    if (order !== "stall first") caller.abort();
    if (order === "abort settled first") await tick();
    // Same-turn abort cannot turn an already claimed watchdog rejection into
    // approval; Pi's neutral resolution arrives later on a microtask.
    if (order === "abort settled first") t.mock.timers.tick(STALL_MS - 1);
    else t.mock.timers.tick(STALL_MS);
    if (order === "stall first") caller.abort();
    const settled = await outcome;
    if (order === "abort settled first") assert.deepEqual(settled, { value: false });
    else assert.equal(settled.error.name, "PromptQueueStallError");
    await tick();
    assert.equal(h.stack().length, 1);
    assert.notEqual(h.current(), stale);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    h.answer(stale);
    h.answer();
    assert.equal(await next, true);
    assert.deepEqual(h.stack(), []);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.intervals.size, 0);
  });
}

for (const failure of ["throw", "reject", "never settles"]) {
  test(`native ${failure} detaches caller abort and cancels before advancing`, async (t) => {
    const caller = new AbortController(), pending = Promise.withResolvers();
    let signal;
    const h = nativeFixture(t, { input: (_title, _placeholder, opts) => {
      signal = opts.signal;
      if (failure === "throw") throw new Error("native failed");
      if (failure === "reject") return Promise.reject(new Error("native failed"));
      return pending.promise;
    } });
    const rejected = assert.rejects(h.ui.input("broken", undefined, { signal: caller.signal }),
      failure === "never settles" ? { name: "PromptQueueStallError" } : /native failed/);
    const next = h.ui.confirm("next", "approval");
    await tick();
    if (failure === "never settles") t.mock.timers.tick(STALL_MS);
    await rejected;
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(caller.signal.aborted, false);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(h.stack().length, 1);
    pending.reject(new Error("late native failure"));
    // In the throw/reject cases this deferred was never returned to the queue.
    if (failure !== "never settles") await assert.rejects(pending.promise, /late native failure/);
    await tick();
    h.answer();
    assert.equal(await next, true);
    assert.equal(h.timeouts.size, 0);
  });
}

test("native wrappers share the existing process FIFO across rebinds and are spread-idempotent", async (t) => {
  const h = nativeFixture(t), copy = { ...h.ui }, rebound = { ...h.rawUI };
  for (const ui of [copy, rebound]) promptQueue({ on: (_event, handler) => handler({}, { mode: "tui", hasUI: true, ui }) });
  for (const method of ["select", "confirm", "input", "editor", "custom"]) assert.equal(copy[method], h.ui[method]);
  const first = h.ui.confirm("first", "approval"), second = rebound.confirm("second", "approval");
  await tick();
  assert.equal(h.options.length, 1);
  h.answer();
  await first;
  await tick();
  assert.equal(h.options.length, 2);
  h.answer();
  assert.equal(await second, true);
  assert.deepEqual(h.stack(), []);
});

for (const ending of ["answer", "escape"]) {
  test(`native editor keeps its supported two-argument API and ${ending} FIFO behavior`, async (t) => {
    const h = nativeFixture(t), result = h.ui.editor("edit", "prefill"), next = h.ui.confirm("next", "approval");
    await tick();
    assert.equal(h.options[0], undefined, "do not invent an unsupported editor signal option");
    if (ending === "answer") h.answer(); else h.escape();
    assert.equal(await result, ending === "answer" ? "answer" : undefined);
    await tick();
    assert.equal(h.stack().length, 1);
    h.answer();
    assert.equal(await next, true);
    assert.deepEqual(h.stack(), []);
    assert.equal(h.timeouts.size, 0);
  });
}

test("native permission stall retires before the next ask and pane restoration never revives it", async (t) => {
  const h = nativeFixture(t), b = createEventBus(), yielding = new PaneYield(), deferred = [];
  let request, opening, mounts = 0;
  const open = () => {
    const attempt = request = new PaneRequest();
    opening = h.ui.custom((_tui, _theme, _keys, done) => {
      if (attempt.mount(() => done(undefined), yielding, watch.pending)) mounts++;
      return { render: () => ["pane"], invalidate() {} };
    }).finally(() => {
      attempt.dispose(); request = undefined; yielding.unmounted();
      if (!watch.pending) handlers.onIdle();
    });
    return opening;
  };
  const handlers = paneYieldHandlers(yielding, {
    open: () => !!request, close: () => request?.close, overlay: () => undefined,
    pending: () => watch.pending, reopen: () => { void open(); }, defer: (task) => deferred.push(task),
  });
  const watch = new ApprovalWatch(handlers);
  t.after(watch.bind(b));
  const firstPane = open();
  await tick();
  b.emit(PERMISSION_UI_PROMPT, { requestId: "stale" });
  const expired = assert.rejects(h.ui.confirm("stale", "approval").finally(() => {
    b.emit("managed-permissions:ui_prompt_end:v1", { requestId: "stale" });
  }), { name: "PromptQueueStallError" });
  await firstPane;
  await tick();
  const stale = h.current();
  b.emit(PERMISSION_UI_PROMPT, { requestId: "next" });
  const next = h.ui.confirm("next", "approval");
  t.mock.timers.tick(STALL_MS);
  await expired;
  await tick();
  assert.equal(watch.pending, 1);
  assert.equal(yielding.active, true);
  assert.equal(mounts, 1, "the pane cannot return before the remaining ask settles");
  assert.equal(deferred.length, 0);
  assert.equal(h.stack().length, 1);
  assert.notEqual(h.current(), stale);
  h.answer();
  assert.equal(await next, true);
  b.emit(PERMISSION_DECISION, { requestId: "next", result: "allow" });
  for (const task of deferred.splice(0)) task();
  await tick();
  assert.equal(mounts, 2);
  const restored = h.current();
  h.answer(stale);
  assert.equal(h.current(), restored);
  request.close();
  await opening;
  assert.deepEqual(h.stack(), []);
  assert.equal(h.current(), h.editor);
  assert.equal(h.timeouts.size, 0);
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
  assert.equal(h.overlay(), undefined, "Pi closes the pane through its own overlay handle");
  assert.equal(h.overlayHideCalls(), 1);
  assert.equal(h.globalOverlayHideCalls(), 0, "Pi must not pop the topmost overlay");
  h.close(); h.lateDone();
  assert.equal(h.overlayHideCalls(), 1, "late closure does not call the handle again");
  assert.equal(h.globalOverlayHideCalls(), 0);
  assert.equal(h.intervals.size, 0);
});
