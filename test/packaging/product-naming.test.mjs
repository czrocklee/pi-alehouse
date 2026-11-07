import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
// Source roots only: build output, dependencies and lockfiles are not ours.
const roots = ["bin", "docs", "nix", "resources", "scripts", "src", "test", ".github"];
const topLevel = [
  "AGENTS.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
  "package.json",
  "flake.nix",
  "tsconfig.json",
  "eslint.config.mjs",
  "release-policy.json",
  ".gitignore",
  ".prettierignore",
];
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });

test("harness appears only as a generic domain term, never as a product or identifier name", () => {
  const files = [
    ...roots
      .map((root) => join(repo, root))
      .filter((root) => existsSync(root))
      .flatMap(walk),
    ...topLevel.map((name) => join(repo, name)).filter((path) => existsSync(path)),
  ].filter((path) => path !== self);
  assert(files.length > 100, "the scan must cover the source tree");
  const offenders = files.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        /harness/i.test(line.replace(/\btest[ -]harness(?:es)?\b/gi, ""))
          ? [`${relative(repo, path)}:${index + 1}: ${line.trim().slice(0, 120)}`]
          : [],
      ),
  );
  assert.deepEqual(
    offenders,
    [],
    "Use Alehouse for product names and orchestration for the internal layer; " +
      "'harness' is allowed only as a generic term such as 'test harness'.",
  );
});
