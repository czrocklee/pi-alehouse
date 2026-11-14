// Package-lane subprocesses, not the controlled host collector or live-model evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/child-skills.mjs", import.meta.url));
const cases = {
  preferences: "saved false, real settings toggle and unchanged reused child resources",
  scopes: "default enabled, scoped overrides, project trust and SDK exclusions",
  lock: "transient --no-skills lock overrides saved true without changing preferences",
  authority: "managed per-profile skill gates and ordinary reads with discovery off",
};

for (const [scenario, description] of Object.entries(cases)) {
  test(`real composition child skills: ${description}, offline`, { timeout: 60000 }, (t) => {
    const home = mkdtempSync(join(tmpdir(), "alehouse-composed-skills-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    // Own every state location BEFORE any SDK, authority or composition import.
    // Do not inherit credentials, network opt-ins, resource roots or subagent hints.
    const output = execFileSync(process.execPath, [fixture, scenario], {
      env: {
        HOME: home,
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        ALEHOUSE_CHILD_SKILLS_FIXTURE_HOME: home,
        PI_JEV_API_KEY_FILE: join(home, "nonexistent-fixture-key"),
        PI_JEV_APPROVAL_MODE: "shadow",
        PI_OFFLINE: "1",
        NO_COLOR: "1",
        ...(scenario === "lock" ? { PI_ALEHOUSE_NO_CHILD_SKILLS: "1" } : {}),
      },
      encoding: "utf8",
      timeout: 55000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(output.includes(`PASS: child skills ${scenario}, offline`), output);
  });
}
