// Real installed SDK runtime + permission/guard + Controller. Controlled IO only.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { assembleChildSession as assembleChild } from "../../dist/runtime/child-session.js";
import { ownerSessionReplacementGuard } from "../../dist/runtime/owner-lifecycle.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { loadHost, controlledProvider } from "../support/host.mjs";

const [piExecutable, generatedRoot, outputRoot] = process.argv.slice(2);
assert(outputRoot, "Use script/check-pi-harness.sh");
const root = join(outputRoot, "session-replacement"); mkdirSync(root, { mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = resolve(generatedRoot);
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
const { sdk, ai, permission, permissionEntry, authority, versions } = await loadHost(piExecutable);
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
const provider = controlledProvider(ai); modelRuntime.registerProvider("harness-fixture", provider.config);
const model = modelRuntime.getModel("harness-fixture", "controlled"); assert(model);
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const permissionPath = permissionEntry, guardPath = join(generatedRoot, "extensions/static-safety-guard.ts");
const definition = readFileSync(join(generatedRoot, "agents/reader.md"), "utf8"), definitionDigest = digest(definition);
const effective = { provider: model.provider, model: model.id, thinking: "off", parent_thinking: "off",
  thinking_resolution: "identity", profile: "reader",
  difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64), cwd: root,
  tools: ["notify_parent"], definition_digest: definitionDigest };
const childInit = Promise.withResolvers(), initEntered = Promise.withResolvers(), childHold = Promise.withResolvers();
const childEntered = Promise.withResolvers(), parentEntered = Promise.withResolvers();
const children = [], owners = [], events = [], claims = [], replacementNotices = [], confirmations = [];
let hosted, runtimeHost, notifySent = false, confirmReplacement = async () => false;
const replacementUI = {
  select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
  confirm: async (...args) => { confirmations.push(args); return confirmReplacement(...args); },
  notify: (message, level) => replacementNotices.push({ message, level }), setStatus() {}, setWidget() {}, setFooter() {}, setTitle() {},
};
const bind = (session) => session.bindExtensions({ mode: "tui", uiContext: replacementUI });
const report = { authority, versions, claims, events, limitations: [
  "Controlled provider, not a real-model or real Codex WebSocket test",
  "Actual SDK runtime routes, not new/resume/fork/import PTY pixel-preservation acceptance",
  "Pi 0.87.1 reload remains unguarded; runtime.dispose/tree/general input races are not protected",
  "The confirmation/drain latch does not serialize downstream SDK replacement; wait for one operation to finish before another",
  "Each replacement parent gets a fresh immutable owner/guard; this is not production wiring",
] };
const save = () => writeFileSync(join(outputRoot, "session-replacement.json"), JSON.stringify(report, null, 2));
const until = async (check) => {
  const deadline = performance.now() + 10000;
  while (!check()) { assert(performance.now() < deadline, "fixture timed out"); await new Promise((r) => setImmediate(r)); }
};
provider.respond(async ({ context, signal }) => {
  const last = context.messages.findLast((m) => m.role === "user");
  const text = typeof last?.content === "string" ? last.content : last?.content?.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
  if (text.includes("HOLD_PARENT")) {
    parentEntered.resolve(signal);
    return new Promise((resolve) => {
      const abort = () => resolve({ text: "parent aborted after admission", reason: "aborted" });
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  }
  if (text.includes("NOTIFY_AND_HOLD_CHILD")) {
    if (!notifySent) { notifySent = true; return { tools: [{ type: "toolCall", id: "notify-before-wait", name: "notify_parent", arguments: { message: "REAL_SDK_NOTIFY_BEFORE_WAIT" } }] }; }
    childEntered.resolve(signal); await childHold.promise; // Deliberately non-cooperative provider until released.
    return { text: "child exited", reason: signal.aborted ? "aborted" : "stop" };
  }
  return { text: "synthetic seed" };
});
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const parentBus = sdk.createEventBus(); let parent;
  const owner = await ExecutionOwner.open({ directory: join(root, "owners"), owner_id: sessionManager.getSessionId(), flock: process.env.P0_FLOCK });
  const controller = await Controller.open({ owner, concurrency: 1, createSession: async () => {
    initEntered.resolve(); await childInit.promise;
    const bus = sdk.createEventBus(), gate = new RunInputGate(); let callbacks;
    const customTools = [sdk.defineTool({ name: "notify_parent", label: "notify", description: "Synthetic notification, not authorization",
      parameters: ai.Type.Object({ message: ai.Type.String() }), execute: async (_id, { message }) => {
        assert(callbacks && gate.accepting); callbacks.notify(message);
        return { content: [{ type: "text", text: "recorded" }], details: {} };
      } })];
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: bus,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [permissionPath, guardPath], extensionFactories: [gate.extension] });
    await loader.reload(); const sm = sdk.SessionManager.inMemory(cwd);
    sm.appendCustomEntry("active_agent", { name: effective.profile });
    const assembled = await assembleChild({ createSession: sdk.createAgentSession, options: { cwd, agentDir: generatedRoot,
      resourceLoader: loader, settingsManager: settings(), sessionManager: sm, modelRuntime, model, tools: effective.tools, customTools },
      parentBus, childBus: bus, parentSessionId: parent.sessionId, profile: effective.profile, definitionDigest,
      getPermissionsService: permission.getPermissionsService });
    const port = new SdkRunPort({ session: assembled.session, parentBus, gate,
      readiness: () => requireReadiness(bus, permission.getPermissionsService, assembled.session.sessionId, effective.profile, definitionDigest) });
    children.push(assembled.session);
    return { session_id: port.session_id, canInput: () => port.canInput(), stop: () => port.stop(),
      steer: (message, valid) => port.steer(message, valid), clearInputs: () => port.clearInputs(), dispose: () => port.dispose(),
      run: async (prompt, cb) => { callbacks = cb; try { return await port.run(prompt, cb); } finally { callbacks = undefined; } } };
  } });
  owners.push(controller);
  const services = await sdk.createAgentSessionServices({ cwd, agentDir: generatedRoot, modelRuntime, settingsManager: settings(),
    resourceLoaderOptions: { eventBus: parentBus, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [permissionPath], extensionFactories: [(pi) => {
        for (const name of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) pi.on(name, (e) => { events.push({ ...e, session_id: sessionManager.getSessionId() }); });
      }, ownerSessionReplacementGuard(controller)] } });
  const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] });
  parent = result.session; hosted = { controller, parentBus, parent };
  return { ...result, services, diagnostics: services.diagnostics };
};
try {
  runtimeHost = await sdk.createAgentSessionRuntime(createRuntime, { cwd: root, agentDir: generatedRoot, sessionManager: sdk.SessionManager.create(root) });
  await bind(runtimeHost.session); runtimeHost.setRebindSession(bind);

  // A never-used Owner can be synchronously sealed before the guard's first
  // await, then replaced through the real runtime with fresh authority/lease.
  const unused = runtimeHost.session, unusedController = hosted.controller;
  const unusedService = permission.getPermissionsService(unused.sessionId); assert(unusedService);
  assert.equal((await runtimeHost.newSession()).cancelled, false);
  assert.equal(unusedController.stats().closed, true);
  assert.notEqual(runtimeHost.session, unused); assert.equal(permission.getPermissionsService(unused.sessionId), undefined);
  const initialReplacementService = permission.getPermissionsService(runtimeHost.session.sessionId);
  assert(initialReplacementService); assert.notEqual(initialReplacementService, unusedService);
  assert.equal(hosted.controller.stats().closed, false);
  claims.push("fresh unused Owner auto-closes before replacement and receives fresh authority/owner state");

  const original = runtimeHost.session, runner = original.extensionRunner, controller = hosted.controller;
  const tree = await original.extensionRunner.emit({ type: "session_before_tree" });
  assert.equal(tree?.cancel, true); assert.equal(controller.stats().closed, false);
  assert.match(replacementNotices.at(-1)?.message ?? "", /in place without creating a fresh harness Owner/);
  await original.prompt("SEED_FOR_FORK"); const target = original.sessionFile;
  const forkId = original.sessionManager.getEntries().find((e) => e.type === "message" && e.message.role === "user").id;
  const service = permission.getPermissionsService(original.sessionId); assert(service);
  const parentPrompt = original.prompt("HOLD_PARENT"); const parentSignal = await parentEntered.promise;
  const rejectAll = async (phase) => {
    const shutdowns = events.filter((e) => e.type === "session_shutdown").length;
    const confirmationsBefore = confirmations.length;
    for (const [name, operation] of [["new", () => runtimeHost.newSession()], ["resume", () => runtimeHost.switchSession(target)],
      ["fork", () => runtimeHost.fork(forkId)], ["clone", () => runtimeHost.fork(forkId, { position: "at" })],
      ["import", () => runtimeHost.importFromJsonl(target)]]) {
      assert.equal((await operation()).cancelled, true, `${phase}/${name}`);
      assert.equal(runtimeHost.session, original); assert.equal(original.extensionRunner, runner);
      assert.equal(permission.getPermissionsService(original.sessionId), service); assert.equal(parentSignal.aborted, false);
      assert.equal(events.filter((e) => e.type === "session_shutdown").length, shutdowns);
      claims.push(`${phase}/${name}: refused before teardown`);
    }
    assert.equal(confirmations.length, confirmationsBefore + 5, `${phase}: every target needs its own literal confirmation`);
    assert.equal(controller.stats().closed, false); save();
  };
  const run = await controller.submit("child", { prompt: "NOTIFY_AND_HOLD_CHILD", description: "synthetic child", settings: effective });
  await initEntered.promise;
  const queued = await controller.submit("queued", { prompt: "MUST_NOT_START", description: "queued", settings: effective });
  await rejectAll("initializing-and-queued"); childInit.resolve(); const childSignal = await childEntered.promise;
  assert.equal(controller.view(run.run_id).pending_messages, 1);
  const notification = await controller.wait([run.run_id], { mode: "all", timeout_ms: 0 });
  assert.equal(notification.reason, "timeout"); assert.equal(notification.progress, undefined);
  assert.equal(controller.view(run.run_id).pending_messages, 1);
  claims.push("real notify tool buffers progress without ending a wait or losing it on timeout");
  await rejectAll("running-and-queued"); assert.equal(childSignal.aborted, false);
  confirmReplacement = async () => undefined;
  assert.equal((await runtimeHost.newSession()).cancelled, true, "undefined confirmation never authorizes used replacement");
  confirmReplacement = async () => { throw new Error("CONFIRM_FAILURE"); };
  assert.equal((await runtimeHost.newSession()).cancelled, true, "confirmation failure never authorizes used replacement");
  assert.equal(controller.stats().closed, false); assert.equal(childSignal.aborted, false);

  // An actual confirmed guard drain times out while the child refuses to exit.
  // It must veto replacement and retain parent authority/reservations; a later
  // confirmation is a new decision, not a positive result shared from this one.
  confirmReplacement = async () => true;
  const timeoutShutdowns = events.filter((e) => e.type === "session_shutdown").length;
  assert.equal((await runtimeHost.newSession()).cancelled, true, "unconfirmed drain vetoes this replacement target");
  assert.equal(runtimeHost.session, original); assert.equal(permission.getPermissionsService(original.sessionId), service);
  assert.equal(events.filter((e) => e.type === "session_shutdown").length, timeoutShutdowns);
  assert.equal(controller.stats().closed, false); assert.equal(childSignal.aborted, true);
  assert.equal(parentSignal.aborted, false, "a timed-out child drain must not start parent teardown");
  assert.equal(controller.stats().active, 1, "the non-exited child still owns its execution slot");
  assert.equal(controller.view(run.run_id).execution_exited, false);
  assert.equal(controller.view(run.run_id).resident, true);

  // Hold the retry's real confirmation so another target is rejected rather
  // than sharing its decision. The accepted retry then drains all Owner work.
  const approval = Promise.withResolvers();
  confirmReplacement = async () => approval.promise;
  const beforeApprovedConfirm = confirmations.length, shutdowns = events.filter((e) => e.type === "session_shutdown").length;
  const approved = runtimeHost.newSession();
  await until(() => confirmations.length === beforeApprovedConfirm + 1);
  const [, warning] = confirmations.at(-1);
  assert.match(warning, /ALL this Owner's work.*including work accepted while this dialog is open/i);
  assert.match(warning, /Closure is permanent/i);
  assert.equal((await runtimeHost.fork(forkId)).cancelled, true, "concurrent target cannot share the pending confirmation");
  assert.equal(confirmations.length, beforeApprovedConfirm + 1);
  approval.resolve(true); childHold.resolve();
  assert.equal((await approved).cancelled, false); await parentPrompt;
  await until(() => controller.view(run.run_id).phase === "settled" && controller.view(queued.run_id).phase === "settled");
  const finished = await controller.wait([run.run_id], { mode: "all" });
  assert.equal(finished.progress[0].text, "REAL_SDK_NOTIFY_BEFORE_WAIT");
  assert.equal((await controller.wait([run.run_id], { mode: "all" })).progress, undefined);
  assert.equal(controller.stats().closed, true);
  assert.equal(events.filter((e) => e.type === "session_shutdown").length, shutdowns + 1);
  assert.notEqual(runtimeHost.session, original); assert.equal(permission.getPermissionsService(original.sessionId), undefined);
  const replacementService = permission.getPermissionsService(runtimeHost.session.sessionId);
  assert(replacementService); assert.notEqual(replacementService, service);
  assert.equal(hosted.controller.stats().closed, false);
  claims.push("used Owner refusal preserves authority; accepted confirmation stops/drains once; concurrent targets and timeout remain vetoed");
  await runtimeHost.session.prompt("/harness-close");
} finally {
  childInit.resolve(); childHold.resolve();
  for (const owner of owners) assert.equal((await owner.shutdown(5000)).closed, true);
  if (runtimeHost) await runtimeHost.dispose();
  for (const child of children) { assert.equal(child.isIdle, true); assert.equal(permission.getPermissionsService(child.sessionId), undefined); }
}
report.passed = true; report.children = children.length; report.providerRequests = provider.requests.length; save();
console.log(`PASS SDK session replacement: ${claims.length} checks; controlled IO, evidence-only`);
