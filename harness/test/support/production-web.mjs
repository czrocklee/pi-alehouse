// A production-shaped pi-web-access install outside this repository: the
// pinned package and its own dependencies, but no Pi SDK anywhere on its
// lookup path, as after `npm install --omit=dev --legacy-peer-deps` beside a
// separately supplied host Pi. Development dependencies must not mask it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function installed(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    assert.notEqual(dirname(directory), directory, `pi-web-access dependency is not installed: ${name}`);
  }
}

/** Returns the copied entry. `root` must be outside any tree holding the SDK. */
export function productionWebLayout(root, entry) {
  const source = realpathSync(dirname(dirname(entry)));
  const target = join(root, "node_modules/pi-web-access");
  mkdirSync(join(target, "dist"), { recursive: true });
  for (const file of ["package.json", "dist/index.js"]) cpSync(join(source, file), join(target, file));
  if (existsSync(join(source, "node_modules"))) {
    cpSync(join(source, "node_modules"), join(target, "node_modules"), { recursive: true, dereference: true });
  }
  const { dependencies = {} } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const name of Object.keys(dependencies)) {
    if (existsSync(join(target, "node_modules", name))) continue;
    const link = join(root, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(installed(source, name), link, "dir");
  }
  for (let directory = target; ; directory = dirname(directory)) {
    for (const scope of ["@earendil-works", "@mariozechner"]) {
      assert(!existsSync(join(directory, "node_modules", scope)), `Pi SDK on the production lookup path: ${directory}`);
    }
    if (dirname(directory) === directory) break;
  }
  const copied = join(target, "dist/index.js");
  // The regression itself: a plain native import cannot resolve the SDK.
  const plain = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1])", pathToFileURL(copied).href],
    { encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH, HOME: root } });
  assert.notEqual(plain.status, 0, "production layout unexpectedly resolved the Pi SDK");
  assert.match(plain.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*@earendil-works|@earendil-works[\s\S]*ERR_MODULE_NOT_FOUND/);
  return copied;
}
