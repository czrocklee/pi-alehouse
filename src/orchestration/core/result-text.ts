import { createHash } from "node:crypto";
import type { Output, ResultRef } from "./contracts.ts";
import { OrchestrationError } from "./ports.ts";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const isId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export const validOutput = (value: unknown): value is Output => {
  if (!value || typeof value !== "object") return false;
  const o = value as Output;
  return (
    typeof o.text === "string" &&
    Number.isSafeInteger(o.total_chars) &&
    o.total_chars >= o.text.length &&
    typeof o.truncated === "boolean" &&
    (o.truncated || o.total_chars === o.text.length) &&
    (o.revision === undefined || (Number.isSafeInteger(o.revision) && o.revision >= 0))
  );
};

export const boundedOutput = (text: string, maxChars: number): Output => {
  let end = Math.max(0, Math.min(text.length, maxChars));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? ""))
    end--;
  return { text: text.slice(0, end), total_chars: text.length, truncated: end < text.length };
};

/** Core-owned prefix buffer. Appending only examines the new chunk plus one
 * withheld high surrogate; no cumulative string is built at token rate.
 * The private joined-string memo is observational only: it changes no retained
 * facts and invokes no ports. RunView/list/stats never request this text. */
export class OutputBuffer implements Output {
  private readonly chunks: string[] = [];
  private retained = 0;
  private observed = 0;
  private pendingHigh = "";
  private closed = false;
  private joined: string | undefined = "";

  constructor(
    private readonly cap: number,
    readonly revision: number,
  ) {
    if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(revision) || revision < 0)
      throw new OrchestrationError("INVALID_OUTPUT_DELTA");
  }
  append(delta: string): void {
    if (typeof delta !== "string" || !Number.isSafeInteger(this.observed + delta.length))
      throw new OrchestrationError("INVALID_OUTPUT_DELTA");
    this.observed += delta.length;
    if (this.closed || !delta.length) return;
    const chunk = this.pendingHigh + delta;
    const last = chunk.charCodeAt(chunk.length - 1);
    this.pendingHigh = last >= 0xd800 && last <= 0xdbff ? chunk.slice(-1) : "";
    const bounded = boundedOutput(
      chunk.slice(0, chunk.length - this.pendingHigh.length),
      this.cap - this.retained,
    );
    if (bounded.text.length) {
      this.chunks.push(bounded.text);
      this.retained += bounded.text.length;
      this.joined = undefined;
    }
    this.closed = bounded.truncated;
    if (this.closed) this.pendingHigh = "";
  }
  get text(): string {
    if (this.joined === undefined) {
      const text = this.chunks.join("");
      // Retain only the materialized prefix, not that string plus every old
      // chunk. Later appends extend this one prefix without duplicating it.
      this.chunks.length = 0;
      this.chunks.push(text);
      this.joined = text;
    }
    return this.joined;
  }
  get total_chars(): number {
    return this.observed;
  }
  get truncated(): boolean {
    return this.retained < this.observed;
  }
  snapshot(): Output {
    return {
      text: this.text,
      total_chars: this.observed,
      truncated: this.truncated,
      revision: this.revision,
    };
  }
}

/** Bounded text metadata for the SDK reader/cursor, not another stored result. */
export function describeResult(run_id: string, output: Output): ResultRef {
  if (!isId(run_id) || !validOutput(output)) throw new OrchestrationError("INVALID_RESULT");
  return {
    scope: "owner_memory",
    run_id,
    digest: sha256(output.text),
    chars: output.text.length,
    total_chars: output.total_chars,
    truncated: output.truncated,
  };
}
