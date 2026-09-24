import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const typeGate = fileURLToPath(new URL("../../../scripts/check-pi-types.mjs", import.meta.url));
const baseline = "ext/policy-grep.ts(1,1): error TS2322: existing intentional file/code baseline";
const fakeTsc = `#!/usr/bin/env node
const fixture = JSON.parse(process.env.PI_TYPEGATE_FIXTURE);
if (process.argv.includes("--version")) {
  process.stdout.write(fixture.version ?? "Version fixture-5.9.3\\n");
  process.stderr.write(fixture.versionError ?? "");
  process.exit(fixture.versionStatus ?? 0);
}
if (!process.argv.includes("--pretty") || !process.argv.includes("false")) throw new Error("expected plain diagnostics");
process.stdout.write(fixture.stdout);
process.stderr.write(fixture.stderr ?? "");
if (fixture.signal) process.kill(process.pid, "SIGTERM");
if (fixture.crash) throw new Error("synthetic compiler exception");
process.exit(fixture.status ?? 2);
`;

function runGate(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-type-gate-regression-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), agent = join(root, "agent"), scratch = join(root, "scratch");
  const harness = join(repo, "harness");
  for (const directory of [
    "scripts", "extensions", "lib", "harness/test/support", "node_modules/.bin",
    "node_modules/@earendil-works", "node_modules/@types", "node_modules/typebox",
    "node_modules/@gotgenes/pi-permission-system",
  ]) mkdirSync(join(repo, directory), { recursive: true });
  mkdirSync(join(agent, "npm/node_modules/@gotgenes/pi-permission-system"), { recursive: true });
  mkdirSync(scratch);
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(harness, "test/support/shared-library-types.mjs"), "// unrelated shared checker fixture\n");
  const compiler = join(repo, "node_modules/.bin/tsc");
  writeFileSync(compiler, overrides.startFailure ? "#!/nonexistent/pi-typegate-interpreter\n" : fakeTsc);
  chmodSync(compiler, 0o755);
  const result = spawnSync(process.execPath, [typeGate, repo, agent], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, TMPDIR: scratch, PI_TYPEGATE_FIXTURE: JSON.stringify({ stdout: `${baseline}\n`, ...overrides }) },
  });
  assert(!result.error, result.error?.message);
  assert.equal(result.signal, null);
  assert.deepEqual(readdirSync(scratch), [], "all handled outcomes remove scratch state");
  return result;
}

test("extension type gate accepts the single known file/code baseline and its continuation", (t) => {
  const result = runGate(t, { stdout: `${baseline}\n  Continuation of the accepted diagnostic.\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: Pi extensions typecheck.*fixture-5\.9\.3, 1 baselined/);
});

for (const [name, diagnostic, expected] of [
  ["extension", "ext/other.ts(2,3): error TS2339: extra extension failure", /ext\/other\.ts:2:3: error TS2339/],
  ["relative dependency", "node_modules/package/index.ts(1,1): error TS2345: dependency failure", /node_modules\/package\/index\.ts:1:1/],
  ["absolute dependency", "/tmp/project (fixture)/node_modules/package/index.ts(1,1): error TS2345: external failure", /\/tmp\/project \(fixture\)\/node_modules/],
  ["global", "error TS2688: missing synthetic type definition", /<global>: error TS2688/],
  ["warning", "ext/policy-grep.ts(1,1): warning TS2322: not an accepted error", /warning TS2322/],
]) test(`extension type gate rejects an additional ${name} diagnostic`, (t) => {
  const result = runGate(t, { stdout: `${baseline}\n${diagnostic}\n` });
  assert.equal(result.status, 1); assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stdout, /PASS: Pi extensions/);
});

for (const [name, overrides, expected] of [
  ["missing baseline", { stdout: "", status: 0 }, /Baseline entry no longer occurs/],
  ["duplicate baseline", { stdout: `${baseline}\n${baseline}\n` }, /Baseline expects 1 x TS2322.*found 2/],
  ["signal", { signal: true }, /tsc terminated by signal SIGTERM/],
  ["compiler exception", { crash: true }, /synthetic compiler exception/],
  ["unexpected status", { status: 17 }, /tsc exited abnormally: expected 2.*got 17/],
  ["zero status with error", { status: 0 }, /tsc exited abnormally: expected 2.*got 0/],
  ["compiler launch failure", { startFailure: true }, /tsc failed to run/],
  ["unrecognized output", { stdout: `${baseline}\nunknown compiler failure\n` }, /Unrecognized tsc output/],
  ["stderr without stdout newline", { stdout: baseline, stderr: "error TS2688: separate error\n" }, /<global>: error TS2688/],
  ["indented stderr", { stderr: "  unexpected stderr failure\n" }, /Unrecognized tsc output/],
  ["version failure", { versionStatus: 17 }, /tsc --version exited abnormally/],
  ["version stderr", { versionError: "unexpected warning\n" }, /tsc --version wrote unexpected stderr/],
  ["version format", { version: "unknown version\n" }, /Unexpected tsc --version output/],
]) test(`extension type gate rejects ${name}`, (t) => {
  const result = runGate(t, overrides);
  assert.equal(result.status, 1); assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stdout, /PASS: Pi extensions/);
});
