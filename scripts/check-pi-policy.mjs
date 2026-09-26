// Exercise the installed permission system's real parser and gate policy.
// Commands are parsed as data; none are executed and fixtures contain no secrets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [root, piExecutable, resources] = process.argv.slice(2);
assert(root && piExecutable && resources, "Usage: node check-pi-policy.mjs REPO PI_EXECUTABLE GENERATED_RESOURCES");
const require = createRequire(realpathSync(piExecutable));
const { createJiti } = require("jiti");
let piRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(piRoot, "package.json"))) {
  const parent = dirname(piRoot);
  assert.notEqual(parent, piRoot, "Cannot locate Pi package root");
  piRoot = parent;
}
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"), typebox: require.resolve("typebox") },
});
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(packageRoot, "Tests require the built managed permission-system closure");
const upstreamVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
// These internal interfaces are deliberately checked against the live install;
// API drift must fail this gate rather than silently substitute mock semantics.
const load = (name) => jiti.import(join(packageRoot, "src", `${name}.ts`));
const [
  { BashProgram }, { PermissionManager }, { PermissionResolver }, { PathNormalizer },
  { posixPathFlavor }, { resolveBashCommandCheck }, { describeBashPathGate },
  { describeBashExternalDirectoryGate },
] = await Promise.all([
  load("access-intent/bash/program"), load("policy/permission-manager"),
  load("policy/permission-resolver"), load("path/path-normalizer"),
  load("path/path-flavor"), load("handlers/gates/bash-command"),
  load("handlers/gates/bash-path"), load("handlers/gates/bash-external-directory"),
]);

const configPath = join(resources, "extensions/pi-permission-system/config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
// These explicit test-only Bash allowances exercise fixed-command matching,
// while reader wildcards must still pass independent path/external gates.
// Other read-only Git forms below rely on managed proof, not blanket patterns.
const fixedCommands = ["git status --short", "mktemp -d", "pwd"];
assert.deepEqual(config.piInfrastructureReadPaths, [], "No deployment-specific infrastructure scope in the fixture");
assert.deepEqual(Object.keys(config.permission.external_directory_read).sort(),
  ["/proc/meminfo", "/proc/self/mountinfo"].sort(), "Only synthetic regression metadata reads bypass external review");
const allowedPatterns = Object.entries(config.permission.bash)
  .filter(([, rule]) => rule === "allow" || rule?.action === "allow")
  .map(([pattern]) => pattern).sort();
assert.deepEqual(allowedPatterns, [...fixedCommands, "nl *", "sha256sum *", "echo *", "printf *", "ls *", "stat *", "rg --no-config *", "cd *", "head *", "wc *", "cat *", "tail *", "cut *", "tr *", "basename *", "dirname *", "readlink *", "realpath *", "uname *"].sort(), "Exact whitelist membership");

const scratch = mkdtempSync(join(tmpdir(), "pi-policy-test-"));
try {
  writeFileSync(join(scratch, ".env"), "FAKE_FIXTURE=not-a-real-secret\n");
  writeFileSync(join(scratch, "ordinary.txt"), "ordinary fixture\n");
  const manager = new PermissionManager({
    globalConfigPath: configPath, agentsDir: join(resources, "agents"), mcpServerNames: [],
  });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, scratch);
  assert.deepEqual(manager.getConfigIssues(), [], "Policy must load without fail-closed fallback");
  const check = async (command, agentName) => {
    const program = await BashProgram.parse(command, normalizer);
    const context = { toolCallId: "fixture", toolName: "bash", cwd: scratch, agentName };
    return {
      bash: resolveBashCommandCheck(command, program.commands(), agentName, resolver),
      path: describeBashPathGate(context, program, resolver, normalizer),
      external: describeBashExternalDirectoryGate(context, program, resolver, normalizer),
    };
  };
  const metadataQueries = ["git log -5 --oneline", "git log --oneline -n 20 HEAD", "git status --short -- ordinary.txt", "git status --short --ignored"].map(command => command.replace(/^git /, "git --no-lazy-fetch "));
  for (const agent of [undefined, "editor", "reader"]) {
    for (const command of metadataQueries) assert.equal((await check(command, agent)).bash.state, "allow", `Proven metadata query: ${agent}: ${command}`);
  }
  const readerCommands = ["nl -ba ordinary.txt", "sha256sum ordinary.txt", "sha256sum --tag ordinary.txt", "sha256sum - < ordinary.txt", "echo ok", "printf 'exit=%s\\n' \"$?\"", "head -45 ordinary.txt", "head ordinary.txt", "wc ordinary.txt", "wc -l -c ordinary.txt", "head -n 10 < ordinary.txt", "cat -n ordinary.txt", "tail -n 20 ordinary.txt", "cut -d : -f 1 ordinary.txt", "tr a-z A-Z < ordinary.txt", "tr '[:upper:]' '[:lower:]' < ordinary.txt", "basename ordinary.txt", "dirname ordinary.txt", "readlink ordinary.txt", "realpath ordinary.txt", "uname -m", "ls -la .", "stat ordinary.txt", "rg --no-config -n -d 0 -- fixture ordinary.txt", "rg --no-config -F -d 0 -- fixture ordinary.txt", "rg --no-config -n -d 0 -- '[ab]*$|x(y)' ordinary.txt", "rg --no-config -d 0 -- 'fixture with spaces' ordinary.txt", "rg --no-config --files --hidden -g '*.txt' -- .", "rg --no-config -- fixture - < ordinary.txt"];
  for (const command of [...fixedCommands, ...readerCommands, "cd .", `cd '${scratch}'`]) {
    const result = await check(command);
    assert.equal(result.bash.state, "allow", `Static allow: ${command}`);
    assert.equal(result.path, null, `No unexpected path gate: ${command}`);
    assert(!result.external || result.external.action === "allow", `No unexpected external ask: ${command}`);
  }
  for (const command of [
    "promtool --version", "sleep 5", "date --iso-8601=seconds",
    "git diff --stat --output=ordinary.txt",
    "git diff --stat --ext-diff", "node --version -e 'process.exit()'",
    "python3 --version -c 'print(1)'",
    "git push origin main", "git commit -m fixture", "rg --pre cat fixture .",
    "sort -o ordinary.txt", "sort --compress-program=fixture", "uniq ordinary.txt output.txt", "env printf -v PATH fixture", "env sha256sum --check sums", "date -s tomorrow", "sleep 300", "git rev-parse --short HEAD extra", "rg fixture ordinary.txt",
    "sed -i s/a/b/ ordinary.txt", "find . -delete",
    "./ao build --clean", "./ao build --clean -p ./important-data",
    "./ao build --clean --path=./important-data", "/tmp/ao build --clean", "ao build --clean",
    "git status --short && git push origin main", "git status --short; touch ordinary.txt",
    "git status --short | tee ordinary.txt",
    "env PATH=./fixture-bin git status --short",
    "PATH=./fixture-bin; git status --short", "FOO=bar; pwd",
  ]) assert.equal((await check(command)).bash.state, "ask", `Non-whitelisted command must ask: ${command}`);
  assert.equal((await check("git status --short && git diff --check")).bash.state, "ask");
  assert.equal((await check("git status --short && sudo true")).bash.state, "deny");
  // The upstream Bash matcher strips inline assignments. The independent
  // static-safety-guard tool-entry regressions must block these exact cases;
  // an explicit `env` wrapper above provides the normal ask path instead.
  for (const command of [
    'wc -l <<< "$(PATH=/fixture git status --short)"',
    "wc -l <<EOF\n$(PATH=/fixture git status --short)\nEOF",
    "PATH=./fixture-bin git status --short",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./fixture-hook git status --short",
  ]) assert.equal((await check(command)).bash.state, "allow", "Upstream assignment-stripping contract");
  assert.equal((await check("git push origin main", "reader")).bash.state, "deny");
  assert.equal((await check("git commit --amend", "editor")).bash.state, "deny");
  for (const agent of ["editor", "reader"]) {
    assert.deepEqual(manager.getConfigIssues(agent), [], `Worker policy must load: ${agent}`);
    for (const tool of ["notify_parent", "ask_parent"]) {
      assert.equal(resolver.checkPermission(tool, {}, agent).state, "allow", `Internal communication: ${agent}: ${tool}`);
    }
    for (const tool of ["write", "edit"]) {
      assert.equal(resolver.checkPermission(tool, {}, agent).state, agent === "editor" ? "allow" : "deny", `Direct editing boundary: ${agent}: ${tool}`);
    }
    assert.equal((await check("printf '%s' fixture > ordinary.txt", agent)).path?.preCheck?.state, agent === "editor" ? undefined : "deny", `Worker path-write gate: ${agent}`);
    assert.equal((await check("printf '%s' fixture > ~/.pi/agent/settings.json", agent)).path?.preCheck?.state, "deny", `Worker self-write denial: ${agent}`);

    for (const command of [...fixedCommands, ...readerCommands, "cd ."]) {
      assert.equal((await check(command, agent)).bash.state, "allow", `Worker whitelist: ${agent}: ${command}`);
    }
    for (const command of ["git diff --stat --output=ordinary.txt", "node --version -e 'process.exit()'"]) {
      assert.equal((await check(command, agent)).bash.state, "ask", `Worker non-whitelist: ${agent}: ${command}`);
    }
    for (const command of ["git commit -m fixture", "git push origin main"]) {
      assert.equal((await check(command, agent)).bash.state, "deny", `Git mutations stay with the parent: ${agent}: ${command}`);
    }
    assert.equal((await check("sudo true", agent)).bash.state, "deny", `Worker privilege denial: ${agent}`);
    assert.equal((await check("rg --no-config -d 0 -- fixture .env", agent)).path?.preCheck?.state, "deny", `Worker rg secret path: ${agent}`);
    assert.equal((await check("cat /var/lib/pi-policy-fixture/input.txt", agent)).external?.preCheck?.state, "ask", `Worker external reader: ${agent}`);
  }

  // Even with the Bash gate allowed, redirection/file and external-directory
  // checks must still see the parser's effects and retain their own decisions.
  for (const command of ["nl -ba .env", "sha256sum .env", "echo ok > ~/.pi/agent/settings.json", "printf '%s' ok > ~/.pi/agent/settings.json", "rg --no-config -d 0 -- fixture .env", "cat .env", "tail .env", "cut -f 1 .env", "tr a-z A-Z < .env", "head .env", "wc -l .env", "head ~/.pi/agent/auth.json", "wc ~/.ssh/id_ed25519"]) {
    const result = await check(command);
    assert.equal(result.bash.state, "allow", `Reader static allow: ${command}`);
    assert.equal(result.path?.preCheck?.state, "deny", `Reader secret path denied: ${command}`);
  }
  for (const command of ["nl -ba /var/lib/pi-policy-fixture/input.txt", "sha256sum /var/lib/pi-policy-fixture/input.txt", "cat /var/lib/pi-policy-fixture/input.txt", "tail /var/lib/pi-policy-fixture/input.txt", "cut -f 1 /var/lib/pi-policy-fixture/input.txt", "rg --no-config -d 0 -- fixture /var/lib/pi-policy-fixture/input.txt"]) {
    const result = await check(command);
    assert.equal(result.bash.state, "allow", `External reader static allowance: ${command}`);
    assert.equal(result.external?.preCheck?.state, "ask", `External reader still asks: ${command}`);
  }
  const externalRead = await check("head /var/lib/pi-policy-fixture/input.txt");
  assert.equal(externalRead.external?.preCheck?.state, "ask", "Unknown external read remains an ask");
  const envRead = await check("wc -l < .env");
  assert.equal(envRead.bash.state, "allow");
  assert.equal(envRead.path?.preCheck?.state, "deny", "Env read remains denied");
  const selfWrite = await check("pwd > ~/.pi/agent/settings.json");
  assert.equal(selfWrite.path?.preCheck?.state, "deny", "Self-configuration write remains denied");
  const externalCd = await check("cd /var/lib/pi-policy-fixture");
  assert.equal(externalCd.bash.state, "allow");
  assert.equal(externalCd.external?.preCheck?.state, "ask", "Unknown external directory remains an ask");
  const externalChain = await check("cd /etc && git status --short");
  assert.equal(externalChain.bash.state, "allow");
  assert.equal(externalChain.external?.preCheck?.state, "ask", "Chained external directory remains an ask");
  for (const name of ["fixture-skill", "unlisted/vendor-skill"]) {
    assert.equal(resolver.checkPermission("skill", name).state, "allow");
  }
  for (const profile of ["editor", "reader"]) {
    assert.equal(resolver.checkPermission("spawn_agent", { profile, difficulty: 3, prompt: "fixture", description: "fixture" }).state, "allow");
  }
  for (const tool of ["resume_agent", "list_agents", "release_agent", "wait_runs", "read_run", "steer_run", "cancel_run", "post_update"]) {
    assert.equal(resolver.checkPermission(tool, {}).state, "allow", `Harness management: ${tool}`);
  }
  for (const old of ["subagent", "resume_subagent", "list_subagents", "release_subagent", "wait_subagents",
    "get_subagent_result", "steer_subagent", "cancel_subagent"]) {
    assert.equal(Object.hasOwn(config.permission, old), false, `No stale management allow: ${old}`);
  }

  // Real upstream gate production, including URL normalization and write policy.
  const { ToolCallGatePipeline } = await load("handlers/gates/tool-call-gate-pipeline");
  const pipeline = new ToolCallGatePipeline(resolver, {
    getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [],
    getToolPreviewLimits: () => ({}), getPathNormalizer: () => normalizer,
    getShellToolAliases: () => undefined,
  });
  const gatesFor = async (toolName, input, agentName) => {
    const gates = [];
    await pipeline.evaluate({ toolCallId: "real-fixture", toolName, input, cwd: scratch, agentName }, {
      run: async (gate) => { if (gate) gates.push(gate); return { action: "allow" }; },
    });
    return gates;
  };
  // Evaluate with no guard at all. Neither content output nor executable diff
  // may inherit an allow from a broad metadata pattern if an extension fails.
  const uncheckedGit = ["git show HEAD", "git show HEAD:.env", "git show -s", "git show -s HEAD", "git show deadbeef", "git log -p -1 --ext-diff", "GIT_EXTERNAL_DIFF=./x.sh git log -p -1 --ext-diff"];
  for (const agent of [undefined, "editor", "reader"]) {
    for (const command of uncheckedGit) {
      assert.equal((await check(command, agent)).bash.state, "ask", `No guard parser: ${agent}:${command}`);
      const gate = (await gatesFor("bash", { command }, agent)).find((gate) => gate.surface === "bash");
      assert.equal(gate?.preCheck?.state, "ask", `No guard pipeline: ${agent}:${command}`);
    }
  }
  // Test Luna against upstream payloads, not a guessed request.value shape.
  const { default: lunaAutoApproval, hardCheckpointReason } = await jiti.import(join(resources, "extensions/luna-auto-approval.ts"));
  {
    // The approval indicator's protocol: Luna publishes every mode, keeps its
    // own status only while nobody renders it, and applies a well-formed request
    // through the same transition as /auto-approval.
    const hooks = new Map(), listeners = new Map(), statuses = [], published = [];
    const events = {
      on: (name, fn) => { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); return () => {}; },
      emit: (name, data) => { for (const fn of listeners.get(name) ?? []) fn(data); published.push({ name, data: { ...data } }); },
    };
    const previousMode = process.env.PI_AUTO_APPROVAL_MODE, previousHome = process.env.HOME;
    process.env.PI_AUTO_APPROVAL_MODE = "enforce-subagents";
    process.env.HOME = scratch; // Luna's audit log lands in the fixture, never the real home.
    try {
      lunaAutoApproval({ on: (name, fn) => hooks.set(name, fn), registerCommand() {}, registerTool() {}, events });
      const ctx = { cwd: scratch, hasUI: true, mode: "tui", ui: { setStatus: (key, value) => statuses.push([key, value]), notify() {} },
        sessionManager: { getSessionId: () => "luna-protocol", getHeader: () => ({}), getBranch: () => [], getSessionFile: () => undefined } };
      await hooks.get("session_start")({}, ctx);
      assert.deepEqual(published.at(-1), { name: "approval:judge-state",
        data: { judge: "luna", mode: "enforce", includeSubagents: true, sessionId: "luna-protocol", shown: false } });
      assert.deepEqual(statuses.at(-1), ["luna-auto-approval", "auto: ENFORCE+SUB"], "Unclaimed, Luna keeps its status");
      events.on("approval:judge-state", (state) => { state.shown = true; });
      const request = (mode, includeSubagents) => {
        const data = { mode, includeSubagents, applied: false };
        for (const fn of listeners.get("approval:set-judge") ?? []) fn(data);
        return data.applied;
      };
      assert.equal(request("shadow", true), false, "Shadow cannot cover subagents");
      assert.equal(request("yolo", false), false, "Yolo is not a judge mode");
      assert.equal(request("shadow", false), true);
      assert.deepEqual(published.at(-1).data, { judge: "luna", mode: "shadow", includeSubagents: false, sessionId: "luna-protocol", shown: true });
      assert.deepEqual(statuses.at(-1), ["luna-auto-approval", undefined], "A rendering indicator replaces Luna's status");
    } finally {
      process.env.PI_AUTO_APPROVAL_MODE = previousMode;
      process.env.HOME = previousHome;
      await hooks.get("session_shutdown")?.({}, {});
    }
    console.log("PASS: Luna publishes its mode and applies approval-indicator requests");
  }
  const { inspectGitCommands } = await jiti.import(join(resources, "extensions/static-safety-guard.ts"));
  const { SessionRules } = await load("session/session-rules");
  for (const command of [...uncheckedGit, "env git show HEAD", "env git show HEAD:.env"]) {
    const gate = (await gatesFor("bash", { command })).find((gate) => gate.surface === "bash");
    assert(gate, `Git query requires review: ${command}`);
    assert(hardCheckpointReason({ ...gate.promptDetails, payload: gate.payload }), `Git content cannot reach automatic approval: ${command}`);
  }
  for (const agent of [undefined, "editor", "reader"]) {
    for (const toolName of ["read", "write", "edit", "ls", "find", "grep"]) {
      for (const path of ["file:///home/fixture/.ssh/id_fixture", "@file:///home/fixture/.ssh/id_fixture", "file:///home/fixture/.ssh/id_fixture.env.example", "file:///home/fixture/.ssh/id_fixture.key"]) {
        assert((await gatesFor(toolName, { path }, agent)).some((gate) => gate.preCheck?.state === "deny"), `URL denied without static guard: ${agent}:${toolName}:${path}`);
      }
    }
    for (const path of [".git", ".git/config", ".git/HEAD", ".git/refs/heads/main", "~/.gitconfig", "~/.config/git/config"]) {
      assert((await gatesFor("write", { path, content: "fixture" }, agent)).some((gate) => gate.preCheck?.state === "deny"), `Direct Git control write denied: ${agent}:${path}`);
    }
    for (const command of ["echo fixture > .git/HEAD", "echo fixture > .git/config"]) {
      assert.equal((await check(command, agent)).path?.preCheck?.state, "deny", `Git control redirection: ${agent}:${command}`);
    }
  }
  const { resolveToCwd } = await import(join(piRoot, "dist/core/tools/path-utils.js"));
  assert.equal(resolveToCwd("file:///home/fixture/.ssh/id_fixture", scratch), "/home/fixture/.ssh/id_fixture");
  for (const scheme of ["FILE", "FiLe"]) {
    assert.equal(resolveToCwd(`${scheme}:///home/fixture/.ssh/id_fixture`, scratch), join(scratch, `${scheme}:/home/fixture/.ssh/id_fixture`), "Uppercase schemes are literal relative paths in this SDK; normalization changes require policy review");
  }
  for (const toolName of ["web_search", "fetch_content"]) {
    const first = (await gatesFor(toolName, { query: "alpha", url: "https://example.invalid/a" })).find((gate) => gate.surface === toolName);
    const second = (await gatesFor(toolName, { query: "beta", url: "https://example.invalid/b" })).find((gate) => gate.surface === toolName);
    assert.equal(first.payload.request.value, second.payload.request.value);
    assert.notDeepEqual(first.payload.evidence, second.payload.evidence, "A gate unit alone does not identify a tool action");
  }
  const gitEnv = { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
  const gitDir = join(scratch, "git-fixture"); mkdirSync(gitDir);
  const git = (...args) => spawnSync("git", ["-C", gitDir, ...args], { env: gitEnv, encoding: "utf8", timeout: 5000 });
  assert.equal(git("init", "-q").status, 0);
  writeFileSync(join(gitDir, "fixture.txt"), "BLOB_FIXTURE_CONTENT\n");
  const blob = git("hash-object", "-w", "fixture.txt").stdout.trim();
  writeFileSync(join(gitDir, ".git/HEAD"), `${blob}\n`);
  assert.match(git("show", "-s").stdout, /BLOB_FIXTURE_CONTENT/);
  assert.match(git("show", "-s", "HEAD").stdout, /BLOB_FIXTURE_CONTENT/);
  for (const revision of ["HEAD^0", "HEAD~0", "HEAD^{commit}"]) {
    const result = git("show", "-s", revision);
    assert.notEqual(result.status, 0); assert(!result.stdout.includes("BLOB_FIXTURE_CONTENT"));
  }
  writeFileSync(join(gitDir, ".git/HEAD"), "ref: refs/heads/main\n");
  const marker = join(gitDir, "fsmonitor-ran");
  const hook = join(gitDir, "fixture-monitor.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o700 });
  assert.equal(git("config", "core.fsmonitor", hook).status, 0);
  git("status", "--short");
  assert(existsSync(marker), "Git status can execute configured fsmonitor; it is not inherently side-effect-free");
  assert.match(git("-P", "show", "-s", blob).stdout, /BLOB_FIXTURE_CONTENT/);
  const prefixedShows = [
    `git -P show -s ${blob}`, `git -p show -s ${blob}`, `git -C . show -s ${blob}`,
    `git --no-pager show -s ${blob}`, `git --bare show -s ${blob}`,
    `git -C . -P show -s ${blob}`, `git -P -C . show -s ${blob}`, `command git -P show -s ${blob}`,
  ];
  for (const command of prefixedShows) {
    assert.equal((await check(command)).bash.state, "ask", `Prefixed show asks: ${command}`);
    const gate = (await gatesFor("bash", { command })).find((item) => item.surface === "bash");
    assert(gate, `Prefixed show produces a bash gate: ${command}`);
    assert(hardCheckpointReason({ ...gate.promptDetails, payload: gate.payload }), `Prefixed show cannot auto-approve: ${command}`);
    assert.equal(inspectGitCommands(command)[0]?.subcommand, "show", `Shared parser finds show: ${command}`);
  }
  const session = new SessionRules();
  session.approve("bash", "git -P *");
  const granted = new PermissionResolver(manager, session);
  const grantedPipeline = new ToolCallGatePipeline(granted, {
    getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [],
    getToolPreviewLimits: () => ({}), getPathNormalizer: () => normalizer,
    getShellToolAliases: () => undefined,
  });
  const leak = `git -P show -s ${blob}`;
  const grantedProgram = await BashProgram.parse(leak, normalizer);
  assert.equal(resolveBashCommandCheck(leak, grantedProgram.commands(), undefined, granted).state, "allow", "Session grant git -P * covers blob show");
  const grantedGates = [];
  await grantedPipeline.evaluate({ toolCallId: "session-grant-fixture", toolName: "bash", input: { command: leak }, cwd: scratch }, {
    run: async (gate) => { if (gate) grantedGates.push(gate); return { action: "allow" }; },
  });
  assert(!grantedGates.some((gate) => gate.surface === "bash" && gate.preCheck?.state === "ask"), "Session grant skips the bash ask");
  assert(hardCheckpointReason({ payload: { kind: "bash", request: { surface: "bash", toolName: "bash", value: leak, matchedPattern: "git -P *", commandContext: null, executedUnit: null }, evidence: [{ label: "full command", text: leak, detail: null }], annotations: [] } }), "Luna still checkpoints a session-granted git -P show");
  // The static guard lets operand-taking wrappers through as the normal-review
  // route. That is only sound while upstream keys them by the wrapper name, so
  // no `git ...` session grant covers them and Luna still sees a show.
  const wideSession = new SessionRules();
  for (const pattern of ["git -P *", "git *"]) wideSession.approve("bash", pattern);
  const wideGranted = new PermissionResolver(manager, wideSession);
  const widePipeline = new ToolCallGatePipeline(wideGranted, {
    getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [],
    getToolPreviewLimits: () => ({}), getPathNormalizer: () => normalizer,
    getShellToolAliases: () => undefined,
  });
  for (const prefix of ["env", "env FOO=1", "timeout 5", "timeout -s9 5", "nice -n 5", "nice -n5", "stdbuf -o0", "ionice -c3", "ionice -c 3", "time", "time -fx"]) {
    const command = `${prefix} git -P show -s ${blob}`;
    assert.equal(inspectGitCommands(command)[0]?.wrapped, true, `Shared parser marks wrapper: ${command}`);
    const program = await BashProgram.parse(command, normalizer);
    assert.notEqual(resolveBashCommandCheck(command, program.commands(), undefined, wideGranted).state, "allow", `Git session grant does not cover wrapper: ${command}`);
    const gates = [];
    await widePipeline.evaluate({ toolCallId: "wrapped-grant-fixture", toolName: "bash", input: { command }, cwd: scratch }, {
      run: async (gate) => { if (gate) gates.push(gate); return { action: "allow" }; },
    });
    const gate = gates.find((item) => item.surface === "bash" && item.preCheck?.state === "ask");
    assert(gate, `Wrapped Git show still asks under a Git session grant: ${command}`);
    assert(hardCheckpointReason({ ...gate.promptDetails, payload: gate.payload }), `Wrapped Git show cannot auto-approve: ${command}`);
  }

  // No SDK runtime export may be necessary to load the Bash/path guard.
  // Exercise both missing export and throwing grep factory against its real hook.
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = resources;
  try {
    // Real SDK loading, tool selection and emitToolCall dispatch. In-memory
    // credentials and disabled discovery/network keep this independent of the
    // production agent. Never prompt a model or execute the Bash fixture.
    const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(join(piRoot, "dist/index.js"));
    const { loadExtensions } = await import(join(piRoot, "dist/core/extensions/loader.js"));
    const { AuthStorage } = await import(join(piRoot, "dist/core/auth-storage.js"));
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const canary = { name: "grep", label: "fixture", description: "unchecked fixture", parameters: { type: "object", properties: { pattern: { type: "string" } } } };
    const canaryPath = join(scratch, "earlier-grep.ts");
    writeFileSync(canaryPath, `export default pi => pi.registerTool({ ...${JSON.stringify(canary)}, execute: async () => { throw new Error("Unchecked fixture executed"); } });\n`);
    for (const scenario of ["missing", "bound", "earlier-extension", "sdk-override"]) {
      const paths = [join(resources, "extensions/static-safety-guard.ts")];
      if (scenario !== "missing") paths.push(join(resources, "extensions/policy-grep.ts"));
      if (scenario === "earlier-extension") paths.unshift(canaryPath);
      const settingsManager = SettingsManager.inMemory();
      const eventBus = createEventBus();
      // The CLI resource resolver can reject duplicates earlier; SDK clients
      // can supply their own extension set. Exercise the runner's first-wins
      // behavior as well as the separate SDK customTools override.
      const loaded = await loadExtensions(paths, scratch, eventBus);
      const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: resources, settingsManager, eventBus,
        extensionsOverride: () => loaded, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, [], `SDK factory loading: ${scenario}`);
      const { session } = await createAgentSession({ cwd: scratch, agentDir: resources, resourceLoader: loader,
        settingsManager, sessionManager: SessionManager.inMemory(scratch), modelRuntime,
        customTools: scenario === "sdk-override" ? [{ ...canary, execute: async () => { throw new Error("Unchecked SDK fixture executed"); } }] : [] });
      const errors = [];
      const call = (toolName, input) => session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: `sdk-${scenario}`, toolName, input });
      try {
        assert((await call("grep", { pattern: "fixture" }))?.block, `No readiness before session_start: ${scenario}`);
        await session.bindExtensions({ onError: (error) => errors.push(error) });
        assert((await call("bash", { command: "sudo true" }))?.block, `Actual SDK dispatch reaches Bash guard: ${scenario}`);
        assert((await call("bash", { command: "git -P show -s deadbeef" }))?.block, `Actual SDK dispatch blocks prefixed Git show: ${scenario}`);
        assert((await call("read", { path: "FILE:///home/fixture/.ssh/id_fixture" }))?.block, `Actual SDK dispatch reaches URL guard: ${scenario}`);
        const selected = session.getAllTools().find((tool) => tool.name === "grep");
        if (scenario === "earlier-extension" || scenario === "sdk-override") assert.equal(selected.description, canary.description, `SDK selects conflicting definition: ${scenario}`);
        assert.equal(Boolean((await call("grep", { pattern: "fixture" }))?.block), scenario !== "bound", `Guard verifies winning tool binding: ${scenario}`);
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
        assert((await call("grep", { pattern: "fixture" }))?.block, `Shutdown removes readiness: ${scenario}`);
        assert.deepEqual(errors, [], `SDK lifecycle errors: ${scenario}`);
      } finally { session.dispose(); }
    }
    console.log("PASS: real Pi SDK factories, emitToolCall, grep binding, earlier extension/SDK override and shutdown");
    for (const stub of ["export const unrelated = true;", "export function createGrepToolDefinition() { throw new Error('fixture unavailable'); }"]) {
      const sdkStub = join(scratch, stub.includes("function") ? "sdk-throw.mjs" : "sdk-missing.mjs");
      writeFileSync(sdkStub, stub);
      const isolatedJiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": sdkStub } });
      const guardHandlers = new Map();
      const guardEvents = new Map();
      const { default: guard } = await isolatedJiti.import(join(resources, "extensions/static-safety-guard.ts"));
      const api = { on: (name, fn) => guardHandlers.set(name, fn), registerTool: () => {}, events: { on: (name, fn) => { guardEvents.set(name, fn); return () => {}; }, emit: () => {} } };
      guard(api);
      const guardCtx = { cwd: scratch, getSystemPrompt: () => "", sessionManager: { getSessionId: () => "missing-grep", getEntries: () => [] } };
      guardHandlers.get("session_start")({}, guardCtx);
      await assert.rejects(async () => {
        const { default: searchExtension } = await isolatedJiti.import(join(resources, "extensions/policy-grep.ts"));
        searchExtension(api);
      }, stub.includes("function") ? /fixture unavailable/ : /createGrepToolDefinition/);
      for (const command of ["sudo true", "GIT_EXTERNAL_DIFF=./x.sh git log -p -1 --ext-diff", "git show -s", "git show -s HEAD", "git -P show -s deadbeef", "git --bare show -s HEAD", "command git -P show -s deadbeef"]) {
        assert(guardHandlers.get("tool_call")({ toolName: "bash", input: { command } }, guardCtx)?.block, `Independent guard still loaded: ${command}`);
      }
      assert(guardHandlers.get("tool_call")({ toolName: "grep", input: { pattern: "fixture" } }, guardCtx)?.block, "Unchecked grep fallback must fail closed");
      for (const toolName of ["read", "write", "edit", "ls", "find", "grep"]) {
        assert(guardHandlers.get("tool_call")({ toolName, input: { path: "file:///home/fixture/.ssh/id_fixture" } }, guardCtx)?.block);
      }
      // Register and exercise the deterministic directory preflight. The real
      // pipeline supplies its path facts, so this cannot pass on a guessed shape.
      const serviceKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
      const previous = globalThis[serviceKey];
      let preflight;
      globalThis[serviceKey] = new Map([["missing-grep", { registerAuthorizer: (name, fn) => { assert.equal(name, "directory-search-scope"); preflight = fn; return () => {}; } }]]);
      try {
        guardEvents.get("permissions:ready")({ sessionId: "missing-grep" });
        const directoryGate = (await gatesFor("grep", { path: "/var" })).find((gate) => gate.surface === "external_directory_read");
        assert(directoryGate, "External directory produces an ask gate");
        const result = await preflight({ ...directoryGate.promptDetails, payload: directoryGate.payload });
        assert.equal(result.kind, "deny", "Useless one-time directory prompt is stopped before Luna/UI");
        const explicitGate = (await gatesFor("grep", { path: "/etc/hosts" })).find((gate) => gate.surface === "external_directory_read");
        assert.equal((await preflight({ ...explicitGate.promptDetails, payload: explicitGate.payload })).kind, "defer", "Explicit file search keeps normal approval");
      } finally { globalThis[serviceKey] = previous; }
      guardHandlers.get("session_shutdown")();
    }
  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }

  // Exercise the actual registered replacement tool, with the installed service
  // and resolver. Merely mocking a readFile callback on upstream grep would miss
  // its unchecked subprocess reads; assert nested content never reaches output.
  const { LocalPermissionsService } = await load("service/permissions-service");
  const service = new LocalPermissionsService(resolver, { getPathNormalizer: () => normalizer }, {}, {}, {});
  const sessionId = "policy-grep-fixture";
  const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
  const previousServices = globalThis[servicesKey];
  globalThis[servicesKey] = new Map([[sessionId, service]]);
  try {
    const tools = new Map();
    const { default: extension } = await jiti.import(join(resources, "extensions/policy-grep.ts"));
    extension({ registerTool: (tool) => tools.set(tool.name, tool), on: () => {}, events: { on: () => () => {}, emit: () => {} } });
    const grep = tools.get("grep");
    assert(grep, "Permission-aware grep must replace the built-in");
    const nested = join(scratch, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "normal.txt"), "before\nneedle visible\nafter\n");
    writeFileSync(join(nested, ".env"), "needle DENIED_FIXTURE\n");
    writeFileSync(join(nested, "private.key"), "needle ASK_FIXTURE\n");
    writeFileSync(join(nested, ".env.example"), "needle public template\n");
    writeFileSync(join(nested, ".gitignore"), "normal.txt\n");
    symlinkSync(join(nested, ".env"), join(nested, "alias.txt"));
    symlinkSync(nested, join(nested, "loop"));
    writeFileSync(join(nested, "large.txt"), "needle LARGE_FIXTURE\n".repeat(150_000));
    const ctx = (agent) => ({ cwd: scratch, getSystemPrompt: () => "", sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => agent ? [{ type: "custom", customType: "active_agent", data: { name: agent } }] : [],
    } });
    const search = (params, agent, signal) => grep.execute("fixture", { pattern: "needle", ...params }, signal, undefined, ctx(agent));
    for (const agent of [undefined, "editor", "reader"]) {
      const result = await search({}, agent);
      const text = result.content[0].text;
      assert(text.includes("needle visible") && text.includes("needle public template"), `Recursive ordinary/allowed template search: ${agent}`);
      assert(!/DENIED_FIXTURE|ASK_FIXTURE|LARGE_FIXTURE/.test(text), `Filtered descendants must never reach output: ${agent}`);
      assert(result.details.skippedFiles >= 3);
      assert.equal(result.details.incomplete, false);
    }
    const glob = await search({ path: "nested", glob: "normal.txt", context: 1 });
    assert.match(glob.content[0].text, /before/);
    assert.match(glob.content[0].text, /after/);
    assert(!glob.content[0].text.includes("public template"));
    const formatted = join(scratch, "formatted"); mkdirSync(formatted);
    const singlePath = join(formatted, "single.txt");
    writeFileSync(singlePath, "zero\nneedle single\nend\n");
    writeFileSync(join(formatted, "second.txt"), "needle second\n");
    const hostileName = "evil\"\\name\nline.txt";
    writeFileSync(join(formatted, hostileName), "needle hostile\n");
    const grouped = await search({ path: formatted, context: 1 });
    const groupedResults = grouped.content[0].text.split("\n\nSearched ")[0];
    assert.equal(groupedResults, [
      `Root ${JSON.stringify(formatted)} (file paths below are relative)`,
      `File ${JSON.stringify(hostileName)}`,
      "1: needle hostile",
      'File "second.txt"',
      "1: needle second",
      'File "single.txt"',
      "1- zero",
      "2: needle single",
      "3- end",
    ].join("\n"), "Directory results are grouped with one escaped path header and path-free match/context lines");
    const single = await search({ path: singlePath });
    assert.equal(single.content[0].text.split("\n\nSearched ")[0],
      `File ${JSON.stringify(singlePath)}\n2: needle single`, "Explicit-file output has one absolute group header");
    const capped = join(scratch, "capped"); mkdirSync(capped);
    for (let i = 0; i < 120; i++) writeFileSync(join(capped, `${String(i).padStart(3, "0")}.txt`), `needle ${"x".repeat(600)}\n`);
    const cappedResult = await search({ path: capped, limit: 500 });
    const cappedText = cappedResult.content[0].text;
    const cappedResults = cappedText.split("\n\nSearched ")[0];
    assert(Buffer.byteLength(cappedResults, "utf8") <= 50 * 1024, "Root, group headers and lines share the 50 KiB result budget");
    assert.equal(cappedResult.details.incomplete, true);
    assert.match(cappedText, /Search incomplete:/);
    const cappedLines = cappedResults.split("\n");
    for (let i = 0; i < cappedLines.length; i++) if (cappedLines[i].startsWith("File ")) {
      assert.match(cappedLines[i + 1] ?? "", /^\d+[:-] /, "No group header may be orphaned by truncation");
    }
    assert(!cappedLines.at(-1).startsWith("File "), "Truncation cannot end on a group header");
    const limited = await search({ limit: 1 });
    assert.equal(limited.details.incomplete, true, "Partial output is explicit");
    const literal = await search({ pattern: "needle.*", literal: true });
    assert.match(literal.content[0].text, /No text matches/);
    await assert.rejects(search({ pattern: "[" }), /ripgrep failed/);
    await assert.rejects(search({}, undefined, AbortSignal.abort()), /aborted/);
    const edges = join(scratch, "edges"); mkdirSync(edges);
    writeFileSync(join(edges, "a.txt"), "unrelated before boundary\n");
    writeFileSync(join(edges, "b.vcxproj"), "before\r\nneedle CRLF\r\nafter\r\n");
    writeFileSync(join(edges, "c.txt"), "unrelated after boundary\n");
    writeFileSync(join(edges, "binary.bin"), Buffer.from("needle BINARY_FIXTURE\0\n"));
    const exact = await search({ path: edges, limit: 1, context: 10 });
    assert.equal(exact.details.incomplete, false, "An exact limit is complete until one more match is found");
    assert.match(exact.content[0].text, /needle CRLF/);
    assert(!exact.content[0].text.includes("\r"), "CRLF line endings must not corrupt output");
    assert(!exact.content[0].text.includes("unrelated"), "Context cannot cross file boundaries");
    assert.equal(exact.details.skipped.binary, 1, "Binary exclusion is reported separately");
    assert.equal(exact.details.searchedFiles, 3);
    const repeated = await search({ path: edges, limit: 1, context: 10 });
    assert.deepEqual(repeated, exact, "Enumeration and results are deterministic");
    const explicit = await search({ path: join(edges, "b.vcxproj"), limit: 1 });
    assert.match(explicit.content[0].text, /needle CRLF/);
    assert.equal(explicit.details.incomplete, false);
    const deniedExplicit = await search({ path: join(nested, ".env") });
    assert.equal(deniedExplicit.details.searchedFiles, 0);
    assert(!deniedExplicit.content[0].text.includes("DENIED_FIXTURE"));
    for (const prefix of ["file://", "@file://"]) await assert.rejects(search({ path: `${prefix}${join(edges, "b.vcxproj")}` }), /file:/);
    // A symlink cwd must not cause canonical descendants to be classified as
    // external. Force external asks even under /tmp so this covers the bug.
    const cwdAlias = join(scratch, "cwd-alias"); symlinkSync(scratch, cwdAlias);
    globalThis[servicesKey].set(sessionId, { checkPermission: (surface, ...args) => surface === "external_directory_read" ? { state: "ask" } : service.checkPermission(surface, ...args) });
    const aliasContext = { ...ctx(), cwd: cwdAlias };
    const aliased = await grep.execute("symlink-cwd", { pattern: "needle", path: "edges" }, undefined, undefined, aliasContext);
    assert.match(aliased.content[0].text, /needle CRLF/);
    // A direct execute after a one-time directory grant still cannot extend it
    // to descendants; the preflight above prevents this useless normal UI path.
    const externalContext = { ...ctx(), cwd: edges };
    const external = await grep.execute("external", { pattern: "needle", path: nested }, undefined, undefined, externalContext);
    assert.equal(external.details.searchedFiles, 0);
    assert(external.details.skipped.permission > 0);
    assert.match(external.content[0].text, /one-time directory approval/);
    globalThis[servicesKey].set(sessionId, service);
    const fdCount = () => readdirSync("/proc/self/fd").length;
    const descriptors = fdCount();
    const fakeBin = join(scratch, "fake-bin"); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "rg"), '#!/bin/sh\nread -r line || exit 1\nprintf "fixture search failure" >&2\nexit 2\n', { mode: 0o700 });
    const savedPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try { await assert.rejects(search({ path: join(edges, "b.vcxproj") }), /fixture search failure/); }
    finally { process.env.PATH = savedPath; }
    assert.equal(fdCount(), descriptors, "Search-phase failure closes descriptors");
    if (process.env.PI_POLICY_SCALE_SELFTEST === "1") {
      const scale = join(scratch, "scale"); mkdirSync(scale);
      for (let i = 0; i < 22_600; i++) writeFileSync(join(scale, `${String(i).padStart(5, "0")}.txt`), i === 22_599 ? "needle LAST_FILE\n" : "ordinary scale fixture\n");
      const start = performance.now();
      const result = await search({ path: scale });
      const elapsed = performance.now() - start;
      assert.equal(result.details.searchedFiles, 22_600, "Real-scale traversal must reach beyond the former 10k cap");
      assert.equal(result.details.incomplete, false);
      assert.match(result.content[0].text, /LAST_FILE/);
      console.log(`PASS: 22600-file scale fixture searched completely in ${(elapsed / 1000).toFixed(2)}s`);
    }
    globalThis[servicesKey].delete(sessionId);
    await assert.rejects(search({}), /permission service/);
    console.log("PASS: grep CRLF, binary, exact limit, deterministic order, context boundaries, explicit files, URL denial, symlink cwd, external scope, descriptor cleanup and all worker profiles");
  } finally { globalThis[servicesKey] = previousServices; }
  console.log(`PASS: upstream ${upstreamVersion} parser/gates, ${allowedPatterns.length} static patterns, negative commands, skills/subagents, path/external boundaries`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
