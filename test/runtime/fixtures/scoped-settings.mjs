// Offline settings persistence through the real composition across parent
// sessions: the initial Session scope writes nothing, a confirmed global scope
// copies nothing, explicit choices stay pending until a quit shutdown flushes
// them, a scripted /harness-preset-edit creates a custom model preset from the
// physical fixture model without touching harness-presets.json, the approval
// preference stages the same way, fresh parents restore the saved mode, preset,
// definition and preference with the scope reset to session, a preset created
// in Session scope persists name AND definition only once a later global
// choice re-selects it, a resumed branch wins over the saved preference, and a
// malformed saved preference fails startup closed. A scripted provider answers
// every model request; the global fetch throws.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialize } from "../../../scripts/init.mjs";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { controlledProvider } from "../../../harness/test/support/host.mjs";
import { delegationGuideline } from "../../../harness/dist/delegation.js";
import { settingsStoreForSession } from "../../../lib/settings-store.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR, home = process.env.HOME;
assert(agentDir && home);
globalThis.fetch = () => { throw new Error("Unexpected network request in offline scoped-settings fixture"); };
initialize({ agentDir });
const fixtureModel = "harness-fixture/controlled";
const presetsPath = join(agentDir, "harness-presets.json");
const globalConfig = join(agentDir, "extensions/pi-alehouse/config.json");
const workspaceConfig = join(home, "project/.pi/extensions/pi-alehouse/config.json");
writeFileSync(presetsPath, JSON.stringify({ version: 2, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", models: { light: fixtureModel, standard: fixtureModel, strong: fixtureModel } } } }));
const catalogueBytes = readFileSync(presetsPath);
initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
const prompts = [];
provider.respond(async (request) => { prompts.push(request.context.systemPrompt); return { text: "OK" }; });
const cwd = join(home, "project"), sessions = join(home, "sessions");
mkdirSync(cwd, { recursive: true }); mkdirSync(sessions, { recursive: true });
const management = ["agent_spawn", "agent_run", "agent_send", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
const leadEager = delegationGuideline({ mode: "lead", eagerness: "eager" });
// The deferred approval restore publishes through its own microtask/timer
// chain; observe it with a bounded wait, never an unbounded sleep.
const waitFor = async (read, expected, what) => {
  for (let attempt = 0; attempt < 100 && read() !== expected; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(read(), expected, what);
};

// One real parent. Dialog answers come from scripted arrays; every scripted
// answer is verified against the options the real dialog offered, and closing
// asserts the whole script was consumed and no cleanup failed.
async function parent(sessionManager, script = {}) {
  script = { selects: script.selects ?? [], inputs: script.inputs ?? [], confirms: script.confirms ?? [] };
  const ui = { statuses: [], notices: [], selects: [], inputs: [], confirms: [] };
  const noop = () => {};
  const uiContext = {
    select: async (prompt, options) => {
      ui.selects.push({ prompt, options });
      const answer = script.selects.shift();
      if (answer !== undefined) assert(options.includes(answer),
        `scripted answer ${JSON.stringify(answer)} was not offered for ${JSON.stringify(prompt)}`);
      return answer;
    },
    input: async (prompt, placeholder) => { ui.inputs.push({ prompt, placeholder }); return script.inputs.shift(); },
    confirm: async (title, text) => { ui.confirms.push({ title, text }); return script.confirms.shift() ?? false; },
    editor: async () => undefined, custom: async () => undefined,
    notify: (message, type) => ui.notices.push({ message, type }), onTerminalInput: () => noop,
    setStatus: (key, value) => ui.statuses.push({ key, value }), setWorkingMessage: noop,
    setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop, setFooter: noop, setHeader: noop,
    setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "", addAutocompleteProvider: noop,
    setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false }), theme: { fg: (_color, text) => text, bold: (text) => text },
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, additionalExtensionPaths: [join(packageRoot, "composition.ts")] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model,
    thinkingLevel: "off", settingsManager, sessionManager, tools: ["read", ...management] });
  await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => ui.notices.push({ message: String(error.error), type: "error" }) });
  // Close collects problems instead of asserting, so a body failure is
  // never masked by the teardown checks that follow it.
  const close = async () => {
    const problems = [];
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    } catch (error) { problems.push(error); }
    if (script.selects.length || script.inputs.length || script.confirms.length)
      problems.push(new Error(`unconsumed scripted answers ${JSON.stringify({ selects: script.selects, inputs: script.inputs, confirms: script.confirms })}; notices: ${JSON.stringify(ui.notices)}; selects seen: ${JSON.stringify(ui.selects.map(({ prompt }) => prompt))}`));
    for (const { message } of ui.notices) if (/Harness cleanup is incomplete|Settings not saved/.test(message))
      problems.push(new Error(`unexpected notice: ${message}`));
    return problems;
  };
  return { session, ui, close,
    store: () => settingsStoreForSession(session.sessionManager.getSessionId()),
    status: (key) => [...ui.statuses].reverse().find((entry) => entry.key === key)?.value,
    ask: async (text) => { const before = prompts.length; await session.prompt(text, { expandPromptTemplates: false }); return prompts.slice(before); } };
}

// 1. A fresh parent is Session-scoped and creates no configuration file.
const first = await parent(SessionManager.create(cwd, sessions), {
  selects: ["Show paths and pending changes", "Change save scope", "global",
    fixtureModel, "inherit", fixtureModel, "inherit", fixtureModel, "inherit"],
  inputs: ["custom"], confirms: [true, true, true],
});
const problems = [];
let firstFile;
try {
  assert.equal(first.status("harness-preset"), "delegation: co-worker/fixture", "the file default seeds a fresh session");
  assert.equal(first.status("approval"), "approval: jev+sub", "the launch judge mode is enforce+subagents");
  assert(!existsSync(globalConfig) && !existsSync(workspaceConfig), "reading settings layers creates no files");
  await first.session.prompt("/harness-settings");
  const shown = JSON.parse(first.ui.notices.findLast(({ message }) => message.startsWith("{") && message.includes('"scope"')).message);
  assert.equal(shown.scope, "session"); assert.deepEqual(shown.pending, []);
  assert.equal(shown.paths.global, globalConfig);
  // A real model request persists the session file the later resume opens.
  await first.ask("PERSIST_THIS_SESSION");

  // 2. A confirmed global scope switch copies nothing.
  await first.session.prompt("/harness-settings");
  assert(first.ui.confirms.some(({ title, text }) => title === "Remember in global?" && /copies nothing/.test(text)),
    JSON.stringify(first.ui.confirms));
  assert(first.ui.notices.some(({ message }) => message === "Save: global · no pending writes"), JSON.stringify(first.ui.notices));
  assert(!existsSync(globalConfig), "switching scope alone writes nothing");

  // 3. A mode change stays pending; the config file appears only on flush.
  await first.session.prompt("/harness-mode lead eager");
  assert(first.ui.notices.some(({ message }) => message === "Delegation: lead·eager"), JSON.stringify(first.ui.notices));
  assert.deepEqual(first.store().pending(), [
    { scope: "global", path: ["delegation", "mode"], value: "lead" },
    { scope: "global", path: ["delegation", "eagerness"], value: "eager" },
  ]);
  assert(!existsSync(globalConfig), "explicit changes stay pending until exit");

  // 4-5. The approval preference stages the same way, live and remembered.
  await first.session.prompt("/approval manual");
  assert.equal(first.status("approval"), "approval: manual");
  await first.session.prompt("/approval save global");
  assert(first.ui.confirms.some(({ title }) => title === "Save manual as global approval default?"), JSON.stringify(first.ui.confirms));
  const pendingApproval = first.store().pending();
  assert(pendingApproval.some((patch) => patch.path.join(".") === "approval" && patch.value === "manual"));
  assert(!existsSync(globalConfig), "the remembered preference is still only pending");

  // 6. A scripted custom preset: three model and three effort selects, the
  //    physical fixture model only, and no harness-presets.json mutation.
  await first.session.prompt("/harness-preset-edit");
  assert(first.ui.selects.some(({ prompt, options }) => prompt.startsWith("custom: light model") && options.includes(fixtureModel)),
    JSON.stringify(first.ui.selects.map(({ prompt }) => prompt)));
  assert(first.ui.confirms.some(({ title }) => title === "Create and select custom?"), JSON.stringify(first.ui.confirms));
  assert(first.ui.notices.some(({ message }) => /^Model preset custom@user-\d+ selected; existing agents are unchanged\.$/.test(message)),
    JSON.stringify(first.ui.notices));
  assert.equal(first.status("harness-preset"), "delegation: lead·eager/custom");
  assert.deepEqual(readFileSync(presetsPath), catalogueBytes, "the base preset catalogue keeps its exact bytes");
  const firstPending = first.store().pending();
  assert(firstPending.some((patch) => patch.path.join(".") === "presets.custom" && patch.value.models.light === fixtureModel));
  assert(firstPending.some((patch) => patch.path.join(".") === "preset" && patch.value === "custom"));
  assert(!existsSync(globalConfig), "the created definition waits for the quit flush too");

  firstFile = first.session.sessionManager.getSessionFile();
  assert(firstFile);
} catch (error) { problems.push(error); }
problems.push(...await first.close());
assert.deepEqual(problems, [], "parent 1: session scope, confirmed global switch, pending choices, scripted custom preset");
assert(existsSync(globalConfig), "a quit shutdown flushes the pending document");
const flushed = JSON.parse(readFileSync(globalConfig, "utf8"));
assert.match(readFileSync(globalConfig, "utf8"), /\n$/, "the flush writes one terminating newline");
assert.match(flushed.presets.custom.version, /^user-\d+$/);
assert.deepEqual({ ...flushed, presets: { custom: { ...flushed.presets.custom, version: "user" } } }, {
  version: 1, preset: "custom", approval: "manual",
  delegation: { mode: "lead", eagerness: "eager" },
  presets: { custom: { version: "user", models: { light: fixtureModel, standard: fixtureModel, strong: fixtureModel },
    effort: { light: "inherit", standard: "inherit", strong: "inherit" } } },
});
assert(!existsSync(workspaceConfig), "nothing ever writes the workspace layer");
const firstFlushBytes = readFileSync(globalConfig);

// 7. A fresh parent restores the saved mode, preset, custom definition and
//    approval preference, and its save scope resets to session.
const second = await parent(SessionManager.create(cwd, sessions), { selects: ["Show paths and pending changes"] });
try {
  assert.equal(second.status("harness-preset"), "delegation: lead·eager/custom", "the saved mode and preset restore");
  await waitFor(() => second.status("approval"), "approval: manual", "the saved manual preference restores");
  assert((await second.ask("HELLO"))[0].includes(leadEager), "the restored mode reaches the first request");
  assert.equal(second.store().scope, "session", "a fresh session starts Session-scoped again");
  assert.equal(second.store().effective().preset, "custom");
  assert.equal(second.store().effective().presets.custom.models.strong, fixtureModel);
  await second.session.prompt("/harness-settings");
  const shown = JSON.parse(second.ui.notices.findLast(({ message }) => message.startsWith("{") && message.includes('"scope"')).message);
  assert.equal(shown.scope, "session"); assert.deepEqual(shown.pending, []);
  assert.deepEqual(readFileSync(presetsPath), catalogueBytes);
} catch (error) { problems.push(error); }
problems.push(...await second.close());
assert.deepEqual(problems, [], "parent 2: fresh restore with the scope reset to session");
assert.deepEqual(readFileSync(globalConfig), firstFlushBytes, "a session-scoped parent flushes nothing");

// 8. Regression: a preset created while Session-scoped stages nothing; after
//    the scope switches to global (again without copying), Off and a custom
//    re-selection stage BOTH the saved name and the session-born definition.
const third = await parent(SessionManager.create(cwd, sessions), {
  selects: [fixtureModel, "inherit", fixtureModel, "inherit", fixtureModel, "inherit",
    "Show paths and pending changes", "Change save scope", "global"],
  inputs: ["scoped"], confirms: [true, true],
});
try {
  assert.equal(third.status("harness-preset"), "delegation: lead·eager/custom");
  await third.session.prompt("/harness-preset-edit");
  assert(third.ui.notices.some(({ message }) => /^Model preset scoped@user-\d+ selected; existing agents are unchanged\.$/.test(message)),
    JSON.stringify(third.ui.notices));
  assert.equal(third.status("harness-preset"), "delegation: lead·eager/scoped");
  assert.deepEqual(third.store().pending(), [], "a Session-scoped create queues nothing");
  assert.deepEqual(readFileSync(globalConfig), firstFlushBytes, "no intermediate write touches the config");
  await third.session.prompt("/harness-settings");
  let shown = JSON.parse(third.ui.notices.findLast(({ message }) => message.startsWith("{") && message.includes('"scope"')).message);
  assert.equal(shown.scope, "session"); assert.deepEqual(shown.pending, []);
  await third.session.prompt("/harness-settings");
  assert(third.ui.notices.some(({ message }) => message === "Save: global · no pending writes"), JSON.stringify(third.ui.notices));

  await third.session.prompt("/harness-preset off");
  assert.equal(third.status("harness-preset"), "delegation: off");
  assert.deepEqual(third.store().pending(), [{ scope: "global", path: ["preset"], value: "off" }]);
  await third.session.prompt("/harness-preset scoped");
  const staged = third.store().pending();
  assert.equal(staged.length, 2, JSON.stringify(staged));
  assert.deepEqual(staged[0].path, ["presets", "scoped"]);
  assert.equal(staged[0].value.models.light, fixtureModel);
  assert.match(staged[0].value.version, /^user-\d+$/);
  assert.deepEqual(staged[1], { scope: "global", path: ["preset"], value: "scoped" });
  assert.equal(third.status("harness-preset"), "delegation: lead·eager/scoped");
} catch (error) { problems.push(error); }
problems.push(...await third.close());
assert.deepEqual(problems, [], "parent 3: session-scoped create, later global scope, off then custom re-selection");
const regressed = JSON.parse(readFileSync(globalConfig, "utf8"));
assert.equal(regressed.preset, "scoped");
assert.match(regressed.presets.scoped.version, /^user-\d+$/);
assert.equal(regressed.presets.custom.models.light, fixtureModel, "earlier saved definitions survive the merge");
assert.equal(regressed.approval, "manual");

// 9. The next fresh parent loads the session-born preset name and definition.
const fourth = await parent(SessionManager.create(cwd, sessions));
try {
  assert.equal(fourth.status("harness-preset"), "delegation: lead·eager/scoped", "the staged name and definition both persisted");
  assert.deepEqual(readFileSync(presetsPath), catalogueBytes);
} catch (error) { problems.push(error); }
problems.push(...await fourth.close());
assert.deepEqual(problems, [], "parent 4: fresh load of the session-born preset name and definition");
const savedConfigBytes = readFileSync(globalConfig);

// 10. A resumed branch wins over the saved global preference: parent 1's
//     branch last selected "custom" while the global default now says "scoped".
const fifth = await parent(SessionManager.open(firstFile));
try {
  assert.equal(fifth.status("harness-preset"), "delegation: lead·eager/custom",
    "the branch's recorded choice precedes the saved global default");
  assert((await fifth.ask("RESTORED"))[0].includes(leadEager));
} catch (error) { problems.push(error); }
problems.push(...await fifth.close());
assert.deepEqual(problems, [], "parent 5: resumed branch choice precedes the saved global preference");
assert.deepEqual(readFileSync(globalConfig), savedConfigBytes, "a resume flushes nothing new");

// 11. A malformed saved preference fails the next startup closed, without
//     touching the file or initializing any harness tool.
writeFileSync(globalConfig, '{"version":1,"preset":"not a valid name"}\n');
const sixth = await parent(SessionManager.create(cwd, sessions));
try {
  const failure = sixth.ui.notices.find(({ message }) => message.includes("SETTINGS_LOAD_FAILED"));
  assert(failure, JSON.stringify(sixth.ui.notices));
  const body = JSON.parse(failure.message);
  assert.equal(body.code, "SETTINGS_LOAD_FAILED");
  assert.deepEqual(body.config_paths, [globalConfig, workspaceConfig]);
  assert.equal(sixth.status("harness-preset"), undefined, "no routing published");
  assert(!sixth.session.getAllTools().some((tool) => tool.name === "agent_spawn"), "the harness did not initialize");
  const blocked = await sixth.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "scoped-settings-read",
    toolName: "read", input: { path: "fixture.txt" } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Harness initialization did not complete/);
  assert.equal(readFileSync(globalConfig, "utf8"), '{"version":1,"preset":"not a valid name"}\n', "startup repairs nothing");
} catch (error) { problems.push(error); }
problems.push(...await sixth.close());
assert.deepEqual(problems, [], "parent 6: malformed saved preference fails startup closed");

console.log("PASS: scoped settings save nothing until a confirmed global scope queues them, flush on quit, restore across fresh parents, branch precedence on resume, and fail closed on a malformed preference, offline");
