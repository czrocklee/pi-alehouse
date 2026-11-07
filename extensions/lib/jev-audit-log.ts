import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_ACTIVE_AUDIT_BYTES = 1_048_576;
export type JevAuditFailureReason =
  | "invalid_input"
  | "unsupported_platform"
  | "unsafe_directory"
  | "untrusted_directory_owner"
  | "directory_changed"
  | "symlink_target_unprotected"
  | "legacy_lock_requires_offline_recovery"
  | "unsafe_lock"
  | "lock_busy"
  | "lock_unavailable"
  | "lock_not_confirmed"
  | "validation_failed"
  | "unsafe_active"
  | "legacy_hardlinks_require_offline_recovery"
  | "incomplete_tail_requires_offline_recovery"
  | "archive_unavailable"
  | "audit_io_failed"
  | "cleanup_failed";
export type JevAuditResult = { ok: true } | { ok: false; reason: JevAuditFailureReason };
export interface JevAuditOptions {
  maxBytes?: number;
  /** Launcher-verified absolute util-linux executable; never searched on PATH. */
  flock?: string;
  /** Kernel contention wait only, not a hard filesystem/handshake deadline. */
  lockWaitMs?: number;
  /** Startup-fixed canonical logs directory. A later retarget is rejected. */
  expectedDirectory?: string;
  /** Trusted immutable floor aliases, not model/config permission rules. */
  protectedWriteRoots?: readonly string[];
  protectedWriteFiles?: readonly string[];
  /** Called synchronously after lock acquisition/wait, before rename/write.
   * A Promise or anything other than literal true fails closed. */
  beforeWrite?: () => boolean;
}

class AuditFailure extends Error {
  constructor(readonly reason: JevAuditFailureReason) {
    super(reason);
  }
}
function fail(reason: JevAuditFailureReason): never {
  throw new AuditFailure(reason);
}
const owned = (info: Stats): boolean => info.uid === process.getuid?.();
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
const absent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Ordinary Linux/POSIX ownership boundary. Root is trusted. A sticky shared
 * ancestor (e.g. /tmp) is accepted only when its immediate child is ours; an
 * ordinary group/world-writable parent is never accepted. No ACL/OS sandbox
 * or hostile-same-uid guarantee is claimed. */
function safeAncestors(canonical: string): void {
  let path = canonical,
    child: Stats | undefined;
  for (;;) {
    const info = lstatSync(path);
    if (!info.isDirectory()) fail("unsafe_directory");
    if (!owned(info) && info.uid !== 0) fail("untrusted_directory_owner");
    if (info.mode & 0o022) {
      if (!(info.mode & 0o1000) || !child || !owned(child)) fail("unsafe_directory");
    }
    if (path === canonical && (!owned(info) || info.mode & 0o022)) fail("unsafe_directory");
    const parent = dirname(path);
    if (parent === path) break;
    child = info;
    path = parent;
  }
}
function protectedTarget(canonical: string, base: string, options: JevAuditOptions): boolean {
  const roots = options.protectedWriteRoots ?? [],
    files = options.protectedWriteFiles ?? [];
  for (const path of [...roots, ...files]) {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
      fail("invalid_input");
  }
  const file = (path: string) => files.includes(path) || roots.some((root) => within(path, root));
  return (
    file(join(canonical, base)) &&
    file(join(canonical, `.${base}.lock`)) &&
    roots.some((root) => within(join(canonical, `${base}.archives`), root))
  );
}
function checkedFile(fd: number, path: string, reason: "unsafe_lock" | "unsafe_active"): Stats {
  const info = fstatSync(fd),
    named = lstatSync(path);
  if (!info.isFile() || !named.isFile() || !owned(info) || !same(info, named)) fail(reason);
  if (info.nlink !== 1)
    fail(reason === "unsafe_active" ? "legacy_hardlinks_require_offline_recovery" : reason);
  fchmodSync(fd, 0o600);
  return info;
}
function privateDirectory(path: string): number {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd),
      named = lstatSync(path);
    if (!info.isDirectory() || !owned(info) || (info.mode & 0o777) !== 0o700 || !same(info, named))
      fail("archive_unavailable");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Synchronous, confirmed audit only. The persistent REGULAR .lock shares this
 * change's intermediate mkdir writer's pathname; those two protocols refuse
 * each other's artifact. HEAD's original appendFileSync writer has NO lock and
 * ignores this marker. Upgrade AND rollback require stopping every old Pi that
 * shares the agentDir. Never unlink a kernel lock inode. Linux flock is attached to the retained
 * open-file-description; only a short-lived verified child inherits that FD.
 * Between new-protocol writers, death releases the kernel lock, NOT legacy
 * hardlinks or incomplete JSONL (those require explicit offline recovery).
 * Archives use fresh private containers and rename, never link/unlink or an
 * overwriteable public destination. Success is not fsync/crash durability. */
export function appendJevAuditDetailed(
  logPath: string,
  details: Record<string, unknown>,
  options: JevAuditOptions = {},
): JevAuditResult {
  let directoryFd: number | undefined, lockFd: number | undefined, activeFd: number | undefined;
  let archiveFd: number | undefined, containerFd: number | undefined;
  let result: JevAuditResult = { ok: false, reason: "audit_io_failed" };
  let checkDirectory: (() => void) | undefined;
  try {
    if (process.platform !== "linux") fail("unsupported_platform");
    const maxBytes = options.maxBytes ?? MAX_ACTIVE_AUDIT_BYTES,
      waitMs = options.lockWaitMs ?? 25;
    if (
      !isAbsolute(logPath) ||
      resolve(logPath) !== logPath ||
      logPath.includes("\0") ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 1000
    )
      fail("invalid_input");
    const line = Buffer.from(`${JSON.stringify(details)}\n`, "utf8");
    if (line.length > maxBytes) fail("invalid_input");
    const directory = dirname(logPath),
      base = basename(logPath);
    // Validate the existing ancestor before creating an absent logs directory.
    let ancestor = directory;
    while (!absent(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) fail("unsafe_directory");
      ancestor = parent;
    }
    // The final directory must be ours; existing shared ancestors are checked
    // again against the fully resolved chain after creation.
    safeAncestors(realpathSync(ancestor));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(directory);
    if (
      options.expectedDirectory !== undefined &&
      (!isAbsolute(options.expectedDirectory) ||
        resolve(options.expectedDirectory) !== options.expectedDirectory ||
        canonical !== options.expectedDirectory)
    )
      fail("directory_changed");
    safeAncestors(canonical);
    if (
      canonical !== directory &&
      (options.expectedDirectory === undefined || !protectedTarget(canonical, base, options))
    )
      fail("symlink_target_unprotected");
    directoryFd = openSync(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = fstatSync(directoryFd);
    checkDirectory = () => {
      if (
        realpathSync(directory) !== canonical ||
        !same(identity, lstatSync(canonical)) ||
        !same(identity, fstatSync(directoryFd!))
      )
        fail("directory_changed");
      safeAncestors(canonical);
    };
    checkDirectory();
    const anchored = `/proc/self/fd/${directoryFd}`,
      activePath = join(anchored, base),
      lockPath = join(anchored, `.${base}.lock`);
    const priorLock = absent(lockPath);
    if (priorLock?.isDirectory()) fail("legacy_lock_requires_offline_recovery");
    if (priorLock && (!priorLock.isFile() || !owned(priorLock) || priorLock.nlink !== 1))
      fail("unsafe_lock");
    lockFd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    checkedFile(lockFd, lockPath, "unsafe_lock");
    const requestedFlock = options.flock ?? process.env.PI_HARNESS_FLOCK;
    if (!requestedFlock || !isAbsolute(requestedFlock)) fail("lock_unavailable");
    let flock: string;
    try {
      flock = realpathSync(requestedFlock);
    } catch {
      fail("lock_unavailable");
    }
    const args =
      waitMs === 0
        ? ["--exclusive", "--nonblock", "3"]
        : ["--exclusive", "--wait", (waitMs / 1000).toFixed(3), "3"];
    const held = spawnSync(flock!, args, {
      stdio: ["ignore", "pipe", "pipe", lockFd],
      timeout: waitMs + 2000,
      killSignal: "SIGKILL",
    });
    if (held.error || held.status !== 0) fail(held.status === 1 ? "lock_busy" : "lock_unavailable");
    checkedFile(lockFd, lockPath, "unsafe_lock");
    // An independently opened OFD must contend. A noop returning zero is not
    // evidence that the first child actually locked anything.
    const contenderFd = openSync(
      lockPath,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      checkedFile(contenderFd, lockPath, "unsafe_lock");
      const contender = spawnSync(flock!, ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", contenderFd],
        timeout: 2000,
        killSignal: "SIGKILL",
      });
      if (contender.error || contender.status !== 1) fail("lock_not_confirmed");
    } finally {
      closeSync(contenderFd);
    }
    checkDirectory();
    checkedFile(lockFd, lockPath, "unsafe_lock");
    try {
      activeFd = openSync(
        activePath,
        constants.O_RDWR |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          constants.O_CREAT,
        0o600,
      );
    } catch {
      fail("unsafe_active");
    }
    let info = checkedFile(activeFd!, activePath, "unsafe_active");
    if (info.size > 0) {
      const tail = Buffer.alloc(1);
      if (readSync(activeFd, tail, 0, 1, info.size - 1) !== 1 || tail[0] !== 0x0a)
        fail("incomplete_tail_requires_offline_recovery");
      if (checkedFile(activeFd, activePath, "unsafe_active").size !== info.size)
        fail("unsafe_active");
    }
    if (options.beforeWrite) {
      let valid: unknown;
      try {
        valid = options.beforeWrite();
      } catch {
        fail("validation_failed");
      }
      if (valid !== true) {
        // Reject async validators without leaking their rejected Promise.
        try {
          void Promise.resolve(valid).catch(() => {});
        } catch {
          /* Still invalid. */
        }
        fail("validation_failed");
      }
    }
    checkDirectory();
    checkedFile(lockFd, lockPath, "unsafe_lock");
    if (checkedFile(activeFd, activePath, "unsafe_active").size !== info.size)
      fail("unsafe_active");
    if (info.size > 0 && info.size + line.length > maxBytes) {
      try {
        const archivesPath = join(anchored, `${base}.archives`);
        archiveFd = privateDirectory(archivesPath);
        const archiveIdentity = fstatSync(archiveFd);
        const containerPath = join(`/proc/self/fd/${archiveFd}`, `${Date.now()}.${randomUUID()}`);
        mkdirSync(containerPath, { mode: 0o700 }); // Exclusive, never reuse a container.
        containerFd = openSync(
          containerPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const container = fstatSync(containerFd);
        if (
          !owned(container) ||
          !container.isDirectory() ||
          (container.mode & 0o777) !== 0o700 ||
          !same(container, lstatSync(containerPath))
        )
          fail("archive_unavailable");
        const slot = join(`/proc/self/fd/${containerFd}`, "audit.jsonl");
        if (absent(slot) || !same(archiveIdentity, lstatSync(archivesPath)))
          fail("archive_unavailable");
        renameSync(activePath, slot);
        if (
          !same(info, checkedFile(activeFd, slot, "unsafe_active")) ||
          fstatSync(activeFd).size !== info.size
        )
          fail("archive_unavailable");
        const old = activeFd;
        activeFd = undefined;
        closeSync(old);
        activeFd = openSync(
          activePath,
          constants.O_RDWR |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            constants.O_CREAT |
            constants.O_EXCL,
          0o600,
        );
        info = checkedFile(activeFd, activePath, "unsafe_active");
      } catch (error) {
        if (error instanceof AuditFailure) throw error;
        fail("archive_unavailable");
      }
    }
    let offset = 0;
    while (offset < line.length) {
      const written = writeSync(activeFd, line, offset, line.length - offset);
      if (written <= 0) fail("audit_io_failed");
      offset += written;
    }
    if (checkedFile(activeFd, activePath, "unsafe_active").size !== info.size + line.length)
      fail("unsafe_active");
    checkedFile(lockFd, lockPath, "unsafe_lock");
    checkDirectory();
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      reason: error instanceof AuditFailure ? error.reason : "audit_io_failed",
    };
  } finally {
    try {
      checkDirectory?.();
    } catch {
      result = { ok: false, reason: "directory_changed" };
    }
    // Close the kernel-lock OFD last; no lock path is ever removed.
    for (const fd of [activeFd, containerFd, archiveFd, directoryFd, lockFd]) {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {
          result = { ok: false, reason: "cleanup_failed" };
        }
    }
  }
  return result;
}

/** Compatibility wrapper for existing boolean callers. */
export function appendJevAudit(
  logPath: string,
  details: Record<string, unknown>,
  maxBytes = MAX_ACTIVE_AUDIT_BYTES,
  options: Omit<JevAuditOptions, "maxBytes"> = {},
): boolean {
  return appendJevAuditDetailed(logPath, details, { ...options, maxBytes }).ok;
}
