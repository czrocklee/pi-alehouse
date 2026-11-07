// Deny/specific-ask checks for native Git are independent of query eligibility.
// These checks cannot produce a grant or relax the ordinary permission gates.
export function applyNativeGitRestrictions(root, patch) {
  patch("src/policy/permission-manager.ts", [
    ["import { normalizeFlatConfig }", "import { expandDirectionalSugar, normalizeFlatConfig }"],
    ["  agentWriteFloor: Ruleset;", "  agentWriteFloor: Ruleset;\n  gitBashScopes: Ruleset[];"],
    [
      "  getToolPermission(toolName: string, agentName?: string): PermissionState;",
      "  checkGitBashRestriction?(command: string, agentName?: string, sessionRules?: Ruleset): PermissionCheckResult | undefined;\n  getToolPermission(toolName: string, agentName?: string): PermissionState;",
    ],
    [
      "    const composedRules = composeRuleset(",
      `    // Keep each raw scope before destructive merge/session composition,
    // including universal configured denies. Evaluate its own ordering first:
    // a same-scope allow exception is not a deny.
    const gitBashScopes = ([["global", globalConfig], ["project", projectConfig],
      ["agent", agentConfig], ["project-agent", projectAgentConfig]] as const).map(([origin, scope]) =>
      normalizeFlatConfig(expandDirectionalSugar(scope.permission ?? {}))
        .map(rule => ({ ...rule, layer: "config" as const, origin })));
    const composedRules = composeRuleset(`,
    ],
    [
      "      agentWriteFloor,\n      failClosedScopes,",
      "      agentWriteFloor,\n      gitBashScopes,\n      failClosedScopes,",
    ],
    [
      "  getResolvedPolicyPaths(): ResolvedPolicyPaths {",
      `  checkGitBashRestriction(command: string, agentName?: string, sessionRules?: Ruleset): PermissionCheckResult | undefined {
    const { gitBashScopes } = this.resolvePermissions(agentName);
    const { surface, values } = normalizeInput("bash", { command }, this.loader.getConfiguredMcpServerNames());
    const selected = gitBashScopes.map(rules => evaluateFirst(surface, values, rules, this.flavor).rule)
      .filter(rule => rule.layer === "config" && (rule.action === "deny" || (rule.action === "ask" &&
        (rule.pattern !== "*" || (rule.surface !== "bash" && rule.surface !== "*")))));
    // A recorded approval can satisfy an ask, never a configured deny. Yolo
    // remains the ordinary manager rewrite, not a new query permission grant.
    const invalid = this.getConfigIssues(agentName).length > 0;
    const restrictions = [...selected.filter(rule => rule.action === "ask"),
      ...(invalid ? [] : sessionRules ?? []), ...selected.filter(rule => rule.action === "deny")];
    const check = this.check({ kind: "tool", surface: "bash", input: { command }, agentName }, restrictions);
    if (invalid && check.state !== "deny") return { ...check, state: "ask", source: "bash", origin: "fail-closed", matchedPattern: "<managed-invalid-config>" };
    return check.state === "deny" || (check.state === "ask" &&
      (selected.some(rule => rule.action === "ask") || check.origin === "fail-closed")) ? check : undefined;
  }

  getResolvedPolicyPaths(): ResolvedPolicyPaths {`,
    ],
  ]);
  patch("src/policy/permission-resolver.ts", [
    [
      "export interface ScopedPermissionResolver {",
      "export interface ScopedPermissionResolver {\n  checkGitBashRestriction?(command: string, agentName?: string): PermissionCheckResult | undefined;",
    ],
    [
      "  checkPermission(\n",
      `  checkGitBashRestriction(command: string, agentName?: string): PermissionCheckResult | undefined {
    return this.permissionManager.checkGitBashRestriction?.(command, agentName, this.sessionRules.getRuleset());
  }

  checkPermission(
`,
    ],
  ]);
  patch("src/handlers/gates/bash-command.ts", [
    [
      `  // Provenance and exact parsing exclude flags/assignments, other wrappers
  // and any spelling not covered by the complete program proof. Both rules
  // are still checked when opt-in is off; only the floor exemption needs it.`,
      `  // Literal inner restrictions are independent of automatic query eligibility.
  // Only the floor exemption needs complete scope, opt-in and original-inner
  // provenance. An unknown/helper-bearing query gains no wrapper exemption.`,
    ],
    [
      "  return (\n    pickMostRestrictive(results) ??",
      `  const wholeRestriction = commands.some(cmd => cmd.managedGitRequest)
    ? resolver.checkGitBashRestriction?.(command, agentName) : undefined;
  return (
    pickMostRestrictive([...results, ...(wholeRestriction ? [wholeRestriction] : [])]) ??`,
    ],
    [
      `  const managedGit = cmd.managedReadOnly &&
    cmd.wrapperKind === "indirection" && !cmd.parseUnresolved && !cmd.context &&
    cmd.managedGitInner !== undefined && managedGitInnerCommand(cmd.text) === cmd.managedGitInner &&
    (cmd.managedOriginal === undefined || (cmd.managedGitOriginalInner !== undefined &&
      managedGitInnerCommand(cmd.managedOriginal) === cmd.managedGitOriginalInner));
  const managedGitFloorExempt = managedGit && enabledRead &&`,
      `  // Only the tiny automatic query lane needs recursive full inner resolution.
  // Repository Git keeps inner deny/specific-ask restrictions below, not a
  // second catch-all ask that would invalidate approval of the complete unit.
  const managedGit = cmd.managedReadOnly && cmd.wrapperKind === "indirection" && !cmd.parseUnresolved && !cmd.context &&
    cmd.managedGitInner !== undefined && managedGitInnerCommand(cmd.text) === cmd.managedGitInner;
  const originalInnerProven = cmd.managedOriginal === undefined || (cmd.managedGitOriginalInner !== undefined &&
    managedGitInnerCommand(cmd.managedOriginal) === cmd.managedGitOriginalInner);
  const managedGitFloorExempt = managedGit && originalInnerProven && enabledRead &&`,
    ],
    [
      "  if (originalRestricted) {",
      `  const nativeRestrictions = cmd.managedGitRequest
    ? [cmd.text, cmd.managedOriginal, cmd.managedGitInner, cmd.managedGitOriginalInner, ...(cmd.managedGitRestrictions ?? [])]
      .filter((text): text is string => text !== undefined)
      .flatMap(text => { const check = resolver.checkGitBashRestriction?.(text, agentName); return check ? [check] : []; })
    : [];
  // Approval of the complete source-bound unit satisfies its inner asks too.
  // It never satisfies a deny, invalid policy or argv absent from that unit.
  const approvedWholeGit = base.state === "allow" && base.source === "session" &&
    !cmd.managedRedirectCompleted && !cmd.managedGitCompleted?.length;
  if (approvedWholeGit) {
    for (let i = nativeRestrictions.length - 1; i >= 0; i--) {
      const restriction = nativeRestrictions[i];
      if (restriction?.state === "ask" && restriction.origin !== "fail-closed") nativeRestrictions.splice(i, 1);
    }
  }
  // A truncated exact ALLOW cannot cover later argv. Completed spellings may
  // restore even a catch-all ask, but can never contribute an ALLOW or opt-in.
  nativeRestrictions.push(...(cmd.managedGitCompleted ?? []).map(text =>
    resolveOnBashSurface(text, agentName, resolver)).filter(check => check.state !== "allow"));
  if (originalRestricted) {`,
    ],
    [
      "    if (!managedGit) return restricted;",
      "    if (!managedGit) return pickMostRestrictive([restricted, ...nativeRestrictions]) ?? restricted;",
    ],
    [
      "  // Resolve BOTH spellings, even when the wrapper itself asks or denies.",
      "  base = pickMostRestrictive([base, ...nativeRestrictions]) ?? base;\n  // Resolve BOTH spellings, even when the wrapper itself asks or denies.",
    ],
    [
      "  const managedGitCheck = managedGit\n",
      "  const managedGitCheck = managedGit && !approvedWholeGit\n",
    ],
    [
      "        text: cmd.managedGitInner!, managedReadOnly: true,",
      "        text: cmd.managedGitInner!,\n        ...(cmd.managedReadOnly ? { managedReadOnly: true as const } : {}),\n        ...(cmd.managedGitRequest ? { managedGitRequest: true as const } : {}),",
    ],
  ]);
}
