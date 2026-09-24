// Opt-in synthetic trial of the real createOwnerTools interface. The default
// mode uses one explicitly selected real model; --controlled uses fixture IO.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OwnerController as Controller } from "../../dist/core/owner-controller.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { SessionInitializationError } from "../../dist/core/ports.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { PiRunJournal as SdkRunHistory } from "../../dist/history/run-journal.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { ChildRunGate as RunInputGate, PiAgentSessionAdapter as SdkRunPort } from "../../dist/runtime/agent-session.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { managementToolNames as delegationTools } from "../../dist/tools/tool-names.js";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { abortAndWaitForIdle, assertThinkingSupported, controlledProvider, loadHost, requestAbort } from "../support/host.mjs";
import { dialogueFailures, messageText, parentRoundEvidence, questionFailures } from "../support/model-trial-evidence.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const argv = process.argv.slice(2), controlled = argv[0] === "--controlled";
const args = controlled ? argv.slice(1) : argv;
const [piExecutable, installedAgentDir] = args;
let resourceSource, configPath, outputRoot, requestedModel, requestedThinking, fault;
if (controlled) [resourceSource, outputRoot, fault] = args.slice(2);
else [resourceSource, configPath, outputRoot, requestedModel, requestedThinking = "minimal"] = args.slice(2);
assert(piExecutable && installedAgentDir && resourceSource && outputRoot && (controlled || configPath),
  controlled ? "Use scripts/check-pi-harness.sh" : "Use scripts/run-pi-harness-live-trial.sh with --model PROVIDER/MODEL");
assert(fault === undefined || controlled && ["parent-answer-error", "post-assembly", "post-assembly-cleanup-timeout"].includes(fault), "Unknown controlled fault");
process.umask(0o077);
const agentDir = controlled ? resourceSource : join(outputRoot, "agent");
const isolatedHome = controlled ? join(dirname(agentDir), "home") : join(outputRoot, "home");
const cwd = join(outputRoot, controlled ? "controlled-model-project" : "project");
const sessionDirectory = join(outputRoot, controlled ? "controlled-model-sessions" : "sessions");
assert.equal(process.env.HOME, isolatedHome, "Use the isolating shell wrapper");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
assert.equal(process.env.PI_TELEMETRY, "0");
assert.equal(process.env.PI_AUTO_APPROVAL_MODE, "shadow", "Trials must keep automatic approval in shadow mode");
assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, sessionDirectory, "The shell wrapper must isolate the SDK session root");
for (const directory of [agentDir, cwd, isolatedHome, sessionDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });

assert(controlled || typeof requestedModel === "string" && /^[^/\s]+\/[^\s]+$/.test(requestedModel),
  "Live trials require an explicit PROVIDER/MODEL; no provider or model is selected by default");
const { sdk, ai, permission, permissionEntry, authority, versions } = await loadHost(piExecutable);
const { Type: T } = ai;
assert(T?.Object, "Host TypeBox export missing");
if (!controlled) {
  const resources = JSON.parse(readFileSync(resourceSource, "utf8"));
  for (const [directory, files] of Object.entries({ agents: resources.agents, extensions: resources.extensions })) {
    mkdirSync(join(agentDir, directory), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      if (name === "luna-auto-approval.ts") continue;
      const path = join(agentDir, directory, directory === "agents" ? `${name}.md` : name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const name of [...delegationTools, "notify_parent", "ask_parent"]) config.permission[name] = "allow";
  mkdirSync(join(agentDir, "extensions/pi-permission-system"), { recursive: true });
  writeFileSync(join(agentDir, "extensions/pi-permission-system/config.json"), JSON.stringify(config));
}
assert.equal(existsSync(join(agentDir, "extensions/luna-auto-approval.ts")), false, "Luna must not load in a trial");

const sourceText = "quantity=7\nunit=11\nfactor=unknown; ask your parent\n";
const sourcePath = join(cwd, "source.txt");
const forbiddenReadPath = join(isolatedHome, "not-a-synthetic-source.txt");
assert.equal(existsSync(forbiddenReadPath), false, "out-of-scope read target must not exist");
writeFileSync(sourcePath, sourceText);
const trialGuardPath = join(outputRoot, "trial-read-guard.ts");
const hangingCleanup = fault === "post-assembly-cleanup-timeout";
writeFileSync(trialGuardPath, `import { resolve } from "node:path";
const allowed = new Set(${JSON.stringify([sourcePath])});
export default function (pi) {
  ${hangingCleanup ? 'pi.on("session_shutdown", async () => { pi.events.emit("model-trial:cleanup-held", {}); await new Promise(() => {}); });' : ""}
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const path = typeof event.input.path === "string" ? resolve(ctx.cwd, event.input.path) : undefined;
    if (!path || !allowed.has(path)) {
      pi.events.emit("model-trial:guard-block", { path });
      return { block: true, reason: "Trial read scope is exactly source.txt" };
    }
  });
}
`);
const profileNames = ["editor", "reader"];
const profiles = Object.fromEntries(profileNames.map((name) => {
  const definition = readFileSync(join(agentDir, "agents", `${name}.md`), "utf8");
  // Identical explicit trial subset; this is not the complete production profile.
  return [name, { definition, tools: ["read", "notify_parent", "ask_parent"] }];
}));
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false },
  retry: { enabled: false, provider: { timeoutMs: 45000, maxRetries: 0 } } });
let provider;
const runtime = await sdk.ModelRuntime.create(controlled
  ? { credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false }
  : { authPath: join(installedAgentDir, "auth.json"), modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
let modelSpec = requestedModel, parentThinking = requestedThinking;
if (controlled) {
  provider = controlledProvider(ai);
  runtime.registerProvider("harness-fixture", provider.config);
  modelSpec = "harness-fixture/controlled";
  parentThinking = "off";
}
const separator = modelSpec.indexOf("/");
assert(separator > 0, "Model must be exact provider/model");
const catalogModel = runtime.getModel(modelSpec.slice(0, separator), modelSpec.slice(separator + 1));
assert(catalogModel, "Requested catalog model absent");
assertThinkingSupported(catalogModel, parentThinking, ai.getSupportedThinkingLevels);
// Preserve the trial baseline: parent-only model metadata override, not a
// verified output/fee cap. In particular, the installed Codex request builder
// does not send max_output_tokens. Children keep the catalogue metadata.
const model = controlled ? catalogModel : { ...catalogModel, maxTokens: 2048 };
const trialPreset = { name: controlled ? "controlled-trial" : "authorized-trial", version: "v1",
  digest: digest(`trial:${modelSpec}`), models: { light: modelSpec, standard: modelSpec, strong: modelSpec },
  thinking: { light: {}, standard: {}, strong: {} },
  effort: { light: "inherit", standard: "inherit", strong: "inherit" },
  effort_defaults: { light: "inherit", standard: "inherit", strong: "inherit" }, effort_overrides: {} };
const permissionPath = permissionEntry;
const parentBus = sdk.createEventBus();
const parentManager = sdk.SessionManager.create(cwd, sessionDirectory);
let owner;

const report = { authority, versions, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  mode: controlled ? "controlled" : "real-model", real_model: !controlled, release: releaseDecision,
  model: modelSpec, thinking: parentThinking, auto_approval_mode: process.env.PI_AUTO_APPROVAL_MODE, luna_loaded: false,
  output_limits: { parent_model_max_tokens: model.maxTokens, child_model_max_tokens: catalogModel.maxTokens,
    child_source: "catalogue", verified_hard_token_or_fee_cap: false },
  abort_errors: [], injected_fault: fault, factory_failures: [],
  roots: { home: isolatedHome, agent: agentDir, sessions: sessionDirectory, cwd },
  started_at: new Date().toISOString(), tool_events: [], calls: [], child_events: [], child_guard_blocks: [], child_tool_events: [], child_tool_calls: [], cases: [],
  limitations: [
    "Synthetic read-only project and an explicit two-profile trial subset, not full production-profile acceptance",
    controlled ? "Controlled provider IO; no private auth or remote model call" : "One explicitly selected real provider/model; not a statistical usability benchmark",
    "No Bash, writes, Luna, reload, production admission, backend switch, private conversation, or deployment",
    "SDK catalogue membership is not authentication/availability proof",
    "Parent-only maxTokens metadata is not a verified provider cap; child metadata comes from the catalogue; wall time is not a token/fee limit",
    "Notifications are owner-local at-most-once claims; this trial does not add durable delivery",
    ...(!controlled ? ["OAuth refresh may update the explicit existing authPath in place; credentials are never copied or logged"] : []),
  ] };
const reportPath = join(outputRoot, controlled ? "controlled-model-trial.json" : "model-trial.json");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
save();

const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const transcript = (session) => session.messages.map((message) => ({ role: message.role,
  ...(message.role === "assistant" ? { stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage } : {}),
  ...(message.role === "toolResult" ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError } : {}),
  content: typeof message.content === "string" ? message.content : message.content?.filter((part) => part.type === "text" || part.type === "toolCall"),
}));
const extractToolCalls = (messages, timings = new Map()) => {
  const calls = [], byId = new Map();
  for (const message of messages) {
    if (message.role === "assistant") for (const part of message.content ?? []) if (part.type === "toolCall") {
      const timing = timings.get(part.id) ?? {};
      const call = { name: part.name, id: part.id, args: structuredClone(part.arguments), ...timing };
      calls.push(call); byId.set(part.id, call);
    }
    if (message.role === "toolResult") {
      const call = byId.get(message.toolCallId);
      if (!call) continue;
      const body = messageText(message);
      call.is_error = !!message.isError;
      call.value = parseJson(body) ?? body;
      call.response_body_utf16_chars = body.length;
      call.response_body_utf8_bytes = Buffer.byteLength(body, "utf8");
      call.response_envelope_utf8_bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    }
  }
  return calls;
};
const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: undefined });
const stringParameter = () => T.String({ minLength: 1, maxLength: 8192 });
const loaderFor = async (bus, extra = {}) => {
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings(), eventBus: bus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [permissionPath], ...extra });
  await loader.reload();
  return loader;
};
const callById = (messages, id) => messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
const resultById = (messages, id) => parseJson(messageText(callById(messages, id)));
let parent, parentContext, tools, controller, turns = 0, primaryError;
const children = new Map(), parentTimings = new Map();
const scenario = { name: "delegate-question-resume", started_ms: performance.now(), task_review: "required" };
report.cases.push(scenario); save();
let deadline, dialogueStage = "question", roundStart;
const requestParentAbort = () => {
  void requestAbort(parent, report.abort_errors);
};

const collectChildCalls = () => {
  const collected = [];
  for (const [agent_id, child] of children) for (const window of child.runs) for (const call of
    extractToolCalls(child.session.messages.slice(window.start, window.end))) {
    // A peer may still be awaiting its tool result when this Run finalizes.
    // Observe completed messages only; telemetry must not fail a healthy Run.
    if (call.is_error === undefined) continue;
    const body = typeof call.value === "string" ? call.value : JSON.stringify(call.value);
    const path = typeof call.args?.path === "string" ? resolve(cwd, call.args.path) : undefined;
    collected.push({ agent_id, run_id: window.run_id, name: call.name, id: call.id, args: call.args, is_error: call.is_error,
      response_utf16_chars: body.length, response_utf8_bytes: Buffer.byteLength(body, "utf8"), result_digest: digest(body),
      result_preview: body.slice(0, 160),
      ...(call.name === "read" && !call.is_error && path === sourcePath && body === sourceText ? { fixture_match: "source.txt" } : {}),
      ...(call.name === "read" && call.is_error && path === forbiddenReadPath &&
        report.child_guard_blocks.some((block) => block.agent_id === agent_id && block.path === forbiddenReadPath) ? { exact_guard_blocked: true } : {}),
    });
  }
  report.child_tool_calls = collected;
  return collected;
};

const evidenceExpected = { modelSpec, parentThinking, thinking: parentThinking };

try {
  owner = await ExecutionOwner.open({ directory: join(outputRoot, controlled ? "controlled-model-owners" : "owners"),
    owner_id: parentManager.getSessionId(), flock: process.env.P0_FLOCK });
  controller = await Controller.open({ owner, concurrency: 2, resident_limit: 2, grace_turns: 2, createSession: async (agent) => {
    const profile = profiles[agent.settings.profile];
    assert(profile, `unknown profile ${agent.settings.profile}`);
    assert.equal(digest(profile.definition), agent.settings.definition_digest, "child definition digest mismatch");
    assert.deepEqual(agent.settings.tools, profile.tools, "child tool subset differs from captured profile");
    const childModel = runtime.getModel(agent.settings.provider, agent.settings.model);
    assert(childModel, "fixed Agent model disappeared from runtime");
    const bus = sdk.createEventBus(), gate = new RunInputGate();
    bus.on("model-trial:guard-block", (event) => {
      report.child_guard_blocks.push({ agent_id: agent.agent_id, path: event.path, at_ms: performance.now() }); save();
    });
    bus.on("model-trial:cleanup-held", () => { report.factory_cleanup_held = true; });
    let callbacks;
    const communicate = (name, key, action) => sdk.defineTool({ name, label: name,
      description: name === "ask_parent" ? "Record one question, then finish this Run." : "Send progress to the parent.",
      parameters: T.Object({ [key]: stringParameter() }, { additionalProperties: false }),
      execute: async (_id, args) => {
        assert(callbacks && gate.accepting && !gate.stopped, "RUN_INPUT_CLOSED");
        report.child_events.push({ agent_id: agent.agent_id, kind: name, text: args[key], at_ms: performance.now() });
        action(callbacks, args[key]); save();
        return textResult({ recorded: true, ...(name === "ask_parent" ? { instruction: "Finish this Run now." } : {}) });
      },
    });
    const customTools = [communicate("notify_parent", "message", (cb, value) => cb.notify(value)),
      communicate("ask_parent", "question", (cb, value) => cb.question(value))];
    const childLoader = await loaderFor(bus, {
      // Load the exact trial path guard before permission/static guard so the
      // controlled negative read proves this boundary rather than another deny.
      additionalExtensionPaths: [trialGuardPath, permissionPath, join(agentDir, "extensions/static-safety-guard.ts")],
      appendSystemPromptOverride: () => [profile.definition.split(/^---\s*$/m).slice(2).join("\n").trim(), `<active_agent name="${agent.settings.profile}"/>`],
      extensionFactories: [gate.extension],
    });
    const manager = sdk.SessionManager.create(cwd, sessionDirectory, { parentSession: parent.sessionFile });
    manager.appendCustomEntry("active_agent", { name: agent.settings.profile });
    const assembled = await assembleChild({ createSession: sdk.createAgentSession,
      options: { cwd, agentDir, resourceLoader: childLoader, settingsManager: settings(), sessionManager: manager,
        modelRuntime: runtime, model: childModel, thinkingLevel: agent.settings.thinking, tools: agent.settings.tools, customTools },
      parentBus, childBus: bus, parentSessionId: parent.sessionId, profile: agent.settings.profile,
      definitionDigest: agent.settings.definition_digest, getPermissionsService: permission.getPermissionsService });
    // The factory owns the bound child until the complete port is returned.
    try {
      if (fault === "post-assembly" || hangingCleanup) assert.fail("SYNTHETIC_POST_ASSEMBLY_FAILURE");
      assert.equal(assembled.session.thinkingLevel, agent.settings.thinking);
      assert.equal(assembled.session.model.maxTokens, report.output_limits.child_model_max_tokens);
      assert.deepEqual(assembled.session.getActiveToolNames().sort(), [...agent.settings.tools].sort());
      assembled.session.subscribe((event) => {
        if (event.type !== "tool_execution_end") return;
        const body = event.result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
        report.child_tool_events.push({ agent_id: agent.agent_id, name: event.toolName, id: event.toolCallId,
          args: structuredClone(event.args), is_error: event.isError, result_summary: body.slice(0, 160),
          response_utf16_chars: body.length, response_utf8_bytes: Buffer.byteLength(body, "utf8") }); save();
      });
      const port = new SdkRunPort({ session: assembled.session, parentBus, gate,
        history: new SdkRunHistory({ parent: parent.sessionManager, session: manager }),
        readiness: () => requireReadiness(bus, permission.getPermissionsService, assembled.session.sessionId,
          agent.settings.profile, agent.settings.definition_digest) });
      const reference = `${controlled ? "controlled" : "real"}-child-${children.size + 1}.json`;
      const child = { session: assembled.session, reference, runs: [] };
      const result = { session_id: port.session_id, history: port.history,
        run: async (prompt, cb) => {
          // Same-Agent execution is exclusive. Attribute SDK message slices to
          // this Run, not every historical read in the reusable Agent session.
          const run_id = controller.list().find((run) => run.agent_id === agent.agent_id).run_id;
          const window = { run_id, start: assembled.session.messages.length };
          child.runs.push(window);
          callbacks = cb;
          try { return await port.run(prompt, cb); }
          finally {
            window.end = assembled.session.messages.length;
            callbacks = undefined; collectChildCalls(); save();
            writeFileSync(join(outputRoot, reference), JSON.stringify(transcript(assembled.session), null, 2));
          }
        },
        canInput: () => port.canInput(), steer: (value, valid) => port.steer(value, valid), stop: () => port.stop(),
        clearInputs: () => port.clearInputs(), dispose: () => port.dispose(),
      };
      children.set(agent.agent_id, child);
      return result;
    } catch (error) {
      children.delete(agent.agent_id);
      const failure = { agent_id: agent.agent_id, session_id: assembled.session.sessionId, original_error: String(error),
        permission_present_before_cleanup: !!permission.getPermissionsService(assembled.session.sessionId) };
      report.factory_failures.push(failure);
      try {
        await abortAndWaitForIdle(assembled.session);
        failure.cleanup = await disposeChild(assembled.session, parentBus, hangingCleanup ? 40 : undefined);
        failure.permission_removed = !permission.getPermissionsService(assembled.session.sessionId);
        assert(failure.cleanup.shutdownExited && failure.cleanup.errors.length === 0,
          `CHILD_CLEANUP_NOT_CONFIRMED: ${JSON.stringify(failure.cleanup)}`);
        assert.equal(failure.permission_removed, true, "CHILD_PERMISSION_NOT_REMOVED");
      } catch (cleanupError) {
        failure.cleanup_error = String(cleanupError);
        throw new SessionInitializationError(error, cleanupError);
      }
      throw error;
    }
  } });

  const parentLoader = await loaderFor(parentBus, {
    systemPromptOverride: () => controlled ? "SYNTHETIC_MODEL_TRIAL_PARENT" :
      "You coordinate read-only workers. Use returned IDs and ask the user for missing information rather than guessing.",
    extensionFactories: [(pi) => {
      pi.on("session_start", (_event, ctx) => {
        parentContext = ctx;
        if (tools) return;
        tools = createOwnerTools({ controller, context: ctx, profiles,
          getSupportedThinkingLevels: ai.getSupportedThinkingLevels, getPreset: () => structuredClone(trialPreset) });
        for (const item of tools) pi.registerTool(item);
        pi.setActiveTools(tools.map((item) => item.name));
      });
      pi.on("tool_call", (event) => {
        if (event.toolName === "spawn_agent" && event.input.model !== undefined) {
          return { block: true, reason: "MODEL_ARGUMENT_OBSOLETE: use the authorized trial preset" };
        }
      });
    }],
  });
  ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: parentLoader, settingsManager: settings(),
    sessionManager: parentManager, modelRuntime: runtime, model, thinkingLevel: parentThinking, tools: delegationTools }));
  const bindErrors = [];
  await parent.bindExtensions({ onError: (error) => { bindErrors.push(String(error.error)); report.bind_errors = bindErrors; save(); } });
  assert.deepEqual(bindErrors, []);
  assert(parentContext, "session_start did not capture the actual ExtensionContext");
  assert.deepEqual(parent.getActiveToolNames().sort(), [...delegationTools].sort());
  assert.equal(parent.thinkingLevel, parentThinking);
  assert.equal(parent.model.maxTokens, report.output_limits.parent_model_max_tokens);
  parent.subscribe((event) => {
    if (event.type === "turn_start" && ++turns > 24) { scenario.turn_limit = true; requestParentAbort(); }
    if (event.type === "tool_execution_start" && delegationTools.includes(event.toolName)) {
      const timing = { started_ms: performance.now() };
      parentTimings.set(event.toolCallId, timing);
      report.tool_events.push({ phase: "start", name: event.toolName, id: event.toolCallId, at_ms: timing.started_ms }); save();
    }
    if (event.type === "tool_execution_end" && delegationTools.includes(event.toolName)) {
      const timing = parentTimings.get(event.toolCallId), completed = performance.now();
      if (timing) { timing.completed_ms = completed; timing.duration_ms = completed - timing.started_ms; }
      report.tool_events.push({ phase: "end", name: event.toolName, id: event.toolCallId, is_error: event.isError,
        at_ms: completed, duration_ms: timing?.duration_ms }); save();
    }
  });

  if (controlled) {
    const action = (id, name, arguments_) => ({ tools: [{ type: "toolCall", id, name, arguments: arguments_ }] });
    provider.respond(async (call) => {
      const messages = call.context.messages;
      if (!call.context.systemPrompt.includes("SYNTHETIC_MODEL_TRIAL_PARENT")) {
        const prompt = messageText(messages.filter((message) => message.role === "user").at(-1));
        const last = messages.at(-1), body = messageText(last);
        if (prompt.includes("ASK_FACTOR")) {
          if (last?.role === "toolResult" && last.toolName === "ask_parent") return { text: "QUESTION_RECORDED" };
          if (last?.role === "toolResult" && last.toolName === "notify_parent") return action("child-a-question", "ask_parent", { question: "缺少的 factor 是多少🚀？" });
          if (last?.role === "toolResult" && last.toolName === "read" && !last.isError) {
            assert.equal(body, sourceText, "A must consume the SDK read result for source.txt");
            return action("child-a-progress", "notify_parent", { message: "已读取合成输入，等待 factor" });
          }
          if (last?.role === "toolResult" && last.toolName === "read" && last.isError) {
            assert(report.child_guard_blocks.some((block) => block.path === forbiddenReadPath), "out-of-scope read must reach the exact trial guard");
            return action("child-a-source", "read", { path: sourcePath });
          }
          return action("child-a-forbidden", "read", { path: forbiddenReadPath });
        }
        if (prompt.includes("ANSWER_FACTOR")) {
          const source = messageText(messages.find((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError));
          const quantity = Number(/quantity=(\d+)/.exec(source)?.[1]);
          const unit = Number(/unit=(\d+)/.exec(source)?.[1]);
          return { text: `${quantity} × ${unit} × 3 = ${quantity * unit * 3}。` };
        }
        throw new Error("Unexpected controlled child task");
      }

      const result = (id) => resultById(messages, id);
      if (!callById(messages, "create-a")) return action("create-a", "spawn_agent", { prompt: "ASK_FACTOR", description: "calculate the source product", profile: "reader", difficulty: 3, wait_ms: 60000 });
      const a = result("create-a");
      if (dialogueStage === "question") {
        const question = a.wait?.runs[0];
        assert.equal(question?.status, "needs_input"); assert.equal(question.question_complete, true);
        return { text: question.question };
      }
      if (!callById(messages, "answer")) return action("answer", "resume_agent", { agent_id: a.agent_id, prompt: "ANSWER_FACTOR 3", answer_to_run_id: a.run_id, wait_ms: 60000 });
      const answerResult = result("answer").wait?.runs[0];
      assert.equal(answerResult.status, "completed"); assert.equal(answerResult.complete, true);
      return { text: answerResult.text, ...(fault === "parent-answer-error" ? { reason: "error", error: "SYNTHETIC_PARENT_ANSWER_ERROR" } : {}) };
    });
  }

  deadline = setTimeout(() => { scenario.deadline = true; save(); requestParentAbort(); }, controlled ? 60000 : 240000);
  // The missing value is not present in the initial parent prompt or inherited
  // context. This is an ordinary two-message user dialogue, not a tool checklist.
  const prompts = ["请让一个助手读取 source.txt，计算 quantity × unit × factor。缺少信息就先问我。",
    "factor 是 3。请让刚才的助手继续完成计算，并告诉我结果。"];
  report.user_prompts = [prompts[0]];
  roundStart = parent.messages.length;
  await parent.prompt(prompts[0], { source: "extension", expandPromptTemplates: false });
  await parent.waitForIdle();
  scenario.first = {
    calls: extractToolCalls(parent.messages, parentTimings).filter((call) => delegationTools.includes(call.name)),
    runStates: [...controller.runs.keys()].map((id) => controller.view(id)),
    childCalls: collectChildCalls(),
    ...parentRoundEvidence(parent.messages, roundStart),
  };
  scenario.question_path = scenario.first.runStates[0]?.status === "needs_input" ? "ask_parent" : "parent-followup";
  scenario.failures = questionFailures(scenario.first);
  if (scenario.deadline || scenario.turn_limit) scenario.failures.push("parent budget ended before the user answer");
  save();
  if (scenario.failures.length) throw new Error(`QUESTION_STAGE_FAILED: ${scenario.failures.join("; ")}`);
  dialogueStage = "answer";
  report.user_prompts.push(prompts[1]);
  roundStart = parent.messages.length;
  await parent.prompt(prompts[1], { source: "extension", expandPromptTemplates: false });
  await parent.waitForIdle();
  report.calls = extractToolCalls(parent.messages, parentTimings).filter((call) => delegationTools.includes(call.name));
  Object.assign(scenario, parentRoundEvidence(parent.messages, roundStart));
  scenario.duration_ms = performance.now() - scenario.started_ms;
  scenario.tool_call_count = report.calls.length; scenario.parent_turns = turns;
  scenario.error_call_count = report.calls.filter((call) => call.is_error).length;
  scenario.response_body_utf16_chars = report.calls.reduce((sum, call) => sum + (call.response_body_utf16_chars ?? 0), 0);
  scenario.response_body_utf8_bytes = report.calls.reduce((sum, call) => sum + (call.response_body_utf8_bytes ?? 0), 0);
  scenario.response_envelope_utf8_bytes = report.calls.reduce((sum, call) => sum + (call.response_envelope_utf8_bytes ?? 0), 0);
  scenario.resources_at_model_end = controller.stats();
  scenario.run_states = [...controller.runs.keys()].map((run_id) => controller.view(run_id));
  collectChildCalls();
  const evidence = { first: scenario.first, calls: report.calls, stats: scenario.resources_at_model_end, runStates: scenario.run_states,
    final: scenario.final, stop_reason: scenario.stop_reason, error_message: scenario.error_message, childCalls: report.child_tool_calls };
  scenario.failures = dialogueFailures(evidence, evidenceExpected);
  if (scenario.deadline) scenario.failures.push("model deadline fired; fallback cleanup cannot satisfy business assertions");
  if (scenario.turn_limit) scenario.failures.push("parent turn limit fired");
  scenario.status = scenario.failures.length ? "failed" : "passed";

  if (controlled && !scenario.failures.length) {
    assert.equal(scenario.final, "7 × 11 × 3 = 231。");
    assert.deepEqual(report.calls.map((call) => call.name), ["spawn_agent", "resume_agent"]);
    assert.equal(scenario.parent_turns, 4, "two controlled rounds each dispatch once then report, without wait/get turns");
    assert(report.child_tool_calls.some((call) => call.exact_guard_blocked));
    scenario.task_review = "controlled-fixture-asserted";
    // A worker may simply report missing data. Parent-led clarification and
    // ordinary reuse are valid too; do not mistake that for ask_parent coverage.
    const ordinary = structuredClone(evidence);
    ordinary.first.runStates[0].status = "completed";
    ordinary.first.runStates[0].outcome = { status: "completed" };
    ordinary.runStates[0] = structuredClone(ordinary.first.runStates[0]);
    const questionReply = ordinary.first.calls.find((call) => call.name === "spawn_agent").value.wait.runs[0];
    questionReply.text = questionReply.question;
    questionReply.status = "completed"; questionReply.complete = true;
    delete questionReply.question;
    delete ordinary.calls.find((call) => call.name === "resume_agent").args.answer_to_run_id;
    assert.deepEqual(dialogueFailures(ordinary, evidenceExpected), []);
    report.ordinary_followup_oracle = "accepted-without-claiming-ask_parent-coverage";
    const mutations = {
      "missing-answer": [["user answer did not complete a second Run on the same Agent (answer_to_run_id is required for needs_input)",
        "parent did not retrieve and report the answer Run's output"],
        (copy) => { copy.calls = copy.calls.filter((call) => call.name !== "resume_agent"); }],
      "wrong-question-run": [["user answer did not complete a second Run on the same Agent (answer_to_run_id is required for needs_input)",
        "parent did not retrieve and report the answer Run's output"],
        (copy) => { copy.calls.find((call) => call.name === "resume_agent").args.answer_to_run_id = "another-run"; }],
      "wrong-read-run": [["question Run did not read the synthetic source through SDK read"],
        (copy) => { for (const call of copy.first.childCalls) if (call.fixture_match) call.run_id = "another-run"; }],
      "active-at-return": [["active work or uncertain ownership remained before host cleanup"], (copy) => { copy.stats.active = 1; }],
      "unretrieved-question": [["parent did not retrieve that Run's complete question"],
        (copy) => { copy.first.calls.find((call) => call.name === "spawn_agent").value.wait.runs[0].question_complete = false; }],
      "partial-answer": [["parent did not retrieve and report the answer Run's output"],
        (copy) => { copy.calls.find((call) => call.name === "resume_agent").value.wait.runs[0].complete = false; }],
      "settings-drift": [["reused Agent settings changed"], (copy) => { copy.runStates[1].effective_settings.definition_digest = "changed"; }],
      "budget-exceeded": [["Run execution/budget/model scope was not satisfied"], (copy) => { copy.runStates[1].outcome.limit_reached = true; }],
      "model-mismatch": [["reused Agent settings changed", "Run execution/budget/model scope was not satisfied"], (copy) => { copy.runStates[1].effective_settings.model = "other"; }],
      "thinking-mismatch": [["reused Agent settings changed", "Run execution/budget/model scope was not satisfied"], (copy) => { copy.runStates[1].effective_settings.thinking = "high"; }],
    };
    report.negative_oracle = [];
    for (const [name, [expected, mutate]] of Object.entries(mutations)) {
      const copy = structuredClone(evidence); mutate(copy);
      const failures = dialogueFailures(copy, evidenceExpected);
      assert.deepEqual(failures, expected, `negative oracle ${name} did not match its expected failure branches`);
      report.negative_oracle.push({ name, status: "expected-failure-detected", expected, failures });
    }
  }
  if (scenario.failures.length) throw new Error(`BUSINESS_ASSERTIONS_FAILED: ${scenario.failures.join("; ")}`);
} catch (error) {
  primaryError = error;
  scenario.status = "failed";
  scenario.failure_reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    if (parent) {
      report.calls = extractToolCalls(parent.messages, parentTimings).filter((call) => delegationTools.includes(call.name));
      if (roundStart !== undefined) Object.assign(scenario, parentRoundEvidence(parent.messages, roundStart));
    }
    if (controller) {
      scenario.resources_at_model_end ??= controller.stats();
      scenario.run_states ??= [...controller.runs.keys()].map((run_id) => controller.view(run_id));
    }
    collectChildCalls();
  } catch (snapshotError) { report.failure_snapshot_error = String(snapshotError); }
} finally {
  clearTimeout(deadline);
  report.cleanup = {};
  if (parent) {
    try { await abortAndWaitForIdle(parent); report.cleanup.parent_idle = true; }
    catch (error) { report.cleanup.parent_abort_error = String(error); }
  }
  if (controller) {
    try { report.cleanup.controller = await controller.shutdown(10000); }
    catch (error) { report.cleanup.controller_error = String(error); }
    report.cleanup.resources_after_shutdown = controller.stats();
  } else if (owner) {
    try { owner.close(); report.cleanup.owner_without_controller = "closed"; }
    catch (error) { report.cleanup.owner_without_controller = `close failed: ${String(error)}`; }
  } else report.cleanup.owner_without_controller = "not_acquired";
  const ownerClosed = controller ? report.cleanup.controller?.closed === true :
    report.cleanup.owner_without_controller === "closed" || report.cleanup.owner_without_controller === "not_acquired";
  if (parent && ownerClosed && report.cleanup.parent_idle === true) {
    try { report.cleanup.parent = await disposeChild(parent, parentBus); }
    catch (error) { report.cleanup.parent_error = String(error); }
  } else if (parent) {
    report.cleanup.parent = { skipped: ownerClosed ? "PARENT_ABORT_NOT_CONFIRMED" : "OWNER_NOT_CLOSED" };
  }
  if (parent) {
    report.cleanup.parent_permission_present = !!permission.getPermissionsService(parent.sessionId);
    try { writeFileSync(join(outputRoot, controlled ? "controlled-parent.json" : "real-parent.json"), JSON.stringify(transcript(parent), null, 2)); }
    catch (error) { report.cleanup.parent_transcript_error = String(error); }
  }
  report.turns = turns; report.finished_at = new Date().toISOString();
  const parentCertain = !parent || report.cleanup.parent?.shutdownExited === true &&
    Array.isArray(report.cleanup.parent?.errors) && report.cleanup.parent.errors.length === 0;
  const cleanupCertain = ownerClosed && parentCertain && !report.cleanup.controller_error && !report.cleanup.parent_abort_error && !report.abort_errors?.length;
  if (!cleanupCertain) {
    const reason = `CLEANUP_UNCERTAIN: ${JSON.stringify(report.cleanup)}`;
    primaryError ??= new Error(reason);
    scenario.status = "failed";
    scenario.failure_reason = scenario.failure_reason ? `${scenario.failure_reason}; ${reason}` : reason;
  }
  report.status = !primaryError && scenario.status === "passed" ? "mechanics-passed" : "failed";
  report.failure_reason = primaryError instanceof Error ? `${primaryError.name}: ${primaryError.message}` :
    primaryError === undefined ? undefined : String(primaryError);
  try { save(); }
  catch (saveError) {
    if (primaryError === undefined) primaryError = saveError;
    else console.error(`Failed to save final trial report without replacing the primary error: ${String(saveError)}`);
  }
}
if (primaryError) throw primaryError;
console.log(`${controlled ? "Controlled" : "Real-model"} dialogue mechanics passed; review the saved question and answer: ${reportPath}`);
