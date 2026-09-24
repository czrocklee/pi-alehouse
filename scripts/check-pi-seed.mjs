#!/usr/bin/env node
// Production seed through the actual private patched parser/gates, independent
// of the historical conservative-policy fixture. No commands are executed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  let checks = 0;
  for (const agent of [undefined, "editor", "reader"]) {
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
    for (const tool of ["write", "edit"]) { assert.equal(resolver.checkPermission(tool, {}, agent).state, agent === "reader" ? "deny" : "allow"); checks++; }
    for (const tool of ["spawn_agent", "wait_runs", "read_run", "notify_parent", "ask_parent"]) { assert.equal(resolver.checkPermission(tool, {}, agent).state, "allow"); checks++; }
  }
  console.log(`PASS: ${checks} production seed real-parser/gate checks, no fallback policy`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
