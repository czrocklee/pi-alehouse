import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { validateDispatch, type Dispatch, type DispatchContext, type DispatchObservation, type DispatchPath, type DispatchPort, type PreparedDispatch, type SourceState } from "../core/dispatch.js";
import { HarnessError } from "../core/ports.js";
import { FileLeaseLock } from "./owner-lease.js";

const PROBE_MS = 2_000;
const CAPTURE_MS = 8_000;
const PROBE_BYTES = 4 * 1024 * 1024;
const CAPTURE_BYTES = 8 * 1024 * 1024;
const GIT_FLAGS = ["--no-lazy-fetch", "--no-optional-locks", "--no-pager", "--no-replace-objects"];
const CONFIG_GUARD = "^(core\\.fsmonitor|filter\\..*\\.(clean|process)|extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$";

type PermissionState = "allow" | "ask" | "deny" | "unknown";
type PermissionQuery = { checkPermission(surface: string, value: string, profile: string): unknown };
type PathField = "inputs" | "ownership" | "tree";

function inside(base: string, path: string): boolean {
  const tail = relative(base, path);
  return !tail || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
}
function errno(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function supportedLiteralPath(value: string): string {
  // The authority trims policy literals and strips trailing wrapper quotes.
  // Refuse aliases/cwds it cannot query as the exact same filesystem name.
  if (value !== value.trim() || /['"]$/.test(value)) throw new HarnessError("DISPATCH_PATH_UNKNOWN", { path: value });
  return value;
}
/** Resolve only missing tails, never reinterpret an inaccessible/dangling alias.
 * These ancestry probes are path interpretation, NOT input existence classification.
 * Neither this nor later stat is a TOCTOU barrier or hardlink detector.
 */
function canonicalPath(path: string): string {
  supportedLiteralPath(path);
  let ancestor = path;
  const tail: string[] = [];
  try {
    for (;;) {
      try {
        const entry = lstatSync(ancestor);
        const canonical = realpathSync(ancestor);
        if (tail.length && !lstatSync(canonical).isDirectory()) throw new Error("NOT_DIRECTORY");
        // A dangling symlink fails realpath above; never ascend through it.
        if (!entry.isSymbolicLink() && !entry.isDirectory() && tail.length) throw new Error("NOT_DIRECTORY");
        return supportedLiteralPath(resolve(canonical, ...tail));
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        // ENOENT from realpath of an existing symlink must not be treated as a
        // missing output. lstat distinguishes that case without following it.
        try { lstatSync(ancestor); throw new Error("DANGLING_PATH", { cause: error }); }
        catch (inspection) { if (errno(inspection) !== "ENOENT") throw inspection; }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        tail.unshift(relative(parent, ancestor));
        ancestor = parent;
      }
    }
  } catch { throw new HarnessError("DISPATCH_PATH_UNKNOWN", { path }); }
}

function permissionQuery(getService: () => unknown): PermissionQuery {
  try {
    const service = getService();
    if (!service || typeof service !== "object" || Array.isArray(service) || "then" in service || typeof (service as PermissionQuery).checkPermission !== "function") throw new Error("MISSING_QUERY");
    return service as PermissionQuery;
  } catch { throw new HarnessError("DISPATCH_PREFLIGHT_UNAVAILABLE"); }
}
function permissionState(service: PermissionQuery, surface: string, path: string, profile: string, field: PathField, item: string): PermissionState {
  try {
    const result = service.checkPermission(surface, path, profile);
    if (!result || typeof result !== "object" || Array.isArray(result) || "then" in result) throw new Error("INVALID_QUERY_RESULT");
    const state: unknown = (result as { state?: unknown }).state;
    if (state !== "allow" && state !== "ask" && state !== "deny" && state !== "unknown") throw new Error("INVALID_QUERY_STATE");
    return state;
  } catch { throw new HarnessError("DISPATCH_PREFLIGHT_UNAVAILABLE", { key: field, requested: item, surface, path }); }
}
function classify(path: DispatchPath, field: "inputs" | "tree", item: string): void {
  let entry: ReturnType<typeof statSync>;
  try { entry = statSync(path.path); }
  catch (error) {
    if (errno(error) === "ENOENT") {
      if (field === "tree") return;
      throw new HarnessError("DISPATCH_INPUT_MISSING", { key: field, requested: item, path: path.path });
    }
    throw new HarnessError(field === "inputs" ? "DISPATCH_INPUT_INSPECTION_FAILED" : "DISPATCH_TREE_INSPECTION_FAILED", { key: field, requested: item, path: path.path });
  }
  if (field === "tree" ? !entry.isDirectory() : !entry.isFile() && !entry.isDirectory())
    throw new HarnessError(field === "inputs" ? "DISPATCH_INPUT_TYPE" : "DISPATCH_TREE_TYPE", { key: field, requested: item, path: path.path });
}

/** Git gets no ambient Git injection/redirect/trace or dynamic-loader variables.
 * Keep normal system/global config visible so the raw guard sees its helpers.
 * No project PATH lookup, even for accidental helper execution.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:GIT_|LD_|DYLD_|_RLD|LDR_|BASH_FUNC_)/i.test(key) ||
        /^(?:LIBPATH|SHLIB_PATH|GCONV_PATH|GLIBC_TUNABLES|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|CDPATH|SHELLOPTS|BASHOPTS|PATH)$/i.test(key)) continue;
    env[key] = value;
  }
  // Trace2 also has system/global config targets. Explicit zero overrides them
  // before setup/config inspection; merely deleting inherited trace vars does not.
  // /dev/null is an ENOTDIR search sentinel, NOT a system executable directory.
  // Empty PATH would search cwd and could run a project helper from a wrapper.
  return { ...env, PATH: "/dev/null", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_TRACE: "0", GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0" };
}

/** Async per-probe and aggregate time/output budgets. OS IO and scheduling are
 * not hard realtime bounds. No raw status/path/config/error output is retained.
 */
async function captureSource(cwd: string, git: string | undefined): Promise<SourceState> {
  const unknown = (reason: string): SourceState => ({ state: "unknown", reason });
  if (typeof git !== "string" || !isAbsolute(git)) return unknown("git_unavailable");
  let binary: string;
  try {
    binary = realpathSync(git);
    accessSync(binary, constants.X_OK);
    if (!statSync(binary).isFile()) return unknown("git_unavailable");
  } catch { return unknown("git_unavailable"); }
  try {
    // Deliberately support only a conventional root worktree. Linked, bare,
    // separate-git-dir, subdirectory and ambiguous layouts remain unknown.
    const root = realpathSync(cwd);
    const dotGit = join(root, ".git");
    if (!lstatSync(root).isDirectory() || !lstatSync(dotGit).isDirectory() || /[\r\n]/.test(root)) return unknown("git_layout_unknown");
    const env = gitEnvironment();
    const deadline = performance.now() + CAPTURE_MS;
    let bytes = 0;
    const probe = async (args: string[], absentOK = false): Promise<Buffer> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0 || bytes >= CAPTURE_BYTES) throw new Error("CAPTURE_LIMIT");
      return new Promise<Buffer>((accept, reject) => {
        let inputFailed = false;
        const child = execFile(binary, [...GIT_FLAGS, ...args], {
          cwd: root, env, encoding: "buffer", timeout: Math.min(PROBE_MS, remaining),
          maxBuffer: Math.min(PROBE_BYTES, CAPTURE_BYTES - bytes), killSignal: "SIGKILL",
        }, (error, stdout, stderr) => {
          bytes += stdout.length + stderr.length;
          if (bytes > CAPTURE_BYTES || performance.now() > deadline) { reject(new Error("CAPTURE_LIMIT")); return; }
          if (inputFailed) { reject(new Error("PROBE_INPUT_FAILED")); return; }
          if (error && !(absentOK && error.code === 1 && !error.killed && !stdout.length && !stderr.length)) {
            reject(new Error("GIT_PROBE_FAILED", { cause: error })); return;
          }
          accept(stdout);
        });
        // Settle only through execFile's exit callback, including stdin errors.
        child.stdin?.on("error", () => { inputFailed = true; child.kill("SIGKILL"); });
        child.stdin?.end();
      });
    };
    // Do NOT inject -c core.fsmonitor=false into this guard: it would detect
    // its own override and incorrectly label every repository unknown.
    const config = await probe(["config", "--null", "--name-only", "--get-regexp", CONFIG_GUARD], true);
    if (config.length) {
      const keys = config.toString("utf8").split("\0");
      return unknown(keys.some(key => /^(?:extensions\.partialclone|remote\..*\.(?:promisor|partialclonefilter))$/.test(key)) ? "git_partial_clone" : "git_helper_config");
    }
    const layout = (await probe(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--is-inside-work-tree", "--is-bare-repository"])).toString("utf8");
    if (layout !== `${root}\n${dotGit}\n${dotGit}\ntrue\nfalse\n`) return unknown("git_layout_unknown");
    const head = (await probe(["rev-parse", "--verify", "HEAD"])).toString("utf8");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(head)) return unknown("git_head_unknown");
    const status = await probe(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=normal"]);
    if (status.length && status[status.length - 1] !== 0) return unknown("git_status_unknown");
    return { state: "observed", scope: "superproject_only", submodules: "ignored", head: head.slice(0, -1),
      dirty: status.length > 0, status_digest: createHash("sha256").update(status).digest("hex"), observed_at: Date.now() };
  } catch { return unknown("git_probe_failed"); }
}

async function privateDirectory(path: string): Promise<{ dev: number; ino: number }> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (errno(error) !== "EEXIST") throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o7777) !== 0o700)
    throw new Error("TREE_DIRECTORY_MUST_BE_PRIVATE");
  return { dev: entry.dev, ino: entry.ino };
}
async function sameDirectory(path: string, identity: { dev: number; ino: number }): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o7777) !== 0o700 ||
      entry.dev !== identity.dev || entry.ino !== identity.ino) throw new Error("TREE_DIRECTORY_CHANGED");
}

export function createDispatchRuntime(options: { agentDir: string; flock: string; git?: string; getPermissionsService: () => unknown }): DispatchPort {
  return {
    prepare(dispatch: Dispatch, context: DispatchContext & { deferInputs: boolean }): PreparedDispatch {
      validateDispatch(dispatch);
      if (!isAbsolute(context.cwd)) throw new HarnessError("DISPATCH_PATH_UNKNOWN", { path: context.cwd });
      const lexicalCwd = supportedLiteralPath(resolve(context.cwd));
      const service = permissionQuery(options.getPermissionsService);
      const declaration: Dispatch = {
        ...(dispatch.inputs ? { inputs: [...dispatch.inputs] } : {}),
        ...(dispatch.ownership ? { ownership: [...dispatch.ownership] } : {}),
        ...(dispatch.tree ? { tree: dispatch.tree } : {}),
        ...(dispatch.checks ? { checks: [...dispatch.checks] } : {}),
      };
      type Target = { key: PathField; requested: string; path: string; canonical?: string; lexicalExternal?: boolean };
      const target = (requested: string, key: PathField): Target => {
        const path = resolve(lexicalCwd, requested);
        try { supportedLiteralPath(path); }
        catch { throw new HarnessError("DISPATCH_PATH_UNKNOWN", { key, requested, path }); }
        return { key, requested, path };
      };
      const inputs = (declaration.inputs ?? []).map(item => target(item, "inputs"));
      const ownership = (declaration.ownership ?? []).map(item => target(item, "ownership"));
      const tree = declaration.tree ? target(declaration.tree, "tree") : undefined;
      const targets = [...inputs, ...ownership, ...(tree ? [tree] : [])];
      const denied = (entry: Target, surface: string, path: string): void => {
        if (permissionState(service, surface, path, context.profile, entry.key, entry.requested) === "deny")
          throw new HarnessError("PREFLIGHT_DENIED", { key: entry.key, requested: entry.requested, surface, path });
      };
      const external = (entry: Target): string => entry.key === "inputs" ? "external_directory_read" : "external_directory_write";
      // First query every lexical declaration before ANY ancestry inspection.
      // Known denies must not be replaced by dangling/EACCES/ENOTDIR diagnostics.
      for (const entry of targets) {
        denied(entry, entry.key === "inputs" ? "path_read" : "path_write", entry.path);
        if (!inside(lexicalCwd, entry.path)) { denied(entry, external(entry), entry.path); entry.lexicalExternal = true; }
      }
      let cwd: string | undefined;
      let pathError: HarnessError | undefined;
      try { cwd = canonicalPath(lexicalCwd); }
      catch { pathError = new HarnessError("DISPATCH_PATH_UNKNOWN", { path: lexicalCwd }); }
      for (const entry of targets) {
        try { entry.canonical = canonicalPath(entry.path); }
        catch { pathError ??= new HarnessError("DISPATCH_PATH_UNKNOWN", { key: entry.key, requested: entry.requested, path: entry.path }); }
        if (cwd !== undefined && entry.canonical !== undefined && !inside(cwd, entry.canonical) &&
            !(entry.lexicalExternal && entry.path === entry.canonical)) denied(entry, external(entry), entry.canonical);
      }
      // Complete all still-possible permissions before reporting a path error,
      // and EVERY permission before classifying ANY input/tree.
      if (pathError) throw pathError;
      const resolved = (entry: Target): DispatchPath => ({ path: entry.path, canonical: entry.canonical! });
      const prepared: PreparedDispatch = { declaration, inputs: inputs.map(resolved), ownership: ownership.map(resolved),
        ...(tree ? { tree: resolved(tree) } : {}) };
      if (!context.deferInputs) prepared.inputs.forEach((path, i) => classify(path, "inputs", declaration.inputs![i]!));
      if (prepared.tree) classify(prepared.tree, "tree", declaration.tree!);
      return prepared;
    },
    async start(dispatch: PreparedDispatch, context: DispatchContext & { acquireTree: boolean }): Promise<DispatchObservation> {
      const observation: DispatchObservation = {};
      if (dispatch.tree && context.acquireTree) {
        let lock: FileLeaseLock | undefined;
        try {
          if (!isAbsolute(options.agentDir) || !isAbsolute(dispatch.tree.canonical)) throw new Error("TREE_PATH_UNKNOWN");
          const root = join(options.agentDir, "harness-trees");
          const leaf = join(root, createHash("sha256").update(dispatch.tree.canonical).digest("hex"));
          const rootIdentity = await privateDirectory(root);
          const leafIdentity = await privateDirectory(leaf);
          await sameDirectory(root, rootIdentity);
          lock = new FileLeaseLock(leaf, options.flock);
          await sameDirectory(root, rootIdentity);
          await sameDirectory(leaf, leafIdentity);
          observation.lease = lock;
        } catch (error) {
          observation.notes = [error instanceof Error && error.message === "OWNER_LOCKED" ? "tree_shared" : "tree_lock_unknown"];
          // Core is the sole release authority once a handle exists, including
          // failed post-acquisition inspection. Do not attempt early close here.
          if (lock) observation.lease = lock;
          else if (error instanceof Error && error.message === "LOCK_CLEANUP_UNCERTAIN") {
            // Constructor cleanup failed before it could return a handle. Keep
            // the same sticky failure as a tombstone so core latches/retains its
            // claim rather than mistaking absent handle for confirmed cleanup.
            const failed = (): never => { throw error; };
            observation.lease = { assertHeld: failed, close: failed };
          }
        }
      }
      if (dispatch.declaration.checks?.length) observation.source_state = await captureSource(context.cwd, options.git);
      return observation;
    },
  };
}
