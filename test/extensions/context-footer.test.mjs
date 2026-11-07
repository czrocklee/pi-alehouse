import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("context footer shares SDK totals and pins without provider or credential IO", () => {
  const run = spawnSync(
    process.execPath,
    [new URL("../../scripts/checks/check-pi-context-footer.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /PASS: context footer integration/);
});
