import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { HarnessError, type RunCallbacks } from "../core/ports.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

export function createChildTools(current: () => RunCallbacks | undefined,
  gate: { readonly accepting: boolean; readonly stopped: boolean }): ToolDefinition[] {
  return ([["notify_parent", "message"], ["ask_parent", "question"]] as const).map(([name, key]) => {
    const parameters = Type.Object({ [key]: text(8192) }, { additionalProperties: false });
    return { name, label: name, parameters,
      description: name === "ask_parent" ? "Record a question for the parent, then finish this Run." : "Record ordinary progress for the UI and the parent's next completed wait; this does not interrupt waiting. Use ask_parent for a decision, then finish the Run.",
      async execute(_id: string, args: unknown) {
        // Like owner tools, recheck AFTER mutable SDK tool_call hooks, before
        // callbacks can record a question or evict an existing notification.
        if (!Check(parameters, args)) throw new HarnessError("INVALID_PARAMETERS");
        const callbacks = current();
        if (!callbacks || !gate.accepting || gate.stopped) throw new HarnessError("RUN_INPUT_CLOSED");
        const value = args[key]!;
        if (name === "ask_parent") callbacks.question(value); else callbacks.notify(value);
        return { content: [{ type: "text" as const, text: name === "ask_parent" ? "Question recorded. Finish this Run now." : "Progress recorded." }], details: undefined };
      },
    };
  });
}
