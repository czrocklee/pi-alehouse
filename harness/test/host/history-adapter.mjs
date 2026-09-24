// Actual installed SDK history codec tests; no Controller/permissions/model network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { PiRunJournal as SdkRunHistory, historyTypes } from "../../dist/history/run-journal.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { boundedOutput, describeResult, sha256 } from "../../dist/core/result-text.js";
import { addToLedger } from "../../dist/core/usage-ledger.js";
import { ParentHistoryError } from "../../dist/core/ports.js";
import { hostUsage } from "../../dist/runtime/tool-usage.js";
import { loadHost } from "../support/host.mjs";
import { createFixture } from "../support/sdk-history-fixture.mjs";

const [piExecutable, outputRoot] = process.argv.slice(2);
const root = join(outputRoot, "history-adapter"); mkdirSync(root, { mode: 0o700 });
const host = await loadHost(piExecutable), { sdk } = host;
const parent = await createFixture(host, root, "parent"), child = await createFixture(host, root, "child");
const report = { sdk: host.versions.pi, claims: [], limitations: ["Controlled model IO, not a real-model trial", "History only; no owner execution, permission or reload acceptance"] };
const save = () => writeFileSync(join(outputRoot, "history-adapter.json"), JSON.stringify(report, null, 2));
const check = (name, detail = {}) => { report.claims.push({ name, detail }); save(); console.log(`PASS SDK history adapter: ${name}`); };
const parse = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const writeLog = (file, entries) => writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const runIdentity = () => ({ owner_id: parent.manager.getSessionId(), generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
const journal = new SdkRunHistory({ parent: parent.manager, session: child.manager });
const read = (ref, extra = {}) => readSdkRun({ sessionManager: sdk.SessionManager, parentFile: parent.manager.getSessionFile(), sessionDirectory: root, ref, ...extra });

try {
  await parent.session.prompt("initialize parent SDK log"); await parent.session.waitForIdle();
  const unknownSpend = hostUsage(addToLedger(undefined,
    { input: null, output: null, cache_read: null, cache_write: null, cost: null }, "compaction/fixture/controlled"));
  // Codec fixture only: production still attaches spend to real tool results.
  parent.manager.appendMessage({ role: "toolResult", toolCallId: "fixture-unknown-spend", toolName: "wait_runs",
    content: [{ type: "text", text: "fixture" }], isError: false, usage: unknownSpend, timestamp: Date.now() });
  const storedSpend = parse(parent.manager.getSessionFile()).find((e) => e.type === "message" && e.message.toolCallId === "fixture-unknown-spend").message.usage;
  assert.deepEqual(storedSpend, unknownSpend);
  assert.equal(storedSpend.harnessModels[0].cost, 0);
  assert.deepEqual(storedSpend.harnessModels[0].partial, ["input", "output", "cache_read", "cache_write", "cost"]);
  check("installed SDK preserves unknown-spend markers beside tool-result model rows");
  const execute = async (text, limit = 1024, afterSeal, outcome = { status: "completed", limit_reached: false }) => {
    const ref = journal.begin(runIdentity()); child.provider.respond(async () => ({ text }));
    await child.session.prompt("synthetic task"); await child.session.waitForIdle(); journal.seal();
    afterSeal?.();
    const output = boundedOutput(text, limit);
    return journal.finish(ref, outcome, output);
  };
  const long = "甲😀乙".repeat(20);
  const first = await execute(long, 5);
  const second = await execute("SECOND_RESULT", 1024, () => {
    // Simulate an extension append AFTER prompt exit, not a fake first flush.
    const message = child.manager.getEntries().findLast((e) => e.type === "message" && e.message.role === "assistant").message;
    child.manager.appendMessage({ ...message, content: [{ type: "text", text: "AFTER_SEAL_NOT_THIS_RUN" }] });
  }, { status: "failed", reason: "output_limit", model_stop_reason: "length", limit_reached: false });
  assert.deepEqual(Object.keys(child.manager.getEntry(second.end_entry_id).data).sort(), ["final_entry_id", "outcome", "ref", "result", "through"]);
  child.session.dispose(); parent.session.dispose();
  assert.deepEqual((await read(first)).output, boundedOutput(long, 5));
  assert.equal((await read(second)).output.text, "SECOND_RESULT");
  assert.deepEqual((await read(second)).outcome,
    { status: "failed", reason: "output_limit", model_stop_reason: "length", limit_reached: false });
  assert.equal((await read(second)).resumable, false);
  check("bounded results and sealed prompt boundary survive dispose", { first, second });

  child.manager.appendCompaction("summary", second.start_entry_id, 1000);
  child.manager.branch(first.end_entry_id); child.manager.appendCustomEntry("branch-note", {});
  assert.equal((await read(second)).output.text, "SECOND_RESULT");
  check("old Run references survive later compaction and branching");

  const parentFile = parent.manager.getSessionFile(), childFile = child.manager.getSessionFile();
  const parentBytes = readFileSync(parentFile, "utf8"), childBytes = readFileSync(childFile, "utf8");
  const parentCopy = join(root, "parent-copy.jsonl"), childCopy = join(root, "child-copy.jsonl");
  const copySource = (mutateChild = () => {}, mutateParent = () => {}) => {
    const parents = parse(parentFile), children = parse(childFile);
    for (const e of parents) if (e.type === "custom" && e.customType === historyTypes.link) e.data.session_file = childCopy;
    mutateChild(children); mutateParent(parents);
    writeLog(childCopy, children); writeLog(parentCopy, parents);
    return { parentFile: parentCopy };
  };
  const end = (entries, ref) => entries.find((e) => e.id === ref.end_entry_id);
  for (const [name, mutate] of [
    ["wrong final reference", (entries) => { end(entries, first).data.final_entry_id = end(entries, second).data.final_entry_id; }],
    ["wrong generation", (entries) => { end(entries, first).data.ref.generation = randomUUID(); }],
    ["wrong start reference", (entries) => { end(entries, first).data.ref.start_entry_id = second.start_entry_id; }],
    ["cross-Run through/final/result tuple", (entries) => { const a = end(entries, first).data, b = end(entries, second).data; a.through = b.through; a.final_entry_id = b.final_entry_id; a.result = { ...b.result, run_id: first.run_id }; }],
    ["delayed END after another Run", (entries) => {
      const a = end(entries, first), b = end(entries, second);
      entries.splice(entries.indexOf(a), 1);
      for (const e of entries) if (e.parentId === a.id) e.parentId = a.parentId;
      a.parentId = b.id; a.data.through = b.data.through; a.data.final_entry_id = b.data.final_entry_id;
      a.data.result = { ...b.data.result, run_id: first.run_id };
      entries.splice(entries.indexOf(b) + 1, 0, a);
    }],
    ["forward parent ID", (entries) => { entries[1].parentId = entries.at(-1).id; }],
    ["split surrogate prefix", (entries) => { end(entries, first).data.result = describeResult(first.run_id, { text: long.slice(0, 2), total_chars: long.length, truncated: true }); }],
    ["duplicate entry ID", (entries) => { entries.push(entries.at(-1)); }],
    ["wrong child header", (entries) => { entries[0].id = randomUUID(); }],
  ]) {
    const value = await read(first, copySource(mutate));
    assert.equal(value.state, "unavailable", name);
    check(`reject ${name}`, { error: value.error });
  }
  assert.equal((await read(first, copySource(() => {}, (entries) => { entries[0].id = randomUUID(); }))).state, "unavailable");
  assert.equal((await read(first, { ...copySource(), sessionDirectory: join(root, "child") })).state, "unavailable");
  const missingEnd = copySource((entries) => {
    const a = end(entries, first); entries.splice(entries.indexOf(a), 1);
    for (const e of entries) if (e.parentId === a.id) e.parentId = a.parentId;
  });
  assert.equal((await read(first, missingEnd)).state, "unknown");
  check("parent identity/root boundaries and missing terminal metadata are explicit");

  const byId = (run_id, extra = {}) => readSdkRun({ sessionManager: sdk.SessionManager, parentFile, sessionDirectory: root, run_id, ...extra });
  assert.equal((await byId(second.run_id)).output.text, "SECOND_RESULT");
  assert.equal((await byId(first.run_id, missingEnd)).state, "unknown");
  assert.equal((await byId(randomUUID())).error, "RUN_HISTORY_NOT_RECORDED");
  assert.equal((await byId("invalid")).state, "unavailable");
  assert.equal((await byId(first.run_id, { maxBytes: 1 })).error, "HISTORY_TOO_LARGE");
  assert.equal((await byId(first.run_id, copySource(() => {}, (entries) => {
    const link = entries.find((e) => e.type === "custom" && e.customType === historyTypes.link);
    entries.push({ ...link, id: "eeeeeeee", parentId: entries.at(-1).id });
  }))).state, "unavailable");
  check("cold Run-ID lookup uses the same bounded reader: recorded/unknown/unavailable, no execution resolver");

  const limit = await read(first, { maxBytes: 1 }); assert.equal(limit.error, "HISTORY_TOO_LARGE");
  copySource(); writeFileSync(childCopy, readFileSync(childCopy, "utf8") + '{"unfinished":');
  assert.equal((await read(first, { parentFile: parentCopy })).state, "unavailable");
  unlinkSync(childCopy); assert.equal((await read(first, { parentFile: parentCopy })).error, "ENOENT");
  assert.equal(readFileSync(parentFile, "utf8"), parentBytes); assert.equal(readFileSync(childFile, "utf8"), childBytes);
  check("bounded reads reject torn/deleted logs without repairing originals", { parentHash: sha256(parentBytes), childHash: sha256(childBytes) });

  renameSync(childFile, childFile + ".before-fault"); mkdirSync(childFile);
  try {
    const before = child.manager.getLeafId();
    assert.throws(() => journal.begin(runIdentity()), { code: "EISDIR" });
    assert.notEqual(child.manager.getLeafId(), before); assert.match(journal.error, /EISDIR/);
    const failedLeaf = child.manager.getLeafId();
    assert.throws(() => journal.begin(runIdentity()), { code: "SDK_HISTORY_UNCERTAIN" });
    assert.equal(child.manager.getLeafId(), failedLeaf);
  } finally { rmdirSync(childFile); renameSync(childFile + ".before-fault", childFile); }
  assert.equal(readFileSync(childFile, "utf8"), childBytes);
  check("real synchronous SDK metadata failure latches uncertainty; no writer retry");

  const other = sdk.SessionManager.create(root, join(root, "other-sessions"));
  const parentFault = new SdkRunHistory({ parent: parent.manager, session: other });
  renameSync(parentFile, parentFile + ".before-fault"); mkdirSync(parentFile);
  try {
    assert.throws(() => parentFault.begin(runIdentity()), (error) => error instanceof ParentHistoryError && error.cause.code === "EISDIR");
    assert.match(parentFault.error, /PARENT_HISTORY_UNAVAILABLE/);
  } finally { rmdirSync(parentFile); renameSync(parentFile + ".before-fault", parentFile); }
  assert.equal(readFileSync(parentFile, "utf8"), parentBytes);
  check("shared parent LINK failure is distinguished from a child writer failure");

  const disabled = new SdkRunHistory({ parent: sdk.SessionManager.inMemory(root), session: sdk.SessionManager.inMemory(root) });
  assert.equal(disabled.begin(runIdentity()), undefined);
  check("in-memory SDK sessions disable history rather than invent persistence");
} catch (error) { report.failure = String(error.stack ?? error); save(); throw error; }
finally { await child.session.abort(); await child.session.waitForIdle(); child.session.dispose(); await parent.session.abort(); await parent.session.waitForIdle(); parent.session.dispose(); }
save();
