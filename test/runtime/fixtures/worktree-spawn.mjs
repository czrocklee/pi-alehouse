// Dedicated offline process: real composition, generated authority, child factory,
// DefaultResourceLoader and SDK builtins. Only the model transport is synthetic.
// Product retention is checked before the wrapper may discard this fixture's files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import tls from "node:tls";
import * as ai from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveGit } from "../../../bin/runtime-support.mjs";
import { controlledProvider } from "../../../harness/test/support/host.mjs";
import { initialize } from "../../../scripts/init.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR, home = process.env.HOME;
const temporaryRoot = process.env.TMPDIR, closedMarker = process.env.WORKTREE_FIXTURE_CLOSED;
const stateRoot = process.env.XDG_STATE_HOME;
assert(agentDir && home && temporaryRoot && closedMarker && stateRoot);
for (const path of [agentDir, home, temporaryRoot, closedMarker, stateRoot]) assert(isAbsolute(path));
assert.equal(process.platform, "linux", "worktree runtime currently supports Linux only");
assert.equal(realpathSync(temporaryRoot), temporaryRoot);
const git = resolveGit();
assert(git && isAbsolute(git), "verified absolute Git is required");
assert.equal(git, process.env.PI_HARNESS_GIT, "wrapper must supply resolver-verified Git, not PATH");

// Keep these stubs installed for the process lifetime, including late callbacks.
const network = [];
const blocked = (name) => () => { network.push(name); throw new Error(`UNEXPECTED_NETWORK: ${name}`); };
globalThis.fetch = blocked("fetch");
for (const [name, module] of [["http", http], ["https", https]]) {
  for (const method of ["request", "get"]) module[method] = blocked(`${name}.${method}`);
}
net.Socket.prototype.connect = blocked("socket.connect");
tls.connect = blocked("tls.connect");
syncBuiltinESMExports();

initialize({ agentDir });
const fixtureModel = "harness-fixture/controlled";
writeFileSync(join(agentDir, "harness-presets.json"), JSON.stringify({ version: 3, defaultPreset: "fixture",
  presets: { fixture: { version: "v1", slots: Object.fromEntries(["d1", "d2", "d3", "d4", "d5"].map((slot) => [slot, { model: fixtureModel }])) } } }));
const cwd = join(home, "project"), sessions = join(home, "sessions");
mkdirSync(cwd); mkdirSync(sessions);
// Authored disposable repository only. Never invoke Git against packageRoot.
const gitEnv = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), PATH: "/dev/null", LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0",
  GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1",
  GIT_TRACE: "0", GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0",
  GIT_AUTHOR_NAME: "Offline Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Offline Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z" };
const runGit = (...args) => execFileSync(git, ["--no-pager", "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
  "-c", "protocol.allow=never", "-c", "gc.auto=0", ...args],
{ cwd, env: gitEnv, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
runGit("init", "--initial-branch=fixture", "--template=");
assert.equal(runGit("remote"), "", "fixture has no remotes");
const ordinary = join(cwd, "ordinary.txt"), secret = join(cwd, "private-note.txt");
const untracked = join(cwd, "source-untracked.txt"), outputName = "child-created.txt";
const projectConfig = join(cwd, ".pi/extensions/pi-permission-system/config.json");
const instructions = join(cwd, "AGENTS.md");
const permissiveConfig = JSON.stringify({ permission: { read: "allow", path: { "*": "allow" } } }) + "\n";
mkdirSync(dirname(projectConfig), { recursive: true });
writeFileSync(ordinary, "COMMITTED_BASELINE\n");
writeFileSync(secret, "SYNTHETIC_PRIVATE_NOTE_MUST_NOT_REACH_MODEL\n");
writeFileSync(instructions, "CHECKED_OUT_INSTRUCTION_NOT_SOURCE_AUTHORITY\n");
writeFileSync(projectConfig, permissiveConfig);
// Both real worktrees inherit this committed symlink, but its target is owned
// by this fixture outside either checkout. Never infer worktree state layout.
const sharedOutput = join(home, "shared-output"); mkdirSync(sharedOutput);
symlinkSync(sharedOutput, join(cwd, "shared-build"));
runGit("add", "--", "ordinary.txt", "private-note.txt", "AGENTS.md", ".pi", "shared-build");
runGit("commit", "--no-gpg-sign", "-m", "offline fixture baseline");
const baseCommit = runGit("rev-parse", "HEAD").trim();
assert.match(baseCommit, /^[0-9a-f]{40,64}$/);
writeFileSync(ordinary, "DIRTY_SOURCE_ONLY\n");
writeFileSync(untracked, "UNTRACKED_SOURCE_ONLY\n");
writeFileSync(instructions, "SOURCE_ONLY_TRUSTED_INSTRUCTION\n");
const denyReason = "SYNTHETIC_SOURCE_ABSOLUTE_PATH_DENY";
// Only the live source project has this exact absolute restriction. The committed
// .pi config instead allows reads; neither a copied config nor wildcard secret
// policy could explain the expected denial at the corresponding worktree path.
writeFileSync(projectConfig, JSON.stringify({ permission: { path: { [secret]: { action: "deny", reason: denyReason } } } }) + "\n");
const sourceFiles = new Map([ordinary, secret, untracked, instructions, projectConfig].map((path) => [path, readFileSync(path)]));
const sourceStatus = runGit("status", "--porcelain=v1", "--untracked-files=all");
const sourceIndex = readFileSync(join(cwd, ".git/index"));
assert.match(sourceStatus, /ordinary\.txt/); assert.match(sourceStatus, /source-untracked\.txt/);

initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
assert(model);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }, { projectTrusted: true });
assert.equal(settingsManager.isProjectTrusted(), true);
const lifecycle = [], notifications = [], dialogs = [], errors = [];
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [join(packageRoot, "composition.ts")],
  extensionFactories: [(pi) => {
    for (const kind of ["session-created", "bound", "disposed"]) pi.events.on(`subagents:child:${kind}`, (event) => lifecycle.push({ kind, ...event }));
  }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const text = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const call = (id, name, args) => ({ tools: [{ type: "toolCall", id, name, arguments: args }] });
const parse = (message, tool) => {
  assert.equal(message?.toolName, tool);
  assert.equal(message.isError, false, text(message));
  return JSON.parse(text(message));
};
const result = (message, id, denied = false) => {
  assert.equal(message?.role, "toolResult"); assert.equal(message.toolCallId, id);
  assert.equal(message.isError, denied, text(message));
  return text(message);
};
const management = ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
let workspace, manifest, scriptFailure, waits = 0;
let holderWorkspace, contenderWorkspace, contenderSessionId;
let holderCalls = 0, contenderCalls = 0;
const holderLabel = "CONFLICT_HOLDER_TASK: ask whether to continue, then finish; do not edit.";
const contenderLabel = "CONFLICT_CONTENDER_TASK: this input must never reach the child.";
const safeLabel = "CONFLICT_SAFE_TASK: report SAFE_DONE without tools or edits.";
const firstDone = "FIRST_DONE: expected configured read denied; no retry.", secondDone = "SECOND_DONE";
const firstLabel = "BASELINE_TASK: read ordinary, write a worktree file, report the expected denied read without retrying.";
const secondLabel = "FOLLOWUP_TASK: read your prior worktree output.";
const firstDispatch = { inputs: ["ordinary.txt"], ownership: [outputName], tree: "build", checks: ["controlled worktree read/write"] };
const nextDispatch = { inputs: [outputName], tree: "build" };
const treeLeasePath = (base) => join(agentDir, "harness-trees", createHash("sha256").update(join(base, "build")).digest("hex"), "owner.lock");
const dispatchDeclaration = (message) => {
  const matches = [...text(message).matchAll(/\n(\{[^\n]+\})\n--- End of dispatch declarations ---/g)];
  assert.equal(matches.length, 1, "the current task has exactly one dispatch declaration body");
  return JSON.parse(matches[0][1]);
};
const workspaceSummary = () => ({ ...workspace, checkout_root: workspace.cwd });
const childSteps = [
  (last) => {
    assert.equal(last.role, "user");
    assert.match(text(last), /Relative inputs, ownership, and tree paths resolve from this execution cwd/);
    assert(text(last).includes(`Execution cwd: ${JSON.stringify(workspace.cwd)}\n`));
    assert(text(last).includes(`source cwd (${JSON.stringify(cwd)})`));
    assert.deepEqual(dispatchDeclaration(last), firstDispatch, "first spawn carries all relative dispatch declarations without initialization calls");
    assert(existsSync(treeLeasePath(realpathSync(workspace.cwd))), "tree observation uses the bound worktree canonical path before child input");
    assert.equal(existsSync(treeLeasePath(realpathSync(cwd))), false, "no source-tree lease is fabricated");
    return call("baseline-read", "read", { path: "ordinary.txt" });
  },
  (last) => {
    assert.match(result(last, "baseline-read"), /COMMITTED_BASELINE/);
    assert.doesNotMatch(text(last), /DIRTY_SOURCE_ONLY/);
    return call("worktree-write", "write", { path: outputName, content: "WORKTREE_ONLY_OUTPUT\n" });
  },
  (last) => { result(last, "worktree-write"); return call("source-denied-read", "read", { path: "private-note.txt" }); },
  (last) => {
    assert.match(result(last, "source-denied-read", true), new RegExp(denyReason));
    assert.doesNotMatch(text(last), /SYNTHETIC_PRIVATE_NOTE_MUST_NOT_REACH_MODEL/);
    return { text: firstDone };
  },
  (last) => {
    assert.equal(last.role, "user"); assert.match(text(last), /FOLLOWUP_TASK/);
    assert(text(last).includes(`Execution cwd: ${JSON.stringify(workspace.cwd)}\n`));
    assert.deepEqual(dispatchDeclaration(last), nextDispatch, "follow-up relative input is the prior worktree output, not a missing source file");
    return call("followup-read", "read", { path: outputName });
  },
  (last) => { assert.match(result(last, "followup-read"), /WORKTREE_ONLY_OUTPUT/); return { text: secondDone }; },
];
const parentSteps = [];
const settled = (task, tool, next) => (last) => {
  const reply = parse(last, tool);
  const row = reply.agents.find((entry) => entry.agent === "marten" && entry.task === task);
  assert(row, text(last));
  if (row.status !== "completed") {
    assert(["queued", "running", "finishing"].includes(row.status), text(last));
    assert(++waits <= 6, "unexpected repeated waits");
    parentSteps.unshift(settled(task, "agent_wait", next));
    return call(`wait-${waits}`, "agent_wait", { agents: ["marten"], wait_ms: 60000 });
  }
  assert.equal(row.result, task === 1 ? firstDone : secondDone);
  assert.equal(row.label, task === 1 ? firstLabel : secondLabel);
  if (tool === "agent_wait") assert.deepEqual(row.workspace, workspaceSummary());
  else assert.equal(Object.hasOwn(row, "workspace"), false, "action replies omit workspace");
  return next();
};
provider.respond(async (request) => {
  try {
    assert.equal(request.model.provider, "harness-fixture"); assert.equal(request.model.id, "controlled");
    const profile = /<active_agent name="(\w+)"\/>/.exec(request.context.systemPrompt ?? "")?.[1];
    if (!profile) {
      const spawnSchema = request.context.tools.find((tool) => tool.name === "agent_spawn")?.parameters;
      assert.deepEqual(spawnSchema?.properties.profile.enum, ["worker", "researcher"]);
      assert.deepEqual(spawnSchema?.properties.workspace.enum, ["shared", "worktree"]);
      const step = parentSteps.shift(); assert(step, "unscripted parent request");
      return step(request.context.messages.at(-1));
    }
    assert.equal(profile, "editor", "public worker maps to the real internal editor profile");
    const tools = request.context.tools.map((tool) => tool.name);
    for (const name of ["read", "write", "edit", "bash", "alert_parent", "ask_parent"]) assert(tools.includes(name), name);
    assert(!tools.some((name) => management.includes(name) || name === "web_search" || name === "notify_parent"));
    const prompt = request.context.systemPrompt;
    assert.match(prompt, /SOURCE_ONLY_TRUSTED_INSTRUCTION/, "real child resource loader inherits live source instructions");
    assert.doesNotMatch(prompt, /CHECKED_OUT_INSTRUCTION_NOT_SOURCE_AUTHORITY/);
    const current = JSON.parse(/Workspace: (\{[^\n]+\})/.exec(prompt)?.[1] ?? "null");
    assert.deepEqual(Object.keys(current).sort(), ["base_commit", "cwd", "mode", "source_cwd"], "child WorkspaceInfo stays the four-field binding");
    assert.equal(current.mode, "worktree"); assert.equal(current.source_cwd, cwd); assert.equal(current.base_commit, baseCommit);
    assert(isAbsolute(current.cwd)); assert.notEqual(current.cwd, cwd);
    assert(relative(join(stateRoot, "pi-alehouse", "worktrees"), current.cwd).startsWith("pi-alehouse-worktree-"),
      "worktree stays under the wrapper-owned XDG_STATE_HOME worktrees root");
    assert.equal(current.cwd.startsWith(temporaryRoot), false, "TMPDIR no longer drives allocation");
    assert.equal(current.cwd.startsWith(join(stateRoot, "pi-alehouse", "worktrees")), true);
    const taskText = text(request.context.messages.at(-1));
    if (taskText.includes("CONFLICT_HOLDER_TASK") || holderWorkspace?.cwd === current.cwd) {
      holderWorkspace ??= current;
      assert.deepEqual(current, holderWorkspace);
      assert.equal(realpathSync(join(current.cwd, "shared-build")), sharedOutput);
      assert(existsSync(join(agentDir, "harness-trees", createHash("sha256").update(sharedOutput).digest("hex"), "owner.lock")),
        "holder acquired the actual shared canonical tree before input");
      if (++holderCalls === 1) return call("holder-question", "ask_parent", { question: "Continue holding the shared output?" });
      assert.equal(holderCalls, 2); result(request.context.messages.at(-1), "holder-question");
      return { text: "HOLDER_WAITING" };
    }
    assert(!taskText.includes("CONFLICT_CONTENDER_TASK"), "binding conflict must prevent original contender child input");
    if (taskText.includes("CONFLICT_SAFE_TASK")) {
      contenderCalls++;
      assert.equal(contenderCalls, 1);
      assert.equal(current.cwd, contenderWorkspace.cwd, "safe follow-up reuses the successfully initialized contender workspace");
      return { text: "SAFE_DONE" };
    }
    if (workspace) assert.deepEqual(current, workspace, "follow-up retains the same worktree");
    else workspace = current;
    manifest ??= /Recovery manifest: ([^\n]+)/.exec(prompt)?.[1];
    assert.equal(manifest, join(dirname(workspace.cwd), "recovery.jsonl"));
    const step = childSteps.shift(); assert(step, "unscripted child request");
    return step(request.context.messages.at(-1));
  } catch (error) { scriptFailure ??= error; throw error; }
});
const noop = () => {};
const uiContext = {
  select: async (title) => { dialogs.push(title); throw new Error("Unexpected permission prompt in offline worktree fixture"); },
  confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
  notify: (message, type) => notifications.push({ message, type }), onTerminalInput: () => noop,
  setStatus: noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop,
  setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
  addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined,
  getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false }),
};
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
  model, thinkingLevel: "off", settingsManager, sessionManager: SessionManager.create(cwd, sessions), tools: ["read", ...management] });
const checkRetained = () => {
  assert(workspace && manifest);
  assert.equal(readFileSync(join(workspace.cwd, outputName), "utf8"), "WORKTREE_ONLY_OUTPUT\n");
  assert.equal(readFileSync(join(workspace.cwd, "ordinary.txt"), "utf8"), "COMMITTED_BASELINE\n");
  assert.equal(existsSync(join(workspace.cwd, "source-untracked.txt")), false, "untracked source file is not copied");
  assert.equal(readFileSync(join(workspace.cwd, ".pi/extensions/pi-permission-system/config.json"), "utf8"), permissiveConfig,
    "checked-out permissive config exists but did not replace live source authority");
  const records = readFileSync(manifest, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1).state, "ready"); assert.deepEqual(records.at(-1).workspace, workspace);
};
const checkRoster = (last, task) => {
  const reply = parse(last, "agent_list"); assert.equal(reply.agents.length, 1);
  const row = reply.agents[0];
  assert.equal(row.agent, "marten"); assert.equal(row.profile, "worker");
  assert.equal(row.task, task); assert.equal(row.status, "completed");
  assert.equal(row.label, task === 1 ? firstLabel : secondLabel);
  assert.deepEqual(row.workspace, workspaceSummary());
  assert.equal(lifecycle.filter((event) => event.kind === "session-created").length, 1, "agent_run reuses the actual SDK session");
  assert.equal(lifecycle.filter((event) => event.kind === "bound").length, 1);
  assert.equal(lifecycle.filter((event) => event.kind === "disposed").length, 0);
  checkRetained();
};
try {
  await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => errors.push(error.error) });
  assert.deepEqual(errors, []); assert(session.getActiveToolNames().includes("agent_spawn"));
  parentSteps.push(
    () => call("spawn-worktree", "agent_spawn", { agent: "marten", profile: "worker", workspace: "worktree",
      prompt: firstLabel, reasoning_difficulty: 1, dispatch: firstDispatch, wait_ms: 60000 }),
    settled(1, "agent_spawn", () => call("list-first", "agent_list", {})),
    (last) => { checkRoster(last, 1); return call("reuse-worktree", "agent_run", { agent: "marten", continues: "First task's worktree output", prompt: secondLabel, dispatch: nextDispatch, wait_ms: 60000 }); },
    settled(2, "agent_run", () => call("list-second", "agent_list", {})),
    (last) => { checkRoster(last, 2); return call("kill-worktree", "agent_kill", { agent: "marten" }); },
    (last) => {
      assert.deepEqual(parse(last, "agent_kill"), { agent: "marten", status: "killed", label: secondLabel });
      const [disposed] = lifecycle.filter((event) => event.kind === "disposed");
      assert(disposed); assert.equal(disposed.cleanup.shutdownExited, true); assert.deepEqual(disposed.cleanup.errors, []);
      checkRetained();
      return call("read-killed-task", "agent_read", { agent: "marten", task: 2 });
    },
    (last) => {
      const reply = parse(last, "agent_read");
      assert.equal(Object.hasOwn(reply, "reason"), false);
      assert.deepEqual(reply.agents, [{ agent: "marten", task: 2, status: "completed", unavailable: true, unavailable_reason: "explicitly_released",
        label: secondLabel, result: secondDone, workspace: workspaceSummary() }]);
      assert.equal(Object.hasOwn(reply, "pending"), false);
      assert.equal(Object.hasOwn(reply, "alerts_pending"), false); assert.equal(reply.alerts, undefined);
      assert.equal(Object.hasOwn(reply, "finished_pending"), false); assert.equal(reply.finished, undefined);
      checkRetained();
      return call("spawn-holder", "agent_spawn", { agent: "otter", profile: "worker", workspace: "worktree",
        prompt: holderLabel, reasoning_difficulty: 1, dispatch: { tree: "shared-build" }, wait_ms: 60000 });
    },
  );
  const conflictSettled = (agent, status, tool, next) => last => {
    const reply = parse(last, tool), row = reply.agents.find(entry => entry.agent === agent);
    assert(row, text(last));
    if (row.status !== status) {
      assert(["queued", "running", "finishing"].includes(row.status), text(last));
      assert(++waits <= 12);
      parentSteps.unshift(conflictSettled(agent, status, "agent_wait", next));
      return call(`conflict-wait-${waits}`, "agent_wait", { agents: [agent], wait_ms: 60000 });
    }
    return next(row);
  };
  parentSteps.push(
    conflictSettled("otter", "needs_input", "agent_spawn", row => {
      assert(row.question_id); assert.equal(row.result, "HOLDER_WAITING");
      return call("read-holder", "agent_read", { agent: "otter" });
    }),
    last => {
      const row = parse(last, "agent_read").agents[0];
      assert.equal(row.status, "needs_input"); assert.deepEqual(row.workspace, { ...holderWorkspace, checkout_root: holderWorkspace.cwd });
      assert.equal(holderCalls, 2);
      return call("spawn-contender", "agent_spawn", { agent: "badger", profile: "worker", workspace: "worktree",
        prompt: contenderLabel, reasoning_difficulty: 1, dispatch: { tree: "shared-build" }, wait_ms: 60000 });
    },
    conflictSettled("badger", "failed", "agent_spawn", row => {
      assert.match(row.error, /BUILD_TREE_BUSY/); assert.equal(row.unavailable, undefined);
      assert.equal(contenderCalls, 0, "conflicting task never requested model transport");
      return call("read-contender", "agent_read", { agent: "badger" });
    }),
    last => {
      const row = parse(last, "agent_read").agents[0];
      contenderWorkspace = row.workspace; assert(contenderWorkspace);
      assert.notEqual(contenderWorkspace.cwd, holderWorkspace.cwd, "two independent real worktrees");
      assert.equal(realpathSync(join(contenderWorkspace.cwd, "shared-build")), sharedOutput);
      const created = lifecycle.filter(event => event.kind === "session-created");
      assert.equal(created.length, 3); contenderSessionId = created.at(-1).sessionId;
      for (const file of readdirSync(sessions).filter(name => name.includes(contenderSessionId))) {
        const journal = readFileSync(join(sessions, file), "utf8");
        assert(!journal.includes("harness:run-start:v1"), "binding refusal precedes child history.begin");
        assert(!journal.includes('"role":"assistant"'), "no model output before conflict refusal");
      }
      assert.equal(lifecycle.filter(event => event.kind === "disposed").length, 1, "healthy contender was not disposed");
      return call("reuse-contender", "agent_run", { agent: "badger", continues: "The retained workspace from the preflight-failed task",
        prompt: safeLabel, dispatch: { tree: "safe-build" }, wait_ms: 60000 });
    },
    conflictSettled("badger", "completed", "agent_run", row => {
      assert.equal(row.result, "SAFE_DONE"); assert.equal(contenderCalls, 1);
      assert.equal(lifecycle.filter(event => event.kind === "session-created").length, 3, "follow-up reused the healthy session");
      return call("kill-contender", "agent_kill", { agent: "badger" });
    }),
    last => { assert.equal(parse(last, "agent_kill").status, "killed"); return call("kill-holder", "agent_kill", { agent: "otter" }); },
    last => {
      assert.equal(parse(last, "agent_kill").status, "killed");
      assert.equal(holderCalls, 2); assert.equal(contenderCalls, 1);
      return { text: "PARENT_DONE" };
    },
  );
  await session.prompt("START", { expandPromptTemplates: false });
  if (scriptFailure) throw scriptFailure;
  assert.deepEqual(parentSteps, []); assert.deepEqual(childSteps, []);
  assert.equal(session.isIdle, true);
  await session.prompt("/harness-close");
  assert(notifications.some(({ message }) => message === "Harness owner closed; session replacement is now permitted."),
    "explicit close must confirm Owner closure, not just idle/disposal");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
assert.deepEqual(errors, []);
assert(!notifications.some(({ type }) => type === "error"), JSON.stringify(notifications));
const created = lifecycle.filter((event) => event.kind === "session-created").map((event) => event.sessionId);
const disposed = lifecycle.filter((event) => event.kind === "disposed");
assert.equal(created.length, 3); assert.deepEqual(disposed.map(event => event.sessionId).sort(), [...created].sort());
assert.equal(contenderSessionId, created.at(-1));
assert(disposed.every(event => event.cleanup.shutdownExited && event.cleanup.errors.length === 0));
assert.deepEqual(readdirSync(sharedOutput), [], "conflict declarations and synthetic tools do not write the external output");
assert.equal(disposed[0].cleanup.shutdownExited, true); assert.deepEqual(disposed[0].cleanup.errors, []);
checkRetained(); // Both kill and confirmed parent shutdown retain the dirty output and recovery manifest.
for (const [path, bytes] of sourceFiles) assert.deepEqual(readFileSync(path), bytes, `source bytes unchanged: ${path}`);
assert.equal(existsSync(join(cwd, outputName)), false, "SDK builtin wrote in actual worktree cwd, never source");
assert.equal(existsSync(join(cwd, "build")), false, "relative tree did not allocate source output");
assert.equal(existsSync(join(workspace.cwd, "build")), false, "tree declaration and lease alone do not create user output");
assert.equal(runGit("rev-parse", "HEAD").trim(), baseCommit, "no auto commit/merge");
assert.deepEqual(readFileSync(join(cwd, ".git/index")), sourceIndex, "source index bytes unchanged");
assert.equal(runGit("status", "--porcelain=v1", "--untracked-files=all"), sourceStatus, "source status unchanged (not whole-tree identity)");
assert.equal(runGit("remote"), "");
assert.deepEqual(dialogs, []); assert.deepEqual(network, []);
// Cleanup is a TEST-only wrapper action, enabled only after all closure and
// retention assertions. Failure/timeout leaves private artifacts for inspection.
writeFileSync(closedMarker, "confirmed fixture closure; retained output checked\n", { flag: "wx", mode: 0o600 });
console.log("PASS: real composition worktrees inherit source policy and SDK cwd, reject shared canonical tree conflict before child input/history, retain a healthy reusable session and dirty output through confirmed shutdown; source files and index unchanged; offline");
