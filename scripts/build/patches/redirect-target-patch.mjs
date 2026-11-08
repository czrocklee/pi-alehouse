// Literal file-redirect targets enter both path projections by syntax: no
// generic argument-shape filter and no existence probe decides whether they are
// paths. Effects stay as the operator proved them (`<>` and unresolved parses
// remain unproven); descriptor duplications, here-strings, heredocs and
// non-literal targets keep upstream handling. A number names a descriptor only
// after `>&` / `<&`: `>123` opens a file called 123.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

function edit(root, file, edits) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length, 2, `Patch drift: ${file}: ${before}`);
    text = text.replace(before, after);
  }
  writeFileSync(path, text);
}

export function applyRedirectTargetPatch(root) {
  copyFileSync(
    join(packageRoot, "src/authority/managed-redirect-target.ts"),
    join(root, "src/access-intent/bash/managed-redirect-target.ts"),
  );
  copyFileSync(
    join(packageRoot, "src/authority/managed-literal-path.ts"),
    join(root, "src/access-intent/managed-literal-path.ts"),
  );
  edit(root, "src/access-intent/access-path.ts", [
    [
      'import type { PathFlavor } from "#src/path/path-flavor";',
      'import type { PathFlavor } from "#src/path/path-flavor";\nimport { filesystemLiteralForms } from "./managed-literal-path";',
    ],
    [
      "  /**\n   * Build a literal-only `AccessPath`",
      `  /** A decoded shell filename: no tool-input cleanup or home expansion. */
  static forFilesystemLiteral(
    literal: string,
    options: { cwd: string; resolveBase?: string; flavor: PathFlavor },
  ): AccessPath {
    const { lexical, aliases, canonical } = filesystemLiteralForms(literal, options);
    return new AccessPath(lexical, aliases, canonical);
  }

  /**
   * Build a literal-only \`AccessPath\``,
    ],
  ]);
  edit(root, "src/path/path-normalizer.ts", [
    [
      "  /**\n   * The session-approval glob for an accessed path:",
      `  /** Preserve decoded filesystem bytes while retaining Git Bash path shapes. */
  forBashLiteral(token: string, options?: { resolveBase?: string }): AccessPath {
    const shape = this.flavor.bashTokenShape(token);
    switch (shape.kind) {
      case "device":
        return AccessPath.forDevice(token);
      case "posix-absolute":
        return this.forLiteral(token);
      case "drive-mount":
      case "plain":
        return AccessPath.forFilesystemLiteral(
          shape.kind === "drive-mount" ? shape.windowsPath : token,
          { cwd: this.cwd, resolveBase: options?.resolveBase, flavor: this.flavor },
        );
    }
  }

  /**
   * The session-approval glob for an accessed path:`,
    ],
  ]);
  // Recover only the grammar's discarded <> operator, so the real first word
  // remains the destination and subsequent argv reaches the command's roles.
  // The unresolved-command/effect floors are deliberately unchanged.
  edit(root, "src/access-intent/bash/managed-redirect-argv.ts", [
    [
      'import type { TSNode } from "./parser";',
      'import type { TSNode } from "./parser";\nimport { recoveredReadWriteRedirect, recoveredReadWriteOperator, redirectArgumentNode } from "./managed-redirect-target";',
    ],
    [
      "    const child = redirect.child(i)!;\n    if (!child.isNamed) {",
      "    const child = redirect.child(i)!;\n    if (recoveredReadWriteOperator(redirect, child)) continue;\n    if (!child.isNamed) {",
    ],
    [
      '      if (child.startIndex >= redirect.startIndex) break;\n      if (child.isNamed && child.type !== "comment"',
      `      if (child.startIndex >= redirect.startIndex) break;
      if (recoveredReadWriteRedirect(redirect) && child.type === "ERROR" &&
          child.text === "<" && child.endIndex === redirect.startIndex) continue;
      if (child.isNamed && child.type !== "comment"`,
    ],
    ["  children.push(...tails);", "  children.push(...tails.map(redirectArgumentNode));"],
  ]);
  edit(root, "src/access-intent/bash/token-collection.ts", [
    [
      'import { redirectEffectForDestination } from "./redirect-analysis";',
      'import { redirectEffectForDestination } from "./redirect-analysis";\nimport { literalRedirectTarget, redirectNumberNamesFile } from "./managed-redirect-target";',
    ],
    [
      "  readonly token: string;\n  readonly effect: TokenEffect;\n}",
      `  readonly token: string;
  readonly effect: TokenEffect;
  /** A literal file-redirect target: a filename by syntax, never by shape. */
  readonly fromRedirect?: true;
}`,
    ],
    [
      `    if (ARG_NODE_TYPES.has(child.type) && !owned?.has(child.startIndex)) {
      const effect = redirectEffectForDestination(node, child);
      if (effect) tokens.push({ token: resolveNodeText(child), effect });
    }`,
      `    const target = ARG_NODE_TYPES.has(child.type) || redirectNumberNamesFile(node, child);
    if (target && !owned?.has(child.startIndex)) {
      const effect = redirectEffectForDestination(node, child);
      const literal = effect ? literalRedirectTarget(node, child) : undefined;
      if (effect)
        tokens.push(literal === undefined
          ? { token: resolveNodeText(child), effect }
          : { token: literal, effect, fromRedirect: true });
    }`,
    ],
  ]);
  // A number is a descriptor only after a duplicating operator; elsewhere it is
  // a filename, which the wrapper-floor write check must also count.
  edit(root, "src/access-intent/bash/redirect-analysis.ts", [
    [
      'import { parseUnresolvedAt, type TSNode } from "./parser";',
      'import { parseUnresolvedAt, type TSNode } from "./parser";\nimport { redirectNumberNamesFile } from "./managed-redirect-target";',
    ],
    [
      "    DESCRIPTOR_NODE_TYPES.has(destination.type),",
      "    DESCRIPTOR_NODE_TYPES.has(destination.type) && !redirectNumberNamesFile(redirect, destination),",
    ],
    [
      "    if (DESCRIPTOR_NODE_TYPES.has(child.type)) continue;",
      "    if (DESCRIPTOR_NODE_TYPES.has(child.type) && !redirectNumberNamesFile(redirect, child)) continue;",
    ],
  ]);
  edit(root, "src/access-intent/bash/bash-path-resolver.ts", [
    [
      "  readonly base: EffectiveBase;\n  readonly effect: TokenEffect;\n}",
      `  readonly base: EffectiveBase;
  readonly effect: TokenEffect;
  readonly fromRedirect?: true;
}`,
    ],
    [
      "  for (const { token, effect } of tokens) out.push({ token, base, effect });",
      `  for (const { token, effect, fromRedirect } of tokens)
    out.push({ token, base, effect, ...(fromRedirect ? { fromRedirect } : {}) });`,
    ],
    [
      `    for (const { token, base, effect } of candidates) {
      const candidate = classifyTokenAsPathCandidate(token);`,
      `    for (const { token, base, effect, fromRedirect } of candidates) {
      // Decoded redirect filenames bypass all tool-input spelling cleanup in
      // BOTH projections. Unknown relative bases stay literal-only/external.
      if (fromRedirect) {
        this.collectIfExternal(
          this.buildRedirectCandidatePath(token, base), effect, seen, externalPaths,
        );
        continue;
      }
      const candidate = classifyTokenAsPathCandidate(token);`,
    ],
    [
      `    for (const { token, base, effect } of candidates) {
      const shaped = classifyTokenAsRuleCandidate(
        token,
        this.normalizer.flavor,
      );`,
      `    for (const { token, base, effect, fromRedirect } of candidates) {
      const shaped = fromRedirect ? token : classifyTokenAsRuleCandidate(
        token,
        this.normalizer.flavor,
      );`,
    ],
    [
      "          : { token: shaped, path: this.buildRuleCandidatePath(shaped, base) };",
      `          : { token: shaped, path: fromRedirect
              ? this.buildRedirectCandidatePath(shaped, base)
              : this.buildRuleCandidatePath(shaped, base) };`,
    ],
    [
      "  private buildRuleCandidatePath(",
      `  private buildRedirectCandidatePath(candidate: string, base: EffectiveBase): AccessPath {
    // A quoted/escaped ~ or $HOME is relative data, never a home expansion.
    if (base.kind === "unknown" && !this.normalizer.isAbsolute(candidate)) {
      return this.normalizer.forLiteral(candidate);
    }
    const resolveBase = base.kind === "known"
      ? this.normalizer.resolveBase(base.offset) : undefined;
    return this.normalizer.forBashLiteral(candidate, { resolveBase });
  }

  private buildRuleCandidatePath(`,
    ],
  ]);
}
