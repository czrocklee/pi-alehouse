import assert from "node:assert/strict";
import test from "node:test";
import { ManagedBlockObserver, MANAGED_BLOCK_ID_LIMIT } from "../../dist/runtime/permission-blocks.js";

function fixture() {
  const subscriptions = [], alerts = [];
  let accepting = true, releases = 0;
  const observer = new ManagedBlockObserver((sessionId, receive) => {
    subscriptions.push({ sessionId, receive });
    return () => { releases++; };
  });
  const begin = (callbacks = { managedBlock: (fact) => alerts.push(fact), alert: () => assert.fail("must not spend child alert quota") }) =>
    observer.begin("real-sdk-session", callbacks, () => accepting);
  begin();
  return { observer, alerts, subscriptions, begin, set accepting(value) { accepting = value; },
    get releases() { return releases; }, block(toolName, toolCallId) { subscriptions.at(-1).receive({ toolName, toolCallId }); } };
}

test("only two distinct confirmed blocks of the same exact tool latch one partial-coverage alert", () => {
  const f = fixture();
  f.block("bash", "opaque|one"); f.observer.flush();
  assert.deepEqual(f.alerts, []);
  f.block("bash", "opaque|one"); f.block("write", "second"); f.observer.flush();
  assert.deepEqual(f.alerts, [], "duplicate IDs and another tool do not establish recurrence");
  f.block("bash", "third");
  assert.deepEqual(f.alerts, [], "authority sink is latch-only, not an Owner callback");
  f.observer.flush(); f.observer.flush();
  f.block("write", "fourth"); f.observer.flush();
  assert.equal(f.alerts.length, 1);
  assert.deepEqual(f.alerts[0], { toolName: "bash" }, "only typed exact-tool telemetry reaches the trusted callback");
  assert.doesNotMatch(JSON.stringify(f.alerts[0]), /opaque|third|real-sdk-session|permission denied|policy deny/i);
  assert.equal(f.subscriptions[0].sessionId, "real-sdk-session");
});

test("closed gates, old Run callbacks and end cannot leak observations into a reused Run", () => {
  const f = fixture(), old = f.subscriptions[0].receive;
  f.block("read", "one"); f.block("read", "two");
  f.accepting = false; f.observer.flush();
  assert.equal(f.alerts.length, 0);
  f.observer.end(); f.observer.end();
  assert.equal(f.releases, 1);
  f.accepting = true; f.begin();
  old({ toolName: "read", toolCallId: "late-old" });
  f.block("read", "new-one"); f.observer.flush();
  assert.equal(f.alerts.length, 0);
  f.block("read", "new-two"); f.observer.flush();
  assert.equal(f.alerts.length, 1);
  f.observer.end();
  f.block("read", "late-closed"); f.observer.flush();
  assert.equal(f.alerts.length, 1);
  assert.equal(f.releases, 2);
});

test("invalid or unsupported metadata is unknown and never echoed", () => {
  const f = fixture(), receive = f.subscriptions[0].receive;
  for (const fact of [undefined, {}, { toolName: "bash", toolCallId: "" },
    { toolName: "bash", toolCallId: "x".repeat(257) }, { toolName: "raw-secret-command", toolCallId: "one" },
    { toolName: "raw-secret-command", toolCallId: "two" }, { toolName: "bash", toolCallId: 42 }]) receive(fact);
  f.observer.flush();
  assert.deepEqual(f.alerts, []);
  f.block("bash", "ok1"); f.block("bash", "ok2"); f.observer.flush();
  assert.equal(f.alerts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.alerts[0]), /raw-secret-command/);
});

test("bounded ID retention and ambiguous IDs never create unbounded text or groups", () => {
  const f = fixture();
  // Invalid tool groups cannot occupy the bounded ID table.
  for (let i = 0; i < 1000; i++) f.block(`unknown-${i}`, `bad-${i}`);
  f.block("read", "one");
  // Reuse one identity across tools: never count twice under an ambiguous ID.
  for (let i = 0; i < MANAGED_BLOCK_ID_LIMIT + 100; i++) f.block("bash", "one");
  f.observer.flush(); assert.deepEqual(f.alerts, []);
  f.block("read", "two"); f.observer.flush(); assert.equal(f.alerts.length, 1);
  const g = fixture();
  g.block("bash", "first"); g.block("bash", "repeat");
  const retainedIds = [...g.observer.current.ids], retainedTools = [...g.observer.current.tools];
  for (let i = 0; i < MANAGED_BLOCK_ID_LIMIT + 100; i++) {
    g.block("bash", `distinct-${i}`);
    g.block("write", `other-${i}`);
  }
  assert(g.observer.current.ids.size <= MANAGED_BLOCK_ID_LIMIT, "retained IDs stay bounded before flush");
  assert.deepEqual([...g.observer.current.ids], retainedIds, "IDs stop accumulating as soon as recurrence latches");
  assert.deepEqual([...g.observer.current.tools], retainedTools, "new tool groups stop accumulating after the latch");
  g.observer.flush(); assert.equal(g.alerts.length, 1);
});

test("a full or throwing alert sink is attempted once, never retried or propagated", () => {
  const f = fixture(); let attempts = 0;
  f.begin({ managedBlock() { attempts++; f.observer.flush(); throw new Error("ALERT_LIMIT"); } });
  f.block("bash", "a"); f.block("bash", "b");
  assert.doesNotThrow(() => f.observer.flush());
  f.block("bash", "c"); f.observer.flush();
  assert.equal(attempts, 1);
});

test("unavailable subscription and unsubscribe are harmless, locally sealed unknown coverage", () => {
  const absent = new ManagedBlockObserver();
  assert.doesNotThrow(() => { absent.begin("session", {}, () => true); absent.flush(); absent.end(); });
  const broken = new ManagedBlockObserver(() => { throw new Error("unavailable"); });
  assert.doesNotThrow(() => { broken.begin("session", {}, () => true); broken.flush(); broken.end(); });
  let receive, alerts = 0;
  const throwingRelease = new ManagedBlockObserver((_id, sink) => { receive = sink; return () => { throw new Error("release"); }; });
  throwingRelease.begin("session", { managedBlock: () => alerts++ }, () => true);
  receive({ toolName: "write", toolCallId: "one" });
  receive({ toolName: "write", toolCallId: "two" });
  throwingRelease.end(); throwingRelease.flush();
  assert.equal(alerts, 0);
});
