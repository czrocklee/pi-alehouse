import assert from "node:assert/strict";
import fs, {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  SettingsStore, registerSettingsStore, settingsStoreForSession, validateSettings,
} from "../lib/settings-store.mjs";

const definition = (version = "v1", model = "fixture/model") => ({
  version,
  slots: { d1: { model }, d2: { model }, d3: { model }, d4: { model }, d5: { model } },
});
const withSlot = (slot, patch, version = "v1", model = "fixture/model") => {
  const body = definition(version, model);
  body.slots[slot] = { ...body.slots[slot], ...patch };
  return body;
};
function fixture(t, projectTrusted = true) {
  const root = mkdtempSync(join(tmpdir(), "alehouse-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted };
  const paths = {
    global: join(options.agentDir, "extensions/pi-alehouse/config.json"),
    workspace: join(options.cwd, ".pi/extensions/pi-alehouse/config.json"),
  };
  const put = (scope, value) => {
    mkdirSync(dirname(paths[scope]), { recursive: true });
    writeFileSync(paths[scope], JSON.stringify(value));
  };
  return { root, options, paths, put, store: () => new SettingsStore(options) };
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const ownArtifacts = (path) => readdirSync(dirname(path)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));
function intercept(method, implementation, run) {
  const original = fs[method];
  fs[method] = (...args) => implementation(original, args);
  syncBuiltinESMExports();
  try { return run(); }
  finally { fs[method] = original; syncBuiltinESMExports(); }
}
const isTempFd = (fd) => fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith(".tmp");

// Every fixture is synthetic and local. No SDK, credentials, provider, network,
// human approval or packaging lane is exercised by this file.
test("constructor and clean operations never create directories", (t) => {
  const f = fixture(t), store = f.store();
  assert.deepEqual(store.paths, f.paths);
  assert(Object.isFrozen(store.paths));
  assert.throws(() => { store.paths.global = "other"; }, TypeError);
  assert.equal(store.scope, "session");
  assert.equal(store.canWriteWorkspace(), true);
  assert.deepEqual(store.get("global"), { version: 2 });
  assert.deepEqual(store.get("workspace"), { version: 2 });
  assert.deepEqual(store.effective(), { version: 2 });
  assert.deepEqual(store.pending(), []);
  store.setScope("global");
  assert.equal(store.scope, "global");
  store.setScope("workspace");
  store.setScope("session");
  store.discard();
  assert.deepEqual(store.flush(), []);
  assert.deepEqual(readdirSync(f.root), []);
});

test("untrusted workspace is never read or written, even when malformed", (t) => {
  const f = fixture(t, false);
  f.put("global", { version: 2, preset: "off", approval: "manual" });
  f.put("workspace", { version: "SECRET-invalid", approval: "yolo" });
  const store = intercept("lstatSync", (original, [path, ...options]) => {
    assert.notEqual(path, f.paths.workspace, "untrusted workspace must not even be inspected");
    return original(path, ...options);
  }, () => f.store());
  assert.equal(store.canWriteWorkspace(), false);
  assert.deepEqual(store.get("workspace"), { version: 2 });
  assert.equal(store.effective().approval, "manual");
  assert.throws(() => store.setScope("workspace"), /trust/);
  assert.throws(() => store.stage("workspace", ["approval"], "yolo"), /trust/);
  store.stage("global", ["approval"], "judge");
  assert.deepEqual(store.flush(), [{ scope: "global", path: f.paths.global }]);
  assert.equal(read(f.paths.workspace).version, "SECRET-invalid");
});

test("global and trusted workspace merge by the contracted units", (t) => {
  const f = fixture(t);
  f.put("global", {
    version: 2, preset: "base", approval: "judge", delegation: { mode: "lead", eagerness: "balanced" },
    presets: { base: withSlot("d1", { effort: "low" }), other: definition("other-v1") },
    effort: { base: { d1: "high", d2: "inherit", d3: "medium", d4: "minimal", d5: "low" }, other: { d5: "max" } },
  });
  f.put("workspace", {
    version: 2, preset: "off", delegation: { eagerness: "eager" }, presets: { base: definition("v2") },
    effort: { base: { d1: null, d3: "off", d4: null } },
  });
  const store = f.store();
  store.stage("workspace", ["approval"], "judge+sub");
  store.stage("global", ["delegation", "mode"], "supervisor");
  assert.deepEqual(store.effective(), {
    version: 2, preset: "off", approval: "judge+sub", delegation: { mode: "supervisor", eagerness: "eager" },
    presets: { base: definition("v2"), other: definition("other-v1") },
    effort: { base: { d1: null, d2: "inherit", d3: "off", d4: null, d5: "low" }, other: { d5: "max" } },
  });
  assert.deepEqual(store.effective().presets.base, definition("v2"));
  assert(!Object.hasOwn(store.effective().presets.base.slots.d1, "effort"), "preset bodies do not merge");
});

test("individually bounded preference layers remain loadable when their merge exceeds one file cap", (t) => {
  const f = fixture(t), store = f.store();
  const presets = (prefix) => Object.fromEntries(Array.from({ length: 350 }, (_unused, index) =>
    [`${prefix}${index}`, definition("v".repeat(64), `fixture/${"m".repeat(100)}`)]));
  store.stage("global", ["presets"], presets("global"));
  store.stage("workspace", ["presets"], presets("workspace"));
  const effective = store.effective();
  assert(Buffer.byteLength(JSON.stringify(effective)) > 256 * 1024);
  assert.equal(Object.keys(effective.presets).length, 700);
  assert.deepEqual(store.flush(), [
    { scope: "global", path: f.paths.global }, { scope: "workspace", path: f.paths.workspace },
  ]);
  for (const path of Object.values(f.paths)) {
    assert(lstatSync(path).size < 256 * 1024);
    validateSettings(read(path));
  }
  assert.deepEqual(f.store().effective(), effective, "successful saves must remain restorable");
  const pending = store.pending();
  assert.throws(() => store.stage("global", ["presets"], effective.presets), /262144/,
    "merging in memory never widens an individual file's write limit");
  assert.deepEqual(store.pending(), pending);
  for (const layers of [0, 4, Infinity, "2", null])
    assert.throws(() => validateSettings({ version: 2 }, layers), /validation layers/);
});

test("undefined removes a workspace key and exposes lower-layer effort, unlike null", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual", effort: { base: { d1: "high" } } });
  f.put("workspace", { version: 2, approval: "judge", effort: { base: { d1: null } } });
  const store = f.store();
  assert.equal(store.effective().effort.base.d1, null);
  store.stage("workspace", ["effort", "base", "d1"], undefined);
  store.stage("workspace", ["approval"], undefined);
  assert.deepEqual(store.pending(), [
    { scope: "workspace", path: ["effort", "base", "d1"], value: undefined },
    { scope: "workspace", path: ["approval"], value: undefined },
  ]);
  assert.equal(store.effective().effort.base.d1, "high");
  assert.equal(store.effective().approval, "manual");
  assert.deepEqual(store.flush(), [{ scope: "workspace", path: f.paths.workspace }]);
  assert.deepEqual(read(f.paths.workspace), { version: 2, effort: { base: {} } });
});

test("get, effective, pending and stage inputs are detached clones", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, presets: { base: definition() }, effort: { base: { d1: "low" } } });
  const store = f.store(), body = definition("v2"), path = ["presets", "base"];
  store.stage("global", path, body);
  body.slots.d1.model = "changed/model";
  path[1] = "changed";
  store.get("global").presets.base.slots.d1.model = "changed/model";
  store.effective().effort.base.d1 = "max";
  const pending = store.pending();
  pending[0].path[1] = "changed";
  pending[0].value.slots.d1.model = "changed/model";
  assert.equal(store.get("global").presets.base.slots.d1.model, "fixture/model");
  assert.equal(store.get("global").effort.base.d1, "low");
  assert.deepEqual(store.pending()[0].path, ["presets", "base"]);
});

test("only dirty paths are retained; reverted or absent deletes never perform IO", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual", delegation: { mode: "manual" } });
  const store = f.store();
  store.stage("global", ["version"], 2);
  store.stage("global", ["preset"], undefined);
  store.stage("global", ["effort", "missing", "d1"], undefined);
  store.stage("global", ["approval"], "judge");
  store.stage("global", ["approval"], "manual");
  store.stage("global", ["delegation"], { mode: "manual" });
  assert.deepEqual(store.pending(), []);
  writeFileSync(f.paths.global, "malformed-now");
  intercept("lstatSync", () => { throw new Error("unexpected IO"); }, () => {
    assert.deepEqual(store.get("global"), { version: 2, approval: "manual", delegation: { mode: "manual" } });
    assert.equal(store.effective().approval, "manual");
    assert.deepEqual(store.flush(), []);
    store.discard();
  });
});

test("stage coalesces overlapping patches and compares original, not pending, values", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, delegation: { mode: "manual", eagerness: "balanced" } });
  const store = f.store();
  store.stage("global", ["delegation"], { mode: "lead", eagerness: "eager" });
  store.stage("global", ["delegation", "mode"], "supervisor");
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["delegation"], value: { mode: "supervisor", eagerness: "eager" } }]);
  store.stage("global", ["delegation", "mode"], "manual");
  store.stage("global", ["delegation", "eagerness"], "balanced");
  assert.deepEqual(store.pending(), []);
  store.stage("global", ["delegation", "mode"], "lead");
  store.stage("global", ["delegation", "eagerness"], "eager");
  store.stage("global", ["delegation"], { mode: "manual", eagerness: "reserved" });
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["delegation"], value: { mode: "manual", eagerness: "reserved" } }]);
});

test("discard can reset one scope or both, without writing", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  store.stage("workspace", ["preset"], "off");
  store.discard("global");
  assert.equal(store.pending().length, 1);
  assert.deepEqual(store.get("global"), { version: 2 });
  assert.equal(store.effective().preset, "off");
  store.discard();
  assert.deepEqual(store.pending(), []);
  assert.deepEqual(readdirSync(f.root), []);
});

test("explicit flush creates private regular files and resets successful baselines", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  store.stage("workspace", ["effort", "base", "d1"], null);
  assert.deepEqual(readdirSync(f.root), []);
  assert.deepEqual(store.flush(), [
    { scope: "global", path: f.paths.global }, { scope: "workspace", path: f.paths.workspace },
  ]);
  assert.deepEqual(read(f.paths.global), { version: 2, approval: "judge" });
  assert.deepEqual(read(f.paths.workspace), { version: 2, effort: { base: { d1: null } } });
  assert.equal(lstatSync(f.paths.global).mode & 0o777, 0o600);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  assert.deepEqual(ownArtifacts(f.paths.workspace), []);
  assert.deepEqual(store.pending(), []);
  store.stage("global", ["approval"], "manual");
  assert.deepEqual(store.flush(), [{ scope: "global", path: f.paths.global }]);
  store.stage("global", ["approval"], undefined);
  assert.deepEqual(store.flush(), [{ scope: "global", path: f.paths.global }]);
  assert.deepEqual(store.get("global"), { version: 2 });
  assert.deepEqual(f.store().effective(), store.effective());
});

test("new scopes persist explicit patches, not inherited effective values", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "judge", presets: { base: definition() }, delegation: { mode: "lead" } });
  const store = f.store();
  store.stage("workspace", ["delegation", "eagerness"], "eager");
  assert.deepEqual(store.flush(), [{ scope: "workspace", path: f.paths.workspace }]);
  assert.deepEqual(read(f.paths.workspace), { version: 2, delegation: { eagerness: "eager" } });
  assert.equal(store.effective().approval, "judge");
});

test("concurrent unrelated scalar and nested leaf edits survive and become the new baseline", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual", delegation: { mode: "manual", eagerness: "balanced" }, effort: { base: { d1: "low" } } });
  const first = f.store(), second = f.store();
  first.stage("global", ["delegation", "mode"], "lead");
  first.stage("global", ["effort", "base", "d1"], "high");
  second.stage("global", ["delegation", "eagerness"], "eager");
  second.stage("global", ["effort", "base", "d5"], "max");
  second.stage("global", ["approval"], "judge");
  assert(!second.flush()[0].error);
  assert(!first.flush()[0].error);
  assert.deepEqual(read(f.paths.global), {
    version: 2, approval: "judge", delegation: { mode: "lead", eagerness: "eager" },
    effort: { base: { d1: "high", d5: "max" } },
  });
  first.stage("global", ["approval"], "manual");
  assert(!first.flush()[0].error, "successful commits adopt unrelated latest edits as the baseline");
});

test("same-leaf concurrent edits reject the entire scope and retain all dirty patches", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const first = f.store(), second = f.store();
  first.stage("global", ["approval"], "judge");
  first.stage("global", ["preset"], "off");
  second.stage("global", ["approval"], "yolo");
  assert(!second.flush()[0].error);
  const result = first.flush();
  assert.match(result[0].error, /conflict/);
  assert.equal(first.pending().length, 2);
  assert.deepEqual(read(f.paths.global), { version: 2, approval: "yolo" });
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  assert.match(first.flush()[0].error, /conflict/, "retry cannot silently rebase a failed dirty leaf");
});

test("missing-vs-null conflicts and identical desired external changes are not adopted", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["effort", "base", "d1"], "high");
  f.put("global", { version: 2, effort: { base: { d1: null } } });
  assert.match(store.flush()[0].error, /conflict/);
  f.put("global", { version: 2, effort: { base: { d1: "high" } } });
  assert.match(store.flush()[0].error, /conflict/);
  assert.equal(store.pending().length, 1);
  f.put("global", { version: 2, effort: { base: {} } });
  assert(!store.flush()[0].error, "restoring the original missing leaf allows a retry");
});

test("deleting an original key conflicts if it has already been deleted externally", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], undefined);
  f.put("global", { version: 2 });
  assert.match(store.flush()[0].error, /conflict/);
  assert.deepEqual(store.pending()[0], { scope: "global", path: ["approval"], value: undefined });
});

test("separate scope attempts are independent and failures stay pending", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  store.stage("workspace", ["approval"], "judge+sub");
  writeFileSync(`${f.paths.global}.lock`, "foreign lock");
  const result = store.flush();
  assert.match(result[0].error, /lock busy/);
  assert.deepEqual(result[1], { scope: "workspace", path: f.paths.workspace });
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["approval"], value: "judge" }]);
  assert.equal(readFileSync(`${f.paths.global}.lock`, "utf8"), "foreign lock");
});

test("existing malformed, wrong schema, invalid UTF-8 and oversized configs fail without raw contents", (t) => {
  const f = fixture(t);
  const secret = "SECRET-DO-NOT-REPORT";
  f.put("global", { version: 2 });
  for (const bytes of [
    `{"approval":"${secret}"`, JSON.stringify({ version: 3, private: secret }),
    Buffer.from([0xff, 0xfe]), " ".repeat(256 * 1024 + 1),
  ]) {
    writeFileSync(f.paths.global, bytes);
    assert.throws(() => f.store(), (error) => {
      assert(error.message.includes(f.paths.global));
      assert.match(error.message, /repair/i);
      assert(!error.message.includes(secret));
      return true;
    });
  }
});

test("external malformed config never gets overwritten and failed patches survive repair", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  const secret = "SECRET-invalid-external";
  writeFileSync(f.paths.global, secret);
  const result = store.flush()[0];
  assert.match(result.error, /JSON/);
  assert(!result.error.includes(secret));
  assert.equal(readFileSync(f.paths.global, "utf8"), secret);
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  f.put("global", { version: 2, approval: "manual", preset: "off" });
  assert(!store.flush()[0].error);
  assert.deepEqual(read(f.paths.global), { version: 2, approval: "judge", preset: "off" });
});

test("read symlinks to regular configs are allowed but writes never replace them", (t) => {
  const f = fixture(t), actual = join(f.root, "managed-config.json");
  writeFileSync(actual, JSON.stringify({ version: 2, approval: "manual" }));
  mkdirSync(dirname(f.paths.global), { recursive: true });
  symlinkSync(actual, f.paths.global);
  const store = f.store();
  assert.equal(store.get("global").approval, "manual");
  store.stage("global", ["approval"], "judge");
  assert.match(store.flush()[0].error, /symlink/);
  assert(lstatSync(f.paths.global).isSymbolicLink());
  assert.equal(read(actual).approval, "manual");
  assert.equal(store.pending().length, 1);
});

test("symlink parents may be read but cannot be used for writes or directory creation", (t) => {
  const f = fixture(t), actual = join(f.root, "actual-agent");
  mkdirSync(join(actual, "extensions/pi-alehouse"), { recursive: true });
  writeFileSync(join(actual, "extensions/pi-alehouse/config.json"), JSON.stringify({ version: 2, approval: "manual" }));
  symlinkSync(actual, f.options.agentDir);
  const store = f.store();
  assert.equal(store.get("global").approval, "manual");
  store.stage("global", ["approval"], "judge");
  assert.match(store.flush()[0].error, /symlink/);
  assert.equal(read(f.paths.global).approval, "manual");
  rmSync(join(actual, "extensions"), { recursive: true });
  assert.match(store.flush()[0].error, /symlink/);
  assert(!existsSync(join(actual, "extensions")));
});

test("dangling symlinks, directory targets and nonregular read targets fail visibly", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.paths.global), { recursive: true });
  symlinkSync(join(f.root, "nonexistent"), f.paths.global);
  assert.throws(() => f.store(), /Cannot read settings/);
  rmSync(f.paths.global);
  mkdirSync(f.paths.global);
  assert.throws(() => f.store(), /regular file/);
  rmSync(f.paths.global, { recursive: true });
  const fifo = spawnSync("mkfifo", [f.paths.global], { encoding: "utf8", timeout: 5000 });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.throws(() => f.store(), /regular file/);
});

test("readonly targets and directories are rejected even under a privileged user", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  chmodSync(f.paths.global, 0o444);
  assert.match(store.flush()[0].error, /readonly/);
  assert.equal(read(f.paths.global).approval, "manual");
  chmodSync(f.paths.global, 0o600);
  chmodSync(dirname(f.paths.global), 0o555);
  assert.match(store.flush()[0].error, /readonly/);
  chmodSync(dirname(f.paths.global), 0o700);
  assert(!store.flush()[0].error);
});

test("a target made nonregular after construction is never replaced", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  mkdirSync(f.paths.global, { recursive: true });
  assert.match(store.flush()[0].error, /regular file/);
  assert(lstatSync(f.paths.global).isDirectory());
  assert.equal(store.pending().length, 1);
});

test("a separate process holding the lock blocks writes without automatic stale stealing", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {openSync, writeFileSync, closeSync} from 'node:fs';
    const fd = openSync(process.argv[1], 'wx', 0o600);
    writeFileSync(fd, 'other-process-lock'); closeSync(fd);
  `, `${f.paths.global}.lock`], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  assert.match(store.flush()[0].error, /lock busy/);
  assert.match(store.flush()[0].error, /no stale lock/);
  assert.equal(readFileSync(`${f.paths.global}.lock`, "utf8"), "other-process-lock");
  assert.equal(read(f.paths.global).approval, "manual");
  assert.equal(store.pending().length, 1);
  rmSync(`${f.paths.global}.lock`); // fixture owns this deliberately abandoned lock
  assert(!store.flush()[0].error);
});

test("temp write/fsync failures clean only owned artifacts and retain all dirty patches", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  intercept("fsyncSync", (original, [fd]) => {
    if (isTempFd(fd)) throw Object.assign(new Error("SECRET-failure"), { code: "EIO" });
    return original(fd);
  }, () => {
    const result = store.flush()[0];
    assert.match(result.error, /EIO/);
    assert(!result.error.includes("SECRET"));
  });
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  assert.equal(read(f.paths.global).approval, "manual");
  assert.equal(store.pending().length, 1);
  assert(!store.flush()[0].error);
});

test("final recheck rejects changed target identity before rename", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  intercept("fsyncSync", (original, [fd]) => {
    if (isTempFd(fd)) {
      fs.renameSync(f.paths.global, `${f.paths.global}.original`);
      f.put("global", { version: 2, approval: "manual", preset: "off" });
    }
    return original(fd);
  }, () => assert.match(store.flush()[0].error, /identity or contents changed/));
  assert.deepEqual(read(f.paths.global), { version: 2, approval: "manual", preset: "off" });
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("final recheck refuses a newly symlinked target and leaves its referent intact", (t) => {
  const f = fixture(t), referent = join(f.root, "referent.json");
  f.put("global", { version: 2, approval: "manual" });
  writeFileSync(referent, JSON.stringify({ version: 2, approval: "yolo" }));
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  intercept("fsyncSync", (original, [fd]) => {
    if (isTempFd(fd)) { fs.unlinkSync(f.paths.global); symlinkSync(referent, f.paths.global); }
    return original(fd);
  }, () => assert.match(store.flush()[0].error, /symlink/));
  assert(lstatSync(f.paths.global).isSymbolicLink());
  assert.equal(read(referent).approval, "yolo");
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("cleanup never removes a lock whose ownership changed", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  intercept("fsyncSync", (original, [fd]) => {
    if (isTempFd(fd)) { fs.unlinkSync(`${f.paths.global}.lock`); writeFileSync(`${f.paths.global}.lock`, "foreign replacement"); }
    return original(fd);
  }, () => assert.match(store.flush()[0].error, /ownership changed/));
  assert.equal(readFileSync(`${f.paths.global}.lock`, "utf8"), "foreign replacement");
  assert.equal(read(f.paths.global).approval, "manual");
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), ["config.json.lock"]);
});

test("rename uncertainty retains the lock and pending patches, without deleting a foreign temp", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  const unrelatedTemp = join(dirname(f.paths.global), ".config.json.foreign.tmp");
  writeFileSync(unrelatedTemp, "other writer");
  intercept("renameSync", () => { throw Object.assign(new Error("synthetic"), { code: "EIO" }); }, () => {
    assert.match(store.flush()[0].error, /unconfirmed.*Lock retained/);
  });
  assert.equal(read(f.paths.global).approval, "manual");
  assert.equal(store.pending().length, 1);
  assert.equal(readFileSync(unrelatedTemp, "utf8"), "other writer");
  assert(existsSync(`${f.paths.global}.lock`));
  assert.match(store.flush()[0].error, /lock busy/);
});

test("post-rename directory fsync uncertainty keeps the published file, lock and dirty patches", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  intercept("fsyncSync", (original, [fd]) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("synthetic"), { code: "EIO" });
    return original(fd);
  }, () => assert.match(store.flush()[0].error, /unconfirmed.*Lock retained/));
  assert.equal(read(f.paths.global).approval, "judge");
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), ["config.json.lock"]);
  assert.match(store.flush()[0].error, /lock busy/);
});

test("seal blocks scope/stage mutations but allows flush, reads and discard", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  store.seal();
  store.seal();
  assert.throws(() => store.setScope("global"), /sealed/);
  assert.throws(() => store.stage("global", ["approval"], "manual"), /sealed/);
  assert.equal(store.effective().approval, "judge");
  assert.deepEqual(store.flush(), [{ scope: "global", path: f.paths.global }]);
  store.discard();
  assert.deepEqual(store.flush(), []);
});

test("full schema validates, including empty policy maps, nested model IDs and nullable override masks", () => {
  const value = {
    version: 2, preset: "off", approval: "judge+sub", delegation: { mode: "co-worker", eagerness: "reserved" },
    effort: { "preset.Name-1": { d1: null, d2: "inherit", d3: "xhigh", d4: "max", d5: null } },
    presets: { "preset.Name-1": {
      ...definition("revision", "provider-name/org/model:revision"),
      slots: {
        ...definition("revision", "provider-name/org/model:revision").slots,
        d1: { model: "provider-name/org/model:revision", effort: "off" },
        d4: { model: "provider-name/org/model:revision" },
        d5: { model: "provider-name/org/model:revision", effort: "max" },
      },
    } },
  };
  assert.deepEqual(validateSettings(value), value);
  const result = validateSettings(value);
  result.presets["preset.Name-1"].slots.d1.model = "other/model";
  assert.equal(value.presets["preset.Name-1"].slots.d1.model, "provider-name/org/model:revision");
  const plainNull = Object.assign(Object.create(null), { version: 2, delegation: Object.create(null) });
  assert.deepEqual(validateSettings(plainNull), { version: 2, delegation: {} });
});

test("validator rejects unknown fields, bad enums, nonrecords and unbounded strings", () => {
  for (const value of [
    null, [], 1, {}, { version: 3 }, { version: 2, unknown: true },
    { version: 2, approval: undefined }, { version: 2, approval: "auto" },
    { version: 2, preset: " space" }, { version: 2, preset: "a".repeat(65) }, { version: 2, preset: "reload" },
    { version: 2, delegation: [] }, { version: 2, delegation: { mode: "auto" } },
    { version: 2, delegation: { eagerness: "fast" } }, { version: 2, delegation: { extra: true } },
    { version: 2, effort: [] }, { version: 2, effort: { base: { other: "low" } } },
    { version: 2, effort: { base: { d1: NaN } } }, { version: 2, effort: { base: { d1: Infinity } } },
    { version: 2, effort: { base: { d1: undefined } } },
    { version: 2, presets: { base: { ...definition(), version: "" } } },
    { version: 2, presets: { base: { ...definition(), version: "v".repeat(65) } } },
    { version: 2, presets: { base: { ...definition(), version: "newline\n" } } },
    { version: 2, presets: { base: { ...definition(), extra: 1 } } },
    { version: 2, presets: { base: { ...definition(), models: { d1: "fixture/model" } } } },
    { version: 2, presets: { base: { ...definition(), effort: { d1: null } } } },
    { version: 2, presets: { base: { ...definition(), thinking: { d1: { low: "medium" } } } } },
    { version: 2, presets: { base: withSlot("d1", { thinking: {} }) } },
    { version: 2, presets: { base: withSlot("d1", { thinking: null }) } },
    { version: 2, presets: { base: withSlot("d1", { thinking: { low: "medium" } }) } },
  ]) assert.throws(() => validateSettings(value), /Invalid settings/);
  for (const model of ["model", "/model", "provider/", "provider/*", "provider/m?", " provider/model", "provider/model ", "provider/model\n", `provider/${"m".repeat(250)}`])
    assert.throws(() => validateSettings({ version: 2, presets: { base: definition("v1", model) } }), /provider\/model/);
});

test("reserved definition/effort names and prototype-unsafe keys are rejected at every map depth", () => {
  for (const name of ["off", "reload", "__proto__", "constructor", "prototype", "bad name"])
    for (const field of ["presets", "effort"])
      assert.throws(() => validateSettings({ version: 2, [field]: { [name]: field === "presets" ? definition() : {} } }));
  for (const value of [
    '{"version":2,"__proto__":{}}', '{"version":2,"delegation":{"constructor":"manual"}}',
    '{"version":2,"effort":{"base":{"prototype":"low"}}}',
    '{"version":2,"presets":{"base":{"version":"v1","slots":{"__proto__":{"model":"p/m"}}}}}',
    '{"version":2,"presets":{"base":{"version":"v1","slots":{"d1":{"model":"p/m","constructor":"x"},"d2":{"model":"p/m"},"d3":{"model":"p/m"},"d4":{"model":"p/m"},"d5":{"model":"p/m"}}}}}',

  ]) assert.throws(() => validateSettings(JSON.parse(value)), /unsafe/);
  assert.equal({}.polluted, undefined);
});

test("plain-record validation rejects symbols, custom prototypes and accessors without invoking them", () => {
  let invoked = 0;
  const accessor = { version: 2 };
  Object.defineProperty(accessor, "approval", { enumerable: true, get() { invoked++; return "manual"; } });
  const nested = { version: 2, delegation: {} };
  Object.defineProperty(nested.delegation, "mode", { enumerable: true, get() { invoked++; return "lead"; } });
  const hidden = { version: 2 };
  Object.defineProperty(hidden, "approval", { enumerable: false, value: "manual" });
  const slotAccessor = definition();
  Object.defineProperty(slotAccessor.slots.d1, "model", { enumerable: true, get() { invoked++; return "fixture/model"; } });
  const thinkingAccessor = definition();
  const mapping = {};
  Object.defineProperty(mapping, "low", { enumerable: true, get() { invoked++; return "medium"; } });
  thinkingAccessor.slots.d3 = { model: "fixture/model", thinking: mapping };
  const symbolSlot = definition();
  symbolSlot.slots.d2[Symbol("key")] = 1;
  const symbolMap = definition();
  symbolMap.slots.d2 = { model: "fixture/model", thinking: { low: "medium", [Symbol("key")]: "high" } };
  const protoSlot = definition();
  protoSlot.slots.d1 = Object.assign(Object.create({ inherited: true }), { model: "fixture/model" });
  for (const value of [
    accessor, nested, hidden, { version: 2, [Symbol("key")]: 1 }, new Date(),
    Object.assign(Object.create({ inherited: true }), { version: 2 }),
    { version: 2, presets: { base: slotAccessor } },
    { version: 2, presets: { base: thinkingAccessor } },
    { version: 2, presets: { base: symbolSlot } },
    { version: 2, presets: { base: symbolMap } },
    { version: 2, presets: { base: protoSlot } },
  ]) assert.throws(() => validateSettings(value));
  assert.equal(invoked, 0);
});

test("the 256 KiB cap accounts for serialized maps and escaping", () => {
  const presets = {};
  for (let index = 0; index < 1500; index++) presets[`p${index}`] = definition("v".repeat(64), `provider/${"m".repeat(100)}`);
  assert.throws(() => validateSettings({ version: 2, presets }), /262144/);
});

test("invalid stages are atomic and unsafe/sparse/accessor paths do not execute data", (t) => {
  const f = fixture(t), store = f.store();
  store.stage("global", ["approval"], "judge");
  for (const [path, value] of [
    [[], 1], [["__proto__", "polluted"], true], [["constructor"], {}], [["version"], 1],
    [["unknown"], "manual"], [["presets", "base"], { version: "v1" }],
    [["presets", "base", "slots", "d1", "effort", "tooDeep"], "low"],
    [["presets", "base", "slots", "d1", "__proto__"], "off"],
    [["approval", "nested"], "judge"], [new Array(1), "manual"], [new Array(6), "low"],
  ]) assert.throws(() => store.stage("global", path, value));
  let invoked = 0;
  const path = [];
  Object.defineProperty(path, "0", { get() { invoked++; return "approval"; } });
  assert.throws(() => store.stage("global", path, "manual"));
  const value = {};
  Object.defineProperty(value, "mode", { enumerable: true, get() { invoked++; return "lead"; } });
  assert.throws(() => store.stage("global", ["delegation"], value));
  const slot = { model: "fixture/model" };
  Object.defineProperty(slot, "effort", { enumerable: true, get() { invoked++; return "low"; } });
  const badPreset = definition();
  badPreset.slots.d1 = slot;
  assert.throws(() => store.stage("global", ["presets", "base"], badPreset));
  const thinking = {};
  Object.defineProperty(thinking, "minimal", { enumerable: true, get() { invoked++; return "high"; } });
  assert.throws(() => store.stage("global", ["presets", "base", "slots", "d1", "thinking"], thinking));
  const accessorPath = [];
  for (const key of ["presets", "base", "slots", "d1", "effort"]) {
    const index = accessorPath.length;
    Object.defineProperty(accessorPath, String(index), { enumerable: true, get() { invoked++; return key; } });
  }
  assert.throws(() => store.stage("global", accessorPath, "low"), /1 to 5/);
  assert.equal(invoked, 0);
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["approval"], value: "judge" }]);
  assert.throws(() => store.setScope("invalid"));
  assert.throws(() => store.stage("session", ["approval"], "manual"));
  assert.throws(() => store.get("session"));
  assert.throws(() => store.discard("session"));
  assert.equal({}.polluted, undefined);
});

test("version 1 settings are rejected even with five-slot bodies; no read or flush migrates files", (t) => {
  for (const document of [
    { version: 1 }, { version: 1, preset: "off", approval: "manual" },
    { version: 1, approval: "judge" }, { version: 1, delegation: { mode: "manual" } },
    { version: 1, presets: { base: definition() }, effort: { base: { d5: null } } },
  ]) assert.throws(() => validateSettings(document), /version 1 is unsupported.*including approval\/delegation-only or empty documents.*manually provide a version 2.*no automatic migration/);
  const f = fixture(t);
  for (const scope of ["global", "workspace"]) {
    f.put(scope, { version: 1, presets: { base: definition() } });
    const before = readFileSync(f.paths[scope]);
    assert.throws(() => f.store(), /version 1 is unsupported/);
    assert.deepEqual(readFileSync(f.paths[scope]), before);
    assert.deepEqual(ownArtifacts(f.paths[scope]), []);
    f.put(scope, { version: 2 });
  }
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  f.put("global", { version: 1 });
  const before = readFileSync(f.paths.global);
  assert.match(store.flush()[0].error, /version 1 is unsupported/);
  assert.deepEqual(readFileSync(f.paths.global), before);
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("legacy slot keys are rejected in every slot map, including mixed five-slot maps", (t) => {
  const legacy = {
    light: { model: "fixture/model" }, standard: { model: "fixture/model" }, strong: { model: "fixture/model" },
  };
  for (const key of ["light", "standard", "strong"]) {
    assert.throws(() => validateSettings({ version: 2, presets: { base: {
      version: "v1", slots: { ...definition().slots, [key]: { model: "fixture/model" } },
    } } }), /legacy slots.*d1, d2, d3, d4, d5/);
    for (const level of ["high", null])
      assert.throws(() => validateSettings({ version: 2, effort: { base: { d1: null, [key]: level } } }), /legacy slots/);
  }
  assert.throws(() => validateSettings({ version: 2, presets: { base: { version: "v1", slots: legacy } } }), /legacy slots/);
  const f = fixture(t), store = f.store();
  for (const key of Object.keys(legacy)) {
    assert.throws(() => store.stage("global", ["effort", "base", key], null), /legacy slots/);
    assert.deepEqual(store.pending(), []);
  }
  f.put("global", { version: 2, effort: { base: { light: null } } });
  const before = readFileSync(f.paths.global);
  assert.throws(() => f.store(), /legacy slots/);
  assert.deepEqual(readFileSync(f.paths.global), before);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("all five slots are required independently; repeated models and partial effort stay exact", () => {
  const models = { d1: "p/one", d2: "p/two", d3: "p/three", d4: "p/four", d5: "p/five" };
  const body = {
    version: "five",
    slots: {
      d1: { model: models.d1 },
      d2: { model: models.d2, effort: "inherit" },
      d3: { model: models.d3, effort: "high" },
      d4: { model: models.d4, effort: "off" },
      d5: { model: models.d5 },
    },
  };
  assert.deepEqual(validateSettings({ version: 2, presets: { base: body } }).presets.base, body);
  assert.equal(validateSettings({ version: 2, presets: { base: body } }).presets.base.slots.d1.effort, undefined);
  assert.equal(validateSettings({ version: 2, presets: { base: body } }).presets.base.slots.d1.thinking, undefined);
  assert.deepEqual(validateSettings({ version: 2, presets: { same: definition() } }).presets.same, definition());
  for (const slot of Object.keys(models)) {
    const missing = { ...body.slots };
    delete missing[slot];
    assert.throws(() => validateSettings({ version: 2, presets: { base: { ...body, slots: missing } } }), /all five slots/);
    const invalidModel = { ...body.slots, [slot]: { ...body.slots[slot], model: "not-a-provider-model" } };
    assert.throws(() => validateSettings({ version: 2, presets: { base: { ...body, slots: invalidModel } } }), /provider\/model/);
  }
});

test("five effort leaves retain independent null, absence and conflict behavior across save and reload", (t) => {
  const f = fixture(t);
  const levels = { d1: "low", d2: "medium", d3: "high", d4: "xhigh", d5: "max" };
  f.put("global", { version: 2, effort: { base: levels } });
  const store = f.store();
  for (const slot of Object.keys(levels)) {
    store.stage("workspace", ["effort", "base", slot], null);
    assert.equal(store.effective().effort.base[slot], null);
    store.stage("workspace", ["effort", "base", slot], undefined);
    assert.equal(store.effective().effort.base[slot], levels[slot]);
  }
  assert.deepEqual(store.pending(), []);
  for (const slot of Object.keys(levels)) store.stage("workspace", ["effort", "base", slot], null);
  assert.equal(store.pending().length, 5);
  assert(!store.flush()[0].error);
  const allNulls = { d1: null, d2: null, d3: null, d4: null, d5: null };
  assert.deepEqual(f.store().effective().effort.base, allNulls);
  const first = f.store(), second = f.store();
  first.stage("workspace", ["effort", "base", "d4"], undefined);
  second.stage("workspace", ["effort", "base", "d5"], "inherit");
  assert(!second.flush()[0].error);
  assert(!first.flush()[0].error);
  assert.deepEqual(f.store().effective().effort.base, { ...allNulls, d4: "xhigh", d5: "inherit" });
});

test("empty and slot-free version-2 preferences remain valid", () => {
  assert.deepEqual(validateSettings({ version: 2 }), { version: 2 });
  assert.deepEqual(validateSettings({ version: 2, preset: "off", approval: "manual", delegation: { mode: "manual" } }), {
    version: 2, preset: "off", approval: "manual", delegation: { mode: "manual" },
  });
  assert.deepEqual(validateSettings({ version: 2, effort: { base: {} }, presets: {} }), {
    version: 2, effort: { base: {} }, presets: {},
  });
});

test("retired flat, mixed, string, null, partial and extra slot shapes are rejected without migration", (t) => {
  const flat = {
    version: "v1",
    models: { d1: "fixture/model", d2: "fixture/model", d3: "fixture/model", d4: "fixture/model", d5: "fixture/model" },
    effort: { d1: "low" },
    thinking: { d3: { low: "medium" } },
  };
  const retired = /retired flat models\/effort\/thinking fields.*no automatic migration or mixed format/;
  for (const body of [
    flat,
    { version: "v1", models: flat.models },
    { ...definition(), models: flat.models },
    { ...definition(), effort: { d1: "low" } },
    { ...definition(), thinking: { d3: { low: "medium" } } },
  ]) assert.throws(() => validateSettings({ version: 2, presets: { base: body } }), retired);
  const slots = definition().slots;
  for (const body of [
    { version: "v1", slots: "d1" },
    { version: "v1", slots: null },
    { version: "v1", slots: { ...slots, d1: "fixture/model" } },
    { version: "v1", slots: { ...slots, d1: null } },
    { version: "v1", slots: { ...slots, d3: ["fixture/model"] } },
  ]) assert.throws(() => validateSettings({ version: 2, presets: { base: body } }), /plain record/);
  const partial = { ...slots };
  delete partial.d5;
  assert.throws(() => validateSettings({ version: 2, presets: { base: { version: "v1", slots: partial } } }), /all five slots/);
  assert.throws(() => validateSettings({ version: 2, presets: { base: { version: "v1" } } }), /preset slots are required/);
  assert.throws(() => validateSettings({ version: 2, presets: { base: {
    version: "v1", slots: { ...slots, d6: { model: "fixture/model" } },
  } } }), /unsupported field/);
  assert.throws(() => validateSettings({ version: 2, presets: { base: withSlot("d1", { id: "extra" }) } }), /unsupported field/);
  assert.throws(() => validateSettings({ version: 2, presets: { base: {
    version: "v1", slots: { ...slots, d1: { effort: "low" } },
  } } }), /model is required/);
  for (const slot of [
    { model: null }, { model: "fixture/model", effort: null }, { model: "fixture/model", effort: { d1: "low" } },
    { model: "fixture/model", thinking: null }, { model: "fixture/model", thinking: "low" },
  ]) assert.throws(() => validateSettings({ version: 2, presets: { base: {
    version: "v1", slots: { ...slots, d1: slot },
  } } }), /Invalid settings/);
  const f = fixture(t);
  f.put("global", { version: 2, presets: { base: flat } });
  const before = readFileSync(f.paths.global);
  assert.throws(() => f.store(), /retired flat/);
  assert.deepEqual(readFileSync(f.paths.global), before);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  assert.throws(() => store.stage("global", ["presets", "base"], flat), /retired flat/);
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["approval"], value: "judge" }]);
  f.put("global", { version: 2, presets: { base: flat } });
  const external = readFileSync(f.paths.global);
  assert.match(store.flush()[0].error, /retired flat/);
  assert.deepEqual(readFileSync(f.paths.global), external);
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("slot thinking is rejected without migration or rewrite", (t) => {
  const message = /thinking is not configurable.*no automatic migration/;
  const slots = definition().slots;
  for (const thinking of [{}, null, { low: "medium", off: "off" }, { off: "high" }, "low", { minimal: "low", max: "xhigh" }])
    assert.throws(() => validateSettings({ version: 2, presets: { base: {
      version: "v1", slots: { ...slots, d3: { model: "fixture/model", effort: "inherit", thinking } },
    } } }), message);
  let invoked = 0;
  const slot = { model: "fixture/model" };
  Object.defineProperty(slot, "thinking", { enumerable: true, get() { invoked++; return { low: "medium" }; } });
  const accessorBody = definition();
  accessorBody.slots.d1 = slot;
  assert.throws(() => validateSettings({ version: 2, presets: { base: accessorBody } }));
  assert.equal(invoked, 0);
  const stored = { version: 2, presets: { base: {
    version: "v1", slots: { ...slots, d3: { model: "fixture/model", thinking: { low: "medium" } } },
  } } };
  const f = fixture(t);
  f.put("global", stored);
  const before = readFileSync(f.paths.global);
  assert.throws(() => f.store(), /thinking is not configurable/);
  assert.deepEqual(readFileSync(f.paths.global), before);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  f.put("global", { version: 2, approval: "manual" });
  const store = f.store();
  store.stage("global", ["approval"], "judge");
  assert.throws(() => store.stage("global", ["presets", "base"], stored.presets.base), message);
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["approval"], value: "judge" }]);
  f.put("global", stored);
  const external = readFileSync(f.paths.global);
  assert.match(store.flush()[0].error, /thinking is not configurable/);
  assert.deepEqual(readFileSync(f.paths.global), external);
  assert.equal(store.pending().length, 1);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("whole preset definitions publish by name without merging slots", (t) => {
  const f = fixture(t);
  const first = withSlot("d1", { effort: "low" }, "v1", "fixture/one");
  f.put("global", { version: 2, presets: { base: first, other: definition("keep") } });
  const store = f.store();
  const next = withSlot("d5", { effort: "max" }, "v2", "fixture/two");
  store.stage("global", ["presets", "base"], next);
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["presets", "base"], value: next }]);
  assert(!store.flush()[0].error);
  const saved = read(f.paths.global);
  assert.deepEqual(saved.presets.base, next);
  assert.deepEqual(saved.presets.other, definition("keep"));
  assert.equal(saved.presets.base.slots.d1.effort, undefined);
  assert.equal(saved.presets.base.slots.d1.thinking, undefined);
  assert.deepEqual(f.store().get("global"), saved);
});

test("five-segment slot effort publishes; six-segment, unsafe and accessor paths do not", (t) => {
  const f = fixture(t);
  f.put("global", { version: 2, presets: { base: definition() } });
  const store = f.store();
  store.stage("global", ["presets", "base", "slots", "d1", "effort"], "low");
  assert.equal(store.pending()[0].path.length, 5);
  assert.deepEqual(store.pending(), [{
    scope: "global", path: ["presets", "base", "slots", "d1", "effort"], value: "low",
  }]);
  assert.equal(store.get("global").presets.base.slots.d1.effort, "low");
  assert.equal(store.get("global").presets.base.slots.d2.effort, undefined);
  assert(!store.flush()[0].error);
  assert.deepEqual(read(f.paths.global).presets.base.slots.d1, { model: "fixture/model", effort: "low" });
  assert.deepEqual(f.store().get("global").presets.base.slots.d1, { model: "fixture/model", effort: "low" });

  const again = f.store();
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1", "effort", "extra"], "high"), /1 to 5/);
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1", "thinking", "minimal"], "low"), /1 to 5/);
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1", "thinking"], {}), /thinking is not configurable/);
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1", "thinking"], null), /thinking is not configurable/);
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1", "__proto__"], "off"), /safe, bounded/);
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "__proto__", "effort"], "low"), /safe, bounded/);
  let invoked = 0;
  const accessorPath = [];
  for (const key of ["presets", "base", "slots", "d1", "effort"]) {
    Object.defineProperty(accessorPath, String(accessorPath.length), {
      enumerable: true, get() { invoked++; return key; },
    });
  }
  assert.throws(() => again.stage("global", accessorPath, "high"));
  const slot = { model: "fixture/model" };
  Object.defineProperty(slot, "effort", { enumerable: true, get() { invoked++; return "high"; } });
  assert.throws(() => again.stage("global", ["presets", "base", "slots", "d1"], slot));
  assert.equal(invoked, 0);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(again.pending(), []);
  assert.equal(read(f.paths.global).presets.base.slots.d1.effort, "low");
  assert.equal(read(f.paths.global).presets.base.slots.d1.thinking, undefined);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
});

test("nested slot patches persist, reload and conflict on the same leaf", (t) => {
  const f = fixture(t);
  const body = definition("v1", "fixture/model");
  body.slots.d1 = { model: "fixture/model", effort: "low" };
  body.slots.d3 = { model: "fixture/model", effort: "inherit" };
  f.put("global", { version: 2, presets: { base: body }, approval: "manual" });
  const store = f.store();
  store.stage("global", ["presets", "base", "slots", "d1", "effort"], "medium");
  store.stage("global", ["presets", "base", "slots", "d5", "model"], "fixture/other");
  store.stage("global", ["presets", "base", "slots", "d2", "effort"], "high");
  assert.equal(store.pending().length, 3);
  assert.equal(store.pending().every((patch) => patch.path.length <= 5), true);
  assert(!store.flush()[0].error);
  const saved = read(f.paths.global);
  assert.equal(saved.presets.base.slots.d1.effort, "medium");
  assert.equal(saved.presets.base.slots.d1.model, "fixture/model");
  assert.equal(saved.presets.base.slots.d5.model, "fixture/other");
  assert.equal(saved.presets.base.slots.d2.effort, "high");
  assert.equal(saved.presets.base.slots.d3.effort, "inherit");
  assert.equal(saved.presets.base.slots.d4.effort, undefined);
  assert.equal(saved.presets.base.slots.d1.thinking, undefined);
  assert.deepEqual(f.store().get("global"), saved);

  const unrelatedA = f.store(), unrelatedB = f.store();
  unrelatedA.stage("global", ["presets", "base", "slots", "d1", "model"], "fixture/changed");
  unrelatedB.stage("global", ["presets", "base", "slots", "d5", "effort"], "max");
  assert(!unrelatedB.flush()[0].error);
  assert(!unrelatedA.flush()[0].error);
  const reloaded = f.store().get("global").presets.base;
  assert.equal(reloaded.slots.d1.model, "fixture/changed");
  assert.equal(reloaded.slots.d1.effort, "medium");
  assert.equal(reloaded.slots.d5.effort, "max");
  assert.equal(reloaded.slots.d5.model, "fixture/other");

  const conflicted = f.store(), winner = f.store();
  conflicted.stage("global", ["presets", "base", "slots", "d1", "effort"], "max");
  conflicted.stage("global", ["presets", "base", "slots", "d4", "effort"], "low");
  winner.stage("global", ["presets", "base", "slots", "d1", "effort"], "off");
  assert(!winner.flush()[0].error);
  assert.match(conflicted.flush()[0].error, /conflict/);
  assert.equal(conflicted.pending().length, 2);
  assert.equal(read(f.paths.global).presets.base.slots.d1.effort, "off");
  assert.equal(read(f.paths.global).presets.base.slots.d4.effort, undefined);
  assert.deepEqual(ownArtifacts(f.paths.global), []);
  assert.match(conflicted.flush()[0].error, /conflict/, "retry cannot silently rebase a failed dirty leaf");
});

test("cross-bundle session registry cleanup is identity checked", async (t) => {
  const f = fixture(t), first = f.store(), second = f.store();
  const id = `settings-test-${f.root}`;
  const otherBundle = await import(`../lib/settings-store.mjs?registry-test=${encodeURIComponent(id)}`);
  assert.equal(settingsStoreForSession(id), undefined);
  const cleanFirst = registerSettingsStore(id, first);
  assert.equal(otherBundle.settingsStoreForSession(id), first);
  const cleanSecond = otherBundle.registerSettingsStore(id, second);
  cleanFirst();
  assert.equal(settingsStoreForSession(id), second);
  cleanSecond();
  cleanSecond();
  assert.equal(settingsStoreForSession(id), undefined);
});
