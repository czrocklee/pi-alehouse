import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const gate = join(root, "scripts/checks/check-pi-types.mjs");
function temporary(t) {
  const cwd = mkdtempSync(join(tmpdir(), "alehouse-type-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function put(cwd, name, text) {
  const path = join(cwd, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function checkFixture(t, files, overrides = {}) {
  const cwd = temporary(t);
  for (const file of files) cpSync(join(root, file), join(cwd, file), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  // Exercise the real npm aggregate. Don't recursively run unrelated suites;
  // the policy stand-in records the actual arguments npm forwarded to it.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  Object.assign(pkg.scripts, {
    lint: "true",
    "test:built": "true",
    "test:policy": "node policy.mjs",
    ...overrides,
  });
  put(cwd, "package.json", JSON.stringify(pkg));
  put(
    cwd,
    "policy.mjs",
    'import {writeFileSync} from "node:fs"; writeFileSync("policy-args.json", JSON.stringify(process.argv.slice(2)));',
  );
  return cwd;
}
function check(cwd) {
  const result = spawnSync("npm", ["--offline", "--silent", "run", "check"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(cwd, ".npm-cache") },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("a missing generation is an error, not a narrower successful typecheck", (t) => {
  const checked = spawnSync(process.execPath, [gate, temporary(t)], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /Missing generated authority entry/);
});

test("an ancestor compiler cannot silently stand in for a missing checkout dependency", (t) => {
  const parent = temporary(t);
  const cwd = join(parent, "checkout");
  put(parent, "node_modules/typescript/bin/tsc", "process.exit(0);");
  put(cwd, "generated/authority/index.ts", "export {};");
  put(cwd, "test/support/shared-library-types.mjs", "export {};");
  const checked = spawnSync(process.execPath, [gate, cwd], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /Missing checkout-local TypeScript/);
});

test("check rejects an orchestration type error without publishing the failed build", (t) => {
  const cwd = checkFixture(t, [
    "bin",
    "scripts/build",
    "resources",
    "src/authority",
    "src/extensions",
    "src/shared",
    "tsconfig.json",
  ]);
  put(cwd, "src/orchestration/probe.ts", "export const x: string = 42;");
  const result = check(cwd);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /src\/orchestration\/probe\.ts[^\n]*TS2322/);
  for (const file of ["dist", "generated", "policy-args.json"])
    assert(!existsSync(join(cwd, file)), file);
});

test("check follows generated authority imports and only hands a passing build to policy", (t) => {
  const cwd = checkFixture(
    t,
    [
      "scripts/checks/check-pi-types.mjs",
      "scripts/checks/tsconfig.extensions.json",
      "test/support/shared-library-types.mjs",
    ],
    { build: "true" },
  );
  put(cwd, "src/shared/one.mjs", "export const one = 1;");
  put(cwd, "src/shared/one.d.mts", "export declare const one: 1;");
  put(cwd, "src/composition.ts", "export {};");
  put(cwd, "generated/authority/index.ts", 'import "./vendor/leaf.ts";');
  const leaf = "generated/authority/vendor/leaf.ts";
  put(cwd, leaf, "export const x: string = 42;");
  const broken = check(cwd);
  assert.notEqual(broken.status, 0, broken.output);
  assert.match(broken.output, /generated\/authority\/vendor\/leaf\.ts[^\n]*TS2322/);
  assert(!existsSync(join(cwd, "policy-args.json")));

  put(cwd, leaf, 'export const x: string = "fixed";');
  const fixed = check(cwd);
  assert.equal(fixed.status, 0, fixed.output);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "policy-args.json"), "utf8")), ["--built"]);
});
