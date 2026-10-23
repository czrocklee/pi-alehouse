// Synthetic source-evidence checks, not a permission or installed-host test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fixtureBootstrap, resolveManagedAuthority } from "../support/managed-authority.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "alehouse-authority-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), closure = join(root, "runtime/permission-system");
  const entryPoint = join(closure, "index.ts"), observer = join(closure, "managed-block-observer.ts");
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put(join(agentDir, "managed-permissions.json"), JSON.stringify({ version: 1, entryPoint }));
  put(join(agentDir, "extensions/managed-permissions/index.ts"), fixtureBootstrap(entryPoint));
  put(join(closure, "vendor/package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system", version: "32.0.3" }));
  for (const file of ["index.ts", "authority-guard.ts", "managed-scratch.ts", "managed-block-observer.ts",
    "vendor/src/access-intent/bash/managed-read-policy.ts"]) put(join(closure, file), `// synthetic ${file}\n`);
  const vocabulary = join(closure, "../lib/managed-block-tools.mjs");
  put(vocabulary, "// synthetic observation vocabulary\n");
  return { agentDir, observer, vocabulary, put };
}

test("managed observer source changes alter recorded authority evidence", (t) => {
  const f = fixture(t), before = resolveManagedAuthority(f.agentDir).authority;
  const original = before.sources.find(({ path }) => path === f.observer);
  assert(original, "the observer is an explicit source in the evidence");
  const changed = "// changed synthetic observer\n";
  f.put(f.observer, changed);
  const after = resolveManagedAuthority(f.agentDir).authority;
  assert.notDeepEqual(after.sources, before.sources);
  assert.equal(after.sources.find(({ path }) => path === f.observer).sha256,
    createHash("sha256").update(changed).digest("hex"));
  assert.deepEqual(after.sources.filter(({ path }) => path !== f.observer),
    before.sources.filter(({ path }) => path !== f.observer), "other explicit source hashes stay unchanged");
});

test("shared observation vocabulary is also part of authority source evidence", (t) => {
  const f = fixture(t), before = resolveManagedAuthority(f.agentDir).authority;
  const original = before.sources.find(({ path }) => path === f.vocabulary);
  assert(original, "behavior-defining shared vocabulary is hashed");
  f.put(f.vocabulary, "// changed vocabulary\n");
  assert.notEqual(resolveManagedAuthority(f.agentDir).authority.sources.find(({ path }) => path === f.vocabulary).sha256,
    original.sha256);
});

test("missing observer source fails evidence collection rather than silently omitting coverage", (t) => {
  const f = fixture(t);
  rmSync(f.observer);
  assert.throws(() => resolveManagedAuthority(f.agentDir), { code: "ENOENT" });
});
