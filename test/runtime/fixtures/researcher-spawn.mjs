// Offline end-to-end Agents through the real composition: parent tools, child
// factory, researcher web instances, cooperative worker edits and permission
// forwarding to the parent UI. A scripted provider stands in for every model
// and the global fetch
// throws, so nothing leaves the process. No web tool is
// ever approved or executed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
writeFileSync(join(agentDir, "harness-presets.json"), JSON.stringify({ version: 3, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", slots: Object.fromEntries(["d1", "d2", "d3", "d4", "d5"].map((slot) => [slot, { model: fixtureModel }])) } } }));
initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert(model);

const cwd = join(home, "project"), sessions = join(home, "sessions"), outside = join(home, "outside", "fixture.pem");
mkdirSync(cwd, { recursive: true }); mkdirSync(sessions, { recursive: true }); mkdirSync(join(home, "outside"));
writeFileSync(outside, "OUTSIDE_NOTE_CONTENT (not a key)\n");
const workerReport = join(cwd, "worker-report.md"), approvedReport = join(cwd, "worker-approved-report.md");
const siblingReport = join(cwd, "sibling-approved-report.md"), deniedReport = join(cwd, "fixture-protected-report.md");
const secret = join(cwd, "fixture.env"), denyReason = "SYNTHETIC_WORKER_PATH_DENY";
writeFileSync(deniedReport, "PROTECTED_FIXTURE_REPORT\n");
writeFileSync(secret, "SYNTHETIC_SECRET_MUST_NOT_BE_READ\n");
// Only this disposable fixture's synthetic config gains path asks/deny. Keep
// every shipped rule, including the secret-path deny; ordinary worker writes
// remain usable while explicit user-style policy is enforced for both workers.
const syntheticPermissions = join(agentDir, "extensions/pi-permission-system/config.json");
const seeded = JSON.parse(readFileSync(syntheticPermissions, "utf8"));
assert.equal(seeded.permission.path["*.env"], "deny");
for (const path of [approvedReport, siblingReport]) seeded.permission.path_write[path] = "ask";
seeded.permission.path_write[deniedReport] = { action: "deny", reason: denyReason };
writeFileSync(syntheticPermissions, JSON.stringify(seeded, null, 2) + "\n");
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
  assert.equal(profile, ["RESEARCH_TASK", "SECOND_TASK"].includes(key) ? "researcher" : "editor",
    "public worker retains the internal editor profile");
  if (key === "WORKER_TASK" && request.context.messages.at(-1)?.role !== "toolResult") return { tools: [
    { type: "toolCall", id: "worker-report", name: "write", arguments: { path: workerReport, content: "WORKER_REPORT\n" } },
    { type: "toolCall", id: "approved-report", name: "write", arguments: { path: approvedReport, content: "APPROVED_WORKER_REPORT\n" } },
    { type: "toolCall", id: "protected-write", name: "write", arguments: { path: deniedReport, content: "FORBIDDEN\n" } },
    { type: "toolCall", id: "secret-read", name: "read", arguments: { path: secret } },
  ] };
  if (key === "WORKER_TASK" && !results(request).some((result) => result.toolCallId === "worker-edit")) return { tools: [
    { type: "toolCall", id: "worker-edit", name: "edit", arguments: { path: workerReport, oldText: "WORKER_REPORT", newText: "EDITED_WORKER_REPORT" } },
  ] };
  if (key === "SIBLING_TASK" && request.context.messages.at(-1)?.role !== "toolResult") return { tools: [
    { type: "toolCall", id: "sibling-protected", name: "write", arguments: { path: deniedReport, content: "SIBLING_FORBIDDEN\n" } },
    { type: "toolCall", id: "sibling-approved", name: "write", arguments: { path: siblingReport, content: "SIBLING_APPROVED_REPORT\n" } },
  ] };
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
// the local read of a *.pem path (an ask rule) is approved, and so is each
// fixture worker's approved report write (the synthetic path_write asks).
// Explicit configured denies and secret-path blocks never ask.
const dialogs = [], statuses = [];
const noop = () => {};
const uiContext = {
  select: async (title, options) => {
    dialogs.push(title);
    assert.equal(options[0], "Yes");
    assert(options.includes("No"));
    if (/tool\s*:\s*read\b/.test(title)) return "Yes";
    if (/subagent\s*:\s*worker\b/.test(title) && [approvedReport, siblingReport]
      .some((path) => title.includes(path))) return "Yes";
    return "No";
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
  // The idle Agent's real SDK context size rides on its completed row as a reuse-cost hint.
  const [{ context_tokens, ...row }] = reply.agents;
  assert(Number.isSafeInteger(context_tokens) && context_tokens >= 0, text(message));
  assert.equal(reply.agents.length, 1);
  assert.deepEqual(row, { agent, task: 1, status: "completed", result: `${profile}_DONE` });
  assert.equal(reply.alerts_pending, 0);
  assert.equal(reply.alerts, undefined);
  assert.equal(reply.workers_disabled, undefined);
};
const spawn = (agent, profile, key) => call(`spawn-${agent}`, "agent_spawn",
  { agent, prompt: `Do ${key} now.`, profile, reasoning_difficulty: 1, wait_ms: 60000 });
try {
  await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => errors.push(error.error) });
  assert.deepEqual(errors, []);
  assert(session.getActiveToolNames().includes("agent_spawn"), "an enabled preset exposes delegation");
  parentSteps.push(
    () => spawn("otter", "researcher", "RESEARCH_TASK"),
    (last) => { spawned(last, "otter", "RESEARCH_TASK"); return call("kill-otter", "agent_kill", { agent: "otter" }); },
    (last) => { assert.equal(last.isError, false, text(last)); return spawn("heron", "researcher", "SECOND_TASK"); },
    (last) => { spawned(last, "heron", "SECOND_TASK"); return spawn("pike", "worker", "WORKER_TASK"); },
    (last) => { spawned(last, "pike", "WORKER_TASK"); return spawn("perch", "worker", "SIBLING_TASK"); },
    (last) => { spawned(last, "perch", "SIBLING_TASK"); return { text: "PARENT_DONE" }; },
  );
  await session.prompt("START", { expandPromptTemplates: false });
  if (scriptFailure) throw scriptFailure;
  assert.deepEqual(parentSteps, [], "every scripted parent step ran");

  const web = ["web_search", "source_check", "fetch_content", "get_search_content"];
  const researcherTools = ["read", "grep", "find", "ls", ...web, "alert_parent", "ask_parent"];
  assert.deepEqual(childTools.RESEARCH_TASK, researcherTools);
  assert.deepEqual(childTools.SECOND_TASK, researcherTools, "a reused web instance serves the next researcher");
  for (const key of ["WORKER_TASK", "SIBLING_TASK"]) {
    assert(!childTools[key].some((tool) => web.includes(tool)), `${key} has no web tools`);
    for (const tool of ["bash", "read", "edit", "write", "alert_parent"]) assert(childTools[key].includes(tool), `${key}: ${tool}`);
  }
  for (const tool of ["bash", "edit", "write"]) assert(!childTools.RESEARCH_TASK.includes(tool), `researcher has no ${tool}`);
  for (const tools of Object.values(childTools)) {
    assert(tools.includes("ask_parent"));
    assert(!tools.includes("notify_parent"), "no retired runtime communication alias");
    assert(!tools.some((tool) => management.includes(tool)), "children cannot answer or delegate");
  }
  const worker = Object.fromEntries(childResults.WORKER_TASK.map(result => [result.id, result]));
  for (const id of ["worker-report", "worker-edit", "approved-report"]) assert.equal(worker[id].error, false, worker[id].text);
  assert.equal(readFileSync(workerReport, "utf8"), "EDITED_WORKER_REPORT\n", "ordinary worker write and edit reached the file");
  assert.equal(readFileSync(approvedReport, "utf8"), "APPROVED_WORKER_REPORT\n", "the approved path ask reached the file");
  assert.equal(worker["protected-write"].error, true);
  assert(worker["protected-write"].text.includes(denyReason), "the worker cannot bypass an explicit path-write deny");
  assert.equal(worker["secret-read"].error, true);
  assert.doesNotMatch(worker["secret-read"].text, /SYNTHETIC_SECRET_MUST_NOT_BE_READ/);
  const sibling = Object.fromEntries(childResults.SIBLING_TASK.map((result) => [result.id, result]));
  assert.equal(sibling["sibling-protected"].error, true);
  assert(sibling["sibling-protected"].text.includes(denyReason), "the configured deny also covers a sibling worker");
  assert.equal(sibling["sibling-approved"].error, false, sibling["sibling-approved"].text);
  assert.equal(readFileSync(siblingReport, "utf8"), "SIBLING_APPROVED_REPORT\n");
  assert.equal(readFileSync(deniedReport, "utf8"), "PROTECTED_FIXTURE_REPORT\n", "neither worker changed the denied target");

  const research = Object.fromEntries(childResults.RESEARCH_TASK.map((result) => [result.id, result]));
  assert.equal(research.search.error, true);
  assert.match(research.search.text, /The user denied this 'web_search' call for agent 'researcher'/);
  assert.match(research["local-video"].text, /Validation failed for tool "fetch_content"[\s\S]*must match pattern/);
  assert.match(research.proxy.text, /Validation failed for tool "fetch_content"[\s\S]*proxy/);
  assert.equal(research.outside.error, false, research.outside.text);
  assert.match(research.outside.text, /OUTSIDE_NOTE_CONTENT/);
  // Exactly four forwarded prompts: invalid calls and configured/secret denies
  // never reach the parent approval UI.
  assert.equal(dialogs.length, 4, dialogs.join("\n---\n"));
  for (const [tool, dialog] of [["web_search", dialogs.find((title) => /tool\s*:\s*web_search/.test(title))],
    ["read", dialogs.find((title) => /tool\s*:\s*read\b/.test(title))]]) {
    assert.match(dialog ?? "", /Permission Required \(Subagent\)[\s\S]*subagent\s*:\s*researcher/, tool);
  }
  assert.match(dialogs.find((title) => /web_search/.test(title)), /alehouse fixture/, "the parent sees the query it approves");
  for (const path of [approvedReport, siblingReport]) {
    const ask = dialogs.find((title) => title.includes(path));
    assert(ask, `the worker's forwarded ask names the actual ${path} artifact`);
    assert.match(ask, /Permission Required \(Subagent\)[\s\S]*subagent\s*:\s*worker\b/, "forwarded ask titles show the public worker label");
    assert.doesNotMatch(ask, /subagent\s*:\s*editor\b/, "internal profile IDs are not shown as requester labels");
    assert.match(ask, /tool\s*:\s*write\b/, "the forwarded write ask names the write tool");
  }
  assert.equal(dialogs.filter((title) => /tool\s*:\s*write\b/.test(title)).length, 2,
    "only the two approved fixture worker writes ask");
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
assert.equal(readFileSync(workerReport, "utf8"), "EDITED_WORKER_REPORT\n", "shutdown preserves ordinary worker output");
assert.equal(readFileSync(approvedReport, "utf8"), "APPROVED_WORKER_REPORT\n", "shutdown preserves the approved report");
assert.equal(readFileSync(siblingReport, "utf8"), "SIBLING_APPROVED_REPORT\n", "shutdown preserves the sibling's approved report");
assert.equal(readFileSync(deniedReport, "utf8"), "PROTECTED_FIXTURE_REPORT\n", "shutdown does not alter the denied target");
assert.deepEqual(network, []);
console.log("PASS: real composition spawns researcher and worker Agents; forwarded asks reach the parent UI; worker writes and edits stay permission-checked; explicit path-write and secret denies hold; a mode switch reaches the next request; nothing leaves the process");
