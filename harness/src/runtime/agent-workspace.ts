import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { WorkspaceInfo } from "../core/contracts.js";

/** Execution metadata only: neither a permission grant nor an OS sandbox. */
export type AgentWorkspace = Readonly<WorkspaceInfo>;
export interface AgentWorkspaceHandle {
  readonly workspace: AgentWorkspace;
  readonly manifest: string;
  /** Private handle facts, not public WorkspaceInfo: the retained allocated
   * checkout tree and the lexical source-repository spelling validated against
   * the canonical repository root. */
  readonly checkout_root: string;
  readonly source_root: string;
}

/** No cleanup API: even incomplete worktrees are retained for manual recovery. */
export class AgentWorkspaceError extends Error {
  constructor(readonly reason: string, readonly retained_path?: string, readonly manifest?: string, cause?: unknown) {
    super(`WORKTREE_CREATION_FAILED: ${reason}${retained_path ? `; retained path: ${retained_path}; recovery manifest: ${manifest}` : ""}`, { cause });
    this.name = "AgentWorkspaceError";
  }
}

const TRUSTED_GIT_UNAVAILABLE = "trusted_git_unavailable; set PI_HARNESS_GIT to a verified absolute Git executable";
const FLAGS = ["--no-lazy-fetch", "--no-optional-locks", "--no-pager", "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
// Guard raw configuration BEFORE adding fsmonitor/sparse overrides. Unlike the
// source-state observation, checkout also cares about smudge and required filters.
const UNSUPPORTED = "^(include\\..*|includeif\\..*|core\\.(fsmonitor|alternaterefscommand|worktree)|filter\\..*\\.(clean|smudge|process|required)|extensions\\.(partialclone|worktreeconfig)|remote\\..*\\.(promisor|partialclonefilter))$";
const CHECKOUT = ["-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
  "-c", "core.sparseCheckout=false", "-c", "core.sparseCheckoutCone=false", "-c", "index.sparse=false",
  "-c", "checkout.workers=1", "-c", "submodule.recurse=false", "-c", "worktree.guessRemote=false"];

/** No ambient Git/config/loader/shell injection, executable search, or transports.
 * Global config remains visible to the raw helper guard, then is suppressed for
 * mutation. Only a private symlink to verified Git is searchable for internal
 * Git subprocesses. Local config is never edited. This is not a sandbox.
 */
function environment(controlled: boolean, gitOnlyDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { PATH: gitOnlyDirectory, LC_ALL: "C", GIT_EXEC_PATH: gitOnlyDirectory, GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TRACE: "0", GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0" });
  if (controlled) Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" });
  return env;
}
function code(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}
async function privateDirectory(path: string): Promise<{ dev: number; ino: number }> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (code(error) !== "EEXIST") throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o7777) !== 0o700)
    throw new Error("workspace_directory_not_private");
  return { dev: entry.dev, ino: entry.ino };
}
async function sameDirectory(path: string, identity: { dev: number; ino: number }): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid?.() || (current.mode & 0o7777) !== 0o700 ||
      identity.dev !== current.dev || identity.ino !== current.ino) throw new Error("workspace_directory_changed");
}
/** Persistent default state home: an absolute XDG_STATE_HOME, else the XDG
 * default ~/.local/state. A relative XDG_STATE_HOME is ignored per the XDG
 * specification and the home fallback is used. */
function stateHomeDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  return join(homedir(), ".local", "state");
}
/** Standard state base: only a missing hierarchy is created with the ordinary
 * umask default (typically 0755). Existing user directories are never chmodded,
 * replaced or unlinked; a symlinked location is the user's own choice and is
 * followed, but a final non-directory is refused. */
async function ensureStateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { recursive: true }); }
  catch { throw new Error("workspace_state_unavailable"); }
  if (!(await stat(path)).isDirectory()) throw new Error("workspace_state_unavailable");
}
/** Canonicalizes the nearest existing ancestor, so an alias through a symlink
 * cannot hide an overlap before the hierarchy is created. */
async function nearestExistingDirectory(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try { return await realpath(current); }
    catch (error) {
      if (code(error) !== "ENOENT" || current === dirname(current)) throw error;
      current = dirname(current);
    }
  }
}
/** The canonical selected worktree state root must be outside the immutable
 * agent directory, at or below it never acceptable. */
function outsideImmutableAgentDirectory(canonical: string, agentRoot: string): void {
  const tail = relative(agentRoot, canonical);
  if (!tail || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`)))
    throw new Error("worktree_root_is_immutable_agent_directory");
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Called only at actual child assembly; no submit/replay side effects.
 * Supports a conventional or linked local source repository, including a cwd
 * below its root. No dirty files, untracked files, credentials, caches or submodules are
 * copied. Tracked blobs alone are checked out at the resolved local commit.
 * Allocation uses a persistent private state location (absolute XDG_STATE_HOME,
 * else ~/.local/state, beneath pi-alehouse/worktrees) outside the immutable
 * agentDir. Allocation and manifests are retained on failure with no proactive
 * cleanup; this is a durable default location, not an indefinite-persistence
 * or crash-durability promise.
 * Budgets are asynchronous soft bounds, not immediate cancellation/exit proof.
 */
export async function createAgentWorkspace(input: {
  /** Used only to reject an immutable agentDir as the checkout state root. */
  agentDir: string;
  agentId: string;
  sourceCwd: string;
  /** Launcher-verified absolute Git, never a project PATH lookup. */
  git: string | undefined;
}): Promise<AgentWorkspaceHandle> {
  let retained: string | undefined, manifest: string | undefined;
  let record: ((state: string, extra?: Record<string, unknown>) => Promise<void>) | undefined;
  let stage = "workspace_preflight";
  try {
    if (process.platform !== "linux" || !isAbsolute(input.agentDir) || !isAbsolute(input.sourceCwd) || /[\0\r\n]/.test(input.sourceCwd))
      throw new Error("unsupported_workspace_path");
    if (!input.git || !isAbsolute(input.git)) throw new Error(TRUSTED_GIT_UNAVAILABLE);
    const git = await realpath(input.git);
    await access(git, constants.X_OK);
    if (!(await stat(git)).isFile()) throw new Error(TRUSTED_GIT_UNAVAILABLE);
    const source = await realpath(input.sourceCwd);
    if (!(await stat(source)).isDirectory()) throw new Error("source_not_directory");
    // agentDir is immutable to model tools. Keep the actual editable checkout
    // outside it, under a persistent private state location the user owns:
    // <XDG_STATE_HOME or ~/.local/state>/pi-alehouse/worktrees, never tmpdir.
    const agentRoot = await realpath(input.agentDir);
    const stateHome = stateHomeDirectory();
    if (!isAbsolute(stateHome)) throw new Error("unsupported_workspace_path");
    const worktrees = join(stateHome, "pi-alehouse", "worktrees");
    // Refuse an overlap with the immutable agent directory before creating the
    // state hierarchy, including through existing symlinked ancestors.
    outsideImmutableAgentDirectory(await nearestExistingDirectory(worktrees), agentRoot);
    await ensureStateDirectory(stateHome);
    await ensureStateDirectory(join(stateHome, "pi-alehouse"));
    // The dedicated worktrees parent is private to this user (0700, own uid,
    // never a symlink); a shared or unsafe existing root fails visibly and is
    // never chmodded or replaced.
    const worktreesIdentity = await privateDirectory(worktrees);
    const root = await realpath(worktrees);
    outsideImmutableAgentDirectory(root, agentRoot);
    await sameDirectory(worktrees, worktreesIdentity);
    const leaf = await mkdtemp(join(root, "pi-alehouse-worktree-"));
    retained = join(leaf, "tree");
    manifest = join(leaf, "recovery.jsonl");
    const leafIdentity = await privateDirectory(leaf);
    const file = await open(manifest, constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      record = async (state, extra = {}) => {
        await file.writeFile(`${JSON.stringify({ version: 1, state, agent_id: input.agentId,
          source_cwd: input.sourceCwd, retained_path: retained, ...extra })}\n`);
        await file.sync();
      };
      await record("allocated");
      // worktree add can spawn Git itself. Offer only the verified executable,
      // never project PATH, a general system helper directory, or empty PATH.
      const gitOnlyDirectory = join(leaf, "git-bin");
      await privateDirectory(gitOnlyDirectory);
      await symlink(git, join(gitOnlyDirectory, "git"));
      // Publish the recovery record and its directory entries before Git can
      // mutate repository metadata. This is a local fsync attempt, not recovery
      // automation or a claim about every filesystem's power-loss behavior.
      await syncDirectory(leaf); await syncDirectory(worktrees);
      const deadline = performance.now() + 45_000;
      let bytes = 0;
      const probe = async (cwd: string, args: string[], controlled = true, absentOK = false, checkout = false): Promise<string> => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0 || bytes >= 8 * 1024 * 1024) throw new Error("git_budget_exceeded");
        return new Promise<string>((accept, reject) => {
          let inputFailed = false;
          const child = execFile(git, [...FLAGS, ...args], { cwd, env: environment(controlled, gitOnlyDirectory), encoding: "buffer",
            timeout: Math.min(checkout ? 30_000 : 2_000, remaining), maxBuffer: Math.min(4 * 1024 * 1024, 8 * 1024 * 1024 - bytes), killSignal: "SIGKILL" },
          (error, stdout, stderr) => {
            bytes += stdout.length + stderr.length;
            if (inputFailed || bytes > 8 * 1024 * 1024 || performance.now() > deadline) { reject(new Error("git_budget_exceeded")); return; }
            if (error && !(absentOK && error.code === 1 && !error.killed && !stdout.length && !stderr.length)) {
              reject(new Error("git_command_failed")); return;
            }
            accept(stdout.toString("utf8"));
          });
          child.stdin?.on("error", () => { inputFailed = true; child.kill("SIGKILL"); });
          child.stdin?.end();
        });
      };
      try {
        stage = "git_configuration";
        if (await probe(source, ["config", "--null", "--name-only", "--get-regexp", UNSUPPORTED], false, true))
          throw new Error("unsupported_git_helper_or_partial_configuration");
        stage = "git_layout";
        const layout = (await probe(source, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--is-inside-work-tree", "--is-bare-repository"])).split("\n");
        const repository = layout[0];
        const gitDirectory = layout[1], commonDirectory = layout[2];
        if (!repository || !gitDirectory || !commonDirectory || layout.length !== 6 || !isAbsolute(repository) || !isAbsolute(gitDirectory) || !isAbsolute(commonDirectory) ||
            layout[3] !== "true" || layout[4] !== "false" || layout[5] !== "" || await realpath(repository) !== repository ||
            !(await stat(gitDirectory)).isDirectory() || !(await stat(commonDirectory)).isDirectory())
          throw new Error("unsupported_git_layout");
        const dotGit = await lstat(join(repository, ".git"));
        if (dotGit.isSymbolicLink() || (!dotGit.isDirectory() && !dotGit.isFile()) ||
            (dotGit.isDirectory() ? gitDirectory !== join(repository, ".git") || commonDirectory !== gitDirectory : !gitDirectory.startsWith(`${join(commonDirectory, "worktrees")}${sep}`)))
          throw new Error("unsupported_git_layout");
        const tail = relative(repository, source);
        if (isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`)) throw new Error("source_outside_repository");
        // Private handle fact: the caller's lexical source-repository spelling.
        // The same relative offsets must lead from that spelling back to the
        // canonical repository; an unsupported alias fails visibly. Nothing is
        // guessed from model paths.
        const lexicalSourceRoot = resolve(input.sourceCwd, ...tail.split(sep).filter(Boolean).map(() => ".."));
        if (await realpath(lexicalSourceRoot) !== repository) throw new Error("unsupported_source_alias");
        const head = await probe(source, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(head)) throw new Error("local_head_unavailable");
        const base = head.slice(0, -1), cwd = resolve(retained, tail);
        const workspace: AgentWorkspace = Object.freeze({ mode: "worktree", cwd, source_cwd: input.sourceCwd, base_commit: base });
        await record("creating", { workspace, repository, git_directory: gitDirectory, common_directory: commonDirectory, source_root: lexicalSourceRoot });
        await sameDirectory(leaf, leafIdentity);
        stage = "git_worktree_add";
        await probe(repository, [...CHECKOUT, "worktree", "add", "--detach", "--no-checkout", "--", retained, base], true, false, true);
        stage = "git_checkout_guard";
        // Inspect the new location too: conditional/local policy must not become
        // a previously unseen checkout helper. This is still cooperative,
        // non-atomic config inspection, not protection from trusted concurrent
        // code changing repository configuration during the next subprocess.
        if (await probe(retained, ["config", "--null", "--name-only", "--get-regexp", UNSUPPORTED], true, true))
          throw new Error("unsupported_git_helper_or_partial_configuration");
        stage = "git_checkout";
        await probe(retained, [...CHECKOUT, `--work-tree=${retained}`, "read-tree", "--reset", "-u", base], true, false, true);
        stage = "git_verify";
        if (await probe(retained, ["rev-parse", "--verify", "HEAD"]) !== head ||
            await probe(retained, ["symbolic-ref", "-q", "HEAD"], true, true) !== "" || !(await stat(cwd)).isDirectory() || await realpath(cwd) !== cwd)
          throw new Error("workspace_baseline_unconfirmed");
        await sameDirectory(leaf, leafIdentity);
        await record("ready", { workspace });
        return Object.freeze({ workspace, manifest, checkout_root: retained, source_root: lexicalSourceRoot });
      } catch (error) {
        try { await record("failed_retained", { stage }); } catch { /* Initial recovery record is still retained. */ }
        throw error;
      }
    } finally { await file.close(); }
  } catch (error) {
    const reason = error instanceof Error ? error.message : stage;
    throw new AgentWorkspaceError(`${stage}: ${reason}`, retained, manifest, error);
  }
}
