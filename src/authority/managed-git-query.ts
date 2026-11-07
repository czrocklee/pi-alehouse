// Literal Git effects and additive restrictions, not repository/content proof.
// No Git subprocesses, history walks, object attribution or execution rewrites.
// Repository commands use normal Bash permission, including mutations and yolo.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { TokenEffect } from "#src/access-intent/effect";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { BashExternalPath, BashPathRuleCandidate } from "./bash-path-resolver";
import type { TSNode } from "./parser";
import { ownedRedirectTails, redirectTail, redirectTailOwner } from "./managed-redirect-argv";
import {
  gitHistoryOptionLength,
  gitLogRevision,
  gitMutationProblem,
  gitRequiredOperandRole,
  gitStatusFlags,
} from "./git-read-grammar";

export type NativeGitDiagnostic = { code: string; reason: string; token?: string };
export type NativeGitUnit = {
  text: string;
  auto: boolean;
  restrictions?: readonly string[];
  completed?: readonly string[];
  diagnostic?: NativeGitDiagnostic;
};
export type NativeGitScope = {
  ruleCandidates: BashPathRuleCandidate[];
  externalAccesses: BashExternalPath[];
  auto: boolean;
  /** Completeness concerns only the tiny version query, never repository IO. */
  complete: boolean;
  diagnostic?: NativeGitDiagnostic;
};
const READ: TokenEffect = { effect: "read", source: "managed-literal" };
const WRITE: TokenEffect = { effect: "write", source: "managed-literal" };
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

// Literal shell concatenation only. Dynamic words stay unknown, not READ.
function literalWords(source: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /[ \t]/.test(source[i]!)) i++;
    if (i === source.length) break;
    let word = "",
      started = false;
    while (i < source.length && !/[ \t]/.test(source[i]!)) {
      const char = source[i++]!;
      if (char === "'" || char === '"') {
        const end = source.indexOf(char, i);
        if (end < 0) return;
        const fragment = source.slice(i, end);
        if (controls.test(fragment) || (char === '"' && /[$`\\]/.test(fragment))) return;
        word += fragment;
        started = true;
        i = end + 1;
      } else if (char === "\\") {
        const escaped = source[i++];
        if (escaped === undefined || controls.test(escaped)) return;
        word += escaped;
        started = true;
      } else if (char === "{" && /[@^]$/.test(word)) {
        const end = source.indexOf("}", i),
          fragment = end < 0 ? "" : source.slice(i, end);
        if (end < 0 || !/^[A-Za-z0-9_./@^+\-]*$/.test(fragment) || fragment.includes("..")) return;
        word += `{${fragment}}`;
        started = true;
        i = end + 1;
      } else {
        if (
          controls.test(char) ||
          /[\s$`*?\[\]{};|&<>()!#"']/.test(char) ||
          (char === "~" && (!started || /^[A-Za-z_][A-Za-z0-9_]*=(?:.*:)?$/.test(word)))
        )
          return;
        word += char;
        started = true;
      }
    }
    if (!started) return;
    words.push(word);
  }
  return words.length ? words : undefined;
}
export function gitQueryWords(source: string): string[] | undefined {
  if (source.length > 65536) return;
  const words = literalWords(source);
  if (/^[ \t]*git(?:[ \t]|$)/.test(source) && words?.[0] === "git") return words;
  if (/^[ \t]*env[ \t]+git(?:[ \t]|$)/.test(source) && words?.[0] === "env" && words[1] === "git")
    return words;
}

type Invocation = {
  sub: string;
  args: string[];
  directories: string[];
  rootSafe: boolean;
  spellings: string[];
  dynamicBlobs: string[];
};
const globalFlags = new Set([
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-pager",
  "-P",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--no-advice",
  "-p",
  "--paginate",
  "--bare",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);
const globalValues = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--attr-source",
  "--config-env",
]);
function safeAssignment(value: string): boolean {
  const key = value.split("=", 1)[0] ?? "";
  return (
    !/^(?:GIT_|BASH|LD_|DYLD_)/.test(key) &&
    !["PATH", "HOME", "XDG_CONFIG_HOME", "ENV", "SHELLOPTS", "CDPATH", "PWD"].includes(key)
  );
}
// A bounded restriction-only brace expansion; it confers no command eligibility.
function braceWords(text: string, depth = 0): string[] | undefined {
  const group = /^([^{}]*)\{([^{}$`'"\\]*,[^{}$`'"\\]*)\}(.*)$/s.exec(text);
  if (!group || depth > 3) return;
  const words: string[] = [];
  for (const choice of group[2]!.split(",")) {
    const variant = `${group[1]}${choice}${group[3]}`,
      decoded = literalWords(`git ${variant}`);
    const expanded = decoded?.length === 2 ? [decoded[1]!] : braceWords(variant, depth + 1);
    if (!expanded) return;
    words.push(...expanded);
    if (words.length > 32) return;
  }
  return words;
}
function literalFragment(node: TSNode, child: TSNode): string | undefined {
  // string_content is already inside double quotes. Decode it in that same
  // context, not as an unquoted shell word; expansions remain unknown slots.
  const source =
    node.type === "string" && child.type === "string_content" ? `"${child.text}"` : child.text;
  const words = literalWords(`git ${source}`);
  return words?.length === 2 ? words[1] : undefined;
}
function dynamicDirectoryOption(node: TSNode): string | undefined {
  if (!["concatenation", "string"].includes(node.type)) return;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (!child.isNamed) continue;
    // Known attached -C arity only, still ONE argv slot even in a DATA role.
    return literalFragment(node, child)?.startsWith("-C") ? "-C\0" : undefined;
  }
}
function dynamicBlobPath(node: TSNode): string | undefined {
  if (!["concatenation", "string"].includes(node.type) || /^-/.test(node.text)) return;
  const parts: (string | undefined)[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.isNamed) parts.push(literalFragment(node, child));
  }
  if (parts[0]?.startsWith("-")) return;
  for (let i = 1; i < parts.length; i++) {
    const text = parts[i];
    if (text === undefined || !text.includes(":")) continue;
    const rest = [text.slice(text.indexOf(":") + 1)];
    for (let j = i + 1; j < parts.length; j++) {
      const part = parts[j];
      if (part === undefined) return;
      rest.push(part);
    }
    const path = rest.join("");
    if (!/[?*\[\]]/.test(path)) return path;
  }
}
function invocation(
  words: readonly string[],
  rootSafe = true,
  spellings: string[] = [],
  dynamicBlobs: string[] = [],
  restrictionOnly = false,
  sourceWords: readonly TSNode[] = [],
): Invocation | undefined {
  let i = 0;
  // Only operand-free command/exec (optionally --), before env/Git. In
  // particular command -v/-V and exec's other options are not execution proof.
  if (restrictionOnly)
    for (let depth = 0; depth < 4 && ["command", "exec"].includes(words[i] ?? ""); depth++) {
      i++;
      if (words[i] === "--") i++;
    }
  const head = words[i++];
  let gitIndex = i - 1;
  const gitExecutable = (word: string | undefined) =>
    word === "git" || (restrictionOnly && word?.endsWith("/git") === true);
  const directoryOperand = (word: string | undefined) =>
    word !== undefined && (!controls.test(word) || (restrictionOnly && word.startsWith("\0")));
  const directories: string[] = [];
  if (head === "env") {
    let envDirectory: string | undefined;
    while (i < words.length) {
      const word = words[i]!;
      if (word === "--") {
        i++;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        rootSafe &&= safeAssignment(word);
        i++;
        continue;
      }
      if (["-i", "--ignore-environment", "-0", "--null"].includes(word)) {
        rootSafe = false;
        i++;
        continue;
      }
      if (["-u", "--unset"].includes(word)) {
        if (!words[i + 1] || controls.test(words[i + 1]!)) return;
        rootSafe &&= safeAssignment(`${words[i + 1]}=`);
        i += 2;
        continue;
      }
      if (word.startsWith("--unset=") || (word.startsWith("-u") && word.length > 2)) {
        rootSafe &&= safeAssignment(`${word.startsWith("-u") ? word.slice(2) : word.slice(8)}=`);
        i++;
        continue;
      }
      if (["-C", "--chdir"].includes(word)) {
        if (!words[i + 1] || !directoryOperand(words[i + 1])) return;
        envDirectory = words[i + 1];
        i += 2;
        continue;
      }
      if (word.startsWith("--chdir=") || (word.startsWith("-C") && word.length > 2)) {
        envDirectory = word.startsWith("-C") ? word.slice(2) : word.slice(8);
        i++;
        continue;
      }
      break;
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) {
      rootSafe &&= safeAssignment(words[i]!);
      i++;
    }
    gitIndex = i;
    if (!gitExecutable(words[i++])) return;
    if (envDirectory !== undefined) directories.push(envDirectory);
  } else if (!gitExecutable(head)) return;
  while (words[i]?.startsWith("-") && words[i] !== "--version") {
    const word = words[i++]!;
    if (word === "-C") {
      if (!directoryOperand(words[i])) return;
      directories.push(words[i++]!);
    } else if (word.startsWith("-C") && word.length > 2) directories.push(word.slice(2));
    else if (globalFlags.has(word)) {
      if (word === "--bare") rootSafe = false;
    } else if (word === "-c" || globalValues.has(word)) {
      if (!words[i++]) return;
      rootSafe = false;
    } else if (
      word.startsWith("-c") ||
      [...globalValues].some((flag) => word.startsWith(`${flag}=`)) ||
      word.startsWith("--exec-path=")
    )
      rootSafe = false;
    else return; // Unknown global arity: never guess a subcommand position.
  }
  const sub = words[i++];
  if (!sub || controls.test(sub)) return;
  if (restrictionOnly) {
    // Inner spellings can select denies/asks only. Retain original quoting
    // and unknown argv as well as the decoded conventional executable alias.
    const raw = [
      ...new Map(
        sourceWords.slice(gitIndex).map((node) => [node.startIndex, node.text] as const),
      ).values(),
    ];
    if (raw.length) spellings.push(raw.join(" "), ["git", ...raw.slice(1)].join(" "));
    if (words.every((word) => !controls.test(word)))
      spellings.push(["git", ...words.slice(gitIndex + 1)].join(" "));
  }
  return {
    sub,
    args: words.slice(i),
    directories,
    rootSafe,
    spellings: [...new Set(spellings)],
    dynamicBlobs,
  };
}
function commandHead(node: TSNode): { name?: TSNode; head?: string } {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type !== "command_name") continue;
    const words = literalWords(child.text);
    return { name: child, ...(words?.length === 1 ? { head: words[0] } : {}) };
  }
  return {};
}
function restrictionInvocation(node: TSNode): Invocation | undefined {
  const { name, head } = commandHead(node);
  if (!name || !(["git", "env", "command", "exec"].includes(head ?? "") || head?.endsWith("/git")))
    return;
  const args = [...ownedRedirectTails(node)];
  let afterName = false,
    rootSafe = true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.startIndex === name.startIndex) {
      afterName = true;
      continue;
    }
    if (child.type === "variable_assignment" && !safeAssignment(child.text)) rootSafe = false;
    if (child.type === "file_redirect") {
      args.push(...redirectTail(child));
      continue;
    }
    if (afterName && child.isNamed && !child.type.endsWith("redirect")) args.push(child);
  }
  args.sort((a, b) => a.startIndex - b.startIndex);
  const dynamicBlobs: string[] = [],
    sourceWords = [name];
  const words = [
    head!,
    ...args.flatMap((child) => {
      const decoded = literalWords(`git ${child.text}`),
        expanded = decoded?.length === 2 ? [decoded[1]!] : braceWords(child.text);
      const directory = expanded ? undefined : dynamicDirectoryOption(child);
      const path = expanded || directory ? undefined : dynamicBlobPath(child);
      // Keep a literal dynamic-revision tail IN its argv slot. A required DATA
      // operand must not become a historical path merely because it has a colon.
      const slots = expanded ?? [directory ?? (path ? `\0:${path}` : "\0")]; // Unknowns never shift DATA.
      sourceWords.push(...slots.map(() => child));
      return slots;
    }),
  ];
  const raw = [name.text, ...args.map((arg) => arg.text)].join(" ");
  const spellings = [raw];
  if (words.every((word) => !controls.test(word))) spellings.push(words.join(" "));
  if (head === "env") {
    const git = words.indexOf("git", 1);
    if (git >= 0 && words.every((word) => !controls.test(word)))
      spellings.push(words.slice(git).join(" "));
    // Exact source spelling for the common operand-free env lane.
    if (args[0] && literalWords(args[0].text)?.[0] === "git")
      spellings.push(args.map((arg) => arg.text).join(" "));
  }
  return invocation(words, rootSafe, spellings, dynamicBlobs, true, sourceWords);
}

// Literal batch stdin can itself spell rev:path. Keep that spelling only;
// never resolve object IDs, read redirected files or enumerate their history.
function batchPaths(command: TSNode): string[] {
  const paths: string[] = [];
  const inspect = (redirect: TSNode) => {
    let text: string | undefined,
      delimiter = "";
    for (let i = 0; i < redirect.childCount; i++) {
      const child = redirect.child(i)!;
      if (child.type === "heredoc_start") delimiter = child.text;
      if (child.type === "heredoc_body") text = child.text;
      if (
        redirect.type === "herestring_redirect" &&
        child.isNamed &&
        child.type !== "file_descriptor"
      ) {
        const source = child.text;
        if (child.type === "raw_string" || (child.type === "string" && !/[$`\\]/.test(source)))
          text = source.slice(1, -1);
        else {
          const words = literalWords(`git ${source}`);
          if (words?.length === 2) text = words[1];
        }
      }
    }
    for (const line of text?.split("\n") ?? []) {
      if (!/['"\\]/.test(delimiter) && /[$`\\]/.test(line)) continue;
      const split = /^(\S+)\s+(.*)$/.exec(line);
      for (const word of [line.trim(), split?.[1], split?.[2]]) {
        const path = word && blobPath(word);
        if (path && blobFile(path)) paths.push(path);
      }
    }
  };
  for (let i = 0; i < command.childCount; i++) {
    const child = command.child(i)!;
    if (["herestring_redirect", "heredoc_redirect"].includes(child.type)) inspect(child);
  }
  for (
    let parent = command.parent, depth = 0;
    parent && ["list", "pipeline", "redirected_statement"].includes(parent.type) && depth < 128;
    parent = parent.parent, depth++
  ) {
    for (let i = 0; i < parent.childCount; i++) {
      const redirect = parent.child(i)!;
      if (!["herestring_redirect", "heredoc_redirect"].includes(redirect.type)) continue;
      if (redirectTailOwner(redirect)?.startIndex === command.startIndex) inspect(redirect);
    }
  }
  return paths;
}

const contentQueries = new Set([
  "status",
  "ls-files",
  "log",
  "show",
  "diff",
  "cat-file",
  "rev-parse",
  "diff-tree",
  "diff-index",
  "grep",
  "blame",
  "annotate",
  "archive",
  "format-patch",
  "difftool",
  "range-diff",
  "whatchanged",
  "checkout",
  "restore",
  "reset",
  "add",
  "rm",
  "mv",
]);
const literalFile = (word: string) =>
  !!word && !controls.test(word) && !word.startsWith(":") && !/[?*\[\]]/.test(word);
const blobFile = (word: string) => !!word && !controls.test(word) && !isAbsolute(word);
function blobPath(word: string): string | undefined {
  const staged = /^:(?:[0-3]:)?(?!\/)(.+)$/.exec(word);
  if (staged) return staged[1];
  const colon = word.indexOf(":");
  return colon > 0 && !word.startsWith("-") && !controls.test(word)
    ? word.slice(colon + 1) || undefined
    : undefined;
}
type Restrictions = { paths: string[]; outputs: string[]; blobs: string[] };
function literalRestrictions(inv: Invocation): Restrictions {
  const result: Restrictions = { paths: [], outputs: [], blobs: [] };
  if (!contentQueries.has(inv.sub)) return result;
  const sub = inv.sub === "whatchanged" ? "log" : inv.sub;
  result.blobs.push(...inv.dynamicBlobs.filter(blobFile));
  for (let i = 0, paths = false; i < inv.args.length; i++) {
    const arg = inv.args[i]!;
    if (paths) {
      if (literalFile(arg)) result.paths.push(arg);
      continue;
    }
    if (arg === "--") {
      paths = true;
      continue;
    }
    const role = gitRequiredOperandRole(sub, arg);
    if (role) {
      const value = inv.args[++i];
      if (role === "output" && value && !controls.test(value)) result.outputs.push(value);
      continue;
    }
    if (
      ["log", "show", "diff", "diff-tree", "archive"].includes(sub) &&
      arg.startsWith("--output=")
    ) {
      if (arg.length > 9 && !controls.test(arg.slice(9))) result.outputs.push(arg.slice(9));
      continue;
    }
    if (sub === "archive" && (arg === "-o" || (arg.startsWith("-o") && !arg.startsWith("--")))) {
      const value = arg === "-o" ? inv.args[++i] : arg.slice(2);
      if (value && !controls.test(value)) result.outputs.push(value);
      continue;
    }
    if (sub === "archive" && (arg === "--add-file" || arg.startsWith("--add-file="))) {
      const value = arg === "--add-file" ? inv.args[++i] : arg.slice(11);
      if (value && literalFile(value)) result.paths.push(value);
      continue;
    }
    if (["log", "show"].includes(sub) && arg.startsWith("-L")) {
      const range = arg === "-L" ? inv.args[++i] : arg.slice(2),
        file = range?.slice(range.lastIndexOf(":") + 1);
      if (range?.includes(":") && file && literalFile(file)) result.paths.push(file);
      continue;
    }
    if (arg.startsWith("\0:")) {
      if (blobFile(arg.slice(2))) result.blobs.push(arg.slice(2));
      continue;
    }
    const blob =
      sub === "cat-file" && arg.startsWith("--path=")
        ? arg.slice(7)
        : arg.startsWith("-")
          ? undefined
          : blobPath(arg);
    if (blob && blobFile(blob)) result.blobs.push(blob);
    else if (
      ["status", "ls-files", "blame", "annotate", "add", "rm", "mv"].includes(sub) &&
      !arg.startsWith("-") &&
      literalFile(arg)
    )
      result.paths.push(arg);
  }
  return result;
}
function physical(base: string, directory?: string): string {
  return realpathSync.native(
    directory ? (isAbsolute(directory) ? directory : `${base}${sep}${directory}`) : base,
  );
}
function nativePathAlias(base: string, token: string): string | undefined {
  let current = isAbsolute(token) ? token : `${base}${sep}${token}`;
  const tail: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      return join(physical(current), ...tail);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      try {
        if (lstatSync(current).isSymbolicLink()) return;
      } catch (failure) {
        if (!["ENOENT", "ENOTDIR"].includes((failure as NodeJS.ErrnoException).code ?? "")) return;
      }
      const parent = dirname(current);
      if (parent === current) return;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
// Conventional working trees only (.git directory or worktree gitfile). This
// is a filesystem alias lookup, not a Git/config/history probe or a bare-repo
// guarantee. Explicit/inherited repository selectors withhold root aliases.
function repositoryRoot(cwd: string): string | undefined {
  let current = cwd;
  for (let depth = 0; depth < 128; depth++) {
    try {
      const marker = lstatSync(join(current, ".git"));
      return marker.isDirectory() || marker.isFile() ? current : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
const inheritedRepositorySelector = () =>
  Object.entries(process.env).some(
    ([key, value]) =>
      !!value &&
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*)$/.test(
        key,
      ) &&
      !(key === "GIT_CONFIG_COUNT" && value === "0") &&
      !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].includes(key),
  );
function restrictionsScope(
  inv: Invocation,
  normalizer: PathNormalizer,
  workdir: string | undefined,
  knownBase: boolean,
): NativeGitScope {
  const ruleCandidates: BashPathRuleCandidate[] = [];
  const add = (token: string, base?: string, effect = READ) => {
    if (!token || controls.test(token)) return;
    if (!base && !normalizer.isAbsolute(token)) {
      ruleCandidates.push({ token, path: normalizer.forLiteral(token), effect });
      return;
    }
    const absolute = normalizer.flavor.impl.resolve(base ?? normalizer.resolveBase(""), token);
    // Extra quotes are permission representation only; execution is untouched.
    const lookup = (path: string) => normalizer.forPath(`"${path}"`);
    const path = lookup(absolute);
    ruleCandidates.push({ token, path, effect });
    if (path.value() !== normalizer.flavor.comparable(absolute, base ?? normalizer.resolveBase("")))
      ruleCandidates.push({ token, path: normalizer.forLiteral(absolute), effect });
    const actual = nativePathAlias(base ?? normalizer.resolveBase(""), token);
    if (actual !== undefined && actual !== absolute)
      ruleCandidates.push({ token, path: lookup(actual), effect });
  };
  let cwd: string | undefined;
  if (knownBase) {
    try {
      cwd = physical(normalizer.resolveBase(""), workdir);
      for (const directory of inv.directories) {
        // An unknown -C keeps later literal operands, but cannot establish a
        // cwd/root alias. Never substitute PWD or the invocation's old cwd.
        if (controls.test(directory)) {
          cwd = undefined;
          break;
        }
        if (!directory) continue;
        add(directory, cwd);
        cwd = physical(cwd, directory);
      }
    } catch {
      cwd = undefined;
    }
  }
  const restrictions = literalRestrictions(inv);
  for (const path of restrictions.paths) add(path, cwd);
  for (const output of restrictions.outputs) add(output, cwd, WRITE);
  const top =
    cwd && inv.rootSafe && !inheritedRepositorySelector() ? repositoryRoot(cwd) : undefined;
  for (const blob of restrictions.blobs) add(blob, /^(?:\.\/|\.\.\/)/.test(blob) ? cwd : top);
  const externalAccesses = ruleCandidates
    .filter(
      ({ path }) =>
        !path.boundaryValue() || normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue()),
    )
    .map(({ path, effect }) => ({ path, effect }));
  return {
    ruleCandidates,
    externalAccesses,
    complete: false,
    auto: false,
    diagnostic: {
      code: "git-literal-review",
      reason:
        "Literal Git paths and outputs are restrictions only; repository effects use normal Bash permission.",
    },
  };
}
// Only the exact version command is independent of repository config/content.
// Even that small allowance is withheld under inherited Git/loader overrides.
function versionQuery(source: string): boolean {
  return (
    /^(?:env[ \t]+)?git[ \t]+(?:--version|version)[ \t]*$/.test(source) &&
    !Object.entries(process.env).some(
      ([key, value]) => !!value && /^(?:GIT_|LD_|DYLD_|BASH_FUNC_)/.test(key),
    )
  );
}
export function nativeGitScope(
  source: string,
  normalizer: PathNormalizer,
  workdir?: string,
): NativeGitScope | undefined {
  const words = gitQueryWords(source),
    inv = words && invocation(words);
  if (!inv || sep !== "/" || normalizer.flavor.impl.sep !== "/") return;
  const scope = restrictionsScope(inv, normalizer, workdir, true);
  return versionQuery(source)
    ? { ...scope, auto: true, complete: true, diagnostic: undefined }
    : scope;
}

const contextHeads = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "unset",
  "set",
  "shopt",
  "alias",
  "unalias",
  "eval",
  "source",
  ".",
  "exec",
  "builtin",
  "command",
  "declare",
  "typeset",
  "local",
  "readonly",
  "enable",
  "hash",
]);
function nonContextBuiltin(node: TSNode): boolean {
  if (!["command", "declaration_command"].includes(node.type)) return false;
  const words = literalWords(node.text);
  if (node.type === "command" && words?.length === 2 && words[0] === "set" && words[1] === "-e")
    return true;
  return (
    node.type === "declaration_command" &&
    words?.[0] === "export" &&
    words.length > 1 &&
    words.slice(1).every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && safeAssignment(word))
  );
}
function changesContext(
  node: TSNode,
  depth = 0,
  ignoredCommand?: number,
  restrictionOnly = false,
): boolean {
  if (node.type === "command" && node.startIndex === ignoredCommand) return false;
  if (depth > 128) return true;
  if (restrictionOnly && nonContextBuiltin(node)) return false;
  if (["declaration_command", "unset_command", "function_definition"].includes(node.type))
    return true;
  if (node.type === "variable_assignment" && !safeAssignment(node.text)) return true;
  if (node.type === "command") {
    const { head } = commandHead(node);
    if (!head || (contextHeads.has(head) && !(restrictionOnly && restrictionInvocation(node))))
      return true;
  }
  for (let i = 0; i < node.childCount; i++)
    if (changesContext(node.child(i)!, depth + 1, ignoredCommand, restrictionOnly)) return true;
  return false;
}
/** Add literal facts from every Git command, including nested/completed argv.
 * Never replace generic argv tokens or other commands/redirects with a proof. */
export function analyzeGitCommands(
  root: TSNode,
  normalizer: PathNormalizer,
  workdir?: string,
): {
  units: Map<number, NativeGitUnit>;
  ruleCandidates: BashPathRuleCandidate[];
  externalAccesses: BashExternalPath[];
} {
  const units = new Map<number, NativeGitUnit>(),
    ruleCandidates: BashPathRuleCandidate[] = [],
    externalAccesses: BashExternalPath[] = [];
  const platform = sep === "/" && normalizer.flavor.impl.sep === "/";
  let base = workdir,
    ignoredCd: number | undefined;
  // One literal leading cd with && can establish an alias base; HOME, CDPATH,
  // parent traversal and control-flow guesses never enter this small lane.
  const leading = /^\s*(cd[^\n;&|]*)&&/.exec(root.text);
  const cd = leading && literalWords(leading[1]!);
  if (
    platform &&
    cd?.[0] === "cd" &&
    cd.length === 2 &&
    !cd[1]!.startsWith("-") &&
    !cd[1]!.split("/").includes("..") &&
    (isAbsolute(cd[1]!) || cd[1] === "." || cd[1]!.startsWith("./") || !process.env.CDPATH) &&
    !/;|\|\||\n/.test(root.text)
  ) {
    try {
      base = physical(physical(normalizer.resolveBase(""), workdir), cd[1]);
      ignoredCd = root.startIndex + root.text.indexOf("cd");
    } catch {
      /* Unknown base remains ordinary permission. */
    }
  }
  const stable = !root.hasError && !changesContext(root, 0, ignoredCd);
  // Bounded non-context-mutating forms recover restriction aliases only;
  // automatic version eligibility deliberately keeps the original predicate.
  const knownBase = stable || (!root.hasError && !changesContext(root, 0, ignoredCd, true));
  const walk = (node: TSNode, nested: boolean, depth = 0): void => {
    if (depth > 128) return;
    if (node.type === "command") {
      const inv = restrictionInvocation(node),
        { head } = commandHead(node);
      if (inv || head === "git") {
        if (inv?.sub === "cat-file" && inv.args.some((arg) => arg.startsWith("--batch")))
          inv.dynamicBlobs.push(...batchPaths(node));
        const tails = ownedRedirectTails(node);
        const auto = platform && !nested && stable && tails.length === 0 && versionQuery(node.text);
        const diagnostic = !platform
          ? {
              code: "git-platform",
              reason: "Native path aliases are POSIX-only; ordinary permission facts remain.",
            }
          : tails.length
            ? {
                code: "git-redirect-argv",
                reason: "Completed Git argv adds restrictions only, never automatic permission.",
              }
            : {
                code: "git-literal-review",
                reason:
                  "Repository Git commands use normal Bash permission; only explicit literal paths and outputs are inventoried.",
              };
        units.set(node.startIndex, {
          text: node.text,
          auto,
          ...(auto ? {} : { diagnostic }),
          ...(inv
            ? { restrictions: inv.spellings, ...(tails.length ? { completed: inv.spellings } : {}) }
            : {}),
        });
        if (inv && platform) {
          const scope = restrictionsScope(inv, normalizer, base, knownBase);
          ruleCandidates.push(...scope.ruleCandidates);
          externalAccesses.push(...scope.externalAccesses);
        }
      }
      for (let i = 0; i < node.childCount; i++) walk(node.child(i)!, true, depth + 1);
      return;
    }
    const sequence = ["program", "list", "pipeline", "redirected_statement"].includes(node.type);
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!, nested || !sequence, depth + 1);
  };
  walk(root, false);
  return { units, ruleCandidates, externalAccesses };
}

/** Bounded literal read vocabulary, NOT an allowance. Unknown/mutating/output
 * argv retain upstream effects; actual redirects are collected independently. */
export function gitQueryEffect(source: string): TokenEffect | undefined {
  const words = gitQueryWords(source),
    inv = words && invocation(words);
  if (
    !inv ||
    !inv.rootSafe ||
    gitMutationProblem(inv.sub, inv.args) ||
    literalRestrictions(inv).outputs.length
  )
    return;
  const separator = inv.args.indexOf("--"),
    options = separator < 0 ? inv.args : inv.args.slice(0, separator);
  if (
    inv.sub === "status" &&
    options.every((arg) => gitStatusFlags.has(arg) || !arg.startsWith("-"))
  )
    return READ;
  if (
    inv.sub === "ls-files" &&
    options.every(
      (arg) =>
        [
          "--cached",
          "-c",
          "--stage",
          "-s",
          "-z",
          "--others",
          "-o",
          "--exclude-standard",
          "--full-name",
          "--deduplicate",
          "--deleted",
          "-d",
          "--modified",
          "-m",
          "--unmerged",
          "-u",
          "--error-unmatch",
        ].includes(arg) || !arg.startsWith("-"),
    )
  )
    return READ;
  if (
    inv.sub === "branch" &&
    options.every((arg) =>
      [
        "--show-current",
        "--list",
        "-l",
        "--all",
        "-a",
        "--remotes",
        "-r",
        "-v",
        "-vv",
        "--no-color",
      ].includes(arg),
    )
  )
    return READ;
  if (inv.sub === "remote" && inv.args.length === 0) return READ;
  if (["version", "--version"].includes(inv.sub) && inv.args.length === 0) return READ;
  if (
    inv.sub === "rev-parse" &&
    inv.args.every(
      (arg) =>
        [
          "--show-toplevel",
          "--show-prefix",
          "--show-cdup",
          "--git-dir",
          "--git-common-dir",
          "--is-inside-work-tree",
          "--is-bare-repository",
          "--short",
          "--verify",
          "--abbrev-ref",
          "--symbolic-full-name",
          "--end-of-options",
        ].includes(arg) || gitLogRevision(arg),
    )
  )
    return READ;
  if (
    inv.sub === "cat-file" &&
    options.length === 2 &&
    ["-p", "-t", "-s", "-e"].includes(options[0]!) &&
    !options[1]!.startsWith("-")
  )
    return READ;
  if (!["log", "show", "diff"].includes(inv.sub)) return;
  for (let i = 0; i < options.length; i++) {
    const arg = options[i]!;
    if (!arg.startsWith("-")) continue;
    const length = inv.sub !== "diff" ? gitHistoryOptionLength(options, i) : 0;
    if (length) {
      i += length - 1;
      continue;
    }
    if (
      [
        "--cached",
        "--staged",
        "--stat",
        "--numstat",
        "--shortstat",
        "--summary",
        "--name-only",
        "--name-status",
        "--check",
        "--exit-code",
        "--quiet",
        "-p",
        "--patch",
        "-s",
        "--no-patch",
        "--binary",
        "--full-index",
        "-z",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
      ].includes(arg) ||
      /^(?:-U|--unified=)\d{1,4}$/.test(arg)
    )
      continue;
    return;
  }
  return READ;
}
