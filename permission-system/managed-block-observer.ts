import type { ExtensionAPI, ExtensionContext, ExtensionHandler, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isManagedBlockTool } from "../lib/managed-block-tools.mjs";

/** A managed tool_call handler actually returned block === true. No verdict
 * classification, input, reason, result body or event-bus payload is retained. */
interface ManagedBlockFact {
  readonly toolName: string;
  readonly toolCallId: string;
}
type ManagedBlockListener = (fact: ManagedBlockFact) => void;
type ManagedBlockSubscription = (sessionId: string, onBlock: ManagedBlockListener) => () => void;
interface ManagedBlockObserver {
  readonly subscribeManagedBlocks: ManagedBlockSubscription;
  readonly wrapManagedBlocks: (pi: ExtensionAPI) => ExtensionAPI;
}

interface Subscription {
  readonly service: object;
  readonly onBlock: ManagedBlockListener;
}
interface Capture {
  readonly sessionId: string;
  readonly subscription: Subscription;
  readonly fact: ManagedBlockFact;
  readonly ctx: ExtensionContext;
}
type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
const key = Symbol.for("pi-alehouse:managed-block-observer:v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

function subscriptions(): Map<string, Subscription> {
  // Separate jiti loads share only live leases, never a block history. The
  // envelope is private/versioned/non-replaceable, like managed reader scratch.
  if (globals[key] === undefined) Object.defineProperty(globals, key, {
    value: Object.freeze({ version: 1, entries: new Map<string, Subscription>() }),
    configurable: false, writable: false, enumerable: false,
  });
  const registry = globals[key] as { version: number; entries: Map<string, Subscription> };
  if (!registry || !Object.isFrozen(registry) || registry.version !== 1 || !(registry.entries instanceof Map))
    throw new Error("Managed block observer registry is unavailable");
  return registry.entries;
}

/** Inject the authority entry's actual public service getter. This helper
 * never guesses a permission-service global or listens to decision events.
 * Only trusted runtime code supplies SDK-derived session IDs and callbacks. */
export function createManagedBlockObserver(getPermissionsService: (sessionId: string) => unknown): ManagedBlockObserver {
  const subscribeManagedBlocks: ManagedBlockSubscription = (sessionId, onBlock) => {
    if (!validId(sessionId) || typeof onBlock !== "function") throw new Error("Invalid managed block subscription");
    const entries = subscriptions();
    if (entries.has(sessionId)) throw new Error("Managed block subscription is already active");
    const service = getPermissionsService(sessionId);
    if (typeof service !== "object" || service === null) throw new Error("Managed permission service is unavailable");
    // A getter must not be able to reentrantly overwrite another live lease.
    if (entries.has(sessionId)) throw new Error("Managed block subscription is already active");
    const subscription: Subscription = Object.freeze({ service, onBlock });
    entries.set(sessionId, subscription);
    return () => { if (entries.get(sessionId) === subscription) entries.delete(sessionId); };
  };

  const capture = (event: ToolCallEvent, ctx: ExtensionContext): Capture | undefined => {
    try {
      const toolName = event.toolName, toolCallId = event.toolCallId;
      if (!isManagedBlockTool(toolName) || !validId(toolCallId)) return;
      const sessionId = ctx.sessionManager.getSessionId();
      if (!validId(sessionId)) return;
      const entries = subscriptions();
      const subscription = entries.get(sessionId);
      if (!subscription || getPermissionsService(sessionId) !== subscription.service || entries.get(sessionId) !== subscription) return;
      return { sessionId, subscription, ctx, fact: Object.freeze({ toolName, toolCallId }) };
    } catch { return; } // Missing/throwing metadata is unobserved, never inferred.
  };

  const publish = (captured: Capture, result: unknown): void => {
    try {
      if (!result || typeof result !== "object" || (result as { block?: unknown }).block !== true) return;
      const { sessionId, subscription, ctx, fact } = captured;
      const entries = subscriptions();
      // The service getter may reenter and replace/revoke the lease. Recheck
      // the subscription AFTER that call, not just before it.
      if (ctx.sessionManager.getSessionId() !== sessionId ||
          getPermissionsService(sessionId) !== subscription.service || entries.get(sessionId) !== subscription) return;
      subscription.onBlock(fact);
    } catch { /* Observation must not change the gate's result or exception. */ }
  };

  const wrapHandler = (handler: ToolCallHandler): ToolCallHandler => function (this: unknown, event, ctx, ...rest: unknown[]) {
    // Capture before invoking even a synchronous handler: it may revoke this
    // Run and install the next subscription before its promise settles.
    const captured = capture(event, ctx);
    const result = Reflect.apply(handler, this, [event, ctx, ...rest]) as ReturnType<ToolCallHandler>;
    if (captured) {
      try {
        if (result instanceof Promise) {
          // Observe settlement without replacing the original promise, its
          // resolution object, or its rejection. Neither branch can throw.
          void Promise.prototype.then.call(result, (value: unknown) => publish(captured, value), () => {});
        } else publish(captured, result);
      } catch { /* Even attaching an observer cannot interfere with the gate. */ }
    }
    return result;
  };

  const wrapManagedBlocks = (pi: ExtensionAPI): ExtensionAPI => {
    // Decorate registration only. A separate facade can shadow even a frozen
    // API's on method without violating Proxy invariants or mutating the host.
    // Other SDK APIs are inherited live, not read/copied during construction;
    // this is a registration facade, not an own-property identity clone.
    const wrapped = Object.create(pi) as ExtensionAPI;
    Object.defineProperty(wrapped, "on", { enumerable: true,
      value: function (this: unknown, event: unknown, handler: unknown, ...rest: unknown[]) {
        const observed = event === "tool_call" && typeof handler === "function" ? wrapHandler(handler as ToolCallHandler) : handler;
        return Reflect.apply(pi.on, this === wrapped ? pi : this, [event, observed, ...rest]);
      },
    });
    return wrapped;
  };

  return Object.freeze({ subscribeManagedBlocks, wrapManagedBlocks });
}
