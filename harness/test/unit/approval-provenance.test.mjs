import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalBindings } from "../../dist/permissions/approval-provenance.js";

const key = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
const owner = { owner_id: "approval-owner", generation: "owner-generation" };
const run = { ...owner, agent_id: "agent", run_id: "run-1", task_prompt: "Inspect the public fixture." };
const input = { sessionId: "approval-child", cwd: "/fixture", profile: "reader", definitionDigest: "definition", prompt: `Inherited notes\n\n${run.task_prompt}` };
function fixture() {
  globalThis[key] = new Map();
  const events = [], hooks = new Map();
  const binding = new ApprovalBindings({ emit: (name, payload) => events.push({ name, payload }) }, owner);
  binding.childExtension(input.sessionId)({ on: (name, fn) => hooks.set(name, fn) });
  const emit = (name, event) => hooks.get(name)?.(event);
  emit("session_start", {});
  const start = () => emit("before_agent_start", { prompt: input.prompt, systemPrompt: "Loaded instruction snapshot" });
  const message = (text = input.prompt) => emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
  return { binding, events, emit, start, message, facts: () => globalThis[key].get(input.sessionId) };
}

test("approval witness binds actual inherited prompt, identity and loaded instructions; fresh resume", () => {
  const f = fixture();
  f.binding.contextChanged({ ...run, event_id: "admit", kind: "submit" });
  assert.equal(f.events[0].name, "pi-harness:approval:admitted");
  f.binding.begin(run, input);
  assert.equal(f.facts().initialPromptDigest, undefined, "not bound before SDK observes the prompt");
  f.start(); f.message();
  assert.equal(f.events[1].name, "pi-harness:approval:started");
  assert.equal(f.facts().parentSessionId, owner.owner_id, "ID, never a JSONL path");
  assert.equal(f.facts().harness.task_prompt, run.task_prompt);
  assert.equal(f.facts().harness.prompt, input.prompt);
  assert.equal(f.facts().harness.systemPrompt, "Loaded instruction snapshot");
  assert.equal(f.facts().contextChanged, false);
  for (const key of ["owner_id", "generation", "agent_id", "run_id"]) {
    f.binding.end(input.sessionId, { ...run, [key]: "wrong" });
    assert(f.facts(), `wrong ${key} must not revoke the witness`);
  }
  f.binding.end(input.sessionId, run);
  assert.equal(f.facts(), undefined);
  assert.deepEqual(f.events.at(-1).payload, { sessionId: input.sessionId, owner_id: run.owner_id,
    generation: run.generation, agent_id: run.agent_id, run_id: run.run_id });
  const next = { ...run, run_id: "run-2" };
  f.binding.contextChanged({ ...next, event_id: "resume", kind: "resume" });
  f.binding.begin(next, input); f.start(); f.message();
  f.binding.end(input.sessionId, run);
  assert.equal(f.facts().harness.run_id, next.run_id, "late old cleanup cannot revoke new Run");
  assert.equal(f.facts().contextChanged, false);
  f.emit("session_shutdown", {});
  assert.equal(f.facts(), undefined);
});

for (const kind of ["steer", "soft_budget", "cancel", "hard_budget"]) test(`${kind} synchronously revokes approval before dispatch`, () => {
  const f = fixture(); f.binding.begin(run, input); f.start(); f.message();
  f.binding.contextChanged({ ...run, event_id: kind, session_id: input.sessionId, kind });
  assert.equal(f.facts().contextChanged, true);
  f.start();
  assert.equal(f.facts().contextChanged, true, "a later hook cannot revive authority");
});

test("mismatched, repeated prompts and extra user messages fail closed", () => {
  for (const extra of ["wrong-prompt", "second-start", "second-user", "wrong-user"]) {
    const f = fixture(); f.binding.begin(run, input);
    if (extra === "wrong-prompt") f.emit("before_agent_start", { prompt: "wrong", systemPrompt: "x" });
    else {
      f.start();
      if (extra === "second-start") f.start();
      else if (extra === "wrong-user") f.message("wrong");
      else { f.message(); f.message("injected follow-up"); }
    }
    assert.equal(f.facts().contextChanged, true, extra);
  }
});

test("complete child actions are observed before permissions and removed on tool exit", () => {
  const f = fixture(); f.binding.begin(run, input); f.start(); f.message();
  const args = { command: "printf one; printf two", timeout: 4 };
  f.emit("tool_execution_start", { toolCallId: "call", toolName: "bash", args });
  args.command = "changed caller object";
  assert.deepEqual(f.facts().toolCalls.call, { name: "bash", arguments: { command: "printf one; printf two", timeout: 4 } });
  const observer = globalThis[Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers")].get(input.sessionId);
  observer({ requestId: "ask", toolCallId: "call" });
  assert.equal(f.facts().requestTools.ask, "call", "the forwarding edge, not nearest-call inference, binds the request");
  observer({ requestId: "unseen", toolCallId: "wrong" });
  assert.equal(f.facts().requestTools.unseen, undefined);
  f.emit("tool_execution_end", { toolCallId: "call" });
  assert.equal(f.facts().toolCalls.call, undefined);
  assert.equal(f.facts().requestTools.ask, undefined);
  f.binding.end(input.sessionId, run);
  f.binding.begin({ ...run, run_id: "next" }, input);
  assert.equal(f.facts().requestTools.ask, undefined, "a resumed Run cannot inherit an old forwarded request");
});

test("wrong owner cannot publish a binding", () => {
  const f = fixture();
  assert.throws(() => f.binding.begin({ ...run, owner_id: "other" }, input), /OWNER|RUN_MISMATCH/);
  assert.equal(f.facts(), undefined);
  assert.throws(() => f.binding.contextChanged({ ...run, generation: "other", kind: "submit" }), /OWNER_MISMATCH/);
});

test("leftover owned witness makes one Run manual without throwing or poisoning future reuse", () => {
  const f = fixture();
  assert.equal(f.binding.begin(run, input), true); f.start(); f.message();
  const next = { ...run, run_id: "next" };
  assert.equal(f.binding.begin(next, input), false);
  assert.equal(f.facts().harness.run_id, next.run_id);
  assert.equal(f.facts().contextChanged, true);
  f.start(); f.message();
  f.emit("tool_execution_start", { toolCallId: "new", toolName: "bash", args: { command: "true" } });
  assert.equal(f.facts().initialPromptDigest, undefined);
  assert.equal(f.facts().toolCalls.new, undefined);
  f.binding.end(input.sessionId, run);
  assert(f.facts(), "late old end must not erase current manual Run");
  f.binding.end(input.sessionId, next);
  assert.equal(f.facts(), undefined);
  assert.equal(f.binding.begin({ ...run, run_id: "fresh" }, input), true);
  f.start(); f.message();
  assert.equal(f.facts().contextChanged, false);
});

test("end retires local identity even when the shared witness has disappeared", () => {
  const f = fixture(); f.binding.begin(run, input); f.start(); f.message();
  globalThis[key].delete(input.sessionId);
  f.binding.end(input.sessionId, run);
  assert.equal(f.events.at(-1).name, "pi-harness:approval:finished");
  assert.equal(f.binding.begin({ ...run, run_id: "next" }, input), true);
});

test("a foreign or replacement witness is not used, overwritten or deleted", () => {
  const f = fixture(); f.binding.begin(run, input); f.start(); f.message();
  const foreign = structuredClone(f.facts());
  foreign.harness.generation = "foreign-generation";
  globalThis[key].set(input.sessionId, foreign);
  assert.equal(f.binding.begin({ ...run, run_id: "next" }, input), false);
  f.start(); f.message();
  f.emit("tool_execution_start", { toolCallId: "new", toolName: "bash", args: { command: "true" } });
  f.emit("session_shutdown", {});
  assert.strictEqual(f.facts(), foreign);
  assert.equal(foreign.contextChanged, false);
  assert.equal(foreign.toolCalls.new, undefined);
});

for (const [name, args] of [
  ["function member", { invalid() {} }], ["null", null], ["string", "not an object"],
  ["array", []], ["date", new Date()], ["throwing getter", { get command() { throw new Error("bad getter"); } }],
]) test(`invalid tool arguments revoke the witness without throwing: ${name}`, () => {
  const f = fixture(); f.binding.begin(run, input); f.start(); f.message();
  assert.doesNotThrow(() => f.emit("tool_execution_start", { toolCallId: "invalid", toolName: "bash", args }));
  assert.equal(f.facts().contextChanged, true);
  assert.equal(f.facts().toolCalls.invalid, undefined);
  f.emit("tool_execution_start", { toolCallId: "later", toolName: "bash", args: { command: "true" } });
  assert.equal(f.facts().toolCalls.later, undefined, "a later valid event cannot revive the invalidated Run");
});
