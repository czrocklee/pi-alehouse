import type { RunCallbacks } from "../core/ports.js";
import { isManagedBlockTool } from "../../../lib/managed-block-tools.mjs";

/** Metadata from the managed authority's actual SDK handler return, not a UI
 * decision event, error string, or tool_execution_end.isError. */
export interface ManagedBlockFact {
  readonly toolName: string;
  readonly toolCallId: string;
}
export type ManagedBlockSubscription = (sessionId: string, onBlock: (fact: ManagedBlockFact) => void) => () => void;
export const MANAGED_BLOCK_ID_LIMIT = 128;
interface Observation {
  attempted: boolean;
  pendingTool?: string;
  ids: Set<string>;
  tools: Set<string>;
  accepting(): boolean;
  callbacks: RunCallbacks;
}

/** Optional, bounded per-Run feedback. The producer captures this subscription
 * before its await; old authority work cannot attach to a new Run. Nothing here
 * grants permission, classifies a denial reason, or compares operation inputs. */
export class ManagedBlockObserver {
  private current?: Observation;
  private release?: () => void;
  constructor(private readonly subscribe?: ManagedBlockSubscription) {}

  begin(sessionId: string, callbacks: RunCallbacks, accepting: () => boolean): void {
    this.end();
    if (!this.subscribe) return;
    const observation: Observation = { attempted: false, ids: new Set(), tools: new Set(), accepting, callbacks };
    this.current = observation;
    try {
      this.release = this.subscribe(sessionId, (fact) => {
        // Latch only in the authority's call stack. Never reenter the Owner or
        // publish an alert until the SDK has returned from its tool boundary.
        if (this.current !== observation || !observation.accepting() || observation.attempted || observation.pendingTool !== undefined ||
            !isManagedBlockTool(fact?.toolName) ||
            typeof fact.toolCallId !== "string" || !fact.toolCallId || fact.toolCallId.length > 256 ||
            observation.ids.has(fact.toolCallId) || observation.ids.size >= MANAGED_BLOCK_ID_LIMIT) return;
        observation.ids.add(fact.toolCallId);
        if (observation.tools.has(fact.toolName)) observation.pendingTool = fact.toolName;
        else observation.tools.add(fact.toolName);
      });
    } catch { this.end(); /* Missing telemetry is unknown, not an execution failure. */ }
  }

  /** Called only from the SDK tool_execution_end observation, never its isError.
   * Attempt once, including a full/closed alert FIFO; there is no retry outbox. */
  flush(): void {
    const observation = this.current;
    if (!observation || observation.attempted || !observation.pendingTool || !observation.accepting()) return;
    observation.attempted = true;
    try {
      observation.callbacks.managedBlock?.({ toolName: observation.pendingTool });
    } catch { /* Feedback cannot change authority, cancellation or Run settlement. */ }
  }

  end(): void {
    const release = this.release;
    this.current = undefined;
    this.release = undefined;
    try { release?.(); } catch { /* Sealed locally even if optional unsubscribe fails. */ }
  }
}
