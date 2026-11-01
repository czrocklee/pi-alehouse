// Source-only controlled local Git fixtures. No build output, provider, live
// agent directory, credentials, remote, or external Git helper is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { resolveGit } from "../../../bin/runtime-support.mjs";

const source = readFileSync(new URL("../../src/runtime/agent-workspace.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createAgentWorkspace, AgentWorkspaceError } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const trustedGit = resolveGit();
assert.ok(trustedGit, "Trusted Git unavailable; supply an absolute verified PI_HARNESS_GIT (no PATH lookup or skip)");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "harness-workspace-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), repository = join(directory, "source"), state = join(directory, "state"), agentDir = join(directory, "agent");
  mkdirSync(home); mkdirSync(repository); mkdirSync(agentDir);
  const original = { ...process.env };
  // Each test runs sequentially in its own file/process, and restores the env.
  // HOME is isolated and the allocation state home is fixture-owned scratch:
  // the real user's persistent state is never read or written.
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: state });
  t.after(() => {
    // Preserve Node's special environment object: replacing it disconnects
    // later assignments from native environment readers such as os.tmpdir().
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(original, key)) delete process.env[key];
    }
    Object.assign(process.env, original);
  });
  const env = { HOME: home, XDG_CONFIG_HOME: home, PATH: "/dev/null", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" };
  const git = (args, cwd = repository) => execFileSync(trustedGit, ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--initial-branch=fixture"]);
  mkdirSync(join(repository, "nested"));
  writeFileSync(join(repository, "tracked.txt"), "committed\n");
  writeFileSync(join(repository, "nested/child.txt"), "nested baseline\n");
  git(["add", "--", "."]); git(["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  const create = async (sourceCwd = repository, gitPath = trustedGit) => {
    let result;
    try {
      result = await createAgentWorkspace({ agentDir, agentId: "fixture-agent", sourceCwd, git: gitPath });
      // Test-only manual cleanup of this fixture-owned retained artifact. Runtime
      // itself has no removal path and never calls git worktree remove/prune.
      t.after(() => rmSync(dirname(result.manifest), { recursive: true, force: true }));
      return result;
    } catch (error) {
      if (error.manifest) t.after(() => rmSync(dirname(error.manifest), { recursive: true, force: true }));
      throw error;
    }
  };
  return { directory, repository, home, state, agentDir, git, create, head };
}

function records(manifest) { return readFileSync(manifest, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
function worktreesRoot(stateHome) { return join(stateHome, "pi-alehouse", "worktrees"); }

test("detached committed baseline only, private recovery record, no source config/index/content mutation", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repository, "tracked.txt"), "dirty source\n");
  writeFileSync(join(f.repository, "untracked-secret.txt"), "not copied\n");
  mkdirSync(join(f.repository, ".pi")); writeFileSync(join(f.repository, ".pi/auth.json"), "fixture credential sentinel");
  const config = readFileSync(join(f.repository, ".git/config")), index = readFileSync(join(f.repository, ".git/index"));
  const handle = await f.create();
  const { workspace, manifest } = handle;
  assert.deepEqual(Object.keys(workspace).sort(), ["base_commit", "cwd", "mode", "source_cwd"]);
  assert.equal(workspace.mode, "worktree"); assert.equal(workspace.source_cwd, f.repository); assert.equal(workspace.base_commit, f.head);
  assert.ok(Object.isFrozen(workspace));
  assert.ok(Object.isFrozen(handle), "the private handle is immutable");
  assert.deepEqual(Object.keys(handle).sort(), ["checkout_root", "manifest", "source_root", "workspace"],
    "private handle roots are not public WorkspaceInfo facts");
  assert.equal(handle.checkout_root, workspace.cwd);
  assert.equal(handle.checkout_root, join(dirname(manifest), "tree"));
  assert.equal(handle.source_root, f.repository);
  assert.equal(records(manifest)[1].source_root, f.repository);
  assert.equal(readFileSync(join(workspace.cwd, "tracked.txt"), "utf8"), "committed\n");
  assert.equal(existsSync(join(workspace.cwd, "untracked-secret.txt")), false);
  assert.equal(existsSync(join(workspace.cwd, ".pi")), false);
  assert.equal(f.git(["rev-parse", "HEAD"], workspace.cwd).trim(), f.head);
  assert.throws(() => f.git(["symbolic-ref", "-q", "HEAD"], workspace.cwd));
  assert.equal(lstatSync(dirname(manifest)).mode & 0o777, 0o700);
  assert.equal(lstatSync(manifest).mode & 0o777, 0o600);
  assert.equal(lstatSync(manifest).uid, process.getuid());
  assert.deepEqual(records(manifest).map((entry) => entry.state), ["allocated", "creating", "ready"]);
  assert.deepEqual(records(manifest).at(-1).workspace, workspace);
  assert.deepEqual(readFileSync(join(f.repository, ".git/config")), config, "byte comparison: local config unchanged");
  assert.deepEqual(readFileSync(join(f.repository, ".git/index")), index, "byte comparison: source index unchanged");
  assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "dirty source\n");
  writeFileSync(join(workspace.cwd, "tracked.txt"), "worker edit\n");
  assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "dirty source\n", "separate tracked file contents, not OS isolation");
});

test("subdirectory cwd mirrors the committed subtree and separate allocations remain distinct", async (t) => {
  const f = fixture(t), source = join(f.repository, "nested");
  const first = await f.create(source), second = await f.create(source);
  assert.equal(first.workspace.source_cwd, source);
  assert.equal(relative(dirname(first.manifest), first.workspace.cwd), "tree/nested");
  assert.equal(readFileSync(join(first.workspace.cwd, "child.txt"), "utf8"), "nested baseline\n");
  assert.notEqual(first.workspace.cwd, second.workspace.cwd);
});

test("a linked-worktree source resolves its own current detached local HEAD", async (t) => {
  const f = fixture(t), linked = join(f.directory, "linked");
  f.git(["worktree", "add", "--detach", "--", linked, f.head]);
  const { workspace } = await f.create(linked);
  assert.equal(workspace.source_cwd, linked); assert.equal(workspace.base_commit, f.head);
  assert.equal(readFileSync(join(workspace.cwd, "tracked.txt"), "utf8"), "committed\n");
});

test("post-checkout hook is not executed, and tracked attributes cannot select an unconfigured helper", async (t) => {
  const f = fixture(t), hooks = join(f.directory, "hooks"), marker = join(f.directory, "hook-ran");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nprintf forbidden > '${marker}'\n`, { mode: 0o700 });
  f.git(["config", "core.hooksPath", hooks]);
  writeFileSync(join(f.repository, ".gitattributes"), "*.txt filter=unconfigured-fixture\n");
  f.git(["add", "--", ".gitattributes"]); f.git(["commit", "--no-gpg-sign", "-m", "fixture attributes"]);
  const { workspace } = await f.create();
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(workspace.cwd, "tracked.txt"), "utf8"), "committed\n");
});

for (const key of ["filter.fixture.smudge", "filter.fixture.clean", "filter.fixture.process", "filter.fixture.required", "core.fsmonitor", "extensions.partialclone", "include.path", "extensions.worktreeConfig"]) {
  test(`unsupported ${key} fails before repository mutation and retains a private diagnostic`, async (t) => {
    const f = fixture(t), marker = join(f.directory, "helper-ran");
    const value = key === "filter.fixture.required" || key === "extensions.worktreeConfig" ? "true" : key === "include.path" ? join(f.directory, "missing-config") : `fixture-helper-${marker}`;
    f.git(["config", key, value]);
    const config = readFileSync(join(f.repository, ".git/config"));
    await assert.rejects(f.create(), (error) => {
      assert.ok(error instanceof AgentWorkspaceError);
      assert.match(error.message, /unsupported_git_helper_or_partial_configuration/);
      assert.match(error.message, /retained path: .*recovery manifest:/);
      assert.equal(existsSync(error.retained_path), false);
      assert.deepEqual(records(error.manifest).map((entry) => entry.state), ["allocated", "failed_retained"]);
      return true;
    });
    assert.equal(existsSync(join(f.repository, ".git/worktrees")), false);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readFileSync(join(f.repository, ".git/config")), config);
  });
}

test("global helper configuration is inspected without running it or copying it into the worktree", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".gitconfig"), "[filter \"fixture\"]\n\tsmudge = fixture-helper-must-not-run\n");
  await assert.rejects(f.create(), /unsupported_git_helper_or_partial_configuration/);
  assert.equal(existsSync(join(f.repository, ".git/worktrees")), false);
});

test("missing local blob fails checkout safely with no fetch and leaves partial artifacts recoverable", async (t) => {
  const f = fixture(t), blob = f.git(["rev-parse", "HEAD:tracked.txt"]).trim();
  rmSync(join(f.repository, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(f.create(), (error) => {
    assert.ok(error instanceof AgentWorkspaceError);
    assert.match(error.reason, /git_checkout/);
    const log = records(error.manifest);
    assert.equal(log.at(-1).state, "failed_retained"); assert.equal(log.at(-1).stage, "git_checkout");
    assert.equal(log[1].workspace.base_commit, f.head);
    assert.equal(existsSync(join(error.retained_path, ".git")), true);
    return true;
  });
});

test("ambient Git redirect/config/exec/trace injection cannot redirect checkout", async (t) => {
  const f = fixture(t), trace = join(f.directory, "trace"), redirected = join(f.directory, "redirected");
  Object.assign(process.env, { GIT_DIR: redirected, GIT_WORK_TREE: redirected, GIT_INDEX_FILE: redirected,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.injected.smudge", GIT_CONFIG_VALUE_0: "fixture-helper",
    GIT_TRACE: trace, GIT_TRACE2_EVENT: trace, GIT_EXEC_PATH: redirected, GIT_SSH_COMMAND: "fixture-helper", PATH: redirected });
  const { workspace } = await f.create();
  assert.equal(workspace.base_commit, f.head); assert.equal(existsSync(trace), false); assert.equal(existsSync(redirected), false);
});

test("failure after worktree registration retains checked-out files and recoverable baseline", async (t) => {
  const f = fixture(t), uncommittedDirectory = join(f.repository, "not-in-head"); mkdirSync(uncommittedDirectory);
  await assert.rejects(f.create(uncommittedDirectory), (error) => {
    assert.ok(error instanceof AgentWorkspaceError); assert.match(error.reason, /git_verify/);
    assert.equal(readFileSync(join(error.retained_path, "tracked.txt"), "utf8"), "committed\n");
    const log = records(error.manifest);
    assert.deepEqual(log.map((entry) => entry.state), ["allocated", "creating", "failed_retained"]);
    assert.equal(log[1].workspace.base_commit, f.head); assert.equal(log.at(-1).stage, "git_verify");
    assert.ok(f.git(["worktree", "list", "--porcelain"]).includes(error.retained_path));
    return true;
  });
});

test("non-repository and unborn HEAD fail explicitly, never fall back to the source directory", async (t) => {
  const f = fixture(t), outside = join(f.directory, "outside"); mkdirSync(outside);
  await assert.rejects(f.create(outside), AgentWorkspaceError);
  f.git(["init", "--initial-branch=unborn"], outside);
  await assert.rejects(f.create(outside), AgentWorkspaceError);
  assert.deepEqual(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "committed\n");
});

test("a selected state root inside immutable agentDir fails before any allocation or hierarchy creation", async (t) => {
  const f = fixture(t);
  process.env.XDG_STATE_HOME = join(f.agentDir, "inside-agent-state");
  await assert.rejects(f.create(), (error) => {
    assert.ok(error instanceof AgentWorkspaceError);
    assert.match(error.reason, /worktree_root_is_immutable_agent_directory/);
    assert.equal(error.retained_path, undefined, "no leaf is allocated");
    assert.equal(error.manifest, undefined);
    return true;
  });
  assert.equal(existsSync(join(f.agentDir, "inside-agent-state")), false,
    "the state hierarchy is not created inside the immutable agent directory");
  // A symlinked alias hiding the overlap is also refused before creation.
  const alias = join(f.directory, "alias-state");
  symlinkSync(f.agentDir, alias);
  process.env.XDG_STATE_HOME = alias;
  await assert.rejects(f.create(), /worktree_root_is_immutable_agent_directory/);
  assert.equal(existsSync(join(alias, "pi-alehouse")), false, "nothing is created through the alias");
});

test("allocation uses the persistent state home, never tmpdir, and creates a missing private root", async (t) => {
  const f = fixture(t);
  delete process.env.XDG_STATE_HOME;
  // Even a TMPDIR inside the immutable agentDir must not drive allocation.
  process.env.TMPDIR = f.home;
  assert.equal(tmpdir(), f.home, "test setup reaches the native temporary-directory lookup");
  const { workspace, manifest } = await f.create();
  const root = worktreesRoot(join(f.home, ".local", "state"));
  assert.ok(relative(root, workspace.cwd).startsWith("pi-alehouse-worktree-"),
    `default allocation is under HOME/.local/state/pi-alehouse/worktrees: ${workspace.cwd}`);
  assert.equal(relative(root, dirname(manifest)).startsWith("pi-alehouse-worktree-"), true);
  assert.equal(workspace.cwd.startsWith(f.home), true, "allocation is inside the isolated HOME state, not tmpdir");
  const created = lstatSync(root);
  assert.equal(created.mode & 0o777, 0o700, "the dedicated worktrees parent is created private 0700");
  assert.equal(created.uid, process.getuid());
  assert.equal(created.isSymbolicLink(), false);
  const base = statSync(join(f.home, ".local", "state", "pi-alehouse"));
  assert.equal(base.isDirectory(), true, "standard state base created without chmod demands");
});

test("an explicit absolute XDG_STATE_HOME selects the allocation root; a relative value is ignored per the XDG specification", async (t) => {
  const f = fixture(t);
  const explicit = await f.create();
  assert.ok(relative(worktreesRoot(f.state), explicit.workspace.cwd).startsWith("pi-alehouse-worktree-"),
    "absolute XDG_STATE_HOME drives allocation");
  process.env.XDG_STATE_HOME = "relative-state";
  const fallback = await f.create();
  assert.ok(relative(worktreesRoot(join(f.home, ".local", "state")), fallback.workspace.cwd).startsWith("pi-alehouse-worktree-"),
    "a relative XDG_STATE_HOME is ignored and the HOME fallback is used");
});

test("existing shared or symlinked worktrees roots fail visibly and are never chmodded or replaced", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.state, "pi-alehouse"), { recursive: true });
  const root = worktreesRoot(f.state);
  for (const mode of [0o755, 0o777]) {
    mkdirSync(root); chmodSync(root, mode);
    await assert.rejects(f.create(), (error) => {
      assert.ok(error instanceof AgentWorkspaceError);
      assert.match(error.reason, /workspace_directory_not_private/);
      assert.equal(error.retained_path, undefined, "no leaf is allocated");
      return true;
    });
    assert.equal(lstatSync(root).mode & 0o777, mode, "an unsafe existing root is never chmodded");
    rmSync(root, { recursive: true, force: true });
  }
  const target = join(f.directory, "elsewhere"); mkdirSync(target);
  symlinkSync(target, root);
  await assert.rejects(f.create(), /workspace_directory_not_private/);
  assert.equal(lstatSync(root).isSymbolicLink(), true, "a symlinked root is never replaced");
  assert.equal(statSync(target).isDirectory(), true, "the symlink target is untouched");
});

test("private handle roots are accurate for root, subdirectory and linked-worktree sources", async (t) => {
  const f = fixture(t);
  const linked = join(f.directory, "linked");
  f.git(["worktree", "add", "--detach", "--", linked, f.head]);
  const atRoot = await f.create();
  assert.equal(atRoot.checkout_root, atRoot.workspace.cwd);
  assert.equal(atRoot.source_root, f.repository);
  const atNested = await f.create(join(f.repository, "nested"));
  assert.equal(atNested.source_root, f.repository, "source_root is the repository root, not the cwd");
  assert.equal(atNested.checkout_root, join(dirname(atNested.manifest), "tree"));
  assert.equal(atNested.workspace.cwd, join(atNested.checkout_root, "nested"));
  assert.notEqual(atNested.checkout_root, atNested.workspace.cwd);
  const atLinked = await f.create(linked);
  assert.equal(atLinked.source_root, linked, "a linked-worktree source reports its own root");
  assert.equal(atLinked.checkout_root, atLinked.workspace.cwd);
});

test("a symlinked source spelling keeps its lexical root through a canonical roundtrip; unsupported aliases fail visibly", async (t) => {
  const f = fixture(t);
  const alias = join(f.directory, "alias");
  symlinkSync(f.repository, alias);
  const viaAlias = await f.create(alias);
  assert.equal(viaAlias.workspace.source_cwd, alias, "the source spelling is not rewritten");
  assert.equal(viaAlias.source_root, alias, "source_root keeps the caller's lexical spelling");
  assert.equal(realpathSync(viaAlias.source_root), realpathSync(f.repository),
    "the lexical root roundtrips to the canonical repository");
  const viaNested = await f.create(join(alias, "nested"));
  assert.equal(viaNested.source_root, alias);
  assert.equal(readFileSync(join(viaNested.workspace.cwd, "child.txt"), "utf8"), "nested baseline\n");
  const deep = join(f.directory, "deep");
  symlinkSync(join(f.repository, "nested"), deep);
  await assert.rejects(f.create(deep), (error) => {
    assert.ok(error instanceof AgentWorkspaceError);
    assert.match(error.reason, /unsupported_source_alias/);
    assert.equal(existsSync(dirname(error.manifest)), true, "the allocated private leaf is retained for recovery");
    assert.equal(lstatSync(dirname(error.manifest)).mode & 0o777, 0o700);
    assert.deepEqual(records(error.manifest).map((entry) => entry.state), ["allocated", "failed_retained"]);
    return true;
  });
});

test("trusted Git is mandatory; relative/project PATH executables are never used", async (t) => {
  const f = fixture(t);
  for (const attempt of [() => f.create(f.repository, "git"),
    () => createAgentWorkspace({ agentDir: f.agentDir, agentId: "fixture", sourceCwd: f.repository, git: undefined })]) {
    await assert.rejects(attempt(), (error) => {
      assert.ok(error instanceof AgentWorkspaceError);
      assert.match(error.reason, /trusted_git_unavailable/);
      assert.match(error.reason, /PI_HARNESS_GIT/, "the diagnostic names the verified absolute override");
      return true;
    });
  }
});

test("second checkout configuration guard: a local config injected after worktree add fails before any checkout", async (t) => {
  const f = fixture(t);
  // Test-only executable wrapper around the exact verified trusted Git. It
  // lives in fixture scratch (never inside the source repository), invokes the
  // actual local `worktree add`, then injects an unsupported LOCAL filter
  // config into the fresh worktree before returning. For a linked worktree the
  // worktree-local config is the shared common config, so the injection lands
  // in the fixture's .git/config; the product only reads it and the test
  // restores the bytes below. The known Git path is fixed in the script,
  // detection is a fixed argv match, and there is no env-based wrapper or retry.
  const wrapper = join(f.directory, "git-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh
# Test-only regression wrapper; not a product helper.
GIT="${trustedGit}"
retained=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--" ]; then retained="$arg"; fi
  prev="$arg"
done
"$GIT" "$@" || exit $?
case "$*" in
  *" worktree add --detach --no-checkout -- "*)
    (cd "$retained" && "$GIT" config --local filter.wrapper.injected.smudge fixture-helper-must-not-run)
    ;;
esac
exit 0
`);
  chmodSync(wrapper, 0o700);
  const config = readFileSync(join(f.repository, ".git/config"));
  await assert.rejects(f.create(f.repository, wrapper), (error) => {
    assert.ok(error instanceof AgentWorkspaceError);
    assert.match(error.reason, /git_checkout_guard: unsupported_git_helper_or_partial_configuration/);
    // The worktree registration exists, but read-tree/checkout never ran:
    // no tracked content was materialized.
    assert.equal(existsSync(join(error.retained_path, ".git")), true);
    assert.equal(existsSync(join(error.retained_path, "tracked.txt")), false, "no checked-out tracked content");
    assert.equal(existsSync(join(error.retained_path, "nested")), false, "no checked-out subtree");
    const log = records(error.manifest);
    assert.deepEqual(log.map((entry) => entry.state), ["allocated", "creating", "failed_retained"]);
    assert.equal(log.at(-1).stage, "git_checkout_guard");
    assert.equal(lstatSync(error.manifest).mode & 0o777, 0o600, "private recovery manifest retained");
    assert.equal(lstatSync(dirname(error.manifest)).mode & 0o777, 0o700);
    return true;
  });
  const injected = readFileSync(join(f.repository, ".git/config"), "utf8");
  assert.match(injected, /smudge = fixture-helper-must-not-run/,
    "the wrapper injected into the worktree-visible local (common) config after worktree add");
  // Test-only restore of the wrapper's fixture injection; the product never writes it.
  writeFileSync(join(f.repository, ".git/config"), config);
});
