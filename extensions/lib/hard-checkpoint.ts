/**
 * Static checkpoints for asks a model judge must never be the only reviewer of.
 *
 * A shared helper, not an extension: Jev imports it and runs it before any
 * model call, so an unparseable or high-impact action costs nothing and stays
 * human. Keep it free of SDK runtime imports.
 */

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { inspectGitCommands } from "../static-safety-guard.ts";
import { gitInvocationNeedsHuman, GIT_GLOBAL_OPTIONS_PATTERN } from "./git-invocation.ts";

/** The parts of the live tool call a checkpoint reads. */
type CheckpointToolCall = { name: string; arguments: Record<string, unknown> };

// A command-position anchor that also survives literal environment assignments
// and wrappers whose options consume operands. It remains defense-in-depth, not
// a shell parser; unsupported or dynamic forms are left for the gate sentinel
// and reviewer rather than treated as allow evidence.
const SHELL_ATOM = String.raw`(?:"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^\s;&|()\n]+)`;
const SHELL_ASSIGNMENT = `[A-Za-z_][A-Za-z0-9_]*=${SHELL_ATOM}`;
const COMMAND_PATH_PREFIX = String.raw`(?:[^\s;&|()\n]+/)?`;
const SIMPLE_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}(?:command|builtin|nohup)\s+(?:-\S+\s+)*`;
const EXEC_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}exec\s+(?:(?:-a|--argv0)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+|-\S+\s+)*`;
// Assignments deliberately remain outside this wrapper in COMMAND_POSITION.
// Accepting them both here and in the enclosing repeated group creates 2^n
// backtracking paths for `env A=1 ...` when the final command does not match.
const ENV_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}env\s+(?:(?:-i|--ignore-environment|-0|--null)\s+|(?:-u|--unset|-C|--chdir|-S|--split-string)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+)*`;
const STDBUF_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}stdbuf\s+(?:(?:-[ioe])(?:\S+|\s+${SHELL_ATOM})\s+|--(?:input|output|error)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+)*`;
const NICE_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}nice\s+(?:(?:-n|--adjustment)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+|-\d+\s+)*`;
// `-t` belongs only to the operand-free branch below. Listing it here too --
// as `-[cnpt]` did -- lets `ionice -t ...` parse two ways per repeat, which is
// the same 2^n construction the env wrapper comment describes.
const IONICE_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}ionice\s+(?:(?:-[cnp]|--class|--classdata|--pid|--pgid|--uid)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+|(?:-t|--ignore)\s+)*`;
const TIME_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}time\s+(?:(?:-f|--format|-o|--output)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+|(?:-a|--append|-p|--portability|--verbose)\s+)*`;
const TIMEOUT_COMMAND_WRAPPER = String.raw`${COMMAND_PATH_PREFIX}timeout\s+(?:(?:-s|--signal|-k|--kill-after)(?:=${SHELL_ATOM}|\s+${SHELL_ATOM})\s+|(?:--preserve-status|--foreground|--verbose)\s+)*${SHELL_ATOM}\s+`;
const COMMAND_WRAPPER = `(?:${SIMPLE_COMMAND_WRAPPER}|${EXEC_COMMAND_WRAPPER}|${ENV_COMMAND_WRAPPER}|${STDBUF_COMMAND_WRAPPER}|${NICE_COMMAND_WRAPPER}|${IONICE_COMMAND_WRAPPER}|${TIME_COMMAND_WRAPPER}|${TIMEOUT_COMMAND_WRAPPER})`;
// Compound-statement keywords open a command position that the separator class
// alone misses: `for f in *; do rm -rf $f; done` puts `rm` after `do`, not
// after a separator. `{` stays here rather than joining the separator class --
// accepting it in both places makes each `{ ` parse two ways and turns the
// anchor quadratic.
const SHELL_KEYWORD = String.raw`(?:!|\{|then|else|elif|do|done|fi|in)`;
const COMMAND_POSITION = String.raw`(?:^|[;&|()\n]\s*)\s*(?:${SHELL_KEYWORD}\s+)*(?:${SHELL_ASSIGNMENT}\s+)*(?:(?:${COMMAND_WRAPPER})(?:${SHELL_ASSIGNMENT}\s+)*)*\\?`;
const COMMAND_NAME_POSITION = `${COMMAND_POSITION}${COMMAND_PATH_PREFIX}`;
const GIT_GLOBAL_OPTIONS = GIT_GLOBAL_OPTIONS_PATTERN;

const HIGH_IMPACT_COMMAND_PATTERNS: readonly RegExp[] = [
  new RegExp(`${COMMAND_NAME_POSITION}(?:sudo|doas|su)\\b`, "i"),
  new RegExp(`${COMMAND_NAME_POSITION}(?:rm|shred|wipefs|truncate|mkfs(?:\\.[\\w-]+)?)\\b`, "i"),
  new RegExp(`${COMMAND_NAME_POSITION}(?:chown|chgrp|chmod)\\b`, "i"),
  new RegExp(`${COMMAND_NAME_POSITION}(?:ssh|scp|sftp|rsync|crontab|at)\\b`, "i"),
  new RegExp(`${COMMAND_NAME_POSITION}dd\\b[^\\n;]*\\bof=`, "i"),
  /\bfind\b[^\n;]*(?:\s-delete\b|\s-exec(?:dir)?\b|\s-ok(?:dir)?\b)/i,
  // Per-invocation config can install pagers, filters, aliases, hooks, or
  // fsmonitor commands even when the apparent Git subcommand is read-only.
  // Keep flag matching case-sensitive so benign `git -C <dir>` is not caught.
  new RegExp(
    `${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+(?:-c(?:\\s+|[^\\s])|--config-env(?:=|\\s+))`,
  ),
  new RegExp(`${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+config\\b`, "i"),
  // Only exact commit-metadata forms bypass review in the static policy. Any
  // remaining show request needs a human: objects can contain denied file data.
  new RegExp(`${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+show\\b`, "i"),
  /\bgit\b[^\n;]*\b(?:diff|log|show)\b[^\n;]*\s--(?:output(?:=|\s)|ext-diff\b|textconv\b)/i,
  // Git global options may sit between `git` and a destructive subcommand.
  new RegExp(`${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+push\\b`),
  new RegExp(`${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+reset\\s+--hard\\b`),
  new RegExp(
    `${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+clean\\b[^\\n;]*(?:\\s-[A-Za-z]*f[A-Za-z]*\\b|\\s--force\\b)`,
  ),
  new RegExp(
    `${COMMAND_NAME_POSITION}git\\b${GIT_GLOBAL_OPTIONS}\\s+(?:reflog\\s+(?:delete|expire)|branch\\s+(?:-D|--delete)|tag\\s+(?:-d|--delete))\\b`,
  ),
  /\b(?:npm|pnpm|yarn|cargo|gem)\s+publish\b/i,
  /\b(?:docker|podman)\s+push\b/i,
  /\bgh\s+(?:pr\s+(?:create|merge|comment|close|reopen)|issue\s+(?:create|comment|close|reopen)|release\s+create)\b/i,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|scale|set|taint|cordon|drain|uncordon|exec|cp)\b/i,
  /\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i,
  /\bterraform\s+(?:apply|destroy|import|state\s+(?:mv|rm|push))\b/i,
  /\b(?:nixos-rebuild|home-manager)\s+(?:switch|boot|test)\b/i,
  new RegExp(
    `${COMMAND_NAME_POSITION}nrb\\s+(?:switch|boot|test|update|gc|deploy|rollback)\\b`,
    "i",
  ),
  /\bnix(?:-env|-collect-garbage|\s+profile)\b/i,
  /\b(?:aws|gcloud|az)\b[^\n;]*\b(?:rm|delete|create|update|deploy|put|sync|apply|terminate)\b/i,
  /\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|edit|set-property|reboot|poweroff|suspend|hibernate)\b/i,
  new RegExp(`${COMMAND_NAME_POSITION}(?:shutdown|reboot|poweroff|halt)\\b`, "i"),
  /\bcurl\b[^\n;]*(?:--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-binary|-raw|-urlencode)?\b|--upload-file\b)/i,
  /\bwget\b[^\n;]*(?:--post-data|--post-file|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE))/i,
  // Anchored at command position: an unanchored spelling checkpointed every
  // `grep x /etc/passwd`, which is a read.
  new RegExp(`${COMMAND_NAME_POSITION}(?:passwd|chpasswd|usermod|useradd|userdel)\\b`, "i"),
];

/**
 * Wrappers whose payload is opaque to path analysis. With `bash: "*": "ask"`,
 * the gate never floors an allow and therefore never stamps its opaque-wrapper
 * sentinel, so text detection is the primary checkpoint.
 */
const OPAQUE_SHELL_WRAPPER_PATTERNS: readonly RegExp[] = [
  // A nested shell receives code from -c, stdin, or an external script that
  // deterministic path analysis has not inspected.
  new RegExp(`${COMMAND_NAME_POSITION}(?:ba|z|k|da|fi)?sh\\b`, "i"),
  new RegExp(`${COMMAND_NAME_POSITION}eval\\b`, "i"),
  new RegExp(
    `${COMMAND_NAME_POSITION}(?:pwsh|powershell)\\b[^\\n;]*\\s-(?:c|command|e|encodedcommand)\\b`,
    "i",
  ),
  new RegExp(`${COMMAND_NAME_POSITION}(?:source\\b|\\.\\s+\\S)`, "i"),
  /\bnix-shell\b[^\n;]*--run\b/i,
  /\b(?:nix|docker|podman|kubectl|flatpak|distrobox|toolbox)\b[^\n;]*\b(?:run|exec)\b/i,
  /\bssh\b[^\n;]*\s(?:'|")/i,
  /\bxargs\b/i,
  // awk system() hands a string to a nested shell, so it remains opaque here.
  new RegExp(`${COMMAND_NAME_POSITION}(?:awk|gawk|mawk|nawk)\\b[^\\n;]*\\bsystem\\s*\\(`, "i"),
];

/**
 * Complete, shell-quoted inline interpreter source is reviewed separately from
 * opaque wrappers. Prefix parsing below accepts only a small safe option set;
 * an external script or code-loading option keeps the whole action manual.
 */
const INLINE_INTERPRETER_BASENAME = String.raw`(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|node|deno|bun|ruby|perl|php|lua)`;
const INLINE_INTERPRETER_NAME = String.raw`(?:\S*/)?${INLINE_INTERPRETER_BASENAME}`;
const INLINE_INTERPRETER_INVOCATION = new RegExp(
  `${COMMAND_POSITION}(${INLINE_INTERPRETER_NAME})\\b`,
  "i",
);
const CODE_LOADING_INTERPRETER_ENV =
  /\b(?:NODE_OPTIONS|NODE_PATH|PERL5LIB|PERL5OPT|PHPRC|PHP_INI_SCAN_DIR|PYTHONHOME|PYTHONINSPECT|PYTHONPATH|PYTHONSTARTUP|PYTHONWARNINGS|RUBYLIB|RUBYOPT|LUA_INIT|LUA_PATH|LUA_CPATH)\s*=/i;
const OPAQUE_INLINE_SOURCE_PATTERNS: readonly RegExp[] = [
  /\b(?:eval|exec|compile)\s*\(/i,
  /\b(?:new\s+Function|Function)\s*\(/,
  /\bvm\.(?:runInContext|runInNewContext|runInThisContext|compileFunction)\s*\(/i,
  /\b(?:base64|b64decode|atob|fromhex|unhexlify|marshal|pickle|zlib|gunzip|inflate)\b/i,
  /\b(?:runpy\.run_path|importlib\.(?:import_module|util\.spec_from_file_location))\s*\(/i,
  /\b(?:sys\.stdin|process\.stdin|readFileSync\s*\(\s*0\b)/i,
];

const EXTERNAL_SIDE_EFFECT_TARGET =
  /(?:^|[:/_-])(?:create|delete|deploy|destroy|merge|message|publish|release|remove|send|submit|update)(?:$|[:/_-])/i;

function staticShellCommandView(command: string): string {
  let view = command;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = view
      .replace(/\$''/g, "")
      .replace(/\$'([A-Za-z0-9_./+,@%=-]+)'/g, "$1")
      .replace(/''|""/g, "")
      .replace(/'([A-Za-z0-9_./+,@%=-]+)'/g, "$1")
      .replace(/"([A-Za-z0-9_./+,@%=-]+)"/g, "$1")
      .replace(/\\([A-Za-z0-9_./+,@%=-])/g, "$1");
    if (next === view) break;
    view = next;
  }
  return view;
}

function checkpointCommands(
  details: PromptPermissionDetails,
  currentToolCall: CheckpointToolCall | undefined,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || value.trim() === "" || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  add(currentToolCall?.arguments.command);
  add(details.command);
  if (details.payload.kind === "bash") {
    add(details.payload.request.value);
    add(details.payload.request.executedUnit);
    for (const evidence of details.payload.evidence) {
      if (evidence.label === "full command") add(evidence.text);
    }
  }
  // `bash_external_directory` intentionally has no command-bearing payload in
  // the permission-system contract and is permanently excluded from auto-allow.
  // If Jev's EXCLUDED_ALLOW_SURFACES ever relaxes that boundary, command
  // provenance must be added here before the surface can become model-allowable.
  return candidates;
}

function interpreterBasename(executable: string): string {
  return executable.split("/").at(-1)?.toLowerCase() ?? "";
}

function inlineSourceFlags(executable: string): ReadonlySet<string> {
  const basename = interpreterBasename(executable);
  if (/^(?:python\d*(?:\.\d+)*|pypy\d*)$/.test(basename)) return new Set(["-c"]);
  if (basename === "node") return new Set(["-e", "--eval", "-p", "--print"]);
  if (basename === "bun") return new Set(["-e", "--eval"]);
  if (basename === "deno") return new Set(["eval"]);
  if (basename === "perl") return new Set(["-e", "-E"]);
  if (basename === "ruby" || basename === "lua") return new Set(["-e"]);
  if (basename === "php") return new Set(["-r"]);
  return new Set();
}

function safeInlinePrefixOption(executable: string, option: string): boolean {
  const basename = interpreterBasename(executable);
  if (/^(?:python\d*(?:\.\d+)*|pypy\d*)$/.test(basename)) {
    return /^-(?:b{1,2}|B|d|E|I|O{1,2}|P|q|R|s|S|u|v)$/.test(option);
  }
  if (basename === "node") {
    return /^(?:--input-type=(?:commonjs|module|commonjs-typescript|module-typescript)|--no-warnings|--trace-warnings|--enable-source-maps|--no-deprecation|--trace-deprecation)$/.test(
      option,
    );
  }
  if (basename === "deno") return /^(?:--no-config|--no-lock|--quiet)$/.test(option);
  if (basename === "ruby") return /^(?:-w|--disable-gems)$/.test(option);
  if (basename === "perl") return option === "-w";
  if (basename === "php") return option === "-n";
  if (basename === "lua") return option === "-E";
  return false;
}

/**
 * Locate an inline source argument only when every preceding token is a known
 * non-code-loading interpreter option. A script operand, `--`, preload hook,
 * quoted/generated option, or unsupported option fails closed.
 */
function inlinePayloadOffset(command: string, invocation: RegExpMatchArray): number | undefined {
  const executable = invocation[1] ?? "";
  const flags = inlineSourceFlags(executable);
  let cursor = (invocation.index ?? 0) + invocation[0].length;

  while (cursor < command.length) {
    while (cursor < command.length && /\s/.test(command[cursor] ?? "")) cursor += 1;
    const tokenStart = cursor;
    while (cursor < command.length && !/\s/.test(command[cursor] ?? "")) cursor += 1;
    const token = command.slice(tokenStart, cursor);
    if (token === "") return undefined;
    if (flags.has(token)) {
      while (cursor < command.length && /\s/.test(command[cursor] ?? "")) cursor += 1;
      return cursor;
    }
    if (!safeInlinePrefixOption(executable, token)) return undefined;
  }
  return undefined;
}

/**
 * Return literal source for the common, shell-quoted inline-code form.
 *
 * This intentionally accepts less than a shell parser. Concatenated strings,
 * ANSI-C quoting, unquoted source, substitutions, and unterminated quoting all
 * remain manual because the text visible to the reviewer is not necessarily
 * the bytes the interpreter receives.
 */
function literalInlineSource(command: string, payloadOffset: number): string | undefined {
  const payload = command.slice(payloadOffset);
  const quote = payload[0];
  if (quote !== "'" && quote !== '"') return undefined;

  let escaped = false;
  for (let index = 1; index < payload.length; index += 1) {
    const character = payload[index];
    if (quote === '"' && !escaped && (character === "$" || character === "`")) {
      return undefined;
    }
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      const remainder = payload.slice(index + 1);
      if (/^\S/.test(remainder) && !/^[;&|()]/.test(remainder)) return undefined;
      return payload.slice(1, index);
    }
    escaped = false;
  }
  return undefined;
}

function interpreterHeredoc(
  command: string,
  invocation: RegExpMatchArray,
): "quoted" | "unquoted" | undefined {
  const start = (invocation.index ?? 0) + invocation[0].length;
  const line = command.slice(
    start,
    command.indexOf("\n", start) < 0 ? undefined : command.indexOf("\n", start),
  );
  const operator = /<<-?/.exec(line);
  if (!operator) return undefined;
  let cursor = (operator.index ?? 0) + operator[0].length;
  while (cursor < line.length && /[ \t]/.test(line[cursor] ?? "")) cursor += 1;
  const delimiterStart = cursor;
  while (cursor < line.length && !/[ \t]/.test(line[cursor] ?? "")) cursor += 1;
  const delimiter = line.slice(delimiterStart, cursor);
  if (delimiter === "") return "unquoted";
  return /['"\\]/.test(delimiter) ? "quoted" : "unquoted";
}

function knownInterpreterMode(executable: string, tail: string): boolean {
  const basename = interpreterBasename(executable);
  if (/^(?:-V|--version)(?:\s|$)/.test(tail)) return true;
  if (/^(?:python\d*(?:\.\d+)*|pypy\d*)$/.test(basename)) {
    return /^-m\s+[A-Za-z0-9_.-]+(?:\s|$)/.test(tail);
  }
  if (basename === "node") return /^(?:-v|--check|--test)(?:\s|$)/.test(tail);
  if (basename === "deno") return /^(?:check|fmt|lint|test)(?:\s|$)/.test(tail);
  if (basename === "bun") return /^(?:-v|test)(?:\s|$)/.test(tail);
  if (basename === "ruby" || basename === "perl") return /^-c(?:\s|$)/.test(tail);
  if (basename === "php") return /^-l(?:\s|$)/.test(tail);
  return false;
}

function opaqueInlineInterpreterPayload(command: string): boolean {
  const mentionsInterpreter = new RegExp(`\\b${INLINE_INTERPRETER_BASENAME}\\b`, "i").test(command);
  if (mentionsInterpreter && CODE_LOADING_INTERPRETER_ENV.test(command)) return true;

  const invocations = [...command.matchAll(new RegExp(INLINE_INTERPRETER_INVOCATION.source, "gi"))];
  if (invocations.length === 0) return false;
  // Parsing multiple shell/interpreter quote domains correctly is outside this
  // bounded classifier. The reviewer still sees the command after a defer.
  if (invocations.length !== 1) return true;

  const invocation = invocations[0];
  const payloadOffset = inlinePayloadOffset(command, invocation);
  if (payloadOffset !== undefined) {
    const literalSource = literalInlineSource(command, payloadOffset);
    if (literalSource === undefined) return true;
    return OPAQUE_INLINE_SOURCE_PATTERNS.some((pattern) => pattern.test(literalSource));
  }

  const heredoc = interpreterHeredoc(command, invocation);
  if (heredoc === "unquoted") return true;
  const tail = command.slice((invocation.index ?? 0) + invocation[0].length).trimStart();
  if (heredoc === "quoted") {
    return OPAQUE_INLINE_SOURCE_PATTERNS.some((pattern) => pattern.test(command));
  }
  if (knownInterpreterMode(invocation[1] ?? "", tail)) return false;

  // A bare interpreter, stdin program, or external script does not put the
  // executed source in exactAction. Keep it at the human checkpoint.
  return true;
}

const QUOTE_SENSITIVE_CHECKPOINT_EXECUTABLES = new Set([
  "sudo",
  "doas",
  "su",
  "rm",
  "shred",
  "wipefs",
  "truncate",
  "mkfs",
  "chown",
  "chgrp",
  "chmod",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "crontab",
  "at",
  "dd",
  "find",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "gem",
  "docker",
  "podman",
  "gh",
  "kubectl",
  "helm",
  "terraform",
  "nixos-rebuild",
  "home-manager",
  "nrb",
  "nix",
  "nix-env",
  "nix-collect-garbage",
  "aws",
  "gcloud",
  "az",
  "systemctl",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "curl",
  "wget",
  "passwd",
  "chpasswd",
  "usermod",
  "useradd",
  "userdel",
  "sh",
  "bash",
  "zsh",
  "ksh",
  "dash",
  "fish",
  "eval",
  "pwsh",
  "powershell",
  "source",
  ".",
  "nix-shell",
  "flatpak",
  "distrobox",
  "toolbox",
  "xargs",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

const LEADING_COMMAND_TOKEN = new RegExp(
  `^\\s*(?:${SHELL_ASSIGNMENT}\\s+)*(?:(?:${COMMAND_WRAPPER})(?:${SHELL_ASSIGNMENT}\\s+)*)*\\\\?([^\\s;&|()]+)`,
  "i",
);

/**
 * Split on top-level separators, carrying each piece's offset in `command`.
 *
 * The offset is what lets a caller rebuild the command around a piece instead
 * of scanning the piece alone; `start` indexes the first character of `text`.
 */
interface ShellSegment {
  text: string;
  start: number;
}

function pushSegment(
  segments: ShellSegment[],
  command: string,
  from: number,
  to: number,
): void {
  const raw = command.slice(from, to);
  const text = raw.trim();
  if (text === "") return;
  segments.push({ text, start: from + (raw.length - raw.trimStart().length) });
}

function topLevelShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (
      character === "\n" ||
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "(" ||
      character === ")"
    ) {
      pushSegment(segments, command, start, index);
      start = index + 1;
    }
  }
  pushSegment(segments, command, start, command.length);
  return segments;
}

/**
 * Rebuild the whole command with only its command names unquoted.
 *
 * Quoting is obfuscation in command-name position and semantics everywhere
 * after it: `<<\'PY\'` is a literal heredoc and `<<PY` expands, so a fully
 * unquoted view would rewrite every literal heredoc into an expanding one and
 * checkpoint it. Only the names are normalized; every argument keeps the bytes
 * it was written with.
 *
 * The result spans the whole command rather than one segment because the
 * classifier this feeds reads past separators -- a heredoc body holding a `;`
 * is split across segments, and a segment alone would hand it a truncated
 * program. `undefined` means no name was quoted, so the direct scan over the
 * command already saw everything this view would show.
 */
function commandNameNormalizedView(command: string): string | undefined {
  let view = "";
  let cursor = 0;
  for (const { text, start } of topLevelShellSegments(command)) {
    const original = LEADING_COMMAND_TOKEN.exec(text);
    if (!original) continue;
    const normalized = LEADING_COMMAND_TOKEN.exec(staticShellCommandView(text));
    if (!normalized || normalized[0] === original[0]) continue;
    view += command.slice(cursor, start) + normalized[0];
    cursor = start + original[0].length;
  }
  return cursor === 0 ? undefined : view + command.slice(cursor);
}

/**
 * Re-run the command scans over views that undo quoting.
 *
 * Two scans over two different views, because the two are sensitive to
 * different things. The inline classifier reads argument quoting as meaning,
 * so it gets `commandNameNormalizedView` -- names unquoted, arguments intact --
 * which is exactly the reading the unquoted spelling of the same command would
 * get from the direct scan; the direct scan cannot see it itself because a
 * quoted name is not in command position.
 *
 * The shell scans get the fully unquoted segment, since `\'rm\'` and `r"m"` are
 * what they exist to catch, and they run only for a leading executable in
 * `QUOTE_SENSITIVE_CHECKPOINT_EXECUTABLES`. That gate is what keeps them off
 * interpreter segments: unquoting rewrites `python3 -c \'print("bash")\'` into
 * `python3 -c print(bash)`, where `(` is a command-position separator, so
 * scanning it would checkpoint every script that mentions a shell in a string.
 */
function quoteObfuscatedCheckpointReason(commands: readonly string[]): string | undefined {
  for (const command of commands) {
    const nameView = commandNameNormalizedView(command);
    if (nameView !== undefined && opaqueInlineInterpreterPayload(nameView)) {
      return "opaque_inline_interpreter";
    }
    for (const { text: segment } of topLevelShellSegments(command)) {
      const staticView = staticShellCommandView(segment);
      if (staticView === segment) continue;
      const executable = LEADING_COMMAND_TOKEN.exec(staticView)?.[1];
      if (!executable) continue;
      const name = interpreterBasename(executable);
      if (!QUOTE_SENSITIVE_CHECKPOINT_EXECUTABLES.has(name) && !name.startsWith("mkfs.")) {
        continue;
      }
      if (HIGH_IMPACT_COMMAND_PATTERNS.some((pattern) => pattern.test(staticView))) {
        return "high_impact_command";
      }
      if (OPAQUE_SHELL_WRAPPER_PATTERNS.some((pattern) => pattern.test(staticView))) {
        return "opaque_shell_wrapper";
      }
    }
  }
  return undefined;
}

/**
 * A command name assembled with ANSI-C quoting hides its own bytes: `$'\x72m'`
 * is `rm` to the shell and nothing a static view can decode. Implementing the
 * escape grammar would be a second parser to get wrong, so the construct is
 * treated as opaque wherever it names the command.
 *
 * Scoped to command-name position on purpose: `grep $'\t' file` puts the escape
 * in an argument, where it hides nothing about what will run.
 */
const ANSI_C_QUOTED_NAME = /\$'[^']*\\/;

function ansiCQuotedCommandName(commands: readonly string[]): boolean {
  return commands.some((command) =>
    topLevelShellSegments(command).some((segment) => {
      const executable = LEADING_COMMAND_TOKEN.exec(segment.text)?.[1];
      return executable !== undefined && ANSI_C_QUOTED_NAME.test(executable);
    }),
  );
}

/**
 * Deterministic pre-filter for asks a model must not be the only reviewer of.
 *
 * Not a boundary -- a denylist over command text never is. It exists so the
 * two classes where model judgment is the *only* remaining check (a high-impact
 * effect, and a payload no static rule could inspect) never reach the model.
 */
export function hardCheckpointReason(
  details: PromptPermissionDetails,
  currentToolCall: CheckpointToolCall | undefined,
): string | undefined {
  const commands = checkpointCommands(details, currentToolCall);
  if (commands.some((command) => inspectGitCommands(command).some(gitInvocationNeedsHuman))) {
    return "high_impact_command";
  }
  if (
    commands.some((command) =>
      HIGH_IMPACT_COMMAND_PATTERNS.some((pattern) => pattern.test(command)),
    )
  ) {
    return "high_impact_command";
  }
  if (
    commands.some((command) =>
      OPAQUE_SHELL_WRAPPER_PATTERNS.some((pattern) => pattern.test(command)),
    )
  ) {
    return "opaque_shell_wrapper";
  }
  const quoteObfuscatedReason = quoteObfuscatedCheckpointReason(commands);
  if (quoteObfuscatedReason) return quoteObfuscatedReason;
  if (ansiCQuotedCommandName(commands)) return "ansi_c_quoted_command_name";
  if (commands.some(opaqueInlineInterpreterPayload)) {
    return "opaque_inline_interpreter";
  }

  const request = details.payload.request;
  // The gate stamps these when it could not see what will run. They only
  // appear where a rule resolved permissively enough to be floored, so they
  // are a supplement to the text scan above rather than a replacement.
  if (
    request.matchedPattern === "<opaque-bash-wrapper>" ||
    request.matchedPattern === "<indirection-bash-wrapper>" ||
    request.matchedPattern === "<unparseable-bash-command>"
  ) {
    return "gate_reported_opaque_command";
  }
  if (
    typeof request.executedUnit === "string" &&
    request.executedUnit.trim() !== "" &&
    request.executedUnit.trim() !== request.value.trim()
  ) {
    return "executed_unit_differs";
  }
  if (request.commandContext) {
    return "nested_command_context";
  }
  const toolName = currentToolCall?.name ?? request.toolName ?? "";
  if (details.payload.kind === "mcp" && EXTERNAL_SIDE_EFFECT_TARGET.test(request.value)) {
    return "external_side_effect_tool";
  }
  if (/(?:^|[:/_-])(?:deploy|destroy|publish|release|send)(?:$|[:/_-])/i.test(toolName)) {
    return "high_impact_tool";
  }
  return undefined;
}
