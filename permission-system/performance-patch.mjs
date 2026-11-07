// Apply after the managed authority patches, before any import normalization.
// Only the private pinned copy is changed. Reapplication is byte-idempotent;
// every unpatched anchor must occur exactly once, so upstream drift fails build.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyForwardingPerformancePatch } from "./forwarding-performance-patch.mjs";

export function applyPermissionPerformancePatch(root) {
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "32.0.3");
  function patch(file, edits) {
    const path = join(root, file);
    let text = readFileSync(path, "utf8");
    for (const [before, after] of edits) {
      if (text.includes(after)) {
        assert.equal(text.split(after).length, 2, `Performance patch duplicate: ${file}`);
        continue;
      }
      assert.equal(text.split(before).length, 2, `Performance patch drift: ${file}: ${before}`);
      text = text.replace(before, after);
    }
    writeFileSync(path, text);
  }
  copyFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "managed-permission-snapshot.ts"),
    join(root, "src/policy/managed-permission-snapshot.ts"),
  );
  patch("src/policy/wildcard-matcher.ts", [
    [
      "function escapeRegExp(value: string): string {",
      `// Cache only regexes, never pattern/state wrappers or permission decisions.
// Expansion precedes the key: changing HOME must change a home-pattern match.
const MAX_WILDCARD_REGEXES = 4096;
const MAX_CACHED_PATTERN_CHARS = 8192;
const wildcardRegexes = new Map<string, RegExp>();

function escapeRegExp(value: string): string {`,
    ],
    [
      [
        "  const expanded = foldSeparators(expandHomePath(pattern), options);",
        "  let escaped = expanded",
        '    .split("*")',
        String.raw`    .map((part) => escapeRegExp(part).replaceAll("\\?", "."))`,
        '    .join(".*");',
        "",
        '  // If the pattern ends with " *" (space + wildcard), make the trailing',
        '  // space-and-arguments portion optional so that e.g. "git *" matches both',
        '  // "git status" and bare "git". Mirrors OpenCode wildcard semantics.',
        '  if (escaped.endsWith(" .*")) {',
        "    escaped = `${escaped.slice(0, -3)}( .*)?`;",
        "  }",
        "",
        "  const regex = new RegExp(",
        "    `^${escaped}$`,",
        '    options?.caseInsensitive ? "si" : "s",',
        "  );",
      ].join("\n"),
      String.raw`  const expanded = foldSeparators(expandHomePath(pattern), options);
  const flags = options?.caseInsensitive ? "si" : "s";
  // Separator mode also belongs to the key; value folding stays in each fresh
  // wrapper below, including callers that retain their own pattern/state.
  const key = JSON.stringify([expanded, flags, options?.windowsSeparators === true]);
  let compiled = wildcardRegexes.get(key);
  if (!compiled) {
    let escaped = expanded
      .split("*")
      .map((part) => escapeRegExp(part).replaceAll("\\?", "."))
      .join(".*");
    if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
    compiled = new RegExp("^" + escaped + "$", flags);
    if (expanded.length <= MAX_CACHED_PATTERN_CHARS) {
      if (wildcardRegexes.size >= MAX_WILDCARD_REGEXES) wildcardRegexes.clear();
      wildcardRegexes.set(key, compiled);
    }
  }
  const regex = compiled;`,
    ],
  ]);
  patch("src/config/policy-loader.ts", [
    [
      'import { existsSync, readFileSync, statSync } from "node:fs";',
      'import { existsSync, readFileSync, statSync } from "node:fs";\nimport { synchronousPermissionSample } from "#src/policy/managed-permission-snapshot";',
    ],
    [
      `function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}`,
      `function getFileStamp(path: string): string {
  return synchronousPermissionSample("policy-stamp", path, () => {
    try {
      return String(statSync(path).mtimeMs);
    } catch {
      return "missing";
    }
  });
}`,
    ],
  ]);
  patch("src/path/canonicalize-path.ts", [
    [
      'import { realpathSync } from "node:fs";',
      'import { realpathSync } from "node:fs";\nimport { synchronousPermissionSample } from "#src/policy/managed-permission-snapshot";',
    ],
    [
      `export function canonicalizePath(
  absolutePath: string,
  flavor: PathFlavor,
): string {
  if (!absolutePath) return absolutePath;`,
      `export function canonicalizePath(
  absolutePath: string,
  flavor: PathFlavor,
): string {
  return synchronousPermissionSample(flavor, absolutePath, () => canonicalizePathUncached(absolutePath, flavor));
}

function canonicalizePathUncached(absolutePath: string, flavor: PathFlavor): string {
  if (!absolutePath) return absolutePath;`,
    ],
  ]);
  patch("src/handlers/gates/tool-call-gate-pipeline.ts", [
    [
      'import { BashProgram } from "#src/access-intent/bash/program";',
      'import { BashProgram } from "#src/access-intent/bash/program";\nimport { withSynchronousPermissionSnapshot } from "#src/policy/managed-permission-snapshot";',
    ],
    [
      "      gates.push(await produce());",
      `      // Drop all samples before awaiting a producer or entering GateRunner.
      // Authorizers and post-approval revalidation always sample freshly.
      gates.push(await withSynchronousPermissionSnapshot(produce));`,
    ],
  ]);
  patch("src/access-intent/bash/program.ts", [
    [
      'import { getParser } from "./parser";',
      'import { getParser } from "./parser";\nimport { withSynchronousPermissionSnapshot } from "#src/policy/managed-permission-snapshot";',
    ],
    [
      "    try {\n      const nativeGit = analyzeGitCommands",
      "    try {\n      return withSynchronousPermissionSnapshot(() => {\n      const nativeGit = analyzeGitCommands",
    ],
    ["    } finally {\n      tree.delete();", "      });\n    } finally {\n      tree.delete();"],
  ]);
  patch("src/policy/permission-manager.ts", [
    [
      `    const { composedRules } = this.resolvePermissions(agentName);
    return [...composedRules.filter((r) => r.layer === "config"), ...this.resolvePermissions(agentName).agentWriteFloor];`,
      `    const { composedRules, agentWriteFloor } = this.resolvePermissions(agentName);
    return [...composedRules.filter((r) => r.layer === "config"), ...agentWriteFloor];`,
    ],
    [
      `    const { composedRules } = this.resolvePermissions(agentName);
    // Every surface`,
      `    const { composedRules, agentWriteFloor } = this.resolvePermissions(agentName);
    // Every surface`,
    ],
    [
      'if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return "deny";',
      'if (toolName.trim() === "path_write" && agentWriteFloor.length) return "deny";',
    ],
    [
      `    const { composedRules } = this.resolvePermissions(agentName);
    if (toolName.trim() === "path_write" && this.resolvePermissions(agentName).agentWriteFloor.length) return true;`,
      `    const { composedRules, agentWriteFloor } = this.resolvePermissions(agentName);
    if (toolName.trim() === "path_write" && agentWriteFloor.length) return true;`,
    ],
  ]);
  applyForwardingPerformancePatch(root, patch);
}
