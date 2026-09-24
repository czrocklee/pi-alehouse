#!/usr/bin/env node
// Typecheck the Pi extensions against the real SDK and permission-system types.
//
// `collect-pi-harness-evidence.sh` runs `npm run typecheck` over the harness's own
// src/. This additional gate checks extensions/ and composition.ts, where
// the permission judges live, and that gap is not theoretical: a judge shipped
// with a failure code missing from its own union and a narrowing hole in the
// branch that reads a child's bound authorization, both invisible to every
// other check in this repo because they all exercise behaviour through jiti,
// which strips types without checking them.
//
// The compiler is the harness's pinned TypeScript, not whatever `tsc` is on
// PATH: a type gate that moves with the ambient toolchain reports drift that
// has nothing to do with this repo. Types come from the same pinned SDK and
// from the pinned development permission package, so an API change
// upstream fails here rather than being silently re-inferred as `any`.
//
// Usage: node check-pi-types.mjs REPO [PI_CODING_AGENT_DIR]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [repoArgument] = process.argv.slice(2);
const repo = resolve(repoArgument ?? ".");
assert(existsSync(join(repo, "package.json")), "Usage: node check-pi-types.mjs REPO");
const harness = join(repo, "harness");
const tsc = join(repo, "node_modules/.bin/tsc");
assert(existsSync(tsc), `Run npm ci --prefix ${repo} first.`);
// Consumers resolve .d.mts before .mjs. Independently check the shared JS
// bodies and their declaration surface; compiling declarations alone is not
// evidence that the separately bundled footer and harness implementations fit.
const shared = spawnSync(process.execPath, [join(harness, "test/support/shared-library-types.mjs"),
  join(repo, "lib")], { stdio: "inherit", timeout: 120_000 });
assert.equal(shared.status, 0, `Shared library typecheck failed: ${shared.error?.message ?? shared.signal ?? "contract mismatch"}`);
const extensions = join(repo, "extensions");
const permissionSystem = join(repo, "node_modules/@gotgenes/pi-permission-system");
assert(existsSync(permissionSystem), `Missing pinned development dependency ${permissionSystem}; run npm ci.`);

/**
 * Errors that are accepted as they stand, keyed by file and TypeScript code
 * with an exact count. A new error fails; so does one that disappears, because
 * a stale entry silently widens what the gate lets through.
 */
const BASELINE = [
  {
    file: "ext/policy-grep.ts",
    code: "TS2322",
    count: 1,
    // Deliberate divergence, not drift. The SDK's GrepToolDetails describes
    // output truncation; this tool's details carry policy-exclusion counts
    // instead, and everything a reader needs is already appended to the text
    // content. Spreading the SDK definition also inherits its renderers, which
    // read the fields they know and ignore these. Fixing the type means either
    // re-declaring the tool's generic or dropping the spread, and both are
    // larger changes to a tool this gate was not added to rewrite.
    why: "policy-grep reports exclusion counts in details where the SDK types truncation state",
  },
];

const scratch = mkdtempSync(join(tmpdir(), "pi-types-"));
try {
  // A real node_modules tree rather than tsconfig `paths`: NodeNext resolves
  // through each package's own `exports` map, so the types checked here are the
  // ones the runtime loader would pick.
  const modules = join(scratch, "node_modules");
  mkdirSync(join(modules, "@gotgenes"), { recursive: true });
  const link = (target, name) => symlinkSync(target, join(modules, name), "dir");
  link(join(repo, "node_modules/@earendil-works"), "@earendil-works");
  link(join(repo, "node_modules/@types"), "@types");
  link(join(repo, "node_modules/typebox"), "typebox");
  link(permissionSystem, "@gotgenes/pi-permission-system");
  symlinkSync(extensions, join(scratch, "ext"), "dir");
  symlinkSync(join(repo, "lib"), join(scratch, "lib"), "dir");
  // Type the integrated composition against its actual local graph as well.
  for (const name of ["bin", "runtime", "harness"]) symlinkSync(join(repo, name), join(scratch, name), "dir");
  symlinkSync(join(repo, "composition.ts"), join(scratch, "composition.ts"));

  writeFileSync(join(scratch, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023", "DOM"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      // Extensions import siblings as "./x.ts"; Pi loads them through jiti.
      allowImportingTsExtensions: true,
      types: ["node"],
    },
    include: ["ext/*.ts", "ext/lib/*.ts", "lib/*.d.mts", "composition.ts", "runtime/permission-system/managed-resource-protection.ts"],
  }, null, 2)}\n`);

  const run = spawnSync(tsc, ["-p", "tsconfig.json", "--pretty", "false"], {
    cwd: scratch, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert(!run.error, `tsc failed to run: ${run.error?.message}`);
  assert.equal(run.signal, null, `tsc terminated by signal ${run.signal}`);

  // --pretty=false has one diagnostic header per error. Accept indented
  // continuation text only after a header, and reject every other output line
  // so a new file shape, global diagnostic, or compiler failure cannot vanish.
  const diagnostics = [];
  const failures = [];
  // Streams have independent line/continuation boundaries. Concatenation can
  // hide stderr inside a stdout baseline lacking its final newline.
  for (const output of [run.stdout, run.stderr]) {
    let current;
    for (const line of output.split("\n")) {
      const match = /^\s*(?:(.+)\((\d+),(\d+)\):\s+)?(error|warning|suggestion|message)\s+(TS\d+):\s*(.*)$/.exec(line);
      if (match) {
        current = {
          file: match[1] ?? null,
          line: match[2] ?? null,
          column: match[3] ?? null,
          category: match[4],
          code: match[5],
          message: match[6],
        };
        diagnostics.push(current);
      } else if (line === "") {
        continue;
      } else if (current && /^\s+/.test(line)) {
        current.message += `\n${line}`;
      } else {
        failures.push(`Unrecognized tsc output: ${line.slice(0, 200)}`);
      }
    }
  }

  // A no-emit tsc run returns 0 without diagnostics and 2 with diagnostics.
  // Any other status is a crash/CLI failure, even if an accepted baseline was
  // printed first. The baseline itself therefore does not require exit 0.
  const expectedStatus = diagnostics.length === 0 ? 0 : 2;
  if (run.status !== expectedStatus) {
    failures.push(`tsc exited abnormally: expected ${expectedStatus} for ${diagnostics.length} diagnostic(s), got ${run.status}`);
  }

  const found = new Map();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.file, diagnostic.code, diagnostic.category]);
    found.set(key, [...(found.get(key) ?? []), diagnostic]);
  }

  for (const entry of BASELINE) {
    const key = JSON.stringify([entry.file, entry.code, "error"]);
    const actual = found.get(key)?.length ?? 0;
    if (actual === entry.count) {
      found.delete(key);
      continue;
    }
    failures.push(actual === 0
      ? `Baseline entry no longer occurs, remove it: ${entry.file} ${entry.code} (${entry.why})`
      : `Baseline expects ${entry.count} x ${entry.code} in ${entry.file}, found ${actual}`);
    found.delete(key);
  }
  for (const diagnostics of found.values()) {
    for (const diagnostic of diagnostics) {
      const location = diagnostic.file === null
        ? "<global>"
        : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
      failures.push(`${location}: ${diagnostic.category} ${diagnostic.code}: ${diagnostic.message.slice(0, 160)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} type gate failure(s) in the Pi extensions\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    const version = spawnSync(tsc, ["--version"], { encoding: "utf8", timeout: 30_000 });
    assert(!version.error, `tsc --version failed to run: ${version.error?.message}`);
    assert.equal(version.signal, null, `tsc --version terminated by signal ${version.signal}`);
    assert.equal(version.status, 0, `tsc --version exited abnormally (${version.status})`);
    assert.equal(version.stderr, "", `tsc --version wrote unexpected stderr: ${version.stderr.trim()}`);
    assert.match(version.stdout.trim(), /^Version \S+$/, "Unexpected tsc --version output");
    const baselined = BASELINE.reduce((total, entry) => total + entry.count, 0);
    console.log(
      `PASS: Pi extensions typecheck against the pinned SDK and permission system` +
      ` (tsc ${version.stdout.trim()}, ${baselined} baselined)`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
