// Final-shape, deny-only privilege floor. Keep raw global Bash ordering before
// destructive scope merge; no session/yolo grant or wrapper floor can hide it.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

function edit(root, file, edits) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length - 1, 1, `Patch drift: ${file}: ${before}`);
    text = text.replace(before, after);
  }
  writeFileSync(path, text);
}

export function applyPrivilegeCommandPatch(root) {
  for (const name of [
    "managed-privilege-command.ts",
    "managed-privilege-inspection.ts",
    "managed-heredoc-execution.ts",
  ])
    copyFileSync(
      join(packageRoot, "src/authority", name),
      join(root, "src/access-intent/bash", name),
    );
  edit(root, "src/access-intent/bash/parser.ts", [
    [
      'import { memoizeAsyncWithRetry } from "./async-cache";',
      'import { memoizeAsyncWithRetry } from "./async-cache";\nimport { managedHeredocParser } from "./managed-heredoc-execution.ts";',
    ],
    ["  return parser;\n}", "  return managedHeredocParser(parser);\n}"],
  ]);
  edit(root, "src/policy/permission-manager.ts", [
    [
      'import { join } from "node:path";',
      `import { join } from "node:path";
import { privilegeCommandAliases, privilegePatternMayMatch, simplePrivilegeSource } from "#src/access-intent/bash/managed-privilege-command.ts";`,
    ],
    [
      "  gitBashScopes: Ruleset[];",
      "  gitBashScopes: Ruleset[];\n  globalPrivilegeBashRules: Ruleset;",
    ],
    [
      "  checkGitBashRestriction?(command: string, agentName?: string, sessionRules?: Ruleset): PermissionCheckResult | undefined;",
      `  checkPrivilegeBashRestriction?(command: string, agentName?: string): PermissionCheckResult | undefined;
  hasPrivilegeBashRestriction?(agentName?: string): boolean;
  checkGitBashRestriction?(command: string, agentName?: string, sessionRules?: Ruleset): PermissionCheckResult | undefined;`,
    ],
    [
      "    const projectConfig = this.loader.loadProjectConfig();",
      `    // Retain genuine Bash rules only, including same-scope allow/ask
    // exceptions. The universal synthesized default is not a privilege floor.
    const globalBash = globalConfig.permission?.bash;
    const globalPrivilegeBashRules: Ruleset = globalBash === undefined ? [] :
      normalizeFlatConfig({ bash: globalBash })
        .map(rule => ({ ...rule, layer: "config" as const, origin: "global" as const }));
    const projectConfig = this.loader.loadProjectConfig();`,
    ],
    [
      "      gitBashScopes,\n      failClosedScopes,",
      "      gitBashScopes,\n      globalPrivilegeBashRules,\n      failClosedScopes,",
    ],
    [
      "  getResolvedPolicyPaths(): ResolvedPolicyPaths {",
      `  hasPrivilegeBashRestriction(agentName?: string): boolean {
    const rules = this.resolvePermissions(agentName).globalPrivilegeBashRules;
    return rules.some((rule, index) => rule.action === "deny" && privilegePatternMayMatch(rule.pattern) &&
      !rules.slice(index + 1).some(later => later.pattern === "*" && later.action !== "deny"));
  }

  /** A real simple-command unit, not interpreter source or display text. */
  checkPrivilegeBashRestriction(command: string, agentName?: string): PermissionCheckResult | undefined {
    const aliases = privilegeCommandAliases(command);
    if (!aliases) return undefined;
    const { globalPrivilegeBashRules } = this.resolvePermissions(agentName);
    // Evaluate aliases TOGETHER, preserving the full raw global rule order.
    // A later same-scope exception wins even across raw/canonical spellings.
    const { rule } = evaluateAnyValue("bash", aliases, globalPrivilegeBashRules, this.flavor);
    if (rule.action !== "deny" || rule.layer !== "config") return undefined;
    return { state: "deny", toolName: "bash", source: "bash", origin: "global",
      command, matchedPattern: rule.pattern, reason: rule.reason };
  }

  getResolvedPolicyPaths(): ResolvedPolicyPaths {`,
    ],
    [
      "    const result = this.checkComposed(intent, sessionRules, options);",
      `    // Direct literal invocations also clamp the unconditional manager
    // query. Full shell programs are inspected by the AST gate/advisory/parent
    // orchestrators, never treated as one matched-text permission shortcut.
    if (intent.kind === "tool" && intent.surface.trim() === "bash" &&
        typeof intent.input === "object" && intent.input !== null && "command" in intent.input &&
        typeof intent.input.command === "string" && simplePrivilegeSource(intent.input.command)) {
      const privilege = this.checkPrivilegeBashRestriction(intent.input.command, intent.agentName);
      if (privilege) return privilege;
    }
    const result = this.checkComposed(intent, sessionRules, options);`,
    ],
  ]);
  edit(root, "src/policy/permission-resolver.ts", [
    [
      "export interface ScopedPermissionResolver {",
      `export interface ScopedPermissionResolver {
  checkPrivilegeBashRestriction?(command: string, agentName?: string): PermissionCheckResult | undefined;
  hasPrivilegeBashRestriction?(agentName?: string): boolean;`,
    ],
    [
      "  checkGitBashRestriction(command: string, agentName?: string): PermissionCheckResult | undefined {",
      `  hasPrivilegeBashRestriction(agentName?: string): boolean {
    return this.permissionManager.hasPrivilegeBashRestriction?.(agentName) ?? false;
  }

  checkPrivilegeBashRestriction(command: string, agentName?: string): PermissionCheckResult | undefined {
    return this.permissionManager.checkPrivilegeBashRestriction?.(command, agentName);
  }

  checkGitBashRestriction(command: string, agentName?: string): PermissionCheckResult | undefined {`,
    ],
  ]);
  edit(root, "src/access-intent/bash/command-enumeration.ts", [
    [
      'import { ownedRedirectTails } from "./managed-redirect-argv";',
      `import { ownedRedirectTails } from "./managed-redirect-argv";
import { literalPrivilegeCommand } from "./managed-privilege-command.ts";
import { heredocOriginalSource, heredocTextOffset } from "./managed-heredoc-execution.ts";`,
    ],
    [
      "export interface BashCommand {",
      `export interface BashCommand {
  /** Private AST-origin execution fact, never display-only executedUnit. */
  readonly managedPrivilegeCommand?: string;`,
    ],
    [
      "    unitStart ??= child.startIndex;\n    words.push({ text: child.text, offset: child.startIndex - unitStart });",
      "    const textStart = heredocTextOffset(node, child);\n    unitStart ??= textStart;\n    words.push({ text: child.text, offset: textStart - unitStart });",
    ],
    [
      "      return node.text.slice(child.startIndex - node.startIndex);",
      "      return node.text.slice(heredocTextOffset(node, child));",
    ],
    [
      "  sourceBindings.set(bound, { start: node.startIndex, text: node.text });\n  return bound;",
      `  // Only genuine command nodes get a privilege fact; compound units and
  // ERROR blobs cannot turn data/prose into executable authority. Include
  // redirect-buried argv when present, retaining exact argument spelling.
  const privilege = !parseUnresolvedWithin(node) && literalPrivilegeCommand(completedText);
  const originalSource = heredocOriginalSource(node);
  const sourced = originalSource === undefined ? bound : { ...bound, managedOriginal: originalSource };
  const result = privilege ? { ...sourced, managedPrivilegeCommand: completedText } : sourced;
  sourceBindings.set(result, { start: node.startIndex, text: originalSource ?? node.text });
  return result;`,
    ],
  ]);
  edit(root, "src/handlers/gates/bash-command.ts", [
    [
      'import type { PermissionCheckResult } from "#src/types";',
      `import type { PermissionCheckResult } from "#src/types";
import { privilegeBashFloorFromCommands } from "#src/access-intent/bash/managed-privilege-inspection.ts";`,
    ],
    [
      "  const excluded = resolveBashCommandCheckOnce(command, commands, agentName, resolver, options);",
      `  // Independent of wrapper ALLOW/ASK, opaque floors and session sources.
  const privilege = privilegeBashFloorFromCommands(commands, agentName, resolver);
  if (privilege) return privilege;
  const excluded = resolveBashCommandCheckOnce(command, commands, agentName, resolver, options);`,
    ],
  ]);
  edit(root, "src/handlers/gates/tool-call-gate-pipeline.ts", [
    [
      'import { withSynchronousPermissionSnapshot } from "#src/policy/managed-permission-snapshot";',
      `import { withSynchronousPermissionSnapshot } from "#src/policy/managed-permission-snapshot";
import { resolvePrivilegeBashFloor } from "#src/access-intent/bash/managed-privilege-inspection.ts";
import { pickMostRestrictive } from "#src/policy/restrictiveness.ts";`,
    ],
    [
      "    const forwardable =\n",
      `    // Inspect the full privately captured pre-hardening request, including
    // heredoc substitutions. Existing execution units are checked separately
    // by resolveBashCommandCheck below; neither spelling can erase a deny.
    const privilegeFloor = shell
      ? await resolvePrivilegeBashFloor(requested, tcc.agentName ?? undefined, this.resolver)
      : undefined;
    const forwardable =
`,
    ],
    [
      "        const { toolCheck, pathAccess } = this.resolvePerToolCheck(",
      "        const { toolCheck: ordinaryToolCheck, pathAccess } = this.resolvePerToolCheck(",
    ],
    [
      "        const toolDescriptor = describeToolGate(\n",
      `        const toolCheck = privilegeFloor
          ? pickMostRestrictive([privilegeFloor, ordinaryToolCheck]) ?? ordinaryToolCheck
          : ordinaryToolCheck;
        const toolDescriptor = describeToolGate(
`,
    ],
  ]);
  edit(root, "src/service/bash-advisory-check.ts", [
    [
      'import { parseBashCommandsSync } from "#src/access-intent/bash/sync-commands";',
      `import { parseBashCommandsSync } from "#src/access-intent/bash/sync-commands";
import { resolvePrivilegeBashFloorSync } from "#src/access-intent/bash/managed-privilege-inspection.ts";`,
    ],
    [
      "  const options = staticAllowExclusionOf(command, agentName, resolver)",
      `  const privilege = resolvePrivilegeBashFloorSync(command, agentName, resolver);
  if (privilege?.state === "deny") return privilege;
  const options = staticAllowExclusionOf(command, agentName, resolver)`,
    ],
    [
      '    return resolver.resolve({\n      kind: "tool",\n      surface: "bash",\n      input: { command },\n      agentName,\n    }, options);',
      `    const ordinary = resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    }, options);
    return ordinary.state === "deny" || ordinary.origin === "fail-closed" ? ordinary : privilege ?? ordinary;`,
    ],
    [
      "  return resolveBashCommandCheck(command, commands, agentName, resolver, options);",
      `  const ordinary = resolveBashCommandCheck(command, commands, agentName, resolver, options);
  return ordinary.state === "deny" || ordinary.origin === "fail-closed" ? ordinary : privilege ?? ordinary;`,
    ],
  ]);
  edit(root, "src/authority/forwarded-request-server.ts", [
    [
      'import type { PermissionCheckResult } from "#src/types";',
      `import type { PermissionCheckResult } from "#src/types";
import { resolvePrivilegeBashFloor } from "#src/access-intent/bash/managed-privilege-inspection.ts";
import { pickMostRestrictive } from "#src/policy/restrictiveness.ts";`,
    ],
    [
      "  resolve(intent: ForwardedAccessIntent): ServedCheck;",
      "  resolve(intent: ForwardedAccessIntent): ServedCheck | Promise<ServedCheck>;",
    ],
    [
      '  resolver: Pick<PermissionResolver, "resolve">,',
      '  resolver: Pick<PermissionResolver, "resolve"> & Partial<Pick<PermissionResolver, "checkPrivilegeBashRestriction" | "hasPrivilegeBashRestriction">>,',
    ],
    ["    resolve(intent) {", "    async resolve(intent) {"],
    [
      '      if (intent.surface !== "bash") return resolver.resolve(resolved);\n      const exclusion =',
      `      if (intent.surface !== "bash") return resolver.resolve(resolved);
      // The child's matchValues may name only a harmless fragment. Parent
      // authority inspects the COMPLETE request against its own raw globals,
      // before escalation or session recording, independent of exclusions.
      const privilege = await resolvePrivilegeBashFloor(
        intent.requestedCommand, intent.principal.agentName, resolver,
      );
      if (privilege?.state === "deny") return privilege;
      const exclusion =`,
    ],
    [
      "      if (!exclusion) return resolver.resolve(resolved);\n      return {\n        ...resolver.resolve(resolved, { excludeAllowRules: true }),",
      `      const ordinary = resolver.resolve(resolved, exclusion ? { excludeAllowRules: true } : undefined);
      const check = privilege ? pickMostRestrictive([privilege, ordinary]) ?? ordinary : ordinary;
      if (!exclusion) return check;
      return {
        ...check,`,
    ],
    [
      "    const check = this.policy.resolve(request.accessIntent);",
      `    const check = await this.policy.resolve(request.accessIntent);
    // Missing/failed full-source inspection is not a configured sudo denial.
    // It is an incomplete-proof gate error, never authorizer/session authority.
    if (check.origin === "fail-closed" &&
        ["<uninspected-privilege-command>", "<uninspected-heredoc-execution>"].includes(check.matchedPattern ?? "")) {
      const reason = "The full requested Bash execution source could not be completely inspected.";
      return { ...createDeniedPermissionDecision(reason), decidedBy: { kind: "gate_error", reason } };
    }`,
    ],
  ]);
}
