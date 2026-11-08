// Static-allow exclusion and literal redirect targets, decided by the actual
// authority (manager, resolver, gate pipeline, runner, forwarding wire, serving
// node and approval UI models). Commands are fixture data: no shell, model or
// network runs, and every assertion is on the final decision.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(
      packageRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    ),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    "#src": join(packageRoot, "generated/authority/vendor/src"),
  },
});
const load = (name) => jiti.import(`#src/${name}`);
const [
  { PermissionManager },
  { PermissionResolver },
  { PathNormalizer },
  { posixPathFlavor },
  { PermissionSession },
  { PermissionGateHandler },
  { ToolCallGatePipeline, STATIC_ALLOW_EXCLUSION_EVIDENCE },
  { resolveToolPreviewLimits },
  { GateRunner },
  { BashProgram },
  { captureRequestedBashCommand, hardenNonGitInput },
  { resolveBashAdvisoryCheck },
  { ForwardedRequestServer, createServingPolicy },
  { ParentAuthorizer },
  { createPermissionForwardingLocation },
  { readForwardedPermissionRequest, readForwardedPermissionResponse },
  { getSubagentSessionRegistry },
  { LocalUserAuthorizer },
  { requestPermissionDecisionFromUi },
  { reducePrompt, initialPromptState, visibleOptionKeys },
  { STATIC_ALLOW_REQUEST_LIMIT, STATIC_ALLOW_EXCLUSION_TEXT_LIMIT, describeStaticAllowExclusion },
] = await Promise.all([
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("path/path-normalizer"),
  load("path/path-flavor"),
  load("session/permission-session"),
  load("handlers/permission-gate-handler"),
  load("handlers/gates/tool-call-gate-pipeline"),
  load("tool-input/tool-preview-formatter"),
  load("handlers/gates/runner"),
  load("access-intent/bash/program"),
  load("access-intent/bash/managed-read-policy"),
  load("service/bash-advisory-check"),
  load("authority/forwarded-request-server"),
  load("authority/approval-escalator"),
  load("authority/permission-forwarding"),
  load("authority/forwarding-io"),
  load("authority/subagent-registry"),
  load("authority/local-user-authorizer"),
  load("authority/permission-dialog"),
  load("authority/permission-prompt-decision"),
  load("access-intent/bash/static-allow-exclusion"),
]);

const root = mkdtempSync(join(tmpdir(), "alehouse-static-allow-"));
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "agents"), { recursive: true });
for (const name of ["editor", "researcher"])
  cpSync(join(packageRoot, "generated/agents", `${name}.md`), join(agentDir, `agents/${name}.md`));
process.env.PI_CODING_AGENT_DIR = agentDir;
const shipped = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
// The allowance shapes of a real user configuration (resources ship none).
const ALLOWS = {
  "cat *": "allow",
  "wc *": "allow",
  "echo *": "allow",
  "printf *": "allow",
  "sha256sum *": "allow",
  "rg --no-config *": "allow",
  "python3 --version": "allow",
  "git log *": "allow",
  "printenv *": "allow",
};
const withBash = (bash, permission = {}) => ({
  ...shipped,
  permission: {
    ...shipped.permission,
    ...permission,
    bash: { ...shipped.permission.bash, ...bash },
  },
});
const workspace = () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  for (const name of ["README", "ordinary.txt", "foo", "l", "notes.txt"])
    writeFileSync(join(cwd, name), "fixture\n");
  return cwd;
};
const sessionAllow = (pattern) => ({
  surface: "bash",
  pattern,
  action: "allow",
  layer: "session",
  origin: "session",
});
const approvedForSession = {
  approved: true,
  state: "approved_for_session",
  decidedBy: { kind: "user", via: "dialog" },
};
const unavailable = {
  approved: false,
  state: "denied",
  confirmationUnavailable: true,
  decidedBy: { kind: "unavailable", reason: "No live authority was reachable for this session" },
};

let serial = 0;
function managerFor({ config = withBash(ALLOWS), yolo = false, managerOptions = {} } = {}) {
  const configFile = join(root, `config-${serial++}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  return new PermissionManager({
    globalConfigPath: configFile,
    agentsDir: join(agentDir, "agents"),
    mcpServerNames: [],
    ...managerOptions,
    ...(yolo ? { isYoloEnabled: () => true } : {}),
  });
}

// One gate stack: the actual handler, pipeline, runner and resolver.
function gate(cwd, options = {}) {
  // An explicit `agent: undefined` is the parent session, not the default.
  const agent = "agent" in options ? options.agent : "editor";
  const { yolo = false, sessionRules = [], sessionId = "static-allow" } = options;
  const manager = managerFor(options);
  const resolver = new PermissionResolver(manager, { getRuleset: () => sessionRules });
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const prompts = [],
    approvals = [];
  const escalate =
    options.escalate ??
    (async (details) => {
      prompts.push(details);
      return options.decision ?? unavailable;
    });
  const runner = new GateRunner(
    resolver,
    { recordSessionApproval: (approval) => approvals.push(approval.toForwardedData()) },
    { escalate },
    { writeReviewLog() {}, emitDecision() {} },
    () => yolo,
  );
  const tools = ["read", "bash", "grep", "find", "ls", "edit", "write"].map((name) => ({
    name,
    sourceInfo: { source: "builtin", path: `builtin:${name}` },
  }));
  const session = new PermissionSession(
    {},
    { start() {}, stop() {} },
    manager,
    {},
    {},
    { activate() {}, deactivate() {} },
    posixPathFlavor,
  );
  const handler = new PermissionGateHandler(
    session,
    { getAll: () => tools, getActive: () => tools.map((tool) => tool.name), setActive() {} },
    new ToolCallGatePipeline(resolver, {
      getActiveSkillEntries: () => [],
      getInfrastructureReadDirs: () => [],
      getToolPreviewLimits: () => resolveToolPreviewLimits(),
      getPathNormalizer: () => normalizer,
      getShellToolAliases: () => undefined,
    }),
    {},
    runner,
  );
  const entries = agent
    ? [{ type: "custom", customType: "active_agent", data: { name: agent } }]
    : [];
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => sessionId,
    },
  };
  return {
    resolver,
    prompts,
    approvals,
    ctx,
    async call(command, prepare) {
      const input = { command };
      if (prepare) await prepare(input);
      const before = prompts.length;
      const outcome = await handler.handleToolCall(
        { toolCallId: randomUUID(), toolName: "bash", input },
        ctx,
      );
      const asked = prompts.slice(before);
      return { outcome, input, asked, allowed: outcome.action === "allow" };
    },
  };
}
const exclusionOf = (prompt) =>
  prompt.payload.evidence.find((entry) => entry.label === STATIC_ALLOW_EXCLUSION_EVIDENCE);

// ── Local gate ────────────────────────────────────────────────────────────

const EXCLUDED = [
  ['cat "$X"', "dynamic-operand"],
  ["wc -l *.env", "dynamic-operand"],
  ['for f in a b; do cat "$f"; done', "dynamic-operand"],
  ["git diff --stat && wc -l src/*.ts", "dynamic-operand"],
  ["sha256sum -c l", "output-utility"],
  ["wc --files0-from=l", "indirect-file-list"],
  ["rg --no-config foo .", "ripgrep"],
  ["printf -v PATH x", "output-utility"],
  ["LD_PRELOAD=./x.so python3 --version", "inline-environment"],
  ["FOO=1 cat README", "inline-environment"],
  ["cat <<EOF\n$(id)\nEOF", "expanding-heredoc"],
  ["echo hi > $OUT", "dynamic-operand"],
];

for (const agent of [undefined, "editor"])
  test(`excluded shapes ask once, carry the trigger and offer no session grant: ${agent ?? "parent"}`, async () => {
    const cwd = workspace();
    for (const [command, rule] of EXCLUDED) {
      const g = gate(cwd, { agent, decision: approvedForSession });
      const result = await g.call(command);
      assert.equal(result.asked.length, 1, `normal approval is requested: ${command}`);
      const [prompt] = result.asked;
      assert.equal(prompt.accessIntent?.staticAllowExclusion?.rule, rule, command);
      assert.ok(exclusionOf(prompt), `prompt evidence names the trigger: ${command}`);
      assert.equal(prompt.sessionGrantUnavailable, true, command);
      assert.equal(prompt.sessionApproval, undefined, command);
      assert.equal(prompt.sessionLabel, undefined, command);
      assert.equal(result.allowed, true, "a one-time approval satisfies this call");
      assert.deepEqual(g.approvals, [], `no session grant is recorded: ${command}`);
      const again = await g.call(command);
      assert.equal(again.asked.length, 1, `the next identical call asks again: ${command}`);
    }
  });

test("yolo answers an excluded ask exactly like any ordinary ask", async () => {
  const cwd = workspace();
  for (const [command] of EXCLUDED) {
    const result = await gate(cwd, { yolo: true }).call(command);
    assert.equal(result.allowed, true, command);
    assert.equal(result.asked.length, 0, command);
  }
});

test("shapes the guard never refused keep their decisions", async () => {
  const cwd = workspace();
  for (const command of [
    'echo "$status"',
    'echo "a*b"',
    "printf -- '-%s' ok",
    "printf 'exit=%s\\n' \"$?\"",
    "git log --oneline HEAD~5..HEAD",
    "echo ok 2>&1",
    "cat foo 2>/dev/null",
    "cat README",
    "wc -l README notes.txt",
  ]) {
    const result = await gate(cwd).call(command);
    assert.equal(result.allowed, true, command);
    assert.equal(result.asked.length, 0, command);
  }
  // The managed lane is not a bash allow rule: `$` inside its literal sed
  // clause neither excludes it nor lets an explicit `sed *` allow be needed.
  for (const config of [withBash(ALLOWS), withBash({ ...ALLOWS, "sed *": "allow" })]) {
    const result = await gate(cwd, { config }).call("sed -n '1,$p' README");
    assert.equal(result.allowed, true);
    assert.equal(result.asked.length, 0);
  }
});

test("session grants and project/agent-scope allows are excluded too", async () => {
  const cwd = workspace();
  const shippedBash = withBash({});
  const session = gate(cwd, { config: shippedBash, sessionRules: [sessionAllow("cat *")] });
  assert.equal((await session.call("cat README")).allowed, true, "session grant still applies");
  const sessionExcluded = await session.call('cat "$X"');
  assert.equal(sessionExcluded.asked.length, 1, "no session fast path for an excluded call");
  assert.equal(sessionExcluded.allowed, false);

  const projectDir = mkdtempSync(join(root, "project-"));
  const projectGlobalConfigPath = join(projectDir, "project.json");
  writeFileSync(
    projectGlobalConfigPath,
    JSON.stringify({ permission: { bash: { "cat *": "allow" } } }),
  );
  const projectAgentsDir = join(projectDir, "agents");
  mkdirSync(projectAgentsDir);
  writeFileSync(
    join(projectAgentsDir, "editor.md"),
    ["---", "permission:", "  bash:", '    "cat *": allow', "---", ""].join("\n"),
  );
  for (const managerOptions of [{ projectGlobalConfigPath }, { projectAgentsDir }]) {
    const g = gate(cwd, { config: shippedBash, managerOptions });
    assert.equal((await g.call("cat README")).allowed, true, "scoped allow still applies");
    const excluded = await g.call('cat "$X"');
    assert.equal(excluded.asked.length, 1, "scoped allows are excluded as well");
    assert.equal(excluded.allowed, false);
  }
});

test("deny rules and the invalid-config floor keep holding", async () => {
  const cwd = workspace();
  const denied = await gate(cwd, {
    config: withBash({ ...ALLOWS, "wc *": "deny" }),
    yolo: true,
  }).call("wc -l *.env");
  assert.equal(denied.allowed, false);
  assert.equal(denied.asked.length, 0, "a deny never becomes an approvable ask");
  // The guard no longer refuses an expanding heredoc; its substitution's units
  // are still resolved, and an excluded program drops session allows too.
  for (const options of [{}, { yolo: true }, { sessionRules: [sessionAllow("sudo *")] }]) {
    const heredoc = await gate(cwd, options).call("wc -l <<EOF\n$(sudo true)\nEOF");
    assert.equal(heredoc.allowed, false, JSON.stringify(options));
    assert.equal(heredoc.asked.length, 0, "the sudo deny is final");
  }

  const projectGlobalConfigPath = join(root, `invalid-${serial++}.json`);
  writeFileSync(projectGlobalConfigPath, "{invalid");
  const floor = await gate(cwd, { yolo: true, managerOptions: { projectGlobalConfigPath } }).call(
    'cat "$X"',
  );
  assert.equal(floor.asked.length, 1, "yolo never satisfies the fail-closed floor");
  assert.equal(floor.allowed, false);
});

test("the decision uses the requested text captured before hardening", async () => {
  const cwd = workspace();
  // Opt out of the managed read lane, which is not a bash allow rule and would
  // otherwise answer the hardened printenv spelling on its own.
  const g = gate(cwd, { config: withBash(ALLOWS, { managed_static_read: "ask" }) });
  const hardened = await g.call("printenv PI_MODEL", async (input) => {
    captureRequestedBashCommand(input);
    await hardenNonGitInput(input, cwd);
  });
  assert.equal(hardened.input.command, "printenv -- PI_MODEL", "fixture is really hardened");
  assert.equal(hardened.allowed, true, "managed hardening alone is not an unverified original");
  assert.equal(hardened.asked.length, 0);
  const uncaptured = await g.call("printenv PI_MODEL", (input) => hardenNonGitInput(input, cwd));
  assert.equal(uncaptured.input.command, "printenv -- PI_MODEL");
  assert.equal(uncaptured.asked.length, 1, "a hardened input without its capture fails closed");
  assert.equal(uncaptured.asked[0].accessIntent.staticAllowExclusion.rule, "unverified-original");

  const drifted = await g.call("cat README", async (input) => {
    captureRequestedBashCommand(input);
    input.command = "cat README notes.txt";
  });
  assert.equal(drifted.asked.length, 1, "an unbound execution text fails closed to approval");
  assert.equal(drifted.asked[0].accessIntent.staticAllowExclusion.rule, "unverified-original");

  const forged = await g.call('cat "$X"', async (input) => {
    input.requested = "cat README";
    input.original = "cat README";
    input.staticAllowExclusion = null;
  });
  assert.equal(forged.asked.length, 1, "model-suppliable fields carry no provenance");
});

test("advisory bash queries answer at gate parity", async () => {
  const cwd = workspace();
  const { resolver } = gate(cwd);
  assert.equal(resolveBashAdvisoryCheck('cat "$X"', "editor", resolver).state, "ask");
  assert.equal(resolveBashAdvisoryCheck("cat README", "editor", resolver).state, "allow");
});

// ── Literal redirect targets ──────────────────────────────────────────────

const candidates = async (cwd, command) =>
  (await BashProgram.parse(command, new PathNormalizer(posixPathFlavor, cwd)))
    .pathRuleCandidates()
    .map((candidate) => [candidate.token, candidate.effect.effect]);

for (const agent of [undefined, "editor"])
  test(`literal redirect targets reach path policy by syntax: ${agent ?? "parent"}`, async () => {
    const cwd = workspace();
    const outside = mkdtempSync(join(root, "outside-"));
    const config = withBash({ ...ALLOWS, "cd *": "allow" }, { external_directory: { "*": "ask" } });
    const run = (command) => gate(cwd, { agent, config }).call(command);
    for (const command of [
      "echo hi > new.env",
      "echo hi >> new.env",
      "echo hi >| new.env",
      "echo hi &>new.env",
      "echo hi &>>new.env",
      "echo hi > -d/new.env",
      "echo hi > NAME=d/new.env",
      "echo hi >&new.env",
      "cat <> new.env",
    ]) {
      const result = await run(command);
      assert.equal(result.allowed, false, `path deny applies to a new target: ${command}`);
      assert.equal(result.asked.length, 0, `a path deny is final: ${command}`);
    }
    for (const command of ["echo hi > body.diff", "echo hi > .x=new.txt", "echo hi > ./new.txt"]) {
      const result = await run(command);
      assert.equal(result.allowed, true, command);
      assert.equal(result.asked.length, 0, command);
    }
    for (const command of [
      `cd ${outside} && echo hi > ./newfile`,
      'cd "$WS" && echo hi > out.txt',
    ]) {
      const result = await run(command);
      assert.equal(result.asked.length, 1, `external write is checked: ${command}`);
      assert.match(result.asked[0].payload.request.surface, /^external_directory/);
    }
    assert.deepEqual(await candidates(cwd, "cat <> new.env"), [["new.env", "unproven"]]);
    assert.deepEqual(await candidates(cwd, "echo hi > -d/new.env"), [["-d/new.env", "write"]]);
    for (const command of [
      "echo ok 2>&1",
      "echo ok >&2",
      "echo ok >&-",
      "cat <&0",
      "cat <<< new.env",
      "cat <<'EOF'\nnew.env\nEOF",
      "echo hi > *.env",
    ])
      assert.deepEqual(await candidates(cwd, command), [], command);
  });

// ── Approval UI ───────────────────────────────────────────────────────────

test("one-time asks offer no session option in either dialog", async () => {
  const captured = [];
  const authorizer = new LocalUserAuthorizer({
    ui: {},
    mode: "tui",
    events: { emit() {} },
    getPromptPreferences: () => ({}),
    requestPermissionDecision: async (_view, _title, _payload, options) => {
      captured.push(options);
      return { approved: true, state: "approved", decidedBy: { kind: "user", via: "dialog" } };
    },
  });
  const payload = {
    kind: "tool",
    request: { surface: "bash", value: "cat $X", toolName: "bash" },
    evidence: [],
    annotations: [],
  };
  for (const forwarding of [undefined, { requesterAgentName: "editor", requesterSessionId: "c" }])
    await authorizer.authorize({
      requestId: "r",
      source: "tool_call",
      agentName: "editor",
      payload,
      sessionLabel: "Yes, for this session (cat *)",
      sessionApproval: { grants: [{ surface: "bash", pattern: "cat *" }] },
      sessionGrantUnavailable: true,
      ...(forwarding ? { forwarding } : {}),
    });
  assert.deepEqual(captured, [
    { sessionGrantUnavailable: true },
    { sessionGrantUnavailable: true },
  ]);

  let offered;
  const select = async (_title, options) => {
    offered = options;
    return "Yes, for this session";
  };
  const decision = await requestPermissionDecisionFromUi(
    { select, input: async () => undefined },
    "Permission Required",
    "cat $X",
    { sessionGrantUnavailable: true },
  );
  assert.equal(
    offered.some((option) => /session/i.test(option)),
    false,
  );
  assert.equal(decision.approved, false, "a session label cannot be chosen when not offered");

  const config = {
    doublePressToConfirm: false,
    sessionLabel: "Yes, for this session",
    widthLabel: "Yes, both directions",
    sessionGrantUnavailable: true,
  };
  assert.deepEqual(visibleOptionKeys(config), ["y", "n", "r"]);
  const state = initialPromptState(config);
  for (const key of ["s", "b"])
    assert.equal(reducePrompt(config, state, { type: "hotkey", key }).kind, "render", key);
  const navigated = reducePrompt(config, state, { type: "nav", direction: "down" });
  assert.equal(navigated.state.highlightedKey, "n");
  const control = { ...config, sessionGrantUnavailable: undefined };
  assert.equal(
    reducePrompt(control, state, { type: "hotkey", key: "s" }).decision?.state,
    "approved_for_session",
    "the session key works for ordinary asks",
  );
});

// ── Forwarding: child gate → wire → serving parent ────────────────────────

const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");

function forwardingFixture(t, parentOptions = {}, childOptions = {}) {
  // These cases test each node's configured Bash rules, not frontmatter
  // precedence: state those rules in editor's actual agent layer as well.
  const editorOptions = (options) => ({
    ...options,
    managerOptions: {
      projectAgentsDir: editorAgents((options.config ?? withBash(ALLOWS)).permission.bash),
      ...options.managerOptions,
    },
  });
  const forwardingDir = mkdtempSync(join(root, "forwarding-"));
  const parent = randomUUID(),
    child = randomUUID();
  const registry = getSubagentSessionRegistry();
  registry.register(child, { parentSessionId: parent });
  t.after(() => registry.unregister(child));
  const previous = globalThis[servicesKey];
  const services = previous instanceof Map ? previous : new Map();
  globalThis[servicesKey] = services;
  services.set(child, { getToolCallAgentName: () => "editor" });
  t.after(() => {
    services.delete(child);
    if (!(previous instanceof Map)) delete globalThis[servicesKey];
  });

  const cwd = workspace();
  const childGate = gate(cwd, {
    ...editorOptions(childOptions),
    sessionId: child,
    escalate: (details) => edge.authorize(details),
  });
  const edge = new ParentAuthorizer(childGate.ctx, {
    forwardingDir,
    registry,
    serving: {
      isServing: () => true,
      describe: () => ({ channel: "registry", state: "serving", servingIds: [parent] }),
    },
    getTimeoutMs: () => 15_000,
    logger: { review() {}, debug() {} },
  });

  const parentManager = managerFor(editorOptions(parentOptions));
  const parentResolver = new PermissionResolver(parentManager, {
    getRuleset: () => parentOptions.sessionRules ?? [],
  });
  const served = [],
    recorded = [],
    resolved = [],
    wire = [];
  const policy = createServingPolicy(parentResolver);
  const server = new ForwardedRequestServer({
    forwardingDir,
    registry,
    logger: { review() {}, debug() {} },
    policy: {
      resolve(intent) {
        resolved.push(intent);
        return policy.resolve(intent);
      },
    },
    escalator: {
      async escalate(details) {
        served.push(details);
        return (
          parentOptions.decision ?? {
            approved: true,
            state: "approved",
            decidedBy: { kind: "user", via: "dialog" },
          }
        );
      },
    },
    broadcaster: { emitDecision() {} },
    recorder: { recordSessionApproval: (approval) => recorded.push(approval) },
  });
  const location = createPermissionForwardingLocation(forwardingDir, parent);
  const parentCtx = {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => parent,
      getSessionDir: () => location.sessionRootDir,
      getEntries: () => [],
    },
  };
  // Serve until the child's gate settles, recording each request as written
  // (serialization) and as the production reader parses it (read).
  async function call(command) {
    let settled = false;
    const pending = childGate.call(command).finally(() => {
      settled = true;
    });
    const seen = new Set();
    while (!settled) {
      const files = existsSync(location.requestsDir)
        ? readdirSync(location.requestsDir).filter((name) => name.endsWith(".json"))
        : [];
      for (const name of files) {
        if (seen.has(name)) continue;
        seen.add(name);
        const path = join(location.requestsDir, name);
        wire.push({
          raw: JSON.parse(readFileSync(path, "utf8")),
          parsed: readForwardedPermissionRequest(null, path),
        });
      }
      if (files.length) await server.processInbox(parentCtx);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return pending;
  }
  return {
    call,
    childGate,
    served,
    recorded,
    resolved,
    wire,
    server,
    location,
    parentCtx,
    parent,
    child,
    cwd,
  };
}

test("forwarded exclusion survives the wire and reaches parent approval", async (t) => {
  const f = forwardingFixture(t, {
    config: withBash({ "wc *": "allow" }),
    decision: {
      approved: true,
      state: "approved_for_serving_session",
      decidedBy: { kind: "user", via: "dialog" },
    },
  });
  const result = await f.call("wc -l *.env");
  assert.equal(result.allowed, true, "the parent's one-time approval answers the call");
  assert.equal(f.wire.length, 1);
  const [{ raw, parsed }] = f.wire;
  assert.equal(raw.accessIntent.staticAllowExclusion.rule, "dynamic-operand", "serialized");
  assert.equal(raw.sessionApproval, undefined, "the child suggests no grant");
  assert.deepEqual(
    parsed.accessIntent.staticAllowExclusion,
    raw.accessIntent.staticAllowExclusion,
    "read",
  );
  assert.equal(parsed.invalidStaticAllowExclusion, undefined);
  assert.equal(f.served.length, 1, "a parent allow rule does not auto-approve");
  assert.deepEqual(
    f.served[0].accessIntent.staticAllowExclusion,
    raw.accessIntent.staticAllowExclusion,
    "projected",
  );
  assert.equal(f.served[0].sessionGrantUnavailable, true);
  assert.equal(f.served[0].sessionApproval, undefined);
  const triggers = f.served[0].payload.evidence.filter(
    (entry) => entry.label === STATIC_ALLOW_EXCLUSION_EVIDENCE,
  );
  assert.equal(triggers.length, 1, "the child's trigger is not duplicated by the parent");
  assert.deepEqual(triggers[0], exclusionOf({ payload: raw.payload }));
  assert.deepEqual(f.recorded, [], "the parent records no serving-session grant");
  assert.deepEqual(f.childGate.approvals, [], "the child records no grant");
  const again = await f.call("wc -l *.env");
  assert.equal(again.allowed, true);
  assert.equal(f.served.length, 2, "the next identical call is approved again, not remembered");
});

test("control: without the exclusion the same parent allow auto-approves", async (t) => {
  const f = forwardingFixture(
    t,
    { config: withBash({ "wc *": "allow" }) },
    { config: withBash({}) },
  );
  const result = await f.call("wc -l README");
  assert.equal(result.allowed, true);
  assert.equal(f.wire.length, 1, "the child's ordinary ask was forwarded");
  assert.equal(f.wire[0].raw.accessIntent.staticAllowExclusion, undefined);
  assert.equal(f.wire[0].raw.accessIntent.requestedCommand, "wc -l README");
  assert.equal(f.wire[0].parsed.accessIntent.requestedCommand, "wc -l README");
  assert.ok(f.wire[0].raw.sessionApproval, "an ordinary ask still suggests a session grant");
  assert.equal(f.served.length, 0, "the parent's allow decided without approval");
});

test("control: an ordinary current Bash ask still uses an existing parent session grant", async (t) => {
  const f = forwardingFixture(
    t,
    { config: withBash({}), sessionRules: [sessionAllow("wc *")] },
    { config: withBash({}) },
  );
  const result = await f.call("wc -l README");
  assert.equal(result.allowed, true);
  assert.equal(f.wire.length, 1, "the actual child edge forwards the ordinary ask");
  assert.equal(f.wire[0].parsed.invalidStaticAllowExclusion, undefined);
  assert.equal(f.wire[0].parsed.accessIntent.requestedCommand, "wc -l README");
  assert.equal(f.resolved.length, 1, "the actual serving policy resolves it");
  assert.equal(f.served.length, 0, "the existing session grant auto-approves");
  assert.deepEqual(f.recorded, [], "no new grant is needed");
});

test("Bash path and external-directory asks retain their own fixed intent surfaces", async (t) => {
  const outside = workspace();
  for (const kind of ["path", "external_directory"]) {
    const permission = { [kind === "path" ? "path_read" : kind]: { "*": "ask" } };
    const parentPermission = { [kind === "path" ? "path_read" : kind]: { "*": "allow" } };
    const f = forwardingFixture(
      t,
      { config: withBash({ "cat *": "allow" }, parentPermission) },
      { config: withBash({ "cat *": "allow" }, permission) },
    );
    const command = kind === "path" ? "cat README" : `cat ${join(outside, "ordinary.txt")}`;
    const result = await f.call(command);
    assert.equal(result.allowed, true, kind);
    assert.equal(f.wire.length, 1, `exactly the independent ${kind} gate forwards`);
    const { raw, parsed } = f.wire[0];
    assert.equal(raw.payload.request.toolName, "bash", "this really is a Bash tool request");
    assert.match(parsed.accessIntent.surface, new RegExp(`^${kind}(?:_|$)`));
    assert.equal(raw.payload.request.surface, parsed.accessIntent.surface);
    assert.equal(parsed.accessIntent.requestedCommand, undefined, "not a Bash command gate");
    assert.equal(parsed.accessIntent.staticAllowExclusion, undefined);
    assert.equal(parsed.invalidStaticAllowExclusion, undefined, "valid current intent accepted");
    assert.equal(f.resolved.length, 1, "the actual serving policy resolves the path facts");
    assert.equal(f.served.length, 0, "the parent's existing path/boundary allow decides");
  }
});

test("parent session grants, denies, yolo and the floor apply after the exclusion", async (t) => {
  const grant = forwardingFixture(t, {
    config: withBash({}),
    sessionRules: [sessionAllow("wc *")],
  });
  await grant.call("wc -l *.env");
  assert.equal(grant.served.length, 1, "a parent session grant does not auto-approve");

  const denied = forwardingFixture(t, { config: withBash({ "wc *": "deny" }), yolo: true });
  const deniedResult = await denied.call("wc -l *.env");
  assert.equal(deniedResult.allowed, false);
  assert.equal(denied.served.length, 0, "a parent deny stays automatic");

  for (const config of [withBash({ "wc *": "allow" }), withBash({})]) {
    const yolo = forwardingFixture(t, { config, yolo: true });
    const result = await yolo.call("wc -l *.env");
    assert.equal(result.allowed, true, "parent yolo answers the downgraded ask");
    assert.equal(yolo.served.length, 0);
  }

  const projectGlobalConfigPath = join(root, `invalid-${serial++}.json`);
  writeFileSync(projectGlobalConfigPath, "{invalid");
  const floor = forwardingFixture(t, {
    config: withBash({ "wc *": "allow" }),
    yolo: true,
    managerOptions: { projectGlobalConfigPath },
  });
  await floor.call("wc -l *.env");
  assert.equal(floor.served.length, 1, "parent yolo never satisfies the fail-closed floor");
});

test("malformed forwarded access facts deny before policy, escalation or stale grants", async (t) => {
  for (const yolo of [false, true]) {
    const f = forwardingFixture(
      t,
      {
        config: withBash({ "wc *": "allow" }),
        yolo,
        decision: {
          approved: true,
          state: "approved_for_serving_session",
          decidedBy: { kind: "user", via: "dialog" },
        },
      },
      { config: withBash({}) },
    );
    const control = await f.call("wc -l README");
    assert.equal(control.allowed, true, "a complete current ask still auto-approves");
    assert.equal(f.wire.length, 1, "positive control used the actual forwarding edge and writer");
    assert.equal(f.resolved.length, 1, "positive control reached the actual serving policy");
    assert.equal(f.served.length, 0, "recorded authority answered the positive control");
    const base = f.wire[0].raw;
    assert.ok(base.sessionApproval?.grants.length, "fixture carries a real stale grant suggestion");
    const facts = base.accessIntent;
    const { requestedCommand: _requestedCommand, ...withoutCommand } = facts;
    const variants = [
      ["omitted intent", undefined],
      ["null intent", null],
      ["numeric intent", 7],
      ["string intent", "bash"],
      ["array intent", []],
      ["empty intent", {}],
      ...[undefined, null, 7, [], "", " bash", "bash "].map((surface) => [
        `invalid surface: ${JSON.stringify(surface)}`,
        { ...facts, surface },
      ]),
      ["surface disagrees with fixed Bash payload", { ...withoutCommand, surface: "path_read" }],
      ["neither Bash forwarding fact", withoutCommand],
      ["numeric requested command", { ...facts, requestedCommand: 7 }],
      [
        "over-limit requested command",
        { ...facts, requestedCommand: "x".repeat(STATIC_ALLOW_REQUEST_LIMIT + 1) },
      ],
      ["invalid match values", { ...facts, matchValues: [7] }],
      ["missing principal", { ...facts, principal: undefined }],
      [
        "invalid exclusion rule",
        { ...facts, staticAllowExclusion: { rule: "bogus", unitText: "", word: "" } },
      ],
      [
        "invalid exclusion segment",
        { ...facts, staticAllowExclusion: { rule: "dynamic-operand", unitText: 1, word: "" } },
      ],
      [
        "extra exclusion field",
        {
          ...facts,
          staticAllowExclusion: { rule: "dynamic-operand", unitText: "", word: "", x: 1 },
        },
      ],
      ["null exclusion", { ...facts, staticAllowExclusion: null }],
      ["Bash fields on path surface", { ...facts, surface: "path_read" }],
    ];
    for (const [name, accessIntent] of variants) {
      const id = randomUUID();
      const request = { ...base, id, accessIntent };
      const label = `${name}${yolo ? " + yolo" : ""}`;
      mkdirSync(f.location.requestsDir, { recursive: true });
      const requestPath = join(f.location.requestsDir, `${id}.json`);
      writeFileSync(requestPath, JSON.stringify(request));
      const parsed = readForwardedPermissionRequest(null, requestPath);
      assert.ok(parsed, `malformed access facts get an explicit response: ${label}`);
      assert.equal(parsed.invalidStaticAllowExclusion, true, label);
      assert.deepEqual(parsed.sessionApproval, base.sessionApproval, "stale suggestion is present");
      await f.server.processInbox(f.parentCtx);
      const response = readForwardedPermissionResponse(
        null,
        join(f.location.responsesDir, `${id}.json`),
      );
      assert.ok(response, `server wrote a readable denial: ${label}`);
      assert.equal(response.approved, false, label);
      assert.equal(response.decidedBy?.kind, "gate_error", label);
      assert.match(response.decidedBy.reason, /facts are missing or malformed/, label);
      assert.equal(f.resolved.length, 1, `refused before serving policy: ${label}`);
      assert.equal(f.served.length, 0, `refused before escalation: ${label}`);
      assert.deepEqual(f.recorded, [], `no stale serving-session grant recorded: ${label}`);
      assert.deepEqual(f.childGate.approvals, [], `no child grant recorded: ${label}`);
    }
  }
});

test("a well-formed requested command alone is served on the parent's own terms", async (t) => {
  const f = forwardingFixture(t, { config: withBash({ "wc *": "allow" }) });
  const id = randomUUID();
  mkdirSync(f.location.requestsDir, { recursive: true });
  const requestPath = join(f.location.requestsDir, `${id}.json`);
  writeFileSync(
    requestPath,
    JSON.stringify({
      id,
      createdAt: Date.now(),
      targetSessionId: f.parent,
      requesterSessionId: f.child,
      requesterAgentName: "editor",
      surface: "bash",
      value: "wc -l README",
      accessIntent: {
        surface: "bash",
        matchValues: ["wc -l README"],
        boundaryValue: null,
        requesterCwd: f.cwd,
        principal: { sessionId: f.child, agentName: "editor" },
        requestedCommand: "wc -l README",
      },
    }),
  );
  await f.server.processInbox(f.parentCtx);
  const response = readForwardedPermissionResponse(
    null,
    join(f.location.responsesDir, `${id}.json`),
  );
  assert.equal(response?.approved, true, "the parent allow decides");
  assert.equal(f.served.length, 0);
});

// ── Review regressions ────────────────────────────────────────────────────

// Agent frontmatter outranks global rules (the shipped editor carries
// `bash: "*": ask`), so an editor case states its rules in the agent layer.
function editorAgents(bash) {
  const dir = mkdtempSync(join(root, "agents-"));
  const lines = Object.entries(bash).map(([key, value]) => `    ${JSON.stringify(key)}: ${value}`);
  writeFileSync(
    join(dir, "editor.md"),
    ["---", "permission:", "  bash:", ...lines, "---", ""].join("\n"),
  );
  return dir;
}

test("an excluded program keeps every restriction the full policy finds", async () => {
  const cwd = workspace();
  const projectDir = mkdtempSync(join(root, "project-"));
  const projectGlobalConfigPath = join(projectDir, "project.json");
  writeFileSync(
    projectGlobalConfigPath,
    JSON.stringify({ permission: { bash: { "cat *": "deny" } } }),
  );
  const open = { permission: { "*": "allow", bash: { "*": "allow" } } };
  const setups = [
    { name: "global", config: { permission: { "*": "allow", bash: { "cat *": "deny" } } } },
    { name: "project", config: open, managerOptions: { projectGlobalConfigPath } },
    {
      name: "agent",
      agent: "editor",
      config: open,
      managerOptions: { projectAgentsDir: editorAgents({ "*": "allow", "cat *": "deny" }) },
    },
  ];
  for (const { name, agent, ...setup } of setups)
    for (const yolo of [false, true]) {
      const label = `${name}${yolo ? " + yolo" : ""}`;
      const g = gate(cwd, { ...setup, agent, yolo });
      for (const command of [
        "cat README",
        "env cat README",
        "FOO=1 env cat README",
        "FOO=1 cat README",
        'env cat "$X"',
        "timeout 5 env FOO=1 cat README",
      ]) {
        const result = await g.call(command);
        assert.equal(result.allowed, false, `${label}: ${command}`);
        assert.equal(result.asked.length, 0, `the wrapped deny is final: ${label}: ${command}`);
      }
    }
});

test("a deny default with an allowlist resolves an excluded program to deny", async () => {
  const cwd = workspace();
  const bash = { "*": "deny", "cat *": "allow" };
  const setups = [
    { config: { permission: { "*": "allow", bash } } },
    {
      agent: "editor",
      config: { permission: { "*": "allow" } },
      managerOptions: { projectAgentsDir: editorAgents(bash) },
    },
  ];
  for (const setup of setups)
    for (const yolo of [false, true]) {
      const g = gate(cwd, { ...setup, agent: setup.agent, yolo });
      assert.equal((await g.call("cat README")).allowed, true, "the allowlist applies");
      for (const command of ['cat "$X"', "FOO=1 cat README"]) {
        const result = await g.call(command);
        const label = `${setup.agent ?? "parent"}${yolo ? " + yolo" : ""}: ${command}`;
        assert.equal(result.allowed, false, label);
        assert.equal(result.asked.length, 0, `the remaining policy is deny, not ask: ${label}`);
      }
    }
});

test("a parent re-evaluates the requested command against its own allows", async (t) => {
  const cases = [
    {
      grant: "python3 --version",
      command: "LD_PRELOAD=./fixture.so python3 --version",
      rule: "inline-environment",
    },
    { grant: "echo *", command: "echo hi > $OUT", rule: "dynamic-operand" },
    {
      grant: "python3 --version",
      command: `LD_PRELOAD=./${"x".repeat(STATIC_ALLOW_EXCLUSION_TEXT_LIMIT + 64)} python3 --version`,
      rule: "inline-environment",
    },
    // A dynamic reader operand is excluded by the child already: both agree.
    { grant: "cat *", command: 'cat "$X"', rule: "dynamic-operand", child: true },
  ];
  for (const { grant, command, rule, child } of cases)
    for (const where of ["session", "config"]) {
      const parentOptions =
        where === "session"
          ? { config: withBash({}), sessionRules: [sessionAllow(grant)] }
          : { config: withBash({ [grant]: "allow" }) };
      const f = forwardingFixture(
        t,
        {
          ...parentOptions,
          decision: {
            approved: true,
            state: "approved_for_serving_session",
            decidedBy: { kind: "user", via: "dialog" },
          },
        },
        { config: withBash({}) },
      );
      const result = await f.call(command);
      const label = `${where}: ${command}`;
      assert.equal(f.wire.length, 1, label);
      assert.equal(
        f.wire[0].raw.accessIntent.staticAllowExclusion?.rule,
        child ? rule : undefined,
        `only the parent's allow makes this an exclusion: ${label}`,
      );
      assert.equal(f.wire[0].raw.accessIntent.requestedCommand, command, label);
      assert.equal(f.served.length, 1, `a parent-only allow does not auto-approve: ${label}`);
      assert.equal(f.served[0].accessIntent.staticAllowExclusion?.rule, rule, label);
      assert.equal(f.served[0].accessIntent.requestedCommand, undefined, "not projected");
      const triggers = f.served[0].payload.evidence.filter(
        (entry) => entry.label === STATIC_ALLOW_EXCLUSION_EVIDENCE,
      );
      assert.equal(triggers.length, 1, `exactly one parent prompt trigger: ${label}`);
      const fact = f.served[0].accessIntent.staticAllowExclusion;
      assert.equal(triggers[0].text, describeStaticAllowExclusion(fact), label);
      assert.ok(fact.unitText.length > 0, `the triggering segment is identified: ${label}`);
      assert.ok(fact.unitText.length <= STATIC_ALLOW_EXCLUSION_TEXT_LIMIT, label);
      assert.ok(fact.word.length <= STATIC_ALLOW_EXCLUSION_TEXT_LIMIT, label);
      assert.ok(triggers[0].text.includes(fact.unitText), label);
      assert.equal(triggers[0].detail, fact.word || null, label);
      assert.equal(
        f.wire[0].raw.payload.evidence.filter(
          (entry) => entry.label === STATIC_ALLOW_EXCLUSION_EVIDENCE,
        ).length,
        child ? 1 : 0,
        `parent-only exclusions start without child trigger evidence: ${label}`,
      );
      assert.equal(f.served[0].sessionGrantUnavailable, true, label);
      assert.equal(f.served[0].sessionApproval, undefined, label);
      assert.equal(result.allowed, true, "the parent's one-time approval answers the call");
      assert.deepEqual(f.recorded, [], `no serving-session grant is recorded: ${label}`);
      assert.deepEqual(f.childGate.approvals, [], `no child grant is recorded: ${label}`);
    }
});

test("the requested text binds to the real execution input, untrimmed", async () => {
  const cwd = workspace();
  const g = gate(cwd);
  for (const command of ["cat README\n", "  cat README", "cat README \n\n"]) {
    const result = await g.call(command, (input) => captureRequestedBashCommand(input));
    assert.equal(result.allowed, true, JSON.stringify(command));
    assert.equal(result.asked.length, 0, JSON.stringify(command));
  }
  const trimmed = await g.call("cat README\n", (input) => {
    captureRequestedBashCommand(input);
    input.command = "cat README";
  });
  assert.equal(trimmed.asked.length, 1, "a changed execution text is not the requested one");
  assert.equal(trimmed.asked[0].accessIntent.staticAllowExclusion.rule, "unverified-original");
});

test("advisory queries apply yolo like the gate, never past a deny", async () => {
  const cwd = workspace();
  for (const agent of [undefined, "editor"]) {
    const { resolver } = gate(cwd, { yolo: true, agent });
    assert.equal(resolveBashAdvisoryCheck('cat "$X"', agent, resolver).state, "allow");
    assert.equal(resolveBashAdvisoryCheck("sudo true", agent, resolver).state, "deny");
    const { resolver: denying } = gate(cwd, {
      yolo: true,
      agent,
      config: withBash({ ...ALLOWS, "wc *": "deny" }),
    });
    assert.equal(resolveBashAdvisoryCheck("wc -l *.env", agent, denying).state, "deny");
  }
});

test("literal redirect targets decode names the shell does not expand", async () => {
  const cwd = workspace();
  for (const agent of [undefined, "editor"]) {
    const config = withBash(ALLOWS, {
      path_write: {
        ...shipped.permission.path_write,
        "*/123": "deny",
        "*/1": "deny",
        "*/notes.txt": "deny",
      },
    });
    const run = (command) => gate(cwd, { agent, config }).call(command);
    for (const command of [
      "echo hi > 秘密.env",
      "echo hi > café.env",
      "echo hi > new\\ name.env",
      "echo hi > x!.env",
      'echo hi > "a\\"b.env"',
      'echo hi > "a b".env',
      "echo hi > \\new.env",
      "echo hi >123",
      "echo hi > 123",
      "echo hi &>1",
      "echo hi >> 123",
    ]) {
      const result = await run(command);
      assert.equal(result.allowed, false, `${agent ?? "parent"}: ${command}`);
      assert.equal(result.asked.length, 0, `a path deny is final: ${command}`);
    }
    for (const command of ["echo hi >&2", "echo hi 1>&2", "cat <&0"]) {
      const result = await run(command);
      assert.equal(result.allowed, true, `${agent ?? "parent"}: ${command}`);
      assert.equal(result.asked.length, 0, command);
    }
    // Only the first word of an unresolved `<>` is a target: the later
    // operand's write deny does not fire; the unparsed redirect still asks.
    const rw = await run("cat <> rw.txt notes.txt");
    assert.equal(rw.asked.length, 1, "not a final notes.txt write deny");
    assert.equal(rw.asked[0].payload.request.surface, "bash");
  }
  assert.deepEqual(await candidates(cwd, "echo hi >123"), [["123", "write"]]);
  assert.deepEqual(await candidates(cwd, "echo hi &>1"), [["1", "write"]]);
  assert.deepEqual(await candidates(cwd, "cat <123"), [["123", "read"]]);
  assert.deepEqual(await candidates(cwd, "echo hi >&2"), []);
  assert.deepEqual(await candidates(cwd, "echo hi > new\\ name.env"), [["new name.env", "write"]]);
  assert.deepEqual(await candidates(cwd, 'echo hi > "a\\$b"'), [["a$b", "write"]]);
  const rw = await candidates(cwd, "cat <> rw.txt notes.txt");
  assert.ok(
    rw.some(([token, effect]) => token === "rw.txt" && effect === "unproven"),
    "first word",
  );
  assert.ok(
    !rw.some(([token, effect]) => token === "notes.txt" && effect !== "read"),
    `later words stay argv: ${JSON.stringify(rw)}`,
  );
  // Expanding spellings stay non-literal (upstream handling and, under an
  // allow, the dynamic-operand exclusion), never a decoded filename.
  for (const command of ["echo hi > ~/x.env", "echo hi > {a,b}.env", "echo hi > $'x.env'"])
    assert.ok(
      !(await candidates(cwd, command)).some(([token]) =>
        /^(?:x\.env|a\.env|\{a,b\}\.env)$/.test(token),
      ),
      command,
    );
});
