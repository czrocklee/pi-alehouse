// Storage-only experiment: actual installed SDK, controlled model IO, no FileStore.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadHost } from "../support/host.mjs";
import { ADMISSION, START, END, beginRun, createFixture, endRun, readHistory, readRun } from "../support/sdk-history-fixture.mjs";

const [piExecutable, output] = process.argv.slice(2);
assert(piExecutable && output, "Use script/check-pi-sdk-history.sh");
process.umask(0o077);
const root = resolve(output);
const host = await loadHost(piExecutable), { sdk } = host;
const report = { sdk: host.versions.pi, node: process.version, claims: [], observations: [], limitations: [
  "SDK storage feasibility only: no Controller/StorePort replacement, execution-owner/reload or permission acceptance",
  "Only synthetic SDK sessions are read/written/killed; no credentials, private history or real model requests",
  "Result references are experiment metadata, not production schemas, owner handles or an untrusted-file parser",
  "Subprocess coordinates come from IPC; no persisted parent-to-child lookup/discovery is tested",
  "SIGKILL while OS/filesystem continue is not power-loss durability; no fsync guarantee is claimed",
] };
const save = () => writeFileSync(join(root, "sdk-history.json"), JSON.stringify(report, null, 2));
const record = (name, detail) => { report.claims.push({ name, detail }); save(); console.log(`PASS SDK history: ${name}`); };
const observe = (name, detail) => { report.observations.push({ name, detail }); save(); console.log(`OBSERVED SDK history: ${name}`); };
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const prompt = async (fixture, text) => {
  await fixture.session.prompt(text, { source: "extension", expandPromptTemplates: false });
  await fixture.session.waitForIdle();
};

async function subprocess(stage, kill) {
  const child = fork(new URL("./sdk-history-child.mjs", import.meta.url), [piExecutable, root, stage], {
    cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close"), messages = [];
  let stdout = "", stderr = "", timed_out = false;
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const reached = Promise.withResolvers();
  child.on("message", (message) => {
    messages.push(message);
    if (message.event === "checkpoint") reached.resolve(message);
  });
  const deadline = setTimeout(() => { timed_out = true; child.kill("SIGKILL"); reached.reject(new Error(`fixture timeout: ${stage}`)); }, 10000);
  // Non-kill scenarios do not await reached; avoid an unused rejected Promise.
  if (!kill) void reached.promise.catch(() => {});
  try {
    if (kill) {
      await Promise.race([reached.promise, closed.then(() => { throw new Error(`premature fixture exit: ${stage}: ${stderr}`); })]);
      child.kill("SIGKILL");
    }
    const [code, signal] = await closed;
    return { stage, code, signal, messages, stdout, stderr, timed_out };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

try {
  // A genuine tool turn and reuse, with only references written as Run metadata.
  const f = await createFixture(host, root, "new-reuse");
  const first = beginRun(f.manager);
  assert.equal(existsSync(f.manager.getSessionFile()), false);
  let calls = 0;
  f.provider.respond(async () => calls++ === 0
    ? { text: "NOT_THE_FINAL_ANSWER", tools: [{ type: "toolCall", id: "synthetic-tool", name: "synthetic_echo", arguments: {} }] }
    : { text: "FIRST_FINAL" });
  await prompt(f, "first synthetic Run");
  const firstRef = endRun(f.manager, first, "completed");
  const second = beginRun(f.manager);
  f.provider.respond(async () => ({ text: "SECOND_FINAL" }));
  await prompt(f, "reuse this SDK session for a distinct Run");
  const secondRef = endRun(f.manager, second, "completed");
  const file = f.manager.getSessionFile(), original = hash(file);
  const secondBranch = f.manager.getBranch(secondRef.end);
  const secondUser = secondBranch.slice(secondBranch.findIndex((entry) => entry.id === second.start) + 1)
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert(secondUser);
  const metadata = f.manager.getEntries().filter((entry) => entry.type === "custom" && [START, END].includes(entry.customType));
  assert(!JSON.stringify(metadata).includes("FIRST_FINAL") && !JSON.stringify(metadata).includes("SECOND_FINAL"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  f.session.dispose(); // Discard live model runtime; the SDK log remains.
  const reopened = readHistory(sdk, file);
  assert.equal(hash(file), original);
  assert.equal(readRun(reopened, first.run_id).text, "FIRST_FINAL");
  assert.equal(readRun(reopened, second.run_id).text, "SECOND_FINAL");
  assert(reopened.getEntries().some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("NOT_THE_FINAL_ANSWER")));
  assert(!JSON.stringify(reopened.buildSessionContext().messages).includes(first.run_id));
  assert.equal(readRun(reopened, "unrelated-run").status, "not_recorded");
  // A wrong reference into another Run must not silently become its result.
  reopened.getEntries().find((e) => e.id === secondRef.end).data.final_entry_id = firstRef.final;
  assert.throws(() => readRun(reopened, second.run_id), /wrong final message reference/);
  record("new/reuse keep separate final answers after dispose, without result text duplication", {
    file, firstRef, secondRef, metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
    sameSession: true, sourceUnchangedByRead: true, customEntriesExcludedFromModelContext: true,
  });

  // Exercise the installed SDK's public log operations, NOT an LLM compaction call.
  f.manager.appendCompaction("SYNTHETIC_COMPACTION_SUMMARY", secondUser.id, 1000);
  assert(!JSON.stringify(f.manager.buildSessionContext().messages).includes("FIRST_FINAL"));
  assert.equal(readRun(readHistory(sdk, file), first.run_id).text, "FIRST_FINAL");
  f.manager.branch(firstRef.end);
  f.manager.appendCustomEntry("synthetic-branch-note", { value: "new active branch" });
  const branched = readHistory(sdk, file);
  assert(!JSON.stringify(branched.buildSessionContext().messages).includes("SECOND_FINAL"));
  assert.equal(readRun(branched, second.run_id).text, "SECOND_FINAL");
  record("compaction and branch change active context, not old referenced entries", { firstKeptEntryId: secondUser.id, oldBranchResultReadable: true,
    limit: "appendCompaction/branch operations only; no real summarizer or compaction lifecycle acceptance" });

  const missingNewline = join(root, "missing-newline.jsonl");
  writeFileSync(missingNewline, readFileSync(file, "utf8").trimEnd());
  const before = hash(missingNewline);
  readHistory(sdk, missingNewline);
  assert.equal(hash(missingNewline), before);
  sdk.SessionManager.open(missingNewline);
  assert.notEqual(hash(missingNewline), before);
  assert(readFileSync(missingNewline, "utf8").endsWith("\n"));
  const torn = join(root, "torn.jsonl");
  writeFileSync(torn, readFileSync(file, "utf8") + '{"type":"custom","unfinished":');
  const tornBefore = hash(torn);
  assert.throws(() => readHistory(sdk, torn), SyntaxError);
  assert.equal(hash(torn), tornBefore);
  record("SDK open repairs a missing newline; snapshot + inMemory reads without repairing source", {
    sourceChangedByOpen: true, readOnlySnapshotUnchanged: true, malformedTailRejected: true,
    limit: "current version 3 synthetic files only; no salvage/migration support in candidate reader",
  });

  // A terminal-looking assistant is not a terminal Run report after a crash.
  for (const stage of ["cold-admission", "warm-admission", "streaming", "before-terminal", "terminal-recorded"]) {
    const result = await subprocess(stage, true);
    assert.equal(result.signal, "SIGKILL");
    const checkpoint = result.messages.find((message) => message.event === "checkpoint");
    assert(checkpoint);
    if (stage === "cold-admission") {
      assert.equal(checkpoint.isPersisted, true);
      assert.equal(checkpoint.exists, false);
      assert.equal(existsSync(checkpoint.file), false);
      result.observed = "returned custom ID and isPersisted=true, but no log survives";
    } else {
      const history = readHistory(sdk, checkpoint.file);
      assert.equal(readRun(history, checkpoint.earlier.run_id).text, "EARLIER_RESULT");
      if (stage === "warm-admission") {
        assert.equal(history.getEntry(checkpoint.id).customType, ADMISSION);
        result.observed = "an already-flushed session records queued metadata, without creating a separate execution session for that queued work";
      } else {
        const value = readRun(history, checkpoint.run.run_id);
        assert.equal(value.status, stage === "terminal-recorded" ? "completed" : "unknown");
        assert.equal(value.complete, stage === "terminal-recorded");
        if (stage === "terminal-recorded") assert.equal(value.text, "NEW_FINAL");
        if (stage === "streaming") {
          assert(checkpoint.partialObserved && checkpoint.streaming);
          assert(!readFileSync(checkpoint.file, "utf8").includes("UNSAVED_PARTIAL"));
        }
        if (stage === "before-terminal") assert(readFileSync(checkpoint.file, "utf8").includes("NEW_FINAL"));
        result.observed = value;
      }
    }
    record(`SIGKILL ${stage}: read-only fixture, no inferred completion`, result);
  }

  // Direct metadata append failure: synchronous error, but in-memory tree mutated.
  const beforeFault = f.manager.getLeafId();
  renameSync(file, file + ".before-fault"); mkdirSync(file);
  assert.throws(() => f.manager.appendCustomEntry("failed-append", { value: "memory only" }), { code: "EISDIR" });
  assert.notEqual(f.manager.getLeafId(), beforeFault);
  assert.equal(f.manager.getLeafEntry().customType, "failed-append");
  rmdirSync(file); renameSync(file + ".before-fault", file); // Test teardown only; never reuse that writer.
  assert(!readHistory(sdk, file).getEntries().some((entry) => entry.customType === "failed-append"));
  record("metadata IO failure throws after mutating memory; discard writer rather than retry", { code: "EISDIR", memoryAheadOfFile: true });

  // Observe both automatic write boundaries, without a global exception handler.
  for (const stage of ["write-failure", "assistant-write-failure"]) {
    const failure = await subprocess(stage, false);
    const ready = failure.messages.find((message) => message.event === "fault-ready");
    const returned = failure.messages.find((message) => message.event === "root-returned");
    failure.rootResult = returned?.rootResult ?? "not_observed";
    failure.memoryHasNewAssistant = returned?.memoryHasNewAssistant ?? null;
    failure.survived = failure.messages.some((message) => message.event === "survived");
    // Save the actual tuple BEFORE assertions. Rejection need not print to stderr.
    // Pin the observed tuple only for these fixtures, not every host/extension.
    observe(`native SDK automatic log-write error propagation: ${stage}`, failure);
    assert(ready); assert.equal(failure.timed_out, false, "native error handling did not settle");
    assert.equal(failure.code, 0); assert.equal(failure.signal, null);
    assert.equal(returned?.rootResult, "rejected:EISDIR");
    assert.equal(returned.injected, true);
    assert.equal(returned.requests, stage === "write-failure" ? 0 : 1);
    assert.equal(returned.memoryHasNewAssistant, stage === "assistant-write-failure");
    const cleanup = failure.messages.find((message) => message.event === "survived");
    assert(cleanup?.idle && cleanup.streaming === false, "synthetic SDK cleanup did not complete");
    rmdirSync(ready.file); renameSync(ready.file + ".before-fault", ready.file);
    const history = readHistory(sdk, ready.file);
    assert.equal(readRun(history, ready.run.run_id).status, "unknown");
    assert.equal(readRun(history, ready.earlier.run_id).text, "EARLIER_RESULT");
    assert(!readFileSync(ready.file, "utf8").includes("MEMORY_ONLY_AFTER_FAULT"));
  }

  unlinkSync(file);
  assert.throws(() => readHistory(sdk, file), { code: "ENOENT" });
  record("deleting the referenced SDK log makes this candidate reader return ENOENT", { unavailable: true });
} catch (error) {
  report.failure = String(error.stack ?? error); save(); throw error;
}
save();
console.log(`SDK single-session history probes complete: ${join(root, "sdk-history.json")}; not end-to-end storage replacement or a durability guarantee.`);
