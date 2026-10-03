import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { COMMUNICATION_LIMITS } from "../core/communication-envelope.js";
import { ALERT_QUEUE_FULL_RESOLUTION } from "../core/communication-state.js";
import { HarnessError, type RunCallbacks } from "../core/ports.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

function childAlertError(error: unknown): unknown {
  if (!(error instanceof HarnessError) || error.code !== "ALERT_QUEUE_FULL") return error;
  // The SDK exposes only Error.message. Project just the fixed quota facts and
  // guidance, never arbitrary details/resolution, IDs, stack or cause. Leave the
  // core error untouched and preserve other acceptance errors' identity.
  const quota = error.details.scope === "owner" && error.details.limit === COMMUNICATION_LIMITS.owner_alerts
    ? { scope: "owner", limit: COMMUNICATION_LIMITS.owner_alerts }
    : error.details.scope === "agent" && error.details.limit === COMMUNICATION_LIMITS.agent_alerts
      ? { scope: "agent", limit: COMMUNICATION_LIMITS.agent_alerts } : undefined;
  const visible = new HarnessError("ALERT_QUEUE_FULL", { ...quota, resolution: ALERT_QUEUE_FULL_RESOLUTION });
  visible.message = `ALERT_QUEUE_FULL${quota ? ` (scope=${quota.scope}, limit=${quota.limit})` : ""}: ${ALERT_QUEUE_FULL_RESOLUTION}`;
  return visible;
}

export function createChildTools(current: () => RunCallbacks | undefined,
  gate: { readonly accepting: boolean; readonly stopped: boolean }): ToolDefinition[] {
  return ([["alert_parent", "message"], ["ask_parent", "question"]] as const).map(([name, key]) => {
    const parameters = Type.Object({ [key]: text(8192) }, { additionalProperties: false });
    return { name, label: name, parameters,
      description: name === "ask_parent" ? "Record a question requiring the parent's decision, then finish this task. An existing question is kept, not replaced." : "Queue an important fact that affects the parent's decisions, then continue working. It wakes matching parent observations, not a new parent model turn. Use ask_parent when a decision is required, then finish the task.",
      async execute(_id: string, args: unknown) {
        // Like owner tools, recheck AFTER mutable SDK tool_call hooks, before
        // callbacks can enqueue an alert or record the first question.
        if (!Check(parameters, args) || args[key]!.length > 8192) throw new HarnessError("INVALID_PARAMETERS",
          { resolution: "Check the argument: 1-8192 nonblank UTF-16 units." });
        const callbacks = current();
        if (!callbacks || !gate.accepting || gate.stopped) throw new HarnessError("RUN_INPUT_CLOSED");
        const value = args[key]!;
        let receipt: string;
        if (name === "ask_parent") {
          const accepted = callbacks.question(value);
          receipt = accepted === "already_recorded"
            ? "This task already has a question; it was not replaced. Finish this task now."
            : "Question recorded. Finish this task now.";
        } else {
          try { callbacks.alert(value); }
          catch (error) { throw childAlertError(error); }
          receipt = "Alert queued. Continue working.";
        }
        return { content: [{ type: "text" as const, text: receipt }], details: undefined };
      },
    };
  });
}
