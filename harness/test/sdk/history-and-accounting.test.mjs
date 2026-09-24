import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configureChildRuntime } from "../../dist/runtime/execution-policy.js";
import harnessExtension from "../../dist/extension.js";
import { reportUnreportedUsage, residueType } from "../../dist/history/usage-audit.js";
import { historicalRunsCommand } from "../../dist/history/history-command.js";
import { PiRunJournal as SdkRunHistory, historyTypes, validRouting } from "../../dist/history/run-journal.js";
import { validSettings } from "../../dist/core/contracts.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { addToLedger } from "../../dist/core/usage-ledger.js";
import { renderRunningLines } from "../../dist/ui/agent-widget.js";

const ledger = () => addToLedger(undefined, { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.25 }, "p/m");
test("child runtime overrides bound native retries without changing compaction token budgets", () => {
  const manager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 512 },
    retry: { enabled: false, maxRetries: 900, provider: { maxRetries: 900 } } });
  configureChildRuntime(manager);
  assert.deepEqual(manager.getCompactionSettings(), { enabled: true, reserveTokens: 2048, keepRecentTokens: 512 });
  assert.deepEqual(manager.getRetrySettings(), { enabled: true, maxRetries: 1, baseDelayMs: 1000, maxAgentDelayMs: 5000 });
  assert.deepEqual(manager.getProviderRetrySettings(), { timeoutMs: 600000, maxRetries: 0, maxRetryDelayMs: 5000 });
});

test("parent harness does not register post-compaction context injection", () => {
  const handlers = new Map();
  harnessExtension({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerShortcut() {} });
  assert(handlers.has("session_start"), "exercise the actual extension factory");
  assert.equal(handlers.has("session_compact"), false);
  assert.equal(handlers.has("context"), false);
});

test("unreported spend is an audit snapshot, not a fake billed message or destructive drain", () => {
  const entries = [], notices = [], usage = ledger();
  const source = { identity: { owner_id: randomUUID(), generation: randomUUID() },
    stats: () => ({ closed: true, unreported_usage: structuredClone(usage) }), drainUsage() { throw new Error("must not drain"); } };
  const ui = { notify: (...args) => notices.push(args) };
  reportUnreportedUsage({ appendEntry: (...args) => entries.push(args) }, { ui }, source);
  assert.equal(entries.length, 1); assert.equal(entries[0][0], residueType);
  assert.deepEqual(entries[0][1].usage, usage);
  assert.match(notices[0][0], /not merged into Pi totals/);
  usage.partial.push("cost"); // A changed snapshot must attempt a new append.
  reportUnreportedUsage({ appendEntry() { throw new Error("disk failure"); } }, { ui }, source);
  assert.match(notices.at(-1)[0], /could not be recorded/);
});

test("audit dedup skips only an unchanged successful snapshot, including closed state and model attribution", () => {
  let usage = addToLedger(ledger(), { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 }, "q/m"), closed = false;
  const entries = [], notices = [], source = { identity: { owner_id: randomUUID(), generation: randomUUID() },
    stats: () => ({ closed, unreported_usage: structuredClone(usage) }), drainUsage() { assert.fail("must not drain"); } };
  const pi = { appendEntry: (...args) => entries.push(args) }, ctx = { ui: { notify: (...args) => notices.push(args) } };
  const report = () => reportUnreportedUsage(pi, ctx, source);
  report(); report(); assert.equal(entries.length, 1); assert.equal(notices.length, 1);
  usage.byModel = Object.fromEntries(Object.entries(usage.byModel).reverse());
  report(); assert.equal(entries.length, 1, "object insertion order is not a new bill");
  closed = true; report(); report(); assert.equal(entries.length, 2, "completed close differs from incomplete close");
  usage = addToLedger(usage, { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0.25 }, "p/m");
  report(); assert.equal(entries.length, 3, "new settled spend must still be reported");
  usage.partial.push("cost"); report(); assert.equal(entries.length, 4, "new uncertainty is not hidden by equal totals");
  usage.byModel = { "other/m": usage.total }; report(); assert.equal(entries.length, 5, "attribution changes are not hidden");
  report(); assert.equal(notices.length, 5);
  const otherOwner = { ...source, identity: { ...source.identity, generation: randomUUID() } };
  reportUnreportedUsage(pi, ctx, otherOwner); assert.equal(entries.length, 6, "a new controller is never suppressed");
  const saved = usage; usage = undefined; report(); usage = saved; report();
  assert.equal(entries.length, 7, "an observed empty residue resets presentation dedup");
});

test("failed audit appends retry even after notifying; failed notifications retry without duplicate writes", () => {
  let failAppend = true, failNotify = false, attempts = 0, writes = 0, notices = 0;
  const usage = ledger(), source = { identity: { owner_id: randomUUID(), generation: randomUUID() },
    stats: () => ({ closed: true, unreported_usage: structuredClone(usage) }) };
  const pi = { appendEntry() { attempts++; if (failAppend) throw new Error("disk failure"); writes++; } };
  const ctx = { ui: { notify() { if (failNotify) throw new Error("UI failure"); notices++; } } };
  const report = () => reportUnreportedUsage(pi, ctx, source);
  report(); report(); assert.equal(attempts, 2); assert.equal(writes, 0); assert.equal(notices, 2);
  failAppend = false; failNotify = true;
  assert.throws(report, /UI failure/); assert.equal(attempts, 3); assert.equal(writes, 1);
  failNotify = false; report(); assert.equal(attempts, 3); assert.equal(notices, 3);
  report(); assert.equal(attempts, 3); assert.equal(notices, 3);
});

test("history command queries only this parent's links, returns partial output/usage and pages Unicode safely", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  const message = (text) => ({ role: "assistant", api: "fixture", provider: "p", model: "m", content: [{ type: "text", text }],
    stopReason: "length", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.25 } }, timestamp: Date.now() });
  parent.appendMessage(message("fixture parent"));
  const history = new SdkRunHistory({ parent, session: child });
  const identity = { owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() };
  const ref = history.begin(identity), text = "x".repeat(16383) + "😀partial";
  child.appendMessage(message(text)); history.seal();
  const usage = ledger(); usage.partial.push("cost");
  history.finish(ref, { status: "failed", reason: "output_limit", model_stop_reason: "length", limit_reached: false },
    { text, total_chars: text.length, truncated: false }, usage);
  const commands = new Map(), notices = [];
  historicalRunsCommand({ registerCommand: (name, definition) => commands.set(name, definition) });
  const ctx = { sessionManager: parent, ui: { notify: (text) => notices.push(text) } }, run = commands.get("harness-history").handler;
  await run("", ctx); assert.equal(JSON.parse(notices.at(-1)).runs[0].run_id, identity.run_id);
  await run(identity.run_id, ctx);
  const page = JSON.parse(notices.at(-1));
  assert.equal(page.resumable, false); assert.equal(page.outcome.reason, "output_limit"); assert.deepEqual(page.usage, usage);
  assert.equal(page.output.next_offset, 16383); assert.equal(page.output.text.length, 16383);
  await run(`${identity.run_id} ${page.output.next_offset}`, ctx);
  assert.equal(JSON.parse(notices.at(-1)).output.text, "😀partial");
  await run(`${identity.run_id} 16384`, ctx); assert.match(notices.at(-1), /surrogate pair/);
  await run("/tmp/arbitrary.jsonl", ctx); assert.match(notices.at(-1), /Usage:/);
  const cyclic = {}; cyclic.self = cyclic;
  const checkpointContext = (data) => ({ ...ctx, sessionManager: { getEntries: () => [
    { type: "custom", customType: residueType, data },
  ] } });
  for (const data of [cyclic, { usage: 1n }]) {
    await run("", checkpointContext(data));
    assert.equal(JSON.parse(notices.at(-1)).latest_unreported_checkpoint.error, "MALFORMED_USAGE_CHECKPOINT");
  }
  await run("", checkpointContext({ ...identity, closed: true, recorded_at: Date.now(), usage,
    ignored: "huge".repeat(100000), recursive: cyclic }));
  const checkpoint = JSON.parse(notices.at(-1)).latest_unreported_checkpoint;
  assert.deepEqual(checkpoint.usage, { total: usage.total, partial: usage.partial });
  assert(notices.at(-1).length < 1000, "raw arbitrary checkpoint data is never serialized");
});

test("cold history preserves current thinking provenance and still reads legacy routing without inventing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  const message = { role: "assistant", api: "fixture", provider: "p", model: "m",
    content: [{ type: "text", text: "answer" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() };
  parent.appendMessage(message);
  const history = new SdkRunHistory({ parent, session: child });
  const identity = { owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() };
  const settings = { provider: "p", model: "m", thinking: "high", parent_thinking: "low",
    thinking_resolution: "preset_mapping", effort_source: "user_override", profile: "reader", difficulty: 3,
    strength: "standard", preset: "team", preset_version: "v2", selection_digest: "a".repeat(64), cwd: root,
    tools: ["read"], definition_digest: "b".repeat(64) };
  assert.equal(validSettings(settings), true);
  const ref = history.begin(identity, settings); child.appendMessage(message); history.seal();
  history.finish(ref, { status: "completed", limit_reached: false }, { text: "answer", total_chars: 6, truncated: false });
  const query = () => readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(),
    sessionDirectory: root, run_id: ref.run_id });
  const expected = { preset: "team", preset_version: "v2", selection_digest: "a".repeat(64),
    difficulty: 3, strength: "standard", thinking: "high", parent_thinking: "low", thinking_resolution: "preset_mapping",
    effort_source: "user_override", provider: "p", model: "m", profile: "reader" };
  assert.deepEqual((await query()).routing, expected);
  const recorded = await Promise.all([parent.getSessionFile(), child.getSessionFile()].map(async (file) =>
    (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line))
      .find((entry) => entry.data?.routing)?.data.routing));
  assert.deepEqual(recorded, [expected, expected], "parent link and child start record identical provenance");
  const eraseRoutingFields = async (fields) => {
    for (const file of [parent.getSessionFile(), child.getSessionFile()]) {
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      for (const entry of lines) if (entry.data?.routing)
        for (const field of fields) delete entry.data.routing[field];
      await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
  };
  await eraseRoutingFields(["difficulty", "effort_source"]);
  const priorRating = await query();
  assert.equal(priorRating.state, "recorded");
  assert.equal(priorRating.routing.parent_thinking, "low");
  assert.equal(priorRating.routing.thinking_resolution, "preset_mapping");
  assert.equal(Object.hasOwn(priorRating.routing, "difficulty"), false, "old records must not invent a rating");
  assert.equal(Object.hasOwn(priorRating.routing, "effort_source"), false, "old records must not invent a source");
  await eraseRoutingFields(["parent_thinking", "thinking_resolution"]);
  const legacy = await query();
  assert.equal(legacy.state, "recorded");
  assert.equal(legacy.routing.thinking, "high");
  assert.equal(Object.hasOwn(legacy.routing, "parent_thinking"), false);
  assert.equal(Object.hasOwn(legacy.routing, "thinking_resolution"), false);
  assert.equal(Object.hasOwn(legacy.routing, "difficulty"), false, "old records must not invent a rating");
  assert.equal(Object.hasOwn(legacy.routing, "effort_source"), false, "old records must not invent a source");
});

test("admission and cold routing validate fixed and inherited effort without inferring provenance", () => {
  const settings = { provider: "p", model: "m", thinking: "high", thinking_resolution: "preset_fixed",
    effort_source: "preset", profile: "reader", difficulty: 3, strength: "standard", preset: "team",
    preset_version: "v2", selection_digest: "a".repeat(64), cwd: "/tmp", tools: ["read"],
    definition_digest: "b".repeat(64) };
  const route = { preset: settings.preset, preset_version: settings.preset_version,
    selection_digest: settings.selection_digest, difficulty: settings.difficulty, strength: settings.strength,
    thinking: settings.thinking, thinking_resolution: settings.thinking_resolution,
    effort_source: settings.effort_source, provider: settings.provider, model: settings.model, profile: settings.profile };
  for (const parent of [undefined, "off"]) {
    const extra = parent === undefined ? {} : { parent_thinking: parent };
    assert.equal(validSettings({ ...settings, ...extra }), true);
    assert.equal(validRouting({ ...route, ...extra }), true);
  }
  assert.equal(validSettings({ ...settings, effort_source: undefined }), false);
  assert.equal(validSettings({ ...settings, parent_thinking: "" }), false);
  assert.equal(validRouting({ ...route, parent_thinking: "" }), false);
  for (const resolution of ["identity", "preset_mapping"]) {
    assert.equal(validSettings({ ...settings, thinking_resolution: resolution }), false, "inheritance requires a parent");
    assert.equal(validRouting({ ...route, thinking_resolution: resolution }), false);
    assert.equal(validSettings({ ...settings, thinking_resolution: resolution, parent_thinking: "low",
      effort_source: "user_override" }), true);
    assert.equal(validRouting({ ...route, thinking_resolution: resolution, parent_thinking: "low",
      effort_source: "user_override" }), true);
  }
  for (const source of [undefined, null, "", "auto"]) {
    assert.equal(validSettings({ ...settings, effort_source: source }), false);
    assert.equal(validRouting({ ...route, effort_source: source }), false);
  }
  for (const invalid of [undefined, null, ""]) {
    assert.equal(validSettings({ ...settings, thinking: invalid }), false);
    assert.equal(validRouting({ ...route, thinking: invalid }), false);
  }
  for (const invalid of [undefined, null, "", "other"]) {
    assert.equal(validSettings({ ...settings, thinking_resolution: invalid }), false);
    assert.equal(validRouting({ ...route, thinking_resolution: invalid }), false);
  }
  const olderSettings = { ...settings }, olderRoute = { ...route };
  delete olderSettings.effort_source;
  delete olderRoute.effort_source;
  assert.equal(validSettings(olderSettings), true, "older internal settings need no source");
  assert.equal(validRouting(olderRoute), true, "a recorded fixed route can predate the source field");
  const legacy = { ...olderRoute };
  delete legacy.thinking_resolution;
  assert.equal(validRouting(legacy), true, "older records need neither parent nor resolution");
  assert.equal(validRouting({ ...legacy, effort_source: "preset" }), false, "a source needs an explicit resolution");
  assert.equal(validRouting({ ...legacy, parent_thinking: "low" }), false, "half of a legacy pair is invalid");
});

test("fixed effort round-trips on both parent link and child start with no parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-fixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  const message = { role: "assistant", api: "fixture", provider: "p", model: "m",
    content: [{ type: "text", text: "answer" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() };
  parent.appendMessage(message);
  const settings = { provider: "p", model: "m", thinking: "high", thinking_resolution: "preset_fixed",
    effort_source: "preset", profile: "reader", difficulty: 3, strength: "standard", preset: "team",
    preset_version: "v2", selection_digest: "a".repeat(64), cwd: root, tools: ["read"], definition_digest: "b".repeat(64) };
  const history = new SdkRunHistory({ parent, session: child });
  const ref = history.begin({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() }, settings);
  child.appendMessage(message); history.seal();
  history.finish(ref, { status: "completed", limit_reached: false }, { text: "answer", total_chars: 6, truncated: false });
  const link = parent.getEntries().find((entry) => entry.customType === historyTypes.link);
  const start = child.getEntries().find((entry) => entry.customType === historyTypes.start);
  assert.deepEqual(link.data.routing, start.data.routing);
  assert.equal(Object.hasOwn(start.data.routing, "parent_thinking"), false);
  assert.equal(start.data.routing.effort_source, "preset");
  const cold = await readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(),
    sessionDirectory: root, run_id: ref.run_id });
  assert.equal(cold.state, "recorded", JSON.stringify(cold));
  assert.deepEqual(cold.routing, start.data.routing);
});

test("unfinished history returns validated routing, but never invents it or accepts a mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-unfinished-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root);
  const message = { role: "assistant", api: "fixture", provider: "p", model: "m",
    content: [{ type: "text", text: "unfinished" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() };
  parent.appendMessage(message);
  const identity = () => ({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
  const settings = { provider: "p", model: "m", thinking: "high", parent_thinking: "low",
    thinking_resolution: "preset_mapping", profile: "reader", difficulty: 3, strength: "standard", preset: "team",
    preset_version: "v2", selection_digest: "a".repeat(64), cwd: root, tools: ["read"], definition_digest: "b".repeat(64) };
  const child = SessionManager.create(root, root), current = new SdkRunHistory({ parent, session: child });
  const ref = current.begin(identity(), settings); child.appendMessage(message);
  const query = (run_id) => readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(),
    sessionDirectory: root, run_id });
  const unfinished = await query(ref.run_id);
  assert.equal(unfinished.state, "unknown", JSON.stringify(unfinished)); assert.equal(unfinished.resumable, false);
  assert.equal(unfinished.outcome, undefined); assert.equal(unfinished.output, undefined);
  assert.deepEqual(unfinished.routing, { preset: "team", preset_version: "v2", selection_digest: "a".repeat(64),
    difficulty: 3, strength: "standard", thinking: "high", parent_thinking: "low", thinking_resolution: "preset_mapping",
    provider: "p", model: "m", profile: "reader" });

  const legacyChild = SessionManager.create(root, root), legacyHistory = new SdkRunHistory({ parent, session: legacyChild });
  const legacyRef = legacyHistory.begin(identity()); legacyChild.appendMessage(message);
  const legacy = await query(legacyRef.run_id);
  assert.equal(legacy.state, "unknown"); assert.equal(Object.hasOwn(legacy, "routing"), false);

  const lines = (await readFile(child.getSessionFile(), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const parentLines = (await readFile(parent.getSessionFile(), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const start = lines.find((entry) => entry.type === "custom" && entry.customType === historyTypes.start);
  const link = parentLines.find((entry) => entry.type === "custom" && entry.customType === historyTypes.link &&
    entry.data.ref.run_id === ref.run_id);
  assert(start?.data.routing && link?.data.routing);
  for (const invalid of [0, 6, 2.5, "3", null]) {
    start.data.routing.difficulty = invalid;
    link.data.routing.difficulty = invalid;
    await writeFile(child.getSessionFile(), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(parent.getSessionFile(), parentLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const rejected = await query(ref.run_id);
    assert.equal(rejected.state, "unavailable"); assert.equal(rejected.error, "INVALID_SDK_HISTORY");
    assert.equal(rejected.routing, undefined);
  }
  start.data.routing.difficulty = 3;
  link.data.routing.difficulty = 3;
  const original = { ...start.data.routing };
  const persist = async () => {
    await writeFile(child.getSessionFile(), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(parent.getSessionFile(), parentLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  };
  for (const invalid of [
    { effort_source: "invented" }, { effort_source: null }, { parent_thinking: "" },
    { thinking: "" }, { thinking_resolution: "preset_fixed", parent_thinking: null },
    { thinking_resolution: "preset_mapping", parent_thinking: undefined },
    { thinking_resolution: undefined, effort_source: "preset" },
  ]) {
    const changed = { ...original, ...invalid };
    for (const routing of [start.data.routing, link.data.routing]) {
      for (const field of ["parent_thinking", "thinking_resolution", "effort_source", "thinking"])
        if (changed[field] === undefined) delete routing[field];
        else routing[field] = changed[field];
    }
    await persist();
    const rejected = await query(ref.run_id);
    assert.equal(rejected.state, "unavailable", JSON.stringify(invalid));
    assert.equal(rejected.error, "INVALID_SDK_HISTORY");
  }
  Object.assign(start.data.routing, original);
  Object.assign(link.data.routing, original);
  await persist();
  start.data.routing.model = "mismatch";
  await writeFile(child.getSessionFile(), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const mismatch = await query(ref.run_id);
  assert.equal(mismatch.state, "unavailable"); assert.equal(mismatch.error, "INVALID_SDK_HISTORY");
  assert.equal(mismatch.routing, undefined);
});

test("history command rejects malformed or unbounded cap options before accessing files", async () => {
  let handler; const notices = [], id = randomUUID();
  historicalRunsCommand({ registerCommand: (_name, command) => { handler = command.handler; } });
  const ctx = { sessionManager: { getSessionFile() { assert.fail("invalid arguments must not read history"); } },
    ui: { notify: (message) => notices.push(message) } };
  for (const args of [`${id} --max-mib 0`, `${id} --max-mib 65`, `${id} --max-mib 1.5`, `${id} --max-mib Infinity`,
    `${id} --max-mib 1e1`, `${id} --max-mib`, `${id} --max-mib 16 --max-mib 32`, `${id} --max-mib 16 0`,
    `${id} 0 1 --max-mib 16`, `${id} -1 --max-mib 16`, `${id} 9007199254740992 --max-mib 16`,
    "--max-mib 64", "/tmp/arbitrary.jsonl --max-mib 64"]) {
    await handler(args, ctx); assert.match(notices.at(-1), /^Usage:/, args);
  }
  for (const args of [`${id} --max-mib 64`, `${id} 0 --max-mib 1`]) {
    await handler(args, { ...ctx, sessionManager: { getSessionFile: () => undefined } });
    assert.match(notices.at(-1), /no saved SDK history/, "both endpoints of the allowed cap range parse");
  }
});

for (const large of ["parent", "child"]) test(`history command requires explicit opt-in for a large ${large} log and keeps the 64 MiB ceiling`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-large-")); t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  const message = (text) => ({ role: "assistant", api: "fixture", provider: "p", model: "m", content: [{ type: "text", text }],
    stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() });
  parent.appendMessage(message("parent"));
  if (large === "parent") parent.appendCustomEntry("fixture:padding", "x".repeat(9 * 1024 * 1024));
  const history = new SdkRunHistory({ parent, session: child });
  const ref = history.begin({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
  if (large === "child") child.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "blob",
    content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }], isError: false, timestamp: Date.now() });
  const text = "x".repeat(16383) + "😀FINAL";
  child.appendMessage(message(text)); history.seal();
  history.finish(ref, { status: "completed", limit_reached: false }, { text, total_chars: text.length, truncated: false });
  const file = (large === "parent" ? parent : child).getSessionFile();
  assert((await stat(file)).size > 8 * 1024 * 1024);
  let handler, notice;
  historicalRunsCommand({ registerCommand: (_name, command) => { handler = command.handler; } });
  const ctx = { sessionManager: parent, ui: { notify: (text) => { notice = JSON.parse(text); } } };
  await handler(ref.run_id, ctx); assert.equal(notice.error, "HISTORY_TOO_LARGE"); assert.equal(notice.max_mib, 8);
  assert.match(notice.help, /--max-mib 64/);
  await handler(`${ref.run_id} --max-mib 16`, ctx);
  assert.equal(notice.state, "recorded"); assert.equal(notice.resumable, false); assert.equal(notice.max_mib, 16);
  assert.equal(notice.output.next_offset, 16383); assert.match(notice.output.next_command, /16383 --max-mib 16$/);
  await handler(notice.output.next_command.replace(/^\/harness-history /, ""), ctx);
  assert.equal(notice.output.text, "😀FINAL");
  // Per-invocation consent does not change the default for subsequent queries.
  await handler(ref.run_id, ctx); assert.equal(notice.error, "HISTORY_TOO_LARGE");
  // Sparse over-limit fixture: refusal must happen at stat, before JSON parsing.
  await truncate(file, 64 * 1024 * 1024 + 1);
  await handler(`${ref.run_id} --max-mib 64`, ctx);
  assert.equal(notice.error, "HISTORY_TOO_LARGE"); assert.match(notice.help, /cannot read larger/);
});

const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
for (const [label, usage, expected] of [
  ["absent", undefined, undefined],
  ["empty", { byModel: {} }, undefined],
  ["full empty", { byModel: {}, total: zero, partial: [] }, undefined],
  ["known zero", { byModel: { "p/m": zero }, total: zero, partial: [] }, { byModel: { "p/m": zero }, total: zero, partial: [] }],
  ["partial", { byModel: { "p/m": { cost: 0.25 } } }, { byModel: { "p/m": { ...zero, cost: 0.25 } },
    total: { ...zero, cost: 0.25 }, partial: ["input", "output", "cache_read", "cache_write"] }],
]) test(`direct SDK history writer normalizes ${label} usage before cold round-trip`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-history-usage-")); t.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root), child = SessionManager.create(root, root);
  const message = { role: "assistant", api: "fixture", provider: "p", model: "m", content: [{ type: "text", text: "answer" }],
    stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() };
  parent.appendMessage(message);
  const history = new SdkRunHistory({ parent, session: child });
  const ref = history.begin({ owner_id: parent.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
  child.appendMessage(message); history.seal();
  history.finish(ref, { status: "completed", limit_reached: false }, { text: "answer", total_chars: 6, truncated: false }, usage);
  const end = child.getEntries().find((entry) => entry.type === "custom" && entry.customType === historyTypes.end);
  assert.deepEqual(end.data.usage, expected); assert.equal(Object.hasOwn(end.data, "usage"), expected !== undefined);
  const query = () => readSdkRun({ sessionManager: SessionManager, parentFile: parent.getSessionFile(), sessionDirectory: root, run_id: ref.run_id });
  const result = await query(); assert.equal(result.state, "recorded"); assert.deepEqual(result.usage, expected);
  assert.equal(result.output.text, "answer");
  if (label === "empty") {
    // Writer normalization is not a blanket relaxation of persisted metadata.
    // Old explicit empty bills remain invalid rather than masquerading as zero.
    const lines = (await readFile(child.getSessionFile(), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    for (const invalid of [{ byModel: {} }, { byModel: [] }, { byModel: { "p/m": null } }]) {
      lines.find((entry) => entry.customType === historyTypes.end).data.usage = invalid;
      await writeFile(child.getSessionFile(), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
      assert.equal((await query()).error, "INVALID_SDK_HISTORY");
    }
  }
});

test("widget distinguishes compaction/retry from stale prose and shows incomplete cost as a floor", () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const run = { name: "worker", profile: "editor", role: "worker", description: "task", status: "running", turns: 1, max_turns: 10,
    elapsed_ms: 10, tool_uses: 0, active_tools: [], preview: "old draft", cost: 0.25, cost_partial: true };
  assert.match(renderRunningLines({ ...run, runtime: { activity: "compacting" } }, 0, theme)[1], /compacting context/);
  assert.match(renderRunningLines({ ...run, runtime: { activity: "retrying" } }, 0, theme)[1], /retrying provider/);
  assert.match(renderRunningLines(run, 0, theme)[0], /≥\$0.250/);
});
