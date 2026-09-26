export const managementToolNames: readonly string[] = Object.freeze([
  "spawn_agent", "read_run", "steer_run", "wait_runs",
  "list_agents", "cancel_run", "resume_agent", "release_agent", "post_update",
]);

/** Off retains inspection/cleanup once this Owner has accepted work, even after
 * execution finishes: retained results must not disappear with the active slot. */
export const cleanupToolNames: readonly string[] = Object.freeze([
  "read_run", "wait_runs", "list_agents", "cancel_run", "release_agent",
]);

/** The preset owns these names: each reconciliation restores missing allowed
 * harness tools, overriding individual deactivation. Other tools keep their
 * current selection/order; never restore a cached global tool list. */
export function workerToolSelection(active: readonly string[], enabled: boolean, hasAcceptedRuns: boolean): string[] {
  const allowed = enabled ? managementToolNames : hasAcceptedRuns ? cleanupToolNames : [];
  const selected = active.filter((name) => !managementToolNames.includes(name) || allowed.includes(name));
  for (const name of allowed) if (!selected.includes(name)) selected.push(name);
  return selected;
}

// Deny-only compatibility: retired names are never registered as aliases.
export const blockedDelegationToolNames: readonly string[] = Object.freeze([
  ...managementToolNames,
  "subagent", "get_subagent_result", "steer_subagent", "wait_subagents",
  "list_subagents", "cancel_subagent", "resume_subagent", "release_subagent",
]);

export const agentProfileNames = ["editor", "reader"] as const;
