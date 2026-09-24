// Capture the portable CLI with a fake Pi. Never loads user settings/auth.
// Nix/HM Pi-versus-Codex deployment prompt assertions remain in the Nix repository;
// they are not claims made by this standalone package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalInstructionFixture } from "../support/project-instructions.mjs";

const [repo, , output] = process.argv.slice(2);
assert(repo && output, "Use collect-pi-harness-evidence.sh");
const launcher = join(repo, "bin/pi-alehouse.mjs");
const bin = join(output, "launcher-bin"); mkdirSync(bin, { mode: 0o700 });
const fake = join(bin, "pi");
writeFileSync(fake, `#!/usr/bin/env node
console.log(JSON.stringify({ argv: process.argv.slice(2),
  permissionRoot: process.env.PI_HARNESS_PERMISSION_ROOT,
  policyRoot: process.env.PI_HARNESS_POLICY_ROOT,
  flock: process.env.PI_HARNESS_FLOCK,
  autoApproval: process.env.PI_AUTO_APPROVAL_MODE,
  jevApproval: process.env.PI_JEV_APPROVAL_MODE }));
`, { mode: 0o700 });
const launcherEnv = { ...process.env, PI_ALEHOUSE_PI: fake };
delete launcherEnv.PI_JEV_APPROVAL_MODE;
delete launcherEnv.PI_HARNESS_PERMISSION_ROOT;
delete launcherEnv.PI_HARNESS_POLICY_ROOT;
const command = (args, env = launcherEnv) => {
  const result = spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const captured = command(["--thinking", "off"]);
assert.deepEqual(captured.argv, ["--no-extensions", "-e", join(repo, "composition.ts"), "--thinking", "off"]);
assert.equal(captured.permissionRoot, join(repo, "runtime/permission-system"));
assert.equal(captured.policyRoot, join(repo, "runtime/policy"));
assert.equal(captured.autoApproval, "shadow");
assert.equal(captured.jevApproval, "enforce-subagents");
assert.equal(command([], { ...launcherEnv, PI_JEV_APPROVAL_MODE: "shadow" }).jevApproval, "shadow");
// Component-wiring smoke retains the historical harness-only baseline comparison.
// Full composition fail-closed semantics have a separate test/runtime gate.
const paths = [join(repo, "harness/src/extension.ts"), join(captured.policyRoot, "ui-prompt-queue.ts"),
  join(captured.policyRoot, "jev-auto-approval.ts"), join(captured.permissionRoot, "index.ts"),
  ...["static-safety-guard", "policy-grep", "status-footer", "approval-mode", "stats", "terminal-title-status"].map((name) => join(captured.policyRoot, `${name}.ts`)),
  join(repo, "node_modules/pi-web-access")];
const composition = readFileSync(join(repo, "composition.ts"), "utf8");
let previous = -1;
for (const name of ["harness", "ui-prompt-queue", "jev", "managed-permissions", "static-safety-guard", "policy-grep", "footer", "approval-mode", "stats", "terminal-title", "web-access"]) {
  const at = composition.indexOf(`["${name}",`); assert(at > previous, `factory order: ${name}`); previous = at;
}
assert(!paths.some((path) => /luna-auto-approval|pi-subagents/.test(path)));
writeFileSync(join(output, "orchestration-prompts.json"), JSON.stringify({ pi: globalInstructionFixture }));
writeFileSync(join(output, "entry-package.json"), JSON.stringify({ checks: "passed", launcher,
  ...captured, extensionPaths: paths, compositionEntry: join(repo, "composition.ts"), real_model: false }, null, 2));
console.log("PASS: portable launcher captures one explicit composition and preserves factory ordering/CLI arguments");
