import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("tarball allowlist excludes regression suites and maintainer-only check scripts", () => {
  for (const path of ["harness/test/", "test/", "scripts/"])
    assert(!pkg.files.includes(path), `${path} must not be shipped wholesale`);
  for (const path of [
    "bin/",
    "composition.ts",
    "harness/src/",
    "runtime/",
    "lib/",
    "extensions/",
    "permission-system/",
    "resources/",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    assert(pkg.files.includes(path), `${path} is a required runtime or reproducible build input`);
  assert.deepEqual(
    pkg.files.filter((path) => path.startsWith("scripts/")),
    [
      "scripts/build.mjs",
      "scripts/generate-workers.mjs",
      "scripts/init.mjs",
      "scripts/normalize-runtime-imports.mjs",
      "scripts/prepare-authority.mjs",
    ],
  );
});

test("CLI init and source build helpers remain in the slim tarball", () => {
  const cli = readFileSync(new URL("bin/pi-alehouse.mjs", root), "utf8");
  assert.match(cli, /import\("\.\.\/scripts\/init\.mjs"\)/);
  for (const path of pkg.files.filter((path) => path.startsWith("scripts/")))
    assert(readFileSync(new URL(path, root), "utf8").length > 0, path);
});

test("canonical typecheck invokes its self-contained shared/extension gate only once", () => {
  assert.equal(
    pkg.scripts.typecheck,
    "tsc -p harness/tsconfig.json --noEmit && node scripts/check-pi-types.mjs",
  );
  const gate = readFileSync(new URL("scripts/check-pi-types.mjs", root), "utf8");
  assert.equal(gate.split('[join(harness, "test/support/shared-library-types.mjs")').length, 2);
  assert.match(gate, /"ext\/\*\*\/\*\.ts"/);
});

// Test payloads stay in the source check lane: not in the tarball, not in the
// generated runtime copy or its integrity manifest, and not loaded by the guard.
const testPayload =
  /(^|\/)test-support\/|static-safety-selftest|^harness\/test\/|^test\/|^scripts\/checks\//;

test("actual tarball members exclude test payloads and maintainer-only scripts", () => {
  const npm = process.env.npm_execpath;
  const result = spawnSync(
    npm ? process.execPath : "npm",
    [...(npm ? [npm] : []), "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const [{ files }] = JSON.parse(result.stdout);
  const paths = files.map((file) => file.path);
  assert(paths.includes("extensions/static-safety-guard.ts"));
  assert.deepEqual(
    paths.filter((path) => testPayload.test(path)),
    [],
  );
  assert.deepEqual(
    paths.filter((path) => path.startsWith("scripts/")).sort(),
    pkg.files.filter((path) => path.startsWith("scripts/")).sort(),
  );
});

test("generated policy copy and its manifest carry no test support", () => {
  assert.equal(existsSync(new URL("extensions/test-support", root)), false);
  assert.equal(existsSync(new URL("runtime/policy/test-support", root)), false);
  const manifest = JSON.parse(readFileSync(new URL("runtime/manifest.json", root), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.files).filter((path) => testPayload.test(path)),
    [],
  );
});

test("the production static guard has no self-test hook and keeps its policy private", () => {
  const guard = readFileSync(new URL("extensions/static-safety-guard.ts", root), "utf8");
  assert.doesNotMatch(
    guard,
    /test-support|static-safety-selftest|PI_STATIC_SAFETY_SELFTEST|createRequire/,
  );
  assert.doesNotMatch(guard, /export\s+(const|let|var)\s+WORKER_POLICY/);
  assert.doesNotMatch(guard, /export\s+function\s+(registerGuard|workerProfiles)\b/);
  assert.match(guard, /const WORKER_POLICY = freezePolicy\(\/\* @worker-policy@ \*\/ \{\}\);/);
});
