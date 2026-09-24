/**
 * Argv-preserving Git invocation parse shared by the static guard and Luna.
 * Unknown globals stay on the human path; do not join words and re-lex them.
 */
import { basename } from "node:path";

const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS and the config-file
// selectors inject configuration exactly like -c/--config-env.
const GIT_CONFIG_ASSIGNMENT = /^GIT_CONFIG(?:_[A-Za-z0-9_]*)?=/;
const SIMPLE_WRAPPERS = new Set(["command", "builtin", "nohup"]);
// Proven direct diff bypasses the ask chain in the managed upstream pipeline.
// A diff/blame that still asks has no complete static read-scope proof.
const CHECKPOINT_SUBCOMMANDS = new Set(["diff", "blame", "show", "config", "push", "reset", "clean", "reflog", "branch", "tag"]);
const QUERY_SUBCOMMANDS = new Set(["status", "log", "show"]);

const GIT_GLOBALS_NONE = new Set([
  "-P",
  "-p",
  "--no-pager",
  "--paginate",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-advice",
  "--bare",
  "--help",
  "-h",
  "--version",
  "--html-path",
  "--man-path",
  "--info-path",
]);

const GIT_GLOBALS_REQUIRED_LONG = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--attr-source",
  "--config-env",
]);

export type GitInvocation = {
  subcommand: string | undefined;
  args: string[];
  unknownGlobals: boolean;
  configOverride: boolean;
  expansions: boolean;
  /** An operand-taking wrapper (env, timeout, nice, ...) precedes git. */
  wrapped: boolean;
};

function flagsFor(words: string[], expansions?: boolean[]): boolean[] {
  return words.map((_, index) => expansions?.[index] === true);
}

function take(words: string[], expansions: boolean[]): void {
  words.shift();
  expansions.shift();
}

/**
 * Strip keywords, assignments, and wrappers whose flags we can consume.
 * Returns undefined when a wrapper flag is unknown, matching the existing
 * operand-free wrapper boundary: those forms stay on the human path.
 * `wrapped` reports env/timeout/nice/stdbuf/ionice/time: upstream matches
 * those by the wrapper name, so a `git ...` grant never covers them.
 */
export function skipCommandPrefix(
  original: string[],
  originalExpansions?: boolean[],
): { words: string[]; expansions: boolean[]; wrapped: boolean; gitConfigEnvironment: boolean } | undefined {
  const words = [...original];
  const expansions = flagsFor(original, originalExpansions);
  let wrapped = false;
  let gitConfigEnvironment = false;
  while (KEYWORDS.has(words[0] ?? "")) take(words, expansions);
  while (words.length && ASSIGNMENT.test(words[0] ?? "")) {
    if (GIT_CONFIG_ASSIGNMENT.test(words[0])) gitConfigEnvironment = true;
    take(words, expansions);
  }

  for (;;) {
    const name = basename(words[0] ?? "");
    if (SIMPLE_WRAPPERS.has(name)) {
      take(words, expansions);
      if (words[0] === "--") take(words, expansions);
      if (words[0]?.startsWith("-")) return undefined;
      continue;
    }
    if (name === "exec") {
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (word === "-a" || word === "--argv0") {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (word.startsWith("-a") && word.length > 2) {
          take(words, expansions);
          continue;
        }
        if (word.startsWith("--argv0=")) {
          take(words, expansions);
          continue;
        }
        break;
      }
      if (words[0] === "--") take(words, expansions);
      if (words[0]?.startsWith("-")) return undefined;
      continue;
    }
    if (name === "env") {
      wrapped = true;
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (word === "--") {
          take(words, expansions);
          break;
        }
        if (["-i", "--ignore-environment", "-0", "--null"].includes(word)) {
          take(words, expansions);
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(word)) {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (
          (word.startsWith("-u") && word.length > 2) ||
          word.startsWith("--unset=") ||
          word.startsWith("--chdir=") ||
          word.startsWith("--split-string=") ||
          (word.startsWith("-C") && word.length > 2)
        ) {
          take(words, expansions);
          continue;
        }
        if (ASSIGNMENT.test(word)) {
          if (GIT_CONFIG_ASSIGNMENT.test(word)) gitConfigEnvironment = true;
          take(words, expansions);
          continue;
        }
        if (word.startsWith("-")) return undefined;
        break;
      }
      continue;
    }
    if (name === "timeout") {
      wrapped = true;
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (word === "--") {
          take(words, expansions);
          break;
        }
        if (["--preserve-status", "--foreground", "--verbose"].includes(word)) {
          take(words, expansions);
          continue;
        }
        if (["-s", "--signal", "-k", "--kill-after"].includes(word)) {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (word.startsWith("--signal=") || word.startsWith("--kill-after=") || /^-[sk]./.test(word)) {
          take(words, expansions);
          continue;
        }
        if (word.startsWith("-")) return undefined;
        break;
      }
      if (!words.length) return undefined;
      take(words, expansions);
      continue;
    }
    if (name === "nice") {
      wrapped = true;
      take(words, expansions);
      const word = words[0];
      if (word === "-n" || word === "--adjustment") {
        take(words, expansions);
        if (!words.length) return undefined;
        take(words, expansions);
      } else if (word?.startsWith("--adjustment=") || /^-(?:[0-9]+|n.+)$/.test(word ?? "")) {
        take(words, expansions);
      } else if (word?.startsWith("-") && word !== "--") return undefined;
      if (words[0] === "--") take(words, expansions);
      continue;
    }
    if (name === "stdbuf") {
      wrapped = true;
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (word === "--") {
          take(words, expansions);
          break;
        }
        if (["-i", "-o", "-e", "--input", "--output", "--error"].includes(word)) {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (
          /^-[ioe]./.test(word) ||
          word.startsWith("--input=") ||
          word.startsWith("--output=") ||
          word.startsWith("--error=")
        ) {
          take(words, expansions);
          continue;
        }
        if (word.startsWith("-")) return undefined;
        break;
      }
      continue;
    }
    if (name === "ionice") {
      wrapped = true;
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (word === "--") {
          take(words, expansions);
          break;
        }
        if (["-t", "--ignore"].includes(word)) {
          take(words, expansions);
          continue;
        }
        if (["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"].includes(word)) {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (
          /^-[cnpPu]./.test(word) ||
          word.startsWith("--class=") ||
          word.startsWith("--classdata=") ||
          word.startsWith("--pid=") ||
          word.startsWith("--pgid=") ||
          word.startsWith("--uid=")
        ) {
          take(words, expansions);
          continue;
        }
        if (word.startsWith("-")) return undefined;
        break;
      }
      continue;
    }
    if (name === "time") {
      wrapped = true;
      take(words, expansions);
      while (words.length) {
        const word = words[0];
        if (["-a", "--append", "-p", "--portability", "--verbose"].includes(word)) {
          take(words, expansions);
          continue;
        }
        if (["-f", "--format", "-o", "--output"].includes(word)) {
          take(words, expansions);
          if (!words.length) return undefined;
          take(words, expansions);
          continue;
        }
        if (word.startsWith("--format=") || word.startsWith("--output=") || /^-[fo]./.test(word)) {
          take(words, expansions);
          continue;
        }
        if (word === "--") {
          take(words, expansions);
          break;
        }
        if (word.startsWith("-")) return undefined;
        break;
      }
      continue;
    }
    break;
  }
  return { words, expansions, wrapped, gitConfigEnvironment };
}

function consumeGitGlobal(word: string, next: string | undefined): { tokens: number; config: boolean } | "unknown" {
  if (GIT_GLOBALS_NONE.has(word)) return { tokens: 1, config: false };
  if (word === "-C") return next !== undefined ? { tokens: 2, config: false } : "unknown";
  if (word.startsWith("-C") && word.length > 2) return { tokens: 1, config: false };
  if (word === "-c") return next !== undefined ? { tokens: 2, config: true } : "unknown";
  if (word.startsWith("-c") && word.length > 2) return { tokens: 1, config: true };
  if (word === "--exec-path" || word.startsWith("--exec-path=")) return { tokens: 1, config: false };
  const eq = word.indexOf("=");
  const head = eq === -1 ? word : word.slice(0, eq);
  if (GIT_GLOBALS_REQUIRED_LONG.has(head)) {
    if (eq !== -1) return { tokens: 1, config: head === "--config-env" };
    if (next !== undefined) return { tokens: 2, config: head === "--config-env" };
    return "unknown";
  }
  return "unknown";
}

export function parseGitInvocation(original: string[], originalExpansions?: boolean[]): GitInvocation | undefined {
  const skipped = skipCommandPrefix(original, originalExpansions);
  if (!skipped || basename(skipped.words[0] ?? "") !== "git") return undefined;
  const { words, expansions } = skipped;
  let index = 1;
  let unknownGlobals = false;
  let configOverride = skipped.gitConfigEnvironment;
  while (index < words.length) {
    const word = words[index];
    if (word === "--") {
      index += 1;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    const consumed = consumeGitGlobal(word, words[index + 1]);
    if (consumed === "unknown") {
      unknownGlobals = true;
      break;
    }
    if (consumed.config) configOverride = true;
    index += consumed.tokens;
  }
  let subcommand: string | undefined;
  let args: string[] = [];
  if (unknownGlobals) {
    const rest = words.slice(index);
    const names = rest.filter((word) => word && !word.startsWith("-"));
    subcommand =
      names.find((name) => QUERY_SUBCOMMANDS.has(name.toLowerCase()) || CHECKPOINT_SUBCOMMANDS.has(name.toLowerCase())) ??
      names[0];
    if (subcommand) {
      const at = rest.indexOf(subcommand);
      args = rest.slice(at + 1);
    }
  } else if (index < words.length) {
    subcommand = words[index];
    args = words.slice(index + 1);
  }
  return {
    subcommand,
    args,
    unknownGlobals,
    configOverride,
    expansions: expansions.some(Boolean),
    wrapped: skipped.wrapped,
  };
}

function mentionsSubcommand(invocation: GitInvocation, names: ReadonlySet<string>): boolean {
  return [invocation.subcommand, ...invocation.args].some((token) => token !== undefined && names.has(token.toLowerCase()));
}

/** status, log or show, whose output the static guard must prove metadata-only. */
export function isGitQuery(invocation: GitInvocation): boolean {
  return QUERY_SUBCOMMANDS.has(invocation.subcommand?.toLowerCase() ?? "");
}

/** An unknown global makes the subcommand position unreliable; any query word counts. */
export function unknownGlobalsMayHideQuery(invocation: GitInvocation): boolean {
  return invocation.unknownGlobals && mentionsSubcommand(invocation, QUERY_SUBCOMMANDS);
}

function hasForceFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--force" || /^-([A-Za-z]*f[A-Za-z]*)$/.test(arg));
}

function hasExtDiffOrOutput(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--ext-diff" ||
      arg === "--textconv" ||
      arg === "--output" ||
      arg.startsWith("--output="),
  );
}

/** Luna hard-checkpoint: remaining show, config, destructive Git, unknown globals. */
export function gitInvocationNeedsHuman(invocation: GitInvocation): boolean {
  const subcommand = invocation.subcommand?.toLowerCase();
  if (invocation.configOverride) return true;
  if (subcommand === "show" || subcommand === "config" || subcommand === "push") return true;
  if (subcommand === "reset" && invocation.args.includes("--hard")) return true;
  if (subcommand === "clean" && hasForceFlag(invocation.args)) return true;
  if (subcommand === "reflog" && ["delete", "expire"].includes((invocation.args[0] ?? "").toLowerCase())) return true;
  if (subcommand === "branch" && invocation.args.some((arg) => arg === "-D" || arg === "--delete")) return true;
  if (subcommand === "tag" && invocation.args.some((arg) => arg === "-d" || arg === "--delete")) return true;
  if ((subcommand === "diff" || subcommand === "log" || subcommand === "show") && hasExtDiffOrOutput(invocation.args)) {
    return true;
  }
  return invocation.unknownGlobals &&
    (mentionsSubcommand(invocation, QUERY_SUBCOMMANDS) || mentionsSubcommand(invocation, CHECKPOINT_SUBCOMMANDS));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex skip list generated from the same globals the argv parser knows, minus -c. */
export const GIT_GLOBAL_OPTIONS_PATTERN = (() => {
  const alternatives: string[] = [];
  for (const name of GIT_GLOBALS_NONE) alternatives.push(escapeRegExp(name));
  alternatives.push(String.raw`-C(?:\s+\S+|\S+)`);
  for (const name of GIT_GLOBALS_REQUIRED_LONG) {
    if (name === "--config-env") continue;
    alternatives.push(`${escapeRegExp(name)}(?:=\\S+|\\s+\\S+)`);
  }
  alternatives.push(String.raw`--exec-path(?:=\S+)?`);
  return `(?:(?:\\s+(?:${alternatives.join("|")})))*`;
})();
