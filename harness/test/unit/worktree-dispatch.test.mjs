import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute, normalize, resolve } from "node:path";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { HarnessError } from "../../dist/core/ports.js";
import { resourcesOverlap } from "../../dist/core/dispatch.js";
import { FakePort, deferred, ended, settings, task, tick, until } from "../support/controller-fixture.mjs";
import { assertOwnerInvariants } from "../support/owner-invariants.mjs";

// Controlled core/port protocol tests, not filesystem/policy or model evidence.
function declarations(options = {}) {
  const prepares = [], starts = [];
  return { prepares, starts,
    prepare(declaration, context) {
      prepares.push({ declaration: structuredClone(declaration), cwd: context.cwd, unbound: context.unbound_worktree });
      options.preflight?.(declaration, context);
      const path = word => context.unbound_worktree && !isAbsolute(word) ?
        { kind: "unbound_worktree", agent_id: context.unbound_worktree, rel: normalize(word) } :
        { path: resolve(context.cwd, word), canonical: options.canonical?.(resolve(context.cwd, word), context) ?? resolve(context.cwd, word) };
      return { declaration: structuredClone(declaration), inputs: (declaration.inputs ?? []).map(path),
        ownership: (declaration.ownership ?? []).map(path), ...(declaration.tree ? { tree: path(declaration.tree) } : {}) };
    },
    async start(prepared, context) {
      assert([...prepared.inputs, ...prepared.ownership, ...(prepared.tree ? [prepared.tree] : [])].every(path => path.kind !== "unbound_worktree"));
      starts.push({ prepared: structuredClone(prepared), ...context });
      return await options.start?.(prepared, context) ?? {};
    } };
}
async function memory(t, options = {}) {
  const ports = [], gates = [];
  let held = true;
  const owner = { owner_id: "binding-owner", generation: "binding-generation",
    assertHeld() { if (!held) throw new HarnessError("OWNER_LOCK_CLOSED"); }, close() { held = false; } };
  const dispatch = options.dispatch ?? declarations();
  const c = await OwnerController.open({ owner, concurrency: 3, resident_limit: 8, dispatch,
    createSession: async agent => {
      const port = new FakePort(); port.agent = agent;
      if (agent.settings.workspace === "worktree") port.workspace = { mode: "worktree", source_cwd: agent.settings.cwd,
        cwd: `/private/${agent.name}/repo/subdir`, base_commit: "a".repeat(40) };
      ports.push(port);
      const gate = options.create?.(port, agent);
      if (gate) { gates.push(gate); await gate.promise; }
      return port;
    }, ...options.controller });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await options.beforeShutdown?.();
    await tick();
    for (const port of ports) if (port.streaming) port.finish("cleanup", "aborted");
    const report = await c.shutdown(1000);
    assert.equal(report.closed, true, JSON.stringify(report));
    assertOwnerInvariants(c);
  });
  return { c, ports, dispatch, owner };
}
const work = (name, dispatch, extra = {}) => task("Modify the assigned copy and run the focused checks.", {
  name, settings: { ...settings, cwd: "/source/repo/subdir", workspace: "worktree" }, dispatch, ...extra });
const claim = (c, run) => [...c.claims].find(value => value.agent_id === run.agent_id);
const lease = () => ({ closes: 0, checks: 0, assertHeld() { this.checks++; assert.equal(this.closes, 0); }, close() { this.closes++; } });

test("provisional overlap is Agent-local, never proof that aliases or escaping paths are disjoint", () => {
  const unbound = (agent_id, rel) => ({ kind: "unbound_worktree", agent_id, rel });
  assert(resourcesOverlap(unbound("a", "../build"), unbound("a", "../build/nested")));
  assert.equal(resourcesOverlap(unbound("a", "build"), unbound("b", "build")), false);
  assert.equal(resourcesOverlap(unbound("a", `${"../".repeat(80)}build`), unbound("a", `${"../".repeat(79)}build`)), false,
    "logical resources do not collapse at this process's root before binding");
  assert(resourcesOverlap(unbound("a", "../"), unbound("a", "build/nested")));
  assert.equal(resourcesOverlap(unbound("a", "../../shared"), { path: "/shared", canonical: "/shared" }), false);
  assert(resourcesOverlap({ path: "/a/build", canonical: "/shared" }, { path: "/shared/sub", canonical: "/shared/sub" }));
});

test("independent initial worktrees bind the same relative tree, including .., without fake source conflicts", async t => {
  const gate = deferred();
  const f = await memory(t, { create: () => gate });
  const declaration = { inputs: ["../src/input.ts"], ownership: ["../src/input.ts"], tree: "../build", checks: ["focused"] };
  const a = await f.c.submit("a", work("ash", declaration));
  const b = await f.c.submit("b", work("beech", declaration));
  assert.equal(f.ports.length, 2);
  assert.equal(claim(f.c, a).prepared.tree.kind, "unbound_worktree");
  assert.equal(claim(f.c, a).prepared.tree.agent_id, a.agent_id);
  const prepares = f.dispatch.prepares.length;
  const replay = await f.c.submit("a", work("ash", declaration));
  assert.equal(replay.run_id, a.run_id);
  assert.equal(f.dispatch.prepares.length, prepares);
  await assert.rejects(f.c.submit("a", work("ash", { tree: "changed" })), { code: "REQUEST_CONFLICT" });
  gate.resolve(); await until(() => f.ports.every(port => port.streaming));
  assert.equal(claim(f.c, a).prepared.tree.path, "/private/ash/repo/build");
  assert.equal(claim(f.c, b).prepared.tree.path, "/private/beech/repo/build");
  assert.equal(f.dispatch.starts.length, 2);
  for (const port of f.ports) {
    assert(port.calls[0].prompt.includes(port.workspace.cwd));
    assert(port.calls[0].prompt.includes("Policy and settings inherit from source cwd"));
    port.finish();
  }
  await ended(f.c, a); await ended(f.c, b);
  assert.equal(f.c.claims.size, 0);
});

test("queued cancellation and failed dependencies allocate no worktree; later run can bind its first tree", async t => {
  const f = await memory(t, { controller: { concurrency: 1 } });
  const blocker = await f.c.submit("block", task("hold", { name: "blocker" }));
  await until(() => f.ports[0]?.streaming);
  const queued = await f.c.submit("queued", work("ash", { tree: "build" }));
  assert.equal(f.c.view(queued.run_id).status, "queued");
  assert.equal(f.ports.length, 1);
  f.c.cancel(queued.run_id); await ended(f.c, queued);
  assert.equal(f.c.view(queued.run_id).workspace, undefined);
  const doomed = await f.c.submit("doomed", work("beech", { tree: "build" }, { after: [blocker.run_id] }));
  f.ports[0].finish("not completed", "error", "controlled failure");
  await ended(f.c, blocker); await ended(f.c, doomed);
  assert.equal(f.c.view(doomed.run_id).outcome.reason, "dependency_not_completed");
  assert.equal(f.ports.length, 1);
  const follow = await f.c.submit("follow", { resume: queued.agent_id, prompt: "Continue the unstarted work", dispatch: { tree: "build" } });
  await until(() => f.ports[1]?.streaming);
  assert.equal(claim(f.c, follow).prepared.tree.path, "/private/ash/repo/subdir/build");
  assert.equal(f.c.view(queued.run_id).workspace, undefined, "no later binding backfills an earlier task");
  f.ports[1].finish(); await ended(f.c, follow);
});

test("a real alias conflict discovered after binding fails only the task before history, locks or input", async t => {
  const dispatch = declarations({ canonical: path => path.startsWith("/private/") && path.endsWith("/build") ? "/shared/build" : path });
  let begins = 0;
  const f = await memory(t, { dispatch, create(port) {
    port.history = { begin() { begins++; }, finish(ref) { return ref; } };
  } });
  const holder = await f.c.submit("holder", task("hold the shared tree", { name: "holder", dispatch: { tree: "/shared/build" } }));
  await until(() => f.ports[0]?.streaming);
  const failed = await f.c.submit("conflict", work("ash", { tree: "build" }));
  await ended(f.c, failed);
  const view = f.c.view(failed.run_id);
  assert.equal(view.status, "failed"); assert.equal(view.outcome.reason, "dispatch_preflight_failed");
  assert.match(view.outcome.error, /BUILD_TREE_BUSY.*holder/);
  assert.equal(view.resident, true); assert.equal(view.unavailable, undefined);
  assert.equal(f.ports[1].disposed, 0); assert.equal(f.ports[1].calls.length, 0);
  assert.equal(begins, 1); assert.equal(dispatch.starts.length, 1);
  assert.equal(claim(f.c, failed), undefined);
  const follow = await f.c.submit("safe-follow", { resume: failed.agent_id, prompt: "Use the separately assigned output", dispatch: { tree: "safe" } });
  await until(() => f.ports[1].streaming);
  assert.equal(f.ports.length, 2, "healthy initialized session is reused");
  f.ports[1].finish(); f.ports[0].finish(); await ended(f.c, follow); await ended(f.c, holder);
});

for (const code of ["DISPATCH_INPUT_MISSING", "DISPATCH_TREE_TYPE", "PREFLIGHT_DENIED"]) {
  test(`binding ${code} retains a healthy Agent and reports an actionable preflight outcome`, async t => {
    const dispatch = declarations({ preflight(_declaration, context) {
      if (!context.unbound_worktree) throw new HarnessError(code, { path: `${context.cwd}/input`, surface: "path_read" });
    } });
    const f = await memory(t, { dispatch });
    const run = await f.c.submit("bind-fail", work("ash", { inputs: ["input"], tree: "build" }));
    await ended(f.c, run);
    const view = f.c.view(run.run_id);
    assert.equal(view.status, "failed");
    assert.equal(view.outcome.reason, code === "DISPATCH_INPUT_MISSING" ? "dependency_input_missing" : "dispatch_preflight_failed");
    assert.match(view.outcome.error, new RegExp(code));
    if (code === "DISPATCH_INPUT_MISSING") assert.match(view.outcome.error, /dirty\/untracked files are not copied/);
    if (code === "PREFLIGHT_DENIED") assert.match(view.outcome.error, /not a missing-file or model-execution failure/);
    assert.equal(f.ports[0].disposed, 0); assert.equal(f.ports[0].calls.length, 0);
    assert.equal(f.c.claims.size, 0); assert.equal(dispatch.starts.length, 0);
    const follow = await f.c.submit("follow", { resume: run.agent_id, prompt: "Inspect the confirmed workspace without declarations" });
    await until(() => f.ports[0].streaming); f.ports[0].finish(); await ended(f.c, follow);
  });
}

test("an unbound pump deny preserves the source-candidate diagnostic without inventing a worktree path", async t => {
  let checks = 0;
  const reason = "Provisional preflight denied the source-path candidate; the worktree is not bound yet.";
  const dispatch = declarations({ preflight(_declaration, context) {
    if (context.unbound_worktree && ++checks === 2) throw new HarnessError("PREFLIGHT_DENIED", {
      path: "/source/repo/outside", surface: "path_write", reason,
    });
  } });
  const f = await memory(t, { dispatch });
  const run = await f.c.submit("unbound-deny", work("ash", { tree: "../outside" }));
  await ended(f.c, run);
  const view = f.c.view(run.run_id);
  assert.equal(view.outcome.reason, "dispatch_preflight_failed");
  assert(view.outcome.error.includes(reason)); assert.doesNotMatch(view.outcome.error, /\/private\//);
  assert.equal(view.workspace, undefined); assert.equal(f.ports.length, 0); assert.equal(f.c.claims.size, 0);
});

test("first binding cannot silently retarget an already-bound absolute claim", async t => {
  let changed = false;
  const gate = deferred();
  const dispatch = declarations({ canonical: path => path === "/external/build" && changed ? "/external/other" : path });
  const f = await memory(t, { dispatch, create: () => gate });
  const run = await f.c.submit("bound", work("ash", { ownership: ["local"], tree: "/external/build" }));
  assert.equal(claim(f.c, run).prepared.tree.canonical, "/external/build");
  changed = true; gate.resolve(); await ended(f.c, run);
  assert.equal(f.c.view(run.run_id).outcome.reason, "dispatch_preflight_failed");
  assert.match(f.c.view(run.run_id).outcome.error, /DISPATCH_RESOURCE_CHANGED/);
  assert.equal(dispatch.starts.length, 0); assert.equal(f.ports[0].calls.length, 0);
});

for (const code of ["DISPATCH_INPUT_MISSING", "PREFLIGHT_DENIED"]) {
  test(`queued answer ${code} in pump restores its question, prepared resources and lease`, async t => {
    const tree = lease(); let rejectPump = false;
    const dispatch = declarations({ preflight(_declaration, context) {
      if (rejectPump && context.cwd.startsWith("/private/")) throw new HarnessError(code, { path: `${context.cwd}/input` });
    }, start: (_prepared, context) => context.acquireTree ? { lease: tree } : {} });
    const f = await memory(t, { dispatch, controller: { concurrency: 1 } });
    const original = await f.c.submit("question", work("ash", { inputs: ["input"], ownership: ["src/a.ts"], tree: "build" }));
    await until(() => f.ports[0]?.streaming);
    f.ports[0].callbacks.question("Proceed with this format?"); f.ports[0].finish("waiting"); await ended(f.c, original);
    const question = f.c.view(original.run_id).question_id, held = claim(f.c, original);
    const prepared = held.prepared, before = structuredClone(prepared), starts = dispatch.starts.length;
    const blocker = await f.c.submit("blocker", task("hold the provider slot", { name: "beech" }));
    await until(() => f.ports[1]?.streaming);
    const answer = await f.c.answer("answer", original.agent_id, question, "Use the existing format");
    assert.equal(answer.status, "queued"); assert.equal(held.run_id, answer.run_id);
    rejectPump = true; // Simulate an input disappearing or policy changing while queued.
    f.ports[1].finish(); await ended(f.c, blocker); await ended(f.c, answer);
    assert.equal(f.c.view(answer.run_id).outcome.reason,
      code === "DISPATCH_INPUT_MISSING" ? "dependency_input_missing" : "dispatch_preflight_failed");
    assert.equal(f.c.view(original.run_id).question_id, question);
    assert.equal(f.c.agents.get(original.agent_id).question.reserved_by, undefined);
    assert.equal(claim(f.c, original), held); assert.equal(held.run_id, original.run_id);
    assert.equal(held.prepared, prepared); assert.deepEqual(held.prepared, before);
    assert.equal(held.lease, tree); assert.equal(tree.closes, 0);
    assert.equal(f.ports[0].calls.length, 1); assert.equal(f.ports[0].disposed, 0);
    assert.equal(dispatch.starts.length, starts, "pump refusal occurs before observation or input");
    rejectPump = false;
    const resumed = await f.c.answer("answer-again", original.agent_id, question, "Continue");
    await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
    assert.equal(dispatch.starts.filter(start => start.acquireTree).length, 1);
    f.ports[0].finish(); await ended(f.c, resumed); assert.equal(tree.closes, 1);
  });
}

test("binding refusal on an answer reopens the original question without mutating its claim or tree lease", async t => {
  const tree = lease(); let rejectBinding = false, boundChecks = 0;
  const dispatch = declarations({ preflight(_declaration, context) {
    if (rejectBinding && !context.unbound_worktree && ++boundChecks === 3) throw new HarnessError("PREFLIGHT_DENIED");
  }, start: (_prepared, context) => context.acquireTree ? { lease: tree } : {} });
  const f = await memory(t, { dispatch });
  const original = await f.c.submit("ask", work("ash", { ownership: ["src/a.ts"], tree: "build" }));
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Which implementation?"); f.ports[0].finish("waiting"); await ended(f.c, original);
  const question = f.c.view(original.run_id).question_id, held = claim(f.c, original), prepared = held.prepared;
  rejectBinding = true;
  const answer = await f.c.answer("answer", original.agent_id, question, "Use the minimal implementation");
  await ended(f.c, answer);
  assert.equal(f.c.view(answer.run_id).outcome.reason, "dispatch_preflight_failed");
  assert.equal(f.c.view(original.run_id).question_id, question);
  assert.equal(claim(f.c, original), held); assert.equal(held.run_id, original.run_id);
  assert.deepEqual(held.prepared, prepared); assert.equal(held.lease, tree); assert.equal(tree.closes, 0);
  assert.equal(f.ports[0].calls.length, 1); assert.equal(f.ports[0].disposed, 0);
  rejectBinding = false;
  const resumed = await f.c.answer("answer-again", original.agent_id, question, "Continue the same decision");
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  assert.equal(dispatch.starts.filter(start => start.acquireTree).length, 1, "answer does not reacquire its own lock");
  f.ports[0].finish(); await ended(f.c, resumed); assert.equal(tree.closes, 1);
});

test("a symlink change after a worktree question fails strict admission and keeps the original lease", async t => {
  let changed = false;
  const tree = lease();
  const dispatch = declarations({ canonical: path => changed && path.endsWith("/build") ? "/other/build" : path,
    start: () => ({ lease: tree }) });
  const f = await memory(t, { dispatch });
  const original = await f.c.submit("ask", work("ash", { tree: "build" }));
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Proceed?"); f.ports[0].finish(); await ended(f.c, original);
  const question = f.c.view(original.run_id).question_id, held = claim(f.c, original), before = structuredClone(held.prepared);
  changed = true;
  await assert.rejects(f.c.answer("answer", original.agent_id, question, "yes"), { code: "DISPATCH_RESOURCE_CHANGED" });
  assert.deepEqual(held.prepared, before); assert.equal(held.run_id, original.run_id);
  assert.equal(f.c.view(original.run_id).question_id, question); assert.equal(tree.closes, 0);
  await f.c.kill(original.agent_id); assert.equal(tree.closes, 1);
});

for (const phase of ["creation", "observation"]) {
  test(`cancel during worktree ${phase} never enters child input and releases only observed handles`, async t => {
    const gate = deferred(), tree = lease();
    const dispatch = declarations({ start: async () => { if (phase === "observation") await gate.promise; return { lease: tree }; } });
    const f = await memory(t, { dispatch, create: () => phase === "creation" ? gate : undefined,
      beforeShutdown: () => gate.resolve() });
    const run = await f.c.submit("cancel", work("ash", { tree: "build" }));
    await until(() => phase === "creation" ? f.ports.length === 1 : dispatch.starts.length === 1);
    f.c.cancel(run.run_id); gate.resolve(); await ended(f.c, run);
    assert.equal(f.c.view(run.run_id).status, "cancelled");
    assert.equal(f.ports[0].calls.length, 0); assert.equal(f.c.claims.size, 0);
    assert.equal(tree.closes, phase === "observation" ? 1 : 0);
  });
}

test("binding preflight remains read-only even when a callback swallows reentrant cancellation", async t => {
  let controller;
  const dispatch = declarations({ preflight(_declaration, context) {
    if (!context.unbound_worktree && controller) {
      try { controller.cancel(controller.findAgent("ash").run_id); } catch { /* A swallowed violation still taints the read. */ }
    }
  } });
  const f = await memory(t, { dispatch }); controller = f.c;
  const run = await f.c.submit("read-only", work("ash", { tree: "build" }));
  await ended(f.c, run);
  const view = f.c.view(run.run_id);
  assert.equal(view.status, "failed"); assert.equal(view.stop_reason, undefined);
  assert.match(view.outcome.error, /OBSERVATION_REENTRANCY/);
  assert.equal(f.ports[0].calls.length, 0); assert.equal(f.ports[0].stopped, 0);
  assert.equal(f.c.claims.size, 0);
});

test("forged provisional identity is refused before allocation or claims", async t => {
  const f = await memory(t, { dispatch: { prepare(declaration) {
    return { declaration, inputs: [], ownership: [], tree: { kind: "unbound_worktree", agent_id: "foreign", rel: "build" } };
  } } });
  await assert.rejects(f.c.submit("forged", work("ash", { tree: "build" })), { code: "INVALID_PREPARED_DISPATCH" });
  assert.equal(f.ports.length, 0); assert.equal(f.c.claims.size, 0); assert.equal(f.c.stats().runs, 0);
});
