import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
type AgentMessage = AgentSession["messages"][number];

export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** No tools, tool results, images or reasoning blocks; no silent truncation. */
export function textSnapshot(messages: readonly AgentMessage[], maxBytes = 64 * 1024): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content :
        message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text) lines.push(`[${message.role}]\n${text}`);
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      lines.push(`[${message.role}]\n${message.summary}`);
    }
  }
  const snapshot = lines.join("\n\n");
  const bytes = Buffer.byteLength(snapshot);
  if (bytes > maxBytes) throw new Error(`CONTEXT_SNAPSHOT_TOO_LARGE: ${bytes} > ${maxBytes}`);
  return snapshot;
}

export function contextSources(files: readonly { path: string; content: string }[], agentDir: string) {
  const seen = new Map<string, string>();
  return files.flatMap((file) => {
    const path = resolve(file.path);
    const hash = digest(file.content);
    if (seen.has(path)) {
      if (seen.get(path) !== hash) throw new Error(`CONTEXT_SOURCE_CONFLICT: ${path}`);
      return [];
    }
    seen.set(path, hash);
    return [{ path, digest: hash, origin: path === resolve(agentDir, "AGENTS.md") ? "operator" : "child-cwd" }];
  });
}
