// Three specific negative runs of the SAME controlled trial, isolated in child
// processes so an uncertain owner is never force-closed to continue testing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseDecision } from "../support/release-policy.mjs";

const [piExecutable, installedAgentDir, generatedRoot, outputRoot] = process.argv.slice(2);
assert(piExecutable && installedAgentDir && generatedRoot && outputRoot, "Use check-pi-harness.sh --tools-only");
const root = join(outputRoot, "controlled-failures"); mkdirSync(root, { mode: 0o700 });
const reports = [];
for (const fault of ["parent-answer-error", "post-assembly", "post-assembly-cleanup-timeout"]) {
  const output = join(root, fault); mkdirSync(output, { mode: 0o700 });
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./model-trial.mjs", import.meta.url)),
    "--controlled", piExecutable, installedAgentDir, generatedRoot, output, fault], {
    env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: join(output, "controlled-model-sessions") },
    encoding: "utf8", timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
  writeFileSync(join(output, "process.log"), `${child.stdout ?? ""}\n${child.stderr ?? ""}`, { mode: 0o600 });
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 1, `${fault}: expected trial failure`);
  const report = JSON.parse(readFileSync(join(output, "controlled-model-trial.json"), "utf8"));
  const scenario = report.cases[0];
  assert.equal(report.real_model, false); assert.equal(report.injected_fault, fault);
  assert.equal(report.status, "failed"); assert.equal(scenario.status, "failed");
  assert(!scenario.deadline && !scenario.turn_limit, "watchdog/budget failure cannot stand in for the injected fault");
  assert.equal(report.cleanup.parent_idle, true);
  if (fault === "parent-answer-error") {
    assert.equal(scenario.first.stop_reason, "stop");
    assert.equal(scenario.final, "7 × 11 × 3 = 231。");
    assert.equal(scenario.stop_reason, "error"); assert.equal(scenario.error_message, "SYNTHETIC_PARENT_ANSWER_ERROR");
    assert.deepEqual(scenario.failures, ["parent answer did not finish with stop"]);
    const answer = report.calls.find((call) => call.name === "resume_agent" && !call.is_error).value.run_id;
    assert(report.calls.some((call) => call.name === "resume_agent" && call.is_error === false &&
      call.value?.wait?.runs.some((run) => run.run_id === answer && run.status === "completed" &&
        run.complete === true && run.text === scenario.final)));
    const transcript = JSON.parse(readFileSync(join(output, "controlled-parent.json"), "utf8"));
    const last = transcript.findLast((message) => message.role === "assistant");
    assert.equal(last.stopReason, "error"); assert.equal(last.errorMessage, scenario.error_message);
    assert.deepEqual(report.factory_failures, []);
  } else {
    assert.equal(report.factory_failures.length, 1);
    const failure = report.factory_failures[0];
    assert.match(failure.original_error, /AssertionError.*SYNTHETIC_POST_ASSEMBLY_FAILURE/);
    assert.equal(failure.permission_present_before_cleanup, true);
    assert.deepEqual(report.child_tool_calls, []);
    assert.equal(scenario.run_states.length, 1); assert.equal(scenario.run_states[0].status, "failed");
    assert.match(scenario.run_states[0].outcome.error, /SYNTHETIC_POST_ASSEMBLY_FAILURE/);
    if (fault === "post-assembly") {
      assert.equal(failure.cleanup.shutdownExited, true); assert.deepEqual(failure.cleanup.errors, []);
      assert.equal(failure.permission_removed, true); assert.equal(failure.cleanup_error, undefined);
      assert.doesNotMatch(scenario.run_states[0].outcome.error, /CHILD_INITIALIZATION_FAILED/);
    } else {
      assert.equal(report.factory_cleanup_held, true);
      assert.equal(failure.cleanup.shutdownExited, false); assert(failure.cleanup.errors.includes("CHILD_SHUTDOWN_TIMEOUT"));
      assert.equal(failure.permission_removed, false);
      assert.match(scenario.run_states[0].outcome.error, /CHILD_INITIALIZATION_FAILED.*SYNTHETIC_POST_ASSEMBLY_FAILURE.*CHILD_SHUTDOWN_TIMEOUT/s);
    }
  }
  const uncertain = fault === "post-assembly-cleanup-timeout";
  assert.equal(report.cleanup.controller.closed, !uncertain);
  assert.equal(report.cleanup.resources_after_shutdown.cleanup_uncertain, uncertain);
  assert.equal(report.cleanup.resources_after_shutdown.resident, uncertain ? 1 : 0);
  assert.equal(report.cleanup.parent_permission_present, uncertain);
  if (uncertain) assert.equal(report.cleanup.parent.skipped, "OWNER_NOT_CLOSED");
  else { assert.equal(report.cleanup.parent.shutdownExited, true); assert.deepEqual(report.cleanup.parent.errors, []); }
  reports.push({ fault, status: "expected-failure-verified", report: join("controlled-failures", fault, "controlled-model-trial.json") });
  console.log(`PASS controlled trial fault: ${fault}`);
}
writeFileSync(join(outputRoot, "controlled-failures.json"), JSON.stringify({ real_model: false, release: releaseDecision, cases: reports }, null, 2), { mode: 0o600 });
