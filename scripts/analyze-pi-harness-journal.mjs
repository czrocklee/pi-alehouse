#!/usr/bin/env node
// Source-only offline audit. Only explicitly supplied SDK journals are opened;
// links/prompts are data, never paths to follow. No SDK repair, scan or network.
// JSON-only output; --json is an explicit alias. Strict errors fail the batch,
// not a zero-cost result or an implicitly salvaged partial accounting report.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = { start: "harness:run-start:v1", end: "harness:run-end:v1", link: "harness:run-link:v1",
  residue: "harness:unreported-usage:v1" };
const RECEIPT_ERROR = "invalid_validation_receipt";
const COMPONENTS = ["input", "output", "cache_read", "cache_write", "cost"];
const LIMITS = { files: 64, file_bytes: 8 * 1024 * 1024, total_bytes: 64 * 1024 * 1024,
  lines: 250000, line_bytes: 1024 * 1024 };
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const entryId = value => typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
const identity = value => object(value) && [value.owner_id, value.generation, value.agent_id, value.run_id].every(id);
const ref = value => identity(value) && id(value.session_id) && entryId(value.start_entry_id) &&
  (value.end_entry_id === undefined || entryId(value.end_entry_id));
const keyOf = value => JSON.stringify([value.owner_id, value.generation, value.agent_id, value.run_id]);
const runOf = value => Object.fromEntries(["owner_id", "generation", "agent_id", "run_id"].map(key => [key, value[key]]));
const fail = message => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const zero = () => Object.fromEntries(COMPONENTS.map(key => [key, 0]));
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// Match core's observed-floor normalization: totals derive only from model shares;
// missing/invalid metrics are partial, not fabricated prices. Reject bad containers.
function ledger(value, allowEmptyFloor = false) {
  // Finalization failure may leave a legal residue floor with no model shares.
  // Its zero total is only an observed floor; partial cost remains unknown.
  assert(object(value) && object(value.byModel) && (allowEmptyFloor || Object.keys(value.byModel).length > 0), "invalid usage ledger");
  assert(value.partial === undefined || (Array.isArray(value.partial) && value.partial.every(key => COMPONENTS.includes(key))), "invalid usage partial");
  const partial = new Set(value.partial ?? []), byModel = Object.create(null), total = zero();
  for (const [model, raw] of Object.entries(value.byModel)) {
    assert(model.length > 0 && object(raw), "invalid model usage");
    const share = zero();
    for (const key of COMPONENTS) {
      if (finite(raw[key])) share[key] = raw[key]; else partial.add(key);
      total[key] += share[key]; assert(finite(total[key]), "usage overflow");
    }
    byModel[model] = share;
  }
  return { total, partial: COMPONENTS.filter(key => partial.has(key)), byModel };
}
function merge(left, right) {
  if (!right) return left;
  if (!left) return structuredClone(right);
  const byModel = Object.assign(Object.create(null), left.byModel), partial = new Set([...left.partial, ...right.partial]);
  for (const [model, share] of Object.entries(right.byModel)) {
    const sum = { ...(byModel[model] ?? zero()) };
    for (const key of COMPONENTS) { sum[key] += share[key]; assert(finite(sum[key]), "usage overflow"); }
    byModel[model] = sum;
  }
  return ledger({ byModel, partial: [...partial] });
}
function outcomeOf(value) {
  assert(object(value) && ["completed", "needs_input", "failed", "cancelled"].includes(value.status) &&
    typeof value.limit_reached === "boolean" && (value.time_wrapped === undefined || value.time_wrapped === true) &&
    [value.reason, value.error, value.question].every(item => item === undefined || typeof item === "string") &&
    (value.model_stop_reason === undefined || (typeof value.model_stop_reason === "string" && value.model_stop_reason.length > 0 && value.model_stop_reason.length <= 128)), "invalid outcome");
  return { status: value.status, ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.time_wrapped ? { time_wrapped: true } : {}) };
}
function receiptOf(value, outcome) {
  // Keep this bounded scalar schema aligned with core/dispatch.ts. No arbitrary
  // optional/custom fields are projected or treated as verification evidence.
  const word = item => typeof item === "string" && !!item.trim() && item.length <= 512 && !/[\x00-\x1f\x7f]/.test(item);
  const path = item => typeof item === "string" && item.length <= 4096 && isAbsolute(item);
  assert(object(value) && value.version === 1 && Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 16 &&
    value.checks.every(word) && new Set(value.checks).size === value.checks.length && path(value.cwd) &&
    (value.tree === undefined || path(value.tree)) && object(value.outcome), "invalid validation receipt");
  const s = value.source_state;
  assert(object(s) && ((s.state === "unknown" && typeof s.reason === "string" && s.reason.length > 0 && s.reason.length <= 120) ||
    (s.state === "observed" && s.scope === "superproject_only" && s.submodules === "ignored" &&
      typeof s.head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.head) && typeof s.dirty === "boolean" &&
      typeof s.status_digest === "string" && /^[0-9a-f]{64}$/.test(s.status_digest) && Number.isSafeInteger(s.observed_at) && s.observed_at >= 0)), "invalid receipt source observation");
  const o = value.outcome;
  assert(["completed", "needs_input", "failed", "cancelled"].includes(o.status) &&
    (o.reason === undefined || (typeof o.reason === "string" && o.reason.length <= 120)) &&
    (o.time_wrapped === undefined || o.time_wrapped === true) && o.status === outcome.status &&
    o.reason === outcome.reason && o.time_wrapped === outcome.time_wrapped, "receipt/outcome mismatch");
  return { version: 1, checks: [...value.checks], cwd: value.cwd, ...(value.tree !== undefined ? { tree: value.tree } : {}),
    source_state: s.state === "unknown" ? { state: s.state, reason: s.reason } : { state: s.state, scope: s.scope,
      submodules: s.submodules, head: s.head, dirty: s.dirty, status_digest: s.status_digest, observed_at: s.observed_at },
    outcome: { ...outcome } };
}
async function snapshot(file, budget) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assert(before.isFile(), "not a regular journal file");
    assert(before.size <= LIMITS.file_bytes && budget.bytes + before.size <= LIMITS.total_bytes, "journal byte limit exceeded");
    budget.bytes += before.size;
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    assert(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
      "journal changed during read");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    const entries = [], ids = new Set();
    for (let offset = 0, index = 0; offset < text.length; index++) {
      const newline = text.indexOf("\n", offset), end = newline === -1 ? text.length : newline;
      const line = text.slice(offset, end); offset = end + 1;
      assert(++budget.lines <= LIMITS.lines && Buffer.byteLength(line) <= LIMITS.line_bytes, "journal line limit exceeded");
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { fail(`invalid JSON at line ${index + 1}`); }
      assert(object(entry), `invalid entry at line ${index + 1}`);
      if (!entries.length) assert(entry.type === "session" && entry.version === 3 && id(entry.id), "invalid SDK session header");
      else {
        assert(typeof entry.type === "string" && entry.type !== "session" && entryId(entry.id) && !ids.has(entry.id) &&
          (entry.parentId === null || (entryId(entry.parentId) && ids.has(entry.parentId))), `invalid SDK entry at line ${index + 1}`);
        ids.add(entry.id);
      }
      entries.push(entry);
    }
    assert(entries.length > 0, "empty journal");
    return entries;
  } finally { await handle.close(); }
}

/** Aggregates only observed records from explicit inputs; not all accepted Runs. */
export async function analyzeJournals(files) {
  assert(Array.isArray(files) && files.length > 0 && files.length <= LIMITS.files && files.every(file => typeof file === "string" && !!file), "supply 1..64 journal files");
  const paths = [...new Set(files.map(file => resolve(file)))], budget = { bytes: 0, lines: 0 };
  const runs = new Map(), residues = new Map(), residueEntries = new Map(), residuePositions = new Map();
  let duplicateEnds = 0, residueRecords = 0;
  const get = value => {
    const key = keyOf(value);
    if (!runs.has(key)) runs.set(key, { identity: runOf(value), links: new Map() });
    return runs.get(key);
  };
  for (const file of paths) {
    try {
      const entries = await snapshot(file, budget), session = entries[0].id;
      for (const [position, entry] of entries.entries()) {
        if (entry.type !== "custom" || !Object.values(TYPES).includes(entry.customType)) continue;
        const data = entry.data;
        assert(object(data), "invalid harness data");
        if (entry.customType === TYPES.residue) {
          assert(id(data.owner_id) && data.owner_id === session && id(data.generation) && typeof data.closed === "boolean" &&
            Number.isSafeInteger(data.recorded_at) && data.recorded_at >= 0, "invalid residue checkpoint");
          const key = JSON.stringify([data.owner_id, data.generation]);
          const record = { owner_id: data.owner_id, generation: data.generation, closed: data.closed,
            recorded_at: data.recorded_at, usage: ledger(data.usage, true) };
          // SDK append order, not Date.now(), defines latest. Copies/prefix
          // snapshots must agree on the same entry's data and journal position.
          const entryKey = JSON.stringify([session, entry.id]), positionKey = JSON.stringify([session, position]);
          const fingerprint = canonical(entry), seen = residueEntries.get(entryKey), atPosition = residuePositions.get(positionKey);
          assert(!seen || (seen.position === position && seen.fingerprint === fingerprint), "conflicting residue entry identity");
          assert(atPosition === undefined || atPosition === entry.id, "conflicting residue journal order");
          residueEntries.set(entryKey, { position, fingerprint }); residuePositions.set(positionKey, entry.id);
          const prior = residues.get(key); residueRecords++;
          if (!prior || position > prior.position) residues.set(key, { position, record });
        } else if (entry.customType === TYPES.start) {
          assert(identity(data), "invalid run-start identity");
          const run = get(data), start = { session_id: session, start_entry_id: entry.id };
          assert(!run.start || canonical(run.start) === canonical(start), "conflicting run-start boundary");
          run.start = start;
        } else if (entry.customType === TYPES.link) {
          assert(ref(data.ref) && data.ref.owner_id === session && typeof data.session_file === "string" && isAbsolute(data.session_file), "invalid run-link");
          const run = get(data.ref), boundary = { session_id: data.ref.session_id, start_entry_id: data.ref.start_entry_id };
          run.links.set(canonical(boundary), boundary); // Never open data.session_file.
          assert(run.links.size === 1, "conflicting run-link boundary");
        } else {
          assert(ref(data.ref) && data.ref.session_id === session &&
            (data.ref.end_entry_id === undefined || data.ref.end_entry_id === entry.id) && entryId(data.through) && data.through !== entry.id &&
            (data.final_entry_id === null || entryId(data.final_entry_id)), "invalid run-end boundary");
          const result = data.result;
          assert(object(result) && result.scope === "owner_memory" && result.run_id === data.ref.run_id &&
            Number.isSafeInteger(result.chars) && result.chars >= 0 && Number.isSafeInteger(result.total_chars) && result.total_chars >= result.chars &&
            typeof result.truncated === "boolean" && typeof result.digest === "string" && /^[0-9a-f]{64}$/.test(result.digest), "invalid run-end result");
          const run = get(data.ref), outcome = outcomeOf(data.outcome);
          const rejectedReceipt = Object.hasOwn(data, "validation_receipt_error");
          assert(!rejectedReceipt || (data.validation_receipt_error === RECEIPT_ERROR && !Object.hasOwn(data, "validation_receipt")),
            "invalid validation receipt error marker");
          const end = { session_id: session, start_entry_id: data.ref.start_entry_id, end_entry_id: entry.id,
            through: data.through, final_entry_id: data.final_entry_id, result, outcome: data.outcome,
            ...(data.usage !== undefined ? { usage: ledger(data.usage) } : {}),
            ...(rejectedReceipt ? { validation_receipt_error: RECEIPT_ERROR } : {}),
            ...(Object.hasOwn(data, "validation_receipt") ? { validation_receipt: receiptOf(data.validation_receipt, outcome) } : {}) };
          if (run.end) { assert(canonical(run.end) === canonical(end), "conflicting run-end identity"); duplicateEnds++; }
          else run.end = end;
        }
      }
    } catch (error) { fail(`${file}: ${error.message}`); }
  }
  const statusReasons = new Map(), declarations = new Map(), gaps = [], receiptGaps = [];
  let usage, endCount = 0, missingUsage = 0, timeWrappedAttempts = 0;
  const groupUsage = (group, end) => {
    group.runs++; if (!end.usage) group.runs_without_usage++;
    if (end.outcome.time_wrapped) group.time_wrapped_attempts++;
    group.usage = merge(group.usage, end.usage);
  };
  for (const run of runs.values()) {
    const { start, end, links } = run, link = [...links.values()][0];
    const boundaries = [start, end, link].filter(Boolean);
    assert(boundaries.every(boundary => boundary.session_id === boundaries[0].session_id && boundary.start_entry_id === boundaries[0].start_entry_id), "run boundary mismatch");
    const missing = [];
    if (!start) missing.push("start_not_in_inputs");
    if (!end) missing.push("end_not_in_inputs");
    if (!link) missing.push("link_not_in_inputs");
    if (missing.length) gaps.push({ ...run.identity, missing });
    if (!end) continue;
    endCount++; usage = merge(usage, end.usage); if (!end.usage) missingUsage++;
    if (end.outcome.time_wrapped) timeWrappedAttempts++;
    if (end.validation_receipt_error) receiptGaps.push({ ...run.identity, error: RECEIPT_ERROR });
    const reason = end.outcome.reason ?? null, key = JSON.stringify([end.outcome.status, reason]);
    if (!statusReasons.has(key)) statusReasons.set(key, { status: end.outcome.status, reason, runs: 0, runs_without_usage: 0, time_wrapped_attempts: 0 });
    groupUsage(statusReasons.get(key), end);
    const receipt = end.validation_receipt;
    if (receipt) {
      const checks = [...receipt.checks].sort(), tree = receipt.tree ?? null;
      const key = JSON.stringify([checks, receipt.cwd, tree]);
      if (!declarations.has(key)) declarations.set(key, { planned_checks: checks, cwd: receipt.cwd, tree, runs: 0, runs_without_usage: 0, time_wrapped_attempts: 0 });
      groupUsage(declarations.get(key), end);
    }
  }
  return { files: paths, limits: LIMITS, observed_runs: runs.size, observed_run_ends: endCount,
    duplicate_run_ends: duplicateEnds, runs_without_usage: missingUsage, observed_run_end_usage: usage ?? null,
    time_wrapped_attempts: timeWrappedAttempts,
    validation_receipt_invalid_count: receiptGaps.length, validation_receipt_gaps: receiptGaps,
    status_reasons: [...statusReasons.values()],
    declared_check_attempts: [...declarations.values()].map(group => ({ ...group, repeated_declaration_attempts: Math.max(0, group.runs - 1) })),
    latest_unreported_usage: [...residues.values()].map(value => value.record), residue_records_observed: residueRecords,
    coverage_gaps: gaps,
    limits_of_inference: ["Only supplied journals and observed records; accepted Runs with no journal records are not counted.",
      "Usage is counted once per run-end identity, never from messages, links or residue snapshots.",
      "Latest residue uses journal append order per owner/generation, not timestamp order; it is non-additive and may overlap run-end usage.",
      "Empty residue model shares retain a zero observed floor and partial components; partial cost is unknown, not a zero price.",
      "Checks are parent declarations; repeated attempts do not prove executed, passed or redundant validation.",
      "Source observations are non-atomic superproject-only metadata, not validated content fingerprints.",
      "Time-wrapped counts are recorded warning attempts, not delivery, checkpoints or effective wrap-up rates.",
      "Receipt error markers identify rejected optional observations; raw invalid receipts still fail this strict batch.",
      "No structured stage or deny records: phase costs and denial counts are unavailable."] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), files = args.filter(arg => arg !== "--json");
  if (!files.length || files.some(arg => arg.startsWith("--"))) {
    console.error("Usage: node scripts/analyze-pi-harness-journal.mjs [--json] JOURNAL.jsonl [JOURNAL.jsonl ...] (explicit files only; JSON-only, --json is an alias; strict batch failure)");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await analyzeJournals(files), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
