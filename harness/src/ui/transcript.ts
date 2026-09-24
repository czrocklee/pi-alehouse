/**
 * A child's conversation through Pi's own message components, so it reads like
 * the main one. The SDK/TUI half of the detail pane: `agent-detail.ts` stays pure and
 * reaches this only through `TranscriptRows`.
 *
 * One gap that is not ours to close: Pi's built-in tool renderers live behind a
 * path its `exports` map does not expose, and a built-in definition carries
 * none of its own, so `read`/`bash`/`edit` fall back to plain text.
 */

import { AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent, parseSkillBlock, SkillInvocationMessageComponent,
  ToolExecutionComponent, UserMessageComponent, type sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { paneRow, type TranscriptRows } from "./format.js";

/** Where a child's messages come from. Structural, so the pane never holds a session. */
export interface TranscriptSource {
  /** Settled history, oldest first. */
  messages(): readonly unknown[];
  /** The assistant message being streamed right now, or undefined. */
  inFlight(): unknown;
  /** The child's registered definition for a tool, for custom renderers. */
  toolDefinition(name: string): unknown;
}
export interface TranscriptOptions {
  tui: TUI;
  cwd: string;
  markdownTheme: MarkdownTheme;
  source: TranscriptSource;
}

/** One settled message's components plus its rows at the current width. */
interface Block { readonly container: Container; rows: readonly string[] | undefined }
/** A tool call awaiting its result, and the block whose rows it will invalidate. */
interface Pending { readonly component: ToolExecutionComponent; readonly block: Block }

// Keep the source opaque; only project the role-specific public SDK shape at
// the rendering boundary. Malformed settled entries still use consume()'s
// per-message failure isolation, rather than leaking any through the pane.
type Msg = ReturnType<typeof sessionEntryToContextMessages>[number];
type MessageOf<Role extends Msg["role"]> = Extract<Msg, { role: Role }>;
const role = (message: unknown): unknown =>
  message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;

/**
 * A child's transcript as renderable rows.
 *
 * Settled history renders once per width and per content change, so a paint or a
 * scroll costs a slice rather than a walk of the whole component tree. Held as
 * one block per message: a message that settles appends a block and a tool
 * result touches only its own, so neither discards the rest of the rendering.
 *
 * The streaming message is a separate component updated in place, exactly as
 * Pi's interactive mode does, so a token never invalidates settled history.
 */
export class TranscriptContent implements TranscriptRows {
  private blocks: Block[] = [];
  private consumed = 0;
  private lastConsumed: unknown;
  /** Whether anything above a user message was rendered, driving its spacer. */
  private visible = false;
  private readonly pending = new Map<string, Pending>();
  private width: number | undefined;
  private rows: readonly string[] | undefined;
  private inFlight: AssistantMessageComponent | undefined;
  private inFlightWidth: number | undefined;
  private inFlightRows: readonly string[] | undefined;

  constructor(private readonly options: TranscriptOptions) {}

  lineCount(width: number): number {
    if (width <= 0) return 0;
    return this.settled(width).length + this.tail(width).length;
  }

  slice(width: number, start: number, count: number): string[] {
    if (width <= 0) return [];
    const settled = this.settled(width);
    const end = start + count;
    const out = settled.slice(start, Math.min(end, settled.length));
    if (end > settled.length) {
      const tail = this.tail(width);
      out.push(...tail.slice(Math.max(0, start - settled.length), end - settled.length));
    }
    return out;
  }

  /** Drop every cached row, in this object and in the mounted components. */
  invalidate(): void {
    for (const block of this.blocks) { block.container.invalidate(); block.rows = undefined; }
    this.rows = undefined;
    this.inFlight?.invalidate();
    this.inFlightRows = undefined;
  }

  dispose(): void {
    this.blocks = [];
    this.pending.clear();
    this.rows = undefined;
    this.inFlight = undefined;
    this.inFlightRows = undefined;
  }

  // ---- Private ----

  private settled(width: number): readonly string[] {
    this.consume();
    if (this.width !== width) {
      this.width = width;
      for (const block of this.blocks) block.rows = undefined;
      this.rows = undefined;
    }
    if (this.rows) return this.rows;
    const out: string[] = [];
    for (const block of this.blocks) {
      block.rows ??= block.container.render(width).map((line) => paneRow(line, width));
      // Appended one at a time: a spread passes every row as an argument, and a
      // single huge tool output is enough to exceed the engine's argument limit
      // and take the pane down with a RangeError.
      for (const row of block.rows) out.push(row);
    }
    this.rows = out;
    return out;
  }

  /** The streaming message, re-rendered independently of settled history. */
  private tail(width: number): readonly string[] {
    const streaming = this.options.source.inFlight();
    if (!streaming || role(streaming) !== "assistant") {
      this.inFlight = undefined;
      this.inFlightRows = undefined;
      return [];
    }
    // Construct empty and fill as streaming, the way Pi builds its own: handing
    // the message to the constructor renders it through the settled path for one
    // frame, so an unclosed fence flashes as finished markdown before the
    // streaming transform catches up.
    this.inFlight ??= new AssistantMessageComponent(undefined, false, this.options.markdownTheme);
    this.inFlight.updateContent(streaming as MessageOf<"assistant">, true);
    if (this.inFlightWidth !== width) { this.inFlightWidth = width; this.inFlightRows = undefined; }
    // Streaming changes every frame, so its rows are never worth caching across
    // one; the width check exists only to keep the two caches in step.
    this.inFlightRows = this.inFlight.render(width).map((line) => paneRow(line, width));
    return this.inFlightRows;
  }

  /**
   * Append blocks for everything that settled since the last check. When the
   * consumed prefix no longer mirrors the source — history rewritten by a
   * compaction or a branch — start over rather than appending onto stale blocks.
   */
  private consume(): void {
    const messages = this.options.source.messages();
    const rewritten = messages.length < this.consumed ||
      (this.consumed > 0 && messages[this.consumed - 1] !== this.lastConsumed);
    if (rewritten) {
      this.blocks = [];
      this.consumed = 0;
      this.lastConsumed = undefined;
      this.visible = false;
      this.pending.clear();
      this.rows = undefined;
    }
    if (messages.length === this.consumed) return;
    for (let i = this.consumed; i < messages.length; i++) {
      // Pi's own components assume well-formed messages -- array content, a
      // summary that knows its token count -- and throw on anything else. These
      // entries are a CHILD's, read while it may still be writing them, so one
      // that cannot be rendered is skipped rather than allowed to take down the
      // parent's UI. It is skipped permanently: `consumed` advances either way,
      // or the same throw would return on every frame.
      try { this.consumeOne(messages[i]); } catch { /* one block short, not one pane */ }
    }
    this.consumed = messages.length;
    this.lastConsumed = messages.at(-1);
    this.rows = undefined;
  }

  private consumeOne(message: unknown): void {
    const theme = this.options.markdownTheme;
    const msg = message as Msg;
    switch (role(message)) {
      case "assistant": return this.consumeAssistant(msg as MessageOf<"assistant">);
      case "toolResult": return this.consumeToolResult(msg as MessageOf<"toolResult">);
      case "user": return this.consumeUser(msg as MessageOf<"user">);
      case "bashExecution": return this.consumeBash(msg as MessageOf<"bashExecution">);
      case "compactionSummary": return this.consumeSummary(new CompactionSummaryMessageComponent(msg as MessageOf<"compactionSummary">, theme));
      case "branchSummary": return this.consumeSummary(new BranchSummaryMessageComponent(msg as MessageOf<"branchSummary">, theme));
      // A `custom` message needs the child's message-renderer registry, which
      // this pane does not hold, so it contributes no block rather than a guess.
      default: return;
    }
  }

  /**
   * A message that stopped mid-tool-call will never produce results, and Pi's
   * own assistant component prints nothing for `aborted` or `error` when the
   * message carries tool calls -- it expects the cards to say it. So a card
   * left pending here would spin for the life of the pane AND swallow the only
   * report of the failure. Finalize it the way Pi does instead. Children run
   * with retry disabled, so there is no attempt count to put in the wording.
   */
  private static failureText(message: MessageOf<"assistant">): string | undefined {
    if (message.stopReason === "aborted") return "Operation aborted";
    if (message.stopReason !== "error") return undefined;
    return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "Error";
  }

  private consumeAssistant(message: MessageOf<"assistant">): void {
    const block = this.append();
    block.container.addChild(new AssistantMessageComponent(message, false, this.options.markdownTheme));
    const failure = TranscriptContent.failureText(message);
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content?.type !== "toolCall") continue;
      const tool = new ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false },
        this.options.source.toolDefinition(content.name) as ConstructorParameters<typeof ToolExecutionComponent>[4], this.options.tui, this.options.cwd);
      tool.setExpanded(true);
      block.container.addChild(tool);
      // Only a call that can still be answered stays pending; the rest are done.
      if (failure === undefined) this.pending.set(content.id, { component: tool, block });
      else tool.updateResult({ content: [{ type: "text", text: failure }], isError: true });
    }
    this.visible = true;
  }

  /** A result mutates the block holding its call; no other block changes. */
  private consumeToolResult(message: MessageOf<"toolResult">): void {
    const pending = this.pending.get(message.toolCallId);
    if (!pending) return;
    pending.component.updateResult(message);
    pending.block.rows = undefined;
    this.rows = undefined;
    this.pending.delete(message.toolCallId);
  }

  private consumeUser(message: MessageOf<"user">): void {
    const content = message.content;
    const text = typeof content === "string" ? content :
      (Array.isArray(content) ? content : []).filter((part) => part?.type === "text")
        .map((part) => part.text ?? "").join("");
    if (!text) return;
    const block = this.append();
    // Whether a leading spacer is needed is a whole-transcript property, so it
    // is decided here, where what precedes this block is known.
    if (this.visible) block.container.addChild(new Spacer(1));
    const skill = parseSkillBlock(text);
    if (!skill) {
      block.container.addChild(new UserMessageComponent(text, this.options.markdownTheme));
    } else {
      const invocation = new SkillInvocationMessageComponent(skill, this.options.markdownTheme);
      invocation.setExpanded(true);
      block.container.addChild(invocation);
      if (skill.userMessage) {
        block.container.addChild(new Spacer(1));
        block.container.addChild(new UserMessageComponent(skill.userMessage, this.options.markdownTheme));
      }
    }
    this.visible = true;
  }

  private consumeBash(message: MessageOf<"bashExecution">): void {
    const block = this.append();
    const bash = new BashExecutionComponent(message.command, this.options.tui, message.excludeFromContext);
    if (message.output) bash.appendOutput(message.output);
    bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
    block.container.addChild(bash);
    this.visible = true;
  }

  private consumeSummary(summary: CompactionSummaryMessageComponent | BranchSummaryMessageComponent): void {
    const block = this.append();
    block.container.addChild(new Spacer(1));
    summary.setExpanded(true);
    block.container.addChild(summary);
    this.visible = true;
  }

  private append(): Block {
    const block: Block = { container: new Container(), rows: undefined };
    this.blocks.push(block);
    return block;
  }
}
