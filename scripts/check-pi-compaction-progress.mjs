#!/usr/bin/env node
// Synthetic, fake-clock UI checks only. No sessions, credentials or providers.
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const { CompactionProgress } = await createJiti(import.meta.url).import(
  "../extensions/lib/compaction-progress.ts",
);
let clock = 0;
const progress = new CompactionProgress(() => clock);
const options = { modelKey: "provider/model", tokensBefore: 1000 };
function train(count = 3, duration = 48_000, input = options, success = true) {
  for (let i = 0; i < count; i++) {
    progress.start(input);
    clock += duration;
    progress.finish(success);
  }
}
function inspect(input = options, elapsed = 24_000) {
  progress.start(input);
  clock += elapsed;
  return progress.snapshot();
}

assert.equal(progress.snapshot(), undefined);
assert.equal(inspect().percent, undefined, "cold start is elapsed-only");
assert.match(progress.snapshot().text, /^⠋ 24s$/);
progress.finish(false);
train(2);
assert.equal(inspect().percent, undefined, "two samples are insufficient");
progress.finish(false);
train(1);
assert.equal(inspect().percent, 50);
assert.match(progress.snapshot().text, /^⠋ ≈50% 24s$/);
const first = progress.snapshot().text;
clock += 100;
assert.notEqual(progress.snapshot().text, first, "animation derives from time");
clock += 21_500;
assert.equal(progress.snapshot().percent, undefined, "95% waiting zone drops ETA");
clock += 30_000;
assert.equal(progress.snapshot().percent, undefined, "overrun remains elapsed-only");
assert.equal(progress.snapshot().elapsedMs, 75_600);
progress.finish(false);
assert.equal(progress.snapshot(), undefined);
assert.equal(inspect({ ...options, modelKey: "other" }).percent, undefined);
assert.equal(inspect({ ...options, tokensBefore: 10_000 }).percent, undefined);
assert.equal(inspect({ tokensBefore: 1000 }).percent, undefined);
assert.equal(inspect({ ...options, modelKey: "" }).percent, undefined);
for (const tokensBefore of [NaN, Infinity, -1, 0]) {
  assert.equal(inspect({ ...options, tokensBefore }).percent, undefined);
  progress.finish(true);
}
progress.reset();
train(3, 48_000, options, false);
assert.equal(inspect().percent, undefined, "failures/cancellations do not train");
progress.finish(false);
train(1);
progress.finish(true);
progress.finish(true);
assert.equal(inspect().percent, undefined, "finish is idempotent");
progress.reset();
for (let i = 0; i < 3; i++) {
  progress.start(options);
  clock += 48_000;
  progress.start({ ...options, modelKey: "replacement" });
  progress.finish(false);
}
assert.equal(inspect().percent, undefined, "repeated starts do not record success");
progress.reset();
train();
progress.reset();
assert.equal(progress.snapshot(), undefined);
assert.equal(inspect().percent, undefined, "reset clears history");
progress.reset();
train(1, 10_000);
train(1, 48_000);
train(1, 120_000);
assert.equal(inspect().percent, undefined, "unstable duration has no estimate");

progress.reset();
train();
progress.start(options);
clock += 1000;
assert.equal(progress.snapshot().elapsedMs, 1000);
clock -= 2000;
assert.equal(progress.snapshot().elapsedMs, 1000, "clock reversal cannot regress elapsed");
assert.equal(progress.snapshot().percent, undefined);
clock = NaN;
assert.equal(progress.snapshot().elapsedMs, 1000);
progress.finish(true);
clock = 0;
progress.reset();
progress.start(options);
clock = Infinity;
assert.equal(progress.snapshot().elapsedMs, 0);
progress.finish(true);
clock = NaN;
progress.start(options);
clock = 10_000;
assert.equal(progress.snapshot().elapsedMs, 0, "invalid start clock cannot train");
progress.finish(true);
assert.equal(inspect().percent, undefined);
const throwing = new CompactionProgress(() => { throw new Error("clock unavailable"); });
throwing.start(options);
assert.equal(throwing.snapshot().elapsedMs, 0);
throwing.finish(true);
assert.equal(throwing.snapshot(), undefined);

// Behavioral eviction checks: no private state inspection or diagnostic API.
clock = 0;
progress.reset();
train();
train(8, 48_000, { ...options, tokensBefore: 100_000 });
assert.equal(inspect().percent, undefined, "per-model history evicts old size samples after eight");
progress.reset();
train();
for (let i = 0; i < 64; i++) train(1, 48_000, { ...options, modelKey: `model-${i}` });
assert.equal(inspect().percent, undefined, "global history evicts after 64 samples");
progress.reset();
train(3, 48_000, { ...options, modelKey: "latest" });
assert.equal(inspect({ ...options, modelKey: "latest" }).percent, 50);
progress.reset();
progress.start(options);
clock += 65_000;
assert.match(progress.snapshot().text, / 1m5s$/);
clock += 3_600_000;
assert.match(progress.snapshot().text, / 1h1m$/);
progress.finish(true);
assert.equal(progress.snapshot(), undefined);
// Default clock is callable without requiring a session or starting a timer.
const defaults = new CompactionProgress();
defaults.start(options);
assert.ok(Number.isFinite(defaults.snapshot().elapsedMs));
defaults.reset();
console.log("PASS: compaction progress pure UI timing, estimation, isolation and bounds");
