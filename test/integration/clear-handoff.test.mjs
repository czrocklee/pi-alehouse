import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/clear-handoff.mjs", import.meta.url));

for (const [scenario, description] of Object.entries({
  custom: "/clear transfers only live custom routing and UI settings once",
  base: "startup, /clear and resume preserve routing; /new and unrelated sessions use defaults",
})) {
  test(`real composition: ${description}, offline`, { timeout: 60000 }, (t) => {
    const home = mkdtempSync(join(tmpdir(), "alehouse-clear-handoff-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
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
        ALEHOUSE_CLEAR_FIXTURE_HOME: home,
        PI_JEV_API_KEY_FILE: join(home, "nonexistent-fixture-key"),
        PI_JEV_APPROVAL_MODE: "shadow",
        PI_OFFLINE: "1",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 55000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(output.includes(`PASS: ${scenario}, offline`), output);
  });
}
