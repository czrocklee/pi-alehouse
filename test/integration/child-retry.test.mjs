import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/fast-mode.mjs", import.meta.url));
for (const [scenario, description] of [
  ["retry-disk-enabled", "four attempts from disk, then one after a live disable"],
  ["retry-disk-disabled", "three attempts after a live enable with a budget of two"],
]) {
  test(
    `real composition: ${description}; child transport retries stay off, offline`,
    { timeout: 60000 },
    (t) => {
      const home = mkdtempSync(join(tmpdir(), "alehouse-child-retry-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      // Own all state before loading Pi; do not inherit credentials or network opt-ins.
      const output = execFileSync(process.execPath, [fixture, scenario], {
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_DATA_HOME: join(home, ".local/share"),
          XDG_STATE_HOME: join(home, ".local/state"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          ALEHOUSE_CHILD_RETRY_FIXTURE_HOME: home,
          PI_JEV_API_KEY_FILE: join(home, "nonexistent-fixture-key"),
          PI_JEV_APPROVAL_MODE: "shadow",
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 55000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert(output.includes(`PASS: child ${scenario}, offline`), output);
    },
  );
}
