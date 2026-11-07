// Managed parser matrix checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
export async function runParserMatrix(
  load,
  cwd,
  check,
  describeExternalDirectoryGate,
  config,
  resolver,
  normalizer,
  git,
  scratch,
  PermissionResolver,
  PermissionManager,
  agentDir,
  BashProgram,
  resolveBashCommandCheck,
  configPath,
  repo,
) {
  const { hardenGitInput, originalGitCommands } = await load(
    "access-intent/bash/managed-read-policy",
  );
  const fixedRequested = [
    "command -v pi",
    "command -v alejandra",
    "command -v mypy",
    "bash -n syntax.sh",
    "env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER",
    "printenv BUILD_DIR AOBUS_BUILD_ROOT",
  ];
  const weeklyRequested = [
    "git diff --unified=0 -- ordinary.txt",
    "git diff --unified=80 -- ordinary.txt",
    "sed -n '1p;2,4p' ordinary.txt",
    "nl -ba ordinary.txt | sed -n '1,2p;2,4p'",
  ];
  const fixedPositive = [];
  for (const command of fixedRequested) {
    const input = { command };
    assert(await hardenGitInput(input), `Fixed query must be hardened: ${command}`);
    assert.deepEqual(originalGitCommands(input), [command]);
    fixedPositive.push(input.command);
  }
  const diff = "git diff";
  const gitRequested = [
    "git status --short",
    "git status --porcelain=v1 -z",
    "git status --short -- ordinary.txt",
    "git status --short --ignored",
    "git log -5 --oneline",
    "git log --oneline -n 20 HEAD",
    "git show HEAD:ordinary.txt",
    "env git show HEAD:ordinary.txt",
    "git ls-files",
    "git ls-files -- src",
    "git -C . status --short",
    "git --no-pager log -5 --oneline",
    `env ${diff}`,
    ...[
      "",
      " --stat",
      " --check",
      " --name-only",
      " --name-status",
      " --cached --stat",
      " --cached --check",
      " --unified=0",
      " --unified=9999",
      " --unified=3 --stat",
      " --no-renames -- ordinary.txt",
    ].map((suffix) => diff + suffix),
  ];
  for (const command of gitRequested) {
    const input = { command };
    assert.equal(
      await hardenGitInput(input, cwd),
      undefined,
      `Git input is not rewritten: ${command}`,
    );
    assert.equal(input.command, command);
    assert.deepEqual(Object.keys(input), ["command"]);
  }
  // Repository Git is deliberately not part of the automatic positive matrix.
  // The fixture's exact status allow is USER policy; all other forms ask.
  for (const agent of [undefined, "editor"])
    for (const command of gitRequested) {
      const result = await check(command, agent);
      assert.equal(
        result.bash.state,
        command === "git status --short" ? "allow" : "ask",
        `${agent}: ordinary Git policy: ${command}`,
      );
      assert.equal(
        result.program.commands().some((unit) => unit.managedReadOnly),
        false,
      );
    }
  for (const command of [
    "git add ordinary.txt",
    "git commit -m fixture",
    "git branch topic",
    "git tag v1",
  ]) {
    assert.equal(
      (await check(command, "editor")).bash.state,
      "ask",
      "editor writes use ordinary permission, never managed_static_read",
    );
    assert.equal(
      (await check(command, "editor")).program.commands().some((unit) => unit.managedReadOnly),
      false,
    );
  }
  const positive = [
    ...fixedPositive,
    "cut -d : -f 1 ordinary.txt",
    "nl -ba ordinary.txt",
    "readlink ordinary.txt",
    "sha256sum ordinary.txt",
    "cat ordinary.txt",
    "head -n 1 ordinary.txt",
    "sed -n '1p;2,4p' ordinary.txt",
    "sed -n '1,2p;2,$p' ordinary.txt",
    `sed -n '${Array(32).fill("1p").join(";")}' ordinary.txt`,
  ];
  const negative = [
    ...[
      "--unified",
      "--unified=",
      "--unified=-1",
      "--unified=10000",
      "--unified=3x",
      "--unif=3",
      "--unified 3",
      "-U",
      "-U-1",
      "-U10000",
      "-U3x",
      "-U 3",
    ].map((flag) => `${diff} --stat ${flag}`),
    ...[
      "1p;",
      ";1p",
      "1p;;2p",
      "0,2p;3p",
      "1p;2q",
      "1p;2e",
      "1p;w output.txt",
      "1p;r .env",
      "1p;s/a/b/e",
      "1p;#comment",
      "1p\\n2p",
      Array(33).fill("1p").join(";"),
    ].map((program) => `sed -n '${program}' ordinary.txt`),
    "sed -i -n '1p;2p' ordinary.txt",
    "sed -n '1p;2p' -f script.sed",
    "env sed -n '1p;2p' ordinary.txt",
    "sed -n '1p;2p' ordinary.txt > output.txt",
    "sed -n '1p;2p' ordinary.txt && touch output.txt",
    "command -v",
    "command -v git",
    "command -v ../pi",
    "command -v -- pi",
    "command pi",
    "bash -n",
    "bash -n syntax.sh extra",
    "bash -c syntax.sh",
    "bash -n .",
    "bash -n $FILE",
    "printenv",
    "printenv HOME",
    "printenv PI_OTHER",
    "printenv PI_MODEL HOME",
    "env",
    "env printenv HOME",
    "env FOO=bar printenv PI_MODEL",
    "ruff check syntax.sh",
    "ruff check --fix syntax.sh",
    "ruff check --output-file out syntax.sh",
    "ruff format --check syntax.sh",
    "git diff --not-a-real-option",
    `${diff} --output=ordinary.txt`,
    `${diff} --out=ordinary.txt`,
    `${diff} --o ordinary.txt`,
    `${diff} --ext-diff`,
    `${diff} --textconv`,
    `${diff} --no-renames -- ../repo/ordinary.txt`,
    `${diff} --no-renames -- ':(top)*'`,
    `${diff} --no-renames -- "$INPUT"`,
    `${diff} && touch ordinary.txt`,
    `env FOO=1 ${diff}`,
    `env -i ${diff}`,
    `timeout 5 ${diff}`,
    "git -c core.pager=cat status --short",
    "git blame ordinary.txt",
    "git log -p -1",
    "git ls-files --with-tree=HEAD",
    "git ls-files --recurse-submodules",
  ];
  for (const agent of [undefined, "editor"]) {
    for (const command of positive) {
      const result = await check(command, agent);
      assert.equal(result.bash.state, "allow", `${agent}: Bash: ${command}`);
      assert.equal(result.path, null, `${agent}: path: ${command}`);
      assert(
        !result.external || result.external.action === "allow",
        `${agent}: external: ${command}`,
      );
    }
    for (const command of negative) {
      const result = await check(command, agent);
      assert.notEqual(result.bash.state, "allow", `${agent}: unsupported command: ${command}`);
      assert(
        !result.program.commands().some((command) => command.floorExemption),
        `New proof reached wrapper core: ${command}`,
      );
      if (command === `${diff} && touch ordinary.txt`) {
        assert.equal(
          result.bash.state,
          "ask",
          "the mutating sibling still needs its own ordinary approval",
        );
        assert.notEqual(
          result.program.commands().find((unit) => unit.text === diff)?.managedReadOnly,
          true,
        );
        assert.notEqual(
          result.program.commands().find((unit) => unit.text.startsWith("touch "))?.managedReadOnly,
          true,
          "a sibling cannot inherit Git's read classification",
        );
      }
    }
    // Git-body eligibility is per COMMAND, not an allow for shell file effects.
    // Gate-only fixtures: never execute either redirect, even for an editor.
    for (const target of ["ordinary.txt", ".git/config"]) {
      const command = `${diff} > ${target}`,
        input = { command };
      assert.equal(await hardenGitInput(input, cwd), undefined);
      assert.equal(input.command, command);
      const result = await check(input.command, agent);
      assert.equal(result.program.commandText(), command);
      assert.equal(
        result.bash.state,
        "ask",
        `${agent}: repository Git uses normal Bash permission`,
      );
      assert.notEqual(
        result.program.commands().find((unit) => unit.text === diff)?.managedReadOnly,
        true,
      );
      assert(
        result.program
          .pathRuleCandidates()
          .some(
            (candidate) =>
              candidate.token === target &&
              candidate.effect.effect === "write" &&
              candidate.effect.source === "syntax",
          ),
        `actual shell redirect remains a syntax WRITE: ${command}`,
      );
      if (target === ".git/config") {
        assert.equal(
          result.path?.preCheck?.state,
          "deny",
          `${agent}: independent write/protected-target floor: ${command}`,
        );
      } else {
        assert.equal(
          result.path,
          null,
          `${agent}: existing ordinary workspace-write permission is unchanged`,
        );
      }
    }
    assert.equal((await check("echo fixture > ordinary.txt", agent)).path, null);
    assert.equal(
      (await check("echo fixture > ~/.pi/agent/settings.json", agent)).path.preCheck.state,
      "deny",
    );
    assert.equal(
      (await check("cut -f 1 /var/lib/pi-fixture/external.txt", agent)).external.preCheck.state,
      "ask",
    );
  }
  const procContext = (path) => ({
    toolCallId: "proc-fixture",
    toolName: "read",
    input: { path },
    cwd,
  });
  for (const path of ["/proc/meminfo", "/proc/self/mountinfo"]) {
    const gate = describeExternalDirectoryGate(
      procContext(path),
      config.piInfrastructureReadPaths,
      resolver,
      normalizer,
    );
    assert.equal(gate.preCheck.state, "allow", `Exact proc metadata scope: ${path}`);
  }
  const selfMount = normalizer.forPath("/proc/self/mountinfo");
  assert(selfMount.matchValues().includes("/proc/self/mountinfo"));
  assert.match(
    selfMount.boundaryValue(),
    /^\/proc\/\d+\/mountinfo$/,
    "Canonical self resolves to this Pi process, not a wildcard rule",
  );
  for (const path of [
    "/proc/1/environ",
    "/proc/self/environ",
    "/proc/self/fd",
    `/proc/${process.pid}/mountinfo`,
  ]) {
    const gate = describeExternalDirectoryGate(
      procContext(path),
      config.piInfrastructureReadPaths,
      resolver,
      normalizer,
    );
    assert.equal(gate.preCheck.state, "ask", `Other proc path remains review: ${path}`);
  }
  // A missing ordinary tracked file still has a narrow, policy-checked scope.
  rmSync(join(cwd, "ordinary.txt"));
  for (const agent of [undefined, "editor"]) {
    const deleted = await check(`${diff} --no-renames -- ordinary.txt`, agent);
    assert.equal(deleted.bash.state, "ask");
    assert.equal(deleted.path, null);
  }
  writeFileSync(join(cwd, "ordinary.txt"), "after\n");
  // Implicit whole-repository/history effects are no longer enumerated.
  // Literal paths and ordinary Bash review remain, not content provenance.
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=not-real\n");
  writeFileSync(join(cwd, "src/.env"), "FAKE_NESTED_FIXTURE=not-real\n");
  git("add", ".env", "src/.env");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fake sensitive fixture",
  );
  const scopedCheck = { command: "git diff --check" };
  await hardenGitInput(scopedCheck);
  assert.equal(
    (await check(scopedCheck.command)).path,
    null,
    "Unchanged protected files cannot disable ordinary diff/check",
  );
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=changed-private-marker\n");
  assert.equal(
    (await check(scopedCheck.command)).path,
    null,
    "No implicit working-tree/history enumeration: repository diff remains normal review",
  );
  for (const [requested, expected, gate] of [
    ["bash -n .env", "deny", "path"],
    ["bash -n /var/lib/pi-fixture/external.sh", "ask", "external"],
  ]) {
    const input = { command: requested };
    await hardenGitInput(input);
    const result = await check(input.command);
    assert.equal(
      result[gate].preCheck.state,
      expected,
      `Fixed syntax check retains ${gate} scope: ${requested}`,
    );
  }
  for (const suffix of [
    "--stat -p",
    "--stat --patch",
    "--stat --check",
    "--stat --binary",
    "--stat -U0",
    "--stat --unified=0",
    "--unified=3 --stat",
    "--name-only --unified=1",
  ]) {
    const mixed = { command: `git diff ${suffix}` };
    await hardenGitInput(mixed);
    assert.equal(
      (await check(mixed.command)).path,
      null,
      "Implicit file content is not attributed; ordinary Bash review remains",
    );
    assert.equal((await check(mixed.command)).bash.state, "ask");
  }
  for (const format of [
    "--stat",
    "--numstat",
    "--shortstat",
    "--summary",
    "--name-only",
    "--name-status",
  ]) {
    const metadata = { command: `git diff ${format}` };
    await hardenGitInput(metadata);
    assert.equal(
      (await check(metadata.command)).path,
      null,
      "No changed-file/history probe: unmentioned names are not a literal restriction",
    );
    assert.equal((await check(metadata.command)).bash.state, "ask");
    assert.equal(
      metadata.command,
      `git diff ${format}`,
      "summary formatting is not rewritten to weaken a path restriction",
    );
  }
  writeFileSync(join(cwd, ".env"), "FAKE_SECRET_FIXTURE=not-real\n");
  git("rm", "-q", ".env", "src/.env");
  for (const agent of [undefined, "editor"]) {
    assert.equal(
      (await check(`${diff} --cached`, agent)).path,
      null,
      "Historical-only names are not enumerated",
    );
    assert.equal((await check(`${diff} --cached`, agent)).bash.state, "ask");
    assert.equal(
      (await check(`${diff} --no-renames -- ordinary.txt`, agent)).path,
      null,
      "Explicit file proof does not read unrelated historical blobs",
    );
    for (const path of ["src", "src//", "./src/./", "."])
      assert.equal(
        (await check(`${diff} --cached --no-renames -- ${path}`, agent)).bash.state,
        "ask",
        "Directory content remains normal review, not a recursive read proof",
      );
  }
  writeFileSync(join(cwd, ".env"), "FAKE_UNTRACKED_FIXTURE\n");
  symlinkSync(".env", join(cwd, "alias.txt"));
  assert.equal((await check("cat alias.txt", "editor")).path.preCheck.state, "deny");
  assert.equal(
    (await check(`${diff} --no-renames -- alias.txt`)).path.preCheck.state,
    "deny",
    "Git proof retains canonical symlink policy",
  );
  assert.equal(
    (await check("git show HEAD:.env")).path?.preCheck.state,
    "deny",
    "Named historical secret stays a path deny",
  );
  // An explicit deny/ask and an invalid scope may never be replaced by proof.
  for (const action of ["ask", "deny"]) {
    const file = join(scratch, `policy-${action}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        permission: {
          ...config.permission,
          bash: { ...config.permission.bash, "git log -5 --oneline": action },
        },
      }),
    );
    const local = new PermissionResolver(
      new PermissionManager({
        globalConfigPath: file,
        agentsDir: join(agentDir, "agents"),
        mcpServerNames: [],
      }),
      { getRuleset: () => [] },
    );
    const p = await BashProgram.parse("git log -5 --oneline", normalizer);
    assert.equal(
      resolveBashCommandCheck(p.commandText(), p.commands(), undefined, local).state,
      action,
    );
  }
  for (const [index, requested] of [
    "bash -n syntax.sh",
    "env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER",
    ...weeklyRequested.filter((command) => !command.includes("|")),
  ].entries()) {
    const input = { command: requested };
    await hardenGitInput(input);
    for (const [surface, pattern] of [
      ["original", requested],
      ["hardened", input.command],
    ]) {
      for (const action of ["ask", "deny"]) {
        const file = join(scratch, `fixed-${index}-${surface}-${action}.json`);
        writeFileSync(
          file,
          JSON.stringify({
            ...config,
            permission: {
              ...config.permission,
              bash: { ...config.permission.bash, [pattern]: action },
            },
          }),
        );
        const local = new PermissionResolver(
          new PermissionManager({
            globalConfigPath: file,
            agentsDir: join(agentDir, "agents"),
            mcpServerNames: [],
          }),
          { getRuleset: () => [] },
        );
        const p = await BashProgram.parse(input.command, normalizer, {
          originalCommands: originalGitCommands(input),
        });
        assert.equal(
          resolveBashCommandCheck(p.commandText(), p.commands(), undefined, local).state,
          action,
          `${surface} ${action} wins: ${requested}`,
        );
      }
    }
  }
  const disabledProofPolicy = join(scratch, "disabled-proof.json");
  writeFileSync(
    disabledProofPolicy,
    JSON.stringify({ ...config, permission: { ...config.permission, managed_static_read: "ask" } }),
  );
  for (const requested of [...fixedRequested, ...weeklyRequested]) {
    const input = { command: requested };
    await hardenGitInput(input);
    const program = await BashProgram.parse(input.command, normalizer, {
      originalCommands: originalGitCommands(input),
    });
    const disabledResolver = new PermissionResolver(
      new PermissionManager({
        globalConfigPath: disabledProofPolicy,
        agentsDir: join(agentDir, "agents"),
        mcpServerNames: [],
      }),
      { getRuleset: () => [] },
    );
    assert.notEqual(
      resolveBashCommandCheck(
        program.commandText(),
        program.commands(),
        undefined,
        disabledResolver,
      ).state,
      "allow",
      `Managed opt-out: ${requested}`,
    );
  }
  const sessionInput = { command: "git log -7 --oneline" };
  await hardenGitInput(sessionInput);
  const sessionProgram = await BashProgram.parse(sessionInput.command, normalizer, {
    originalCommands: originalGitCommands(sessionInput),
  });
  for (const action of ["allow", "deny"]) {
    const sessionResolver = new PermissionResolver(
      new PermissionManager({
        globalConfigPath: disabledProofPolicy,
        agentsDir: join(agentDir, "agents"),
        mcpServerNames: [],
      }),
      {
        getRuleset: () => [
          {
            surface: "bash",
            pattern: "git log -7 --oneline",
            action,
            layer: "session",
            origin: "session",
          },
        ],
      },
    );
    const result = resolveBashCommandCheck(
      sessionProgram.commandText(),
      sessionProgram.commands(),
      undefined,
      sessionResolver,
    );
    assert.equal(result.state, action);
    assert.equal(
      result.source,
      "session",
      "Original session decision survives hardening with new grants disabled",
    );
  }
  const brokenAgents = join(scratch, "broken-agents");
  mkdirSync(brokenAgents);
  const brokenConfig = join(scratch, "broken-config.json");
  writeFileSync(brokenConfig, "{invalid-json");
  const brokenManager = new PermissionManager({
    globalConfigPath: configPath,
    projectGlobalConfigPath: brokenConfig,
    agentsDir: brokenAgents,
    mcpServerNames: [],
  });
  assert(brokenManager.getConfigIssues("broken").length > 0);
  const brokenResolver = new PermissionResolver(brokenManager, { getRuleset: () => [] });
  const p = await BashProgram.parse("git log -5 --oneline", normalizer);
  assert.notEqual(
    resolveBashCommandCheck(p.commandText(), p.commands(), "broken", brokenResolver).state,
    "allow",
  );
  const brokenFixed = { command: "bash -n syntax.sh" };
  await hardenGitInput(brokenFixed);
  const brokenFixedProgram = await BashProgram.parse(brokenFixed.command, normalizer, {
    originalCommands: originalGitCommands(brokenFixed),
  });
  assert.notEqual(
    resolveBashCommandCheck(
      brokenFixedProgram.commandText(),
      brokenFixedProgram.commands(),
      "broken",
      brokenResolver,
    ).state,
    "allow",
  );
  // Yolo turns asks into allows, never the floor's clamped allows.
  const yoloBroken = new PermissionResolver(
    new PermissionManager({
      globalConfigPath: configPath,
      projectGlobalConfigPath: brokenConfig,
      agentsDir: brokenAgents,
      mcpServerNames: [],
      isYoloEnabled: () => true,
    }),
    { getRuleset: () => [] },
  );
  // `cat *` is a fixture-only read-command allowance; invalid project scope clamps it to ask.
  const clamped = await BashProgram.parse("cat ordinary.txt", normalizer);
  assert.equal(
    resolveBashCommandCheck(clamped.commandText(), clamped.commands(), "broken", brokenResolver)
      .origin,
    "fail-closed",
    "the fixture really is a floored allow",
  );
  const floored = resolveBashCommandCheck(
    clamped.commandText(),
    clamped.commands(),
    "broken",
    yoloBroken,
  );
  assert.equal(floored.state, "ask", "yolo keeps the fail-closed floor");
  assert.equal(floored.origin, "fail-closed");
  const { resolveYoloGrant } = await load("handlers/gates/helpers");
  assert.equal(
    resolveYoloGrant(floored, true),
    null,
    "the post-resolution yolo grant keeps the floor too",
  );
  assert.equal(
    resolveYoloGrant({ ...floored, origin: "builtin" }, true)?.state,
    "allow",
    "an ordinary ask is still granted",
  );
  const plainAsk = await BashProgram.parse("printenv HOME", normalizer);
  const yoloValid = new PermissionResolver(
    new PermissionManager({
      globalConfigPath: configPath,
      agentsDir: join(agentDir, "agents"),
      mcpServerNames: [],
      isYoloEnabled: () => true,
    }),
    { getRuleset: () => [] },
  );
  assert.equal(
    resolveBashCommandCheck(plainAsk.commandText(), plainAsk.commands(), undefined, yoloValid)
      .state,
    "allow",
    "with a valid config, yolo still allows an ordinary ask",
  );
  console.log(
    `PASS: patched 32.0.3 real parser/gates, ${positive.length} non-Git positive/${negative.length} negative forms; ordinary Git review, literal secrets, external scope, writes, wrappers, config drift`,
  );

  // Drop the fake secret from HEAD as well, so the full positive matrix (not
  // only narrow diffs) reaches the actual SDK gates below. Untracked .env stays
  // for the secret-read negatives.
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "remove fake secret",
  );
  assert.equal((await check(`${diff} HEAD~1 HEAD`)).path, null, "No historical file enumeration");
  assert.equal((await check(`${diff} HEAD~1 HEAD`)).bash.state, "ask");
  assert.equal((await check(`${diff} HEAD~1 HEAD --no-renames -- src/code.ts`)).path, null);
  for (const flags of ["--unified=0", "--stat --unified=1"]) {
    const historical = { command: `git diff ${flags} HEAD~1 HEAD` };
    assert.equal(await hardenGitInput(historical, cwd), undefined);
    assert.equal(historical.command, `git diff ${flags} HEAD~1 HEAD`);
    assert.equal(
      (await check(historical.command)).path,
      null,
      "Implicit historical content is ordinary review, not an attributed read scope",
    );
    assert.equal((await check(historical.command)).bash.state, "ask");
  }
  symlinkSync("ordinary.txt", join(cwd, "doc-link"));
  git("add", "doc-link");
  assert.equal(
    (await check(diff)).path,
    null,
    "Tracked documentation symlinks do not disable the entire proof",
  );

  // No promisor/helper trial: the literal classifier never starts Git at all.
  // Partial clones, helpers and configured content sources are normal review,
  // not a repository proof or an isolation promise for approved execution.
  const querySource = readFileSync(join(repo, "permission-system/managed-git-query.ts"), "utf8");
  assert.doesNotMatch(
    querySource,
    /node:child_process|execFileSync|spawnSync|managed-git-unattributed|find-object=/,
  );
  assert.equal((await check(diff)).bash.state, "ask");
  console.log(
    "PASS: Git classifier has no subprocess/history-attribution implementation; repository commands use ordinary review",
  );
  const localCd = join(cwd, "nested"),
    cdBase = join(scratch, "cdpath"),
    outsideCd = join(cdBase, "nested");
  mkdirSync(localCd);
  mkdirSync(outsideCd, { recursive: true });
  for (const path of [localCd, outsideCd]) execFileSync("git", ["init", "-q"], { cwd: path });
  const cdInput = { command: "cd nested && git rev-parse --show-toplevel" };
  assert.equal(await hardenGitInput(cdInput), undefined);
  assert.equal(
    cdInput.command,
    "cd nested && git rev-parse --show-toplevel",
    "Leading cd in a Git program is not rewritten",
  );
  process.env.CDPATH = cdBase;
  try {
    const cdProgram = await BashProgram.parse(cdInput.command, normalizer);
    assert.equal(
      cdProgram.commands().some((unit) => unit.managedReadOnly),
      false,
      "CDPATH leading cd is not an automatic Git read",
    );
  } finally {
    delete process.env.CDPATH;
  }
  const implicitPath = { command: "git log --oneline src/code.ts" };
  assert.equal(await hardenGitInput(implicitPath), undefined);
  assert.equal(
    implicitPath.command,
    "git log --oneline src/code.ts",
    "No injected pathspec terminator",
  );
  assert.equal(
    (await BashProgram.parse(implicitPath.command, normalizer))
      .commands()
      .some((unit) => unit.managedReadOnly),
    false,
    "An unresolved log word is not an automatic read",
  );
  console.log(
    "PASS: CDPATH Git cd stays original and is not an automatic read; implicit log path is not rewritten",
  );
  // No raw Git execution: CDPATH is deliberately unresolved for permission,
  // not rewritten or verified by running the requested shell program.

  const fixedBin = join(scratch, "fixed-bin");
  mkdirSync(fixedBin);
  const targetCanary = join(scratch, "command-target-ran");
  writeFileSync(join(fixedBin, "pi"), '#!/bin/sh\nprintf ran > "$PI_TARGET_CANARY"\n', {
    mode: 0o755,
  });
  const commandProbe = { command: "command -v pi" };
  await hardenGitInput(commandProbe);
  const commandOutput = spawnSync("bash", ["-c", commandProbe.command], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixedBin}:${process.env.PATH}`,
      PI_TARGET_CANARY: targetCanary,
    },
  });
  assert.equal(commandOutput.status, 0);
  assert.equal(commandOutput.stdout.trim(), join(fixedBin, "pi"));
  assert(!existsSync(targetCanary), "command lookup must not execute its target");

  const bashEnvCanary = join(scratch, "bash-env-ran"),
    bashSourceCanary = join(scratch, "bash-source-ran");
  const bashEnv = join(scratch, "bash-env.sh");
  writeFileSync(bashEnv, 'printf startup > "$BASH_ENV_CANARY"\n');
  const syntaxProbe = { command: "bash -n syntax.sh" };
  await hardenGitInput(syntaxProbe);
  assert.match(syntaxProbe.command, /^bash --noprofile --norc -p -n -- /);
  // Invoke the hardened child directly: an outer `bash -c` would itself read
  // BASH_ENV before it could launch the child and would test the harness shell,
  // not the syntax-check Bash this normalization hardens.
  const syntaxEnv = {
    ...process.env,
    BASH_ENV: bashEnv,
    BASH_ENV_CANARY: bashEnvCanary,
    BASH_SOURCE_CANARY: bashSourceCanary,
    SHELLOPTS: "braceexpand:extglob:hashall:interactive-comments",
    BASHOPTS:
      "checkwinsize:cmdhist:complete_fullquote:extquote:force_fignore:globasciiranges:globskipdots:hostcomplete:interactive_comments:patsub_replacement:progcomp:promptvars:sourcepath",
    "BASH_FUNC_fixture_imported%%": "() { :; }",
  };
  const syntaxResult = spawnSync("bash", ["--noprofile", "--norc", "-p", "-n", "--", "syntax.sh"], {
    cwd,
    encoding: "utf8",
    env: syntaxEnv,
  });
  assert.equal(syntaxResult.status, 0, syntaxResult.stderr);
  assert(!existsSync(bashEnvCanary), "Privileged syntax Bash must ignore BASH_ENV");
  assert(!existsSync(bashSourceCanary), "Syntax checking must not execute the source file");
  assert.notEqual(
    spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", "type fixture_imported"], {
      cwd,
      encoding: "utf8",
      env: syntaxEnv,
    }).status,
    0,
    "Privileged Bash must ignore imported functions",
  );
  assert.notEqual(
    spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", "shopt -q extglob"], {
      cwd,
      encoding: "utf8",
      env: syntaxEnv,
    }).status,
    0,
    "Privileged Bash must ignore startup option variables",
  );

  const environment = {
    ...process.env,
    PI_MODEL: "fixture-model",
    PI_MODEL_ID: "fixture-id",
    PI_PROVIDER: "fixture-provider",
    BUILD_DIR: "fixture-build",
    AOBUS_BUILD_ROOT: "fixture-root",
    SECRET_FIXTURE: "must-not-leak",
  };
  for (const [requested, expected] of [
    [
      "env printenv PI_MODEL PI_MODEL_ID PI_PROVIDER",
      ["fixture-model", "fixture-id", "fixture-provider"],
    ],
    ["printenv BUILD_DIR AOBUS_BUILD_ROOT", ["fixture-build", "fixture-root"]],
  ]) {
    const input = { command: requested };
    await hardenGitInput(input);
    const output = spawnSync("bash", ["-c", input.command], {
      cwd,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(output.status, 0);
    assert.deepEqual(output.stdout.trim().split("\n"), expected);
    assert(
      !output.stdout.includes("must-not-leak"),
      "Fixed printenv must not disclose other variables",
    );
  }
  console.log("PASS: actual fixed-query target, BASH_ENV/source, and bounded environment canaries");

  // Execute only fabricated inputs. Multi-range sed keeps disjoint ranges AND
  // overlapping duplicate prints; recognizing a long Git flag preserves output.
  writeFileSync(join(cwd, "ranges.txt"), "one\ntwo\nthree\nfour\nfive\n");
  for (const [program, expected] of [
    ["1p;3,4p", "one\nthree\nfour\n"],
    ["1,3p;2,4p", "one\ntwo\ntwo\nthree\nthree\nfour\n"],
    ["4p;1,2p", "one\ntwo\nfour\n"],
  ]) {
    const command = `sed -n '${program}' ranges.txt`;
    assert.equal((await check(command)).bash.state, "allow");
    const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
  }
  for (const count of [0, 3, 80]) {
    const long = { command: `git diff --unified=${count} -- ordinary.txt` };
    const short = { command: `git diff -U${count} -- ordinary.txt` };
    assert.equal(await hardenGitInput(long, cwd), undefined);
    assert.equal(await hardenGitInput(short, cwd), undefined);
    assert.equal(long.command, `git diff --unified=${count} -- ordinary.txt`);
    assert.equal(short.command, `git diff -U${count} -- ordinary.txt`);
  }
  console.log(
    "UNRUN: unified long/short native output comparison; parent has not assigned execution",
  );
  for (const agent of [undefined, "editor"]) {
    for (const path of [".env", "alias.txt"])
      assert.equal((await check(`sed -n '1p;2,4p' ${path}`, agent)).path.preCheck.state, "deny");
    assert.equal(
      (await check("sed -n '1p;2,4p' /var/lib/pi-fixture/external.txt", agent)).external.preCheck
        .state,
      "ask",
    );
  }
  console.log(
    "PASS: Git context flags stay original and review-only; multi-range sed preserves actual output and path gates",
  );
  return { positive, fixedRequested, weeklyRequested, localCd, outsideCd, cdBase, gitRequested };
}
