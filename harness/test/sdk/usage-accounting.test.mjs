import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { addToLedger, normalizeLedger } from "../../dist/core/usage-ledger.js";
import { boundedOutput } from "../../dist/core/result-text.js";
import { SessionUnavailableError } from "../../dist/core/ports.js";
import { hostUsage } from "../../dist/runtime/tool-usage.js";
import { ended, fixture, task, until } from "../support/controller-fixture.mjs";

const usage = (input, output, cache_read, cache_write, cost) => ({ input, output, cache_read, cache_write, cost });
const components = (input, output, cache_read, cache_write, cost) => ({ input, output, cache_read, cache_write, cost });
// The fixture submits every Run with the same settings, so one model owns the split.
const MODEL = "fixture/controlled";
const ledger = (input, output, cache_read, cache_write, cost, partial = [], byModel) =>
  ({ total: components(input, output, cache_read, cache_write, cost), partial,
    byModel: byModel ?? { [MODEL]: components(input, output, cache_read, cache_write, cost) } });
/** One response's spend, attributed the way a port attributes it. */
const spent = (u, model = MODEL) => addToLedger(undefined, u, model);
const settle = (port, facts) => {
  port.callbacks.output(boundedOutput("done", 1_048_576));
  port.callbacks.turnEnd();
  port.calls.at(-1).done.resolve({ kind: "success", output: boundedOutput("done", 1_048_576), ...facts });
};

const accrue = (...spends) => spends.reduce((l, [u, m]) => addToLedger(l, u, m ?? MODEL), undefined);

test("addToLedger sums what was reported and remembers what was not", () => {
  const two = accrue([usage(1, 2, 3, 4, 0.5)], [usage(10, 20, 30, 40, 1.5)]);
  assert.deepEqual(two, ledger(11, 22, 33, 44, 2));
  // An unpriced Run is not free, but it also does not erase the priced one.
  assert.deepEqual(accrue([usage(1, 2, 3, 4, 0.5)], [usage(10, 20, 30, 40, null)]),
    ledger(11, 22, 33, 44, 0.5, ["cost"]));
  // Unknown token components are marked the same way, each on its own.
  assert.deepEqual(accrue([usage(1, 2, 3, 4, 1)], [usage(null, 20, null, 40, 1)]),
    ledger(1, 22, 3, 44, 2, ["input", "cache_read"]));
  assert.deepEqual(accrue([usage(1, 2, 3, 4, 5)]), ledger(1, 2, 3, 4, 5));
  assert.deepEqual(addToLedger(ledger(1, 2, 3, 4, 5), undefined, MODEL), ledger(1, 2, 3, 4, 5));
  assert.equal(addToLedger(undefined, undefined, MODEL), undefined);
});

/**
 * A worker's model is the one thing the tool-result seam cannot carry, so the
 * ledger carries it instead -- and it must divide the totals exactly, or a
 * reader that bills the parts and drops the whole would change the bill.
 */
test("the per-model split is a partition of the total, never a second copy of it", () => {
  const sol = "openai-codex/gpt-5.6-sol", luna = "openai-codex/gpt-5.6-luna";
  const owed = accrue([usage(10, 1, 100, 0, 0.5), sol], [usage(20, 2, 200, 0, 0.25), luna],
    [usage(30, 3, 300, 0, 1), sol]);
  assert.deepEqual(owed.byModel, {
    [sol]: components(40, 4, 400, 0, 1.5),
    [luna]: components(20, 2, 200, 0, 0.25),
  });
  for (const key of ["input", "output", "cache_read", "cache_write", "cost"]) {
    const summed = Object.values(owed.byModel).reduce((sum, share) => sum + share[key], 0);
    assert.equal(summed, owed.total[key], `${key} splits exactly`);
  }
  // What nobody reported is missing from both halves, so they still agree.
  const withUnknown = accrue([usage(10, null, 0, 0, null), sol], [usage(5, 5, 0, 0, 2), luna]);
  assert.deepEqual(withUnknown.total, components(15, 5, 0, 0, 2));
  assert.deepEqual(withUnknown.byModel[sol], components(10, 0, 0, 0, 0));
  assert.deepEqual(withUnknown.partial, ["output", "cost"]);
});

test("a tool result carries the split, so a worker is billed to the model that ran it", () => {
  const sol = "openai-codex/gpt-5.6-sol", astra = "openai-codex/fixture-strong-model";
  const owed = accrue([usage(10, 1, 100, 0, 0.25), sol], [usage(20, 2, 200, 0, 1), astra]);
  assert.deepEqual(hostUsage(owed).harnessModels, [
    // Biggest bill first: the answer to "where did the money go" leads.
    { model: astra, input: 20, output: 2, cacheRead: 200, cacheWrite: 0, cost: 1 },
    { model: sol, input: 10, output: 1, cacheRead: 100, cacheWrite: 0, cost: 0.25 },
  ]);
  // A second drain onto the same result merges into the rows already there,
  // so they keep adding up to the flat totals beside them.
  const again = hostUsage(accrue([usage(5, 0, 0, 0, 0.75), sol]), hostUsage(owed));
  assert.deepEqual(again.harnessModels, [
    // Equal costs retain the deterministic model-id ordering.
    { model: astra, input: 20, output: 2, cacheRead: 200, cacheWrite: 0, cost: 1 },
    { model: sol, input: 15, output: 1, cacheRead: 100, cacheWrite: 0, cost: 1 },
  ]);
  assert.equal(again.harnessModels.reduce((sum, row) => sum + row.cost, 0), again.cost.total);
  assert.equal(again.harnessModels.reduce((sum, row) => sum + row.input, 0), again.input);
  // A tool's own usage is not a worker's: it stays out of the split and is
  // simply the part of the totals no model claimed.
  const overTool = hostUsage(accrue([usage(5, 0, 0, 0, 0.5), sol]),
    { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } });
  assert.deepEqual(overTool.harnessModels, [{ model: sol, input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 }]);
  assert.equal(overTool.input, 12);
});

test("unknown model spend is marked as a floor while genuinely free rows survive", () => {
  const owed = accrue([usage(20, 10, 0, 0, 2), "p/m"], [usage(null, null, null, null, null), "compaction/p/m"]);
  const before = structuredClone(owed), projected = hostUsage(owed);
  const all = ["input", "output", "cache_read", "cache_write", "cost"];
  assert.deepEqual(projected.harnessPartial, all);
  assert.equal(projected.cost.total, 2); assert.equal(projected.harnessModels.reduce((sum, row) => sum + row.cost, 0), 2);
  assert.equal(projected.harnessModels.find((row) => row.model === "compaction/p/m").cost, 0);
  for (const row of projected.harnessModels) assert.deepEqual(row.partial, all, "global source uncertainty is conservatively repeated, not localized");
  projected.harnessPartial.pop(); projected.harnessModels[0].partial.pop();
  assert.deepEqual(projected.harnessModels[1].partial, all, "projection rows do not share mutable flag arrays");
  assert.deepEqual(owed, before, "projection never mutates the ledger marker");
  const free = hostUsage(accrue([usage(0, 0, 0, 0, 0), "free/model"]));
  assert.equal(free.harnessPartial, undefined);
  assert.deepEqual(free.harnessModels, [{ model: "free/model", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }]);
});

test("host partial metadata survives repeated handoffs and conservatively qualifies every row", () => {
  const first = hostUsage(accrue([usage(10, 0, 0, 0, null), "p/m"])), before = structuredClone(first);
  const next = hostUsage(accrue([usage(1, null, 0, 0, 1), "q/m"]), first);
  assert.deepEqual(first, before);
  assert.deepEqual(next.harnessPartial, ["output", "cost"]);
  for (const row of next.harnessModels) assert.deepEqual(row.partial, next.harnessPartial);
  const complete = hostUsage(accrue([usage(0, 0, 0, 0, 2), "p/m"]), next);
  assert.equal(complete.cost.total, 3); assert.deepEqual(complete.harnessPartial, ["output", "cost"]);
  for (const row of complete.harnessModels) assert.deepEqual(row.partial, complete.harnessPartial);
  const { harnessPartial: _removed, ...rowOnly } = next;
  assert.deepEqual(hostUsage(accrue([usage(0, 0, 0, 0, 0), "free/m"]), rowOnly).harnessPartial, ["output", "cost"]);
  const batched = hostUsage(accrue([usage(10, 0, 0, 0, null), "p/m"], [usage(1, null, 0, 0, 1), "q/m"]));
  assert.deepEqual(batched, next, "drain batching does not change either amounts or conservative markers");
});

test("foreign attribution cannot poison child totals or claim more than the prior usage", () => {
  const child = ledger(10, 1, 0, 0, 0.5);
  const row = { model: "foreign/model", input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.25 };
  for (const harnessModels of [null, {}, "invalid", [null], [42], [{ ...row, model: "" }],
    [{ ...row, input: 6 }], [{ ...row, output: "2" }], [{ ...row, cost: Infinity }],
    [{ ...row, cost: -1 }], [row, row]]) {
    const prior = { ...hostUsage(ledger(5, 2, 0, 0, 0.25)), harnessModels, harnessPartial: ["cache_read"] };
    const before = structuredClone(prior);
    const merged = hostUsage(child, prior);
    assert.equal(merged.input, 15); assert.equal(merged.output, 3);
    assert.equal(merged.cost.total, 0.75, "rejecting attribution must not discard the tool's actual spend");
    assert.deepEqual(merged.harnessModels, [{ model: MODEL, input: 10, output: 1, cacheRead: 0,
      cacheWrite: 0, cost: 0.5, partial: ["cache_read"] }]);
    assert.deepEqual(merged.harnessPartial, ["cache_read"]);
    assert.deepEqual(prior, before);
  }
});

test("rejecting a malformed share does not erase its conservative partial markers", () => {
  const prior = { ...hostUsage(ledger(5, 2, 0, 0, 0.25)),
    harnessModels: [{ model: "foreign/model", input: "invalid", partial: ["cost", "unknown-field"] }] };
  const merged = hostUsage(ledger(10, 1, 0, 0, 0.5), prior);
  assert.equal(merged.cost.total, 0.75);
  assert.deepEqual(merged.harnessPartial, ["cost"]);
  assert.deepEqual(merged.harnessModels[0].partial, ["cost"]);
});

test("SDK tool-result persistence preserves harness unknown-spend metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-partial-host-")); t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "assistant", api: "fixture", provider: "p", model: "m", content: [{ type: "text", text: "fixture" }],
    stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() });
  const projected = hostUsage(accrue([usage(null, null, null, null, null), "compaction/p/m"]));
  manager.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "wait_runs", content: [{ type: "text", text: "done" }],
    isError: false, usage: projected, timestamp: Date.now() });
  const saved = (await readFile(manager.getSessionFile(), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line))
    .find((entry) => entry.type === "message" && entry.message.role === "toolResult").message.usage;
  assert.deepEqual(saved, projected); assert.equal(saved.harnessModels[0].cost, 0);
  assert.deepEqual(saved.harnessModels[0].partial, ["input", "output", "cache_read", "cache_write", "cost"]);
});

test("a settled Run's spend is accrued once and handed over exactly once", async (t) => {
  const { controller: c, ports } = await fixture(t);
  assert.equal(c.drainUsage(), undefined, "nothing is owed before any Run settles");

  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  settle(ports[0], { usage: spent(usage(100, 20, 500, 10, 0.004)) });
  await ended(c, a);

  assert.deepEqual(c.drainUsage(), ledger(100, 20, 500, 10, 0.004));
  // Draining is a handover, not a read: the host now owns that spend.
  assert.equal(c.drainUsage(), undefined, "a drained total is never replayed");
});

test("spend from several Runs accumulates until the host takes it", async (t) => {
  const { controller: c, ports } = await fixture(t);
  for (const [i, spend] of [usage(100, 20, 0, 10, 0.004), usage(7, 3, 0, 1, 0.001)].entries()) {
    const run = await c.submit(`r${i}`, task(`r${i}`));
    // Each submission is its own Agent, so each gets its own port.
    await until(() => ports[i]?.streaming);
    settle(ports[i], { usage: spent(spend) });
    await ended(c, run);
  }
  assert.deepEqual(c.drainUsage(), ledger(107, 23, 0, 11, 0.005));
});

test("a failed Run still cost money, so its spend is accrued too", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  ports[0].callbacks.turnEnd();
  ports[0].calls.at(-1).done.resolve({ kind: "error", error: "boom",
    output: boundedOutput("", 1_048_576), usage: spent(usage(50, 5, 0, 0, 0.002)) });
  const result = await ended(c, a);
  assert.equal(result.snapshots[0].status, "failed");
  assert.deepEqual(c.drainUsage(), ledger(50, 5, 0, 0, 0.002), "a failure is billed like any other call");
});

test("a Run whose result nobody fetches is still accounted for", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  settle(ports[0], { usage: spent(usage(9, 1, 0, 0, 0.0007)) });
  await ended(c, a);
  // No getResult call anywhere in this test — accrual happens at settle, not at fetch.
  assert.deepEqual(c.drainUsage(), ledger(9, 1, 0, 0, 0.0007));
});

test("a Run that reported no usage at all owes nothing", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  settle(ports[0], {});
  await ended(c, a);
  assert.equal(c.drainUsage(), undefined);
});

test("an unpriced Run costs the priced ones nothing", async (t) => {
  const { controller: c, ports } = await fixture(t);
  for (const [i, spend] of [usage(10, 1, 0, 0, 0.001), usage(20, 2, 0, 0, null)].entries()) {
    const run = await c.submit(`r${i}`, task("r"));
    await until(() => ports[i]?.streaming);
    settle(ports[i], { usage: spent(spend) });
    await ended(c, run);
  }
  const owed = c.drainUsage();
  assert.equal(owed.total.cost, 0.001, "money that WAS reported survives a sibling that reported none");
  assert.deepEqual(owed.partial, ["cost"], "and the total is known to be a floor");
  assert.equal(owed.total.input, 30, "tokens both Runs reported are counted as before");
  assert.equal(hostUsage(owed).cost.total, 0.001, "which is what reaches the host");
});

/**
 * The bug this whole shape exists to prevent: with a contagious unknown, the
 * bill depended on where tool results happened to fall between settlements.
 */
test("batched and separate drains bill the same, whatever went unreported", async (t) => {
  const spends = [usage(100, 10, 0, 0, 1.25), usage(20, 2, 0, 0, null), usage(30, 3, 0, 0, 0.75)];
  const drainAfterEach = async (batched) => {
    const { controller: c, ports } = await fixture(t);
    let host;
    for (const [i, spend] of spends.entries()) {
      const run = await c.submit(`r${i}`, task("r"));
      await until(() => ports[i]?.streaming);
      settle(ports[i], { usage: spent(spend) });
      await ended(c, run);
      if (!batched) { const owed = c.drainUsage(); if (owed) host = hostUsage(owed, host); }
    }
    if (batched) host = hostUsage(c.drainUsage());
    return host;
  };
  const batched = await drainAfterEach(true);
  const separate = await drainAfterEach(false);
  assert.equal(batched.cost.total, 2, "every reported dollar is billed exactly once");
  assert.equal(batched.cost.total, separate.cost.total, "and drain timing cannot change the bill");
  assert.equal(batched.input, separate.input);
  assert.equal(batched.totalTokens, separate.totalTokens);
});

/** The flat totals Pi reads, with the attribution that rides beside them
 * lifted off: the split has its own tests, and Pi never looks at it. */
const flat = ({ harnessModels: _split, harnessPartial: _partial, ...totals }) => totals;

/**
 * Adding a component that is not a number silently turned the total into NaN
 * while `partial` reported everything as known -- a ledger that looked exact
 * and printed "NaN". Anything unusable is simply unknown, like null.
 */
test("a component that is not a usable number is unknown, never NaN", () => {
  const cases = [
    [{ input: 10, output: 5, cache_read: 0, cache_write: 0 }, ["cost"]],
    [{ input: 10, output: 5, cache_read: 0, cache_write: 0, cost: Number.NaN }, ["cost"]],
    [{ input: 10, output: 5, cache_read: 0, cache_write: 0, cost: -1 }, ["cost"]],
    [{ input: 10, output: 5, cache_read: 0, cache_write: 0, cost: "1.25" }, ["cost"]],
    [{ input: 10, output: 5, cache_read: 0, cache_write: 0, cost: Infinity }, ["cost"]],
  ];
  for (const [bad, partial] of cases) {
    const owed = addToLedger(undefined, bad, MODEL);
    assert.deepEqual(owed.partial, partial, JSON.stringify(bad));
    for (const key of ["input", "output", "cache_read", "cache_write", "cost"]) {
      assert.ok(Number.isFinite(owed.total[key]), `${key} is not a number for ${JSON.stringify(bad)}`);
      assert.equal(owed.total[key], Object.values(owed.byModel).reduce((sum, share) => sum + share[key], 0));
    }
    assert.equal(owed.total.input, 10, "what WAS reported still counts");
  }
});

test("a ledger from a port is trusted only as far as it is well formed", () => {
  // An array is an object, and would have become a model row of zeros.
  assert.equal(normalizeLedger({ byModel: { m: [] } }), undefined);
  assert.equal(normalizeLedger({ byModel: { "": { input: 1 } } }), undefined);
  assert.equal(normalizeLedger({ byModel: { m: null } }), undefined);
  assert.equal(normalizeLedger({ byModel: {} }), undefined);
  const owed = normalizeLedger({ byModel: { "p/m": { input: 5, output: "x", cache_read: 1, cache_write: 0, cost: 2 } } });
  assert.equal(owed.total.input, 5);
  assert.deepEqual(owed.partial, ["output"]);
});

/**
 * Pi's own tool usage is always complete, but this merges onto whatever the
 * handlers before us left on the event, and a throw here is swallowed whole.
 */
test("a prior usage that is missing pieces is merged, not thrown over", () => {
  const owed = spent(usage(10, 1, 0, 0, 0.5));
  const merged = hostUsage(owed, { input: 50, output: 10 });
  assert.equal(merged.input, 60);
  assert.equal(merged.cost.total, 0.5, "the child's own spend still reaches the host");
  assert.ok(Number.isFinite(merged.totalTokens));
  assert.equal(hostUsage(owed, {}).cost.total, 0.5);
});

/**
 * The throw path returns no facts, so a session that went bad after streaming
 * priced responses used to bill nothing at all -- contrary to the rule that a
 * failed Run still cost money.
 */
test("a session that fails after it has already billed still hands that spend over", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  const failure = new SessionUnavailableError("sdk_error", new Error("socket hung up"));
  failure.usage = spent(usage(400, 40, 0, 0, 1.75));
  ports[0].calls.at(-1).done.reject(failure);
  const result = await ended(c, a);
  assert.equal(result.snapshots[0].status, "failed");
  assert.deepEqual(c.drainUsage(), ledger(400, 40, 0, 0, 1.75));
});

/** The drain is destructive, so a handover that throws has to be given back. */
test("spend a caller could not deliver goes back on the books", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  settle(ports[0], { usage: spent(usage(10, 1, 0, 0, 0.5)) });
  await ended(c, a);
  const owed = c.drainUsage();
  assert.equal(c.drainUsage(), undefined, "drained once");
  c.returnUsage(owed);
  assert.deepEqual(c.drainUsage(), ledger(10, 1, 0, 0, 0.5), "and owed again after a failed handover");
  // Returning nothing is not an error, and returning twice does not double bill.
  c.returnUsage(undefined);
  assert.equal(c.drainUsage(), undefined);
});

test("hostUsage reports child spend to the host without inventing numbers", () => {
  const fresh = hostUsage(ledger(100, 20, 500, 10, 0.004));
  assert.deepEqual(flat(fresh), { input: 100, output: 20, cacheRead: 500, cacheWrite: 10, totalTokens: 630,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 } });
  // Pi reads cost.total; a per-component split nobody measured stays zero.
  assert.equal(fresh.cost.input + fresh.cost.output + fresh.cost.cacheRead + fresh.cost.cacheWrite, 0);
});

test("hostUsage adds to a tool's own usage instead of replacing it", () => {
  const prior = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
  const merged = hostUsage(ledger(100, 20, 500, 10, 0.5), prior);
  assert.deepEqual(flat(merged), { input: 101, output: 22, cacheRead: 503, cacheWrite: 14, totalTokens: 640,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1.5 } });
});

test("hostUsage carries the reported floor and simply omits what nobody reported", () => {
  const owed = addToLedger(undefined, usage(100, null, null, null, null), MODEL);
  assert.deepEqual(owed.partial, ["output", "cache_read", "cache_write", "cost"]);
  assert.deepEqual(flat(hostUsage(owed)), { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
});
