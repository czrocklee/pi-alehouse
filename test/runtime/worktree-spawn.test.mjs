import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { packageRoot, resolveGit } from "../../bin/runtime-support.mjs";

const pass = "PASS: real composition worktrees inherit source policy and SDK cwd, reject shared canonical tree conflict before child input/history, retain a healthy reusable session and dirty output through confirmed shutdown; source files and index unchanged; offline";

test("real composition worktrees bind source policy, reject canonical conflicts before input/history and reuse healthy sessions, offline", { timeout: 90000 }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "alehouse-worktree-composition-")));
  const agentDir = join(dir, "agent"), temporaryRoot = join(dir, "tmp"), closed = join(dir, "confirmed-closed");
  mkdirSync(temporaryRoot, { mode: 0o700 });
  // No inherited credentials, provider configuration, Git injection or user Pi
  // paths. The fixture also overrides XDG_STATE_HOME with owned scratch, so
  // product worktree allocation never touches the real user's persistent state.
  const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg"), XDG_STATE_HOME: join(dir, "state"), PATH: process.env.PATH, TMPDIR: temporaryRoot,
    PI_CODING_AGENT_DIR: agentDir, PI_JEV_API_KEY_FILE: join(dir, "nonexistent-test-key"),
    PI_OFFLINE: "1", NO_COLOR: "1", WORKTREE_FIXTURE_CLOSED: closed };
  const git = resolveGit({ ...env, PI_HARNESS_GIT: process.env.PI_HARNESS_GIT });
  assert(git && isAbsolute(git), "controlled worktree integration requires verified absolute Git");
  t.after(() => {
    // Explicit TEST discard, not product cleanup. Unconfirmed/failed executions
    // retain their complete private root, including source repo and worktrees.
    if (existsSync(closed)) rmSync(dir, { recursive: true, force: true });
    else t.diagnostic(`Unconfirmed fixture artifacts retained at ${dir}`);
  });
  const output = execFileSync(process.execPath, [join(packageRoot, "test/runtime/fixtures/worktree-spawn.mjs")], {
    env: { ...env, PI_HARNESS_GIT: git }, encoding: "utf8", timeout: 85000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(existsSync(closed), true, `fixture must confirm closure before cleanup: ${dir}`);
  assert.deepEqual(output.split(/\r?\n/).filter((line) => line.startsWith("PASS:")), [pass]);
});
