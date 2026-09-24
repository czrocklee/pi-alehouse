import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const vendor = resolve(import.meta.dirname, "../runtime/permission-system/vendor/src");
const jiti = createJiti(import.meta.url, { interopDefault: false });
const protectionApi = await jiti.import(join(vendor, "policy/managed-resource-protection.ts"));
const { PermissionManager } = await jiti.import(join(vendor, "policy/permission-manager.ts"));
const { PermissionResolver } = await jiti.import(join(vendor, "policy/permission-resolver.ts"));
const { AccessPath } = await jiti.import(join(vendor, "access-intent/access-path.ts"));
const { posixPathFlavor: flavor } = await jiti.import(join(vendor, "path/path-flavor.ts"));
const dir = mkdtempSync(join(tmpdir(), "alehouse-protection-"));
const root = join(dir, "runtime[dev]");
const credentials = join(dir, "keys", "jev.key");
mkdirSync(root); mkdirSync(join(dir, "keys")); mkdirSync(join(dir, "work"));
writeFileSync(join(root, "index.ts"), "// synthetic runtime\n");
writeFileSync(credentials, "synthetic-not-a-credential\n");
symlinkSync(root, join(dir, "runtime-link"));
symlinkSync(credentials, join(dir, "key-link"));
after(() => rmSync(dir, { recursive: true, force: true }));

assert.throws(() => protectionApi.requireManagedResourceProtection(), /must initialize/);
const protection = protectionApi.initializeManagedResourceProtection({ writeRoots: [root], readFiles: [credentials] });
function resolver(yolo = false, explicitDeny = false) {
  const allow = { permission: { "*": "allow", path: { "*": "allow" }, path_write: { "*": "allow" } } };
  const loader = {
    getCacheStamp: () => "fixture",
    loadGlobalConfig: () => explicitDeny ? { permission: { ...allow.permission, path_read: { [credentials]: "deny" } } } : allow,
    loadProjectConfig: () => explicitDeny ? {} : allow,
    loadAgentConfig: (name) => explicitDeny ? {} : name === "reader" ? { permission: { path_write: { "*": "deny" } } } : allow,
    loadProjectAgentConfig: () => explicitDeny ? {} : allow,
    getConfigIssues: () => [],
    getConfiguredMcpServerNames: () => [],
  };
  const manager = new PermissionManager({ policyLoader: loader, resourceProtection: protection, isYoloEnabled: () => yolo });
  return new PermissionResolver(manager, { getRuleset: () => explicitDeny ? [] : [
    { surface: "path_read", pattern: "*", action: "allow", layer: "session", origin: "global" },
    { surface: "path_write", pattern: "*", action: "allow", layer: "session", origin: "global" },
  ] });
}
function query(r, surface, path, agentName, resolveBase = dir) {
  return r.resolve({ kind: "access-path", surface, path: AccessPath.forPath(path, { cwd: dir, resolveBase, flavor }), agentName });
}

for (const profile of [undefined, "reader", "editor"]) for (const yolo of [false, true]) {
  test(`protected resources survive project/session grants and yolo=${yolo} for ${profile ?? "parent"}`, () => {
    const r = resolver(yolo);
    for (const path of [join(root, "index.ts"), "runtime-link/index.ts", "runtime[dev]/new.ts", "runtime[dev]", dir]) {
      const result = query(r, "path_write", path, profile);
      assert.equal(result.state, "deny", path);
      assert.equal(typeof result.matchedPattern, "string", "upstream gates must not discard the deny as an unmatched default");
    }
    assert.equal(query(r, "path_write", "index.ts", profile, root).state, "deny", "literal cd-adjusted path");
    for (const path of [credentials, "key-link"]) for (const surface of ["path_read", "path_write", "path"]) {
      assert.equal(query(r, surface, path, profile).state, "deny", `${surface} ${path}`);
    }
    assert.equal(query(r, "path_read", join(root, "index.ts"), profile).state, "allow", "source remains readable");
    assert.equal(query(r, "path_write", join(dir, "runtime[dev]-sibling", "file"), profile).state,
      profile === "reader" ? "deny" : "allow", "separator-bounded literal matching, not globs/prefixes");
    assert.equal(query(r, "path_write", join(dir, "work", "file"), profile).state, profile === "reader" ? "deny" : "allow");
  });
}

test("snapshot is deeply frozen, non-replaceable and cannot be widened by a later generation", () => {
  assert.equal(protectionApi.requireManagedResourceProtection(), protection);
  assert(Object.isFrozen(protection)); assert(Object.isFrozen(protection.writeRoots));
  assert.throws(() => protection.writeRoots.push("/"), TypeError);
  assert.throws(() => { globalThis[Symbol.for("pi-alehouse:managed-resource-protection:v1")] = {}; }, TypeError);
  assert.equal(protectionApi.initializeManagedResourceProtection({ writeRoots: [join(root, "sub")], readFiles: [credentials] }), protection);
  assert.throws(() => protectionApi.initializeManagedResourceProtection({ writeRoots: [join(dir, "different")], readFiles: [] }), /generation changed/);
});

test("existing explicit denial retains its policy provenance", () => {
  const result = query(resolver(false, true), "path_read", credentials);
  assert.equal(result.state, "deny");
  assert.equal(result.origin, "global");
  assert.equal(result.matchedPattern, credentials);
});
