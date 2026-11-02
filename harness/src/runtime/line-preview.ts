import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { graphemes, previewText } from "../ui/text.ts";

type PreviewEvent = Extract<AssistantMessageEvent, { type:
  "thinking_start" | "thinking_delta" | "thinking_end" | "text_start" | "text_delta" | "text_end" }>;

/** Bound storage independently from terminal width, without splitting clusters. */
export function boundedPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let head = "";
  for (const { segment } of graphemes.segment(text)) {
    if (head.length + segment.length > limit) break;
    head += segment;
  }
  return `${head}…`;
}

const PREVIEW_LIMIT = 1024;
// eslint-disable-next-line no-control-regex -- terminal string-protocol introducers, including C1 spellings
const PROTOCOL_INTRODUCER = /[\u001b\u0090\u0098\u009d\u009e\u009f]/;
/** Two bounded logical lines cover an empty tail without storing a transcript.
 * A channel owns its block index so a new block cannot revive an older one. */
export class LinePreview {
  private current = "";
  private previous = "";
  private capped = false;
  private needsCumulative = false;
  private contentIndex?: number;

  clear(): void {
    this.current = "";
    this.previous = "";
    this.capped = false;
    this.needsCumulative = false;
    this.contentIndex = undefined;
  }

  replace(text: string): void {
    // Strip protocols BEFORE finding lines: even an unfinished OSC/APC payload
    // can contain newlines that must never become visible preview content.
    this.needsCumulative ||= PROTOCOL_INTRODUCER.test(text);
    const lines = previewText(text).split("\n");
    const current = (lines.pop() ?? "").trimStart();
    this.current = boundedPreview(current, PREVIEW_LIMIT);
    this.capped = this.current !== current;
    this.previous = boundedPreview(lines.findLast((line) => line.trim())?.trimStart() ?? "", PREVIEW_LIMIT);
  }

  append(delta: string, cumulative?: string): void {
    // Ordinary prose costs O(delta), not O(the complete growing response).
    // Once ESC appears, only cumulative sanitization can safely handle a
    // protocol split across chunks. Do not retain that full public text here.
    this.needsCumulative ||= PROTOCOL_INTRODUCER.test(delta);
    if (this.needsCumulative) {
      if (cumulative !== undefined) this.replace(cumulative);
      else { this.current = ""; this.previous = ""; }
      return;
    }
    for (const [index, line] of previewText(delta).split("\n").entries()) {
      if (index > 0) {
        if (this.current.trim()) this.previous = this.current;
        this.current = "";
        this.capped = false;
      }
      if (!this.capped) {
        const candidate = (this.current + line).trimStart();
        this.current = boundedPreview(candidate, PREVIEW_LIMIT);
        this.capped = this.current !== candidate;
      }
    }
  }

  update(event: PreviewEvent): void {
    if (this.contentIndex !== event.contentIndex || event.type === "thinking_start" || event.type === "text_start") {
      this.clear();
      this.contentIndex = event.contentIndex;
    }
    const block = event.partial.content[event.contentIndex];
    if (block?.type === "thinking" && block.redacted) { this.clear(); return; }
    if (event.type === "thinking_end" || event.type === "text_end") this.replace(event.content);
    else if (event.type === "thinking_delta" || event.type === "text_delta") {
      const cumulative = block?.type === "thinking" ? block.thinking : block?.type === "text" ? block.text : undefined;
      this.append(event.delta, cumulative);
    }
  }

  value(): string {
    const line = this.current.trim() ? this.current : this.previous;
    // A streamed delta may end halfway through a surrogate pair. Keep the high
    // half internally to join the next delta, but never paint it unfinished.
    const last = line.charCodeAt(line.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? line.slice(0, -1) : line;
  }
}
