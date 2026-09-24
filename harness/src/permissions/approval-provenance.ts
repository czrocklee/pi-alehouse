import { createHash } from "node:crypto";
import type { EventBus, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ContextChange } from "../core/owner-controller.js";
import type { RunExecutionIdentity, RunIdentity } from "../core/contracts.js";

/** Host-only witness, not a tool or a child authorizer. Jev reads this registry
 * and snapshots parent authorization on admission. No transcript heuristics,
 * session-file-as-ID, or model-supplied Run identities cross this boundary.
 * The protocol is checked by the rendered-Jev/real-child integration test. */
const runtimeKey = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
const observersKey = Symbol.for("@rocklee/managed-permissions:forwarded-ask-observers");
const promptDigest = (text: string) => createHash("sha256").update(JSON.stringify(text)).digest("hex");
export interface HarnessApprovalFacts {
  parentSessionId: string;
  cwd: string;
  initialPromptDigest?: string;
  contextChanged: boolean;
  /** Complete preflight actions, keyed by SDK ID; IDs are never retry identity. */
  toolCalls: Record<string, { name: string; arguments: Record<string, unknown> }>;
  requestTools: Record<string, string>;
  harness: RunExecutionIdentity & {
    protocol: 1;
    profile: string;
    definitionDigest: string;
    prompt: string;
    systemPrompt?: string;
  };
}
function registry(): Map<string, HarnessApprovalFacts> {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[runtimeKey];
  if (existing instanceof Map) return existing as Map<string, HarnessApprovalFacts>;
  const result = new Map<string, HarnessApprovalFacts>();
  global[runtimeKey] = result;
  return result;
}

function sameRun(left: RunIdentity, right: RunIdentity): boolean {
  return (["owner_id", "generation", "agent_id", "run_id"] as const).every((key) => left[key] === right[key]);
}

export class ApprovalBindings {
  private readonly sessions = new Map<string, RunIdentity>();
  private readonly observedInput = new Set<string>();
  constructor(private readonly bus: EventBus, private readonly owner: Pick<RunIdentity, "owner_id" | "generation">) {}

  /** Synchronous and before dispatch: a queued steer/cancel must invalidate an
   * in-flight verdict even if the SDK has not consumed the new input yet. */
  readonly contextChanged = (event: ContextChange): undefined => {
    if (event.owner_id !== this.owner.owner_id || event.generation !== this.owner.generation) throw new Error("APPROVAL_OWNER_MISMATCH");
    for (const sessionId of this.sessions.keys()) {
      const facts = this.facts(sessionId);
      if (facts?.harness.agent_id === event.agent_id) this.invalidate(sessionId);
    }
    if (event.kind === "submit" || event.kind === "resume") this.bus.emit("pi-harness:approval:admitted", event);
    else this.bus.emit("pi-harness:approval:invalidated", event);
    return undefined;
  };

  /** A leftover witness disables auto-approval for this Run, not execution.
   * Retire only locally owned state. Never overwrite another owner's witness. */
  begin(run: RunExecutionIdentity, input: { sessionId: string; cwd: string; profile: string; definitionDigest: string; prompt: string }): boolean {
    if (run.owner_id !== this.owner.owner_id || run.generation !== this.owner.generation) {
      throw new Error("APPROVAL_RUN_MISMATCH");
    }
    const previous = this.sessions.get(input.sessionId);
    const collision = previous !== undefined || registry().has(input.sessionId);
    if (previous) this.end(input.sessionId, previous);
    if (registry().has(input.sessionId)) return false;
    this.sessions.set(input.sessionId, { ...run });
    this.observedInput.delete(input.sessionId);
    registry().set(input.sessionId, {
      parentSessionId: run.owner_id, cwd: input.cwd, contextChanged: collision,
      toolCalls: Object.create(null) as HarnessApprovalFacts["toolCalls"],
      requestTools: Object.create(null) as HarnessApprovalFacts["requestTools"],
      harness: { ...run, protocol: 1, profile: input.profile, definitionDigest: input.definitionDigest, prompt: input.prompt },
    });
    return !collision;
  }

  private facts(sessionId: string): HarnessApprovalFacts | undefined {
    const owned = this.sessions.get(sessionId), facts = registry().get(sessionId);
    return owned && facts && sameRun(owned, facts.harness) ? facts : undefined;
  }

  private invalidate(sessionId: string): void {
    const facts = this.facts(sessionId);
    if (facts) facts.contextChanged = true;
  }

  /** Loaded in the real child, but never loads a reviewer or reads credentials.
   * Observe the SDK's final prompt after the Run ticket has been stripped. A
   * second prompt or user message cannot borrow the first prompt's witness. */
  childExtension(sessionId: string): ExtensionFactory {
    return (pi) => {
      const global = globalThis as Record<symbol, unknown>;
      const observe = (event: { requestId?: unknown; toolCallId?: unknown }) => {
        const facts = this.facts(sessionId);
        if (!facts || facts.contextChanged ||
            typeof event.requestId !== "string" || typeof event.toolCallId !== "string" ||
            !facts.toolCalls[event.toolCallId] || Object.keys(facts.requestTools).length >= 256) return;
        if (facts.requestTools[event.requestId]) { this.invalidate(sessionId); return; }
        facts.requestTools[event.requestId] = event.toolCallId;
      };
      pi.on("session_start", () => {
        if (!(global[observersKey] instanceof Map)) global[observersKey] = new Map();
        (global[observersKey] as Map<string, typeof observe>).set(sessionId, observe);
      });
      pi.on("before_agent_start", (event) => {
        const facts = this.facts(sessionId);
        if (!facts) return;
        if (facts.contextChanged || facts.initialPromptDigest || event.prompt !== facts.harness.prompt) {
          this.invalidate(sessionId);
          return;
        }
        registry().set(sessionId, { ...facts, initialPromptDigest: promptDigest(event.prompt),
          harness: { ...facts.harness, systemPrompt: event.systemPrompt } });
        this.bus.emit("pi-harness:approval:started", { sessionId });
      });
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        const facts = this.facts(sessionId);
        if (!facts) return;
        const content = event.message.content;
        const text = typeof content === "string" ? content : content.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
        if (this.observedInput.has(sessionId) || text === undefined || promptDigest(text) !== facts.initialPromptDigest) this.invalidate(sessionId);
        this.observedInput.add(sessionId);
      });
      // This event precedes permission-system's tool_call handler. A tool_call
      // observer loaded after permissions would publish too late for forwarding.
      pi.on("tool_execution_start", (event) => {
        const facts = this.facts(sessionId);
        if (!facts || facts.contextChanged) return;
        try {
          if (Object.keys(facts.toolCalls).length >= 256 || facts.toolCalls[event.toolCallId] ||
              !event.args || typeof event.args !== "object" || Array.isArray(event.args) ||
              !([Object.prototype, null] as readonly unknown[]).includes(Object.getPrototypeOf(event.args))) {
            this.invalidate(sessionId);
            return;
          }
          facts.toolCalls[event.toolCallId] = { name: event.toolName, arguments: structuredClone(event.args) as Record<string, unknown> };
        } catch {
          // Optional observation must never fail the tool batch. Uncloneable
          // or malformed arguments revoke this Run's model-approval witness.
          this.invalidate(sessionId);
        }
      });
      pi.on("tool_execution_end", (event) => {
        const facts = this.facts(sessionId);
        if (facts) {
          delete facts.toolCalls[event.toolCallId];
          for (const [id, toolId] of Object.entries(facts.requestTools)) {
            if (toolId === event.toolCallId) delete facts.requestTools[id];
          }
        }
      });
      pi.on("session_shutdown", () => {
        const observers = global[observersKey] as Map<string, typeof observe> | undefined;
        if (observers?.get(sessionId) === observe) observers.delete(sessionId);
        const run = this.sessions.get(sessionId);
        if (run) this.end(sessionId, run);
      });
    };
  }

  end(sessionId: string, run: RunIdentity): void {
    const owned = this.sessions.get(sessionId);
    if (!owned || !sameRun(owned, run) || run.owner_id !== this.owner.owner_id || run.generation !== this.owner.generation) return;
    // Even if the public registry entry vanished, retire our local identity and
    // notify Jev. A foreign/replacement entry must survive this cleanup.
    if (this.facts(sessionId)) registry().delete(sessionId);
    this.sessions.delete(sessionId);
    this.observedInput.delete(sessionId);
    this.bus.emit("pi-harness:approval:finished", { sessionId, owner_id: run.owner_id,
      generation: run.generation, agent_id: run.agent_id, run_id: run.run_id });
  }
}
