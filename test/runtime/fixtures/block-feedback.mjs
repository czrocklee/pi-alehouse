// Offline, real composition/child factory/managed authority regression. The
// only provider is scripted; the reader deliberately violates its scratch
// ceiling to exercise actual managed block===true returns, not error inference.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialize } from "../../../scripts/init.mjs";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { controlledProvider } from "../../../harness/test/support/host.mjs";

const home = process.env.HOME, agentDir = process.env.PI_CODING_AGENT_DIR;
assert(home && agentDir === join(home, "agent"), "use the disposable child-process wrapper");
assert.equal(process.env.PI_OFFLINE, "1");
const network = [];
globalThis.fetch = (url) => { network.push(String(url)); throw new Error("Unexpected network request in offline block-feedback fixture"); };
// Explicit absent-only initialization of this disposable fixture, using the
// verified, matched generated workers and authority; never installed user data.
initialize({ agentDir });
writeFileSync(join(agentDir, "harness-presets.json"), JSON.stringify({ version: 3, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", slots: Object.fromEntries(["d1", "d2", "d3", "d4", "d5"]
    .map((slot) => [slot, { model: "harness-fixture/controlled" }])) } } }));
initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert(model);
const cwd = join(home, "project"), sessions = join(home, "sessions");
mkdirSync(cwd); mkdirSync(sessions);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
const lifecycle = [], permissionPrompts = [];
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [join(packageRoot, "composition.ts")],
  extensionFactories: [(pi) => {
    for (const kind of ["session-created", "bound", "disposed"]) pi.events.on(`subagents:child:${kind}`, (event) => lifecycle.push({ kind, ...event }));
    pi.events.on("permissions:ui_prompt", (event) => permissionPrompts.push(event));
  }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);

const management = ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
  model, thinkingLevel: "off", settingsManager, sessionManager: SessionManager.create(cwd, sessions), tools: ["read", ...management] });
const text = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const summary = "Managed authority blocked 'write' on two distinct calls. Reasons and operation equivalence are unknown; coverage is partial. Parent: assess whether to steer this task or report the limit.";
const agent = "pike";
const tasks = [1, 2].map((task) => ({ task, key: `BLOCK_TASK_${task}`, step: 0, alerts: [],
  attempts: Array.from({ length: task === 1 ? 3 : 2 }, (_, index) => ({
    id: `opaque-denied-call-${task}-${index + 1}`,
    path: join(cwd, `private-project-target-${task}-${index + 1}.txt`),
    content: `PRIVATE_WRITE_PAYLOAD_${task}_${index + 1}\n`,
  })) }));
const allAttempts = tasks.flatMap((task) => task.attempts);
const childResults = new Map(), modelCalls = [], commands = [], observations = [], scratchDirectories = new Set();
let expectedCommand, parentPhase = "start", currentTask = 1, oldCursor, scriptFailure;
const emit = (name, args) => {
  assert(management.includes(name));
  const id = `parent-management-${commands.length + 1}`;
  expectedCommand = { id, name, args };
  commands.push(expectedCommand);
  return { tools: [{ type: "toolCall", id, name, arguments: args }] };
};
const writeCalls = (attempts) => ({ tools: attempts.map(({ id, path, content }) => ({
  type: "toolCall", id, name: "write", arguments: { path, content },
})) });
function observe(last, task, historical = false) {
  assert(expectedCommand, "no unsolicited parent model turn");
  assert.equal(last?.role, "toolResult");
  assert.equal(last.toolCallId, expectedCommand.id);
  assert.equal(last.toolName, expectedCommand.name);
  assert.equal(last.isError, false, text(last));
  const reply = JSON.parse(text(last));
  observations.push({ command: expectedCommand, reply });
  if (["agent_spawn", "agent_run"].includes(expectedCommand.name)) {
    assert.deepEqual(reply.action, { type: expectedCommand.name, agent, task });
  } else assert.equal(reply.action, undefined);
  assert.equal(reply.workers_disabled, undefined);
  assert(["alert", "done", "snapshot"].includes(reply.reason), text(last));
  assert.equal(reply.agents.length, 1);
  assert.equal(reply.agents[0].agent, agent);
  assert.equal(reply.agents[0].task, task);
  assert(["queued", "running", "finishing", "completed"].includes(reply.agents[0].status), text(last));
  for (const alert of reply.alerts ?? []) {
    assert(!historical, "a consumed old-Run summary must not reappear");
    assert.deepEqual(Object.keys(alert).sort(), ["agent", "label", "message", "source", "task"]);
    assert.equal(alert.source, "harness", "only trusted managed-block feedback carries harness provenance");
    assert.equal(alert.agent, agent);
    assert.equal(alert.task, task, "inline new-task feedback cannot contain the old task's alert");
    assert.equal(alert.label, tasks[task - 1].key);
    // Fixed generic text, not a denial class/reason or a paraphrase of inputs.
    assert.equal(alert.message, summary);
    assert.match(alert.message, /Reasons and operation equivalence are unknown; coverage is partial/);
    for (const secret of [cwd, agentDir, ...allAttempts.flatMap(({ id, path, content }) => [id, path, content.trim()]),
      "own scratch directory", "toolCallId", "path_write"]) assert(!alert.message.includes(secret), secret);
    tasks[task - 1].alerts.push(alert);
  }
  assert.equal(reply.alerts_pending, 0, "the accepted summary is consumed by ordinary publication");
  expectedCommand = undefined;
  return reply.agents[0];
}
function parentResponse(request) {
  const last = request.context.messages.at(-1);
  if (parentPhase === "start") {
    assert.equal(last?.role, "user");
    assert.equal(text(last), "START_BLOCK_FEEDBACK");
    parentPhase = "settle";
    return emit("agent_spawn", { agent, profile: "reader", reasoning_difficulty: 1,
      label: tasks[0].key, prompt: `Execute ${tasks[0].key} scripted denied-write probes.`, wait_ms: 60000 });
  }
  assert.notEqual(parentPhase, "done", "no extra parent provider call after scripted management flow");
  const row = observe(last, parentPhase === "old-read" ? 1 : currentTask, parentPhase === "old-read");
  if (parentPhase === "settle") {
    // A normal alert can wake the inline command before completion. Do not
    // assume spawn/run waited for the final child response, or assert timing.
    if (row.status !== "completed") return emit("agent_wait", { agents: [agent], wait_ms: 60000 });
    parentPhase = "read";
    return emit("agent_read", { agent, ...(currentTask === 1 ? { max_chars: 1 } : {}) });
  }
  assert.equal(row.status, "completed");
  if (parentPhase === "read") {
    assert.equal(tasks[currentTask - 1].alerts.length, 1, "exactly one summary per Run, including after the third denial");
    if (currentTask === 1) {
      const reply = observations.at(-1).reply;
      assert.equal(row.result, "B");
      oldCursor = row.next_cursor;
      assert.equal(typeof oldCursor, "string", JSON.stringify(reply));
      currentTask = 2;
      parentPhase = "settle";
      return emit("agent_run", { agent, builds_on: "Continue the same reader's first denied-write boundary check with fresh calls.",
        label: tasks[1].key, prompt: `Execute ${tasks[1].key} scripted denied-write probes.`, wait_ms: 60000 });
    }
    assert.equal(row.result, "BLOCK_TASK_2_DONE");
    parentPhase = "old-read";
    return emit("agent_read", { agent, cursor: oldCursor });
  }
  assert.equal(parentPhase, "old-read");
  assert.equal(row.result, "LOCK_TASK_1_DONE");
  assert.equal(observations.at(-1).reply.alerts, undefined, "old task stays drained after reader reuse");
  parentPhase = "done";
  return { text: "PARENT_BLOCK_FEEDBACK_DONE" };
}
function childResponse(request) {
  assert.match(request.context.systemPrompt, /<active_agent name="reader"\/>/);
  const user = request.context.messages.findLast((message) => message.role === "user" && /BLOCK_TASK_[12]/.test(text(message)));
  const key = /BLOCK_TASK_[12]/.exec(text(user))?.[0];
  const task = tasks.find((item) => item.key === key);
  assert(task, "unscripted child task");
  const scratch = /^Scratch directory: (\/tmp\/pi-alehouse-reader-[A-Za-z0-9]+)$/m.exec(request.context.systemPrompt)?.[1];
  assert(scratch, "real authority-created reader scratch appears in the child prompt");
  scratchDirectories.add(scratch);
  assert(request.context.tools.some((tool) => tool.name === "write"));
  assert(!request.context.tools.some((tool) => management.includes(tool.name)));
  assert(task.attempts.every(({ path }) => !path.startsWith(scratch + "/")));
  if (task.step++ === 0) return writeCalls(task.attempts.slice(0, 2));
  const results = request.context.messages.filter((message) => message.role === "toolResult" && task.attempts.some(({ id }) => id === message.toolCallId));
  assert.equal(results.length, task.step === 2 ? 2 : 3);
  for (const result of results) {
    assert.equal(result.toolName, "write");
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /own scratch directory/, "actual managed scratch handler, not validation or another guard");
    childResults.set(result.toolCallId, text(result));
  }
  if (task.task === 1 && task.step === 2) return writeCalls(task.attempts.slice(2));
  assert.equal(task.step, task.task === 1 ? 3 : 2, "no unscripted child provider call");
  return { text: `${task.key}_DONE` };
}
provider.respond(async (request) => {
  try {
    const profile = /<active_agent name="(\w+)"\/>/.exec(request.context.systemPrompt ?? "")?.[1];
    modelCalls.push({ profile: profile ?? "parent", lastRole: request.context.messages.at(-1)?.role });
    return profile ? childResponse(request) : parentResponse(request);
  } catch (error) { scriptFailure ??= error; throw error; }
});
const errors = [];
try {
  // Composition binds the actual parent/child permission services itself. Do
  // not install a second observation lease or synthesize managed-block facts.
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  assert.deepEqual(errors, []);
  assert(session.getActiveToolNames().includes("agent_spawn"));
  await session.prompt("START_BLOCK_FEEDBACK", { expandPromptTemplates: false });
  if (scriptFailure) throw scriptFailure;
  assert.equal(session.isIdle, true);
  assert.equal(parentPhase, "done");
  assert.equal(expectedCommand, undefined);
  assert.equal(childResults.size, 5, "all five distinct built-in write calls were blocked");
  assert.equal(scratchDirectories.size, 1, "follow-up task reuses the SAME reader SDK session and scratch");
  assert.deepEqual(tasks.map(({ alerts }) => alerts.length), [1, 1]);
  assert.deepEqual(tasks.map(({ step }) => step), [3, 2]);
  assert.equal(modelCalls.filter(({ profile }) => profile === "parent").length, commands.length + 1,
    "only scripted management replies cause parent calls; alerts do not start a model turn");
  assert.equal(modelCalls.filter(({ profile }) => profile === "reader").length, 5);
  assert.equal(provider.requests.length, modelCalls.length, "every model call was recorded and checked");
  assert.deepEqual(permissionPrompts, [], "scratch-floor blocks never ask a human or a reviewer");
  assert.deepEqual(errors, []);
  const links = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "harness:run-link:v1");
  assert.equal(links.length, 2);
  assert.notEqual(links[0].data.ref.run_id, links[1].data.ref.run_id, "task2 is a new Run");
  assert.equal(links[0].data.ref.session_id, links[1].data.ref.session_id, "same actual SDK child identity");
  const opaqueIds = links.flatMap(({ data: { ref } }) => [ref.owner_id, ref.generation, ref.agent_id, ref.run_id, ref.session_id]);
  for (const { alerts } of tasks) for (const alert of alerts) {
    for (const id of opaqueIds) assert(!alert.message.includes(id), "generic feedback contains no opaque lifecycle IDs");
    for (const reason of childResults.values()) assert(!alert.message.includes(reason), "no raw block reason");
  }
  assert.equal(lifecycle.filter(({ kind }) => kind === "session-created").length, 1);
  assert.equal(lifecycle.filter(({ kind }) => kind === "bound").length, 1);
  assert.equal(lifecycle.filter(({ kind }) => kind === "disposed").length, 0, "reader stays resident until shutdown");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
const created = lifecycle.filter(({ kind }) => kind === "session-created");
const disposed = lifecycle.filter(({ kind }) => kind === "disposed");
assert.equal(disposed.length, 1);
assert.equal(disposed[0].sessionId, created[0].sessionId);
assert.deepEqual(disposed[0].cleanup, { shutdownExited: true, disposed: true, resumable: false, errors: [] },
  "real SDK shutdown/idle/cleanup, not merely a cancellation request");
// Runtime revokes authority but intentionally preserves artifacts. Only after
// confirmed closure, remove this fixture's observed, authority-created scratch.
for (const scratch of scratchDirectories) rmSync(scratch, { recursive: true, force: true });
for (const { path } of allAttempts) assert(!existsSync(path), "blocked writes cannot reach project files");
assert.deepEqual(network, []);
console.log("PASS: real composition managed blocks produce exactly one harness-sourced alert per reader task; no writes, extra parent turns or network; child shutdown confirmed");
