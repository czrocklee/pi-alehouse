import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OwnerController } from "../core/owner-controller.js";

export const humanCancellationMessage = "harness:human-cancellation:v1";

/** Host input adapter, not a lifecycle owner. Cancellation commits in core;
 * optional parent-message failure cannot change the command's accepted result.
 * The SDK owns asynchronous message failures: queuing is not model receipt. */
export function requestHumanStop(controller: Pick<OwnerController, "cancel">,
  pi: Pick<ExtensionAPI, "sendMessage">, run_id: string) {
  const cancellation = controller.cancel(run_id, { source: "human" });
  const result = { result: cancellation.result, already_stopping: cancellation.already_stopping };
  if (cancellation.result !== "cancel_requested" || cancellation.already_stopping) return result;
  const view = cancellation.snapshot;
  try {
    pi.sendMessage({ customType: humanCancellationMessage, display: true,
      content: `Human action: the user requested cooperative cancellation of ${JSON.stringify({ agent: view.name, task: view.task })}. ` +
        "Do not automatically resume or redelegate this task; ask the user before restarting it. " +
        "This is a stop request, not confirmed execution exit; inspect the task state for confirmation.",
      details: { agent: view.name, task: view.task, run_id: view.run_id, cancellation_source: "human" },
    }, { triggerTurn: false });
  } catch {
    return { ...result, warnings: ["The cancellation request was accepted, but its parent-model notice could not be queued."] };
  }
  return result;
}
