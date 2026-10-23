import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageRoot } from "../../../bin/runtime-support.mjs";

test("real composition reports managed reader blocks once per task, offline", { timeout: 60000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "alehouse-block-feedback-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [join(packageRoot, "test/runtime/fixtures/block-feedback.mjs")], {
    cwd: packageRoot,
    // Deliberately no inherited credentials, provider configuration, subagent
    // hints, NODE_OPTIONS or approval/network opt-ins.
    env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, "agent"),
      PI_JEV_API_KEY_FILE: join(home, "nonexistent-test-key"), PI_OFFLINE: "1", NO_COLOR: "1" },
    encoding: "utf8", timeout: 55000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /PASS: real composition managed blocks produce exactly one harness-sourced alert per reader task; no writes, extra parent turns or network; child shutdown confirmed/);
});
