import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

import { copyDisplayData, DISPLAY_MARKERS, ownDisplayValue } from "../presentation/display-data.ts";

type DisplayResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type DisplayBlock = DisplayResult["content"][number];
const INSPECTIONS = 20_000;
const EXHAUSTED = Symbol("display inspection budget");
const marker = (text: string): DisplayBlock => ({ type: "text", text });
const malformedBlock = (value: unknown): DisplayBlock =>
  marker(
    typeof value === "string"
      ? value
      : typeof value === "function"
        ? DISPLAY_MARKERS.callable
        : DISPLAY_MARKERS.malformed,
  );

/** Select visual fields before copying: neither extra keys nor SDK metadata
 * (including legal textSignature) are inspected or charged to the body budget.
 * Each entry/selected-field descriptor read is budgeted; strings are literal
 * leaves, not character-limited. The new blocks are detached by construction.
 * This bounds inspections, not CPU/RSS inside an individual Proxy trap. */
function displayContent(message: object): DisplayResult["content"] {
  let remaining = INSPECTIONS;
  const read = (source: object, key: PropertyKey): unknown => {
    if (remaining <= 0) return EXHAUSTED;
    remaining--;
    return ownDisplayValue(source, key);
  };
  const projectBlock = (block: unknown): DisplayBlock | typeof EXHAUSTED => {
    if (block === EXHAUSTED) return EXHAUSTED;
    if (block === null || typeof block !== "object") return malformedBlock(block);
    const type = read(block, "type");
    if (type === EXHAUSTED) return EXHAUSTED;
    if (type === "text") {
      const text = read(block, "text");
      if (text === EXHAUSTED) return EXHAUSTED;
      return typeof text === "string" ? { type, text } : marker(DISPLAY_MARKERS.malformed);
    }
    if (type === "image") {
      const data = read(block, "data");
      if (data === EXHAUSTED) return EXHAUSTED;
      const mimeType = read(block, "mimeType");
      if (mimeType === EXHAUSTED) return EXHAUSTED;
      return typeof data === "string" && typeof mimeType === "string"
        ? { type, data, mimeType }
        : marker(DISPLAY_MARKERS.malformed);
    }
    return marker(DISPLAY_MARKERS.malformed);
  };
  const source = read(message, "content");
  // Array.isArray can throw for a revoked Proxy; no source enumeration is needed.
  try {
    if (!Array.isArray(source)) return source === undefined ? [] : [malformedBlock(source)];
  } catch {
    return [marker(DISPLAY_MARKERS.malformed)];
  }
  const length = read(source, "length");
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 0xffff_ffff
  ) {
    return [marker(DISPLAY_MARKERS.malformed)];
  }
  const content: DisplayResult["content"] = [];
  for (let i = 0; i < length; i++) {
    const block = projectBlock(read(source, i));
    if (block === EXHAUSTED) {
      content.push(marker(DISPLAY_MARKERS.elided));
      break;
    }
    content.push(block);
  }
  return content;
}

/** Result callbacks receive their own mutable envelope, never the persisted
 * message's content or details. Separate budgets keep large details from
 * consuming the text body's allowance. Only SDK result-display fields cross
 * this boundary; no message metadata or executable capability is forwarded. */
export function detachedToolResult(message: object): DisplayResult {
  const content = displayContent(message);
  const duration = ownDisplayValue(message, "durationMs");
  return {
    content,
    details: copyDisplayData(ownDisplayValue(message, "details")),
    isError: ownDisplayValue(message, "isError") === true,
    ...(typeof duration === "number" && Number.isFinite(duration) ? { durationMs: duration } : {}),
  };
}
