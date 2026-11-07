import { HarnessError } from "../core/ports.ts";

type ToolCallPermissionQuery = { checkToolCallPermission(toolName: string, ctx: unknown): unknown };
type Refusal = "deny" | "ask" | "unknown" | "unavailable";

function refused(reason: Refusal): HarnessError {
  return new HarnessError("RETURN_TO_PERMISSION_DENIED", {
    key: "return_to",
    surface: "agent_answer",
    reason,
    resolution:
      reason === "deny"
        ? "Permission policy denied agent_answer; report the denial. Do not use return_to to bypass it."
        : "Use ordinary separate agent_spawn and agent_answer calls under their normal permission gates; return_to requires an existing parent agent_answer allow.",
  });
}

function rejectAsync(value: object): void {
  if (!("then" in value)) return;
  // Reject immediately, never await or invoke an arbitrary thenable. The
  // intrinsic brand-checks native Promises and sinks their late rejection.
  try {
    Promise.prototype.then.call(value, undefined, () => undefined).catch(() => undefined);
  } catch {
    /* Non-native thenables are still invalid synchronous values. */
  }
  throw new Error("ASYNC_PERMISSION_QUERY");
}

/** Ask the current parent's managed authority for the decision its own
 * agent_answer tool gate would make for this parent tool call. Only the
 * authority knows the principal that gate binds (a recorded active agent, or a
 * name it remembered from an earlier prompt), so the harness never
 * reconstructs it and never substitutes a child profile or tool-list
 * projection. Only an effective synchronous allow admits the compound
 * operation; the query neither prompts nor records a grant. */
export function requireParentAnswerPermission(service: unknown, context: unknown): void {
  let state: unknown;
  try {
    if (!service || typeof service !== "object" || Array.isArray(service))
      throw new Error("INVALID_SERVICE");
    rejectAsync(service);
    const query = service as ToolCallPermissionQuery;
    if (typeof query.checkToolCallPermission !== "function") throw new Error("MISSING_QUERY");
    if (!context || typeof context !== "object") throw new Error("MISSING_CONTEXT");
    const result = query.checkToolCallPermission("agent_answer", context);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("INVALID_RESULT");
    rejectAsync(result);
    state = (result as { state?: unknown }).state;
  } catch {
    throw refused("unavailable");
  }
  if (state === "allow") return;
  throw refused(state === "deny" || state === "ask" ? state : "unknown");
}
