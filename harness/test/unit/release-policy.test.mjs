import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseDecision, validationSummary } from "../support/release-policy.mjs";

const helper = fileURLToPath(new URL("../support/release-policy.mjs", import.meta.url));
const policySource = new URL("../../release-policy.json", import.meta.url);

test("canonical release metadata retains the pending scope and rejected safety guarantees", () => {
  assert.equal(releaseDecision.decision, "PENDING");
  assert.equal(releaseDecision.contract, "cooperative-local-v1");
  assert.equal(releaseDecision.scope, "explicit-pi-alehouse-launcher");
  assert.equal(releaseDecision.automaticDeploymentGate, false);
  assert.deepEqual(releaseDecision.guarantees, {
    atomicCancellation: false,
    zeroPostCancelActivity: false,
    forcedExecutionExit: false,
    liveOwnerReloadSafety: false,
  });
  assert.deepEqual(releaseDecision.requirements, {
    matchingGeneratedRuntime: true,
    freshProcess: true,
    closeOwnerBeforeReplacement: true,
  });
});

test("validation summaries preserve evidence scope and real-model status beside release metadata", () => {
  const summary = validationSummary("core-and-luna-negative-permissions");
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    checks: "passed",
    scope: "core-and-luna-negative-permissions",
    release: releaseDecision,
    real_model: false,
  });
  assert.equal("deployment" in summary, false);
  assert.throws(() => validationSummary(" \t\n"), /VALIDATION_SCOPE_REQUIRED/);
});

test("summary CLI writes only an explicitly completed validation summary", () => {
  const output = mkdtempSync(join(tmpdir(), "harness-release-summary-"));
  const summaryPath = join(output, "validation-summary.json");
  try {
    const invalid = spawnSync(process.execPath, [helper, "--write-validation-summary", output, "narrow-lane"], { encoding: "utf8" });
    assert.ifError(invalid.error); assert.notEqual(invalid.status, 0);
    assert.equal(existsSync(summaryPath), false, "invalid invocation must not write a successful summary");
    const whitespace = spawnSync(process.execPath, [helper, "--write-validation-summary", "--checks-passed", output, " \t "], { encoding: "utf8" });
    assert.ifError(whitespace.error); assert.notEqual(whitespace.status, 0);
    assert.equal(existsSync(summaryPath), false, "blank scope must not write a successful summary");

    const valid = spawnSync(process.execPath, [helper, "--write-validation-summary", "--checks-passed", output, "narrow-lane"], { encoding: "utf8" });
    assert.ifError(valid.error); assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(readFileSync(summaryPath, "utf8")), validationSummary("narrow-lane"));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a revoked policy changes release metadata without changing completed evidence facts", () => {
  const output = mkdtempSync(join(tmpdir(), "harness-revoked-policy-"));
  const copiedHelper = join(output, "test", "support", "release-policy.mjs");
  try {
    const original = JSON.parse(readFileSync(policySource, "utf8"));
    const revoked = { ...original, decision: "NO-GO" };
    assert.deepEqual({ ...revoked, decision: original.decision }, original);
    mkdirSync(join(output, "test", "support"), { recursive: true });
    copyFileSync(helper, copiedHelper);
    writeFileSync(join(output, "release-policy.json"), JSON.stringify(revoked));

    const notice = spawnSync(process.execPath, [copiedHelper, "--print-release-notice"], { encoding: "utf8" });
    assert.ifError(notice.error); assert.equal(notice.status, 0, notice.stderr);
    assert(notice.stdout.startsWith(`RELEASE: NO-GO (${revoked.contract};`), notice.stdout);

    const summary = spawnSync(process.execPath, [copiedHelper, "--write-validation-summary", "--checks-passed", output,
      "core-and-luna-negative-permissions"], { encoding: "utf8" });
    assert.ifError(summary.error); assert.equal(summary.status, 0, summary.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "validation-summary.json"), "utf8")), {
      checks: "passed",
      scope: "core-and-luna-negative-permissions",
      release: revoked,
      real_model: false,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
