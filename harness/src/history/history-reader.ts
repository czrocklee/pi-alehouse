import type { FileEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { HistoryRef, Outcome, Output, ResultRef, RunIdentity } from "../core/contracts.js";
import { HarnessError } from "../core/ports.js";
import { describeResult, isId } from "../core/result-text.js";
import { normalizeLedger, type UsageLedger } from "../core/usage-ledger.js";
import { dataOf, entryId, finalMessage, historyTypes, invalidHistory, sameRun, textOf,
  validIdentity, validModelStopReason, validRef, validRouting, type HistoricalRouting } from "./run-journal.js";

export interface HistoricalRun {
  state: "recorded" | "unknown" | "unavailable";
  resumable: false;
  ref?: HistoryRef;
  outcome?: Outcome;
  output?: Output;
  usage?: UsageLedger;
  routing?: HistoricalRouting;
  error?: string;
}

/** Bounded read-only JSONL snapshot. SDK open() may repair/migrate its input,
 * even when a caller only wants to inspect it. Parse a private snapshot here
 * and give it to inMemory() instead: malformed/torn JSON fails rather than
 * salvaging a prefix or rewriting the original journal. */
async function snapshot(path: string, maxBytes: number): Promise<FileEntry[]> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) invalidHistory();
    if (stat.size > maxBytes) throw new HarnessError("HISTORY_TOO_LARGE");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > stat.size) throw new HarnessError("HISTORY_CHANGED_DURING_READ");
    const entries = buffer.subarray(0, size).toString("utf8").split("\n").filter((line) => line.trim()).map((line): unknown => JSON.parse(line)) as FileEntry[];
    if (entries[0]?.type !== "session" || entries[0].version !== 3 || !isId(entries[0].id)) invalidHistory();
    const ids = new Set<string>();
    for (const e of entries.slice(1)) {
      if (e.type === "session" || !entryId(e.id) || ids.has(e.id) ||
          !(e.parentId === null || (entryId(e.parentId) && ids.has(e.parentId)))) invalidHistory();
      ids.add(e.id);
    }
    return entries;
  } finally { await handle.close(); }
}

/** Cold trusted-host reader. Source paths are trusted host inputs, NOT model
 * arguments: the parent supplies its journal and session-directory boundary.
 * References must match that parent's links and the contained child snapshot.
 * Never opens an AgentSession, repairs a journal, or hydrates a live Agent. */
export async function readSdkRun(input: {
  sessionManager: Pick<typeof SessionManager, "inMemory">;
  parentFile: string;
  sessionDirectory: string;
  maxBytes?: number;
} & ({ ref: HistoryRef } | { run_id: string })): Promise<HistoricalRun> {
  try {
    const requested = "ref" in input ? input.ref : undefined;
    const run_id = "run_id" in input ? input.run_id : requested?.run_id;
    if (!isId(run_id) || ("ref" in input && !validRef(requested))) invalidHistory();
    const maxBytes = input.maxBytes ?? 8_388_608;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67_108_864) invalidHistory();
    const create = (entries: FileEntry[]) => input.sessionManager.inMemory(undefined, undefined, entries);
    const parent = create(await snapshot(input.parentFile, maxBytes));
    const links = parent.getEntries().map((e) => dataOf(e, historyTypes.link) as { ref?: HistoryRef; session_file?: string; routing?: HistoricalRouting } | undefined)
      .filter((link) => link?.ref?.run_id === run_id);
    if (!links.length) return { state: "unavailable", resumable: false, error: "RUN_HISTORY_NOT_RECORDED" };
    if (links.length !== 1) invalidHistory();
    const link = links[0]!, ref = requested ?? link.ref ?? invalidHistory();
    if (!validRef(ref) || parent.getSessionId() !== ref.owner_id || !validRef(link.ref) || !sameRun(link.ref, ref) || link.ref.session_id !== ref.session_id ||
        link.ref.start_entry_id !== ref.start_entry_id || typeof link.session_file !== "string" || !isAbsolute(link.session_file)) invalidHistory();
    const root = await realpath(input.sessionDirectory), file = await realpath(link.session_file!);
    if (!file.startsWith(root + sep) || !file.endsWith(".jsonl")) invalidHistory();
    const session = create(await snapshot(file, maxBytes));
    if (session.getSessionId() !== ref.session_id) invalidHistory();
    const start = dataOf(session.getEntry(ref.start_entry_id), historyTypes.start) as (RunIdentity & { routing?: HistoricalRouting }) | undefined;
    if (!validIdentity(start) || !sameRun(start, ref) ||
        ((start.routing !== undefined || link.routing !== undefined) &&
          (!validRouting(start.routing) || !validRouting(link.routing) || JSON.stringify(start.routing) !== JSON.stringify(link.routing)))) invalidHistory();
    const ends = session.getEntries().filter((e) => {
      const d = dataOf(e, historyTypes.end) as { ref?: HistoryRef } | undefined;
      return d?.ref?.run_id === ref.run_id;
    });
    if (!ends.length) return { state: "unknown", resumable: false, ref,
      ...(start!.routing ? { routing: start!.routing } : {}) };
    if (ends.length !== 1 || (ref.end_entry_id && ref.end_entry_id !== ends[0]!.id)) invalidHistory();
    const data = dataOf(ends[0], historyTypes.end) as { ref: HistoryRef; through: string; final_entry_id: string | null;
      result: ResultRef; outcome: Outcome; usage?: UsageLedger };
    if (!validRef(data.ref) || !sameRun(data.ref, ref) || data.ref.session_id !== ref.session_id ||
        data.ref.start_entry_id !== ref.start_entry_id || !entryId(data.through) ||
        !data.outcome || !["completed", "needs_input", "failed", "cancelled"].includes(data.outcome.status) ||
        typeof data.outcome.limit_reached !== "boolean" || !validModelStopReason(data.outcome.model_stop_reason) ||
        ![data.outcome.reason, data.outcome.error, data.outcome.question].every((v) => v === undefined || typeof v === "string")) invalidHistory();
    if (data.through === ends[0]!.id) invalidHistory();
    const final = finalMessage(session, ref.start_entry_id, data.through, ends[0]!.id), result = data.result;
    if ((final?.id ?? null) !== data.final_entry_id || !result || result.scope !== "owner_memory" || result.run_id !== ref.run_id ||
        !Number.isSafeInteger(result.chars) || result.chars < 0 || !Number.isSafeInteger(result.total_chars) ||
        typeof result.truncated !== "boolean") invalidHistory();
    const text = textOf(final);
    const output = { text: text.slice(0, result.chars), total_chars: result.total_chars, truncated: result.truncated };
    if (text.length !== output.total_chars || output.text.length !== result.chars ||
        (/[\uD800-\uDBFF]/.test(text[result.chars - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[result.chars] ?? "")) ||
        describeResult(ref.run_id, output).digest !== result.digest) invalidHistory();
    const usage = normalizeLedger(data.usage);
    if (data.usage !== undefined && !usage) invalidHistory();
    return { state: "recorded", resumable: false, ref: { ...ref, end_entry_id: ends[0]!.id }, outcome: data.outcome, output,
      ...(start!.routing ? { routing: start!.routing } : {}), ...(usage ? { usage } : {}) };
  } catch (error) {
    return { state: "unavailable", resumable: false, error: error instanceof HarnessError ? error.code :
      (error as NodeJS.ErrnoException)?.code ?? "INVALID_SDK_HISTORY" };
  }
}
