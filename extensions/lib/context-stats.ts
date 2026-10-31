import { stripVTControlCharacters } from "node:util";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  type ExtensionContext,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

export type ContextCategory = "system" | "summary" | "messages" | "tools" | "other";
export const CONTEXT_CATEGORIES = Object.freeze(["system", "summary", "messages", "tools"] as const);

export interface ContextItem {
  id: string;
  category: ContextCategory;
  label: string;
  kind: string;
  rawTokens: number;
  /** Source estimate availability; numeric zero may instead be a placeholder. */
  rawState: "estimate" | "unknown" | "not-applicable";
  tokens: number | null;
  count: number;
  detail?: readonly string[];
}

export interface ContextCategoryStats {
  id: ContextCategory;
  label: string;
  rawTokens: number;
  tokens: number | null;
  count: number;
}

export interface ContextModelIdentity {
  provider: string;
  api: string;
  id: string;
}

export interface ContextSnapshot {
  usage: { tokens: number | null; contextWindow: number; percent: number | null };
  rawTokens: number;
  categories: readonly ContextCategoryStats[];
  items: readonly ContextItem[];
  updatedAt: number;
  calibrated: boolean;
  allocation: "proportional" | "unattributed" | "raw";
  attribution: "complete" | "partial";
  replay: "selected" | "observed" | "unknown";
  note: string;
}

export interface ContextSnapshotOptions {
  usage?: { tokens: number | null; contextWindow: number; percent: number | null };
  effectiveSystemPrompt?: string;
  /** Physical requested identity bound by the caller to this sample, never responseModel. */
  replayModel?: ContextModelIdentity | null;
  replaySource?: "active-request" | "last-observed-request";
  now?: number;
}

const LABELS: Record<ContextCategory, string> = {
  system: "System", summary: "Summary", messages: "Messages", tools: "Tools", other: "Other",
};
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

function physicalIdentity(value: unknown): ContextModelIdentity | null {
  if (!value || typeof value !== "object") return null;
  if (!("provider" in value) || !("api" in value) || !("id" in value)) return null;
  const { provider, api, id } = value;
  if (typeof provider !== "string" || !provider.trim() || typeof api !== "string" || !api.trim()
    || typeof id !== "string" || !id.trim() || api === "pi-virtual") return null;
  return { provider, api, id };
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_NUMBER, value) : null;
}

function integer(value: unknown): number {
  return Math.floor(nonNegative(value) ?? 0);
}

function boundedSum(values: readonly number[]): number {
  return values.reduce((sum, value) => Math.min(MAX_NUMBER, sum + value), 0);
}

/** Metadata only. Never pass message text, arbitrary arguments or shell commands here. */
function metadata(value: unknown, fallback: string, max = 160): string {
  if (typeof value !== "string") return fallback;
  const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : clean || fallback;
}

function nativePath(name: string, args: unknown): string | undefined {
  if (name !== "read" && name !== "edit" && name !== "write") return undefined;
  if (!args || typeof args !== "object" || !("path" in args)) return undefined;
  const path = metadata(args.path, "", Number.MAX_SAFE_INTEGER);
  return path || undefined;
}

/** Lexical display only: no cwd lookup, path resolution or filesystem access. */
function toolSourceLabel(name: string, path: string | undefined): string {
  const tool = metadata(name, "Tool");
  if (!path) return tool;
  const components = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = `${components.length > 3 ? "…/" : ""}${components.slice(-3).join("/")}`;
  return tail ? `${tool} · ${metadata(tail, "")}` : tool;
}

/** Exact largest-remainder arithmetic, including tiny totals and very large weights. */
function allocate(items: ContextItem[], total: number): void {
  const weights = items.map((item) => BigInt(item.rawTokens));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  if (denominator === 0n) {
    for (const item of items) item.tokens = 0;
    return;
  }
  const target = BigInt(total);
  const shares = weights.map((weight, index) => ({
    index, floor: target * weight / denominator, remainder: target * weight % denominator,
  }));
  let remaining = target - shares.reduce((sum, share) => sum + share.floor, 0n);
  // Ties preserve projection order rather than depending on labels or transcript text.
  shares.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const share of shares) {
    const extra = remaining > 0n ? 1n : 0n;
    items[share.index]!.tokens = Number(share.floor + extra);
    remaining -= extra;
  }
}

/**
 * Read-only, current-main-session projection. No session construction, history IO,
 * credential access, tokenizer, provider request, or context mutation. This is not
 * a provider wire breakdown: extension context hooks and transport overhead may
 * differ. Pass the footer's usage sample to keep all views on exactly one total.
 */
export function collectContextSnapshot(
  ctx: ExtensionContext,
  options: ContextSnapshotOptions = {},
): ContextSnapshot {
  let incomplete = false;
  const safely = <T>(read: () => T): T | undefined => {
    try { return read(); } catch { incomplete = true; return undefined; }
  };
  // Do not sample SDK usage at a second instant when the caller supplied it.
  const sampled = options.usage !== undefined ? options.usage : safely(() => ctx.getContextUsage());
  const rawTotal = safely(() => nonNegative(sampled?.tokens));
  const total = rawTotal == null ? null : Math.floor(rawTotal);
  const usage = {
    tokens: total,
    contextWindow: safely(() => nonNegative(sampled?.contextWindow))
      ?? safely(() => nonNegative(ctx.model?.contextWindow)) ?? 0,
    percent: total === null ? null : safely(() => nonNegative(sampled?.percent)) ?? null,
  };
  const updatedAt = nonNegative(options.now) ?? Date.now();
  const items: ContextItem[] = [];
  const add = (id: string, category: ContextCategory, label: string, kind: string, rawTokens: number | null,
    count = 1, detail?: readonly string[],
    rawState: ContextItem["rawState"] = rawTokens === null ? "unknown" : "estimate"): void => {
    items.push({ id, category, label, kind,
      rawTokens: integer(rawTokens), rawState, tokens: null, count, ...(detail ? { detail } : {}) });
  };
  // Keep failure local to this estimate, even if unrelated APIs already marked the sample partial.
  const estimate = (message: Parameters<typeof estimateTokens>[0]): number | null => {
    const value = nonNegative(safely(() => estimateTokens(message)));
    return value === null ? null : Math.floor(value);
  };
  const entries: ProjectedSessionEntry[] = safely(() => {
    const manager = ctx.sessionManager;
    // Only the selected branch, never all entries, raw logs, or another session.
    const projected = typeof manager.buildSessionProjection === "function"
      ? manager.buildSessionProjection().entries : buildSessionProjection(manager.getBranch()).entries;
    // Detach iteration from API-owned arrays; a malformed/throwing projection is
    // unavailable telemetry, never an exception escaping into a session render.
    if (!Array.isArray(projected)) throw new Error("Invalid session projection");
    return projected.map(({ sourceEntry, messages }) => ({ sourceEntry, messages: [...messages] }));
  }) ?? [];
  const messages = safely(() => entries.flatMap((entry) => entry.messages)) ?? [];
  const prompt = options.effectiveSystemPrompt !== undefined
    ? options.effectiveSystemPrompt : safely(() => ctx.getSystemPrompt());
  if (typeof prompt === "string") {
    if (prompt.length > 0) add("context:system:effective-prompt", "system", "Effective system prompt", "prompt",
      estimate({ role: "system", content: prompt, timestamp: 0 }));
  } else {
    incomplete = true;
  }
  const tools = safely(() => getCurrentTools(messages));
  if (tools && tools.length > 0) {
    add("context:system:tool-declarations", "system", "Tool declarations", "tool-declarations",
      estimate({ role: "system", content: "", toolsAdded: tools, timestamp: 0 }), tools.length,
      tools.map((tool) => metadata(tool.name, "Tool")));
  }

  type Call = { name: string; path?: string; position: number };
  const calls = new Map<string, Call | null>();
  const results = new Map<string, number>();
  // Duplicate IDs are ambiguous even when names/arguments happen to be equal.
  for (const [position, message] of messages.entries()) safely(() => {
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || typeof block.id !== "string" || !block.id) continue;
        const call = { name: block.name, path: nativePath(block.name, block.arguments), position };
        calls.set(block.id, calls.has(block.id) ? null : call);
      }
    } else if (message.role === "toolResult") {
      results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
    }
  });

  const suppliedReplay = options.replayModel !== undefined;
  const selected = suppliedReplay ? undefined : safely(() => ctx.model);
  const model = safely(() => physicalIdentity(suppliedReplay ? options.replayModel : selected)) ?? null;
  const replay: ContextSnapshot["replay"] = model ? suppliedReplay ? "observed" : "selected" : "unknown";
  // Null is deliberately unknown; malformed identities are unavailable metadata.
  if (!model && (suppliedReplay ? options.replayModel !== null
    : safely(() => selected?.api) !== "pi-virtual")) incomplete = true;
  let reasoningUnknown = false;
  let position = 0;
  for (const [entryPosition, entry] of entries.entries()) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      const messagePosition = position++;
      safely(() => {
        const sourceId = entry.sourceEntry?.id;
        const source = typeof sourceId === "string" && sourceId.length > 0
          ? ["entry", sourceId] : ["position", entryPosition];
        const addPart = (category: ContextCategory, label: string, kind: string, rawTokens: number | null,
          count = 1, detail?: readonly string[], blockIndex?: number): void => {
          // Tuple encoding keeps source IDs distinct without delimiter collisions.
          // Never key by emitted row position: omissions and compaction change it.
          const id = `context:${JSON.stringify([...source, message.role, messageIndex, kind, blockIndex ?? null])}`;
          add(id, category, label, kind, rawTokens, count, detail);
        };
        if (message.role === "system") return; // Effective prompt and folded tools already counted.
        if (message.role === "assistant") {
          // The SDK does not replay failed/aborted assistant attempts.
          if (message.stopReason === "error" || message.stopReason === "aborted") return;
          const thinking = message.content.filter((block) => block.type === "thinking");
          const sameModel = model !== null && message.provider === model.provider
            && message.api === model.api && message.model === model.id;
          if (!model && thinking.length > 0) {
            reasoningUnknown = true;
            incomplete = true;
            addPart("messages", "Assistant reasoning (replay unknown)", "reasoning-unknown", null, thinking.length,
              ["Physical requested identity unknown; reasoning replay and input weight are unknown, not zero."]);
          } else if (sameModel) {
            // Responses-family converters omit unsigned thinking, even for a matching identity.
            const replayed = thinking.filter((block) => !RESPONSES_APIS.has(model.api) || Boolean(block.thinkingSignature));
            if (replayed.length > 0) {
              const visible = estimate({ ...message, content: replayed.filter((block) => !block.redacted) });
              const signed = replayed.some((block) => Boolean(block.thinkingSignature) || block.redacted);
              const weight = Math.max(visible ?? 0, signed ? integer(message.usage?.reasoning) : 0);
              const opaque = replayed.some((block) => block.redacted || (Boolean(block.thinkingSignature) && !block.thinking));
              if (opaque && weight === 0) {
                reasoningUnknown = true;
                incomplete = true;
                addPart("messages", "Assistant reasoning (weight unknown)", "reasoning-unknown", null, replayed.length,
                  ["Matching requested identity; opaque reasoning input weight unknown without a positive usage.reasoning or visible estimate. Raw zero is a placeholder, not zero occupancy."]);
              } else {
                addPart("messages", "Assistant reasoning (estimate)", "reasoning",
                  weight > 0 || visible !== null ? weight : null, replayed.length,
                  ["Matching requested identity; adapter-dependent replay estimate. usage.reasoning is a rough weight, not actual input occupancy."]);
              }
            }
          }
          for (const [blockIndex, block] of message.content.entries()) {
            if (block.type === "text") {
              addPart("messages", "Assistant text", "assistant-text", estimate({ ...message, content: [block] }),
                1, undefined, blockIndex);
            } else if (block.type === "toolCall") {
              const call = calls.get(block.id);
              const path = call && call.position === messagePosition && call.name === block.name
                ? call.path : undefined;
              addPart("tools", toolSourceLabel(block.name, path), "tool-call",
                estimate({ ...message, content: [block] }), 1, path ? [path] : undefined, blockIndex);
            }
          }
          return;
        }
        if (message.role === "toolResult") {
          const call = calls.get(message.toolCallId);
          const path = call && call.position < messagePosition && call.name === message.toolName
            && results.get(message.toolCallId) === 1 ? call.path : undefined;
          addPart("tools", toolSourceLabel(message.toolName, path), "tool-result", estimate(message),
            1, path ? [path] : undefined);
          return;
        }
        // Native conversion includes summary wrappers and manual bash framing.
        // Preserve their original source category; wrappers are never labelled User.
        const converted = convertToLlm([message])[0];
        if (!converted) return; // Includes explicitly excluded manual bash (!!).
        if (message.role === "compactionSummary" || message.role === "branchSummary") {
          const kind = message.role === "compactionSummary" ? "compaction" : "branch-summary";
          const fromHook = "fromHook" in entry.sourceEntry && entry.sourceEntry.fromHook === true;
          addPart("summary", kind === "compaction" ? "Compaction summary" : "Branch summary", kind,
            estimate(converted), 1, [fromHook ? "Extension summary" : "Pi summary"]);
        } else if (message.role === "bashExecution") {
          addPart("tools", "Manual bash", "bash-execution", estimate(converted));
        } else if (message.role === "user") {
          addPart("messages", "User message", "user", estimate(converted));
        } else if (message.role === "custom") {
          addPart("messages", "Extension message", "custom-message", estimate(converted), 1,
            [metadata(message.customType, "Extension")]);
        }
      });
    }
  }
  const rawTokens = boundedSum(items.map((item) => item.rawTokens));
  const allocation: ContextSnapshot["allocation"] = total === null ? "raw"
    : reasoningUnknown || (rawTokens === 0 && total > 0) ? "unattributed" : "proportional";
  if (allocation === "unattributed") {
    incomplete = true;
    add("context:other:unattributed", "other", "Unattributed", "unattributed", 0, 1,
      ["Entire SDK total; source allocation is unknown. Raw source weights are retained, not calibrated."], "not-applicable");
    // Known raw weights cannot establish shares while replay weight is unknown.
    // Leave source tokens null, including the zero-raw reasoning metadata row.
    items[items.length - 1]!.tokens = total;
  } else if (total !== null) {
    allocate(items, total);
  }
  const ids: ContextCategory[] = [...CONTEXT_CATEGORIES];
  if (items.some((item) => item.category === "other")) ids.push("other");
  const categories = ids.map((id): ContextCategoryStats => {
    const rows = items.filter((item) => item.category === id);
    return { id, label: LABELS[id], rawTokens: boundedSum(rows.map((item) => item.rawTokens)),
      tokens: allocation === "raw" || (allocation === "unattributed" && id !== "other")
        ? null : boundedSum(rows.map((item) => item.tokens ?? 0)),
      count: boundedSum(rows.map((item) => item.count)) };
  });
  return {
    usage, rawTokens, categories, items, updatedAt, calibrated: allocation === "proportional",
    allocation, attribution: incomplete ? "partial" : "complete", replay,
    note: `${allocation === "raw" ? "SDK total unknown; raw estimates only; source tokens unknown"
      : allocation === "unattributed" ? "Entire SDK total unattributed; source tokens unknown, not zero"
        : "Proportional estimates normalized to SDK total"}; not a provider breakdown. `
      + (replay === "observed"
        ? `Physical requested identity observed for ${options.replaySource === "active-request" ? "the active request"
          : options.replaySource === "last-observed-request" ? "the last observed request" : "a sampled request"}; not a prediction of the next route. `
        : replay === "selected" ? "Replay estimated for the selected physical model. "
          : "Physical replay identity unknown; no prediction of the next route. ")
      + (reasoningUnknown ? replay === "unknown"
        ? "Reasoning replay and weight unknown; raw reasoning zero is a placeholder, not zero occupancy. "
        : "Replay identity known; opaque reasoning weight unknown without a positive proxy or visible estimate; raw reasoning zero is a placeholder, not zero occupancy. "
        : "")
      + "Images use the SDK heuristic; opaque signatures are not tokenized."
      + (incomplete ? " Attribution is incomplete: replay weights, context APIs or metadata were unavailable; available raw weights may still be used for proportional estimates." : ""),
  };
}
