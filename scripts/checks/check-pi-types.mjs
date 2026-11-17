#!/usr/bin/env node
// Check the pinned SDK, extension sources and actual built authority, without
// emitting anything or filtering compiler diagnostics. The shared JS bodies
// need their separate check since NodeNext otherwise prefers the declarations.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const cwd = resolve(process.argv[2] ?? ".");
if (!existsSync(join(cwd, "generated/authority/index.ts"))) {
  throw new Error("Missing generated authority entry. Run npm run build before typechecking.");
}
const tsc = join(cwd, "node_modules/typescript/bin/tsc");
if (!existsSync(tsc))
  throw new Error("Missing checkout-local TypeScript compiler. Run npm ci first.");
const run = (...args) => execFileSync(process.execPath, args, { cwd, stdio: "inherit" });
run("test/support/shared-library-types.mjs", "src/shared");
run(tsc, "-p", "scripts/checks/tsconfig.extensions.json");
