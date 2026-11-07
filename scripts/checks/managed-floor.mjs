// Managed protected-read floor checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function runProtectedReadFloor(
  BashProgram,
  PermissionManager,
  PermissionResolver,
  PathNormalizer,
  posixPathFlavor,
  resolveBashCommandCheck,
  describeBashPathGate,
) {
  // Assignment prefixes do not change expansions in the same simple command.
  // A future parser migration must retain the immutable floor for the file Bash
  // actually reads, even when yolo allows the ordinary Bash ask.
  {
    const cwd = mkdtempSync(join(tmpdir(), "pi-floor-expansion-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = cwd;
      const protectedFile = join(cwd, "auth.json"),
        config = join(cwd, "permissions.json");
      writeFileSync(protectedFile, "synthetic-protected-content\n");
      mkdirSync(join(cwd, "safe"));
      writeFileSync(
        config,
        JSON.stringify({
          permission: {
            "*": "ask",
            bash: { "*": "ask" },
            path: "allow",
            path_read: "allow",
          },
        }),
      );
      const manager = new PermissionManager({
        globalConfigPath: config,
        agentsDir: join(cwd, "agents"),
        mcpServerNames: [],
        isYoloEnabled: () => true,
        resourceProtection: {
          version: 1,
          readFiles: [protectedFile],
          writeFiles: [protectedFile],
          writeRoots: [],
        },
      });
      const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
      const normalizer = new PathNormalizer(posixPathFlavor, cwd);
      for (const command of [
        `cat ${protectedFile}`,
        `HOME=${cwd}/safe cat "$HOME/auth.json"`,
        `PWD=${cwd}/safe cat "$PWD/auth.json"`,
      ]) {
        assert.equal(
          execFileSync("bash", ["-c", command], {
            cwd,
            env: { HOME: cwd, PATH: process.env.PATH },
            encoding: "utf8",
          }),
          "synthetic-protected-content\n",
          "observe actual expansion with fabricated data only",
        );
        const program = await BashProgram.parse(command, normalizer);
        assert.equal(
          resolveBashCommandCheck(command, program.commands(), undefined, resolver).state,
          "allow",
        );
        assert.equal(
          describeBashPathGate(
            { toolCallId: "floor-expansion", toolName: "bash", cwd },
            program,
            resolver,
            normalizer,
          )?.preCheck?.state,
          "deny",
          "path floor survives assignment prefixes and yolo",
        );
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(cwd, { recursive: true, force: true });
    }
    console.log("PASS: immutable protected-read floor covers actual HOME/PWD expansion under yolo");
  }
}
