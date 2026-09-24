#!/usr/bin/env node
// Pure session-stat regressions against the repository's pinned Pi/Jiti toolchain.
// No model, network, wall-clock timer, transcript, or session file is involved.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const harness = root;
const require = createRequire(join(harness, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(
      harness, "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    ),
  },
});
const { SessionStats, bindStatsEvents } = await jiti.import(
  join(root, "extensions/lib/session-stats.ts"),
);

function clock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    set: (next) => { value = next; },
    advance: (delta) => { value += delta; },
  };
}

function usage(output, cost = 0) {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant({ provider = "provider", model = "requested", responseModel, output = 0,
  cost = 0, stopReason = "stop", withUsage = true } = {}) {
  return {
    role: "assistant",
    provider,
    model,
    ...(responseModel ? { responseModel } : {}),
    ...(withUsage ? { usage: usage(output, cost) } : {}),
    stopReason,
    // Content is deliberately ignored by the collector.
    content: [{ type: "text", text: "SECRET_TRANSCRIPT_FIXTURE" }],
  };
}

function started(initial = 0) {
  const c = clock(initial);
  const stats = new SessionStats(c.now);
  stats.startActivity();
  return { c, stats };
}

const model = (snapshot, name) => snapshot.models.find((row) => row.model === name);
const tool = (snapshot, name) => snapshot.tools.find((row) => row.tool === name);

test("unknown health becomes busy then evidenced idle; busy is a foreground union", () => {
  const c = clock(100);
  const stats = new SessionStats(c.now);
  assert.deepEqual(stats.snapshot(), {
    scope: "foreground-observed",
    limitations: [
      "Current observation window only; no historical backfill.",
      "Single instrumented foreground session; compaction and cache warming are excluded.",
      "Requests are foreground SDK turns; provider-internal retries are not observable.",
      "LLM time starts at turn_start, includes SDK preflight, and is not transport-only latency.",
      "TPS is reported output tokens divided by end-to-end request time, not decoding speed.",
    ],
    elapsedMs: 0, busyMs: 0, idleMs: 0, llmMs: 0, toolMs: 0, approvalMs: 0,
    activeRequests: 0, activeTools: 0, pendingApprovals: 0,
    health: "unknown", observedActivity: false, partial: false, models: [], tools: [],
  });
  c.set(110); stats.startActivity();
  c.set(150); stats.startActivity(); // duplicate lifecycle notification does not double-count
  c.set(180); stats.settleActivity();
  c.set(200);
  const first = stats.snapshot();
  assert.equal(first.busyMs, 70);
  assert.equal(first.idleMs, 30);
  assert.equal(first.health, "idle");
  assert.equal(first.observedActivity, true);
  assert.equal(first.lastActivityMs, 20);

  c.set(220); stats.startActivity();
  c.set(250);
  const live = stats.snapshot();
  assert.equal(live.busyMs, 100);
  assert.equal(live.idleMs, 50);
  assert.equal(live.health, "busy");
});

test("parallel tools are cumulative rather than a wall-time partition", () => {
  const { c, stats } = started();
  c.set(10); stats.toolStart("private-tool-id-a", "bash");
  c.set(20); stats.toolStart("private-tool-id-b", "read");
  c.set(40); stats.toolEnd("private-tool-id-a", false);
  c.set(60); stats.toolEnd("private-tool-id-b", true);
  c.set(70); stats.settleActivity();
  const snapshot = stats.snapshot();
  assert.equal(snapshot.elapsedMs, 70);
  assert.equal(snapshot.busyMs, 70);
  assert.equal(snapshot.toolMs, 70, "30ms + 40ms is cumulative despite overlap");
  assert.deepEqual(tool(snapshot, "bash"), {
    tool: "bash", calls: 1, errors: 0, totalMs: 30, maxMs: 30, partial: false,
  });
  assert.deepEqual(tool(snapshot, "read"), {
    tool: "read", calls: 1, errors: 1, totalMs: 40, maxMs: 40, partial: false,
  });
  assert.equal(snapshot.health, "idle", "tool failure counts do not poison settled health");
});

test("ordinary tool failures remain counters, not a fatal session health state", () => {
  const { c, stats } = started();
  for (const [id, name] of [["grep-exit-1", "bash"], ["permission-denied", "read"], ["fixed-build", "bash"]]) {
    stats.toolStart(id, name); c.advance(10); stats.toolEnd(id, true);
    assert.equal(stats.snapshot().health, "busy", `${id} must not turn the footer red`);
  }
  stats.toolStart("build-retry", "bash"); c.advance(10); stats.toolEnd("build-retry", false);
  stats.settleActivity();
  assert.equal(stats.snapshot().health, "idle");
  assert.equal(tool(stats.snapshot(), "bash").errors, 2);
  assert.equal(tool(stats.snapshot(), "read").errors, 1);
});

test("live parallel tools are included without mutating completed totals", () => {
  const { c, stats } = started();
  c.set(10); stats.toolStart("a", "bash");
  c.set(20); stats.toolStart("b", "bash");
  c.set(50);
  const one = stats.snapshot();
  assert.equal(one.activeTools, 2);
  assert.equal(one.toolMs, 70);
  assert.deepEqual(tool(one, "bash"), {
    tool: "bash", calls: 2, errors: 0, totalMs: 70, maxMs: 40, partial: true,
  });
  assert.deepEqual(stats.snapshot(), one, "snapshot is an idempotent read at a fixed clock");
  c.set(60); stats.toolEnd("a", false); stats.toolEnd("b", false);
  assert.equal(stats.snapshot().toolMs, 90);
});

test("overlapping approvals accrue union time and waiting takes precedence over provider errors", () => {
  const { c, stats } = started();
  c.set(5); stats.requestStart("m", "p");
  c.set(8); stats.messageEnd(assistant({ provider: "p", model: "m", stopReason: "error" }));
  c.set(10); stats.approvalStart("private-approval-a");
  c.set(20); stats.approvalStart("private-approval-b");
  c.set(30); stats.toolStart("tool", "bash");
  c.set(35); stats.toolEnd("tool", true);
  assert.equal(stats.snapshot().health, "waiting");
  c.set(40); stats.approvalEnd("private-approval-a");
  assert.equal(stats.snapshot().pendingApprovals, 1);
  c.set(50); stats.approvalEnd("private-approval-b");
  const snapshot = stats.snapshot();
  assert.equal(snapshot.approvalMs, 40);
  assert.equal(snapshot.pendingApprovals, 0);
  assert.equal(snapshot.health, "error");
});

test("first effective output ignores starts and empty deltas; first text is separate", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("alias", "router");
  c.set(15); stats.delta("text_start", "not-an-effective-kind");
  c.set(20); stats.delta("thinking_delta", "");
  c.set(25); stats.delta("thinking_delta", "reasoning");
  c.set(30); stats.delta("text_delta", "");
  c.set(35); stats.delta("text_delta", "answer");
  c.set(60); stats.messageEnd(assistant({ provider: "router", model: "alias", output: 6 }));
  const snapshot = stats.snapshot();
  assert.equal(snapshot.lastTtftMs, 15);
  assert.equal(snapshot.lastTextMs, 25);
  assert.equal(model(snapshot, "alias").ttftMs, 15);
  assert.equal(model(snapshot, "alias").ttftSamples, 1);
});

test("tool-call output is effective output while provider message_start is not request start", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("m", "p");
  c.set(14); stats.delta("start", "start");
  c.set(17); stats.delta("toolcall_start", "{");
  c.set(20); stats.delta("toolcall_delta", "{\"x\":1}");
  c.set(30); stats.messageEnd(assistant({ provider: "p", model: "m", output: 1 }));
  const snapshot = stats.snapshot();
  assert.equal(snapshot.lastTtftMs, 10);
  assert.equal(snapshot.lastTextMs, undefined);
});

test("actual response model and provider own usage instead of the requested alias", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("auto", "router");
  c.set(110); stats.delta("text_delta", "x");
  c.set(210); stats.messageEnd(assistant({
    provider: "actual-provider", model: "auto", responseModel: "actual-model", output: 20, cost: 0.25,
  }));
  const snapshot = stats.snapshot();
  assert.equal(model(snapshot, "auto"), undefined);
  assert.deepEqual(model(snapshot, "actual-model"), {
    provider: "actual-provider", model: "actual-model", requests: 1, errors: 0,
    outputTokens: 20, cost: 0.25, llmMs: 200, ttftMs: 100, ttftSamples: 1,
    timedOutputTokens: 20, timedOutputMs: 200, tps: 100, partial: false,
  });
  assert.equal(snapshot.lastTps, 100);
});

test("missing provider usage remains unknown while explicit zero remains zero", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("missing", "p");
  c.set(20); stats.messageEnd(assistant({ provider: "p", model: "missing", withUsage: false }));
  c.set(30); stats.requestStart("zero", "p");
  c.set(40); stats.messageEnd(assistant({ provider: "p", model: "zero", output: 0, cost: 0 }));
  const snapshot = stats.snapshot();
  const missing = model(snapshot, "missing");
  assert.equal(missing.outputTokens, undefined);
  assert.equal(missing.cost, undefined);
  assert.equal(missing.tps, undefined);
  assert.equal(missing.partial, true);
  const zero = model(snapshot, "zero");
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.cost, 0);
  assert.equal(zero.tps, 0);
  assert.equal(zero.partial, false);
});

test("TPS is a weighted reported-token rate, never an average of request ratios", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("m", "p");
  c.set(110); stats.messageEnd(assistant({ provider: "p", model: "m", output: 10 })); // 100 tok/s
  c.set(200); stats.requestStart("m", "p");
  c.set(1_100); stats.messageEnd(assistant({ provider: "p", model: "m", output: 10 })); // 11.11 tok/s
  const row = model(stats.snapshot(), "m");
  assert.equal(row.outputTokens, 20);
  assert.equal(row.llmMs, 1_000);
  assert.equal(row.tps, 20, "20 tokens / 1.0 corresponding seconds");
  assert(Math.abs(stats.snapshot().lastTps - (10 / 0.9)) < 1e-12);
});

test("TTFT means only observed samples, not zero-filled silent responses", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("m", "p");
  c.set(60); stats.delta("text_delta", "first");
  c.set(100); stats.messageEnd(assistant({ provider: "p", model: "m", output: 1 }));
  c.set(110); stats.requestStart("m", "p");
  c.set(200); stats.messageEnd(assistant({ provider: "p", model: "m", output: 0 }));
  const row = model(stats.snapshot(), "m");
  assert.equal(row.ttftSamples, 1);
  assert.equal(row.ttftMs, 50);
  assert.equal(stats.snapshot().lastTtftMs, undefined);
});

test("failed retry attempts remain counted and partial; errors recover only next activity", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("m", "p");
  c.set(30); stats.messageEnd(assistant({ provider: "p", model: "m", output: 0, stopReason: "error" }));
  c.set(40); stats.requestStart("m", "p");
  c.set(70); stats.messageEnd(assistant({ provider: "p", model: "m", output: 3 }));
  c.set(80); stats.settleActivity();
  let snapshot = stats.snapshot();
  assert.equal(snapshot.health, "error", "same-run success does not hide a failed attempt");
  assert.equal(model(snapshot, "m").requests, 2);
  assert.equal(model(snapshot, "m").errors, 1);
  assert.equal(model(snapshot, "m").partial, true);
  assert.match(snapshot.limitations.join(" "), /internal retries are not observable/i);

  c.set(90); stats.startActivity();
  snapshot = stats.snapshot();
  assert.equal(snapshot.health, "busy", "the next foreground activity is the recovery boundary");
});

test("aborted and superseded requests are retained as incomplete observations", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("first", "p");
  c.set(20); stats.requestStart("second", "p"); // no request id: close the observed first attempt conservatively
  c.set(30); stats.messageEnd(assistant({ provider: "p", model: "second", output: 0, stopReason: "aborted" }));
  const snapshot = stats.snapshot();
  assert.equal(model(snapshot, "first").requests, 1);
  assert.equal(model(snapshot, "first").partial, true);
  assert.equal(model(snapshot, "second").partial, true);
  assert.equal(snapshot.partial, true);
});

test("unsettled work is live and settlement closes it conservatively", () => {
  const { c, stats } = started();
  c.set(10); stats.requestStart("m", "p");
  c.set(20); stats.toolStart("id", "bash");
  c.set(30); stats.approvalStart("approval");
  c.set(50);
  let snapshot = stats.snapshot();
  assert.equal(snapshot.activeRequests, 1);
  assert.equal(snapshot.activeTools, 1);
  assert.equal(snapshot.pendingApprovals, 1);
  assert.equal(snapshot.llmMs, 40);
  assert.equal(snapshot.toolMs, 30);
  assert.equal(snapshot.approvalMs, 20);
  assert.equal(snapshot.partial, true);

  stats.settleActivity();
  snapshot = stats.snapshot();
  assert.equal(snapshot.activeRequests, 0);
  assert.equal(snapshot.activeTools, 0);
  assert.equal(snapshot.pendingApprovals, 1, "agent settlement does not settle a parent UI prompt");
  assert.equal(snapshot.health, "waiting");
  assert.equal(model(snapshot, "m").partial, true);
  assert.equal(tool(snapshot, "bash").partial, true);
  c.set(60); stats.approvalEnd("approval");
  assert.equal(stats.snapshot().approvalMs, 30);
});

test("monotonic clamping survives backwards, non-finite, and throwing clock samples", () => {
  let value = 100;
  const stats = new SessionStats(() => {
    if (value === "throw") throw new Error("clock fixture");
    return value;
  });
  stats.startActivity();
  value = 150; assert.equal(stats.snapshot().busyMs, 50);
  value = 120; assert.equal(stats.snapshot().busyMs, 50);
  value = Number.POSITIVE_INFINITY; assert.equal(stats.snapshot().busyMs, 50);
  value = "throw"; assert.equal(stats.snapshot().busyMs, 50);
  value = 250; stats.settleActivity();
  assert.equal(stats.snapshot().busyMs, 150);
});

test("model and tool aggregation are bounded with explicit overflow buckets", () => {
  const { c, stats } = started();
  for (let index = 0; index < 80; index++) {
    c.advance(1); stats.requestStart(`model-${index}`, `provider-${index}`);
    c.advance(1); stats.messageEnd(assistant({
      provider: `provider-${index}`, model: `model-${index}`, output: index,
    }));
    c.advance(1); stats.toolStart(`id-${index}`, `tool-${index}`);
    c.advance(1); stats.toolEnd(`id-${index}`, false);
  }
  const snapshot = stats.snapshot();
  assert.equal(snapshot.models.length, 32);
  assert.equal(snapshot.tools.length, 32);
  assert(model(snapshot, "(other)"));
  assert(tool(snapshot, "(other)"));
  assert.equal(snapshot.models.reduce((sum, row) => sum + row.requests, 0), 80);
  assert.equal(snapshot.tools.reduce((sum, row) => sum + row.calls, 0), 80);
  assert.equal(snapshot.partial, true);
});

function eventFixture() {
  const handlers = new Map();
  const listeners = new Map();
  let offCalls = 0;
  const pi = {
    on(name, handler) {
      const bucket = handlers.get(name) ?? new Set();
      bucket.add(handler); handlers.set(name, bucket);
      return () => { if (bucket.delete(handler)) offCalls++; };
    },
    events: {
      on(name, handler) {
        const bucket = listeners.get(name) ?? new Set();
        bucket.add(handler); listeners.set(name, bucket);
        return () => { if (bucket.delete(handler)) offCalls++; };
      },
    },
  };
  return {
    pi,
    handlers,
    listeners,
    offCalls: () => offCalls,
    emit(name, event = {}, ctx = {}) {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    },
    bus(name, value) {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
}

test("event binding uses foreground turns and ignores uncorrelated provider/cache events", () => {
  const c = clock();
  const stats = new SessionStats(c.now);
  const f = eventFixture();
  let changes = 0;
  const dispose = bindStatsEvents(f.pi, () => stats, () => { changes++; });
  const ctx = { model: { id: "main", provider: "p" } };

  f.emit("before_provider_request", { payload: { secret: "CACHE_WARM_SECRET" } }, ctx);
  f.emit("after_provider_response", { status: 200, headers: { secret: "NOT_COMPLETION" } }, ctx);
  assert.equal(stats.snapshot().activeRequests, 0, "idle cache warming is outside the window");

  f.emit("agent_start");
  c.set(10); f.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
  c.set(15); f.emit("before_provider_request", { payload: { secret: "CONCURRENT_WARM_SECRET" } }, ctx);
  c.set(20); f.emit("after_provider_response", { status: 200, headers: {} }, ctx);
  assert.equal(stats.snapshot().activeRequests, 1, "provider/cache hooks neither supersede nor end the turn");
  assert.equal(stats.snapshot().llmMs, 10, "duration starts at the SDK turn, including preflight");
  c.set(30); f.emit("message_end", { message: assistant({ provider: "p", model: "main", output: 2 }) });
  f.emit("agent_end");
  c.set(40);
  assert.equal(stats.snapshot().health, "busy", "agent_end is not the settlement boundary");
  f.emit("agent_settled");
  assert.equal(stats.snapshot().health, "idle");
  assert.equal(changes, 2, "only the busy/idle transitions request immediate redraws");
  dispose();
});

test("streaming observes every delta but notifies only on cheap health transitions", () => {
  const c = clock(), stats = new SessionStats(c.now), f = eventFixture();
  let changes = 0, snapshots = 0;
  const snapshot = stats.snapshot.bind(stats);
  stats.snapshot = () => { snapshots++; return snapshot(); };
  bindStatsEvents(f.pi, () => stats, () => { changes++; });
  f.emit("agent_start");
  f.emit("turn_start", {}, { model: { id: "m", provider: "p" } });
  for (let index = 0; index < 2000; index++) {
    c.advance(1);
    for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
      f.emit("message_update", { assistantMessageEvent: { type, delta: "observed" } });
    }
  }
  assert.equal(changes, 1, "only unknown → busy should request a health repaint");
  assert.equal(snapshots, 0, "notification gating never constructs a model/tool snapshot");
  f.bus("permissions:ui_prompt", { requestId: "one" }); assert.equal(changes, 2);
  f.bus("permissions:ui_prompt", { requestId: "two" }); assert.equal(changes, 2);
  f.bus("permissions:decision", { requestId: "one" }); assert.equal(changes, 2);
  f.bus("permissions:decision", { requestId: "two" }); assert.equal(changes, 3);
  f.emit("message_end", { message: assistant({ model: "m", provider: "p", output: 20, stopReason: "error" }) });
  assert.equal(changes, 4, "provider failure repaints immediately");
  f.emit("agent_settled"); assert.equal(changes, 4, "error remains visible after settlement");
  f.emit("agent_start"); assert.equal(changes, 5);
  f.emit("agent_settled"); assert.equal(changes, 6);
  assert.equal(snapshots, 0);
  const observed = snapshot();
  assert.equal(observed.lastTtftMs, 1);
  assert.equal(observed.llmMs, 2000);
  assert.equal(observed.models[0].outputTokens, 20, "suppressing redraws does not suppress observations");
});

test("binding forwards only non-empty effective deltas and aggregates actual model identity", () => {
  const c = clock();
  const stats = new SessionStats(c.now);
  const f = eventFixture();
  bindStatsEvents(f.pi, () => stats, () => {});
  f.emit("agent_start");
  c.set(5); f.emit("turn_start", { turnIndex: 0, timestamp: 0 }, { model: { id: "auto", provider: "router" } });
  c.set(10); f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
  c.set(15); f.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "ok" } });
  c.set(25); f.emit("message_end", { message: assistant({
    provider: "served", model: "auto", responseModel: "real", output: 4,
  }) });
  const snapshot = stats.snapshot();
  assert.equal(snapshot.lastTtftMs, 10);
  assert.equal(model(snapshot, "real").provider, "served");
});

test("binding measures idle/overlapping permission asks without exposing IDs or event data", () => {
  const c = clock();
  const stats = new SessionStats(c.now);
  const f = eventFixture();
  bindStatsEvents(f.pi, () => stats, () => {});
  c.set(5); f.bus("permissions:ui_prompt", { requestId: "SECRET_APPROVAL_A", prompt: "SECRET_PROMPT" });
  assert.equal(stats.snapshot().health, "waiting", "parent UI waits are observed before agent_start");
  f.emit("agent_start");
  c.set(10); f.bus("permissions:ui_prompt", { requestId: "SECRET_APPROVAL_B", toolArgs: "SECRET_ARGS" });
  c.set(15); f.emit("tool_execution_start", {
    toolCallId: "SECRET_TOOL_ID", toolName: "bash", args: { command: "SECRET_COMMAND" },
  });
  c.set(20); f.bus("permissions:decision", { requestId: "SECRET_APPROVAL_A", decision: "allow" });
  c.set(25); f.emit("tool_execution_end", {
    toolCallId: "SECRET_TOOL_ID", toolName: "bash", result: "SECRET_RESULT", isError: false,
  });
  c.set(30); f.bus("permissions:decision", { requestId: "SECRET_APPROVAL_B", decision: "deny" });
  const serialized = JSON.stringify(stats.snapshot());
  for (const secret of ["SECRET_APPROVAL", "SECRET_PROMPT", "SECRET_ARGS", "SECRET_TOOL_ID",
    "SECRET_COMMAND", "SECRET_RESULT"]) {
    assert(!serialized.includes(secret), `snapshot retained ${secret}`);
  }
  assert.equal(stats.snapshot().approvalMs, 25);
});

test("prompt settlement ends only its own approval wait even without a matching decision", () => {
  const c = clock(), stats = new SessionStats(c.now), f = eventFixture();
  let changes = 0;
  const dispose = bindStatsEvents(f.pi, () => stats, () => { changes++; });
  f.emit("agent_start");
  c.set(5); f.bus("permissions:ui_prompt", { requestId: "local" });
  c.set(10); f.bus("permissions:ui_prompt", { requestId: "worker" });
  f.emit("agent_settled");
  c.set(15); f.bus("permissions:decision", { requestId: "different-error-id", resolution: "gate_error" });
  f.bus("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
  f.bus("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
  assert.equal(stats.snapshot().pendingApprovals, 1);
  assert.equal(stats.health, "waiting");
  c.set(30); f.bus("managed-permissions:ui_prompt_end:v1", { requestId: "worker" });
  assert.equal(stats.health, "idle");
  assert.equal(stats.snapshot().approvalMs, 25, "overlapping waits end at actual UI settlement, not parent idle");
  const notified = changes;
  c.set(50); f.bus("permissions:decision", { requestId: "worker" });
  assert.equal(changes, notified);
  assert.equal(stats.snapshot().approvalMs, 25);
  dispose();
  stats.approvalStart("after-disposal");
  f.bus("managed-permissions:ui_prompt_end:v1", { requestId: "after-disposal" });
  assert.equal(stats.snapshot().pendingApprovals, 1, "shutdown unsubscribes the new channel too");
});

test("event observers and redraws are fail-open; unsubscribe is idempotent", () => {
  const f = eventFixture();
  let statsCalls = 0;
  const dispose = bindStatsEvents(f.pi, () => ({
    startActivity() { statsCalls++; throw new Error("telemetry failure"); },
  }), () => { throw new Error("render failure"); });
  assert.doesNotThrow(() => f.emit("agent_start"));
  assert.equal(statsCalls, 1);

  const expectedSubscriptions = 10;
  assert.equal([...f.handlers.values()].reduce((sum, set) => sum + set.size, 0)
    + [...f.listeners.values()].reduce((sum, set) => sum + set.size, 0), expectedSubscriptions);
  assert.doesNotThrow(dispose);
  assert.doesNotThrow(dispose);
  assert.equal(f.offCalls(), expectedSubscriptions);
  assert([...f.handlers.values(), ...f.listeners.values()].every((set) => set.size === 0));
  f.emit("agent_start");
  assert.equal(statsCalls, 1, "disposed observers stay detached");
});

test("malformed bus and message objects cannot escape observers", () => {
  const c = clock();
  const stats = new SessionStats(c.now);
  const f = eventFixture();
  bindStatsEvents(f.pi, () => stats, () => {});
  f.emit("agent_start");
  c.set(1); f.emit("turn_start", { turnIndex: 0, timestamp: 0 }, { model: { id: "m", provider: "p" } });
  const poison = {};
  Object.defineProperty(poison, "requestId", { get() { throw new Error("poison bus"); } });
  assert.doesNotThrow(() => f.bus("permissions:ui_prompt", poison));
  assert.doesNotThrow(() => f.bus("managed-permissions:ui_prompt_end:v1", poison));
  const badMessage = {};
  Object.defineProperty(badMessage, "role", { get() { throw new Error("poison message"); } });
  assert.doesNotThrow(() => f.emit("message_end", { message: badMessage }));
  assert.equal(stats.snapshot().activeRequests, 1);
});
