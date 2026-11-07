import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hook = join(root, ".githooks/pre-commit");

// Exercise the real hook with a synthetic npm. No project checks, Git writes,
// installations, provider calls or user configuration are run by these probes.
function runHook(t, { lintExit = 0, formatExit = 0, npmAvailable = true } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "alehouse-git-hook-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const bin = join(fixture, "bin");
  const log = join(fixture, "calls.txt");
  mkdirSync(bin);
  if (npmAvailable) {
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$HOOK_TEST_LOG"
case "$*" in
  'run lint') exit "$HOOK_TEST_LINT_EXIT" ;;
  'run format:check') exit "$HOOK_TEST_FORMAT_EXIT" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
  }
  const result = spawnSync(hook, [], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: bin,
      HOOK_TEST_LOG: log,
      HOOK_TEST_LINT_EXIT: String(lintExit),
      HOOK_TEST_FORMAT_EXIT: String(formatExit),
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const calls = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { ...result, calls };
}

test("pre-commit is executable and runs lint then read-only formatting checks", (t) => {
  assert.notEqual(statSync(hook).mode & 0o111, 0);
  assert.doesNotMatch(readFileSync(hook, "utf8"), /--fix|--write|git\s+add/);
  const result = runHook(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["run lint", "run format:check"]);
});

test("pre-commit preserves lint failure and does not continue to formatting", (t) => {
  const result = runHook(t, { lintExit: 17 });
  assert.equal(result.status, 17);
  assert.deepEqual(result.calls, ["run lint"]);
});

test("pre-commit rejects formatting failures", (t) => {
  const result = runHook(t, { formatExit: 23 });
  assert.equal(result.status, 23);
  assert.deepEqual(result.calls, ["run lint", "run format:check"]);
});

test("pre-commit fails closed when npm is unavailable", (t) => {
  const result = runHook(t, { npmAvailable: false });
  assert.equal(result.status, 127);
  assert.deepEqual(result.calls, []);
});
