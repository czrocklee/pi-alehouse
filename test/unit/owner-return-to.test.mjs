import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { boundedOutput } from "../../dist/orchestration/core/result-text.js";
import { questionId } from "../../dist/orchestration/core/question-id.js";
import { encodeResultCursor } from "../../dist/orchestration/core/result-cursor.js";
import { OrchestrationError } from "../../dist/orchestration/core/ports.js";
import {
  FakePort,
  deferred,
  ended,
  errorCode,
  fixture,
  settings,
  task,
  tick,
  until,
} from "../support/controller-fixture.mjs";

// Real Owner/FIFO/lease with synthetic ports only; no SDK/provider or release evidence.
const scoutSettings = { ...settings, profile: "researcher" };
const observe = async (c, request, options = {}) =>
  JSON.parse((await c.observe(request, { validate() {}, ...options })).content[0].text);
const action = (c, source, wait_ms = 0, options) =>
  observe(
    c,
    { kind: "action", run_id: source.run_id, action: { type: "agent_spawn" }, wait_ms },
    options,
  );
const read = (c, run, extra = {}) => observe(c, { kind: "read", agent_id: run.agent_id, ...extra });
const wait = (c, agent_ids, extra = {}) =>
  observe(c, { kind: "wait", agent_ids, wait_ms: 0, ...extra });
async function portFor(f, run) {
  await until(() =>
    f.ports.some((port) => port.streaming && port.calls.at(-1)?.identity.run_id === run.run_id),
  );
  return f.ports.find((port) => port.calls.at(-1)?.identity.run_id === run.run_id);
}
async function asking(f, rest = {}) {
  const run = await f.controller.submit(
    "worker-question",
    task("original worker task", { name: "cedar", max_turns: 7, ...rest }),
  );
  const port = await portFor(f, run);
  port.callbacks.question("Which evidence should I use?");
  port.finish("waiting for parent");
  await ended(f.controller, run);
  return { run, port, token: f.controller.view(run.run_id).question_id };
}
function sourceTask(q, rest = {}) {
  return task("collect cited evidence", {
    name: "pine",
    settings: scoutSettings,
    return_to: {
      agent_id: q.run.agent_id,
      question_id: q.token,
      answer: "Use the scout evidence to finish the original task.",
    },
    ...rest,
  });
}
const admit = (f, q, rest = {}, id = "compound") => f.controller.submit(id, sourceTask(q, rest));
function graph(f) {
  const c = f.controller;
  return {
    sequence: c.sequence,
    queue: [...c.queue],
    requests: [...c.requests],
    records: [...c.runs.values()].map((run) => structuredClone(run.record)),
    claims: [...c.claims].map((claim) => ({
      run_id: claim.run_id,
      agent_id: claim.agent_id,
      prepared: structuredClone(claim.prepared),
    })),
    agents: [...c.agents.values()].map((agent) => ({
      id: agent.id,
      current: agent.current,
      question: structuredClone(agent.question),
      resident: agent.resident,
      inbox: [...agent.inbox],
    })),
    output: [c.retainedOutputChars, c.reservedOutputChars],
    events: f.events.length,
    calls: f.ports.map((port) => port.calls.length),
  };
}
function prepared(declaration, { cwd }) {
  const path = (value) => ({ path: resolve(cwd, value), canonical: resolve(cwd, value) });
  return {
    declaration,
    inputs: (declaration.inputs ?? []).map(path),
    ownership: (declaration.ownership ?? []).map(path),
    ...(declaration.tree ? { tree: path(declaration.tree) } : {}),
  };
}

async function finishPair(f, source, text = "SCOUT_PRIVATE_RESULT") {
  const scout = await portFor(f, source);
  scout.finish(text);
  await ended(f.controller, source);
  const continuation = f.controller.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  worker.finish("worker final answer");
  await ended(f.controller, continuation);
  return { scout, continuation, worker };
}
const notices = {
  pending: "Result from pine is assigned to cedar (task 2); handoff is pending.",
  delivered: "Result from pine has been returned to cedar (task 2).",
  not_delivered:
    'Result from pine was not returned to cedar (task 2): the worker continuation ended before receiving input; agent_read({ agent: "pine", task: 1 }) shows the result.',
};
function notice(row, state = "delivered") {
  assert.equal(row.result, notices[state]);
  for (const field of [
    "result_notice",
    "result_omitted",
    "result_truncated",
    "next_cursor",
    "lost_chars",
  ])
    assert(!Object.hasOwn(row, field), `${field} must not describe a notice`);
}
// An explicit read of an undelivered handoff returns the real retained page.
function retained(row, text) {
  assert.equal(row.result, text);
  assert.notEqual(row.result, notices.not_delivered);
}

test("compound acceptance installs two exact Runs; only the worker completes it; handoff is outside approval witness", async (t) => {
  const f = await fixture(t, { controller: { resident_limit: 2 } }),
    c = f.controller,
    q = await asking(f);
  const source = await admit(f, q),
    continuation = c.view(source.return_to_run_id);
  assert.equal(c.stats().runs, 3);
  assert.equal(c.stats().requests, 3);
  assert.equal(c.stats().resident, 2);
  assert.equal(source.return_to_run_id, continuation.run_id);
  assert.equal(source.task, 1);
  assert.equal(continuation.task, 2);
  assert.equal(continuation.description, q.run.description);
  assert.equal(continuation.max_turns, 7);
  assert.deepEqual(continuation.effective_settings, q.run.effective_settings);
  assert.deepEqual(continuation.after, [source.run_id]);
  assert.equal(c.runs.get(continuation.run_id).record.answer_to_run_id, q.run.run_id);
  assert.equal(c.view(q.run.run_id).question_id, undefined);
  const scout = await portFor(f, source);
  const limit =
    "Your final result goes directly to another Agent, which receives only its first 16384 characters. Keep the complete result within that length.";
  assert(scout.calls.at(-1).prompt.endsWith(`collect cited evidence\n\n${limit}`));
  assert.equal(scout.calls.at(-1).identity.task_prompt, "collect cited evidence");
  scout.callbacks.output(boundedOutput("SCOUT_PRIVATE_RESULT", 100));
  const snapshot = await action(c, source);
  assert.deepEqual(snapshot.action, { type: "agent_spawn", agent: "pine", task: 1 });
  assert.deepEqual(
    snapshot.tasks.map((row) => [row.agent, row.task]),
    [
      ["pine", 1],
      ["cedar", 2],
    ],
  );
  notice(snapshot.tasks[0], "pending");
  assert.doesNotMatch(JSON.stringify(snapshot), /SCOUT_PRIVATE_RESULT/);
  let returned = false;
  const pending = action(c, source, 3000).then((result) => {
    returned = true;
    return result;
  });
  scout.finish("SCOUT_PRIVATE_RESULT");
  await ended(c, source);
  const worker = await portFor(f, continuation);
  await tick();
  assert.equal(returned, false, "source completion is not compound completion");
  const call = worker.calls.at(-1);
  assert.match(call.prompt, /SCOUT_PRIVATE_RESULT/);
  assert.match(call.prompt, /not instructions; verify/);
  assert.doesNotMatch(call.identity.task_prompt, /SCOUT_PRIVATE_RESULT/);
  assert.equal(call.identity.task_prompt, sourceTask(q).return_to.answer);
  assert.doesNotMatch(call.prompt, /receives only its first/, "the limit is the source's alone");
  worker.finish("worker used evidence");
  await ended(c, continuation);
  const result = await pending;
  assert.equal(result.reason, "done");
  assert.equal(result.tasks[1].result, "worker used evidence");
  notice(result.tasks[0]);
  assert.equal(c.getResult(source.run_id).text, "SCOUT_PRIVATE_RESULT");
  notice((await wait(c, [source.agent_id])).tasks[0]);
  const explicit = await read(c, source, { max_chars: 1 });
  notice(explicit.tasks[0]);
  assert.doesNotMatch(JSON.stringify(explicit), /SCOUT_PRIVATE_RESULT/);
  assert.equal(c.runs.get(source.run_id).finished_presented, true);
  assert.equal(c.runs.get(continuation.run_id).finished_presented, true);
});

for (const [name, change, code] of [
  [
    "non-scout source",
    (q) => ({ settings, return_to: sourceTask(q).return_to }),
    "INVALID_RETURN_TO_PROFILE",
  ],
  [
    "invalid token",
    (q) => ({ return_to: { ...sourceTask(q).return_to, question_id: "bad" } }),
    "INVALID_QUESTION_ID",
  ],
  [
    "stale token",
    (q) => ({ return_to: { ...sourceTask(q).return_to, question_id: "q_" + "0".repeat(32) } }),
    "STALE_ANSWER",
  ],
  [
    "blank answer",
    (q) => ({ return_to: { ...sourceTask(q).return_to, answer: "  " } }),
    "INVALID_ANSWER",
  ],
  [
    "oversized answer",
    (q) => ({ return_to: { ...sourceTask(q).return_to, answer: "x".repeat(16385) } }),
    "INVALID_ANSWER",
  ],
  [
    "extra return field",
    (q) => ({ return_to: { ...sourceTask(q).return_to, after: [] } }),
    "INVALID_RETURN_TO",
  ],
])
  test(`planning rejects ${name} without allocating, reserving or notifying`, async (t) => {
    const f = await fixture(t),
      q = await asking(f),
      before = graph(f);
    await assert.rejects(admit(f, q, change(q)), errorCode(code));
    assert.deepEqual(graph(f), before);
    assert.equal(f.controller.view(q.run.run_id).question_id, q.token);
  });

for (const [name, limits, code] of [
  ["both queue entries", { queue_limit: 1 }, "QUEUE_FULL"],
  ["both history entries", { history_run_limit: 2 }, "OWNER_HISTORY_LIMIT"],
  [
    "both output reservations",
    { output_chars: 64, history_output_chars: 128 },
    "OWNER_HISTORY_LIMIT",
  ],
  ["new resident only", { resident_limit: 1 }, "RESIDENT_LIMIT"],
])
  test(`projected budget checks ${name} before any mutation`, async (t) => {
    const f = await fixture(t, { controller: limits }),
      q = await asking(f),
      before = graph(f);
    await assert.rejects(admit(f, q), errorCode(code));
    assert.deepEqual(graph(f), before);
  });

test("return_to refusals precede shared capacity; QUEUE_FULL names the two-entry need", async (t) => {
  const f = await fixture(t, { controller: { queue_limit: 1 } }),
    q = await asking(f),
    before = graph(f);
  for (const [change, code] of [
    [
      { return_to: { ...sourceTask(q).return_to, question_id: "q_" + "0".repeat(32) } },
      "STALE_ANSWER",
    ],
    [{ settings }, "INVALID_RETURN_TO_PROFILE"],
    [{ return_to: { ...sourceTask(q).return_to, answer: " " } }, "INVALID_ANSWER"],
  ]) {
    await assert.rejects(admit(f, q, change), errorCode(code));
    assert.deepEqual(graph(f), before);
  }
  await assert.rejects(
    admit(f, q),
    (error) => error.code === "QUEUE_FULL" && /two tasks/.test(error.details.resolution),
  );
  assert.deepEqual(graph(f), before);
});

test("continuation turn limit matches agent_answer: the Agent's fixed limit, not the asking task's override", async (t) => {
  const f = await fixture(t),
    c = f.controller;
  const first = await c.submit("worker-first", task("first", { name: "cedar", max_turns: 7 }));
  (await portFor(f, first)).finish("done");
  await ended(c, first);
  const asked = await c.submit("worker-override", {
      resume: first.agent_id,
      prompt: "override",
      max_turns: 50,
    }),
    port = await portFor(f, asked);
  port.callbacks.question("which evidence?");
  port.finish("waiting");
  await ended(c, asked);
  assert.equal(c.view(asked.run_id).max_turns, 50);
  const source = await admit(f, { run: asked, port, token: c.view(asked.run_id).question_id });
  assert.equal(c.view(source.return_to_run_id).max_turns, 7);
  await finishPair(f, source);
});

test("target must already be a settled healthy editor question, not a busy/future or scout question", async (t) => {
  const f = await fixture(t),
    c = f.controller;
  const run = await c.submit("worker-question", task("question still running", { name: "cedar" })),
    port = await portFor(f, run);
  port.callbacks.question("not settled yet");
  const q = { run, token: questionId(c.identity.owner_id, c.identity.generation, run.run_id) },
    before = graph(f);
  await assert.rejects(admit(f, q), errorCode("STALE_ANSWER"));
  assert.deepEqual(graph(f), before);
  port.finish("waiting");
  await ended(c, run);
  await c.kill(run.agent_id, 1000);
  const killed = graph(f);
  await assert.rejects(admit(f, q), errorCode("STALE_ANSWER"));
  assert.deepEqual(graph(f), killed);
  const scoutQuestion = await c.submit(
    "scout-question",
    task("scout asks", { name: "birch", settings: scoutSettings }),
  );
  const scout = await portFor(f, scoutQuestion);
  scout.callbacks.question("scout question");
  scout.finish("waiting");
  await ended(c, scoutQuestion);
  const beforeScout = graph(f);
  await assert.rejects(
    admit(f, { run: scoutQuestion, token: c.view(scoutQuestion.run_id).question_id }),
    (error) =>
      error.code === "INVALID_RETURN_TO_PROFILE" &&
      error.details.key === "return_to" &&
      error.details.agent_id === scoutQuestion.agent_id &&
      /agent_answer/.test(error.details.resolution),
  );
  assert.deepEqual(graph(f), beforeScout);
  await assert.rejects(
    c.submit("run-return", {
      resume: scoutQuestion.agent_id,
      prompt: "no",
      return_to: sourceTask(q).return_to,
    }),
    errorCode("UNSUPPORTED_PARAMETER"),
  );
});

test("competing compound requests reserve one exact question only once", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f);
  const [first, second] = await Promise.allSettled([
    admit(f, q),
    admit(f, q, { name: "birch" }, "competing"),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "STALE_ANSWER");
  assert.equal(c.stats().runs, 3);
  assert.equal(c.stats().agents, 2);
  assert.equal(c.findAgent("birch"), undefined);
  assert.equal(c.view(q.run.run_id).question_id, undefined);
  await finishPair(f, first.value);
});

test("already-uncompleted source predecessor rejects without allocating the pair", async (t) => {
  const f = await fixture(t),
    q = await asking(f),
    before = graph(f);
  await assert.rejects(
    admit(f, q, { after: [q.run.run_id] }),
    errorCode("DEPENDENCY_NOT_COMPLETED"),
  );
  assert.deepEqual(graph(f), before);
});

test("Off transition during second-plan preflight rejects both admissions", async (t) => {
  let admission = { enabled: true, revision: 0 },
    disable = false;
  const f = await fixture(t, {
      controller: {
        admission: () => admission,
        dispatch: {
          prepare(declaration, context) {
            if (disable && context.profile === "editor" && context.deferInputs)
              admission = { enabled: false, revision: 1 };
            return prepared(declaration, context);
          },
        },
      },
    }),
    q = await asking(f, { dispatch: { ownership: ["owned"] } });
  const before = graph(f);
  disable = true;
  await assert.rejects(admit(f, q), errorCode("DELEGATION_OFF"));
  assert.deepEqual(graph(f), before);
});

test("second-plan preflight failure and live Off transition precede resident capacity without touching question/claim", async (t) => {
  let fail = false,
    flipOff = false,
    reenter,
    f;
  const admission = { enabled: true, revision: 1 };
  f = await fixture(t, {
    controller: {
      resident_limit: 1,
      admission: () => ({ ...admission }),
      dispatch: {
        prepare(declaration, context) {
          if (flipOff && context.profile === "editor" && context.deferInputs) {
            admission.enabled = false;
            admission.revision++;
          }
          if (fail && context.profile === "editor" && context.deferInputs) {
            if (reenter) {
              try {
                reenter();
              } catch {
                /* guard must remember swallowed violation */
              }
            } else throw new OrchestrationError("PREFLIGHT_DENIED");
          }
          return prepared(declaration, context);
        },
      },
    },
  });
  const q = await asking(f, { dispatch: { ownership: ["owned"] } });
  flipOff = true;
  let before = graph(f);
  await assert.rejects(admit(f, q), errorCode("DELEGATION_OFF"));
  assert.deepEqual(graph(f), before);
  flipOff = false;
  admission.enabled = true;
  admission.revision++;
  fail = true;
  before = graph(f);
  await assert.rejects(admit(f, q), errorCode("PREFLIGHT_DENIED"));
  assert.deepEqual(graph(f), before);
  reenter = () => f.controller.cancel(q.run.run_id);
  before = graph(f);
  await assert.rejects(admit(f, q), errorCode("OBSERVATION_REENTRANCY"));
  assert.deepEqual(graph(f), before);
});

test("compound RESIDENT_LIMIT offers only finished non-asking Agents, preserves the question token, and replays after release", async (t) => {
  const f = await fixture(t, { controller: { resident_limit: 2, concurrency: 2 } }),
    c = f.controller,
    q = await asking(f);
  const done = await c.submit("done-peer", task("done", { name: "birch" }));
  const donePort = await portFor(f, done);
  donePort.finish("finished");
  await ended(c, done);
  const input = sourceTask(q);
  const before = graph(f);
  await assert.rejects(
    c.submitPrepared("compound-full", input, (request) => request),
    (error) => {
      assert.equal(error.code, "RESIDENT_LIMIT");
      assert.deepEqual(error.details.releasable_agent_ids, [done.agent_id]);
      return true;
    },
  );
  assert.deepEqual(graph(f), before);
  assert.equal(c.view(q.run.run_id).question_id, q.token);
  assert.equal((await c.kill(done.agent_id)).state, "released");
  const accepted = await c.submitPrepared("compound-full", input, (request) => request);
  const replay = await c.submitPrepared("compound-full", input, () => {
    throw new Error("must not re-prepare accepted compound request");
  });
  assert.equal(replay.run_id, accepted.run_id);
  assert.equal(replay.return_to_run_id, accepted.return_to_run_id);
  await finishPair(f, accepted);
});

test("claim/tree lineage is inherited, reservation retained, then restored with the same lease on scout failure", async (t) => {
  let acquired = 0,
    closed = 0;
  const lease = {
    assertHeld() {},
    close() {
      closed++;
    },
  };
  const f = await fixture(t, {
    controller: {
      dispatch: {
        prepare: prepared,
        async start(_declaration, context) {
          if (context.acquireTree) {
            acquired++;
            return { lease };
          }
          return {};
        },
      },
    },
  });
  const c = f.controller,
    dispatch = { inputs: ["input"], ownership: ["owned"], tree: "build", checks: ["focused"] };
  const q = await asking(f, { dispatch }),
    claim = c.runs.get(q.run.run_id).claim;
  const source = await admit(f, q),
    continuation = c.view(source.return_to_run_id);
  assert.deepEqual(continuation.dispatch, dispatch);
  assert.equal(c.runs.get(continuation.run_id).claim, claim);
  assert.equal(claim.run_id, continuation.run_id);
  assert.equal(claim.lease, lease);
  const scout = await portFor(f, source);
  scout.finish("failed research", "error", "synthetic failure");
  await ended(c, source);
  await ended(c, continuation);
  assert.equal(c.view(continuation.run_id).outcome.reason, "dependency_not_completed");
  assert.equal(c.view(q.run.run_id).question_id, q.token);
  assert.equal(q.port.calls.length, 1);
  assert.equal(claim.run_id, q.run.run_id);
  assert.equal(claim.lease, lease);
  assert.equal(acquired, 1);
  assert.equal(closed, 0);
  await assert.rejects(
    c.submit(
      "conflicting",
      task("other claim", { name: "oak", dispatch: { ownership: ["owned"] } }),
    ),
    errorCode("RESOURCE_OWNED"),
  );
  const retry = await c.answer("fresh-answer", q.run.agent_id, q.token, "finish without research");
  const worker = await portFor(f, retry);
  worker.finish("finished");
  await ended(c, retry);
  assert.equal(acquired, 1);
  assert.equal(closed, 1);
});

test("source claim conflict and inherited target resource drift reject the whole pair", async (t) => {
  let drift = false;
  const f = await fixture(t, {
      controller: {
        dispatch: {
          prepare(declaration, context) {
            const result = prepared(declaration, context);
            if (drift && context.profile === "editor" && context.deferInputs)
              result.ownership[0].canonical += "/changed";
            return result;
          },
        },
      },
    }),
    q = await asking(f, { dispatch: { ownership: ["owned"] } });
  let before = graph(f);
  await assert.rejects(
    admit(f, q, { dispatch: { ownership: ["owned"] } }),
    errorCode("RESOURCE_OWNED"),
  );
  assert.deepEqual(graph(f), before);
  drift = true;
  before = graph(f);
  await assert.rejects(admit(f, q), errorCode("DISPATCH_RESOURCE_CHANGED"));
  assert.deepEqual(graph(f), before);
});

test("scout's own after is staged transitively and the worker follows only the new scout", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }),
    c = f.controller;
  const predecessor = await c.submit("predecessor", task("earlier research", { name: "oak" })),
    predecessorPort = await portFor(f, predecessor);
  const q = await asking(f),
    source = await admit(f, q, { after: [predecessor.run_id] }),
    continuation = c.view(source.return_to_run_id);
  assert.equal(source.status, "queued");
  assert.deepEqual(source.after, [predecessor.run_id]);
  assert.deepEqual(continuation.after, [source.run_id]);
  predecessorPort.finish("earlier result");
  await ended(c, predecessor);
  const scout = await portFor(f, source);
  assert.match(scout.calls[0].prompt, /earlier result/);
  await finishPair(f, source);
});

for (const failure of ["failed", "needs_input", "interrupted"])
  test(`scout ${failure} fails dependent pre-input; the bound reply waits for that settlement and the token reopens`, async (t) => {
    const f = await fixture(t),
      c = f.controller,
      q = await asking(f),
      source = await admit(f, q),
      scout = await portFor(f, source);
    // Registered before the scout settles: the reply must never show a doomed worker as still queued.
    const pending = action(c, source, 3000);
    if (failure === "needs_input") scout.callbacks.question("Need a source decision?");
    if (failure === "interrupted") c.cancel(source.run_id);
    scout.finish(
      "partial untrusted research",
      failure === "failed" ? "error" : failure === "interrupted" ? "aborted" : "success",
    );
    const result = await pending,
      continuation = c.view(source.return_to_run_id);
    assert.equal(result.reason, "task_issue");
    assert.equal(result.tasks[1].status, "failed");
    assert.match(result.tasks[1].error, /^DEPENDENCY_NOT_COMPLETED: pine \(/);
    assert.equal(c.view(continuation.run_id).outcome.reason, "dependency_not_completed");
    assert.equal(q.port.calls.length, 1);
    assert.equal(c.view(q.run.run_id).question_id, q.token);
    notice(result.tasks[0], "not_delivered");
    const explicit = (await read(c, source, { max_chars: 1 })).tasks[0];
    retained(explicit, "p");
    assert.equal(typeof explicit.next_cursor, "string");
    assert.equal(c.getResult(source.run_id).text, "partial untrusted research");
    if (failure === "needs_input") {
      assert.equal(result.tasks[0].question, "Need a source decision?");
      assert.match(result.tasks[0].question_id, /^q_/);
      assert.equal(explicit.question, result.tasks[0].question);
      assert.equal(explicit.question_id, result.tasks[0].question_id);
    }
  });

test("a turn-limited but completed scout hands off and does not end the compound wait early", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q, { max_turns: 1 }),
    scout = await portFor(f, source);
  let returned = false;
  const pending = action(c, source, 3000).then((result) => {
    returned = true;
    return result;
  });
  scout.callbacks.turnEnd(true);
  scout.finish("limited research");
  await ended(c, source);
  assert.equal(c.view(source.run_id).status, "completed");
  assert.equal(c.view(source.run_id).outcome.limit_reached, true);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  await tick();
  assert.equal(returned, false, "scout limit is not a compound task issue");
  assert.match(worker.calls.at(-1).prompt, /turn limit reached/);
  worker.finish("worker done");
  await ended(c, continuation);
  const result = await pending;
  assert.equal(result.reason, "done");
  assert.equal(result.tasks[1].status, "completed");
  assert.equal(result.tasks[0].limit_reached, true);
  notice(result.tasks[0]);
});

test("worker pre-input cancellation and kill leave a sticky not-delivered notice; only an explicit read returns the source result", async (t) => {
  const f = await fixture(t, { controller: { output_chars: 8, history_output_chars: 1024 } }),
    c = f.controller,
    q = await asking(f);
  const source = await admit(f, q),
    continuation = c.view(source.return_to_run_id),
    scout = await portFor(f, source);
  assert.equal(source.return_to_run_id, continuation.run_id);
  c.cancel(continuation.run_id);
  await ended(c, continuation);
  assert.equal(c.view(q.run.run_id).question_id, q.token);
  assert.equal(scout.stopped, 0);
  assert.equal(scout.streaming, true);
  await c.kill(q.run.agent_id, 1000);
  scout.finish("abcdefghNEVER_RETAINED");
  await ended(c, source);
  const sent = await c.send("source-send", source.agent_id, "parent follow-up");
  const sendReply = await observe(c, {
    kind: "action",
    run_id: sent.view.run_id,
    action: { type: "agent_send", delivery: sent.delivery },
    wait_ms: 0,
  });
  for (const result of [
    await action(c, source),
    await wait(c, [source.agent_id]),
    await wait(c, [source.agent_id], { mode: "any" }),
    sendReply,
  ]) {
    notice(
      result.tasks.find((row) => row.agent === "pine"),
      "not_delivered",
    );
    assert.doesNotMatch(JSON.stringify(result), /abcdefgh|NEVER_RETAINED/);
  }
  const explicit = await read(c, source, { task: source.task, max_chars: 1 });
  retained(explicit.tasks[0], "a");
  assert.doesNotMatch(JSON.stringify(explicit), /NEVER_RETAINED/);
  assert.equal(c.getResult(source.run_id).text, "abcdefgh");
  const raw = c.getResult(source.run_id);
  assert.equal(raw.total_chars - raw.retained_chars, 14);
  assert.equal(c.view(source.run_id).return_to_run_id, continuation.run_id);
});

test("default and explicit waits, actions, sends and reads replace live and final source bodies with notices", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q),
    scout = await portFor(f, source);
  scout.callbacks.output(boundedOutput("private live preview", 100));
  const sent = await c.send("live-send", source.agent_id, "continue collecting");
  const sendReply = await observe(c, {
    kind: "action",
    run_id: sent.view.run_id,
    action: { type: "agent_send", delivery: sent.delivery },
    wait_ms: 0,
  });
  for (const result of [
    await wait(c),
    await wait(c, [source.agent_id]),
    await action(c, source),
    await read(c, source),
    await read(c, source, { task: source.task, max_chars: 1 }),
    sendReply,
  ]) {
    notice(
      result.tasks.find((row) => row.agent === "pine"),
      "pending",
    );
    assert.doesNotMatch(JSON.stringify(result), /private live preview/);
  }
  const bound = wait(c, undefined, { wait_ms: 3000 });
  scout.finish("private live preview");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  worker.finish("done");
  await ended(c, continuation);
  notice((await bound).tasks.find((row) => row.agent === "pine"));
  notice((await read(c, source, { max_chars: 1 })).tasks[0]);
});

test("a delivered handoff that omitted retained text says so; only an explicit read pages the full result", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  const tail = "CRITICAL_TAIL_CITATION",
    text = "x".repeat(16384) + tail;
  (await portFor(f, source)).finish(text);
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  const prompt = worker.calls.at(-1).prompt;
  assert.match(prompt, new RegExp(`\\[${tail.length} characters omitted\\]`));
  assert.doesNotMatch(prompt, new RegExp(tail));
  worker.finish("worker done");
  await ended(c, continuation);
  assert.equal(c.runs.get(continuation.run_id).record.input_entered, true);
  await tick();
  assert.equal(c.agents.get(source.agent_id).resident, true, "a cut result stays for the parent");
  assert.equal(c.agents.get(source.agent_id).unavailable, undefined);
  const partial = `Result from pine has been returned to cedar (task 2), but the handoff omitted its last ${tail.length} characters; agent_read({ agent: "pine", task: 1 }) shows the retained result.`;
  for (const result of [await action(c, source), await wait(c, [source.agent_id])]) {
    assert.equal(result.tasks.find((row) => row.agent === "pine").result, partial);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(tail));
  }
  await c.kill(source.agent_id, 1000);
  let row = (await read(c, source, { task: 1 })).tasks[0],
    paged = row.result,
    pages = 1;
  while (row.next_cursor && pages < 20) {
    row = (await read(c, source, { cursor: row.next_cursor })).tasks[0];
    paged += row.result;
    pages++;
  }
  assert(pages > 1, "the full result needs a cursor page");
  assert.equal(paged, text);
  assert.equal(
    c.view(source.return_to_run_id).run_id,
    continuation.run_id,
    "the sticky link is unchanged",
  );
});

test("output beyond the retention cap is a cut handoff: the scout stays for the parent", async (t) => {
  const f = await fixture(t, { controller: { output_chars: 8, history_output_chars: 1024 } }),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  (await portFor(f, source)).finish("abcdefghNEVER_RETAINED");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  const prompt = worker.calls.at(-1).prompt;
  assert.match(prompt, /abcdefgh\n\[14 characters omitted\]/);
  worker.finish("worker done");
  await ended(c, continuation);
  await tick();
  assert.equal(c.agents.get(source.agent_id).resident, true, "a cut result stays for the parent");
  assert.equal(c.agents.get(source.agent_id).unavailable, undefined);
  const row = (await action(c, source)).tasks.find((task) => task.agent === "pine");
  assert.equal(
    row.result,
    'Result from pine has been returned to cedar (task 2), but the handoff omitted its last 14 characters; agent_read({ agent: "pine", task: 1 }) shows the retained result.',
  );
  await c.kill(source.agent_id, 1000);
});

test("a fully attached handoff stays a notice even for explicit and cursor reads", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  const text = "x".repeat(16384);
  await finishPair(f, source, text);
  notice((await read(c, source, { task: 1 })).tasks[0]);
  const cursor = c.getResult(source.run_id, { limit: 1 }).next_cursor;
  notice((await read(c, source, { cursor, max_chars: 1 })).tasks[0]);
});

test("notice cursor reads retain raw identity, version, range and surrogate checks without consuming alerts on rejection", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  const scout = await portFor(f, source),
    text = "a😀z_PRIVATE_SOURCE";
  scout.callbacks.alert("source alert remains ordinary communication");
  const { continuation } = await finishPair(f, source, text);
  const identity = {
    owner: c.identity.owner_id,
    generation: c.identity.generation,
    run: source.run_id,
    version: c.view(source.run_id).result_ref.digest,
  };
  const coreCursor = c.getResult(source.run_id, { limit: 1 }).next_cursor;
  assert.match(coreCursor, /^r1_/);
  const unsupported = Buffer.from(
    JSON.stringify({
      owner: identity.owner,
      run: identity.run,
      version: identity.version,
      offset: 1,
    }),
  ).toString("base64url");
  const invalid = [
    "not-a-cursor",
    ...["owner", "generation", "run", "version"].map((field) =>
      encodeResultCursor({ ...identity, [field]: "different" }, 0),
    ),
    encodeResultCursor(identity, text.length + 1),
    encodeResultCursor(identity, 2),
    unsupported,
  ];
  for (const cursor of invalid) {
    const alerts = [...c.alerts];
    await assert.rejects(read(c, source, { cursor, max_chars: 1 }), errorCode("INVALID_CURSOR"));
    assert.deepEqual(c.alerts, alerts);
    assert.equal(c.runs.get(source.run_id).finished_presented, false);
    assert.equal(c.runs.get(continuation.run_id).finished_presented, false);
    assert.equal(c.stats().internal_error, undefined);
  }
  await assert.rejects(
    read(c, continuation, { cursor: encodeResultCursor(identity, 0) }),
    errorCode("INVALID_CURSOR"),
  );
  assert.equal(c.alerts.length, 1);
  for (const cursor of [
    encodeResultCursor(identity, 0),
    encodeResultCursor(identity, 1),
    encodeResultCursor(identity, 3),
    encodeResultCursor(identity, text.length),
    coreCursor,
  ]) {
    const result = await read(c, source, { cursor, max_chars: 1 });
    assert.equal(result.tasks[0].task, 1);
    notice(result.tasks[0]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE/);
    if (cursor === encodeResultCursor(identity, 0))
      assert.deepEqual(
        result.alerts.map((row) => row.message),
        ["source alert remains ordinary communication"],
      );
  }
  assert.equal(c.alerts.length, 0);
  assert.equal(
    c.getResult(source.run_id, { cursor: encodeResultCursor(identity, 1), limit: 1 }).text,
    "😀",
  );
});

test("handoff stays pending through source finalization, worker capacity and worker initialization; journal and prompt stay raw", async (t) => {
  const sourceHistory = deferred(),
    initialization = deferred(),
    marker = "RAW_JOURNAL_AND_WORKER_INPUT";
  let continuationId,
    initializing = false,
    journalText;
  const f = await fixture(t, {
    beforeShutdown: () => {
      sourceHistory.resolve();
      initialization.resolve();
    },
    history: async (kind, record, output) => {
      if (kind === "finish" && output.text === marker) {
        journalText = output.text;
        await sourceHistory.promise;
      }
      if (kind === "begin" && record.run_id === continuationId) {
        initializing = true;
        await initialization.promise;
      }
    },
  });
  const c = f.controller,
    q = await asking(f),
    source = await admit(f, q),
    scout = await portFor(f, source);
  continuationId = source.return_to_run_id;
  const blocker = await c.submit(
    "capacity-blocker",
    task("occupy the freed slot", { name: "oak" }),
  );
  scout.finish(marker);
  const blockerPort = await portFor(f, blocker);
  await until(() => journalText === marker);
  assert.equal(c.view(source.run_id).finalization_pending, true);
  assert.equal(c.view(continuationId).queued_for, "dependencies");
  notice((await read(c, source, { max_chars: 1 })).tasks[0], "pending");
  sourceHistory.resolve();
  await ended(c, source);
  assert.equal(c.view(continuationId).queued_for, "capacity");
  notice((await action(c, source)).tasks[0], "pending");
  blockerPort.finish("blocker done");
  await ended(c, blocker);
  await until(() => initializing);
  assert.equal(c.runs.get(continuationId).record.input_entered, false);
  notice((await wait(c, [source.agent_id])).tasks[0], "pending");
  notice((await read(c, source, { task: 1, max_chars: 1 })).tasks[0], "pending");
  initialization.resolve();
  const continuation = c.view(continuationId),
    worker = await portFor(f, continuation);
  assert.equal(c.runs.get(continuationId).record.input_entered, true);
  assert.match(worker.calls.at(-1).prompt, new RegExp(marker));
  notice((await read(c, source, { max_chars: 1 })).tasks[0]);
  worker.finish("normal worker output");
  await ended(c, continuation);
  assert.equal((await read(c, continuation)).tasks[0].result, "normal worker output");
  assert.equal(journalText, marker);
  assert.equal(c.getResult(source.run_id).text, marker);
});

test("execution-exited finalizing continuation without observed input is already not-delivered", async (t) => {
  const finalization = deferred();
  const f = await fixture(t, {
    beforeShutdown: () => finalization.resolve(),
    history: async (kind, _record, output) => {
      if (kind === "finish" && output.text === "pre-input worker failure")
        await finalization.promise;
    },
  });
  const c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  const originalRun = q.port.run.bind(q.port);
  q.port.run = (prompt, callbacks, identity) =>
    originalRun(prompt, { ...callbacks, inputEntered() {} }, identity);
  (await portFor(f, source)).finish("raw source stays private");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  notice((await read(c, source)).tasks[0], "pending");
  worker.finish("pre-input worker failure", "error", "synthetic pre-input error");
  await until(() => c.view(continuation.run_id).finalization_pending);
  assert.equal(c.runs.get(continuation.run_id).record.input_entered, false);
  assert.equal(c.view(continuation.run_id).execution_exited, true);
  retained((await read(c, source, { max_chars: 1 })).tasks[0], "r");
  notice((await action(c, source)).tasks[0], "not_delivered");
  finalization.resolve();
  await ended(c, continuation);
  retained((await read(c, source)).tasks[0], "raw source stays private");
});

for (const outcome of ["failed", "interrupted", "killed"])
  test(`observed worker input stays delivered after worker ${outcome} and Off`, async (t) => {
    let admission = { enabled: true, revision: 0 };
    const f = await fixture(t, { controller: { admission: () => admission } }),
      c = f.controller,
      q = await asking(f);
    const source = await admit(f, q);
    (await portFor(f, source)).finish("raw source evidence");
    await ended(c, source);
    const continuation = c.view(source.return_to_run_id),
      worker = await portFor(f, continuation);
    assert.equal(c.runs.get(continuation.run_id).record.input_entered, true);
    notice((await read(c, source)).tasks[0]);
    if (outcome === "killed") {
      worker.autoStop = true;
      await c.kill(continuation.agent_id, 1000);
    } else {
      if (outcome === "interrupted") c.cancel(continuation.run_id);
      worker.finish(
        "worker partial",
        outcome === "failed" ? "error" : "aborted",
        "synthetic ending",
      );
    }
    await ended(c, continuation);
    admission = { enabled: false, revision: 1 };
    const result = await action(c, source);
    assert.match(result.delegation_off, /^Ask the user to enable delegation/);
    notice(result.tasks[0]);
    notice((await read(c, source, { task: 1, max_chars: 1 })).tasks[0]);
    assert.equal(c.getResult(source.run_id).text, "raw source evidence");
  });

test("a later observed answer cannot turn the original cancelled continuation into a delivered handoff", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  const continuation = c.view(source.return_to_run_id);
  c.cancel(continuation.run_id);
  await ended(c, continuation);
  (await portFor(f, source)).finish("raw source evidence");
  await ended(c, source);
  const later = await c.answer(
    "later-worker-answer",
    q.run.agent_id,
    q.token,
    "finish a different continuation",
  );
  const worker = await portFor(f, later);
  assert.equal(later.task, 3);
  assert.equal(c.runs.get(later.run_id).record.input_entered, true);
  notice((await action(c, source)).tasks[0], "not_delivered");
  retained((await read(c, source, { task: 1, max_chars: 1 })).tasks[0], "r");
  worker.finish("later worker result");
  await ended(c, later);
  const replay = await admit(f, q);
  assert.equal(replay.return_to_run_id, continuation.run_id);
  notice((await action(c, replay)).tasks[0], "not_delivered");
});

test("Off rejects before admission but never cancels an accepted pair", async (t) => {
  let admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => admission } }),
    c = f.controller,
    q = await asking(f);
  admission = { enabled: false, revision: 1 };
  const before = graph(f);
  await assert.rejects(admit(f, q), errorCode("DELEGATION_OFF"));
  assert.deepEqual(graph(f), before);
  admission = { enabled: true, revision: 2 };
  const source = await admit(f, q);
  admission = { enabled: false, revision: 3 };
  await finishPair(f, source);
  const result = await action(c, source);
  assert.match(result.delegation_off, /^Ask the user to enable delegation/);
  assert.equal(result.tasks[1].status, "completed");
  notice(result.tasks[0]);
  notice((await read(c, source, { max_chars: 1 })).tasks[0]);
  assert.equal(
    (await admit(f, q)).run_id,
    source.run_id,
    "replay remains before Off and stale eligibility",
  );
});

test("whole delivery releases the scout like a kill; a reused scout is left to the parent", async (t) => {
  const f = await fixture(t, { controller: { resident_limit: 2 } }),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q);
  (await portFor(f, source)).finish("SCOUT_PRIVATE_RESULT");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  await until(() => !c.agents.get(source.agent_id).resident);
  const scout = c.agents.get(source.agent_id);
  assert.equal(scout.unavailable, "result_returned");
  assert.equal(
    f.ports.find((port) => port.calls[0]?.identity.run_id === source.run_id).disposed,
    1,
  );
  assert.equal(c.stats().resident, 1, "its slot is free while the worker still runs");
  assert.equal(c.view(continuation.run_id).status, "running");
  worker.finish("worker final answer");
  await ended(c, continuation);
  // Like a kill: the notice and raw result stay readable.
  notice((await read(c, source)).tasks[0]);
  assert.equal(c.getResult(source.run_id).text, "SCOUT_PRIVATE_RESULT");
  assert.deepEqual(await c.kill(source.agent_id, 1000), {
    agent_id: source.agent_id,
    state: "released",
  });

  // A scout the parent reused before the worker took input keeps its conversation.
  const g = await fixture(t),
    d = g.controller,
    p = await asking(g),
    blocker = await d.submit("blocker", task("hold the worker provider", { name: "oak" })),
    second = await admit(g, p, { settings: { ...scoutSettings, provider: "scout-provider" } });
  (await portFor(g, second)).finish("SCOUT_PRIVATE_RESULT");
  await ended(d, second);
  const next = d.view(second.return_to_run_id);
  assert.equal(next.status, "queued", "the worker's provider slot is still held");
  const reuse = await d.submit("reuse", { resume: second.agent_id, prompt: "more research" });
  (await portFor(g, blocker)).finish("done");
  await ended(d, blocker);
  (await portFor(g, next)).finish("worker final answer");
  await ended(d, next);
  await tick();
  assert.equal(d.agents.get(second.agent_id).resident, true);
  assert.equal(d.agents.get(second.agent_id).unavailable, undefined);
  assert.equal(d.view(reuse.run_id).status, "running");
});

test("duplicate continuation inputEntered disposes the scout once, during and after deferred cleanup", async (t) => {
  const disposal = deferred();
  const f = await fixture(t, { beforeShutdown: () => disposal.resolve() }),
    c = f.controller,
    q = await asking(f),
    source = await admit(f, q),
    scout = await portFor(f, source);
  scout.dispose = async () => {
    scout.disposed++;
    await disposal.promise;
    return { shutdownExited: true, errors: [] };
  };
  scout.finish("SCOUT_PRIVATE_RESULT");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation),
    sourceAgent = c.agents.get(source.agent_id);
  await until(() => scout.disposed === 1);
  assert.equal(sourceAgent.resident, true, "pending disposal retains the source reservation");
  assert.equal(sourceAgent.unavailable, "result_returned");
  assert.equal(c.stats().cleaning, 1);

  const assertWorkerUnaffected = () => {
    assert.equal(worker, q.port);
    assert.equal(worker.calls.length, 2, "the continuation enters the worker exactly once");
    assert.match(worker.calls.at(-1).prompt, /SCOUT_PRIVATE_RESULT/);
    assert.equal(c.runs.get(continuation.run_id).record.input_entered, true);
    assert.equal(c.view(continuation.run_id).status, "running");
    assert.equal(c.agents.get(continuation.agent_id).unavailable, undefined);
    assert.equal(worker.streaming, true);
    assert.equal(worker.stopped, 0);
    assert.equal(worker.disposed, 0);
    assert.deepEqual(c.view(continuation.run_id).cleanup_errors, []);
  };
  worker.callbacks.inputEntered();
  worker.callbacks.inputEntered();
  await tick();
  assert.equal(scout.disposed, 1, "duplicate input cannot start another pending disposal");
  assertWorkerUnaffected();

  disposal.resolve();
  await until(() => !sourceAgent.resident && c.stats().cleaning === 0);
  worker.callbacks.inputEntered();
  worker.callbacks.inputEntered();
  await tick();
  assert.equal(scout.disposed, 1, "duplicate input cannot dispose an already released scout");
  assert.equal(sourceAgent.unavailable, "result_returned");
  assert.equal(c.stats().resident, 1);
  assert.equal(c.stats().cleanup_uncertain, false);
  assertWorkerUnaffected();
  worker.finish("worker used the whole scout result");
  await ended(c, continuation);
  assert.equal(c.view(continuation.run_id).status, "completed");
  assert.equal(c.getResult(continuation.run_id).text, "worker used the whole scout result");
});

for (const [mode, report, diagnostic] of [
  ["rejects", undefined, "synthetic scout dispose rejection"],
  ["does not confirm shutdown", { shutdownExited: false, errors: [] }, "shutdown_not_exited"],
  [
    "reports cleanup errors",
    { shutdownExited: true, errors: ["synthetic scout cleanup error"] },
    "synthetic scout cleanup error",
  ],
])
  test(`automatic scout disposal ${mode}: retains the source, not the worker, and refuses Owner closure`, async (t) => {
    const disposal = deferred();
    const f = await fixture(t, {
      cleanupUncertainExpected: true,
      beforeShutdown: () => disposal.resolve(),
    });
    const c = f.controller,
      q = await asking(f),
      source = await admit(f, q),
      scout = await portFor(f, source);
    scout.dispose = async () => {
      scout.disposed++;
      await disposal.promise;
      if (!report) throw new Error(diagnostic);
      return report;
    };
    scout.finish("SCOUT_PRIVATE_RESULT");
    await ended(c, source);
    const continuation = c.view(source.return_to_run_id),
      worker = await portFor(f, continuation);
    await until(() => scout.disposed === 1);
    disposal.resolve();
    await until(() => c.stats().cleanup_uncertain && c.stats().cleaning === 0);
    const sourceAgent = c.agents.get(source.agent_id);
    assert.equal(sourceAgent.resident, true);
    assert.equal(sourceAgent.unavailable, "cleanup_uncertain");
    assert.equal(c.stats().resident, 2);
    assert(c.view(source.run_id).cleanup_errors.some((error) => error.includes(diagnostic)));
    assert.equal(c.view(source.run_id).status, "completed");
    assert.equal(c.getResult(source.run_id).text, "SCOUT_PRIVATE_RESULT");
    assert.deepEqual(await c.kill(source.agent_id, 1000), {
      agent_id: source.agent_id,
      state: "cleanup_uncertain",
    });
    assert.equal(scout.disposed, 1, "explicit kill cannot retry uncertain automatic cleanup");

    assert.equal(worker, q.port);
    assert.equal(worker.calls.length, 2);
    assert.match(worker.calls.at(-1).prompt, /SCOUT_PRIVATE_RESULT/);
    assert.equal(c.runs.get(continuation.run_id).record.input_entered, true);
    assert.equal(c.view(continuation.run_id).status, "running");
    assert.equal(c.agents.get(continuation.agent_id).unavailable, undefined);
    assert.equal(c.agents.get(continuation.agent_id).question, undefined);
    assert.equal(worker.streaming, true);
    assert.equal(worker.stopped, 0);
    assert.equal(worker.disposed, 0);
    assert.deepEqual(c.view(continuation.run_id).cleanup_errors, []);
    worker.finish("worker completed despite scout cleanup failure");
    await ended(c, continuation);
    assert.equal(c.view(continuation.run_id).status, "completed");
    assert.equal(
      c.getResult(continuation.run_id).text,
      "worker completed despite scout cleanup failure",
    );

    const shutdown = await c.shutdown(1000);
    assert.equal(shutdown.closed, false);
    assert.equal(shutdown.cleanup_uncertain, true);
    assert.equal(shutdown.resident, 1, "only the uncertain scout remains reserved");
    assert.equal(shutdown.active + shutdown.finalizing + shutdown.cleaning, 0);
    assert.equal(scout.disposed, 1, "shutdown cannot retry uncertain automatic cleanup");
    f.owner.assertHeld();
  });

test("replay/conflict bind the same original pair after the worker is reused; secondary IDs cannot be impersonated", async (t) => {
  const f = await fixture(t),
    c = f.controller,
    q = await asking(f),
    input = sourceTask(q);
  let prepares = 0;
  const source = await c.submitPrepared("compound", input, (request) => {
    prepares++;
    return request;
  });
  const { continuation } = await finishPair(f, source);
  // Whole delivery released the scout; only the worker can be reused.
  await assert.rejects(
    c.submit("source-later", { resume: source.agent_id, prompt: "new scout task" }),
    errorCode("AGENT_UNAVAILABLE"),
  );
  const laterWorker = await c.submit("worker-later", {
    resume: q.run.agent_id,
    prompt: "new worker task",
  });
  const worker = await portFor(f, laterWorker);
  worker.callbacks.alert("later worker alert");
  worker.finish("later worker body");
  await ended(c, laterWorker);
  const replay = await c.submitPrepared("compound", input, () => {
    throw new Error("must not prepare replay");
  });
  assert.equal(prepares, 1);
  assert.equal(replay.run_id, source.run_id);
  assert.equal(replay.return_to_run_id, continuation.run_id);
  const result = await action(c, replay);
  assert.deepEqual(
    result.tasks.map((row) => [row.agent, row.task]),
    [
      ["pine", 1],
      ["cedar", 2],
    ],
  );
  assert.equal(result.tasks[1].result, "worker final answer");
  assert.equal(result.alerts, undefined);
  notice(result.tasks[0]);
  const identity = {
    owner: c.identity.owner_id,
    generation: c.identity.generation,
    run: source.run_id,
    version: c.view(source.run_id).result_ref.digest,
  };
  const raw = c.getResult(source.run_id, { limit: 5 });
  assert.equal(raw.text, "SCOUT");
  assert(raw.next_cursor);
  for (const extra of [
    { task: source.task, max_chars: 1 },
    { cursor: encodeResultCursor(identity, 5), max_chars: 1 },
    { cursor: raw.next_cursor, max_chars: 1 },
  ]) {
    const historical = await read(c, source, extra);
    assert.equal(historical.tasks[0].task, 1);
    notice(historical.tasks[0]);
    assert.doesNotMatch(JSON.stringify(historical), /SCOUT_PRIVATE_RESULT/);
  }
  assert.equal(
    c.getResult(source.run_id, { cursor: encodeResultCursor(identity, 5) }).text,
    "_PRIVATE_RESULT",
  );
  const latestSource = await read(c, source);
  assert.equal(latestSource.tasks[0].task, 1);
  notice(latestSource.tasks[0]);
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].message, "later worker alert");
  assert.equal((await read(c, continuation, { task: 2 })).tasks[0].result, "worker final answer");
  assert.equal(c.alerts.length, 0);
  await assert.rejects(
    c.submit("compound", sourceTask(q, { return_to: { ...input.return_to, answer: "different" } })),
    errorCode("REQUEST_CONFLICT"),
  );
  const secondary = c.runs.get(continuation.run_id).record;
  assert.notEqual(secondary.request_id, "compound");
  assert.notEqual(secondary.request_digest, c.runs.get(source.run_id).record.request_digest);
  await assert.rejects(
    c.submit(secondary.request_id, task("impersonate", { name: "birch" })),
    errorCode("INVALID_REQUEST_ID"),
  );
  await assert.rejects(
    c.send(secondary.request_id, source.agent_id, "impersonate"),
    errorCode("INVALID_REQUEST_ID"),
  );
});

test("compound alert scope is the two exact Runs, not either Agent's prior or future history", async (t) => {
  const f = await fixture(t),
    c = f.controller;
  const first = await c.submit(
      "worker-question",
      task("question with old alert", { name: "cedar" }),
    ),
    port = await portFor(f, first);
  port.callbacks.alert("old question alert");
  port.callbacks.question("which evidence?");
  port.finish("waiting");
  await ended(c, first);
  const q = { run: first, port, token: c.view(first.run_id).question_id },
    source = await admit(f, q),
    scout = await portFor(f, source);
  const pending = action(c, source, 3000);
  scout.callbacks.alert("source alert");
  const sourceWake = await pending;
  assert.equal(sourceWake.reason, "alert");
  assert.deepEqual(
    sourceWake.alerts.map((row) => row.message),
    ["source alert"],
  );
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].message, "old question alert");
  scout.finish("evidence");
  await ended(c, source);
  const continuation = c.view(source.return_to_run_id),
    worker = await portFor(f, continuation);
  const workerPending = action(c, source, 3000);
  worker.callbacks.alert("worker continuation alert");
  const workerWake = await workerPending;
  assert.equal(workerWake.reason, "alert");
  assert.deepEqual(
    workerWake.alerts.map((row) => row.message),
    ["worker continuation alert"],
  );
  assert.equal(c.alerts.length, 1);
  worker.finish("done");
  await ended(c, continuation);
});

for (const fault of ["submit", "resume", "both"])
  test(`${fault} notification fault keeps both accepted records and sticky source link`, async (t) => {
    let armed = false,
      c,
      noticed = 0;
    const f = await fixture(t, {
      controller: {
        onContextChange(event) {
          if (!armed || !["submit", "resume"].includes(event.kind)) return;
          noticed++;
          assert.equal(c.stats().runs, 3);
          assert.equal(c.stats().requests, 3);
          const source = [...c.runs.values()].find((run) => run.record.name === "pine");
          assert(source.record.return_to_run_id);
          assert(c.runs.has(source.record.return_to_run_id));
          if (fault === "both" || event.kind === fault) throw new Error("synthetic notice failure");
        },
      },
    });
    c = f.controller;
    const q = await asking(f);
    armed = true;
    const source = await admit(f, q),
      continuation = c.view(source.return_to_run_id);
    assert.equal(noticed, 2);
    assert.equal(c.stats().runs, 3);
    assert.equal(c.stats().requests, 3);
    const sourceFault = fault !== "resume",
      targetFault = fault !== "submit";
    if (!sourceFault) {
      const scout = await portFor(f, source);
      scout.finish("retained despite target fault");
    }
    await ended(c, source);
    await ended(c, continuation);
    if (sourceFault) assert.equal(c.view(source.run_id).outcome.reason, "context_change_failed");
    assert.equal(
      c.view(continuation.run_id).outcome.reason,
      targetFault ? "context_change_failed" : "dependency_not_completed",
    );
    assert.equal(c.view(source.run_id).return_to_run_id, continuation.run_id);
    const replay = await admit(f, q);
    assert.equal(replay.run_id, source.run_id);
    assert.equal(replay.return_to_run_id, continuation.run_id);
  });

// A factory that holds scout sessions until released, recording each one.
function heldScoutSessions(f, gate, dispose) {
  const late = [];
  return {
    late,
    createSession: async ({ settings: value }) => {
      const port = new FakePort();
      if (value.profile !== "researcher") {
        f.ports.push(port);
        return port;
      }
      await gate.promise;
      late.push(port);
      if (dispose)
        port.dispose = async () => {
          port.disposed++;
          return dispose();
        };
      return port;
    },
  };
}
const settleTicks = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test("a failed source notice is isolated before a peer notice can reenter cancel and start it", async (t) => {
  let armed = false,
    c,
    scoutFactory = 0;
  const gate = deferred(),
    holder = {};
  const f = await fixture(t, {
    controller: {
      createSession: (input) => {
        if (input.settings.profile === "researcher") scoutFactory++;
        return holder.factory.createSession(input);
      },
      onContextChange(event) {
        f.events.push(event);
        if (!armed) return;
        const source = [...c.runs.values()].find((run) => run.record.name === "pine");
        if (event.kind === "submit" && event.run_id === source.record.run_id)
          throw new Error("synthetic source notice failure");
        // Cancelling the queued continuation settles it and pumps synchronously.
        if (event.kind === "resume") c.cancel(event.run_id);
      },
    },
  });
  holder.factory = heldScoutSessions(f, gate);
  c = f.controller;
  const q = await asking(f);
  armed = true;
  const source = await admit(f, q);
  assert.equal(c.queue.includes(source.run_id), false, "the failed source left the queue at once");
  assert.equal(scoutFactory, 0, "no session was requested for a Run whose notice failed");
  await ended(c, source);
  await ended(c, { run_id: source.return_to_run_id });
  assert.equal(c.view(source.run_id).outcome.reason, "context_change_failed");
  assert.equal(c.view(source.return_to_run_id).outcome.status, "cancelled");
  gate.resolve();
  await settleTicks();
  assert.equal(scoutFactory, 0);
  assert.deepEqual(holder.factory.late, []);
  assert.equal(
    c.view(q.run.run_id).question_id,
    q.token,
    "the pre-input continuation reopened the question",
  );
});

for (const fault of [false, true])
  test(`no Run starts inside its own ${fault ? "failing " : ""}submit notice when a consumer reenters and pumps`, async (t) => {
    let armed = false,
      c,
      startedInNotice;
    const f = await fixture(t, {
      controller: {
        concurrency: 2,
        onContextChange(event) {
          f.events.push(event);
          if (!armed || event.kind !== "submit") return;
          armed = false;
          const blocked = [...c.runs.values()].find((run) => run.record.name === "held");
          c.cancel(blocked.record.run_id); // Settles synchronously and pumps with a free slot.
          startedInNotice = c.runs.get(event.run_id).record.status !== "queued";
          if (fault) throw new Error("synthetic notice failure");
        },
      },
    });
    c = f.controller;
    const first = await c.submit("first", task("occupies one slot", { name: "oak" }));
    await until(() => f.ports.some((port) => port.streaming));
    await c.submit(
      "held",
      task("blocked by its dependency", { name: "held", after: [first.run_id] }),
    );
    armed = true;
    const subject = await c.submit("subject", task("must wait for its notice", { name: "elm" }));
    assert.equal(startedInNotice, false);
    if (fault) {
      await ended(c, subject);
      await settleTicks();
      assert.equal(c.view(subject.run_id).outcome.reason, "context_change_failed");
      assert.equal(
        f.ports.filter((port) => port.calls.some((call) => call.identity.run_id === subject.run_id))
          .length,
        0,
      );
    } else {
      await until(() =>
        f.ports.some(
          (port) => port.streaming && port.calls.at(-1)?.identity.run_id === subject.run_id,
        ),
      );
      f.ports.find((port) => port.calls.at(-1)?.identity.run_id === subject.run_id).finish("ok");
      await ended(c, subject);
    }
    f.ports[0].finish("done");
    await ended(c, first);
  });

for (const clean of [true, false])
  test(`a Run settled while its session factory is pending never runs; the ${clean ? "" : "unconfirmed "}orphan is disposed`, async (t) => {
    const gate = deferred(),
      holder = {};
    const f = await fixture(t, {
      cleanupUncertainExpected: !clean,
      controller: { createSession: (input) => holder.factory.createSession(input) },
    });
    holder.factory = heldScoutSessions(
      f,
      gate,
      clean ? undefined : () => ({ shutdownExited: false, errors: ["synthetic stuck shutdown"] }),
    );
    const c = f.controller;
    const run = await c.submit(
      "scout",
      task("held factory", { name: "pine", settings: scoutSettings }),
    );
    await until(() => c.runs.get(run.run_id).active);
    // Defense in depth: settle it as failure handling would, factory still pending.
    c.finish(c.runs.get(run.run_id), {
      kind: "error",
      error: "synthetic pre-start failure",
      output: { text: "", total_chars: 0, truncated: false },
    });
    await ended(c, run);
    gate.resolve();
    await until(() => holder.factory.late.length === 1);
    const [port] = holder.factory.late;
    await settleTicks();
    assert.equal(port.calls.length, 0, "a settled Run is never executed");
    assert.equal(port.disposed, 1, "the session no Agent owns is disposed");
    assert.equal(c.stats().cleanup_uncertain, !clean);
    if (!clean)
      assert(
        c
          .view(run.run_id)
          .cleanup_errors.some((error) =>
            /synthetic stuck shutdown|shutdown_not_exited/.test(error),
          ),
      );
  });

test("every lease probe is read-only: a reentrant adapter can neither release the worker nor commit a stale plan", async (t) => {
  for (let target = 1; ; target++) {
    let ran = false;
    await t.test(`reentry at probe ${target}`, async (t) => {
      const f = await fixture(t),
        c = f.controller,
        q = await asking(f),
        original = f.ports[0];
      const assertHeld = f.owner.assertHeld.bind(f.owner);
      let probes = 0,
        refusal;
      f.owner.assertHeld = () => {
        if (++probes === target) {
          ran = true;
          try {
            c.release(q.run.agent_id);
          } catch (error) {
            refusal = error.code;
          }
        }
        return assertHeld();
      };
      const outcome = await admit(f, q).then(
        (view) => ({ view }),
        (error) => ({ error }),
      );
      if (!ran) {
        f.owner.assertHeld = assertHeld;
        if (outcome.view) await finishPair(f, outcome.view);
        return;
      }
      assert.equal(
        refusal,
        "OBSERVATION_REENTRANCY",
        "the reentrant effect is refused inside the probe",
      );
      const worker = c.agents.get(q.run.agent_id);
      assert.equal(worker.unavailable, undefined, "the worker was not released");
      assert.equal(original.disposed, 0);
      if (outcome.error) {
        // A decision probe fails as a lost lease would: sticky, nothing installed.
        assert.equal(outcome.error.code, "OBSERVATION_REENTRANCY");
        assert.notEqual(c.stats().internal_error, undefined);
        assert.equal(c.findAgent("pine"), undefined);
        assert.equal(worker.current, undefined);
        assert.equal(
          worker.question?.run_id,
          q.run.run_id,
          "nothing was installed against the worker",
        );
      } else {
        // Post-install probes (pump, execution, projection) only fault or report
        // not held; the continuation never runs on a session of its own.
        const continuation = outcome.view.return_to_run_id;
        assert(
          f.ports.every(
            (port) =>
              port === original ||
              !port.calls.some((call) => call.identity.run_id === continuation),
          ),
        );
      }
      f.owner.assertHeld = assertHeld;
    });
    if (!ran) break;
    assert(target < 50, "probe inventory is bounded");
  }
});
