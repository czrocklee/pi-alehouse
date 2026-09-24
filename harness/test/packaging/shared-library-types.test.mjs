import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLibraryPairs, readLibraryPairs } from "../support/shared-library-types.mjs";

const pairs = readLibraryPairs();
const mutate = (name, field, from, to) => pairs.map((pair) => {
  if (pair.name !== name) return pair;
  assert(pair[field].includes(from), `mutation target disappeared: ${name} ${from}`);
  return { ...pair, [field]: pair[field].replace(from, to) };
});

test("all shared JS bodies and their separately resolved declarations agree", () => {
  assert(pairs.some((pair) => pair.name === "usage-attribution"));
  assert.deepEqual(checkLibraryPairs(pairs), []);
});

for (const [name, module, field, from, to] of [
  ["accounting output type", "usage-attribution", "declaration", "cost: number", "cost: string"],
  ["reader input type", "usage-attribution", "declaration", "readUsageAttribution(usage: unknown)", "readUsageAttribution(usage: number)"],
  ["any return escape", "usage-attribution", "declaration", "usageTotals(usage: unknown): UsageTotals", "usageTotals(usage: unknown): any"],
  ["optional option drift", "token-format", "declaration", "trimKZero?: boolean;", "trimKZero?: boolean; minDigits?: number;"],
  ["literal protocol drift", "overlay-protocol", "implementation", "pi-harness:hide-transient-overlays", "pi-harness:changed"],
  ["undeclared runtime export", "overlay-protocol", "implementation", "export const HIDE", "export const extra = 1;\nexport const HIDE"],
]) test(`shared declaration guard rejects ${name}`, () => {
  const failures = checkLibraryPairs(mutate(module, field, from, to));
  assert(failures.some((failure) => /contracts\.mts.*TS2344/.test(failure)), failures.join("\n"));
});

test("checkJs inspects the actual body even when its JSDoc and declaration still agree", () => {
  const failures = checkLibraryPairs(mutate("token-format", "implementation", 'return "?";', "return 17;"));
  assert(failures.some((failure) => /implementation\/token-format\.mjs.*TS2322/.test(failure)), failures.join("\n"));
});

test("module discovery fails on missing or orphan declarations instead of skipping a pair", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-shared-pairs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => readLibraryPairs(directory), /No shared JavaScript/);
  writeFileSync(join(directory, "example.mjs"), "export const value = 1;");
  assert.throws(() => readLibraryPairs(directory), /paired declaration/);
  writeFileSync(join(directory, "example.d.mts"), "export const value: 1;");
  assert.deepEqual(checkLibraryPairs(readLibraryPairs(directory)), []);
  writeFileSync(join(directory, "orphan.d.mts"), "export const value: 1;");
  assert.throws(() => readLibraryPairs(directory), /paired declaration/);
});
