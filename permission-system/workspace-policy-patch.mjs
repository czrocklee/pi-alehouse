// Applied after the Git patches to the private pinned vendor copy only.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function applyWorkspacePolicyPatch(root) {
  function patch(file, edits) {
    let text = readFileSync(join(root, file), "utf8");
    for (const [before, after] of edits) {
      assert.equal(text.split(before).length, 2, `Workspace policy patch drift: ${file}: ${before}`);
      text = text.replace(before, after);
    }
    writeFileSync(join(root, file), text);
  }
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "managed-workspace-policy.ts"),
    join(root, "src/policy/managed-workspace-policy.ts"));
  patch("src/session/permission-session.ts", [
    ['import type { ExtensionContext }', 'import { assertWorkspacePolicy, workspacePolicyForContext, type WorkspacePolicyBinding } from "#src/policy/managed-workspace-policy";\nimport type { ExtensionContext }'],
    ['  private context: ExtensionContext | null = null;', '  private context: ExtensionContext | null = null;\n  private workspacePolicy: WorkspacePolicyBinding | undefined;'],
    ['    this.context = ctx;', `    if (this.workspacePolicy) assertWorkspacePolicy(this.workspacePolicy);
    const binding = workspacePolicyForContext(ctx);
    if (this.workspacePolicy !== binding) {
      if (this.workspacePolicy) throw new Error("Workspace policy session binding mismatch");
      this.workspacePolicy = binding;
      if (binding) this.permissionManager.configureForCwd(binding.projectTrusted ? binding.source_cwd : undefined, binding);
    }
    this.context = ctx;`],
    ['    this.permissionManager.configureForCwd(\n      projectTrusted ? ctx.cwd : undefined,\n    );', `    const binding = workspacePolicyForContext(ctx);
    if (this.workspacePolicy) {
      assertWorkspacePolicy(this.workspacePolicy);
      if (binding !== this.workspacePolicy) throw new Error("Workspace policy session binding mismatch");
    }
    this.workspacePolicy = binding;
    this.permissionManager.configureForCwd(
      binding ? (binding.projectTrusted ? binding.source_cwd : undefined) : (projectTrusted ? ctx.cwd : undefined), binding,
    );`],
    ['    this.permissionManager.configureForCwd(\n      projectTrusted ? this.context?.cwd : undefined,\n    );', `    if (this.workspacePolicy) assertWorkspacePolicy(this.workspacePolicy);
    const binding = workspacePolicyForContext(this.context ?? undefined);
    if (binding !== this.workspacePolicy) throw new Error("Workspace policy session binding mismatch");
    this.permissionManager.configureForCwd(
      binding ? (binding.projectTrusted ? binding.source_cwd : undefined) : (projectTrusted ? this.context?.cwd : undefined), binding,
    );`],
    ['  getPathNormalizer(): PathNormalizer {', `  getWorkspacePolicy(): WorkspacePolicyBinding | undefined {
    if (this.workspacePolicy) {
      assertWorkspacePolicy(this.workspacePolicy);
      if (workspacePolicyForContext(this.context ?? undefined) !== this.workspacePolicy)
        throw new Error("Workspace policy session binding mismatch");
    }
    return this.workspacePolicy;
  }

  getPathNormalizer(): PathNormalizer {
    this.getWorkspacePolicy();`],
  ]);
  patch("src/handlers/lifecycle.ts", [
    ['import type { ExtensionContext }', 'import { workspacePolicyForContext } from "#src/policy/managed-workspace-policy";\nimport type { ExtensionContext }'],
    ['    const projectTrusted = ctx.isProjectTrusted();\n    this.session.refreshConfig', '    const projectTrusted = workspacePolicyForContext(ctx)?.projectTrusted ?? ctx.isProjectTrusted();\n    this.session.refreshConfig'],
    ['    const projectTrusted = ctx.isProjectTrusted();\n    this.session.reload', '    const projectTrusted = workspacePolicyForContext(ctx)?.projectTrusted ?? ctx.isProjectTrusted();\n    this.session.reload'],
  ]);
  patch("src/config/config-store.ts", [
    ['import {\n  existsSync,', 'import { assertWorkspacePolicy, workspacePolicyForContext, type WorkspacePolicyBinding } from "#src/policy/managed-workspace-policy";\nimport {\n  existsSync,'],
    ['  private lastConfigWarning: string | null = null;', '  private lastConfigWarning: string | null = null;\n  private workspacePolicy: WorkspacePolicyBinding | undefined;'],
    ['    const cwd = ctx?.cwd ?? null;', `    if (!ctx && this.workspacePolicy) assertWorkspacePolicy(this.workspacePolicy);
    const binding = ctx ? workspacePolicyForContext(ctx) : this.workspacePolicy;
    if (this.workspacePolicy && binding !== this.workspacePolicy)
      throw new Error("Workspace policy config session binding mismatch");
    this.workspacePolicy = binding;
    const cwd = binding?.source_cwd ?? ctx?.cwd ?? null;
    projectTrusted = binding?.projectTrusted ?? projectTrusted;`],
  ]);
  patch("src/policy/permission-manager.ts", [
    ['import { join } from "node:path";', 'import { join } from "node:path";\nimport { assertWorkspacePolicy, workspacePolicyAliases, type WorkspacePolicyBinding } from "./managed-workspace-policy";'],
    ['  configureForCwd(cwd: string | undefined | null): void;', '  configureForCwd(cwd: string | undefined | null, workspacePolicy?: WorkspacePolicyBinding): void;'],
    ['  private loader: PolicyLoader;', '  private loader: PolicyLoader;\n  private workspacePolicy: WorkspacePolicyBinding | undefined;'],
    ['  configureForCwd(cwd: string | undefined | null): void {', `  configureForCwd(cwd: string | undefined | null, workspacePolicy?: WorkspacePolicyBinding): void {
    if (workspacePolicy) {
      assertWorkspacePolicy(workspacePolicy);
      if (cwd !== (workspacePolicy.projectTrusted ? workspacePolicy.source_cwd : undefined))
        throw new Error("Workspace policy source cwd mismatch");
    }
    this.workspacePolicy = workspacePolicy;`],
    ['  private resolvePermissions(agentName?: string): ResolvedPermissions {', '  private resolvePermissions(agentName?: string): ResolvedPermissions {\n    if (this.workspacePolicy) assertWorkspacePolicy(this.workspacePolicy);'],
    ['  check(\n    intent: ResolvedAccessIntent,\n    sessionRules?: Ruleset,\n  ): PermissionCheckResult {', `  private workspaceRestriction(surface: string, values: string[], agentName: string | undefined,
    sessionRules: Ruleset | undefined, forwardedValues: readonly string[] | undefined): Rule | undefined {
    if (!PATH_SURFACES.has(surface)) return;
    if (!this.workspacePolicy && forwardedValues === undefined) return;
    const aliases = [...workspacePolicyAliases(this.workspacePolicy, values), ...(forwardedValues ?? [])];
    if (!aliases.length) return; // Paths outside the bound workspace keep their ordinary policy.
    const { gitBashScopes, failClosedScopes } = this.resolvePermissions(agentName);
    // Keep each raw scope's own ordering/allow exceptions. Never let an alias
    // ALLOW erase an actual-path deny, or import an ALLOW into normal matching.
    const selected = gitBashScopes.flatMap(rules =>
      [values, aliases].filter(group => group.length > 0).map(group => evaluateAnyValue(surface, group, rules, this.flavor).rule))
      .filter(rule => rule.layer === "config" && (rule.action === "deny" || (rule.action === "ask" && rule.pattern !== "*")));
    if (!selected.length) return;
    const restrictions = [...selected.filter(rule => rule.action === "ask"),
      ...(failClosedScopes.length ? [] : sessionRules ?? []), ...selected.filter(rule => rule.action === "deny")];
    const effective = this.isYoloEnabled() ? rewriteAsksToYolo(restrictions) : restrictions;
    const rule = evaluateAnyValue(surface, [...values, ...aliases], effective, this.flavor).rule;
    return rule.action === "deny" || rule.action === "ask" ? rule : undefined;
  }

  check(
    intent: ResolvedAccessIntent,
    sessionRules?: Ruleset,
  ): PermissionCheckResult {`],
    ['        this.resourceProtection,', '        this.resourceProtection,\n        this.workspaceRestriction(intent.surface, lookupValues, intent.agentName, sessionRules, intent.workspacePolicyValues),'],
    ['      this.resourceProtection,\n    );', '      this.resourceProtection,\n      this.workspaceRestriction(surface, values, intent.agentName, sessionRules, intent.workspacePolicyValues),\n    );'],
    ['  resourceProtection: ManagedResourceProtection | undefined,\n): PermissionCheckResult {', '  resourceProtection: ManagedResourceProtection | undefined,\n  workspaceRestriction: Rule | undefined,\n): PermissionCheckResult {'],
    ['  const { rule: matchedRule, value } = PATH_SURFACES.has(surface)', '  let { rule: matchedRule, value } = PATH_SURFACES.has(surface)'],
    ['  // Clamp the final answer, after session rules and YOLO,', `  if (workspaceRestriction && (workspaceRestriction.action === "deny" || matchedRule.action === "allow")) {
    matchedRule = workspaceRestriction;
  }

  // Clamp the final answer, after session rules and YOLO,`],
  ]);
  patch("src/access-intent/access-intent.ts", [
    ['import type { AccessPath } from "./access-path";', `import type { AccessPath } from "./access-path";
interface WorkspacePolicyIntent {
  /** Restriction-only source-workspace spellings, never ordinary ALLOW values. */
  workspacePolicyValues?: readonly string[];
}`],
    ['export interface ToolAccessIntent {', 'export interface ToolAccessIntent extends WorkspacePolicyIntent {'],
    ['export interface PathValuesAccessIntent {', 'export interface PathValuesAccessIntent extends WorkspacePolicyIntent {'],
    ['export interface AccessPathAccessIntent {', 'export interface AccessPathAccessIntent extends WorkspacePolicyIntent {'],
  ]);
  patch("src/policy/permission-resolver.ts", [
    ['      values: intent.path.matchValues(),', '      values: intent.path.matchValues(),\n      workspacePolicyValues: intent.workspacePolicyValues,'],
  ]);
  patch("src/handlers/gates/types.ts", [
    ['/** Outcome of a single permission gate evaluation. */', 'import type { WorkspacePolicyBinding } from "#src/policy/managed-workspace-policy";\n\n/** Outcome of a single permission gate evaluation. */'],
    ['  cwd: string;', '  cwd: string;\n  workspacePolicy?: WorkspacePolicyBinding;'],
  ]);
  patch("src/handlers/permission-gate-handler.ts", [
    ['    const tcc: ToolCallContext = {', '    const tcc: ToolCallContext = {\n      workspacePolicy: this.session.getWorkspacePolicy(),'],
    ['    return await this.pipeline.evaluate(tcc, this.runner);', `    const outcome = await this.pipeline.evaluate(tcc, this.runner);
    // A release/context change during a forwarded approval invalidates allow.
    if (outcome.action === "allow") this.session.activate(ctx);
    return outcome;`],
  ]);
  patch("src/handlers/gates/helpers.ts", [
    ['import type { AccessPath }', 'import { PATH_SURFACES } from "#src/access-intent/path-surfaces";\nimport { workspacePolicyAliases, type WorkspacePolicyBinding } from "#src/policy/managed-workspace-policy";\nimport type { AccessPath }'],
    ['  path: AccessPath,\n): ForwardedAccessFacts {', '  path: AccessPath,\n  workspacePolicy?: WorkspacePolicyBinding,\n): ForwardedAccessFacts {'],
    ['    matchValues: path.matchValues(),', '    matchValues: path.matchValues(),\n    ...(workspacePolicy ? { workspacePolicyValues: workspacePolicyAliases(workspacePolicy, path.matchValues()) } : {}),'],
    [`/**
 * Build the child-fixed access facts for a non-path gate (bash command, MCP
 * target, skill name, plain tool) from its already-portable single value.
 */
export function accessFactsFromValue(
  surface: string,
  value: string,
): ForwardedAccessFacts {
  return { surface, matchValues: [value], boundaryValue: null };
}`, `/**
 * Build the child-fixed access facts for a gate without an AccessPath — a
 * non-path gate, or a path-bearing tool called with an omitted path (ls,
 * find, grep) — from its already-portable single value. A bound PATH_SURFACE
 * also carries the restriction-only aliases of that value, possibly empty:
 * the serving verifier requires a present array for every bound path surface.
 */
export function accessFactsFromValue(
  surface: string,
  value: string,
  workspacePolicy?: WorkspacePolicyBinding,
): ForwardedAccessFacts {
  return {
    surface,
    matchValues: [value],
    ...(workspacePolicy && PATH_SURFACES.has(surface)
      ? { workspacePolicyValues: workspacePolicyAliases(workspacePolicy, [value]) }
      : {}),
    boundaryValue: null,
  };
}`],
  ]);
  for (const file of ["path", "external-directory"]) patch(`src/handlers/gates/${file}.ts`, [
    ['accessFactsFromPath(surface, accessPath)', 'accessFactsFromPath(surface, accessPath, tcc.workspacePolicy)'],
  ]);
  for (const file of ["bash-path", "bash-external-directory"]) patch(`src/handlers/gates/${file}.ts`, [
    ['accessFactsFromPath(surface, worstEntry.path)', 'accessFactsFromPath(surface, worstEntry.path, tcc.workspacePolicy)'],
  ]);
  patch("src/handlers/gates/tool.ts", [
    ['accessFactsFromPath(gateSurface, pathAccess.path)', 'accessFactsFromPath(gateSurface, pathAccess.path, tcc.workspacePolicy)'],
    ['accessFactsFromValue(gateSurface, decisionValue)', 'accessFactsFromValue(gateSurface, decisionValue, tcc.workspacePolicy)'],
  ]);
  patch("src/authority/permission-forwarding.ts", [
    ['export interface ForwardedAccessFacts {', 'export interface ForwardedAccessFacts {\n  /** Restriction-only aliases; not execution/boundary paths or ALLOW inputs. */\n  workspacePolicyValues?: readonly string[];'],
  ]);
  patch("src/authority/forwarding-io.ts", [
    ['    requesterCwd?: unknown;\n    principal?: unknown;', '    requesterCwd?: unknown;\n    principal?: unknown;\n    workspacePolicyValues?: unknown;'],
    ['    surface: candidate.surface,', `    ...(candidate.workspacePolicyValues !== undefined ? {
      workspacePolicyValues: Array.isArray(candidate.workspacePolicyValues) &&
        candidate.workspacePolicyValues.length <= 256 && candidate.workspacePolicyValues.every(value => typeof value === "string")
          ? [...candidate.workspacePolicyValues] : ["<invalid-workspace-policy-values>"],
    } : {}),
    surface: candidate.surface,`],
  ]);
  patch("src/authority/forwarded-request-server.ts", [
    ['    matchValues: intent.matchValues,', '    matchValues: intent.matchValues,\n    ...(intent.workspacePolicyValues !== undefined ? { workspacePolicyValues: intent.workspacePolicyValues } : {}),'],
    [`    const check = request.accessIntent
      ? this.policy.resolve(request.accessIntent)
      : null;`, `    // Serving-policy verification and resolution fail closed: a request whose
    // binding, parentage, or restriction-alias verification breaks is answered
    // with an explicit denial, never an escape from inbox processing.
    let check: PermissionCheckResult | null = null;
    if (request.accessIntent) {
      try {
        check = this.policy.resolve(request.accessIntent);
      } catch (error) {
        const reason = formatUnknownErrorMessage(error);
        logPermissionForwardingError(
          this.logger,
          \`Failed to resolve forwarded permission request '\${request.id}'\`,
          error,
        );
        return {
          ...createDeniedPermissionDecision(reason),
          decidedBy: { kind: "gate_error", reason },
        };
      }
    }`],
  ]);
  patch("src/index.ts", [
    ['import type { ExtensionAPI }', 'import { workspacePolicyForwardedValues } from "#src/policy/managed-workspace-policy";\nimport type { ExtensionAPI }'],
    [`    resolve: (intent) =>
      resolver.resolve(
        buildResolvedIntentFromMatchValues(
          intent.surface,
          intent.matchValues,
          intent.principal.agentName,
        ),
      ),`, `    resolve: (intent) => resolver.resolve({
      ...buildResolvedIntentFromMatchValues(intent.surface, intent.matchValues, intent.principal.agentName),
      workspacePolicyValues: workspacePolicyForwardedValues(intent, serviceLifecycle.currentSessionId(), subagentRegistry),
    }),`],
  ]);
}
