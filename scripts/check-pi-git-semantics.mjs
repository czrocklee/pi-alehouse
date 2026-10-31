#!/usr/bin/env node
// Compatibility collector name. The retired submodule/history/object/rename
// provenance proof is intentionally NOT a gate obligation. Its replacement
// checks literal syntax, permission restrictions and normal Git approval.
// No requested Git command, helper, shell, network or model is executed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [repo, executable, resources] = process.argv.slice(2);
assert(repo && executable && resources && process.env.PI_MANAGED_PERMISSIONS_ROOT,
  "REPO PI_EXECUTABLE GENERATED_RESOURCES and built PI_MANAGED_PERMISSIONS_ROOT required");
const query = readFileSync(join(repo, "permission-system/managed-git-query.ts"), "utf8");
assert.doesNotMatch(query, /node:child_process|execFileSync|spawnSync|managed-git-unattributed|find-object=/,
  "classifier has no Git subprocess or historical attribution implementation");
const patch = readFileSync(join(repo, "permission-system/apply-patch.mjs"), "utf8");
assert.doesNotMatch(patch, /cdHomeTarget|homeStableProgram/, "HOME AST folding is retired");
assert.match(patch, /applyRedirectArgvPatch\(root, patch\)/, "general redirect-buried argv repair retained");
execFileSync(process.execPath, [join(repo, "scripts/check-pi-git-grammar.mjs")], { stdio: "inherit", timeout: 30000 });
execFileSync(process.execPath, [join(repo, "scripts/check-pi-git-read.mjs"), repo, executable, resources], { stdio: "inherit", timeout: 90000 });
console.log("PASS: literal Git contract collector; no historical file enumeration, blob attribution, helper isolation or native output equivalence claim");
