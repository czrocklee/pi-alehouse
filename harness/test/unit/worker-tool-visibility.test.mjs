import assert from "node:assert/strict";
import test from "node:test";
import { cleanupToolNames, managementToolNames, workerToolSelection } from "../../dist/tools/tool-names.js";

test("initial Off removes all worker tools without changing unrelated active tools", () => {
  const active = ["read", ...managementToolNames, "policy-search", "web_search"];
  const original = [...active];
  assert.deepEqual(workerToolSelection(active, false, false), ["read", "policy-search", "web_search"]);
  assert.deepEqual(active, original, "selection must not mutate the SDK's input array");
  assert.deepEqual(workerToolSelection(["read"], false, false), ["read"]);
});

test("Off keeps cleanup and retained-result access after this Owner accepted work", () => {
  const selected = workerToolSelection(["read", ...managementToolNames], false, true);
  assert.deepEqual(selected.filter((name) => managementToolNames.includes(name)), cleanupToolNames);
  for (const name of ["spawn_agent", "resume_agent", "steer_run"]) assert(!selected.includes(name));
  assert(selected.includes("read"));
  assert.deepEqual(workerToolSelection(selected, false, true), selected, "settled/retired workers do not erase result access");
});

test("reconciliation restores preset-owned tools but preserves other tools and their order", () => {
  const active = ["read", "wait_runs", "foreign-tool"];
  assert.deepEqual(workerToolSelection(active, true, false),
    [...active, ...managementToolNames.filter((name) => name !== "wait_runs")]);
  assert.deepEqual(workerToolSelection(active, false, true),
    [...active, ...cleanupToolNames.filter((name) => name !== "wait_runs")]);
});

test("reenabling adds only harness tools and uses the current unrelated selection", () => {
  const before = workerToolSelection(["read", "bash"], false, false);
  const after = workerToolSelection([...before.filter((name) => name !== "bash"), "other-extension"], true, false);
  assert.deepEqual(after, ["read", "other-extension", ...managementToolNames]);
  assert(!after.includes("bash"), "do not restore another extension's previously active tools");
  assert.deepEqual(workerToolSelection(after, true, true), after, "stable selection must not require an SDK update");
});
