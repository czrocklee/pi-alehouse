#!/usr/bin/env node
// Real patched pipeline + real SDK extension lifecycle. Offline fabricated data;
// no private transcripts, production settings, model API, or historical execution.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mock } from "node:test";
const [repo, executable, agentDir] = process.argv.slice(2);
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(packageRoot && agentDir);
const require = createRequire(realpathSync(executable));
let piRoot = dirname(realpathSync(executable));
while (!existsSync(join(piRoot, "package.json"))) {
  const parent = dirname(piRoot);
  assert.notEqual(piRoot, parent, `Pi package.json not found above ${executable}`);
  piRoot = parent;
}
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const publicServicePath = join(packageRoot, "src/service.ts");
process.env.PI_CODING_AGENT_DIR = agentDir;
const publicService = await jiti.import(publicServicePath);
const load = name => jiti.import(join(packageRoot, "src", `${name}.ts`));
const [{ BashProgram }, { PermissionManager }, { PermissionResolver }, { PathNormalizer }, { posixPathFlavor }, { resolveBashCommandCheck }, { describeBashPathGate }, { describeBashExternalDirectoryGate }, { describeExternalDirectoryGate }, { LocalUserAuthorizer }, { createFailClosedToolCall }, promptQueue, terminalTitle] = await Promise.all([
  load("access-intent/bash/program"), load("policy/permission-manager"), load("policy/permission-resolver"), load("path/path-normalizer"), load("path/path-flavor"), load("handlers/gates/bash-command"), load("handlers/gates/bash-path"), load("handlers/gates/bash-external-directory"), load("handlers/gates/external-directory"), load("authority/local-user-authorizer"), load("handlers/tool-call-boundary"),
  jiti.import(join(repo, "extensions/ui-prompt-queue.ts")),
  jiti.import(join(repo, "extensions/terminal-title-status.ts")),
]);

// This joins the real built LocalUserAuthorizer to the production prompt queue.
// It deliberately observes only the lifecycle id: no result, error or content
// becomes an event payload, and a fail-closed boundary must retain its own id.
const PROMPT_END_EVENT = "managed-permissions:ui_prompt_end:v1";
const permissionDetails = (requestId, forwarding) => ({
  requestId,
  source: "tool_call",
  agentName: "fixture",
  toolName: "bash",
  command: "sleep 7",
  payload: { request: { surface: "bash", value: "sleep 7" } },
  ...(forwarding ? { forwarding } : {}),
});
const eventBus = () => {
  const handlers = new Map();
  const emitted = [];
  return {
    emitted,
    events: {
      on(channel, handler) {
        const list = handlers.get(channel) ?? [];
        handlers.set(channel, [...list, handler]);
        return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((entry) => entry !== handler));
      },
      emit(channel, data) {
        // Snapshot before a synchronous observer can mutate the public object.
        emitted.push({ channel, data: structuredClone(data) });
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
    },
  };
};
const endEvents = (bus, requestId) => bus.emitted.filter((event) =>
  event.channel === PROMPT_END_EVENT && event.data.requestId === requestId);
const assertOnePromptEnd = (bus, requestId) => {
  const events = endEvents(bus, requestId);
  assert.equal(events.length, 1, `one lifecycle end for ${requestId}`);
  assert.deepEqual(events[0].data, { requestId }, "end observation has no decision, error, or content");
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// All outcomes after the start broadcast end the original prompt id. The
// captured id survives a mutable start payload and an end observer failure.
{
  const bus = eventBus();
  const ui = {};
  const approved = { approved: true, state: "approved", decidedBy: { kind: "human" } };
  const preferences = { doublePressToConfirm: true, budget: { width: 80 } };
  let request;
  bus.events.on("permissions:ui_prompt", (event) => { event.requestId = "observer-mutated-id"; });
  bus.events.on(PROMPT_END_EVENT, () => { throw new Error("observer failure"); });
  const authorizer = new LocalUserAuthorizer({
    ui,
    mode: "tui",
    events: bus.events,
    getPromptPreferences: () => preferences,
    requestPermissionDecision: async (...args) => { request = args; return approved; },
  });
  const forwarded = { requesterAgentName: "worker", requesterSessionId: "child" };
  assert.strictEqual(await authorizer.authorize(permissionDetails("prompt-success", forwarded)), approved);
  const start = bus.emitted.find((event) => event.channel === "permissions:ui_prompt");
  assert.deepEqual(start?.data.forwarding, forwarded, "forwarded prompt metadata is unchanged");
  assert.equal(start?.data.requestId, "prompt-success", "start observer received the original id");
  assert.equal(request[0].ui, ui);
  assert.equal(request[1], "Permission Required (Subagent)");
  assert.strictEqual(request[3], undefined);
  assertOnePromptEnd(bus, "prompt-success");
}
{
  const bus = eventBus();
  const refused = { approved: false, state: "denied", decidedBy: { kind: "human" } };
  const authorizer = new LocalUserAuthorizer({ ui: {}, mode: "tui", events: bus.events,
    getPromptPreferences: () => ({}), requestPermissionDecision: async () => refused });
  assert.strictEqual(await authorizer.authorize(permissionDetails("prompt-refusal")), refused);
  assertOnePromptEnd(bus, "prompt-refusal");
}
const assertPromptFailure = async (label, error, configure) => {
  const bus = eventBus();
  bus.events.on(PROMPT_END_EVENT, () => { throw new Error("observer failure must not mask the original error"); });
  let requestCalls = 0;
  const deps = {
    ui: {}, mode: "tui", events: bus.events,
    getPromptPreferences: () => ({}),
    requestPermissionDecision: () => { requestCalls++; throw new Error("unset request"); },
  };
  const details = permissionDetails(`prompt-${label}`);
  configure(deps, details, () => { requestCalls++; });
  await assert.rejects(new LocalUserAuthorizer(deps).authorize(details), (caught) => caught === error,
    `${label} preserves the original error`);
  assertOnePromptEnd(bus, details.requestId);
  return requestCalls;
};
{
  const error = new Error("synchronous request failure");
  const calls = await assertPromptFailure("sync-rejection", error, (deps, _details, called) => {
    deps.requestPermissionDecision = () => { called(); throw error; };
  });
  assert.equal(calls, 1);
}
{
  const error = new Error("asynchronous request failure");
  const calls = await assertPromptFailure("async-rejection", error, (deps, _details, called) => {
    deps.requestPermissionDecision = () => { called(); return Promise.reject(error); };
  });
  assert.equal(calls, 1);
}
{
  const error = new Error("preferences failure");
  const calls = await assertPromptFailure("preferences-rejection", error, (deps) => {
    deps.getPromptPreferences = () => { throw error; };
  });
  assert.equal(calls, 0, "a throwing preference reader reaches no dialog");
}
{
  const error = new Error("request options failure");
  const calls = await assertPromptFailure("options-rejection", error, (_deps, details) => {
    const approval = {};
    Object.defineProperty(approval, "grants", { get: () => { throw error; } });
    details.sessionApproval = approval;
  });
  assert.equal(calls, 0, "a throwing option builder reaches no dialog");
}

// Install the real extension wrapper. The first inline ui.custom dialog never
// settles; Node mock timers advance its production ten-minute bound without
// waiting. Queue cancellation calls its done handle. The queued successor stays
// live until this test completes it, and a late first done is inert.
{
  const queueKey = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");
  const queueGlobals = globalThis;
  const hadQueue = Object.hasOwn(queueGlobals, queueKey);
  const previousQueue = queueGlobals[queueKey];
  let timersEnabled = false;
  try {
    delete queueGlobals[queueKey];
    const sessionHandlers = [];
    promptQueue.default({ on: (event, handler) => { if (event === "session_start") sessionHandlers.push(handler); } });
    assert.equal(sessionHandlers.length, 1, "production prompt queue registered its session hook");
    let customCalls = 0;
    const ui = {
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      editor: async () => undefined,
      custom: (factory) => new Promise((resolve) => {
        customCalls++;
        factory({}, {}, {}, resolve);
      }),
    };
    sessionHandlers[0]({}, { mode: "tui", hasUI: true, ui });
    const bus = eventBus();
    const titleHooks = new Map();
    const titleWrites = [];
    ui.setTitle = (title) => titleWrites.push(title);
    ui.setWidget = () => {};
    terminalTitle.default({
      events: bus.events,
      on(event, handler) {
        const list = titleHooks.get(event) ?? [];
        titleHooks.set(event, [...list, handler]);
        return () => titleHooks.set(event, (titleHooks.get(event) ?? []).filter((entry) => entry !== handler));
      },
      getSessionName: () => "fixture",
    });
    const titleStart = titleHooks.get("session_start")?.[0];
    assert(titleStart, "title extension registered its session hook");
    titleStart({}, { mode: "tui", cwd: "/fixture", ui });
    const approved = { approved: true, state: "approved", decidedBy: { kind: "human" } };
    let firstDialogDone;
    let successorDone;
    let dialogFactories = 0;
    const requestPermissionDecision = async (view) => {
      await view.ui.custom((_tui, _theme, _keybindings, done) => {
        if (++dialogFactories === 1) firstDialogDone = done;
        else successorDone = done;
        return { render: () => [], invalidate() {} };
      });
      return approved;
    };
    const original = permissionDetails("prompt-timeout");
    const successorDetails = permissionDetails("prompt-worker", { requesterAgentName: "worker", requesterSessionId: "child" });
    const authorizer = new LocalUserAuthorizer({ ui, mode: "tui", events: bus.events,
      getPromptPreferences: () => ({}), requestPermissionDecision });
    const reviews = [];
    const gate = createFailClosedToolCall(
      async () => { await authorizer.authorize(original); return { action: "allow" }; },
      { writeReviewLog: (...args) => reviews.push({ type: "log", args }), emitDecision(event) {
        reviews.push({ type: "decision", event });
        bus.events.emit("permissions:decision", event);
      } },
      { recordDecision() {}, recordError() {} },
      { debug() {} },
    );
    mock.timers.enable({ apis: ["setTimeout"], now: 0 });
    timersEnabled = true;
    const blocked = gate({ toolName: "bash", input: { command: "sleep 7" } }, {});
    let successorSettled = false;
    const successor = authorizer.authorize(successorDetails)
      .then((value) => { successorSettled = true; return value; });
    await flush();
    assert.equal(titleWrites.at(-1), "! - fixture", "original prompt enters approval title state");
    assert.equal(customCalls, 1, "the successor inline dialog is queued behind the stalled one");
    assert.equal(typeof firstDialogDone, "function", "first inline dialog supplied a done handle");
    mock.timers.tick(10 * 60 * 1000);
    const result = await blocked;
    await flush();
    assert.equal(result.block, true, "queue timeout remains fail-closed");
    assert.match(result.reason, /Inline prompt did not settle within 600000ms/);
    assert.equal(titleWrites.at(-1), "! - fixture", "forwarded worker remains pending after the local prompt ends");
    assert.equal(customCalls, 2, "queue handed the released slot to its forwarded inline successor");
    assert.equal(typeof successorDone, "function");
    assert.equal(successorSettled, false, "successor remains live until its own done call");
    const gateError = reviews.find((entry) => entry.type === "decision")?.event;
    assert.equal(gateError?.resolution, "gate_error");
    assert.notEqual(gateError?.requestId, original.requestId, "gate error keeps its separately minted id");
    assertOnePromptEnd(bus, original.requestId);
    const endsBeforeLateResolve = endEvents(bus, original.requestId).length;
    firstDialogDone("late approval");
    await flush();
    assert.equal(endEvents(bus, original.requestId).length, endsBeforeLateResolve, "late dialog resolution is inert");
    assert.equal(reviews.filter((entry) => entry.type === "decision").length, 1, "late resolution cannot mint another gate decision");
    successorDone("successor completed");
    assert.strictEqual(await successor, approved, "forwarded successor settles only through its own inline done call");
    assert.equal(titleWrites.at(-1), "π - fixture", "forwarded settlement proves the original local id was cleared despite gate error B");
    assertOnePromptEnd(bus, successorDetails.requestId);
  } finally {
    if (timersEnabled) mock.timers.reset();
    if (hadQueue) queueGlobals[queueKey] = previousQueue;
    else delete queueGlobals[queueKey];
  }
}
console.log("PASS: built LocalUserAuthorizer ends original UI prompts on success/refusal/errors and production queue timeout without fabricating decisions");

const scratch = mkdtempSync(join(tmpdir(), "pi-managed-test-"));
const cwd = join(scratch, "repo"); mkdirSync(cwd);
const savedEnv = { ...process.env };
Object.assign(process.env, { HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sessions = [];
const externalScratch = [];
try {
  git("init", "-q");
  writeFileSync(join(cwd, "ordinary.txt"), "before\n");
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src/code.ts"), "export const n = 1;\n");
  writeFileSync(join(cwd, "syntax.sh"), "printf source-ran > \"$BASH_SOURCE_CANARY\"\n");
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  writeFileSync(join(cwd, "ordinary.txt"), "after\n");
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  const config = JSON.parse(readFileSync(configPath));
  const manager = new PermissionManager({ globalConfigPath: configPath, agentsDir: join(agentDir, "agents"), mcpServerNames: [] });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const check = async (command, agentName) => {
    const program = await BashProgram.parse(command, normalizer);
    const context = { toolCallId: "fixture", toolName: "bash", cwd, agentName };
    return { program, bash: resolveBashCommandCheck(command, program.commands(), agentName, resolver),
      path: describeBashPathGate(context, program, resolver, normalizer), external: describeBashExternalDirectoryGate(context, program, resolver, normalizer) };
  };
  // Profile write ceilings survive inherited path exceptions, project policy,
  // standing session grants and YOLO. Read scope and editor policy stay intact.
  const ceilingProject = join(scratch, "ceiling-project.json");
  writeFileSync(ceilingProject, JSON.stringify({ permission: { path_write: { "*.future": "allow" } } }));
  const ceilingProjectAgents = join(scratch, "ceiling-project-agents");
  mkdirSync(ceilingProjectAgents);
  writeFileSync(join(ceilingProjectAgents, "reader.md"), '---\npermission:\n  path_write:\n    "*": allow\n---\n');
  writeFileSync(join(ceilingProjectAgents, "partial.md"), '---\npermission:\n  path_write:\n    "*": deny\n    "*.pem": ask\n---\n');
  writeFileSync(join(ceilingProjectAgents, "local-reader.md"), '---\npermission:\n  path_write: deny\n---\n');
  for (const yolo of [false, true]) {
    const ceilingManager = new PermissionManager({ globalConfigPath: configPath, agentsDir: join(agentDir, "agents"),
      projectGlobalConfigPath: ceilingProject, projectAgentsDir: ceilingProjectAgents, mcpServerNames: [], isYoloEnabled: () => yolo });
    assert.equal(ceilingManager.getToolPermission("path_write", "reader"), "deny");
    assert.equal(ceilingManager.isToolFullyDenied("path_write", "reader"), true);
    const certificateIntent = { kind: "path-values", surface: "path_write", values: [join(cwd, "ordinary.pem")] };
    assert.equal(ceilingManager.check({ ...certificateIntent, agentName: "partial" }).state, yolo ? "allow" : "ask",
      "Partial profile rules keep their own exceptions; a catch-all alone is not enough");
    assert.equal(ceilingManager.isToolFullyDenied("path_write", "partial"), false);
    const localCeiling = ceilingManager.check({ ...certificateIntent, agentName: "local-reader" });
    assert.equal(localCeiling.state, "deny", "A project-agent's scalar full-surface denial is also a ceiling");
    assert.equal(localCeiling.origin, "project-agent");
    for (const grants of [[], [{ surface: "path_write", pattern: "*", action: "allow", layer: "session", origin: "session" }]]) {
      const ceilingResolver = new PermissionResolver(ceilingManager, { getRuleset: () => grants });
      assert.equal(ceilingResolver.resolve({ ...certificateIntent, agentName: "local-reader" }).state, "deny",
        "A path-only profile ceiling holds without relying on a direct write-tool deny");
      assert.equal(ceilingManager.check({ kind: "tool", surface: "path_write", input: join(cwd, "ordinary.pem"), agentName: "local-reader" }, grants).state, "deny",
        "The raw tool-intent path is clamped as well as path-values");
      for (const name of ["ordinary.txt", "ordinary.pem", "ordinary.key", "ordinary.p12", "ordinary.pfx", "ordinary.future", ".env.example"]) {
        const command = `printf '%s' fixture > ./${name}`;
        const program = await BashProgram.parse(command, normalizer);
        const path = describeBashPathGate({ toolCallId: "ceiling", toolName: "bash", cwd, agentName: "reader" }, program, ceilingResolver, normalizer);
        assert.equal(path?.preCheck.state, "deny", `reader ceiling: ${name}, yolo=${yolo}, sessionGrant=${grants.length}`);
        assert.equal(path.preCheck.origin, "agent", "Inherited exceptions cannot replace the profile ceiling");
      }
      assert.equal(ceilingResolver.resolve({ kind: "path-values", surface: "path_read", values: [join(cwd, "ordinary.txt")], agentName: "reader" }).state, "allow");
      for (const agentName of [undefined, "editor"]) {
        assert.equal(ceilingResolver.resolve({ kind: "path-values", surface: "path_write", values: [join(cwd, "ordinary.future")], agentName }).state, "allow");
        assert.equal(ceilingResolver.resolve({ kind: "path-values", surface: "path_write", values: [join(cwd, "ordinary.pem")], agentName }).state,
          yolo || grants.length ? "allow" : "ask", "No new write ceiling on root/editor");
      }
      const protectedWrite = ceilingResolver.resolve({ kind: "path-values", surface: "path_write", values: [join(cwd, ".git/config")], agentName: "reader" });
      assert.equal(protectedWrite.state, "deny");
      assert.equal(protectedWrite.origin, grants.length ? "agent" : "global",
        "Keep an existing specific denial; otherwise clamp the session grant to the profile ceiling");
    }
  }
  console.log("PASS: reader write ceiling survives inherited/project exceptions, project-agent widening, session grants and yolo");
  const { hardenGitInput, originalGitCommands } = await load("access-intent/bash/managed-read-policy");
  const fixedRequested = [
    "command -v pi", "command -v alejandra", "command -v mypy", "bash -n syntax.sh",
    "env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER",
    "printenv BUILD_DIR AOBUS_BUILD_ROOT",
  ];
  const weeklyRequested = [
    "git diff --unified=0 -- ordinary.txt", "git diff --unified=80 -- ordinary.txt",
    "sed -n '1p;2,4p' ordinary.txt", "nl -ba ordinary.txt | sed -n '1,2p;2,4p'",
  ];
  const fixedPositive = [];
  for (const command of fixedRequested) {
    const input = { command };
    assert(await hardenGitInput(input), `Fixed query must be hardened: ${command}`);
    assert.deepEqual(originalGitCommands(input), [command]);
    fixedPositive.push(input.command);
  }
  const diff = "git --no-lazy-fetch diff --no-ext-diff --no-textconv --ignore-submodules=all";
  const positive = [...fixedPositive, "git status --short", "git status --short -- ordinary.txt", "git status --short --ignored", "git log -5 --oneline", "git log --oneline -n 20 HEAD", "git show -s --format=%ci HEAD~1", "git ls-files", "git ls-files -- src", ...["", " --stat", " --check", " --name-only", " --name-status", " --cached --stat", " --cached --check", " --unified=0", " --unified=9999", " --unified=3 --stat", " --no-renames -- ordinary.txt"].map(suffix => diff + suffix), "cut -d : -f 1 ordinary.txt", "nl -ba ordinary.txt", "readlink ordinary.txt", "sha256sum ordinary.txt", "cat ordinary.txt", "head -n 1 ordinary.txt", "sed -n '1p;2,4p' ordinary.txt", "sed -n '1,2p;2,$p' ordinary.txt", `sed -n '${Array(32).fill("1p").join(";")}' ordinary.txt`].map(command => command.startsWith("git ") && !command.startsWith("git --no-lazy-fetch ") ? command.replace(/^git /, "git --no-lazy-fetch ") : command);
  const negative = [
    ...["--unified", "--unified=", "--unified=-1", "--unified=10000", "--unified=3x", "--unif=3", "--unified 3", "-U", "-U-1", "-U10000", "-U3x", "-U 3"].map(flag => `${diff} --stat ${flag}`),
    ...["1p;", ";1p", "1p;;2p", "0,2p;3p", "1p;2q", "1p;2e", "1p;w output.txt", "1p;r .env", "1p;s/a/b/e", "1p;#comment", "1p\\n2p", Array(33).fill("1p").join(";")].map(program => `sed -n '${program}' ordinary.txt`),
    "sed -i -n '1p;2p' ordinary.txt", "sed -n '1p;2p' -f script.sed", "env sed -n '1p;2p' ordinary.txt", "sed -n '1p;2p' ordinary.txt > output.txt", "sed -n '1p;2p' ordinary.txt && touch output.txt",
    "command -v", "command -v git", "command -v ../pi", "command -v -- pi", "command pi", "bash -n", "bash -n syntax.sh extra", "bash -c syntax.sh", "bash -n .", "bash -n $FILE",
    "printenv", "printenv HOME", "printenv PI_OTHER", "printenv PI_MODEL HOME", "env", "env printenv HOME", "env FOO=bar printenv PI_MODEL",
    "ruff check syntax.sh", "ruff check --fix syntax.sh", "ruff check --output-file out syntax.sh", "ruff format --check syntax.sh",
    "git log -5 --oneline", "git diff --no-ext-diff --no-textconv --ignore-submodules=all", "git diff", "git diff --stat", "git diff --check", `${diff} --output=ordinary.txt`, `${diff} --out=ordinary.txt`, `${diff} --o ordinary.txt`, `${diff} --ext-diff`, `${diff} --textconv`, `${diff} HEAD~1`, `${diff} --no-renames -- ../repo/ordinary.txt`, `${diff} --no-renames -- ':(top)*'`, `${diff} --no-renames -- "$INPUT"`, `${diff} > ordinary.txt`, `${diff} && touch ordinary.txt`, `env ${diff}`, `timeout 5 ${diff}`, "git -c core.pager=cat status --short", "git -C . status --short", "git --no-pager log -5 --oneline", "git show HEAD:.env", "git show HEAD", "git blame ordinary.txt", "git log -p -1", "git ls-files --with-tree=HEAD", "git ls-files --recurse-submodules"];
  for (const agent of [undefined, "editor", "reader"]) {
    for (const command of positive) {
      const result = await check(command, agent);
      assert.equal(result.bash.state, "allow", `${agent}: Bash: ${command}`);
      assert.equal(result.path, null, `${agent}: path: ${command}`);
      assert(!result.external || result.external.action === "allow", `${agent}: external: ${command}`);
    }
    for (const command of negative) {
      const result = await check(command, agent);
      assert.notEqual(result.bash.state, "allow", `${agent}: unsupported command: ${command}`);
      assert(!result.program.commands().some(command => command.floorExemption), `New proof reached wrapper core: ${command}`);
    }
    if (agent && agent !== "editor") assert.equal((await check("echo fixture > ordinary.txt", agent)).path.preCheck.state, "deny", "A reader cannot write, even with approval");
    else assert.equal((await check("echo fixture > ordinary.txt", agent)).path, null);
    assert.equal((await check("echo fixture > ~/.pi/agent/settings.json", agent)).path.preCheck.state, "deny");
    assert.equal((await check("cut -f 1 /var/lib/pi-fixture/external.txt", agent)).external.preCheck.state, "ask");
  }
  const procContext = path => ({ toolCallId: "proc-fixture", toolName: "read", input: { path }, cwd });
  for (const path of ["/proc/meminfo", "/proc/self/mountinfo"]) {
    const gate = describeExternalDirectoryGate(procContext(path), config.piInfrastructureReadPaths, resolver, normalizer);
    assert.equal(gate.preCheck.state, "allow", `Exact proc metadata scope: ${path}`);
  }
  const selfMount = normalizer.forPath("/proc/self/mountinfo");
  assert(selfMount.matchValues().includes("/proc/self/mountinfo"));
  assert.match(selfMount.boundaryValue(), /^\/proc\/\d+\/mountinfo$/, "Canonical self resolves to this Pi process, not a wildcard rule");
  for (const path of ["/proc/1/environ", "/proc/self/environ", "/proc/self/fd", `/proc/${process.pid}/mountinfo`]) {
    const gate = describeExternalDirectoryGate(procContext(path), config.piInfrastructureReadPaths, resolver, normalizer);
    assert.equal(gate.preCheck.state, "ask", `Other proc path remains review: ${path}`);
  }
  // A missing ordinary tracked file still has a narrow, policy-checked scope.
  rmSync(join(cwd, "ordinary.txt"));
  for (const agent of [undefined, "editor", "reader"]) {
    const deleted = await check(`${diff} --no-renames -- ordinary.txt`, agent);
    assert.equal(deleted.bash.state, "allow"); assert.equal(deleted.path, null);
  }
  writeFileSync(join(cwd, "ordinary.txt"), "after\n");
  // Whole-repo diff includes protected descendants even though none is named
  // in the command, including deleted index entries still present in HEAD.
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=not-real\n");
  writeFileSync(join(cwd, "src/.env"), "FAKE_NESTED_FIXTURE=not-real\n"); git("add", ".env", "src/.env");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fake sensitive fixture");
  const scopedCheck = { command: "git diff --check" }; await hardenGitInput(scopedCheck);
  assert.equal((await check(scopedCheck.command)).path, null, "Unchanged protected files cannot disable ordinary diff/check");
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=changed-private-marker\n");
  assert.equal((await check(scopedCheck.command)).path.preCheck.state, "deny", "Changed protected content still denies");
  for (const [requested, expected, gate] of [
    ["bash -n .env", "deny", "path"],
    ["bash -n /var/lib/pi-fixture/external.sh", "ask", "external"],
  ]) {
    const input = { command: requested }; await hardenGitInput(input);
    const result = await check(input.command);
    assert.equal(result[gate].preCheck.state, expected, `Fixed syntax check retains ${gate} scope: ${requested}`);
  }
  for (const suffix of ["--stat -p", "--stat --patch", "--stat --check", "--stat --binary", "--stat -U0", "--stat --unified=0", "--unified=3 --stat", "--name-only --unified=1"]) {
    const mixed = { command: `git diff ${suffix}` }; await hardenGitInput(mixed);
    assert.equal((await check(mixed.command)).path.preCheck.state, "deny", "Summary cannot hide a content-bearing option");
  }
  for (const format of ["--stat", "--numstat", "--shortstat", "--summary", "--name-only", "--name-status"]) {
    const metadata = { command: `git diff ${format}` }; await hardenGitInput(metadata);
    assert.equal((await check(metadata.command)).path, null, "Summary-only metadata does not expose file contents");
    const output = spawnSync("bash", ["-c", metadata.command], { cwd, encoding: "utf8" });
    assert.equal(output.status, 0); assert(!output.stdout.includes("changed-private-marker"));
  }
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=not-real\n");
  git("rm", "-q", ".env", "src/.env");
  for (const agent of [undefined, "editor", "reader"]) {
    assert.equal((await check(`${diff} --cached`, agent)).path.preCheck.state, "deny", "Deleted HEAD secret is checked");
    assert.equal((await check(`${diff} --no-renames -- ordinary.txt`, agent)).path, null, "Explicit file proof does not read unrelated historical blobs");
    for (const path of ["src", "src//", "./src/./", "."])
      assert.equal((await check(`${diff} --cached --no-renames -- ${path}`, agent)).path.preCheck.state, "deny", "Directory spellings cannot omit protected descendants");
  }
  writeFileSync(join(cwd, ".env"), "FAKE_UNTRACKED_FIXTURE\n");
  symlinkSync(".env", join(cwd, "alias.txt"));
  assert.equal((await check("cat alias.txt", "editor")).path.preCheck.state, "deny");
  assert.equal((await check(`${diff} --no-renames -- alias.txt`)).path.preCheck.state, "deny", "Git proof retains canonical symlink policy");
  // An explicit deny/ask and an invalid scope may never be replaced by proof.
  for (const action of ["ask", "deny"]) {
    const file = join(scratch, `policy-${action}.json`);
    writeFileSync(file, JSON.stringify({ ...config, permission: { ...config.permission, bash: { ...config.permission.bash, "git --no-lazy-fetch log *": action } } }));
    const local = new PermissionResolver(new PermissionManager({ globalConfigPath: file, agentsDir: join(agentDir, "agents"), mcpServerNames: [] }), { getRuleset: () => [] });
    const p = await BashProgram.parse("git --no-lazy-fetch log -5 --oneline", normalizer);
    assert.equal(resolveBashCommandCheck(p.commandText(), p.commands(), undefined, local).state, action);
  }
  for (const [index, requested] of ["bash -n syntax.sh", "env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER", ...weeklyRequested.filter(command => !command.includes("|"))].entries()) {
    const input = { command: requested }; await hardenGitInput(input);
    for (const [surface, pattern] of [["original", requested], ["hardened", input.command]]) {
      for (const action of ["ask", "deny"]) {
        const file = join(scratch, `fixed-${index}-${surface}-${action}.json`);
        writeFileSync(file, JSON.stringify({ ...config, permission: { ...config.permission, bash: { ...config.permission.bash, [pattern]: action } } }));
        const local = new PermissionResolver(new PermissionManager({ globalConfigPath: file, agentsDir: join(agentDir, "agents"), mcpServerNames: [] }), { getRuleset: () => [] });
        const p = await BashProgram.parse(input.command, normalizer, { originalCommands: originalGitCommands(input) });
        assert.equal(resolveBashCommandCheck(p.commandText(), p.commands(), undefined, local).state, action, `${surface} ${action} wins: ${requested}`);
      }
    }
  }
  const disabledProofPolicy = join(scratch, "disabled-proof.json");
  writeFileSync(disabledProofPolicy, JSON.stringify({ ...config, permission: { ...config.permission, managed_static_read: "ask" } }));
  for (const requested of [...fixedRequested, ...weeklyRequested]) {
    const input = { command: requested }; await hardenGitInput(input);
    const program = await BashProgram.parse(input.command, normalizer, { originalCommands: originalGitCommands(input) });
    const disabledResolver = new PermissionResolver(new PermissionManager({ globalConfigPath: disabledProofPolicy, agentsDir: join(agentDir, "agents"), mcpServerNames: [] }), { getRuleset: () => [] });
    assert.notEqual(resolveBashCommandCheck(program.commandText(), program.commands(), undefined, disabledResolver).state, "allow", `Managed opt-out: ${requested}`);
  }
  const sessionInput = { command: "git log -7 --oneline" }; await hardenGitInput(sessionInput);
  const sessionProgram = await BashProgram.parse(sessionInput.command, normalizer, { originalCommands: originalGitCommands(sessionInput) });
  for (const action of ["allow", "deny"]) {
    const sessionResolver = new PermissionResolver(new PermissionManager({ globalConfigPath: disabledProofPolicy, agentsDir: join(agentDir, "agents"), mcpServerNames: [] }), {
      getRuleset: () => [{ surface: "bash", pattern: "git log -7 --oneline", action, layer: "session", origin: "session" }],
    });
    const result = resolveBashCommandCheck(sessionProgram.commandText(), sessionProgram.commands(), undefined, sessionResolver);
    assert.equal(result.state, action); assert.equal(result.source, "session", "Original session decision survives hardening with new grants disabled");
  }
  const brokenAgents = join(scratch, "broken-agents"); mkdirSync(brokenAgents);
  const brokenConfig = join(scratch, "broken-config.json");
  writeFileSync(brokenConfig, "{invalid-json");
  const brokenManager = new PermissionManager({ globalConfigPath: configPath, projectGlobalConfigPath: brokenConfig, agentsDir: brokenAgents, mcpServerNames: [] });
  assert(brokenManager.getConfigIssues("broken").length > 0);
  const brokenResolver = new PermissionResolver(brokenManager, { getRuleset: () => [] });
  const p = await BashProgram.parse("git --no-lazy-fetch log -5 --oneline", normalizer);
  assert.notEqual(resolveBashCommandCheck(p.commandText(), p.commands(), "broken", brokenResolver).state, "allow");
  const brokenFixed = { command: "bash -n syntax.sh" }; await hardenGitInput(brokenFixed);
  const brokenFixedProgram = await BashProgram.parse(brokenFixed.command, normalizer, { originalCommands: originalGitCommands(brokenFixed) });
  assert.notEqual(resolveBashCommandCheck(brokenFixedProgram.commandText(), brokenFixedProgram.commands(), "broken", brokenResolver).state, "allow");
  // Yolo turns asks into allows, never the floor's clamped allows.
  const yoloBroken = new PermissionResolver(new PermissionManager({ globalConfigPath: configPath, projectGlobalConfigPath: brokenConfig,
    agentsDir: brokenAgents, mcpServerNames: [], isYoloEnabled: () => true }), { getRuleset: () => [] });
  // `cat *` is a fixture-only reader allowance; invalid project scope clamps it to ask.
  const clamped = await BashProgram.parse("cat ordinary.txt", normalizer);
  assert.equal(resolveBashCommandCheck(clamped.commandText(), clamped.commands(), "broken", brokenResolver).origin, "fail-closed",
    "the fixture really is a floored allow");
  const floored = resolveBashCommandCheck(clamped.commandText(), clamped.commands(), "broken", yoloBroken);
  assert.equal(floored.state, "ask", "yolo keeps the fail-closed floor");
  assert.equal(floored.origin, "fail-closed");
  const { resolveYoloGrant } = await load("handlers/gates/helpers");
  assert.equal(resolveYoloGrant(floored, true), null, "the post-resolution yolo grant keeps the floor too");
  assert.equal(resolveYoloGrant({ ...floored, origin: "builtin" }, true)?.state, "allow", "an ordinary ask is still granted");
  const plainAsk = await BashProgram.parse("printenv HOME", normalizer);
  const yoloValid = new PermissionResolver(new PermissionManager({ globalConfigPath: configPath, agentsDir: join(agentDir, "agents"),
    mcpServerNames: [], isYoloEnabled: () => true }), { getRuleset: () => [] });
  assert.equal(resolveBashCommandCheck(plainAsk.commandText(), plainAsk.commands(), undefined, yoloValid).state, "allow",
    "with a valid config, yolo still allows an ordinary ask");
  console.log(`PASS: patched 32.0.3 real parser/gates, ${positive.length} positive/${negative.length} negative forms x root + 3 workers; historical secrets, external scope, writes, wrappers, config drift`);

  // Drop the fake secret from HEAD as well, so the full positive matrix (not
  // only narrow diffs) reaches the actual SDK gates below. Untracked .env stays
  // for the secret-read negatives.
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "remove fake secret");
  assert.equal((await check(`${diff} HEAD~1 HEAD`)).path.preCheck.state, "deny", "Historical-only secret still contributes scope");
  assert.equal((await check(`${diff} HEAD~1 HEAD --no-renames -- src/code.ts`)).path, null);
  for (const flags of ["--unified=0", "--stat --unified=1"]) {
    const historical = { command: `git diff ${flags} HEAD~1 HEAD` };
    assert(await hardenGitInput(historical));
    assert.equal((await check(historical.command)).path.preCheck.state, "deny", "Long context options cannot omit historical-only protected content");
  }
  symlinkSync("ordinary.txt", join(cwd, "doc-link")); git("add", "doc-link");
  assert.equal((await check(diff)).path, null, "Tracked documentation symlinks do not disable the entire proof");

  // A real promisor repository with missing objects. Its remote helper is a
  // local canary that cannot contact a network. First prove the fixture would
  // fetch without the flag, then exercise both execution and pre-gate probes.
  const partial = join(scratch, "partial"); mkdirSync(partial);
  const helperDir = join(scratch, "helpers"); mkdirSync(helperDir);
  const canary = join(scratch, "lazy-fetch-invoked");
  writeFileSync(join(helperDir, "git-remote-picanary"), '#!/bin/sh\nprintf invoked > "$PI_GIT_FETCH_CANARY"\nexit 1\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${helperDir}:${previousPath}`;
  process.env.PI_GIT_FETCH_CANARY = canary;
  const pg = (...args) => execFileSync("git", args, { cwd: partial, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  pg("init", "-q"); writeFileSync(join(partial, "ordinary.txt"), "old\n");
  pg("add", "."); pg("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "promisor fixture");
  const missingBlob = pg("rev-parse", "HEAD:ordinary.txt").trim();
  const missingTree = pg("rev-parse", "HEAD^{tree}").trim();
  pg("config", "remote.fixture.url", "picanary::fixture");
  pg("config", "remote.fixture.promisor", "true");
  pg("config", "remote.fixture.partialclonefilter", "blob:none");
  writeFileSync(join(partial, "ordinary.txt"), "changed\n");
  rmSync(join(partial, ".git/objects", missingBlob.slice(0, 2), missingBlob.slice(2)));
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];
  const unsafeFetch = spawnSync("git", diffArgs, { cwd: partial, timeout: 5000, encoding: "utf8" });
  assert.notEqual(unsafeFetch.status, 0);
  assert(existsSync(canary), "Fixture must demonstrate Git's implicit remote-helper invocation");
  rmSync(canary);
  const partialNormalizer = new PathNormalizer(posixPathFlavor, partial);
  assert((await BashProgram.parse(diff, partialNormalizer)).commands()[0].managedReadOnly, "Missing blobs do not require reading their contents during proof");
  const hardened = { command: "git diff" };
  assert(await hardenGitInput(hardened));
  assert.deepEqual(originalGitCommands(hardened), ["git diff"]);
  assert.equal(await hardenGitInput(hardened), undefined, "Hardening is idempotent");
  const noFetch = spawnSync("bash", ["-c", hardened.command], { cwd: partial, timeout: 5000, encoding: "utf8" });
  assert.notEqual(noFetch.status, 0, "Missing object fails locally, not by fetching it");
  assert(!existsSync(canary), "Proven command must not invoke a remote helper");
  rmSync(join(partial, ".git/objects", missingTree.slice(0, 2), missingTree.slice(2)));
  assert(!(await BashProgram.parse(diff, partialNormalizer)).commands().some(command => command.managedReadOnly));
  assert(!existsSync(canary), "Pre-gate filename probes must never lazy-fetch missing trees");
  process.env.PATH = previousPath;
  delete process.env.PI_GIT_FETCH_CANARY;
  console.log("PASS: real partial-clone missing blob/tree canary; proof and execution never lazy-fetch");
  const localCd = join(cwd, "nested"), cdBase = join(scratch, "cdpath"), outsideCd = join(cdBase, "nested");
  mkdirSync(localCd); mkdirSync(outsideCd, { recursive: true });
  for (const path of [localCd, outsideCd]) execFileSync("git", ["init", "-q"], { cwd: path });
  const cdInput = { command: "cd nested && git rev-parse --show-toplevel" };
  const rawCd = spawnSync("bash", ["-c", cdInput.command], { cwd, encoding: "utf8", env: { ...process.env, CDPATH: cdBase } });
  assert(rawCd.stdout.trim().endsWith(outsideCd), "Fixture must demonstrate CDPATH relocation");
  assert(await hardenGitInput(cdInput));
  assert(cdInput.command.startsWith("cd ./nested && "));
  const safeCd = spawnSync("bash", ["-c", cdInput.command], { cwd, encoding: "utf8", env: { ...process.env, CDPATH: cdBase } });
  assert.equal(safeCd.status, 0); assert.equal(safeCd.stdout.trim(), localCd);
  const implicitPath = { command: "git log --oneline src/code.ts" };
  assert(await hardenGitInput(implicitPath)); assert(implicitPath.command.endsWith(" --"));
  assert.notEqual(spawnSync("bash", ["-c", implicitPath.command], { cwd, encoding: "utf8" }).status, 0, "Log cannot reinterpret a revision operand as an implicit file path");
  console.log("PASS: real CDPATH canary and forced Git revision interpretation");

  const fixedBin = join(scratch, "fixed-bin"); mkdirSync(fixedBin);
  const targetCanary = join(scratch, "command-target-ran");
  writeFileSync(join(fixedBin, "pi"), '#!/bin/sh\nprintf ran > "$PI_TARGET_CANARY"\n', { mode: 0o755 });
  const commandProbe = { command: "command -v pi" }; await hardenGitInput(commandProbe);
  const commandOutput = spawnSync("bash", ["-c", commandProbe.command], { cwd, encoding: "utf8", env: { ...process.env, PATH: `${fixedBin}:${process.env.PATH}`, PI_TARGET_CANARY: targetCanary } });
  assert.equal(commandOutput.status, 0); assert.equal(commandOutput.stdout.trim(), join(fixedBin, "pi"));
  assert(!existsSync(targetCanary), "command lookup must not execute its target");

  const bashEnvCanary = join(scratch, "bash-env-ran"), bashSourceCanary = join(scratch, "bash-source-ran");
  const bashEnv = join(scratch, "bash-env.sh");
  writeFileSync(bashEnv, 'printf startup > "$BASH_ENV_CANARY"\n');
  const syntaxProbe = { command: "bash -n syntax.sh" }; await hardenGitInput(syntaxProbe);
  assert.match(syntaxProbe.command, /^bash --noprofile --norc -p -n -- /);
  // Invoke the hardened child directly: an outer `bash -c` would itself read
  // BASH_ENV before it could launch the child and would test the harness shell,
  // not the syntax-check Bash this normalization hardens.
  const syntaxEnv = {
    ...process.env, BASH_ENV: bashEnv, BASH_ENV_CANARY: bashEnvCanary, BASH_SOURCE_CANARY: bashSourceCanary,
    SHELLOPTS: "braceexpand:extglob:hashall:interactive-comments", BASHOPTS: "checkwinsize:cmdhist:complete_fullquote:extquote:force_fignore:globasciiranges:globskipdots:hostcomplete:interactive_comments:patsub_replacement:progcomp:promptvars:sourcepath",
    "BASH_FUNC_fixture_imported%%": "() { :; }",
  };
  const syntaxResult = spawnSync("bash", ["--noprofile", "--norc", "-p", "-n", "--", "syntax.sh"], { cwd, encoding: "utf8", env: syntaxEnv });
  assert.equal(syntaxResult.status, 0, syntaxResult.stderr);
  assert(!existsSync(bashEnvCanary), "Privileged syntax Bash must ignore BASH_ENV");
  assert(!existsSync(bashSourceCanary), "Syntax checking must not execute the source file");
  assert.notEqual(spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", "type fixture_imported"], { cwd, encoding: "utf8", env: syntaxEnv }).status, 0,
    "Privileged Bash must ignore imported functions");
  assert.notEqual(spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", "shopt -q extglob"], { cwd, encoding: "utf8", env: syntaxEnv }).status, 0,
    "Privileged Bash must ignore startup option variables");

  const environment = { ...process.env, PI_MODEL: "fixture-model", PI_MODEL_ID: "fixture-id", PI_PROVIDER: "fixture-provider",
    BUILD_DIR: "fixture-build", AOBUS_BUILD_ROOT: "fixture-root", SECRET_FIXTURE: "must-not-leak" };
  for (const [requested, expected] of [
    ["env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER", ["fixture-model", "fixture-id", "fixture-provider"]],
    ["printenv BUILD_DIR AOBUS_BUILD_ROOT", ["fixture-build", "fixture-root"]],
  ]) {
    const input = { command: requested }; await hardenGitInput(input);
    const output = spawnSync("bash", ["-c", input.command], { cwd, encoding: "utf8", env: environment });
    assert.equal(output.status, 0); assert.deepEqual(output.stdout.trim().split("\n"), expected);
    assert(!output.stdout.includes("must-not-leak"), "Fixed printenv must not disclose other variables");
  }
  console.log("PASS: actual fixed-query target, BASH_ENV/source, and bounded environment canaries");

  // Execute only fabricated inputs. Multi-range sed keeps disjoint ranges AND
  // overlapping duplicate prints; recognizing a long Git flag preserves output.
  writeFileSync(join(cwd, "ranges.txt"), "one\ntwo\nthree\nfour\nfive\n");
  for (const [program, expected] of [["1p;3,4p", "one\nthree\nfour\n"], ["1,3p;2,4p", "one\ntwo\ntwo\nthree\nthree\nfour\n"], ["4p;1,2p", "one\ntwo\nfour\n"]]) {
    const command = `sed -n '${program}' ranges.txt`;
    assert.equal((await check(command)).bash.state, "allow");
    const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0); assert.equal(result.stdout, expected);
  }
  for (const count of [0, 3, 80]) {
    const long = { command: `git diff --unified=${count} -- ordinary.txt` };
    const short = { command: `git diff -U${count} -- ordinary.txt` };
    assert(await hardenGitInput(long)); assert(await hardenGitInput(short));
    assert(long.command.includes(`--unified=${count}`), "Keep the user's long spelling");
    const a = spawnSync("bash", ["-c", long.command], { cwd, encoding: "utf8" });
    const b = spawnSync("bash", ["-c", short.command], { cwd, encoding: "utf8" });
    assert.equal(a.status, 0); assert.equal(a.status, b.status); assert.equal(a.stdout, b.stdout);
  }
  for (const agent of [undefined, "editor", "reader"]) {
    for (const path of [".env", "alias.txt"])
      assert.equal((await check(`sed -n '1p;2,4p' ${path}`, agent)).path.preCheck.state, "deny");
    assert.equal((await check("sed -n '1p;2,4p' /var/lib/pi-fixture/external.txt", agent)).external.preCheck.state, "ask");
  }
  console.log("PASS: long Git context flags retain content scope; multi-range sed preserves actual output and path gates");

  // Actual generated portable wrapper + root/child permissions service and
  // normal forwarding. The named model-authorizer spy counts entry to the
  // real ask chain; static positives must never reach it or a UI at all.
  const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(join(piRoot, "dist/index.js"));
  const { loadExtensions } = await import(join(piRoot, "dist/core/extensions/loader.js"));
  const { AuthStorage } = await import(join(piRoot, "dist/core/auth-storage.js"));
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  let uiCalls = 0, modelCalls = 0, grantWhole = false;
  const errors = [];
  const { getPermissionsService } = await load("service");
  const make = async (agent, parent, duplicate, suppliedSessionManager, guardFirst = false) => {
    const eventBus = createEventBus();
    const settingsManager = SettingsManager.inMemory();
    const extensions = (guardFirst
      ? ["static-safety-guard.ts", "managed-permissions/index.ts", "policy-grep.ts"]
      : ["managed-permissions/index.ts", "static-safety-guard.ts", "policy-grep.ts"]).map(name => join(agentDir, "extensions", name));
    const unpatched = join(dirname(publicServicePath), "index.ts");
    if (duplicate === "before") extensions.unshift(unpatched);
    if (duplicate === "after") extensions.push(unpatched);
    const loaded = await loadExtensions(extensions, cwd, eventBus);
    assert.deepEqual(loaded.errors, [], "Actual managed extension loads");
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus, extensionsOverride: () => loaded,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sm = suppliedSessionManager ?? SessionManager.inMemory(cwd);
    if (agent) sm.appendCustomEntry("active_agent", { name: agent });
    const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, sessionManager: sm, modelRuntime: runtime });
    const id = sm.getSessionId();
    if (parent) parent.eventBus.emit("subagents:child:session-created", { sessionId: id, parentSessionId: parent.id });
    const ui = { setStatus() {}, notify() {}, setWidget() {}, setTitle() {},
      select: async (_title, choices) => {
        uiCalls++;
        if (!grantWhole) return undefined;
        return choices[1]; // session grant, then whole-session scope
      }, input: async () => undefined, confirm: async () => false };
    await session.bindExtensions({ mode: "rpc", ...(parent ? {} : { uiContext: ui }), onError: error => errors.push(error) });
    const service = getPermissionsService(id); assert(service, `Managed service: ${agent}; errors=${JSON.stringify(errors)}`);
    assert.equal(publicService.getPermissionsService(id), service, "Unpatched public service import reaches the managed authority through shared symbols");
    if (!parent) service.registerAuthorizer("auto-model-judge", async () => { modelCalls++; return { kind: "defer" }; });
    // Pi 0.87.1 takes BuildSystemPromptOptions as the third argument; `cwd` is
    // required and the active-agent tag must land inside the rendered prompt,
    // because the permission system reads it back out of that text.
    await session.extensionRunner.emitBeforeAgentStart("Fixture inspection", undefined,
      { cwd, ...(agent ? { appendSystemPrompt: `<active_agent name="${agent}"/>` } : {}) });
    const record = { session, id, eventBus, parent,
      call: (toolName, input) => session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: `actual-${Math.random()}`, toolName, input }),
      callAs: (toolCallId, toolName, input) => session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId, toolName, input }),
      result: event => session.extensionRunner.emitToolResult({ type: "tool_result", ...event }),
    };
    sessions.push(record); return record;
  };
  const root = await make();
  // Home Manager's SOPS symlink and its real runtime generations are explicit
  // path denies, not merely external-directory asks. Only fake data is created.
  const fakeSecrets = join(scratch, ".config/sops-nix/secrets");
  mkdirSync(fakeSecrets, { recursive: true });
  writeFileSync(join(fakeSecrets, "token"), "SYNTHETIC_ONLY\n");
  writeFileSync(join(cwd, "secrets.yaml"), "ENC[synthetic fixture]\n");
  symlinkSync(join(fakeSecrets, "token"), join(cwd, "runtime-secret-alias.txt"));
  const runtimeSecrets = ["~/.config/sops-nix/secrets", "~/.config/sops-nix/secrets/token", "runtime-secret-alias.txt",
    "/run/secrets", "/run/secrets/__pi_fixture_only__/token", "/run/secrets/__pi_fixture_only__/.env.example", "/run/secrets.d", "/run/secrets.d/__pi_fixture_only__/token",
    "/run/user/12345678/secrets", "/run/user/12345678/secrets/token", "/run/user/12345678/secrets.d", "/run/user/12345678/secrets.d/1/token"];
  const nativeReads = [
    "git diff", "git diff --stat", "git diff --check", "git diff --cached --name-only", "git diff -- src", "git diff -- .", "git diff HEAD -- ordinary.txt",
    "git status --short && git diff --stat && git log -5 --oneline",
    "git --no-pager diff -- ordinary.txt | head -20", "git -C . diff --check",
    "cd . && git diff --stat | tail -5", "git diff -- ordinary.txt | sed -n '1,20p'",
    "git log --oneline HEAD~5..HEAD", "nl -ba ordinary.txt | sed -n '1,20p'",
    "git diff HEAD~1 HEAD -- ordinary.txt", "git rev-parse --verify main", "git branch -vv && git remote",
    "git diff --no-renames --name-only --diff-filter=U",
    "git diff --no-renames --cached --diff-filter=R --name-status",
    "echo 'fixture' && git diff --check", "git status --short && cat ordinary.txt",
    "git diff --stat; git status --short; cat ordinary.txt",
  ];
  for (const agent of [undefined, "editor", "reader"]) {
    const node = agent ? await make(agent, root) : root;
    for (const command of [...positive, ...fixedRequested, ...weeklyRequested, ...nativeReads]) {
      assert.equal((await node.call("bash", { command }))?.block, undefined, `Actual gate allows ${agent}: ${command}`);
    }
    assert.equal((await node.call("read", { path: "ordinary.txt" }))?.block, undefined);
    assert.equal((await node.call("read", { path: "secrets.yaml" }))?.block, undefined, "Encrypted repository files are not runtime secrets");
    assert.equal((await node.call("read", { path: "/proc/meminfo" }))?.block, undefined);
    assert.equal((await node.call("read", { path: "/proc/self/mountinfo" }))?.block, undefined);
    for (const path of runtimeSecrets) {
      assert.equal((await node.call("read", { path }))?.block, true, `SOPS read: ${agent} ${path}`);
      assert.equal((await node.call("write", { path, content: "fixture" }))?.block, true, `SOPS write: ${agent} ${path}`);
      assert.equal((await node.call("bash", { command: `cat ${path}` }))?.block, true, `SOPS Bash: ${agent} ${path}`);
    }
    for (const tool of ["edit", "write"]) {
      if (!agent || agent === "editor") assert.equal((await node.call(tool, { path: "src/new-file.ts", content: "fixture", edits: [] }))?.block, undefined, "Editing profile inherits project path scope");
      else assert.equal((await node.call(tool, { path: "src/new-file.ts", content: "fixture", edits: [] }))?.block, true, "Read-only profiles cannot edit");
      assert.equal((await node.call(tool, { path: join(scratch, "unregistered-tmp.txt"), content: "fixture", edits: [] }))?.block,
        !agent || agent === "editor" ? undefined : true, "Direct editing inherits existing /tmp scope without scratch-creation proof");
      for (const path of [".env", ".git/config", "~/.pi/agent/settings.json", "alias.txt"])
        assert.equal((await node.call(tool, { path, content: "fixture", edits: [] }))?.block, true, `Protected write: ${agent} ${path}`);
    }
    assert.equal((await node.call("read", { path: ".env" }))?.block, true, "Actual secret read denial");
    assert.equal((await node.call("bash", { command: "cut -f 1 .env" }))?.block, true, "Actual reader secret denial");
    assert.equal((await node.call("bash", { command: "sudo true" }))?.block, true, "Actual privilege denial");
    assert.equal(uiCalls, 0, "Static normal operations never prompt UI");
    assert.equal(modelCalls, 0, "Static normal operations never enter a model authorizer");
  }
  // Exercise actual agent-core argument validation, preflight and execution
  // dispatch, with a recording Bash implementation and an in-memory response.
  // No provider/model API and no historical/shell command is executed here.
  const { runAgentLoop } = await import(join(dirname(require.resolve("@earendil-works/pi-agent-core/package.json")), "dist/agent-loop.js"));
  const executed = [];
  let providerCalls = 0, finishedTurns = 0;
  const bashTool = root.session.agent.state.tools.find(tool => tool.name === "bash");
  const readTool = root.session.agent.state.tools.find(tool => tool.name === "read");
  const assistant = { role: "assistant", content: [
    { type: "toolCall", id: "native-read", name: "bash", arguments: { command: "git diff --stat" } },
    ...[...fixedRequested, ...weeklyRequested].map((command, index) => ({ type: "toolCall", id: `fixed-${index}`, name: "bash", arguments: { command } })),
    { type: "toolCall", id: "secret-read", name: "bash", arguments: { command: "cat .env" } },
    { type: "toolCall", id: "proc-meminfo", name: "read", arguments: { path: "/proc/meminfo" } },
    { type: "toolCall", id: "proc-mountinfo", name: "read", arguments: { path: "/proc/self/mountinfo" } },
  ], stopReason: "toolUse", timestamp: Date.now() };
  await runAgentLoop([{ role: "user", content: "Fixture", timestamp: Date.now() }], {
    systemPrompt: "Fixture", messages: [], tools: [{ ...bashTool, execute: async (_id, args) => {
      executed.push({ tool: "bash", input: structuredClone(args) }); return { content: [{ type: "text", text: "recorded" }] };
    } }, { ...readTool, execute: async (_id, args) => {
      executed.push({ tool: "read", input: structuredClone(args) }); return { content: [{ type: "text", text: "recorded" }], details: undefined };
    } }],
  }, { model: { provider: "fixture", id: "fixture" }, convertToLlm: messages => messages,
    beforeToolCall: ({ toolCall, args }) => root.call(toolCall.name, args),
    finishTurn: () => { finishedTurns++; return { action: "end" }; },
  }, async () => {}, undefined, () => {
    assert.equal(++providerCalls, 1, "finishTurn must end after the fixture tool batch, not request another response");
    return { async *[Symbol.asyncIterator]() { yield { type: "done" }; }, result: async () => assistant };
  });
  assert.equal(providerCalls, 1); assert.equal(finishedTurns, 1);
  assert.equal(executed.length, 1 + fixedRequested.length + weeklyRequested.length + 2, "Denied Bash/read calls never reach execute");
  const executedBash = executed.filter(item => item.tool === "bash").map(item => item.input.command);
  const executedRead = executed.filter(item => item.tool === "read").map(item => item.input.path).sort();
  const gitExecution = executedBash.find(command => command.startsWith("git "));
  assert.match(gitExecution, /^git --no-lazy-fetch --no-optional-locks --no-pager diff /);
  assert(gitExecution.includes("--no-ext-diff --no-textconv --submodule=short"));
  assert(!gitExecution.includes("--ignore-submodules="), "No automatic suppression of gitlink or dirty-state changes");
  assert(executedBash.includes("type -P -- pi"));
  assert(executedBash.includes("bash --noprofile --norc -p -n -- syntax.sh"));
  assert(executedBash.includes("printenv -- PI_MODEL PI_MODEL_ID PI_PROVIDER"));
  assert(executedBash.includes("printenv -- BUILD_DIR AOBUS_BUILD_ROOT"));
  assert(executedBash.some(command => command.includes("--unified=80 -- ordinary.txt") && command.startsWith("git --no-lazy-fetch ")));
  assert(executedBash.includes("sed -n '1p;2,4p' ordinary.txt"), "Sed executes unchanged");
  assert.deepEqual(executedRead, ["/proc/meminfo", "/proc/self/mountinfo"]);
  assert.equal(uiCalls, 0); assert.equal(modelCalls, 0);
  console.log("PASS: real agent-core dispatch executes only SDK-preflighted hardened fixed queries and exact proc reads; no model API");

  // Start with a child's ask, approve explicitly for the whole task tree, then
  // siblings and a steering event reuse the upstream grant without new prompts.
  grantWhole = true;
  const first = sessions[1];
  assert.equal((await first.call("bash", { command: "sleep 7" }))?.block, undefined);
  assert.equal(uiCalls, 2, "Exactly decision + whole-session scope selectors");
  const approvedModelCalls = modelCalls;
  for (const node of sessions) {
    await node.session.extensionRunner.emitInput("Continue the same authorized fixture task", undefined, "interactive", "steer");
    assert.equal((await node.call("bash", { command: "sleep 7" }))?.block, undefined, "Sibling/steer reuses explicit grant");
  }
  assert.equal(uiCalls, 2); assert.equal(modelCalls, approvedModelCalls);
  grantWhole = false;
  for (const command of ["printenv HOME", "printenv", "ruff check syntax.sh", "ruff format --check syntax.sh"]) {
    const before = uiCalls;
    assert.equal((await root.call("bash", { command }))?.block, true, `Deferred query remains review: ${command}`);
    assert.equal(uiCalls, before + 1, `Deferred query is an ask, not a new deny: ${command}`);
  }
  assert.equal((await sessions[2].call("bash", { command: "ruff check --fix syntax.sh" }))?.block, true, "reader cannot gain Ruff write capability");
  for (const path of ["/proc/1/environ", "/proc/self/environ", "/proc/self/fd", `/proc/${process.pid}/mountinfo`])
    assert.equal((await root.call("read", { path }))?.block, true, `Actual SDK retains review for ${path}`);
  for (const command of ["cat .env", "echo fixture > ~/.pi/agent/settings.json", "git diff --stat --output=ordinary.txt", "git -c core.pager=cat status --short", "PATH=./fixture-bin git status --short", "readlink $INPUT", "git show HEAD:.env", "git status --short && touch ordinary.txt", "git remote -v", "git diff -- 'ordinary.txt '", "git diff HEAD...main", "sed -n '1p; e touch ordinary.txt' ordinary.txt", "sed -i 's/a/b/' ordinary.txt", "cd missing || git diff", "cd missing; git diff", "cd . | git diff", "cd - && git status --short", "cd -- && git status --short", "df --sync .", "free --unknown"]) {
    assert.equal((await root.call("bash", { command }))?.block, true, `Actual gate blocks/asks ${command}`);
  }
  for (const node of sessions.slice(1)) {
    assert.equal((await node.call("bash", { command: "echo fixture > ordinary.txt" }))?.block, node === sessions[1] ? undefined : true, "Editing profile inherits path scope; read-only workers still ask");
    if (node === sessions[1]) assert.equal((await node.call("write", { path: "/var/lib/pi-fixture/external.txt", content: "fixture" }))?.block, true, "Editing capability cannot authorize external writes");
    assert.equal((await node.call("read", { path: "/var/lib/pi-fixture/external.txt" }))?.block, true, "Actual external scope still requires approval");
  }
  assert.deepEqual(errors, [], "Actual SDK lifecycle has no extension errors");
  console.log("PASS: actual portable wrapper + SDK root/3 child gates; zero UI/model entries for proven reads; upstream explicit whole-session grant survives siblings and steer");

  const observeMktemp = async (node, label) => {
    const input = { command: "mktemp -d" };
    const toolCallId = `mktemp-${label}`;
    assert.equal((await node.callAs(toolCallId, "bash", input))?.block, undefined);
    const output = execFileSync("mktemp", ["-d"], { encoding: "utf8" });
    externalScratch.push(output.trim());
    await node.result({ toolCallId, toolName: "bash", input, content: [{ type: "text", text: output }], details: undefined, isError: false });
    return output.trim();
  };

  // A root exists only after the SDK's exact mktemp call/result pair. The
  // resulting mkdir/cp program is hardened in-place, then all ordinary Bash,
  // READ, WRITE and external-directory gates still run.
  const liveRoot = await observeMktemp(root, "current");
  writeFileSync(join(cwd, "copy-a.txt"), "alpha\n");
  writeFileSync(join(cwd, "copy-b.txt"), "beta\n");
  const fileUiBefore = uiCalls;
  const fileInput = { command: `mkdir -p ${liveRoot}/out && cp copy-a.txt copy-b.txt ${liveRoot}/out` };
  assert.equal((await root.callAs("file-effects-current", "bash", fileInput))?.block, undefined);
  assert.match(fileInput.command, /^mkdir -p -- \/tmp\/tmp\.[A-Za-z0-9]+\/out && cp --no-dereference --target-directory=/);
  assert(fileInput.command.includes(`${liveRoot}/out -- ${join(cwd, "copy-a.txt")} ${join(cwd, "copy-b.txt")}`));
  assert.equal(uiCalls, fileUiBefore, "Observed scratch mkdir/cp must require zero UI");
  const executedFiles = spawnSync("bash", ["-c", fileInput.command], { cwd, encoding: "utf8" });
  assert.equal(executedFiles.status, 0, executedFiles.stderr);
  assert.equal(readFileSync(join(liveRoot, "out/copy-a.txt"), "utf8"), "alpha\n");
  assert.equal(readFileSync(join(liveRoot, "out/copy-b.txt"), "utf8"), "beta\n");
  assert.equal((await root.callAs("file-effects-reused-input", "bash", fileInput))?.block, true, "A reused input object cannot retain a stale no-overwrite proof");
  const freshInput = { command: `mkdir -p ${liveRoot}/cross-session` };
  assert.equal((await root.callAs("file-effects-fresh-input", "bash", freshInput))?.block, undefined);
  const stranger = await make();
  assert.equal((await stranger.callAs("file-effects-cross-session-input", "bash", freshInput))?.block, true, "Input identity alone cannot carry a proof to another session");

  // Both real hook orders must accept a proven leading cd, not merely block
  // it first on another path rule. Execute only these fabricated scratch plans.
  writeFileSync(join(localCd, "cd-copy.txt"), "checked local source\n");
  writeFileSync(join(outsideCd, "cd-copy.txt"), "wrong CDPATH source\n");
  for (const guardFirst of [false, true]) {
    for (const agent of [undefined, "editor"]) {
      const node = await make(agent, agent ? root : undefined, undefined, undefined, guardFirst);
      const target = await observeMktemp(node, `cd-${agent ?? "root"}-${guardFirst}`);
      const input = { command: `cd nested && mkdir -p ${target}/out && cp cd-copy.txt ${target}/out/copied.txt` };
      const before = { ui: uiCalls, model: modelCalls };
      assert.equal((await node.call("bash", input))?.block, undefined, `Positive scratch cd: guardFirst=${guardFirst}, agent=${agent}`);
      assert(input.command.startsWith(`cd ${localCd} && `), "Absolute cd needs no option delimiter");
      assert.deepEqual({ ui: uiCalls, model: modelCalls }, before, "Leading cd must not enter approval");
      const execution = spawnSync("bash", ["-c", input.command], { cwd, encoding: "utf8", env: { ...process.env, CDPATH: cdBase } });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(readFileSync(join(target, "out/copied.txt"), "utf8"), "checked local source\n");
    }
  }
  console.log("PASS: positive scratch cd under both extension orders, root/editing worker, and actual CDPATH-safe execution");

  const secretCopy = { command: `cp .env ${liveRoot}/secret-copy` };
  assert.equal((await root.callAs("file-effects-secret", "bash", secretCopy))?.block, true, "Sensitive source still reaches READ deny");
  assert.match(secretCopy.command, /^cp --no-dereference --no-target-directory -- /, "Sensitive source was analyzed, not skipped");

  const readOnly = sessions[2];
  const readOnlyRoot = await observeMktemp(readOnly, "readonly");
  const readOnlyInput = { command: `mkdir -p ${readOnlyRoot}/blocked` };
  assert.equal((await readOnly.callAs("file-effects-readonly", "bash", readOnlyInput))?.block, true, "Readonly worker path_write ask remains in force");
  assert.notEqual(readOnlyInput.command, `mkdir -p ${readOnlyRoot}/blocked`, "Readonly denial happens after exact effect proof");

  symlinkSync("copy-a.txt", join(cwd, "copy-link.txt"));
  writeFileSync(join(cwd, "hard-a.txt"), "hard\n");
  linkSync(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  execFileSync("mkfifo", [join(cwd, "copy.fifo")]);
  for (const [label, source] of [["symlink", "copy-link.txt"], ["hardlink", "hard-a.txt"], ["fifo", "copy.fifo"]]) {
    const input = { command: `cp ${source} ${liveRoot}/${label}` };
    assert.equal((await root.callAs(`file-effects-${label}`, "bash", input))?.block, true);
    assert.equal(input.command, `cp ${source} ${liveRoot}/${label}`, `${label} source must not receive proof`);
  }
  writeFileSync(join(cwd, "copy-a.txt "), "space-suffixed fixture\n");
  const unsupported = [
    `cp 'copy-a.txt ' ${liveRoot}/trimmed`, `cp 'file:/../copy-a.txt' ${liveRoot}/uri-alias`,
    `mkdir -p '${liveRoot}/space /'`,
    `cp copy-a.txt/ ${liveRoot}/source-slash`, `cp copy-a.txt ${liveRoot}/destination-slash/`,
    `cp copy-a.txt/. ${liveRoot}/source-dot`, `mkdir -p ${liveRoot}//repeated`,
    `mkdir ${liveRoot}/plain`, `mkdir -p ${liveRoot}/x; cp copy-a.txt ${liveRoot}/x/a`,
    `cp -f copy-a.txt ${liveRoot}/forced`, `cp copy-a.txt ${liveRoot}/redirected > ${liveRoot}/log`,
    `mv copy-a.txt ${liveRoot}/moved`, `chmod 700 ${liveRoot}`,
  ];
  for (const [index, command] of unsupported.entries()) {
    const input = { command };
    assert.equal((await root.callAs(`file-effects-unsupported-${index}`, "bash", input))?.block, true);
    assert.equal(input.command, command, `Unsupported syntax cannot acquire file-effect proof: ${command}`);
  }

  const fakeMessageSession = SessionManager.inMemory(cwd);
  fakeMessageSession.appendCustomMessageEntry("managed-scratch-created", JSON.stringify({ path: liveRoot }), false);
  const unproven = await make(undefined, undefined, undefined, fakeMessageSession);
  const forged = { command: `mkdir -p ${liveRoot}/forged`, newScope: { command: `mkdir -p ${liveRoot}/forged` } };
  assert.equal((await unproven.callAs("file-effects-forged", "bash", forged))?.block, true);
  assert.equal(forged.command, `mkdir -p ${liveRoot}/forged`, "Model-supplied newScope is inert");
  const messageForgery = { command: `mkdir -p ${liveRoot}/message-forged` };
  assert.equal((await unproven.callAs("file-effects-message", "bash", messageForgery))?.block, true);
  assert.equal(messageForgery.command, `mkdir -p ${liveRoot}/message-forged`);

  // Persisted parent inheritance is accepted only under the standard,
  // owner-controlled sessions tree and after the real resolver denies writes.
  // Pi normally creates session subdirectories as 0755: confidentiality comes
  // from the private ancestors; authenticity requires no other-writer bits.
  const standardSessions = join(scratch, ".pi/agent/sessions");
  for (const path of [join(scratch, ".pi"), join(scratch, ".pi/agent"), standardSessions, join(standardSessions, "fixture")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }
  chmodSync(standardSessions, 0o755); chmodSync(join(standardSessions, "fixture"), 0o755);
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const parentStem = join(standardSessions, "fixture", `2026-01-01T00-00-00_${parentId}`);
  const parentFile = `${parentStem}.jsonl`;
  writeFileSync(parentFile, `${JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  const persistedParent = await make(undefined, undefined, undefined, SessionManager.open(parentFile));
  const inheritedRoot = await observeMktemp(persistedParent, "parent");
  // Real parent journals exceed 2 MiB. Read bounded complete records even while
  // an unrelated last record is being appended; never consume a partial record.
  const completeParentJournal = readFileSync(parentFile, "utf8") + JSON.stringify({ type: "fixture-padding", data: "x".repeat(3 * 1024 * 1024) }) + "\n";
  writeFileSync(parentFile, completeParentJournal + '{"in-flight":');
  mkdirSync(join(parentStem, "tasks"), { recursive: true, mode: 0o755 }); chmodSync(parentStem, 0o755); chmodSync(join(parentStem, "tasks"), 0o755);
  const childFile = join(parentStem, "tasks", `${childId}.jsonl`);
  writeFileSync(childFile, `${JSON.stringify({ type: "session", version: 3, id: childId, parentSession: parentId, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  const persistedChild = await make("editor", persistedParent, undefined, SessionManager.open(childFile));
  const inheritedInput = { command: `mkdir -p ${inheritedRoot}/child && cp copy-a.txt ${inheritedRoot}/child/a.txt` };
  const inheritedUiBefore = uiCalls;
  assert.equal((await persistedChild.callAs("file-effects-child", "bash", inheritedInput))?.block, undefined, "Exact protected parent journal is reusable");
  assert.match(inheritedInput.command, /^mkdir -p -- .* && cp --no-dereference --no-target-directory -- /);
  assert.equal(uiCalls, inheritedUiBefore);
  writeFileSync(parentFile, completeParentJournal);
  const laterRoot = await observeMktemp(persistedParent, "parent-after-child-start");
  assert.equal((await persistedChild.call("bash", { command: `mkdir -p ${laterRoot}/before-steer` }))?.block, true, "Unobserved later parent metadata is not guessed");
  await persistedChild.session.extensionRunner.emitInput("Continue with the parent's newly created scratch", undefined, "interactive", "steer");
  assert.equal((await persistedChild.call("bash", { command: `mkdir -p ${laterRoot}/after-steer` }))?.block, undefined, "Steer can refresh authenticated parent creation records");

  const unrelatedId = "33333333-3333-4333-8333-333333333333";
  const unrelatedFile = join(standardSessions, "fixture", `2026-01-01T00-00-01_${unrelatedId}.jsonl`);
  writeFileSync(unrelatedFile, `${JSON.stringify({ type: "session", version: 3, id: unrelatedId, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  const unrelated = await make(undefined, undefined, undefined, SessionManager.open(unrelatedFile));
  const crossSession = { command: `mkdir -p ${inheritedRoot}/unrelated` };
  assert.equal((await unrelated.callAs("file-effects-unrelated", "bash", crossSession))?.block, true);
  assert.equal(crossSession.command, `mkdir -p ${inheritedRoot}/unrelated`, "Unrelated session cannot claim another root");

  const creationEntry = readFileSync(parentFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.type === "custom" && entry.customType === "managed-scratch-created");
  assert(creationEntry, "Parent fixture contains an actual SDK-created provenance record");
  for (const [label, id] of [["unprotected", "44444444-4444-4444-8444-444444444444"], ["alias", "55555555-5555-4555-8555-555555555555"]]) {
    const fakeEntry = { ...creationEntry, data: { ...creationEntry.data, sessionId: id } };
    const journal = `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n${JSON.stringify(fakeEntry)}\n`;
    const target = label === "alias" ? join(standardSessions, "fixture", `${id}.jsonl`) : join(scratch, `${id}.jsonl`);
    writeFileSync(target, journal, { mode: 0o600 });
    let openPath = target;
    if (label === "alias") {
      const alias = join(scratch, "session-directory-alias");
      symlinkSync(dirname(target), alias, "dir"); openPath = join(alias, basename(target));
    }
    const fake = await make(undefined, undefined, undefined, SessionManager.open(openPath));
    const input = { command: `mkdir -p ${inheritedRoot}/${label}-claim` };
    assert.equal((await fake.callAs(`file-effects-${label}-journal`, "bash", input))?.block, true, `${label} journal cannot authenticate restored provenance`);
    assert.equal(input.command, `mkdir -p ${inheritedRoot}/${label}-claim`);
  }

  for (const [label, id] of [["child-name", "66666666-6666-4666-8666-666666666666"], ["parent-name", "77777777-7777-4777-8777-777777777777"]]) {
    let stem = parentStem;
    if (label === "parent-name") {
      stem = join(standardSessions, "fixture", "arbitrary-parent");
      writeFileSync(`${stem}.jsonl`, readFileSync(parentFile), { mode: 0o600 });
      mkdirSync(join(stem, "tasks"), { recursive: true, mode: 0o755 });
    }
    const file = join(stem, "tasks", `${label === "child-name" ? "arbitrary-child" : id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, parentSession: parentId, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
    const badTopology = await make("editor", persistedParent, undefined, SessionManager.open(file));
    const input = { command: `mkdir -p ${inheritedRoot}/${label}-claim` };
    assert.equal((await badTopology.callAs(`file-effects-${label}`, "bash", input))?.block, true);
    assert.equal(input.command, `mkdir -p ${inheritedRoot}/${label}-claim`, "Header UUIDs must match actual file topology");
  }

  renameSync(inheritedRoot, `${inheritedRoot}.old`); externalScratch.push(`${inheritedRoot}.old`);
  mkdirSync(inheritedRoot, { mode: 0o700 }); externalScratch.push(inheritedRoot);
  const replaced = { command: `mkdir -p ${inheritedRoot}/replaced` };
  assert.equal((await persistedChild.callAs("file-effects-replaced", "bash", replaced))?.block, true);
  assert.equal(replaced.command, `mkdir -p ${inheritedRoot}/replaced`, "Same path with a new inode invalidates provenance");
  console.log("PASS: process-observed mktemp provenance, protected parent journal, exact mkdir/cp effects, source/type/inode/profile negatives");

  // Real SDK, not a manually fabricated provenance flag: ORIGINAL explicit
  // exact/wildcard rules must survive the different normalized command text.
  const policyBefore = readFileSync(configPath, "utf8");
  try {
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.bash["git log -5 --oneline"] = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const explicit = await make();
      const before = uiCalls;
      assert.equal((await explicit.call("bash", { command: "git log -5 --oneline" }))?.block, true, `Original ${action} is not normalized away`);
      assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
    }
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.managed_static_read = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const disabled = await make();
      assert.equal((await disabled.call("bash", { command: "git diff --stat" }))?.block, true, "Dedicated opt-in can disable deterministic read grants");
      const before = uiCalls;
      assert.equal((await disabled.call("bash", { command: "git status --short && cat ordinary.txt" }))?.block, undefined, "Fixture-only reader allowances survive with new static grants disabled");
      assert.equal(uiCalls, before);
    }
    {
      const policy = JSON.parse(policyBefore);
      policy.permission.managed_static_file_effects = "ask";
      writeFileSync(configPath, JSON.stringify(policy));
      const disabled = await make();
      const root = await observeMktemp(disabled, "file-optout");
      const input = { command: `mkdir -p ${root}/disabled` };
      assert.equal((await disabled.callAs("file-optout", "bash", input))?.block, true);
      assert.match(input.command, /^mkdir -p -- /, "Opt-out disables only the grant, not exact effect extraction");
    }
    for (const [surface, pattern] of [["original", "mkdir -p *"], ["hardened", "mkdir -p -- *"]]) {
      for (const action of ["ask", "deny"]) {
        const policy = JSON.parse(policyBefore);
        policy.permission.bash[pattern] = action;
        writeFileSync(configPath, JSON.stringify(policy));
        const specific = await make();
        const root = await observeMktemp(specific, `${surface}-${action}`);
        const input = { command: `mkdir -p ${root}/specific` };
        const before = uiCalls;
        assert.equal((await specific.callAs(`file-${surface}-${action}`, "bash", input))?.block, true, `${surface} ${action} rule wins file-effect proof`);
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
    mkdirSync(join(cwd, "nested-alias"));
    writeFileSync(join(cwd, "nested-alias/copy-a.txt"), "nested alias fixture\n");
    for (const [pattern, prefix, source] of [["./copy-a.txt", "", "./copy-a.txt"], ["copy-a.txt", "cd nested-alias && ", "copy-a.txt"]]) {
      for (const action of ["ask", "deny"]) {
        const policy = JSON.parse(policyBefore);
        policy.permission.path_read = { ...policy.permission.path_read, [pattern]: action };
        writeFileSync(configPath, JSON.stringify(policy));
        const specific = await make();
        const root = await observeMktemp(specific, `source-alias-${action}-${prefix ? "cd" : "dot"}`);
        const input = { command: `${prefix}cp ${source} ${root}/alias-output` };
        const original = input.command;
        const before = uiCalls;
        assert.equal((await specific.call("bash", input))?.block, true, "Original source aliases retain exact READ rules");
        assert.notEqual(input.command, original, "Source alias rule is checked after effect proof");
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.path_write["/tmp/tmp.*/guarded"] = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const specific = await make();
      const root = await observeMktemp(specific, `directory-${action}`);
      mkdirSync(join(root, "guarded"));
      for (const command of [`cp copy-a.txt ${root}/guarded`, `cp copy-a.txt copy-b.txt ${root}/guarded`, `mkdir -p ${root}/guarded`]) {
        const input = { command };
        const before = uiCalls;
        assert.equal((await specific.call("bash", input))?.block, true, "Explicit directory WRITE rule survives derived targets and mkdir no-op");
        assert.notEqual(input.command, command, "Directory rule is checked after exact effects were proved");
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
  } finally { writeFileSync(configPath, policyBefore); }
  console.log("PASS: actual SDK original explicit asks/denies and opt-in disable survive normalization");

  for (const order of ["before", "after"]) {
    const duplicate = await make(undefined, undefined, order);
    const result = await duplicate.call("read", { path: "ordinary.txt" });
    assert.equal(result?.block, true, `Duplicate authority (${order}) must fail closed`);
    assert.match(result.reason, /authority is missing or duplicated/);
  }
  console.log("PASS: duplicate authority detected in either extension load order");

  // Session yolo from the approval indicator, through the actual patched
  // authority: a root's grant reaches its in-process child, never another
  // root, and it only turns asks into allows -- explicit denies still hold.
  const yoloKey = Symbol.for("@rocklee/managed-permissions:session-yolo");
  assert(readFileSync(join(repo, "extensions/lib/approval-protocol.ts"), "utf8")
    .includes('Symbol.for("@rocklee/managed-permissions:session-yolo")'), "Indicator and authority share the yolo key");
  const yoloChild = sessions.find(node => node.parent === root);
  assert(yoloChild, "a child of the root session exists");
  const otherRoot = await make();
  const yoloReader = await make("reader", root);
  const readerWriteNames = ["ordinary.txt", "ordinary.pem", "ordinary.key", "ordinary.p12", "ordinary.pfx"];
  for (const name of readerWriteNames.slice(1)) writeFileSync(join(cwd, name), "SYNTHETIC_WRITE_CEILING_FIXTURE\n");
  const asked = async (node, command) => {
    const before = { ui: uiCalls, model: modelCalls };
    const blocked = (await node.call("bash", { command }))?.block === true;
    return { blocked, reachedReview: uiCalls !== before.ui || modelCalls !== before.model };
  };
  assert.deepEqual(await asked(root, "printenv HOME"), { blocked: true, reachedReview: true }, "An ordinary ask before yolo");
  for (const name of readerWriteNames) {
    assert.deepEqual(await asked(yoloReader, `printf '%s' fixture > ./${name}`), { blocked: true, reachedReview: false },
      `A reader's visible write never reaches a human or judge: ${name}`);
  }
  globalThis[yoloKey] = new Set([root.id]);
  try {
    for (const node of [root, yoloChild]) {
      assert.deepEqual(await asked(node, "printenv HOME"), { blocked: false, reachedReview: false },
        `yolo allows the ask without UI or judge (${node === root ? "root" : "child"})`);
      for (const command of ["cat .env", "sudo true"])
        assert.deepEqual(await asked(node, command), { blocked: true, reachedReview: false }, `yolo keeps the explicit deny: ${command}`);
      assert.equal((await node.call("read", { path: ".env" }))?.block, true, "yolo keeps secret path denies");
    }
    assert.deepEqual(await asked(otherRoot, "printenv HOME"), { blocked: true, reachedReview: true }, "Another root session keeps asking");
    // A reader's Bash asks are allowed too, but its file writes are a deny.
    assert.deepEqual(await asked(yoloReader, "printenv HOME"), { blocked: false, reachedReview: false }, "yolo reaches a reader child");
    for (const name of readerWriteNames) {
      assert.deepEqual(await asked(yoloReader, `printf '%s' fixture > ./${name}`), { blocked: true, reachedReview: false },
        `yolo cannot make a reader write, including inherited path asks: ${name}`);
      assert.deepEqual(await asked(root, `printf '%s' fixture > ./${name}`), { blocked: false, reachedReview: false },
        `The reader ceiling does not change the parent's scope: ${name}`);
    }
  } finally { globalThis[yoloKey].clear(); }
  assert.deepEqual(await asked(root, "printenv HOME"), { blocked: true, reachedReview: true }, "Clearing yolo restores the ask at once");
  console.log("PASS: session yolo allows asks for the session and its in-process children only; explicit denies hold");

  // The Nix Home Manager migration's backup/rewrite assertions stay in the
  // original deployment suite. Portable init instead MUST NOT migrate settings.
  const settings = join(scratch, "settings.json");
  const original = JSON.stringify({ defaultModel: "fixture", enabledModels: ["fixture/custom"], packages: ["npm:other"], extensions: ["other.ts"] });
  writeFileSync(settings, original);
  const env = { ...process.env, PI_CODING_AGENT_DIR: scratch };
  for (let attempt = 0; attempt < 2; attempt++) {
    const initialized = spawnSync(process.execPath, [join(repo, "scripts/init.mjs")], { env, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(readFileSync(settings, "utf8"), original, "Portable init never rewrites existing SDK settings");
  }
  console.log("PASS: isolated portable init preserves existing SDK settings across repeated calls");
} finally {
  for (const node of sessions.reverse()) {
    await node.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    node.parent?.eventBus.emit("subagents:child:disposed", { sessionId: node.id });
    node.session.dispose();
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const path of [...new Set(externalScratch)].reverse()) rmSync(path, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
