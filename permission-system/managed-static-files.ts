// Bounded scratch mkdir/cp hardening. Provenance supplies exact effects only;
// every access still passes the authority's ordinary directional path gates.
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { TokenEffect } from "#src/access-intent/effect";
import type { BashPathRuleCandidate, BashExternalPath } from "./bash-path-resolver";
import { getParser } from "./parser";
import {
  clearManagedStaticFileScope,
  literalProgram,
  recordManagedInput,
  shellWord,
  type ManagedStaticFileScope,
} from "./managed-inspection";

export type ManagedScratchRoot = {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly birthtimeNs: string;
};

const STATIC_FILE_MAX_FILES = 128;
const STATIC_FILE_MAX_BYTES = 64 * 1024 * 1024;
const READ: TokenEffect = { effect: "read", source: "managed-literal" };
const WRITE: TokenEffect = { effect: "write", source: "managed-literal" };

function bigintStat(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}

function noSymlinkAncestors(path: string): boolean {
  if (!isAbsolute(path)) return false;
  let current = resolve(path);
  const chain: string[] = [];
  while (current !== dirname(current)) {
    chain.push(current);
    current = dirname(current);
  }
  chain.push(current);
  for (const item of chain.reverse()) {
    const stat = bigintStat(item);
    if (!stat || stat.isSymbolicLink()) return false;
  }
  return true;
}

function validScratchRoot(record: ManagedScratchRoot): boolean {
  if (!/^\/tmp\/tmp\.[A-Za-z0-9]+$/.test(record.path) || resolve(record.path) !== record.path)
    return false;
  const stat = bigintStat(record.path);
  const euid = process.geteuid?.();
  return (
    !!stat &&
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    euid !== undefined &&
    record.uid === euid &&
    Number(stat.uid) === euid &&
    Number(stat.mode & 0o777n) === 0o700 &&
    stat.dev.toString() === record.dev &&
    stat.ino.toString() === record.ino &&
    stat.birthtimeNs.toString() === record.birthtimeNs &&
    noSymlinkAncestors(record.path)
  );
}

const under = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function rootFor(
  path: string,
  roots: readonly ManagedScratchRoot[],
): ManagedScratchRoot | undefined {
  return roots
    .filter((root) => under(root.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function validateExistingChain(
  root: ManagedScratchRoot,
  path: string,
  plannedDirs: Set<string>,
): boolean {
  let current = dirname(path);
  while (current !== root.path) {
    if (!under(root.path, current)) return false;
    if (!plannedDirs.has(current)) {
      const stat = bigintStat(current);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== root.dev)
        return false;
    }
    current = dirname(current);
  }
  return true;
}

type PlannedFile = { size: number; sourceDev: string; sourceIno: string };
// Keep lexical operands and normalized path-policy values aligned. In
// particular, do not let trimming or URI-like prefixes disappear in resolve().
const staticFileOperand = (word: string) => {
  if (word === ".") return true;
  if (
    !/^(?:\/)?[A-Za-z0-9_.-][A-Za-z0-9_./ -]*$/.test(word) ||
    word.startsWith("-") ||
    word.endsWith("/")
  )
    return false;
  const path = word.startsWith("./") ? word.slice(2) : word;
  return path
    .split("/")
    .every(
      (part, index) =>
        (part !== "" || (index === 0 && path.startsWith("/"))) &&
        part !== "." &&
        part !== ".." &&
        part === part.trim(),
    );
};

/**
 * Harden a deliberately tiny mkdir/cp language and privately attach its exact
 * read/write scope to the actual mutable SDK input object. The scratch records
 * are provenance, not a path-policy override; downstream gates still resolve
 * every access on their normal directional surfaces.
 */
export async function hardenStaticFileInput(
  input: Record<string, unknown>,
  scratchRoots: readonly ManagedScratchRoot[],
  sessionCwd: string,
): Promise<{ version: 1; originalDigest: string; executionDigest: string } | undefined> {
  // Clear even when this invocation cannot qualify: reused input is no grant.
  clearManagedStaticFileScope(input);
  if (typeof input.command !== "string" || scratchRoots.length === 0) return;
  const source = input.command;
  const tree = (await getParser()).parse(source);
  if (!tree) return;
  try {
    const units = literalProgram(tree.rootNode);
    if (!units || units.some((unit) => source.slice(unit.start, unit.end) !== unit.text)) return;
    if (source.slice(0, units[0].start).trim() || source.slice(units.at(-1)!.end).trim()) return;
    for (let i = 1; i < units.length; i++) {
      if (!/^\s*&&\s*$/.test(source.slice(units[i - 1].end, units[i].start))) return;
    }

    const roots = scratchRoots.filter(validScratchRoot);
    if (roots.length === 0) return;
    let cwd = resolve(sessionCwd);
    let first = 0;
    const replacements: string[] = [];
    const accesses: Array<{
      token: string;
      path: string;
      resolveBase?: string;
      effect: "read" | "write";
    }> = [];
    const marked: boolean[] = [];
    if (units[0].words[0] === "cd") {
      if (units[0].words.length !== 2 || units.length < 2 || !staticFileOperand(units[0].words[1]))
        return;
      const previousCwd = cwd;
      cwd = resolve(cwd, units[0].words[1]);
      const stat = bigintStat(cwd);
      if (!stat?.isDirectory() || !noSymlinkAncestors(cwd)) return;
      // Absolute operands cannot be options or follow CDPATH. Keep the same
      // option-free spelling accepted by the independent static guard.
      replacements.push(`cd ${shellWord(cwd)}`);
      accesses.push({
        token: units[0].words[1],
        path: cwd,
        resolveBase: previousCwd,
        effect: "read",
      });
      marked.push(false);
      first = 1;
    }
    if (units.slice(first).some((unit) => unit.words[0] === "cd")) return;

    const plannedDirs = new Set<string>();
    const plannedFiles = new Map<string, PlannedFile>();
    let fileCount = 0;
    let byteCount = 0;
    const checkedRoots = new Set<string>();
    const checkDestination = (path: string) => {
      const root = rootFor(path, roots);
      if (!root || !validScratchRoot(root) || !validateExistingChain(root, path, plannedDirs))
        return undefined;
      checkedRoots.add(root.path);
      return root;
    };
    const sourceFile = (path: string): PlannedFile | undefined => {
      const planned = plannedFiles.get(path);
      if (planned) return planned;
      const stat = bigintStat(path);
      if (
        !stat ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        !noSymlinkAncestors(path)
      )
        return;
      const containing = roots.find((root) => path === root.path || under(root.path, path));
      if (containing && stat.dev.toString() !== containing.dev) return;
      return {
        size: Number(stat.size),
        sourceDev: stat.dev.toString(),
        sourceIno: stat.ino.toString(),
      };
    };

    for (let index = first; index < units.length; index++) {
      const { words } = units[index];
      if (words[0] === "mkdir") {
        if (words.length < 3 || words[1] !== "-p" || !words.slice(2).every(staticFileOperand))
          return;
        const paths = words.slice(2).map((word) => resolve(cwd, word));
        for (const [pathIndex, path] of paths.entries()) {
          const root = rootFor(path, roots);
          if (!root || !validScratchRoot(root)) return;
          checkedRoots.add(root.path);
          accesses.push({ token: words[pathIndex + 2], path, resolveBase: cwd, effect: "write" });
          const implied: string[] = [];
          let current = path;
          while (current !== root.path) {
            if (!under(root.path, current)) return;
            const existing = bigintStat(current);
            if (existing) {
              if (
                !existing.isDirectory() ||
                existing.isSymbolicLink() ||
                existing.dev.toString() !== root.dev
              )
                return;
            } else if (!plannedDirs.has(current)) implied.push(current);
            current = dirname(current);
          }
          for (const directory of implied.reverse()) {
            plannedDirs.add(directory);
            accesses.push({ token: directory, path: directory, effect: "write" });
          }
        }
        replacements.push(["mkdir", "-p", "--", ...paths].map(shellWord).join(" "));
        marked.push(true);
        continue;
      }
      if (words[0] !== "cp" || words.length < 3 || !words.slice(1).every(staticFileOperand)) return;
      const sources = words.slice(1, -1).map((word) => resolve(cwd, word));
      const requestedTarget = resolve(cwd, words.at(-1)!);
      const targetStat = bigintStat(requestedTarget);
      const targetIsDirectory = plannedDirs.has(requestedTarget) || !!targetStat?.isDirectory();
      if (sources.length > 1 && !targetIsDirectory) return;
      if (
        targetStat &&
        (targetStat.isSymbolicLink() || (targetIsDirectory && !targetStat.isDirectory()))
      )
        return;
      // Preserve rules on the explicit directory operand as well as on every
      // derived child. An exact directory deny must not disappear on expansion.
      accesses.push({
        token: words.at(-1)!,
        path: requestedTarget,
        resolveBase: cwd,
        effect: "write",
      });
      const destinations = sources.map((src) =>
        targetIsDirectory ? join(requestedTarget, basename(src)) : requestedTarget,
      );
      const sourceFacts = sources.map(sourceFile);
      if (sourceFacts.some((item) => !item)) return;
      for (let i = 0; i < destinations.length; i++) {
        const dest = destinations[i];
        const root = checkDestination(dest);
        const fact = sourceFacts[i]!;
        if (
          !root ||
          dest === sources[i] ||
          bigintStat(dest) ||
          plannedDirs.has(dest) ||
          plannedFiles.has(dest)
        )
          return;
        if (++fileCount > STATIC_FILE_MAX_FILES || (byteCount += fact.size) > STATIC_FILE_MAX_BYTES)
          return;
        plannedFiles.set(dest, fact);
        accesses.push({ token: words[i + 1], path: sources[i], resolveBase: cwd, effect: "read" });
        accesses.push({ token: dest, path: dest, effect: "write" });
      }
      replacements.push(
        targetIsDirectory
          ? ["cp", "--no-dereference", `--target-directory=${requestedTarget}`, "--", ...sources]
              .map(shellWord)
              .join(" ")
          : ["cp", "--no-dereference", "--no-target-directory", "--", sources[0], destinations[0]]
              .map(shellWord)
              .join(" "),
      );
      marked.push(true);
    }
    if (checkedRoots.size === 0 || replacements.length !== units.length) return;

    let command = source;
    for (let i = units.length - 1; i >= 0; i--)
      command = command.slice(0, units[i].start) + replacements[i] + command.slice(units[i].end);
    if (command === source) return;
    const scope: ManagedStaticFileScope = { command, marked, accesses };
    return recordManagedInput(input, source, command, units, scope);
  } finally {
    tree.delete();
  }
}

export function managedStaticFileProof(
  scope: ManagedStaticFileScope | undefined,
  command: string,
  normalizer: PathNormalizer,
):
  | {
      ruleCandidates: BashPathRuleCandidate[];
      externalAccesses: BashExternalPath[];
      marked: boolean[];
    }
  | undefined {
  if (!scope || scope.command !== command) return;
  const ruleCandidates = scope.accesses.map(({ token, path, resolveBase, effect }) => ({
    token,
    path:
      resolveBase === undefined
        ? normalizer.forPath(path)
        : normalizer.forPath(token, { resolveBase }),
    effect: effect === "read" ? READ : WRITE,
  }));
  const externalAccesses = ruleCandidates
    .filter(({ path }) => normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue()))
    .map(({ path, effect }) => ({ path, effect }));
  return { ruleCandidates, externalAccesses, marked: [...scope.marked] };
}
