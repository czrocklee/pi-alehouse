// Managed researcher ceiling checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
export async function runResearcherCeiling(
  scratch,
  cwd,
  configPath,
  agentDir,
  normalizer,
  BashProgram,
  describeBashPathGate,
  PermissionManager,
  PermissionResolver,
) {
  // Profile write ceilings survive inherited path exceptions, project policy,
  // standing session grants and YOLO. Read scope and editor policy stay intact.
  const ceilingProject = join(scratch, "ceiling-project.json");
  writeFileSync(
    ceilingProject,
    JSON.stringify({ permission: { path_write: { "*.future": "allow" } } }),
  );
  const ceilingProjectAgents = join(scratch, "ceiling-project-agents");
  mkdirSync(ceilingProjectAgents);
  writeFileSync(
    join(ceilingProjectAgents, "researcher.md"),
    '---\npermission:\n  path_write:\n    "*": allow\n---\n',
  );
  writeFileSync(
    join(ceilingProjectAgents, "partial.md"),
    '---\npermission:\n  path_write:\n    "*": deny\n    "*.pem": ask\n---\n',
  );
  writeFileSync(
    join(ceilingProjectAgents, "local-path-ceiling.md"),
    "---\npermission:\n  path_write: deny\n---\n",
  );
  for (const yolo of [false, true]) {
    const ceilingManager = new PermissionManager({
      globalConfigPath: configPath,
      agentsDir: join(agentDir, "agents"),
      projectGlobalConfigPath: ceilingProject,
      projectAgentsDir: ceilingProjectAgents,
      mcpServerNames: [],
      isYoloEnabled: () => yolo,
    });
    assert.equal(ceilingManager.getToolPermission("path_write", "researcher"), "deny");
    assert.equal(ceilingManager.isToolFullyDenied("path_write", "researcher"), true);
    const certificateIntent = {
      kind: "path-values",
      surface: "path_write",
      values: [join(cwd, "ordinary.pem")],
    };
    assert.equal(
      ceilingManager.check({ ...certificateIntent, agentName: "partial" }).state,
      yolo ? "allow" : "ask",
      "Partial profile rules keep their own exceptions; a catch-all alone is not enough",
    );
    assert.equal(ceilingManager.isToolFullyDenied("path_write", "partial"), false);
    const localCeiling = ceilingManager.check({
      ...certificateIntent,
      agentName: "local-path-ceiling",
    });
    assert.equal(
      localCeiling.state,
      "deny",
      "A project-agent's scalar full-surface denial is also a ceiling",
    );
    assert.equal(localCeiling.origin, "project-agent");
    for (const grants of [
      [],
      [
        {
          surface: "path_write",
          pattern: "*",
          action: "allow",
          layer: "session",
          origin: "session",
        },
      ],
    ]) {
      const ceilingResolver = new PermissionResolver(ceilingManager, { getRuleset: () => grants });
      assert.equal(
        ceilingResolver.resolve({ ...certificateIntent, agentName: "local-path-ceiling" }).state,
        "deny",
        "A path-only profile ceiling holds without relying on a direct write-tool deny",
      );
      assert.equal(
        ceilingManager.check(
          {
            kind: "tool",
            surface: "path_write",
            input: join(cwd, "ordinary.pem"),
            agentName: "local-path-ceiling",
          },
          grants,
        ).state,
        "deny",
        "The raw tool-intent path is clamped as well as path-values",
      );
      for (const name of [
        "ordinary.txt",
        "ordinary.pem",
        "ordinary.key",
        "ordinary.p12",
        "ordinary.pfx",
        "ordinary.future",
        ".env.example",
      ]) {
        const command = `printf '%s' fixture > ./${name}`;
        const program = await BashProgram.parse(command, normalizer);
        const path = describeBashPathGate(
          { toolCallId: "ceiling", toolName: "bash", cwd, agentName: "researcher" },
          program,
          ceilingResolver,
          normalizer,
        );
        assert.equal(
          path?.preCheck.state,
          "deny",
          `researcher ceiling: ${name}, yolo=${yolo}, sessionGrant=${grants.length}`,
        );
        assert.equal(
          path.preCheck.origin,
          "agent",
          "Inherited exceptions cannot replace the profile ceiling",
        );
      }
      assert.equal(
        ceilingResolver.resolve({
          kind: "path-values",
          surface: "path_read",
          values: [join(cwd, "ordinary.txt")],
          agentName: "researcher",
        }).state,
        "allow",
      );
      for (const agentName of [undefined, "editor"]) {
        assert.equal(
          ceilingResolver.resolve({
            kind: "path-values",
            surface: "path_write",
            values: [join(cwd, "ordinary.future")],
            agentName,
          }).state,
          "allow",
        );
        assert.equal(
          ceilingResolver.resolve({
            kind: "path-values",
            surface: "path_write",
            values: [join(cwd, "ordinary.pem")],
            agentName,
          }).state,
          yolo || grants.length ? "allow" : "ask",
          "No new write ceiling on root/editor",
        );
      }
      const protectedWrite = ceilingResolver.resolve({
        kind: "path-values",
        surface: "path_write",
        values: [join(cwd, ".git/config")],
        agentName: "researcher",
      });
      assert.equal(protectedWrite.state, "deny");
      assert.equal(
        protectedWrite.origin,
        grants.length ? "agent" : "global",
        "Keep an existing specific denial; otherwise clamp the session grant to the profile ceiling",
      );
    }
  }
  console.log(
    "PASS: researcher write ceiling survives inherited/project exceptions, project-agent widening, session grants and yolo",
  );
}
