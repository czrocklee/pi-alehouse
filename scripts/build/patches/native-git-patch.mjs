// Literal Git restriction/effect integration. No execution input is rewritten.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";
import { applyNativeGitRestrictions } from "./native-git-restrictions-patch.mjs";

export function applyNativeGitPatch(root, patch) {
  copyFileSync(
    join(packageRoot, "src/authority/managed-git-query.ts"),
    join(root, "src/access-intent/bash/managed-git-query.ts"),
  );
  patch("src/access-intent/bash/command-enumeration.ts", [
    [
      "export interface BashCommand {",
      `// Private source binding; keep enumerable public command shapes unchanged.
const sourceBindings = new WeakMap<object, { start: number; text: string }>();
export function managedCommandStart(command: BashCommand): number | undefined { return sourceBindings.get(command)?.start; }
export function managedCommandSource(command: BashCommand): string | undefined { return sourceBindings.get(command)?.text; }

export interface BashCommand {
  /** Source-bound native Git unit; restrictions apply even without auto eligibility. */
  readonly managedGitRequest?: true;
  /** Completed argv spellings are deny/ask checks only, never allow sources. */
  readonly managedGitRestrictions?: readonly string[];
  readonly managedGitCompleted?: readonly string[];`,
    ],
    [
      `  return makeUnit(text, scope, {
    wrapperKind: classifyWrapperWords(words),
    executedUnit: executedUnitOf(text, words) ?? undefined,
    floorExemption: isTransparentWrapper(words, scope)
      ? "core-reader"
      : undefined,
  });`,
      `  const unit = makeUnit(text, scope, {
    wrapperKind: classifyWrapperWords(words),
    executedUnit: executedUnitOf(text, words) ?? undefined,
    floorExemption: isTransparentWrapper(words, scope)
      ? "core-reader"
      : undefined,
  });
  sourceBindings.set(unit, { start: node.startIndex, text: node.text });
  return unit;`,
    ],
  ]);
  patch("src/access-intent/bash/token-collection.ts", [
    [
      'import { managedInspectionEffect } from "./managed-read-policy";',
      'import { managedInspectionEffect } from "./managed-read-policy";\nimport { gitQueryEffect } from "./managed-git-query";',
    ],
    // Only recognized literal argv get a read effect, never unknowns/writes.
    [
      "const effect = managedInspectionEffect(node.text) ?? proveCommandEffect(",
      "const effect = managedInspectionEffect(node.text) ?? gitQueryEffect(node.text) ?? proveCommandEffect(",
    ],
  ]);
  patch("src/access-intent/bash/program.ts", [
    [
      "import { managedGitInnerCommand,",
      "import { gitLiteralWords, literalWords as fallbackLiteralWords, managedGitInnerCommand,",
    ],
    [
      "      const commands = collectCommands(tree.rootNode);",
      `      const commands = collectCommands(tree.rootNode);
      // Even an unsupported Git unit must not inherit a whole-array read label.
      const isGitCommand = (text: string): boolean => {
        const words = gitLiteralWords(text) ?? fallbackLiteralWords(text);
        return words?.[0] === "git" || (words?.[0] === "env" && words[1] === "git");
      };
      const preserveEffects = nativeGit.units.size > 0 || commands.some(cmd => isGitCommand(cmd.text));`,
    ],
    [
      "import { type BashCommand, collectCommands }",
      'import { analyzeGitCommands } from "./managed-git-query";\nimport { type BashCommand, managedCommandStart, managedCommandSource, collectCommands }',
    ],
    [
      "      const { externalAccesses, ruleCandidates } = new BashPathResolver(",
      "      const nativeGit = analyzeGitCommands(tree.rootNode, normalizer, options?.workdir);\n      const { externalAccesses, ruleCandidates } = new BashPathResolver(",
    ],
    // Preserve native source-bound units in mixed-program effect analysis.
    // Automatic eligibility still comes ONLY from queryAuto below, never from
    // a program mark or a wrapper fallback (Git marks are always false).
    [
      "        commands.every(cmd => !cmd.wrapperKind && !cmd.parseUnresolved && !cmd.context) ? readCandidate : undefined;",
      `        commands.every(cmd => !cmd.parseUnresolved && !cmd.context &&
          (!cmd.wrapperKind || (cmd.wrapperKind === "indirection" &&
            nativeGit.units.has(managedCommandStart(cmd) ?? -1)))) ? readCandidate : undefined;`,
    ],
    [
      `          const diagnostic = diagnostics?.[index] ?? (proof ? undefined : managedGitSyntaxDiagnostic(cmd.text));`,
      `          const originalSource = managedCommandSource(cmd);
          const boundQuery = nativeGit.units.get(managedCommandStart(cmd) ?? -1);
          // Context/parsing can withhold automatic eligibility, never literal
          // restrictions. Keep both exact source text and start binding.
          const query = boundQuery?.text === originalSource ? boundQuery : undefined;
          const queryAuto = !cmd.context && !cmd.parseUnresolved && query?.auto;
          const nativeRequest = query !== undefined || isGitCommand(cmd.text);
          const diagnostic = query ? query.diagnostic : diagnostics?.[index] ?? (proof ? undefined : managedGitSyntaxDiagnostic(cmd.text));`,
    ],
    [
      "          return { ...cmd,",
      "          return { ...cmd,\n          ...(nativeRequest ? { managedGitRequest: true as const } : {}),\n          ...(query?.restrictions ? { managedGitRestrictions: query.restrictions } : {}),\n          ...(query?.completed ? { managedGitCompleted: query.completed } : {}),",
    ],
    [
      "          ...(originals ? { managedOriginal: originals[index] } : {}),",
      "          ...(originals ? { managedOriginal: originals[index] } :\n            nativeRequest && originalSource !== undefined && originalSource !== cmd.text ? { managedOriginal: originalSource } : {}),",
    ],
    [
      "          ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),",
      `          ...(nativeRequest && managedGitInnerCommand(cmd.text) !== undefined && cmd.wrapperKind === "indirection" ? {
            managedGitInner: managedGitInnerCommand(cmd.text),
            ...(originals ? { managedGitOriginalInner: managedGitInnerCommand(originals[index]!) } : {}),
          } : {}),
          ...(diagnostic ? { managedGitDiagnostic: diagnostic } : {}),`,
    ],
    [
      `          ...(fileProof?.marked[index] ? { managedStaticFileEffects: true as const } :
            proof?.marked[index] ? { managedReadOnly: true as const } : {}),`,
      `          ...(fileProof?.marked[index] ? { managedStaticFileEffects: true as const } :
            (query ? queryAuto : proof?.marked[index]) ? { managedReadOnly: true as const } : {}),`,
    ],
    [
      `        fileProof ? fileProof.externalAccesses :
          proof ? [...externalAccesses.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.externalAccesses] : externalAccesses,`,
      `        [...(fileProof ? fileProof.externalAccesses :
          proof && !preserveEffects ? [...externalAccesses.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.externalAccesses] : [...externalAccesses, ...(proof?.externalAccesses ?? [])]),
          ...nativeGit.externalAccesses],`,
    ],
    [
      `        fileProof ? fileProof.ruleCandidates :
          proof ? [...ruleCandidates.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.ruleCandidates] : ruleCandidates,`,
      `        [...(fileProof ? fileProof.ruleCandidates :
          proof && !preserveEffects ? [...ruleCandidates.map(item => ({ ...item, effect: { effect: "read" as const, source: "managed-literal" as const } })), ...proof.ruleCandidates] : [...ruleCandidates, ...(proof?.ruleCandidates ?? [])]),
          ...nativeGit.ruleCandidates],`,
    ],
  ]);
  applyNativeGitRestrictions(root, patch);
  patch("src/presentation/agent-renderer.ts", [
    [
      " Complete managed Git read-only proof unavailable",
      " Native Git query classification unavailable",
    ],
    [
      ". Missing proof does not override the deciding gate; env does not override denies or guarantee approval.",
      ". Classification does not override the deciding gate; bare and env Git retain the same restrictions.",
    ],
  ]);
}
