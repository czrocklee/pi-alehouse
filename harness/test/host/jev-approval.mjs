// Rendered-Jev/real-SDK integration probe. This is intentionally not a
// real-model test: both the Pi provider and Jev fetch are deterministic local
// scripts, and every ambient credential/network route is excluded.
// PROCESS ISOLATION REQUIRED: the collector launches a dedicated Node process.
// Never import this executable into a shared in-process test runner. Network
// stubs intentionally persist until process exit: restoring them at teardown
// would let late callbacks regain real network access.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { ApprovalBindings } from "../../dist/permissions/approval-provenance.js";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { abortAndWaitForIdle, controlledProvider, loadHost } from "../support/host.mjs";
import { globalInstructionFixture, projectInstructionFixture } from "../support/project-instructions.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, generatedRootArg, outputRootArg, configSource] = process.argv.slice(2);
assert(piExecutable && generatedRootArg && outputRootArg && configSource,
  "Use check-pi-harness.sh --jev-only");
const generatedRoot = resolve(generatedRootArg), outputRoot = resolve(outputRootArg);
assert.equal(process.env.HOME, join(dirname(generatedRoot), "home"));
assert.equal(process.env.PI_CODING_AGENT_DIR, generatedRoot);
assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, join(outputRoot, "jev-sessions"));
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.PI_TELEMETRY, "0");
assert.equal(process.env.PI_JEV_APPROVAL_MODE, "enforce-subagents");

const jevPath = join(generatedRoot, "extensions/jev-auto-approval.ts");
const lunaHelperPath = join(generatedRoot, "extensions/luna-auto-approval.ts");
const permissionPath = join(generatedRoot, "extensions/managed-permissions/index.ts");
const staticGuardPath = join(generatedRoot, "extensions/static-safety-guard.ts");
const policyGrepPath = join(generatedRoot, "extensions/policy-grep.ts");
for (const path of [jevPath, lunaHelperPath, permissionPath, staticGuardPath, policyGrepPath]) {
  assert(existsSync(path), `Missing rendered fixture resource: ${path}`);
}
assert.doesNotMatch(readFileSync(jevPath, "utf8"), /\/\* @worker-policy@ \*\/ \{\}/,
  "Jev must be the worker-resources-rendered artifact, not unrendered source");
assert.deepEqual(
  JSON.parse(readFileSync(join(generatedRoot, "extensions/pi-permission-system/config.json"), "utf8")),
  JSON.parse(readFileSync(configSource, "utf8")),
  "The Jev probe must not add permission allowances");

// Jev only reads this file. Overwrite any inherited path before its module is
// evaluated, clear the rendezvous slot, and remove common direct-key variables.
const apiKeySymbol = Symbol.for("@rocklee/jev-auto-approval:api-key-file");
delete globalThis[apiKeySymbol];
for (const name of ["TYPESAFE_API_KEY", "JEV_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
  delete process.env[name];
const fakeKey = "jev-fixture-not-a-credential";
const fakeKeyPath = join(outputRoot, "jev-fixture.key");
writeFileSync(fakeKeyPath, `${fakeKey}\n`, { mode: 0o600, flag: "wx" });
process.env.PI_JEV_API_KEY_FILE = fakeKeyPath;

const networkAttempts = [];
const blockedNetwork = (name) => () => {
  networkAttempts.push(name);
  throw new Error(`UNEXPECTED_NETWORK: ${name}`);
};
for (const [name, module] of [["http", http], ["https", https]]) {
  for (const method of ["request", "get"]) module[method] = blockedNetwork(`${name}.${method}`);
}
net.Socket.prototype.connect = blockedNetwork("socket.connect");
tls.connect = blockedNetwork("tls.connect");
syncBuiltinESMExports();

const allowAnswers = {
  task_scope: { type: "noul", noul: 0.99 },
  read_only: { type: "noul", noul: 0.99 },
  reversible: { type: "noul", noul: 0.99 },
  remote_mutation: { type: "noul", noul: 0.01 },
  credential_exposure: { type: "noul", noul: 0.01 },
  injection: { type: "noul", noul: 0.01 },
  constraint_conflict: { type: "noul", noul: 0.01 },
  policy_evasion: { type: "noul", noul: 0.01 },
  unbounded_target: { type: "noul", noul: 0.01 },
  risk: { type: "score", score: 0, confidence: 0.99, probabilities: { low: 0.99 } },
};
const fetchCalls = [];
let review = async () => ({ answers: allowAnswers, usage: { input_tokens: 41 } });
globalThis.fetch = async (url, options = {}) => {
  assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
  assert.equal(options.method, "POST");
  assert.equal(options.headers?.Authorization, `Bearer ${fakeKey}`);
  assert.equal(options.headers?.["Content-Type"], "application/json");
  const body = JSON.parse(options.body);
  assert.equal(body.model, "jev-1.13.0");
  assert(body.state && body.questions);
  const witnessRegistry = globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")];
  const witnesses = witnessRegistry instanceof Map
    ? [...witnessRegistry.entries()].map(([sessionId, facts]) => ({ sessionId, facts: structuredClone(facts) }))
    : [];
  const call = { state: structuredClone(body.state), witnesses, signal: options.signal, at: Date.now() };
  fetchCalls.push(call);
  const response = await review(call);
  return { ok: true, status: 200, json: async () => structuredClone(response) };
};

const host = await loadHost(piExecutable), { sdk, ai, permission } = host;
const report = {
  authority: host.authority,
  versions: host.versions,
  rendered_jev_digest: digest(readFileSync(jevPath, "utf8")),
  fake_key_path: fakeKeyPath,
  real_model: false,
  release: releaseDecision,
  cases: [],
  approval_events: [],
  permission_events: [],
  dialogs: [],
  fetches: [],
  cleanup: [],
  limitations: [
    "Deterministic local Pi provider and mocked Jev HTTP response; no network and no real credentials",
    "Focused owner/Run approval binding only; not calibration, real-model usability, reload, or deployment admission",
    "Pi 0.87.1 RunInputGate remains a fixture boundary rather than an atomic production input API",
  ],
};
const reportPath = join(outputRoot, "jev-approval.json");
const save = () => writeFileSync(reportPath, JSON.stringify(report, (_key, value) =>
  value instanceof AbortSignal ? { aborted: value.aborted } : value, 2), { mode: 0o600 });
save();

const runtime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(),
  modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert(model);
const settings = () => sdk.SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

const parentCwd = join(outputRoot, "jev-parent");
const childCwd = parentCwd; // Production children inherit the owner's cwd.
// Load realistic instructions through the SDK's context-file override. Disable
// ambient discovery, not the project_context section: no private HOME/ancestor
// files should enter a supposedly hermetic fixture.
const loadedInstructions = [
  { path: join(generatedRoot, "AGENTS.md"), content: globalInstructionFixture },
  { path: join(parentCwd, "AGENTS.md"), content: projectInstructionFixture },
];
const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
const ownerDirectory = join(outputRoot, "jev-owner");
for (const path of [parentCwd, childCwd, sessionDirectory, ownerDirectory])
  mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(childCwd, "PUBLIC.txt"), "JEV_PUBLIC_MARKER\n", { mode: 0o600 });

function observeBus(bus, node) {
  for (const channel of [
    "pi-harness:approval:admitted", "pi-harness:approval:started",
    "pi-harness:approval:invalidated", "pi-harness:approval:finished",
  ]) bus.on(channel, (value) => report.approval_events.push({ node, channel, ...structuredClone(value),
    ...(channel === "pi-harness:approval:started" ? { witness: structuredClone(globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")]?.get(value.sessionId)) } : {}) }));
  for (const channel of [permission.PERMISSIONS_READY_CHANNEL,
    permission.PERMISSIONS_UI_PROMPT_CHANNEL, permission.PERMISSIONS_DECISION_CHANNEL]) {
    bus.on(channel, (value) => report.permission_events.push({ node, channel, ...structuredClone(value) }));
  }
}

let dialogCount = 0;
const parentBus = sdk.createEventBus();
observeBus(parentBus, "parent");
const parentLoader = new sdk.DefaultResourceLoader({
  cwd: parentCwd,
  agentDir: generatedRoot,
  settingsManager: settings(),
  eventBus: parentBus,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  agentsFilesOverride: () => ({ agentsFiles: loadedInstructions }),
  // Jev must observe session_start before managed permissions publishes ready.
  additionalExtensionPaths: [jevPath, permissionPath],
});
await parentLoader.reload();
assert.deepEqual(parentLoader.getExtensions().errors, []);
const { session: parent } = await sdk.createAgentSession({
  cwd: parentCwd,
  agentDir: generatedRoot,
  resourceLoader: parentLoader,
  settingsManager: settings(),
  sessionManager: sdk.SessionManager.create(parentCwd, sessionDirectory),
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: [],
});
await parent.bindExtensions({
  mode: "rpc",
  onError: (error) => { throw new Error(error.error); },
  uiContext: {
    select: async (title, options) => {
      dialogCount += 1;
      report.dialogs.push({ title, options: structuredClone(options) });
      const no = options.find((option) => /^No$/i.test(option));
      assert(no, `No deny choice in ${JSON.stringify(options)}`);
      return no;
    },
    input: async () => { throw new Error("Unexpected free-form approval input"); },
    notify() {}, setStatus() {}, setWidget() {},
  },
});
assert(permission.getPermissionsService(parent.sessionId));

// This must be a real live provenance path. An extension-source injection would
// make Jev correctly fail context construction and invalidate the whole probe.
provider.respond(async () => ({ text: "Parent accepted the delegated inspection task." }));
await parent.prompt("Inspect the public fixture with reader; read-only shell inspection is authorized.", {
  source: "rpc",
  expandPromptTemplates: false,
});
await parent.waitForIdle();
assert.equal(dialogCount, 0);

const definitionPath = join(generatedRoot, "agents/reader.md");
const definition = readFileSync(definitionPath, "utf8");
const definitionDigest = digest(definition);
const tools = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
const inherited = "INHERITED_PARENT_CONTEXT_MARKER";
const effective = {
  provider: model.provider,
  model: model.id,
  thinking: "off",
  parent_thinking: "off",
  thinking_resolution: "identity",
  profile: "reader",
  difficulty: 3, strength: "standard",
  preset: "fixture",
  preset_version: "v1",
  selection_digest: "1".repeat(64),
  cwd: childCwd,
  tools,
  definition_digest: definitionDigest,
  context_snapshot: inherited,
};

const owner = await ExecutionOwner.open({
  directory: ownerDirectory,
  owner_id: parent.sessionId,
  flock: process.env.P0_FLOCK,
});
const approvals = new ApprovalBindings(parentBus, {
  owner_id: parent.sessionId,
  generation: owner.generation,
});
const ports = [];
const controller = await Controller.open({
  owner,
  concurrency: 1,
  onContextChange: approvals.contextChanged,
  createSession: async (agent) => {
    assert.equal(agent.settings.profile, effective.profile);
    assert.equal(agent.settings.definition_digest, definitionDigest);
    const childBus = sdk.createEventBus();
    observeBus(childBus, `child-${ports.length + 1}`);
    const gate = new RunInputGate();
    const manager = sdk.SessionManager.create(childCwd, sessionDirectory, { parentSession: parent.sessionFile });
    assert.equal(existsSync(manager.getSessionFile()), false, "SessionManager.create reserves an ID/path but does not create a journal");
    manager.appendCustomEntry("active_agent", { name: effective.profile });
    const sessionId = manager.getSessionId();
    const loader = new sdk.DefaultResourceLoader({
      cwd: childCwd,
      agentDir: generatedRoot,
      settingsManager: settings(),
      eventBus: childBus,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: loadedInstructions }),
      // Deliberately no Jev here. The child has deterministic policy and static
      // guards, then its own witness observer, with RunInputGate loaded last.
      additionalExtensionPaths: [permissionPath, staticGuardPath, policyGrepPath],
      appendSystemPromptOverride: () => [
        definition.split(/^---\s*$/m).slice(2).join("\n").trim(),
        '<active_agent name="reader"/>',
      ],
      extensionFactories: [approvals.childExtension(sessionId), gate.extension],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const assembled = await assembleChild({
      createSession: sdk.createAgentSession,
      options: {
        cwd: childCwd,
        agentDir: generatedRoot,
        resourceLoader: loader,
        settingsManager: settings(),
        sessionManager: manager,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        tools,
      },
      parentBus,
      childBus,
      parentSessionId: parent.sessionId,
      profile: effective.profile,
      definitionDigest,
      getPermissionsService: permission.getPermissionsService,
    });
    assert.equal(assembled.session.sessionId, sessionId);
    let activeRun;
    const port = new SdkRunPort({
      session: assembled.session,
      parentBus,
      gate,
      readiness: () => requireReadiness(childBus, permission.getPermissionsService,
        assembled.session.sessionId, effective.profile, definitionDigest),
      invalidateApproval: () => {
        if (activeRun) approvals.end(assembled.session.sessionId, activeRun);
        activeRun = undefined;
      },
    });
    // This adapter is the integration seam under test: Controller supplies the
    // trusted third argument, begin receives the actual inherited prompt, and
    // SdkRunPort revokes in stop()/finally before drain.
    const sdkRun = port.run.bind(port);
    port.run = (prompt, callbacks, identity) => {
      assert(identity, "Controller did not supply RunExecutionIdentity");
      assert.equal(identity.task_prompt.length > 0, true);
      activeRun = identity;
      if (!identity.task_prompt.includes("MISSING_WITNESS")) {
        if (identity.task_prompt.includes("LEFTOVER_WITNESS")) {
          approvals.begin({ ...identity, run_id: `${identity.run_id}-leftover` }, {
            sessionId: assembled.session.sessionId, cwd: childCwd,
            profile: effective.profile, definitionDigest, prompt,
          });
        }
        approvals.begin(identity, {
          sessionId: assembled.session.sessionId,
          cwd: childCwd,
          profile: effective.profile,
          definitionDigest,
          prompt,
        });
      }
      return sdkRun(prompt, callbacks, identity);
    };
    ports.push({ port, gate, session: assembled.session, bus: childBus });
    return port;
  },
});

const terminal = (status) => ["completed", "needs_input", "failed", "cancelled"].includes(status);
async function finish(run) {
  const waited = await controller.wait([run.run_id], { mode: "all", timeout_ms: 10_000 });
  assert.equal(waited.reason, "condition", JSON.stringify(waited));
  assert(terminal(waited.snapshots[0].status));
  return waited;
}
function scriptedBash(id, finalText) {
  let count = 0;
  provider.respond(async () => ++count === 1
    ? { tools: [{ type: "toolCall", id, name: "bash", arguments: { command: "sleep 0" } }] }
    : { text: finalText });
  return () => count;
}
function toolResult(session, id) {
  return session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
}
function audits() {
  const path = join(generatedRoot, "logs/jev-auto-approval.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
function jevDecisionsSince(start) {
  return audits().slice(start).filter((row) => row.event === "jev_model_judge.decision");
}
async function check(name, action) {
  const item = { name, status: "running" };
  report.cases.push(item); save();
  try {
    await action(item);
    item.status = "passed";
  } catch (error) {
    item.status = "failed";
    item.error = String(error);
    throw error;
  } finally {
    report.decisions = audits();
    report.fetches = fetchCalls.map((call) => ({ actionBinding: call.state.actionBinding,
      delegationContext: call.state.delegationContext, userAuthorization: call.state.userAuthorization,
      witnesses: call.witnesses, aborted: call.signal?.aborted ?? false }));
    save();
  }
  console.log(`PASS JEV: ${name}`);
}

let primaryError;
try {
  let first;
  await check("initial inherited prompt is bound and forwarded Bash ask auto-allows without human UI", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length, beforeFetch = fetchCalls.length;
    const calls = scriptedBash("jev-initial-bash", "INITIAL_JEV_ALLOWED");
    first = await controller.submit("jev-initial", {
      prompt: "Inspect once with sleep 0 and report completion.",
      description: "Initial bound delegated approval",
      name: "approval-fixture",
      settings: effective,
    });
    const result = await finish(first);
    assert.equal(result.snapshots[0].status, "completed");
    assert.equal(result.results[0].text, "INITIAL_JEV_ALLOWED");
    assert.equal(calls(), 2);
    const child = ports[0].session;
    const tool = toolResult(child, "jev-initial-bash");
    assert(tool && !tool.isError, "sleep 0 did not execute through the real Bash gate");
    assert.equal(dialogCount, beforeDialogs, "automatic allow unexpectedly opened human UI");
    assert.equal(fetchCalls.length, beforeFetch + 1);
    const packet = fetchCalls.at(-1).state;
    assert.equal(packet.actionBinding.scope, "delegated_child_exact_action");
    assert.equal(packet.projectInstructionExcerpts.sourceFileCount, 2);
    assert.equal(packet.delegationContext.projectInstructionExcerpts.sourceFileCount, 2);
    assert(JSON.stringify(packet.projectInstructionExcerpts.entries).length / 4 > 700,
      "realistic loaded instructions must exercise the old budget failure");
    assert(packet.projectInstructionExcerpts.entries.some((entry) => entry.text.includes("Never commit plaintext secrets.")));
    assert.match(parent.systemPrompt, /Project-specific instructions and guidelines:/);
    assert.equal(packet.delegationContext.agentName, effective.profile);
    assert(packet.userAuthorization.messages.some((message) => message.source === "live_input" &&
      message.text.includes("Inspect the public fixture")), "Jev packet lost the real root authorization snapshot");
    const witnessed = fetchCalls.at(-1).witnesses.find((entry) => entry.sessionId === child.sessionId)?.facts;
    assert(witnessed, "Jev fetch occurred without a host witness");
    assert.equal(witnessed.parentSessionId, parent.sessionId);
    assert.equal(witnessed.harness.owner_id, parent.sessionId);
    assert.equal(witnessed.harness.run_id, first.run_id);
    assert.equal(witnessed.harness.agent_id, first.agent_id);
    assert.equal(witnessed.harness.profile, effective.profile);
    assert.equal(witnessed.harness.definitionDigest, definitionDigest);
    assert.equal(witnessed.harness.task_prompt, "Inspect once with sleep 0 and report completion.");
    assert.equal(witnessed.harness.prompt,
      `${inherited}\n\nInspect once with sleep 0 and report completion.`);
    assert.match(JSON.stringify(provider.requests.find((request) =>
      JSON.stringify(request.context.messages).includes("jev-initial-bash"))?.context.messages),
    /INHERITED_PARENT_CONTEXT_MARKER[\s\S]*Inspect once with sleep 0/);
    const decision = jevDecisionsSince(beforeAudit).find((row) => row.requestScope === "subagent");
    assert(decision && decision.effectiveVerdict === "allow" && decision.modelCalled === true,
      JSON.stringify(jevDecisionsSince(beforeAudit)));
    item.run_id = first.run_id; item.agent_id = first.agent_id; item.session_id = child.sessionId;
  });

  await check("same Agent resume receives a fresh Run binding and auto-allows", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length;
    scriptedBash("jev-resume-bash", "RESUMED_JEV_ALLOWED");
    const resumed = await controller.submit("jev-resume", {
      resume: first.agent_id,
      prompt: "Repeat the bounded sleep 0 inspection for the follow-up.",
    });
    const result = await finish(resumed);
    assert.equal(resumed.agent_id, first.agent_id);
    assert.equal(ports.length, 1, "resume created a second SDK child");
    assert.equal(result.results[0].text, "RESUMED_JEV_ALLOWED");
    assert(!toolResult(ports[0].session, "jev-resume-bash").isError);
    assert.equal(dialogCount, beforeDialogs);
    assert(jevDecisionsSince(beforeAudit).some((row) =>
      row.requestScope === "subagent" && row.effectiveVerdict === "allow"));
    item.run_id = resumed.run_id;
  });

  await check("controller steer while reviewer is pending expires the allow", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    review = async () => { entered.resolve(); await release.promise; return { answers: allowAnswers, usage: { input_tokens: 42 } }; };
    scriptedBash("jev-steer-bash", "STEER_CASE_FINISHED");
    const run = await controller.submit("jev-steer-expiry", {
      resume: first.agent_id,
      prompt: "Start a bounded sleep 0 inspection while review is pending.",
    });
    await entered.promise;
    const receipt = controller.steer(run.run_id, "Changed task context while the approval reviewer is pending.");
    assert.equal(receipt.accepted, true);
    release.resolve();
    const result = await finish(run);
    review = async () => ({ answers: allowAnswers, usage: { input_tokens: 41 } });
    const tool = toolResult(ports[0].session, "jev-steer-bash");
    assert(tool?.isError, "stale Jev allow executed after steer");
    assert.equal(dialogCount, beforeDialogs + 1, "stale allow did not fall through to fake-No UI");
    const decisions = jevDecisionsSince(beforeAudit);
    assert(decisions.some((row) => row.requestScope === "subagent" &&
      row.effectiveVerdict !== "allow" && row.failureCode === "review_context_changed"),
    JSON.stringify(decisions));
    assert(report.approval_events.some((event) => event.channel === "pi-harness:approval:invalidated" &&
      event.run_id === run.run_id && event.kind === "steer"));
    item.run_id = run.run_id; item.status_after = result.snapshots[0].status;
  });

  await check("a fresh sibling Agent cannot retry the same human-refused action", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length, beforeFetch = fetchCalls.length;
    scriptedBash("jev-sibling-retry", "SIBLING_RETRY_FINISHED");
    const sibling = await controller.submit("jev-sibling-retry", {
      prompt: "Inspect once with sleep 0 using a different Agent.",
      description: "Cross-session refusal regression", settings: effective,
    });
    await finish(sibling);
    assert.notEqual(ports[1].session.sessionId, ports[0].session.sessionId);
    assert(toolResult(ports[1].session, "jev-sibling-retry")?.isError);
    assert.equal(dialogCount, beforeDialogs, "refusal retry must not reopen the human dialog");
    assert.equal(fetchCalls.length, beforeFetch, "changing Agent must not reopen model approval");
    assert(jevDecisionsSince(beforeAudit).some((row) => row.failureCode === "approval_retry_paused"));
    item.run_id = sibling.run_id;
  });

  // The previous synthetic human No paused sleep 0. Only fresh direct root
  // input may reopen that exact operation for the next independent race case.
  provider.respond(async () => ({ text: "New bounded inspection authorized." }));
  await parent.prompt("Authorize a new bounded sleep 0 inspection for the next fixture case.", {
    source: "rpc", expandPromptTemplates: false,
  });
  await parent.waitForIdle();

  await check("new live root input expires an in-flight child authorization snapshot", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    review = async () => { entered.resolve(); await release.promise; return { answers: allowAnswers, usage: { input_tokens: 43 } }; };
    scriptedBash("jev-root-input-bash", "ROOT_INPUT_CASE_FINISHED");
    const run = await controller.submit("jev-root-input-expiry", {
      resume: first.agent_id,
      prompt: "Begin another bounded sleep 0 inspection.",
    });
    await entered.promise;
    provider.respond(async () => ({ text: "Parent context changed while child review was pending." }));
    await parent.prompt("New root instruction: the previous delegated authorization snapshot is obsolete.", {
      source: "rpc",
      expandPromptTemplates: false,
    });
    await parent.waitForIdle();
    release.resolve();
    await finish(run);
    review = async () => ({ answers: allowAnswers, usage: { input_tokens: 41 } });
    assert(toolResult(ports[0].session, "jev-root-input-bash")?.isError,
      "old authorization survived a new live root input");
    assert.equal(dialogCount, beforeDialogs + 1);
    const decisions = jevDecisionsSince(beforeAudit);
    assert(decisions.some((row) => row.requestScope === "subagent" &&
      row.effectiveVerdict !== "allow" && row.failureCode === "review_context_changed"),
    JSON.stringify(decisions));
    item.run_id = run.run_id;
  });

  await check("same session cannot borrow an old grant when the new Run witness is missing", async (item) => {
    const beforeDialogs = dialogCount, beforeAudit = audits().length, beforeFetch = fetchCalls.length;
    scriptedBash("jev-missing-witness-bash", "MISSING_WITNESS_FINISHED");
    const run = await controller.submit("jev-missing-witness", {
      resume: first.agent_id,
      prompt: "MISSING_WITNESS: this fixture deliberately omits ApprovalBindings.begin.",
    });
    await finish(run);
    assert(toolResult(ports[0].session, "jev-missing-witness-bash")?.isError);
    assert.equal(dialogCount, beforeDialogs + 1);
    assert.equal(fetchCalls.length, beforeFetch, "missing witness reached Jev model fetch");
    const decisions = jevDecisionsSince(beforeAudit);
    assert(decisions.some((row) => row.requestScope === "subagent" && row.modelCalled === false &&
      row.effectiveVerdict === "defer" && row.failureCode === "delegation_unbound"), JSON.stringify(decisions));
    item.run_id = run.run_id;
  });

  await check("a throwing witness observer cannot disable normal human forwarding", async (item) => {
    const beforeDialogs = dialogCount, beforeFetch = fetchCalls.length;
    const observers = globalThis[Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers")];
    const sessionId = ports[0].session.sessionId, original = observers.get(sessionId);
    assert.equal(typeof original, "function");
    observers.set(sessionId, () => { throw new Error("synthetic observation failure"); });
    try {
      scriptedBash("jev-observer-failure", "OBSERVER_FAILURE_FINISHED");
      const run = await controller.submit("jev-observer-failure", {
        resume: first.agent_id, prompt: "Inspect once with sleep 0 while the optional witness observer fails.",
      });
      await finish(run);
      assert(toolResult(ports[0].session, "jev-observer-failure")?.isError);
      assert.equal(dialogCount, beforeDialogs + 1, "forwarding must still reach human No");
      assert.equal(fetchCalls.length, beforeFetch, "a failed observation must not grant model authority");
      item.run_id = run.run_id;
    } finally { observers.set(sessionId, original); }
  });

  await check("a leftover owned witness falls through to human approval instead of killing the Run", async (item) => {
    const beforeDialogs = dialogCount, beforeFetch = fetchCalls.length;
    scriptedBash("jev-leftover-witness", "LEFTOVER_WITNESS_FINISHED");
    const run = await controller.submit("jev-leftover-witness", {
      resume: first.agent_id, prompt: "LEFTOVER_WITNESS: inspect once with sleep 0.",
    });
    const result = await finish(run);
    assert.equal(result.snapshots[0].status, "completed", "optional approval bookkeeping must not fail the Run");
    assert.equal(result.results[0].text, "LEFTOVER_WITNESS_FINISHED");
    assert(toolResult(ports[0].session, "jev-leftover-witness")?.isError);
    assert.equal(dialogCount, beforeDialogs + 1, "unbound ask should reach human No");
    assert.equal(fetchCalls.length, beforeFetch);
    assert.equal(globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")].has(ports[0].session.sessionId), false, "Run exit must retire the manual-only witness");
    item.run_id = run.run_id;
  });

  for (const channel of ["pi-harness:approval:admitted", "pi-harness:approval:started",
    "pi-harness:approval:invalidated", "pi-harness:approval:finished"]) {
    assert(report.approval_events.some((event) => event.channel === channel),
      `Missing real approval lifecycle event: ${channel}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    const shutdown = await controller.shutdown(10_000);
    report.cleanup.push({ target: "controller", ...shutdown });
    assert.equal(shutdown.closed, true);
  } catch (error) {
    primaryError ??= error;
    report.cleanup.push({ target: "controller", error: String(error) });
  }
  try {
    await abortAndWaitForIdle(parent);
    const disposed = await disposeChild(parent, parentBus);
    report.cleanup.push({ target: "parent", ...disposed,
      permission_removed: !permission.getPermissionsService(parent.sessionId) });
    assert(disposed.shutdownExited && disposed.errors.length === 0);
    assert.equal(permission.getPermissionsService(parent.sessionId), undefined);
  } catch (error) {
    primaryError ??= error;
    report.cleanup.push({ target: "parent", error: String(error) });
  }
  report.network_attempts = networkAttempts;
  report.dialog_count = dialogCount;
  report.fetch_count = fetchCalls.length;
  report.approval_event_channels = [...new Set(report.approval_events.map((event) => event.channel))];
  report.error = primaryError ? String(primaryError) : undefined;
  report.status = !primaryError && networkAttempts.length === 0 &&
    report.cases.every((item) => item.status === "passed") ? "passed" : "failed";
  save();
}

console.log(`Jev approval evidence: ${reportPath}`);
if (primaryError) throw primaryError;
