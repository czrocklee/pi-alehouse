export const managementToolNames: readonly string[] = Object.freeze([
  "agent_spawn", "agent_run", "agent_send", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list",
]);

/** Off retains inspection/cleanup once this Owner has accepted work, even after
 * execution finishes: retained results must not disappear with the active slot. */
export const cleanupToolNames: readonly string[] = Object.freeze([
  "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list",
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

// Never in a child profile: current names, plus retired ones as deny-only
// defense in depth. Retired names are never registered as aliases.
export const blockedDelegationToolNames: readonly string[] = Object.freeze([
  ...managementToolNames,
  "delegate", "wait_agents", "read_result", "message_agents", "cancel_task", "release_agent", "list_agents",
  "spawn_agent", "resume_agent", "read_run", "wait_runs", "steer_run", "cancel_run", "post_update",
  "subagent", "get_subagent_result", "steer_subagent", "wait_subagents",
  "list_subagents", "cancel_subagent", "resume_subagent", "release_subagent",
]);

export const agentProfileNames = ["editor", "reader", "researcher"] as const;
export type AgentProfileName = typeof agentProfileNames[number];

/** The only child tools besides local ones and notify/ask_parent. Only the
 * researcher receives them, from its own pi-web-access instance; its
 * definition must list all four and no Bash or direct edit tool. */
export const webToolNames: readonly string[] = Object.freeze(["web_search", "source_check", "fetch_content", "get_search_content"]);
export const webProfileNames: readonly AgentProfileName[] = Object.freeze(["researcher"]);
