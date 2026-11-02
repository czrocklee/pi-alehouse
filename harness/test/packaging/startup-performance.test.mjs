import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { normalizeRuntimeImports, removeGlobalNpmProbe } from "../../../scripts/normalize-runtime-imports.mjs";
import { packageRoot, verifyRuntime } from "../../../bin/runtime-support.mjs";

const temporary = (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-startup-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const put = (path, text = "export {};") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const upstream = join(dirname(createRequire(import.meta.url).resolve("@gotgenes/pi-permission-system")), "..");

test("vendor specifier normalization covers runtime/type edges without rewriting data or assets", (t) => {
  const vendor = temporary(t), file = join(vendor, "src/index.ts");
  put(join(vendor, "src/value.ts")); put(join(vendor, "src/group/index.ts"));
  put(join(vendor, "src/parser.wasm"), "asset");
  const source = `import type { Value } from "#src/value";
export type { Value } from "./value.js";
export * from "./group";
type Deferred = import("./value").Value;
const lazy = () => import("#src/group");
const required = require("./group");
import parser from "./parser.wasm";
import external from "external-package";
// import("#src/value") is documentation, not an edge.
const data = "#src/value";
`;
  const normalized = normalizeRuntimeImports(source, file, vendor);
  for (const expected of ['from "#src/value.ts"', 'from "./value.ts"', 'from "./group/index.ts"',
    'import("./value.ts")', 'import("#src/group/index.ts")', 'require("./group/index.ts")',
    'from "./parser.wasm"', 'from "external-package"', '// import("#src/value")', 'data = "#src/value"']) {
    assert(normalized.includes(expected), expected);
  }
  assert.equal(normalizeRuntimeImports(normalized, file, vendor), normalized, "idempotent generation");
  assert.throws(() => normalizeRuntimeImports('import "./missing";', file, vendor), /Unresolved runtime import/);
  assert.throws(() => normalizeRuntimeImports('import "../../outside";', file, vendor), /escaped its package/);
});

test("checkout discovery has no subprocess and installed discovery retains exactly its existing ancestor", async (t) => {
  const root = temporary(t), sourcePath = join(upstream, "src/path/node-modules-discovery.ts");
  const source = removeGlobalNpmProbe(readFileSync(sourcePath, "utf8"), sourcePath);
  assert.doesNotMatch(source, /spawnSync|child_process|npm.*root/);
  const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  const entry = join(root, "discovery.mjs"); put(entry, emitted);
  const { discoverGlobalNodeModulesRoot } = await import(pathToFileURL(entry).href);
  assert.equal(discoverGlobalNodeModulesRoot(pathToFileURL(join(root, "checkout/runtime/vendor/src/path/discovery.ts")).href), null);
  for (const base of [join(root, "npm-prefix"), join(root, "nix-store/lib")]) {
    const tree = join(base, "node_modules");
    assert.equal(discoverGlobalNodeModulesRoot(pathToFileURL(join(tree, "pi-alehouse/runtime/permission-system/vendor/src/path/discovery.ts")).href), tree);
  }
  assert.equal(discoverGlobalNodeModulesRoot("not a file URL"), null);
});

test("generated infrastructure paths retain the explicit host directory without adding dependency read allowances", async (t) => {
  const root = temporary(t), config = join(root, "config/extension-paths.mjs");
  const source = readFileSync(join(packageRoot, "runtime/permission-system/vendor/src/config/extension-paths.ts"), "utf8");
  const parsed = ts.createSourceFile(config, source, ts.ScriptTarget.Latest, true);
  const imports = parsed.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
  assert.deepEqual(imports, ["node:path", "#src/path/node-modules-discovery.ts", "./config-paths.ts"]);
  // Compile the real generated caller with controlled pure dependencies. This
  // checks its exact allow set, not a newly invented root-selection algorithm.
  const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
    .replace('"#src/path/node-modules-discovery.ts"', '"../path/discovery.mjs"').replace('"./config-paths.ts"', '"./config-paths.mjs"');
  put(config, emitted);
  put(join(root, "path/discovery.mjs"), "export const discoverGlobalNodeModulesRoot = () => null;");
  put(join(root, "config/config-paths.mjs"), 'export const getGlobalLogsDir = (dir) => dir + "/logs";');
  const { computeExtensionPaths } = await import(pathToFileURL(config).href);
  const agent = join(root, "agent"), host = join(root, "host");
  assert.deepEqual(computeExtensionPaths(agent, host).piInfrastructureDirs, [agent, join(agent, "git"), host]);
});

test("runtime manifest omits non-executable vendor docs but retains license, imports and WASM support", () => {
  const runtime = verifyRuntime(packageRoot);
  const { files } = JSON.parse(readFileSync(join(runtime, "manifest.json"), "utf8"));
  assert(files["permission-system/vendor/LICENSE"]);
  assert(!Object.keys(files).some((path) => /^permission-system\/vendor\/(?:docs\/|README\.md$|CHANGELOG\.md$)/.test(path)));
  const pkg = JSON.parse(readFileSync(join(runtime, "permission-system/vendor/package.json"), "utf8"));
  assert.equal(pkg.imports["#src/*"], "./src/*");
  assert(Object.keys(files).some((path) => path.endsWith("src/access-intent/bash/parser.ts")), "the installed-dependency WASM resolver remains in the executable closure");
  assert.doesNotMatch(readFileSync(join(runtime, "permission-system/vendor/src/path/node-modules-discovery.ts"), "utf8"), /spawnSync|node:child_process/);
});

test("harness keeps host-loader source entry and emits native-compatible .js relative specifiers", () => {
  const config = JSON.parse(readFileSync(join(packageRoot, "harness/tsconfig.json"), "utf8"));
  assert.equal(config.compilerOptions.allowImportingTsExtensions, true);
  assert.equal(config.compilerOptions.rewriteRelativeImportExtensions, true);
  const composition = readFileSync(join(packageRoot, "composition.ts"), "utf8");
  assert(composition.includes('"harness/src/extension.ts"'));
  assert(!composition.includes("harness/dist/extension.js"));
  const extension = readFileSync(join(packageRoot, "harness/src/extension.ts"), "utf8");
  assert.doesNotMatch(extension, /createJiti|hostRequire|dist\/index\.js/);
  const emitted = readFileSync(join(packageRoot, "harness/dist/runtime/parent-web.js"), "utf8");
  assert(emitted.includes('"./child-web.js"'));
  assert.doesNotMatch(emitted, /from "\.\/.+\.ts"/);
  for (const entry of ["bin/pi-alehouse.mjs", "composition.ts"]) {
    assert.match(readFileSync(join(packageRoot, entry), "utf8"), /\bpreflight\(\)/, `${entry}: verification must not be skipped`);
  }
});
