import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { generateWorkers, packageRoot } from "./generate-workers.mjs";
import { prepareAuthority } from "./prepare-authority.mjs";
import { digest, webEntry } from "../bin/runtime-support.mjs";

// Runtime-only, deterministic and offline. Publish after every patch succeeds;
// never mutate dependency installs or leave a failed build marked complete.
const stage = mkdtempSync(join(packageRoot, ".runtime-build-"));
try {
  webEntry(packageRoot);
  generateWorkers(stage);
  prepareAuthority(join(stage, "permission-system"));
  mkdirSync(join(stage, "seeds"));
  for (const name of ["harness-presets.json", "permissions.json"]) cpSync(join(packageRoot, "resources", name), join(stage, "seeds", name));
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(stage, path)] = digest(readFileSync(path));
      else throw new Error(`Unexpected non-regular runtime asset: ${path}`);
    }
  }
  visit(stage);
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ version: 1, files }, null, 2) + "\n");
  rmSync(join(packageRoot, "runtime"), { recursive: true, force: true });
  renameSync(stage, join(packageRoot, "runtime"));
  console.log("Generated private Alehouse runtime (permission authority 32.0.3; web access 0.31.0)");
} finally { rmSync(stage, { recursive: true, force: true }); }
