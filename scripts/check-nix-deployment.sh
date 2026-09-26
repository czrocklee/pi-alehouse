#!/usr/bin/env bash
# Inspect an already-built Home Manager generation that enables the flake's
# programs.pi-alehouse module; never build or activate it. Consumers compare
# their own personal presets/permissions separately.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 HM_GENERATION [HOST_PI_EXECUTABLE]" >&2
  exit 2
fi
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pi_executable="${2:-$(command -v pi)}"
node --input-type=module - "$scripts" "$1" "$pi_executable" <<'JS'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const [scripts, generationArg, piExecutable] = process.argv.slice(2);
const generation = realpathSync(generationArg);
assert(generation.startsWith("/nix/store/"), "Expected an already-built Nix Home Manager generation");
const resources = join(generation, "home-files/.pi/agent");
const launcher = realpathSync(join(generation, "home-path/bin/pi-alehouse"));
assert(launcher.startsWith("/nix/store/"), "Launcher must be store-owned");
const root = join(dirname(dirname(launcher)), "lib/node_modules/pi-alehouse");
const runtime = join(root, "runtime");
const manifest = JSON.parse(readFileSync(join(root, "package.json")));
assert.equal(manifest.name, "pi-alehouse");
assert.deepEqual(manifest.pi.extensions, [], "Ordinary Pi must not autoload delegation");
const selector = JSON.parse(readFileSync(join(resources, "managed-permissions.json")));
assert.equal(selector.version, 1);
assert.equal(selector.entryPoint, join(runtime, "permission-system/index.ts"));
const activate = readFileSync(join(generation, "activate"), "utf8");
const bootstraps = [...new Set(activate.match(/\/nix\/store\/[a-z0-9]{32}-[^\s"']+\/bootstrap\.ts/g) ?? [])];
assert.equal(bootstraps.length, 1, "Expected one separate persistent-bootstrap source in activation text");
const bootstrap = bootstraps[0];
assert(readFileSync(bootstrap, "utf8").startsWith("// pi-managed-permissions-bootstrap v1\n"));
assert.notEqual(dirname(bootstrap), dirname(selector.entryPoint));
const { verifyRuntime, verifyAgentResources } = await import(pathToFileURL(join(root, "bin/runtime-support.mjs")));
verifyRuntime(root);
verifyAgentResources(resources, root);
for (const name of ["editor", "reader", "Explore", "Plan", "general-purpose"]) {
  assert.equal(realpathSync(join(resources, "agents", `${name}.md`)), join(runtime, "agents", `${name}.md`));
}
const policyExtensions = ["status-footer", "approval-mode", "stats", "terminal-title-status", "ui-prompt-queue", "luna-auto-approval", "static-safety-guard", "policy-grep"];
for (const name of policyExtensions) {
  // Shims, not symlinks: Pi resolves an entry's relative imports from its ~/.pi path.
  assert.equal(readFileSync(join(resources, "extensions", `${name}.ts`), "utf8"), `export { default } from "${join(runtime, "policy", `${name}.ts`)}";\n`);
}
// Use the product's parser, not a second schema implementation in Nix tests.
let piRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(piRoot, "package.json"))) {
  assert.notEqual(dirname(piRoot), piRoot, "Host Pi must resolve inside its npm package");
  piRoot = dirname(piRoot);
}
assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"))).name, "@earendil-works/pi-coding-agent");
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const { PresetRouter } = await createJiti(import.meta.url, { fsCache: false }).import(join(root, "harness/src/routing.ts"));
new PresetRouter(join(resources, "harness-presets.json"));
// No private host SDK/TypeBox copies may ship in the production dependency tree.
function inspect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    assert(!/\/node_modules\/(?:@earendil-works\/pi-(?:ai|agent-core|coding-agent|tui)|typebox)$/.test(path), `Bundled host runtime: ${path}`);
    if (entry.isDirectory()) inspect(path);
  }
}
inspect(join(root, "node_modules"));
{
  // Load the installed entries from their generation paths, as ordinary Pi does.
  const scratch = mkdtempSync(join(tmpdir(), "pi-extension-load-check-"));
  try {
    const loaded = spawnSync(piExecutable, ["--no-extensions", ...policyExtensions.flatMap((name) => ["-e", join(resources, "extensions", `${name}.ts`)]), "--mode", "rpc", "--no-session"], {
      encoding: "utf8", timeout: 60_000, input: '{"type":"get_state","id":"load-check"}\n',
      env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_TELEMETRY: "0", AGENT_DASHBOARD_URL: "", PI_ALEHOUSE_GROK_BILLING: "0" } });
    assert(!/Failed to load extension/.test(`${loaded.stdout}${loaded.stderr}`), `Ordinary Pi could not load policy extensions:\n${loaded.stderr}`);
    assert(loaded.stdout.includes('"id":"load-check"'), `Ordinary Pi did not answer after loading policy extensions:\n${loaded.stderr || String(loaded.error)}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
const scratch = mkdtempSync(join(tmpdir(), "pi-deployment-check-"));
try {
  const agent = join(scratch, "agent");
  mkdirSync(join(agent, "agents"), { recursive: true });
  mkdirSync(join(agent, "extensions/pi-permission-system"), { recursive: true });
  for (const name of ["editor", "reader", "Explore", "Plan", "general-purpose"]) copyFileSync(join(resources, "agents", `${name}.md`), join(agent, "agents", `${name}.md`));
  for (const name of ["harness-presets.json", "extensions/pi-permission-system/config.json"]) copyFileSync(join(resources, name), join(agent, name));
  const record = join(scratch, "launch.json"), host = join(scratch, "record-host.mjs");
  writeFileSync(host, `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.RECORD, JSON.stringify({ argv: process.argv.slice(2), permission: process.env.PI_HARNESS_PERMISSION_ROOT, policy: process.env.PI_HARNESS_POLICY_ROOT, luna: process.env.PI_AUTO_APPROVAL_MODE, jev: process.env.PI_JEV_APPROVAL_MODE }));\n`, { mode: 0o700 });
  // Even a regressed override lookup must never find the real credentialed CLI.
  symlinkSync(host, join(scratch, "pi"));
  const probe = spawnSync(launcher, ["--mode", "rpc", "--no-session"], { encoding: "utf8", timeout: 30_000,
    env: { PATH: scratch, HOME: scratch, PI_CODING_AGENT_DIR: agent, PI_ALEHOUSE_PI: host, RECORD: record, PI_TELEMETRY: "0", AGENT_DASHBOARD_URL: "", PI_ALEHOUSE_GROK_BILLING: "0" } });
  assert.equal(probe.status, 0, probe.stderr || String(probe.error));
  const launch = JSON.parse(readFileSync(record));
  assert.deepEqual(launch, { argv: ["--no-extensions", "-e", join(root, "composition.ts"), "--mode", "rpc", "--no-session"], permission: join(runtime, "permission-system"), policy: join(runtime, "policy"), luna: "shadow", jev: "enforce-subagents" });
  console.log("PASS: generation selector/bootstrap, exact runtime workers/UI, installed preset schema, host-only SDK, and store launcher composition (recording host; no models)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
const check = spawnSync(process.execPath, [join(scripts, "check-pi-permission-bootstrap.mjs"), piExecutable, resources, bootstrap, join(root, "node_modules/@gotgenes/pi-permission-system")], { stdio: "inherit", timeout: 180_000 });
assert.equal(check.status, 0, `Bootstrap regression check failed: ${check.error ?? check.signal ?? check.status}`);
console.log(`PASS: Nix deployment checks for ${generation}; no activation or model calls`);
JS
