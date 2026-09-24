import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { abortAndWaitForIdle, requestAbort, subagentEnvHintKeys } from "../support/host.mjs";
import { FakePort, deferred, ended, errorCode, fixture, task, tick, until } from "../support/controller-fixture.mjs";
import { flock } from "../support/flock.mjs";

// Intercept every external SDK/model entrypoint: these are shell environment
// regressions, not real-model calls or another SDK/permission acceptance suite.
// This private package's tests require the enclosing checkout and Bash.
const scriptsRoot = new URL("../../../scripts/", import.meta.url);
// Execute the checker's actual discovery block with a controlled filesystem,
// before Jiti/SDK/authority loading. VM timeout bounds the pre-fix root loop.
for (const packageRoot of ["/fixture/sdk", "/", undefined]) {
  test(`managed-permission checker package discovery: ${packageRoot ?? "missing at filesystem root"}`, () => {
    const script = readFileSync(new URL("check-pi-managed-permissions.mjs", scriptsRoot), "utf8");
    const start = script.indexOf("let piRoot =");
    const end = script.indexOf("const { createJiti }");
    assert(start >= 0 && end > start, "discovery must precede SDK imports");
    const visited = [], executable = "/fixture/pi-link";
    const discover = () => runInNewContext(`${script.slice(start, end)}\npiRoot;`, {
      assert, dirname, join, executable,
      realpathSync: (path) => { assert.equal(path, executable); return "/fixture/sdk/dist/cli.js"; },
      existsSync: (path) => {
        assert(visited.length < 8, "unbounded package traversal");
        visited.push(path);
        return packageRoot !== undefined && path === join(packageRoot, "package.json");
      },
    }, { timeout: 1000 });
    if (packageRoot === undefined) {
      assert.throws(discover, /Pi package\.json not found above \/fixture\/pi-link/);
    } else assert.equal(discover(), packageRoot);
    assert.deepEqual(visited, ["/fixture/sdk/dist/package.json", "/fixture/sdk/package.json",
      ...(packageRoot === "/fixture/sdk" ? [] : ["/fixture/package.json", "/package.json"])]);
  });
}

const collectorScripts = ["collect-pi-harness-evidence.sh", "check-pi-harness.sh"];
const liveTrialScripts = ["run-pi-harness-live-trial.sh", "run-pi-live-trial.sh"];
for (const [alias, canonical] of [["check-pi-harness.sh", "collect-pi-harness-evidence.sh"], ["run-pi-live-trial.sh", "run-pi-harness-live-trial.sh"]]) {
  test(`${alias} is a thin exec compatibility wrapper for ${canonical}`, () => {
    const wrapper = readFileSync(new URL(alias, scriptsRoot), "utf8");
    assert.match(wrapper, /^set -euo pipefail$/m);
    if (alias === "run-pi-live-trial.sh") {
      assert.match(wrapper, /# Explicit opt-in: calls a REAL model/);
      assert.match(wrapper, /# SDK OAuth refresh may update the existing auth file IN PLACE\./);
    } else {
      assert.match(wrapper, /# Isolated harness experiments, not a production admission check\. Never installs Pi\./);
    }
    assert.match(wrapper, new RegExp(`^exec "\\$SCRIPT_DIR/${canonical}" "\\$@"$`, "m"));
  });
}
for (const script of liveTrialScripts) test(`${script} requires an explicit model before creating trial resources`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-explicit-model-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output");
  const result = spawnSync("bash", [fileURLToPath(new URL(script, scriptsRoot)), "--output", output], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "forbidden-auth") },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--model PROVIDER\/MODEL/);
  assert.equal(existsSync(output), false);
});
const collectorCases = [
  [["--tools-only"], ["packaging/entry-package.mjs", "host/entry.mjs", "host/tools.mjs", "host/model-trial.mjs --controlled", "host/model-trial-failures.mjs"]],
  [["--permissions-only"], ["host/readonly-permissions.mjs"]],
  [["--luna-only"], ["host/readonly-permissions.mjs"]],
  [["--jev-only"], ["host/jev-approval.mjs"]],
  [["--all"], ["packaging/entry-package.mjs", "host/entry.mjs", "host/tools.mjs", "host/model-trial.mjs --controlled", "host/model-trial-failures.mjs", "tui/reload.mjs", "host/session-integration.mjs", "host/run-lifecycle.mjs", "host/readonly-permissions.mjs"]],
  [[], ["packaging/entry-package.mjs", "host/entry.mjs", "host/tools.mjs", "host/model-trial.mjs --controlled", "host/model-trial-failures.mjs", "tui/reload.mjs", "host/session-integration.mjs", "host/run-lifecycle.mjs"]],
];
const scriptCases = [
  ...collectorScripts.flatMap((script) => collectorCases.map(([options, entries]) => [script, options, entries])),
  ...liveTrialScripts.map((script) => [script, [], ["host/model-trial.mjs"]]),
  ["check-pi-sdk-history.sh", [], ["host/sdk-history.mjs"]],
  ...collectorScripts.map((script) => [script, ["--all"], [], true]),
];
for (const [script, options, entries, lintFails = false] of scriptCases) test(`${script} ${options.join(" ")} ${lintFails ? "stops on lint failure before SDK/PTY probes" : "strips hints and enforces shadow before Node/PTY entrypoints"}`, (t) => {
  const collector = collectorScripts.includes(script);
  const root = mkdtempSync(join(tmpdir(), "pi-harness-env-")), bin = join(root, "bin"), log = join(root, "calls.txt");
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(bin);
  for (const name of ["pi", "nix"]) writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$HARNESS_ENV_PROBE_LOG"
if [[ "$1" == run && "$2" == lint ]]; then exit "\${HARNESS_TEST_LINT_EXIT:-0}"; fi
`, { mode: 0o700 });
  for (const name of ["node", "python3"]) writeFileSync(join(bin, name), `#!/usr/bin/env bash
set -euo pipefail
[[ "$PI_AUTO_APPROVAL_MODE" == shadow ]] || { printf '%s\\n' 'Missing shadow isolation' >&2; exit 74; }
${collector ? `expected_jev=shadow
[[ "$1" != */test/host/jev-approval.mjs ]] || expected_jev=enforce-subagents
[[ "$PI_JEV_APPROVAL_MODE" == "$expected_jev" ]] || { echo 'Wrong Jev isolation mode' >&2; exit 75; }
[[ ! -v PI_JEV_API_KEY_FILE ]] || { echo 'Inherited Jev credential path' >&2; exit 76; }
if [[ "$1" == */test/packaging/entry-package.mjs ]]; then
  [[ "$PI_CODING_AGENT_DIR" == */${options.includes("--all") ? "agent-full" : "agent"} ]] || { echo 'Wrong packaging resource lane' >&2; exit 78; }
fi
if [[ "$expected_jev" == enforce-subagents ]]; then
  [[ "$HOME" == */pi-harness-fixture-*/home && "$PI_CODING_AGENT_DIR" == */pi-harness-fixture-*/agent && "$PI_OFFLINE" == 1 ]] || exit 77
fi` : ""}
for key in ${subagentEnvHintKeys.join(" ")}; do
  if [[ -v "$key" ]]; then printf 'Inherited hint: %s\\n' "$key" >&2; exit 73; fi
done
printf '%s\\n' "$*" >> "$HARNESS_ENV_PROBE_LOG"
`, { mode: 0o700 });
  const output = spawnSync("bash", [fileURLToPath(new URL(script, scriptsRoot)),
    ...options, "--output", join(root, "output"), ...(liveTrialScripts.includes(script) ? ["--model", "fixture/controlled"] : [])], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, ...Object.fromEntries(subagentEnvHintKeys.map((key) => [key, "synthetic-inherited-hint"])),
      PATH: `${bin}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: join(root, "missing-installed-agent"),
      PI_AUTO_APPROVAL_MODE: "enforce-subagents",
      ...(collector ? { PI_JEV_APPROVAL_MODE: "enforce-subagents",
        PI_JEV_API_KEY_FILE: "/synthetic/do-not-read-real-key" } : {}),
      HARNESS_ENV_PROBE_LOG: log, HARNESS_TEST_LINT_EXIT: lintFails ? "73" : "0", P0_FLOCK: flock } });
  assert.equal(output.status, lintFails ? 73 : 0, `${output.error ?? ""}\n${output.stderr}`);
  const calls = readFileSync(log, "utf8").trimEnd().split("\n");
  if (lintFails) {
    assert.equal(calls.length, 1, "a lint failure must prevent typecheck, SDK, PTY and permission preparation");
    assert.match(calls[0], /^npm run lint --prefix /);
    return;
  }
  if (collector) {
    const lint = calls.findIndex((call) => call.startsWith("npm run lint --prefix "));
    const types = calls.findIndex((call) => call.startsWith("npm run typecheck --prefix "));
    const extensions = calls.findIndex((call) => call.includes("/scripts/check-pi-types.mjs "));
    const tests = calls.findIndex((call) => call.startsWith("npm test --prefix "));
    assert.equal(calls.filter((call) => call.startsWith("npm run lint --prefix ")).length, 1);
    assert(lint >= 0 && types > lint && extensions > types && tests > extensions, "collector must preserve local gate ordering");
    const policyHelper = fileURLToPath(new URL("../support/release-policy.mjs", import.meta.url));
    const reporting = calls.filter((call) => call.startsWith(`${policyHelper} `));
    const scope = ({
      "--tools-only": "core-and-tools-only", "--permissions-only": "core-and-readonly-permissions",
      "--luna-only": "core-and-luna-negative-permissions", "--jev-only": "core-and-jev-permissions",
    })[options[0]] ?? "core-and-full-suite";
    const summary = (directory, lane) => `${policyHelper} --write-validation-summary --checks-passed ${join(root, "output", directory)} ${lane}`;
    const notice = `${policyHelper} --print-release-notice`;
    assert.deepEqual(reporting, options.includes("--all") ? [
      summary("full", "core-and-full-suite"), summary("readonly", "core-and-readonly-permissions"), notice,
      summary("", "core-full-suite-and-readonly-permissions"), notice,
    ] : [summary("", scope), notice], "reporting must preserve lane scope and use the canonical policy helper");
  }
  const fixtureCall = (call) => /\/test\/(?:support|host|packaging|tui)\//.test(call);
  const fixtureName = (call) => /\/test\/(?:support|host|packaging|tui)\/(\S+)/.exec(call)[1];
  for (const call of calls.filter(fixtureCall)) {
    const needsInstalled = !collector && /\/host\/model-trial\.mjs(?: |$)/.test(call);
    assert.equal(call.includes(join(root, "missing-installed-agent")), needsInstalled,
      `only explicitly opt-in live model trials may receive the original agent dir: ${call}`);
  }
  const prepared = calls.findIndex((call) => call.includes("/test/support/managed-authority.mjs "));
  assert(prepared >= 0, "missing matched runtime managed authority preparation");
  for (const entry of entries) assert(calls.some((call, index) => index > prepared && call.includes(`/test/${entry} `)),
    `missing required entrypoint/arguments after authority preparation: ${entry}`);
  if (entries.includes("packaging/entry-package.mjs")) {
    const packaged = calls.findIndex((call) => call.includes("/test/packaging/entry-package.mjs "));
    const smoke = calls.findIndex((call) => call.includes("/test/host/entry.mjs "));
    assert(packaged < smoke, "must build/capture actual launcher before entry smoke");
  }
  if (collector && (options.length === 0 || options.includes("--all"))) {
    assert(calls.some((call) => call.includes("/test/host/run-lifecycle.mjs ") && call.endsWith(" --natural-finish-steer")), "missing natural finish/steer probe");
    for (const kind of ["initial", "steer", "soft-budget"]) {
      assert(calls.some((call) => call.includes("/test/host/run-lifecycle.mjs ") && call.endsWith(` --post-guard-${kind}`)), `missing post-guard ${kind} probe`);
    }
  }
  if (options.includes("--permissions-only") || options.includes("--luna-only")) {
    const probes = calls.filter((call) => call.includes("/test/host/readonly-permissions.mjs "));
    assert.equal(probes.length, 1);
    assert.equal(probes[0].endsWith(" --luna"), options.includes("--luna-only"));
    const fixtures = calls.filter(fixtureCall);
    assert.deepEqual(fixtures.map(fixtureName),
      ["managed-authority.mjs", "readonly-permissions.mjs", "release-policy.mjs", "release-policy.mjs"],
      "permission-only modes must run only authority preparation, their one permission probe and reporting");
  }
  if (options.includes("--all")) {
    const authorities = calls.filter((call) => call.includes("/test/support/managed-authority.mjs "));
    assert.equal(authorities.length, 2, "all mode prepares independently rendered full and readonly resources");
    assert(authorities[0].includes("/agent-full ") && authorities[0].includes("/output/full"));
    assert(authorities[1].includes("/agent-readonly ") && authorities[1].includes("/output/readonly"));
    const probes = calls.filter((call) => call.includes("/test/host/readonly-permissions.mjs "));
    assert.equal(probes.length, 1); assert(!probes[0].endsWith(" --luna"));
    assert(probes[0].includes("/agent-readonly ") && probes[0].includes("/output/readonly"),
      "all mode permission probe must use its strict resource/output lane");
    for (const name of ["host/entry.mjs", "host/tools.mjs", "host/session-integration.mjs", "host/run-lifecycle.mjs"]) {
      for (const call of calls.filter((entry) => entry.includes(`/test/${name} `))) assert(call.includes("/agent-full "), call);
    }
  }
  if (options.includes("--jev-only")) {
    const unit = calls.findIndex((call) => call.includes("/scripts/check-pi-jev.mjs "));
    const integration = calls.findIndex((call) => call.includes("/test/host/jev-approval.mjs "));
    assert(unit > prepared && integration > unit, "rendered authorizer regressions must precede real forwarding integration");
    assert.deepEqual(calls.filter(fixtureCall).map(fixtureName),
      ["managed-authority.mjs", "jev-approval.mjs", "release-policy.mjs", "release-policy.mjs"],
      "Jev-only must not run unrelated SDK/PTY/model trials");
  }
  assert(!calls.some((call) => call.includes("/npm/node_modules/@gotgenes/pi-permission-system")), "must not load the installed npm authority");
});

test("controlled failure aggregator budget covers all three child ceilings", () => {
  const collector = readFileSync(new URL("collect-pi-harness-evidence.sh", scriptsRoot), "utf8");
  const child = readFileSync(new URL("../host/model-trial-failures.mjs", import.meta.url), "utf8");
  const seconds = Number(/timeout -k 5s (\d+)s node "\$HARNESS\/test\/host\/model-trial-failures\.mjs"/.exec(collector)?.[1]);
  const milliseconds = Number(/timeout: (\d+)/.exec(child)?.[1]);
  assert(seconds * 1000 >= 3 * milliseconds + 30000, "aggregate timeout must include child budgets and teardown margin");
});

test("agent check reports missing Pi before creating resources or building runtime", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("bash", ["-c", 'unset PI_TEST_EXECUTABLE; PATH="$1"; export PATH; exec "$BASH" "$2"', "missing-pi", root,
    fileURLToPath(new URL("check-pi-agents.sh", scriptsRoot))], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Pi is not installed or is not on PATH.");
  assert.equal(result.stdout, "");
});

for (const outcome of ["success", "sync-throw", "async-reject"]) test(`watchdog abort immediately dispatches and records ${outcome}`, async () => {
  const errors = []; let called = false;
  const session = { abort() {
    called = true;
    if (outcome === "sync-throw") throw new Error("synthetic abort failure");
    return outcome === "async-reject" ? Promise.reject(new Error("synthetic abort failure")) : Promise.resolve();
  } };
  const requested = requestAbort(session, errors);
  assert.equal(called, true, "abort dispatch must not be deferred to another microtask");
  await requested;
  assert.deepEqual(errors, outcome === "success" ? [] : ["Error: synthetic abort failure"]);
});

test("fixture abort helper confirms abort, idle wait and actual idle before returning", async () => {
  const calls = [], session = { isIdle: false,
    async abort() { calls.push("abort"); }, async waitForIdle() { calls.push("idle"); this.isIdle = true; } };
  await abortAndWaitForIdle(session); assert.deepEqual(calls, ["abort", "idle"]);
  session.waitForIdle = async () => {}; session.isIdle = false;
  await assert.rejects(abortAndWaitForIdle(session), /EXECUTION_NOT_EXITED/);
});
for (const synchronous of [true, false]) test(`fixture abort helper preserves ${synchronous ? "sync" : "async"} failure`, async () => {
  const failure = new Error("synthetic abort failure"); let waited = false;
  const session = { abort() { if (synchronous) throw failure; return Promise.reject(failure); },
    async waitForIdle() { waited = true; }, isIdle: true };
  await assert.rejects(abortAndWaitForIdle(session), (error) => error === failure); assert.equal(waited, false);
});
for (const phase of ["abort", "waitForIdle"]) for (const late of ["resolve", "reject"]) {
  test(`fixture ${phase} timeout stays failed after late ${late}, without unhandled rejection`, async (t) => {
    const gate = deferred(), unhandled = [], observe = (error) => unhandled.push(error);
    process.on("unhandledRejection", observe);
    t.after(() => { gate.resolve(); process.off("unhandledRejection", observe); });
    const session = { async abort() {}, async waitForIdle() {}, isIdle: true };
    session[phase] = () => gate.promise;
    const cleanup = abortAndWaitForIdle(session, 10);
    await assert.rejects(cleanup, /SESSION_ABORT_OR_IDLE_TIMEOUT/);
    if (late === "reject") gate.reject(new Error("late synthetic rejection")); else gate.resolve();
    await tick(); await tick();
    await assert.rejects(cleanup, /SESSION_ABORT_OR_IDLE_TIMEOUT/); assert.deepEqual(unhandled, []);
  });
}

for (const controlled of [false, true]) test(`direct ${controlled ? "controlled" : "real-model"} trial refuses non-isolated HOME before host imports or auth access`, () => {
  const args = controlled ? ["--controlled", "/synthetic/no-pi", "/synthetic/no-agent", "/synthetic/fixture/agent", "/synthetic/no-output"] :
    ["/synthetic/no-pi", "/synthetic/no-agent", "/synthetic/no-resources", "/synthetic/no-config", "/synthetic/no-output"];
  const output = spawnSync(process.execPath, [fileURLToPath(new URL("../host/model-trial.mjs", import.meta.url)), ...args],
  { env: { ...process.env, HOME: "/synthetic/wrong-home" }, encoding: "utf8", timeout: 5000 });
  assert.equal(output.status, 1); assert.match(output.stderr, /Use the isolating shell wrapper/);
  assert.doesNotMatch(output.stderr, /ENOENT/); // loadHost would realpath /synthetic/no-pi if reached.
});

for (const stop of [undefined, "user_cancel", "hard_budget"]) test(`unobserved input still quarantines without replacing frozen ${stop ?? "no stop"} outcome`, async (t) => {
  const port = new FakePort(), runPort = port.run.bind(port);
  // The ordinary FakePort observes input; omitting it is essential to this bug.
  port.run = (prompt, callbacks) => runPort(prompt, { ...callbacks, inputEntered() {} });
  const { controller: c, ports } = await fixture(t, { controller: { createSession: async () => port, grace_turns: 0 } });
  ports.push(port);
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => port.streaming);
  if (stop === "user_cancel") c.cancel(a.run_id);
  if (stop === "hard_budget") port.callbacks.turnStart();
  port.finish("late success without observed input");
  const done = (await ended(c, a)).snapshots[0];
  assert.equal(done.stop_reason, stop);
  assert.equal(done.status, stop === "user_cancel" ? "cancelled" : "failed");
  assert.equal(done.outcome.reason, stop === "hard_budget" ? "turn_limit" : stop ? undefined : "input_not_observed");
  assert.equal(done.unavailable_reason, "input_not_observed"); assert.equal(done.resumable, false);
  assert.equal(port.disposed, 1); assert.equal(c.stats().resident, 0); assert.equal(c.stats().active, 0);
});

for (const effect of ["throw", "async resolve", "async reject", "non-void"]) test(`submit effect ${effect}: accepted failure retains idempotence and never calls factory`, async (t) => {
  let calls = 0;
  const { controller: c, ports } = await fixture(t, { controller: { onContextChange: () => {
    calls++;
    if (effect === "throw") throw new Error("synthetic context failure");
    if (effect === "async resolve") return Promise.resolve();
    if (effect === "async reject") return Promise.reject(new Error("synthetic rejected effect"));
    return true;
  } } });
  const a = await c.submit("a", task("a"));
  const done = (await ended(c, a)).snapshots[0];
  assert.equal(done.status, "failed"); assert.equal(done.outcome.reason, "context_change_failed");
  assert.match(done.outcome.error, effect === "throw" ? /synthetic context failure/ : /synchronously return undefined/);
  assert.equal(done.stop_reason, undefined); assert.equal(done.unavailable_reason, "context_change_failed");
  assert.equal(ports.length, 0); assert.equal(c.stats().resident, 0);
  assert.equal((await c.submit("a", task("a"))).run_id, a.run_id); assert.equal(calls, 1);
  await assert.rejects(c.submit("a", task("different")), errorCode("REQUEST_CONFLICT"));
});

test("rejected async consumer cannot roll back its own late effect and leaks no unhandled rejection", async (t) => {
  const gate = deferred(), unhandled = []; let effect = false;
  const observe = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  t.after(() => { gate.resolve(); process.off("unhandledRejection", observe); });
  const { controller: c, ports } = await fixture(t, { controller: { onContextChange: async () => {
    await gate.promise; effect = true; throw new Error("late synthetic effect failure");
  } } });
  const a = await c.submit("a", task("a"));
  assert.equal((await ended(c, a)).snapshots[0].outcome.reason, "context_change_failed");
  assert.equal(effect, false); assert.equal(ports.length, 0);
  gate.resolve(); await until(() => effect); await tick();
  assert.deepEqual(unhandled, []);
});

test("failed resume effect keeps the new Run but isolates the old session before prompt", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { onContextChange: (event) => {
    if (event.kind === "resume") throw new Error("resume context failure");
  } } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  ports[0].finish("first answer"); await ended(c, a);
  const request = { resume: a.agent_id, prompt: "follow-up" };
  const b = await c.submit("b", request); const done = (await ended(c, b)).snapshots[0];
  assert.notEqual(a.run_id, b.run_id); assert.equal(done.outcome.reason, "context_change_failed");
  assert.equal(ports[0].calls.length, 1); assert.equal(ports[0].disposed, 1);
  assert.equal(c.getResult(a.run_id).text, "first answer");
  assert.equal((await c.submit("b", request)).run_id, b.run_id);
  await assert.rejects(c.submit("c", request), errorCode("AGENT_UNAVAILABLE"));
});

test("failed steer effect rejects before dispatch or quota use", async (t) => {
  let reject = true;
  const { controller: c, ports } = await fixture(t, { controller: { onContextChange: (event) => {
    if (event.kind === "steer" && reject) throw new Error("steer context failure");
  } } });
  const a = await c.submit("a", task("a")); await until(() => ports[0]?.streaming);
  assert.throws(() => c.steer(a.run_id, "must not enter"), errorCode("CONTEXT_CHANGE_FAILED"));
  reject = false;
  for (let i = 0; i < 64; i++) c.steer(a.run_id, `accepted ${i}`);
  assert.throws(() => c.steer(a.run_id, "over quota"), errorCode("INPUT_LIMIT"));
  await until(() => ports[0].inputs.length === 64); assert(!ports[0].inputs.includes("must not enter"));
});

for (const kind of ["cancel", "hard_budget"]) test(`${kind} freezes before reentrant/throwing context consumer and still aborts once`, async (t) => {
  let c, calls = 0;
  const f = await fixture(t, { controller: { grace_turns: 0, onContextChange: (event) => {
    if (event.kind !== kind) return;
    calls++;
    assert.equal(c.cancel(event.run_id).already_stopping, true);
    throw new Error("stop context failure");
  } } });
  c = f.controller;
  const a = await c.submit("a", task("a", { max_turns: 1 })); await until(() => f.ports[0]?.streaming);
  if (kind === "cancel") c.cancel(a.run_id); else f.ports[0].callbacks.turnStart();
  await until(() => f.ports[0].stopped === 1);
  f.ports[0].finish("late success"); const done = (await ended(c, a)).snapshots[0];
  assert.equal(calls, 1); assert.equal(f.ports[0].disposed, 1);
  assert.equal(done.status, kind === "cancel" ? "cancelled" : "failed");
  assert.equal(done.outcome.reason, kind === "cancel" ? undefined : "turn_limit");
  assert.equal(done.stop_reason, kind === "cancel" ? "user_cancel" : "hard_budget");
  assert(done.cleanup_errors.some((error) => error.includes("stop context failure")));
});
