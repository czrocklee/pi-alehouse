import assert from "node:assert/strict";
import test from "node:test";
import { errorReply, taskReply } from "../../dist/orchestration/tools/replies.js";
import {
  checkParentToolArguments,
  spawnSchema,
} from "../../dist/orchestration/tools/parent-schemas.js";

const spawn = {
  agent: "pine",
  prompt: "Review local source.",
  label: "Review local source",
  profile: "scout",
  reasoning_difficulty: 3,
};
const returnTo = {
  agent: "oak",
  question_id: `q_${"a".repeat(32)}`,
  instruction: "Use the findings to choose the next step.",
};

test("public vocabulary has no old or mixed dispatch/return_to aliases", () => {
  const current = {
    ...spawn,
    return_to: returnTo,
    dispatch: { required_paths: ["src"], build_dir: "build" },
  };
  assert.deepEqual(checkParentToolArguments("agent_spawn", spawnSchema, current), current);
  for (const args of [
    { ...current, dispatch: { inputs: ["src"] } },
    { ...current, dispatch: { tree: "build" } },
    { ...current, dispatch: { required_paths: ["src"], inputs: ["other"] } },
    { ...current, dispatch: { build_dir: "build", tree: "other" } },
    { ...current, return_to: { agent: "oak", question_id: returnTo.question_id, answer: "old" } },
    { ...current, return_to: { ...returnTo, answer: "old" } },
  ]) {
    assert.throws(
      () => checkParentToolArguments("agent_spawn", spawnSchema, args),
      (error) => error.code === "INVALID_PARAMETERS",
    );
  }
});

test("error projection maps typed vocabulary without changing caller path bytes or core facts", () => {
  for (const [internalCode, publicCode, key, parameter] of [
    ["BUILD_TREE_BUSY", "BUILD_DIR_BUSY", "tree", "build_dir"],
    ["DISPATCH_TREE_TYPE", "DISPATCH_BUILD_DIR_TYPE", "dispatch.tree", "dispatch.build_dir"],
    [
      "DISPATCH_TREE_INSPECTION_FAILED",
      "DISPATCH_BUILD_DIR_INSPECTION_FAILED",
      "tree",
      "build_dir",
    ],
    [
      "DISPATCH_INPUT_MISSING",
      "DISPATCH_REQUIRED_PATH_MISSING",
      "dispatch.inputs.0",
      "dispatch.required_paths.0",
    ],
    ["DISPATCH_INPUT_TYPE", "DISPATCH_REQUIRED_PATH_TYPE", "inputs", "required_paths"],
    [
      "DISPATCH_INPUT_INSPECTION_FAILED",
      "DISPATCH_REQUIRED_PATH_INSPECTION_FAILED",
      "inputs",
      "required_paths",
    ],
  ]) {
    const path = "tree/inputs/dispatch.inputs.0/build/tree";
    const diagnostic = "Do not rewrite this path: tree/inputs.";
    const details = Object.freeze({ key, requested: path, path, resolution: diagnostic });
    const original = Object.freeze({ code: internalCode, details });
    const projected = errorReply(original).error;
    assert.equal(projected.code, publicCode);
    assert.equal(projected.parameter, parameter);
    assert.equal(projected.path, path);
    assert.equal(projected.requested, path);
    assert.equal(projected.resolution, diagnostic);
    assert.equal(original.code, internalCode);
    assert.equal(original.details.key, key);
  }
  assert.deepEqual(
    errorReply({ code: "FIXTURE", details: { reason: "diagnostic", resolution: "unchanged" } }),
    { error: { code: "FIXTURE", reason: "diagnostic", resolution: "unchanged" } },
    "nested error.reason is not the observation or task outcome namespace",
  );
});

test("defensive typed answer-error projection preserves the public instruction field and agent_answer", () => {
  // Synthetic helper coverage, not evidence that valid model calls can reach
  // core answer-validation failures: the public raw checks reject them first.
  const detail = {
    key: "return_to.answer",
    resolution: "Give the worker's next instruction as non-blank text of at most 16384 characters.",
  };
  const projected = errorReply({ code: "INVALID_ANSWER", details: detail }).error;
  assert.equal(projected.parameter, "return_to.instruction");
  assert.match(projected.resolution, /return_to\.instruction/);
  assert.equal(detail.key, "return_to.answer");
  const answer = errorReply({
    code: "INVALID_ANSWER",
    details: { key: "answer", resolution: "Answer this question." },
  }).error;
  assert.equal(answer.parameter, "answer");
  assert.equal(answer.resolution, "Answer this question.");
});

test("error projection does not rewrite a generic core shape-diagnostic sentence", () => {
  const resolution =
    "return_to takes exactly agent, question_id and answer for one worker's pending question.";
  const projected = errorReply({
    code: "INVALID_RETURN_TO",
    details: { key: "return_to", resolution },
  }).error;
  assert.equal(projected.resolution, resolution);
  assert.equal(projected.parameter, "return_to");
});

test("independent task replies share terminal causes and project human provenance without rewriting it", () => {
  const view = {
    name: "pine",
    task: 1,
    description: "Review local source",
    status: "failed",
    phase: "settled",
    execution_exited: true,
    resumable: true,
    cancellation_source: "human",
    outcome: { status: "failed", reason: "output_limit", limit_reached: false },
  };
  const row = taskReply(view, () => "pine");
  assert.equal(row.outcome_reason, "output_limit");
  assert.equal(row.interrupted_by, "human");
  assert.equal(Object.hasOwn(row, "reason"), false);
  assert.equal(Object.hasOwn(row, "cancellation_source"), false);
  assert.equal(view.cancellation_source, "human");
  assert.equal(view.outcome.reason, "output_limit");
  const finishing = taskReply(
    { ...view, status: "running", phase: "finalizing", finalization_pending: true },
    () => "pine",
  );
  assert.equal(finishing.status, "finishing");
  assert.equal(finishing.outcome_reason, undefined);
  const unknown = taskReply(
    { ...view, outcome: { ...view.outcome, reason: "future-cause" } },
    () => "pine",
  );
  assert.equal(unknown.outcome_reason, "other");
});
