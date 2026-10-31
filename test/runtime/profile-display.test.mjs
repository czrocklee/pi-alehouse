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
const [{ buildForwardedScopeLabels }, { renderPromptDialog, completeViewBudget }, { SessionApproval }, { publicProfileLabel }] = await Promise.all([
  jiti.import("#src/presentation/pattern-suggest"),
  jiti.import("#src/presentation/dialog-renderer"),
  jiti.import("#src/session/session-approval"),
  jiti.import("#src/presentation/managed-profile-label"),
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
    { label: "user content", text: "keep editor in /tmp/editor.txt", detail: "editor" }], annotations: [] });
}
const render = (input) => renderPromptDialog(input, completeViewBudget(200));
const requesterLine = (view, forwarded) => view.lines.find((line) => line.startsWith(forwarded ? "subagent" : "agent"));

test("permission display: exact editor label only, without legacy aliases or nickname rewriting", () => {
  assert.equal(publicProfileLabel("editor"), "worker");
  for (const name of ["worker", "researcher", "reader", "unknown-profile", "editor-nickname", "my editor", "Editor", "editor ", ""]) {
    assert.equal(publicProfileLabel(name), name);
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
  for (const [name, shown] of [["editor", "worker"], ["researcher", "researcher"], ["unknown-profile", "unknown-profile"],
    ["editor-nickname", "editor-nickname"], ["reader", "reader"]]) {
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
    assert.deepEqual(input, before, "rendering does not mutate the request or user content");
    assert.equal(input.request.requester.agentName, "editor", "permission identity stays internal");
  }
});

test("permission display: researcher, unknown profiles and unnamed requesters keep upstream identity", () => {
  for (const forwarded of [false, true]) {
    for (const name of ["researcher", "unknown-profile", "editor-nickname", "reader", null, ""]) {
      const input = payload(name, forwarded), before = structuredClone(input);
      const line = requesterLine(render(input), forwarded);
      if (forwarded) assert.equal(line?.split(/\s+: /)[1], `${name || "unknown"} · session editor`);
      else if (name) assert.equal(line?.split(/\s+: /)[1], name);
      else assert.equal(line, undefined);
      assert.deepEqual(input, before);
    }
  }
});
