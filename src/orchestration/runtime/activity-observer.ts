import type { ExtensionFactory, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { identifyingToolArgs } from "../presentation/tool-identity.ts";
import { singleLineText } from "../presentation/plain-text.ts";
import type { ActiveTool, GenerationPreview } from "./activity-types.ts";
import { boundedPreview, LinePreview } from "./line-preview.ts";

export interface SessionEntries {
  getEntries(): unknown[];
  getSessionId?(): string;
  getLeafId?(): string | null;
  getEntryCount?(): number;
}
/** Opaque history identity, not a model projection or execution capability. */
export interface ActivityHistoryState {
  readonly session: object;
  readonly session_id: string;
  readonly leaf: string | null;
  readonly count: number;
}
export interface ChildActivitySnapshot extends GenerationPreview {
  active_tools: ActiveTool[];
  tool_uses: number;
}
/** A live per-session renderer resolver; the bound session is never handed on. */
export type ToolRendererLookup = (name: string) => ToolRenderers | undefined;

export interface ChildActivityObservation {
  /** Pure invalidation hints; optional for structural observation sources. */
  readonly presentationRevision?: number;
  /** Stable opaque token whose identity changes only when the live renderer
   * binding changes (bind/unbind/retire). Renderer lookups and stream
   * messages never change it, so a UI epoch keyed on this token rebuilds
   * callback-bearing blocks only across a real binding change — not on every
   * presentationRevision bump. */
  readonly toolRenderersRevision?: unknown;
  historyState?(): ActivityHistoryState | undefined;
  snapshot(): ChildActivitySnapshot;
  entries(): unknown[] | undefined;
  inFlight(): unknown;
  /** Live renderer projection for one tool name, or undefined for the UI's
   * own raw fallback (unknown tool, missing API, closed session). */
  toolRenderers?(name: string): ToolRenderers | undefined;
}
export interface ActivityObservationSource {
  get(agent_id: string): ChildActivityObservation | undefined;
}

/** Names are public identifying metadata, not an unbounded raw provider field. */
const observedToolName = (name: string): string => boundedPreview(singleLineText(name), 256);

/** Per-child activity observer. It does not own the SDK session. */
export class ChildActivity implements ChildActivityObservation {
  private readonly running = new Map<string, ActiveTool>();
  private streaming: unknown;
  private readonly prose = new LinePreview();
  private readonly thought = new LinePreview();
  private channel: GenerationPreview["channel"];
  private preparingTool?: string;
  private uses = 0;
  private sessions?: SessionEntries;
  private revision = 0;
  private history?: ActivityHistoryState;
  /** Live renderer resolver; undefined after unbind/retire (raw fallback). */
  private rendererLookup?: ToolRendererLookup;
  /** Stable per-instance opaque token; replaced only on binding changes. */
  private rendererToken: unknown = Object.freeze({});
  constructor(private readonly cwd: string) {}

  private clearPreviews(): void {
    this.prose.clear();
    this.thought.clear();
    this.channel = undefined;
    this.preparingTool = undefined;
  }
  private clearGeneration(): void {
    this.clearPreviews();
    this.streaming = undefined;
    this.revision++;
  }

  readonly extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      this.sessions = ctx.sessionManager;
      this.history = undefined;
      // A new session (or reload) invalidates the bound resolver; the retained
      // SessionManager/entries access above stays exactly as it was.
      this.retireToolRenderers();
      this.revision++;
    });
    pi.on("turn_start", () => this.clearGeneration());
    pi.on("agent_start", () => this.clearGeneration());
    pi.on("agent_end", () => this.clearGeneration());
    pi.on("session_before_compact", () => this.clearGeneration());
    pi.on("agent_settled", () => {
      this.clearGeneration();
      this.running.clear();
    });
    // Disposal ends live activity, not retained failed-Run transcript access.
    // ChildActivityRegistry.retain owns the observation's eventual lifetime.
    pi.on("session_shutdown", () => {
      this.clearGeneration();
      this.running.clear();
      // Backstop retirement: the factory's dispose/catch unbinds first, because
      // an earlier handler can block this one from running at all.
      this.retireToolRenderers();
    });
    pi.on("tool_execution_start", (event) => {
      this.revision++;
      const detail = identifyingToolArgs(event.toolName, event.args, this.cwd);
      this.preparingTool = undefined;
      this.running.set(event.toolCallId, {
        name: observedToolName(event.toolName),
        detail: detail ? boundedPreview(detail, 4096) : undefined,
      });
    });
    pi.on("tool_execution_end", (event) => {
      if (this.running.delete(event.toolCallId)) {
        this.uses++;
        this.revision++;
      }
    });
    pi.on("message_start", (event) => {
      if (event.message.role !== "assistant") return;
      this.clearGeneration();
      this.streaming = event.message;
    });
    pi.on("message_update", (event) => {
      if (event.message.role !== "assistant") return;
      this.revision++;
      this.streaming = event.message;
      const update = event.assistantMessageEvent;
      if (
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta" ||
        update.type === "toolcall_end"
      ) {
        // Draft arguments are not an executing tool; retain the native in-flight
        // message while showing only the tool's identifying name, never its body.
        this.clearPreviews();
        const block = update.partial.content[update.contentIndex];
        this.preparingTool = block?.type === "toolCall" ? observedToolName(block.name) : "";
        return;
      }
      if (
        update.type !== "thinking_start" &&
        update.type !== "thinking_delta" &&
        update.type !== "thinking_end" &&
        update.type !== "text_start" &&
        update.type !== "text_delta" &&
        update.type !== "text_end"
      )
        return;
      const thinking =
        update.type === "thinking_start" ||
        update.type === "thinking_delta" ||
        update.type === "thinking_end";
      this.preparingTool = undefined;
      this.channel = thinking ? "thinking" : "text";
      (thinking ? this.thought : this.prose).update(update);
    });
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") this.clearGeneration();
    });
  };
  /** Submission boundary: reset before a child can report the new Run. */
  begin(): void {
    this.running.clear();
    this.clearGeneration();
    this.uses = 0;
  }
  snapshot(): ChildActivitySnapshot {
    const thinking = this.thought.value();
    return {
      active_tools: [...this.running.values()],
      tool_uses: this.uses,
      preview: this.prose.value(),
      ...(thinking ? { thinking } : {}),
      ...(this.channel ? { channel: this.channel } : {}),
      ...(this.preparingTool !== undefined ? { preparing_tool: this.preparingTool } : {}),
    };
  }
  get presentationRevision(): number {
    return this.revision;
  }
  historyState(): ActivityHistoryState | undefined {
    const session = this.sessions;
    if (!session?.getSessionId || !session.getLeafId || !session.getEntryCount) return undefined;
    try {
      const session_id = session.getSessionId(),
        leaf = session.getLeafId(),
        count = session.getEntryCount();
      if (
        !this.history ||
        this.history.session !== session ||
        this.history.session_id !== session_id ||
        this.history.leaf !== leaf ||
        this.history.count !== count
      )
        this.history = { session, session_id, leaf, count };
      return this.history;
    } catch {
      return undefined;
    }
  }
  entries(): unknown[] | undefined {
    try {
      return this.sessions?.getEntries();
    } catch {
      return undefined;
    }
  }
  inFlight(): unknown {
    return this.streaming;
  }
  /** Bind the live renderer resolver. The returned unbind is idempotent and
   * matched to this call's own binding token, not to the lookup function:
   * rebinding the same function still supersedes the older unbind, and no
   * unbind can ever clear a newer binding. Only bind/unbind/retire change
   * the opaque token — never a lookup — and each change bumps
   * presentationRevision to wake the UI. */
  bindToolRenderers(lookup: ToolRendererLookup): () => void {
    const binding = Object.freeze({});
    this.rendererLookup = lookup;
    this.rendererToken = binding;
    this.revision++;
    let unbound = false;
    return () => {
      if (unbound) return;
      unbound = true;
      if (this.rendererToken === binding) {
        this.rendererLookup = undefined;
        this.rendererToken = Object.freeze({});
        this.revision++;
      }
    };
  }
  /** Drop the live resolver (registry/factory cleanup, a new session's
   * session_start, session_shutdown). Retained history and entries stay;
   * the UI falls back to its own raw rendering. */
  retireToolRenderers(): void {
    if (this.rendererLookup === undefined) return;
    this.rendererLookup = undefined;
    this.rendererToken = Object.freeze({});
    this.revision++;
  }
  get toolRenderersRevision(): unknown {
    return this.rendererToken;
  }
  toolRenderers(name: string): ToolRenderers | undefined {
    const lookup = this.rendererLookup;
    if (lookup === undefined) return undefined;
    try {
      return lookup(name);
    } catch {
      return undefined;
    }
  }
}

/** Owns activity observers independently from the widget's display lifetime. */
export class ChildActivityRegistry {
  private readonly activities = new Map<string, ChildActivity>();
  readonly observations: ActivityObservationSource = {
    get: (agent_id) => this.activities.get(agent_id),
  };
  track(agent_id: string, cwd: string): ChildActivity {
    const existing = this.activities.get(agent_id);
    if (existing) return existing;
    const created = new ChildActivity(cwd);
    this.activities.set(agent_id, created);
    return created;
  }
  retain(agent_ids: ReadonlySet<string>): void {
    for (const [id, activity] of this.activities) {
      if (agent_ids.has(id)) continue;
      // Retire the live resolver before dropping the observation, so a still
      // held UI reference stops calling into an untracked session.
      activity.retireToolRenderers();
      this.activities.delete(id);
    }
  }
  clear(): void {
    for (const activity of this.activities.values()) activity.retireToolRenderers();
    this.activities.clear();
  }
}
