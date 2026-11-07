// Forwarding correlation observes only; principal checks remain in authority.
// Keep these separate so optional observation can never stand in for binding.
export function applyManagedForwardingObservationPatch(root, patch) {
  // The upstream wire envelope omits SDK toolCallId. Publish local correlation
  // before writing it, without changing the protocol or human forwarding.
  patch("src/authority/approval-escalator.ts", [
    [
      "    const uiPrompt = buildUiPrompt(details);",
      `    const managedRequestId = forwardableRequestId(details.requestId);
    const observers = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers")];
    const observe = observers instanceof Map ? observers.get(getSessionId(this.ctx)) : undefined;
    try {
      if (typeof observe === "function") observe({ requestId: managedRequestId, toolCallId: details.toolCallId });
    } catch { /* Optional observation must not disable normal human forwarding. */ }
    const uiPrompt = buildUiPrompt(details);`,
    ],
    ["      requestId: details.requestId,", "      requestId: managedRequestId,"],
  ]);
}

// Forwarded authority must retain the requester's edge-stamped principal.
export function applyManagedForwardedPrincipalPatch(root, patch) {
  patch("src/authority/forwarded-request-server.ts", [
    [
      "    const check = request.accessIntent",
      `    if (request.accessIntent &&
        (request.accessIntent.principal.sessionId !== request.requesterSessionId ||
         request.accessIntent.principal.agentName !== request.requesterAgentName)) {
      const reason = "Forwarded permission principal does not match its requester.";
      return { ...createDeniedPermissionDecision(reason), decidedBy: { kind: "gate_error", reason } };
    }
    const check = request.accessIntent`,
    ],
  ]);
}

// Another extension acting for this node reaches this node's own tool-gate
// principal. Query only: no remembered-name mutation, prompt or recorded grant.
export function applyManagedToolCallPrincipalPatch(root, patch) {
  patch("src/session/permission-session.ts", [
    [
      "  // Read by the `index.ts` config-modal adapter closure:",
      `  /** Managed: the principal resolveAgentName(ctx) binds for a tool call
   * (no system prompt there), without updating the remembered name. */
  peekToolCallAgentName(ctx: ActiveAgentContext): string | null {
    return getActiveAgentName(ctx) ?? this.knownAgentName;
  }

  // Read by the \`index.ts\` config-modal adapter closure:`,
    ],
    ["  getActiveAgentName,\n", "  getActiveAgentName,\n  type ActiveAgentContext,\n"],
  ]);
  patch("src/service/permissions-service.ts", [
    [
      "interface PathNormalizerProvider {\n  getPathNormalizer(): PathNormalizer;\n}",
      `interface PathNormalizerProvider {
  getPathNormalizer(): PathNormalizer;
  peekToolCallAgentName(ctx: ActiveAgentContext): string | null;
}`,
    ],
    [
      'import type { PathNormalizer } from "#src/path/path-normalizer";',
      'import type { PathNormalizer } from "#src/path/path-normalizer";\nimport type { ActiveAgentContext } from "#src/session/active-agent";',
    ],
    [
      "  getToolPermission(\n    toolName: string,",
      `  checkToolCallPermission(
    toolName: string,
    ctx: ActiveAgentContext,
  ): ReturnType<PermissionsService["checkToolCallPermission"]> {
    return this.checkPermission(toolName, undefined, this.session.peekToolCallAgentName(ctx) ?? undefined);
  }

  getToolPermission(
    toolName: string,`,
    ],
  ]);
  patch("src/service.ts", [
    [
      'import type { PermissionCheckResult, PermissionState } from "./types";',
      'import type { PermissionCheckResult, PermissionState } from "./types";\nimport type { ActiveAgentContext } from "#src/session/active-agent";',
    ],
    [
      "  isToolFullyDenied(toolName: string, agentName?: string): boolean;\n",
      `  isToolFullyDenied(toolName: string, agentName?: string): boolean;

  /**
   * Managed: the decision this node's own tool gate would make for a call of
   * \`toolName\` in \`ctx\` (one of this node's tool calls), under the principal
   * that gate binds. Read-only: it neither prompts nor records a grant, and it
   * does not change the remembered agent name.
   */
  checkToolCallPermission(toolName: string, ctx: ActiveAgentContext): PermissionCheckResult;
`,
    ],
  ]);
}
