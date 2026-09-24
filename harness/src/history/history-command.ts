import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isId, boundedOutput } from "../core/result-text.js";
import { USAGE_COMPONENTS, type Usage } from "../core/usage-ledger.js";
import { historyTypes } from "./run-journal.js";
import { readSdkRun } from "./history-reader.js";
import { residueType } from "./usage-audit.js";

const DEFAULT_MAX_MIB = 8, MAX_MIB = 64;
const commandUsage = "/harness-history RUN_ID [nonnegative UTF-16 offset] [--max-mib N] (N: 1..64, default 8; per file, not RAM)";

/** Fixed scalar projection: never serialize arbitrary stored checkpoint data. */
function checkpointSummary(data: unknown): unknown {
  const malformed = { error: "MALFORMED_USAGE_CHECKPOINT" };
  try {
    if (!data || typeof data !== "object") return malformed;
    const raw = data as { owner_id?: unknown; generation?: unknown; closed?: unknown; recorded_at?: unknown;
      usage?: { total?: Usage; partial?: unknown } };
    if (!isId(raw.owner_id) || !isId(raw.generation) || typeof raw.closed !== "boolean" ||
        typeof raw.recorded_at !== "number" || !Number.isFinite(raw.recorded_at) || !raw.usage?.total ||
        !Array.isArray(raw.usage.partial) || raw.usage.partial.length > USAGE_COMPONENTS.length) return malformed;
    const source = raw.usage.total;
    const partial: readonly unknown[] = raw.usage.partial;
    const total = Object.fromEntries(USAGE_COMPONENTS.map((key) => [key, source[key]]));
    if (Object.values(total).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
        partial.some((key) => !(USAGE_COMPONENTS as readonly unknown[]).includes(key))) return malformed;
    return { owner_id: raw.owner_id, generation: raw.generation, closed: raw.closed, recorded_at: raw.recorded_at,
      usage: { total, partial: [...partial] } };
  } catch { return malformed; }
}

/** Explicit user-facing cold lookup. Paths come only from this parent SDK;
 * no arbitrary file arguments, session repair, global scan or execution resume.
 */
export const historicalRunsCommand = ((pi) => {
  pi.registerCommand("harness-history", {
    description: "Read linked Runs: [run_id [UTF-16 offset] [--max-mib N]]. Default 8 MiB/file, max 64. No live resume.",
    handler: async (args, ctx) => {
      const parts = args.trim() ? args.trim().split(/\s+/) : [];
      if (!parts.length) {
        const entries = ctx.sessionManager.getEntries();
        const links = entries.filter((entry) => entry.type === "custom" && entry.customType === historyTypes.link);
        const checkpoint = entries.findLast((entry) => entry.type === "custom" && entry.customType === residueType);
        const runs = links.slice(-16).map((entry) => {
          const ref = (entry as { data?: { ref?: { run_id?: unknown; agent_id?: unknown } } }).data?.ref;
          return { run_id: isId(ref?.run_id) ? ref.run_id : "invalid", agent_id: isId(ref?.agent_id) ? ref.agent_id : "invalid" };
        });
        // Project only fixed scalar fields BEFORE serialization. Another
        // extension may have written cyclic/huge in-memory custom data.
        ctx.ui.notify(boundedOutput(JSON.stringify({ runs, older_runs: Math.max(0, links.length - runs.length),
          latest_unreported_checkpoint: checkpoint?.type === "custom" ? checkpointSummary(checkpoint.data) : undefined,
          help: `${commandUsage}; checkpoints are snapshots, not additive charges` }), 16384).text, "info");
        return;
      }
      let maxMiB = DEFAULT_MAX_MIB;
      const limitAt = parts.indexOf("--max-mib");
      if (limitAt !== -1) {
        const raw = parts[limitAt + 1];
        if (limitAt !== parts.length - 2 || !raw || !/^\d+$/.test(raw) ||
            !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > MAX_MIB) {
          ctx.ui.notify(`Usage: ${commandUsage}`, "warning"); return;
        }
        maxMiB = Number(raw); parts.splice(limitAt, 2);
      }
      const [run_id, rawOffset] = parts, offset = rawOffset === undefined ? 0 : Number(rawOffset);
      if (parts.length > 2 || !isId(run_id) || !Number.isSafeInteger(offset) || offset < 0 ||
          (rawOffset !== undefined && !/^\d+$/.test(rawOffset))) {
        ctx.ui.notify(`Usage: ${commandUsage}`, "warning"); return;
      }
      const parentFile = ctx.sessionManager.getSessionFile();
      if (!parentFile) { ctx.ui.notify("This parent has no saved SDK history.", "warning"); return; }
      const result = await readSdkRun({ sessionManager: SessionManager, parentFile,
        sessionDirectory: ctx.sessionManager.getSessionDir(), run_id, maxBytes: maxMiB * 1024 * 1024 });
      if (!result.output) {
        ctx.ui.notify(JSON.stringify({ ...result, max_mib: maxMiB, ...(result.error === "HISTORY_TOO_LARGE" ? {
          help: maxMiB < MAX_MIB ? `Opt in with /harness-history ${run_id} ${offset} --max-mib ${MAX_MIB}. ` +
            "Larger per-file caps increase parsing memory; they are not RAM limits." :
            "The 64 MiB per-file hard limit was reached. This command cannot read larger parent/child logs.",
        } : {}) }), "warning"); return;
      }
      const { text, ...output } = result.output;
      if (offset > text.length || (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))) {
        ctx.ui.notify("Invalid history offset (outside retained text or inside a surrogate pair).", "warning"); return;
      }
      const page = boundedOutput(text.slice(offset), 16384);
      const next = offset + page.text.length;
      ctx.ui.notify(JSON.stringify({ ...result, max_mib: maxMiB, output: { ...output, text: page.text, retained_chars: text.length, offset,
        ...(next < text.length ? { next_offset: next,
          next_command: `/harness-history ${run_id} ${next} --max-mib ${maxMiB}` } : {}) } }), "info");
    },
  });
}) satisfies ExtensionFactory;
