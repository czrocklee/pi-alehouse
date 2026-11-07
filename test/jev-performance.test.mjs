import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";

// Stable dispatchers precede Jiti: fault injection must reach captured imports.
const originalFs = Object.fromEntries(
  ["readSync", "writeSync", "renameSync", "lstatSync", "mkdirSync", "closeSync"].map((name) => [
    name,
    fs[name],
  ]),
);
const activeFsReplacements = new Map();
for (const [name, original] of Object.entries(originalFs))
  fs[name] = (...args) => {
    const active = activeFsReplacements.get(name);
    if (!active) return Reflect.apply(original, fs, args);
    active.calls++;
    return Reflect.apply(active.replacement, fs, args);
  };
syncBuiltinESMExports();
after(() => {
  try {
    assert.equal(activeFsReplacements.size, 0);
  } finally {
    Object.assign(fs, originalFs);
    syncBuiltinESMExports();
  }
});
function patch(name, replacement, run, expectedCalls = 1) {
  const previous = activeFsReplacements.get(name),
    active = { replacement, calls: 0 };
  activeFsReplacements.set(name, active);
  try {
    run();
  } finally {
    if (previous) activeFsReplacements.set(name, previous);
    else activeFsReplacements.delete(name);
    if (expectedCalls === null)
      assert(active.calls > 0, `${name}: injection must actually be observed`);
    else assert.equal(active.calls, expectedCalls, `${name}: injection must actually be observed`);
  }
}

// Source-only synthetic fixtures: no build, credentials, network or real model.
const scratch = fs.mkdtempSync(join(tmpdir(), "jev-performance-"));
for (const name of ["home", "config", "state", "cache"])
  fs.mkdirSync(join(scratch, name), { mode: 0o700 });
Object.assign(process.env, {
  HOME: join(scratch, "home"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_STATE_HOME: join(scratch, "state"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
});
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
delete process.env.PI_JEV_API_KEY_FILE;
delete globalThis[Symbol.for("@rocklee/jev-auto-approval:api-key-file")];
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const flock = fs.realpathSync(
  ["/usr/bin/flock", "/bin/flock", "/run/current-system/sw/bin/flock"].find((path) =>
    fs.existsSync(path),
  ),
);
process.env.PI_HARNESS_FLOCK = flock;
globalThis.fetch = async () => {
  throw new Error("Network disabled in synthetic Jev regressions");
};
const sourcePath = fileURLToPath(new URL("../extensions/jev-auto-approval.ts", import.meta.url));
const auditPath = fileURLToPath(new URL("../extensions/lib/jev-audit-log.ts", import.meta.url));
const recoveryPath = fileURLToPath(new URL("../scripts/recover-jev-audit.mjs", import.meta.url));
const jiti = createJiti(import.meta.url);
const { buildAction, recentToolCallFacts } = await jiti.import(sourcePath);
const { appendJevAudit, appendJevAuditDetailed: append } = await jiti.import(auditPath);
const assistant = (...content) => ({ type: "message", message: { role: "assistant", content } });
const call = (id, name = "bash", arguments_ = { command: "git status" }) => ({
  type: "toolCall",
  id,
  name,
  arguments: arguments_,
});
const details = (toolCallId) => ({
  source: "tool_call",
  toolCallId,
  payload: {
    kind: "bash",
    evidence: [],
    request: { surface: "bash", toolName: "bash", invokedToolName: "bash", value: "git status" },
  },
});
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
function legacyCalls(branch) {
  const calls = [];
  for (const entry of branch) {
    if (record(entry)?.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (record(block)?.type !== "toolCall" || typeof block.name !== "string") continue;
      calls.push({
        id: typeof block.id === "string" ? block.id : null,
        name: block.name,
        arguments: record(block.arguments) ?? {},
      });
    }
  }
  return calls;
}

test("bounded reverse scans preserve duplicate IDs, ordering and malformed-call semantics", () => {
  const branch = [
    null,
    [],
    { type: "message", message: { role: "user", content: [call("user")] } },
    assistant(call("dup", "bash", { old: true }), null, call(null)),
    assistant(call("one"), { type: "toolCall", id: "dup", name: 1 }, call(123, "bash", [])),
    assistant(
      call("dup", "bash", null),
      { type: "text", text: "not a call" },
      call("two"),
      call("three"),
    ),
    assistant(call("dup", "bash", { newest: true }), call("four")),
    { type: "message", message: { role: "assistant", content: "malformed" } },
  ];
  for (const id of [undefined, "dup", "one", "absent", "", "four"]) {
    const expected = legacyCalls(branch);
    assert.deepEqual(
      recentToolCallFacts(branch, id),
      expected
        .filter((c) => c.id !== id)
        .slice(-4)
        .map(({ name, arguments: arguments_ }) => ({ name, arguments: arguments_ })),
    );
    const action = buildAction(details(id), branch),
      last = id ? expected.findLast((c) => c.id === id) : undefined;
    if (last) {
      assert.equal(action.ok, true);
      assert.deepEqual(action.currentToolCall, last);
    } else assert.deepEqual(action, { ok: false, failureCode: "context_incomplete" });
  }
  assert.deepEqual(
    buildAction(details("bad"), [assistant(call("bad", "bash", []))]).currentToolCall.arguments,
    {},
  );
  assert.deepEqual(
    buildAction(details("dup"), [assistant(call("dup")), assistant(call("dup", "write"))]),
    { ok: false, failureCode: "context_incomplete" },
  );
  let historicalReads = 0,
    tailReads = 0;
  const historical = {
    get type() {
      historicalReads++;
      return "message";
    },
    message: { role: "assistant", content: [call("history")] },
  };
  const tail = new Proxy(assistant(call("a"), call("b"), call("c"), call("d"), call("current")), {
    get(target, key, receiver) {
      if (key === "type") tailReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const long = [...Array(20_000).fill(historical), tail];
  assert.equal(buildAction(details("current"), long).ok, true);
  assert.equal(recentToolCallFacts(long, "current").length, 4);
  assert.equal(historicalReads, 0);
  assert.equal(tailReads, 2);
});

test("action canonicalization happens once and packet/baseline work stays outside freshness validation", () => {
  let reads = 0;
  const args = {
    get command() {
      reads++;
      return "git status";
    },
  };
  assert.equal(buildAction(details("once"), [assistant(call("once", "bash", args))]).ok, true);
  assert.equal(reads, 1);
  const source = fs.readFileSync(sourcePath, "utf8"),
    ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const calls = [],
    declarations = new Map();
  const walk = (node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      declarations.set(node.name.text, node);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  const namedCall = (name, argument) =>
    calls.filter(
      (node) =>
        node.expression.getText(ast) === name && node.arguments[0]?.getText(ast) === argument,
    );
  assert.equal(namedCall("canonicalJson", "packet").length, 1);
  assert.equal(namedCall("digest", "packet").length, 0);
  assert.equal(namedCall("textDigest", "serializedPacket").length, 1);
  const current = declarations.get("reviewIsCurrent"),
    baseline = declarations.get("baseline");
  assert(baseline.pos < declarations.get("reviewPromise").pos);
  for (const value of [
    "deterministicPolicy",
    "userContext",
    "projectInstructionExcerpts",
    "invokedScript",
  ]) {
    const matches = namedCall("digest", value);
    assert.equal(matches.length, 1);
    assert(matches[0].pos < current.pos);
  }
  const validation = current.getText(ast);
  for (const seam of [
    "query.checkPermission(",
    "buildAction(",
    "buildUserContext(",
    "delegationBindingFailure(",
    "boundedProfileIsValid(",
    "delegationReviewDigest(",
    "buildProjectRestrictions(",
    "invokedScriptFact(",
  ])
    assert(validation.includes(seam));
  assert(!/getLeafId|getEntryCount/.test(validation));
});

function fixture(name) {
  const directory = join(scratch, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "jev-auto-approval.jsonl");
  return {
    directory,
    path,
    lock: join(directory, ".jev-auto-approval.jsonl.lock"),
    archives: `${path}.archives`,
  };
}
const history = (f) =>
  fs.existsSync(f.archives)
    ? fs.readdirSync(f.archives).flatMap((name) => {
        const path = join(f.archives, name, "audit.jsonl");
        return fs.existsSync(path) ? [path] : [];
      })
    : [];
const reason = (value, expected) => assert.deepEqual(value, { ok: false, reason: expected });
const recover = (f, args = [], script = recoveryPath) =>
  spawnSync(process.execPath, [script, "--log", f.path, "--flock", flock, ...args], {
    env: { ...process.env, HOME: scratch, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });

test("audit preserves shared 0750 parent, private files, persistent lock identity and all rotated bytes", () => {
  const f = fixture("rotation"),
    old = Buffer.from('{"legacy":true}\nnot-rewritten\n');
  fs.chmodSync(f.directory, 0o750);
  fs.writeFileSync(f.path, old, { mode: 0o644 });
  assert.equal(appendJevAudit(f.path, { first: "x".repeat(90) }, 128), true);
  const lock = fs.statSync(f.lock),
    originalArchive = history(f)[0];
  assert.deepEqual(fs.readFileSync(originalArchive), old);
  for (let i = 0; i < 5; i++) assert(appendJevAudit(f.path, { i, data: "y".repeat(90) }, 128));
  assert.equal(history(f).length, 6);
  assert.deepEqual(fs.readFileSync(originalArchive), old);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o750);
  assert.equal(fs.statSync(f.archives).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.lock).ino, lock.ino);
  assert.equal(fs.statSync(f.lock).nlink, 1);
  for (const path of [f.path, f.lock, ...history(f)])
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert(fs.statSync(f.path).size <= 128);
  assert.throws(
    () => fs.mkdirSync(f.lock),
    { code: "EEXIST" },
    "this change's intermediate mkdir protocol cannot enter alongside the new writer; original unlocked HEAD cannot coexist",
  );
  const bytes = fs.readFileSync(f.path);
  reason(append(f.path, { huge: "z".repeat(200) }, { maxBytes: 128 }), "invalid_input");
  assert.deepEqual(fs.readFileSync(f.path), bytes);
});

test("legacy locks, unsafe parent/active/lock paths and fake flock fail closed with specific reasons", () => {
  const legacy = fixture("legacy");
  fs.mkdirSync(legacy.lock, { mode: 0o700 });
  reason(append(legacy.path, {}), "legacy_lock_requires_offline_recovery");
  assert(fs.statSync(legacy.lock).isDirectory());
  const unsafe = fixture("unsafe");
  fs.chmodSync(unsafe.directory, 0o770);
  reason(append(unsafe.path, {}), "unsafe_directory");
  assert.equal(fs.statSync(unsafe.directory).mode & 0o777, 0o770);
  const nested = join(unsafe.directory, "private");
  fs.mkdirSync(nested, { mode: 0o700 });
  reason(append(join(nested, "audit.jsonl"), {}), "unsafe_directory");
  const f = fixture("noop"),
    noop = join(scratch, "noop-flock");
  fs.writeFileSync(noop, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  reason(append(f.path, {}, { flock: noop }), "lock_not_confirmed");
  assert(!fs.existsSync(f.path));
  for (const kind of ["symlink", "hardlink"]) {
    const target = fixture(`unsafe-${kind}`),
      victim = join(target.directory, "victim");
    fs.writeFileSync(victim, "untouched", { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(victim, target.path);
    else fs.linkSync(victim, target.path);
    assert.equal(append(target.path, {}).ok, false);
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  }
});

test("foreign directory owners including overflow UID are refused without touching history, locks or directories", () => {
  const current = process.getuid(),
    foreign = current === 12345 ? 12346 : 12345;
  // 65534 can also be the legitimate current UID; only inject foreign owners.
  for (const uid of [65534, foreign].filter((value) => value !== current)) {
    assert.notEqual(uid, current, "the injected owner must be foreign to this test process");
    const container = fixture(`owner-${uid}`),
      ancestor = join(container.directory, "ancestor"),
      logs = join(ancestor, "logs");
    fs.mkdirSync(logs, { recursive: true, mode: 0o750 });
    const f = {
      directory: logs,
      path: join(logs, "jev-auto-approval.jsonl"),
      lock: join(logs, ".jev-auto-approval.jsonl.lock"),
    };
    const bytes = Buffer.from('{"history":"unchanged"}\n');
    fs.writeFileSync(f.path, bytes, { mode: 0o600 });
    fs.writeFileSync(f.lock, "", { mode: 0o600 });
    const before = [ancestor, logs, f.path, f.lock].map((path) => {
      const info = originalFs.lstatSync(path);
      return [info.ino, info.uid, info.mode, info.nlink, info.size];
    });
    const names = fs.readdirSync(logs);
    let forged = 0,
      validations = 0;
    patch(
      "lstatSync",
      (path, ...args) => {
        const info = originalFs.lstatSync(path, ...args);
        if (String(path) !== ancestor) return info;
        forged++;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid });
      },
      () => {
        for (let attempt = 0; attempt < 2; attempt++)
          reason(
            append(
              f.path,
              {},
              {
                beforeWrite: () => {
                  validations++;
                  return true;
                },
              },
            ),
            "untrusted_directory_owner",
          );
      },
      null,
    );
    assert.equal(forged, 2, "each refusal must actually sample the foreign ancestor");
    assert.equal(validations, 0);
    assert.deepEqual(fs.readFileSync(f.path), bytes);
    assert.equal(fs.readFileSync(f.lock).length, 0);
    assert.deepEqual(fs.readdirSync(logs), names);
    assert.deepEqual(
      [ancestor, logs, f.path, f.lock].map((path) => {
        const info = originalFs.lstatSync(path);
        return [info.ino, info.uid, info.mode, info.nlink, info.size];
      }),
      before,
    );

    // Native ESM --import installs a live-binding dispatcher BEFORE the CLI.
    // The proof counter is outside the audited directory and must be nonzero.
    const proof = join(container.directory, "cli-hits.json"),
      preload = join(container.directory, "owner-preload.mjs");
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.lstatSync; let hits=0;
fs.lstatSync=(path,...args)=>{const info=original(path,...args);if(String(path)!==${JSON.stringify(ancestor)})return info;hits++;return Object.assign(Object.create(Object.getPrototypeOf(info)),info,{uid:${uid}});};
syncBuiltinESMExports(); process.on('exit',()=>fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({hits}),{mode:0o600}));\n`,
      { mode: 0o600 },
    );
    for (const args of [[], ["--apply", "--confirm-writers-stopped"]]) {
      const result = spawnSync(
        process.execPath,
        ["--import", preload, recoveryPath, "--log", f.path, ...args],
        {
          env: { ...process.env, HOME: join(scratch, "home") },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const error = JSON.parse(result.stderr);
      assert.equal(error.reason, "untrusted_directory_owner");
      assert.match(error.warning, /UID\/GID mappings/);
      assert.match(error.warning, /not a bad lockfile/);
      assert(
        JSON.parse(fs.readFileSync(proof, "utf8")).hits > 0,
        "CLI owner injection actually hit",
      );
      assert.deepEqual(fs.readdirSync(logs), names);
      assert.deepEqual(fs.readFileSync(f.path), bytes);
      assert.equal(fs.readFileSync(f.lock).length, 0);
    }
  }
});

test("directory type, root/current owner, sticky and writable-parent rules keep their original acceptance boundary", () => {
  const current = process.getuid(),
    foreign = current === 12345 ? 12346 : 12345;
  const cases = [
    { name: "current", uid: current, mode: 0o750, ok: true },
    { name: "root", uid: 0, mode: 0o750, ok: true },
    { name: "sticky-root-owned-child", uid: 0, mode: 0o1777, ok: true },
    { name: "current-group-writable", uid: current, mode: 0o770, reason: "unsafe_directory" },
    { name: "root-world-writable", uid: 0, mode: 0o777, reason: "unsafe_directory" },
    { name: "foreign-sticky", uid: foreign, mode: 0o1777, reason: "untrusted_directory_owner" },
    {
      name: "not-directory",
      uid: foreign,
      mode: 0o750,
      directory: false,
      reason: "unsafe_directory",
    },
    ...(current === 0
      ? []
      : [
          {
            name: "sticky-unowned-child",
            uid: 0,
            mode: 0o1777,
            childRoot: true,
            reason: "unsafe_directory",
          },
        ]),
  ];
  for (const item of cases) {
    const f = fixture(`owner-control-${item.name}`),
      ancestor = join(f.directory, "ancestor"),
      child = join(ancestor, "child"),
      logs = join(child, "logs");
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    let forged = 0;
    patch(
      "lstatSync",
      (path, ...args) => {
        const info = originalFs.lstatSync(path, ...args);
        if (String(path) === child && item.childRoot)
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: 0 });
        if (String(path) !== ancestor) return info;
        forged++;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          uid: item.uid,
          mode: (info.mode & ~0o7777) | item.mode,
          ...(item.directory === false ? { isDirectory: () => false } : {}),
        });
      },
      () => {
        const result = append(join(logs, "jev-auto-approval.jsonl"), {});
        if (item.ok) assert.equal(result.ok, true, item.name);
        else reason(result, item.reason);
      },
      null,
    );
    assert(forged > 0, `${item.name}: the control must actually hit its metadata injection`);
  }
  if (current !== 0) {
    const f = fixture("owner-control-root-leaf");
    let forged = 0;
    patch(
      "lstatSync",
      (path) => {
        const info = originalFs.lstatSync(path);
        if (String(path) !== f.directory) return info;
        forged++;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: 0 });
      },
      () => reason(append(f.path, {}), "unsafe_directory"),
      null,
    );
    assert(forged > 0, "root-owned leaf still must be owned by the current UID");
  }
});

test("audit beforeWrite validates after the lock and rejects false, throws and async validators without writing", async () => {
  const f = fixture("validate");
  for (const beforeWrite of [
    () => false,
    () => {
      throw new Error("stale");
    },
    () => Promise.reject(new Error("async")),
  ]) {
    reason(append(f.path, { rejected: true }, { beforeWrite }), "validation_failed");
    assert.equal(fs.readFileSync(f.path, "utf8"), "");
  }
  assert.equal(append(f.path, { valid: true }, { beforeWrite: () => true }).ok, true);
  const before = fs.readFileSync(f.path);
  reason(
    append(f.path, { payload: "x".repeat(44) }, { maxBytes: 64, beforeWrite: () => false }),
    "validation_failed",
  );
  assert.deepEqual(fs.readFileSync(f.path), before);
  assert.deepEqual(history(f), [], "false validation cannot rotate or add an allow line");
  await Promise.resolve();
});

test("partial writes, non-LF tails and tail-read errors never recover into unconfirmed allows", () => {
  for (const seeded of [false, true]) {
    const f = fixture(`partial-${seeded}`),
      before = seeded ? Buffer.from('{"seed":true}\n') : Buffer.alloc(0);
    if (seeded) fs.writeFileSync(f.path, before, { mode: 0o600 });
    const details = { partial: "incomplete" },
      line = Buffer.from(`${JSON.stringify(details)}\n`);
    let written = 0;
    patch(
      "writeSync",
      (fd, buffer, offset, length) => {
        if (written) throw new Error("after real partial write");
        return (written = originalFs.writeSync(fd, buffer, offset, Math.min(7, length)));
      },
      () => reason(append(f.path, details, { maxBytes: 64 }), "audit_io_failed"),
      2,
    );
    const damaged = Buffer.concat([before, line.subarray(0, 7)]);
    for (const maxBytes of [64, 16])
      reason(
        append(f.path, { retry: 1 }, { maxBytes }),
        "incomplete_tail_requires_offline_recovery",
      );
    assert.deepEqual(fs.readFileSync(f.path), damaged);
    assert.deepEqual(history(f), []);
    assert(fs.statSync(f.lock).isFile());
  }
  const f = fixture("read-failure");
  fs.writeFileSync(f.path, '{"seed":true}\n', { mode: 0o600 });
  patch(
    "readSync",
    () => 0,
    () => reason(append(f.path, {}), "incomplete_tail_requires_offline_recovery"),
  );
  patch(
    "readSync",
    () => {
      throw new Error("read failure");
    },
    () => reason(append(f.path, {}), "audit_io_failed"),
  );
  assert.equal(append(f.path, {}).ok, true);
});

test("symlink compatibility requires exact canonical file/root floor coverage and a fixed directory binding", () => {
  const f = fixture("canonical"),
    alias = join(scratch, "logs-link");
  fs.symlinkSync(f.directory, alias);
  const path = join(alias, basename(f.path)),
    expectedDirectory = f.directory;
  reason(append(path, {}), "symlink_target_unprotected");
  const options = {
    expectedDirectory,
    protectedWriteFiles: [f.path, f.lock],
    protectedWriteRoots: [f.archives],
  };
  reason(
    append(path, {}, { ...options, protectedWriteFiles: [f.path] }),
    "symlink_target_unprotected",
  );
  reason(append(path, {}, { ...options, protectedWriteRoots: [] }), "symlink_target_unprotected");
  assert.equal(append(path, { protected: true }, options).ok, true);
  const sibling = join(f.directory, "unrelated-extension.log");
  fs.writeFileSync(sibling, "still writable");
  const other = fixture("retarget");
  fs.unlinkSync(alias);
  fs.symlinkSync(other.directory, alias);
  reason(append(path, {}, options), "directory_changed");
  assert(!fs.existsSync(other.path));
  assert.equal(fs.readFileSync(sibling, "utf8"), "still writable");
});

async function childAt(t, f, stage = "locked") {
  const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {createJiti} from 'jiti';
const stage=${JSON.stringify(stage)};
const pause=()=>{process.send('paused'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,stage==='short-hold'?75:10000);};
if(stage==='before-rename'||stage==='after-rename'){const original=fs.renameSync;fs.renameSync=(...args)=>{if(stage==='before-rename')pause();const result=original(...args);if(stage==='after-rename')pause();return result;};syncBuiltinESMExports();}
if(stage==='after-create'){const original=fs.openSync;fs.openSync=(path,flags,...args)=>{const fd=original(path,flags,...args);if(String(path).endsWith('/jev-auto-approval.jsonl')&&(flags&fs.constants.O_EXCL))pause();return fd;};syncBuiltinESMExports();}
const {appendJevAuditDetailed:append}=await createJiti(import.meta.url).import(${JSON.stringify(auditPath)});
const result=append(${JSON.stringify(f.path)},{payload:'x'.repeat(44)},{flock:${JSON.stringify(flock)},maxBytes:64,...(['locked','short-hold'].includes(stage)?{beforeWrite:()=>{pause();return true;}}:{})});
console.log(JSON.stringify(result)); process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: scratch },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not reach ${stage}: ${stderr}`));
    }, 15000);
    child.once("message", (message) => {
      clearTimeout(timer);
      assert.equal(message, "paused");
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
  return { child, exited };
}

test(
  "kernel lock contention is bounded and process death releases the OFD without unlinking its inode",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture("kernel-crash"),
      { child, exited } = await childAt(t, f);
    const lock = fs.statSync(f.lock);
    let validations = 0;
    const before = Date.now();
    reason(
      append(
        f.path,
        {},
        {
          lockWaitMs: 25,
          beforeWrite: () => {
            validations++;
            return true;
          },
        },
      ),
      "lock_busy",
    );
    assert.equal(validations, 0);
    assert(Date.now() - before < 2000, "kernel wait is bounded; not a hard IO timing guarantee");
    const refused = recover(f, ["--apply", "--confirm-writers-stopped"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /writers_not_stopped_lock_busy/);
    child.kill("SIGKILL");
    await exited;
    assert.equal(append(f.path, { afterDeath: true }).ok, true);
    assert.equal(fs.statSync(f.lock).ino, lock.ino);
    assert.equal(fs.statSync(f.lock).nlink, 1);
  },
);

test(
  "a short kernel wait succeeds after the other process releases and validates only after that wait",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture("short-contention"),
      { exited } = await childAt(t, f, "short-hold");
    let validations = 0;
    assert.equal(
      append(
        f.path,
        { second: true },
        {
          lockWaitMs: 250,
          beforeWrite: () => {
            validations++;
            assert.match(fs.readFileSync(f.path, "utf8"), /payload/);
            return true;
          },
        },
      ).ok,
      true,
    );
    assert.equal(validations, 1);
    await exited;
    assert.equal(fs.readFileSync(f.path, "utf8").trim().split("\n").length, 2);
  },
);

for (const stage of ["before-rename", "after-rename", "after-create"])
  test(
    `archive crash ${stage} preserves bytes without a link/unlink double-link state`,
    { timeout: 30_000 },
    async (t) => {
      const f = fixture(`crash-${stage}`),
        old = Buffer.from('{"old":true}\n');
      fs.writeFileSync(f.path, old, { mode: 0o600 });
      const { child, exited } = await childAt(t, f, stage);
      child.kill("SIGKILL");
      await exited;
      const retained = [...history(f), ...(fs.existsSync(f.path) ? [f.path] : [])];
      assert(retained.some((path) => fs.readFileSync(path).equals(old)));
      for (const path of retained) assert.equal(fs.statSync(path).nlink, 1);
      assert.equal(append(f.path, { resumed: true }, { maxBytes: 64 }).ok, true);
    },
  );

test("offline recovery is dry-run by default, preserves dirty/hardlink evidence, and runs as installed ordinary ESM", () => {
  const installed = join(scratch, "node_modules/fake/scripts/recover-jev-audit.mjs");
  fs.mkdirSync(join(scratch, "node_modules/fake/scripts"), { recursive: true });
  fs.copyFileSync(recoveryPath, installed);
  for (const kind of ["legacy-lock", "dirty", "hardlinks"]) {
    const f = fixture(`recover-${kind}`),
      bytes = Buffer.from(kind === "dirty" ? '{"partial":' : '{"old":true}\n');
    fs.writeFileSync(f.path, bytes, { mode: 0o600 });
    if (kind === "legacy-lock") fs.mkdirSync(f.lock, { mode: 0o700 });
    let legacyArchive;
    if (kind === "hardlinks") {
      legacyArchive = `${f.path}.123.${randomUUID()}.archive`;
      fs.linkSync(f.path, legacyArchive);
    }
    const names = fs.readdirSync(f.directory),
      dry = recover(f, [], installed);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).mode, "dry-run");
    assert.deepEqual(fs.readdirSync(f.directory), names);
    assert.deepEqual(fs.readFileSync(f.path), bytes);
    assert.notEqual(recover(f, ["--apply"], installed).status, 0);
    const applied = recover(f, ["--apply", "--confirm-writers-stopped"], installed);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).auditGapRepaired, false);
    assert(fs.statSync(f.lock).isFile());
    if (kind !== "legacy-lock") {
      assert.equal(fs.statSync(f.path).size, 0);
      assert(history(f).some((path) => fs.readFileSync(path).equals(bytes)));
    } else assert.deepEqual(fs.readFileSync(f.path), bytes);
    if (legacyArchive) assert.deepEqual(fs.readFileSync(legacyArchive), bytes);
    assert.equal(append(f.path, { recovered: true }).ok, true);
  }
});

test("audit metadata/rename/close errors fail closed without orphaning a directory lock or overwriting history", () => {
  const f = fixture("metadata-error");
  let injected = false;
  patch(
    "lstatSync",
    (path) => {
      if (
        !injected &&
        String(path).endsWith("/.jev-auto-approval.jsonl.lock") &&
        fs.existsSync(path)
      ) {
        injected = true;
        throw new Error("metadata failure after regular lock creation");
      }
      return originalFs.lstatSync(path);
    },
    () => assert.equal(append(f.path, {}).ok, false),
    null,
  );
  assert(injected);
  assert(fs.statSync(f.lock).isFile());
  assert.equal(append(f.path, { seed: true }).ok, true);
  const before = fs.readFileSync(f.path);
  patch(
    "renameSync",
    () => {
      throw new Error("rename failed");
    },
    () =>
      reason(append(f.path, { payload: "x".repeat(44) }, { maxBytes: 64 }), "archive_unavailable"),
  );
  assert.deepEqual(fs.readFileSync(f.path), before);
  let closed = false;
  patch(
    "closeSync",
    (fd) => {
      const active = fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith("/jev-auto-approval.jsonl");
      originalFs.closeSync(fd);
      if (active && !closed) {
        closed = true;
        throw new Error("unconfirmed close");
      }
    },
    () => reason(append(f.path, { written: true }), "cleanup_failed"),
    null,
  );
  assert(closed);
  assert.equal(
    append(f.path, { next: true }).ok,
    true,
    "lock OFD closes even after another close reports failure",
  );
});

test("offline recovery rejects unrelated private filenames in dry-run and apply without changing bytes or names", () => {
  for (const name of ["auth.json", "models.json", "unrelated.json"]) {
    const f = fixture(`wrong-name-${name}`);
    f.path = join(f.directory, name);
    const bytes = Buffer.from('{"private":"must not become an empty audit file"}');
    fs.writeFileSync(f.path, bytes, { mode: 0o600 });
    const names = fs.readdirSync(f.directory);
    for (const args of [[], ["--apply", "--confirm-writers-stopped"]]) {
      const result = recover(f, args);
      assert.notEqual(result.status, 0);
      const error = JSON.parse(result.stderr);
      assert.equal(error.reason, "jev_audit_basename_required");
      assert.equal(error.atomicRecovery, false);
      assert.deepEqual(fs.readdirSync(f.directory), names);
      assert.deepEqual(fs.readFileSync(f.path), bytes);
      assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
    }
  }
});

test("offline recovery refuses unrecognized artifacts without deleting or changing them", () => {
  for (const kind of ["symlink", "nonempty-lock", "unknown-hardlinks", "writable-parent"]) {
    const f = fixture(`refuse-${kind}`),
      victim = join(f.directory, "victim");
    fs.writeFileSync(victim, "untouched", { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(victim, f.path);
    if (kind === "nonempty-lock") {
      fs.mkdirSync(f.lock, { mode: 0o700 });
      fs.writeFileSync(join(f.lock, "unknown"), "keep");
    }
    if (kind === "unknown-hardlinks") fs.linkSync(victim, f.path);
    if (kind === "writable-parent") fs.chmodSync(f.directory, 0o770);
    const names = fs.readdirSync(f.directory);
    const result = recover(f, ["--apply", "--confirm-writers-stopped"]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(f.directory), names);
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  }
});

test("legacy nlink2 is never treated as kernel-lock recovery or silently accepted by the writer", () => {
  const f = fixture("nlink2");
  fs.writeFileSync(f.path, '{"old":true}\n', { mode: 0o600 });
  fs.linkSync(f.path, `${f.path}.123.${randomUUID()}.archive`);
  reason(append(f.path, {}), "legacy_hardlinks_require_offline_recovery");
  assert(fs.statSync(f.lock).isFile());
  assert.equal(fs.statSync(f.path).nlink, 2);
});
