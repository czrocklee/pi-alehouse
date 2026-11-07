import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const directory = new URL(
  "../../../runtime/permission-system/vendor/src/access-intent/bash/",
  import.meta.url,
);
const policy = await jiti.import(fileURLToPath(new URL("managed-read-policy.ts", directory)));
const inspection = await jiti.import(fileURLToPath(new URL("managed-inspection.ts", directory)));
const staticFiles = await jiti.import(fileURLToPath(new URL("managed-static-files.ts", directory)));

function scratch(t) {
  const path = mkdtempSync("/tmp/tmp.");
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const stat = lstatSync(path, { bigint: true });
  return {
    path,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

test("managed read compatibility entry re-exports the same provenance functions", () => {
  assert.equal(policy.hardenStaticFileInput, staticFiles.hardenStaticFileInput);
  assert.equal(policy.managedStaticFileScope, inspection.managedStaticFileScope);
  assert.equal(policy.originalGitCommands, inspection.originalGitCommands);
  const forged = { command: "cp a b", fileScope: { command: "cp a b", marked: [true] } };
  assert.equal(policy.managedStaticFileScope(forged), undefined);
  assert.equal(policy.originalGitCommands(forged), undefined);
});

test("static hardening shares private scope and originals without executing the copy", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root.path, "source.txt"), "synthetic source\n");
  const source = `cp ${root.path}/source.txt ${root.path}/target.txt`;
  const input = { command: source };
  const audit = await policy.hardenStaticFileInput(input, [root], root.path);
  assert.equal(audit.version, 1);
  assert.notEqual(input.command, source);
  assert.equal(existsSync(join(root.path, "target.txt")), false);
  const scope = inspection.managedStaticFileScope(input);
  assert.equal(scope, policy.managedStaticFileScope(input));
  assert.equal(scope.command, input.command);
  assert(
    scope.accesses.some(
      (access) => access.path === join(root.path, "source.txt") && access.effect === "read",
    ),
  );
  assert(
    scope.accesses.some(
      (access) => access.path === join(root.path, "target.txt") && access.effect === "write",
    ),
  );
  assert.deepEqual(inspection.originalGitCommands(input), [source]);
  assert.equal(policy.managedStaticFileScope({ ...input }), undefined);
  assert.equal(policy.originalGitCommands({ ...input }), undefined);
});

test("changed commands and a reused invocation cannot inherit static scope", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root.path, "source.txt"), "fixture\n");
  const input = { command: `cp ${root.path}/source.txt ${root.path}/target.txt` };
  await policy.hardenStaticFileInput(input, [root], root.path);
  const hardened = input.command;
  assert(policy.managedStaticFileScope(input));
  input.command = "true";
  assert.equal(policy.managedStaticFileScope(input), undefined);
  assert.equal(policy.originalGitCommands(input), undefined);
  input.command = hardened;
  assert(policy.managedStaticFileScope(input));
  await policy.hardenStaticFileInput(input, [], root.path);
  assert.equal(policy.managedStaticFileScope(input), undefined);
});

test("static-file provenance still refuses symlink sources", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root.path, "source.txt"), "fixture\n");
  symlinkSync("source.txt", join(root.path, "link.txt"));
  const command = `cp ${root.path}/link.txt ${root.path}/target.txt`;
  const input = { command };
  assert.equal(await policy.hardenStaticFileInput(input, [root], root.path), undefined);
  assert.equal(input.command, command);
  assert.equal(policy.managedStaticFileScope(input), undefined);
});
