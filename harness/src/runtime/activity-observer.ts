import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describeToolArgs, type ActiveTool } from "../ui/format.js";

export interface SessionEntries { getEntries(): unknown[] }
export interface ChildActivitySnapshot {
  active_tools: ActiveTool[];
  tool_uses: number;
  preview: string;
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

/** Per-child activity observer. It does not own the SDK session. */
export class ChildActivity implements ChildActivityObservation {
  private readonly running = new Map<string, ActiveTool>();
  private streaming: unknown;
  private preview = "";
  private uses = 0;
  private sessions?: SessionEntries;
  constructor(private readonly cwd: string) {}
  readonly extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => { this.sessions = ctx.sessionManager; });
    pi.on("tool_execution_start", (event) => {
      this.running.set(event.toolCallId, { name: event.toolName,
        detail: describeToolArgs(event.toolName, event.args, this.cwd, 72) });
    });
    pi.on("tool_execution_end", (event) => {
      if (this.running.delete(event.toolCallId)) this.uses++;
    });
    pi.on("message_start", (event) => {
      if (event.message.role !== "assistant") return;
      this.preview = "";
      this.streaming = event.message;
    });
    pi.on("message_update", (event) => {
      if (event.message.role === "assistant") this.streaming = event.message;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      this.preview = (this.preview + event.assistantMessageEvent.delta).slice(-256);
    });
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") this.streaming = undefined;
    });
  };
  /** Submission boundary: reset before a child can report the new Run. */
  begin(): void {
    this.running.clear();
    this.preview = "";
    this.uses = 0;
    this.streaming = undefined;
  }
  snapshot(): ChildActivitySnapshot {
    return { active_tools: [...this.running.values()], tool_uses: this.uses, preview: this.preview };
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
