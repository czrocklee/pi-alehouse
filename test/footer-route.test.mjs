import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Isolated process: this fixture replaces native IO and HOME for its lifetime.
test("footer subscription metadata and virtual-route display use no credential or network IO", () => {
  const run = spawnSync(process.execPath, [new URL("../scripts/check-pi-footer-route.mjs", import.meta.url).pathname], {
    encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /PASS: footer subscription route/);
});
