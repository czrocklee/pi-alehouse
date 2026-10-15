// Per-reader temporary files, not a sandbox for Bash or opaque programs.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { ForwardedAccessIntent } from "#src/authority/permission-forwarding";
import type { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizePathPolicyLiteral } from "#src/access-intent/path-normalization";
import type { ScopeConfig } from "#src/types";

export interface ReaderScratchLease {
  readonly directory: string;
  release(): void;
}
interface Scratch {
  readonly directory: string;
  readonly canonical: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}
const key = Symbol.for("pi-alehouse:reader-scratch:v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

function records(): Map<string, Scratch> {
  if (globals[key] === undefined) Object.defineProperty(globals, key, {
    value: Object.freeze({ version: 1, entries: new Map<string, Scratch>() }),
    configurable: false, writable: false, enumerable: false,
  });
  const registry = globals[key] as { version: number; entries: Map<string, Scratch> };
  assert(Object.isFrozen(registry) && registry.version === 1 && registry.entries instanceof Map,
    "Reader scratch registry is unavailable");
  return registry.entries;
}
function validRoot(record: Scratch): boolean {
  try {
    const stat = lstatSync(record.directory, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === record.dev &&
      stat.ino === record.ino && stat.uid === record.uid && (stat.mode & 0o7777n) === 0o700n &&
      realpathSync(record.directory) === record.canonical;
  } catch { return false; }
}

/** Called only by the trusted child factory, with the actual SDK session ID. */
export function createReaderScratch(sessionId: string): ReaderScratchLease {
  assert(typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256, "Invalid reader session");
  const entries = records();
  assert(!entries.has(sessionId), "Reader scratch is already assigned");
  const directory = mkdtempSync("/tmp/pi-alehouse-reader-");
  chmodSync(directory, 0o700);
  const stat = lstatSync(directory, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.geteuid!()), "Invalid reader scratch directory");
  const record: Scratch = Object.freeze({ directory, canonical: realpathSync(directory), dev: stat.dev, ino: stat.ino, uid: stat.uid });
  entries.set(sessionId, record);
  return Object.freeze({ directory, release() {
    // Revoke only. Retain reports for the parent; never recursively remove a
    // path whose ownership or execution state could have changed.
    if (entries.get(sessionId) === record) entries.delete(sessionId);
  } });
}

function strictCanonical(path: string): string | undefined {
  let ancestor = path;
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      const parent = dirname(ancestor);
      if (parent === ancestor) return;
      tail.unshift(ancestor.slice(parent.endsWith("/") ? parent.length : parent.length + 1));
      ancestor = parent;
      continue;
    }
    try {
      const canonical = realpathSync(ancestor);
      if (tail.length && !statSync(canonical).isDirectory()) return;
      return resolve(canonical, ...tail);
    } catch { return; }
  }
}
function safeEntries(root: string, path: string): boolean {
  let current = root;
  const segments = path.slice(root.length + 1).split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current += `/${segments[index]}`;
    try {
      const stat = lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isDirectory() &&
        (index !== segments.length - 1 || !stat.isFile() || stat.nlink !== 1n))) return false;
    } catch (error) {
      // A missing entry below an inspected directory is a valid new-file tail.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}
function contains(record: Scratch, values: readonly string[]): boolean {
  if (!validRoot(record) || values.some(value => normalizePathPolicyLiteral(value) !== value ||
    // Pi's built-in write normalizes these spaces. Reject changing spellings
    // instead of approving a different filesystem target than it will execute.
    /[\x00-\x1f\x7f\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(value) ||
    value.split("/").some(part => part === "." || part === ".."))) return false;
  const absolute = values.filter(value => isAbsolute(value));
  if (!absolute.length || !within(absolute[0]!, record.directory) ||
      !safeEntries(record.directory, absolute[0]!)) return false;
  return absolute.every(path => {
    if (resolve(path) !== path || (!within(path, record.directory) && !within(path, record.canonical))) return false;
    const canonical = strictCanonical(path);
    if (!canonical || !within(canonical, record.canonical)) return false;
    try {
      const stat = lstatSync(canonical, { bigint: true });
      if (stat.isFile() && stat.nlink > 1n) return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    return true;
  });
}
export function readerScratchDirectories(): readonly string[] {
  return [...records().values()].filter(validRoot).map(record => record.directory);
}
export function readerScratchContains(sessionId: string, path: string): boolean {
  const record = records().get(sessionId);
  return record !== undefined && isAbsolute(path) && contains(record, [path]);
}

/** Alternate scope composition must recover global/project catch-alls that
 * would otherwise have been hidden by the managed reader's same-pattern deny. */
export function readerScratchAgentScope(scope: ScopeConfig): ScopeConfig | undefined {
  const write = scope.permission?.path_write;
  if (scope.invalid || !write || typeof write !== "object" || write["*"] !== "deny" ||
      !Object.values(write).every(value => value === "deny" ||
        (typeof value === "object" && value !== null && value.action === "deny"))) return;
  const permission = { ...scope.permission };
  const remaining = Object.fromEntries(Object.entries(write).filter(([pattern]) => pattern !== "*"));
  if (Object.keys(remaining).length) permission.path_write = remaining;
  else delete permission.path_write;
  return { ...scope, permission };
}
/** Private request provenance, never a tool argument or a configuration grant. */
export interface ReaderScratchWriteContext {
  readonly sessionId: string;
  readonly token: string;
}
interface WriteRequest {
  readonly sessionId: string;
  readonly scratch: Scratch;
  readonly path: string;
}
const requestsKey = Symbol.for("pi-alehouse:reader-scratch:write-requests:v1");
function requests(): Map<string, WriteRequest> {
  if (globals[requestsKey] === undefined) Object.defineProperty(globals, requestsKey, {
    value: new Map<string, WriteRequest>(), configurable: false, writable: false, enumerable: false,
  });
  const value = globals[requestsKey];
  assert(value instanceof Map, "Reader scratch request registry is unavailable");
  return value as Map<string, WriteRequest>;
}
function builtinWrite(tools: readonly unknown[]): boolean {
  const writers = tools.filter(tool => tool && typeof tool === "object" && (tool as { name?: unknown }).name === "write");
  if (writers.length !== 1) return false;
  const source = (writers[0] as { sourceInfo?: { source?: unknown; path?: unknown } }).sourceInfo;
  return source?.source === "builtin" && source.path === "builtin:write";
}
function requestFor(context: ReaderScratchWriteContext | undefined): WriteRequest | undefined {
  if (!context || typeof context.sessionId !== "string" || typeof context.token !== "string") return;
  const request = requests().get(context.token);
  if (request && request.sessionId === context.sessionId && records().get(context.sessionId) === request.scratch &&
      contains(request.scratch, [request.path])) return request;
}

/** Called at the real SDK tool boundary after resolving the authority's agent.
 * A live per-call token proves both the originating session and built-in write.
 * It is retired when permission evaluation (including a forwarded ask) ends. */
export function beginReaderScratchWrite(ctx: ExtensionContext, toolName: string, agentName: string | null,
  input: unknown, tools: readonly unknown[]): { context: ReaderScratchWriteContext; release(): void } | undefined {
  if (toolName !== "write" || agentName !== "reader" || !builtinWrite(tools)) return;
  const path = input && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof path !== "string" || !readerScratchContains(sessionId, path)) return;
  const scratch = records().get(sessionId)!;
  const token = randomUUID();
  const request: WriteRequest = Object.freeze({ sessionId, scratch, path });
  requests().set(token, request);
  return Object.freeze({ context: Object.freeze({ sessionId, token }), release() {
    if (requests().get(token) === request) requests().delete(token);
  } });
}
export function readerScratchWriteMatches(context: ReaderScratchWriteContext | undefined, values: readonly string[]): boolean {
  const request = requestFor(context);
  return request !== undefined && values.includes(request.path) && contains(request.scratch, values);
}

/** Preserve the gate's effective reader identity, including its cached-name
 * semantics, rather than independently parsing the forwarding context. */
export function readerScratchWriteAgent(token: string, sessionId: string): "reader" | undefined {
  return requestFor({ token, sessionId }) ? "reader" : undefined;
}
export function readerScratchForwardedWrite(intent: ForwardedAccessIntent, servingSessionId: string | null,
  registry: Pick<SubagentSessionRegistry, "get">): ReaderScratchWriteContext | undefined {
  if (intent.surface !== "path_write" || intent.principal.agentName !== "reader" ||
      typeof intent.readerScratchWrite !== "string" || !servingSessionId ||
      registry.get(intent.principal.sessionId)?.parentSessionId !== servingSessionId) return;
  const context = Object.freeze({ sessionId: intent.principal.sessionId, token: intent.readerScratchWrite });
  return readerScratchWriteMatches(context, intent.matchValues) ? context : undefined;
}

/** The callback is the very same PermissionSession resolver the tool gate uses,
 * not another approximation of branch, prompt or last-known identity. */
export function installReaderScratchGuard(pi: ExtensionAPI, resolveAgent: (ctx: ExtensionContext) => string | null): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write") return;
    try {
      if (resolveAgent(ctx) !== "reader") return;
      if (builtinWrite(pi.getAllTools()) && typeof event.input.path === "string" &&
          readerScratchContains(ctx.sessionManager.getSessionId(), event.input.path)) return;
    } catch { /* Identity/source failures must never skip the early guard. */ }
    return { block: true, reason: "Reader can use write only in its own scratch directory with the built-in write tool." };
  });
}
