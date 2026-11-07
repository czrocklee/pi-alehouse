// Source-only, offline identity regressions. Jiti evaluates the exact managed
// patches against the pinned upstream source in memory. No build/runtime output,
// shell tools, models, forwarding IO or network execute. Resolver/hardener seams
// below are explicit observations, not full policy or host acceptance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyManagedForwardingObservationPatch,
  applyManagedForwardedPrincipalPatch,
  applyManagedToolCallPrincipalPatch,
} from "../../scripts/build/patches/managed-principal-patch.mjs";
import { renderWorkers } from "../../scripts/build/generate-workers.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstream = join(root, "node_modules/@gotgenes/pi-permission-system");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: false,
  alias: { "#src": join(upstream, "src") },
});
const source = (path) => readFileSync(join(root, path), "utf8");
const patched = new Map();
const patch = (file, edits) => {
  let text = patched.get(file) ?? readFileSync(join(upstream, file), "utf8");
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length, 2, `Exact managed patch anchor: ${file}`);
    text = text.replace(before, after);
  }
  patched.set(file, text);
};
// Preserve production order for the shared forwarding source anchors.
applyManagedForwardingObservationPatch(upstream, patch);
applyManagedForwardedPrincipalPatch(upstream, patch);
applyManagedToolCallPrincipalPatch(upstream, patch);
const evaluate = (text, filename) => jiti.evalModule(text, { filename });
const { PermissionSession } = evaluate(
  patched.get("src/session/permission-session.ts"),
  join(upstream, "src/session/permission-session.ts"),
);
const { LocalPermissionsService } = evaluate(
  patched.get("src/service/permissions-service.ts"),
  join(upstream, "src/service/permissions-service.ts"),
);
const { ParentAuthorizer } = evaluate(
  patched.get("src/authority/approval-escalator.ts"),
  join(upstream, "src/authority/approval-escalator.ts"),
);
const { ForwardedRequestServer } = evaluate(
  patched.get("src/authority/forwarded-request-server.ts"),
  join(upstream, "src/authority/forwarded-request-server.ts"),
);
// Evaluate the public interface's complete module too: the added import must
// remain a type-only dependency and preserve the existing service registry.
evaluate(patched.get("src/service.ts"), join(upstream, "src/service.ts"));
const { posixPathFlavor } = await jiti.import(join(upstream, "src/path/path-flavor.ts"));
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { requireReadiness } = await jiti.import(
  join(root, "src/orchestration/permissions/readiness.ts"),
);
const { metadata } = renderWorkers(root);
const guard = evaluate(
  source("src/extensions/static-safety-guard.ts").replace(
    "/* @worker-policy@ */ {}",
    JSON.stringify(metadata),
  ),
  join(root, "src/extensions/static-safety-guard.ts"),
);
const { installManagedScratch } = evaluate(
  source("src/authority/managed-scratch.ts").replace(
    '"./node_modules/@gotgenes/pi-permission-system/src/service.ts"',
    JSON.stringify(join(upstream, "src/service.ts")),
  ),
  join(root, "src/authority/managed-scratch.ts"),
);
const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
const record = (name) => ({ type: "custom", customType: "active_agent", data: { name } });

function authority() {
  const session = new PermissionSession(
    {},
    { start() {}, stop() {} },
    { configureForCwd() {} },
    { clear() {} },
    {},
    { activate() {}, deactivate() {} },
    posixPathFlavor,
  );
  const intents = [];
  const service = new LocalPermissionsService(
    {
      resolve(intent) {
        intents.push(intent);
        return { state: intent.agentName === "researcher" ? "deny" : "allow" };
      },
    },
    session,
    {},
    {},
    {},
  );
  return { session, service, intents };
}

function context(entries = [], id = randomUUID()) {
  return {
    cwd: root,
    getSystemPrompt() {
      throw new Error("Prompt identity access is forbidden");
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch() {
        throw new Error("Branch identity access is forbidden");
      },
      getSessionId: () => id,
    },
  };
}

function bus() {
  const events = new Map();
  return {
    on(name, fn) {
      const listeners = events.get(name) ?? new Set();
      events.set(name, listeners);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(name, data) {
      for (const fn of events.get(name) ?? []) fn(data);
    },
  };
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "alehouse-source-principal-"));
  const configDir = join(base, "extensions/pi-permission-system");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), source("resources/permissions.json"));
  const previous = globalThis[servicesKey];
  const services = new Map();
  globalThis[servicesKey] = services;
  t.after(() => {
    if (previous === undefined) delete globalThis[servicesKey];
    else globalThis[servicesKey] = previous;
    rmSync(base, { recursive: true, force: true });
  });
  const events = bus();
  function register(ctx) {
    const handlers = new Map();
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = base;
    try {
      guard.default({ on: (name, fn) => handlers.set(name, fn), events });
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
    }
    handlers.get("session_start")({}, ctx);
    return {
      call: (toolName, input = {}) => handlers.get("tool_call")({ toolName, input }, ctx),
      start: () => handlers.get("session_start")({}, ctx),
      shutdown: () => handlers.get("session_shutdown")({}, ctx),
    };
  }
  const ready = (ctx, profile) =>
    requireReadiness(
      events,
      (id) => services.get(id),
      ctx.sessionManager.getSessionId(),
      profile,
      metadata[profile].digest,
    );
  return { base, services, events, register, ready };
}

const rootPrompts = [
  "ordinary instructions",
  "<active_agents>list</active_agents>",
  '`<active_agent name="researcher"/>`',
  '```xml\n<active_agent name="researcher"/>\n```',
  '<active_agent name="researcher"/>',
  '<active_agent name="editor"/>\n<active_agent name="researcher"/>',
  "<active_agent_metrics>example</active_agent_metrics>",
];

test("managed authority never selects or caches a principal from prompt prose", () => {
  const { session, service, intents } = authority();
  const ctx = context();
  for (const prompt of rootPrompts) {
    assert.equal(session.resolveAgentName(ctx, prompt), null);
    assert.equal(service.getToolCallAgentName(ctx), null);
    assert.equal(service.checkToolCallPermission("agent_answer", ctx).state, "allow");
    assert.equal(intents.at(-1).agentName, undefined);
    assert.equal(session.lastKnownActiveAgentName, null);
  }
  assert.doesNotMatch(
    patched.get("src/session/permission-session.ts"),
    /getActiveAgentNameFromSystemPrompt/,
  );
});

test("service query/peek and actual resolver agree on all-tree records, normalization and retained null cache", () => {
  for (const cached of [false, true]) {
    for (const [tail, expected] of [
      [[], cached ? "editor" : null],
      [[record(null)], cached ? "editor" : null],
      [[record("researcher"), record(null)], cached ? "editor" : null],
      [[record("editor"), record("")], "editor"],
      [[record("editor"), record("   ")], "editor"],
      [[record("editor"), record(23)], "editor"],
      [[record("editor"), record(" researcher ")], "researcher"],
      [[record("unknown-profile")], "unknown-profile"],
    ]) {
      const { session, service, intents } = authority();
      if (cached) session.resolveAgentName(context([record("editor")]));
      const ctx = context(tail);
      const before = session.lastKnownActiveAgentName;
      assert.equal(service.getToolCallAgentName(ctx), expected);
      assert.equal(session.peekToolCallAgentName(ctx), expected);
      service.checkToolCallPermission("agent_answer", ctx);
      assert.equal(intents.at(-1).agentName, expected ?? undefined);
      assert.equal(
        session.lastKnownActiveAgentName,
        before,
        "Read-only queries cannot remember a name",
      );
      assert.equal(session.resolveAgentName(ctx, '<active_agent name="researcher"/>'), expected);
      assert.equal(session.lastKnownActiveAgentName, expected);
    }
  }
  const sm = SessionManager.inMemory(root);
  const anchor = sm.appendCustomEntry("fixture-anchor", {});
  const researcher = sm.appendCustomEntry("active_agent", { name: "researcher" });
  sm.branch(anchor);
  sm.appendCustomEntry("active_agent", { name: "editor" });
  sm.branch(researcher);
  assert.equal(sm.getBranch().at(-1).data.name, "researcher");
  const ctx = { ...context(), sessionManager: sm };
  const { session, service } = authority();
  assert.equal(service.getToolCallAgentName(ctx), "editor");
  assert.equal(
    session.resolveAgentName(ctx),
    "editor",
    "All entries, not branch, own the actual gate",
  );
});

test("expected binding only narrows existing identity, rejects competing instances, and checks every gate projection", () => {
  const { session, service } = authority();
  const entries = [record("researcher")];
  const ctx = context(entries);
  assert.equal(service.bindExpectedToolCallAgent(context(), "researcher", "one"), false);
  assert.equal(
    service.bindExpectedToolCallAgent(context([record(" researcher ")]), "researcher", "one"),
    false,
  );
  assert.equal(service.bindExpectedToolCallAgent(ctx, "researcher", "one"), true);
  assert.equal(service.bindExpectedToolCallAgent(ctx, "researcher", "two"), false);
  assert.equal(service.bindExpectedToolCallAgent(ctx, "editor", "one"), false);
  assert.equal(service.bindExpectedToolCallAgent(ctx, "researcher", "one"), true);
  assert.equal(session.lastKnownActiveAgentName, null);
  assert.equal(service.checkToolCallPermission("agent_answer", ctx).state, "deny");
  assert.equal(session.resolveAgentName(ctx), "researcher");
  for (const invalid of [
    [],
    [record(null)],
    [record("editor")],
    [record("unknown-profile")],
    [record("researcher"), record("")],
    [record("researcher"), record(4)],
    [record(" researcher ")],
  ]) {
    entries.splice(0, entries.length, ...invalid);
    for (const query of [
      () => session.resolveAgentName(ctx),
      () => session.peekToolCallAgentName(ctx),
      () => service.getToolCallAgentName(ctx),
      () => service.checkToolCallPermission("agent_answer", ctx),
    ])
      assert.throws(query, /PRINCIPAL_MISMATCH/);
    assert.equal(session.lastKnownActiveAgentName, "researcher");
  }
  assert.equal(service.releaseExpectedToolCallAgent("two"), false);
  assert.throws(() => service.getToolCallAgentName(ctx), /PRINCIPAL_MISMATCH/);
  assert.equal(service.releaseExpectedToolCallAgent("one"), true);
  entries.length = 0;
  assert.equal(
    service.getToolCallAgentName(ctx),
    "researcher",
    "Unbound legacy null-cache semantics retained",
  );
  entries.push(record("researcher"));
  service.bindExpectedToolCallAgent(ctx, "researcher", "one");
  session.resetForNewSession(context(), false);
  assert.equal(
    service.bindExpectedToolCallAgent(ctx, "researcher", "two"),
    true,
    "New session resets restriction",
  );
  session.shutdown();
  assert.equal(service.bindExpectedToolCallAgent(ctx, "researcher", "three"), true);
});

test("ordinary root AGENTS/XML quotations keep global denies with or without authority", (t) => {
  const f = fixture(t);
  const ctx = context();
  const registered = f.register(ctx);
  const { session, service } = authority();
  for (const composed of [false, true]) {
    if (composed) f.services.set(ctx.sessionManager.getSessionId(), service);
    for (const prompt of rootPrompts) {
      ctx.getSystemPrompt = () => {
        throw new Error(`Must not inspect AGENTS prose: ${prompt}`);
      };
      assert.equal(session.resolveAgentName(ctx, prompt), null);
      assert.equal(guard.activeAgent(ctx), undefined);
      assert.equal(registered.call("bash", { command: "pwd" }), undefined);
      assert.equal(guard.originalBashDeny("pwd", ctx, f.base), undefined);
      assert.equal(registered.call("bash", { command: "sudo true" }).block, true);
      assert.ok(guard.originalBashDeny("sudo true", ctx, f.base));
    }
  }
});

test("guard uses the actual remembered gate name and keeps the researcher floor", (t) => {
  const f = fixture(t);
  const entries = [record("researcher")];
  const ctx = context(entries);
  const { session, service } = authority();
  f.services.set(ctx.sessionManager.getSessionId(), service);
  const g = f.register(ctx);
  session.resolveAgentName(ctx);
  entries.push(record(null));
  assert.equal(guard.activeAgent(ctx), "researcher");
  assert.equal(g.call("bash", { command: "git commit -m fixture" }).block, true);
  assert.ok(guard.originalBashDeny("git commit -m fixture", ctx, f.base));
  entries.push(record(" editor "));
  assert.equal(guard.activeAgent(ctx), "editor");
  assert.equal(g.call("bash", { command: "git commit -m fixture" }), undefined);
  entries.push(record("unknown-profile"));
  assert.equal(g.call("read", { path: "ordinary.txt" }).block, true);
});

test("nonce readiness binds the real service; lost/wrong/unknown child identity blocks every tool", (t) => {
  const f = fixture(t);
  const entries = [record("researcher")];
  const ctx = context(entries);
  const { session, service } = authority();
  f.services.set(ctx.sessionManager.getSessionId(), service);
  const g = f.register(ctx);
  const ready = f.ready(ctx, "researcher");
  assert.equal(ready.profile, "researcher");
  assert.equal(ready.definitionDigest, metadata.researcher.digest);
  assert.equal(
    session.lastKnownActiveAgentName,
    null,
    "Readiness does not create remembered authority",
  );
  assert.equal(g.call("read", { path: "ordinary.txt" }), undefined);
  for (const next of [
    [],
    [record(null)],
    [record("editor")],
    [record("unknown-profile")],
    [record(" researcher ")],
  ]) {
    entries.splice(0, entries.length, ...next);
    for (const toolName of [
      "read",
      "write",
      "edit",
      "grep",
      "find",
      "ls",
      "bash",
      "web_search",
      "alert_parent",
      "custom_tool",
    ]) {
      const blocked = g.call(toolName, { command: "pwd", path: "ordinary.txt" });
      assert.equal(blocked?.block, true, `${toolName}: ${JSON.stringify(next)}`);
      assert.match(blocked.reason, /principal/);
    }
    assert.throws(() => f.ready(ctx, "researcher"), /STATIC_GUARD_NOT_READY/);
  }
  entries.splice(0, entries.length, record("researcher"));
  f.services.delete(ctx.sessionManager.getSessionId());
  assert.equal(g.call("read").block, true, "A bound child cannot degrade to standalone guard");
});

test("readiness refuses unavailable/partial/invalid services and non-exact raw records", (t) => {
  const f = fixture(t);
  const entries = [record("editor")];
  const ctx = context(entries);
  const g = f.register(ctx);
  assert.throws(() => f.ready(ctx, "editor"), /PERMISSION_NOT_READY/);
  for (const bad of [
    {},
    { getToolCallAgentName: () => "editor" },
    { getToolCallAgentName: () => "editor", bindExpectedToolCallAgent: () => true },
    {
      getToolCallAgentName: () => "editor",
      bindExpectedToolCallAgent: () => Promise.resolve(true),
      releaseExpectedToolCallAgent() {},
    },
  ]) {
    f.services.set(ctx.sessionManager.getSessionId(), bad);
    assert.throws(() => f.ready(ctx, "editor"), /STATIC_GUARD_NOT_READY/);
  }
  for (const value of [
    undefined,
    null,
    false,
    "",
    " editor ",
    "unknown-profile",
    Promise.resolve("editor"),
  ]) {
    f.services.set(ctx.sessionManager.getSessionId(), {
      getToolCallAgentName: () => value,
      bindExpectedToolCallAgent: () => true,
      releaseExpectedToolCallAgent() {},
    });
    assert.throws(() => f.ready(ctx, "editor"), /STATIC_GUARD_NOT_READY/);
    assert.equal(g.call("read").block, true);
  }
  f.services.set(ctx.sessionManager.getSessionId(), authority().service);
  for (const bad of [" editor ", null, "researcher", 3]) {
    entries.splice(0, entries.length, record(bad));
    assert.throws(() => f.ready(ctx, "editor"), /STATIC_GUARD_NOT_READY/);
  }
});

test("duplicate guard shutdown cannot release another instance; session_start releases only its own binding", (t) => {
  const f = fixture(t);
  const entries = [record("editor")];
  const ctx = context(entries);
  const { service } = authority();
  f.services.set(ctx.sessionManager.getSessionId(), service);
  const owner = f.register(ctx);
  const one = f.ready(ctx, "editor");
  const duplicate = f.register(ctx);
  const again = f.ready(ctx, "editor");
  assert.equal(
    again.instanceId,
    one.instanceId,
    "Competing instance cannot overwrite binding or ack",
  );
  duplicate.shutdown();
  entries.length = 0;
  assert.throws(() => service.getToolCallAgentName(ctx), /PRINCIPAL_MISMATCH/);
  entries.push(record("editor"));
  owner.start();
  assert.equal(
    service.releaseExpectedToolCallAgent(one.instanceId),
    false,
    "Prior start binding was released",
  );
  const two = f.ready(ctx, "editor");
  assert.notEqual(two.instanceId, one.instanceId);
  owner.shutdown();
  assert.equal(service.releaseExpectedToolCallAgent(two.instanceId), false);
  entries.length = 0;
  assert.equal(service.getToolCallAgentName(ctx), null);
  assert.throws(() => f.ready(ctx, "editor"), /STATIC_GUARD_NOT_READY/);
});

test("scratch authenticates current and parent journals only under the actual gate principal", async (t) => {
  const f = fixture(t);
  const priorHome = process.env.HOME;
  process.env.HOME = f.base;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const child = randomUUID(),
    parent = randomUUID();
  const sessions = join(f.base, ".pi/agent/sessions");
  for (const path of [
    join(f.base, ".pi"),
    join(f.base, ".pi/agent"),
    sessions,
    join(sessions, parent),
    join(sessions, parent, "tasks"),
  ])
    mkdirSync(path, { mode: 0o700 });
  const currentFile = join(sessions, parent, "tasks", `${child}.jsonl`);
  const parentFile = join(sessions, `${parent}.jsonl`);
  const scratchRecord = (sessionId, path) => ({
    type: "custom",
    customType: "managed-scratch-created",
    data: {
      version: 1,
      sessionId,
      path,
      dev: "1",
      ino: "2",
      uid: process.geteuid(),
      birthtimeNs: "1",
      observedAt: 1,
    },
  });
  const current = scratchRecord(child, "/tmp/tmp.CurrentFixture");
  const inherited = scratchRecord(parent, "/tmp/tmp.ParentFixture");
  writeFileSync(currentFile, "synthetic journal\n", { mode: 0o600 });
  writeFileSync(
    parentFile,
    [{ type: "session", id: parent }, inherited].map(JSON.stringify).join("\n") + "\n",
    { mode: 0o600 },
  );
  const entries = [record("researcher"), record(null), current];
  const ctx = context(entries, child);
  ctx.sessionManager.getSessionFile = () => currentFile;
  ctx.sessionManager.getHeader = () => ({ parentSession: parent });
  const { session, service } = authority();
  session.resolveAgentName(context([record("editor")]));
  const observations = [];
  const actualCheck = service.checkPermission.bind(service);
  service.checkPermission = (...args) => {
    observations.push(args);
    return actualCheck(...args);
  };
  const hardenWith = async (selected) => {
    f.services.set(child, selected);
    const handlers = new Map();
    let roots;
    installManagedScratch(
      { on: (name, fn) => handlers.set(name, fn), appendEntry() {} },
      async (_input, value) => {
        roots = value;
      },
    );
    handlers.get("session_start")({}, ctx);
    await handlers.get("tool_call")(
      { toolName: "bash", toolCallId: randomUUID(), input: { command: "pwd" } },
      ctx,
    );
    return roots;
  };
  assert.deepEqual(
    await hardenWith(service),
    [],
    "Remembered editor can write; branch researcher cannot authenticate roots",
  );
  assert.deepEqual(
    observations.map((args) => args[2]),
    ["editor"],
  );
  observations.length = 0;
  entries.push(record(" researcher "));
  assert.equal(session.lastKnownActiveAgentName, "editor");
  assert.equal(
    (await hardenWith(service)).length,
    2,
    "Both protected journals restore after actual researcher denies",
  );
  assert.deepEqual(
    observations.map((args) => args[2]),
    ["researcher", "researcher"],
  );
  assert.equal(session.lastKnownActiveAgentName, "editor", "Scratch query is read-only");
  for (const selected of [
    undefined,
    {},
    { checkPermission: () => ({ state: "deny" }) },
    {
      getToolCallAgentName() {
        throw new Error("unavailable");
      },
    },
    ...[undefined, "", "   ", " researcher ", 4, Promise.resolve("researcher")].map((value) => ({
      getToolCallAgentName: () => value,
      checkPermission: () => ({ state: "deny" }),
    })),
    {
      getToolCallAgentName: () => "researcher",
      checkPermission() {
        throw new Error("unavailable");
      },
    },
  ]) {
    assert.deepEqual(
      await hardenWith(selected),
      [],
      "Unavailable principal/check cannot restore provenance",
    );
  }
  const rootChecks = [];
  assert.equal(
    (
      await hardenWith({
        getToolCallAgentName: () => null,
        checkPermission(...args) {
          rootChecks.push(args);
          return { state: "deny" };
        },
      })
    ).length,
    2,
  );
  assert.deepEqual(
    rootChecks.map((args) => args[2]),
    [undefined, undefined],
    "Explicit root is valid, missing API is not root",
  );
  assert.doesNotMatch(
    source("src/authority/managed-scratch.ts"),
    /getBranch\(|function activeAgent|getToolPermission/,
  );
});

test("forwarded edge stamps the same actual named principal as the gate, never prompt or a raw record cache guess", (t) => {
  const f = fixture(t);
  const facts = {
    requestId: "synthetic-request",
    payload: { synthetic: true },
    accessIntent: {
      surface: "path_read",
      matchValues: ["/synthetic/ordinary.txt"],
      boundaryValue: "/synthetic/ordinary.txt",
    },
  };
  for (const profile of ["editor", "researcher"]) {
    const entries = [record(profile)];
    const ctx = context(entries);
    const { session, service } = authority();
    f.services.set(ctx.sessionManager.getSessionId(), service);
    const edge = new ParentAuthorizer(ctx, {});
    service.bindExpectedToolCallAgent(ctx, profile, "guard-instance");
    const request = edge.buildForwardedRequest(
      ctx,
      facts,
      ctx.sessionManager.getSessionId(),
      "parent-session",
    );
    assert.equal(request.requesterAgentName, profile);
    assert.deepEqual(request.accessIntent.principal, {
      sessionId: ctx.sessionManager.getSessionId(),
      agentName: profile,
    });
    assert.equal(request.accessIntent.requesterCwd, ctx.cwd);
    assert.deepEqual(request.accessIntent.matchValues, facts.accessIntent.matchValues);
    assert.equal(request.payload, facts.payload);
    assert.equal(session.lastKnownActiveAgentName, null, "Forwarding is read-only");
    session.resolveAgentName(ctx);
    entries.push(record(null));
    assert.equal(
      edge.buildForwardedRequest(ctx, facts, ctx.sessionManager.getSessionId(), "parent-session"),
      null,
      "Lost bound identity never forwards under cached name",
    );
    service.releaseExpectedToolCallAgent("guard-instance");
    const cached = edge.buildForwardedRequest(
      ctx,
      facts,
      ctx.sessionManager.getSessionId(),
      "parent-session",
    );
    assert.equal(
      cached.requesterAgentName,
      profile,
      "Unbound edge honors actual gate cache, not raw decoder null",
    );
  }
  assert.doesNotMatch(
    patched.get("src/authority/approval-escalator.ts"),
    /getActiveAgentNameFromSystemPrompt|getContextSystemPrompt|toRecord/,
  );
});

test("normal source forwarded envelopes retain named policy and mismatch denial without approval IO", async (t) => {
  const f = fixture(t);
  const calls = [];
  const server = new ForwardedRequestServer({
    policy: {
      resolve(intent) {
        calls.push(intent);
        return { state: intent.principal.agentName === "researcher" ? "deny" : "allow" };
      },
    },
    logger: { review() {} },
    escalator: {
      escalate() {
        throw new Error("No human approval is authorized");
      },
    },
  });
  for (const profile of ["editor", "researcher"]) {
    const ctx = context([record(profile)]);
    f.services.set(ctx.sessionManager.getSessionId(), authority().service);
    const edge = new ParentAuthorizer(ctx, {});
    const request = edge.buildForwardedRequest(
      ctx,
      {
        requestId: "fixture",
        payload: {},
        accessIntent: {
          surface: "path_write",
          matchValues: ["/synthetic/ordinary.txt"],
          boundaryValue: "/synthetic/ordinary.txt",
        },
      },
      ctx.sessionManager.getSessionId(),
      "parent-session",
    );
    const result = await server.resolveDecision(request, {});
    assert.equal(result.approved, profile === "editor");
    assert.equal(result.decidedBy.kind, "rule");
    const previous = calls.length;
    const mismatched = await server.resolveDecision(
      { ...request, requesterAgentName: profile === "editor" ? "researcher" : "editor" },
      {},
    );
    assert.equal(mismatched.approved, false);
    assert.equal(mismatched.decidedBy.kind, "gate_error");
    assert.equal(calls.length, previous);
  }
  assert.deepEqual(
    calls.map((intent) => intent.principal.agentName),
    ["editor", "researcher"],
  );
});

test("unavailable/null/malformed forwarded principal returns unavailable before any forwarding IO", async (t) => {
  const f = fixture(t);
  const ctx = context();
  const id = ctx.sessionManager.getSessionId();
  const edge = new ParentAuthorizer(ctx, {
    // Any attempt to prepare forwarding paths would throw. Invalid identity
    // must produce an ordinary unavailable decision before touching this seam.
    forwardingDir: null,
    registry: { get: () => ({ parentSessionId: "parent-session" }) },
  });
  const facts = { requestId: "fixture", payload: {} };
  for (const selected of [
    undefined,
    {},
    authority().service,
    {
      getToolCallAgentName() {
        throw new Error("unavailable");
      },
    },
    ...[null, undefined, "", " editor ", 4, Promise.resolve("editor")].map((value) => ({
      getToolCallAgentName: () => value,
    })),
  ]) {
    f.services.set(id, selected);
    assert.equal(edge.buildForwardedRequest(ctx, facts, id, "parent-session"), null);
    const decision = await edge.waitForForwardedApproval(ctx, facts);
    assert.equal(decision.approved, false);
    assert.equal(decision.confirmationUnavailable, true);
    assert.match(decision.denialReason, /actual named tool-call principal/);
  }
});

test("the source guard self-test uses the normal registrar and accepts root documentation", async (t) => {
  const f = fixture(t);
  // Same explicit data-only static allowances used by the portable policy
  // fixture. These are not added to shipped policy or the authority.
  const config = JSON.parse(source("resources/permissions.json"));
  for (const pattern of [
    "git status --short",
    "mktemp -d",
    "pwd",
    "nl *",
    "sha256sum *",
    "echo *",
    "printf *",
    "ls *",
    "stat *",
    "rg --no-config *",
    "cd *",
    "head *",
    "wc *",
    "cat *",
    "tail *",
    "cut *",
    "tr *",
    "basename *",
    "dirname *",
    "readlink *",
    "realpath *",
    "uname *",
  ])
    config.permission.bash[pattern] = "allow";
  writeFileSync(
    join(f.base, "extensions/pi-permission-system/config.json"),
    JSON.stringify(config),
  );
  const { safetySelfTest } = await jiti.import(
    join(root, "scripts/checks/static-safety-selftest.ts"),
  );
  safetySelfTest(f.base, {
    guard: guard.default,
    workerProfiles: Object.keys(metadata),
    inspectGitCommands: guard.inspectGitCommands,
  });
});
