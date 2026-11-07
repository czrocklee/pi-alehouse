import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Included by the existing test/*.test.mjs npm test glob.
test("compaction progress is a bounded, fake-clock pure UI projection", () => {
  const run = spawnSync(
    process.execPath,
    [new URL("../scripts/check-pi-compaction-progress.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /PASS: compaction progress pure UI/);
});
