// Synthetic factory/assembly boundaries with the real pinned SDK SessionManager.
// No authority, model, credentials, web IO, or generated build is exercised here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const seamUrl = dataModule(`
import { createHash } from "node:crypto";
export { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
export const state = {};
export class SessionInitializationError extends Error {}
export const digest = (text) => createHash("sha256").update(text).digest("hex");
export const createEventBus = () => ({});
export const createAgentSession = () => {};
export const requireReadiness = () => {};
export const createChildTools = () => [];
export const webProfileNames = ["researcher"];
export const childWebExtension = (factory) => factory;
export const orderFreeToolSchemaExtension = () => {};
export class ChildRunGate { extension = () => {}; }
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
    getActiveToolNames: () => [...input.options.tools] } };
};
export const disposeChildSession = async () => {
  state.cleanups++;
  if (state.cleanupError) throw state.cleanupError;
  return state.cleanupReport;
};
export class PiAgentSessionAdapter {
  constructor(options) { this.session_id = options.session.sessionId; this.history = options.history; }
  async run(prompt) { state.runs.push(prompt); return { kind: "success" }; }
  canInput() { return false; }
  async steer() { return false; }
  async stop() {}
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

function fixture(t, profile = "reader") {
  const directory = mkdtempSync(join(tmpdir(), "harness-child-factory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const key of Object.keys(seam.state)) delete seam.state[key];
  Object.assign(seam.state, { loaders: [], prompts: [], assemblies: [], runs: [], cleanups: 0,
    cleanupReport: { shutdownExited: true, errors: [] } });
  const scratchCalls = [], releases = [], webReleases = [], approvals = [];
  const definition = `${profile} synthetic definition`, tools = ["read", "alert_parent", "ask_parent"];
  if (profile === "reader") tools.push("write");
  const agent = { agent_id: "model-unrelated-agent-id", name: "synthetic", settings: {
    profile, cwd: directory, definition_digest: seam.digest(definition), tools,
    provider: "synthetic", model: "synthetic", thinking: "off",
  } };
  const model = { provider: "synthetic", id: "synthetic" };
  const options = {
    ctx: { cwd: directory, sessionManager: { getSessionDir: () => directory,
      getSessionFile: () => join(directory, "parent.jsonl") } },
    parentBus: {}, agentDir: directory, permissionRoot: directory, policyRoot: directory, parentId: "parent",
    runtime: { getModel: () => model, getPhysicalModel: () => model },
    profiles: { [profile]: { definition, body: "Shared worker body.", tools } }, settings: () => ({}),
    parentHistory: {}, parentPermission: () => ({}), getPermissionsService: () => undefined,
    approvalBindings: { childExtension: (id) => { approvals.push(id); return () => {}; }, begin() {}, end() {} },
    activities: { track: () => ({ extension() {}, begin() {} }) },
    createReaderScratch: (id) => {
      scratchCalls.push(id);
      const scratch = `/tmp/pi-alehouse-reader-synthetic-${scratchCalls.length}`;
      return { directory: scratch, release: () => releases.push(scratch) };
    },
    web: { acquire: async () => ({ factory() {}, release: () => webReleases.push("released") }) },
  };
  return { agent, options, scratchCalls, releases, webReleases, approvals,
    create: () => createChildSessionFactory(options)(agent) };
}

test("reader binds scratch to the real SDK manager ID and appends only the dynamic instruction", async (t) => {
  const f = fixture(t), port = await f.create();
  const manager = seam.state.assemblies[0].options.sessionManager;
  assert.equal(f.scratchCalls[0], manager.getSessionId());
  assert.equal(port.session_id, manager.getSessionId());
  assert.notEqual(port.session_id, f.agent.agent_id);
  assert.notEqual(port.session_id, f.options.parentId);
  assert.deepEqual(f.approvals, [port.session_id], "approval identity remains unchanged");
  assert.deepEqual(seam.state.prompts[0], ["Shared worker body.", '<active_agent name="reader"/>',
    "Scratch directory: /tmp/pi-alehouse-reader-synthetic-1"]);
  assert.equal(seam.state.assemblies[0].options.cwd, f.agent.settings.cwd, "scratch never becomes project cwd");
  await port.run("initial", {}, { run_id: "first" });
  await port.run("follow-up", {}, { run_id: "second" });
  assert.deepEqual(seam.state.runs, ["initial", "follow-up"]);
  assert.equal(f.scratchCalls.length, 1, "reuse does not allocate or revoke scratch");
  assert.deepEqual(f.releases, []);
  const disposal = Promise.withResolvers();
  seam.state.disposal = disposal.promise;
  const pending = port.dispose();
  assert.deepEqual(f.releases, [], "dispose attempt alone is not exit proof");
  disposal.resolve({ shutdownExited: true, errors: [] });
  await pending;
  assert.equal(f.releases.length, 1);
});

test("separate reader sessions allocate against distinct SDK IDs", async (t) => {
  const f = fixture(t), create = createChildSessionFactory(f.options);
  const first = await create(f.agent), second = await create(f.agent);
  assert.notEqual(first.session_id, second.session_id);
  assert.deepEqual(f.scratchCalls, [first.session_id, second.session_id]);
  assert.notEqual(seam.state.prompts[0][2], seam.state.prompts[1][2]);
  await first.dispose();
  assert.deepEqual(f.releases, ["/tmp/pi-alehouse-reader-synthetic-1"]);
  await second.dispose();
  assert.deepEqual(f.releases, ["/tmp/pi-alehouse-reader-synthetic-1", "/tmp/pi-alehouse-reader-synthetic-2"]);
});

test("reader capability is mandatory and failure creates no loader or session", async (t) => {
  const f = fixture(t);
  delete f.options.createReaderScratch;
  await assert.rejects(f.create(), /Reader scratch access is unavailable/);
  assert.equal(seam.state.loaders.length, 0);
  assert.equal(seam.state.assemblies.length, 0);
});

for (const profile of ["editor", "researcher"]) test(`${profile} allocates no scratch and preserves web lifecycle`, async (t) => {
  const f = fixture(t, profile);
  delete f.options.createReaderScratch;
  const port = await f.create();
  assert.deepEqual(f.scratchCalls, []);
  assert.deepEqual(seam.state.prompts[0], ["Shared worker body.", `<active_agent name="${profile}"/>`]);
  assert.deepEqual(f.webReleases, []);
  await port.dispose();
  assert.deepEqual(f.releases, []);
  assert.equal(f.webReleases.length, profile === "researcher" ? 1 : 0);
});

for (const failure of ["loaderError", "assemblyError"]) test(`${failure} before execution or after confirmed assembly cleanup releases scratch`, async (t) => {
  const f = fixture(t);
  seam.state[failure] = new Error("synthetic assembly failure");
  await assert.rejects(f.create(), /synthetic assembly failure/);
  assert.equal(f.scratchCalls.length, 1);
  assert.equal(f.releases.length, 1);
  if (failure === "loaderError") assert.equal(seam.state.assemblies.length, 0);
});

test("SessionInitializationError retains scratch on uncertain assembly cleanup", async (t) => {
  const f = fixture(t);
  seam.state.assemblyError = new seam.SessionInitializationError("uncertain assembly");
  await assert.rejects(f.create(), seam.SessionInitializationError);
  assert.deepEqual(f.releases, []);
});

for (const uncertain of [false, true]) test(`post-assembly validation failure ${uncertain ? "retains" : "releases"} scratch with cleanup proof`, async (t) => {
  const f = fixture(t);
  seam.state.badThinking = true;
  if (uncertain) seam.state.cleanupReport = { shutdownExited: false, errors: [] };
  await assert.rejects(f.create(), uncertain ? seam.SessionInitializationError : /strictly equal/);
  assert.equal(seam.state.cleanups, 1);
  assert.equal(f.releases.length, uncertain ? 0 : 1);
});

test("mismatched SDK execution ID fails assembly and cleans before revocation", async (t) => {
  const f = fixture(t);
  seam.state.sessionIdOverride = "unexpected-sdk-session";
  await assert.rejects(f.create(), /Child session identity changed/);
  assert.equal(seam.state.cleanups, 1);
  assert.equal(f.releases.length, 1);
});

for (const rejected of [false, true]) test(`uncertain ${rejected ? "rejected" : "reported"} disposal retains scratch`, async (t) => {
  const f = fixture(t), port = await f.create();
  if (rejected) {
    seam.state.disposeError = new Error("synthetic disposal rejection");
    await assert.rejects(port.dispose(), /synthetic disposal rejection/);
  } else {
    seam.state.cleanupReport = { shutdownExited: false, errors: ["synthetic uncertainty"] };
    assert.equal((await port.dispose()).shutdownExited, false);
  }
  assert.deepEqual(f.releases, []);
});
