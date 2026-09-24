import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLeaseLock as OwnerLock } from "../../dist/runtime/owner-lease.js";

import { flock, resolveTestFlock } from "../support/flock.mjs";

test("lease fixtures honor canonical and legacy overrides without PATH discovery", () => {
  assert.equal(resolveTestFlock({ HARNESS_FLOCK: "/trusted/current/flock", P0_FLOCK: "/trusted/legacy/flock" }), "/trusted/current/flock");
  assert.equal(resolveTestFlock({ P0_FLOCK: "/trusted/legacy/flock" }), "/trusted/legacy/flock");
  assert.equal(resolveTestFlock({ PATH: "/project/bin" }, (path) => path === "/usr/bin/flock"), "/usr/bin/flock");
  assert.equal(resolveTestFlock({ PATH: "/project/bin" }, (path) => path === "/run/current-system/sw/bin/flock"), "/run/current-system/sw/bin/flock");
  assert.throws(() => resolveTestFlock({ PATH: "/project/bin" }, () => false), /Install util-linux/);
  assert.throws(() => resolveTestFlock({ HARNESS_FLOCK: "flock" }), /ABSOLUTE_PATH_REQUIRED/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-lock-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const compete = (path) => spawnSync(flock, ["--nonblock", path, process.execPath, "-e", ""], { timeout: 2000 }).status;

test("H11 short-lived flock exits; owner fd retains lock until closed", (t) => {
  const dir = fixture(t);
  const lock = new OwnerLock(dir, flock);
  t.after(() => lock.close());
  const inode = lstatSync(lock.path).ino;
  // Linux /proc reports the descriptor CLOEXEC bit. Node/libuv supplies it;
  // constants.O_CLOEXEC need not be exposed. Test the actual owner descriptor,
  // not just Node spawn's separate close-extra-fds behavior.
  const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${lock.fd}`, "utf8"));
  assert(flags); assert.notEqual(Number.parseInt(flags[1], 8) & 0o2000000, 0, "owner descriptor lacks CLOEXEC");
  writeFileSync(join(dir, "manifest.json"), "original");
  assert.equal(compete(lock.path), 1);
  assert.throws(() => new OwnerLock(dir, flock), /OWNER_LOCKED/);
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), "original");
  const output = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const lock = fs.statSync(process.argv[1]);
    for (const fd of fs.readdirSync('/proc/self/fd')) {
      try { const st = fs.statSync('/proc/self/fd/' + fd);
        if (st.ino === lock.ino && st.dev === lock.dev) process.exit(1);
      } catch {}
    }
  `, lock.path], { timeout: 2000 });
  assert.equal(output.status, 0, "ordinary child inherited lock fd");
  lock.close(); lock.close();
  assert.throws(() => lock.assertHeld(), /OWNER_LOCK_CLOSED/);
  assert.equal(lstatSync(lock.path).ino, inode);
  assert.equal(compete(lock.path), 0);
  const next = new OwnerLock(dir, flock);
  assert.notEqual(next.generation, lock.generation);
  next.close();
});

test("H11 killed owner releases lock (no long-lived holding helper)", { timeout: 5000 }, async (t) => {
  const dir = fixture(t);
  const url = new URL("../../dist/runtime/owner-lease.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { FileLeaseLock } from ${JSON.stringify(url)};
    const lock = new FileLeaseLock(process.argv[1], ${JSON.stringify(flock)});
    process.send({ ready: true });
    setInterval(() => lock.assertHeld(), 1000);
  `, dir], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "message");
  assert.equal(compete(join(dir, "owner.lock")), 1);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(compete(join(dir, "owner.lock")), 0);
});

test("H11 handshake failures, inode drift and symlink fail closed", (t) => {
  const dir = fixture(t);
  assert.throws(() => new OwnerLock(dir, join(dir, "missing-flock")), /LOCK_HANDSHAKE_FAILED/);
  const helper = join(dir, "timeout-flock");
  writeFileSync(helper, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  assert.throws(() => new OwnerLock(dir, helper, 50), /LOCK_HANDSHAKE_FAILED/);
  writeFileSync(helper, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  assert.throws(() => new OwnerLock(dir, helper), /LOCK_NOT_CONFIRMED/);
  assert.throws(() => new OwnerLock(dir, "flock"), /FLOCK_ABSOLUTE_PATH_REQUIRED/);
  const lock = new OwnerLock(dir, flock);
  t.after(() => lock.close());
  renameSync(lock.path, join(dir, "old-lock"));
  writeFileSync(lock.path, "replacement");
  assert.throws(() => lock.assertHeld(), /LOCK_INODE_CHANGED/);
  lock.close();
  rmSync(lock.path);
  symlinkSync(join(dir, "old-lock"), lock.path);
  assert.throws(() => new OwnerLock(dir, flock));
  chmodSync(dir, 0o755);
  assert.throws(() => new OwnerLock(dir, flock), /OWNER_DIRECTORY_MUST_BE_PRIVATE/);
});
