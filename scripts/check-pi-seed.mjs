#!/usr/bin/env node
// Production seed through the actual private patched parser/gates, independent
// of the historical conservative-policy fixture. No commands are executed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const [repo, , resources] = process.argv.slice(2);
assert(repo && resources && process.env.PI_MANAGED_PERMISSIONS_ROOT);
const jiti = createJiti(import.meta.url);
const load = (name) => jiti.import(join(process.env.PI_MANAGED_PERMISSIONS_ROOT, "src", `${name}.ts`));
const [{ PermissionManager }, { PermissionResolver }, { PathNormalizer }, { posixPathFlavor }, { ToolCallGatePipeline }] = await Promise.all([
  load("policy/permission-manager"), load("policy/permission-resolver"), load("path/path-normalizer"), load("path/path-flavor"), load("handlers/gates/tool-call-gate-pipeline"),
]);
const scratch = mkdtempSync(join(tmpdir(), "alehouse-seed-policy-"));
try {
  writeFileSync(join(scratch, "ordinary.txt"), "synthetic\n");
  writeFileSync(join(scratch, ".env"), "SYNTHETIC_NOT_A_SECRET\n");
  const manager = new PermissionManager({ globalConfigPath: join(repo, "resources/permissions.json"), agentsDir: join(resources, "agents"), mcpServerNames: [] });
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const normalizer = new PathNormalizer(posixPathFlavor, scratch);
  const pipeline = new ToolCallGatePipeline(resolver, { getActiveSkillEntries: () => [], getInfrastructureReadDirs: () => [], getToolPreviewLimits: () => ({}), getPathNormalizer: () => normalizer, getShellToolAliases: () => undefined });
  const gatesFor = async (toolName, input, agentName) => {
    const gates = [];
    await pipeline.evaluate({ toolCallId: "seed-fixture", toolName, input, cwd: scratch, agentName }, { run: async (gate) => { if (gate) gates.push(gate); return { action: "allow" }; } });
    return gates;
  };
  const management = ["agent_spawn", "agent_run", "agent_send", "agent_answer", "agent_wait", "agent_read", "agent_interrupt", "agent_kill", "agent_list"];
  const childDenies = JSON.parse(readFileSync(join(repo, "resources/worker-policy.json"), "utf8")).childToolDenies;
  assert.equal(resolver.checkPermission("write", {}).state, "allow", "Seed global write baseline: the reader equality below must be meaningful");
  let checks = 0;
  for (const agent of [undefined, "editor", "reader", "researcher"]) {
    assert.deepEqual(manager.getConfigIssues(agent), []);
    for (const path of [".env", "~/.pi/agent/auth.json", "~/.ssh/id_ed25519", "/run/secrets/token"]) {
      assert((await gatesFor("read", { path }, agent)).some((gate) => gate.preCheck?.state === "deny"), `${agent}: secret read ${path}`); checks++;
    }
    for (const path of [".git/config", "~/.pi/agent/settings.json", ".pi/extensions/policy.ts"]) {
      assert((await gatesFor("write", { path, content: "synthetic" }, agent)).some((gate) => gate.preCheck?.state === "deny"), `${agent}: protected write ${path}`); checks++;
    }
    for (const command of ["sudo true", "doas true", "su root", "rm -rf /"]) {
      assert((await gatesFor("bash", { command }, agent)).some((gate) => gate.preCheck?.state === "deny"), `${agent}: privilege/destruction ${command}`); checks++;
    }
    for (const command of ["curl https://example.invalid", "node -e 'process.exit()'", "git show HEAD:.env"]) {
      assert((await gatesFor("bash", { command }, agent)).some((gate) => ["ask", "deny"].includes(gate.preCheck?.state)), `${agent}: no automatic arbitrary execution ${command}`); checks++;
    }
    // Reader boundary: the built-in write follows the ordinary global rule (the
    // profile pins no per-tool write deny and never adds a forced allow), while
    // edit stays denied by the profile. Without a scratch directory bound by
    // the trusted authority, the path_write floor still denies every write-tool
    // target (checked after the loop), so the tool grant alone writes nothing.
    for (const tool of ["write", "edit"]) {
      const expected = agent === undefined || agent === "editor" ? "allow"
        : agent === "reader" && tool === "write" ? resolver.checkPermission("write", {}).state
        : "deny";
      assert.equal(resolver.checkPermission(tool, {}, agent).state, expected, `${agent ?? "parent"}: ${tool} boundary`); checks++;
    }
    for (const tool of ["alert_parent", "ask_parent"]) { assert.equal(resolver.checkPermission(tool, {}, agent).state, "allow"); checks++; }
    for (const tool of management) { assert.equal(resolver.checkPermission(tool, {}, agent).state, agent ? "deny" : "allow", `${agent}: management boundary ${tool}`); checks++; }
    assert.equal(resolver.checkPermission("notify_parent", {}, agent).state, "deny"); checks++;
    if (agent) for (const tool of childDenies) { assert.equal(resolver.checkPermission(tool, {}, agent).state, "deny", `${agent}: child exclusion ${tool}`); checks++; }
  }
  // No scratch directory is bound in this process: the trusted authority alone
  // creates and binds one per reader, so the reader's default path_write floor
  // denies the write tool everywhere, project paths and arbitrary /tmp paths.
  for (const path of [join(scratch, "ordinary.txt"), "/tmp/pi-alehouse-reader-unbound/report.md"]) {
    assert((await gatesFor("write", { path, content: "synthetic" }, "reader")).some((gate) => gate.preCheck?.state === "deny"),
      `reader: unbound write-tool path denied: ${path}`); checks++;
  }
  console.log(`PASS: ${checks} production seed real-parser/gate checks, no fallback policy`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
