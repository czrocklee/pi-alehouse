// Non-Git literal inspection hardening and its private mutable-input provenance.
// This is execution normalization, not a permission authority or Git rewrite.
import { createHash } from "node:crypto";
import type { TokenEffect } from "#src/access-intent/effect";
import { getParser, parseUnresolvedWithin, type TSNode } from "./parser";
import { gitQueryWords } from "./managed-git-query";

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

export const shellWord = (word: string) =>
  /^[A-Za-z0-9_./:%=+@^,~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

export function printingSed(words: string[]): boolean {
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

export function resourceMetadata(words: string[]): boolean {
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
export function managedInspection(words: string[]): ManagedInspection | undefined {
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

export type LiteralUnit = { text: string; words: string[]; start: number; end: number };
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

// Both hardeners and both gate readers share this ONE store. Neither a copied
// input object nor a JSON field can supply original-request or file provenance.
const originals = new WeakMap<
  object,
  { command: string; units: string[]; fileScope?: ManagedStaticFileScope }
>();
// The complete requested command, captured by the authority entry before its
// first hardener (and before the original-command deny). Private to this
// module: a field on the input object could be supplied by the model.
const requestedCommands = new WeakMap<object, string>();

/** Capture the requested command; called once per call, before any hardening. */
export function captureRequestedBashCommand(input: Record<string, unknown>): void {
  if (typeof input.command === "string") requestedCommands.set(input, input.command);
  else requestedCommands.delete(input);
}

/**
 * The requested (pre-hardening) command behind this input's execution text, or
 * undefined when it cannot be verified. The execution text is the input's own
 * `command` byte-for-byte, never a trimmed or parsed projection; `fallback` is
 * used only by a shell tool that keeps its command under another key (no
 * capture or hardener ever touches it). A capture binds only while the
 * execution text is the requested text or the one a managed hardener recorded
 * for this same input. Without any capture layer (direct gate use), an input
 * no hardener touched is its own original. Only text is retained.
 */
export function requestedBashCommand(
  input: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  const executed = typeof input.command === "string" ? input.command : undefined;
  const requested = requestedCommands.get(input);
  const hardened = originals.get(input);
  if (requested === undefined) return hardened ? undefined : (executed ?? fallback);
  if (executed === requested) return requested;
  return executed !== undefined && hardened?.command === executed ? requested : undefined;
}

// Provenance requires the same input object and unchanged hardened command.
export function originalGitCommands(input: Record<string, unknown>): string[] | undefined {
  const original = originals.get(input);
  return original?.command === input.command ? original.units : undefined;
}

export function managedStaticFileScope(
  input: Record<string, unknown>,
): ManagedStaticFileScope | undefined {
  const original = originals.get(input);
  return original?.command === input.command && original.fileScope?.command === input.command
    ? original.fileScope
    : undefined;
}

// A file scope proves one invocation, never reuse across executions/sessions.
export function clearManagedStaticFileScope(input: Record<string, unknown>): void {
  const previous = originals.get(input);
  if (previous?.fileScope)
    originals.set(input, { command: previous.command, units: previous.units });
}

// Internal commit shared by the two hardeners, not a model-facing capability.
// Mutation, original units and digest audit always describe the same command.
export function recordManagedInput(
  input: Record<string, unknown>,
  source: string,
  command: string,
  units: LiteralUnit[],
  fileScope?: ManagedStaticFileScope,
): { version: 1; originalDigest: string; executionDigest: string } {
  input.command = command;
  originals.set(input, {
    command,
    units: units.map((unit) => unit.text),
    ...(fileScope ? { fileScope } : {}),
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return { version: 1, originalDigest: hash(source), executionDigest: hash(command) };
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

// Only non-Git units are hardened. Called BEFORE the gate; SDK in-place
// mutation is the execution input, not a tool/gate replacement.
export async function hardenNonGitInput(
  input: Record<string, unknown>,
  _sessionCwd = process.cwd(),
) {
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
    // Never rewrite the shared leading cd in a mixed program containing Git.
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
    return recordManagedInput(input, source, command, units);
  } finally {
    tree.delete();
  }
}
