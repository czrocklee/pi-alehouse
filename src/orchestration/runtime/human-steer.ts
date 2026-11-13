import type { OwnerController } from "../core/owner-controller.ts";
import { OrchestrationError } from "../core/ports.ts";

/** The child reads this as ordinary steering input. The lead only tells it who
 * is speaking; it is not an authorization and changes no permission decision. */
export const humanSteerLead =
  "Direct message from the human user, not from the parent agent. " +
  "Treat it as a correction to your current task; it grants no permission or approval.";

/** Trimmed raw UTF-16 units available within core's 16384-unit steer cap.
 * Core still validates the full wrapped message before admission. */
export const HUMAN_STEER_MAX_UNITS = 16_384 - humanSteerLead.length - 2;

/** Host input adapter, not a lifecycle owner. Admission commits in core and is
 * not delivery. Unlike a human Stop, nothing is published to the parent session:
 * the Run only carries the bounded `human_steered` marker. */
export function requestHumanSteer(
  controller: Pick<OwnerController, "steer">,
  run_id: string,
  text: string,
): { accepted: true } {
  if (typeof text !== "string" || !text.trim()) throw new OrchestrationError("INVALID_MESSAGE");
  controller.steer(run_id, `${humanSteerLead}\n\n${text.trim()}`, { source: "human" });
  return { accepted: true };
}
