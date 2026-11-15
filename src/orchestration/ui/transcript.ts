/**
 * A child's conversation through Pi's own message components, so it reads like
 * the main one. The SDK/TUI half of the detail pane: `agent-detail.ts` stays pure and
 * reaches this only through `TranscriptRows`.
 *
 * Tool presentation comes from the child's public renderer registry, including
 * native renderers carried by its built-in definitions. The UI receives only
 * display callbacks, not executable definitions or the child session. Missing
 * or retired tool renderers fall back to literal transcript data through the
 * SDK's own bounded generic card, since its definition-less dump prints full
 * arguments regardless of `expanded`. Rendering never interprets a record as
 * a current tool or hydrates alerts or questions.
 *
 * The pane's own presentation choices, none of which interpret a record:
 * tool cards default collapsed (active/incomplete and failed ones stay
 * expanded, and `setToolsExpanded()` is a presentation-only toggle);
 * `alert_parent`/`ask_parent` calls with exactly their one recorded string
 * argument get an Input-style message block with a right-aligned title and a
 * separate receipt instead of raw JSON; user messages carry neutral labels,
 * with the human steering lead shown only as the
 * qualified label it itself declares.
 */

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  UserMessageComponent,
  type ToolRenderers,
  type sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { COMMUNICATION_LIMITS } from "../core/communication-envelope.ts";
import { humanSteerLead } from "../presentation/human-steer-text.ts";
import { copyDisplayData } from "../presentation/display-data.ts";
import { toolArgumentText } from "../presentation/tool-argument-text.ts";
import { blockedDelegationToolNames } from "../tools/tool-names.ts";
import { paneRow, type TranscriptFrame, type TranscriptRows } from "./format.ts";
import { plainText } from "./text.ts";
import { CommunicationBubble } from "./communication-bubble.ts";
import { detachedToolResult } from "./tool-result-projection.ts";
import { TranscriptToolCard } from "./transcript-tool-card.ts";

/** Where a child's messages come from. Structural, so the pane never holds a session. */
export interface TranscriptSource {
  /** Settled history, oldest first. */
  messages(): readonly unknown[];
  /** The assistant message being streamed right now, or undefined. */
  inFlight(): unknown;
  /** The child's renderer-only projection, never its executable definition. */
  toolDefinition(name: string): ToolRenderers | undefined;
  /** Synchronous identity, stable until a real binding change (not per-read
   * allocation or stream updates). Thrown reads suspend custom renderers and
   * use raw cards until a successful read starts a new display epoch. */
  toolRenderersRevision?(): unknown;
}
export interface TranscriptOptions {
  tui: TUI;
  cwd: string;
  markdownTheme: MarkdownTheme;
  source: TranscriptSource;
}

/** One settled message's components plus its rows at the current width. */
interface Block {
  readonly container: Container;
  rows: readonly string[] | undefined;
}
/** One tool card this pane created, with the state that drives its expansion.
 * The SDK component keeps `expanded` private, so the pane tracks the value it
 * applied; nothing else can flip it, because the pane is a projection that
 * never routes mouse events into these components. */
interface ToolEntry {
  readonly component: TranscriptToolCard;
  readonly block: Block;
  expanded: boolean;
  /** A result (or the assistant's own failure) has been applied to the card. */
  settled: boolean;
  error: boolean;
}

/** Settled block geometry for the anchor index: the retained blocks with
 * their cumulative start/end rows and a block→index map. Immutable once
 * built; held frames keep their own snapshot. */
interface BlockLayout {
  readonly blocks: readonly Block[];
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly byBlock: ReadonlyMap<Block, number>;
  readonly total: number;
}

/** A captured read anchor: the actual retained block object (or streaming
 * component) plus the row's offset inside it, so resolving after a
 * presentation-only change finds the same message again. Opaque to callers;
 * only the pane's own block/component identities make it valid. */
interface ReadAnchor {
  readonly kind: "block" | "inFlight";
  readonly offset: number;
  readonly target: Block | AssistantMessageComponent;
}

/** The two current child-to-parent communication tools, and the single string
 * argument each records. Only these exact current tools get the labeled
 * display; retired names like `notify_parent` keep the generic raw rendering. */
const COMMUNICATION_DISPLAY = {
  alert_parent: { label: "Alert to parent", key: "message" },
  ask_parent: { label: "Question to parent", key: "question" },
} as const;

/** The SDK bounds a card's arguments and output only through its
 * definition-present fallback; handed no definition at all, it dumps full raw
 * JSON whatever `expanded` says. An empty renderers object selects that
 * bounded fallback (title, argument preview, result preview) without
 * customizing anything, so unknown tools stay literal raw data — collapsed to
 * a preview until expanded. */
const RAW_RENDERERS: ToolRenderers = {};
/** Failed reads are not a legitimate missing/undefined binding. Keep a stable
 * raw-only epoch so records stay visible and recovery always replays them. */
const UNAVAILABLE_RENDERER_BINDING = Symbol("unavailable renderer binding");
interface RendererBinding {
  readonly value: unknown;
}

/** Detached display arguments, not execution arguments. Escape controls and
 * backslashes without deleting protocol payloads or normalizing code whitespace.
 * The shared copier bounds inspected structure (including hidden properties),
 * marks non-data/repeated nodes, and refuses ambiguous transformed keys instead
 * of replacing an earlier field. Semantic matching still uses the original
 * recorded name, arguments and call ID; history is never rewritten. */
function sanitizedToolProjection(name: string, args: unknown): { name: string; args: unknown } {
  return {
    name: toolArgumentText(name),
    args: copyDisplayData(args, { text: toolArgumentText }),
  };
}

/** A read-only message block for a well-formed `alert_parent`/`ask_parent`
 * call: Input-style background, a right-aligned neutral title, then the
 * recorded result outside that background. Malformed arguments and retired
 * names stay raw; other tools keep their normal renderer selection. The block
 * only projects what the record says —
 * it hydrates nothing, acknowledges nothing, and a receipt line is the child's
 * own recorded output, never a claim the parent read it. The body uses faithful
 * tool-argument encoding, including visible tabs and protocol payloads. Receipts
 * retain the native-result-style plainText prose projection instead: recognized
 * protocols drop and whitespace normalizes. Neither path rewrites history. */
function communicationRenderers(name: string, args: unknown): ToolRenderers | undefined {
  const display = COMMUNICATION_DISPLAY[name as keyof typeof COMMUNICATION_DISPLAY];
  if (!display || typeof args !== "object" || args === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (Array.isArray(args)) return undefined;
    const keys = Reflect.ownKeys(args);
    if (keys.length !== 1 || keys[0] !== display.key) return undefined;
    descriptor = Object.getOwnPropertyDescriptor(args, display.key);
  } catch {
    // Reflection failures stay local to this raw card. Proxy traps themselves
    // remain arbitrary trusted code; do not invoke a recorded property getter.
    return undefined;
  }
  if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
  const text: unknown = descriptor.value;
  if (
    typeof text !== "string" ||
    text.length > COMMUNICATION_LIMITS.child_text_units ||
    !/\S/.test(text)
  )
    return undefined;
  const resultText = (result: unknown): string => {
    const content = (result as { content?: unknown } | undefined)?.content;
    return (Array.isArray(content) ? content : [])
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? (part as { text?: unknown }).text
          : undefined,
      )
      .filter((output): output is string => typeof output === "string")
      .join("\n");
  };
  return {
    // Own only the framing: record state and receipts stay outside the bubble,
    // without a pending/success/error tool-card background or delivery claim.
    renderShell: "self",
    renderCall: (_args, theme, context) => {
      const view =
        context.lastComponent instanceof Container ? context.lastComponent : new Container();
      const previousBubble = view.children[0];
      const previousNote = view.children[1];
      const note = previousNote instanceof Text ? previousNote : new Text("", 1, 0);
      if (!(previousBubble instanceof CommunicationBubble) || note !== previousNote) {
        view.clear();
        view.addChild(
          previousBubble instanceof CommunicationBubble
            ? previousBubble
            : new CommunicationBubble(display.label, toolArgumentText(text), theme),
        );
        view.addChild(note);
      }
      // This transcript applies only final recorded/synthetic results. Here
      // isPartial means no result record yet, not proof of live execution.
      note.setText(context.isPartial ? theme.fg("dim", "No recorded result") : "");
      return view;
    },
    renderResult: (result, _options, theme, context) => {
      const recorded = plainText(resultText(result));
      const needsMarker = context.isError && visibleWidth(recorded.replace(/\s/gu, "")) === 0;
      // Cell width is not pixel visibility. Retain nonblank combining-only
      // text below the marker rather than erasing potentially visible ink.
      const output = needsMarker ? (recorded.trim() ? `Error\n${recorded}` : "Error") : recorded;
      const view =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 0);
      view.setText(output ? theme.fg(context.isError ? "error" : "dim", output) : "");
      return view;
    },
  };
}

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
 *
 * A presentation-only stable READ ANCHOR sits over those blocks, so the
 * parent can save which message a pane was scrolled to before a
 * height-changing toggle and get the same message back after it, with no
 * position invented for anchors the retained history no longer contains.
 * frame() exposes it as closures scoped to that frame's own snapshot (no
 * source resampling); captureAnchor/resolveAnchor are per-call helpers over
 * the same anchors.
 */
export class TranscriptContent implements TranscriptRows {
  private blocks: Block[] = [];
  private consumed = 0;
  private consumedMessages: readonly unknown[] = [];
  private messagesIdentity: readonly unknown[] | undefined;
  private toolRenderersRevision: RendererBinding | undefined;
  /** Track every observed transition, including failures seen by a saved
   * handle before frame sync. Returning to the same source token cannot then
   * revive a card from an earlier observation epoch. */
  private observedRendererBinding: RendererBinding | undefined;
  /** Whether anything above a user message was rendered, driving its spacer. */
  private visible = false;
  /** Every tool card this pane created, for the presentation-only expansion
   * toggle; results also find their card through `pending` while incomplete. */
  private readonly tools: ToolEntry[] = [];
  /** Default expansion for settled, successful tool cards. Collapsed is the
   * pane's own presentation choice; active/incomplete and failed cards stay
   * expanded regardless, so progress and errors remain visible. */
  private toolsExpanded = false;
  private readonly pending = new Map<string, ToolEntry>();
  private width: number | undefined;
  private rows: readonly string[] | undefined;
  /** Anchor index for the current settled rows, keyed by that array's
   * identity: every width/content/expansion/render invalidation replaces the
   * rows array, so an identity match proves the geometry is unchanged and
   * the index can be reused; reset() drops it with the blocks it names. */
  private layout: { rows: readonly string[]; layout: BlockLayout } | undefined;
  private inFlight: AssistantMessageComponent | undefined;
  private inFlightWidth: number | undefined;
  private inFlightRows: readonly string[] | undefined;

  constructor(private readonly options: TranscriptOptions) {}

  frame(width: number): TranscriptFrame {
    if (width <= 0)
      return {
        lineCount: 0,
        slice: () => [],
        // A non-positive width paints nothing, so it has no blocks to anchor
        // into — not even stale ones from an earlier, wider paint.
        anchorAt: () => undefined,
        resolveAnchor: () => undefined,
      };
    const settled = this.settled(width),
      tail = this.tail(width);
    // The anchor index is rebuilt only when the settled rows array is — an
    // identity match means no width/content/expansion/render change happened
    // since it was built — so an unchanged history costs no reindex, streaming
    // or not. The closures below capture this frame's own immutable snapshot,
    // so a later rebuild never re-scopes an older frame.
    const layout =
        this.layout?.rows === settled ? this.layout.layout : this.buildBlockLayout(settled),
      inFlight = this.inFlight;
    return {
      lineCount: settled.length + tail.length,
      slice: (start, count) => {
        const end = start + count,
          out = settled.slice(start, Math.min(end, settled.length));
        if (end > settled.length)
          out.push(...tail.slice(Math.max(0, start - settled.length), end - settled.length));
        return out;
      },
      anchorAt: (row) => {
        if (!Number.isInteger(row) || row < 0) return undefined;
        if (row < layout.total) {
          // First block whose cumulative end passes the row. A zero-height
          // block's end equals its start, so it can never be the first end
          // above the row: the search skips such blocks by construction.
          let low = 0,
            high = layout.ends.length;
          while (low < high) {
            const mid = (low + high) >> 1;
            if (layout.ends[mid]! <= row) low = mid + 1;
            else high = mid;
          }
          return {
            kind: "block",
            offset: row - layout.starts[low]!,
            target: layout.blocks[low]!,
          } satisfies ReadAnchor;
        }
        if (inFlight && tail.length > 0 && row < layout.total + tail.length)
          return {
            kind: "inFlight",
            offset: row - layout.total,
            target: inFlight,
          } satisfies ReadAnchor;
        return undefined;
      },
      resolveAnchor: (anchor) => {
        if (typeof anchor !== "object" || anchor === null) return undefined;
        const { kind, offset, target } = anchor as Partial<ReadAnchor>;
        if (
          (kind !== "block" && kind !== "inFlight") ||
          typeof offset !== "number" ||
          !Number.isInteger(offset) ||
          offset < 0
        )
          return undefined;
        if (kind === "inFlight") {
          if (target !== inFlight || tail.length === 0) return undefined;
          return settled.length + Math.min(offset, tail.length - 1);
        }
        // Identity, not index: a rewrite builds new block objects, so an
        // anchor into the old generation matches nothing this frame kept.
        const index = layout.byBlock.get(target as Block);
        if (index === undefined) return undefined;
        const height = layout.ends[index]! - layout.starts[index]!;
        return height > 0 ? layout.starts[index]! + Math.min(offset, height - 1) : undefined;
      },
    };
  }

  /** Index the current blocks once per settled rows array. Presentation-only
   * geometry; no source, authority or lifecycle state is touched. */
  private buildBlockLayout(rows: readonly string[]): BlockLayout {
    const blocks = [...this.blocks],
      starts: number[] = [],
      ends: number[] = [],
      byBlock = new Map<Block, number>();
    let start = 0;
    for (const [index, block] of this.blocks.entries()) {
      const height = block.rows?.length ?? 0;
      starts.push(start);
      ends.push(start + height);
      byBlock.set(block, index);
      start += height;
    }
    const layout: BlockLayout = { blocks, starts, ends, byBlock, total: start };
    this.layout = { rows, layout };
    return layout;
  }

  /** Explicit MarkdownTheme/palette replacement rebuilds captured components,
   * including literal ANSI and SDK Markdown default-style prefixes. A fresh
   * getMarkdownTheme() wrapper alone is not evidence of a palette change. */
  setTheme(markdownTheme: MarkdownTheme): void {
    this.options.markdownTheme = markdownTheme;
    this.reset();
    this.inFlight = undefined;
    this.inFlightRows = undefined;
  }

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

  /** Layout invalidation for a known unchanged palette. Native message/tool
   * invalidate() overrides can rebuild Markdown, so traverse their public tree
   * instead. Box render caches self-check width, child rows and background.
   * Opaque wrappers (including MouseRegion) use public invalidate(); the native
   * assistant's thinking wrapper delegates to its Markdown/Text leaf. */
  invalidateLayout(): void {
    this.syncRendererBinding();
    const invalidate = (component: Component): void => {
      if (component instanceof TranscriptToolCard) component.invalidateLayout();
      else if (component instanceof Container || component instanceof Box) {
        for (const child of component.children) invalidate(child);
      } else component.invalidate();
    };
    for (const block of this.blocks) {
      invalidate(block.container);
      block.rows = undefined;
    }
    this.rows = undefined;
    if (this.inFlight) invalidate(this.inFlight);
    this.inFlightRows = undefined;
  }

  /** Ordinary external invalidation retains its native-component semantics.
   * Palette replacement should use setTheme() to refresh captured ANSI too. */
  invalidate(): void {
    this.syncRendererBinding();
    for (const block of this.blocks) {
      block.container.invalidate();
      block.rows = undefined;
    }
    this.rows = undefined;
    this.inFlight?.invalidate();
    this.inFlightRows = undefined;
  }

  /** Presentation-only default expansion for settled, successful tool cards.
   * Active/incomplete and failed cards ignore it. Only the blocks whose cards
   * actually changed lose their cached rows; the streaming tail and untouched
   * settled blocks keep theirs. No runtime or permission state is involved. */
  setToolsExpanded(expanded: boolean): void {
    this.syncRendererBinding();
    if (this.toolsExpanded === expanded) return;
    this.toolsExpanded = expanded;
    for (const entry of this.tools) this.applyExpansion(entry);
  }

  dispose(): void {
    this.reset();
    this.inFlight = undefined;
    this.inFlightRows = undefined;
  }

  /** Presentation-only stable read anchor: identify the message block the
   * given row falls inside — plus the row's offset within it — under the
   * CURRENT rendering, before a height-changing presentation toggle. The
   * streaming tail is anchored by its component identity instead. A row
   * outside the rendered content, a non-positive width or a malformed row
   * yields undefined; nothing is invented. Beyond rendering at the given
   * width (exactly what a paint does), this is a read: no expansion mode,
   * scroll, source or lifecycle state changes. Implemented over frame(), so
   * each call is its own sample; a per-paint flow should instead hold the
   * frame and use its anchorAt/resolveAnchor closures, which never resample
   * and stay scoped to that frame's captured blocks. */
  captureAnchor(width: number, row: number): unknown {
    return this.frame(width).anchorAt?.(row);
  }

  /** Map an anchor back to a row under the CURRENT rendering, after a
   * presentation-only change (e.g. setToolsExpanded) and possibly at a new
   * width. The same retained block keeps its captured row; if the block
   * collapsed, the offset clamps to its last row rather than drifting into
   * the next message. An anchor is only valid against the same retained
   * block/component objects of this pane: history rewritten by a compaction
   * or branch (or an anchor from another pane, or any malformed value) has no
   * position to preserve, and resolves to undefined — never a guess. Also a
   * per-call sample over frame(); a held frame's resolveAnchor closure gives
   * the same answer without touching the source again. */
  resolveAnchor(width: number, anchor: unknown): number | undefined {
    return this.frame(width).resolveAnchor?.(anchor);
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
    if (this.inFlightWidth !== width) {
      this.inFlightWidth = width;
      this.inFlightRows = undefined;
    }
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
  private reset(): void {
    for (const entry of this.tools) entry.component.retire();
    this.blocks = [];
    this.consumed = 0;
    this.consumedMessages = [];
    this.messagesIdentity = undefined;
    this.visible = false;
    this.tools.length = 0;
    this.pending.clear();
    this.rows = undefined;
    this.layout = undefined;
  }

  /** The same guarded observation drives frame sync and immediate callback
   * freshness. In particular, a failure cannot accidentally authorize an old
   * callback or masquerade as a successful undefined-token read. */
  private readRendererBinding(): RendererBinding {
    let value: unknown;
    try {
      value = this.options.source.toolRenderersRevision?.();
    } catch {
      value = UNAVAILABLE_RENDERER_BINDING;
    }
    if (!this.observedRendererBinding || this.observedRendererBinding.value !== value)
      this.observedRendererBinding = { value };
    return this.observedRendererBinding;
  }

  /** Retire callback-bearing components before any SDK operation can render
   * or invalidate them, not only before the next frame samples the history. */
  private syncRendererBinding(): void {
    const revision = this.readRendererBinding();
    if (revision !== this.toolRenderersRevision) {
      this.reset();
      this.toolRenderersRevision = revision;
    }
  }

  private consume(): void {
    this.syncRendererBinding();
    const messages = this.options.source.messages();
    if (messages === this.messagesIdentity && messages.length === this.consumed) return;
    // Only inspect prefixes when the source history actually changed. A branch
    // can replace an earlier entry while retaining the same last message.
    const rewritten =
      messages.length < this.consumed ||
      this.consumedMessages.some((message, i) => i < this.consumed && messages[i] !== message);
    if (rewritten) this.reset();
    this.messagesIdentity = messages;
    this.consumedMessages = messages.slice();
    if (messages.length === this.consumed) return;
    for (let i = this.consumed; i < messages.length; i++) {
      // Pi's own components assume well-formed messages -- array content, a
      // summary that knows its token count -- and throw on anything else. These
      // entries are a CHILD's, read while it may still be writing them, so one
      // that cannot be rendered is skipped rather than allowed to take down the
      // parent's UI. It is skipped permanently: `consumed` advances either way,
      // or the same throw would return on every frame.
      try {
        this.consumeOne(messages[i]);
      } catch {
        /* one block short, not one pane */
      }
    }
    this.consumed = messages.length;
    this.rows = undefined;
  }

  private consumeOne(message: unknown): void {
    const theme = this.options.markdownTheme;
    const msg = message as Msg;
    switch (role(message)) {
      case "assistant":
        return this.consumeAssistant(msg as MessageOf<"assistant">);
      case "toolResult":
        return this.consumeToolResult(msg as MessageOf<"toolResult">);
      case "user":
        return this.consumeUser(msg as MessageOf<"user">);
      case "bashExecution":
        return this.consumeBash(msg as MessageOf<"bashExecution">);
      case "compactionSummary":
        return this.consumeSummary(
          new CompactionSummaryMessageComponent(msg as MessageOf<"compactionSummary">, theme),
        );
      case "branchSummary":
        return this.consumeSummary(
          new BranchSummaryMessageComponent(msg as MessageOf<"branchSummary">, theme),
        );
      // A `custom` message needs the child's message-renderer registry, which
      // this pane does not hold, so it contributes no block rather than a guess.
      default:
        return;
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
    return typeof message.errorMessage === "string" && message.errorMessage
      ? message.errorMessage
      : "Error";
  }

  private consumeAssistant(message: MessageOf<"assistant">): void {
    const block = this.append();
    block.container.addChild(
      new AssistantMessageComponent(message, false, this.options.markdownTheme),
    );
    const failure = TranscriptContent.failureText(message);
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content?.type !== "toolCall") continue;
      // Semantic matching first, on the original exact name and arguments; the
      // component itself is handed only the detached, terminal-safe projection.
      const binding = this.toolRenderersRevision;
      let renderers: ToolRenderers = RAW_RENDERERS;
      if (binding?.value !== UNAVAILABLE_RENDERER_BINDING) {
        if (Object.hasOwn(COMMUNICATION_DISPLAY, content.name)) {
          // Malformed communication records stay raw, even if a resolver would
          // recognize their names. The message bubble remains the exact match.
          renderers = communicationRenderers(content.name, content.arguments) ?? RAW_RENDERERS;
        } else if (!blockedDelegationToolNames.includes(content.name)) {
          try {
            renderers = this.options.source.toolDefinition(content.name) ?? RAW_RENDERERS;
          } catch {
            // An unavailable resolver must not hide the recorded call or result.
          }
        }
      }
      const projection = sanitizedToolProjection(content.name, content.arguments);
      const tool = new TranscriptToolCard({
        name: projection.name,
        callId: content.id,
        args: projection.args,
        renderers,
        tui: this.options.tui,
        cwd: this.options.cwd,
        isCurrent: () => this.readRendererBinding() === binding,
        changed: () => {
          block.rows = undefined;
          this.rows = undefined;
          this.layout = undefined;
        },
      });
      // Do not mark historical arguments complete or execution started: some
      // native renderers would then read today's worktree for a preview diff.
      // Only recorded results belong here. A fresh card starts expanded; a
      // successful result later collapses it when the
      // pane's mode asks for it.
      tool.setExpanded(true);
      const entry: ToolEntry = {
        component: tool,
        block,
        expanded: true,
        settled: failure !== undefined,
        error: failure !== undefined,
      };
      this.tools.push(entry);
      block.container.addChild(tool);
      // Only a call that can still be answered stays pending; the rest are done.
      if (failure === undefined) this.pending.set(content.id, entry);
      else tool.updateResult({ content: [{ type: "text", text: failure }], isError: true });
    }
    this.visible = true;
  }

  /** The pane's expansion rule: active/incomplete and failed cards stay
   * expanded; a settled successful card follows the pane's mode. */
  private applyExpansion(entry: ToolEntry): void {
    const want = !entry.settled || entry.error || this.toolsExpanded;
    if (entry.expanded === want) return;
    entry.expanded = want;
    entry.component.setExpanded(want);
    entry.block.rows = undefined;
    this.rows = undefined;
  }

  /** A result mutates the block holding its call; no other block changes. */
  private consumeToolResult(message: MessageOf<"toolResult">): void {
    const pending = this.pending.get(message.toolCallId);
    if (!pending) return;
    const projected = detachedToolResult(message);
    pending.component.updateResult(projected);
    pending.settled = true;
    pending.error = projected.isError === true;
    this.applyExpansion(pending);
    pending.block.rows = undefined;
    this.rows = undefined;
    this.pending.delete(message.toolCallId);
  }

  private consumeUser(message: MessageOf<"user">): void {
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : [])
            .filter((part) => part?.type === "text")
            .map((part) => part.text ?? "")
            .join("");
    if (!text) return;
    const block = this.append();
    // Whether a leading spacer is needed is a whole-transcript property, so it
    // is decided here, where what precedes this block is known.
    if (this.visible) block.container.addChild(new Spacer(1));
    const steer = `${humanSteerLead}\n\n`;
    if (text.startsWith(steer)) {
      // The recorded lead is the only authorship evidence, and it says "human",
      // so the pane shows exactly that qualification — no verified-authorship
      // claim — and drops the boilerplate, keeping the message bytes untouched.
      block.container.addChild(this.userLabel("Steering input (human lead)"));
      block.container.addChild(
        new UserMessageComponent(text.slice(steer.length), this.options.markdownTheme),
      );
    } else {
      // Neutral labels only, and the same one for every generic user message:
      // after a compaction or branch rewrite the pane cannot prove which
      // rendered user message was the original task input, so it never claims
      // one. The recorded steering lead stays the only qualified label.
      block.container.addChild(this.userLabel("Input"));
      const skill = parseSkillBlock(text);
      if (!skill) {
        block.container.addChild(new UserMessageComponent(text, this.options.markdownTheme));
      } else {
        const invocation = new SkillInvocationMessageComponent(skill, this.options.markdownTheme);
        invocation.setExpanded(true);
        block.container.addChild(invocation);
        if (skill.userMessage) {
          block.container.addChild(new Spacer(1));
          block.container.addChild(
            new UserMessageComponent(skill.userMessage, this.options.markdownTheme),
          );
        }
      }
    }
    this.visible = true;
  }

  /** A user block's neutral label, aligned with the message's own padding. */
  private userLabel(label: string): Text {
    return new Text(this.options.markdownTheme.bold(label), 1, 0);
  }

  private consumeBash(message: MessageOf<"bashExecution">): void {
    const block = this.append();
    const bash = new BashExecutionComponent(
      message.command,
      this.options.tui,
      message.excludeFromContext,
    );
    if (message.output) bash.appendOutput(message.output);
    bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
    block.container.addChild(bash);
    this.visible = true;
  }

  private consumeSummary(
    summary: CompactionSummaryMessageComponent | BranchSummaryMessageComponent,
  ): void {
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
