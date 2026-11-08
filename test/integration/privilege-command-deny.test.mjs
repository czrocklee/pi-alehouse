// Authority-only privilege-command floor. All shell programs below are test
// data: no command, subprocess, model, network or static safety guard executes.
// Exercise the real local gate, advisory service and child → parent JSON edge.
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const root = mkdtempSync(join(tmpdir(), "alehouse-privilege-deny-"));
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const home = join(root, "home"),
  agentDir = join(root, "agent");
for (const dir of [home, join(agentDir, "agents"), join(home, ".config")])
  mkdirSync(dir, { recursive: true });
cpSync(join(packageRoot, "generated/agents/editor.md"), join(agentDir, "agents/editor.md"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
for (const kind of ["DATA", "STATE", "CACHE"]) {
  const dir = join(home, kind.toLowerCase());
  mkdirSync(dir);
  process.env[`XDG_${kind}_HOME`] = dir;
}
process.env.PI_CODING_AGENT_DIR = agentDir;

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
const load = (name) =>
  jiti.import(join(packageRoot, "generated/authority/vendor/src", `${name}.ts`));
// Load one canonical graph in order. Concurrent Jiti imports through different
// routes can duplicate mutable parser state instead of warming the service's parser.
const loadAll = async (names) => {
  const modules = [];
  for (const name of names) modules.push(await load(name));
  return modules;
};
await load("access-intent/bash/parser");
const [
  { PermissionManager },
  { PermissionResolver },
  { PathNormalizer },
  { posixPathFlavor },
  { SessionRules },
  { PermissionSession },
  { PermissionGateHandler },
  { ToolCallGatePipeline },
  { resolveToolPreviewLimits },
  { GateRunner },
  { LocalPermissionsService },
  { resolveBashAdvisoryCheck },
  { warmBashParser, resetWarmBashParser, getWarmBashParser },
  { ForwardedRequestServer, createServingPolicy },
  { ParentAuthorizer },
  { createPermissionForwardingLocation },
  { readForwardedPermissionRequest, readForwardedPermissionResponse },
  { getSubagentSessionRegistry },
] = await loadAll([
  "policy/permission-manager",
  "policy/permission-resolver",
  "path/path-normalizer",
  "path/path-flavor",
  "session/session-rules",
  "session/permission-session",
  "handlers/permission-gate-handler",
  "handlers/gates/tool-call-gate-pipeline",
  "tool-input/tool-preview-formatter",
  "handlers/gates/runner",
  "service/permissions-service",
  "service/bash-advisory-check",
  "access-intent/bash/parser",
  "authority/forwarded-request-server",
  "authority/approval-escalator",
  "authority/permission-forwarding",
  "authority/forwarding-io",
  "authority/subagent-registry",
]);

await warmBashParser();
assert.ok(getWarmBashParser(), "fixture requires the real AST parser");

const seed = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
const privilegeRules = Object.fromEntries(
  ["sudo", "doas", "su"].map((name) => [`${name} *`, seed.permission.bash[`${name} *`]]),
);
// Deliberately synthetic, permissive path/external policy: even a non-existing
// /run/wrappers/bin/sudo must reach the command floor, not a path gate.
function config(bash = privilegeRules) {
  return {
    permission: {
      "*": "allow",
      managed_static_read: "ask",
      managed_static_file_effects: "ask",
      path: { "*": "allow" },
      external_directory: { "*": "allow" },
      bash: { "*": "ask", ...bash },
    },
  };
}
const approved = {
  approved: true,
  state: "approved_for_session",
  sessionGrantWidth: "proven",
  decidedBy: { kind: "user", via: "dialog" },
};
const unavailable = {
  approved: false,
  state: "denied",
  confirmationUnavailable: true,
  decidedBy: { kind: "unavailable", reason: "Synthetic permission-only fixture" },
};
let serial = 0;
function workspace() {
  const cwd = mkdtempSync(join(root, "workspace-"));
  writeFileSync(join(cwd, "README"), "synthetic fixture\n");
  return cwd;
}
function editorAgents(bash) {
  const dir = mkdtempSync(join(root, "project-agents-"));
  const lines = Object.entries(bash).map(
    ([pattern, action]) => `    ${JSON.stringify(pattern)}: ${action}`,
  );
  writeFileSync(
    join(dir, "editor.md"),
    ["---", "permission:", "  bash:", ...lines, "---", ""].join("\n"),
  );
  return dir;
}
function projectPolicy(bash) {
  const path = join(root, `project-${serial++}.json`);
  writeFileSync(path, JSON.stringify({ permission: { bash } }));
  return path;
}

function fixture(options = {}) {
  // Explicit null/undefined both mean the unscoped root; never default them to
  // editor. Editor normally uses the untouched shipped catch-all-ask profile.
  const agent = "agent" in options ? options.agent : "editor";
  const cwd = options.cwd ?? workspace();
  const configPath = join(root, `global-${serial++}.json`);
  writeFileSync(configPath, JSON.stringify(options.config ?? config()));
  const yolo = options.yolo ?? false;
  const manager = new PermissionManager({
    globalConfigPath: configPath,
    agentsDir: join(agentDir, "agents"),
    globalMcpConfigPath: join(agentDir, "mcp.json"),
    mcpServerNames: [],
    isYoloEnabled: () => yolo,
    ...options.managerOptions,
  });
  const sessionRules = new SessionRules();
  for (const pattern of options.grants ?? []) sessionRules.approve("bash", pattern);
  const resolver = new PermissionResolver(manager, sessionRules);
  const prompts = [],
    recorded = [],
    events = [],
    logs = [];
  const recorder = {
    recordSessionApproval(approval) {
      recorded.push(approval.toForwardedData());
      sessionRules.recordSessionApproval(approval);
    },
  };
  const runner = new GateRunner(
    resolver,
    recorder,
    {
      async escalate(details) {
        prompts.push(details);
        return options.escalate ? options.escalate(details) : (options.decision ?? unavailable);
      },
    },
    {
      writeReviewLog: (event, details) => logs.push({ event, details }),
      emitDecision: (event) => events.push(event),
    },
    () => yolo,
  );
  const session = new PermissionSession(
    {},
    { start() {}, stop() {} },
    manager,
    sessionRules,
    {},
    { activate() {}, deactivate() {} },
    posixPathFlavor,
  );
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const tools = [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }];
  const handler = new PermissionGateHandler(
    session,
    { getAll: () => tools, getActive: () => ["bash"], setActive() {} },
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
      getSessionId: () => options.sessionId ?? "privilege-fixture",
    },
  };
  session.activate(ctx);
  assert.equal(session.resolveAgentName(ctx), agent ?? null, "actual gate principal");
  const service = new LocalPermissionsService(resolver, session, {}, {}, {});
  return {
    manager,
    resolver,
    session,
    sessionRules,
    recorder,
    service,
    configPath,
    prompts,
    recorded,
    events,
    logs,
    ctx,
    async call(command) {
      const before = { prompts: prompts.length, recorded: recorded.length, events: events.length };
      const input = { command };
      const outcome = await handler.handleToolCall(
        { toolCallId: randomUUID(), toolName: "bash", input },
        ctx,
      );
      assert.equal(
        input.command,
        command,
        "permission checking never executes/rewrites the program",
      );
      return {
        outcome,
        prompts: prompts.slice(before.prompts),
        recorded: recorded.slice(before.recorded),
        events: events.slice(before.events),
      };
    },
  };
}

function assertCheckDenied(check, name, label) {
  assert.equal(check.state, "deny", `${label}: ${JSON.stringify(check)}`);
  assert.equal(check.source, "bash", label);
  assert.equal(check.origin, "global", label);
  assert.equal(check.matchedPattern, `${name} *`, label);
  assert.equal(check.reason, privilegeRules[`${name} *`].reason, label);
}
async function assertDenied(f, command, name = "sudo") {
  const result = await f.call(command);
  assert.equal(result.outcome.action, "block", command);
  assert.equal(result.prompts.length, 0, `deny never escalates: ${command}`);
  assert.deepEqual(result.recorded, [], `deny never records a session grant: ${command}`);
  assert.match(result.outcome.reason, new RegExp(privilegeRules[`${name} *`].reason), command);
  const denial = result.events.find((event) => event.surface === "bash" && event.result === "deny");
  assert.ok(denial, `real gate reports Bash denial: ${command}`);
  assert.equal(denial.origin, "global", command);
  assert.equal(denial.matchedPattern, `${name} *`, command);
  assertCheckDenied(
    f.service.checkPermission("bash", command, f.session.resolveAgentName(f.ctx) ?? undefined),
    name,
    command,
  );
  return result;
}

const PRIVILEGE_CASES = ["sudo", "doas", "su"].flatMap((name) => [
  [name, `${name} true`],
  [name, `${name}\t${name === "su" ? "root" : "true"}`],
  [name, `${name} "$X"`],
  [name, `'${name}' true`],
  [name, `"${name}" true`],
  [name, `${name.slice(0, 1)}''${name.slice(1)} true`],
  [name, `\\${name} true`],
  [name, `/run/wrappers/bin/${name} true`],
  [name, `'/run/wrappers/bin/${name}' true`],
  [name, `env FOO=bar ${name} true`],
  [name, `env > out ${name} true`],
  [name, `timeout 1 2>/dev/null ${name} true`],
  [name, `command -- ${name} true`],
  [name, `exec ${name} true`],
  [name, `timeout 5 ${name} true`],
  [name, `nice -n 5 ${name} true`],
  [name, `timeout 5 env FOO=bar command -- nice -n 5 ${name} true`],
]);
PRIVILEGE_CASES.push(["sudo", "env -u builtin sudo true"], ["sudo", "exec -a builtin sudo true"]);
const NESTED_CASES = [
  "env wc -l <<EOF\n$(sudo true)\nEOF",
  "env wc -l <<EOF\n$(timeout 5 env FOO=bar command -- sudo true)\nEOF",
  "env wc -l <<EOF\n`sudo true`\nEOF",
  "env wc -l <<EOF\n`printf '%s' \"$(sudo true)\"`\nEOF",
  "env wc -l <<EOF\n`echo \\`sudo true\\``\nEOF",
  "env wc -l <<EOF\n`X=\\\\a sudo true`\nEOF",
  "echo ok && sudo true",
  "echo ok; doas true",
  "echo ok | su true",
  "{ sudo true; }",
  "(sudo true)",
  'echo "$(sudo true)"',
  "echo `sudo true`",
  "cat <(sudo true)",
  "cat <<< $(sudo true)",
  "if true; then sudo true; fi",
  "for item in a; do sudo true; done",
];

for (const agent of [null, undefined, "editor"])
  test(`global privilege denies survive profile, grants and yolo: ${String(agent)}`, async () => {
    for (const options of [
      {},
      { grants: ["*", "sudo *", "doas *", "su *", "env *"] },
      { yolo: true, grants: ["*", "sudo *", "doas *", "su *", "env *"] },
    ]) {
      const f = fixture({ agent, ...options, decision: approved });
      assert.deepEqual(f.manager.getConfigIssues(agent ?? undefined), []);
      for (const [name, command] of PRIVILEGE_CASES) await assertDenied(f, command, name);
      for (const command of NESTED_CASES)
        await assertDenied(
          f,
          command,
          command.includes("doas true") ? "doas" : command.includes("su true") ? "su" : "sudo",
        );
    }
  });

test("project catch-all and exact allows cannot weaken the raw global privilege deny", async () => {
  const projectGlobalConfigPath = projectPolicy({
    "*": "allow",
    "sudo *": "allow",
    "env *": "allow",
  });
  const projectAgentsDir = editorAgents({ "*": "allow", "sudo *": "allow", "env *": "allow" });
  for (const agent of [null, "editor"])
    for (const managerOptions of [{ projectGlobalConfigPath }, { projectAgentsDir }]) {
      const f = fixture({ agent, managerOptions, yolo: true, grants: ["*"] });
      await assertDenied(f, "sudo true");
      await assertDenied(f, "env wc -l <<EOF\n$(sudo true)\nEOF");
    }
});

const DATA_CASES = [
  "echo sudo true",
  "echo sudo",
  "echo >out sudo true",
  "command -v sudo",
  "command -V sudo",
  '"X=1" sudo',
  "builtin sudo true",
  "builtin env sudo true",
  "printf '%s\\n' 'sudo true'",
  "env wc -l <<'EOF'\n$(sudo true)\nEOF",
  "env wc -l <<'EOF'\n`sudo true`\nEOF",
  "env wc -l <<EOF\n\\`sudo true\\`\nEOF",
  "env wc -l <<EOF\n$(printf '%s' '`sudo true`')\nEOF",
  "env wc -l <<EOF\n`printf '%s' '$(sudo true)'`\nEOF",
  "env wc -l <<EOF\nsudo true\nEOF",
  "echo ok # sudo true",
  "cat sudo.txt",
  "cat <> ordinary.txt",
  "python3 -c 'print(\"sudo true\")'",
  "bash -c 'echo sudo true'",
];
test("data, quoted interpreter source and comments never become a privilege hard deny", async () => {
  for (const agent of [null, "editor"]) {
    const f = fixture({ agent, yolo: true, grants: ["*"] });
    for (const command of DATA_CASES) {
      const result = await f.call(command);
      assert.equal(result.outcome.action, "allow", command);
      assert.equal(result.prompts.length, 0, command);
      assert.notEqual(
        f.service.checkPermission("bash", command, agent ?? undefined).state,
        "deny",
        command,
      );
    }
  }
});

test("nested heredoc backticks retain real ordinary denies but not single-quoted command data", async () => {
  const reason = "Synthetic ordinary curl denial";
  const f = fixture({
    agent: null,
    config: config({ "curl *": { action: "deny", reason } }),
    yolo: true,
  });
  assert.deepEqual(f.manager.getConfigIssues(), []);
  assert.deepEqual(
    f.sessionRules.getRuleset(),
    [],
    "no session approval can mask an ordinary deny",
  );
  const actual = "env wc -l <<EOF\n`printf '%s' \"$(curl https://example.invalid)\"`\nEOF";
  const data = "env wc -l <<EOF\n`printf '%s' '$(curl https://example.invalid)'`\nEOF";
  const denied = await f.call(actual);
  assert.equal(denied.outcome.action, "block", actual);
  assert.ok(denied.outcome.reason.includes(reason));
  assert.equal(denied.prompts.length, 0);
  assert.deepEqual(denied.recorded, []);
  const event = denied.events.find((entry) => entry.surface === "bash" && entry.result === "deny");
  assert.ok(event, "the actual ordinary Bash gate retains the nested curl execution");
  assert.equal(event.origin, "global");
  assert.equal(event.matchedPattern, "curl *");
  const check = f.service.checkPermission("bash", actual);
  assert.equal(check.state, "deny", JSON.stringify(check));
  assert.equal(check.source, "bash");
  assert.equal(check.origin, "global");
  assert.equal(check.matchedPattern, "curl *");
  assert.equal(check.reason, reason);
  const harmless = await f.call(data);
  assert.equal(harmless.outcome.action, "allow", data);
  assert.equal(harmless.prompts.length, 0);
  assert.deepEqual(harmless.recorded, []);
  const bashEvents = harmless.events.filter((entry) => entry.surface === "bash");
  assert.ok(bashEvents.length > 0, "the data control traverses the actual Bash gate");
  assert.ok(bashEvents.every((entry) => entry.result === "allow"));
  assert.notEqual(f.service.checkPermission("bash", data).state, "deny", data);
});

test("Unicode non-Bash blanks stay inside literal executable names", async () => {
  const projectGlobalConfigPath = projectPolicy({ "*": "allow" });
  for (const agent of [null, "editor"])
    for (const yolo of [false, true]) {
      const f = fixture({
        agent,
        yolo,
        decision: approved,
        managerOptions: { projectGlobalConfigPath },
      });
      assert.deepEqual(f.manager.getConfigIssues(agent ?? undefined), []);
      // Keep the raw global privilege denies active, but make ordinary policy
      // permissive. An upstream projection may still ask; explicit synthetic
      // approval answers that ask rather than confusing it with a hard deny.
      for (const command of ["sudo\u00a0true", "env\u00a0sudo true"]) {
        const result = await f.call(command);
        const check = f.service.checkPermission("bash", command, agent ?? undefined);
        const evidence = JSON.stringify({
          command,
          outcome: result.outcome,
          check,
          events: result.events,
        });
        assert.equal(result.outcome.action, "allow", evidence);
        assert.ok(["allow", "ask"].includes(check.state), evidence);
        assert.equal(check.source, "bash", evidence);
        const bashEvents = result.events.filter((event) => event.surface === "bash");
        assert.ok(bashEvents.length > 0, `actual Bash gate must report a decision: ${evidence}`);
        assert.ok(
          bashEvents.every((event) => event.result === "allow"),
          evidence,
        );
        assert.equal(check.reason, undefined, evidence);
      }
      // Adjacent executable spelling is genuinely privileged: the same live
      // fixture must still deny it, including after any ordinary session grant.
      await assertDenied(f, "sudo true");
      await assertDenied(f, "env sudo true");
    }
});

test("ordinary asks, real session recording, overrides and yolo keep their existing behavior", async () => {
  for (const agent of [null, "editor"]) {
    const f = fixture({ agent, decision: approved });
    const first = await f.call("fixture-command ordinary");
    assert.equal(first.outcome.action, "allow");
    assert.equal(first.prompts.length, 1, "positive escalation control");
    assert.equal(first.recorded.length, 1, "positive real SessionRules recording control");
    assert.ok(f.sessionRules.getRuleset().some((rule) => rule.surface === "bash"));
    const again = await f.call("fixture-command ordinary");
    assert.equal(again.outcome.action, "allow");
    assert.equal(again.prompts.length, 0, "recorded grant satisfies the retry");
    assert.equal(
      (await fixture({ agent, yolo: true }).call("fixture-command ordinary")).outcome.action,
      "allow",
    );

    const noDeny = fixture({ agent, config: config({}), decision: approved });
    const ordinaryPrivilegeAsk = await noDeny.call("sudo true");
    assert.equal(ordinaryPrivilegeAsk.outcome.action, "allow", "not an unconditional sudo ban");
    assert.equal(
      ordinaryPrivilegeAsk.prompts.length,
      1,
      "without an explicit deny this is an ordinary ask",
    );
    assert.equal(ordinaryPrivilegeAsk.recorded.length, 1);
  }
  // Scope merging replaces matching keys, not every earlier specific key:
  // the shipped editor's catch-all ask genuinely overrides this catch-all deny.
  const nonsudoDeny = config({ "*": "deny" });
  const projectGlobalConfigPath = projectPolicy({ "fixture-command *": "allow" });
  const project = fixture({
    agent: null,
    config: nonsudoDeny,
    managerOptions: { projectGlobalConfigPath },
  });
  assert.equal((await project.call("fixture-command ordinary")).outcome.action, "allow");
  const editor = fixture({ agent: "editor", config: nonsudoDeny, decision: approved });
  const editorCheck = editor.service.checkPermission("bash", "fixture-command ordinary", "editor");
  assert.equal(editorCheck.state, "ask");
  assert.equal(editorCheck.origin, "agent", "the shipped editor supplies the actual override");
  const overridden = await editor.call("fixture-command ordinary");
  assert.equal(
    overridden.outcome.action,
    "allow",
    "shipped editor overrides an ordinary global deny",
  );
  assert.equal(overridden.prompts.length, 1);
});

test("the last matching allow in the same raw global scope remains an exception", async () => {
  for (const agent of [null, "editor"]) {
    const f = fixture({
      agent,
      config: config({ ...privilegeRules, "sudo true": "allow" }),
      yolo: true,
    });
    for (const command of ["sudo true", "s''udo true", "'/run/wrappers/bin/sudo' true"])
      assert.equal((await f.call(command)).outcome.action, "allow", command);
    await assertDenied(f, "sudo false");
    const lastDeny = fixture({
      agent,
      config: config({ "sudo true": "allow", ...privilegeRules }),
      yolo: true,
      grants: ["*"],
    });
    await assertDenied(lastDeny, "sudo true");
    const aliasException = fixture({
      agent,
      config: config({
        ...privilegeRules,
        "'sudo' true": "deny",
        "sudo true": "allow",
      }),
      yolo: true,
    });
    assert.equal(
      aliasException.manager.checkPrivilegeBashRestriction("'sudo' true", agent ?? undefined),
      undefined,
      "the deny-only floor compares raw and canonical aliases in same-scope rule order",
    );
    assert.equal((await aliasException.call("sudo true")).outcome.action, "allow");
    const rawDeny = await aliasException.call("'sudo' true");
    assert.equal(
      rawDeny.outcome.action,
      "block",
      "no floor deny never manufactures an ordinary allow",
    );
    assert.equal(rawDeny.prompts.length, 0, "ordinary exact raw-spelling deny remains final");
    assert.deepEqual(rawDeny.recorded, []);
    const event = rawDeny.events.find(
      (entry) => entry.surface === "bash" && entry.result === "deny",
    );
    assert.ok(event, "the actual ordinary Bash gate reports its selected raw deny");
    assert.equal(event.origin, "global");
    assert.equal(event.matchedPattern, "'sudo' true");
  }
});

test("outer wrapper allows never become same-command global privilege exceptions", async () => {
  for (const agent of [null, "editor"]) {
    const f = fixture({
      agent,
      config: config({
        ...privilegeRules,
        "env *": "allow",
        "timeout *": "allow",
        "sudo --version": "allow",
      }),
      yolo: true,
      grants: ["*"],
    });
    for (const command of [
      "env sudo true",
      "timeout 5 sudo true",
      "timeout 5 env sudo true",
      "env wc -l <<EOF\n$(sudo true)\nEOF",
    ])
      await assertDenied(f, command);
    assert.equal((await f.call("sudo --version")).outcome.action, "allow");
    assert.equal((await f.call("env sudo --version")).outcome.action, "allow");
  }
});

test("precise privilege patterns preserve argument source rather than joining argument values", async () => {
  const reason = "Synthetic precise privilege denial";
  for (const agent of [null, "editor"]) {
    const f = fixture({
      agent,
      config: config({ "sudo echo safe": { action: "deny", reason } }),
      yolo: true,
      grants: ["*"],
    });
    for (const command of ["sudo echo safe", "'sudo' echo safe", "env sudo echo safe"]) {
      const result = await f.call(command);
      assert.equal(result.outcome.action, "block", command);
      assert.equal(result.prompts.length, 0, command);
      assert.deepEqual(result.recorded, []);
      const check = f.service.checkPermission("bash", command, agent ?? undefined);
      assert.equal(check.state, "deny", command);
      assert.equal(check.source, "bash", command);
      assert.equal(check.origin, "global", command);
      assert.equal(check.matchedPattern, "sudo echo safe", command);
      assert.equal(check.reason, reason, command);
    }
    for (const command of ["sudo 'echo safe'", "sudo echo 'safe'", "env sudo 'echo safe'"])
      assert.equal((await f.call(command)).outcome.action, "allow", command);
  }
});

const privilegePath = "/run/wrappers/bin/sudo";
const privilegePathPattern = `${privilegePath} *`;
const privilegePathReason = "Synthetic path-only privilege denial";
const privilegePathRule = {
  [privilegePathPattern]: { action: "deny", reason: privilegePathReason },
};
function assertPathPrivilegeDenied(check, label) {
  assert.equal(check.state, "deny", `${label}: ${JSON.stringify(check)}`);
  assert.equal(check.source, "bash", label);
  assert.equal(check.origin, "global", label);
  assert.equal(check.matchedPattern, privilegePathPattern, label);
  assert.equal(check.reason, privilegePathReason, label);
}

test("a path-only global privilege deny covers decoded executable aliases without a basename deny", async () => {
  const commands = [
    `${privilegePath} true`,
    `'${privilegePath}' true`,
    "/run/wrappers/bin/s''udo true",
    "/run/wrappers/bin/su\\do true",
    `env FOO=bar '${privilegePath}' true`,
  ];
  for (const agent of [null, "editor"]) {
    const f = fixture({
      agent,
      config: config(privilegePathRule),
      yolo: true,
      grants: ["*", "sudo *", `${privilegePath} *`, "env *"],
      decision: approved,
    });
    assert.deepEqual(f.manager.getConfigIssues(agent ?? undefined), []);
    assert.equal((await f.call("sudo true")).outcome.action, "allow", "no hidden basename deny");
    for (const command of commands) {
      const result = await f.call(command);
      assert.equal(result.outcome.action, "block", command);
      assert.ok(result.outcome.reason.includes(privilegePathReason), command);
      assert.equal(result.prompts.length, 0, "a path-only privilege deny never escalates");
      assert.deepEqual(result.recorded, [], "a path-only privilege deny records no grant");
      const event = result.events.find(
        (entry) => entry.surface === "bash" && entry.result === "deny",
      );
      assert.ok(event, command);
      assert.equal(event.origin, "global", command);
      assert.equal(event.matchedPattern, privilegePathPattern, command);
      assertPathPrivilegeDenied(
        f.service.checkPermission("bash", command, agent ?? undefined),
        command,
      );
    }
    for (const action of ["allow", "ask"]) {
      const exception = fixture({
        agent,
        config: config({ ...privilegePathRule, [`${privilegePath} true`]: action }),
        yolo: true,
        grants: ["*"],
      });
      for (const command of commands)
        assert.equal(
          exception.manager.checkPrivilegeBashRestriction(command, agent ?? undefined),
          undefined,
          `a later same-global ${action} exception wins across executable aliases: ${command}`,
        );
      // This query asserts only absence of an invented floor deny: unrelated
      // ordinary-policy restrictions must not be removed to manufacture ALLOW.
    }
  }
});

test("invalid project configuration keeps its fail-closed ask under yolo", async () => {
  const projectGlobalConfigPath = join(root, `invalid-${serial++}.json`);
  writeFileSync(projectGlobalConfigPath, "{invalid");
  for (const agent of [null, "editor"]) {
    // The invalid-scope floor clamps configured ALLOWs, not ordinary ASKs or
    // a separate SessionRules store. Supply a genuine scoped allow so this
    // checks fail-closed/yolo behavior rather than an unrelated ordinary ask.
    const f = fixture({
      agent,
      yolo: true,
      config: config({ ...privilegeRules, "*": "allow" }),
      managerOptions: {
        projectGlobalConfigPath,
        projectAgentsDir: editorAgents({ "*": "allow" }),
      },
    });
    assert.ok(f.manager.getConfigIssues(agent ?? undefined).length > 0);
    const check = f.service.checkPermission("bash", "fixture-command ordinary", agent ?? undefined);
    assert.equal(check.state, "ask");
    assert.equal(check.origin, "fail-closed");
    const result = await f.call("fixture-command ordinary");
    assert.equal(result.outcome.action, "block", JSON.stringify({ check, result }));
    assert.ok(
      result.prompts.length > 0,
      "yolo cannot satisfy the invalid-config allow-to-ask floor",
    );
    assert.deepEqual(result.recorded, []);
    assert.ok(
      result.events.some((event) => event.surface === "bash" && event.origin === "fail-closed"),
    );
    await assertDenied(f, "env wc -l <<EOF\n$(sudo true)\nEOF");
  }
});

test("live owned global config reload adds, changes and removes the privilege floor", async () => {
  const f = fixture({ agent: "editor", config: config({}), yolo: true, grants: ["*"] });
  const command = "env wc -l <<EOF\n$(sudo true)\nEOF";
  assert.equal((await f.call(command)).outcome.action, "allow");
  let tick = 0;
  function reload(next) {
    writeFileSync(f.configPath, JSON.stringify(next));
    // Own file only; distinct observed mtimes refresh the loader's file cache
    // as well as the manager cache reset performed by actual session reload.
    const time = new Date(Date.now() + ++tick * 2000);
    utimesSync(f.configPath, time, time);
    f.session.reload(true);
  }
  reload(config());
  await assertDenied(f, command);
  reload(config({ ...privilegeRules, "sudo true": "allow" }));
  assert.equal(
    f.manager.checkPrivilegeBashRestriction("sudo true", "editor"),
    undefined,
    "reload removes the selected floor deny for the same-scope exception",
  );
  // Use a literal call for the exception's positive control: an expanding
  // heredoc independently excludes all ordinary allows, so its remaining
  // ordinary sudo deny must not be weakened just to manufacture an allowance.
  assert.equal(
    (await f.call("sudo true")).outcome.action,
    "allow",
    "live same-scope allow exception",
  );
  reload(config({}));
  assert.equal(
    (await f.call(command)).outcome.action,
    "allow",
    "removed explicit deny is not cached",
  );
  reload(config());
  await assertDenied(f, command);
});

test("actual advisory service matches warm gates and fails closed while the parser is cold", async () => {
  try {
    for (const agent of [null, "editor"]) {
      const f = fixture({ agent, yolo: true, grants: ["*"] });
      resetWarmBashParser();
      assert.equal(getWarmBashParser(), null, "really exercising the cold branch");
      const command = "env wc -l <<EOF\n$(sudo true)\nEOF";
      for (const check of [
        f.service.checkPermission("bash", command, agent ?? undefined),
        resolveBashAdvisoryCheck(command, agent ?? undefined, f.resolver),
      ]) {
        assert.equal(
          check.state,
          "ask",
          "cold parser cannot grant an uninspected program under yolo",
        );
        assert.notEqual(check.source, "session");
        assert.equal(check.origin, "fail-closed");
      }
      const syntaxCases = ["X=1 sudo true", "! sudo true", "echo fixture\nsudo true"];
      for (const program of syntaxCases)
        for (const check of [
          f.service.checkPermission("bash", program, agent ?? undefined),
          resolveBashAdvisoryCheck(program, agent ?? undefined, f.resolver),
        ]) {
          assert.ok(["ask", "deny"].includes(check.state), `cold syntax never grants: ${program}`);
          if (check.state === "deny") assertCheckDenied(check, "sudo", program);
          else assert.equal(check.origin, "fail-closed", program);
        }
      const literal = f.service.checkPermission("bash", "sudo true", agent ?? undefined);
      assert.ok(["ask", "deny"].includes(literal.state), "cold direct literal never grants");
      if (literal.state === "deny") assertCheckDenied(literal, "sudo", "cold direct literal");
      await warmBashParser();
      assert.ok(getWarmBashParser(), "warm-up really initialized the AST parser");
      await assertDenied(f, command);
      for (const program of syntaxCases) await assertDenied(f, program);
      for (const [name, program] of PRIVILEGE_CASES)
        assertCheckDenied(
          resolveBashAdvisoryCheck(program, agent ?? undefined, f.resolver),
          name,
          program,
        );
      assert.equal(
        f.service.checkPermission("bash", "fixture-command ordinary", agent ?? undefined).state,
        "allow",
      );
    }
  } finally {
    await warmBashParser();
  }
});

// Parent-only policy is critical: the child's synthetic global config contains
// NO sudo/doas/su deny (not the shipped seed), so its real forwarding edge runs.
const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
function forwardingFixture(t, parentOptions = {}) {
  const parentId = randomUUID(),
    childId = randomUUID(),
    forwardingDir = mkdtempSync(join(root, "forwarding-"));
  const registry = getSubagentSessionRegistry();
  registry.register(childId, { parentSessionId: parentId });
  t.after(() => registry.unregister(childId));
  const previous = globalThis[servicesKey];
  const services = previous instanceof Map ? previous : new Map();
  globalThis[servicesKey] = services;
  t.after(() => {
    services.delete(childId);
    if (!(previous instanceof Map)) delete globalThis[servicesKey];
  });
  const cwd = workspace();
  const child = fixture({
    cwd,
    agent: "editor",
    config: config({}),
    sessionId: childId,
    escalate: (details) => edge.authorize(details),
  });
  services.set(childId, child.service);
  const edge = new ParentAuthorizer(child.ctx, {
    forwardingDir,
    registry,
    serving: {
      isServing: () => true,
      describe: () => ({ channel: "registry", state: "serving", servingIds: [parentId] }),
    },
    getTimeoutMs: () => 15000,
    logger: { review() {}, debug() {} },
  });
  const parent = fixture({ cwd, ...parentOptions, sessionId: parentId });
  const policy = createServingPolicy(parent.resolver);
  const resolved = [],
    wire = [],
    responses = [],
    served = [];
  const server = new ForwardedRequestServer({
    forwardingDir,
    registry,
    logger: { review() {}, debug() {} },
    policy: {
      async resolve(intent) {
        const check = await policy.resolve(intent);
        resolved.push({ intent, check });
        return check;
      },
    },
    escalator: {
      async escalate(details) {
        served.push(details);
        return (
          parentOptions.decision ?? {
            ...approved,
            state: "approved_for_serving_session",
          }
        );
      },
    },
    broadcaster: { emitDecision() {} },
    recorder: parent.recorder,
  });
  const location = createPermissionForwardingLocation(forwardingDir, parentId);
  const parentCtx = {
    ...parent.ctx,
    sessionManager: {
      ...parent.ctx.sessionManager,
      getSessionDir: () => location.sessionRootDir,
    },
  };
  async function call(command) {
    let settled = false;
    const pending = child.call(command).finally(() => {
      settled = true;
    });
    const seen = new Set();
    // Polling owned JSON files is the actual ParentAuthorizer protocol, not a
    // direct call that skips the wire/principal validation or serving policy.
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
      if (files.length) {
        await server.processInbox(parentCtx);
        // Read before the edge's next timer consumes its response.
        for (const name of files) {
          const path = join(location.responsesDir, name);
          if (existsSync(path)) responses.push(JSON.parse(readFileSync(path, "utf8")));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return pending;
  }
  return { parent, child, resolved, wire, responses, served, call, server, location, parentCtx };
}

test("parent-only privilege floor re-evaluates full requestedCommand through the real JSON edge", async (t) => {
  for (const command of [
    "sudo true",
    "env FOO=bar sudo true",
    "timeout 5 env command -- sudo true",
    "env > out sudo true",
    "timeout 1 2>/dev/null sudo true",
    "env wc -l <<EOF\n$(sudo true)\nEOF",
    "env wc -l <<EOF\n$(timeout 5 env FOO=bar command -- sudo true)\nEOF",
  ]) {
    const f = forwardingFixture(t, {
      yolo: true,
      config: config({ ...privilegeRules, "env *": "allow", "timeout *": "allow" }),
      grants: ["*", command, "sudo *", "env *"],
    });
    const result = await f.call(command);
    assert.equal(result.outcome.action, "block", command);
    assert.ok(f.wire.length > 0, `child must reach ParentAuthorizer, not deny locally: ${command}`);
    assert.equal(
      f.wire[0].raw.accessIntent.requestedCommand,
      command,
      "complete serialized program",
    );
    assert.equal(f.wire[0].parsed.accessIntent.requestedCommand, command, "real wire reader");
    assert.equal(f.wire[0].parsed.invalidStaticAllowExclusion, undefined);
    assert.ok(f.resolved.length > 0, "actual serving policy was invoked");
    assertCheckDenied(f.resolved[0].check, "sudo", command);
    assert.equal(f.served.length, 0, "parent deny never reaches authorizer escalation");
    assert.deepEqual(f.parent.recorded, [], "parent never records a denied grant");
    assert.deepEqual(f.child.recorded, [], "child never records a denied grant");
    assert.ok(f.responses.length > 0, "real JSON response captured");
    const response = f.responses[0];
    assert.equal(response.approved, false);
    assert.equal(response.decidedBy.kind, "rule");
    assert.equal(response.decidedBy.surface, "bash");
    assert.equal(response.decidedBy.origin, "global");
    assert.equal(response.decidedBy.pattern, "sudo *");
    assert.equal(response.denialReason, privilegeRules["sudo *"].reason);
  }
});

test("bounded heredoc inventory fails closed without any configured privilege deny", async (t) => {
  const command = [
    "env wc -l <<EOF",
    ...Array(256).fill("`true`"),
    "`printf '%s' \"$(curl https://example.invalid)\"`",
    "EOF",
  ].join("\n");
  const policy = config({ "curl *": { action: "deny", reason: "Synthetic ordinary curl denial" } });
  const marker = "<uninspected-heredoc-execution>";
  const local = fixture({ agent: null, config: policy, yolo: true, decision: unavailable });
  assert.deepEqual(local.manager.getConfigIssues(), []);
  assert.equal(local.manager.hasPrivilegeBashRestriction(), false, "no hidden sudo/doas/su floor");
  assert.ok(getWarmBashParser(), "advisory inspection uses the actual warmed parser");
  const check = local.service.checkPermission("bash", command);
  assert.equal(check.state, "ask", JSON.stringify(check));
  assert.equal(check.source, "bash");
  assert.equal(check.origin, "fail-closed");
  assert.equal(check.matchedPattern, marker, "incomplete source is not an invented curl denial");
  const result = await local.call(command);
  assert.equal(
    result.outcome.action,
    "block",
    "yolo cannot approve a truncated execution inventory",
  );
  assert.ok(
    result.prompts.length > 0,
    "ordinary fallback may ask but synthetic approval is unavailable",
  );
  assert.deepEqual(result.recorded, []);
  assert.deepEqual(local.sessionRules.getRuleset(), []);
  const event = result.events.find((entry) => entry.surface === "bash" && entry.result === "deny");
  assert.ok(event, "the actual Bash gate refuses the incomplete inventory");
  assert.equal(event.origin, "fail-closed");
  assert.equal(event.matchedPattern, marker);

  const parent = forwardingFixture(t, { config: policy, yolo: true, grants: ["*"] });
  const forwarded = await parent.call(command);
  assert.equal(forwarded.outcome.action, "block");
  assert.ok(parent.wire.length > 0, "the actual child forwards the incomplete full source");
  assert.equal(parent.wire[0].parsed.accessIntent.requestedCommand, command);
  assert.ok(
    parent.resolved.length > 0,
    "real serving policy checks completeness without a privilege floor",
  );
  assert.equal(parent.resolved[0].check.state, "ask");
  assert.equal(parent.resolved[0].check.origin, "fail-closed");
  assert.equal(parent.resolved[0].check.matchedPattern, marker);
  assert.equal(parent.served.length, 0, "a parent cannot authorize incomplete requested source");
  assert.deepEqual(parent.parent.recorded, []);
  assert.deepEqual(parent.child.recorded, []);
  assert.ok(parent.responses.length > 0);
  assert.equal(parent.responses[0].approved, false);
  assert.equal(parent.responses[0].decidedBy.kind, "gate_error");
});

test("parent inspection does not invent privilege execution from quoted data inside heredoc backticks", async (t) => {
  const command = "env wc -l <<EOF\n`printf '%s' '$(sudo true)'`\nEOF";
  const f = forwardingFixture(t, { yolo: true, grants: ["*"] });
  const result = await f.call(command);
  assert.equal(result.outcome.action, "allow", "only printf executes under this synthetic policy");
  assert.ok(f.wire.length > 0, "the actual deny-free child forwards the harmless Bash fragment");
  for (const { raw, parsed } of f.wire) {
    assert.equal(raw.accessIntent.requestedCommand, command);
    assert.equal(parsed.accessIntent.requestedCommand, command);
  }
  assert.ok(f.resolved.length > 0, "the real serving policy inspects complete requested source");
  for (const { check } of f.resolved)
    assert.notEqual(check.state, "deny", `no invented privilege floor: ${JSON.stringify(check)}`);
  assert.equal(f.served.length, 0, "parent yolo answers the remaining ordinary ask");
  assert.deepEqual(f.parent.recorded, []);
  assert.deepEqual(f.child.recorded, []);
});

test("a parent-only path privilege deny survives quoted executable forwarding and parent grants", async (t) => {
  const command = `'${privilegePath}' true`;
  const f = forwardingFixture(t, {
    config: config(privilegePathRule),
    yolo: true,
    grants: ["*", command, `${privilegePath} *`, "sudo *"],
  });
  const result = await f.call(command);
  assert.equal(result.outcome.action, "block");
  assert.equal(f.wire.length, 1, "the child's deny-free config must reach the actual parent edge");
  assert.equal(f.wire[0].raw.accessIntent.requestedCommand, command);
  assert.equal(f.wire[0].parsed.accessIntent.requestedCommand, command);
  assert.equal(f.resolved.length, 1, "the actual serving policy inspects the full request");
  assertPathPrivilegeDenied(f.resolved[0].check, command);
  assert.equal(f.served.length, 0);
  assert.deepEqual(f.parent.recorded, []);
  assert.deepEqual(f.child.recorded, []);
  assert.equal(f.responses.length, 1, "real JSON denial response");
  const response = f.responses[0];
  assert.equal(response.approved, false);
  assert.equal(response.decidedBy.kind, "rule");
  assert.equal(response.decidedBy.surface, "bash");
  assert.equal(response.decidedBy.origin, "global");
  assert.equal(response.decidedBy.pattern, privilegePathPattern);
  assert.equal(response.denialReason, privilegePathReason);
});

test("a forwarded exclusion without requested source cannot use parent grants or yolo", async (t) => {
  const f = forwardingFixture(t, { yolo: true, grants: ["*"], decision: unavailable });
  assert.equal((await f.call("fixture-command ordinary")).outcome.action, "allow");
  assert.equal(f.served.length, 0, "ordinary complete source is a positive yolo control");
  const base = f.wire[0].raw;
  const id = randomUUID();
  const { requestedCommand: _requestedCommand, ...facts } = base.accessIntent;
  const request = {
    ...base,
    id,
    accessIntent: {
      ...facts,
      staticAllowExclusion: {
        rule: "expanding-heredoc",
        unitText: "env wc -l <<EOF",
        word: "EOF",
      },
    },
  };
  mkdirSync(f.location.requestsDir, { recursive: true });
  const path = join(f.location.requestsDir, `${id}.json`);
  writeFileSync(path, JSON.stringify(request));
  const parsed = readForwardedPermissionRequest(null, path);
  assert.ok(parsed, "actual wire reader accepts the exclusion-only shape");
  assert.equal(parsed.invalidStaticAllowExclusion, undefined);
  await f.server.processInbox(f.parentCtx);
  const check = f.resolved.at(-1).check;
  assert.equal(check.state, "ask", "missing source cannot be auto-granted");
  assert.equal(check.origin, "fail-closed");
  assert.equal(f.served.length, 0, "missing full source must not reach any authorizer");
  assert.deepEqual(f.parent.recorded, []);
  assert.deepEqual(f.child.recorded, []);
  const response = readForwardedPermissionResponse(
    null,
    join(f.location.responsesDir, `${id}.json`),
  );
  assert.ok(response);
  assert.equal(response.approved, false, "uninspected full source cannot be authorized");
  assert.equal(response.decidedBy.kind, "gate_error");
  assert.match(
    response.decidedBy.reason,
    /full requested Bash execution source could not be completely inspected/,
  );
});

test("forwarding positive controls escalate, record real grants and preserve parent ordinary yolo", async (t) => {
  const f = forwardingFixture(t, { config: config({}) });
  const first = await f.call("fixture-command ordinary");
  assert.equal(first.outcome.action, "allow");
  assert.equal(f.wire.length, 1, "real child request was serialized");
  assert.equal(f.served.length, 1, "positive parent authorizer escalation control");
  assert.equal(f.parent.recorded.length, 1, "positive parent SessionRules recording control");
  assert.ok(f.parent.sessionRules.getRuleset().length > 0);
  assert.deepEqual(f.child.recorded, [], "serving-session choice records only in parent");
  assert.equal((await f.call("fixture-command ordinary")).outcome.action, "allow");
  assert.equal(f.served.length, 1, "parent's real session grant answers the retry");
  const yolo = forwardingFixture(t, { yolo: true });
  assert.equal((await yolo.call("fixture-command ordinary")).outcome.action, "allow");
  assert.equal(yolo.wire.length, 1);
  assert.equal(yolo.served.length, 0, "ordinary parent yolo still bypasses escalation");
  const exception = forwardingFixture(t, {
    yolo: true,
    config: config({ ...privilegeRules, "sudo true": "allow" }),
  });
  assert.equal((await exception.call("sudo true")).outcome.action, "allow");
  assert.equal(exception.wire.length, 1, "same-global exception exercised on the serving node");
  assert.equal(exception.served.length, 0);
});
