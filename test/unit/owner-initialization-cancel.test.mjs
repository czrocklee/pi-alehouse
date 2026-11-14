import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// Source OwnerController only. The dist controller fixture is intentionally
// unused: this regression must follow the public API against current source.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { OwnerController } = await jiti.import("../../src/orchestration/core/owner-controller.ts");
const { OrchestrationError } = await jiti.import("../../src/orchestration/core/ports.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const output = () => ({ text: "", total_chars: 0, truncated: false });
const settings = {
  provider: "fixture",
  model: "controlled",
  thinking: "off",
  parent_thinking: "off",
  thinking_resolution: "identity",
  profile: "editor",
  difficulty: 3,
  strength: "d3",
  preset: "fixture",
  preset_version: "v1",
  selection_digest: "2".repeat(64),
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  tools: ["read"],
  definition_digest: "1".repeat(64),
};

test("cancel during a pending createSession keeps the Agent busy, then reuses that session", async (t) => {
  const gate = Promise.withResolvers();
  const owner = {
    owner_id: randomUUID(),
    generation: randomUUID(),
    closed: false,
    assertHeld() {
      if (this.closed) throw new Error("FIXTURE_LEASE_LOST");
    },
    close() {
      this.closed = true;
    },
  };
  const prompts = [];
  let created = 0;
  let disposed = 0;
  const port = {
    session_id: randomUUID(),
    canInput: () => false,
    async run(prompt, callbacks) {
      prompts.push(prompt);
      callbacks.inputEntered();
      return { kind: "success", output: output() };
    },
    async steer() {
      return false;
    },
    async stop() {},
    clearInputs: () => [],
    async dispose() {
      disposed++;
      return { shutdownExited: true, errors: [] };
    },
  };
  const controller = await OwnerController.open({
    owner,
    concurrency: 1,
    createSession: async () => {
      created++;
      await gate.promise;
      return port;
    },
  });
  let released = false;
  t.after(async () => {
    if (released) return;
    gate.resolve();
    const report = await controller.shutdown(3000);
    assert.equal(report.closed, true);
  });

  const first = await controller.submit("initialize", {
    prompt: "first task",
    description: "first task",
    name: "oak",
    settings,
  });
  assert.equal(created, 1);
  assert.equal(controller.view(first.run_id).status, "running");
  assert.equal(controller.view(first.run_id).phase, "initializing");
  assert.equal(controller.view(first.run_id).execution_exited, false);

  const cancellation = controller.cancel(first.run_id);
  assert.equal(cancellation.result, "cancel_requested");
  assert.equal(cancellation.execution_exited, false);
  assert.equal(cancellation.snapshot.status, "cancelling");
  assert.equal(cancellation.snapshot.phase, "initializing");
  for (let i = 0; i < 20; i++) await tick();
  const pending = controller.view(first.run_id);
  assert.equal(pending.status, "cancelling");
  assert.equal(pending.phase, "initializing");
  assert.equal(pending.execution_exited, false);
  assert.equal(created, 1);
  assert.deepEqual(prompts, []);
  await assert.rejects(
    controller.submit("resume-while-initializing", {
      resume: first.agent_id,
      prompt: "follow-up",
    }),
    (error) => {
      assert.ok(error instanceof OrchestrationError);
      assert.equal(error.code, "AGENT_BUSY");
      assert.equal(error.details.run_id, first.run_id);
      return true;
    },
  );
  assert.equal(created, 1);

  gate.resolve();
  assert.equal(
    await controller.waitForRuns([first.run_id], { mode: "all", timeout_ms: 3000 }),
    "ready",
  );
  const cancelled = controller.view(first.run_id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "settled");
  assert.equal(cancelled.stop_reason, "user_cancel");
  assert.equal(cancelled.execution_exited, true);
  assert.deepEqual(prompts, []);
  assert.equal(created, 1);
  assert.equal(disposed, 0);

  const resumed = await controller.submit("resume-after-cancel", {
    resume: first.agent_id,
    prompt: "follow-up",
  });
  assert.equal(resumed.agent_id, first.agent_id);
  assert.notEqual(resumed.run_id, first.run_id);
  assert.equal(
    await controller.waitForRuns([resumed.run_id], { mode: "all", timeout_ms: 3000 }),
    "ready",
  );
  assert.equal(controller.view(resumed.run_id).status, "completed");
  assert.equal(controller.view(resumed.run_id).phase, "settled");
  assert.equal(controller.view(first.run_id).status, "cancelled");
  assert.equal(created, 1);
  assert.deepEqual(prompts, ["follow-up"]);

  const report = await controller.shutdown(3000);
  released = true;
  assert.equal(report.closed, true);
  assert.equal(owner.closed, true);
  assert.equal(created, 1);
  assert.equal(disposed, 1);
});
