// Actual SDK/permission assembly failures, synthetic provider only. No model/auth IO.
// The shared abort/shutdown deadline guarantees a dispatch ATTEMPT before
// disposal, not handler entry: an exhausted abort budget permits late handlers.
// Only settled shutdown cases can require handler entry before disposal.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { controlledProvider, loadHost } from "../support/host.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, generatedRoot, outputRoot] = process.argv.slice(2);
assert(piExecutable && generatedRoot && outputRoot, "Use script/check-pi-harness.sh");
const { sdk, ai, permission, permissionEntry, authority, versions } = await loadHost(piExecutable);
const report = { authority, versions, release: releaseDecision, cases: [], limitations: [
  "Real SDK/permission with synthetic provider; no real model, production consumer, Luna or backend switch",
  "Faulty session_start deliberately starts SDK work before bind fails; harness never returns a SessionPort",
  "Shutdown dispatch attempted is not proof that every handler ran or arbitrary extension work exited",
  "Uncertain owners keep their lock until this isolated process exits; no force-unlock or late close certificate",
] };
const save = () => writeFileSync(join(outputRoot, "initialization-cleanup.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
const provider = controlledProvider(ai); runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled"); assert(model);
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const permissionPath = permissionEntry, guardPath = join(generatedRoot, "extensions/static-safety-guard.ts");
const definitionDigest = digest(readFileSync(join(generatedRoot, "agents/reader.md"), "utf8"));

for (const mode of ["cooperative", "abort-timeout", "shutdown-error"]) {
  const cwd = join(outputRoot, `initialization-${mode}`); mkdirSync(cwd, { mode: 0o700 });
  const data = { mode, events: [], abortCalls: 0, disposeCalls: 0, providerAbortObserved: false, promptExited: false };
  report.cases.push(data); save();
  const loaderFor = async (eventBus, extra = {}) => {
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [permissionPath], ...extra });
    await loader.reload(); return loader;
  };
  const parentBus = sdk.createEventBus();
  const { session: parent } = await sdk.createAgentSession({ cwd, agentDir: generatedRoot, resourceLoader: await loaderFor(parentBus),
    settingsManager: settings(), sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model, tools: [] });
  await parent.bindExtensions({}); assert(permission.getPermissionsService(parent.sessionId));
  const ownerOptions = { directory: join(outputRoot, "initialization-owners"), owner_id: parent.sessionId, flock: process.env.P0_FLOCK };
  const owner = await ExecutionOwner.open(ownerOptions), hold = Promise.withResolvers();
  let child, childPrompt;
  parentBus.on("subagents:child:disposed", ({ sessionId, cleanup }) => {
    if (sessionId === child?.sessionId) data.cleanup = cleanup;
  });
  const beforeRequests = provider.requests.length;
  provider.respond(async ({ signal }) => {
    data.events.push("provider-entered");
    const abort = () => { data.providerAbortObserved = true; if (mode !== "abort-timeout") hold.resolve(); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    await hold.promise; signal.removeEventListener("abort", abort);
    return { text: "synthetic initialization work stopped", reason: "aborted" };
  });
  const controller = await Controller.open({ owner, createSession: async () => {
    const bus = sdk.createEventBus();
    const loader = await loaderFor(bus, { additionalExtensionPaths: [permissionPath, guardPath], extensionFactories: [(pi) => {
      pi.on("session_start", async () => {
        // Observe the actual bound child's public dispatch boundary, without
        // replacing its asynchronous handler scheduling or completion semantics.
        const runner = child.extensionRunner, emit = runner.emit.bind(runner);
        runner.emit = (...args) => {
          if (args[0].type === "session_shutdown") data.events.push("shutdown-dispatch-attempt");
          return emit(...args);
        };
        const requested = provider.requested();
        childPrompt = child.prompt("SYNTHETIC_WORK_STARTED_BY_BROKEN_INITIALIZER", { source: "extension" }).then(
          () => { data.promptExited = true; }, (error) => { data.promptExited = true; data.promptError = String(error); });
        await requested;
        data.nonIdleAtBindFailure = !child.isIdle;
        throw new Error("BIND_FAILED_AFTER_STARTING_WORK");
      });
      pi.on("session_shutdown", () => {
        data.events.push("shutdown-handler-entered");
        if (mode === "shutdown-error") throw new Error("SYNTHETIC_SHUTDOWN_HANDLER_ERROR");
      });
    }] });
    const manager = sdk.SessionManager.inMemory(cwd); manager.appendCustomEntry("active_agent", { name: "reader" });
    await assembleChild({ createSession: async (options) => {
      const result = await sdk.createAgentSession(options); child = result.session;
      const abort = child.abort.bind(child), dispose = child.dispose.bind(child);
      child.abort = () => { data.abortCalls++; data.events.push("abort-called"); return abort(); };
      child.dispose = () => { data.disposeCalls++; data.events.push("dispose-called"); dispose(); };
      return result;
    }, options: { cwd, agentDir: generatedRoot, resourceLoader: loader, settingsManager: settings(), sessionManager: manager,
      modelRuntime: runtime, model, tools: [] }, parentBus, childBus: bus, parentSessionId: parent.sessionId,
    profile: "reader", definitionDigest, getPermissionsService: permission.getPermissionsService,
    shutdownTimeoutMs: mode === "abort-timeout" ? 40 : 1000 });
    assert.fail("failed assembly returned a port");
  } });
  try {
    const run = await controller.submit(mode, { prompt: "HARNESS_PROMPT_MUST_NOT_EXECUTE", description: mode,
      settings: { provider: model.provider, model: model.id, thinking: "off", parent_thinking: "off",
        thinking_resolution: "identity", profile: "reader",
        difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64),
        cwd, tools: [], definition_digest: definitionDigest } });
    let result = await controller.wait([run.run_id], { mode: "all", timeout_ms: 10000 });
    if (result.reason === "owner_blocked") result = await controller.wait([run.run_id], { mode: "all", timeout_ms: 10000 });
    assert.equal(result.reason, "condition"); data.run = result.snapshots[0];
    assert.equal(data.run.status, "failed"); assert.match(data.run.outcome.error, /BIND_FAILED_AFTER_STARTING_WORK/);
    assert.equal(data.nonIdleAtBindFailure, true); assert.equal(data.abortCalls, 1); assert.equal(data.disposeCalls, 1);
    assert.equal(data.providerAbortObserved, true); assert.equal(provider.requests.length - beforeRequests, 1);
    assert.equal(data.events.filter((event) => event === "shutdown-dispatch-attempt").length, 1);
    assert(data.events.indexOf("abort-called") < data.events.indexOf("shutdown-dispatch-attempt"));
    assert(data.events.indexOf("shutdown-dispatch-attempt") < data.events.indexOf("dispose-called"));
    if (mode !== "abort-timeout") {
      assert(data.events.indexOf("shutdown-dispatch-attempt") < data.events.indexOf("shutdown-handler-entered"));
      assert(data.events.indexOf("shutdown-handler-entered") < data.events.indexOf("dispose-called"));
    }
    assert.equal(data.cleanup.disposed, true);
    data.atCleanup = { promptExited: data.promptExited, sessionIdle: child.isIdle };
    const uncertain = mode !== "cooperative";
    assert.equal(controller.stats().cleanup_uncertain, uncertain);
    assert.equal(controller.stats().resident, uncertain ? 1 : 0);
    if (mode === "abort-timeout") {
      assert.equal(data.promptExited, false); assert.equal(child.isIdle, false);
      assert.equal(data.cleanup.shutdownExited, false); assert(data.cleanup.errors.includes("CHILD_ABORT_TIMEOUT"));
    } else {
      assert.equal(data.promptExited, true); assert.equal(child.isIdle, true);
      assert.equal(data.cleanup.shutdownExited, true);
      assert.equal(permission.getPermissionsService(child.sessionId), undefined);
      if (mode === "shutdown-error") assert(data.cleanup.errors.some((s) => s.includes("SYNTHETIC_SHUTDOWN_HANDLER_ERROR")));
      else assert.deepEqual(data.cleanup.errors, []);
    }
    if (uncertain) {
      await assert.rejects(controller.submit("blocked", { resume: run.agent_id, prompt: "MUST_NOT_START" }), { code: "OWNER_CLEANUP_UNCERTAIN" });
      assert.equal((await controller.shutdown(50)).closed, false);
      await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
      hold.resolve(); await childPrompt;
      assert.equal((await controller.shutdown(50)).closed, false, "late idle is not a cleanup certificate");
    } else assert.equal((await controller.shutdown()).closed, true);
    data.finalStats = controller.stats();
  } finally {
    hold.resolve(); await childPrompt;
    await controller.shutdown(1000);
    const parentCleanup = await disposeChild(parent, parentBus);
    save();
    assert.equal(parentCleanup.shutdownExited, true); assert.deepEqual(parentCleanup.errors, []);
  }
  // Persist only the child report; parent disposal must not replace its fault.
  if (mode === "abort-timeout") assert.equal(data.cleanup.shutdownExited, false);
  if (mode === "shutdown-error") assert(data.cleanup.errors.some((s) => s.includes("SYNTHETIC_SHUTDOWN_HANDLER_ERROR")));
  data.passed = true; save();
}
console.log("CHECKED: real non-idle failed initialization abort/drain/dispose and swallowed shutdown errors; evidence-only");
