import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

async function controlledFixture() {
  const home = process.env.HOME, agentDir = process.env.PI_CODING_AGENT_DIR;
  assert(home && agentDir === join(home, "agent"), "isolated child-process wrapper required");
  assert.equal(process.env.PI_OFFLINE, "1");
  const network = [];
  const forbiddenNetwork = name => () => { network.push(name); throw new Error(`OFFLINE_FIXTURE_NETWORK: ${name}`); };
  globalThis.fetch = forbiddenNetwork("fetch");
  for (const name of ["http", "https"]) {
    const { default: module } = await import(`node:${name}`);
    module.request = forbiddenNetwork(`${name}.request`);
    module.get = forbiddenNetwork(`${name}.get`);
  }
  const { default: net } = await import("node:net");
  const { default: tls } = await import("node:tls");
  net.connect = forbiddenNetwork("net.connect");
  net.createConnection = forbiddenNetwork("net.createConnection");
  tls.connect = forbiddenNetwork("tls.connect");
  syncBuiltinESMExports();

  const sdk = await import("@earendil-works/pi-coding-agent");
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { fsCache: false });
  const managed = await jiti.import(join(repo, "runtime/permission-system/index.ts"));
  const { sessionYoloSet } = await jiti.import(join(repo, "extensions/lib/approval-protocol.ts"));
  const { requireParentAnswerPermission } = await jiti.import(join(repo, "harness/src/runtime/parent-answer-permission.ts"));
  assert.equal(JSON.parse(readFileSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/package.json"))).version, "1.5.0");
  assert.equal(JSON.parse(readFileSync(join(repo, "runtime/permission-system/vendor/package.json"))).version, "32.0.3");

  const cwd = join(home, "project");
  const config = join(agentDir, "extensions/pi-permission-system/config.json");
  for (const path of [cwd, join(agentDir, "agents"), join(agentDir, "extensions/pi-permission-system")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // Only owned synthetic state. Copy the matched child definition to prove a
  // child-profile deny is independent of the parent's unscoped query.
  writeFileSync(join(agentDir, "agents/editor.md"), readFileSync(join(repo, "runtime/agents/editor.md")), { mode: 0o600 });
  sdk.initTheme(undefined, false);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  let modelCalls = 0, fakeSelections = 0;
  runtime.registerProvider("parent-permission-fixture", {
    api: "parent-permission-fixture", apiKey: "synthetic-not-a-credential", baseUrl: "https://invalid.invalid/never-used",
    models: [{ id: "no-call", name: "No model calls", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple() { modelCalls++; throw new Error("MODEL_CALL_NOT_AUTHORIZED"); },
  });
  const errors = [], prompts = [], observations = [];
  for (const scenario of ["allow", "deny", "ask", "session", "spawn-session", "yolo"]) {
    const state = ["allow", "deny"].includes(scenario) ? scenario : "ask";
    writeFileSync(config, JSON.stringify({ permission: { "*": "ask",
      agent_spawn: scenario === "spawn-session" ? "ask" : "allow", agent_answer: state } }), { mode: 0o600 });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [join(repo, "runtime/permission-system/index.ts")],
      extensionFactories: [pi => {
        for (const name of ["agent_spawn", "agent_answer"]) pi.registerTool({ name, label: name, description: "Synthetic permission gate only",
          parameters: { type: "object", properties: {} }, execute() { assert.fail("no tool effects authorized"); } });
        pi.events.on("permissions:ui_prompt", event => prompts.push(event));
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel("parent-permission-fixture", "no-call"), thinkingLevel: "off", settingsManager,
      sessionManager: sdk.SessionManager.inMemory(cwd), tools: ["agent_spawn", "agent_answer"] });
    let explicitGrantSetup = false;
    const grantTool = scenario === "spawn-session" ? "agent_spawn" : "agent_answer";
    try {
      await session.bindExtensions({ mode: "rpc", onError: error => errors.push(String(error.error)), uiContext: {
        select: async (title, options) => {
          assert(explicitGrantSetup, "preflight must never prompt");
          assert.match(title, new RegExp(grantTool));
          assert.match(options[1], /session/i);
          fakeSelections++;
          return options[1]; // Explicit scripted session approval, not a human dialog.
        },
        input: async () => { assert.fail("no input authorized"); },
        notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {},
      } });
      const sessionId = session.sessionManager.getSessionId();
      const service = managed.getPermissionsService(sessionId);
      const parent = { sessionManager: session.sessionManager, getSystemPrompt: () => session.systemPrompt ?? "" };
      assert(service, "actual public managed parent service must be published");
      assert.equal(service.checkPermission("agent_answer").state, state);
      assert.equal(service.checkPermission("agent_answer", undefined, "editor").state, "deny");
      if (state !== "allow") assert.throws(() => requireParentAnswerPermission(service, parent), error =>
        error.code === "RETURN_TO_PERMISSION_DENIED" && error.details.reason === state);
      if (scenario === "session" || scenario === "spawn-session") {
        explicitGrantSetup = true;
        const result = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: grantTool,
          toolCallId: `synthetic-grant-${scenario}`, input: {} });
        explicitGrantSetup = false;
        assert(!result?.block, JSON.stringify(result));
      }
      // Controlled fixture setup uses the exported cross-extension yolo
      // protocol. The production helper never reads or modifies its registry.
      if (scenario === "yolo") sessionYoloSet().add(sessionId);
      assert.equal(service.checkPermission("agent_spawn").state, "allow");
      const promptCount = prompts.length, selectionCount = fakeSelections;
      const effective = service.checkPermission("agent_answer");
      const expected = ["allow", "session", "yolo"].includes(scenario) ? "allow" : state;
      assert.equal(effective.state, expected);
      if (expected === "allow") assert.equal(requireParentAnswerPermission(service, parent), undefined);
      else assert.throws(() => requireParentAnswerPermission(service, parent), error =>
        error.code === "RETURN_TO_PERMISSION_DENIED" && error.details.reason === expected);
      assert.equal(prompts.length, promptCount, "direct public lookup and helper never prompt");
      assert.equal(fakeSelections, selectionCount);
      if (scenario === "session") {
        assert.equal(effective.source, "session");
        assert.equal(effective.origin, "session");
        assert.equal(service.getToolPermission("agent_answer"), "ask", "blanket projection omits session grants");
      }
      if (scenario === "yolo") {
        assert.equal(effective.origin, "yolo");
        assert.equal(service.getToolPermission("agent_answer"), "ask", "blanket projection omits yolo");
        sessionYoloSet().delete(sessionId);
        assert.throws(() => requireParentAnswerPermission(service, parent), error => error.details.reason === "ask");
      }
      if (scenario === "deny") {
        sessionYoloSet().add(sessionId);
        assert.equal(service.checkPermission("agent_answer").state, "deny");
        assert.throws(() => requireParentAnswerPermission(service, parent), error => error.details.reason === "deny");
      }
      observations.push({ scenario, state: effective.state, origin: effective.origin });
    } finally {
      sessionYoloSet().delete(session.sessionManager.getSessionId());
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }
  // The parent's own principal: an active_agent profile scopes agent_answer at
  // the normal gate, so the helper must reach the same decision, both ways.
  const scoped = [];
  for (const [scenario, global, profile] of [["profile-deny", "allow", "deny"], ["profile-ask", "allow", "ask"], ["profile-allow", "ask", "allow"]]) {
    writeFileSync(config, JSON.stringify({ permission: { "*": "ask", agent_spawn: "allow", agent_answer: global } }), { mode: 0o600 });
    writeFileSync(join(agentDir, "agents/reviewer.md"),
      `---\ndescription: Synthetic parent profile\npermission:\n  agent_spawn: allow\n  agent_answer: ${profile}\n---\nSynthetic.\n`, { mode: 0o600 });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [join(repo, "runtime/permission-system/index.ts")],
      extensionFactories: [pi => {
        for (const name of ["agent_spawn", "agent_answer"]) pi.registerTool({ name, label: name, description: "Synthetic permission gate only",
          parameters: { type: "object", properties: {} }, execute() { assert.fail("no tool effects authorized"); } });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const sessionManager = sdk.SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry("active_agent", { name: "reviewer" });
    const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel("parent-permission-fixture", "no-call"), thinkingLevel: "off", settingsManager,
      sessionManager, tools: ["agent_spawn", "agent_answer"] });
    try {
      await session.bindExtensions({ mode: "rpc", onError: error => errors.push(String(error.error)), uiContext: {
        select: async () => { assert.fail("scoped checks never prompt"); }, input: async () => { assert.fail("no input authorized"); },
        notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {},
      } });
      const service = managed.getPermissionsService(session.sessionManager.getSessionId());
      const parent = { sessionManager: session.sessionManager, getSystemPrompt: () => session.systemPrompt ?? "" };
      assert.equal(service.checkPermission("agent_answer").state, global);
      assert.equal(service.checkPermission("agent_answer", undefined, "reviewer").state, profile);
      // The real gate (no prompt for allow/deny) is the reference decision.
      const gate = profile === "ask" ? "ask" : (await session.extensionRunner.emitToolCall({ type: "tool_call",
        toolName: "agent_answer", toolCallId: `scoped-${scenario}`, input: {} }))?.block ? "deny" : "allow";
      assert.equal(gate, profile);
      let helper = "allow";
      try { requireParentAnswerPermission(service, parent); }
      catch (error) { assert.equal(error.code, "RETURN_TO_PERMISSION_DENIED"); helper = error.details.reason; }
      assert.equal(helper, gate, `${scenario}: return_to must decide as the parent's own agent_answer gate`);
      scoped.push({ scenario, gate, helper });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }
  // During real SDK tool execution: run 1 starts with a prompt tag, so the
  // authority remembers "reviewer"; a tool then removes the tag's guideline.
  // Run 2 starts without the tag and the authority keeps the remembered name.
  // With no entry and no tag left, only the authority still knows the principal
  // its agent_answer gate binds, so return_to must take the authority's decision.
  const ai = await import("@earendil-works/pi-ai");
  const { controlledProvider } = await import(pathToFileURL(join(repo, "harness/test/support/host.mjs")).href);
  writeFileSync(config, JSON.stringify({ permission: { "*": "ask", agent_answer: "allow", tagger: "allow", untag: "allow", probe: "allow" } }), { mode: 0o600 });
  writeFileSync(join(agentDir, "agents/reviewer.md"),
    "---\ndescription: Synthetic parent profile\npermission:\n  agent_answer: deny\n---\nSynthetic.\n", { mode: 0o600 });
  const scripted = controlledProvider(ai), turns = [];
  runtime.registerProvider("tool-execution-fixture", scripted.config);
  scripted.respond(async request => {
    turns.push(/<active_agent\s+name="reviewer"/.test(request.context.systemPrompt));
    if (turns.length === 1) return { tools: [{ type: "toolCall", id: "untag-1", name: "untag", arguments: {} }] };
    if (turns.length === 3) return { tools: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }] };
    return { text: "done" };
  });
  let executing, probe;
  const toolLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [join(repo, "runtime/permission-system/index.ts")],
    extensionFactories: [pi => {
      const tool = (name, execute, extra = {}) => pi.registerTool({ name, label: name, description: `Synthetic ${name}`,
        parameters: { type: "object", properties: {} }, execute, ...extra });
      tool("tagger", () => assert.fail("never called"), { promptGuidelines: ['Parent identity: <active_agent name="reviewer"/>'] });
      tool("agent_answer", () => assert.fail("no tool effects authorized"));
      tool("untag", async () => { pi.setActiveTools(["untag", "probe", "agent_answer"]); return { content: [{ type: "text", text: "untagged" }], details: undefined }; });
      tool("probe", async (_id, _params, _signal, _update, ctx) => {
        const service = managed.getPermissionsService(ctx.sessionManager.getSessionId());
        const gate = await executing.extensionRunner.emitToolCall({ type: "tool_call", toolName: "agent_answer", toolCallId: "probe-gate", input: {} });
        let helper = "allow";
        try { requireParentAnswerPermission(service, ctx); }
        catch (error) { assert.equal(error.code, "RETURN_TO_PERMISSION_DENIED"); helper = error.details.reason; }
        probe = { tagInPrompt: /<active_agent/.test(ctx.getSystemPrompt()),
          activeAgentEntries: ctx.sessionManager.getEntries().filter(entry => entry.customType === "active_agent").length,
          unscoped: service.checkPermission("agent_answer").state, gate: gate?.block ? "deny" : "allow", gateReason: gate?.reason ?? null, helper };
        return { content: [{ type: "text", text: "probed" }], details: undefined };
      });
    }],
  });
  await toolLoader.reload();
  assert.deepEqual(toolLoader.getExtensions().errors, []);
  ({ session: executing } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: toolLoader, modelRuntime: runtime,
    model: runtime.getModel("tool-execution-fixture", "controlled"), thinkingLevel: "off", settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd), tools: ["tagger", "untag", "probe", "agent_answer"] }));
  try {
    await executing.bindExtensions({ mode: "rpc", onError: error => errors.push(String(error.error)), uiContext: {
      select: async () => { assert.fail("tool-execution scenario never prompts"); }, input: async () => { assert.fail("no input authorized"); },
      notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {},
    } });
    await executing.prompt("Remove the identity guideline.");
    assert.equal(probe, undefined);
    await executing.prompt("Run the synthetic probe.");
  } finally {
    await executing.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    executing.dispose();
  }
  assert.deepEqual(turns, [true, true, false, false], "only run 1 started with the tag");
  assert(probe, "the probe tool executed");
  assert.equal(fakeSelections, 2, "only explicit synthetic grant setups use fake UI");
  assert.equal(prompts.length, 2);
  assert.equal(modelCalls, 0);
  assert.deepEqual(network, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ observations, scoped, probe, fakeSelections, permissionPrompts: prompts.length, modelCalls, network, errors }));
}

if (process.argv.includes("--controlled-fixture")) {
  await controlledFixture();
} else test("real managed public parent query includes session grants/yolo, decides under the parent's own principal and rejects non-allow without prompting, offline", { timeout: 60000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-parent-answer-permission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "xdg-config", "xdg-cache", "xdg-state"]) mkdirSync(join(root, name), { mode: 0o700 });
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--controlled-fixture"], {
    cwd: repo, encoding: "utf8", timeout: 55000, stdio: ["ignore", "pipe", "pipe"],
    // No credentials, live settings, subagent hints, provider/Jev opt-ins,
    // inherited NODE_OPTIONS or executables can reach this isolated fixture.
    env: { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home/agent"),
      XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_STATE_HOME: join(root, "xdg-state"),
      PI_OFFLINE: "1", NO_COLOR: "1", PATH: "/dev/null" },
  });
  const evidence = JSON.parse(output);
  assert.deepEqual(evidence.observations.map(({ scenario, state }) => [scenario, state]), [
    ["allow", "allow"], ["deny", "deny"], ["ask", "ask"], ["session", "allow"], ["spawn-session", "ask"], ["yolo", "allow"],
  ]);
  assert.deepEqual(evidence.scoped, [
    { scenario: "profile-deny", gate: "deny", helper: "deny" },
    { scenario: "profile-ask", gate: "ask", helper: "ask" },
    { scenario: "profile-allow", gate: "allow", helper: "allow" },
  ]);
  const { gateReason, ...probe } = evidence.probe;
  assert.deepEqual(probe, { tagInPrompt: false, activeAgentEntries: 0, unscoped: "allow", gate: "deny", helper: "deny" },
    "only the authority still holds the principal; return_to must follow its gate, not the unscoped allow");
  assert.match(gateReason ?? "", /agent_answer|deny|reviewer/i);
  assert.equal(evidence.modelCalls, 0);
  assert.deepEqual(evidence.network, []);
  assert.deepEqual(evidence.errors, []);
});
