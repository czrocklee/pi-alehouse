// Synthetic factory/assembly boundaries with the real pinned SDK SessionManager.
// No authority, model, credentials, web IO, or generated build is exercised here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true };
const sourceOutput = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions }).outputText;
const portsUrl = dataModule(sourceOutput("../../src/core/ports.ts"));
const { SessionInitializationError } = await import(portsUrl);
const seamUrl = dataModule(`
import { createHash } from "node:crypto";
export { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
export { SessionInitializationError } from ${JSON.stringify(portsUrl)};
export const state = {};
export const digest = (text) => createHash("sha256").update(text).digest("hex");
export const createEventBus = () => ({});
export const createAgentSession = () => {};
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
  compilerOptions,
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
    blockRuns: [], blockEnds: 0, blockFlushes: 0, blockUnsubscribes: 0, activities: [], approvalBegins: [],
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
    web: { acquire: async () => ({ factory() {}, release: () => webReleases.push("released") }) },
  };
  return { agent, options, webReleases, approvals,
    create: () => createChildSessionFactory(options)(agent) };
}

test("SDK, loader, activity and approval all retain the original admitted cwd across Runs", async t => {
  const f = fixture(t), port = await f.create(), assembly = seam.state.assemblies[0];
  const cwd = f.agent.settings.cwd;
  assert.equal(assembly.options.cwd, cwd);
  assert.equal(assembly.options.sessionManager.getCwd(), cwd);
  assert.equal(seam.state.loaders[0].options.cwd, cwd);
  assert.deepEqual(seam.state.activities, [{ id: f.agent.agent_id, cwd }]);
  for (const field of ["workspace", "workspace_details", "workspace_policy"]) assert.equal(Object.hasOwn(port, field), false);
  const active = assembly.options.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "active_agent");
  assert(active); assert.equal(Object.hasOwn(active.data, "workspace"), false);
  await port.run("initial", {}, { run_id: "first" });
  await port.run("follow-up", {}, { run_id: "second" });
  assert.deepEqual(seam.state.approvalBegins.map(args => args[1].cwd), [cwd, cwd]);
  await port.dispose();
});

test("child and approval identities use the real SDK manager ID across Runs", async t => {
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

for (const profile of ["editor", "researcher"]) test(`${profile} preserves profile prompt and web lifecycle`, async t => {
  const f = fixture(t, profile), port = await f.create();
  assert.deepEqual(seam.state.prompts[0], ["Shared worker body.", `<active_agent name="${profile}"/>`]);
  assert.deepEqual(f.webReleases, []);
  await port.dispose();
  assert.equal(f.webReleases.length, profile === "researcher" ? 1 : 0);
});

for (const failure of ["loaderError", "assemblyError"]) test(`${failure} releases web lease after confirmed cleanup`, async t => {
  const f = fixture(t, "researcher");
  seam.state[failure] = Object.freeze(new Error("synthetic assembly failure"));
  await assert.rejects(f.create(), error => error === seam.state[failure]);
  assert.equal(f.webReleases.length, 1);
  if (failure === "loaderError") assert.equal(seam.state.assemblies.length, 0);
});

test("frozen SessionInitializationError preserves its causes and retains the web lease", async t => {
  const f = fixture(t, "researcher"), original = new Error("assembly failure"), cleanup = new Error("uncertain cleanup");
  const failure = Object.freeze(new SessionInitializationError(original, cleanup));
  seam.state.assemblyError = failure;
  await assert.rejects(f.create(), error => {
    assert.equal(error, failure); assert(error instanceof SessionInitializationError);
    assert.equal(error.code, "CHILD_INITIALIZATION_FAILED"); assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanup]); return true;
  });
  assert.deepEqual(f.webReleases, []);
});

for (const uncertain of [false, true]) test(`post-assembly validation failure ${uncertain ? "retains" : "releases"} web lease with cleanup proof`, async t => {
  const f = fixture(t, "researcher"); seam.state.badThinking = true;
  if (uncertain) seam.state.cleanupReport = { shutdownExited: false, errors: [] };
  await assert.rejects(f.create(), error => {
    if (uncertain) {
      assert(error instanceof SessionInitializationError);
      assert.match(error.cause.message, /strictly equal/);
      assert.match(error.errors[1].message, /Child cleanup incomplete/);
    } else assert.match(error.message, /strictly equal/);
    return true;
  });
  assert.equal(seam.state.cleanups, 1); assert.equal(f.webReleases.length, uncertain ? 0 : 1);
});

test("managed-block subscription follows actual SDK identity and seals on every Run exit and stop", async t => {
  const f = fixture(t), port = await f.create();
  assert.equal(seam.state.blockSubscribe, f.options.subscribeManagedBlocks);
  const deferred = Promise.withResolvers(); seam.state.onRun = () => deferred.promise;
  const feedback = [], callbacks = { managedBlock: fact => feedback.push(fact),
    alert: () => assert.fail("managed feedback must not call the child alert sink") };
  const pending = port.run("initial", callbacks, { run_id: "first" });
  assert.equal(seam.state.blockRuns[0].id, port.session_id);
  assert.equal(seam.state.blockRuns[0].callbacks, callbacks);
  seam.state.blockListener({ type: "tool_execution_start", isError: true });
  assert.equal(seam.state.blockFlushes, 0);
  seam.state.blockListener({ type: "tool_execution_end", isError: false });
  assert.equal(seam.state.blockFlushes, 1);
  assert.deepEqual(feedback, [{ toolName: "write" }]);
  await port.stop(); assert.equal(seam.state.blockEndsAtStop, 1);
  deferred.resolve(); await pending;
  assert.equal(seam.state.blockEnds, 2); assert.equal(seam.state.blockUnsubscribes, 1);
  seam.state.onRun = () => { throw new Error("synthetic Run failure"); };
  await assert.rejects(port.run("follow-up", {}, { run_id: "second" }), /synthetic Run failure/);
  assert.equal(seam.state.blockRuns[1].id, port.session_id);
  assert.equal(seam.state.blockEnds, 3); assert.equal(seam.state.blockUnsubscribes, 2);
  await port.dispose(); assert.equal(seam.state.blockEnds, 4);
});

test("mismatched SDK execution ID fails assembly and cleans before revocation", async t => {
  const f = fixture(t, "researcher"); seam.state.sessionIdOverride = "unexpected-sdk-session";
  await assert.rejects(f.create(), /Child session identity changed/);
  assert.equal(seam.state.cleanups, 1); assert.equal(f.webReleases.length, 1);
});

for (const rejected of [false, true]) test(`uncertain ${rejected ? "rejected" : "reported"} disposal retains web lease`, async t => {
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
