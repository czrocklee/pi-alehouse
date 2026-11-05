// Actual built permission presentation entrypoints, with synthetic frozen
// inputs. No authority decisions, model calls, network, or live config.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  "#src": join(packageRoot, "runtime/permission-system/vendor/src"),
} });
const [{ buildForwardedScopeLabels }, { renderPromptDialog, completeViewBudget }, { SessionApproval }, { publicProfileLabel },
  { renderPolicyDenial, renderRefusal, renderUnavailableDenial },
  { SkillInputGatePipeline, formatSkillDenyNotice }] = await Promise.all([
  jiti.import("#src/presentation/pattern-suggest"),
  jiti.import("#src/presentation/dialog-renderer"),
  jiti.import("#src/session/session-approval"),
  jiti.import("#src/presentation/managed-profile-label"),
  jiti.import("#src/presentation/agent-renderer"),
  jiti.import("#src/handlers/gates/skill-input-gate-pipeline"),
]);

function freeze(value) {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function payload(agentName, forwarded = true) {
  return freeze({ kind: "bash", request: {
    requester: { agentName, forwarded, sessionId: forwarded ? "editor" : null },
    surface: "bash", toolName: "bash", invokedToolName: "editor",
    value: "echo editor", matchedPattern: "editor *", commandContext: null, executedUnit: "editor --check",
  }, evidence: [{ label: "nickname", text: "editor", detail: null },
    { label: "user content", text: "keep editor in /tmp/editor.txt", detail: "editor" },
    { label: "note", text: "literal researcher and editor", detail: null }], annotations: [] });
}
const render = (input) => renderPromptDialog(input, completeViewBudget(200));
const requesterLine = (view, forwarded) => view.lines.find((line) => line.startsWith(forwarded ? "subagent" : "agent"));

test("permission display: exact internal editor and researcher labels only, without legacy aliases or nickname rewriting", () => {
  assert.equal(publicProfileLabel("editor"), "worker");
  assert.equal(publicProfileLabel("researcher"), "scout");
  for (const name of ["worker", "scout", "reader", "unknown-profile", "editor-nickname", "researcher-nickname", "my editor", "my researcher", "Editor", "Researcher", "editor ", "researcher ", "",
    "constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    const label = publicProfileLabel(name);
    assert.equal(label, name);
    assert.equal(typeof label, "string");
  }
});

test("permission display: forwarded scope labels leave session approval surfaces and patterns intact", () => {
  const approval = SessionApproval.forGrants(freeze([
    { surface: "path_write", pattern: "/tmp/editor/*" },
    { surface: "path_read", pattern: "/tmp/editor.txt" },
  ]));
  const before = structuredClone(approval.toForwardedData());
  freeze(approval);
  const expectedSession = "The whole session — allow path 2 paths for parent and all subagents";
  for (const [name, shown] of [["editor", "worker"], ["researcher", "scout"], ["scout", "scout"], ["unknown-profile", "unknown-profile"],
    ["editor-nickname", "editor-nickname"], ["researcher-nickname", "researcher-nickname"], ["reader", "reader"],
    ["constructor", "constructor"], ["toString", "toString"], ["__proto__", "__proto__"]]) {
    assert.deepEqual(buildForwardedScopeLabels(name, approval.grants), {
      subagentLabel: `This subagent ('${shown}') only`, servingSessionLabel: expectedSession,
    });
  }
  for (const name of [null, ""]) assert.equal(buildForwardedScopeLabels(name, approval.grants).subagentLabel, "This subagent only");
  assert.deepEqual(approval.toForwardedData(), before, "label rendering never changes the session grants");
  const single = freeze([{ surface: "bash", pattern: "editor *" }]);
  assert.equal(buildForwardedScopeLabels("editor", single).servingSessionLabel,
    'The whole session — allow bash "editor *" for parent and all subagents');
});

test("permission display: actual local and forwarded dialogs label worker but retain internal editor facts", () => {
  for (const forwarded of [false, true]) {
    const input = payload("editor", forwarded), before = structuredClone(input);
    const view = render(input), line = requesterLine(view, forwarded);
    assert.equal(view.elided, false);
    assert.match(line, forwarded ? /^subagent\s*:\s*worker · session editor$/ : /^agent\s*:\s*worker$/);
    assert.doesNotMatch(line, /:\s*editor\b/);
    const text = view.lines.join("\n");
    assert.match(text, /tool\s*:\s*bash \(invoked as editor\)/);
    assert.match(text, /rule\s*:\s*editor \*/);
    assert.match(text, /command\s*:\s*echo editor/);
    assert.match(text, /runs\s*:\s*editor --check/);
    assert.match(text, /nickname\s*:\s*editor/);
    assert.match(text, /user content\s*:\s*keep editor in \/tmp\/editor.txt → editor/);
    assert.match(text, /note\s*:\s*literal researcher and editor/);
    assert.deepEqual(input, before, "rendering does not mutate the request or user content");
    assert.equal(input.request.requester.agentName, "editor", "permission identity stays internal");
  }
});

test("permission display: actual local and forwarded dialogs label scout but retain internal researcher identity and literal facts", () => {
  for (const forwarded of [false, true]) {
    const input = payload("researcher", forwarded), before = structuredClone(input);
    const view = render(input), line = requesterLine(view, forwarded);
    assert.equal(view.elided, false);
    assert.match(line, forwarded ? /^subagent\s*:\s*scout · session editor$/ : /^agent\s*:\s*scout$/);
    assert.doesNotMatch(line, /researcher/);
    const text = view.lines.join("\n");
    assert.match(text, /tool\s*:\s*bash \(invoked as editor\)/);
    assert.match(text, /rule\s*:\s*editor \*/);
    assert.match(text, /command\s*:\s*echo editor/);
    assert.match(text, /runs\s*:\s*editor --check/);
    assert.match(text, /nickname\s*:\s*editor/);
    assert.match(text, /user content\s*:\s*keep editor in \/tmp\/editor.txt → editor/);
    assert.match(text, /note\s*:\s*literal researcher and editor/);
    assert.doesNotMatch(text, /scout \*/);
    assert.deepEqual(input, before, "rendering does not mutate the request or user content");
    assert.equal(input.request.requester.agentName, "researcher", "permission identity stays internal");
  }
});

test("permission display: denial and refusal renders label the requester while every other fact stays literal", () => {
  // The same payload the real gate pipeline emits, run through the actual
  // built render entrypoints: policy deny, human refusal and no-authority
  // denial. Only the requester label is remapped; the invoked-tool name,
  // matched rule and evidence text keep the internal spelling.
  for (const forwarded of [false, true]) {
    for (const [name, shown] of [["editor", "worker"], ["researcher", "scout"], ["unknown-profile", "unknown-profile"]]) {
      const input = payload(name, forwarded), before = structuredClone(input);
      const renders = {
        policy: renderPolicyDenial(input, null),
        user: renderRefusal(input, { kind: "user", via: "dialog" }, null),
        unavailable: renderUnavailableDenial(input, null),
      };
      const identity = `(invoked as 'editor') for agent '${shown}' (rule 'editor *')`;
      const core = `'bash' call ${identity}`;
      assert.equal(renders.policy, `[pi-permission-system] Denied by policy: 'bash' ${identity}.`);
      assert.equal(renders.user, `[pi-permission-system] The user denied this ${core}.`);
      assert.equal(renders.unavailable, `[pi-permission-system] This ${core} requires approval, but no interactive UI is available.`);
      if (name === "editor" || name === "researcher") {
        for (const text of Object.values(renders)) assert.doesNotMatch(text, new RegExp(`for agent '${name}'`));
      }
      for (const text of Object.values(renders)) {
        assert.match(text, /\(invoked as 'editor'\)/, "only the requester label is remapped");
        assert.match(text, /rule 'editor \*'/, "the matched rule stays literal");
        assert.doesNotMatch(text, /worker \*/, "no generic label replacement beyond the agent clause");
        assert.doesNotMatch(text, /scout \*/, "no generic label replacement beyond the agent clause");
      }
      assert.deepEqual(input, before, "rendering does not mutate the request or evidence");
      assert.equal(input.request.requester.agentName, name, "permission identity stays internal");
    }
  }
});

test("permission display: skill input deny notice labels the requester through the actual gate pipeline", async () => {
  // A denied skill resolution (frozen check result), run through the real
  // SkillInputGatePipeline: the underlying check still receives the internal
  // agentName and the runner sees the same identity; only the human-facing
  // notice text carries the public label.
  const checks = [], runs = [], notices = [];
  const pipeline = new SkillInputGatePipeline({
    checkPermission: (surface, input, agentName) => {
      checks.push({ surface, input, agentName });
      return freeze({ toolName: "skill", state: "deny", reason: "off",
        matchedPattern: "editor skill", source: "skill", origin: "config" });
    },
  });
  for (const [name, shown] of [["editor", "worker"], ["researcher", "scout"], ["unknown-profile", "unknown-profile"]]) {
    checks.length = runs.length = notices.length = 0;
    const outcome = await pipeline.evaluate("deploy-notes", name, { warn: (m) => notices.push(m) },
      { run: async (gate, agentName) => { runs.push({ gate, agentName }); return freeze({ action: "block", reason: "deny" }); } });
    assert.deepEqual(outcome, { action: "block", reason: "deny" });
    assert.deepEqual(checks, [{ surface: "skill", input: { name: "deploy-notes" }, agentName: name }],
      "the permission check keeps the internal requester identity");
    assert.deepEqual(notices, [`Skill 'deploy-notes' is not permitted for agent '${shown}'.`],
      "only the notice label is remapped");
    if (name === "editor" || name === "researcher") assert.doesNotMatch(notices[0], new RegExp(`for agent '${name}'`));
    assert.match(notices[0], /Skill 'deploy-notes' is not permitted for agent/);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].agentName, name, "the gate still evaluates as the internal requester");
    assert.equal(runs[0].gate.surface, "skill");
    assert.deepEqual(runs[0].gate.input, { name: "deploy-notes" });
    assert.equal(runs[0].gate.payload.request.requester.agentName, name, "payload identity stays internal");
  }
  assert.equal(formatSkillDenyNotice("deploy-notes", null),
    "Skill 'deploy-notes' is not permitted by the current skill policy.");
});

test("permission display: researcher is labeled scout; unknown profiles and unnamed requesters keep upstream identity", () => {
  for (const forwarded of [false, true]) {
    for (const name of ["researcher", "unknown-profile", "editor-nickname", "researcher-nickname", "reader", "scout", "constructor", "toString", "__proto__", null, ""]) {
      const input = payload(name, forwarded), before = structuredClone(input);
      const shown = name === "researcher" ? "scout" : name;
      const line = requesterLine(render(input), forwarded);
      if (forwarded) assert.equal(line?.split(/\s+: /)[1], `${shown || "unknown"} · session editor`);
      else if (shown) assert.equal(line?.split(/\s+: /)[1], shown);
      else assert.equal(line, undefined);
      if (name === "researcher") assert.doesNotMatch(line ?? "", /researcher/);
      assert.deepEqual(input, before);
      assert.equal(input.request.requester.agentName, name, "permission identity stays internal");
    }
  }
});
