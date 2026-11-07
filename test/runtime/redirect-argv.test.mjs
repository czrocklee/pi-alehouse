// Bash passes words after a redirect destination (`cmd 2>/dev/null a b`, and
// `cmd <<EOF a`) to the command, while the pinned AST buries them in the
// redirect node. They keep the owning command's roles, and its completed
// spelling can restrict but never allow the unit. Dynamic `cd`, including ~,
// stays an unknown base: no HOME-stability proof. Commands are fixture data;
// this file does not start a shell.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test, after } from "node:test";
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
  { PermissionSession },
  { PermissionGateHandler },
  { ToolCallGatePipeline },
  { resolveToolPreviewLimits },
  { GateRunner },
  { BashProgram },
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
]);

const root = mkdtempSync(join(tmpdir(), "alehouse-redirect-argv-"));
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "agents"), { recursive: true });
cpSync(join(packageRoot, "runtime/agents/editor.md"), join(agentDir, "agents/editor.md"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const shipped = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
const withBash = (bash) => ({
  ...shipped,
  permission: { ...shipped.permission, bash: { ...shipped.permission.bash, ...bash } },
});

const workspace = () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  for (const name of ["notes.txt", "ordinary.txt", ".env", "in.txt"])
    writeFileSync(join(cwd, name), "fixture\n");
  return cwd;
};
const unavailable = {
  approved: false,
  state: "denied",
  confirmationUnavailable: true,
  decidedBy: { kind: "unavailable", reason: "No live authority was reachable for this session" },
};
let configs = 0;
async function captureHandler(
  cwd,
  command,
  {
    agent = "editor",
    config = shipped,
    yolo = false,
    managerOptions = {},
    decision = unavailable,
  } = {},
) {
  const configFile = join(root, `config-${configs++}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const manager = new PermissionManager({
    globalConfigPath: configFile,
    agentsDir: join(agentDir, "agents"),
    mcpServerNames: [],
    ...managerOptions,
    ...(yolo ? { isYoloEnabled: () => true } : {}),
  });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const prompts = [],
    approvals = [],
    decisions = [],
    reviewLogs = [];
  const runner = new GateRunner(
    resolver,
    {
      recordSessionApproval(approval) {
        approvals.push(approval.toForwardedData());
      },
    },
    {
      async escalate(details) {
        prompts.push(details);
        return decision;
      },
    },
    {
      writeReviewLog(event, details) {
        reviewLogs.push({ event, details });
      },
      emitDecision(facts) {
        decisions.push(facts);
      },
    },
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
  const input = { command };
  const entries = agent
    ? [{ type: "custom", customType: "active_agent", data: { name: agent } }]
    : [];
  const outcome = await handler.handleToolCall(
    { toolCallId: "redirect-argv", toolName: "bash", input },
    {
      cwd,
      hasUI: false,
      ui: { notify() {} },
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
        getSessionId: () => "redirect-argv",
      },
    },
  );
  assert.equal(input.command, command, "permission only: the command is never rewritten");
  const state =
    outcome.action === "allow"
      ? "allow"
      : /requires approval/.test(outcome.reason ?? "")
        ? "ask"
        : /Denied by policy/.test(outcome.reason ?? "")
          ? `deny ${/Denied by policy: '(\w+)'/.exec(outcome.reason)?.[1]}`
          : outcome.reason;
  return { state, outcome, input, prompts, approvals, decisions, reviewLogs, resolver };
}
const runHandler = async (cwd, command, options = {}) =>
  (await captureHandler(cwd, command, options)).state;
const effects = async (cwd, command) =>
  (await BashProgram.parse(command, new PathNormalizer(posixPathFlavor, cwd)))
    .pathRuleCandidates()
    .map((candidate) => [candidate.token, candidate.effect.effect]);

// Exercise actual configuration layers, not a mocked resolver. Project-agent
// files deliberately keep the admitted internal editor identity.
function scopedBash(scope, rules) {
  if (scope === "global") return { config: withBash(rules) };
  const dir = mkdtempSync(join(root, `scope-${scope}-`));
  const config = withBash({ "npm*": "allow", "kubectl*": "allow" });
  if (scope === "project") {
    const projectGlobalConfigPath = join(dir, "project.json");
    writeFileSync(projectGlobalConfigPath, JSON.stringify({ permission: { bash: rules } }));
    return { config, managerOptions: { projectGlobalConfigPath } };
  }
  const projectAgentsDir = join(dir, "agents");
  mkdirSync(projectAgentsDir);
  writeFileSync(
    join(projectAgentsDir, "editor.md"),
    [
      "---",
      "permission:",
      "  bash:",
      ...Object.entries(rules).map(
        ([pattern, action]) => `    ${JSON.stringify(pattern)}: ${action}`,
      ),
      "---",
      "",
    ].join("\n"),
  );
  return { config, managerOptions: { projectAgentsDir } };
}
const bashDecisions = (result) => result.decisions.filter((fact) => fact.surface === "bash");
const decidingRule = (result) =>
  bashDecisions(result).map(({ value, matchedPattern, origin, result: action }) => ({
    value,
    matchedPattern,
    origin,
    result: action,
  }));

test("completed npm/kubectl argv keeps specific scoped denies/asks without flattening narrow allows", async () => {
  const cwd = workspace();
  for (const scope of ["global", "project", "project-agent"]) {
    for (const [plain, redirected, broad] of [
      ["npm publish x", "npm 2>/dev/null publish x", "npm*"],
      ["kubectl delete pod x", "kubectl 2>/dev/null delete pod x", "kubectl*"],
    ])
      for (const action of ["deny", "ask"]) {
        const fixture = scopedBash(scope, { [broad]: "allow", [plain]: action });
        const control = await captureHandler(cwd, plain, fixture);
        const redirectedResult = await captureHandler(cwd, redirected, fixture);
        assert.equal(control.state, action === "deny" ? "deny bash" : "ask", `${scope}: ${plain}`);
        assert.equal(redirectedResult.state, control.state, `${scope}: ${redirected}`);
        assert.deepEqual(decidingRule(control), [
          { value: plain, matchedPattern: plain, origin: scope, result: "deny" },
        ]);
        assert.deepEqual(
          decidingRule(redirectedResult),
          decidingRule(control),
          "same deciding command, exact rule and real scope",
        );
        assert.deepEqual(redirectedResult.approvals, []);
        if (action === "deny") {
          assert.deepEqual(redirectedResult.prompts, []);
          const yolo = await captureHandler(cwd, redirected, { ...fixture, yolo: true });
          assert.equal(yolo.state, "deny bash", "selected specific deny survives yolo");
          assert.deepEqual(yolo.prompts, []);
        } else {
          assert.equal(control.prompts.length, 1);
          assert.equal(redirectedResult.prompts.length, 1);
          const prompt = redirectedResult.prompts[0];
          assert.equal(prompt.payload.request.value, plain);
          assert.equal(prompt.payload.request.matchedPattern, plain);
          assert.deepEqual(prompt.accessIntent, {
            surface: "bash",
            matchValues: [plain],
            boundaryValue: null,
          });
          assert.deepEqual(prompt.payload.evidence, [
            { label: "full command", text: redirected, detail: null },
          ]);
        }
      }
    const fixture = scopedBash(scope, { "npm*": "deny", "npm publish x": "allow" });
    const allowed = await captureHandler(cwd, "npm publish x", fixture);
    assert.equal(
      allowed.state,
      "allow",
      "ordinary same-scope rules are not flattened to deny-only restrictions",
    );
    assert.deepEqual(decidingRule(allowed), [
      { value: "npm publish x", matchedPattern: "npm publish x", origin: scope, result: "allow" },
    ]);
    assert.deepEqual(allowed.prompts, []);
    const denied = await captureHandler(cwd, "npm install x", fixture);
    assert.equal(denied.state, "deny bash");
    assert.deepEqual(decidingRule(denied), [
      { value: "npm install x", matchedPattern: "npm*", origin: scope, result: "deny" },
    ]);
    const gitFixture = scopedBash(scope, { "git *": "deny", "git status*": "allow" });
    for (const command of ["git status --short", "git status --short 2>/dev/null"]) {
      const result = await captureHandler(cwd, command, gitFixture);
      assert.equal(result.state, "allow", `${scope}: redirected narrow allow remains effective`);
      assert.deepEqual(result.prompts, []);
      assert.deepEqual(decidingRule(result), [
        {
          value: "git status --short",
          matchedPattern: "git status*",
          origin: scope,
          result: "allow",
        },
      ]);
    }
  }
});

test("redirect-completed Git ask and synthetic session approval name the full command, not git", async () => {
  const cwd = workspace(),
    command = "git 2>/dev/null push origin main",
    completed = "git push origin main";
  const grants = { grants: [{ surface: "bash", pattern: "git push *" }] };
  const plain = await captureHandler(cwd, completed);
  assert.equal(plain.state, "ask");
  const unavailableResult = await captureHandler(cwd, command);
  assert.equal(unavailableResult.state, "ask");
  assert.equal(unavailableResult.prompts.length, 1);
  const prompt = unavailableResult.prompts[0];
  assert.equal(prompt.payload.kind, "bash");
  assert.equal(prompt.agentName, "editor");
  assert.equal(prompt.toolName, "bash");
  assert.equal(prompt.payload.request.value, completed);
  assert.equal(prompt.payload.request.matchedPattern, "*");
  assert.deepEqual(prompt.accessIntent, {
    surface: "bash",
    matchValues: [completed],
    boundaryValue: null,
  });
  assert.equal(prompt.command, completed);
  assert.deepEqual(prompt.payload.evidence, [
    { label: "full command", text: command, detail: null },
  ]);
  assert.deepEqual(
    prompt.sessionApproval,
    grants,
    "forwardable grant covers the completed Git subcommand, never the bare git fragment",
  );
  assert.deepEqual(prompt.sessionApproval, plain.prompts[0].sessionApproval);
  assert.deepEqual(unavailableResult.approvals, []);
  assert.deepEqual(decidingRule(unavailableResult), decidingRule(plain));

  // A scripted authorizer answer drives the real GateRunner recorder; no
  // human prompt, forwarding transport, shell or Git process runs here.
  const approved = await captureHandler(cwd, command, {
    decision: {
      approved: true,
      state: "approved_for_session",
      decidedBy: { kind: "authorizer", name: "fixture", verdict: "allow", reason: null },
    },
  });
  assert.equal(approved.state, "allow");
  assert.equal(approved.prompts.length, 1);
  assert.equal(approved.prompts[0].payload.request.value, completed);
  assert.deepEqual(approved.prompts[0].sessionApproval, grants);
  assert.deepEqual(approved.approvals, [grants]);
  assert.equal(bashDecisions(approved)[0].value, completed);
});

test("fd duplication and a bare redirected ls preserve specific asks and exact completed values", async () => {
  const cwd = workspace();
  for (const [plain, redirected, broad] of [
    ["kubectl delete pod x", "kubectl 2>&1 delete pod x", "kubectl*"],
    ["ls", "ls 2>/dev/null", "ls*"],
  ]) {
    const config = withBash({ [broad]: "allow", [plain]: "ask" });
    const control = await captureHandler(cwd, plain, { config });
    const result = await captureHandler(cwd, redirected, { config });
    assert.equal(control.state, "ask");
    assert.equal(result.state, "ask");
    assert.deepEqual(decidingRule(result), decidingRule(control));
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].payload.request.value, plain);
    assert.equal(result.prompts[0].payload.request.matchedPattern, plain);
    assert.deepEqual(result.prompts[0].accessIntent, {
      surface: "bash",
      matchValues: [plain],
      boundaryValue: null,
    });
    assert.deepEqual(result.prompts[0].sessionApproval, control.prompts[0].sessionApproval);
    assert.deepEqual(result.approvals, []);
  }
  const config = withBash({ "kubectl*": "allow", "ls*": "allow", "kubectl delete pod x": "ask" });
  const plain = await captureHandler(cwd, "kubectl delete pod x; ls", { config });
  const mixed = await captureHandler(cwd, "kubectl 2>&1 delete pod x; ls 2>/dev/null", { config });
  assert.equal(mixed.state, "ask");
  assert.deepEqual(decidingRule(mixed), decidingRule(plain));
  assert.equal(mixed.prompts[0].payload.request.value, "kubectl delete pod x");
  assert.deepEqual(mixed.approvals, []);
});

test("ordinary editor cat and recursive grep retain READ bodies and the real null WRITE", async () => {
  const cwd = workspace();
  const config = withBash({ "cat*": "allow", "grep*": "allow" });
  config.permission.path_write = {
    ...config.permission.path_write,
    [join(cwd, "ordinary.txt")]: "deny",
    [cwd]: "deny",
  };
  for (const [plain, redirected, body] of [
    ["cat ordinary.txt", "cat 2>/dev/null ordinary.txt", "ordinary.txt"],
    ["grep -r x .", "grep 2>/dev/null -r x .", "."],
  ]) {
    assert.deepEqual(await effects(cwd, redirected), [
      [body, "read"],
      ["/dev/null", "write"],
    ]);
    assert.deepEqual(await effects(cwd, plain), [[body, "read"]]);
    const control = await captureHandler(cwd, plain, { config });
    const result = await captureHandler(cwd, redirected, { config });
    assert.equal(control.state, "allow");
    assert.equal(
      result.state,
      "allow",
      "body reads must not hit the deliberately denied body path_write rule",
    );
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.approvals, []);
    assert.equal(
      result.reviewLogs.some(({ event }) => event === "permission_request.auto_approved"),
      false,
      "ordinary explicit allows need no automatic-approval audit",
    );
    assert.equal(
      result.resolver.resolve({
        kind: "path-values",
        surface: "path_write",
        values: [join(cwd, body)],
        agentName: "editor",
      }).state,
      "deny",
      "the body write deny is a live rule, not a vacuous control",
    );
  }
});

test("a truncated exact allow cannot cover redirect-buried argv or hide a wrapper", async () => {
  const cwd = workspace();
  const config = withBash({
    sort: "allow",
    "sort *": "allow",
    "sort *--compress-program*": "deny",
    env: "allow",
    "env *": "allow",
  });
  assert.equal(
    await runHandler(cwd, "sort in.txt 2>/dev/null", { agent: "editor", config }),
    "allow",
  );
  assert.equal(
    await runHandler(cwd, "sort --compress-program=sh in.txt", { agent: "editor", config }),
    "deny bash",
  );
  assert.equal(
    await runHandler(cwd, "sort 2>/dev/null --compress-program=sh in.txt", {
      agent: "editor",
      config,
    }),
    "deny bash",
  );
  assert.equal(
    await runHandler(cwd, "sort 2>/dev/null --compress-program=sh in.txt | head", {
      agent: "editor",
      config,
    }),
    "deny bash",
  );
  // The completed `env sh -c id` is an indirection wrapper, floored to ask.
  assert.equal(
    await runHandler(cwd, "env 2>/dev/null sh -c id", { agent: "editor", config }),
    "ask",
  );
  assert.equal(
    await runHandler(cwd, "env 2>/dev/null sh -c id", { agent: "editor", config, yolo: true }),
    "allow",
  );
});

test("redirect-buried and heredoc-line operands keep the owning command's roles", async () => {
  const cwd = workspace();
  assert.deepEqual(await effects(cwd, "cat 2>/dev/null notes.txt"), [
    ["notes.txt", "read"],
    ["/dev/null", "write"],
  ]);
  assert.deepEqual(await effects(cwd, "cat 2>&- notes.txt"), [["notes.txt", "read"]]);
  assert.deepEqual(await effects(cwd, "cat <<EOF notes.txt\nhi\nEOF"), [["notes.txt", "read"]]);
  assert.deepEqual(await effects(cwd, "grep 2>/dev/null fixture notes.txt"), [
    ["notes.txt", "read"],
    ["/dev/null", "write"],
  ]);
  assert.deepEqual(await effects(cwd, "echo x | cat 2>/dev/null notes.txt"), [
    ["notes.txt", "read"],
    ["/dev/null", "write"],
  ]);
  // A retraction still sees the completed argv: `find -delete` is no read.
  assert.notEqual(new Map(await effects(cwd, "find 2>/dev/null . -delete")).get("."), "read");
  // The real destination remains a write; only the tail moves to its command.
  assert.deepEqual(await effects(cwd, "cat >./out.txt notes.txt"), [
    ["notes.txt", "read"],
    ["./out.txt", "write"],
  ]);
  for (const agent of [null, "editor"])
    for (const yolo of [false, true]) {
      for (const command of [
        "cat 2>/dev/null .env",
        "cat <<EOF .env\nhi\nEOF",
        "grep 2>/dev/null x .env",
      ])
        assert.equal(
          await runHandler(cwd, command, { agent, yolo }),
          "deny path_read",
          `${command} ${agent} ${yolo}`,
        );
    }
  // An ordinary tail is a read the command rule decides, not a false write.
  assert.equal(
    await runHandler(cwd, "cat 2>/dev/null notes.txt", {
      agent: "editor",
      config: withBash({ "cat *": "allow" }),
    }),
    "allow",
  );
});

test("home and other dynamic cd targets stay unknown, never folded from HOME", async (t) => {
  const cwd = workspace(),
    home = mkdtempSync(join(root, "home-"));
  mkdirSync(join(home, "vault"));
  writeFileSync(join(home, "vault", "key"), "fixture\n");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previous;
  });
  const config = {
    ...shipped,
    permission: {
      ...shipped.permission,
      path: { ...shipped.permission.path, [`${home}/vault/*`]: "deny" },
    },
  };
  for (const command of [
    "cd ~/vault && cat key",
    "cd ~ && cat vault/key",
    "cd ~/vault; cat key",
    "cd -- ~/vault && cat key",
    "export X=1; cd ~/vault && cat key",
    "unset X; cd ~/vault && cat key",
  ]) {
    assert.equal(await runHandler(cwd, command, { agent: "editor", config }), "ask", command);
    assert.equal(
      await runHandler(cwd, command, { agent: "editor", config, yolo: true }),
      "allow",
      "normal unknown-base ask is yolo-satisfiable",
    );
  }
  // Explicit absolute cd still enforces its actual path deny.
  assert.match(
    await runHandler(cwd, `cd ${home}/vault && cat key`, { agent: "editor", config, yolo: true }),
    /^deny path/,
  );
  // Quoted tilde, another user's home, HOME reassignment and code execution
  // also get no inferred login-home base.
  for (const command of [
    'cd "~/vault" && cat key',
    "cd ~root && cat key",
    "HOME=/tmp; cd ~/vault && cat key",
    "eval x=1; cd ~/vault && cat key",
    "f() { :; }; cd ~/vault && cat key",
    "declare -n r; cd ~/vault && cat key",
    "export 'HO''ME=/tmp'; cd ~/vault && cat key",
    "x=HO; y=ME; : $(( $x$y=1 )); cd ~/vault && cat key",
  ])
    assert.equal(
      await runHandler(cwd, command, { agent: "editor", config, yolo: true }),
      "allow",
      command,
    );
});
