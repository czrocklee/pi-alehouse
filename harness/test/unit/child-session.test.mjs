import assert from "node:assert/strict";
import test from "node:test";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { SessionInitializationError } from "../../dist/core/ports.js";
import { deferred } from "../support/controller-fixture.mjs";

function setup() {
  const calls = [], reports = [], listeners = new Set();
  const session = {
    sessionId: "synthetic-child", isIdle: false,
    async bindExtensions({ onError }) { onError({ error: "synthetic bind failure" }); },
    async abort() { calls.push("abort"); session.isIdle = true; },
    dispose() { calls.push("dispose"); },
    extensionRunner: {
      onError(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async emit() { calls.push("shutdown"); },
    },
  };
  const input = { createSession: async () => ({ session, extensionsResult: { errors: [] } }), options: {},
    parentBus: { emit: (name, data) => { reports.push({ name, data }); } }, childBus: {}, parentSessionId: "synthetic-parent",
    profile: "reader", definitionDigest: "1".repeat(64), getPermissionsService() {}, shutdownTimeoutMs: 1000 };
  return { session, input, calls, reports, listeners };
}

test("failed non-idle bind aborts, drains, shuts down and disposes; original bind error survives", async () => {
  const { input, calls, reports, session } = setup();
  await assert.rejects(assembleChild(input), (error) => !(error instanceof SessionInitializationError) && /EXTENSION_BIND_FAILED/.test(error.message));
  assert.deepEqual(calls, ["abort", "shutdown", "dispose"]);
  assert.equal(reports.at(-1).data.cleanup.shutdownExited, true);
  await disposeChild(session, input.parentBus); assert.equal(calls.filter((c) => c === "dispose").length, 1);
});

test("ordinary dispose keeps its idle precondition and makes no cleanup calls when it fails", async () => {
  const { session, input, calls } = setup();
  await assert.rejects(disposeChild(session, input.parentBus), /EXECUTION_NOT_EXITED/);
  assert.deepEqual(calls, []);
  session.isIdle = true; await disposeChild(session, input.parentBus);
  assert.deepEqual(calls, ["shutdown", "dispose"]);
});

test("failed initialization uses one deadline, attempts shutdown after abort timeout and freezes uncertainty", async () => {
  const { session, input, calls, reports, listeners } = setup(), abort = deferred(), shutdown = deferred();
  session.abort = () => { calls.push("abort"); return abort.promise; };
  session.extensionRunner.emit = () => { calls.push("shutdown"); return shutdown.promise; };
  try {
    await assert.rejects(assembleChild({ ...input, shutdownTimeoutMs: 10 }), (error) => {
      assert(error instanceof SessionInitializationError); assert.match(String(error.cause), /EXTENSION_BIND_FAILED/);
      assert.match(error.message, /CHILD_ABORT_TIMEOUT/); assert.match(error.message, /CHILD_SHUTDOWN_TIMEOUT/); return true;
    });
    assert.deepEqual(calls, ["abort", "shutdown", "dispose"]);
    const cleanup = reports.at(-1).data.cleanup, saved = structuredClone(cleanup);
    assert.equal(cleanup.shutdownExited, false); assert.equal(cleanup.disposed, true); assert.equal(listeners.size, 0);
    abort.reject(new Error("late abort rejection")); shutdown.reject(new Error("late shutdown rejection"));
    await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(cleanup, saved);
    assert.equal((await disposeChild(session, input.parentBus)).shutdownExited, false);
  } finally { abort.resolve(); shutdown.resolve(); }
});

test("SDK-style swallowed shutdown errors are captured during both failed assembly and ordinary disposal", async () => {
  for (const failed of [true, false]) {
    const { session, input, calls, reports, listeners } = setup();
    session.extensionRunner.emit = async () => { calls.push("shutdown"); for (const fn of listeners) fn({ error: "swallowed shutdown error" }); };
    if (failed) await assert.rejects(assembleChild(input), (error) => error instanceof SessionInitializationError && /swallowed shutdown error/.test(error.message));
    else { session.isIdle = true; await disposeChild(session, input.parentBus); }
    assert.deepEqual(reports.at(-1).data.cleanup.errors, ["swallowed shutdown error"]);
    assert.equal(calls.at(-1), "dispose"); assert.equal(listeners.size, 0);
  }
});

test("failed initialization attempts shutdown even if abort throws; dispose errors retain the bind cause", async () => {
  const { session, input, calls } = setup();
  session.abort = () => { calls.push("abort"); throw new Error("abort threw"); };
  session.dispose = () => { calls.push("dispose"); throw new Error("dispose threw"); };
  await assert.rejects(assembleChild(input), (error) => {
    assert(error instanceof SessionInitializationError); assert.match(String(error.cause), /EXTENSION_BIND_FAILED/);
    assert.match(error.message, /abort threw/); assert.match(error.message, /dispose threw/); return true;
  });
  assert.deepEqual(calls, ["abort", "shutdown", "dispose"]);
});

test("an abort return without idle is not execution-exit proof", async () => {
  const { session, input, calls, reports } = setup();
  session.abort = async () => { calls.push("abort"); }; // Violates the real SDK's guarantee.
  await assert.rejects(assembleChild(input), (error) => error instanceof SessionInitializationError && /EXECUTION_NOT_EXITED/.test(error.message));
  assert.deepEqual(calls, ["abort", "shutdown", "dispose"]);
  assert.equal(reports.at(-1).data.cleanup.shutdownExited, false);
});

test("invalid cleanup budget is rejected before creating a session; failed child registration also cleans up", async () => {
  const { input, calls } = setup(); let creations = 0;
  await assert.rejects(assembleChild({ ...input, shutdownTimeoutMs: 0, createSession: () => { creations++; } }), /INVALID_SHUTDOWN_TIMEOUT/);
  assert.equal(creations, 0);
  await assert.rejects(assembleChild({ ...input, parentBus: { emit: (name) => {
    if (name === "subagents:child:session-created") throw new Error("registration failed");
  } } }), /registration failed/);
  assert.deepEqual(calls, ["abort", "shutdown", "dispose"]);
});
