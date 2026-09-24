import { createHash } from "node:crypto";
import type { Output, ResultRef } from "./contracts.js";
import { HarnessError } from "./ports.js";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const isId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export const validOutput = (value: unknown): value is Output => {
  if (!value || typeof value !== "object") return false;
  const o = value as Output;
  return typeof o.text === "string" && Number.isSafeInteger(o.total_chars) && o.total_chars >= o.text.length &&
    typeof o.truncated === "boolean" && (o.truncated || o.total_chars === o.text.length) &&
    (o.revision === undefined || (Number.isSafeInteger(o.revision) && o.revision >= 0));
};

export const boundedOutput = (text: string, maxChars: number): Output => {
  let end = Math.max(0, Math.min(text.length, maxChars));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return { text: text.slice(0, end), total_chars: text.length, truncated: end < text.length };
};

/** Bounded text metadata for the SDK reader/cursor, not another stored result. */
export function describeResult(run_id: string, output: Output): ResultRef {
  if (!isId(run_id) || !validOutput(output)) throw new HarnessError("INVALID_RESULT");
  return { scope: "owner_memory", run_id, digest: sha256(output.text), chars: output.text.length,
    total_chars: output.total_chars, truncated: output.truncated };
}
