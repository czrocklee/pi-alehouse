import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { isId } from "../core/result-text.js";
import { HarnessError, type OwnerLease } from "../core/ports.js";

/** Linux/local-filesystem primitive, NOT proof that detached descendants exited. */
export class FileLeaseLock {
  readonly generation = randomUUID();
  readonly path: string;
  private fd: number | undefined;

  constructor(directory: string, flock: string, timeoutMs = 2_000) {
    if (process.platform !== "linux") throw new Error("UNSUPPORTED_LOCK_PLATFORM");
    // Trusted host input, never a model parameter. Deployment must supply the
    // Nix-pinned executable; do not resolve a command from a project's PATH.
    if (!isAbsolute(flock)) throw new Error("FLOCK_ABSOLUTE_PATH_REQUIRED");
    try { flock = realpathSync(flock); } catch (cause) {
      throw new Error("LOCK_HANDSHAKE_FAILED", { cause });
    }
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.()) {
      throw new Error("OWNER_DIRECTORY_MUST_BE_PRIVATE");
    }
    this.path = join(directory, "owner.lock");
    this.fd = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const file = fstatSync(this.fd);
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.()) {
        throw new Error("INVALID_LOCK_FILE");
      }
      fchmodSync(this.fd, 0o600);
      // Only this short-lived child receives the fd. Pi retains the same open
      // file description after flock exits. Do NOT use a long-lived lock helper.
      const result = spawnSync(flock, ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "pipe", "pipe", this.fd],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      if (result.error || result.status !== 0) {
        throw new Error(result.status === 1 ? "OWNER_LOCKED" : "LOCK_HANDSHAKE_FAILED", {
          cause: result.error ?? result.stderr?.toString(),
        });
      }
      this.assertHeld();
      // A no-op/broken wrapper returning zero is not proof of a held lock.
      // Reopen independently (without passing our fd): the trusted flock must
      // report contention. This diagnoses accidents, not malicious binaries.
      const contender = spawnSync(flock, ["--exclusive", "--nonblock", this.path, process.execPath, "-e", ""], {
        stdio: ["ignore", "ignore", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL",
      });
      if (contender.error || contender.status !== 1) throw new Error("LOCK_NOT_CONFIRMED");
      this.assertHeld();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Call before accepting work; never replace the inode. */
  assertHeld(): void {
    if (this.fd === undefined) throw new Error("OWNER_LOCK_CLOSED");
    const actual = fstatSync(this.fd);
    const named = lstatSync(this.path);
    if (!named.isFile() || actual.dev !== named.dev || actual.ino !== named.ino || actual.nlink !== 1) {
      throw new Error("LOCK_INODE_CHANGED");
    }
  }

  /** Caller must first establish controlled execution exit AND finalization. */
  close(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    closeSync(fd);
    // Deliberately never unlink/rename/truncate the lock file, including cleanup.
  }
}

/** A stable per-parent execution lock, not a second history store.
 * Deriving the directory from owner_id replaces the old owner.json binding.
 */
export class FileOwnerLease extends FileLeaseLock implements OwnerLease {
  private constructor(directory: string, readonly owner_id: string, flock: string) { super(directory, flock); }
  static async open(options: { directory: string; owner_id: string; flock: string }): Promise<FileOwnerLease> {
    if (!isId(options.owner_id)) throw new HarnessError("INVALID_OWNER_ID");
    const directory = join(options.directory, options.owner_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new FileOwnerLease(directory, options.owner_id, options.flock);
  }
}
