import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { COMMUNICATION_LIMITS } from "../core/communication-envelope.ts";
import { ALERT_QUEUE_FULL_RESOLUTION } from "../core/communication-state.ts";
import { OrchestrationError, type RunCallbacks } from "../core/ports.ts";

const text = (maxLength: number, description: string) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

/** Closed set of admission failures with fixed child-facing wording. Any other
 * error keeps its original identity, so existing behavior is unchanged. */
const CLOSED_CODES = new Set([
  "INVALID_PARAMETERS",
  "INVALID_QUESTION",
  "INVALID_ALERT",
  "RUN_INPUT_CLOSED",
  "ALERT_TOO_LARGE",
  "ALERT_QUEUE_FULL",
]);

/** Build one projected error: fresh details, no stack/cause forwarding, and a
 * fixed message. The SDK exposes only Error.message to the model. */
function fixedError(code: string, message: string, details: Record<string, unknown> = {}) {
  const visible = new OrchestrationError(code, details);
  visible.message = message;
  return visible;
}

/** Project only the closed known codes into bounded child guidance. Never copy
 * arbitrary core details, resolution IDs, stack or cause to the model. */
function projectChildError(error: unknown, key: string): unknown {
  if (!(error instanceof OrchestrationError) || !CLOSED_CODES.has(error.code)) return error;
  const limit = COMMUNICATION_LIMITS.child_text_units;
  switch (error.code) {
    case "INVALID_PARAMETERS":
      return fixedError(
        error.code,
        `${error.code}: Provide exactly one nonblank "${key}" string of 1-${limit} characters.`,
      );
    case "INVALID_QUESTION":
      return fixedError(
        error.code,
        `${error.code}: Provide one nonblank question of 1-${limit} characters.`,
      );
    case "INVALID_ALERT":
      return fixedError(
        error.code,
        `${error.code}: Provide one nonblank message of 1-${limit} characters.`,
      );
    case "RUN_INPUT_CLOSED":
      return fixedError(
        error.code,
        `${error.code}: This task is no longer accepting tool calls; end your turn.`,
      );
    case "ALERT_TOO_LARGE":
      return fixedError(
        error.code,
        `${error.code}: The message was not queued. Shorten it substantially and retry once, or keep it in your final result.`,
      );
    case "ALERT_QUEUE_FULL": {
      // Keep only the bounded quota facts and shared recovery guidance; the
      // core error itself is never mutated.
      const quota =
        error.details.scope === "owner" && error.details.limit === COMMUNICATION_LIMITS.owner_alerts
          ? { scope: "owner", limit: COMMUNICATION_LIMITS.owner_alerts }
          : error.details.scope === "agent" &&
              error.details.limit === COMMUNICATION_LIMITS.agent_alerts
            ? { scope: "agent", limit: COMMUNICATION_LIMITS.agent_alerts }
            : undefined;
      return fixedError(
        error.code,
        `ALERT_QUEUE_FULL${quota ? ` (scope=${quota.scope}, limit=${quota.limit})` : ""}: ${ALERT_QUEUE_FULL_RESOLUTION}`,
        quota
          ? { ...quota, resolution: ALERT_QUEUE_FULL_RESOLUTION }
          : { resolution: ALERT_QUEUE_FULL_RESOLUTION },
      );
    }
  }
  return error;
}

/** Exact argument shape and end-turn mechanics live here, not in shared prompt
 * text. Ask records a question; it never claims delivery or acknowledgement.
 * The no-repeat instruction appears only in the ask receipts (ASK_END_TURN). */
const DEFINITIONS = [
  {
    name: "alert_parent",
    key: "message",
    promptSnippet: "Queue a decision-relevant fact for the parent, then continue.",
    description:
      "alert_parent({message: string}) — Queue a decision-relevant fact for the parent, then continue. Queued does not mean read or acknowledged; no new parent turn.",
    field: `The fact to queue for the parent: 1-${COMMUNICATION_LIMITS.child_text_units} characters of nonblank text.`,
  },
  {
    name: "ask_parent",
    key: "question",
    promptSnippet: "Ask the parent a blocking question, then end your turn.",
    description:
      "ask_parent({question: string}) — Record one blocking question for the parent, then stop calling tools and end your turn so the task can settle for an answer. Only the first question is kept.",
    field: `The complete question for the parent: 1-${COMMUNICATION_LIMITS.child_text_units} characters of nonblank text.`,
  },
] as const;

const ASK_END_TURN =
  "Stop calling tools and end your turn now. Do not repeat the question in your final reply.";

export function createChildTools(
  current: () => RunCallbacks | undefined,
  gate: { readonly accepting: boolean; readonly stopped: boolean },
): ToolDefinition[] {
  return DEFINITIONS.map(({ name, key, promptSnippet, description, field }) => {
    const parameters = Type.Object(
      { [key]: text(COMMUNICATION_LIMITS.child_text_units, field) },
      { additionalProperties: false },
    );
    return {
      name,
      label: name,
      parameters,
      promptSnippet,
      description,
      async execute(_id: string, args: unknown) {
        // Like owner tools, recheck AFTER mutable SDK tool_call hooks, before
        // callbacks can enqueue an alert or record the first question.
        if (!Check(parameters, args) || args[key]!.length > COMMUNICATION_LIMITS.child_text_units)
          throw projectChildError(
            new OrchestrationError("INVALID_PARAMETERS", {
              resolution: `Check the argument: 1-${COMMUNICATION_LIMITS.child_text_units} nonblank UTF-16 units.`,
            }),
            key,
          );
        const callbacks = current();
        if (!callbacks || !gate.accepting || gate.stopped)
          throw projectChildError(new OrchestrationError("RUN_INPUT_CLOSED"), key);
        const value = args[key]!;
        let receipt: string;
        if (name === "ask_parent") {
          let accepted: "recorded" | "already_recorded";
          try {
            accepted = callbacks.question(value);
          } catch (error) {
            throw projectChildError(error, key);
          }
          receipt =
            accepted === "already_recorded"
              ? `This task already has a question; it was not replaced. ${ASK_END_TURN}`
              : `Question recorded. ${ASK_END_TURN}`;
        } else {
          try {
            callbacks.alert(value);
          } catch (error) {
            throw projectChildError(error, key);
          }
          receipt = "Alert queued. Continue working.";
        }
        return { content: [{ type: "text" as const, text: receipt }], details: undefined };
      },
    };
  });
}
