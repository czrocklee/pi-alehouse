import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_RECOVERY_HINT_MAX_UNITS, modelRecoveryHint } from "../../dist/core/model-recovery.js";

// Pure structured-outcome projection, not evidence of provider availability.
const outcome = (rest = {}) => ({ status: "failed", reason: "execution_error", model_stop_reason: "error",
  limit_reached: false, ...rest });

test("only the failed execution_error/error outcome selects whole conditional pinned-model recovery guidance", () => {
  const retained = Object.freeze(outcome()), hint = modelRecoveryHint(retained);
  assert.equal(MODEL_RECOVERY_HINT_MAX_UNITS, 384);
  assert.equal(typeof hint, "string"); assert(hint.trim().length > 0 && hint.length <= 384);
  assert.match(hint, /Agent models stay fixed/);
  assert.doesNotMatch(hint, /agent_run|agent_answer/);
  assert.match(hint, /Failure alone does not prove model unavailability/);
  assert.match(hint, /If unavailable, ask the user to check worker configuration/);
  assert.match(hint, /before explicitly spawning a fresh Agent with artifacts and a handoff/);
  assert.match(hint, /normal admission and cleanup rules apply/);
  assert.match(hint, /Keep reasoning_difficulty task-based/);
  assert.deepEqual(retained, outcome(), "derivation adds no retained state");
  assert.equal(modelRecoveryHint(retained), hint, "repeat projection is deterministic");
});

test("quota/limit words alone never classify an unavailable model or select the hint", () => {
  for (const error of ["quota exceeded", "rate limit", "usage limit reached", "model unavailable", "provider/model disabled"]) {
    for (const retained of [outcome({ model_stop_reason: undefined, error }), outcome({ model_stop_reason: "stop", error }),
      outcome({ reason: undefined, error }), outcome({ reason: "quota", error }), outcome({ reason: "limit", error })])
      assert.equal(modelRecoveryHint(retained), undefined, error);
    assert.equal(modelRecoveryHint(outcome({ error })), modelRecoveryHint(outcome()),
      "the exact structured failure gets the same conditional advice, not a quota diagnosis");
  }
});

for (const [name, retained] of [
  ["no retained outcome", undefined],
  ["output limit", outcome({ reason: "output_limit", model_stop_reason: "length" })],
  ["deadline", outcome({ reason: "deadline" })],
  ["turn limit", outcome({ reason: "turn_limit", limit_reached: true })],
  ["user cancel", outcome({ status: "cancelled", reason: undefined })],
  ["needs input", outcome({ status: "needs_input", question: "Choose?" })],
  ["completed", outcome({ status: "completed" })],
  ["unexpected abort", outcome({ reason: "unexpected_abort", model_stop_reason: "aborted" })],
  ["missing model stop reason", outcome({ model_stop_reason: undefined })],
  ["unknown model stop reason", outcome({ model_stop_reason: "future_reason" })],
  ["failed initialization", outcome({ reason: "initialization_failed" })],
  ["failed finalization", outcome({ reason: "finalization_failed" })],
]) test(`${name} has no pinned-model recovery hint`, () => {
  assert.equal(modelRecoveryHint(retained && Object.freeze(retained)), undefined);
});

test("trusted recovery guidance contains no raw error or concrete provider/model and never reads them", () => {
  const raw = "RAW_PRIVATE_ERROR fixture-provider/controlled-model quota disabled";
  const retained = Object.freeze(outcome({ error: raw, provider: "fixture-provider", model: "controlled-model" }));
  const hint = modelRecoveryHint(retained);
  assert.doesNotMatch(hint, /RAW_PRIVATE_ERROR|fixture-provider|controlled-model|quota|disabled/);
  const unreadable = outcome();
  for (const key of ["error", "provider", "model", "question", "limit_reached"])
    Object.defineProperty(unreadable, key, { get() { throw new Error(`must not read ${key}`); } });
  assert.equal(modelRecoveryHint(Object.freeze(unreadable)), hint,
    "only the three structured discriminator fields are inputs, never raw text or model inventory");
});
