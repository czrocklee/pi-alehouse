import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PresetRouter } from "../../dist/orchestration/routing.js";
import { restorePresetRouter } from "../../dist/orchestration/runtime/preset-restoration.js";
import {
  stageWorkerSelection,
  workerDefinitionForScope,
} from "../../dist/orchestration/ui/preferences-controls.js";
import { SettingsStore } from "../../src/shared/settings-store.mjs";
import { controls, fixture, team } from "../support/preferences-fixture.mjs";

const inherited = team("global-worker");
const updated = team("updated-global-worker");

function flushScope(store, scope) {
  assert.deepEqual(store.flush(), [{ scope, path: store.paths[scope] }]);
}

function saveGlobalDefinition(store, definition) {
  store.stage("global", ["presets", "custom"], definition);
  flushScope(store, "global");
}

async function inheritedPreset(t, { selected = true } = {}) {
  const f = await fixture(t);
  if (selected) f.store.stage("global", ["preset"], "custom");
  saveGlobalDefinition(f.store, inherited);
  f.router = restorePresetRouter(f.path, [], f.store.effective());
  return f;
}

function freshSelection(f) {
  const store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });
  return restorePresetRouter(f.path, [], store.effective()).current();
}

function applyInWorkspace(f, overrides) {
  const { store, router } = f;
  store.setScope("workspace");
  const previous = router.current();
  const candidate = router.prepare(undefined, { configuredOnly: overrides === undefined });
  const previousEfforts = router
    .inspect(candidate)
    .find(({ name }) => name === "custom").effort_overrides;
  const selection = router.apply(candidate, "custom", () => {}, overrides);
  stageWorkerSelection(
    store,
    selection,
    previous,
    overrides !== undefined,
    previousEfforts,
    workerDefinitionForScope(router, store, "workspace", selection.name),
  );
  return selection;
}

for (const effortOnly of [true, false])
  test(`workspace ${effortOnly ? "effort-only edit" : "preset selection"} leaves the custom definition inherited from global`, async (t) => {
    const f = await inheritedPreset(t, { selected: effortOnly });
    const selected = applyInWorkspace(f, effortOnly ? { d3: "low" } : undefined);
    assert.equal(selected.models.d3, inherited.slots.d3.model);
    assert.deepEqual(f.store.pending(), [
      effortOnly
        ? { scope: "workspace", path: ["effort", "custom", "d3"], value: "low" }
        : { scope: "workspace", path: ["preset"], value: "custom" },
    ]);
    flushScope(f.store, "workspace");
    saveGlobalDefinition(f.store, updated);

    const fresh = freshSelection(f);
    assert.equal(fresh.name, "custom");
    assert.equal(fresh.models.d3, updated.slots.d3.model);
    assert.deepEqual(fresh.effort_overrides, effortOnly ? { d3: "low" } : {});
  });

test("an explicit workspace worker snapshot pins the inherited custom definition", async (t) => {
  const f = await inheritedPreset(t);
  const c = controls(f, [], [true]);
  await c.ui.saveDefault("workspace");
  assert.deepEqual(
    f.store.pending().find(({ path }) => path[0] === "presets"),
    { scope: "workspace", path: ["presets", "custom"], value: inherited },
  );
  flushScope(f.store, "workspace");
  saveGlobalDefinition(f.store, updated);

  const fresh = freshSelection(f);
  assert.equal(fresh.name, "custom");
  assert.equal(fresh.models.d3, inherited.slots.d3.model);
});

test("an explicit global snapshot does not offer a redundant definition patch", async (t) => {
  const f = await inheritedPreset(t);
  const c = controls(f, [], [true]);
  await c.ui.saveDefault("global");
  assert.equal(c.confirmPrompts.length, 1);
  assert.doesNotMatch(c.confirmPrompts[0].text, /"presets"/);
  assert(!f.store.pending().some(({ path }) => path[0] === "presets"));
  assert.deepEqual(f.store.get("global").presets.custom, inherited);
});

test("an ordinary workspace effort edit saves a restored live pin that differs from global", async (t) => {
  const f = await inheritedPreset(t);
  const pin = team("restored-worker");
  const recorded = new PresetRouter(f.path, new Map(), { custom: pin }).select("custom");
  f.router = restorePresetRouter(f.path, [recorded], f.store.effective());
  const selected = applyInWorkspace(f, { d3: "low" });
  assert.equal(selected.models.d3, pin.slots.d3.model);
  assert.deepEqual(f.store.pending(), [
    { scope: "workspace", path: ["presets", "custom"], value: pin },
    { scope: "workspace", path: ["effort", "custom", "d3"], value: "low" },
  ]);
  flushScope(f.store, "workspace");
  assert.deepEqual(freshSelection(f), selected);
});
