/**
 * Static-guard self-test for the source check lane only. It is neither shipped
 * nor generated into runtime/policy, and the guard never loads it. Policy checks
 * call safetySelfTest with the generated guard's normal default entry, generated
 * profile names and lexical helper. Commands here are data: no shell, Git, or network runs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StaticSafetySelfTestDeps = {
  guard: (pi: {
    registerTool: () => void;
    on: (name: string, handler: (...args: any[]) => any) => void;
    events: { on: () => () => void; emit: () => void };
  }) => void;
  workerProfiles: readonly string[];
  inspectGitCommands: (source: string) => Array<{
    subcommand: string | undefined;
    unknownGlobals: boolean;
    wrapped: boolean;
    configOverride: boolean;
  }>;
};

export function safetySelfTest(root: string, deps: StaticSafetySelfTestDeps): void {
  const scratch = mkdtempSync(join(tmpdir(), "pi-guard-test-"));
  try {
    // Dynamic redirects and non-Git environment prefixes exercise the
    // static-allow defense, not blanket command denies. These four allowances
    // are deliberately absent from the shipped policy.
    // Use a private, data-only guard fixture: never edit the supplied policy or
    // load this fixture into the permission authority. Existing rules survive.
    const config = JSON.parse(
      readFileSync(join(root, "extensions/pi-permission-system/config.json"), "utf8"),
    ) as { permission: { bash: Record<string, unknown> } };
    const bash = { ...config.permission.bash };
    for (const pattern of ["sort *", "uniq *", "node --version", "python3 --version"])
      if (!Object.hasOwn(bash, pattern)) bash[pattern] = "allow";
    const policyRoot = join(scratch, "policy");
    const policyDirectory = join(policyRoot, "extensions/pi-permission-system");
    mkdirSync(policyDirectory, { recursive: true });
    writeFileSync(join(policyDirectory, "config.json"), JSON.stringify({ permission: { bash } }), {
      mode: 0o600,
    });
    const handlers = new Map<string, (...args: any[]) => any>();
    // The normal synchronous entry captures its configured root at registration.
    // Keep fixture selection here rather than exporting a production test registrar.
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = policyRoot;
    try {
      deps.guard({
        registerTool: () => {},
        on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
        events: { on: () => () => {}, emit: () => {} },
      });
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
    handlers.get("session_start")!(
      {},
      { sessionManager: { getSessionId: () => "static-selftest" } },
    );
    writeFileSync(join(scratch, ".env"), "FAKE_SECURITY_FIXTURE=not-a-secret\n");
    writeFileSync(join(scratch, "normal.txt"), "safe fixture\n");
    mkdirSync(join(scratch, "docs"));
    symlinkSync(scratch, join(scratch, "linked-directory"));
    const context = (agent?: string) => ({
      cwd: scratch,
      getSystemPrompt: () => (agent ? `<active_agent name="${agent}">` : ""),
      sessionManager: { getEntries: () => [], getSessionId: () => "static-selftest" },
    });
    // Invoke the registered guard hook directly, below harness tool exposure.
    // Researcher Bash cases test guard depth, not an executable child route;
    // identity, redirect and Git cases retain their separate guard obligations.
    const call = (toolName: string, input: Record<string, unknown>, agent?: string) =>
      handlers.get("tool_call")!({ toolName, input }, context(agent));
    // Data-only guard checks: an absent static refusal is NOT a permission
    // allow. The authority still checks paths, helpers and ordinary approval.
    const gitApprovalRoute = [
      "git show -s",
      "git show -s HEAD",
      "git show HEAD",
      "git show -s deadbeef",
      "git show -s refs/tags/blob",
      "git show -s HEAD:.env",
      "git show -s --output=ordinary.txt HEAD",
      "git log -5 --oneline --ext-diff",
      "git log --textconv",
      "git log --format=raw --patch",
      "git status --short -- $INPUT",
      "git log -5 --oneline $REF",
      "command git show HEAD",
      "if true; then git log --textconv; fi",
      "git -P show -s deadbeef",
      "git -p show -s deadbeef",
      "git --bare show -s HEAD",
      "git --namespace=foo show -s HEAD",
      "git -C . show -s deadbeef",
      "git -C . -P show -s deadbeef",
      "git -P -C . show -s deadbeef",
      "command git -P show -s deadbeef",
      "git --git-dir=.git show -s deadbeef",
      "GIT_CONFIG_PARAMETERS=\"'core.pager=cat'\" git log -1 --oneline",
      'GIT_CONFIG_VALUE_0="`pwd`/fixture" git status --short',
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./fixture-hook git status --short",
      "LC_ALL=C git diff --stat",
      "FOO='a b' git status --short && git diff --check",
      "git diff --check; FOO=bar git status --short",
      "FOO=bar command git status --short",
    ];
    for (const command of gitApprovalRoute) {
      if (call("bash", { command })?.block)
        throw new Error(`Git approval route statically refused: ${command}`);
    }
    // The grep override exercises descendant permissions in check-pi-policy.mjs.
    const denied = [
      ["unlisted-worker", "git status --short"],
      ["editor", "pwd >> new-output"],
      ["editor", "cd docs && echo ok >normal.txt"],
      ...[
        "PATH=./fixture-bin git status --short",
        'PATH="`pwd`" git status --short',
        "PATH=$(pwd) git status --short",
        'PATH="$(pwd)" git status --short',
        "PATH=`pwd` git status --short",
        "LD_PRELOAD=./fixture.so git status",
        "GIT_EXTERNAL_DIFF=./fixture git diff",
        "env PATH=./fixture-bin git status --short",
        "/usr/bin/env GIT_EDITOR=./fixture /usr/bin/git status",
      ].map((command) => [undefined, command]),
      ...[
        "nl *.txt",
        "nl $INPUT",
        "sha256sum *.txt",
        "sha256sum $INPUT",
        "sha256sum < $INPUT",
        "sha256sum -c sums",
        "sha256sum --check sums",
        "sha256sum --ch sums",
        "sha256sum --check=sums",
        "sha256sum -bc sums",
        "sha256sum --ignore-missing sums",
        "sha256sum -- sums*",
        "printf -v PATH fixture",
        "printf '%n' PATH",
        "printf '%s%n' ok PATH",
        "printf '%q' ok",
        "printf '%(x)T' 0",
        'printf "$FORMAT" ok',
        "printf $(echo %s) ok",
        "printf -- '%n' PATH",
        "printf '%s' ok > $OUTPUT",
        "echo ok > $OUTPUT",
        "PATH=/fixture echo ok",
        "PATH=/fixture printf ok",
        "echo ok <<EOF\n$(touch fixture)\nEOF",
        "printf ok <<EOF\n$(touch fixture)\nEOF",
      ].map((command) => [undefined, command]),
      [undefined, 'wc -l <<< "$(PATH=/fixture git status --short)"'],
      [undefined, "cat *"],
      [undefined, "tail ${INPUT}"],
      [undefined, "cut -f 1 *.txt"],
      [undefined, "readlink $INPUT"],
      [undefined, "readlink *.txt"],
      [undefined, "tr a-z A-Z < *.txt"],
      [undefined, "tr a-z A-Z < $INPUT"],
      [undefined, "sort < $INPUT"],
      [undefined, "uniq < *.txt"],
      [undefined, "rg --no-config -- fixture ordinary.txt"],
      [undefined, "rg --no-config -d 0 -- fixture *.txt"],
      [undefined, "rg --no-config -d 0 -- [ab]* normal.txt"],
      [undefined, "rg --no-config -d 0 -- fixture $INPUT"],
      [undefined, "rg --no-config -d 0 -- fixture - < *.txt"],
      [undefined, "rg --no-config --pre cat -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -z -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --hostname-bin=fixture -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -f patterns -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --ignore-file patterns -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config --follow -d 0 -- fixture normal.txt"],
      [undefined, "rg --no-config -d 0 -d 2 -- fixture normal.txt"],
      [undefined, "rg --no-config --files --pre cat -- ."],
      [undefined, "rg --no-config --files -- /var/lib/pi-policy-fixture"],
      [undefined, "rg --no-config --files -- linked-directory"],
      [undefined, "rg --no-config --files -- . .."],
      [undefined, "rg --no-config --files --glob=$INPUT -- ."],
      [undefined, "cd linked-directory && rg --no-config -- fixture normal.txt"],
      [undefined, "if true; then rg --no-config --pre cat -- fixture normal.txt; fi"],
      [undefined, "PATH=/fixture rg --no-config -d 0 -- fixture normal.txt"],
      [undefined, "head *"],
      [undefined, "wc -l *.txt"],
      [undefined, "head ${INPUT}"],
      [undefined, "head < *"],
      [undefined, "< * head -n 10"],
      [undefined, "wc --files0-from=names"],
      [undefined, "wc --files0-from names"],
      [undefined, "wc --f=names"],
      [undefined, "wc --files0-fr names"],
      [undefined, "wc --files0-from=-"],
      [undefined, "PATH=/fixture head ordinary.txt"],
      [undefined, "wc -l <<EOF\n$(PATH=/fixture git status --short)\nEOF"],
      [undefined, "wc -l <<-EOF\n\t`PATH=/fixture git status --short`\n\tEOF"],
      [undefined, "PATH=./fixture-bin node --version"],
      [undefined, "LD_PRELOAD=./fixture.so python3 --version"],
      [undefined, "sudo true"],
      [undefined, "/run/wrappers/bin/sudo true"],
      [undefined, "sudo\ttrue"],
      [undefined, '\"sudo\" true'],
      [undefined, '\"sudo\"'],
      [undefined, 's"u"do true'],
      [undefined, '"sudo" "$USER"'],
      [undefined, '/run/wrappers/bin/sudo true; echo "$HOME"'],
      [undefined, 'echo "$HOME"; "sudo" true'],
      [undefined, 'printf ok > /tmp/out; "sudo" true'],
      [undefined, 'if true; then "sudo" true; fi'],
      [undefined, '>/tmp/out "sudo" true'],
      [undefined, '2>&1 "sudo" true'],
      [undefined, 'while false; do "sudo" true; done'],
      [undefined, "true && /run/wrappers/bin/sudo true | cat"],
      ["researcher", "git --no-pager push"],
      ["researcher", "git -C '/tmp/a b' --no-pager push origin main"],
      ["researcher", "'/usr/bin/git' --paginate commit -m fixture"],
      [undefined, "cat <<'EOF'\nsudo true\nEOF\n\"sudo\" true"],
      [undefined, 'cat <<-"EOF"\n\tsudo true\n\tEOF\n"sudo" true'],
      [undefined, "cat <<A <<'B'\nsudo true\nA\nsudo true\nB\n\"sudo\" true"],
      [undefined, "\"sudo\" true; cat <<'EOF'\nsafe fixture\nEOF"],
    ];
    for (const [agent, command] of denied) {
      // This callback runs even when an upstream session grant returned allow.
      if (!call("bash", { command }, agent)?.block)
        throw new Error(`Literal deny escaped: ${agent}: ${command}`);
    }
    for (const [command, subcommand, unknown, wrapped, config] of [
      ["git -P show -s deadbeef", "show", false, false, false],
      ["git --bare show -s HEAD", "show", false, false, false],
      ["command git -P show -s deadbeef", "show", false, false, false],
      ["timeout 5 git -P show -s deadbeef", "show", false, true, false],
      ["env git -C . show -s deadbeef", "show", false, true, false],
      [
        "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git -p log",
        "log",
        false,
        true,
        true,
      ],
      ["GIT_CONFIG_PARAMETERS=x git -p log", "log", false, false, true],
    ] as const) {
      const [invocation] = deps.inspectGitCommands(command);
      if (
        invocation?.subcommand !== subcommand ||
        invocation.unknownGlobals !== unknown ||
        invocation.wrapped !== wrapped ||
        invocation.configOverride !== config
      ) {
        throw new Error(`Git invocation parse drifted: ${command}`);
      }
    }
    for (const command of [
      "nl -ba normal.txt",
      "sha256sum normal.txt",
      "sha256sum -btz normal.txt",
      "sha256sum --tag normal.txt",
      "sha256sum -- --check",
      "sha256sum - < normal.txt",
      "printf 'exit=%s\\n' \"$?\"",
      "printf '%s %% done\\n' \"$status\"",
      "printf -- '-%s' ok",
      'echo "$status"',
      "env printf -v PATH fixture",
      'env printf "$FORMAT" ok',
      "env sha256sum --check sums",
      "wc -l <<'EOF'\n$(PATH=/fixture git status --short)\nEOF",
      "wc -l <<\\EOF\n$(PATH=/fixture git status --short)\nEOF",
      "wc -l <<EOF\nplain fixture text\nEOF",
      "env wc -l <<EOF\n$(PATH=/fixture git status --short)\nEOF",
      "cat -n normal.txt",
      "tail -n 20 normal.txt",
      "cut -f 1 normal.txt",
      "tr a-z A-Z < normal.txt",
      "tr '[:upper:]' '[:lower:]' < normal.txt",
      "sort -u < normal.txt",
      "uniq -c < normal.txt",
      "rg --no-config -n -d 0 -- '[ab]*$|x(y)' normal.txt",
      "rg --no-config -d 0 -- 'fixture with spaces' normal.txt",
      "rg --no-config -F -d 0 -- '--pre cat' normal.txt",
      "rg --no-config -- fixture - < normal.txt",
      "rg --no-config --files --hidden -g '*.txt' -- .",
      "rg --no-config --files --",
      "cd linked-directory && rg --no-config -d 0 -- fixture normal.txt",
      "env rg --pre cat fixture .",
      "head -45 normal.txt",
      "wc -l -c normal.txt",
      "head -n 10 < normal.txt",
      "env wc --files0-from=names",
      "env head *.txt",
      "echo ok >normal.txt",
      // Wrapped Git keeps the normal managed/approval route, not a permission grant.
      "env git show HEAD",
      "env git -P show -s deadbeef",
      "timeout 5 git -P show -s deadbeef",
      "FOO=bar python3 -c 'print(1); print(2)'",
      "echo ok >./sudo",
      "echo ok 2>&1",
      "echo ok 2>&-",
      "git diff -- path",
      "git --no-pager status && git diff --stat",
      "git log --oneline HEAD~5..HEAD",
      "git log -n5",
      "git log --max-count=5",
      "git show -s --format=%ci HEAD~1",
      "git show -s HEAD^{commit}",
      "git log --oneline @{1}",
      "git -P status",
      "git -P show -s --format=%ci HEAD^0",
      "git -C . status --short",
      "printf ok | cat",
      "python3 -c 'x=1; print(x)'",
      "node -e 'console.log(\"hello; world\")'",
      "cat <<'EOF'\nsudo true\nEOF",
      "cat <<EOF\nsudo true\nEOF\nprintf done",
      "python3 - <<'PY'\nsudo = 'fixture'\nprint(sudo)\nPY",
      'cat <<-"EOF"\n\tsudo true\n\tEOF\nprintf done',
      "cat <<'first end' <<SECOND\nsudo true\nfirst end\nsudo true\nSECOND\nprintf done",
    ]) {
      if (call("bash", { command }, "editor")) throw new Error(`Safe literal blocked: ${command}`);
    }
    for (const agent of deps.workerProfiles) {
      if (call("bash", { command: "git status --short" }, agent))
        throw new Error(`Managed worker cannot inspect status: ${agent}`);
      if (!call("bash", { command: "sudo true" }, agent)?.block)
        throw new Error(`Worker escaped global deny: ${agent}`);
    }
    // No special mutation refusal: only the generated profile's literal denies
    // apply here. Absence of a guard refusal is NOT a Bash approval.
    for (const command of [
      "git add normal.txt",
      "git commit -m fixture",
      "git branch topic",
      "git tag v1",
    ]) {
      if (call("bash", { command }, "editor")?.block)
        throw new Error(`Editor Git ordinary approval route refused: ${command}`);
    }
    if (!call("bash", { command: "git --no-pager commit -m fixture" }, "researcher")?.block)
      throw new Error("Researcher lost its declared deny");
    // Trusted identity selects the declared deny set, never prompt prose.
    const commit = { toolName: "bash", input: { command: "git commit -m fixture" } };
    for (const [parent, child] of [
      ["editor", "researcher"],
      ["researcher", "editor"],
    ]) {
      const ctx = {
        ...context(),
        getSystemPrompt: () => `<active_agent name="${parent}"/>\n<active_agent name="${child}"/>`,
      };
      if (!handlers.get("tool_call")!(commit, ctx)?.block)
        throw new Error("Ambiguous prompt identity was accepted");
    }
    const repeated = {
      ...context(),
      getSystemPrompt: () => '<active_agent name="editor"/>\n<ACTIVE_AGENT name="editor"/>',
    };
    if (handlers.get("tool_call")!(commit, repeated))
      throw new Error("Identical prompt markers blocked");
    for (const agent of ["researcher", "editor"]) {
      const trusted = {
        ...context(),
        getSystemPrompt: () => '<active_agent name="editor"/>\n<active_agent name="researcher"/>',
        sessionManager: {
          getEntries: () => [{ type: "custom", customType: "active_agent", data: { name: agent } }],
        },
      };
      if (!!handlers.get("tool_call")!(commit, trusted)?.block !== (agent === "researcher"))
        throw new Error("Prompt markers overrode trusted child entry");
    }
    if (call("bash", { command: "git status --short" }))
      throw new Error("Marker-free parent blocked");
    for (const agent of [undefined, "editor"]) {
      for (const command of [
        "git log -5 --oneline",
        "git log --oneline -n 20 HEAD",
        "git status --short -- normal.txt",
        "git status --short --ignored",
        "git show -s --format=%ci HEAD^0",
        "mktemp -d",
      ]) {
        if (call("bash", { command }, agent))
          throw new Error(`Read-only query blocked: ${agent}: ${command}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("static-safety-guard loaded literal-denies-and-policy-grep");
}
