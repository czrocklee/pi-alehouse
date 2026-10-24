import assert from "node:assert/strict";
import test from "node:test";
import { FakePort, deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";
import { assertOwnerInvariants } from "../support/owner-invariants.mjs";

// Synthetic SessionPort only. No live model, network, or host SDK.
// concurrency is per immutable settings.provider; resident and queue stay owner-wide.
// fixture() pins concurrency 1; omitLimits opens the controller with omitted defaults.

const work = (prompt, provider, options = {}) => {
  const { model, profile, difficulty, ...rest } = options;
  const request = task(prompt, rest);
  const next = { ...request.settings, provider };
  if (model !== undefined) next.model = model;
  if (profile !== undefined) next.profile = profile;
  if (difficulty !== undefined) { next.difficulty = difficulty; next.strength = `d${difficulty}`; }
  request.settings = next;
  return request;
};
const portFor = (ports, prompt) => ports.find((port) => port.calls.some((call) => call.prompt === prompt));
const providerRow = (controller, provider) => {
  const stats = controller.stats();
  assert.equal(stats.concurrency_scope, "provider");
  const rows = stats.providers;
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.reduce((sum, row) => sum + row.active, 0), stats.active, "provider active sums to stats.active");
  assert.equal(rows.reduce((sum, row) => sum + row.queued, 0), stats.queued, "provider queued sums to stats.queued");
  assert.equal(rows.every((row) => row.limit === stats.limits.concurrency && (row.active > 0 || row.queued > 0)), true);
  return rows.find((row) => row.provider === provider);
};
const modelRows = async (controller, agentIds) => {
  const body = JSON.parse((await controller.observe({ kind: "wait", agent_ids: agentIds, mode: "all", wait_ms: 0 }, { validate() {} })).content[0].text);
  assert.equal(Array.isArray(body.agents), true);
  for (const row of body.agents) {
    assert.equal(Object.hasOwn(row, "provider"), false, row.agent);
    if (row.wait !== undefined) assert.ok(row.wait === "dependencies" || row.wait === "capacity", row.wait);
  }
  return body.agents;
};
const openDefault = (t) => fixture(t, { omitLimits: true });

test("default concurrency of four is per provider and resident twelve is the owner total", async (t) => {
  const { controller: c, ports } = await openDefault(t);
  assert.deepEqual([c.stats().limits.concurrency, c.stats().limits.resident, c.stats().limits.queue], [4, 12, 16]);
  const accepted = [];
  for (const provider of ["alpha", "beta", "gamma"]) {
    for (let i = 1; i <= 4; i++) accepted.push({ provider, prompt: `${provider}-${i}`, ...(await c.submit(`${provider}-${i}`, work(`${provider}-${i}`, provider))) });
  }
  await until(() => ports.filter((port) => port.streaming).length === 12);
  assert.equal(c.stats().active, 12);
  assert.equal(c.stats().queued, 0);
  assert.equal(c.stats().resident, 12);
  assert.deepEqual(providerRow(c, "alpha"), { provider: "alpha", active: 4, queued: 0, limit: 4 });
  assert.deepEqual(providerRow(c, "beta"), { provider: "beta", active: 4, queued: 0, limit: 4 });
  assert.deepEqual(providerRow(c, "gamma"), { provider: "gamma", active: 4, queued: 0, limit: 4 });
  assertOwnerInvariants(c, "default split");
  const rejectFull = (id, prompt) => assert.rejects(c.submit(id, work(prompt, "delta")), (error) => {
    assert.equal(error.code, "RESIDENT_LIMIT");
    assert.equal(error.details.resident_limit, 12);
    return true;
  });
  await rejectFull("overflow", "overflow");
  assert.equal(c.stats().runs, 12);
  assert.equal(c.stats().resident, 12);
  assert.equal(ports.length, 12, "the rejected provider never receives a session");
  const alphas = accepted.filter((run) => run.provider === "alpha");
  for (const run of alphas) portFor(ports, run.prompt).finish("alpha done");
  for (const run of alphas) await ended(c, run);
  assert.equal(c.stats().active, 8);
  assert.equal(c.stats().resident, 12, "completed-unreleased residents retain the owner cap");
  assert.equal(alphas.every((run) => c.view(run.run_id).status === "completed" && c.view(run.run_id).resident), true);
  await rejectFull("still-full", "still-full");
  assert.equal(c.stats().runs, 12);
  assert.equal(ports.length, 12);
  assert.deepEqual(await c.kill(alphas[0].agent_id), { agent_id: alphas[0].agent_id, state: "released" });
  assert.equal(c.view(alphas[0].run_id).resident, false);
  assert.equal(c.stats().resident, 11);
  const queued = await c.submit("beta-5", work("beta-5", "beta"));
  assert.equal(queued.status, "queued", "the freed slot admits work that still waits on its provider cap");
  assert.equal(c.stats().resident, 12);
  assert.equal(c.stats().queued, 1);
  assert.equal(c.stats().runs, 13);
  assert.deepEqual(providerRow(c, "beta"), { provider: "beta", active: 4, queued: 1, limit: 4 });
  assert.equal(providerRow(c, "alpha"), undefined, "a completed provider with nothing queued is omitted");
  assert.equal(ports.length, 12, "a queued admission does not open a session");
});

test("one provider shares its cap across model, profile and difficulty; FIFO skips a saturated head", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2, resident_limit: 8, queue_limit: 8 } });
  const first = await c.submit("first", work("first", "alpha", { name: "first", model: "model-a", profile: "reader", difficulty: 1 }));
  const second = await c.submit("second", work("second", "alpha", { name: "second", model: "model-b", profile: "editor", difficulty: 5 }));
  const third = await c.submit("third", work("third", "alpha", { name: "third", model: "model-c", profile: "researcher", difficulty: 3 }));
  const later = await c.submit("later", work("later", "alpha", { name: "later", model: "model-d", profile: "reader", difficulty: 4 }));
  const other = await c.submit("other", work("other", "beta", { name: "other", model: "model-a", profile: "reader", difficulty: 1 }));
  await until(() => ports.filter((port) => port.streaming).length === 3);
  assert.equal(c.view(first.run_id).status, "running");
  assert.equal(c.view(second.run_id).status, "running");
  assert.equal(c.view(third.run_id).status, "queued");
  assert.equal(c.view(later.run_id).status, "queued");
  assert.equal(c.view(other.run_id).status, "running");
  assert.equal(c.view(second.run_id).effective_settings.model, "model-b");
  assert.equal(c.view(second.run_id).effective_settings.profile, "editor");
  assert.equal(c.view(second.run_id).effective_settings.difficulty, 5);
  assert.deepEqual([...c.queue], [third.run_id, later.run_id]);
  assert.equal(c.view(third.run_id).queued_for, "capacity");
  assert.equal(c.view(later.run_id).queued_for, "capacity");
  assert.equal(c.view(other.run_id).queued_for, undefined);
  assert.deepEqual(providerRow(c, "alpha"), { provider: "alpha", active: 2, queued: 2, limit: 2 });
  assert.deepEqual(providerRow(c, "beta"), { provider: "beta", active: 1, queued: 0, limit: 2 });
  const rows = await modelRows(c, [first.agent_id, third.agent_id, later.agent_id, other.agent_id]);
  assert.equal(rows.find((row) => row.agent === "third").wait, "capacity");
  assert.equal(rows.find((row) => row.agent === "later").wait, "capacity");
  assert.equal(rows.find((row) => row.agent === "first").status, "running");
  assert.equal(rows.find((row) => row.agent === "first").wait, undefined);
  assert.equal(rows.find((row) => row.agent === "other").wait, undefined);
  assertOwnerInvariants(c, "shared provider cap");
  portFor(ports, "first").finish("first done");
  await until(() => portFor(ports, "third")?.streaming);
  assert.equal(c.view(later.run_id).status, "queued");
  assert.equal(c.view(other.run_id).status, "running");
  assert.deepEqual([...c.queue], [later.run_id]);
});

test("initializing runs count against their provider while another provider starts", async (t) => {
  const gate = deferred();
  const { controller: c, ports } = await fixture(t, { beforeShutdown: async () => { gate.resolve(); await tick(); }, controller: { concurrency: 1, resident_limit: 6, queue_limit: 6, createSession: async () => {
    const port = new FakePort(); ports.push(port); await gate.promise; return port;
  } } });
  const alpha = await c.submit("alpha", work("alpha", "alpha"));
  const queued = await c.submit("queued", work("queued", "alpha"));
  const beta = await c.submit("beta", work("beta", "beta"));
  assert.equal(c.view(alpha.run_id).phase, "initializing");
  assert.equal(c.view(beta.run_id).phase, "initializing");
  assert.equal(c.view(queued.run_id).status, "queued");
  assert.equal(c.runs.get(alpha.run_id).active, true);
  assert.equal(c.runs.get(beta.run_id).active, true);
  assert.equal(c.stats().active, 2);
  assert.equal(ports.length, 2);
  assert.equal(ports.every((port) => port.calls.length === 0), true);
  assertOwnerInvariants(c, "initializing counts");
  gate.resolve();
  await until(() => ports.filter((port) => port.streaming).length === 2);
  assert.equal(c.view(queued.run_id).status, "queued");
  assert.equal(c.view(alpha.run_id).phase, "executing");
  assert.equal(providerRow(c, "alpha")?.active, 1);
});

test("cancellation keeps its provider slot until exit while another provider starts", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 6, queue_limit: 6 } });
  const alpha = await c.submit("alpha", work("alpha", "alpha"));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", work("queued", "alpha"));
  c.cancel(alpha.run_id); await tick();
  assert.equal(c.view(alpha.run_id).status, "cancelling");
  assert.equal(c.view(alpha.run_id).execution_exited, false);
  assert.equal(c.runs.get(alpha.run_id).active, true);
  assert.equal(c.view(queued.run_id).status, "queued");
  const beta = await c.submit("beta", work("beta", "beta"));
  await until(() => portFor(ports, "beta")?.streaming);
  assert.equal(c.view(queued.run_id).status, "queued");
  assert.equal(c.stats().active, 2);
  assert.equal(providerRow(c, "alpha")?.active, 1);
  assert.equal(providerRow(c, "beta")?.active, 1);
  assertOwnerInvariants(c, "cancel holds slot");
  ports[0].finish("partial", "aborted");
  await until(() => portFor(ports, "queued")?.streaming);
  assert.equal(c.runs.get(alpha.run_id).active, false);
  assert.equal(c.view(alpha.run_id).execution_exited, true);
  assert.equal(providerRow(c, "alpha")?.active, 1);
  assert.equal(c.view(beta.run_id).status, "running");
});

test("execution exit frees that provider before history finalization", async (t) => {
  const gate = deferred(), entered = deferred();
  let hold = false;
  const { controller: c, ports } = await fixture(t, { beforeShutdown: async () => { gate.resolve(); await tick(); }, controller: { concurrency: 1, resident_limit: 6, queue_limit: 6 }, history: async (point) => {
    if (hold && point === "finish") { entered.resolve(); await gate.promise; }
  } });
  const alpha = await c.submit("alpha", work("alpha", "alpha"));
  const beta = await c.submit("beta", work("beta", "beta"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const next = await c.submit("next", work("next", "alpha"));
  hold = true;
  portFor(ports, "alpha").finish("alpha done");
  await entered.promise;
  await until(() => portFor(ports, "next")?.streaming);
  assert.equal(c.view(alpha.run_id).execution_exited, true);
  assert.equal(c.view(alpha.run_id).finalization_pending, true);
  assert.equal(c.view(alpha.run_id).phase, "finalizing");
  assert.equal(c.runs.get(alpha.run_id).active, false);
  assert.equal(c.view(next.run_id).status, "running");
  assert.equal(c.view(beta.run_id).status, "running");
  assert.equal(providerRow(c, "alpha")?.active, 1);
  assert.equal((c.stats().finalizing_waits ?? []).some((wait) => wait.run_id === alpha.run_id && wait.wait === "history"), true);
  gate.resolve();
  await ended(c, alpha);
  assert.equal(c.view(alpha.run_id).status, "completed");
});

test("resume and answer stay in the original provider group", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 6, queue_limit: 6 } });
  const original = await c.submit("original", work("original", "alpha", { model: "alpha-model", profile: "editor", difficulty: 2 }));
  await until(() => ports[0]?.streaming);
  ports[0].callbacks.question("Which path?");
  ports[0].finish("need a path");
  await ended(c, original);
  await c.submit("filler", work("filler", "alpha"));
  await until(() => ports[1]?.streaming);
  const answer = await c.answer("answer", original.agent_id, c.view(original.run_id).question_id, "left");
  assert.equal(answer.status, "queued");
  assert.equal(answer.effective_settings.provider, "alpha");
  assert.equal(answer.effective_settings.model, "alpha-model");
  assert.equal(answer.effective_settings.difficulty, 2);
  const beta = await c.submit("beta", work("beta", "beta"));
  await until(() => portFor(ports, "beta")?.streaming);
  assert.equal(c.view(answer.run_id).status, "queued");
  portFor(ports, "filler").finish("done");
  await until(() => ports[0].calls.length === 2 && ports[0].streaming);
  assert.equal(ports[0].calls[1].prompt, "left");
  assert.equal(c.runs.get(answer.run_id).record.settings.provider, "alpha");
  ports[0].finish("answered");
  await ended(c, answer);
  await c.submit("blocker", work("blocker", "alpha"));
  await until(() => portFor(ports, "blocker")?.streaming);
  const resumed = await c.submit("resume", { resume: original.agent_id, prompt: "continue" });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.effective_settings.provider, "alpha");
  assert.equal(resumed.effective_settings.profile, "editor");
  assert.equal(c.view(beta.run_id).status, "running");
  assert.equal(providerRow(c, "alpha")?.active, 1);
});

test("the queue limit stays owner-wide when another provider has free capacity", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 8, queue_limit: 2 } });
  await c.submit("alpha", work("alpha", "alpha"));
  await c.submit("beta", work("beta", "beta"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  await c.submit("alpha-q", work("alpha-q", "alpha"));
  await c.submit("beta-q", work("beta-q", "beta"));
  assert.equal(c.stats().queued, 2);
  assert.equal(c.stats().limits.queue, 2);
  assert.deepEqual(providerRow(c, "alpha"), { provider: "alpha", active: 1, queued: 1, limit: 1 });
  assert.deepEqual(providerRow(c, "beta"), { provider: "beta", active: 1, queued: 1, limit: 1 });
  await assert.rejects(c.submit("gamma", work("gamma", "gamma")), errorCode("QUEUE_FULL"));
  assert.equal(c.stats().runs, 4);
  assert.equal(c.stats().active, 2);
  assert.equal(ports.length, 2);
  assert.equal(providerRow(c, "gamma"), undefined);
});

test("a cross-provider dependency takes no slot and fails without one when unmet", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 6, queue_limit: 6 } });
  const dep = await c.submit("dep", work("dep", "alpha", { name: "alpha-dep" }));
  await until(() => ports[0]?.streaming);
  const waiter = await c.submit("waiter", work("waiter", "beta", { name: "beta-wait", after: [dep.run_id] }));
  const peer = await c.submit("peer", work("peer", "beta"));
  await until(() => portFor(ports, "peer")?.streaming);
  assert.equal(c.view(waiter.run_id).status, "queued");
  assert.equal(c.view(waiter.run_id).queued_for, "dependencies");
  assert.deepEqual(c.view(waiter.run_id).blocked_by, [dep.run_id]);
  assert.equal(c.stats().active, 2);
  assert.equal(ports.length, 2);
  assert.deepEqual(providerRow(c, "alpha"), { provider: "alpha", active: 1, queued: 0, limit: 1 });
  assert.deepEqual(providerRow(c, "beta"), { provider: "beta", active: 1, queued: 1, limit: 1 });
  const [waiterRow] = await modelRows(c, [waiter.agent_id]);
  assert.equal(waiterRow.agent, "beta-wait");
  assert.equal(waiterRow.status, "queued");
  assert.equal(waiterRow.wait, "dependencies");
  ports[0].finish("broken", "error", "boom");
  const failed = (await ended(c, waiter)).snapshots[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.outcome.reason, "dependency_not_completed");
  assert.equal(failed.outcome.error, "DEPENDENCY_NOT_COMPLETED: alpha-dep (failed)");
  assert.equal(ports.length, 2, "failDoomed does not create a session");
  assert.equal(c.view(peer.run_id).status, "running");
  assert.equal(c.runs.get(waiter.run_id).active, false);
});

for (const unfinished of [false, true]) {
  test(`wait-any publishes no queue wait for a doomed dependency${unfinished ? " with another predecessor unfinished" : " while its provider is full"}`, async (t) => {
    const { controller: c, ports } = await fixture(t);
    const dep = await c.submit("dep", work("dep", "alpha", { name: "alpha-dep" }));
    const peer = await c.submit("peer", work("peer", "beta", { name: "beta-peer" }));
    const other = unfinished ? await c.submit("other", work("other", "gamma", { name: "gamma-dep" })) : undefined;
    const after = other ? [other.run_id, dep.run_id] : [dep.run_id];
    const waiter = await c.submit("waiter", work("waiter", "beta", { name: "beta-wait", after }));
    const sessionCount = other ? 3 : 2;
    await until(() => ports.length === sessionCount && ports.every((port) => port.streaming));
    assert.equal(c.view(waiter.run_id).queued_for, "dependencies");
    const publications = [];
    const observation = c.observe({ kind: "wait", agent_ids: [dep.agent_id, waiter.agent_id], mode: "any", wait_ms: 3000 }, {
      validate() {
        if (c.view(dep.run_id).status === "failed") publications.push({
          waiter: c.view(waiter.run_id), peer: c.view(peer.run_id),
          other: other ? c.view(other.run_id) : undefined, sessions: ports.length,
        });
      },
    });
    portFor(ports, "dep").finish("broken", "error", "boom");
    // Settlement wakes the registered observer synchronously, before pump fails
    // the doomed successor. Assert the actual published result, not a later poll.
    const body = JSON.parse((await observation).content[0].text);
    assert.equal(body.reason, "task_issue");
    assert.equal(body.agents.find((row) => row.agent === "alpha-dep").status, "failed");
    const row = body.agents.find((entry) => entry.agent === "beta-wait");
    assert.equal(row.status, "queued");
    assert.equal(Object.hasOwn(row, "wait"), false);
    assert.equal(publications.length, 1);
    const published = publications[0];
    assert.equal(published.waiter.status, "queued");
    assert.equal(published.waiter.queued_for, undefined);
    assert.deepEqual(published.waiter.blocked_by ?? [], other ? [other.run_id] : []);
    assert.equal(published.sessions, sessionCount, "publication allocates no successor session");
    assert.equal(published.peer.status, "running");
    if (other) assert.equal(published.other.status, "running");
    const failed = (await ended(c, waiter)).snapshots[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.outcome.reason, "dependency_not_completed");
    assert.equal(failed.outcome.error, "DEPENDENCY_NOT_COMPLETED: alpha-dep (failed)");
    assert.equal(ports.length, sessionCount, "dependency failure allocates no session");
    assert.equal(portFor(ports, "waiter"), undefined);
    assert.equal(c.view(peer.run_id).status, "running");
    if (other) assert.equal(c.view(other.run_id).status, "running");
  });
}

test("wait-any can publish a ready successor queued without a blocker before pump starts it", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const dep = await c.submit("dep", work("dep", "alpha", { name: "alpha-dep" }));
  const waiter = await c.submit("waiter", work("waiter", "beta", { name: "beta-wait", after: [dep.run_id] }));
  await until(() => portFor(ports, "dep")?.streaming);
  assert.equal(c.view(waiter.run_id).queued_for, "dependencies");
  const publications = [];
  const observation = c.observe({ kind: "wait", agent_ids: [dep.agent_id, waiter.agent_id], mode: "any", wait_ms: 3000 }, {
    validate() {
      if (c.view(dep.run_id).status === "completed") publications.push({ waiter: c.view(waiter.run_id), sessions: ports.length });
    },
  });
  portFor(ports, "dep").finish("done");
  const body = JSON.parse((await observation).content[0].text);
  assert.equal(body.reason, "done");
  assert.equal(body.agents.find((row) => row.agent === "alpha-dep").status, "completed");
  const row = body.agents.find((entry) => entry.agent === "beta-wait");
  assert.equal(row.status, "queued");
  // Queue wait is conditional: this publication precedes pump, but neither
  // dependencies nor capacity blocks the successor anymore.
  assert.equal(Object.hasOwn(row, "wait"), false);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].waiter.status, "queued");
  assert.equal(publications[0].waiter.queued_for, undefined);
  assert.deepEqual(publications[0].waiter.blocked_by ?? [], []);
  assert.equal(publications[0].sessions, 1);
  const successorPort = () => ports.find((port) => port.calls.some((call) => call.identity.run_id === waiter.run_id));
  await until(() => successorPort()?.streaming);
  assert.equal(successorPort().calls[0].identity.agent_id, waiter.agent_id);
  assert.notEqual(successorPort().session_id, portFor(ports, "dep").session_id);
  assert.equal(c.view(waiter.run_id).status, "running");
  assert.equal(ports.length, 2);
});

test("a synchronous run throw frees the provider slot for a queued peer in the same pump", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 6, queue_limit: 6, createSession: async () => {
    const port = new FakePort();
    const inherited = FakePort.prototype.run;
    port.run = function (prompt, callbacks, identity) {
      if (port.failSync) throw new Error("sync execution failure");
      return inherited.call(port, prompt, callbacks, identity);
    };
    ports.push(port);
    return port;
  } } });
  const original = await c.submit("original", work("original", "alpha"));
  await until(() => ports[0]?.streaming);
  ports[0].finish("seed");
  await ended(c, original);
  await c.submit("holder", work("holder", "alpha"));
  await until(() => ports[1]?.streaming);
  ports[0].failSync = true;
  const resumed = await c.submit("resume", { resume: original.agent_id, prompt: "boom" });
  const peer = await c.submit("peer", work("peer", "alpha"));
  assert.deepEqual([...c.queue], [resumed.run_id, peer.run_id]);
  ports[1].finish("release");
  await until(() => portFor(ports, "peer")?.streaming);
  assert.equal(c.runs.get(resumed.run_id).active, false);
  assert.equal(c.view(resumed.run_id).execution_exited, true);
  assert.equal(c.view(peer.run_id).status, "running");
  assert.equal(c.stats().queued, 0);
  assert.equal(providerRow(c, "alpha")?.active, 1);
  assert.equal(providerRow(c, "alpha")?.queued, 0);
  const failed = (await ended(c, resumed)).snapshots[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.outcome.reason, "execution_error");
  assertOwnerInvariants(c, "sync exit continues the outer pump");
});

test("live scheduling invariant accepts active cancellation and rejects a ready run left queued with capacity", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 4, queue_limit: 4 } });
  const running = await c.submit("running", work("running", "alpha"));
  await until(() => ports[0]?.streaming);
  const queued = await c.submit("queued", work("queued", "alpha"));
  c.cancel(running.run_id); await tick();
  assert.equal(c.view(running.run_id).status, "cancelling");
  assert.equal(c.runs.get(running.run_id).active, true);
  assert.equal(c.view(queued.run_id).queued_for, "capacity");
  assertOwnerInvariants(c, "active cancelling holds the slot");
  const held = c.runs.get(running.run_id);
  const saved = { active: held.active, exited: held.record.execution_exited, controllerActive: c.active };
  try {
    held.active = false;
    held.record.execution_exited = true;
    c.active = 0;
    assert.throws(() => assertOwnerInvariants(c, "negative"), (error) => {
      assert.match(error.message, /ready .+ queued under alpha with capacity/);
      assert.doesNotMatch(error.message, /unslotted/);
      return true;
    });
  } finally {
    held.active = saved.active;
    held.record.execution_exited = saved.exited;
    c.active = saved.controllerActive;
  }
  assertOwnerInvariants(c, "restored");
});

test("queued projections reuse one occupancy snapshot and do not keep it", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 1, resident_limit: 8, queue_limit: 8 } });
  const submit = (name, provider) => c.submit(name, work(name, provider, { name }));
  const alpha = await submit("alpha-hold", "alpha");
  const beta = await submit("beta-hold", "beta");
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const queued = [];
  for (const [name, provider] of [["alpha-q1", "alpha"], ["alpha-q2", "alpha"], ["alpha-q3", "alpha"], ["beta-q1", "beta"], ["beta-q2", "beta"]]) queued.push(await submit(name, provider));
  const original = c.providerActivity;
  let calls = 0;
  c.providerActivity = function (...args) { calls += 1; return original.apply(this, args); };
  const taken = () => { const seen = calls; calls = 0; return seen; };
  const byId = (rows, id) => rows.find((row) => row.agent_id === id);
  try {
    const listed = c.list();
    assert.equal(taken(), 1);
    for (const holder of [alpha, beta]) {
      assert.equal(byId(listed, holder.agent_id).status, "running");
      assert.equal(byId(listed, holder.agent_id).queued_for, undefined);
    }
    for (const run of queued) {
      assert.equal(byId(listed, run.agent_id).status, "queued");
      assert.equal(byId(listed, run.agent_id).queued_for, "capacity");
    }
    const waiting = await modelRows(c, queued.map((run) => run.agent_id));
    assert.equal(taken(), 1);
    assert.equal(waiting.length, queued.length);
    for (const row of waiting) {
      assert.equal(row.status, "queued");
      assert.equal(row.wait, "capacity");
    }
    assert.equal(c.view(queued[0].run_id).queued_for, "capacity");
    assert.equal(taken(), 1);
    assert.equal(c.view(alpha.run_id).queued_for, undefined);
    assert.equal(taken(), 0);
    portFor(ports, "alpha-hold").finish("done");
    await until(() => portFor(ports, "alpha-q1")?.streaming);
    await ended(c, alpha);
    taken();
    const next = c.list();
    assert.equal(taken(), 1);
    assert.equal(byId(next, alpha.agent_id).status, "completed");
    assert.equal(byId(next, alpha.agent_id).queued_for, undefined);
    assert.equal(byId(next, queued[0].agent_id).status, "running");
    assert.equal(byId(next, queued[0].agent_id).queued_for, undefined);
    for (const run of queued.slice(1)) {
      assert.equal(byId(next, run.agent_id).status, "queued");
      assert.equal(byId(next, run.agent_id).queued_for, "capacity");
    }
    const after = await modelRows(c, [queued[0].agent_id, queued[1].agent_id, queued[3].agent_id]);
    assert.equal(taken(), 1);
    assert.equal(after.find((row) => row.agent === "alpha-q1").status, "running");
    assert.equal(after.find((row) => row.agent === "alpha-q1").wait, undefined);
    assert.equal(after.find((row) => row.agent === "alpha-q2").wait, "capacity");
    assert.equal(after.find((row) => row.agent === "beta-q1").wait, "capacity");
    assert.equal(c.view(queued[0].run_id).status, "running");
    assert.equal(taken(), 0);
    assert.equal(c.view(queued[1].run_id).queued_for, "capacity");
    assert.equal(taken(), 1);
  } finally {
    c.providerActivity = original;
  }
});
