// Pure Jev answer fixtures. No Pi, jiti, network, or credential access.
import { createHash } from "node:crypto";
export const allowAnswers = (taskScope = 0.95) => ({
  task_scope: { noul: taskScope },
  read_only: { noul: 0.95 },
  reversible: { noul: 0.95 },
  remote_mutation: { noul: 0.01 },
  credential_exposure: { noul: 0.01 },
  injection: { noul: 0.01 },
  constraint_conflict: { noul: 0.01 },
  policy_evasion: { noul: 0.01 },
  unbounded_target: { noul: 0.01 },
  risk: { score: 0, confidence: 0.99 },
});

export const wireAnswers = (answers) =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [
      id,
      id === "risk"
        ? { type: "score", score: answer.score, confidence: answer.confidence }
        : { type: "noul", noul: answer.noul },
    ]),
  );

export const mockResponse = (answers) =>
  new Response(
    JSON.stringify({
      answers: wireAnswers(answers),
      usage: { input_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

export const hashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
