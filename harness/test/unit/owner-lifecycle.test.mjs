import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { addToLedger } from "../../dist/core/usage-ledger.js";
import { ownerSessionReplacementGuard } from "../../dist/runtime/owner-lifecycle.js";
import { deferred, ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

const veto = { cancel: true };
function guard(owner, { confirm = async () => { assert.fail("unexpected confirmation"); }, hasUI = true, notify } = {}) {
  const hooks = new Map(), commands = new Map(), notices = [], confirmations = [], entries = [];
  const ctx = { hasUI, ui: {
    confirm: async (...args) => { confirmations.push(args); return confirm(...args); },
    notify: (message, level) => { notices.push({ message, level }); notify?.(message, level); },
  } };
  ownerSessionReplacementGuard(owner)({ on: (name, fn) => hooks.set(name, fn),
    registerCommand: (name, spec) => commands.set(name, spec), appendEntry: (...args) => entries.push(args) });
  return { hooks, ctx, notices, confirmations, entries, attempt: (event = "session_before_switch") => hooks.get(event)({ type: event }, ctx),
    close: () => commands.get("harness-close").handler("", ctx) };
}

for (const event of ["session_before_switch", "session_before_fork"]) {
  test(`${event} auto-closes a never-used Owner, sealing pending submissions before awaiting`, async (t) => {
    const h = await fixture(t), g = guard(h.controller, { hasUI: false });
    const submitted = h.controller.submit("pending", task("must never start"));
    const denied = assert.rejects(submitted, errorCode("OWNER_CLOSED"));
    const change = g.attempt(event);
    assert.throws(() => h.controller.assertOwnerAvailable(), errorCode("OWNER_CLOSED"), "seal is synchronous");
    await denied;
    assert.equal(await change, undefined);
    assert.equal(h.controller.stats().closed, true);
    assert.equal(h.controller.hasAcceptedRuns, false);
    assert.equal(h.ports.length, 0);
    assert.equal(g.confirmations.length, 0);
    assert.equal(g.notices.at(-1).level, "warning");
    assert.match(g.notices.at(-1).message, /Workers are permanently closed in this session/);
    assert.match(g.notices.at(-1).message, /Open another session or restart Pi/);
    assert.throws(() => h.owner.assertHeld());
    await assert.rejects(h.controller.submit("late", task("late")), errorCode("OWNER_CLOSED"));
  });
}

test("tree navigation does not silently close even an empty Owner; explicit close still enables it", async (t) => {
  const h = await fixture(t), g = guard(h.controller);
  assert.deepEqual(await g.attempt("session_before_tree"), veto);
  assert.equal(h.controller.stats().closed, false);
  assert.doesNotThrow(() => h.controller.assertOwnerAvailable());
  assert.match(g.notices.at(-1).message, /in place.*fresh harness Owner/);
  assert.match(g.notices.at(-1).message, /harness-close/);
  await g.close();
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) assert.equal(await g.attempt(event), undefined);
  assert.equal(g.confirmations.length, 0);
});

for (const answer of [false, undefined, "true"]) test(`used Owner refusal (${String(answer)}) does not seal, cancel or drain`, async (t) => {
  const h = await fixture(t), g = guard(h.controller, { confirm: async () => answer });
  const run = await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(g.confirmations.length, 1);
  assert.equal(h.ports[0].stopped, 0);
  assert.equal(h.ports[0].disposed, 0);
  assert.equal(h.controller.view(run.run_id).status, "running");
  assert.doesNotThrow(() => h.controller.assertOwnerAvailable());
  assert.match(g.notices.at(-1).message, /cancelled.*did not stop or close/);
  assert.equal((await h.controller.submit("more", task("still accepted"))).status, "queued");
});

test("confirmation covers work accepted during the dialog and waits for actual drain before allowing", async (t) => {
  const h = await fixture(t), approval = deferred();
  const g = guard(h.controller, { confirm: () => approval.promise });
  const a = await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  const change = g.attempt();
  assert.equal(g.confirmations.length, 1);
  assert.match(g.confirmations[0][1], /including work accepted while this dialog is open/);
  assert.match(g.confirmations[0][1], /permanent even if a later hook/);
  const b = await h.controller.submit("b", task("queued during confirmation"));
  assert.equal(h.ports[0].stopped, 0);
  approval.resolve(true);
  await until(() => h.ports[0].stopped > 0);
  assert.throws(() => h.controller.assertOwnerAvailable(), errorCode("OWNER_CLOSED"));
  let settled = false; void change.then(() => { settled = true; });
  assert.equal(settled, false); assert.equal(h.controller.stats().closed, false);
  assert.doesNotThrow(() => h.owner.assertHeld());
  h.ports[0].finish("stopped", "aborted");
  assert.equal(await change, undefined);
  assert.equal(h.controller.stats().closed, true);
  assert.equal(h.ports[0].disposed, 1);
  assert.equal(h.ports.length, 1, "queued work never got a child");
  for (const run of [a, b]) assert.equal(h.controller.view(run.run_id).status, "cancelled");
});

for (const released of [false, true]) test(`settled work still requires confirmation (released=${released})`, async (t) => {
  const h = await fixture(t), g = guard(h.controller, { confirm: async () => false });
  const run = await h.controller.submit("a", task("complete")); await until(() => h.ports[0]?.streaming);
  h.ports[0].finish(); await ended(h.controller, run);
  if (released) await h.controller.release(run.agent_id);
  assert.equal(h.controller.stats().active, 0);
  assert.equal(h.controller.stats().resident, released ? 0 : 1);
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(g.confirmations.length, 1);
  assert.equal(h.controller.stats().closed, false);
  assert.equal(h.controller.getResult(run.run_id).text, "done");
});

test("used Owner without UI explicitly refuses and stays available", async (t) => {
  const h = await fixture(t), g = guard(h.controller, { hasUI: false });
  await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(g.confirmations.length, 0);
  assert.equal(h.ports[0].stopped, 0);
  assert.doesNotThrow(() => h.controller.assertOwnerAvailable());
  assert.match(g.notices.at(-1).message, /no confirmation UI/);
});

test("overlapping guards during confirmation/drain never share an approval", async (t) => {
  const h = await fixture(t), approval = deferred();
  const g = guard(h.controller, { confirm: () => approval.promise });
  await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  const first = g.attempt();
  assert.deepEqual(await g.attempt("session_before_fork"), veto);
  assert.deepEqual(await g.attempt("session_before_tree"), veto);
  assert.equal(g.confirmations.length, 1); assert.equal(h.ports[0].stopped, 0);
  assert.match(g.notices.at(-1).message, /Another harness session change/);
  approval.resolve(false); assert.deepEqual(await first, veto);
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(g.confirmations.length, 2, "a fresh attempt gets its own confirmation");
});

test("a refusal after an independent explicit close still cancels its original request", async (t) => {
  const h = await fixture(t), approval = deferred();
  const g = guard(h.controller, { confirm: () => approval.promise });
  await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  h.ports[0].autoStop = true;
  const changing = g.attempt();
  await g.close(); approval.resolve(false);
  assert.deepEqual(await changing, veto);
  assert.equal(await g.attempt(), undefined, "a subsequent change sees confirmed closure");
  assert.equal(g.confirmations.length, 1);
});

test("timeout is not closure: replacement stays blocked and the lease remains held", async (t) => {
  const h = await fixture(t), g = guard(h.controller, { confirm: async () => true });
  await h.controller.submit("a", task("noncooperative")); await until(() => h.ports[0]?.streaming);
  const shutdown = h.controller.shutdown.bind(h.controller);
  h.controller.shutdown = () => shutdown(5); // Only the probe's wait bound changes.
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(h.controller.stats().closed, false);
  assert.doesNotThrow(() => h.owner.assertHeld());
  assert.throws(() => h.controller.assertOwnerAvailable(), errorCode("OWNER_CLOSED"));
  assert.match(g.notices.at(-1).message, /NOT closed.*Session change blocked/);
  assert.match(g.notices.at(-1).message, /harness-status.*harness-close/);
  h.ports[0].finish("eventually exits", "aborted");
  await until(() => h.controller.stats().active === 0 && h.controller.stats().finalizing === 0);
  h.controller.shutdown = shutdown;
  await g.close(); assert.equal(h.controller.stats().closed, true);
});

test("uncertain disposal remains a negative result, retaining the reservation and lease", async (t) => {
  const h = await fixture(t, { cleanupUncertainExpected: true }), g = guard(h.controller, { confirm: async () => true });
  const run = await h.controller.submit("a", task("complete")); await until(() => h.ports[0]?.streaming);
  h.ports[0].finish(); await ended(h.controller, run);
  h.ports[0].dispose = async () => ({ shutdownExited: false, errors: ["uncertain fixture"] });
  assert.deepEqual(await g.attempt(), veto);
  assert.equal(h.controller.stats().closed, false);
  assert.equal(h.controller.stats().resident, 1);
  assert.doesNotThrow(() => h.owner.assertHeld());
  assert.match(g.notices.at(-1).message, /cleanup uncertain: true/);
});

for (const fault of ["stats", "confirmation", "shutdown"]) test(`${fault} and notification errors cannot fail open`, async (t) => {
  const h = await fixture(t);
  await h.controller.submit("a", task("active")); await until(() => h.ports[0]?.streaming);
  const g = guard(h.controller, { confirm: async () => {
    if (fault === "confirmation") throw { toString() { throw new Error("BAD_FORMAT"); } };
    return true;
  }, notify: () => { throw new Error("NOTIFY_FAILED"); } });
  const saved = h.controller[fault];
  if (fault !== "confirmation") h.controller[fault] = () => { throw new Error("SYNTHETIC_FAILURE"); };
  try { assert.deepEqual(await g.attempt(), veto); }
  finally { if (fault !== "confirmation") h.controller[fault] = saved; }
  assert.equal(h.ports[0].stopped, 0);
  assert.doesNotThrow(() => h.controller.assertOwnerAvailable());
  assert.match(g.notices.at(-1).message, /session change blocked/);
});

for (const explicit of [false, true]) test(`usage-notice failure does not override confirmed closure (explicit=${explicit})`, async (t) => {
  const h = await fixture(t), g = guard(h.controller, { confirm: async () => true, notify() { throw new Error("NOTICE_FAILED"); } });
  const run = await h.controller.submit("a", task("complete")); await until(() => h.ports[0]?.streaming);
  h.ports[0].finish(); await ended(h.controller, run);
  const usage = addToLedger(undefined, { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.25 }, "p/m");
  h.controller.returnUsage(usage);
  assert.equal(await (explicit ? g.close() : g.attempt()), undefined);
  assert.equal(h.controller.stats().closed, true);
  assert.equal(g.entries.length, 1);
  assert.deepEqual(g.entries[0][1].usage, usage);
  assert.deepEqual(h.controller.stats().unreported_usage, usage, "audit never drains or invents a billed result");
  assert(g.notices.some(({ message }) => message.includes("Child usage reporting failed")));
  assert(!g.notices.some(({ message }) => message.includes("Could not confirm")));
});

test("the guard does not claim to serialize SDK handlers after its closure decision", async (t) => {
  const h = await fixture(t), g = guard(h.controller), later = deferred();
  let reached = false;
  const changing = ExtensionRunner.prototype.emit.call({
    createContext: () => g.ctx,
    extensions: [
      { path: "fixture:harness", handlers: new Map([["session_before_switch", [g.hooks.get("session_before_switch")]]]) },
      { path: "fixture:later-hook", handlers: new Map([["session_before_switch", [() => { reached = true; return later.promise; }]]]) },
    ], isSessionBeforeEvent: () => true, emitError() { assert.fail("unexpected hook failure"); },
  }, { type: "session_before_switch", reason: "resume", targetSessionFile: "/synthetic.jsonl" });
  try {
    await until(() => reached);
    assert.equal(h.controller.stats().closed, true);
    assert.equal(await g.attempt("session_before_fork"), undefined,
      "closed-only admission is not an SDK replacement transaction lock");
    await assert.rejects(h.controller.submit("late", task("late")), errorCode("OWNER_CLOSED"));
  } finally { later.resolve(veto); }
  assert.deepEqual(await changing, veto);
});

test("a later SDK hook veto never reopens the automatically closed Owner", async (t) => {
  const h = await fixture(t), g = guard(h.controller);
  const result = await ExtensionRunner.prototype.emit.call({
    createContext: () => g.ctx,
    extensions: [
      { path: "fixture:harness", handlers: new Map([["session_before_switch", [g.hooks.get("session_before_switch")]]]) },
      { path: "fixture:later-veto", handlers: new Map([["session_before_switch", [() => veto]]]) },
    ], isSessionBeforeEvent: () => true, emitError() { assert.fail("SDK swallowed an unexpected error"); },
  }, { type: "session_before_switch", reason: "resume", sessionFile: "/synthetic.jsonl" });
  assert.deepEqual(result, veto);
  assert.equal(h.controller.stats().closed, true);
  assert.throws(() => h.controller.assertOwnerAvailable(), errorCode("OWNER_CLOSED"));
  assert.match(g.notices.at(-1).message, /permanent.*cancelled or fails/);
  assert.equal(g.notices.at(-1).level, "warning");
  assert.match(g.notices.at(-1).message, /Workers are permanently closed in this session/);
  assert.match(g.notices.at(-1).message, /Open another session or restart Pi/);
});
