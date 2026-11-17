import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLibraryPairs, readLibraryPairs } from "../support/shared-library-types.mjs";

const pairs = readLibraryPairs();
function mutate(fixture, name, field, from, to) {
  const pair = pairs.find((candidate) => candidate.name === name);
  assert(pair?.[field].includes(from), `mutation target disappeared: ${name} ${from}`);
  const fixtureName = `contract-probe-${fixture}`;
  assert(!pairs.some((candidate) => candidate.name === fixtureName), fixtureName);
  return { ...pair, name: fixtureName, [field]: pair[field].replace(from, to) };
}

test("all shared JS bodies and their separately resolved declarations agree", () => {
  assert(pairs.some((pair) => pair.name === "usage-attribution"));
  assert.deepEqual(checkLibraryPairs(pairs), []);
});

test("shared declaration guard rejects each independent contract and JavaScript body mutation", () => {
  // One compiler program loads the ambient types once. Each mutation gets its
  // own module pair; any sibling imports still see the unmodified library.
  const contracts = [
    mutate("output-type", "usage-attribution", "declaration", "cost: number", "cost: string"),
    mutate(
      "reader-input",
      "usage-attribution",
      "declaration",
      "readUsageAttribution(usage: unknown)",
      "readUsageAttribution(usage: number)",
    ),
    mutate(
      "any-return",
      "usage-attribution",
      "declaration",
      "usageTotals(usage: unknown): UsageTotals",
      "usageTotals(usage: unknown): any",
    ),
    mutate(
      "optional-option",
      "token-format",
      "declaration",
      "trimKZero?: boolean;",
      "trimKZero?: boolean; minDigits?: number;",
    ),
    mutate(
      "protocol-literal",
      "overlay-protocol",
      "implementation",
      "pi-alehouse:hide-transient-overlays",
      "fixture:overlay-drift",
    ),
    mutate(
      "extra-export",
      "overlay-protocol",
      "implementation",
      "export const HIDE",
      "export const extra = 1;\nexport const HIDE",
    ),
  ];
  const body = mutate("body-return", "token-format", "implementation", 'return "?";', "return 17;");
  const failures = checkLibraryPairs([...pairs, ...contracts, body]);
  for (const { name } of contracts) {
    assert.equal(
      failures.filter(
        (failure) =>
          /contracts\.mts.*TS2344/.test(failure) &&
          failure.includes(`typeof import("./implementation/${name}.mjs")`),
      ).length,
      1,
      `Expected a contract mismatch for ${name}:\n${failures.join("\n")}`,
    );
  }
  assert.equal(
    failures.filter((failure) =>
      /implementation\/contract-probe-body-return\.mjs.*TS2322/.test(failure),
    ).length,
    1,
    failures.join("\n"),
  );
  // The body-only probe must fail checkJs without also mismatching its API.
  assert.equal(failures.length, contracts.length + 1, failures.join("\n"));
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
