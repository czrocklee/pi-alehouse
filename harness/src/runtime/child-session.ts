import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult, EventBus } from "@earendil-works/pi-coding-agent";
import { SessionInitializationError } from "../core/ports.js";
import { requireReadiness } from "../permissions/readiness.js";
import { blockedDelegationToolNames } from "../tools/tool-names.js";

/** P0 assembly seam only. The caller supplies the actual host SDK and loader. */
export async function assembleChildSession(input: {
  createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
  options: CreateAgentSessionOptions;
  parentBus: EventBus;
  childBus: EventBus;
  parentSessionId: string;
  profile: string;
  definitionDigest: string;
  getPermissionsService: (id: string) => unknown;
  shutdownTimeoutMs?: number;
}) {
  const timeoutMs = input.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("INVALID_SHUTDOWN_TIMEOUT");
  const { session, extensionsResult } = await input.createSession({
    ...input.options,
    excludeTools: [...new Set([...(input.options.excludeTools ?? []), ...blockedDelegationToolNames])],
  });
  const identity = { sessionId: session.sessionId, parentSessionId: input.parentSessionId };
  const errors: string[] = [];
  try {
    input.parentBus.emit("subagents:child:session-created", identity);
    if (extensionsResult.errors.length) throw new Error(`EXTENSION_LOAD_FAILED: ${extensionsResult.errors.map((e) => e.path).join(", ")}`);
    // Runner logs and swallows many handler errors; a resolved bind is not
    // proof of readiness. Capture these errors as well as loader diagnostics.
    await session.bindExtensions({ onError: (error) => errors.push(error.error) });
    if (errors.length) throw new Error(`EXTENSION_BIND_FAILED: ${errors.join("; ")}`);
    input.parentBus.emit("subagents:child:bound", identity);
    const guard = requireReadiness(input.childBus, input.getPermissionsService,
      session.sessionId, input.profile, input.definitionDigest);
    return { session, guard, errors, identity };
  } catch (error) {
    try {
      const cleanup = await cleanupChildSession(session, input.parentBus, timeoutMs, true);
      if (cleanup.errors.length) {
        throw new Error(cleanup.errors.join("; "), { cause: error });
      }
    } catch (cleanupError) {
      throw new SessionInitializationError(error, cleanupError);
    }
    throw error;
  }
}

export interface CleanupReport {
  /** Abort/shutdown work settled and idle was confirmed, not error-free success. */
  shutdownExited: boolean;
  disposed: true;
  resumable: false;
  errors: string[];
}
const disposals = new WeakMap<AgentSession, Promise<CleanupReport>>();

// Isolated-host policy, not a production availability guarantee. A one-second
// default was too eager for ordinary extension cleanup. Hosts may override it;
// expiration still cannot prove exit or authorize releasing the owner lock.
export const defaultShutdownTimeoutMs = 5_000;

/** Only for an idle/never-prompted session. A shutdown timeout is NOT exit. */
export function disposeChildSession(session: AgentSession, parentBus: EventBus, timeoutMs = defaultShutdownTimeoutMs): Promise<CleanupReport> {
  const existing = disposals.get(session);
  if (existing) return existing;
  if (!session.isIdle) return Promise.reject(new Error("EXECUTION_NOT_EXITED"));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("INVALID_SHUTDOWN_TIMEOUT"));
  return cleanupChildSession(session, parentBus, timeoutMs);
}

/** Only failed assembly may attempt cleanup without prior execution-exit proof.
 * One budget covers abort/drain and shutdown; disposal is best effort, not exit.
 * SDK abort() already waits for idle. Never await it without this bound. */
function cleanupChildSession(session: AgentSession, parentBus: EventBus, timeoutMs: number, abortFirst = false): Promise<CleanupReport> {
  const existing = disposals.get(session);
  if (existing) return existing;
  const deadline = performance.now() + timeoutMs;
  // Publish the single-flight promise before any extension can reenter cleanup.
  const disposing = Promise.resolve().then(async (): Promise<CleanupReport> => {
    const errors: string[] = [];
    const bounded = async (operation: () => Promise<unknown>, timeout: string): Promise<boolean> => {
      // Invoke even when the budget is exhausted; observe late rejections too.
      const settled = (async () => operation())().then(() => true, (error: unknown) => { errors.push(String(error)); return true; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = Math.max(0, deadline - performance.now());
        const exited = remaining > 0 && await Promise.race([settled, new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        })]);
        if (!exited) errors.push(timeout);
        return exited;
      } finally { clearTimeout(timer); }
    };
    let unsubscribe: (() => void) | undefined, shutdownExited: boolean;
    try {
      // emit() swallows handler throws. A resolved dispatch is not success.
      unsubscribe = session.extensionRunner.onError((error) => { errors.push(error.error); });
      const aborted = !abortFirst || await bounded(() => session.abort(), "CHILD_ABORT_TIMEOUT");
      const idle = session.isIdle;
      const shutdown = await bounded(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), "CHILD_SHUTDOWN_TIMEOUT");
      shutdownExited = aborted && idle && shutdown && session.isIdle;
      if (!idle || !session.isIdle) errors.push("EXECUTION_NOT_EXITED");
    } finally {
      // A blocked shutdown handler may prevent later permission handlers from
      // running. We promise an attempt, not their success or arbitrary-work exit.
      try { session.dispose(); }
      // A disposal failure must reject even after an earlier shutdown failure:
      // callers retain ownership on this path instead of treating it as cleanup.
      // eslint-disable-next-line no-unsafe-finally -- disposal failure takes precedence, with diagnostics retained
      catch (error) { throw new Error([...errors, String(error)].join("; "), { cause: error }); }
      finally { unsubscribe?.(); }
    }
    const cleanup: CleanupReport = { shutdownExited, disposed: true, resumable: false, errors: [...errors] };
    parentBus.emit("subagents:child:disposed", { sessionId: session.sessionId, cleanup });
    return cleanup;
  });
  disposals.set(session, disposing);
  return disposing;
}
