/**
 * Deny-only tool-entry guard. Session approvals and the model authorizer cannot
 * override it. This closes literal spelling variants of our declarative Bash
 * denies; it is not a sandbox for interpreters, scripts, or dynamic shell code.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionsService } from "@gotgenes/pi-permission-system";
import { hasDangerousGitEnvironmentPrefix, parseGitInvocation } from "./lib/git-invocation.ts";
import {
  analyzeLiteralCommands,
  canonicalCommands,
  canonicalWords,
  inspectGitCommands,
  literalCommands,
  type LiteralInput,
} from "./lib/shell-literal.ts";

export { inspectGitCommands };

type WorkerPolicy = Readonly<
  Record<string, Readonly<{ digest: string; bashDenies: readonly string[] }>>
>;
// Deep-frozen and module-private: loadDenies keeps references to these arrays,
// so no importer may shrink a profile's deny floor in place.
function freezePolicy(
  policy: Record<string, { digest: string; bashDenies: string[] }>,
): WorkerPolicy {
  for (const entry of Object.values(policy)) Object.freeze(Object.freeze(entry).bashDenies);
  return Object.freeze(policy);
}
// Placeholder replaced by scripts/generate-workers.mjs from resources/worker-policy.json.
const WORKER_POLICY = freezePolicy(/* @worker-policy@ */ {});

type Denies = {
  global: string[];
  staticAllows: string[];
  agents: Map<string, readonly string[]>;
};

type PolicyGrepRegistration = { isBound: () => boolean };

export function policyGrepRegistry(): Map<string, PolicyGrepRegistration> {
  const globals = globalThis as Record<symbol, unknown>;
  const key = Symbol.for("@rocklee/pi:policy-grep:v3");
  if (!(globals[key] instanceof Map)) globals[key] = new Map<string, PolicyGrepRegistration>();
  return globals[key] as Map<string, PolicyGrepRegistration>;
}

const denyRegexes = new Map<string, RegExp>();
function matchesDeny(value: string, pattern: string): boolean {
  let regex = denyRegexes.get(pattern);
  if (!regex) {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regex = new RegExp(`^${source}$`, "s");
    // Do not retain unbounded config patterns. Unlike the wildcard matcher,
    // this deny language treats ? literally; only * is a wildcard.
    if (pattern.length <= 8192) {
      if (denyRegexes.size >= 4096) denyRegexes.clear();
      denyRegexes.set(pattern, regex);
    }
  }
  // A command without operands must not escape an existing `sudo *` deny.
  return regex.test(value) || (pattern.endsWith(" *") && value === pattern.slice(0, -2));
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
  const names = new Set(
    Array.from(
      ctx.getSystemPrompt().matchAll(/<active_agent\s+name=["']([^"']+)["'][^>]*>/gi),
      (match) => match[1].trim(),
    ),
  );
  if (names.size > 1) throw new Error("AMBIGUOUS_ACTIVE_AGENT");
  return names.values().next().value;
}

let parsedDenies: { raw: string; denies: Denies } | undefined;
function loadDenies(root: string): Denies {
  // Always read: a new deny (or an unreadable/malformed file) must be observed
  // on both sides of asynchronous hardening. Cache successful parsing only.
  const raw = readFileSync(join(root, "extensions/pi-permission-system/config.json"), "utf8");
  if (parsedDenies?.raw === raw) return parsedDenies.denies;
  const config = JSON.parse(raw);
  const global = Object.entries(config.permission.bash as Record<string, unknown>)
    .filter(([, rule]) => rule === "deny" || (rule as { action?: string })?.action === "deny")
    .map(([pattern]) => pattern);
  if (!global.includes("sudo *")) throw new Error("Global deny policy missing");
  if (!Object.keys(WORKER_POLICY).length) throw new Error("Worker policy was not generated");
  const agents = new Map(
    Object.entries(WORKER_POLICY).map(([name, policy]) => [name, policy.bashDenies]),
  );
  const staticAllows = Object.entries(config.permission.bash as Record<string, unknown>)
    .filter(([, rule]) => rule === "allow" || (rule as { action?: string })?.action === "allow")
    .map(([pattern]) => pattern);
  const denies = { global, staticAllows, agents };
  if (raw.length <= 1024 * 1024) parsedDenies = { raw, denies };
  return denies;
}

function bashDenied(command: LiteralInput, agent: string | undefined, denies: Denies): boolean {
  if (agent && !denies.agents.has(agent)) return true;
  // Only declared denies apply. Worker identity is not a Git mutation ban;
  // ordinary editor Git writes still need the normal Bash/path gates.
  const patterns = [...denies.global, ...(agent ? denies.agents.get(agent)! : [])];
  return canonicalCommands(command).some((value) =>
    patterns.some((pattern) => matchesDeny(value, pattern)),
  );
}

// Check the actual requested source before permission inspection or unrelated
// non-Git hardening. A session grant must never hide an original declared deny.
// This deny-only floor does not grant query permission.
export function originalBashDeny(
  command: string,
  ctx: ExtensionContext,
  root = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")),
): string | undefined {
  try {
    if (bashDenied(command, activeAgent(ctx), loadDenies(root)))
      return "A declarative Bash deny applies to the original command before managed hardening; session approvals cannot override it.";
  } catch {
    return "Cannot verify the original command against the static Bash deny policy.";
  }
}

function inlineEnvironmentOverridesWhitelist(command: LiteralInput, denies: Denies): boolean {
  return (literalCommands(command) ?? []).some((original) => {
    const words = [...original];
    while (["if", "then", "else", "elif", "while", "until", "do", "!", "{"].includes(words[0]))
      words.shift();
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) return false;
    // Git keeps ordinary approval for benign assignments, with a hard human
    // checkpoint on eligible asks. Selected dangerous prefixes are refused
    // separately, including env wrappers, regardless of any permission grant.
    if (parseGitInvocation(original)) return false;
    // Upstream strips these assignments before matching non-Git static allows.
    // Unknown variables are not evidence that an exact allowance stays safe.
    // Work on decoded words, without reparsing quoted interpreter source.
    return canonicalWords(words).some(
      (value) =>
        /^git (?:status|diff|log|show|ls-files)(?: |$)/.test(value) ||
        denies.staticAllows.some((pattern) => matchesDeny(value, pattern)),
    );
  });
}

function expandingHeredocFeedsWhitelist(command: LiteralInput, denies: Denies): boolean {
  let found = false;
  literalCommands(command, (owner) => {
    if (
      canonicalWords(owner).some((value) =>
        denies.staticAllows.some((pattern) => matchesDeny(value, pattern)),
      )
    ) {
      found = true;
    }
  });
  return found;
}

function indirectReaderInput(command: LiteralInput, denies: Denies): boolean {
  const reader = (words: string[]) =>
    canonicalWords(words).some((value) =>
      /^(head|wc|cat|tail|cut|nl|sha256sum|readlink)( |$)/.test(value),
    );
  // The upstream path gate sees lexical paths, not shell-expanded filenames.
  // Conservative even for quoted metacharacters: enumerate literal paths or
  // use an explicit env wrapper to request normal approval for these forms.
  const dynamic = (word: string) => /[$*?\[\]{}~`]/.test(word.replace(/^~\//, ""));
  let blocked = false;
  const commands = literalCommands(command, undefined, (word, owner) => {
    if (
      canonicalWords(owner).some((value) =>
        denies.staticAllows.some((pattern) => matchesDeny(value, pattern)),
      ) &&
      dynamic(word)
    )
      blocked = true;
  });
  for (const words of commands ?? []) {
    if (!reader(words)) continue;
    if (words.some(dynamic)) blocked = true;
    // wc follows every filename in this file (or stdin), bypassing the path
    // gate. GNU getopt also accepts unambiguous prefixes such as --f=names.
    if (
      canonicalWords(words).some((value) => value.startsWith("wc ")) &&
      words.some((word) => {
        const option = word.split("=", 1)[0];
        return option.startsWith("--") && option.length > 2 && "--files0-from".startsWith(option);
      })
    )
      blocked = true;
  }
  return blocked;
}

// Keep printf away from shell-variable assignment (-v / %n), and checksums
// away from indirect filename lists (--check, including getopt abbreviations).
// Unsupported forms can use env to enter normal approval.
function unsafeOutputUtility(command: LiteralInput): boolean {
  let blocked = false;
  literalCommands(command, undefined, undefined, (words, expansions) => {
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
        blocked = true;
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
      blocked = true;
    }
  });
  return blocked;
}

// The static rg form deliberately uses an option terminator. This keeps its
// pattern/path boundary explicit without implementing ripgrep's entire CLI.
// Existing shell word decoding supplies expansion metadata; quoted regex
// metacharacters are data, whereas expanded operands evade upstream path gates.
function unsafeRipgrep(command: LiteralInput): boolean {
  let blocked = false;
  literalCommands(
    command,
    undefined,
    (word, owner) => {
      if (basename(owner[0] ?? "") === "rg" && /[$*?\[\]{}~`]/.test(word.replace(/^~\//, "")))
        blocked = true;
    },
    (words, expansions) => {
      if (!canonicalWords(words).some((value) => value.startsWith("rg --no-config "))) return;
      words = words.slice(words.findIndex((word) => basename(word) === "rg"));
      if (expansions.some(Boolean)) {
        blocked = true;
        return;
      }
      const flags = new Set([
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
      let files = false;
      let depthZero = false;
      let i = 2;
      while (i < words.length && words[i] !== "--") {
        const flag = words[i++];
        if (flag === "--files") {
          files = true;
          continue;
        }
        if (["-d", "--max-depth"].includes(flag) && words[i] === "0") {
          depthZero = true;
          i += 1;
          continue;
        }
        if (flags.has(flag)) continue;
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
        blocked = true;
        return;
      }
      if (words[i++] !== "--") {
        blocked = true;
        return;
      }
      if (!files && words[i++] === undefined) {
        blocked = true;
        return;
      }
      const paths = words.slice(i);
      // Upstream treats the first --files operand as a regex and misses its
      // external-directory gate. Keep listing rooted at the current directory.
      if (files) {
        if (paths.length > 1 || (paths.length === 1 && paths[0] !== ".")) blocked = true;
        return;
      }
      if (
        !paths.length ||
        paths.some((path) => !path || /[$*?\[\]{}~`]/.test(path.replace(/^~\//, "")))
      ) {
        blocked = true;
        return;
      }
      // Depth zero prevents reading directory descendants even after cd, or if
      // a file changes into a directory between validation and execution.
      if (!depthZero && paths.some((path) => path !== "-")) blocked = true;
    },
  );
  return blocked;
}

// Upstream misses a new bare output filename when classifying worker writes.
// Keep the action on the normal path gate by requiring its explicit ./ spelling.
function missedWorkerRedirect(
  command: LiteralInput,
  ctx: ExtensionContext,
  agent: string | undefined,
): boolean {
  if (agent === undefined || !Object.hasOwn(WORKER_POLICY, agent)) return false;
  const bareTargets: string[] = [];
  const commands = literalCommands(command, undefined, (word, _owner, operator) => {
    if (
      ![">", ">>", ">|", "<>", ">&"].includes(operator) ||
      (operator === ">&" && /^(?:[0-9]+-?|-)$/.test(word))
    )
      return;
    if (word && !word.includes("/")) bareTargets.push(word);
  });
  const changesCwd = commands?.some((words) =>
    canonicalWords(words).some((value) => value === "cd" || value.startsWith("cd ")),
  );
  return bareTargets.some((word) => changesCwd || !existsSync(resolve(ctx.cwd, word)));
}

function registerGuard(
  pi: ExtensionAPI,
  root = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")),
): void {
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
    const services = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@gotgenes/pi-permission-system:session-services")
    ];
    const service =
      services instanceof Map
        ? (services.get(sessionId) as PermissionsService | undefined)
        : undefined;
    if (!service) return;
    disposeScopeCheck?.();
    disposeScopeCheck = service.registerAuthorizer("directory-search-scope", async (details) => {
      if (
        details.payload.request.toolName !== "grep" ||
        !["path_read", "external_directory_read"].includes(details.payload.request.surface)
      )
        return { kind: "defer" };
      const path = details.accessIntent?.boundaryValue;
      if (typeof path !== "string" || !isAbsolute(path)) return { kind: "defer" };
      try {
        if (!(await stat(path)).isDirectory()) return { kind: "defer" };
      } catch {
        return {
          kind: "deny",
          reason: "Cannot inspect the requested search scope. Use an existing explicit file path.",
        };
      }
      return {
        kind: "deny",
        reason:
          "Recursive grep cannot use a one-time directory grant for its descendants. Search explicit files, or have the user configure read access for this exact directory and its descendants before retrying. No directory approval was requested.",
      };
    });
  });
  const unsubscribeProbe = pi.events.on("pi-agent-harness:static-guard:probe", (data: unknown) => {
    const probe = data as { sessionId?: unknown; nonce?: unknown; profile?: unknown } | undefined;
    if (
      !ready ||
      probe?.sessionId !== ready.sessionId ||
      typeof probe.nonce !== "string" ||
      typeof probe.profile !== "string" ||
      !Object.hasOwn(WORKER_POLICY, probe.profile)
    )
      return;
    reload();
    if (!denies || !readyContext) return;
    // Child admission requires the trusted host's session entry, not a regex
    // match in composed instructions (project examples can contain markers).
    // Legacy tool policy retains its prompt fallback; ordinary parents need no
    // child identity. Never serialize the captured context onto the event bus.
    try {
      if (recordedAgent(readyContext) !== probe.profile) return;
    } catch {
      return;
    }
    pi.events.emit("pi-agent-harness:static-guard:ready", {
      protocol: 1,
      ...ready,
      nonce: probe.nonce,
      profile: probe.profile,
      definitionDigest: WORKER_POLICY[probe.profile].digest,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    disposeScopeCheck?.();
    disposeScopeCheck = undefined;
    reload();
    ready = denies
      ? { sessionId: ctx.sessionManager.getSessionId(), instanceId: randomUUID() }
      : undefined;
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
    if (
      ["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName) &&
      typeof inputPath === "string" &&
      /^@?file:/i.test(inputPath.trimStart())
    ) {
      return {
        block: true,
        reason:
          "file: URLs are not supported by the permission path normalizer. Use a filesystem path.",
      };
    }
    if (event.toolName === "grep") {
      try {
        if (policyGrepRegistry().get(ctx.sessionManager.getSessionId())?.isBound()) return;
      } catch {
        /* A missing SDK binding must not permit an unchecked tool. */
      }
      return {
        block: true,
        reason:
          "Permission-aware grep is unavailable or shadowed by another tool. Use read on explicit files.",
      };
    }
    if (event.toolName !== "bash") return;
    reload();
    if (!denies || typeof event.input.command !== "string") {
      return { block: true, reason: "Static Bash deny policy is unavailable." };
    }
    try {
      const command = analyzeLiteralCommands(event.input.command);
      if (canonicalCommands(command).some((value) => /^cd -/.test(value))) {
        return {
          block: true,
          reason:
            "Use an explicit directory operand for cd. OLDPWD and cd option forms do not have a proven working-directory scope.",
        };
      }
      // Resolve once for this synchronous handler, never by toolCallId and
      // never across the original-command check or an asynchronous hardener.
      const agent = activeAgent(ctx);
      if (missedWorkerRedirect(command, ctx, agent)) {
        return {
          block: true,
          reason:
            "The upstream parser misses worker writes to new bare filenames. Spell the output as ./filename so path_write approval is applied.",
        };
      }
      if (unsafeOutputUtility(command)) {
        return {
          block: true,
          reason:
            "Static printf requires a literal text/%s/%% format; sha256sum requires direct input and supported output flags. Use an env wrapper for normal approval of other forms.",
        };
      }
      if (unsafeRipgrep(command)) {
        return {
          block: true,
          reason:
            "Static rg requires --no-config, safe flags, -d 0, then -- and a pattern plus literal paths (or stdin - without -d 0); --files lists only the current directory. Use an env wrapper for normal approval of other forms.",
        };
      }
      if (indirectReaderInput(command, denies)) {
        return {
          block: true,
          reason:
            "Static file-read allowance requires literal paths and direct input; expand filenames explicitly or use an env wrapper for normal approval.",
        };
      }
      if (expandingHeredocFeedsWhitelist(command, denies)) {
        return {
          block: true,
          reason:
            "Command substitutions in an expanding heredoc are outside the static whitelist; use an explicit env wrapper for normal approval.",
        };
      }
      if ((literalCommands(command) ?? []).some(hasDangerousGitEnvironmentPrefix)) {
        return {
          block: true,
          reason:
            "Requested PATH, loader, or helper-execution environment overrides on recognized Git invocations are statically denied; session approvals cannot override this guard.",
        };
      }
      if (inlineEnvironmentOverridesWhitelist(command, denies)) {
        return {
          block: true,
          reason:
            "Inline environment overrides are outside the static whitelist; use an explicit env wrapper for normal approval.",
        };
      }
      if (bashDenied(command, agent, denies)) {
        return {
          block: true,
          reason:
            "A declarative Bash deny applies to this command after literal normalization; session approvals cannot override it.",
        };
      }
    } catch (error) {
      return {
        block: true,
        reason:
          error instanceof Error && error.message === "AMBIGUOUS_ACTIVE_AGENT"
            ? "Conflicting legacy active_agent markers; a trusted session identity is required for Bash."
            : "Cannot determine the active Bash deny policy.",
      };
    }
  });
}

// The self-test lives in the source check lane (scripts/checks); production
// load never imports or requires it.
export default function staticSafetyGuard(pi: ExtensionAPI): void {
  registerGuard(pi);
}
