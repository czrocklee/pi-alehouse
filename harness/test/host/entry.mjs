// One ordinary wiring smoke of the actual opt-in extension, not another race matrix.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { controlledProvider, loadHost } from "../support/host.mjs";
import { disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { managementToolNames as delegationTools, cleanupToolNames } from "../../dist/tools/tool-names.js";
import { FileOwnerLease as ExecutionOwner } from "../../dist/runtime/owner-lease.js";
import { assertNoOrchestrationPrompt, assertCallerTools } from "../support/caller-contract.mjs";

const [piExecutable, agentDir, outputRoot] = process.argv.slice(2);
// Load the real launcher extension list, but never the live JEV credential or
// enforcement mode. Its network path is also blocked by the canary below.
process.env.PI_JEV_APPROVAL_MODE = "shadow";
delete process.env.PI_JEV_API_KEY_FILE;
const networkAttempts = [];
globalThis.fetch = async (input) => { networkAttempts.push(String(input)); throw new Error("Unexpected entry-smoke network request"); };
const { sdk, ai, permission, permissionRoot, versions } = await loadHost(piExecutable);
const { KeybindingsManager } = await import(new URL("core/keybindings.js",
  import.meta.resolve("@earendil-works/pi-coding-agent")));
const keybindings = KeybindingsManager.create(agentDir);
const packaged = JSON.parse(readFileSync(join(outputRoot, "entry-package.json"), "utf8"));
const orchestration = JSON.parse(readFileSync(join(outputRoot, "orchestration-prompts.json"), "utf8"));
const childToolsByProfile = {};
assert.equal(packaged.permissionRoot, resolve(permissionRoot, ".."));
const webTools = ["web_search", "source_check", "fetch_content", "get_search_content"];
const cwd = join(outputRoot, "entry-project");
mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, "source.txt"), "ENTRY_READ_OK\n");
process.env.PI_HARNESS_PERMISSION_ROOT = resolve(permissionRoot, "..");
process.env.PI_HARNESS_POLICY_ROOT = packaged.policyRoot;
process.env.PI_HARNESS_FLOCK = packaged.flock;
const entry = packaged.extensionPaths[0];
const provider = controlledProvider(ai);
// Synthetic TTL/pricing makes a refresh eligible after one second, including
// idle sessions. IO still goes exclusively to the controlled provider below.
Object.assign(provider.config.models[0], { promptCache: { short: 11, long: 11 },
  cost: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } });
const settingsPath = join(agentDir, "settings.json");
const savedSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
// $RESOURCE_DIR is shared by every fixture in one check run, and the collector
// runs each under `timeout -k 5s 120s`, so a SIGTERM must not leave the warming
// setting behind for the next fixture's children. Idempotent; sync only.
let settingsOverridden = false;
const restoreSettings = () => {
  if (!settingsOverridden) return;
  settingsOverridden = false;
  if (savedSettings === undefined) rmSync(settingsPath, { force: true });
  else writeFileSync(settingsPath, savedSettings, { mode: 0o600 });
};
process.on("exit", restoreSettings);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  // Restore, then re-raise so the collector still sees death by signal.
  process.on(signal, () => { restoreSettings(); process.removeAllListeners(signal); process.kill(process.pid, signal); });
}
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
  modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert.equal(model.promptCache.short, 11);
const settings = sdk.SettingsManager.inMemory({ cacheWarming: "idle", compaction: { enabled: false }, retry: { enabled: false } });
const children = new Set(), errors = [], parentPresentOnDisposal = [], readyParents = [], notices = [], statuses = [];
// Each scripted choice still travels through the packaged picker component and
// its real key handling; never return an invented selection from the UI mock.
const presetSelections = [];
const pickerKeys = { up: "\u001b[A", down: "\u001b[B", left: "\u001b[D", right: "\u001b[C",
  enter: "\r", esc: "\u001b", "alt+s": "\u001bs" };
let focusedPicker, activePickerCustoms = 0, failPresetStatus = false;
const uiEvidence = { footer: false, title: false, queueBeforeAuthority: false, pickerModes: [] };
const unexpectedDialog = async () => { throw new Error("Unexpected permission/UI grant in entry smoke"); };
const waitUntil = async (predicate, label, timeoutMs = 3000) => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert(performance.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const pickerTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text,
  italic: (text) => text, strikethrough: (text) => text };
const ui = { select: unexpectedDialog, confirm: unexpectedDialog, input: unexpectedDialog, editor: unexpectedDialog,
  async custom(factory, options) {
    if (!presetSelections.length) return unexpectedDialog("Unexpected custom UI");
    const requested = presetSelections.shift();
    uiEvidence.pickerModes.push(options?.overlay === true ? "overlay" : "docked");
    activePickerCustoms++;
    try {
      if (requested?.queued) {
        requested.entered.resolve();
        await requested.release.promise;
      }
      const tui = { terminal: { columns: 100, rows: 30 }, requestRender() {} };
      let result = Symbol("unsettled");
      const settled = Promise.withResolvers();
      const component = await factory(tui, pickerTheme, keybindings, (value) => { result = value; settled.resolve(); });
      if (requested?.focused) {
        focusedPicker = component;
        await settled.promise;
        focusedPicker = undefined;
      } else if (requested === undefined) component.handleInput?.("\u001b");
      else if (!requested?.queued) {
        // Start from a known endpoint so this fixture covers targets behind as
        // well as ahead of the active row. Scripted edits use the SAME picker
        // instance, including Esc returning from editor to list.
        const target = typeof requested === "string" ? requested : requested.target;
        component.handleInput?.("\u001b[H");
        for (let i = 0; component.selection?.() !== target && i < 128; i++) component.handleInput?.(pickerKeys.down);
        assert.equal(component.selection?.(), target, `picker could not reach ${target}`);
        if (typeof requested === "string") component.handleInput?.(pickerKeys.enter);
        else {
          assert.equal(typeof component.render, "function", "host picker must expose the component renderer");
          for (const [index, step] of requested.steps.entries()) {
            component.handleInput?.(pickerKeys[step] ?? step);
            const painted = component.render(76).join("\n");
            if (requested.expectPaint?.[index]) assert(painted.includes(requested.expectPaint[index]),
              `picker step ${index} (${step}) did not paint ${requested.expectPaint[index]}: ${painted}`);
          }
          if (requested.expectResult !== undefined) assert.deepEqual(result, requested.expectResult);
        }
      }
      component.dispose?.();
      assert.notEqual(typeof result, "symbol", "picker did not settle");
      return result;
    } finally { activePickerCustoms--; focusedPicker = undefined; }
  },
  notify(message) { notices.push(message); },
  setStatus(key, value) {
    if (key === "harness-preset" && value !== undefined && failPresetStatus) throw new Error("ENTRY_FOOTER_PAINT_FAILURE");
    statuses.push({ key, value });
  }, setWidget() {},
  setFooter(factory) { uiEvidence.footer ||= typeof factory === "function"; },
  setTitle(title) { uiEvidence.title ||= title.startsWith("π - "); } };
let request, sequence = 0, parent, parentBus, runtimeHost;
let expectedWorkers = "off-empty", initialOffPrompt;
const offRequests = [];
const heldResponse = Promise.withResolvers();
let heldResponseEntered = false;
// An idle Agent's completed row carries its real SDK context size as a reuse-cost
// hint; check it is a plain count, then compare the rest of the row exactly.
const settledRows = (agents) => agents.map(({ context_tokens, ...row }) => {
  assert(Number.isSafeInteger(context_tokens) && context_tokens >= 0, `context_tokens on ${row.agent}/${row.task}`);
  return row;
});
const text = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
provider.respond(async ({ context, maxTokens }) => {
  if (maxTokens === 1) return { text: "SYNTHETIC_CACHE_WARM" };
  if (context.systemPrompt.includes("ENTRY_BASELINE")) return { text: "BASELINE_DONE" };
  if (context.systemPrompt.includes("ENTRY_PARENT")) {
    assertNoOrchestrationPrompt(context.systemPrompt);
    const exposed = context.tools.filter((tool) => delegationTools.includes(tool.name)).map((tool) => tool.name).sort();
    const expected = expectedWorkers === "on" ? delegationTools : expectedWorkers === "off-retained" ? cleanupToolNames : [];
    assert.deepEqual(exposed, [...expected].sort(), `provider-visible worker tools (${expectedWorkers})`);
    if (expectedWorkers === "on") assertCallerTools(context.tools);
    if (expectedWorkers === "off-empty") {
      // Independent positive control: the same installed SDK and extension list
      // without harness. Session.systemPrompt alone omits request-time native
      // tool summaries/guidelines, so compare actual provider-visible prompts.
      assert.equal(context.systemPrompt, initialOffPrompt,
        "initial Off must match the no-harness prompt, without even a renamed instruction block");
      const serialized = JSON.stringify(context);
      for (const name of delegationTools) assert(!serialized.includes(name), `initial Off leaked ${name} into the actual request`);
      assert(!serialized.includes("harness:preset-selection"), "selection metadata must not become model context");
      offRequests.push({ systemPrompt: context.systemPrompt, tools: context.tools.map((tool) => tool.name) });
    }
    if (request && !request.sent) {
      request.sent = true;
      return { tools: [{ type: "toolCall", id: request.id, name: request.name, arguments: request.args }] };
    }
    return { text: "PARENT_DONE" };
  }
  assert(!context.tools.some((tool) => delegationTools.includes(tool.name)), "nested delegation exposed");
  assert(!context.tools.some((tool) => webTools.includes(tool.name)), "parent web tools exposed to child");
  const profile = /<active_agent name="([^"]+)"\/>/.exec(context.systemPrompt)?.[1];
  assert(["editor", "reader"].includes(profile));
  const names = context.tools.map((tool) => tool.name).sort();
  childToolsByProfile[profile] = names;
  for (const name of ["edit", "write"]) assert.equal(names.includes(name), profile === "editor");
  assert(names.includes("read") && names.includes("bash"));
  const operation = text(context.messages.findLast((message) => message.role === "user"));
  if (operation.includes("ENTRY_HOLD")) {
    heldResponseEntered = true;
    await heldResponse.promise;
    return { text: "ENTRY_HOLD_DONE" };
  }
  if (operation.includes("ENTRY_WRITE") || operation.includes("ENTRY_EDIT")) {
    const editing = operation.includes("ENTRY_EDIT");
    const name = editing ? "edit" : "write";
    assert(context.tools.some((tool) => tool.name === name), `${name} not exposed to worker`);
    if (context.messages.at(-1)?.role === "toolResult") {
      assert.equal(context.messages.at(-1).toolName, name);
      assert.equal(context.messages.at(-1).isError, false, text(context.messages.at(-1)));
      return { text: editing ? "ENTRY_EDIT_OK" : "ENTRY_WRITE_OK" };
    }
    return { tools: [{ type: "toolCall", id: `${name}-${sequence++}`, name, arguments: editing
      ? { path: "edited.txt", oldText: "before", newText: "after" }
      : { path: "edited.txt", content: "before\n" } }] };
  }
  assert(!context.tools.some((tool) => ["edit", "write"].includes(tool.name)), "write tools exposed to readonly worker");
  if (context.messages.at(-1)?.role === "toolResult") {
    assert.equal(text(context.messages.at(-1)).trim(), "ENTRY_READ_OK");
    return { text: "ENTRY_READ_OK" };
  }
  return { tools: [{ type: "toolCall", id: `read-${sequence++}`, name: "read", arguments: { path: "source.txt" } }] };
});
// Recreate the actual extension list through the SDK's real replacement route,
// not by emitting shutdown/start manually on an old extension closure.
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const bus = sdk.createEventBus();
  const services = await sdk.createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager: settings,
    resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true, systemPromptOverride: () => `ENTRY_PARENT\n${orchestration.pi}`,
      additionalExtensionPaths: packaged.extensionPaths } });
  const extensions = services.resourceLoader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  assert(!extensions.extensions.some((e) => /luna-auto-approval|pi-subagents/.test(e.path)));
  const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
  const session = result.session;
  parent = session; parentBus = bus;
  bus.on(permission.PERMISSIONS_READY_CHANNEL, ({ sessionId }) => {
    if (sessionId !== session.sessionId) return;
    const activeUI = session.extensionRunner.createContext().ui; // SDK wraps the supplied UI object.
    assert.equal(activeUI.select[Symbol.for("nixos-config.pi.ui-prompt-queue.wrapped.v1")], true);
    uiEvidence.queueBeforeAuthority = true; readyParents.push(sessionId);
  });
  bus.on("subagents:child:bound", ({ sessionId }) => children.add(sessionId));
  bus.on("subagents:child:disposed", ({ sessionId }) => {
    if (children.has(sessionId)) parentPresentOnDisposal.push(!!permission.getPermissionsService(session.sessionId));
  });
  return { ...result, services, diagnostics: services.diagnostics };
};
const bind = (session) => session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error.error) });
const presetPath = join(agentDir, "harness-presets.json"), presetEntry = "harness:preset-selection:v1";
const preset = (version) => ({ version, slots: Object.fromEntries(["d1", "d2", "d3", "d4", "d5"]
  .map((slot) => [slot, { model: "harness-fixture/controlled" }])) });
const writePresets = (presets) => writeFileSync(presetPath, JSON.stringify({ version: 3,
  defaultPreset: Object.keys(presets)[0] ?? "off", presets }), { mode: 0o600 });
const selectedEntries = () => parent.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === presetEntry);
const presetStatus = () => statuses.findLast((entry) => entry.key === "harness-preset")?.value;
try {
  // This is the isolated generated agent directory, never the user's settings.
  // Production children inherit it; applyOverrides(cacheWarming:off) alone would
  // NOT override this global-only setting, so this catches that tempting bug.
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(savedSettings ?? "{}"), cacheWarming: "idle" }), { mode: 0o600 });
  settingsOverridden = true;
  const baselineBus = sdk.createEventBus();
  const baselineLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, eventBus: baselineBus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPromptOverride: () => `ENTRY_BASELINE\n${orchestration.pi}`, additionalExtensionPaths: packaged.extensionPaths.slice(1) });
  await baselineLoader.reload();
  assert.deepEqual(baselineLoader.getExtensions().errors, []);
  const { session: baselineSession } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings,
    resourceLoader: baselineLoader, sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model, thinkingLevel: "off" });
  let baselineCleanup;
  try {
    await baselineSession.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error.error) });
    await baselineSession.prompt("Observe the baseline prompt and tool declarations.");
    const baselineCall = provider.requests.find((call) => call.maxTokens !== 1 && call.context.systemPrompt.includes("ENTRY_BASELINE"));
    assert(baselineCall, "no-harness positive control must reach the controlled provider");
    assert.equal(baselineSession.getLastAssistantText(), "BASELINE_DONE");
    assert.equal(baselineCall.context.tools.some((tool) => delegationTools.includes(tool.name)), false);
    initialOffPrompt = baselineCall.context.systemPrompt.replace("ENTRY_BASELINE", "ENTRY_PARENT");
  } finally {
    baselineCleanup = await disposeChild(baselineSession, baselineBus);
    assert(baselineCleanup.shutdownExited && !baselineCleanup.errors.length);
  }
  // Seed a real branched session: all entries end in an abandoned enabled
  // selection, while the active branch ends in Off. The first model request
  // must have neither harness declarations nor a disabled-mode instruction.
  writePresets({ "entry-fixture": preset("v1"), "entry-other": preset("v1") });
  const parentManager = sdk.SessionManager.create(cwd, join(outputRoot, "entry-sessions"));
  const rootEntry = parentManager.appendCustomEntry("fixture:branch-root", {});
  const branchA = parentManager.appendCustomEntry(presetEntry, { name: "off", version: "historical-v0", digest: "0".repeat(64) });
  parentManager.branch(rootEntry);
  parentManager.appendCustomEntry(presetEntry, { name: "entry-other" });
  parentManager.branch(branchA);
  assert.equal(parentManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === presetEntry).at(-1).data.name, "entry-other");
  assert.equal(parentManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === presetEntry).at(-1).data.name, "off");
  runtimeHost = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: parentManager });
  runtimeHost.setRebindSession(bind);
  await bind(parent);
  assert.equal(presetStatus(), "delegation: off", "startup must restore Off from the active branch, not the abandoned enabled choice");
  assert.equal(parent.model, model);
  assert.equal(parent.getActiveToolNames().some((name) => delegationTools.includes(name)), false);
  for (const name of ["read", "bash"]) assert(parent.getActiveToolNames().includes(name), `${name} lost while workers are off`);
  for (const name of webTools) assert(parent.getToolDefinition(name), `${name} not registered for the parent`);
  const initialOtherTools = parent.getActiveToolNames();
  request = { name: "read", args: { path: "source.txt" }, id: "off-parent-read", sent: false };
  await parent.prompt("Read source.txt directly.");
  const directRead = parent.messages.find((message) => message.role === "toolResult" && message.toolCallId === request.id);
  assert(directRead && !directRead.isError, JSON.stringify(directRead ?? parent.messages.at(-1)));
  assert.equal(text(directRead).trim(), "ENTRY_READ_OK");
  assert.equal(offRequests.length, 2, "both the initial and post-tool request must remain free of harness declarations");
  assert.equal(children.size, 0, "Off must not create a child session");
  request = undefined;
  assert.deepEqual(parent.getActiveToolNames(), initialOtherTools, "Off reconciliation must not change another extension's activation");
  // The first controlled assistant response above persists this session. Neither
  // Owner has accepted worker work. Resume a different ID, then use the actual
  // SDK selector callback to return; await the whole replacement, not just the
  // early assignment in createRuntime before extensions have rebound.
  const { InteractiveMode } = sdk; sdk.initTheme(undefined, false);
  const interactiveStatuses = [];
  const interactiveHost = {
    runtimeHost, ui: { requestRender() {} },
    get sessionManager() { return parent.sessionManager; }, keybindings,
    clearStatusIndicator() {}, showStatus: (message) => interactiveStatuses.push(message),
    handleFatalRuntimeError(label, error) { throw new Error(label, { cause: error }); },
    createProjectTrustContext: (cwd) => ({ cwd, mode: "tui", hasUI: true, ui }),
  };
  const firstInteractiveParent = parent, firstInteractiveService = permission.getPermissionsService(parent.sessionId);
  assert(firstInteractiveService); assert(existsSync(parent.sessionFile));
  const interactiveTarget = sdk.SessionManager.forkFrom(parent.sessionFile, cwd, join(outputRoot, "entry-interactive-sessions"));
  const interactiveResume = await InteractiveMode.prototype.handleResumeSession.call(interactiveHost, interactiveTarget.getSessionFile());
  assert.equal(interactiveResume.cancelled, false); assert.notEqual(parent, firstInteractiveParent);
  assert.equal(permission.getPermissionsService(firstInteractiveParent.sessionId), undefined);
  const firstInteractiveReplacementService = permission.getPermissionsService(parent.sessionId);
  assert(firstInteractiveReplacementService); assert.notEqual(firstInteractiveReplacementService, firstInteractiveService);
  let interactiveSelector, selecting, selectorDone = 0;
  interactiveHost.showSelector = (factory) => { interactiveSelector = factory(() => { selectorDone++; }).component; };
  interactiveHost.handleResumeSession = (sessionPath, options) =>
    (selecting = InteractiveMode.prototype.handleResumeSession.call(interactiveHost, sessionPath, options));
  const selectedInteractiveParent = parent, selectedInteractiveService = firstInteractiveReplacementService;
  InteractiveMode.prototype.showSessionSelector.call(interactiveHost);
  assert(interactiveSelector); assert.equal(typeof interactiveSelector.getSessionList().onSelect, "function");
  interactiveSelector.getSessionList().onSelect(firstInteractiveParent.sessionFile);
  assert(selecting); assert.equal((await selecting).cancelled, false);
  assert.equal(selectorDone, 1); assert.equal(permission.getPermissionsService(selectedInteractiveParent.sessionId), undefined);
  const selectorReplacementService = permission.getPermissionsService(parent.sessionId);
  assert(selectorReplacementService); assert.notEqual(selectorReplacementService, selectedInteractiveService);
  assert.deepEqual(interactiveStatuses, ["Resumed session", "Resumed session"]);
  assert.deepEqual(errors, []);
  assert.equal(presetStatus(), "delegation: off");
  assert.equal(parent.getActiveToolNames().some((name) => delegationTools.includes(name)), false);
  // The installed web package can start with deferred tools. Make an explicit
  // public-SDK selection as a controlled unrelated change; never execute web IO.
  parent.setActiveToolsByName([...new Set([...initialOtherTools, ...webTools])]);
  const selectedOtherTools = parent.getActiveToolNames();
  await parent.prompt("/harness-preset entry-fixture");
  expectedWorkers = "on";
  assert.deepEqual(parent.getActiveToolNames().filter((name) => !delegationTools.includes(name)), selectedOtherTools);
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");
  const shortcuts = parent.extensionRunner.getShortcuts(keybindings.getEffectiveConfig());
  assert(shortcuts.has("alt+s"), "Alt+S worker-preset shortcut is registered");
  assert(shortcuts.has("alt+a"), "Alt+A detail shortcut is retained");
  assert(!shortcuts.has("ctrl+s"), "Ctrl+S remains Pi's model/thinking save");

  // Failed direct selection and cancelled picker preserve the live v1 snapshot
  // despite an altered v2 file; neither writes audit metadata.
  writePresets({ "entry-fixture": preset("v2"), "entry-other": preset("v1") });
  const initialAudit = selectedEntries().length;
  await parent.prompt("/harness-preset typo");
  assert.equal(JSON.parse(notices.at(-1)).code, "PRESET_NOT_FOUND");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture"); assert.equal(selectedEntries().length, initialAudit);
  presetSelections.push(undefined);
  await parent.prompt("/harness-preset");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture"); assert.equal(selectedEntries().length, initialAudit);

  // Reload commits v2 atomically. Removing the active preset makes reload fail
  // without changing status/audit, while an explicit switch-away succeeds.
  await parent.prompt("/harness-preset reload");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");
  assert.equal(selectedEntries().at(-1).data.version, "v2");
  const reloadAudit = selectedEntries().length;
  writePresets({ "entry-other": preset("v3") });
  await parent.prompt("/harness-preset reload");
  assert.equal(JSON.parse(notices.at(-1)).code, "PRESET_NOT_FOUND");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture"); assert.equal(selectedEntries().length, reloadAudit);
  await parent.prompt("/harness-preset entry-other");
  assert.equal(presetStatus(), "delegation: co-worker/entry-other"); assert.equal(selectedEntries().at(-1).data.version, "v3");
  // Drive the registered shortcut through the packaged extension. Reintroduce
  // two presets and choose the lexically earlier row to cover backward targets;
  // the mock presses Home before deterministic downward navigation.
  writePresets({ "entry-fixture": preset("v4"), "entry-other": preset("v3") });
  assert("entry-fixture" < "entry-other");
  const shortcutAudit = selectedEntries().length;
  presetSelections.push("entry-fixture");
  shortcuts.get("alt+s").handler({});
  await waitUntil(() => selectedEntries().length === shortcutAudit + 1, "Alt+S preset selection");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");
  assert.equal(parent.model, model, "worker picker must not change the parent model");

  // The same registered shortcut closes its own mounted picker without commit
  // or warning. A queued picker can be toggled closed before its factory runs.
  const toggleAudit = selectedEntries().length, noticesBeforeToggle = notices.length;
  presetSelections.push({ focused: true });
  shortcuts.get("alt+s").handler({});
  await waitUntil(() => !!focusedPicker, "focused Alt+S picker");
  shortcuts.get("alt+s").handler({});
  await waitUntil(() => !focusedPicker && activePickerCustoms === 0, "focused picker toggle close");
  assert.equal(selectedEntries().length, toggleAudit); assert.equal(notices.length, noticesBeforeToggle);
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");

  const queued = { queued: true, entered: Promise.withResolvers(), release: Promise.withResolvers() };
  presetSelections.push(queued);
  shortcuts.get("alt+s").handler({});
  await queued.entered.promise;
  shortcuts.get("alt+s").handler({});
  queued.release.resolve();
  await waitUntil(() => activePickerCustoms === 0, "queued picker toggle close");
  assert.equal(selectedEntries().length, toggleAudit); assert.equal(notices.length, noticesBeforeToggle);
  assert.deepEqual(uiEvidence, { footer: true, title: true, queueBeforeAuthority: true,
    pickerModes: ["docked", "docked", "docked", "docked"] });

  // Audit/live publication succeeds before best-effort footer paint. A broken
  // footer therefore reports a warning but cannot turn the selection into a
  // failure or roll it back; the first worker below proves the live v5 route.
  const unresolvedInheritance = preset("v5");
  unresolvedInheritance.slots.d5.model = "harness-fixture/missing-inherit-model";
  assert.equal(runtime.getModel("harness-fixture", "missing-inherit-model"), undefined);
  writePresets({ "entry-fixture": unresolvedInheritance, "entry-other": preset("v3") });
  const beforeFooterAudit = selectedEntries().length;
  failPresetStatus = true;
  await parent.prompt("/harness-preset reload");
  failPresetStatus = false;
  assert.equal(selectedEntries().length, beforeFooterAudit + 1);
  assert.equal(selectedEntries().at(-1).data.version, "v5");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture", "failed footer paint leaves only stale UI, not stale routing");
  assert.match(notices.at(-1), /entry-fixture@v5 selected.*footer could not update.*ENTRY_FOOTER_PAINT_FAILURE/);

  // The nonreasoning model in the installed registry supports only "off".
  // D5 deliberately has an unresolved inherited model: it must not block
  // saving another slot or warn on session restoration before any spawn.
  // Arrows audit immediately; Esc returns without undoing, and Alt+S closes.
  // Editor Enter only returns to the list. List Enter still selects a name
  // rather than manufacturing an override record.
  const beforeEdit = selectedEntries().length;
  presetSelections.push({ target: "entry-fixture", steps: ["e", "down", "down", "right", "right", "esc", "esc"],
    expectPaint: { 0: "Effort · entry-fixture", 4: "d3:off", 5: "Delegation" }, expectResult: null });
  await parent.prompt("/harness-preset");
  presetSelections.push({ target: "entry-fixture", steps: ["e", "down", "down", "right", "right", "alt+s"],
    expectPaint: { 4: "d3:off" }, expectResult: null });
  await parent.prompt("/harness-preset");
  assert.equal(selectedEntries().length, beforeEdit + 2, "arrows audit inherit/off; bounded arrows and closing do not");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*", "live arrows repaint and closing retains them");
  presetSelections.push({ target: "entry-fixture", steps: ["e", "down", "down", "left", "right", "right", "enter", "esc"],
    expectPaint: { 0: "Effort · entry-fixture", 3: "d3:inherit", 4: "d3:off", 5: "d3:off", 6: "Delegation" },
    expectResult: null });
  await parent.prompt("/harness-preset");
  assert.equal(selectedEntries().length, beforeEdit + 4);
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, { d3: "off" });
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  await parent.prompt("/harness-preset entry-other");
  assert.equal(presetStatus(), "delegation: co-worker/entry-other");
  await parent.prompt("/harness-preset entry-fixture");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*", "switch-away/back remembers this preset's effort");
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, { d3: "off" });

  // A fresh unused Owner permits a real SDK InteractiveMode replacement. Fork
  // the persisted branch, not an in-memory copy or a synthetic session_start;
  // the new extension must replay the saved effort before its first admission.
  const beforeEffortReplacement = parent, beforeEffortService = permission.getPermissionsService(parent.sessionId);
  const beforeEffortRestoreNotices = notices.length;
  const effortTarget = sdk.SessionManager.forkFrom(parent.sessionFile, cwd, join(outputRoot, "entry-effort-sessions"));
  assert.equal((await InteractiveMode.prototype.handleResumeSession.call(interactiveHost, effortTarget.getSessionFile())).cancelled, false);
  assert.notEqual(parent, beforeEffortReplacement);
  assert.equal(permission.getPermissionsService(beforeEffortReplacement.sessionId), undefined);
  assert.notEqual(permission.getPermissionsService(parent.sessionId), beforeEffortService);
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, { d3: "off" });
  assert.equal(parent.model, model, "editing worker effort must not change the parent model");
  assert.equal(notices.slice(beforeEffortRestoreNotices).some((message) => message.includes("Saved worker effort needs attention")), false,
    "unresolved inherit is spawn-time validation, not a saved-policy warning");
  // Restore the controlled d5 model before later difficulty-5 work. This
  // rereads metadata without changing the successfully saved d3 override.
  writePresets({ "entry-fixture": preset("v5"), "entry-other": preset("v3") });
  await parent.prompt("/harness-preset reload");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  // Pi's transient active-tool choice is not saved in the session journal;
  // reselect the same unrelated tools after replacement before testing Off.
  parent.setActiveToolsByName([...selectedOtherTools, ...parent.getActiveToolNames().filter((name) => delegationTools.includes(name))]);
  assert.deepEqual(parent.getActiveToolNames().filter((name) => !delegationTools.includes(name)), selectedOtherTools);
  for (const name of [...delegationTools, ...webTools]) assert(parent.getActiveToolNames().includes(name), `${name} not active`);
  async function invoke(name, args) {
    request = { name, args, id: `parent-${sequence++}`, sent: false };
    const id = request.id;
    await parent.prompt("Run the requested management operation.");
    const result = parent.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);
    assert(result && !result.isError, result ? text(result) : JSON.stringify(parent.messages.at(-1)).slice(0, 2000));
    return JSON.parse(text(result));
  }
  // The preset owns harness names: the same request must restore a separately
  // deactivated agent_spawn tool before constructing the provider-visible tool list.
  parent.setActiveToolsByName(parent.getActiveToolNames().filter((name) => name !== "agent_spawn"));
  assert(!parent.getActiveToolNames().includes("agent_spawn"));
  const lastLink = () => parent.sessionManager.getBranch().findLast((entry) => entry.type === "custom" &&
    entry.customType === "harness:run-link:v1");
  const first = await invoke("agent_spawn", { agent: "entry", profile: "reader", reasoning_difficulty: 3,
    prompt: "Read source.txt", label: "Entry smoke", max_turns: 4, wait_ms: 60000 });
  assert.equal(first.reason, "done");
  assert.deepEqual(first.action, { type: "agent_spawn", agent: "entry", task: 1 });
  assert.deepEqual(settledRows(first.agents), [{ agent: "entry", task: 1, status: "completed", result: "ENTRY_READ_OK" }],
    "unified replies name the Agent/task and carry no routing");
  const fixedLink = lastLink();
  assert(fixedLink, "the real SDK child must record a parent run link");
  assert.equal(fixedLink.data.routing.thinking_resolution, "preset_fixed");
  assert.equal(fixedLink.data.routing.effort_source, "user_override");
  assert.equal(fixedLink.data.routing.parent_thinking, "off");
  const finish = async (envelope) => {
    const [reply] = envelope.agents; assert(reply);
    if (reply.status === "completed" && reply.result !== undefined && !reply.next_cursor) return reply;
    for (let i = 0; i < 8; i++) {
      const [waited] = (await invoke("agent_wait", { agents: [reply.agent], wait_ms: 1000 })).agents;
      if (waited.status === "completed") { assert.equal(waited.next_cursor, undefined); return waited; }
      assert(!["failed", "interrupted"].includes(waited.status), JSON.stringify(waited));
    }
    assert.fail("Task did not complete");
  };
  // Hold a real SDK child in an accepting task, not a finished one whose message
  // would not be delivered. Reuse the same resident Agent.
  const held = await invoke("agent_run", { agent: "entry", prompt: "ENTRY_HOLD", builds_on: "the entry task", label: "Entry hold" });
  await waitUntil(() => heldResponseEntered, "accepting child before Off");
  // Cached definitions bypass active-tool visibility, so these rejections prove
  // execution-side admission rather than merely an unavailable schema.
  const cachedTools = new Map(["agent_spawn", "agent_run", "agent_send", "agent_answer"].map((name) => [name, parent.getToolDefinition(name)]));
  const setActiveTools = parent.setActiveToolsByName.bind(parent);
  let visibilityFailureReached = false;
  parent.setActiveToolsByName = () => { visibilityFailureReached = true; throw new Error("ENTRY_TOOL_VISIBILITY_FAILURE"); };
  try { await parent.prompt("/harness-preset off"); }
  finally { parent.setActiveToolsByName = setActiveTools; }
  assert(visibilityFailureReached);
  assert.match(notices.at(-1), /off selected.*tool visibility could not update.*ENTRY_TOOL_VISIBILITY_FAILURE/);
  assert(parent.getActiveToolNames().includes("agent_spawn"), "fault must leave the stale executable tool visible");
  expectedWorkers = "off-retained";
  assert.deepEqual(parent.getActiveToolNames().filter((name) => !delegationTools.includes(name)), selectedOtherTools,
    "turning Off must preserve another extension's newly active tools");
  assert.equal(presetStatus(), "delegation: off");
  assert.equal(selectedEntries().at(-1).data.name, "off");
  assert.equal("models" in selectedEntries().at(-1).data, false);
  for (const [name, args] of [
    ["agent_spawn", { agent: "blocked", profile: "reader", reasoning_difficulty: 3, prompt: "Must not start", label: "Blocked" }],
    ["agent_run", { agent: "entry", prompt: "Must not start", builds_on: "the entry task" }],
    ["agent_send", { agent: "entry", message: "Must not steer" }],
    ["agent_answer", { agent: "entry", question_id: `q_${"0".repeat(32)}`, answer: "Must not answer" }],
  ]) {
    await assert.rejects(cachedTools.get(name).execute(`off-block-${name}-${args.agent}`, args, undefined, undefined,
      parent.extensionRunner.createContext()), /WORKERS_DISABLED/);
  }
  await assert.rejects(cachedTools.get("agent_send").execute("off-unknown", { agent: "unknown", message: "Must not send" },
    undefined, undefined, parent.extensionRunner.createContext()), /AGENT_NOT_FOUND/);
  assert.equal(children.size, 1);
  const offResult = await invoke("agent_read", { agent: "entry" });
  assert.deepEqual(parent.getActiveToolNames().filter((name) => delegationTools.includes(name)), cleanupToolNames,
    "the next request must repair tool visibility without changing the Off selection");
  assert.equal(offResult.reason, "snapshot"); assert.equal(offResult.workers_disabled, true);
  assert.equal(offResult.agents[0].status, "running", "Off keeps inspection of the accepted task");
  heldResponse.resolve();
  assert.equal((await finish(held)).result, "ENTRY_HOLD_DONE", "accepted work must finish while Off");
  await parent.prompt("/harness-preset entry-other");
  expectedWorkers = "on";
  const next = await invoke("agent_run", { agent: "entry", prompt: "Read source.txt again", builds_on: "its earlier read of source.txt", label: "Entry again", wait_ms: 60000 });
  assert.equal(next.reason, "done");
  assert.deepEqual(next.action, { type: "agent_run", agent: "entry", task: 3 });
  assert.deepEqual(settledRows(next.agents), [{ agent: "entry", task: 3, status: "completed", result: "ENTRY_READ_OK" }]);
  assert.deepEqual(lastLink().data.routing, fixedLink.data.routing, "reenabling a different preset must not reconfigure a reused fixed-effort Agent");
  await parent.prompt("/harness-preset entry-fixture");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  // An explicit inherit is distinct from the preset default in the audit, but
  // has identity resolution. Reset removes that override and clears the star.
  const inheritAudit = selectedEntries().length;
  presetSelections.push({ target: "entry-fixture", steps: ["e", "down", "down", "left", "enter", "esc"],
    expectPaint: { 0: "Effort · entry-fixture", 3: "d3:inherit", 4: "Delegation" }, expectResult: null });
  await parent.prompt("/harness-preset");
  assert.equal(selectedEntries().length, inheritAudit + 1);
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, { d3: "inherit" });
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  const inherited = await invoke("agent_spawn", { agent: "inherit", profile: "reader", reasoning_difficulty: 3,
    prompt: "Read source.txt", label: "Explicit inherit control", max_turns: 4, wait_ms: 60000 });
  assert.equal(inherited.reason, "done");
  assert.deepEqual(inherited.action, { type: "agent_spawn", agent: "inherit", task: 1 });
  assert.deepEqual(settledRows(inherited.agents), [{ agent: "inherit", task: 1, status: "completed", result: "ENTRY_READ_OK" }], "effort provenance never reaches the model");
  const inheritedLink = lastLink();
  assert.equal(inheritedLink?.data.routing.effort_source, "user_override");
  assert.equal(inheritedLink?.data.routing.thinking_resolution, "identity",
    "new Agent at the same slot inherits parent off; the old fixed Agent retains its original resolution");
  assert.equal((await invoke("agent_kill", { agent: "inherit" })).status, "killed");
  const resetAudit = selectedEntries().length;
  presetSelections.push({ target: "entry-fixture", steps: ["e", "r", "enter", "esc"],
    expectPaint: { 1: "d3:default", 2: "Delegation" }, expectResult: null });
  await parent.prompt("/harness-preset");
  assert.equal(selectedEntries().length, resetAudit + 1);
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, {});
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");
  // Reset affects only future Agents, not the resident child whose Run was
  // fixed at admission. Read-only list projection must keep that old setting.
  const retained = await invoke("agent_list", {});
  assert.deepEqual(retained.agents.map((row) => [row.agent, row.profile, row.reasoning_difficulty]), [["entry", "reader", 3]]);
  assert.deepEqual(uiEvidence.pickerModes, Array(9).fill("docked"),
    "all edited/cancelled choices used the installed component, not a fabricated UI return");
  const effortEditing = { fixed_routing: fixedLink.data.routing, inherited_routing: inheritedLink.data.routing,
    restored_status: "delegation: co-worker/entry-fixture*", reset_status: presetStatus(),
    reset_overrides: selectedEntries().at(-1).data.effort_overrides };
  // Positive control: require a NEW parent refresh after this resume completes;
  // an older refresh cannot stand in for the child's newly reset idle timer.
  // The child became idle first. No private timer API/mocks are used.
  // This control depends on host scheduling (90%-of-TTL with a 10s floor), on
  // the prefix-identity check, and on the $0.05 savings threshold. Its failure
  // means the synthetic setup no longer warms at all, NOT that the child veto
  // regressed -- the child evidence below is what carries that property.
  const isWarm = (call) => call.maxTokens === 1;
  const isParentCall = (call) => call.context.systemPrompt.includes("ENTRY_PARENT");
  const afterResume = provider.requests.length, warmDeadline = performance.now() + 20000;
  while (!provider.requests.slice(afterResume).some((call) => isWarm(call) && isParentCall(call))) {
    assert(performance.now() < warmDeadline,
      "synthetic parent warming never fired: check promptCache TTL vs the host's warming delay rule, pricing vs its savings threshold, and that the parent stayed on one prompt prefix");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Measured, not asserted-and-then-restated: the report must not be able to
  // claim zero child refreshes if the discriminator or the assert ever drifts.
  const warmed = provider.requests.filter(isWarm);
  const childWarmed = warmed.filter((call) => !isParentCall(call));
  const inheritedMode = JSON.parse(readFileSync(settingsPath, "utf8")).cacheWarming;
  const cacheWarming = { parent_refreshes: warmed.length - childWarmed.length,
    child_refreshes: childWarmed.length, inherited_mode: inheritedMode };
  // Name the offending profile on failure, not just the shared model id.
  assert.deepEqual(childWarmed.map((call) => /<active_agent name="([^"]+)"\/>/.exec(call.context.systemPrompt)?.[1] ?? "unknown"),
    [], "child issued an unbudgeted cache-warming request");
  assert(cacheWarming.parent_refreshes > 0, "parent warming evidence is missing");
  assert.equal(inheritedMode, "idle", "child must not persistently change global policy");
  settings.setCacheWarmingMode("off"); // Fixture-only in-memory parent; rest of the smoke need not warm.
  assert.equal((await invoke("agent_kill", { agent: "entry" })).status, "killed");
  // No residents is still an open Owner: the actual SDK replacement route must
  // remain blocked without implicitly closing the Owner or changing its parent.
  await parent.prompt("/harness-status");
  const emptyOwner = JSON.parse(notices.at(-1)), sameParent = parent;
  assert.equal(emptyOwner.resident, 0); assert.equal(emptyOwner.closed, false);
  // This Owner has accepted/released work. A UI object without confirm must
  // fail closed rather than treating a missing method as implicit approval.
  const contextUI = parent.extensionRunner.createContext().ui;
  const missingConfirm = contextUI.confirm; contextUI.confirm = undefined;
  try { assert.equal((await runtimeHost.newSession()).cancelled, true); }
  finally { contextUI.confirm = missingConfirm; }
  assert.equal(parent, sameParent); assert.match(notices.at(-1), /Could not confirm harness Owner closure/);
  // Use the unmodified managed policy: write/edit and wait/resume must work
  // without a UI grant or fixture-only management-tool allow rules.
  const idle = await invoke("agent_spawn", { agent: "writer", profile: "editor", reasoning_difficulty: 5,
    prompt: "ENTRY_WRITE: create edited.txt", label: "Writable entry smoke", max_turns: 4 });
  assert.equal((await finish(idle)).result, "ENTRY_WRITE_OK");
  assert.equal(readFileSync(join(cwd, "edited.txt"), "utf8"), "before\n");
  const edited = await invoke("agent_run", { agent: "writer", prompt: "ENTRY_EDIT: change before to after in edited.txt", builds_on: "the writer task", label: "Edit" });
  assert.deepEqual(edited.action, { type: "agent_run", agent: "writer", task: 2 });
  assert.equal((await finish(edited)).result, "ENTRY_EDIT_OK");
  assert.equal(readFileSync(join(cwd, "edited.txt"), "utf8"), "after\n");

  // Establish an accurate footer, then inject the SDK's ambiguous failure
  // shape: append changes the real parent branch and returns an id, but the
  // call still throws before AgentSession can emit entry_appended. The live
  // router remains v5 and the shared owner is latched permanently.
  await parent.prompt("/harness-preset reload");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture");
  writePresets({ "entry-fixture": preset("v5"), "entry-other": preset("v6") });
  const appendCustomEntry = parent.sessionManager.appendCustomEntry.bind(parent.sessionManager);
  const beforeAmbiguousAudit = selectedEntries().length;
  let auditAppendInjected = false;
  parent.sessionManager.appendCustomEntry = (customType, data) => {
    const id = appendCustomEntry(customType, data);
    if (!auditAppendInjected && customType === presetEntry) {
      auditAppendInjected = true;
      throw new Error("ENTRY_AUDIT_AFTER_APPEND_FAILURE");
    }
    return id;
  };
  await parent.prompt("/harness-preset entry-other");
  parent.sessionManager.appendCustomEntry = appendCustomEntry;
  const auditFailure = JSON.parse(notices.at(-1));
  assert.equal(auditFailure.code, "PRESET_AUDIT_FAILED");
  assert.match(auditFailure.resolution, /ambiguous outcome.*live worker preset was not published.*restart Pi/);
  assert.equal(selectedEntries().length, beforeAmbiguousAudit + 1,
    "SDK ambiguity may leave historical evidence even though live publication was withheld");
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture", "ambiguous audit failure preserves the old live router/footer");
  await parent.prompt("/harness-status");
  assert.match(JSON.parse(notices.at(-1)).parent_error, /ENTRY_AUDIT_AFTER_APPEND_FAILURE/);
  const blockedAuditCount = selectedEntries().length;
  await parent.prompt("/harness-preset entry-fixture");
  assert.equal(JSON.parse(notices.at(-1)).code, "OWNER_PARENT_UNAVAILABLE");
  assert.equal(selectedEntries().length, blockedAuditCount, "apparent SDK recovery cannot admit another preset audit");

  assert.equal(children.size, 3); assert(parent.extensionRunner.getCommand("harness-close"));
  const status = async () => {
    const before = notices.length;
    await parent.prompt("/harness-status");
    assert.equal(notices.length, before + 1);
    return JSON.parse(notices.at(-1));
  };
  const original = parent, oldService = permission.getPermissionsService(original.sessionId);
  assert(oldService);
  assert.equal((await runtimeHost.newSession()).cancelled, true, "open owner must veto replacement");
  await parent.prompt("/harness-close");
  assert.equal((await status()).closed, true);
  for (const id of children) assert.equal(permission.getPermissionsService(id), undefined);
  assert.equal(permission.getPermissionsService(original.sessionId), oldService, "close must retain parent authority until replacement");
  const priorReadyParents = [...new Set(readyParents)];
  assert.equal((await runtimeHost.newSession()).cancelled, false);
  assert.equal(parent, runtimeHost.session); assert.notEqual(parent, original);
  assert.notEqual(parent.sessionId, original.sessionId);
  assert.equal(permission.getPermissionsService(original.sessionId), undefined);
  const replacementService = permission.getPermissionsService(parent.sessionId);
  assert(replacementService); assert.notEqual(replacementService, oldService);
  // Readiness can be re-announced on queries; every distinct parent must pass.
  assert.deepEqual([...new Set(readyParents)], [...priorReadyParents, parent.sessionId]);
  const fresh = await status(); assert.equal(fresh.closed, false); assert.equal(fresh.resident, 0);
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture", "fresh session uses the configured default without the previous branch's selection or effort overrides");
  const replacementList = await invoke("agent_list", {});
  assert.deepEqual(replacementList.agents, []);
  await parent.prompt("/harness-preset entry-other");
  const replacementRun = await invoke("agent_spawn", { agent: "replacement", profile: "reader", reasoning_difficulty: 1,
    prompt: "Read source.txt", label: "Replacement entry smoke", max_turns: 4 });
  assert.equal((await finish(replacementRun)).result, "ENTRY_READ_OK");
  const replacement = { previous_session: original.sessionId, session: parent.sessionId, fresh, replacementList, run: replacementRun };
  assert.equal(children.size, 4);
  // Retain the original normal-shutdown coverage, now with a replacement child.
  const cleanup = await disposeChild(parent, parentBus);
  assert(cleanup.shutdownExited && !cleanup.errors.length);
  assert.equal(statuses.findLast((entry) => entry.key === "harness-preset")?.value, undefined,
    "session shutdown clears the worker-preset footer");
  for (const id of children) assert.equal(permission.getPermissionsService(id), undefined);
  assert.deepEqual(parentPresentOnDisposal, [true, true, true, true]); assert.deepEqual(errors, []);
  assert.equal(permission.getPermissionsService(parent.sessionId), undefined);

  // Retain the enabled-selection restoration positive control as well as Off:
  // the active branch wins, and current disk content replaces historical slots.
  const restoreManager = sdk.SessionManager.create(cwd, join(outputRoot, "entry-restore-sessions"));
  const restoreRoot = restoreManager.appendCustomEntry("fixture:branch-root", {});
  const restoreBranch = restoreManager.appendCustomEntry(presetEntry, { name: "entry-fixture", version: "historical-v0", digest: "0".repeat(64) });
  restoreManager.branch(restoreRoot);
  restoreManager.appendCustomEntry(presetEntry, { name: "entry-other", effort_overrides: { d5: "off" } });
  restoreManager.branch(restoreBranch);
  restoreManager.appendCustomEntry(presetEntry, { name: "entry-fixture", effort_overrides: { d3: "off" } });
  const restored = await createRuntime({ cwd, sessionManager: restoreManager, sessionStartEvent: { type: "session_start", reason: "startup" } });
  await bind(restored.session);
  assert.equal(presetStatus(), "delegation: co-worker/entry-fixture*");
  for (const name of delegationTools) assert(restored.session.getActiveToolNames().includes(name));
  assert.deepEqual(selectedEntries().at(-1).data.effort_overrides, { d3: "off" },
    "active SDK branch must not replay the abandoned preset's effort");
  const restoredSelection = { status: presetStatus(), saved_version: "historical-v0", active_tools: restored.session.getActiveToolNames() };
  const restoredCleanup = await disposeChild(restored.session, parentBus);
  assert(restoredCleanup.shutdownExited && !restoredCleanup.errors.length);
  assert.deepEqual(errors, []);

  // Exercise a failure AFTER owner/tool setup and approval-watch binding. Only
  // the harness is loaded here, so these two subscriptions have one owner.
  const faultBus = sdk.createEventBus(), approvalListeners = new Set(), originalOn = faultBus.on.bind(faultBus);
  faultBus.on = (name, listener) => {
    const off = originalOn(name, listener);
    if (["permissions:ui_prompt", "permissions:decision"].includes(name)) approvalListeners.add(listener);
    return () => { approvalListeners.delete(listener); off(); };
  };
  const faultLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, eventBus: faultBus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [entry] });
  await faultLoader.reload();
  assert.deepEqual(faultLoader.getExtensions().errors, []);
  const { session: failed } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings,
    resourceLoader: faultLoader, sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model });
  const faultErrors = [], faultNotices = [];
  let faultCleanup, faultReached = false, faultClearAttempts = 0;
  try {
    await failed.bindExtensions({ mode: "tui", uiContext: { ...ui,
      notify: (message) => faultNotices.push(message),
      setStatus(key, value) {
        if (key !== "harness-preset") return;
        if (value === undefined) { faultClearAttempts++; throw new Error("ENTRY_PRESET_STATUS_CLEAR_FAILURE"); }
        assert.equal(approvalListeners.size, 2, "fault must occur after both approval subscriptions");
        faultReached = true;
        throw new Error("ENTRY_PRESET_STATUS_FAILURE");
      },
    }, onError: (error) => faultErrors.push(error.error) });
    assert.equal(faultReached, true);
    assert.deepEqual(faultErrors, ["ENTRY_PRESET_STATUS_FAILURE"]);
    assert.equal(approvalListeners.size, 0, "startup failure must unbind before session shutdown");
    await failed.prompt("/harness-status");
    assert.equal(JSON.parse(faultNotices.at(-1)).closed, true);
    const auditBefore = failed.sessionManager.getEntries().length;
    await failed.prompt("/harness-preset fixture-strong");
    assert.equal(JSON.parse(faultNotices.at(-1)).code, "HARNESS_NOT_READY");
    assert.equal(failed.sessionManager.getEntries().length, auditBefore, "failed command cannot record selection");
    const blocked = await failed.extensionRunner.emitToolCall({ type: "tool_call", toolName: "agent_list",
      toolCallId: "failed-startup-list", input: {} });
    assert.equal(blocked.block, true);
    const reclaimed = await ExecutionOwner.open({ directory: join(agentDir, "harness-owners"),
      owner_id: failed.sessionId, flock: packaged.flock });
    reclaimed.close(); // Closed controller really released its owner lock.
  } finally {
    faultCleanup = await disposeChild(failed, faultBus);
    assert(faultCleanup.shutdownExited && !faultCleanup.errors.length);
  }
  assert(faultClearAttempts > 0, "shutdown attempts footer cleanup even after startup status failure");
  const startupFailure = { error: faultErrors[0], approval_listeners: approvalListeners.size,
    owner_reacquired: true, preset_command_blocked: true, footer_clear_attempts: faultClearAttempts, cleanup: faultCleanup };
  assert.deepEqual(networkAttempts, []);
  assert.deepEqual(Object.keys(childToolsByProfile).sort(), ["editor", "reader"]);
  const caller = provider.requests.find((call) => isParentCall(call) && !isWarm(call) &&
    call.context.tools.some((tool) => tool.name === "agent_spawn")).context;
  writeFileSync(join(outputRoot, "caller-interface.json"), JSON.stringify({ real_model: false, model_decisions: "scripted",
    systemPrompt: caller.systemPrompt,
    tools: caller.tools.filter((tool) => delegationTools.includes(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
    childToolsByProfile, emptyOwner, initialOff: { requests: offRequests, directRead: text(directRead), child_sessions: 0 },
    offRetainedResult: offResult }, null, 2));
  writeFileSync(join(outputRoot, "entry-smoke.json"), JSON.stringify({ checks: "passed", versions, entry, real_model: false,
    cases: ["portable launcher and historical component wiring (composition separately tested)", "actual SDK InteractiveMode handleResumeSession and showSessionSelector replace fresh unused Owners with fresh authority", "active-branch Off restores before the first real SDK request with zero harness prompt/schema content", "preset reconciliation restores a separately deactivated harness tool on the same request", "Off blocks cached new/reused delegation and messages per Agent while inspection stays available", "tool-visibility failure cannot roll back Off or bypass admission; next-request reconciliation repairs exposure", "reenabling another preset preserves resident Agent settings", "enabled active-branch selection restores current disk content rather than historical slots", "atomic preset typo/cancel/reload/removal/switch-away", "synchronous preset audit precedes live publication; ambiguous append latches owner", "successful selection survives footer paint failure with warning", "Alt+S packaged picker selection leaves parent model unchanged", "packaged effort editor audits live changes, retains them on close, restores across SDK branch replacement, remembers per-preset settings, explicitly inherits and resets defaults without changing resident Agent policy", "parent UI/web restored; child web excluded", "synthetic parent warming succeeds; child warming vetoed despite global idle mode", "readonly create/wait/read/result", "same-Agent reuse/wait", "worker write and resumed edit", "wait/reuse use managed allow rules without UI grants", "used Owner with a missing confirm UI remains closed to replacement", "release and normal shutdown before parent authority", "harness-close then actual SDK newSession with fresh authority/owner and successful delegation"],
    presetStatus: statuses.filter((entry) => entry.key === "harness-preset"), uiEvidence, cacheWarming, readyParents, startupFailure,
    restoredSelection, restoredCleanup, baselineCleanup, effortEditing,
    webTools, networkAttempts, human_ui: false, first, next, inherited, idle, edited, replacement, cleanup, parentPresentOnDisposal }, null, 2));
  console.log("PASS: packaged entry delegates read/write/edit, resumes, closes and replaces through the SDK with fresh working authority");
} catch (error) {
  heldResponse.resolve();
  // Best-effort rescue does not turn a failed smoke into cleanup evidence.
  if (parent?.isIdle) await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
  throw error;
} finally {
  restoreSettings();
}
