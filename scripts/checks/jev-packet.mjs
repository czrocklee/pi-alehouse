// Jev packet provenance checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  globalInstructionFixture,
  projectInstructionFixture,
} from "../../harness/test/support/project-instructions.mjs";
import { allowAnswers, mockResponse } from "./jev-wire.mjs";
export async function runJevPacket(
  check,
  buildUserContext,
  captureApiKeyFile,
  delegationBindingFailure,
  invokedScriptFact,
  buildProjectRestrictions,
) {
  /* ---------------------------------------------------------------- *
   * Authorization completeness, reload, and delegated Run binding
   * ---------------------------------------------------------------- */
  const messageEntry = (text) => ({ type: "message", message: { role: "user", content: text } });
  const firstAuthorization = messageEntry("Inspect the project.");
  const hiddenRestriction = messageEntry(
    `Never inspect private-notes. ${"padding ".repeat(40_000)}`,
  );
  const latestAuthorization = messageEntry("Continue with the inspection.");
  const liveMessages = new Map([
    [firstAuthorization.message, firstAuthorization.message.content],
    [hiddenRestriction.message, hiddenRestriction.message.content],
    [latestAuthorization.message, latestAuthorization.message.content],
  ]);
  check(
    "an omitted middle live restriction defers",
    buildUserContext([firstAuthorization, hiddenRestriction, latestAuthorization], {
      text: (message) => liveMessages.get(message),
    }),
    { ok: false, failureCode: "context_oversize" },
  );

  const reloadGlobal = {};
  const firstEnvironment = { PI_JEV_API_KEY_FILE: "/run/secrets/jev" };
  check(
    "first module load captures the key path",
    captureApiKeyFile(firstEnvironment, reloadGlobal),
    "/run/secrets/jev",
  );
  check(
    "first module load scrubs the environment",
    firstEnvironment.PI_JEV_API_KEY_FILE,
    undefined,
  );
  check(
    "reload retains the captured key path",
    captureApiKeyFile({}, reloadGlobal),
    "/run/secrets/jev",
  );
  check(
    "reload cannot replace the original key path",
    captureApiKeyFile({ PI_JEV_API_KEY_FILE: "/tmp/replacement" }, reloadGlobal),
    "/run/secrets/jev",
  );

  const boundAuthorization = {
    messages: [],
    totalDirectUserMessages: 0,
    omittedDirectUserMessages: 0,
    totalUnverifiedUserMessages: 0,
    omittedUnverifiedUserMessages: 0,
    rawAuthorizationHistoryComplete: true,
  };
  const hashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const witness = {
    protocol: 1,
    owner_id: "parent",
    generation: "owner-generation",
    agent_id: "agent",
    run_id: "run",
    profile: "editor",
    definitionDigest: "fixture-definition",
    task_prompt: "inspect",
    prompt: "inherited\n\ninspect",
    systemPrompt: "",
  };
  const promptDigest = hashJson(witness.prompt);
  const runBinding = {
    parentSessionId: "parent",
    expectedCwd: "/work",
    generation: 3,
    userAuthorization: boundAuthorization,
    authorizationDigest: "auth-a",
    calls: [{ profile: "editor", promptDigest }],
    runId: "run",
    childSystemPrompt: "",
    harnessDigest: hashJson(
      Object.fromEntries(
        Object.keys(witness)
          .sort()
          .map((key) => [key, witness[key]]),
      ),
    ),
  };
  const initialRun = {
    parentSessionId: "parent",
    cwd: "/work",
    initialPromptDigest: promptDigest,
    harness: witness,
  };
  check(
    "initial child Run remains bound",
    delegationBindingFailure(runBinding, initialRun, {
      sessionId: "parent",
      cwd: "/work",
      generation: 3,
      authorizationDigest: "auth-a",
      agentName: "editor",
    }),
    undefined,
  );
  check(
    "changed child context invalidates the snapshot",
    delegationBindingFailure(
      runBinding,
      { ...initialRun, contextChanged: true },
      {
        sessionId: "parent",
        cwd: "/work",
        generation: 3,
        authorizationDigest: "auth-a",
        agentName: "editor",
      },
    ),
    "delegation_context_changed",
  );
  check(
    "new parent restrictions invalidate the snapshot",
    delegationBindingFailure(runBinding, initialRun, {
      sessionId: "parent",
      cwd: "/work",
      generation: 3,
      authorizationDigest: "auth-b",
      agentName: "editor",
    }),
    "delegation_context_changed",
  );
  check(
    "a different child prompt cannot borrow the snapshot",
    delegationBindingFailure(
      runBinding,
      { ...initialRun, initialPromptDigest: "prompt-b" },
      {
        sessionId: "parent",
        cwd: "/work",
        generation: 3,
        authorizationDigest: "auth-a",
        agentName: "editor",
      },
    ),
    "delegation_unbound",
  );

  /* ---------------------------------------------------------------- *
   * invokedScript containment
   *
   * The packet quotes the body of a script the action will run, which
   * turns "unknown" into "known hostile" but never into "known safe".
   * Its whole safety rests on staying inside the working tree, so the
   * escapes are tested against real files rather than reasoned about.
   * ---------------------------------------------------------------- */
  const scratch = mkdtempSync(join(tmpdir(), "pi-jev-script-"));
  try {
    const tree = join(scratch, "tree");
    mkdirSync(join(tree, "sub"), { recursive: true });
    writeFileSync(join(tree, "sub/ok.sh"), "#!/bin/sh\ncmake --build build\n");
    writeFileSync(join(scratch, "outside.sh"), "#!/bin/sh\necho outside\n");
    symlinkSync(join(scratch, "outside.sh"), join(tree, "escape.sh"));
    // Random bytes decode to U+FFFD rather than NUL, so a literal NUL test on the
    // decoded string passes a binary through; both checks are required.
    writeFileSync(
      join(tree, "prog.bin"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0xff, 0xfe, 0x01]),
    );
    writeFileSync(join(tree, "big.sh"), `#!/bin/sh\n# ${"x".repeat(40_000)}\n`);

    const body = (command) => invokedScriptFact(tree, command)?.body;
    check("reads a script run via an interpreter", body("sh sub/ok.sh")?.includes("cmake"), true);
    check("reads a script run directly", body("./sub/ok.sh --jobs 4")?.includes("cmake"), true);
    check(
      "reads through a leading pipeline segment",
      body("set -e; ./sub/ok.sh")?.includes("cmake"),
      true,
    );
    check("refuses a symlink out of the tree", invokedScriptFact(tree, "sh escape.sh"), null);
    check(
      "refuses a relative path out of the tree",
      invokedScriptFact(tree, "sh ../outside.sh"),
      null,
    );
    check("refuses an absolute path", invokedScriptFact(tree, "sh /etc/passwd"), null);
    check("refuses a binary", invokedScriptFact(tree, "./prog.bin"), null);
    check("refuses an oversize file", invokedScriptFact(tree, "sh big.sh"), null);
    check("ignores a bare command with no path", invokedScriptFact(tree, "node --version"), null);
    check("ignores a missing file", invokedScriptFact(tree, "sh sub/gone.sh"), null);
    const fact = invokedScriptFact(tree, "sh sub/ok.sh");
    check("the body is labelled untrusted", fact.trust, "untrusted_evidence");
    check("the path is recorded", fact.path.endsWith("sub/ok.sh"), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runJevPacketInstructions(
  check,
  registeredHarness,
  offlineRuntime,
  buildProjectRestrictions,
) {
  // Synthetic repository-sized instructions plus global policy must fit without
  // weakening the cue or dropping lines. This used to exceed the 700-token cap.
  {
    const h = registeredHarness();
    h.setSystemPrompt(`<project_context>Project-specific instructions and guidelines:
<project_instructions path="/fixture/global/AGENTS.md">${globalInstructionFixture}</project_instructions>
<project_instructions path="/fixture/repo/AGENTS.md">${projectInstructionFixture}</project_instructions>
</project_context>`);
    h.live("Inspect repository status.");
    let packet;
    globalThis.fetch = async (_url, init) => {
      packet = JSON.parse(init.body).state;
      return mockResponse(allowAnswers());
    };
    check(
      "synthetic repo plus global instructions reach reviewer",
      await h.authorize(h.call("realistic-instructions")),
      { kind: "allow" },
    );
    check(
      "both realistic loaded sources survive",
      packet.projectInstructionExcerpts.sourceFileCount,
      2,
    );
    check(
      "realistic regression exceeds the old budget",
      JSON.stringify(packet.projectInstructionExcerpts.entries).length / 4 > 700,
      true,
    );
    check(
      "synthetic repository prohibition is preserved",
      packet.projectInstructionExcerpts.entries.some((entry) =>
        entry.text.includes("Never commit plaintext secrets."),
      ),
      true,
    );
  }

  // Project restrictions come from the loaded system prompt. Lines are preserved
  // whole; malformed envelopes and known budget loss defer before fetch.
  {
    const h = registeredHarness();
    const fullLine = `${"Background. ".repeat(40)}Never inspect private-notes.`;
    h.setSystemPrompt(`<project_context><project_instructions path="/loaded/AGENTS.md">
# Guardrails
${fullLine}
</project_instructions></project_context>`);
    h.live("Inspect repository status.");
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body).state;
      return mockResponse(allowAnswers());
    };
    check(
      "loaded project restriction allows normal review",
      await h.authorize(h.call("project-full-line")),
      { kind: "allow" },
    );
    check(
      "selected restriction line is not sliced",
      sent.projectInstructionExcerpts.entries[0].text,
      fullLine,
    );
    check(
      "loaded restriction source is retained",
      sent.projectInstructionExcerpts.entries[0].source,
      "/loaded/AGENTS.md",
    );
  }

  {
    const h = registeredHarness();
    h.setSystemPrompt(`<project_context><project_instructions path="/ancestor/AGENTS.md">Only inspect src/public.
只能在 src/public 中进行检查。
You mustn't publish internal files.
You mustn’t remove backups.
You shouldn't change unrelated files.
You shouldn’t skip verification.
</project_instructions></project_context>`);
    writeFileSync(join(offlineRuntime, "AGENTS.md"), "Never inspect disk-only.");
    const parsed = buildProjectRestrictions(h.ctx);
    check("loaded ancestor instructions are selected", parsed.ok, true);
    check(
      "English, Chinese and contracted prohibitions survive",
      parsed.restrictions.entries.map((entry) => entry.text),
      [
        "Only inspect src/public.",
        "只能在 src/public 中进行检查。",
        "You mustn't publish internal files.",
        "You mustn’t remove backups.",
        "You shouldn't change unrelated files.",
        "You shouldn’t skip verification.",
      ],
    );
    check(
      "disk instruction changes cannot replace the loaded snapshot",
      parsed.restrictions.sourceFileCount,
      1,
    );
  }

  for (const [name, prompt, failure] of [
    [
      "malformed",
      `<project_context><project_instructions path="/loaded/AGENTS.md">Never modify x.</project_context>`,
      "context_incomplete",
    ],
    [
      "balanced escape",
      `<project_context><project_instructions path="/loaded/AGENTS.md">Only inspect public files.
</project_instructions>Never push to main.<project_instructions path="x">Keep changes focused.
</project_instructions></project_context>`,
      "context_incomplete",
    ],
    [
      "balanced outer escape",
      `<project_context><project_instructions path="x">Only inspect public files.
</project_instructions></project_context>Never push to main.<project_context><project_instructions path="y">
Keep changes focused.</project_instructions></project_context>`,
      "context_incomplete",
    ],
    [
      "uncovered tail",
      `<project_context><project_instructions path="x">Only inspect public files.</project_instructions>
Never push to main.</project_context>`,
      "context_incomplete",
    ],
    [
      "nested tags",
      `<project_context><project_instructions path="x"><project_instructions path="y">Never push to main.
</project_instructions></project_instructions></project_context>`,
      "context_incomplete",
    ],
    [
      "budget",
      `<project_context><project_instructions path="/loaded/AGENTS.md">${Array.from(
        { length: 120 },
        (_, i) => `Never modify area-${i}-${"x".repeat(30)}.`,
      ).join("\n")}</project_instructions></project_context>`,
      "context_oversize",
    ],
  ]) {
    const h = registeredHarness();
    h.setSystemPrompt(prompt);
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    check(`${name} project context defers`, await h.authorize(h.call(`project-${name}`)), {
      kind: "defer",
    });
    check(`${name} project context does not fetch`, fetchCalls, 0);
    check(`${name} project context reports ${failure}`, h.reviews.at(-1).failureCode, failure);
  }
}
