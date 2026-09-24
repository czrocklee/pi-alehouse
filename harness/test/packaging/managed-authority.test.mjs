import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixtureBootstrap, parseManagedSelection, resolveManagedAuthority } from "../support/managed-authority.mjs";

const selection = { version: 1, entryPoint: "/synthetic/runtime/permission-system/index.ts" };
// Exercise the complete read/check sequence without generating runtime. No SDK is imported.
for (const fault of [undefined, "bootstrap", "package-name"]) test(`managed closure integrity: ${fault ?? "valid"}`, (t) => {
  const agentDir = "/synthetic/agent", closure = dirname(selection.entryPoint);
  const permissionRoot = join(closure, "vendor");
  const permissionEntry = join(agentDir, "extensions/managed-permissions/index.ts");
  const files = new Map([
    [join(agentDir, "managed-permissions.json"), JSON.stringify(selection)],
    [permissionEntry, fault === "bootstrap" ? "changed bootstrap" : fixtureBootstrap(selection.entryPoint)],
    [join(permissionRoot, "package.json"), JSON.stringify({ name: fault === "package-name" ? "wrong-package" : "@gotgenes/pi-permission-system", version: "32.0.3" })],
    [selection.entryPoint, "managed factory"], [join(closure, "authority-guard.ts"), "guard"],
    [join(closure, "managed-scratch.ts"), "scratch"],
    [join(permissionRoot, "src/access-intent/bash/managed-read-policy.ts"), "managed read proof"],
  ]);
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path, encoding) => {
    assert(files.has(path), `Unexpected fixture read: ${path}`);
    return encoding ? files.get(path) : Buffer.from(files.get(path));
  });
  syncBuiltinESMExports();
  try {
    if (fault === "bootstrap") assert.throws(() => resolveManagedAuthority(agentDir), /MANAGED_BOOTSTRAP_CONTENT_CHANGED/);
    else if (fault === "package-name") assert.throws(() => resolveManagedAuthority(agentDir), (error) => error.actual === "wrong-package" && error.expected === "@gotgenes/pi-permission-system");
    else {
      const resolved = resolveManagedAuthority(agentDir);
      assert.equal(resolved.permissionRoot, permissionRoot); assert.equal(resolved.permissionEntry, permissionEntry);
      assert.equal(resolved.authority.sources.length, 6);
      assert(resolved.authority.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256)));
    }
  } finally {
    // Restore named builtin imports synchronously before another test can run.
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
});
test("managed selector parses a version-1 absolute runtime authority index.ts", () => {
  assert.deepEqual(parseManagedSelection(JSON.stringify(selection)), selection);
});
for (const invalid of [null, {}, { ...selection, version: 2 }, { ...selection, entryPoint: "index.ts" },
  { ...selection, entryPoint: "file:///runtime/permission-system/index.ts" }, { ...selection, entryPoint: "/tmp/fake/index.ts" },
  { ...selection, entryPoint: "/runtime/permission-system/src/index.ts" }, { ...selection, entryPoint: 42 }]) {
  test(`managed selector rejects ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => parseManagedSelection(JSON.stringify(invalid)), /INVALID_MANAGED_PERMISSION_SELECTOR/);
  });
}
test("malformed JSON is not a fallback signal", () => {
  assert.throws(() => parseManagedSelection("{"), SyntaxError);
});
for (const kind of ["absent", "dangling", "invalid", "missing-closure"]) test(`managed selection fails closed: ${kind}`, (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "managed-selection-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  // A public npm tree must not rescue any failure, including an absent selector.
  const publicRoot = join(agentDir, "npm/node_modules/@gotgenes/pi-permission-system");
  mkdirSync(publicRoot, { recursive: true });
  writeFileSync(join(publicRoot, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system", version: "32.0.3" }));
  const selectorPath = join(agentDir, "managed-permissions.json");
  if (kind === "dangling") symlinkSync(join(agentDir, "missing"), selectorPath);
  if (kind === "invalid") writeFileSync(selectorPath, "{}");
  if (kind === "missing-closure") {
    writeFileSync(selectorPath, JSON.stringify(selection));
    mkdirSync(join(agentDir, "extensions/managed-permissions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions/managed-permissions/index.ts"), fixtureBootstrap(selection.entryPoint));
  }
  assert.throws(() => resolveManagedAuthority(agentDir), kind === "invalid" ? /INVALID_MANAGED_PERMISSION_SELECTOR/ : /ENOENT/);
});
