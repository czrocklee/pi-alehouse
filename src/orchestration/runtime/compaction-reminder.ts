import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OwnerController } from "../core/owner-controller.ts";

export const compactionReminderMessage = "alehouse:compaction-reminder:v1";

/** Fixed bytes. Pi delivers custom messages to the model as user-role content,
 * so nothing from an Agent, child, provider or Owner state is interpolated: the
 * reminder carries no untrusted text, names no Agent a later Owner may lack,
 * and cannot contradict a fresher tool result. It states a fact and asks for
 * no action: a user-role imperative could start an unwanted long agent_wait. */
export const compactionReminderText =
  "Alehouse note: this conversation was compacted while delegated Agents still had " +
  "unfinished work, unread results, alerts or questions.";

type ReminderOwner = Pick<
  OwnerController,
  "validateObservationEntry" | "hasOutstandingCommunication"
>;

/** One appended parent message per compaction while an Owner-scope agent_wait
 * would still present something. Never a per-request projection: the bytes are
 * written once, so the provider prompt prefix stays byte-stable. The SDK defers
 * the append to the end of the turn while a run is active. Best-effort and
 * read-only: a failed check or queue is not an Owner fault, and queuing is
 * neither model receipt nor communication consumption. */
export function remindAfterCompaction(
  owner: ReminderOwner,
  pi: Pick<ExtensionAPI, "sendMessage">,
): boolean {
  try {
    if (!owner.validateObservationEntry(() => owner.hasOutstandingCommunication())) return false;
    pi.sendMessage(
      { customType: compactionReminderMessage, display: false, content: compactionReminderText },
      { triggerTurn: false },
    );
    return true;
  } catch {
    return false;
  }
}

/** The extension's only registration. `current` returns the Owner bound to the
 * compacted parent session, or undefined while not ready or after that parent
 * context changed; a throwing lookup is treated as no Owner. */
export function registerCompactionReminder(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  current: (ctx: ExtensionContext) => ReminderOwner | undefined,
): void {
  pi.on("session_compact", (_event, ctx) => {
    let owner: ReminderOwner | undefined;
    try {
      owner = current(ctx);
    } catch {
      return;
    }
    if (owner) remindAfterCompaction(owner, pi);
  });
}
