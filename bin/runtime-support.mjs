import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function agentDirectory(env = process.env) {
  const path = env.PI_CODING_AGENT_DIR;
  return resolve(path ? path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path : join(homedir(), ".pi/agent"));
}
export function executable(name, override, env = process.env) {
  if (override) assert(isAbsolute(override), `${name} override must be an absolute executable path`);
  const paths = override ? [override] : (env.PATH ?? "").split(":").filter(Boolean).map((p) => resolve(p, name));
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* next PATH entry */ }
  }
  throw new Error(`${name} executable unavailable${override ? `: ${override}` : " on PATH"}`);
}
export function resolveFlock(env = process.env) {
  assert.equal(process.platform, "linux", "Alehouse requires Linux util-linux flock; no weaker lock fallback");
  const candidates = env.PI_HARNESS_FLOCK ? [env.PI_HARNESS_FLOCK] :
    ["/usr/bin/flock", "/bin/flock", "/run/current-system/sw/bin/flock"];
  for (const candidate of candidates) {
    assert(isAbsolute(candidate), "flock override must be an absolute executable path");
    try {
      const path = executable("flock", candidate, env);
      const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 });
      assert(result.status === 0 && /flock from util-linux\b/.test(result.stdout ?? ""), `Expected util-linux flock: ${path}`);
      return path;
    } catch (error) { if (env.PI_HARNESS_FLOCK) throw error; }
  }
  throw new Error("Linux util-linux flock unavailable; set an explicit absolute PI_HARNESS_FLOCK (PATH is not trusted)");
}
function regular(path) {
  assert(statSync(path).isFile(), `Required resource is not a file: ${path}`);
  return readFileSync(path);
}
export function webEntry(root = packageRoot) {
  // Node's package-local dependency lookup also supports npm's normal hoisting.
  const manifest = createRequire(join(root, "package.json")).resolve("pi-web-access/package.json");
  const web = dirname(manifest);
  let installed = false;
  for (let ancestor = resolve(root); ; ancestor = dirname(ancestor)) {
    try {
      if (realpathSync(join(ancestor, "node_modules/pi-web-access/package.json")) === realpathSync(manifest)) { installed = true; break; }
    } catch { /* Dependency may be hoisted farther up. */ }
    if (dirname(ancestor) === ancestor) break;
  }
  assert(installed, "pi-web-access must belong to this install, not NODE_PATH or an ambient global package");
  const pkg = JSON.parse(regular(manifest));
  assert.equal(pkg.version, "0.31.0", "Package-local pi-web-access must be pinned to 0.31.0");
  assert.deepEqual(pkg.pi.extensions, ["./dist"], "Pinned web extension manifest drift");
  const entry = join(web, "dist/index.js");
  regular(entry);
  return entry;
}
export function verifyRuntime(root = packageRoot) {
  regular(join(root, "composition.ts"));
  const runtime = join(root, "runtime");
  const manifest = JSON.parse(regular(join(runtime, "manifest.json")));
  assert.equal(manifest.version, 1, "Runtime manifest version mismatch; rebuild Alehouse");
  for (const [path, expected] of Object.entries(manifest.files)) {
    const target = resolve(runtime, path);
    assert(!relative(runtime, target).startsWith("..") && !isAbsolute(path), "Invalid runtime manifest path");
    assert.equal(digest(regular(target)), expected, `Runtime resource mismatch: ${path}; rebuild Alehouse`);
  }
  for (const required of ["worker-policy.json", "permission-system/index.ts", "permission-system/vendor/package.json",
    "policy/jev-auto-approval.ts", "policy/static-safety-guard.ts", "policy/policy-grep.ts", "agents/editor.md", "agents/reader.md"]) {
    assert(Object.hasOwn(manifest.files, required), `Incomplete runtime manifest: ${required}`);
  }
  return runtime;
}
export function verifyAgentResources(agentDir = agentDirectory(), root = packageRoot) {
  const runtime = join(root, "runtime");
  for (const name of ["editor", "reader", "Explore", "Plan", "general-purpose"]) {
    const path = join(agentDir, "agents", `${name}.md`);
    assert.equal(digest(regular(path)), digest(regular(join(runtime, "agents", `${name}.md`))),
      `Managed profile mismatch: ${path}. Preserve your file; reconcile it manually before launching.`);
  }
  // Existing Nix/user policy and catalogues remain authoritative, not replaced
  // with seed defaults. Upstream and harness perform full semantic validation.
  const presets = JSON.parse(regular(join(agentDir, "harness-presets.json")));
  assert(presets.version === 2 && typeof presets.defaultPreset === "string" && presets.presets && typeof presets.presets === "object" && !Array.isArray(presets.presets), "Invalid harness-presets.json");
  const permissions = JSON.parse(regular(join(agentDir, "extensions/pi-permission-system/config.json")));
  assert(permissions && permissions.permission && typeof permissions.permission === "object" && !Array.isArray(permissions.permission), "Invalid permission config.json");
}
export function preflight({ root = packageRoot, env = process.env, agentDir = agentDirectory(env) } = {}) {
  const runtime = verifyRuntime(root);
  verifyAgentResources(agentDir, root);
  const flock = resolveFlock(env);
  const permissionRoot = realpathSync(join(runtime, "permission-system"));
  const policyRoot = realpathSync(join(runtime, "policy"));
  // Old environment names remain the internal contract, not an unchecked
  // authority-selection escape hatch. Aliases of this verified generation are
  // accepted; another mutable deployment must use its own launcher/package.
  for (const [key, expected] of [["PI_HARNESS_PERMISSION_ROOT", permissionRoot], ["PI_HARNESS_POLICY_ROOT", policyRoot]]) {
    if (!env[key]) continue;
    assert(isAbsolute(env[key]), `${key} must be absolute`);
    assert.equal(realpathSync(env[key]), expected, `${key} does not identify this verified runtime generation; unset the override`);
  }
  return { runtime, permissionRoot, policyRoot, flock, web: webEntry(root), agentDir };
}
// Resolve executable dependency code using this installation's module graph,
// including npm hoisting and canonical targets of package-manager symlinks.
function dependencyCodeRoots(root) {
  const req = createRequire(join(root, "package.json"));
  const pkg = JSON.parse(regular(join(root, "package.json")));
  const roots = new Set();
  const localTrees = new Set();
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    localTrees.add(join(dir, "node_modules"));
    if (dir === dirname(dir)) break;
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    let found = false;
    // Inspect manifests along Node's local search trees rather than resolving
    // package exports: host peers can be import-only and hide package.json.
    for (const tree of req.resolve.paths(name) ?? []) {
      if (!localTrees.has(tree)) continue;
      const manifest = join(tree, name, "package.json");
      try {
        regular(manifest);
        roots.add(dirname(realpathSync(manifest)));
        roots.add(tree);
        found = true;
        break;
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
    assert(found, `Dependency is outside this installation or missing: ${name}`);
  }
  return [...roots];
}
function absoluteUserPath(path) {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
export function protectionResources(paths = {}, env = process.env, root = packageRoot, hostRoot) {
  const agentDir = paths.agentDir ?? agentDirectory(env);
  const retained = globalThis[Symbol.for("@rocklee/jev-auto-approval:api-key-file")];
  const keyFile = env.PI_JEV_API_KEY_FILE || (typeof retained === "string" ? retained : undefined);
  const readFiles = [join(agentDir, "auth.json"), join(agentDir, "web-search.json"),
    join(homedir(), ".pi/agent/auth.json"), join(homedir(), ".pi/agent/web-search.json"), join(homedir(), ".pi/web-search.json")];
  if (env.XDG_CONFIG_HOME) readFiles.push(join(absoluteUserPath(env.XDG_CONFIG_HOME), "pi/web-search.json"));
  if (keyFile) readFiles.push(absoluteUserPath(keyFile));
  return { writeRoots: [...new Set([resolve(root), agentDir,
    paths.permissionRoot ?? join(root, "runtime/permission-system"), paths.policyRoot ?? join(root, "runtime/policy"),
    ...dependencyCodeRoots(root), ...(hostRoot ? [hostRoot, ...dependencyCodeRoots(hostRoot)] : [])])], readFiles: [...new Set(readFiles)] };
}
export function runtimeEnvironment(paths, env = process.env) {
  return { ...env, PI_CODING_AGENT_DIR: paths.agentDir,
    PI_HARNESS_PERMISSION_ROOT: paths.permissionRoot, PI_HARNESS_POLICY_ROOT: paths.policyRoot,
    PI_HARNESS_FLOCK: paths.flock, PI_AUTO_APPROVAL_MODE: "shadow",
    ...(env.PI_JEV_API_KEY_FILE ? { PI_JEV_API_KEY_FILE: absoluteUserPath(env.PI_JEV_API_KEY_FILE) } : {}),
    PI_JEV_APPROVAL_MODE: env.PI_JEV_APPROVAL_MODE || "enforce-subagents" };
}
