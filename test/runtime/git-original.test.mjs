// Permission-only literal Git contract. Commands are data: never start Git,
// a shell, helpers, historical content queries, network or a model here.
// Deliberate replacement of the retired history/object attribution suite:
// hashes, implicit history and configured content sources are NORMAL review,
// not an enumerate-all-files promise or a yolo-resistant attribution ask.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test, after } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  "#src": join(packageRoot, "runtime/permission-system/vendor/src"),
} });
const load = name => jiti.import(`#src/${name}`);
const [{ PermissionManager }, { PermissionResolver }, { PathNormalizer }, { posixPathFlavor },
  { PermissionSession }, { PermissionGateHandler }, { ToolCallGatePipeline }, { resolveToolPreviewLimits },
  { GateRunner }, readPolicy, query, { getParser }, { BashProgram }, { describeBashPathGate }, { describeBashExternalDirectoryGate }] = await Promise.all([
  load("policy/permission-manager"), load("policy/permission-resolver"), load("path/path-normalizer"), load("path/path-flavor"),
  load("session/permission-session"), load("handlers/permission-gate-handler"), load("handlers/gates/tool-call-gate-pipeline"),
  load("tool-input/tool-preview-formatter"), load("handlers/gates/runner"), load("access-intent/bash/managed-read-policy"),
  load("access-intent/bash/managed-git-query"), load("access-intent/bash/parser"), load("access-intent/bash/program"),
  load("handlers/gates/bash-path"), load("handlers/gates/bash-external-directory"),
]);
const { hardenGitInput, managedGitProof, originalGitCommands } = readPolicy;
const { analyzeGitCommands, nativeGitScope, gitQueryEffect } = query;
const { default: staticGuard, originalBashDeny } = await jiti.import(join(packageRoot, "runtime/policy/static-safety-guard.ts"));
const root = mkdtempSync(join(tmpdir(), "alehouse-git-literal-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace");
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
mkdirSync(join(agentDir, "agents"), { recursive: true });
for (const name of ["editor", "researcher"]) cpSync(join(packageRoot, "runtime/agents", `${name}.md`), join(agentDir, "agents", `${name}.md`));
mkdirSync(join(cwd, ".git"), { recursive: true });
mkdirSync(join(cwd, "docs"));
writeFileSync(join(cwd, "ordinary.txt"), "synthetic fixture\n");
writeFileSync(join(cwd, ".git/config"), "[core]\n fsmonitor = /never-execute-fixture\n");
const shipped = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
const writeJson = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
writeJson(configPath, shipped);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.CDPATH;
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
const normalizerFor = (where = cwd) => new PathNormalizer(posixPathFlavor, where);
const hooks = new Map();
staticGuard({ on: (name, handler) => hooks.set(name, handler), events: { on: () => () => {}, emit() {} } });
const guardCtx = agent => ({ cwd, getSystemPrompt: () => "", sessionManager: {
  getSessionId: () => "git-literal", getEntries: () => agent ? [{ type: "custom", customType: "active_agent", data: { name: agent } }] : [],
} });
hooks.get("session_start")({}, guardCtx());
const guard = (command, agent = "editor") => hooks.get("tool_call")({ toolName: "bash", input: { command } }, guardCtx(agent));
const bashGrant = [{ surface: "bash", pattern: "*", action: "allow", layer: "session", origin: "session" }];
const modes = [{}, { yolo: true }, { grants: bashGrant }];
const policy = (surface, rules) => ({ ...shipped, permission: { ...shipped.permission,
  [surface]: { ...shipped.permission[surface], ...rules },
} });
let ordinal = 0;
async function run(command, { agent = "editor", config = shipped, yolo = false, grants = [], approve = false, where = cwd, managerOptions = {} } = {}) {
  const file = join(root, `policy-${ordinal++}.json`);
  writeJson(file, config);
  const manager = new PermissionManager({ globalConfigPath: file, agentsDir: join(agentDir, "agents"),
    mcpServerNames: [], ...managerOptions, isYoloEnabled: () => yolo });
  const resolver = new PermissionResolver(manager, { getRuleset: () => grants }), normalizer = normalizerFor(where);
  const prompts = [], approvals = [], decisions = [];
  const runner = new GateRunner(resolver, { recordSessionApproval(approval) { approvals.push(approval.toForwardedData()); } }, { async escalate(details) {
    prompts.push(details);
    return approve ? { approved: true, state: "approved_for_session",
      decidedBy: { kind: "authorizer", name: "synthetic-fixture", verdict: "allow", reason: null } }
      : { approved: false, state: "denied", confirmationUnavailable: true,
        decidedBy: { kind: "unavailable", reason: "Permission-only fixture" } };
  } }, { writeReviewLog() {}, emitDecision(decision) { decisions.push(decision); } }, () => yolo);
  const tools = [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }];
  const session = new PermissionSession({}, { start() {}, stop() {} }, manager, {}, {}, { activate() {}, deactivate() {} }, posixPathFlavor);
  const handler = new PermissionGateHandler(session, { getAll: () => tools, getActive: () => ["bash"], setActive() {} },
    new ToolCallGatePipeline(resolver, { getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [],
      getToolPreviewLimits: () => resolveToolPreviewLimits(), getPathNormalizer: () => normalizer, getShellToolAliases: () => undefined }), {}, runner);
  const input = { command };
  const outcome = await handler.handleToolCall({ toolCallId: "git-literal", toolName: "bash", input }, { ...guardCtx(agent), cwd: where, hasUI: false, ui: { notify() {} } });
  assert.equal(input.command, command, "actual input bytes unchanged");
  assert.equal(originalGitCommands(input), undefined, "no execution rewrite provenance");
  return { outcome, prompts, approvals, decisions, resolver };
}
const gates = (program, resolver, agent = "editor", where = cwd) => {
  const tcc = { toolName: "bash", toolCallId: "git-literal", input: { command: program.commandText() }, agentName: agent, cwd: where };
  return { path: describeBashPathGate(tcc, program, resolver, normalizerFor(where)),
    external: describeBashExternalDirectoryGate(tcc, program, resolver, normalizerFor(where)) };
};
const externalPolicy = action => ({ ...shipped, permission: { ...shipped.permission, external_directory: { "*": action } } });
const facts = async (command, where = cwd) => (await BashProgram.parse(command, normalizerFor(where))).pathRuleCandidates();
const has = (candidates, token, effect) => candidates.some(candidate => candidate.token === token && candidate.effect.effect === effect);

test("Git stays original and repository queries never inherit managed_static_read", async () => {
  for (const command of ["git status --short", "git log -1 --oneline", "git diff --stat", "git show HEAD:ordinary.txt",
    "env git show HEAD:ordinary.txt", "git -C docs status --short", "cd docs && git status --short"]) {
    const input = { command };
    assert.equal(await hardenGitInput(input, cwd), undefined);
    assert.equal(input.command, command);
    assert.equal(managedGitProof(command, normalizerFor()), undefined);
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false, command);
    const ordinary = await run(command);
    assert.equal(ordinary.outcome.action, "block", command);
    assert.ok(ordinary.prompts.length > 0, "normal approval, not a static refusal");
    assert.equal((await run(command, { yolo: true })).outcome.action, "allow", command);
  }
  assert.equal(nativeGitScope("git --version", normalizerFor())?.auto, true, "only a literal config-independent version query");
});

test("literal cd and a managed non-Git sibling cannot auto-approve repository Git", async () => {
  const config = policy("bash", { "cd *": "allow" });
  for (const command of [
    "cd ./docs && git status --short",
    "cd ./docs && git diff --stat",
    "cd ./docs && sed -n '1p' ../ordinary.txt && git diff --stat",
  ]) {
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(program.commandText(), command);
    const git = program.commands().find(unit => unit.text.startsWith("git "));
    assert.equal(git?.managedGitRequest, true, "the Git unit keeps its native restriction binding");
    assert.notEqual(git.managedReadOnly, true, "non-Git readProof cannot mark repository Git");
    if (command.includes("sed -n")) assert.equal(program.commands().find(unit => unit.text.startsWith("sed "))?.managedReadOnly, true,
      "exercise a real managed non-Git sibling, not a whole-program proof decline");
    const ordinary = await run(command, { config });
    assert.equal(ordinary.outcome.action, "block");
    assert.ok(ordinary.prompts.length > 0, "Git still needs normal approval despite the allowed cd/sibling");
    assert.equal((await run(command, { config, yolo: true })).outcome.action, "allow", "ordinary yolo remains available");
  }
  const command = "cd ./docs && git status --short", explicit = policy("bash", { "cd *": "allow", "git status --short": "allow" });
  const allowed = await run(command, { config: explicit });
  assert.equal(allowed.outcome.action, "allow", "an explicit status allowance is ordinary policy, not a blanket Git allow");
  assert.equal(allowed.prompts.length, 0);
  assert.equal((await BashProgram.parse(command, normalizerFor())).commands().some(unit => unit.managedReadOnly), false);
});

test("ordinary editor Git writes need approval; unknown effects are never relabeled READ", async () => {
  for (const command of ["git add ordinary.txt", "git commit -m fixture", "git branch topic", "git tag v1", "git checkout -b topic", "git worktree add ../separate"]) {
    assert.equal(guard(command)?.block, undefined, command);
    assert.equal(originalBashDeny(command, guardCtx("editor"), agentDir), undefined);
    assert.equal(gitQueryEffect(command), undefined);
    assert.notEqual(nativeGitScope(command, normalizerFor())?.auto, true);
    const ordinary = await run(command);
    assert.equal(ordinary.outcome.action, "block");
    assert.ok(ordinary.prompts.length > 0, "write is normal review, never a managed read grant");
    assert.equal((await run(command, { yolo: true })).outcome.action, "allow", command);
  }
  for (const command of ["git mystery ordinary.txt", "git diff --unknown -- ordinary.txt", "git diff --output=out"])
    assert.equal(gitQueryEffect(command), undefined, command);
  assert.equal(guard("sudo true")?.block, true, "high-risk protection retained");
  assert.equal(guard("git commit -m fixture", "researcher")?.block, true, "researcher retains its Bash deny");
});

test("literal rev:path and pathspec denies survive ordinary approval, yolo and session grants", async () => {
  for (const command of ["git show HEAD:.env", "git show :0:.env", "git cat-file -p HEAD:.env", "git log -- .env",
    "git show --unknown HEAD:.env", "git rev-parse HEAD:.env", "git diff HEAD:.env HEAD:ordinary.txt",
    "git show $(git rev-parse HEAD):.env", "git show HEAD:.{env,}", "echo $(git show HEAD:.env)",
    "git cat-file --batch <<< HEAD:.env", "git cat-file --batch <<'EOF'\nHEAD:.env\nEOF"]) {
    assert.equal(has(await facts(command), ".env", "read"), true, command);
    for (const mode of modes) {
      const result = await run(command, mode);
      assert.equal(result.outcome.action, "block", command);
      assert.equal(result.prompts.length, 0, "literal deny is not approval");
    }
  }
  const absolute = join(cwd, "private.txt");
  assert.equal(existsSync(absolute), false, "historical literal need not exist");
  for (const where of [cwd, join(cwd, "docs")]) {
    const command = "env git show 2>&1 HEAD:private.txt", candidates = await facts(command, where);
    assert.ok(candidates.some(candidate => candidate.token === "private.txt" && candidate.path.matchValues().includes(absolute)), "filesystem repo marker resolves a root alias from subdir");
    for (const mode of modes) assert.equal((await run(command, { ...mode, where, config: policy("path_read", { [absolute]: "deny" }) })).outcome.action, "block");
  }
});

test("wrapper, executable, dynamic-root/revision and show -L literals reach the READ deny for parent and editor", async () => {
  const commands = ["command git show HEAD:.env", "/usr/bin/git show HEAD:.env", "exec git show HEAD:.env",
    'git -C "$PWD" show HEAD:.env', 'git -C"$PWD" show HEAD:.env', 'git show "$REV:.env"', "git show -L1,2:.env",
    "git show HEAD:.env", "env git show HEAD:.env", "git show $REV:.env", "git show -L 1,2:.env", "git log -L1,2:.env",
    "command -- ./fixture-bin/git show HEAD:.env", "exec -- git show HEAD:.env", "env ./fixture-bin/git show HEAD:.env",
    "echo $(command git show 2>&1 HEAD:.env)", 'git -C "$PWD" show 2>&1 "$REV:.env"', "git show 2>&1 -L1,2:.env"];
  for (const command of commands) {
    const input = { command };
    assert.equal(await hardenGitInput(input, cwd), undefined);
    assert.equal(input.command, command, "the restriction collector does not rewrite execution");
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(program.commandText(), command);
    assert.equal(has(program.pathRuleCandidates(), ".env", "read"), true, command);
    assert.ok(program.commands().some(unit => unit.managedGitRequest), "real command units retain the restriction binding");
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false, "no repository or wrapper automatic grant");
    for (const agent of [null, "editor"]) {
      assert.equal(guard(command, agent)?.block, undefined, "literal path protection, not a blanket static Git refusal");
      assert.equal(originalBashDeny(command, guardCtx(agent), agentDir), undefined);
      for (const mode of [...modes, { approve: true }]) {
        const result = await run(command, { ...mode, agent });
        const descriptor = gates(program, result.resolver, agent).path;
        assert.equal(descriptor?.surface, "path_read", command);
        assert.equal(descriptor.preCheck.state, "deny");
        assert.equal(descriptor.logContext.path, ".env");
        assert.equal(result.outcome.action, "block", command);
        assert.equal(result.prompts.length, 0, "neither approval, a broad Bash session grant nor yolo can approve this path deny");
        assert.equal(result.approvals.length, 0);
        assert.ok(result.decisions.some(decision => decision.surface === "path_read" && decision.result === "deny"));
      }
    }
  }
  const ordinary = await run("command git show HEAD:ordinary.txt", { approve: true });
  assert.equal(ordinary.outcome.action, "allow", "synthetic approval really can satisfy ordinary Bash review");
  assert.ok(ordinary.approvals.length > 0, "exercise the approved_for_session recorder without running the command");
});

test("unknown cwd/root retains literal-only restrictions without guessing PWD or granting execution", async () => {
  for (const command of ['git -C "$PWD" show HEAD:.env', 'git -C"$PWD" show HEAD:.env', 'git "-C$PWD" show HEAD:.env',
    'env -C "$DIR" git show HEAD:.env', 'env -C"$DIR" git show HEAD:.env', 'git -C "$DIR:ordinary.txt" show HEAD:.env',
    'cd "$DIR" && git show HEAD:.env', 'git -c "$CONFIG" show HEAD:.env', 'git --work-tree "$TREE" show HEAD:.env',
    "git --git-dir=.git show HEAD:.env"]) {
    const program = await BashProgram.parse(command, normalizerFor());
    const literal = program.pathRuleCandidates().filter(candidate => candidate.token === ".env" && candidate.effect.effect === "read");
    assert.ok(literal.length > 0, command);
    for (const candidate of literal) {
      assert.deepEqual(candidate.path.matchValues(), [".env"], "unknown root adds no guessed absolute alias");
      assert.equal(candidate.path.boundaryValue(), "");
    }
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false);
    const result = await run(command, { yolo: true });
    // A literal .git selector has its own earlier directional WRITE deny;
    // that mixed path gate may decide before the historical READ candidate.
    const descriptor = gates(program, result.resolver).path;
    assert.equal(descriptor?.surface, command === "git --git-dir=.git show HEAD:.env" ? "path" : "path_read");
    assert.equal(descriptor.preCheck.state, "deny");
    for (const candidate of literal) {
      assert.equal(result.resolver.resolve({ kind: "access-path", surface: "path_read", path: candidate.path,
        agentName: "editor" }).state, "deny", "the collected .env READ deny remains independently discriminating");
    }
    assert.equal(result.outcome.action, "block");
    assert.equal(result.prompts.length, 0);
  }
});

test("bounded set/export prefixes preserve cwd aliases and do not invent an external gate", async () => {
  for (const command of ["git add ordinary.txt", "set -e; git add ordinary.txt", "export A=1 && git add ordinary.txt"]) {
    const program = await BashProgram.parse(command, normalizerFor());
    const literal = program.pathRuleCandidates().filter(candidate => candidate.token === "ordinary.txt" && candidate.effect.effect === "read");
    assert.ok(literal.length > 0, command);
    assert.ok(literal.every(candidate => candidate.path.boundaryValue() === join(cwd, "ordinary.txt")), "the known cwd stays known");
    assert.equal(program.externalAccesses().length, 0, command);
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false);
    const ordinary = await run(command, { config: externalPolicy("ask") });
    assert.equal(gates(program, ordinary.resolver).external, null);
    assert.equal(ordinary.outcome.action, "block", "ordinary Bash review still applies");
    assert.ok(ordinary.prompts.length > 0);
    assert.ok(ordinary.prompts.every(prompt => prompt.payload.request.surface === "bash"), "no spurious external ask");
    const deniedExternal = await run(command, { config: externalPolicy("deny"), yolo: true });
    assert.equal(gates(program, deniedExternal.resolver).external, null);
    assert.equal(deniedExternal.outcome.action, "allow", "an external deny must not block this ordinary in-cwd target");
  }
});

test("bounded context exceptions do not fold other builtins, sensitive exports or dynamic cd", async () => {
  const commands = ["set +e; git add ordinary.txt", "set -- docs; git add ordinary.txt",
    'export A="$VALUE" && git add ordinary.txt', "eval ':'; git add ordinary.txt", ". ./context.sh; git add ordinary.txt",
    "f() { :; }; git add ordinary.txt", "cd ~ && git add ordinary.txt", 'cd "$DIR" && git add ordinary.txt',
    ...["HOME", "GIT_DIR", "PATH", "CDPATH", "PWD"].map(key => `export ${key}=docs && git add ordinary.txt`)];
  for (const command of commands) {
    const program = await BashProgram.parse(command, normalizerFor());
    const literal = program.pathRuleCandidates().filter(candidate => candidate.token === "ordinary.txt" && candidate.effect.effect === "read");
    assert.ok(literal.some(candidate => candidate.path.boundaryValue() === ""), command);
    assert.ok(program.externalAccesses().some(access => access.path.value() === "ordinary.txt" && access.effect.effect === "read"), "the unknown base remains external");
  }
  for (const command of ["cd ~ && git add ordinary.txt", 'cd "$DIR" && git add ordinary.txt']) {
    const program = await BashProgram.parse(command, normalizerFor());
    const ordinary = await run(command, { config: externalPolicy("ask") });
    assert.equal(ordinary.outcome.action, "block");
    assert.equal(gates(program, ordinary.resolver).external?.preCheck.state, "ask");
    assert.ok(ordinary.prompts.some(prompt => prompt.payload.request.surface.startsWith("external_directory")));
    const denied = await run(command, { config: externalPolicy("deny"), yolo: true });
    assert.equal(denied.outcome.action, "block", "a genuine unknown base keeps the configured external deny");
    assert.equal(denied.prompts.length, 0);
  }
});

test("DATA, unknown filenames and globs do not acquire a fake literal .env fact", async () => {
  for (const command of ["git log --format=HEAD:.env", 'git log --grep "$REV:.env"', "git log --grep HEAD:.env",
    'command git log 2>&1 -G "$REV:.env"', 'git log --grep -C"$PWD" --format=HEAD:.env',
    'git show "$REV:$FILE.env"', "git show HEAD:*.env", 'git show "$REV:*.env"']) {
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(has(program.pathRuleCandidates(), ".env", "read"), false, command);
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false);
  }
  assert.equal(has(await facts("git log --format HEAD:.env"), ".env", "read"), true, "bare optional --format does not consume the following positional revision");
  for (const command of ["command -v git show HEAD:.env", "command -V git show HEAD:.env", "exec -a fixture git show HEAD:.env"]) {
    const tree = (await getParser()).parse(command);
    try { assert.equal(analyzeGitCommands(tree.rootNode, normalizerFor()).units.size, 0, "unrecognized wrapper options are not execution proof"); }
    finally { tree.delete(); }
  }
});

test("restriction-only additions leave the exact automatic Git version lane unchanged", async () => {
  for (const command of ["git --version", "env git --version"]) assert.equal(nativeGitScope(command, normalizerFor())?.auto, true);
  for (const command of ["command git --version", "exec git --version", "/usr/bin/git --version", "set -e; git --version",
    "export A=1 && git --version", 'git -C "$PWD" --version', 'git -C"$PWD" --version', "git -c alias.fixture=status --version", "git fixture"]) {
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(program.commands().filter(unit => unit.managedGitRequest).some(unit => unit.managedReadOnly), false, command);
    assert.notEqual(nativeGitScope(command, normalizerFor())?.auto, true);
  }
});

test("real redirects and explicit outputs remain writes, including completed argv", async () => {
  for (const command of ["git diff --output=out.txt", "git log 2>&1 --output out.txt", "git archive HEAD --output=out.txt",
    "git archive HEAD -o out.txt", "git show --unknown --output=out.txt HEAD", "'git' diff --output=out.txt",
    "command git show --output=out.txt HEAD", "exec git show --output out.txt HEAD", "/usr/bin/git diff --output=out.txt",
    'git -C "$PWD" diff --output=out.txt', 'git -C"$PWD" diff --output=out.txt', "echo $(command git diff 2>&1 --output=out.txt)"]) {
    assert.equal(has(await facts(command), "out.txt", "write"), true, command);
    for (const mode of modes) {
      const result = await run(command, { ...mode, config: policy("path_write", { "out.txt": "deny" }) });
      assert.equal(result.outcome.action, "block", command);
      assert.equal(result.prompts.length, 0);
    }
  }
  for (const [command, token] of [["git log 2>/dev/null -- ordinary.txt", "/dev/null"], ["git diff >./sink", "./sink"], ["git diff | tee ./sink", "./sink"]])
    assert.ok((await facts(command)).some(candidate => candidate.token === token && candidate.effect.effect !== "read"), "sibling/redirect write is never a Git read");
  symlinkSync(".git/config", join(cwd, "sink'"));
  for (const mode of modes) assert.equal((await run('git diff --output="sink\'"', mode)).outcome.action, "block", "canonical protected output alias");
});

test("completed argv preserves option DATA and unknown slots without fabricating writes", async () => {
  for (const [tail, expected] of [
    ["--grep '--output=fake'", []], ["--grep -- --output=real", ["real"]],
    ['--grep "$UNKNOWN" --output=real', ["real"]], ['--output "$UNKNOWN" --grep \'--output=fake\' --output=real', ["real"]],
    ["-S '--output=fake' HEAD", []], ["-G 'HEAD:private.txt'", []], ["--grep $rev:private.txt", []],
    ['--grep "$REV:.env"', []], ["--grep HEAD:.env", []], ['-G "$REV:.env"', []], ["--format=HEAD:.env", []],
    ['--output "$UNKNOWN" --grep "$REV:.env" --output=real', ["real"]], ['--grep -C"$PWD" --output=real', ["real"]],
  ]) {
    const command = `git log 2>&1 ${tail}`, tree = (await getParser()).parse(command);
    try {
      const analysis = analyzeGitCommands(tree.rootNode, normalizerFor());
      assert.deepEqual([...new Set(analysis.ruleCandidates.filter(candidate => candidate.effect.effect === "write").map(candidate => candidate.token))], expected);
      assert.equal(has(analysis.ruleCandidates, "private.txt", "read"), false);
      assert.equal(has(analysis.ruleCandidates, ".env", "read"), false);
      assert.equal(has(await facts(command), ".env", "read"), false, "built BashProgram preserves the same DATA slots");
      assert.equal([...analysis.units.values()].some(unit => unit.auto), false);
    } finally { tree.delete(); }
  }
  const command = "git log 2>&1 --show-signature -1";
  const result = await run(command, { config: policy("bash", { "git log": "allow" }) });
  assert.equal(result.outcome.action, "block");
  assert.ok(result.prompts.length > 0, "truncated exact allow cannot approve buried argv");
});

// Exercise the actual raw-scope API before session composition; no child-only
// blanket policy can substitute for the deliberately configured deny here.
function rawScope(origin, action, pattern) {
  const dir = join(root, `scope-${ordinal++}`), agentsDir = join(dir, "agents"), projectAgentsDir = join(dir, "project-agents");
  mkdirSync(agentsDir, { recursive: true }); mkdirSync(projectAgentsDir);
  const rules = { bash: { [pattern]: action } };
  const frontmatter = permission => ["---", "permission:", ...Object.entries(permission).flatMap(([surface, patterns]) => [
    `  ${surface}:`, ...Object.entries(patterns).map(([key, value]) => `    ${JSON.stringify(key)}: ${value}`),
  ]), "---", ""].join("\n");
  writeFileSync(join(agentsDir, "scopePrincipal.md"), frontmatter(origin === "agent" ? rules : {}));
  if (origin === "project-agent") writeFileSync(join(projectAgentsDir, "scopePrincipal.md"), frontmatter(rules));
  const projectGlobalConfigPath = join(dir, "project.json");
  writeJson(projectGlobalConfigPath, { permission: origin === "project" ? rules : {} });
  return { agent: "scopePrincipal", config: origin === "global" ? policy("bash", rules.bash) : shipped,
    managerOptions: { agentsDir, projectAgentsDir, projectGlobalConfigPath } };
}

test("raw global/project/agent/project-agent exact Bash denies survive approval and env", async () => {
  for (const origin of ["global", "project", "agent", "project-agent"]) {
    const fixture = rawScope(origin, "deny", "git log --oneline");
    for (const command of ["git log --oneline", "env git log --oneline"]) for (const mode of modes) {
      const result = await run(command, { ...fixture, ...mode });
      assert.equal(result.resolver.checkGitBashRestriction("git log --oneline", "scopePrincipal")?.state, "deny");
      assert.equal(result.outcome.action, "block", `${origin}: ${command}`);
      assert.equal(result.prompts.length, 0);
    }
  }
});

test("recognized restriction-only wrappers/executables retain selected inner Bash denies and asks", async () => {
  const cases = ["command git log --oneline", "exec git log --oneline", "/usr/bin/git log --oneline",
    "command -- ./fixture-bin/git log --oneline", "env ./fixture-bin/git log --oneline"].map(command => [command, "git log --oneline"]);
  cases.push(['command git log --grep "$VALUE" --oneline', 'git log --grep "$VALUE" --oneline'],
    ["/usr/bin/git log '--format=ordinary words' --oneline", "git log '--format=ordinary words' --oneline"]);
  for (const [command, inner] of cases) {
    const program = await BashProgram.parse(command, normalizerFor());
    assert.ok(program.commands().some(unit => unit.managedGitRestrictions?.includes(inner)), command);
    for (const mode of [...modes, { approve: true }]) {
      const denied = await run(command, { ...mode, config: policy("bash", { [inner]: "deny" }) });
      assert.equal(denied.outcome.action, "block");
      assert.equal(denied.prompts.length, 0, "the inner configured deny survives approval authority");
    }
    const asked = await run(command, { config: policy("bash", { [inner]: "ask" }) });
    assert.equal(asked.resolver.checkGitBashRestriction(inner, "editor")?.state, "ask");
    assert.equal(asked.outcome.action, "block");
    assert.ok(asked.prompts.length > 0);
    assert.equal((await run(command, { config: policy("bash", { [inner]: "ask" }), yolo: true })).outcome.action, "allow");
  }
});

test("nested redirect-completed Git keeps exact project denies under session grants and yolo", async () => {
  const inner = "git log --oneline", fixture = rawScope("project", "deny", inner);
  for (const command of [
    "echo $(git log 2>&1 --oneline)",
    "echo 'git log --oneline'; echo $(git log 2>&1 --oneline) && opaque-tool --version",
  ]) {
    const program = await BashProgram.parse(command, normalizerFor());
    assert.equal(program.commandText(), command);
    const nested = program.commands().find(unit => unit.managedGitRestrictions?.includes(inner));
    assert.ok(nested, "the exact source-bound nested unit retains its literal restrictions");
    assert.ok(nested.context || nested.parseUnresolved, "exercise the contextual/unresolved metadata path");
    assert.ok(nested.managedGitCompleted?.includes(inner), "completed argv restriction survives context");
    assert.equal(nested.managedGitRequest, true);
    assert.equal(program.commands().some(unit => unit.managedReadOnly), false, "neither nested Git nor siblings inherit an automatic grant");
    for (const unit of program.commands().filter(unit => unit !== nested)) {
      assert.equal(unit.managedGitRestrictions?.includes(inner) ?? false, false, "restriction metadata cannot migrate to siblings or quoted DATA");
      assert.equal(unit.managedGitCompleted?.includes(inner) ?? false, false);
    }
    for (const authority of [{ grants: bashGrant }, { yolo: true }, { grants: bashGrant, yolo: true }]) {
      const result = await run(command, { ...fixture, ...authority });
      assert.equal(result.resolver.checkGitBashRestriction(inner, fixture.agent)?.state, "deny");
      assert.equal(result.outcome.action, "block", "a recorded Bash grant or yolo cannot hide the nested exact deny");
      assert.equal(result.prompts.length, 0, "the configured deny wins before any approval");
      // run() also asserts unchanged actual input and no rewrite provenance.
    }
  }
  const dataOnly = "echo 'git log --oneline' && opaque-tool --version";
  const control = await BashProgram.parse(dataOnly, normalizerFor());
  assert.equal(control.commands().some(unit => unit.managedGitRequest || unit.managedReadOnly || unit.managedGitCompleted || unit.managedGitRestrictions), false,
    "quoted command DATA supplies neither Git restriction metadata nor an ALLOW");
  const ordinary = await run(dataOnly, fixture);
  assert.equal(ordinary.outcome.action, "block");
  assert.ok(ordinary.prompts.length > 0, "an unrelated opaque sibling still needs ordinary approval");
});

test("specific asks, full raw assignments, whole programs and completed spellings retain normal permission", async () => {
  for (const command of ["env git log --oneline", "PATH=./fixture-bin git status --short", "git status --short && git log --oneline", "git log 2>&1 --oneline"]) {
    const fixture = rawScope("project", "ask", command);
    const result = await run(command, fixture);
    assert.equal(result.outcome.action, "block"); assert.ok(result.prompts.length > 0);
    assert.equal((await run(command, { ...fixture, yolo: true })).outcome.action, "allow", "ordinary ask, no attribution floor");
    const denied = rawScope("project", "deny", command);
    assert.equal((await run(command, { ...denied, yolo: true, grants: bashGrant })).outcome.action, "block", "completed/raw exact deny survives");
  }
});

test("implicit history, hashes, batch objects and configured sources are review, not provenance claims", async () => {
  const before = readFileSync(join(cwd, ".git/config"));
  for (const command of ["git log -p -2", "git log --stat", "git show HEAD", `git cat-file -p ${"a".repeat(40)}`,
    "git grep needle HEAD", "git archive HEAD", "git cat-file --batch-all-objects --batch", "git cat-file --batch <<< HEAD"]) {
    const scope = nativeGitScope(command, normalizerFor());
    assert.notEqual(scope?.auto, true);
    assert.equal(has(scope?.ruleCandidates ?? [], ".env", "read"), false, "no guessed historical attribution");
    const ordinary = await run(command);
    assert.ok(ordinary.prompts.length > 0, command);
    assert.equal((await run(command, { yolo: true })).outcome.action, "allow", "normal approval/yolo may authorize opaque repository effects");
  }
  assert.deepEqual(readFileSync(join(cwd, ".git/config")), before, "analysis did not change synthetic config bytes");
  const source = readFileSync(join(packageRoot, "permission-system/managed-git-query.ts"), "utf8");
  assert.doesNotMatch(source, /node:child_process|execFileSync|spawnSync|managed-git-unattributed|find-object=/, "no process or historical attribution implementation");
});

test("gitfile worktrees keep literal root aliases without probing their object store", () => {
  const where = join(root, "worktree"), docs = join(where, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(where, ".git"), `gitdir: ${join(cwd, ".git/worktrees/fixture")}\n`);
  const scope = nativeGitScope("git show HEAD:private.txt", normalizerFor(docs));
  assert.equal(scope?.auto, false);
  assert.ok(scope.ruleCandidates.some(candidate => candidate.token === "private.txt" && candidate.path.matchValues().includes(join(where, "private.txt"))));
});

test("raw universal project denies survive grants; same-scope Bash allow exceptions still work", async () => {
  const file = join(root, "universal-deny.json"); writeJson(file, { permission: { "*": "deny" } });
  const result = await run("git log --oneline", { yolo: true, grants: bashGrant, managerOptions: { projectGlobalConfigPath: file } });
  assert.equal(result.outcome.action, "block"); assert.equal(result.prompts.length, 0);
  const config = policy("bash", { "*": "deny", "git status --short": "allow" });
  const exception = await run("git status --short", { config });
  assert.equal(exception.resolver.checkGitBashRestriction("git status --short", "editor"), undefined);
  assert.equal(exception.outcome.action, "allow");
});

test("non-Git fixed hardening and immutable/invalid-config floors stay independent", async () => {
  const input = { command: "command -v pi" };
  assert.ok(await hardenGitInput(input, cwd));
  assert.equal(input.command, "type -P -- pi");
  assert.deepEqual(originalGitCommands(input), ["command -v pi"]);
  const projectGlobalConfigPath = join(root, "invalid.json"); writeFileSync(projectGlobalConfigPath, "{invalid");
  const invalid = await run("git log --oneline", { yolo: true, grants: bashGrant, managerOptions: { projectGlobalConfigPath } });
  assert.equal(invalid.outcome.action, "block"); assert.ok(invalid.prompts.length > 0, "invalid config still fails closed, unlike retired attribution review");
  for (const command of ["git log -- .env", "git diff --output=.git/config"]) assert.equal((await run(command, { yolo: true })).outcome.action, "block");
});
