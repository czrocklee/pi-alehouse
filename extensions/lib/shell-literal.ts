/**
 * Pure lexical shell-word analysis shared by the static guard and hard
 * checkpoints. Not an extension, policy cache, or permission grant. Hard
 * checkpoints import this leaf instead of the guard module.
 */
import { basename } from "node:path";
import { parseGitInvocation, type GitInvocation } from "./git-invocation.ts";

// Find the end of a $(...) word fragment without turning its parentheses into
// outer command separators. Quoted parentheses belong to its payload.
function substitutionEnd(source: string, start: number): number {
  let depth = 1;
  let quote = "";
  for (let i = start + 2; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
    } else if (char === "\\") {
      i += 1;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "$" && source[i + 1] === "(") {
        i = substitutionEnd(source, i);
        if (i < 0) return -1;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      if (char === "`") {
        i = source.indexOf("`", i + 1);
        if (i < 0) return -1;
      } else quote = char;
    } else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

type LiteralEvent =
  | { kind: "heredoc"; words: string[] }
  | { kind: "redirect"; word: string; words: string[]; operator: string }
  | { kind: "command"; words: string[]; expansions: boolean[] };
type LiteralAnalysis = { commands: string[][] | undefined; events: LiteralEvent[] };
export type LiteralInput = string | LiteralAnalysis;

// Keep event order and partial-parse events, including substitutions/heredocs.
// This is pure lexical data for ONE synchronous guard invocation, not a policy
// or identity cache. The original-command guard still performs its own check.
export function analyzeLiteralCommands(source: string): LiteralAnalysis {
  const events: LiteralEvent[] = [];
  const commands = parseLiteralCommands(
    source,
    (words) => events.push({ kind: "heredoc", words: [...words] }),
    (word, words, operator) => events.push({ kind: "redirect", word, words: [...words], operator }),
    (words, expansions) =>
      events.push({ kind: "command", words: [...words], expansions: [...expansions] }),
  );
  return { commands, events };
}

export function literalCommands(
  source: LiteralInput,
  expandingHeredoc?: (owner: string[]) => void,
  redirectWord?: (word: string, owner: string[], operator: string) => void,
  commandWords?: (words: string[], expansions: boolean[]) => void,
): string[][] | undefined {
  const analysis = typeof source === "string" ? analyzeLiteralCommands(source) : source;
  if (!expandingHeredoc && !redirectWord && !commandWords) return analysis.commands;
  for (const event of analysis.events) {
    if (event.kind === "heredoc") expandingHeredoc?.([...event.words]);
    else if (event.kind === "redirect")
      redirectWord?.(event.word, [...event.words], event.operator);
    else commandWords?.([...event.words], [...event.expansions]);
  }
  return analysis.commands;
}

// Decode literal shell words, retaining quoted interpreter source as one word.
// Opaque syntax stays on the upstream permission path. Do not mistake a string
// inside python -c / node -e for a shell command or split it at its semicolons.
function parseLiteralCommands(
  source: string,
  expandingHeredoc?: (owner: string[]) => void,
  redirectWord?: (word: string, owner: string[], operator: string) => void,
  commandWords?: (words: string[], expansions: boolean[]) => void,
): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let wordQuoted = false;
  let wordExpands = false;
  let expansions: boolean[] = [];
  let redirectTarget = false;
  let redirectOperator = "";
  let redirectWords: Array<{ word: string; operator: string }> = [];
  let heredocTarget: { stripTabs: boolean } | undefined;
  const heredocs: Array<{
    delimiter: string;
    stripTabs: boolean;
    expand: boolean;
    owner: string[];
  }> = [];
  const flushWord = () => {
    if (started && redirectTarget && !heredocTarget)
      redirectWords.push({ word, operator: redirectOperator });
    if (started && !redirectTarget) {
      words.push(word);
      expansions.push(wordExpands);
    }
    if (started && redirectTarget && heredocTarget) {
      heredocs.push({ delimiter: word, ...heredocTarget, expand: !wordQuoted, owner: [...words] });
      heredocTarget = undefined;
    }
    if (started) redirectTarget = false;
    word = "";
    started = false;
    wordQuoted = false;
    wordExpands = false;
  };
  const flushCommand = () => {
    flushWord();
    for (const target of redirectWords) redirectWord?.(target.word, words, target.operator);
    redirectWords = [];
    if (words.length) {
      commands.push(words);
      commandWords?.(words, expansions);
    }
    words = [];
    expansions = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined) return undefined;
      if (next === "\n") continue;
      wordQuoted = true;
      if (quote === '"' && !'\\$`"'.includes(next)) word += "\\";
      word += next;
      started = true;
      continue;
    }
    // Both quoting forms execute substitutions. Keep an opaque fragment in
    // the outer word so PATH=... and the following executable stay associated.
    // Single-quoted and escaped backticks were already consumed above.
    if (char === "`" || (char === "$" && source[i + 1] === "(")) {
      const backtick = char === "`";
      const end = backtick ? source.indexOf("`", i + 1) : substitutionEnd(source, i);
      if (end < 0) return undefined;
      commands.push(
        ...(parseLiteralCommands(
          source.slice(i + (backtick ? 1 : 2), end),
          expandingHeredoc,
          redirectWord,
          commandWords,
        ) ?? []),
      );
      wordExpands = true;
      word += "$dynamic";
      started = true;
      i = end;
      continue;
    }
    if (
      char === "$" ||
      (!quote &&
        (/[*?\[\]]/.test(char) ||
          (char === "~" && !started) ||
          (char === "{" && /^\{[^}\n]*(?:,|\.\.)[^}\n]*\}/.test(source.slice(i)))))
    )
      wordExpands = true;
    if (quote === '"') {
      if (char === '"') quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordQuoted = true;
      started = true;
    } else if (char === "<" || char === ">") {
      // A contiguous decimal word is an IO number, not an argument. Consume
      // the redirect target without confusing it with the executable.
      if (started && /^\d+$/.test(word)) {
        word = "";
        started = false;
      } else flushWord();
      const operatorStart = i;
      while (source[i + 1] === "<" || source[i + 1] === ">") i += 1;
      if (source.slice(operatorStart, i + 1) === "<<") {
        const stripTabs = source[i + 1] === "-";
        if (stripTabs) i += 1;
        heredocTarget = { stripTabs };
      }
      if (source[i + 1] === "&" || source[i + 1] === "|") i += 1;
      redirectOperator = source.slice(operatorStart, i + 1);
      redirectTarget = true;
    } else if (char === "(" || char === ")") {
      flushCommand();
    } else if (char === ";" || char === "|" || char === "&" || char === "\n") {
      flushCommand();
      if (char === "\n") {
        // Heredoc bodies begin at the next physical line, in redirect order.
        // Their text is data, not shell commands. Word decoding above already
        // removed delimiter quotes/escapes. Dynamic expansion within an
        // unquoted body remains on the upstream opaque-command review path.
        for (const heredoc of heredocs.splice(0)) {
          let cursor = i + 1;
          let closed = false;
          while (cursor <= source.length) {
            const newline = source.indexOf("\n", cursor);
            const end = newline < 0 ? source.length : newline;
            const line = source.slice(cursor, end);
            if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
              i = end;
              closed = true;
              break;
            }
            if (heredoc.expand && (line.includes("$(") || line.includes("`"))) {
              expandingHeredoc?.(heredoc.owner);
            }
            if (newline < 0) break;
            cursor = newline + 1;
          }
          // Bash consumes all remaining input for an unterminated heredoc.
          if (!closed) return commands;
        }
      }
    } else if (/\s/.test(char)) {
      flushWord();
    } else if (char === "#" && !started) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i += 1;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  flushCommand();
  return commands;
}

export function canonicalCommands(source: LiteralInput): string[] {
  const commands = literalCommands(source);
  if (!commands) return [];
  return commands.flatMap(canonicalWords);
}

export function canonicalWords(original: string[]): string[] {
  const words = [...original];
  while (["if", "then", "else", "elif", "while", "until", "do", "!", "{"].includes(words[0]))
    words.shift();
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  // Operand-free wrappers have unambiguous command positions. Other wrappers
  // keep their existing upstream human-review boundary. Git globals are
  // stripped separately so `git -P push` still matches `git push *` denies.
  while (["command", "builtin", "exec", "nohup"].includes(basename(words[0] ?? ""))) {
    words.shift();
    if (words[0] === "--") words.shift();
    if (words[0]?.startsWith("-")) return [];
  }
  if (!words.length) return [];
  words[0] = basename(words[0]);
  const values = [words.join(" ")];
  const git = parseGitInvocation(original);
  if (git?.subcommand && !git.unknownGlobals) {
    values.push(["git", git.subcommand, ...git.args].join(" "));
  }
  return values;
}

export function inspectGitCommands(source: string): GitInvocation[] {
  const found: GitInvocation[] = [];
  const commands = literalCommands(source, undefined, undefined, (words, expansions) => {
    const invocation = parseGitInvocation(words, expansions);
    if (invocation) found.push(invocation);
  });
  return commands === undefined ? [] : found;
}
