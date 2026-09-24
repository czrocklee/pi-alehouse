#!/usr/bin/env node
// Real hardened queries on synthetic repositories; no remotes, model or live config.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const [repo, executable, resources] = process.argv.slice(2);
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(packageRoot);
let piRoot = dirname(fs.realpathSync(executable));
while (!fs.existsSync(join(piRoot, "package.json"))) piRoot = dirname(piRoot);
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") } });
const load = name => jiti.import(join(packageRoot, "src", `${name}.ts`));
const { hardenGitInput, managedGitProof, originalGitCommands } = await load("access-intent/bash/managed-read-policy");
const { BashProgram } = await load("access-intent/bash/program");
const { PermissionManager } = await load("policy/permission-manager");
const { PermissionResolver } = await load("policy/permission-resolver");
const { PathNormalizer } = await load("path/path-normalizer");
const { posixPathFlavor } = await load("path/path-flavor");
const { resolveBashCommandCheck } = await load("handlers/gates/bash-command");
const { describeBashPathGate } = await load("handlers/gates/bash-path");
const scratch = fs.mkdtempSync(join(tmpdir(), "pi-git-semantics-"));
const savedEnv = { ...process.env };
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_") || name.startsWith("BASH_FUNC_")) delete process.env[name];
Object.assign(process.env, { HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "config"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0", BASH_ENV: "/dev/null", ENV: "/dev/null" });
for (const name of ["home", "config", "template"]) fs.mkdirSync(join(scratch, name));
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false",
  "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
const init = name => { const cwd = join(scratch, name); fs.mkdirSync(cwd, { recursive: true }); git(cwd, "init", "-q", `--template=${join(scratch, "template")}`); return cwd; };
const execute = (cwd, command) => {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", command], { cwd, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error); assert([0, 1].includes(result.status), result.stderr);
  return { status: result.status, stdout: result.stdout };
};
async function equivalent(cwd, command, changes = true) {
  const input = { command }; await hardenGitInput(input);
  if (changes) assert.notEqual(input.command, command, "Query must exercise actual hardening");
  else { assert.equal(input.command, command); assert.equal(originalGitCommands(input), undefined); }
  assert.deepEqual(execute(cwd, input.command), execute(cwd, command), `Output and status: ${command}`);
  return input.command;
}
const manager = new PermissionManager({ globalConfigPath: join(resources, "extensions/pi-permission-system/config.json"), agentsDir: join(resources, "agents"), mcpServerNames: [] });
const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
try {
  const cwd = init("links");
  git(cwd, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/dependency`); git(cwd, "commit", "-qm", "initial link");
  git(cwd, "update-index", "--cacheinfo", `160000,${"2".repeat(40)},vendor/dependency`);
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  for (const suffix of ["--stat", "--name-status", "--quiet", "--exit-code", "-p", "--binary", "--check"]) await equivalent(cwd, `git diff --cached ${suffix}`);
  let input = { command: "git diff --cached" }; await hardenGitInput(input);
  assert(managedGitProof(input.command, normalizer)?.ruleCandidates.some(candidate => candidate.token === "vendor/dependency"), "Changed-name probe must retain staged gitlink scope");
  git(cwd, "commit", "-qm", "bump link");
  for (const suffix of ["--stat", "--quiet", "--exit-code"]) await equivalent(cwd, `git diff HEAD~1 HEAD ${suffix}`);
  input = { command: "git diff HEAD~1 HEAD" }; await hardenGitInput(input);
  assert(managedGitProof(input.command, normalizer)?.ruleCandidates.some(candidate => candidate.token === "vendor/dependency"), "Historical gitlink scope");

  // An actual checked-out submodule: dirty tracked files, untracked files and
  // a different HEAD are distinct from changing the superproject's index.
  const sub = init("links/vendor/dependency");
  fs.writeFileSync(join(sub, "file.txt"), "before\n"); git(sub, "add", "file.txt"); git(sub, "commit", "-qm", "sub base");
  const oldOid = git(sub, "rev-parse", "HEAD").trim();
  git(cwd, "update-index", "--cacheinfo", `160000,${oldOid},vendor/dependency`);
  fs.writeFileSync(join(cwd, ".gitmodules"), '[submodule "dependency"]\n path = vendor/dependency\n url = ./unused-local\n');
  git(cwd, "add", ".gitmodules"); git(cwd, "commit", "-qm", "checked out submodule");
  for (const state of ["tracked", "untracked", "head"]) {
    if (state === "tracked") fs.writeFileSync(join(sub, "file.txt"), "after\n");
    if (state === "untracked") { git(sub, "checkout", "--", "file.txt"); fs.writeFileSync(join(sub, "new.txt"), "untracked\n"); }
    if (state === "head") { git(sub, "add", "new.txt"); git(sub, "commit", "-qm", "sub bump"); }
    for (const suffix of ["", "--stat", "--quiet", "--exit-code"]) await equivalent(cwd, `git diff ${suffix}`.trim());
    input = { command: "git diff" }; await hardenGitInput(input);
    const visible = git(cwd, "diff", "--name-only").trim().split("\n").filter(Boolean);
    assert.deepEqual(managedGitProof(input.command, normalizer)?.ruleCandidates.map(candidate => candidate.token), visible, `Working-tree gitlink scope follows Git defaults: ${state}`);
    for (const setting of ["submodule.dependency.ignore", "diff.ignoreSubmodules"]) {
      for (const ignore of ["none", "dirty", "untracked", "all"]) {
        git(cwd, "config", setting, ignore);
        await equivalent(cwd, "git diff --quiet");
        const expected = git(cwd, "diff", "--name-only").trim().split("\n").filter(Boolean);
        assert.deepEqual(managedGitProof(input.command, normalizer)?.ruleCandidates.map(candidate => candidate.token), expected, `Probe follows ${setting}=${ignore}`);
      }
      git(cwd, "config", "--unset", setting);
    }
    await equivalent(cwd, "git diff --ignore-submodules=all --quiet");
    input = { command: "git diff --ignore-submodules=all" }; await hardenGitInput(input);
    assert.deepEqual(managedGitProof(input.command, normalizer)?.ruleCandidates, [], "Explicit all is preserved in the probe too");
  }
  const marker = "SUBMODULE_FILE_CONTENT_MUST_NOT_ESCAPE";
  const subject = "SUBMODULE_COMMIT_SUBJECT_MUST_NOT_ESCAPE";
  fs.writeFileSync(join(sub, ".env"), marker); git(sub, "add", ".env"); git(sub, "commit", "-qm", subject);
  for (const format of ["diff", "log"]) {
    git(cwd, "config", "diff.submodule", format);
    input = { command: "git diff --exit-code" }; await hardenGitInput(input);
    const result = execute(cwd, input.command);
    assert.equal(result.status, 1); assert(!result.stdout.includes(marker)); assert(!result.stdout.includes(subject)); assert(result.stdout.includes("Subproject commit"));
  }
  for (const option of ["--submodule=diff", "--submodule=log", "--submodule", "--ignore-submodules=dirty", "--ignore-submodules=none", "--ignore-submodules=untracked"]) {
    input = { command: `git diff ${option}` }; await hardenGitInput(input); assert.equal(input.command, `git diff ${option}`, "Unsupported explicit mode is not rewritten");
  }

  const renamed = init("renames"); fs.writeFileSync(join(renamed, "before.txt"), "synthetic\n"); git(renamed, "add", "."); git(renamed, "commit", "-qm", "base");
  git(renamed, "config", "diff.renames", "true"); fs.renameSync(join(renamed, "before.txt"), join(renamed, "after.txt")); git(renamed, "add", "-A");
  const renameNormalizer = new PathNormalizer(posixPathFlavor, renamed);
  for (const filter of ["R", "C", "A", "D", "r", "a", "d", "ACDMRTUXB", "U"]) {
    const command = `git diff --cached --diff-filter=${filter} --name-status`;
    await equivalent(renamed, command, false);
    const program = await BashProgram.parse(command, renameNormalizer);
    for (const agent of [undefined, "editor", "reader"]) assert.equal(resolveBashCommandCheck(command, program.commands(), agent, resolver).state, "ask", `Unchanged filter keeps normal review: ${filter}/${agent}`);
    await equivalent(renamed, `git diff --no-renames --cached --diff-filter=${filter} --name-status`);
  }
  input = { command: "git status --short && git diff --cached --diff-filter=R --name-status" }; await hardenGitInput(input);
  assert(input.command.endsWith("&& git diff --cached --diff-filter=R --name-status"), "Another hardenable unit cannot rewrite the rejected filter");
  const mixed = await BashProgram.parse(input.command, renameNormalizer);
  for (const agent of [undefined, "editor", "reader"]) assert.equal(resolveBashCommandCheck(input.command, mixed.commands(), agent, resolver).state, "ask", "Mixed program cannot indirectly gain static proof");

  const protectedDir = init("protected-link"), protectedNormalizer = new PathNormalizer(posixPathFlavor, protectedDir);
  git(protectedDir, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},.env`); git(protectedDir, "commit", "-qm", "protected link");
  git(protectedDir, "update-index", "--cacheinfo", `160000,${"2".repeat(40)},.env`);
  for (const deleted of [false, true]) {
    if (deleted) git(protectedDir, "update-index", "--force-remove", ".env");
    input = { command: "git diff --cached" }; await hardenGitInput(input);
    const program = await BashProgram.parse(input.command, protectedNormalizer);
    for (const agentName of [undefined, "editor", "reader"]) {
      const gate = describeBashPathGate({ toolCallId: "gitlink", toolName: "bash", cwd: protectedDir, agentName }, program, resolver, protectedNormalizer);
      assert.equal(gate.preCheck.state, "deny", "Changed/deleted gitlinks retain protected-path gates");
    }
  }
  console.log("PASS: real Git gitlink/index/tree/dirty/untracked/HEAD output and exit status, short-only disclosure, matching probe scope, unchanged rename-filter review");

  // Exercise the production membership loop with bounded synthetic probe data.
  // Deterministic operation assertions, not a hardware-dependent timing threshold.
  const n = 25000, names = Array.from({ length: n }, (_, i) => `vendor/f${String(i).padStart(7, "0")}.js`);
  const lists = join(scratch, "names.json"), bin = join(scratch, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(lists, JSON.stringify({ indexed: names.slice(0, n / 2), committed: names.slice(n / 2), changed: names }));
  fs.writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(lists)}, 'utf8'));
const sub = process.argv[5];
const names = sub === 'ls-files' ? data.indexed : sub === 'ls-tree' ? data.committed : sub === 'diff' ? data.changed : undefined;
if (!names) process.exit(2);
process.stdout.write(names.join('\\0') + '\\0');\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const includes = Array.prototype.includes, has = Set.prototype.has;
  let lookups = 0;
  Array.prototype.includes = function (value, ...rest) {
    assert(!(this.length >= n && typeof value === "string" && value.startsWith("vendor/f")), "Quadratic changed-name array scan");
    return includes.call(this, value, ...rest);
  };
  Set.prototype.has = function (value) { if (this.size === n && typeof value === "string" && value.startsWith("vendor/f")) lookups++; return has.call(this, value); };
  const cheapNormalizer = { resolveBase: () => cwd, isBoundaryOutsideWorkingDirectory: () => false, forPath: token => ({ boundaryValue: () => join(cwd, token) }) };
  const command = "git --no-lazy-fetch diff --no-ext-diff --no-textconv --ignore-submodules=all --no-renames --cached";
  try {
    assert.equal(managedGitProof(command, cheapNormalizer)?.ruleCandidates.length, n);
    assert.equal(lookups, n, "One Set membership lookup per changed name across index union tree");
    fs.writeFileSync(lists, JSON.stringify({ indexed: names.slice(0, n / 2), committed: names.slice(n / 2), changed: [...names, "vendor/f-unknown.js"] }));
    assert.equal(managedGitProof(command, cheapNormalizer), undefined, "Unknown changed names still fail closed");
  } finally { Array.prototype.includes = includes; Set.prototype.has = has; }
  console.log("PASS: 25,000-name production proof uses Set membership, no large-array scans; unknown names rejected");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv); fs.rmSync(scratch, { recursive: true, force: true });
}
