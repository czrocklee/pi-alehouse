// Synthetic factory/assembly boundaries with the real pinned SDK SessionManager.
// No authority, model, credentials, web IO, or generated build is exercised here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
const sourceOutput = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions }).outputText;
// Use the actual source core error and WeakMap helpers, not fake classes or a
// potentially stale dist generation. Only SDK/IO boundaries below are seams.
const portsUrl = dataModule(sourceOutput("../../src/core/ports.ts"));
const metadataUrl = dataModule(sourceOutput("../../src/core/workspace-metadata.ts"));
const workspaceUrl = dataModule(sourceOutput("../../src/runtime/agent-workspace.ts")
  .replace('"../core/workspace-metadata.js"', JSON.stringify(metadataUrl)));
const { SessionInitializationError } = await import(portsUrl);
const seamUrl = dataModule(`
import { createHash } from "node:crypto";
export { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
export { SessionInitializationError } from ${JSON.stringify(portsUrl)};
export { AgentWorkspaceError } from ${JSON.stringify(workspaceUrl)};
export { withWorkspaceRecovery, workspaceRecoveryOf } from ${JSON.stringify(metadataUrl)};
export const state = {};
export const digest = (text) => createHash("sha256").update(text).digest("hex");
export const createEventBus = () => ({});
export const createAgentSession = () => {};
export const createAgentWorkspace = async (input) => {
  state.workspaceCalls.push(input);
  if (state.workspaceError) throw state.workspaceError;
  return state.workspaceResult;
};
export const requireReadiness = () => {};
export const createChildTools = () => [];
export const webProfileNames = ["researcher"];
export const childWebExtension = (factory) => factory;
export const orderFreeToolSchemaExtension = () => {};
export class ChildRunGate { extension = () => {}; accepting = false; stopped = false; }
export class ManagedBlockObserver {
  constructor(subscribe) { state.blockSubscribe = subscribe; }
  begin(id, callbacks, accepting) { state.blockRuns.push({ id, callbacks, accepting }); }
  flush() {
    state.blockFlushes++;
    state.blockRuns.at(-1).callbacks.managedBlock?.({ toolName: "write" });
  }
  end() { state.blockEnds++; }
}
export class PiRunJournal {}
export class WorkerStatsObserver {
  extension = () => {};
  beginRun() {} endRun() {} dispose() {}
}
export class DefaultResourceLoader {
  constructor(options) { this.options = options; state.loaders.push(this); }
  async reload() {
    state.policyBindsAtReload.push(state.policyBinds.length);
    state.prompts.push(this.options.appendSystemPromptOverride());
    if (state.loaderError) throw state.loaderError;
  }
}
export const assembleChildSession = async (input) => {
  state.assemblies.push(input);
  if (state.assemblyError) throw state.assemblyError;
  return { session: { sessionId: state.sessionIdOverride ?? input.options.sessionManager.getSessionId(),
    thinkingLevel: state.badThinking ? "high" : "off",
    subscribe: (listener) => { state.blockListener = listener; return () => { state.blockUnsubscribes++; }; },
    getActiveToolNames: () => [...input.options.tools] } };
};
export const disposeChildSession = async () => {
  state.cleanups++;
  if (state.cleanupError) throw state.cleanupError;
  return state.cleanupReport;
};
export class PiAgentSessionAdapter {
  constructor(options) { this.session_id = options.session.sessionId; this.history = options.history; }
  async run(prompt) {
    state.runs.push(prompt);
    if (state.onRun) await state.onRun();
    return { kind: "success" };
  }
  canInput() { return false; }
  async steer() { return false; }
  async stop() { state.blockEndsAtStop = state.blockEnds; }
  clearInputs() { return []; }
  async dispose() {
    if (state.disposal) return await state.disposal;
    if (state.disposeError) throw state.disposeError;
    return state.cleanupReport;
  }
}
`);
const seam = await import(seamUrl);
const source = readFileSync(new URL("../../src/runtime/child-factory.ts", import.meta.url), "utf8");
// Replace only dependency boundaries, not the factory implementation under test.
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  transformers: { before: [(context) => (file) => ts.visitNode(file, function visit(node) {
    if (ts.isImportDeclaration(node) && !node.moduleSpecifier.text.startsWith("node:")) {
      return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause,
        ts.factory.createStringLiteral(seamUrl), node.attributes);
    }
    return ts.visitEachChild(node, visit, context);
  })] },
}).outputText;
const { createChildSessionFactory } = await import(dataModule(output));

function fixture(t, profile = "editor") {
  const directory = mkdtempSync(join(tmpdir(), "harness-child-factory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const key of Object.keys(seam.state)) delete seam.state[key];
  Object.assign(seam.state, { loaders: [], prompts: [], assemblies: [], runs: [], cleanups: 0,
    blockRuns: [], blockEnds: 0, blockFlushes: 0, blockUnsubscribes: 0,
    workspaceCalls: [], policyBinds: [], policyReleases: [], policyAliases: [], policyBindsAtReload: [], activities: [], approvalBegins: [],
    workspaceResult: { workspace: Object.freeze({ mode: "worktree", cwd: join(directory, "execution"), source_cwd: directory, base_commit: "a".repeat(40) }),
      checkout_root: join(directory, "execution"), source_root: directory, manifest: join(directory, "recovery.jsonl") },
    cleanupReport: { shutdownExited: true, errors: [] } });
  const webReleases = [], approvals = [];
  const definition = `${profile} synthetic definition`, tools = ["read", "alert_parent", "ask_parent"];
  const agent = { agent_id: "model-unrelated-agent-id", name: "synthetic", settings: {
    profile, cwd: directory, definition_digest: seam.digest(definition), tools,
    provider: "synthetic", model: "synthetic", thinking: "off",
  } };
  const model = { provider: "synthetic", id: "synthetic" };
  const options = {
    ctx: { cwd: directory, isProjectTrusted: () => true, sessionManager: { getSessionDir: () => directory,
      getSessionFile: () => join(directory, "parent.jsonl") } },
    parentBus: {}, agentDir: directory, permissionRoot: directory, policyRoot: directory, parentId: "parent",
    runtime: { getModel: () => model, getPhysicalModel: () => model },
    profiles: { [profile]: { definition, body: "Shared worker body.", tools } }, settings: () => ({}),
    parentHistory: {}, parentPermission: () => ({}), getPermissionsService: () => undefined,
    subscribeManagedBlocks: () => () => {},
    approvalBindings: { childExtension: (id) => { approvals.push(id); return () => {}; }, begin: (...args) => seam.state.approvalBegins.push(args), end() {} },
    activities: { track: (id, cwd) => { seam.state.activities.push({ id, cwd }); return { extension() {}, begin() {} }; } },
    git: "/fixture/trusted-git",
    bindWorkspacePolicy: (input) => {
      seam.state.policyBinds.push(input);
      let live = true;
      return {
        aliases(paths) {
          assert(live, "fixture policy binding released");
          seam.state.policyAliases.push({ sessionId: input.sessionId, paths: [...paths] });
          return seam.state.policyAliasResult ?? [];
        },
        release() { live = false; seam.state.policyReleases.push(input.sessionId); },
      };
    },
    web: { acquire: async () => ({ factory() {}, release: () => webReleases.push("released") }) },
  };
  return { agent, options, webReleases, approvals,
    create: () => createChildSessionFactory(options)(agent) };
}

test("shared default creates no workspace or policy alias", async (t) => {
  const f = fixture(t, "editor"), port = await f.create();
  assert.equal(port.workspace, undefined);
  assert.equal(port.workspace_details, undefined);
  assert.equal(port.workspace_policy, undefined);
  assert.deepEqual(seam.state.workspaceCalls, []);
  assert.deepEqual(seam.state.policyBinds, []);
  assert.equal(seam.state.assemblies[0].options.cwd, f.agent.settings.cwd);
  assert.equal(seam.state.loaders[0].options.cwd, f.agent.settings.cwd);
  await port.dispose();
});

test("worktree actual cwd reaches SDK manager/tools/activity/approval; source alone drives instruction discovery", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  const port = await f.create(), workspace = seam.state.workspaceResult.workspace;
  const manager = seam.state.assemblies[0].options.sessionManager;
  assert.deepEqual(seam.state.workspaceCalls, [{ agentDir: f.options.agentDir, agentId: f.agent.agent_id, sourceCwd: f.agent.settings.cwd, git: f.options.git }]);
  assert.equal(port.workspace, workspace); assert.ok(Object.isFrozen(port.workspace));
  assert.deepEqual(Object.keys(workspace).sort(), ["base_commit", "cwd", "mode", "source_cwd"], "WorkspaceInfo stays unchanged");
  assert.deepEqual(port.workspace_details, { checkout_root: seam.state.workspaceResult.checkout_root,
    recovery_manifest: seam.state.workspaceResult.manifest });
  assert.ok(Object.isFrozen(port.workspace_details));
  assert.ok(Object.isFrozen(port.workspace_policy));
  assert.deepEqual(Object.keys(port.workspace_policy), ["aliases"], "core gets neither root mapping nor release authority");
  assert.deepEqual(seam.state.policyAliases, [{ sessionId: port.session_id, paths: [] }], "validate the live authority seam before loading extensions");
  seam.state.policyAliasResult = [join(workspace.source_cwd, "file")];
  assert.deepEqual(port.workspace_policy.aliases([join(workspace.cwd, "file")]), seam.state.policyAliasResult);
  assert.deepEqual(seam.state.policyAliases.at(-1), { sessionId: port.session_id, paths: [join(workspace.cwd, "file")] });
  assert.equal(f.agent.settings.cwd, f.options.ctx.cwd, "admitted source remains unchanged");
  assert.equal(seam.state.assemblies[0].options.cwd, workspace.cwd);
  assert.equal(manager.getCwd(), workspace.cwd);
  assert.equal(seam.state.loaders[0].options.cwd, workspace.source_cwd, "do not load the worktree's checked-out .pi as authority");
  assert.deepEqual(seam.state.activities, [{ id: f.agent.agent_id, cwd: workspace.cwd }]);
  assert.deepEqual(seam.state.policyBinds, [{ sessionId: port.session_id, cwd: workspace.cwd, source_cwd: workspace.source_cwd,
    checkout_root: seam.state.workspaceResult.checkout_root, source_root: seam.state.workspaceResult.source_root, projectTrusted: true }]);
  assert.deepEqual(seam.state.policyBindsAtReload, [1], "bind source policy before permission module loading");
  assert.ok(seam.state.prompts[0].at(-1).includes(JSON.stringify(workspace)));
  assert.ok(seam.state.prompts[0].at(-1).includes(seam.state.workspaceResult.manifest));
  const metadata = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "active_agent");
  assert.deepEqual(metadata.data.workspace, workspace);
  await port.run("initial", {}, { run_id: "first" });
  await port.run("answer or follow-up", {}, { run_id: "second" });
  assert.deepEqual(seam.state.approvalBegins.map((args) => args[1].cwd), [workspace.cwd, workspace.cwd]);
  assert.equal(seam.state.workspaceCalls.length, 1, "Agent workspace is reused across Runs and answers");
  await port.stop(); assert.deepEqual(seam.state.policyReleases, []);
  const disposal = Promise.withResolvers(); seam.state.disposal = disposal.promise;
  const pending = port.dispose();
  assert.deepEqual(seam.state.policyReleases, [], "a dispose attempt alone is not cleanup proof");
  disposal.resolve({ shutdownExited: true, errors: [] });
  await pending; assert.deepEqual(seam.state.policyReleases, [port.session_id]);
  assert.throws(() => port.workspace_policy.aliases([]), /binding released/, "release cannot leave a cached authorization alias");
  assert.equal(port.workspace, workspace, "termination retains recovery metadata, not deletion");
});

test("nested execution inherits the whole known checkout root pair, not just its cwd", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  f.agent.settings.cwd = join(f.options.ctx.cwd, "nested");
  seam.state.workspaceResult.workspace = Object.freeze({ ...seam.state.workspaceResult.workspace,
    cwd: join(seam.state.workspaceResult.checkout_root, "nested"), source_cwd: f.agent.settings.cwd });
  const port = await f.create(), bound = seam.state.policyBinds[0];
  assert.equal(bound.cwd, seam.state.workspaceResult.workspace.cwd);
  assert.equal(bound.source_cwd, f.agent.settings.cwd);
  assert.equal(bound.checkout_root, seam.state.workspaceResult.checkout_root);
  assert.equal(bound.source_root, seam.state.workspaceResult.source_root);
  assert.notEqual(bound.checkout_root, bound.cwd);
  assert.notEqual(bound.source_root, bound.source_cwd);
  assert.equal(port.workspace_details.checkout_root, bound.checkout_root, "recovery root is not the nested execution cwd");
  await port.dispose();
});

for (const trusted of [false, true]) test(`worktree source project trust ${trusted} is explicit, never inferred from new cwd`, async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  f.options.ctx.isProjectTrusted = () => trusted;
  const port = await f.create();
  assert.equal(seam.state.policyBinds[0].projectTrusted, trusted);
  await port.dispose();
});

test("worktree bridge is mandatory before any checkout/session; no source fallback", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  delete f.options.bindWorkspacePolicy;
  await assert.rejects(f.create(), /Worktree policy inheritance is unavailable/);
  assert.deepEqual(seam.state.workspaceCalls, []); assert.deepEqual(seam.state.assemblies, []);
});

test("old authority without live aliases fails before SDK assembly and releases its binding", async (t) => {
  const f = fixture(t); f.agent.settings.workspace = "worktree";
  f.options.bindWorkspacePolicy = () => ({ release: () => seam.state.policyReleases.push("old-authority") });
  await assert.rejects(f.create(), /Worktree policy binding is unavailable/);
  assert.deepEqual(seam.state.assemblies, []);
  assert.deepEqual(seam.state.policyReleases, ["old-authority"]);
});

test("worktree creation failure is cached per Agent, never a source-cwd fallback or blind retry", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  seam.state.workspaceError = new Error("WORKTREE_CREATION_FAILED retained path: fixture-path");
  const create = createChildSessionFactory(f.options);
  await assert.rejects(create(f.agent), /WORKTREE_CREATION_FAILED/);
  await assert.rejects(create(f.agent), /WORKTREE_CREATION_FAILED/);
  assert.equal(seam.state.workspaceCalls.length, 1); assert.deepEqual(seam.state.assemblies, []);
  assert.equal(seam.workspaceRecoveryOf(seam.state.workspaceError), undefined, "never parse location facts from diagnostic text");
});

test("workspace creation forwards attached partial recovery unchanged across cached failures", async (t) => {
  const f = fixture(t); f.agent.settings.workspace = "worktree";
  const recovery = { mode: "worktree", state: "partial", source_cwd: f.agent.settings.cwd,
    allocated_path: join(f.options.ctx.cwd, "allocation") };
  const failure = Object.freeze(new seam.AgentWorkspaceError("x".repeat(1200), join(recovery.allocated_path, "tree")));
  seam.state.workspaceError = seam.withWorkspaceRecovery(failure, recovery);
  const create = createChildSessionFactory(f.options);
  for (let i = 0; i < 2; i++) await assert.rejects(create(f.agent), (error) => {
    assert.equal(error, failure);
    assert.deepEqual(seam.workspaceRecoveryOf(error), recovery, "no successful binding or manifest is invented");
    return true;
  });
  assert.equal(seam.state.workspaceCalls.length, 1);
  assert.deepEqual(seam.state.assemblies, []);
  assert.deepEqual(seam.state.policyBinds, []);
});

test("bare synthetic AgentWorkspaceError fields are not promoted to observed recovery", async (t) => {
  const f = fixture(t); f.agent.settings.workspace = "worktree";
  const retained = join(f.options.ctx.cwd, "retained"), manifest = join(f.options.ctx.cwd, "recovery.jsonl");
  const failure = Object.freeze(new seam.AgentWorkspaceError("x".repeat(1200), retained, manifest));
  seam.state.workspaceError = failure;
  await assert.rejects(f.create(), (error) => {
    assert.equal(error, failure);
    assert.equal(seam.workspaceRecoveryOf(error), undefined, "only the private observed-metadata attachment carries recovery facts");
    assert.equal(error.retained_path, retained);
    assert.equal(error.manifest, manifest);
    return true;
  });
});

test("confirmed failed assembly releases policy binding but reuses the retained Agent worktree", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  const create = createChildSessionFactory(f.options); seam.state.loaderError = new Error("fixture loader failure");
  await assert.rejects(create(f.agent), (error) => {
    assert.equal(error, seam.state.loaderError);
    assert.equal(error.message, "fixture loader failure", "diagnostic text is not mutated for recovery transport");
    assert.deepEqual(seam.workspaceRecoveryOf(error), { ...seam.state.workspaceResult.workspace, state: "checkout_ready",
      checkout_root: seam.state.workspaceResult.checkout_root,
      recovery_manifest: seam.state.workspaceResult.manifest });
    return true;
  });
  assert.equal(seam.state.policyReleases.length, 1);
  delete seam.state.loaderError;
  const port = await create(f.agent);
  assert.equal(seam.state.workspaceCalls.length, 1); assert.equal(seam.state.policyBinds.length, 2);
  assert.equal(port.workspace, seam.state.workspaceResult.workspace);
  await port.dispose();
});

test("ready checkout recovery survives a frozen SDK assembly failure without replacing the error", async (t) => {
  const f = fixture(t, "researcher"); f.agent.settings.workspace = "worktree";
  const failure = Object.freeze(new Error("synthetic SDK assembly failure ".repeat(80)));
  seam.state.assemblyError = failure;
  await assert.rejects(f.create(), (error) => {
    assert.equal(error, failure);
    assert.deepEqual(seam.workspaceRecoveryOf(error), { ...seam.state.workspaceResult.workspace, state: "checkout_ready",
      checkout_root: seam.state.workspaceResult.checkout_root,
      recovery_manifest: seam.state.workspaceResult.manifest });
    return true;
  });
  assert.equal(seam.state.assemblies.length, 1);
  assert.equal(seam.state.policyReleases.length, 1);
  assert.deepEqual(f.webReleases, ["released"]);
});

test("real frozen SessionInitializationError retains identity, causes, ready recovery and both uncertain leases", async (t) => {
  const f = fixture(t, "researcher"); f.agent.settings.workspace = "worktree";
  const original = new Error("synthetic SDK assembly failure"), cleanup = new Error("synthetic cleanup uncertainty");
  const failure = Object.freeze(new SessionInitializationError(original, cleanup)), message = failure.message;
  seam.state.assemblyError = failure;
  await assert.rejects(f.create(), (error) => {
    assert.equal(error, failure);
    assert.ok(error instanceof SessionInitializationError, "the actual core AggregateError type, not a seam-only class");
    assert.ok(error instanceof AggregateError);
    assert.equal(error.code, "CHILD_INITIALIZATION_FAILED");
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanup]);
    assert.equal(error.message, message);
    assert.deepEqual(seam.workspaceRecoveryOf(error), { ...seam.state.workspaceResult.workspace, state: "checkout_ready",
      checkout_root: seam.state.workspaceResult.checkout_root,
      recovery_manifest: seam.state.workspaceResult.manifest });
    return true;
  });
  assert.deepEqual(seam.state.policyReleases, []);
  assert.deepEqual(f.webReleases, []);
});

for (const failedAssembly of [false, true]) test(`worktree policy binding retained on uncertain ${failedAssembly ? "assembly" : "disposal"}`, async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  if (failedAssembly) {
    seam.state.assemblyError = new SessionInitializationError(new Error("fixture assembly failure"), new Error("uncertain fixture shutdown"));
    await assert.rejects(f.create(), seam.SessionInitializationError);
  } else {
    const port = await f.create(); seam.state.cleanupReport = { shutdownExited: false, errors: [] };
    await port.dispose();
  }
  assert.deepEqual(seam.state.policyReleases, []);
});

test("worktree policy binding retained when shutdown exited but cleanup reported errors", async (t) => {
  const f = fixture(t, "editor"); f.agent.settings.workspace = "worktree";
  const port = await f.create();
  seam.state.cleanupReport = { shutdownExited: true, errors: ["fixture cleanup error"] };
  assert.deepEqual(await port.dispose(), seam.state.cleanupReport);
  assert.deepEqual(seam.state.policyReleases, [], "core still treats the cleanup as uncertain");
  assert.equal(port.workspace, seam.state.workspaceResult.workspace, "retained workspace metadata remains available");
});

test("child and approval identities use the real SDK manager ID across Runs", async (t) => {
  const f = fixture(t), port = await f.create();
  const manager = seam.state.assemblies[0].options.sessionManager;
  assert.equal(port.session_id, manager.getSessionId());
  assert.notEqual(port.session_id, f.agent.agent_id);
  assert.notEqual(port.session_id, f.options.parentId);
  assert.deepEqual(f.approvals, [port.session_id]);
  await port.run("initial", {}, { run_id: "first" });
  await port.run("follow-up", {}, { run_id: "second" });
  assert.deepEqual(seam.state.runs, ["initial", "follow-up"]);
  await port.dispose();
});

for (const profile of ["editor", "researcher"]) test(`${profile} preserves profile prompt and web lifecycle`, async (t) => {
  const f = fixture(t, profile), port = await f.create();
  assert.deepEqual(seam.state.prompts[0], ["Shared worker body.", `<active_agent name="${profile}"/>`]);
  assert.deepEqual(f.webReleases, []);
  await port.dispose();
  assert.equal(f.webReleases.length, profile === "researcher" ? 1 : 0);
});

for (const failure of ["loaderError", "assemblyError"]) test(`${failure} before execution or after confirmed assembly cleanup releases web lease`, async (t) => {
  const f = fixture(t, "researcher");
  seam.state[failure] = new Error("synthetic assembly failure");
  await assert.rejects(f.create(), /synthetic assembly failure/);
  assert.equal(f.webReleases.length, 1);
  if (failure === "loaderError") assert.equal(seam.state.assemblies.length, 0);
});

test("SessionInitializationError retains web lease on uncertain assembly cleanup", async (t) => {
  const f = fixture(t, "researcher");
  seam.state.assemblyError = new SessionInitializationError(new Error("fixture assembly failure"), new Error("uncertain assembly"));
  await assert.rejects(f.create(), seam.SessionInitializationError);
  assert.deepEqual(f.webReleases, []);
});

for (const uncertain of [false, true]) test(`post-assembly validation failure ${uncertain ? "retains" : "releases"} web and policy leases with cleanup proof`, async (t) => {
  const f = fixture(t, "researcher"); f.agent.settings.workspace = "worktree";
  seam.state.badThinking = true;
  if (uncertain) seam.state.cleanupReport = { shutdownExited: false, errors: [] };
  await assert.rejects(f.create(), (error) => {
    if (uncertain) {
      assert.ok(error instanceof SessionInitializationError, "factory-created cleanup uncertainty keeps the real core type");
      assert.match(error.cause.message, /strictly equal/);
      assert.match(error.errors[1].message, /Child cleanup incomplete/);
    } else assert.match(error.message, /strictly equal/);
    assert.equal(seam.workspaceRecoveryOf(error).state, "checkout_ready");
    return true;
  });
  assert.equal(seam.state.cleanups, 1);
  assert.equal(f.webReleases.length, uncertain ? 0 : 1);
  assert.equal(seam.state.policyReleases.length, uncertain ? 0 : 1);
});

test("managed-block subscription follows actual SDK identity and seals on every Run exit and stop", async (t) => {
  const f = fixture(t), port = await f.create();
  assert.equal(seam.state.blockSubscribe, f.options.subscribeManagedBlocks);
  const deferred = Promise.withResolvers();
  seam.state.onRun = () => deferred.promise;
  const feedback = [], callbacks = { managedBlock: (fact) => feedback.push(fact),
    alert: () => assert.fail("managed feedback must not call the child alert sink") };
  const pending = port.run("initial", callbacks, { run_id: "first" });
  assert.equal(seam.state.blockRuns[0].id, port.session_id);
  assert.equal(seam.state.blockRuns[0].callbacks, callbacks);
  seam.state.blockListener({ type: "tool_execution_start", isError: true });
  assert.equal(seam.state.blockFlushes, 0);
  seam.state.blockListener({ type: "tool_execution_end", isError: false });
  assert.equal(seam.state.blockFlushes, 1, "SDK safe point does not classify isError");
  assert.deepEqual(feedback, [{ toolName: "write" }], "factory wires the typed trusted callback, not arbitrary alert text");
  await port.stop();
  assert.equal(seam.state.blockEndsAtStop, 1, "seals before SDK stop can reenter");
  deferred.resolve(); await pending;
  assert.equal(seam.state.blockEnds, 2);
  assert.equal(seam.state.blockUnsubscribes, 1);
  seam.state.onRun = () => { throw new Error("synthetic Run failure"); };
  await assert.rejects(port.run("follow-up", {}, { run_id: "second" }), /synthetic Run failure/);
  assert.equal(seam.state.blockRuns[1].id, port.session_id);
  assert.equal(seam.state.blockEnds, 3);
  assert.equal(seam.state.blockUnsubscribes, 2);
  await port.dispose();
  assert.equal(seam.state.blockEnds, 4);
});

test("mismatched SDK execution ID fails assembly and cleans before revocation", async (t) => {
  const f = fixture(t, "researcher");
  seam.state.sessionIdOverride = "unexpected-sdk-session";
  await assert.rejects(f.create(), /Child session identity changed/);
  assert.equal(seam.state.cleanups, 1);
  assert.equal(f.webReleases.length, 1);
});

for (const rejected of [false, true]) test(`uncertain ${rejected ? "rejected" : "reported"} disposal retains web lease`, async (t) => {
  const f = fixture(t, "researcher"), port = await f.create();
  if (rejected) {
    seam.state.disposeError = new Error("synthetic disposal rejection");
    await assert.rejects(port.dispose(), /synthetic disposal rejection/);
  } else {
    seam.state.cleanupReport = { shutdownExited: false, errors: ["synthetic uncertainty"] };
    assert.equal((await port.dispose()).shutdownExited, false);
  }
  assert.deepEqual(f.webReleases, []);
});
