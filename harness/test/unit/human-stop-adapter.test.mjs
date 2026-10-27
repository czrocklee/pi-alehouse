import assert from "node:assert/strict";
import test from "node:test";
import { humanCancellationMessage, requestHumanStop } from "../../dist/runtime/human-stop.js";

const snapshot = { run_id: "original-run", name: "otter", task: 3 };
const accepted = () => ({ result: "cancel_requested", already_stopping: false, snapshot: { ...snapshot } });

test("a human stop records core origin and queues a non-triggering parent-model notice", () => {
  const calls = [], messages = [];
  const result = requestHumanStop({ cancel(id, options) {
    calls.push({ id, options }); return accepted();
  } }, { sendMessage(message, options) { messages.push({ message, options }); } }, snapshot.run_id);
  assert.deepEqual(calls, [{ id: snapshot.run_id, options: { source: "human" } }]);
  assert.deepEqual(result, { result: "cancel_requested", already_stopping: false });
  assert.equal(messages.length, 1);
  const { message, options } = messages[0];
  assert.equal(message.customType, humanCancellationMessage);
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: false });
  assert.deepEqual(message.details, { agent: "otter", task: 3, run_id: "original-run", cancellation_source: "human" });
  assert.match(message.content, /"agent":"otter","task":3/);
  assert.match(message.content, /Do not automatically resume or redelegate/);
  assert.match(message.content, /not confirmed execution exit/);
});

for (const [result, already_stopping] of [
  ["cancel_requested", true], ["already_terminal", false], ["already_exited", false],
]) test(`a no-op human stop does not announce a new cancellation (${result}, stopping=${already_stopping})`, () => {
  const reply = requestHumanStop({ cancel: () => ({ result, already_stopping, snapshot }) }, {
    sendMessage() { assert.fail("a no-op must not be misreported as a new human cancellation"); },
  }, snapshot.run_id);
  assert.deepEqual(reply, { result, already_stopping });
});

test("a command rejection is not announced or retried", () => {
  let requests = 0;
  assert.throws(() => requestHumanStop({ cancel() { requests++; throw new Error("STOP_REJECTED"); } }, {
    sendMessage() { assert.fail("rejected cancellation is not an accepted human action"); },
  }, snapshot.run_id), /STOP_REJECTED/);
  assert.equal(requests, 1);
});

test("a parent-message failure cannot turn an accepted stop into a rejected command", () => {
  let requests = 0;
  const reply = requestHumanStop({ cancel() { requests++; return accepted(); } }, {
    sendMessage() { throw new Error("MESSAGE_QUEUE_FAILED"); },
  }, snapshot.run_id);
  assert.equal(requests, 1);
  assert.equal(reply.result, "cancel_requested");
  assert.equal(reply.already_stopping, false);
  assert.deepEqual(reply.warnings, ["The cancellation request was accepted, but its parent-model notice could not be queued."]);
});
