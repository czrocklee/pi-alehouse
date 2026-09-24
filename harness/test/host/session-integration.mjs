import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { managementToolNames as delegationTools } from "../../dist/tools/tool-names.js";
import { requireReadiness } from "../../dist/permissions/readiness.js";
import { contextSources, digest, textSnapshot } from "../../dist/runtime/context-snapshot.js";
import { FileLeaseLock as OwnerLock } from "../../dist/runtime/owner-lease.js";
import { controlledProvider, loadHost } from "../support/host.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, generatedRoot, outputRoot, storeProbe] = process.argv.slice(2);
assert(piExecutable && generatedRoot && outputRoot, "Use script/check-pi-harness.sh");
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = resolve(generatedRoot);
const host = await loadHost(piExecutable);
process.env.P0_PERMISSION_ROOT = host.permissionRoot;
const { sdk, ai, permission } = host;
const report = { authority: host.authority, versions: host.versions, claims: [], reload: [], contexts: [], readiness: [], cleanup: [], limitations: [
  "P0 only: no controller, manifests, tools, production backend or real-model trial",
  "No H01-H22 row is claimed complete by these boundary experiments",
] };
function record(name, detail, label = "PASS") { report.claims.push({ name, detail }); console.log(`${label}: ${name}`); }
function save() { writeFileSync(join(outputRoot, "p0-sdk.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
report.platform = { node: process.version, os: process.platform, arch: process.arch };
report.sources = [
  ...["core/sdk.js", "core/agent-session.js", "core/extensions/runner.js", "modes/interactive/interactive-mode.js"].map((file) => join(host.root, "dist", file)),
  join(host.permissionRoot, "src/service.ts"), join(host.permissionRoot, "src/index.ts"),
].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
report.capabilities = host.capabilities;
report.release = releaseDecision;
save();

const parentCwd = join(outputRoot, "parent");
const childCwd = join(outputRoot, "child");
for (const path of [parentCwd, childCwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(generatedRoot, "AGENTS.md"), "OPERATOR_CONTEXT_MARKER\n");
writeFileSync(join(parentCwd, "AGENTS.md"), "PARENT_CWD_CONTEXT_MARKER\n");
writeFileSync(join(childCwd, "AGENTS.md"), "CHILD_CWD_CONTEXT_MARKER\n");
const skillPath = join(generatedRoot, "skills/p0/SKILL.md");
mkdirSync(join(generatedRoot, "skills/p0"), { recursive: true });
writeFileSync(skillPath, "---\nname: p0-fixture\ndescription: CHILD_SKILL_CATALOG_MARKER\n---\nOnly temporary fixture instructions.\n");
const guardPath = join(generatedRoot, "extensions/static-safety-guard.ts");
const permissionPath = host.permissionEntry;
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(outputRoot, "unused-model-cache.json"), refreshOnCreate: false,
});
const provider = controlledProvider(ai);
modelRuntime.registerProvider("harness-fixture", provider.config);
const model = modelRuntime.getModel("harness-fixture", "controlled");
assert(model);
const parentBus = sdk.createEventBus();
const lifecycle = [];
for (const kind of ["session-created", "bound", "disposed"]) {
  parentBus.on(`subagents:child:${kind}`, (event) => lifecycle.push({ kind, ...event }));
}
let parentApi;
const parentLoader = new sdk.DefaultResourceLoader({
  cwd: parentCwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: parentBus,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [permissionPath, guardPath],
  extensionFactories: [(pi) => { parentApi = pi; }],
});
await parentLoader.reload();
assert.equal(typeof parentApi?.getAllTools, "function", "parent inline factory received the SDK API");
assert.deepEqual(parentLoader.getExtensions().errors, []);
const { session: parent } = await sdk.createAgentSession({
  cwd: parentCwd, agentDir: generatedRoot, resourceLoader: parentLoader,
  settingsManager: settings(), sessionManager: sdk.SessionManager.inMemory(parentCwd),
  modelRuntime, model, tools: ["bash"],
});
await parent.bindExtensions({});
assert(permission.getPermissionsService(parent.sessionId));
const live = new Set();
const metrics = { beforePrompt: 0, createdSessionId: undefined };

async function child({ cwd = childCwd, profile = "reader", marker = profile, activeProfile = marker, missing, factories = [], shutdownTimeoutMs } = {}) {
  const definition = readFileSync(join(generatedRoot, "agents", `${profile}.md`), "utf8");
  const body = definition.split(/^---\s*$/m).slice(2).join("\n").trim();
  const tools = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
  const bus = sdk.createEventBus();
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: bus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalSkillPaths: [skillPath],
    additionalExtensionPaths: [
      ...(missing === "permission" ? [] : [permissionPath]),
      ...(missing === "guard" ? [] : [guardPath]),
      ...(missing === "broken" ? [join(outputRoot, "broken.ts")] : []),
    ],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [body, ...(marker === null ? [] : [`<active_agent name="${marker}"/>`])],
    extensionFactories: [
      (pi) => {
        pi.on("before_agent_start", () => { metrics.beforePrompt++; });
        pi.on("session_start", (_event, ctx) => { metrics.createdSessionId = ctx.sessionManager.getSessionId(); });
      }, ...factories,
    ],
  });
  await loader.reload();
  const sm = sdk.SessionManager.inMemory(cwd);
  sm.newSession({ parentSession: parent.sessionId });
  if (activeProfile !== null) sm.appendCustomEntry("active_agent", { name: activeProfile });
  metrics.createdSessionId = sm.getSessionId();
  const result = await assembleChild({
    createSession: sdk.createAgentSession,
    options: { cwd, agentDir: generatedRoot, resourceLoader: loader, settingsManager: settings(),
      sessionManager: sm, modelRuntime, model, thinkingLevel: "off", tools },
    parentBus, childBus: bus, parentSessionId: parent.sessionId, profile,
    definitionDigest: digest(definition), getPermissionsService: permission.getPermissionsService, shutdownTimeoutMs,
  });
  assert.equal(result.guard.sessionId, result.session.sessionId);
  assert.equal(result.guard.profile, profile);
  assert.equal(result.guard.definitionDigest, digest(definition));
  const again = requireReadiness(bus, permission.getPermissionsService, result.session.sessionId, profile, digest(definition));
  assert.equal(again.instanceId, result.guard.instanceId);
  assert.notEqual(again.nonce, result.guard.nonce);
  assert.throws(() => requireReadiness(bus, permission.getPermissionsService, result.session.sessionId, profile, "wrong-digest"), /STATIC_GUARD_NOT_READY/);
  assert.throws(() => requireReadiness(bus, () => ({}), "different-session", profile, digest(definition)), /STATIC_GUARD_NOT_READY/);
  assert(!report.readiness.some((ready) => ready.instanceId === result.guard.instanceId || ready.nonce === result.guard.nonce));
  report.readiness.push({ ...result.guard, freshProbeNonce: again.nonce, wrongDigestRejected: true, crossSessionRejected: true });
  result.bus = bus;
  result.profile = profile;
  result.definitionDigest = digest(definition);
  result.sources = contextSources(loader.getAgentsFiles().agentsFiles, generatedRoot);
  result.skillDiagnostics = loader.getSkills().diagnostics;
  live.add(result);
  return result;
}
async function release(item) {
  const cleanup = await disposeChild(item.session, parentBus);
  assert.equal(cleanup.shutdownExited, true);
  assert.deepEqual(cleanup.errors, []);
  live.delete(item);
  assert.equal(permission.getPermissionsService(item.session.sessionId), undefined);
  assert.throws(() => requireReadiness(item.bus, () => ({}), item.session.sessionId,
    item.profile, item.definitionDigest), /STATIC_GUARD_NOT_READY/);
  report.cleanup.push({ sessionId: item.session.sessionId, ...cleanup, permissionRemoved: true, guardProbeRejected: true });
}
const ask = (session, prompt) => session.prompt(prompt, { expandPromptTemplates: false });
const text = (session) => session.messages.filter((m) => m.role === "assistant").at(-1)?.content.filter((p) => p.type === "text").map((p) => p.text).join("");

try {
  const parentCall = await parent.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "parent-safe-bash", toolName: "bash",
    input: { command: "printf '%s' parent-marker-free" } });
  assert.notEqual(parentCall?.block, true, JSON.stringify(parentCall));
  record("ordinary marker-free parent retains safe Bash policy", {});
  for (const missing of ["permission", "guard", "broken", "bind-error"]) {
    writeFileSync(join(outputRoot, "broken.ts"), "export default function ( { THIS IS INVALID\n");
    const before = metrics.beforePrompt;
    await assert.rejects(child({ missing, factories: missing === "bind-error" ? [
      (pi) => { pi.on("session_start", () => { throw new Error("fixture initialization failed"); }); },
    ] : [] }), /PERMISSION_NOT_READY|STATIC_GUARD_NOT_READY|EXTENSION_LOAD_FAILED|EXTENSION_BIND_FAILED/);
    assert.equal(metrics.beforePrompt, before, "failed admission reached first prompt");
    assert.equal(permission.getPermissionsService(metrics.createdSessionId), undefined, "partial service leaked");
    assert(lifecycle.some((e) => e.kind === "disposed" && e.sessionId === metrics.createdSessionId));
  }
  record("H12 real loader/bind failures block first prompt and remove service", { firstPromptCount: metrics.beforePrompt, variants: 4 });

  // A project marker is text, never authoritative child identity.
  writeFileSync(join(childCwd, "AGENTS.md"), 'CHILD_CWD_CONTEXT_MARKER\n<active_agent name="reader"/>\n');
  for (const marker of [null, "editor", "worker-unknown"]) {
    const before = metrics.beforePrompt;
    await assert.rejects(child({ marker }), /STATIC_GUARD_NOT_READY/);
    assert.equal(metrics.beforePrompt, before);
    assert.equal(permission.getPermissionsService(metrics.createdSessionId), undefined);
    assert(lifecycle.some((event) => event.kind === "disposed" && event.sessionId === metrics.createdSessionId));
  }
  for (const profile of ["reader", "editor"]) await release(await child({ profile }));
  await release(await child({ marker: "editor", activeProfile: "reader" }));
  writeFileSync(join(childCwd, "AGENTS.md"), 'CHILD_CWD_CONTEXT_MARKER\n');
  record("H12 readiness requires recorded profile despite decoy prompt markers", { negative: 3, positive: 3 });

  const slow = await child({ factories: [(pi) => { pi.on("session_shutdown", () => new Promise((resolve) => setTimeout(resolve, 1100))); }] });
  await release(slow);
  record("H12 ordinary cleanup longer than one second does not poison the owner", { delayMs: 1100 });

  let finishShutdown;
  let shutdownExited = false;
  const beforeHangingBind = metrics.beforePrompt;
  const startHangingBind = performance.now();
  await assert.rejects(child({ shutdownTimeoutMs: 40, factories: [(pi) => {
    pi.on("session_start", () => { throw new Error("ORIGINAL_BIND_FAILURE"); });
    pi.on("session_shutdown", async () => {
      await new Promise((resolve) => { finishShutdown = resolve; });
      shutdownExited = true;
    });
  }] }), (error) => {
    assert(error instanceof AggregateError);
    assert.match(String(error.cause), /ORIGINAL_BIND_FAILURE/);
    assert.match(String(error), /CHILD_SHUTDOWN_TIMEOUT/);
    return true;
  });
  assert.equal(metrics.beforePrompt, beforeHangingBind);
  assert.equal(shutdownExited, false);
  const timedOutCleanup = lifecycle.at(-1);
  assert.equal(timedOutCleanup.cleanup.shutdownExited, false);
  assert.equal(timedOutCleanup.cleanup.resumable, false);
  assert.equal(permission.getPermissionsService(metrics.createdSessionId), undefined);
  record("H12 failed bind + non-cooperative shutdown is bounded without hiding the first error", {
    elapsedMs: performance.now() - startHangingBind, cleanup: timedOutCleanup,
  });
  finishShutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownExited, true);

  for (const cwd of [parentCwd, childCwd]) {
    for (const inherit of [false, true]) {
      const item = await child({ cwd });
      assert.notEqual(permission.getPermissionsService(item.session.sessionId), permission.getPermissionsService(parent.sessionId));
      const originalId = item.session.sessionId;
      const history = textSnapshot([{ role: "user", content: "PARENT_TEXT_SNAPSHOT_MARKER", timestamp: 0 }]);
      for (let round = 0; round < 2; round++) {
        await ask(item.session, `${inherit && round === 0 ? history + "\n\n" : ""}temporary task ${round}`);
        assert.equal(text(item.session), "fixture-result", JSON.stringify(item.session.messages));
        const context = provider.requests.at(-1).context;
        assert.match(context.systemPrompt, /OPERATOR_CONTEXT_MARKER/);
        assert.match(context.systemPrompt, cwd === parentCwd ? /PARENT_CWD_CONTEXT_MARKER/ : /CHILD_CWD_CONTEXT_MARKER/);
        assert.doesNotMatch(context.systemPrompt, cwd === parentCwd ? /CHILD_CWD_CONTEXT_MARKER/ : /PARENT_CWD_CONTEXT_MARKER/);
        assert.match(context.systemPrompt, /Execute the current assignment/);
        assert.match(context.systemPrompt, /<active_agent name="reader"\/>/);
        assert.match(context.systemPrompt, /CHILD_SKILL_CATALOG_MARKER/);
        assert.equal(context.systemPrompt.split("OPERATOR_CONTEXT_MARKER").length - 1, 1);
        assert(!context.tools.some((t) => ["edit", "write", ...delegationTools].includes(t.name)));
        assert.equal(JSON.stringify(context.messages).includes("PARENT_TEXT_SNAPSHOT_MARKER"), inherit);
        const file = `prompt-${cwd === parentCwd ? "same" : "different"}-${inherit}-${round}.json`;
        writeFileSync(join(outputRoot, file), JSON.stringify({ systemPrompt: context.systemPrompt,
          tools: context.tools.map((t) => ({ name: t.name, description: t.description })), sources: item.sources }, null, 2), { mode: 0o600 });
        report.contexts.push(file);
      }
      assert.equal(item.session.sessionId, originalId);
      await release(item);
    }
  }
  record("H16 real final prompt/tool table, same/different cwd, text snapshot and two prompts", report.contexts);

  const queued = await child();
  provider.respond(({ signal }) => new Promise((resolve) => {
    const stop = () => resolve({ reason: "aborted", error: "fixture abort" });
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  }));
  const request = provider.requested();
  const running = ask(queued.session, "hold-stream");
  await request;
  await queued.session.steer("OLD_STEERING");
  await queued.session.followUp("OLD_FOLLOW_UP");
  const aborting = queued.session.abort();
  assert(queued.session.getSteeringMessages().includes("OLD_STEERING"));
  assert(queued.session.getFollowUpMessages().includes("OLD_FOLLOW_UP"));
  // Abort does not clear queues. This host's post-run loop can even start a
  // continuation from them, so clear at stop acceptance as well as after exit.
  const discarded = queued.session.clearQueue();
  await aborting;
  await running; // Full prompt exit, not a single agent_end.
  queued.session.clearQueue();
  assert.deepEqual(queued.session.getSteeringMessages(), []);
  assert.deepEqual(queued.session.getFollowUpMessages(), []);
  provider.respond(async () => ({ text: "after-cancel" }));
  await ask(queued.session, "fresh-resume");
  assert.equal(text(queued.session), "after-cancel");
  assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).context.messages), /OLD_STEERING|OLD_FOLLOW_UP/);
  record("H03/H04 real abort retains inputs; explicit clearQueue prevents next-prompt leakage", discarded);
  await release(queued);

  // A real built-in Bash process executes through the real permission gates.
  // No fake tool execute or direct invocation of an unwrapped SDK tool.
  const ownerDir = join(outputRoot, "owner"); mkdirSync(ownerDir, { mode: 0o700 }); chmodSync(ownerDir, 0o700);
  const lock = new OwnerLock(ownerDir, process.env.P0_FLOCK ?? "/run/current-system/sw/bin/flock");
  try {
    // This tests fd inheritance, not read-only policy. The parser cannot prove
    // a Node script operand read-only, so a reader's write ceiling rejects it
    // even with the fixture's command/path grants. Do not weaken that ceiling.
    const item = await child({ profile: "editor" });
    const inspector = join(childCwd, "inspect-fd.cjs");
    writeFileSync(inspector, `const fs=require('node:fs');\nconst lock=fs.statSync(${JSON.stringify(lock.path)});\nlet inherited=false;\nfor(const fd of fs.readdirSync('/proc/self/fd')){try{const s=fs.statSync('/proc/self/fd/'+fd);if(s.ino===lock.ino&&s.dev===lock.dev)inherited=true;}catch{}}\nconsole.log(inherited?'INHERITED_LOCK':'NO_INHERITED_LOCK');\n`);
    // This exact, fixture-only read-only command is authorized in the temporary
    // config by the check script; production policy remains untouched.
    let calls = 0;
    provider.respond(async () => ++calls === 1 ? { tools: [{ type: "toolCall", id: "fd-check", name: "bash", arguments: { command: `${process.execPath} ${inspector}` } }] } : { text: "fd-done" });
    await ask(item.session, "inspect fixture fd");
    const tool = item.session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "fd-check");
    assert(tool && !tool.isError, JSON.stringify(tool));
    assert.match(JSON.stringify(tool.content), /NO_INHERITED_LOCK/);
    assert.doesNotMatch(JSON.stringify(tool.content), /"INHERITED_LOCK/);
    lock.assertHeld();
    await release(item);
    record("H11 actual SDK Bash child does not inherit owner lock fd", { toolCallId: tool.toolCallId });
  } finally { lock.close(); }

  // The real SDK reload is invoked; no method/prototype monkey patches.
  // The observer deliberately tries the ineffective shutdown veto.
  for (const strategy of ["cancel-return", "throw", "bounded-wait"]) {
    const item = await child();
    let releaseStream;
    provider.respond(() => new Promise((resolve) => { releaseStream = () => resolve({ reason: "aborted", error: "fixture end" }); }));
    const requested = provider.requested();
    const running = ask(item.session, "reload-boundary-held-stream");
    await requested;
    const events = [];
    let oldApi;
    const observerBus = sdk.createEventBus();
    const loader = new sdk.DefaultResourceLoader({
      cwd: parentCwd, agentDir: generatedRoot, settingsManager: settings(), eventBus: observerBus,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [permissionPath],
      extensionFactories: [(pi) => {
        oldApi ??= pi;
        pi.on("session_shutdown", async (_event, ctx) => {
          events.push({ event: "shutdown", reason: _event.reason, childStreaming: item.session.isStreaming,
            permissionPresent: !!permission.getPermissionsService(ctx.sessionManager.getSessionId()) });
          if (strategy === "throw") throw new Error("VETO_RELOAD_FIXTURE");
          if (strategy === "bounded-wait") await new Promise((resolve) => setTimeout(resolve, 20));
          return { cancel: true };
        });
      }],
    });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: parentCwd, agentDir: generatedRoot,
      resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(parentCwd), settingsManager: settings(),
      modelRuntime, model, tools: [] });
    await session.bindExtensions({ onError: (e) => events.push({ event: "reported-error", message: e.error }) });
    const oldService = permission.getPermissionsService(session.sessionId);
    assert(oldService, "reload observer parent permission node missing");
    const start = performance.now();
    try {
      await session.reload();
      assert(item.session.isStreaming, "fixture child exited too early");
      assert(events.some((e) => e.event === "shutdown" && e.reason === "reload" && e.childStreaming && !e.permissionPresent));
      assert.throws(() => oldApi.getActiveTools(), /stale|invalid|active|disposed/i);
      assert.notEqual(permission.getPermissionsService(session.sessionId), oldService);
      report.reload.push({ entry: "SDK", strategy, outcome: "unsafe-live-reload", boundary: "unsupported-live-owner-reload",
        elapsedMs: performance.now() - start, oldRunnerInvalidated: true, permissionReplaced: true, childStillExecuting: true,
        events: structuredClone(events) });
    } finally {
      releaseStream(); await running; item.session.clearQueue();
      await release(item);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    }
  }
  record("H11 known boundary: unsupported live-owner reload invalidates old runner/service teardown", report.reload,
    "OBSERVED UNSAFE-LIVE-RELOAD");

  if (storeProbe) {
    const storeBus = sdk.createEventBus();
    let witness;
    storeBus.on("pi-agent-harness:p0:store-probe", (data) => { witness = data; });
    process.env.P0_PROBE_PARENT_SESSION = parent.sessionId;
    const loader = new sdk.DefaultResourceLoader({ cwd: childCwd, agentDir: generatedRoot, eventBus: storeBus,
      settingsManager: settings(), noExtensions: true, noSkills: true, noThemes: true,
      additionalExtensionPaths: [storeProbe],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const probe = JSON.parse(readFileSync(join(outputRoot, "store-probe.json"), "utf8"));
    assert(probe.hostImports && probe.permissionFromExplicitRoot);
    assert.equal(witness.createAgentSession, sdk.createAgentSession);
    assert.equal(witness.SessionManager, sdk.SessionManager);
    assert.equal(witness.Text, host.tui.Text);
    assert.equal(witness.permissionNode, permission.getPermissionsService(parent.sessionId));
    probe.sdkSingleton = probe.tuiSingleton = probe.permissionNodeSingleton = true;
    writeFileSync(join(outputRoot, "store-probe.json"), JSON.stringify(probe, null, 2), { mode: 0o600 });
    report.storeProbe = probe;
    record("H17 read-only external ESM extension resolves host imports and explicit managed permission export", probe);
  }
} finally {
  for (const item of live) {
    await item.session.abort(); item.session.clearQueue();
    await disposeChild(item.session, parentBus);
  }
  await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  parent.dispose();
  save();
}
console.log("P0 observed an unsupported live-owner reload boundary; evidence-only, never safe reload.");
