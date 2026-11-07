import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const shippedScripts = pkg.files.filter((path) => path.startsWith("scripts/"));
const buildFiles = (directory = "scripts/build/") =>
  readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    assert(entry.isDirectory() || entry.isFile(), `${path} must be a regular build input`);
    return entry.isDirectory() ? buildFiles(`${path}/`) : [path];
  });

// The production tarball is a minimal reproducible runtime: sources, generated
// output, docs, resources, the CLI and its necessary build inputs. Regression
// suites, checker topics, self-tests and private state never ship.
const allowedFiles = [
  /^(bin|src|docs|generated|resources)\//,
  /^scripts\/(?:build\/|init\.mjs$)/,
  /^(tsconfig\.json|eslint\.config\.mjs|release-policy\.json)$/,
  /^(README\.md|THIRD_PARTY_NOTICES\.md|LICENSE)$/,
];

test("tarball allowlist ships only source, docs, generated output, resources, CLI and build inputs", () => {
  for (const path of ["test/", "scripts/"])
    assert(!pkg.files.includes(path), `${path} must not be shipped wholesale`);
  for (const path of pkg.files)
    assert(
      allowedFiles.some((pattern) => pattern.test(path)),
      `${path} is outside the single-package tarball allowlist`,
    );
  for (const path of ["bin/", "src/", "generated/", "resources/"])
    assert(pkg.files.includes(path), `${path} is a required runtime or reproducible build input`);
  assert.deepEqual(shippedScripts, ["scripts/build/", "scripts/init.mjs"]);
});

test("CLI init and source build helpers remain in the slim tarball", () => {
  const cli = readFileSync(new URL("bin/pi-alehouse.mjs", root), "utf8");
  assert.match(cli, /import\("\.\.\/scripts\/init\.mjs"\)/);
  for (const path of shippedScripts) {
    const entry = new URL(path, root);
    if (path.endsWith("/"))
      assert(readdirSync(entry).length > 0, `${path} must not be an empty build input`);
    else assert(readFileSync(entry, "utf8").length > 0, path);
  }
});

test("canonical typecheck invokes its self-contained shared/extension gate only once", () => {
  assert.match(pkg.scripts.typecheck, /tsc/);
  assert.match(pkg.scripts.typecheck, /--noEmit/);
  assert.equal(
    pkg.scripts.typecheck.split("scripts/checks/check-pi-types.mjs").length,
    2,
    "the pinned extension/authority gate must be invoked exactly once",
  );
  const gate = readFileSync(new URL("scripts/checks/check-pi-types.mjs", root), "utf8");
  assert.equal(
    gate.split('[join(repo, "test/support/shared-library-types.mjs")').length,
    2,
    "the gate must typecheck the shared .mjs/.d.mts pairs via the support helper",
  );
  assert.match(gate, /"ext\/\*\*\/\*\.ts"/);
  assert.match(
    gate,
    /"generated\/authority\/vendor\/src\/policy\/managed-resource-protection\.ts"/,
  );
});

// Test payloads stay in the source check lane: not in the tarball, not in the
// generated runtime copy or its integrity manifest, and not loaded by the guard.
const testPayload = /(^|\/)test-support\/|static-safety-selftest|^test\/|^scripts\/checks\//;

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
  assert(paths.includes("src/extensions/static-safety-guard.ts"));
  assert.deepEqual(
    paths.filter((path) => testPayload.test(path)),
    [],
  );
  assert.deepEqual(
    paths.filter((path) => path.startsWith("scripts/")).sort(),
    [...buildFiles(), "scripts/init.mjs"].sort(),
  );
  for (const path of [
    "scripts/build/index.mjs",
    "scripts/build/generate-workers.mjs",
    "scripts/build/prepare-authority.mjs",
    "scripts/build/normalize-runtime-imports.mjs",
    "scripts/build/patches/apply-patch.mjs",
  ])
    assert(paths.includes(path), `${path} is required to reproduce the matched runtime`);
});

test("generated policy copy and its manifest carry no test support", () => {
  assert.equal(existsSync(new URL("src/extensions/test-support", root)), false);
  assert.equal(existsSync(new URL("generated/extensions/test-support", root)), false);
  const manifest = JSON.parse(readFileSync(new URL("generated/manifest.json", root), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.files).filter((path) => testPayload.test(path)),
    [],
  );
});

test("the production static guard has no self-test hook and keeps its policy private", () => {
  const guard = readFileSync(new URL("src/extensions/static-safety-guard.ts", root), "utf8");
  assert.doesNotMatch(
    guard,
    /test-support|static-safety-selftest|PI_STATIC_SAFETY_SELFTEST|createRequire/,
  );
  assert.doesNotMatch(guard, /export\s+(const|let|var)\s+WORKER_POLICY/);
  assert.doesNotMatch(guard, /export\s+function\s+(registerGuard|workerProfiles)\b/);
  assert.match(guard, /const WORKER_POLICY = freezePolicy\(\/\* @worker-policy@ \*\/ \{\}\);/);
});
