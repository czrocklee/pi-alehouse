import assert from "node:assert/strict";
import test from "node:test";
import { STATS_WORKER_ATTACH } from "../../../lib/stats-protocol.mjs";
import { WorkerStatsObserver } from "../../dist/runtime/worker-stats.js";

function recordingSink() {
  const calls = [];
  const sink = {
    beginRun() { calls.push(["beginRun"]); },
    startActivity() { calls.push(["startActivity"]); },
    settleActivity() { calls.push(["settleActivity"]); },
    requestStart(model, provider) { calls.push(["requestStart", model, provider]); },
    delta(kind) { calls.push(["delta", kind]); },
    messageEnd(message) { calls.push(["messageEnd", message]); },
    toolStart(id, name) { calls.push(["toolStart", id, name]); },
    toolEnd(id, isError) { calls.push(["toolEnd", id, isError]); },
    endRun(kind) { calls.push(["endRun", kind]); },
    dispose() { calls.push(["dispose"]); },
  };
  return { sink, calls };
}

function boundObserver(bus, parentId = "parent", workerId = "worker") {
  const observer = new WorkerStatsObserver(bus, parentId, workerId);
  const handlers = new Map();
  observer.extension({
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  });
  const emit = (name, event = {}, ctx = {}) => handlers.get(name)?.(event, ctx);
  return { observer, handlers, emit };
}

test("worker observer lazily attaches and forwards literal metadata only", () => {
  const { sink, calls } = recordingSink();
  const attachments = [];
  const { observer, handlers, emit } = boundObserver({
    emit(name, payload) {
      assert.equal(name, STATS_WORKER_ATTACH);
      attachments.push(payload);
      payload.sink = sink;
    },
    on() { throw new Error("the observer never subscribes on the parent bus"); },
  });

  assert.equal(attachments.length, 0, "the extension factory does not attach");
  assert.equal(handlers.has("before_provider_request"), false, "cache warming is never observed");
  assert.equal(handlers.has("permissions:ui_prompt"), false, "parent permission observation is not duplicated");
  observer.beginRun();
  assert.deepEqual(attachments, [{ parentId: "parent", workerId: "worker", sink }]);

  emit("agent_start");
  emit("turn_start", {}, { model: { id: "requested", provider: "provider" } });
  // These stream frames can carry content, but neither a hidden block nor an
  // empty effective delta becomes a telemetry event.
  emit("message_update", { assistantMessageEvent: { type: "thinking_start", partial: { content: "hidden thought" } } });
  emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
  emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "" } });
  emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "" } });
  emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "answer text" } });
  emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
  emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "{\"secret\":true}" } });
  const assistant = {
    role: "assistant", provider: "provider", model: "requested", responseModel: "actual", stopReason: "stop",
    usage: { input: 99, output: 7, cost: { input: 1, total: 0.25 } }, errorMessage: "secret error", headers: { authorization: "secret" },
  };
  Object.defineProperty(assistant, "content", { get() { throw new Error("content must not be read"); } });
  emit("message_end", { message: assistant });
  emit("message_end", { message: { role: "toolResult", content: "not an assistant" } });
  const toolStart = { toolCallId: "call-1", toolName: "bash" };
  Object.defineProperty(toolStart, "args", { get() { throw new Error("tool args must not be read"); } });
  emit("tool_execution_start", toolStart);
  const toolEnd = { toolCallId: "call-1", isError: true };
  Object.defineProperty(toolEnd, "result", { get() { throw new Error("tool output must not be read"); } });
  emit("tool_execution_end", toolEnd);
  emit("agent_settled");
  observer.endRun("success");

  assert.deepEqual(calls, [
    ["beginRun"], ["startActivity"], ["requestStart", "requested", "provider"],
    ["delta", "text_delta"], ["delta", "thinking_delta"], ["delta", "toolcall_delta"],
    ["messageEnd", {
      role: "assistant", provider: "provider", model: "requested", responseModel: "actual", stopReason: "stop",
      usage: { output: 7, cost: { total: 0.25 } },
    }],
    ["toolStart", "call-1", "bash"], ["toolEnd", "call-1", true], ["settleActivity"], ["endRun", "success"],
  ]);
});

test("a worker observer is a no-op when the parent has no Stats listener", () => {
  const emitted = [];
  const { observer, emit } = boundObserver({ emit(name, payload) { emitted.push([name, payload]); }, on() {} });
  assert.doesNotThrow(() => {
    observer.beginRun();
    emit("agent_start");
    emit("turn_start", {}, { model: { id: "model", provider: "provider" } });
    emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "not retained" } });
    emit("message_end", { message: { role: "assistant", content: "not retained" } });
    emit("tool_execution_start", { toolCallId: "id", toolName: "read", args: { path: "/secret" } });
    emit("tool_execution_end", { toolCallId: "id", isError: false, result: "secret" });
    observer.endRun("error");
    observer.dispose();
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], STATS_WORKER_ATTACH);
  assert.deepEqual(emitted[0][1], { parentId: "parent", workerId: "worker" });
});

test("async finalization and resume reuse one attachment", async () => {
  const { sink, calls } = recordingSink();
  let attaches = 0;
  const { observer } = boundObserver({
    emit(name, payload) { assert.equal(name, STATS_WORKER_ATTACH); attaches++; payload.sink = sink; },
    on() {},
  });
  const run = async (kind) => {
    observer.beginRun();
    await Promise.resolve();
    observer.endRun(kind);
  };
  await run("success");
  await run("aborted");
  assert.equal(attaches, 1);
  assert.deepEqual(calls, [["beginRun"], ["endRun", "success"], ["beginRun"], ["endRun", "aborted"]]);
});

test("telemetry failures and hostile getters cannot affect worker events", () => {
  const throwingSink = Object.fromEntries(["beginRun", "startActivity", "settleActivity", "requestStart", "delta", "messageEnd", "toolStart", "toolEnd", "endRun", "dispose"]
    .map((name) => [name, () => { throw new Error(name); }]));
  const { observer, emit } = boundObserver({ emit(_name, payload) { payload.sink = throwingSink; }, on() {} });
  assert.doesNotThrow(() => {
    observer.beginRun();
    emit("agent_start");
    emit("agent_settled");
    emit("turn_start", {}, { get model() { throw new Error("hostile model"); } });
    emit("message_update", { get assistantMessageEvent() { throw new Error("hostile update"); } });
    emit("message_end", { get message() { throw new Error("hostile message"); } });
    emit("tool_execution_start", { get toolCallId() { throw new Error("hostile id"); } });
    emit("tool_execution_end", { get toolCallId() { throw new Error("hostile id"); } });
    observer.endRun("error");
    observer.dispose();
  });

  const failedBus = boundObserver({ emit() { throw new Error("missing parent Stats"); }, on() {} }).observer;
  assert.doesNotThrow(() => { failedBus.beginRun(); failedBus.endRun("error"); failedBus.dispose(); });
});

test("session shutdown and late callbacks retire the observer exactly once", () => {
  const { sink, calls } = recordingSink();
  const { observer, emit } = boundObserver({ emit(_name, payload) { payload.sink = sink; }, on() {} });
  observer.beginRun();
  emit("session_shutdown");
  assert.deepEqual(calls, [["beginRun"], ["dispose"]], "shutdown itself must retire the sink before any explicit dispose");
  emit("session_shutdown");
  assert.deepEqual(calls, [["beginRun"], ["dispose"]], "repeated shutdown is already inert");
  const before = calls.length;
  assert.doesNotThrow(() => {
    emit("agent_start");
    emit("agent_settled");
    emit("turn_start", {}, { get model() { throw new Error("late callback read"); } });
    emit("message_update", { get assistantMessageEvent() { throw new Error("late callback read"); } });
    emit("message_end", { get message() { throw new Error("late callback read"); } });
    emit("tool_execution_start", { get toolCallId() { throw new Error("late callback read"); } });
    emit("tool_execution_end", { get toolCallId() { throw new Error("late callback read"); } });
    observer.beginRun();
    observer.endRun("success");
  });
  assert.deepEqual(calls, [["beginRun"], ["dispose"]]);
  assert.equal(calls.length, before, "shutdown alone makes late events inert");
  observer.dispose(); observer.dispose();
  assert.deepEqual(calls, [["beginRun"], ["dispose"]], "explicit dispose after shutdown is only an idempotence check");
});
