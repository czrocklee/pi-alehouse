// Source-only, synthetic authority observation tests. No generated runtime,
// permission authority initialization, tool execution, model, network or build.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { managedBlockToolNames } from "../lib/managed-block-tools.mjs";
import { renderWorkers } from "../scripts/generate-workers.mjs";

const source = resolve(import.meta.dirname, "../permission-system/managed-block-observer.ts");
const jiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: false, fsCache: false });
const { createManagedBlockObserver } = await jiti.import(source);
const registryKey = Symbol.for("pi-alehouse:managed-block-observer:v1");
const block = Object.freeze({ block: true, reason: "synthetic private reason" });
const event = (toolCallId = "opaque-call", toolName = "bash") => ({ type: "tool_call", toolName, toolCallId });
function sdkContext(sessionId) {
  const sessionManager = { getSessionId() { assert.equal(this, sessionManager); return sessionId; } };
  return { sessionManager };
}
function fixture(getter) {
  const sessionId = randomUUID();
  const service = Object.freeze({});
  const services = new Map([[sessionId, service]]);
  const queries = [];
  const api = createManagedBlockObserver(getter ?? ((id) => { queries.push(id); return services.get(id); }));
  const registrations = [];
  const releaseHandler = () => {};
  const pi = {
    marker: "original",
    get events() { throw new Error("the event bus must never be accessed"); },
    on(name, handler) { registrations.push({ name, handler, receiver: this }); return releaseHandler; },
    appendEntry() { return this.marker; },
  };
  const wrapped = api.wrapManagedBlocks(pi);
  const register = (handler) => {
    assert.equal(wrapped.on("tool_call", handler), releaseHandler);
    return registrations.at(-1).handler;
  };
  return { sessionId, service, services, queries, api, pi, wrapped, registrations, releaseHandler,
    register, ctx: sdkContext(sessionId) };
}
function subscribe(t, f, onBlock, sessionId = f.sessionId) {
  const release = f.api.subscribeManagedBlocks(sessionId, onBlock);
  t.after(release);
  return release;
}
function deferred() {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test("registration facade wraps only on/tool_call; order, receiver, return and live APIs survive", () => {
  const f = fixture();
  assert.notEqual(f.wrapped, f.pi);
  assert.equal(f.wrapped.appendEntry, f.pi.appendEntry);
  assert.equal(f.wrapped.appendEntry(), "original");
  const nonTool = () => "unchanged";
  assert.equal(f.wrapped.on("session_start", nonTool), f.releaseHandler);
  assert.equal(f.registrations[0].handler, nonTool);
  assert.equal(f.registrations[0].receiver, f.pi);
  const gate = () => block;
  f.register(gate);
  assert.notEqual(f.registrations[1].handler, gate);
  f.wrapped.on("session_shutdown", nonTool);
  assert.deepEqual(f.registrations.map(({ name }) => name), ["session_start", "tool_call", "session_shutdown"]);
  assert.equal(f.registrations[2].handler, nonTool);
  const borrowedReceiver = {};
  f.wrapped.on.call(borrowedReceiver, "input", nonTool);
  assert.equal(f.registrations[3].receiver, borrowedReceiver);
  f.pi.later = Object.freeze({ value: "not a snapshot" });
  assert.equal(f.wrapped.later, f.pi.later);
  const symbol = Symbol("non-tool API");
  f.pi[symbol] = nonTool;
  assert.equal(f.wrapped[symbol], nonTool);
  const nextOn = function (name, handler) { assert.equal(this, f.pi); return { name, handler }; };
  f.pi.on = nextOn;
  assert.deepEqual(f.wrapped.on("input", nonTool), { name: "input", handler: nonTool });
});

test("a frozen host API registers managed blocks without mutation or Proxy invariant errors", (t) => {
  const f = fixture(), facts = [];
  subscribe(t, f, (fact) => facts.push(fact));
  const originalOn = f.pi.on;
  Object.freeze(f.pi);
  assert.equal(Object.getOwnPropertyDescriptor(f.pi, "on").writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(f.pi, "on").configurable, false);
  const register = f.wrapped.on;
  assert.equal(register, f.wrapped.on, "registration has a stable wrapper identity");
  assert.equal(f.register(() => block)(event("frozen"), f.ctx), block);
  assert.deepEqual(facts, [{ toolName: "bash", toolCallId: "frozen" }]);
  assert.equal(f.pi.on, originalOn, "the original host API is untouched");
  assert.equal(f.wrapped.appendEntry(), "original");
});

test("telemetry vocabulary matches generated supported-profile tools plus fixed child communication", () => {
  const declared = new Set(["alert_parent", "ask_parent"]);
  const { agents } = renderWorkers();
  for (const name of ["editor", "reader", "researcher"]) {
    const tools = JSON.parse(/^tools: (.+)$/m.exec(agents[name])[1]);
    for (const tool of tools) declared.add(tool);
  }
  assert.equal(Object.isFrozen(managedBlockToolNames), true);
  assert.equal(new Set(managedBlockToolNames).size, managedBlockToolNames.length);
  assert.deepEqual([...managedBlockToolNames].sort(), [...declared].sort(),
    "profile tool additions/removals must explicitly reconcile the telemetry vocabulary");
});

test("all synchronous allow returns and handler this/arguments preserve identity", (t) => {
  const f = fixture(), facts = [];
  subscribe(t, f, (fact) => facts.push(fact));
  const receiver = {};
  for (const value of [undefined, null, false, 0, {}, { block: false }, { block: "true" }, { isError: true }]) {
    const call = event();
    const extra = {};
    const handler = f.register(function (actualEvent, actualCtx, actualExtra) {
      assert.equal(this, receiver);
      assert.equal(actualEvent, call);
      assert.equal(actualCtx, f.ctx);
      assert.equal(actualExtra, extra);
      return value;
    });
    assert.equal(handler.call(receiver, call, f.ctx, extra), value);
  }
  assert.deepEqual(facts, []);
});

test("async allow keeps the original promise and resolved object", async (t) => {
  const f = fixture(), facts = [], allowed = { block: false };
  subscribe(t, f, (fact) => facts.push(fact));
  const promise = Promise.resolve(allowed);
  const handler = f.register(() => promise);
  assert.equal(handler(event(), f.ctx), promise);
  assert.equal(await promise, allowed);
  assert.deepEqual(facts, []);
});

test("synchronous throw and asynchronous rejection escape with original identity and no fact", async (t) => {
  const f = fixture(), facts = [], failure = Object.freeze({ synthetic: "original thrown value" });
  subscribe(t, f, (fact) => facts.push(fact));
  const throwing = f.register(() => { throw failure; });
  assert.throws(() => throwing(event(), f.ctx), (error) => error === failure);
  const pending = deferred();
  const rejecting = f.register(() => pending.promise);
  assert.equal(rejecting(event(), f.ctx), pending.promise);
  pending.reject(failure);
  await assert.rejects(pending.promise, (error) => error === failure);
  assert.deepEqual(facts, []);
});

test("sync block emits only a frozen metadata snapshot, without event bus or raw-field reads", (t) => {
  const f = fixture(), facts = [];
  subscribe(t, f, (fact) => facts.push(fact));
  const poison = () => { throw new Error("private data must not be read"); };
  const call = event("opaque / provider-looking id", "read");
  for (const field of ["input", "arguments", "reason", "result", "error", "provider", "name"])
    Object.defineProperty(call, field, { get: poison });
  const result = { block: true };
  for (const field of ["reason", "input", "result", "error", "isError"])
    Object.defineProperty(result, field, { get: poison });
  const handler = f.register(() => result);
  assert.equal(handler(call, f.ctx), result);
  assert.deepEqual(facts, [{ toolName: "read", toolCallId: "opaque / provider-looking id" }]);
  assert.equal(Object.isFrozen(facts[0]), true);
  assert.deepEqual(Reflect.ownKeys(facts[0]), ["toolName", "toolCallId"]);
  assert.throws(() => { facts[0].toolCallId = "changed"; }, TypeError);
});

test("async block emits after settlement and preserves exact promise/block object", async (t) => {
  const f = fixture(), facts = [], pending = deferred(), receiver = {};
  subscribe(t, f, (fact) => facts.push(fact));
  const handler = f.register(function () { assert.equal(this, receiver); return pending.promise; });
  assert.equal(handler.call(receiver, event("async"), f.ctx), pending.promise);
  assert.deepEqual(facts, []);
  pending.resolve(block);
  assert.equal(await pending.promise, block);
  assert.deepEqual(facts, [{ toolName: "bash", toolCallId: "async" }]);
});

test("snapshot is captured before a handler mutates its event", (t) => {
  const f = fixture(), facts = [];
  subscribe(t, f, (fact) => facts.push(fact));
  const call = event("original", "bash");
  const handler = f.register(() => { call.toolName = "read"; call.toolCallId = "changed"; return block; });
  assert.equal(handler(call, f.ctx), block);
  assert.deepEqual(facts, [{ toolName: "bash", toolCallId: "original" }]);
});

test("actual SDK session and injected service identity select the listener, never event claims", (t) => {
  const f = fixture(), a = [], b = [], otherSession = randomUUID();
  f.services.set(otherSession, Object.freeze({}));
  subscribe(t, f, (fact) => a.push(fact));
  const handler = f.register(() => block);
  const call = { ...event(), sessionId: f.sessionId, service: f.service };
  assert.equal(handler(call, sdkContext(otherSession)), block);
  assert.deepEqual(a, []);
  subscribe(t, f, (fact) => b.push(fact), otherSession);
  assert.equal(handler(call, sdkContext(otherSession)), block);
  assert.deepEqual(a, []);
  assert.deepEqual(b, [{ toolName: "bash", toolCallId: "opaque-call" }]);
  assert(f.queries.includes(otherSession));
  const conflicting = fixture(() => Object.freeze({}));
  // The subscriber's actual service differs from this other authority getter.
  const conflictingHandler = conflicting.register(() => block);
  assert.equal(conflictingHandler(event(), f.ctx), block);
  assert.deepEqual(a, []);
  assert.equal(handler(event("actual"), f.ctx), block);
  assert.deepEqual(a, [{ toolName: "bash", toolCallId: "actual" }]);
});

test("missing, unavailable, conflicting and throwing service lookups silently drop observations", async (t) => {
  for (const replacement of [undefined, null, false, {}, "not a service"]) {
    const f = fixture(), facts = [];
    subscribe(t, f, (fact) => facts.push(fact));
    f.services.set(f.sessionId, replacement);
    assert.equal(f.register(() => block)(event(), f.ctx), block);
    assert.deepEqual(facts, []);
  }
  const f = fixture(), facts = [], pending = deferred();
  subscribe(t, f, (fact) => facts.push(fact));
  const handler = f.register(() => pending.promise);
  handler(event(), f.ctx);
  f.services.set(f.sessionId, {});
  pending.resolve(block);
  assert.equal(await pending.promise, block);
  assert.deepEqual(facts, []);
  let broken = false;
  const service = {};
  const throwing = fixture(() => { if (broken) throw new Error("getter failure"); return service; });
  subscribe(t, throwing, (fact) => facts.push(fact));
  broken = true;
  assert.equal(throwing.register(() => block)(event(), throwing.ctx), block);
  assert.deepEqual(facts, []);
});

test("current service identity is checked, not an inferred service revision history", async (t) => {
  const f = fixture(), facts = [], pending = deferred();
  subscribe(t, f, (fact) => facts.push(fact));
  assert.equal(f.register(() => pending.promise)(event("restored-service"), f.ctx), pending.promise);
  f.services.set(f.sessionId, {});
  f.services.set(f.sessionId, f.service);
  pending.resolve(block);
  assert.equal(await pending.promise, block);
  assert.deepEqual(facts, [{ toolName: "bash", toolCallId: "restored-service" }]);
});

test("session changes during await and service disappearance at completion are unobserved", async (t) => {
  for (const change of ["session", "service", "throwing session"]) {
    const f = fixture(), facts = [], pending = deferred();
    subscribe(t, f, (fact) => facts.push(fact));
    assert.equal(f.register(() => pending.promise)(event(), f.ctx), pending.promise);
    if (change === "service") f.services.delete(f.sessionId);
    else f.ctx.sessionManager.getSessionId = () => { if (change === "throwing session") throw new Error("missing context"); return randomUUID(); };
    pending.resolve(block);
    assert.equal(await pending.promise, block);
    assert.deepEqual(facts, []);
  }
});

test("invalid/missing metadata never falls back or affects the block", (t) => {
  const f = fixture(), facts = [];
  subscribe(t, f, (fact) => facts.push(fact));
  const handler = f.register(() => block);
  for (const call of [null, undefined, {}, { name: "bash", id: "fallback" },
    event("", "bash"), event("x".repeat(257)), event(3), event(null), event(undefined, "unknown_tool"),
    event("id", "Bash"), event("id", "powershell"), event("id", "notify_parent"),
    { toolName: "bash" }, { toolCallId: "id" }, { get toolName() { throw new Error("bad name"); } },
    { toolName: "bash", get toolCallId() { throw new Error("bad id"); } }]) {
    assert.equal(handler(call, f.ctx), block);
  }
  for (const ctx of [null, undefined, {}, { sessionManager: {} }, sdkContext(""), sdkContext("x".repeat(257)),
    sdkContext(undefined), sdkContext(3), { sessionManager: { getSessionId() { throw new Error("bad session"); } } }]) {
    assert.equal(handler(event(), ctx), block);
  }
  const unreadable = { get block() { throw new Error("unreadable result"); } };
  assert.equal(f.register(() => unreadable)(event(), f.ctx), unreadable);
  assert.deepEqual(facts, []);
});

test("all exact admitted tool names and opaque 256-character IDs are accepted without normalization", (t) => {
  const f = fixture(), facts = [], id = " \n/" + "x".repeat(252) + " ";
  assert.equal(id.length, 256);
  subscribe(t, f, (fact) => facts.push(fact));
  const handler = f.register(() => block);
  const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search",
    "source_check", "fetch_content", "get_search_content", "alert_parent", "ask_parent"];
  for (const name of tools) assert.equal(handler(event(id, name), f.ctx), block);
  assert.deepEqual(facts, tools.map((toolName) => ({ toolName, toolCallId: id })));
});

test("subscription requires valid identity, actual service, callback and a single live lease", (t) => {
  const f = fixture();
  for (const id of ["", "x".repeat(257), undefined, 42])
    assert.throws(() => f.api.subscribeManagedBlocks(id, () => {}), /Invalid managed block subscription/);
  assert.throws(() => f.api.subscribeManagedBlocks(f.sessionId, undefined), /Invalid managed block subscription/);
  for (const service of [undefined, null, false, 1, "service", () => {}]) {
    f.services.set(f.sessionId, service);
    assert.throws(() => f.api.subscribeManagedBlocks(f.sessionId, () => {}), /service is unavailable/);
  }
  f.services.set(f.sessionId, f.service);
  const listener = () => {};
  subscribe(t, f, listener);
  assert.throws(() => f.api.subscribeManagedBlocks(f.sessionId, listener), /already active/);
  assert.throws(() => createManagedBlockObserver(() => ({})).subscribeManagedBlocks(f.sessionId, () => {}), /already active/);
});

test("release is idempotent; a previous release cannot delete a replacement; registry retains no history", (t) => {
  const f = fixture(), oldFacts = [], nextFacts = [];
  const release = subscribe(t, f, (fact) => oldFacts.push(fact));
  const handler = f.register(() => block);
  const registry = globalThis[registryKey];
  assert.equal(Object.isFrozen(registry), true);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, registryKey);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.enumerable, false);
  assert.deepEqual(Object.keys(registry).sort(), ["entries", "version"]);
  handler(event("old"), f.ctx);
  release(); release();
  assert.equal(registry.entries.has(f.sessionId), false);
  const releaseNext = subscribe(t, f, (fact) => nextFacts.push(fact));
  release();
  handler(event("next"), f.ctx);
  assert.deepEqual(oldFacts, [{ toolName: "bash", toolCallId: "old" }]);
  assert.deepEqual(nextFacts, [{ toolName: "bash", toolCallId: "next" }]);
  releaseNext();
  assert.equal(registry.entries.has(f.sessionId), false);
});

test("old awaited handler cannot bind to a replacement Run subscription", async (t) => {
  const f = fixture(), oldFacts = [], nextFacts = [], pending = deferred();
  const release = subscribe(t, f, (fact) => oldFacts.push(fact));
  let result = pending.promise;
  const handler = f.register(() => result);
  assert.equal(handler(event("old-await"), f.ctx), pending.promise);
  release();
  subscribe(t, f, (fact) => nextFacts.push(fact));
  pending.resolve(block);
  assert.equal(await pending.promise, block);
  assert.deepEqual(oldFacts, []);
  assert.deepEqual(nextFacts, []);
  result = Promise.resolve(block);
  assert.equal(await handler(event("new-run"), f.ctx), block);
  assert.deepEqual(nextFacts, [{ toolName: "bash", toolCallId: "new-run" }]);
});

test("service getter reentry cannot attach captured work to a replacement lease", (t) => {
  for (const phase of ["capture", "publish"]) {
    let reenter, release;
    const oldFacts = [], nextFacts = [];
    const f = fixture((id) => {
      const action = reenter; reenter = undefined;
      action?.();
      return f.services.get(id);
    });
    release = subscribe(t, f, (fact) => oldFacts.push(fact));
    const replace = () => { release(); subscribe(t, f, (fact) => nextFacts.push(fact)); };
    const handler = f.register(() => {
      if (phase === "publish") reenter = replace;
      return block;
    });
    if (phase === "capture") reenter = replace;
    assert.equal(handler(event(`old-${phase}`), f.ctx), block);
    assert.deepEqual(oldFacts, [], phase);
    assert.deepEqual(nextFacts, [], phase);
    assert.equal(f.register(() => block)(event(`new-${phase}`), f.ctx), block);
    assert.deepEqual(nextFacts, [{ toolName: "bash", toolCallId: `new-${phase}` }]);
  }
});

test("a subscription installed during a handler cannot observe that handler", async (t) => {
  const f = fixture(), facts = [], pending = deferred();
  const handler = f.register(() => pending.promise);
  handler(event("no-lease-at-entry"), f.ctx);
  subscribe(t, f, (fact) => facts.push(fact));
  pending.resolve(block);
  assert.equal(await pending.promise, block);
  assert.deepEqual(facts, []);
  const g = fixture(), oldFacts = [], nextFacts = [];
  const release = subscribe(t, g, (fact) => oldFacts.push(fact));
  const synchronous = g.register(() => { release(); subscribe(t, g, (fact) => nextFacts.push(fact)); return block; });
  assert.equal(synchronous(event(), g.ctx), block);
  assert.deepEqual(oldFacts, []);
  assert.deepEqual(nextFacts, []);
});

test("subscriber throws cannot alter sync or async block object/return", async (t) => {
  const f = fixture();
  let calls = 0;
  subscribe(t, f, () => { calls++; throw new Error("subscriber failure"); });
  assert.equal(f.register(() => block)(event("sync"), f.ctx), block);
  const promise = Promise.resolve(block);
  assert.equal(f.register(() => promise)(event("async"), f.ctx), promise);
  assert.equal(await promise, block);
  assert.equal(calls, 2);
});

test("independent jiti copies share live leases, reject overlaps and deliver only for the same service", async (t) => {
  const secondJiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: false, fsCache: false });
  const copy = await secondJiti.import(source);
  assert.notEqual(copy.createManagedBlockObserver, createManagedBlockObserver);
  const f = fixture(), facts = [];
  const other = copy.createManagedBlockObserver((id) => f.services.get(id));
  const release = other.subscribeManagedBlocks(f.sessionId, (fact) => facts.push(fact));
  t.after(release);
  assert.throws(() => f.api.subscribeManagedBlocks(f.sessionId, () => {}), /already active/);
  assert.equal(f.register(() => block)(event("cross-copy"), f.ctx), block);
  assert.deepEqual(facts, [{ toolName: "bash", toolCallId: "cross-copy" }]);
  release();
  assert.equal(globalThis[registryKey].entries.has(f.sessionId), false);
});

test("generator copies helper, binds actual getter, exports subscription and wraps managed registration in order", () => {
  const generator = readFileSync(resolve(import.meta.dirname, "../scripts/prepare-authority.mjs"), "utf8");
  assert.match(generator, /cpSync\(join\(root, "permission-system\/managed-block-observer\.ts"\), join\(output, "managed-block-observer\.ts"\)\)/);
  assert.match(generator, /import \{ createManagedBlockObserver \} from "\.\/managed-block-observer\.ts"/);
  assert.match(generator, /import \{ getPermissionsService \} from "\.\/vendor\/src\/service\.ts"/);
  assert.match(generator, /const \{ subscribeManagedBlocks, wrapManagedBlocks \} = createManagedBlockObserver\(getPermissionsService\)/);
  assert.match(generator, /export \{ subscribeManagedBlocks \}/);
  assert.doesNotMatch(generator, /export type[^\n]*from "\.\/managed-block-observer\.ts"/);
  const helper = readFileSync(source, "utf8");
  for (const name of ["ManagedBlockFact", "ManagedBlockListener", "ManagedBlockSubscription", "ManagedBlockObserver"]) {
    assert.match(helper, new RegExp(`(?:interface|type) ${name}\\b`));
    assert.doesNotMatch(helper, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  assert.match(generator, /export \{ getPermissionsService \}/);
  assert.match(generator, /export \{ createReaderScratch \} from "\.\/vendor\/src\/policy\/managed-reader-scratch\.ts"/);
  assert.match(generator, /export \{ initializeManagedResourceProtection, getManagedResourceProtection \}/);
  const ordered = ["const managedPi = wrapManagedBlocks(pi)", "guardSingleAuthority(managedPi)",
    'managedPi.on("tool_call"', "originalBashDeny(event.input.command, ctx)", "await hardenGitInput(event.input, ctx.cwd)",
    "installManagedScratch(managedPi, hardenStaticFileInput)", "permissions(managedPi)"];
  let previous = -1;
  for (const snippet of ordered) {
    const index = generator.indexOf(snippet);
    assert(index > previous, `missing/out-of-order managed registration: ${snippet}`);
    previous = index;
  }
  assert.doesNotMatch(generator, /guardSingleAuthority\(pi\)|installManagedScratch\(pi,|permissions\(pi\)|\n  pi\.on\(/);
});
