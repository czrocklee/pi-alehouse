import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { createDispatchRuntime } from "../../dist/runtime/dispatch-runtime.js";
import { FileLeaseLock } from "../../dist/runtime/owner-lease.js";
import { resolveGit } from "../../../bin/runtime-support.mjs";
import { flock } from "../support/flock.mjs";

const bash = ["/bin/bash", "/usr/bin/bash", "/run/current-system/sw/bin/bash"].find(existsSync);
assert(bash, "Bash fixture interpreter unavailable (PATH is not trusted)");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const flags = ["--no-lazy-fetch", "--no-optional-locks", "--no-pager", "--no-replace-objects"];
const head = "0123456789abcdef0123456789abcdef01234567";
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-dispatch-runtime-")));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), home = join(root, "home");
  for (const path of [cwd, agentDir, home]) mkdirSync(path, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const service = { checkPermission(surface, value, profile) { calls.push({ surface, value, profile }); return { state: "allow" }; } };
  const context = { cwd, profile: "editor", deferInputs: false, acquireTree: true };
  const runtime = options => createDispatchRuntime({ agentDir, flock, getPermissionsService: () => service, ...options });
  return { root, cwd, agentDir, home, calls, service, context, runtime };
}
function error(code, key, requested) {
  return e => {
    assert.equal(e.code, code);
    if (key !== undefined) assert.equal(e.details.key, key);
    if (requested !== undefined) assert.equal(e.details.requested, requested);
    return true;
  };
}
function withStat(replacement, run) {
  const original = fs.statSync;
  fs.statSync = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  try { return run(); }
  finally { fs.statSync = original; syncBuiltinESMExports(); }
}
async function withEnvironment(values, run) {
  const old = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await run(); }
  finally {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("dispatch prepare is synchronous, copied, literal, and keeps all resolved deferred inputs", t => {
  const f = fixture(t), runtime = f.runtime();
  const raw = { inputs: ["./missing"], ownership: ["output/new"], tree: "new-tree", checks: ["unit/*.test.mjs"] };
  const prepared = runtime.prepare(raw, { ...f.context, deferInputs: true });
  assert.equal(prepared.then, undefined);
  assert.deepEqual(prepared.inputs, [{ path: join(f.cwd, "missing"), canonical: join(f.cwd, "missing") }]);
  assert.deepEqual(prepared.ownership, [{ path: join(f.cwd, "output/new"), canonical: join(f.cwd, "output/new") }]);
  assert.equal(prepared.tree.canonical, join(f.cwd, "new-tree"));
  assert.deepEqual(prepared.declaration, raw);
  raw.inputs.push("later"); assert.equal(prepared.declaration.inputs.length, 1);
  assert(!existsSync(join(f.cwd, "new-tree")));
  assert.throws(() => runtime.prepare({ inputs: ["./missing"] }, f.context), error("DISPATCH_INPUT_MISSING", "inputs", "./missing"));
});

test("validateDispatch rejects ambiguous path language before permissions or IO classification", t => {
  const f = fixture(t);
  for (const path of ["*", "a?", "[a]", "{a,b}", "'a'", '"a"', "$a", "a\\b", "~a", "@a", "a\n", "a\0", "`a`", ""]) {
    assert.throws(() => f.runtime().prepare({ ownership: [path] }, f.context), error("INVALID_DISPATCH"));
  }
  assert.equal(f.calls.length, 0);
});

test("all public profile/external checks precede every input/tree classification stat", t => {
  const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.cwd, "link"));
  writeFileSync(join(f.cwd, "input"), "input");
  const events = [];
  f.service.checkPermission = (surface, value, profile) => { events.push({ surface, value, profile }); return { state: "ask" }; };
  const prepared = withStat((original, path, ...args) => { events.push({ stat: path }); return original(path, ...args); }, () =>
    f.runtime().prepare({ inputs: ["input"], ownership: ["link/new/file"], tree: "link/new-tree" }, f.context));
  assert.deepEqual(events.slice(0, 5), [
    { surface: "path_read", value: join(f.cwd, "input"), profile: "editor" },
    { surface: "path_write", value: join(f.cwd, "link/new/file"), profile: "editor" },
    { surface: "path_write", value: join(f.cwd, "link/new-tree"), profile: "editor" },
    { surface: "external_directory_write", value: join(outside, "new/file"), profile: "editor" },
    { surface: "external_directory_write", value: join(outside, "new-tree"), profile: "editor" },
  ]);
  assert.deepEqual(events.slice(5), [{ stat: join(f.cwd, "input") }, { stat: join(f.cwd, "link/new-tree") }]);
  assert.equal(prepared.ownership[0].canonical, join(outside, "new/file"));
});

test("deny beats missing input without any classification stat and reports the precise declaration", t => {
  const f = fixture(t);
  f.service.checkPermission = (surface, _path, profile) => {
    assert.equal(profile, "reader"); return { state: surface === "path_write" ? "deny" : "allow" };
  };
  withStat(() => { assert.fail("deny must precede classification stat"); }, () => {
    assert.throws(() => f.runtime().prepare({ inputs: ["secret-missing"], ownership: ["output"] }, { ...f.context, profile: "reader" }),
      error("PREFLIGHT_DENIED", "ownership", "output"));
  });
});

test("canonical cwd boundary applies external read and denies even for deferred/missing input", t => {
  const f = fixture(t), sibling = join(f.root, "repo-other"); mkdirSync(sibling);
  symlinkSync(f.cwd, join(f.root, "cwd-alias"));
  symlinkSync(sibling, join(f.cwd, "outside"));
  f.service.checkPermission = (surface, value, profile) => {
    f.calls.push({ surface, value, profile }); return { state: surface === "external_directory_read" ? "deny" : "unknown" };
  };
  assert.throws(() => f.runtime().prepare({ inputs: ["outside/missing"] }, { ...f.context, cwd: join(f.root, "cwd-alias"), deferInputs: true }),
    error("PREFLIGHT_DENIED", "inputs", "outside/missing"));
  assert.deepEqual(f.calls.map(call => call.surface), ["path_read", "external_directory_read"]);
  assert.equal(f.calls[1].value, join(sibling, "missing"));
  f.calls.length = 0;
  f.runtime().prepare({ ownership: ["new"] }, { ...f.context, cwd: join(f.root, "cwd-alias") });
  assert.deepEqual(f.calls.map(call => call.surface), ["path_write"]);
});

test("policy unknown is allowed, but missing/broken/throwing/async public API is unavailable", t => {
  const f = fixture(t);
  for (const state of ["allow", "ask", "unknown"]) {
    f.runtime({ getPermissionsService: () => ({ checkPermission: () => ({ state }) }) }).prepare({ ownership: ["new"] }, f.context);
  }
  const services = [undefined, null, {}, { checkPermission: false }, Promise.resolve({}),
    ...[undefined, null, "allow", true, {}, [], { state: "bad" }, { state: "allow", then() {} }, Promise.resolve({ state: "allow" })]
      .map(result => ({ checkPermission: () => result })),
    { checkPermission() { throw new Error("API failed"); } },
    { get checkPermission() { throw new Error("API getter failed"); } },
    { checkPermission: () => ({ get state() { throw new Error("state getter failed"); } }) },
  ];
  withStat(() => { assert.fail("invalid permission API must precede classification"); }, () => {
    for (const service of services) assert.throws(() => f.runtime({ getPermissionsService: () => service }).prepare({ inputs: ["missing"] }, f.context), error("DISPATCH_PREFLIGHT_UNAVAILABLE"));
    assert.throws(() => f.runtime({ getPermissionsService() { throw new Error("service failed"); } }).prepare({ ownership: ["new"] }, f.context), error("DISPATCH_PREFLIGHT_UNAVAILABLE"));
  });
});

test("input/tree missing, type and inspection errors are distinct; ownership may not exist", t => {
  const f = fixture(t), runtime = f.runtime();
  writeFileSync(join(f.cwd, "file"), "x"); mkdirSync(join(f.cwd, "directory"));
  runtime.prepare({ inputs: ["file", "directory"], ownership: ["not-created"], tree: "not-created-tree" }, f.context);
  assert.throws(() => runtime.prepare({ tree: "file" }, { ...f.context, deferInputs: true }), error("DISPATCH_TREE_TYPE", "tree", "file"));
  assert.throws(() => runtime.prepare({ inputs: ["missing"] }, f.context), error("DISPATCH_INPUT_MISSING", "inputs", "missing"));
  symlinkSync("/dev/null", join(f.cwd, "device"));
  assert.throws(() => runtime.prepare({ inputs: ["device"] }, f.context), error("DISPATCH_INPUT_TYPE", "inputs", "device"));
  withStat(() => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); }, () => {
    assert.throws(() => runtime.prepare({ inputs: ["file"] }, f.context), error("DISPATCH_INPUT_INSPECTION_FAILED", "inputs", "file"));
    assert.throws(() => runtime.prepare({ tree: "directory" }, f.context), error("DISPATCH_TREE_INSPECTION_FAILED", "tree", "directory"));
  });
});

test("dangling/cyclic aliases and non-directory ancestors fail path interpretation explicitly", t => {
  const f = fixture(t);
  symlinkSync(join(f.root, "gone"), join(f.cwd, "dangling"));
  symlinkSync("cycle", join(f.cwd, "cycle"));
  writeFileSync(join(f.cwd, "file"), "x");
  for (const path of ["dangling/new", "cycle/new", "file/new"])
    assert.throws(() => f.runtime().prepare({ ownership: [path] }, f.context), error("DISPATCH_PATH_UNKNOWN", "ownership", path));
});

test("known deny precedes dangling aliases, denied file parents and inaccessible ancestry", t => {
  const f = fixture(t);
  symlinkSync(join(f.root, "gone"), join(f.cwd, "dangling"));
  writeFileSync(join(f.cwd, "parent-file"), "x");
  const deny = { checkPermission: () => ({ state: "deny" }) };
  withStat(() => { assert.fail("known deny must not classify input"); }, () => {
    for (const input of ["dangling/new", "parent-file/new", "missing/new"]) {
      assert.throws(() => f.runtime({ getPermissionsService: () => deny }).prepare({ inputs: [input] }, f.context),
        error("PREFLIGHT_DENIED", "inputs", input));
    }
    const original = fs.lstatSync;
    fs.lstatSync = () => { throw Object.assign(new Error("inaccessible"), { code: "EACCES" }); };
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.runtime({ getPermissionsService: () => deny }).prepare({ inputs: ["inaccessible/input"] }, f.context),
        error("PREFLIGHT_DENIED", "inputs", "inaccessible/input"));
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  });
});

test("a pending canonical error cannot obscure another declaration's known external deny", t => {
  const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
  symlinkSync(join(f.root, "gone"), join(f.cwd, "dangling"));
  symlinkSync(outside, join(f.cwd, "external"));
  f.service.checkPermission = surface => ({ state: surface === "external_directory_write" ? "deny" : "allow" });
  withStat(() => { assert.fail("denied external declaration must not classify missing input"); }, () => {
    assert.throws(() => f.runtime().prepare({ inputs: ["dangling/new"], ownership: ["external/new"] }, f.context),
      error("PREFLIGHT_DENIED", "ownership", "external/new"));
  });
});

test("resolved and canonical policy literals refuse trimmed names/trailing quotes, including cwd aliases", t => {
  const f = fixture(t);
  for (const suffix of [" ", "'", '"']) {
    const unsupported = join(f.root, `unsupported${suffix}`); mkdirSync(unsupported);
    const alias = join(f.cwd, `alias-${suffix.charCodeAt(0)}`); symlinkSync(unsupported, alias);
    assert.throws(() => f.runtime().prepare({ ownership: [alias] }, f.context), error("DISPATCH_PATH_UNKNOWN", "ownership", alias));
    assert.throws(() => f.runtime().prepare({ checks: ["focused"] }, { ...f.context, cwd: unsupported }), error("DISPATCH_PATH_UNKNOWN"));
    // An alias with a supported lexical name must still reject unsafe cwd identity.
    assert.throws(() => f.runtime().prepare({ checks: ["focused"] }, { ...f.context, cwd: alias }), error("DISPATCH_PATH_UNKNOWN"));
  }
});

test("tree lease uses private canonical-hash directories, contends across aliases and never creates user tree", async t => {
  const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.cwd, "alias"));
  const runtime = f.runtime(), prepared = runtime.prepare({ tree: "alias/not-created" }, f.context);
  const first = await runtime.start(prepared, f.context); assert(first.lease); t.after(() => first.lease.close());
  assert.equal(first.source_state, undefined); assert.equal(first.notes, undefined); first.lease.assertHeld();
  const lockRoot = join(f.agentDir, "harness-trees"), leaf = join(lockRoot, sha(join(outside, "not-created")));
  for (const path of [lockRoot, leaf]) { assert.equal(lstatSync(path).mode & 0o7777, 0o700); assert.equal(lstatSync(path).uid, process.getuid()); }
  assert.deepEqual(readdirSync(leaf), ["owner.lock"]);
  assert(!existsSync(join(outside, "not-created"))); assert.deepEqual(readdirSync(outside), []);
  const second = await f.runtime().start(f.runtime().prepare({ tree: join(outside, "not-created") }, f.context), f.context);
  assert.deepEqual(second.notes, ["tree_shared"]); assert.equal(second.lease, undefined);
  const inode = lstatSync(join(leaf, "owner.lock")).ino;
  first.lease.close(); first.lease.close();
  const next = await runtime.start(runtime.prepare({ tree: "alias/not-created", checks: ["focused"] }, f.context), f.context);
  assert(next.lease); assert.equal(next.source_state.state, "unknown"); next.lease.close();
  assert.equal(lstatSync(join(leaf, "owner.lock")).ino, inode);
});

test("tree locking is only tree && acquireTree; unsafe roots/leaves are not repaired", async t => {
  const f = fixture(t), runtime = f.runtime(), prepared = runtime.prepare({ tree: "tree" }, f.context);
  assert.deepEqual(await runtime.start(prepared, { ...f.context, acquireTree: false }), {});
  assert.deepEqual(await runtime.start(runtime.prepare({ ownership: ["tree"] }, f.context), f.context), {});
  const root = join(f.agentDir, "harness-trees"), leaf = join(root, sha(join(f.cwd, "tree")));
  assert(!existsSync(root));
  mkdirSync(root, { mode: 0o755 });
  assert.deepEqual((await runtime.start(prepared, f.context)).notes, ["tree_lock_unknown"]);
  assert.equal(lstatSync(root).mode & 0o7777, 0o755); assert(!existsSync(leaf));
  chmodSync(root, 0o700);
  mkdirSync(leaf, { mode: 0o755 });
  assert.deepEqual((await runtime.start(prepared, f.context)).notes, ["tree_lock_unknown"]);
  assert.equal(lstatSync(leaf).mode & 0o7777, 0o755); assert.deepEqual(readdirSync(leaf), []);
  rmSync(leaf, { recursive: true });
  const target = join(f.root, "target"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, leaf);
  assert.deepEqual((await runtime.start(prepared, f.context)).notes, ["tree_lock_unknown"]);
  assert.deepEqual(readdirSync(target), []); assert(lstatSync(leaf).isSymbolicLink());
  rmSync(root, { recursive: true }); symlinkSync(target, root);
  assert.deepEqual((await runtime.start(prepared, f.context)).notes, ["tree_lock_unknown"]);
  assert.deepEqual(readdirSync(target), []);
});

test("existing private tree root/leaf must belong to the current uid", async t => {
  const f = fixture(t), runtime = f.runtime(), prepared = runtime.prepare({ tree: "tree" }, f.context);
  const root = join(f.agentDir, "harness-trees"), leaf = join(root, sha(join(f.cwd, "tree")));
  const original = fsp.lstat;
  for (const unowned of [root, leaf]) {
    fsp.lstat = async (...args) => {
      const entry = await original(...args);
      if (args[0] !== unowned) return entry;
      const changed = Object.create(entry); changed.uid = process.getuid() + 1;
      return changed;
    };
    syncBuiltinESMExports();
    try {
      const observation = await runtime.start(prepared, f.context);
      assert.deepEqual(observation.notes, ["tree_lock_unknown"]); assert.equal(observation.lease, undefined);
    } finally { fsp.lstat = original; syncBuiltinESMExports(); }
    assert(!existsSync(join(leaf, "owner.lock")));
  }
});

test("flock handshake/platform failures are observations, not rejected tasks or false contention", async t => {
  const f = fixture(t), broken = join(f.root, "no-op-flock");
  writeFileSync(broken, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  for (const path of [broken, join(f.root, "missing-flock"), "flock"]) {
    const runtime = f.runtime({ flock: path });
    const observed = await runtime.start(runtime.prepare({ tree: "tree" }, f.context), f.context);
    assert.deepEqual(observed.notes, ["tree_lock_unknown"]); assert.equal(observed.lease, undefined);
  }
});

test("constructor close fault returns a sticky cleanup tombstone, never absent/held cleanup evidence", async t => {
  const f = fixture(t), broken = join(f.root, "no-op-flock");
  writeFileSync(broken, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  const runtime = f.runtime({ flock: broken }), prepared = runtime.prepare({ tree: "tree" }, f.context);
  const original = fs.closeSync, fault = new Error("synthetic close failure");
  let calls = 0;
  fs.closeSync = fd => {
    calls++;
    original(fd); // Close the actual fixture fd; only its exit evidence is faulted.
    throw fault;
  };
  syncBuiltinESMExports();
  try {
    const observation = await runtime.start(prepared, f.context);
    assert.deepEqual(observation.notes, ["tree_lock_unknown"]); assert(observation.lease);
    let sticky;
    assert.throws(() => observation.lease.assertHeld(), failure => {
      assert.equal(failure.message, "LOCK_CLEANUP_UNCERTAIN"); assert.equal(failure.cause, fault);
      sticky = failure; return true;
    });
    for (let i = 0; i < 2; i++) {
      assert.throws(() => observation.lease.close(), failure => failure === sticky);
      assert.throws(() => observation.lease.assertHeld(), failure => failure === sticky);
    }
    assert.equal(calls, 1, "tombstone must never retry the uncertain fd");
  } finally { fs.closeSync = original; syncBuiltinESMExports(); }
});

test("post-acquisition inspection failure hands off the live lease without runtime close", async t => {
  const f = fixture(t), runtime = f.runtime(), prepared = runtime.prepare({ tree: "tree" }, f.context);
  const root = join(f.agentDir, "harness-trees"), originalStat = fsp.lstat, originalClose = FileLeaseLock.prototype.close;
  let rootChecks = 0, closeCalls = 0, observation;
  fsp.lstat = async (...args) => {
    if (args[0] === root && ++rootChecks === 3) throw new Error("synthetic post-acquisition inspection fault");
    return originalStat(...args);
  };
  FileLeaseLock.prototype.close = function () { closeCalls++; return originalClose.call(this); };
  syncBuiltinESMExports();
  try {
    observation = await runtime.start(prepared, f.context);
    assert.deepEqual(observation.notes, ["tree_lock_unknown"]); assert(observation.lease);
    assert.equal(closeCalls, 0, "core must be the only release caller after acquisition");
    observation.lease.assertHeld(); observation.lease.close();
    assert.equal(closeCalls, 1);
  } finally {
    fsp.lstat = originalStat; syncBuiltinESMExports();
    if (observation?.lease) originalClose.call(observation.lease);
    FileLeaseLock.prototype.close = originalClose;
  }
});

// Synthetic trusted executables exercise the probe contract without repositories,
// network, credentials, or accidental PATH fallback. Only selected synthetic env
// names/flags are recorded, never the ambient environment or credential values.
function fakeGit(f, settings = {}) {
  mkdirSync(join(f.cwd, ".git"));
  const log = join(f.root, "git-log.jsonl"), config = join(f.root, "git-settings.json"), git = join(f.root, "trusted-git");
  writeFileSync(config, JSON.stringify({ guard: "", head, status: "", ...settings }));
  writeFileSync(git, `#!${process.execPath}
const fs = require('node:fs');
const log = ${JSON.stringify(log)}, s = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(),
  names: Object.keys(process.env).filter(k => /^(GIT_|LD_|DYLD_|_RLD|LDR_|BASH_FUNC_)/i.test(k) || ['LIBPATH','SHLIB_PATH','GCONV_PATH','GLIBC_TUNABLES','NODE_OPTIONS','NODE_PATH'].includes(k)).sort(),
  path: process.env.PATH, optional: process.env.GIT_OPTIONAL_LOCKS, lazy: process.env.GIT_NO_LAZY_FETCH,
  replace: process.env.GIT_NO_REPLACE_OBJECTS, terminal: process.env.GIT_TERMINAL_PROMPT }) + '\\n');
const stage = args.includes('config') ? 'config' : args.includes('status') ? 'status' : args.includes('--verify') ? 'head' : 'layout';
if (s.delay === stage) { setInterval(() => {}, 1000); }
else if (s.overflow === stage) { process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 120)); }
else if (s.fail === stage) { process.stderr.write('synthetic probe failure'); process.exit(2); }
else if (stage === 'config') { process.stdout.write(s.guard); process.exit(s.guard ? 0 : 1); }
else if (stage === 'layout') { process.stdout.write(s.layout ?? ${JSON.stringify(`${f.cwd}\n${join(f.cwd, ".git")}\n${join(f.cwd, ".git")}\ntrue\nfalse\n`)}); }
else if (stage === 'head') { process.stdout.write(s.head + '\\n'); }
else { process.stdout.write(Buffer.from(s.status, 'base64')); }
`, { mode: 0o700 });
  return { git, log, config, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}
async function capture(f, git) {
  const runtime = f.runtime({ git });
  return runtime.start(runtime.prepare({ checks: ["focused"] }, f.context), f.context);
}

test("only checks captures; trusted absolute Git, raw guard first, exact superproject status and digest", async t => {
  const f = fixture(t), status = Buffer.from(" M private-name\0"), fake = fakeGit(f, { status: status.toString("base64") });
  const runtime = f.runtime({ git: fake.git });
  assert.deepEqual(await runtime.start(runtime.prepare({ ownership: ["new"] }, f.context), f.context), {});
  assert.deepEqual(fake.calls(), []);
  const result = await capture(f, fake.git), source = result.source_state;
  assert.deepEqual({ ...source, observed_at: 0 }, { state: "observed", scope: "superproject_only", submodules: "ignored", head,
    dirty: true, status_digest: sha(status), observed_at: 0 });
  assert(Number.isSafeInteger(source.observed_at));
  assert(!JSON.stringify(result).includes("private-name"));
  const calls = fake.calls(); assert.equal(calls.length, 4);
  for (const call of calls) { assert.deepEqual(call.args.slice(0, flags.length), flags); assert.equal(call.cwd, f.cwd); }
  assert(!calls[0].args.includes("-c"), "raw config guard must not see our fsmonitor override");
  assert(calls[0].args.includes("--name-only")); assert(calls[0].args.includes("--null"));
  assert.deepEqual(calls[3].args.slice(flags.length), ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=normal"]);
});

test("Git redirection, config injection, exec-path, trace and dynamic loaders are isolated; no project PATH", async t => {
  const f = fixture(t), fake = fakeGit(f), marker = join(f.root, "trace-write"), evilDir = join(f.root, "evil-bin"); mkdirSync(evilDir);
  writeFileSync(join(evilDir, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(f.root, "path-executed"))}, 'bad');\n`, { mode: 0o700 });
  const hostile = { PATH: evilDir, GIT_DIR: join(f.root, "other"), GIT_WORK_TREE: f.root, GIT_INDEX_FILE: join(f.root, "index"),
    GIT_COMMON_DIR: f.root, GIT_OBJECT_DIRECTORY: f.root, GIT_ALTERNATE_OBJECT_DIRECTORIES: f.root,
    GIT_CONFIG_SYSTEM: join(f.root, "system"), GIT_CONFIG_GLOBAL: join(f.root, "global"), GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "evil", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
    GIT_EXEC_PATH: evilDir, GIT_TRACE: marker, GIT_TRACE2_EVENT: marker, GIT_TRACE2_PERF: marker,
    LD_PRELOAD: join(f.root, "missing.so"), LD_LIBRARY_PATH: evilDir, LD_AUDIT: join(f.root, "missing-audit.so"),
    DYLD_INSERT_LIBRARIES: join(f.root, "missing.dylib"), LIBPATH: evilDir, SHLIB_PATH: evilDir,
    GCONV_PATH: evilDir, GLIBC_TUNABLES: "bad", NODE_OPTIONS: "--require=not-a-module", NODE_PATH: evilDir,
    BASH_ENV: join(f.root, "bash-env"), ENV: join(f.root, "bash-env"), CDPATH: evilDir, SHELLOPTS: "xtrace", BASHOPTS: "extdebug" };
  await withEnvironment(hostile, async () => {
    const observed = await capture(f, fake.git); assert.equal(observed.source_state.state, "observed");
    assert.equal(observed.source_state.dirty, false); assert.equal(observed.source_state.status_digest, sha(Buffer.alloc(0)));
    const expected = ["GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
      "GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"].sort();
    for (const call of fake.calls()) {
      assert.deepEqual(call.names, expected); assert.equal(call.path, "/dev/null");
      assert.equal(call.optional, "0"); assert.equal(call.lazy, "1"); assert.equal(call.replace, "1"); assert.equal(call.terminal, "0");
    }
    for (const missing of [undefined, "git", join(f.root, "missing-git")]) assert.equal((await capture(f, missing)).source_state.state, "unknown");
  });
  assert(!existsSync(marker)); assert(!existsSync(join(f.root, "path-executed")));
});

test("trusted shell Git wrappers cannot execute inherited BASH_ENV", async t => {
  const f = fixture(t), fake = fakeGit(f), marker = join(f.root, "bash-env-ran"), init = join(f.root, "bash-env"), wrapper = join(f.root, "git-wrapper");
  writeFileSync(init, `printf bad > ${JSON.stringify(marker)}\n`);
  writeFileSync(wrapper, `#!${bash}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake.git)} "$@"\n`, { mode: 0o700 });
  await withEnvironment({ BASH_ENV: init, ENV: init }, async () => {
    assert.equal((await capture(f, wrapper)).source_state.state, "observed");
  });
  assert(!existsSync(marker));
});

test("trusted shell Git wrapper's bare helper cannot use exported functions or project cwd", async t => {
  const f = fixture(t), fake = fakeGit(f), name = "harness_canary", wrapper = join(f.root, "git-wrapper");
  const functionMarker = join(f.root, "exported-function-ran"), helperMarker = join(f.root, "cwd-helper-ran");
  writeFileSync(join(f.cwd, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(helperMarker)}, 'bad');\n`, { mode: 0o700 });
  writeFileSync(wrapper, `#!${bash}\n${name} 2>/dev/null || :\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake.git)} "$@"\n`, { mode: 0o700 });
  await withEnvironment({ PATH: f.cwd, [`BASH_FUNC_${name}%%`]: `() { printf bad > ${JSON.stringify(functionMarker)}; }` }, async () => {
    assert.equal((await capture(f, wrapper)).source_state.state, "observed");
  });
  assert(!existsSync(functionMarker), "exported Bash function executed");
  assert(!existsSync(helperMarker), "empty/current-directory PATH executed a project helper");
  for (const call of fake.calls()) {
    assert.equal(call.path, "/dev/null"); assert(!call.names.some(key => key.startsWith("BASH_FUNC_")));
  }
});

test("raw helper/partial keys, failures, unsupported layouts and unborn HEAD never become clean observations", async t => {
  const f = fixture(t), fake = fakeGit(f);
  for (const key of ["core.fsmonitor", "filter.canary.clean", "filter.canary.process", "extensions.partialclone", "remote.origin.promisor", "remote.origin.partialclonefilter"]) {
    writeFileSync(fake.config, JSON.stringify({ guard: `${key}\0`, head, status: "" }));
    const before = fake.calls().length, observed = await capture(f, fake.git);
    assert.equal(observed.source_state.state, "unknown"); assert.equal(fake.calls().length - before, 1, "guard must prevent later status probes");
  }
  for (const settings of [{ fail: "config" }, { fail: "head" }, { fail: "status" }, { layout: "unexpected\n" }, { head: "HEAD" },
    { status: Buffer.from(" M truncated").toString("base64") }, { overflow: "status" }, { delay: "status" }]) {
    writeFileSync(fake.config, JSON.stringify({ guard: "", head, status: "", ...settings }));
    const observed = await capture(f, fake.git);
    assert.equal(observed.source_state.state, "unknown", JSON.stringify(settings));
    assert.equal(observed.source_state.dirty, undefined); assert.equal(observed.source_state.status_digest, undefined);
  }
  rmSync(join(f.cwd, ".git"), { recursive: true });
  assert.equal((await capture(f, fake.git)).source_state.state, "unknown");
});

// Real Git canaries mutate ONLY disposable synthetic repositories. They are
// written here for the single validation owner to run after the source freeze.
// No provider/network/approval or checkout/user-config mutation is involved.
const trustedGit = resolveGit(process.env);
function fixtureGitEnvironment(home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, PATH: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (/^(?:GIT_|LD_|DYLD_|_RLD|LDR_|BASH_FUNC_)/i.test(key) || /^(?:NODE_OPTIONS|NODE_PATH|LIBPATH|SHLIB_PATH|GCONV_PATH|GLIBC_TUNABLES|BASH_ENV|ENV|CDPATH|SHELLOPTS|BASHOPTS)$/.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}
function realGitFixture(t) {
  if (!trustedGit) { t.skip("No trusted absolute Git; synthetic probe tests still run"); return undefined; }
  const f = fixture(t), env = fixtureGitEnvironment(f.home);
  const supported = spawnSync(trustedGit, [...flags, "--version"], { env, encoding: "utf8", timeout: 2000 });
  if (supported.status !== 0) { t.skip("Trusted Git does not support required no-lazy-fetch flags; capture stays unknown"); return undefined; }
  const git = (cwd, args) => {
    assert(isAbsolute(cwd) && (cwd === f.cwd || cwd.startsWith(f.cwd + "/")), "mutation must remain in synthetic repository");
    const result = spawnSync(trustedGit, [...flags, ...args], { cwd, env, encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const init = cwd => git(cwd, ["init", "-q", "--initial-branch=main"]);
  const commit = cwd => {
    git(cwd, ["add", "--all"]);
    git(cwd, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic"]);
  };
  return { ...f, git, init, commit };
}

for (const configured of ["no", "all"]) {
  test(`source capture fixes normal untracked reporting despite status.showUntrackedFiles=${configured}`, async t => {
    const f = realGitFixture(t); if (!f) return;
    f.init(f.cwd); writeFileSync(join(f.cwd, "tracked"), "before\n"); f.commit(f.cwd);
    const untracked = join(f.cwd, "untracked"); mkdirSync(untracked);
    writeFileSync(join(untracked, "first"), "first\n"); writeFileSync(join(untracked, "second"), "second\n");
    f.git(f.cwd, ["config", "status.showUntrackedFiles", configured]);
    // Establish that the isolated fixture's config would otherwise hide all
    // untracked changes or enumerate contents instead of the normal directory.
    const baseline = f.git(f.cwd, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--ignore-submodules=all"]);
    assert.equal(baseline, configured === "no" ? "" : "?? untracked/first\0?? untracked/second\0");
    await withEnvironment({ HOME: f.home, XDG_CONFIG_HOME: f.home }, async () => {
      const observed = (await capture(f, trustedGit)).source_state;
      assert.equal(observed.state, "observed"); assert.equal(observed.dirty, true);
      assert.equal(observed.scope, "superproject_only"); assert.equal(observed.submodules, "ignored");
      assert.equal(observed.status_digest, sha(Buffer.from("?? untracked/\0")));
    });
  });
}

for (const kind of ["clean", "process", "fsmonitor"]) {
  test(`superproject-only capture never executes checked-out submodule ${kind}/fsmonitor canaries`, async t => {
    const f = realGitFixture(t); if (!f) return;
    f.init(f.cwd);
    const sub = join(f.cwd, "sub"); mkdirSync(sub); f.init(sub);
    writeFileSync(join(sub, "file"), "before\n"); f.commit(sub);
    writeFileSync(join(f.cwd, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    f.commit(f.cwd);
    const parentHead = f.git(f.cwd, ["rev-parse", "HEAD"]).trim();
    const filterMarker = join(f.root, "filter-ran"), monitorMarker = join(f.root, "fsmonitor-ran");
    const helper = join(f.root, "filter-helper"), monitor = join(f.root, "monitor-helper");
    writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(filterMarker)}, 'bad');\n${kind === "process" ? "process.exit(1);" : "process.stdin.pipe(process.stdout);"}\n`, { mode: 0o700 });
    writeFileSync(monitor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(monitorMarker)}, 'bad');\nprocess.stdout.write('token\\0');\n`, { mode: 0o700 });
    f.git(sub, ["config", "core.fsmonitor", monitor]);
    if (kind !== "fsmonitor") f.git(sub, ["config", `filter.canary.${kind}`, helper]);
    writeFileSync(join(sub, ".gitattributes"), "file filter=canary\n"); writeFileSync(join(sub, "file"), "after\n");
    await withEnvironment({ HOME: f.home, XDG_CONFIG_HOME: f.home }, async () => {
      const observed = (await capture(f, trustedGit)).source_state;
      assert.equal(observed.state, "observed"); assert.equal(observed.head, parentHead);
      assert.equal(observed.scope, "superproject_only"); assert.equal(observed.submodules, "ignored");
      assert.equal(observed.dirty, false); assert.equal(observed.status_digest, sha(Buffer.alloc(0)));
    });
    assert(!existsSync(filterMarker), "submodule filter executed"); assert(!existsSync(monitorMarker), "submodule fsmonitor executed");
  });
}

test("system/global Trace2 targets do not write during trusted source probes", async t => {
  const f = realGitFixture(t); if (!f) return;
  f.init(f.cwd); writeFileSync(join(f.cwd, "file"), "before\n"); f.commit(f.cwd);
  const marker = join(f.root, "trace2-write");
  writeFileSync(join(f.home, ".gitconfig"), `[trace2]\n\tnormalTarget = ${marker}\n\teventTarget = ${marker}\n\tperfTarget = ${marker}\n`);
  await withEnvironment({ HOME: f.home, XDG_CONFIG_HOME: f.home }, async () => {
    assert.equal((await capture(f, trustedGit)).source_state.state, "observed");
  });
  assert(!existsSync(marker));
});

test("conventional root raw guard does not detect its own override; configured root helper stays unknown without execution", async t => {
  const f = realGitFixture(t); if (!f) return;
  f.init(f.cwd); writeFileSync(join(f.cwd, "file"), "before\n"); f.commit(f.cwd);
  const marker = join(f.root, "root-helper-ran"), helper = join(f.root, "root-helper");
  writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`, { mode: 0o700 });
  await withEnvironment({ HOME: f.home, XDG_CONFIG_HOME: f.home }, async () => {
    assert.equal((await capture(f, trustedGit)).source_state.state, "observed");
    f.git(f.cwd, ["config", "core.fsmonitor", helper]);
    assert.deepEqual((await capture(f, trustedGit)).source_state, { state: "unknown", reason: "git_helper_config" });
  });
  assert(!existsSync(marker));
});
