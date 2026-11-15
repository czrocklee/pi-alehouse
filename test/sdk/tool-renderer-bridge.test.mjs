/**
 * Real-SDK bridge regressions for child tool renderers: the production
 * `createChildSessionFactory` binds each child's public tool renderers onto
 * its registry observation, and disposal retires them without relying on a
 * possibly blocked shutdown handler.
 *
 * The factory, activity registry and digest are loaded from source through
 * jiti (`fsCache: false`), never a stale dist build. The child is a real
 * pinned-SDK `createAgentSession` with a synthetic in-memory provider and a
 * controlled permission extension that satisfies the production readiness
 * protocol (probe/ready on the child bus, permissions-service registration):
 * no real model, credentials or network are exercised, and the read/bash/edit
 * tools under test are never executed — only their recorded native renderers
 * are rendered. The parent UI's sanitizer and communication-bubble behavior
 * are covered by their own tests, not here.
 *
 * Skill discovery stays at the production default (on). HOME, XDG dirs and
 * PI_CODING_AGENT_DIR are owned temp paths set before any SDK or source import
 * that reads them, so neither factory fixture can see the operator's skills
 * or auth. A synthetic skill under that home is the discovery canary.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Per-file process isolation; never discover the operator's skills or settings.
// Must run before SDK and source imports: several of those read HOME / agent
// dir while the module is initializing, not only when a session is created.
const ambientHome = process.env.HOME;
const isolatedEnvKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
];
const previousEnv = Object.fromEntries(isolatedEnvKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "alehouse-renderer-bridge-home-"));
const canarySkill = join(home, ".agents", "skills", "owned-renderer-canary", "SKILL.md");
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
// Bound project .agents ancestor discovery as well as user-level discovery.
await mkdir(join(home, ".git"));
await mkdir(join(home, ".agents", "skills", "owned-renderer-canary"), { recursive: true });
await writeFile(
  canarySkill,
  "---\nname: owned-renderer-canary\ndescription: Use for owned-renderer-canary fixture tasks.\n---\nPRIVATE_BODY_owned-renderer-canary\n",
);
test.after(async () => {
  for (const key of isolatedEnvKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await rm(home, { recursive: true, force: true });
});

const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const { initTheme } = sdk;
const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
const { initialize } = await import("../../scripts/init.mjs");

// The bash renderers style through the SDK's global theme singleton.
initTheme("dark", false);

// Load the production source, not a potentially stale dist build.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const jiti = createJiti(import.meta.url, { fsCache: false });
const { createChildSessionFactory } = await jiti.import(
  "../../src/orchestration/runtime/child-factory.ts",
);
const { ChildActivityRegistry } = await jiti.import(
  "../../src/orchestration/runtime/activity-observer.ts",
);
const { digest } = await jiti.import("../../src/orchestration/runtime/context-snapshot.ts");
// The real generated authority entry: the same module identity contract the
// launcher loads. Importing resolves the public service accessors; the child
// session below loads its own extension copy through the SDK loader.
const authority = await jiti.import("../../generated/authority/index.ts");

// Same-process channel between this fixture and the synthetic permission
// extension the factory loads into the child (see permissionExtensionSource).
const sessionsKey = Symbol.for("alehouse-tests:renderer-bridge:sessions");
const configKey = Symbol.for("alehouse-tests:renderer-bridge:config");
const sessions = (globalThis[sessionsKey] ??= new Map());
const config = (globalThis[configKey] ??= {});

// Controlled readiness stand-in matching the production protocol consumed by
// src/orchestration/permissions/readiness.ts. It is test scaffolding, never a
// permission bypass: it only acknowledges the synthetic probe and registers
// the synthetic session in the fixture's permissions map.
const permissionExtensionSource = `
import { randomUUID } from "node:crypto";
const sessions = globalThis[Symbol.for("alehouse-tests:renderer-bridge:sessions")];
const config = globalThis[Symbol.for("alehouse-tests:renderer-bridge:config")];
export default (pi) => {
  let ready;
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    sessions.set(sessionId, { synthetic: true });
    ready = { sessionId, instanceId: randomUUID() };
  });
  pi.events.on("pi-alehouse:static-guard:probe", (data) => {
    if (!ready || data?.sessionId !== ready.sessionId || typeof data?.nonce !== "string") return;
    pi.events.emit("pi-alehouse:static-guard:ready", {
      protocol: 1,
      sessionId: ready.sessionId,
      instanceId: ready.instanceId,
      nonce: data.nonce,
      profile: data.profile,
      definitionDigest: config.definitionDigest,
    });
  });
  pi.on("session_shutdown", () => {
    if (config.blockShutdown) return new Promise(() => {});
    ready = undefined;
  });
};
`;

const passthroughTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** Minimal honest render context for recorded history: the execution never
 * started and the arguments were never confirmed complete, so no renderer
 * reads the current worktree through the native edit preview path. */
const renderContext = (root, args) => ({
  args,
  toolCallId: "synthetic-recorded-call",
  invalidate: () => {},
  lastComponent: undefined,
  state: {},
  cwd: root,
  executionStarted: false,
  argsComplete: false,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
});

/** Render a renderer Component (or plain string) to comparable text. */
const textOf = (component) =>
  stripTerminalSequences(
    (typeof component === "string" ? [component] : component.render(120)).join("\n"),
  );

/** A synthetic in-memory provider runtime; the model never runs. */
async function syntheticRuntime() {
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new ai.InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  runtime.registerProvider("renderer-bridge", {
    api: "renderer-bridge",
    apiKey: "synthetic-not-a-credential",
    baseUrl: "https://invalid.invalid",
    models: [
      {
        id: "controlled",
        name: "Controlled renderer bridge",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      },
    ],
    streamSimple() {
      assert.fail("the renderer bridge fixture never runs the model");
    },
  });
  return runtime;
}

async function fixture(t, { sentinelFor } = {}) {
  const root = await mkdtemp(join(home, "alehouse-renderer-bridge-"));
  const network = t.mock.method(globalThis, "fetch", () => {
    assert.fail("renderer bridge fixture attempted network IO");
  });
  const permissionRoot = join(root, "permission"),
    policyRoot = join(root, "policy");
  await mkdir(permissionRoot);
  await mkdir(policyRoot);
  await writeFile(join(permissionRoot, "index.ts"), permissionExtensionSource);
  await writeFile(join(policyRoot, "static-safety-guard.ts"), "export default () => {};\n");
  await writeFile(join(policyRoot, "policy-grep.ts"), "export default () => {};\n");
  config.blockShutdown = false;
  const definition = "Synthetic renderer bridge worker definition";
  const definitionDigest = digest(definition);
  config.definitionDigest = definitionDigest;
  const tools = ["read", "bash", "edit"];
  const profiles = { editor: { definition, body: "Synthetic worker body.", tools } };
  const runtime = await syntheticRuntime();
  const events = [];
  const activities = new ChildActivityRegistry();
  const childSessionIds = [];
  const prompts = [];
  const createSession = createChildSessionFactory({
    ctx: {
      sessionManager: {
        getSessionDir: () => root,
        getSessionFile: () => join(root, "parent-session.jsonl"),
      },
    },
    parentBus: { emit: (type, data) => events.push({ type, data }) },
    agentDir: root,
    permissionRoot,
    policyRoot,
    parentId: "renderer-bridge-parent",
    runtime,
    profiles,
    settings: () => sdk.SettingsManager.inMemory({}),
    parentHistory: {
      getSessionId: () => "renderer-bridge-parent",
      isPersisted: () => false,
      appendCustomEntry: () => {},
    },
    approvalBindings: {
      // Dual-purpose synthetic stand-in: the production approval extension is
      // not under test here; this one also marks the child's public read
      // renderers with a per-child sentinel through the public
      // registerToolRenderer resolver API.
      childExtension: (sessionId) => {
        childSessionIds.push(sessionId);
        return (pi) => {
          pi.on("session_start", (_event, ctx) => {
            prompts.push(ctx.getSystemPrompt());
          });
          const sentinel = sentinelFor?.(sessionId);
          if (!sentinel) return;
          pi.registerToolRenderer((name, next) =>
            name === "read" ? { renderCall: sentinel } : next(),
          );
        };
      },
      begin() {},
      end() {},
    },
    activities,
    parentPermission: () => ({ synthetic: true }),
    getPermissionsService: (id) => sessions.get(id),
    subscribeManagedBlocks: () => () => {},
  });
  const ports = [];
  const create = async (agentId) => {
    const port = await createSession({
      agent_id: agentId,
      name: `Renderer bridge ${agentId}`,
      settings: {
        profile: "editor",
        cwd: root,
        definition_digest: definitionDigest,
        tools: [...tools],
        provider: "renderer-bridge",
        model: "controlled",
        thinking: "off",
        parent_thinking: "off",
        thinking_resolution: "identity",
        preset: "fixture",
        preset_version: "v1",
        selection_digest: "b".repeat(64),
        difficulty: 3,
        strength: "d3",
      },
    });
    ports.push(port);
    return port;
  };
  t.after(async () => {
    try {
      config.blockShutdown = false;
      for (const port of ports) await port.dispose().catch(() => {});
      assert.equal(network.mock.callCount(), 0, "fixture must not touch the network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, activities, events, create, childSessionIds, prompts };
}

/** Skill locations must be the owned home canary or this fixture's temp roots.
 * Discovery stays on: turning it off would hide an ambient HOME leak. */
function assertOwnedSkillDiscovery(prompt, roots) {
  assert.match(prompt, /<name>owned-renderer-canary<\/name>/);
  assert.doesNotMatch(prompt, /PRIVATE_BODY_/, "skill bodies stay on demand");
  const locations = [...prompt.matchAll(/<location>([^<]*)<\/location>/g)].map((match) => match[1]);
  assert(
    locations.some((location) =>
      location.endsWith("/.agents/skills/owned-renderer-canary/SKILL.md"),
    ),
    "the owned home skill was not discovered",
  );
  for (const location of locations) {
    assert(
      roots.some((root) => location === root || location.startsWith(`${root}/`)),
      `skill discovery left owned roots: ${location}`,
    );
    assert(
      !ambientHome || ambientHome === home || !location.startsWith(`${ambientHome}/`),
      `skill discovery used ambient HOME: ${location}`,
    );
  }
}

/** The child's read/bash/edit renderers must be the SDK's native builtin
 * renderers reached through the public lookup — never a generic dump. */
function assertNativeChildRenderers(observation, root) {
  const read = observation.toolRenderers?.("read");
  assert(read, "the bound lookup resolves the child's public read definition");
  assert.equal(typeof read.renderCall, "function");
  assert.equal(typeof read.renderResult, "function");
  assert(!("execute" in read), "the projection never exposes execute");
  for (const key of Object.keys(read)) {
    assert(
      key === "renderCall" || key === "renderResult" || key === "renderShell",
      `unexpected projected field: ${key}`,
    );
  }
  const readCall = textOf(
    read.renderCall(
      { path: "notes.txt" },
      passthroughTheme,
      renderContext(root, { path: "notes.txt" }),
    ),
  );
  assert.match(readCall, /\bread\s+notes\.txt/, "the native read call format is rendered");
  assert(!readCall.includes('"path"'), "the native format is not a generic argument dump");
  const readResult = textOf(
    read.renderResult(
      { content: [{ type: "text", text: "alpha bridge line\nbeta bridge line" }] },
      { isPartial: false, expanded: true, isError: false },
      passthroughTheme,
      renderContext(root, { path: "notes.txt" }),
    ),
  );
  assert(readResult.includes("alpha bridge line"), "the native read result format is rendered");

  const bash = observation.toolRenderers?.("bash");
  assert(bash, "the bound lookup resolves the child's public bash definition");
  const bashCall = textOf(
    bash.renderCall(
      { command: "echo native-render" },
      passthroughTheme,
      renderContext(root, { command: "echo native-render" }),
    ),
  );
  assert(bashCall.includes("echo native-render"), "the native shell call format is rendered");
  assert(bashCall.includes("$"), "the shell prompt marker is present");
  assert(!bashCall.includes('"command"'));

  const edit = observation.toolRenderers?.("edit");
  assert(edit, "the bound lookup resolves the child's public edit definition");
  assert.equal(edit.renderShell, "self", "the native edit shell marker is projected");
  const editCall = textOf(
    edit.renderCall(
      { path: "notes.txt", oldText: "a", newText: "b" },
      passthroughTheme,
      renderContext(root, { path: "notes.txt", oldText: "a", newText: "b" }),
    ),
  );
  assert.match(
    editCall,
    /edit\s+notes\.txt/,
    "the native edit call format is rendered, not a generic argument dump",
  );
  assert(!editCall.includes('"oldText"'));

  // Blocked and retired delegation names stay unreachable through the bound
  // child lookup; they are excluded from the child loadout.
  assert.equal(observation.toolRenderers?.("agent_spawn"), undefined);
  assert.equal(observation.toolRenderers?.("subagent"), undefined);
}

test(
  "production factory binds child-native read/bash/edit renderers on the public observation",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.create("bridge-native");
    const observation = f.activities.observations.get("bridge-native");
    assert(observation, "the production registry tracks the child activity");
    assertNativeChildRenderers(observation, f.root);
    assert.equal(f.prompts.length, 1, "the child published its system prompt");
    assertOwnedSkillDiscovery(f.prompts[0], [home, f.root]);
  },
);

test(
  "resolver overrides come from the current child, never a parent-side cache",
  { timeout: 30000 },
  async (t) => {
    const sentinelA = () => "sentinel-a";
    const sentinelB = () => "sentinel-b";
    let current = sentinelA;
    const f = await fixture(t, { sentinelFor: () => current });

    const portA = await f.create("bridge-a");
    const observationA = f.activities.observations.get("bridge-a");
    assert.equal(
      observationA.toolRenderers?.("read")?.renderCall,
      sentinelA,
      "the child's registered resolver overrides the native renderers",
    );
    assert(
      typeof observationA.toolRenderers?.("bash")?.renderCall === "function" &&
        observationA.toolRenderers?.("bash")?.renderCall !== sentinelA,
      "unmarked tools fall through to their native renderers",
    );

    current = sentinelB;
    await f.create("bridge-b");
    const observationB = f.activities.observations.get("bridge-b");
    assert.equal(
      observationB.toolRenderers?.("read")?.renderCall,
      sentinelB,
      "the second child serves its own current resolver",
    );
    assert.equal(
      observationA.toolRenderers?.("read")?.renderCall,
      sentinelA,
      "one child's renderers never leak into another observation",
    );

    assert(f.childSessionIds.length === 2, "each child binds its own approval stand-in");
    await portA.dispose();
    assert.equal(
      observationA.toolRenderers?.("read"),
      undefined,
      "disposing a child retires its bound renderers",
    );
    assert.equal(
      observationB.toolRenderers?.("read")?.renderCall,
      sentinelB,
      "the surviving child keeps its renderers",
    );

    // A fresh child under the same agent id must rebind through its own
    // session: the observation reflects the new child, not a cached lookup.
    await f.create("bridge-a");
    const rebound = f.activities.observations.get("bridge-a");
    assert.equal(rebound, observationA, "the registry keeps the retained activity");
    assert.equal(
      rebound.toolRenderers?.("read")?.renderCall,
      sentinelB,
      "the rebound observation serves the current child's resolver",
    );
  },
);

test(
  "factory dispose unbinds the lookup and keeps the child cleanup protocol",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const port = await f.create("bridge-cleanup");
    const observation = f.activities.observations.get("bridge-cleanup");
    assert(observation.toolRenderers?.("read"), "the lookup is bound while the child lives");
    const report = await port.dispose();
    assert.equal(report.shutdownExited, true, `fixture child must confirm shutdown`);
    assert.deepEqual(report.errors, []);
    assert.equal(
      observation.toolRenderers?.("read"),
      undefined,
      "dispose retires the bound lookup",
    );
    assert(
      f.events.some((event) => event.type === "subagents:child:session-created"),
      "the child session-created protocol is preserved",
    );
    assert(
      f.events.some((event) => event.type === "subagents:child:bound"),
      "the child bound protocol is preserved",
    );
    assert(
      f.events.some((event) => event.type === "subagents:child:disposed"),
      "the child disposed protocol is preserved",
    );
  },
);

test(
  "a blocked shutdown handler cannot keep the disposed child's renderers alive",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    config.blockShutdown = true;
    const port = await f.create("bridge-blocked");
    const observation = f.activities.observations.get("bridge-blocked");
    assert(observation.toolRenderers?.("read"), "the lookup is bound while the child lives");
    const report = await port.dispose();
    config.blockShutdown = false;
    assert.equal(report.shutdownExited, false, "the blocked shutdown is reported honestly");
    assert(
      report.errors.includes("CHILD_SHUTDOWN_TIMEOUT"),
      "the blocked shutdown handler is observed by the cleanup budget",
    );
    assert.equal(
      observation.toolRenderers?.("read"),
      undefined,
      "the dispose entry retires the lookup even though the activity's own " +
        "session_shutdown handler never ran behind the blocked handler",
    );
    assert.equal(
      observation.toolRenderers?.("read"),
      undefined,
      "the retired lookup serves no cached renderers after disposal",
    );
  },
);

/** Production-factory fixture over the REAL generated authority: the child
 * loads generated/authority/index.ts plus the generated static-safety-guard
 * and policy-grep exactly as the launcher assembles it, against an owned temp
 * agent dir (PI_CODING_AGENT_DIR) seeded by the production init — no real
 * user resource is read or written, and no model, network or tool execution
 * is involved. The one synthetic precondition is the parent-side permission
 * service placeholder: this fixture has no parent SDK session. The child-side
 * authority chain — service publication, static-guard probe acknowledgement,
 * expected tool-call agent binding — is entirely real. */
async function authorityFixture(t) {
  const root = await mkdtemp(join(home, "alehouse-renderer-authority-"));
  const agentDir = await mkdtemp(join(home, "alehouse-renderer-agent-"));
  const network = t.mock.method(globalThis, "fetch", () => {
    assert.fail("renderer authority fixture attempted network IO");
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initialize({ agentDir });
  const definition = readFileSync(join(agentDir, "agents", "editor.md"), "utf8");
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert(frontmatter, "the seeded editor definition carries frontmatter");
  const toolsLine = frontmatter[1].match(/tools:\s*\[(.*)\]/);
  assert(toolsLine, "the seeded editor definition declares its tools");
  // Mirrors loadAdmittedProfiles: the editor profile is not a web profile, so
  // only local tools are admitted, plus the communication tools.
  const localTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const tools = [
    ...JSON.parse(`[${toolsLine[1]}]`).filter((tool) => localTools.has(tool)),
    "alert_parent",
    "ask_parent",
  ];
  const events = [];
  const activities = new ChildActivityRegistry();
  const childSessionIds = [];
  const prompts = [];
  const createSession = createChildSessionFactory({
    ctx: {
      sessionManager: {
        getSessionDir: () => root,
        getSessionFile: () => join(root, "parent-session.jsonl"),
      },
    },
    parentBus: { emit: (type, data) => events.push({ type, data }) },
    agentDir,
    permissionRoot: join(repoRoot, "generated", "authority"),
    policyRoot: join(repoRoot, "generated", "extensions"),
    parentId: "renderer-authority-parent",
    runtime: await syntheticRuntime(),
    profiles: { editor: { definition, body: frontmatter[2], tools } },
    settings: () => sdk.SettingsManager.inMemory({}),
    parentHistory: {
      getSessionId: () => "renderer-authority-parent",
      isPersisted: () => false,
      appendCustomEntry: () => {},
    },
    approvalBindings: {
      childExtension: (sessionId) => {
        childSessionIds.push(sessionId);
        return (pi) => {
          pi.on("session_start", (_event, ctx) => {
            prompts.push(ctx.getSystemPrompt());
          });
        };
      },
      begin() {},
      end() {},
    },
    activities,
    parentPermission: () => ({ synthetic: true }),
    getPermissionsService: (id) => authority.getPermissionsService(id),
    subscribeManagedBlocks: authority.subscribeManagedBlocks,
  });
  const ports = [];
  const create = async () => {
    const port = await createSession({
      agent_id: "bridge-authority",
      name: "Renderer authority child",
      settings: {
        profile: "editor",
        cwd: root,
        definition_digest: digest(definition),
        tools: [...tools],
        provider: "renderer-bridge",
        model: "controlled",
        thinking: "off",
        parent_thinking: "off",
        thinking_resolution: "identity",
        preset: "fixture",
        preset_version: "v1",
        selection_digest: "b".repeat(64),
        difficulty: 3,
        strength: "d3",
      },
    });
    ports.push(port);
    return port;
  };
  t.after(async () => {
    try {
      for (const port of ports) await port.dispose().catch(() => {});
      assert.equal(network.mock.callCount(), 0, "fixture must not touch the network");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, agentDir, activities, events, create, childSessionIds, prompts };
}

test(
  "the real generated authority preserves native child renderers through the production factory",
  { timeout: 60000 },
  async (t) => {
    const f = await authorityFixture(t);
    const port = await f.create();
    // Assembly itself is the readiness proof: the real static-safety-guard only
    // acknowledges the probe after the real authority published the child's
    // session service and bound the expected tool-call agent, and only for
    // the real generated worker digest.
    const childSessionId = f.childSessionIds[0];
    assert(childSessionId, "the child assembly reached the approval binding");
    const service = authority.getPermissionsService(childSessionId);
    assert(
      service &&
        typeof service.getToolCallAgentName === "function" &&
        typeof service.bindExpectedToolCallAgent === "function",
      "the real generated authority registered the child's session service",
    );
    assert(!sessions.has(childSessionId), "the synthetic fixture map was not used");
    const observation = f.activities.observations.get("bridge-authority");
    assert(observation, "the production registry tracks the real-authority child");
    assertNativeChildRenderers(observation, f.root);
    assert.equal(f.prompts.length, 1, "the real-authority child published its system prompt");
    assertOwnedSkillDiscovery(f.prompts[0], [home, f.root, f.agentDir]);
    const report = await port.dispose();
    assert.equal(report.shutdownExited, true, "fixture child must confirm shutdown");
    assert.deepEqual(report.errors, []);
    assert.equal(
      observation.toolRenderers?.("read"),
      undefined,
      "dispose retires the bound lookup",
    );
  },
);
