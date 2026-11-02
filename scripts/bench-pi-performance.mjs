#!/usr/bin/env node
// Offline, synthetic microbenchmarks: no AgentSession construction, model,
// credentials, saved journal, host CLI or network. Build first. Timings are
// observations, not pass/fail thresholds or a release/host acceptance gate.
import assert from "node:assert/strict";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { OutputBuffer, boundedOutput } from "../harness/dist/core/result-text.js";
import { wrapPlainText } from "../harness/dist/ui/text.js";

const flags = new Set(process.argv.slice(2));
assert([...flags].every(flag => ["--legacy", "--core-only"].includes(flag)),
  "Usage: node scripts/bench-pi-performance.mjs [--legacy] [--core-only]");
const results = [];
function measure(name, facts, run, count = 7) {
  run();
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results.push({ name, ...facts, samples: count,
    median_ms: +samples[Math.floor(count / 2)].toFixed(3),
    min_ms: +samples[0].toFixed(3), max_ms: +samples.at(-1).toFixed(3) });
}

for (const chars of [16_384, 65_536, 262_144, 1_048_576]) {
  for (const deltaChars of [4, 32]) {
    const chunk = "x".repeat(deltaChars);
    measure("stream_append_and_final_materialization", { chars, delta_chars: deltaChars }, () => {
      const output = new OutputBuffer(chars, 1);
      for (let i = 0; i < chars; i += deltaChars) output.append(chunk);
      const final = output.snapshot();
      assert.equal(final.text.length, chars);
      assert.equal(final.total_chars, chars);
      assert.equal(final.truncated, false);
    });
  }
}
if (flags.has("--legacy")) {
  for (const chars of [16_384, 32_768, 65_536]) {
    measure("legacy_cumulative_protocol_equivalent", { chars, delta_chars: 4 }, () => {
      let output = { text: "", total_chars: 0, truncated: false };
      let retained = output;
      let pendingHigh = "";
      for (let i = 0; i < chars; i += 4) {
        const growing = output.text + pendingHigh + "xxxx";
        pendingHigh = /[\uD800-\uDBFF]$/.test(growing) ? growing.slice(-1) : "";
        output = { ...boundedOutput(growing.slice(0, growing.length - pendingHigh.length), chars), total_chars: i + 4 };
        assert(output.text.startsWith(retained.text));
        retained = { ...boundedOutput(output.text, chars), total_chars: output.total_chars };
      }
      assert.equal(retained.text.length, chars);
    }, 3);
  }
}

const task = "Investigate performance without changing permission semantics. ".repeat(45);
for (const width of [60, 120, 200]) {
  measure("wrap_plain_text", { chars: task.length, width }, () => {
    assert(wrapPlainText(task, width).length > 0);
  }, 21);
}

if (!flags.has("--core-only")) {
  // Only the pure projection/token-estimation method is borrowed; a fake
  // receiver and an explicitly in-memory SessionManager supply all its data.
  const { AgentSession, SessionManager, buildContextEntries, sessionEntryToContextMessages } =
    await import("@earendil-works/pi-coding-agent");
  for (const count of [10_000, 30_000]) {
    const entries = [{ type: "session", version: 3, id: "synthetic-performance",
      cwd: process.cwd(), timestamp: "2026-01-01T00:00:00Z" }];
    const body = "synthetic text ".repeat(36);
    for (let i = 0; i < count; i++) entries.push({ type: "message", id: `e${i}`,
      parentId: i ? `e${i - 1}` : null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: body, timestamp: i } });
    const manager = SessionManager.inMemory(process.cwd(), undefined, entries);
    const receiver = { _limitsModel: () => ({ contextWindow: 2_000_000 }), sessionManager: manager };
    measure("sdk_context_usage_uncached_reference", { entries: count }, () => {
      assert(AgentSession.prototype.getContextUsage.call(receiver).tokens > 0);
    }, 21);
    measure("detail_messages_uncached_reference", { entries: count }, () => {
      assert.equal(buildContextEntries(manager.getEntries()).flatMap(sessionEntryToContextMessages).length, count);
    }, 21);
  }
}
console.log(JSON.stringify({ scope: "offline synthetic microbenchmarks; not end-to-end latency",
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, results }, null, 2));
