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

// One principal for tool gates, forwarded asks and read-only service queries.
// Prompt text is never authority. Expected child bindings only add restrictions.
export function applyManagedToolCallPrincipalPatch(root, patch) {
  patch("src/authority/approval-escalator.ts", [
    [
      `import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "#src/session/active-agent";
import { toRecord } from "#src/value-guards";`,
      'import { getPermissionsService } from "#src/service";',
    ],
    [
      `function getContextSystemPrompt(ctx: ForwarderContext): string | undefined {
  const getSystemPrompt = toRecord(ctx).getSystemPrompt;
  if (typeof getSystemPrompt !== "function") {
    return undefined;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- getSystemPrompt is a Pi SDK accessor returning any
    const systemPrompt = getSystemPrompt.call(ctx);
    return typeof systemPrompt === "string" ? systemPrompt : undefined;
  } catch (error) {
    // No deps available in this helper — warning silently dropped.
    logPermissionForwardingWarning(
      null,
      "Failed to read context system prompt for forwarded permission metadata",
      error,
    );
    return undefined;
  }
}

`,
      "",
    ],
    [
      `    const request = this.buildForwardedRequest(
      ctx,
      facts,
      requesterSessionId,
      target.sessionId,
    );
`,
      "",
    ],
    [
      "    const location = ensurePermissionForwardingLocation(",
      `    const request = this.buildForwardedRequest(ctx, facts, requesterSessionId, target.sessionId);
    if (!request) return abandon("Cannot verify the actual named tool-call principal for forwarding");

    const location = ensurePermissionForwardingLocation(`,
    ],
    [
      `  ): ForwardedPermissionRequest {
    const requestId = forwardableRequestId(facts.requestId);
    const requesterAgentName =
      getActiveAgentName(ctx) ??
      getActiveAgentNameFromSystemPrompt(getContextSystemPrompt(ctx)) ??
      "unknown";`,
      `  ): ForwardedPermissionRequest | null {
    // The edge must stamp the same principal as the actual local gate, not a
    // separately decoded record or prompt. The wire requires a named agent;
    // an unscoped root cannot be represented as a guessed "unknown" profile.
    let requesterAgentName: string;
    try {
      const service = getPermissionsService(requesterSessionId);
      if (typeof service?.getToolCallAgentName !== "function") return null;
      const principal = service.getToolCallAgentName(ctx);
      if (typeof principal !== "string" || !principal || principal.trim() !== principal) return null;
      requesterAgentName = principal;
    } catch {
      return null;
    }
    const requestId = forwardableRequestId(facts.requestId);`,
    ],
  ]);
  patch("src/session/permission-session.ts", [
    ["  getActiveAgentNameFromSystemPrompt,", "  type ActiveAgentContext,"],
    [
      "  private knownAgentName: string | null = null;",
      `  private knownAgentName: string | null = null;
  private expectedToolCallAgent: { profile: string; instanceId: string } | null = null;`,
    ],
    [
      "  resetForNewSession(ctx: ExtensionContext, projectTrusted: boolean): void {",
      `  resetForNewSession(ctx: ExtensionContext, projectTrusted: boolean): void {
    this.expectedToolCallAgent = null;`,
    ],
    [
      "  shutdown(): void {",
      `  shutdown(): void {
    this.expectedToolCallAgent = null;`,
    ],
    [
      `   * Resolve the active agent name from the session context, system prompt,
   * or last known name. Updates lastKnownActiveAgentName as a side effect.`,
      `   * Resolve only the session-wide recorded name or the last known recorded
   * name. Prompt prose never selects a principal. Preserve the existing cache
   * behavior on null/no record; a bound child instead requires its exact record.`,
    ],
    [
      `    systemPrompt?: string,
  ): string | null {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      this.knownAgentName = fromSession;
      return fromSession;
    }
    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      this.knownAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }
    return this.knownAgentName;
  }`,
      `    _systemPrompt?: string,
  ): string | null {
    const agentName = this.peekToolCallAgentName(ctx);
    if (agentName) this.knownAgentName = agentName;
    return agentName;
  }

  /** Read-only: identical to resolveAgentName without remembering the result. */
  peekToolCallAgentName(ctx: ActiveAgentContext): string | null {
    const recorded = getActiveAgentName(ctx);
    if (this.expectedToolCallAgent &&
        (recorded !== this.expectedToolCallAgent.profile ||
         !this.hasExactAgentRecord(ctx, this.expectedToolCallAgent.profile))) {
      throw new Error("MANAGED_TOOL_CALL_PRINCIPAL_MISMATCH");
    }
    return recorded ?? this.knownAgentName;
  }

  private hasExactAgentRecord(ctx: ActiveAgentContext, profile: string): boolean {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== "active_agent") continue;
      return (entry.data as { name?: unknown } | undefined)?.name === profile;
    }
    return false;
  }

  /** Narrowing only: neither supplies a missing identity nor changes the cache. */
  bindExpectedToolCallAgent(ctx: ActiveAgentContext, profile: string, instanceId: string): boolean {
    if (typeof profile !== "string" || !profile || profile.trim() !== profile ||
        typeof instanceId !== "string" || !instanceId || instanceId.trim() !== instanceId) return false;
    const bound = this.expectedToolCallAgent;
    if (bound && (bound.profile !== profile || bound.instanceId !== instanceId)) return false;
    if (!this.hasExactAgentRecord(ctx, profile) || this.peekToolCallAgentName(ctx) !== profile) return false;
    this.expectedToolCallAgent = { profile, instanceId };
    return true;
  }

  releaseExpectedToolCallAgent(instanceId: string): boolean {
    if (!this.expectedToolCallAgent || this.expectedToolCallAgent.instanceId !== instanceId) return false;
    this.expectedToolCallAgent = null;
    return true;
  }`,
    ],
  ]);
  patch("src/service/permissions-service.ts", [
    [
      "interface PathNormalizerProvider {\n  getPathNormalizer(): PathNormalizer;\n}",
      `interface PathNormalizerProvider {
  getPathNormalizer(): PathNormalizer;
  peekToolCallAgentName(ctx: ActiveAgentContext): string | null;
  bindExpectedToolCallAgent(ctx: ActiveAgentContext, profile: string, instanceId: string): boolean;
  releaseExpectedToolCallAgent(instanceId: string): boolean;
}`,
    ],
    [
      'import type { PathNormalizer } from "#src/path/path-normalizer";',
      'import type { PathNormalizer } from "#src/path/path-normalizer";\nimport type { ActiveAgentContext } from "#src/session/active-agent";',
    ],
    [
      "  getToolPermission(\n    toolName: string,",
      `  getToolCallAgentName(ctx: ActiveAgentContext): string | null {
    return this.session.peekToolCallAgentName(ctx);
  }

  bindExpectedToolCallAgent(ctx: ActiveAgentContext, profile: string, instanceId: string): boolean {
    return this.session.bindExpectedToolCallAgent(ctx, profile, instanceId);
  }

  releaseExpectedToolCallAgent(instanceId: string): boolean {
    return this.session.releaseExpectedToolCallAgent(instanceId);
  }

  checkToolCallPermission(
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

  /** Managed: actual tool-gate principal, without updating the remembered name. */
  getToolCallAgentName(ctx: ActiveAgentContext): string | null;

  /** Managed: require an exact existing child record, never create identity or grant. */
  bindExpectedToolCallAgent(ctx: ActiveAgentContext, profile: string, instanceId: string): boolean;

  /** Managed: only the binding's own guard instance may release it. */
  releaseExpectedToolCallAgent(instanceId: string): boolean;
`,
    ],
  ]);
}
