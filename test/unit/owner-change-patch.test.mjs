import assert from "node:assert/strict";
import test from "node:test";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { observeEditPatch, finishEditPatch } = await jiti.import(
  "../../src/orchestration/runtime/owner-change-patch.ts",
);

const detailsFor = (rawPath) => ({
  diff: "display diff",
  patch: `--- ${rawPath}\n+++ ${rawPath}\n@@ -1,1 +1,1 @@\n-apple\n+kiwi\n`,
});

test("sensitive path components suppress plain patch text and net evidence", () => {
  const withheld = { kind: "unavailable", reason: "sensitive" };
  for (const [raw, effective] of [
    [".env.local", "/project/.env.local"],
    ["bundle.pem", "/project/bundle.pem"],
    ["tls.key", "/project/tls.key"],
    ["key.bin", "/home/test/.ssh/key.bin"],
    ["/run/secrets/plain.txt", "/run/secrets/plain.txt"],
    [".CREDENTIALS/child", "/project/.CREDENTIALS/child"],
    ["nested/..//.env/../public.txt", "/project/public.txt"],
    // A source extension isn't proof that unmarked content is safe to publish.
    ["tokens.ts", "/project/src/tokens.ts"],
  ]) {
    const details = detailsFor(raw);
    const evidence = observeEditPatch(details, raw, effective);
    assert.deepEqual(evidence, withheld, raw);
    assert.deepEqual(finishEditPatch(evidence, { details }), { patch: withheld }, raw);
  }
});

test("the path heuristic does not withhold source names that only contain a partial word", () => {
  const raw = "src/tokenizer.ts";
  const details = detailsFor(raw);
  const { patch, net } = finishEditPatch(observeEditPatch(details, raw, `/project/${raw}`), {
    details,
  });
  assert.equal(patch.kind, "edit");
  assert.equal(patch.redacted, false);
  assert.deepEqual(
    patch.lines.map(({ text }) => text),
    ["apple", "kiwi"],
  );
  assert(net);
});

const sdkEdit = (path, before, edits) =>
  createEditTool("/project", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(before),
      writeFile: async () => {},
    },
  }).execute("synthetic-edit", { path, edits });
const preview = (path, result) =>
  finishEditPatch(observeEditPatch(result.details, path, `/project/${path}`), result);
const sensitive = { patch: { kind: "unavailable", reason: "sensitive" } };

for (const path of ["values.yaml", "values.yaml.tmpl", "user-data"]) {
  test(`withholds both sides of a pinned SDK YAML credential plain scalar change: ${path}`, async () => {
    const oldText = "  token: old opening\n    mock old part";
    const newText = "  token: new opening\n    mock new part";
    const result = await sdkEdit(path, `settings:\n${oldText}\n  enabled: true\n`, [
      { oldText, newText },
    ]);
    assert.match(result.details.patch, /^- {2}token: old opening\n- {4}mock old part$/m);
    assert.match(result.details.patch, /^\+ {2}token: new opening\n\+ {4}mock new part$/m);
    assert.deepEqual(preview(path, result), sensitive);
  });
}

test("withholds a credential scalar in an inline YAML flow mapping on an extensionless path", async () => {
  const path = "user-data";
  for (const key of ["token", '"token"']) {
    const oldText = `settings: [{${key}: old opening\n  mock old part, enabled: true}]`;
    const newText = `settings: [{${key}: new opening\n  mock new part, enabled: true}]`;
    const result = await sdkEdit(path, `${oldText}\n`, [{ oldText, newText }]);
    assert.match(result.details.patch, /^- {2}mock old part,/m);
    assert.match(result.details.patch, /^\+ {2}mock new part,/m);
    assert.deepEqual(preview(path, result), sensitive, key);
  }
});

test("withholds an INI-style credential assignment with equally ambiguous continuation rows", async () => {
  const path = "app.conf";
  const oldText = "token = old opening\n  mock old part";
  const newText = "token = new opening\n  mock new part";
  const result = await sdkEdit(path, `[settings]\n${oldText}\n`, [{ oldText, newText }]);
  assert.match(result.details.patch, /^- {2}mock old part$/m);
  assert.match(result.details.patch, /^\+ {2}mock new part$/m);
  assert.deepEqual(preview(path, result), sensitive);
});

test("a changed assignment also withholds a continuation beyond the first SDK hunk", async () => {
  const path = "user-data";
  const oldText = "password: old opening";
  const middle = Array.from({ length: 25 }, (_, i) => `  mock middle part ${i}\n`).join("");
  const result = await sdkEdit(path, `${oldText}\n${middle}  mock old ending\nenabled: true\n`, [
    { oldText, newText: "password: new opening" },
    { oldText: "mock old ending", newText: "mock new ending" },
  ]);
  assert.equal(result.details.patch.match(/^@@/gm).length, 2);
  assert.match(result.details.patch, /^- {2}mock old ending\n\+ {2}mock new ending$/m);
  assert.deepEqual(preview(path, result), sensitive);
});

test("an ordinary pinned SDK YAML scalar without a credential marker stays visible", async () => {
  const path = "user-data";
  const result = await sdkEdit(path, "label: sample\n  old words\n", [
    { oldText: "old words", newText: "new words" },
  ]);
  const { patch, net } = preview(path, result);
  assert.equal(patch.kind, "edit");
  assert.equal(patch.redacted, false);
  assert.deepEqual(
    patch.lines.map(({ text }) => text),
    ["  old words", "  new words"],
  );
  assert(net);
});
