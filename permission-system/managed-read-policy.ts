// Local, version-pinned extension of the existing pipeline, not an authorizer.
// Upstream read-command effects stay separate from the native Git inventory;
// this module does not inject Git flags, pin objects, or exempt wrappers.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { TokenEffect } from "#src/access-intent/effect";
import type { BashPathRuleCandidate, BashExternalPath } from "./bash-path-resolver";
import { getParser, parseUnresolvedWithin, type TSNode } from "./parser";
import { proveCommandEffect } from "./command-effects";
import { gitQueryWords, nativeGitScope } from "./managed-git-query";

const READ: TokenEffect = { effect: "read", source: "managed-literal" };

// Smaller than shell syntax: whole-word quotes, no expansion, concatenation,
// globbing, assignments-as-prefixes, comments, or redirects.
export function literalWords(source: string): string[] | undefined {
  const words: string[] = [];
  let rest = source.trim();
  while (rest) {
    const match = /^(?:'([^'\n]*)'|"([^"$`\\\n]*)"|([A-Za-z0-9_./:%=+@^,~-]+))(?=\s|$)/.exec(rest);
    if (!match || match[3]?.startsWith("~")) return;
    words.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return words.length ? words : undefined;
}

// Git query words come from the native module. Non-Git readers keep literalWords.
export function gitLiteralWords(source: string): string[] | undefined {
  return gitQueryWords(source);
}

export function managedGitInnerCommand(source: string): string | undefined {
  const words = gitLiteralWords(source);
  if (words?.[0] === "env") return source.replace(/^env[ \t]+/, "");
}

function printingSed(words: string[]): boolean {
  // Only literal numeric print clauses; preserve their order and overlap (sed
  // may print a line more than once). Never rewrite into a wider single range.
  const clauses = (words[2] ?? "").split(";");
  return (
    words[0] === "sed" &&
    words[1] === "-n" &&
    clauses.length <= 32 &&
    clauses.every((clause) => /^[1-9]\d*(?:,(?:[1-9]\d*|\$))?p$/.test(clause)) &&
    words.slice(3).every((word) => word === "-" || !word.startsWith("-"))
  );
}

function resourceMetadata(words: string[]): boolean {
  const [head, ...args] = words;
  if (head === "free")
    return args.every((arg) =>
      ["-h", "-m", "-g", "-b", "-k", "--si", "--total", "--wide"].includes(arg),
    );
  if (head === "df")
    return args.every(
      (arg) =>
        !arg.startsWith("-") || ["-h", "-H", "-T", "-i", "-P", "--total", "--"].includes(arg),
    );
  return false;
}

const exposedEnvironment = new Set([
  "PI_MODEL",
  "PI_MODEL_ID",
  "PI_PROVIDER",
  "BUILD_DIR",
  "AOBUS_BUILD_ROOT",
  "AOBUS_STATE_ROOT",
]);
const commandProbes = new Set(["pi", "alejandra", "mypy"]);
// Preserve the non-Git syntax-checker's existing path language independently
// of the native Git decoder's Unicode/path additions.
const ordinaryFileWord = (word: string) =>
  word !== "." &&
  word === word.trim() &&
  /^(?:\.\/)?[A-Za-z0-9_.-][A-Za-z0-9_./ -]*$/.test(word) &&
  !word.startsWith("-") &&
  !word.split("/").includes("..");

type ManagedInspection = { files: string[] };
// Exact hardened execution spellings, not patterns over arbitrary tool families.
function managedInspection(words: string[]): ManagedInspection | undefined {
  if (
    words.length === 4 &&
    words[0] === "type" &&
    words[1] === "-P" &&
    words[2] === "--" &&
    commandProbes.has(words[3])
  )
    return { files: [] };
  if (
    words.length > 2 &&
    words[0] === "printenv" &&
    words[1] === "--" &&
    words.slice(2).every((word) => exposedEnvironment.has(word))
  )
    return { files: [] };
  if (
    words.length === 7 &&
    words.slice(0, 6).join(" ") === "bash --noprofile --norc -p -n --" &&
    ordinaryFileWord(words[6])
  )
    return { files: [words[6]] };
}

// Effect attribution is NOT a Bash allowance or a general wrapper-floor
// exemption. Only the exact hardened spellings above enter the new lane.
export function managedInspectionEffect(source: string): TokenEffect | undefined {
  const words = literalWords(source);
  if (!words) return;
  const [head, ...args] = words;
  if (
    managedInspection(words) ||
    ["cut", "nl", "readlink", "tr"].includes(head) ||
    printingSed(words) ||
    resourceMetadata(words)
  )
    return READ;
  if (head === "uniq" && (args.length === 0 || args.join(" ") === "-c")) return READ;
  if (head === "sha256sum") {
    let operands = false;
    for (const arg of args) {
      if (arg === "--") {
        operands = true;
        continue;
      }
      if (operands || !arg.startsWith("-") || arg === "-") continue;
      if (
        !/^-([btz]+)$/.test(arg) &&
        !["--binary", "--text", "--tag", "--zero", "--help", "--version"].includes(arg)
      )
        return;
    }
    return READ;
  }
  if (head === "printf") {
    const format = args[0] === "--" ? args[1] : args[0];
    if (
      format !== undefined &&
      !format.startsWith("-") &&
      !format.replace(/%(s|%)/g, "").includes("%")
    )
      return READ;
  }
}

export type ManagedGitDiagnostic = { code: string; reason: string; token?: string };
type ScopeProof = { ruleCandidates: BashPathRuleCandidate[]; externalAccesses: BashExternalPath[] };

// Compatibility entry for the tiny literal version query only. Repository
// history/content commands no longer receive a managed read proof or grant.
export function managedGitProof(
  source: string,
  normalizer: PathNormalizer,
  workdir?: string,
  reject?: (diagnostic: ManagedGitDiagnostic) => void,
): ScopeProof | undefined {
  const scope = nativeGitScope(source, normalizer, workdir);
  if (!scope?.auto) {
    reject?.(
      scope?.diagnostic ?? {
        code: "git-scope",
        reason: "Git query scope is unavailable for this command.",
      },
    );
    return;
  }
  return { ruleCandidates: scope.ruleCandidates, externalAccesses: scope.externalAccesses };
}

type LiteralUnit = { text: string; words: string[]; start: number; end: number };
// Reuse upstream's actual AST. Only fully literal commands joined by ordinary
// foreground operators enter this lane; wrappers need a separate exact proof.
export function literalProgram(root: TSNode): LiteralUnit[] | undefined {
  if (parseUnresolvedWithin(root)) return;
  const units: LiteralUnit[] = [];
  const walk = (node: TSNode): boolean => {
    if (!node.isNamed) return ["&&", "||", ";", "|"].includes(node.text);
    if (node.type === "command") {
      const words = gitLiteralWords(node.text) ?? literalWords(node.text);
      if (!words || !/^[a-z][a-z0-9-]*$/.test(words[0])) return false;
      units.push({ text: node.text, words, start: node.startIndex, end: node.endIndex });
      return true;
    }
    if (!["program", "list", "pipeline"].includes(node.type)) return false;
    for (let i = 0; i < node.childCount; i++) if (!walk(node.child(i)!)) return false;
    return true;
  };
  return walk(root) && units.length ? units : undefined;
}

export type ManagedStaticFileScope = {
  readonly command: string;
  readonly marked: readonly boolean[];
  readonly accesses: readonly {
    token: string;
    path: string;
    resolveBase?: string;
    effect: "read" | "write";
  }[];
};

const originals = new WeakMap<
  object,
  { command: string; units: string[]; fileScope?: ManagedStaticFileScope }
>();
// Provenance requires the same input object and unchanged hardened command.
export function originalGitCommands(input: Record<string, unknown>): string[] | undefined {
  const original = originals.get(input);
  return original?.command === input.command ? original.units : undefined;
}

// The pipeline can obtain a file-effect scope only for the exact input object
// mutated by this module. A JSON field with the same name has no authority.
export function managedStaticFileScope(
  input: Record<string, unknown>,
): ManagedStaticFileScope | undefined {
  const original = originals.get(input);
  return original?.command === input.command && original.fileScope?.command === input.command
    ? original.fileScope
    : undefined;
}
const shellWord = (word: string) =>
  /^[A-Za-z0-9_./:%=+@^,~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

export type ManagedScratchRoot = {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly birthtimeNs: string;
};

const STATIC_FILE_MAX_FILES = 128;
const STATIC_FILE_MAX_BYTES = 64 * 1024 * 1024;
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
  // A scope is a proof for this invocation, never a reusable grant on an input
  // object. SDK callers may reuse objects after execution or across sessions.
  const previous = originals.get(input);
  if (previous?.fileScope)
    originals.set(input, { command: previous.command, units: previous.units });
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
    input.command = command;
    originals.set(input, { command, units: units.map((unit) => unit.text), fileScope: scope });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return { version: 1, originalDigest: hash(source), executionDigest: hash(command) };
  } finally {
    tree.delete();
  }
}

export function managedStaticFileProof(
  scope: ManagedStaticFileScope | undefined,
  command: string,
  normalizer: PathNormalizer,
): (ScopeProof & { marked: boolean[] }) | undefined {
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

function hardenedUnit(words: string[]): string | undefined {
  if (
    words.length === 3 &&
    words[0] === "command" &&
    words[1] === "-v" &&
    commandProbes.has(words[2])
  )
    return ["type", "-P", "--", words[2]].map(shellWord).join(" ");
  if (words.length === 3 && words[0] === "bash" && words[1] === "-n" && ordinaryFileWord(words[2]))
    return ["bash", "--noprofile", "--norc", "-p", "-n", "--", words[2]].map(shellWord).join(" ");
  if (
    words.length > 1 &&
    words[0] === "printenv" &&
    words.slice(1).every((word) => exposedEnvironment.has(word))
  )
    return ["printenv", "--", ...words.slice(1)].join(" ");
  if (
    words.length > 2 &&
    words[0] === "env" &&
    words[1] === "printenv" &&
    words.slice(2).every((word) => exposedEnvironment.has(word))
  )
    return ["printenv", "--", ...words.slice(2)].join(" ");
}

// Called BEFORE the authority's gate handler. SDK guarantees that in-place input
// mutation is the actual execution input; no tool replacement or gate bypass.
// Keep original command units privately so explicit ORIGINAL ask/deny rules are
// checked as well as normalized rules. The model cannot forge a WeakMap entry.
export async function hardenGitInput(input: Record<string, unknown>, _sessionCwd = process.cwd()) {
  if (typeof input.command !== "string") return;
  const source = input.command;
  const tree = (await getParser()).parse(source);
  if (!tree) return;
  try {
    const units = literalProgram(tree.rootNode);
    if (!units || units.some((unit) => source.slice(unit.start, unit.end) !== unit.text)) return;
    const gitUnit = (unit: LiteralUnit) =>
      unit.words[0] === "git" || (unit.words[0] === "env" && unit.words.includes("git"));
    const hasGit = units.some(gitUnit);
    const replacements = units.map((unit) =>
      gitUnit(unit) ? undefined : hardenedUnit(unit.words),
    );
    if (!replacements.some(Boolean)) return;
    // Bash CDPATH can redirect a bare relative `cd` outside the checked cwd.
    // Make the ordinary leading-cd spelling explicitly cwd-relative instead.
    const first = units[0].words;
    if (
      !hasGit &&
      first[0] === "cd" &&
      first.length === 2 &&
      first[1] &&
      first[1] === first[1].trim() &&
      !first[1].startsWith("-") &&
      !/^(?:\/|\.\.?\/|\.{1,2}$)/.test(first[1])
    )
      replacements[0] = `cd ${shellWord(`./${first[1]}`)}`;
    let command = source;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i],
        replacement = replacements[i];
      if (replacement)
        command = command.slice(0, unit.start) + replacement + command.slice(unit.end);
    }
    if (command === source) return;
    input.command = command;
    originals.set(input, { command, units: units.map((unit) => unit.text) });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return { version: 1, originalDigest: hash(source), executionDigest: hash(command) };
  } finally {
    tree.delete();
  }
}

// Presentation only. Recognizing a Git-looking unit must never admit it.
export function managedGitSyntaxDiagnostic(source: string): ManagedGitDiagnostic | undefined {
  if (/^(?:env[ \t]+)?git(?:[ \t]|$)/.test(source))
    return {
      code: "git-program-syntax",
      reason:
        "This shell structure, assignment or expansion is outside literal Git query classification.",
    };
}

type ManagedProgramProof = ScopeProof & { marked: boolean[]; gitWrappers: (string | undefined)[] };
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
  const gitWrappers: (string | undefined)[] = units.map(() => undefined);
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
  return { proof: { ruleCandidates, externalAccesses, marked, gitWrappers }, diagnostics };
}
