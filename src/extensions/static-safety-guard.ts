/**
 * Deny-only tool-entry guard for hard denies. Session approvals, yolo and the
 * model authorizer cannot override it. It closes literal spelling variants of
 * our declarative Bash denies and a few unprovable principal/path shapes; it is
 * not a sandbox for interpreters, scripts, or dynamic shell code.
 *
 * It never asks the model to respell a command. Shapes a static allow cannot
 * prove safe (dynamic operands, indirect file lists, inline environment, ...)
 * are the authority's static-allow exclusion instead: they fall back to normal
 * approval (lib/static-allow-exclusion.ts).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionsService } from "@gotgenes/pi-permission-system";
import { hasDangerousGitEnvironmentPrefix } from "./lib/git-invocation.ts";
import {
  analyzeLiteralCommands,
  canonicalCommands,
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
// Placeholder replaced by scripts/build/generate-workers.mjs from resources/worker-policy.json.
const WORKER_POLICY = freezePolicy(/* @worker-policy@ */ {});

type Denies = {
  global: string[];
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

type PrincipalService = PermissionsService & {
  getToolCallAgentName?: (ctx: ExtensionContext) => unknown;
  bindExpectedToolCallAgent?: (
    ctx: ExtensionContext,
    profile: string,
    instanceId: string,
  ) => unknown;
  releaseExpectedToolCallAgent?: (instanceId: string) => unknown;
};

function permissionService(ctx: ExtensionContext): PrincipalService | undefined {
  const services = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@gotgenes/pi-permission-system:session-services")
  ];
  return services instanceof Map
    ? (services.get(ctx.sessionManager.getSessionId()) as PrincipalService | undefined)
    : undefined;
}

// Readiness requires the latest raw record to match exactly, not a trimmed or
// cached identity. This check can only tighten the authority's binding.
function recordedAgent(ctx: ExtensionContext): unknown {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === "active_agent")
      return (entry.data as { name?: unknown } | undefined)?.name;
  }
}

export function activeAgent(ctx: ExtensionContext): string | undefined {
  const service = permissionService(ctx);
  let name: unknown = null;
  if (service !== undefined) {
    if (typeof service?.getToolCallAgentName !== "function")
      throw new Error("UNTRUSTED_ACTIVE_AGENT");
    name = service.getToolCallAgentName(ctx);
  } else {
    // A standalone deny-only guard has no authority cache. Its record-only
    // fallback grants nothing; composed sessions always use the actual service.
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== "active_agent") continue;
      const raw = (entry.data as { name?: unknown } | undefined)?.name;
      if (typeof raw === "string" && raw.trim()) {
        name = raw.trim();
        break;
      }
      if (raw === null) break;
    }
  }
  if (name === null) return undefined;
  if (
    typeof name !== "string" ||
    !name ||
    name.trim() !== name ||
    !Object.hasOwn(WORKER_POLICY, name)
  )
    throw new Error("UNTRUSTED_ACTIVE_AGENT");
  return name;
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
  const denies = { global, agents };
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
      return hardDeny(
        "The original command matches a declarative Bash deny (checked before managed hardening).",
      );
  } catch {
    return hardDeny("The original command cannot be verified against the static Bash deny policy.");
  }
}

// Hard denies are final: rephrasing or wrapping the command must not be the
// suggested way forward. Only an alternative that changes what runs is named.
function hardDeny(reason: string, alternative = ""): string {
  return `${reason} This is a hard deny: session approvals and yolo cannot override it. Do not rephrase or wrap the command to get around it.${alternative ? ` ${alternative}` : ""} Otherwise stop and report this to the user (a subagent uses ask_parent).`;
}

const segment = (words: readonly string[]): string => {
  const text = words.join(" ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

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
  // Readiness adds an expected-principal restriction, never a grant. The nonce and
  // per-start identity prevent a stale child/extension acknowledgement being
  // reused after shutdown. Unrendered source has no trusted profile metadata.
  let ready: { sessionId: string; instanceId: string } | undefined;
  let readyContext: ExtensionContext | undefined;
  let disposeScopeCheck: (() => void) | undefined;
  let binding: { service: PrincipalService; instanceId: string; profile: string } | undefined;
  const releaseBinding = () => {
    const previous = binding;
    binding = undefined;
    previous?.service.releaseExpectedToolCallAgent?.(previous.instanceId);
  };
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
  const unsubscribeProbe = pi.events.on("pi-alehouse:static-guard:probe", (data: unknown) => {
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
    // Bind the actual gate, not a parallel guard identity. Missing APIs or a
    // duplicate guard instance cannot acknowledge readiness. Never serialize
    // the captured context or service onto the event bus.
    try {
      if (
        readyContext.sessionManager.getSessionId() !== ready.sessionId ||
        recordedAgent(readyContext) !== probe.profile
      )
        return;
      const service = permissionService(readyContext);
      if (
        !service ||
        typeof service.getToolCallAgentName !== "function" ||
        typeof service.bindExpectedToolCallAgent !== "function" ||
        typeof service.releaseExpectedToolCallAgent !== "function" ||
        (binding && binding.service !== service) ||
        service.bindExpectedToolCallAgent(readyContext, probe.profile, ready.instanceId) !== true
      )
        return;
      binding = { service, instanceId: ready.instanceId, profile: probe.profile };
      if (activeAgent(readyContext) !== probe.profile) return;
    } catch {
      return;
    }
    pi.events.emit("pi-alehouse:static-guard:ready", {
      protocol: 1,
      ...ready,
      nonce: probe.nonce,
      profile: probe.profile,
      definitionDigest: WORKER_POLICY[probe.profile].digest,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    releaseBinding();
    disposeScopeCheck?.();
    disposeScopeCheck = undefined;
    reload();
    ready = denies
      ? { sessionId: ctx.sessionManager.getSessionId(), instanceId: randomUUID() }
      : undefined;
    readyContext = ready ? ctx : undefined;
  });
  pi.on("session_shutdown", () => {
    releaseBinding();
    disposeScopeCheck?.();
    disposeScopeCheck = undefined;
    ready = undefined;
    readyContext = undefined;
    unsubscribeProbe();
  });
  pi.on("tool_call", (event, ctx) => {
    // SDK extension exceptions must not become identity admission. Return an
    // explicit block for every tool before any non-identity deny/projection.
    let agent: string | undefined;
    try {
      if (binding && permissionService(ctx) !== binding.service)
        throw new Error("UNTRUSTED_ACTIVE_AGENT");
      agent = activeAgent(ctx);
      if (binding && agent !== binding.profile) throw new Error("UNTRUSTED_ACTIVE_AGENT");
    } catch {
      return { block: true, reason: "Cannot verify the actual tool-call permission principal." };
    }
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
      return {
        block: true,
        reason: hardDeny("The static Bash deny policy is unavailable."),
      };
    }
    try {
      const command = analyzeLiteralCommands(event.input.command);
      if (canonicalCommands(command).some((value) => /^cd -/.test(value))) {
        return {
          block: true,
          reason: hardDeny(
            "`cd -` and cd option forms have no provable working directory.",
            "An explicit directory operand for cd is checked normally.",
          ),
        };
      }
      const dangerous = (literalCommands(command) ?? []).find(hasDangerousGitEnvironmentPrefix);
      if (dangerous) {
        return {
          block: true,
          reason: hardDeny(
            `Git with a PATH, loader or helper-execution environment override (\`${segment(dangerous)}\`) is refused.`,
          ),
        };
      }
      if (bashDenied(command, agent, denies)) {
        return {
          block: true,
          reason: hardDeny(
            "The command matches a declarative Bash deny after literal normalization.",
          ),
        };
      }
    } catch {
      return {
        block: true,
        reason: hardDeny("The active Bash deny policy cannot be determined."),
      };
    }
  });
}

// The self-test lives in the source check lane (scripts/checks); production
// load never imports or requires it.
export default function staticSafetyGuard(pi: ExtensionAPI): void {
  registerGuard(pi);
}
