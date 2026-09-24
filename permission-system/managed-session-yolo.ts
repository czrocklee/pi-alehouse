/**
 * Session-scoped yolo for the managed authority.
 *
 * Upstream yolo is a config knob (`yoloMode`): global, persisted to
 * config.json and shared by every session. The approval indicator needs one
 * session to opt in without touching the others or the Nix-owned config, so
 * this reader adds a second, process-local source: a set of session ids.
 *
 * A session is covered when it, or any in-process ancestor recorded in the
 * subagent registry, is in the set, so a parent's yolo reaches the subagents
 * it spawned. It feeds the same `isYoloEnabled` reader as the config knob and
 * therefore has the reach of yolo in this managed build: asks become allows,
 * while explicit denies and tool-entry guards still hold. Upstream yolo would
 * also turn the fail-closed floor's asks (allows clamped in an invalid scope)
 * back into allows; apply-patch.mjs keeps those as asks for either yolo.
 *
 *
 * Coverage is the permission subagent registry only: a child that is not
 * registered there (not in process, or never announced) is not covered and
 * keeps asking.
 *
 * The key is a literal duplicate of SESSION_YOLO_KEY in
 * extensions/lib/approval-protocol.ts; a check asserts the two agree. Only
 * in-process code can write the set; a model can reach it through no tool.
 */
const SESSION_YOLO_KEY = Symbol.for("@rocklee/managed-permissions:session-yolo");

export interface ManagedParentChain {
  get(sessionId: string): { parentSessionId?: string } | undefined;
}

export function managedSessionYolo(sessionId: string | null, chain: ManagedParentChain): boolean {
  const granted = (globalThis as unknown as Record<symbol, unknown>)[SESSION_YOLO_KEY];
  if (!(granted instanceof Set) || granted.size === 0 || sessionId === null) return false;
  // A malformed chain must not hang a permission check; each node is read once.
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current !== undefined && !visited.has(current)) {
    if (granted.has(current)) return true;
    visited.add(current);
    current = chain.get(current)?.parentSessionId;
  }
  return false;
}
