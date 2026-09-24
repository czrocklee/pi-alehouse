#!/usr/bin/env node
// Test resources only. Never reads a user's agent directory or credentials.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function renderFixture(repo, target, output, lane = "readonly") {
  assert(["full", "readonly", "luna", "jev"].includes(lane), "INVALID_FIXTURE_LANE");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  cpSync(join(repo, "runtime/agents"), join(target, "agents"), { recursive: true });
  cpSync(join(repo, "runtime/policy"), join(target, "extensions"), { recursive: true });
  cpSync(join(repo, "runtime/lib"), join(target, "lib"), { recursive: true });
  if (lane !== "luna" && lane !== "jev") rmSync(join(target, "extensions/luna-auto-approval.ts"), { force: true });
  const config = JSON.parse(readFileSync(join(repo, "test/policy/permissions.json"), "utf8"));
  if (lane === "full") {
    // ONLY these synthetic executables: no wildcard/interpreter class allowance.
    for (const relative of ["child/inspect-fd.cjs", "p1-child/cooperative.cjs"]) {
      const path = join(output, relative);
      config.permission.bash[`${process.execPath} ${path}`] = "allow";
      config.permission.path[path] = "allow";
    }
  }
  mkdirSync(join(target, "extensions/pi-permission-system"), { recursive: true });
  writeFileSync(join(target, "extensions/pi-permission-system/config.json"), JSON.stringify(config));
  cpSync(join(repo, "resources/harness-presets.json"), join(target, "harness-presets.json"));
}
export function resourceJson(repo) {
  const readTree = (directory, prefix = "") => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(prefix, entry.name), path = join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(readTree(path, name)) : [[name, readFileSync(path, "utf8")]];
  }));
  return { agents: Object.fromEntries(Object.entries(readTree(join(repo, "runtime/agents"))).map(([name, text]) => [name.replace(/\.md$/, ""), text])),
    extensions: readTree(join(repo, "runtime/policy")) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, target, output, lane] = process.argv.slice(2);
  if (target === "--json") process.stdout.write(JSON.stringify(resourceJson(repo)));
  else { assert(repo && target && output, "REPO TARGET OUTPUT [LANE]"); mkdirSync(dirname(target), { recursive: true }); renderFixture(repo, target, output, lane); }
}
