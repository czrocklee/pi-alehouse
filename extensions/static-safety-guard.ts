/**
 * Deny-only tool-entry guard. Session approvals and the model authorizer cannot
 * override it. This closes literal spelling variants of our declarative Bash
 * denies; it is not a sandbox for interpreters, scripts, or dynamic shell code.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionsService } from "@gotgenes/pi-permission-system";
import { isGitQuery, parseGitInvocation, unknownGlobalsMayHideQuery, type GitInvocation } from "./lib/git-invocation.ts";

// Populated from the same Nix declaration as worker definitions and approval hashes.
const WORKER_POLICY: Record<string, { digest: string; bashDenies: string[] }> = /* @worker-policy@ */ {};

type Denies = { global: string[]; staticAllows: string[]; agents: Map<string, string[]> };

type PolicyGrepRegistration = { isBound: () => boolean };

export function policyGrepRegistry(): Map<string, PolicyGrepRegistration> {
  const globals = globalThis as Record<symbol, unknown>;
  const key = Symbol.for("@rocklee/pi:policy-grep:v3");
  if (!(globals[key] instanceof Map)) globals[key] = new Map<string, PolicyGrepRegistration>();
  return globals[key] as Map<string, PolicyGrepRegistration>;
}

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

// Decode literal shell words, retaining quoted interpreter source as one word.
// Opaque syntax stays on the upstream permission path. Do not mistake a string
// inside python -c / node -e for a shell command or split it at its semicolons.
function literalCommands(source: string, expandingHeredoc?: (owner: string[]) => void, redirectWord?: (word: string, owner: string[], operator: string) => void, commandWords?: (words: string[], expansions: boolean[]) => void): string[][] | undefined {
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
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; expand: boolean; owner: string[] }> = [];
  const flushWord = () => {
    if (started && redirectTarget && !heredocTarget) redirectWords.push({ word, operator: redirectOperator });
    if (started && !redirectTarget) { words.push(word); expansions.push(wordExpands); }
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
      commands.push(...(literalCommands(source.slice(i + (backtick ? 1 : 2), end), expandingHeredoc, redirectWord, commandWords) ?? []));
      wordExpands = true;
      word += "$dynamic";
      started = true;
      i = end;
      continue;
    }
    if (char === "$" || (!quote && (/[*?\[\]]/.test(char) || (char === "~" && !started) ||
        (char === "{" && /^\{[^}\n]*(?:,|\.\.)[^}\n]*\}/.test(source.slice(i)))))) wordExpands = true;
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
      if (started && /^\d+$/.test(word)) { word = ""; started = false; }
      else flushWord();
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

function canonicalCommands(source: string): string[] {
  const commands = literalCommands(source);
  if (!commands) return [];
  return commands.flatMap(canonicalWords);
}

function canonicalWords(original: string[]): string[] {
  const words = [...original];
  while (["if", "then", "else", "elif", "while", "until", "do", "!", "{"].includes(words[0])) words.shift();
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

function matchesDeny(value: string, pattern: string): boolean {
  const regex = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  // A command without operands must not escape an existing `sudo *` deny.
  return new RegExp(`^${regex}$`, "s").test(value) ||
    (pattern.endsWith(" *") && value === pattern.slice(0, -2));
}

function recordedAgent(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "active_agent") continue;
    const name = (entry.data as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
    if (name === null) break;
  }
  return undefined;
}

export function activeAgent(ctx: ExtensionContext): string | undefined {
  const recorded = recordedAgent(ctx);
  if (recorded !== undefined) return recorded;
  // Legacy has no trusted entry. Parent identity precedes the child marker,
  // but custom child prose may contain later markers. Neither first nor last
  // proves identity; reject conflicting names rather than select wider denies.
  const names = new Set(Array.from(ctx.getSystemPrompt().matchAll(/<active_agent\s+name=["']([^"']+)["'][^>]*>/gi), (match) => match[1].trim()));
  if (names.size > 1) throw new Error("AMBIGUOUS_ACTIVE_AGENT");
  return names.values().next().value;
}

function loadDenies(root: string): Denies {
  const config = JSON.parse(readFileSync(join(root, "extensions/pi-permission-system/config.json"), "utf8"));
  const global = Object.entries(config.permission.bash as Record<string, unknown>)
    .filter(([, rule]) => rule === "deny" || (rule as { action?: string })?.action === "deny")
    .map(([pattern]) => pattern);
  if (!global.includes("sudo *")) throw new Error("Global deny policy missing");
  if (!Object.keys(WORKER_POLICY).length) throw new Error("Worker policy was not generated");
  const agents = new Map(Object.entries(WORKER_POLICY).map(([name, policy]) => [name, policy.bashDenies]));
  const staticAllows = Object.entries(config.permission.bash as Record<string, unknown>)
    .filter(([, rule]) => rule === "allow" || (rule as { action?: string })?.action === "allow")
    .map(([pattern]) => pattern);
  return { global, staticAllows, agents };
}

function bashDenied(command: string, agent: string | undefined, denies: Denies): boolean {
  if (agent && !denies.agents.has(agent)) return true;
  const patterns = [...denies.global, ...(agent ? denies.agents.get(agent)! : [])];
  return canonicalCommands(command).some((value) => patterns.some((pattern) => matchesDeny(value, pattern)));
}

function inlineEnvironmentOverridesWhitelist(command: string, denies: Denies): boolean {
  return (literalCommands(command) ?? []).some((original) => {
    const words = [...original];
    while (["if", "then", "else", "elif", "while", "until", "do", "!", "{"].includes(words[0])) words.shift();
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) return false;
    // Upstream strips these assignments before matching command patterns. PATH,
    // loader options and Git configuration can turn an exact read-only spelling
    // into code execution; unknown variables are not evidence of safety either.
    // Work on decoded words, without reparsing quoted interpreter source.
    return canonicalWords(words).some((value) =>
      /^git (?:status|diff|log|show|ls-files)(?: |$)/.test(value) ||
      denies.staticAllows.some((pattern) => matchesDeny(value, pattern)));
  });
}

function expandingHeredocFeedsWhitelist(command: string, denies: Denies): boolean {
  let found = false;
  literalCommands(command, (owner) => {
    if (canonicalWords(owner).some((value) => denies.staticAllows.some((pattern) => matchesDeny(value, pattern)))) {
      found = true;
    }
  });
  return found;
}

function indirectReaderInput(command: string, denies: Denies): boolean {
  const reader = (words: string[]) => canonicalWords(words).some((value) => /^(head|wc|cat|tail|cut|nl|sha256sum|readlink)( |$)/.test(value));
  // The upstream path gate sees lexical paths, not shell-expanded filenames.
  // Conservative even for quoted metacharacters: enumerate literal paths or
  // use an explicit env wrapper to request normal approval for these forms.
  const dynamic = (word: string) => /[$*?\[\]{}~`]/.test(word.replace(/^~\//, ""));
  let blocked = false;
  const commands = literalCommands(command, undefined, (word, owner) => {
    if (canonicalWords(owner).some((value) => denies.staticAllows.some((pattern) => matchesDeny(value, pattern))) && dynamic(word)) blocked = true;
  });
  for (const words of commands ?? []) {
    if (!reader(words)) continue;
    if (words.some(dynamic)) blocked = true;
    // wc follows every filename in this file (or stdin), bypassing the path
    // gate. GNU getopt also accepts unambiguous prefixes such as --f=names.
    if (canonicalWords(words).some((value) => value.startsWith("wc ")) &&
        words.some((word) => {
          const option = word.split("=", 1)[0];
          return option.startsWith("--") && option.length > 2 && "--files0-from".startsWith(option);
        })) blocked = true;
  }
  return blocked;
}

// Keep printf away from shell-variable assignment (-v / %n), and checksums
// away from indirect filename lists (--check, including getopt abbreviations).
// Unsupported forms can use env to enter normal approval.
function unsafeOutputUtility(command: string): boolean {
  let blocked = false;
  literalCommands(command, undefined, undefined, (words, expansions) => {
    const values = canonicalWords(words);
    const name = ["printf", "sha256sum"].find((name) => values.some((value) => value === name || value.startsWith(`${name} `)));
    if (!name) return;
    const start = words.findIndex((word) => basename(word) === name);
    const args = words.slice(start + 1);
    const expanded = expansions.slice(start + 1);
    if (name === "printf") {
      const index = args[0] === "--" ? 1 : 0;
      const format = args[index];
      if (format === undefined || expanded[index] || (index === 0 && format.startsWith("-")) ||
          format.replace(/%(?:s|%)/g, "").includes("%")) blocked = true;
      return;
    }
    let operands = false;
    for (const arg of args) {
      if (operands || arg === "-" || !arg.startsWith("-")) continue;
      if (arg === "--") { operands = true; continue; }
      if (["--binary", "--text", "--tag", "--zero", "--help", "--version"].includes(arg) || /^-[btz]+$/.test(arg)) continue;
      blocked = true;
    }
  });
  return blocked;
}

// The static rg form deliberately uses an option terminator. This keeps its
// pattern/path boundary explicit without implementing ripgrep's entire CLI.
// Existing shell word decoding supplies expansion metadata; quoted regex
// metacharacters are data, whereas expanded operands evade upstream path gates.
function unsafeRipgrep(command: string): boolean {
  let blocked = false;
  literalCommands(command, undefined, (word, owner) => {
    if (basename(owner[0] ?? "") === "rg" && /[$*?\[\]{}~`]/.test(word.replace(/^~\//, ""))) blocked = true;
  }, (words, expansions) => {
    if (!canonicalWords(words).some((value) => value.startsWith("rg --no-config "))) return;
    words = words.slice(words.findIndex((word) => basename(word) === "rg"));
    if (expansions.some(Boolean)) { blocked = true; return; }
    const flags = new Set(["-n", "--line-number", "-i", "--ignore-case", "-s", "--case-sensitive",
      "-S", "--smart-case", "-F", "--fixed-strings", "-w", "--word-regexp", "-x", "--line-regexp",
      "-v", "--invert-match", "-l", "--files-with-matches", "-c", "--count",
      "--count-matches", "-o", "--only-matching", "-q", "--quiet", "-H", "--with-filename",
      "-h", "--no-filename", "--hidden", "--no-heading", "--heading", "--null", "-0"]);
    let files = false;
    let depthZero = false;
    let i = 2;
    while (i < words.length && words[i] !== "--") {
      const flag = words[i++];
      if (flag === "--files") { files = true; continue; }
      if (["-d", "--max-depth"].includes(flag) && words[i] === "0") { depthZero = true; i += 1; continue; }
      if (flags.has(flag)) continue;
      if (["-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not"].includes(flag) && i < words.length) { i += 1; continue; }
      if (["-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context"].includes(flag) && /^\d+$/.test(words[i] ?? "")) { i += 1; continue; }
      blocked = true;
      return;
    }
    if (words[i++] !== "--") { blocked = true; return; }
    if (!files && words[i++] === undefined) { blocked = true; return; }
    const paths = words.slice(i);
    // Upstream treats the first --files operand as a regex and misses its
    // external-directory gate. Keep listing rooted at the current directory.
    if (files) {
      if (paths.length > 1 || (paths.length === 1 && paths[0] !== ".")) blocked = true;
      return;
    }
    if (!paths.length || paths.some((path) => !path || /[$*?\[\]{}~`]/.test(path.replace(/^~\//, "")))) { blocked = true; return; }
    // Depth zero prevents reading directory descendants even after cd, or if
    // a file changes into a directory between validation and execution.
    if (!depthZero && paths.some((path) => path !== "-")) blocked = true;
  });
  return blocked;
}

// Check literal Git queries even after session approval bypasses the Bash gate.
// Unsupported forms retain an explicit `env git ...` normal-review route: the
// upstream matcher keys wrapped commands by the wrapper, so no `git ...` grant
// covers them, and Luna still checkpoints wrapped show/config forms.
// In particular, show must be metadata-only: its default includes file contents.
function unsafeGitQuery(source: string): boolean {
  let blocked = false;
  literalCommands(source, undefined, undefined, (original, expansions) => {
    const git = parseGitInvocation(original, expansions);
    if (!git || git.wrapped) return;
    if (!isGitQuery(git)) {
      if (unknownGlobalsMayHideQuery(git)) blocked = true;
      return;
    }
    const kind = git.subcommand!.toLowerCase();
    if (git.unknownGlobals || git.configOverride || git.expansions) { blocked = true; return; }
    const args = git.args;
    let showCommit = false;
    const statusFlags = new Set(["-s", "-b", "--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all", "--ignored", "--ignored=matching", "--ignored=traditional"]);
    const historyFlags = new Set(["--oneline", "--no-decorate", "--decorate", "--decorate=short", "--decorate=full", "--no-walk", "--no-patch", "-s", "--format=%ci", "--format=%cI", "--format=%H", "--format=%h", "--format=%s", "--format=fuller"]);
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--" && (kind === "status" || (kind === "log" && i === args.length - 1))) return;
      if ((kind === "status" ? statusFlags : historyFlags).has(arg)) continue;
      if (kind !== "status" && /^-[1-9]\d{0,2}$/.test(arg)) continue;
      if (kind !== "status" && /^(?:-n|--max-count=)[1-9]\d{0,2}$/.test(arg)) continue;
      if (kind !== "status" && ["-n", "--max-count"].includes(arg) && /^[1-9]\d{0,2}$/.test(args[i + 1] ?? "")) { i += 1; continue; }
      // `git show -s <blob>` still prints its contents. Only commit-constrained
      // show revisions are metadata queries; log itself traverses commits only.
      if (kind === "show" && (/^HEAD(?:[~^][0-9]*)+$/.test(arg) || /^[A-Za-z0-9_@][A-Za-z0-9_./~^@{}+-]*\^\{commit\}$/.test(arg))) { showCommit = true; continue; }
      if (kind === "log" && /^[A-Za-z0-9_@][A-Za-z0-9_./~^@{}+-]*$/.test(arg)) continue;
      blocked = true;
    }
    if (kind === "show" && (!showCommit || !args.some((arg) => arg === "-s" || arg === "--no-patch"))) blocked = true;
  });
  return blocked;
}

// Upstream misses a new bare output filename when classifying worker writes.
// Keep the action on the normal path gate by requiring its explicit ./ spelling.
function missedWorkerRedirect(command: string, ctx: ExtensionContext): boolean {
  const agent = activeAgent(ctx);
  if (agent === undefined || !Object.hasOwn(WORKER_POLICY, agent)) return false;
  const bareTargets: string[] = [];
  const commands = literalCommands(command, undefined, (word, _owner, operator) => {
    if (![">", ">>", ">|", "<>", ">&"].includes(operator) ||
        (operator === ">&" && /^(?:[0-9]+-?|-)$/.test(word))) return;
    if (word && !word.includes("/")) bareTargets.push(word);
  });
  const changesCwd = commands?.some((words) => canonicalWords(words).some((value) => value === "cd" || value.startsWith("cd ")));
  return bareTargets.some((word) => changesCwd || !existsSync(resolve(ctx.cwd, word)));
}

function registerGuard(pi: ExtensionAPI, root = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"))): void {
  let denies: Denies | undefined;
  const reload = () => {
    try {
      denies = loadDenies(root);
    } catch {
      denies = undefined;
    }
  };
  // Observational readiness only; this never grants permission. The nonce and
  // per-start identity prevent a stale child/extension acknowledgement being
  // reused after shutdown. Unrendered source has no trusted profile metadata.
  let ready: { sessionId: string; instanceId: string } | undefined;
  let readyContext: ExtensionContext | undefined;
  let disposeScopeCheck: (() => void) | undefined;
  pi.events.on("permissions:ready", (event: unknown) => {
    const sessionId = (event as { sessionId?: string })?.sessionId;
    if (!sessionId || sessionId !== ready?.sessionId) return;
    const services = (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-permission-system:session-services")];
    const service = services instanceof Map ? services.get(sessionId) as PermissionsService | undefined : undefined;
    if (!service) return;
    disposeScopeCheck?.();
    disposeScopeCheck = service.registerAuthorizer("directory-search-scope", async (details) => {
      if (details.payload.request.toolName !== "grep" ||
          !["path_read", "external_directory_read"].includes(details.payload.request.surface)) return { kind: "defer" };
      const path = details.accessIntent?.boundaryValue;
      if (typeof path !== "string" || !isAbsolute(path)) return { kind: "defer" };
      try {
        if (!(await stat(path)).isDirectory()) return { kind: "defer" };
      } catch { return { kind: "deny", reason: "Cannot inspect the requested search scope. Use an existing explicit file path." }; }
      return { kind: "deny", reason: "Recursive grep cannot use a one-time directory grant for its descendants. Search explicit files, or have the user configure read access for this exact directory and its descendants before retrying. No directory approval was requested." };
    });
  });
  const unsubscribeProbe = pi.events.on("pi-agent-harness:static-guard:probe", (data: unknown) => {
    const probe = data as { sessionId?: unknown; nonce?: unknown; profile?: unknown } | undefined;
    if (!ready || probe?.sessionId !== ready.sessionId || typeof probe.nonce !== "string" ||
        typeof probe.profile !== "string" || !Object.hasOwn(WORKER_POLICY, probe.profile)) return;
    reload();
    if (!denies || !readyContext) return;
    // Child admission requires the trusted host's session entry, not a regex
    // match in composed instructions (project examples can contain markers).
    // Legacy tool policy retains its prompt fallback; ordinary parents need no
    // child identity. Never serialize the captured context onto the event bus.
    try { if (recordedAgent(readyContext) !== probe.profile) return; }
    catch { return; }
    pi.events.emit("pi-agent-harness:static-guard:ready", {
      protocol: 1, ...ready, nonce: probe.nonce, profile: probe.profile,
      definitionDigest: WORKER_POLICY[probe.profile].digest,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    disposeScopeCheck?.();
    disposeScopeCheck = undefined;
    reload();
    ready = denies ? { sessionId: ctx.sessionManager.getSessionId(), instanceId: randomUUID() } : undefined;
    readyContext = ready ? ctx : undefined;
  });
  pi.on("session_shutdown", () => {
    disposeScopeCheck?.();
    disposeScopeCheck = undefined;
    ready = undefined;
    readyContext = undefined;
    unsubscribeProbe();
  });
  pi.on("tool_call", (event, ctx) => {
    // The tool-input union has no common `path`, so read it as an optional
    // unknown rather than asserting a shape this handler never established.
    const inputPath = (event.input as { path?: unknown }).path;
    if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName) &&
        typeof inputPath === "string" && /^@?file:/i.test(inputPath.trimStart())) {
      return { block: true, reason: "file: URLs are not supported by the permission path normalizer. Use a filesystem path." };
    }
    if (event.toolName === "grep") {
      try {
        if (policyGrepRegistry().get(ctx.sessionManager.getSessionId())?.isBound()) return;
      } catch { /* A missing SDK binding must not permit an unchecked tool. */ }
      return { block: true, reason: "Permission-aware grep is unavailable or shadowed by another tool. Use read on explicit files." };
    }
    if (event.toolName !== "bash") return;
    reload();
    if (!denies || typeof event.input.command !== "string") {
      return { block: true, reason: "Static Bash deny policy is unavailable." };
    }
    try {
      if (canonicalCommands(event.input.command).some(command => /^cd -/.test(command))) {
        return { block: true, reason: "Use an explicit directory operand for cd. OLDPWD and cd option forms do not have a proven working-directory scope." };
      }
      if (missedWorkerRedirect(event.input.command, ctx)) {
        return { block: true, reason: "The upstream parser misses worker writes to new bare filenames. Spell the output as ./filename so path_write approval is applied." };
      }
      if (unsafeOutputUtility(event.input.command)) {
        return { block: true, reason: "Static printf requires a literal text/%s/%% format; sha256sum requires direct input and supported output flags. Use an env wrapper for normal approval of other forms." };
      }
      if (unsafeGitQuery(event.input.command)) {
        return { block: true, reason: "Static Git status/log/show accepts only literal read-only metadata arguments; show needs -s/--no-patch and an explicit commit-constrained revision such as HEAD^0. Use env git for normal approval of other forms." };
      }
      if (unsafeRipgrep(event.input.command)) {
        return { block: true, reason: "Static rg requires --no-config, safe flags, -d 0, then -- and a pattern plus literal paths (or stdin - without -d 0); --files lists only the current directory. Use an env wrapper for normal approval of other forms." };
      }
      if (indirectReaderInput(event.input.command, denies)) {
        return { block: true, reason: "Reader static allowance requires literal paths and direct input; expand filenames explicitly or use an env wrapper for normal approval." };
      }
      if (expandingHeredocFeedsWhitelist(event.input.command, denies)) {
        return { block: true, reason: "Command substitutions in an expanding heredoc are outside the static whitelist; use an explicit env wrapper for normal approval." };
      }
      if (inlineEnvironmentOverridesWhitelist(event.input.command, denies)) {
        return { block: true, reason: "Inline environment overrides are outside the static whitelist; use an explicit env wrapper for normal approval." };
      }
      if (bashDenied(event.input.command, activeAgent(ctx), denies)) {
        return { block: true, reason: "A declarative Bash deny applies to this command after literal normalization; session approvals cannot override it." };
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error && error.message === "AMBIGUOUS_ACTIVE_AGENT" ?
        "Conflicting legacy active_agent markers; a trusted session identity is required for Bash." : "Cannot determine the active Bash deny policy." };
    }
  });
}

function safetySelfTest(root: string): void {
  const handlers = new Map<string, (...args: any[]) => any>();
  registerGuard({
    registerTool: () => {},
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI, root);
  handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => "static-selftest" } });
  const scratch = mkdtempSync(join(tmpdir(), "pi-guard-test-"));
  try {
    writeFileSync(join(scratch, ".env"), "FAKE_SECURITY_FIXTURE=not-a-secret\n");
    writeFileSync(join(scratch, "normal.txt"), "safe fixture\n");
    symlinkSync(scratch, join(scratch, "linked-directory"));
    const context = (agent?: string) => ({
      cwd: scratch,
      getSystemPrompt: () => agent ? `<active_agent name="${agent}">` : "",
      sessionManager: { getEntries: () => [], getSessionId: () => "static-selftest" },
    });
    const call = (toolName: string, input: Record<string, unknown>, agent?: string) =>
      handlers.get("tool_call")!({ toolName, input }, context(agent));
    // The grep override exercises descendant permissions in check-pi-policy.mjs.
    const denied = [
      ...["git show -s", "git show -s HEAD", "git show HEAD", "git show -s deadbeef", "git show -s refs/tags/blob", "git show -s HEAD:.env", "git show -s --output=ordinary.txt HEAD", "git log -5 --oneline --ext-diff", "git log --textconv", "git log --format=raw --patch", "git status --short -- $INPUT", "git log -5 --oneline $REF", "command git show HEAD", "if true; then git log --textconv; fi",
        "git -P show -s deadbeef", "git -p show -s deadbeef", "git --bare show -s HEAD", "git --namespace=foo show -s HEAD",
        "git -C . show -s deadbeef", "git -C . -P show -s deadbeef", "git -P -C . show -s deadbeef", "command git -P show -s deadbeef",
        "git --git-dir=.git show -s deadbeef", "GIT_CONFIG_PARAMETERS=\"'core.pager=cat'\" git log -1 --oneline",
      ].map((command) => [undefined, command]),
      ["unlisted-worker", "git status --short"],
      ["reader", "echo fixture > new-output"],
      ["editor", "pwd >> new-output"],
      ["reader", "cd linked-directory && echo fixture > normal.txt"],
      ...["nl *.txt", "nl $INPUT", "sha256sum *.txt", "sha256sum $INPUT", "sha256sum < $INPUT",
        "sha256sum -c sums", "sha256sum --check sums", "sha256sum --ch sums", "sha256sum --check=sums",
        "sha256sum -bc sums", "sha256sum --ignore-missing sums", "sha256sum -- sums*",
        "printf -v PATH fixture", "printf '%n' PATH", "printf '%s%n' ok PATH", "printf '%q' ok",
        "printf '%(x)T' 0", "printf \"$FORMAT\" ok", "printf $(echo %s) ok", "printf -- '%n' PATH",
        "printf '%s' ok > $OUTPUT", "echo ok > $OUTPUT", "PATH=/fixture echo ok", "PATH=/fixture printf ok",
        "echo ok <<EOF\n$(touch fixture)\nEOF", "printf ok <<EOF\n$(touch fixture)\nEOF",
      ].map((command) => [undefined, command]),
      [undefined, 'wc -l <<< "$(PATH=/fixture git status --short)"'],
      [undefined, "cat *"], [undefined, "tail ${INPUT}"], [undefined, "cut -f 1 *.txt"],
      [undefined, "readlink $INPUT"], [undefined, "readlink *.txt"],
      [undefined, "tr a-z A-Z < *.txt"], [undefined, "tr a-z A-Z < $INPUT"], [undefined, "sort < $INPUT"], [undefined, "uniq < *.txt"],
      [undefined, "rg --no-config -- fixture ordinary.txt"],
      [undefined, "rg --no-config -d 0 -- fixture *.txt"],
      [undefined, "rg --no-config -d 0 -- [ab]* normal.txt"],
      [undefined, "rg --no-config -d 0 -- fixture $INPUT"],
      [undefined, "rg --no-config -d 0 -- fixture - < *.txt"],
      [undefined, "rg --no-config --pre cat -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -z -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --hostname-bin=fixture -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -f patterns -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --ignore-file patterns -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --follow -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -d 0 -d 2 -- fixture normal.txt"],
      [undefined, "rg --no-config --files --pre cat -- ."],
      [undefined, "rg --no-config --files -- /var/lib/pi-policy-fixture"],
      [undefined, "rg --no-config --files -- linked-directory"],
      [undefined, "rg --no-config --files -- . .."],
      [undefined, "rg --no-config --files --glob=$INPUT -- ."],
      [undefined, "cd linked-directory && rg --no-config -- fixture normal.txt"],
      [undefined, "if true; then rg --no-config --pre cat -- fixture normal.txt; fi"],
      [undefined, "PATH=/fixture rg --no-config -d 0 -- fixture normal.txt"],
      [undefined, "head *"], [undefined, "wc -l *.txt"],
      [undefined, "head ${INPUT}"], [undefined, "head < *"], [undefined, "< * head -n 10"],
      [undefined, "wc --files0-from=names"], [undefined, "wc --files0-from names"],
      [undefined, "wc --f=names"], [undefined, "wc --files0-fr names"],
      [undefined, "wc --files0-from=-"], [undefined, "PATH=/fixture head ordinary.txt"],
      [undefined, "wc -l <<EOF\n$(PATH=/fixture git status --short)\nEOF"],
      [undefined, "wc -l <<-EOF\n\t`PATH=/fixture git status --short`\n\tEOF"],
      [undefined, "PATH=./fixture-bin git status --short"],
      [undefined, 'PATH="`pwd`" git status --short'],
      [undefined, "PATH=$(pwd) git status --short"],
      [undefined, 'PATH="$(pwd)" git status --short'],
      [undefined, "PATH=`pwd` git status --short"],
      [undefined, 'GIT_CONFIG_VALUE_0="`pwd`/fixture" git status --short'],
      [undefined, "PATH=./fixture-bin node --version"],
      [undefined, "LD_PRELOAD=./fixture.so python3 --version"],
      [undefined, "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./fixture-hook git status --short"],
      [undefined, "LC_ALL=C git diff --stat"],
      [undefined, "FOO='a b' git status --short && git diff --check"],
      [undefined, "git diff --check; FOO=bar git status --short"],
      [undefined, "FOO=bar command git status --short"],
      [undefined, "sudo true"], [undefined, "/run/wrappers/bin/sudo true"],
      [undefined, "sudo\ttrue"], [undefined, '\"sudo\" true'], [undefined, '\"sudo\"'],
      [undefined, 's"u"do true'], [undefined, '"sudo" "$USER"'],
      [undefined, '/run/wrappers/bin/sudo true; echo "$HOME"'],
      [undefined, 'echo "$HOME"; "sudo" true'],
      [undefined, 'printf ok > /tmp/out; "sudo" true'],
      [undefined, 'if true; then "sudo" true; fi'],
      [undefined, '>/tmp/out "sudo" true'], [undefined, '2>&1 "sudo" true'],
      [undefined, 'while false; do "sudo" true; done'], [undefined, "true && /run/wrappers/bin/sudo true | cat"],
      ["reader", "git --no-pager push"], ["reader", "git -C '/tmp/a b' --no-pager push origin main"],
      ["reader", "'/usr/bin/git' --paginate commit -m fixture"],
      ["editor", "git --no-pager commit --amend"],
      ["editor", "git -P commit --amend"], ["editor", "git -P push --force"],
      ["editor", "git -p commit --amend"], ["editor", "git -C /tmp -P push --force"],
      ["editor", "git -C /tmp --no-pager push origin main --force-with-lease"],
      ["editor", "git --git-dir=/tmp/foo status"], ["editor", "git --no-pager -c core.pager=cat status"],
      [undefined, 'cat <<\'EOF\'\nsudo true\nEOF\n"sudo" true'],
      [undefined, 'cat <<-"EOF"\n\tsudo true\n\tEOF\n"sudo" true'],
      [undefined, 'cat <<A <<\'B\'\nsudo true\nA\nsudo true\nB\n"sudo" true'],
      [undefined, '"sudo" true; cat <<\'EOF\'\nsafe fixture\nEOF'],
    ];
    for (const [agent, command] of denied) {
      // This callback runs even when an upstream session grant returned allow.
      if (!call("bash", { command }, agent)?.block) throw new Error(`Literal deny escaped: ${agent}: ${command}`);
    }
    for (const [command, subcommand, unknown, wrapped, config] of [
      ["git -P show -s deadbeef", "show", false, false, false],
      ["git --bare show -s HEAD", "show", false, false, false],
      ["command git -P show -s deadbeef", "show", false, false, false],
      ["timeout 5 git -P show -s deadbeef", "show", false, true, false],
      ["env git -C . show -s deadbeef", "show", false, true, false],
      ["env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git -p log", "log", false, true, true],
      ["GIT_CONFIG_PARAMETERS=x git -p log", "log", false, false, true],
    ] as const) {
      const [invocation] = inspectGitCommands(command);
      if (invocation?.subcommand !== subcommand || invocation.unknownGlobals !== unknown ||
          invocation.wrapped !== wrapped || invocation.configOverride !== config) {
        throw new Error(`Git invocation parse drifted: ${command}`);
      }
    }
    for (const command of [
      "nl -ba normal.txt", "sha256sum normal.txt", "sha256sum -btz normal.txt", "sha256sum --tag normal.txt",
      "sha256sum -- --check", "sha256sum - < normal.txt", "printf 'exit=%s\\n' \"$?\"",
      "printf '%s %% done\\n' \"$status\"", "printf -- '-%s' ok", "echo \"$status\"",
      "env printf -v PATH fixture", "env printf \"$FORMAT\" ok", "env sha256sum --check sums",
      "wc -l <<'EOF'\n$(PATH=/fixture git status --short)\nEOF",
      "wc -l <<\\EOF\n$(PATH=/fixture git status --short)\nEOF",
      "wc -l <<EOF\nplain fixture text\nEOF",
      "env wc -l <<EOF\n$(PATH=/fixture git status --short)\nEOF",
      "cat -n normal.txt", "tail -n 20 normal.txt", "cut -f 1 normal.txt", "tr a-z A-Z < normal.txt", "tr '[:upper:]' '[:lower:]' < normal.txt",
      "sort -u < normal.txt", "uniq -c < normal.txt",
      "rg --no-config -n -d 0 -- '[ab]*$|x(y)' normal.txt",
      "rg --no-config -d 0 -- 'fixture with spaces' normal.txt",
      "rg --no-config -F -d 0 -- '--pre cat' normal.txt",
      "rg --no-config -- fixture - < normal.txt",
      "rg --no-config --files --hidden -g '*.txt' -- .",
      "rg --no-config --files --",
      "cd linked-directory && rg --no-config -d 0 -- fixture normal.txt",
      "env rg --pre cat fixture .",
      "head -45 normal.txt", "wc -l -c normal.txt", "head -n 10 < normal.txt",
      "env wc --files0-from=names", "env head *.txt",
      "env PATH=./fixture-bin git status --short",
      // Wrapped Git keeps the documented normal-review route (Luna checkpoints show).
      "env git show HEAD", "env git -P show -s deadbeef", "timeout 5 git -P show -s deadbeef",
      "FOO=bar python3 -c 'print(1); print(2)'",
      "echo ok >./sudo", "echo ok 2>&1", "echo ok 2>&-", "git diff -- path", "git --no-pager status && git diff --stat",
      "git log --oneline HEAD~5..HEAD", "git log -n5", "git log --max-count=5", "git show -s --format=%ci HEAD~1", "git show -s HEAD^{commit}", "git log --oneline @{1}",
      "git -P status", "git -P show -s --format=%ci HEAD^0", "git -C . status --short",
      "printf ok | cat", "python3 -c 'x=1; print(x)'", 'node -e \'console.log("hello; world")\'',
      "cat <<'EOF'\nsudo true\nEOF", "cat <<EOF\nsudo true\nEOF\nprintf done",
      "python3 - <<'PY'\nsudo = 'fixture'\nprint(sudo)\nPY",
      'cat <<-"EOF"\n\tsudo true\n\tEOF\nprintf done',
      "cat <<'first end' <<SECOND\nsudo true\nfirst end\nsudo true\nSECOND\nprintf done",
    ]) {
      if (call("bash", { command }, "reader")) throw new Error(`Safe literal blocked: ${command}`);
    }
    for (const agent of Object.keys(WORKER_POLICY)) {
      if (call("bash", { command: "git status --short" }, agent)) throw new Error(`Managed worker cannot inspect status: ${agent}`);
      if (!call("bash", { command: "sudo true" }, agent)?.block) throw new Error(`Worker escaped global deny: ${agent}`);
    }
    // Git mutations are the parent's in every profile.
    for (const agent of Object.keys(WORKER_POLICY)) {
      if (!call("bash", { command: "git --no-pager commit -m fixture" }, agent)?.block) throw new Error(`Worker committed: ${agent}`);
    }
    // Identity decides the deny set: a reader may not rm, an editor may.
    const remove = { toolName: "bash", input: { command: "rm normal.txt" } };
    for (const [parent, child] of [["editor", "reader"], ["reader", "editor"]]) {
      const ctx = { ...context(), getSystemPrompt: () => `<active_agent name="${parent}"/>\n<active_agent name="${child}"/>` };
      if (!handlers.get("tool_call")!(remove, ctx)?.block) throw new Error("Ambiguous legacy identity was accepted");
    }
    const repeated = { ...context(), getSystemPrompt: () => '<active_agent name="editor"/>\n<ACTIVE_AGENT name="editor"/>' };
    if (handlers.get("tool_call")!(remove, repeated)) throw new Error("Identical legacy markers blocked");
    for (const agent of ["reader", "editor"]) {
      const trusted = { ...context(), getSystemPrompt: () => '<active_agent name="editor"/>\n<active_agent name="reader"/>',
        sessionManager: { getEntries: () => [{ type: "custom", customType: "active_agent", data: { name: agent } }] } };
      if (!!handlers.get("tool_call")!(remove, trusted)?.block !== (agent === "reader")) throw new Error("Prompt markers overrode trusted child entry");
    }
    if (call("bash", { command: "git status --short" })) throw new Error("Marker-free parent blocked");
    for (const agent of [undefined, "editor", "reader"]) {
      for (const command of ["git log -5 --oneline", "git log --oneline -n 20 HEAD", "git status --short -- normal.txt", "git status --short --ignored", "git show -s --format=%ci HEAD^0", "mktemp -d"]) {
        if (call("bash", { command }, agent)) throw new Error(`Read-only query blocked: ${agent}: ${command}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("static-safety-guard loaded literal-denies-and-policy-grep");
}

export default function staticSafetyGuard(pi: ExtensionAPI): void {
  if (process.env.PI_STATIC_SAFETY_SELFTEST) safetySelfTest(process.env.PI_STATIC_SAFETY_SELFTEST);
  registerGuard(pi);
}
