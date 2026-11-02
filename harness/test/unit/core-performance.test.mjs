import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boundedOutput, OutputBuffer, sha256 } from "../../dist/core/result-text.js";
import { taskOrdinals, taskOrdinal } from "../../dist/core/communication-state.js";
import { deferred, ended, fixture, task, until } from "../support/controller-fixture.mjs";

// Structural checks, not wall-clock promises. Controlled core ports; no SDK,
// providers, permission approval or production journal/durability evidence.
test("append buffers do not join growing prefixes, including after the cap", () => {
  const original = Array.prototype.join, buffer = new OutputBuffer(16384, 7);
  let joins = 0;
  Array.prototype.join = function (...args) {
    if (this === buffer.chunks) joins++;
    return Reflect.apply(original, this, args);
  };
  try {
    for (let index = 0; index < 32768; index++) buffer.append("abcd");
    assert.equal(joins, 0, "there is no full-prefix materialization at delta rate");
    assert.equal(buffer.chunks.length, 4096, "many retained chunks exist before the explicit read");
    const first = buffer.snapshot();
    assert.equal(joins, 1);
    assert.deepEqual(first, { text: "abcd".repeat(4096), total_chars: 131072, truncated: true, revision: 7 });
    // Inspect representation only: no heap/RSS or engine backing-store claim.
    assert.deepEqual(buffer.chunks, [first.text], "materialization releases the old chunk references");
    assert.equal(buffer.joined, buffer.chunks[0], "chunks and memo retain the same materialized prefix");
    assert.deepEqual(buffer.snapshot(), first);
    buffer.append("ignored after cap"); buffer.snapshot();
    assert.equal(joins, 1, "unchanged retained prefix reuses its private materialization");
  } finally { Array.prototype.join = original; }
});

test("materialized prefixes compact between appends without duplicating text or changing stream state", () => {
  const buffer = new OutputBuffer(6, 3);
  const read = (text, total_chars, truncated) => {
    assert.deepEqual(buffer.snapshot(), { text, total_chars, truncated, revision: 3 });
    assert.deepEqual(buffer.chunks, [text], "only one materialized prefix remains after each nonempty read");
    assert.equal(buffer.joined, buffer.chunks[0]);
  };
  buffer.append("a"); buffer.append("b");
  assert.deepEqual(buffer.chunks, ["a", "b"]);
  read("ab", 2, false);
  buffer.append("\ud83d"); read("ab", 3, true);
  assert.equal(buffer.pendingHigh, "\ud83d", "materialization does not discard a provisional high surrogate");
  buffer.append(""); read("ab", 3, true);
  assert.equal(buffer.pendingHigh, "\ud83d");
  buffer.append("\ude80");
  assert.deepEqual(buffer.chunks, ["ab", "🚀"], "a later append extends the compacted prefix once");
  read("ab🚀", 4, false);
  buffer.append("c"); buffer.append("d");
  assert.deepEqual(buffer.chunks, ["ab🚀", "c", "d"]);
  read("ab🚀cd", 6, false);
  assert.equal(buffer.closed, false, "an exact cap does not close retention prematurely");
  buffer.append("\ud83d"); read("ab🚀cd", 7, true);
  assert.equal(buffer.pendingHigh, "\ud83d"); assert.equal(buffer.closed, false);
  buffer.append("\ude80"); read("ab🚀cd", 8, true);
  assert.equal(buffer.pendingHigh, ""); assert.equal(buffer.closed, true);
  buffer.append("ignored"); read("ab🚀cd", 15, true);
});

test("chunk-local retention matches the former prefix rule at every split and cap", () => {
  const text = "a🚀b\ud800X\udfff😀z";
  for (let cap = 0; cap <= text.length + 1; cap++) for (let split = 0; split <= text.length; split++) {
    const buffer = new OutputBuffer(cap, 1);
    let output = { text: "", total_chars: 0, truncated: false }, high = "", closed = false;
    for (const delta of [text.slice(0, split), "", text.slice(split)]) {
      if (!closed) {
        const growing = output.text + high + delta;
        high = /[\uD800-\uDBFF]$/.test(growing) ? growing.slice(-1) : "";
        const bounded = boundedOutput(growing.slice(0, growing.length - high.length), cap);
        output.text = bounded.text; closed = bounded.truncated;
        if (closed) high = "";
      }
      output.total_chars += delta.length;
      output.truncated = output.text.length < output.total_chars;
      buffer.append(delta);
      assert.deepEqual(buffer.snapshot(), { ...output, revision: 1 }, `cap=${cap} split=${split}`);
    }
  }
});

test("Owner delta ingestion and roster projections never access buffered text", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("stream", task("stream", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  const getter = Object.getOwnPropertyDescriptor(OutputBuffer.prototype, "text");
  let textReads = 0;
  Object.defineProperty(OutputBuffer.prototype, "text", { ...getter, get() { textReads++; return getter.get.call(this); } });
  try {
    const before = c.presentationRevision;
    ports[0].callbacks.outputDelta({ type: "reset", revision: 1 });
    for (let index = 0; index < 8192; index++) ports[0].callbacks.outputDelta({ type: "append", revision: 1, text: "abcd" });
    const revision = c.presentationRevision;
    assert(revision > before);
    c.view(run.run_id); c.list(); c.stats();
    assert.equal(c.presentationRevision, revision, "projections do not invalidate themselves");
    assert.equal(textReads, 0, "neither ingestion nor widget-style roster reads materialize text");
    assert.equal(c.getResult(run.run_id).text, "abcd".repeat(1024));
    assert(textReads > 0, "an explicit result reader requests text");
  } finally { Object.defineProperty(OutputBuffer.prototype, "text", getter); }
  ports[0].calls.at(-1).done.resolve({ kind: "success", output: { text: "abcd".repeat(8192), total_chars: 32768, truncated: false, revision: 1 } });
  await ended(c, run);
  assert.equal(c.view(run.run_id).status, "completed");
});

test("cached admitted settings remain detached, immutable on reuse and free of projection hashing", async (t) => {
  const request = task("context", { name: "otter" });
  request.settings = { ...request.settings, context_snapshot: "x".repeat(65536) };
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("context", request);
  await until(() => ports[0]?.streaming);
  const expected = sha256(request.settings.context_snapshot);
  request.settings.context_snapshot = "caller mutation";
  // Poison only the private snapshot read surface AFTER admission. Projections
  // must use the admitted metadata, not reread/hash snapshot content per frame.
  const settings = c.runs.get(run.run_id).record.settings;
  Object.defineProperty(settings, "context_snapshot", { configurable: true, get() { throw new Error("projection rehashed context"); } });
  for (let index = 0; index < 20; index++) {
    const view = c.list()[0];
    assert.equal(view.effective_settings.context_digest, expected);
    assert.equal(view.effective_settings.context_bytes, 65536);
    view.effective_settings.tools.push("poison");
    assert.deepEqual(c.view(run.run_id).effective_settings.tools, ["read"]);
  }
  // Restore the test-only poison before any history/finalization boundary.
  Object.defineProperty(settings, "context_snapshot", { value: "x".repeat(65536), writable: true, configurable: true });
  ports[0].finish("done"); await ended(c, run);
  const next = await c.submit("reuse", { resume: run.agent_id, prompt: "again" });
  assert.equal(next.effective_settings.context_digest, expected);
});

test("hostile final facts still pass a plain retained snapshot to history", async (t) => {
  let saved;
  const { controller: c, ports } = await fixture(t, { history: async (point, _record, output) => { if (point === "finish") saved = output; } });
  const run = await c.submit("hostile", task("hostile")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.outputDelta({ type: "reset", revision: 1 });
  ports[0].callbacks.outputDelta({ type: "append", revision: 1, text: "useful" });
  ports[0].calls.at(-1).done.resolve({ kind: "success", get output() { throw new Error("hostile final facts"); } });
  await ended(c, run);
  assert.equal(c.view(run.run_id).status, "failed");
  assert.equal(c.getResult(run.run_id).text, "useful");
  assert.deepEqual(saved, { text: "useful", total_chars: 6, truncated: false, revision: 1 });
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  assert.deepEqual(Object.keys(saved).sort(), ["revision", "text", "total_chars", "truncated"]);
  assert.equal(c.stats().reserved_output_chars, 0);
});

for (const invalid of [
  { type: "reset", revision: 1 }, { type: "append", revision: 2, text: "wrong revision" },
  { type: "append", revision: 1, text: 12 }, { type: "reset", revision: 2, max_chars: -1 },
  { type: "append", revision: 1, text: "unknown", extra: true },
]) test(`malformed delta latches invalid execution even when a port swallows it (${JSON.stringify(invalid)})`, async (t) => {
  const { controller: c, ports } = await fixture(t);
  const run = await c.submit("invalid-delta", task("invalid-delta")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.outputDelta({ type: "reset", revision: 1 });
  ports[0].callbacks.outputDelta({ type: "append", revision: 1, text: "safe" });
  assert.throws(() => ports[0].callbacks.outputDelta(invalid), { code: "INVALID_OUTPUT_DELTA" });
  ports[0].calls.at(-1).done.resolve({ kind: "success", output: { text: "safe", total_chars: 4, truncated: false, revision: 1 } });
  await ended(c, run);
  assert.equal(c.view(run.run_id).status, "failed"); assert.equal(c.view(run.run_id).resumable, false);
  assert(c.view(run.run_id).cleanup_errors.includes("INVALID_OUTPUT_DELTA"));
  assert.equal(c.getResult(run.run_id).text, "safe");
});

test("history wait entry/exit invalidates presentation without making projections effecting", async (t) => {
  const entered = deferred(), release = deferred();
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish") { entered.resolve(); await release.promise; }
  }, beforeShutdown: () => release.resolve() });
  const run = await c.submit("wait-version", task("wait-version")); await until(() => ports[0]?.streaming);
  const running = c.presentationRevision;
  ports[0].finish("done"); await entered.promise;
  const waiting = c.presentationRevision;
  assert(waiting > running);
  assert.equal(c.stats().finalizing_waits[0].wait, "history");
  c.validateObservationEntry(() => { c.list(); c.stats(); });
  assert.equal(c.presentationRevision, waiting);
  release.resolve(); await ended(c, run);
  assert(c.presentationRevision > waiting);
  assert.equal(c.stats().finalizing_waits, undefined);
});

test("old Run delta callbacks ignore late payloads before inspection during settling and Agent reuse", async (t) => {
  const entered = deferred(), release = deferred();
  let holdHistory = true;
  const { controller: c, ports } = await fixture(t, { history: async (point) => {
    if (point === "finish" && holdHistory) { entered.resolve(); await release.promise; }
  }, beforeShutdown: () => release.resolve() });
  const old = await c.submit("old-delta", task("old-delta", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  // Capture this ORIGINAL callback; the reusable port replaces .callbacks on
  // the next Run. Looking it up later would accidentally test the new Run.
  const lateDelta = ports[0].callbacks.outputDelta;
  lateDelta({ type: "reset", revision: 1 }); lateDelta({ type: "append", revision: 1, text: "old prefix" });
  let payloadReads = 0, next;
  const tripwire = () => { payloadReads++; throw new Error("late payload was inspected"); };
  const payloads = [
    { label: "getter", value: { get type() { return tripwire(); } } },
    { label: "proxy", value: new Proxy({}, { get: tripwire, ownKeys: tripwire,
      getOwnPropertyDescriptor: tripwire, getPrototypeOf: tripwire, has: tripwire }) },
    { label: "valid reset", value: { type: "reset", revision: 99 } },
    { label: "valid append", value: { type: "append", revision: 99, text: "stale overwrite" } },
  ];
  const resultState = (run) => {
    const page = c.getResult(run.run_id), view = page.snapshot;
    return { text: page.text, total_chars: page.total_chars, retained_chars: page.retained_chars,
      truncated: page.truncated, result_ref: page.result_ref, status: view.status, phase: view.phase,
      execution_exited: view.execution_exited, cleanup_errors: view.cleanup_errors,
      quarantine: c.runs.get(run.run_id).quarantine };
  };
  const capture = () => structuredClone({ revision: c.presentationRevision,
    old: resultState(old), next: next && resultState(next) });
  const unchangedLateCalls = (phase) => {
    const before = capture();
    for (const { label, value } of payloads) {
      assert.doesNotThrow(() => lateDelta(value), `${phase}/${label}: a retired callback is a no-op`);
      assert.equal(payloadReads, 0, `${phase}/${label}: current/exit guards precede payload inspection`);
      assert.deepEqual(capture(), before, `${phase}/${label}: no old/new result, quarantine or presentation mutation`);
    }
  };
  ports[0].calls.at(-1).done.resolve({ kind: "success", output: {
    text: "old prefix", total_chars: 10, truncated: false, revision: 1,
  } });
  await entered.promise;
  assert.equal(c.view(old.run_id).phase, "finalizing"); assert.equal(c.view(old.run_id).execution_exited, true);
  assert.equal(c.agents.get(old.agent_id).current, old.run_id, "settling exercises the exit guard while the old Run is still current");
  unchangedLateCalls("settling");
  holdHistory = false; release.resolve(); await ended(c, old);
  assert.equal(c.view(old.run_id).status, "completed");
  unchangedLateCalls("settled");
  next = await c.submit("new-delta", { resume: old.agent_id, prompt: "new task" });
  await until(() => ports[0].streaming && ports[0].calls.length === 2);
  assert.equal(next.agent_id, old.agent_id); assert.equal(ports.length, 1);
  assert.notEqual(ports[0].callbacks.outputDelta, lateDelta, "the next Run has its own callback identity");
  ports[0].callbacks.outputDelta({ type: "reset", revision: 1 });
  ports[0].callbacks.outputDelta({ type: "append", revision: 1, text: "new prefix" });
  assert.equal(c.getResult(next.run_id).text, "new prefix");
  unchangedLateCalls("Agent reused");
  ports[0].calls.at(-1).done.resolve({ kind: "success", output: {
    text: "new prefix", total_chars: 10, truncated: false, revision: 1,
  } });
  await ended(c, next);
  assert.equal(c.view(next.run_id).status, "completed");
  assert.equal(c.getResult(old.run_id).text, "old prefix"); assert.equal(c.getResult(next.run_id).text, "new prefix");
});

test("batch ordinals scan ordered retained Runs once and preserve foreign-object rejection", () => {
  let sequences = 0;
  const runs = Array.from({ length: 512 }, (_, index) => ({ record: {
    agent_id: `a${index % 12}`, get enqueue_sequence() { sequences++; return index; },
  } }));
  const ordinals = taskOrdinals(runs);
  for (let index = 0; index < runs.length; index++) assert.equal(ordinals.get(runs[index]), Math.floor(index / 12) + 1);
  assert(sequences < runs.length * 5, "one batch index, not a history scan for each candidate");
  assert.equal(ordinals.has({ ...runs[0] }), false);
  assert.throws(() => taskOrdinal({ ...runs[0] }, runs), { code: "INVALID_COMMUNICATION_RUN" });
  const shuffled = [...runs].reverse(), projected = taskOrdinals(shuffled);
  for (const run of runs) assert.equal(projected.get(run), ordinals.get(run));
});

test("communication capture and independent commit validation use ephemeral batch indexes", () => {
  const owner = readFileSync(new URL("../../src/core/owner-controller.ts", import.meta.url), "utf8");
  const state = readFileSync(new URL("../../src/core/communication-state.ts", import.meta.url), "utf8");
  assert.match(owner, /const ordinals = taskOrdinals\(all\)/);
  assert.match(state, /const ordinals = taskOrdinals\(options.runs\)/);
  assert.doesNotMatch(state.slice(state.indexOf("export function validateCommunicationCommit")), /taskOrdinal\(/,
    "commit validates original membership/ordinals without per-row rescans");
});
