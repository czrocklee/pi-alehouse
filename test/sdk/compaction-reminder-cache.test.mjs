// Real development SDK session, compaction and request assembly with
// deterministic provider IO; no credentials, network or live model. Proves the
// post-compaction reminder is appended once, never splits a tool call
// from its result, starts no extra turn, and leaves every later provider
// request a byte-stable extension of the one before it (prefix-cache safe).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import {
  compactionReminderMessage,
  compactionReminderText,
  registerCompactionReminder,
} from "../../dist/orchestration/runtime/compaction-reminder.js";
import { create, toolsFor } from "../support/owner-tools-fixture.mjs";
import { fixture as ownerFixture, until } from "../support/controller-fixture.mjs";

const SUMMARY = "Summary: the user asked for a probe; agent orca was delegated the work.";
const usage = (input) => ({
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

async function session(t, { controller, respond, compaction }) {
  const root = await mkdtemp(join(tmpdir(), "alehouse-compaction-reminder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = [],
    summaries = [];
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
  });
  runtime.registerProvider("alehouse-reminder", {
    api: "alehouse-reminder",
    apiKey: "synthetic-not-a-credential",
    baseUrl: "https://invalid.invalid",
    models: [
      {
        id: "controlled",
        name: "Controlled",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      const system = ai.getCurrentSystemPrompt(context.messages) ?? context.systemPrompt ?? "";
      const summarizing = system.startsWith("You are a context summarization assistant");
      const request = { messages: structuredClone(context.messages) };
      (summarizing ? summaries : main).push(request);
      const { content, input = 10 } = summarizing
        ? { content: [{ type: "text", text: SUMMARY }] }
        : respond(main.length);
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        usage: usage(input),
        timestamp: Date.now(),
      };
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const lookups = [];
  const extension = (api) => {
    api.registerTool({
      name: "probe",
      label: "probe",
      description: "fixture probe",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "probe-result ".repeat(40) }] }),
    });
    // The production registration; extension.ts supplies only the lookup that
    // returns its ready Owner bound to the compacted session.
    registerCompactionReminder(api, (ctx) => {
      lookups.push(ctx);
      return controller;
    });
  };
  const settings = sdk.SettingsManager.inMemory({
    compaction: { enabled: true, ...compaction },
    retry: { enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [extension],
  });
  await loader.reload();
  const sessionManager = sdk.SessionManager.inMemory(root);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager,
    modelRuntime: runtime,
    model: runtime.getModel("alehouse-reminder", "controlled"),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  return { session, sessionManager, main, summaries, lookups };
}

const runningAgent = async (t) => {
  const f = await ownerFixture(t);
  await toolsFor(f).call("agent_spawn", create({ label: "Delegated probe" }));
  await until(() => f.ports[0]?.streaming);
  // Still running at teardown: the Owner fixture's release aborts and drains it.
  return f.controller;
};

const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const reminderIndexes = (messages) =>
  messages.flatMap((message, index) => (text(message) === compactionReminderText ? [index] : []));

/** Every later request must start with the exact bytes of the one before it. */
function assertPrefixStable(requests) {
  for (let i = 1; i < requests.length; i++) {
    const before = requests[i - 1].messages,
      after = requests[i].messages;
    assert(after.length > before.length, `request ${i + 1} only appends`);
    for (let j = 0; j < before.length; j++)
      assert.equal(
        JSON.stringify(after[j]),
        JSON.stringify(before[j]),
        `request ${i + 1} rewrote message ${j} of request ${i}`,
      );
  }
}

function assertAppendedOnce(sessionManager) {
  const branch = sessionManager.getBranch();
  const compaction = branch.findLastIndex((entry) => entry.type === "compaction");
  const reminders = branch.flatMap((entry, index) =>
    entry.type === "custom_message" && entry.customType === compactionReminderMessage
      ? [index]
      : [],
  );
  assert.equal(reminders.length, 1, "one reminder per compaction");
  assert(reminders[0] > compaction, "the reminder follows the compaction entry");
  // Never between an assistant tool call and its result.
  const previous = branch[reminders[0] - 1];
  if (previous.type === "message" && previous.message.role === "assistant")
    assert(!previous.message.content.some((part) => part.type === "toolCall"));
  const entry = branch[reminders[0]];
  assert.equal(entry.display, false);
  assert.equal(entry.content, compactionReminderText, "fixed bytes, nothing interpolated");
  return entry;
}

test(
  "real SDK: idle manual compaction appends the reminder once; later requests only extend the prefix",
  { timeout: 15000 },
  async (t) => {
    t.mock.method(globalThis, "fetch", () => assert.fail("fixture attempted network IO"));
    const controller = await runningAgent(t);
    const f = await session(t, {
      controller,
      respond: () => ({ content: [{ type: "text", text: "ok ".repeat(200) }] }),
      compaction: { reserveTokens: 1024, keepRecentTokens: 64 },
    });
    for (const prompt of ["first", "second", "third"]) await f.session.prompt(prompt);
    await f.session.compact();
    assert.equal(f.lookups.length, 1);
    assertAppendedOnce(f.sessionManager);
    const before = f.main.length;
    await f.session.prompt("after compaction");
    await f.session.prompt("and again");
    const after = f.main.slice(before);
    assert.equal(after.length, 2, "the reminder itself started no turn");
    for (const request of after) assert.equal(reminderIndexes(request.messages).length, 1);
    assertPrefixStable(after);
    assert.equal(
      text(after[0].messages[reminderIndexes(after[0].messages)[0] + 1]),
      "after compaction",
      "the reminder sits before the next user prompt",
    );
  },
);

test(
  "real SDK: threshold compaction inside a tool-using run defers the reminder past the tool result",
  { timeout: 15000 },
  async (t) => {
    t.mock.method(globalThis, "fetch", () => assert.fail("fixture attempted network IO"));
    const controller = await runningAgent(t);
    // Usage above the threshold on the tool-call turn compacts before the next response.
    const f = await session(t, {
      controller,
      respond: (n) =>
        n === 2
          ? {
              content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
              input: 65000,
            }
          : { content: [{ type: "text", text: `answer ${n} `.repeat(100) }] },
      compaction: { reserveTokens: 1024, keepRecentTokens: 64 },
    });
    await f.session.prompt("warm up");
    await f.session.prompt("use the probe");
    // A split turn may take two summary requests for one compaction.
    assert(f.summaries.length >= 1);
    assert.equal(
      f.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length,
      1,
      "the run compacted exactly once",
    );
    const compaction = f.sessionManager.getBranch().find((entry) => entry.type === "compaction");
    assert.equal(compaction.summary.includes(SUMMARY), true);
    assert.equal(f.lookups.length, 1);
    assertAppendedOnce(f.sessionManager);
    const shape = f.sessionManager
      .getBranch()
      .map((entry) =>
        entry.type !== "message"
          ? entry.type
          : entry.message.content?.some?.((part) => part.type === "toolCall")
            ? "call"
            : entry.message.role,
      );
    assert.deepEqual(
      shape.slice(shape.indexOf("call")),
      ["call", "toolResult", "compaction", "assistant", "custom_message"],
      "compacted mid-run; the reminder waits for the turn to end",
    );
    const before = f.main.length;
    await f.session.prompt("after the run");
    await f.session.prompt("and again");
    const after = f.main.slice(before);
    assert.equal(after.length, 2, "the reminder itself started no turn");
    for (const request of after) assert.equal(reminderIndexes(request.messages).length, 1);
    assertPrefixStable(after);
  },
);

test("real SDK: compaction with nothing owed appends nothing", { timeout: 15000 }, async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("fixture attempted network IO"));
  const empty = await ownerFixture(t);
  const f = await session(t, {
    controller: empty.controller,
    respond: () => ({ content: [{ type: "text", text: "ok ".repeat(200) }] }),
    compaction: { reserveTokens: 1024, keepRecentTokens: 64 },
  });
  for (const prompt of ["first", "second", "third"]) await f.session.prompt(prompt);
  await f.session.compact();
  assert.equal(f.lookups.length, 1, "the production handler ran");
  assert(
    !f.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom_message" && entry.customType === compactionReminderMessage,
      ),
  );
});
