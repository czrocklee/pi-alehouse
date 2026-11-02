import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./generate-workers.mjs";
import { normalizeVendorImports, removeGlobalNpmProbe } from "./normalize-runtime-imports.mjs";

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
    filter: (path) => {
      const parts = relative(upstream, path).split(/[\\/]/);
      // Non-executable upstream documentation need not be shipped/hashed on
      // every launch. Retain LICENSE, package imports, schemas and WASM assets.
      return !parts.includes("node_modules") && !["docs", "README.md", "CHANGELOG.md"].includes(parts[0]);
    } });
  execFileSync(process.execPath, [join(root, "permission-system/apply-patch.mjs"), vendor], { stdio: "inherit" });
  const discovery = join(vendor, "src/path/node-modules-discovery.ts");
  writeFileSync(discovery, removeGlobalNpmProbe(readFileSync(discovery, "utf8"), discovery));
  normalizeVendorImports(vendor);
  cpSync(join(root, "permission-system/authority-guard.ts"), join(output, "authority-guard.ts"));
  cpSync(join(root, "permission-system/managed-block-observer.ts"), join(output, "managed-block-observer.ts"));
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
import { createManagedBlockObserver } from "./managed-block-observer.ts";
import { installManagedScratch } from "./managed-scratch.ts";
import { hardenGitInput, hardenStaticFileInput } from "./vendor/src/access-intent/bash/managed-read-policy.ts";
export { bindWorkspacePolicy } from "./vendor/src/policy/managed-workspace-policy.ts";
import { originalBashDeny } from "../policy/static-safety-guard.ts";
import { getPermissionsService } from "./vendor/src/service.ts";
export { getPermissionsService };
const { subscribeManagedBlocks, wrapManagedBlocks } = createManagedBlockObserver(getPermissionsService);
export { subscribeManagedBlocks };
export { initializeManagedResourceProtection, getManagedResourceProtection };
export default function (pi: ExtensionAPI) {
  // Standalone authority loads (including normal Pi) get the same immutable
  // floor. Internal children may request only an already-covered subset.
  initializeManagedResourceProtection(protectionResources({}, process.env, packageRoot, getPackageDir()));
  const managedPi = wrapManagedBlocks(pi);
  guardSingleAuthority(managedPi);
  managedPi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    if (typeof event.input.command === "string") {
      const reason = originalBashDeny(event.input.command, ctx);
      if (reason) return { block: true, reason };
    }
    const audit = await hardenGitInput(event.input, ctx.cwd);
    if (audit) managedPi.appendEntry("managed-git-read", audit);
  });
  installManagedScratch(managedPi, hardenStaticFileInput);
  permissions(managedPi);
}
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareAuthority();
