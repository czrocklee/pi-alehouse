import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createChildTools } from "../../dist/tools/child-tools.js";
import { HarnessError } from "../../dist/core/ports.js";
import { ALERT_QUEUE_FULL_RESOLUTION } from "../../dist/core/communication-state.js";
import { blockedDelegationToolNames, managementToolNames } from "../../dist/tools/tool-names.js";

const toolsFor = (callbacks, gate = { accepting: true, stopped: false }) =>
  createChildTools(() => callbacks, gate);

function recordingCallbacks() {
  const calls = { alert: [], question: [] };
  return { calls, callbacks: {
    alert: (value) => { calls.alert.push(value); },
    question: (value) => { calls.question.push(value); return "recorded"; },
  } };
}

test("children expose exactly two closed communication tools, without notification or management aliases", () => {
  const { callbacks } = recordingCallbacks(), tools = toolsFor(callbacks);
  assert.deepEqual(tools.map((tool) => tool.name), ["alert_parent", "ask_parent"]);
  assert(managementToolNames.includes("agent_answer"));
  assert(blockedDelegationToolNames.includes("agent_answer"));
  assert(blockedDelegationToolNames.includes("notify_parent"));
  for (const tool of tools) {
    assert(!blockedDelegationToolNames.includes(tool.name));
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.type, "object");
    const key = tool.name === "alert_parent" ? "message" : "question";
    assert.deepEqual(Object.keys(tool.parameters.properties), [key]);
    assert.deepEqual(tool.parameters.required, [key]);
    assert.equal(tool.parameters.properties[key].minLength, 1);
    assert.equal(tool.parameters.properties[key].maxLength, 8192);
    assert.equal(tool.parameters.properties[key].pattern, "\\S");
  }
});

for (const [name, key] of [["alert_parent", "message"], ["ask_parent", "question"]]) {
  test(`${name} revalidates mutable SDK hook inputs before obtaining callbacks or accepting data`, async () => {
    const { callbacks, calls } = recordingCallbacks();
    let reads = 0;
    const tool = createChildTools(() => { reads++; return callbacks; }, { accepting: true, stopped: false })
      .find((entry) => entry.name === name);
    for (const value of [undefined, null, 42, [], {}, "", " \t\n", "\u3000", "x".repeat(8193), "🚀".repeat(4097)]) {
      const args = { [key]: "valid before SDK tool_call" };
      assert(Check(tool.parameters, args)); args[key] = value;
      await assert.rejects(tool.execute("mutated", args), { code: "INVALID_PARAMETERS" });
    }
    await assert.rejects(tool.execute("extra", { [key]: "valid", extra: true }), { code: "INVALID_PARAMETERS" });
    assert.equal(reads, 0);
    assert.deepEqual(calls, { alert: [], question: [] });
    for (const value of ["x", "字".repeat(8192), "🚀".repeat(4096), "\ud800".repeat(8192)]) {
      const result = await tool.execute("accepted", { [key]: value });
      assert.equal(result.details, undefined);
      assert.equal(result.content[0].type, "text");
      assert.equal(calls[key === "message" ? "alert" : "question"].at(-1), value, "legal UTF-16 text is never truncated");
    }
    assert.equal(reads, 4);
  });

  test(`${name} checks the current Run gate after hooks and rejects a stale or closed Run without false success`, async () => {
    const { callbacks, calls } = recordingCallbacks();
    for (const [current, gate] of [[undefined, { accepting: true, stopped: false }],
      [callbacks, { accepting: false, stopped: false }], [callbacks, { accepting: true, stopped: true }]]) {
      const tool = toolsFor(current, gate).find((entry) => entry.name === name);
      const args = { [key]: "valid" };
      assert(Check(tool.parameters, args));
      await assert.rejects(tool.execute("after-hooks", args), { code: "RUN_INPUT_CLOSED" });
    }
    const gate = { accepting: true, stopped: false };
    const tool = toolsFor(callbacks, gate).find((entry) => entry.name === name);
    const args = { [key]: "valid before mutable hook" };
    assert(Check(tool.parameters, args)); gate.stopped = true;
    await assert.rejects(tool.execute("stopped-by-hook", args), { code: "RUN_INPUT_CLOSED" });
    assert.deepEqual(calls, { alert: [], question: [] });
  });
}

test("accepted alerts say queued/continue, never read, and repeated call IDs are not deduplicated", async () => {
  const { callbacks, calls } = recordingCallbacks(), tool = toolsFor(callbacks)[0];
  const args = { message: "important decision-relevant fact" };
  for (let i = 0; i < 2; i++) {
    const result = await tool.execute("same-call-id", args);
    assert.deepEqual(result, { content: [{ type: "text", text: "Alert queued. Continue working." }], details: undefined });
    assert.doesNotMatch(result.content[0].text, /read|acknowledged|presented/i);
  }
  assert.deepEqual(calls.alert, [args.message, args.message]);
  assert.deepEqual(calls.question, []);
});

test("question receipts distinguish first recording from first-write-wins acceptance without comparing/replacing text", async () => {
  let original;
  const calls = [];
  const tool = toolsFor({ alert() { assert.fail("question must not enqueue an alert"); }, question(value) {
    calls.push(value);
    if (original !== undefined) return "already_recorded";
    original = value;
    return "recorded";
  } })[1];
  const first = await tool.execute("first", { question: "Which factor?" });
  const second = await tool.execute("second", { question: "A different valid question" });
  assert.equal(original, "Which factor?");
  assert.equal(first.content[0].text, "Question recorded. Finish this task now.");
  assert.equal(second.content[0].text, "This task already has a question; it was not replaced. Finish this task now.");
  assert.notEqual(first.content[0].text, second.content[0].text);
  await assert.rejects(tool.execute("invalid-repeat", { question: " " }), { code: "INVALID_PARAMETERS" });
  assert.deepEqual(calls, ["Which factor?", "A different valid question"]);
});

const queueResolution = "Do not retry in a loop; keep the information in your final result and continue work you can do. If you truly need a parent decision, use ask_parent and end this task.";

test("the shared SDK-free queue recovery constant preserves the exact bounded child guidance contract", () => {
  assert.equal(ALERT_QUEUE_FULL_RESOLUTION, queueResolution);
  assert(ALERT_QUEUE_FULL_RESOLUTION.length < 512);
});

for (const [scope, limit] of [["agent", 16], ["owner", 64]]) {
  test(`queue rejection projects bounded ${scope} quota/guidance into Error.message without mutating the core error`, async () => {
    const secret = "PRIVATE-DETAIL".repeat(8192);
    const details = { scope, limit, resolution: secret, owner_id: "PRIVATE-OWNER", run_id: "PRIVATE-RUN",
      prompt: secret, nested: { toJSON() { assert.fail("arbitrary details must never be serialized"); } } };
    const failure = new HarnessError("ALERT_QUEUE_FULL", details);
    failure.message = "PRIVATE-MESSAGE";
    failure.cause = new Error("PRIVATE-CAUSE");
    const tool = toolsFor({ alert() { throw failure; }, question() { assert.fail("alert must not ask"); } })[0];
    await assert.rejects(tool.execute("alert", { message: "not accepted" }), (error) => {
      assert(error instanceof HarnessError);
      assert.notEqual(error, failure, "only queue errors receive a child-boundary projection");
      assert.equal(error.code, "ALERT_QUEUE_FULL");
      assert.equal(error.message, `ALERT_QUEUE_FULL (scope=${scope}, limit=${limit}): ${queueResolution}`);
      assert.deepEqual(error.details, { scope, limit, resolution: queueResolution });
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /PRIVATE|Alert queued|Question recorded/);
      assert(error.message.length < 512);
      return true;
    });
    assert.equal(failure.message, "PRIVATE-MESSAGE");
    assert.equal(failure.details, details);
    assert.equal(failure.details.resolution, secret);
  });
}

test("queue rejection never stringifies malformed scope/limit or forwards arbitrary resolution", async () => {
  const unprintable = { toString() { assert.fail("malformed quota must not be stringified"); } };
  for (const details of [{}, { scope: "PRIVATE-SCOPE".repeat(8192), limit: 64 },
    { scope: unprintable, limit: 16 }, { scope: "agent", limit: unprintable },
    { scope: "agent", limit: "16" }, { scope: "owner", limit: 16 }, { scope: "agent", limit: 64 }]) {
    const failure = new HarnessError("ALERT_QUEUE_FULL", { ...details, resolution: "PRIVATE-RESOLUTION" });
    const tool = toolsFor({ alert() { throw failure; } })[0];
    await assert.rejects(tool.execute("alert", { message: "not accepted" }), (error) => {
      assert.equal(error.code, "ALERT_QUEUE_FULL");
      assert.equal(error.message, `ALERT_QUEUE_FULL: ${queueResolution}`);
      assert.deepEqual(error.details, { resolution: queueResolution });
      return true;
    });
  }
});

test("non-queue alert failures and all question failures preserve original error identity without false acceptance", async () => {
  for (const failure of [new HarnessError("RUN_INPUT_CLOSED"), new HarnessError("ALERT_TOO_LARGE", { limit: 8192 }),
    new Error("ALERT_QUEUE_FULL"), new Error("unrelated failure")]) {
    const tools = toolsFor({ alert() { throw failure; }, question() { throw failure; } });
    await assert.rejects(tools[0].execute("alert", { message: "keep in final result" }), (error) => error === failure);
    await assert.rejects(tools[1].execute("question", { question: "decide?" }), (error) => error === failure);
  }
  const failure = new HarnessError("ALERT_QUEUE_FULL", { scope: "agent", limit: 16 });
  const tool = toolsFor({ question() { throw failure; } })[1];
  await assert.rejects(tool.execute("question", { question: "decide?" }), (error) => error === failure);
});
