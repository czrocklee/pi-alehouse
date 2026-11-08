import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { generateWorkers, packageRoot } from "./generate-workers.mjs";
import { prepareAuthority } from "./prepare-authority.mjs";
import { digest, webEntry } from "../../bin/runtime-support.mjs";

// Deterministic and offline. Publish generated assets after patches and source
// compilation succeed; never mutate dependency installs.
const stage = mkdtempSync(join(packageRoot, ".generated-build-"));
try {
  webEntry(packageRoot);
  generateWorkers(stage);
  prepareAuthority(join(stage, "authority"));
  // The guard and the authority must read the same lexical leaf and grammar:
  // the authority's static-allow exclusion reuses the guard's former predicates.
  for (const name of [
    "git-read-grammar.ts",
    "shell-literal.ts",
    "git-invocation.ts",
    "static-allow-exclusion.ts",
  ]) {
    const sourceDigest = digest(readFileSync(join(packageRoot, "src/extensions/lib", name)));
    for (const copy of [
      `extensions/lib/${name}`,
      `authority/vendor/src/access-intent/bash/${name}`,
    ]) {
      assert.equal(
        digest(readFileSync(join(stage, copy))),
        sourceDigest,
        `Shared lexical/grammar drift: ${copy}`,
      );
    }
  }
  // Source-owned authority helpers must survive copying/import normalization
  // unchanged, for both literal-path identity and privilege-command detection.
  for (const [source, copy] of [
    ["managed-literal-path.ts", "access-intent/managed-literal-path.ts"],
    ["managed-redirect-target.ts", "access-intent/bash/managed-redirect-target.ts"],
    ["managed-privilege-command.ts", "access-intent/bash/managed-privilege-command.ts"],
    ["managed-privilege-inspection.ts", "access-intent/bash/managed-privilege-inspection.ts"],
    ["managed-heredoc-execution.ts", "access-intent/bash/managed-heredoc-execution.ts"],
  ]) {
    assert.equal(
      digest(readFileSync(join(stage, "authority/vendor/src", copy))),
      digest(readFileSync(join(packageRoot, "src/authority", source))),
      `Authority helper drift: ${copy}`,
    );
  }
  mkdirSync(join(stage, "seeds"));
  for (const name of ["alehouse-presets.json", "permissions.json"])
    cpSync(join(packageRoot, "resources", name), join(stage, "seeds", name));
  // Mirror the source topology in disposable compiler output. TypeScript uses
  // the checked declarations; copy JS/declaration pairs verbatim, not inferred
  // replacement declarations. Runtime code loads source/generated assets only.
  const compiled = join(stage, ".compiled");
  const require = createRequire(import.meta.url);
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      join(packageRoot, "tsconfig.json"),
      "--outDir",
      compiled,
    ],
    { stdio: "inherit" },
  );
  cpSync(join(packageRoot, "src/shared"), join(compiled, "shared"), { recursive: true });
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
  renameSync(compiled, join(packageRoot, "dist"));
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(stage, path)] = digest(readFileSync(path));
      else throw new Error(`Unexpected non-regular runtime asset: ${path}`);
    }
  }
  visit(stage);
  writeFileSync(
    join(stage, "manifest.json"),
    JSON.stringify({ version: 1, files }, null, 2) + "\n",
  );
  rmSync(join(packageRoot, "generated"), { recursive: true, force: true });
  renameSync(stage, join(packageRoot, "generated"));
  console.log(
    "Generated private Alehouse runtime (permission authority 32.0.3; web access 0.47.0)",
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
