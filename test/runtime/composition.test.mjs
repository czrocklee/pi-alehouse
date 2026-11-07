import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { packageRoot } from "../../bin/runtime-support.mjs";
import { initialize } from "../../scripts/init.mjs";

async function loadExtensions(paths, cwd) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: paths,
  });
  await loader.reload();
  return loader.getExtensions();
}
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const temporary = (t) => {
  const path = mkdtempSync(join(tmpdir(), "alehouse-composition-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const sessionContext = (id) => ({
  sessionManager: { getSessionId: () => id },
  ui: { notify() {} },
});
const fixtures = [
  ["harness", "harness/src/extension.ts"],
  ["queue", "runtime/policy/ui-prompt-queue.ts"],
  ["jev", "runtime/policy/jev-auto-approval.ts"],
  ["permission", "runtime/permission-system/index.ts"],
  ["static", "runtime/policy/static-safety-guard.ts"],
  ["grep", "runtime/policy/policy-grep.ts"],
  ["footer", "runtime/policy/status-footer.ts"],
  ["approval", "runtime/policy/approval-mode.ts"],
  ["stats", "runtime/policy/stats.ts"],
  ["title", "runtime/policy/terminal-title-status.ts"],
  ["web", "web.ts"],
];
const registryKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
async function fixture(t, replacements = {}, initializeProtection = "") {
  const root = temporary(t);
  const observations = [];
  const key = `alehouse-test-${root}`;
  globalThis[key] = observations;
  t.after(() => {
    delete globalThis[key];
  });
  cpSync(join(packageRoot, "composition.ts"), join(root, "composition.ts"));
  write(join(root, "package.json"), '{"type":"module"}');
  write(
    join(root, "harness/src/tools/tool-names.ts"),
    'export const managementToolNames = ["fixture-management"];',
  );
  // The real helper is exercised separately with a production-shaped native
  // module. This fixture keeps every factory synthetic and order-observable.
  write(
    join(root, "harness/src/runtime/parent-web.ts"),
    `import { pathToFileURL } from "node:url";
export const loadParentWeb = (entry) => import(pathToFileURL(entry).href);`,
  );
  write(
    join(root, "bin/runtime-support.mjs"),
    `export const packageRoot=${JSON.stringify(root)};
export function preflight(){return {runtime:packageRoot+'/runtime',policyRoot:packageRoot+'/runtime/policy',permissionRoot:packageRoot+'/runtime/permission-system',web:packageRoot+'/web.ts'};}
export function runtimeEnvironment(){return {};}
export function protectionResources(){return {writeRoots:[],readFiles:[]};}`,
  );
  for (const [name, path] of fixtures) {
    const register =
      name === "harness"
        ? 'pi.registerTool({name:"fixture-management",description:"fixture",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});'
        : "";
    const source =
      replacements[name] ??
      `export default function(pi){globalThis[${JSON.stringify(key)}].push(${JSON.stringify(name)}); pi.on('session_start',()=>{globalThis[${JSON.stringify(key)}].push(${JSON.stringify(name + ":start")});${register}});}`;
    write(
      join(root, path),
      source +
        (name === "permission"
          ? `\nexport function initializeManagedResourceProtection(){${initializeProtection}}\nexport function getPermissionsService(){}`
          : ""),
    );
  }
  const loaded = await loadExtensions([join(root, "composition.ts")], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(
    loaded.extensions.length,
    1,
    "factory failure must retain the one guarded extension",
  );
  return { extension: loaded.extensions[0], observations, root };
}
async function blocked(extension) {
  const handlers = extension.handlers.get("tool_call");
  assert(handlers?.length);
  return handlers[0]({ toolName: "bash", input: { command: "true" } });
}

test("single composition invokes its ordered factories", async (t) => {
  const { extension, observations } = await fixture(t);
  assert.deepEqual(
    observations,
    fixtures.map(([name]) => name),
  );
  assert.match((await blocked(extension)).reason, /not ready/);
  const authority = {};
  const previous = globalThis[registryKey];
  globalThis[registryKey] = new Map([["ordered", authority]]);
  t.after(() => {
    globalThis[registryKey] = previous;
  });
  for (const handler of extension.handlers.get("session_start"))
    await handler({}, sessionContext("ordered"));
  assert.deepEqual(
    observations.slice(fixtures.length),
    fixtures.map(([name]) => name + ":start"),
  );
  assert.equal(await blocked(extension), undefined);
  globalThis[registryKey].set("ordered", {});
  assert.match((await blocked(extension)).reason, /authority/);
  assert.throws(() => extension.handlers.get("user_bash")[0](), /authority/);
});

test("early immutable resource floor precedes Jev module key capture and ordered factories", async (t) => {
  const root = temporary(t),
    key = `alehouse-floor-${root}`;
  // A synthetic path only; no credential file is created or read.
  const keyPath = join(root, "synthetic-jev-key"),
    previous = process.env.PI_JEV_API_KEY_FILE;
  const state = { floor: false, order: [], captured: undefined, protectedKey: undefined };
  globalThis[key] = state;
  process.env.PI_JEV_API_KEY_FILE = keyPath;
  t.after(() => {
    delete globalThis[key];
    if (previous === undefined) delete process.env.PI_JEV_API_KEY_FILE;
    else process.env.PI_JEV_API_KEY_FILE = previous;
  });
  const access = `globalThis[${JSON.stringify(key)}]`;
  const guardedFactory = (name) => `export default function(){
    if (!${access}.floor) throw new Error("Factory ran before immutable floor");
    ${access}.order.push(${JSON.stringify(name + ":factory")});
  }`;
  const { extension } = await fixture(
    t,
    {
      permission: `${access}.order.push("permission:module"); ${guardedFactory("permission")}`,
      harness: guardedFactory("harness"),
      queue: guardedFactory("queue"),
      jev: `const state = ${access};
if (!state.floor) throw new Error("Jev module imported before immutable floor");
state.order.push("jev:module");
state.captured = process.env.PI_JEV_API_KEY_FILE;
delete process.env.PI_JEV_API_KEY_FILE;
export default function(){
  if (!state.floor || state.captured !== state.protectedKey) throw new Error("Unprotected Jev key capture");
  state.order.push("jev:factory");
}`,
    },
    `${access}.order.push("floor:init");
${access}.protectedKey = process.env.PI_JEV_API_KEY_FILE;
${access}.floor = true;`,
  );
  assert.deepEqual(state.order, [
    "permission:module",
    "floor:init",
    "harness:factory",
    "queue:factory",
    "jev:module",
    "jev:factory",
    "permission:factory",
  ]);
  assert.equal(
    state.protectedKey,
    keyPath,
    "the initializer observes the key path before Jev removes it",
  );
  assert.equal(state.captured, keyPath);
  assert.equal(process.env.PI_JEV_API_KEY_FILE, undefined);
  assert.equal(
    (await blocked(extension)).reason,
    "Alehouse session is not ready",
    "assembly succeeded without pretending a session started",
  );
});

test("immutable resource initializer failure retains tool guards and imports no later Jev module or factory", async (t) => {
  const key = `alehouse-floor-failure-${temporary(t)}`,
    state = { order: [] };
  globalThis[key] = state;
  t.after(() => {
    delete globalThis[key];
  });
  const access = `globalThis[${JSON.stringify(key)}]`;
  const { extension, observations } = await fixture(
    t,
    {
      permission: `${access}.order.push("permission:module");
export default function(){ ${access}.order.push("permission:factory"); }`,
      jev: `${access}.order.push("jev:module");
export default function(){ ${access}.order.push("jev:factory"); }`,
    },
    `${access}.order.push("floor:init"); throw new Error("IMMUTABLE_FLOOR_INIT_FAILED");`,
  );
  assert.deepEqual(
    state.order,
    ["permission:module", "floor:init"],
    "failure prevents even Jev's top-level key capture",
  );
  assert.deepEqual(observations, [], "no later factory, including harness, is invoked");
  const result = await blocked(extension);
  assert.equal(result.block, true);
  assert.match(result.reason, /IMMUTABLE_FLOOR_INIT_FAILED/);
  assert.throws(() => extension.handlers.get("user_bash")[0](), /IMMUTABLE_FLOOR_INIT_FAILED/);
  for (const handler of extension.handlers.get("session_start"))
    await handler({}, sessionContext("floor-failed"));
  assert.equal(
    (await blocked(extension)).block,
    true,
    "session_start cannot clear the initialization failure latch",
  );
});

test("composition imports permission once and passes that same interface to harness before invoking its factory", async (t) => {
  const key = `alehouse-permission-once-${temporary(t)}`;
  const state = { imports: 0, factories: 0, marker: {}, received: undefined };
  globalThis[key] = state;
  t.after(() => {
    delete globalThis[key];
  });
  const access = `globalThis[${JSON.stringify(key)}]`;
  const { extension } = await fixture(t, {
    permission: `${access}.imports++;
export const marker = ${access}.marker;
export default function(){ ${access}.factories++; }`,
    harness: `export default function(_pi, startup){ ${access}.received = startup.permission.marker; }`,
  });
  assert.equal(state.imports, 1);
  assert.equal(
    state.factories,
    1,
    "the canonical authority factory is invoked once in its ordered slot",
  );
  assert.equal(
    state.received,
    state.marker,
    "the harness receives the already-imported interface, not a lookup fallback",
  );
  assert.equal((await blocked(extension)).reason, "Alehouse session is not ready");
});

test("the harness reads, per use, exactly the tools the parent's web-access factory registered", async (t) => {
  const key = `alehouse-parent-web-${temporary(t)}`;
  const state = { read: undefined, before: undefined };
  globalThis[key] = state;
  t.after(() => {
    delete globalThis[key];
  });
  const access = `globalThis[${JSON.stringify(key)}]`;
  const tool = (name) =>
    `pi.registerTool({name:${JSON.stringify(name)},description:"fixture",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});`;
  await fixture(t, {
    harness: `export default function(pi, startup){ ${access}.read = startup.parentWebTools; ${access}.before = startup.parentWebTools(); ${tool("fixture-management")} }`,
    grep: `export default function(pi){ ${tool("fixture-policy-tool")} }`,
    // Configured names, not the defaults: membership comes from the owner.
    web: `export default function(pi){ ${tool("renamed_search")} ${tool("web_enable")} }`,
  });
  assert.deepEqual(state.before, [], "the harness factory runs before web-access registers");
  assert.deepEqual(state.read().toSorted(), ["renamed_search", "web_enable"]);
});

test("a later invalid preset cannot reuse a previous session's successful registrations", async (t) => {
  // Same loaded factory and SDK dispatch throughout; only harness internals and
  // authority publication are fixtures. The real invalid-first-start case is
  // independently covered by the offline parent session smoke.
  const { extension, root } = await fixture(t, {
    harness: `
    import { readFileSync } from "node:fs";
    export default function(pi) {
      pi.on("session_start", () => {
        const config = JSON.parse(readFileSync(new URL("../../harness-presets.json", import.meta.url), "utf8"));
        if (config.defaultPreset !== "off" && !Object.hasOwn(config.presets, config.defaultPreset)) return;
        pi.registerTool({name:"fixture-management",description:"fixture",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
      });
    }`,
  });
  const presetPath = join(root, "harness-presets.json");
  writeFileSync(presetPath, JSON.stringify({ version: 3, defaultPreset: "off", presets: {} }));
  const previous = globalThis[registryKey];
  globalThis[registryKey] = new Map([
    ["first", {}],
    ["second", {}],
  ]);
  t.after(() => {
    globalThis[registryKey] = previous;
  });
  let ctx = sessionContext("first");
  const errors = [];
  const runner = {
    extensions: [extension],
    createContext: () => ctx,
    isSessionBeforeEvent: () => false,
    emitError: (error) => errors.push(error.error),
  };
  const emit = (event) => ExtensionRunner.prototype.emit.call(runner, event);
  const tool = () =>
    ExtensionRunner.prototype.emitToolCall.call(runner, {
      type: "tool_call",
      toolCallId: "read",
      toolName: "read",
      input: { path: "fixture.txt" },
    });
  const bash = () =>
    ExtensionRunner.prototype.emitUserBash.call(runner, {
      type: "user_bash",
      command: "true",
      excludeFromContext: false,
    });
  await emit({ type: "session_start" });
  assert.equal(await tool(), undefined);
  assert.equal(await bash(), undefined);
  await emit({ type: "session_shutdown", reason: "quit" });
  assert(
    extension.tools.has("fixture-management"),
    "the old registration remains in Pi's extension map",
  );
  writeFileSync(presetPath, JSON.stringify({ version: 3, defaultPreset: "missing", presets: {} }));
  ctx = sessionContext("second");
  await emit({ type: "session_start" });
  assert.deepEqual(errors, [], "the fixture returns early rather than throwing");
  const blocked = await tool();
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Harness initialization did not complete/);
  await assert.rejects(bash(), /Harness initialization did not complete/);
});

test("failed dynamic import retains first tool and user-bash fail-closed guards", async (t) => {
  const { extension, observations } = await fixture(t, {
    jev: 'throw new Error("injected import failure"); export default () => {};',
  });
  assert.deepEqual(observations, ["harness", "queue"]);
  assert.match((await blocked(extension)).reason, /injected import failure/);
  assert.throws(() => extension.handlers.get("user_bash")[0](), /injected import failure/);
});

test("partial factory registration followed by failure remains guarded", async (t) => {
  const { extension } = await fixture(t, {
    jev: 'export default function(pi){pi.registerCommand("partial",{handler(){}});throw new Error("partial failure");}',
  });
  assert(extension.commands.has("partial"));
  assert.match((await blocked(extension)).reason, /partial failure/);
});

test("cross-factory registration collisions are fail-closed, never silent overwrite", async (t) => {
  const { extension } = await fixture(t, {
    harness:
      'export default function(pi){pi.registerCommand("same",{description:"first",handler(){}});}',
    jev: 'export default function(pi){pi.registerCommand("same",{description:"second",handler(){}});}',
  });
  assert.equal(extension.commands.get("same").description, "first");
  assert.match((await blocked(extension)).reason, /Registration collision registerCommand:same/);
});

test("a factory cannot clear the collision latch by catching its own registration error", async (t) => {
  const { extension } = await fixture(t, {
    harness:
      'export default function(pi){pi.registerCommand("caught",{description:"first",handler(){}});}',
    jev: 'export default function(pi){try{pi.registerCommand("caught",{description:"second",handler(){}})}catch{}}',
  });
  assert.equal(extension.commands.get("caught").description, "first");
  assert.match((await blocked(extension)).reason, /Registration collision/);
});

test("late cross-factory registration collisions also latch failure", async (t) => {
  const { extension } = await fixture(t, {
    harness:
      'export default function(pi){pi.on("session_start",()=>pi.registerCommand("late",{description:"first",handler(){}}));}',
    jev: 'export default function(pi){pi.registerCommand("late",{description:"second",handler(){}});}',
  });
  for (const handler of extension.handlers.get("session_start")) {
    try {
      await handler({}, sessionContext("late"));
    } catch {
      /* Pi reports hook errors and continues */
    }
  }
  assert.match((await blocked(extension)).reason, /Registration collision/);
});

test("session-start failure cannot fabricate ready even with an authority", async (t) => {
  const { extension } = await fixture(t, {
    harness:
      'export default function(pi){pi.on("session_start",()=>{throw new Error("startup failure")});}',
  });
  const previous = globalThis[registryKey];
  globalThis[registryKey] = new Map([["failed", {}]]);
  t.after(() => {
    globalThis[registryKey] = previous;
  });
  for (const handler of extension.handlers.get("session_start")) {
    try {
      await handler({}, sessionContext("failed"));
    } catch {
      /* same Pi dispatch behavior */
    }
  }
  assert.match((await blocked(extension)).reason, /startup failure/);
  assert.throws(() => extension.handlers.get("user_bash")[0](), /startup failure/);
});

test("real pinned package factories load as one host extension with web_enable", async (t) => {
  const agentDir = temporary(t);
  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_HARNESS_PERMISSION_ROOT;
  delete process.env.PI_HARNESS_POLICY_ROOT;
  delete process.env.PI_HARNESS_FLOCK;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  initialize({ agentDir });
  const loaded = await loadExtensions([join(packageRoot, "composition.ts")], agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(
    (await blocked(extension)).reason,
    "Alehouse session is not ready",
    "no caught factory failure",
  );
  assert(extension.tools.has("web_enable"), "pinned web lazy-loader must remain available");
  assert(extension.commands.has("harness-status"));
  assert(
    !extension.commands.has("auto-approval"),
    "the retired Luna judge's command must not return",
  );
});
