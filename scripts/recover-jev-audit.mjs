#!/usr/bin/env node
// Operator-only, offline recovery. Intentionally self-contained ordinary ESM:
// installed Node cannot strip TS in node_modules and production has no Jiti.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, rmdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = info => info.uid === process.getuid?.();
const reject = message => { throw new Error(message); };
function at(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function safeDirectory(path) {
  let current = path, child;
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory()) reject("unsafe_directory");
    if (!owned(info) && info.uid !== 0) reject("untrusted_directory_owner");
    if ((info.mode & 0o022) && (!(info.mode & 0o1000) || !child || !owned(child))) reject("unsafe_directory");
    if (current === path && (!owned(info) || (info.mode & 0o022))) reject("unsafe_directory");
    const parent = dirname(current);
    if (parent === current) return;
    child = info; current = parent;
  }
}
function regular(path, info, allowDoubleLink = false) {
  if (!info?.isFile() || !owned(info) || (info.mode & 0o077) ||
      (info.nlink !== 1 && !(allowDoubleLink && info.nlink === 2))) reject(`unsafe_artifact:${basename(path)}`);
}
function inspectActive(path) {
  const info = at(path);
  if (!info) return { kind: "missing" };
  regular(path, info, true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(info, fstatSync(fd))) reject("changed_active");
    let terminated = true;
    if (info.size) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, info.size - 1) !== 1) reject("tail_read_failed");
      terminated = tail[0] === 0x0a;
    }
    if (!same(info, lstatSync(path)) || fstatSync(fd).size !== info.size) reject("changed_active");
    return { kind: info.nlink === 2 ? "legacy_hardlinks" : terminated ? "healthy" : "incomplete_tail", info, terminated };
  } finally { closeSync(fd); }
}
function run() {
  const args = process.argv.slice(2), values = {}, switches = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (["--apply", "--confirm-writers-stopped", "--help"].includes(name)) {
      if (switches.has(name)) reject("duplicate_option");
      switches.add(name);
    } else if (["--log", "--flock"].includes(name) && args[i + 1] && !args[i + 1].startsWith("--")) {
      if (values[name]) reject("duplicate_option");
      values[name] = args[++i];
    } else reject("unknown_or_missing_option");
  }
  if (switches.has("--help")) return { usage: "node scripts/recover-jev-audit.mjs --log ABSOLUTE_PATH [--flock VERIFIED_ABSOLUTE_FLOCK] [--apply --confirm-writers-stopped]", default: "dry-run" };
  if (process.platform !== "linux") reject("unsupported_platform");
  const log = values["--log"];
  if (!log || !isAbsolute(log) || resolve(log) !== log || log.includes("\0")) reject("absolute_normalized_log_required");
  if (basename(log) !== "jev-auto-approval.jsonl") reject("jev_audit_basename_required");
  const apply = switches.has("--apply");
  if (apply && !switches.has("--confirm-writers-stopped")) reject("apply_requires_confirm_writers_stopped");
  const directory = dirname(log), base = basename(log);
  // For a symlink layout, explicitly pass its canonical log path. Recovery
  // does not silently follow a changed link or widen the runtime's floor.
  if (realpathSync(directory) !== directory) reject("use_explicit_canonical_log_path");
  safeDirectory(directory);
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let lockFd, archiveFd, containerFd;
  const identity = fstatSync(directoryFd), anchored = `/proc/self/fd/${directoryFd}`;
  const activePath = join(anchored, base), lockPath = join(anchored, `.${base}.lock`);
  const archivesPath = join(anchored, `${base}.archives`);
  const unchangedDirectory = () => {
    if (realpathSync(directory) !== directory || !same(identity, lstatSync(directory))) reject("changed_directory");
    safeDirectory(directory);
  };
  try {
    unchangedDirectory();
    const lock = at(lockPath);
    let lockKind = "missing";
    if (lock?.isDirectory()) {
      if (!owned(lock) || (lock.mode & 0o777) !== 0o700 || readdirSync(lockPath).length) reject("unsafe_legacy_lock");
      lockKind = "legacy_directory";
    } else if (lock) { regular(lockPath, lock); lockKind = "kernel_file"; }
    let active = inspectActive(activePath), counterpart;
    if (active.kind === "legacy_hardlinks") {
      // Only recognize the old writer's exact archive-name family and exactly
      // one same-inode partner. Never remove that archive or scan recursively.
      const names = readdirSync(anchored);
      if (names.length > 4096) reject("offline_inventory_limit");
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped}\\.[0-9]+\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.archive$`, "i");
      const matches = names.filter(name => pattern.test(name)).filter(name => {
        const info = lstatSync(join(anchored, name));
        return info.isFile() && owned(info) && same(info, active.info);
      });
      if (matches.length !== 1) reject("unrecognized_legacy_hardlinks");
      counterpart = matches[0];
    }
    const planned = [
      ...(lockKind === "legacy_directory" ? ["replace_verified_empty_legacy_lock_with_persistent_kernel_file"] : lockKind === "missing" ? ["create_persistent_kernel_lock_file"] : []),
      ...(["legacy_hardlinks", "incomplete_tail"].includes(active.kind) ? ["preserve_active_in_exclusive_archive_container", "create_empty_private_active"] : []),
    ];
    const report = { mode: apply ? "apply" : "dry-run", lock: lockKind, active: active.kind,
      ...(counterpart ? { retainedLegacyArchive: counterpart } : {}), planned,
      auditGapRepaired: false, atomicRecovery: false,
      warning: "Stop ALL Pi writers sharing this agentDir before upgrade, rollback or recovery, including the original unlocked appendFileSync writer. Shutdown is an operator assertion, not PID/TTL proof. Recovery is not atomic; a failed apply may retain lock/archive artifacts. It does not repair missing audit records or grant approval." };
    if (!apply) return report;
    const requested = values["--flock"] ?? process.env.PI_HARNESS_FLOCK;
    if (!requested || !isAbsolute(requested)) reject("verified_absolute_flock_required");
    const flock = realpathSync(requested);
    // The intermediate mkdir protocol shares this path; the original HEAD
    // appendFileSync writer has no lock at all. Both upgrade and rollback need
    // ALL shared-agentDir writers stopped. No PID/TTL reclaim or alternate lock.
    if (lockKind === "legacy_directory") {
      if (!same(lock, lstatSync(lockPath)) || readdirSync(lockPath).length) reject("changed_legacy_lock");
      unchangedDirectory(); rmdirSync(lockPath);
    }
    lockFd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (lockKind === "kernel_file" ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    const lockInfo = fstatSync(lockFd);
    regular(lockPath, lockInfo);
    if (!same(lockInfo, lstatSync(lockPath))) reject("changed_kernel_lock");
    const held = spawnSync(flock, ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "pipe", "pipe", lockFd], timeout: 2000, killSignal: "SIGKILL",
    });
    if (held.error || held.status !== 0) reject(held.status === 1 ? "writers_not_stopped_lock_busy" : "lock_unavailable");
    const contender = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const probe = spawnSync(flock, ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", contender], timeout: 2000, killSignal: "SIGKILL",
      });
      if (probe.error || probe.status !== 1) reject("lock_not_confirmed");
    } finally { closeSync(contender); }
    unchangedDirectory();
    const now = inspectActive(activePath);
    if (now.kind !== active.kind || (active.info && (!same(now.info, active.info) || now.info.size !== active.info.size))) reject("changed_active");
    active = now;
    if (["legacy_hardlinks", "incomplete_tail"].includes(active.kind)) {
      if (counterpart && !same(active.info, lstatSync(join(anchored, counterpart)))) reject("changed_legacy_archive");
      try { mkdirSync(archivesPath, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const archives = lstatSync(archivesPath);
      if (!archives.isDirectory() || !owned(archives) || (archives.mode & 0o777) !== 0o700) reject("unsafe_archives_directory");
      archiveFd = openSync(archivesPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!same(archives, fstatSync(archiveFd))) reject("changed_archives_directory");
      const containerName = `${Date.now()}.${randomUUID()}`;
      const containerPath = join(`/proc/self/fd/${archiveFd}`, containerName);
      mkdirSync(containerPath, { mode: 0o700 });
      containerFd = openSync(containerPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const container = fstatSync(containerFd);
      if (!container.isDirectory() || !owned(container) || (container.mode & 0o777) !== 0o700 || !same(container, lstatSync(containerPath))) reject("unsafe_archive_container");
      const slot = join(`/proc/self/fd/${containerFd}`, "audit.jsonl");
      if (at(slot)) reject("archive_slot_exists");
      unchangedDirectory();
      renameSync(activePath, slot); // Preserve bytes and every legacy archive.
      if (!same(active.info, lstatSync(slot))) reject("changed_preserved_evidence");
      const fresh = openSync(activePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { regular(activePath, fstatSync(fresh)); } finally { closeSync(fresh); }
      report.preservedEvidence = `${base}.archives/${containerName}/audit.jsonl`;
    }
    unchangedDirectory();
    if (!same(lockInfo, lstatSync(lockPath))) reject("changed_kernel_lock");
    return { ...report, applied: planned, status: planned.length ? "recovered_requires_fresh_runtime_validation" : "healthy" };
  } finally {
    // A close failure is an error, not a successful recovery report.
    let failure;
    for (const fd of [containerFd, archiveFd, directoryFd, lockFd]) {
      if (fd !== undefined) try { closeSync(fd); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
try { console.log(JSON.stringify(run())); }
catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : "recovery_failed",
    atomicRecovery: false, appliedMayBePartial: process.argv.includes("--apply"),
    warning: error instanceof Error && error.message === "untrusted_directory_owner"
      ? "A log directory ancestor's owner is not trusted in the current namespace. Unmapped root may appear as an overflow UID/nobody; check UID/GID mappings. The UID value alone does not establish a namespace cause. This is not a bad lockfile; offline audit recovery or retry cannot fix the ownership/mapping boundary."
      : "A failed apply may retain lock/archive artifacts; inspect them before another explicitly authorized recovery. No audit gap was repaired." }));
  process.exitCode = 1;
}
