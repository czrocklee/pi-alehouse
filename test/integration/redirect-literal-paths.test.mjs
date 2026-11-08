// Production permission gates, never shell execution. All filenames, policies,
// credentials/config roots and symlink targets are isolated fixture data.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const root = mkdtempSync(join(tmpdir(), "alehouse-redirect-literals-"));
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
const agentDir = join(root, "agent");
for (const path of ["home", "xdg", "agent/agents"])
  mkdirSync(join(root, path), { recursive: true });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.PI_CODING_AGENT_DIR = agentDir;
cpSync(join(packageRoot, "generated/agents/editor.md"), join(agentDir, "agents/editor.md"));

const require = createRequire(import.meta.url);
const jiti = require("jiti").createJiti(import.meta.url, {
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
  { posixPathFlavor, win32PathFlavor },
  { PermissionSession },
  { PermissionGateHandler },
  { ToolCallGatePipeline },
  { resolveToolPreviewLimits },
  { GateRunner },
  { BashProgram },
  { initializeManagedResourceProtection },
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
  load("policy/managed-resource-protection"),
]);
const shipped = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
const policy = (rules = {}) => ({
  ...shipped,
  permission: {
    ...shipped.permission,
    bash: { "*": "allow" },
    path: { "*": "allow" },
    path_read: {},
    path_write: {},
    external_directory: { "*": "allow" },
    ...rules,
  },
});
const workspace = () => mkdtempSync(join(root, "cwd-"));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const parse = (cwd, command) =>
  BashProgram.parse(command, new PathNormalizer(posixPathFlavor, cwd));
let configs = 0;
async function check(
  cwd,
  command,
  { agent = null, yolo = false, config = policy(), resourceProtection } = {},
) {
  const configFile = join(root, `config-${configs++}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const manager = new PermissionManager({
    globalConfigPath: configFile,
    agentsDir: join(agentDir, "agents"),
    mcpServerNames: [],
    isYoloEnabled: () => yolo,
    resourceProtection,
  });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  const prompts = [];
  const runner = new GateRunner(
    resolver,
    {
      recordSessionApproval() {
        assert.fail("no fixture approval may record a grant");
      },
    },
    {
      async escalate(details) {
        prompts.push(details);
        return {
          approved: false,
          state: "denied",
          confirmationUnavailable: true,
          decidedBy: { kind: "unavailable", reason: "fixture has no approval UI" },
        };
      },
    },
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
    { getAll: () => tools, getActive: () => tools.map(({ name }) => name), setActive() {} },
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
  const input = { command };
  const outcome = await handler.handleToolCall(
    { toolCallId: "redirect-literal", toolName: "bash", input },
    {
      cwd,
      hasUI: false,
      ui: { notify() {} },
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
        getSessionId: () => "redirect-literal",
      },
    },
  );
  assert.equal(input.command, command, "permission classification must not rewrite execution text");
  const state =
    outcome.action === "allow"
      ? "allow"
      : /requires approval/.test(outcome.reason ?? "")
        ? "ask"
        : /Denied by policy/.test(outcome.reason ?? "")
          ? `deny ${/Denied by policy: '(\w+)'/.exec(outcome.reason)?.[1]}`
          : outcome.reason;
  return { state, outcome, prompts };
}

const literals = [
  ["@new", "\\@new"],
  [" secret.txt", "' secret.txt'"],
  ["trailing ", "'trailing '"],
  ["~", "\\~"],
  ["~/secret.txt", "'~/secret.txt'"],
  ["$HOME/secret.txt", "'$HOME/secret.txt'"],
  ["${HOME}/secret.txt", "'${HOME}/secret.txt'"],
  ['"quoted"', "'\"quoted\"'"],
  ["'quoted'", "\"'quoted'\""],
  ["*", "'*'"],
  ["é!文件", "'é!文件'"],
];

test("decoded redirect filenames retain their bytes through production path denies", async () => {
  const cwd = workspace();
  for (const [literal, spelling] of literals) {
    const absolute = join(cwd, literal);
    const config = policy({ path_write: { [absolute]: "deny" } });
    for (const command of [`echo hi > ${spelling}`, `echo hi > ${quote(`./${literal}`)}`]) {
      const program = await parse(cwd, command);
      const candidate = program
        .pathRuleCandidates()
        .find(({ token }) => token === literal || token === `./${literal}`);
      assert.ok(candidate, command);
      assert.equal(candidate.path.value(), absolute, command);
      assert.ok(candidate.path.matchValues().includes(absolute), command);
      assert.ok(candidate.path.matchValues().includes(literal), command);
      assert.equal(candidate.path.boundaryValue(), absolute, command);
      for (const agent of [null, "editor"])
        for (const yolo of [false, true])
          assert.equal(
            (await check(cwd, command, { config, agent, yolo })).state,
            "deny path_write",
            `${command} ${agent} ${yolo}`,
          );
    }
  }
  // Wrong, tool-cleaned aliases must not be added as equivalent filenames.
  for (const [literal, spelling, wrong] of [
    ["@new", "\\@new", "new"],
    [" secret.txt", "' secret.txt'", "secret.txt"],
    ["trailing ", "'trailing '", "trailing"],
    ['"quoted"', "'\"quoted\"'", "quoted"],
  ]) {
    const config = policy({ path_write: { [join(cwd, wrong)]: "deny" } });
    assert.equal(
      (await check(cwd, `echo hi > ${spelling}`, { config, yolo: true })).state,
      "allow",
      literal,
    );
  }
});

test("literal redirects retain operator effects, not command effects or argument shape", async () => {
  const cwd = workspace();
  for (const [operator, effect, surface] of [
    [">", "write", "path_write"],
    [">>", "write", "path_write"],
    [">|", "write", "path_write"],
    ["&>", "write", "path_write"],
    ["&>>", "write", "path_write"],
    [">&", "write", "path_write"],
    ["<", "read", "path_read"],
    ["<>", "unproven", "path_write"],
  ]) {
    const literal = " @literal";
    const command = `cat ${operator} ${quote(literal)}`;
    const candidates = (await parse(cwd, command)).pathRuleCandidates();
    assert.deepEqual(
      candidates.map(({ token, effect: value }) => [token, value.effect]),
      [[literal, effect]],
      command,
    );
    for (const agent of [null, "editor"])
      for (const yolo of [false, true])
        assert.equal(
          (
            await check(cwd, command, {
              agent,
              yolo,
              config: policy({ [surface]: { [join(cwd, literal)]: "deny" } }),
            })
          ).state,
          effect === "unproven" ? "deny path" : `deny ${surface}`,
          command,
        );
  }
});

test("numbers name files except for descriptor copies; here text is not a filename", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "notes.txt"), "fixture\n");
  for (const [redirect, literal, effect, surface] of [
    [">123", "123", "write", "path_write"],
    ["<123", "123", "read", "path_read"],
    ["&>1", "1", "write", "path_write"],
  ]) {
    const command = `cat ${redirect} notes.txt`;
    assert.deepEqual(
      new Map(
        (await parse(cwd, command))
          .pathRuleCandidates()
          .map(({ token, effect: value }) => [token, value.effect]),
      ),
      new Map([
        ["notes.txt", "read"],
        [literal, effect],
      ]),
      command,
    );
    for (const agent of [null, "editor"])
      for (const yolo of [false, true])
        assert.equal(
          (
            await check(cwd, command, {
              agent,
              yolo,
              config: policy({ [surface]: { [join(cwd, literal)]: "deny" } }),
            })
          ).state,
          `deny ${surface}`,
          command,
        );
  }
  for (const redirect of ["2>&1", ">&2", "<&0", "2>&-", '<<< ".env"', "<<EOF"]) {
    const command = `cat ${redirect} notes.txt${redirect === "<<EOF" ? "\n.env\nEOF" : ""}`;
    assert.deepEqual(
      (await parse(cwd, command))
        .pathRuleCandidates()
        .map(({ token, effect }) => [token, effect.effect]),
      [["notes.txt", "read"]],
      command,
    );
    for (const agent of [null, "editor"])
      assert.equal(
        (
          await check(cwd, command, {
            agent,
            yolo: true,
            config: policy({
              path_read: { [join(cwd, ".env")]: "deny" },
              path_write: {
                [join(cwd, "notes.txt")]: "deny",
                [join(cwd, "1")]: "deny",
                [join(cwd, "2")]: "deny",
              },
            }),
          })
        ).state,
        "allow",
        command,
      );
  }
});

test("path ask facts and approval patterns keep literal directory bytes", async () => {
  const cwd = workspace(),
    literal = '@folder /"name" ';
  const absolute = join(cwd, literal);
  const command = `echo hi > ${quote(literal)}`;
  const result = await check(cwd, command, {
    config: policy({ path_write: { [absolute]: "ask" } }),
  });
  assert.equal(result.state, "ask");
  const prompt = result.prompts.find(({ accessIntent }) => accessIntent.surface === "path_write");
  assert.deepEqual(prompt.accessIntent.matchValues, [absolute, literal]);
  assert.equal(prompt.accessIntent.boundaryValue, absolute);
  assert.deepEqual(prompt.sessionApproval, {
    grants: [{ surface: "path_write", pattern: `${cwd}/@folder /*` }],
  });
});

test("effective cwd and external-directory policy use the same literal aliases", async () => {
  const cwd = workspace(),
    outside = workspace();
  for (const [literal, spelling] of literals) {
    const absolute = join(outside, literal);
    const command = `cd ${quote(outside)} && echo hi > ${spelling}`;
    const program = await parse(cwd, command);
    const candidate = program.pathRuleCandidates().find(({ token }) => token === literal);
    assert.equal(candidate.path.value(), absolute, command);
    assert.ok(
      program.externalAccesses().some(({ path }) => path.matchValues().includes(absolute)),
      command,
    );
    for (const agent of [null, "editor"])
      for (const yolo of [false, true])
        assert.equal(
          (
            await check(cwd, command, {
              agent,
              yolo,
              config: policy({ external_directory_write: { [absolute]: "deny" } }),
            })
          ).state,
          "deny external_directory_write",
          command,
        );
  }
  assert.equal((await parse(cwd, "echo hi > /dev/null")).externalAccesses().length, 0);
});

test("unknown cwd retains only literal aliases and conservative external checks", async () => {
  const cwd = workspace();
  for (const [literal, spelling] of literals) {
    const command = `cd "$DIR" && echo hi > ${spelling}`;
    const program = await parse(cwd, command);
    const candidate = program.pathRuleCandidates().find(({ token }) => token === literal);
    assert.deepEqual(candidate.path.matchValues(), [literal], command);
    assert.equal(candidate.path.boundaryValue(), "", command);
    const external = program.externalAccesses().find(({ path }) => path.value() === literal);
    assert.ok(external, command);
    assert.deepEqual(external.path.matchValues(), [literal], command);
    assert.equal(external.path.boundaryValue(), "", command);
    const config = policy({
      external_directory_write: { "*": "ask" },
      path_write: { [join(cwd, literal)]: "deny" },
    });
    for (const agent of [null, "editor"]) {
      const result = await check(cwd, command, { agent, config });
      assert.equal(result.state, "ask", command);
      const prompt = result.prompts.find(
        ({ accessIntent }) => accessIntent.surface === "external_directory_write",
      );
      assert.ok(prompt, command);
      assert.deepEqual(prompt.accessIntent.matchValues, [literal], command);
      assert.equal(prompt.accessIntent.boundaryValue, null, command);
      assert.equal(
        (await check(cwd, command, { agent, config, yolo: true })).state,
        "allow",
        command,
      );
    }
  }
  for (const [literal, spelling] of literals.slice(0, 3))
    for (const agent of [null, "editor"])
      for (const yolo of [false, true])
        assert.equal(
          (
            await check(cwd, `cd "$DIR" && echo hi > ${spelling}`, {
              agent,
              yolo,
              config: policy({ external_directory_write: { [literal]: "deny" } }),
            })
          ).state,
          "deny external_directory_write",
          literal,
        );
});

test("the literal-only seam leaves normal tool spelling and platform shapes intact", () => {
  const cwd = workspace();
  const normalizer = new PathNormalizer(posixPathFlavor, cwd);
  assert.equal(normalizer.forPath(" @new ").value(), join(cwd, "new"));
  assert.equal(normalizer.forPath("'name'").value(), join(cwd, "name"));
  assert.equal(normalizer.forPath("$HOME/name").value(), join(root, "home/name"));
  const windows = new PathNormalizer(win32PathFlavor, "C:\\work");
  assert.equal(windows.forBashLiteral("/dev/null").value(), "/dev/null");
  assert.equal(windows.forBashLiteral("/c/work/@new ").value(), "c:\\work\\@new ");
  assert.deepEqual(windows.forBashLiteral("/foreign/@new ").matchValues(), ["/foreign/@new "]);
});

test("symlink/canonical denies and the immutable floor see decoded filenames", async () => {
  const cwd = workspace(),
    vault = workspace();
  symlinkSync(vault, join(cwd, "@link"), "dir");
  for (const surface of ["path_write", "external_directory_write"])
    for (const literal of ["@new", " secret.txt", '"quoted"']) {
      const command = `echo hi > ${quote(`@link/${literal}`)}`;
      const candidate = (await parse(cwd, command)).pathRuleCandidates()[0];
      assert.equal(candidate.path.boundaryValue(), join(vault, literal));
      assert.equal(candidate.path.resolvedAlias(), join(vault, literal));
      const config = policy({ [surface]: { [join(vault, literal)]: "deny" } });
      for (const agent of [null, "editor"])
        for (const yolo of [false, true])
          assert.equal(
            (await check(cwd, command, { config, agent, yolo })).state,
            `deny ${surface}`,
            command,
          );
    }
  // Initialize once, last: even broad user allows/yolo cannot override this
  // process-local floor, including a new filename under a canonical ancestor.
  const resourceProtection = initializeManagedResourceProtection({
    writeRoots: [vault],
    readFiles: [],
    writeFiles: [join(cwd, "*")],
  });
  for (const command of ["echo hi > '@link/ new'", "echo hi > '*'"])
    for (const agent of [null, "editor"])
      for (const yolo of [false, true])
        assert.equal(
          (await check(cwd, command, { agent, yolo, resourceProtection })).state,
          "deny path_write",
          command,
        );
});
