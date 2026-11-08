// Deny-only literal privilege execution proof. AST command enumeration supplies
// the actual execution units; interpreter source and display-only executedUnit
// are never authority. No permission verdict is cached here.
import { basename } from "node:path";
import { skipCommandPrefix } from "./git-invocation.ts";
import { wildcardMatch } from "#src/policy/wildcard-matcher.ts";

const PRIVILEGE_NAMES = new Set(["sudo", "doas", "su"]);
const NON_COMMAND_PREFIX = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
]);
const MAX_PREFIX_WORDS = 256;

/** Policy presence only, never a verdict. Unknown pattern heads need inspection. */
export function privilegePatternMayMatch(pattern: string): boolean {
  const head = pattern.replace(/^[ \t\n]+/, "").split(/[ \t\n]/, 1)[0] ?? "";
  // Quoted/escaped whitespace in a configured executable pattern is uncommon
  // and not safely represented by the split; conservatively inspect it.
  if (/["'\\]/.test(head) && pattern.slice(head.length).replace(/[ \t\n]/g, "")) return true;
  const executable = basename(head.replace(/["'\\]/g, ""));
  return [...PRIVILEGE_NAMES].some((name) => wildcardMatch(executable, name));
}

/** Decode one literal prefix word, retaining its exact source boundaries. */
function literalWord(source: string, start: number): { value: string; end: number } | undefined {
  let value = "";
  let quote = "";
  let started = false;
  let i = start;
  for (; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      else value += char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined) return;
      if (next === "\n") continue;
      if (quote === '"' && !'\\$`"'.includes(next)) value += "\\";
      value += next;
      started = true;
      continue;
    }
    if (char === "$" || char === "`") return;
    if (quote === '"') {
      if (char === '"') quote = "";
      else value += char;
      started = true;
      continue;
    }
    if (/[ \t\n]/.test(char) || /[;&|()<>]/.test(char)) break;
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else {
      // Expanding executable/option words are not literal proof. Quoted
      // wildcard and brace characters above remain ordinary filename bytes.
      if (/[*?\[\]{}]/.test(char) || (char === "~" && !started)) return;
      if (char === "#" && !started) return;
      value += char;
      started = true;
    }
  }
  return started && !quote ? { value, end: i } : undefined;
}

/**
 * Raw inner invocation, decoded full executable and basename-canonical invocation.
 * Arguments retain their original quoting and expansion spelling: only the
 * literal executable is normalized. All aliases must be evaluated together
 * against the FULL ordered global rules so same-scope exceptions keep winning.
 */
export function privilegeCommandAliases(source: string): string[] | undefined {
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (let count = 0; count < MAX_PREFIX_WORDS; count++) {
    while (/[ \t\n]/.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    const start = cursor;
    const word = literalWord(source, start);
    if (!word) return;
    // Actual AST units have already stripped syntactic assignments. A quoted
    // "X=1" or "if" is an executable, not shell syntax to skip. Cold direct
    // checks conservatively leave assignment prefixes to AST enumeration too.
    if (
      !words.length &&
      (NON_COMMAND_PREFIX.has(word.value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value))
    )
      return;
    words.push(word.value);
    starts.push(start);
    ends.push(word.end);
    // `builtin sudo` cannot execute external sudo. Make builtin opaque to
    // the generic prefix parser, at its actual executable position only.
    // Option DATA named builtin (env -u builtin / exec -a builtin) is still
    // consumed by that parser's existing argv-role knowledge, not scanned as
    // a wrapper. Unsupported builtin continuations retain ordinary policy.
    const skipped = skipCommandPrefix(
      words.map((value) => (basename(value) === "builtin" ? "<opaque-builtin>" : value)),
    );
    const name = skipped && basename(skipped.words[0] ?? "");
    if (name && PRIVILEGE_NAMES.has(name)) {
      const index = words.length - skipped!.words.length;
      const inner = source.slice(starts[index]);
      const tail = source.slice(ends[index]).replace(/^[ \t\n]+/, "");
      const argumentsSource = tail ? " " + tail : "";
      const decoded = words[index] + argumentsSource;
      const canonical = name + argumentsSource;
      // A wrapper's own allow is NOT an exception for the privilege command.
      return [...new Set([inner, decoded, canonical])];
    }
    cursor = word.end;
    if (cursor >= source.length || !/[ \t\n]/.test(source[cursor])) return;
  }
  return;
}

export function literalPrivilegeCommand(source: string): string | undefined {
  return privilegeCommandAliases(source)?.at(-1);
}

/**
 * Direct-manager/cold-fallback proof of one simple command (not a full program).
 * Dynamic argument variables are fine; nested executions and shell structure
 * require AST inspection. Quotes and escaped data punctuation stay literal.
 */
export function simplePrivilegeSource(source: string): boolean {
  const start = source.search(/[^ \t\n]/);
  const head = start < 0 ? undefined : literalWord(source, start);
  // Assignment/negation/reserved prefixes need the AST's syntactic role,
  // unlike an env wrapper's own assignment argv. Never infer an executable
  // position by dropping a decoded quoted assignment or reserved word.
  if (head && (NON_COMMAND_PREFIX.has(head.value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head.value)))
    return false;
  let quote = "";
  let started = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\\") {
      if (++i >= source.length) return false;
      continue;
    }
    if (char === "`" || (char === "$" && source[i + 1] === "(")) return false;
    if (quote === '"') {
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[;&|()<>]/.test(char) || (char === "#" && !started)) return false;
    else if (char === "\n" && source.slice(i).replace(/[ \t\n]/g, "")) return false;
    else if (/[ \t\n]/.test(char)) started = false;
    else started = true;
  }
  return !quote;
}
