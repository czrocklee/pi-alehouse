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
const profiles = Object.fromEntries(["editor", "reader"].map((name) => {
  const definition = readFileSync(join(generatedRoot, "agents", `${name}.md`), "utf8");
  const declared = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
  // A fixture-selected subset of available built-ins, not a new agent parser or
  // permission policy. The exact generated definition/digest still reaches SDK.
  const tools = declared.filter((tool) => ["read", "bash", "write", "edit", "grep", "find", "ls"].includes(tool));
  return [name, { definition, tools: [...tools, "notify_parent", "ask_parent"] }];
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
  models: { light: id, standard: id, strong: id }, thinking: { light: {}, standard: {}, strong: {} },
  effort: { light: "inherit", standard: "inherit", strong: "inherit" },
  effort_defaults: { light: "inherit", standard: "inherit", strong: "inherit" }, effort_overrides: {} });
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
    if (last?.role === "toolResult" && last.toolName === "notify_parent") return { tools: [{ type: "toolCall", id: "child-question", name: "ask_parent", arguments: { question: "What is the factor?" } }] };
    return { tools: [{ type: "toolCall", id: "child-notice", name: "notify_parent", arguments: { message: "SYNTHETIC_PROGRESS_BEFORE_WAIT" } }] };
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
    tools: [{ type: "toolCall", id: "forbidden-management", name: "resume_agent", arguments: { agent_id: "not-an-agent", prompt: "must not route" } }],
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
      for (const tool of tools) pi.registerTool(!["wait_runs", "spawn_agent"].includes(tool.name) ? tool : {
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
      if (mutateNext && event.toolName === "spawn_agent") { mutateNext = false; event.input.owner_id = "FORGED_AFTER_SCHEMA_VALIDATION"; }
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
const newTask = (prompt, profile = "reader", rest = {}) => ({ prompt, description: prompt, profile,
  difficulty: 3, ...rest });
const settled = (run) => until(() => ["completed", "needs_input", "failed", "cancelled"].includes(controller.view(run.run_id).status));
try {
  const { getJsonSchemaToolParameters } = await import(pathToFileURL(join(host.root, "node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js")));
  for (const tool of tools) assert.equal(getJsonSchemaToolParameters(tool, true).type, "object");
  assert.throws(() => getJsonSchemaToolParameters({ name: "union", parameters: Type.Union([
    Type.Object({ create: Type.String() }), Type.Object({ agent_id: Type.String() }),
  ]) }, true));
  claim("simple schemas pass installed strict conversion; object-union schema does not (not remote API evidence)");

  await invoke("spawn_agent", { ...newTask("MUST_NOT_START"), agent_id: "wrong-branch" }, { error: "INVALID_PARAMETERS" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "unknown"), { error: "INVALID_PROFILE" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "editor", { model: "controlled" }), { error: "OBSOLETE_PARAMETER" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "editor", { thinking: "max" }), { error: "OBSOLETE_PARAMETER" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "editor", { strength: "standard" }), { error: "OBSOLETE_PARAMETER" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "editor", { difficulty: 0 }), { error: "INVALID_DIFFICULTY" });
  await invoke("spawn_agent", newTask("MUST_NOT_START", "editor", { role: "reviewer" }), { error: "OBSOLETE_PARAMETER" });
  await invoke("resume_agent", { resume: "old-id", prompt: "MUST_NOT_START" }, { error: "INVALID_PARAMETERS" });
  await invoke("read_run", { run_id: "old-id", limit: 10 }, { error: "INVALID_PARAMETERS" });
  mutateNext = true;
  await invoke("spawn_agent", newTask("MUST_NOT_START"), { error: "INVALID_PARAMETERS" });
  assert.equal(children.length, 0); assert.equal(controller.list().length, 0);
  assert(provider.requests.every(isParent));
  claim("actual SDK prepare/execute rejection, including mutation after schema validation: zero child factory/IO");

  const descriptionPrefix = "Find the missing factor: ".padEnd(255, "x");
  const firstArgs = newTask("ASK_FACTOR", "reader", {
    inherit_context: true, description: descriptionPrefix + "🚀ROSTER_ONLY_SUFFIX",
  });
  const first = await invoke("spawn_agent", firstArgs, { id: "stable-call", prompt: inheritedMarker }); await settled(first);
  assert.equal(controller.view(first.run_id).status, "needs_input");
  assert.equal(controller.view(first.run_id).pending_messages, 1);
  const roster = await invoke("list_agents", {});
  assert.equal(roster.agents[0].run_id, first.run_id); assert.equal(roster.agents[0].name, undefined);
  assert.equal(roster.agents[0].description, descriptionPrefix);
  assert.equal(roster.agents[0].description_truncated, true); assert.equal(roster.agents[0].description.isWellFormed(), true);
  assert.equal(controller.view(first.run_id).description, firstArgs.description);
  assert.equal("description" in first, false);
  claim("actual SDK list exposes unnamed task labels on demand with Unicode-safe bounded previews", {
    description_units: roster.agents[0].description.length, description_truncated: roster.agents[0].description_truncated,
  });
  const waited = await invoke("wait_runs", { run_ids: [first.run_id] });
  assert.equal(waited.reason, "condition"); assert.equal(waited.progress[0].text, "SYNTHETIC_PROGRESS_BEFORE_WAIT");
  assert.equal(waited.runs[0].has_question, true); assert.equal(waited.runs[0].question, "What is the factor?");
  assert.equal(waited.runs[0].question_complete, true); assert.equal("description" in waited.runs[0], false);
  const questionResult = await invoke("read_run", { run_id: first.run_id, max_chars: 16384 });
  assert.equal(questionResult.question, "What is the factor?"); assert.equal("description" in questionResult, false);
  assert.equal(controller.view(first.run_id).effective_settings.context_mode, "text_snapshot");
  assert.equal(children[0].agent.settings.context_snapshot.split(inheritedMarker).length - 1, 1);
  const firstRequests = provider.requests.filter((call) => !isParent(call)); assert(firstRequests.length > 0);
  for (const call of firstRequests) assert.equal(inheritedOccurrences(call.context.messages), 1, "snapshot reaches actual child IO exactly once");
  claim("real child notify/ask finish before first wait; terminal question and buffered notification are distinct");

  await parent.setModel(reasoning); parent.setThinkingLevel("high");
  const duplicate = await invoke("spawn_agent", { ...firstArgs, wait_ms: 300000 }, { id: "stable-call" });
  assert.equal(duplicate.wait.runs[0].question_complete, true); assert.equal(duplicate.status, "needs_input");
  assert.equal(duplicate.run_id, first.run_id); assert.equal(children.length, 1);
  await invoke("spawn_agent", { ...firstArgs, prompt: "CONFLICT" }, { id: "stable-call", error: "REQUEST_CONFLICT" });
  await invoke("resume_agent", { agent_id: first.agent_id, prompt: "ANSWER_FACTOR", model: "other" }, { error: "IMMUTABLE_SETTING" });
  await invoke("resume_agent", { agent_id: first.agent_id, prompt: "ANSWER_FACTOR", difficulty: 4 }, { error: "IMMUTABLE_SETTING" });
  await invoke("resume_agent", { agent_id: first.agent_id, prompt: "ANSWER_FACTOR", strength: "standard" }, { error: "IMMUTABLE_SETTING" });
  const beforeAnswer = provider.requests.length;
  const answered = await invoke("resume_agent", { agent_id: first.agent_id, prompt: "ANSWER_FACTOR 3", answer_to_run_id: first.run_id, wait_ms: 300000 });
  assert.equal(answered.status, "completed"); assert.equal(answered.wait.runs[0].status, "completed");
  assert(answered.wait.runs[0].next_cursor, "combined waits preserve result pagination");
  const answerRequests = provider.requests.slice(beforeAnswer).filter((call) => !isParent(call)); assert(answerRequests.length > 0);
  for (const call of answerRequests) {
    assert.equal(inheritedOccurrences(call.context.messages), 1, "reuse retains only the original inherited context in history");
    assert.equal(messageText(call.context.messages.filter((message) => message.role === "user").at(-1)), "ANSWER_FACTOR 3", "reuse does not prefix new input with the snapshot");
  }
  claim("inherited context reaches actual child IO once, with no new snapshot prefix on reuse", { first_requests: firstRequests.length, reuse_requests: answerRequests.length });
  assert.equal(answered.agent_id, first.agent_id); assert.notEqual(answered.run_id, first.run_id);
  assert.deepEqual(answered.settings, { profile: "reader", difficulty: 3 }, "replies carry only caller choices");
  const answeredRoute = controller.view(answered.run_id).effective_settings;
  assert.equal(answeredRoute.preset, "controlled-team"); assert.equal(answeredRoute.parent_thinking, "off");
  assert.equal(answeredRoute.thinking, "off"); assert.equal(answeredRoute.thinking_resolution, "identity");
  assert.equal(children.length, 1);
  const preview = await invoke("wait_runs", { run_ids: [answered.run_id], mode: "all" });
  const page = preview.runs[0]; assert(page.next_cursor);
  const rest = await invoke("read_run", { run_id: answered.run_id, cursor: page.next_cursor });
  assert.equal(page.text + rest.text, receipt); assert.equal(rest.complete, true);
  assert.equal((await invoke("read_run", { run_id: first.run_id })).text, "QUESTION_RECORDED");
  claim("same tool ID survives changed parent defaults; reuse/answer remains fixed and result cursor reconstructs exact final text");

  await invoke("spawn_agent", newTask("MUST_NOT_START_AFTER_PARENT_THINKING_CHANGE"), { error: "THINKING_INCOMPATIBLE" });
  activePreset = route("reasoning-team", "harness-fixture/reasoning", "v2");
  const blocking = await invoke("spawn_agent", newTask("BLOCK_FOR_CANCEL", "editor"));
  await until(() => children.length === 2 && children[1].session.isStreaming);
  assert.deepEqual(blocking.settings, { profile: "editor", difficulty: 3 });
  const blockingRoute = controller.view(blocking.run_id).effective_settings;
  assert.equal(blockingRoute.preset, "reasoning-team"); assert.equal(blockingRoute.parent_thinking, "high");
  assert.equal(blockingRoute.thinking, "high"); assert.equal(blockingRoute.thinking_resolution, "identity");
  const active = await invoke("steer_run", { run_id: blocking.run_id, message: "SYNTHETIC_STEERING" }); assert.equal(active.accepted, true);
  await invoke("spawn_agent", newTask("TRY_PARENT_CONTROL", "reader"), { error: "RESIDENT_LIMIT" });
  await invoke("release_agent", { agent_id: blocking.agent_id }, { error: "AGENT_BUSY" });
  assert.equal((await invoke("release_agent", { agent_id: first.agent_id })).released, true);
  const releasedRuns = [...controller.runs.values()].filter((run) => run.record.agent_id === first.agent_id);
  assert.equal(releasedRuns.length, 2);
  assert(releasedRuns.every((run) => run.session === undefined), "historical Runs do not retain the real SDK port wrapper");
  const third = await invoke("spawn_agent", newTask("TRY_PARENT_CONTROL", "reader")); await settled(third);
  assert.equal(leakedParentCalls, 0);
  assert(children[2].session.messages.some((m) => m.role === "toolResult" && m.toolName === "resume_agent" && m.isError));
  await invoke("cancel_run", { run_id: blocking.run_id }); await settled(blocking);
  assert.equal(controller.view(blocking.run_id).status, "cancelled");
  assert.equal((await invoke("read_run", { run_id: first.run_id })).text, "QUESTION_RECORDED");
  const listed = await invoke("list_agents", { limit: 2 });
  assert.deepEqual(listed.agents.map((run) => run.agent_id), [blocking.agent_id, third.agent_id]); assert.equal(listed.next_offset, undefined);
  const history = await invoke("list_agents", { include_released: true, limit: 1 });
  assert.equal(history.agents[0].agent_id, first.agent_id); assert.equal(history.next_offset, 1);
  assert.equal(history.agents[0].run_id, answered.run_id);
  assert.equal(history.agents[0].description, "Follow-up task", "resume without a label does not inherit the old task");
  assert.equal(history.agents[0].description_truncated, false);
  const batch = await invoke("wait_runs", { run_ids: [first.run_id, answered.run_id, blocking.run_id, third.run_id], mode: "all" });
  assert(batch.runs.every((run) => run.text.length <= 4096));
  assert(batch.runs.reduce((count, run) => count + run.text.length + (run.question?.length ?? 0), 0) <= 16384);
  assert.equal(batch.runs[0].has_question, true); assert.equal(batch.runs[0].question_complete, true);
  claim("actual SDK waits include complete questions, useful result pages and stable combined-dispatch identities");
  claim("new Agent takes the active preset while the parent model stays independent; explicit idle release frees hard capacity; steer/cancel stay Run-scoped; both managed profiles have real readiness", {
    profiles: children.map((c) => c.agent.settings.profile), parent_control_calls_from_child: leakedParentCalls,
    released_run_port_refs: releasedRuns.filter((run) => run.session !== undefined).length,
  });

  const oldTool = tools.find((t) => t.name === "list_agents"), oldCtx = parentCtx;
  await assert.rejects(oldTool.execute("foreign", {}, undefined, undefined, children[2].context), /STALE_OWNER_CONTEXT/);
  const preAborted = new AbortController(); preAborted.abort();
  const waitTool = tools.find((t) => t.name === "wait_runs");
  const interrupted = await waitTool.execute("wait-abort", { run_ids: [third.run_id], mode: "all" }, preAborted.signal, undefined, oldCtx);
  assert.equal(JSON.parse(interrupted.content[0].text).reason, "interrupted");
  // Reuse this fixture's real tool/SDK assembly instead of another host runner.
  await invoke("release_agent", { agent_id: blocking.agent_id });
  await invoke("release_agent", { agent_id: third.agent_id });
  request = { name: "spawn_agent", id: "parent-abort-wait", sent: false,
    args: newTask("HOLD_AFTER_PARENT_ABORT", "reader", { name: "shutdown-probe", wait_ms: 300000 }) };
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
  assert.equal(abortProbe.wait.reply.wait.reason, "interrupted");
  assert.equal(abortProbe.wait.reply.run_id, held.run_id);
  assert.equal(abortProbe.wait.reply.agent_id, held.agent_id);
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
  await invoke("spawn_agent", newTask("MUST_NOT_START_AFTER_CLOSE"), { error: "OWNER_CLOSED" });
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
