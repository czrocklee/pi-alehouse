import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const load = createJiti(import.meta.url).import;
const {
  quotaReadingsFromHeaders,
  quotaReadingsFromStream,
  codexDisplayFromHeaders,
  codexDisplayFromStream,
  mergeCodexDisplay,
} = await load("../../src/extensions/lib/codex-quota.ts");
const { installQuotaObserver, childQuotaObserver } = await load(
  "../../src/extensions/lib/quota-observer.ts",
);

const readingKey = Symbol.for("pi-alehouse:quota-reading:v1");
const native = "openai-codex";
const when = 1_800_000_000;
const window = (name, used, fields) => ({ pool: "codex", window: name, used_pct: used, ...fields });
const model = (provider, id = "same", api = "openai-codex-responses") => ({ provider, id, api });
const quotaEvent = {
  type: "codex.rate_limits",
  rate_limits: { primary: { used_percent: 21 } },
  credits: { has_credits: true, unlimited: false, balance: "1.23" },
};
const headerResponse = {
  status: 429,
  headers: {
    "x-codex-primary-used-percent": "14",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "60",
    authorization: "never outbound",
  },
};
const headerRow = window("primary", 14, { duration_s: 18_000, resets_at: when + 60 });

function useReadingSink(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, readingKey);
  delete globalThis[readingKey];
  t.after(() => {
    delete globalThis[readingKey];
    if (previous) Object.defineProperty(globalThis, readingKey, previous);
  });
  t.mock.method(Date, "now", () => when * 1_000 + 125);
  return (sink) => {
    globalThis[readingKey] = sink;
  };
}
const reading = (provider, ...windows) => ({ provider, observedAt: when + 0.125, windows });

function session(t, install, runtime, sessionId) {
  const handlers = new Map();
  install({ on: (type, handler) => handlers.set(type, handler) });
  assert.deepEqual([...handlers.keys()], ["session_start", "session_shutdown"]);
  const ctx = {
    model: model("xai", "selected", "openai-completions"),
    modelRegistry: { runtime },
    sessionManager: { getSessionId: () => sessionId },
  };
  const start = () => handlers.get("session_start")({}, ctx);
  const end = handlers.get("session_shutdown");
  t.after(end);
  start();
  return { start, end };
}

function runtimeFixture() {
  const originalCalls = [];
  const dispatchReturn = Symbol("original dispatch return");
  const stream = Symbol("original hook return");
  let captured;
  const context = { systemPrompt: "synthetic private prompt" };
  const runtime = {
    streamSimple(selected, transcript, options) {
      assert.equal(this, runtime);
      assert.equal(transcript, context);
      captured = { selected, options };
      return dispatchReturn;
    },
  };
  function dispatch(sessionId, selected, extra) {
    const options = {
      sessionId,
      onResponse(...args) {
        assert.equal(this, options);
        originalCalls.push(["http", ...args]);
        return stream;
      },
      onProviderStreamEvent(...args) {
        assert.equal(this, options);
        originalCalls.push(["stream", ...args]);
        return stream;
      },
      ...extra,
    };
    assert.equal(runtime.streamSimple(selected, context, options), dispatchReturn);
    assert.equal(captured.selected, selected);
    return captured.options;
  }
  return { runtime, dispatch, originalCalls, stream };
}

test("Codex window parsers are sparse and precise without reading unrelated headers", () => {
  const headers = new Proxy(
    {
      "x-codex-primary-used-percent": "0",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "60",
      "x-codex-secondary-used-percent": "101",
    },
    {
      ownKeys() {
        assert.fail("must not enumerate raw headers");
      },
    },
  );
  assert.deepEqual(quotaReadingsFromHeaders(headers, when), [
    window("primary", 0, { duration_s: 18000, resets_at: when + 60 }),
  ]);
  const stream = { primary: { used_percent: 0.125 }, secondary: { used_percent: "1" } };
  const cached = mergeCodexDisplay(undefined, codexDisplayFromHeaders(headers, when));
  assert.equal(
    mergeCodexDisplay(cached, codexDisplayFromStream(stream)).primary.resetsAt,
    when + 60,
  );
  assert.deepEqual(
    quotaReadingsFromStream(stream, when + 1),
    [window("primary", 0.125)],
    "display metadata must not feed back into a new reading",
  );
  assert.deepEqual(
    quotaReadingsFromStream({ primary: { used_percent: 10, reset_at: "broken" } }, when),
    [],
  );
  assert.deepEqual(
    quotaReadingsFromHeaders(
      { "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "NaN" },
      when,
    ),
    [],
  );
});

test("plain Pi starts observing before a sink exists; the sink gets only fresh numeric windows", (t) => {
  const setSink = useReadingSink(t);
  const { runtime, dispatch, originalCalls, stream } = runtimeFixture();
  const displays = [];
  const { end } = session(
    t,
    (pi) => installQuotaObserver(pi, (...args) => displays.push(args)),
    runtime,
    "plain",
  );
  const physical = model("codex-personal");
  const options = dispatch("plain", physical);
  assert.equal(options.onResponse(headerResponse, physical), stream);
  assert.equal(displays.length, 1, "the local footer doesn't require a consumer");
  const samples = [];
  setSink((...args) => samples.push(args));
  assert.equal(options.onResponse(headerResponse, physical), stream);
  assert.equal(options.onResponse(headerResponse, physical), stream);
  assert.equal(options.onProviderStreamEvent(quotaEvent, physical), stream);
  options.onResponse({ headers: {} }, physical);
  options.onProviderStreamEvent({ ...quotaEvent, metered_limit_name: "other" }, physical);
  options.onProviderStreamEvent({ ...quotaEvent, rate_limits: {} }, physical);
  assert.deepEqual(samples, [
    [reading("codex-personal", headerRow)],
    [reading("codex-personal", headerRow)],
    [reading("codex-personal", window("primary", 21))],
  ]);
  assert.deepEqual(originalCalls.slice(0, 4), [
    ["http", headerResponse, physical],
    ["http", headerResponse, physical],
    ["http", headerResponse, physical],
    ["stream", quotaEvent, physical],
  ]);
  assert.deepEqual(displays[3][2], { hasCredits: true, unlimited: false, balance: "1.23" });
  end();
  options.onResponse(headerResponse, physical);
  assert.equal(samples.length, 3, "retired dispatch hooks never publish");
});

test("parent and child share a runtime, attributing only bound physical dispatches", (t) => {
  const setSink = useReadingSink(t);
  const { runtime, dispatch } = runtimeFixture();
  const original = runtime.streamSimple;
  const displays = [];
  const parent = session(
    t,
    (pi) => installQuotaObserver(pi, (...args) => displays.push(args)),
    runtime,
    "parent",
  );
  const wrapped = runtime.streamSimple;
  const child = session(t, childQuotaObserver, runtime, "child");
  assert.equal(runtime.streamSimple, wrapped, "a shared runtime is wrapped once");
  const samples = [];
  setSink((value) => samples.push(value));
  const parentModel = model(native);
  const childModel = model("worker-account");
  const reportedModel = model("provider-relabelled");
  const parentRequest = dispatch("parent", parentModel);
  const childRequest = dispatch("child", childModel);
  childRequest.onProviderStreamEvent(quotaEvent, parentModel);
  childRequest.onProviderStreamEvent(quotaEvent, { ...childModel, id: "different-id" });
  childRequest.onProviderStreamEvent(quotaEvent, { ...childModel, api: "openai-responses" });
  childRequest.onResponse(headerResponse, model(reportedModel.provider, "different-id"));
  childRequest.onResponse(
    headerResponse,
    model(reportedModel.provider, "same", "openai-responses"),
  );
  childRequest.onResponse(headerResponse, undefined);
  for (const provider of [null, "", 42, "white space", "invisible\u0000control"])
    childRequest.onResponse(headerResponse, { ...reportedModel, provider });
  childRequest.onResponse(headerResponse, { ...reportedModel, provider: undefined });
  dispatch("unbound", parentModel).onResponse(headerResponse, parentModel);
  dispatch("parent", model(" ")).onResponse(headerResponse, parentModel);
  dispatch("parent", parentModel, { disableContinuation: true }).onResponse(
    headerResponse,
    parentModel,
  );
  dispatch("parent", model("virtual", "route", "pi-virtual")).onResponse(
    headerResponse,
    parentModel,
  );
  dispatch("parent", model("xai", "same", "openai-responses")).onResponse(
    headerResponse,
    parentModel,
  );
  assert.deepEqual(samples, [], "no observation for ambiguous stream or non-Codex requests");
  childRequest.onResponse(headerResponse, reportedModel);
  parentRequest.onResponse(headerResponse, childModel);
  assert.deepEqual(displays, [], "mixed HTTP identity is not proof for the display");
  childRequest.onProviderStreamEvent(quotaEvent, childModel);
  parentRequest.onProviderStreamEvent(quotaEvent, parentModel);
  assert.deepEqual(samples, [
    { ...reading(childModel.provider, headerRow), responseProvider: reportedModel.provider },
    { ...reading(native, headerRow), responseProvider: childModel.provider },
    reading(childModel.provider, window("primary", 21)),
    reading(native, window("primary", 21)),
  ]);
  assert.deepEqual(
    displays.map(([provider]) => provider),
    [native],
    "no child display bleed",
  );
  child.start();
  childRequest.onResponse(headerResponse, reportedModel);
  assert.equal(samples.length, 4, "a stale callback can't borrow a replacement subscription");
  const replacement = dispatch("child", childModel);
  replacement.onResponse(headerResponse, childModel);
  assert.deepEqual(samples.slice(4), [reading(childModel.provider, headerRow)]);
  child.end();
  replacement.onResponse(headerResponse, childModel);
  assert.equal(samples.length, 5);
  assert.equal(runtime.streamSimple, wrapped);
  parent.end();
  assert.equal(runtime.streamSimple, original);
});

test("optional observation failures and returned promises cannot change SDK callbacks", (t) => {
  const setSink = useReadingSink(t);
  const { runtime, dispatch } = runtimeFixture();
  let renders = 0;
  session(
    t,
    (pi) =>
      installQuotaObserver(pi, () => {
        renders++;
        throw new Error("fixture display failure");
      }),
    runtime,
    "parent",
  );
  const physical = model(native);
  const returned = Promise.resolve();
  const error = new Error("fixture SDK callback failure");
  const outbound = dispatch("parent", physical, {
    onResponse: () => returned,
    onProviderStreamEvent: () => {
      throw error;
    },
  });
  setSink(() => {
    throw new Error("fixture consumer failure");
  });
  assert.equal(outbound.onResponse(headerResponse, physical), returned);
  assert.equal(renders, 1);
  setSink(() => Promise.reject(new Error("fixture accidental async consumer failure")));
  assert.throws(
    () => outbound.onProviderStreamEvent(quotaEvent, physical),
    (e) => e === error,
  );
  assert.equal(renders, 2);
  let observations = 0;
  setSink(() => observations++);
  assert.equal(outbound.onResponse(headerResponse, physical), returned);
  assert.equal(observations, 1, "a failed observation does not disable later observations");
});
