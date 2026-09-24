import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const json = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("published routing defaults are neutral and regression routes are explicitly synthetic", () => {
  assert.deepEqual(json("resources/harness-presets.json"), { version: 2, defaultPreset: "off", presets: {} });
  const fixture = json("harness/test/support/presets.json");
  assert.match(fixture.defaultPreset, /^fixture-/);
  for (const [name, preset] of Object.entries(fixture.presets)) {
    assert.match(name, /^fixture-/);
    assert.match(preset.version, /^fixture-/);
    for (const model of Object.values(preset.models)) assert.match(model, /^[^/]+\/fixture-/);
  }
});

test("static policy fixtures grant no personal workspace or deployment-store scopes", () => {
  for (const path of ["resources/permissions.json", "test/policy/permissions.json"]) {
    const policy = json(path);
    assert.deepEqual(policy.piInfrastructureReadPaths, [], `${path}: SDK scopes must be supplied by isolated fixtures`);
    for (const family of ["external_directory", "external_directory_read", "external_directory_write"]) {
      for (const [pattern, value] of Object.entries(policy.permission[family] ?? {})) {
        if ((typeof value === "string" ? value : value.action) !== "allow") continue;
        assert(pattern === "/tmp" || pattern.startsWith("/tmp/") || pattern.startsWith("/proc/") || pattern.includes("fixture-"),
          `${path}: unexpected non-synthetic external scope ${pattern}`);
      }
    }
  }
});
