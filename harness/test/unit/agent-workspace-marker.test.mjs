import assert from "node:assert/strict";
import test from "node:test";
import { taskMetadata } from "../../dist/core/task-metadata.js";
import { agentRow, taskReply } from "../../dist/tools/replies.js";

const workspace = { mode: "worktree", cwd: "/tree", source_cwd: "/source", base_commit: "a".repeat(40) };
const source = (rest = {}) => ({ description: "task", isolation: "worktree", status: "running", execution_exited: false, ...rest });
const hasPending = metadata => Object.hasOwn(metadata, "workspace_pending");

test("only inspection of a queued/running original unbound worktree task has a pending control", () => {
  for (const status of ["queued", "running"]) {
    const input = Object.freeze(source({ status }));
    assert.deepEqual(taskMetadata(input, true), { label: "task", workspace_pending: true });
    assert.deepEqual(taskMetadata(input), { label: "task" });
    assert.deepEqual(taskMetadata(input, false), { label: "task" });
    assert.equal(taskMetadata({ ...input, execution_exited: undefined }, true).workspace_pending, true);
    assert.equal(hasPending(taskMetadata({ ...input, execution_exited: true }, true)), false, "finalization is not allocation pending");
  }
  for (const status of [undefined, "cancelling", "cancelled", "completed", "needs_input", "failed"])
    assert.equal(hasPending(taskMetadata(source({ status }), true)), false, String(status));
  assert.equal(hasPending(taskMetadata(source({ isolation: "shared" }), true)), false);
});

test("confirmed bindings and any observed recovery suppress pending without inventing a path", () => {
  const bound = taskMetadata(source({ workspace }), true);
  assert.deepEqual(bound, { label: "task", workspace });
  assert.notEqual(bound.workspace, workspace);
  for (const recovery of [
    { mode: "worktree", state: "failed", source_cwd: "/source" },
    { mode: "worktree", state: "partial", source_cwd: "/source", allocated_path: "/state/allocation" },
    { mode: "worktree", state: "checkout_ready", source_cwd: "/source", checkout_root: "/tree", recovery_manifest: "/state/manifest" },
  ]) {
    const metadata = taskMetadata(source({ recovery }), true);
    assert.equal(hasPending(metadata), false); assert.equal(Object.hasOwn(metadata, "workspace"), false);
    assert.deepEqual(metadata.retained_paths, recovery.allocated_path ? ["/state/allocation"] :
      recovery.checkout_root ? ["/tree", "/state/manifest"] : undefined);
  }
  const earlier = Object.freeze(source({ status: "failed" })), later = source({ workspace });
  assert.equal(hasPending(taskMetadata(later, true)), false);
  assert.deepEqual(taskMetadata(earlier, true), { label: "task" }, "later bindings cannot fill the earlier original task");
});

test("roster opts in to pending projection; ordinary independent task replies do not", () => {
  const view = { ...source(), name: "wren", task: 1, resumable: true, has_question: false,
    owner_blocked: false, effective_settings: { profile: "editor", difficulty: 3 } };
  assert.equal(agentRow(view, () => "wren").workspace_pending, true);
  assert.equal(taskReply(view, () => "wren", true).workspace_pending, true);
  assert.equal(hasPending(taskReply(view, () => "wren")), false);
  assert.equal(hasPending(agentRow({ ...view, status: "failed" }, () => "wren")), false);
});
