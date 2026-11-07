// Managed repo fixture checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function openManagedRepo(
  agentDir,
  repo,
  PermissionManager,
  PermissionResolver,
  PathNormalizer,
  posixPathFlavor,
  BashProgram,
  resolveBashCommandCheck,
  describeBashPathGate,
  describeBashExternalDirectoryGate,
) {
  const scratch = mkdtempSync(join(tmpdir(), "pi-managed-test-"));
  const cwd = join(scratch, "repo");
  mkdirSync(cwd);
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: scratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const sessions = [];
  const externalScratch = [];
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "ordinary.txt"), "before\n");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/code.ts"), "export const n = 1;\n");
    writeFileSync(join(cwd, "syntax.sh"), 'printf source-ran > "$BASH_SOURCE_CANARY"\n');
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    writeFileSync(join(cwd, "ordinary.txt"), "after\n");
    const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
    const config = JSON.parse(readFileSync(configPath));
    const manager = new PermissionManager({
      globalConfigPath: configPath,
      agentsDir: join(agentDir, "agents"),
      mcpServerNames: [],
    });
    const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
    const normalizer = new PathNormalizer(posixPathFlavor, cwd);
    const management = [
      "agent_spawn",
      "agent_run",
      "agent_send",
      "agent_answer",
      "agent_wait",
      "agent_read",
      "agent_interrupt",
      "agent_kill",
      "agent_list",
    ];
    const childDenies = JSON.parse(
      readFileSync(join(repo, "resources/worker-policy.json"), "utf8"),
    ).childToolDenies;
    assert.equal(
      config.permission.notify_parent,
      "deny",
      "Retired communication name must be explicitly denied",
    );
    for (const agent of ["editor", "researcher"]) {
      for (const tool of childDenies)
        assert.equal(resolver.checkPermission(tool, {}, agent).state, "deny", `${agent}: ${tool}`);
      for (const tool of ["alert_parent", "ask_parent"])
        assert.equal(resolver.checkPermission(tool, {}, agent).state, "allow", `${agent}: ${tool}`);
    }
    const check = async (command, agentName) => {
      const program = await BashProgram.parse(command, normalizer);
      const context = { toolCallId: "fixture", toolName: "bash", cwd, agentName };
      return {
        program,
        bash: resolveBashCommandCheck(command, program.commands(), agentName, resolver),
        path: describeBashPathGate(context, program, resolver, normalizer),
        external: describeBashExternalDirectoryGate(context, program, resolver, normalizer),
      };
    };
    return {
      scratch,
      cwd,
      git,
      sessions,
      externalScratch,
      savedEnv,
      configPath,
      config,
      manager,
      resolver,
      normalizer,
      management,
      childDenies,
      check,
    };
  } catch (error) {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function closeManagedRepo(sessions, externalScratch, savedEnv, scratch) {
  for (const node of sessions.reverse()) {
    await node.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    node.parent?.eventBus.emit("subagents:child:disposed", { sessionId: node.id });
    node.session.dispose();
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const path of [...new Set(externalScratch)].reverse())
    rmSync(path, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
