// Presentation and prompt lifecycle observations never decide permission.
export function applyManagedGitPresentationPatch(root, patch) {
  patch("src/presentation/agent-renderer.ts", [
    [
      'import type { BashCommandContext } from "#src/types";',
      'import type { BashCommandContext } from "#src/types";\nimport type { ManagedGitDiagnostic } from "#src/access-intent/bash/managed-read-policy";',
    ],
    ["  type PromptPayload,", "  type PromptPayload,\n  type PromptEvidence,"],
    [
      "export function renderRefusal(",
      `export function renderRefusal(
  payload: PromptPayload,
  decidedBy: DecisionSource,
  denialReason: string | null,
  budget: AgentRenderBudget = DEFAULT_RENDER_BUDGET,
): string {
  return renderRefusalVerdict(payload, decidedBy, denialReason, budget) +
    managedGitProofClause(payload, budget);
}

function renderRefusalVerdict(`,
    ],
    [
      "/** The agent-facing render of a policy deny. */",
      `/** Presentation-only facts; no permission or session-grant semantics. */
export function managedGitDiagnosticEvidence(diagnostic: ManagedGitDiagnostic | undefined): PromptEvidence[] {
  return diagnostic ? [{ label: "managed Git proof unavailable",
    text: "[" + diagnostic.code + "] " + diagnostic.reason, detail: diagnostic.token ?? null }] : [];
}

/** A missing proof must never be described as a promised approval route. */
function managedGitProofClause(payload: PromptPayload, budget: AgentRenderBudget): string {
  const failure = findEvidence(payload, "managed Git proof unavailable");
  if (!failure) return "";
  const token = failure.detail === null ? "" : " (token '" + cap(failure.detail, budget) + "')";
  return " Complete managed Git read-only proof unavailable" + token + ": " + cap(failure.text, budget) +
    ". Missing proof does not override the deciding gate; env does not override denies or guarantee approval.";
}

/** The agent-facing render of a policy deny. */`,
    ],
    ["    ruleReason,\n  );", "    ruleReason,\n  ) + managedGitProofClause(payload, budget);"],
  ]);
}

// End the exact displayed request even if prompting fails. Capture the id
// before mutable bus observers see it; no outcome or decision is fabricated.
export function applyManagedPromptLifecyclePatch(root, patch) {
  patch("src/authority/local-user-authorizer.ts", [
    [
      `  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const uiPrompt = buildUiPrompt(details);
    emitUiPromptEvent(this.deps.events, uiPrompt);
    return this.deps.requestPermissionDecision(
      {
        mode: this.deps.mode,
        ui: this.deps.ui,
        ...this.deps.getPromptPreferences(),
      },
      details.forwarding
        ? "Permission Required (Subagent)"
        : "Permission Required",
      details.payload,
      buildRequestOptions(details),
    );
  }`,
      `  async authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const uiPrompt = buildUiPrompt(details);
    const requestId = uiPrompt.requestId;
    emitUiPromptEvent(this.deps.events, uiPrompt);
    try {
      return await this.deps.requestPermissionDecision(
        {
          mode: this.deps.mode,
          ui: this.deps.ui,
          ...this.deps.getPromptPreferences(),
        },
        details.forwarding
          ? "Permission Required (Subagent)"
          : "Permission Required",
        details.payload,
        buildRequestOptions(details),
      );
    } finally {
      try {
        this.deps.events.emit("managed-permissions:ui_prompt_end:v1", { requestId });
      } catch {
        // Lifecycle observation must not alter the prompt outcome.
      }
    }
  }`,
    ],
  ]);
}

// Hidden request declarations stay active and gated. This changes projection,
// not the active tool set, even for tools restored later in the same event.
export function applyManagedHiddenToolsPatch(root, patch) {
  patch("src/handlers/before-agent-start.ts", [
    [
      "  systemPromptOptions?: {\n    toolSnippets?: Record<string, string>;\n  };",
      `  systemPromptOptions?: {
    toolSnippets?: Record<string, string>;
    /** Managed: active tools whose declarations Pi leaves out of requests. */
    hiddenTools?: readonly string[];
  };`,
    ],
    [
      "    const toolSurfacePrompt = renderToolSurface(event.systemPrompt, {\n      allowedTools,\n",
      `    // Managed: a hidden declaration stays active and gated, but unlisted.
    const hiddenTools = new Set(event.systemPromptOptions?.hiddenTools ?? []);
    const toolSurfacePrompt = renderToolSurface(event.systemPrompt, {
      allowedTools: allowedTools.filter((name) => !hiddenTools.has(name)),
`,
    ],
  ]);
}
