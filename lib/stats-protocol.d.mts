export const STATS_WORKER_ATTACH: "pi-stats:worker-attach:v1";
/** Small metadata-only interface across separately bundled extensions. */
export interface WorkerStatsSink {
  beginRun(): void;
  startActivity(): void;
  settleActivity(): void;
  requestStart(model: string, provider?: string): void;
  /** A nonempty effective delta was seen; never transport its content. */
  delta(kind: "text_delta" | "thinking_delta" | "toolcall_delta"): void;
  messageEnd(message: WorkerStatsMessage): void;
  toolStart(id: string, name: string): void;
  toolEnd(id: string, isError: boolean): void;
  endRun(kind: "success" | "error" | "aborted"): void;
  dispose(): void;
}
export interface WorkerStatsMessage {
  role: "assistant";
  provider?: string;
  model?: string;
  responseModel?: string;
  stopReason?: string;
  usage?: { output?: number; cost?: { total?: number } };
}
export interface WorkerStatsAttachment {
  parentId: string;
  workerId: string;
  /** Filled synchronously by the owning parent; no listener means no observer. */
  sink?: WorkerStatsSink;
}
