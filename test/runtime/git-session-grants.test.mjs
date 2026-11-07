// Actual permission gate and SessionRules: approving a complete Git wrapper
// must not produce a second generic inner ask. Commands are data, never run.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "#src": join(packageRoot, "runtime/permission-system/vendor/src"),
  },
});
const load = (name) => jiti.import(`#src/${name}`);
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
] = await Promise.all([
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("path/path-normalizer"),
  load("path/path-flavor"),
  load("session/session-rules"),
  load("session/permission-session"),
  load("handlers/permission-gate-handler"),
  load("handlers/gates/tool-call-gate-pipeline"),
  load("tool-input/tool-preview-formatter"),
  load("handlers/gates/runner"),
]);
const root = mkdtempSync(join(tmpdir(), "alehouse-git-session-")),
  savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const cwd = join(root, "workspace"),
  agentDir = join(root, "agent");
mkdirSync(join(cwd, ".git"), { recursive: true });
mkdirSync(join(agentDir, "agents"), { recursive: true });
cpSync(join(packageRoot, "runtime/agents/editor.md"), join(agentDir, "agents/editor.md"));
writeFileSync(join(cwd, ".env"), "FAKE_SESSION_FIXTURE=synthetic\n");
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const key of Object.keys(process.env))
  if (/^(GIT_|LD_|DYLD_)/.test(key)) delete process.env[key];
delete process.env.CDPATH;
const seed = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
let serial = 0;
function fixture({
  agent = "editor",
  rules = {},
  grants = [],
  approve = false,
  invalid = false,
} = {}) {
  const configFile = join(root, `config-${serial++}.json`);
  writeFileSync(
    configFile,
    JSON.stringify({
      ...seed,
      permission: { ...seed.permission, bash: { ...seed.permission.bash, ...rules } },
    }),
  );
  const projectGlobalConfigPath = join(root, `project-${serial++}.json`);
  if (invalid) writeFileSync(projectGlobalConfigPath, "{invalid");
  const manager = new PermissionManager({
    globalConfigPath: configFile,
    agentsDir: join(agentDir, "agents"),
    mcpServerNames: [],
    ...(invalid ? { projectGlobalConfigPath } : {}),
  });
  const sessionRules = new SessionRules();
  for (const pattern of grants) sessionRules.approve("bash", pattern);
  const resolver = new PermissionResolver(manager, { getRuleset: () => sessionRules.getRuleset() });
  const prompts = [];
  const runner = new GateRunner(
    resolver,
    sessionRules,
    {
      async escalate(details) {
        prompts.push(details);
        return approve
          ? {
              approved: true,
              state: "approved_for_session",
              decidedBy: { kind: "user" },
              sessionGrantWidth: "proven",
            }
          : {
              approved: false,
              state: "denied",
              confirmationUnavailable: true,
              decidedBy: { kind: "unavailable", reason: "Synthetic permission-only fixture" },
            };
      },
    },
    { writeReviewLog() {}, emitDecision() {} },
    () => false,
  );
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const session = new PermissionSession(
    {},
    { start() {}, stop() {} },
    manager,
    {},
    {},
    { activate() {}, deactivate() {} },
    posixPathFlavor,
  );
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
      getSessionId: () => "git-session",
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };
  assert.equal(
    session.resolveAgentName(ctx),
    agent,
    "exercise the actual parent/editor identity, not a defaulted fixture label",
  );
  return {
    prompts,
    sessionRules,
    async call(command) {
      const input = { command },
        before = prompts.length;
      const outcome = await handler.handleToolCall(
        { toolCallId: `git-session-${serial++}`, toolName: "bash", input },
        ctx,
      );
      assert.equal(input.command, command, "no execution rewrite");
      return { outcome, prompts: prompts.slice(before) };
    },
  };
}

for (const agent of [null, "editor"]) {
  test(`complete env Git session grants are effective without authorizing the inner spelling: ${agent ?? "parent"}`, async () => {
    const command = "env git status --short";
    const ordinary = await fixture({ agent }).call(command);
    assert.equal(ordinary.outcome.action, "block");
    assert.equal(ordinary.prompts.length, 1);
    assert.equal(ordinary.prompts[0].agentName, agent);
    for (const pattern of [command, "env *"]) {
      const approved = await fixture({ agent, grants: [pattern] }).call(command);
      assert.equal(approved.outcome.action, "allow", pattern);
      assert.equal(approved.prompts.length, 0, "no second inner catch-all ask");
    }
    const innerOnly = await fixture({ agent, grants: ["git status --short"] }).call(command);
    assert.equal(
      innerOnly.outcome.action,
      "block",
      "a grant to the inner spelling is not approval of an env wrapper",
    );
    assert.equal(innerOnly.prompts.length, 1);
  });

  test(`real approved-for-session record satisfies retry, including selected inner asks: ${agent ?? "parent"}`, async () => {
    for (const [command, rules] of [
      ["env git status --short", {}],
      ["env git status --short", { "git status --short": "ask" }],
      ["env git --version", { "git --version": "ask" }],
    ]) {
      const f = fixture({ agent, rules, approve: true });
      const first = await f.call(command);
      assert.equal(first.outcome.action, "allow");
      assert.equal(first.prompts.length, 1);
      assert.equal(first.prompts[0].payload.request.value, command);
      assert.deepEqual(
        f.sessionRules
          .getRuleset()
          .map((rule) => ({ surface: rule.surface, pattern: rule.pattern })),
        [{ surface: "bash", pattern: "env *" }],
      );
      const retry = await f.call(command);
      assert.equal(retry.outcome.action, "allow");
      assert.equal(
        retry.prompts.length,
        0,
        "actual recorded approval is sufficient on the second call",
      );
      const preGranted = await fixture({ agent, rules, grants: [command] }).call(command);
      assert.equal(
        preGranted.outcome.action,
        "allow",
        "an exact complete-unit grant also satisfies the selected inner ask",
      );
      assert.equal(preGranted.prompts.length, 0);
    }
  });

  test(`complete wrapper approval cannot erase configured deny, path deny or invalid configuration: ${agent ?? "parent"}`, async () => {
    for (const [command, rules] of [
      ["env git status --short", { "git status --short": "deny" }],
      ["env git status --short", { "env git status --short": "deny" }],
      ["env git --version", { "git --version": "deny" }],
    ]) {
      const result = await fixture({ agent, rules, grants: ["env *", "git *"] }).call(command);
      assert.equal(result.outcome.action, "block");
      assert.equal(result.prompts.length, 0, "configured deny remains final");
    }
    const secret = await fixture({ agent, grants: ["env *", "git *"] }).call(
      "env git show HEAD:.env",
    );
    assert.equal(secret.outcome.action, "block");
    assert.equal(secret.prompts.length, 0, "Bash approval does not skip directional READ deny");
    for (const command of ["env git status --short", "env git --version"]) {
      const invalid = await fixture({ agent, invalid: true, grants: ["env *", "git *"] }).call(
        command,
      );
      assert.equal(invalid.outcome.action, "block");
      assert.ok(
        invalid.prompts.length > 0,
        "fail-closed ask is not a satisfiable inner ordinary ask",
      );
    }
  });

  test(`truncated wrapper approval cannot authorize redirect-buried argv: ${agent ?? "parent"}`, async () => {
    const result = await fixture({ agent, grants: ["env git"] }).call(
      "env git 2>/dev/null push origin main",
    );
    assert.equal(result.outcome.action, "block");
    assert.ok(result.prompts.length > 0);
  });
}
