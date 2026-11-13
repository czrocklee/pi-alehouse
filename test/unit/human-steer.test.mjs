import assert from "node:assert/strict";
import test from "node:test";
import { taskReply } from "../../dist/orchestration/tools/replies.js";
import {
  HUMAN_STEER_MAX_UNITS,
  humanSteerLead,
  requestHumanSteer,
} from "../../dist/orchestration/runtime/human-steer.js";
import { ended, errorCode, fixture, task, until } from "../support/controller-fixture.mjs";

// Controlled Owner/SessionPort only: admission and projection, not model receipt.
const human = Object.freeze({ source: "human" });
const body = (result) => JSON.parse(result.content[0].text);

test("a human message marks its Run; model steering alone does not", async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const run = await c.submit("a", task("a", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  c.steer(run.run_id, "from the parent model");
  assert.equal(Object.hasOwn(c.view(run.run_id), "human_steered"), false);
  assert.equal(
    Object.hasOwn(
      taskReply(c.view(run.run_id), () => "otter"),
      "human_steered",
    ),
    false,
  );
  assert.equal(c.steer(run.run_id, "from the human", human).accepted, true);
  assert.equal(c.view(run.run_id).human_steered, true);
  assert.equal(Object.hasOwn(c.view(run.run_id), "cancellation_source"), false);
  // Same context-change event as any steer: it invalidates approval, never widens it.
  assert.deepEqual(
    events.map(({ kind }) => kind),
    ["submit", "steer", "steer"],
  );
  assert.equal(taskReply(c.view(run.run_id), () => "otter").human_steered, true);
  const waited = body(
    await c.observe({ kind: "wait", agent_ids: [run.agent_id], wait_ms: 0 }, { validate() {} }),
  );
  assert.equal(waited.tasks[0].human_steered, true);
  ports[0].finish("done");
  await ended(c, run);
  assert.equal(c.view(run.run_id).human_steered, true, "the marker outlives execution");
  assert.equal(Object.hasOwn(c.view(run.run_id).outcome, "human_steered"), false);
  const read = body(await c.observe({ kind: "read", agent_id: run.agent_id }, { validate() {} }));
  assert.equal(read.tasks[0].human_steered, true);
});

test("the runtime adapter rejects invalid raw text before invoking core", () => {
  let calls = 0;
  const controller = {
    steer() {
      calls++;
      throw new Error("invalid raw text must not reach core");
    },
  };
  for (const text of [
    "",
    " \t\r\n",
    "\u00a0\u2003\u2028\ufeff",
    undefined,
    null,
    0,
    false,
    [],
    {},
    new String("not a primitive string"),
    { trim: () => "not a string" },
  ]) {
    assert.throws(
      () => requestHumanSteer(controller, "exact-run", text),
      errorCode("INVALID_MESSAGE"),
    );
  }
  assert.equal(calls, 0);
});

test("invalid adapter input has no marker, context, delivery or quota effects", async (t) => {
  const {
    controller: c,
    ports,
    events,
  } = await fixture(t, {
    controller: { clock: { wall: () => 1000, mono: () => 0 } },
  });
  const run = await c.submit("a", task("a"));
  await until(() => ports[0]?.streaming);
  const before = c.view(run.run_id);
  const beforeEvents = [...events];
  for (const text of ["", " \t\n", "\u00a0\u2003", undefined, null, 42, {}, []]) {
    assert.throws(() => requestHumanSteer(c, run.run_id, text), errorCode("INVALID_MESSAGE"));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(c.view(run.run_id), before);
  assert.deepEqual(events, beforeEvents, "no approval-invalidating context event");
  assert.deepEqual(ports[0].inputs, []);
  for (let i = 0; i < 64; i++) c.steer(run.run_id, `parent input ${i}`);
  assert.throws(() => requestHumanSteer(c, run.run_id, "over quota"), errorCode("INPUT_LIMIT"));
  await until(() => ports[0].inputs.length === 64);
  assert.equal(events.filter(({ kind }) => kind === "steer").length, 64);
  assert.equal(Object.hasOwn(c.view(run.run_id), "human_steered"), false);
});

for (const [name, token] of [
  ["ASCII", "x"],
  ["astral", "😀"],
  ["combining", "e\u0301"],
  ["ZWJ", "👩‍💻"],
]) {
  test(`adapter enforces the full wrapped UTF-16 boundary (${name})`, async (t) => {
    const {
      controller: c,
      ports,
      events,
    } = await fixture(t, {
      controller: { clock: { wall: () => 1000, mono: () => 0 } },
    });
    const run = await c.submit("a", task("a"));
    await until(() => ports[0]?.streaming);
    assert.equal(humanSteerLead.length + 2, 148);
    assert.equal(HUMAN_STEER_MAX_UNITS, 16236);
    const raw =
      token.repeat(Math.floor(HUMAN_STEER_MAX_UNITS / token.length)) +
      "x".repeat(HUMAN_STEER_MAX_UNITS % token.length);
    assert.equal(raw.length, HUMAN_STEER_MAX_UNITS);
    const before = c.view(run.run_id);
    const beforeEvents = [...events];
    assert.throws(() => requestHumanSteer(c, run.run_id, `${raw}x`), errorCode("INVALID_MESSAGE"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(c.view(run.run_id), before);
    assert.deepEqual(events, beforeEvents);
    assert.deepEqual(ports[0].inputs, []);
    assert.deepEqual(requestHumanSteer(c, run.run_id, ` \t${raw}\n `), { accepted: true });
    await until(() => ports[0].inputs.length === 1);
    assert.equal(ports[0].inputs[0], `${humanSteerLead}\n\n${raw}`);
    assert.equal(ports[0].inputs[0].length, 16384);
    assert.equal(c.view(run.run_id).human_steered, true);
    assert.deepEqual(
      events.map(({ kind }) => kind),
      ["submit", "steer"],
    );
    for (let i = 1; i < 64; i++) c.steer(run.run_id, `parent input ${i}`);
    assert.throws(() => requestHumanSteer(c, run.run_id, "over quota"), errorCode("INPUT_LIMIT"));
    await until(() => ports[0].inputs.length === 64);
    assert.equal(events.filter(({ kind }) => kind === "steer").length, 64);
  });
}

test("the adapter retains Off gating and exact Run targeting on Agent reuse", async (t) => {
  const admission = { enabled: true, revision: 0 };
  const {
    controller: c,
    ports,
    events,
  } = await fixture(t, {
    controller: { admission: () => ({ ...admission }) },
  });
  const first = await c.submit("first", task("first"));
  await until(() => ports[0]?.streaming);
  admission.enabled = false;
  admission.revision++;
  assert.throws(() => requestHumanSteer(c, first.run_id, "while Off"), errorCode("DELEGATION_OFF"));
  assert.equal(Object.hasOwn(c.view(first.run_id), "human_steered"), false);
  assert.deepEqual(
    events.map(({ kind }) => kind),
    ["submit"],
  );
  assert.deepEqual(ports[0].inputs, []);
  admission.enabled = true;
  admission.revision++;
  ports[0].finish("first done");
  await ended(c, first);
  const second = await c.submit("second", { resume: first.agent_id, prompt: "second" });
  await until(() => ports[0].streaming);
  const beforeEvents = [...events];
  assert.throws(() => requestHumanSteer(c, first.run_id, "stale"), errorCode("RUN_INPUT_CLOSED"));
  assert.deepEqual(events, beforeEvents);
  assert.equal(Object.hasOwn(c.view(second.run_id), "human_steered"), false);
  assert.deepEqual(requestHumanSteer(c, second.run_id, "current"), { accepted: true });
  await until(() => ports[0].inputs.length === 1);
  assert.equal(ports[0].inputs[0], `${humanSteerLead}\n\ncurrent`);
  assert.equal(Object.hasOwn(c.view(first.run_id), "human_steered"), false);
  assert.equal(c.view(second.run_id).human_steered, true);
});

test("a refused human message marks nothing", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const queued = await c.submit("a", task("a", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  assert.throws(() => c.steer(queued.run_id, "   ", human), errorCode("INVALID_MESSAGE"));
  assert.throws(
    () => c.steer(queued.run_id, "x", { source: "model" }),
    errorCode("INVALID_CANCEL_OPTIONS"),
  );
  assert.equal(Object.hasOwn(c.view(queued.run_id), "human_steered"), false);
  ports[0].finish("done");
  await ended(c, queued);
  assert.throws(() => c.steer(queued.run_id, "late", human), errorCode("RUN_INPUT_CLOSED"));
  assert.equal(Object.hasOwn(c.view(queued.run_id), "human_steered"), false);
});
