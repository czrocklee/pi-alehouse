// Deterministic SDK permission probe: real rendered policy and real tool IO,
// scripted RPC-style dialog choices (not a model, TUI, or production acceptance).
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { assembleChildSession as assembleChild, disposeChildSession as disposeChild } from "../../dist/runtime/child-session.js";
import { managementToolNames as delegationTools } from "../../dist/tools/tool-names.js";
import { abortAndWaitForIdle, controlledProvider, loadHost } from "../support/host.mjs";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, agentDir, outputRoot, configSource, option] = process.argv.slice(2);
assert(option === undefined || option === "--luna", "Unknown permission probe option");
const luna = option === "--luna";
assert(piExecutable && agentDir && outputRoot && configSource, "Use check-pi-harness.sh --permissions-only or --luna-only");
assert.equal(process.env.HOME, join(dirname(agentDir), "home"));
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, join(outputRoot, luna ? "luna-sessions" : "readonly-sessions"));
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.PI_TELEMETRY, "0");
assert.equal(process.env.PI_AUTO_APPROVAL_MODE, "shadow");
const lunaPath = join(agentDir, "extensions/luna-auto-approval.ts");
assert.equal(existsSync(lunaPath), luna);
const networkAttempts = [];
if (luna) {
  // Only this isolated negative probe enables enforcement. The wrapper and all
  // other SDK/model/PTY fixtures still start in shadow with Luna excluded.
  process.env.PI_AUTO_APPROVAL_MODE = "enforce-subagents";
  const block = (name) => () => { networkAttempts.push(name); throw new Error(`UNEXPECTED_NETWORK: ${name}`); };
  globalThis.fetch = block("fetch");
  for (const [name, module] of [["http", http], ["https", https]]) for (const key of ["request", "get"]) module[key] = block(`${name}.${key}`);
  net.Socket.prototype.connect = block("socket.connect"); tls.connect = block("tls.connect");
  syncBuiltinESMExports();
}
const configText = readFileSync(configSource, "utf8");
assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "extensions/pi-permission-system/config.json"), "utf8")), JSON.parse(configText), "No fixture permission allowances in this probe");
const definition = readFileSync(join(agentDir, "agents/reader.md"), "utf8");
const declaredTools = JSON.parse(/^tools: (.*)$/m.exec(definition)[1]);
const cwd = join(outputRoot, luna ? "luna-project" : "readonly-project"), sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
for (const path of [cwd, sessionDirectory, join(cwd, "ask-zone"), join(cwd, "shared-zone"), join(cwd, ".git")]) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const [name, content] of Object.entries({ "source.txt": "PUBLIC_MARKER\n", ".env": "DENIED_MARKER\n",
  "ask-zone/a.pem": "CHILD_GRANT_MARKER\n", "shared-zone/a.key": "SHARED_GRANT_MARKER\n", "ask-zone/unserved.pem": "UNSERVED_MARKER\n" })) writeFileSync(join(cwd, name), content);
symlinkSync(join(cwd, ".env"), join(cwd, "alias.txt"));
const host = await loadHost(piExecutable), { sdk, ai, permission } = host;
const report = { authority: host.authority, versions: host.versions, real_model: false, luna_loaded: luna, release: releaseDecision,
  auto_approval_mode: process.env.PI_AUTO_APPROVAL_MODE, network_attempts: networkAttempts, luna_provider_calls: 0,
  luna_digest: luna ? digest(readFileSync(lunaPath, "utf8")) : undefined,
  config_digest: digest(configText), definition_digest: digest(definition), declared_tools: declaredTools,
  cases: [], events: [], dialogs: [], policy: [], cleanup: [], scratch_cleanup: [], extension_errors: [], limitations: [
    "Real file/Bash gates and policy-grep; web tools are not provisioned or exercised, not full profile acceptance",
    "Controlled provider and scripted RPC-style human choices; not actual human/TUI or positive Luna authorization acceptance",
    ...(luna ? ["Negative co-load/forwarding only: no complete Luna delegation provenance, no Owner/Run binding or production enforcement support"] : []),
    "One worker scratch mkdir/cp case; other cases use reader. No persisted scratch inheritance acceptance",
    "No Owner/Run lifecycle, reload, production entrypoint or permission policy changes",
  ] };
const reportPath = join(outputRoot, luna ? "luna-permissions.json" : "readonly-permissions.json");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
save();
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
  modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
const provider = controlledProvider(ai); runtime.registerProvider("harness-fixture", provider.config);
if (luna) runtime.registerProvider("openai-codex", {
  ...provider.config, api: "luna-forbidden-fixture",
  models: [{ ...provider.config.models[0], id: "gpt-5.6-luna", name: "Forbidden Luna fixture" }],
  streamSimple: () => { report.luna_provider_calls++; throw new Error("UNEXPECTED_LUNA_MODEL_CALL"); },
});
const audit = () => {
  const path = join(agentDir, "logs/luna-auto-approval.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
function deferredWithoutModel(start, reason) {
  const decisions = audit().slice(start).filter((row) => row.event === "auto_model_judge.decision");
  assert.equal(decisions.length, 1, JSON.stringify(decisions));
  const row = decisions[0];
  assert.equal(row.mode, "enforce"); assert.equal(row.requestScope, "subagent");
  assert.equal(row.reasonCode, reason); assert.equal(row.failureCode, reason);
  assert.equal(row.modelCalled, false); assert.equal(row.effectiveVerdict, "defer");
  assert.equal(report.luna_provider_calls, 0); assert.deepEqual(networkAttempts, []);
  report.cases.at(-1).luna = row;
}
const model = runtime.getModel("harness-fixture", "controlled");
const settings = () => sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const parents = [], children = [], scratchRoots = [];
let choices = [], callNumber = 0;
const text = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
function busFor(label) {
  const bus = sdk.createEventBus();
  for (const channel of [permission.PERMISSIONS_READY_CHANNEL, permission.PERMISSIONS_UI_PROMPT_CHANNEL, permission.PERMISSIONS_DECISION_CHANNEL]) {
    bus.on(channel, (value) => { report.events.push({ node: label, channel, ...structuredClone(value) }); });
  }
  return bus;
}
async function loader(bus, profile) {
  const result = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings(), eventBus: bus,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    // Preserve historical fixture ordering: Luna's session_start must run before the
    // authority publishes permissions:ready. A loaded file alone is not proof
    // of authorizer registration; the probe requires its actual decision audit.
    additionalExtensionPaths: [...(luna ? [lunaPath] : []), host.permissionEntry, join(agentDir, "extensions/static-safety-guard.ts"), join(agentDir, "extensions/policy-grep.ts")],
    ...(profile ? { appendSystemPromptOverride: () => [profile.definition.split(/^---\s*$/m).slice(2).join("\n").trim(), `<active_agent name="${profile.name}"/>`] } : {}),
  });
  await result.reload(); assert.deepEqual(result.getExtensions().errors, []);
  return result;
}
async function parent(label, serving = true) {
  const bus = busFor(label);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: await loader(bus),
    settingsManager: settings(), sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model, tools: ["read"] });
  const item = { session, bus, label }; parents.push(item);
  await session.bindExtensions({ mode: "rpc", onError: (error) => report.extension_errors.push(error.error),
    ...(serving ? { uiContext: {
      select: async (title, options) => {
        report.dialogs.push({ node: label, title, options });
        const choice = choices.shift();
        assert(choice, `Unexpected approval prompt: ${title}`);
        const selected = options.find((option) => choice.test(option));
        assert(selected, `Missing choice ${choice}: ${JSON.stringify(options)}`);
        return selected;
      },
      input: async () => { throw new Error("Unexpected text input"); },
      notify() {}, setStatus() {}, setWidget() {},
    } } : {}),
  });
  assert(permission.getPermissionsService(session.sessionId));
  return item;
}
async function child(parent, label, name = "reader") {
  const profile = { name, definition: readFileSync(join(agentDir, "agents", `${name}.md`), "utf8") };
  const tools = JSON.parse(/^tools: (.*)$/m.exec(profile.definition)[1]);
  const bus = busFor(label), manager = sdk.SessionManager.inMemory(cwd);
  const parentSession = parent.session.sessionManager.getSessionFile();
  manager.newSession({ parentSession });
  assert.equal(manager.getHeader().parentSession, parentSession); // undefined for an in-memory parent, never a session ID.
  manager.appendCustomEntry("active_agent", { name });
  const assembled = await assembleChild({ createSession: sdk.createAgentSession,
    options: { cwd, agentDir, resourceLoader: await loader(bus, profile), settingsManager: settings(), sessionManager: manager,
      modelRuntime: runtime, model, thinkingLevel: "off", tools },
    parentBus: parent.bus, childBus: bus, parentSessionId: parent.session.sessionId, profile: name,
    definitionDigest: digest(profile.definition), getPermissionsService: permission.getPermissionsService }).catch((error) => {
    if (error.code === "CHILD_INITIALIZATION_FAILED") report.initialization_cleanup_uncertain = true;
    throw error;
  });
  const item = { ...assembled, bus, parent, label, profile: name, definitionDigest: digest(profile.definition) }; children.push(item); return item;
}
async function call(item, name, args, answers = []) {
  assert.equal(choices.length, 0); choices = [...answers];
  const id = `permission-call-${++callNumber}`;
  let turns = 0;
  provider.respond(async ({ context }) => {
    if (++turns === 1) {
      item.activeTools = context.tools.map((tool) => tool.name);
      return { tools: [{ type: "toolCall", id, name, arguments: args }] };
    }
    return { text: "Fixture tool finished" };
  });
  await item.session.prompt(`Synthetic permission case ${id}`, { source: "extension", expandPromptTemplates: false });
  await item.session.waitForIdle();
  assert.equal(choices.length, 0, "Expected dialog was not reached");
  const result = item.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
  assert(result, `No SDK tool result: ${id}`);
  report.cases.at(-1).calls.push({ id, node: item.label, name, args, is_error: !!result.isError, text: text(result) });
  return result;
}
async function check(name, action) {
  if (report.initialization_cleanup_uncertain) throw new Error("Child initialization cleanup not confirmed; stop probing");
  const record = { name, status: "running", calls: [] }; report.cases.push(record); save();
  try { await action(); record.status = "passed"; }
  catch (error) { record.status = "failed"; record.error = String(error); choices = []; }
  save(); console.log(`${record.status.toUpperCase()}: ${name}`);
}
function forwardedSince(start, child, result) {
  const events = report.events.slice(start);
  const prompt = events.find((event) => event.node === "parent" && event.channel === permission.PERMISSIONS_UI_PROMPT_CHANNEL);
  assert.equal(prompt?.forwarding?.requesterSessionId, child.session.sessionId);
  assert.equal(prompt?.forwarding?.requesterAgentName, child.profile);
  for (const node of ["parent", child.label]) assert(events.some((event) => event.node === node && event.channel === permission.PERMISSIONS_DECISION_CHANNEL && event.requestId === prompt.requestId && event.result === result &&
    !["authorizer_allowed", "authorizer_denied"].includes(event.resolution)));
  return events.find((event) => event.node === "parent" && event.channel === permission.PERMISSIONS_DECISION_CHANNEL && event.requestId === prompt.requestId);
}
let primaryError;
try {
  const p = await parent("parent"), a = await child(p, "child-a"), b = await child(p, "child-b");
  report.sessions = { parent: p.session.sessionId, a: a.session.sessionId, b: b.session.sessionId };
  if (luna) for (const allowed of [true, false]) await check(`unbound child Bash ask defers to scripted human ${allowed ? "allow" : "deny"}`, async () => {
    const start = report.events.length, auditStart = audit().length;
    assert.equal(permission.getPermissionsService(a.session.sessionId).checkPermission("bash", "sleep 0", "reader").state, "ask");
    const result = await call(a, "bash", { command: "sleep 0" }, [allowed ? /^Yes$/ : /^No$/]);
    assert.equal(!!result.isError, !allowed);
    const decision = forwardedSince(start, a, allowed ? "allow" : "deny");
    assert.equal(decision.resolution, allowed ? "user_approved" : "user_denied");
    deferredWithoutModel(auditStart, "delegation_unbound");
  });
  await check("real read, tool visibility and profile denies", async () => {
    const result = await call(a, "read", { path: "source.txt" });
    assert(!result.isError); assert.equal(text(result), "PUBLIC_MARKER\n");
    assert.deepEqual([...a.activeTools].sort(), ["bash", "find", "grep", "ls", "read"]);
    assert(!a.activeTools.some((name) => ["write", "edit", ...delegationTools].includes(name)));
    report.active_tools = a.activeTools;
    const service = permission.getPermissionsService(a.session.sessionId);
    for (const name of ["write", "edit"]) assert.equal(service.checkPermission(name, undefined, "reader").state, "deny");
  });
  await check("sensitive reads and symlink alias denied without a prompt", async () => {
    const before = report.dialogs.length;
    for (const path of [".env", "alias.txt"]) {
      const result = await call(a, "read", { path });
      assert(result.isError); assert.match(text(result), /Denied by policy.*path_read/); assert(!text(result).includes("DENIED_MARKER"));
    }
    assert.equal(report.dialogs.length, before);
  });
  await check("actual policy-grep skips deny and ask descendants", async () => {
    const result = await call(a, "grep", { path: ".", pattern: "MARKER" });
    assert(!result.isError); assert.match(text(result), /PUBLIC_MARKER/);
    assert.doesNotMatch(text(result), /DENIED_MARKER|CHILD_GRANT_MARKER|SHARED_GRANT_MARKER|UNSERVED_MARKER/);
  });
  await check("Bash safe read works; profile rm deny preserves file", async () => {
    const safe = await call(a, "bash", { command: "cat source.txt" }); assert(!safe.isError); assert.match(text(safe), /PUBLIC_MARKER/);
    // A managed-only proof, not merely an unchanged upstream literal allowance.
    const command = "sed -n '1,1p' source.txt", before = report.dialogs.length;
    assert.equal(permission.getPermissionsService(a.session.sessionId).checkPermission("bash", command, "reader").state, "ask");
    const managed = await call(a, "bash", { command });
    assert(!managed.isError); assert.match(text(managed), /PUBLIC_MARKER/); assert.equal(report.dialogs.length, before);
    const denied = await call(a, "bash", { command: "rm source.txt" }); assert(denied.isError);
    assert.equal(readFileSync(join(cwd, "source.txt"), "utf8"), "PUBLIC_MARKER\n");
  });
  await check("reader visible writes are hard-denied before and during parent yolo", async () => {
    const key = Symbol.for("@rocklee/managed-permissions:session-yolo"), previous = globalThis[key];
    const grants = new Set(previous ?? []);
    globalThis[key] = grants;
    try {
      for (const yolo of [false, true]) {
        if (yolo) grants.add(p.session.sessionId); else grants.delete(p.session.sessionId);
        for (const suffix of ["txt", "pem", "key", "p12", "pfx"]) {
          const name = `reader-write.${suffix}`, path = join(cwd, name), before = report.dialogs.length;
          writeFileSync(path, "SYNTHETIC_WRITE_CEILING_FIXTURE\n");
          const result = await call(a, "bash", { command: `printf '%s' READER_WRITE_CANARY > ./${name}` });
          assert(result.isError, `reader wrote ${name}, yolo=${yolo}`);
          assert.match(text(result), /Denied by policy.*path_write/);
          assert.equal(readFileSync(path, "utf8"), "SYNTHETIC_WRITE_CEILING_FIXTURE\n");
          assert.equal(report.dialogs.length, before, "A profile denial never reaches human approval");
        }
      }
    } finally {
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
  });
  await check("worker scratch mkdir/cp uses managed proof; non-scratch copy still asks", async () => {
    // reader deliberately retains a path_write deny ceiling. Use the editing
    // profile here; do not relax any policy to manufacture a prompt-free copy.
    const w = await child(p, "scratch-worker", "editor");
    report.cases.at(-1).profile = { name: w.profile, definition_digest: w.definitionDigest };
    const manager = w.session.sessionManager, start = manager.getEntries().length, before = report.dialogs.length;
    const created = await call(w, "bash", { command: "mktemp -d" });
    assert(!created.isError, text(created));
    const root = text(created).trim(); assert.match(root, /^\/tmp\/tmp\.[A-Za-z0-9]+$/);
    const stat = lstatSync(root); assert(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o700);
    scratchRoots.push({ path: root, dev: stat.dev, ino: stat.ino });
    assert.deepEqual(readdirSync(root), []);
    const records = () => manager.getEntries().slice(start).filter((entry) => entry.type === "custom");
    const roots = records().filter((entry) => entry.customType === "managed-scratch-created");
    assert.equal(roots.length, 1); assert.equal(roots[0].data.path, root);
    const command = `mkdir -p ${root}/nested && cp source.txt ${root}/nested/copied.txt`;
    const service = permission.getPermissionsService(w.session.sessionId);
    assert.equal(service.checkPermission("bash", command, "editor").state, "ask");
    const copied = await call(w, "bash", { command }); assert(!copied.isError, text(copied));
    assert.equal(readFileSync(join(root, "nested/copied.txt"), "utf8"), "PUBLIC_MARKER\n");
    assert.equal(report.dialogs.length, before);
    const effects = () => records().filter((entry) => entry.customType === "managed-static-file-effects");
    assert.equal(effects().length, 1);
    const proof = effects()[0].data;
    assert.equal(proof.originalDigest, digest(command));
    assert.match(proof.executionDigest, /^[0-9a-f]{64}$/); assert.notEqual(proof.executionDigest, proof.originalDigest);
    report.cases.at(-1).proof = proof;
    const outside = "cp source.txt ./outside-copy.txt", eventStart = report.events.length;
    assert.equal(service.checkPermission("bash", outside, "editor").state, "ask");
    assert((await call(w, "bash", { command: outside }, [/^No$/])).isError);
    forwardedSince(eventStart, w, "deny");
    assert.equal(report.dialogs.length, before + 1);
    assert(!existsSync(join(cwd, "outside-copy.txt"))); assert.equal(effects().length, 1);
  });
  await check("forwarded child-only grant cannot authorize sibling or parent", async () => {
    const start = report.events.length, auditStart = audit().length;
    const granted = await call(a, "read", { path: "ask-zone/a.pem" }, [/^Yes, allow reads to/, /^This subagent\b.*\bonly$/]);
    assert(!granted.isError); assert.equal(text(granted), "CHILD_GRANT_MARKER\n"); forwardedSince(start, a, "allow");
    if (luna) deferredWithoutModel(auditStart, "bounded_path_family");
    const count = report.dialogs.length;
    assert.equal(permission.getPermissionsService(a.session.sessionId).checkPermission("path_write", join(cwd, "ask-zone/a.pem"), "reader").state, "deny", "read approval must not weaken the reader write ceiling");
    assert(!(await call(a, "read", { path: "ask-zone/a.pem" })).isError); assert.equal(report.dialogs.length, count);
    assert((await call(b, "read", { path: "ask-zone/a.pem" }, [/^No$/])).isError);
    assert((await call(p, "read", { path: "ask-zone/a.pem" }, [/^No$/])).isError);
  });
  await check("forwarded whole-session grant covers sibling and parent", async () => {
    const start = report.events.length;
    assert(!(await call(a, "read", { path: "shared-zone/a.key" }, [/^Yes, allow reads to/, /^The whole session/])).isError);
    forwardedSince(start, a, "allow");
    const count = report.dialogs.length;
    for (const item of [b, p]) assert(!(await call(item, "read", { path: "shared-zone/a.key" })).isError);
    assert.equal(report.dialogs.length, count);
    for (const item of [p, a, b]) assert.equal(permission.getPermissionsService(item.session.sessionId)
      .checkPermission("path_write", join(cwd, "shared-zone/a.key"), item === p ? undefined : "reader").state,
      item === p ? "ask" : "deny", "whole-session read grant must not authorize writes or weaken the reader ceiling");
  });
  await check("headless unserved parent fails closed", async () => {
    const unserved = await parent("unserved-parent", false), c = await child(unserved, "unserved-child");
    const start = report.events.length, result = await call(c, "read", { path: "ask-zone/unserved.pem" });
    assert(result.isError); assert(!text(result).includes("UNSERVED_MARKER"));
    assert(report.events.slice(start).some((event) => event.node === c.label && event.resolution === "confirmation_unavailable" && event.result === "deny"));
  });
  await check("protected write paths retain global hard denies in worker policy", async () => {
    const service = permission.getPermissionsService(a.session.sessionId);
    const paths = [join(cwd, ".git/config"), join(process.env.HOME, ".gitconfig"), join(process.env.HOME, ".pi/agent/fixture.json")];
    for (const path of paths) report.policy.push({ path,
      global: service.checkPermission("path_write", path), worker: service.checkPermission("path_write", path, "reader") });
    // Control files are query-only. The real Bash gate is exercised against a
    // synthetic non-control canary inside this fixture's otherwise empty .git.
    assert(report.policy.every((row) => row.global.state === "deny" && row.worker.state === "deny" &&
      row.global.origin === "global" && row.worker.origin === "global" && row.global.matchedPattern === row.worker.matchedPattern), JSON.stringify(report.policy));
    const before = report.dialogs.length;
    const result = await call(a, "bash", { command: "printf '%s' blocked > ./.git/fixture-canary.txt" });
    assert(result.isError); assert.match(text(result), /Denied by policy.*path_write/);
    assert(!existsSync(join(cwd, ".git/fixture-canary.txt")));
    assert.equal(report.dialogs.length, before);
  });
} catch (error) { primaryError = String(error); }
finally {
  let childrenClosed = !report.initialization_cleanup_uncertain;
  for (const item of [...children].reverse()) {
    try {
      await abortAndWaitForIdle(item.session);
      const result = await disposeChild(item.session, item.parent.bus);
      report.cleanup.push({ node: item.label, ...result, permission_removed: !permission.getPermissionsService(item.session.sessionId) });
      childrenClosed &&= result.shutdownExited && result.errors.length === 0 && !permission.getPermissionsService(item.session.sessionId);
    } catch (error) { childrenClosed = false; report.cleanup.push({ node: item.label, error: String(error) }); }
  }
  if (childrenClosed) for (const item of [...parents].reverse()) {
    try {
      await abortAndWaitForIdle(item.session);
      report.cleanup.push({ node: item.label, ...await disposeChild(item.session, item.bus), permission_removed: !permission.getPermissionsService(item.session.sessionId) });
    } catch (error) { report.cleanup.push({ node: item.label, error: String(error) }); }
  }
  else report.parent_teardown = "skipped: child cleanup not confirmed";
  // Only remove roots this probe observed, after all child cleanup is confirmed.
  if (childrenClosed) for (const root of scratchRoots) {
    try {
      const stat = lstatSync(root.path);
      assert(stat.isDirectory() && stat.dev === root.dev && stat.ino === root.ino, "Scratch identity changed before cleanup");
      rmSync(root.path, { recursive: true });
      report.scratch_cleanup.push({ path: root.path, removed: true });
    } catch (error) { report.scratch_cleanup.push({ path: root.path, removed: false, error: String(error) }); }
  }
  report.error = primaryError;
  report.luna_audit = luna ? audit() : undefined;
  report.status = !primaryError && networkAttempts.length === 0 && report.luna_provider_calls === 0 &&
    !report.luna_audit?.some((row) => row.modelCalled === true || row.event === "auto_model_judge.registration_failed") && childrenClosed && report.extension_errors.length === 0 && report.cases.every((item) => item.status === "passed") &&
    report.cleanup.every((item) => item.shutdownExited && item.permission_removed && item.errors?.length === 0) &&
    report.scratch_cleanup.length === scratchRoots.length && report.scratch_cleanup.every((item) => item.removed) ? "passed" : "failed";
  save();
}
console.log(`Permission evidence: ${reportPath}`);
if (report.status !== "passed") process.exitCode = 1;
