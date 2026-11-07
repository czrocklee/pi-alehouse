// Non-Git literal effects, private original-input binding and ordinary gates.
// Native Git eligibility/restrictions are layered separately after this patch.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

export function applyManagedReadPatch(root, patch) {
  const source = join(packageRoot, "src/authority");
  for (const file of ["managed-read-policy.ts", "managed-inspection.ts", "managed-static-files.ts"])
    copyFileSync(join(source, file), join(root, "src/access-intent/bash", file));
  copyFileSync(
    join(packageRoot, "src/extensions/lib/git-read-grammar.ts"),
    join(root, "src/access-intent/bash/git-read-grammar.ts"),
  );
  patch("src/access-intent/effect.ts", [
    [
      'export type EffectSource = "syntax" | "core" | "retracted" | "unproven";',
      'export type EffectSource = "syntax" | "core" | "retracted" | "unproven" | "managed-literal";',
    ],
  ]);
  patch("src/access-intent/bash/token-collection.ts", [
    [
      'import { proveCommandEffect } from "./command-effects";',
      'import { proveCommandEffect } from "./command-effects";\nimport { managedInspectionEffect } from "./managed-read-policy";',
    ],
    [
      "const effect = proveCommandEffect(",
      "const effect = managedInspectionEffect(node.text) ?? proveCommandEffect(",
    ],
  ]);
  patch("src/access-intent/bash/command-enumeration.ts", [
    [
      'import type { BashCommandContext, FloorExemption } from "#src/types";',
      'import type { BashCommandContext, FloorExemption } from "#src/types";\nimport type { ManagedGitDiagnostic } from "./managed-read-policy";',
    ],
    [
      "export interface BashCommand {",
      "export interface BashCommand {\n  /** Private original-source binding; original policy still applies. */\n  readonly managedOriginal?: string;\n  /** Eligible managed inspection/query scope, not physical zero-IO. */\n  readonly managedReadOnly?: true;\n  /** Literal inner spelling; restrictive checks also apply when auto scope is unavailable. */\n  readonly managedGitInner?: string;\n  /** Raw original inner spelling; never reconstructed from decoded words. */\n  readonly managedGitOriginalInner?: string;\n  /** Proof failure is presentation only, not a permission decision. */\n  readonly managedGitDiagnostic?: ManagedGitDiagnostic;\n  /** Exact mkdir/cp effects came from private mutable-input provenance. */\n  readonly managedStaticFileEffects?: true;",
    ],
  ]);
  patch("src/access-intent/bash/program.ts", [
    [
      'import { getParser } from "./parser";',
      'import { getParser } from "./parser";\nimport { managedGitInnerCommand, managedGitSyntaxDiagnostic, managedProgramAnalysis, managedStaticFileProof, type ManagedStaticFileScope } from "./managed-read-policy";',
    ],
    [
      "options?: { workdir?: string },",
      "options?: { workdir?: string; originalCommands?: string[]; newScope?: ManagedStaticFileScope },",
    ],
    [
      "      return new BashProgram(\n        command,\n        collectCommands(tree.rootNode),\n        externalAccesses,\n        ruleCandidates,\n      );",
      `      const commands = collectCommands(tree.rootNode);
      const fileCandidate = managedStaticFileProof(options?.newScope, command, normalizer);
      const analysis = fileCandidate ? undefined : managedProgramAnalysis(tree.rootNode, normalizer, options?.workdir);
      const readCandidate = analysis?.proof;
      // Wrapper eligibility is independent of the non-Git program effect proof.
      const readProof = readCandidate?.marked.length === commands.length &&
        commands.every(cmd => !cmd.wrapperKind && !cmd.parseUnresolved && !cmd.context) ? readCandidate : undefined;
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
          ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),
          ...(fileProof?.marked[index] ? { managedStaticFileEffects: true as const } :
            proof?.marked[index] ? { managedReadOnly: true as const } : {}),
          };
        }),
        fileProof ? fileProof.externalAccesses :
          proof ? [...externalAccesses.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.externalAccesses] : externalAccesses,
        fileProof ? fileProof.ruleCandidates :
          proof ? [...ruleCandidates.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.ruleCandidates] : ruleCandidates,
      );`,
    ],
  ]);
  patch("src/handlers/gates/tool-call-gate-pipeline.ts", [
    [
      'import { BashProgram } from "#src/access-intent/bash/program";',
      'import { BashProgram } from "#src/access-intent/bash/program";\nimport { managedStaticFileScope, originalGitCommands } from "#src/access-intent/bash/managed-read-policy";',
    ],
    [
      "workdir: shell.workdir,",
      "workdir: shell.workdir,\n          originalCommands: originalGitCommands(tcc.input),\n          newScope: managedStaticFileScope(tcc.input),",
    ],
    [
      'import { resolveBashCommandCheck } from "./bash-command";',
      'import { resolveBashCommandCheck } from "./bash-command";\nimport { managedGitDiagnosticEvidence } from "#src/presentation/agent-renderer";',
    ],
    [
      "        toolDescriptor.preCheck = toolCheck;",
      `        // The winning spelling may be the normalized unit or its original.
        // Do not attribute an unrelated unit's failure to a command-specific deny.
        const diagnostic = bashProgram?.commands().find(cmd =>
          cmd.text === toolCheck.command || cmd.managedOriginal === toolCheck.command)?.managedGitDiagnostic;
        if (diagnostic) {
          toolDescriptor.payload = { ...toolDescriptor.payload,
            evidence: [...toolDescriptor.payload.evidence, ...managedGitDiagnosticEvidence(diagnostic)] };
          toolDescriptor.logContext.managedGitDiagnostic = diagnostic;
        }
        toolDescriptor.preCheck = toolCheck;`,
    ],
  ]);
  patch("src/handlers/gates/bash-command.ts", [
    [
      'import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";',
      'import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";\nimport { managedGitInnerCommand } from "#src/access-intent/bash/managed-read-policy";',
    ],
    [
      "  const base = resolveOnBashSurface(cmd.text, agentName, resolver);",
      `  const configured = resolveOnBashSurface(cmd.text, agentName, resolver);
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
  }`,
    ],
    [
      '  const floored =\n    cmd.wrapperKind && base.state === "allow"',
      `  // Resolve BOTH spellings, even when the wrapper itself asks or denies.
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
    : cmd.wrapperKind && base.state === "allow"`,
    ],
  ]);
  // Missing proof is presentation, never an authorizer or session grant.
  patch("src/handlers/gates/bash-path.ts", [
    [
      'import { buildPathAskPayload } from "#src/presentation/path-ask-payload";',
      'import { buildPathAskPayload } from "#src/presentation/path-ask-payload";\nimport { managedGitDiagnosticEvidence } from "#src/presentation/agent-renderer";',
    ],
    [
      "  const pattern = normalizer.approvalPatternFor(worstEntry.path);",
      `  // One failed unit withholds the complete program proof. This diagnostic
  // describes that loss, not the identity or authority of the deciding path.
  // Prefer the failed unit's own reason over its siblings' program-scope note.
  const diagnostics = worstEntry.effect.effect === "unproven"
    ? bashProgram.commands().flatMap(cmd => cmd.managedGitDiagnostic ? [cmd.managedGitDiagnostic] : []) : [];
  const diagnostic = diagnostics.find(item => item.code !== "git-program-scope") ?? diagnostics[0];
  const pattern = normalizer.approvalPatternFor(worstEntry.path);`,
    ],
    [
      "    payload,\n    sessionApproval:",
      "    payload: { ...payload, evidence: [...payload.evidence, ...managedGitDiagnosticEvidence(diagnostic)] },\n    sessionApproval:",
    ],
    [
      "      effectSource: worstEntry.effect.source,",
      "      effectSource: worstEntry.effect.source,\n      ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),",
    ],
  ]);
}
