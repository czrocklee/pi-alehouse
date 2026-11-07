import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildRunGate,
  PiAgentSessionAdapter,
} from "../../dist/orchestration/runtime/agent-session.js";

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
};
const assistant = () => ({
  role: "assistant",
  api: "fixture",
  provider: "fixture",
  model: "controlled",
  content: [],
  stopReason: "stop",
  usage,
  timestamp: 0,
});

// Isolated public-event seam complements the real SDK held-stream regression.
async function runScript(script) {
  let listener, runtime;
  const outputActivities = [];
  const session = {
    sessionId: "retry-preview-fixture",
    isIdle: true,
    isStreaming: false,
    model: { provider: "fixture", id: "controlled" },
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getContextUsage: () => undefined,
    waitForIdle: async () => {},
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      await script(
        (event) => listener(event),
        () => runtime,
      );
    },
  };
  const port = new PiAgentSessionAdapter({
    session,
    gate: new ChildRunGate(),
    parentBus: { emit() {} },
    readiness() {},
  });
  const facts = await port.run("synthetic task", {
    inputEntered() {},
    turnStart() {},
    turnEnd() {},
    outputDelta() {
      outputActivities.push(runtime?.activity);
    },
    output() {
      outputActivities.push(runtime?.activity);
    },
    runtime(value) {
      runtime = value;
    },
  });
  assert.equal(listener, undefined, "the adapter unsubscribed after exit");
  return { facts, outputActivities };
}

for (const summary of [false, true])
  test(`non-assistant starts preserve retry state and assistant response publishes generation (summary=${summary})`, async () => {
    const { facts, outputActivities } = await runScript(async (emit, current) => {
      if (summary) {
        emit({ type: "compaction_start" });
        emit({ type: "summarization_retry_scheduled" });
      } else emit({ type: "auto_retry_start" });
      assert.equal(current().activity, "retrying");
      for (const role of ["user", "toolResult"]) {
        emit({ type: "message_start", message: { role } });
        // turn_start forces a publish even if message_start itself is ignored.
        emit({ type: "turn_start" });
        assert.equal(
          current().activity,
          "retrying",
          `${role} message_start cannot clear retry state`,
        );
      }
      if (summary) {
        emit({ type: "summarization_retry_attempt_start" });
        assert.equal(current().activity, "compacting");
        emit({ type: "summarization_retry_finished" });
        emit({ type: "compaction_end", result: { usage } });
      }
      emit({ type: "message_start", message: assistant() });
      assert.equal(
        current().activity,
        "generating",
        "publish occurs at response start, before deltas or message_end",
      );
      emit({ type: "message_end", message: assistant() });
    });
    assert.deepEqual(
      outputActivities,
      ["generating", "generating"],
      "even the response-start output observer sees the updated runtime",
    );
    assert.equal(facts.kind, "success");
    assert.equal(facts.usage.byModel["fixture/controlled"].cost, 1);
    if (summary) {
      assert.equal(facts.usage.byModel["compaction/fixture/controlled"].cost, 1);
      assert.deepEqual(
        facts.usage.partial,
        ["input", "output", "cache_read", "cache_write", "cost"],
        "hidden summary retry spend stays incomplete",
      );
    } else assert.equal(facts.usage.byModel["compaction/fixture/controlled"], undefined);
  });
