// Home Manager activation only. Tests supply an isolated settings path.
import assert from "node:assert/strict";
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [path, bootstrapSource] = process.argv.slice(2);
assert(path && bootstrapSource, "Usage: node migrate-settings.mjs SETTINGS_PATH BOOTSTRAP_SOURCE");
assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Pi settings must be a regular file");
const old = readFileSync(path, "utf8");
const settings = JSON.parse(old);
assert(settings && typeof settings === "object" && !Array.isArray(settings));
assert(settings.packages === undefined || Array.isArray(settings.packages));
let found = false;
settings.packages = (settings.packages ?? []).map(entry => {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string" || !/^npm:@gotgenes\/pi-permission-system(?:@[^\s]+)?$/.test(source)) return entry;
  assert(!found, "Duplicate permission-system package entries; resolve manually");
  found = true;
  return { ...(typeof entry === "string" ? {} : entry), source: "npm:@gotgenes/pi-permission-system@32.0.3", extensions: [] };
});
if (!found) settings.packages.push({ source: "npm:@gotgenes/pi-permission-system@32.0.3", extensions: [] });
// Publish the durable bootstrap BEFORE disabling npm's automatic extension.
// HM does not own this leaf, so rolling back removes only the selector. Keep
// this regular and self-contained: an unmanaged store symlink is not a GC root.
const marker = "// pi-managed-permissions-bootstrap v1\n";
const bootstrap = readFileSync(bootstrapSource, "utf8");
assert(bootstrap.startsWith(marker), "Invalid permission bootstrap source");
const extensionDir = join(dirname(path), "extensions");
const bootstrapDir = join(extensionDir, "managed-permissions");
for (const directory of [extensionDir, bootstrapDir]) {
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), "Pi bootstrap directories must not be symlinks");
}
const bootstrapPath = join(bootstrapDir, "index.ts");
let existing;
try { existing = lstatSync(bootstrapPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  assert(existing.isFile() && !existing.isSymbolicLink(), "Pi bootstrap must be a regular file");
  assert(readFileSync(bootstrapPath, "utf8").startsWith(marker), "Refusing to overwrite an unrelated Pi extension");
}
function atomicWrite(target, content) {
  const temporary = `${target}.managed-permissions-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
}
atomicWrite(bootstrapPath, bootstrap);
if (JSON.stringify(JSON.parse(old)) !== JSON.stringify(settings)) {
  const backup = `${path}.before-managed-permissions-v1`;
  try { copyFileSync(path, backup, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`);
}
