#!/usr/bin/env node
// Real patched pipeline + real SDK extension lifecycle. Offline fabricated data;
// no private transcripts, production settings, model API, or historical execution.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runProtectedReadFloor } from "./checks/managed-floor.mjs";
import { runPromptLifecycle } from "./checks/managed-prompts.mjs";
import { closeManagedRepo, openManagedRepo } from "./checks/managed-repo.mjs";
import { runResearcherCeiling } from "./checks/managed-ceiling.mjs";
import { runParserMatrix } from "./checks/managed-parser.mjs";
import { runManagedSdk } from "./checks/managed-sdk.mjs";
const [repo, executable, agentDir] = process.argv.slice(2);
const packageRoot = process.env.PI_MANAGED_PERMISSIONS_ROOT;
assert(packageRoot && agentDir);
const require = createRequire(realpathSync(executable));
let piRoot = dirname(realpathSync(executable));
while (!existsSync(join(piRoot, "package.json"))) {
  const parent = dirname(piRoot);
  assert.notEqual(piRoot, parent, `Pi package.json not found above ${executable}`);
  piRoot = parent;
}
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  },
});
const publicServicePath = join(packageRoot, "src/service.ts");
process.env.PI_CODING_AGENT_DIR = agentDir;
const publicService = await jiti.import(publicServicePath);
const load = (name) => jiti.import(join(packageRoot, "src", `${name}.ts`));
const [
  { BashProgram },
  { PermissionManager },
  { PermissionResolver },
  { PathNormalizer },
  { posixPathFlavor },
  { resolveBashCommandCheck },
  { describeBashPathGate },
  { describeBashExternalDirectoryGate },
  { describeExternalDirectoryGate },
  { LocalUserAuthorizer },
  { createFailClosedToolCall },
  promptQueue,
  terminalTitle,
] = await Promise.all([
  load("access-intent/bash/program"),
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("path/path-normalizer"),
  load("path/path-flavor"),
  load("handlers/gates/bash-command"),
  load("handlers/gates/bash-path"),
  load("handlers/gates/bash-external-directory"),
  load("handlers/gates/external-directory"),
  load("authority/local-user-authorizer"),
  load("handlers/tool-call-boundary"),
  jiti.import(join(repo, "extensions/ui-prompt-queue.ts")),
  jiti.import(join(repo, "extensions/terminal-title-status.ts")),
]);

await runProtectedReadFloor(
  BashProgram,
  PermissionManager,
  PermissionResolver,
  PathNormalizer,
  posixPathFlavor,
  resolveBashCommandCheck,
  describeBashPathGate,
);
await runPromptLifecycle(LocalUserAuthorizer, promptQueue, terminalTitle, createFailClosedToolCall);
let opened;
try {
  opened = openManagedRepo(
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
  );
  await runResearcherCeiling(
    opened.scratch,
    opened.cwd,
    opened.configPath,
    agentDir,
    opened.normalizer,
    BashProgram,
    describeBashPathGate,
    PermissionManager,
    PermissionResolver,
  );
  const proof = await runParserMatrix(
    load,
    opened.cwd,
    opened.check,
    describeExternalDirectoryGate,
    opened.config,
    opened.resolver,
    opened.normalizer,
    opened.git,
    opened.scratch,
    PermissionResolver,
    PermissionManager,
    agentDir,
    BashProgram,
    resolveBashCommandCheck,
    opened.configPath,
    repo,
  );
  await runManagedSdk(
    piRoot,
    load,
    opened.scratch,
    opened.management,
    opened.childDenies,
    agentDir,
    publicServicePath,
    opened.cwd,
    publicService,
    opened.sessions,
    opened.externalScratch,
    require,
    opened.configPath,
    repo,
    proof.gitRequested,
    opened.check,
    proof.positive,
    proof.fixedRequested,
    proof.weeklyRequested,
    proof.localCd,
    proof.outsideCd,
    proof.cdBase,
  );
} finally {
  if (opened)
    await closeManagedRepo(
      opened.sessions,
      opened.externalScratch,
      opened.savedEnv,
      opened.scratch,
    );
}
