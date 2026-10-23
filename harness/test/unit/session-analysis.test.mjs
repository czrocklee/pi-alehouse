import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, truncate, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeSessions, LIMITS, parseArgs } from "../../../scripts/analyze-pi-session.mjs";

// Entirely synthetic fixtures. Never read a developer/host session directory.
const timestamp = "2026-01-02T00:00:00.000Z";
const header = (id = "parent") => ({ type: "session", version: 3, id, timestamp });
const entry = (id, type, extra = {}, time = timestamp) => ({ id, type, timestamp: time, ...extra });
const message = (id, body, time) => entry(id, "message", { message: body }, time);
const user = id => message(id, { role: "user", content: "PRIVATE_SYNTHETIC_PROMPT" });
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (id, calls = [], extra = {}, time) => message(id, { role: "assistant", content: calls, ...extra }, time);
const result = (id, callId, name, reply, extra = {}, time) => message(id, { role: "toolResult", toolCallId: callId,
  toolName: name, content: [{ type: "text", text: JSON.stringify(reply) }], ...extra }, time);
const usage = cost => ({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: cost } });
const custom = (id, customType, data) => entry(id, "custom", { customType, data });
const script = fileURLToPath(new URL("../../../scripts/analyze-pi-session.mjs", import.meta.url));
const invoke = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 20_000 });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "session-analysis-synthetic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = async (name, entries) => {
    const file = join(root, name);
    await writeFile(file, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
    return file;
  };
  return { root, save };
}

test("validation context: source-only synthetic tests, no SDK/build/network", t => {
  t.diagnostic(`platform=${process.platform}/${process.arch}; node=${process.version}; two-pass explicit-file IO; limits=${JSON.stringify(LIMITS)}`);
});

test("direct and symlink CLI entry points produce identical output and exit codes", async t => {
  const { root, save } = await fixture(t);
  const alias = join(root, "analyzer link.mjs");
  await symlink(script, alias);
  const file = await save("cli.jsonl", [header(), user("u")]);
  const malformed = join(root, "malformed.jsonl");
  await writeFile(malformed, "PRIVATE_SYNTHETIC_INVALID_JSON\n");
  for (const [args, status] of [[["--json", file], 0], [[file], 0], [["--json", malformed], 1], [[], 2]]) {
    const direct = invoke(args);
    assert.equal(direct.status, status, direct.stderr);
    if (status === 0) assert.notEqual(direct.stdout, "");
    else assert.notEqual(direct.stderr, "");
    for (const flags of [[], ["--preserve-symlinks-main"]]) {
      const linked = spawnSync(process.execPath, [...flags, alias, ...args], { encoding: "utf8", timeout: 20_000 });
      assert.equal(linked.error, undefined);
      assert.equal(linked.status, direct.status, linked.stderr);
      assert.equal(linked.stdout, direct.stdout, "symlink must actually run the CLI");
      assert.equal(linked.stderr, direct.stderr);
    }
  }
});

test("direct and symlink imports expose the library without CLI output, input reads or exit-code changes", async t => {
  const { root, save } = await fixture(t);
  const alias = join(root, "import link.mjs");
  await symlink(script, alias);
  const file = await save("import.jsonl", [header(), user("u")]);
  for (const url of [pathToFileURL(script).href, pathToFileURL(alias).href]) {
    for (const argv1 of [file, join(root, "missing-importer.mjs"), undefined]) {
      const code = `
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      let reads = 0;
      fs.open = async () => { reads++; throw new Error("unexpected input read"); };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(argv1) ?? "undefined"}, "--json", ${JSON.stringify(file)}];
      const exitCode = process.exitCode;
      const library = await import(${JSON.stringify(url)});
      assert.equal(typeof library.analyzeSessions, "function");
      assert.equal(typeof library.parseArgs, "function");
      assert.equal(reads, 0);
      assert.equal(process.exitCode, exitCode);
    `;
      const imported = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 20_000 });
      assert.equal(imported.error, undefined);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout, "");
      assert.equal(imported.stderr, "");
    }
  }
});

test("all nine management tools, answer-only turns, modern delivery and separated legacy answered", async t => {
  const { save } = await fixture(t);
  const names = ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
  const records = [header(), ...names.flatMap((name, index) => [assistant(`a${index}`, [call(`c${index}`, name)]),
    result(`r${index}`, `c${index}`, name, name === "agent_send" ? { action: { delivery: "steered" } } : { reason: "snapshot" })])];
  for (const [index, reply] of [
    { action: { delivery: "joined" }, delivery: "answered" },
    { action: { delivery: "not_delivered" } },
    { delivery: "answered" },
    { action: { delivery: "answered" }, delivery: "answered" },
    { action: {}, delivery: "answered" },
  ].entries()) records.push(assistant(`s${index}`, [call(`send${index}`, "agent_send", { wait_ms: 1 })]),
    result(`sr${index}`, `send${index}`, "agent_send", reply));
  const file = await save("all.jsonl", records), report = await analyzeSessions([file]);
  assert.equal(report.management_only_turns, 14);
  assert.equal(report.management_only_turns_by_session_kind.unknown, 14);
  assert.equal(report.tools.agent_answer, 1); assert.equal(report.harness.answer.ok, 1);
  assert.deepEqual(report.harness.send.modern, { steered: 1, joined: 1, not_delivered: 1, unknown: 2 });
  assert.equal(report.harness.send.legacy.answered, 1);
  assert.equal(report.harness.send.invalid_modern_delivery, 1);
  assert.equal(Object.hasOwn(report.harness.send, "answered"), false, "never manufacture modern answered");
  assert.equal(report.harness.send.with_wait_ms, 5);
  for (const name of names) assert(report.tools[name] > 0);
  const cli = invoke(["--json", file]); assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).file, file, "preserve familiar one-file JSON entry point");
  const plain = invoke([file]); assert.equal(plain.status, 0); assert.match(plain.stdout, /NON-ADDITIVE/);
});

test("compact text summarizes observations without detailed dictionaries; JSON retains every scope and counter", async t => {
  const { save } = await fixture(t);
  const file = await save("compact.jsonl", [header(), user("u"), user("u"),
    assistant("a", [call("w", "agent_wait", { wait_ms: 0 }), call("e", "agent_wait", { wait_ms: 1 })], { usage: usage(0) }),
    result("r", "w", "agent_wait", { reason: "timeout", secret: "PRIVATE_SYNTHETIC_RESULT" }, { usage: usage(0) }),
    result("error", "e", "agent_wait", { error: { code: "SYNTHETIC_ERROR" } }, { isError: true }),
    assistant("missing"),
  ]);
  const report = await analyzeSessions([file]);
  const plain = invoke([file]); assert.equal(plain.status, 0, plain.stderr);
  for (const pattern of [
    /sessions\s+1 .*unknown.*1/, /entries\s+5 selected; 1 duplicates excluded/,
    /user records\s+1 \(not verified human requests\)/,
    /raw usage\s+2 records; observed cost 0; partial components: input, output, cacheRead, cacheWrite, cost/,
    /tool usage attached 0 \(NON-ADDITIVE; not necessarily child Agents\)/,
    /tool turns\s+1; non-child management-only 1/,
    /management results spawn 0; run 0; answer 0 \(non-error\)/,
    /wait results\s+2 including errors; 1 non-error; explicit <=1s 2; short timeouts 1/,
    /tools\s+\{"agent_wait":2\}/,
    /argument matching\s+matched 2; missing 0; ambiguous 0; name mismatch 0/,
    /error observations assistant stops 0; management results 1; unparsed replies 0/,
    /observed usage is not complete billing; missing\/partial components are unknown, not zero/,
    /--json for full scopes\/counters/, /not task quality or success/, /separate from timeout\/question/,
    /session\+entry dedup only; fork\/clone histories may repeat provider operations/, /Explicit files\/window only/,
  ]) assert.match(plain.stdout, pattern);
  assert.doesNotMatch(plain.stdout, /PRIVATE_SYNTHETIC|compact\.jsonl|session-analysis-synthetic-|"missing":|"invalid":|declared_partial|scope:|harness\s+\{/);
  assert(plain.stdout.trim().split("\n").length <= 18, "human report stays scanable");
  for (const scope of report.limits_of_inference) assert(!plain.stdout.includes(scope), "no full qualifier dump");
  const cli = invoke(["--json", file]); assert.equal(cli.status, 0, cli.stderr);
  const detailed = JSON.parse(cli.stdout);
  assert.deepEqual(detailed, report, "JSON is the full unchanged analysis, not the compact projection");
  assert.equal(detailed.raw_usage.total.missing.cost, 1);
  assert.equal(detailed.raw_usage.total.invalid.cost, 0);
  assert.equal(detailed.raw_usage.total.declared_partial.cost, 0);
  assert.equal(detailed.harness.wait.short_timeout_le_1s, detailed.harness.wait.short_timeout);
  assert(detailed.limits_of_inference.some(scope => scope.includes("no cross-session billing deduplication")));
  assert(detailed.limits_of_inference.some(scope => scope.includes("not fsync or atomic snapshot proof")));
  const unknown = await save("unknown.jsonl", [header("unknown"), assistant("a")]);
  const unknownText = invoke([unknown]); assert.equal(unknownText.status, 0, unknownText.stderr);
  assert.match(unknownText.stdout, /raw usage\s+1 records; observed cost unknown/);
  assert.match(unknownText.stdout, /tool usage attached unknown \(NON-ADDITIVE/);
});

test("inclusive persisted-time window retains cross-window arguments and separates timeout, question and error observations", async t => {
  const { save } = await fixture(t);
  const before = "2026-01-01T23:59:59.999Z", until = "2026-01-02T00:00:01.000Z", after = "2026-01-02T00:00:01.001Z";
  const records = [header(),
    assistant("outside-spawn", [call("spawn", "agent_spawn", { wait_ms: 5, after: ["one", "two"] })], {}, before),
    result("at-since", "spawn", "agent_spawn", { action: { type: "agent_spawn" } }),
    assistant("outside-wait", [call("wait", "agent_wait", { wait_ms: 1000 })], {}, before),
    result("at-until", "wait", "agent_wait", { reason: "timeout" }, { timestamp: 0 }, until),
    assistant("inside", [call("long", "agent_wait", { wait_ms: 1001 }), call("question", "agent_wait", { wait_ms: 0 }),
      call("error", "agent_wait", { wait_ms: 0 }), call("zero", "agent_wait", { wait_ms: 0 }), call("default", "agent_wait")],
    { timestamp: 0, usage: usage(1) }),
    result("long-result", "long", "agent_wait", { reason: "timeout" }),
    result("question-result", "question", "agent_wait", { reason: "needs_input" }),
    result("error-result", "error", "agent_wait", { error: { code: "SYNTHETIC_API_ERROR" }, reason: "timeout" }, { isError: true }),
    result("zero-result", "zero", "agent_wait", { reason: "timeout" }),
    result("default-result", "default", "agent_wait", { reason: "timeout" }),
    result("excluded", "wait", "agent_wait", { reason: "timeout" }, {}, after),
    assistant("assistant-api-error", [], { stopReason: "error" }),
  ];
  const file = await save("window.jsonl", records);
  const report = await analyzeSessions([file], { since: "2026-01-02T01:00:00+01:00", until });
  assert.equal(report.inputs.outside_window_entries, 3);
  assert.equal(report.inputs.selected_entries, records.length - 4);
  assert.equal(report.parent.calls, 2); assert.equal(report.parent.cost, 1);
  assert.equal(report.harness.spawn.with_wait_ms, 1); assert.equal(report.harness.spawn.after_agents, 2);
  assert.equal(report.harness.wait.calls, 5); assert.equal(report.harness.wait.calls_including_errors, 6);
  assert.equal(report.harness.wait.short_wait_le_1s, 4);
  assert.equal(report.harness.wait.short_timeout, 2); assert.equal(report.harness.wait.short_timeout_le_1s, 2);
  assert.deepEqual(report.harness.wait.reasons, { timeout: 4, needs_input: 1 });
  assert.equal(report.harness.errors["agent_wait:SYNTHETIC_API_ERROR"], 1);
  assert.deepEqual(report.errors, { assistant_error_stops: 1, management_tool_results: 1 });
  const cli = invoke(["--since", timestamp, "--until", until, "--json", file]);
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).inputs.selected_entries, report.inputs.selected_entries);
  const zero = await analyzeSessions([file], { since: after, until: after });
  assert.equal(zero.inputs.selected_entries, 1); assert.equal(zero.harness.wait.short_timeout, 1);
});

test("CLI rejects unknown/duplicate flags, missing files and invalid/reversed bounds without echoing input", () => {
  const invalid = [[], ["--unknown-SYNTHETIC_SECRET"], ["--json", "--json", "x"], ["--since", timestamp, "--since", timestamp, "x"],
    ["--until", timestamp, "--until", timestamp, "x"], ["--since"], ["--since", "--json", "x"], ["--since", "2026-01-02T00:00:00", "x"],
    ["--until", "2026-02-30T00:00:00Z", "x"], ["--since", "2026-01-02T24:00:00Z", "x"], ["--until", "2026-01-02T00:00:00+24:00", "x"],
    ["--since", "2026-01-02T00:00:00.0001Z", "x"], ["--since", "2026-01-02T00:00:00Z", "--until", "2026-01-01T00:00:00Z", "x"],
    Array.from({ length: LIMITS.files + 1 }, () => "x"), ["--json=true", "x"], ["-j", "x"]];
  for (const args of invalid) {
    assert.throws(() => parseArgs(args));
    const cli = invoke(args); assert.equal(cli.status, 2, JSON.stringify(args)); assert.equal(cli.stdout, "");
    assert.doesNotMatch(cli.stderr, /SYNTHETIC_SECRET/);
  }
  assert.equal(parseArgs(["--since", "2024-02-29T00:00:00Z", "x"]).files[0], "x");
});

test("malformed, non-object, empty, missing/invalid identity and timestamps fail with file/line-only diagnostics", async t => {
  const { root } = await fixture(t);
  const badRecords = ["", "PRIVATE_SYNTHETIC_SECRET\n", "null\n", "[]\n", "0\n", '"PRIVATE_SYNTHETIC_SECRET"\n',
    JSON.stringify({ type: "session", timestamp }) + "\n",
    ...["", null, 12, "PRIVATE SYNTHETIC SECRET"].map(id => JSON.stringify({ ...header(), id }) + "\n"),
    JSON.stringify({ ...header(), timestamp: undefined }) + "\n",
    JSON.stringify({ ...header(), timestamp: "2026-02-30T00:00:00Z" }) + "\n",
    JSON.stringify(assistant("entry", [])) + "\n",
    JSON.stringify(header()) + "\n\n",
    JSON.stringify(header()) + "\n[]\n",
    "\uFEFF" + JSON.stringify(header()) + "\n",
    JSON.stringify(header()) + "\n" + JSON.stringify({ type: "message", timestamp, message: { role: "assistant" } }) + "\n",
    JSON.stringify(header()) + "\n" + JSON.stringify({ ...user("u"), timestamp: "2026-01-02T00:00:00" }) + "\n",
    JSON.stringify(header()) + "\n" + JSON.stringify(entry("u", "message", { message: null })) + "\n",
    JSON.stringify(header()) + "\n" + JSON.stringify(assistant("a", [call("", "agent_wait")])) + "\n",
  ];
  for (const [index, text] of badRecords.entries()) {
    const file = join(root, `bad-${index}.jsonl`); await writeFile(file, text);
    await assert.rejects(analyzeSessions([file]), error => {
      assert.match(error.message, /^".*bad-\d+\.jsonl":\d+: [a-zA-Z0-9 -]+$/);
      assert.doesNotMatch(error.message, /PRIVATE|SYNTHETIC_SECRET/); return true;
    });
    const cli = invoke(["--json", file]); assert.equal(cli.status, 1); assert.equal(cli.stdout, "");
    assert.doesNotMatch(cli.stderr, /PRIVATE|SYNTHETIC_SECRET|SyntaxError| at /);
  }
  const invalidUtf8 = join(root, "invalid-utf8.jsonl");
  await writeFile(invalidUtf8, Buffer.concat([Buffer.from(JSON.stringify(header()) + '\n{"PRIVATE_SYNTHETIC_SECRET":"'),
    Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));
  const failedUtf8 = invoke(["--json", invalidUtf8]);
  assert.equal(failedUtf8.status, 1); assert.equal(failedUtf8.stdout, "");
  assert.equal(failedUtf8.stderr, `${JSON.stringify(invalidUtf8)}:2: invalid JSON or UTF-8\n`);
  for (const file of [root, join(root, "missing.jsonl")]) {
    const cli = invoke(["--json", file]); assert.equal(cli.status, 1); assert.equal(cli.stdout, "");
    assert.match(cli.stderr, /:1: (input is not a regular file|cannot open input)/);
  }
});

test("reused fatal decoder preserves per-line UTF-8 and BOM validation across chunks", async t => {
  const { root, save } = await fixture(t);
  const records = [header(), message("unicode", { role: "user", content: "€😀".repeat(20_000) }), user("last")];
  const file = await save("unicode.jsonl", records);
  // Exercise a final line without LF as well as multibyte sequences across chunks.
  await writeFile(file, records.map(value => JSON.stringify(value)).join("\n"));
  assert.equal((await analyzeSessions([file])).user_messages, 2);
  for (const [name, invalid] of [
    ["later-bom", Buffer.from("\uFEFF" + JSON.stringify(user("bad")))],
    ["truncated-utf8", Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe2, 0x82])])],
  ]) {
    const bad = join(root, `${name}.jsonl`);
    await writeFile(bad, Buffer.concat([Buffer.from(JSON.stringify(header()) + "\n" + JSON.stringify(user("valid")) + "\n"), invalid]));
    await assert.rejects(analyzeSessions([bad]), /:3: invalid JSON or UTF-8$/);
    // A failed decode must not leak state into subsequent analyses.
    assert.equal((await analyzeSessions([file])).user_messages, 2);
  }
});

test("same-file arguments, same-file entries and overlapping snapshots deduplicate by session+entry", async t => {
  const { save } = await fixture(t);
  const a = assistant("a", [call("c", "agent_run")], { usage: usage(1) });
  const r = result("r", "c", "agent_run", {});
  const first = await save("first.jsonl", [header(), a, a]);
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const snapshot = await save("snapshot.jsonl", [header(), reordered, r]);
  for (const files of [[first, first, snapshot], [snapshot, first, first]]) {
    const report = await analyzeSessions(files);
    assert.equal(report.inputs.duplicate_file_arguments, 1); assert.equal(report.inputs.duplicate_entries, 2);
    assert.equal(report.inputs.duplicate_headers, 1); assert.equal(report.inputs.unique_entries, 2);
    assert.equal(report.parent.calls, 1); assert.equal(report.parent.cost, 1); assert.equal(report.tools.agent_run, 1);
    assert.equal(report.harness.run.ok, 1); assert.equal(report.argument_correlation.matched, 1);
  }
  const conflict = await save("conflict.jsonl", [header(), { ...a, message: { ...a.message, usage: usage(2) } }]);
  await assert.rejects(analyzeSessions([first, conflict]), /conflicting entry identity/);
  const inFileConflict = await save("in-file-conflict.jsonl", [header(), a, { ...a, timestamp: "2026-01-02T00:00:01Z" }]);
  await assert.rejects(analyzeSessions([inFileConflict]), /conflicting entry identity/);
  const headerConflict = await save("header-conflict.jsonl", [{ ...header(), timestamp: "2026-01-02T00:00:01Z" }]);
  await assert.rejects(analyzeSessions([first, headerConflict]), /conflicting session identity/);
  const cli = invoke(["--json", first, conflict]); assert.equal(cli.status, 1); assert.equal(cli.stdout, "");
});

test("tool-call IDs are session-scoped; distinct entries with reused IDs stay counted and arguments become unknown", async t => {
  const { save } = await fixture(t);
  const first = await save("one.jsonl", [header("one"), assistant("a", [call("call_a|fc_a", "agent_wait", { wait_ms: 1000 })], { usage: usage(1) }),
    result("r", "call_a|fc_a", "agent_wait", { reason: "timeout" })]);
  const second = await save("two.jsonl", [header("two"), assistant("a", [call("call_a|fc_a", "agent_wait", { wait_ms: 2000 })], { usage: usage(2) }),
    result("r", "call_a|fc_a", "agent_wait", { reason: "timeout" })]);
  const scoped = await analyzeSessions([first, second]);
  assert.equal(scoped.tools.agent_wait, 2); assert.equal(scoped.harness.wait.short_timeout, 1);
  assert.equal(scoped.argument_correlation.matched, 2); assert.equal(scoped.raw_usage.total.cost, 3, "no cross-session provider-operation dedup");
  const ambiguous = await save("ambiguous.jsonl", [header("three"),
    assistant("a", [call("call_a|fc_a", "agent_wait", { wait_ms: 1 })], { usage: usage(1) }),
    result("r", "call_a|fc_a", "agent_wait", { reason: "timeout" }),
    assistant("b", [call("call_a|fc_a", "agent_wait", { wait_ms: 1 })], { usage: usage(1) }),
    result("s", "call_a|fc_a", "agent_wait", { reason: "timeout" }),
    result("missing", "absent", "agent_wait", { reason: "timeout" }),
    result("mismatch", "call_a|fc_a", "agent_spawn", {}),
  ]);
  const report = await analyzeSessions([ambiguous]);
  assert.equal(report.tools.agent_wait, 2); assert.equal(report.parent.cost, 2);
  assert.equal(report.harness.wait.calls, 3); assert.equal(report.harness.wait.args_unknown, 3);
  assert.equal(report.harness.wait.short_timeout, 0); assert.equal(report.harness.wait.short_wait_le_1s, 0);
  assert.equal(report.argument_correlation.ambiguous, 3); assert.equal(report.argument_correlation.missing, 1);
  assert.equal(report.harness.spawn.args_unknown, 1);
  const mismatch = await save("mismatch.jsonl", [header("four"), assistant("a", [call("c", "agent_run", { wait_ms: 1 })]),
    result("r", "c", "agent_spawn", {})]);
  assert.equal((await analyzeSessions([mismatch])).argument_correlation.name_mismatch, 1);
});

test("literal exponent overflow cannot fingerprint as null in a conflicting snapshot", async t => {
  const { save } = await fixture(t);
  const nullEntry = assistant("a", [], { usage: { cost: null } });
  const nullFile = await save("null.jsonl", [header("overflow"), nullEntry]);
  const overflowFile = await save("overflow.jsonl", [header("overflow"), nullEntry]);
  await writeFile(overflowFile, JSON.stringify(header("overflow")) + "\n" + JSON.stringify(nullEntry).replace('"cost":null', '"cost":1e999') + "\n");
  assert.equal((await analyzeSessions([overflowFile])).raw_usage.assistant.invalid.cost, 1);
  for (const files of [[nullFile, overflowFile], [overflowFile, nullFile]]) {
    await assert.rejects(analyzeSessions(files), /:2: conflicting entry identity/);
  }
});

test("opaque provider IDs including pipes correlate with missing tool names; absent IDs stay missing and mismatches are explicit", async t => {
  const { save } = await fixture(t);
  const file = await save("opaque.jsonl", [header(),
    assistant("a", [call("call_a|fc_a", "agent_wait", { wait_ms: 1 })]),
    result("r", "call_a|fc_a", undefined, { reason: "timeout" }),
    result("missing", undefined, "agent_wait", { reason: "timeout" }),
    result("mismatch", "call_a|fc_a", "agent_spawn", {}),
  ]);
  const report = await analyzeSessions([file]);
  assert.equal(report.harness.wait.short_wait_le_1s, 1); assert.equal(report.harness.wait.args_unknown, 1);
  assert.deepEqual(report.argument_correlation, { matched: 1, missing: 1, ambiguous: 0, name_mismatch: 1 });
});

test("raw assistant/compaction/usage/branch_summary accounting excludes attached tool usage and harness projections", async t => {
  const { save } = await fixture(t);
  const parentRecords = [header(), user("root-user"),
    assistant("a", [call("c", "agent_send", { message: "PRIVATE_SYNTHETIC_ARGUMENT" })], { provider: "p", model: "m", usage: usage(1) }),
    entry("compact", "compaction", { details: { usage: usage(2), provider: "p", model: "summary" }, summary: "PRIVATE_SYNTHETIC_RESULT" }),
    entry("usage", "usage", { usage: usage(3), provider: "p", model: "m" }),
    entry("branch", "branch_summary", { usage: usage(4), details: { usage: usage(900) }, summary: "PRIVATE_SYNTHETIC_RESULT" }),
    result("r", "c", "agent_send", { action: { delivery: "steered" }, result: "PRIVATE_SYNTHETIC_RESULT" }, { usage: usage(300) }),
    custom("link", "harness:run-link:v1", { ref: { owner_id: "parent", session_id: "child" }, session_file: "/must-not-read/missing.jsonl" }),
    custom("residue", "harness:unreported-usage:v1", { owner_id: "parent", usage: { total: { cost: 500 } } }),
  ];
  const childRecords = [{ ...header("child"), parentSession: "/must-not-read/parent.jsonl" }, user("child-task"),
    custom("start", "harness:run-start:v1", { owner_id: "parent" }),
    assistant("a", [], { provider: "q", model: "n", usage: usage(5) }),
    custom("end", "harness:run-end:v1", { ref: { owner_id: "parent" }, usage: { total: { cost: 400 } }, outcome: { status: "completed" } })];
  const parent = await save("parent.jsonl", parentRecords), child = await save("child.jsonl", childRecords);
  const unknown = await save("fork.jsonl", [{ ...header("fork"), parentSession: parent }, user("unknown-user")]);
  const report = await analyzeSessions([child, parent, unknown]);
  assert.equal(report.raw_usage.total.cost, 15); assert.equal(report.parent.cost, 1);
  assert.equal(report.raw_usage.assistant.cost, 6); assert.equal(report.raw_usage.compaction.cost, 2);
  assert.equal(report.raw_usage.usage.cost, 3); assert.equal(report.raw_usage.branch_summary.cost, 4);
  assert.equal(report.child_cost_attached, 300); assert.equal(report.non_additive.tool_result_attached.cost, 300);
  assert.equal(report.non_additive.additive, false); assert.equal(report.non_additive.harness_run_end_records, 1);
  assert.equal(report.non_additive.harness_unreported_usage_records, 1);
  assert.deepEqual(report.session_classification, { parent: 1, child: 1, unknown: 1, conflicting: 0 });
  assert.equal(report.user_messages, 3); assert.deepEqual(report.user_messages_by_session_kind, { parent: 1, child: 1, unknown: 1 });
  assert.equal(report.human_requests, null); assert.equal(report.human_request_candidates, 1);
  assert.equal(report.management_only_turns_by_session_kind.parent, 1);
  assert.deepEqual(report.raw_usage.by_model.filter(group => group.source === "assistant").map(group => [group.provider, group.model, group.usage.cost]),
    [["p", "m", 1], ["q", "n", 5]]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SYNTHETIC|must-not-read/);
  assert.equal((await analyzeSessions([child])).parent.calls, 0, "child owner identity alone excludes child task turns");
  const parentOnly = await analyzeSessions([parent]);
  assert.equal(parentOnly.raw_usage.total.cost, 10); assert.equal(parentOnly.child_cost_attached, 300, "attached cost is never silently added");
});

test("missing usage is unknown, observed zero remains zero, invalid/partial metrics expose gaps", async t => {
  const { save } = await fixture(t);
  const file = await save("gaps.jsonl", [header(), assistant("missing"),
    assistant("zero", [], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
    assistant("invalid", [], { usage: { input: -1, output: "invalid", cacheRead: 0, cacheWrite: 0, cost: { total: -1 }, partial: ["cost"] } }),
    entry("compaction", "compaction", { summary: "not printed" }),
  ]);
  const report = await analyzeSessions([file]);
  assert.equal(report.parent.calls, 3); assert.equal(report.parent.cost, 0); assert.equal(report.parent.missing.cost, 1);
  assert.equal(report.parent.invalid.cost, 1); assert.equal(report.parent.declared_partial.cost, 1);
  assert(report.parent.partial.includes("cost")); assert.equal(report.parent.cache_hit_rate, null);
  assert.equal(report.raw_usage.compaction.cost, null); assert.equal(report.raw_usage.compaction.missing.cost, 1);
  assert.equal(report.child_cost_attached, null);
  const noUsage = await save("none.jsonl", [header("none"), assistant("a")]);
  assert.equal((await analyzeSessions([noUsage])).parent.cost, null);
  const zeroUsage = await save("zero.jsonl", [header("zero"), assistant("a", [], { usage: usage(0) })]);
  const zero = await analyzeSessions([zeroUsage]); assert.equal(zero.parent.cost, 0); assert.deepEqual(zero.parent.partial, []);
  assert.equal(zero.parent.cache_hit_rate, 3 / 17);
  const huge = await save("huge.jsonl", [header("huge"), assistant("a", [], { usage: {
    input: Number.MAX_VALUE, output: 0, cacheRead: Number.MAX_VALUE, cacheWrite: 0, cost: { total: 0 },
  } })]);
  assert.equal((await analyzeSessions([huge])).parent.cache_hit_rate, null, "finite fields can overflow the prompt denominator");
  const costOverflow = await save("cost-overflow.jsonl", [header("cost-overflow"),
    assistant("a", [], { usage: usage(Number.MAX_VALUE) }), assistant("b", [], { usage: usage(Number.MAX_VALUE) })]);
  const overflow = await analyzeSessions([costOverflow]);
  for (const aggregate of [overflow.parent, overflow.raw_usage.assistant, overflow.raw_usage.total, overflow.raw_usage.by_model[0].usage]) {
    assert.equal(aggregate.cost, Number.MAX_VALUE); assert.equal(aggregate.invalid.cost, 1);
    assert.equal(aggregate.missing.cost, 0); assert.deepEqual(aggregate.partial, ["cost"]);
  }
  assert.doesNotMatch(JSON.stringify(overflow), /Infinity|NaN/);
});

test("assistant attribution prefers physical responseModel; summary metadata stays requested or unknown", async t => {
  const { save } = await fixture(t);
  const file = await save("response-model.jsonl", [header(),
    assistant("routed", [], { provider: "p", model: "router-alias", responseModel: "physical", usage: usage(1) }),
    assistant("direct", [], { provider: "p", model: "direct", usage: usage(2) }),
    entry("compaction", "compaction", { provider: "p", model: "router-alias", responseModel: "not-used", usage: usage(3) }),
    entry("summary", "branch_summary", { details: { responseModel: "not-used", usage: usage(4) } }),
  ]);
  const report = await analyzeSessions([file]);
  assert.deepEqual(report.raw_usage.by_model.map(group => [group.source, group.provider, group.model, group.usage.cost]), [
    ["assistant", "p", "direct", 2], ["assistant", "p", "physical", 1],
    ["branch_summary", "unknown", "unknown", 4], ["compaction", "p", "router-alias", 3],
  ]);
  assert.equal(report.raw_usage.total.cost, 10); assert.equal(report.parent.cost, 3);
});

test("error/aborted assistant usage preserves floors but marks uncertainty without fake missing data or extra records", async t => {
  const { save } = await fixture(t);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const all = ["input", "output", "cacheRead", "cacheWrite", "cost"];
  const files = [];
  for (const [name, stopReason, figures] of [
    ["error-zero", "error", zero], ["aborted-zero", "aborted", zero],
    ["error-positive", "error", usage(3)], ["aborted-positive", "aborted", usage(4)], ["success-zero", "stop", zero],
  ]) {
    const file = await save(`${name}.jsonl`, [header(name),
      assistant("a", [], { provider: "p", model: "alias", responseModel: "physical", stopReason, usage: figures })]);
    files.push(file);
    const report = await analyzeSessions([file]);
    const uncertain = stopReason === "stop" ? 0 : 1;
    for (const aggregate of [report.raw_usage.assistant, report.raw_usage.total, report.parent, report.raw_usage.by_model[0].usage]) {
      assert.equal(aggregate.records, 1, name); assert.equal(aggregate.usage_records, 1, name);
      assert.equal(aggregate.error_or_aborted_records, uncertain, name);
      assert.deepEqual(aggregate.partial, uncertain ? all : [], name);
      assert.equal(aggregate.cost, figures.cost.total, name);
      for (const metric of all) {
        assert.equal(aggregate.missing[metric], 0, `${name}:${metric}`);
        assert.equal(aggregate.invalid[metric], 0, `${name}:${metric}`);
        assert.equal(aggregate.declared_partial[metric], 0, `${name}:${metric}`);
        assert.equal(aggregate[metric], metric === "cost" ? figures.cost.total : figures[metric], `${name}:${metric}`);
      }
    }
    assert.equal(report.errors.assistant_error_stops, stopReason === "error" ? 1 : 0, name);
    assert.equal(report.raw_usage.compaction.error_or_aborted_records, 0, name);
  }
  const combined = await analyzeSessions(files);
  for (const aggregate of [combined.raw_usage.assistant, combined.raw_usage.total, combined.parent, combined.raw_usage.by_model[0].usage]) {
    assert.equal(aggregate.records, 5); assert.equal(aggregate.error_or_aborted_records, 4);
    assert.equal(aggregate.cost, 7); assert.deepEqual(aggregate.partial, all);
  }
});

test("HostUsage partial markers are conservatively unioned without adding attribution rows to flat totals", async t => {
  const { save } = await fixture(t);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const row = { model: "synthetic/attributed", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const all = ["input", "output", "cacheRead", "cacheWrite", "cost"];
  const cases = [
    { name: "complete-zero", host: zero, partial: [] },
    { name: "top-only", host: { ...zero, harnessPartial: ["cost", "cache_read", "cache_write", "cost", "unknown"] },
      partial: ["cacheRead", "cacheWrite", "cost"] },
    { name: "row-only", host: { ...zero, harnessModels: [{ ...row, partial: ["input", "output", "cache_read", "cache_write", "cost"] }] }, partial: all },
    { name: "union", host: { ...zero, partial: ["input"], harnessPartial: ["cache_read", "cost"],
      harnessModels: [{ ...row, partial: ["output", "cacheWrite", "cacheRead", "cost", "unknown"] }] }, partial: all },
    { name: "malformed-rows", host: { ...zero, harnessModels: [null, false, 42, "ignored",
      { model: "", cost: -1, partial: ["cost", "cache_write"] }, { unknown: true, partial: ["cache_read"] },
      { model: {}, partial: ["cost"] }] }, partial: ["cacheRead", "cacheWrite", "cost"] },
    { name: "malformed-container", host: { ...zero, harnessPartial: ["cost"], harnessModels: { partial: ["input"] } }, partial: ["cost"] },
    { name: "malformed-markers", host: { ...zero, partial: { cost: true }, harnessPartial: "cost",
      harnessModels: [{ ...row, partial: "cost" }, { ...row, partial: [null, {}, 1, "unrecognized"] }] }, partial: [] },
    { name: "row-claims-not-added", host: { ...zero, cost: { total: 7 }, harnessModels: [{ ...row, cost: 999, partial: ["cost"] }] }, partial: ["cost"] },
  ];
  for (const { name, host, partial } of cases) {
    const file = await save(`${name}.jsonl`, [header(name),
      assistant("a", [call("c", "nested_model_tool")], { provider: "p", model: "m", usage: usage(2) }),
      result("r", "c", "nested_model_tool", {}, { usage: host })]);
    const report = await analyzeSessions([file]);
    const attached = report.non_additive.tool_result_attached;
    assert.equal(attached.cost, host.cost.total, name); assert.equal(report.child_cost_attached, host.cost.total, name);
    assert.deepEqual(attached.partial, partial, name); assert.equal(attached.missing.cost, 0, name); assert.equal(attached.invalid.cost, 0, name);
    for (const metric of all) assert.equal(attached.declared_partial[metric], partial.includes(metric) ? 1 : 0, `${name}:${metric}`);
    assert.equal(report.raw_usage.total.cost, 2, name); assert.equal(report.raw_usage.by_model.length, 1, name);
    assert.equal(report.non_additive.additive, false, name);
  }
});

test("classification evidence outside the window remains available; conflicting evidence is explicit unknown", async t => {
  const { save } = await fixture(t);
  const before = "2026-01-01T23:59:59Z";
  const file = await save("child.jsonl", [header("child"),
    { ...custom("start", "harness:run-start:v1", { owner_id: "owner" }), timestamp: before },
    user("task"), assistant("a", [call("c", "agent_answer")])]);
  const child = await analyzeSessions([file], { since: timestamp });
  assert.equal(child.session_classification.child, 1); assert.equal(child.parent.calls, 0);
  assert.equal(child.management_only_turns, 0); assert.equal(child.management_only_turns_by_session_kind.child, 1);
  assert.equal(child.human_request_candidates, 0); assert.equal(child.user_messages_by_session_kind.child, 1);
  const conflicting = await save("conflicting-classification.jsonl", [header("child"),
    custom("start", "harness:run-start:v1", { owner_id: "owner" }),
    custom("residue", "harness:unreported-usage:v1", { owner_id: "child" }), user("u")]);
  const report = await analyzeSessions([conflicting]); assert.equal(report.session_classification.conflicting, 1);
  assert.equal(report.user_messages_by_session_kind.unknown, 1); assert.equal(report.human_request_candidates, 0);
});

test("bounded streaming handles chunk boundaries and rejects line, byte and depth caps without partial reports", async t => {
  const { root, save } = await fixture(t);
  const file = await save("chunks.jsonl", [header(), message("u", { role: "user", content: "x".repeat(200_000) })]);
  assert.equal((await analyzeSessions([file])).user_messages, 1);
  const oversized = join(root, "oversized-line.jsonl");
  await writeFile(oversized, JSON.stringify(header()) + "\n" + "x".repeat(LIMITS.line_bytes + 1));
  await assert.rejects(analyzeSessions([oversized]), /:2: line byte cap exceeded/);
  const large = join(root, "sparse.jsonl"); await writeFile(large, ""); await truncate(large, LIMITS.bytes + 1);
  await assert.rejects(analyzeSessions([large]), /:1: input byte cap exceeded/);
  let extra = {};
  for (let i = 0; i <= LIMITS.depth; i++) extra = { nested: extra };
  const deep = await save("deep.jsonl", [header(), entry("e", "custom", { extra })]);
  const cli = invoke(["--json", deep]); assert.equal(cli.status, 1); assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /:2: JSON depth cap exceeded/);
  const groups = Array.from({ length: LIMITS.groups }, (_, index) => assistant(`a${index}`, [], { provider: "p", model: `model${index}`, usage: usage(0) }));
  const atLimit = await save("groups-at-limit.jsonl", [header("groups"), ...groups]);
  assert.equal((await analyzeSessions([atLimit])).raw_usage.by_model.length, LIMITS.groups);
  const aboveLimit = await save("groups-above-limit.jsonl", [header("groups"), ...groups,
    assistant("extra", [], { provider: "p", model: "extra-model", usage: usage(0) })]);
  const capped = invoke(["--json", aboveLimit]); assert.equal(capped.status, 1); assert.equal(capped.stdout, "");
  assert.equal(capped.stderr, `${JSON.stringify(aboveLimit)}:${LIMITS.groups + 2}: report group cap exceeded\n`);
});
