// Trusted child assembly binds policy provenance; model/config JSON cannot mint it.
import { strict as assert } from "node:assert";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { synchronousPermissionSample } from "./managed-permission-snapshot";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PATH_SURFACES } from "#src/access-intent/path-surfaces";
import type { ForwardedAccessIntent } from "#src/authority/permission-forwarding";
import type { SubagentSessionRegistry } from "#src/authority/subagent-registry";

export interface WorkspacePolicyBinding {
  readonly sessionId: string;
  readonly cwd: string;
  readonly source_cwd: string;
  /** Trusted creation roots, not model-selected paths or execution grants. */
  readonly checkout_root: string;
  readonly source_root: string;
  readonly projectTrusted: boolean;
  readonly canonicalCwd: string;
  readonly canonicalSourceCwd: string;
  readonly canonicalCheckoutRoot: string;
  readonly canonicalSourceRoot: string;
}
interface Registry {
  readonly version: 1;
  // Tombstones prevent a released child context silently reverting to cwd policy.
  readonly entries: Map<string, WorkspacePolicyBinding | null>;
}
const key = Symbol.for("pi-alehouse:workspace-policy:v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const MAX_BINDINGS = 4096; // Includes retired sessions; fail visibly, never evict policy provenance.
function registry(): Registry {
  if (globals[key] === undefined) Object.defineProperty(globals, key, {
    value: Object.freeze({ version: 1, entries: new Map<string, WorkspacePolicyBinding | null>() }),
    configurable: false, writable: false, enumerable: false,
  });
  const value = globals[key] as Registry;
  assert(value && Object.isFrozen(value) && value.version === 1 && value.entries instanceof Map,
    "Workspace policy registry is unavailable");
  return value;
}
function sessionId(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value), "Invalid workspace policy session");
}
function directory(value: unknown): asserts value is string {
  assert(typeof value === "string" && isAbsolute(value) &&
    !/[\x00-\x1f\x7f]/.test(value) && statSync(value).isDirectory(), "Invalid workspace policy directory");
}
function containedTail(root: string, path: string): string {
  const tail = relative(root, path);
  assert(tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail), "Workspace policy cwd is outside its root");
  return tail;
}
export function assertWorkspacePolicy(binding: WorkspacePolicyBinding): void {
  sessionId(binding.sessionId);
  assert(registry().entries.get(binding.sessionId) === binding && Object.isFrozen(binding),
    "Workspace policy binding is stale or forged");
  // Registry/tombstone checks above are NEVER cached. Realpaths can share a
  // sample only inside a synchronous producer, never across approval awaits.
  const canonical = (path: string) => synchronousPermissionSample("workspace-realpath", path, () => realpathSync(path));
  assert(canonical(binding.cwd) === binding.canonicalCwd && canonical(binding.source_cwd) === binding.canonicalSourceCwd &&
    canonical(binding.checkout_root) === binding.canonicalCheckoutRoot && canonical(binding.source_root) === binding.canonicalSourceRoot,
    "Workspace policy directory binding changed");
}

export interface WorkspacePolicyLease {
  /** Live, restriction-only aliases; rejects after release or root changes. */
  aliases(values: readonly string[]): readonly string[];
  release(): void;
}

/** Runtime-only inputs, registered before the child's permission extension loads.
 * The caller must retain this lease until confirmed child shutdown. */
export function bindWorkspacePolicy(input: {
  sessionId: string; cwd: string; source_cwd: string; checkout_root: string; source_root: string; projectTrusted: boolean;
}): WorkspacePolicyLease {
  sessionId(input.sessionId);
  directory(input.cwd); directory(input.source_cwd); directory(input.checkout_root); directory(input.source_root);
  assert(typeof input.projectTrusted === "boolean", "Invalid workspace policy trust decision");
  const canonicalCwd = realpathSync(input.cwd), canonicalSourceCwd = realpathSync(input.source_cwd);
  const canonicalCheckoutRoot = realpathSync(input.checkout_root), canonicalSourceRoot = realpathSync(input.source_root);
  const tail = containedTail(input.checkout_root, input.cwd);
  assert(tail === containedTail(input.source_root, input.source_cwd) &&
    tail === containedTail(canonicalCheckoutRoot, canonicalCwd) && tail === containedTail(canonicalSourceRoot, canonicalSourceCwd),
    "Workspace policy cwd offsets mismatch");
  const entries = registry().entries;
  assert(!entries.has(input.sessionId), "Workspace policy session is already bound or retired");
  assert(entries.size < MAX_BINDINGS, "Workspace policy registry capacity reached; start a fresh process");
  const binding: WorkspacePolicyBinding = Object.freeze({ sessionId: input.sessionId, cwd: input.cwd,
    source_cwd: input.source_cwd, checkout_root: input.checkout_root, source_root: input.source_root,
    projectTrusted: input.projectTrusted, canonicalCwd, canonicalSourceCwd, canonicalCheckoutRoot, canonicalSourceRoot });
  entries.set(binding.sessionId, binding);
  return Object.freeze({
    aliases: (values: readonly string[]) => workspacePolicyAliases(binding, values),
    release() {
      if (entries.get(binding.sessionId) === binding) entries.set(binding.sessionId, null);
    },
  });
}

export function workspacePolicyForContext(ctx: Pick<ExtensionContext, "cwd" | "sessionManager"> | undefined): WorkspacePolicyBinding | undefined {
  if (!ctx) return;
  const id = ctx.sessionManager.getSessionId();
  sessionId(id);
  const entries = registry().entries;
  if (!entries.has(id)) return;
  const binding = entries.get(id);
  assert(binding, "Workspace policy session has been released");
  assertWorkspacePolicy(binding);
  assert(ctx.cwd === binding.cwd, "Workspace policy execution cwd mismatch");
  return binding;
}

/** One non-recursive mirror of the whole known checkout, including siblings
 * above a nested execution cwd. Never guess roots or map another checkout.
 * These strings must NEVER join ordinary ALLOW candidate values or replace
 * execution/external-boundary paths. */
export function workspacePolicyAliases(binding: WorkspacePolicyBinding | undefined, values: readonly string[]): string[] {
  if (!binding) return [];
  assertWorkspacePolicy(binding);
  const aliases = new Set<string>();
  for (const value of values) {
    if (!isAbsolute(value) || resolve(value) !== value) continue;
    for (const root of [binding.checkout_root, binding.canonicalCheckoutRoot]) {
      const tail = relative(root, value);
      if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) continue;
      aliases.add(resolve(binding.source_root, tail));
      aliases.add(resolve(binding.canonicalSourceRoot, tail));
    }
  }
  return [...aliases];
}

/** Wire strings add restrictions only. Identity/trust still comes exclusively
 * from the process registry, never the serialized request. */
export function workspacePolicyForwardedValues(intent: ForwardedAccessIntent, servingSessionId: string | null,
  subagents: Pick<SubagentSessionRegistry, "get">): readonly string[] | undefined {
  if (!PATH_SURFACES.has(intent.surface)) return;
  const id = intent.principal.sessionId;
  sessionId(id);
  const entries = registry().entries;
  if (!entries.has(id)) {
    assert(intent.workspacePolicyValues === undefined, "Forwarded workspace policy binding is missing");
    return;
  }
  assert(servingSessionId && subagents.get(id)?.parentSessionId === servingSessionId,
    "Forwarded workspace policy parent mismatch");
  const binding = workspacePolicyForContext({ cwd: intent.requesterCwd,
    sessionManager: { getSessionId: () => id } as ExtensionContext["sessionManager"] });
  const aliases = workspacePolicyAliases(binding, intent.matchValues);
  assert(Array.isArray(intent.workspacePolicyValues) && aliases.length === intent.workspacePolicyValues.length &&
    aliases.every((value, index) => value === intent.workspacePolicyValues![index]),
    "Forwarded workspace policy restriction values mismatch");
  return aliases;
}
