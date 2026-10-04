import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultDelegation, delegationGuideline, delegationLabel, delegationModes, delegationStatus, eagernessLevels,
  parseDelegation, restoreDelegation, usesEagerness } from "../../dist/delegation.js";
import { PresetRouter } from "../../dist/routing.js";
import { writePresetConfig } from "../support/preset-config.mjs";

const preset = (name, effort_overrides = {}) => ({ name, version: "v1", digest: "0", models: {},
  effort: {}, effort_defaults: {}, effort_overrides });
const off = { name: "off", version: "off-v1", digest: "f" };

test("each autonomous guideline is one division sentence plus one eagerness sentence; Manual stands alone", () => {
  for (const mode of delegationModes) for (const eagerness of eagernessLevels) {
    const line = delegationGuideline({ mode, eagerness });
    if (!usesEagerness(mode)) {
      assert.equal(line, delegationGuideline({ mode, eagerness: "balanced" }), "Manual ignores eagerness");
      assert.match(line, /only when the user asks/);
      continue;
    }
    // The same eagerness sentence ends every mode; the same mode sentence starts every eagerness.
    const tail = delegationGuideline({ mode: "co-worker", eagerness }).replace(/^[^.]+\. /, "");
    assert(line.endsWith(tail), `${mode}/${eagerness}`);
  }
  assert.deepEqual(defaultDelegation, { mode: "co-worker", eagerness: "balanced" });
});

test("status is versionless `mode/preset`, adds eagerness only off its default, and Off hides the mode", () => {
  assert.equal(delegationStatus(preset("gpt-medium"), defaultDelegation), "delegation: co-worker/gpt-medium");
  const selected = { ...preset("glm-mix"), version: "2026-10-v7" };
  assert.equal(delegationStatus(selected, { mode: "lead", eagerness: "balanced" }), "delegation: lead/glm-mix");
  assert.equal(selected.version, "2026-10-v7", "hiding a version must not mutate the selected preset");
  assert.equal(delegationStatus(preset("gpt-medium", { d1: "high" }), { mode: "lead", eagerness: "eager" }),
    "delegation: lead·eager/gpt-medium*");
  assert.equal(delegationStatus(off, { mode: "supervisor", eagerness: "eager" }), "delegation: off");
  assert.equal(delegationLabel({ mode: "manual", eagerness: "eager" }), "manual", "eagerness is meaningless in Manual");
});

test("restore takes the branch's last saved setting, else the configured default; bad entries fail closed", () => {
  assert.deepEqual(restoreDelegation([], { mode: "lead", eagerness: "reserved" }), { mode: "lead", eagerness: "reserved" });
  assert.deepEqual(restoreDelegation([{ mode: "manual", eagerness: "balanced", selected_at: 1 },
    { mode: "supervisor", eagerness: "eager", selected_at: 2 }], defaultDelegation), { mode: "supervisor", eagerness: "eager" });
  for (const bad of [null, "lead", { mode: "boss", eagerness: "eager" }, { mode: "lead" }]) {
    assert.throws(() => restoreDelegation([bad], defaultDelegation), /INVALID_SAVED_DELEGATION/, JSON.stringify(bad));
  }
});

test("command arguments take a mode, an eagerness, or one of each, in any order", () => {
  assert.deepEqual(parseDelegation("lead", defaultDelegation), { mode: "lead", eagerness: "balanced" });
  assert.deepEqual(parseDelegation(" Eager  supervisor ", defaultDelegation), { mode: "supervisor", eagerness: "eager" });
  assert.deepEqual(parseDelegation("reserved", { mode: "lead", eagerness: "eager" }), { mode: "lead", eagerness: "reserved" });
  for (const bad of ["", "boss", "lead manual", "eager reserved", "lead eager extra"]) {
    assert.throws(() => parseDelegation(bad, defaultDelegation), /INVALID_DELEGATION/, bad);
  }
});

test("the preset file may set the fresh-session default mode and eagerness; invalid values fail the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-delegation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "harness-presets.json");
  const base = { version: 3, defaultPreset: "off", presets: {} };
  await writePresetConfig(path, base);
  assert.deepEqual(new PresetRouter(path).defaultDelegation, defaultDelegation, "omitted fields keep the built-in default");
  await writePresetConfig(path, { ...base, defaultMode: "supervisor", defaultEagerness: "reserved" });
  assert.deepEqual(new PresetRouter(path).defaultDelegation, { mode: "supervisor", eagerness: "reserved" });
  for (const bad of [{ defaultMode: "boss" }, { defaultEagerness: "very" }, { defaultMode: 1 }]) {
    await writePresetConfig(path, { ...base, ...bad });
    assert.throws(() => new PresetRouter(path), /INVALID_PRESET_CONFIG/, JSON.stringify(bad));
  }
});
