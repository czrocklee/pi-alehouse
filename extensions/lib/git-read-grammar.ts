/**
 * Shared literal Git read grammar, not an authorization or repository proof.
 * Keep this module import-free: the managed authority copies it unchanged.
 * Callers own shell decoding, revision/path boundaries and execution hardening.
 * Inherited Git configuration/environment is outside this grammar's guarantee.
 */

export const gitStatusFlags: ReadonlySet<string> = new Set([
  "-s", "-b", "-sb", "-bs", "-z", "-uno", "-unormal", "-uall", "--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2",
  "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all",
  "--ignored", "--ignored=matching", "--ignored=traditional", "--ignore-submodules=all",
]);

const historyFlags: ReadonlySet<string> = new Set([
  "--oneline", "--no-decorate", "--decorate", "--decorate=short", "--decorate=full",
  "--no-walk", "--no-patch", "-s", "--not", "--graph", "--topo-order", "--date-order", "--reverse",
  "--no-show-signature", "--no-ext-diff", "--no-textconv",
]);
const prettyBuiltins: ReadonlySet<string> = new Set([
  "medium", "short", "full", "fuller", "raw", "oneline", "reference",
]);
const prettyTokens: ReadonlySet<string> = new Set([
  "H", "h", "T", "t", "P", "p", "an", "ae", "ad", "aD", "ar", "at", "ai", "aI",
  "cn", "ce", "cd", "cr", "ct", "ci", "cI", "s", "f", "b", "B", "N", "D", "n", "%",
  // Actual reflog placeholders, not the plan's nonexistent %g? wildcard.
  "gD", "gd", "gn", "ge", "gs",
]);
const dateBuiltins: ReadonlySet<string> = new Set([
  "iso", "iso-local", "iso-strict", "iso8601", "iso8601-local", "rfc", "short", "raw",
  "relative", "default", "human", "unix",
]);
// No modifiers, widths, locale extensions, newline/tab directives or arbitrary
// percent escapes. Both the template length and literal alphabet are bounded.
const strftimeTokens: ReadonlySet<string> = new Set([
  "Y", "y", "m", "d", "e", "H", "I", "M", "S", "p", "z", "Z", "a", "A", "b", "B",
  "j", "u", "w", "U", "W", "V", "G", "g", "s", "F", "T", "R", "D", "%",
]);
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const countValue = (value: string) => !controls.test(value) && /^[1-9]\d{0,2}$/.test(value);

/** First unsafe pretty token/reason; undefined means an accepted value. */
export function gitPrettyProblem(value: string): string | undefined {
  if (controls.test(value)) return "pretty value contains a literal control character or line break";
  if (prettyBuiltins.has(value)) return;
  const explicit = value.startsWith("format:") || value.startsWith("tformat:");
  if (!explicit && !value.includes("%")) return `unknown named pretty format ${JSON.stringify(value)}`;
  const template = explicit ? value.slice(value.indexOf(":") + 1) : value;
  for (let i = 0; i < template.length; i += 1) {
    if (template[i] !== "%") continue;
    const pair = template.slice(i + 1, i + 3);
    if (pair.length === 2 && prettyTokens.has(pair)) { i += 2; continue; }
    const token = template[i + 1];
    if (token !== undefined && prettyTokens.has(token)) { i += 1; continue; }
    if (token === undefined) return "incomplete pretty placeholder %";
    const spelling = JSON.stringify(template.slice(i, i + (token === "G" || token === "g" ? 3 : 2)));
    if (token === "G") return `pretty placeholder ${spelling} requests signature verification`;
    if (token === "x") {
      // Output bytes are not reparsed as placeholders. Permit ordinary text
      // separators, not arbitrary controls/terminal escapes or an incomplete
      // escape. In particular %x09 supports customary hash<TAB>subject output.
      const hex = template.slice(i + 2, i + 4);
      const byte = /^[0-9a-fA-F]{2}$/.test(hex) ? Number.parseInt(hex, 16) : -1;
      if (byte === 9 || byte === 10 || (byte >= 32 && byte <= 126)) { i += 3; continue; }
      return `pretty placeholder ${spelling} is an unsafe or incomplete byte escape`;
    }
    if (token === "C") return `pretty placeholder ${spelling} controls color`;
    if ("<>|".includes(token)) return `pretty placeholder ${spelling} controls width/alignment`;
    if (token === "(") return `pretty placeholder ${spelling} uses unsupported trailers/function syntax`;
    return `unsupported pretty placeholder ${spelling}`;
  }
}

export function gitPrettyValue(value: string): boolean {
  return gitPrettyProblem(value) === undefined;
}

/** Signature demand only, not the older strict pretty-format whitelist. */
export function gitPrettySignatureRequested(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "%") continue;
    const token = value[++i];
    if (token === "%") continue; // %%G? is literal output, not verification.
    if (token === "x" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) { i += 2; continue; }
    // Git's conditional whitespace modifiers still consume a real placeholder.
    const actual = token !== undefined && "+- ".includes(token) ? value[++i] : token;
    if (actual === "G") return true;
  }
  return false;
}

/** First unsafe date token/reason; undefined means an accepted value. */
export function gitDateProblem(value: string): string | undefined {
  if (controls.test(value)) return "date value contains a literal control character or line break";
  if (dateBuiltins.has(value)) return;
  const prefix = value.startsWith("format-local:") ? "format-local:" : value.startsWith("format:") ? "format:" : undefined;
  if (prefix === undefined) return `unsupported date mode ${JSON.stringify(value)}`;
  const template = value.slice(prefix.length);
  if (template.length === 0 || template.length > 256) return "strftime template must contain 1..256 characters";
  for (let i = 0; i < template.length; i += 1) {
    const char = template.charAt(i);
    if (char !== "%") {
      if (!/[A-Za-z0-9_ /:.,+()\-]/.test(char)) return `unsupported strftime literal ${JSON.stringify(char)}`;
      continue;
    }
    const token = template[++i];
    if (token === undefined) return "incomplete strftime directive %";
    if (!strftimeTokens.has(token)) return `unsupported strftime directive ${JSON.stringify(`%${token}`)}`;
  }
}

export function gitDateValue(value: string): boolean {
  return gitDateProblem(value) === undefined;
}

type HistoryOption = { length: number; problem?: string };

function historyOption(args: readonly string[], index: number): HistoryOption {
  const arg = args[index];
  if (arg === undefined) return { length: 0, problem: "missing history option" };
  if (controls.test(arg)) return { length: 0, problem: "history option contains a literal control character or line break" };
  if (historyFlags.has(arg) || /^-[1-9]\d{0,2}$/.test(arg) || /^(?:-n|--max-count=)[1-9]\d{0,2}$/.test(arg)) return { length: 1 };
  if (arg === "-n" || arg === "--max-count") {
    return countValue(args[index + 1] ?? "") ? { length: 2 } : { length: 0, problem: `${arg} requires a count in 1..999` };
  }
  // Require attached values. A bare optional --pretty/--format must not hide
  // a following revision from the caller's commit/path constraints.
  for (const [name, validate] of [["--format", gitPrettyProblem], ["--pretty", gitPrettyProblem], ["--date", gitDateProblem]] as const) {
    if (arg === name) return { length: 0, problem: `${name} requires an attached literal value (${name}=...)` };
    if (!arg.startsWith(`${name}=`)) continue;
    const problem = validate(arg.slice(name.length + 1));
    return problem === undefined ? { length: 1 } : { length: 0, problem: `${name}: ${problem}` };
  }
  return { length: 0, problem: `unsupported history option ${JSON.stringify(arg)}` };
}

/** Safe option's argv length (including its operand); zero is unrecognized. */
export function gitHistoryOptionLength(args: readonly string[], index: number): number {
  return historyOption(args, index).length;
}

/** Diagnostic companion; never grants permission or changes option recognition. */
export function gitHistoryOptionProblem(args: readonly string[], index: number): string | undefined {
  return historyOption(args, index).problem;
}

/** Log revision spelling, including ranges and a single exclusion prefix ^. */
export function gitLogRevision(word: string): boolean {
  return !controls.test(word) && /^\^?[A-Za-z0-9_@][A-Za-z0-9_./~^@{}+\-]*$/.test(word);
}

/**
 * Strict diff revision atom; callers split ranges themselves. A bare ancestry
 * step (`X^`, `X~`, `X^^`) is Git's spelling of `X^1`/`X~1`; peel, reflog and
 * shorthand suffixes (`^{}`, `@{}`, `^!`, `^@`, `^-`) remain unsupported.
 */
export function gitDiffRevision(word: string): boolean {
  return !controls.test(word) && /^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]*)*$/.test(word) && !word.includes("..");
}

/** Literal path spelling, after shell decoding; not a path permission. */
export function gitPathWord(word: string): boolean {
  return word.length > 0 && word === word.trim() && !controls.test(word) &&
    !/[$`*?\[\]{}\\:]/.test(word) && !word.startsWith("-") &&
    !word.startsWith("/") && !word.startsWith("~") && !word.startsWith("@") && !word.split("/").includes("..");
}

const historyRequiredData: ReadonlySet<string> = new Set([
  "--grep", "--author", "--committer", "--since", "--until", "--after", "--before", "--date", "-n", "--max-count",
]);
const listingRequiredData: ReadonlySet<string> = new Set(["--format", "--sort", "--points-at"]);

/**
 * Curated argv roles, NOT query acceptance or a complete Git CLI parser.
 * Required data can itself spell `--`, `--output=...` or a mutation flag;
 * optional pretty/color/column arguments must NOT consume the next word.
 */
export function gitRequiredOperandRole(sub: string, option: string): "data" | "output" | undefined {
  if (["archive", "diff-tree"].includes(sub) && option === "--output") return "output";
  if (sub === "archive" && ["--prefix", "--format", "--remote", "--exec", "--add-virtual-file"].includes(option)) return "data";
  if (["log", "show", "diff"].includes(sub)) {
    if (option === "--output") return "output";
    if (["-S", "-G", "--find-object"].includes(option)) return "data";
  }
  if (["log", "show"].includes(sub) && historyRequiredData.has(option)) return "data";
  if (["branch", "tag"].includes(sub) && listingRequiredData.has(option)) return "data";
}

/**
 * Effect inventory only: a known mutation must never get a managed read grant.
 * This function is NOT a child refusal or an authorizer. Known writes and
 * unknown verbs/options both use normal Bash permission and configured denies.
 */
export function gitMutationProblem(sub: string, args: readonly string[]): string | undefined {
  const verbs = new Set([
    "add", "am", "apply", "bisect", "checkout", "cherry-pick", "clean", "clone", "commit", "config",
    "fetch", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch",
    "update-ref", "update-index", "read-tree", "write-tree", "commit-tree",
    "mktag", "mktree", "pack-refs", "pack-objects", "unpack-objects", "index-pack", "repack", "prune",
    "gc", "maintenance", "init", "fast-import", "filter-branch",
  ]);
  if (verbs.has(sub)) return `Git ${sub} is a mutation/configuration operation, not a managed read.`;
  const before = args.indexOf("--");
  const options = before < 0 ? args : args.slice(0, before);
  const mutatingLong = (names: readonly string[]) => options.some(arg => {
    const option = arg.split("=", 1)[0] ?? "";
    return option.startsWith("--") && option.length > 2 && names.some(name => name.startsWith(option));
  });
  if (sub === "branch" || sub === "tag") {
    // Exclude known listing-option DATA before both flag and creation checks.
    // Otherwise e.g. --format '-D' fabricates a mutation, while a format value
    // '--list' could incorrectly hide an actual following creation operand.
    const listingWords: string[] = [];
    let listingEnd = -1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === "--") { listingEnd = i; break; }
      listingWords.push(arg);
      if (gitRequiredOperandRole(sub, arg) === "data") i++;
    }
    const branch = sub === "branch";
    const mutationLong = branch
      ? ["--delete", "--move", "--copy", "--force", "--create-reflog", "--edit-description", "--set-upstream", "--set-upstream-to", "--unset-upstream"]
      : ["--delete", "--force", "--annotate", "--sign", "--local-user", "--message", "--file", "--edit", "--create-reflog"];
    const mutationShort = branch ? /[dDmMcCf]/ : /[adfsmuFe]/;
    for (const arg of listingWords) {
      const option = arg.split("=", 1)[0] ?? "";
      if ((option.startsWith("--") && option.length > 2 && mutationLong.some(name => name.startsWith(option))) ||
          (/^-[^-]/.test(arg) && mutationShort.test(arg.slice(1))))
        return `Git ${sub} mutation flags are not a managed read.`;
    }
    const listing = listingWords.some(arg => ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(arg) || /^(?:--(?:contains|no-contains|merged|no-merged|points-at))=/.test(arg));
    // Tag verification is a helper-bearing read, not ref creation. It still
    // needs ordinary approval; real mutation flags above always win.
    const verifyingTag = !branch && listingWords.some(arg => arg === "-v" || arg === "--verify");
    // A positional outside listing/verification creates a ref; branch -v is
    // merely display verbosity and does not make branch creation a read.
    if (!listing && !verifyingTag && (listingWords.some(arg => !arg.startsWith("-")) || (listingEnd >= 0 && listingEnd < args.length - 1)))
      return `Git ${sub} creation is not a managed read; listing patterns need an explicit listing mode.`;
  }
  if (sub === "hash-object" && options.some(arg => /^-[^-]*w/.test(arg)))
    return "Git object writes are not a managed read.";
  if (sub === "symbolic-ref" && (mutatingLong(["--delete"]) || options.includes("-d") || options.filter(arg => !arg.startsWith("-")).length > 1))
    return "Git symbolic-ref modification is not a managed read.";
  if (sub === "notes" && args.some(arg => ["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(arg)))
    return "Git notes modification is not a managed read.";
  if (sub === "replace" && (mutatingLong(["--delete", "--edit", "--graft", "--convert-graft-file", "--force"]) || options.some(arg => /^-[^-]*[defg]/.test(arg)) || options.filter(arg => !arg.startsWith("-")).length > 1))
    return "Git replacement-ref modification is not a managed read.";
  if (sub === "remote" && args.some(arg => ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "update", "prune"].includes(arg)))
    return "Git remote modification/network operations are not a managed read.";
  if (sub === "reflog" && args.some(arg => ["delete", "expire", "drop", "write"].includes(arg)))
    return "Git reflog modification is not a managed read.";
  if (sub === "submodule" && args.some(arg => ["add", "update", "init", "deinit", "sync", "set-branch", "set-url", "absorbgitdirs", "foreach"].includes(arg)))
    return "Git submodule modification/execution is not a managed read.";
  if (sub === "worktree" && args.some(arg => ["add", "lock", "move", "prune", "remove", "unlock", "repair"].includes(arg)))
    return "Git worktree modification is not a managed read.";
}
