import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

const harness = fileURLToPath(new URL("../../", import.meta.url));
const resources = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: resources, overrideConfigFile: join(harness, "eslint.config.mjs") });
// lintText only: no fixture code runs, no files are rewritten, and no SDK/model
// is instantiated. An existing project file gives the real project service a
// TSConfig owner without permitting a broad, untyped default project.
const probe = (text, filePath = join(harness, "src/core/result-text.ts")) => eslint.lintText(text, { filePath });

for (const [name, code, rule] of [
  ["floating Promise", "export function f() { Promise.resolve(1); }", "@typescript-eslint/no-floating-promises"],
  ["void is not a rejection handler", "export function f() { void Promise.resolve(1); }", "@typescript-eslint/no-floating-promises"],
  ["detached finally", "export function f() { void Promise.resolve().finally(() => {}); }", "@typescript-eslint/no-floating-promises"],
  ["misused async callback", "export const callback: () => void = async () => {};", "@typescript-eslint/no-misused-promises"],
  ["unsafe JSON assignment", 'export const value: number = JSON.parse("1");', "@typescript-eslint/no-unsafe-assignment"],
  ["unsafe call", 'export function f() { return JSON.parse("null").run(); }', "@typescript-eslint/no-unsafe-call"],
  ["explicit any", "export function f(value: any): unknown { return value; }", "@typescript-eslint/no-explicit-any"],
  ["unused import", 'import { join } from "node:path"; export const value = 1;', "@typescript-eslint/no-unused-vars"],
  ["redundant assertion", "const value: number = Math.random(); export const copy = value as number;", "@typescript-eslint/no-unnecessary-type-assertion"],
  ["unbound method", "const obj = { value: 1, get() { return this.value; } }; export const get = obj.get;", "@typescript-eslint/unbound-method"],
]) test(`typed lint rejects ${name}`, async () => {
  const [result] = await probe(code);
  assert(result.messages.some((message) => message.ruleId === rule && message.severity === 2), JSON.stringify(result.messages));
  assert.equal(result.fatalErrorCount, 0, "a parser/config error must not masquerade as rule coverage");
});

test("typed lint accepts observed Promises and synchronous implementations of async ports", async () => {
  const [result] = await probe(`
export async function port() { return 1; }
export async function awaited() { return await port(); }
export function observed() { void port().catch((error: unknown) => { console.error(error); }); }
export function forwarded() { return port(); }
`);
  assert.deepEqual(result.messages, []);
});

test("unused lint suppressions fail rather than accumulating exceptions", async () => {
  const [result] = await probe("// eslint-disable-next-line no-debugger -- deliberately unused probe\nexport const value = 1;");
  assert(result.messages.some((message) => message.severity === 2 && /Unused eslint-disable directive/.test(message.message)));
});

test("JS fixtures and shared leaves use real lint rules, not a silently ignored path", async () => {
  for (const filePath of [join(harness, "test/unit/tools.test.mjs"), join(resources, "lib/usage-attribution.mjs")]) {
    assert.equal(await eslint.isPathIgnored(filePath), false);
    const [result] = await probe('const unused = 1; nonexistent(); require("node:fs");', filePath);
    assert(result.messages.some((message) => message.ruleId === "no-unused-vars"));
    assert(result.messages.some((message) => message.ruleId === "no-undef" && message.message.includes("'require'")),
      "ES modules must not inherit CommonJS globals");
    assert.equal(result.fatalErrorCount, 0);
  }
  for (const filePath of ["dist/extension.js", "node_modules/fixture/index.js"]) {
    assert.equal(await eslint.isPathIgnored(join(harness, filePath)), true);
  }
});

test("local check command is fail-fast lint, typecheck, then tests, without autofix", () => {
  const pkg = JSON.parse(readFileSync(join(resources, "package.json"), "utf8"));
  assert.equal(pkg.scripts.check, "npm run lint && npm run typecheck && npm test && npm run test:policy");
  assert.match(pkg.scripts.lint, /--max-warnings 0/);
  assert.doesNotMatch(pkg.scripts.lint, /--fix/);
  const { compilerOptions } = JSON.parse(readFileSync(join(harness, "tsconfig.json"), "utf8"));
  for (const key of ["strict", "noUncheckedIndexedAccess", "noUnusedLocals", "noUnusedParameters"]) {
    assert.equal(compilerOptions[key], true, key);
  }
});
