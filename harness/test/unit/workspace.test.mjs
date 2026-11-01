import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { validSettings } from "../../dist/core/contracts.js";
import { WORKTREE_TREE_RESOLUTION } from "../../dist/core/owner-controller.js";
import { agentRow } from "../../dist/tools/replies.js";
import { FakePort, ended, fixture, settings, task, until } from "../support/controller-fixture.mjs";

const workspace = { mode: "worktree", cwd: "/tmp/private-worktree/repo", source_cwd: "/tmp", base_commit: "a".repeat(40) };
const work = () => task("inspect your private working copy", { settings: { ...settings, profile: "editor", workspace: "worktree" } });

test("workspace selection is optional, closed and immutable in admitted settings", () => {
  assert(validSettings(settings));
  for (const value of ["shared", "worktree"]) assert(validSettings({ ...settings, workspace: value }));
  for (const value of [false, null, {}, "sandbox", "/tmp"]) assert.equal(validSettings({ ...settings, workspace: value }), false);
});

test("list projects uninitialized worktrees honestly after failed assembly, and omits shared metadata", async (t) => {
  const f = await fixture(t, { controller: { createSession: async () => { throw new Error("WORKTREE_CREATION_FAILED: fixture"); } } });
  const run = await f.controller.submit("failed-worktree", work());
  await ended(f.controller, run);
  const view = f.controller.view(run.run_id), summary = f.controller.agentSummary(run.agent_id);
  assert.equal(view.status, "failed");
  assert.equal(view.workspace, undefined);
  for (const status of ["queued", "running", "failed"]) {
    const row = agentRow({ ...view, status }, summary, () => "worker");
    assert.deepEqual(row.workspace, { mode: "worktree", state: "uninitialized" });
  }
  assert.equal(agentRow({ ...view, isolation: "shared" }, summary, () => "worker").workspace, undefined);
});

test("worktree binding survives follow-up and kill without changing source settings or deleting artifacts", async (t) => {
  let creates = 0;
  const port = new FakePort(); port.workspace = { ...workspace };
  const f = await fixture(t, { controller: { createSession: async () => { creates++; return port; } },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const first = await f.controller.submit("first", work());
  await until(() => port.streaming);
  assert.equal(f.controller.view(first.run_id).effective_settings.cwd, "/tmp");
  assert.deepEqual(f.controller.view(first.run_id).workspace, workspace);
  port.callbacks.touched("new.txt");
  assert.deepEqual(f.controller.agentSummary(first.agent_id).touched, ["new.txt"]);
  port.finish(); await ended(f.controller, first);
  const second = await f.controller.submit("second", { resume: first.agent_id, prompt: "follow up" });
  await until(() => port.calls.length === 2 && port.streaming);
  assert.equal(creates, 1);
  assert.deepEqual(f.controller.view(second.run_id).workspace, workspace);
  port.finish(); await ended(f.controller, second);
  await f.controller.kill(first.agent_id);
  const view = f.controller.view(second.run_id);
  assert.deepEqual(view.workspace, workspace);
  assert.equal(view.isolation, "worktree");
  const row = agentRow(view, f.controller.agentSummary(first.agent_id), () => "worker");
  assert.equal(row.profile, "worker");
  assert.deepEqual(row.workspace, workspace);
  assert.equal(port.disposed, 1, "only session disposal; core has no filesystem deletion operation");
});

test("worktree checks observe actual execution cwd while declarations retain their source base", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const observed = [];
  const f = await fixture(t, { controller: { createSession: async () => port, dispatch: {
    prepare(declaration, context) { observed.push(["prepare", context.cwd]); return { declaration, inputs: [], ownership: [] }; },
    start(_prepared, context) { observed.push(["start", context.cwd]); return { source_state: { state: "unknown", reason: "fixture" } }; },
  } }, beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const run = await f.controller.submit("checks", { ...work(), dispatch: { checks: ["local-check"] } });
  await until(() => port.streaming);
  assert(observed.filter(([kind]) => kind === "prepare").every(([, cwd]) => cwd === "/tmp"));
  assert.deepEqual(observed.filter(([kind]) => kind === "start"), [["start", workspace.cwd]]);
  port.finish(); await ended(f.controller, run);
});

for (const bad of [undefined, { ...workspace, source_cwd: "/other" }, { ...workspace, cwd: "relative" }]) {
  test(`worktree assembly refuses mismatched runtime metadata: ${JSON.stringify(bad)}`, async (t) => {
    const port = new FakePort(); port.workspace = bad;
    const f = await fixture(t, { controller: { createSession: async () => port } });
    const run = await f.controller.submit("mismatch", work());
    await ended(f.controller, run);
    const view = f.controller.view(run.run_id);
    assert.equal(view.status, "failed");
    assert.match(view.outcome.error, /INVALID_WORKSPACE_BINDING/);
    assert.equal(port.calls.length, 0);
    assert.equal(port.disposed, 1);
  });
}

test("shared mode rejects an unexpected worktree binding before any run", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  // If the guard regresses, finish the unexpected run so the verdict assertion
  // fails directly rather than detecting it through a fake-session timeout.
  const run = port.run.bind(port);
  port.run = (...args) => { const pending = run(...args); port.finish("unexpected shared execution"); return pending; };
  const f = await fixture(t, { controller: { createSession: async () => port } });
  const accepted = await f.controller.submit("unexpected", task("shared task"));
  await ended(f.controller, accepted);
  const view = f.controller.view(accepted.run_id);
  assert.equal(view.status, "failed");
  assert.match(view.outcome.error, /UNEXPECTED_WORKSPACE_BINDING/);
  assert.equal(view.isolation, "shared");
  assert.equal(view.workspace, undefined);
  assert.equal(port.calls.length, 0, "no prompt ever ran in the forged working copy");
  assert.equal(port.disposed, 1);
});

test("a mutated reused workspace binding fails the follow-up before its run, preserving the confirmed metadata", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const f = await fixture(t, { controller: { createSession: async () => port },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const first = await f.controller.submit("first", work());
  await until(() => port.streaming);
  port.finish(); await ended(f.controller, first);
  port.workspace = { ...workspace, cwd: "/tmp/mutated-worktree/repo", base_commit: "b".repeat(40) };
  const run = port.run.bind(port);
  port.run = (...args) => { const pending = run(...args); port.finish("unexpected follow-up execution"); return pending; };
  const second = await f.controller.submit("second", { resume: first.agent_id, prompt: "follow up" });
  await ended(f.controller, second);
  const view = f.controller.view(second.run_id);
  assert.equal(view.status, "failed");
  assert.match(view.outcome.error, /INVALID_WORKSPACE_BINDING/);
  assert.deepEqual(view.workspace, workspace, "the previously confirmed binding stays the projected metadata");
  assert.deepEqual(f.controller.view(first.run_id).workspace, workspace);
  assert.equal(port.calls.length, 1, "the follow-up never reached port.run");
  assert.equal(port.disposed, 1, "a mismatched binding quarantines and disposes the session");
});

test("touched renders absolute worktree paths relative to the actual cwd; escapes and outside paths stay absolute and persist", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const f = await fixture(t, { controller: { createSession: async () => port },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const first = await f.controller.submit("touched", work());
  await until(() => port.streaming);
  port.callbacks.touched(`${workspace.cwd}/src/new.ts`);
  port.callbacks.touched(`${workspace.cwd}/../escape.ts`);
  port.callbacks.touched("/tmp/outside-secret.ts");
  port.callbacks.touched("relative-edit.ts");
  port.finish(); await ended(f.controller, first);
  const expected = ["src/new.ts", "/tmp/private-worktree/escape.ts", "/tmp/outside-secret.ts", "relative-edit.ts"];
  assert.deepEqual(f.controller.agentSummary(first.agent_id).touched, expected);
  const second = await f.controller.submit("touched-followup", { resume: first.agent_id, prompt: "follow up" });
  await until(() => port.calls.length === 2 && port.streaming);
  port.callbacks.touched(`${workspace.cwd}/src/followup.ts`);
  port.finish(); await ended(f.controller, second);
  assert.deepEqual(f.controller.agentSummary(first.agent_id).touched, [...expected, "src/followup.ts"],
    "the confirmed worktree base persists across the follow-up");
});

test("worktree tree declarations reject before preparation until the workspace is initialized", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const prepares = [];
  let creates = 0;
  const dispatch = { prepare(declaration, context) {
      prepares.push({ declaration: structuredClone(declaration), cwd: context.cwd });
      const path = (word) => ({ path: resolve(context.cwd, word), canonical: resolve(context.cwd, word) });
      return { declaration: structuredClone(declaration), inputs: [], ownership: [],
        ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree) }) };
    }, async start() { return {}; } };
  const f = await fixture(t, { controller: { createSession: async () => { creates++; return port; }, dispatch },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  await assert.rejects(f.controller.submit("tree", { ...work(), dispatch: { tree: "build" } }), (error) => {
    assert.equal(error.code, "DISPATCH_WORKTREE_UNINITIALIZED");
    assert.equal(error.details.key, "tree");
    assert.equal(error.details.requested, "build");
    assert.equal(error.details.resolution, WORKTREE_TREE_RESOLUTION);
    return true;
  });
  assert.equal(prepares.length, 0, "the rejection precedes dispatch.prepare");
  assert.equal(creates, 0, "no session or worktree is created for a rejected declaration");
  assert.equal(f.controller.claims.size, 0);
  assert.equal(f.controller.stats().runs, 0);
  assert.equal(f.controller.stats().requests, 0);
  const first = await f.controller.submit("first", { ...work(), dispatch: { checks: ["focused"] } });
  await until(() => port.streaming);
  port.finish(); await ended(f.controller, first);
  assert.deepEqual(f.controller.view(first.run_id).workspace, workspace);
  const follow = await f.controller.submit("follow", { resume: first.agent_id, prompt: "build it",
    dispatch: { tree: `${workspace.cwd}/build` } });
  const treePrepares = prepares.filter((entry) => entry.declaration.tree !== undefined);
  assert.equal(treePrepares.length, 2, "admission and the pre-execution recheck prepared the tree follow-up");
  assert(treePrepares.every((entry) => entry.cwd === "/tmp"),
    "relative declarations keep the source settings cwd, never the worktree");
  assert.deepEqual(treePrepares.map((entry) => entry.declaration),
    [{ tree: `${workspace.cwd}/build` }, { tree: `${workspace.cwd}/build` }]);
  const prepared = prepares.length;
  const replay = await f.controller.submit("follow", { resume: first.agent_id, prompt: "build it",
    dispatch: { tree: `${workspace.cwd}/build` } });
  assert.equal(replay.run_id, follow.run_id, "accepted replay is unaffected by the admission gate");
  assert.equal(prepares.length, prepared, "a replay does not re-prepare");
  await until(() => port.calls.length === 2 && port.streaming);
  port.finish(); await ended(f.controller, follow);
  assert.equal(f.controller.view(follow.run_id).status, "completed");
  assert.equal(creates, 1, "the initialized follow-up reuses the same session");
});

test("checks receipts record the actual worktree cwd, never the source settings cwd", async (t) => {
  const receipts = [];
  const port = new FakePort(); port.workspace = { ...workspace };
  const dispatch = { prepare(declaration) { return { declaration: structuredClone(declaration), inputs: [], ownership: [] }; },
    start: () => ({ source_state: { state: "unknown", reason: "fixture" } }) };
  const f = await fixture(t, { controller: {
    createSession: async () => {
      port.history = {
        begin: async (run) => ({ ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }),
        finish: async (ref, _outcome, _output, _usage, receipt) => { receipts.push(structuredClone(receipt)); return { ...ref, end_entry_id: "bbbbbbbb" }; },
      };
      return port;
    }, dispatch },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const run = await f.controller.submit("receipt", { ...work(), dispatch: { checks: ["focused:receipt-cwd"] } });
  await until(() => port.streaming);
  assert.equal(f.controller.view(run.run_id).effective_settings.cwd, "/tmp");
  port.finish(); await ended(f.controller, run);
  assert.equal(receipts.length, 1, "exactly the sole run-end append carries the receipt");
  const receipt = receipts[0];
  assert.equal(receipt.version, 1);
  assert.deepEqual(receipt.checks, ["focused:receipt-cwd"]);
  assert.equal(receipt.cwd, workspace.cwd, "the receipt reports the actual workspace cwd");
  assert.notEqual(receipt.cwd, settings.cwd, "not the source settings cwd");
  assert.deepEqual(receipt.source_state, { state: "unknown", reason: "fixture" });
  assert.equal(receipt.tree, undefined);
});
