// Canonical release policy is metadata only; fixture evidence keeps its own scope and outcome.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const policyPath = fileURLToPath(new URL("../../release-policy.json", import.meta.url));
const parsed = JSON.parse(readFileSync(policyPath, "utf8"));

const nonBlankString = (value) => typeof value === "string" && value.trim().length > 0;
const booleanRecord = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "boolean");

function assertReleasePolicy(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "RELEASE_POLICY_REQUIRED");
  assert(["GO", "NO-GO", "PENDING"].includes(value.decision), "RELEASE_DECISION_REQUIRED");
  for (const field of ["contract", "scope", "basis"]) assert(nonBlankString(value[field]), `RELEASE_${field.toUpperCase()}_REQUIRED`);
  assert.equal(typeof value.automaticDeploymentGate, "boolean", "RELEASE_AUTOMATIC_DEPLOYMENT_GATE_REQUIRED");
  assert(booleanRecord(value.guarantees), "RELEASE_GUARANTEES_REQUIRED");
  assert(booleanRecord(value.requirements), "RELEASE_REQUIREMENTS_REQUIRED");
}

assertReleasePolicy(parsed);
export const releaseDecision = Object.freeze({
  ...parsed,
  guarantees: Object.freeze({ ...parsed.guarantees }),
  requirements: Object.freeze({ ...parsed.requirements }),
});

// This only describes a completed evidence lane; it does not change its scope
// or turn successful fixture checks into an automated deployment decision.
export function validationSummary(scope) {
  assert(nonBlankString(scope), "VALIDATION_SCOPE_REQUIRED");
  return { checks: "passed", scope, release: releaseDecision, real_model: false };
}

export function releaseNotice() {
  const deploymentGate = releaseDecision.automaticDeploymentGate ? "an automated deployment gate" : "not an automated deployment gate";
  return `RELEASE: ${releaseDecision.decision} (${releaseDecision.contract}; ${releaseDecision.basis}); evidence-only; ${deploymentGate}; no real model.`;
}

function writePassedValidationSummary(output, scope) {
  assert(typeof output === "string" && output.length > 0, "VALIDATION_OUTPUT_REQUIRED");
  const directory = resolve(output);
  assert(existsSync(directory) && statSync(directory).isDirectory(), "VALIDATION_OUTPUT_DIRECTORY_REQUIRED");
  const target = join(directory, "validation-summary.json");
  assert(!existsSync(target), "VALIDATION_SUMMARY_ALREADY_EXISTS");
  writeFileSync(target, `${JSON.stringify(validationSummary(scope))}\n`, { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, passed, output, scope] = process.argv.slice(2);
  if (command === "--print-release-notice") {
    assert.equal(process.argv.length, 3, "Use --print-release-notice");
    console.log(releaseNotice());
  } else {
    assert.equal(command, "--write-validation-summary", "Use --write-validation-summary --checks-passed OUTPUT_DIRECTORY SCOPE");
    assert.equal(passed, "--checks-passed", "Validation summaries may only be written after checks pass");
    assert.equal(process.argv.length, 6, "Use --write-validation-summary --checks-passed OUTPUT_DIRECTORY SCOPE");
    writePassedValidationSummary(output, scope);
  }
}
