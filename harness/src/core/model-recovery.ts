import type { Outcome } from "./contracts.js";

export const MODEL_RECOVERY_HINT_MAX_UNITS = 384;

const pinnedModelRecoveryHint = "Agent models stay fixed. Failure alone does not prove model unavailability. " +
  "If unavailable, ask the user to check worker configuration before explicitly spawning a fresh Agent with artifacts and a handoff. " +
  "Keep reasoning_difficulty task-based; normal admission and cleanup rules apply.";

/** Pure conditional guidance, not an availability verdict. Callers must confirm
 * settlement: an Outcome can exist while finalization is still pending. */
export function modelRecoveryHint(outcome: Outcome | undefined): string | undefined {
  return outcome?.status === "failed" && outcome.reason === "execution_error" && outcome.model_stop_reason === "error" ?
    pinnedModelRecoveryHint : undefined;
}
