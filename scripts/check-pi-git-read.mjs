#!/usr/bin/env node
// Offline Git-read regression fixture. All Git mutations are confined to a new
// temporary tree; no remotes, credentials, provider calls or approval UI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [repo, executable, resources] = process.argv.slice(2);
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(repo && executable && resources && packageRoot, "REPO PI_EXECUTABLE GENERATED_RESOURCES and built PI_MANAGED_PERMISSIONS_ROOT required");
let piRoot = dirname(fs.realpathSync(executable));
while (!fs.existsSync(join(piRoot, "package.json"))) {
  const parent = dirname(piRoot);
  assert.notEqual(parent, piRoot, "Cannot locate Pi package root");
  piRoot = parent;
}
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") } });
const load = name => jiti.import(join(packageRoot, "src", `${name}.ts`));
// Initialize the authority module graph serially. Concurrent Jiti entry imports
// can instantiate the provenance WeakMap twice; that would not model one
// production authority and would silently drop originals in the pipeline.
const { hardenGitInput, managedGitProof, managedProgramProof, managedProgramAnalysis, originalGitCommands, gitLiteralWords, literalWords, managedReaderEffect } = await load("access-intent/bash/managed-read-policy");
const { BashProgram } = await load("access-intent/bash/program");
const { getParser } = await load("access-intent/bash/parser");
const { PermissionManager } = await load("policy/permission-manager");
const { PermissionResolver } = await load("policy/permission-resolver");
const { PathNormalizer } = await load("path/path-normalizer");
const { posixPathFlavor } = await load("path/path-flavor");
const { ToolCallGatePipeline } = await load("handlers/gates/tool-call-gate-pipeline");
const { resolveBashCommandCheck } = await load("handlers/gates/bash-command");
const { default: staticGuard, originalBashDeny } = await jiti.import(join(resources, "extensions/static-safety-guard.ts"));
const { describeBashPathGate } = await load("handlers/gates/bash-path");
const { renderPolicyDenial } = await load("presentation/agent-renderer");
const { SessionRules } = await load("session/session-rules");
const scratch = fs.mkdtempSync(join(tmpdir(), "pi-git-read-"));
const savedEnv = { ...process.env };
const config = JSON.parse(fs.readFileSync(join(resources, "extensions/pi-permission-system/config.json"), "utf8"));
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_") || name.startsWith("BASH_FUNC_")) delete process.env[name];
for (const name of ["home", "config", "template"]) fs.mkdirSync(join(scratch, name));
Object.assign(process.env, {
  HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "config"), PI_CODING_AGENT_DIR: resources,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", BASH_ENV: "/dev/null", ENV: "/dev/null",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});
const realGit = execFileSync("bash", ["--noprofile", "--norc", "-p", "-c", "type -P -- git"], { encoding: "utf8" }).trim();
assert(realGit.startsWith("/"));
const gitWithInput = (cwd, input, ...args) => execFileSync(realGit, [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false",
  "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
], { cwd, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 10000 });
const git = (cwd, ...args) => gitWithInput(cwd, undefined, ...args);
const init = (name, ...options) => {
  const cwd = join(scratch, name); fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q", `--template=${join(scratch, "template")}`, ...options);
  return cwd;
};
const normalizerFor = cwd => new PathNormalizer(posixPathFlavor, cwd);
const resolverFor = (policy = config, grants = []) => {
  const file = join(scratch, `policy-${policyOrdinal++}.json`);
  fs.writeFileSync(file, JSON.stringify(policy));
  return new PermissionResolver(new PermissionManager({ globalConfigPath: file, agentsDir: join(resources, "agents"), mcpServerNames: [] }), { getRuleset: () => grants });
};
let policyOrdinal = 0;
const shellWord = word => `'${word.replace(/'/g, "'\\''")}'`;
const execute = (cwd, command) => {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", command], { cwd, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const harden = async (cwd, command) => {
  const input = { command };
  assert(await hardenGitInput(input, cwd), `Must actually harden: ${command}`);
  assert.deepEqual(originalGitCommands(input), [command], "Original command provenance survives normalization");
  assert.equal(await hardenGitInput(input, cwd), undefined, "Idempotent hardening");
  return input;
};
const equivalent = async (cwd, command) => {
  const input = await harden(cwd, command);
  assert.deepEqual(execute(cwd, input.command), execute(cwd, command), `Literal argv/output roundtrip: ${command}`);
  assert(managedGitProof(input.command, normalizerFor(cwd)), `Complete Git proof: ${command}`);
  return input;
};
const guardHooks = new Map();
staticGuard({ on: (name, handler) => guardHooks.set(name, handler), events: { on: () => () => {}, emit() {} } });
const guardContext = (cwd, agentName) => ({ cwd, getSystemPrompt: () => "", sessionManager: {
  getSessionId: () => "git-read-fixture", getEntries: () => agentName ? [{ type: "custom", customType: "active_agent", data: { name: agentName } }] : [],
} });
const guard = (cwd, input, agentName) => guardHooks.get("tool_call")({ toolName: "bash", input }, guardContext(cwd, agentName));
// Real gate assembly: a collector records every pre-check without invoking an
// authorizer. Returning allow here only collects later surfaces; assertions
// below require each decision to allow, so an ask/deny is never accepted.
const gatesFor = async (cwd, input, resolver, agentName) => {
  const normalizer = normalizerFor(cwd);
  const pipeline = new ToolCallGatePipeline(resolver, {
    getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [], getToolPreviewLimits: () => ({}),
    getPathNormalizer: () => normalizer, getShellToolAliases: () => undefined,
  });
  const gates = [];
  await pipeline.evaluate({ toolCallId: "git-read-fixture", toolName: "bash", input, cwd, agentName }, {
    run: async gate => { if (gate) gates.push(gate); return { action: "allow" }; },
  });
  return gates;
};
const assertAllowed = async (cwd, input, resolver, agentName) => {
  const program = await BashProgram.parse(input.command, normalizerFor(cwd), { originalCommands: originalGitCommands(input) });
  assert(program.commands().length > 0);
  assert(program.commands().every(command => command.managedReadOnly), "Program admission must not discard env proof as an indirection wrapper");
  const tree = (await getParser()).parse(input.command);
  assert(tree);
  try { assert(managedProgramProof(tree.rootNode, normalizerFor(cwd)), "Entire literal program has proof"); }
  finally { tree.delete(); }
  assert.equal(resolveBashCommandCheck(input.command, program.commands(), agentName, resolver).state, "allow", "Real Bash wrapper floor must admit the proven env invocation");
  const gates = await gatesFor(cwd, input, resolver, agentName);
  assert(gates.some(gate => gate.surface === "bash"), "Real pipeline produced the Bash surface");
  for (const gate of gates) assert.equal(gate.preCheck?.state ?? gate.action, "allow", `Independent ${gate.surface} gate: ${input.command}`);
  assert.equal(guard(cwd, input, agentName)?.block, undefined, "Static guard must retain the env route after hardening");
};

async function checkOriginalDenyFloor(cwd, executionCommand) {
  const commands = ["env git show HEAD:ordinary.txt", "git log --oneline"];
  const policy = { ...config, permission: { ...config.permission, bash: {
    ...config.permission.bash, ...Object.fromEntries(commands.map(command => [command, "deny"])),
  } } };
  const denyRoot = join(scratch, "original-deny-root"), denyConfig = join(denyRoot, "extensions/pi-permission-system/config.json");
  fs.mkdirSync(dirname(denyConfig), { recursive: true }); fs.writeFileSync(denyConfig, JSON.stringify(policy));
  const sessions = new SessionRules();
  for (const pattern of ["env git *", "git *"]) sessions.approve("bash", pattern);
  const masked = resolverFor(policy, sessions.getRuleset()), ctx = guardContext(cwd);
  for (const command of commands) {
    const check = masked.resolve({ kind: "tool", surface: "bash", input: { command } });
    assert.equal(check.state, "allow", "The broad prior session grant can mask the exact config deny on the ordinary Bash surface");
    assert.equal(check.source, "session");
    assert(originalBashDeny(command, ctx, denyRoot), "Original static deny cannot be masked by a Bash session grant");
  }
  assert.equal(originalBashDeny(executionCommand, ctx, denyRoot), undefined, "Pinning changes the spelling: only a BEFORE-hardening check preserves this exact deny");
  assert(originalBashDeny(commands[0], ctx, join(scratch, "missing-deny-root")), "Missing original-deny policy fails closed");

  // Exercise the GENERATED wrapper body, not a guessed copy of its handler.
  // Only dependency import specifiers are substituted in a temporary test copy;
  // production registration, branching and call order remain byte-for-byte.
  const source = fs.readFileSync(join(dirname(packageRoot), "index.ts"), "utf8");
  assert(source.includes('import { originalBashDeny } from "../policy/static-safety-guard.ts";'), "Generated authority imports the original-command floor");
  const dependencySpecs = new Set([
    "@earendil-works/pi-coding-agent", "../../bin/runtime-support.mjs",
    "./vendor/src/policy/managed-resource-protection.ts", "./vendor/src/index.ts", "./authority-guard.ts",
    "./managed-scratch.ts", "./vendor/src/access-intent/bash/managed-read-policy.ts",
    "../policy/static-safety-guard.ts", "./vendor/src/service.ts",
  ]);
  const seenSpecs = new Set();
  const testSource = source.replace(/(^import[^\n]* from |^export[^\n]* from )"([^"]+)"/gm, (_match, prefix, specifier) => {
    assert(dependencySpecs.has(specifier), `Review new generated authority dependency: ${specifier}`);
    seenSpecs.add(specifier);
    return `${prefix}"./authority-dependencies.mjs"`;
  });
  assert.deepEqual([...seenSpecs].sort(), [...dependencySpecs].sort(), "Every authority dependency is explicitly mocked");
  const testWrapper = join(scratch, "authority-order.ts"), dependencies = join(scratch, "authority-dependencies.mjs");
  const bridgeKey = Symbol.for("@rocklee/pi-alehouse:test-original-deny-order"), previousBridge = globalThis[bridgeKey];
  const state = { trace: [], hardenCalls: 0, executionCommand,
    deny: (command, context) => originalBashDeny(command, context, denyRoot) };
  globalThis[bridgeKey] = state;
  fs.writeFileSync(testWrapper, testSource);
  fs.writeFileSync(dependencies, `const state = globalThis[Symbol.for("@rocklee/pi-alehouse:test-original-deny-order")];
export const getPackageDir = () => "/fixture-host", packageRoot = "/fixture-package";
export const protectionResources = () => ({}), initializeManagedResourceProtection = () => {};
export const getManagedResourceProtection = () => ({}), getPermissionsService = () => undefined;
export const guardSingleAuthority = () => {};
export function originalBashDeny(command, ctx) { state.trace.push("original-deny"); return state.deny(command, ctx); }
export async function hardenGitInput(input) { state.trace.push("hardener/probes"); state.hardenCalls++; input.command = state.executionCommand; return { version: 1, originalDigest: "fixture", executionDigest: "fixture" }; }
export const hardenStaticFileInput = () => undefined;
export function installManagedScratch(pi) { pi.on("tool_call", () => { state.trace.push("scratch-gate"); }); }
export default function permissions(pi) { pi.on("tool_call", () => { state.trace.push("permission-gate"); }); }
`);
  try {
    const { default: authority } = await jiti.import(testWrapper);
    const hooks = [];
    authority({ on: (name, handler) => { if (name === "tool_call") hooks.push(handler); },
      appendEntry: (name) => { assert.equal(name, "managed-git-read"); state.trace.push("audit"); } });
    assert.equal(hooks.length, 3, "Generated pre-hardener registers ahead of mocked scratch and permission handlers");
    const dispatch = async input => {
      for (const hook of hooks) {
        const result = await hook({ toolName: "bash", input }, ctx);
        if (result?.block) return result;
      }
    };
    for (const command of commands) {
      state.trace.length = 0;
      const input = { command }, result = await dispatch(input);
      assert.equal(result?.block, true);
      assert.match(result.reason, /original command before managed hardening/);
      assert.equal(input.command, command, "Exact-denied input must never be rewritten or pinned");
      assert.equal(state.hardenCalls, 0, "Original deny blocks before every hardener/object probe");
      assert.deepEqual(state.trace, ["original-deny"], "Blocked original command cannot reach later gates or audit");
    }
    state.trace.length = 0;
    const allowed = { command: "env git status --short" };
    assert.equal(await dispatch(allowed), undefined, "Non-denied control reaches the unchanged downstream chain");
    assert.equal(allowed.command, executionCommand);
    assert.deepEqual(state.trace, ["original-deny", "hardener/probes", "audit", "scratch-gate", "permission-gate"]);
  } finally {
    if (previousBridge === undefined) delete globalThis[bridgeKey]; else globalThis[bridgeKey] = previousBridge;
  }
  console.log("PASS: raw exact static denies survive broad prior Bash session grants before generated-wrapper hardening/probes");
}

async function checkProofDiagnostic(cwd, input, resolver, expectedCode) {
  const normalizer = normalizerFor(cwd), program = await BashProgram.parse(input.command, normalizer);
  assert.equal(program.commands()[0]?.managedGitDiagnostic?.code, expectedCode);
  assert(!program.commands().some(command => command.managedReadOnly));
  const tree = (await getParser()).parse(input.command); assert(tree);
  try {
    const analysis = managedProgramAnalysis(tree.rootNode, normalizer);
    assert.equal(analysis.proof, undefined); assert.equal(analysis.diagnostics[0]?.code, expectedCode);
  } finally { tree.delete(); }
  // Remove only presentation metadata from a projection of the REAL parser's
  // path facts. The same deciding token/surface/state must remain unchanged.
  const diagnosticless = { commandText: () => program.commandText(), pathRuleCandidates: () => program.pathRuleCandidates(),
    commands: () => program.commands().map(({ managedGitDiagnostic: _diagnostic, ...command }) => command) };
  const context = { toolCallId: "diagnostic-fixture", toolName: "bash", cwd, agentName: "reader" };
  const before = describeBashPathGate(context, diagnosticless, resolver, normalizer);
  const after = describeBashPathGate(context, program, resolver, normalizer);
  assert(before?.preCheck && after?.preCheck, "A reader's unproven explicit file operand produces the real path-family denial");
  const decision = gate => ({ token: gate.input.path, surface: gate.surface, state: gate.preCheck.state, value: gate.decision.value });
  assert.deepEqual(decision(after), decision(before), "Diagnostics cannot change path authority or blame");
  assert.equal(after.input.path, "ordinary.txt"); assert.equal(after.surface, "path"); assert.equal(after.preCheck.state, "deny");
  assert(after.payload.evidence.some(entry => entry.label === "managed Git proof unavailable" && entry.text.includes(expectedCode)));
  const rendered = renderPolicyDenial(after.payload, null);
  assert.match(rendered, /Complete managed Git read-only proof unavailable/); assert(rendered.includes(expectedCode));
  assert(!/needs approval|requires approval|approval required/i.test(rendered), "Missing proof is not a promise of an approval route");
}

try {
  const cwd = init("main"), normalizer = normalizerFor(cwd), resolver = resolverFor();
  fs.mkdirSync(join(cwd, "docs")); fs.mkdirSync(join(cwd, "Vault"));
  for (const [file, text] of [["ordinary.txt", "ordinary before\n"], ["docs/space name.txt", "space before\n"], ["docs/owner's note.txt", "apostrophe before\n"], [".env", "PROTECTED_SYNTHETIC_MARKER\n"], ["Vault/.env", "CASE_SYNTHETIC_BEFORE\n"]]) fs.writeFileSync(join(cwd, file), text);
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "base"); git(cwd, "branch", "review-base");
  fs.writeFileSync(join(cwd, "ordinary.txt"), "ordinary after\n"); git(cwd, "add", "ordinary.txt"); git(cwd, "commit", "-qm", "second");
  guardHooks.get("session_start")({}, guardContext(cwd));

  for (const command of [
    "git log --format='%H %P %s' review-base..HEAD", "env git log --format='%H %P %s' review-base..HEAD",
    "git log -6 --format='%h %ad %s' --date=iso-local", "git log --format='%h %ad' --date=format:'%Y %m'",
    "git log --format='%ad' --date=format-local:'%Y %m'", 'git log --format="owner\'s %s"',
    "git log --oneline -- docs/'space name.txt'", "env git log --oneline -- docs/'space name.txt'", "env git show HEAD:docs/'space name.txt'",
    "git log --oneline ^review-base HEAD", "git log --oneline HEAD --not review-base",
    "git log --oneline review-base...HEAD", "git log --oneline review-base HEAD",
    "git log --graph --topo-order --date-order --decorate=full --oneline", "git log --reverse --oneline",
  ]) {
    const input = await equivalent(cwd, command);
    for (const agent of [undefined, "editor", "reader"]) await assertAllowed(cwd, input, resolver, agent);
  }
  for (const globals of ["--no-lazy-fetch", "--no-lazy-fetch --no-pager", "--no-lazy-fetch --no-optional-locks", "--no-optional-locks --no-pager"]) {
    const command = `git ${globals} log --no-show-signature --oneline --`;
    assert.equal(managedGitProof(command, normalizer), undefined, `Incomplete EXECUTED hardening never proves: ${globals}`);
    assert(!((await BashProgram.parse(command, normalizer)).commands().some(command => command.managedReadOnly)));
  }
  const roundtrip = await harden(cwd, 'git log --format="owner\'s %s"');
  assert.deepEqual(gitLiteralWords(roundtrip.command).filter(word => word.startsWith("--format=")), ["--format=owner's %s"]);
  assert.deepEqual(gitLiteralWords("git log --format='a'\"b\"'c %s'"), ["git", "log", "--format=abc %s"]);
  assert.deepEqual(gitLiteralWords('env git show HEAD:"docs/owner\'s note.txt"'), ["env", "git", "show", "HEAD:docs/owner's note.txt"], "Decoder roundtrip is broader than the conservative path grammar");
  for (const command of ['env git show HEAD:"docs/owner\'s note.txt"', 'env git log --oneline -- "docs/owner\'s note.txt"', 'git log --format="%ad" --date=format:"%Y owner\'s"']) {
    const input = { command };
    assert.equal(await hardenGitInput(input, cwd), undefined, "A decoded apostrophe does not widen the path/date grammar");
    assert.equal(input.command, command);
    const program = await BashProgram.parse(command, normalizer);
    assert(!program.commands().some(command => command.managedReadOnly), "Unsupported path/date spelling cannot obtain complete program proof");
  }
  for (const prefix of ["git", "env git"]) {
    const raw = `${prefix} log A=b:~`;
    assert.equal(gitLiteralWords(raw), undefined, "Unquoted assignment-like colon tilde is an expansion position, not a literal Git operand");
    for (const command of [raw, `${prefix} log 'A=b:~'`, `${prefix} log A=b:'~'`]) {
      if (command !== raw) assert.deepEqual(gitLiteralWords(command), [...prefix.split(" "), "log", "A=b:~"], "Quoted tilde stays literal in the Git-only decoder");
      const input = { command };
      assert.equal(await hardenGitInput(input, cwd), undefined, "Neither decoded quoted operand nor raw expansion widens the Git grammar");
      assert.equal(input.command, command);
      assert.equal(managedGitProof(command, normalizer), undefined);
      assert(!((await BashProgram.parse(command, normalizer)).commands().some(unit => unit.managedReadOnly)));
    }
  }
  // Git-only decoder must not widen sed/scratch/other managed reader languages.
  for (const source of ["sed -n '1'p ordinary.txt", "mkdir -p out/'space name'", 'cp "owner\'s"\' note\' target']) assert.equal(literalWords(source), undefined, `Legacy literal grammar unchanged: ${source}`);
  assert.equal(managedReaderEffect("sed -n '1'p ordinary.txt"), undefined);

  const safeTokens = ["%H", "%h", "%T", "%t", "%P", "%p", "%an", "%ae", "%ad", "%aD", "%ar", "%at", "%ai", "%aI", "%cn", "%ce", "%cd", "%cr", "%ct", "%ci", "%cI", "%s", "%f", "%b", "%N", "%D", "%gD", "%gd", "%gn", "%ge", "%gs", "%n", "%%", "%%G?"];
  for (const option of ["--format", "--pretty"]) {
    for (const format of [safeTokens.join(" "), `format:${safeTokens.join(" ")}`, `tformat:${safeTokens.join(" ")}`]) {
      const input = await equivalent(cwd, `git log ${option}=${shellWord(format)}`);
      assert.equal(guard(cwd, input)?.block, undefined);
    }
    for (const format of ["%G?", "%GG", "%GS", "%GK", "%GF", "%GP", "%GT", "%x00", "%<(20)%s", "%C(red)%s", "%(trailers)", "review", "format:%G?", "tformat:%G?"]) {
      const command = `git log ${option}=${shellWord(format)}`, input = { command };
      assert.equal(await hardenGitInput(input, cwd), undefined, `Unsafe format/alias not normalized: ${format}`);
      assert.equal(input.command, command);
      assert.equal(managedGitProof(`git --no-lazy-fetch --no-optional-locks --no-pager log --no-show-signature ${option}=${shellWord(format)} --`, normalizer), undefined, `Unsafe format/alias not proven: ${format}`);
      assert.equal(guard(cwd, input)?.block, true, `Static format boundary: ${format}`);
    }
  }

  // Metadata pathspec has READ scope without any repository/name traversal.
  const pathLog = await harden(cwd, "env git log --oneline -- docs/'space name.txt'");
  const noProbeBin = join(scratch, "no-probe-bin"), noProbeMarker = join(scratch, "metadata-probed"); fs.mkdirSync(noProbeBin);
  fs.writeFileSync(join(noProbeBin, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(noProbeMarker)}, 'unexpected'); process.exit(2);\n`, { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${noProbeBin}:${previousPath}`;
  let logProof;
  try { logProof = managedGitProof(pathLog.command, normalizer); }
  finally { process.env.PATH = previousPath; }
  assert(logProof); assert(!fs.existsSync(noProbeMarker), "Log pathspec metadata proof performs zero Git probes");
  assert(logProof.ruleCandidates.some(candidate => candidate.token === "docs/space name.txt" && candidate.effect.effect === "read"));
  assert.equal(guard(cwd, { command: "git log --oneline -- ordinary.txt" })?.block, undefined, "Bare metadata log pathspec now uses the same independent path gates");
  for (const command of ["git log --oneline -- ':(glob)*'", "git log --oneline -- ../ordinary.txt", "git log --oneline -- ordinary.txt ':(glob)*'", "git log --oneline -- '$HOME'"]) {
    assert.equal(guard(cwd, { command })?.block, true, `Static log validates EVERY literal pathspec, not just the separator: ${command}`);
    assert.equal(await hardenGitInput({ command }, cwd), undefined, "Unsupported log pathspec does not gain a managed proof");
  }
  // Exercise the REAL parser/gates on unnormalized execution, not a guessed
  // fallback. The static metadata lane is not automatic managed authorization.
  for (const command of ["git log --oneline -- ordinary.txt", "git log --oneline -- .env"]) {
    const input = { command }, program = await BashProgram.parse(command, normalizer);
    assert.equal(managedGitProof(command, normalizer), undefined, "Raw log lacks required execution hardening");
    assert(!program.commands().some(unit => unit.managedReadOnly));
    assert.equal(guard(cwd, input)?.block, undefined, "Static metadata log allowance does not claim a managed proof");
    assert.equal(resolveBashCommandCheck(command, program.commands(), "reader", resolver).state, "ask", "No-proof bare log keeps ordinary Bash review");
    const gates = await gatesFor(cwd, input, resolver, "reader");
    assert.equal(gates.find(gate => gate.surface === "bash")?.preCheck.state, "ask");
    if (command.endsWith(".env")) assert(gates.some(gate => gate.surface.startsWith("path") && gate.preCheck?.state === "deny"), "Protected no-proof fallback retains independent path denial");
  }
  const sessionRules = new SessionRules(); sessionRules.approve("bash", "git *");
  const sessionResolver = resolverFor(config, sessionRules.getRuleset());
  for (const command of ["git log --oneline -- .env", "env git log --oneline -- .env", "env git show HEAD:.env"]) {
    const input = await harden(cwd, command);
    assert(managedGitProof(input.command, normalizer), "Syntax/content proof is not a policy grant");
    for (const agent of [undefined, "editor", "reader"]) for (const local of [resolver, sessionResolver]) {
      const denied = (await gatesFor(cwd, input, local, agent)).find(gate => gate.preCheck?.state === "deny" && gate.surface === "path_read");
      assert(denied, "Real protected READ gate wins env proof");
      assert(!denied.payload.evidence.some(entry => entry.label === "managed Git proof unavailable"), "A successful protected READ proof is not mislabeled as missing proof");
      assert(!renderPolicyDenial(denied.payload, null).includes("Complete managed Git read-only proof unavailable"));
    }
  }
  const blobInput = await harden(cwd, "env git show HEAD:ordinary.txt");
  assert(blobInput.command.startsWith("env git "), "Normalization must not strip the static-guard route");
  assert.match(blobInput.command, /--no-replace-objects/);
  assert.match(blobInput.command, /--no-textconv/); assert.match(blobInput.command, /--no-ext-diff/);
  assert.match(blobInput.command, /[0-9a-f]{40,64}:ordinary\.txt/, "Mutable revision is pinned to an immutable tree OID");
  assert.equal(guard(cwd, { command: "git show HEAD:ordinary.txt" })?.block, true, "Bare content show retains independent static floor");
  assert.equal(guard(cwd, { command: blobInput.command.replace(/^env /, "") })?.block, true, "Even pinned bare content is not a static metadata allowance");
  await checkOriginalDenyFloor(cwd, blobInput.command);
  for (const command of ["git log --oneline -- ordinary.txt", "env git log --oneline", "env git show HEAD:ordinary.txt"]) {
    const input = await harden(cwd, command);
    const surfaces = [["outer-original", command], ["outer-execution", input.command], ...(command.startsWith("env ") ? [["inner-original", command.slice(4)], ["inner-execution", input.command.slice(4)]] : [])];
    for (const [surface, pattern] of surfaces) for (const action of ["ask", "deny"]) {
      const local = resolverFor({ ...config, permission: { ...config.permission, bash: { ...config.permission.bash, [pattern]: action } } });
      const gates = await gatesFor(cwd, input, local);
      assert.equal(gates.find(gate => gate.surface === "bash")?.preCheck.state, action, `${surface} ${action} preserved: ${command}`);
    }
    // Resolver projections only: fabricated session ask/deny records test
    // original-spelling matching, NOT real SessionRules or runner enforcement.
    // Real SessionRules.approve emits allow; its runner fast-paths source=session.
    for (const [surface, pattern] of surfaces) for (const action of ["ask", "deny"]) {
      const local = resolverFor(config, [{ surface: "bash", pattern, action, layer: "session", origin: "session" }]);
      assert.equal((await gatesFor(cwd, input, local)).find(gate => gate.surface === "bash")?.preCheck.state, action, `${surface} fabricated session ${action}: resolver projection only`);
    }
    for (const action of ["ask", "deny"]) {
      const local = resolverFor({ ...config, permission: { ...config.permission, managed_static_read: action } });
      assert.notEqual((await gatesFor(cwd, input, local)).find(gate => gate.surface === "bash")?.preCheck.state, "allow", `Opt-out survives env wrapper: ${command}`);
    }
  }
  for (const prefix of ["env FOO=1", "env GIT_DIR=.git", "env GIT_WORK_TREE=.", "env GIT_INDEX_FILE=alternate", "env GIT_CONFIG_COUNT=0", "env -i", "env --", "env -u HOME", "timeout 5", "nice -n 5", "command", "FOO=1", "A=b:~"]) {
    const input = { command: `${prefix} git log --oneline` };
    assert.equal(await hardenGitInput(input, cwd), undefined, `Unsupported wrapper not hardened: ${prefix}`);
    assert.equal(managedGitProof(`${prefix} git --no-lazy-fetch --no-optional-locks --no-pager log --no-show-signature --oneline --`, normalizer), undefined);
    const program = await BashProgram.parse(input.command, normalizer);
    assert(!program.commands().some(command => command.managedReadOnly), `Unsupported wrapper cannot enter full-program proof: ${prefix}`);
  }
  for (const sub of ["add ordinary.txt", "commit -m fixture", "push origin main", "fetch origin", "switch main", "rebase main", "reset --hard", "stash push", "checkout main"]) for (const prefix of ["git", "env git"]) {
    const input = { command: `${prefix} ${sub}` };
    assert.equal(await hardenGitInput(input, cwd), undefined);
    const program = await BashProgram.parse(input.command, normalizer);
    assert(!program.commands().some(command => command.managedReadOnly));
    for (const agent of ["editor", "reader"]) assert.equal(guard(cwd, input, agent)?.block, true, `Worker mutation floor: ${input.command}`);
  }
  for (const command of ["git diff --ext-diff", "git diff --textconv", "git diff --output=ordinary.txt", "env git -c core.pager=cat log --oneline", "env git --git-dir=.git log --oneline", "env git --work-tree=. log --oneline"]) {
    const input = { command }; assert.equal(await hardenGitInput(input, cwd), undefined);
    assert(!((await BashProgram.parse(command, normalizer)).commands().some(command => command.managedReadOnly)));
  }
  for (const command of ["git diff --ext-diff", "git ls-files --recurse-submodules"]) assert.equal(guard(cwd, { command })?.block, undefined, "Static Git query set must not expand to diff/ls-files");
  for (const command of ["git log --oneline -- ordinary.txt && git add ordinary.txt", "git log --oneline -- ordinary.txt; printf unsafe > ordinary.txt"]) {
    const input = { command }; await hardenGitInput(input, cwd);
    const program = await BashProgram.parse(input.command, normalizer);
    assert(!program.commands().every(unit => unit.managedReadOnly), "Bare path log cannot manufacture a whole-program proof for mixed fallback");
    const tree = (await getParser()).parse(input.command); assert(tree);
    try { assert.equal(managedProgramProof(tree.rootNode, normalizer), undefined); }
    finally { tree.delete(); }
  }
  console.log("PASS: quoted Git argv/pretty/date/revision roundtrips, bare/env log READ scope and protected session floor, full env gates, original inner/outer rules and opt-out");

  // ls-tree's blob label is insufficient when replacement changes actual type.
  const blob = git(cwd, "rev-parse", "HEAD:ordinary.txt").trim(), head = git(cwd, "rev-parse", "HEAD").trim();
  const protectedCommit = git(cwd, "rev-parse", "review-base").trim();
  git(cwd, "replace", "-f", blob, protectedCommit);
  assert.equal(git(cwd, "cat-file", "-t", "HEAD:ordinary.txt").trim(), "commit", "Replacement vulnerability fixture is active");
  assert(execute(cwd, "git show HEAD:ordinary.txt").includes("PROTECTED_SYNTHETIC_MARKER"), "Unsafe replacement exposes unrelated protected patch content");
  const replacedInput = await harden(cwd, "env git show HEAD:ordinary.txt");
  assert.equal(execute(cwd, replacedInput.command), "ordinary after\n", "Execution and proof share replacement-disabled blob semantics");
  assert(!execute(cwd, replacedInput.command).includes("PROTECTED_SYNTHETIC_MARKER"));
  await assertAllowed(cwd, replacedInput, resolver, "reader");
  git(cwd, "replace", "-d", blob);
  // A blob-to-blob replacement preserves the type check but changes patch
  // contents. Also cover GIT_REPLACE_REF_BASE, not only default loose refs.
  const protectedBlob = git(cwd, "rev-parse", "HEAD:.env").trim();
  for (const namespace of ["refs/replace/", "refs/fixture-replacements/"]) {
    git(cwd, "update-ref", `${namespace}${blob}`, protectedBlob);
    process.env.GIT_REPLACE_REF_BASE = namespace;
    try {
      const unsafe = "git diff HEAD~1 HEAD --no-renames -p -- ordinary.txt";
      assert(execute(cwd, unsafe).includes("PROTECTED_SYNTHETIC_MARKER"), `${namespace}: replacement leak fixture must be active`);
      for (const suffix of ["-p", "--stat", "--numstat", "--summary"]) {
        const command = `git diff HEAD~1 HEAD --no-renames ${suffix} -- ordinary.txt`, input = await harden(cwd, command);
        assert(gitLiteralWords(input.command).includes("--no-replace-objects"), "Every diff execution, including summary, disables replacements");
        const output = execute(cwd, input.command);
        assert(!output.includes("PROTECTED_SYNTHETIC_MARKER"), "Patch cannot disclose a replacement's protected blob");
        assert.equal(output, execute(cwd, `git --no-replace-objects diff HEAD~1 HEAD --no-renames ${suffix} -- ordinary.txt`), "Diff output matches replacement-disabled semantics");
        const proof = managedGitProof(input.command, normalizer); assert(proof, "Replacement-disabled diff retains ordinary path proof");
        assert(proof.ruleCandidates.some(candidate => candidate.token === "ordinary.txt"));
        assert(!proof.ruleCandidates.some(candidate => candidate.token === ".env"));
        assert.equal(managedGitProof(input.command.replace(/--no-replace-objects\s+/, ""), normalizer), undefined, "Missing EXECUTED replacement control cannot prove diff");
      }
    } finally {
      delete process.env.GIT_REPLACE_REF_BASE;
      git(cwd, "update-ref", "-d", `${namespace}${blob}`);
    }
  }
  git(cwd, "update-ref", "HEAD", protectedCommit);
  assert.equal(execute(cwd, "env git show HEAD:ordinary.txt"), "ordinary before\n", "Original revision moved after hardening");
  assert.equal(execute(cwd, replacedInput.command), "ordinary after\n", "Pinned execution cannot follow a later mutable revision");
  git(cwd, "update-ref", "HEAD", head);
  // An invalid-but-readable tree can label a commit OID as a blob. Verify the
  // actual type, not only ls-tree's mode-derived label (even with no replaces).
  const forgedTree = gitWithInput(cwd, Buffer.concat([Buffer.from("100644 forged.txt\0"), Buffer.from(head, "hex")]), "hash-object", "--literally", "-t", "tree", "-w", "--stdin").trim();
  assert.match(git(cwd, "ls-tree", forgedTree), /100644 blob/);
  assert.equal(git(cwd, "cat-file", "-t", `${forgedTree}:forged.txt`).trim(), "commit");
  const forged = { command: `env git show ${forgedTree}:forged.txt` };
  assert.equal(await hardenGitInput(forged, cwd), undefined, "Mode-derived blob label cannot bypass actual type verification");
  assert.equal(managedGitProof(`env git --no-lazy-fetch --no-optional-locks --no-pager --no-replace-objects show --no-show-signature --no-ext-diff --no-textconv ${forgedTree}:forged.txt`, normalizer), undefined);
  git(cwd, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/link`); git(cwd, "commit", "-qm", "gitlink");
  for (const object of ["HEAD:vendor/link", "HEAD:docs", ":0:ordinary.txt", ":1:ordinary.txt", "HEAD:./ordinary.txt", "HEAD:../ordinary.txt"]) {
    const input = { command: `env git show ${object}` };
    assert.equal(await hardenGitInput(input, cwd), undefined, `Non-root/blob target cannot be hardened: ${object}`);
    assert.equal(managedGitProof(`env git --no-lazy-fetch --no-optional-locks --no-pager --no-replace-objects show --no-show-signature --no-ext-diff --no-textconv ${object}`, normalizer), undefined);
  }
  const subdir = join(cwd, "docs");
  const separated = init("separated", `--separate-git-dir=${join(scratch, "admin")}`), bare = init("bare", "--bare");
  fs.writeFileSync(join(separated, "ordinary.txt"), "separated\n"); git(separated, "add", "."); git(separated, "commit", "-qm", "base");
  for (const unsupported of [subdir, separated, bare]) {
    const input = { command: "env git show HEAD:ordinary.txt" };
    assert.equal(await hardenGitInput(input, unsupported), undefined, "Unknown layout/subdirectory content hardening declines");
    const diffInput = { command: "git diff" }; await hardenGitInput(diffInput, unsupported);
    assert.equal(managedGitProof(diffInput.command, normalizerFor(unsupported)), undefined, "Unknown layout/subdirectory content diff proof declines");
  }

  const linked = join(scratch, "linked"); git(cwd, "worktree", "add", "-q", "--detach", linked, "HEAD");
  fs.writeFileSync(join(linked, "ordinary.txt"), "linked after\n");
  const linkedInput = await equivalent(linked, "git diff -- ordinary.txt"), linkedProof = managedGitProof(linkedInput.command, normalizerFor(linked));
  assert(linkedProof.ruleCandidates.some(candidate => candidate.path.boundaryValue() === cwd && candidate.effect.effect === "read"), "Standard linked worktree includes main root READ candidate");
  assert(!linkedProof.ruleCandidates.some(candidate => candidate.path.boundaryValue().includes("/.git")), "Git administration directories are not user path candidates");
  await assertAllowed(linked, linkedInput, resolver, "reader");
  const externalMain = resolverFor({ ...config, permission: { ...config.permission,
    external_directory: { "*": "ask" }, external_directory_read: { "*": "ask" } } });
  assert((await gatesFor(linked, linkedInput, externalMain, "reader")).some(gate => gate.surface === "external_directory_read" && gate.preCheck?.state === "ask"), "Out-of-scope main root remains an independent ask");
  const separatedLinked = join(scratch, "separated-linked"); git(separated, "worktree", "add", "-q", "--detach", separatedLinked, "HEAD");
  const unknownLayout = await harden(separatedLinked, "git diff");
  assert.equal(managedGitProof(unknownLayout.command, normalizerFor(separatedLinked)), undefined, "Linked worktree with separated common gitdir cannot invent a main root");

  fs.writeFileSync(join(cwd, "Vault/.env"), "CASE_SYNTHETIC_CHANGED\n");
  process.env.GIT_ICASE_PATHSPECS = "1";
  try {
    const input = await harden(cwd, "git diff -- vault");
    assert(execute(cwd, input.command).includes("CASE_SYNTHETIC_CHANGED"), "Case-insensitive fixture selects the actual protected content");
    const proof = managedGitProof(input.command, normalizer);
    assert(proof?.ruleCandidates.some(candidate => candidate.token === "Vault/.env"), "Retain Git's actual changed path rather than a JS case-sensitive refilter");
    assert((await gatesFor(cwd, input, resolver, "reader")).some(gate => gate.surface === "path_read" && gate.preCheck?.state === "deny"));
  } finally { delete process.env.GIT_ICASE_PATHSPECS; }
  for (const key of ["remote.fixture.promisor", "remote.fixture.partialclonefilter", "extensions.partialclone"]) {
    git(cwd, "config", key, key.endsWith("promisor") ? "true" : "fixture");
    const input = await harden(cwd, "git diff");
    assert.equal(managedGitProof(input.command, normalizer), undefined, `Partial-clone content proof declines: ${key}`);
    if (key === "remote.fixture.promisor") await checkProofDiagnostic(cwd, await harden(cwd, "git diff -- ordinary.txt"), resolver, "git-partial-clone");
    const show = { command: "env git show HEAD:ordinary.txt" };
    assert.equal(await hardenGitInput(show, cwd), undefined, "Partial-clone show cannot acquire pinned content proof");
    git(cwd, "config", "--unset", key);
  }
  const indexHelperCanary = join(scratch, "index-helper-invoked"), indexHelper = join(scratch, "index-helper");
  fs.writeFileSync(indexHelper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(indexHelperCanary)}, 'invoked'); process.exit(1);\n`, { mode: 0o700 });
  for (const [key, value] of [["core.fsmonitor", indexHelper], ["core.fsmonitor", "false"], ["filter.fixture.clean", indexHelper], ["filter.fixture.process", indexHelper]]) {
    git(cwd, "config", key, value);
    for (const command of ["git status --short", "git ls-files", "git diff", "git diff --stat"]) {
      const input = await harden(cwd, command);
      assert.equal(managedGitProof(input.command, normalizer), undefined, `Presence of helper config conservatively declines proof: ${key}=${value}`);
      assert(!fs.existsSync(indexHelperCanary), "Configuration rejection happens before any configured index/content helper");
    }
    if (key === "core.fsmonitor" && value === indexHelper)
      await checkProofDiagnostic(cwd, await harden(cwd, "git diff -- ordinary.txt"), resolver, "git-helper-config");
    git(cwd, "config", "--unset", key);
  }
  console.log("PASS: replacement-disabled pinned blobs, actual blob type, gitlink/tree/stage/relative rejects, worktree root scope, partial-clone, helper config, diagnostic-only denial and case-sensitive path deny regressions");

  // Fabricated signature: prove the canary is reachable without hardening, then
  // ensure both config-triggered and named-pretty-triggered verification close.
  const gpgCanary = join(scratch, "gpg-invoked"), fakeGpg = join(scratch, "fake-gpg");
  fs.writeFileSync(fakeGpg, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(gpgCanary)}, 'invoked'); process.exit(1);\n`, { mode: 0o700 });
  const treeOid = git(cwd, "rev-parse", "HEAD^{tree}").trim();
  const signed = gitWithInput(cwd, `tree ${treeOid}\nparent ${git(cwd, "rev-parse", "HEAD").trim()}\nauthor Fixture <fixture@example.invalid> 1767225600 +0000\ncommitter Fixture <fixture@example.invalid> 1767225600 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n synthetic\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`, "hash-object", "-t", "commit", "-w", "--stdin").trim();
  git(cwd, "update-ref", "HEAD", signed); git(cwd, "config", "gpg.program", fakeGpg);
  git(cwd, "config", "pretty.review", "format:%G?"); git(cwd, "config", "log.showSignature", "true");
  execute(cwd, "git log -1 --format=%s"); assert(fs.existsSync(gpgCanary), "Configured signature verification canary must be reachable"); fs.rmSync(gpgCanary);
  for (const command of ["git log -1 --oneline", "git log -1", "git show -s HEAD^0", "env git show HEAD:ordinary.txt"]) {
    const input = await harden(cwd, command); assert.match(input.command, /--no-show-signature/);
    if (!command.includes("--oneline") && !command.includes(":ordinary.txt")) assert.match(input.command, /--format=medium/, "Unspecified format is safety-normalized, not config-controlled");
    execute(cwd, input.command); assert(!fs.existsSync(gpgCanary), `No config-triggered signature helper: ${command}`);
  }
  git(cwd, "config", "format.pretty", "review");
  const defaultFormat = await harden(cwd, "git log -1"); execute(cwd, defaultFormat.command);
  assert(!fs.existsSync(gpgCanary), "Explicit medium suppresses configured pretty alias");
  for (const option of ["--format", "--pretty"]) {
    execute(cwd, `git log -1 --no-show-signature ${option}=review`);
    assert(fs.existsSync(gpgCanary), "Named alias still invokes GPG even with no-show-signature"); fs.rmSync(gpgCanary);
    const input = { command: `git log -1 ${option}=review` };
    assert.equal(await hardenGitInput(input, cwd), undefined);
    const escaped = await harden(cwd, `git log -1 ${option}='%%G?'`);
    assert.equal(execute(cwd, escaped.command), "%G?\n"); assert(!fs.existsSync(gpgCanary), "Escaped percent is literal, not a signature token");
  }
  git(cwd, "config", "--unset", "log.showSignature"); git(cwd, "config", "--unset", "format.pretty");
  console.log("PASS: active fake-GPG canaries for config/default/named pretty, escaped %%G? and no-show-signature normalization");

  // Fail/timeout each content probe stage. Delegate every other operation to
  // the trusted absolute Git binary; the fake helper cannot contact a network.
  const probeBin = join(scratch, "probe-bin"), probeControl = join(scratch, "probe-control.json"), probeCalls = join(scratch, "probe-calls.jsonl");
  fs.mkdirSync(probeBin);
  fs.writeFileSync(join(probeBin, "git"), `#!${process.execPath}\nconst fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), control = JSON.parse(fs.readFileSync(${JSON.stringify(probeControl)}, 'utf8'));
const sub = args.find(arg => ['rev-parse', 'config', 'ls-tree', 'cat-file', 'ls-files', 'diff'].includes(arg));
fs.appendFileSync(${JSON.stringify(probeCalls)}, JSON.stringify({ sub, args, cwd: process.cwd() }) + '\\n');
if (control.mode === 'record-only') process.exit(2);
if (control.mode === 'malformed-stage' && sub === 'ls-files' && (args.includes('--stage') || args.includes('-s'))) {
  process.stdout.write(control.output); process.exit(0);
}
if (sub === control.sub) {
  if (control.mode === 'timeout') setTimeout(() => process.exit(2), 60000);
  else process.exit(2);
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8', timeout: 10000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 2);
}\n`, { mode: 0o700 });
  const diffInput = await harden(cwd, "git diff -- ordinary.txt"), showInput = await harden(cwd, "env git show HEAD:ordinary.txt");
  const externalAlias = join(cwd, "external-alias"); fs.symlinkSync(separated, externalAlias, "dir");
  fs.mkdirSync(join(separated, "physical-child"));
  fs.symlinkSync(join(separated, "physical-child"), join(cwd, "physical-alias"), "dir");
  const callsRecorded = () => fs.readFileSync(probeCalls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const zeroProbes = phase => assert.deepEqual(callsRecorded(), [], `${phase}: external canonical effective cwd must be rejected BEFORE ANY Git subprocess`);
  // The recorder never delegates in this phase, even if a regression attempts
  // an external probe. The ordinary fallback is not an approval guarantee.
  fs.writeFileSync(probeControl, JSON.stringify({ mode: "record-only" }));
  process.env.PATH = `${probeBin}:${previousPath}`;
  try {
    for (const target of [separated, "../separated", "external-alias", "physical-alias/.."]) for (const query of ["diff -p", "diff --stat", "status --short", "log --oneline", "show HEAD:ordinary.txt"]) {
      for (const route of ["-C", "cd"]) {
        fs.writeFileSync(probeCalls, "");
        const gitCommand = `${query.startsWith("show") ? "env " : ""}git`, command = route === "-C"
          ? `${gitCommand} -C ${shellWord(target)} ${query}` : `cd ${shellWord(target)} && ${gitCommand} ${query}`;
        const input = { command }; await hardenGitInput(input, cwd);
        zeroProbes(`hardening ${route}/${target}/${query}`);
        if (query.startsWith("show")) assert.equal(input.command, command, "External blob pinning must decline without probing or rewriting");
        const tree = (await getParser()).parse(input.command); assert(tree);
        try { assert.equal(managedProgramProof(tree.rootNode, normalizer), undefined, "External cwd cannot have complete managed proof"); }
        finally { tree.delete(); }
        zeroProbes(`program proof ${route}/${target}/${query}`);
        const program = await BashProgram.parse(input.command, normalizer);
        assert(!program.commands().some(unit => unit.managedReadOnly), "External fallback cannot auto-prove a program unit");
        zeroProbes(`real parser ${route}/${target}/${query}`);
      }
    }
    for (const query of ["diff -p", "show HEAD:ordinary.txt"]) {
      fs.writeFileSync(probeCalls, "");
      const command = `cd physical-alias && ${query.startsWith("show") ? "env " : ""}git -C .. ${query}`, input = { command };
      await hardenGitInput(input, cwd);
      zeroProbes(`physical leading cd then -C .. hardening/${query}`);
      const tree = (await getParser()).parse(input.command); assert(tree);
      try { assert.equal(managedProgramProof(tree.rootNode, normalizer), undefined, "Leading cd and subsequent -C use physical, not lexical, symlink/.. resolution"); }
      finally { tree.delete(); }
      zeroProbes(`physical leading cd then -C .. proof/${query}`);
    }
    // Bash's logical PWD makes `cd ../repo` select alias/repo, while native
    // physical traversal from alias/link would return physical/repo. Neither
    // hardening nor program analysis may pin/probe the guessed physical repo.
    const logicalRoot = join(scratch, "logical-pwd"), physicalRepo = join(logicalRoot, "physical/repo"), aliasRoot = join(logicalRoot, "alias");
    fs.mkdirSync(dirname(physicalRepo), { recursive: true }); fs.mkdirSync(aliasRoot);
    fs.cpSync(cwd, physicalRepo, { recursive: true, dereference: false });
    fs.cpSync(cwd, join(aliasRoot, "repo"), { recursive: true, dereference: false });
    const aliasCwd = join(aliasRoot, "link"); fs.symlinkSync(physicalRepo, aliasCwd, "dir");
    assert.equal(fs.realpathSync(aliasCwd), physicalRepo);
    assert(fs.lstatSync(join(aliasRoot, "repo")).isDirectory(), "The logical-PWD sibling is a real directory, not the physical checkout");
    const previousPwd = process.env.PWD; process.env.PWD = aliasCwd;
    try {
      fs.writeFileSync(probeCalls, "");
      const command = "cd ../repo && env git show HEAD:ordinary.txt", input = { command }, aliasNormalizer = normalizerFor(aliasCwd);
      assert.equal(await hardenGitInput(input, aliasCwd), undefined, "Ambiguous logical leading cd cannot harden/pin a historical blob");
      assert.equal(input.command, command, "Logical-PWD input must retain its original revision and execution spelling");
      zeroProbes("logical PWD symlink/.. hardening");
      const tree = (await getParser()).parse(input.command); assert(tree);
      try {
        assert.equal(managedProgramAnalysis(tree.rootNode, aliasNormalizer).proof, undefined, "Logical-PWD leading cd has no managed program proof");
        assert.equal(managedProgramProof(tree.rootNode, aliasNormalizer), undefined);
      } finally { tree.delete(); }
      zeroProbes("logical PWD symlink/.. program analysis");
      const program = await BashProgram.parse(input.command, aliasNormalizer);
      assert(!program.commands().some(unit => unit.managedReadOnly), "Logical-PWD parser fallback cannot auto-prove a Git unit");
      zeroProbes("logical PWD symlink/.. real parser");
      // Even a plain `cd .` is ambiguous when PWD itself carries a symlink/..
      // spelling that Bash validates physically but subsequently normalizes.
      process.env.PWD = `${aliasCwd}/../repo`;
      assert.equal(fs.realpathSync.native(process.env.PWD), physicalRepo);
      assert.equal(execute(physicalRepo, "cd . && pwd -P").trim(), join(aliasRoot, "repo"), "The inherited-PWD canary really changes the physical repository");
      const ambientInput = { command: "cd . && env git show HEAD:ordinary.txt" };
      assert.equal(await hardenGitInput(ambientInput, physicalRepo), undefined);
      const ambientTree = (await getParser()).parse(ambientInput.command); assert(ambientTree);
      try { assert.equal(managedProgramAnalysis(ambientTree.rootNode, normalizerFor(physicalRepo)).proof, undefined); }
      finally { ambientTree.delete(); }
      zeroProbes("dotdot in inherited PWD with plain cd operand");
    } finally {
      if (previousPwd === undefined) delete process.env.PWD; else process.env.PWD = previousPwd;
    }
    for (const workdir of [separated, externalAlias]) {
      fs.writeFileSync(probeCalls, "");
      assert.equal(managedGitProof(diffInput.command, normalizer, workdir), undefined, "Explicit external workdir is canonicalized before proof probes");
      assert.equal(managedGitProof(showInput.command, normalizer, workdir), undefined, "Already-pinned external blob still cannot probe");
      zeroProbes(`direct diff/blob proof ${workdir}`);
    }
  } finally { process.env.PATH = previousPath; }
  console.log("PASS: absolute/relative -C, leading cd and outward symlink hardening/blob pinning/program/parser proof reject external cwd with ZERO recorded probes; linked main-root exception checked separately");
  for (const [sub, command] of [["rev-parse", diffInput.command], ["config", diffInput.command], ["ls-files", diffInput.command], ["ls-tree", showInput.command], ["cat-file", showInput.command], ["diff", diffInput.command]]) {
    for (const mode of ["fail", "timeout"]) {
      fs.writeFileSync(probeControl, JSON.stringify({ sub, mode })); fs.writeFileSync(probeCalls, "");
      process.env.PATH = `${probeBin}:${previousPath}`;
      const start = performance.now();
      try { assert.equal(managedGitProof(command, normalizer), undefined, `${sub}/${mode} rejects proof without throwing`); }
      finally { process.env.PATH = previousPath; }
      assert(performance.now() - start < 7500, `${sub}/${mode} rejection is bounded`);
      const calls = fs.readFileSync(probeCalls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      assert(calls.some(call => call.sub === sub), `Fixture reached ${sub}, not an earlier rejection`);
      for (const call of calls) {
        assert(call.args.includes("--no-lazy-fetch"), "All probes disable lazy fetch");
        assert(call.args.includes("--no-replace-objects"), `ALL ${call.sub} probes share replacement-disabled execution semantics`);
      }
    }
  }
  for (const output of ["not-a-stage-record\0", `160000 ${head} 4\tvendor/link\0`, `160000 ${head} 0\t../outside\0`, `160000 ${head} 0\tvendor/link`]) {
    fs.writeFileSync(probeControl, JSON.stringify({ mode: "malformed-stage", output })); fs.writeFileSync(probeCalls, "");
    process.env.PATH = `${probeBin}:${previousPath}`;
    try { assert.equal(managedGitProof(diffInput.command, normalizer), undefined, "Unknown/malformed stage enumeration fails closed"); }
    finally { process.env.PATH = previousPath; }
    const calls = fs.readFileSync(probeCalls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(calls.some(call => call.sub === "ls-files" && (call.args.includes("--stage") || call.args.includes("-s"))), "Stage fixture actually reached the non-recursive gitlink enumeration");
    assert(!calls.some(call => call.sub === "diff"), "Malformed stage output must reject before dangerous changed-name diff");
  }
  console.log("PASS: native rev-parse/config/name/stage/tree/type probes fail closed with bounded timeout, malformed stage guards and universal no-replace flags");
} finally {
  guardHooks.get("session_shutdown")?.();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(scratch, { recursive: true, force: true });
}
