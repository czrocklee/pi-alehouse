#!/usr/bin/env node
// Compatibility script name; literal permission inventory, NOT historical-read
// proof. Commands are data. No Git, shell, helper, network or model execution.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const [repo, executable, resources] = process.argv.slice(2);
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(
  repo && executable && resources && packageRoot,
  "REPO PI_EXECUTABLE GENERATED_RESOURCES and built PI_MANAGED_PERMISSIONS_ROOT required",
);
let piRoot = dirname(realpathSync(executable));
while (!existsSync(join(piRoot, "package.json"))) {
  const parent = dirname(piRoot);
  assert.notEqual(parent, piRoot);
  piRoot = parent;
}
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") },
});
const load = (name) => jiti.import(join(packageRoot, "src", `${name}.ts`));
const [
  { hardenNonGitInput, originalGitCommands },
  { nativeGitScope, analyzeGitCommands, gitQueryEffect },
  { BashProgram },
  { getParser },
  { PermissionManager },
  { PermissionResolver },
  { PathNormalizer },
  { posixPathFlavor },
  { resolveBashCommandCheck },
  { describeBashPathGate },
] = await Promise.all([
  load("access-intent/bash/managed-read-policy"),
  load("access-intent/bash/managed-git-query"),
  load("access-intent/bash/program"),
  load("access-intent/bash/parser"),
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("path/path-normalizer"),
  load("path/path-flavor"),
  load("handlers/gates/bash-command"),
  load("handlers/gates/bash-path"),
]);
const { default: guard, originalBashDeny } = await jiti.import(
  join(resources, "extensions/static-safety-guard.ts"),
);
const scratch = mkdtempSync(join(tmpdir(), "pi-git-literal-")),
  cwd = join(scratch, "repo");
const savedEnv = { ...process.env };
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  delete process.env.CDPATH;
  process.env.PI_CODING_AGENT_DIR = resources;
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "ordinary.txt"), "synthetic fixture\n");
  const config = JSON.parse(
    readFileSync(join(resources, "extensions/pi-permission-system/config.json"), "utf8"),
  );
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const resolverFor = (policy = config, yolo = false, grants = []) => {
    const file = join(scratch, `policy-${ordinal++}.json`);
    writeFileSync(file, JSON.stringify(policy));
    return new PermissionResolver(
      new PermissionManager({
        globalConfigPath: file,
        agentsDir: join(resources, "agents"),
        mcpServerNames: [],
        isYoloEnabled: () => yolo,
      }),
      { getRuleset: () => grants },
    );
  };
  let ordinal = 0;
  const resolver = resolverFor();
  const hooks = new Map();
  guard({ on: (event, fn) => hooks.set(event, fn), events: { on: () => () => {}, emit() {} } });
  const context = {
    cwd,
    getSystemPrompt: () => "",
    sessionManager: {
      getSessionId: () => "literal-git",
      getEntries: () => [{ type: "custom", customType: "active_agent", data: { name: "editor" } }],
    },
  };
  hooks.get("session_start")({}, context);
  const parse = (command) => BashProgram.parse(command, normalizer);
  const check = async (command, selected = resolver, agentName = "editor") => {
    const program = await parse(command);
    return {
      program,
      bash: resolveBashCommandCheck(command, program.commands(), agentName, selected),
      path: describeBashPathGate(
        { toolCallId: "literal", toolName: "bash", cwd, agentName },
        program,
        selected,
        normalizer,
      ),
    };
  };
  for (const command of [
    "git log --oneline",
    "git diff --stat",
    "git show HEAD:ordinary.txt",
    "env git show HEAD:ordinary.txt",
    "git -C docs status --short",
    "cd docs && git diff --stat",
    "git cat-file --batch-all-objects --batch",
  ]) {
    const input = { command };
    assert.equal(await hardenNonGitInput(input, cwd), undefined);
    assert.equal(input.command, command);
    assert.equal(originalGitCommands(input), undefined);
    assert.notEqual(nativeGitScope(command, normalizer)?.auto, true);
    const ordinary = await check(command);
    assert.equal(ordinary.bash.state, "ask", command);
    assert.equal(
      ordinary.program.commands().some((unit) => unit.managedReadOnly),
      false,
    );
    // Wrapper floors are normal asks; the gate's ordinary yolo step can answer
    // them. Bare commands already resolve as yolo allows at this seam.
    const yolo = await check(command, resolverFor(config, true));
    assert.notEqual(yolo.bash.state, "deny", command);
    assert.notEqual(yolo.bash.origin, "fail-closed");
  }
  // Exact fixture allowances remain ordinary policy, never managed Git auto.
  const configuredChain = "cd docs && git status --short",
    statusInput = { command: configuredChain };
  assert.equal(await hardenNonGitInput(statusInput, cwd), undefined);
  assert.equal(statusInput.command, configuredChain);
  assert.equal(originalGitCommands(statusInput), undefined);
  assert.equal(config.permission.bash["cd *"], "allow");
  assert.equal(config.permission.bash["git status --short"], "allow");
  for (const [unit, pattern] of [
    ["cd docs", "cd *"],
    ["git status --short", "git status --short"],
  ]) {
    const configured = resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command: unit },
      agentName: "editor",
    });
    assert.equal(configured.state, "allow");
    assert.equal(
      configured.matchedPattern,
      pattern,
      "allow must come from the explicit fixture rule",
    );
  }
  const allowedStatus = await check(configuredChain);
  assert.equal(allowedStatus.bash.state, "allow");
  assert.equal(
    allowedStatus.program.commands().some((unit) => unit.managedReadOnly),
    false,
  );
  for (const command of [
    "git add ordinary.txt",
    "git commit -m fixture",
    "git branch topic",
    "git tag v1",
    "git checkout -b topic",
  ]) {
    assert.equal(
      hooks.get("tool_call")({ toolName: "bash", input: { command } }, context)?.block,
      undefined,
    );
    assert.equal(originalBashDeny(command, context, resources), undefined);
    assert.equal(gitQueryEffect(command), undefined);
    assert.equal((await check(command)).bash.state, "ask");
    assert.equal((await check(command, resolverFor(config, true))).bash.state, "allow");
  }
  for (const command of [
    "git show HEAD:.env",
    "git log -- .env",
    "git show 2>&1 HEAD:.env",
    "env git show 2>/dev/null HEAD:.env",
    "git diff --output=.git/config",
  ]) {
    for (const [yolo, grants] of [
      [false, []],
      [true, []],
      [
        false,
        [{ surface: "bash", pattern: "*", action: "allow", layer: "session", origin: "session" }],
      ],
    ]) {
      const result = await check(command, resolverFor(config, yolo, grants));
      assert.equal(
        result.path?.preCheck?.state,
        "deny",
        `literal path/output deny survives ordinary approval: ${command}`,
      );
    }
  }
  const output = await check("git log 2>/dev/null --output=out.txt");
  const facts = output.program.pathRuleCandidates();
  assert(
    facts.some((candidate) => candidate.token === "out.txt" && candidate.effect.effect === "write"),
  );
  assert(
    facts.some(
      (candidate) => candidate.token === "/dev/null" && candidate.effect.effect === "write",
    ),
  );
  const tree = (await getParser()).parse("git log 2>&1 --grep '--output=fake' --output=real");
  try {
    const inventory = analyzeGitCommands(tree.rootNode, normalizer);
    assert.deepEqual(
      [
        ...new Set(
          inventory.ruleCandidates
            .filter((candidate) => candidate.effect.effect === "write")
            .map((candidate) => candidate.token),
        ),
      ],
      ["real"],
    );
  } finally {
    tree.delete();
  }
  const inner = "git log --oneline",
    command = `env ${inner}`;
  const denied = {
    ...config,
    permission: { ...config.permission, bash: { ...config.permission.bash, [inner]: "deny" } },
  };
  const approved = resolverFor(denied, true, [
    { surface: "bash", pattern: "*", action: "allow", layer: "session", origin: "session" },
  ]);
  assert.equal(
    (await check(command, approved)).bash.state,
    "deny",
    "raw inner configured deny survives yolo/session",
  );
  const subdir = new PathNormalizer(posixPathFlavor, join(cwd, "docs"));
  assert(
    nativeGitScope("git show HEAD:private.txt", subdir)?.ruleCandidates.some((candidate) =>
      candidate.path.matchValues().includes(join(cwd, "private.txt")),
    ),
    "filesystem root alias without history probes",
  );
  const source = readFileSync(join(repo, "src/authority/managed-git-query.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /node:child_process|execFileSync|spawnSync|managed-git-unattributed|find-object=/,
  );
  const fixed = { command: "command -v pi" };
  assert(await hardenNonGitInput(fixed, cwd));
  assert.equal(fixed.command, "type -P -- pi");
  console.log(
    "PASS: literal Git paths/outputs/raw denies/completed argv; editor writes normal approval; no repository auto-read or provenance claim; non-Git hardening retained (permission-only)",
  );
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true });
}
