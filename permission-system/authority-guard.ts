import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A project package override or an explicit -e can load another copy after the
// global settings migration. Observe identity, not paths/package names. Never
// silently choose whichever authority happened to publish last.
export function guardSingleAuthority(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let expected: unknown;
  let conflict = false;
  const service = () => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-permission-system:session-services")];
    return sessionId && registry instanceof Map ? registry.get(sessionId) : undefined;
  };
  const unsubscribe = pi.events.on("permissions:ready", (event: unknown) => {
    if ((event as { sessionId?: unknown })?.sessionId !== sessionId || !sessionId) return;
    const current = service();
    if (!current) { conflict = true; return; }
    if (expected === undefined && !conflict) expected = current;
    else if (expected !== current) conflict = true;
  });
  // Register BEFORE the managed authority's own session_start/tool_call hooks.
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    expected = undefined;
    conflict = service() !== undefined;
  });
  pi.on("tool_call", () => {
    if (conflict || expected === undefined || service() !== expected) {
      return { block: true, reason: "Managed permission authority is missing or duplicated. Disable other permission-system extensions in project settings/CLI and start a new session; no authority was silently selected." };
    }
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
    sessionId = undefined;
    expected = undefined;
    conflict = false;
  });
}
