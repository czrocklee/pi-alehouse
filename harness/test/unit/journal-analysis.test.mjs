import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile, truncate, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeJournals } from "../../../scripts/analyze-pi-harness-journal.mjs";

const types = { start: "harness:run-start:v1", end: "harness:run-end:v1", link: "harness:run-link:v1", residue: "harness:unreported-usage:v1" };
const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
const usage = cost => ({ total: { ...zero, cost: 999999 }, partial: ["input"], byModel: { "p/m": { ...zero, cost } } });
const header = id => ({ type: "session", version: 3, id });
const entry = (id, type, data) => ({ id, parentId: null, type: "custom", customType: types[type], data });
const identity = owner => ({ owner_id: owner, generation: randomUUID(), agent_id: randomUUID(), run_id: randomUUID() });
const outcome = reason => ({ status: reason ? "failed" : "completed", ...(reason ? { reason } : {}), limit_reached: false });
const receipt = (cwd, o, tree = "/build") => ({ version: 1, checks: ["focused:a", "focused:b"], cwd,
  ...(tree === undefined ? {} : { tree }), source_state: { state: "unknown", reason: "git_unavailable" },
  outcome: { status: o.status, ...(o.reason ? { reason: o.reason } : {}) } });
function run(owner, cwd, reason, cost, withReceipt = true, generation) {
  const who = identity(owner); if (generation) who.generation = generation;
  const session = randomUUID(), ref = { ...who, session_id: session, start_entry_id: "aaaaaaaa" }, o = outcome(reason);
  const end = entry("cccccccc", "end", { ref, through: "bbbbbbbb", final_entry_id: null,
    result: { scope: "owner_memory", run_id: who.run_id, digest: "a".repeat(64), chars: 0, total_chars: 0, truncated: false },
    outcome: o, usage: usage(cost), ...(withReceipt ? { validation_receipt: receipt(cwd, o) } : {}) });
  return { who, end, ref, child: [header(session), entry("aaaaaaaa", "start", who),
    { id: "bbbbbbbb", parentId: null, type: "message", message: { role: "assistant", usage: { cost: { total: 9999 } } } }, end],
    link: entry(randomUUID().replaceAll("-", "").slice(0, 8), "link", { ref, session_file: "/must-not-follow/not-present.jsonl" }) };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-journal-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = async (name, entries) => {
    const file = join(root, name); await writeFile(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); return file;
  };
  return { root, save, make: run };
}

test("offline journal counts ends once, legacy/no checks, failed/deadline and unknown reasons without invented stages", async t => {
  const { save, make } = await fixture(t), owner = randomUUID(), generation = randomUUID();
  const runs = [make(owner, "/workspace", undefined, 1, false, generation),
    make(owner, "/workspace", "deadline", 2, true, generation), make(owner, "/workspace", "dependency_input_missing", 3, true, generation),
    make(owner, "/other-workspace", "future_reason", 4, true, generation)];
  const parent = await save("parent.jsonl", [header(owner), ...runs.map(r => r.link)]);
  const children = await Promise.all(runs.map((r, i) => save(`${i}.jsonl`, r.child)));
  const copy = await save("copy.jsonl", runs[1].child);
  const result = await analyzeJournals([parent, ...children, copy, children[0]]);
  assert.equal(result.observed_run_ends, 4); assert.equal(result.duplicate_run_ends, 1);
  assert.equal(result.observed_run_end_usage.total.cost, 10, "ignore fabricated declared totals and duplicate copy");
  assert.deepEqual(result.observed_run_end_usage.partial, ["input"]);
  assert.deepEqual(result.status_reasons.map(g => [g.status, g.reason, g.runs]),
    [["completed", null, 1], ["failed", "deadline", 1], ["failed", "dependency_input_missing", 1], ["failed", "future_reason", 1]]);
  assert.equal(result.declared_check_attempts.length, 2, "different cwd is not grouped");
  assert.equal(result.declared_check_attempts[0].repeated_declaration_attempts, 1);
  assert.equal(result.declared_check_attempts[0].usage.total.cost, 5);
  assert.equal(result.coverage_gaps.length, 0);
  assert.equal(Object.hasOwn(result, "phase"), false);
  assert.match(result.limits_of_inference.join(" "), /do not prove executed, passed or redundant/);
});

test("deduped warning attempts include non-checks ends; receipt error gaps never prevent usage accounting", async t => {
  const { save, make } = await fixture(t), owner = randomUUID();
  const runs = [make(owner, "/cwd", undefined, 1, false), make(owner, "/cwd", "deadline", 2, false),
    make(owner, "/cwd", "finalization_failed", 3, false), make(owner, "/cwd", undefined, 4, true)];
  for (const r of runs.slice(0, 3)) r.end.data.outcome.time_wrapped = true;
  runs[2].end.data.validation_receipt_error = "invalid_validation_receipt";
  const files = await Promise.all(runs.map((r, i) => save(`${i}.jsonl`, r.child)));
  const duplicate = await save("duplicate.jsonl", runs[2].child);
  const result = await analyzeJournals([...files, duplicate]);
  assert.equal(result.time_wrapped_attempts, 3); assert.equal(result.observed_run_ends, 4);
  assert.equal(result.duplicate_run_ends, 1); assert.equal(result.observed_run_end_usage.total.cost, 10);
  assert.deepEqual(result.status_reasons.map(g => [g.reason, g.time_wrapped_attempts]),
    [[null, 1], ["deadline", 1], ["finalization_failed", 1]]);
  assert.equal(result.declared_check_attempts.length, 1); assert.equal(result.declared_check_attempts[0].time_wrapped_attempts, 0);
  assert.equal(result.validation_receipt_invalid_count, 1);
  assert.deepEqual(result.validation_receipt_gaps, [{ ...runs[2].who, error: "invalid_validation_receipt" }]);
  assert.match(result.limits_of_inference.join(" "), /warning attempts, not delivery/);
});

test("strict audit accepts only the fixed writer rejection marker, never raw receipts alongside a marker", async t => {
  const { save, make } = await fixture(t), owner = randomUUID();
  const r = make(owner, "/cwd", undefined, 1, false);
  for (const marker of ["unknown_error", null, false]) {
    r.end.data.validation_receipt_error = marker;
    await assert.rejects(analyzeJournals([await save("invalid-marker.jsonl", r.child)]), /receipt error marker/);
  }
  r.end.data.validation_receipt_error = "invalid_validation_receipt";
  for (const raw of [null, receipt("/cwd", r.end.data.outcome)]) {
    r.end.data.validation_receipt = raw;
    await assert.rejects(analyzeJournals([await save("both.jsonl", r.child)]), /receipt error marker/);
  }
});

test("CLI is JSON-only, --json is an alias, and strict failures emit no partial accounting", async t => {
  const { save, root } = await fixture(t), file = await save("empty-parent.jsonl", [header(randomUUID())]);
  const script = fileURLToPath(new URL("../../../scripts/analyze-pi-harness-journal.mjs", import.meta.url));
  const invoke = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10000 });
  const plain = invoke([file]), alias = invoke(["--json", file]);
  assert.equal(plain.status, 0); assert.equal(alias.status, 0); assert.equal(plain.stdout, alias.stdout);
  assert.equal(JSON.parse(plain.stdout).observed_run_ends, 0);
  const help = invoke([]); assert.equal(help.status, 2); assert.match(help.stderr, /JSON-only, --json is an alias/);
  const malformed = join(root, "malformed-cli.jsonl"); await writeFile(malformed, "{broken\n");
  const failed = invoke([file, malformed]); assert.equal(failed.status, 1); assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /invalid JSON/);
});

test("receipt grouping includes cwd and missing/different tree; checks ordering does not invent different declarations", async t => {
  const { save, make } = await fixture(t), owner = randomUUID();
  const runs = Array.from({ length: 4 }, () => make(owner, "/cwd", undefined, 1));
  runs[1].end.data.validation_receipt.checks.reverse();
  delete runs[2].end.data.validation_receipt.tree;
  runs[3].end.data.validation_receipt.tree = "/another-tree";
  const files = await Promise.all(runs.map((r, i) => save(`${i}.jsonl`, r.child)));
  const result = await analyzeJournals(files);
  assert.equal(result.declared_check_attempts.length, 3);
  assert.equal(result.declared_check_attempts[0].runs, 2);
  assert.equal(result.declared_check_attempts[1].tree, null);
  assert(result.coverage_gaps.every(gap => gap.missing.includes("link_not_in_inputs")));
});

test("latest residue stays separate for each owner/generation and is never summed with run-end spend", async t => {
  const { save, make } = await fixture(t), owner = randomUUID(), first = randomUUID(), second = randomUUID();
  const r = make(owner, "/cwd", "deadline", 10, true, first);
  const checkpoint = (id, generation, recorded_at, cost) => entry(id, "residue", { owner_id: owner, generation,
    closed: true, recorded_at, usage: usage(cost) });
  const parentRecords = [header(owner), r.link, checkpoint("11111111", first, 100, 2),
    checkpoint("22222222", first, 200, 3), checkpoint("33333333", first, 200, 3), checkpoint("44444444", second, 50, 4)];
  const parent = await save("parent.jsonl", parentRecords), copy = await save("parent-copy.jsonl", parentRecords);
  const child = await save("child.jsonl", r.child);
  const result = await analyzeJournals([parent, child, copy]);
  assert.equal(result.observed_run_end_usage.total.cost, 10);
  assert.equal(result.latest_unreported_usage.length, 2);
  assert.deepEqual(result.latest_unreported_usage.map(item => item.usage.total.cost), [3, 4]);
  assert.equal(result.latest_unreported_usage[0].recorded_at, 200);
  assert.equal(result.residue_records_observed, 8);
});

test("same-millisecond residue changes use append order, including when older copies are supplied later", async t => {
  const { save } = await fixture(t), owner = randomUUID(), generation = randomUUID();
  const checkpoints = [header(owner), entry("11111111", "residue", { owner_id: owner, generation,
    closed: false, recorded_at: 100, usage: usage(2) }), entry("22222222", "residue", {
    owner_id: owner, generation, closed: true, recorded_at: 100, usage: usage(3) })];
  const older = await save("older.jsonl", checkpoints.slice(0, 2)), newer = await save("newer.jsonl", checkpoints);
  const copy = await save("copy.jsonl", checkpoints);
  for (const files of [[older, newer, copy], [newer, copy, older]]) {
    const result = await analyzeJournals(files);
    assert.equal(result.latest_unreported_usage.length, 1);
    assert.equal(result.latest_unreported_usage[0].closed, true);
    assert.equal(result.latest_unreported_usage[0].recorded_at, 100);
    assert.equal(result.latest_unreported_usage[0].usage.total.cost, 3);
    assert.equal(result.observed_run_end_usage, null);
  }
});

test("legal finalization-failed empty residue preserves partial unknowns without inventing spend", async t => {
  const { save, make } = await fixture(t), owner = randomUUID(), generation = randomUUID();
  const r = make(owner, "/cwd", "finalization_failed", 1, true, generation);
  delete r.end.data.usage; // The run-end writer omits an empty normalized ledger.
  const partial = ["input", "output", "cache_read", "cache_write", "cost"];
  const parent = await save("parent.jsonl", [header(owner), r.link, entry("11111111", "residue", {
    owner_id: owner, generation, closed: true, recorded_at: 100,
    usage: { total: { ...zero, cost: 999 }, byModel: {}, partial } })]);
  const child = await save("child.jsonl", r.child), result = await analyzeJournals([parent, child]);
  const floor = result.latest_unreported_usage[0].usage;
  assert.equal(Object.keys(floor.byModel).length, 0);
  assert.deepEqual(floor.partial, partial); assert.deepEqual(floor.total, zero, "derive the floor, never trust declared cost");
  assert.equal(result.observed_run_end_usage, null); assert.equal(result.runs_without_usage, 1);
  assert.match(result.limits_of_inference.join(" "), /partial cost is unknown, not a zero price/);
  r.end.data.usage = { total: zero, byModel: {}, partial };
  await assert.rejects(analyzeJournals([await save("strict-end.jsonl", r.child)]), /invalid usage ledger/);
});

test("observed missing boundaries are coverage gaps, never imaginary accepted Run counts or link traversal", async t => {
  const { save, make } = await fixture(t), owner = randomUUID();
  const r = make(owner, "/cwd", "deadline", 1), other = make(owner, "/cwd", undefined, 1);
  const parent = await save("parent.jsonl", [header(owner), r.link, other.link]);
  const partial = await save("partial.jsonl", [r.child[0], r.child[1]]);
  const result = await analyzeJournals([parent, partial]);
  assert.equal(result.observed_runs, 2); assert.equal(result.observed_run_ends, 0);
  assert.equal(result.observed_run_end_usage, null);
  assert.deepEqual(result.coverage_gaps.map(g => g.missing), [["end_not_in_inputs"], ["start_not_in_inputs", "end_not_in_inputs"]]);
  assert.match(result.limits_of_inference[0], /no journal records are not counted/);
});

test("invalid receipt, conflicting duplicate identity/residue and malformed JSON fail instead of dropping records", async t => {
  const { save, make, root } = await fixture(t), owner = randomUUID();
  for (const mutate of [r => { r.end.data.validation_receipt.checks = []; },
    r => { r.end.data.validation_receipt.outcome.status = "completed"; },
    r => { r.end.data.validation_receipt.outcome.time_wrapped = true; },
    r => { r.end.data.validation_receipt.source_state = { state: "observed", scope: "all" }; },
    r => { r.end.data.validation_receipt = null; }]) {
    const r = make(owner, "/cwd", "deadline", 1); mutate(r);
    const file = await save("invalid.jsonl", r.child);
    await assert.rejects(analyzeJournals([file]), /receipt/);
  }
  const r = make(owner, "/cwd", "deadline", 1), original = await save("original.jsonl", r.child);
  r.end.data.usage = usage(2);
  const conflicting = await save("conflicting.jsonl", r.child);
  await assert.rejects(analyzeJournals([original, conflicting]), /conflicting run-end/);
  const checkpoints = [header(owner), entry("00000000", "residue", {
    owner_id: owner, generation: r.who.generation, closed: true, recorded_at: 100, usage: usage(1) })];
  const residueOriginal = await save("residue-original.jsonl", checkpoints);
  checkpoints[1].data.usage = usage(2);
  const residueChanged = await save("residue-changed.jsonl", checkpoints);
  await assert.rejects(analyzeJournals([residueOriginal, residueChanged]), /conflicting residue entry identity/);
  checkpoints[1].id = "00000001";
  const residueReplaced = await save("residue-replaced.jsonl", checkpoints);
  await assert.rejects(analyzeJournals([residueOriginal, residueReplaced]), /conflicting residue journal order/);
  const malformed = join(root, "malformed.jsonl");
  await writeFile(malformed, JSON.stringify(header(owner)) + "\n{\"torn\":\n");
  await assert.rejects(analyzeJournals([malformed]), /invalid JSON at line 2/);
});

test("dedup uses the full owner/generation/agent/run identity and missing usage is an observation gap", async t => {
  const { save, make } = await fixture(t), owner = randomUUID();
  const first = make(owner, "/cwd", undefined, 1), second = make(owner, "/cwd", undefined, 2);
  second.who.run_id = first.who.run_id;
  second.ref.run_id = first.who.run_id;
  second.end.data.result.run_id = first.who.run_id;
  delete second.end.data.usage;
  const files = await Promise.all([first, second].map((r, i) => save(`${i}.jsonl`, r.child)));
  const result = await analyzeJournals(files);
  assert.equal(result.observed_run_ends, 2); assert.equal(result.duplicate_run_ends, 0);
  assert.equal(result.runs_without_usage, 1); assert.equal(result.status_reasons[0].runs_without_usage, 1);
  assert.equal(result.observed_run_end_usage.total.cost, 1, "assistant-message usage cannot fill a missing end ledger");
});

test("bounded explicit inputs reject directories, leaf symlinks and oversized/invalid-UTF8 journals", async t => {
  const { root, save } = await fixture(t), file = await save("one.jsonl", [header(randomUUID())]);
  await assert.rejects(analyzeJournals([root]), /regular journal|EISDIR/);
  const link = join(root, "symlink.jsonl"); await symlink(file, link);
  await assert.rejects(analyzeJournals([link]), /ELOOP/);
  await assert.rejects(analyzeJournals(Array(65).fill(file)), /1\.\.64/);
  await truncate(file, 8 * 1024 * 1024 + 1);
  await assert.rejects(analyzeJournals([file]), /byte limit/);
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(analyzeJournals([file]), /encoded data|UTF/);
});
