import test from "node:test";
import assert from "node:assert/strict";
import {
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  PINNED_INDICATORS,
} from "../../src/shared/overlay-protocol.mjs";
import { POPOVER, popoverRule, popoverSide } from "../../src/shared/popover-frame.mjs";
import { usageTotals, readUsageAttribution } from "../../src/shared/usage-attribution.mjs";

const spend = (cost = 0) => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost });
const attributed = (overrides = {}) => ({
  ...spend(),
  cost: { total: 0.5 },
  alehouseModels: [{ ...spend(0.5), model: "provider/model" }],
  ...overrides,
});

test("overlay protocol stays stable across independently bundled consumers", () => {
  assert.equal(HIDE_TRANSIENT_OVERLAYS_EVENT, "pi-alehouse:hide-transient-overlays");
});

test("footer pins routing, approval and health in fixed left-to-right order", () => {
  assert.deepEqual(PINNED_INDICATORS, ["alehouse-preset", "approval", "session-health"]);
  assert(Object.isFrozen(PINNED_INDICATORS));
});

test("shared popover frame preserves existing glyphs and theme roles", () => {
  const theme = { fg: (role, text) => `${role}:${text}` };
  assert.equal(popoverRule(theme, 5, "top"), "borderAccent:╭───╮");
  assert.equal(popoverRule(theme, 2, "bottom"), "borderAccent:╰╯");
  assert.equal(popoverRule(theme, 4, "divider"), "borderMuted:├──┤");
  assert.equal(popoverRule(theme, 0, "top"), "");
  assert.equal(popoverRule(theme, 1, "top"), "borderAccent:─");
  assert.equal(popoverRule(theme, 1, "divider"), "borderMuted:─");
  assert.equal(popoverSide(theme), `borderMuted:${POPOVER.v}`);
});

test("attribution reader rejects malformed or overclaimed session-file shares", () => {
  assert.deepEqual(usageTotals(attributed()), spend(0.5));
  assert.deepEqual(readUsageAttribution(attributed()), attributed().alehouseModels);
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    attributed({ alehouseModels: [] }),
    attributed({ alehouseModels: [null] }),
    attributed({ alehouseModels: {} }),
    attributed({ alehouseModels: [{ ...spend(0.5), model: "provider/model", input: 2 }] }),
    attributed({ alehouseModels: [{ ...spend(0.5), model: "provider/model", cacheRead: 4 }] }),
    attributed({
      alehouseModels: [...attributed().alehouseModels, ...attributed().alehouseModels],
    }),
    attributed({ alehouseModels: [{ ...spend(0.6), model: "provider/model" }] }),
    attributed({ alehouseModels: [{ ...spend(0.5), model: "" }] }),
    attributed({ alehouseModels: [{ ...spend(0.5), model: "provider/model", input: -1 }] }),
    attributed({ alehouseModels: [{ ...spend(Infinity), model: "provider/model" }] }),
    attributed({ alehouseModels: [{ ...spend(0.5), model: "provider/model", output: "2" }] }),
  ])
    assert.deepEqual(readUsageAttribution(invalid), []);
});

test("attribution preserves partial shares, floating tolerance and foreign model labels", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const parts = [
    { ...zero, cost: 0.1, model: "compaction/provider/model" },
    { ...zero, cost: 0.2, model: "opaque" },
  ];
  assert.deepEqual(
    readUsageAttribution({ ...zero, cost: { total: 0.3 }, alehouseModels: parts }),
    parts,
  );
  // Attribution need not exhaust flat totals; the remainder stays tool spend.
  assert.deepEqual(
    readUsageAttribution({ ...zero, cost: { total: 0.9 }, alehouseModels: parts }),
    parts,
  );
  assert.deepEqual(usageTotals({ input: Infinity, output: 2, cost: { total: NaN } }), {
    ...zero,
    output: 2,
  });
  assert.deepEqual(usageTotals(null), zero);
  assert.deepEqual(usageTotals(undefined), zero);
});
