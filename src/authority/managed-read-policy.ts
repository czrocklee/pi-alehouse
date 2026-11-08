// Local, version-pinned extension of the existing pipeline, not an authorizer.
// Non-Git inspection and static-file hardening retain one private input store;
// native Git inventory/eligibility never comes from this program-wide proof.
import { lstatSync } from "node:fs";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { TokenEffect } from "#src/access-intent/effect";
import type { BashPathRuleCandidate, BashExternalPath } from "./bash-path-resolver";
import type { TSNode } from "./parser";
import { proveCommandEffect } from "./command-effects";
import {
  gitLiteralWords,
  literalProgram,
  managedInspection,
  managedInspectionEffect,
  printingSed,
  resourceMetadata,
  type LiteralUnit,
} from "./managed-inspection";

// Keep the existing entry identity for generation, managed scratch and callers.
// Re-export the same functions, never duplicate the private provenance store.
export {
  captureRequestedBashCommand,
  gitLiteralWords,
  hardenNonGitInput,
  literalProgram,
  literalWords,
  managedInspectionEffect,
  managedStaticFileScope,
  originalGitCommands,
  requestedBashCommand,
  type ManagedStaticFileScope,
} from "./managed-inspection";
export {
  hardenStaticFileInput,
  managedStaticFileProof,
  type ManagedScratchRoot,
} from "./managed-static-files";

const READ: TokenEffect = { effect: "read", source: "managed-literal" };

export function managedGitInnerCommand(source: string): string | undefined {
  const words = gitLiteralWords(source);
  if (words?.[0] === "env") return source.replace(/^env[ \t]+/, "");
}

export type ManagedGitDiagnostic = { code: string; reason: string; token?: string };
type ScopeProof = { ruleCandidates: BashPathRuleCandidate[]; externalAccesses: BashExternalPath[] };

// Presentation only. Recognizing a Git-looking unit must never admit it.
export function managedGitSyntaxDiagnostic(source: string): ManagedGitDiagnostic | undefined {
  if (/^(?:env[ \t]+)?git(?:[ \t]|$)/.test(source))
    return {
      code: "git-program-syntax",
      reason:
        "This shell structure, assignment or expansion is outside literal Git query classification.",
    };
}

type ManagedProgramProof = ScopeProof & { marked: boolean[] };
export function managedProgramAnalysis(
  root: TSNode,
  normalizer: PathNormalizer,
  workdir?: string,
): {
  proof?: ManagedProgramProof;
  diagnostics: (ManagedGitDiagnostic | undefined)[];
} {
  const units = literalProgram(root);
  if (!units) return { diagnostics: [] };
  const diagnostics: (ManagedGitDiagnostic | undefined)[] = units.map(() => undefined);
  const isGit = (unit: LiteralUnit) =>
    unit.words[0] === "git" || (unit.words[0] === "env" && unit.words.includes("git"));
  const incomplete = (reason: string, token?: string) => {
    units.forEach((unit, index) => {
      if (isGit(unit) && !diagnostics[index])
        diagnostics[index] = {
          code: "git-program-scope",
          reason,
          ...(token === undefined ? {} : { token }),
        };
    });
    return { diagnostics };
  };
  let cwd = normalizer.resolveBase(workdir ?? "");
  const cd = units.filter((unit) => unit.words[0] === "cd");
  if (cd.length) {
    // Do not guess cwd after failed cd, pipes containing cd, multiple cd, ';',
    // or '||'. This non-Git lane must establish its literal base.
    const uncertain = () =>
      incomplete("The shell program does not establish one deterministic Git working directory.");
    if (cd.length !== 1 || cd[0] !== units[0] || cd[0].words.length !== 2 || units.length < 2)
      return uncertain();
    const rest = root.text.slice(cd[0].end - root.startIndex);
    if (!/^\s*&&/.test(rest) || /;|\|\||\n/.test(rest)) return uncertain();
    if (
      cd[0].words[1] !== cd[0].words[1].trim() ||
      !/^(?:\/|\.\.?\/|\.{1,2}$)/.test(cd[0].words[1])
    )
      return uncertain();
    cwd = normalizer.forPath(cd[0].words[1], { resolveBase: cwd }).boundaryValue();
  }
  const ruleCandidates: BashPathRuleCandidate[] = [],
    externalAccesses: BashExternalPath[] = [],
    marked: boolean[] = [];
  // The first unit without proof is named in its siblings' diagnostics.
  let unproven: LiteralUnit | undefined;
  for (const unit of units) {
    if (unit === cd[0]) {
      marked.push(false);
      continue;
    }
    // Git has its own literal inventory and ordinary permission. Presence is
    // not a non-Git failure, but never grants this lane's read allowance.
    if (isGit(unit)) {
      marked.push(false);
      continue;
    }
    const inspection = managedInspection(unit.words);
    if (inspection) {
      for (const token of inspection.files) {
        const path = normalizer.forPath(token, { resolveBase: cwd });
        try {
          if (!lstatSync(path.boundaryValue()).isFile()) unproven ??= unit;
        } catch {
          /* A missing literal file cannot become a recursive scan. */
        }
        const candidate = { token, path, effect: READ };
        ruleCandidates.push(candidate);
        if (normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue()))
          externalAccesses.push({ path, effect: READ });
      }
      marked.push(true);
      continue;
    }
    const read =
      managedInspectionEffect(unit.text) ?? proveCommandEffect(unit.words[0], unit.words.slice(1));
    if (
      read.effect !== "read" &&
      !["true", "false", "uname", "whoami", "id"].includes(unit.words[0])
    )
      unproven ??= unit;
    // Effect attribution is not a tool allowance for recursive readers.
    marked.push(printingSed(unit.words) || resourceMetadata(unit.words));
  }
  if (unproven)
    return incomplete(
      "Another command in the shell program lacks a complete read-only proof.",
      unproven.text,
    );
  return { proof: { ruleCandidates, externalAccesses, marked }, diagnostics };
}
