// Synthetic, local authority tests. No model, network, live config, or tool
// execution. Source-only cases do not generate or mutate shared runtime output.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { packageRoot, resolveGit } from "../../bin/runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const vendorSrc = join(packageRoot, "runtime/permission-system/vendor/src");
const aliases = {
  "@earendil-works/pi-coding-agent": join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  "#src/access-intent/path-surfaces": join(vendorSrc, "access-intent/path-surfaces.ts"),
};
const jiti = createJiti(import.meta.url, { alias: aliases });
const sourcePath = join(packageRoot, "permission-system/managed-workspace-policy.ts");
const source = await jiti.import(sourcePath);
const load = (name) => jiti.import(join(vendorSrc, `${name}.ts`));
let runtime;
async function modules() {
  runtime ??= Promise.all([
    load("policy/permission-manager"), load("policy/permission-resolver"), load("session/permission-session"),
    load("config/config-store"), load("path/path-flavor"), load("handlers/gates/path"),
    load("handlers/gates/tool"), load("handlers/gates/bash-path"), load("access-intent/bash/program"),
    load("handlers/gates/external-directory"), load("path/path-normalizer"),
    load("access-intent/input-normalizer"), load("policy/managed-workspace-policy"),
    load("authority/forwarded-request-server"), load("authority/forwarding-io"),
    load("authority/permission-forwarding"), load("authority/subagent-registry"),
    load("service/permissions-service"), load("handlers/permission-gate-handler"), load("handlers/lifecycle"),
  ]).then(parts => Object.assign({}, ...parts));
  return runtime;
}
let stamp = Date.now();
const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value));
  const time = new Date(++stamp); utimesSync(path, time, time); // Deterministic mtime-based loader invalidation.
};
const projectConfig = (cwd) => join(cwd, ".pi/extensions/pi-permission-system/config.json");
function directories(t) {
  const base = mkdtempSync(join(tmpdir(), "alehouse-workspace-policy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, "worktree"), source_cwd = join(base, "original"), agentDir = join(base, "agent");
  for (const path of [cwd, source_cwd, agentDir]) mkdirSync(path);
  return { base, cwd, source_cwd, agentDir };
}
function context(id, cwd, projectTrusted = false) {
  const entries = [{ type: "custom", customType: "active_agent", data: { name: "editor" } }];
  return { cwd, hasUI: false, isProjectTrusted: () => projectTrusted, ui: { notify() {} },
    sessionManager: { getSessionId: () => id, getEntries: () => entries, getBranch: () => entries } };
}
function binding(t, dirs, projectTrusted = true) {
  const sessionId = randomUUID();
  const lease = source.bindWorkspacePolicy({ sessionId, cwd: dirs.cwd, source_cwd: dirs.source_cwd,
    checkout_root: dirs.checkout_root ?? dirs.cwd, source_root: dirs.source_root ?? dirs.source_cwd, projectTrusted });
  t.after(() => lease.release());
  return { sessionId, lease, ctx: context(sessionId, dirs.cwd) };
}
const baseline = () => ({ "*": "allow", path: "allow", read: "allow", write: "allow", edit: "allow", bash: "ask" });
async function fixture(t, options = {}) {
  const dirs = directories(t);
  dirs.checkout_root = dirs.cwd; dirs.source_root = dirs.source_cwd;
  if (options.repository) {
    const git = resolveGit();
    assert.ok(git, "Workspace Git path coverage requires verified absolute PI_HARNESS_GIT");
    const env = { HOME: dirs.base, XDG_CONFIG_HOME: dirs.base, PATH: "/dev/null", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const runGit = (...args) => execFileSync(git, ["--no-lazy-fetch", "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false", "-c", "protocol.allow=never", ...args],
    { cwd: dirs.source_root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    runGit("init", "--initial-branch=fixture", "--template=");
    for (const name of ["secret/k.txt", "nested/keep.txt"]) {
      mkdirSync(dirname(join(dirs.source_root, name)), { recursive: true });
      writeFileSync(join(dirs.source_root, name), "synthetic committed fixture\n");
    }
    runGit("add", "--", "."); runGit("commit", "--no-gpg-sign", "-m", "fixture");
    runGit("worktree", "add", "--detach", "--", dirs.checkout_root, "HEAD");
  }
  if (options.nested) {
    dirs.source_cwd = join(dirs.source_root, "nested");
    dirs.cwd = join(dirs.checkout_root, "nested");
    mkdirSync(dirs.source_cwd, { recursive: true }); mkdirSync(dirs.cwd, { recursive: true });
  }
  const globalPath = join(dirs.agentDir, "extensions/pi-permission-system/config.json");
  const seed = options.seed ? JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8")) : { permission: baseline() };
  json(globalPath, { ...seed, ...options.global });
  if (options.seed) {
    mkdirSync(join(dirs.agentDir, "agents"));
    for (const name of ["editor", "researcher"]) cpSync(join(packageRoot, "runtime/agents", `${name}.md`), join(dirs.agentDir, "agents", `${name}.md`));
  }
  json(projectConfig(dirs.source_cwd), { permission: {}, ...options.project });
  // A worktree's project config must never replace the trusted source config.
  json(projectConfig(dirs.cwd), { permission: { "*": "allow", path: "allow" }, yoloMode: false });
  const bound = binding(t, dirs, options.trusted ?? true);
  const m = await modules();
  const manager = new m.PermissionManager({ agentDir: dirs.agentDir, isYoloEnabled: () => options.yolo === true,
    resourceProtection: options.protection?.(dirs) });
  const logger = { debug() {}, review() {} };
  const store = new m.ConfigStore({ agentDir: dirs.agentDir, policyPaths: manager, logger });
  const rules = options.rules ?? [];
  const session = new m.PermissionSession({ piInfrastructureDirs: [] }, { start() {}, stop() {} }, manager,
    { clear() {} }, store, { activate() {}, deactivate() {} }, m.posixPathFlavor);
  session.refreshConfig(bound.ctx, false);
  session.resetForNewSession(bound.ctx, false);
  const resolver = new m.PermissionResolver(manager, { getRuleset: () => rules });
  const service = new m.LocalPermissionsService(resolver, session, {}, {}, {});
  const check = (value, surface = "path_read", agent = "editor") => service.checkPermission(surface, value, agent);
  const tcc = (input, toolName = "read") => ({ input, toolName, agentName: "editor", toolCallId: "fixture",
    cwd: dirs.cwd, workspacePolicy: session.getWorkspacePolicy() });
  return { ...dirs, ...bound, m, manager, store, session, resolver, service, check, tcc, globalPath };
}

// The real serving seam over the real wire: a ForwardedRequestServer drains an
// inbox of requests whose facts came from the actual child gate producer.
async function forwardingFixture(t, options = {}) {
  const f = await fixture(t, { project: options.project });
  const parent = randomUUID();
  const registry = f.m.getSubagentSessionRegistry();
  registry.register(f.sessionId, { parentSessionId: options.wrongParent ? randomUUID() : parent });
  t.after(() => registry.unregister(f.sessionId));
  const forwardingDir = join(f.base, "forwarding");
  const parentManager = new f.m.PermissionManager({ agentDir: f.agentDir });
  parentManager.configureForCwd(f.source_cwd);
  const parentResolver = new f.m.PermissionResolver(parentManager, { getRuleset: () => [] });
  const calls = { policy: 0, resolve: 0, escalator: 0 };
  const server = new f.m.ForwardedRequestServer({ forwardingDir, registry,
    logger: { review() {}, debug() {} },
    // The composition root's serving policy: verify binding/parentage/aliases
    // first, then resolve the child-fixed facts against the real parent rules.
    // The two counters distinguish "policy callback entered" from "actual
    // serving resolution reached" when verification throws.
    policy: { resolve(intent) {
      calls.policy++;
      const workspacePolicyValues = f.m.workspacePolicyForwardedValues(intent, parent, registry);
      calls.resolve++;
      return parentResolver.resolve({
        ...f.m.buildResolvedIntentFromMatchValues(intent.surface, intent.matchValues, intent.principal.agentName),
        workspacePolicyValues,
      });
    } },
    escalator: { async escalate() {
      calls.escalator++;
      return { approved: true, state: "approved", decidedBy: { kind: "user", via: "dialog" } };
    } },
    broadcaster: { emitDecision() {} }, recorder: { recordSessionApproval() {} },
  });
  const location = f.m.createPermissionForwardingLocation(forwardingDir, parent);
  mkdirSync(location.requestsDir, { recursive: true });
  const ctx = { cwd: f.cwd, hasUI: false, ui: { notify() {} }, sessionManager: {
    getSessionId: () => parent, getSessionDir: () => location.sessionRootDir, getEntries: () => [],
  } };
  const forward = (accessIntent, id = randomUUID()) => {
    const requestPath = join(location.requestsDir, `${id}.json`);
    json(requestPath, { id, createdAt: Date.now(), requesterSessionId: f.sessionId, targetSessionId: parent,
      requesterAgentName: "editor", accessIntent });
    return { id, requestPath };
  };
  const serve = async forwarded => {
    await server.processInbox(ctx);
    const responsePath = join(location.responsesDir, `${forwarded.id}.json`);
    assert.ok(existsSync(responsePath), "server must record a response instead of leaving the inbox hanging");
    assert.equal(existsSync(forwarded.requestPath), false, "responded request is drained");
    return f.m.readForwardedPermissionResponse(null, responsePath);
  };
  return { ...f, parent, calls, forward, serve };
}

// Invocable before generation: --test-name-pattern='^workspace source:'
test("workspace source: bounded per-session registry spans independent jiti instances", async (t) => {
  const dirs = directories(t), a = binding(t, dirs);
  const other = await createJiti(import.meta.url, { alias: aliases }).import(sourcePath);
  const secondDirs = { ...dirs, cwd: join(dirs.base, "second"), source_cwd: join(dirs.base, "second-source") };
  mkdirSync(secondDirs.cwd); mkdirSync(secondDirs.source_cwd);
  const b = binding(t, secondDirs, false);
  const first = other.workspacePolicyForContext(a.ctx), second = source.workspacePolicyForContext(b.ctx);
  assert.equal(first.source_cwd, dirs.source_cwd);
  assert.equal(second.projectTrusted, false);
  const spelled = binding(t, { ...dirs, source_cwd: `${dirs.source_cwd}/.` });
  assert.equal(source.workspacePolicyForContext(spelled.ctx).source_cwd, `${dirs.source_cwd}/.`,
    "retain trusted source cwd spelling; canonical aliases are separate");
  assert.deepEqual(other.workspacePolicyAliases(first, [join(dirs.cwd, "sub/file")]), [join(dirs.source_cwd, "sub/file")]);
  assert.deepEqual(source.workspacePolicyAliases(second, [join(dirs.cwd, "sub/file")]), []);
  assert.throws(() => other.assertWorkspacePolicy(JSON.parse(JSON.stringify(first))), /stale or forged/);
});

test("workspace source: malformed, duplicate, mismatched and released bindings fail visibly", (t) => {
  const dirs = directories(t), a = binding(t, dirs);
  const roots = { checkout_root: dirs.cwd, source_root: dirs.source_cwd };
  for (const change of [{ sessionId: "" }, { cwd: "relative" }, { source_cwd: "relative" }, { projectTrusted: "true" },
    { checkout_root: "relative" }, { source_root: "relative" }, { checkout_root: dirs.source_cwd }]) {
    assert.throws(() => source.bindWorkspacePolicy({ sessionId: randomUUID(), ...dirs, ...roots, projectTrusted: true, ...change }));
  }
  assert.throws(() => source.bindWorkspacePolicy({ sessionId: a.sessionId, ...dirs, ...roots, projectTrusted: true }), /already bound/);
  assert.throws(() => source.workspacePolicyForContext(context(a.sessionId, dirs.source_cwd)), /cwd mismatch/);
  assert.throws(() => source.workspacePolicyForContext(context("", dirs.cwd)), /Invalid workspace policy session/);
  const record = source.workspacePolicyForContext(a.ctx);
  a.lease.release(); a.lease.release();
  assert.throws(() => source.workspacePolicyForContext(a.ctx), /released/);
  assert.throws(() => source.workspacePolicyAliases(record, [join(dirs.cwd, "file")]), /stale/);
  assert.throws(() => source.bindWorkspacePolicy({ sessionId: a.sessionId, ...dirs, ...roots, projectTrusted: true }), /retired/);
  assert.equal(source.workspacePolicyForContext(context(randomUUID(), dirs.cwd)), undefined);
});

test("workspace source: explicit whole-checkout roots cover nested siblings, not unrelated checkouts", (t) => {
  const dirs = directories(t);
  dirs.checkout_root = dirs.cwd; dirs.source_root = dirs.source_cwd;
  dirs.cwd = join(dirs.checkout_root, "nested"); dirs.source_cwd = join(dirs.source_root, "nested");
  mkdirSync(dirs.cwd); mkdirSync(dirs.source_cwd);
  const a = binding(t, dirs), record = source.workspacePolicyForContext(a.ctx);
  assert.deepEqual(source.workspacePolicyAliases(record, [dirs.cwd, join(dirs.checkout_root, "sibling/file")]),
    [dirs.source_cwd, join(dirs.source_root, "sibling/file")]);
  for (const outside of [dirs.source_root, join(dirs.base, "worktree-other/file"), "relative/file"]) {
    assert.deepEqual(source.workspacePolicyAliases(record, [outside]), []);
  }
  assert.throws(() => source.bindWorkspacePolicy({ ...dirs, cwd: dirs.checkout_root, sessionId: randomUUID(), projectTrusted: true }), /offsets mismatch/);
});

test("workspace source: validated lexical and canonical repository roots preserve symlink-prefixed restrictions", (t) => {
  const dirs = directories(t), link = join(dirs.base, "source-link");
  symlinkSync(dirs.source_cwd, link);
  const a = binding(t, { ...dirs, source_root: link, source_cwd: link });
  assert.deepEqual(source.workspacePolicyAliases(source.workspacePolicyForContext(a.ctx), [join(dirs.cwd, "secret/k")]),
    [join(link, "secret/k"), join(dirs.source_cwd, "secret/k")]);
});

test("workspace runtime: source project policy/trust load while execution paths remain the worktree", async (t) => {
  const f = await fixture(t, { project: { yoloMode: true, permission: { path: { "*.secret": "deny", "*.review": "ask" } } } });
  assert.equal(f.store.current().yoloMode, true, "source config, not worktree config or worktree trust");
  f.store.refresh(undefined, false);
  assert.equal(f.store.current().yoloMode, true, "contextless refresh retains the bound source policy");
  assert.equal(f.manager.getResolvedPolicyPaths().projectConfigPath, projectConfig(f.source_cwd));
  assert.equal(f.check("private.secret").state, "deny");
  assert.equal(f.check("note.review").state, "ask");
  assert.equal(f.session.getPathNormalizer().forPath("file").value(), join(f.cwd, "file"));
  const program = await f.m.BashProgram.parse("cat sub/private.secret", f.session.getPathNormalizer());
  const gate = f.m.describeBashPathGate(f.tcc({ command: program.commandText() }, "bash"), program, f.resolver, f.session.getPathNormalizer());
  assert.equal(gate.preCheck.state, "deny");
  assert.ok(gate.promptDetails.accessIntent.matchValues.includes(join(f.cwd, "sub/private.secret")));
  assert.ok(gate.promptDetails.accessIntent.workspacePolicyValues.includes(join(f.source_cwd, "sub/private.secret")));
  assert.ok(!gate.promptDetails.accessIntent.matchValues.includes(join(f.source_cwd, "sub/private.secret")));
});

test("workspace runtime: exact absolute source denies hold at root and subdir, including nested source cwd", async (t) => {
  for (const nested of [false, true]) {
    const f = await fixture(t, { nested });
    const denied = ["secret.txt", "sub/secret.txt"];
    // Bare argv are promoted by an existence probe, not by the configured
    // rule. Populate ordinary source/worktree files to exercise that path.
    for (const root of [f.source_cwd, f.cwd]) for (const name of denied) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "synthetic workspace fixture\n");
    }
    json(projectConfig(f.source_cwd), { permission: { path_read: Object.fromEntries(denied.map(name => [join(f.source_cwd, name), "deny"])) } });
    for (const name of denied) {
      const result = f.check(join(f.cwd, name));
      assert.equal(result.state, "deny", `${nested}: ${name}`);
      assert.equal(result.matchedPattern, join(f.source_cwd, name));
      const command = name.startsWith("sub/") ? "cd sub && cat secret.txt" : "cat secret.txt";
      const program = await f.m.BashProgram.parse(command, f.session.getPathNormalizer());
      assert.ok(program.pathRuleCandidates().some(({ path }) => path.matchValues().includes(join(f.cwd, name))),
        `collector must resolve the actual execution path: ${command}`);
      const gate = f.m.describeBashPathGate(f.tcc({ command }, "bash"), program, f.resolver, f.session.getPathNormalizer());
      assert.ok(gate, `exact source deny must produce a gate: ${command}`);
      assert.equal(gate.preCheck.state, "deny", `cd-aware exact source deny: ${command}`);
    }
    if (nested) assert.deepEqual(source.workspacePolicyAliases(source.workspacePolicyForContext(f.ctx),
      [join(f.checkout_root, "sibling.txt")]), [join(f.source_root, "sibling.txt")]);
  }
});

test("workspace runtime: real seed and linked Git checkout preserve repository sibling denies from nested cwd", async (t) => {
  const f = await fixture(t, { nested: true, seed: true, repository: true });
  const shared = new f.m.PermissionManager({ agentDir: f.agentDir });
  shared.configureForCwd(f.source_cwd);
  const sharedResolver = new f.m.PermissionResolver(shared, { getRuleset: () => [] });
  const sharedNormalizer = new f.m.PathNormalizer(f.m.posixPathFlavor, f.source_cwd);
  const originalHome = process.env.HOME;
  try {
    // A fixture-owned HOME also tests a genuine ~ repository-prefix rule;
    // no credentials or user's state directory are read or created.
    process.env.HOME = f.base;
    for (const pattern of [join(f.source_root, "secret/*"), `~/${relative(f.base, f.source_root)}/secret/*`]) {
      json(projectConfig(f.source_cwd), { permission: { path_read: { [pattern]: "deny" } } });
      assert.deepEqual(f.manager.getConfigIssues("editor"), []);
      assert.equal(sharedResolver.resolve({ kind: "access-path", surface: "path_read",
        path: sharedNormalizer.forPath("../secret/k.txt"), agentName: "editor" }).state, "deny", "shared control");
      const readGate = f.m.describePathGate(f.tcc({ path: "../secret/k.txt" }), f.resolver, f.session.getPathNormalizer());
      assert.ok(readGate, `own nested sibling must produce a deny gate: ${pattern}`);
      assert.equal(readGate.preCheck.state, "deny", `own nested sibling: ${pattern}`);
      assert.ok(readGate.promptDetails.accessIntent.matchValues.includes(join(f.checkout_root, "secret/k.txt")));
      assert.deepEqual(readGate.promptDetails.accessIntent.workspacePolicyValues, [join(f.source_root, "secret/k.txt")]);
      for (const command of ["cat ../secret/k.txt", "git show HEAD:secret/k.txt", "git diff -- ../secret/k.txt"]) {
        const program = await f.m.BashProgram.parse(command, f.session.getPathNormalizer());
        assert.equal(program.commandText(), command, "classification never rewrites the command");
        const gate = f.m.describeBashPathGate(f.tcc({ command }, "bash"), program, f.resolver, f.session.getPathNormalizer());
        assert.equal(gate?.preCheck.state, "deny", command);
      }
      const external = f.m.describeExternalDirectoryGate(f.tcc({ path: "../secret/k.txt" }), [], f.resolver, f.session.getPathNormalizer());
      assert.equal(external.preCheck.state, "allow", "fixture /tmp/* external allowance does not erase the independent path deny");
    }
    assert.equal(f.check("local.env").state, "deny", "seed suffix denies do not need repository-prefix aliases");
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  }
});

test("workspace runtime: other checkouts stay external and ordinary persistent paths ask under the real seed", async (t) => {
  const f = await fixture(t, { seed: true, nested: true });
  const normalizer = f.session.getPathNormalizer();
  // Read-only lookups for not-created persistent paths, no writes outside the
  // test root. Actual allocation and its state-root selection have local-Git tests.
  const other = "/home/alehouse-fixture/.local/state/pi-alehouse/worktrees/other/tree/secret/k.txt";
  assert.deepEqual(source.workspacePolicyAliases(f.session.getWorkspacePolicy(), [other]), []);
  const gate = f.m.describeExternalDirectoryGate(f.tcc({ path: other }), [], f.resolver, normalizer);
  assert.equal(gate.preCheck.state, "ask", "a different checkout is not imported as own-source deny or exempted as /tmp");
  const sharedManager = new f.m.PermissionManager({ agentDir: f.agentDir });
  sharedManager.configureForCwd(f.source_cwd);
  const sharedResolver = new f.m.PermissionResolver(sharedManager, { getRuleset: () => [] });
  const shared = f.m.describeExternalDirectoryGate({ ...f.tcc({ path: other }), workspacePolicy: undefined }, [], sharedResolver, normalizer);
  assert.equal(shared.preCheck.state, "ask", "unbound callers also retain the ordinary external gate");
  json(projectConfig(f.source_cwd), { permission: { external_directory_read: { [other]: "allow" } } });
  assert.equal(f.m.describeExternalDirectoryGate(f.tcc({ path: other }), [], f.resolver, normalizer).preCheck.state, "allow",
    "explicit external allows are still meaningful; relocation is not isolation");
});

test("workspace runtime: raw global/project denies and specific asks survive higher-scope and session allows", async (t) => {
  const f = await fixture(t, { rules: [{ surface: "path_read", pattern: "*", action: "allow", layer: "session", origin: "session" }] });
  json(f.globalPath, { permission: { ...baseline(), path_read: {
    [join(f.source_cwd, "global-denied")]: "deny", [join(f.source_cwd, "global-ask")]: "ask",
  } } });
  json(projectConfig(f.source_cwd), { permission: { path_read: {
    "*": "allow", [join(f.source_cwd, "global-denied")]: "allow", [join(f.source_cwd, "global-ask")]: "allow",
    [join(f.source_cwd, "project-denied")]: "deny", [join(f.source_cwd, "project-ask")]: "ask",
  } } });
  mkdirSync(join(f.source_cwd, ".pi/agents"), { recursive: true });
  writeFileSync(join(f.source_cwd, ".pi/agents/editor.md"), `---\npermission:\n  path_read:\n    '*': allow\n    '${join(f.source_cwd, "project-denied")}': allow\n    '${join(f.source_cwd, "project-ask")}': allow\n---\n`);
  for (const file of ["global-denied", "project-denied"]) assert.equal(f.check(file).state, "deny");
  for (const file of ["global-ask", "project-ask"]) assert.equal(f.check(file).state, "allow", "ordinary session approval satisfies asks");
  const withoutGrant = new f.m.PermissionResolver(f.manager, { getRuleset: () => [] });
  for (const file of ["global-ask", "project-ask"]) assert.equal(withoutGrant.resolve({ kind: "access-path", surface: "path_read",
    path: f.session.getPathNormalizer().forPath(file), agentName: "editor" }).state, "ask");
});

test("workspace runtime: aliases cannot import ALLOW, weaken actual denies, or bypass the resource floor", async (t) => {
  const f = await fixture(t, { protection: dirs => Object.freeze({ version: 1, writeRoots: [], readFiles: [],
    writeFiles: [join(dirs.cwd, "protected")] }) });
  json(projectConfig(f.source_cwd), { permission: { path_read: { "*": "ask", [join(f.source_cwd, "source-allowed")]: "allow",
    [join(f.cwd, "actual-denied")]: "deny", [join(f.source_cwd, "actual-denied")]: "allow" }, path_write: "allow" } });
  assert.equal(f.check("source-allowed").state, "ask", "source exact ALLOW is not imported");
  assert.equal(f.check("actual-denied").state, "deny", "source ALLOW cannot erase a real-path deny");
  assert.equal(f.check("protected", "path_write").state, "deny", "floor still checks execution effects");
});

test("workspace runtime: source project-agent rules and source trust decision are respected", async (t) => {
  const f = await fixture(t);
  const warnings = [];
  const lifecycle = new f.m.SessionLifecycleHandler(f.session, f.resolver, { activate() {} },
    { debug() {}, review() {}, warn: message => warnings.push(message) }, {});
  await lifecycle.handleSessionStart({ reason: "start" }, f.ctx);
  await lifecycle.handleResourcesDiscover({ reason: "reload" }, f.ctx);
  assert.deepEqual(warnings, [], "worktree trust=false must not report source project scope skipped");
  assert.throws(() => f.session.resetForNewSession(context(randomUUID(), f.cwd), true), /binding mismatch/);
  assert.throws(() => f.store.refresh(context(randomUUID(), f.cwd), true), /binding mismatch/);
  mkdirSync(join(f.source_cwd, ".pi/agents"), { recursive: true });
  writeFileSync(join(f.source_cwd, ".pi/agents/editor.md"), "---\npermission:\n  path_read:\n    '*.agent-secret': deny\n    '*.agent-review': ask\n---\n");
  assert.equal(f.check("file.agent-secret").state, "deny");
  assert.equal(f.check("file.agent-review").state, "ask");
  assert.equal(f.check("file.agent-secret", "path_read", "researcher").state, "allow", "project agent is scoped by identity");
  const untrusted = await fixture(t, { trusted: false, project: { yoloMode: true, permission: { path_read: "deny" } } });
  assert.equal(untrusted.store.current().yoloMode, false);
  assert.equal(untrusted.check("file").state, "allow", "untrusted source project policy is withheld even if worktree is trusted");
  untrusted.session.resetForNewSession({ ...untrusted.ctx, isProjectTrusted: () => true }, true);
  assert.equal(untrusted.check("file").state, "allow");
});

test("workspace runtime: yolo cannot erase source deny or invalid source config floor; live updates reload normally", async (t) => {
  const f = await fixture(t, { yolo: true, project: { permission: { path_read: { "*.secret": "deny", "*.review": "ask" } } } });
  assert.equal(f.check("file.secret").state, "deny");
  assert.equal(f.check("file.review").state, "allow");
  writeFileSync(projectConfig(f.source_cwd), "{ invalid JSON");
  const invalid = f.check("ordinary");
  assert.equal(invalid.state, "ask");
  assert.equal(invalid.origin, "fail-closed");
  assert.ok(f.manager.getConfigIssues("editor").length > 0);
  json(projectConfig(f.source_cwd), { permission: { path_read: { "*.secret": "allow", "ordinary": "deny" } } });
  assert.equal(f.check("file.secret").state, "allow", "source policy is queried normally, not frozen/copied");
  assert.equal(f.check("ordinary").state, "deny");
});

test("workspace runtime: outside paths retain normal composition and no source aliases", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "outside");
  json(f.globalPath, { permission: { ...baseline(), path_read: { [outside]: "deny" } } });
  json(projectConfig(f.source_cwd), { permission: { path_read: { [outside]: "allow" } } });
  assert.equal(f.check(outside).state, "allow", "no workspace-only raw-scope lane for external targets");
  assert.deepEqual(source.workspacePolicyAliases(source.workspacePolicyForContext(f.ctx), [outside]), []);
});

test("workspace runtime: forwarded path/tool asks preserve restriction values across IO and serving policy", async (t) => {
  const f = await fixture(t);
  const exact = join(f.source_cwd, "review");
  json(projectConfig(f.source_cwd), { permission: { path_read: { [exact]: "ask" }, read: { [exact]: "ask" } } });
  const gate = f.m.describePathGate(f.tcc({ path: "review" }), f.resolver, f.session.getPathNormalizer());
  assert.equal(gate.preCheck.state, "ask");
  const parent = randomUUID(), registry = f.m.getSubagentSessionRegistry();
  registry.register(f.sessionId, { parentSessionId: parent });
  t.after(() => registry.unregister(f.sessionId));
  const intent = { ...gate.promptDetails.accessIntent, requesterCwd: f.cwd, principal: { sessionId: f.sessionId, agentName: "editor" } };
  assert.deepEqual(intent.workspacePolicyValues, [exact]);
  assert.ok(intent.matchValues.includes(join(f.cwd, "review")));
  const requestPath = join(f.base, "forwarded.json");
  json(requestPath, { id: "fixture", createdAt: Date.now(), requesterSessionId: f.sessionId, targetSessionId: parent,
    requesterAgentName: "editor", accessIntent: intent });
  const request = f.m.readForwardedPermissionRequest(null, requestPath);
  assert.ok(request, "well-formed synthetic forwarded request must survive IO");
  assert.equal(request.requesterSessionId, f.sessionId);
  assert.equal(request.accessIntent.principal.sessionId, f.sessionId);
  assert.deepEqual(request.accessIntent.workspacePolicyValues, [exact]);
  const parentManager = new f.m.PermissionManager({ agentDir: f.agentDir });
  parentManager.configureForCwd(f.source_cwd);
  const parentResolver = new f.m.PermissionResolver(parentManager, { getRuleset: () => [] });
  const serve = wire => parentResolver.resolve({
    ...f.m.buildResolvedIntentFromMatchValues(wire.surface, wire.matchValues, wire.principal.agentName),
    workspacePolicyValues: f.m.workspacePolicyForwardedValues(wire, parent, registry),
  });
  assert.equal(serve(request.accessIntent).state, "ask", "parent does not reinterpret relative path via its cwd");
  json(projectConfig(f.source_cwd), { permission: { path_read: { [exact]: "deny" }, read: { [exact]: "ask" } } });
  assert.equal(serve(request.accessIntent).state, "deny", "live parent deny applies through restriction alias");
  assert.throws(() => serve({ ...intent, requesterCwd: f.source_cwd }), /cwd mismatch/);
  assert.throws(() => serve({ ...intent, workspacePolicyValues: [] }), /restriction values mismatch/);
  assert.equal(intent.workspacePolicyValues.length, 1);
  assert.throws(() => serve({ ...intent, workspacePolicyValues: [join(f.source_cwd, "forged")] }), /restriction values mismatch/,
    "same-length forged aliases require content comparison, not merely array/length checks");
  assert.throws(() => serve({ ...intent, principal: { ...intent.principal, sessionId: randomUUID() } }), /binding is missing/);
  const toolCheck = f.check("review", "read");
  assert.equal(toolCheck.state, "ask");
  const toolGate = f.m.describeToolGate(f.tcc({ path: "review" }), toolCheck, { getPermissionLogContext: () => ({}), formatToolInputForPrompt: () => "" },
    { path: f.session.getPathNormalizer().forPath("review"), approvalPattern: join(f.cwd, "review") });
  assert.deepEqual(toolGate.promptDetails.accessIntent.workspacePolicyValues, [exact]);
  f.lease.release();
  assert.throws(() => serve(intent), /released/);
  assert.ok(readFileSync(requestPath, "utf8").includes(exact), "synthetic wire captured source restrictions, not configuration copies");
});

test("workspace runtime: release invalidates cached policy and an in-flight approval without affecting other children", async (t) => {
  const f = await fixture(t), other = await fixture(t);
  assert.equal(f.check("ordinary").state, "allow");
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const handler = new f.m.PermissionGateHandler(f.session,
    { getAll: () => [{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } }] },
    { evaluate: () => pending }, {}, {});
  const call = handler.handleToolCall({ toolName: "read", input: { path: "ordinary" }, toolCallId: "fixture" }, f.ctx);
  f.lease.release(); finish({ action: "allow" });
  await assert.rejects(call, /stale or forged|released/);
  assert.throws(() => f.check("ordinary"), /stale or forged/);
  assert.throws(() => f.session.activate(f.ctx), /stale or forged|released/);
  assert.throws(() => f.session.refreshConfig(f.ctx, true), /released/);
  assert.equal(other.check("ordinary").state, "allow");
});

test("workspace runtime: forwarded server serves omitted-path tool asks with empty restriction values", async (t) => {
  const f = await forwardingFixture(t, { project: { permission: { ls: "ask", find: "ask", grep: "ask" } } });
  const inputs = { ls: {}, find: { pattern: "*.ts" }, grep: { pattern: "needle" } };
  const intents = {};
  let served = 0;
  for (const [tool, input] of Object.entries(inputs)) {
    // The pipeline's own per-tool resolution for a path-bearing tool called
    // without a path: the raw tool intent, never a guessed default cwd path.
    const toolCheck = f.resolver.resolve({ kind: "tool", surface: tool, input, agentName: "editor" });
    assert.equal(toolCheck.state, "ask", `${tool}: valid per-tool ask from the bound session`);
    const gate = f.m.describeToolGate(f.tcc(input, tool), toolCheck,
      { getPermissionLogContext: () => ({}), formatToolInputForPrompt: () => "" });
    const intent = { ...gate.promptDetails.accessIntent, requesterCwd: f.cwd,
      principal: { sessionId: f.sessionId, agentName: "editor" } };
    intents[tool] = intent;
    assert.deepEqual(intent.workspacePolicyValues, [], `${tool}: bound path surface carries a present, empty alias array`);
    assert.deepEqual(intent.matchValues, [tool], `${tool}: match values stay the child's original value`);
    assert.equal(intent.boundaryValue, null, `${tool}: no-path facts carry no boundary path`);
    const forwarded = f.forward(intent);
    const request = f.m.readForwardedPermissionRequest(null, forwarded.requestPath);
    assert.deepEqual(request.accessIntent.workspacePolicyValues, [], `${tool}: empty restriction values survive the wire`);
    assert.deepEqual(request.accessIntent.matchValues, [tool], `${tool}: wire preserves the child's facts`);
    assert.equal(request.accessIntent.principal.agentName, "editor", `${tool}: internal editor principal is preserved`);
    assert.equal(request.accessIntent.principal.sessionId, f.sessionId, `${tool}: bound child session is preserved`);
    assert.equal(request.accessIntent.requesterCwd, f.cwd, `${tool}: requester cwd stays the worktree`);
    const response = await f.serve(forwarded);
    assert.equal(response.approved, true, `${tool}: stub human approval approves the real parent ask`);
    assert.equal(response.responderSessionId, f.parent);
    assert.equal(response.decidedBy?.kind, "user", `${tool}: approval comes from the escalated ask`);
    assert.equal(f.calls.escalator, ++served, `${tool}: exactly one escalation`);
    assert.equal(f.calls.resolve, served, `${tool}: serving resolution ran for the request`);
  }
  // A matched live deny resolves by rule without escalation: the frozen
  // ask-time facts are re-served, never re-derived from the parent's cwd.
  json(projectConfig(f.source_cwd), { permission: { ls: "deny", find: "ask", grep: "ask" } });
  const denied = await f.serve(f.forward(intents.ls));
  assert.equal(denied.approved, false, "live source deny resolves by rule");
  assert.equal(denied.decidedBy?.kind, "rule");
  assert.equal(f.calls.escalator, served, "a matched deny never escalates");
  assert.equal(f.calls.resolve, served + 1, "the deny control still reached serving resolution");
});

test("workspace runtime: forwarded server verifier failures answer denied gate_error instead of hanging", async (t) => {
  const cases = [
    { name: "omitted workspace policy values", forge: () => ({ workspacePolicyValues: undefined }),
      reason: /restriction values mismatch/ },
    { name: "forged workspace policy values", forge: () => ({ workspacePolicyValues: ["/forged/workspace/alias"] }),
      reason: /restriction values mismatch/ },
    { name: "serving session is not the direct parent", wrongParent: true, reason: /parent mismatch/ },
    { name: "released workspace binding", release: true, reason: /released/ },
  ];
  for (const c of cases) {
    const f = await forwardingFixture(t, { wrongParent: c.wrongParent, project: { permission: { ls: "ask" } } });
    const toolCheck = f.resolver.resolve({ kind: "tool", surface: "ls", input: {}, agentName: "editor" });
    assert.equal(toolCheck.state, "ask", `${c.name}: fixture starts from a valid ask`);
    const gate = f.m.describeToolGate(f.tcc({}, "ls"), toolCheck,
      { getPermissionLogContext: () => ({}), formatToolInputForPrompt: () => "" });
    const intent = { ...gate.promptDetails.accessIntent, requesterCwd: f.cwd,
      principal: { sessionId: f.sessionId, agentName: "editor" }, ...(c.forge ? c.forge() : {}) };
    if (c.release) f.lease.release();
    const response = await f.serve(f.forward(intent));
    assert.equal(response.approved, false, `${c.name}: verification failure denies`);
    assert.equal(response.state, "denied_with_reason", `${c.name}: denial is an explicit recorded response`);
    assert.equal(response.decidedBy?.kind, "gate_error", `${c.name}: the gate, not the human or a rule, decided`);
    assert.match(response.decidedBy?.reason ?? "", c.reason, c.name);
    assert.equal(f.calls.policy, 1, `${c.name}: the server entered its serving policy once`);
    assert.equal(f.calls.resolve, 0, `${c.name}: verification failed before any serving resolution`);
    assert.equal(f.calls.escalator, 0, `${c.name}: verification failures never escalate`);
  }
  // The strict principal-mismatch guard still precedes the policy call and is
  // covered by the existing forwarded-principal suite; it is untouched here.
});
