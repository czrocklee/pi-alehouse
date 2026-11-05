import assert from "node:assert/strict";
import test from "node:test";
import { packIndependentCommunication } from "../../dist/core/communication-packer.js";

// Pure lifecycle/roster projection, no Owner publication or notification ACK.
const bytes = result => Buffer.byteLength(JSON.stringify(result), "utf8");
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("independent packing preserves complete replies and never mutates captured lifecycle facts", () => {
  for (const captured of [
    { agent: "otter", task: 1, status: "interrupting", label: "Stop requested" },
    { agents: [{ agent: "otter", task: 1, status: "queued", wait: "capacity" }], killed: ["badger"] },
    { agent: "otter", status: "cleanup_uncertain", resolution: "Tell the user, do not retry.", response_limit_reached: true },
  ]) {
    const before = structuredClone(captured); freeze(captured);
    const result = packIndependentCommunication(captured);
    assert.deepEqual(JSON.parse(result.content[0].text), before);
    assert.equal(result.details, undefined); assert(bytes(result) <= 65536);
    assert.deepEqual(captured, before);
  }
});

test("independent roster uses deterministic whole-field omission without dropping queued controls", () => {
  const captured = { agents: Array.from({ length: 16 }, (_, i) => ({ agent: `otter${i}`, task: 1,
    status: "queued", wait: i % 2 ? "capacity" : "dependencies",
    error: "\0".repeat(20000), label: "fixture" })), killed: ["badger"] };
  const before = structuredClone(captured); freeze(captured);
  const result = packIndependentCommunication(captured), reply = JSON.parse(result.content[0].text);
  assert(bytes(result) <= 65536); assert.equal(reply.response_limit_reached, true);
  assert.equal(reply.agents.length, 16); assert.deepEqual(reply.killed, ["badger"]);
  for (const [index, row] of reply.agents.entries()) {
    for (const field of ["agent", "task", "status", "wait"]) assert.equal(row[field], before.agents[index][field]);
    for (const field of ["error", "label"])
      if (Object.hasOwn(row, field)) assert.deepEqual(row[field], before.agents[index][field], "metadata is whole or omitted, never clipped");
  }
  assert.deepEqual(captured, before);
});

test("independent omission preserves field priority and removes later rows first", () => {
  const captured = { agents: [0, 1].map(i => ({ agent: `otter${i}`, task: 1, status: "completed",
    error: `diagnostic-${i}:` + "x".repeat(40000), label: `task ${i}` })) };
  const reply = JSON.parse(packIndependentCommunication(captured).content[0].text);
  assert.deepEqual(reply.agents[0].error, captured.agents[0].error);
  assert.equal(reply.agents[1].error, undefined);
  for (const [i, row] of reply.agents.entries()) {
    assert.equal(row.label, captured.agents[i].label);
  }
  assert.equal(reply.response_limit_reached, true);
});

test("required independent lifecycle facts cannot be silently removed to fit", () => {
  const captured = freeze({ agent: "otter", status: "cleanup_uncertain", required_control: "\0".repeat(16384) });
  const before = structuredClone(captured);
  assert.throws(() => packIndependentCommunication(captured), { code: "COMMUNICATION_REPLY_TOO_LARGE" });
  assert.deepEqual(captured, before);
});
