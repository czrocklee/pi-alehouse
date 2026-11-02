import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager, ExtensionRunner } from "@earendil-works/pi-coding-agent";

// Synthetic public SDK seam only; no build, providers, credentials or network.
delete process.env.PI_ALEHOUSE_GROK_BILLING;
delete process.env.AGENT_DASHBOARD_URL;
globalThis.fetch = () => { throw new Error("Footer source regressions forbid network IO"); };
const { default: extension } = await createJiti(import.meta.url).import(
  new URL("../extensions/status-footer.ts", import.meta.url).pathname,
);
const MARKER = "\u0000pi-status-footer\u0000";
const usage = (cost = 1, extra = {}) => ({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4,
  cost: { total: cost }, ...extra });
const assistant = (model, cost = 1) => ({ type: "message", message: { role: "assistant", provider: "fixture",
  api: "fixture-api", model, stopReason: "stop", usage: usage(cost) } });

function fixture({ session, sdkDispatch = false } = {}) {
  const handlers = new Map(), entries = [], byId = new Map(), overlays = [];
  const reads = { usage: 0, entries: 0, entry: 0, branch: 0 };
  const sourceReads = { session: 0, leaf: 0, count: 0 };
  let leaf = null, sessionId = "fixture", footer, buffer = [], serial = 0;
  const manager = {
    getSessionId() { sourceReads.session++; return session?.getSessionId() ?? sessionId; },
    getLeafId() { sourceReads.leaf++; return session ? session.getLeafId() : leaf; },
    getEntryCount() { sourceReads.count++; return session?.getEntryCount() ?? entries.length; },
    getEntries() { reads.entries++; return session?.getEntries() ?? entries.slice(); },
    getEntry(id) { reads.entry++; return session ? session.getEntry(id) : byId.get(id); },
    getBranch() {
      reads.branch++;
      if (session) return session.getBranch();
      const branch = [];
      for (let id = leaf; id; id = byId.get(id)?.parentId) branch.push(byId.get(id));
      return branch.reverse();
    },
  };
  const theme = { fg: (_color, text) => text, bold: text => text };
  const tui = {
    mode: "fullscreen", terminal: { rows: 24, columns: 200 },
    render: width => typeof buffer === "function" ? buffer(width, footer) : buffer, requestRender() {},
    showOverlay(component, options) {
      overlays.push({ component, options });
      return { hide() {}, isFocused: () => false };
    },
  };
  const ctx = {
    cwd: "/fixture", hasUI: false, mode: "tui", thinkingLevel: "off",
    model: { provider: "fixture", id: "physical", api: "fixture-api", contextWindow: 1000 },
    modelRegistry: { isUsingOAuth: () => false }, sessionManager: manager,
    getSystemPrompt: () => "", tokens: 10,
    getContextUsage() {
      reads.usage++;
      return { tokens: ctx.tokens, contextWindow: ctx.model.contextWindow,
        percent: ctx.tokens / ctx.model.contextWindow * 100 };
    },
    ui: { setFooter(factory) {
      footer?.dispose();
      footer = factory(tui, theme, { getGitBranch: () => undefined, getExtensionStatuses: () => [],
        onBranchChange: () => () => {} });
    } },
  };
  extension({ on(name, handler) {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    return () => {};
  }, events: { on: () => () => {}, emit() {} } });
  const runner = { extensions: [{ path: "footer-performance-source", handlers }], createContext: () => ctx,
    isSessionBeforeEvent: ExtensionRunner.prototype.isSessionBeforeEvent,
    emitError(error) { throw new Error(`Unexpected SDK hook error: ${error.error}`); } };
  const emit = async (name, event = {}) => {
    if (sdkDispatch) return ExtensionRunner.prototype.emit.call(runner, { ...event, type: name });
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const append = (entry, parentId = leaf) => {
    const next = { id: `entry-${++serial}`, parentId, timestamp: "2026-01-01T00:00:00Z", ...entry };
    entries.push(next); byId.set(next.id, next); leaf = next.id;
    return next;
  };
  return { ctx, tui, reads, sourceReads, entries, manager, emit, append, overlays,
    paint: () => footer.render(200)[0], invalidate: () => footer.invalidate(),
    setLeaf(id) { leaf = id; }, setSession(id) { sessionId = id; },
    setBuffer(value) { buffer = value; },
    openContext() {
      const line = footer.render(200)[0];
      footer.handleMouse({ type: "click", button: "left", x: line.indexOf("10/1.0k") + 1, y: 0 });
      return overlays.at(-1);
    },
    openSpend() {
      const line = footer.render(200)[0];
      footer.handleMouse({ type: "click", button: "left", x: line.indexOf("↑"), y: 0 });
      return overlays.at(-1);
    },
    dispose: async () => { await emit("session_shutdown"); footer?.dispose(); },
  };
}

test("footer caches context and virtual routes by public session/model/revision boundaries", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    f.paint();
    for (let frame = 0; frame < 1000; frame++) { f.invalidate(); f.paint(); }
    assert.deepEqual(f.reads, { usage: 1, entries: 1, entry: 0, branch: 0 });
    for (const name of ["before_agent_start", "turn_start", "turn_end", "context_with_system", "message_start",
      "message_end", "tool_execution_end", "agent_settled", "model_select", "session_tree", "session_compact",
      "session_compact_failed", "before_provider_request"]) {
      const before = f.reads.usage;
      f.ctx.tokens++;
      await f.emit(name, { message: { role: "assistant", provider: "fixture", api: "fixture-api", model: "routed" } });
      f.paint(); f.paint();
      assert.equal(f.reads.usage, before + 1, `${name} refreshes once even when the leaf is unchanged`);
    }
    for (const change of [{ provider: "other" }, { id: "other-model" }, { api: "other-api" }, { contextWindow: 2000 }]) {
      const before = f.reads.usage;
      Object.assign(f.ctx.model, change); f.paint(); f.paint();
      assert.equal(f.reads.usage, before + 1, "physical model identity/limits are part of the cache key");
    }
    for (const entry of [{ type: "usage", provider: "fixture", model: "warm", usage: usage() },
      { type: "context_edit", targetId: "absent", replacement: null }]) {
      const before = f.reads.usage;
      f.append(entry); f.paint(); f.paint();
      assert.equal(f.reads.usage, before + 1, "independent usage and context edits advance the public key");
    }
    f.ctx.model = { provider: "router", id: "auto", api: "pi-virtual", contextWindow: 3000 };
    f.append({ type: "model_change", provider: "router", modelId: "auto" });
    f.append(assistant("route-a"));
    assert.match(f.paint(), /auto → route-a/);
    const afterRoute = { ...f.reads };
    for (let frame = 0; frame < 1000; frame++) f.paint();
    assert.deepEqual(f.reads, afterRoute, "virtual frames do not walk the branch or session");
    // A dispatch may change routed limits before anything is persisted.
    f.ctx.tokens = 777;
    await f.emit("before_provider_request"); f.paint(); f.paint();
    assert.equal(f.reads.usage, afterRoute.usage + 1);
    f.append(assistant("route-b"));
    assert.match(f.paint(), /auto → route-b/);
    const beforeSession = f.reads.usage;
    f.setSession("different-session-same-leaf"); f.paint(); f.paint();
    assert.equal(f.reads.usage, beforeSession + 1, "session identity prevents same-leaf reuse");
    f.ctx.sessionManager = { ...f.manager };
    f.paint();
    assert.equal(f.reads.usage, beforeSession + 2, "manager replacement cannot borrow another cache");
    for (const missing of ["getSessionId", "getLeafId"]) {
      const saved = f.ctx.sessionManager[missing];
      delete f.ctx.sessionManager[missing];
      const before = f.reads.usage;
      f.paint(); f.paint();
      assert.equal(f.reads.usage, before + 2, `old host missing ${missing} reads fresh`);
      f.ctx.sessionManager[missing] = saved;
    }
    f.ctx.sessionManager.getLeafId = () => { throw new Error("unavailable"); };
    const beforeThrow = f.reads.usage;
    f.paint(); f.paint();
    assert.equal(f.reads.usage, beforeThrow + 2, "throwing identity getters cannot keep a stale total");
  } finally { await f.dispose(); }
});

test("spend processes append deltas and keeps all abandoned-branch/tool/summary/independent charges", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 1000; index++) f.append(assistant("main"));
    const branchPoint = f.entries[499].id;
    await f.emit("session_start");
    assert.match(f.paint(), /\$1000\.000/);
    const baseline = f.reads.entries;
    for (let index = 0; index < 100; index++) {
      f.append(assistant("main")); await f.emit("message_end"); f.invalidate(); f.paint();
    }
    assert.equal(f.reads.entries, baseline, "ordinary appends never copy/walk all session entries again");
    assert.equal(f.reads.entry, 100, "exactly one entry is consumed per ordinary append");
    f.setLeaf(branchPoint); await f.emit("session_tree");
    assert.match(f.paint(), /\$1100\.000/, "tree navigation never discards abandoned-branch spend");
    f.append(assistant("main", 2));
    assert.match(f.paint(), /\$1102\.000/);
    assert.equal(f.reads.entries, baseline, "new work on an old branch remains incremental");
    f.append({ type: "message", message: { role: "assistant", provider: "fixture", model: "alias",
      responseModel: "actual", usage: usage(3) } });
    f.append({ type: "usage", provider: "fixture", model: "warm", usage: usage(4) });
    f.append({ type: "compaction", usage: usage(5) });
    f.append({ type: "branch_summary", usage: usage(6) });
    f.append({ type: "message", message: { role: "toolResult", usage: usage(7, { harnessModels: [
      { model: "worker/child", input: 4, output: 1, cacheRead: 1, cacheWrite: 2, cost: 3 },
      { model: "compaction/worker/child", input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 },
    ] }) } });
    await f.emit("session_compact");
    assert.match(f.paint(), /\$1127\.000/);
    assert.equal(f.reads.entries, baseline, "compaction does not force a historical accounting rescan");
    const panel = f.openSpend();
    const table = panel.component.render(panel.options.width).join("\n");
    assert.match(table, /actual/); assert.doesNotMatch(table, /alias/);
    assert.match(table, /warm/); assert.match(table, /main · compact\/summaries/);
    assert.match(table, /worker compact · child/); assert.match(table, /tools/);
    assert.match(table, /1127\.000/);
    const beforeQueries = { ...f.reads };
    for (let frame = 0; frame < 100; frame++) {
      void panel.options.width; panel.component.render(panel.options.width); f.paint();
    }
    assert.deepEqual(f.reads, beforeQueries, "stack layout queries share the accounting cursor");
    // Entries can have arrived on multiple branches between observations. A
    // single new-leaf chain is then insufficient: rebuild from ALL entries.
    f.append(assistant("hidden", 8));
    f.setLeaf(branchPoint);
    f.append(assistant("visible", 9));
    assert.match(f.paint(), /\$1144\.000/);
    assert.equal(f.reads.entries, baseline + 1, "a count/parent-chain mismatch safely rehydrates all branches");
    assert.match(panel.component.render(panel.options.width).join("\n"), /hidden/);
    const readCount = f.reads.entries;
    delete f.manager.getEntryCount;
    f.append(assistant("legacy", 1)); f.paint();
    assert.equal(f.reads.entries, readCount + 1, "hosts without entry count use a full safe refresh");
    delete f.manager.getLeafId;
    f.paint(); f.paint();
    assert.equal(f.reads.entries, readCount + 3, "hosts without a reliable key never reuse accounting");
  } finally { await f.dispose(); }
});

for (const scenario of [{ count: false, identity: true }, { count: true, identity: true }, { count: false, identity: false }]) {
  test(`unobserved billed A→B→A stays in whole-session spend (count=${scenario.count}, identity=${scenario.identity})`, async () => {
    const session = SessionManager.inMemory("/synthetic/footer-review");
    const a = session.appendMessage({ ...assistant("base").message, content: [], timestamp: 0 });
    const f = fixture({ session, sdkDispatch: true });
    if (!scenario.count) delete f.manager.getEntryCount;
    if (!scenario.identity) delete f.manager.getSessionId;
    try {
      await f.emit("session_start");
      assert.match(f.paint(), /\$1\.000/);
      const reads = f.reads.entries;
      const b = session.appendUsage("cache_warm", "fixture", "unobserved-B", usage(2));
      // Do not paint/read B before navigating back. A is the same immutable
      // branch, but it is not a revision of the complete billing journal.
      session.branch(a);
      await f.emit("session_tree", { oldLeafId: b.id, newLeafId: a, summaryEntry: undefined });
      assert.equal(session.getBranch().length, 1);
      assert.equal(session.getEntries().length, 2);
      assert.match(f.paint(), /\$3\.000/);
      assert.equal(f.reads.entries, reads + 1, "the unobserved billed branch forces a whole-journal refresh");
      const refreshed = f.reads.entries, usageReads = f.reads.usage;
      f.paint(); f.paint();
      assert.equal(f.reads.entries, refreshed + (scenario.count && scenario.identity ? 0 : 2),
        "only a reliable whole-journal revision permits spend reuse");
      if (scenario.identity) assert.equal(f.reads.usage, usageReads,
        "the immutable branch context can still be cached without a journal count");
    } finally { await f.dispose(); }
  });
}

test("one footer frame captures one public source; independent context panels capture freshly and no-route is cached", async () => {
  const f = fixture();
  const reset = () => { for (const key of Object.keys(f.sourceReads)) f.sourceReads[key] = 0; };
  try {
    await f.emit("session_start");
    reset(); f.paint();
    assert.deepEqual(f.sourceReads, { session: 1, leaf: 1, count: 1 });
    const panel = f.openContext();
    assert(panel);
    reset(); f.paint();
    assert.deepEqual(f.sourceReads, { session: 1, leaf: 1, count: 1 }, "spend/usage/route/context share one captured source");
    reset(); panel.component.render(panel.options.width);
    assert.deepEqual(f.sourceReads, { session: 1, leaf: 1, count: 1 }, "an independent panel does not borrow a previous footer source");
    f.ctx.tokens = 77;
    await f.emit("message_end");
    assert.match(panel.component.render(panel.options.width).join("\n"), /77\s*\/\s*1\.0k/);
    // A separate fixture avoids counting the context table's intentional branch
    // projection as route work below.
  } finally { await f.dispose(); }
  const negative = fixture();
  try {
    await negative.emit("session_start");
    negative.ctx.model = { provider: "router", id: "auto", api: "pi-virtual", contextWindow: 1000 };
    negative.append({ type: "model_change", provider: "router", modelId: "auto" });
    assert.doesNotMatch(negative.paint(), /→/);
    const before = negative.reads.branch;
    for (let i = 0; i < 20; i++) negative.paint();
    assert.equal(negative.reads.branch, before, "undefined physical route is a valid memo result");
  } finally { await negative.dispose(); }
});

test("bottom-footer uses render-local row identity without history scans, markers or shared-array mutation", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    assert(!f.paint().includes(MARKER), "fullscreen component emits no sentinel");
    for (const mode of ["regular", "fullscreen"]) for (const rows of [1, 6]) {
      f.tui.mode = mode; f.tui.terminal.rows = rows;
      for (const position of ["last", "middle", "missing"]) {
        let shared;
        f.setBuffer((width, footer) => {
          const row = position === "missing" ? undefined : footer.render(width)[0];
          assert(!row?.includes(MARKER), "regular component also emits no sentinel");
          shared = Object.freeze(position === "last" ? ["body", row]
            : position === "middle" ? [row, "tail"] : ["body", "tail"]);
          return shared;
        });
        const rendered = f.tui.render(20);
        const pads = mode === "regular" && position === "last" && rows > 2;
        if (pads) {
          assert.deepEqual(rendered, ["body", ...Array(rows - 2).fill(" ".repeat(20)), shared[1]]);
          assert.notEqual(rendered, shared);
        } else assert.equal(rendered, shared, "non-padding renders reuse the host array verbatim");
        assert.equal(shared.length, 2, "cached host arrays are never padded in place");
      }
    }
    f.tui.mode = "regular"; f.tui.terminal.rows = 6;
    // The retired private sentinel is now ordinary content, not a magic
    // transcript rewrite trigger, including non-last and duplicate spellings.
    for (const value of [[], ["body", "footer"], [`middle${MARKER}`, "tail"],
      [`early${MARKER}`, `footer${MARKER}`], [`footer${MARKER}${MARKER}`]]) {
      const input = Object.freeze(value);
      f.setBuffer(input);
      assert.equal(f.tui.render(20), input);
    }
    const oldPaint = Object.freeze([f.paint()]);
    f.setBuffer(oldPaint);
    assert.equal(f.tui.render(20), oldPaint, "a footer row from an earlier paint cannot borrow a new token");
    let indexedReads = 0, history;
    f.setBuffer((width, footer) => {
      const row = footer.render(width)[0];
      history = new Proxy(Object.freeze([...Array(10000).fill("history"), row]), {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) indexedReads++;
          return Reflect.get(target, key, receiver);
        },
      });
      return history;
    });
    assert.equal(f.tui.render(20), history, "long transcript frames allocate no history-sized copy");
    assert.equal(indexedReads, 1, "the wrapper only reads the last row, not each history string");
    // Inner renders must not overwrite the outer render's observation.
    let nested = false, inner;
    f.setBuffer((width, footer) => {
      const row = footer.render(width)[0];
      if (!nested) {
        nested = true;
        try { inner = f.tui.render(width); } finally { nested = false; }
      }
      return Object.freeze([nested ? "inner" : "outer", row]);
    });
    const outer = f.tui.render(20);
    assert.equal(inner.length, 6); assert.equal(inner[0], "inner");
    assert.equal(outer.length, 6); assert.equal(outer[0], "outer");
    f.setBuffer((width, footer) => { footer.render(width); throw new Error("synthetic-render"); });
    assert.throws(() => f.tui.render(20), /synthetic-render/);
    f.setBuffer(oldPaint);
    assert.equal(f.tui.render(20), oldPaint, "throwing renders restore the token in finally");
    f.setBuffer((width, footer) => ["body", footer.render(width)[0]]);
    assert.equal(f.tui.render(20).length, 6, "a later legitimate render still pads correctly");
  } finally { await f.dispose(); }
});
