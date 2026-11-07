import assert from "node:assert/strict";
import test from "node:test";
import {
  validModelStopReason,
  validOutcome,
  validRouting,
} from "../../src/shared/history-codec.mjs";

// The shared codec source for both the live writer (run-journal.ts) and the
// offline analyzer; this matrix pins the current legal shapes so the two
// consumers can never drift apart.
const inherited = {
  preset: "team",
  preset_version: "v2",
  selection_digest: "a".repeat(64),
  difficulty: 3,
  strength: "d3",
  thinking: "high",
  parent_thinking: "low",
  thinking_resolution: "automatic_mapping",
  effort_source: "preset",
  provider: "p",
  model: "m",
  profile: "editor",
};
const fixed = { ...inherited, thinking_resolution: "preset_fixed" };
delete fixed.parent_thinking; // A preset's fixed effort may omit the parent route.

test("routing rejects null, primitives, arrays and non-object records without throwing", () => {
  for (const bad of [null, undefined, 0, 3, "", "team", true, [], ["d3"], () => {}]) {
    assert.equal(validRouting(bad), false, `routing must reject ${String(bad)}`);
  }
  assert.equal(validRouting(new Date()), false);
});

test("routing requires exactly a 64-lowercase-hex selection digest", () => {
  for (const digest of [
    undefined,
    null,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    ["a".repeat(64)],
    { hex: "a".repeat(64) },
  ]) {
    assert.equal(validRouting({ ...inherited, selection_digest: digest }), false);
  }
  assert.equal(validRouting({ ...inherited, selection_digest: "0".repeat(64) }), true);
});

test("routing accepts the current optional shapes and rejects retired formats", () => {
  for (const difficulty of [1, 2, 3, 4, 5]) {
    assert.equal(
      validRouting({ ...inherited, difficulty, strength: `d${difficulty}` }),
      true,
      "an inherited route with a matched current slot is current data",
    );
    assert.equal(validRouting({ ...fixed, difficulty, strength: `d${difficulty}` }), true);
  }
  for (const legal of [
    { ...inherited, effort_source: "user_override" },
    { ...inherited, thinking_resolution: "identity" },
    { ...fixed, parent_thinking: "medium" },
    { ...fixed, effort_source: "preset" },
  ]) {
    const withoutSource = { ...legal };
    delete withoutSource.effort_source;
    assert.equal(validRouting(legal), true);
    assert.equal(validRouting(withoutSource), true, "effort_source stays optional");
  }
  for (const retired of [
    { ...inherited, strength: "standard" },
    { ...inherited, strength: "strong" },
    { ...inherited, strength: `d${inherited.difficulty === 5 ? 1 : inherited.difficulty + 1}` },
    { ...inherited, difficulty: 0 },
    { ...inherited, difficulty: 6 },
    { ...inherited, difficulty: 3.5 },
    { ...inherited, difficulty: undefined },
    { ...inherited, thinking_resolution: "preset_mapping" },
    { ...inherited, thinking_resolution: undefined, parent_thinking: undefined },
    { ...inherited, effort_source: "auto" },
    { ...inherited, effort_source: null },
    { ...inherited, thinking: "" },
    { ...inherited, preset: undefined },
    { ...inherited, parent_thinking: "" },
    { ...inherited, parent_thinking: undefined },
    { ...fixed, parent_thinking: undefined },
  ]) {
    assert.equal(validRouting(retired), false, `retired shape must stay unsupported`);
  }
});

test("outcomes accept current legal shapes and reject unknown or retired fields", () => {
  assert.equal(validModelStopReason(undefined), true);
  assert.equal(validModelStopReason("stop"), true);
  assert.equal(validModelStopReason("x".repeat(128)), true);
  for (const bad of [null, "", "x".repeat(129), 3, [], {}]) {
    assert.equal(validModelStopReason(bad), false);
  }
  for (const legal of [
    { status: "completed", limit_reached: false },
    { status: "completed", limit_reached: true, model_stop_reason: "stop" },
    { status: "needs_input", limit_reached: false, question: "which tree?" },
    { status: "failed", limit_reached: false, error: "boom" },
    {
      status: "cancelled",
      limit_reached: false,
      reason: "user_cancel",
      cancellation_source: "human",
      model_stop_reason: "aborted",
    },
    // Optional fields may be present with an undefined value, matching the
    // writer's current optionality on both sides of the shared codec.
    { status: "completed", limit_reached: false, reason: undefined },
  ]) {
    assert.equal(validOutcome(legal), true, JSON.stringify(legal));
  }
  for (const bad of [null, undefined, 3, "completed", [], ["completed"]]) {
    assert.equal(validOutcome(bad), false);
  }
  for (const retired of [
    { status: "completed", limit_reached: false, time_wrapped: true },
    { status: "completed", limit_reached: false, unknown_field: "x" },
    { status: "completed" },
    { status: "completed", limit_reached: "false" },
    { status: "completed", limit_reached: undefined },
    { status: "finished", limit_reached: false },
    { status: "cancelled", limit_reached: false, cancellation_source: "model" },
    { status: "failed", limit_reached: false, error: 7 },
    { status: "needs_input", limit_reached: false, question: null },
    { status: "completed", limit_reached: false, model_stop_reason: "" },
  ]) {
    assert.equal(
      validOutcome(retired),
      false,
      `outcome must stay closed: ${JSON.stringify(retired)}`,
    );
  }
});
