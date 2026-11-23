// Pinned Pi owns replacement (including setup before rebind). Only UI answers
// and provider responses are scripted; no CLI/PTY or live-host evidence.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.argv[2];
assert(["custom", "base"].includes(scenario));
const home = process.env.ALEHOUSE_CLEAR_FIXTURE_HOME;
assert(home && isAbsolute(home), "run through clear-handoff.test.mjs with an owned HOME");
assert.equal(process.env.HOME, home);
const agentDir = join(home, "agent");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
for (const [key, directory] of Object.entries({
  XDG_CONFIG_HOME: ".config",
  XDG_CACHE_HOME: ".cache",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
}))
  assert.equal(process.env[key], join(home, directory));
const network = [];
const blocked = (surface) => () => {
  network.push(surface);
  throw new Error(`Unexpected ${surface} network IO in clear-handoff fixture`);
};
globalThis.fetch = blocked("fetch");
for (const [module, names] of [
  [http, ["request", "get"]],
  [https, ["request", "get"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
])
  for (const name of names) module[name] = blocked(name);
net.Socket.prototype.connect = blocked("socket.connect");
syncBuiltinESMExports();

const ai = await import("@earendil-works/pi-ai");
const {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { initialize } = await import("../../../scripts/init.mjs");
const { packageRoot } = await import("../../../bin/runtime-support.mjs");
const { controlledProvider } = await import("../../support/host.mjs");

const cwd = join(home, "project"),
  sessions = join(home, "sessions");
mkdirSync(join(cwd, ".git"), { recursive: true }); // Bound project resource discovery.
mkdirSync(sessions);
initialize({ agentDir });
initTheme(undefined, false);
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return text;
}
const json = (path, data) => put(path, JSON.stringify(data, null, 2) + "\n");
const preset = (version, model, effort) => ({
  version,
  slots: Object.fromEntries(
    ["d1", "d2", "d3", "d4", "d5"].map((slot) => [
      slot,
      { model: `alehouse-fixture/${model}`, effort },
    ]),
  ),
});
const custom = preset("branch-fixture", "custom-worker", "medium");
const saved = preset("saved-fixture", "saved-worker", "low");
if (scenario === "base") saved.slots.d2 = { model: "alehouse-fixture/saved-alt", effort: "medium" };
const cataloguePath = join(agentDir, "alehouse-presets.json");
const writeCatalogue = (definition) =>
  json(cataloguePath, { version: 3, defaultPreset: "off", presets: { saved: definition } });
let expectedCatalogue = writeCatalogue(saved);
const configPath = join(agentDir, "extensions/pi-alehouse/config.json");
const defaults = {
  version: 2,
  preset: "saved",
  delegation: { mode: "supervisor", eagerness: "reserved" },
  ...(scenario === "base" ? { effort: { saved: { d1: "high" } } } : {}),
  childSkills: true,
  ui: { beerMugs: false, borderLabels: true },
};
let expectedConfig = { ...defaults, approval: "manual" };
const original = json(configPath, expectedConfig);
const writeConfig = (value) => {
  json(configPath, value);
  expectedConfig = value;
};
json(join(agentDir, "settings.json"), { cacheWarming: "off" });
put(
  join(agentDir, "skills/clear-fixture/SKILL.md"),
  "---\nname: clear-fixture\ndescription: A local handoff fixture.\n---\nFixture body.\n",
);
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false,
});
const provider = controlledProvider(ai);
const wire = [];
modelRuntime.registerProvider("alehouse-fixture", {
  ...provider.config,
  models: [
    ...provider.config.models,
    ...["custom-worker", "saved-worker", "saved-alt", "edited-worker"].map((id) => ({
      ...provider.config.models[0],
      id,
      name: id,
      reasoning: true,
    })),
  ],
  streamSimple(model, context, options) {
    wire.push({ model: model.id, effort: options?.reasoning });
    return provider.config.streamSimple(model, context, options);
  },
});
const model = modelRuntime.getModel("alehouse-fixture", "controlled");
assert(model);
const presetEntry = "alehouse:preset-selection:v1";
const approvalEntry = "approval-mode:choice:v1";
const controlsEntry = "alehouse:clear-controls:v1";
const runLink = "alehouse:run-link:v1";
const initial = SessionManager.create(cwd, sessions);
if (scenario === "custom") {
  // Only the active preset's definition and overrides may cross /clear.
  const definitions = { local: custom, inactive: preset("inactive-fixture", "saved-alt", "low") };
  initial.appendCustomEntry(presetEntry, {
    name: "inactive",
    custom_presets: definitions,
    effort_overrides: { d3: "high" },
  });
  initial.appendCustomEntry(presetEntry, {
    name: "local",
    custom_presets: definitions,
    effort_overrides: { d1: "high" },
  });
}

const notices = [],
  menus = [],
  errors = [],
  selects = [],
  confirmations = [],
  rebinds = [];
const statuses = new Map();
const noop = () => {};
const ui = {
  async select(title, options) {
    menus.push({ title, options });
    if (!selects.length) return undefined; // Read-only inspection of live option labels.
    const answer = selects.shift();
    assert(options.includes(answer), JSON.stringify({ title, options, answer }));
    return answer;
  },
  async confirm(title) {
    const queued = confirmations.shift();
    const [expected, answer] = Array.isArray(queued) ? queued : [queued, true];
    if (title !== expected) {
      const failure = `Unexpected confirmation ${JSON.stringify({ title, expected })}`;
      errors.push(failure); // Startup approval can catch a dialog failure internally.
      throw new Error(failure);
    }
    return answer;
  },
  notify: (message, type) => notices.push({ message, type }),
  setStatus: (key, value) => statuses.set(key, value),
  setWidget: noop,
  setFooter: noop,
  setTitle: noop,
  onTerminalInput: () => noop,
  theme: { fg: (_color, text) => text, bold: (text) => text },
};
const host = await createAgentSessionRuntime(
  async (target) => {
    const services = await createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(
        { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
        { projectTrusted: true },
      ),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true, // Only the real child factory may discover skills.
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        additionalExtensionPaths: [join(packageRoot, "src/composition.ts")],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSessionFromServices({
      ...target,
      services,
      model,
      thinkingLevel: "off",
      tools: ["agent_spawn"],
    });
    return { session, services, diagnostics: services.diagnostics };
  },
  { cwd, agentDir, sessionManager: initial },
);
const bind = async (session) => {
  statuses.clear();
  await session.bindExtensions({
    mode: "rpc",
    uiContext: ui,
    commandContextActions: { newSession: (options) => host.newSession(options) },
    onError: (event) => errors.push(event.error),
  });
  rebinds.push(session.sessionId);
};
host.setRebindSession(bind);
const command = async (line) => {
  await host.session.prompt(line);
  assert.deepEqual(errors, [], line);
  assert.deepEqual(
    notices.filter(({ type }) => type === "error"),
    [],
    line,
  );
};
const settings = async (...answers) => {
  selects.push(...answers);
  await command("/alehouse-settings");
  assert.deepEqual(selects, [], "settings answers consumed");
};
const preferences = async () => {
  await settings("Show paths and pending changes");
  return JSON.parse(notices.at(-1).message);
};
const appearance = async (mugs, labels, skills) => {
  await settings();
  assert.deepEqual(menus.at(-1).options.slice(0, 3), [
    `Beer mugs: ${mugs}`,
    `Border labels: ${labels} (all Alehouse panels)`,
    `Agent skills: ${skills}`,
  ]);
};
const stats = async () => {
  await command("/alehouse-status");
  return JSON.parse(notices.at(-1).message);
};
const permission = (id) =>
  globalThis[Symbol.for("@gotgenes/pi-permission-system:session-services")]?.get(id);
const yolo = (id) => globalThis[Symbol.for("@rocklee/managed-permissions:session-yolo")]?.has(id);

async function spawn(tag, workerModel, effort, skills, difficulty = 1) {
  const start = provider.requests.length,
    wireStart = wire.length;
  const task = `synthetic-${tag}`;
  let invoked = false;
  provider.respond(async ({ context }) => {
    if (context.systemPrompt.includes('<active_agent name="editor"/>')) return { text: task };
    if (invoked) return { text: "Parent finished" };
    invoked = true;
    return {
      tools: [
        {
          type: "toolCall",
          id: task,
          name: "agent_spawn",
          arguments: {
            agent: difficulty === 1 ? "swift" : "tern",
            profile: "worker",
            reasoning_difficulty: difficulty,
            prompt: `Inspect ${task}`,
            label: task,
            wait_ms: 10000,
          },
        },
      ],
    };
  });
  await host.session.prompt(`OLD_OR_NEW_PARENT_${tag}`, { expandPromptTemplates: false });
  const result = host.session.messages.find((message) => message.toolCallId === task);
  assert.equal(result?.isError, false, JSON.stringify({ result, notices, errors }));
  const row = JSON.parse(result.content[0].text).tasks[0];
  assert.equal(row.status, "completed", JSON.stringify(row));
  assert.equal(row.result, task);
  const requests = provider.requests.slice(start).filter(({ model }) => model.id !== "controlled");
  assert.equal(requests.length, 1, "a real worker made exactly one fixture request");
  assert.equal(requests[0].context.systemPrompt.includes("<name>clear-fixture</name>"), skills);
  assert.deepEqual(
    wire.slice(wireStart).filter(({ model }) => model !== "controlled"),
    [{ model: workerModel, effort }],
  );
}

const rebound = async (previous) => {
  const incoming = host.session;
  assert.notEqual(incoming, previous);
  assert.notEqual(incoming.sessionId, previous.sessionId);
  assert.equal(rebinds.at(-1), incoming.sessionId, "real SDK rebound the new session");
  assert.equal(permission(previous.sessionId), undefined, "old permission service was torn down");
  assert(permission(incoming.sessionId), "fresh authority is ready");
  assert.equal(yolo(previous.sessionId), false, "old yolo was revoked");
  assert.equal(yolo(incoming.sessionId), false, "yolo was not inherited");
  assert.equal(statuses.get("approval"), "approval: manual");
  const state = await stats();
  assert.equal(state.closed, false, "fresh Owner is open");
  for (const key of ["agents", "resident", "requests", "runs"])
    assert.equal(state[key], 0, `fresh Owner did not inherit ${key}`);
  await command("/fast status");
  assert.match(notices.at(-1).message, /^Fast is off/);
  const { scope, pending } = await preferences();
  assert.equal(scope, "session");
  assert.deepEqual(pending, [], "old staging queue was not transferred");
  return incoming;
};
const replacedContext = async (previous) => {
  const incoming = await rebound(previous);
  assert.deepEqual(incoming.messages, [], "old transcript was not copied");
  assert.equal(incoming.sessionManager.getHeader().parentSession, undefined, "not a fork");
  assert(
    !incoming.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" ||
          entry.customType?.startsWith("alehouse:run-") ||
          entry.customType === approvalEntry,
      ),
    "no old messages, Run links, or approval records anywhere in the destination session",
  );
  return incoming.sessionManager.getBranch();
};

async function customHandoff() {
  const old = host.session;
  await bind(old);
  assert.equal(statuses.get("alehouse-preset"), "delegation: supervisor/local*");
  await command("/alehouse-mode lead eager");
  await settings("Beer mugs: off");
  await settings("Border labels: on (all Alehouse panels)");
  await settings("Agent skills: on");
  await appearance("on", "off", "off");
  assert.deepEqual((await preferences()).pending, [], "the live choices are session-only");
  await command("/fast ultrafast");
  assert.match(notices.at(-1).message, /^Speed ceiling: Ultrafast/);
  confirmations.push("Turn on yolo for this session?");
  await command("/approval yolo");
  assert.equal(statuses.get("approval"), "approval: YOLO");
  assert.equal(yolo(old.sessionId), true);
  await spawn("before-clear", "custom-worker", "high", false);
  const oldStats = await stats();
  assert.equal(oldStats.runs, 1);
  assert.equal(oldStats.resident, 1);
  assert(old.messages.some(({ role }) => role === "user"));
  const oldBranch = old.sessionManager.getBranch();
  assert(oldBranch.some((entry) => entry.customType === runLink));
  assert(oldBranch.some((entry) => entry.customType === approvalEntry && entry.data.yolo));

  // Make a distinct pending preference via real UI without saving the live
  // session-only toggles. The old queue still flushes on ordinary shutdown.
  confirmations.push("Remember in global?", "Remember in global?");
  await settings("Change save scope", "global");
  await settings("Remove a saved override", "global", '["approval"]');
  const staged = await preferences();
  assert.equal(staged.scope, "global");
  assert.deepEqual(
    staged.pending.map(({ scope, path }) => ({ scope, path })),
    [{ scope: "global", path: ["approval"] }],
  );
  assert.equal(readFileSync(configPath, "utf8"), original);

  confirmations.push("Close Alehouse Owner and change session?");
  await command("/clear");
  expectedConfig = defaults;
  const cleared = await replacedContext(old);
  assert.equal(statuses.get("alehouse-preset"), "delegation: lead·eager/local*");
  await appearance("on", "off", "off");
  const selections = cleared.filter((entry) => entry.customType === presetEntry);
  assert.equal(selections.length, 1, "no selection or effort record for the inactive preset");
  const selection = selections[0].data;
  assert.equal(selection.name, "local");
  assert.deepEqual(selection.custom_presets, { local: custom });
  assert.deepEqual(selection.effort_overrides, { d1: "high" });
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, "utf8")),
    defaults,
    "shutdown flushed only the staged removal, not the /clear handoff",
  );
  const afterClear = host.session;
  await spawn("after-clear", "custom-worker", "high", false);

  // Native /new calls this same SDK replacement method without command options.
  confirmations.push("Close Alehouse Owner and change session?");
  assert.deepEqual(await host.newSession(), { cancelled: false });
  const fresh = await replacedContext(afterClear);
  assert(!fresh.some((entry) => entry.customType === controlsEntry), "no second handoff record");
  assert.equal(statuses.get("alehouse-preset"), "delegation: supervisor/saved");
  await appearance("off", "on", "on");
  await spawn("after-new", "saved-worker", "low", true);
  assert.equal(rebinds.length, 3, "initial bind plus exactly one bind per replacement");
}

async function mode(expected) {
  await command("/alehouse-mode");
  const { mode, eagerness, eagerness_active } = JSON.parse(notices.at(-1).message);
  assert.deepEqual({ mode, eagerness }, expected);
  assert.equal(eagerness_active, expected.mode === "co-worker" || expected.mode === "lead");
}

function assertOldBaseRecord(branch) {
  const selected = branch.findLast((entry) => entry.customType === presetEntry)?.data;
  assert.equal(selected?.name, "saved");
  assert.equal(selected.version, saved.version);
  const slots = Object.entries(saved.slots);
  assert.deepEqual(
    selected.models,
    Object.fromEntries(slots.map(([key, slot]) => [key, slot.model])),
  );
  const defaultEffort = Object.fromEntries(slots.map(([key, slot]) => [key, slot.effort]));
  // d1's original default is still meaningful even while dispatch uses its override.
  assert.deepEqual(selected.effort_defaults, defaultEffort);
  assert.deepEqual(selected.effort_overrides, { d1: "high" });
  assert.deepEqual(selected.effort, { ...defaultEffort, d1: "high" });
}

async function oldBaseRoutes(tag, skills) {
  await spawn(`${tag}-override`, "saved-worker", "high", skills);
  await spawn(`${tag}-default`, "saved-alt", "medium", skills, 2);
}

async function resume(target, { used = true, declineYolo = false } = {}) {
  const previous = host.session;
  const id = target.getSessionId();
  const file = target.getSessionFile();
  assert(file);
  if (used) confirmations.push("Close Alehouse Owner and change session?");
  if (declineYolo) confirmations.push(["Resume yolo for this session?", false]);
  assert.deepEqual(await host.switchSession(file), { cancelled: false });
  // Approval offers a new choice after binding, never reapplying yolo silently.
  if (declineYolo) await delay(0);
  assert.deepEqual(confirmations, [], "switch consumed only its scripted confirmations");
  const incoming = await rebound(previous);
  assert.equal(incoming.sessionId, id);
  assert.equal(incoming.sessionFile, file);
  return incoming;
}

function assertHistoricalWork(session, tag) {
  assert(
    session.messages.some(
      ({ role, content }) =>
        role === "user" &&
        content.some((part) => part.type === "text" && part.text === `OLD_OR_NEW_PARENT_${tag}`),
    ),
    "resume reopened the original conversation",
  );
  assert(
    session.sessionManager.getBranch().some((entry) => entry.customType === runLink),
    "old Run links are still historical, not live Owner state",
  );
}

async function offTurn(tag) {
  assert.equal(statuses.get("alehouse-preset"), "delegation: off");
  const start = provider.requests.length;
  provider.respond(async () => ({ text: tag }));
  await host.session.prompt(tag, { expandPromptTemplates: false });
  assert.deepEqual(
    provider.requests.slice(start).map(({ model }) => model.id),
    ["controlled"],
  );
  assert(!provider.requests[start].context.tools.some(({ name }) => name === "agent_spawn"));
}

async function baseHandoff() {
  const base = host.session;
  await bind(base);
  assert.equal(statuses.get("alehouse-preset"), "delegation: supervisor/saved*");
  await mode(defaults.delegation);
  // No select, effort edit or mode change: startup alone pins both policies.
  assertOldBaseRecord(base.sessionManager.getBranch());
  await oldBaseRoutes("startup", true);
  await settings("Beer mugs: off");
  await settings("Border labels: on (all Alehouse panels)");
  await settings("Agent skills: on");
  await appearance("on", "off", "off");

  const unrelated = SessionManager.create(cwd, sessions);
  unrelated.appendMessage({
    role: "user",
    content: "An unrelated Pi session",
    timestamp: Date.now(),
  });
  assert(unrelated.getEntries().every((entry) => entry.type !== "custom"));

  // This is a same-name edit, not a rename: both original and edited models
  // are still locally available and a fallback to either would look valid.
  expectedCatalogue = writeCatalogue(preset("edited-fixture", "edited-worker", "low"));
  const edited = {
    ...defaults,
    delegation: { mode: "co-worker", eagerness: "eager" },
    effort: { saved: { d1: "medium" } },
  };
  writeConfig(edited);

  confirmations.push("Close Alehouse Owner and change session?");
  await command("/clear");
  assertOldBaseRecord(await replacedContext(base));
  const cleared = host.session;
  await mode(defaults.delegation);
  await appearance("on", "off", "off");
  await oldBaseRoutes("clear-base", false);
  await command("/fast ultrafast");
  assert.match(notices.at(-1).message, /^Speed ceiling: Ultrafast/);
  confirmations.push("Turn on yolo for this session?");
  await command("/approval yolo");
  assert.equal(yolo(cleared.sessionId), true);

  confirmations.push("Close Alehouse Owner and change session?");
  assert.deepEqual(await host.newSession(), { cancelled: false });
  const fresh = await replacedContext(cleared);
  assert(!fresh.some((entry) => entry.customType === controlsEntry));
  assert.equal(statuses.get("alehouse-preset"), "delegation: co-worker·eager/saved*");
  await mode(edited.delegation);
  await appearance("off", "on", "on");
  await spawn("new-override", "edited-worker", "medium", true);
  await spawn("new-default", "edited-worker", "low", true, 2);

  assertHistoricalWork(await resume(base.sessionManager), "startup-override");
  assert.equal(statuses.get("alehouse-preset"), "delegation: supervisor/saved*");
  await mode(defaults.delegation);
  await appearance("off", "on", "on");
  await oldBaseRoutes("resume-startup", true);

  assertHistoricalWork(
    await resume(cleared.sessionManager, { declineYolo: true }),
    "clear-base-override",
  );
  assert.equal(statuses.get("alehouse-preset"), "delegation: supervisor/saved*");
  await mode(defaults.delegation);
  await appearance("off", "on", "on");
  await oldBaseRoutes("resume-clear", true);

  const prior = host.session;
  writeConfig({ ...edited, preset: "off", delegation: defaults.delegation });
  confirmations.push("Close Alehouse Owner and change session?");
  assert.deepEqual(await host.newSession(), { cancelled: false });
  await replacedContext(prior);
  const off = host.session;
  await offTurn("off-at-startup");

  writeConfig(edited); // Default is now enabled; neither /clear nor resume may adopt it.
  await command("/clear"); // Off Owner never accepted work, so no closure dialog.
  await replacedContext(off);
  await mode(defaults.delegation);
  await offTurn("off-after-clear");

  await resume(unrelated, { used: false });
  assert.equal(statuses.get("alehouse-preset"), "delegation: co-worker·eager/saved*");
  await mode(edited.delegation);
  await spawn("unrelated-default", "edited-worker", "medium", true);

  await resume(off.sessionManager);
  await mode(defaults.delegation);
  await offTurn("off-after-resume");
}

const failures = [];
try {
  if (scenario === "custom") await customHandoff();
  else await baseHandoff();
  assert.deepEqual(confirmations, [], "all scripted confirmations consumed");
} catch (error) {
  failures.push(error);
}
try {
  const id = host.session.sessionId;
  await host.dispose();
  assert.equal(permission(id), undefined);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    notices.filter(({ type }) => type === "error"),
    [],
  );
  assert(!notices.some(({ message }) => /cleanup is incomplete|Settings not saved/.test(message)));
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), expectedConfig);
  assert.equal(readFileSync(cataloguePath, "utf8"), expectedCatalogue);
  assert.deepEqual(network, [], "nothing attempted to leave the process");
} catch (error) {
  failures.push(error);
}
if (failures.length) throw new AggregateError(failures, `${scenario} handoff or cleanup failed`);
console.log(`PASS: ${scenario}, offline`);
