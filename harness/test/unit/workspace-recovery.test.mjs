// Source-only recovery fault boundaries: fixture-owned filesystem, no Git
// subprocess, SDK session, provider, generated build or real user state.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
const sourceOutput = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions }).outputText;
const metadataUrl = dataModule(sourceOutput("../../src/core/workspace-metadata.ts"));
const { workspaceRecoveryOf } = await import(metadataUrl);
const seamUrl = dataModule(`
import * as fs from "node:fs/promises";
export const state = {};
export const access = (...args) => { state.calls.push("access"); return fs.access(...args); };
export const mkdir = (...args) => { state.calls.push("mkdir"); return fs.mkdir(...args); };
export const realpath = (...args) => { state.calls.push("realpath"); return fs.realpath(...args); };
export const stat = (...args) => { state.calls.push("stat"); return fs.stat(...args); };
export const symlink = (...args) => { state.calls.push("symlink"); return fs.symlink(...args); };
export const lstat = async (path) => {
  state.calls.push("lstat");
  if (state.failure === "leaf_identity" && path === state.allocated) throw state.error;
  return await fs.lstat(path);
};
export const mkdtemp = async (prefix) => {
  state.calls.push("mkdtemp");
  if (state.failure === "allocation") throw state.error;
  state.allocated = await fs.mkdtemp(prefix);
  return state.allocated;
};
export const open = async (path, ...args) => {
  state.calls.push("open");
  const manifest = path.endsWith("/recovery.jsonl");
  if (manifest && state.failure === "open") throw state.error;
  const file = await fs.open(path, ...args);
  if (manifest) state.manifest = path;
  return {
    writeFile: async (data) => {
      state.calls.push("writeFile");
      if (manifest && state.failure === "write") throw state.error;
      await file.writeFile(data);
    },
    sync: async () => {
      state.calls.push("sync");
      if ((manifest && state.failure === "sync") || (!manifest && state.failure === "directory_sync")) throw state.error;
      await file.sync();
    },
    close: async () => {
      state.calls.push("close");
      await file.close();
      if (manifest) {
        state.closed = true;
        if (state.failure === "close") throw state.error;
      }
    },
  };
};
// A close fault is reached after a controlled Git-probe failure. Never execute
// the fixture executable, search PATH or invoke a real Git subprocess here.
export const execFile = (_file, _args, _options, callback) => {
  state.gitCalls++;
  queueMicrotask(() => callback(Object.assign(new Error("synthetic Git failure"), { code: 2 }), Buffer.alloc(0), Buffer.alloc(0)));
  return { stdin: { on() {}, end() {} } };
};
`);
const seam = await import(seamUrl);
const workspaceUrl = dataModule(sourceOutput("../../src/runtime/agent-workspace.ts")
  .replace('"../core/workspace-metadata.js"', JSON.stringify(metadataUrl))
  .replace('"node:fs/promises"', JSON.stringify(seamUrl))
  .replace('"node:child_process"', JSON.stringify(seamUrl)));
const { createAgentWorkspace, AgentWorkspaceError } = await import(workspaceUrl);

function fixture(t, failure) {
  const directory = mkdtempSync(join(tmpdir(), "harness-workspace-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = { ...process.env };
  const home = join(directory, "home"), agentDir = join(directory, "agent"), sourceCwd = join(directory, "source");
  for (const path of [home, agentDir, sourceCwd]) mkdirSync(path);
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: join(directory, "state") });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key];
    Object.assign(process.env, original);
  });
  for (const key of Object.keys(seam.state)) delete seam.state[key];
  Object.assign(seam.state, { calls: [], gitCalls: 0, failure, error: new Error(`injected ${failure} failure`) });
  const git = join(directory, "never-executed-git");
  writeFileSync(git, "fixture executable sentinel\n", { mode: 0o700 });
  return { sourceCwd, create: () => createAgentWorkspace({ agentDir, agentId: "fixture-agent", sourceCwd, git }) };
}

for (const failure of ["allocation", "leaf_identity", "open", "write", "sync", "directory_sync", "close"]) {
  test(`${failure} failure exposes only observed retained facts without retry, cleanup or read-side IO`, async (t) => {
    const f = fixture(t, failure);
    await assert.rejects(f.create(), (error) => {
      assert.ok(error instanceof AgentWorkspaceError);
      assert.equal(error.cause, seam.state.error);
      const allocated = failure !== "allocation", opened = !["allocation", "leaf_identity", "open"].includes(failure);
      const expected = { mode: "worktree", state: "partial", source_cwd: f.sourceCwd,
        ...(allocated ? { allocated_path: seam.state.allocated } : {}),
        ...(opened ? { recovery_manifest: seam.state.manifest } : {}) };
      const calls = [...seam.state.calls], gitCalls = seam.state.gitCalls;
      const recovery = workspaceRecoveryOf(error);
      assert.deepEqual(recovery, expected);
      recovery.source_cwd = "/consumer-mutation";
      assert.deepEqual(workspaceRecoveryOf(error), expected, "metadata reads are detached and repeatable");
      assert.deepEqual(seam.state.calls, calls, "recovery reads do not touch the filesystem");
      assert.equal(seam.state.gitCalls, gitCalls, "recovery reads do not probe or retry Git");
      assert.equal(error.retained_path, allocated ? join(seam.state.allocated, "tree") : undefined,
        "the typed diagnostic still preserves its intended target");
      assert.equal(Object.hasOwn(recovery, "retained_path"), false, "observed recovery omits an unverified target");
      assert.equal(error.manifest, expected.recovery_manifest);
      if (allocated) {
        assert.equal(existsSync(expected.allocated_path), true, "the actual allocation is retained");
        assert.equal(existsSync(error.retained_path), false, "a target candidate is not a verified checkout");
        assert.equal(existsSync(join(expected.allocated_path, "recovery.jsonl")), opened);
      }
      if (!opened) assert.doesNotMatch(error.message, /recovery manifest:/, "an unopened manifest is not claimed in diagnostics either");
      if (failure === "write") assert.equal(readFileSync(expected.recovery_manifest, "utf8"), "", "open succeeded but no record was written");
      if (failure === "sync") assert.equal(JSON.parse(readFileSync(expected.recovery_manifest, "utf8")).state, "allocated",
        "written bytes are observed, not a successful fsync promise");
      assert.equal(seam.state.gitCalls, failure === "close" ? 1 : 0, "earlier faults never reach a Git probe");
      assert.equal(seam.state.calls.filter((call) => call === "mkdtemp").length, 1, "allocation is not retried");
      if (opened) assert.equal(seam.state.closed, true, "file closure was attempted without deleting retained artifacts");
      return true;
    });
  });
}
