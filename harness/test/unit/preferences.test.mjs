import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { SettingsStore } from "../../../lib/settings-store.mjs";
import { PresetRouter } from "../../dist/routing.js";
import { restorePresetRouter, restorePresetDefinitions } from "../../dist/extension.js";
import { PreferencesControls, stageWorkerSelection } from "../../dist/ui/preferences-controls.js";
import { createPresetModelSelector } from "../../dist/runtime/preset-model-selector.js";
import { PresetModelPopover } from "../../dist/ui/preset-model-popover.js";

const team = (model = "worker") => ({ version: "v1", models: { light: `fixture/${model}`, standard: `fixture/${model}`, strong: `fixture/${model}` }, effort: { light: "low", standard: "inherit", strong: "high" } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "alehouse-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "harness-presets.json");
  const config = { version: 2, defaultPreset: "off", presets: { team: team() } };
  await writeFile(path, JSON.stringify(config));
  const store = new SettingsStore({ agentDir: join(root, "agent"), cwd: join(root, "work"), projectTrusted: true });
  return { root, path, store, config, router: new PresetRouter(path), after: (cleanup) => t.after(cleanup) };
}

test("preferences seed fresh selections; historical effort/name-only records keep their original meaning", async (t) => {
  const f = await fixture(t);
  const prefs = { version: 1, preset: "team", effort: { team: { light: "max", strong: null } } };
  const fresh = restorePresetRouter(f.path, [], prefs).current();
  assert.equal(fresh.name, "team");
  assert.deepEqual(fresh.effort_overrides, { light: "max" });
  assert.equal(fresh.effort.strong, "high");
  for (const entries of [[{ name: "team" }], [{ name: "team", effort_overrides: {} }]]) {
    const restored = restorePresetRouter(f.path, entries, prefs).current();
    assert.deepEqual(restored.effort_overrides, {});
    assert.equal(restored.effort.light, "low");
  }
  const restored = restorePresetRouter(f.path, [{ name: "team", effort_overrides: { strong: "off" } }, { name: "team" }], prefs).current();
  assert.deepEqual(restored.effort_overrides, { strong: "off" }, "later legacy name-only records retain earlier session overrides");
  assert.equal(restorePresetRouter(f.path, [{ name: "off" }], prefs).current().name, "off");
  assert.throws(() => restorePresetRouter(f.path, [], { version: 1, preset: "removed" }), { code: "PRESET_NOT_FOUND" });
});

test("custom model preset candidates are transactional, immutable to callers and survive branch restoration", async (t) => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const definitions = { custom: team("other") };
  const candidate = f.router.prepare(definitions);
  definitions.custom.models.light = "mutated/no";
  assert(!f.router.names().includes("custom"), "preparation alone must not publish");
  assert.equal(f.router.inspect(candidate).find((x) => x.name === "custom").models.light, "fixture/other");
  assert.throws(() => f.router.apply(candidate, "custom", () => { throw new Error("audit failed"); }), /audit failed/);
  assert(!f.router.names().includes("custom"));
  const records = [];
  f.router.apply(candidate, "custom", (selection) => records.push({ ...selection, custom_presets: { custom: team("other") } }));
  assert.equal(f.router.current().models.light, "fixture/other");
  assert.equal(restorePresetRouter(f.path, records).current().models.light, "fixture/other");
  assert.deepEqual(restorePresetDefinitions(records), { custom: team("other") });
  assert.throws(() => restorePresetDefinitions([{ custom_presets: { off: team() } }]), { code: "INVALID_SAVED_PRESETS" });
  assert.equal(await readFile(f.path, "utf8"), before, "catalogue file is never rewritten");
  const old = f.router.prepare({ custom: team("old") });
  f.router.commit(f.router.prepare(), "off");
  assert.throws(() => f.router.commit(old, "custom"), { code: "STALE_PRESET_SELECTION" });
});

test("workspace preset definitions replace by name, and explicit branch edits override startup definitions", async (t) => {
  const f = await fixture(t);
  const prefs = { version: 1, preset: "team", presets: { team: team("global") } };
  assert.equal(restorePresetRouter(f.path, [], prefs).current().models.strong, "fixture/global");
  const records = [{ name: "team", custom_presets: { team: team("session") } }];
  assert.equal(restorePresetRouter(f.path, records, prefs).current().models.strong, "fixture/session");
});

test("routing accepts bounded global, workspace and session definitions together without enlarging stored records", async (t) => {
  const f = await fixture(t);
  const definitions = (prefix) => Object.fromEntries(Array.from({ length: 400 }, (_unused, index) =>
    [`${prefix}${index}`, { version: "v".repeat(64), models: {
      light: `fixture/${"m".repeat(100)}`, standard: `fixture/${"m".repeat(100)}`, strong: `fixture/${"m".repeat(100)}`,
    } }]));
  f.store.stage("global", ["presets"], definitions("global"));
  f.store.stage("workspace", ["presets"], definitions("workspace"));
  assert(f.store.flush().every((result) => !result.error));
  const preferences = new SettingsStore({ agentDir: join(f.root, "agent"), cwd: join(f.root, "work"), projectTrusted: true }).effective();
  const records = [{ name: "session0", custom_presets: definitions("session") }];
  const router = restorePresetRouter(f.path, records, preferences);
  assert.equal(router.current().name, "session0");
  assert.equal(router.names().length, 1202, "base + three custom layers + off");
  assert(Buffer.byteLength(JSON.stringify(router.customPresets())) > 512 * 1024);
  assert.equal(router.prepare().names.length, router.names().length);
  assert.throws(() => restorePresetDefinitions([{ custom_presets: router.customPresets() }]), { code: "INVALID_SAVED_PRESETS" },
    "session records contain only session definitions, not the larger merged routing catalogue");
});

test("applied changes stage only explicit fields; reset masks pins and Off preserves all effort preferences", async (t) => {
  const { router, store } = await fixture(t);
  const off = router.current();
  const first = router.apply(router.prepare(), "team", () => {}, { light: "high" });
  stageWorkerSelection(store, first, off, true);
  assert.deepEqual(store.pending(), [], "Session is the initial scope");
  store.setScope("workspace");
  stageWorkerSelection(store, first, off, true);
  assert.deepEqual(store.get("workspace"), { version: 1, preset: "team", effort: { team: { light: "high" } } });
  store.flush();
  const reset = router.apply(router.prepare(), "team", () => {}, {});
  stageWorkerSelection(store, reset, first, true, first.effort_overrides);
  assert.equal(store.get("workspace").effort.team.light, null);
  const next = router.apply(router.prepare(), "off", () => {});
  stageWorkerSelection(store, next, reset, false);
  assert.equal(store.get("workspace").preset, "off");
  assert.equal(store.get("workspace").effort.team.light, null);
});

function controls(f, answers = [], confirmations = []) {
  const notifications = [], published = [], confirmPrompts = [], selectPrompts = [];
  let live = true;
  const ctx = { hasUI: true, ui: {
    select: async (prompt, choices) => { selectPrompts.push({ prompt, choices }); return answers.shift(); }, input: async () => answers.shift(),
    confirm: async (title, text) => { confirmPrompts.push({ title, text }); return confirmations.shift() ?? false; },
    notify: (text, level) => notifications.push({ text, level }),
  }, modelRegistry: { getAll: () => [{ provider: "fixture", id: "worker", api: "fixture", reasoning: false }] } };
  const ui = new PreferencesControls({ ctx, store: f.store, router: () => f.router, ready: () => live,
    delegation: () => f.delegation ?? ({ mode: "lead", eagerness: "eager" }),
    publishDefinition: (candidate, name, definition) => published.push({ candidate, name, definition }),
  });
  return { ui, ctx, notifications, published, confirmPrompts, selectPrompts, retire: () => { live = false; } };
}

test("scope consent stages nothing; explicit remember previews and queues a snapshot, not a hidden disk write", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  const c = controls(f, ["Change save scope", "workspace"], [true]);
  await c.ui.open();
  assert.equal(f.store.scope, "workspace");
  assert.deepEqual(f.store.pending(), []);
  const remember = controls(f, ["Remember current worker settings", "global"], [true]);
  await remember.ui.open();
  assert.equal(f.store.scope, "workspace", "one-shot remember never changes the ongoing scope");
  assert.deepEqual(f.store.get("global").effort.team, { light: null, standard: null, strong: null });
  assert.deepEqual(f.store.get("global").delegation, { mode: "lead", eagerness: "eager" });
  await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  f.store.seal();
  assert.equal(f.store.flush()[0].error, undefined);
  assert.equal(JSON.parse(await readFile(f.store.paths.global, "utf8")).preset, "team");
});

test("cancelled or stale scope consent never changes save scope or creates files", async (t) => {
  const f = await fixture(t);
  const c = controls(f, ["Change save scope", "workspace"], [false]);
  await c.ui.open();
  assert.equal(f.store.scope, "session");
  const stale = controls(f, ["Change save scope", "workspace"]);
  stale.ctx.ui.confirm = async () => { stale.retire(); return true; };
  await assert.rejects(stale.ui.open(), { code: "SETTINGS_SESSION_CHANGED" });
  assert.equal(f.store.scope, "session");
  assert.deepEqual(f.store.pending(), []);
});

test("discard only drops pending persistence, while no-UI and untrusted workspace cannot opt in", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["preset"], "team");
  f.router.select("team");
  const c = controls(f, ["Discard pending writes"], [true]);
  await c.ui.open();
  assert.equal(f.router.current().name, "team");
  assert.deepEqual(f.store.pending(), []);
  c.ctx.hasUI = false;
  await assert.rejects(c.ui.open(), { code: "SETTINGS_UI_REQUIRED" });
  f.store = new SettingsStore({ agentDir: join(f.root, "agent"), cwd: join(f.root, "work"), projectTrusted: false });
  const denied = controls(f, ["Change save scope", "workspace"], [true]);
  await assert.rejects(denied.ui.open(), { code: "PROJECT_NOT_TRUSTED" });
  assert.deepEqual(f.store.pending(), []);
});

test("preset editor creates a physical model preset only after confirmation and rejects stale publication", async (t) => {
  const f = await fixture(t);
  const c = controls(f, ["custom", "fixture/worker", "inherit", "fixture/worker", "inherit", "fixture/worker", "inherit"], [true]);
  await c.ui.editPreset();
  assert.equal(c.published.length, 1);
  assert.equal(c.published[0].name, "custom");
  assert.deepEqual(c.published[0].definition.models, team().models);
  assert.deepEqual(c.published[0].definition.effort, { light: "inherit", standard: "inherit", strong: "inherit" });
  assert.deepEqual(f.store.pending(), [], "the editor only returns an audited commit request");
  const stale = controls(f, ["other", "fixture/worker", "inherit", "fixture/worker", "inherit", "fixture/worker", "inherit"]);
  stale.ctx.ui.confirm = async () => { f.router.select("team"); return true; };
  await assert.rejects(stale.ui.editPreset(), { code: "STALE_PRESET_SELECTION" });
  assert.equal(stale.published.length, 0);
});

test("preset editor cancellation and duplicate/reserved names never modify catalogue", async (t) => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const duplicate = controls(f, ["team"]);
  await assert.rejects(duplicate.ui.editPreset(), { code: "PRESET_ALREADY_EXISTS" });
  const reserved = controls(f, ["reload"]);
  await assert.rejects(reserved.ui.editPreset(), { code: "INVALID_PRESET_NAME" });
  const malformed = controls(f, ["../../escape"]);
  await assert.rejects(malformed.ui.editPreset(), { code: "INVALID_PRESET_NAME" });
  const cancel = controls(f, ["custom", undefined]);
  await cancel.ui.editPreset();
  assert.deepEqual(cancel.published, []);
  const noModels = controls(f, ["custom"]);
  noModels.ctx.modelRegistry.getAll = () => [{ provider: "fixture", id: "virtual", api: "pi-virtual" }];
  await assert.rejects(noModels.ui.editPreset(), { code: "PRESET_MODEL_UNAVAILABLE" });
  assert.equal(await readFile(f.path, "utf8"), before);
});


for (const scope of ["global", "workspace"]) test(`one-shot ${scope} saving remembers only applied worker settings without changing scope or writing files`, async (t) => {
  const f = await fixture(t);
  f.router = new PresetRouter(f.path, new Map(), { team: team("custom"), unused: team("unused") });
  f.router.apply(f.router.prepare(), "team", () => {}, { light: "inherit", strong: "off" });
  f.store.setScope(scope === "global" ? "workspace" : "global");
  f.store.stage(scope, ["approval"], "manual");
  f.store.stage(scope, ["effort", "other", "light"], "high");
  const before = f.router.current(), ongoingScope = f.store.scope, c = controls(f, [], [true]);
  await c.ui.saveDefault(scope);
  assert.equal(f.store.scope, ongoingScope);
  assert.deepEqual(f.router.current(), before);
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.selectPrompts, [], "a direct save already has its destination");
  assert.equal(c.confirmPrompts.length, 1);
  assert(c.confirmPrompts[0].text.includes(f.store.paths[scope]), "the exact destination is confirmed");
  assert.match(c.confirmPrompts[0].text, /current applied worker settings.*not a highlighted preset, slider preview or live parent thinking/);
  assert.deepEqual(f.store.get(scope), { version: 1, approval: "manual", preset: "team",
    delegation: { mode: "lead", eagerness: "eager" }, presets: { team: team("custom") },
    effort: { other: { light: "high" }, team: { light: "inherit", standard: null, strong: "off" } } });
  await assert.rejects(readFile(f.store.paths[scope]), { code: "ENOENT" });
  assert(c.notifications.some(({ text }) => text.includes(`${scope} on normal exit`)));
});

for (const source of ["base", "custom"]) test(`saving a ${source} preset named toString treats it as data, not an inherited member`, async (t) => {
  const f = await fixture(t), before = Object.getOwnPropertyDescriptors(Object.prototype.toString);
  if (source === "base") {
    f.config.presets.toString = team();
    await writeFile(f.path, JSON.stringify(f.config));
    f.router = new PresetRouter(f.path);
    f.router.select("toString");
  } else f.router.commit(f.router.prepare({ toString: team("custom") }), "toString");
  const c = controls(f, [], [true]);
  await c.ui.saveDefault("global");
  const saved = f.store.get("global");
  assert.equal(saved.preset, "toString");
  assert(Object.hasOwn(saved.effort, "toString"));
  assert.deepEqual(saved.effort.toString, { light: null, standard: null, strong: null });
  assert.equal(Object.hasOwn(saved.presets ?? {}, "toString"), source === "custom");
  if (source === "custom") assert.deepEqual(saved.presets.toString, team("custom"));
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype.toString), before, "built-in functions remain untouched");
});

test("saving Off defaults preserves every effort and unrelated preference", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["effort", "team"], { light: "high", standard: "inherit", strong: null });
  f.store.stage("global", ["approval"], "judge");
  const effort = f.store.get("global").effort, c = controls(f, [], [true]);
  await c.ui.saveDefault("global");
  assert.equal(f.store.get("global").preset, "off");
  assert.deepEqual(f.store.get("global").effort, effort);
  assert.equal(f.store.get("global").approval, "judge");
  assert.equal(f.store.scope, "session");
  assert.deepEqual(c.published, []);
});

test("direct worker saves require confirmation, UI and workspace trust", async (t) => {
  const f = await fixture(t), c = controls(f, [], [false]);
  await c.ui.saveDefault("global");
  assert.deepEqual(f.store.pending(), []);
  c.ctx.hasUI = false;
  await assert.rejects(c.ui.saveDefault("global"), { code: "SETTINGS_UI_REQUIRED" });
  f.store = new SettingsStore({ agentDir: join(f.root, "agent"), cwd: join(f.root, "work"), projectTrusted: false });
  const denied = controls(f, [], [true]);
  await assert.rejects(denied.ui.saveDefault("workspace"), { code: "PROJECT_NOT_TRUSTED" });
  assert.deepEqual(denied.confirmPrompts, [], "an untrusted destination is never offered for consent");
  assert.deepEqual(f.store.pending(), []);
});

for (const change of ["preset", "effort", "definition", "delegation", "router", "retire", "dispose"]) {
  test(`a worker save cannot stage an obsolete snapshot after ${change} during confirmation`, async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    f.store.stage("global", ["approval"], "manual");
    const pending = f.store.pending(), c = controls(f);
    c.ctx.ui.confirm = async () => {
      if (change === "preset") f.router.select("off");
      else if (change === "effort") f.router.apply(f.router.prepare(), "team", () => {}, { light: "off" });
      else if (change === "definition") f.router.commit(f.router.prepare({ team: team("new") }), "team");
      else if (change === "delegation") f.delegation = { mode: "manual", eagerness: "reserved" };
      else if (change === "router") f.router = new PresetRouter(f.path);
      else if (change === "retire") c.retire();
      else c.ui.dispose();
      return true;
    };
    if (["retire", "dispose"].includes(change)) await assert.rejects(c.ui.saveDefault("global"), { code: "SETTINGS_SESSION_CHANGED" });
    else {
      await c.ui.saveDefault("global");
      assert(c.notifications.some(({ text, level }) => level === "warning" && text.includes("nothing was staged")));
    }
    assert.deepEqual(f.store.pending(), pending);
    await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  });
}

test("worker save confirmation owns one destination, not the shared future save scope", async (t) => {
  const f = await fixture(t), c = controls(f);
  c.ctx.ui.confirm = async () => { f.store.setScope("workspace"); return true; };
  await c.ui.saveDefault("global");
  assert.equal(f.store.scope, "workspace");
  assert.equal(f.store.get("global").preset, "off");
  assert.deepEqual(f.store.get("workspace"), { version: 1 });
});

test("one pending worker save owns its dialog and releases after cancellation", async (t) => {
  const f = await fixture(t), c = controls(f);
  let answer, confirmations = 0;
  c.ctx.ui.confirm = () => { confirmations++; return new Promise((resolve) => { answer = resolve; }); };
  const saving = c.ui.saveDefault("global");
  await c.ui.saveDefault("workspace");
  await c.ui.open();
  assert.equal(confirmations, 1);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(f.store.pending(), []);
  answer(false); await saving;
  c.ctx.ui.confirm = async () => true;
  await c.ui.saveDefault("workspace");
  assert.deepEqual(f.store.get("global"), { version: 1 });
  assert.equal(f.store.get("workspace").preset, "off");
});

function nearLimitPreferences(initial, spareBytes) {
  const document = { ...initial, presets: {} }, max = 256 * 1024;
  const bytes = () => Buffer.byteLength(JSON.stringify(document)) + 1;
  const large = { version: "v".repeat(64), models: {
    light: `fixture/${"m".repeat(248)}`, standard: `fixture/${"m".repeat(248)}`, strong: `fixture/${"m".repeat(248)}`,
  } };
  let index = 0;
  while (bytes() < max) document.presets[`filler${index++}`] = structuredClone(large);
  let excess = bytes() - (max - spareBytes);
  for (const body of Object.values(document.presets).slice(-2)) for (const slot of ["light", "standard", "strong"]) {
    const cut = Math.min(excess, body.models[slot].length - "fixture/m".length);
    body.models[slot] = body.models[slot].slice(0, body.models[slot].length - cut);
    excess -= cut;
  }
  assert.equal(excess, 0);
  assert.equal(bytes(), max - spareBytes);
  return document;
}

test("worker snapshot preflight prevents partially queued saves at the single-file byte cap", async (t) => {
  const f = await fixture(t), document = nearLimitPreferences({ version: 1 }, 30);
  f.store.stage("global", ["presets"], document.presets);
  f.router.select("team");
  const pending = f.store.pending(), c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(f.store.pending(), pending, "not even the smaller first preset patch is queued");
  assert.equal(f.store.get("global").preset, undefined);
});

test("a final-fitting worker snapshot cannot partially stage an overflowing intermediate prefix", async (t) => {
  const f = await fixture(t), document = nearLimitPreferences({ version: 1, preset: "a",
    delegation: { mode: "manual", eagerness: "balanced" }, effort: { team: { light: null, standard: null, strong: null } } }, 5);
  for (const [key, value] of Object.entries(document)) if (key !== "version") f.store.stage("global", [key], value);
  f.router.select("team");
  f.delegation = { mode: "supervisor", eagerness: "eager" };
  const final = { ...document, preset: "team", delegation: f.delegation };
  assert.equal(Buffer.byteLength(JSON.stringify(final)) + 1, 256 * 1024 - 1, "the final document fits by one byte");
  const pending = f.store.pending(), c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(f.store.pending(), pending, "preset must not queue before the larger mode patch fails");
  assert.equal(f.store.get("global").preset, "a");
});

test("toString effort preflight respects the byte cap and leaves built-ins and pending patches untouched", async (t) => {
  const f = await fixture(t), before = Object.getOwnPropertyDescriptors(Object.prototype.toString);
  f.config.presets.toString = team();
  await writeFile(f.path, JSON.stringify(f.config));
  f.router = new PresetRouter(f.path); f.router.select("toString");
  const document = nearLimitPreferences({ version: 1, preset: "a", delegation: { mode: "lead", eagerness: "eager" } }, 30);
  for (const [key, value] of Object.entries(document)) if (key !== "version") f.store.stage("global", [key], value);
  const pending = f.store.pending(), c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(f.store.pending(), pending);
  assert.equal(f.store.get("global").preset, "a");
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype.toString), before);
});

// Native model picker regressions. TUI preset slots reuse /model's native
// ModelSelectorComponent through a controlled ModelRuntime double: the real
// runtime, providers, auth and network are never touched here. The double's
// model list is shared with ctx.modelRegistry.getAll() so a refresh updates
// both, exactly like a host whose catalog was refreshed while open.
initTheme(undefined, false);

const worker = { provider: "fixture", id: "worker", name: "Fixture Worker", api: "fixture", reasoning: false };
const virtual = { provider: "fixture", id: "virtual-worker", name: "Fixture Virtual", api: "pi-virtual", reasoning: false };
const fresh = { provider: "fixture", id: "fresh", name: "Fixture Fresh", api: "fixture",
  reasoning: true, thinkingLevelMap: { high: "high" } };
const tick = async (count = 1) => { for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve)); };

/** A controlled ModelRuntime double. `models` is held by reference so callers
 * decide what the registry and the selector share; `pending` keeps the
 * refresh unsettled so a dispose-driven abort is deterministic. */
function runtimeDouble({ models = [], onRefresh, pending } = {}) {
  const state = { models, refreshCalls: [] };
  return { state, runtime: {
    getAvailableSnapshot: () => [...state.models],
    getModel: (provider, id) => state.models.find((model) => model.provider === provider && model.id === id),
    getError: () => undefined,
    refresh: async (options) => {
      state.refreshCalls.push(options);
      await onRefresh?.(state);
      if (pending) await new Promise(() => {});
      return { aborted: false, errors: new Map() };
    },
  } };
}

/** TUI-mode controls with a scripted native ui.custom, effort selects and a
 * main-model trap that preset editing must never touch. */
function tuiControls(f, options = {}) {
  const registry = { models: [...options.registry ?? [worker, virtual]] };
  const double = options.runtimeDouble ? options.runtimeDouble(registry.models) : runtimeDouble({ models: registry.models });
  const notifications = [], published = [], pickers = [], selectors = [], selectPrompts = [], inputPrompts = [], confirmPrompts = [];
  const answers = [...options.selects ?? []], confirmations = [...options.confirms ?? []], typed = [...options.inputs ?? []];
  let live = true, queuedFactory;
  const mockTui = { mode: options.tuiMode ?? "regular",
    terminal: { rows: options.rows ?? 30, columns: options.columns ?? 100,
      hideCursor() {}, showCursor() {}, write() {} }, requestRender() {} };
  const themeDouble = { fg: (_color, text) => text, bg: (_color, text) => text,
    bold: (text) => text, italic: (text) => text, strikethrough: (text) => text };
  const ctx = { mode: options.mode ?? "tui", hasUI: true, cwd: f.root, ui: {
    select: async (prompt, choices) => { selectPrompts.push({ prompt, choices }); return answers.shift(); },
    input: async (prompt, placeholder) => { inputPrompts.push({ prompt, placeholder }); return typed.shift(); },
    confirm: async (title, text) => { confirmPrompts.push({ title, text }); return confirmations.shift() ?? false; },
    notify: (text, level) => notifications.push({ text, level }),
    custom: (factory, uiOptions) => new Promise((resolve, reject) => {
      const run = () => {
        try {
          const entry = { settled: false, options: uiOptions };
          entry.done = (value) => { options.onPickerDone?.(value); entry.settled = true; resolve(value); };
          entry.component = factory(mockTui, themeDouble, { matches: () => false }, entry.done);
          pickers.push(entry);
        } catch (error) { reject(error); }
      };
      if (options.deferCustom) queuedFactory = run;
      else run();
    }),
  }, modelRegistry: { getAll: () => [...registry.models] },
    // The public session-scope getter: read fresh each time a picker opens,
    // exactly like the SDK runner exposes the current session's scope. A
    // function value models a live getter; undefined models a host without
    // the capability so the helper's own guard can fail closed.
    get scopedModels() {
      // An absent option models an unscoped host ([]); a getter that itself
      // yields undefined models the missing capability and must fail closed
      // in the helper, never default to a fabricated scope.
      return typeof options.scopedModels === "function" ? options.scopedModels() : options.scopedModels ?? [];
    },
    // Preset editing must never touch the main model or its SDK defaults.
    get model() { throw new Error("MAIN_MODEL_TOUCHED"); } };
  const ui = new PreferencesControls({ ctx, store: f.store, router: () => f.router, ready: () => live,
    delegation: () => ({ mode: "lead", eagerness: "eager" }),
    // The UI layer owns no runtime value import: the selector constructor is
    // injected here exactly like the extension binds the acquired host runtime.
    createModelSelector: (pickerOptions) => {
      const selector = createPresetModelSelector({ ...pickerOptions,
        runtime: "modelRuntime" in options ? options.modelRuntime : double.runtime });
      selectors.push(selector);
      return selector;
    },
    ...(options.modelPopover ? { modelPopover: options.modelPopover } : {}),
    modelSelectionAllowed: options.modelSelectionAllowed,
    beforeModelClose: options.beforeModelClose,
    publishDefinition: (candidate, name, definition) => {
      published.push({ candidate, name, definition });
      options.publishDefinition?.(candidate, name, definition);
    } });
  f.after(() => ui.cancelModelSelection());
  return { ui, ctx, tui: mockTui, registry, state: double.state, pickers, selectors, selectPrompts, inputPrompts, confirmPrompts,
    notifications, published, retire: () => { live = false; },
    runQueuedFactory: () => { const run = queuedFactory; queuedFactory = undefined; run?.(); } };
}

const waitForPicker = async (controls, index) => {
  for (let attempt = 0; attempt < 100 && controls.pickers.length <= index; attempt++) await tick();
  assert.ok(controls.pickers.length > index, `native picker ${index} never mounted`);
  return controls.pickers[index];
};
const paint = (entry, width = 100) => entry.component.render(width).map((line) => stripTerminalSequences(line)).join("\n");

test("TUI slots pick through the native selector: titled, searchable, virtual-free, no default-setting path", async (t) => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { inputs: ["custom"], selects: ["inherit", "inherit", "inherit"], confirms: [true] });
  const editing = c.ui.editPreset();
  try {
    const light = await waitForPicker(c, 0);
    assert.match(paint(light), /custom: light model · new Agents only; main unchanged/, "the wrapper carries its context title");
    assert(!paint(light).includes("set as default"), "no save-as-default handler is offered");
    assert.equal(light.component.focused, false, "the wrapper is IME-focusable");
    light.component.focused = true;
    assert.equal(light.component.focused, true);
    light.component.focused = false;
    assert(paint(light).includes("worker"), "the physical fixture model is listed");
    assert(!paint(light).includes("virtual-worker"), "virtual models are never listed");
    // A query that only matches the virtual model finds nothing and cannot settle.
    for (const key of ["v", "i", "r", "t"]) light.component.handleInput(key);
    assert(paint(light).includes("No matching models"), "a virtual-only query matches nothing");
    light.component.handleInput("\x13"); // save-as-default: no such handler here
    light.component.handleInput("\r");
    await tick();
    assert.equal(light.settled, false, "neither an empty selection nor the default path settles the dialog");
    for (const key of ["\x7f", "\x7f", "\x7f", "\x7f"]) light.component.handleInput(key);
    for (const key of ["w", "o", "r", "k"]) light.component.handleInput(key);
    assert(paint(light).includes("worker"), "typing filters to the physical model");
    light.component.handleInput("\r");
    const standard = await waitForPicker(c, 1);
    assert.match(paint(standard), /custom: standard model · new Agents only; main unchanged/);
    standard.component.handleInput("\r"); // no query: the first physical model
    const strong = await waitForPicker(c, 2);
    assert.match(paint(strong), /custom: strong model · new Agents only; main unchanged/);
    strong.component.handleInput("\r");
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(c.selectPrompts.map(({ prompt }) => prompt),
    ["custom: light default effort", "custom: standard default effort", "custom: strong default effort"],
    "the effort dialog still follows every native model choice");
  assert.deepEqual(c.selectPrompts[0].choices, ["Keep inherit", "inherit", "off"],
    "effort policies come from the selected model's metadata");
  assert.equal(c.published.length, 1);
  assert.deepEqual(c.published[0].definition.models, { light: "fixture/worker", standard: "fixture/worker", strong: "fixture/worker" });
  assert.deepEqual(c.published[0].definition.effort, { light: "inherit", standard: "inherit", strong: "inherit" });
  assert.ok(c.state.refreshCalls.length >= 1, "the native selector keeps its automatic catalog refresh");
  assert.deepEqual(f.store.pending(), [], "the editor only returns an audited commit request");
  assert.equal(await readFile(f.path, "utf8"), before, "the catalogue file is never rewritten");
});

test("editing an existing preset preselects its current model in the native list", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { selects: ["inherit"] });
  const editing = c.ui.editPreset("team");
  const light = await waitForPicker(c, 0);
  const text = paint(light);
  assert(text.includes("✓"), "the current model is marked");
  assert(text.indexOf("✓") < text.indexOf("worker"), "the current model leads the list");
  light.component.handleInput("\r"); // no query: Enter takes the preselected model
  const standard = await waitForPicker(c, 1);
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.selectPrompts.map(({ prompt }) => prompt), ["team: light default effort"]);
  assert.deepEqual(c.published, [], "the flow is cancelled at the next slot");
});

test("Escape from the native picker publishes nothing and writes no file", async (t) => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { inputs: ["custom"] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\u001b");
  await editing;
  assert.equal(light.settled, true);
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.selectPrompts, [], "no effort dialog runs after a cancel");
  assert.deepEqual(f.store.pending(), []);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("disposing the controls while the native picker is open settles the dialog and aborts its refresh", async (t) => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { inputs: ["custom"], runtimeDouble: (models) => runtimeDouble({ models: [...models], pending: true }) });
  const editing = c.ui.editPreset();
  await waitForPicker(c, 0);
  await tick(3); // arm the pending refresh through the shared coordinator
  assert.ok(c.state.refreshCalls.length >= 1, "the native refresh was requested with a signal");
  c.ui.dispose();
  await assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  await tick(3);
  assert.equal(c.state.refreshCalls[0].signal.aborted, true, "the native refresh is aborted on dispose");
  assert.deepEqual(c.published, []);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("a late callback from an already-finished picker cannot close the newer dialog", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], selects: ["inherit"] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\r"); // selects the first physical model
  const standard = await waitForPicker(c, 1);
  // The disposed light picker still receives input; its once-guard must not
  // reach the standard dialog's done.
  light.component.handleInput("\r");
  light.component.handleInput("\u001b");
  await tick(3);
  assert.equal(standard.settled, false, "the newer dialog stays open");
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("a factory queued across dispose asserts liveness and never mounts a native picker", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], deferCustom: true });
  const editing = c.ui.editPreset();
  await tick(); // the name dialog resolves, ui.custom queues the factory
  c.ui.dispose();
  c.runQueuedFactory();
  await assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  assert.deepEqual(c.pickers, [], "no native component was created for a retired session");
  assert.deepEqual(c.published, []);
});

test("a model that only the runtime snapshot knows fails fresh registry validation", async (t) => {
  const f = await fixture(t);
  const orphan = { provider: "fixture", id: "orphan", name: "Orphan", api: "fixture", reasoning: false };
  const c = tuiControls(f, { inputs: ["custom"], registry: [worker],
    runtimeDouble: (models) => runtimeDouble({ models: [...models, orphan] }) });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  for (const key of ["o", "r", "p", "h"]) light.component.handleInput(key);
  light.component.handleInput("\r");
  await assert.rejects(editing, { code: "PRESET_MODEL_UNAVAILABLE" });
  assert.deepEqual(c.published, []);
});

test("a catalog refresh that adds a physical model feeds fresh metadata into the effort dialog", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], selects: ["high", "high", "high"], confirms: [true],
    runtimeDouble: (models) => runtimeDouble({ models,
      onRefresh: (state) => { state.models.push(fresh); } }) });
  const editing = c.ui.editPreset();
  try {
    for (const slot of [0, 1, 2]) {
      const picker = await waitForPicker(c, slot);
      await tick(3); // let the automatic refresh publish the new model
      for (const key of ["f", "r", "e", "s", "h"]) picker.component.handleInput(key);
      assert(paint(picker).includes("fresh"), "the refreshed model is selectable");
      picker.component.handleInput("\r");
    }
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(c.selectPrompts[0].choices, ["Keep inherit", "inherit", "off", "minimal", "low", "medium", "high"],
    "effort policies follow the refreshed model's metadata");
  assert.deepEqual(c.published[0].definition.models,
    { light: "fixture/fresh", standard: "fixture/fresh", strong: "fixture/fresh" });
  assert.deepEqual(c.published[0].definition.effort, { light: "high", standard: "high", strong: "high" });
});

test("a host runtime without the selector's four methods fails closed", async (t) => {
  const f = await fixture(t);
  for (const runtime of [undefined, { getAvailableSnapshot: () => [], getModel: () => undefined, getError: () => undefined }]) {
    const c = tuiControls(f, { inputs: ["custom"], modelRuntime: runtime });
    await assert.rejects(c.ui.editPreset(), { code: "MODEL_SELECTOR_UNAVAILABLE" });
    assert.deepEqual(c.published, []);
  }
});

test("rpc mode keeps the supported legacy list and never mounts the native picker", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { mode: "rpc", inputs: ["custom"],
    selects: ["fixture/worker", "inherit", "fixture/worker", "inherit", "fixture/worker", "inherit"], confirms: [true] });
  await c.ui.editPreset();
  assert.deepEqual(c.pickers, [], "no native component in rpc mode");
  assert.deepEqual(c.selectPrompts.map(({ prompt }) => prompt),
    ["custom: light model (new Agents only)", "custom: light default effort",
      "custom: standard model (new Agents only)", "custom: standard default effort",
      "custom: strong model (new Agents only)", "custom: strong default effort"]);
  assert.equal(c.published.length, 1);
});

// Native all/scoped scope: the picker reuses the public session scope, Tab
// toggles between the host's scoped models and the full physical catalogue,
// and neither the scope array nor its metadata is ever rewritten.
const heavy = { provider: "fixture", id: "heavy", name: "Fixture Heavy", api: "fixture",
  reasoning: true, thinkingLevelMap: { high: "high" } };

test("Tab toggles the native scope; scoped and all selections both reach the definition", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { registry: [worker, heavy, virtual], inputs: ["custom"],
    selects: ["inherit", "inherit", "inherit"], confirms: [true],
    scopedModels: [{ model: heavy, thinkingLevel: "high" }] });
  const editing = c.ui.editPreset();
  try {
    const light = await waitForPicker(c, 0);
    const scopedText = paint(light);
    assert(scopedText.includes("Scope: all | scoped"), "the native scope row is shown");
    assert(scopedText.includes("heavy"), "the scoped list starts with the session's scoped model");
    assert(!scopedText.includes("worker"), "the all-list stays out of the scoped view");
    light.component.handleInput("w"); // scoped: no match yet
    assert(paint(light).includes("No matching models"), "the scoped filter only sees scoped models");
    for (const key of ["\x7f"]) light.component.handleInput(key);
    light.component.handleInput("\t"); // all
    const allText = paint(light);
    assert(allText.includes("worker") && allText.includes("heavy"), "Tab shows the full physical list");
    assert(!allText.includes("virtual-worker"), "the all list is virtual-free");
    light.component.handleInput("\t"); // scoped again
    assert(!paint(light).includes("worker"), "Tab returns to the scoped list");
    light.component.handleInput("\r"); // scoped: the heavy model itself
    const standard = await waitForPicker(c, 1);
    assert(!paint(standard).includes("worker"), "each picker starts scoped");
    standard.component.handleInput("\t"); // all
    for (const key of ["w", "o", "r", "k"]) standard.component.handleInput(key);
    standard.component.handleInput("\r");
    const strong = await waitForPicker(c, 2);
    assert(paint(strong).includes("heavy") && !paint(strong).includes("worker"), "the scoped default returns");
    strong.component.handleInput("\r"); // scoped: the heavy model itself
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(c.selectPrompts.map(({ prompt }) => prompt),
    ["custom: light default effort", "custom: standard default effort", "custom: strong default effort"]);
  // Effort stays its own dialog: options follow each selected model's
  // metadata, never the scoped entry's thinkingLevel hint.
  assert.deepEqual(c.selectPrompts[0].choices, ["Keep inherit", "inherit", "off", "minimal", "low", "medium", "high"],
    "the heavy model's own metadata drives its effort options");
  assert(!c.selectPrompts[0].choices.includes("Keep high"), "the scoped thinkingLevel is not pre-applied");
  assert.deepEqual(c.selectPrompts[1].choices, ["Keep inherit", "inherit", "off"],
    "the worker model's metadata drives its effort options");
  assert.equal(c.published.length, 1);
  assert.deepEqual(c.published[0].definition.models,
    { light: "fixture/heavy", standard: "fixture/worker", strong: "fixture/heavy" });
  assert.deepEqual(c.published[0].definition.effort, { light: "inherit", standard: "inherit", strong: "inherit" });
});

test("a scoped virtual entry is filtered once and never leaks through Tab", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { registry: [worker, heavy, virtual], inputs: ["custom"],
    scopedModels: [{ model: virtual, thinkingLevel: "low" }, { model: worker }] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(paint(light).includes("Scope: all | scoped"), "the filtered scope stays present");
  assert(paint(light).includes("worker"), "the physical scoped entry is listed");
  assert(!paint(light).includes("virtual-worker"), "the virtual scoped entry is filtered");
  light.component.handleInput("\t"); // all
  assert(!paint(light).includes("virtual-worker"), "the all list stays virtual-free too");
  light.component.handleInput("\t"); // scoped
  assert(!paint(light).includes("virtual-worker"), "Tab back still leaks nothing");
  light.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("an empty session scope keeps the native picker in all mode with no toggle", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], scopedModels: [] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(!paint(light).includes("Scope:"), "no scope row for an unscoped session");
  assert(paint(light).includes("worker"), "the full physical list shows");
  light.component.handleInput("\t");
  const after = paint(light);
  assert(!after.includes("Scope:"), "Tab creates no scope for an unscoped session");
  assert(after.includes("worker"), "the list is unchanged by the inert toggle");
  light.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("each picker re-reads the session scope getter, so a mid-session change applies next slot", async (t) => {
  const f = await fixture(t);
  const scope = { current: [{ model: heavy, thinkingLevel: "high" }] };
  const c = tuiControls(f, { registry: [worker, heavy], inputs: ["custom"], selects: ["inherit"],
    scopedModels: () => scope.current });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(paint(light).includes("heavy") && !paint(light).includes("worker"), "the first picker reads the initial scope");
  light.component.handleInput("\r"); // scoped: heavy
  scope.current = [{ model: worker }];
  const standard = await waitForPicker(c, 1);
  const standardText = paint(standard);
  assert(standardText.includes("worker"), "the next picker reads the changed scope");
  assert(!standardText.includes("heavy"), "the stale scope does not linger");
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, [], "the flow is cancelled at the second slot");
});

test("the scope array and its model metadata are never rewritten by the picker", async (t) => {
  const f = await fixture(t);
  const scopeEntry = { model: { ...heavy }, thinkingLevel: "high" };
  const scope = [scopeEntry];
  Object.freeze(scopeEntry.model); Object.freeze(scopeEntry); Object.freeze(scope);
  const before = structuredClone(scope);
  const c = tuiControls(f, { registry: [worker, heavy], inputs: ["custom"], selects: ["inherit"],
    scopedModels: scope });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\r"); // scoped: heavy, via a refreshed model copy
  const standard = await waitForPicker(c, 1);
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(scope, before, "the frozen scope is byte-for-byte unchanged");
  assert.deepEqual(c.registry.models[1], heavy, "the registry metadata object is untouched");
  assert.deepEqual(c.published, []);
});

test("a host whose scope getter yields no array fails closed instead of fabricating a scope", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], scopedModels: () => undefined });
  await assert.rejects(c.ui.editPreset(), { code: "MODEL_SELECTOR_UNAVAILABLE" });
  assert.deepEqual(c.pickers, [], "no native component mounted");
  assert.deepEqual(c.published, []);
});

// Single-slot edits use the real router candidate/audit primitives and the real
// native selector. Doubles supply only catalogue IO and the operator's answers.
const lightBase = { ...fresh, id: "light-base", name: "Light Base" };
const standardBase = { ...fresh, id: "standard-base", name: "Standard Base" };
const strongBase = { ...fresh, id: "strong-base", name: "Strong Base" };
const richModels = [lightBase, standardBase, strongBase, fresh, virtual];
async function singleSlotFixture(t, { active = true, overrides = {} } = {}) {
  const f = await fixture(t);
  f.config.presets.team = {
    version: "fixed-and-mapped-v1",
    models: { light: "fixture/light-base", standard: "fixture/standard-base", strong: "fixture/strong-base" },
    effort: { light: "low", standard: "inherit", strong: "high" },
    thinking: { light: { off: "off", max: "low" }, standard: { high: "medium" }, strong: { xhigh: "high" } },
  };
  await writeFile(f.path, JSON.stringify(f.config));
  f.router = new PresetRouter(f.path, new Map([["team", overrides]]));
  if (active) f.router.select("team");
  return f;
}
const chooseNative = (entry, query) => {
  for (const key of query) entry.component.handleInput(key);
  assert(paint(entry).includes(query), `the native filtered list must show ${query}`);
  entry.component.handleInput("\r");
};
const assertOnlySlotChanged = (definition, original, slot, model) => {
  assert.match(definition.version, /^user-\d+$/);
  const expected = structuredClone(original);
  expected.version = definition.version;
  expected.models[slot] = model;
  delete expected.thinking[slot];
  assert.deepEqual(definition, expected, "only the requested model and its compatibility map can change");
};

for (const slot of ["light", "standard", "strong"]) {
  test(`single-slot ${slot} edit preserves other models, fixed defaults, maps and session effort overrides`, async (t) => {
    const overrides = { light: "medium", strong: "off" };
    const f = await singleSlotFixture(t, { overrides }), original = f.router.definition("team");
    const before = await readFile(f.path, "utf8"), revision = f.router.prepare().revision, audits = [];
    f.store.setScope("global");
    const c = tuiControls(f, { registry: richModels,
      publishDefinition: (candidate, name, definition) => {
        assert.deepEqual(f.store.pending(), [], "only the publisher can stage a successfully audited definition");
        const previous = f.router.current();
        const selected = f.router.inspect(candidate).find((item) => item.name === name);
        const next = f.router.apply(candidate, name, (snapshot) => audits.push(snapshot), selected.effort_overrides);
        f.store.stage("global", ["presets", name], definition);
        stageWorkerSelection(f.store, next, previous, false);
      } });
    const editing = c.ui.editModel("team", slot);
    const picker = await waitForPicker(c, 0);
    assert.match(paint(picker), new RegExp(`team: ${slot} model`));
    assert.deepEqual(f.router.definition("team"), original, "a mounted picker is not a publication");
    chooseNative(picker, "fresh");
    await editing;
    assert.equal(c.pickers.length, 1, "one click edits exactly one slot, not the full three-slot workflow");
    assert.deepEqual(c.selectPrompts, [], "fixed default effort is not edited or silently clamped");
    assert.deepEqual(c.inputPrompts, []);
    assert.deepEqual(c.confirmPrompts, [], "explicit native selection for the active preset needs no second approval");
    assert.equal(c.published.length, 1);
    assert.equal(c.published[0].candidate.revision, revision);
    assertOnlySlotChanged(c.published[0].definition, original, slot, "fixture/fresh");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].effort_overrides, overrides);
    assert.deepEqual(f.router.current().effort_overrides, overrides);
    assert.deepEqual(f.router.current().effort_defaults, original.effort);
    assert.deepEqual(f.store.pending(), [{ scope: "global", path: ["presets", "team"], value: c.published[0].definition }]);
    assert.equal(await readFile(f.path, "utf8"), before, "the base catalogue and permission profiles are not rewritten");
    await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  });
}

test("single-slot same-model selection is an exact no-op without confirmation, publication or dirty state", async (t) => {
  const f = await singleSlotFixture(t), original = f.router.definition("team"), revision = f.router.prepare().revision;
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0);
  assert(paint(picker).includes("✓"), "the exact existing model is preselected by the native component");
  picker.component.handleInput("\r");
  await editing;
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.router.definition("team"), original);
  assert.equal(f.router.prepare().revision, revision);
});

test("single-slot native cancellation leaves the definition, defaults and catalogue unchanged", async (t) => {
  const f = await singleSlotFixture(t), original = f.router.definition("team"), before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "standard");
  const picker = await waitForPicker(c, 0);
  picker.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.router.definition("team"), original);
  assert.equal(await readFile(f.path, "utf8"), before);
});

for (const accepted of [false, true]) {
  test(`editing an inactive preset's single slot requires explicit enable consent (${accepted})`, async (t) => {
    const f = await singleSlotFixture(t, { active: false }), original = f.router.definition("team");
    const c = tuiControls(f, { registry: richModels, confirms: [accepted],
      publishDefinition: (candidate, name) => f.router.apply(candidate, name, () => {}) });
    const editing = c.ui.editModel("team", "standard");
    const picker = await waitForPicker(c, 0);
    chooseNative(picker, "fresh");
    await editing;
    assert.equal(c.confirmPrompts.length, 1);
    assert.equal(c.confirmPrompts[0].title, "Change standard model and enable team?");
    assert(c.confirmPrompts[0].text.includes("fixture/fresh"));
    assert.equal(c.published.length, accepted ? 1 : 0);
    assert.deepEqual(f.store.pending(), []);
    assert.equal(f.router.current().name, accepted ? "team" : "off");
    if (accepted) assertOnlySlotChanged(c.published[0].definition, original, "standard", "fixture/fresh");
    else assert.deepEqual(f.router.definition("team"), original);
  });
}

for (const change of ["removed", "virtual"]) {
  test(`single-slot selection fails fresh registry validation when the painted model becomes ${change}`, async (t) => {
    const f = await singleSlotFixture(t), original = f.router.definition("team");
    const c = tuiControls(f, { registry: richModels,
      runtimeDouble: (models) => runtimeDouble({ models: [...models] }) });
    const editing = c.ui.editModel("team", "light");
    const rejected = assert.rejects(editing, { code: "PRESET_MODEL_UNAVAILABLE" });
    const picker = await waitForPicker(c, 0);
    const index = c.registry.models.findIndex((model) => model.id === "fresh");
    c.registry.models.splice(index, 1, ...(change === "virtual" ? [{ ...fresh, api: "pi-virtual" }] : []));
    chooseNative(picker, "fresh"); // The real native snapshot still contains the old physical model.
    await rejected;
    assert.deepEqual(c.published, []);
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(f.store.pending(), []);
    assert.deepEqual(f.router.definition("team"), original);
  });
}

test("single-slot stale routing revision fails closed instead of overwriting a newer selection", async (t) => {
  const f = await singleSlotFixture(t), original = f.router.definition("team");
  const c = tuiControls(f, { registry: richModels, confirms: [true] });
  const editing = c.ui.editModel("team", "strong");
  const rejected = assert.rejects(editing, { code: "STALE_PRESET_SELECTION" });
  const picker = await waitForPicker(c, 0);
  f.router.select("off");
  chooseNative(picker, "fresh");
  await rejected;
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  assert.equal(f.router.current().name, "off");
  assert.deepEqual(f.router.definition("team"), original);
});

test("single-slot session retirement and missing UI cannot publish or stage a model choice", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "light");
  const rejected = assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  const picker = await waitForPicker(c, 0);
  c.retire();
  chooseNative(picker, "fresh");
  await rejected;
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const noUi = tuiControls(f, { registry: richModels });
  noUi.ctx.hasUI = false;
  await assert.rejects(noUi.ui.editModel("team", "light"), { code: "SETTINGS_UI_REQUIRED" });
  assert.deepEqual(noUi.pickers, []);
});

test("single-slot invalid preset/off/slot arguments throw HarnessError before opening any native picker", async (t) => {
  const f = await singleSlotFixture(t);
  for (const [name, slot] of [["missing", "light"], ["off", "light"], ["team", "all"]]) {
    const c = tuiControls(f, { registry: richModels });
    await assert.rejects(c.ui.editModel(name, slot), { name: "HarnessError" });
    assert.deepEqual(c.pickers, []);
    assert.deepEqual(c.selectors, []);
    assert.deepEqual(c.state.refreshCalls, []);
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(c.published, []);
    assert.deepEqual(f.store.pending(), []);
  }
});

const floating = { modelPopover: () => true, tuiMode: "fullscreen", rows: 28, columns: 100 };
const mouseClick = (entry, x, y, width, height) => entry.component.handleMouse({ type: "click", button: "left", x, y,
  screenX: x, screenY: y, width, height, shift: false, ctrl: false, alt: false });
const overlayConfig = (entry) => {
  assert.equal(entry.options?.overlay, true);
  assert.equal(typeof entry.options.overlayOptions, "function", "popover placement is recomputed by the native host");
  return entry.options.overlayOptions();
};
const boundedOverlay = (config, terminal) => {
  for (const key of ["width", "maxHeight"]) assert.equal(typeof config[key], "number");
  assert(config.width > 0 && config.width <= terminal.columns);
  assert(config.maxHeight > 0 && config.maxHeight <= terminal.rows);
  if (config.row !== undefined) {
    assert.equal(typeof config.row, "number");
    assert(config.row >= 0 && config.row < terminal.rows);
  }
  if (config.col !== undefined) {
    assert.equal(typeof config.col, "number");
    assert(config.col >= 0 && config.col < terminal.columns);
  }
};

const measuredOverlay = (entry, terminal) => {
  // No terminal is started: the real compositor computes and clamps geometry
  // against the controlled terminal, rather than a permissive fake doing so.
  const host = new TuiAltScreen(terminal, false, undefined, {});
  host.requestRender = () => {};
  const handle = host.showOverlay(entry.component, overlayConfig(entry));
  try {
    for (let index = 0; index < 2; index++) host.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows);
    const bounds = handle.getBounds();
    assert(bounds, "the native popover is visible to the real compositor");
    assert(bounds.row >= 0 && bounds.col >= 0);
    assert(bounds.row + bounds.height <= terminal.rows);
    assert(bounds.col + bounds.width <= terminal.columns);
    return bounds;
  } finally { handle.hide(); }
};

test("native model popover uses dynamic near-click absolute placement and clamps after resize", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { ...floating, registry: richModels });
  const editing = c.ui.editModel("team", "light", { row: 3, col: 5 });
  const picker = await waitForPicker(c, 0), before = overlayConfig(picker);
  boundedOverlay(before, c.tui.terminal);
  assert.equal(before.row, 4, "the picker opens immediately below the absolute click row");
  assert.equal(before.col, 5);
  const originalBounds = measuredOverlay(picker, c.tui.terminal);
  assert.equal(originalBounds.row, 4);
  assert.equal(originalBounds.col, 5);
  c.tui.terminal.rows = 9; c.tui.terminal.columns = 34;
  const after = overlayConfig(picker);
  boundedOverlay(after, c.tui.terminal);
  assert.notDeepEqual(after, before, "placement is not frozen to the original terminal dimensions");
  measuredOverlay(picker, c.tui.terminal);
  picker.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("native model popover with no click position is centered rather than using stale coordinates", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { ...floating, registry: richModels });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0), config = overlayConfig(picker);
  boundedOverlay(config, c.tui.terminal);
  assert.equal(config.anchor ?? "center", "center");
  assert.equal(config.row, undefined, "the native center anchor owns row placement");
  assert.equal(config.col, undefined, "the native center anchor owns column placement");
  const bounds = measuredOverlay(picker, c.tui.terminal);
  assert.equal(bounds.row, Math.floor((c.tui.terminal.rows - bounds.height) / 2));
  assert.equal(bounds.col, Math.floor((c.tui.terminal.columns - bounds.width) / 2));
  picker.component.handleInput("\u001b");
  await editing;
});

for (const modelPopover of [undefined, () => false]) {
  test(`native model picker stays docked when popover capability is ${modelPopover ? "false" : "absent"}`, async (t) => {
    const f = await singleSlotFixture(t);
    const c = tuiControls(f, { registry: richModels, modelPopover, tuiMode: "regular" });
    const editing = c.ui.editModel("team", "light", { row: 8, col: 20 });
    const picker = await waitForPicker(c, 0);
    assert.notEqual(picker.options?.overlay, true);
    assert.match(paint(picker), /team: light model/);
    picker.component.handleInput("\u001b");
    await editing;
    assert.deepEqual(c.published, []);
  });
}

test("floating native selector retains rounded frame, IME search focus and native Tab scope filtering", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy, virtual], scopedModels: [{ model: worker }] });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0), native = c.selectors[0];
  const lines = picker.component.render(74).map(stripTerminalSequences);
  assert(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
  assert(lines[0].includes("×"));
  assert(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
  assert(lines.every((line) => visibleWidth(line) <= 74));
  picker.component.focused = true;
  assert.equal(native.focused, true);
  assert.equal(native.getSearchInput().focused, true, "IME focus reaches the actual native Input");
  picker.component.focused = false;
  assert.equal(native.getSearchInput().focused, false);
  assert(paint(picker).includes("Scope: all | scoped"));
  assert(!paint(picker).includes("heavy"), "the initial scope is the real session scope");
  picker.component.handleInput("\t");
  assert(paint(picker).includes("heavy"));
  for (const key of "hea") picker.component.handleInput(key);
  assert.equal(native.getSearchInput().getValue(), "hea");
  assert(paint(picker).includes("heavy"));
  assert(!paint(picker).includes("virtual-worker"));
  picker.component.handleInput("\t");
  assert(paint(picker).includes("No matching models"));
  assert.equal(native.getSearchInput().getValue(), "hea", "Tab preserves the native search text");
  picker.component.handleInput("\t");
  assert.match(paint(picker), /→.*heavy/, "the restored selection is painted before Enter can accept it");
  picker.component.handleInput("\r");
  await editing;
  assert.equal(c.published[0].definition.models.light, "fixture/heavy");
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(f.store.pending(), []);
});

for (const input of ["keyboard", "continuation click"]) {
  test(`fully visible wrapped native model labels remain selectable via ${input}`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t); f.router.select("team");
    const long = { ...worker, id: "very-long-physical-model-id-which-exceeds-the-popover-width", name: "Long" };
    const c = tuiControls(f, { ...floating, rows: 24, columns: 34, registry: [worker, long] });
    const editing = c.ui.editModel("team", "light");
    const picker = await waitForPicker(c, 0);
    picker.component.render(34);
    picker.component.handleInput("\u001b[B");
    const lines = picker.component.render(34).map(stripTerminalSequences);
    assert(lines.some((line) => line.includes("[fixture]")));
    assert(picker.component.canSelect(), "a wrapped arrow and complete visible model group are a real selection");
    if (input === "keyboard") picker.component.handleInput("\r");
    else {
      const y = lines.findIndex((line) => line.includes("h-exceeds-the-popover-width"));
      assert(y > 0, lines.join("\n"));
      mouseClick(picker, 3, y, 34, lines.length);
    }
    await editing;
    assert.equal(c.published[0].definition.models.light, `fixture/${long.id}`);
    assert.deepEqual(f.store.pending(), []);
  });
}

test("permission yield is rechecked between slot dialogs and before queued model factories", async (t) => {
  const f = await fixture(t); f.router.select("team");
  let allowed = true;
  const c = tuiControls(f, { ...floating, registry: [worker, heavy], selects: ["inherit"],
    modelSelectionAllowed: () => allowed });
  const editing = c.ui.editPreset("team");
  const light = await waitForPicker(c, 0);
  c.ctx.ui.select = async () => { allowed = false; return "inherit"; };
  light.component.render(74); light.component.handleInput("\r");
  await editing;
  assert.equal(c.pickers.length, 1, "a permission ask between slots prevents the next selector");
  assert.deepEqual(c.published, []);

  const queued = tuiControls(f, { ...floating, registry: [worker, heavy], deferCustom: true,
    modelSelectionAllowed: () => allowed });
  allowed = true;
  const pending = queued.ui.editModel("team", "light");
  await tick(); allowed = false;
  queued.runQueuedFactory();
  await pending;
  assert.deepEqual(queued.selectors, [], "a queued factory cannot mount after permission yield");
  assert.deepEqual(queued.state.refreshCalls, []);
  assert.deepEqual(queued.published, []);
});

test("floating native mouse selection hits actual model/provider text, never padding or stale rows", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
  const editing = c.ui.editModel("team", "standard");
  const picker = await waitForPicker(c, 0), width = 72;
  let lines = picker.component.render(width).map(stripTerminalSequences);
  const oldRow = lines.findIndex((line) => line.includes("heavy") && line.includes("[fixture]"));
  assert(oldRow >= 0, "a real native item, not a fixture-synthesized row, is painted");
  const oldX = lines[oldRow].indexOf("heavy");
  mouseClick(picker, width - 3, oldRow, width, lines.length);
  mouseClick(picker, 0, oldRow, width, lines.length);
  assert.equal(picker.settled, false, "right padding and the frame edge have no model target");
  for (const key of "work") picker.component.handleInput(key);
  lines = picker.component.render(width).map(stripTerminalSequences);
  mouseClick(picker, oldX, oldRow, width, lines.length);
  assert.equal(picker.settled, false, "a formerly-painted heavy row cannot survive a filtered repaint");
  for (const key of ["\x7f", "\x7f", "\x7f", "\x7f"]) picker.component.handleInput(key);
  lines = picker.component.render(width).map(stripTerminalSequences);
  const row = lines.findIndex((line) => line.includes("heavy") && line.includes("[fixture]"));
  const providerX = lines[row].indexOf("[fixture]") + 1;
  mouseClick(picker, providerX, row, width, lines.length);
  await editing;
  assert.equal(c.published.length, 1);
  assert.equal(c.published[0].definition.models.standard, "fixture/heavy");
  assert.equal(c.published[0].definition.models.light, "fixture/worker");
  assert.equal(c.published[0].definition.models.strong, "fixture/worker");
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(f.store.pending(), []);
});

test("floating native × closes only its own model selection without publishing or dirtying settings", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0), width = 68;
  const lines = picker.component.render(width).map(stripTerminalSequences), x = lines[0].indexOf("×");
  assert(x > 0);
  mouseClick(picker, x, 0, width, lines.length);
  await editing;
  assert.equal(picker.settled, true);
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(f.store.pending(), []);
});

test("short native popovers keep the selected arrow, input and scope visible rather than blindly accepting a hidden model", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const many = Array.from({ length: 24 }, (_unused, index) => ({ ...worker,
    id: `slot-${String(index).padStart(2, "0")}`, name: `Slot ${index}` }));
  const c = tuiControls(f, { ...floating, registry: [worker, ...many], scopedModels: [{ model: worker }] });
  const editing = c.ui.editModel("team", "strong");
  const picker = await waitForPicker(c, 0);
  picker.component.handleInput("\t");
  for (const key of "slot") picker.component.handleInput(key);
  for (let index = 0; index < 18; index++) picker.component.handleInput("\u001b[B");
  assert.match(paint(picker), /→.*slot-18/);
  c.tui.terminal.rows = 10; c.tui.terminal.columns = 36;
  const config = overlayConfig(picker), lines = picker.component.render(36).map(stripTerminalSequences);
  assert(lines.length <= config.maxHeight && lines.length <= c.tui.terminal.rows);
  assert(lines.every((line) => visibleWidth(line) <= 36));
  assert(lines.some((line) => /→.*slot-18/.test(line)), "the native selected model survives viewport compression");
  assert(lines.some((line) => line.includes("Scope: all | scoped")));
  assert(lines.some((line) => line.includes("> slot")), "the actual search Input stays visible");
  picker.component.handleInput("\r");
  await editing;
  assert.equal(c.published[0].definition.models.strong, "fixture/slot-18", "Enter accepts exactly the visible arrow row");
  assert.deepEqual(f.store.pending(), []);
});

test("permission yield cancels a queued model request without mounting or refreshing, and keeps the controls reusable", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy], deferCustom: true });
  const editing = c.ui.editModel("team", "light");
  await tick();
  c.ui.cancelModelSelection();
  c.runQueuedFactory();
  await editing;
  assert.deepEqual(c.selectors, [], "queued cancellation must not construct a native selector later");
  assert.deepEqual(c.state.refreshCalls, [], "no hidden native refresh can resurrect after permission yield");
  assert(c.pickers.every((entry) => entry.settled && entry.component.render(80).length === 0));
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const nextIndex = c.pickers.length;
  const next = c.ui.editModel("team", "standard");
  c.runQueuedFactory();
  const picker = await waitForPicker(c, nextIndex);
  assert.equal(c.selectors.length, 1, "cancelModelSelection is not dispose");
  picker.component.handleInput("\u001b");
  await next;
  assert.deepEqual(c.published, []);
});

test("permission yield aborts an opened refresh without dirtying; old callbacks cannot cancel a newer request", async (t) => {
  const f = await fixture(t); f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy],
    runtimeDouble: (models) => runtimeDouble({ models: [...models], pending: true }) });
  const editing = c.ui.editModel("team", "light");
  const old = await waitForPicker(c, 0);
  await tick(3);
  assert(c.state.refreshCalls.length >= 1);
  c.ui.cancelModelSelection();
  await editing;
  assert.equal(c.state.refreshCalls[0].signal.aborted, true);
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const next = c.ui.editModel("team", "standard");
  const current = await waitForPicker(c, 1);
  old.component.handleInput("\u001b"); old.component.handleInput("\r");
  const oldLines = old.component.render(70).map(stripTerminalSequences), closeX = oldLines[0]?.indexOf("×");
  if (closeX > 0) mouseClick(old, closeX, 0, 70, oldLines.length);
  await tick(3);
  assert.equal(current.settled, false, "retained old callbacks own neither the new request nor its done callback");
  chooseNative(current, "heavy");
  await next;
  assert.equal(c.published.length, 1);
  assert.equal(c.published[0].definition.models.standard, "fixture/heavy");
  assert.equal(c.published[0].definition.models.light, "fixture/worker");
  assert.deepEqual(f.store.pending(), []);
});

// These view-only cases never start a terminal or a provider. Keep every
// interaction bounded so a broken selection cannot hang the portable gate.
test("a tiny model popover cannot accept an unseen choice and still cancels", { timeout: 5000 }, async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { ...floating, rows: 4, columns: 10, registry: richModels });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0);
  assert.match(paint(picker, 8), /^Too /);
  picker.component.handleInput("\r");
  await tick();
  assert.equal(picker.settled, false);
  assert.deepEqual(c.published, []);
  c.ui.cancelModelSelection();
  await editing;
  assert.deepEqual(f.store.pending(), []);
});

for (const throwing of [false, true]) {
  test(`model close coordinates other overlays before SDK done, even on cleanup throw (${throwing})`, { timeout: 5000 }, async (t) => {
    const f = await singleSlotFixture(t), order = [];
    const c = tuiControls(f, { ...floating, registry: richModels,
      beforeModelClose: () => { order.push("overlays aside"); if (throwing) throw new Error("cleanup"); },
      onPickerDone: () => order.push("SDK done") });
    const editing = c.ui.editModel("team", "light");
    await waitForPicker(c, 0);
    c.ui.cancelModelSelection();
    await editing;
    assert.deepEqual(order, ["overlays aside", "SDK done"]);
    assert.deepEqual(c.published, []);
    assert.deepEqual(f.store.pending(), []);
  });
}

test("native model-name lookalike rows are not mouse model targets", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); f.router.select("team");
  const forged = { ...worker, id: "forged" }, named = { ...heavy, name: "Fake\n→ ✓ forged [fixture]" };
  const c = tuiControls(f, { ...floating, registry: [worker, named, forged] });
  const editing = c.ui.editModel("team", "light");
  const picker = await waitForPicker(c, 0);
  for (const key of "heavy") picker.component.handleInput(key);
  const lines = picker.component.render(74).map(stripTerminalSequences);
  const y = lines.findIndex((line) => line.includes("forged [fixture]"));
  assert(y >= 0, "a real native name detail contains the adversarial lookalike");
  mouseClick(picker, lines[y].indexOf("forged"), y, 74, lines.length);
  assert.equal(picker.settled, false, "only the native list's actual leading item leaves have targets");
  c.ui.cancelModelSelection();
  await editing;
  assert.deepEqual(c.published, []);
});

test("an unknown native component tree falls back to keyboard-only painted rows", () => {
  const selected = [], lines = ["Scope: all", "> ", "→ ✓ worker [fixture]"];
  const native = { children: [], focused: false, render: () => lines, handleInput() {}, invalidate() {}, dispose() {} };
  const view = new PresetModelPopover({ native, title: "team: light model", theme: { fg: (_color, text) => text, bold: (text) => text },
    height: () => 12, models: () => [worker], select: (model) => selected.push(model), cancel() {} });
  const rows = view.render(60).map(stripTerminalSequences);
  assert.equal(view.canSelect(), true, "painted keyboard selection is retained without private state");
  const y = rows.findIndex((line) => line.includes("worker [fixture]"));
  mouseClick({ component: view }, 8, y, 60, rows.length);
  assert.deepEqual(selected, [], "unknown public trees do not gain parsed mouse targets");
  view.dispose();
});
