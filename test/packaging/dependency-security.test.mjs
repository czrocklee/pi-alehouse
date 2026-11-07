import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const manifestUrl = new URL("../../package.json", import.meta.url);
const require = createRequire(manifestUrl);
const consumers = ["eslint", "@eslint/config-array", "@typescript-eslint/typescript-estree"];
const safeVersion = "11.0.3";

// Resolve from each consumer, not just the repository root: an apparently safe
// top-level copy must not conceal a vulnerable nested lint dependency.
const fromConsumer = (name) => createRequire(require.resolve(name));

test("minimatch overrides are scoped to the three lint consumers and actually resolve", () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  assert.deepEqual(
    manifest.overrides,
    Object.fromEntries(consumers.map((name) => [name, { minimatch: safeVersion }])),
  );
  for (const name of consumers) {
    assert.equal(fromConsumer(name)("minimatch/package.json").version, safeVersion, name);
  }
});

test("every locked minimatch copy excludes GHSA-g3hv-75wg-m249's affected range", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const copies = Object.entries(lock.packages).filter(
    ([path]) => path.split("node_modules/").at(-1) === "minimatch",
  );
  assert(copies.length > 0, "must inspect at least one locked minimatch copy");
  for (const [path, { version }] of copies) {
    assert.match(version, /^\d+\.\d+\.\d+$/, path);
    const [major, minor, patch] = version.split(".").map(Number);
    assert(
      major < 7 || major > 11 || (major === 11 && (minor > 0 || patch >= 1)),
      `${path}@${version} is in the advisory's affected range >=7.0.0 <11.0.1`,
    );
  }
});

test("the overridden CommonJS matcher APIs retain bounded lint glob behavior", () => {
  const cases = [
    ["src/orchestration/core/result-text.ts", "src/orchestration/**/*.ts", {}, true],
    ["src/shared/usage-attribution.mjs", "src/{orchestration,shared}/**/*.{ts,mjs}", {}, true],
    ["dist/orchestration/extension.js", "src/orchestration/**/*.ts", {}, false],
    ["src/orchestration/.hidden/input.ts", "src/orchestration/**/*.ts", { dot: true }, true],
    ["src/shared/.hidden.mjs", "src/shared/**/*.mjs", {}, false],
    ["src/shared/input.mjs", "!src/shared/**/*.mjs", { nonegate: true }, false],
    ["src/shared/input.ts", "**/*.mjs", {}, false],
    ["src/shared/space name.mjs", "**/*.mjs", {}, true],
  ];
  for (const name of consumers) {
    const { minimatch, Minimatch } = fromConsumer(name)("minimatch");
    for (const [path, pattern, options, expected] of cases) {
      assert.equal(minimatch(path, pattern, options), expected, `${name}: ${pattern}`);
      assert.equal(new Minimatch(pattern, options).match(path), expected, `${name}: ${pattern}`);
    }
  }
});
