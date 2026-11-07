import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Source-level witness check: no build output, SDK, credentials or network.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ApprovalBindings } = await jiti.import(
  "../../src/orchestration/permissions/approval-provenance.ts",
);

const key = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
const owner = { owner_id: "approval-owner", generation: "owner-generation" };
const run = {
  ...owner,
  agent_id: "agent",
  run_id: "run-1",
  task_prompt: "Inspect the public fixture.",
};
const input = {
  sessionId: "approval-child",
  cwd: "/fixture",
  profile: "editor",
  definitionDigest: "definition",
  prompt: `Inherited notes\n\n${run.task_prompt}`,
};
function fixture() {
  globalThis[key] = new Map();
  const events = [],
    hooks = new Map();
  const binding = new ApprovalBindings(
    { emit: (name, payload) => events.push({ name, payload }) },
    owner,
  );
  binding.childExtension(input.sessionId)({ on: (name, fn) => hooks.set(name, fn) });
  const emit = (name, event) => hooks.get(name)?.(event);
  emit("session_start", {});
  const start = () =>
    emit("before_agent_start", {
      messageType: "user",
      prompt: input.prompt,
      systemPrompt: "Loaded instruction snapshot",
    });
  const message = (text = input.prompt) =>
    emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
  return {
    binding,
    events,
    emit,
    start,
    message,
    facts: () => globalThis[key].get(input.sessionId),
  };
}

test("approval witness binds actual inherited prompt, identity and loaded instructions; fresh resume", () => {
  const f = fixture();
  f.binding.contextChanged({ ...run, event_id: "admit", kind: "submit" });
  assert.equal(f.events[0].name, "pi-alehouse:approval:admitted");
  f.binding.begin(run, input);
  assert.equal(
    f.facts().initialPromptDigest,
    undefined,
    "not bound before SDK observes the prompt",
  );
  f.start();
  f.message();
  assert.equal(f.events[1].name, "pi-alehouse:approval:started");
  assert.equal(f.facts().parentSessionId, owner.owner_id, "ID, never a JSONL path");
  assert.equal(f.facts().delegation.task_prompt, run.task_prompt);
  assert.equal(f.facts().delegation.prompt, input.prompt);
  assert.equal(f.facts().delegation.systemPrompt, "Loaded instruction snapshot");
  assert.equal(f.facts().contextChanged, false);
  for (const key of ["owner_id", "generation", "agent_id", "run_id"]) {
    f.binding.end(input.sessionId, { ...run, [key]: "wrong" });
    assert(f.facts(), `wrong ${key} must not revoke the witness`);
  }
  f.binding.end(input.sessionId, run);
  assert.equal(f.facts(), undefined);
  assert.deepEqual(f.events.at(-1).payload, {
    sessionId: input.sessionId,
    owner_id: run.owner_id,
    generation: run.generation,
    agent_id: run.agent_id,
    run_id: run.run_id,
  });
  const next = { ...run, run_id: "run-2" };
  f.binding.contextChanged({ ...next, event_id: "resume", kind: "resume" });
  f.binding.begin(next, input);
  f.start();
  f.message();
  f.binding.end(input.sessionId, run);
  assert.equal(f.facts().delegation.run_id, next.run_id, "late old cleanup cannot revoke new Run");
  assert.equal(f.facts().contextChanged, false);
  f.emit("session_shutdown", {});
  assert.equal(f.facts(), undefined);
});

for (const kind of ["steer", "soft_budget", "cancel", "hard_budget"])
  test(`${kind} synchronously revokes approval before dispatch`, () => {
    const f = fixture();
    f.binding.begin(run, input);
    f.start();
    f.message();
    f.binding.contextChanged({ ...run, event_id: kind, session_id: input.sessionId, kind });
    assert.equal(f.facts().contextChanged, true);
    f.start();
    assert.equal(f.facts().contextChanged, true, "a later hook cannot revive authority");
  });

test("unrecognized start shapes fail closed and never activate the witness", () => {
  // The pinned SDK makes messageType a required discriminator. The old
  // unlabelled shape (no messageType), a malformed user start (messageType
  // "user" without a string prompt) and an unknown discriminator all
  // invalidate the witness: no started event, no bound prompt digest, one
  // explicit prompt-free diagnostic, and a later message cannot revive it.
  for (const start of [
    { prompt: input.prompt, systemPrompt: "Loaded instruction snapshot" },
    { messageType: "user", systemPrompt: "Loaded instruction snapshot" },
    { messageType: "fixture-unknown", prompt: input.prompt, systemPrompt: "x" },
  ]) {
    const f = fixture();
    f.binding.begin(run, input);
    f.emit("before_agent_start", start);
    assert.equal(f.facts().initialPromptDigest, undefined);
    assert.equal(f.facts().contextChanged, true);
    assert.equal(
      f.events.filter((event) => event.name === "pi-alehouse:approval:started").length,
      0,
      "an unrecognized shape emits no started event",
    );
    const diagnostics = f.events.filter(
      (event) => event.name === "pi-alehouse:approval:witness-invalidated",
    );
    assert.equal(diagnostics.length, 1, "one explicit invalidation diagnostic");
    assert.equal(typeof diagnostics[0].payload.reason, "string");
    for (const secret of [input.prompt, "Loaded instruction snapshot"])
      assert(
        !JSON.stringify(diagnostics).includes(secret),
        "the diagnostic never carries prompt or instruction text",
      );
    f.message();
    assert.equal(f.facts().contextChanged, true, "a later message cannot revive it");
    assert.equal(
      f.events.filter((event) => event.name === "pi-alehouse:approval:witness-invalidated").length,
      1,
      "the diagnostic is deduplicated per session",
    );
  }
});

test("unsupported start shapes report a fixed reason vocabulary", () => {
  for (const [start, reason] of [
    [{ prompt: input.prompt }, "missing_message_type"],
    [{ messageType: "fixture-unknown", prompt: input.prompt }, "unknown_message_type"],
    [{ messageType: "user", systemPrompt: "Loaded instruction snapshot" }, "malformed_user_start"],
  ]) {
    const f = fixture();
    f.binding.begin(run, input);
    f.emit("before_agent_start", start);
    const diagnostic = f.events.find(
      (event) => event.name === "pi-alehouse:approval:witness-invalidated",
    );
    assert.equal(diagnostic?.payload.reason, reason);
    assert.equal(diagnostic.payload.sessionId, input.sessionId);
    assert.equal(f.facts().contextChanged, true);
  }
  // An event whose shape cannot even be read is still fail-closed and
  // diagnosed once; the unreadable fixture never reaches the prompt.
  const f = fixture();
  f.binding.begin(run, input);
  f.emit(
    "before_agent_start",
    new Proxy(
      {},
      {
        get() {
          throw new Error("unreadable fixture event");
        },
      },
    ),
  );
  assert.equal(f.facts().contextChanged, true);
  assert.equal(
    f.events.find((event) => event.name === "pi-alehouse:approval:witness-invalidated")?.payload
      .reason,
    "unreadable_start_event",
  );
});

test("legitimate custom starts and well-formed mismatches invalidate without a shape diagnostic", () => {
  // A custom-message run is a valid non-human start and a wrong-prompt user
  // start is a normal fail-closed mismatch: neither is a host-shape fault,
  // so both stay silent while still never emitting started.
  for (const start of [
    {
      messageType: "custom",
      message: { role: "custom", content: input.prompt },
      systemPrompt: "Loaded instruction snapshot",
    },
    { messageType: "user", prompt: "wrong-prompt", systemPrompt: "Loaded instruction snapshot" },
  ]) {
    const f = fixture();
    f.binding.begin(run, input);
    f.emit("before_agent_start", start);
    assert.equal(f.facts().contextChanged, true);
    assert.equal(f.events.length, 0, "no started event and no shape diagnostic");
  }
});

test("mismatched, repeated prompts and extra user messages fail closed", () => {
  for (const extra of [
    "wrong-prompt",
    "custom-start",
    "second-start",
    "second-user",
    "wrong-user",
  ]) {
    const f = fixture();
    f.binding.begin(run, input);
    if (extra === "wrong-prompt")
      f.emit("before_agent_start", { messageType: "user", prompt: "wrong", systemPrompt: "x" });
    // Pi 1.2 also starts runs from custom messages; none carries the orchestration prompt.
    else if (extra === "custom-start")
      f.emit("before_agent_start", {
        messageType: "custom",
        message: { role: "custom", content: input.prompt },
        systemPrompt: "x",
      });
    else {
      f.start();
      if (extra === "second-start") f.start();
      else if (extra === "wrong-user") f.message("wrong");
      else {
        f.message();
        f.message("injected follow-up");
      }
    }
    assert.equal(f.facts().contextChanged, true, extra);
  }
});

test("complete child actions are observed before permissions and removed on tool exit", () => {
  const f = fixture();
  f.binding.begin(run, input);
  f.start();
  f.message();
  const args = { command: "printf one; printf two", timeout: 4 };
  f.emit("tool_execution_start", { toolCallId: "call", toolName: "bash", args });
  args.command = "changed caller object";
  assert.deepEqual(f.facts().toolCalls.call, {
    name: "bash",
    arguments: { command: "printf one; printf two", timeout: 4 },
  });
  const observer = globalThis[
    Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers")
  ].get(input.sessionId);
  observer({ requestId: "ask", toolCallId: "call" });
  assert.equal(
    f.facts().requestTools.ask,
    "call",
    "the forwarding edge, not nearest-call inference, binds the request",
  );
  observer({ requestId: "unseen", toolCallId: "wrong" });
  assert.equal(f.facts().requestTools.unseen, undefined);
  f.emit("tool_execution_end", { toolCallId: "call" });
  assert.equal(f.facts().toolCalls.call, undefined);
  assert.equal(f.facts().requestTools.ask, undefined);
  f.binding.end(input.sessionId, run);
  f.binding.begin({ ...run, run_id: "next" }, input);
  assert.equal(
    f.facts().requestTools.ask,
    undefined,
    "a resumed Run cannot inherit an old forwarded request",
  );
});

test("wrong owner cannot publish a binding", () => {
  const f = fixture();
  assert.throws(() => f.binding.begin({ ...run, owner_id: "other" }, input), /OWNER|RUN_MISMATCH/);
  assert.equal(f.facts(), undefined);
  assert.throws(
    () => f.binding.contextChanged({ ...run, generation: "other", kind: "submit" }),
    /OWNER_MISMATCH/,
  );
});

test("leftover owned witness makes one Run manual without throwing or poisoning future reuse", () => {
  const f = fixture();
  assert.equal(f.binding.begin(run, input), true);
  f.start();
  f.message();
  const next = { ...run, run_id: "next" };
  assert.equal(f.binding.begin(next, input), false);
  assert.equal(f.facts().delegation.run_id, next.run_id);
  assert.equal(f.facts().contextChanged, true);
  f.start();
  f.message();
  f.emit("tool_execution_start", {
    toolCallId: "new",
    toolName: "bash",
    args: { command: "true" },
  });
  assert.equal(f.facts().initialPromptDigest, undefined);
  assert.equal(f.facts().toolCalls.new, undefined);
  f.binding.end(input.sessionId, run);
  assert(f.facts(), "late old end must not erase current manual Run");
  f.binding.end(input.sessionId, next);
  assert.equal(f.facts(), undefined);
  assert.equal(f.binding.begin({ ...run, run_id: "fresh" }, input), true);
  f.start();
  f.message();
  assert.equal(f.facts().contextChanged, false);
});

test("end retires local identity even when the shared witness has disappeared", () => {
  const f = fixture();
  f.binding.begin(run, input);
  f.start();
  f.message();
  globalThis[key].delete(input.sessionId);
  f.binding.end(input.sessionId, run);
  assert.equal(f.events.at(-1).name, "pi-alehouse:approval:finished");
  assert.equal(f.binding.begin({ ...run, run_id: "next" }, input), true);
});

test("a foreign or replacement witness is not used, overwritten or deleted", () => {
  const f = fixture();
  f.binding.begin(run, input);
  f.start();
  f.message();
  const foreign = structuredClone(f.facts());
  foreign.delegation.generation = "foreign-generation";
  globalThis[key].set(input.sessionId, foreign);
  assert.equal(f.binding.begin({ ...run, run_id: "next" }, input), false);
  f.start();
  f.message();
  f.emit("tool_execution_start", {
    toolCallId: "new",
    toolName: "bash",
    args: { command: "true" },
  });
  f.emit("session_shutdown", {});
  assert.strictEqual(f.facts(), foreign);
  assert.equal(foreign.contextChanged, false);
  assert.equal(foreign.toolCalls.new, undefined);
});

for (const [name, args] of [
  ["function member", { invalid() {} }],
  ["null", null],
  ["string", "not an object"],
  ["array", []],
  ["date", new Date()],
  [
    "throwing getter",
    {
      get command() {
        throw new Error("bad getter");
      },
    },
  ],
])
  test(`invalid tool arguments revoke the witness without throwing: ${name}`, () => {
    const f = fixture();
    f.binding.begin(run, input);
    f.start();
    f.message();
    assert.doesNotThrow(() =>
      f.emit("tool_execution_start", { toolCallId: "invalid", toolName: "bash", args }),
    );
    assert.equal(f.facts().contextChanged, true);
    assert.equal(f.facts().toolCalls.invalid, undefined);
    f.emit("tool_execution_start", {
      toolCallId: "later",
      toolName: "bash",
      args: { command: "true" },
    });
    assert.equal(
      f.facts().toolCalls.later,
      undefined,
      "a later valid event cannot revive the invalidated Run",
    );
  });
