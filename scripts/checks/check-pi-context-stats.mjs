#!/usr/bin/env node
// Focused, source-only, offline tests. Real pinned SDK pure projections + synthetic
// ExtensionContexts: no session construction, model, network, credentials or logs.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { collectContextSnapshot, CONTEXT_CATEGORIES } = await jiti.import(
  resolve(root, "src/extensions/lib/context-stats.ts"),
);
const MODEL = {
  provider: "fixture",
  api: "fixture-api",
  id: "fixture-model",
  contextWindow: 10000,
};
const stamp = "2026-01-01T00:00:00.000Z";
const sdkUsage = (tokens) => ({
  tokens,
  contextWindow: 10000,
  percent: tokens === null ? null : tokens / 100,
});
const text = (value) => ({ type: "text", text: value });
const thinking = (value, signature) => ({
  type: "thinking",
  thinking: value,
  ...(signature ? { thinkingSignature: signature } : {}),
});
const call = (id, name = "read", args = { path: "src/example.ts" }) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  provider: MODEL.provider,
  api: MODEL.api,
  model: MODEL.id,
  usage: { reasoning: 0 },
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const user = (content) => ({ role: "user", content, timestamp: 0 });
const result = (id, name = "read", content = [text("fixture output")]) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content,
  isError: false,
  timestamp: 0,
});
const entry = (id, parentId, message) => ({
  type: "message",
  id,
  parentId,
  timestamp: stamp,
  message,
});
function chain(messages) {
  return messages.map((message, index) =>
    entry(`entry-${index}`, index ? `entry-${index - 1}` : null, message),
  );
}
function fixture(entries = [], options = {}) {
  const reads = { usage: 0, prompt: 0, projection: 0 };
  const leaf = options.leaf ?? entries.at(-1)?.id ?? null;
  const projection = buildSessionProjection(entries, leaf);
  const ctx = {
    model: Object.hasOwn(options, "model") ? options.model : MODEL,
    sessionManager: {
      buildSessionProjection() {
        reads.projection++;
        return projection;
      },
      getBranch() {
        throw new Error("Do not use raw branch when a projection is available");
      },
      getEntries() {
        throw new Error("No whole-history reads");
      },
      getSessionFile() {
        throw new Error("No journal paths");
      },
    },
    getContextUsage() {
      reads.usage++;
      return options.usage ?? sdkUsage(100);
    },
    getSystemPrompt() {
      reads.prompt++;
      return options.prompt ?? "";
    },
    get modelRegistry() {
      throw new Error("No credentials or model runtime");
    },
    compact() {
      throw new Error("No mutation");
    },
    abort() {
      throw new Error("No lifecycle effects");
    },
  };
  return { ctx, projection, reads };
}
function snapshot(messages, options = {}) {
  const f = fixture(chain(messages), options);
  return collectContextSnapshot(f.ctx, { now: 123, ...options });
}
const category = (s, id) => s.categories.find((row) => row.id === id);
const rows = (s, kind) => s.items.filter((row) => row.kind === kind);
const sum = (values) => values.reduce((total, value) => total + value, 0);
function closed(s, total, allocation = "proportional") {
  assert.equal(s.usage.tokens, total, "footer and popover share this exact usage sample");
  assert.equal(
    sum(s.items.map((row) => row.tokens)),
    total,
    "numeric item allocation closes exactly (null is not a share)",
  );
  assert.equal(
    sum(s.categories.map((row) => row.tokens)),
    total,
    "numeric category allocation closes exactly",
  );
  for (const c of s.categories) {
    const items = s.items.filter((row) => row.category === c.id);
    if (c.tokens === null) assert(items.every((row) => row.tokens === null));
    else assert.equal(sum(items.map((row) => row.tokens)), c.tokens);
  }
  assert(
    s.items.every(
      (row) =>
        (allocation === "unattributed" && row.tokens === null) ||
        (Number.isSafeInteger(row.tokens) && row.tokens >= 0),
    ),
  );
  assert.equal(s.allocation, allocation);
  assert.equal(s.calibrated, allocation === "proportional");
  assert.match(
    s.note,
    allocation === "proportional"
      ? /proportional estimates.*not a provider breakdown/i
      : /entire SDK total unattributed.*not a provider breakdown/i,
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("stable four tabs, supplied usage wins without a hidden second sample; read-only and deterministic", () => {
  assert.deepEqual(CONTEXT_CATEGORIES, ["system", "summary", "messages", "tools"]);
  assert.equal(Object.isFrozen(CONTEXT_CATEGORIES), true);
  const entries = freeze(
    chain([
      user("USER_PRIVATE"),
      assistant([text("ASSISTANT_PRIVATE"), call("call-id")]),
      result("call-id"),
    ]),
  );
  const before = JSON.stringify(entries);
  const f = fixture(entries, { prompt: "SYSTEM_PRIVATE" });
  const supplied = sdkUsage(7);
  const options = { usage: supplied, effectiveSystemPrompt: "EFFECTIVE_PRIVATE", now: 123 };
  const s = collectContextSnapshot(f.ctx, options);
  closed(s, 7);
  assert.equal(s.updatedAt, 123);
  assert.deepEqual(s.usage, supplied);
  assert.equal(f.reads.usage, 0);
  assert.equal(f.reads.prompt, 0);
  assert.equal(f.reads.projection, 1);
  assert.equal(
    JSON.stringify(entries),
    before,
    "manual JSON comparison of synthetic inputs before/after",
  );
  assert.deepEqual(collectContextSnapshot(f.ctx, options), s);
});

test("source IDs survive earlier context omission and effective-prompt visibility changes", () => {
  const declaration = { name: "read", description: "read", parameters: { type: "object" } };
  const entries = chain([
    { role: "system", content: "", toolsAdded: [declaration], timestamp: 0 },
    user("earlier"),
    assistant([text("later"), thinking("visible", "signed"), call("stable-call")], {
      usage: { reasoning: 20 },
    }),
    result("stable-call"),
  ]);
  const before = collectContextSnapshot(fixture(entries).ctx, {
    effectiveSystemPrompt: "effective",
    now: 0,
  });
  const removedId = rows(before, "user")[0].id;
  const edited = [
    ...entries,
    {
      type: "context_edit",
      id: "omit-earlier",
      parentId: "entry-3",
      timestamp: stamp,
      targetId: "entry-1",
      replacement: null,
    },
  ];
  const after = collectContextSnapshot(fixture(edited).ctx, { effectiveSystemPrompt: "", now: 0 });
  assert.deepEqual(
    after.items.map((row) => row.id),
    before.items
      .filter((row) => row.id !== removedId && row.kind !== "prompt")
      .map((row) => row.id),
  );
  assert.equal(rows(after, "tool-declarations")[0].id, rows(before, "tool-declarations")[0].id);
  const restoredPrompt = collectContextSnapshot(fixture(edited).ctx, {
    effectiveSystemPrompt: "changed",
    now: 0,
  });
  assert.equal(rows(restoredPrompt, "prompt")[0].id, rows(before, "prompt")[0].id);
  assert.equal(
    rows(after, "reasoning")[0].rawTokens,
    20,
    "one max(visible, usage) estimate after source reindexing",
  );
  closed(after, 100);
});

test("new compaction and branch sources never reuse prior summary or message IDs", () => {
  const entries = [
    entry("old-user", null, user("same content")),
    {
      type: "compaction",
      id: "first-compaction",
      parentId: "old-user",
      timestamp: stamp,
      summary: "same summary",
      firstKeptEntryId: "old-user",
      tokensBefore: 10,
    },
    {
      type: "branch_summary",
      id: "first-branch",
      parentId: "first-compaction",
      timestamp: stamp,
      summary: "same branch",
      fromId: "abandoned",
    },
  ];
  const before = collectContextSnapshot(fixture(entries).ctx, { now: 0 });
  const later = [
    ...entries,
    entry("new-user", "first-branch", user("same content")),
    {
      type: "compaction",
      id: "second-compaction",
      parentId: "new-user",
      timestamp: stamp,
      summary: "same summary",
      firstKeptEntryId: "new-user",
      tokensBefore: 10,
    },
    {
      type: "branch_summary",
      id: "second-branch",
      parentId: "second-compaction",
      timestamp: stamp,
      summary: "same branch",
      fromId: "abandoned",
    },
  ];
  const after = collectContextSnapshot(fixture(later).ctx, { now: 0 });
  assert.deepEqual(
    after.items.map((row) => row.kind),
    before.items.map((row) => row.kind),
  );
  const previousIds = new Set(before.items.map((row) => row.id));
  assert(
    after.items.every((row) => !previousIds.has(row.id)),
    "identical row order/content cannot alias new source identities",
  );
  closed(before, 100);
  closed(after, 100);
});

test("multiple assistant blocks and same-kind entries have distinct stable IDs without double-counted reasoning", () => {
  const blocks = [
    text("aaaa"),
    call("one"),
    thinking("visible", "first-signature"),
    text("bbbb"),
    call("two"),
    thinking("more visible", "second-signature"),
  ];
  const message = assistant(blocks, { usage: { reasoning: 30 } });
  const s = snapshot([message, result("one"), result("two"), message]);
  assert.equal(new Set(s.items.map((row) => row.id)).size, s.items.length);
  assert.equal(rows(s, "assistant-text").length, 4);
  assert.equal(rows(s, "tool-call").length, 4);
  assert.equal(rows(s, "reasoning").length, 2);
  assert.equal(rows(s, "tool-result").length, 2);
  assert.deepEqual(
    rows(s, "reasoning").map((row) => row.rawTokens),
    [30, 30],
  );
  assert.equal(
    category(s, "messages").rawTokens,
    64,
    "2 text tokens + max reasoning 30 per assistant, no call weight",
  );
  closed(s, 100);
  assert.deepEqual(
    snapshot([message, result("one"), result("two"), message]).items.map((row) => row.id),
    s.items.map((row) => row.id),
  );
});

test("entry ID tuple encoding avoids delimiter aliases; missing entry IDs alone use position fallback", () => {
  const ctx = fixture().ctx;
  const projected = [
    { sourceEntry: { id: "source:assistant:0" }, messages: [user("first")] },
    { sourceEntry: { id: "source" }, messages: [assistant([text("second")])] },
    { sourceEntry: {}, messages: [user("missing id")] },
    { sourceEntry: {}, messages: [user("another missing id")] },
  ];
  ctx.sessionManager.buildSessionProjection = () => ({ entries: projected });
  const before = collectContextSnapshot(ctx, { now: 0 });
  assert.equal(new Set(before.items.map((row) => row.id)).size, 4);
  projected.unshift({ sourceEntry: { id: "earlier" }, messages: [user("earlier")] });
  const after = collectContextSnapshot(ctx, { now: 0 });
  assert.deepEqual(
    after.items.slice(1, 3).map((row) => row.id),
    before.items.slice(0, 2).map((row) => row.id),
  );
  assert.notEqual(
    after.items[3].id,
    before.items[2].id,
    "only absent source IDs have positional identity",
  );
});

test("effective prompt replaces raw system and sections; current folded schemas counted exactly once", () => {
  const first = { name: "read", description: "OLD_SCHEMA_PRIVATE", parameters: { type: "object" } };
  const replacement = {
    name: "read",
    description: "CURRENT_SCHEMA_PRIVATE",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  };
  const removed = {
    name: "retired",
    description: "RETIRED_PRIVATE",
    parameters: { type: "object" },
  };
  const messages = [
    {
      role: "system",
      content: "RAW_PROMPT_PRIVATE".repeat(100),
      sections: { rules: "RAW_SECTION_PRIVATE".repeat(100) },
      toolsAdded: [first, removed],
      timestamp: 0,
    },
    user("hello"),
    {
      role: "system",
      content: "RAW_DELTA_PRIVATE",
      sections: { rules: "RAW_REPLACEMENT_PRIVATE" },
      toolsRemoved: [{ name: "retired" }],
      toolsAdded: [replacement],
      timestamp: 1,
    },
  ];
  const f = fixture(chain(messages), { prompt: "effective prompt" });
  const s = collectContextSnapshot(f.ctx, { now: 0 });
  const promptWeight = estimateTokens({
    role: "system",
    content: "effective prompt",
    timestamp: 0,
  });
  const schemaWeight = estimateTokens({
    role: "system",
    content: "",
    toolsAdded: getCurrentTools(messages),
    timestamp: 0,
  });
  assert.equal(rows(s, "prompt")[0].rawTokens, promptWeight);
  assert.equal(rows(s, "tool-declarations").length, 1);
  assert.equal(rows(s, "tool-declarations")[0].rawTokens, schemaWeight);
  assert.equal(rows(s, "tool-declarations")[0].count, 1);
  assert.equal(category(s, "system").rawTokens, promptWeight + schemaWeight);
  assert.equal(f.reads.prompt, 1);
  assert.equal(f.reads.usage, 1);
  assert(!JSON.stringify(s).includes("PRIVATE"));
  const emptyOverride = collectContextSnapshot(f.ctx, { effectiveSystemPrompt: "", now: 0 });
  assert.equal(
    rows(emptyOverride, "prompt").length,
    0,
    "empty effective prompt is authoritative too",
  );
});

test("assistant blocks split text/reasoning/calls; signed reasoning uses max, never signature bytes or duplicate usage", () => {
  const blocks = [
    text("abcd"),
    thinking("visible", "OPAQUE_PRIVATE".repeat(10000)),
    thinking("also visible", "SECOND_OPAQUE_PRIVATE"),
    call("id", "bash", { command: "COMMAND_PRIVATE" }),
  ];
  const a = assistant(blocks, { usage: { reasoning: 91 } });
  const s = snapshot([a, result("id", "bash")]);
  assert.equal(rows(s, "assistant-text")[0].rawTokens, 1);
  assert.equal(rows(s, "reasoning").length, 1);
  assert.equal(rows(s, "reasoning")[0].rawTokens, 91);
  assert.equal(rows(s, "tool-call")[0].rawTokens, estimateTokens({ ...a, content: [blocks[3]] }));
  assert.equal(category(s, "messages").rawTokens, 92, "call is not also in Messages");
  closed(s, 100);
  const lowUsage = snapshot([
    assistant([thinking("x".repeat(400), "signed")], { usage: { reasoning: 4 } }),
  ]);
  assert.equal(
    rows(lowUsage, "reasoning")[0].rawTokens,
    100,
    "visible text is a floor, not added to usage",
  );
  const noUsage = snapshot([assistant([thinking("abcd", "opaque")], { usage: {} })]);
  assert.equal(rows(noUsage, "reasoning")[0].rawTokens, 1);
  assert(!JSON.stringify(s).includes("PRIVATE"));
});

test("foreign thinking is omitted; unsigned visible thinking uses native estimate; opaque redacted data is not chars/4", () => {
  const unsigned = snapshot([
    assistant([thinking("x".repeat(40))], { usage: { reasoning: 999999 } }),
  ]);
  assert.equal(rows(unsigned, "reasoning")[0].rawTokens, 10);
  for (const identity of [{ model: "foreign" }, { provider: "foreign" }, { api: "foreign" }]) {
    const s = snapshot([
      assistant([text("okay"), thinking("x".repeat(400), "opaque")], {
        ...identity,
        usage: { reasoning: 9999 },
      }),
    ]);
    assert.equal(rows(s, "reasoning").length, 0);
    assert.equal(category(s, "messages").rawTokens, 1);
  }
  const redacted = snapshot(
    [
      assistant(
        [
          {
            type: "thinking",
            thinking: "CIPHERTEXT_PRIVATE".repeat(10000),
            redacted: true,
            thinkingSignature: "BASE64_PRIVATE".repeat(10000),
          },
        ],
        { usage: {} },
      ),
    ],
    { usage: sdkUsage(null) },
  );
  assert.equal(redacted.rawTokens, 0);
  assert(!JSON.stringify(redacted).includes("PRIVATE"));
});

test("Anthropic-shaped opaque reasoning without a positive weight stays partial without losing known replay identity", () => {
  const model = {
    ...MODEL,
    provider: "anthropic-fixture",
    api: "anthropic-messages",
    id: "claude-fixture",
  };
  // Matches pinned Anthropic output: placeholder body, opaque signature, no usage.reasoning field.
  const redacted = {
    type: "thinking",
    thinking: "[Reasoning redacted]",
    redacted: true,
    thinkingSignature: "CIPHERTEXT_PRIVATE".repeat(1000),
  };
  const emptySigned = thinking("", "SIGNATURE_PRIVATE".repeat(1000));
  const noReasoning = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 };
  const make = (blocks, usage = noReasoning, extra = {}) => [
    user("aaaa"),
    assistant([text("bbbb"), ...blocks], {
      provider: model.provider,
      api: model.api,
      model: model.id,
      usage,
      ...extra,
    }),
  ];
  const modes = [
    { model },
    { model: { ...MODEL, api: "pi-virtual" }, replayModel: model, replaySource: "active-request" },
  ];
  for (const mode of modes) {
    const replay = mode.replayModel ? "observed" : "selected";
    for (const block of [redacted, emptySigned]) {
      for (const counter of [undefined, 0, -1, NaN, Infinity]) {
        const usage = counter === undefined ? noReasoning : { ...noReasoning, reasoning: counter };
        const s = snapshot(make([block], usage), { ...mode, usage: sdkUsage(10000) });
        closed(s, 10000, "unattributed");
        assert.equal(s.replay, replay, "unknown weight does not mean unknown model identity");
        assert.equal(s.attribution, "partial");
        assert.equal(s.rawTokens, 2, "only visible user/assistant text has a raw estimate");
        assert.equal(rows(s, "reasoning").length, 0);
        const pending = rows(s, "reasoning-unknown");
        assert.equal(pending.length, 1);
        assert.equal(pending[0].rawState, "unknown");
        assert(
          s.items
            .filter((row) => row.category !== "other" && row.kind !== "reasoning-unknown")
            .every((row) => row.rawState === "estimate"),
        );
        assert.equal(rows(s, "unattributed")[0].rawState, "not-applicable");
        assert.deepEqual(
          [pending[0].category, pending[0].rawTokens, pending[0].tokens, pending[0].count],
          ["messages", 0, null, 1],
        );
        assert.match(pending[0].detail.join(" "), /matching requested identity.*weight unknown/i);
        assert.match(s.note, /replay identity known; opaque reasoning weight unknown/i);
        assert.doesNotMatch(s.note, /identity unknown|reasoning replay and weight unknown/i);
        assert(
          s.items.filter((row) => row.category !== "other").every((row) => row.tokens === null),
        );
        assert(
          s.categories.filter((row) => row.id !== "other").every((row) => row.tokens === null),
        );
        assert.equal(rows(s, "unattributed")[0].tokens, 10000);
        assert(!JSON.stringify(s).includes("PRIVATE"));
      }
      const raw = snapshot(make([block]), { ...mode, usage: sdkUsage(null) });
      assert.equal(raw.usage.tokens, null);
      assert.equal(raw.replay, replay);
      assert.equal(raw.allocation, "raw");
      assert.equal(raw.attribution, "partial");
      assert.equal(raw.calibrated, false);
      assert(raw.items.every((row) => row.tokens === null));
      assert(raw.categories.every((row) => row.tokens === null));
      assert.equal(rows(raw, "reasoning-unknown")[0].count, 1);
      assert.equal(rows(raw, "reasoning-unknown")[0].rawState, "unknown");
      assert(
        raw.items
          .filter((row) => row.kind !== "reasoning-unknown")
          .every((row) => row.rawState === "estimate"),
      );
      assert.equal(rows(raw, "unattributed").length, 0);
      assert(!JSON.stringify(raw).includes("PRIVATE"));
    }
    const short = snapshot(make([{ ...redacted, thinkingSignature: "short" }]), {
      ...mode,
      usage: sdkUsage(10000),
    });
    const long = snapshot(make([redacted]), { ...mode, usage: sdkUsage(10000) });
    assert.deepEqual(short, long, "signature size never becomes chars/4 weight or metadata");
  }
});

test("opaque groups keep positive proxy or visible fallback estimates; foreign groups do not replay", () => {
  const model = {
    ...MODEL,
    provider: "anthropic-fixture",
    api: "anthropic-messages",
    id: "claude-fixture",
  };
  const redacted = {
    type: "thinking",
    thinking: "[Reasoning redacted]",
    redacted: true,
    thinkingSignature: "OPAQUE_PRIVATE",
  };
  const emptySigned = thinking("", "SIGNATURE_PRIVATE");
  const make = (blocks, extra = {}) => [
    user("aaaa"),
    assistant([text("bbbb"), ...blocks], {
      provider: model.provider,
      api: model.api,
      model: model.id,
      usage: {},
      ...extra,
    }),
  ];
  for (const block of [redacted, emptySigned]) {
    const positive = snapshot(make([block], { usage: { reasoning: 7000 } }), {
      model,
      usage: sdkUsage(10000),
    });
    closed(positive, 10000);
    assert.equal(positive.replay, "selected");
    assert.equal(positive.attribution, "complete");
    assert.equal(rows(positive, "reasoning")[0].rawTokens, 7000);
    assert.equal(rows(positive, "reasoning")[0].rawState, "estimate");
    assert.equal(rows(positive, "reasoning-unknown").length, 0);
    // Existing group-level max policy: visible fallback can stand in for the whole group.
    const fallback = snapshot(
      make([block, thinking("x".repeat(40), "VISIBLE_SIGNATURE_PRIVATE")]),
      { model, usage: sdkUsage(10000) },
    );
    closed(fallback, 10000);
    assert.equal(fallback.attribution, "complete");
    assert.equal(rows(fallback, "reasoning")[0].rawTokens, 10);
    assert.equal(rows(fallback, "reasoning")[0].rawState, "estimate");
    assert.equal(rows(fallback, "reasoning")[0].count, 2);
    assert.equal(rows(fallback, "reasoning-unknown").length, 0);
    for (const identity of [{ provider: "foreign" }, { api: "foreign" }, { model: "foreign" }]) {
      const foreign = snapshot(make([block], identity), { model, usage: sdkUsage(10000) });
      closed(foreign, 10000);
      assert.equal(foreign.replay, "selected");
      assert.equal(foreign.attribution, "complete");
      assert.equal(rows(foreign, "reasoning").length, 0);
      assert.equal(
        rows(foreign, "reasoning-unknown").length,
        0,
        "omitted foreign blocks do not need an input weight",
      );
    }
    assert(!JSON.stringify([positive, fallback]).includes("PRIVATE"));
  }
  const visible = snapshot(make([thinking("x".repeat(40), "SIGNED_PRIVATE")]), {
    model,
    usage: sdkUsage(10000),
  });
  closed(visible, 10000);
  assert.equal(visible.attribution, "complete");
  assert.equal(
    rows(visible, "reasoning")[0].rawTokens,
    10,
    "signed visible text alone remains estimable without a counter",
  );
});

test("same 10000-token sample distinguishes selected physical, virtual unknown, observed A and switched B", () => {
  const a = { ...MODEL, api: "openai-responses", id: "requested-a" };
  const virtual = { ...MODEL, api: "pi-virtual", id: "virtual-selection" };
  const messages = [
    user("USER_PRIVATE"),
    assistant(
      [
        thinking("REASONING_PRIVATE", "SIGNED_PRIVATE"),
        {
          type: "thinking",
          thinking: "OPAQUE_PRIVATE".repeat(1000),
          redacted: true,
          thinkingSignature: "ENCRYPTED_PRIVATE",
        },
        text("ASSISTANT_PRIVATE"),
        call("route-call"),
      ],
      {
        provider: a.provider,
        api: a.api,
        model: a.id,
        responseModel: "server-response-alias",
        usage: { reasoning: 7000 },
      },
    ),
    result("route-call"),
  ];
  const f = fixture(freeze(chain(messages)), { model: virtual });
  const before = JSON.stringify(f.projection);
  const options = { usage: sdkUsage(10000), effectiveSystemPrompt: "SYSTEM_PRIVATE", now: 0 };
  const physical = collectContextSnapshot(
    Object.assign(Object.create(f.ctx), { model: a }),
    options,
  );
  closed(physical, 10000);
  assert.equal(physical.replay, "selected");
  assert.equal(physical.attribution, "complete");
  assert.equal(rows(physical, "reasoning")[0].rawTokens, 7000);
  assert.equal(rows(physical, "reasoning")[0].count, 2);

  const unknown = collectContextSnapshot(f.ctx, options); // No observer; history cannot supply a target.
  closed(unknown, 10000, "unattributed");
  assert.equal(unknown.replay, "unknown");
  assert.equal(unknown.attribution, "partial");
  assert.equal(rows(unknown, "reasoning").length, 0);
  const pending = rows(unknown, "reasoning-unknown");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rawState, "unknown");
  assert.equal(rows(unknown, "unattributed")[0].rawState, "not-applicable");
  assert.deepEqual(
    [pending[0].category, pending[0].rawTokens, pending[0].tokens, pending[0].count],
    ["messages", 0, null, 2],
  );
  assert.match(pending[0].detail.join(" "), /unknown, not zero/);
  assert(
    unknown.items.filter((row) => row.category !== "other").every((row) => row.tokens === null),
  );
  assert(
    unknown.categories.filter((row) => row.id !== "other").every((row) => row.tokens === null),
  );
  assert.equal(category(unknown, "other").tokens, 10000);
  assert(unknown.rawTokens > 0, "known source weights are retained, not calibrated");
  assert.equal(unknown.rawTokens, physical.rawTokens - 7000);
  assert.deepEqual(
    unknown.items.filter((row) => row.category !== "other" && row.kind !== "reasoning-unknown"),
    physical.items
      .filter((row) => row.kind !== "reasoning")
      .map((row) => ({ ...row, tokens: null })),
  );

  for (const replaySource of ["active-request", "last-observed-request"]) {
    const observed = collectContextSnapshot(f.ctx, { ...options, replayModel: a, replaySource });
    closed(observed, 10000);
    assert.equal(observed.replay, "observed");
    assert.equal(observed.attribution, "complete");
    assert.deepEqual(observed.items, physical.items);
    assert.match(observed.note, /not a prediction of the next route/);
    assert.match(
      observed.note,
      replaySource === "active-request" ? /active request/ : /last observed request/,
    );
    assert(!JSON.stringify(observed).includes("PRIVATE"));
  }
  // A new explicitly observed request must replace A, not reuse its history identity.
  for (const b of [
    { ...a, id: "requested-b" },
    { ...a, api: "different-api" },
    { ...a, provider: "different-provider" },
    { ...a, id: "server-response-alias" },
  ]) {
    const switched = collectContextSnapshot(f.ctx, {
      ...options,
      replayModel: b,
      replaySource: "active-request",
    });
    closed(switched, 10000);
    assert.equal(switched.replay, "observed");
    assert.equal(
      rows(switched, "reasoning").length,
      0,
      "provider/api/requested id must all match; responseModel is not identity",
    );
    assert.equal(
      rows(switched, "reasoning-unknown").length,
      0,
      "known foreign reasoning is omitted, not unknown",
    );
    assert.equal(switched.attribution, "complete");
  }
  assert.equal(
    JSON.stringify(f.projection),
    before,
    "exact JSON string comparison of synthetic projection before/after",
  );
  assert(!JSON.stringify(unknown).includes("PRIVATE"));
  closed(collectContextSnapshot(f.ctx, { ...options, replayModel: a }), 10000);
  assert.equal(f.reads.usage, 0, "all comparisons use the same supplied sample");
});

test("explicit null, absent observer and invalid identities cannot infer replay from physical history", () => {
  const messages = [
    user("known text"),
    assistant([thinking("BODY_PRIVATE", "SIGNATURE_PRIVATE")], { usage: { reasoning: 9000 } }),
  ];
  const virtual = { ...MODEL, api: "pi-virtual" };
  const candidates = [
    null,
    virtual,
    {},
    { provider: MODEL.provider, api: MODEL.api },
    { provider: "", api: MODEL.api, id: MODEL.id },
    { ...MODEL, api: " " },
    { ...MODEL, id: 1 },
  ];
  for (const replayModel of candidates) {
    const s = snapshot(messages, { replayModel, usage: sdkUsage(10000) });
    closed(s, 10000, "unattributed");
    assert.equal(s.replay, "unknown");
    assert.equal(s.attribution, "partial");
    assert.equal(rows(s, "reasoning-unknown")[0].count, 1);
    assert(!JSON.stringify(s).includes("PRIVATE"));
  }
  const throwingIdentity = {
    ...MODEL,
    get api() {
      throw new Error("IDENTITY_ERROR_PRIVATE");
    },
  };
  for (const model of [
    virtual,
    undefined,
    null,
    { ...MODEL, provider: undefined },
    throwingIdentity,
  ]) {
    const s = snapshot(messages, { model, usage: sdkUsage(10000) });
    closed(s, 10000, "unattributed");
    assert.equal(s.replay, "unknown");
    assert(!JSON.stringify(s).includes("PRIVATE"));
  }
  // Undefined, unlike null, retains the physical-selection default.
  const selected = snapshot(messages, { replayModel: undefined, usage: sdkUsage(10000) });
  closed(selected, 10000);
  assert.equal(selected.replay, "selected");
});

test("unknown replay and unknown SDK total retain reasoning metadata and all null source tokens", () => {
  const messages = [
    user("known text"),
    assistant([thinking("BODY_PRIVATE", "SIGNATURE_PRIVATE")], { usage: { reasoning: 7000 } }),
  ];
  const s = snapshot(messages, { model: { ...MODEL, api: "pi-virtual" }, usage: sdkUsage(null) });
  assert.equal(s.usage.tokens, null);
  assert.equal(s.allocation, "raw");
  assert.equal(s.attribution, "partial");
  assert.equal(s.replay, "unknown");
  assert.equal(s.calibrated, false);
  assert(s.items.every((row) => row.tokens === null));
  assert(s.categories.every((row) => row.tokens === null));
  assert.equal(rows(s, "reasoning-unknown")[0].rawTokens, 0);
  assert.equal(rows(s, "reasoning-unknown")[0].rawState, "unknown");
  assert.equal(rows(s, "user")[0].rawState, "estimate");
  assert.equal(rows(s, "reasoning-unknown")[0].count, 1);
  assert.equal(rows(s, "unattributed").length, 0);
  assert(s.rawTokens > 0);
  assert.match(s.note, /SDK total unknown/);
  assert.match(s.note, /reasoning replay and weight unknown/i);
  assert(!JSON.stringify(s).includes("PRIVATE"));
  const zero = snapshot(messages, { replayModel: null, usage: sdkUsage(0) });
  closed(zero, 0, "unattributed");
  assert.equal(
    rows(zero, "reasoning-unknown")[0].tokens,
    null,
    "even zero total does not prove zero reasoning replay",
  );
});

test("virtual unknown without successful thinking still allows proportional estimates with explicit replay caveat", () => {
  const messages = [
    user("hello"),
    assistant([text("answer")]),
    assistant([thinking("FAILED_PRIVATE", "signed")], { stopReason: "error" }),
    assistant([thinking("ABORTED_PRIVATE", "signed")], { stopReason: "aborted" }),
  ];
  const s = snapshot(messages, { model: { ...MODEL, api: "pi-virtual" }, usage: sdkUsage(10000) });
  closed(s, 10000);
  assert.equal(s.replay, "unknown");
  assert.equal(s.attribution, "complete");
  assert.equal(rows(s, "reasoning-unknown").length, 0);
  assert.match(s.note, /physical replay identity unknown/i);
  assert(!JSON.stringify(s).includes("PRIVATE"));
});

test("Responses family omits unsigned thinking instead of claiming same-identity replay", () => {
  for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
    const model = { ...MODEL, api };
    const unsigned = assistant(
      [
        text("abcd"),
        thinking("UNSIGNED_PRIVATE".repeat(1000)),
        { type: "thinking", thinking: "", redacted: true },
      ],
      { api, usage: { reasoning: 7000 } },
    );
    const s = snapshot([unsigned], { model, usage: sdkUsage(10000) });
    closed(s, 10000);
    assert.equal(rows(s, "reasoning").length, 0);
    assert.equal(s.rawTokens, 1);
    const signed = snapshot(
      [
        assistant([...unsigned.content, thinking("", "OPAQUE_PRIVATE".repeat(1000))], {
          api,
          usage: { reasoning: 7000 },
        }),
      ],
      { model, usage: sdkUsage(10000) },
    );
    closed(signed, 10000);
    assert.equal(rows(signed, "reasoning")[0].count, 1);
    assert.equal(
      rows(signed, "reasoning")[0].rawTokens,
      7000,
      "opaque weight uses rough usage, not signature bytes",
    );
    assert(!JSON.stringify(signed).includes("PRIVATE"));
  }
});

test("available raw weights can be proportional while API or estimator failures mark partial attribution", () => {
  const f = fixture(chain([user("available")]));
  f.ctx.getSystemPrompt = () => {
    throw new Error("PROMPT_ERROR_PRIVATE");
  };
  const s = collectContextSnapshot(f.ctx, { usage: sdkUsage(10000), now: 0 });
  closed(s, 10000);
  assert.equal(s.attribution, "partial");
  assert.match(s.note, /incomplete.*unavailable.*proportional/i);
  assert(!JSON.stringify(s).includes("PRIVATE"));

  const badText = {
    type: "text",
    get text() {
      throw new Error("ESTIMATE_ERROR_PRIVATE");
    },
  };
  f.ctx.sessionManager.buildSessionProjection = () => ({
    entries: [
      { sourceEntry: { id: "available" }, messages: [user("available")] },
      {
        sourceEntry: { id: "unavailable-estimate" },
        messages: [result("unlinked", "read", [badText])],
      },
    ],
  });
  const partial = collectContextSnapshot(f.ctx, {
    usage: sdkUsage(10000),
    effectiveSystemPrompt: "",
    now: 0,
  });
  closed(partial, 10000);
  assert.equal(partial.attribution, "partial");
  assert.equal(rows(partial, "tool-result")[0].rawTokens, 0);
  assert.equal(rows(partial, "tool-result")[0].rawState, "unknown");
  assert.equal(rows(partial, "user")[0].rawState, "estimate");
  assert(!JSON.stringify(partial).includes("PRIVATE"));
  const raw = collectContextSnapshot(f.ctx, {
    usage: sdkUsage(null),
    effectiveSystemPrompt: "",
    now: 0,
  });
  assert.equal(raw.allocation, "raw");
  assert.equal(raw.attribution, "partial");
  assert.equal(raw.calibrated, false);
  assert(raw.items.every((row) => row.tokens === null));
  assert(raw.categories.every((row) => row.tokens === null));
});

test("successful zero and throwing zero snapshots differ only in per-row rawState, even when both are partial", () => {
  const failure = {
    type: "text",
    get text() {
      throw new Error("ESTIMATE_ERROR_PRIVATE");
    },
  };
  const make = (block, total) => {
    const f = fixture();
    f.ctx.getSystemPrompt = () => {
      throw new Error("PROMPT_ERROR_PRIVATE");
    };
    f.ctx.sessionManager.buildSessionProjection = () => ({
      entries: [
        { sourceEntry: { id: "known" }, messages: [user("available")] },
        { sourceEntry: { id: "zero-user" }, messages: [user([block])] },
        { sourceEntry: { id: "zero-result" }, messages: [result("unlinked", "read", [block])] },
        { sourceEntry: { id: "known-zero" }, messages: [assistant([text("")])] },
      ],
    });
    return collectContextSnapshot(f.ctx, { usage: sdkUsage(total), now: 0 });
  };
  for (const total of [null, 100]) {
    const known = make(text(""), total);
    const failed = make(failure, total);
    assert.equal(known.attribution, "partial");
    assert.equal(failed.attribution, "partial");
    const withoutStates = (s) => ({
      ...s,
      items: s.items.map(({ rawState: _state, ...row }) => row),
    });
    assert.deepEqual(
      withoutStates(known),
      withoutStates(failed),
      "all pre-existing DTO fields still collide exactly",
    );
    assert(
      known.items.every((row) => row.rawState === "estimate"),
      "unrelated API failure cannot poison known rows, including zero",
    );
    assert.deepEqual(
      failed.items.map((row) => row.rawState),
      ["estimate", "unknown", "unknown", "estimate"],
    );
    assert.deepEqual(
      known.items.map((row) => row.rawTokens),
      [3, 0, 0, 0],
    );
    if (total === null) {
      assert.equal(failed.allocation, "raw");
      assert(failed.items.every((row) => row.tokens === null));
    } else {
      closed(known, total);
      closed(failed, total);
    }
    assert(!JSON.stringify([known, failed]).includes("PRIVATE"));
  }
});

test("illegal estimator results retain numeric zero without masquerading as successful estimates", () => {
  for (const length of [NaN, Infinity, -Infinity, -8, undefined]) {
    // Deliberately malformed synthetic text exercises the real SDK heuristic's numeric result.
    const bad = { type: "text", text: { length } };
    const f = fixture();
    f.ctx.sessionManager.buildSessionProjection = () => ({
      entries: [
        { sourceEntry: { id: "known" }, messages: [user("available")] },
        { sourceEntry: { id: "bad-result" }, messages: [result("unlinked", "read", [bad])] },
      ],
    });
    const s = collectContextSnapshot(f.ctx, { usage: sdkUsage(100), now: 0 });
    closed(s, 100);
    assert.equal(
      s.attribution,
      "complete",
      "rawState does not change the existing attribution decision for non-throwing invalid estimates",
    );
    assert.equal(rows(s, "user")[0].rawState, "estimate");
    assert.equal(rows(s, "tool-result")[0].rawTokens, 0);
    assert.equal(rows(s, "tool-result")[0].rawState, "unknown");
    assert.equal(rows(s, "tool-result")[0].tokens, 0);
  }
});

test("reasoning rawState follows the final group weight, not global failure state or numeric zero alone", () => {
  const zero = snapshot([assistant([thinking("")])], { usage: sdkUsage(0) });
  closed(zero, 0);
  assert.equal(rows(zero, "reasoning")[0].rawTokens, 0);
  assert.equal(
    rows(zero, "reasoning")[0].rawState,
    "estimate",
    "successful non-opaque zero is known",
  );
  const failedBody = {
    get length() {
      throw new Error("ESTIMATE_ERROR_PRIVATE");
    },
  };
  for (const proxy of [0, 20]) {
    const message = assistant([thinking(failedBody, "SIGNATURE_PRIVATE"), text("known")], {
      usage: { reasoning: proxy },
    });
    const s = snapshot([message], { usage: sdkUsage(100) });
    closed(s, 100);
    assert.equal(s.attribution, "partial");
    assert.equal(rows(s, "reasoning")[0].rawTokens, proxy);
    assert.equal(rows(s, "reasoning")[0].rawState, proxy > 0 ? "estimate" : "unknown");
    assert.equal(rows(s, "assistant-text")[0].rawState, "estimate");
    assert.equal(
      rows(s, "reasoning-unknown").length,
      0,
      "metadata does not widen the existing opaque/Other strategy",
    );
    assert(!JSON.stringify(s).includes("PRIVATE"));
  }
  for (const proxy of [0, -1, NaN, Infinity, undefined, 2, 20]) {
    const s = snapshot([
      assistant([thinking("x".repeat(40), "signed")], { usage: { reasoning: proxy } }),
    ]);
    closed(s, 100);
    assert.equal(
      rows(s, "reasoning")[0].rawTokens,
      proxy === 20 ? 20 : 10,
      "group remains max(visible, positive proxy)",
    );
    assert.equal(rows(s, "reasoning")[0].rawState, "estimate");
  }
});

test("compaction/context_edit/branch provenance uses the native selected projection; summary wrappers are not User", () => {
  const entries = [
    entry("old", null, user("SUMMARIZED_PRIVATE".repeat(100))),
    entry("kept", "old", user("ORIGINAL_PRIVATE")),
    {
      type: "compaction",
      id: "compact",
      parentId: "kept",
      timestamp: stamp,
      summary: "COMPACTION_PRIVATE",
      firstKeptEntryId: "kept",
      tokensBefore: 999,
    },
    {
      type: "branch_summary",
      id: "branch",
      parentId: "compact",
      timestamp: stamp,
      summary: "BRANCH_PRIVATE",
      fromId: "OTHER_BRANCH_PRIVATE",
      fromHook: true,
    },
    {
      type: "context_edit",
      id: "edit",
      parentId: "branch",
      timestamp: stamp,
      targetId: "kept",
      replacement: { content: "edited" },
    },
    entry("omit", "edit", user("OMITTED_PRIVATE")),
    {
      type: "context_edit",
      id: "omit-edit",
      parentId: "omit",
      timestamp: stamp,
      targetId: "omit",
      replacement: null,
    },
    entry("unselected", "old", user("UNSELECTED_PRIVATE".repeat(1000))),
  ];
  const f = fixture(entries, { leaf: "omit-edit" });
  const s = collectContextSnapshot(f.ctx, { now: 0 });
  assert.equal(rows(s, "user").length, 1);
  assert.equal(category(s, "messages").rawTokens, estimateTokens(user("edited")));
  const nativeSummaries = f.projection.messages.filter(
    (m) => m.role === "compactionSummary" || m.role === "branchSummary",
  );
  for (const [index, kind] of ["compaction", "branch-summary"].entries()) {
    const row = rows(s, kind)[0];
    assert.equal(row.category, "summary");
    assert.equal(row.rawTokens, estimateTokens(convertToLlm([nativeSummaries[index]])[0]));
    assert(
      row.rawTokens > estimateTokens(nativeSummaries[index]),
      "native wrapper contributes to weight",
    );
  }
  assert.deepEqual(rows(s, "compaction")[0].detail, ["Pi summary"]);
  assert.deepEqual(rows(s, "branch-summary")[0].detail, ["Extension summary"]);
  assert.equal(category(s, "summary").count, 2);
  assert(!JSON.stringify(s).includes("PRIVATE"));
  closed(s, 100);
  // Missing convenience API falls back to the same public, branch-local pure projector.
  const branch = entries.filter((e) => e.id !== "unselected");
  const fallbackCtx = Object.assign(Object.create(f.ctx), {
    sessionManager: { getBranch: () => branch },
  });
  assert.deepEqual(collectContextSnapshot(fallbackCtx, { now: 0 }), s);
});

test("new compaction checkpoint does not resurrect older summaries or raw system sections", () => {
  const entries = [
    entry("u", null, user("old")),
    {
      type: "compaction",
      id: "c1",
      parentId: "u",
      timestamp: stamp,
      summary: "OLD_PRIVATE",
      firstKeptEntryId: "u",
      tokensBefore: 20,
    },
    entry("keep", "c1", user("kept")),
    {
      type: "compaction",
      id: "c2",
      parentId: "keep",
      timestamp: stamp,
      summary: "NEW_PRIVATE",
      firstKeptEntryId: "c1",
      tokensBefore: 30,
      systemMessage: { role: "system", content: "RAW_PRIVATE".repeat(1000), timestamp: 0 },
    },
  ];
  const f = fixture(entries, { prompt: "live" });
  const s = collectContextSnapshot(f.ctx);
  assert.equal(rows(s, "compaction").length, 1);
  assert.equal(rows(s, "prompt")[0].rawTokens, 1);
  assert.equal(rows(s, "user").length, 1);
  assert(!JSON.stringify(s).includes("PRIVATE"));
});

test("extension content and manual bash belong to their source categories; excluded bash contributes nothing", () => {
  const manual = {
    role: "bashExecution",
    command: "COMMAND_PRIVATE",
    output: "OUTPUT_PRIVATE",
    exitCode: 0,
    cancelled: false,
    timestamp: 0,
  };
  const custom = {
    type: "custom_message",
    id: "custom",
    parentId: "entry-1",
    timestamp: stamp,
    customType: "safe-extension",
    content: "CUSTOM_PRIVATE",
    display: false,
  };
  const entries = [
    ...chain([manual, { ...manual, excludeFromContext: true }]),
    custom,
    {
      type: "custom",
      id: "state-only",
      parentId: "custom",
      timestamp: stamp,
      customType: "state",
      data: "IGNORED_PRIVATE",
    },
  ];
  const f = fixture(entries);
  const s = collectContextSnapshot(f.ctx);
  assert.equal(rows(s, "bash-execution").length, 1);
  assert.equal(rows(s, "bash-execution")[0].category, "tools");
  assert.equal(rows(s, "bash-execution")[0].rawTokens, estimateTokens(convertToLlm([manual])[0]));
  assert.equal(rows(s, "custom-message").length, 1);
  assert.equal(rows(s, "custom-message")[0].category, "messages");
  assert.equal(rows(s, "user").length, 0);
  assert(!JSON.stringify(s).includes("PRIVATE"));
});

test("images use SDK fixed weights rather than base64 length, including tool-result images", () => {
  const image = (data) => ({ type: "image", mimeType: "image/png", data });
  const s = snapshot([
    user([image("a")]),
    result("unlinked", "read", [image("BASE64_PRIVATE".repeat(10000))]),
  ]);
  assert.equal(rows(s, "user")[0].rawTokens, 1200);
  assert.equal(rows(s, "tool-result")[0].rawTokens, 1200);
  assert.equal(rows(s, "tool-result")[0].detail, undefined);
  assert(!JSON.stringify(s).includes("PRIVATE"));
  closed(s, 100);
});

test("native file source labels distinguish lexical path tails while detail keeps the full clean path", () => {
  const first = "/workspace/project/packages/alpha/src/index.ts";
  const second = "/workspace/project/packages/beta/src/index.ts";
  const long = `${"prefix".repeat(40)}/folder/nested/output.ts`;
  const s = snapshot([
    assistant([
      call("first", "read", { path: first }),
      call("second", "read", { path: second }),
      call("edit", "edit", { path: "src/short.ts" }),
      call("write", "write", { path: long }),
      call("windows", "read", { path: "C:\\repo\\src\\out.ts" }),
      call("no-path", "read", {}),
    ]),
    result("first"),
    result("second"),
    result("edit", "edit"),
    result("write", "write"),
    result("windows"),
    result("no-path"),
  ]);
  const expected = [
    "read · …/alpha/src/index.ts",
    "read · …/beta/src/index.ts",
    "edit · src/short.ts",
    "write · …/folder/nested/output.ts",
    "read · …/repo/src/out.ts",
    "read",
  ];
  assert.deepEqual(
    rows(s, "tool-call").map((row) => row.label),
    expected,
  );
  assert.deepEqual(
    rows(s, "tool-result").map((row) => row.label),
    expected,
  );
  assert.notEqual(rows(s, "tool-result")[0].label, rows(s, "tool-result")[1].label);
  assert.deepEqual(rows(s, "tool-call")[0].detail, [first]);
  assert.deepEqual(rows(s, "tool-result")[1].detail, [second]);
  assert.deepEqual(
    rows(s, "tool-result")[3].detail,
    [long],
    "long prefix is abbreviated only in label, not detail",
  );
  assert.equal(
    new Set(s.items.map((row) => row.id)).size,
    s.items.length,
    "call/result kinds retain separate identities",
  );
  closed(s, 100);
});

test("labels expose only safe metadata; native paths are sanitized and results require unique ordered identity", () => {
  const path = "src/\x1b[31mfile\x1b[0m\nname\x85\u202eevil.ts";
  const s = snapshot([
    assistant([call("unique", "read", { path, secret: "ARGS_PRIVATE" })]),
    result("unique"),
    assistant([
      call("duplicate", "read", { path: "wrong-one" }),
      call("duplicate", "read", { path: "wrong-two" }),
    ]),
    result("duplicate"),
    result("before"),
    assistant([call("before")]),
    assistant([call("wrong-name")]),
    result("wrong-name", "write"),
    assistant([call("dup-result")]),
    result("dup-result"),
    result("dup-result"),
    assistant([
      call("unknown", "custom\x1b[31m\nname", {
        path: "PATH_PRIVATE",
        command: "COMMAND_PRIVATE",
        secret: "ARGS_PRIVATE",
      }),
    ]),
    result("unknown", "custom\x1b[31m\nname"),
  ]);
  const resultRows = rows(s, "tool-result");
  assert.deepEqual(resultRows[0].detail, ["src/file name evil.ts"]);
  assert.equal(resultRows[0].label, "read · src/file name evil.ts");
  assert.equal(rows(s, "tool-call")[0].label, "read · src/file name evil.ts");
  for (const row of resultRows.slice(1)) assert.equal(row.detail, undefined);
  assert.deepEqual(
    resultRows.slice(1).map((row) => row.label),
    ["read", "read", "write", "read", "read", "custom name"],
  );
  for (const row of rows(s, "tool-call").slice(1, 3)) {
    assert.equal(row.label, "read", "duplicate call IDs never acquire a file source label");
    assert.equal(row.detail, undefined);
  }
  assert.equal(rows(s, "tool-call").at(-1).detail, undefined);
  assert.equal(rows(s, "tool-call").at(-1).label, "custom name");
  const serialized = JSON.stringify(s);
  assert(!serialized.includes("PRIVATE"));
  assert(
    !/[\u0000-\u001f\u007f-\u009f\u202e]/u.test(
      s.items.map((row) => [row.label, ...(row.detail ?? [])].join(" ")).join(" "),
    ),
  );
});

test("context edits also replace assistant call weights and tool-result bodies rather than restoring originals", () => {
  const entries = chain([
    assistant([call("id", "read", { path: "old-private-path" })]),
    result("id", "read", [text("OLD_PRIVATE".repeat(100))]),
  ]);
  entries.push(
    {
      type: "context_edit",
      id: "a-edit",
      parentId: "entry-1",
      timestamp: stamp,
      targetId: "entry-0",
      replacement: { content: [text("only text")] },
    },
    {
      type: "context_edit",
      id: "r-edit",
      parentId: "a-edit",
      timestamp: stamp,
      targetId: "entry-1",
      replacement: { content: [text("new")] },
    },
  );
  const s = collectContextSnapshot(fixture(entries).ctx);
  assert.equal(rows(s, "tool-call").length, 0);
  assert.equal(rows(s, "tool-result")[0].rawTokens, 1);
  assert.equal(rows(s, "tool-result")[0].detail, undefined);
  assert(!JSON.stringify(s).includes("private"));
});

test("unknown is null, zero is a calibrated zero, and unexplained positive totals remain Unattributed", () => {
  const unknown = snapshot([user("hello")], { usage: sdkUsage(null) });
  assert.equal(unknown.usage.tokens, null);
  assert.equal(unknown.usage.percent, null);
  assert.equal(unknown.calibrated, false);
  assert.equal(unknown.allocation, "raw");
  assert.equal(unknown.attribution, "complete");
  assert.equal(unknown.replay, "selected");
  assert(unknown.items.every((row) => row.tokens === null));
  assert(
    unknown.categories.every((row) => row.tokens === null),
    "absent categories are unknown, not zero",
  );
  const zero = snapshot([user("hello")], { usage: sdkUsage(0) });
  closed(zero, 0);
  assert(zero.categories.every((row) => row.tokens === 0));
  const unassigned = snapshot([], { usage: sdkUsage(17) });
  closed(unassigned, 17, "unattributed");
  assert.equal(unassigned.attribution, "partial");
  assert.equal(unassigned.rawTokens, 0);
  assert.deepEqual(
    rows(unassigned, "unattributed").map((row) => [
      row.category,
      row.label,
      row.rawTokens,
      row.tokens,
    ]),
    [["other", "Unattributed", 0, 17]],
  );
  assert.equal(unassigned.categories.at(-1).id, "other");
  assert.equal(snapshot([], { usage: sdkUsage(0) }).items.length, 0);
});

test("largest remainder closes tiny totals, stable ties, extreme weights and exact integer totals", () => {
  const messages = [user("aaaa"), assistant([text("bbbb"), text("cccc")])];
  for (let total = 0; total < 50; total++)
    closed(snapshot(messages, { usage: sdkUsage(total) }), total);
  assert.deepEqual(
    snapshot(messages, { usage: sdkUsage(1) }).items.map((row) => row.tokens),
    [1, 0, 0],
  );
  assert.deepEqual(
    snapshot(messages, { usage: sdkUsage(2) }).items.map((row) => row.tokens),
    [1, 1, 0],
  );
  const extreme = [
    assistant([thinking("", "signed")], { usage: { reasoning: Number.MAX_SAFE_INTEGER } }),
    assistant([thinking("", "signed")], { usage: { reasoning: Number.MAX_SAFE_INTEGER } }),
    user("tiny"),
  ];
  closed(snapshot(extreme, { usage: sdkUsage(Number.MAX_SAFE_INTEGER) }), Number.MAX_SAFE_INTEGER);
  for (const total of [1, 2, 3, 12345])
    closed(snapshot(extreme, { usage: sdkUsage(total) }), total);
});

test("non-finite, negative and missing numeric metadata cannot poison weights or allocations", () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, undefined]) {
    const s = snapshot([assistant([thinking("", "signed")], { usage: { reasoning: invalid } })], {
      usage: { tokens: invalid, contextWindow: invalid, percent: invalid },
      now: NaN,
    });
    assert.equal(s.usage.tokens, null);
    assert.equal(s.usage.percent, null);
    assert(Number.isFinite(s.usage.contextWindow));
    assert(Number.isFinite(s.rawTokens));
    assert(Number.isFinite(s.updatedAt));
    assert(s.items.every((row) => row.rawTokens === 0 && row.tokens === null));
  }
});

test("missing/throwing APIs degrade safely without reading history, credentials or mutating context", () => {
  const missing = collectContextSnapshot({}, { now: 0 });
  assert.equal(missing.usage.tokens, null);
  assert.equal(missing.items.length, 0);
  assert.equal(missing.allocation, "raw");
  assert.equal(missing.attribution, "partial");
  assert.equal(missing.replay, "unknown");
  assert.match(missing.note, /incomplete.*unavailable/);
  const thrower = () => {
    throw new Error("SECRET_ERROR_PRIVATE");
  };
  const ctx = {
    getContextUsage: thrower,
    getSystemPrompt: thrower,
    get sessionManager() {
      thrower();
    },
    get model() {
      thrower();
    },
  };
  const failed = collectContextSnapshot(ctx, { usage: sdkUsage(9), now: 0 });
  closed(failed, 9, "unattributed");
  assert.equal(failed.attribution, "partial");
  assert.equal(rows(failed, "unattributed")[0].tokens, 9);
  assert(!JSON.stringify(failed).includes("PRIVATE"));
  const noPrompt = fixture(
    chain([
      { role: "system", content: "RAW_PRIVATE", sections: { hidden: "RAW_PRIVATE" }, timestamp: 0 },
    ]),
  );
  noPrompt.ctx.getSystemPrompt = thrower;
  assert.equal(
    collectContextSnapshot(noPrompt.ctx).rawTokens,
    0,
    "no raw system fallback that might double count sections",
  );
});

test("failed/aborted assistant turns are not replay weights or path associations", () => {
  const s = snapshot([
    assistant([text("FAILED_PRIVATE"), call("id")], { stopReason: "error" }),
    result("id"),
    assistant([text("ABORTED_PRIVATE")], { stopReason: "aborted" }),
  ]);
  assert.equal(rows(s, "assistant-text").length, 0);
  assert.equal(rows(s, "tool-call").length, 0);
  assert.equal(rows(s, "tool-result")[0].detail, undefined);
});
