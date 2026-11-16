// Shared fixture for the policy-grep extension tests. Importing this module
// has no tool-registry side effects: tests register the tool explicitly via
// registerPolicyGrepTool() and own their temp directories and cleanup.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const projectRoot = resolve(import.meta.dirname, "../..");
// Unbuilt src carries an empty WORKER_POLICY placeholder; the stub only
// supplies the build-time agent identity, never policy logic.
const stubDir = mkdtempSync(join(tmpdir(), "policy-grep-stub-"));
const guardStub = join(stubDir, "guard-stub.mjs");
writeFileSync(
  guardStub,
  `export { policyGrepRegistry } from ${JSON.stringify(
    join(projectRoot, "src/extensions/static-safety-guard.ts"),
  )};\nexport const activeAgent = () => "editor";\n`,
);
const jiti = createJiti(import.meta.url, {
  interopDefault: false,
  alias: { "./static-safety-guard.ts": guardStub },
});
const { default: policyGrep } = await jiti.import(
  join(projectRoot, "src/extensions/policy-grep.ts"),
);

const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");

export function registerPolicyGrepTool() {
  let tool;
  policyGrep({
    registerTool(definition) {
      tool = definition;
    },
    getAllTools: () => [],
    on() {},
  });
  return tool;
}

export function allowSession(sessionId = "policy-grep-test") {
  let services = globalThis[servicesKey];
  if (!(services instanceof Map)) services = globalThis[servicesKey] = new Map();
  services.set(sessionId, {
    getToolCallAgentName: () => "editor",
    checkPermission: () => ({ state: "allow" }),
  });
}

export async function search(tool, directory, params, sessionId = "policy-grep-test") {
  const result = await tool.execute("fixture", params, undefined, undefined, {
    cwd: directory,
    sessionManager: { getSessionId: () => sessionId },
  });
  return { text: result.content[0].text, details: result.details };
}

export function disposePolicyGrepFixture(sessionId = "policy-grep-test") {
  globalThis[servicesKey]?.delete(sessionId);
  rmSync(stubDir, { recursive: true, force: true });
}
