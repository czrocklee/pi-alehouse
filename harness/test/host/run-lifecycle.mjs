import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { SessionInitializationError } from "../../dist/core/ports.js";
import { PiRunJournal as SdkRunHistory, historyTypes } from "../../dist/history/run-journal.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { abortAndWaitForIdle, controlledProvider, loadHost } from "../support/host.mjs";
import { pollStep, restoreFaultedLogs } from "../support/run-lifecycle-support.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, generatedRoot, outputRoot, scenario] = process.argv.slice(2);
const initializationFailure = scenario === "--initialization-failure";
const naturalFinish = scenario === "--natural-finish-steer";
const boundaryKind = ["initial", "steer", "soft-budget"].find((kind) => scenario === `--post-guard-${kind}`);
assert(scenario === undefined || initializationFailure || naturalFinish || boundaryKind, "Unknown P1 scenario");
assert(piExecutable && generatedRoot && outputRoot, "Use script/check-pi-harness.sh");
process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = resolve(generatedRoot);
const host = await loadHost(piExecutable), { sdk, ai, permission } = host;
const report = { authority: host.authority, versions: host.versions, claims: [], events: [], runs: [], readiness: [], limitations: [
  "Isolated P1 only; controlled provider is NOT a real-model usability trial",
  "No production tools, owner service handles, Luna binding, reload admission, or backend switch",
  "Last input guard is NOT atomic with SDK enqueue; post-guard cases expect a crossing, not atomic rejection",
  "Initial before_agent_start and cleanup holds are artificial extension/adapter delays; steer/soft-budget injection adds no await to the synchronous guard",
  ...(naturalFinish ? ["Finite agent_end caller scheduling points only; no probability, exhaustive scheduling, remote-provider, or future-SDK claim"] :
    ["No claim about natural root-finish versus steer scheduling, remote cancellation, or absence of every possible provider crossing"]),
  "No complete H01-H22 row is claimed by this fixture",
] };
const save = () => writeFileSync(join(outputRoot, initializationFailure ? "p1-initialization.json" : naturalFinish ? "p1-natural-finish.json" :
  boundaryKind ? `p1-post-guard-${boundaryKind}.json` : "p1-sdk.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const record = (name, detail) => { report.claims.push({ name, detail }); console.log(`PASS P1: ${name}`); save(); };
report.capabilities = host.capabilities;
report.release = releaseDecision;
const parentCwd = join(outputRoot, "p1-parent"), cwd = join(outputRoot, "p1-child");
const sessionDirectory = join(outputRoot, "p1-sdk-sessions");
for (const path of [parentCwd, cwd, sessionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(cwd, "AGENTS.md"), "P1_CHILD_CONTEXT_MARKER\n");
const permissionPath = host.permissionEntry, guardPath = join(generatedRoot, "extensions/static-safety-guard.ts");
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false },
  retry: naturalFinish ? { enabled: false } : { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
const provider = controlledProvider(ai); runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled"); assert(model);
const parentBus = sdk.createEventBus();
const parentLoader = new sdk.DefaultResourceLoader({ cwd: parentCwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: parentBus,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [permissionPath] });
await parentLoader.reload();
const { session: parent } = await sdk.createAgentSession({ cwd: parentCwd, agentDir: generatedRoot, resourceLoader: parentLoader,
  settingsManager: settings(), sessionManager: sdk.SessionManager.create(parentCwd, sessionDirectory), modelRuntime: runtime, model, tools: [] });
await parent.bindExtensions({}); assert(permission.getPermissionsService(parent.sessionId));
// A real controlled SDK assistant, not a forged log entry or force-flush API.
if (!initializationFailure) { await parent.prompt("Initialize synthetic parent history", { source: "extension" }); await parent.waitForIdle(); }
// Lifecycle probes execute a controlled Node script. Its operand has unknown
// file effects, so it needs editor rather than overriding a reader write deny.
const definitionPath = join(generatedRoot, "agents/editor.md");
const definition = readFileSync(definitionPath, "utf8"), definitionDigest = digest(definition);
const tools = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
const effective = { provider: model.provider, model: model.id, thinking: "off", parent_thinking: "off",
  thinking_resolution: "identity", profile: "editor",
  difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "1".repeat(64), cwd,
  tools, definition_digest: definitionDigest };
const ports = [];
const gatesToRelease = [];
const deferred = () => { const d = Promise.withResolvers(); gatesToRelease.push(d); return d; };
let inputHold, inputReached, bashReached;
const cleanupHold = deferred(); let failedCleanupExited = false;
let failReadinessSession, cleanupTarget, peerCleanupHold, peerCleanupEntered;
let faultFile, parentFaultFile, firstRunId, faultRunId;
const boundary = boundaryKind ? { kind: boundaryKind, trace: [], target: `POST_GUARD_${boundaryKind}`, fired: false,
  beforeStart: deferred(), releaseStart: deferred(), cleanupEntered: deferred(), releaseCleanup: deferred(),
  rootEntered: deferred(), releaseRoot: deferred(), sdkReturned: deferred() } : undefined;
const natural = naturalFinish ? { depths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16], cases: [], byAgent: new Map(), byRun: new Map(), pending: undefined } : undefined;
function observeNatural(item, event, detail = {}) {
  item.trace.push({ order: item.trace.length, event, ...detail });
}
function scheduleNatural(depth, action) {
  if (depth === 0) action();
  else queueMicrotask(() => scheduleNatural(depth - 1, action));
}
function observeBoundary(event, detail = {}) {
  if (!boundary) return;
  boundary.trace.push({ order: boundary.trace.length, event, ...detail });
}
if (natural) report.natural_finish = { scheduling: "session_agent_end_with_finite_caller_microtask_offsets",
  trigger: "first normal-stop session agent_end", artificial_holds: [], cases: natural.cases };
if (boundary) report.boundary = { kind: boundaryKind,
  injection: boundaryKind === "initial" ? "existing_async_before_agent_start" : "microtask_after_synchronous_guard_result",
  artificial_holds: [...(boundaryKind === "initial" ? ["before_agent_start"] : boundaryKind === "steer" ? ["root_provider_until_queue_observed"] : []), "adapter_cleanup_entry"],
  trace: boundary.trace };
async function boundaryWait(promise, phase) {
  report.boundary.phase = phase; save();
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`POST_GUARD_TIMEOUT: ${phase}`)), 10000);
  })]); } finally { clearTimeout(timer); }
}
const ownerOptions = { directory: join(outputRoot, "p1-owners"), owner_id: parent.sessionId, flock: process.env.P0_FLOCK };
const owner = await ExecutionOwner.open(ownerOptions);
const controller = await Controller.open({ owner, concurrency: 1,
  onContextChange: (event) => {
    if (natural) {
      if (event.kind === "submit" && natural.pending) {
        natural.pending.run_id = event.run_id; natural.pending.agent_id = event.agent_id;
        natural.byAgent.set(event.agent_id, natural.pending); natural.byRun.set(event.run_id, natural.pending);
      }
      const item = natural.byRun.get(event.run_id);
      if (item) observeNatural(item, `controller_${event.kind}`, { run_id: event.run_id });
    }
    if (!boundary || boundary.done) return;
    if (event.kind === "submit" && !boundary.runId) boundary.runId = event.run_id;
    observeBoundary(`controller_${event.kind}`, { run_id: event.run_id });
  },
  createSession: async (agent) => {
  assert.equal(digest(readFileSync(definitionPath, "utf8")), agent.settings.definition_digest, "queued definition drift");
  const bus = sdk.createEventBus(), gate = new RunInputGate();
  const naturalCase = natural?.byAgent.get(agent.agent_id);
  const probed = boundary && !boundary.done;
  if (probed) boundary.gate = gate;
  if (naturalCase) Object.defineProperty(naturalCase, "gate", { value: gate });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: bus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [permissionPath, guardPath], systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [definition.split(/^---\s*$/m).slice(2).join("\n").trim(), '<active_agent name="editor"/>'],
    extensionFactories: [(pi) => {
      if (initializationFailure) {
        pi.on("session_start", () => { throw new Error("BIND_FAILED_BEFORE_PORT_RETURNED"); });
        pi.on("session_shutdown", async () => { await cleanupHold.promise; failedCleanupExited = true; });
      }
      pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.sessionManager.getSessionId() === cleanupTarget) { peerCleanupEntered.resolve(); await peerCleanupHold.promise; }
      });
      if (probed && boundaryKind === "initial") pi.on("before_agent_start", async () => {
        observeBoundary("before_agent_start_held"); boundary.beforeStart.resolve();
        await boundary.releaseStart.promise;
        observeBoundary("before_agent_start_released");
      });
      // The natural-finish probe must not add an async input handler: even an
      // immediately resolved Promise would create a test-only scheduling edge.
      if (!naturalCase) pi.on("input", async (event) => {
        if (event.text.includes("HELD_OLD_INPUT")) { inputReached.resolve(); await inputHold.promise; }
        return { action: "continue" };
      });
      // Competing earlier decision, so "the gate loads last" is load-bearing in
      // this fixture rather than merely conventional: cache_warming_decision is
      // last-writer-wins, so this would win if the gate were not final.
      if (!naturalCase) pi.on("cache_warming_decision", () => ({ action: "warm" }));
    }, (pi) => gate.extension({ ...pi, on: (name, handler) => pi.on(name, name !== "input" ? handler : (...args) => {
      // Call the actual last guard and return its synchronous result unchanged.
      // Cancellation runs at the SDK's existing await of that result, not an
      // invented await/latch between guard and enqueue.
      const result = handler(...args);
      if (probed && !boundary.fired && result?.action === "transform" && result.text === boundary.target) {
        assert.equal(typeof result.then, "undefined"); boundary.fired = true;
        observeBoundary("guard_passed", { accepting: gate.accepting, stopped: gate.stopped });
        if (boundaryKind !== "initial") queueMicrotask(() => {
          controller.cancel(boundary.runId); observeBoundary("cancel_requested");
        });
      }
      if (naturalCase && result?.action === "transform" && result.text === naturalCase.target) {
        assert.equal(typeof result.then, "undefined"); naturalCase.guard_passed = true;
        observeNatural(naturalCase, "guard_passed", { accepting: gate.accepting, stopped: gate.stopped,
          sdk_session_streaming: naturalCase.session.isStreaming,
          core_agent_streaming: naturalCase.session.agent.state.isStreaming });
      }
      return result;
    }) })],
  });
  await loader.reload();
  if (naturalCase) {
    naturalCase.handler_counts = Object.fromEntries(["input", "before_agent_start", "agent_end", "agent_settled", "cache_warming_decision"].map((name) =>
      [name, loader.getExtensions().extensions.reduce((count, extension) => count + (extension.handlers.get(name)?.length ?? 0), 0)]));
    assert.deepEqual(naturalCase.handler_counts, { input: 3, before_agent_start: 1, agent_end: 0, agent_settled: 0, cache_warming_decision: 1 },
      "Review handler topology drift; do not silently add test-only await boundaries");
  }
  const sm = sdk.SessionManager.create(cwd, sessionDirectory, { parentSession: parent.sessionFile });
  sm.appendCustomEntry("active_agent", { name: effective.profile });
  const assembled = await assembleChild({ createSession: sdk.createAgentSession,
    options: { cwd, agentDir: generatedRoot, resourceLoader: loader, settingsManager: settings(), sessionManager: sm,
      modelRuntime: runtime, model, thinkingLevel: "off", tools }, parentBus, childBus: bus, parentSessionId: parent.sessionId,
    profile: effective.profile, definitionDigest, getPermissionsService: permission.getPermissionsService,
    shutdownTimeoutMs: initializationFailure ? 40 : undefined });
  try {
  report.readiness.push(assembled.guard);
  if (probed) {
    boundary.session = assembled.session;
    const prompt = assembled.session.prompt.bind(assembled.session);
    assembled.session.prompt = (...args) => {
      const result = prompt(...args), target = args[0].endsWith(boundary.target);
      // Observe without substituting the promise or delaying its fulfillment.
      void result.then(() => {
        if (target) { observeBoundary("sdk_prompt_resolved", { view: controller.view(boundary.runId) }); boundary.sdkReturned.resolve(); }
      },
        (error) => observeBoundary("sdk_prompt_rejected", { error: String(error) }));
      return result;
    };
  }
  if (naturalCase) {
    Object.defineProperty(naturalCase, "session", { value: assembled.session });
    const runner = assembled.session.extensionRunner;
    const beforeAgentStart = runner.emitBeforeAgentStart.bind(runner);
    runner.emitBeforeAgentStart = (text, ...args) => {
      if (text === naturalCase.target) observeNatural(naturalCase, "target_before_agent_start", {
        sdk_session_streaming: assembled.session.isStreaming,
        core_agent_streaming: assembled.session.agent.state.isStreaming,
        gate_accepting: gate.accepting, gate_stopped: gate.stopped });
      return beforeAgentStart(text, ...args); // Return the original Promise; do not add an await.
    };
    const prompt = assembled.session.prompt.bind(assembled.session);
    assembled.session.prompt = (...args) => {
      const target = args[0].endsWith(naturalCase.target), result = prompt(...args);
      if (target) void result.then(() => observeNatural(naturalCase, "target_sdk_prompt_resolved", {
        sdk_session_streaming: assembled.session.isStreaming, core_agent_streaming: assembled.session.agent.state.isStreaming }),
      (error) => observeNatural(naturalCase, "target_sdk_prompt_rejected", { error: String(error) }));
      return result; // Observation never replaces or delays the SDK Promise.
    };
  }
  assembled.session.subscribe((event) => {
    report.events.push({ session_id: assembled.session.sessionId, type: event.type,
      ...(event.type === "auto_retry_end" ? { success: event.success } : {}),
      ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
      ...(event.type === "message_end" && event.message.role === "assistant" ? { stopReason: event.message.stopReason, error: event.message.errorMessage,
        text: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("").slice(0, 128) } : {}) });
    if (naturalCase?.observing) {
      if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) observeNatural(naturalCase, `sdk_${event.type}`, {
        sdk_session_streaming: assembled.session.isStreaming,
        core_agent_streaming: assembled.session.agent.state.isStreaming,
        ...(event.type === "agent_end" ? { stop_reason: event.messages.filter((message) => message.role === "assistant").at(-1)?.stopReason,
          will_retry: event.willRetry } : {}),
      });
      if (event.type === "agent_end" && !naturalCase.scheduled) {
        naturalCase.scheduled = true;
        scheduleNatural(naturalCase.depth, () => {
          observeNatural(naturalCase, "steer_caller", { sdk_session_streaming: assembled.session.isStreaming,
            core_agent_streaming: assembled.session.agent.state.isStreaming,
            gate_accepting: gate.accepting, gate_stopped: gate.stopped,
            run_status: controller.view(naturalCase.run_id).status });
          try {
            naturalCase.receipt = controller.steer(naturalCase.run_id, naturalCase.target);
            observeNatural(naturalCase, "steer_reserved", { event_id: naturalCase.receipt.event_id });
          } catch (error) {
            naturalCase.controller_error = { code: error.code, message: String(error) };
            observeNatural(naturalCase, "steer_rejected", naturalCase.controller_error);
          }
        });
      }
      if (event.type === "queue_update" && event.steering.includes(naturalCase.target)) {
        naturalCase.queue_accepted = true;
        observeNatural(naturalCase, "target_queue_accepted", { sdk_session_streaming: assembled.session.isStreaming,
          core_agent_streaming: assembled.session.agent.state.isStreaming,
          gate_accepting: gate.accepting, gate_stopped: gate.stopped });
      }
      if (["message_start", "message_end"].includes(event.type) && event.message.role === "user") {
        const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter((p) => p.type === "text").map((p) => p.text).join("");
        if (text === naturalCase.target) {
          naturalCase.user_accepted = true;
          observeNatural(naturalCase, `target_user_${event.type}`, { sdk_session_streaming: assembled.session.isStreaming,
            core_agent_streaming: assembled.session.agent.state.isStreaming,
            gate_accepting: gate.accepting, gate_stopped: gate.stopped });
        }
      }
    }
    if (probed) {
      if (event.type === "tool_execution_end") observeBoundary("sdk_tool_execution_end", { tool_call_id: event.toolCallId, is_error: event.isError });
      if (event.type === "turn_end") observeBoundary("sdk_turn_end", { stop_reason: event.message.stopReason });
      if (event.type === "queue_update" && assembled.session.getSteeringMessages().includes(boundary.target)) {
        observeBoundary("sdk_queue_accepted", { gate_accepting: gate.accepting, gate_stopped: gate.stopped });
      }
      if (["message_start", "message_end"].includes(event.type) && event.message.role === "user") {
        const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter((p) => p.type === "text").map((p) => p.text).join("");
        if (text === boundary.target) observeBoundary(`sdk_user_${event.type}`, { gate_accepting: gate.accepting, gate_stopped: gate.stopped });
      }
    }
    const match = JSON.stringify(event).match(/P1_CHILD_READY (\d+)/);
    if (match) bashReached?.resolve(Number(match[1]));
  });
  const port = new SdkRunPort({ session: assembled.session, parentBus, gate,
    history: new SdkRunHistory({ parent: parent.sessionManager, session: sm }),
    readiness: () => {
      if (assembled.session.sessionId === failReadinessSession) throw new Error("STATIC_GUARD_NOT_READY fixture lost readiness");
      requireReadiness(bus, permission.getPermissionsService, assembled.session.sessionId, effective.profile, definitionDigest);
    } });
  if (probed) {
    const stop = port.stop.bind(port), steer = port.steer.bind(port), dispose = port.dispose.bind(port);
    port.stop = () => { observeBoundary("port_stop_entered"); const result = stop(); observeBoundary("gate_closed", { accepting: gate.accepting, stopped: gate.stopped }); return result; };
    port.steer = (text, valid) => {
      if (boundaryKind === "soft-budget") {
        assert(boundary.trace.some((row) => row.event === "controller_soft_budget"));
        boundary.target = text; report.boundary.soft_budget_message = text;
      }
      return steer(text, valid);
    };
    port.dispose = async () => {
      observeBoundary("cleanup_entered", { idle: assembled.session.isIdle, uncertain: gate.uncertain });
      boundary.cleanupEntered.resolve(); await boundary.releaseCleanup.promise;
      const result = await dispose(); observeBoundary("cleanup_exited", { ...result,
        permission_removed: !permission.getPermissionsService(assembled.session.sessionId) }); return result;
    };
  }
  ports.push({ port, gate, bus, session: assembled.session }); return port;
  } catch (original) {
    // Fixture instrumentation still owns the child until the complete port is
    // returned. A changed SDK observation API must not orphan a bound child.
    try {
      await abortAndWaitForIdle(assembled.session);
      const cleanup = await disposeChild(assembled.session, parentBus);
      assert(cleanup.shutdownExited && cleanup.errors.length === 0 && !permission.getPermissionsService(assembled.session.sessionId), JSON.stringify(cleanup));
    } catch (cleanup) { throw new SessionInitializationError(original, cleanup); }
    throw original;
  }
} });
const submit = (id, prompt, resume) => controller.submit(id, resume ? { resume, prompt } : { prompt, description: prompt, name: "月兔", settings: effective });
const finish = async (run) => {
  const result = await controller.wait([run.run_id], { mode: "all", timeout_ms: 10000 });
  assert.equal(result.reason, "condition", JSON.stringify(result)); report.runs.push(result.snapshots[0]); return result;
};
const blocked = ({ signal }) => new Promise((resolve) => {
  const abort = () => resolve({ text: "synthetic partial", reason: "aborted" });
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
});

if (initializationFailure) {
  const failed = await submit("failed-init", "MUST_NOT_EXECUTE");
  const failedTick = pollStep("initialization Run settled", () => controller.view(failed.run_id));
  while (controller.view(failed.run_id).phase !== "settled") await failedTick();
  const done = await finish(failed);
  assert.equal(done.snapshots[0].status, "failed"); assert.equal(provider.requests.length, 0);
  assert.equal(controller.stats().resident, 1); assert.equal(controller.stats().cleanup_uncertain, true);
  assert.equal(failedCleanupExited, false);
  await assert.rejects(submit("blocked-init", "MUST_NOT_START"), { code: "OWNER_CLEANUP_UNCERTAIN" });
  report.shutdown = await controller.shutdown(100);
  assert.equal(report.shutdown.closed, false);
  await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
  cleanupHold.resolve();
  const cleanupTick = pollStep("failed initialization cleanup exited", () => ({ failedCleanupExited, stats: controller.stats() }));
  while (!failedCleanupExited) await cleanupTick();
  assert.equal((await controller.shutdown(100)).closed, false, "late extension return is not a controller cleanup certificate");
  record("real failed assembly without returned port retains owner lock and resident reservation", { noProviderIO: true });
  assert(permission.getPermissionsService(parent.sessionId));
  report.parent_cleanup = { skipped: "OWNER_NOT_CLOSED", permission_present: true }; save();
  // Separate synthetic process: the latch deliberately has no force-unlock API.
  // The extension has actually exited; only process exit now releases its fd.
  process.exit(0);
}

try {
  if (boundary) {
    let calls = 0;
    provider.respond(async (request) => {
      observeBoundary("provider_entered", { call: ++calls, aborted: request.signal?.aborted,
        after_cancel: boundary.trace.some((row) => row.event === "cancel_requested") });
      if (boundaryKind === "steer") { boundary.rootEntered.resolve(); await boundary.releaseRoot.promise; return { reason: "aborted", text: "held provider exited" }; }
      if (boundaryKind === "soft-budget" && calls === 1) return { tools: [{ type: "toolCall", id: "post-guard-budget-read", name: "read", arguments: { path: join(cwd, "AGENTS.md") } }] };
      return { text: "post-guard provider observed", reason: request.signal?.aborted ? "aborted" : "stop" };
    });
    const run = await controller.submit("post-guard", { prompt: boundaryKind === "initial" ? boundary.target : "POST_GUARD_ROOT",
      name: "月兔", description: `Post-guard ${boundaryKind}`, settings: effective, ...(boundaryKind === "soft-budget" ? { max_turns: 1 } : {}) });
    const held = async () => {
      assert.equal(controller.view(run.run_id).execution_exited, false);
      assert.equal((await controller.wait([run.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
      await assert.rejects(submit("post-guard-premature-reuse", "MUST_NOT_START", run.agent_id), { code: "AGENT_BUSY" });
      assert.equal(controller.stats().active, 1); assert.equal(controller.stats().resident, 1);
      assert(permission.getPermissionsService(parent.sessionId));
      await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
      observeBoundary("execution_held", { stats: controller.stats() });
    };
    if (boundaryKind === "initial") {
      await boundaryWait(boundary.beforeStart.promise, "before_agent_start");
      assert(boundary.fired); controller.cancel(run.run_id); observeBoundary("cancel_requested");
      await held(); boundary.releaseStart.resolve();
    } else if (boundaryKind === "steer") {
      await boundaryWait(boundary.rootEntered.promise, "root_provider"); controller.steer(run.run_id, boundary.target);
      await boundaryWait(boundary.sdkReturned.promise, "steer_prompt_return");
      assert.equal(boundary.gate.uncertain, true);
      await held(); boundary.releaseRoot.resolve();
    }
    await boundaryWait(boundary.cleanupEntered.promise, "quarantine_cleanup");
    assert(boundary.fired, "Last guard did not pass");
    assert.equal(boundary.gate.uncertain, true, "Post-close crossing must quarantine");
    assert.equal(boundary.session.isIdle, true);
    assert.equal(controller.view(run.run_id).execution_exited, true);
    assert.equal(controller.view(run.run_id).resumable, false);
    assert.equal(controller.stats().active, 0); assert.equal(controller.stats().cleaning, 1);
    assert.equal(controller.stats().resident, 1); assert.equal(controller.stats().closed, false);
    assert(permission.getPermissionsService(parent.sessionId)); assert(permission.getPermissionsService(boundary.session.sessionId));
    await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
    observeBoundary("cleanup_held", { stats: controller.stats() });
    const events = boundary.trace.map((row) => row.event);
    const crossing = boundaryKind === "initial" ? "sdk_user_message_start" : "sdk_queue_accepted";
    assert(events.indexOf("guard_passed") < events.indexOf("cancel_requested"));
    assert(events.indexOf("cancel_requested") < events.indexOf("gate_closed"));
    assert(events.indexOf("gate_closed") < events.indexOf(crossing), JSON.stringify(boundary.trace));
    const accepted = boundary.trace.find((row) => row.event === crossing);
    assert.equal(accepted.gate_accepting, false); assert.equal(accepted.gate_stopped, true);
    const returned = boundary.trace.find((row) => row.event === "sdk_prompt_resolved");
    assert(returned); assert.equal(returned.view.execution_exited, false, "SDK prompt return is not dispatch drain");
    assert(accepted.order < returned.order && returned.order < events.indexOf("cleanup_entered"));
    if (boundaryKind === "initial") {
      assert(events.indexOf("guard_passed") < events.indexOf("before_agent_start_held"));
      assert(events.indexOf("before_agent_start_held") < events.indexOf("cancel_requested"));
      assert(events.indexOf("gate_closed") < events.indexOf("before_agent_start_released"));
    }
    if (boundaryKind === "soft-budget") {
      const tool = boundary.trace.find((row) => row.event === "sdk_tool_execution_end" && row.tool_call_id === "post-guard-budget-read");
      const turn = boundary.trace.find((row) => row.event === "sdk_turn_end" && row.stop_reason === "toolUse");
      assert(tool && !tool.is_error && turn && tool.order < turn.order);
      assert(turn.order < events.indexOf("controller_soft_budget") && events.indexOf("controller_soft_budget") < events.indexOf("guard_passed"));
      assert.equal(events.filter((event) => event === "controller_soft_budget").length, 1);
      assert(!events.includes("controller_steer"), "Soft-budget must not be a disguised manual steer");
      assert(boundary.session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "post-guard-budget-read" && !message.isError));
    }
    boundary.releaseCleanup.resolve();
    const completed = await finish(run);
    assert.equal(completed.snapshots[0].status, "cancelled");
    assert.equal(completed.snapshots[0].stop_reason, "user_cancel");
    assert.equal(completed.snapshots[0].unavailable_reason, "input_cleanup_uncertain");
    assert(completed.snapshots[0].cleanup_errors.some((error) => error.includes("INPUT_BOUNDARY_UNCERTAIN")));
    assert.deepEqual(boundary.trace.find((row) => row.event === "cleanup_exited").errors, []);
    assert.equal(permission.getPermissionsService(boundary.session.sessionId), undefined);
    assert.equal(controller.stats().resident, 0);
    assert.deepEqual(boundary.session.getSteeringMessages(), []); assert.deepEqual(boundary.session.getFollowUpMessages(), []);
    await assert.rejects(submit("post-guard-reuse", "FORBIDDEN_REUSE", run.agent_id), { code: "AGENT_UNAVAILABLE" });
    boundary.done = true;
    provider.respond(async () => ({ text: "CLEAN_NEXT_AGENT" }));
    const next = await submit("post-guard-next", "CLEAN_NEXT_TASK"); await finish(next);
    assert.notEqual(next.agent_id, run.agent_id);
    assert(!JSON.stringify(provider.requests.at(-1).context.messages).includes(boundary.target));
    report.boundary.provider_entries_after_cancel = boundary.trace.filter((row) => row.event === "provider_entered" && row.after_cancel);
    report.boundary.phase = "verified";
    record("post-guard cancellation crosses SDK acceptance; drain and confirmed cleanup prevent reuse", {
      kind: boundaryKind, run_id: run.run_id, next: next.run_id, crossing,
      atomic_admission: false, quarantined: true, natural_root_finish_race_tested: false });
  } else if (natural) {
    for (const depth of natural.depths) {
      const item = { depth, target: `NATURAL_FINISH_STEER_${depth}`, trace: [], provider_calls: [],
        scheduled: false, observing: true, guard_passed: false, queue_accepted: false, user_accepted: false };
      natural.cases.push(item); natural.pending = item; save();
      provider.respond(async ({ context, signal }) => {
        const text = JSON.stringify(context.messages), target_in_context = text.includes(item.target);
        const call = { number: item.provider_calls.length + 1, target_in_context, aborted: !!signal?.aborted,
          prior_targets: natural.cases.filter((prior) => prior !== item && text.includes(prior.target)).map((prior) => prior.depth) };
        item.provider_calls.push(call); observeNatural(item, "provider_entered", call);
        return { text: target_in_context ? `NATURAL_TARGET_RESULT_${depth}` : `NATURAL_ROOT_RESULT_${depth}` };
      });
      const run = await controller.submit(`natural-finish-${depth}`, { prompt: `NATURAL_ROOT_${depth}`,
        name: `潮兔${depth}`, description: `Natural finish scheduling point ${depth}`, settings: effective });
      natural.pending = undefined;
      assert.equal(item.run_id, run.run_id); assert.equal(item.agent_id, run.agent_id);
      const done = await finish(run);
      // This only lets already scheduled observations finish after the Run is
      // terminal; it cannot enlarge or reposition the agent_end race window.
      await new Promise((resolve) => setImmediate(resolve));
      const snapshot = done.snapshots[0], events = item.trace.map((row) => row.event);
      assert.equal(item.scheduled, true); assert(events.includes("sdk_agent_end")); assert(events.includes("steer_caller"));
      assert.equal(item.provider_calls[0].target_in_context, false, "fresh root prompt must not contain the steer");
      assert(item.provider_calls.every((call) => call.prior_targets.length === 0), "a fresh Agent must not inherit another Agent's old input");
      const targetProviderCalls = item.provider_calls.filter((call) => call.target_in_context);
      item.outcome = {
        status: snapshot.status, unavailable_reason: snapshot.unavailable_reason,
        discarded: snapshot.discarded_inputs.includes(item.target), target_provider_calls: targetProviderCalls.length,
      };
      const firstAgentEnd = item.trace.find((row) => row.event === "sdk_agent_end");
      const caller = item.trace.find((row) => row.event === "steer_caller");
      const guard = item.trace.find((row) => row.event === "guard_passed");
      assert(firstAgentEnd && caller && firstAgentEnd.order < caller.order);
      assert.equal(firstAgentEnd.stop_reason, "stop"); assert.equal(firstAgentEnd.will_retry, false);
      assert.equal(snapshot.stop_reason, undefined, "No Controller cancel/budget stop may manufacture natural completion");
      if (item.controller_error) {
        assert.equal(item.controller_error.code, "RUN_INPUT_CLOSED");
        assert.equal(item.receipt, undefined); assert.equal(item.guard_passed, false); assert.equal(item.queue_accepted, false);
        assert.equal(targetProviderCalls.length, 0); item.classification = "controller_rejected";
      } else if (!item.guard_passed) {
        assert(item.receipt?.accepted); assert.equal(item.queue_accepted, false); assert.equal(item.user_accepted, false);
        assert.equal(targetProviderCalls.length, 0); assert.equal(item.outcome.discarded, true);
        item.classification = "dispatch_discarded_before_guard";
      } else if (events.includes("target_before_agent_start")) {
        assert(item.receipt?.accepted); assert.equal(item.queue_accepted, false);
        assert(events.includes("target_sdk_prompt_resolved"));
        assert(item.user_accepted);
        assert(events.filter((event) => event === "sdk_agent_start").length >= 2);
        item.classification = "new_prompt_fallback";
        const before = item.trace.find((row) => row.event === "target_before_agent_start");
        const user = item.trace.find((row) => row.event === "target_user_message_start");
        const settled = item.trace.find((row) => row.event === "sdk_agent_settled");
        assert(settled && before && user && guard.order < settled.order && settled.order < before.order && before.order < user.order);
        assert.equal(before.sdk_session_streaming, false); assert.equal(before.core_agent_streaming, false);
        assert.equal(user.gate_accepting, false); assert.equal(item.gate.uncertain, true);
        assert.equal(user.gate_stopped, false); assert.equal(targetProviderCalls.length, 0);
        assert(events.includes("target_user_message_end")); assert.equal(snapshot.resumable, false);
        assert.equal(permission.getPermissionsService(item.session.sessionId), undefined);
        assert.equal(snapshot.status, "failed"); assert.equal(snapshot.unavailable_reason, "input_cleanup_uncertain");
        assert(snapshot.cleanup_errors.some((error) => error.includes("INPUT_BOUNDARY_UNCERTAIN")));
      } else {
        assert(item.receipt?.accepted); assert.equal(item.queue_accepted, true);
        assert(events.includes("target_sdk_prompt_resolved"));
        if (item.user_accepted) {
          assert(targetProviderCalls.length > 0); assert.equal(item.outcome.discarded, false);
          assert.equal(snapshot.status, "completed"); item.classification = "streaming_queue_consumed";
        } else {
          assert.equal(targetProviderCalls.length, 0); assert.equal(item.outcome.discarded, true);
          assert.equal(snapshot.status, "completed"); item.classification = "streaming_queue_discarded";
        }
      }
      if (item.guard_passed) {
        assert(guard);
        assert.equal(guard.accepting, true); assert.equal(guard.stopped, false);
      }
      assert.deepEqual(item.session.getSteeringMessages(), []); assert.deepEqual(item.session.getFollowUpMessages(), []);
      item.observing = false;
      if (snapshot.resumable) {
        assert(permission.getPermissionsService(item.session.sessionId));
        if (!item.user_accepted) {
          let checked = false;
          provider.respond(async ({ context }) => {
            assert(!JSON.stringify(context.messages).includes(item.target), "discarded input escaped into same-session reuse");
            checked = true; return { text: "CLEAN_NATURAL_REUSE" };
          });
          const reused = await submit(`natural-clean-reuse-${depth}`, "CLEAN_FOLLOWUP", run.agent_id);
          assert.equal((await finish(reused)).results[0].text, "CLEAN_NATURAL_REUSE"); assert(checked);
          item.clean_reuse = { run_id: reused.run_id, agent_id: reused.agent_id, old_input_absent: true };
        }
        assert.equal((await controller.release(run.agent_id)).released, true);
      }
      assert.equal(permission.getPermissionsService(item.session.sessionId), undefined);
      assert.equal(controller.stats().resident, 0); assert.equal(controller.stats().cleaning, 0);
      await assert.rejects(submit(`natural-forbidden-reuse-${depth}`, "MUST_NOT_REUSE", run.agent_id), { code: "AGENT_UNAVAILABLE" });
      item.verified = true; save();
    }
    // A depth that produced no case must surface as a named oracle mismatch
    // below, never as "cannot read properties of undefined" here.
    const classifications = Object.fromEntries(natural.depths.map((depth) =>
      [depth, natural.cases.find((item) => item.depth === depth)?.classification ?? "no_case_observed"]));
    assert.equal(new Set(natural.cases.map((item) => item.agent_id)).size, natural.depths.length, "each scheduling point needs a fresh Agent/session");
    // Reviewed Pi 0.87.1 schedule: compared with 0.86.1, depths 4/5/8 shift.
    // The pre-repair and repaired core/adapter produce this same exact map on
    // that host. Depth 9 retains pre-guard-discard coverage on 0.87.1; per-case
    // safety assertions stay intact, with no accepted alternative schedules.
    assert.deepEqual(classifications, {
      0: "streaming_queue_consumed", 1: "streaming_queue_consumed",
      2: "streaming_queue_consumed", 3: "streaming_queue_consumed",
      4: "streaming_queue_consumed", 5: "streaming_queue_discarded",
      6: "new_prompt_fallback", 7: "new_prompt_fallback",
      8: "new_prompt_fallback", 9: "dispatch_discarded_before_guard", 16: "controller_rejected",
    }, "current SDK natural-finish schedule changed; review the boundary rather than widening the oracle");
    report.natural_finish.classifications = classifications;
    report.natural_finish.new_prompt_fallback_observed = natural.cases.some((item) => item.classification === "new_prompt_fallback");
    report.natural_finish.finite_points_only = true;
    record("finite natural agent_end scheduling classifies continuation, discard, rejection and new-prompt fallback", {
      depths: natural.depths, classifications, new_prompt_fallback_observed: report.natural_finish.new_prompt_fallback_observed });
  } else {
  provider.respond(async () => ({ text: "FIRST_RESULT" }));
  const a = await submit("first", "FIRST_TASK"); firstRunId = a.run_id;
  assert.equal((await finish(a)).results[0].text, "FIRST_RESULT");
  provider.respond(async () => ({ text: "SECOND_RESULT" }));
  const b = await submit("reuse", "SECOND_TASK", a.agent_id); assert.equal((await finish(b)).results[0].text, "SECOND_RESULT");
  assert.equal(a.agent_id, b.agent_id); assert.notEqual(a.run_id, b.run_id); assert.equal(ports.length, 1);
  assert.equal(controller.getResult(a.run_id).text, "FIRST_RESULT");
  assert.match(provider.requests.at(-1).context.systemPrompt, /P1_CHILD_CONTEXT_MARKER/);
  assert.match(JSON.stringify(provider.requests.at(-1).context.messages), /FIRST_TASK/);
  assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).context.messages), /harness-fixture-input:/);
  record("same real SDK executor creates separate memory Runs and SDK history references",  { agent_id: a.agent_id, run_ids: [a.run_id, b.run_id], session_id: ports[0].session.sessionId });

  // Drive the actual SDK decision dispatcher, not just a stub handler. A warm
  // decision remains unchanged on the parent and is always stopped on children.
  // The child also carries an earlier handler that returns "warm": because the
  // event is last-writer-wins, this only yields "stop" while the gate stays the
  // final child factory. Reordering it back would fail here, not silently.
  const warmDecision = { type: "cache_warming_decision", action: "warm", warmCost: 0.01, missCost: 1, continuationProbability: 1 };
  assert.equal(await parent.extensionRunner.emitCacheWarmingDecision(warmDecision), "warm");
  assert.equal(await ports[0].session.extensionRunner.emitCacheWarmingDecision(warmDecision), "stop");
  // Same for pi's own "stop": an override must never turn warming back on.
  assert.equal(await ports[0].session.extensionRunner.emitCacheWarmingDecision({ ...warmDecision, action: "stop" }), "stop");
  record("child cache warming is stopped by the real SDK hook, last factory wins over an earlier warm override", { child: "stop", parent: "warm" });

  provider.respond(async () => ({ text: "", reason: "error", error: "synthetic non-retryable bad request" }));
  const failed = await submit("provider-error", "FAIL_THIS_RUN", a.agent_id); const failure = await finish(failed);
  assert.equal(failure.snapshots[0].status, "failed"); assert.equal(failure.results[0].text, "");
  assert.match(failure.snapshots[0].outcome.error, /synthetic non-retryable/);
  const retryHold = deferred(); let retries = 0;
  const retryEntered = deferred();
  provider.respond(async () => {
    if (retries++ === 0) return { text: "FAILED_RETRY_DRAFT", reason: "error", error: "503 overloaded synthetic retry" };
    retryEntered.resolve(); await retryHold.promise; return { text: "RECOVERED_RESULT" };
  });
  const recovered = await submit("retry", "RETRY_THIS_RUN", a.agent_id); await retryEntered.promise;
  assert(report.events.some((event) => event.type === "message_end" && event.text === "FAILED_RETRY_DRAFT" && event.stopReason === "error"));
  assert.equal(controller.view(recovered.run_id).execution_exited, false);
  assert.equal((await controller.wait([recovered.run_id], { mode: "all", timeout_ms: 0 })).reason, "timeout");
  retryHold.resolve(); const retried = await finish(recovered);
  assert.equal(retried.snapshots[0].status, "completed"); assert.equal(retried.snapshots[0].outcome.error, undefined);
  assert.equal(retried.results[0].text, "RECOVERED_RESULT");
  assert(report.events.some((event) => event.type === "auto_retry_end" && event.success));
  record("provider error resolves prompt but fails Run; successful SDK retry clears final error", { failed: failed.run_id, retried: recovered.run_id, attempts: retries });

  let reads = 0;
  provider.respond(async () => reads++ === 0 ? { text: "COMMENTARY_BEFORE_TOOL", tools: [{ type: "toolCall", id: "p1-read-error", name: "read", arguments: { path: join(cwd, "does-not-exist.txt") } }] } : { text: "RECOVERED_TOOL_ERROR" });
  const toolError = await submit("tool-error", "HANDLE_A_TOOL_ERROR", a.agent_id); const toolRecovered = await finish(toolError);
  assert.equal(toolRecovered.snapshots[0].status, "completed"); assert.equal(toolRecovered.results[0].text, "RECOVERED_TOOL_ERROR");
  assert(ports[0].session.messages.some((m) => m.role === "toolResult" && m.toolCallId === "p1-read-error" && m.isError));
  assert(ports[0].session.messages.some((m) => m.role === "assistant" && m.content.some((part) => part.type === "text" && part.text === "COMMENTARY_BEFORE_TOOL")));
  record("real read failure followed by normal delivery does not permanently poison the Run", { run_id: toolError.run_id });

  let budgetCalls = 0;
  provider.respond(async () => ({ tools: [{ type: "toolCall", id: `p1-budget-${budgetCalls++}`, name: "read", arguments: { path: join(cwd, "AGENTS.md") } }] }));
  const budget = await controller.submit("budget", { resume: a.agent_id, prompt: "SYNTHETIC_BUDGET_LOOP", max_turns: 1 });
  const budgetResult = await finish(budget);
  assert.equal(budgetResult.snapshots[0].status, "failed"); assert.equal(budgetResult.snapshots[0].outcome.reason, "turn_limit");
  assert.equal(budgetResult.snapshots[0].stop_reason, "hard_budget"); assert.equal(budgetResult.snapshots[0].turns, 7);
  record("real SDK turn events enforce one shared hard budget on a reused session", { run_id: budget.run_id, turns: budgetResult.snapshots[0].turns, providerCalls: budgetCalls });

  inputHold = deferred(); inputReached = deferred(); const rootHold = deferred();
  provider.respond(async () => { await rootHold.promise; return { text: "ROOT_FINISHED" }; });
  let requested = provider.requested();
  const race = await submit("race", "ROOT_WITH_HELD_DISPATCH", a.agent_id); await requested;
  controller.steer(race.run_id, "HELD_OLD_INPUT"); await inputReached.promise;
  rootHold.resolve(); await ports[0].session.waitForIdle();
  assert.throws(() => controller.steer(race.run_id, "late input"), { code: "RUN_INPUT_CLOSED" });
  await assert.rejects(submit("premature-reuse", "NOT_YET", a.agent_id), { code: "AGENT_BUSY" });
  inputHold.resolve(); const raced = await finish(race);
  assert.equal(raced.snapshots[0].status, "completed");
  assert(raced.snapshots[0].discarded_inputs.includes("HELD_OLD_INPUT"));
  assert(ports[0].gate.observations.some((o) => !o.admitted));
  provider.respond(async () => ({ text: "AFTER_RACE" }));
  const afterRace = await submit("after-race", "AFTER_RACE_TASK", a.agent_id); await finish(afterRace);
  assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).context.messages), /HELD_OLD_INPUT/);
  record("awaited input transform loses its Run window, final guard rejects, next real prompt has no old input", { race: race.run_id, next: afterRace.run_id, guard: ports[0].gate.observations });

  provider.respond(blocked); requested = provider.requested();
  const cancelled = await submit("cancel", "CANCEL_RUNNING", a.agent_id); await requested;
  controller.steer(cancelled.run_id, "OLD_QUEUED_STEER");
  // Drain the tracked public prompt dispatch, not a fake controller queue.
  const steerTick = pollStep("cancel steering queue", () => ports[0].session.getSteeringMessages());
  while (!ports[0].session.getSteeringMessages().includes("OLD_QUEUED_STEER")) await steerTick();
  // Pi 0.87.1 routes followUp through input handlers too. First prove a direct
  // unowned dispatch is rejected, then seed the real SDK queue via a valid
  // Run ticket so cancellation still exercises clearing an actual follow-up.
  const beforeUnowned = ports[0].gate.observations.length;
  await ports[0].session.followUp("UNOWNED_FOLLOWUP");
  assert(!ports[0].session.getFollowUpMessages().includes("UNOWNED_FOLLOWUP"));
  // Exactly this dispatch, not whatever happens to sit last in the ring buffer.
  assert.deepEqual(ports[0].gate.observations.slice(beforeUnowned),
    [{ admitted: false, reason: "input_closed_or_unowned" }], "unowned follow-up must be the only input observed here");
  const followUpTicket = { prefix: "[harness-fixture-input:p1-follow-up]\n",
    valid: () => controller.view(cancelled.run_id).status === "running", passed: false };
  ports[0].gate.tickets.add(followUpTicket);
  try { await ports[0].session.followUp(followUpTicket.prefix + "OLD_QUEUED_FOLLOWUP", undefined, { source: "extension" }); }
  finally { ports[0].gate.tickets.delete(followUpTicket); }
  assert.equal(followUpTicket.passed, true);
  assert(ports[0].session.getFollowUpMessages().includes("OLD_QUEUED_FOLLOWUP"));
  controller.cancel(cancelled.run_id); assert.equal(controller.cancel(cancelled.run_id).already_stopping, true);
  const cancelledResult = await finish(cancelled); assert.equal(cancelledResult.snapshots[0].status, "cancelled");
  assert(cancelledResult.snapshots[0].discarded_inputs.includes("OLD_QUEUED_STEER"));
  assert(cancelledResult.snapshots[0].discarded_inputs.includes("OLD_QUEUED_FOLLOWUP"));
  provider.respond(async () => ({ text: "CLEAN_REUSE" }));
  const clean = await submit("clean", "CLEAN_TASK", a.agent_id); await finish(clean);
  assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).context.messages), /OLD_QUEUED_STEER|OLD_QUEUED_FOLLOWUP|UNOWNED_FOLLOWUP/);
  assert.equal(ports.length, 1);
  record("real cancellation clears steering/follow-up; same session can reuse without old input", { cancelled: cancelled.run_id, clean: clean.run_id });

  const script = join(cwd, "cooperative.cjs");
  writeFileSync(script, 'console.log(`P1_CHILD_READY ${process.pid}`); setTimeout(() => process.exit(0), 15000);\n');
  bashReached = deferred(); let toolCalls = 0;
  provider.respond(async () => toolCalls++ === 0 ? { tools: [{ type: "toolCall", id: "p1-bash", name: "bash", arguments: { command: `${process.execPath} ${script}` } }] } : { text: "after bash" });
  const bashRun = await submit("bash", "CONTROLLED_BASH_CANCEL", a.agent_id); const pid = await bashReached.promise;
  assert.equal(controller.stats().active, 1); controller.cancel(bashRun.run_id);
  const bashResult = await finish(bashRun); assert.equal(bashResult.snapshots[0].status, "cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  record("real permitted SDK Bash is observed running, cancel waits for controlled process exit", { run_id: bashRun.run_id, pid, processExited: true });

  await controller.release(a.agent_id);
  // Discover links from a NEW snapshot of the parent JSONL, not the live child map.
  const entries = readFileSync(parent.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  const parentHistory = sdk.SessionManager.inMemory(parentCwd, undefined, entries);
  const history = async (run_id) => {
    const link = parentHistory.getEntries().find((e) => e.type === "custom" && e.customType === historyTypes.link && e.data.ref.run_id === run_id);
    assert(link, "missing persisted parent-child link");
    return readSdkRun({ sessionManager: sdk.SessionManager, parentFile: parent.sessionFile, sessionDirectory, ref: link.data.ref });
  };
  assert.equal((await history(a.run_id)).output.text, "FIRST_RESULT");
  assert.equal((await history(b.run_id)).output.text, "SECOND_RESULT");
  assert.equal((await history(bashRun.run_id)).outcome.status, "cancelled");
  assert.equal(controller.getResult(a.run_id).text, "FIRST_RESULT");
  assert.equal(controller.view(a.run_id).resumable, false);
  record("released SDK child history is discoverable through parent JSONL without a live session", { first: await history(a.run_id), second: await history(b.run_id) });

  provider.respond(async () => ({ text: "READY_ONCE" }));
  const readyOnce = await submit("ready-once", "READY_ONCE"); await finish(readyOnce);
  const requestsBefore = provider.requests.length;
  const failingPort = ports.at(-1), startHold = deferred(), startEntered = deferred();
  failReadinessSession = cleanupTarget = failingPort.session.sessionId;
  peerCleanupHold = deferred(); peerCleanupEntered = deferred();
  // Delay only the adapter boundary so the peer is already FIFO-queued. The
  // START append, SDK shutdown, permission cleanup and peer IO remain real.
  const begin = failingPort.port.history.begin.bind(failingPort.port.history);
  failingPort.port.history.begin = async (run, settings) => { startEntered.resolve(); await startHold.promise; return begin(run, settings); };
  const peerRootHold = deferred(), peerRequested = deferred();
  provider.respond(async () => { peerRequested.resolve(); await peerRootHold.promise; return { text: "HEALTHY_DURING_CLEANUP" }; });
  const notReady = await submit("lost-readiness", "MUST_NOT_PROMPT", readyOnce.agent_id); await startEntered.promise;
  const peer = await submit("cleanup-peer", "PEER_PREQUEUED_BEFORE_CLEANUP"); startHold.resolve();
  await peerCleanupEntered.promise; await peerRequested.promise;
  const peerPort = ports.at(-1), peerPermission = permission.getPermissionsService(peerPort.session.sessionId);
  assert(peerPermission); assert.equal(controller.stats().cleaning, 1); assert.equal(controller.stats().active, 1);
  controller.steer(peer.run_id, "PEER_INPUT_SURVIVES_OTHER_DISPOSE");
  const peerTick = pollStep("peer steering queue", () => peerPort.session.getSteeringMessages());
  while (!peerPort.session.getSteeringMessages().includes("PEER_INPUT_SURVIVES_OTHER_DISPOSE")) await peerTick();
  assert.equal(provider.requests.length, requestsBefore + 1, "only the healthy peer reached the provider");
  peerCleanupHold.resolve(); const rejected = await finish(notReady);
  assert.equal(rejected.snapshots[0].status, "failed"); assert.equal(rejected.snapshots[0].resumable, false);
  assert.equal(rejected.snapshots[0].unavailable_reason, "readiness_failed");
  const rejectedHistory = await readSdkRun({ sessionManager: sdk.SessionManager, parentFile: parent.sessionFile,
    sessionDirectory, ref: rejected.snapshots[0].history_ref });
  assert.deepEqual(rejectedHistory.routing, { preset: effective.preset, preset_version: effective.preset_version,
    selection_digest: effective.selection_digest, difficulty: effective.difficulty, strength: effective.strength, thinking: effective.thinking,
    parent_thinking: effective.parent_thinking, thinking_resolution: effective.thinking_resolution,
    provider: effective.provider, model: effective.model, profile: effective.profile });
  assert.equal(permission.getPermissionsService(failingPort.session.sessionId), undefined);
  assert.equal(permission.getPermissionsService(peerPort.session.sessionId), peerPermission);
  assert.equal(peerPort.session.isStreaming, true);
  assert(peerPort.session.getSteeringMessages().includes("PEER_INPUT_SURVIVES_OTHER_DISPOSE"));
  assert.equal(requireReadiness(peerPort.bus, permission.getPermissionsService, peerPort.session.sessionId,
    effective.profile, definitionDigest).sessionId, peerPort.session.sessionId);
  await assert.rejects(submit("retry-lost-readiness", "STILL_FORBIDDEN", readyOnce.agent_id), { code: "AGENT_UNAVAILABLE" });
  peerRootHold.resolve(); assert.equal((await finish(peer)).results[0].text, "HEALTHY_DURING_CLEANUP");
  failReadinessSession = cleanupTarget = undefined;
  provider.respond(async () => ({ text: "REUSED_AFTER_PEER_CLEANUP" }));
  const peerReuse = await submit("cleanup-peer-reuse", "REUSE_HEALTHY_PEER", peer.agent_id); await finish(peerReuse);
  record("lost readiness quarantines one session; prequeued SDK peer starts during cleanup and keeps permission/input/reuse", {
    failed: notReady.run_id, peer: peer.run_id, reused: peerReuse.run_id, permissionPreserved: true, steeringPreserved: true });

  provider.respond(async () => ({ text: "BEFORE_IO_FAILURE" }));
  const warm = await submit("warm-fault", "WARM_FAULT_SESSION"); await finish(warm);
  const hold = deferred(), entered = deferred(), target = ports.at(-1).session.sessionFile;
  provider.respond(async () => {
    if (faultFile) return { text: "HEALTHY_QUEUED_RESULT" };
    entered.resolve(); await hold.promise;
    renameSync(target, target + ".before-fault"); mkdirSync(target); faultFile = target;
    return { text: "UNSAVED_ASSISTANT" };
  });
  const damaged = await submit("history-fault", "SDK_WRITE_FAILURE", warm.agent_id); faultRunId = damaged.run_id; await entered.promise;
  const queued = await submit("queued-at-fault", "HEALTHY_PEER_MAY_RUN"); hold.resolve();
  const damagedTick = pollStep("child history-fault Run settled", () => controller.view(damaged.run_id));
  while (controller.view(damaged.run_id).phase !== "settled") await damagedTick();
  assert.equal(controller.view(damaged.run_id).status, "failed");
  assert.match(controller.view(damaged.run_id).history_error, /SDK_HISTORY_UNCERTAIN|EISDIR/);
  const healthy = await finish(queued);
  assert.equal(healthy.results[0].text, "HEALTHY_QUEUED_RESULT");
  assert.equal(controller.view(damaged.run_id).owner_blocked, false);
  await assert.rejects(submit("no-reuse", "NO_REUSE", warm.agent_id), { code: "AGENT_UNAVAILABLE" });
  record("child SDK automatic log failure isolates its writer while a healthy peer completes", { damaged: controller.view(damaged.run_id), healthy });

  provider.respond(blocked); const parentRequested = provider.requested();
  const blocker = await submit("parent-fault-blocker", "HOLD_FOR_PARENT_FAULT", queued.agent_id); await parentRequested;
  const parentDamaged = await submit("parent-link-fault", "MUST_NOT_PROMPT");
  const frozen = await submit("queued-after-parent-fault", "MUST_NOT_START");
  const requestsAtFault = provider.requests.length;
  renameSync(parent.sessionFile, parent.sessionFile + ".before-fault"); mkdirSync(parent.sessionFile); parentFaultFile = parent.sessionFile;
  controller.cancel(blocker.run_id);
  const parentDamagedTick = pollStep("parent history-fault Run settled", () => controller.view(parentDamaged.run_id));
  while (controller.view(parentDamaged.run_id).phase !== "settled") await parentDamagedTick();
  assert.equal(controller.view(parentDamaged.run_id).status, "failed");
  assert.match(controller.stats().parent_error, /PARENT_HISTORY_UNAVAILABLE.*EISDIR/);
  assert.equal(controller.view(frozen.run_id).status, "queued"); assert.equal(provider.requests.length, requestsAtFault);
  assert.equal((await controller.wait([frozen.run_id], { mode: "all" })).reason, "owner_blocked");
  await assert.rejects(submit("parent-unavailable", "NO_NEW_WORK"), { code: "OWNER_PARENT_UNAVAILABLE" });
  record("shared parent SDK LINK failure still blocks owner admission before provider IO", { damaged: controller.view(parentDamaged.run_id), frozen: controller.view(frozen.run_id) });
  }
} catch (error) {
  report.failure_reason = String(error); throw error;
} finally {
  for (const gate of gatesToRelease) gate.resolve();
  report.shutdown = await controller.shutdown(3000);
  report.fault_restoration = restoreFaultedLogs([faultFile, parentFaultFile], report.shutdown.closed);
  report.guardObservations = ports.map(({ gate, session }) => ({ session_id: session.sessionId, observations: gate.observations, uncertain: gate.uncertain }));
  save();
  assert.equal(report.shutdown.closed, true, JSON.stringify(report.shutdown));
  assert(report.fault_restoration.every((item) => item.restored), JSON.stringify(report.fault_restoration));
  if (boundary) observeBoundary("owner_closed", { stats: report.shutdown });
  for (const { session } of ports) assert.equal(permission.getPermissionsService(session.sessionId), undefined);
  assert.deepEqual(readdirSync(join(ownerOptions.directory, ownerOptions.owner_id)), ["owner.lock"]);
  const restarted = await Controller.open({ owner: await ExecutionOwner.open(ownerOptions), createSession: async () => { throw new Error("NO_REPLAY"); } });
  assert.deepEqual(restarted.list(), []); assert.equal((await restarted.shutdown()).closed, true);
  record(boundary ? "post-guard owner drains before closure; restart never hydrates live Runs" :
    "history failure does not hold a drained owner open; restart never hydrates live Runs", { emptyRestart: true, files: ["owner.lock"] });
  if (firstRunId && faultRunId) {
    const readCold = (run_id) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./history-reader.mjs", import.meta.url)),
      piExecutable, parent.sessionFile, sessionDirectory, run_id], { encoding: "utf8", timeout: 20_000, maxBuffer: 1_048_576 }));
    const first = readCold(firstRunId), damaged = readCold(faultRunId);
    assert.equal(first.state, "recorded"); assert.equal(first.output.text, "FIRST_RESULT"); assert.equal(first.resumable, false);
    assert.equal(damaged.state, "unknown"); assert.equal(damaged.resumable, false);
    record("cold processes discover child history from parent path and Run ID; missing END stays unknown", { first, damaged });
  }
  const cleanup = await disposeChild(parent, parentBus); assert.equal(cleanup.shutdownExited, true);
  assert.deepEqual(cleanup.errors, []); assert.equal(permission.getPermissionsService(parent.sessionId), undefined);
  if (boundary) observeBoundary("parent_disposed", { ...cleanup, permission_removed: true });
  report.parent_cleanup = cleanup; save();
}
report.checks_passed = true; save();
console.log("P1 SDK fixture assertions complete; evidence-only and not a real-model trial.");
