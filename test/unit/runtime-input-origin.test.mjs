// Source-level regressions for the presentation-only input attribution seam:
// the exact-object capture around the public Agent methods, and the activity
// sidecar that retains a confirmed origin by message identity. No SDK session,
// model, network or host workflow is involved; the Agent here is a plain
// public-shape stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Load the production source, never a stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { InputOriginCapture } = await jiti.import("../../src/orchestration/runtime/input-origin.ts");
const { ChildActivity } = await jiti.import("../../src/orchestration/runtime/activity-observer.ts");
const { PiAgentSessionAdapter } = await jiti.import(
  "../../src/orchestration/runtime/agent-session.ts",
);

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const textOf = (message) =>
  Array.isArray(message?.content)
    ? message.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("")
    : undefined;

/** A minimal public-Agent stand-in: exactly the two methods the capture wraps,
 * with every call's receiver and arguments retained for identity assertions. */
function fakeAgent() {
  const calls = [];
  const agent = {
    prompt(input, options) {
      calls.push({ method: "prompt", input, options, receiver: this });
      return Array.isArray(input) ? input[0] : input;
    },
    steer(input, options) {
      calls.push({ method: "steer", input, options, receiver: this });
      return input;
    },
  };
  return { agent, calls };
}

const dispatch = (capture, input, invoke) =>
  capture.dispatch({ steer: false, admitted: () => true, ...input }, invoke);

test("concurrent identical text binds each dispatch's own origin despite reordering", async () => {
  const { agent, calls } = fakeAgent();
  const records = new Map();
  const capture = new InputOriginCapture(agent, (message, origin) => records.set(message, origin));

  let armParent;
  const parentArmed = new Promise((resolve) => (armParent = resolve));
  let allowParent;
  const parentAllowed = new Promise((resolve) => (allowParent = resolve));

  const parent = dispatch(capture, { origin: "parent", text: "SAME_BODY" }, async (start) => {
    start();
    armParent();
    await parentAllowed;
    return agent.prompt([user("SAME_BODY")]);
  });
  const human = dispatch(capture, { origin: "human", text: "SAME_BODY" }, async (start) => {
    start();
    await parentArmed;
    const message = agent.prompt([user("SAME_BODY")]);
    allowParent();
    return message;
  });

  const [parentMessage, humanMessage] = await Promise.all([parent, human]);
  assert.notEqual(parentMessage, humanMessage, "each dispatch observes its own object");
  assert.equal(records.get(parentMessage), "parent");
  assert.equal(records.get(humanMessage), "human");
  assert.equal(calls[0].input[0], humanMessage, "the human dispatch prompted first");
  assert.equal(calls[1].input[0], parentMessage);
});

test("unadmitted, unarmed, follow-up and non-steer dispatches never bind", async () => {
  const { agent } = fakeAgent();
  const records = new Map();
  const capture = new InputOriginCapture(agent, (message, origin) => records.set(message, origin));

  const discarded = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY", admitted: () => false },
    async (start) => {
      start();
      return agent.prompt([user("SAME_BODY")]);
    },
  );
  const unarmed = await dispatch(capture, { origin: "parent", text: "SAME_BODY" }, async () =>
    agent.prompt([user("SAME_BODY")]),
  );
  const followUp = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.steer(user("SAME_BODY"));
    },
  );
  const notSteer = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY", steer: false },
    async (start) => {
      start();
      return agent.steer(user("SAME_BODY"));
    },
  );
  await assert.rejects(
    dispatch(capture, { origin: "parent", text: "SAME_BODY" }, async () => {
      throw new Error("BEFORE_PROMPT");
    }),
    /BEFORE_PROMPT/,
  );

  for (const message of [discarded, unarmed, followUp, notSteer])
    assert.equal(records.has(message), false, "no discarded call may acquire an origin");
});

test("direct, custom, multi-message and non-text payloads stay unknown", async () => {
  const { agent } = fakeAgent();
  const records = new Map();
  const capture = new InputOriginCapture(agent, (message, origin) => records.set(message, origin));

  const direct = agent.prompt([user("SAME_BODY")]);
  const custom = await dispatch(capture, { origin: "parent", text: "SAME_BODY" }, async (start) => {
    start();
    return agent.prompt([
      {
        role: "custom",
        customType: "synthetic",
        content: [{ type: "text", text: "SAME_BODY" }],
        timestamp: 1,
      },
    ]);
  });
  const twoUsers = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([user("SAME_BODY"), user("SAME_BODY")]);
    },
  );
  const twoParts = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([
        {
          role: "user",
          content: [
            { type: "text", text: "SAME_BODY" },
            { type: "text", text: "SAME_BODY" },
          ],
          timestamp: 1,
        },
      ]);
    },
  );
  const stringContent = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([{ role: "user", content: "SAME_BODY", timestamp: 1 }]);
    },
  );
  const wrongText = await dispatch(
    capture,
    { origin: "parent", text: "EXPECTED_BODY" },
    async (start) => {
      start();
      return agent.prompt([user("OTHER_BODY")]);
    },
  );

  for (const message of [direct, custom, twoUsers, twoParts, stringContent, wrongText])
    assert.equal(records.has(message), false, "unconfirmed payloads never bind");

  const confirmed = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([user("SAME_BODY")]);
    },
  );
  assert.equal(records.get(confirmed), "parent", "a later exact dispatch still binds");
});

test("a late user in the inherited initial scope never reuses the initial origin", async () => {
  const { agent } = fakeAgent();
  const records = new Map();
  const capture = new InputOriginCapture(agent, (message, origin) => records.set(message, origin));

  let late;
  const initial = await dispatch(
    capture,
    { origin: "parent", text: "TASK_BODY" },
    async (start) => {
      start();
      const message = agent.prompt([user("TASK_BODY")]);
      // Same async scope, same text: the initial dispatch is one-shot.
      await Promise.resolve();
      late = agent.prompt([user("TASK_BODY")]);
      return message;
    },
  );
  assert.equal(records.get(initial), "parent");
  assert.equal(records.has(late), false, "the inherited scope cannot bind twice");
  const afterExit = agent.prompt([user("TASK_BODY")]);
  assert.equal(records.has(afterExit), false, "the closed dispatch binds nothing");
});

test("an unsupported frozen method leaves the agent usable and unobserved", async () => {
  const prompt = (input) => input[0];
  const agent = Object.freeze({ prompt });
  const records = [];
  const capture = new InputOriginCapture(agent, (message, origin) =>
    records.push([message, origin]),
  );

  assert.equal(agent.prompt, prompt, "the frozen method is not replaced");
  const message = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([user("SAME_BODY")]);
    },
  );
  assert.equal(textOf(message), "SAME_BODY");
  assert.deepEqual(records, []);
});

test("an observer failure cannot change the method's return, rejection, receiver or arguments", async () => {
  const { agent, calls } = fakeAgent();
  const capture = new InputOriginCapture(agent, () => {
    throw new Error("OBSERVER_FAILURE");
  });
  const message = user("SAME_BODY");
  const options = { source: "extension" };
  const before = structuredClone(message);

  const returned = await dispatch(
    capture,
    { origin: "parent", text: "SAME_BODY" },
    async (start) => {
      start();
      return agent.prompt([message], options);
    },
  );
  assert.equal(returned, message, "the original return value is preserved");
  const call = calls.at(-1);
  assert.equal(call.input[0], message, "the exact argument object is passed through");
  assert.equal(call.options, options, "the exact options object is passed through");
  assert.equal(call.receiver, agent, "the receiver is preserved");
  assert.deepEqual(message, before, "the observed message bytes are untouched");
  assert.deepEqual(Object.keys(message), ["role", "content", "timestamp"]);

  const failure = new Error("METHOD_REJECTED");
  const rejecting = {
    prompt() {
      throw failure;
    },
    steer() {},
  };
  const rejectingCapture = new InputOriginCapture(rejecting, () => {
    throw new Error("OBSERVER_FAILURE");
  });
  await assert.rejects(
    dispatch(rejectingCapture, { origin: "parent", text: "SAME_BODY" }, async (start) => {
      start();
      return rejecting.prompt([user("SAME_BODY")]);
    }),
    (error) => error === failure,
    "the original rejection is preserved",
  );

  const other = { marker: true };
  const otherReturn = agent.prompt.call(other, [user("SAME_BODY")]);
  assert.equal(calls.at(-1).receiver, other, "a foreign receiver is never observed or changed");
  assert.equal(textOf(otherReturn), "SAME_BODY");
});

test("ChildActivity retains an origin by exact identity, first binding wins, and never infers", () => {
  const activity = new ChildActivity("/synthetic");
  const handlers = new Map();
  activity.extension({ on: (name, handler) => handlers.set(name, handler) });
  const message = user("SAME_BODY");
  const twin = user("SAME_BODY");

  assert.equal(activity.inputOrigin(message), undefined, "unrecorded messages are unknown");
  const revision = activity.presentationRevision;
  const before = structuredClone(message);
  activity.recordInputOrigin(message, "parent");
  assert.equal(activity.inputOrigin(message), "parent");
  assert(activity.presentationRevision > revision, "a real binding wakes the UI");
  activity.recordInputOrigin(message, "human");
  assert.equal(activity.inputOrigin(message), "parent", "first binding wins");
  assert.deepEqual(message, before, "recording never rewrites the message");
  assert.equal(activity.inputOrigin(twin), undefined, "identical bytes are not identity");
  assert.equal(activity.inputOrigin(null), undefined);
  assert.equal(activity.inputOrigin("SAME_BODY"), undefined);
  assert.equal(activity.inputOrigin({}), undefined);

  activity.begin();
  assert.equal(activity.inputOrigin(message), "parent", "submission reset retains the sidecar");

  const sessionManager = {
    getEntries: () => [],
    getSessionId: () => "synthetic-session",
    getLeafId: () => null,
    getEntryCount: () => 0,
  };
  handlers.get("session_start")({}, { sessionManager });
  assert.equal(activity.inputOrigin(message), "parent", "a new session retains retained history");
  handlers.get("session_shutdown")();
  assert.equal(activity.inputOrigin(message), "parent", "shutdown retains the sidecar");
});

test("the adapter installs the capture only when an observer is supplied", () => {
  const { agent } = fakeAgent();
  const originalPrompt = agent.prompt;
  const originalSteer = agent.steer;
  const session = { sessionId: "synthetic", agent };
  const gate = { accepting: false, stopped: false, tickets: new Set(), observations: [] };

  new PiAgentSessionAdapter({ session, parentBus: { emit() {} }, gate, readiness() {} });
  assert.equal(agent.prompt, originalPrompt, "no observer leaves the public method untouched");
  assert.equal(agent.steer, originalSteer);

  const observed = [];
  new PiAgentSessionAdapter({
    session,
    parentBus: { emit() {} },
    gate,
    readiness() {},
    observeInput: (message, origin) => observed.push([message, origin]),
  });
  assert.notEqual(agent.prompt, originalPrompt, "an observer installs the exact-object seam");
  assert.notEqual(agent.steer, originalSteer);
  assert.deepEqual(observed, []);
});
