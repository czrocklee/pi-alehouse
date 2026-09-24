import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OwnerController } from "../core/owner-controller.js";
import { reportUnreportedUsage } from "../history/usage-audit.js";

const cancelled = Object.freeze({ cancel: true as const });
const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "warning"): void => {
  try { ctx.ui.notify(message, level); } catch { /* UI failure cannot turn a veto into permission. */ }
};
const diagnostic = (error: unknown): string => {
  try { return String(error).slice(0, 256); } catch { return "unprintable error"; }
};
const incomplete = (state: ReturnType<OwnerController["stats"]>): string =>
  `Harness Owner is NOT closed (active ${state.active}, queued ${state.queued}, finalizing ${state.finalizing}, ` +
  `cleaning ${state.cleaning}, cleanup uncertain: ${state.cleanup_uncertain}). Session change blocked. ` +
  "Inspect /harness-status; wait for work to exit and retry /harness-close. There is no force-unlock.";

/** Capture this parent's immutable owner; a replacement parent needs a fresh owner.
 * Only irreversible closed (not idle) admits replacement. Empty auto-close calls
 * shutdown before its first await, sealing pending/new admissions. A used Owner
 * needs an explicit human confirmation before the same stop/drain path runs.
 * Pi swallows hook throws: every error must return an explicit cancellation.
 * Tree navigation does not replace the runtime. Reload has no pre-teardown veto.
 * See docs/limitations.md, "Lifecycle and cancellation".
 */
export function ownerSessionReplacementGuard(owner: OwnerController): (pi: ExtensionAPI) => void {
  return (pi) => {
    // Never reuse a confirmation/drain promise for a second target. This latch
    // ends with our hook; it cannot serialize Pi's later hooks/target loading.
    let pending = false;
    const reportUsage = (ctx: ExtensionContext): void => {
      try { reportUnreportedUsage(pi, ctx, owner); }
      catch (error) {
        // Reporting is not the closure authority. A failed notice must not
        // relabel an already-proven close as unconfirmed, nor unlock a live Owner.
        notify(ctx, `Child usage reporting failed during Owner closure; inspect /harness-history. ${diagnostic(error)}`);
      }
    };
    const admit = async (_event: unknown, ctx: ExtensionContext) => {
      if (pending) {
        notify(ctx, "Another harness session change is awaiting confirmation or closure. Finish it, then retry this request.");
        return cancelled;
      }
      pending = true;
      try {
        const state = owner.stats();
        if (state.closed === true) return;
        if (owner.hasAcceptedRuns !== false) {
          if (!ctx.hasUI) {
            notify(ctx, "Session change blocked: this harness Owner has accepted work. Use /harness-close and confirm closure before retrying; no confirmation UI is available.");
            return cancelled;
          }
          const confirmed = await ctx.ui.confirm("Close harness Owner and change session?",
            `This Owner has ${state.resident} resident Agent(s), ${state.active} active and ${state.queued} queued Run(s), ` +
            `and ${state.runs} retained Run(s).\n` +
            "Continuing stops new admissions, requests cancellation of ALL this Owner's work (including work accepted while this dialog is open), " +
            "and waits for confirmed exit and cleanup. Resident Agents cannot be reused afterward.\n" +
            "Closure is permanent even if a later hook cancels the change or the destination fails to open. " +
            "Cancel leaves this request's work untouched.");
          if (confirmed !== true) {
            notify(ctx, "Session change cancelled; this request did not stop or close the harness Owner.");
            return cancelled;
          }
        }
        // No await (nor fallible UI callback) between the unused-Owner check
        // and shutdown's synchronous admission seal. Idle alone is insufficient.
        const closing = owner.shutdown();
        notify(ctx, "Closing harness Owner for session change; waiting for work to exit and cleanup to finish.", "info");
        const closed = await closing;
        reportUsage(ctx);
        if (closed.closed !== true) {
          notify(ctx, incomplete(closed));
          return cancelled;
        }
        notify(ctx, "Harness Owner closed for session change. Workers are permanently closed in this session, " +
          "even if the change is later cancelled or fails. Open another session or restart Pi to use workers again.");
        return;
      } catch (error) {
        notify(ctx, `Could not confirm harness Owner closure; session change blocked. Inspect /harness-status and /harness-close. ${diagnostic(error)}`);
        return cancelled;
      } finally { pending = false; }
    };
    pi.on("session_before_switch", admit);
    pi.on("session_before_fork", admit);
    pi.on("session_before_tree", (_event, ctx) => {
      if (pending) {
        notify(ctx, "Another harness session change is awaiting confirmation or closure. Finish it, then retry this request.");
        return cancelled;
      }
      try { if (owner.stats().closed === true) return; } catch { /* fail closed */ }
      notify(ctx, "Tree navigation blocked: /tree changes this session in place without creating a fresh harness Owner. " +
        "Use /harness-close first; workers stay closed until you open another session.");
      return cancelled;
    });
    pi.registerCommand("harness-close", {
      description: "Cancel/drain this harness owner and close it permanently before session replacement",
      handler: async (_args, ctx) => {
        const state = await owner.shutdown();
        reportUsage(ctx);
        notify(ctx, state.closed ? "Harness owner closed; session replacement is now permitted." : incomplete(state), state.closed ? "info" : "warning");
      },
    });
  };
}
