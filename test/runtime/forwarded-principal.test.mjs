// Offline forwarded-permission identity regression. Only synthetic config and
// request/response fixtures are written; no tools, models or network execute.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../bin/runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const vendorSrc = join(packageRoot, "runtime/permission-system/vendor/src");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(
      packageRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    ),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    "#src": vendorSrc,
  },
});
const load = (name) => jiti.import(join(vendorSrc, `${name}.ts`));
const [
  { PermissionManager },
  { PermissionResolver },
  { ForwardedRequestServer },
  { createPermissionForwardingLocation },
  { readForwardedPermissionResponse },
  { getSubagentSessionRegistry },
] = await Promise.all([
  load("policy/permission-manager"),
  load("policy/permission-resolver"),
  load("authority/forwarded-request-server"),
  load("authority/permission-forwarding"),
  load("authority/forwarding-io"),
  load("authority/subagent-registry"),
]);

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "alehouse-forwarded-principal-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace"),
    agentDir = join(base, "agent");
  const agentsDir = join(agentDir, "agents");
  mkdirSync(cwd);
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ["editor", "researcher"])
    cpSync(join(packageRoot, "runtime/agents", `${name}.md`), join(agentsDir, `${name}.md`));
  const config = JSON.parse(readFileSync(join(packageRoot, "resources/permissions.json"), "utf8"));
  // Ordinary writes retain shipped policy; reads deliberately ask so the
  // controlled escalation counter has a positive control, not a dead stub.
  config.permission.path_read = { "*": "ask" };
  const globalConfigPath = join(agentDir, "extensions/pi-permission-system/config.json");
  mkdirSync(join(agentDir, "extensions/pi-permission-system"), { recursive: true });
  writeFileSync(globalConfigPath, JSON.stringify(config));
  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    mcpServerNames: [],
    globalMcpConfigPath: join(agentDir, "mcp.json"),
  });
  for (const name of ["editor", "researcher"])
    assert.deepEqual(manager.getConfigIssues(name), [], `${name} fixture config must be valid`);
  const resolver = new PermissionResolver(manager, { getRuleset: () => [] });
  const parent = randomUUID(),
    children = { editor: randomUUID(), researcher: randomUUID() };
  const registry = getSubagentSessionRegistry();
  // Registry records parentage, not profile authority: the copied definitions
  // and actual manager/resolver supply the internal editor/researcher policy.
  for (const child of Object.values(children)) {
    registry.register(child, { parentSessionId: parent });
    t.after(() => registry.unregister(child));
  }
  const calls = { policy: 0, escalator: 0 };
  const forwardingDir = join(base, "forwarding");
  const server = new ForwardedRequestServer({
    forwardingDir,
    registry,
    logger: { review() {}, debug() {} },
    policy: {
      resolve(intent) {
        calls.policy++;
        return resolver.resolve({
          kind: "path-values",
          surface: intent.surface,
          values: intent.matchValues,
          agentName: intent.principal.agentName,
        });
      },
    },
    escalator: {
      async escalate() {
        calls.escalator++;
        return { approved: true, state: "approved", decidedBy: { kind: "user", via: "dialog" } };
      },
    },
    broadcaster: { emitDecision() {} },
    recorder: { recordSessionApproval() {} },
  });
  const location = createPermissionForwardingLocation(forwardingDir, parent);
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => parent,
      getSessionDir: () => location.sessionRootDir,
      getEntries: () => [],
    },
  };
  return { cwd, parent, children, calls, server, location, ctx };
}

const cases = [
  {
    name: "matched editor write allows",
    agent: "editor",
    surface: "path_write",
    approved: true,
    escalator: 0,
  },
  {
    name: "matched researcher write denies",
    agent: "researcher",
    surface: "path_write",
    approved: false,
    escalator: 0,
  },
  {
    name: "matched editor read escalates",
    agent: "editor",
    surface: "path_read",
    approved: true,
    escalator: 1,
  },
  {
    name: "matched researcher read escalates",
    agent: "researcher",
    surface: "path_read",
    approved: true,
    escalator: 1,
  },
  ...["path_write", "path_read"].flatMap((surface) => [
    {
      name: `sessionId mismatch rejects before policy: ${surface}`,
      agent: "editor",
      surface,
      mismatch: "sessionId",
      approved: false,
      escalator: 0,
    },
    {
      name: `researcher envelope/editor principal rejects before policy: ${surface}`,
      agent: "editor",
      surface,
      mismatch: "agentName",
      approved: false,
      escalator: 0,
    },
  ]),
];

for (const c of cases)
  test(`forwarded principal: ${c.name}`, async (t) => {
    const f = fixture(t),
      id = randomUUID(),
      target = join(f.cwd, "ordinary.txt");
    const principal = { sessionId: f.children[c.agent], agentName: c.agent };
    const request = {
      id,
      createdAt: Date.now(),
      targetSessionId: f.parent,
      requesterSessionId: c.mismatch === "sessionId" ? f.children.researcher : principal.sessionId,
      requesterAgentName: c.mismatch === "agentName" ? "researcher" : principal.agentName,
      surface: c.surface,
      value: target,
      accessIntent: {
        surface: c.surface,
        matchValues: [target],
        boundaryValue: target,
        requesterCwd: f.cwd,
        principal,
      },
    };
    // Each malformed envelope changes exactly one identity field; all other
    // request facts remain valid and must reach the server's explicit denial.
    assert.equal(request.requesterSessionId === principal.sessionId, c.mismatch !== "sessionId");
    assert.equal(request.requesterAgentName === principal.agentName, c.mismatch !== "agentName");
    mkdirSync(f.location.requestsDir, { recursive: true });
    const requestPath = join(f.location.requestsDir, `${id}.json`);
    writeFileSync(requestPath, JSON.stringify(request));
    await f.server.processInbox(f.ctx);
    const responsePath = join(f.location.responsesDir, `${id}.json`);
    assert.ok(
      existsSync(responsePath),
      "server must write a response, not silently discard the request",
    );
    const response = readForwardedPermissionResponse(null, responsePath);
    assert.ok(response, "response JSON must survive the real wire reader");
    assert.equal(existsSync(requestPath), false, "responded request is drained");
    assert.equal(
      f.calls.policy,
      c.mismatch ? 0 : 1,
      "mismatch must stop before actual recorded policy",
    );
    assert.equal(f.calls.escalator, c.escalator, "mismatch must never reach escalation");
    assert.equal(response.responderSessionId, f.parent);
    assert.equal(response.approved, c.approved);
    if (c.mismatch) {
      assert.equal(response.state, "denied_with_reason");
      assert.equal(response.decidedBy?.kind, "gate_error");
      assert.match(response.decidedBy.reason, /principal does not match its requester/);
    } else {
      assert.equal(response.decidedBy?.kind, c.escalator ? "user" : "rule");
    }
    assert.equal(existsSync(target), false, "permission facts never execute a file write");
  });
