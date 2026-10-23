/** Exact names eligible for optional managed-block observations. This is a
 * telemetry vocabulary, never a tool allowlist or a permission grant. */
export const managedBlockToolNames = Object.freeze([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "web_search", "source_check", "fetch_content", "get_search_content", "alert_parent", "ask_parent",
]);

/** @param {unknown} toolName */
export function isManagedBlockTool(toolName) {
  return typeof toolName === "string" && managedBlockToolNames.includes(toolName);
}
