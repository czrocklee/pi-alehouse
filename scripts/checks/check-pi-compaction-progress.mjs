#!/usr/bin/env node
// Synthetic, fake-clock UI checks only. No sessions, credentials or providers.
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const {
  CompactionHistory,
  CompactionProgress,
  compactionModelKey,
  previousSummaryTokens,
  sharedCompactionHistory,
  summaryOutputTokens,
} = await createJiti(import.meta.url).import("../../src/extensions/lib/compaction-progress.ts");
let clock = 0;
const progress = new CompactionProgress(() => clock);
// 9000 reported output tokens over 240 s = 37.5 end-to-end effective TPS.
// The next summary's estimated 15% growth predicts 10350 / 37.5 = 276 s.
const SUMMARY = 9000;
const SUMMARY_MS = 240_000;
const NEXT_MS = 276_000;
const options = { modelKey: "provider/model", previousOutputTokens: SUMMARY };
function train(count = 1, duration = SUMMARY_MS, input = options, success = true, out = SUMMARY) {
  for (let i = 0; i < count; i++) {
    progress.start(input);
    clock += duration;
    progress.finish(success, out);
  }
}
function inspect(input = options, elapsed = NEXT_MS / 2) {
  progress.start(input);
  clock += elapsed;
  return progress.snapshot();
}

assert.equal(progress.snapshot(), undefined);
assert.equal(inspect().percent, undefined, "a previous summary alone cannot invent model TPS");
assert.match(progress.snapshot().text, /^⠋ 2m18s$/);
progress.finish(false);
train(1, SUMMARY_MS, { modelKey: options.modelKey });
assert.equal(
  inspect({ modelKey: options.modelKey }).percent,
  undefined,
  "a first compaction has no target summary size even with known TPS",
);
progress.finish(false);
assert.equal(inspect().percent, 50, "reported output and actual elapsed time calibrate TPS");
assert.match(progress.snapshot().text, /^⠋ ≈50% 2m18s$/);
const first = progress.snapshot().text;
clock += 100;
assert.notEqual(progress.snapshot().text, first, "animation derives from time");
clock += NEXT_MS * 0.45;
assert.equal(progress.snapshot().percent, undefined, "95% waiting zone drops ETA");
clock += 30_000;
assert.equal(progress.snapshot().percent, undefined, "overrun remains elapsed-only");
progress.finish(false);
assert.equal(progress.snapshot(), undefined);
assert.equal(
  inspect({ previousOutputTokens: SUMMARY }).percent,
  undefined,
  "no model, no estimate",
);
assert.equal(inspect({ ...options, modelKey: "" }).percent, undefined);
for (const previousOutputTokens of [NaN, Infinity, -1, 0]) {
  assert.equal(inspect({ ...options, previousOutputTokens }).percent, undefined);
  progress.finish(false);
}
assert.equal(
  inspect({ ...options, previousOutputTokens: SUMMARY * 2 }, NEXT_MS).percent,
  50,
  "twice the expected output takes twice as long at observed TPS",
);
progress.finish(false);

progress.reset();
train(1, SUMMARY_MS * 2);
assert.equal(inspect().percent, 25, "twice as slow halves progress at the same elapsed time");
progress.finish(false);
assert.equal(
  inspect({ ...options, modelKey: "other" }).percent,
  undefined,
  "samples are per model",
);
progress.finish(false);
train();
assert.equal(inspect().percent, 33, "rate weights actual tokens by their corresponding time");
progress.finish(false);
train();
assert.equal(inspect().percent, 37, "all retained observations contribute their measured duration");
progress.finish(false);
progress.reset();
train(1, SUMMARY_MS * 2, options, true, SUMMARY * 2);
assert.equal(inspect().percent, 50, "twice the output in twice the time has the same TPS");
progress.finish(false);
progress.reset();
train(1, SUMMARY_MS * 10);
assert.equal(inspect().percent, 5, "measured slow throughput is not clamped to a fixed prior");
progress.finish(false);

progress.reset();
train(1, SUMMARY_MS * 2, options, false);
assert.equal(inspect().percent, undefined, "failures/cancellations do not train");
progress.finish(false);
for (const out of [NaN, Infinity, 0, -1]) train(1, SUMMARY_MS * 2, options, true, out);
progress.start(options);
clock += SUMMARY_MS * 2;
progress.finish(true);
assert.equal(inspect().percent, undefined, "missing/invalid reported output cannot train TPS");
progress.finish(false);
train(1, 0);
train(1, SUMMARY_MS, { previousOutputTokens: SUMMARY });
train(1, SUMMARY_MS, { ...options, modelKey: "" });
assert.equal(inspect().percent, undefined, "zero duration or missing model cannot train TPS");
progress.finish(false);
train(1, SUMMARY_MS * 2);
progress.finish(true, SUMMARY);
progress.finish(true, SUMMARY);
assert.equal(inspect().percent, 25, "finish is idempotent");
progress.finish(false);
progress.reset();
for (let i = 0; i < 3; i++) {
  progress.start(options);
  clock += SUMMARY_MS * 2;
  progress.start({ ...options, modelKey: "replacement" });
  progress.finish(false);
}
assert.equal(inspect().percent, undefined, "repeated starts do not record success");
progress.reset();
train();
progress.reset();
assert.equal(progress.snapshot(), undefined);
assert.equal(inspect().percent, undefined, "explicit reset clears history");
progress.finish(false);
train(1, SUMMARY_MS * 2);
progress.start(options);
progress.finish(false);
assert.equal(inspect().percent, 25, "dropping an unfinished observation keeps history");

progress.reset();
train();
progress.start(options);
clock += 1000;
assert.equal(progress.snapshot().elapsedMs, 1000);
assert.notEqual(progress.snapshot().percent, undefined);
clock -= 2000;
assert.equal(progress.snapshot().elapsedMs, 1000, "clock reversal cannot regress elapsed");
assert.equal(progress.snapshot().percent, undefined);
clock += 4000;
assert.equal(
  progress.snapshot().percent,
  undefined,
  "clock recovery cannot resurrect the estimate",
);
clock = NaN;
assert.equal(progress.snapshot().elapsedMs, 3000);
progress.finish(true, SUMMARY);
clock = 0;
assert.equal(inspect().percent, 50, "an unreliable clock cannot pollute observed TPS");
progress.reset();
progress.start(options);
clock = Infinity;
assert.equal(progress.snapshot().elapsedMs, 0);
progress.finish(true, SUMMARY);
clock = NaN;
progress.start(options);
clock = 10_000;
assert.equal(progress.snapshot().elapsedMs, 0, "invalid start clock cannot train");
assert.equal(progress.snapshot().percent, undefined);
progress.finish(true, SUMMARY);
assert.equal(inspect().percent, undefined);
const throwing = new CompactionProgress(() => {
  throw new Error("clock unavailable");
});
throwing.start(options);
assert.equal(throwing.snapshot().elapsedMs, 0);
throwing.finish(true, SUMMARY);
assert.equal(throwing.snapshot(), undefined);

// Behavioral eviction checks: no private state inspection or diagnostic API.
clock = 0;
progress.reset();
train(8, SUMMARY_MS * 2);
train(4);
assert.equal(inspect().percent, 33, "only four of the oldest eight samples remain");
progress.finish(false);
train(4);
assert.equal(inspect().percent, 50, "the latest eight samples determine the rate");
progress.reset();
train();
for (let i = 0; i < 64; i++) train(1, SUMMARY_MS, { ...options, modelKey: `model-${i}` });
assert.equal(inspect().percent, undefined, "global history evicts after 64 samples");
progress.reset();
progress.start(options);
clock += 65_000;
assert.match(progress.snapshot().text, / 1m5s$/);
clock += 3_600_000;
assert.match(progress.snapshot().text, / 1h1m$/);
progress.finish(true, SUMMARY);
assert.equal(progress.snapshot(), undefined);
// Default clock is callable without requiring a session or starting a timer.
const defaults = new CompactionProgress();
defaults.start(options);
assert.ok(Number.isFinite(defaults.snapshot().elapsedMs));
defaults.reset();

// Distinct observers/facades may share data, never their active observations.
const samples = { compaction: [], response: [] };
const oldObserver = new CompactionProgress(() => clock, new CompactionHistory(samples));
oldObserver.start(options);
clock += SUMMARY_MS;
oldObserver.finish(true, SUMMARY);
oldObserver.start(options);
const replacement = new CompactionProgress(() => clock, new CompactionHistory(samples));
assert.equal(replacement.snapshot(), undefined);
replacement.start(options);
clock += NEXT_MS / 2;
assert.equal(oldObserver.snapshot().percent, 50);
assert.equal(replacement.snapshot().percent, 50);
oldObserver.finish(false);
assert.equal(replacement.snapshot().percent, 50, "old teardown cannot retire replacement state");
replacement.finish(false);
const isolated = new CompactionProgress(() => clock);
isolated.start(options);
clock += NEXT_MS / 2;
assert.equal(isolated.snapshot().percent, undefined, "default histories are not shared");
oldObserver.reset();
replacement.start(options);
clock += NEXT_MS / 2;
assert.equal(
  replacement.snapshot().percent,
  undefined,
  "explicit clearing updates all shared facades",
);

// Unsupported magnitudes cannot overflow the bounded weighted totals or paint NaN.
const extremes = new CompactionHistory();
for (const [tokens, ms] of [
  [1e308, 1e308],
  [Number.MAX_VALUE, 1000],
  [1000, Number.MAX_VALUE],
]) {
  extremes.recordCompaction(options.modelKey, tokens, ms);
}
assert.equal(extremes.estimateMs(options.modelKey, SUMMARY), undefined);
for (let i = 0; i < 8; i++) {
  extremes.recordCompaction(options.modelKey, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}
assert.ok(Number.isFinite(extremes.estimateMs(options.modelKey, Number.MAX_SAFE_INTEGER)));
const extremeProgress = new CompactionProgress(() => clock, extremes);
extremeProgress.start({ ...options, previousOutputTokens: Number.MAX_VALUE });
assert.equal(extremeProgress.snapshot().percent, undefined);

// Main Stats timings are a cold-start fallback; native compactions take over.
const modelHistory = new CompactionHistory();
const fromMain = new CompactionProgress(() => clock, modelHistory);
modelHistory.recordResponse(options.modelKey, 10, 100);
modelHistory.recordResponse(options.modelKey, 10, 900);
fromMain.start(options);
clock += 258750; // 10350 / (20 tokens / 1s) = 517.5s.
assert.equal(
  fromMain.snapshot().percent,
  50,
  "main observations work before any compaction sample",
);
fromMain.finish(false);
modelHistory.recordResponse("other", SUMMARY, SUMMARY_MS);
fromMain.start({ ...options, modelKey: "unseen" });
clock += 1000;
assert.equal(fromMain.snapshot().percent, undefined, "another identity cannot supply TPS");
fromMain.finish(false);
for (const [tokens, ms] of [
  [0, 1000],
  [-1, 1000],
  [NaN, 1000],
  [Infinity, 1000],
  [100, 0],
  [100, NaN],
]) {
  modelHistory.recordResponse(options.modelKey, tokens, ms);
}
assert.equal(
  modelHistory.estimateMs(options.modelKey, SUMMARY),
  517500,
  "invalid samples are excluded",
);

modelHistory.clear();
for (let i = 0; i < 8; i++) modelHistory.recordResponse(options.modelKey, 50, 1000);
fromMain.start(options);
for (let i = 0; i < 8; i++) modelHistory.recordResponse(options.modelKey, 100, 1000);
clock += 103500;
assert.equal(fromMain.snapshot().percent, 50, "an active estimate stays frozen as TPS changes");
clock += 256500;
fromMain.finish(true, SUMMARY); // 9000 / 360s = 25 TPS, beside eight 100 TPS replies.
fromMain.start(options);
clock += 207000; // 10350 / 25 TPS = 414s.
assert.equal(
  fromMain.snapshot().percent,
  50,
  "a native compaction sample replaces the main fallback, without ratio correction",
);
fromMain.finish(false);
for (let i = 0; i < 64; i++) modelHistory.recordResponse(options.modelKey, 100, 1000);
for (let i = 0; i < 64; i++) modelHistory.recordResponse(`other-${i}`, 100, 1000);
fromMain.start(options);
clock += 207000;
assert.equal(
  fromMain.snapshot().percent,
  50,
  "frequent main replies cannot evict or dilute compaction samples",
);
fromMain.finish(false);
modelHistory.recordCompaction(options.modelKey, SUMMARY * 3, SUMMARY_MS);
fromMain.start(options);
clock += 103500; // (9000 + 27000) / (360s + 240s) = 60 TPS -> 172.5s.
assert.equal(fromMain.snapshot().percent, 60, "compaction samples pool by weighted time");
fromMain.finish(false);
const otherOnly = new CompactionHistory();
otherOnly.recordCompaction("compacted", SUMMARY, SUMMARY_MS);
otherOnly.recordResponse("replied", 100, 1000);
assert.equal(
  Math.round(otherOnly.estimateMs("replied", SUMMARY)),
  103500,
  "another model's compaction does not suppress this model's main fallback",
);
fromMain.reset();
fromMain.start(options);
clock += NEXT_MS / 2;
assert.equal(fromMain.snapshot().percent, undefined, "reset clears both sources");
fromMain.finish(false);

// The shared store survives module replacement, and a foreign value never throws.
const SHARED_KEY = Symbol.for("pi-alehouse:compaction-progress:history:v1");
const savedShared = globalThis[SHARED_KEY];
try {
  delete globalThis[SHARED_KEY];
  sharedCompactionHistory().recordResponse(options.modelKey, 100, 1000);
  sharedCompactionHistory().recordCompaction(options.modelKey, SUMMARY, SUMMARY_MS);
  assert.deepEqual(Object.keys(globalThis[SHARED_KEY]).sort(), ["compaction", "response"]);
  assert.equal(
    sharedCompactionHistory().estimateMs(options.modelKey, SUMMARY),
    NEXT_MS,
    "separately created facades share one store",
  );
  for (const foreign of ["garbage", [], { compaction: [] }, null]) {
    globalThis[SHARED_KEY] = foreign;
    const local = sharedCompactionHistory();
    assert.equal(local.estimateMs(options.modelKey, SUMMARY), undefined);
    local.recordCompaction(options.modelKey, SUMMARY, SUMMARY_MS);
    assert.equal(local.estimateMs(options.modelKey, SUMMARY), NEXT_MS);
    if (foreign === null) assert.notEqual(globalThis[SHARED_KEY], null);
    else assert.equal(globalThis[SHARED_KEY], foreign, "a foreign value is left untouched");
  }
} finally {
  if (savedShared === undefined) delete globalThis[SHARED_KEY];
  else globalThis[SHARED_KEY] = savedShared;
}

const identity = { provider: "p", id: "requested", api: "api" };
assert.equal(compactionModelKey(undefined, "high"), undefined);
assert.equal(compactionModelKey({ ...identity, api: "pi-virtual" }, "high"), undefined);
assert.notEqual(compactionModelKey(identity, "high"), compactionModelKey(identity, "low"));
assert.notEqual(
  compactionModelKey(identity, "high"),
  compactionModelKey({ ...identity, api: "other" }, "high"),
);
assert.notEqual(
  compactionModelKey(identity, "high"),
  compactionModelKey({ ...identity, provider: "other" }, "high"),
);

// Only reported usage trains TPS; text fallback is confined to target sizing.
assert.equal(summaryOutputTokens({ summary: "x".repeat(400), usage: { output: 7 } }), 7);
for (const output of [0, -1, NaN, Infinity]) {
  assert.equal(summaryOutputTokens({ summary: "x".repeat(400), usage: { output } }), undefined);
}
assert.equal(summaryOutputTokens({ summary: "x".repeat(401) }), undefined);
assert.equal(summaryOutputTokens({ summary: "" }), undefined);
assert.equal(summaryOutputTokens({}), undefined);
assert.equal(summaryOutputTokens(undefined), undefined);
const branch = [
  { type: "compaction", summary: "old", usage: { output: 11 } },
  { type: "message" },
  { type: "compaction", summary: "kept", usage: { output: 22 } },
  { type: "custom", summary: "kept", usage: { output: 33 } },
  { type: "compaction", summary: "x".repeat(401), usage: { output: 0 } },
];
assert.equal(previousSummaryTokens(undefined, branch), undefined);
assert.equal(previousSummaryTokens("", branch), undefined);
assert.equal(previousSummaryTokens("kept", branch), 22);
assert.equal(previousSummaryTokens("old", branch), 11);
assert.equal(previousSummaryTokens("x".repeat(40), branch), 10, "unstored summary uses its text");
assert.equal(
  previousSummaryTokens("x".repeat(401), branch),
  101,
  "unreported summary uses its text",
);
console.log("PASS: compaction progress pure UI timing, estimation, isolation and bounds");
