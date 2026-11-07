// Redirect-buried argv belongs to the command that receives it. Its tokens take
// that command's roles and effect over the completed argv, and its completed
// spelling can restrict the unit's command rules but never allow it.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function applyRedirectArgvPatch(root, patch) {
  copyFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "managed-redirect-argv.ts"),
    join(root, "src/access-intent/bash/managed-redirect-argv.ts"),
  );
  patch("src/access-intent/bash/token-collection.ts", [
    [
      'import { managedInspectionEffect } from "./managed-read-policy";',
      'import { managedInspectionEffect } from "./managed-read-policy";\nimport { completedCommandView, redirectTail, redirectTailOwner } from "./managed-redirect-argv";',
    ],
    [
      "export function collectCommandTokens(node: TSNode): PathToken[] {\n  const effect =",
      `export function collectCommandTokens(node: TSNode): PathToken[] {
  // Argv a later redirect buried is this command's, with this command's roles.
  const completed = completedCommandView(node);
  if (completed) return collectCommandTokens(completed);
  const effect =`,
    ],
    [
      `export function collectRedirectTokens(node: TSNode): PathToken[] {
  const tokens: PathToken[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (ARG_NODE_TYPES.has(child.type)) {`,
      `export function collectRedirectTokens(node: TSNode): PathToken[] {
  const tokens: PathToken[] = [];
  // An owned tail is collected as its command's argv, not as a destination.
  const owned = redirectTailOwner(node) ? new Set(redirectTail(node).map(tail => tail.startIndex)) : undefined;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (ARG_NODE_TYPES.has(child.type) && !owned?.has(child.startIndex)) {`,
    ],
  ]);
  patch("src/access-intent/bash/command-enumeration.ts", [
    [
      'import { redirectMayWriteFile } from "./redirect-analysis";',
      'import { redirectMayWriteFile } from "./redirect-analysis";\nimport { ownedRedirectTails } from "./managed-redirect-argv";',
    ],
    [
      "  readonly managedGitCompleted?: readonly string[];",
      "  readonly managedGitCompleted?: readonly string[];\n  /** The unit with redirect-buried argv restored: deny/ask checks only, never an allow source. */\n  readonly managedRedirectCompleted?: BashCommand;",
    ],
    [
      "  sourceBindings.set(unit, { start: node.startIndex, text: node.text });\n  return unit;",
      `  // Bash runs argv a later redirect buried. The completed unit is classified
  // afresh and never inherits the truncated unit's floor exemption.
  const tails = ownedRedirectTails(node);
  let completedText = text;
  const completedWords = [...words];
  for (const tail of tails) {
    completedText += " ";
    completedWords.push({ text: tail.text, offset: completedText.length });
    completedText += tail.text;
  }
  const bound = tails.length ? { ...unit, managedRedirectCompleted: makeUnit(completedText, scope, {
    wrapperKind: classifyWrapperWords(completedWords),
    executedUnit: executedUnitOf(completedText, completedWords) ?? undefined,
  }) } : unit;
  sourceBindings.set(bound, { start: node.startIndex, text: node.text });
  return bound;`,
    ],
  ]);
  patch("src/handlers/gates/bash-command.ts", [
    [
      "  const unparsed = floorUnparsedUnit(cmd, command, floored);",
      `  // The completed unit can restore any ask or deny, including the catch-all,
  // but a truncated exact ALLOW cannot cover the argv it never saw. Prefer
  // completed facts on ties so prompts and session grants name the real argv.
  const completed = cmd.managedRedirectCompleted
    ? resolveCommandUnit(cmd.managedRedirectCompleted, command, agentName, resolver) : undefined;
  const unparsed = floorUnparsedUnit(cmd, command, completed && completed.state !== "allow"
    ? pickMostRestrictive([completed, floored]) ?? floored : floored);`,
    ],
  ]);
}
