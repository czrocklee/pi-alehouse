// Fixture-only selection of the portable, patched runtime authority. No live
// activation, installed npm fallback, version negotiation or settings migration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseManagedSelection(text) {
  const selection = JSON.parse(text);
  assert(selection?.version === 1 && typeof selection.entryPoint === "string" &&
    isAbsolute(selection.entryPoint) && basename(selection.entryPoint) === "index.ts" &&
    basename(dirname(selection.entryPoint)) === "permission-system",
  "INVALID_MANAGED_PERMISSION_SELECTOR");
  return selection;
}
export const fixtureBootstrap = (entryPoint) => `// Isolated fixture; never discover an installed npm authority.\nexport { default } from ${JSON.stringify(entryPoint)};\n`;

export function resolveManagedAuthority(agentDir) {
  assert(agentDir && isAbsolute(agentDir), "ISOLATED_MANAGED_AGENT_DIR_REQUIRED");
  const selector = join(agentDir, "managed-permissions.json");
  const selection = parseManagedSelection(readFileSync(selector, "utf8"));
  const closure = dirname(selection.entryPoint);
  const permissionRoot = join(closure, "vendor");
  const permissionEntry = join(agentDir, "extensions/managed-permissions/index.ts");
  assert.equal(readFileSync(permissionEntry, "utf8"), fixtureBootstrap(selection.entryPoint),
    "MANAGED_BOOTSTRAP_CONTENT_CHANGED");
  const pkg = JSON.parse(readFileSync(join(permissionRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@gotgenes/pi-permission-system");
  assert.equal(pkg.version, "32.0.3", "MANAGED_VENDOR_VERSION_CHANGED");
  const sources = [selector, permissionEntry, selection.entryPoint,
    join(closure, "authority-guard.ts"), join(closure, "managed-scratch.ts"),
    join(permissionRoot, "src/access-intent/bash/managed-read-policy.ts")].map((path) => ({ path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  return { permissionRoot, permissionEntry, authority: { kind: "portable-managed", selector: selection, permissionRoot, sources } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, agentDir, output] = process.argv.slice(2);
  assert(repo && agentDir && output, "Use the isolating harness wrappers");
  const selection = { version: 1, entryPoint: join(resolve(repo), "runtime/permission-system/index.ts") };
  // Required matched generated closure, not an unpatched dependency or ambient install.
  const { verifyRuntime } = await import("../../../bin/runtime-support.mjs");
  verifyRuntime(resolve(repo));
  readFileSync(selection.entryPoint);
  const bootstrap = join(agentDir, "extensions/managed-permissions/index.ts");
  mkdirSync(dirname(bootstrap), { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "managed-permissions.json"), JSON.stringify(selection), { mode: 0o600, flag: "wx" });
  writeFileSync(bootstrap, fixtureBootstrap(selection.entryPoint), { mode: 0o600, flag: "wx" });
  const { authority } = resolveManagedAuthority(agentDir);
  writeFileSync(join(output, "managed-authority.json"), JSON.stringify(authority, null, 2), { mode: 0o600, flag: "wx" });
}
