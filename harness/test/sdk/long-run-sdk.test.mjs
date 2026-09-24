// Real development SDK with deterministic provider IO; no credentials, network,
// managed-permission acceptance, live model or deployment claims.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { ChildRunGate, PiAgentSessionAdapter } from "../../dist/runtime/agent-session.js";
import { PiRunJournal } from "../../dist/history/run-journal.js";
import { readSdkRun } from "../../dist/history/history-reader.js";
import { until } from "../support/controller-fixture.mjs";

const usage = (cost) => ({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const latch = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const allPartial = ["input", "output", "cache_read", "cache_write", "cost"];
async function fixture(t, respond, { window = 8192, retry = false, controllerOptions = {}, invalidateApproval, extensions = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-long-run-"));
  const requests = [], events = [], gate = new ChildRunGate();
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json") });
  runtime.registerProvider("harness-long-run", {
    api: "harness-long-run", apiKey: "synthetic-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "controlled", name: "Controlled long run", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: window, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const summary = ai.getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant.");
      const request = { summary, context: structuredClone(context), signal: options?.signal,
        index: requests.filter((r) => r.summary === summary).length + 1 };
      requests.push(request);
      void (async () => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason: "pending", usage: usage(summary ? 0.5 : 1), timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        try {
          const result = await respond(request);
          if (result.deltas) {
            const part = { type: "text", text: "" }; message.content = [part];
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            for (const delta of result.deltas) {
              part.text += delta;
              stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
            }
            stream.push({ type: "text_end", contentIndex: 0, content: part.text, partial: message });
          }
          message.content = result.tools ?? [{ type: "text", text: result.text ?? "SUMMARY" }];
          message.stopReason = result.reason ?? (result.tools ? "toolUse" : "stop");
          message.errorMessage = result.error;
          if (result.usage) message.usage = result.usage;
        } catch (error) {
          message.stopReason = request.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
        }
        if (["error", "aborted"].includes(message.stopReason)) stream.push({ type: "error", reason: message.stopReason, error: message });
        else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })();
      return stream;
    },
  });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 512 },
    retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1, provider: { maxRetries: 0 } } });
  const parent = sdk.SessionManager.create(root, root), manager = sdk.SessionManager.create(root, root);
  parent.appendMessage({ role: "user", content: "fixture parent", timestamp: Date.now() });
  parent.appendMessage({ role: "assistant", api: "harness-long-run", provider: "harness-long-run", model: "controlled",
    content: [{ type: "text", text: "parent" }], stopReason: "stop", usage: usage(0), timestamp: Date.now() });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Only execute the fixture task.",
    extensionFactories: [...extensions, gate.extension] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
    settingsManager: settings, sessionManager: manager, modelRuntime: runtime, model: runtime.getModel("harness-long-run", "controlled"),
    tools: ["blob"], customTools: [{ name: "blob", description: "Return deterministic fixture text",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "z".repeat(40000) }] }) }] });
  await session.bindExtensions({});
  session.subscribe((event) => events.push(event));
  const history = new PiRunJournal({ parent, session: manager });
  const port = new PiAgentSessionAdapter({ session, parentBus: { emit() {} }, gate, history, readiness() {}, invalidateApproval });
  const controller = await OwnerController.open({ owner: { owner_id: parent.getSessionId(), generation: randomUUID(), assertHeld() {}, close() {} },
    createSession: async () => port, ...controllerOptions });
  t.after(async () => {
    const stopped = await controller.shutdown(2000);
    assert.equal(stopped.closed, true, "fixture must confirm shutdown");
    await rm(root, { recursive: true, force: true });
  });
  const task = (prompt = "Call blob, then finish.") => ({ prompt, description: "controlled long task", settings: {
    provider: "harness-long-run", model: "controlled", thinking: "off", parent_thinking: "off",
    thinking_resolution: "identity", profile: "reader",
    difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "b".repeat(64), cwd: root,
    tools: ["blob"], definition_digest: "a".repeat(64) } });
  const submit = (request = task()) => controller.submit(randomUUID(), request);
  const end = async (run) => {
    const waited = await controller.wait([run.run_id], { mode: "all", timeout_ms: 3000 });
    assert.equal(waited.reason, "condition"); return controller.view(run.run_id);
  };
  const historical = (run) => readSdkRun({ sessionManager: sdk.SessionManager, parentFile: parent.getSessionFile(), sessionDirectory: root, run_id: run.run_id });
  return { root, session, manager, controller, port, gate, requests, events, submit, end, historical, task };
}
const blob = { tools: [{ type: "toolCall", id: "large-output", name: "blob", arguments: {} }] };

const callbackFaults = [
  ["inputEntered", "inputEntered", () => true],
  ["turnStart", "turnStart", () => true],
  ["turnEnd", "turnEnd", () => true],
  ["output-start", "output", (value) => value.text === ""],
  ["output-delta", "output", (value) => value.text === "CALLBACK_"],
  ["output-end", "output", (value) => value.text === "CALLBACK_FINAL"],
];
for (const [point, method, matches] of callbackFaults) for (const persistent of [false, true]) {
  test(`real SDK: ${point} callback failure is contained without success or reuse (persistent=${persistent})`, { timeout: 10000 }, async (t) => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("callback fixture attempted network IO"); });
    const f = await fixture(t, async () => ({ text: "CALLBACK_FINAL", deltas: ["CALLBACK_"] }));
    const original = f.port.run.bind(f.port), subscribe = f.session.subscribe.bind(f.session);
    let failures = 0, listeners = 0;
    t.mock.method(f.session, "subscribe", (listener) => {
      listeners++; const off = subscribe(listener);
      return () => { listeners--; off(); };
    });
    t.mock.method(f.port, "run", (prompt, callbacks) => original(prompt, { ...callbacks,
      [method](...args) {
        if (matches(...args) && (!failures || persistent)) {
          failures++; throw new Error(`CONTROL_CALLBACK_FAILED:${point}`);
        }
        return callbacks[method](...args);
      },
    }));
    const run = await f.submit(f.task("Finish once")), result = await f.end(run);
    assert(failures > 0, "the actual SDK event must reach the selected callback");
    assert.equal(result.status, "failed");
    if (["output-end", "turnEnd"].includes(point)) {
      assert.equal(result.usage.total.cost, 1, "an observed priced response must survive its callback's failure");
    }
    assert.equal(result.resumable, false);
    assert.equal(result.unavailable_reason, "run_callback_failed");
    assert.match(result.outcome.error, /CONTROL_CALLBACK_FAILED/);
    assert.equal(result.execution_exited, true); assert.equal(result.finalization_pending, false);
    assert.equal(result.resident, false); assert.equal(f.session.isIdle, true); assert.equal(listeners, 0);
    assert.equal(failures, 1, "after a failed control sink, further callbacks cannot amplify diagnostics");
    await assert.rejects(f.submit({ resume: run.agent_id, prompt: "must not reuse" }), { code: "AGENT_UNAVAILABLE" });
    assert(f.requests.length <= 1, "a callback fault must not dispatch another provider request");
    assert.equal(f.controller.drainUsage()?.total.cost ?? 0, result.usage?.total.cost ?? 0);
    assert.equal(f.controller.drainUsage(), undefined);
  });
}

for (const rejects of [false, true]) for (const revokeThrows of [false, true]) test(`real SDK: opaque callback failure retains ownership through its tracked abort (rejects=${rejects}, revokeThrows=${revokeThrows})`, { timeout: 10000 }, async (t) => {
  const released = latch(), abortEntered = latch(), order = [];
  t.after(() => released.resolve());
  t.mock.method(globalThis, "fetch", () => { assert.fail("callback fixture attempted network IO"); });
  const f = await fixture(t, async () => ({ text: "CALLBACK_FINAL" }), {
    invalidateApproval() { order.push("invalidate"); if (revokeThrows) throw new Error("APPROVAL_REVOCATION_FAILED"); },
  });
  const original = f.port.run.bind(f.port), abort = f.session.abort.bind(f.session);
  const disposed = t.mock.method(f.session, "dispose", f.session.dispose.bind(f.session));
  t.mock.method(f.session, "abort", async () => {
    order.push("abort");
    await abort(); abortEntered.resolve(); await released.promise;
    if (rejects) throw new Error("TRACKED_ABORT_REJECTED");
  });
  t.mock.method(f.port, "run", (prompt, callbacks) => original(prompt, { ...callbacks,
    turnEnd(...args) { callbacks.turnEnd(...args); throw Object.create(null); },
  }));
  const run = await f.submit(f.task("Finish once")); await abortEntered.promise;
  await until(() => f.controller.view(run.run_id).drain?.waiting_for === "deliveries");
  const held = f.controller.view(run.run_id);
  assert.deepEqual(order.slice(0, 2), ["invalidate", "abort"], "revocation must be attempted synchronously before stopping");
  assert.equal(f.session.isIdle, true, "SDK idle alone does not finish our tracked abort");
  assert.equal(held.execution_exited, false); assert.equal(held.resident, true);
  assert.equal(f.controller.closed, false); assert.equal(f.controller.stats().active, 1);
  assert.equal(held.usage.total.cost, 1);
  assert.equal(disposed.mock.callCount(), 0);
  await assert.rejects(f.port.dispose(), /EXECUTION_NOT_EXITED/);
  assert.equal((await f.controller.wait([run.run_id], { mode: "all", timeout_ms: 10 })).reason, "timeout");
  released.resolve(); const result = await f.end(run);
  assert.equal(result.status, "failed"); assert.equal(result.unavailable_reason, "run_callback_failed");
  assert.equal(result.resumable, false); assert.equal(result.execution_exited, true);
  assert.equal(result.drain, undefined); assert.equal(result.resident, false);
  assert.match(result.outcome.error, /Unprintable failure/);
  if (revokeThrows) assert.match(result.outcome.error, /APPROVAL_REVOCATION_FAILED/);
  assert.doesNotMatch(result.outcome.error, /SDK_IDLE_NOT_CONFIRMED/);
  assert.equal(result.usage.total.cost, 1);
  assert.equal(f.controller.getResult(run.run_id).text, "CALLBACK_FINAL", "already accepted output survives the fault");
  assert.equal(f.gate.uncertain, rejects);
  assert.equal(disposed.mock.callCount(), 1);
});

for (const revokeThrows of [false, true]) test(`real SDK: callback failure attempts revocation before abort while root execution is held (revokeThrows=${revokeThrows})`, { timeout: 10000 }, async (t) => {
  const entered = latch(), released = latch(), order = [];
  t.after(() => released.resolve());
  t.mock.method(globalThis, "fetch", () => { assert.fail("callback fixture attempted network IO"); });
  const f = await fixture(t, async () => ({ text: "CALLBACK_FINAL" }), {
    invalidateApproval() { order.push("invalidate"); if (revokeThrows) throw new Error("APPROVAL_REVOCATION_FAILED"); },
    // Extensions precede public listeners for the same event. Hold the next
    // agent_end event, after the public turn_end callback has already failed.
    extensions: [(pi) => pi.on("agent_end", async () => {
      order.push("extension"); entered.resolve(); await released.promise;
    })],
  });
  const original = f.port.run.bind(f.port), abort = f.session.abort.bind(f.session);
  const disposed = t.mock.method(f.session, "dispose", f.session.dispose.bind(f.session));
  t.mock.method(f.session, "abort", () => { order.push("abort"); return abort(); });
  t.mock.method(f.port, "run", (prompt, callbacks) => original(prompt, { ...callbacks,
    turnEnd() { throw new Error("CONTROL_CALLBACK_FAILED:turnEnd"); },
  }));
  const run = await f.submit(f.task("Finish once")); await entered.promise;
  assert.deepEqual(order, ["invalidate", "abort", "extension"]);
  assert.equal(f.session.isIdle, false);
  assert.equal(f.controller.view(run.run_id).execution_exited, false);
  assert.equal(f.controller.stats().active, 1); assert.equal(disposed.mock.callCount(), 0);
  await assert.rejects(f.port.dispose(), /EXECUTION_NOT_EXITED/);
  assert.equal((await f.controller.wait([run.run_id], { mode: "all", timeout_ms: 10 })).reason, "timeout");
  released.resolve(); const result = await f.end(run);
  assert.equal(result.status, "failed"); assert.equal(result.unavailable_reason, "run_callback_failed");
  assert.equal(result.resumable, false); assert.equal(result.usage.total.cost, 1);
  assert.match(result.outcome.error, /CONTROL_CALLBACK_FAILED:turnEnd/);
  if (revokeThrows) assert.match(result.outcome.error, /APPROVAL_REVOCATION_FAILED/);
  assert.equal(result.execution_exited, true); assert.equal(result.resident, false);
  assert.equal(disposed.mock.callCount(), 1);
});

test("real SDK: compaction continues one Run, counts summary once, and resume preserves history boundaries", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.summary ? { text: "SUMMARY_MARKER" } : r.index === 1 ? blob : { text: `FINAL_${r.index}` });
  const first = await f.submit(), a = await f.end(first);
  assert.equal(a.status, "completed"); assert.equal(a.turns, 2);
  assert.equal(f.controller.getResult(first.run_id).text, "FINAL_2");
  assert.equal(a.usage.total.cost, 2.5); assert.deepEqual(a.usage.partial, []);
  assert.equal(a.usage.byModel["harness-long-run/controlled"].cost, 2);
  assert.equal(a.usage.byModel["compaction/harness-long-run/controlled"].cost, 0.5);
  assert.equal(f.requests.filter((r) => r.summary).length, 1);
  assert.match(JSON.stringify(f.requests.at(-1).context), /SUMMARY_MARKER/);
  const second = await f.submit({ resume: first.agent_id, prompt: "Follow up after compaction" });
  const b = await f.end(second);
  assert.equal(b.status, "completed"); assert.equal(b.agent_id, a.agent_id);
  assert.equal(b.history_ref.session_id, a.history_ref.session_id);
  const recorded = await f.historical(first);
  assert.equal(recorded.output.text, "FINAL_2");
  assert.deepEqual(recorded.usage, a.usage);
  assert.deepEqual(recorded.routing, { preset: "fixture", preset_version: "v1", selection_digest: "b".repeat(64),
    difficulty: 3, strength: "standard", thinking: "off", parent_thinking: "off", thinking_resolution: "identity",
    provider: "harness-long-run", model: "controlled", profile: "reader" });
  assert.equal((await f.historical(second)).output.text, "FINAL_3");
  assert.equal(f.controller.drainUsage().total.cost, a.usage.total.cost + b.usage.total.cost);
  assert.equal(f.controller.drainUsage(), undefined);
});

test("real SDK: overflow compact-and-retry stays in one Run and cannot loop forever", { timeout: 10000 }, async (t) => {
  let failures = 0;
  const f = await fixture(t, async (r) => r.summary ? { text: "OVERFLOW_SUMMARY" } : r.index === 1 ? { text: "seed ".repeat(600) } :
    ++failures <= 2 ? { reason: "error", error: "maximum context length exceeded" } : { text: "recovered" }, { window: 128000 });
  const first = await f.submit(f.task("seed ".repeat(1000))); await f.end(first);
  const second = await f.submit({ resume: first.agent_id, prompt: "cause overflow" }), result = await f.end(second);
  assert.equal(result.status, "failed"); assert.equal(result.model_stop_reason, "error");
  assert.equal(result.turns, 2);
  assert.equal(f.requests.filter((r) => r.summary).length, 1);
  assert.equal(result.usage.total.cost, 2.5);
  assert.deepEqual(result.usage.partial, allPartial, "failed ordinary responses cannot certify complete usage");
  assert.equal(result.usage.byModel["compaction/harness-long-run/controlled"].cost, 0.5,
    "unpaired recovery-exhausted compaction_end incurred no new summary call");
  const third = await f.submit({ resume: first.agent_id, prompt: "recover now" });
  const recovered = await f.end(third);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.usage.partial, [], "a separate successful Run starts a fresh ledger");
});

test("real SDK: successful overflow recovery returns only final output", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.summary ? { text: "RECOVERY_SUMMARY" } : r.index === 2 ?
    { reason: "error", error: "maximum context length exceeded" } : { text: r.index === 1 ? "seed ".repeat(600) : "RECOVERED" }, { window: 128000 });
  const first = await f.submit(f.task("seed ".repeat(1000))); await f.end(first);
  const second = await f.submit({ resume: first.agent_id, prompt: "overflow once" }), result = await f.end(second);
  assert.equal(result.status, "completed"); assert.equal(result.usage.total.cost, 2.5);
  assert.deepEqual(result.usage.partial, allPartial, "successful recovery retains the failed response's uncertainty");
  assert.equal(f.controller.getResult(second.run_id).text, "RECOVERED");
  assert(f.events.some((e) => e.type === "compaction_end" && e.willRetry));
});

test("real SDK: summary retry preserves observed cost but marks hidden attempts incomplete", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.summary ? r.index === 1 ? { reason: "error", error: "503 service unavailable" } : { text: "RETRIED_SUMMARY" } :
    r.index === 1 ? blob : { text: "DONE" }, { retry: true });
  const run = await f.submit(), result = await f.end(run);
  assert.equal(result.status, "completed"); assert.equal(result.usage.total.cost, 2.5);
  assert.equal(result.usage.byModel["compaction/harness-long-run/controlled"].cost, 0.5);
  assert.deepEqual(result.usage.partial, allPartial);
  assert.equal(f.requests.filter((r) => r.summary).length, 2);
  assert(f.events.some((e) => e.type === "summarization_retry_scheduled"));
});

test("real SDK: split compaction failure retains ordinary spend and marks the lost successful summary incomplete", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.summary ? r.index === 1 ? { text: "SUCCESSFUL_HISTORY_SUMMARY" } :
    { reason: "error", error: "fixture permanent summary failure" } : r.index === 2 ? blob : { text: "DONE" });
  const seed = await f.submit(f.task("old history ".repeat(500))); await f.end(seed);
  const run = await f.submit({ resume: seed.agent_id, prompt: "call blob then finish" }), result = await f.end(run);
  assert.equal(f.requests.filter((r) => r.summary).length, 2);
  assert(f.events.some((e) => e.type === "compaction_end" && !e.result && e.errorMessage));
  assert.equal(result.usage.total.cost, 2, "SDK does not expose the already-billed first summary after the second fails");
  assert.equal(result.usage.byModel["compaction/harness-long-run/controlled"].cost, 0);
  assert.deepEqual(result.usage.partial, allPartial);
  assert.deepEqual((await f.historical(run)).usage, result.usage, "cold history preserves the accounting gap");
});

test("real SDK: pre-prompt compaction cancel quarantines escaped admission rather than silently reusing it", { timeout: 10000 }, async (t) => {
  const entered = latch(), release = latch();
  t.after(() => release.resolve());
  const f = await fixture(t, async (r) => {
    if (r.summary) { entered.resolve(r); await release.promise; return { reason: "aborted", error: "fixture cancelled summary" }; }
    return { reason: "aborted", text: "seed ".repeat(600), usage: { ...usage(1), input: 10000, totalTokens: 10010 } };
  });
  const seed = await f.submit(f.task("seed context ".repeat(500))); await f.end(seed);
  const run = await f.submit({ resume: seed.agent_id, prompt: "trigger pre-prompt compaction" });
  const request = await entered.promise;
  assert.equal(f.session.isStreaming, false);
  f.controller.cancel(run.run_id); await new Promise((r) => setImmediate(r));
  assert.equal(request.signal.aborted, true);
  release.resolve(); const result = await f.end(run);
  assert.equal(result.status, "cancelled"); assert.equal(result.resumable, false);
  assert.deepEqual(result.usage.partial, allPartial);
  assert.equal(f.requests.filter((r) => !r.summary).length, 1,
    "observed schedule has no post-cancel provider entry; not an atomic-admission guarantee");
});

test("real SDK: cancel held compaction waits for actual exit, never replays or leaks queued steering", { timeout: 10000 }, async (t) => {
  const entered = latch(), release = latch();
  t.after(() => release.resolve());
  const f = await fixture(t, async (r) => {
    if (r.summary) { entered.resolve(r); await release.promise; return { reason: "aborted", error: "fixture cancellation" }; }
    return r.index === 1 ? blob : { text: "FRESH" };
  });
  const run = await f.submit(); const request = await entered.promise;
  assert.equal(f.controller.view(run.run_id).runtime?.activity, "compacting");
  f.controller.steer(run.run_id, "UNDISPATCHED_OLD_STEER");
  await new Promise((r) => setImmediate(r));
  f.controller.cancel(run.run_id);
  await new Promise((r) => setImmediate(r));
  assert.equal(request.signal.aborted, true);
  const pending = f.controller.view(run.run_id);
  assert.equal(pending.execution_exited, false); assert.equal(pending.resident, true);
  assert.equal(f.controller.stats().active, 1);
  release.resolve(); const result = await f.end(run);
  assert.equal(result.status, "cancelled"); assert.equal(f.requests.filter((r) => !r.summary).length, 1);
  assert.deepEqual(result.usage.partial, allPartial);
  assert.deepEqual(f.session.getSteeringMessages(), []);
  // Already-consumed steering is legitimate history; this marker was never consumed.
  const next = await f.submit({ resume: run.agent_id, prompt: "fresh task" }); await f.end(next);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).context), /UNDISPATCHED_OLD_STEER/);
});

test("real SDK: transient request retries, not the task, and bills each attempt", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.index === 1 ? { reason: "error", error: "503 service unavailable" } : { text: "RETRIED" }, { retry: true });
  const run = await f.submit(f.task("UNIQUE_TASK_PROMPT")), result = await f.end(run);
  assert.equal(result.status, "completed"); assert.equal(result.turns, 2); assert.equal(result.usage.total.cost, 2);
  assert.deepEqual(result.usage.partial, allPartial, "ordinary retry also preserves incomplete failed-response observation");
  assert.equal(result.usage.byModel["compaction/harness-long-run/controlled"], undefined, "no summary attempt was billed");
  assert.deepEqual((await f.historical(run)).usage, result.usage, "END preserves retry uncertainty and reported totals");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].context.messages.filter((m) => m.role === "user" && JSON.stringify(m).includes("UNIQUE_TASK_PROMPT")).length, 1);
});

test("real SDK: retry consumes turn budget and hard stop keeps its reason", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async () => ({ reason: "error", error: "503 service unavailable" }), { retry: true, controllerOptions: { grace_turns: 0 } });
  const run = await f.submit({ ...f.task(), max_turns: 1 }), result = await f.end(run);
  assert.equal(result.status, "failed"); assert.equal(result.outcome.reason, "turn_limit");
  assert.equal(result.turns, 2); assert.equal(result.outcome.limit_reached, true);
  assert.equal(f.requests.length, 1, "hard stop prevents the retry provider call on this schedule");
});

test("real SDK: unrecovered length remains readable and resumable with auto compaction enabled", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => r.index === 1 ? { reason: "length", text: "PARTIAL", usage: { ...usage(1), output: 1024, totalTokens: 1034 } } : { text: "FINISHED" });
  const run = await f.submit(), result = await f.end(run);
  assert.equal(result.status, "failed"); assert.equal(result.outcome.reason, "output_limit");
  assert.equal(result.model_stop_reason, "length"); assert.equal(result.resumable, true);
  assert.equal(f.controller.getResult(run.run_id).text, "PARTIAL");
  const next = await f.submit({ resume: run.agent_id, prompt: "continue" });
  assert.equal((await f.end(next)).status, "completed");
});

test("real SDK: cancel retry backoff does not replay the task; next Run is healthy", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (r) => ({ reason: r.index === 1 ? "error" : "stop", error: r.index === 1 ? "503 service unavailable" : undefined, text: "NEXT" }), { retry: true });
  let cancelled = false;
  f.session.subscribe((event) => {
    if (event.type === "auto_retry_start") {
      cancelled = true;
      f.controller.cancel(f.controller.list()[0].run_id);
    }
  });
  const run = await f.submit(), result = await f.end(run);
  assert(cancelled); assert.equal(result.status, "cancelled"); assert.equal(f.requests.length, 1);
  const next = await f.submit({ resume: run.agent_id, prompt: "next task" });
  assert.equal((await f.end(next)).status, "completed");
});
