// Real pinned SDK + scripted local provider only. No live model, credentials,
// network, installed-runtime or human-terminal acceptance claims.
//
// The production adapter, gate, activity observer and transcript projection are
// loaded from source through jiti (`fsCache: false`), never a stale dist build.
// The child is a real `createAgentSession` with a synthetic in-memory provider;
// the scripted responses are the only "model" and no tool executes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Per-file process isolation; never discover the operator's skills or settings.
// Must run before SDK and source imports: several of those read HOME / agent
// dir while the module is initializing, not only when a session is created.
const isolatedEnvKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
];
const previousEnv = Object.fromEntries(isolatedEnvKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "alehouse-input-origin-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
// Bound project .agents ancestor discovery as well as user-level discovery.
await mkdir(join(home, ".git"));
test.after(async () => {
  for (const key of isolatedEnvKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await rm(home, { recursive: true, force: true });
});

const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ChildRunGate, PiAgentSessionAdapter } = await jiti.import(
  "../../src/orchestration/runtime/agent-session.ts",
);
const { ChildActivity } = await jiti.import("../../src/orchestration/runtime/activity-observer.ts");
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { createTranscriptMessageCache } = await jiti.import(
  "../../src/orchestration/ui/detail-transcript-cache.ts",
);
const { softBudgetMessage } = await jiti.import("../../src/orchestration/core/owner-controller.ts");

sdk.initTheme(undefined, false);

const deferred = () => Promise.withResolvers();
const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
};

const userMessages = (entries) =>
  (entries ?? [])
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => entry.message);
const textOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("");

function textDelta(stream, message, text, index = 0) {
  const part = { type: "text", text };
  message.content[index] = part;
  stream.push({ type: "text_start", contentIndex: index, partial: message });
  stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: message });
}

/** A real SDK session over the scripted provider, with the production adapter,
 * gate and activity observer wired exactly as the child factory wires them. */
async function fixture(t, respond) {
  const root = await mkdtemp(join(home, "alehouse-input-origin-"));
  const network = t.mock.method(globalThis, "fetch", () => {
    assert.fail("input origin fixture attempted network IO");
  });
  const activity = new ChildActivity(root);
  const handlers = new Map();
  // Observe the activity's own registered handlers so the test can trigger the
  // real compaction invalidation without scripting a whole compaction.
  const activityExtension = (pi) =>
    activity.extension({
      on(name, handler) {
        handlers.set(name, handler);
        pi.on(name, handler);
      },
    });
  const gate = new ChildRunGate();
  const events = [];
  let attempts = 0;
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  runtime.registerProvider("input-origin", {
    api: "input-origin",
    apiKey: "synthetic-not-a-credential",
    baseUrl: "https://invalid.invalid",
    models: [
      {
        id: "controlled",
        name: "Controlled input origin",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model) {
      const attempt = ++attempts,
        stream = ai.createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "pending",
        usage: structuredClone(usage),
        timestamp: Date.now(),
      };
      void (async () => {
        stream.push({ type: "start", partial: message });
        try {
          await respond({ attempt, stream, message });
          if (message.stopReason === "pending") message.stopReason = "stop";
        } catch (error) {
          message.stopReason = "error";
          message.errorMessage = String(error);
        }
        if (message.stopReason === "error")
          stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })();
      return stream;
    },
  });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => "Only answer the synthetic fixture.",
    extensionFactories: [activityExtension, gate.extension],
  });
  await loader.reload();
  const created = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(root),
    resourceLoader: loader,
    modelRuntime: runtime,
    model: runtime.getModel("input-origin", "controlled"),
    tools: [],
  });
  const session = created.session;
  await session.bindExtensions({});
  session.subscribe((event) => events.push(event.type));
  const observed = [];
  const port = new PiAgentSessionAdapter({
    session,
    parentBus: { emit() {} },
    gate,
    readiness() {},
    observeInput(message, origin) {
      observed.push({ message, origin });
      activity.recordInputOrigin(message, origin);
    },
  });
  const callbacks = {
    inputEntered() {},
    output() {},
    outputDelta() {},
    turnStart() {},
    turnEnd() {},
    question() {
      return "recorded";
    },
    alert() {},
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return undefined;
    disposed = true;
    return port.dispose();
  };
  t.after(async () => {
    try {
      await dispose().catch(() => {});
      assert.equal(network.mock.callCount(), 0, "fixture must not touch the network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    activity,
    handlers,
    gate,
    session,
    port,
    callbacks,
    events,
    observed,
    dispose,
  };
}

function transcriptOver(f) {
  const cache = createTranscriptMessageCache();
  const transcript = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 100, rows: 30 } },
    cwd: f.root,
    markdownTheme: sdk.getMarkdownTheme(),
    source: {
      messages: () => cache.messages(f.activity),
      inFlight: () => f.activity.inFlight(),
      toolDefinition: () => undefined,
      inputOrigin: (message) => f.activity.inputOrigin(message),
    },
  });
  return { transcript, cache };
}

const paint = (transcript, width = 100) =>
  transcript.slice(width, 0, transcript.lineCount(width)).join("\n");

test(
  "real SDK: the initial parent prompt is labeled from parent end-to-end",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async ({ stream, message }) => {
      textDelta(stream, message, "ORIGIN_ANSWER");
    });
    const facts = await f.port.run("ORIGIN_TASK", f.callbacks);
    assert.equal(facts.kind, "success");
    const messages = userMessages(f.activity.entries());
    const task = messages.find((message) => textOf(message) === "ORIGIN_TASK");
    assert(task, "the SDK persisted the exact prompt text");
    assert.equal(f.activity.inputOrigin(task), "parent");
    assert.equal(f.observed.length, 1);
    assert.equal(f.observed[0].message, task, "the observed object is the persisted message");
    assert.equal(f.observed[0].origin, "parent");

    const { transcript } = transcriptOver(f);
    t.after(() => transcript.dispose());
    const painted = paint(transcript);
    assert.match(painted, /From parent/);
    assert.match(painted, /ORIGIN_TASK/);
    assert.doesNotMatch(painted, /From user|Alehouse input/);
  },
);

test(
  "real SDK: concurrent identical parent/human steers and the orchestration soft budget keep exact origins",
  { timeout: 15000 },
  async (t) => {
    const streaming = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    const f = await fixture(t, async ({ attempt, stream, message }) => {
      if (attempt === 1) {
        streaming.resolve();
        await release.promise;
      }
      textDelta(stream, message, `STEER_ANSWER_${attempt}`);
    });
    const running = f.port.run("ORIGIN_TASK", f.callbacks);
    await streaming.promise;
    assert.equal(f.session.isStreaming, true, "the scripted response is still streaming");
    const valid = () => true;
    const accepted = await Promise.all([
      f.port.steer("IDENTICAL_BODY", valid, "parent"),
      f.port.steer("IDENTICAL_BODY", valid, "human"),
      f.port.steer(softBudgetMessage, valid, "orchestration"),
    ]);
    assert.deepEqual(accepted, [true, true, true], "every ticket-admitted steer was accepted");
    release.resolve();
    const facts = await running;
    assert.equal(facts.kind, "success");

    const messages = userMessages(f.activity.entries());
    const body = messages.filter((message) => textOf(message) === "IDENTICAL_BODY");
    assert.equal(body.length, 2, "both identical steers reached the transcript");
    assert.notEqual(body[0], body[1], "identical text never collapses message identity");
    assert.deepEqual(body.map((message) => f.activity.inputOrigin(message)).sort(), [
      "human",
      "parent",
    ]);
    const soft = messages.filter((message) => textOf(message) === softBudgetMessage);
    assert.equal(soft.length, 1);
    assert.equal(f.activity.inputOrigin(soft[0]), "orchestration");
    const task = messages.find((message) => textOf(message) === "ORIGIN_TASK");
    assert.equal(f.activity.inputOrigin(task), "parent");
    for (const { message } of f.observed)
      assert(messages.includes(message), "every observed object is a persisted message");

    const { transcript } = transcriptOver(f);
    t.after(() => transcript.dispose());
    const painted = paint(transcript);
    assert.match(painted, /From parent/);
    assert.match(painted, /From user/);
    assert.match(painted, /Alehouse input/);
  },
);

test(
  "real SDK: confirmed origins survive projection, compaction invalidation and disposal",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async ({ stream, message }) => {
      textDelta(stream, message, "RETAINED_ANSWER");
    });
    await f.port.run("RETAINED_TASK", f.callbacks);
    const entries = f.activity.entries();
    const task = userMessages(entries).find((message) => textOf(message) === "RETAINED_TASK");
    assert(task);
    assert.equal(f.activity.inputOrigin(task), "parent");

    const { transcript, cache } = transcriptOver(f);
    t.after(() => transcript.dispose());
    const projected = cache.messages(f.activity);
    assert(projected.includes(task), "projection preserves the exact message identity");
    assert.match(paint(transcript), /From parent/);

    f.handlers.get("session_before_compact")();
    assert.equal(f.activity.inputOrigin(task), "parent", "compaction invalidation retains it");

    const report = await f.dispose();
    assert.equal(report.shutdownExited, true, "the fixture child confirms shutdown");
    assert.deepEqual(report.errors, []);
    assert(
      (f.activity.entries() ?? []).some((entry) => entry.message === task),
      "disposal does not sever the retained SessionManager reference",
    );
    assert.equal(f.activity.inputOrigin(task), "parent", "dispose retains the origin");
    transcript.invalidate();
    assert.match(paint(transcript), /From parent/, "the retained pane repaints after disposal");
    assert.match(paint(transcript), /RETAINED_TASK/);
  },
);
