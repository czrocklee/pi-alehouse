import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { softBudgetMessage } from "../../dist/orchestration/core/owner-controller.js";
import { fixture, task, until } from "../support/controller-fixture.mjs";

test("human direct steer reaches the port with the human origin", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const { run_id } = await c.submit("a", task("a"));
  await until(() => ports[0].streaming);
  c.steer(run_id, "from the human", { source: "human" });
  await until(() => ports[0].inputs.length === 1);
  assert.deepEqual(ports[0].origins, ["human"]);
});

test("model steering reaches the port with the parent origin", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const { run_id } = await c.submit("a", task("a"));
  await until(() => ports[0].streaming);
  c.steer(run_id, "from the parent model");
  await until(() => ports[0].inputs.length === 1);
  assert.deepEqual(ports[0].origins, ["parent"]);
});

test("internal soft-budget input reaches the port with the orchestration origin", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { grace_turns: 2 } });
  await c.submit("a", task("a", { max_turns: 1 }));
  await until(() => ports[0].streaming);
  ports[0].callbacks.turnEnd(true);
  ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.includes(softBudgetMessage));
  assert.deepEqual(ports[0].origins, ["orchestration"]);
});

test("agent_send while running reaches the port with the parent origin", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const { agent_id } = await c.submit("a", task("a"));
  await until(() => ports[0].streaming);
  await c.send(`tool:agent_send:${randomUUID()}`, agent_id, "continue");
  await until(() => ports[0].inputs.length === 1);
  assert.deepEqual(ports[0].origins, ["parent"]);
});
