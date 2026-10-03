// Apply only to the pinned dependency closure, never the mutable live install.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = process.argv[2];
assert(root, "Usage: node apply-patch.mjs PACKAGE_ROOT");
assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "32.0.3");
function patch(file, edits) {
  let text = readFileSync(join(root, file), "utf8");
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length, 2, `Patch drift: ${file}: ${before}`);
    text = text.replace(before, after);
  }
  writeFileSync(join(root, file), text);
}
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "managed-read-policy.ts"), join(root, "src/access-intent/bash/managed-read-policy.ts"));
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "../extensions/lib/git-read-grammar.ts"), join(root, "src/access-intent/bash/git-read-grammar.ts"));
patch("src/access-intent/effect.ts", [
  ['export type EffectSource = "syntax" | "core" | "retracted" | "unproven";', 'export type EffectSource = "syntax" | "core" | "retracted" | "unproven" | "managed-literal";'],
]);
patch("src/access-intent/bash/token-collection.ts", [
  ['import { proveCommandEffect } from "./command-effects";', 'import { proveCommandEffect } from "./command-effects";\nimport { managedReaderEffect } from "./managed-read-policy";'],
  ['const effect = proveCommandEffect(', 'const effect = managedReaderEffect(node.text) ?? proveCommandEffect('],
]);
patch("src/access-intent/bash/command-enumeration.ts", [
  ['import type { BashCommandContext, FloorExemption } from "#src/types";', 'import type { BashCommandContext, FloorExemption } from "#src/types";\nimport type { ManagedGitDiagnostic } from "./managed-read-policy";'],
  ['export interface BashCommand {', 'export interface BashCommand {\n  /** Private managed normalization provenance; original policy still applies. */\n  readonly managedOriginal?: string;\n  /** Local proof after complete static scope inspection. */\n  readonly managedReadOnly?: true;\n  /** Hardened inner spelling for this exact, completely proven env Git unit. */\n  readonly managedGitInner?: string;\n  /** Raw original inner spelling; never reconstructed from decoded words. */\n  readonly managedGitOriginalInner?: string;\n  /** Proof failure is presentation only, not a permission decision. */\n  readonly managedGitDiagnostic?: ManagedGitDiagnostic;\n  /** Exact mkdir/cp effects came from private mutable-input provenance. */\n  readonly managedStaticFileEffects?: true;'],
]);
patch("src/access-intent/bash/program.ts", [
  ['import { getParser } from "./parser";', 'import { getParser } from "./parser";\nimport { managedGitInnerCommand, managedGitSyntaxDiagnostic, managedProgramAnalysis, managedStaticFileProof, type ManagedStaticFileScope } from "./managed-read-policy";'],
  ['options?: { workdir?: string },', 'options?: { workdir?: string; originalCommands?: string[]; newScope?: ManagedStaticFileScope },'],
  ['      return new BashProgram(\n        command,\n        collectCommands(tree.rootNode),\n        externalAccesses,\n        ruleCandidates,\n      );', `      const commands = collectCommands(tree.rootNode);
      const fileCandidate = managedStaticFileProof(options?.newScope, command, normalizer);
      const analysis = fileCandidate ? undefined : managedProgramAnalysis(tree.rootNode, normalizer, options?.workdir);
      const readCandidate = analysis?.proof;
      // Indirection is admitted only for the exact env Git unit marked by a
      // COMPLETE program proof. No other wrapper inherits this exception.
      const readProof = readCandidate?.marked.length === commands.length &&
        readCandidate.gitWrappers.length === commands.length &&
        commands.every((cmd, index) => !cmd.parseUnresolved && !cmd.context &&
          (!cmd.wrapperKind || (cmd.wrapperKind === "indirection" &&
            readCandidate.marked[index] && readCandidate.gitWrappers[index] !== undefined &&
            managedGitInnerCommand(cmd.text) === readCandidate.gitWrappers[index]))) ? readCandidate : undefined;
      const fileProof = fileCandidate?.marked.length === commands.length &&
        commands.every(cmd => !cmd.wrapperKind && !cmd.parseUnresolved && !cmd.context) ? fileCandidate : undefined;
      const proof = fileProof ?? readProof;
      const diagnostics = analysis?.diagnostics.length === commands.length ? analysis.diagnostics : undefined;
      const originals = options?.originalCommands;
      if (originals && originals.length !== commands.length) throw new Error("Managed normalization provenance mismatch");
      return new BashProgram(
        command,
        commands.map((cmd, index) => {
          const diagnostic = diagnostics?.[index] ?? (proof ? undefined : managedGitSyntaxDiagnostic(cmd.text));
          return { ...cmd,
          ...(originals ? { managedOriginal: originals[index] } : {}),
          ...(readProof?.marked[index] && cmd.wrapperKind === "indirection" ? {
            managedGitInner: readProof.gitWrappers[index],
            ...(originals ? { managedGitOriginalInner: managedGitInnerCommand(originals[index]!) } : {}),
          } : {}),
          ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),
          ...(fileProof?.marked[index] ? { managedStaticFileEffects: true as const } :
            proof?.marked[index] ? { managedReadOnly: true as const } : {}),
          };
        }),
        fileProof ? fileProof.externalAccesses :
          proof ? [...externalAccesses.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.externalAccesses] : externalAccesses,
        fileProof ? fileProof.ruleCandidates :
          proof ? [...ruleCandidates.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.ruleCandidates] : ruleCandidates,
      );`],
]);
patch("src/handlers/gates/tool-call-gate-pipeline.ts", [
  ['import { BashProgram } from "#src/access-intent/bash/program";', 'import { BashProgram } from "#src/access-intent/bash/program";\nimport { managedStaticFileScope, originalGitCommands } from "#src/access-intent/bash/managed-read-policy";'],
  ['workdir: shell.workdir,', 'workdir: shell.workdir,\n          originalCommands: originalGitCommands(tcc.input),\n          newScope: managedStaticFileScope(tcc.input),'],
  ['import { resolveBashCommandCheck } from "./bash-command";', 'import { resolveBashCommandCheck } from "./bash-command";\nimport { managedGitDiagnosticEvidence } from "#src/presentation/agent-renderer";'],
  ['        toolDescriptor.preCheck = toolCheck;', `        // The winning spelling may be the normalized unit or its original.
        // Do not attribute an unrelated unit's failure to a command-specific deny.
        const diagnostic = bashProgram?.commands().find(cmd =>
          cmd.text === toolCheck.command || cmd.managedOriginal === toolCheck.command)?.managedGitDiagnostic;
        if (diagnostic) {
          toolDescriptor.payload = { ...toolDescriptor.payload,
            evidence: [...toolDescriptor.payload.evidence, ...managedGitDiagnosticEvidence(diagnostic)] };
          toolDescriptor.logContext.managedGitDiagnostic = diagnostic;
        }
        toolDescriptor.preCheck = toolCheck;`],
]);
patch("src/handlers/gates/bash-command.ts", [
  ['import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";', 'import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";\nimport { managedGitInnerCommand } from "#src/access-intent/bash/managed-read-policy";'],
  ['  const base = resolveOnBashSurface(cmd.text, agentName, resolver);', `  const configured = resolveOnBashSurface(cmd.text, agentName, resolver);
  // Dedicated internal surfaces opt into deterministic effects over only the
  // ordinary Bash catch-all. Neither is a registered tool or command allowance.
  const readOptIn = resolver.resolve({ kind: "tool", surface: "managed_static_read", input: {}, agentName });
  const fileOptIn = resolver.resolve({ kind: "tool", surface: "managed_static_file_effects", input: {}, agentName });
  const enabledRead = readOptIn.state === "allow" && readOptIn.source === "tool";
  const enabledFile = fileOptIn.state === "allow" && fileOptIn.source === "tool";
  const enabled = (cmd.managedReadOnly && enabledRead) || (cmd.managedStaticFileEffects && enabledFile);
  const sentinel = cmd.managedStaticFileEffects ? "<managed-static-file-effects>" : "<managed-static-read>";
  // Provenance and exact parsing exclude flags/assignments, other wrappers
  // and any spelling not covered by the complete program proof. Both rules
  // are still checked when opt-in is off; only the floor exemption needs it.
  const managedGit = cmd.managedReadOnly &&
    cmd.wrapperKind === "indirection" && !cmd.parseUnresolved && !cmd.context &&
    cmd.managedGitInner !== undefined && managedGitInnerCommand(cmd.text) === cmd.managedGitInner &&
    (cmd.managedOriginal === undefined || (cmd.managedGitOriginalInner !== undefined &&
      managedGitInnerCommand(cmd.managedOriginal) === cmd.managedGitOriginalInner));
  const managedGitFloorExempt = managedGit && enabledRead &&
    "getConfigIssues" in resolver && typeof resolver.getConfigIssues === "function" &&
    resolver.getConfigIssues(agentName).length === 0;
  // Command-specific asks/denies, session decisions and invalid policy remain
  // upstream. Set the corresponding managed surface to ask to opt out.
  let base = enabled && configured.state === "ask" &&
    configured.matchedPattern === "*" && configured.source === "bash" &&
    "getConfigIssues" in resolver && typeof resolver.getConfigIssues === "function" &&
    resolver.getConfigIssues(agentName).length === 0
    ? { ...configured, state: "allow" as const, matchedPattern: sentinel }
    : configured;
  // Normalization must not evade explicit rules or session decisions matching
  // the spelling the model actually requested (including exact patterns).
  const original = cmd.managedOriginal === undefined ? undefined :
    resolveOnBashSurface(cmd.managedOriginal, agentName, resolver);
  // Additive/reductive execution hardening must not invalidate an existing
  // exact allowance/session grant merely because its spelling became safer.
  // A specific normalized ask/deny and any invalid-policy clamp still win.
  if (original?.state === "allow" && configured.state === "ask" &&
      configured.matchedPattern === "*" && configured.source === "bash" &&
      "getConfigIssues" in resolver && typeof resolver.getConfigIssues === "function" &&
      resolver.getConfigIssues(agentName).length === 0) base = { ...original, command: cmd.text };
  const originalRestricted = original && original.state !== "allow" &&
    !(original.state === "ask" && original.matchedPattern === "*" && original.source === "bash" &&
      enabled && "getConfigIssues" in resolver && typeof resolver.getConfigIssues === "function" &&
      resolver.getConfigIssues(agentName).length === 0);
  if (originalRestricted) {
    const restricted = pickMostRestrictive([base, original]) ?? original;
    if (!managedGit) return restricted;
    base = restricted;
  }`],
  ['  const floored =\n    cmd.wrapperKind && base.state === "allow"', `  // Resolve BOTH spellings, even when the wrapper itself asks or denies.
  // A bare inner unit avoids re-applying the wrapper floor recursively, while
  // retaining read opt-in and exact original-inner asks/denies/session rules.
  // Keep the outer unit as the decision/session value: no grant to a fragment.
  const managedGitCheck = managedGit
    ? { ...(pickMostRestrictive([base, resolveCommandUnit({
        text: cmd.managedGitInner!, managedReadOnly: true,
        ...(cmd.managedGitOriginalInner === undefined ? {} : { managedOriginal: cmd.managedGitOriginalInner }),
      }, cmd.managedGitInner!, agentName, resolver)]) ?? base), command: cmd.text }
    : undefined;
  const floored = managedGitCheck
    ? (!managedGitFloorExempt && managedGitCheck.state === "allow"
        ? { ...managedGitCheck, state: "ask" as const, matchedPattern: WRAPPER_SENTINEL.indirection }
        : managedGitCheck)
    : cmd.wrapperKind && base.state === "allow"`],
]);
// Missing proof is a reason to explain, never an authorizer. The deciding
// surface/token/rule and the session-approval scope remain exactly upstream.
patch("src/handlers/gates/bash-path.ts", [
  ['import { buildPathAskPayload } from "#src/presentation/path-ask-payload";', 'import { buildPathAskPayload } from "#src/presentation/path-ask-payload";\nimport { managedGitDiagnosticEvidence } from "#src/presentation/agent-renderer";'],
  ['  const pattern = normalizer.approvalPatternFor(worstEntry.path);', `  // One failed unit withholds the complete program proof. This diagnostic
  // describes that loss, not the identity or authority of the deciding path.
  const diagnostic = worstEntry.effect.effect === "unproven"
    ? bashProgram.commands().find(cmd => cmd.managedGitDiagnostic)?.managedGitDiagnostic : undefined;
  const pattern = normalizer.approvalPatternFor(worstEntry.path);`],
  ['    payload,\n    sessionApproval:', '    payload: { ...payload, evidence: [...payload.evidence, ...managedGitDiagnosticEvidence(diagnostic)] },\n    sessionApproval:'],
  ['      effectSource: worstEntry.effect.source,', '      effectSource: worstEntry.effect.source,\n      ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),'],
]);
patch("src/presentation/agent-renderer.ts", [
  ['import type { BashCommandContext } from "#src/types";', 'import type { BashCommandContext } from "#src/types";\nimport type { ManagedGitDiagnostic } from "#src/access-intent/bash/managed-read-policy";'],
  ['  type PromptPayload,', '  type PromptPayload,\n  type PromptEvidence,'],
  ['export function renderRefusal(', `export function renderRefusal(
  payload: PromptPayload,
  decidedBy: DecisionSource,
  denialReason: string | null,
  budget: AgentRenderBudget = DEFAULT_RENDER_BUDGET,
): string {
  return renderRefusalVerdict(payload, decidedBy, denialReason, budget) +
    managedGitProofClause(payload, budget);
}

function renderRefusalVerdict(`],
  ['/** The agent-facing render of a policy deny. */', `/** Presentation-only facts; no permission or session-grant semantics. */
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

/** The agent-facing render of a policy deny. */`],
  ['    ruleReason,\n  );', '    ruleReason,\n  ) + managedGitProofClause(payload, budget);'],
]);
// A prompt can fail after its start broadcast (for example when the managed
// inline-prompt queue times out). End that exact displayed request regardless
// of outcome, without inventing a permission decision. Capture its id before
// the synchronous, observer-visible start emit: bus listeners receive a mutable
// object and must not be able to redirect this lifecycle-only observation.
patch("src/authority/local-user-authorizer.ts", [
  [`  authorize(
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
  }`, `  async authorize(
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
  }`],
]);
// The upstream forwarding envelope intentionally omits SDK toolCallId. Publish
// a synchronous, host-local correlation BEFORE writing the request, without
// changing the wire protocol or giving this observer any permission authority.
// A stale/absent observer simply leaves model approval unbound; normal human
// forwarding and every deterministic permission gate remain unchanged.
patch("src/authority/approval-escalator.ts", [
  ['    const uiPrompt = buildUiPrompt(details);', `    const managedRequestId = forwardableRequestId(details.requestId);
    const observers = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers")];
    const observe = observers instanceof Map ? observers.get(getSessionId(this.ctx)) : undefined;
    try {
      if (typeof observe === "function") observe({ requestId: managedRequestId, toolCallId: details.toolCallId });
    } catch { /* Optional observation must not disable normal human forwarding. */ }
    const uiPrompt = buildUiPrompt(details);`],
  ['      requestId: details.requestId,', '      requestId: managedRequestId,'],
]);
// A profile that wholly denies path_write declares a capability ceiling, not
// a catch-all to shallow-merge with inherited path exceptions. Keep that ceiling
// across project policy, session grants and both yolo paths. Partial profile
// rules retain upstream semantics; existing specific denies keep their origins.
patch("src/policy/permission-manager.ts", [
  ['  composedRules: Ruleset;', '  composedRules: Ruleset;\n  agentWriteFloor: Ruleset;'],
  ['    const composedRules = composeRuleset(', `    const agentWriteFloor: Ruleset = [];
    for (const [origin, scope] of [["agent", agentConfig], ["project-agent", projectAgentConfig]] as const) {
      const rules = normalizeFlatConfig({ path_write: scope.permission?.path_write });
      const catchAll = rules.find((rule) => rule.pattern === "*" && rule.action === "deny");
      if (catchAll && rules.every((rule) => rule.action === "deny")) {
        agentWriteFloor.push({ ...catchAll, layer: "config", origin });
      }
    }
    const composedRules = composeRuleset(`],
  ['      composedRules: effectiveRules,', '      composedRules: effectiveRules,\n      agentWriteFloor,'],
  ['    return composedRules.filter((r) => r.layer === "config");',
    '    return [...composedRules.filter((r) => r.layer === "config"), ...this.resolvePermissions(agentName).agentWriteFloor];'],
  ['    return evaluate(toolName.trim(), "*", composedRules, this.flavor).action;',
    '    if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return "deny";\n    return evaluate(toolName.trim(), "*", composedRules, this.flavor).action;'],
  ['    return isSurfaceFullyDenied(toolName.trim(), composedRules, this.flavor);',
    '    if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return true;\n    return isSurfaceFullyDenied(toolName.trim(), composedRules, this.flavor);'],
  ['    const { composedRules } = this.resolvePermissions(intent.agentName);',
    '    const { composedRules, agentWriteFloor } = this.resolvePermissions(intent.agentName);'],
  ['        fullRules,\n        this.flavor,', '        fullRules,\n        this.flavor,\n        agentWriteFloor,'],
  ['      fullRules,\n      this.flavor,', '      fullRules,\n      this.flavor,\n      agentWriteFloor,'],
  ['  fullRules: Ruleset,\n  flavor: PathFlavor,', '  fullRules: Ruleset,\n  flavor: PathFlavor,\n  agentWriteFloor: Ruleset,'],
  ['  const { rule, value } = PATH_SURFACES.has(surface)', '  const { rule: matchedRule, value } = PATH_SURFACES.has(surface)'],
  ['  // For MCP, replace the normalizer\'s fallback target with the actual', `  // Clamp the final answer, after session rules and YOLO, without changing
  // existing denial provenance or resurrecting shadowed path exceptions.
  const rule = surface === "path_write" && matchedRule.action !== "deny" && agentWriteFloor.length
    ? agentWriteFloor[agentWriteFloor.length - 1]!
    : matchedRule;

  // For MCP, replace the normalizer's fallback target with the actual`],
]);
// Session-scoped yolo from the approval indicator (see managed-session-yolo.ts).
// It joins the config knob in the one reader both yolo paths already share,
// so it inherits upstream's reach exactly. `serviceLifecycle` is declared
// later in the composition root; gates only run after it exists, and a read
// before then falls back to "not yolo" rather than throwing.
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "managed-session-yolo.ts"), join(root, "src/authority/managed-session-yolo.ts"));
patch("src/index.ts", [
  ['import { isYoloModeEnabled } from "#src/config/extension-config";', 'import { isYoloModeEnabled } from "#src/config/extension-config";\nimport { managedSessionYolo } from "#src/authority/managed-session-yolo";'],
  ['  const isYoloEnabled = (): boolean => isYoloModeEnabled(configStore.current());', `  const isYoloEnabled = (): boolean => {
    if (isYoloModeEnabled(configStore.current())) return true;
    let sessionId: string | null;
    try { sessionId = serviceLifecycle.currentSessionId(); } catch { return false; }
    return managedSessionYolo(sessionId, subagentRegistry);
  };`],
]);
// Yolo turns asks into allows, but not the asks the fail-closed floor made
// out of allows in an invalid scope: upstream rewrites those back, so an
// invalid project config would grant silently under yolo. Both yolo paths
// (the ruleset rewrite and the post-resolution grant) keep them as asks.
patch("src/policy/rule.ts", [
  ['    rule.action === "ask" ? { ...rule, action: "allow", origin: "yolo" } : rule,',
    '    rule.action === "ask" && rule.origin !== "fail-closed" ? { ...rule, action: "allow", origin: "yolo" } : rule,'],
]);
patch("src/handlers/gates/helpers.ts", [
  ['  if (check.state === "ask" && yoloEnabled) {', '  if (check.state === "ask" && yoloEnabled && check.origin !== "fail-closed") {'],
]);
// Portable installs are writable by their owner, unlike a root-owned Nix store.
// Apply an immutable, deny-only resource floor in the shared resolver so project
// overrides, session grants, and yolo cannot authorize self-modification or
// credential reads. Direct policy-unit tests may omit it; production startup
// always requires the initialized process-local snapshot.
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "managed-resource-protection.ts"), join(root, "src/policy/managed-resource-protection.ts"));
patch("src/policy/permission-manager.ts", [
  ['import { join } from "node:path";', 'import { join } from "node:path";\nimport { managedResourceMatch, type ManagedResourceProtection } from "./managed-resource-protection";'],
  ['  isYoloEnabled?: () => boolean;', '  isYoloEnabled?: () => boolean;\n  resourceProtection?: ManagedResourceProtection;'],
  ['  private readonly isYoloEnabled: () => boolean;', '  private readonly isYoloEnabled: () => boolean;\n  private readonly resourceProtection: ManagedResourceProtection | undefined;'],
  ['    this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;', '    this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;\n    this.resourceProtection = options.resourceProtection;'],
  ['        agentWriteFloor,', '        agentWriteFloor,\n        this.resourceProtection,'],
  ['      agentWriteFloor,\n    );', '      agentWriteFloor,\n      this.resourceProtection,\n    );'],
  ['  agentWriteFloor: Ruleset,\n): PermissionCheckResult', '  agentWriteFloor: Ruleset,\n  resourceProtection: ManagedResourceProtection | undefined,\n): PermissionCheckResult'],
  ['  const rule = surface === "path_write"', '  let rule = surface === "path_write"'],
  ['    : matchedRule;\n\n  // For MCP', `    : matchedRule;
  const protectedPath = managedResourceMatch(resourceProtection, surface, values);
  if (rule.action !== "deny" && protectedPath !== undefined) {
    rule = { surface, action: "deny", pattern: protectedPath, layer: "config", origin: "builtin",
      reason: "Protected Alehouse runtime, configuration, or credential; change it outside the agent." };
  }

  // For MCP`],
]);
patch("src/index.ts", [
  ['import { PermissionManager } from "#src/policy/permission-manager";', 'import { PermissionManager } from "#src/policy/permission-manager";\nimport { requireManagedResourceProtection } from "#src/policy/managed-resource-protection";'],
  ['  const permissionManager = new PermissionManager({\n    agentDir,', '  const permissionManager = new PermissionManager({\n    resourceProtection: requireManagedResourceProtection(),\n    agentDir,'],
]);
console.log("Applied managed permission/provenance/profile/yolo and immutable resource-floor patches to pi-permission-system 32.0.3");
