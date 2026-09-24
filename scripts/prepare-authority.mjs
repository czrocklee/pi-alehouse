import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./generate-workers.mjs";

export function prepareAuthority(output = join(packageRoot, "runtime/permission-system"), root = packageRoot) {
  // A direct dependency, never the ambient/global Pi installation. Keep its
  // package boundary (#src imports), source and parser WASM assets intact.
  const upstream = resolve(dirname(createRequire(join(root, "package.json")).resolve("@gotgenes/pi-permission-system")), "..");
  const pkg = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
  assert.equal(pkg.version, "32.0.3", "Permission authority must be pinned to 32.0.3");
  mkdirSync(output, { recursive: true });
  const vendor = join(output, "vendor");
  rmSync(vendor, { recursive: true, force: true });
  cpSync(upstream, vendor, { recursive: true, dereference: true,
    filter: (path) => !path.slice(upstream.length).split(/[\\/]/).includes("node_modules") });
  execFileSync(process.execPath, [join(root, "permission-system/apply-patch.mjs"), vendor], { stdio: "inherit" });
  cpSync(join(root, "permission-system/authority-guard.ts"), join(output, "authority-guard.ts"));
  const scratch = readFileSync(join(root, "permission-system/managed-scratch.ts"), "utf8");
  const oldRoot = '"./node_modules/@gotgenes/pi-permission-system/';
  assert.equal(scratch.split(oldRoot).length, 3, "Managed scratch import-layout drift");
  writeFileSync(join(output, "managed-scratch.ts"), scratch.replaceAll(oldRoot, '"./vendor/'));
  writeFileSync(join(output, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n");
  writeFileSync(join(output, "index.ts"), `// Generated private authority; every consumer imports this same entry.
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, protectionResources } from "../../bin/runtime-support.mjs";
import { initializeManagedResourceProtection, getManagedResourceProtection } from "./vendor/src/policy/managed-resource-protection.ts";
import permissions from "./vendor/src/index.ts";
import { guardSingleAuthority } from "./authority-guard.ts";
import { installManagedScratch } from "./managed-scratch.ts";
import { hardenGitInput, hardenStaticFileInput } from "./vendor/src/access-intent/bash/managed-read-policy.ts";
export { getPermissionsService } from "./vendor/src/service.ts";
export { initializeManagedResourceProtection, getManagedResourceProtection };
export default function (pi: ExtensionAPI) {
  // Standalone authority loads (including normal Pi) get the same immutable
  // floor. Internal children may request only an already-covered subset.
  initializeManagedResourceProtection(protectionResources({}, process.env, packageRoot, getPackageDir()));
  guardSingleAuthority(pi);
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const audit = await hardenGitInput(event.input);
    if (audit) pi.appendEntry("managed-git-read", audit);
  });
  installManagedScratch(pi, hardenStaticFileInput);
  permissions(pi);
}
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareAuthority();
