// Offline delegation mode through the real composition across parent restarts:
// restore from the branch, the preset file's default, a change while Off,
// recovery from failed re-registration and tool restoration, a corrupt saved
// record failing startup, and an audit failure. A scripted
// provider answers every request; the global fetch throws.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialize } from "../../../scripts/init.mjs";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { controlledProvider } from "../../../harness/test/support/host.mjs";
import { delegationGuideline } from "../../../harness/dist/delegation.js";

const agentDir = process.env.PI_CODING_AGENT_DIR, home = process.env.HOME;
assert(agentDir && home);
globalThis.fetch = () => { throw new Error("Unexpected network request in offline delegation fixture"); };
initialize({ agentDir });
const fixtureModel = "harness-fixture/controlled";
const writePresets = (extra = {}) => writeFileSync(join(agentDir, "harness-presets.json"), JSON.stringify({ version: 3, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", slots: Object.fromEntries(["d1", "d2", "d3", "d4", "d5"].map((slot) => [slot, { model: fixtureModel }])) } }, ...extra }));
writePresets({ defaultMode: "supervisor", defaultEagerness: "reserved" });
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
const entryType = "harness:delegation-mode:v1";

async function parent(sessionManager) {
  const ui = { statuses: [], notices: [] };
  const noop = () => {};
  const uiContext = {
    select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    custom: async () => undefined, notify: (message, type) => ui.notices.push({ message, type }), onTerminalInput: () => noop,
    setStatus: (key, value) => { if (key === "harness-preset") ui.statuses.push(value); }, setWorkingMessage: noop,
    setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop, setFooter: noop, setHeader: noop,
    setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "", addAutocompleteProvider: noop,
    setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false }),
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, additionalExtensionPaths: [join(packageRoot, "composition.ts")] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model,
    thinkingLevel: "off", settingsManager, sessionManager, tools: ["read", ...management] });
  await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => ui.notices.push({ message: String(error.error), type: "error" }) });
  const close = async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };
  return { session, ui, close, ask: async (text) => { const before = prompts.length; await session.prompt(text, { expandPromptTemplates: false }); return prompts.slice(before); } };
}
const saved = (session) => session.sessionManager.getBranch()
  .filter((entry) => entry.type === "custom" && entry.customType === entryType).map(({ data }) => `${data.mode}/${data.eagerness}`);
const supervisorReserved = delegationGuideline({ mode: "supervisor", eagerness: "reserved" });
const leadEager = delegationGuideline({ mode: "lead", eagerness: "eager" });

// 1. A fresh session starts from the file's defaultMode/defaultEagerness.
let first = await parent(SessionManager.create(cwd, sessions));
let file;
try {
  assert.equal(first.ui.statuses.at(-1), "delegation: supervisor·reserved/fixture");
  assert((await first.ask("HELLO"))[0].includes(supervisorReserved), "the configured default reaches the first request");
  // 2. While Off the mode changes and is audited, but the footer stays off and
  // agent_spawn stays hidden; enabling again shows the new mode.
  await first.session.prompt("/harness-preset off");
  assert.equal(first.ui.statuses.at(-1), "delegation: off");
  await first.session.prompt("/harness-mode lead eager");
  assert.equal(first.ui.statuses.at(-1), "delegation: off");
  assert(!first.session.getActiveToolNames().includes("agent_spawn"), "a mode change never re-exposes delegation while Off");
  assert.deepEqual(saved(first.session), ["lead/eager"]);
  await first.session.prompt("/harness-preset fixture");
  assert.equal(first.ui.statuses.at(-1), "delegation: lead·eager/fixture");
  const enabled = await first.ask("AFTER_ENABLE");
  assert(enabled[0].includes(leadEager) && !enabled[0].includes(supervisorReserved));
  await first.session.prompt("/harness-mode lead eager");
  assert.match(first.ui.notices.at(-1).message, /Delegation: lead·eager \(unchanged\)/);
  assert.deepEqual(saved(first.session), ["lead/eager"], "an unchanged selection writes no record");
  file = first.session.sessionManager.getSessionFile();
  assert(file);
} finally { await first.close(); }

// 3. Restoring the session restores the saved mode, not the file default.
let second = await parent(SessionManager.open(file));
try {
  assert.equal(second.ui.statuses.at(-1), "delegation: lead·eager/fixture");
  const restored = await second.ask("RESTORED");
  assert(restored[0].includes(leadEager) && !restored[0].includes(supervisorReserved), "the restored mode reaches the first request");
  // 4a. A failed active-tool restore is retried on reselect. With the tool
  // allowlist, re-registration activates every allowed tool.
  const { session } = second;
  await session.prompt("/harness-preset off");
  session.setActiveToolsByName([]);
  const setActive = session.setActiveToolsByName;
  let restoreFailures = 1;
  session.setActiveToolsByName = function (names) {
    if (names.length === 0 && restoreFailures-- > 0) throw new Error("fixture restore failure");
    return setActive.call(this, names);
  };
  let before = second.ui.notices.length;
  await session.prompt("/harness-mode co-worker reserved");
  assert(second.ui.notices.slice(before).some(({ message }) => /fixture restore failure/.test(message)), JSON.stringify(second.ui.notices.slice(before)));
  assert.notDeepEqual(session.getActiveToolNames(), [], "the failure left the allowlist active");
  await session.prompt("/harness-mode co-worker reserved");
  assert.deepEqual(session.getActiveToolNames(), [], "reselecting restores the prior active set");
  session.setActiveToolsByName = setActive;
  session.setActiveToolsByName(["read"]);
  await session.prompt("/harness-preset fixture");
  // 4b. A registration failure is retried before the next run, and that run's
  // prompt carries only the new line.
  const refresh = session._refreshToolRegistry;
  let refreshFailures = 1;
  session._refreshToolRegistry = function (...args) {
    if (refreshFailures-- > 0) throw new Error("fixture registration failure");
    return refresh.apply(this, args);
  };
  before = second.ui.notices.length;
  await session.prompt("/harness-mode lead eager");
  assert(second.ui.notices.slice(before).some(({ message }) => /fixture registration failure/.test(message)), JSON.stringify(second.ui.notices.slice(before)));
  const coWorkerReserved = delegationGuideline({ mode: "co-worker", eagerness: "reserved" });
  const recovered = await second.ask("RECOVERED");
  assert.equal(recovered.length, 1);
  assert(recovered[0].includes(leadEager), "the recovered line reaches this run");
  assert(!recovered[0].includes(coWorkerReserved), "the stale line is gone from this run");
  session._refreshToolRegistry = refresh;
  // 4. An ambiguous audit failure changes nothing and latches the Owner.
  const append = second.session.sessionManager.appendCustomEntry;
  second.session.sessionManager.appendCustomEntry = (type, ...rest) => {
    if (type === entryType) throw new Error("fixture audit failure");
    return append.call(second.session.sessionManager, type, ...rest);
  };
  await second.session.prompt("/harness-mode manual");
  assert.match(second.ui.notices.at(-1).message, /DELEGATION_AUDIT_FAILED/);
  assert.equal(second.ui.statuses.at(-1), "delegation: lead·eager/fixture");
  second.session.sessionManager.appendCustomEntry = append;
  await second.session.prompt("/harness-mode manual");
  assert.match(second.ui.notices.at(-1).message, /PARENT_HISTORY|OWNER|unavailable/i, "the latched Owner refuses later changes");
  assert((await second.ask("AFTER_FAILURE"))[0].includes(leadEager), "the live guideline is unchanged");
  // 5. A corrupt saved record fails the next startup with its own error.
  append.call(second.session.sessionManager, entryType, { mode: "boss", eagerness: "eager" });
} finally { await second.close(); }

const third = await parent(SessionManager.open(file));
try {
  const failure = third.ui.notices.find(({ message }) => message.includes("INVALID_SAVED_DELEGATION"));
  assert(failure, JSON.stringify(third.ui.notices));
  assert.match(failure.message, /harness:delegation-mode:v1/);
  assert.doesNotMatch(failure.message, /harness-presets\.json/, "the error points at the session record, not the preset file");
  assert(!third.session.getAllTools().some((tool) => tool.name === "agent_spawn"), "the harness did not initialize");
} finally { await third.close(); }
console.log("PASS: delegation mode defaults, changes while Off, restores, fails closed on a bad record and on audit failure, offline");
