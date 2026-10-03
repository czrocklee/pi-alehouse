// Offline end-to-end Agents through the real composition: parent tools, child
// factory, researcher web instances and permission forwarding to the parent UI.
// A scripted provider stands in for every model and the global fetch throws, so
// nothing leaves the process. No web tool is ever approved or executed.
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
const network = [];
globalThis.fetch = (url) => { network.push(String(url)); throw new Error("Unexpected network request in offline Agent fixture"); };
initialize({ agentDir });
const fixtureModel = "harness-fixture/controlled";
writeFileSync(join(agentDir, "harness-presets.json"), JSON.stringify({ version: 2, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", models: { light: fixtureModel, standard: fixtureModel, strong: fixtureModel } } } }));
initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert(model);

const cwd = join(home, "project"), sessions = join(home, "sessions"), outside = join(home, "outside", "fixture.pem");
mkdirSync(cwd, { recursive: true }); mkdirSync(sessions, { recursive: true }); mkdirSync(join(home, "outside"));
writeFileSync(outside, "OUTSIDE_NOTE_CONTENT (not a key)\n");
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
const lifecycle = [];
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [join(packageRoot, "composition.ts")],
  extensionFactories: [(pi) => {
    for (const kind of ["session-created", "disposed"]) pi.events.on(`subagents:child:${kind}`, (event) => lifecycle.push({ kind, ...event }));
  }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);

// Parent requests carry no active_agent marker; children are told apart by
// their profile and the task text of their first user message.
const text = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const profileOf = (request) => /<active_agent name="(\w+)"\/>/.exec(request.context.systemPrompt ?? "")?.[1];
const results = (request) => request.context.messages.filter((message) => message.role === "toolResult");
const parentSteps = [], parentPrompts = [], childTools = {}, childResults = {};
const call = (id, name, args) => ({ tools: [{ type: "toolCall", id, name, arguments: args }] });
// A failed step only ends the provider response; keep it for the real report.
let scriptFailure;
provider.respond(async (request) => { try { return respond(request); } catch (error) { scriptFailure ??= error; throw error; } });
function respond(request) {
  const profile = profileOf(request);
  if (!profile) {
    parentPrompts.push(request.context.systemPrompt);
    const step = parentSteps.shift();
    assert(step, "unscripted parent request");
    return step(request.context.messages.at(-1));
  }
  const task = text(request.context.messages.find((message) => message.role === "user"));
  const key = /\b([A-Z]+_TASK)\b/.exec(task)?.[1];
  assert(key, `unscripted ${profile} task`);
  childTools[key] ??= request.context.tools.map((tool) => tool.name);
  if (key === "RESEARCH_TASK" && request.context.messages.at(-1)?.role !== "toolResult") return { tools: [
    { type: "toolCall", id: "search", name: "web_search", arguments: { query: "alehouse fixture" } },
    { type: "toolCall", id: "local-video", name: "fetch_content", arguments: { url: "file:///etc/passwd" } },
    { type: "toolCall", id: "proxy", name: "fetch_content", arguments: { url: "https://example.com", proxy: "http://127.0.0.1:9" } },
    { type: "toolCall", id: "outside", name: "read", arguments: { path: outside } },
  ] };
  childResults[key] = results(request).map((message) => ({ id: message.toolCallId, error: message.isError, text: text(message) }));
  return { text: `${key}_DONE` };
}

// The parent UI answers forwarded permission requests: web_search is denied,
// the local read of a *.pem path (an ask rule) is approved.
const dialogs = [], statuses = [];
const noop = () => {};
const uiContext = {
  select: async (title, options) => {
    dialogs.push(title);
    assert.equal(options[0], "Yes");
    assert(options.includes("No"));
    return /tool\s*:\s*read\b/.test(title) ? "Yes" : "No";
  },
  confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
  notify: noop, onTerminalInput: () => noop, setStatus: (key, value) => { if (key === "harness-preset") statuses.push(value); }, setWorkingMessage: noop, setWorkingVisible: noop,
  setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop,
  pasteToEditor: noop, setEditorText: noop, getEditorText: () => "", addAutocompleteProvider: noop, setEditorComponent: noop,
  getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false }),
};

const management = ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
  model, thinkingLevel: "off", settingsManager, sessionManager: SessionManager.create(cwd, sessions), tools: ["read", ...management] });
const errors = [];
const spawned = (message, agent, profile) => {
  assert.equal(message?.toolName, management[0]);
  assert.equal(message.isError, false, text(message));
  const reply = JSON.parse(text(message));
  assert.equal(reply.reason, "done");
  assert.deepEqual(reply.action, { type: "agent_spawn", agent, task: 1 });
  assert.deepEqual(reply.agents, [{ agent, task: 1, status: "completed", result: `${profile}_DONE` }]);
  assert.equal(reply.alerts_pending, 0);
  assert.equal(reply.alerts, undefined);
  assert.equal(reply.workers_disabled, undefined);
};
const spawn = (agent, profile, key) => call(`spawn-${agent}`, "agent_spawn",
  { agent, prompt: `Do ${key} now.`, profile, difficulty: 1, wait_ms: 60000 });
try {
  await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => errors.push(error.error) });
  assert.deepEqual(errors, []);
  assert(session.getActiveToolNames().includes("agent_spawn"), "an enabled preset exposes delegation");
  parentSteps.push(
    () => spawn("otter", "researcher", "RESEARCH_TASK"),
    (last) => { spawned(last, "otter", "RESEARCH_TASK"); return call("kill-otter", "agent_kill", { agent: "otter" }); },
    (last) => { assert.equal(last.isError, false, text(last)); return spawn("heron", "researcher", "SECOND_TASK"); },
    (last) => { spawned(last, "heron", "SECOND_TASK"); return spawn("pike", "reader", "READER_TASK"); },
    (last) => { spawned(last, "pike", "READER_TASK"); return spawn("carp", "editor", "EDITOR_TASK"); },
    (last) => { spawned(last, "carp", "EDITOR_TASK"); return { text: "PARENT_DONE" }; },
  );
  await session.prompt("START", { expandPromptTemplates: false });
  if (scriptFailure) throw scriptFailure;
  assert.deepEqual(parentSteps, [], "every scripted parent step ran");

  const web = ["web_search", "source_check", "fetch_content", "get_search_content"];
  const researcherTools = ["read", "grep", "find", "ls", ...web, "alert_parent", "ask_parent"];
  assert.deepEqual(childTools.RESEARCH_TASK, researcherTools);
  assert.deepEqual(childTools.SECOND_TASK, researcherTools, "a reused web instance serves the next researcher");
  for (const key of ["READER_TASK", "EDITOR_TASK"]) {
    assert(!childTools[key].some((tool) => web.includes(tool)), `${key} has no web tools`);
    assert(childTools[key].includes("bash") && childTools[key].includes("alert_parent"), key);
  }
  for (const tools of Object.values(childTools)) {
    assert(tools.includes("ask_parent"));
    assert(!tools.includes("notify_parent"), "no retired runtime communication alias");
    assert(!tools.some((tool) => management.includes(tool)), "children cannot answer or delegate");
  }
  assert(childTools.EDITOR_TASK.includes("edit") && !childTools.READER_TASK.includes("edit"));

  const research = Object.fromEntries(childResults.RESEARCH_TASK.map((result) => [result.id, result]));
  assert.equal(research.search.error, true);
  assert.match(research.search.text, /The user denied this 'web_search' call for agent 'researcher'/);
  assert.match(research["local-video"].text, /Validation failed for tool "fetch_content"[\s\S]*must match pattern/);
  assert.match(research.proxy.text, /Validation failed for tool "fetch_content"[\s\S]*proxy/);
  assert.equal(research.outside.error, false, research.outside.text);
  assert.match(research.outside.text, /OUTSIDE_NOTE_CONTENT/);
  // Exactly two forwarded prompts: invalid calls never reach permission.
  assert.equal(dialogs.length, 2, dialogs.join("\n---\n"));
  for (const [tool, dialog] of [["web_search", dialogs.find((title) => /tool\s*:\s*web_search/.test(title))],
    ["read", dialogs.find((title) => /tool\s*:\s*read\b/.test(title))]]) {
    assert.match(dialog ?? "", /Permission Required \(Subagent\)[\s\S]*subagent\s*:\s*researcher/, tool);
  }
  assert.match(dialogs.find((title) => /web_search/.test(title)), /alehouse fixture/, "the parent sees the query it approves");
  assert.equal(lifecycle.filter((event) => event.kind === "disposed").length, 1, "only the killed researcher is disposed so far");

  // Delegation mode: the default guideline, then a command switch that takes
  // effect in the next request, with an audit entry and footer status.
  const coWorker = delegationGuideline({ mode: "co-worker", eagerness: "balanced" });
  const lead = delegationGuideline({ mode: "lead", eagerness: "eager" });
  // Pi renders tool guidelines in both its rules and Guidelines sections.
  assert(parentPrompts.every((prompt) => prompt.includes(coWorker)), "the default guideline is in every parent request");
  assert.equal(statuses.at(-1), "delegation: co-worker/fixture");
  await session.prompt("/harness-mode lead eager");
  assert.equal(statuses.at(-1), "delegation: lead·eager/fixture");
  const saved = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "harness:delegation-mode:v1");
  assert.deepEqual(saved.map(({ data: { mode, eagerness } }) => ({ mode, eagerness })), [{ mode: "lead", eagerness: "eager" }]);
  const before = parentPrompts.length;
  parentSteps.push(() => ({ text: "LEAD_DONE" }));
  await session.prompt("AFTER_SWITCH", { expandPromptTemplates: false });
  const switched = parentPrompts.slice(before);
  assert.equal(switched.length, 1);
  assert.equal(switched[0].split(lead).length, parentPrompts[0].split(coWorker).length, "the next request carries the new guideline in its place");
  assert(!switched[0].includes(coWorker), "and not the old one");
  assert(session.getActiveToolNames().includes("agent_spawn"), "a mode change keeps delegation exposed");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
const created = lifecycle.filter((event) => event.kind === "session-created").map((event) => event.sessionId);
const disposed = lifecycle.filter((event) => event.kind === "disposed").map((event) => event.sessionId);
assert.equal(created.length, 4);
assert.deepEqual([...disposed].sort(), [...created].sort(), "parent shutdown disposes every Agent session");
assert.deepEqual(network, []);
console.log("PASS: real composition spawns researcher, reader and editor Agents; forwarded asks reach the parent UI; a mode switch reaches the next request; nothing leaves the process");
