// Reader scratch: behavioral contract tests for the per-reader private scratch
// design. The trusted child factory — never configuration — creates a fresh
// /tmp/pi-alehouse-reader-XXXXXX directory bound to the exact child session ID.
// The profile-wide scratch exception is gone: only a per-call opaque token
// begun at the real SDK tool boundary for the actual built-in write tool can
// relax the reader's blanket path_write catch-all, and the token proves the
// originating session, the exact original input.path, and the live lease.
// The write-tool guard consumes the very same PermissionSession resolver the
// permission gate uses (never an independent branch/prompt parser) and trusts
// only the SDK's built-in write tool. Bash sends real path facts and never a
// token, so detectable writes and unproven targets — including registered
// scratch — stay denied; immutable resource matches and ordinary specific
// denies still hit real paths when a floor is removed or modified externally.
// Forwarded asks reach the serving parent's recorded-policy edge only through
// a live token whose principal matches the request envelope. Only public
// manager/resolver/gate/schema/service APIs plus the scratch helpers and the
// real gate handler are exercised; fixtures are synthetic temporary paths, no
// model or network is touched, and no shell command is executed (BashProgram
// is static analysis). This is detectable-path policy, not an OS sandbox.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { packageRoot, protectionResources } from "../../bin/runtime-support.mjs";
import { initialize } from "../../scripts/init.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const aliases = {
  "@earendil-works/pi-coding-agent": join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
};
const jiti = createJiti(import.meta.url, { alias: aliases });
const vendorSrc = join(packageRoot, "runtime/permission-system/vendor/src");
const load = (name) => jiti.import(join(vendorSrc, `${name}.ts`));
const [{ PermissionManager }, { PermissionResolver }, { PathNormalizer }, { posixPathFlavor }, { BashProgram },
  { resolveBashCommandCheck }, { describeBashPathGate }, { describeBashExternalDirectoryGate },
  { validateUnifiedConfig }, { buildPermissionsJsonSchema }, { initializeManagedResourceProtection },
  scratchModule, { PermissionSession }, { SubagentSessionRegistry }, { createPermissionForwardingLocation },
  { readForwardedPermissionRequest }, { ForwardedRequestServer }, { LocalPermissionsService },
  { PermissionGateHandler }] =
  await Promise.all([
    load("policy/permission-manager"), load("policy/permission-resolver"), load("path/path-normalizer"),
    load("path/path-flavor"), load("access-intent/bash/program"), load("handlers/gates/bash-command"),
    load("handlers/gates/bash-path"), load("handlers/gates/bash-external-directory"),
    load("config/config-loader"), load("config/config-schema"), load("policy/managed-resource-protection"),
    load("policy/managed-reader-scratch"), load("session/permission-session"),
    load("authority/subagent-registry"), load("authority/permission-forwarding"),
    load("authority/forwarding-io"), load("authority/forwarded-request-server"),
    load("service/permissions-service"), load("handlers/permission-gate-handler"),
  ]);
const { createReaderScratch, readerScratchDirectories, readerScratchContains, readerScratchAgentScope,
  installReaderScratchGuard, beginReaderScratchWrite, readerScratchWriteMatches,
  readerScratchForwardedWrite, readerScratchWriteAgent } = scratchModule;

const scratchBase = (t) => {
  const base = mkdtempSync(join(tmpdir(), "alehouse-reader-scratch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};
// The scratch and per-call-request registries are process-global: every lease
// needs its own synthetic session ID and must be revoked and removed before
// the test ends, and every begun token must be released.
const leaseFor = (t, session = randomUUID()) => {
  const lease = createReaderScratch(session);
  t.after(() => { lease.release(); rmSync(lease.directory, { recursive: true, force: true }); });
  return lease;
};
const agentsFixture = (agentDir, names = ["reader", "researcher", "editor"]) => {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const name of names) cpSync(join(packageRoot, "runtime/agents", `${name}.md`), join(agentDir, "agents", `${name}.md`));
};
// The ordinary rules the reader's blanket deny would shadow: a bare `path`
// allow for reads, an ordinary path_write catch-all ask, and specific
// asks/denies. `write: "ask"` is the ordinary global write rule the exposed
// reader write tool falls through to.
const managedPermission = () => ({
  "*": "ask",
  path: { "*": "allow", "*.env": "deny" },
  path_write: { "*": "ask", "*.key": "ask", "*.pem": "deny" },
  external_directory: { "*": "ask" },
  bash: { "*": "ask" },
  read: "allow", write: "ask", edit: "allow",
});
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };
const makeManager = (configPath, agentsDir, options = {}) =>
  new PermissionManager({ globalConfigPath: configPath, agentsDir, mcpServerNames: [], ...options });
const makeResolver = (manager, grants = []) => new PermissionResolver(manager, { getRuleset: () => grants });
// A path-values intent; the optional third argument is the per-call scratch
// write context a begun request carries into the manager.
const writeIntent = (values, agentName = "reader", context) =>
  ({ kind: "path-values", surface: "path_write", values, agentName, ...(context ? { readerScratchWrite: context } : {}) });
const sessionRule = (action) => ({ surface: "path_write", pattern: "*", action, layer: "session", origin: "session" });
// The MAIN fixture: a registered reader scratch plus the managed agent profiles.
const core = (t, extraConfig = {}, options = {}) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const agentDir = join(base, "agent");
  agentsFixture(agentDir);
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  writeJson(configPath, { permission: managedPermission(), ...extraConfig });
  const manager = makeManager(configPath, join(agentDir, "agents"), options);
  return { base, dir: lease.directory, lease, session, agentDir, configPath, cwd: join(base, "repo"), manager, resolver: makeResolver(manager) };
};
const bashGates = async (command, resolver, cwd, agentName = "reader") => {
  const program = await BashProgram.parse(command, new PathNormalizer(posixPathFlavor, cwd));
  const context = { toolCallId: "fixture", toolName: "bash", cwd, agentName };
  return {
    program,
    path: describeBashPathGate(context, program, resolver, new PathNormalizer(posixPathFlavor, cwd)),
    bash: () => resolveBashCommandCheck(program.commandText(), program.commands(), agentName, resolver),
    external: () => describeBashExternalDirectoryGate(context, program, resolver, new PathNormalizer(posixPathFlavor, cwd)),
  };
};

// ── Guard / begin fixtures ─────────────────────────────────────────────────
// The exact built-in write sourceInfo shape the guard and begin require, as
// `pi.getAllTools()` reports it for the SDK's built-in tools.
const toolInfo = (name, sourceInfo) => ({ name, sourceInfo });
const builtinToolInfo = (name) => toolInfo(name, { source: "builtin", path: `builtin:${name}` });
const builtinTools = () => [builtinToolInfo("read"), builtinToolInfo("write")];
// A fake extension API capturing the guard's handlers and exposing a tool list.
const guardPi = (tools, { withoutGetAllTools = false } = {}) => {
  const handlers = new Map();
  const pi = { handlers, on: (event, handler) => handlers.set(event, handler) };
  if (!withoutGetAllTools) pi.getAllTools = () => tools ?? builtinTools();
  return pi;
};
const entry = (name) => ({ type: "custom", customType: "active_agent", data: { name } });
// A real-shaped extension context: the identity readers the PermissionSession
// resolver uses (getEntries/getBranch) plus the session id.
const sessionCtx = ({ sessionId, entries = [], branch = entries } = {}) => ({
  cwd: "/tmp",
  sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => sessionId },
});
const guardOutcome = (pi, event, ctx) => {
  assert.ok(pi.handlers.has("tool_call"), "the guard registered a tool_call handler");
  const result = pi.handlers.get("tool_call")(event, ctx);
  return result?.block === true ? "blocked" : "allowed";
};
const writeEvent = (path) =>
  ({ toolCallId: "fixture", toolName: "write", input: typeof path === "string" ? { path } : (path ?? {}) });
const newPermissionSession = () => new PermissionSession(
  {}, { start() {}, stop() {} }, {}, {}, {}, { activate() {}, deactivate() {} }, posixPathFlavor);
// beginReaderScratchWrite's refusal cases must stay fail-closed: a thrown
// validation is as good as an undefined return, but a grant must never appear.
const beginRefusal = (ctx, toolName, agentName, input, tools) => {
  try { return beginReaderScratchWrite(ctx, toolName, agentName, input, tools) === undefined; }
  catch { return true; }
};
// The per-call request registry is process-global behind a Symbol.for key, so
// tests can observe token lifetimes (held across awaits, retired on exit).
const writeRequests = () => {
  const registry = globalThis[Symbol.for("pi-alehouse:reader-scratch:write-requests:v1")];
  assert.ok(registry instanceof Map, "the per-call write-request registry is process-global");
  return registry;
};
// A hand-frozen protection snapshot for one fixture file, avoiding the
// process-global initialize (which the trust-input test owns for this file).
const fileProtection = (paths) => Object.freeze({
  version: 1,
  writeRoots: Object.freeze([]),
  readFiles: Object.freeze([]),
  writeFiles: Object.freeze(paths),
});

test("createReaderScratch issues a fresh private directory per session", (t) => {
  assert.equal(typeof scratchModule.readerScratchMatches, "undefined",
    "the profile-wide global scan helper is removed from the contract surface");
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = createReaderScratch(session);
  t.after(() => { lease.release(); rmSync(lease.directory, { recursive: true, force: true }); });
  const dir = lease.directory;
  assert.match(dir, /^\/tmp\/pi-alehouse-reader-/, "the directory name is generated, never caller-selected");
  assert(!dir.startsWith(base), "no caller-selected path");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "the directory is owner-only");
  assert.equal(readdirSync(dir).length, 0, "creation never reuses or overwrites an existing directory");
  assert.ok(readerScratchDirectories().includes(dir));
  assert.ok(readerScratchContains(session, join(dir, "out.txt")));
  const second = createReaderScratch(randomUUID());
  t.after(() => { second.release(); rmSync(second.directory, { recursive: true, force: true }); });
  assert.notEqual(second.directory, dir, "each session gets a distinct directory");
  assert.ok(readerScratchDirectories().includes(second.directory));
  assert.throws(() => createReaderScratch(session), /already assigned/, "an assigned session is never overwritten");
  assert.throws(() => createReaderScratch(""), /Invalid reader session/);
});

test("release revokes the lease and its live tokens while successful reports persist", (t) => {
  const session = randomUUID();
  const lease = createReaderScratch(session);
  const dirs = [lease.directory];
  t.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const artifact = join(lease.directory, "report.md");
  const ctx = { sessionManager: { getSessionId: () => session } };
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: artifact }, builtinTools());
  assert.ok(grant, "a live lease begins a write request");
  writeFileSync(artifact, "fixture\n");
  assert.equal(readerScratchWriteMatches(grant.context, [artifact]), true);
  lease.release();
  assert.equal(readFileSync(artifact, "utf8"), "fixture\n", "successful reports persist after the revocation");
  assert.ok(statSync(lease.directory).isDirectory(), "the directory itself survives");
  assert(!readerScratchDirectories().includes(lease.directory), "the root leaves the registry listing");
  assert.equal(readerScratchContains(session, artifact), false);
  assert.equal(readerScratchWriteMatches(grant.context, [artifact]), false, "revocation voids live write tokens");
  assert.equal(beginReaderScratchWrite(ctx, "write", "reader", { path: artifact }, builtinTools()), undefined,
    "no new request begins against a released lease");
  lease.release(); // Revocation is idempotent.
  const reissued = createReaderScratch(session);
  dirs.push(reissued.directory);
  assert.notEqual(reissued.directory, lease.directory, "a revoked slot can be reassigned to a fresh directory");
  assert.equal(readerScratchWriteMatches(grant.context, [artifact]), false, "a reassigned slot never revives an old token");
  reissued.release();
});

test("the Symbol-backed registries are shared across jiti loads and isolated per session", async (t) => {
  const secondJiti = createJiti(import.meta.url, { alias: aliases });
  const other = await secondJiti.import(join(vendorSrc, "policy/managed-reader-scratch.ts"));
  const firstSession = randomUUID(), secondSession = randomUUID();
  const a = createReaderScratch(firstSession);
  const b = other.createReaderScratch(secondSession);
  t.after(() => {
    a.release(); b.release();
    rmSync(a.directory, { recursive: true, force: true });
    rmSync(b.directory, { recursive: true, force: true });
  });
  assert.ok(other.readerScratchDirectories().includes(a.directory), "a second jiti load sees the first lease");
  assert.ok(readerScratchDirectories().includes(b.directory), "the first load sees the second lease");
  // The per-call request registry is equally process-global.
  const target = join(a.directory, "out.txt");
  const grant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => firstSession } }, "write", "reader", { path: target }, builtinTools());
  assert.ok(grant);
  assert.equal(other.readerScratchWriteMatches(grant.context, [target]), true, "the token registry spans jiti loads");
  assert.equal(other.readerScratchWriteAgent(grant.context.token, firstSession), "reader");
  assert.equal(readerScratchWriteMatches({ sessionId: secondSession, token: grant.context.token }, [target]), false,
    "the token stays bound to its own session");
  grant.release();
});

test("scratch matching accepts only clean absolute spellings inside the bound directory", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const peer = leaseFor(t);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(base, "evil.txt"), "fixture\n");
  writeFileSync(join(dir, "real.txt"), "fixture\n");
  writeFileSync(join(dir, "leaf.txt"), "fixture\n");
  symlinkSync(join(dir, "real.txt"), join(dir, "link-in"));
  symlinkSync(join(base, "evil.txt"), join(dir, "escape"));
  symlinkSync(join(dir, "out.txt"), join(base, "in-link"));
  linkSync(join(base, "evil.txt"), join(dir, "hard"));
  const contains = (path) => readerScratchContains(session, path);
  // Clean own spellings: existing regular files and missing descendants below
  // an inspected directory.
  for (const path of [join(dir, "out.txt"), join(dir, "made", "deep", "new.txt"), join(dir, "leaf.txt")])
    assert.equal(contains(path), true, `contained: ${path}`);
  // The per-call context rides only its own session's values; there is no
  // profile-wide scan that could span reader children.
  const grant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => session } }, "write", "reader",
    { path: join(dir, "out.txt") }, builtinTools());
  assert.ok(grant);
  assert.equal(readerScratchWriteMatches(grant.context, [join(dir, "out.txt")]), true, "own-session values ride the token");
  grant.release();
  // Everything else fails closed: source, the tmp root itself, other sessions'
  // directories, unnormalized or suspicious spellings, aliasing escapes, any
  // descendant symlink (even an in-root target), and non-directory ancestors.
  for (const [label, path] of [
    ["source path", join(base, "source.txt")],
    ["tmp root", "/tmp"],
    ["other session scratch", join(peer.directory, "out.txt")],
    ["relative", "out.txt"],
    ["project shorthand", "@/out.txt"],
    ["home shorthand", "~/out.txt"],
    ["wrapped quotes", `'${join(dir, "q.txt")}'`],
    ["padded", ` ${join(dir, "q.txt")} `],
    ["dot segment", `${dir}/./out.txt`],
    ["dotdot segment", `${dir}/sub/../out.txt`],
    ["control character", `${dir}/a\nb.txt`],
    ["escaping symlink", join(dir, "escape")],
    ["in-root symlink", join(dir, "link-in")],
    ["non-directory ancestor", join(dir, "leaf.txt", "new.txt")],
    ["hardlink to outside", join(dir, "hard")],
    ["outside alias into the scratch", join(base, "in-link")],
  ]) assert.equal(contains(path), false, `${label} fails closed`);
  // Retargeting the bound directory itself breaks root identity. The populated
  // original is preserved under the base (renamed, not deleted), so the
  // after-hook cleanup removes both it and the replacement symlink.
  const target = join(base, "retarget");
  const original = join(base, "retarget-original");
  mkdirSync(target);
  renameSync(dir, original);
  symlinkSync(target, dir, "dir");
  assert.equal(contains(join(dir, "out.txt")), false, "a retargeted root fails closed");
  assert(!readerScratchDirectories().includes(dir), "an invalid root leaves the registry listing");
});

test("beginReaderScratchWrite issues an opaque per-call token only for the real built-in write tool", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const peer = leaseFor(t);
  const dir = lease.directory;
  const ctx = { sessionManager: { getSessionId: () => session } };
  const target = join(dir, "report.md");
  const begin = (ctxArg = ctx, toolName = "write", agentName = "reader", input = { path: target }, tools = builtinTools()) =>
    beginReaderScratchWrite(ctxArg, toolName, agentName, input, tools);
  const grant = begin();
  assert.ok(grant, "a clean own-scratch write begins a request");
  assert.equal(grant.context.sessionId, session, "the session is the actual SDK session from ctx");
  assert.ok(typeof grant.context.token === "string" && grant.context.token.length > 0, "the token is a non-empty string");
  assert.notEqual(grant.context.token, session, "the token is not the session id");
  assert.notEqual(grant.context.token, target, "the token is not the path");
  assert.ok(Object.isFrozen(grant.context), "the context is immutable");
  assert.equal(typeof grant.release, "function");
  assert.equal(readerScratchWriteMatches(grant.context, [target]), true);
  // Each call gets a fresh opaque random token, and release retires exactly
  // its own token.
  const second = begin();
  assert.ok(second);
  assert.notEqual(second.context.token, grant.context.token, "per-call tokens are fresh random values");
  assert.equal(readerScratchWriteMatches(second.context, [target]), true);
  grant.release();
  assert.equal(readerScratchWriteMatches(grant.context, [target]), false, "release revokes the token");
  assert.equal(readerScratchWriteMatches(second.context, [target]), true, "a sibling request keeps its own token");
  second.release();
  grant.release(); // Idempotent.
  assert.equal(readerScratchWriteMatches(grant.context, [target]), false);
  // Every refusal below stays fail-closed: undefined or throw, never a grant.
  const builtinRead = () => builtinToolInfo("read");
  for (const [label, [ctxArg, toolName, agentName, input, tools]] of [
    ["non-write edit tool", [ctx, "edit", "reader", { path: target }, builtinTools()]],
    ["non-write bash tool", [ctx, "bash", "reader", { path: target }, builtinTools()]],
    ["non-reader identity", [ctx, "write", "editor", { path: target }, builtinTools()]],
    ["null identity", [ctx, "write", null, { path: target }, builtinTools()]],
    ["no write tool at all", [ctx, "write", "reader", { path: target }, [builtinRead()]]],
    ["extension write tool", [ctx, "write", "reader", { path: target }, [toolInfo("write", { source: "extension", path: "/evil/extension.ts" })]]],
    ["mismatched builtin path", [ctx, "write", "reader", { path: target }, [toolInfo("write", { source: "builtin", path: "builtin:edit" })]]],
    ["duplicate write tools", [ctx, "write", "reader", { path: target }, [builtinToolInfo("write"), builtinToolInfo("write")]]],
    ["missing input path", [ctx, "write", "reader", {}, builtinTools()]],
    ["non-string path", [ctx, "write", "reader", { path: 42 }, builtinTools()]],
    ["relative path", [ctx, "write", "reader", { path: "report.md" }, builtinTools()]],
    ["peer scratch", [ctx, "write", "reader", { path: join(peer.directory, "out.txt") }, builtinTools()]],
    ["outside the scratch", [ctx, "write", "reader", { path: join(base, "outside.txt") }, builtinTools()]],
    ["dotdot escape", [ctx, "write", "reader", { path: `${dir}/../escape.txt` }, builtinTools()]],
    ["raw Unicode space", [ctx, "write", "reader", { path: `${dir}/blocked\u00a0name.txt` }, builtinTools()]],
    ["missing session in ctx", [{}, "write", "reader", { path: target }, builtinTools()]],
    ["unknown session", [{ sessionManager: { getSessionId: () => randomUUID() } }, "write", "reader", { path: target }, builtinTools()]],
    ["empty tool list", [ctx, "write", "reader", { path: target }, []]],
  ]) assert.ok(beginRefusal(ctxArg, toolName, agentName, input, tools), `refused: ${label}`);
});

test("readerScratchWriteMatches binds the live token to its session, exact original path, and current lease", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const peer = leaseFor(t);
  const ctx = { sessionManager: { getSessionId: () => session } };
  const target = join(dir, "out.txt");
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: target }, builtinTools());
  assert.ok(grant);
  const { context } = grant;
  assert.equal(readerScratchWriteMatches(context, [target]), true);
  assert.equal(readerScratchWriteMatches(context, [join(dir, "other.txt")]), false,
    "only the exact original path rides the context");
  assert.equal(readerScratchWriteMatches(context, [`${dir}/./out.txt`]), false, "exact spelling, not an equivalent form");
  assert.equal(readerScratchWriteMatches(context, [join(peer.directory, "out.txt")]), false, "peer paths never match");
  assert.equal(readerScratchWriteMatches(context, [target, join(peer.directory, "peer.txt")]), false,
    "a borrowed peer value cannot ride the context");
  assert.equal(readerScratchWriteMatches(context, []), false, "empty values never match");
  // Malformed or missing contexts are inert, never an exception.
  for (const candidate of [undefined, {}, { sessionId: session }, { token: context.token }, null]) {
    let refused = false;
    try { refused = readerScratchWriteMatches(candidate, [target]) === false; } catch { refused = true; }
    assert.ok(refused, "a malformed context never matches");
  }
  assert.equal(readerScratchWriteMatches({ sessionId: randomUUID(), token: context.token }, [target]), false,
    "the token is bound to its session");
  // Strict containment is revalidated live against the original path.
  writeFileSync(join(base, "evil.txt"), "fixture\n");
  symlinkSync(join(base, "evil.txt"), target, "file");
  assert.equal(readerScratchWriteMatches(context, [target]), false,
    "an escaping symlink at the original path voids the match");
  rmSync(target);
  assert.equal(readerScratchWriteMatches(context, [target]), true, "the match recovers when the alias is gone");
  // A second grant is independent and pinned to its own original path.
  const second = beginReaderScratchWrite(ctx, "write", "reader", { path: join(dir, "second.txt") }, builtinTools());
  assert.ok(second);
  assert.equal(readerScratchWriteMatches(second.context, [join(dir, "second.txt")]), true);
  assert.equal(readerScratchWriteMatches(second.context, [target]), false);
  grant.release();
  assert.equal(readerScratchWriteMatches(context, [target]), false);
  assert.equal(readerScratchWriteMatches(second.context, [join(dir, "second.txt")]), true);
  // The CURRENT lease must still be the request's lease: revocation and
  // reassignment void old tokens even for the same session id.
  second.release();
  lease.release();
  assert.equal(readerScratchWriteMatches(second.context, [join(dir, "second.txt")]), false,
    "a released lease voids its live tokens");
  const reissued = createReaderScratch(session);
  t.after(() => { reissued.release(); rmSync(reissued.directory, { recursive: true, force: true }); });
  assert.equal(readerScratchWriteMatches(context, [target]), false, "a reissued lease never revives an old token");
  const fresh = beginReaderScratchWrite(ctx, "write", "reader", { path: join(reissued.directory, "fresh.txt") }, builtinTools());
  assert.ok(fresh, "the reissued lease serves fresh requests");
  fresh.release();
});

test("the write guard requires the built-in write tool and binds the event to the own session scratch", (t) => {
  const base = scratchBase(t);
  const reader = randomUUID(), peer = randomUUID(), revokedSession = randomUUID();
  const own = createReaderScratch(reader);
  const other = createReaderScratch(peer);
  const revoked = createReaderScratch(revokedSession);
  t.after(() => {
    for (const lease of [own, other, revoked]) { lease.release(); rmSync(lease.directory, { recursive: true, force: true }); }
  });
  revoked.release();
  const permissionSession = newPermissionSession();
  const pi = guardPi();
  installReaderScratchGuard(pi, permissionSession.resolveAgentName.bind(permissionSession));
  const ctxFor = (sessionId, agentName = "reader") =>
    sessionCtx({ sessionId, entries: agentName === null ? [] : [entry(agentName)] });
  const outcome = (event, ctx) => guardOutcome(pi, event, ctx);
  const write = (path, sessionId, agentName) => outcome(writeEvent(path), ctxFor(sessionId, agentName));
  assert.equal(write(join(own.directory, "out.txt"), reader), "allowed", "a clean write in the own scratch proceeds");
  assert.equal(write(join(own.directory, "made", "new", "f.txt"), reader), "allowed", "missing descendants are eligible");
  mkdirSync(join(own.directory, "sub"), { recursive: true });
  writeFileSync(join(base, "evil.txt"), "fixture\n");
  writeFileSync(join(own.directory, "real.txt"), "fixture\n");
  symlinkSync(join(own.directory, "real.txt"), join(own.directory, "link-in"));
  symlinkSync(join(base, "evil.txt"), join(own.directory, "escape"));
  linkSync(join(base, "evil.txt"), join(own.directory, "hard"));
  writeFileSync(join(own.directory, "leaf.txt"), "fixture\n");
  assert.equal(write(join(own.directory, "leaf.txt"), reader), "allowed", "a clean existing regular file stays eligible");
  for (const [label, path] of [
    ["another session's scratch", join(other.directory, "out.txt")],
    ["unregistered tmp", join(tmpdir(), "unregistered", "out.txt")],
    ["project source", join(base, "source.txt")],
    ["relative", "out.txt"],
    ["project shorthand", "@/out.txt"],
    ["wrapped quotes", `'${join(own.directory, "q.txt")}'`],
    ["dotdot segment", `${own.directory}/../out.txt`],
    ["escaping symlink", join(own.directory, "escape")],
    ["in-root symlink", join(own.directory, "link-in")],
    ["non-directory ancestor", join(own.directory, "leaf.txt", "new.txt")],
    ["hardlink to outside", join(own.directory, "hard")],
  ]) assert.equal(write(path, reader), "blocked", `the guard blocks ${label}`);
  assert.equal(write({}, reader), "blocked", "a missing path is blocked");
  assert.equal(write(join(own.directory, "out.txt"), randomUUID()), "blocked", "an unknown session is blocked");
  assert.equal(write(join(own.directory, "out.txt"), revokedSession), "blocked", "a released lease is revoked");
  assert.equal(write(join(revoked.directory, "out.txt"), revokedSession), "blocked", "a released directory grants nothing");
  // The guard trusts only the actual SDK built-in write tool: any impostor or
  // missing capability fails closed, even inside the own scratch.
  for (const [label, tools] of [
    ["an extension write tool", [toolInfo("write", { source: "extension", path: "/evil/extension.ts" })]],
    ["a mismatched builtin path", [toolInfo("write", { source: "builtin", path: "builtin:edit" })]],
    ["duplicate write tools", [builtinToolInfo("write"), builtinToolInfo("write")]],
    ["no write tool at all", [builtinToolInfo("read")]],
  ]) {
    const impostorPi = guardPi(tools);
    installReaderScratchGuard(impostorPi, permissionSession.resolveAgentName.bind(permissionSession));
    assert.equal(guardOutcome(impostorPi, writeEvent(join(own.directory, "out.txt")), ctxFor(reader)), "blocked",
      `the guard fails closed on ${label}`);
  }
  const noToolListPi = guardPi(null, { withoutGetAllTools: true });
  installReaderScratchGuard(noToolListPi, permissionSession.resolveAgentName.bind(permissionSession));
  assert.equal(guardOutcome(noToolListPi, writeEvent(join(own.directory, "out.txt")), ctxFor(reader)), "blocked",
    "a pi without getAllTools fails closed for reader writes");
  // The guard owns only the reader's write tool; other scopes and Bash events
  // keep their ordinary rules and gates.
  assert.equal(write(join(base, "anywhere.txt"), randomUUID(), "editor"), "allowed", "non-reader scopes are not guarded here");
  assert.equal(outcome({ toolCallId: "fixture", toolName: "bash", input: { command: "printf fixture" } }, ctxFor(reader)), "allowed",
    "Bash events belong to the Bash path gate, not this guard");
  assert.equal(write(join(base, "anywhere.txt"), randomUUID(), null), "allowed", "events without an active reader are not guarded here");
  // Retargeting the bound directory withholds writes; the populated original
  // is renamed under the base for the after-hook cleanup, not deleted.
  const target = join(base, "retargeted");
  const original = join(base, "retargeted-original");
  mkdirSync(target);
  renameSync(own.directory, original);
  symlinkSync(target, own.directory, "dir");
  assert.equal(write(join(own.directory, "out.txt"), reader), "blocked", "a retargeted root fails the guard");
});

test("the guard consumes the actual PermissionSession identity, so every variant agrees with the gate", (t) => {
  const ownSession = randomUUID(), peerSession = randomUUID();
  const own = createReaderScratch(ownSession);
  const peer = createReaderScratch(peerSession);
  t.after(() => {
    for (const lease of [own, peer]) { lease.release(); rmSync(lease.directory, { recursive: true, force: true }); }
  });
  const peerPath = join(peer.directory, "peer-report.txt");
  const ownPath = join(own.directory, "out.txt");
  // Each variant builds a fresh real PermissionSession plus a guard wired to
  // that session's own resolveAgentName callback — no independent parser.
  const variant = ({ entries = [], branch = entries, seedPrompt } = {}) => {
    const session = newPermissionSession();
    const ctx = sessionCtx({ sessionId: ownSession, entries, branch });
    if (seedPrompt) session.resolveAgentName(ctx, seedPrompt); // before_agent_start seeds the prompt identity
    const pi = guardPi();
    installReaderScratchGuard(pi, session.resolveAgentName.bind(session));
    return { session, pi, ctx };
  };
  for (const [label, setup, identity, expected] of [
    ["canonical active_agent record", () => variant({ entries: [entry("reader")] }), "reader", "blocked"],
    ["whitespace-padded record", () => variant({ entries: [entry(" reader ")] }), "reader", "blocked"],
    ["malformed newest record", () => variant({ entries: [entry("reader"), { type: "custom", customType: "active_agent", data: { name: 42 } }] }), "reader", "blocked"],
    ["getEntries diverges from getBranch", () => variant({ entries: [entry("reader")], branch: [] }), "reader", "blocked"],
    ["last-known after a prompt-only context", () => variant({ entries: [], seedPrompt: '<active_agent name="reader"/>' }), "reader", "blocked"],
    ["explicitly cleared record with retained last-known", () => variant({ entries: [{ type: "custom", customType: "active_agent", data: { name: null } }], seedPrompt: '<active_agent name="reader"/>' }), "reader", "blocked"],
    ["prompt-only context, never seeded", () => variant({ entries: [] }), null, "allowed"],
    ["non-reader record", () => variant({ entries: [entry("editor")] }), "editor", "allowed"],
  ]) {
    const { session, pi, ctx } = setup();
    assert.equal(session.resolveAgentName(ctx), identity, `effective identity for ${label}`);
    assert.equal(guardOutcome(pi, writeEvent(peerPath), ctx), expected, `${label}: the guard agrees with the session resolver`);
    if (identity === "reader")
      assert.equal(guardOutcome(pi, writeEvent(ownPath), ctx), "allowed", `${label}: the own scratch stays writable`);
  }
  // The unseeded prompt-only case documents agreement, not permission: with no
  // effective reader identity anywhere, both the guard and the gate defer to
  // ordinary policy instead of disagreeing about who is asking.
});

test("raw Unicode-space spellings cannot launder an ASCII-space target", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const permissionSession = newPermissionSession();
  const pi = guardPi();
  installReaderScratchGuard(pi, permissionSession.resolveAgentName.bind(permissionSession));
  const ctx = sessionCtx({ sessionId: session, entries: [entry("reader")] });
  // Pi's built-in write converts these spaces to ASCII, so approving a raw
  // spelling would authorize a different filesystem target than it executes.
  for (const space of ["\u00a0", "\u2000", "\u200a", "\u202f", "\u205f", "\u3000"]) {
    const spelled = `${dir}/blocked${space}name.txt`;
    assert.equal(readerScratchContains(session, spelled), false,
      `a raw Unicode-space spelling is rejected: U+${space.charCodeAt(0).toString(16).padStart(4, "0")}`);
    assert.ok(beginRefusal(ctx, "write", "reader", { path: spelled }, builtinTools()),
      `no write request begins for a raw spelling: U+${space.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  // The escape shape: the ASCII-space counterpart is a symlink linked outside.
  const raw = `${dir}/blocked\u00a0name.txt`;
  writeFileSync(join(base, "evil.txt"), "fixture\n");
  symlinkSync(join(base, "evil.txt"), join(dir, "blocked name.txt"), "file");
  assert.equal(guardOutcome(pi, writeEvent(raw), ctx), "blocked",
    "the raw spelling cannot reach the ASCII-space symlink linked outside");
  // An ordinary specific deny on the ASCII-space file must not be dodgeable by
  // the raw spelling: no request begins, so the blanket ceiling answers
  // instead of the recovered catch-all ask.
  const secret = join(dir, "secret name.txt");
  writeFileSync(secret, "fixture\n");
  const agentDir = join(base, "agent");
  agentsFixture(agentDir);
  const permission = managedPermission();
  permission.path_write = { "*": "ask", [secret]: "deny" };
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  writeJson(configPath, { permission });
  const resolver = makeResolver(makeManager(configPath, join(agentDir, "agents")));
  const dodged = resolver.resolve(writeIntent([`${dir}/secret\u00a0name.txt`]));
  assert.equal(dodged.state, "deny", "the raw spelling keeps the blanket ceiling");
  assert.equal(dodged.origin, "agent");
  // The ASCII spelling is a clean own-scratch write, so a begun context
  // recovers the ordinary rules — and the specific deny still answers.
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: secret }, builtinTools());
  assert.ok(grant, "the ASCII spelling is guard-eligible");
  const denied = resolver.resolve(writeIntent([secret], "reader", grant.context));
  assert.equal(denied.state, "deny", "the ordinary specific deny holds for the ASCII spelling");
  assert.equal(denied.origin, "global");
  grant.release();
  assert.equal(guardOutcome(pi, writeEvent(`${dir}/secret\u00a0name.txt`), ctx), "blocked",
    "the guard withholds the raw spelling outright");
  assert.equal(guardOutcome(pi, writeEvent(secret), ctx), "allowed",
    "the ASCII spelling stays a guard-eligible own-scratch write; the specific deny is the resolver's job");
});

test("the scratch exception requires a qualified own context; generic queries stay under the reader floor", (t) => {
  const { base, dir, lease, session, cwd, agentDir, configPath, manager, resolver } = core(t);
  assert.deepEqual(manager.getConfigIssues("reader"), [], "a config without the retired field is valid");
  const ctx = { sessionManager: { getSessionId: () => session } };
  const target = join(dir, "out.txt");
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: target }, builtinTools());
  assert.ok(grant, "a qualified own context begins for the ordinary own-scratch write");
  // Without a context every query is under the blanket ceiling — including the
  // own scratch. Generic profile lookups never see the exception again.
  for (const value of [target, join(dir, "id.key"), join(dir, "secret.pem"), join(cwd, "source.txt"), join(base, "unregistered", "out.txt")])
    assert.equal(resolver.resolve(writeIntent([value])).state, "deny", `a generic query stays denied: ${value}`);
  // With the qualified own context the ordinary recovered rules answer.
  const inside = resolver.resolve(writeIntent([target], "reader", grant.context));
  assert.equal(inside.state, "ask", "the recovered ordinary catch-all ask, never an automatic allow");
  assert.equal(inside.origin, "global");
  // Exact-path binding: the out.txt context cannot ask id.key or reach
  // secret.pem's global deny — those need their own qualified contexts.
  assert.equal(resolver.resolve(writeIntent([join(dir, "id.key")], "reader", grant.context)).state, "deny",
    "the out.txt context rides only its original path");
  assert.equal(resolver.resolve(writeIntent([join(dir, "secret.pem")], "reader", grant.context)).state, "deny",
    "the out.txt context cannot reach another file's specific deny");
  const keyGrant = beginReaderScratchWrite(ctx, "write", "reader", { path: join(dir, "id.key") }, builtinTools());
  assert.ok(keyGrant, "a qualified context begins for id.key");
  const key = resolver.resolve(writeIntent([join(dir, "id.key")], "reader", keyGrant.context));
  assert.equal(key.state, "ask", "a specific ordinary ask survives behind its own context");
  assert.equal(key.origin, "global");
  keyGrant.release();
  const pemGrant = beginReaderScratchWrite(ctx, "write", "reader", { path: join(dir, "secret.pem") }, builtinTools());
  assert.ok(pemGrant, "a qualified context begins for secret.pem");
  const pem = resolver.resolve(writeIntent([join(dir, "secret.pem")], "reader", pemGrant.context));
  assert.equal(pem.state, "deny", "a specific ordinary deny survives behind its own context");
  assert.equal(pem.origin, "global");
  pemGrant.release();
  // The context never covers other paths, peers, or foreign sessions.
  assert.equal(resolver.resolve(writeIntent([join(dir, "other.txt")], "reader", grant.context)).state, "deny",
    "the context rides only its original path");
  const peer = leaseFor(t);
  assert.equal(resolver.resolve(writeIntent([join(peer.directory, "peer.txt")], "reader", grant.context)).state, "deny",
    "no profile-wide peer matching: the peer scratch stays under the ceiling");
  assert.equal(resolver.resolve(writeIntent([target], "reader", { sessionId: randomUUID(), token: grant.context.token })).state, "deny",
    "a borrowed context with a foreign session id never matches");
  for (const agentName of ["editor", undefined]) {
    // writeIntent defaults agentName to "reader", so spread and set it
    // explicitly: an undefined agentName property is the global scope.
    for (const value of [target, join(cwd, "out.txt")]) {
      const result = resolver.resolve({ ...writeIntent([value], agentName, grant.context), agentName });
      assert.equal(result.state, "ask", `non-reader scopes keep ordinary rules: ${agentName ?? "global"}`);
    }
  }
  assert.equal(resolver.resolve(writeIntent([target], "researcher", grant.context)).state, "deny", "the researcher keeps its own ceiling");
  // The access-path variant carries the context through the resolver unwrap.
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const viaAccessPath = resolver.resolve({ kind: "access-path", surface: "path_write", path: normalizer.forPath(target),
    agentName: "reader", readerScratchWrite: grant.context });
  assert.equal(viaAccessPath.state, "ask", "access-path to path-values carries the context");
  // A per-tool `write` query is the ordinary global write rule ("write":
  // "ask"), not the path_write ceiling: with or without a context it asks.
  // The reader's cross-cutting path_write ceiling denies separately, through
  // the path-values/access-path intents asserted above.
  const viaTool = resolver.resolve({ kind: "tool", surface: "write", input: { path: target },
    agentName: "reader", readerScratchWrite: grant.context });
  assert.equal(viaTool.state, "ask", "the per-tool write query is the ordinary global ask");
  assert.equal(resolver.resolve({ kind: "tool", surface: "write", input: { path: target }, agentName: "reader" }).state,
    "ask", "the per-tool write query without a context asks too; the path_write ceiling denies separately");
  // The reader's built-in write tool is exposed (ordinary global write rule)
  // and edit stays denied.
  assert.equal(resolver.getToolPermission("write", "reader"), "ask", "the ordinary global write rule applies");
  assert.equal(resolver.isToolFullyDenied("write", "reader"), false, "the write tool is exposed");
  assert.equal(resolver.checkPermission("edit", { path: join(dir, "new.txt"), edits: [] }, "reader").state, "deny", "no edit tools");
  assert.equal(resolver.isToolFullyDenied("edit", "reader"), true);
  // Revocation voids the exception for later policy lookups, and a reissued
  // lease never revives the old token.
  grant.release();
  lease.release();
  const revoked = makeResolver(makeManager(configPath, join(agentDir, "agents")));
  assert.equal(revoked.resolve(writeIntent([target], "reader", grant.context)).state, "deny",
    "a released scratch is revoked for policy too");
  assert.equal(revoked.resolve(writeIntent([target])).state, "deny");
});

test("the alternate composition recovers shadowed rules behind the qualified context", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const agentDir = join(base, "agent");
  agentsFixture(agentDir);
  const agentsDir = join(agentDir, "agents");
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  writeJson(configPath, { permission: managedPermission() });
  const ctx = { sessionManager: { getSessionId: () => session } };
  const grant = (path) => {
    const begun = beginReaderScratchWrite(ctx, "write", "reader", { path }, builtinTools());
    assert.ok(begun, `a qualified context begins for ${path}`);
    t.after(() => begun.release());
    return begun.context;
  };
  const inside = join(dir, "out.txt");
  // A global catch-all deny hidden by the reader blanket reappears behind the
  // qualified context.
  const caught = managedPermission();
  caught.path_write = { "*": "deny", [join(dir, "ok.txt")]: "ask" };
  const caughtPath = join(agentDir, "extensions/pi-permission-system/config-caught.json");
  writeJson(caughtPath, { permission: caught });
  const caughtManager = makeManager(caughtPath, agentsDir);
  const caughtResolver = makeResolver(caughtManager);
  assert.equal(caughtManager.isToolFullyDenied("path_write", "reader"), false,
    "denied root/probe paths cannot hide a reachable specific scratch file");
  const okGrant = grant(join(dir, "ok.txt"));
  assert.equal(caughtResolver.resolve(writeIntent([join(dir, "ok.txt")], "reader", okGrant)).state, "ask",
    "a shadowed specific ask is recovered");
  assert.equal(caughtResolver.resolve(writeIntent([join(dir, "ok.txt")])).state, "deny",
    "without the context the shadowed specific rule stays hidden");
  const other = caughtResolver.resolve(writeIntent([join(dir, "other.txt")], "reader", grant(join(dir, "other.txt"))));
  assert.equal(other.state, "deny", "the shadowed global catch-all deny reappears");
  assert.equal(other.origin, "global");
  // A project catch-all deny hidden by the same-pattern agent blanket survives
  // the pre-merge composition instead of being discarded.
  const projectDeny = join(base, "project-deny.json");
  writeJson(projectDeny, { permission: { path_write: { "*": "deny" } } });
  const denied = makeResolver(makeManager(configPath, agentsDir, { projectGlobalConfigPath: projectDeny }))
    .resolve(writeIntent([inside], "reader", grant(inside)));
  assert.equal(denied.state, "deny", "a shadowed project deny survives inside the scratch");
  assert.equal(denied.origin, "project");
  // A shadowed project allow is recovered the same way, only inside.
  const projectAllow = join(base, "project-allow.json");
  writeJson(projectAllow, { permission: { path_write: { "*": "allow" } } });
  const allowResolver = makeResolver(makeManager(configPath, agentsDir, { projectGlobalConfigPath: projectAllow }));
  const recovered = allowResolver.resolve(writeIntent([inside], "reader", grant(inside)));
  assert.equal(recovered.state, "allow");
  assert.equal(recovered.origin, "project");
  const ceiling = allowResolver.resolve(writeIntent([join(base, "repo", "x.txt")], "reader", grant(inside)));
  assert.equal(ceiling.state, "deny", "outside the scratch the ceiling still holds, context or not");
  assert.equal(ceiling.origin, "agent");
  // A project-agent floor survives inside the scratch.
  const projectAgentsDir = join(base, "project-agents");
  mkdirSync(projectAgentsDir);
  writeFileSync(join(projectAgentsDir, "reader.md"), "---\npermission:\n  path_write: deny\n---\n");
  const floored = makeResolver(makeManager(configPath, agentsDir, { projectAgentsDir }))
    .resolve(writeIntent([inside], "reader", grant(inside)));
  assert.equal(floored.state, "deny", "the project-agent floor holds inside the scratch");
  assert.equal(floored.origin, "project-agent");
  // Only the plain managed blanket map is relaxed, never user-modified ceilings.
  const profile = (body) => `---\npermission:\n${body}\n---\n`;
  for (const [label, source, expected] of [
    ["plain map", profile('  path_write:\n    "*": deny'), "ask"],
    ["scalar", profile("  path_write: deny"), "deny"],
    ["deny with reason", profile('  path_write:\n    "*":\n      action: deny\n      reason: fixture lock'), "deny"],
  ]) {
    const customDir = join(base, `agents-${label.replace(/\W+/g, "-")}`);
    mkdirSync(customDir);
    writeFileSync(join(customDir, "reader.md"), source);
    assert.equal(makeResolver(makeManager(configPath, customDir))
      .resolve(writeIntent([inside], "reader", grant(inside))).state, expected,
      `a user-modified reader ceiling of the ${label} form is ${expected === "ask" ? "relaxed" : "not relaxed"}`);
  }
});

test("session grants and yolo widen only context-qualified scratch writes and never bypass the guard", (t) => {
  const { base, dir, session, cwd, configPath, agentDir } = core(t);
  const agentsDir = join(agentDir, "agents");
  const peer = leaseFor(t);
  const ctx = { sessionManager: { getSessionId: () => session } };
  const target = join(dir, "out.txt");
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: target }, builtinTools());
  assert.ok(grant);
  const granted = makeResolver(makeManager(configPath, agentsDir), [sessionRule("allow")]);
  assert.equal(granted.resolve(writeIntent([target], "reader", grant.context)).state, "allow",
    "session grants work inside the qualified scratch");
  assert.equal(granted.resolve(writeIntent([target])).state, "deny",
    "session grants cannot create the exception without the context");
  assert.equal(granted.resolve(writeIntent([join(cwd, "out.txt")], "reader", grant.context)).state, "deny",
    "the context never covers paths outside the scratch");
  const denying = makeResolver(makeManager(configPath, agentsDir), [sessionRule("deny")]);
  assert.equal(denying.resolve(writeIntent([target], "reader", grant.context)).state, "deny",
    "session denials hold inside the scratch");
  const yolo = makeResolver(makeManager(configPath, agentsDir, { isYoloEnabled: () => true }));
  assert.equal(yolo.resolve(writeIntent([target], "reader", grant.context)).state, "allow",
    "yolo allows the recovered ask");
  const pemGrant = beginReaderScratchWrite(ctx, "write", "reader", { path: join(dir, "secret.pem") }, builtinTools());
  assert.ok(pemGrant);
  assert.equal(yolo.resolve(writeIntent([join(dir, "secret.pem")], "reader", pemGrant.context)).state, "deny",
    "yolo keeps specific denies");
  pemGrant.release();
  for (const value of [join(cwd, "out.txt"), join(cwd, "id.key")])
    assert.equal(yolo.resolve(writeIntent([value])).state, "deny", `yolo cannot cross the ceiling: ${value}`);
  // The peer scratch is no longer a policy question at all: neither with this
  // session's context nor without any context.
  assert.equal(granted.resolve(writeIntent([join(peer.directory, "peer.txt")], "reader", grant.context)).state, "deny");
  assert.equal(granted.resolve(writeIntent([join(peer.directory, "peer.txt")])).state, "deny");
  // The session-bound guard still withholds the actual write even when the
  // resolver would allow, and grants/yolo never widen the guard.
  const permissionSession = newPermissionSession();
  const pi = guardPi();
  installReaderScratchGuard(pi, permissionSession.resolveAgentName.bind(permissionSession));
  const guardCtx = sessionCtx({ sessionId: session, entries: [entry("reader")] });
  assert.equal(guardOutcome(pi, writeEvent(join(peer.directory, "peer.txt")), guardCtx), "blocked",
    "an allowed ask never authorizes another child's scratch");
  assert.equal(guardOutcome(pi, writeEvent(target), guardCtx), "allowed", "the own scratch stays writable");
  assert.equal(guardOutcome(pi, writeEvent(join(cwd, "out.txt")), guardCtx), "blocked",
    "session grants and yolo never bypass the guard outside the registered root");
  grant.release();
});

test("the retired readerOutputRoots setting is reported and grants nothing", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const agentDir = join(base, "agent");
  agentsFixture(agentDir);
  const injected = join(base, "injected");
  mkdirSync(injected);
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  writeJson(configPath, { readerOutputRoots: [injected], permission: managedPermission() });
  const manager = makeManager(configPath, join(agentDir, "agents"));
  assert.ok(manager.getConfigIssues("reader").length > 0, "the retired field is reported, not honored");
  const resolver = makeResolver(manager);
  const grant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => session } }, "write", "reader",
    { path: join(dir, "out.txt") }, builtinTools());
  assert.ok(grant, "the registry scratch keeps working despite the invalid field");
  assert.equal(resolver.resolve(writeIntent([join(dir, "out.txt")], "reader", grant.context)).state, "ask",
    "the qualified context recovers the ordinary ask");
  assert.equal(resolver.resolve(writeIntent([join(dir, "out.txt")])).state, "deny",
    "generic queries stay under the ceiling");
  const hostile = resolver.resolve(writeIntent([join(injected, "out.txt")]));
  assert.equal(hostile.state, "deny", "a configured root grants nothing");
  assert.equal(hostile.origin, "agent");
  grant.release();
});

test("Bash keeps the reader ceiling with real path facts and no scratch exception", async (t) => {
  const { dir, session, resolver, cwd } = core(t);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(dir, "script.sh"), "printf fixture\n");
  writeFileSync(join(dir, "data.txt"), "fixture\n");
  // A recording resolver observes exactly what the Bash path gate sends.
  const seen = [];
  const recording = { seen, resolve(intent) { seen.push(intent); return resolver.resolve(intent); } };
  const scratchOut = join(dir, "out.txt");
  const redirect = await bashGates(`printf fixture > ${scratchOut}`, recording, cwd);
  assert.equal(redirect.path.preCheck.state, "deny", "Bash has no scratch write exception");
  assert.equal(redirect.path.preCheck.origin, "agent");
  const writeIntents = seen.filter((intent) => intent.kind === "access-path" && intent.surface === "path_write");
  assert.ok(writeIntents.length > 0, "the write token reached the resolver");
  for (const intent of writeIntents) {
    const values = intent.path.matchValues();
    assert.ok(values.includes(scratchOut), "the real path is preserved for policy, not a sentinel");
    assert.ok(!values.includes("*"), "no fake catch-all is sent to the resolver");
    assert.equal(intent.readerScratchWrite, undefined, "Bash never receives a scratch write context");
  }
  // Explicit script operands and folded relative writes hit the same ceiling.
  assert.equal((await bashGates(`bash ${join(dir, "script.sh")}`, resolver, cwd)).path.preCheck.state, "deny",
    "an explicit script operand in the scratch is not executable by the reader");
  // A bare `out.txt` redirect is an existing extractor blind spot (no slash, no
  // extraction, so nothing to deny), so keep the slash-bearing spelling the
  // path gate actually observes after the cd.
  assert.equal((await bashGates(`cd ${dir} && printf fixture > logs/out.txt`, resolver, cwd)).path.preCheck.state, "deny",
    "a relative write after cd into the scratch is denied");
  // Unproven targets stay denied under the floor now that real paths flow.
  assert.equal((await bashGates(`python3 ${scratchOut}`, resolver, cwd)).path.preCheck.state, "deny",
    "an unproven target in the scratch is denied");
  // Pure reads keep their original resolution.
  const read = await bashGates(`cat ${join(dir, "data.txt")}`, resolver, cwd);
  assert.equal(read.path, null, "reads are unrestricted as before");
  assert.equal(read.bash().state, "ask");
  // Other agents are unaffected by the reader-specific gate.
  const editor = await bashGates(`printf fixture > ${scratchOut}`, resolver, cwd, "editor");
  assert.equal(editor.path.preCheck.state, "ask", "the gate change is reader-specific");
  assert.equal(editor.bash().state, "ask");
});

test("a live reader definition removed externally still hits resource matches and specific denies on real Bash paths", async (t) => {
  const base = scratchBase(t);
  const lease = leaseFor(t);
  const dir = lease.directory;
  const cwd = join(base, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "plain.txt"), "fixture\n");
  const protectedFile = join(cwd, "protected", "config.json");
  writeJson(protectedFile, {});
  const specificFile = join(cwd, "specific.txt");
  writeFileSync(specificFile, "fixture\n");
  // A hand-frozen protection snapshot for this fixture only (the process-global
  // initialize belongs to the trust-input test below).
  const protection = fileProtection([protectedFile]);
  const customAgents = join(base, "agents");
  mkdirSync(customAgents);
  // Begin with a valid managed reader; only this fixture's copied profile is
  // moved later. The same warmed manager must notice without an explicit reload.
  const liveProfile = join(customAgents, "reader.md");
  cpSync(join(packageRoot, "runtime/agents/reader.md"), liveProfile);
  const configPath = join(base, "config.json");
  writeJson(configPath, { permission: { path_write: { "*": "allow", [specificFile]: { action: "deny", reason: "fixture-specific" } } } });
  const resolver = makeResolver(makeManager(configPath, customAgents, { resourceProtection: protection }));
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const before = await bashGates(`printf fixture > ${protectedFile}`, resolver, cwd);
  assert.equal(before.path.preCheck.state, "deny");
  assert.equal(before.path.preCheck.origin, "agent", "the managed reader floor initially decides");
  renameSync(liveProfile, join(base, "reader-profile-backup.md"));
  // The profile is gone, but immutable protection and the specific global deny
  // must still decide on real paths. No reload/new manager is performed.
  // Direct query: the real path hits the immutable resource match.
  const direct = resolver.resolve({ kind: "access-path", surface: "path_write", path: normalizer.forPath(protectedFile), agentName: "reader" });
  assert.equal(direct.state, "deny");
  assert.equal(direct.origin, "builtin");
  // Bash with real paths: the resource deny produces a gate descriptor, and
  // the unproven target family cannot slip past it either.
  const resource = await bashGates(`printf fixture > ${protectedFile}`, resolver, cwd);
  assert.equal(resource.path.preCheck.state, "deny", "real Bash paths hit the immutable resource match");
  assert.equal(resource.path.preCheck.origin, "builtin");
  const opaque = await bashGates(`python3 ${protectedFile}`, resolver, cwd);
  assert.equal(opaque.path.preCheck.state, "deny", "an unproven target still hits the resource match");
  // An ordinary specific deny keeps its provenance.
  const specific = await bashGates(`printf fixture > ${specificFile}`, resolver, cwd);
  assert.equal(specific.path.preCheck.state, "deny");
  assert.equal(specific.path.preCheck.reason, "fixture-specific");
  // Reads stay ordinary, and registered scratch paths stay denied for Bash.
  const read = await bashGates(`cat ${join(cwd, "plain.txt")}`, resolver, cwd);
  assert.equal(read.path, null);
  assert.equal((await bashGates(`printf fixture > ${join(dir, "out.txt")}`, resolver, cwd)).path, null,
    "without a reader floor Bash resolves the ordinary global allow inside the scratch; the write-tool cap is the binding, not Bash");
});

test("protected trust inputs inside a scratch directory stay unwritable", (t) => {
  const base = scratchBase(t);
  const session = randomUUID();
  const lease = leaseFor(t, session);
  const dir = lease.directory;
  const agentDir = join(base, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  // The permission config and the reader profile are symlinks whose canonical
  // targets live inside the scratch directory.
  const configTarget = join(dir, "permission-config.json");
  writeJson(configTarget, { permission: managedPermission() });
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  symlinkSync(configTarget, configPath);
  const profileTarget = join(dir, "reader-profile.md");
  writeFileSync(profileTarget, readFileSync(join(packageRoot, "runtime/agents/reader.md")));
  symlinkSync(profileTarget, join(agentDir, "agents/reader.md"));
  for (const name of ["researcher", "editor"]) cpSync(join(packageRoot, "runtime/agents", `${name}.md`), join(agentDir, "agents", `${name}.md`));
  const protection = initializeManagedResourceProtection(protectionResources({ agentDir }, {}, packageRoot));
  assert.equal(protection.version, 1);
  assert.ok(protection.writeFiles.includes(configTarget), "the canonical config alias is pinned");
  assert.ok(protection.writeFiles.includes(profileTarget), "the canonical profile alias is pinned");
  const ctx = { sessionManager: { getSessionId: () => session } };
  const resolver = makeResolver(
    makeManager(configPath, join(agentDir, "agents"), { isYoloEnabled: () => true, resourceProtection: protection }),
    [sessionRule("allow")]);
  for (const path of [configTarget, profileTarget, configPath]) {
    const grant = beginReaderScratchWrite(ctx, "write", "reader", { path }, builtinTools());
    if (path === configPath) assert.ok(!grant, "the symlink path outside the scratch never begins a request");
    const result = resolver.resolve(writeIntent([path], "reader", grant?.context));
    assert.equal(result.state, "deny", `a trust input inside the scratch stays denied: ${path}`);
    grant?.release();
  }
  const out = join(dir, "out.txt");
  const grant = beginReaderScratchWrite(ctx, "write", "reader", { path: out }, builtinTools());
  assert.ok(grant, "an ordinary output inside the scratch begins a request");
  assert.equal(resolver.resolve(writeIntent([out], "reader", grant.context)).state, "allow",
    "ordinary outputs inside the scratch keep the widened rules behind the context");
  assert.equal(resolver.resolve(writeIntent([out])).state, "deny",
    "without the context even an ordinary output stays under the ceiling");
  grant.release();
});

test("the retired readerOutputRoots setting is gone from schema, seed, and profile", (t) => {
  const schema = buildPermissionsJsonSchema();
  assert.ok(!("readerOutputRoots" in schema.properties), "the published schema no longer documents the field");
  const published = JSON.parse(readFileSync(join(packageRoot, "runtime/permission-system/vendor/schemas/permissions.schema.json"), "utf8"));
  assert.deepEqual(published, schema, "the committed schema must be regenerated from the zod source");
  assert.deepEqual(validateUnifiedConfig({ permission: { "*": "ask" } }).issues, [], "a config without the field is valid");
  assert.ok(validateUnifiedConfig({ readerOutputRoots: ["/abs/output"] }).issues.length > 0,
    "the retired field is rejected");
  // The missing seed opts into nothing and keeps the trust-input write denies.
  const base = scratchBase(t);
  const agentDir = join(base, "agent");
  initialize({ agentDir });
  const seeded = JSON.parse(readFileSync(join(agentDir, "extensions/pi-permission-system/config.json"), "utf8"));
  assert.ok(!("readerOutputRoots" in seeded), "a fresh installation seeds no roots");
  const denied = (path) => {
    const value = seeded.permission.path_write[path];
    return value === "deny" || value?.action === "deny";
  };
  for (const path of [join(agentDir, "settings.json"), join(agentDir, "agents/reader.md")])
    assert.ok(denied(path), `the seed mirrors the write deny for ${path}`);
  // The managed reader profile: the write tool is exposed with no per-tool
  // write rule, edit stays denied, and the path_write ceiling remains.
  const source = readFileSync(join(packageRoot, "runtime/agents/reader.md"), "utf8");
  assert.ok(!/^  write:/m.test(source), "the frontmatter carries no write:deny and no write:allow");
  assert.match(source, /^  edit: deny$/m, "edit tools stay denied");
  assert.match(source, /^  path_write:\n {4}"\*": deny$/m, "the path_write ceiling remains");
  const tools = JSON.parse(/^tools: (\[.*\])$/m.exec(source)[1]);
  assert.ok(tools.includes("write"), "the built-in write tool is exposed");
  assert.ok(!tools.includes("edit"), "no edit tools");
});

test("the gate handler holds the token across evaluation, rechecks live facts before allowing, and always retires it", async (t) => {
  // Warm the process-global request registry so token counts are observable.
  const warmSession = randomUUID();
  const warmLease = leaseFor(t, warmSession);
  const warmGrant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => warmSession } }, "write", "reader",
    { path: join(warmLease.directory, "warm.txt") }, builtinTools());
  assert.ok(warmGrant, "warm-up request begins");
  warmGrant.release();
  const registry = writeRequests();
  const baseline = registry.size;
  const holdPipeline = () => {
    let resolve, reject;
    const outcome = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { resolve, reject, evaluate() { return outcome; } };
  };
  const makeHandler = (pipeline, tools) => new PermissionGateHandler(
    newPermissionSession(),
    { getAll: () => tools, getActive: () => tools.map((tool) => tool.name), setActive() {} },
    pipeline, {}, {});
  const scenario = async ({ mutate, pipelineResult, reject, entries = [entry("reader")], tools = builtinTools(), path } = {}) => {
    const session = randomUUID();
    const lease = createReaderScratch(session);
    t.after(() => { lease.release(); rmSync(lease.directory, { recursive: true, force: true }); });
    const target = path ?? join(lease.directory, "report.md");
    let liveSessionId = session;
    const ctx = { cwd: "/tmp", hasUI: false, ui: { notify() {} },
      sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => liveSessionId } };
    const event = { toolCallId: "fixture", toolName: "write", input: { path: target } };
    const pipeline = holdPipeline();
    const pending = makeHandler(pipeline, tools).handleToolCall(event, ctx);
    // A token is held only when the write tool is the actual built-in write
    // tool and the event targets the own scratch; otherwise the handler must
    // block up front and hold nothing.
    const capable = !path && tools.some((tool) => tool.name === "write" && tool.sourceInfo?.source === "builtin" && tool.sourceInfo.path === "builtin:write") &&
      entries.some((item) => item?.type === "custom" && item?.customType === "active_agent" &&
        typeof item?.data?.name === "string" && item.data.name.trim() === "reader");
    if (capable) assert.equal(registry.size, baseline + 1, "the per-call token is held while evaluation is pending");
    mutate?.({ lease, session, event, entries, setSessionId: (id) => { liveSessionId = id; } });
    if (reject) pipeline.reject(new Error("pipeline failure"));
    else pipeline.resolve(pipelineResult ?? { action: "allow" });
    return await pending;
  };
  // The untouched own-scratch write is allowed — and the token is still retired.
  assert.deepEqual(await scenario({}), { action: "allow" },
    "an unmutated own-scratch write passes the final recheck");
  assert.equal(registry.size, baseline, "the token is retired after the allow");
  // A deny or block outcome retires the token too.
  const blocked = await scenario({ pipelineResult: { action: "block", reason: "fixture deny" } });
  assert.equal(blocked.action, "block");
  assert.equal(registry.size, baseline, "the token is retired after a block outcome");
  // Facts mutated while the pipeline (or a forwarded human ask) was awaited
  // must void an allow: released lease, reissued lease, replaced raw input, or
  // a switched session id all fail the final recheck.
  for (const [label, mutate] of [
    ["released scratch", ({ lease }) => lease.release()],
    ["reissued lease", ({ lease, session }) => {
      lease.release();
      const reissued = createReaderScratch(session);
      t.after(() => { reissued.release(); rmSync(reissued.directory, { recursive: true, force: true }); });
    }],
    ["replaced raw input", ({ event }) => { event.input = { path: "/tmp/reader-guard-evil.txt" }; }],
    ["switched session", ({ setSessionId }) => setSessionId(randomUUID())],
    ["changed cached identity", ({ entries }) => { entries.splice(0, entries.length, entry("editor")); }],
  ]) {
    const result = await scenario({ mutate });
    assert.equal(result.action, "block", `an allow after a ${label} must not pass the final recheck`);
    assert.equal(registry.size, baseline, `the token is retired after a ${label}`);
  }
  // A pipeline failure never allows the write and still retires the token.
  let failure = "resolved";
  try { const outcome = await scenario({ reject: true }); failure = outcome?.action ?? "resolved"; }
  catch { failure = "rejected"; }
  assert.ok(failure === "rejected" || failure === "block", "a pipeline failure never allows the write");
  assert.equal(registry.size, baseline, "the token is retired after a pipeline failure");
  // An initial effective-reader write that never began a token is blocked even
  // when the pipeline allows — including with no write floor at all.
  assert.equal((await scenario({ path: "/tmp/reader-guard-outside.txt" })).action, "block",
    "a reader write outside the scratch is blocked without a cap");
  assert.equal(registry.size, baseline, "no token was held for the lacking-cap write");
  assert.equal((await scenario({ tools: [builtinToolInfo("read")] })).action, "block",
    "a reader write without the built-in write tool is blocked without a cap");
  assert.equal(registry.size, baseline);
  // A non-reader write never holds a token at all.
  const editor = await scenario({ entries: [entry("editor")] });
  assert.deepEqual(editor, { action: "allow" }, "the editor write is an ordinary policy question");
  assert.equal(registry.size, baseline, "no token is held for a non-reader scope");
});

test("generic dispatch preflight cannot borrow any registered scratch", async (t) => {
  const { base, dir, session, cwd, agentDir, configPath } = core(t);
  mkdirSync(cwd, { recursive: true });
  const agentsDir = join(agentDir, "agents");
  const peer = leaseFor(t);
  const resolver = makeResolver(makeManager(configPath, agentsDir));
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  // A real LocalPermissionsService: the same resolver the gates use, queried
  // with exactly the surface/path/profile the runtime preflight sends — and
  // therefore with no scratch context at all.
  const service = new LocalPermissionsService(resolver, { getPathNormalizer: () => normalizer }, {}, {}, {});
  const dist = join(packageRoot, "harness/dist/runtime/dispatch-runtime.js");
  assert.ok(existsSync(dist), "harness/dist/runtime/dispatch-runtime.js is built before the test suite runs");
  const { createDispatchRuntime } = await import(pathToFileURL(dist).href);
  const runtime = createDispatchRuntime({ agentDir, flock: "/unused-by-prepare", getPermissionsService: () => service });
  const prepare = (dispatch) => runtime.prepare(dispatch, { cwd, profile: "reader", deferInputs: false });
  const denied = (dispatch) => {
    try { prepare(dispatch); return false; }
    catch (error) { return error?.code === "PREFLIGHT_DENIED"; }
  };
  // Peer tree/ownership: rejected by policy, not by filesystem classification.
  assert.ok(denied({ ownership: [join(peer.directory, "peer-report.txt")] }),
    "peer-scratch ownership declarations are denied at preflight");
  assert.ok(denied({ tree: peer.directory }),
    "peer-scratch tree declarations are denied at preflight");
  // New-spawn and follow-up generic output declarations get no exception
  // either: even the own scratch is under the reader floor without a context.
  assert.ok(denied({ ownership: [join(dir, "report.md")] }),
    "own-scratch ownership declarations stay generic and are denied");
  assert.ok(denied({ tree: dir }),
    "own-scratch tree declarations stay generic and are denied");
  // Input reads are unchanged.
  writeFileSync(join(dir, "data.txt"), "fixture\n");
  const prepared = prepare({ inputs: [join(dir, "data.txt")] });
  assert.equal(prepared.inputs[0].path, join(dir, "data.txt"), "input reads inside the scratch are ordinary");
  // Non-reader profiles are unaffected by the reader-specific floor.
  const editor = runtime.prepare({ ownership: [join(peer.directory, "peer-report.txt")] }, { cwd, profile: "editor", deferInputs: false });
  assert.equal(editor.ownership[0].path, join(peer.directory, "peer-report.txt"),
    "the editor profile keeps its ordinary preflight rules");
});

test("a forwarded ask reaches the serving policy only through a live child token", (t) => {
  const { agentDir, configPath, cwd } = core(t);
  const resolver = makeResolver(makeManager(configPath, join(agentDir, "agents")));
  const childSession = randomUUID();
  const childLease = leaseFor(t, childSession);
  const target = join(childLease.directory, "report.md");
  const grant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => childSession } }, "write", "reader",
    { path: target }, builtinTools());
  assert.ok(grant);
  const registry = new SubagentSessionRegistry();
  const parentSession = randomUUID();
  registry.register(childSession, { parentSessionId: parentSession });
  const intent = {
    surface: "path_write",
    matchValues: [target],
    boundaryValue: target,
    requesterCwd: cwd,
    principal: { sessionId: childSession, agentName: "reader" },
    readerScratchWrite: grant.context.token,
  };
  const context = readerScratchForwardedWrite(intent, parentSession, registry);
  assert.deepEqual(context, { sessionId: childSession, token: grant.context.token },
    "the context is rebuilt only from the live token and principal");
  assert.equal(readerScratchWriteAgent(grant.context.token, childSession), "reader",
    "the identity helper confirms the live request");
  assert.ok(readerScratchWriteAgent(grant.context.token, randomUUID()) !== "reader",
    "a mismatched session gets no reader identity");
  assert.ok(readerScratchWriteAgent("not-a-token", childSession) !== "reader", "an unknown token gets no identity");
  // The serving node resolves against its own composed rules, agent-scoped to
  // the requester, with the rebuilt context.
  const served = resolver.resolve({ kind: "path-values", surface: "path_write", values: intent.matchValues,
    agentName: "reader", readerScratchWrite: context });
  assert.equal(served.state, "ask", "the child's own scratch ask is served through the live token");
  assert.equal(served.origin, "global");
  // Without the token, the same ask stays under the reader floor.
  assert.equal(resolver.resolve(writeIntent([target])).state, "deny");
  // Refusals: malformed or unproven provenance never rebuilds a context.
  const siblingSession = randomUUID();
  registry.register(siblingSession, { parentSessionId: parentSession });
  for (const [label, candidate] of [
    ["missing token", { ...intent, readerScratchWrite: undefined }],
    ["non-string token", { ...intent, readerScratchWrite: 42 }],
    ["non-reader principal", { ...intent, principal: { sessionId: childSession, agentName: "editor" } }],
    ["unregistered principal", { ...intent, principal: { sessionId: randomUUID(), agentName: "reader" } }],
    ["stolen token across registered siblings", { ...intent, principal: { sessionId: siblingSession, agentName: "reader" } }],
    ["peer match values", { ...intent, matchValues: [join(tmpdir(), "peer.txt")] }],
    ["wrong surface", { ...intent, surface: "path" }],
  ]) {
    let rebuilt = "unexpected";
    try { rebuilt = readerScratchForwardedWrite(candidate, parentSession, registry); } catch { rebuilt = undefined; }
    assert.equal(rebuilt, undefined, `refused: ${label}`);
  }
  assert.equal(readerScratchForwardedWrite(intent, randomUUID(), registry), undefined,
    "a different serving session cannot rebuild the context");
  assert.equal(readerScratchForwardedWrite(intent, parentSession, new SubagentSessionRegistry()), undefined,
    "an unregistered child cannot rebuild the context");
  const orphan = new SubagentSessionRegistry();
  orphan.register(childSession, { parentSessionId: randomUUID() });
  assert.equal(readerScratchForwardedWrite(intent, parentSession, orphan), undefined,
    "a child of another parent cannot rebuild the context");
  // A released token is dead on the wire, and the identity helper agrees.
  grant.release();
  assert.equal(readerScratchForwardedWrite(intent, parentSession, registry), undefined, "a released token never serves");
  assert.ok(readerScratchWriteAgent(grant.context.token, childSession) !== "reader");
});

test("the forwarded parser keeps ordinary facts and drops only malformed scratch tokens", (t) => {
  const base = scratchBase(t);
  const logger = { review() {}, debug() {} };
  const envelope = {
    id: randomUUID(), createdAt: Date.now(),
    requesterSessionId: "child-1", targetSessionId: "parent-1", requesterAgentName: "reader",
  };
  const intent = {
    surface: "path_write", matchValues: ["/tmp/pi-alehouse-reader-child/report.md"],
    boundaryValue: "/tmp/pi-alehouse-reader-child/report.md", requesterCwd: "/tmp",
    principal: { sessionId: "child-1", agentName: "reader" },
  };
  const read = (accessIntent) => {
    const path = join(base, `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ ...envelope, accessIntent }));
    return readForwardedPermissionRequest(logger, path);
  };
  const withToken = read({ ...intent, readerScratchWrite: "fixture-token" });
  assert.equal(withToken.accessIntent.readerScratchWrite, "fixture-token", "a well-formed token survives the wire");
  assert.equal(withToken.accessIntent.principal.sessionId, "child-1", "ordinary facts survive with it");
  // A malformed token is omitted, but the intent itself is retained intact.
  for (const [label, token] of [["a numeric token", 42], ["an object-shaped token", { sessionId: "child-1", token: "t" }], ["a null token", null]]) {
    const parsed = read({ ...intent, readerScratchWrite: token });
    assert.ok(parsed.accessIntent, `the intent is retained after ${label}`);
    assert.equal(parsed.accessIntent.readerScratchWrite, undefined, `only the malformed capability is omitted: ${label}`);
    assert.deepEqual(parsed.accessIntent.matchValues, intent.matchValues);
    assert.deepEqual(parsed.accessIntent.principal, intent.principal);
    assert.equal(parsed.accessIntent.surface, "path_write");
  }
  // A wholly malformed intent is still dropped entirely.
  const broken = read({ ...intent, matchValues: [42] });
  assert.equal(broken.accessIntent, undefined, "corrupt facts never reach the serving policy");
});

test("the serving server honors the scratch token only when the envelope matches the principal", async (t) => {
  const base = scratchBase(t);
  const { agentDir, configPath, cwd } = core(t);
  const resolver = makeResolver(makeManager(configPath, join(agentDir, "agents")));
  const servingSession = randomUUID();
  const registry = new SubagentSessionRegistry();
  // The recorded-policy edge: the serving composition rebuilds the context
  // from the live token (the authorizer projection never sees it).
  const servedIntents = [];
  const policy = {
    resolve(intent) {
      servedIntents.push(intent);
      const context = readerScratchForwardedWrite(intent, servingSession, registry);
      return resolver.resolve({ kind: "path-values", surface: intent.surface, values: intent.matchValues,
        agentName: intent.principal.agentName, ...(context ? { readerScratchWrite: context } : {}) });
    },
  };
  const server = new ForwardedRequestServer({
    forwardingDir: join(base, "forwarding"),
    logger: { review() {}, debug() {} },
    policy,
    escalator: { escalate: async () => ({ approved: true, state: "approved", decidedBy: { kind: "user", via: "dialog" } }) },
    broadcaster: { emitDecision() {} },
    recorder: { recordSessionApproval() {} },
    registry,
  });
  const location = createPermissionForwardingLocation(join(base, "forwarding"), servingSession);
  mkdirSync(location.requestsDir, { recursive: true });
  t.after(() => rmSync(join(base, "forwarding"), { recursive: true, force: true }));
  const ctx = { hasUI: false, ui: { notify() {} }, cwd,
    sessionManager: { getSessionId: () => servingSession, getSessionDir: () => location.sessionRootDir, getEntries: () => [] } };
  const submit = async ({ requesterSessionId, requesterAgentName, intent }) => {
    // Production cleanup removes the drained (empty) inbox after each pass, so
    // recreate it before every request.
    mkdirSync(location.requestsDir, { recursive: true });
    const id = randomUUID();
    const requestPath = join(location.requestsDir, `${id}.json`);
    writeFileSync(requestPath, JSON.stringify({
      id, createdAt: Date.now(), requesterSessionId, targetSessionId: servingSession, requesterAgentName, accessIntent: intent,
    }));
    await server.processInbox(ctx);
    assert.equal(existsSync(requestPath), false, "the drained request is removed");
    const responsePath = join(location.responsesDir, `${id}.json`);
    if (!existsSync(responsePath)) return null;
    const response = JSON.parse(readFileSync(responsePath, "utf8"));
    rmSync(responsePath);
    return response;
  };
  // A legitimate child ask: the token reaches the recorded-policy edge, the
  // recovered ask is escalated, and the human approves.
  const child = randomUUID();
  const childLease = leaseFor(t, child);
  const target = join(childLease.directory, "report.md");
  const grant = beginReaderScratchWrite({ sessionManager: { getSessionId: () => child } }, "write", "reader",
    { path: target }, builtinTools());
  assert.ok(grant);
  registry.register(child, { parentSessionId: servingSession });
  const intent = { surface: "path_write", matchValues: [target], boundaryValue: target, requesterCwd: cwd,
    principal: { sessionId: child, agentName: "reader" }, readerScratchWrite: grant.context.token };
  const served = await submit({ requesterSessionId: child, requesterAgentName: "reader", intent });
  assert.ok(served?.approved === true, "the child's own-scratch ask is served through the live token");
  assert.ok(servedIntents.some((seen) => seen.readerScratchWrite === grant.context.token),
    "the token reached the recorded-policy edge");
  // A sibling's envelope carrying this child's token: the server verifies the
  // principal against the envelope, so the exception must not be served.
  const sibling = randomUUID();
  registry.register(sibling, { parentSessionId: servingSession });
  const mismatched = await submit({ requesterSessionId: sibling, requesterAgentName: "reader", intent });
  assert.ok(mismatched === null || mismatched.approved !== true,
    "a principal/envelope mismatch never yields the scratch exception");
  // A released token is dead even with a matching envelope.
  grant.release();
  const revoked = await submit({ requesterSessionId: child, requesterAgentName: "reader", intent });
  assert.ok(revoked === null || revoked.approved !== true, "a released token never serves");
});
