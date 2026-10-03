/**
 * Shared literal Git read grammar, not an authorization or repository proof.
 * Keep this module import-free: the managed authority copies it unchanged.
 * Callers own shell decoding, revision/path boundaries and execution hardening.
 * Inherited Git configuration/environment is outside this grammar's guarantee.
 */

export const gitStatusFlags: ReadonlySet<string> = new Set([
  "-s", "-b", "--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2",
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
  "cn", "ce", "cd", "cr", "ct", "ci", "cI", "s", "f", "b", "N", "D", "n", "%",
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
    if (token === "x") return `pretty placeholder ${spelling} is a byte escape`;
    if (token === "C") return `pretty placeholder ${spelling} controls color`;
    if ("<>|".includes(token)) return `pretty placeholder ${spelling} controls width/alignment`;
    if (token === "(") return `pretty placeholder ${spelling} uses unsupported trailers/function syntax`;
    return `unsupported pretty placeholder ${spelling}`;
  }
}

export function gitPrettyValue(value: string): boolean {
  return gitPrettyProblem(value) === undefined;
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

/** Existing strict diff revision atom; callers split ranges themselves. */
export function gitDiffRevision(word: string): boolean {
  return !controls.test(word) && /^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]+)*$/.test(word) && !word.includes("..");
}

/** Existing literal path spelling; not a path permission or existence check. */
export function gitPathWord(word: string): boolean {
  return word === word.trim() && /^(?:\.\/)?[A-Za-z0-9_.-][A-Za-z0-9_./ -]*$/.test(word) && !word.startsWith("-") && !word.split("/").includes("..");
}
