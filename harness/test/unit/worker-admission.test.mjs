import assert from "node:assert/strict";
import test from "node:test";
import { softBudgetMessage } from "../../dist/core/owner-controller.js";
import { deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";

const admission = (state) => () => ({ ...state });

test("disabled spawn and resume stay pre-prepare and allocate neither Runs nor sessions", async (t) => {
  const state = { enabled: false, revision: 1 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  let preparations = 0;
  await assert.rejects(c.submitPrepared("disabled-spawn", { raw: "spawn" }, () => {
    preparations++; return task("must not prepare");
  }), errorCode("WORKERS_DISABLED"));
  await assert.rejects(c.submit("disabled-submit", task("must not start")), errorCode("WORKERS_DISABLED"));
  assert.equal(preparations, 0); assert.equal(c.hasAcceptedRuns, false);
  assert.equal(ports.length, 0); assert.deepEqual(c.list(), []);
  assert.deepEqual(c.stats().runs, 0); assert.deepEqual(c.stats().agents, 0);

  state.enabled = true;
  const accepted = await c.submit("accepted", task("first"));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(c, accepted);
  const before = c.stats(), portCount = ports.length;
  state.enabled = false; state.revision++;
  await assert.rejects(c.submitPrepared("disabled-resume", { agent: accepted.agent_id, prompt: "again" }, () => {
    preparations++; return { resume: accepted.agent_id, prompt: "again" };
  }), errorCode("WORKERS_DISABLED"));
  assert.equal(preparations, 0); assert.equal(ports.length, portCount);
  assert.equal(c.stats().runs, before.runs); assert.equal(c.stats().agents, before.agents);
});

test("accepted queued and running Runs drain after admission closes", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  const running = await c.submit("running", task("running"));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", task("queued"));
  assert.equal(queued.status, "queued");
  state.enabled = false; state.revision++;
  ports[0].finish("running done"); await ended(c, running);
  await until(() => ports[1]?.streaming);
  ports[1].finish("queued done"); await ended(c, queued);
  assert.deepEqual([c.view(running.run_id).status, c.view(queued.run_id).status], ["completed", "completed"]);
});

test("off rejects external steer but preserves accepted input, soft-budget delivery, reads, waits and release", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports, events } = await fixture(t, { controller: { admission: admission(state) } });
  const run = await c.submit("budget", task("budget", { max_turns: 1 }));
  await until(() => ports[0]?.streaming);
  ports[0].deliveryGate = deferred();
  c.steer(run.run_id, "accepted before off"); await tick();
  state.enabled = false; state.revision++;
  assert.throws(() => c.steer(run.run_id, "rejected while off"), errorCode("WORKERS_DISABLED"));
  assert.throws(() => c.steer("unknown", "no such Run"), errorCode("RUN_NOT_FOUND"));
  assert.deepEqual(events.map((event) => event.kind), ["submit", "steer"]);
  ports[0].deliveryGate.resolve();
  await until(() => ports[0].inputs.includes("accepted before off"));
  ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.includes(softBudgetMessage));
  assert.deepEqual(events.map((event) => event.kind), ["submit", "steer", "soft_budget"]);
  ports[0].finish("done");
  const waited = await c.wait([run.run_id], { mode: "all" });
  assert.equal(waited.reason, "condition"); assert.equal(c.getResult(run.run_id).text, "done");
  assert.throws(() => c.steer(run.run_id, "already finished"), errorCode("RUN_INPUT_CLOSED"));
  assert.deepEqual(events.map((event) => event.kind), ["submit", "steer", "soft_budget"]);
  assert.equal((await c.release(run.agent_id)).released, true);
  assert.equal(c.list({ include_released: true }).length, 1);
});

for (const fault of ["cancel", "parent-history"]) test(`steer rechecks input/Owner guards after admission callback reentry (${fault})`, async (t) => {
  let reenter = () => {};
  const { controller: c, ports, events } = await fixture(t, { controller: {
    admission: () => { reenter(); return { enabled: true, revision: 0 }; },
  } });
  const run = await c.submit("active", task("active"));
  await until(() => ports[0]?.streaming);
  reenter = () => {
    if (fault === "cancel") c.cancel(run.run_id);
    else c.latchParentHistoryFailure(new Error("synthetic parent failure"));
  };
  assert.throws(() => c.steer(run.run_id, "must not accept"),
    errorCode(fault === "cancel" ? "RUN_INPUT_CLOSED" : "OWNER_PARENT_UNAVAILABLE"));
  await tick();
  assert.deepEqual(events.map((event) => event.kind), fault === "cancel" ? ["submit", "cancel"] : ["submit"]);
  assert.deepEqual(ports[0].inputs, []);
});

test("off retains accepted request idempotence and conflict detection", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  let preparations = 0;
  const first = await c.submitPrepared("same", { task: "same" }, () => {
    preparations++; return task("same");
  });
  await until(() => ports[0]?.streaming);
  state.enabled = false; state.revision++;
  const retry = await c.submitPrepared("same", { task: "same" }, () => {
    preparations++; return task("must not prepare");
  });
  assert.equal(retry.run_id, first.run_id); assert.equal(preparations, 1);
  await assert.rejects(c.submitPrepared("same", { task: "conflict" }, () => {
    preparations++; return task("must not prepare");
  }), errorCode("REQUEST_CONFLICT"));
  assert.equal(preparations, 1);
  ports[0].finish(); await ended(c, first);
});

test("a pending request cannot cross an off-on ABA transition", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  const hold = deferred(); c.submitTail = hold.promise;
  let preparations = 0;
  const pending = c.submitPrepared("aba", { task: "aba" }, () => {
    preparations++; return task("must not prepare");
  });
  state.enabled = false; state.revision++;
  state.enabled = true;
  hold.resolve();
  await assert.rejects(pending, errorCode("WORKERS_DISABLED"));
  assert.equal(preparations, 0); assert.equal(ports.length, 0); assert.equal(c.hasAcceptedRuns, false);
});

test("synchronous prepare reentry cannot accept after it closes admission", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  let preparations = 0;
  await assert.rejects(c.submitPrepared("reentry", { task: "reentry" }, () => {
    preparations++;
    c.list();
    state.enabled = false; state.revision++;
    return task("must not allocate");
  }), errorCode("WORKERS_DISABLED"));
  assert.equal(preparations, 1); assert.equal(ports.length, 0);
  assert.equal(c.stats().runs, 0); assert.equal(c.stats().agents, 0);
});

test("reenabling admits new and resumed Runs while a resident Agent retains fixed settings", async (t) => {
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: admission(state) } });
  const initial = await c.submit("initial", task("initial", { settings: { ...task("x").settings, model: "fixed-old" } }));
  await until(() => ports[0]?.streaming); ports[0].finish(); await ended(c, initial);
  state.enabled = false; state.revision++;
  await assert.rejects(c.submit("blocked-resume", { resume: initial.agent_id, prompt: "blocked" }), errorCode("WORKERS_DISABLED"));
  state.enabled = true;
  const created = await c.submit("new", task("new"));
  const resumed = await c.submit("resume", { resume: initial.agent_id, prompt: "continued" });
  assert.equal(resumed.effective_settings.model, "fixed-old");
  await until(() => ports[1]?.streaming); ports[1].finish(); await ended(c, created);
  await until(() => ports[0].calls.length === 2); ports[0].finish(); await ended(c, resumed);
});

test("default callers remain enabled, while bad readers fail closed without poisoning accepted idempotence", async (t) => {
  const defaultFixture = await fixture(t);
  assert.equal(defaultFixture.controller.hasAcceptedRuns, false);
  const defaultRun = await defaultFixture.controller.submit("default", task("default"));
  await until(() => defaultFixture.ports[0]?.streaming);
  assert.equal(defaultFixture.controller.hasAcceptedRuns, true);
  defaultFixture.ports[0].finish(); await ended(defaultFixture.controller, defaultRun);

  let reader = "ok";
  const state = { enabled: true, revision: 0 };
  const { controller: c, ports } = await fixture(t, { controller: { admission: () => {
    if (reader === "throw") throw new Error("reader failed");
    if (reader === "invalid") return { enabled: "yes", revision: 0 };
    return { ...state };
  } } });
  const accepted = await c.submit("accepted", task("accepted"));
  await until(() => ports[0]?.streaming);
  reader = "throw";
  assert.equal((await c.submit("accepted", task("accepted"))).run_id, accepted.run_id);
  reader = "invalid";
  await assert.rejects(c.submit("new", task("new")), errorCode("WORKERS_DISABLED"));
  assert.equal(c.stats().internal_error, undefined); assert.equal(c.stats().parent_error, undefined);
  ports[0].finish(); await ended(c, accepted);
});
