#!/usr/bin/env node
// Offline, explicit-file JSONL analysis. No linked paths, directory scans or IO
// beyond the supplied regular files. Output contains aggregates, not message text.
// Two streaming passes retain only hashes, identities and compact call metadata.
// Caps bound input/metadata, not process RSS: 128 files, 4 GiB input per pass,
// 16 MiB/line, 2M entries/calls, JSON depth 128, 4096 tool/model groups.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LIMITS = Object.freeze({ files: 128, bytes: 4 * 1024 ** 3,
  line_bytes: 16 * 1024 ** 2, entries: 2_000_000, calls: 2_000_000, depth: 128, groups: 4096 });
const management = new Set(["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read",
  "agent_interrupt", "agent_kill", "agent_list"]);
const reasons = new Set(["snapshot", "aborted", "owner_blocked", "question", "task_issue", "done", "alert",
  "nothing_pending", "timeout", "needs_input"]);
const metrics = ["input", "output", "cacheRead", "cacheWrite", "cost"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
// Provider IDs are opaque (OpenAI commonly includes '|'), not SDK entry IDs.
const toolCallIdentity = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const label = value => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:/@+-]{0,159}$/.test(value) ? value : "unknown";
const bump = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const keyOf = (...parts) => JSON.stringify(parts);
const fail = (file, line, reason) => { throw new Error(`${JSON.stringify(file)}:${line}: ${reason}`); };
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Full calendar validation: Date.parse alone normalizes e.g. February 30.
export function isoTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

const cliUsage = "Usage: node scripts/analyze-pi-session.mjs [--json] [--since ISO] [--until ISO] JOURNAL.jsonl [JOURNAL.jsonl ...]";
export function parseArgs(args) {
  const options = { json: false, since: undefined, until: undefined, files: [] };
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { options.files.push(arg); continue; }
    if (!["--json", "--since", "--until"].includes(arg) || flags.has(arg)) throw new Error("Invalid command line.");
    flags.add(arg);
    if (arg === "--json") options.json = true;
    else {
      const value = args[++i];
      if (isoTime(value) === null) throw new Error("Invalid timestamp bound (ISO date-time with explicit timezone required).");
      options[arg.slice(2)] = value;
    }
  }
  if (!options.files.length || options.files.length > LIMITS.files) throw new Error("Supply 1 to 128 explicit files.");
  if (options.since !== undefined && options.until !== undefined && isoTime(options.since) > isoTime(options.until)) throw new Error("Reversed timestamp bounds.");
  return options;
}

function digest(value) {
  const hash = createHash("sha256");
  const walk = (part, depth) => {
    if (depth > LIMITS.depth) throw new Error("depth");
    if (Array.isArray(part)) {
      hash.update("[");
      for (const item of part) { walk(item, depth + 1); hash.update(","); }
      hash.update("]");
    } else if (object(part)) {
      hash.update("{");
      for (const key of Object.keys(part).sort()) { hash.update(JSON.stringify(key) + ":"); walk(part[key], depth + 1); hash.update(","); }
      hash.update("}");
    } else hash.update(`${typeof part}:${String(part === null ? null : typeof part === "number" ? part : JSON.stringify(part))}`);
  };
  walk(value, 0);
  return hash.digest("hex");
}
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

async function* records(file, budget, expected) {
  let handle, line = 1;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { fail(file, line, "cannot open input"); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(file, line, "input is not a regular file");
    if (expected !== undefined && expected !== signature(before)) fail(file, line, "input changed between passes");
    budget.bytes += Number(before.size);
    if (budget.bytes > LIMITS.bytes) fail(file, line, "input byte cap exceeded");
    let pieces = [], length = 0, readBytes = 0;
    // Non-streaming decode resets state per line; keep fatal UTF-8/BOM handling.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const decode = buffer => {
      let entry;
      try { entry = JSON.parse(decoder.decode(buffer)); }
      catch { fail(file, line, "invalid JSON or UTF-8"); }
      if (!object(entry)) fail(file, line, "record must be an object");
      if (!identity(entry.id) || !identity(entry.type)) fail(file, line, "invalid record identity or type");
      if (isoTime(entry.timestamp) === null) fail(file, line, "invalid persisted timestamp");
      if (entry.type === "message" && (!object(entry.message) || !identity(entry.message.role))) fail(file, line, "invalid message record");
      return { entry, line, signature: signature(before) };
    };
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      readBytes += chunk.length;
      if (readBytes > Number(before.size)) fail(file, line, "input changed while reading");
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end;
        const piece = chunk.subarray(start, stop);
        length += piece.length;
        if (length > LIMITS.line_bytes) fail(file, line, "line byte cap exceeded");
        pieces.push(piece);
        if (end < 0) break;
        yield decode(Buffer.concat(pieces, length));
        line++; pieces = []; length = 0; start = end + 1;
      }
    }
    if (length) yield decode(Buffer.concat(pieces, length));
    if (line === 1 && !length) fail(file, 1, "empty input");
    const after = await handle.stat({ bigint: true });
    if (signature(before) !== signature(after) || readBytes !== Number(before.size)) fail(file, line, "input changed while reading");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${JSON.stringify(file)}:`)) throw error;
    fail(file, line, "cannot process input");
  } finally { await handle.close(); }
}

function newUsage() {
  return { records: 0, usage_records: 0, error_or_aborted_records: 0, sums: Object.fromEntries(metrics.map(m => [m, 0])),
    known: Object.fromEntries(metrics.map(m => [m, 0])), missing: Object.fromEntries(metrics.map(m => [m, 0])),
    invalid: Object.fromEntries(metrics.map(m => [m, 0])), declared_partial: Object.fromEntries(metrics.map(m => [m, 0])) };
}
function addUsage(target, usage, errorOrAborted = false) {
  target.records++;
  if (object(usage)) target.usage_records++;
  // Failed streams may expose SDK-initialized zero usage, not a provider frame.
  // Keep numeric floors and one actual record; uncertainty is a separate cause.
  if (errorOrAborted) target.error_or_aborted_records++;
  // HostUsage rows are attribution claims against the flat total, not more
  // spend. Preserve recognized partial markers even on otherwise invalid rows.
  const rows = Array.isArray(usage?.harnessModels) ? usage.harnessModels : [];
  const hasPartial = (markers, metric, alias) => Array.isArray(markers) && (markers.includes(metric) || markers.includes(alias));
  for (const metric of metrics) {
    const alias = metric === "cacheRead" ? "cache_read" : metric === "cacheWrite" ? "cache_write" : metric;
    const value = metric === "cost" && object(usage?.cost) ? usage.cost.total : usage?.[metric] ?? usage?.[alias];
    if (value === undefined) target.missing[metric]++;
    else if (!finite(value) || !Number.isFinite(target.sums[metric] + value)) target.invalid[metric]++;
    else { target.known[metric]++; target.sums[metric] += value; }
    if (hasPartial(usage?.partial, metric, alias) || hasPartial(usage?.harnessPartial, metric, alias) ||
        rows.some(row => hasPartial(row?.partial, metric, alias))) target.declared_partial[metric]++;
  }
}
function usageReport(target) {
  const partial = metrics.filter(m => target.missing[m] || target.invalid[m] || target.declared_partial[m] || target.error_or_aborted_records);
  const prompt = target.sums.input + target.sums.cacheRead + target.sums.cacheWrite;
  return { records: target.records, usage_records: target.usage_records, error_or_aborted_records: target.error_or_aborted_records,
    ...Object.fromEntries(metrics.map(m => [m, target.known[m] ? target.sums[m] : null])),
    partial, missing: target.missing, invalid: target.invalid, declared_partial: target.declared_partial,
    cache_hit_rate: Number.isFinite(prompt) && prompt > 0 && ["input", "cacheRead", "cacheWrite"].every(m => !partial.includes(m)) ? target.sums.cacheRead / prompt : null };
}
const replyOf = message => {
  const text = Array.isArray(message.content) ? message.content.find(part => part?.type === "text")?.text : undefined;
  if (typeof text !== "string") return undefined;
  try { const reply = JSON.parse(text); return object(reply) ? reply : undefined; } catch { return undefined; }
};

export async function analyzeSessions(files, { since, until } = {}) {
  // Reuse CLI validation for library calls as well, without opening any file.
  parseArgs([...(since === undefined ? [] : ["--since", since]), ...(until === undefined ? [] : ["--until", until]), ...files]);
  const paths = [...new Set(files.map(file => resolve(file)))];
  const seen = new Map(), headers = new Map(), sessions = new Map(), calls = new Map(), signatures = new Map();
  let duplicates = 0, duplicateHeaders = 0, callCount = 0;
  const evidence = (id, kind) => {
    if (!identity(id)) return;
    if (!sessions.has(id)) sessions.set(id, new Set());
    sessions.get(id).add(kind);
  };
  const firstBudget = { bytes: 0 };
  for (const file of paths) {
    let session;
    for await (const { entry, line, signature: sig } of records(file, firstBudget)) {
      signatures.set(file, sig);
      let hash;
      try { hash = digest(entry); } catch { fail(file, line, "JSON depth cap exceeded"); }
      if (line === 1) {
        if (entry.type !== "session") fail(file, line, "missing session header");
        session = entry.id;
        if (!sessions.has(session)) sessions.set(session, new Set());
        const prior = headers.get(session);
        if (prior && prior !== hash) fail(file, line, "conflicting session identity");
        if (prior) duplicateHeaders++;
        headers.set(session, hash);
        continue;
      }
      if (entry.type === "session") fail(file, line, "unexpected session header");
      const key = keyOf(session, entry.id), prior = seen.get(key);
      if (prior) {
        if (prior.hash !== hash) fail(file, line, "conflicting entry identity");
        duplicates++; continue;
      }
      if (seen.size >= LIMITS.entries) fail(file, line, "entry cap exceeded");
      seen.set(key, { hash, file, line });
      if (entry.type === "custom") {
        const data = entry.data;
        if (["harness:run-start:v1", "harness:run-end:v1"].includes(entry.customType)) {
          const owner = data?.owner_id ?? data?.ref?.owner_id;
          if (identity(owner)) { evidence(owner, "parent"); evidence(session, owner === session ? "parent" : "child"); }
        } else if (entry.customType === "harness:run-link:v1" && data?.ref?.owner_id === session) {
          evidence(session, "parent"); evidence(data.ref.session_id, "child");
        } else if (entry.customType === "harness:unreported-usage:v1" && data?.owner_id === session) evidence(session, "parent");
      }
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const call of Array.isArray(entry.message.content) ? entry.message.content : []) {
        if (call?.type !== "toolCall") continue;
        if (!toolCallIdentity(call.id) || !identity(call.name)) fail(file, line, "invalid tool-call identity");
        if (++callCount > LIMITS.calls) fail(file, line, "tool-call cap exceeded");
        const callKey = keyOf(session, call.id), old = calls.get(callKey);
        if (old) { old.ambiguous = true; if (old.name !== call.name) old.name = undefined; }
        else calls.set(callKey, { name: call.name, wait_ms: finite(call.arguments?.wait_ms) ? call.arguments.wait_ms : undefined,
          after_agents: Array.isArray(call.arguments?.after) ? call.arguments.after.length : 0, ambiguous: false });
      }
    }
  }
  const kindOf = session => {
    const kinds = sessions.get(session);
    return kinds?.size === 1 ? [...kinds][0] : "unknown";
  };
  const sessionClassification = { parent: 0, child: 0, unknown: 0, conflicting: 0 };
  for (const id of headers.keys()) { sessionClassification[kindOf(id)]++; if (sessions.get(id).size > 1) sessionClassification.conflicting++; }
  const sourceUsage = Object.fromEntries(["assistant", "compaction", "usage", "branch_summary"].map(source => [source, newUsage()]));
  const totalUsage = newUsage(), parentUsage = newUsage(), attachedUsage = newUsage(), models = new Map(), tools = new Map();
  const turnKinds = { parent: 0, child: 0, unknown: 0 }, userKinds = { parent: 0, child: 0, unknown: 0 };
  const harness = {
    spawn: { ok: 0, with_wait_ms: 0, after_agents: 0, args_unknown: 0 },
    run: { ok: 0, with_wait_ms: 0, after_agents: 0, args_unknown: 0 },
    answer: { ok: 0, with_wait_ms: 0, args_unknown: 0 },
    send: { steered: 0, joined: 0, not_delivered: 0, unknown: 0, invalid_modern_delivery: 0, with_wait_ms: 0, args_unknown: 0,
      modern: { steered: 0, joined: 0, not_delivered: 0, unknown: 0 },
      legacy: { steered: 0, joined: 0, answered: 0, not_delivered: 0, unknown: 0 } },
    errors: {}, wait: { calls: 0, calls_including_errors: 0, short_wait_le_1s: 0, short_timeout: 0, args_unknown: 0, reasons: {} },
    agent_list: 0, agent_read: 0, agent_interrupt: 0, agent_kill: 0, finished_seen: 0, unparsed_replies: 0,
  };
  const correlation = { matched: 0, missing: 0, ambiguous: 0, name_mismatch: 0 };
  const projections = { tool_result_attached: null, tool_results_without_attached_usage: 0, harness_run_end_records: 0,
    harness_unreported_usage_records: 0, additive: false, scope: "all toolResult usage, not necessarily harness children" };
  const errors = { assistant_error_stops: 0, management_tool_results: 0 };
  const secondBudget = { bytes: 0 }, lower = since === undefined ? -Infinity : isoTime(since), upper = until === undefined ? Infinity : isoTime(until);
  let selected = 0, compactions = 0, toolTurns = 0;
  const boundedGroup = (map, key, value, file, line) => {
    if (!map.has(key) && map.size >= LIMITS.groups) fail(file, line, "report group cap exceeded");
    if (!map.has(key)) map.set(key, value);
    return map.get(key);
  };
  for (const file of paths) {
    let session;
    for await (const { entry, line } of records(file, secondBudget, signatures.get(file))) {
      if (line === 1) { session = entry.id; continue; }
      const prior = seen.get(keyOf(session, entry.id));
      // Bind reread content to first-pass correlation/dedup metadata, even for
      // duplicates and out-of-window entries. Stat checks alone are not enough.
      if (!prior || prior.hash !== digest(entry)) fail(file, line, "input changed between passes");
      if (prior.file !== file || prior.line !== line) continue;
      const time = isoTime(entry.timestamp);
      if (time < lower || time > upper) continue;
      selected++;
      const kind = kindOf(session);
      if (entry.type === "custom") {
        if (entry.customType === "harness:run-end:v1") projections.harness_run_end_records++;
        if (entry.customType === "harness:unreported-usage:v1") projections.harness_unreported_usage_records++;
      }
      if (entry.type === "compaction") compactions++;
      const message = entry.type === "message" ? entry.message : undefined;
      const source = message?.role === "assistant" ? "assistant" : ["compaction", "usage", "branch_summary"].includes(entry.type) ? entry.type : undefined;
      if (source) {
        const usage = message ? message.usage : entry.usage ?? entry.details?.usage;
        const errorOrAborted = source === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
        addUsage(sourceUsage[source], usage, errorOrAborted); addUsage(totalUsage, usage, errorOrAborted);
        if (source === "assistant" && kind !== "child") addUsage(parentUsage, usage, errorOrAborted);
        const provider = label(message?.provider ?? entry.provider ?? entry.details?.provider);
        const model = label(message?.responseModel ?? message?.model ?? entry.model ?? entry.details?.model);
        const group = boundedGroup(models, keyOf(source, provider, model), { source, provider, model, usage: newUsage() }, file, line);
        addUsage(group.usage, usage, errorOrAborted);
      }
      if (!message) continue;
      if (message.role === "user") userKinds[kind]++;
      if (message.role === "assistant") {
        if (message.stopReason === "error") errors.assistant_error_stops++;
        const toolCalls = (Array.isArray(message.content) ? message.content : []).filter(part => part?.type === "toolCall");
        if (toolCalls.length) {
          toolTurns++;
          if (toolCalls.every(call => management.has(call.name))) turnKinds[kind]++;
        }
        for (const call of toolCalls) {
          const name = label(call.name);
          boundedGroup(tools, name, 0, file, line); tools.set(name, tools.get(name) + 1);
        }
      }
      if (message.role !== "toolResult") continue;
      if (message.usage !== undefined) addUsage(attachedUsage, message.usage);
      else projections.tool_results_without_attached_usage++;
      const call = calls.get(keyOf(session, message.toolCallId));
      const status = !call ? "missing" : call.ambiguous ? "ambiguous" : message.toolName !== undefined && message.toolName !== call.name ? "name_mismatch" : "matched";
      correlation[status]++;
      const name = message.toolName ?? call?.name;
      if (!management.has(name)) continue;
      const reply = replyOf(message);
      if (!reply) harness.unparsed_replies++;
      if (Array.isArray(reply?.finished)) harness.finished_seen += reply.finished.length;
      const args = status === "matched" ? call : undefined;
      if (name === "agent_wait") {
        harness.wait.calls_including_errors++;
        if (args && finite(args.wait_ms) && args.wait_ms <= 1000) harness.wait.short_wait_le_1s++;
      }
      if (message.isError) {
        errors.management_tool_results++;
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(reply?.error?.code) ? reply.error.code : "unknown";
        bump(harness.errors, `${name}:${code}`); continue;
      }
      switch (name) {
        case "agent_spawn": case "agent_run": case "agent_answer": {
          const record = harness[name === "agent_spawn" ? "spawn" : name === "agent_run" ? "run" : "answer"];
          record.ok++;
          if (!args) record.args_unknown++;
          else { if (finite(args.wait_ms) && args.wait_ms > 0) record.with_wait_ms++; if ("after_agents" in record) record.after_agents += args.after_agents; }
          break;
        }
        case "agent_send": {
          // Presence of an action marks the modern shape: never fall back to a
          // historical top-level "answered" (or manufacture a modern answer).
          const modern = reply !== undefined && Object.hasOwn(reply, "action");
          const delivery = modern ? reply.action?.delivery : reply?.delivery;
          const allowed = modern ? ["steered", "joined", "not_delivered"] : ["steered", "joined", "not_delivered", "answered"];
          const value = allowed.includes(delivery) ? delivery : "unknown";
          bump(modern ? harness.send.modern : harness.send.legacy, value);
          if (modern && delivery !== undefined && value === "unknown") harness.send.invalid_modern_delivery++;
          if (value !== "answered") bump(harness.send, value);
          if (!args) harness.send.args_unknown++;
          else if (finite(args.wait_ms) && args.wait_ms > 0) harness.send.with_wait_ms++;
          break;
        }
        case "agent_wait":
          harness.wait.calls++;
          if (!args) harness.wait.args_unknown++;
          bump(harness.wait.reasons, reasons.has(reply?.reason) ? reply.reason : "unknown");
          if (reply?.reason === "timeout" && args && finite(args.wait_ms) && args.wait_ms <= 1000) {
            harness.wait.short_timeout++;
          }
          break;
        default: harness[name]++;
      }
    }
  }
  projections.tool_result_attached = usageReport(attachedUsage);
  const parent = usageReport(parentUsage);
  return {
    file: paths[0], files: paths, window: { since: since ?? null, until: until ?? null, inclusive: true, clock: "persisted entry.timestamp" },
    inputs: { sessions: headers.size, unique_entries: seen.size, selected_entries: selected, outside_window_entries: seen.size - selected,
      duplicate_file_arguments: files.length - paths.length, duplicate_entries: duplicates, duplicate_headers: duplicateHeaders, bytes: firstBudget.bytes, passes: 2, limits: LIMITS },
    session_classification: sessionClassification,
    user_messages: userKinds.parent + userKinds.child + userKinds.unknown, user_messages_by_session_kind: userKinds, human_requests: null, human_request_candidates: userKinds.parent,
    compactions, parent: { ...parent, calls: parent.records, scope: "assistant usage in parent and unknown sessions; excludes identified children" },
    raw_usage: { scope: "selected raw sources in supplied files/window only; not complete parent+all-child spend; no harness projections added", total: usageReport(totalUsage),
      ...Object.fromEntries(Object.entries(sourceUsage).map(([source, usage]) => [source, usageReport(usage)])),
      by_model: [...models.values()].sort((a, b) => keyOf(a.source, a.provider, a.model).localeCompare(keyOf(b.source, b.provider, b.model)))
        .map(group => ({ ...group, usage: usageReport(group.usage) })) },
    child_cost_attached: projections.tool_result_attached.cost, non_additive: projections,
    tool_turns: toolTurns, management_only_turns: turnKinds.parent + turnKinds.unknown, management_only_turns_by_session_kind: turnKinds,
    tools: Object.fromEntries([...tools].sort(([a], [b]) => a.localeCompare(b))), argument_correlation: correlation, errors,
    harness: { ...harness, wait: { ...harness.wait, short_timeout_le_1s: harness.wait.short_timeout } },
    limits_of_inference: [
      "Only explicitly supplied files are read, twice; parentSession, session_file and run-link paths are never followed. Stat/change checks are freshness checks, not fsync or atomic snapshot proof.",
      "Deduplication is SDK session+entry identity only. Fork/clone histories with different session IDs can repeat provider operations; there is no cross-session billing deduplication.",
      "Classification uses harness owner/session identity across all supplied records, including outside the window. Header ancestry alone may be a fork, not a child; absent/conflicting evidence is unknown.",
      "User-role records in identified parent sessions are human-request candidates, not verified human requests; child task prompts and unknown sessions are separate.",
      "Usage sources: assistant message.usage; compaction/usage/branch_summary entry.usage (fallback details.usage). Assistant attribution prefers responseModel over model; summary model metadata may be requested, not actual. Other shapes/failed summary attempts may be absent.",
      "error_or_aborted_records counts assistant error/aborted stops whose provider usage frame is uncertain. Numeric floors and actual record counts are preserved, but all components are partial; this is separate from missing figures or declared partial markers.",
      "Null metrics mean no numeric observation; partial/missing/invalid metrics are gaps, not zero prices. Recognized partial components are unioned from partial, harnessPartial and harnessModels[].partial, including on malformed attribution rows; row amounts are never added again. Numeric sums are observed values only, not complete provider billing.",
      "ToolResult attached usage (compatibility field child_cost_attached) is all tool-result usage: it may overlap supplied child raw usage or include other nested model calls absent from raw records. It and harness run-end/unreported-usage projections are non-additive, never blindly added to raw usage or to one another.",
      "Assistant error stops and management isError results are separate from timeout/question observations; neither necessarily denotes a provider API failure.",
      "Reused tool-call IDs within a session are ambiguous; argument-dependent counts exclude them and expose args_unknown, not assumed zero. Distinct entry IDs are retained.",
      "Management-only turns include unknown sessions but exclude identified children. ok counts non-error tool results, finished_seen counts rows presented; neither is a task-quality or success rate.",
      "Wait metrics use selected toolResult timestamps. calls excludes isError results; calls_including_errors and short_wait_le_1s include them. short_wait_le_1s requires correlated explicit wait_ms <= 1000; legacy field short_timeout now counts only non-error timeout replies at that threshold (also short_timeout_le_1s). Tool errors and needs-input/question observations remain separate.",
    ],
  };
}

function textReport(report) {
  const { harness, raw_usage: { total }, argument_correlation: correlation, errors } = report;
  const wait = harness.wait;
  return [
    `sessions           ${report.inputs.sessions} (classification ${JSON.stringify(report.session_classification)})`,
    `entries            ${report.inputs.selected_entries} selected; ${report.inputs.duplicate_entries} duplicates excluded`,
    `user records       ${report.user_messages} (not verified human requests)`,
    `parent/unknown LLM ${report.parent.calls} calls; observed cost ${report.parent.cost ?? "unknown"}`,
    `raw usage          ${total.records} records; observed cost ${total.cost ?? "unknown"}; partial components: ${total.partial.join(", ") || "none"}`,
    `tool usage attached ${report.child_cost_attached ?? "unknown"} (NON-ADDITIVE; not necessarily child Agents)`,
    `tool turns         ${report.tool_turns}; non-child management-only ${report.management_only_turns}`,
    `management results spawn ${harness.spawn.ok}; run ${harness.run.ok}; answer ${harness.answer.ok} (non-error)`,
    `send delivery      steered ${harness.send.steered}; joined ${harness.send.joined}; not delivered ${harness.send.not_delivered}; unknown ${harness.send.unknown}; legacy answered ${harness.send.legacy.answered}`,
    `wait results       ${wait.calls_including_errors} including errors; ${wait.calls} non-error; explicit <=1s ${wait.short_wait_le_1s}; short timeouts ${wait.short_timeout_le_1s}`,
    `management other   list ${harness.agent_list}; read ${harness.agent_read}; interrupt ${harness.agent_interrupt}; kill ${harness.agent_kill}; finished rows ${harness.finished_seen}`,
    `tools              ${JSON.stringify(report.tools)}`,
    `argument matching  matched ${correlation.matched}; missing ${correlation.missing}; ambiguous ${correlation.ambiguous}; name mismatch ${correlation.name_mismatch}`,
    `error observations assistant stops ${errors.assistant_error_stops}; management results ${errors.management_tool_results}; unparsed replies ${harness.unparsed_replies}`,
    "warning: observed usage is not complete billing; missing/partial components are unknown, not zero. --json for full scopes/counters.",
    "warning: session+entry dedup only; fork/clone histories may repeat provider operations. Explicit files/window only.",
    "warning: non-error results/finished rows are not task quality or success; errors are separate from timeout/question observations.",
  ].join("\n");
}
async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n${cliUsage}`); process.exitCode = 2; return; }
  try {
    const report = await analyzeSessions(options.files, options);
    console.log(options.json ? JSON.stringify(report, null, 2) : textReport(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
async function isMain() {
  if (!process.argv[1]) return false;
  // Keep the lexical match for --preserve-symlinks-main; normally Node resolves
  // the main module's symlinks, but leaves process.argv[1] unresolved.
  if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) return true;
  try { return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href; }
  catch { return false; } // Imports may have no existing file at argv[1].
}
if (await isMain()) await main();
