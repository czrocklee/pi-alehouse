// Filesystem notifications are hints only. Existing poll, wire readers,
// requester checks, liveness windows and permission resolution remain authority.
import { statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PermissionWatchFailure = "missing" | "resource" | "unsupported" | "other";
export interface PermissionDirectoryWatch {
  readonly active: boolean;
  readonly failure: PermissionWatchFailure | undefined;
  /** Poll-driven registration retry; never changes the caller's poll cadence. */
  refresh(): void;
  close(): void;
}
interface DirectoryIdentity { path: string; dev: number; ino: number }
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;
const IDENTITY_PROBE_MS = 1000;

function failureKind(error: unknown): PermissionWatchFailure {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "ENOSPC" || code === "EMFILE" || code === "ENFILE") return "resource";
  if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" ||
      code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") return "unsupported";
  return "other";
}
function identity(path: string): DirectoryIdentity | undefined {
  try {
    const info = statSync(path);
    return info.isDirectory() ? { path, dev: info.dev, ino: info.ino } : undefined;
  } catch (error) {
    if (failureKind(error) !== "missing") throw error;
    return undefined;
  }
}
function sameDirectory(a: DirectoryIdentity | undefined, b: DirectoryIdentity | undefined): boolean {
  return a?.path === b?.path && a?.dev === b?.dev && a?.ino === b?.ino;
}

/** Watch an existing directory, or its closest existing ancestor no higher
 * than boundary. Never create directories. Only missing paths permit walking
 * ancestors; a resource/unsupported watch error backs off the whole observer,
 * rather than repeating the same failing registration at every ancestor.
 * Retry deadlines are monotonic and poll-driven: no extra retry timers survive
 * close, and inactive observers must be retained by their callers. */
export function watchPermissionDirectory(directory: string, changed: () => void, boundary = directory): PermissionDirectoryWatch {
  let watcher: FSWatcher | undefined;
  let active = false;
  let closed = false;
  let failure: PermissionWatchFailure | undefined;
  let failures = 0;
  let retryAt = 0;
  let nextProbeAt = 0;
  let installedAt = 0;
  let probe: { path: string; identity: DirectoryIdentity | undefined } | undefined;
  directory = resolve(directory);
  const root = resolve(boundary);
  const tail = relative(root, directory);
  const contained = tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
  const candidates = [directory];
  if (contained) {
    let path = directory;
    while (path !== root && candidates.length < 16) {
      const parent = dirname(path);
      if (parent === path) break;
      candidates.push(parent); path = parent;
    }
  }
  const locate = () => {
    for (const path of candidates) {
      const found = identity(path);
      if (found) return found;
    }
    return undefined;
  };
  const detach = () => {
    active = false;
    const previous = watcher;
    watcher = undefined;
    try { previous?.close(); } catch { /* Polling is independent. */ }
  };
  const reset = () => { failures = 0; retryAt = 0; nextProbeAt = 0; probe = undefined; failure = undefined; };
  const defer = (error: unknown, observed: DirectoryIdentity | undefined) => {
    failure = failureKind(error);
    failures = Math.min(failures + 1, 6);
    const delay = failure === "unsupported" ? RETRY_MAX_MS : Math.min(RETRY_INITIAL_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    const now = performance.now();
    retryAt = now + delay;
    nextProbeAt = now + IDENTITY_PROBE_MS;
    probe = { path: observed?.path ?? candidates[candidates.length - 1]!, identity: observed };
  };
  const attach = () => {
    if (closed || active) return;
    let observed: DirectoryIdentity | undefined;
    try {
      observed = locate();
      if (!observed) { defer({ code: "ENOENT" }, undefined); return; }
      const selected = observed;
      const installed = watch(selected.path, { persistent: false }, () => {
        if (watcher !== installed || closed) return;
        try {
          if (!sameDirectory(locate(), selected)) {
            detach(); reset(); attach();
          }
        } catch (error) { detach(); defer(error, selected); }
        changed();
      });
      watcher = installed; active = true; installedAt = performance.now();
      failure = undefined; retryAt = 0; nextProbeAt = installedAt + IDENTITY_PROBE_MS;
      probe = { path: selected.path, identity: selected };
      // Do not reset consecutive failures on registration alone: a watcher
      // that emits ENOSPC immediately must also reach the bounded backoff.
      installed.on("error", error => {
        if (watcher !== installed) return;
        if (performance.now() - installedAt >= RETRY_MAX_MS) failures = 0;
        detach(); defer(error, selected);
      });
      installed.on("close", () => {
        if (watcher !== installed) return;
        watcher = undefined; active = false;
        defer(undefined, selected);
      });
    } catch (error) { detach(); defer(error, observed); }
  };
  const refresh = () => {
    if (closed) return;
    const now = performance.now();
    if (active) {
      if (now - installedAt >= RETRY_MAX_MS) failures = 0;
      if (now >= nextProbeAt) {
        nextProbeAt = now + IDENTITY_PROBE_MS;
        try {
          // Recover from a missed rename/creation event without rebuilding an
          // unchanged active subscription. This still stays within candidates.
          if (!sameDirectory(locate(), probe?.identity)) { detach(); reset(); attach(); }
        } catch { /* A failed probe must not retire an otherwise live watch. */ }
      }
      return;
    }
    if (now >= retryAt) { attach(); return; }
    // Bounded identity probes permit missing-parent creation and inode
    // replacement to recover sooner, without a watch() storm on a fixed path.
    if (probe && now >= nextProbeAt) {
      nextProbeAt = now + IDENTITY_PROBE_MS;
      try {
        if (!sameDirectory(identity(probe.path), probe.identity)) { reset(); attach(); }
      } catch { /* Keep the registration deadline on an unreadable probe. */ }
    }
  };
  attach();
  return {
    get active() { return active; }, get failure() { return failure; }, refresh,
    close() { closed = true; reset(); detach(); },
  };
}

/** A latched wake cannot be lost between checking a response and waiting.
 * Every wait still has the original bounded poll timer. One exchange owns this
 * watcher and timer; finally must close it on success, abandonment or error. */
export function permissionResponseWake(directory: string): { wait(ms: number): Promise<void>; close(): void } {
  let pending = false;
  let closed = false;
  let finish: (() => void) | undefined;
  const changed = () => { pending = true; finish?.(); };
  const observer = watchPermissionDirectory(directory, changed);
  return {
    wait(ms) {
      if (closed) return Promise.resolve();
      observer.refresh();
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          if (finish === done) finish = undefined;
          pending = false;
          resolve();
        }
        finish = done;
      });
    },
    close() { closed = true; observer.close(); finish?.(); },
  };
}
