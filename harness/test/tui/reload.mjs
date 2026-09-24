// Test-only extension. Its deliberately live child exposes the host reload gap.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { controlledProvider, loadHost } from "../support/host.mjs";

export default async function (pi) {
  if (!process.env.P0_TUI_REPORT) throw new Error("P0 fixture environment required");
  // Explicitly use the running CLI, not dev dependencies/native TS import.
  const { sdk, ai, permission, permissionEntry } = await loadHost(process.argv[1]);
  const record = (event) => appendFileSync(process.env.P0_TUI_REPORT,
    JSON.stringify({ timestamp: Date.now(), ...event }) + "\n", { mode: 0o600 });
  const key = Symbol.for("@rocklee/pi-agent-harness:p0-tui-reload");
  const state = globalThis[key] ??= {};
  const fixture = controlledProvider(ai);
  pi.registerProvider("harness-fixture", fixture.config);
  pi.registerCommand("harness-fixture-reload", {
    description: "P0: invoke real extension command context reload",
    handler: async (_args, ctx) => {
      record({ event: "command-entered" });
      await ctx.reload();
      record({ event: "command-returned" });
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (state.child) {
      let oldRunnerInvalidated = false;
      try { state.oldApi.getActiveTools(); } catch { oldRunnerInvalidated = true; }
      record({ event: "reloaded", outcome: "unsafe-live-reload", boundary: "unsupported-live-owner-reload", oldRunnerInvalidated,
        permissionReplaced: permission.getPermissionsService(ctx.sessionManager.getSessionId()) !== state.oldService,
        childStillExecuting: state.child.session.isStreaming });
      state.release();
      await state.execution;
      state.child.session.clearQueue();
      await disposeChild(state.child.session, pi.events);
      state.done = true;
      record({ event: "fixture-cleaned" });
      return;
    }
    const cwd = join(process.env.P0_REPORT_DIR, `tui-child-${process.env.P0_TUI_ENTRY}`);
    mkdirSync(cwd, { mode: 0o700 });
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const definition = readFileSync(join(agentDir, "agents/reader.md"), "utf8");
    const bus = sdk.createEventBus();
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, eventBus: bus, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [permissionEntry, join(agentDir, "extensions/static-safety-guard.ts")],
      appendSystemPromptOverride: () => [definition.split(/^---\s*$/m).slice(2).join("\n"), '<active_agent name="reader"/>'],
    });
    await loader.reload();
    const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null, modelsStorePath: join(cwd, "unused-cache.json"), refreshOnCreate: false });
    const held = controlledProvider(ai);
    held.respond(() => new Promise((resolve) => { state.release = () => resolve({ reason: "aborted", error: "fixture release" }); }));
    runtime.registerProvider("harness-fixture", held.config);
    const sm = sdk.SessionManager.inMemory(cwd);
    sm.newSession({ parentSession: ctx.sessionManager.getSessionId() });
    sm.appendCustomEntry("active_agent", { name: "reader" });
    state.child = await assembleChild({ createSession: sdk.createAgentSession,
      options: { cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("harness-fixture", "controlled"),
        resourceLoader: loader, sessionManager: sm, settingsManager: settings, tools: ["read", "bash"], thinkingLevel: "off" },
      parentBus: pi.events, childBus: bus, parentSessionId: ctx.sessionManager.getSessionId(), profile: "reader",
      definitionDigest: digest(definition), getPermissionsService: permission.getPermissionsService,
    });
    state.oldApi = pi;
    state.oldService = permission.getPermissionsService(ctx.sessionManager.getSessionId());
    const requested = held.requested();
    state.execution = state.child.session.prompt("Hold temporary P0 stream", { expandPromptTemplates: false });
    await requested;
    record({ event: "ready", childStillExecuting: state.child.session.isStreaming,
      permissionPresent: !!state.oldService });
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (state.done) return;
    record({ event: "shutdown-veto-attempt", reason: event.reason,
      childStillExecuting: state.child?.session.isStreaming,
      permissionPresent: !!permission.getPermissionsService(ctx.sessionManager.getSessionId()) });
    return { cancel: true }; // Real ExtensionRunner ignores this. Never production code.
  });
}
