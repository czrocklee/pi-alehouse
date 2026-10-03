import assert from "node:assert/strict";
import test from "node:test";
import { softBudgetMessage } from "../../dist/core/owner-controller.js";
import { ParentHistoryError } from "../../dist/core/ports.js";
import { errorReply, taskReply } from "../../dist/tools/replies.js";
import { deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";

const namesOf = (c) => (id) => c.view(id).name;
const named = (name, extra = {}) => task(name, { name, ...extra });
const observe = async (c, request, signal) => JSON.parse((await c.observe(request, { validate() {}, signal })).content[0].text);
const wait = (c, runs, extra = {}, signal) => observe(c, { kind: "wait", agent_ids: runs.map((run) => run.agent_id), ...extra }, signal);
const read = (c, run, extra = {}) => observe(c, { kind: "read", agent_id: run.agent_id, ...extra });

test("alerts survive absent waiters, wake matching observations, and are presented exactly once", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("a", named("a")), b = await c.submit("b", named("b"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  ports[1].callbacks.alert("B before wait");
  assert.equal((await wait(c, [a], { wait_ms: 0 })).reason, "timeout");
  assert.equal(c.view(b.run_id).pending_messages, 1);
  ports[0].callbacks.alert("A buffered");
  assert.equal((await wait(c, [a], {}, AbortSignal.abort())).reason, "aborted");
  const first = await wait(c, [a]); assert.deepEqual(first.alerts.map((entry) => entry.message), ["A buffered"]);
  const one = wait(c, [a]), two = wait(c, [a]);
  ports[0].callbacks.alert("one publication");
  assert.deepEqual((await one).alerts.map((entry) => entry.message), ["one publication"]);
  let resolved = false; const completion = two.then((value) => { resolved = true; return value; });
  await tick(); assert.equal(resolved, false, "the loser keeps waiting on the same task");
  ports[0].finish("A"); assert.equal((await completion).reason, "done");
  assert.equal(c.view(a.run_id).pending_messages, 0);
  ports[1].finish("B"); await ended(c, b);
  assert.deepEqual((await read(c, b)).alerts.map((entry) => entry.message), ["B before wait"]);
});

test("a terminal any return can present alerts from all explicitly scoped Agents without losing control rows", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 16, resident_limit: 16 } });
  const runs = [];
  for (let index = 0; index < 16; index++) runs.push(await c.submit(`r${index}`, named(`r${index}`)));
  await until(() => ports.length === 16 && ports.every((port) => port.streaming));
  for (const port of ports) { port.callbacks.alert("first"); port.callbacks.alert("second"); }
  ports[0].finish("done"); await ended(c, runs[0]);
  const reply = await wait(c, runs, { mode: "any" });
  assert.equal(reply.reason, "done"); assert.equal(reply.agents.length, 16); assert.equal(reply.alerts.length, 32);
  assert.deepEqual(reply.pending, runs.slice(1).map((_, index) => `r${index + 1}`));
  assert.equal(reply.alerts_pending, 0);
  assert(runs.every((run) => c.view(run.run_id).pending_messages === 0));
});

test("pending questions remain level-triggered across concurrent and repeated publications", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 2 } });
  const a = await c.submit("a", named("a")), b = await c.submit("b", named("b"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const one = wait(c, [a, b]), two = wait(c, [a, b]);
  ports[0].callbacks.question("which option?"); ports[0].finish("please choose");
  for (const reply of await Promise.all([one, two])) {
    assert.equal(reply.reason, "question"); assert.equal(reply.agents[0].question, "which option?"); assert(reply.agents[0].question_id);
  }
  const again = await wait(c, [a, b], { wait_ms: 0 });
  assert.equal(again.reason, "question"); assert.deepEqual(again.pending, ["b"]);
  assert.equal((await wait(c, [b], { wait_ms: 0 })).reason, "timeout");
});

test("repeated asks validate then preserve the original full question", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("a")); await until(() => ports[0]?.streaming);
  const question = "Q".repeat(8190) + "🚀";
  assert.equal(ports[0].callbacks.question(question), "recorded");
  assert.equal(ports[0].callbacks.question("replacement?"), "already_recorded");
  for (const invalid of ["Q".repeat(8191) + "🚀", "Q".repeat(8193), " ", null])
    assert.throws(() => ports[0].callbacks.question(invalid), errorCode("INVALID_QUESTION"));
  ports[0].finish("please answer"); await ended(c, a);
  const reply = await read(c, a); assert.equal(reply.agents[0].question, question); assert.equal(reply.agents[0].question_truncated, undefined);
});

test("full Agent inbox rejects without evicting accepted alerts; stale callbacks cannot claim success", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("a")); await until(() => ports[0]?.streaming);
  const old = ports[0].callbacks;
  for (let index = 0; index < 16; index++) old.alert(`message ${index}`);
  assert.throws(() => old.alert("overflow"), (error) => error.code === "ALERT_QUEUE_FULL" && error.details.scope === "agent");
  assert.equal(c.view(a.run_id).pending_messages, 16); assert.equal(c.view(a.run_id).notification_drops, undefined);
  ports[0].finish("FINAL"); await ended(c, a);
  const reply = await read(c, a);
  assert.deepEqual(reply.alerts.map((entry) => entry.message), Array.from({ length: 16 }, (_, index) => `message ${index}`));
  assert.equal(reply.alerts_pending, 0); assert.equal(reply.agents[0].result, "FINAL");
  const b = await c.submit("b", { resume: a.agent_id, prompt: "b" }); await until(() => ports[0].calls.length === 2);
  assert.throws(() => old.alert("STALE"), errorCode("RUN_INPUT_CLOSED"));
  assert.throws(() => old.question("STALE?"), errorCode("RUN_INPUT_CLOSED"));
  assert.equal(c.view(b.run_id).pending_messages, 0);
});

test("new owner fault broadcasts to registered observers without requiring an unchanged reported marker", async (t) => {
  let starts = 0;
  const { controller: c, ports } = await fixture(t, { controller: { concurrency: 3 }, history: (point) => {
    if (point === "begin" && ++starts === 3) throw new ParentHistoryError("broadcast parent write unavailable");
  } });
  const a = await c.submit("a", named("a")), b = await c.submit("b", named("b"));
  await until(() => ports.length === 2 && ports.every((port) => port.streaming));
  const one = wait(c, [a]), two = wait(c, [b]);
  await c.submit("damaged", named("damaged"));
  const replies = await Promise.all([one, two]);
  assert.deepEqual(replies.map((reply) => reply.reason), ["owner_blocked", "owner_blocked"]);
  assert(replies.every((reply) => reply.agents[0].unavailable === true));
  assert.equal((await wait(c, [a, b], { wait_ms: 0 })).reason, "timeout");
  ports[0].callbacks.alert("A still running");
  assert.equal((await wait(c, [a])).reason, "alert", "accepted work can still communicate after a host history fault");
});

test("release preserves accepted alerts for Agent-scoped read or default Owner inbox", async (t) => {
  const { controller: c, ports } = await fixture(t);
  const a = await c.submit("a", named("a")); await until(() => ports[0]?.streaming);
  ports[0].callbacks.alert("recorded before release"); ports[0].finish("done"); await ended(c, a);
  assert.equal((await c.release(a.agent_id)).released, true); assert.equal(c.view(a.run_id).pending_messages, 1);
  const reply = await observe(c, { kind: "wait" });
  assert.equal(reply.reason, "alert"); assert.deepEqual(reply.agents, []);
  assert.deepEqual(reply.alerts.map((entry) => entry.message), ["recorded before release"]);
  assert.equal((await observe(c, { kind: "wait" })).reason, "nothing_pending");
});

for (const clean of [true, false]) test(`prequeued peers start during pending cleanup; later clean=${clean} keeps correct fault domain`, async (t) => {
  const hold = deferred(), entered = deferred();
  const { controller: c, ports, owner } = await fixture(t, { cleanupUncertainExpected: !clean });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].dispose = async () => { ports[0].disposed++; entered.resolve(); await hold.promise; return { shutdownExited: clean, errors: clean ? [] : ["synthetic cleanup timeout"] }; };
  t.after(() => hold.resolve());
  const b = await c.submit("b", task("b")); ports[0].finish("invalid facts", "invalid"); await entered.promise;
  await until(() => ports[1]?.streaming);
  assert.equal(c.stats().cleaning, 1); assert.equal(c.stats().active, 1); assert.equal(c.stats().resident, 2);
  assert.equal(c.runs.get(a.run_id).session, ports[0]);
  await assert.rejects(c.submit("reuse", { resume: a.agent_id, prompt: "reuse" }), errorCode("AGENT_BUSY"));
  const queued = await c.submit("queued", task("queued"));
  hold.resolve(); await until(() => c.view(a.run_id).phase === "settled");
  assert.equal(c.runs.get(a.run_id).session, undefined);
  assert.equal(c.stats().cleanup_uncertain, !clean); assert.equal(c.view(b.run_id).execution_exited, false);
  ports[1].finish("healthy peer"); await until(() => c.view(b.run_id).phase === "settled");
  if (clean) {
    await until(() => ports[2]?.streaming); ports[2].finish("healthy queue"); await ended(c, queued);
  } else {
    assert.equal(c.view(queued.run_id).status, "queued");
    await assert.rejects(c.submit("new", task("new")), errorCode("OWNER_CLEANUP_UNCERTAIN"));
    assert.equal((await c.shutdown(50)).closed, false); owner.assertHeld();
  }
});

for (const before of [63, 64]) test(`automatic soft budget has its own provenance and does not spend the ${before}-input quota`, async (t) => {
  const { controller: c, ports, events } = await fixture(t);
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => ports[0]?.streaming);
  for (let i = 0; i < before; i++) c.steer(a.run_id, `user ${i}`);
  ports[0].callbacks.turnEnd(true); ports[0].callbacks.turnEnd(true);
  await until(() => ports[0].inputs.includes(softBudgetMessage));
  if (before === 63) c.steer(a.run_id, "last user input");
  assert.throws(() => c.steer(a.run_id, "over quota"), errorCode("INPUT_LIMIT"));
  assert.equal(events.filter((e) => e.kind === "steer").length, 64);
  assert.equal(events.filter((e) => e.kind === "soft_budget").length, 1);
  assert.equal(ports[0].inputs.filter((s) => s === softBudgetMessage).length, 1);
});

test("thin results distinguish paging from retention omission and preserve actionable diagnostics", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 5 } });
  const a = await c.submit("a", named("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("0123456789"); await ended(c, a);
  const first = (await read(c, a, { max_chars: 2 })).agents[0];
  assert.equal(first.omitted_chars, 5); assert(first.next_cursor); assert.equal(first.truncated, undefined);
  const last = (await read(c, a, { cursor: first.next_cursor })).agents[0];
  assert.equal(first.result + last.result, "01234"); assert.equal(last.next_cursor, undefined); assert.equal(last.omitted_chars, 5);
  await c.release(a.agent_id);
  try { await c.submit("released", { resume: a.agent_id, prompt: "x" }); assert.fail(); }
  catch (error) { assert.equal(errorReply(error).error.reason, "explicitly_released"); }
  try { await c.submit("unsupported", { ...task("x"), wait: true }); assert.fail(); }
  catch (error) { assert(errorReply(error).error.allowed.includes("prompt")); assert.equal(errorReply(error).error.parameter, "wait"); }
  assert.equal(errorReply({ code: "OWNER_PARENT_UNAVAILABLE", details: { error: "x".repeat(1000), secret_fixture: "hidden" } }).error.message.length, 512);
  assert.equal(taskReply(c.view(a.run_id), namesOf(c)).unavailable, true);
});
