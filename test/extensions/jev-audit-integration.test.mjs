// Source-only caller/helper integration: synthetic provider + private files,
// verified local flock, no generated runtime, credentials, network or human UI.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { resolveFlock } from "../../bin/runtime-support.mjs";

const originalIo = {
  spawnSync: childProcess.spawnSync,
  writeSync: fs.writeSync,
  closeSync: fs.closeSync,
  lstatSync: fs.lstatSync,
};
const activeIo = new Map();
for (const [name, original] of Object.entries(originalIo)) {
  const module = name === "spawnSync" ? childProcess : fs;
  module[name] = (...args) => {
    const tap = activeIo.get(name);
    if (!tap) return Reflect.apply(original, module, args);
    tap.calls++;
    return Reflect.apply(tap.handler, module, args);
  };
}
syncBuiltinESMExports();
const root = fs.mkdtempSync(join(tmpdir(), "jev-audit-integration-"));
for (const name of ["home", "config", "state", "cache"])
  fs.mkdirSync(join(root, name), { mode: 0o700 });
Object.assign(process.env, {
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
});
process.env.PI_ALEHOUSE_FLOCK = resolveFlock();
const key = join(root, "synthetic-key");
fs.writeFileSync(key, "offline-test-key-not-a-credential\n", { mode: 0o600 });
const floorKey = Symbol.for("pi-alehouse:managed-resource-protection:v1");
assert.equal(
  globalThis[floorKey],
  undefined,
  "isolated test process must not replace a real immutable floor",
);
const answers = {
  task_scope: { type: "noul", noul: 0.95 },
  read_only: { type: "noul", noul: 0.95 },
  reversible: { type: "noul", noul: 0.95 },
  remote_mutation: { type: "noul", noul: 0.01 },
  credential_exposure: { type: "noul", noul: 0.01 },
  injection: { type: "noul", noul: 0.01 },
  constraint_conflict: { type: "noul", noul: 0.01 },
  policy_evasion: { type: "noul", noul: 0.01 },
  unbounded_target: { type: "noul", noul: 0.01 },
  risk: { type: "score", score: 0, confidence: 0.99 },
};
let transports = 0;
globalThis.fetch = async (url) => {
  assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
  transports++;
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
after(() => {
  try {
    assert.equal(activeIo.size, 0, "every actual IO injection must release");
  } finally {
    fs.writeSync = originalIo.writeSync;
    fs.closeSync = originalIo.closeSync;
    fs.lstatSync = originalIo.lstatSync;
    childProcess.spawnSync = originalIo.spawnSync;
    syncBuiltinESMExports();
    delete globalThis[floorKey];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
async function withIo(name, handler, run) {
  assert.equal(activeIo.has(name), false);
  const tap = { handler, calls: 0 };
  activeIo.set(name, tap);
  try {
    await run(tap);
  } finally {
    activeIo.delete(name);
  }
  assert(tap.calls > 0, `${name}: the injection must actually hit the source helper`);
}
let serial = 0;
const source = fileURLToPath(new URL("../../src/extensions/jev-auto-approval.ts", import.meta.url));
const activeName = "jev-auto-approval.jsonl",
  lockName = `.${activeName}.lock`;
const artifacts = (directory) => ({
  files: [join(directory, activeName), join(directory, lockName)],
  roots: [join(directory, `${activeName}.archives`)],
});
const frozenFloor = (files, roots) =>
  Object.freeze({
    version: 1,
    writeRoots: Object.freeze(roots),
    writeFiles: Object.freeze(files),
    readFiles: Object.freeze([]),
  });
async function fixture({
  legacy = false,
  symlink = false,
  floor = "none",
  absentLogs = false,
} = {}) {
  delete globalThis[floorKey];
  const base = join(root, `case-${++serial}`),
    agent = join(base, "agent"),
    logs = join(agent, "logs");
  fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
  const target = symlink ? join(base, "target") : logs;
  if (!absentLogs) {
    fs.mkdirSync(target, { mode: 0o750 });
    fs.chmodSync(target, 0o750);
  }
  if (symlink) fs.symlinkSync(target, logs, "dir");
  const targetArtifacts = artifacts(target);
  if (floor === "complete")
    globalThis[floorKey] = frozenFloor(targetArtifacts.files, targetArtifacts.roots);
  if (floor === "missing-lock")
    globalThis[floorKey] = frozenFloor(targetArtifacts.files.slice(0, 1), targetArtifacts.roots);
  if (floor === "missing-active")
    globalThis[floorKey] = frozenFloor(targetArtifacts.files.slice(1), targetArtifacts.roots);
  if (floor === "missing-archives") globalThis[floorKey] = frozenFloor(targetArtifacts.files, []);
  if (floor === "mutable")
    globalThis[floorKey] = { version: 1, writeRoots: [], writeFiles: [], readFiles: [] };
  if (legacy) fs.mkdirSync(join(target, lockName), { mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_JEV_API_KEY_FILE = key;
  process.env.PI_JEV_APPROVAL_MODE = "enforce";
  const { default: extension } = await createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
  }).import(source);
  const hooks = new Map(),
    bus = new Map(),
    reviews = [],
    notices = [],
    branch = [];
  let authorizer,
    toolSerial = 0;
  const policy = { state: "ask", source: "bash", origin: "global", matchedPattern: "bash:*" };
  const sessionId = `session-${serial}`;
  const ctx = {
    cwd: base,
    hasUI: true,
    signal: new AbortController().signal,
    getSystemPrompt: () => "",
    ui: {
      setStatus() {},
      notify(message) {
        notices.push(message);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getHeader: () => ({}),
      getBranch: () => branch,
    },
  };
  const pi = {
    on(name, fn) {
      hooks.set(name, fn);
    },
    events: {
      on(name, fn) {
        bus.set(name, fn);
      },
      emit(name, value) {
        bus.get(name)?.(value);
      },
    },
  };
  extension(pi);
  hooks.get("session_start")({}, ctx);
  globalThis[Symbol.for("@gotgenes/pi-permission-system:session-services")] = new Map([
    [
      sessionId,
      {
        registerAuthorizer(_name, fn) {
          authorizer = fn;
          return () => {};
        },
      },
    ],
  ]);
  bus.get("permissions:ready")({ sessionId });
  assert.equal(typeof authorizer, "function");
  const prompt =
    "Inspect the synthetic repository. PRIVATE-FIXTURE-TEXT must not enter diagnostics.";
  hooks.get("input")({ source: "interactive", text: prompt });
  hooks.get("before_agent_start")({ prompt, messageType: "user" });
  const message = { role: "user", content: [{ type: "text", text: prompt }] };
  hooks.get("message_start")({ message });
  branch.push({ type: "message", message });
  const query = { checkPermission: () => ({ ...policy }) };
  const log = {
    review(_event, detail) {
      reviews.push(detail);
    },
  };
  const call = (command = "git status") => {
    const id = `tool-${++toolSerial}`;
    branch.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
      },
    });
    return {
      requestId: `${sessionId}-${id}`,
      source: "tool_call",
      toolCallId: id,
      payload: {
        kind: "bash",
        evidence: [],
        request: {
          surface: "bash",
          toolName: "bash",
          invokedToolName: "bash",
          value: command,
          matchedPattern: "bash:*",
          commandContext: null,
          executedUnit: null,
          requester: { forwarded: false },
        },
      },
    };
  };
  const setMode = (mode) => {
    const request = { mode, includeSubagents: false, applied: false };
    bus.get("approval:set-judge")(request);
    assert.equal(request.applied, true);
  };
  return {
    base,
    agent,
    logs,
    target,
    ctx,
    policy,
    reviews,
    notices,
    branch,
    hooks,
    bus,
    call,
    setMode,
    authorize: (details) => authorizer(details, query, log),
    path: join(target, activeName),
    lock: join(target, lockName),
  };
}
const warnings = (f) => f.notices.filter((message) => message.startsWith("Jev audit unavailable"));
const auditRows = (f) =>
  !fs.existsSync(f.path) || fs.statSync(f.path).size === 0
    ? []
    : fs
        .readFileSync(f.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

test("legacy audit failure is visible, deduplicated, private, and later recovery is independently reviewed", async () => {
  const f = await fixture({ legacy: true }),
    before = transports;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
    assert.equal(f.reviews.at(-1).failureCode, "audit_unavailable");
  }
  assert.equal(warnings(f).length, 1);
  assert.match(warnings(f)[0], /legacy_lock_requires_offline_recovery/);
  assert.match(
    warnings(f)[0],
    /Stop every Pi sharing this agent directory, including old unlocked writers/,
  );
  assert(!warnings(f)[0].includes("PRIVATE-FIXTURE-TEXT"));
  assert(!warnings(f)[0].includes("git status"));
  assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
  // Isolated synthetic fixture only: no writer is pending, and this is not an
  // extension repair path or permission to remove a live kernel/Owner lock.
  fs.rmdirSync(f.lock);
  assert.deepEqual(await f.authorize(f.call()), { kind: "allow" });
  assert.equal(transports - before, 3, "no LLM approval cache on recovery");
  assert.equal(fs.lstatSync(f.lock).isFile(), true);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o750, "shared logs permissions are preserved");
});

test("foreign ancestor ownership stays denied with namespace-aware diagnostics, not lock-repair advice", async () => {
  const current = process.getuid(),
    foreign = current === 12345 ? 12346 : 12345;
  // Do not misclassify a legitimate current UID of 65534 as a foreign owner.
  for (const uid of [65534, foreign].filter((value) => value !== current)) {
    assert.notEqual(uid, current, "injected owner must differ from the actual current UID");
    const f = await fixture(),
      bytes = Buffer.from('{"history":"must remain literal"}\n');
    fs.writeFileSync(f.path, bytes, { mode: 0o600 });
    fs.writeFileSync(f.lock, "", { mode: 0o600 });
    const paths = [f.base, f.agent, f.target, f.path, f.lock];
    const snapshot = () =>
      paths.map((path) => {
        const info = originalIo.lstatSync(path);
        return [info.ino, info.uid, info.mode, info.nlink, info.size];
      });
    const before = snapshot(),
      names = fs.readdirSync(f.target);
    let forged = 0;
    await withIo(
      "lstatSync",
      (path, ...args) => {
        const info = originalIo.lstatSync(path, ...args);
        if (String(path) !== f.base) return info;
        forged++;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid });
      },
      async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
          assert.equal(f.reviews.at(-1).failureCode, "audit_unavailable");
          assert.equal(f.reviews.at(-1).auditFailureReason, "untrusted_directory_owner");
        }
      },
    );
    assert.equal(forged, 4, "each allow/defer audit actually samples the untrusted ancestor");
    assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
    assert.equal(warnings(f).length, 1, "precise ownership warning is still deduplicated");
    const message = warnings(f)[0];
    assert.match(message, /untrusted_directory_owner/);
    assert.match(message, /owner is not trusted in the current namespace/);
    assert.match(message, /Unmapped root may appear as an overflow UID\/nobody/);
    assert.match(message, /check UID\/GID mappings/);
    assert.match(message, /UID value alone does not establish a namespace cause/);
    assert.match(message, /not a bad lockfile; offline audit recovery or retry cannot fix/);
    assert(!message.includes("Check the private audit files and trusted lock executable"));
    assert(!message.includes("PRIVATE-FIXTURE-TEXT"));
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(fs.readdirSync(f.target), names);
    assert.deepEqual(fs.readFileSync(f.path), bytes);
    assert.equal(fs.readFileSync(f.lock).length, 0);
  }
});

test("failed audit write/close never publishes an audited allow; console fallback is independently visible", async () => {
  for (const failure of ["write", "close"]) {
    const f = await fixture();
    let activeFd;
    const previousWarn = console.warn,
      visible = [];
    console.warn = (message) => visible.push(message);
    f.ctx.ui.notify = () => {
      throw new Error("synthetic unavailable UI");
    };
    try {
      if (failure === "write") {
        await withIo(
          "writeSync",
          () => {
            throw new Error("synthetic secret raw error must never be shown");
          },
          async (tap) => {
            assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
            assert.equal(
              tap.calls,
              2,
              "allow audit and defer audit both hit the stable failing dispatcher",
            );
          },
        );
      } else {
        await withIo(
          "writeSync",
          (...args) => {
            activeFd = args[0];
            return Reflect.apply(originalIo.writeSync, fs, args);
          },
          async () =>
            withIo(
              "closeSync",
              (fd) => {
                originalIo.closeSync(fd);
                if (fd === activeFd) throw new Error("synthetic close confirmation failure");
              },
              async () => assert.deepEqual(await f.authorize(f.call()), { kind: "defer" }),
            ),
        );
      }
      assert.equal(visible.length, 1);
      assert.match(visible[0], failure === "write" ? /audit_io_failed/ : /cleanup_failed/);
      assert(!visible[0].includes("secret raw error"));
      assert.equal(f.reviews.at(-1).failureCode, "audit_unavailable");
      assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
    } finally {
      console.warn = previousWarn;
    }
    assert.deepEqual(await f.authorize(f.call()), { kind: "allow" });
  }
});

test("policy/mode/script changes during audit lock acquisition are freshly rejected before any allow write", async () => {
  for (const change of ["policy", "mode", "script"]) {
    const f = await fixture(),
      script = join(f.base, "synthetic-check.sh");
    fs.writeFileSync(script, "#!/bin/sh\nprintf before\n", { mode: 0o600 });
    let mutations = 0;
    await withIo(
      "spawnSync",
      (...args) => {
        const result = Reflect.apply(originalIo.spawnSync, childProcess, args);
        if (args[1].includes("--wait") && result.status === 0 && mutations === 0) {
          mutations++;
          if (change === "policy") f.policy.state = "deny";
          if (change === "mode") f.setMode("shadow");
          if (change === "script")
            fs.writeFileSync(script, "#!/bin/sh\nprintf changed\n", { mode: 0o600 });
        }
        return result;
      },
      async () =>
        assert.deepEqual(
          await f.authorize(f.call(change === "script" ? "./synthetic-check.sh" : "git status")),
          { kind: "defer" },
        ),
    );
    assert.equal(
      mutations,
      1,
      `${change}: mutation must hit a real successful acquisition before beforeWrite`,
    );
    assert.equal(f.reviews.at(-1).failureCode, "review_context_changed");
    assert.equal(f.reviews.at(-1).auditFailureReason, "validation_failed");
    assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
    assert(
      !auditRows(f).some((row) => row.effectiveVerdict === "allow"),
      "no stale allow in authoritative JSONL",
    );
  }
});

test("failed UI and console diagnostics cannot throw through mode changes or fail-closed verdicts", async () => {
  const f = await fixture({ legacy: true }),
    previousWarn = console.warn;
  f.ctx.ui.notify = () => {
    throw new Error("synthetic unavailable UI");
  };
  console.warn = () => {
    throw new Error("synthetic unavailable console");
  };
  try {
    assert.doesNotThrow(() => f.setMode("shadow"));
    assert.doesNotThrow(() => f.setMode("enforce"));
    assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
    assert.equal(f.reviews.at(-1).failureCode, "audit_unavailable");
    assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
  } finally {
    console.warn = previousWarn;
  }
});

test("mode/outcome audit failures stay visible without changing the requested authority choice", async () => {
  const f = await fixture({ legacy: true });
  f.setMode("shadow");
  assert(warnings(f).some((message) => message.includes("legacy_lock_requires_offline_recovery")));
  const before = transports,
    details = f.call();
  assert.deepEqual(await f.authorize(details), { kind: "defer" });
  f.bus.get("permissions:decision")({
    requestId: details.requestId,
    result: "deny",
    resolution: "user_denied",
  });
  assert.equal(
    warnings(f).length,
    1,
    "mode/decision/outcome failures share the deduped independent warning",
  );
  // Wait for the synthetic shadow classifier completion before replacing the
  // process-wide floor/transport/session for another fixture.
  for (let spin = 0; spin < 100 && f.reviews.length === 0; spin++)
    await new Promise((done) => setImmediate(done));
  assert.equal(transports - before, 1);
  assert(!f.reviews.some((row) => row.effectiveVerdict === "allow"));
});

test("an unrecognized before_agent_start shape is not direct input and keeps refusals closed", async () => {
  const f = await fixture();
  const denied = f.call();
  assert.deepEqual(await f.authorize(denied), { kind: "allow" });
  f.bus.get("permissions:decision")({
    requestId: denied.requestId,
    result: "deny",
    resolution: "user_denied",
  });
  const before = transports;
  // The pinned SDK makes messageType a required discriminator. The old
  // unlabelled shape (no messageType) and a malformed user start (messageType
  // "user" without a string prompt) must both fail closed: they discard the
  // pending input without binding provenance, so the human No stays paused and
  // the reviewer is never consulted for either shape.
  const stale = "Authorize the paused inspection now.";
  for (const start of [{ prompt: stale }, { messageType: "user" }]) {
    f.hooks.get("input")({ source: "interactive", text: stale });
    f.hooks.get("before_agent_start")(start);
    const message = { role: "user", content: [{ type: "text", text: stale }] };
    f.hooks.get("message_start")({ message });
    f.branch.push({ type: "message", message });
    assert.equal((await f.authorize(f.call())).kind, "deny");
  }
  assert.equal(transports, before, "no unrecognized start reached the reviewer");
  // A well-formed user prompt is still the turn boundary that reopens review.
  const fresh = "Authorize a fresh independent inspection now.";
  f.hooks.get("input")({ source: "interactive", text: fresh });
  f.hooks.get("before_agent_start")({ prompt: fresh, messageType: "user" });
  const message = { role: "user", content: [{ type: "text", text: fresh }] };
  f.hooks.get("message_start")({ message });
  f.branch.push({ type: "message", message });
  assert.deepEqual(await f.authorize(f.call()), { kind: "allow" });
});

test("absent logs bind to their first canonical ancestor rather than a later symlink", async () => {
  const normal = await fixture({ absentLogs: true });
  assert.equal(fs.existsSync(normal.logs), false);
  assert.deepEqual(await normal.authorize(normal.call()), { kind: "allow" });
  const f = await fixture({ absentLogs: true }),
    target = join(f.base, "later-target");
  fs.mkdirSync(target, { mode: 0o750 });
  const a = artifacts(target);
  globalThis[floorKey] = frozenFloor(a.files, a.roots);
  fs.symlinkSync(target, f.logs, "dir");
  assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
  assert.equal(f.reviews.at(-1).auditFailureReason, "directory_changed");
  assert.deepEqual(fs.readdirSync(target), []);
});

test("symlink audit targets require the frozen exact-artifact floor and a fixed first binding", async () => {
  for (const floor of ["none", "missing-active", "missing-lock", "missing-archives", "mutable"]) {
    const f = await fixture({ symlink: true, floor });
    assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
    assert.equal(f.reviews.at(-1).failureCode, "audit_unavailable");
    assert.match(
      warnings(f)[0],
      floor === "mutable" ? /invalid_input/ : /symlink_target_unprotected/,
    );
    assert.deepEqual(
      fs.readdirSync(f.target),
      [],
      "unprotected target receives no audit artifacts",
    );
  }
  const f = await fixture({ symlink: true, floor: "complete" });
  assert.deepEqual(await f.authorize(f.call()), { kind: "allow" });
  const before = fs.readFileSync(f.path),
    other = join(f.base, "other-target");
  fs.mkdirSync(other, { mode: 0o750 });
  const a = artifacts(f.target),
    b = artifacts(other);
  // Even a synthetic floor covering both locations cannot rebind a loaded
  // extension. Real startup floors are immutable and never widened this way.
  globalThis[floorKey] = frozenFloor([...a.files, ...b.files], [...a.roots, ...b.roots]);
  fs.unlinkSync(f.logs);
  fs.symlinkSync(other, f.logs, "dir");
  assert.deepEqual(await f.authorize(f.call()), { kind: "defer" });
  assert.equal(f.reviews.at(-1).auditFailureReason, "directory_changed");
  assert.deepEqual(fs.readdirSync(other), []);
  assert.deepEqual(fs.readFileSync(f.path), before);
});
