import type { CommunicationAction, CommunicationEnvelope, CommunicationReason, TaskEntry, ThinTaskEntry } from "./communication-envelope.js";
import type { QuestionId } from "./question-id.js";
import type { ResultCursorIdentity } from "./result-cursor.js";

/** Ordinary, immutable-by-contract data only. Snapshot indices, not live Run
 * objects, cross the publisher boundary; the Owner retains their provenance.
 * No registry or persistence is introduced by these per-publication values. */
export interface ResultWindow {
  /** Captured requested window, starting at offset. May be live preview text. */
  readonly text: string;
  readonly offset: number;
  readonly retained_chars: number;
  readonly total_chars: number;
  /** Required for EVERY stable terminal window, even when its captured page
   * ends at retained EOF; forbidden on live previews. A fixed-width locator is
   * reserved before text packing; its actual offset is computed AFTER packing. */
  readonly cursor?: ResultCursorIdentity;
}
export interface TaskSnapshot {
  /** Required control facts only; arbitrary strings belong in diagnostics. */
  readonly row: ThinTaskEntry;
  readonly settled: boolean;
  readonly question_id?: QuestionId;
  readonly question?: string;
  readonly result?: ResultWindow;
  readonly diagnostics?: Pick<TaskEntry, "error" | "owner_error" | "unavailable_reason">;
}
export interface AlertSnapshot {
  readonly agent: string;
  readonly task: number;
  readonly label: string;
  readonly message: string;
}
export interface FinishedSnapshot {
  readonly row: ThinTaskEntry;
  /** Explicit original-Run association with a bound tasks row. Absence means
   * this candidate needs its own finished row; never infer identity from names,
   * task ordinals or statuses. The Owner validates the original references. */
  readonly task_index?: number;
}
export interface CommunicationSnapshot {
  readonly reason: CommunicationReason;
  readonly action?: CommunicationAction;
  readonly workers_disabled?: true;
  /** Every bound task, already ordered at registration; maximum sixteen. */
  readonly tasks: readonly TaskSnapshot[];
  /** Already filtered to the typed scope, preserving the one Owner FIFO. */
  readonly alerts: readonly AlertSnapshot[];
  /** All settled, unpresented candidates, in settled_seq order. */
  readonly finished: readonly FinishedSnapshot[];
  readonly blocked?: string;
}
export interface CommunicationReferences {
  /** Exactly a prefix of the snapshot's scope-filtered alerts. */
  readonly alerts: readonly number[];
  /** Snapshot indices shown through explicit task_index links or the ordered
   * finished-row prefix. Display-field equality never establishes provenance. */
  readonly finished: readonly number[];
  /** Present only when this publication actually reports owner_blocked. */
  readonly blocked?: string;
}
/** SDK-free structural final result; observe resolves this exact value. */
export interface CommunicationToolResult {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: undefined;
}
export interface PackedCommunication {
  readonly envelope: CommunicationEnvelope;
  readonly result: CommunicationToolResult;
  readonly references: CommunicationReferences;
}
