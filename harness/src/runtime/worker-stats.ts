import type { EventBus, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { STATS_WORKER_ATTACH } from "../../../lib/stats-protocol.mjs";
import type { WorkerStatsAttachment, WorkerStatsMessage, WorkerStatsSink } from "../../../lib/stats-protocol.mjs";

type RunKind = "success" | "error" | "aborted";

type UntrustedMessage = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  stopReason?: unknown;
  usage?: unknown;
};

type UntrustedUsage = {
  output?: unknown;
  cost?: unknown;
};

type UntrustedCost = {
  total?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Construct a new metadata-only object; never give the parent an SDK message. */
function assistantMetadata(message: unknown): WorkerStatsMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const source = message as UntrustedMessage;
  if (source.role !== "assistant") return undefined;

  const result: WorkerStatsMessage = { role: "assistant" };
  const provider = stringValue(source.provider);
  const model = stringValue(source.model);
  const responseModel = stringValue(source.responseModel);
  const stopReason = stringValue(source.stopReason);
  if (provider !== undefined) result.provider = provider;
  if (model !== undefined) result.model = model;
  if (responseModel !== undefined) result.responseModel = responseModel;
  if (stopReason !== undefined) result.stopReason = stopReason;

  const usageSource = source.usage;
  if (typeof usageSource !== "object" || usageSource === null) return result;
  const usage = usageSource as UntrustedUsage;
  const output = numberValue(usage.output);
  const costSource = usage.cost;
  const total = typeof costSource === "object" && costSource !== null
    ? numberValue((costSource as UntrustedCost).total)
    : undefined;
  if (output !== undefined || total !== undefined) {
    result.usage = {
      ...(output !== undefined ? { output } : {}),
      ...(total !== undefined ? { cost: { total } } : {}),
    };
  }
  return result;
}

/**
 * Optional, metadata-only bridge from one child SDK session to the owning
 * parent's Stats extension. It owns neither the child session nor Run state.
 */
export class WorkerStatsObserver {
  private attached = false;
  private disposed = false;
  private sink: WorkerStatsSink | undefined;

  constructor(
    private readonly parentBus: EventBus,
    private readonly parentId: string,
    private readonly workerId: string,
  ) {}

  private observe(operation: (sink: WorkerStatsSink) => void): void {
    if (this.disposed) return;
    try {
      const sink = this.sink;
      if (sink) operation(sink);
    } catch {
      // Stats is observational only, including across independently bundled code.
    }
  }

  private register(subscription: () => unknown): void {
    try {
      subscription();
    } catch {
      // A missing or hostile optional event channel cannot block child startup.
    }
  }

  readonly extension: ExtensionFactory = (pi) => {
    this.register(() => pi.on("agent_start", () => this.observe((sink) => sink.startActivity())));
    this.register(() => pi.on("agent_settled", () => this.observe((sink) => sink.settleActivity())));
    // turn_start is the SDK attempt boundary. before_provider_request also sees
    // cache warming, which is deliberately outside a worker Run.
    this.register(() => pi.on("turn_start", (_event, ctx) => this.observe((sink) => {
      const model = ctx.model;
      const id = stringValue(model?.id);
      if (id === undefined) return;
      const provider = stringValue(model?.provider);
      sink.requestStart(id, provider);
    })));
    this.register(() => pi.on("message_update", (event) => this.observe((sink) => {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") return;
      if (typeof update.delta === "string" && update.delta.length > 0) sink.delta(update.type);
    })));
    this.register(() => pi.on("message_end", (event) => this.observe((sink) => {
      const message = assistantMetadata(event.message);
      if (message) sink.messageEnd(message);
    })));
    this.register(() => pi.on("tool_execution_start", (event) => this.observe((sink) => {
      const id = stringValue(event.toolCallId);
      const name = stringValue(event.toolName);
      if (id !== undefined && name !== undefined) sink.toolStart(id, name);
    })));
    this.register(() => pi.on("tool_execution_end", (event) => this.observe((sink) => {
      const id = stringValue(event.toolCallId);
      if (id !== undefined && typeof event.isError === "boolean") sink.toolEnd(id, event.isError);
    })));
    this.register(() => pi.on("session_shutdown", () => this.dispose()));
  };

  beginRun(): void {
    if (this.disposed) return;
    if (!this.attached) {
      this.attached = true;
      const attachment: WorkerStatsAttachment = { parentId: this.parentId, workerId: this.workerId };
      try {
        this.parentBus.emit(STATS_WORKER_ATTACH, attachment);
      } catch {
        // Stats may not be loaded, and its bus must never become Run authority.
      }
      try {
        if (attachment.sink) this.sink = attachment.sink;
      } catch {
        // A hostile attachment getter is equivalent to no Stats extension.
      }
    }
    this.observe((sink) => sink.beginRun());
  }

  endRun(kind: RunKind): void {
    this.observe((sink) => sink.endRun(kind));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const sink = this.sink;
    this.sink = undefined;
    try {
      sink?.dispose();
    } catch {
      // Cleanup cannot replace child session teardown.
    }
  }
}
