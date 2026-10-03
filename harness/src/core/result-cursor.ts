import { createHash } from "node:crypto";
import { HarnessError } from "./ports.js";

/** Stateless, Owner/generation/result-bound continuation identity. Original
 * retained Runs remain the only lookup source; no cursor registry or cache. */
export interface ResultCursorIdentity {
  readonly owner: string;
  readonly generation: string;
  readonly run: string;
  readonly version: string;
}
export const RESULT_CURSOR_LENGTH = 37;
const OFFSET_WIDTH = 11; // MAX_SAFE_INTEGER in base 36.
const PATTERN = /^r1_([A-Za-z0-9_-]{22})\.([0-9a-z]{11})$/;

/** Uniform recovery guidance for syntax, identity, range and UTF-16 failures.
 * A cursorless read is not a recovery selector for an Agent's older task. */
export function invalidResultCursor(): HarnessError {
  return new HarnessError("INVALID_CURSOR", { resolution:
    "Pass agent and next_cursor exactly as returned together in an earlier reply. Without a cursor, agent_read selects the current, pending-question, or latest task; it does not recover a specific older task." });
}

/** First 128 SHA256 bits, with an independent domain from question identity.
 * This is a locator, not authority or a collision-free guarantee. */
export function resultCursorKey(identity: ResultCursorIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    "pi-alehouse/result-cursor/v1", identity.owner, identity.generation, identity.run, identity.version,
  ])).digest().subarray(0, 16).toString("base64url");
}

/** Fixed width reserves every future offset before text packing. All emitted
 * characters are JSON-safe ASCII; an advanced page cannot grow the reservation. */
export function encodeResultCursor(identity: ResultCursorIdentity, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidResultCursor();
  return `r1_${resultCursorKey(identity)}.${offset.toString(36).padStart(OFFSET_WIDTH, "0")}`;
}

export function decodeResultCursor(cursor: string): { key: string; offset: number } {
  const match = typeof cursor === "string" && cursor.length === RESULT_CURSOR_LENGTH ? PATTERN.exec(cursor) : null;
  if (!match) throw invalidResultCursor();
  const key = match[1]!, encoded = match[2]!, offset = Number.parseInt(encoded, 36);
  // Reject noncanonical base64 unused bits and unsafe/overflowed numeric offsets.
  if (Buffer.from(key, "base64url").toString("base64url") !== key || !Number.isSafeInteger(offset) ||
      offset < 0 || offset.toString(36).padStart(OFFSET_WIDTH, "0") !== encoded) throw invalidResultCursor();
  return { key, offset };
}
