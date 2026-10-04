import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { PiRunJournal as SdkRunHistory } from "../../dist/history/run-journal.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { blockedDelegationToolNames as blockedDelegationTools, managementToolNames as delegationTools } from "../../dist/tools/tool-names.js";
import { createChildTools as createCommunicationTools } from "../../dist/tools/child-tools.js";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { abortAndWaitForIdle, controlledProvider, loadHost } from "../support/host.mjs";

const [piExecutable, generatedRoot, outputRoot] = process.argv.slice(2);
assert(piExecutable && generatedRoot && outputRoot, "Use script/check-pi-harness.sh");
const host = await loadHost(piExecutable), { sdk, ai, permission } = host;
const report = { authority: host.authority, versions: host.versions, claims: [], parent_shutdowns: [], limitations: [
  "Actual SDK tool validation/readiness handshake with loaded permission/guard; independent gate enforcement is not established here",
  "Controlled provider IO, not a real model or remote schema acceptance",
  "No production admission, Luna consumer, service registry, UI, migration, or backend installation",
  "Reload here occurs only after explicit owner shutdown; stale handles are not a live-child reload veto",
  "Parent abort probe uses the public SDK API, not TUI Esc/signals or an uncooperative external process",
  "Registered catalogue lookup is not an auth/availability guarantee; no private auth/history is read",
] };
const save = () => writeFileSync(join(outputRoot, "tool-layer.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const claim = (name, facts = {}) => { report.claims.push({ name, ...facts }); save(); console.log(`PASS tool layer: ${name}`); };
const until = async (condition, message = "fixture condition timed out") => {
  const deadline = performance.now() + 10000;
  while (!condition()) { assert(performance.now() < deadline, message); await new Promise((resolve) => setImmediate(resolve)); }
};
const cwd = join(outputRoot, "tools-project"), sessionDirectory = join(outputRoot, "tools-sessions");
for (const path of [cwd, sessionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
const profiles = Object.fromEntries(["editor", "reader", "researcher"].map((name) => {
  const definition = readFileSync(join(generatedRoot, "agents", `${name}.md`), "utf8");
  const declared = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
  // A fixture-selected subset of available built-ins, not a new agent parser or
  // permission policy. The exact generated definition/digest still reaches SDK.
  const tools = declared.filter((tool) => ["read", "bash", "write", "edit", "grep", "find", "ls"].includes(tool));
  return [name, { definition, tools: [...tools, "alert_parent", "ask_parent"] }];
}));
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
const provider = controlledProvider(ai);
provider.config.models.push({ ...provider.config.models[0], id: "reasoning", reasoning: true });
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled"), reasoning = runtime.getModel("harness-fixture", "reasoning");
assert(model && reasoning); assert(ai.getSupportedThinkingLevels(reasoning).includes("high"));
const route = (name, id, version = "v1") => ({ name, version, digest: digest(`${name}:${version}:${id}`),
  models: { d1: id, d2: id, d3: id, d4: id, d5: id },
  effort: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" },
  effort_defaults: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" }, effort_overrides: {} });
let activePreset = route("controlled-team", "harness-fixture/controlled");
const parentBus = sdk.createEventBus(), parentManager = sdk.SessionManager.create(cwd, sessionDirectory);
const ownerOptions = { directory: join(outputRoot, "tools-owners"), owner_id: parentManager.getSessionId(), flock: process.env.P0_FLOCK };
const owner = await ExecutionOwner.open(ownerOptions);
const children = [], receipt = `${"文🚀".repeat(2000)}END_OF_SYNTHETIC_RECEIPT`;
const childExit = Promise.withResolvers(), cleanupExit = Promise.withResolvers();
const abortProbe = { wait: {}, cleanupEntered: false };
// This probe deliberately holds extension cleanup while making host assertions.
// Keep a 10s fixture work budget inside an explicit 15s adapter deadline; the
// core's ordinary 5s default is unchanged.
const probeCleanupTimeoutMs = 15000, probeGateBudgetMs = 10000;
let parent, parentCtx, tools, controller, request, primaryError, mutateNext = false, leakedParentCalls = 0;
const isParent = (call) => call.context.systemPrompt.includes("SYNTHETIC_TOOL_LAYER_PARENT");
const messageText = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const inheritedMarker = "SYNTHETIC_UNIQUE_INHERITED_CONTEXT";
const inheritedOccurrences = (messages) => messages.reduce((count, message) => count + messageText(message).split(inheritedMarker).length - 1, 0);
provider.respond(async (call) => {
  if (isParent(call)) {
    assert(request, "parent IO outside the requested fixture step");
    if (!request.sent) { request.sent = true; return { tools: [{ type: "toolCall", id: request.id, name: request.name, arguments: request.args }] }; }
    return { text: "PARENT_STEP_FINISHED" };
  }
  const lastUser = call.context.messages.filter((m) => m.role === "user").at(-1);
  const prompt = messageText(lastUser);
  const last = call.context.messages.at(-1);
  if (prompt?.includes("ASK_FACTOR")) {
    if (last?.role === "toolResult" && last.toolName === "ask_parent") return { text: "QUESTION_RECORDED" };
    if (last?.role === "toolResult" && last.toolName === "alert_parent") return { tools: [{ type: "toolCall", id: "child-question", name: "ask_parent", arguments: { question: "What is the factor?" } }] };
    return { tools: [{ type: "toolCall", id: "child-alert", name: "alert_parent", arguments: { message: "SYNTHETIC_ALERT_BEFORE_WAIT" } }] };
  }
  if (prompt?.includes("ANSWER_FACTOR")) return { text: receipt };
  if (prompt?.includes("HOLD_AFTER_PARENT_ABORT")) {
    abortProbe.childSignal = call.signal;
    await childExit.promise; // Deliberately ignore abort until the fixture releases execution.
    return { text: "CHILD_EXIT_CONFIRMED", reason: call.signal.aborted ? "aborted" : "stop" };
  }
  if (prompt?.includes("BLOCK_FOR_CANCEL")) return new Promise((resolve) => {
    const stop = () => resolve({ text: "PARTIAL_CANCELLED", reason: "aborted" });
    if (call.signal.aborted) stop(); else call.signal.addEventListener("abort", stop, { once: true });
  });
  if (prompt?.includes("TRY_PARENT_CONTROL") && last?.role !== "toolResult") return {
    tools: [{ type: "toolCall", id: "forbidden-management", name: "agent_spawn", arguments: { agent: "not-an-agent", prompt: "must not route", profile: "reader", reasoning_difficulty: 1 } }],
  };
  return { text: "SYNTHETIC_CHILD_DONE" };
});
controller = await Controller.open({ owner, concurrency: 2, resident_limit: 2, createSession: async (agent) => {
  const profile = profiles[agent.settings.profile]; assert.equal(digest(profile.definition), agent.settings.definition_digest);
  const bus = sdk.createEventBus(), gate = new RunInputGate(); let callbacks, context;
  const customs = [...createCommunicationTools(() => callbacks, gate),
    ...tools.map((tool) => ({ ...tool, execute: async () => { leakedParentCalls++; throw new Error("PARENT_CONTROL_LEAK"); } })),
    ...blockedDelegationTools.filter((name) => !delegationTools.includes(name)).map((name) => ({
      name, label: name, description: "Retired management canary", parameters: Type.Object({}),
      execute: async () => { leakedParentCalls++; throw new Error("RETIRED_PARENT_CONTROL_LEAK"); },
    }))];
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: bus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [host.permissionEntry, join(generatedRoot, "extensions/static-safety-guard.ts")],
    appendSystemPromptOverride: () => [profile.definition.split(/^---\s*$/m).slice(2).join("\n").trim(), `<active_agent name="${agent.settings.profile}"/>`],
    extensionFactories: [(pi) => {
      pi.on("session_start", (_event, ctx) => { context = ctx; });
      pi.on("session_shutdown", async () => {
        if (agent.name !== "shutdown-probe") return;
        abortProbe.cleanupEntered = true;
        await cleanupExit.promise; // Execution exit and extension cleanup are distinct boundaries.
      });
    }, gate.extension] });
  await loader.reload();
  const manager = sdk.SessionManager.create(cwd, sessionDirectory, { parentSession: parent.sessionFile });
  manager.appendCustomEntry("active_agent", { name: agent.settings.profile });
  // Controller prefixes the snapshot on the first Run; do not also seed it here.
  const assembled = await assembleChild({ createSession: sdk.createAgentSession,
    options: { cwd, agentDir: generatedRoot, resourceLoader: loader, settingsManager: settings(), sessionManager: manager,
      modelRuntime: runtime, model: runtime.getModel(agent.settings.provider, agent.settings.model), thinkingLevel: agent.settings.thinking,
      tools: agent.settings.tools, customTools: customs }, parentBus, childBus: bus, parentSessionId: parent.sessionId,
    profile: agent.settings.profile, definitionDigest: agent.settings.definition_digest, getPermissionsService: permission.getPermissionsService });
  assert.equal(assembled.session.thinkingLevel, agent.settings.thinking);
  assembled.session.setActiveToolsByName([...agent.settings.tools, ...blockedDelegationTools]);
  assert.deepEqual(assembled.session.getActiveToolNames().sort(), [...agent.settings.tools].sort(), "SDK excludes management even after reactivation attempt");
  const port = new SdkRunPort({ session: assembled.session, parentBus, gate,
    ...(agent.name === "shutdown-probe" ? { shutdownTimeoutMs: probeCleanupTimeoutMs } : {}),
    history: new SdkRunHistory({ parent: parent.sessionManager, session: manager }),
    readiness: () => requireReadiness(bus, permission.getPermissionsService, assembled.session.sessionId, agent.settings.profile, agent.settings.definition_digest) });
  children.push({ agent, session: assembled.session, context, guard: assembled.guard });
  return { session_id: port.session_id, history: port.history, canInput: () => port.canInput(),
    run: async (prompt, cb) => { callbacks = cb; try { return await port.run(prompt, cb); } finally { callbacks = undefined; } },
    steer: (text, valid) => port.steer(text, valid), stop: () => port.stop(), clearInputs: () => port.clearInputs(),
    dispose: () => {
      if (agent.name === "shutdown-probe") abortProbe.cleanupStarted = performance.now();
      return port.dispose();
    } };
} });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: parentBus,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [host.permissionEntry], systemPromptOverride: () => "SYNTHETIC_TOOL_LAYER_PARENT",
  extensionFactories: [(pi) => {
    pi.on("session_start", (_event, ctx) => {
      parentCtx = ctx;
      if (tools) return; // Deliberately do not rebind an old owner after reload.
      tools = createOwnerTools({ controller, context: ctx, profiles, getSupportedThinkingLevels: ai.getSupportedThinkingLevels,
        getPreset: () => structuredClone(activePreset) });
      for (const tool of tools) pi.registerTool(!["agent_wait", "agent_spawn"].includes(tool.name) ? tool : {
        ...tool, execute: async (...args) => {
          const pending = tool.execute(...args);
          if (args[0] !== "parent-abort-wait") return pending;
          // Observe the real tool signal. The test also waits for child IO,
          // which proves acceptance occurred before it aborts this combined wait.
          abortProbe.wait.signal = args[2];
          const result = await pending;
          abortProbe.wait.reply = JSON.parse(messageText(result));
          return result;
        },
      });
      pi.setActiveTools(tools.map((tool) => tool.name));
    });
    pi.on("session_shutdown", () => { report.parent_shutdowns.push(controller.stats()); });
    pi.on("tool_call", (event) => {
      if (mutateNext && event.toolName === "agent_spawn") { mutateNext = false; event.input.owner_id = "FORGED_AFTER_SCHEMA_VALIDATION"; }
    });
  }] });
await loader.reload();
({ session: parent } = await sdk.createAgentSession({ cwd, agentDir: generatedRoot, resourceLoader: loader, settingsManager: settings(),
  sessionManager: parentManager, modelRuntime: runtime, model, thinkingLevel: "off", tools: delegationTools }));
const bindErrors = [];
await parent.bindExtensions({ onError: (error) => bindErrors.push(error.error) });
report.bind_errors = bindErrors; save(); assert.deepEqual(bindErrors, []);
assert(permission.getPermissionsService(parent.sessionId));
assert.deepEqual(parent.getActiveToolNames().sort(), [...delegationTools].sort());
let sequence = 0;
async function invoke(name, args, { id = `parent-call-${sequence++}`, error, prompt = "SYNTHETIC_PARENT_CONTEXT" } = {}) {
  const before = parent.messages.length;
  request = { name, args: structuredClone(args), id, sent: false };
  await parent.prompt(prompt, { source: "extension", expandPromptTemplates: false });
  await parent.waitForIdle(); request = undefined;
  const result = parent.messages.slice(before).find((m) => m.role === "toolResult" && m.toolCallId === id);
  assert(result, `missing tool result: ${name}`);
  const value = JSON.parse(result.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
  assert.equal(result.isError, !!error, JSON.stringify(value)); if (error) assert.equal(value.error.code, error);
  return value;
}
// Agent names are the model-facing handle: a lowercase slug of the fixture prompt.
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
const newTask = (prompt, profile = "reader", rest = {}) => ({ agent: slug(prompt), prompt, label: prompt, profile,
  reasoning_difficulty: 3, ...rest });
const runOf = (agent) => controller.findAgent(agent).run_id;
const settled = (agent) => until(() => ["completed", "needs_input", "failed", "cancelled"].includes(controller.view(runOf(agent)).status));
try {
  const { getJsonSchemaToolParameters } = await import(pathToFileURL(join(host.root, "node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js")));
  for (const tool of tools) assert.equal(getJsonSchemaToolParameters(tool, true).type, "object");
  assert.throws(() => getJsonSchemaToolParameters({ name: "union", parameters: Type.Union([
    Type.Object({ create: Type.String() }), Type.Object({ agent: Type.String() }),
  ]) }, true));
  claim("simple schemas pass installed strict conversion; object-union schema does not (not remote API evidence)");

  await invoke("agent_spawn", { ...newTask("MUST_NOT_START"), agent_id: "wrong-branch" }, { error: "INVALID_PARAMETERS" });
  await invoke("agent_spawn", newTask("MUST_NOT_START", "unknown"), { error: "INVALID_PROFILE" });
  for (const extra of [{ model: "controlled" }, { thinking: "max" }, { strength: "d3" }, { role: "reviewer" }, { agent: "Not A Name" }]) {
    await invoke("agent_spawn", newTask("MUST_NOT_START", "editor", extra), { error: "INVALID_PARAMETERS" });
  }
  await invoke("agent_spawn", newTask("MUST_NOT_START", "editor", { reasoning_difficulty: 0 }), { error: "INVALID_DIFFICULTY" });
  await invoke("agent_send", { agent: "must-not-start", message: "MUST_NOT_START" }, { error: "AGENT_NOT_FOUND" });
  await invoke("agent_read", { agent: "must-not-start", limit: 10 }, { error: "INVALID_PARAMETERS" });
  mutateNext = true;
  await invoke("agent_spawn", newTask("MUST_NOT_START"), { error: "INVALID_PARAMETERS" });
  assert.equal(children.length, 0); assert.equal(controller.list().length, 0);
  assert(provider.requests.every(isParent));
  claim("actual SDK prepare/execute rejection, including mutation after schema validation: zero child factory/IO");

  const firstArgs = newTask("ASK_FACTOR", "reader", { agent: "orca", inherit_context: true, label: "Find the missing factor 🚀" });
  const first = await invoke("agent_spawn", firstArgs, { id: "stable-call", prompt: inheritedMarker }); await settled("orca");
  const firstRun = runOf("orca");
  assert.equal(first.reason, "snapshot");
  assert.deepEqual(first.action, { type: "agent_spawn", agent: "orca", task: 1 });
  assert.equal(first.agents[0].agent, "orca"); assert.equal(first.agents[0].task, 1);
  assert.equal(JSON.stringify(first).includes(firstRun), false, "a receipt carries no internal Run UUID");
  assert.equal(controller.view(firstRun).status, "needs_input");
  const roster = await invoke("agent_list", {});
  assert.deepEqual([roster.agents[0].agent, roster.agents[0].label, roster.agents[0].has_question], ["orca", firstArgs.label, true]);
  assert.equal(JSON.stringify(roster).includes(firstRun), false);
  claim("actual SDK roster names Agents and shows task labels on demand, without internal IDs");
  const waited = await invoke("agent_wait", { agents: ["orca"] });
  assert.equal(waited.reason, "question");
  assert.deepEqual([...(first.alerts ?? []), ...(waited.alerts ?? [])],
    [{ agent: "orca", task: 1, label: firstArgs.label, message: "SYNTHETIC_ALERT_BEFORE_WAIT" }]);
  assert.equal(waited.alerts_pending, 0); assert.equal(controller.view(firstRun).pending_messages, 0);
  assert.equal(waited.agents[0].question, "What is the factor?"); assert.equal(waited.agents[0].question_truncated, undefined);
  assert.match(waited.agents[0].question_id, /^q_[0-9a-f]{32}$/);
  assert.equal("label" in waited.agents[0], false);
  const questionResult = await invoke("agent_read", { agent: "orca" });
  assert.equal(questionResult.reason, "snapshot");
  const question = questionResult.agents[0];
  assert.equal(question.question, "What is the factor?"); assert.equal(question.result, "QUESTION_RECORDED");
  assert.equal(question.question_id, waited.agents[0].question_id);
  assert.equal(controller.view(firstRun).effective_settings.context_mode, "text_snapshot");
  assert.equal(children[0].agent.settings.context_snapshot.split(inheritedMarker).length - 1, 1);
  const firstRequests = provider.requests.filter((call) => !isParent(call)); assert(firstRequests.length > 0);
  for (const call of firstRequests) assert.equal(inheritedOccurrences(call.context.messages), 1, "snapshot reaches actual child IO exactly once");
  claim("real child alert/ask finish before first wait; top-level alerts and explicit pending question identity are distinct");

  await parent.setModel(reasoning); parent.setThinkingLevel("high");
  const duplicate = await invoke("agent_spawn", { ...firstArgs, wait_ms: 300000 }, { id: "stable-call" });
  assert.equal(duplicate.reason, "question");
  assert.deepEqual(duplicate.action, first.action);
  assert.equal(duplicate.agents[0].status, "needs_input"); assert.equal(duplicate.agents[0].question, "What is the factor?");
  assert.equal(duplicate.alerts, undefined, "acceptance replay does not restore a consumed alert");
  assert.equal(runOf("orca"), firstRun); assert.equal(children.length, 1);
  await invoke("agent_spawn", { ...firstArgs, prompt: "CONFLICT" }, { id: "stable-call", error: "REQUEST_CONFLICT" });
  await invoke("agent_send", { agent: "orca", message: "ANSWER_FACTOR", model: "other" }, { error: "INVALID_PARAMETERS" });
  await invoke("agent_send", { agent: "orca", message: "ANSWER_FACTOR", reasoning_difficulty: 4 }, { error: "INVALID_PARAMETERS" });
  await invoke("agent_spawn", newTask("ANSWER_FACTOR", "editor", { agent: "orca" }), { error: "AGENT_EXISTS" });
  const beforeAnswer = provider.requests.length;
  await invoke("agent_run", { agent: "orca", prompt: "ANSWER_FACTOR 3" }, { error: "PENDING_QUESTION" });
  const notDelivered = await invoke("agent_send", { agent: "orca", message: "ANSWER_FACTOR 3" });
  assert.deepEqual(notDelivered.action, { type: "agent_send", agent: "orca", task: 1, delivery: "not_delivered" });
  assert.equal(runOf("orca"), firstRun, "send never starts a question continuation");
  for (const extra of [{ reasoning_difficulty: 4 }, { difficulty: 4 }, { profile: "editor" }, { label: "replacement" }]) {
    await invoke("agent_answer", { agent: "orca", question_id: question.question_id, answer: "ANSWER_FACTOR 3", ...extra },
      { error: "INVALID_PARAMETERS" });
  }
  const answered = await invoke("agent_answer", { agent: "orca", question_id: question.question_id, answer: "ANSWER_FACTOR 3", wait_ms: 300000 });
  assert.equal(answered.reason, "done");
  assert.deepEqual(answered.action, { type: "agent_answer", agent: "orca", task: 2 });
  assert.equal(answered.agents[0].status, "completed"); assert.equal(answered.agents[0].result, receipt, "a lone result arrives whole in the combined wait");
  const answerRequests = provider.requests.slice(beforeAnswer).filter((call) => !isParent(call)); assert(answerRequests.length > 0);
  for (const call of answerRequests) {
    assert.equal(inheritedOccurrences(call.context.messages), 1, "reuse retains only the original inherited context in history");
    assert.equal(messageText(call.context.messages.filter((message) => message.role === "user").at(-1)), "ANSWER_FACTOR 3", "reuse does not prefix new input with the snapshot");
  }
  claim("inherited context reaches actual child IO once, with no new snapshot prefix on reuse", { first_requests: firstRequests.length, reuse_requests: answerRequests.length });
  const answeredRun = runOf("orca"); assert.notEqual(answeredRun, firstRun);
  assert.equal("settings" in answered.agents[0], false, "task rows carry no routing");
  const answeredRoute = controller.view(answeredRun).effective_settings;
  assert.equal(answeredRoute.preset, "controlled-team"); assert.equal(answeredRoute.parent_thinking, "off");
  assert.equal(answeredRoute.thinking, "off"); assert.equal(answeredRoute.thinking_resolution, "identity");
  assert.equal(children.length, 1);
  const page = (await invoke("agent_read", { agent: "orca", max_chars: 1000 })).agents[0]; assert(page.next_cursor);
  const rest = (await invoke("agent_read", { agent: "orca", cursor: page.next_cursor })).agents[0];
  assert.equal(page.result + rest.result, receipt); assert.equal(rest.next_cursor, undefined);
  assert.equal(controller.getResult(firstRun).text, "QUESTION_RECORDED", "the earlier result is retained");
  claim("same tool ID survives changed parent defaults; reuse answers the question with fixed settings and cursors reconstruct exact final text");

  await invoke("agent_spawn", newTask("MUST_NOT_START_AFTER_PARENT_THINKING_CHANGE"), { error: "THINKING_INCOMPATIBLE" });
  activePreset = route("reasoning-team", "harness-fixture/reasoning", "v2");
  const blocking = await invoke("agent_spawn", newTask("BLOCK_FOR_CANCEL", "editor"));
  await until(() => children.length === 2 && children[1].session.isStreaming);
  assert.equal(blocking.reason, "snapshot");
  assert.deepEqual(blocking.action, { type: "agent_spawn", agent: "block-for-cancel", task: 1 });
  assert.equal(blocking.agents[0].status, "running");
  const blockingRoute = controller.view(runOf("block-for-cancel")).effective_settings;
  assert.equal(blockingRoute.preset, "reasoning-team"); assert.equal(blockingRoute.parent_thinking, "high");
  assert.equal(blockingRoute.thinking, "high"); assert.equal(blockingRoute.thinking_resolution, "identity");
  assert.equal((await invoke("agent_send", { agent: "block-for-cancel", message: "SYNTHETIC_STEERING" })).action.delivery, "steered");
  await invoke("agent_spawn", newTask("TRY_PARENT_CONTROL", "reader"), { error: "RESIDENT_LIMIT" });
  assert.equal((await invoke("agent_kill", { agent: "orca" })).status, "killed");
  const orcaId = controller.findAgent("orca").agent_id;
  const releasedRuns = [...controller.runs.values()].filter((run) => run.record.agent_id === orcaId);
  assert.equal(releasedRuns.length, 2);
  assert(releasedRuns.every((run) => run.session === undefined), "historical Runs do not retain the real SDK port wrapper");
  await invoke("agent_spawn", newTask("TRY_PARENT_CONTROL", "reader")); await settled("try-parent-control");
  assert.equal(leakedParentCalls, 0);
  assert(children[2].session.messages.some((m) => m.role === "toolResult" && m.toolName === "agent_spawn" && m.isError));
  await invoke("agent_interrupt", { agent: "block-for-cancel" }); await settled("block-for-cancel");
  assert.equal(controller.view(runOf("block-for-cancel")).status, "cancelled");
  assert.equal((await invoke("agent_read", { agent: "orca" })).agents[0].result, receipt, "a released Agent's last result stays readable");
  const listed = await invoke("agent_list", {});
  assert.deepEqual(listed.agents.map((row) => row.agent), ["block-for-cancel", "try-parent-control"]);
  assert.deepEqual(listed.killed, ["orca"]);
  const batch = await invoke("agent_wait", { agents: ["orca", "block-for-cancel", "try-parent-control"] });
  assert.equal(batch.reason, "task_issue", "an interrupted task takes priority over the all-terminal done condition");
  assert(batch.agents.reduce((count, entry) => count + (entry.result?.length ?? 0) + (entry.question?.length ?? 0), 0) <= 16384);
  assert.deepEqual(batch.agents.map((entry) => entry.status), ["completed", "interrupted", "completed"]);
  claim("actual SDK waits return results by Agent name within the shared text budget");
  claim("new Agent takes the active preset while the parent model stays independent; kill frees hard capacity; messages and interrupts are Agent-scoped; both managed profiles have real readiness", {
    profiles: children.map((c) => c.agent.settings.profile), parent_control_calls_from_child: leakedParentCalls,
    released_run_port_refs: releasedRuns.filter((run) => run.session !== undefined).length,
  });

  const oldTool = tools.find((t) => t.name === "agent_list"), oldCtx = parentCtx;
  await assert.rejects(oldTool.execute("foreign", {}, undefined, undefined, children[2].context), /STALE_OWNER_CONTEXT/);
  const preAborted = new AbortController(); preAborted.abort();
  const waitTool = tools.find((t) => t.name === "agent_wait");
  const interrupted = await waitTool.execute("wait-abort", { agents: ["try-parent-control"] }, preAborted.signal, undefined, oldCtx);
  assert.equal(JSON.parse(interrupted.content[0].text).reason, "aborted");
  // Reuse this fixture's real tool/SDK assembly instead of another host runner.
  await invoke("agent_kill", { agent: "block-for-cancel" });
  await invoke("agent_kill", { agent: "try-parent-control" });
  request = { name: "agent_spawn", id: "parent-abort-wait", sent: false,
    args: newTask("HOLD_AFTER_PARENT_ABORT", "reader", { agent: "shutdown-probe", wait_ms: 300000 }) };
  let waitPromptError;
  const waitPrompt = parent.prompt("WAIT_FOR_HELD_CHILD", { source: "extension", expandPromptTemplates: false })
    .catch((error) => { waitPromptError = error; });
  await until(() => abortProbe.wait.signal && abortProbe.childSignal);
  const held = controller.list().find((run) => run.name === "shutdown-probe"); assert(held);
  const heldChild = children.at(-1).session, parentService = permission.getPermissionsService(parent.sessionId);
  const childService = permission.getPermissionsService(heldChild.sessionId);
  assert(parentService && childService);
  assert.equal(abortProbe.wait.signal.aborted, false);
  await parent.abort(); await waitPrompt; await parent.waitForIdle(); request = undefined;
  assert.equal(waitPromptError, undefined);
  assert.equal(abortProbe.wait.signal.aborted, true);
  assert.equal(abortProbe.wait.reply.reason, "aborted");
  assert.deepEqual(abortProbe.wait.reply.action, { type: "agent_spawn", agent: "shutdown-probe", task: 1 });
  assert.equal(abortProbe.wait.reply.agents[0].agent, "shutdown-probe");
  assert.equal(abortProbe.wait.reply.agents[0].status, "running");
  assert.equal(abortProbe.wait.reply.alerts, undefined, "an aborted observation consumes no alerts");
  assert.equal(abortProbe.childSignal.aborted, false, "parent abort must not pretend to cancel a managed child");
  assert.equal(parent.isIdle, true); assert.equal(heldChild.isIdle, false);
  assert.equal(controller.view(held.run_id).status, "running");
  assert.equal(controller.view(held.run_id).execution_exited, false);
  assert.equal(controller.stats().active, 1); assert.equal(controller.stats().resident, 1);
  assert.equal(permission.getPermissionsService(heldChild.sessionId), childService);
  assert.equal(permission.getPermissionsService(parent.sessionId), parentService);
  assert.equal(report.parent_shutdowns.length, 0);
  await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
  claim("actual parent SDK abort preserves accepted IDs and interrupts the combined wait, not child execution or owner ownership", {
    run_id: held.run_id, wait: abortProbe.wait.reply, stats: controller.stats(), parent_idle: parent.isIdle,
    child_idle: heldChild.isIdle, competing_owner_rejected: true,
  });

  const closing = await controller.shutdown(20);
  assert.equal(closing.closed, false); assert.equal(closing.active, 1); assert.equal(closing.resident, 1);
  assert.equal(closing.cleanup_uncertain, false);
  assert.equal(abortProbe.childSignal.aborted, true);
  assert.equal(controller.view(held.run_id).execution_exited, false);
  assert.equal(controller.view(held.run_id).status, "cancelling");
  const factoriesBefore = children.length;
  await invoke("agent_spawn", newTask("MUST_NOT_START_AFTER_CLOSE"), { error: "OWNER_CLOSED" });
  assert.equal(children.length, factoriesBefore);
  await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/);
  assert.equal(permission.getPermissionsService(parent.sessionId), parentService);
  assert.equal(report.parent_shutdowns.length, 0);
  claim("shutdown deadline keeps the live child slot/reservation/lock and seals new admission", { stats: closing, run: controller.view(held.run_id) });

  const checkCleanupWindow = () => {
    const elapsed_ms = performance.now() - abortProbe.cleanupStarted;
    report.cleanup_probe = { adapter_timeout_ms: probeCleanupTimeoutMs, gate_budget_ms: probeGateBudgetMs,
      hook_entered: abortProbe.cleanupEntered, elapsed_ms };
    assert(elapsed_ms < probeGateBudgetMs, `FIXTURE_CLEANUP_GATE_BUDGET_EXCEEDED: ${JSON.stringify(report.cleanup_probe)}`);
  };
  childExit.resolve();
  await until(() => abortProbe.cleanupStarted !== undefined, "fixture timed out waiting for child cleanup to start");
  await until(() => { checkCleanupWindow(); return abortProbe.cleanupEntered; });
  assert.equal(heldChild.isIdle, true); assert.equal(controller.view(held.run_id).execution_exited, true);
  assert.equal(controller.view(held.run_id).status, "cancelled");
  const cleaning = await controller.shutdown(20); checkCleanupWindow();
  assert.equal(cleaning.active, 0); assert.equal(cleaning.cleaning, 1); assert.equal(cleaning.resident, 1);
  assert.equal(cleaning.closed, false); assert.equal(cleaning.cleanup_uncertain, false);
  await assert.rejects(ExecutionOwner.open(ownerOptions), /OWNER_LOCKED/); checkCleanupWindow();
  assert.equal(permission.getPermissionsService(parent.sessionId), parentService);
  assert.equal(report.parent_shutdowns.length, 0);
  cleanupExit.resolve(); report.shutdown = await controller.shutdown(10000);
  assert.equal(report.shutdown.closed, true);
  for (const key of ["active", "queued", "resident", "finalizing", "cleaning"]) assert.equal(report.shutdown[key], 0);
  assert.equal(report.shutdown.cleanup_uncertain, false);
  assert.equal(permission.getPermissionsService(heldChild.sessionId), undefined);
  const reacquired = await ExecutionOwner.open(ownerOptions); reacquired.close();
  claim("child exit alone cannot close owner; confirmed cleanup releases lock before parent teardown", {
    during_cleanup: cleaning, after_cleanup: report.shutdown, competing_owner_reacquired: true,
  });
  const originalId = parent.sessionId, originalManager = parent.sessionManager;
  await parent.reload();
  assert.equal(parent.sessionId, originalId); assert.equal(parent.sessionManager, originalManager); assert.notEqual(parentCtx, oldCtx);
  await assert.rejects(oldTool.execute("stale-old", {}, undefined, undefined, oldCtx), /STALE_OWNER_CONTEXT/);
  await assert.rejects(oldTool.execute("stale-new", {}, undefined, undefined, parentCtx), /STALE_OWNER_CONTEXT/);
  claim("foreign SDK context and captured old tool reject; same-ID reload cannot authorize an old closure (owner already closed)");
} catch (error) {
  primaryError = error; report.failure_reason = String(error);
  try { save(); } catch (saveError) { report.failure_save_error = String(saveError); }
} finally {
  // Fixture rescue only; it cannot turn an assertion failure into a pass.
  childExit.resolve(); cleanupExit.resolve();
  report.cleanup_errors = [];
  let parentIdle = false, ownerClosed = false;
  try { await abortAndWaitForIdle(parent); parentIdle = true; }
  catch (error) { report.cleanup_errors.push(`parent abort: ${String(error)}`); }
  try {
    report.shutdown = await controller.shutdown(10000);
    ownerClosed = report.shutdown.closed === true;
    if (!ownerClosed) report.cleanup_errors.push("OWNER_NOT_CLOSED");
  } catch (error) { report.cleanup_errors.push(`owner shutdown: ${String(error)}`); }
  // This gate is unconditional, even when a probe already failed. Never force
  // unlock or tear down the parent merely to avoid shadowing the primary error.
  if (ownerClosed && parentIdle) {
    try {
      report.parent_cleanup = await disposeChild(parent, parentBus);
      assert.equal(report.parent_cleanup.shutdownExited, true);
      assert.deepEqual(report.parent_cleanup.errors, []);
      assert(report.parent_shutdowns.length > 0);
      assert(report.parent_shutdowns.every((state) => state.closed === true), "parent session_shutdown (reload or final teardown) before owner closed");
    } catch (error) { report.cleanup_errors.push(`parent teardown: ${String(error)}`); }
  } else report.parent_cleanup = { skipped: ownerClosed ? "PARENT_ABORT_NOT_CONFIRMED" : "OWNER_NOT_CLOSED" };
  if (report.cleanup_errors.length) primaryError ??= new Error(`CLEANUP_UNCERTAIN: ${report.cleanup_errors.join("; ")}`);
  report.child_factory_count = children.length;
  report.controlled_parent_requests = provider.requests.filter(isParent).length;
  report.controlled_child_requests = provider.requests.length - report.controlled_parent_requests;
  report.passed = primaryError === undefined;
  report.failure_reason = primaryError === undefined ? undefined : String(primaryError);
  try { save(); }
  catch (saveError) {
    if (primaryError === undefined) primaryError = saveError;
    else console.error(`Failed to save tool report without replacing the primary error: ${String(saveError)}`);
  }
}
if (primaryError !== undefined) throw primaryError;
