import type { AgentSession, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { blockedDelegationToolNames } from "../tools/tool-names.ts";

/**
 * Live child tool-renderer resolution, as a leaf module so the factory (and
 * focused checks) can construct it without the activity observer.
 *
 * The lookup uses only the SDK's public session read surface —
 * `session.getToolDefinition(name)` and
 * `session.extensionRunner.resolveToolRenderers(name, base)` — with the
 * registered definition queried lazily as the resolver chain's base. It never
 * reaches for the SDK's private built-in renderer table, fabricates tool
 * instances, or falls back to anything beyond that public chain.
 *
 * Every call is a fresh query: results, including misses, are never cached,
 * so a closed or replaced session takes effect on the next lookup rather than
 * surviving in a detached cache. Each result is a whitelist projection of
 * only `renderCall`/`renderResult`/`renderShell` with those fields' shapes
 * validated; `execute`, the full `ToolDefinition` and the session itself are
 * never handed on. Every failure mode — a blocked delegation name, a missing
 * API, a thrown error, a malformed or empty shape, an async (Promise) result
 * — yields undefined, which the UI renders through its own bounded raw
 * fallback.
 *
 * The renderer functions are trusted extension display code; this projection
 * is a capability filter, not an OS sandbox or an absence-of-IO claim, and
 * this module never executes any tool.
 */

/** Public read methods only; the UI never receives this or the session. */
export type ChildRendererSessionPort = Pick<AgentSession, "getToolDefinition" | "extensionRunner">;

/** Project only the display fields, validating their shapes: renderer fields
 * must be functions, the shell mode one of the two known literals. Extra
 * fields such as `execute` are omitted. Malformed display fields and empty
 * renderer objects yield undefined, never a passthrough of the source. */
function projectToolRenderers(source: unknown): ToolRenderers | undefined {
  if (source instanceof Promise) {
    // The public chain is sync-typed; a genuine Promise here is a runtime
    // contract violation (an async resolver or definition getter), not a
    // shape to project. Async is refused, not awaited or supported: the
    // result is the raw fallback, and the rejection is observed here so it
    // cannot surface as an unhandled rejection and take the pane or the
    // process down. Genuine Promises only (the SDK shares this realm);
    // arbitrary thenables stay untouched — probing them could execute
    // getter code.
    void source.catch(() => {});
    return undefined;
  }
  if (typeof source !== "object" || source === null) return undefined;
  const { renderCall, renderResult, renderShell } = source as Record<string, unknown>;
  if (renderCall !== undefined && typeof renderCall !== "function") return undefined;
  if (renderResult !== undefined && typeof renderResult !== "function") return undefined;
  if (renderShell !== undefined && renderShell !== "self" && renderShell !== "default")
    return undefined;
  if (renderCall === undefined && renderResult === undefined && renderShell === undefined)
    return undefined;
  const projected: ToolRenderers = {};
  if (renderCall !== undefined) projected.renderCall = renderCall as ToolRenderers["renderCall"];
  if (renderResult !== undefined)
    projected.renderResult = renderResult as ToolRenderers["renderResult"];
  if (renderShell !== undefined) projected.renderShell = renderShell;
  return projected;
}

/** A fresh live resolver for one child session. Blocked delegation names are
 * refused before any query; the session port is read, never handed on. */
export function createChildToolRendererLookup(
  session: ChildRendererSessionPort,
): (name: string) => ToolRenderers | undefined {
  return (name: string): ToolRenderers | undefined => {
    if (blockedDelegationToolNames.includes(name)) return undefined;
    try {
      // The registered definition is the resolver chain's lazy base: extension
      // resolvers may override it, and it is read only if the chain reaches it.
      const base = (): ToolRenderers | undefined => {
        // A missing definition API throws here and is caught: same raw
        // fallback as any other missing piece of the public read surface.
        try {
          return projectToolRenderers(session.getToolDefinition(name));
        } catch {
          return undefined;
        }
      };
      // A missing resolver API throws the same way: the whole public chain is
      // absent, so the result is the UI's raw fallback, never a partial one.
      const runner = session.extensionRunner;
      return projectToolRenderers(runner.resolveToolRenderers(name, base));
    } catch {
      return undefined;
    }
  };
}
