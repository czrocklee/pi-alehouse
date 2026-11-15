import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { InputOrigin } from "../core/ports.ts";

interface Dispatch {
  readonly origin: InputOrigin;
  readonly text: string;
  readonly steer: boolean;
  readonly admitted: () => boolean;
  active: boolean;
  started: boolean;
  consumed: boolean;
}

/** Presentation-only SDK compatibility seam. Input events carry no message
 * identity. Observe the exact objects the SDK passes to its public Agent
 * methods instead, inside that ticket-admitted dispatch's async context.
 * No message, queue, prompt, provider input or journal entry is modified.
 * Unsupported method shapes/bindings simply leave the origin unknown.
 *
 * Each dispatch can bind at most one user object. In particular the initial
 * prompt's async context spans the whole run: later extension calls inheriting
 * that context must not acquire the original prompt's attribution.
 */
export class InputOriginCapture {
  private readonly context = new AsyncLocalStorage<Dispatch>();

  constructor(
    agent: AgentSession["agent"],
    private readonly record: (message: object, origin: InputOrigin) => void,
  ) {
    for (const name of ["prompt", "steer"] as const) {
      try {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only through Reflect.apply with the original receiver below
        const original = agent[name];
        if (typeof original !== "function") continue;
        const observe = (input: unknown) => this.observe(name, input);
        const descriptor = Object.getOwnPropertyDescriptor(agent, name);
        Object.defineProperty(agent, name, {
          ...(descriptor ?? { configurable: true, enumerable: false, writable: true }),
          value: function (this: unknown, ...args: unknown[]): unknown {
            if (this === agent) observe(args[0]);
            return Reflect.apply(original, this, args);
          },
        });
      } catch {
        // Observation cannot make an otherwise usable host fail assembly.
      }
    }
  }

  async dispatch<T>(
    input: Pick<Dispatch, "origin" | "text" | "steer" | "admitted">,
    invoke: (started: () => void) => Promise<T>,
  ): Promise<T> {
    const scope: Dispatch = { ...input, active: true, started: false, consumed: false };
    return this.context.run(scope, async () => {
      try {
        return await invoke(() => {
          scope.started = true;
        });
      } finally {
        scope.active = false;
      }
    });
  }

  private observe(method: "prompt" | "steer", input: unknown): void {
    try {
      const scope = this.context.getStore();
      if (!scope?.active || scope.consumed) return;
      // Pi calls preflightResult('started') immediately before agent.prompt,
      // with no intervening await. Queued input uses agent.steer before its
      // 'queued' notification instead. Follow-ups are not adapter dispatches.
      if (method === "prompt" ? !scope.started : !scope.steer || scope.started) return;
      if (!scope.admitted()) return;
      scope.consumed = true;
      const messages: unknown[] = method === "prompt" && Array.isArray(input) ? input : [input];
      const users = messages.filter(
        (message): message is { role: "user"; content: unknown } =>
          !!message &&
          typeof message === "object" &&
          Object.getOwnPropertyDescriptor(message, "role")?.value === "user",
      );
      if (users.length !== 1) return;
      const message = users[0]!;
      const content: unknown = Object.getOwnPropertyDescriptor(message, "content")?.value;
      // An integrity guard, not an origin lookup: only this admitted dispatch
      // can supply the origin, and identity (not text) keys the retained fact.
      if (!Array.isArray(content) || content.length !== 1) return;
      const part: unknown = content[0];
      if (
        !part ||
        typeof part !== "object" ||
        Object.getOwnPropertyDescriptor(part, "type")?.value !== "text" ||
        Object.getOwnPropertyDescriptor(part, "text")?.value !== scope.text
      )
        return;
      this.record(message, scope.origin);
    } catch {
      // Reflection or an optional presentation observer must never alter the
      // original method's receiver, arguments, return value or thrown error.
    }
  }
}
