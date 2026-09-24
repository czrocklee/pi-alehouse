// Synthetic subprocess only. The parent kills explicit checkpoints, never a user's Pi.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { loadHost } from "../support/host.mjs";
import { ADMISSION, beginRun, createFixture, endRun } from "../support/sdk-history-fixture.mjs";

const [piExecutable, root, stage] = process.argv.slice(2);
const host = await loadHost(piExecutable);
process.on("message", () => {}); // Keep IPC alive while a synthetic stream is held.
const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
const hold = () => new Promise(() => {});
const fixture = await createFixture(host, root, stage);
const { manager, session, provider } = fixture;
const file = manager.getSessionFile();
if (stage === "cold-admission") {
  const id = manager.appendCustomEntry(ADMISSION, { run_id: "queued-before-first-assistant" });
  manager.appendMessage({ role: "user", content: "not yet an assistant", timestamp: Date.now() });
  await send({ event: "checkpoint", stage, file, id, exists: existsSync(file), isPersisted: manager.isPersisted() });
  await hold();
}

const earlier = beginRun(manager);
provider.respond(async () => ({ text: "EARLIER_RESULT" }));
await session.prompt("warm this synthetic SDK log", { expandPromptTemplates: false, source: "extension" });
await session.waitForIdle();
endRun(manager, earlier, "completed");
if (stage === "warm-admission") {
  const id = manager.appendCustomEntry(ADMISSION, { run_id: "queued-without-child-session" });
  await send({ event: "checkpoint", stage, file, id, exists: existsSync(file), earlier });
  await hold();
}

const run = beginRun(manager);
if (stage === "write-failure" || stage === "assistant-write-failure") {
  // No SDK monkeypatch or disk filling. Only replace THIS fixture's file target.
  let injected = false;
  const inject = () => { renameSync(file, file + ".before-fault"); mkdirSync(file); injected = true; };
  if (stage === "write-failure") inject(); // user message cannot be saved
  await send({ event: "fault-ready", stage, file, run, earlier });
  let rootResult, promptError = null;
  const requestsBefore = provider.requests.length;
  provider.respond(async () => {
    if (stage === "assistant-write-failure") inject(); // user saved; model answer cannot be saved
    return { text: "MEMORY_ONLY_AFTER_FAULT" };
  });
  try {
    await session.prompt("synthetic write failure", { expandPromptTemplates: false, source: "extension" });
    rootResult = "resolved";
  } catch (error) {
    rootResult = `rejected:${error.code ?? error.name}`;
    promptError = { name: error.name, code: error.code, message: error.message };
  }
  await send({ event: "root-returned", rootResult, promptError, injected, requests: provider.requests.length - requestsBefore,
    memoryHasNewAssistant: manager.getEntries().some((e) => e.type === "message" && JSON.stringify(e.message.content).includes("MEMORY_ONLY_AFTER_FAULT")) });
  // Do not mask default unhandled-rejection behavior with process.exit() or an
  // exception handler. Give the native SDK/Node chain a normal event-loop turn.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await session.abort(); await session.waitForIdle(); session.dispose();
  await send({ event: "survived", idle: session.isIdle, streaming: session.isStreaming });
  process.disconnect();
} else if (stage === "streaming") {
  fixture.holdPartial();
  void session.prompt("hold an unfinished second Run", { expandPromptTemplates: false, source: "extension" });
  await fixture.partialSeen;
  await send({ event: "checkpoint", stage, file, run, earlier, partialObserved: true, streaming: session.isStreaming });
  await hold();
} else {
  provider.respond(async () => ({ text: "NEW_FINAL" }));
  await session.prompt("second Run", { expandPromptTemplates: false, source: "extension" });
  await session.waitForIdle();
  if (stage === "terminal-recorded") endRun(manager, run, "completed");
  await send({ event: "checkpoint", stage, file, run, earlier, idle: session.isIdle });
  await hold();
}
