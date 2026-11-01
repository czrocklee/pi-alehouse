import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describeToolArgs } from "../ui/format.js";
import { singleLineText } from "../ui/text.js";
import type { ActiveTool, GenerationPreview } from "./activity-types.js";
import { boundedPreview, LinePreview } from "./line-preview.js";

export interface SessionEntries { getEntries(): unknown[] }
export interface ChildActivitySnapshot extends GenerationPreview {
  active_tools: ActiveTool[];
  tool_uses: number;
}
export interface ChildActivityObservation {
  snapshot(): ChildActivitySnapshot;
  entries(): unknown[] | undefined;
  inFlight(): unknown;
  readonly workspace: string;
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
  constructor(private readonly cwd: string) {}

  private clearPreviews(): void {
    this.prose.clear();
    this.thought.clear();
    this.channel = undefined;
    this.preparingTool = undefined;
  }
  private clearGeneration(): void { this.clearPreviews(); this.streaming = undefined; }

  readonly extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => { this.sessions = ctx.sessionManager; });
    pi.on("turn_start", () => this.clearGeneration());
    pi.on("agent_start", () => this.clearGeneration());
    pi.on("agent_end", () => this.clearGeneration());
    pi.on("session_before_compact", () => this.clearGeneration());
    pi.on("agent_settled", () => { this.clearGeneration(); this.running.clear(); });
    // Disposal ends live activity, not retained failed-Run transcript access.
    // ChildActivityRegistry.retain owns the observation's eventual lifetime.
    pi.on("session_shutdown", () => { this.clearGeneration(); this.running.clear(); });
    pi.on("tool_execution_start", (event) => {
      const detail = describeToolArgs(event.toolName, event.args, this.cwd, Infinity);
      this.preparingTool = undefined;
      this.running.set(event.toolCallId, { name: observedToolName(event.toolName),
        detail: detail ? boundedPreview(detail, 4096) : undefined });
    });
    pi.on("tool_execution_end", (event) => {
      if (this.running.delete(event.toolCallId)) this.uses++;
    });
    pi.on("message_start", (event) => {
      if (event.message.role !== "assistant") return;
      this.clearGeneration();
      this.streaming = event.message;
    });
    pi.on("message_update", (event) => {
      if (event.message.role !== "assistant") return;
      this.streaming = event.message;
      const update = event.assistantMessageEvent;
      if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
        // Draft arguments are not an executing tool; retain the native in-flight
        // message while showing only the tool's identifying name, never its body.
        this.clearPreviews();
        const block = update.partial.content[update.contentIndex];
        this.preparingTool = block?.type === "toolCall" ? observedToolName(block.name) : "";
        return;
      }
      if (update.type !== "thinking_start" && update.type !== "thinking_delta" && update.type !== "thinking_end" &&
          update.type !== "text_start" && update.type !== "text_delta" && update.type !== "text_end") return;
      const thinking = update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end";
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
    return { active_tools: [...this.running.values()], tool_uses: this.uses, preview: this.prose.value(),
      ...(thinking ? { thinking } : {}), ...(this.channel ? { channel: this.channel } : {}),
      ...(this.preparingTool !== undefined ? { preparing_tool: this.preparingTool } : {}) };
  }
  entries(): unknown[] | undefined {
    try { return this.sessions?.getEntries(); } catch { return undefined; }
  }
  inFlight(): unknown { return this.streaming; }
  get workspace(): string { return this.cwd; }
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
    for (const id of this.activities.keys()) if (!agent_ids.has(id)) this.activities.delete(id);
  }
  clear(): void { this.activities.clear(); }
}
