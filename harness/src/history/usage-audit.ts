import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OwnerController } from "../core/owner-controller.js";

export const residueType = "harness:unreported-usage:v1";
// Presentation-only deduplication, never an accounting drain or durable receipt.
// Weak keys do not keep a closed controller alive. Failed appends are retried.
const checkpoints = new WeakMap<OwnerController, { key: string; notified: boolean }>();
/** An explicit audit snapshot, NOT a billable Pi usage entry or a ledger drain.
 * Repeated close/shutdown snapshots must not be added together. Parent totals
 * cannot be completed through the extension API without a later tool result.
 */
export function reportUnreportedUsage(pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<ExtensionContext, "ui">,
  controller: OwnerController): void {
  const state = controller.stats(), usage = state.unreported_usage;
  if (!usage) { checkpoints.delete(controller); return; }
  const snapshot = { ...controller.identity, closed: state.closed, usage: { ...usage,
    byModel: Object.fromEntries(Object.entries(usage.byModel).sort(([a], [b]) => a.localeCompare(b))) } };
  const key = JSON.stringify(snapshot); // Exclude timestamp; include partial/model splits and closed state.
  let checkpoint = checkpoints.get(controller);
  if (checkpoint?.key === key && checkpoint.notified) return;
  let recorded = checkpoint?.key === key;
  if (!recorded) {
    try {
      pi.appendEntry(residueType, { ...snapshot, recorded_at: Date.now() });
      checkpoint = { key, notified: false }; checkpoints.set(controller, checkpoint); recorded = true;
    } catch { /* Keep the prior successful checkpoint; retry this state next time. */ }
  }
  ctx.ui.notify(`Child usage not merged into Pi totals: ${JSON.stringify(usage.total)}${usage.partial.length ? ` (incomplete: ${usage.partial.join(", ")})` : ""}. ` +
    (recorded ? "Audit snapshot recorded; /harness-history shows the latest checkpoint." : "Audit snapshot could not be recorded; preserve this notice."), "warning");
  if (recorded && checkpoint) checkpoint.notified = true;
}
