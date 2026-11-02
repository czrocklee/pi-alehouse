// Offline, counted permission regressions. No shell/tool execution, model,
// network, approvals, host CLI or shared runtime generation. Build first under
// the single validation owner's coordination; patch checks use a private copy.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";
import { applyPermissionPerformancePatch } from "../../permission-system/performance-patch.mjs";

// Jiti can retain a named-import function at its first property read. Install
// stable forwarding functions BEFORE loading any authority modules, then switch
// only the active counter. Replacing fs methods per test misses retained imports
// and can charge a later call to a counter whose measurement already ended.
const originalFs = { statSync: fs.statSync, realpathSync: fs.realpathSync };
const originalWatch = fs.watch;
let watchImplementation = originalWatch;
const activeFsCounters = new Map();
for (const [name, original] of Object.entries(originalFs)) {
  let depth = 0;
  const invoke = (target, args) => {
    const counter = activeFsCounters.get(name);
    if (depth === 0 && counter) counter.calls++;
    depth++;
    try { return Reflect.apply(target, fs, args); }
    finally { depth--; }
  };
  const dispatch = (...args) => invoke(original, args);
  // A regular realpath call that delegates to .native is one observed API call,
  // while independent direct .native calls are counted too.
  if (typeof original.native === "function") dispatch.native = (...args) => invoke(original.native, args);
  fs[name] = dispatch;
}
fs.watch = (...args) => Reflect.apply(watchImplementation, fs, args);
syncBuiltinESMExports();
after(() => {
  assert.equal(activeFsCounters.size, 0, "every IO tap must release on return/throw/rejection");
  assert.equal(watchImplementation, originalWatch, "every watch mock must release");
  Object.assign(fs, originalFs); fs.watch = originalWatch; syncBuiltinESMExports();
});

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const vendor = join(packageRoot, "runtime/permission-system/vendor");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  "#src": join(vendor, "src"),
} });
const load = name => jiti.import(join(vendor, "src", `${name}.ts`));
const [matcher, snapshot, { FilePolicyLoader }, { PermissionManager }, { PathNormalizer },
  { posixPathFlavor, win32PathFlavor }, { canonicalizePath }, workspace, guardModule, checkpoint, forwardingWatch,
  { ForwardingManager }, { createPermissionForwardingLocation }, { ToolCallGatePipeline }, { PermissionResolver },
  { BashProgram }, { resolveToolPreviewLimits }] = await Promise.all([
  load("policy/wildcard-matcher"), load("policy/managed-permission-snapshot"),
  load("config/policy-loader"), load("policy/permission-manager"), load("path/path-normalizer"),
  load("path/path-flavor"), load("path/canonicalize-path"), load("policy/managed-workspace-policy"),
  jiti.import(join(packageRoot, "runtime/policy/static-safety-guard.ts")),
  jiti.import(join(packageRoot, "extensions/lib/hard-checkpoint.ts")),
  load("authority/managed-forwarding-watch"), load("authority/forwarding-manager"), load("authority/permission-forwarding"),
  load("handlers/gates/tool-call-gate-pipeline"), load("policy/permission-resolver"), load("access-intent/bash/program"),
  load("tool-input/tool-preview-formatter"),
]);
const { withSynchronousPermissionSnapshot: within, synchronousPermissionSample: sample } = snapshot;

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "alehouse-permission-performance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fsCount(name) {
  assert.ok(Object.hasOwn(originalFs, name), `No stable IO dispatcher for ${name}`);
  const previous = activeFsCounters.get(name), counter = { calls: 0 };
  activeFsCounters.set(name, counter);
  return {
    calls: () => counter.calls,
    close() { if (previous) activeFsCounters.set(name, previous); else activeFsCounters.delete(name); },
  };
}
function countedFs(name, read) {
  const counter = fsCount(name);
  try { return { value: read(counter.calls), calls: counter.calls }; }
  finally { counter.close(); }
}
async function countedFsAsync(name, read) {
  const counter = fsCount(name);
  try { return { value: await read(counter.calls), calls: counter.calls }; }
  finally { counter.close(); }
}
function countedRegex(read) {
  const Original = globalThis.RegExp;
  let calls = 0;
  globalThis.RegExp = new Proxy(Original, {
    construct(target, args) { calls++; return Reflect.construct(target, args); },
  });
  try { read(); return calls; }
  finally { globalThis.RegExp = Original; }
}
let stamp = Date.now();
function json(path, data) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(data));
  const date = new Date(stamp += 1000);
  fs.utimesSync(path, date, date);
}

test("stable FS dispatchers switch counters for captured imports, native calls and async measurements", async t => {
  const root = fixture(t), captured = fs.statSync, realpath = fs.realpathSync, native = fs.realpathSync.native;
  const first = countedFs("statSync", () => captured(root));
  const second = countedFs("statSync", () => { captured(root); captured(root); });
  assert.equal(first.calls(), 1); assert.equal(second.calls(), 2);
  captured(root);
  assert.equal(first.calls(), 1); assert.equal(second.calls(), 2, "inactive counters cannot receive later calls");
  const outer = countedFs("statSync", () => {
    captured(root);
    assert.equal(countedFs("statSync", () => captured(root)).calls(), 1);
    captured(root);
  });
  assert.equal(outer.calls(), 2, "nested taps restore the previous active counter");
  assert.throws(() => countedFs("statSync", () => { captured(root); throw new Error("tap failure"); }), /tap failure/);
  assert.equal(activeFsCounters.size, 0);
  assert.equal(countedFs("realpathSync", () => { realpath(root); native(root); }).calls(), 2,
    "regular and direct native API calls are each observed once");
  const asyncCount = await countedFsAsync("statSync", async () => { captured(root); await Promise.resolve(); captured(root); });
  assert.equal(asyncCount.calls(), 2);
  await assert.rejects(countedFsAsync("statSync", async () => { captured(root); await Promise.resolve(); throw new Error("tap rejection"); }), /tap rejection/);
  assert.equal(activeFsCounters.size, 0);
});

test("performance patch is pinned, drift-checked and byte-idempotent before import normalization", t => {
  const root = fixture(t), copy = join(root, "vendor");
  const upstream = resolve(dirname(require.resolve("@gotgenes/pi-permission-system")), "..");
  fs.cpSync(upstream, copy, { recursive: true, filter: path => !path.slice(upstream.length).split(/[\\/]/).includes("node_modules") });
  execFileSync(process.execPath, [join(packageRoot, "permission-system/apply-patch.mjs"), copy], { stdio: "pipe" });
  const files = ["policy/wildcard-matcher", "policy/managed-permission-snapshot", "config/policy-loader",
    "path/canonicalize-path", "handlers/gates/tool-call-gate-pipeline", "access-intent/bash/program", "policy/permission-manager",
    "authority/managed-forwarding-watch", "authority/forwarding-manager", "authority/approval-escalator", "index"];
  const before = files.map(name => fs.readFileSync(join(copy, "src", `${name}.ts`), "utf8"));
  applyPermissionPerformancePatch(copy);
  assert.deepEqual(files.map(name => fs.readFileSync(join(copy, "src", `${name}.ts`), "utf8")), before);
  const path = join(copy, "src/policy/wildcard-matcher.ts");
  fs.writeFileSync(path, fs.readFileSync(join(upstream, "src/policy/wildcard-matcher.ts"), "utf8")
    .replace("function escapeRegExp(value: string): string {", "function upstreamDrift(value: string): string {"));
  assert.throws(() => applyPermissionPerformancePatch(copy), /Performance patch drift/);
  json(join(copy, "package.json"), { version: "32.0.4" });
  assert.throws(() => applyPermissionPerformancePatch(copy), /32\.0\.3/);
});

test("wildcard regex cache preserves flags, separators, HOME, state and exact wildcard semantics", () => {
  const pattern = `performance-${randomUUID()} *`;
  assert.equal(countedRegex(() => {
    for (let i = 0; i < 100; i++) assert.equal(matcher.wildcardMatch(pattern, pattern.slice(0, -2)), true);
  }), 1);
  const first = matcher.compileWildcardPattern(pattern, "deny"), second = matcher.compileWildcardPattern(pattern, "ask");
  assert.equal(first.pattern, pattern); assert.equal(first.state, "deny"); assert.equal(second.state, "ask");
  for (const [rule, value, options, expected] of [
    ["a?b", "acb", undefined, true], ["a?b", "ab", undefined, false],
    ["a.b", "axb", undefined, false], ["a*b", "a\nb", undefined, true],
    ["C:/Case/*", "c:\\case\\file", win32PathFlavor.matchOptions, true],
    ["C:/Case/*", "c:\\case\\file", { caseInsensitive: true }, false],
    ["C:/Case/*", "c:\\case\\file", { windowsSeparators: true }, false],
    ["C:/Case/*", "C:\\Case\\file", { windowsSeparators: true }, true],
  ]) assert.equal(matcher.wildcardMatch(rule, value, options), expected, `${rule}:${value}`);
  const home = process.env.HOME;
  try {
    for (const value of ["/synthetic/performance-home-a", "/synthetic/performance-home-b"]) {
      process.env.HOME = value;
      for (const prefix of ["~", "$HOME", "${HOME}"]) assert.equal(matcher.wildcardMatch(`${prefix}/item`, `${value}/item`), true);
    }
    assert.equal(matcher.wildcardMatch("~/item", "/synthetic/performance-home-a/item"), false);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
});

test("regex cache evicts bounded entries and does not retain oversize patterns", () => {
  const first = `bounded-${randomUUID()}`;
  matcher.wildcardMatch(first, first);
  for (let i = 0; i < 4097; i++) matcher.wildcardMatch(`${first}-${i}`, "not-matching");
  assert.equal(countedRegex(() => matcher.wildcardMatch(first, first)), 1);
  const large = "x".repeat(8193);
  assert.equal(countedRegex(() => { matcher.wildcardMatch(large, large); matcher.wildcardMatch(large, large); }), 2);
});

test("Jiti repeated module identities share synchronous samples without crossing invocations, awaits or module roots", async t => {
  const root = fixture(t);
  fs.copyFileSync(join(packageRoot, "permission-system/managed-permission-snapshot.ts"), join(root, "snapshot.ts"));
  fs.copyFileSync(join(root, "snapshot.ts"), join(root, "other-generation.ts"));
  for (const name of ["left", "right"]) fs.writeFileSync(join(root, `${name}.ts`),
    'export { withSynchronousPermissionSnapshot as within, synchronousPermissionSample as sample } from "./snapshot.ts";');
  const options = { moduleCache: false, fsCache: false, tryNative: false };
  const loader = createJiti(join(root, "loader.mjs"), options);
  // Separate imports, not a single entry graph: Jiti's graph-local cache can
  // otherwise make moduleCache:false appear to preserve module identity.
  const left = await loader.import(join(root, "left.ts"));
  const right = await loader.import(join(root, "right.ts"));
  const independent = await createJiti(join(root, "other-loader.mjs"), options).import(join(root, "right.ts"));
  const other = await loader.import(join(root, "other-generation.ts"));
  assert.notEqual(left.sample, right.sample, "exercise actual duplicate helper evaluations");
  assert.notEqual(left.sample, independent.sample);
  let reads = 0;
  const read = () => String(++reads);
  const get = module => module.sample("policy-stamp", "/synthetic/path", read);
  left.within(() => {
    assert.deepEqual([get(left), get(right), get(independent)], ["1", "1", "1"]);
    assert.throws(() => right.within(() => {
      assert.deepEqual([get(left), get(right)], ["2", "2"]);
      throw new Error("nested scope");
    }), /nested scope/);
    assert.equal(get(left), "1", "nested throw restores the outer scope across module instances");
    assert.equal(other.synchronousPermissionSample("policy-stamp", "/synthetic/path", read), "3");
    assert.equal(other.synchronousPermissionSample("policy-stamp", "/synthetic/path", read), "4",
      "another module root cannot borrow this generation's samples");
  });
  assert.equal(get(right), "5"); assert.equal(get(independent), "6", "no scope survives return");
  right.within(() => assert.deepEqual([get(left), get(right)], ["7", "7"], "a new invocation samples freshly"));
  let resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  const pending = left.within(async () => {
    assert.equal(get(right), "8");
    await barrier;
    assert.equal(get(right), "10", "a pending invocation cannot retain its synchronous scope");
  });
  independent.within(() => assert.deepEqual([get(left), get(right)], ["9", "9"]));
  resume(); await pending;
  assert.equal(get(left), "11"); assert.equal(reads, 11);
});

test("sampling is bounded, space-separated, nested, exception-safe and never crosses a Promise continuation", async () => {
  let reads = 0;
  const read = () => String(++reads);
  within(() => {
    assert.equal(sample("a", "path", read), "1"); assert.equal(sample("a", "path", read), "1");
    assert.equal(sample("b", "path", read), "2");
    within(() => assert.equal(sample("a", "path", read), "3"));
    assert.equal(sample("a", "path", read), "1");
    assert.throws(() => within(() => { sample("a", "path", read); throw new Error("scope"); }), /scope/);
    assert.equal(sample("a", "path", read), "1");
  });
  assert.equal(sample("a", "path", read), "5");
  await within(async () => {
    const before = sample("a", "path", read);
    assert.equal(sample("a", "path", read), before);
    await Promise.resolve();
    assert.notEqual(sample("a", "path", read), before);
  });
  within(() => {
    for (let i = 0; i < 4096; i++) sample("bounded", String(i), read);
    const before = reads;
    sample("bounded", "overflow", read); sample("bounded", "overflow", read);
    assert.equal(reads - before, 2);
    assert.throws(() => sample("error", "x", () => { throw new Error("read failed"); }), /read failed/);
  });
});

test("policy stamps deduplicate only synchronous sampling and see the next deny/invalid config", t => {
  const root = fixture(t), global = join(root, "global.json"), project = join(root, "project.json");
  const agents = join(root, "agents"), projectAgents = join(root, "project-agents"), mcp = join(root, "mcp.json");
  json(global, { permission: { "*": "allow", bash: "allow" } });
  json(project, { permission: {} }); json(mcp, { mcpServers: { synthetic: {} } });
  const options = { globalConfigPath: global, projectGlobalConfigPath: project, agentsDir: agents,
    projectAgentsDir: projectAgents, globalMcpConfigPath: mcp };
  const loader = new FilePolicyLoader(options);
  const counts = countedFs("statSync", () => within(() => {
    for (let i = 0; i < 20; i++) { loader.getCacheStamp("editor"); loader.getConfiguredMcpServerNames(); }
  }));
  assert.equal(counts.calls(), 5, "four policy paths plus MCP, regardless of check count");
  assert.equal(countedFs("statSync", () => loader.getCacheStamp("editor")).calls(), 4);
  const manager = new PermissionManager({ ...options, isYoloEnabled: () => true });
  const check = () => manager.check({ kind: "tool", surface: "bash", input: { command: "synthetic-command" } });
  assert.equal(within(check).state, "allow");
  json(project, { permission: { bash: { "synthetic-command": "deny" } } });
  assert.equal(within(check).state, "deny");
  fs.writeFileSync(project, "invalid JSON"); const date = new Date(stamp += 1000); fs.utimesSync(project, date, date);
  assert.equal(within(check).origin, "fail-closed"); assert.equal(within(check).state, "ask");
});

test("actual pipeline bounds policy stamp reads and drops samples before asynchronous gate running", async t => {
  const root = fixture(t), global = join(root, "global.json"), project = join(root, "project.json");
  json(global, { permission: { "*": "allow", bash: "allow", path: "allow", external_directory: "allow" } });
  json(project, { permission: {} }); fs.writeFileSync(join(root, "item"), "fixture");
  const manager = new PermissionManager({ globalConfigPath: global, projectGlobalConfigPath: project,
    agentsDir: join(root, "agents"), mcpServerNames: [] });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, root);
  const pipeline = new ToolCallGatePipeline(resolver, { getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [],
    getToolPreviewLimits: () => resolveToolPreviewLimits(), getPathNormalizer: () => normalizer, getShellToolAliases: () => undefined });
  const command = Array(40).fill("cat ./item").join(" && ");
  await BashProgram.parse(command, normalizer); // Warm WASM outside IO accounting.
  let running = 0;
  const measured = await countedFsAsync("statSync", async calls => {
    return await pipeline.evaluate({ toolName: "bash", toolCallId: "counted", input: { command }, cwd: root }, {
      async run() {
        running++;
        if (running === 1) {
          assert.ok(calls() > 0 && calls() <= 12, `stamp reads (${calls()}) scale with synchronous producers, not 40 command units`);
          json(project, { permission: { bash: { "synthetic-command": "deny" } } });
          await Promise.resolve();
          assert.equal(manager.check({ kind: "tool", surface: "bash", input: { command: "synthetic-command" } }).state, "deny",
            "a gate runner/authorizer continuation must not inherit a frozen stamp");
        }
        return { action: "allow" };
      },
    });
  });
  assert.equal(measured.value.action, "allow"); assert.ok(running > 0);
});

test("canonicalization is keyed by absolute path and flavor, discarded before symlink changes", t => {
  const root = fixture(t), a = join(root, "a"), b = join(root, "b"), link = join(root, "link");
  for (const path of [a, b]) fs.mkdirSync(path);
  fs.writeFileSync(join(a, "item"), "a"); fs.writeFileSync(join(b, "item"), "b"); fs.symlinkSync(a, link);
  const normalizer = new PathNormalizer(posixPathFlavor, root);
  const counts = countedFs("realpathSync", () => within(() => {
    assert.equal(normalizer.forPath("link/item").boundaryValue(), join(a, "item"));
    assert.equal(normalizer.forPath("./link/item").boundaryValue(), join(a, "item"));
    assert.equal(canonicalizePath(join(link, "item"), Object.create(posixPathFlavor)), join(a, "item"));
  }));
  assert.equal(counts.calls(), 2, "equivalent absolute paths share, distinct flavors do not");
  fs.unlinkSync(link); fs.symlinkSync(b, link);
  assert.equal(normalizer.forPath("link/item").boundaryValue(), join(b, "item"));
  const scoped = within(() => [normalizer.forPath("item", { resolveBase: a }), normalizer.forPath("item", { resolveBase: b })]);
  assert.notEqual(scoped[0].boundaryValue(), scoped[1].boundaryValue());
  assert.equal(normalizer.forLiteral("item").boundaryValue(), "", "unknown cwd never gets a cached absolute alias");
});

test("workspace sampling keeps tombstones live and detects source symlink changes after await", async t => {
  const root = fixture(t), cwd = join(root, "worktree"), a = join(root, "source-a"), b = join(root, "source-b"), source = join(root, "source");
  for (const path of [cwd, a, b]) fs.mkdirSync(path);
  fs.symlinkSync(a, source);
  const sessionId = randomUUID(), ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
  const lease = workspace.bindWorkspacePolicy({ sessionId, cwd, source_cwd: source, checkout_root: cwd, source_root: source, projectTrusted: true });
  t.after(() => lease.release());
  const binding = workspace.workspacePolicyForContext(ctx);
  assert.equal(countedFs("realpathSync", () => within(() => {
    workspace.assertWorkspacePolicy(binding); workspace.assertWorkspacePolicy(binding);
  })).calls(), 2);
  await within(async () => { workspace.assertWorkspacePolicy(binding); await Promise.resolve(); });
  fs.unlinkSync(source); fs.symlinkSync(b, source);
  assert.throws(() => workspace.assertWorkspacePolicy(binding), /directory binding changed/);
  fs.unlinkSync(source); fs.symlinkSync(a, source);
  within(() => {
    workspace.assertWorkspacePolicy(binding); lease.release();
    assert.throws(() => workspace.assertWorkspacePolicy(binding), /stale or forged/);
    assert.throws(() => workspace.workspacePolicyForContext(ctx), /released/);
  });
});

test("static guard reads current deny bytes, parses unchanged content once and resolves identity once per phase", t => {
  const root = fixture(t), config = join(root, "extensions/pi-permission-system/config.json");
  const data = { fixture: randomUUID(), permission: { bash: { "*": "ask", "sudo *": "deny", "printf *": "allow", "wc *": "allow" } } };
  json(config, data);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const hooks = new Map();
  guardModule.default({ on: (name, handler) => hooks.set(name, handler), events: { on: () => () => {}, emit() {} } });
  let entries = 0, agent = "editor", prompt = "";
  const ctx = { cwd: root, getSystemPrompt: () => prompt, sessionManager: {
    getSessionId: () => "static-performance", getEntries: () => { entries++; return agent ? [{ type: "custom", customType: "active_agent", data: { name: agent } }] : []; },
  } };
  hooks.get("session_start")({}, ctx);
  const call = command => hooks.get("tool_call")({ toolName: "bash", toolCallId: "reused-id", input: { command } }, ctx);
  const originalParse = JSON.parse; let parses = 0;
  JSON.parse = (...args) => { parses++; return Reflect.apply(originalParse, JSON, args); };
  try {
    assert.equal(call("git commit -m fixture"), undefined); assert.equal(entries, 1); assert.equal(parses, 0);
    assert.equal(guardModule.originalBashDeny("git commit -m fixture", ctx, root), undefined); assert.equal(entries, 2);
    agent = "researcher";
    assert.equal(call("git commit -m fixture")?.block, true, "same toolCallId must see the new identity");
    agent = "editor"; data.permission.bash["git commit *"] = "deny"; json(config, data);
    assert.equal(call("git commit -m fixture")?.block, true); assert.equal(parses, 1);
    assert.equal(call("git commit -m fixture")?.block, true); assert.equal(parses, 1);
    fs.writeFileSync(config, "invalid JSON"); assert.equal(call("git status")?.block, true);
    fs.unlinkSync(config); assert.equal(call("git status")?.block, true, "cannot fall back to a previous parsed allow");
  } finally { JSON.parse = originalParse; }
  json(config, data); agent = undefined; prompt = '<active_agent name="editor"/><active_agent name="researcher"/>';
  assert.equal(call("git status")?.block, true, "ambiguous legacy identity still fails closed");
});

test("lexical event reuse preserves dangerous substitutions, heredocs and redirect metadata", t => {
  const root = fixture(t); json(join(root, "extensions/pi-permission-system/config.json"), {
    permission: { bash: { "sudo *": "deny", "wc *": "allow", "printf *": "allow", "echo *": "allow" } },
  });
  const ctx = { cwd: root, getSystemPrompt: () => "", sessionManager: { getEntries: () => [], getSessionId: () => "lexical-performance" } };
  for (const command of ['echo "$(sudo true)"', "sudo 2>/dev/null true", 's"u"do true']) {
    assert.ok(guardModule.originalBashDeny(command, ctx, root), command);
  }
  assert.equal(guardModule.originalBashDeny("wc -l <<'EOF'\nsudo true\nEOF", ctx, root), undefined, "quoted heredoc body stays data");
  assert.equal(guardModule.originalBashDeny("printf '%s' 'sudo true'", ctx, root), undefined, "quoted payload stays data");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const hooks = new Map();
  guardModule.default({ on: (name, handler) => hooks.set(name, handler), events: { on: () => () => {}, emit() {} } });
  hooks.get("session_start")({}, ctx);
  const call = command => hooks.get("tool_call")({ toolName: "bash", input: { command } }, ctx);
  for (const command of ["wc -l <<EOF\n$(sudo true)\nEOF", "printf '%n' PATH", "printf ok > $OUTPUT", "PATH=$(pwd) git status"]) {
    assert.equal(call(command)?.block, true, command);
  }
  for (const command of ["wc -l <<'EOF'\n$(sudo true)\nEOF", "printf '%s' 'sudo true'", "printf ok 2>&1"]) {
    assert.equal(call(command), undefined, command);
  }
});

test("hoisted interpreter regexes remain stateless across repeated checkpoint decisions", () => {
  const details = { payload: { kind: "bash", evidence: [], request: { toolName: "bash", surface: "bash", value: "node -e 'console.log(1)'" } } };
  const current = { name: "bash", arguments: { command: "node -e 'console.log(1)'" } };
  const expected = checkpoint.hardCheckpointReason(details, current);
  assert.equal(countedRegex(() => {
    for (let i = 0; i < 20; i++) assert.equal(checkpoint.hardCheckpointReason(details, current), expected);
  }), 0);
});

function mockWatches(t) {
  const previous = watchImplementation, watchers = [], attempts = [];
  let failure;
  watchImplementation = (path, _options, listener) => {
    attempts.push({ path, time: performance.now() });
    if (failure) throw Object.assign(new Error(`synthetic watch ${failure}`), { code: failure });
    const watcher = new EventEmitter();
    watcher.path = path; watcher.closed = false; watcher.listener = listener;
    watcher.close = () => { watcher.closed = true; watcher.emit("close"); };
    watchers.push(watcher);
    return watcher;
  };
  t.after(() => { watchImplementation = previous; });
  return { watchers, attempts, fail: code => { failure = code; },
    unsupported: value => { failure = value ? "ENOSYS" : undefined; } };
}
function watchClock(t) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  return { advance(ms) { now += ms; } };
}

for (const [code, kind, maximum] of [
  ["ENOSPC", "resource", 8], ["EMFILE", "resource", 8], ["ENFILE", "resource", 8],
  ["ENOSYS", "unsupported", 5], ["ENOTSUP", "unsupported", 5], ["EACCES", "other", 8],
]) test(`watch registration ${code} has bounded retries, recovers and stops after close`, t => {
  const clock = watchClock(t), root = fixture(t), directory = join(root, "session/requests");
  fs.mkdirSync(directory, { recursive: true });
  const mock = mockWatches(t); mock.fail(code);
  const observer = forwardingWatch.watchPermissionDirectory(directory, () => {}, root);
  t.after(() => observer.close());
  assert.equal(observer.failure, kind); assert.equal(observer.active, false);
  assert.equal(mock.attempts.length, 1, "one failure must not register again at every ancestor");
  for (let i = 0; i < 480; i++) { clock.advance(250); observer.refresh(); }
  assert.ok(mock.attempts.length <= maximum, `${code}: watch attempts in two minutes are bounded, not 480 poll ticks`);
  assert.ok(mock.attempts.every(attempt => attempt.path === directory), "no broader registration on global/resource errors");
  mock.fail(undefined); clock.advance(30_000); observer.refresh();
  assert.equal(observer.active, true); assert.equal(observer.failure, undefined);
  const recovered = mock.attempts.length;
  for (let i = 0; i < 480; i++) { clock.advance(250); observer.refresh(); }
  assert.equal(mock.attempts.length, recovered, "active watchers never re-register on poll");
  observer.close(); clock.advance(60_000); observer.refresh();
  assert.equal(mock.attempts.length, recovered, "close retires retry deadlines without a retry timer");
  assert.ok(mock.watchers.every(watcher => watcher.closed));
});

test("watch errors emitted immediately after registration also retain increasing backoff", t => {
  const clock = watchClock(t), root = fixture(t), mock = mockWatches(t);
  const observer = forwardingWatch.watchPermissionDirectory(root, () => {});
  t.after(() => observer.close());
  mock.watchers.at(-1).emit("error", Object.assign(new Error("exhausted"), { code: "ENOSPC" }));
  assert.equal(observer.failure, "resource");
  clock.advance(999); observer.refresh(); assert.equal(mock.attempts.length, 1);
  clock.advance(1); observer.refresh(); assert.equal(mock.attempts.length, 2);
  mock.watchers.at(-1).emit("error", Object.assign(new Error("exhausted again"), { code: "EMFILE" }));
  clock.advance(1000); observer.refresh(); assert.equal(mock.attempts.length, 2, "registration alone does not erase failure history");
  clock.advance(1000); observer.refresh(); assert.equal(mock.attempts.length, 3);
  observer.close(); clock.advance(60_000); observer.refresh(); assert.equal(mock.attempts.length, 3);
});

test("missing watch parents recover on creation within the original boundary without directory creation by the helper", t => {
  const clock = watchClock(t), root = fixture(t), boundary = join(root, "future"), directory = join(boundary, "session/requests");
  const mock = mockWatches(t);
  const observer = forwardingWatch.watchPermissionDirectory(directory, () => {}, boundary);
  t.after(() => observer.close());
  for (let i = 0; i < 124; i++) { clock.advance(250); observer.refresh(); }
  assert.equal(observer.failure, "missing"); assert.equal(mock.attempts.length, 0);
  assert.equal(fs.existsSync(boundary), false, "watch setup must never create directories");
  fs.mkdirSync(boundary); clock.advance(1000); observer.refresh();
  assert.equal(observer.active, true); assert.equal(mock.watchers.at(-1).path, boundary);
  const ancestor = mock.watchers.at(-1), registered = mock.attempts.length;
  for (let i = 0; i < 20; i++) ancestor.listener("rename", "unrelated");
  assert.equal(mock.attempts.length, registered, "unchanged active ancestor does not repeatedly re-register");
  fs.mkdirSync(directory, { recursive: true }); ancestor.listener("rename", "session");
  assert.equal(ancestor.closed, true); assert.equal(mock.watchers.at(-1).path, directory);
  assert.ok(mock.attempts.every(attempt => attempt.path === boundary || attempt.path === directory));
});

test("inode replacement resets an inactive watch deadline and rebinds an active watch", t => {
  const clock = watchClock(t), root = fixture(t), directory = join(root, "responses"); fs.mkdirSync(directory);
  const mock = mockWatches(t); mock.fail("ENOSYS");
  const observer = forwardingWatch.watchPermissionDirectory(directory, () => {});
  t.after(() => observer.close());
  assert.equal(mock.attempts.length, 1);
  fs.renameSync(directory, join(root, "old-responses")); fs.mkdirSync(directory);
  mock.fail(undefined); clock.advance(1000); observer.refresh();
  assert.equal(observer.active, true); assert.equal(mock.attempts.length, 2, "new inode may recover before unsupported backoff expires");
  const previous = mock.watchers.at(-1);
  fs.renameSync(directory, join(root, "replaced-responses")); fs.mkdirSync(directory);
  clock.advance(1000); observer.refresh(); // Even a lost rename notification recovers.
  assert.equal(previous.closed, true); assert.equal(mock.attempts.length, 3);
  previous.listener("change", "stale"); assert.equal(mock.attempts.length, 3);
});

test("inactive inbox observers keep backoff while 250ms poll and serving refresh remain live across session changes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clock = watchClock(t), root = fixture(t), mock = mockWatches(t); mock.fail("ENOSPC");
  let calls = 0, marks = 0, current = randomUUID();
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => current } };
  const manager = new ForwardingManager({ forwardingDir: root,
    forwarder: { async processInbox() { calls++; } },
    serving: { markServing() { marks++; }, clearServing() {} }, logger: { review() {}, debug() {} },
  });
  t.after(() => manager.stop()); manager.start(ctx);
  for (let i = 0; i < 40; i++) { clock.advance(250); t.mock.timers.tick(250); await Promise.resolve(); }
  assert.equal(calls, 40, "notification errors do not delay the existing inbox poll");
  assert.equal(marks, 41, "serving announcement still refreshes on every poll");
  assert.ok(mock.attempts.length <= 4, "inactive observer survives each timer tick with its backoff intact");
  const before = mock.attempts.length;
  for (let i = 0; i < 100; i++) manager.start(ctx);
  assert.equal(mock.attempts.length, before, "same-session lifecycle hooks do not reset backoff");
  current = randomUUID(); manager.start(ctx);
  assert.equal(mock.attempts.length, before + 1, "a new session gets its own registration scope");
  mock.fail(undefined);
  for (let i = 0; i < 4; i++) { clock.advance(250); t.mock.timers.tick(250); await Promise.resolve(); }
  assert.equal(mock.attempts.length, before + 2); assert.ok(mock.watchers.at(-1));
  manager.stop(); const stopped = mock.attempts.length, stoppedCalls = calls;
  clock.advance(60_000); t.mock.timers.tick(60_000);
  assert.equal(mock.attempts.length, stopped); assert.equal(calls, stoppedCalls);
  assert.ok(mock.watchers.every(watcher => watcher.closed));
});

test("response reads keep their 250ms wake budget while registration failures back off", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = watchClock(t), root = fixture(t), directory = join(root, "responses"); fs.mkdirSync(directory);
  const mock = mockWatches(t); mock.fail("EMFILE");
  const wake = forwardingWatch.permissionResponseWake(directory); t.after(() => wake.close());
  let completed = 0;
  for (let i = 0; i < 480; i++) {
    const pending = wake.wait(250).then(() => { completed++; });
    clock.advance(249); t.mock.timers.tick(249); await Promise.resolve(); assert.equal(completed, i);
    clock.advance(1); t.mock.timers.tick(1); await pending; assert.equal(completed, i + 1);
  }
  assert.ok(mock.attempts.length <= 8, "two minutes of reads do not recreate a failed observer each poll");
  mock.fail(undefined); clock.advance(30_000);
  const pending = wake.wait(250); mock.watchers.at(-1).listener("rename", "response.json"); await pending;
  const recovered = mock.attempts.length; wake.close();
  clock.advance(60_000); t.mock.timers.tick(60_000);
  assert.equal(mock.attempts.length, recovered); assert.ok(mock.watchers.every(watcher => watcher.closed));
});

test("response notifications latch, retain poll fallback and dispose exchange watchers/timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fixture(t), dir = join(root, "responses"); fs.mkdirSync(dir);
  const mock = mockWatches(t), wake = forwardingWatch.permissionResponseWake(dir);
  t.after(() => wake.close());
  let finished = 0;
  const first = wake.wait(250).then(() => { finished++; });
  mock.watchers.at(-1).listener("rename", "response.json"); await first;
  assert.equal(finished, 1);
  mock.watchers.at(-1).listener("change", "response.json");
  await wake.wait(250); // Notification arrived before waiter registration.
  const lost = wake.wait(250).then(() => { finished++; });
  t.mock.timers.tick(249); await Promise.resolve(); assert.equal(finished, 1);
  t.mock.timers.tick(1); await lost; assert.equal(finished, 2, "dropped notification still polls at 250ms");
  const previous = mock.watchers.at(-1);
  fs.renameSync(dir, join(root, "retired-responses")); fs.mkdirSync(dir);
  previous.listener("rename", "responses");
  assert.equal(previous.closed, true); assert.notEqual(mock.watchers.at(-1), previous);
  await wake.wait(250); // Replacement event was latched.
  mock.watchers.at(-1).emit("error", new Error("synthetic error"));
  mock.unsupported(true);
  const fallback = wake.wait(250); t.mock.timers.tick(250); await fallback;
  const pending = wake.wait(250); wake.close(); await pending;
  assert.ok(mock.watchers.every(watcher => watcher.closed));
  t.mock.timers.tick(1000);
});

test("inbox notification follows bounded directory creation, session switches and the processing lock", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = fixture(t), mock = mockWatches(t), calls = [], pending = [];
  let marks = 0, current = randomUUID();
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => current } };
  const manager = new ForwardingManager({ forwardingDir: root,
    forwarder: { processInbox(context) { calls.push(context.sessionManager.getSessionId()); return new Promise(resolve => pending.push(resolve)); } },
    serving: { markServing() { marks++; }, clearServing() {} }, logger: { review() {}, debug() {} },
  });
  t.after(() => manager.stop());
  manager.start(ctx);
  assert.equal(mock.watchers.at(-1).path, root, "watch closest existing ancestor, not an invented permanent inbox");
  const firstId = current, location = createPermissionForwardingLocation(root, current);
  fs.mkdirSync(location.requestsDir, { recursive: true });
  mock.watchers.at(-1).listener("rename", "sessions");
  assert.equal(mock.watchers.at(-1).path, location.requestsDir);
  assert.deepEqual(calls, [firstId]);
  mock.watchers.at(-1).listener("change", "request.json"); assert.equal(calls.length, 1, "events cannot overlap inbox processing");
  const stale = mock.watchers.at(-1);
  current = randomUUID(); stale.listener("rename", "old-request.json"); assert.equal(calls.length, 1);
  t.mock.timers.tick(250); assert.deepEqual(calls, [firstId], "old pending processing still owns its lock");
  assert.ok(marks >= 2, "heartbeat refresh continues even while processing");
  manager.stop(); manager.start(ctx);
  mock.watchers.at(-1).listener("change", "new-session"); assert.equal(calls.length, 2);
  pending[0](); await Promise.resolve(); await Promise.resolve();
  mock.watchers.at(-1).listener("change", "new-request"); assert.equal(calls.length, 2, "old finally cannot release a replacement processing lock");
  pending[1](); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(250); assert.equal(calls.length, 3, "poll drains even with no notification");
  pending[2](); await Promise.resolve();
  manager.stop();
  assert.ok(mock.watchers.every(watcher => watcher.closed));
  const before = calls.length; stale.listener("change", "late"); t.mock.timers.tick(1000);
  assert.equal(calls.length, before, "shutdown retires watches and poll timers");
});
