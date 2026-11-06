import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

// Exact inherited launcher roots. Omitting them, rather than forwarding
// process.env, is what keeps a developer override from selecting another tree.
const inheritedRoots = ["PI_HARNESS_PERMISSION_ROOT", "PI_HARNESS_POLICY_ROOT", "PI_HARNESS_FLOCK", "PI_HARNESS_WEB_ENTRY", "PI_HARNESS_GIT"];

function runFixture(t, args, expected) {
  const home = mkdtempSync(join(tmpdir(), "alehouse-scout-return-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const name of ["xdg-config", "xdg-state", "xdg-cache", "xdg-data"]) mkdirSync(join(home, name));
  const env = { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, "agent"),
    XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_STATE_HOME: join(home, "xdg-state"),
    XDG_CACHE_HOME: join(home, "xdg-cache"), XDG_DATA_HOME: join(home, "xdg-data"),
    PI_JEV_API_KEY_FILE: join(home, "nonexistent-test-key"), PI_OFFLINE: "1", NO_COLOR: "1" };
  for (const key of inheritedRoots) assert.equal(env[key], undefined);
  // Deliberately no inherited credentials, provider configuration, subagent
  // hints, NODE_OPTIONS, approval/network opt-ins, or harness roots.
  const output = execFileSync(process.execPath, [join(packageRoot, "test/runtime/fixtures/scout-return-to.mjs"), ...args], {
    cwd: packageRoot, env, encoding: "utf8", timeout: 55000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, expected);
  assert.equal(output.includes("SCOUT_BODY_MARKER_9c4e2a"), false);
}

test("real composition scout return_to delivers a hidden source to the worker without a parent relay, offline", { timeout: 60000 }, (t) => {
  runFixture(t, [], /PASS: real composition scout return_to hands the source marker to the worker without a parent relay or source body; shutdown disposes both sessions; nothing leaves the process/);
});

for (const permission of ["ask", "deny"]) {
  test(`compound scout return_to rejects agent_answer ${permission} before source allocation, offline`, { timeout: 60000 }, (t) => {
    runFixture(t, [`--answer-permission=${permission}`], new RegExp(`PASS: compound scout return_to is rejected for agent_answer ${permission} before source allocation, with no human approval and the pending question retained`));
  });
}
