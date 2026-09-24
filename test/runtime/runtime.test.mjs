import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDirectory, digest, packageRoot, preflight, resolveFlock, runtimeEnvironment, verifyAgentResources, verifyRuntime, webEntry } from "../../bin/runtime-support.mjs";
import { initialize } from "../../scripts/init.mjs";
import { renderWorkers } from "../../scripts/generate-workers.mjs";

const temporary = (t) => { const path = mkdtempSync(join(tmpdir(), "alehouse-runtime-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };

test("portable generator matches original worker bytes and policy digests", () => {
  const { agents, metadata } = renderWorkers();
  assert.equal(metadata.editor.digest, "dc31159be9bf812bd3f83f42145a7b7fd621af4c0eb2423a373d4c3b50d34172");
  assert.equal(metadata.reader.digest, "b6756df8ef259f6ec0a41b02ea737a5d07fd691bc56918d26d2c46ffe8ba25ea");
  for (const [name, source] of Object.entries(agents)) assert.equal(readFileSync(join(packageRoot, "runtime/agents", `${name}.md`), "utf8"), source);
  assert.match(agents.reader, /  write: deny\n  edit: deny\n  path_write:\n    "\*": deny/);
  assert(metadata.editor.bashDenies.includes("git -C * commit *"));
  for (const name of ["jev-auto-approval.ts", "luna-auto-approval.ts", "static-safety-guard.ts"]) {
    const source = readFileSync(join(packageRoot, "runtime/policy", name), "utf8");
    assert(!source.includes("/* @worker-policy@ */ {}"));
    assert(source.includes(JSON.stringify(metadata)));
  }
});

test("generated authority is private, pinned, patched and package-complete", () => {
  const vendor = join(packageRoot, "runtime/permission-system/vendor");
  const original = join(packageRoot, "node_modules/@gotgenes/pi-permission-system");
  const pkg = JSON.parse(readFileSync(join(vendor, "package.json")));
  assert.equal(pkg.version, "32.0.3");
  assert.deepEqual(pkg.imports, JSON.parse(readFileSync(join(original, "package.json"))).imports);
  assert(!existsSync(join(vendor, "node_modules")));
  const patched = readFileSync(join(vendor, "src/policy/permission-manager.ts"), "utf8");
  assert.match(patched, /agentWriteFloor/);
  assert.doesNotMatch(readFileSync(join(original, "src/policy/permission-manager.ts"), "utf8"), /agentWriteFloor/);
  assert.match(readFileSync(join(packageRoot, "runtime/permission-system/index.ts"), "utf8"), /export \{ getPermissionsService \} from "\.\/vendor\/src\/service.ts"/);
  assert(existsSync(join(packageRoot, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm")));
  assert(existsSync(join(packageRoot, "node_modules/web-tree-sitter/web-tree-sitter.wasm")));
  verifyRuntime();
  assert.equal(webEntry(), join(packageRoot, "node_modules/pi-web-access/dist/index.js"));
});

test("init creates only absent resources and seeds Off without model routes", (t) => {
  const agentDir = join(temporary(t), "agent");
  const first = initialize({ agentDir });
  assert.equal(first.created.length, 7);
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  const original = readFileSync(configPath);
  const config = JSON.parse(original);
  assert.equal(config.permission.path[join(agentDir, "auth.json")], "deny");
  assert.equal(config.permission.path[join(agentDir, "web-search.json")], "deny");
  assert.equal(config.permission.path_write[packageRoot], "deny");
  assert.equal(config.permission.path_write[join(packageRoot, "*")].action, "deny");
  assert.equal(config.permission.path_write[join(agentDir, "*")].action, "deny");
  assert.equal(config.permission.path["~/.ssh/*"], "deny");
  assert.equal(config.permission.external_directory["*"], "ask");
  assert.equal(config.permission.external_directory_read, undefined);
  assert.deepEqual(config.piInfrastructureReadPaths, []);
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "harness-presets.json"))), { version: 2, defaultPreset: "off", presets: {} });
  const second = initialize({ agentDir });
  assert.equal(second.created.length, 0);
  assert.equal(second.preserved.length, 7);
  assert.deepEqual(readFileSync(configPath), original);
  assert(!existsSync(join(agentDir, "settings.json")));
  assert(!existsSync(join(agentDir, "auth.json")));
  preflight({ agentDir, env: { PATH: "" } });
});

test("init preserves conflicting and dangling profile symlinks; never claims ready", (t) => {
  const base = temporary(t);
  const agentDir = join(base, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  const target = join(base, "absent.md");
  symlinkSync(target, join(agentDir, "agents/editor.md"));
  assert.throws(() => initialize({ agentDir }));
  assert(lstatSync(join(agentDir, "agents/editor.md")).isSymbolicLink());
  assert.equal(readlinkSync(join(agentDir, "agents/editor.md")), target);
  assert(!existsSync(target));
  assert.throws(() => verifyAgentResources(agentDir));
});

test("init preserves matching Nix-style symlinks and existing custom policies", (t) => {
  const agentDir = temporary(t);
  mkdirSync(join(agentDir, "agents"));
  for (const name of ["editor", "reader", "Explore", "Plan", "general-purpose"]) symlinkSync(join(packageRoot, "runtime/agents", `${name}.md`), join(agentDir, "agents", `${name}.md`));
  initialize({ agentDir });
  const path = join(agentDir, "extensions/pi-permission-system/config.json");
  const ownPolicy = '{"permission":{"*":"deny"}}\n';
  writeFileSync(path, ownPolicy);
  initialize({ agentDir });
  assert.equal(readFileSync(path, "utf8"), ownPolicy);
  assert(lstatSync(join(agentDir, "agents/editor.md")).isSymbolicLink());
});

test("init never follows a conflicting directory symlink", (t) => {
  const base = temporary(t), agentDir = join(base, "agent"), outside = join(base, "outside");
  mkdirSync(agentDir); mkdirSync(outside);
  symlinkSync(outside, join(agentDir, "agents"));
  assert.throws(() => initialize({ agentDir }), /Preserved conflicting directory/);
  assert.deepEqual(readdirSync(outside), []);
});

test("init checks symlinked ancestors even when the final directory already exists", (t) => {
  const base = temporary(t), real = join(base, "real"), alias = join(base, "alias");
  mkdirSync(join(real, "agent/agents"), { recursive: true });
  symlinkSync(real, alias);
  assert.throws(() => initialize({ agentDir: join(alias, "agent") }), /Preserved conflicting directory/);
  assert.deepEqual(readdirSync(join(real, "agent/agents")), []);
});

test("preflight binds runtime roots to the verified generation and exports normalized agentDir", (t) => {
  const base = temporary(t), agentDir = join(base, "agent"), alternate = join(base, "alternate");
  initialize({ agentDir });
  cpSync(join(packageRoot, "runtime/permission-system"), alternate, { recursive: true });
  assert.throws(() => preflight({ agentDir, env: { PI_HARNESS_PERMISSION_ROOT: alternate } }), /verified runtime generation/);
  assert.throws(() => preflight({ agentDir, env: { PI_HARNESS_POLICY_ROOT: "relative" } }), /absolute/);
  const paths = preflight({ agentDir, env: {} });
  assert.equal(runtimeEnvironment(paths, { PI_CODING_AGENT_DIR: "~/wrong" }).PI_CODING_AGENT_DIR, agentDir);
});

test("preflight rejects changed generated files and changed installed profiles read-only", (t) => {
  const base = temporary(t), root = join(base, "package"), agentDir = join(base, "agent");
  cpSync(join(packageRoot, "runtime"), join(root, "runtime"), { recursive: true });
  cpSync(join(packageRoot, "composition.ts"), join(root, "composition.ts"));
  writeFileSync(join(root, "package.json"), '{"type":"module","dependencies":{}}');
  initialize({ agentDir, root });
  const profile = join(agentDir, "agents/editor.md");
  writeFileSync(profile, "user-owned conflict\n");
  assert.throws(() => verifyAgentResources(agentDir, root), /Managed profile mismatch/);
  assert.equal(readFileSync(profile, "utf8"), "user-owned conflict\n");
  const generated = join(root, "runtime/policy/static-safety-guard.ts");
  writeFileSync(generated, "export default () => {};\n");
  assert.throws(() => verifyRuntime(root), /Runtime resource mismatch/);
});

test("flock is fixed-system util-linux or explicit absolute override, not PATH", (t) => {
  const dir = temporary(t), fake = join(dir, "flock");
  writeFileSync(fake, '#!/bin/sh\necho "flock from impostor"\n', { mode: 0o755 });
  const real = resolveFlock({ PATH: dir });
  assert.notEqual(real, fake);
  assert.throws(() => resolveFlock({ PI_HARNESS_FLOCK: "flock", PATH: dir }), /absolute/);
  assert.throws(() => resolveFlock({ PI_HARNESS_FLOCK: fake }), /util-linux/);
  assert.equal(resolveFlock({ PI_HARNESS_FLOCK: real }), real);
  assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "~/example" }), join(homedir(), "example"));
});

test("launcher supplies exactly one composition and never mutates global settings", (t) => {
  const dir = temporary(t), agentDir = join(dir, "agent"), fake = join(dir, "pi");
  initialize({ agentDir });
  const marker = join(dir, "args.json");
  writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),flock:process.env.PI_HARNESS_FLOCK,permission:process.env.PI_HARNESS_PERMISSION_ROOT,policy:process.env.PI_HARNESS_POLICY_ROOT}));\n`, { mode: 0o755 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ALEHOUSE_PI: fake };
  delete env.PI_HARNESS_PERMISSION_ROOT; delete env.PI_HARNESS_POLICY_ROOT; delete env.PI_HARNESS_FLOCK;
  const cli = join(packageRoot, "bin/pi-alehouse.mjs");
  execFileSync(process.execPath, [cli, "--no-extensions", "--offline", "--print", "--", "-example", "--extension=prompt-text"], { env });
  const observed = JSON.parse(readFileSync(marker));
  assert.deepEqual(observed.args.slice(0, 3), ["--no-extensions", "-e", join(packageRoot, "composition.ts")]);
  assert.equal(observed.args.filter((v) => v === "-e").length, 1);
  assert.deepEqual(observed.args.slice(-3), ["--", "-example", "--extension=prompt-text"]);
  assert.equal(observed.permission, join(packageRoot, "runtime/permission-system"));
  assert.equal(observed.policy, join(packageRoot, "runtime/policy"));
  assert(!existsSync(join(agentDir, "settings.json")));
  rmSync(marker);
  const denied = spawnSync(process.execPath, [cli, "--extension", "npm:evil"], { env, encoding: "utf8" });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Additional extensions/);
  assert(!existsSync(marker));
});

test("help and version work before init without creating any resources", (t) => {
  const dir = temporary(t), agentDir = join(dir, "absent");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const cli = join(packageRoot, "bin/pi-alehouse.mjs");
  assert.match(execFileSync(process.execPath, [cli, "--help"], { env, encoding: "utf8" }), /Usage: pi-alehouse init/);
  assert.match(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }), /^pi-alehouse \d+\.\d+\.\d+/);
  assert(!existsSync(agentDir));
});

test("web dependency lookup supports npm-hoisted production installs", (t) => {
  const install = temporary(t), root = join(install, "node_modules/pi-alehouse");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"pi-alehouse","dependencies":{"pi-web-access":"0.31.0"}}');
  const web = join(install, "node_modules/pi-web-access");
  mkdirSync(join(web, "dist"), { recursive: true });
  writeFileSync(join(web, "package.json"), '{"name":"pi-web-access","version":"0.31.0","pi":{"extensions":["./dist"]}}');
  writeFileSync(join(web, "dist/index.js"), 'export default () => {};');
  assert.equal(webEntry(root), join(web, "dist/index.js"));
});

test("launcher execve preserves PID and native signal exit (no supervisor)", { timeout: 10000 }, async (t) => {
  const dir = temporary(t), agentDir = join(dir, "agent"), fake = join(dir, "pi");
  initialize({ agentDir });
  writeFileSync(fake, `#!${process.execPath}\nconsole.log(process.pid); setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ALEHOUSE_PI: fake };
  delete env.PI_HARNESS_PERMISSION_ROOT; delete env.PI_HARNESS_POLICY_ROOT; delete env.PI_HARNESS_FLOCK;
  const child = spawn(process.execPath, [join(packageRoot, "bin/pi-alehouse.mjs"), "--offline"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
  const pid = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (data) => { output += data; if (output.includes("\n")) resolve(Number(output.trim())); });
    child.on("error", reject);
    child.on("exit", () => { if (!output) reject(new Error("Host exited before PID report")); });
  });
  assert.equal(pid, child.pid, "Pi replaces the launcher process rather than running as its child");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});

test("real host parent starts Off with one canonical ready authority, offline", { timeout: 30000 }, (t) => {
  const dir = temporary(t), agentDir = join(dir, "agent");
  const output = execFileSync(process.execPath, [join(packageRoot, "test/runtime/fixtures/session-smoke.mjs")], {
    env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir,
      PI_JEV_API_KEY_FILE: join(dir, "nonexistent-test-key"), PI_OFFLINE: "1", NO_COLOR: "1" },
    encoding: "utf8", timeout: 25000,
  });
  assert.match(output, /one real host parent starts Off, one canonical authority ready, no network/);
});

test("preserved invalid preset fails closed for real SDK tool and user_bash dispatch", { timeout: 30000 }, (t) => {
  const dir = temporary(t), agentDir = join(dir, "agent");
  const output = execFileSync(process.execPath, [join(packageRoot, "test/runtime/fixtures/session-smoke.mjs"), "--invalid-preset"], {
    env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir,
      PI_JEV_API_KEY_FILE: join(dir, "nonexistent-test-key"), PI_OFFLINE: "1", NO_COLOR: "1" },
    encoding: "utf8", timeout: 25000,
  });
  assert.match(output, /preserved invalid preset leaves real SDK tool and user_bash latches blocked/);
});

test("build inputs contain no generated installed-profile hash fallback", () => {
  const source = readFileSync(join(packageRoot, "scripts/generate-workers.mjs"), "utf8");
  assert.doesNotMatch(source, /PI_CODING_AGENT_DIR|getAgentDir/);
  assert.equal(digest(readFileSync(join(packageRoot, "runtime/agents/editor.md"))), renderWorkers().metadata.editor.digest);
});
