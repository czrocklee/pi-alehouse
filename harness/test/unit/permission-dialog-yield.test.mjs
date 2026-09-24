import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ApprovalWatch, mountable, PaneRequest, PaneYield, paneYieldHandlers, PERMISSION_UI_PROMPT, PERMISSION_DECISION } from "../../dist/ui/permission-dialog-yield.js";

/** A bus with the shape the SDK's EventBus has, and synchronous emit like it. */
const bus = () => {
  const handlers = new Map();
  return {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      handlers.set(channel, [...list, handler]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
    },
    emit(channel, data) { for (const handler of [...(handlers.get(channel) ?? [])]) handler(data); },
    count: (channel) => (handlers.get(channel) ?? []).length,
  };
};
const watcher = () => {
  const calls = { prompt: [], idle: 0 };
  const watch = new ApprovalWatch({ onPrompt: (p) => calls.prompt.push(p), onIdle: () => { calls.idle++; } });
  return { watch, calls };
};
const ask = (requestId, rest = {}) => ({ requestId, source: "tool_call", forwarding: null, ...rest });

test("a dialog about to be shown yields once, and the pane returns only when the last one is decided", () => {
  const b = bus(), { watch, calls } = watcher();
  watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1", { surface: "bash", value: "rm -rf build",
    forwarding: { requesterAgentName: "scout", requesterSessionId: "child-1" } }));
  assert.equal(calls.prompt.length, 1);
  assert.deepEqual(calls.prompt[0], { requestId: "r1", sessionId: "child-1", agentName: "scout", surface: "bash", value: "rm -rf build" });
  assert.equal(watch.pending, 1);
  // A second ask arrives before the first is answered: still yielded, not idle.
  b.emit(PERMISSION_UI_PROMPT, ask("r2", { surface: "read", value: "/etc/shadow" }));
  assert.equal(watch.pending, 2);
  assert.equal(calls.idle, 0);
  b.emit(PERMISSION_DECISION, { requestId: "r1", result: "allow", resolution: "user_approved" });
  assert.equal(calls.idle, 0, "one ask is still on screen");
  b.emit(PERMISSION_DECISION, { requestId: "r2", result: "deny", resolution: "user_denied" });
  assert.equal(calls.idle, 1);
  assert.equal(watch.pending, 0);
});

test("expired dialogs release yield by their original ID without disturbing another ask", () => {
  const b = bus(), { watch, calls } = watcher();
  const off = watch.bind(b);
  const ended = "managed-permissions:ui_prompt_end:v1";
  b.emit(PERMISSION_UI_PROMPT, ask("local"));
  b.emit(PERMISSION_UI_PROMPT, ask("worker", { forwarding: { requesterSessionId: "child" } }));
  b.emit(PERMISSION_DECISION, { requestId: "gate-error-new-id", resolution: "gate_error" });
  b.emit(ended, { requestId: "local" });
  b.emit(ended, { requestId: "local" });
  assert.equal(watch.pending, 1);
  assert.equal(calls.idle, 0);
  assert.equal(watch.forSession("child").requestId, "worker");
  b.emit(ended, { requestId: "worker" });
  assert.equal(watch.pending, 0);
  assert.equal(calls.idle, 1);
  b.emit(PERMISSION_DECISION, { requestId: "worker" });
  assert.equal(calls.idle, 1, "a later real decision cannot reopen twice");
  off();
  assert.equal(b.count(ended), 0);
});

test("decisions that never reached a dialog cannot bring the pane back", () => {
  const b = bus(), { watch, calls } = watcher();
  watch.bind(b);
  // Policy allows, session grants and authorizer links all decide without a
  // prompt; treating them as the end of a yield would reopen over a live dialog.
  for (const resolution of ["policy_allow", "session_approved", "authorizer_allowed", "auto_approved"]) {
    b.emit(PERMISSION_DECISION, { requestId: `silent-${resolution}`, result: "allow", resolution });
  }
  assert.equal(calls.idle, 0);
  assert.equal(calls.prompt.length, 0);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  b.emit(PERMISSION_DECISION, { requestId: "r1", result: "allow", resolution: "user_approved" });
  assert.equal(calls.idle, 1);
});

test("a repeated prompt for one request yields once, and an unknown id is inert", () => {
  const b = bus(), { watch, calls } = watcher();
  watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  assert.equal(calls.prompt.length, 1);
  assert.equal(watch.pending, 1);
  b.emit(PERMISSION_DECISION, { requestId: "never-prompted" });
  assert.equal(calls.idle, 0);
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  assert.equal(calls.idle, 1);
});

test("a malformed or drifted payload is ignored, never thrown back into the dialog", () => {
  const b = bus(), { watch, calls } = watcher();
  watch.bind(b);
  for (const payload of [undefined, null, 42, "text", {}, { requestId: "" }, { requestId: 7 },
    { requestId: "ok", forwarding: "not an object" }, { requestId: "ok2", forwarding: { requesterSessionId: 5 } }]) {
    b.emit(PERMISSION_UI_PROMPT, payload);
    b.emit(PERMISSION_DECISION, payload);
  }
  // The two well-formed ids survived; the rest contributed nothing.
  assert.deepEqual(calls.prompt.map((p) => p.requestId), ["ok", "ok2"]);
  assert.equal(calls.prompt[0].sessionId, undefined);
  assert.equal(calls.prompt[1].sessionId, undefined);
});

test("a throwing observer cannot take the permission dialog down with it", () => {
  const b = bus();
  const watch = new ApprovalWatch({ onPrompt: () => { throw new Error("pane exploded"); },
    onIdle: () => { throw new Error("reopen exploded"); } });
  watch.bind(b);
  // emit() is synchronous and runs inside LocalUserAuthorizer.authorize, so a
  // throw here would propagate into the ask instead of showing it.
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  assert.equal(watch.pending, 0);
});

test("the ask on screen can be attributed to the worker that raised it", () => {
  const b = bus(), { watch } = watcher();
  watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1", { forwarding: { requesterAgentName: "scout", requesterSessionId: "child-1" } }));
  assert.equal(watch.forSession("child-1").requestId, "r1");
  assert.equal(watch.forSession("child-2"), undefined);
  assert.equal(watch.forSession(undefined), undefined);
});

test("unbinding detaches both channels so a shut-down session stops yielding", () => {
  const b = bus(), { watch, calls } = watcher();
  const off = watch.bind(b);
  assert.equal(b.count(PERMISSION_UI_PROMPT), 1);
  off();
  assert.equal(b.count(PERMISSION_UI_PROMPT), 0);
  assert.equal(b.count(PERMISSION_DECISION), 0);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  assert.equal(calls.prompt.length, 0);
});

/**
 * The extension's pane wiring, reduced to what decides visibility. The mount
 * tears itself down the moment it closes -- `done()` settles `ui.custom` on a
 * microtask, so its cleanup always wins the race against the user answering the
 * dialog -- and the docked reopen is deferred exactly as the real `setTimeout`
 * defers it, which `flush` stands in for.
 */
const wiring = (mode) => {
  const log = [], deferred = [], yielding = new PaneYield();
  let overlay, close;
  const mount = () => {
    log.push("open");
    if (mode === "floating") overlay = { setHidden: (hidden) => log.push(hidden ? "hide" : "show") };
    close = () => { log.push("close"); close = undefined; overlay = undefined; yielding.unmounted(); };
  };
  // The production handlers, not a second copy of them: the only thing stubbed
  // is what the pane is made of and when the deferred reopen runs.
  const watch = new ApprovalWatch(paneYieldHandlers(yielding, {
    open: () => !!close,
    overlay: () => overlay,
    close: () => close,
    pending: () => watch.pending,
    reopen: mount,
    defer: (task) => deferred.push(task),
  }));
  mount();
  return { watch, yielding, log, close: () => close?.(),
    flush: () => { for (const task of deferred.splice(0)) task(); } };
};

test("a docked pane that closed to yield is rebuilt once the last ask is decided", () => {
  const b = bus(), pane = wiring("docked");
  pane.watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  // The teardown runs long before the answer; the intent to reopen must outlive it.
  assert.deepEqual(pane.log, ["open", "close"]);
  assert.equal(pane.yielding.active, true);
  b.emit(PERMISSION_UI_PROMPT, ask("r2"));
  assert.deepEqual(pane.log, ["open", "close"], "the second ask finds the pane already away");
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  pane.flush();
  assert.deepEqual(pane.log, ["open", "close"], "one ask is still on screen");
  b.emit(PERMISSION_DECISION, { requestId: "r2" });
  pane.flush();
  assert.deepEqual(pane.log, ["open", "close", "open"]);
  assert.equal(pane.yielding.active, false);
});

test("a floating pane hides in place, and a close while hidden cancels its return", () => {
  const b = bus(), pane = wiring("floating");
  pane.watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  pane.flush();
  assert.deepEqual(pane.log, ["open", "hide", "show"], "hiding keeps the mount, so nothing is rebuilt");

  const b2 = bus(), other = wiring("floating");
  other.watch.bind(b2);
  b2.emit(PERMISSION_UI_PROMPT, ask("r2"));
  other.close();
  b2.emit(PERMISSION_DECISION, { requestId: "r2" });
  other.flush();
  assert.deepEqual(other.log, ["open", "hide", "close"], "a pane the user closed while hidden stays closed");
});

/**
 * Alt+A reaches `openDetail` through a context Pi builds fresh for shortcut
 * handlers, which the launcher's prompt queue does not wrap. Mounting there
 * during an ask clears the dialog's container without settling it, and the
 * forwarding path turns the abandoned ask into a denial sent to the child.
 */
test("the pane refuses to mount over an ask, or into the gap held open for one", () => {
  const b = bus(), pane = wiring("docked");
  pane.watch.bind(b);
  assert.equal(mountable(pane.yielding, pane.watch.pending), true, "nothing is in the way yet");
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  // The dialog is on screen and the docked pane has already stepped aside: both
  // halves of the guard say no, and they say no independently.
  assert.equal(pane.watch.pending, 1);
  assert.equal(pane.yielding.active, true);
  assert.equal(mountable(pane.yielding, pane.watch.pending), false);
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  // Decided, but the rebuild has not run: the yield is spent, so a user pressing
  // the shortcut now is mounting into an empty screen, which is allowed.
  assert.equal(mountable(pane.yielding, pane.watch.pending), true);
  pane.flush();
  assert.deepEqual(pane.log, ["open", "close", "open"]);
  // An ask with no pane to displace still blocks a mount.
  const b2 = bus(), bare = wiring("docked");
  bare.watch.bind(b2);
  bare.close();
  b2.emit(PERMISSION_UI_PROMPT, ask("r2"));
  assert.equal(mountable(bare.yielding, bare.watch.pending), false, "a dialog alone is enough");
});

test("unbinding forgets the asks it can no longer hear decided", () => {
  const b = bus(), pane = wiring("docked");
  const unbind = pane.watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  assert.equal(pane.watch.pending, 1);
  unbind();
  // No decision can reach a watch that is not listening, so an ask left on the
  // books would report pending forever and refuse every later mount.
  assert.equal(pane.watch.pending, 0);
  assert.equal(mountable(new PaneYield(), pane.watch.pending), true);
});

// Load the actual launcher queue, not a synchronous substitute for ui.custom.
const queueSource = readFileSync(new URL("../../../extensions/ui-prompt-queue.ts", import.meta.url), "utf8");
const { default: promptQueue } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(queueSource,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const queuedPane = (t) => {
  const queueKey = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");
  delete globalThis[queueKey];
  t.after(() => { delete globalThis[queueKey]; });
  const b = bus(), yielding = new PaneYield(), deferred = [];
  let request, releaseBlocker, answer, mounts = 0, permissionShown = false;
  const ui = {
    input: () => new Promise((resolve) => { releaseBlocker = resolve; }),
    confirm: () => new Promise((resolve) => { permissionShown = true; answer = resolve; }),
    select: async () => undefined, editor: async () => undefined,
    custom: (factory) => new Promise((resolve) => { factory({}, {}, {}, resolve); }),
  };
  promptQueue({ on: (_event, handler) => handler({}, { mode: "tui", hasUI: true, ui }) });
  const handlers = paneYieldHandlers(yielding, {
    open: () => !!request, close: () => request?.close, overlay: () => undefined,
    pending: () => watch.pending, reopen: () => { void open(); }, defer: (task) => deferred.push(task),
  });
  const watch = new ApprovalWatch(handlers);
  watch.bind(b);
  const open = async () => {
    if (request || !mountable(yielding, watch.pending)) return;
    const attempt = request = new PaneRequest();
    try {
      await ui.custom((_tui, _theme, _kb, done) => {
        if (attempt.mount(done, yielding, watch.pending)) mounts++;
        return { render: () => [], invalidate() {} };
      });
    } finally {
      request = undefined; yielding.unmounted();
      if (!watch.pending) handlers.onIdle();
    }
  };
  return { b, watch, yielding, open, ui, mounts: () => mounts, permissionShown: () => permissionShown,
    releaseBlocker: () => releaseBlocker(), answer: () => answer(true), close: () => request?.close(),
    flush: () => { for (const task of deferred.splice(0)) task(); } };
};

test("a queued pane yields to an approval behind it in the real PromptQueue", async (t) => {
  const h = queuedPane(t);
  const blocker = h.ui.input();
  await tick();
  const opening = h.open();
  h.b.emit(PERMISSION_UI_PROMPT, ask("queued"));
  const approval = h.ui.confirm();
  assert.equal(h.yielding.active, true, "yield is recorded before there is a done handle");
  h.releaseBlocker();
  await blocker;
  await opening;
  await tick();
  assert.equal(h.mounts(), 0, "cancelled factory never builds a detail pane");
  assert.equal(h.permissionShown(), true, "the queued approval gets the prompt slot");
  assert.equal(h.watch.pending, 1);
  h.answer();
  await approval;
  h.b.emit(PERMISSION_DECISION, { requestId: "queued" });
  h.flush();
  await tick();
  assert.equal(h.mounts(), 1, "one fresh pane returns after the approval");
  h.close();
  await tick();
});

test("a decision before dequeue cannot consume the queued pane's reopen intent", async (t) => {
  const h = queuedPane(t);
  const blocker = h.ui.input();
  await tick();
  const opening = h.open();
  h.b.emit(PERMISSION_UI_PROMPT, ask("early"));
  h.b.emit(PERMISSION_DECISION, { requestId: "early" });
  h.flush();
  assert.equal(h.yielding.active, true, "the old queued request has not torn down yet");
  h.releaseBlocker();
  await blocker;
  await opening;
  assert.equal(h.mounts(), 0);
  h.flush();
  await tick();
  assert.equal(h.mounts(), 1);
  h.flush();
  assert.equal(h.mounts(), 1, "restoration is not duplicated");
  h.close();
  await tick();
});

test("mount rechecks pending approvals even without a prior cancellation callback", () => {
  const request = new PaneRequest(), yielding = new PaneYield();
  let settled = 0;
  assert.equal(request.mount(() => settled++, yielding, 1), false);
  request.close();
  assert.equal(settled, 1);
  assert.equal(yielding.active, true);
});

test("an ask that lands during the rebuild re-arms instead of reopening over it", () => {
  const b = bus(), pane = wiring("docked");
  pane.watch.bind(b);
  b.emit(PERMISSION_UI_PROMPT, ask("r1"));
  b.emit(PERMISSION_DECISION, { requestId: "r1" });
  // The rebuild is a macrotask: a fresh ask can reach the dialog first, and
  // reopening over it would hold the prompt queue and end as a denial.
  b.emit(PERMISSION_UI_PROMPT, ask("r2"));
  pane.flush();
  assert.deepEqual(pane.log, ["open", "close"]);
  assert.equal(pane.yielding.active, true, "re-armed for the ask now on screen");
  b.emit(PERMISSION_DECISION, { requestId: "r2" });
  pane.flush();
  assert.deepEqual(pane.log, ["open", "close", "open"]);
});
