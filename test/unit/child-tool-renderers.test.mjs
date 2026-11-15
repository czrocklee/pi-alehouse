/**
 * Unit regressions for the child tool-renderer bridge: the runtime leaf
 * `createChildToolRendererLookup(session)` and the ChildActivity
 * bind/unbind contract it feeds.
 *
 * Source-only through jiti (`fsCache: false`), never a stale dist build. The
 * SDK seam (`extensionRunner.resolveToolRenderers(name, base)` over the
 * public `getToolDefinition`) is exercised through a controlled fake session
 * reproducing the pinned SDK's resolver-chain semantics; the real-SDK bridge
 * is covered by test/sdk/tool-renderer-bridge.test.mjs.
 *
 * Contract under test (agreed with the runtime owner):
 * - the lookup returns `(name) => ToolRenderers | undefined`, projecting only
 *   `renderCall`/`renderResult`/`renderShell` — never `execute`, the full
 *   definition, or the session;
 * - `blockedDelegationToolNames` (including retired spellings) are never
 *   queried or revived;
 * - missing, throwing, malformed and async definitions resolve to `undefined`,
 *   and unknown names are not negatively cached;
 * - `ChildActivity.bindToolRenderers(lookup)` returns an idempotent,
 *   identity-safe unbind; `toolRenderersRevision` is a stable object token
 *   replaced only on bind/unbind while `presentationRevision` keeps growing
 *   with stream activity;
 * - session_start (new session), session_shutdown and registry retain/clear
 *   retire the lookup without querying the (possibly disposed) session again,
 *   while retained entries/history stay readable.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const runNode = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const jiti = createJiti(import.meta.url, { fsCache: false });
const { ChildActivity, ChildActivityRegistry } = await jiti.import(
  "../../src/orchestration/runtime/activity-observer.ts",
);
const { blockedDelegationToolNames } = await jiti.import(
  "../../src/orchestration/tools/tool-names.ts",
);
// Agreed runtime-leaf module for the renderer lookup. The import fails loudly
// while the runtime source is still landing, instead of silently testing a
// stale dist build.
const { createChildToolRendererLookup } = await jiti.import(
  "../../src/orchestration/runtime/child-tool-renderers.ts",
);

/** Function identity matters: renderers are handed to the UI unwrapped. */
const marker = (label) => {
  const fn = () => label;
  fn.label = label;
  return fn;
};

/** A registered definition shaped like a public builtin tool definition. */
function definition(extra = {}) {
  let executions = 0;
  const def = {
    name: "read",
    label: "Read",
    description: "Synthetic read definition",
    parameters: { type: "object" },
    renderShell: "self",
    renderCall: marker("renderCall"),
    renderResult: marker("renderResult"),
    execute: () => {
      executions += 1;
      return { content: [] };
    },
    ...extra,
  };
  return { def, executions: () => executions };
}

/**
 * Reproduces the pinned SDK `ExtensionRunner.resolveToolRenderers` chain:
 * resolvers run in order, each may short-circuit, and the caller's base is
 * reached only when every resolver deferred to `next()`.
 */
function fakeSession({ defs, resolvers = [], throwing = new Set() } = {}) {
  const calls = { getToolDefinition: [], resolveToolRenderers: [], next: 0 };
  const definitions = defs instanceof Map ? defs : new Map(Object.entries(defs ?? {}));
  const session = {
    getToolDefinition(name) {
      calls.getToolDefinition.push(name);
      const def = definitions.get(name);
      if (def === "throw") throw new Error(`synthetic definition failure: ${name}`);
      return def;
    },
    extensionRunner: {
      resolveToolRenderers(name, base) {
        if (throwing.has(name)) throw new Error(`synthetic resolver failure: ${name}`);
        calls.resolveToolRenderers.push(name);
        const resolve = (index) =>
          index < resolvers.length
            ? resolvers[index](name, () => {
                calls.next += 1;
                return resolve(index + 1);
              })
            : base();
        return resolve(0);
      },
    },
  };
  return { session, calls, definitions };
}

/** Minimal session-manager stand-in for retained history observation. */
function syntheticSessionManager(id = "synthetic-session") {
  const entries = [];
  let leaf = null;
  return {
    getSessionId: () => id,
    getLeafId: () => leaf,
    getEntryCount: () => entries.length,
    getEntries: () => entries,
    append(entry) {
      entries.push(entry);
      leaf = `leaf-${entries.length}`;
      return leaf;
    },
  };
}

/** A counting lookup so retirement can prove the session is never re-queried. */
function countingLookup(label) {
  let queries = 0;
  return {
    queries: () => queries,
    lookup: (name) => {
      queries += 1;
      return name === "read" ? { renderCall: marker(label) } : undefined;
    },
  };
}

function wiredActivity() {
  const child = new ChildActivity("/synthetic");
  const handlers = new Map();
  child.extension({ on: (name, handler) => handlers.set(name, handler) });
  return { child, handlers, observation: child };
}

test("lookup projects exactly the three public renderer fields and never executes", () => {
  const { def, executions } = definition();
  const { session, calls } = fakeSession({ defs: new Map([["read", def]]) });
  const lookup = createChildToolRendererLookup(session);
  const projected = lookup("read");
  assert(projected, "a definition with native renderers resolves");
  assert.deepEqual(
    Object.keys(projected).sort(),
    ["renderCall", "renderResult", "renderShell"],
    "only the public renderer fields are projected",
  );
  assert.equal(projected.renderCall, def.renderCall, "renderCall identity is preserved");
  assert.equal(projected.renderResult, def.renderResult, "renderResult identity is preserved");
  assert.equal(projected.renderShell, "self");
  assert.equal(executions(), 0, "the projection never executes the tool");
  assert.deepEqual(calls.resolveToolRenderers, ["read"]);
  assert.deepEqual(
    calls.getToolDefinition,
    ["read"],
    "the base resolves through the public getToolDefinition",
  );
});

test("extension resolvers run in order, can short-circuit, and keep the base lazy", () => {
  const sentinel = { renderCall: marker("sentinel") };
  const order = [];
  const { session, calls } = fakeSession({
    defs: new Map([["read", definition().def]]),
    resolvers: [
      (name, next) => {
        order.push(`first:${name}`);
        return next();
      },
      (name) => {
        order.push(`second:${name}`);
        return sentinel;
      },
    ],
  });
  const lookup = createChildToolRendererLookup(session);
  const override = lookup("read");
  assert(
    override && override.renderCall === sentinel.renderCall,
    "a resolver override wins over the base definition and keeps function identity",
  );
  assert.deepEqual(order, ["first:read", "second:read"], "resolvers are chained in order");
  assert.deepEqual(calls.getToolDefinition, [], "the base stays lazy behind a resolving chain");

  const shortCircuit = { renderCall: marker("short-circuit") };
  const lazy = fakeSession({
    defs: new Map([["read", definition().def]]),
    resolvers: [
      (_name, _next) => {
        order.push("short-circuit");
        return shortCircuit;
      },
    ],
  });
  const lazyLookup = createChildToolRendererLookup(lazy.session);
  assert.equal(lazyLookup("read")?.renderCall, shortCircuit.renderCall);
  assert.equal(lazy.calls.next, 0, "next() is never invoked when a resolver returns directly");
  assert.deepEqual(lazy.calls.getToolDefinition, []);
});

test("resolver throws and malformed resolver results fall back to undefined", () => {
  const { session } = fakeSession({
    defs: new Map(),
    resolvers: [
      (name, next) =>
        name === "malformed" ? { renderCall: "not-a-function", renderResult: 7 } : next(),
    ],
    throwing: new Set(["boom"]),
  });
  const lookup = createChildToolRendererLookup(session);
  assert.equal(
    lookup("malformed"),
    undefined,
    "a resolver result without valid renderer fields resolves to undefined",
  );
  assert.equal(lookup("boom"), undefined, "a throwing resolver chain resolves to undefined");
});

test("missing, malformed, async and throwing definitions fall back to undefined", () => {
  const { def } = definition();
  const { session, definitions } = fakeSession();
  const lookup = createChildToolRendererLookup(session);
  assert.equal(lookup("late"), undefined, "an unregistered name resolves to undefined");
  definitions.set("late", def);
  const late = lookup("late");
  assert(late && late.renderCall === def.renderCall, "unknown names are not negatively cached");

  definitions.set("missing", null);
  assert.equal(lookup("missing"), undefined);
  definitions.set("number", 42);
  assert.equal(lookup("number"), undefined);
  definitions.set("empty", {});
  assert.equal(lookup("empty"), undefined, "a definition without renderers is not projected");
  definitions.set("invalid", { renderCall: "no", renderResult: 7, renderShell: 42 });
  assert.equal(lookup("invalid"), undefined, "malformed renderer fields are not projected");
  definitions.set("partial", { renderCall: def.renderCall });
  assert.deepEqual(lookup("partial"), { renderCall: def.renderCall });
  definitions.set("async", Promise.resolve(def));
  assert.equal(lookup("async"), undefined, "an async definition is not treated as renderers");
  definitions.set("throwing", "throw");
  assert.equal(lookup("throwing"), undefined, "a throwing definition resolves to undefined");
});

test("blocked and retired delegation names are never queried or revived", () => {
  const { def } = definition();
  const { session, calls, definitions } = fakeSession();
  // Even a definition that somehow exists under a blocked name must not be
  // reachable: the lookup neither queries nor revives it.
  for (const name of blockedDelegationToolNames) definitions.set(name, def);
  const lookup = createChildToolRendererLookup(session);
  for (const name of blockedDelegationToolNames) {
    assert.equal(lookup(name), undefined, `blocked name is not revived: ${name}`);
  }
  assert.deepEqual(calls.getToolDefinition, [], "blocked names are never queried");
  assert.deepEqual(calls.resolveToolRenderers, []);
  for (const retired of ["delegate", "read_result", "subagent", "get_subagent_result"]) {
    assert(
      blockedDelegationToolNames.includes(retired),
      `retired spelling stays deny-only: ${retired}`,
    );
  }
});

test("bindToolRenderers serves the current lookup; unbind is idempotent and identity-safe", () => {
  const { child, observation } = wiredActivity();
  assert.equal(observation.toolRenderers?.("read"), undefined, "no lookup is bound initially");
  const first = countingLookup("first"),
    second = countingLookup("second");
  const unbindFirst = child.bindToolRenderers(first.lookup);
  assert.equal(observation.toolRenderers?.("read")?.renderCall.label, "first");
  const unbindSecond = child.bindToolRenderers(second.lookup);
  assert.equal(observation.toolRenderers?.("read")?.renderCall.label, "second");
  unbindFirst();
  assert.equal(
    observation.toolRenderers?.("read")?.renderCall.label,
    "second",
    "a stale unbind cannot retire the current binding",
  );
  const queried = second.queries();
  unbindSecond();
  unbindSecond();
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(second.queries(), queried, "a retired lookup is never queried again");
});

test("toolRenderersRevision is a stable token replaced only by bind and unbind", () => {
  const { child, handlers, observation } = wiredActivity();
  const initial = observation.toolRenderersRevision;
  const unbind = child.bindToolRenderers(() => undefined);
  const bound = observation.toolRenderersRevision;
  assert.notEqual(bound, initial, "binding replaces the revision token");
  assert(bound && typeof bound === "object", "the revision is a stable object token");
  const revision = observation.presentationRevision;
  handlers.get("turn_start")();
  handlers.get("agent_start")();
  handlers.get("message_start")({ message: { role: "assistant" } });
  handlers.get("message_end")({ message: { role: "assistant" } });
  handlers.get("turn_start")();
  assert.ok(
    observation.presentationRevision > revision,
    "stream activity keeps growing the presentation revision",
  );
  assert.equal(
    observation.toolRenderersRevision,
    bound,
    "the renderer token does not change with stream revisions",
  );
  unbind();
  const afterUnbind = observation.toolRenderersRevision;
  assert.notEqual(afterUnbind, bound, "unbinding replaces the token");
  const rebind = child.bindToolRenderers(() => undefined);
  assert.notEqual(
    observation.toolRenderersRevision,
    afterUnbind,
    "rebinding replaces the token again",
  );
  const rebindToken = observation.toolRenderersRevision;
  rebind();
  assert.notEqual(
    observation.toolRenderersRevision,
    rebindToken,
    "unbind again replaces the token",
  );
});

test("rebinding the same lookup function still invalidates the older unbind", () => {
  const { child, observation } = wiredActivity();
  const shared = countingLookup("shared");
  const unbindFirst = child.bindToolRenderers(shared.lookup);
  assert.equal(observation.toolRenderers?.("read")?.renderCall.label, "shared");
  // A second bind of the SAME function reference is still its own binding
  // token: the first unbind must never retire it.
  const unbindSecond = child.bindToolRenderers(shared.lookup);
  const queried = shared.queries();
  unbindFirst();
  assert.equal(
    observation.toolRenderers?.("read")?.renderCall.label,
    "shared",
    "a stale unbind cannot retire a rebinding of the same lookup function",
  );
  unbindSecond();
  unbindSecond();
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(
    shared.queries(),
    queried + 1,
    "only the rebinding served a query; retirement queried nothing",
  );
});

test(
  "async resolver results fall back to undefined without unhandled rejections",
  { timeout: 30000 },
  async () => {
    // Rejection observation is process-global state: prove it in an isolated
    // child process, so an unobserved rejection can neither be masked by this
    // file's own handlers nor fail unrelated lanes.
    const leafPath = join(repoRoot, "src/orchestration/runtime/child-tool-renderers.ts");
    const jitiEntry = pathToFileURL(join(repoRoot, "node_modules", "jiti", "lib", "jiti.mjs")).href;
    const script = `
import { createJiti } from ${JSON.stringify(jitiEntry)};
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(String(reason)); });
const jiti = createJiti(${JSON.stringify(pathToFileURL(repoRoot).href)}, { fsCache: false });
const { createChildToolRendererLookup } = await jiti.import(${JSON.stringify(leafPath)});
const definition = {
  name: "read", label: "Read", description: "", parameters: {},
  renderShell: "self", renderCall: () => "call", renderResult: () => "result",
  execute: () => ({ content: [] }),
};
const session = {
  getToolDefinition(name) {
    if (name === "async-resolved") return Promise.resolve(definition);
    if (name === "async-rejected")
      return Promise.reject(new Error("synthetic definition rejection"));
    throw new Error("unexpected query: " + name);
  },
  extensionRunner: {
    resolveToolRenderers(name, base) {
      if (name === "resolver-rejected")
        return Promise.reject(new Error("synthetic resolver rejection"));
      return base();
    },
  },
};
const lookup = createChildToolRendererLookup(session);
const report = {
  asyncResolved: lookup("async-resolved"),
  asyncRejected: lookup("async-rejected"),
  resolverRejected: lookup("resolver-rejected"),
};
// Give the process turns to surface any unobserved rejection.
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({ ...report, unhandled }));
if (
  unhandled.length ||
  report.asyncResolved !== undefined ||
  report.asyncRejected !== undefined ||
  report.resolverRejected !== undefined
)
  process.exitCode = 1;
`;
    const { stdout, stderr } = await runNode(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: repoRoot, timeout: 20000 },
    );
    assert.equal(stderr, "", "the isolated lookup run must not write errors");
    const report = JSON.parse(stdout);
    assert.equal(report.asyncResolved, undefined, "a resolved async definition is refused");
    assert.equal(report.asyncRejected, undefined, "a rejected async definition falls back");
    assert.equal(report.resolverRejected, undefined, "a rejected resolver result falls back");
    assert.deepEqual(report.unhandled, [], "every rejection is observed, never unhandled");
  },
);

test("session_start of a new session retires the bound lookup without querying it", () => {
  const { child, handlers, observation } = wiredActivity();
  handlers.get("session_start")({}, { sessionManager: syntheticSessionManager() });
  const probe = countingLookup("probe");
  child.bindToolRenderers(probe.lookup);
  assert(observation.toolRenderers?.("read"), "the bound lookup serves renderers");
  handlers.get("session_start")({}, { sessionManager: syntheticSessionManager("next-session") });
  const queried = probe.queries();
  assert.equal(observation.toolRenderers?.("read"), undefined, "a new session retires the lookup");
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(probe.queries(), queried, "the retired lookup is not queried for the miss");
});

test("session_shutdown retires the lookup and retains history", () => {
  const { child, handlers, observation } = wiredActivity();
  const manager = syntheticSessionManager();
  handlers.get("session_start")({}, { sessionManager: manager });
  manager.append({ role: "user", content: "RETAINED_RENDERER_ENTRY" });
  const probe = countingLookup("probe");
  child.bindToolRenderers(probe.lookup);
  assert(observation.toolRenderers?.("read"));
  handlers.get("session_shutdown")();
  const queried = probe.queries();
  assert.equal(observation.toolRenderers?.("read"), undefined, "shutdown retires the lookup");
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(probe.queries(), queried, "the disposed session is never queried again");
  assert.equal(
    observation.entries()?.length,
    1,
    "shutdown retires live renderers, not retained history",
  );
  assert(observation.historyState(), "the retained history identity stays readable");
});

test("registry retain and clear retire lookups and keep retained history", () => {
  const registry = new ChildActivityRegistry();
  const first = registry.track("agent-1", "/synthetic");
  const handlers = new Map();
  first.extension({ on: (name, handler) => handlers.set(name, handler) });
  const manager = syntheticSessionManager();
  handlers.get("session_start")({}, { sessionManager: manager });
  manager.append({ role: "user", content: "RETAINED_REGISTRY_ENTRY" });
  const probe = countingLookup("probe");
  first.bindToolRenderers(probe.lookup);
  const observation = registry.observations.get("agent-1");
  assert(observation && observation.toolRenderers?.("read"));

  registry.retain(new Set(["unrelated"]));
  const queried = probe.queries();
  assert.equal(observation.toolRenderers?.("read"), undefined, "retain retires the lookup");
  assert.equal(observation.toolRenderers?.("read"), undefined);
  assert.equal(probe.queries(), queried, "the retired lookup is never queried again");
  assert.equal(observation.entries()?.length, 1, "retained history survives retain retirement");
  assert(observation.historyState());

  const recreated = registry.track("agent-1", "/synthetic");
  assert.notEqual(recreated, first, "a dropped activity is not reused");
  assert.equal(
    registry.observations.get("agent-1")?.toolRenderers?.("read"),
    undefined,
    "a recreated activity starts unbound",
  );

  const second = registry.track("agent-2", "/synthetic");
  const secondProbe = countingLookup("second");
  second.bindToolRenderers(secondProbe.lookup);
  assert(registry.observations.get("agent-2")?.toolRenderers?.("read"));
  registry.clear();
  assert.equal(
    registry.observations.get("agent-2")?.toolRenderers?.("read"),
    undefined,
    "clear retires lookups",
  );
  assert.equal(secondProbe.queries(), 1, "the cleared lookup is queried exactly once");
});
