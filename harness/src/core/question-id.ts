import { createHash } from "node:crypto";

export type QuestionId = `q_${string}`;
export const QUESTION_ID_PATTERN = "^q_[0-9a-f]{32}$";

/** Derived identity only: no registry, reservation state, or permission grant. */
export function questionId(owner_id: string, generation: string, original_run_id: string): QuestionId {
  const preimage = JSON.stringify(["pi-alehouse/question/v1", owner_id, generation, original_run_id]);
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  return `q_${digest.subarray(0, 16).toString("hex")}`;
}

export function isQuestionId(value: unknown): value is QuestionId {
  return typeof value === "string" && value.length === 34 && /^q_[0-9a-f]{32}$/.test(value);
}
