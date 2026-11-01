// Offline serving-wiring regressions for the ACTUAL generated vendor
// composition root (runtime/permission-system/vendor/src/index.ts).
//
// The existing workspace-policy suite covers the managed-workspace-policy
// source; the mutation-sensitive seam it did not cover is the composition
// root's serving callback: the ServingPolicy closure that resolves a
// child-fixed forwarded intent against the parent's real rules while
// verifying binding, parentage and restriction aliases. That closure must be
// exercised as the real index builds it — a hand-copied callback in the test
// cannot observe a lost `workspacePolicyValues` wiring — so each case runs
// one bounded subprocess fixture that loads the real index and serves one
// synthetic request over the real forwarding wire (see
// fixtures/workspace-serving.mjs for what stays real).
//
// Assertions are behavioral (JSON records from the real pipeline), never
// source-string matches, so controlled mutations of the generated index flip
// them: dropping the wiring turns every source-gated case below into an
// auto-approval, and dropping only the alias content comparison is caught by
// the same-length forged case. No model, network, human approval, Git, Nix or
// live configuration; fixtures live under the OS tmpdir only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/workspace-serving.mjs");
const vendorIndex = join(packageRoot, "runtime/permission-system/vendor/src/index.ts");

function serve(scenario) {
  assert.ok(existsSync(vendorIndex), `missing generated vendor index: ${vendorIndex}`);
  const run = spawnSync(process.execPath, [fixturePath, "--scenario", scenario],
    { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, `workspace-serving fixture failed for ${scenario}\nstderr: ${run.stderr}`);
  let record;
  try {
    record = JSON.parse(run.stdout);
  } catch {
    assert.fail(`fixture printed non-JSON output for ${scenario}: ${run.stdout}`);
  }
  assert.equal(record.scenario, scenario);
  assert.equal(record.index, vendorIndex, "the standard run serves through packageRoot's generated index");
  assert.equal(record.policyCaptured, true,
    "the composition root must pass its actual ServingPolicy closure to the real ForwardedRequestServer");
  assert.equal(record.escalatorWired, true, "the real escalation seam is wired into the server");
  assert.ok(record.events.includes("permissions:ready"), "the real session lifecycle published the service");
  assert.equal(record.wire.responseFile, true, `${scenario}: the server must answer instead of leaving the inbox hanging`);
  assert.equal(record.wire.requestDrained, true, `${scenario}: the served request is drained from the inbox`);
  return record;
}

const matchedSourceRule = (record, name) => {
  assert.ok(record.direct.matchedPattern?.endsWith(name),
    `${record.scenario}: matched the exact source rule, not a worktree/global pattern`);
  assert.ok(record.recomputedAliases.includes(record.direct.matchedPattern),
    `${record.scenario}: the matched pattern is a recomputed workspace alias`);
  assert.notEqual(record.direct.matchedPattern, record.matchValues[0],
    `${record.scenario}: the verdict came from the source alias, never the raw worktree path`);
};

test("workspace serving: source-only exact ask stays an ask through the real index wiring and is never auto-approved", () => {
  const record = serve("ask");
  assert.equal(record.bound, true);
  assert.deepEqual(record.wireValues, record.recomputedAliases,
    "the child's honest restriction values are the real helper's recomputation");
  assert.ok(record.recomputedAliases.length > 0, "the alias list is non-empty");
  assert.ok(record.recomputedAliases.every((value) => value.endsWith("notes.review")));
  assert.equal(record.direct.threw, false);
  assert.equal(record.direct.state, "ask", "the actual serving closure preserves the source-only ask");
  assert.equal(record.direct.origin, "project");
  matchedSourceRule(record, "notes.review");
  // Headless wire: the real escalation seam answers with the real
  // DenyingAuthorizer — an unavailable denial, never a human approval and
  // never an auto-approval of the gated read.
  assert.equal(record.wire.response.approved, false, "the forwarded ask is not auto-approved");
  assert.equal(record.wire.response.state, "denied");
  assert.equal(record.wire.response.decidedBy?.kind, "unavailable",
    "no human was asked: the headless wire reports confirmation unavailable");
  assert.notEqual(record.wire.response.decidedBy?.kind, "user");
});

test("workspace serving: source-only exact deny is served by rule through the workspace alias", () => {
  const record = serve("deny");
  assert.equal(record.bound, true);
  assert.deepEqual(record.wireValues, record.recomputedAliases);
  assert.equal(record.direct.threw, false);
  assert.equal(record.direct.state, "deny", "the actual serving closure preserves the source-only deny");
  assert.equal(record.direct.origin, "project");
  matchedSourceRule(record, "notes.secret");
  assert.equal(record.wire.response.approved, false, "the forwarded deny is not approved");
  assert.equal(record.wire.response.decidedBy?.kind, "rule", "the source deny resolves by rule");
  assert.equal(record.wire.response.decidedBy?.pattern, record.direct.matchedPattern,
    "the wire decision names the source rule the alias reached");
});

test("workspace serving: a request from outside the direct parent fails closed as gate_error", () => {
  const record = serve("wrongParent");
  assert.equal(record.bound, true);
  assert.deepEqual(record.wireValues, record.recomputedAliases);
  assert.equal(record.direct.threw, true);
  assert.match(record.direct.error, /parent mismatch/);
  assert.equal(record.wire.response.approved, false);
  assert.equal(record.wire.response.state, "denied_with_reason");
  assert.equal(record.wire.response.decidedBy?.kind, "gate_error");
  assert.match(record.wire.response.decidedBy?.reason ?? "", /parent mismatch/);
});

test("workspace serving: a released binding fails closed as gate_error", () => {
  const record = serve("released");
  assert.equal(record.bound, true);
  assert.deepEqual(record.wireValues, record.recomputedAliases);
  assert.equal(record.direct.threw, true);
  assert.match(record.direct.error, /released/);
  assert.equal(record.wire.response.approved, false);
  assert.equal(record.wire.response.state, "denied_with_reason");
  assert.equal(record.wire.response.decidedBy?.kind, "gate_error");
  assert.match(record.wire.response.decidedBy?.reason ?? "", /released/);
});

test("workspace serving: a same-length forged alias list fails closed on content, not just length", () => {
  const record = serve("forged");
  assert.equal(record.bound, true);
  assert.ok(record.recomputedAliases.length > 0,
    "honest aliases are non-empty, so a forged list cannot pass a length-only check trivially");
  assert.ok(record.wireValues.length > 0 && record.wireValues.every((value) => value.length > 0),
    "the forged list is non-empty");
  assert.equal(record.wireValues.length, record.recomputedAliases.length,
    "the forged list keeps the honest length: only the content comparison can catch it");
  assert.ok(record.wireValues.every((value, index) => value !== record.recomputedAliases[index]),
    "the forged list differs in content from the honest recomputation");
  assert.equal(record.direct.threw, true);
  assert.match(record.direct.error, /restriction values mismatch/);
  assert.equal(record.wire.response.approved, false);
  assert.equal(record.wire.response.state, "denied_with_reason");
  assert.equal(record.wire.response.decidedBy?.kind, "gate_error");
  assert.match(record.wire.response.decidedBy?.reason ?? "", /restriction values mismatch/);
});

test("workspace serving: a bound child that omits its restriction values fails closed", () => {
  const record = serve("omitted");
  assert.equal(record.bound, true);
  assert.equal(record.wireValues, null, "the wire omitted the restriction values");
  assert.equal(record.direct.threw, true);
  assert.match(record.direct.error, /restriction values mismatch/);
  assert.equal(record.wire.response.approved, false);
  assert.equal(record.wire.response.state, "denied_with_reason");
  assert.equal(record.wire.response.decidedBy?.kind, "gate_error");
  assert.match(record.wire.response.decidedBy?.reason ?? "", /restriction values mismatch/);
});

test("workspace serving: a claim of restriction values without any binding fails closed", () => {
  const record = serve("unboundClaimed");
  assert.equal(record.bound, false);
  assert.equal(record.wireValues.length, 1);
  assert.ok(record.wireValues[0].endsWith("notes.review"), "the claim names a source-style alias");
  assert.equal(record.direct.threw, true);
  assert.match(record.direct.error, /binding is missing/);
  assert.equal(record.wire.response.approved, false);
  assert.equal(record.wire.response.state, "denied_with_reason");
  assert.equal(record.wire.response.decidedBy?.kind, "gate_error");
  assert.match(record.wire.response.decidedBy?.reason ?? "", /binding is missing/);
});

test("workspace serving: an ordinary public workspace request is still served normally", () => {
  const record = serve("unbound");
  assert.equal(record.bound, false, "no workspace binding: ordinary public workspace request");
  assert.equal(record.wireValues, null);
  assert.equal(record.direct.threw, false);
  assert.equal(record.direct.state, "allow",
    "the unaliased worktree path matches no source rule under the real production seed");
  assert.equal(record.wire.response.approved, true, "an unbound child's ordinary allow is served, not blocked");
  assert.equal(record.wire.response.decidedBy?.kind, "rule");
});
