import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute, normalize, resolve } from "node:path";
import { validSettings } from "../../dist/core/contracts.js";
import { agentRow, taskReply } from "../../dist/tools/replies.js";
import { withWorkspaceRecovery } from "../../dist/core/workspace-metadata.js";
import { FakePort, ended, fixture, settings, task, until } from "../support/controller-fixture.mjs";

const workspace = { mode: "worktree", cwd: "/tmp/private-worktree/repo", source_cwd: "/tmp", base_commit: "a".repeat(40) };
const work = () => task("inspect your private working copy", { settings: { ...settings, profile: "editor", workspace: "worktree" } });

test("workspace selection is optional, closed and immutable in admitted settings", () => {
  assert(validSettings(settings));
  for (const value of ["shared", "worktree"]) assert(validSettings({ ...settings, workspace: value }));
  for (const value of [false, null, {}, "sandbox", "/tmp"]) assert.equal(validSettings({ ...settings, workspace: value }), false);
});

test("list marks only queued/running worktrees pending without binding or recovery", async (t) => {
  const f = await fixture(t, { controller: { createSession: async () => { throw new Error("WORKTREE_CREATION_FAILED: fixture"); } } });
  const run = await f.controller.submit("failed-worktree", work());
  await ended(f.controller, run);
  const view = f.controller.view(run.run_id);
  assert.equal(view.status, "failed");
  assert.equal(view.workspace, undefined);
  for (const status of ["queued", "running", "cancelling", "completed", "needs_input", "failed", "cancelled"]) {
    const row = agentRow({ ...view, status, execution_exited: false }, () => "worker");
    assert.equal(Object.hasOwn(row, "workspace"), false);
    assert.equal(row.workspace_pending, status === "queued" || status === "running" ? true : undefined);
    assert.equal(taskReply({ ...view, status, execution_exited: false }, () => "worker").workspace_pending, undefined, "actions omit workspace metadata");
  }
  const exited = agentRow({ ...view, status: "running", execution_exited: true }, () => "worker");
  assert.equal(exited.workspace_pending, undefined);
  const shared = agentRow({ ...view, status: "running", execution_exited: false, isolation: "shared" }, () => "worker");
  assert.equal(shared.workspace, undefined); assert.equal(shared.workspace_pending, undefined);
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
  const row = agentRow(view, () => "worker");
  assert.equal(row.profile, "worker");
  assert.deepEqual(row.workspace, workspace); assert.equal(row.workspace_pending, undefined);
  assert.equal(port.disposed, 1, "only session disposal; core has no filesystem deletion operation");
});

for (const [observed, retained_paths] of [
  [{}, undefined],
  [{ allocated_path: "/tmp/allocated" }, ["/tmp/allocated"]],
  [{ allocated_path: "/tmp/allocated", recovery_manifest: "/tmp/allocated/recovery.jsonl" },
    ["/tmp/allocated", "/tmp/allocated/recovery.jsonl"]],
  [{ state: "checkout_ready", checkout_root: "/tmp/verified/tree", cwd: "/tmp/verified/tree", base_commit: workspace.base_commit,
    recovery_manifest: "/tmp/verified/recovery.jsonl" }, ["/tmp/verified/tree", "/tmp/verified/recovery.jsonl"]],
]) test(`failed workspace projections expose observed locations only: ${JSON.stringify(observed)}`, async (t) => {
  const recovery = { mode: "worktree", state: "partial", source_cwd: "/tmp", ...observed };
  const f = await fixture(t, { controller: { createSession: async () => {
    throw withWorkspaceRecovery(new Error("workspace assembly failed"), recovery);
  } } });
  const run = await f.controller.submit("recovery", { ...work(), name: "worker" }); await ended(f.controller, run);
  const view = f.controller.view(run.run_id);
  assert.equal(view.status, "failed"); assert.deepEqual(view.recovery, recovery, "cleanup retains internal recovery facts");
  assert.equal(agentRow({ ...view, status: "running", execution_exited: false }, () => "worker").workspace_pending, undefined,
    "recovery evidence suppresses pending even without a confirmed binding");
  for (const row of [taskReply(view, () => "worker"), taskReply(view, () => "worker", true), agentRow(view, () => "worker")]) {
    assert.equal(Object.hasOwn(row, "workspace"), false, "a recovered checkout is not a confirmed execution binding");
    assert.equal(Object.hasOwn(row, "recovery"), false); assert.equal(row.workspace_pending, undefined);
    if (retained_paths) assert.deepEqual(row.retained_paths, retained_paths);
    else assert.equal(Object.hasOwn(row, "retained_paths"), false, "an intended target is not an observed allocation");
  }
  for (const request of [{ kind: "read", agent_id: run.agent_id }, { kind: "wait", agent_ids: [run.agent_id], wait_ms: 0 }]) {
    const reply = JSON.parse((await f.controller.observe(request, { validate() {} })).content[0].text);
    assert.equal(reply.agents[0].retained_paths === undefined, retained_paths === undefined);
    if (retained_paths) assert.deepEqual(reply.agents[0].retained_paths, retained_paths);
    assert.equal(Object.hasOwn(reply.agents[0], "workspace"), false); assert.equal(Object.hasOwn(reply.agents[0], "recovery"), false);
  }
  await f.controller.kill(run.agent_id);
  assert.deepEqual(f.controller.view(run.run_id).recovery, recovery, "kill cannot erase retained cleanup facts");
});

test("worktree checks and bound declarations use execution cwd while settings retain their source base", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const observed = [];
  const f = await fixture(t, { controller: { createSession: async () => port, dispatch: {
    prepare(declaration, context) { observed.push(["prepare", context.cwd]); return { declaration, inputs: [], ownership: [] }; },
    start(_prepared, context) { observed.push(["start", context.cwd]); return { source_state: { state: "unknown", reason: "fixture" } }; },
  } }, beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const run = await f.controller.submit("checks", { ...work(), dispatch: { checks: ["local-check"] } });
  await until(() => port.streaming);
  assert.deepEqual(observed.filter(([kind]) => kind === "prepare"),
    [["prepare", "/tmp"], ["prepare", "/tmp"], ["prepare", workspace.cwd]]);
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

test("first worktree task binds relative tree before observation; follow-ups and replay keep the same workspace", async (t) => {
  const port = new FakePort(); port.workspace = { ...workspace };
  const prepares = [], starts = [];
  let creates = 0;
  const dispatch = { prepare(declaration, context) {
      prepares.push({ declaration: structuredClone(declaration), cwd: context.cwd });
      const path = (word) => context.unbound_worktree && !isAbsolute(word) ?
        { kind: "unbound_worktree", agent_id: context.unbound_worktree, rel: normalize(word) } :
        { path: resolve(context.cwd, word), canonical: resolve(context.cwd, word) };
      return { declaration: structuredClone(declaration), inputs: (declaration.inputs ?? []).map(path),
        ownership: (declaration.ownership ?? []).map(path), ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree) }) };
    }, async start(prepared, context) { starts.push({ prepared: structuredClone(prepared), cwd: context.cwd }); return {}; } };
  const f = await fixture(t, { controller: { createSession: async () => { creates++; return port; }, dispatch },
    beforeShutdown: () => { if (port.streaming) port.finish("cleanup", "aborted"); } });
  const declaration = { inputs: ["src/parser.ts"], ownership: ["src/parser.ts"], tree: "build", checks: ["focused"] };
  const first = await f.controller.submit("first", { ...work(), dispatch: declaration });
  await until(() => port.streaming);
  assert.equal(creates, 1);
  assert.deepEqual(prepares.map(entry => entry.cwd), ["/tmp", "/tmp", workspace.cwd]);
  assert.deepEqual(starts.map(entry => entry.cwd), [workspace.cwd]);
  assert.equal(starts[0].prepared.tree.canonical, `${workspace.cwd}/build`);
  assert.equal(starts[0].prepared.ownership[0].path, `${workspace.cwd}/src/parser.ts`);
  assert.equal([...f.controller.claims][0].prepared.tree.canonical, `${workspace.cwd}/build`);
  assert.deepEqual(f.controller.view(first.run_id).dispatch, declaration, "the original declaration remains unchanged");
  assert.match(port.calls[0].prompt, /Execution cwd: "/);
  assert(port.calls[0].prompt.includes(workspace.cwd));
  port.finish(); await ended(f.controller, first);
  const follow = await f.controller.submit("follow", { resume: first.agent_id, prompt: "build it", dispatch: { tree: "build" } });
  await until(() => port.calls.length === 2 && port.streaming);
  assert(prepares.slice(3).every(entry => entry.cwd === workspace.cwd));
  const preparedCount = prepares.length;
  const replay = await f.controller.submit("follow", { resume: first.agent_id, prompt: "build it", dispatch: { tree: "build" } });
  assert.equal(replay.run_id, follow.run_id);
  assert.equal(prepares.length, preparedCount, "accepted replay does not prepare or bind again");
  port.finish(); await ended(f.controller, follow);
  assert.equal(f.controller.view(follow.run_id).status, "completed");
  assert.equal(creates, 1, "follow-up reuses the same healthy session");
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
