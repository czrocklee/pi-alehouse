// Experiment-only: SDK JSONL + small custom entries, NOT a StorePort/backend.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { controlledProvider } from "./host.mjs";

export const START = "harness-history-experiment:start";
export const END = "harness-history-experiment:end";
export const ADMISSION = "harness-history-experiment:admitted";
export const textOf = (message) => message.content.filter((p) => p.type === "text").map((p) => p.text).join("");

export async function createFixture(host, root, label) {
  const { sdk, ai } = host;
  const cwd = join(root, label), agentDir = join(cwd, "agent"), sessionDir = join(cwd, "sessions");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const manager = sdk.SessionManager.create(cwd, sessionDir);
  const provider = controlledProvider(ai);
  let partialMode = false;
  const partialSeen = Promise.withResolvers();
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerProvider("harness-fixture", { ...provider.config, streamSimple(model, context, options) {
    if (!partialMode) return provider.config.streamSimple(model, context, options);
    // Only model IO is controlled: emit a real SDK text_delta but never message_end.
    const stream = ai.createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "UNSAVED_PARTIAL" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "UNSAVED_PARTIAL", partial: message });
    });
    return stream;
  } });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => "Synthetic SDK history experiment. No external work." });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, sessionManager: manager,
    resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel("harness-fixture", "controlled"), thinkingLevel: "off",
    tools: ["synthetic_echo"], customTools: [sdk.defineTool({ name: "synthetic_echo", label: "echo", description: "Return a constant, no side effects.",
      parameters: ai.Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "synthetic tool result" }], details: {} }) })] });
  await session.bindExtensions({});
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") partialSeen.resolve();
  });
  return { manager, session, provider, partialSeen: partialSeen.promise, holdPartial: () => { partialMode = true; } };
}

export function beginRun(manager, run_id = randomUUID()) {
  const start = manager.appendCustomEntry(START, { version: 1, run_id, session_id: manager.getSessionId() });
  return { run_id, start };
}

// Caller has already awaited the FULL SDK prompt + idle and supplies its outcome.
// This is metadata recording, not new terminal arbitration inferred from a log.
export function endRun(manager, run, outcome) {
  const branch = manager.getBranch();
  const index = branch.findIndex((entry) => entry.id === run.start);
  assert(index >= 0);
  const final = branch.slice(index + 1).filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
  const end = manager.appendCustomEntry(END, { version: 1, run_id: run.run_id, session_id: manager.getSessionId(),
    start_entry_id: run.start, final_entry_id: final?.id ?? null, outcome });
  return { ...run, end, final: final?.id ?? null };
}

// Current-version, small synthetic files only. open() is intentionally avoided:
// it can repair/migrate its source. No salvage, writes, live hydration or replay.
export function readHistory(sdk, path) {
  const bytes = readFileSync(path);
  assert(bytes.length < 1_048_576, "fixture snapshot too large");
  const entries = bytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert(entries[0]?.type === "session" && entries[0].version === 3, "fixture only accepts SDK v3 logs");
  return sdk.SessionManager.inMemory(entries[0].cwd, { id: entries[0].id }, entries);
}

export function readRun(manager, run_id) {
  const entries = manager.getEntries();
  const starts = entries.filter((e) => e.type === "custom" && e.customType === START && e.data?.run_id === run_id);
  const ends = entries.filter((e) => e.type === "custom" && e.customType === END && e.data?.run_id === run_id);
  if (starts.length === 0 && ends.length === 0) return { status: "not_recorded", complete: false };
  assert(starts.length === 1 && ends.length <= 1, "ambiguous Run metadata");
  if (!ends.length) return { status: "unknown", complete: false }; // Not completed or certified interrupted.
  const start = starts[0], end = ends[0], data = end.data;
  assert(data.session_id === manager.getSessionId() && start.data.session_id === data.session_id, "wrong session");
  assert(data.start_entry_id === start.id, "wrong Run boundary");
  const branch = manager.getBranch(end.id), index = branch.findIndex((entry) => entry.id === start.id);
  assert(index >= 0, "start is not on this terminal entry's branch");
  const final = branch.slice(index + 1).filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
  assert((final?.id ?? null) === data.final_entry_id, "wrong final message reference");
  return { status: data.outcome, text: final ? textOf(final.message) : "", complete: true, final_entry_id: data.final_entry_id };
}
