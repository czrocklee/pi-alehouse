#!/usr/bin/env node
// Pure worker-stat regressions using the repository's pinned Jiti toolchain.
// No model, network, wall-clock timer, transcript, or session file is involved.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const harness = root;
const require = createRequire(join(harness, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { WorkerStats } = await jiti.import(
  join(root, "extensions/lib/worker-stats.ts"),
);

function clock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    set: (next) => { value = next; },
    advance: (delta) => { value += delta; },
  };
}

function assistant({ provider = "p", model = "m", responseModel, output = 0,
  cost = 0, stopReason = "stop", withUsage = true, errorMessage } = {}) {
  return {
    role: "assistant",
    provider,
    model,
    ...(responseModel ? { responseModel } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    stopReason,
    ...(withUsage ? { usage: { output, cost: { total: cost } } } : {}),
  };
}

const model = (snapshot, name, provider) => snapshot.models.find((row) =>
  row.model === name && (provider === undefined || row.provider === provider));
const tool = (snapshot, name) => snapshot.tools.find((row) => row.tool === name);

function finishRun(sink, message, kind = "success") {
  if (message) sink.messageEnd(message);
  sink.settleActivity();
  sink.endRun(kind);
}

test("parallel worker busy durations are additive rather than a main-session union", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const a = workers.attach("a");
  const b = workers.attach("b");
  assert(a && b);
  a.beginRun(); b.beginRun();
  a.startActivity(); b.startActivity();
  c.set(100);
  finishRun(a); finishRun(b);
  assert.deepEqual(workers.snapshot(), {
    observed: 2, resident: 2, running: 0,
    busyMs: 200, llmMs: 0, toolMs: 0,
    activeRequests: 0, activeTools: 0,
    health: "idle", partial: false, models: [], tools: [], recentErrors: [],
  });
});

test("worker tool totals are execution-only; the oldest running call's age is separate", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const a = workers.attach("a");
  const b = workers.attach("b");
  assert(a && b);
  a.beginRun(); b.beginRun();
  a.startActivity(); b.startActivity();
  a.toolStart("done", "bash");
  c.set(30); a.toolEnd("done", false, 12);
  a.toolStart("awaiting-approval", "bash");
  c.set(40); b.toolStart("running", "read");
  c.set(90);
  let snapshot = workers.snapshot();
  assert.equal(snapshot.toolMs, 12, "running calls, including one awaiting approval, add no tool time");
  assert.equal(snapshot.activeTools, 2);
  assert.equal(snapshot.longestActiveToolMs, 60, "the oldest call across workers");
  assert.deepEqual(tool(snapshot, "bash"), { tool: "bash", calls: 1, errors: 0, totalMs: 12, maxMs: 12, partial: false });
  assert.equal(tool(snapshot, "read"), undefined);
  a.toolEnd("awaiting-approval", true, 0);
  b.toolEnd("running", false, 5);
  finishRun(a); finishRun(b);
  snapshot = workers.snapshot();
  assert.equal(snapshot.toolMs, 17);
  assert.equal(snapshot.longestActiveToolMs, undefined);
  assert.deepEqual(tool(snapshot, "bash"), { tool: "bash", calls: 2, errors: 1, totalMs: 12, maxMs: 12, partial: false });
});

test("same model merges by provider with sample-weighted TTFT and raw timed TPS", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const a = workers.attach("a");
  const b = workers.attach("b");
  assert(a && b);

  a.beginRun(); a.startActivity(); a.requestStart("m", "p");
  c.set(20); a.delta("text_delta");
  c.set(100); finishRun(a, assistant({ output: 10, cost: 1 }));

  b.beginRun(); b.startActivity(); b.requestStart("m", "p");
  c.set(400); b.delta("thinking_delta");
  c.set(1_000); finishRun(b, assistant({ output: 10, cost: 2 }));

  a.beginRun(); a.startActivity(); a.requestStart("m", "p");
  c.set(1_500); finishRun(a, assistant({ withUsage: false }));

  b.beginRun(); b.startActivity(); b.requestStart("m", "p");
  finishRun(b, assistant({ output: 99, cost: 4 })); // zero duration has no timed rate

  a.beginRun(); a.startActivity(); a.requestStart("m", "other-provider");
  c.set(1_600); finishRun(a, assistant({ provider: "other-provider", output: 1 }));

  const snapshot = workers.snapshot();
  const row = model(snapshot, "m", "p");
  assert(row);
  assert.equal(row.requests, 4);
  assert.equal(row.outputTokens, 119);
  assert.equal(row.cost, 7);
  assert.equal(row.llmMs, 1_500, "missing usage still contributes LLM duration");
  assert.equal(row.ttftSamples, 2);
  assert.equal(row.ttftMs, 160, "TTFT means are weighted by their sample counts");
  assert.equal(row.timedOutputTokens, 20);
  assert.equal(row.timedOutputMs, 1_000);
  assert.equal(row.tps, 20, "missing and zero-duration reports do not dilute timed TPS");
  assert.equal(row.partial, true);
  assert.equal(model(snapshot, "m", "other-provider").requests, 1);
  assert.equal(snapshot.models.length, 2);
});

test("resume is cumulative, duplicate active attach is stable, and new workers are distinct", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const resumed = workers.attach("resume");
  assert(resumed);
  assert.equal(workers.attach("resume"), resumed);

  for (let run = 0; run < 2; run++) {
    resumed.beginRun(); resumed.startActivity(); resumed.requestStart("m", "p");
    c.advance(10);
    finishRun(resumed, assistant({ output: 1 }));
  }
  assert.equal(workers.snapshot().observed, 1);
  assert.equal(model(workers.snapshot(), "m").requests, 2);
  assert(workers.attach("new-worker"));
  assert.equal(workers.snapshot().observed, 2);
});

test("release archives exactly once and stale sink calls cannot resurrect or rebill", () => {
  const c = clock();
  let changes = 0;
  const workers = new WorkerStats(c.now, () => { changes++; });
  const sink = workers.attach("worker");
  assert(sink);
  sink.beginRun(); sink.startActivity(); sink.requestStart("m", "p");
  c.set(100); sink.messageEnd(assistant({ output: 5, cost: 1 }));
  sink.toolStart("id", "bash");
  c.set(130); sink.toolEnd("id", false);
  // A duplicate final message/tool result cannot bill model usage again.
  sink.messageEnd(assistant({ output: 500, cost: 500 }));
  sink.settleActivity(); sink.endRun("success");

  sink.dispose();
  const released = workers.snapshot();
  assert.equal(released.resident, 0);
  assert.equal(model(released, "m").outputTokens, 5);
  assert.equal(model(released, "m").cost, 1);
  assert.equal(tool(released, "bash").calls, 1);
  assert.deepEqual(workers.snapshot(), released);

  sink.dispose();
  sink.beginRun(); sink.startActivity(); sink.requestStart("late", "p");
  c.set(1_000); sink.messageEnd(assistant({ model: "late", output: 99 }));
  sink.toolStart("late", "late-tool"); sink.toolEnd("late", true); sink.endRun("error");
  assert.deepEqual(workers.snapshot(), released);
  assert(changes > 0);
});

test("running and latest resident failure drive health, then beginRun and retirement recover", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  assert.equal(workers.snapshot().health, "unknown");
  const sink = workers.attach("worker");
  assert(sink);
  assert.equal(workers.snapshot().health, "idle");
  sink.beginRun();
  assert.equal(workers.snapshot().health, "busy");
  sink.startActivity(); sink.requestStart("m", "p");
  c.set(10); sink.messageEnd(assistant({ stopReason: "error" }));
  assert.equal(workers.snapshot().health, "error");
  sink.endRun("error");
  assert.equal(workers.snapshot().health, "error");

  sink.beginRun();
  assert.equal(workers.snapshot().health, "busy", "a resumed run clears latest-failure health");
  sink.startActivity(); c.set(20); finishRun(sink);
  assert.equal(workers.snapshot().health, "idle");

  sink.beginRun(); sink.startActivity(); sink.requestStart("unfinished", "p");
  c.set(30); sink.endRun("aborted");
  const aborted = workers.snapshot();
  assert.equal(aborted.running, 0);
  assert.equal(aborted.activeRequests, 0);
  assert.equal(model(aborted, "unfinished").outputTokens, undefined);
  assert.equal(aborted.partial, true);
  sink.dispose();
  assert.equal(workers.snapshot().health, "idle", "retired errors are counters, not sticky health");
});

test("tool errors do not poison resident health or request token-by-token paints", () => {
  const c = clock();
  let changes = 0;
  const workers = new WorkerStats(c.now, () => { changes++; });
  const sink = workers.attach("worker");
  sink.beginRun(); sink.startActivity(); sink.requestStart("m", "p");
  const before = changes;
  for (let i = 0; i < 2000; i++) { c.advance(1); sink.delta("text_delta"); }
  sink.messageEnd(assistant({ output: 20 }));
  for (const id of ["grep-exit-1", "permission-denied", "failed-build"]) {
    sink.toolStart(id, "bash"); c.advance(10); sink.toolEnd(id, true);
    assert.equal(workers.snapshot().health, "busy", `${id} is not a failed Run`);
  }
  assert.equal(changes, before, "neither streaming nor tool failures request a health repaint");
  finishRun(sink);
  assert.equal(workers.snapshot().health, "idle", "an idle successful Run cannot hold the footer red");
  assert.equal(workers.snapshot().tools[0].errors, 3);
  assert.equal(changes, before + 1);
  c.advance(1000);
  assert.equal(workers.snapshot().health, "idle");
  sink.dispose();
  assert.equal(workers.snapshot().tools[0].errors, 3, "retirement preserves tool errors");
});

test("worker failures name the worker; a retry, a successful Run or the parent's successful run clears them", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const a = workers.attach("a7");
  const b = workers.attach("b2");
  a.beginRun(); a.startActivity(); a.requestStart("m", "p");
  c.set(10); a.messageEnd(assistant({ stopReason: "error", responseModel: "actual", errorMessage: "429 rate\nlimited" }));
  let snapshot = workers.snapshot();
  assert.equal(snapshot.health, "error");
  assert.deepEqual(snapshot.recentErrors, [{ ageMs: 0, workerId: "a7", provider: "p", model: "actual",
    message: "429 rate limited", cleared: false }]);
  a.requestStart("m", "p");
  c.set(20); a.messageEnd(assistant());
  assert.equal(workers.snapshot().health, "busy", "the child's SDK auto-retry recovered");
  a.settleActivity(); a.endRun("success");

  // A Run can fail with no provider error, and its worker may never be resumed.
  b.beginRun();
  c.set(30); b.endRun("error");
  snapshot = workers.snapshot();
  assert.equal(snapshot.health, "error");
  assert.deepEqual(snapshot.recentErrors.map(({ workerId, message, cleared }) => [workerId, message, cleared]),
    [["b2", "Run failed without a provider error", false], ["a7", "429 rate limited", true]]);

  a.beginRun(); a.startActivity(); a.requestStart("m", "p");
  c.set(40); a.messageEnd(assistant({ stopReason: "error" }));
  workers.clearSettledFailures();
  snapshot = workers.snapshot();
  assert.equal(snapshot.health, "error", "a running worker's failure is not the parent's to clear");
  assert.equal(snapshot.recentErrors.find(({ workerId }) => workerId === "b2").cleared, true,
    "the idle worker that was never resumed no longer holds the indicator red");
  a.settleActivity(); a.endRun("error");
  assert.equal(workers.snapshot().recentErrors.filter(({ workerId, cleared }) => workerId === "a7" && !cleared).length, 1,
    "a failed response and its failed Run are one failure");
  a.dispose();
  snapshot = workers.snapshot();
  assert.equal(snapshot.health, "idle");
  assert(snapshot.recentErrors.every(({ cleared }) => cleared), "retired failures remain as cleared history");
});

test("a rejected Run is deliberate failure evidence without invented model work", () => {
  const workers = new WorkerStats(() => 0);
  const sink = workers.attach("rejected-at-port-admission");
  sink.beginRun(); sink.endRun("error");
  const failed = workers.snapshot();
  assert.equal(failed.health, "error");
  assert.equal(failed.busyMs, 0); assert.equal(failed.llmMs, 0);
  assert.equal(failed.models.length, 0); assert.equal(failed.tools.length, 0);
  assert.equal(failed.partial, true);
  sink.beginRun(); assert.equal(workers.snapshot().health, "busy");
  sink.endRun("success"); assert.equal(workers.snapshot().health, "idle");
});

test("store disposal freezes totals and makes every resident sink inert", () => {
  const c = clock();
  const workers = new WorkerStats(c.now);
  const sink = workers.attach("worker");
  assert(sink);
  sink.beginRun(); sink.startActivity(); sink.requestStart("m", "p");
  c.set(25); sink.messageEnd(assistant({ output: 2 }));
  workers.dispose();
  const frozen = workers.snapshot();
  assert.equal(frozen.resident, 0);
  assert.equal(frozen.running, 0);
  assert.equal(frozen.partial, true, "disposing a running worker is conservative");
  assert.equal(model(frozen, "m").outputTokens, 2);
  sink.messageEnd(assistant({ output: 200 })); sink.endRun("success"); sink.dispose();
  assert.equal(workers.attach("after-disposal"), undefined);
  workers.dispose();
  assert.deepEqual(workers.snapshot(), frozen);
});

test("resident admission and long retired churn remain bounded with explicit overflow", () => {
  const capped = new WorkerStats(() => 0);
  const residents = [];
  for (let index = 0; index < 32; index++) residents.push(capped.attach(`resident-${index}`));
  assert(residents.every(Boolean));
  assert.equal(capped.attach("overflow-resident"), undefined);
  assert.equal(capped.snapshot().observed, 33);
  assert.equal(capped.snapshot().resident, 32);
  assert.equal(capped.snapshot().partial, true);
  assert.equal(capped.attach(""), undefined);
  assert.equal(capped.snapshot().observed, 33, "invalid IDs are not workers");
  for (const sink of residents) sink.dispose();

  const c = clock();
  const workers = new WorkerStats(c.now);
  for (let index = 0; index < 200; index++) {
    const sink = workers.attach(`worker-${index}`);
    assert(sink);
    sink.beginRun(); sink.startActivity();
    sink.requestStart(`model-${index}`, `provider-${index}`);
    c.advance(1); sink.messageEnd(assistant({
      provider: `provider-${index}`, model: `model-${index}`, output: 1, cost: 1,
    }));
    sink.toolStart(`id-${index}`, `tool-${index}`);
    c.advance(1); sink.toolEnd(`id-${index}`, false);
    finishRun(sink);
    sink.dispose();
  }
  const snapshot = workers.snapshot();
  assert.equal(snapshot.observed, 200);
  assert.equal(snapshot.resident, 0);
  assert.equal(snapshot.models.length, 32);
  assert.equal(snapshot.tools.length, 32);
  assert(model(snapshot, "(other)"));
  assert(tool(snapshot, "(other)"));
  assert.equal(snapshot.models.reduce((sum, row) => sum + row.requests, 0), 200);
  assert.equal(snapshot.tools.reduce((sum, row) => sum + row.calls, 0), 200);
  assert.equal(snapshot.models.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), 200);
  assert.equal(snapshot.models.reduce((sum, row) => sum + (row.cost ?? 0), 0), 200);
  assert.equal(snapshot.partial, true);
});
