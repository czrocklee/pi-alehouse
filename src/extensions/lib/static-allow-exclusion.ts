/**
 * Shell shapes a static Bash allow cannot prove safe. Pure lexical analysis of
 * the ORIGINAL model command (captured before any managed hardening); not an
 * extension, cache or permission grant.
 *
 * These predicates were the static guard's "use an env wrapper" refusals, moved
 * here unchanged in semantics. A hit no longer blocks the call: the authority
 * resolves the whole program as if no allow rule (configured or session) were
 * present, so the call reaches ordinary approval (Jev or a human) and yolo still
 * satisfies it, while denies and the invalid-config floor keep holding. The
 * model never has to respell a command to get the same decision.
 *
 * Only the allow source changed: the guard read global static allows, while the
 * authority now supplies its real resolver (every config scope and session
 * grants), so project/agent-scope allows and session grants are covered too.
 */
import { basename } from "node:path";
import { parseGitInvocation } from "./git-invocation.ts";
import {
  analyzeLiteralCommands,
  canonicalWords,
  literalCommands,
  type LiteralInput,
} from "./shell-literal.ts";

export const STATIC_ALLOW_EXCLUSION_RULES = [
  "dynamic-operand",
  "indirect-file-list",
  "output-utility",
  "ripgrep",
  "expanding-heredoc",
  "inline-environment",
  "unverified-original",
] as const;
export type StaticAllowExclusionRule = (typeof STATIC_ALLOW_EXCLUSION_RULES)[number];

/** Why the program's allows were excluded: evidence only, never a grant. */
export interface StaticAllowExclusion {
  readonly rule: StaticAllowExclusionRule;
  /** The unit (decoded words) that triggered the exclusion. */
  readonly unitText: string;
  /** The word inside that unit, or "" when the whole unit is the reason. */
  readonly word: string;
}

/** Whether a canonical command value is covered by an allow rule. */
export type AllowMatcher = (canonicalValue: string) => boolean;

export const STATIC_ALLOW_EXCLUSION_TEXT_LIMIT = 512;
/**
 * Largest requested command forwarded for a serving node to re-evaluate. A
 * longer one cannot be re-evaluated there, so it counts as unverified.
 */
export const STATIC_ALLOW_REQUEST_LIMIT = 1024 * 1024;

const cap = (text: string) =>
  text.length > STATIC_ALLOW_EXCLUSION_TEXT_LIMIT
    ? text.slice(0, STATIC_ALLOW_EXCLUSION_TEXT_LIMIT - 1) + "…"
    : text;
const hit = (
  rule: StaticAllowExclusionRule,
  unit: string[] | string,
  word = "",
): StaticAllowExclusion => ({
  rule,
  unitText: cap(Array.isArray(unit) ? unit.join(" ") : unit),
  word: cap(word),
});

/** The fail-closed fact used when the original command cannot be verified. */
export const UNVERIFIED_ORIGINAL: StaticAllowExclusion = Object.freeze({
  rule: "unverified-original",
  unitText: "",
  word: "",
});

/** Strict wire validation: a present but malformed fact must be refused. */
export function isStaticAllowExclusion(value: unknown): value is StaticAllowExclusion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  const keys = Object.keys(fact).sort();
  return (
    keys.length === 3 &&
    keys[0] === "rule" &&
    keys[1] === "unitText" &&
    keys[2] === "word" &&
    (STATIC_ALLOW_EXCLUSION_RULES as readonly unknown[]).includes(fact.rule) &&
    typeof fact.unitText === "string" &&
    typeof fact.word === "string" &&
    fact.unitText.length <= STATIC_ALLOW_EXCLUSION_TEXT_LIMIT &&
    fact.word.length <= STATIC_ALLOW_EXCLUSION_TEXT_LIMIT
  );
}

/** One-line prompt/audit rendering of a fact. */
export function describeStaticAllowExclusion(fact: StaticAllowExclusion): string {
  const reason: Record<StaticAllowExclusionRule, string> = {
    "dynamic-operand": "operand is expanded by the shell, so path rules cannot see it",
    "indirect-file-list": "reads a list of file names from another file",
    "output-utility": "printf/sha256sum form outside the literal static form",
    ripgrep: "rg form outside the literal, non-recursive static form",
    "expanding-heredoc": "an expanding heredoc feeds an allowed command",
    "inline-environment": "inline environment assignment before an allowed command",
    "unverified-original": "the original command could not be verified",
  };
  const where = fact.unitText ? ` in \`${fact.unitText}\`` : "";
  const word = fact.word ? ` (${JSON.stringify(fact.word)})` : "";
  return `${reason[fact.rule]}${where}${word}`;
}

const DYNAMIC = /[$*?\[\]{}~`]/;
const dynamic = (word: string) => DYNAMIC.test(word.replace(/^~\//, ""));

// The upstream path gate sees lexical paths, not shell-expanded filenames.
// Conservative even for quoted metacharacters.
function indirectReaderInput(
  command: LiteralInput,
  isAllowed: AllowMatcher,
): StaticAllowExclusion | undefined {
  const reader = (words: string[]) =>
    canonicalWords(words).some((value) =>
      /^(head|wc|cat|tail|cut|nl|sha256sum|readlink)( |$)/.test(value),
    );
  let found: StaticAllowExclusion | undefined;
  const commands = literalCommands(command, undefined, (word, owner) => {
    if (!found && dynamic(word) && canonicalWords(owner).some(isAllowed))
      found = hit("dynamic-operand", owner, word);
  });
  if (found) return found;
  for (const words of commands ?? []) {
    if (!reader(words)) continue;
    const expanded = words.find(dynamic);
    if (expanded !== undefined) return hit("dynamic-operand", words, expanded);
    // wc follows every filename in this file (or stdin), bypassing the path
    // gate. GNU getopt also accepts unambiguous prefixes such as --f=names.
    if (canonicalWords(words).some((value) => value.startsWith("wc "))) {
      const list = words.find((word) => {
        const option = word.split("=", 1)[0];
        return option.startsWith("--") && option.length > 2 && "--files0-from".startsWith(option);
      });
      if (list !== undefined) return hit("indirect-file-list", words, list);
    }
  }
  return undefined;
}

// Keep printf away from shell-variable assignment (-v / %n), and checksums
// away from indirect filename lists (--check, including getopt abbreviations).
function unsafeOutputUtility(command: LiteralInput): StaticAllowExclusion | undefined {
  let found: StaticAllowExclusion | undefined;
  literalCommands(command, undefined, undefined, (words, expansions) => {
    if (found) return;
    const values = canonicalWords(words);
    const name = ["printf", "sha256sum"].find((name) =>
      values.some((value) => value === name || value.startsWith(`${name} `)),
    );
    if (!name) return;
    const start = words.findIndex((word) => basename(word) === name);
    const args = words.slice(start + 1);
    const expanded = expansions.slice(start + 1);
    if (name === "printf") {
      const index = args[0] === "--" ? 1 : 0;
      const format = args[index];
      if (
        format === undefined ||
        expanded[index] ||
        (index === 0 && format.startsWith("-")) ||
        format.replace(/%(?:s|%)/g, "").includes("%")
      )
        found = hit("output-utility", words, format ?? "");
      return;
    }
    let operands = false;
    for (const arg of args) {
      if (operands || arg === "-" || !arg.startsWith("-")) continue;
      if (arg === "--") {
        operands = true;
        continue;
      }
      if (
        ["--binary", "--text", "--tag", "--zero", "--help", "--version"].includes(arg) ||
        /^-[btz]+$/.test(arg)
      )
        continue;
      found = hit("output-utility", words, arg);
      return;
    }
  });
  return found;
}

const RG_FLAGS = new Set([
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-s",
  "--case-sensitive",
  "-S",
  "--smart-case",
  "-F",
  "--fixed-strings",
  "-w",
  "--word-regexp",
  "-x",
  "--line-regexp",
  "-v",
  "--invert-match",
  "-l",
  "--files-with-matches",
  "-c",
  "--count",
  "--count-matches",
  "-o",
  "--only-matching",
  "-q",
  "--quiet",
  "-H",
  "--with-filename",
  "-h",
  "--no-filename",
  "--hidden",
  "--no-heading",
  "--heading",
  "--null",
  "-0",
]);

// The static rg form deliberately uses an option terminator. Quoted regex
// metacharacters are data, whereas expanded operands evade upstream path gates.
function unsafeRipgrep(command: LiteralInput): StaticAllowExclusion | undefined {
  let found: StaticAllowExclusion | undefined;
  literalCommands(
    command,
    undefined,
    (word, owner) => {
      if (!found && basename(owner[0] ?? "") === "rg" && dynamic(word))
        found = hit("ripgrep", owner, word);
    },
    (words, expansions) => {
      if (found) return;
      if (!canonicalWords(words).some((value) => value.startsWith("rg --no-config "))) return;
      const unit = words;
      words = words.slice(words.findIndex((word) => basename(word) === "rg"));
      const refuse = (word = "") => {
        found = hit("ripgrep", unit, word);
      };
      if (expansions.some(Boolean)) return refuse();
      let files = false;
      let depthZero = false;
      let i = 2;
      while (i < words.length && words[i] !== "--") {
        const flag = words[i++]!;
        if (flag === "--files") {
          files = true;
          continue;
        }
        if (["-d", "--max-depth"].includes(flag) && words[i] === "0") {
          depthZero = true;
          i += 1;
          continue;
        }
        if (RG_FLAGS.has(flag)) continue;
        if (
          ["-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not"].includes(flag) &&
          i < words.length
        ) {
          i += 1;
          continue;
        }
        if (
          [
            "-m",
            "--max-count",
            "-A",
            "--after-context",
            "-B",
            "--before-context",
            "-C",
            "--context",
          ].includes(flag) &&
          /^\d+$/.test(words[i] ?? "")
        ) {
          i += 1;
          continue;
        }
        return refuse(flag);
      }
      if (words[i++] !== "--") return refuse();
      if (!files && words[i++] === undefined) return refuse();
      const paths = words.slice(i);
      // Upstream treats the first --files operand as a regex and misses its
      // external-directory gate. Keep listing rooted at the current directory.
      if (files) {
        if (paths.length > 1 || (paths.length === 1 && paths[0] !== ".")) refuse(paths[0]);
        return;
      }
      const bad = paths.find((path) => !path || dynamic(path));
      if (!paths.length || bad !== undefined) return refuse(bad ?? "");
      // Depth zero prevents reading directory descendants even after cd, or if
      // a file changes into a directory between validation and execution.
      if (!depthZero && paths.some((path) => path !== "-")) refuse(paths[0]);
    },
  );
  return found;
}

function expandingHeredocFeedsAllow(
  command: LiteralInput,
  isAllowed: AllowMatcher,
): StaticAllowExclusion | undefined {
  let found: StaticAllowExclusion | undefined;
  literalCommands(command, (owner) => {
    if (!found && canonicalWords(owner).some(isAllowed))
      found = hit("expanding-heredoc", owner, "<<");
  });
  return found;
}

function inlineEnvironmentBeforeAllow(
  command: LiteralInput,
  isAllowed: AllowMatcher,
): StaticAllowExclusion | undefined {
  for (const original of literalCommands(command) ?? []) {
    const words = [...original];
    while (["if", "then", "else", "elif", "while", "until", "do", "!", "{"].includes(words[0]!))
      words.shift();
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) continue;
    // Git keeps ordinary approval for benign assignments, with a hard human
    // checkpoint on eligible asks. Selected dangerous prefixes are refused by
    // the static guard regardless of any permission grant.
    if (parseGitInvocation(original)) continue;
    // Upstream strips these assignments before matching allows. Unknown
    // variables are not evidence that an allowance stays safe.
    if (
      canonicalWords(words).some(
        (value) => /^git (?:status|diff|log|show|ls-files)(?: |$)/.test(value) || isAllowed(value),
      )
    )
      return hit("inline-environment", original, words[0]!);
  }
  return undefined;
}

/**
 * The first shape that keeps an allow rule from covering this program, or
 * undefined. Analysis failure is itself a reason: it never proves safety.
 */
export function staticAllowExclusion(
  source: string,
  isAllowed: AllowMatcher,
): StaticAllowExclusion | undefined {
  try {
    const command = analyzeLiteralCommands(source);
    return (
      unsafeOutputUtility(command) ??
      unsafeRipgrep(command) ??
      indirectReaderInput(command, isAllowed) ??
      expandingHeredocFeedsAllow(command, isAllowed) ??
      inlineEnvironmentBeforeAllow(command, isAllowed)
    );
  } catch {
    return UNVERIFIED_ORIGINAL;
  }
}
