// Static-allow exclusion: shell shapes a static Bash allow cannot prove safe
// may not be covered by any allow rule (configured or session), so they reach
// ordinary approval instead of a guard refusal the model must respell around.
// The program is resolved both with allows set aside and in full; the stricter
// answer wins, so no restriction the full policy finds can disappear. A serving
// parent re-evaluates the requested command against its own allows. Same-build
// contract: requester and serving authority change together; missing or
// malformed forwarded facts are refused, never dropped.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

// Exactly `count` occurrences of every anchor, replaced in order.
function edit(root, file, edits) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  for (const [before, after, count = 1] of edits) {
    assert.equal(text.split(before).length - 1, count, `Patch drift: ${file}: ${before}`);
    text = text.replaceAll(before, after);
  }
  writeFileSync(path, text);
}

export function applyStaticAllowExclusionPatch(root) {
  for (const file of ["static-allow-exclusion.ts", "shell-literal.ts", "git-invocation.ts"])
    copyFileSync(
      join(packageRoot, "src/extensions/lib", file),
      join(root, "src/access-intent/bash", file),
    );

  // ── Resolution: one option, applied before the yolo rewrite ──────────────
  edit(root, "src/policy/permission-manager.ts", [
    [
      "export interface ScopedPermissionManager {",
      `/** Per-check resolution options (Alehouse static-allow exclusion). */
export interface PermissionCheckOptions {
  /** Resolve as if no allow rule (configured or session) were present. */
  excludeAllowRules?: boolean;
}

export interface ScopedPermissionManager {`,
    ],
    [
      "    sessionRules?: Ruleset,\n  ): PermissionCheckResult;",
      "    sessionRules?: Ruleset,\n    options?: PermissionCheckOptions,\n  ): PermissionCheckResult;",
    ],
    [
      "  check(\n    intent: ResolvedAccessIntent,\n    sessionRules?: Ruleset,\n  ): PermissionCheckResult {",
      `  check(
    intent: ResolvedAccessIntent,
    sessionRules?: Ruleset,
    options?: PermissionCheckOptions,
  ): PermissionCheckResult {
    const result = this.checkComposed(intent, sessionRules, options);
    // An excluded check's remaining ask -- including the synthesized default,
    // which the composition-stage rewrite cannot reach -- is answered by yolo
    // exactly as GateRunner would. Deny and the fail-closed floor never yield.
    return options?.excludeAllowRules &&
      result.state === "ask" &&
      result.origin !== "fail-closed" &&
      this.isYoloEnabled()
      ? { ...result, state: "allow", origin: "yolo" }
      : result;
  }

  private checkComposed(
    intent: ResolvedAccessIntent,
    sessionRules?: Ruleset,
    options?: PermissionCheckOptions,
  ): PermissionCheckResult {`,
    ],
    [
      `    const fullRules: Ruleset = this.isYoloEnabled()
      ? rewriteAsksToYolo(composedWithSession)
      : composedWithSession;`,
      `    // Removed before yolo: yolo still answers the remaining ask, while deny
    // rules and the fail-closed floor keep holding. Session rules are allows.
    const visibleRules: Ruleset = options?.excludeAllowRules
      ? composedWithSession.filter((rule) => rule.action !== "allow")
      : composedWithSession;
    const fullRules: Ruleset = this.isYoloEnabled()
      ? rewriteAsksToYolo(visibleRules)
      : visibleRules;`,
    ],
  ]);
  edit(root, "src/policy/permission-resolver.ts", [
    [
      'import type { ScopedPermissionManager } from "./permission-manager";',
      'import type { PermissionCheckOptions, ScopedPermissionManager } from "./permission-manager";',
    ],
    [
      "  resolve(intent: AccessIntent): PermissionCheckResult;",
      "  resolve(intent: AccessIntent, options?: PermissionCheckOptions): PermissionCheckResult;",
    ],
    [
      "    intent: AccessIntent | PathValuesAccessIntent,\n  ): PermissionCheckResult {",
      "    intent: AccessIntent | PathValuesAccessIntent,\n    options?: PermissionCheckOptions,\n  ): PermissionCheckResult {",
    ],
    [
      "      return this.permissionManager.check(resolved, sessionRuleset);",
      "      return this.permissionManager.check(resolved, sessionRuleset, options);",
    ],
    [
      "      this.permissionManager.check({ ...resolved, surface }, sessionRuleset);",
      "      this.permissionManager.check({ ...resolved, surface }, sessionRuleset, options);",
    ],
  ]);

  // ── Bash command gate: every bash-surface resolution carries the option ──
  // Managed opt-in surfaces are not bash rules and stay unaffected; the managed
  // lane still promotes only the ordinary catch-all ask to its sentinel.
  edit(root, "src/handlers/gates/bash-command.ts", [
    [
      'import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";',
      `import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";
import type { PermissionCheckOptions } from "#src/policy/permission-manager";
import {
  STATIC_ALLOW_REQUEST_LIMIT,
  staticAllowExclusion,
  UNVERIFIED_ORIGINAL,
  type StaticAllowExclusion,
} from "#src/access-intent/bash/static-allow-exclusion";`,
    ],
    ["export function resolveBashCommandCheck(", "function resolveBashCommandCheckOnce("],
    ["agentName, resolver)", "agentName, resolver, options)", 11],
    [
      "  resolver: ScopedPermissionResolver,\n): PermissionCheckResult {",
      "  resolver: ScopedPermissionResolver,\n  options?: PermissionCheckOptions,\n): PermissionCheckResult {",
      4,
    ],
    [
      "    input: { command },\n    agentName,\n  });\n}",
      `    input: { command },
    agentName,
  }, options);
}

/**
 * The static-allow exclusion for a requested Bash program, or undefined.
 * \`requested\` is the complete pre-hardening text; undefined means it could
 * not be verified, which never proves safety. Allows come from the real
 * resolver (every config scope and session grants); yolo grants and managed
 * sentinels are not allow rules. Only text is analysed; nothing is cached.
 */
export function staticAllowExclusionOf(
  requested: string | undefined,
  agentName: string | undefined,
  resolver: ScopedPermissionResolver,
): StaticAllowExclusion | undefined {
  if (requested === undefined || requested.length > STATIC_ALLOW_REQUEST_LIMIT)
    return UNVERIFIED_ORIGINAL;
  return staticAllowExclusion(requested, (value) => {
    const check = resolveOnBashSurface(value, agentName, resolver);
    return check.state === "allow" && check.origin !== "yolo";
  });
}

/**
 * Resolve the bash command-pattern decision for a (possibly chained) command.
 *
 * Under a static-allow exclusion the program is resolved twice: with allow
 * rules set aside, and in full. Setting allows aside changes control flow (a
 * wrapper's inner rules are consulted only while the wrapper itself resolves
 * to allow), so the full pass keeps every restriction the ordinary policy
 * finds, while the excluded pass keeps any allow from covering the program.
 * The stricter answer wins; ties keep the excluded answer, and an answer that
 * leans on a session grant is never returned for an excluded program.
 */
export function resolveBashCommandCheck(
  command: string,
  commands: BashCommand[],
  agentName: string | undefined,
  resolver: ScopedPermissionResolver,
  options?: PermissionCheckOptions,
): PermissionCheckResult {
  const excluded = resolveBashCommandCheckOnce(command, commands, agentName, resolver, options);
  if (!options?.excludeAllowRules) return excluded;
  const full = resolveBashCommandCheckOnce(command, commands, agentName, resolver);
  const stricter = pickMostRestrictive([excluded, full]) ?? excluded;
  return stricter !== excluded && stricter.source === "session"
    ? { ...stricter, source: "bash" }
    : stricter;
}`,
    ],
  ]);

  // ── Advisory queries answer at gate parity ───────────────────────────────
  edit(root, "src/service/bash-advisory-check.ts", [
    [
      'import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";',
      'import { resolveBashCommandCheck, staticAllowExclusionOf } from "#src/handlers/gates/bash-command";',
    ],
    [
      `  const commands = parseBashCommandsSync(command);
  if (commands === null) {
    return resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    });
  }
  return resolveBashCommandCheck(command, commands, agentName, resolver);`,
      `  const options = staticAllowExclusionOf(command, agentName, resolver)
    ? { excludeAllowRules: true }
    : undefined;
  const commands = parseBashCommandsSync(command);
  if (commands === null) {
    return resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    }, options);
  }
  return resolveBashCommandCheck(command, commands, agentName, resolver, options);`,
    ],
  ]);

  // Shared bounded trigger evidence for local and parent-computed exclusions.
  writeFileSync(
    join(root, "src/presentation/static-allow-exclusion-evidence.ts"),
    `import {
  describeStaticAllowExclusion,
  type StaticAllowExclusion,
} from "#src/access-intent/bash/static-allow-exclusion";
import type { PromptPayload } from "./prompt-payload";

export const STATIC_ALLOW_EXCLUSION_EVIDENCE = "static allow not applied";

/** One bounded trigger, whether the child or serving parent excluded allows. */
export function withStaticAllowExclusionEvidence(
  payload: PromptPayload,
  fact: StaticAllowExclusion,
): PromptPayload {
  if (payload.evidence.some((entry) => entry.label === STATIC_ALLOW_EXCLUSION_EVIDENCE))
    return payload;
  return {
    ...payload,
    evidence: [
      ...payload.evidence,
      {
        label: STATIC_ALLOW_EXCLUSION_EVIDENCE,
        text: describeStaticAllowExclusion(fact),
        detail: fact.word || null,
      },
    ],
  };
}
`,
  );

  // ── Tool-call pipeline: one program-level fact from the requested text ───
  edit(root, "src/handlers/gates/tool-call-gate-pipeline.ts", [
    [
      'import { managedStaticFileScope, originalGitCommands } from "#src/access-intent/bash/managed-read-policy";',
      `import { managedStaticFileScope, originalGitCommands, requestedBashCommand } from "#src/access-intent/bash/managed-read-policy";
import {
  STATIC_ALLOW_REQUEST_LIMIT,
  type StaticAllowExclusion,
} from "#src/access-intent/bash/static-allow-exclusion";
import { withStaticAllowExclusionEvidence } from "#src/presentation/static-allow-exclusion-evidence";
export { STATIC_ALLOW_EXCLUSION_EVIDENCE } from "#src/presentation/static-allow-exclusion-evidence";`,
    ],
    [
      'import { resolveBashCommandCheck } from "./bash-command";',
      'import { resolveBashCommandCheck, staticAllowExclusionOf } from "./bash-command";',
    ],
    [
      'import { type GateResult, orderDenyFirst } from "./descriptor";',
      'import { type GateDescriptor, type GateResult, orderDenyFirst } from "./descriptor";',
    ],
    [
      "      : null;\n\n    const formatter = new ToolPreviewFormatter(",
      `      : null;
    // Computed once per call from the requested (pre-hardening) command held
    // in private provenance and bound to this input's real execution text,
    // never from a model-suppliable field or the trimmed shell projection.
    const requested = shell
      ? requestedBashCommand(tcc.input as Record<string, unknown>, shell.command)
      : undefined;
    const forwardable =
      requested !== undefined && requested.length <= STATIC_ALLOW_REQUEST_LIMIT
        ? requested
        : undefined;
    const allowExclusion = shell
      ? staticAllowExclusionOf(forwardable, tcc.agentName ?? undefined, this.resolver)
      : undefined;

    const formatter = new ToolPreviewFormatter(`,
    ],
    [
      "          shell,\n          bashProgram,\n          normalizer,\n        );",
      "          shell,\n          bashProgram,\n          normalizer,\n          allowExclusion,\n        );",
    ],
    [
      "        toolDescriptor.preCheck = toolCheck;\n        return toolDescriptor;",
      `        toolDescriptor.preCheck = toolCheck;
        if (shell) attachRequestedCommand(toolDescriptor, forwardable);
        if (allowExclusion) applyStaticAllowExclusion(toolDescriptor, allowExclusion);
        return toolDescriptor;`,
    ],
    [
      "    normalizer: PathNormalizer,\n  ): { toolCheck: PermissionCheckResult; pathAccess?: ToolPathAccess } {",
      "    normalizer: PathNormalizer,\n    allowExclusion?: StaticAllowExclusion,\n  ): { toolCheck: PermissionCheckResult; pathAccess?: ToolPathAccess } {",
    ],
    [
      "            tcc.agentName ?? undefined,\n            this.resolver,\n          ),",
      "            tcc.agentName ?? undefined,\n            this.resolver,\n            allowExclusion ? { excludeAllowRules: true } : undefined,\n          ),",
    ],
    [
      `          input: { command: shell.command },
          agentName: tcc.agentName ?? undefined,
        }),
      };`,
      `          input: { command: shell.command },
          agentName: tcc.agentName ?? undefined,
        }, allowExclusion ? { excludeAllowRules: true } : undefined),
      };`,
    ],
  ]);
  const pipeline = join(root, "src/handlers/gates/tool-call-gate-pipeline.ts");
  writeFileSync(
    pipeline,
    readFileSync(pipeline, "utf8") +
      `
/**
 * Every shell gate forwards the complete requested command, so a serving parent
 * evaluates the exclusion against its own allows and session grants, which
 * this node cannot see. An unforwardable command is already an exclusion.
 */
function attachRequestedCommand(
  descriptor: GateDescriptor,
  requested: string | undefined,
): void {
  const { accessIntent } = descriptor.promptDetails;
  if (requested === undefined || !accessIntent) return;
  descriptor.promptDetails = {
    ...descriptor.promptDetails,
    accessIntent: { ...accessIntent, requestedCommand: requested },
  };
}

/**
 * Shape the Bash tool gate of an excluded program: one-time approval only (no
 * session suggestion, option or record), the trigger as evidence, and the fact
 * on the forwarded access facts so a serving parent resolves the same way.
 */
function applyStaticAllowExclusion(
  descriptor: GateDescriptor,
  fact: StaticAllowExclusion,
): void {
  delete descriptor.sessionApproval;
  const { sessionLabel: _sessionLabel, ...details } = descriptor.promptDetails;
  descriptor.promptDetails = {
    ...details,
    sessionGrantUnavailable: true,
    ...(details.accessIntent
      ? { accessIntent: { ...details.accessIntent, staticAllowExclusion: fact } }
      : {}),
  };
  descriptor.payload = withStaticAllowExclusionEvidence(descriptor.payload, fact);
  descriptor.logContext.staticAllowExclusion = fact;
}
`,
  );

  // ── Ask details and forwarded facts ──────────────────────────────────────
  edit(root, "src/authority/permission-prompter.ts", [
    [
      `   * the same evidence as a local one; only a version-skew request that carried
   * no intent leaves this absent.`,
      `   * the same evidence as a local one. Every current gate supplies these facts;
   * the optional field permits incomplete request representation, not an
   * authorization fallback. The serving node denies missing or malformed facts
   * before policy, authorizers or session recording.`,
    ],
    [
      "  accessIntent?: ForwardedAccessFacts;\n}",
      `  accessIntent?: ForwardedAccessFacts;
  /** One-time approval only: no session option may be offered or recorded. */
  sessionGrantUnavailable?: boolean;
}`,
    ],
  ]);
  edit(root, "src/authority/permission-forwarding.ts", [
    [
      'import type { PromptPayload } from "#src/presentation/prompt-payload";',
      `import type { PromptPayload } from "#src/presentation/prompt-payload";
import type { StaticAllowExclusion } from "#src/access-intent/bash/static-allow-exclusion";`,
    ],
    [
      "  boundaryValue: string | null;\n}",
      `  boundaryValue: string | null;
  /**
   * Bash surface only: the requester excluded its allows for this program.
   * The serving node then resolves without allow rules as well.
   */
  staticAllowExclusion?: StaticAllowExclusion;
  /**
   * Bash surface only: the complete requested (pre-hardening) command, so the
   * serving node evaluates the exclusion against its own allows and session
   * grants. Every bash ask carries this, the exclusion fact, or both.
   */
  requestedCommand?: string;
}`,
    ],
    [
      `   * The child-fixed access intent (ADR 0008 §2). Optional for version-skew
   * tolerance: an older child omits it, and the serving node floors to \`ask\`
   * (Step 3). Present on a current child's request for every gate surface.`,
      `   * The child-fixed access intent (ADR 0008 §2), supplied by every current
   * sender for every gate surface. Optional only to represent invalid inbound
   * requests: missing or malformed facts receive an explicit denial before
   * policy, authorizers or session recording, never a fallback to ask.`,
    ],
    [
      "  accessIntent?: ForwardedAccessIntent;\n};",
      `  accessIntent?: ForwardedAccessIntent;
  /** Set only by the reader: missing/malformed access or static-allow facts. */
  invalidStaticAllowExclusion?: true;
};`,
    ],
  ]);
  edit(root, "src/authority/forwarding-io.ts", [
    [
      ` * Tolerant read: the child-fixed access intent is optional (absent on an older
 * child) and only accepted when fully well-formed — a string \`surface\`, an
 * all-string \`matchValues\` array, a \`string | null\` \`boundaryValue\`, a string
 * \`requesterCwd\`, and a \`principal\` with string \`sessionId\`/\`agentName\`. Any
 * malformed shape → \`undefined\`, so the serving node floors to \`ask\` (Step 3)
 * rather than resolving against corrupt facts.`,
      ` * Current senders fix these facts for every gate. Return undefined for any
 * malformed shape; the reader marks the request invalid so the serving node
 * explicitly denies before policy, authorizers or session recording.`,
    ],
    [
      'import { asDecisionSource } from "./decision-source";',
      `import { asDecisionSource } from "./decision-source";
import {
  isStaticAllowExclusion,
  STATIC_ALLOW_REQUEST_LIMIT,
} from "#src/access-intent/bash/static-allow-exclusion";`,
    ],
    [
      '    typeof candidate.surface !== "string" ||\n    !Array.isArray(candidate.matchValues)',
      '    typeof candidate.surface !== "string" ||\n    !candidate.surface || candidate.surface.trim() !== candidate.surface ||\n    !Array.isArray(candidate.matchValues)',
    ],
    [
      "    requesterCwd?: unknown;\n    principal?: unknown;\n  };",
      "    requesterCwd?: unknown;\n    principal?: unknown;\n    staticAllowExclusion?: unknown;\n    requestedCommand?: unknown;\n  };",
    ],
    [
      `    principal: {
      sessionId: principal.sessionId,
      agentName: principal.agentName,
    },
  };
}`,
      `    principal: {
      sessionId: principal.sessionId,
      agentName: principal.agentName,
    },
    ...(candidate.surface === "bash" &&
    isStaticAllowExclusion(candidate.staticAllowExclusion)
      ? {
          staticAllowExclusion: {
            rule: candidate.staticAllowExclusion.rule,
            unitText: candidate.staticAllowExclusion.unitText,
            word: candidate.staticAllowExclusion.word,
          },
        }
      : {}),
    ...(candidate.surface === "bash" && isForwardableCommand(candidate.requestedCommand)
      ? { requestedCommand: candidate.requestedCommand }
      : {}),
  };
}

const isForwardableCommand = (value: unknown): value is string =>
  typeof value === "string" && value.length <= STATIC_ALLOW_REQUEST_LIMIT;

/**
 * Current senders fix complete access facts for every gate. Refuse a missing
 * or malformed intent on every surface, before policy, escalation or grants;
 * there is no older shape to tolerate. The fixed payload surface, not the
 * display tool name, must agree: Bash also emits path/external-directory asks.
 * A bash intent additionally needs an exclusion fact, requested text, or both;
 * no other surface may carry either static-allow field.
 */
function hasInvalidStaticAllowExclusion(value: unknown, payload: unknown): boolean {
  const intent = asForwardedAccessIntent(value);
  if (!intent) return true;
  const payloadSurface = asPromptPayload(payload)?.request.surface;
  if (payloadSurface !== undefined && payloadSurface !== intent.surface) return true;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  if (intent.surface !== "bash") return has("staticAllowExclusion") || has("requestedCommand");
  return (
    (!has("staticAllowExclusion") && !has("requestedCommand")) ||
    (has("staticAllowExclusion") && !isStaticAllowExclusion(intent.staticAllowExclusion)) ||
    (has("requestedCommand") && !isForwardableCommand(intent.requestedCommand))
  );
}`,
    ],
    [
      "      accessIntent: asForwardedAccessIntent(parsed.accessIntent),\n    };",
      `      accessIntent: asForwardedAccessIntent(parsed.accessIntent),
      ...(hasInvalidStaticAllowExclusion(parsed.accessIntent, parsed.payload)
        ? { invalidStaticAllowExclusion: true as const }
        : {}),
    };`,
    ],
  ]);

  // ── Serving node: its own evaluation, one-time approval ──────────────────
  edit(root, "src/authority/forwarded-request-server.ts", [
    [
      'import type { PermissionCheckResult } from "#src/types";',
      `import type { PermissionCheckResult } from "#src/types";
import type { StaticAllowExclusion } from "#src/access-intent/bash/static-allow-exclusion";
import { buildResolvedIntentFromMatchValues } from "#src/access-intent/input-normalizer";
import { staticAllowExclusionOf } from "#src/handlers/gates/bash-command";
import type { PermissionResolver } from "#src/policy/permission-resolver";
import { withStaticAllowExclusionEvidence } from "#src/presentation/static-allow-exclusion-evidence";`,
    ],
    [
      "export interface ServingPolicy {\n  resolve(intent: ForwardedAccessIntent): PermissionCheckResult;\n}",
      `export interface ServingPolicy {
  resolve(intent: ForwardedAccessIntent): ServedCheck;
}

/** A served resolution, with the static-allow exclusion it was made under. */
export type ServedCheck = PermissionCheckResult & {
  staticAllowExclusion?: StaticAllowExclusion;
};

/**
 * The composition root's serving policy: the child-fixed match values resolved
 * as-is, agent-scoped to the requester. A bash request is excluded when the
 * requester excluded it or when this node's own allows and session grants make
 * the requested command an exclusion (the requester cannot see either). An
 * excluded request resolves with no allow rule; the manager then answers a
 * remaining ask with this node's yolo, never a deny or the fail-closed floor.
 */
export function createServingPolicy(
  resolver: Pick<PermissionResolver, "resolve">,
): ServingPolicy {
  return {
    resolve(intent) {
      const resolved = buildResolvedIntentFromMatchValues(
        intent.surface,
        intent.matchValues,
        intent.principal.agentName,
      );
      if (intent.surface !== "bash") return resolver.resolve(resolved);
      const exclusion =
        intent.staticAllowExclusion ??
        staticAllowExclusionOf(intent.requestedCommand, intent.principal.agentName, resolver);
      if (!exclusion) return resolver.resolve(resolved);
      return {
        ...resolver.resolve(resolved, { excludeAllowRules: true }),
        staticAllowExclusion: exclusion,
      };
    },
  };
}

/** One-time approval only: neither node records a grant for an excluded ask. */
function oneTimeDecision(decision: PermissionPromptDecision): PermissionPromptDecision {
  if (!decision.approved || decision.state === "approved") return decision;
  const { sessionGrantWidth: _width, ...approved } = decision;
  return { ...approved, state: "approved" };
}`,
    ],
    [
      "function buildForwardedAskDetails(\n  request: ForwardedPermissionRequest,\n): PromptPermissionDetails {",
      "function buildForwardedAskDetails(\n  request: ForwardedPermissionRequest,\n  exclusion?: StaticAllowExclusion,\n): PromptPermissionDetails {",
    ],
    [
      "  const payload = buildForwardedAskPayload(request);",
      `  const childPayload = buildForwardedAskPayload(request);
  const payload = exclusion
    ? withStaticAllowExclusionEvidence(childPayload, exclusion)
    : childPayload;`,
    ],
    [
      `    ...(request.sessionApproval
      ? { sessionApproval: request.sessionApproval }
      : {}),
    // Absent for a version-skew request`,
      `    ...(request.sessionApproval && !exclusion
      ? { sessionApproval: request.sessionApproval }
      : {}),
    ...(exclusion ? { sessionGrantUnavailable: true } : {}),
    // Absent for a version-skew request`,
    ],
    [
      `    // Carries the child's suggestion so LocalUserAuthorizer can offer the
    // whole-session grant scope; absent for a legacy/version-skew request.`,
      `    // An ordinary current ask may suggest a whole-session grant; an
    // excluded ask is one-time only, regardless of the child's suggestion.`,
    ],
    [
      `    // Absent for a version-skew request that carried no intent — which the
    // delegation envelope reads as "surface undetermined" and fail-safes to
    // excluded, so absence must stay absence rather than become \`undefined\`.`,
      "    // Missing current access facts are refused before this projection.",
    ],
    [
      `   * \`deny\` auto-denies), then escalate \`ask\` (or a request missing
   * \`accessIntent\`, the version-skew floor, ADR 0008 §4) to the selected
   * \`Authorizer\`.`,
      `   * \`deny\` auto-denies), then escalate \`ask\` to the selected \`Authorizer\`.
   * Missing or malformed current access facts are denied before resolution.`,
    ],
    [
      "      ? { accessIntent: toAccessFacts(request.accessIntent) }",
      "      ? { accessIntent: toAccessFacts(request.accessIntent, exclusion) }",
    ],
    [
      "function toAccessFacts(intent: ForwardedAccessIntent): ForwardedAccessFacts {",
      `function toAccessFacts(
  intent: ForwardedAccessIntent,
  exclusion?: StaticAllowExclusion,
): ForwardedAccessFacts {`,
    ],
    [
      "    boundaryValue: intent.boundaryValue,\n  };\n}",
      `    boundaryValue: intent.boundaryValue,
    // The exclusion this node applied; the requested command stays off the
    // authorizer facts (the payload already renders what runs).
    ...(exclusion ? { staticAllowExclusion: exclusion } : {}),
  };
}`,
    ],
    [
      "    const check = request.accessIntent\n      ? this.policy.resolve(request.accessIntent)\n      : null;",
      `    if (request.invalidStaticAllowExclusion || !request.accessIntent) {
      const reason = "Forwarded access intent or static-allow exclusion facts are missing or malformed.";
      return { ...createDeniedPermissionDecision(reason), decidedBy: { kind: "gate_error", reason } };
    }
    const check = this.policy.resolve(request.accessIntent);
    const exclusion = check.staticAllowExclusion;`,
    ],
    [
      "    const details = buildForwardedAskDetails(request);\n    const decision = await this.escalateAsk(details);",
      `    const details = buildForwardedAskDetails(request, exclusion);
    const escalated = await this.escalateAsk(details);
    const decision = exclusion ? oneTimeDecision(escalated) : escalated;`,
    ],
  ]);
  edit(root, "src/index.ts", [
    [
      `  // PathNormalizer/cwd (#597).`,
      `  // PathNormalizer/cwd (#597). Missing or malformed current access facts
  // are denied by the server before this policy or any authorizer runs.`,
    ],
    [
      'import { buildResolvedIntentFromMatchValues } from "#src/access-intent/input-normalizer";\n',
      "",
    ],
    [
      `  const servingPolicy: ServingPolicy = {
    resolve: (intent) =>
      resolver.resolve(
        buildResolvedIntentFromMatchValues(
          intent.surface,
          intent.matchValues,
          intent.principal.agentName,
        ),
      ),
  };`,
      "  const servingPolicy: ServingPolicy = createServingPolicy(resolver);",
    ],
    [
      '} from "#src/authority/forwarded-request-server";',
      '  createServingPolicy,\n} from "#src/authority/forwarded-request-server";',
    ],
  ]);

  // ── Approval UI: no session option, no session hotkeys ───────────────────
  edit(root, "src/authority/local-user-authorizer.ts", [
    [
      "): RequestPermissionOptions | undefined {\n  const grants = details.sessionApproval?.grants ?? [];",
      `): RequestPermissionOptions | undefined {
  // A static-allow exclusion ask offers a one-time approval only.
  if (details.sessionGrantUnavailable) return { sessionGrantUnavailable: true };
  const grants = details.sessionApproval?.grants ?? [];`,
    ],
  ]);
  edit(root, "src/authority/permission-dialog.ts", [
    [
      "    subagentLabel: string;\n    servingSessionLabel: string;\n  };\n}",
      `    subagentLabel: string;
    servingSessionLabel: string;
  };
  /** Offer no session option at all: a one-time approval only. */
  sessionGrantUnavailable?: boolean;
}`,
    ],
    [
      `  const decisionOptions = [
    APPROVE_OPTION,
    sessionOption,
    ...(widthOption ? [widthOption] : []),
    DENY_OPTION,`,
      `  const sessionAvailable = !options?.sessionGrantUnavailable;
  const decisionOptions = [
    APPROVE_OPTION,
    ...(sessionAvailable ? [sessionOption] : []),
    ...(sessionAvailable && widthOption ? [widthOption] : []),
    DENY_OPTION,`,
    ],
    [
      "  if (selected === sessionOption || (widthOption && selected === widthOption)) {",
      "  if (sessionAvailable && (selected === sessionOption || (widthOption && selected === widthOption))) {",
    ],
  ]);
  edit(root, "src/authority/permission-prompt-decision.ts", [
    [
      'const NARROW_OPTION_ORDER: readonly PromptKey[] = OPTION_ORDER.filter(\n  (key) => key !== "b",\n);',
      `const NARROW_OPTION_ORDER: readonly PromptKey[] = OPTION_ORDER.filter(
  (key) => key !== "b",
);

const ONE_TIME_OPTION_ORDER: readonly PromptKey[] = ["y", "n", "r"];`,
    ],
    [
      "  return config.widthLabel ? OPTION_ORDER : NARROW_OPTION_ORDER;",
      "  if (config.sessionGrantUnavailable) return ONE_TIME_OPTION_ORDER;\n  return config.widthLabel ? OPTION_ORDER : NARROW_OPTION_ORDER;",
    ],
    [
      '  sessionScope?: NonNullable<RequestPermissionOptions["sessionScope"]>;\n}',
      `  sessionScope?: NonNullable<RequestPermissionOptions["sessionScope"]>;
  /** Hide and refuse the session keys: a one-time approval only. */
  sessionGrantUnavailable?: boolean;
}`,
    ],
    [
      '    case "s":\n    case "b": {',
      `    case "s":
    case "b": {
      if (!visibleOptionKeys(config).includes(key)) return render(state);`,
    ],
  ]);
  edit(root, "src/authority/permission-prompt-component.ts", [
    [
      "    sessionScope: options?.sessionScope,\n  };",
      "    sessionScope: options?.sessionScope,\n    sessionGrantUnavailable: options?.sessionGrantUnavailable,\n  };",
    ],
  ]);
}
