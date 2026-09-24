import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDirectory, packageRoot, protectionResources, verifyAgentResources, verifyRuntime } from "../bin/runtime-support.mjs";

function ensureDirectory(path) {
  const parent = dirname(path);
  if (parent !== path) ensureDirectory(parent);
  try {
    // Never write through a conflicting directory symlink, including dangling
    // symlinks. Existing real directories and existing leaf files are untouched.
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Preserved conflicting directory: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; ensureDirectory(path); }
  }
}
export function initialize({ agentDir = agentDirectory(), root = packageRoot } = {}) {
  agentDir = resolve(agentDir);
  const runtime = verifyRuntime(root);
  const files = new Map();
  for (const name of ["editor", "reader", "Explore", "Plan", "general-purpose"]) files.set(`agents/${name}.md`, readFileSync(join(runtime, "agents", `${name}.md`)));
  files.set("harness-presets.json", readFileSync(join(runtime, "seeds/harness-presets.json")));
  const policy = JSON.parse(readFileSync(join(runtime, "seeds/permissions.json"), "utf8"));
  // Visible seed rules mirror the immutable authority floor. Existing config
  // files remain untouched; the runtime floor also covers those deployments.
  const protection = protectionResources({ agentDir }, process.env, root);
  const aliases = (path) => {
    let ancestor = path;
    const tail = [];
    for (;;) {
      try { return [...new Set([path, join(realpathSync(ancestor), ...tail)])]; }
      catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        if (dirname(ancestor) === ancestor) throw error;
        tail.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
  };
  for (const path of protection.readFiles.flatMap(aliases)) {
    policy.permission.path[path] = "deny";
    policy.permission.path_write[path] = "deny";
  }
  for (const path of protection.writeRoots.flatMap(aliases)) {
    policy.permission.path_write[path] = "deny";
    policy.permission.path_write[join(path, "*")] = { action: "deny", reason: "Executable policy, dependencies and Pi configuration must be edited outside the agent." };
  }
  files.set("extensions/pi-permission-system/config.json", JSON.stringify(policy, null, 2) + "\n");
  const created = [], preserved = [];
  for (const [name, bytes] of files) {
    const path = join(agentDir, name);
    ensureDirectory(dirname(path));
    try {
      // O_EXCL preserves regular files and symlinks even when dangling.
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      created.push(path);
    } catch (error) { if (error.code !== "EEXIST") throw error; preserved.push(path); }
  }
  // No ready marker. A partial/failed init is not a runnable installation.
  verifyAgentResources(agentDir, root);
  return { created, preserved };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(initialize(), null, 2)); }
  catch (error) { console.error(`pi-alehouse init: ${error.message}`); process.exitCode = 1; }
}
