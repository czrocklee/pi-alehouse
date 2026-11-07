// Floors and yolo composition remain in the one upstream policy resolver.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

// A wholly denied profile path_write surface is a capability ceiling. Partial
// rules retain upstream semantics, and existing specific denials keep origins.
export function applyManagedAgentWriteFloorPatch(root, patch) {
  patch("src/policy/permission-manager.ts", [
    ["  composedRules: Ruleset;", "  composedRules: Ruleset;\n  agentWriteFloor: Ruleset;"],
    [
      "    const composedRules = composeRuleset(",
      `    const agentWriteFloor: Ruleset = [];
    for (const [origin, scope] of [["agent", agentConfig], ["project-agent", projectAgentConfig]] as const) {
      const rules = normalizeFlatConfig({ path_write: scope.permission?.path_write });
      const catchAll = rules.find((rule) => rule.pattern === "*" && rule.action === "deny");
      if (catchAll && rules.every((rule) => rule.action === "deny")) {
        agentWriteFloor.push({ ...catchAll, layer: "config", origin });
      }
    }
    const composedRules = composeRuleset(`,
    ],
    [
      "      composedRules: effectiveRules,",
      "      composedRules: effectiveRules,\n      agentWriteFloor,",
    ],
    [
      '    return composedRules.filter((r) => r.layer === "config");',
      '    return [...composedRules.filter((r) => r.layer === "config"), ...this.resolvePermissions(agentName).agentWriteFloor];',
    ],
    [
      '    return evaluate(toolName.trim(), "*", composedRules, this.flavor).action;',
      '    if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return "deny";\n    return evaluate(toolName.trim(), "*", composedRules, this.flavor).action;',
    ],
    [
      "    return isSurfaceFullyDenied(toolName.trim(), composedRules, this.flavor);",
      '    if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return true;\n    return isSurfaceFullyDenied(toolName.trim(), composedRules, this.flavor);',
    ],
    [
      "    const { composedRules } = this.resolvePermissions(intent.agentName);",
      "    const { composedRules, agentWriteFloor } = this.resolvePermissions(intent.agentName);",
    ],
    [
      "        fullRules,\n        this.flavor,",
      "        fullRules,\n        this.flavor,\n        agentWriteFloor,",
    ],
    [
      "      fullRules,\n      this.flavor,",
      "      fullRules,\n      this.flavor,\n      agentWriteFloor,",
    ],
    [
      "  fullRules: Ruleset,\n  flavor: PathFlavor,",
      "  fullRules: Ruleset,\n  flavor: PathFlavor,\n  agentWriteFloor: Ruleset,",
    ],
    [
      "  const { rule, value } = PATH_SURFACES.has(surface)",
      "  const { rule: matchedRule, value } = PATH_SURFACES.has(surface)",
    ],
    [
      "  // For MCP, replace the normalizer's fallback target with the actual",
      `  // Clamp the final answer, after session rules and YOLO, without changing
  // existing denial provenance or resurrecting shadowed path exceptions.
  const rule = surface === "path_write" && matchedRule.action !== "deny" && agentWriteFloor.length
    ? agentWriteFloor[agentWriteFloor.length - 1]!
    : matchedRule;

  // For MCP, replace the normalizer's fallback target with the actual`,
    ],
  ]);
}

// Both existing yolo paths share this session-aware reader. The later-declared
// lifecycle can be unavailable during composition: that means not yolo.
export function applyManagedSessionYoloPatch(root, patch) {
  copyFileSync(
    join(packageRoot, "src/authority/managed-session-yolo.ts"),
    join(root, "src/authority/managed-session-yolo.ts"),
  );
  patch("src/index.ts", [
    [
      'import { isYoloModeEnabled } from "#src/config/extension-config";',
      'import { isYoloModeEnabled } from "#src/config/extension-config";\nimport { managedSessionYolo } from "#src/authority/managed-session-yolo";',
    ],
    [
      "  const isYoloEnabled = (): boolean => isYoloModeEnabled(configStore.current());",
      `  const isYoloEnabled = (): boolean => {
    if (isYoloModeEnabled(configStore.current())) return true;
    let sessionId: string | null;
    try { sessionId = serviceLifecycle.currentSessionId(); } catch { return false; }
    return managedSessionYolo(sessionId, subagentRegistry);
  };`,
    ],
  ]);
  // Yolo must not turn invalid-config fail-closed asks back into allows, in
  // either the ruleset rewrite or the post-resolution grant.
  patch("src/policy/rule.ts", [
    [
      '    rule.action === "ask" ? { ...rule, action: "allow", origin: "yolo" } : rule,',
      '    rule.action === "ask" && rule.origin !== "fail-closed" ? { ...rule, action: "allow", origin: "yolo" } : rule,',
    ],
  ]);
  patch("src/handlers/gates/helpers.ts", [
    [
      '  if (check.state === "ask" && yoloEnabled) {',
      '  if (check.state === "ask" && yoloEnabled && check.origin !== "fail-closed") {',
    ],
  ]);
}

// Immutable deny-only resource floor, applied after the profile write ceiling.
// Production requires the initialized snapshot; direct policy tests may omit it.
export function applyManagedResourceFloorPatch(root, patch) {
  copyFileSync(
    join(packageRoot, "src/authority/managed-resource-protection.ts"),
    join(root, "src/policy/managed-resource-protection.ts"),
  );
  patch("src/policy/permission-manager.ts", [
    [
      'import { join } from "node:path";',
      'import { join } from "node:path";\nimport { managedResourceMatch, type ManagedResourceProtection } from "./managed-resource-protection";',
    ],
    [
      "  isYoloEnabled?: () => boolean;",
      "  isYoloEnabled?: () => boolean;\n  resourceProtection?: ManagedResourceProtection;",
    ],
    [
      "  private readonly isYoloEnabled: () => boolean;",
      "  private readonly isYoloEnabled: () => boolean;\n  private readonly resourceProtection: ManagedResourceProtection | undefined;",
    ],
    [
      "    this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;",
      "    this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;\n    this.resourceProtection = options.resourceProtection;",
    ],
    ["        agentWriteFloor,", "        agentWriteFloor,\n        this.resourceProtection,"],
    [
      "      agentWriteFloor,\n    );",
      "      agentWriteFloor,\n      this.resourceProtection,\n    );",
    ],
    [
      "  agentWriteFloor: Ruleset,\n): PermissionCheckResult",
      "  agentWriteFloor: Ruleset,\n  resourceProtection: ManagedResourceProtection | undefined,\n): PermissionCheckResult",
    ],
    ['  const rule = surface === "path_write"', '  let rule = surface === "path_write"'],
    [
      "    : matchedRule;\n\n  // For MCP",
      `    : matchedRule;
  const protectedPath = managedResourceMatch(resourceProtection, surface, values);
  if (rule.action !== "deny" && protectedPath !== undefined) {
    rule = { surface, action: "deny", pattern: protectedPath, layer: "config", origin: "builtin",
      reason: "Protected Alehouse runtime, configuration, or credential; change it outside the agent." };
  }

  // For MCP`,
    ],
  ]);
  patch("src/index.ts", [
    [
      'import { PermissionManager } from "#src/policy/permission-manager";',
      'import { PermissionManager } from "#src/policy/permission-manager";\nimport { requireManagedResourceProtection } from "#src/policy/managed-resource-protection";',
    ],
    [
      "  const permissionManager = new PermissionManager({\n    agentDir,",
      "  const permissionManager = new PermissionManager({\n    resourceProtection: requireManagedResourceProtection(),\n    agentDir,",
    ],
  ]);
}
