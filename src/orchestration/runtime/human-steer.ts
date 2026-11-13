import type { OwnerController } from "../core/owner-controller.ts";
import { OrchestrationError } from "../core/ports.ts";
import { humanSteerLead } from "../presentation/human-steer-text.ts";

export { HUMAN_STEER_MAX_UNITS, humanSteerLead } from "../presentation/human-steer-text.ts";

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
