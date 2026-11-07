// Permission/classifier-only regressions. Every command below is data: no
// shell, Git, helper, network, model or human approval is executed. Load the
// rendered guard (with trusted worker policy), never its empty source template.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  fsCache: false,
  moduleCache: false,
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
  { default: staticGuard, inspectGitCommands, originalBashDeny },
  { hardCheckpointReason },
  { parseGitInvocation, gitInvocationNeedsHuman, hasDangerousGitEnvironmentPrefix },
  { PermissionManager },
  { PermissionResolver },
  { PathNormalizer },
  { posixPathFlavor },
  { PermissionSession },
  { PermissionGateHandler },
  { ToolCallGatePipeline },
  { resolveToolPreviewLimits },
  { GateRunner },
] = await Promise.all([
  jiti.import(join(packageRoot, "generated/extensions/static-safety-guard.ts")),
  jiti.import(join(packageRoot, "generated/extensions/lib/hard-checkpoint.ts")),
  jiti.import(join(packageRoot, "generated/extensions/lib/git-invocation.ts")),
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("path/path-normalizer"),
  load("path/path-flavor"),
  load("session/permission-session"),
  load("handlers/permission-gate-handler"),
  load("handlers/gates/tool-call-gate-pipeline"),
  load("tool-input/tool-preview-formatter"),
  load("handlers/gates/runner"),
]);
const root = mkdtempSync(join(tmpdir(), "alehouse-git-checkpoints-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
mkdirSync(join(cwd, "docs"));
writeFileSync(join(cwd, "existing.txt"), "synthetic fixture\n");
const savedEnv = { ...process.env };
delete process.env.PI_STATIC_SAFETY_SELFTEST;
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const seed = JSON.parse(
  readFileSync(join(packageRoot, "generated/seeds/permissions.json"), "utf8"),
);
const withBash = (bash) => ({
  ...seed,
  permission: { ...seed.permission, bash: { ...seed.permission.bash, ...bash } },
});
let serial = 0;
function guardOrchestration(config = seed) {
  const agentDir = join(root, `agent-${serial++}`);
  mkdirSync(join(agentDir, "extensions/pi-permission-system"), { recursive: true });
  mkdirSync(join(agentDir, "agents"));
  for (const name of ["editor", "researcher"])
    cpSync(
      join(packageRoot, "generated/agents", `${name}.md`),
      join(agentDir, "agents", `${name}.md`),
    );
  const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
  writeFileSync(configPath, JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const hooks = new Map(),
    bus = new Map(),
    published = [];
  staticGuard({
    on: (name, handler) => hooks.set(name, handler),
    events: {
      on: (name, handler) => {
        bus.set(name, handler);
        return () => bus.delete(name);
      },
      emit: (name, data) => published.push({ name, data }),
    },
  });
  const context = (agent) => ({
    cwd,
    getSystemPrompt: () => "Marker-free synthetic instructions.",
    sessionManager: {
      getSessionId: () => `git-checkpoints-${agentDir}`,
      getEntries: () =>
        agent ? [{ type: "custom", customType: "active_agent", data: { name: agent } }] : [],
    },
  });
  hooks.get("session_start")({}, context("editor"));
  bus.get("pi-alehouse:static-guard:probe")({
    sessionId: context("editor").sessionManager.getSessionId(),
    nonce: "fixture",
    profile: "editor",
  });
  assert.equal(
    published.length,
    0,
    "a standalone deny-only guard cannot acknowledge child readiness without the authority APIs",
  );
  const guard = (command, agent = "editor") => {
    const input = { command };
    const outcome = hooks.get("tool_call")({ toolName: "bash", input }, context(agent));
    assert.equal(input.command, command, "guard preserves exact command bytes");
    return outcome;
  };
  return { guard, context, agentDir, configPath };
}
const reason = (command) =>
  hardCheckpointReason(
    {
      command,
      payload: {
        kind: "bash",
        evidence: [],
        request: {
          surface: "bash",
          toolName: "bash",
          value: command,
          matchedPattern: "*",
          requester: { forwarded: false },
        },
      },
    },
    { name: "bash", arguments: { command } },
  );

// Real authority, with only the escalation answer stubbed. This deliberately
// does NOT invoke the static guard: it establishes the otherwise-ALLOW control,
// not a claim that a guard refusal is an ordinary permission result.
async function authority(command, h, { agent, yolo = false, grants = [] } = {}) {
  const manager = new PermissionManager({
    globalConfigPath: h.configPath,
    agentsDir: join(h.agentDir, "agents"),
    mcpServerNames: [],
    isYoloEnabled: () => yolo,
  });
  const resolver = new PermissionResolver(manager, { getRuleset: () => grants });
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const prompts = [];
  const runner = new GateRunner(
    resolver,
    { recordSessionApproval() {} },
    {
      async escalate(details) {
        prompts.push(details);
        return {
          approved: false,
          state: "denied",
          confirmationUnavailable: true,
          decidedBy: { kind: "unavailable", reason: "Synthetic no-UI fixture" },
        };
      },
    },
    { writeReviewLog() {}, emitDecision() {} },
    () => yolo,
  );
  const tools = [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }];
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
  const input = { command };
  const outcome = await handler.handleToolCall(
    { toolCallId: "synthetic-git", toolName: "bash", input },
    { ...h.context(agent), hasUI: false, ui: { notify() {} } },
  );
  assert.equal(input.command, command, "authority preserves exact command bytes");
  return { outcome, prompts };
}
// null explicitly selects the marker-free parent; undefined would use the
// guard helper's default editor identity.
const personas = [null, "editor"];
const dangerousKeys = [
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_PAGER",
  "PAGER",
  "GIT_EXEC_PATH",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "VISUAL",
  "GIT_PROXY_COMMAND",
];

test("selected requested environment overrides stay statically denied for parent and trusted editor", () => {
  for (const config of [seed, withBash({ "*": "allow", "git log --oneline": "deny" })]) {
    const h = guardOrchestration(config);
    for (const agent of personas) {
      for (const key of dangerousKeys) {
        assert.equal(
          hasDangerousGitEnvironmentPrefix([`${key}=./fixture`, "git", "status"]),
          true,
          key,
        );
        assert.equal(
          hasDangerousGitEnvironmentPrefix(["git", "status", "--", `${key}=./fixture`]),
          false,
          "argv DATA is not a prefix",
        );
        for (const command of [
          `${key}=./fixture git status`,
          `/usr/bin/env -i ${key}=./fixture /usr/bin/git status`,
          `command -p /usr/bin/env -- ${key}=./fixture git status`,
          `${key}='./fixture helper' git status`,
        ])
          assert.equal(h.guard(command, agent)?.block, true, `${agent}: ${command}`);
      }
      for (const command of [
        "PATH=$(pwd) git status",
        'PATH="`pwd`" git status',
        "timeout 5 /usr/bin/env GIT_EXTERNAL_DIFF=./fixture git diff",
        "env -u UNUSED -C . GIT_EDITOR=./fixture git status",
      ])
        assert.equal(h.guard(command, agent)?.block, true, command);
      assert.equal(
        h.guard("env PATH=./fixture-bin opaque-tool", agent),
        undefined,
        "no new non-Git environment ban",
      );
      for (const opaque of [
        "env --unknown PATH=./fixture git status",
        "env -S 'FOO=1 PATH=./fixture git status'",
      ]) {
        assert.equal(
          inspectGitCommands(opaque).length,
          0,
          "unsupported prefix is not proof of Git argv",
        );
      }
      assert.equal(h.guard("sudo true", agent)?.block, true, "seed global deny remains selected");
      if (config !== seed) {
        assert.equal(
          h.guard("env git log --oneline", agent)?.block,
          true,
          "custom global deny matches normalized Git",
        );
        assert.match(
          originalBashDeny("git log --oneline", h.context(agent), h.agentDir),
          /declarative Bash deny/,
        );
      }
    }
  }
});

test("static dangerous-prefix refusal survives authority ALLOW, session grants and seed-yolo", async () => {
  const commands = [
    "PATH=./fixture-bin git status",
    "LD_PRELOAD=./fixture.so git status",
    "GIT_EXTERNAL_DIFF=./fixture git diff",
    "EDITOR=./fixture git status",
    "VISUAL=./fixture git status",
    "GIT_PROXY_COMMAND=./fixture git status",
  ];
  // A global catch-all allow does not override editor's profile catch-all ask.
  // Exact complete-command allows are the real configured-ALLOW control.
  const seeded = guardOrchestration(),
    allowed = guardOrchestration(
      withBash(Object.fromEntries(commands.map((command) => [command, "allow"]))),
    );
  const grants = [
    { surface: "bash", pattern: "*", action: "allow", layer: "session", origin: "session" },
  ];
  for (const agent of personas)
    for (const command of commands)
      for (const [h, mode] of [
        [seeded, { yolo: true }],
        [seeded, { grants }],
        [allowed, {}],
      ]) {
        const control = await authority(command, h, { ...mode, agent });
        assert.equal(control.outcome.action, "allow", `otherwise allowed: ${command}`);
        assert.equal(control.prompts.length, 0, "no Jev/human escalation on the authority control");
        assert.equal(
          h.guard(command, agent)?.block,
          true,
          "separate deny-only tool hook still refuses",
        );
      }
});

test("absolute Git keeps its independent external gate while the prefix guard defeats an otherwise complete allow", async () => {
  const command = "/usr/bin/env GIT_EDITOR=./fixture /usr/bin/git status";
  const grants = [
    { surface: "bash", pattern: "*", action: "allow", layer: "session", origin: "session" },
  ];
  const permitExecutable = (config) => ({
    ...config,
    permission: {
      ...config.permission,
      external_directory: { ...config.permission.external_directory, "/usr/bin/git": "allow" },
    },
  });
  for (const agent of personas) {
    const seedOnly = guardOrchestration();
    const external = await authority(command, seedOnly, { agent, grants });
    assert.equal(
      external.outcome.action,
      "block",
      "a Bash grant alone is not external-directory approval",
    );
    assert.equal(external.prompts.length, 1);
    assert.equal(
      external.prompts[0].payload.request.surface,
      "external_directory",
      "the unknown executable effect uses the undirected surface",
    );
    assert.equal(external.prompts[0].payload.request.value, command);
    assert.equal(external.prompts[0].accessIntent.boundaryValue, "/usr/bin/git");
    const seeded = guardOrchestration(permitExecutable(seed));
    const allowed = guardOrchestration(permitExecutable(withBash({ [command]: "allow" })));
    const wrapper = await authority(command, allowed, { agent });
    assert.equal(
      wrapper.outcome.action,
      "block",
      "an exact config allow does not bypass the generic indirection floor",
    );
    assert.equal(wrapper.prompts.length, 1);
    assert.equal(wrapper.prompts[0].payload.request.surface, "bash");
    assert.equal(wrapper.prompts[0].payload.request.matchedPattern, "<indirection-bash-wrapper>");
    assert.equal(allowed.guard(command, agent)?.block, true);
    for (const [h, mode] of [
      [seeded, { yolo: true }],
      [seeded, { grants }],
    ]) {
      const control = await authority(command, h, { ...mode, agent });
      assert.equal(
        control.outcome.action,
        "allow",
        "fixture permits only the otherwise independent executable path",
      );
      assert.equal(control.prompts.length, 0);
      assert.equal(
        h.guard(command, agent)?.block,
        true,
        "the dangerous requested prefix remains a static refusal",
      );
    }
  }
});

test("benign assignments keep their facts and eligible-ask checkpoint without static refusal", () => {
  const h = guardOrchestration();
  for (const agent of personas)
    for (const command of [
      "LC_ALL=C git status",
      "FOO=1 git status",
      "env LC_ALL=C git status",
      "/usr/bin/env -- FOO=1 /usr/bin/git status",
      "FOO=1 command git status",
      "LC_ALL=$(pwd) git status",
      'env LC_ALL="$LOCALE" git status',
      "GIT_CONFIG_PARAMETERS=x git status",
      "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git status",
    ]) {
      assert.equal(h.guard(command, agent), undefined, command);
      const invocation = inspectGitCommands(command).find((item) => item.subcommand === "status");
      assert.equal(invocation?.hasEnvironmentAssignments, true, command);
      assert.equal(
        invocation.expansions,
        command.includes("$"),
        "prefix expansion metadata survives stripping",
      );
      assert.equal(
        reason(command),
        "high_impact_command",
        "eligible ask stays at the human checkpoint",
      );
    }
  for (const command of ["git status", "env git status", "/usr/bin/env -- /usr/bin/git status"]) {
    const [invocation] = inspectGitCommands(command);
    assert.equal(invocation.hasEnvironmentAssignments, false, command);
    assert.equal(reason(command), undefined, "a wrapper alone is not an assignment checkpoint");
  }
  for (const key of ["GIT_EDITOR", "EDITOR", "VISUAL", "GIT_PROXY_COMMAND"]) {
    const previous = process.env[key];
    try {
      process.env[key] = "./synthetic-inherited-helper";
      assert.equal(
        h.guard("git status"),
        undefined,
        "operator-inherited environment is not a requested prefix",
      );
      assert.equal(reason("git status"), undefined);
      assert.equal(
        process.env[key],
        "./synthetic-inherited-helper",
        "inherited environment stays untouched",
      );
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  assert.equal(
    h.guard("git -c core.pager=./fixture status"),
    undefined,
    "config remains manual, not a new static config ban",
  );
  const nonGit = guardOrchestration(withBash({ "node --version": "allow" }));
  assert.equal(
    nonGit.guard("PATH=./fixture-bin node --version")?.block,
    true,
    "existing non-Git inline-whitelist guard remains independent",
  );
  assert.equal(
    nonGit.guard("env PATH=./fixture-bin opaque-tool"),
    undefined,
    "opaque non-Git env still uses ordinary permission",
  );
});

test("selected destructive Git forms checkpoint; ordinary operations and option DATA do not", () => {
  for (const command of [
    "git checkout -- .",
    "git checkout .",
    "git checkout existing.txt",
    "git checkout topic",
    "git restore .",
    "git branch -df main",
    "git stash clear",
    "git update-ref -d refs/heads/main",
    "git filter-branch --all",
    "git checkout -qf main",
    "git checkout --force main",
    "git checkout -Btopic",
    "git branch -fd main",
    "git branch -d main",
    "git branch -D main",
    "git stash drop",
    "git reset --hard",
    "git clean -fd",
    "git push origin main",
    "git reflog delete HEAD@{1}",
    "git tag -d v1",
    "git -c core.pager=cat status",
    "git --unknown status",
    "git diff --ext-diff",
    "git log --textconv",
    "git diff --output=fixture.txt",
  ]) {
    assert.equal(
      gitInvocationNeedsHuman(inspectGitCommands(command)[0]),
      true,
      `shared helper: ${command}`,
    );
    assert.equal(reason(command), "high_impact_command", `full checkpoint: ${command}`);
  }
  const h = guardOrchestration();
  for (const command of [
    "git status",
    "git add existing.txt",
    "git commit -m fixture",
    "git checkout -",
    "git checkout -b topic",
    "git checkout -bfixture",
    "git checkout -qbfeature",
    "git branch --list",
    "git branch -rvv",
    "git branch main-data",
    "git branch -- -df",
    "git branch --list -- -d",
    "git branch --format -d",
    "git branch --sort -d",
    "git branch --format=-d",
    "git tag -- -d",
    "git stash list",
  ]) {
    assert.equal(
      gitInvocationNeedsHuman(inspectGitCommands(command)[0]),
      false,
      `shared helper: ${command}`,
    );
    assert.equal(reason(command), undefined, `full checkpoint: ${command}`);
    assert.equal(h.guard(command), undefined, "no reintroduced editor Git mutation ban");
  }
});

test("bounded destructive long-option prefixes checkpoint at OPTION positions, regardless of order or quoting", () => {
  for (const [subcommand, option, operands] of [
    ["reset", "--hard", ["HEAD"]],
    ["reset", "--merge", ["HEAD"]],
    ["clean", "--force", []],
    ["clean", "--interactive", []],
    ["checkout", "--force", []],
    ["checkout", "--patch", []],
    ["switch", "--discard-changes", ["topic"]],
    ["switch", "--force", ["topic"]],
    ["switch", "--force-create", ["topic"]],
    ["branch", "--force", ["topic"]],
    ["tag", "--force", ["t"]],
    ["tag", "--delete", ["t"]],
    ["branch", "--delete", ["topic"]],
    ["branch", "--delete-merged", ["*"]],
  ])
    for (let length = 3; length <= option.length; length++) {
      // Some short prefixes (notably branch --del) are ambiguous in Git 2.56.
      // Conservatively checkpointing is not a claim they execute or delete data.
      const words = ["git", subcommand, "-q", option.slice(0, length), ...operands];
      assert.equal(
        gitInvocationNeedsHuman(parseGitInvocation(words)),
        true,
        `shared helper: ${words}`,
      );
      assert.equal(
        reason(words.map((word) => `'${word}'`).join(" ")),
        "high_impact_command",
        `quoted full checkpoint: ${words}`,
      );
    }
  for (const command of [
    "git checkout --forc",
    "git checkout -p",
    "git checkout -qp",
    "git checkout -pq",
    "git checkout --patch",
    "git checkout --pat",
    `git checkout '--patch'`,
    "git reset --har HEAD",
    "git reset HEAD --har",
    "git tag --del t",
    "git tag t --del",
    "git branch --delete-merged '*'",
    "git branch -v --delete-merged '*'",
    "git branch -v --delete-merged='*'",
    "git branch topic -v --delete-merged '*'",
    "git branch --delete-mer '*' -v",
    "git branch --format -d --delete-merged '*'",
    "git branch --format -- --delete-merged '*'",
    "git tag --message -- --del t",
    `git checkout '--forc'`,
    `git reset '--har' HEAD`,
    `git tag '--del' t`,
    `git branch -v '--delete-merged' '*'`,
    `g'it' checkout '.'`,
    `git checkout 'topic name'`,
    "git checkout --pathspec-from-file=paths.txt",
  ]) {
    assert.equal(
      gitInvocationNeedsHuman(inspectGitCommands(command)[0]),
      true,
      `shared helper: ${command}`,
    );
    assert.equal(reason(command), "high_impact_command", `full checkpoint: ${command}`);
  }
});

test("context-valued patch groups and interactive/forced ref changes checkpoint without adding a worker deny", () => {
  const h = guardOrchestration();
  for (const command of [
    "git checkout -pU3",
    "git checkout -qpU3",
    "git checkout -U3 -p",
    "git checkout -p --unified=3",
    "git checkout --unified 3 -p",
    "git checkout --inter-hunk-context=3 -p",
    "git checkout -p --inter-hunk-context 3",
    "git clean -i",
    "git clean -qi",
    "git clean --interactive",
    "git clean --inter",
    "git reset --merge",
    "git reset HEAD --merge",
    "git switch -f topic",
    "git switch -qf topic",
    "git switch --discard-changes topic",
    "git switch -Ctopic",
    "git switch --force-create topic",
    "git branch -f topic",
    "git branch -Mf old new",
    "git branch -M old new",
    "git branch -C old new",
    "git branch --force topic",
    "git tag -f v1",
    "git tag --force v1",
    "git tag --for v1", // Ambiguous force/format prefix stays conservative.
  ]) {
    assert.equal(
      gitInvocationNeedsHuman(inspectGitCommands(command)[0]),
      true,
      `shared helper: ${command}`,
    );
    assert.equal(
      reason(command),
      "high_impact_command",
      `eligible ask must skip model-only approval: ${command}`,
    );
    assert.equal(
      h.guard(command),
      undefined,
      "a human checkpoint is not a new static worker Git deny",
    );
  }
});

test("checkpoint matching preserves terminators, required-value DATA and argv boundaries", () => {
  for (const command of [
    "git reset -- --hard",
    "git reset -- --har",
    "git reset --pathspec-from-file --hard",
    "git reset --pathspec-from-f '--har'",
    "git reset --harder",
    `git reset '--har HEAD'`,
    "git clean -- --forc",
    "git clean --exclude '--forc'",
    "git branch -- --delete",
    "git branch -- --delete-merged",
    "git branch --list -- '--delete-mer'",
    "git branch --format --delete-merged",
    "git branch --sort '--del'",
    "git branch --form '--delete'",
    "git branch --format=--delete-merged",
    "git branch --points-at --delete-merged",
    "git branch -u --delete-merged",
    "git branch --set-upstream-to=--delete-merged",
    "git branch --format --",
    "git tag -- --delete",
    "git tag -- --del",
    "git tag --format '--delete'",
    "git tag --sort '--del'",
    "git tag --form --del",
    "git tag -m --del",
    "git tag -m-d",
    "git tag --message=--del",
    "git tag --deletion",
    "git checkout --conflict --force",
    "git checkout --conf '--forc'",
    "git checkout -b --forc",
    "git checkout -qb --forc",
    "git checkout --orphan --forc",
    "git checkout -b --",
    "git checkout --",
    `git checkout '-'`,
    "git checkout -bpatch",
    "git checkout -qbpatch",
    "git checkout -b --patch",
    "git checkout --conflict '--patch'",
    "git checkout --conf '--pat'",
    "git checkout --conflict=--patch",
    "git checkout -U3",
    "git checkout --unified 3",
    "git checkout --inter-hunk-context 3",
    "git checkout -U --patch",
    "git checkout --unified --patch",
    "git checkout --inter-hunk-context --patch",
    "git clean --exclude -i",
    "git clean -einteractive",
    "git clean -- --interactive",
    "git clean --exclude --interactive",
    "git reset -- --merge",
    "git reset --pathspec-from-file --merge",
    "git switch -c topic",
    "git switch -c --discard-changes",
    "git switch -qc--force",
    "git switch --create=--force",
    "git switch --conflict --discard-changes",
    "git switch -- --discard-changes",
    "git branch --format -M",
    "git branch --sort --force",
    "git branch -- -M",
    "git tag -m-f",
    "git tag -F -f",
    "git tag --format --force",
    "git tag -- --force",
  ]) {
    const [invocation] = inspectGitCommands(command);
    assert(invocation, command);
    assert.equal(gitInvocationNeedsHuman(invocation), false, `shared helper: ${command}`);
    assert.equal(reason(command), undefined, `full checkpoint: ${command}`);
  }
  // The existing regex defense-in-depth can conservatively checkpoint these;
  // the argv helper must still preserve their DATA/terminator roles.
  for (const args of [["--", "--force"], ["-e", "--force"], ["-qe--force"]]) {
    assert.equal(
      gitInvocationNeedsHuman(parseGitInvocation(["git", "clean", ...args])),
      false,
      `clean DATA: ${args}`,
    );
  }
  assert.equal(
    gitInvocationNeedsHuman(parseGitInvocation(["git", "branch", "--delete-merged-extra"])),
    false,
    "not an option prefix",
  );
  assert.deepEqual(
    inspectGitCommands(`git tag --format '--del t'`)[0].args,
    ["--format", "--del t"],
    "never join and re-lex argv",
  );
});

test("destructive checkpoints apply only to eligible asks, not existing allows or yolo", async () => {
  const commands = [
    "git checkout existing.txt",
    "git checkout --patch",
    "git reset --har HEAD",
    "git tag --del t",
    "git branch -v --delete-merged '*'",
  ];
  const seeded = guardOrchestration(),
    allowed = guardOrchestration(
      withBash(Object.fromEntries(commands.map((command) => [command, "allow"]))),
    );
  for (const agent of personas)
    for (const command of commands) {
      assert.equal(reason(command), "high_impact_command", command);
      for (const [h, options] of [
        [seeded, { yolo: true }],
        [allowed, {}],
      ]) {
        const control = await authority(command, h, { ...options, agent });
        assert.equal(control.outcome.action, "allow", command);
        assert.equal(
          control.prompts.length,
          0,
          "existing allows/yolo never reach checkpoint review",
        );
        assert.equal(h.guard(command, agent), undefined, "checkpoint is not a static Git deny");
      }
    }
});

test("worker bare redirect remains conservative after cd even if the initial cwd filename exists", () => {
  const h = guardOrchestration();
  assert.equal(existsSync(join(cwd, "existing.txt")), true);
  assert.equal(existsSync(join(cwd, "docs")), true, "cd names an existing directory");
  assert.equal(
    existsSync(join(cwd, "docs/existing.txt")),
    false,
    "bare target is new after the valid cd",
  );
  assert.equal(
    h.guard("echo ok >existing.txt"),
    undefined,
    "unmutated cwd with an existing target is the negative control",
  );
  assert.equal(h.guard("echo ok >missing.txt")?.block, true, "new bare filename remains refused");
  assert.equal(
    h.guard("cd docs && echo ok >existing.txt")?.block,
    true,
    "changesCwd must defeat the initial-cwd exists shortcut",
  );
  assert.equal(
    h.guard("cd docs && echo ok >./existing.txt"),
    undefined,
    "explicit spelling retains the ordinary path gate",
  );
  assert.equal(
    readFileSync(join(cwd, "existing.txt"), "utf8"),
    "synthetic fixture\n",
    "commands were never executed",
  );
});
