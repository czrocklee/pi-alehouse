#!/usr/bin/env node
// Real SDK, isolated settings/npm links and synthetic files; no model or hardware.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
const [executable, resources, bootstrapSource, publicPackage] = process.argv.slice(2);
assert(executable && resources && bootstrapSource,
  "Usage: check-pi-permission-bootstrap.mjs PI_EXECUTABLE AGENT_RESOURCES BOOTSTRAP_SOURCE [PUBLIC_PERMISSION_PACKAGE]");
// The durable bootstrap is a separate Nix derivation (nix/permission-bootstrap),
// not an authority sibling; its migration script ships beside it.
const installed = publicPackage ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "npm/node_modules/@gotgenes/pi-permission-system");
assert.equal(JSON.parse(fs.readFileSync(join(installed, "package.json"))).version, "32.0.3");
assert(fs.readFileSync(bootstrapSource, "utf8").startsWith("// pi-managed-permissions-bootstrap v1\n"));
const selection = JSON.parse(fs.readFileSync(join(resources, "managed-permissions.json")));
const migration = join(dirname(bootstrapSource), "migrate-settings.mjs");
const spawnSync = childProcess.spawnSync;
const scratch = fs.mkdtempSync(join(tmpdir(), "pi-bootstrap-test-"));
const cwd = join(scratch, "project"); fs.mkdirSync(cwd);
fs.writeFileSync(join(cwd, "ordinary.txt"), "synthetic safe file\n");
fs.writeFileSync(join(cwd, ".env"), "SYNTHETIC_SECRET_ONLY\n");
process.env.HOME = scratch; process.env.PI_OFFLINE = "1"; process.env.PI_TELEMETRY = "0";
process.env.PI_CODING_AGENT_DIR = join(scratch, "unused-agent");
process.env.PI_CODING_AGENT_SESSION_DIR = join(scratch, "sessions");
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT") || key.startsWith("PI_AGENT_ROUTER") || key.startsWith("PI_HARNESS_") || key.startsWith("PI_JEV_") || key === "PI_IS_SUBAGENT") delete process.env[key];
let piRoot = dirname(fs.realpathSync(executable));
while (!fs.existsSync(join(piRoot, "package.json"))) {
  assert.notEqual(dirname(piRoot), piRoot, "PI_EXECUTABLE must resolve inside the host Pi npm package");
  piRoot = dirname(piRoot);
}
assert.equal(JSON.parse(fs.readFileSync(join(piRoot, "package.json"))).name, "@earendil-works/pi-coding-agent");
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") } });
const sdk = await import(join(piRoot, "dist/index.js"));
const { createAgentSessionServices, createAgentSessionFromServices } = await import(join(piRoot, "dist/core/agent-session-services.js"));
const { AuthStorage } = await import(join(piRoot, "dist/core/auth-storage.js"));
const { getPermissionsService } = await jiti.import(join(installed, "src/service.ts"));
const models = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(scratch, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
let modelAttempts = 0, processAttempts = 0, prompts = 0;
const errors = [];
for (const name of ["stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred"]) {
  models[name] = () => { modelAttempts++; throw new Error("MODEL_FORBIDDEN"); };
}
// Package discovery must use the already installed fixture link, never npm/git.
const originals = new Map();
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  originals.set(name, childProcess[name]);
  childProcess[name] = () => { processAttempts++; throw new Error("UNEXPECTED_PROCESS"); };
}
syncBuiltinESMExports();
const bootstrapPath = dir => join(dir, "extensions/managed-permissions/index.ts");
const packagePath = dir => join(dir, "npm/node_modules/@gotgenes/pi-permission-system");
const selectorPath = dir => join(dir, "managed-permissions.json");
function fixture(name) {
  const dir = join(scratch, name);
  for (const sub of ["extensions/pi-permission-system", "npm/node_modules/@gotgenes"]) fs.mkdirSync(join(dir, sub), { recursive: true });
  // Installed entries are shims that import the store runtime by absolute path.
  for (const name of ["static-safety-guard.ts", "policy-grep.ts"]) fs.symlinkSync(fs.realpathSync(join(resources, "extensions", name)), join(dir, "extensions", name));
  fs.copyFileSync(join(resources, "extensions/pi-permission-system/config.json"), join(dir, "extensions/pi-permission-system/config.json"));
  fs.symlinkSync(installed, packagePath(dir), "dir");
  fs.writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "fixture", packages: ["npm:@gotgenes/pi-permission-system@32.0.3"] }));
  return dir;
}
function migrate(dir, source = bootstrapSource) {
  return spawnSync(process.execPath, [migration, join(dir, "settings.json"), source], { encoding: "utf8" });
}
function install(dir) {
  const settings = join(dir, "settings.json"), before = fs.readFileSync(settings, "utf8");
  const backup = `${settings}.before-managed-permissions-v1`;
  const previousBackup = fs.existsSync(backup) ? fs.readFileSync(backup, "utf8") : before;
  const result = migrate(dir); assert.equal(result.status, 0, result.stderr);
  assert(fs.lstatSync(bootstrapPath(dir)).isFile()); assert(!fs.lstatSync(bootstrapPath(dir)).isSymbolicLink());
  assert.equal(fs.statSync(bootstrapPath(dir)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(bootstrapPath(dir), "utf8"), fs.readFileSync(bootstrapSource, "utf8"));
  const after = fs.readFileSync(settings, "utf8");
  assert.equal(JSON.parse(after).defaultModel, JSON.parse(before).defaultModel);
  assert.equal(migrate(dir).status, 0);
  assert.equal(fs.readFileSync(settings, "utf8"), after, "Migration is idempotent");
  assert.equal(fs.readFileSync(backup, "utf8"), previousBackup, "First backup is preserved");
}
const runtimes = [];
async function runtimeFor(agentDir, explicit) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: models,
      // noExtensions alone still resolves configured packages. Fault fixtures
      // must also remove package requests so the SDK cannot try npm repair.
      settingsManager: explicit ? sdk.SettingsManager.inMemory() : sdk.SettingsManager.create(cwd, agentDir),
      resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        ...(explicit ? { noExtensions: true, additionalExtensionPaths: explicit } : {}) } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, [], "Bootstrap failure must retain its handlers, not become a loader error");
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: services.diagnostics };
  };
  const runtime = await sdk.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
  const bind = session => session.bindExtensions({ mode: "rpc", uiContext: {
    setStatus() {}, notify() {}, setWidget() {}, setTitle() {},
    select: async () => { prompts++; return undefined; }, input: async () => undefined, confirm: async () => false,
  }, onError: error => errors.push(error) });
  runtime.setRebindSession(bind); await bind(runtime.session); runtimes.push(runtime);
  return runtime;
}
const call = (runtime, path) => runtime.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "bootstrap-probe", toolName: "read", input: { path } });
async function protectedAndUsable(runtime, label) {
  assert(getPermissionsService(runtime.session.sessionManager.getSessionId()), `${label}: authority exists`);
  assert.equal((await call(runtime, "ordinary.txt"))?.block, undefined, `${label}: ordinary read`);
  assert.equal((await call(runtime, ".env"))?.block, true, `${label}: protected read`);
}
try {
  const dir = fixture("round-trip");
  const runtime = await runtimeFor(dir);
  await protectedAndUsable(runtime, "legacy public");
  fs.writeFileSync(selectorPath(dir), JSON.stringify(selection)); install(dir);
  assert.equal((await runtime.newSession()).cancelled, false);
  await protectedAndUsable(runtime, "managed upgrade");
  await runtime.session.reload(); await protectedAndUsable(runtime, "managed reload");
  // HM removes its selector on rollback, but does not own this regular leaf.
  fs.rmSync(selectorPath(dir));
  assert(fs.existsSync(bootstrapPath(dir)));
  assert(!fs.readFileSync(bootstrapPath(dir), "utf8").includes(dirname(selection.entryPoint)), "Bootstrap does not embed the old store closure");
  await runtime.newSession(); await protectedAndUsable(runtime, "rollback with migrated settings");
  await runtime.session.reload(); await protectedAndUsable(runtime, "fallback reload");
  fs.writeFileSync(selectorPath(dir), JSON.stringify(selection)); install(dir);
  await runtime.newSession(); await protectedAndUsable(runtime, "re-upgrade");
  // Real runtime replacement (not a fabricated session_start on an old factory).
  fs.mkdirSync(join(scratch, "saved-sessions"));
  const saved = sdk.SessionManager.create(cwd, join(scratch, "saved-sessions"));
  fs.writeFileSync(saved.getSessionFile(), JSON.stringify(saved.getHeader()) + "\n");
  assert.equal((await runtime.switchSession(saved.getSessionFile())).cancelled, false);
  await protectedAndUsable(runtime, "switchSession");
  await runtime.dispose(); runtimes.pop();

  for (const name of ["malformed", "dangling", "missing-entry", "wrong-schema", "missing-package", "wrong-version", "import-error", "no-default", "partial-factory"]) {
    const dir = fixture(name); install(dir);
    if (name === "malformed") fs.writeFileSync(selectorPath(dir), "{");
    if (name === "dangling") fs.symlinkSync(join(dir, "missing-selector"), selectorPath(dir));
    if (name === "missing-entry") fs.writeFileSync(selectorPath(dir), JSON.stringify({ version: 1, entryPoint: "/nix/store/00000000000000000000000000000000-missing/index.ts" }));
    if (name === "wrong-schema") fs.writeFileSync(selectorPath(dir), JSON.stringify({ ...selection, version: 2 }));
    if (["missing-package", "wrong-version", "import-error", "no-default", "partial-factory"].includes(name)) {
      fs.unlinkSync(packagePath(dir));
      if (name !== "missing-package") {
        fs.mkdirSync(join(packagePath(dir), "src"), { recursive: true });
        fs.writeFileSync(join(packagePath(dir), "package.json"), JSON.stringify({ version: name === "wrong-version" ? "0.0.0" : "32.0.3" }));
        const body = name === "import-error" ? 'import "./missing.ts"; export default () => {};' : name === "partial-factory" ? `export default function (pi) {
  const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
  pi.on("session_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    globalThis[key] ??= new Map(); globalThis[key].set(id, { fixture: true });
    pi.events.emit("permissions:ready", { sessionId: id });
  });
  pi.on("session_shutdown", (_event, ctx) => globalThis[key]?.delete(ctx.sessionManager.getSessionId()));
  throw new Error("PARTIAL_FACTORY");
}` : "export const fixture = true;";
        fs.writeFileSync(join(packagePath(dir), "src/index.ts"), body);
      }
    }
    // Do not let package resolution repair these deliberately broken fixtures.
    const runtime = await runtimeFor(dir, [bootstrapPath(dir)]);
    const result = await call(runtime, "ordinary.txt"); assert.equal(result?.block, true, name);
    if (name === "partial-factory") {
      assert(getPermissionsService(runtime.session.sessionManager.getSessionId()), "Partial factory really published ready/service");
      assert.match(result.reason, /could not load/, "Initialization latch, not missing-service check, rejects partial factory");
    }
    await runtime.dispose(); runtimes.pop();
  }

  for (const order of ["before", "after", "automatic-migration-window"]) {
    const dir = fixture(`duplicate-${order}`); install(dir);
    let explicit;
    if (order === "automatic-migration-window") fs.writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@gotgenes/pi-permission-system@32.0.3"] }));
    else explicit = order === "before" ? [join(installed, "src/index.ts"), bootstrapPath(dir)] : [bootstrapPath(dir), join(installed, "src/index.ts")];
    const runtime = await runtimeFor(dir, explicit);
    assert.equal((await call(runtime, "ordinary.txt"))?.block, true, order);
    await runtime.dispose(); runtimes.pop();
  }

  // A failed installation must never disable the only existing authority.
  for (const kind of ["unknown-file", "symlink-file", "symlink-directory", "bad-source"]) {
    const dir = fixture(`install-${kind}`), before = fs.readFileSync(join(dir, "settings.json"), "utf8");
    const target = join(dir, "extensions/managed-permissions");
    if (kind === "symlink-directory") { fs.mkdirSync(join(dir, "other")); fs.symlinkSync(join(dir, "other"), target); }
    else if (kind !== "bad-source") {
      fs.mkdirSync(target);
      if (kind === "unknown-file") fs.writeFileSync(bootstrapPath(dir), "unrelated extension");
      else fs.symlinkSync(join(dir, "settings.json"), bootstrapPath(dir));
    }
    const result = migrate(dir, kind === "bad-source" ? join(cwd, "ordinary.txt") : bootstrapSource);
    assert.notEqual(result.status, 0, kind);
    assert.equal(fs.readFileSync(join(dir, "settings.json"), "utf8"), before, kind);
    assert(!fs.existsSync(join(dir, "settings.json.before-managed-permissions-v1")), kind);
  }
  // Bad settings cannot be safely classified as "no migration needed". Fail
  // visibly without publishing a bootstrap, rewriting settings or backing up junk.
  for (const [kind, content] of [
    ["empty", ""], ["truncated", "{"], ["array", "[]"], ["null", "null"],
    ["packages-object", '{"packages":{}}'],
    ["duplicates", JSON.stringify({ packages: ["npm:@gotgenes/pi-permission-system", "npm:@gotgenes/pi-permission-system@32.0.3"] })],
    ["symlink", JSON.stringify({ packages: ["npm:@gotgenes/pi-permission-system@32.0.3"] })],
  ]) {
    const dir = fixture(`settings-${kind}`), path = join(dir, "settings.json");
    fs.writeFileSync(path, content);
    if (kind === "symlink") {
      fs.renameSync(path, join(dir, "settings-target.json"));
      fs.symlinkSync(join(dir, "settings-target.json"), path);
    }
    assert.notEqual(migrate(dir).status, 0, kind);
    assert.equal(fs.readFileSync(path, "utf8"), content, kind);
    if (kind === "symlink") assert(fs.lstatSync(path).isSymbolicLink());
    assert(!fs.existsSync(bootstrapPath(dir)), kind);
    assert(!fs.existsSync(`${path}.before-managed-permissions-v1`), kind);
  }
  assert.equal(modelAttempts, 0); assert.equal(processAttempts, 0); assert.equal(prompts, 0); assert.deepEqual(errors, []);
  console.log("PASS: automatic legacy/managed/rollback/re-upgrade, new/switch/reload, broken/partial bootstrap fail-closed, duplicates, safe migration failures; zero model/process/UI attempts");
} finally {
  for (const runtime of runtimes.reverse()) await runtime.dispose();
  for (const [name, fn] of originals) childProcess[name] = fn;
  syncBuiltinESMExports(); fs.rmSync(scratch, { recursive: true, force: true });
}
