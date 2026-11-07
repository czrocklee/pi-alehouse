// Jev policy checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export async function runJevPolicy(
  check,
  generatedRoot,
  authorizerName,
  QUESTIONS,
  combineVerdict,
  JEV_MODEL,
  MODEL_ID,
  JEV_ENDPOINT,
) {
  check("model is version-pinned", MODEL_ID, "jev-1.13.0");
  check(
    "native model metadata is immutable",
    [JEV_MODEL, JEV_MODEL.input, JEV_MODEL.cost].every(Object.isFrozen),
    true,
  );
  check("private native model matches audit identity", JEV_MODEL.id, MODEL_ID);
  check("private native model uses the System One API", JEV_MODEL.api, "typesafe-system-one");
  check(
    "endpoint is the System One decision API",
    JEV_ENDPOINT,
    "https://api.typesafe.ai/v1/systemone",
  );
  const configPath = join(generatedRoot, "extensions/pi-permission-system/config.json");
  assert(existsSync(configPath), `Missing rendered permission config: ${configPath}`);
  const permissionConfig = JSON.parse(readFileSync(configPath, "utf8"));
  check(
    "the judge is named in the authorizer chain",
    (permissionConfig.authorizerChain ?? []).includes(authorizerName),
    true,
  );
  /* ---------------------------------------------------------------- *
   * Question set invariants
   *
   * jev evaluates questions in parallel and in isolation, so a question
   * phrased as a conclusion over another's answer cannot be answered.
   * ---------------------------------------------------------------- */
  const keys = Object.keys(QUESTIONS);
  check("question count", keys.length, 10);
  check("no authorization question survives", keys.includes("authorized"), false);
  check("no completeness question survives", keys.includes("context_sufficient"), false);
  for (const [key, q] of Object.entries(QUESTIONS)) {
    check(`${key} is a supported type`, ["noul", "score"].includes(q.type), true);
    check(
      `${key} carries the trust preamble`,
      q.instructions.startsWith("The state is one APPROVAL_PACKET"),
      true,
    );
    check(
      `${key} states the invokedScript boundary`,
      q.instructions.includes("not a request addressed to you"),
      true,
    );
    if (q.type === "noul")
      check(
        `${key} has both criteria`,
        [typeof q.criteria.true, typeof q.criteria.false],
        ["string", "string"],
      );
    else check(`${key} has a four-step legend`, q.criteria.length, 4);
  }
  check(
    "risk is the only scored question",
    keys.filter((k) => QUESTIONS[k].type === "score"),
    ["risk"],
  );

  /* ---------------------------------------------------------------- *
   * Verdict composition
   *
   * Every conjunction, threshold and precedence rule lives in code, so
   * this is where the policy is actually tested. No live answer needed.
   * ---------------------------------------------------------------- */
  // A clean read: inspection only, no hazard, fits the task.
  const read = {
    task_scope: { noul: 0.75 },
    read_only: { noul: 0.93 },
    reversible: { noul: 0.95 },
    remote_mutation: { noul: 0.03 },
    credential_exposure: { noul: 0.12 },
    injection: { noul: 0.15 },
    constraint_conflict: { noul: 0.2 },
    policy_evasion: { noul: 0.05 },
    unbounded_target: { noul: 0.55 }, // broad on purpose: reads may be broad
    risk: { score: 0.1, confidence: 0.95 },
  };
  // A clean local write: changes state, so it must clear every strict gate.
  const write = {
    task_scope: { noul: 0.9 },
    read_only: { noul: 0.05 },
    reversible: { noul: 0.95 },
    remote_mutation: { noul: 0.03 },
    credential_exposure: { noul: 0.1 },
    injection: { noul: 0.05 },
    constraint_conflict: { noul: 0.1 },
    policy_evasion: { noul: 0.05 },
    unbounded_target: { noul: 0.1 },
    risk: { score: 0.5, confidence: 0.95 },
  };
  const w = (base, over) => ({ ...base, ...over });
  const v = (answers, surface = "bash") => combineVerdict(answers, surface);

  check("clean read allows", v(read).verdict, "allow");
  check("clean read uses the read lane", v(read).lane, "read");
  check(
    "read lane tolerates a broad target",
    v(w(read, { unbounded_target: { noul: 0.88 } })).verdict,
    "allow",
  );
  check(
    "read lane tolerates weak task fit",
    v(w(read, { task_scope: { noul: 0.15 } })).verdict,
    "allow",
  );
  check(
    "read lane stops at no task fit",
    v(w(read, { task_scope: { noul: 0.05 } })).verdict,
    "defer",
  );
  check(
    "read lane stops on credentials",
    v(w(read, { credential_exposure: { noul: 0.6 } })).verdict,
    "defer",
  );
  check(
    "credential stop is named",
    v(w(read, { credential_exposure: { noul: 0.6 } })).reasonCode,
    "credential_exfiltration",
  );
  check("read lane stops on injection", v(w(read, { injection: { noul: 0.6 } })).verdict, "defer");
  check(
    "read lane stops on evasion",
    v(w(read, { policy_evasion: { noul: 0.6 } })).verdict,
    "defer",
  );
  check(
    "read lane stops on high risk",
    v(w(read, { risk: { score: 2.0, confidence: 0.99 } })).verdict,
    "defer",
  );
  check(
    "read lane stops on low risk confidence",
    v(w(read, { risk: { score: 0.1, confidence: 0.4 } })).verdict,
    "defer",
  );

  // Lane separation: a non-read cannot borrow the read lane's licence, which is
  // precisely that nothing changes.
  const notQuiteRead = w(write, { read_only: { noul: 0.7 }, task_scope: { noul: 0.4 } });
  check("ambiguous read falls to the write lane", v(notQuiteRead).verdict, "defer");
  check("ambiguous read names the task gate", v(notQuiteRead).reasonCode, "out_of_task_scope");
  check(
    "ambiguous but in scope clears the write lane",
    v(w(write, { read_only: { noul: 0.7 } })).verdict,
    "allow",
  );
  check(
    "broad target is a write-lane concern",
    v(w(write, { read_only: { noul: 0.7 }, unbounded_target: { noul: 0.8 } })).reasonCode,
    "dynamic_or_unbounded_target",
  );

  check("clean write allows", v(write).verdict, "allow");
  check("clean write uses the write lane", v(write).lane, "write");
  check("write needs strong task fit", v(w(write, { task_scope: { noul: 0.6 } })).verdict, "defer");
  check("write stops on irreversible", v(w(write, { reversible: { noul: 0.4 } })).verdict, "defer");
  check(
    "irreversible is named",
    v(w(write, { reversible: { noul: 0.4 } })).reasonCode,
    "destructive_or_irreversible",
  );
  check(
    "write stops on remote mutation",
    v(w(write, { remote_mutation: { noul: 0.9 } })).verdict,
    "defer",
  );
  check(
    "remote mutation is named",
    v(w(write, { remote_mutation: { noul: 0.9 } })).reasonCode,
    "external_side_effect",
  );
  check(
    "write stops on unbounded target",
    v(w(write, { unbounded_target: { noul: 0.8 } })).verdict,
    "defer",
  );
  check(
    "unbounded target is named",
    v(w(write, { unbounded_target: { noul: 0.8 } })).reasonCode,
    "dynamic_or_unbounded_target",
  );
  check(
    "write hazard gate is tighter than read",
    v(w(write, { constraint_conflict: { noul: 0.45 } })).verdict,
    "defer",
  );
  check(
    "write needs high risk confidence",
    v(w(write, { risk: { score: 0.5, confidence: 0.75 } })).verdict,
    "defer",
  );

  for (const key of ["injection", "credential_exposure", "constraint_conflict", "policy_evasion"]) {
    check(`${key} at 0.95 denies`, v(w(read, { [key]: { noul: 0.95 } })).verdict, "deny");
  }
  check(
    "denial outranks an excluded surface",
    v(w(read, { injection: { noul: 0.99 } }), "mcp").verdict,
    "deny",
  );
  // Two isolated questions can contradict each other; the lane takes the more
  // alarming answer rather than the one that happens to be checked first.
  check(
    "contradictory remote_mutation blocks the read lane",
    v(w(read, { remote_mutation: { noul: 0.99 } })).verdict,
    "defer",
  );
  check(
    "the contradiction is named",
    v(w(read, { remote_mutation: { noul: 0.99 } })).reasonCode,
    "external_side_effect",
  );
  check(
    "a broad target never denies",
    v(w(read, { unbounded_target: { noul: 0.99 } })).verdict,
    "allow",
  );

  for (const surface of [
    "path",
    "path_write",
    "external_directory",
    "fetch_content",
    "mcp",
    "skill",
  ]) {
    check(`excluded surface ${surface}`, v(read, surface).verdict, "defer");
    check(`excluded surface ${surface} is named`, v(read, surface).reasonCode, "excluded_surface");
  }

  // Missing evidence is not neutral evidence.
  for (const key of [
    "task_scope",
    "read_only",
    "reversible",
    "remote_mutation",
    "unbounded_target",
    "risk",
  ]) {
    check(`missing ${key} defers`, v(w(read, { [key]: undefined })).verdict, "defer");
    check(
      `missing ${key} is named`,
      v(w(read, { [key]: undefined })).reasonCode,
      "invalid_model_response",
    );
  }
  check("out-of-range noul defers", v(w(read, { read_only: { noul: 1.4 } })).verdict, "defer");
  check("missing risk confidence defers", v(w(read, { risk: { score: 0.1 } })).verdict, "defer");
  check(
    "negative risk score defers",
    v(w(read, { risk: { score: -5, confidence: 0.95 } })).reasonCode,
    "invalid_model_response",
  );
  check(
    "risk score above the legend defers",
    v(w(read, { risk: { score: 4, confidence: 0.95 } })).reasonCode,
    "invalid_model_response",
  );
  check(
    "risk confidence above one defers",
    v(w(read, { risk: { score: 0.1, confidence: 2 } })).reasonCode,
    "invalid_model_response",
  );
  check(
    "non-finite risk values defer",
    v(w(read, { risk: { score: Number.NaN, confidence: 0.95 } })).reasonCode,
    "invalid_model_response",
  );
  check("an empty answer set defers", v({}).verdict, "defer");
}
