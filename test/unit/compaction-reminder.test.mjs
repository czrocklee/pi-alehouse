import assert from "node:assert/strict";
import test from "node:test";
import { create, run, settle, toolsFor } from "../support/owner-tools-fixture.mjs";
import { fixture, until } from "../support/controller-fixture.mjs";
import {
  compactionReminderMessage,
  compactionReminderText,
  registerCompactionReminder,
  remindAfterCompaction,
} from "../../dist/orchestration/runtime/compaction-reminder.js";

const recorder = () => {
  const sent = [];
  return { sent, pi: { sendMessage: (message, options) => sent.push({ message, options }) } };
};
const remind = (f, pi) => remindAfterCompaction(f.controller, pi);

test("compaction without Agents appends nothing to parent context", async (t) => {
  const f = await fixture(t),
    { sent, pi } = recorder();
  assert.equal(remind(f, pi), false);
  assert.deepEqual(sent, []);
});

test("compaction appends one fixed, non-triggering reminder and consumes nothing", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }),
    { call } = toolsFor(f),
    { sent, pi } = recorder();
  await call("agent_spawn", create({ label: "Survives the summary" }));
  await until(() => f.ports[0]?.streaming);
  assert.equal(remind(f, pi), true);
  assert.equal(sent.length, 1);
  const { message, options } = sent[0];
  assert.deepEqual(message, {
    customType: compactionReminderMessage,
    display: false,
    content: compactionReminderText,
  });
  assert.deepEqual(options, { triggerTurn: false }, "a reminder never starts a parent turn");
  // Fixed bytes: no Agent name, label, status or diagnostic is interpolated.
  assert.doesNotMatch(message.content, /orca|Survives the summary|running|[{}]/);
  f.ports[0].finish();
  await settle(f, "orca");
  // The finished notice is still owed to the model: the reminder presented nothing.
  const waited = await call("agent_wait", { wait_ms: 0 });
  assert.deepEqual(
    waited.finished.map((row) => [row.agent, row.status]),
    [["orca", "completed"]],
  );
  // Idle, resident and fully presented: nothing is owed, so nothing is appended.
  assert.equal((await call("agent_list", {})).agents.length, 1);
  assert.equal(remind(f, pi), false);
  assert.equal(sent.length, 1);
});

test("an unpresented finished notice or an answerable question keeps the reminder owed", async (t) => {
  let enabled = true;
  const f = await fixture(t, { controller: { admission: () => ({ enabled, revision: 0 }) } }),
    { call } = toolsFor(f),
    { sent, pi } = recorder();
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
  assert.equal(remind(f, pi), true, "finished, never presented");
  await call("agent_wait", { wait_ms: 0 });
  assert.equal(remind(f, pi), false);
  await call("agent_run", run("orca", { prompt: "ask first" }));
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  assert.equal(f.ports[0].callbacks.question("which one?"), "recorded");
  f.ports[0].finish("please choose");
  await until(() => f.controller.list().some((view) => view.has_question));
  await call("agent_wait", { wait_ms: 0 });
  assert.equal(remind(f, pi), true, "a presented but unanswered question is still owed");
  // agent_wait's Owner scope drops a question agent_answer could not accept;
  // the reminder follows the same predicate instead of the raw reservation.
  enabled = false;
  assert.equal(remind(f, pi), false, "an unanswerable question is not owed");
  enabled = true;
  assert.equal(remind(f, pi), true);
  assert.equal(sent.length, 3);
});

test("a killed Agent's unpresented result is still owed, as agent_wait delivers it", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f),
    { pi } = recorder();
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  const killing = call("agent_kill", { agent: "orca" });
  await until(() => f.ports[0].stopped === 1);
  f.ports[0].finish("partial", "aborted");
  await killing;
  assert.equal((await call("agent_list", {})).agents.length, 0, "no longer resident");
  assert.equal(remind(f, pi), true);
  const waited = await call("agent_wait", { wait_ms: 0 });
  assert.deepEqual(
    waited.finished.map((row) => row.agent),
    ["orca"],
  );
  assert.equal(remind(f, pi), false);
});

test("a failed check or queue is swallowed, not an Owner fault", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f);
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  const throwing = {
    sendMessage() {
      throw new Error("queue closed");
    },
  };
  assert.equal(remind(f, throwing), false);
  assert.equal(
    remindAfterCompaction(
      {
        validateObservationEntry: (read) => read(),
        hasOutstandingCommunication() {
          throw new Error("owner closed");
        },
      },
      recorder().pi,
    ),
    false,
  );
  assert.equal((await call("agent_list", {})).agents[0].status, "running");
  f.ports[0].finish();
  await settle(f, "orca");
});

test("the registered handler reminds only for the Owner its lookup returns", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f);
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  const handlers = new Map(),
    { sent, pi } = recorder(),
    contexts = [];
  let current = () => undefined;
  registerCompactionReminder({ ...pi, on: (name, fn) => handlers.set(name, fn) }, (ctx) => {
    contexts.push(ctx);
    return current(ctx);
  });
  assert.deepEqual([...handlers.keys()], ["session_compact"]);
  const compact = handlers.get("session_compact"),
    ctx = { marker: "compacted session" };
  compact({ type: "session_compact" }, ctx);
  assert.deepEqual(sent, [], "no bound Owner: nothing is sent");
  current = () => {
    throw new Error("stale context");
  };
  compact({ type: "session_compact" }, ctx);
  assert.deepEqual(sent, [], "a throwing lookup is no Owner");
  current = () => f.controller;
  compact({ type: "session_compact" }, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(contexts, [ctx, ctx, ctx], "the lookup sees the event's own context");
  f.ports[0].finish();
  await settle(f, "orca");
});
