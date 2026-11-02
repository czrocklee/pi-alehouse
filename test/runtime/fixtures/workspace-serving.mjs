// Offline subprocess fixture: serves one synthetic forwarded child ask through
// the ACTUAL generated vendor composition root
// (runtime/permission-system/vendor/src/index.ts), never a hand-copied callback.
//
// What stays real, with zero substitution of the code under test:
//   - jiti imports the actual generated index.ts (fsCache disabled) and runs
//     its default export against a minimal recording ExtensionAPI;
//   - an instrumented ForwardedRequestServer subclass (written into this
//     fixture's own temp directory at runtime) only records the constructor
//     deps — including the ACTUAL ServingPolicy closure the composition root
//     built — and the instance, then delegates everything to the real vendor
//     class;
//   - the SDK shim redirects only getAgentDir/getPackageDir to this fixture;
//   - the real session_start lifecycle hook initializes the parent session
//     (real PermissionManager/ConfigStore over the production permission seed
//     in the fixture agentDir and the real source project config at the
//     trusted parent cwd);
//   - the child binding uses the real managed-workspace-policy binder with
//     explicit roots (checkout_root=cwd, source_root=source_cwd: this
//     synthetic worktree is its own checkout root) and the real subagent
//     registry;
//   - the intent's workspacePolicyValues are computed by the real alias
//     helper, never hand-written (the forged scenario deliberately deviates);
//   - the wire is the real request file -> captured server processInbox ->
//     real response file read back with the real forwarding IO.
//
// The parent is headless, so the real escalation seam answers asks with the
// real DenyingAuthorizer ("unavailable"): an ask is observed as an ask through
// the captured callback and as an escalated denial on the wire, never as a
// human approval. No network, model, human, Git, Nix, or live configuration;
// every path lives under the OS tmpdir and is removed at exit.
//
// Usage: node workspace-serving.mjs --scenario <name>. Prints one JSON record
// to stdout; assertions live in ../workspace-serving.test.mjs so controlled
// index mutations flip them through behavior, not through source matching.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../../../bin/runtime-support.mjs";

const scenarios = ["ask", "deny", "wrongParent", "released", "forged", "omitted", "unbound", "unboundClaimed"];
const argv = process.argv.slice(2);
const scenario = argv[argv.indexOf("--scenario") + 1];
if (argv[0] !== "--scenario" || !scenarios.includes(scenario)) {
  console.error(`usage: node workspace-serving.mjs --scenario <${scenarios.join("|")}>`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const vendorSrc = join(packageRoot, "runtime/permission-system/vendor/src");
const indexPath = join(vendorSrc, "index.ts");
if (!existsSync(indexPath)) {
  console.error(`missing generated vendor index: ${indexPath}`);
  process.exit(2);
}

// ── Self-owned fixture tree under the OS tmpdir ─────────────────────────────
const base = mkdtempSync(join(tmpdir(), "alehouse-workspace-serving-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));
const agentDir = join(base, "agent");
const source = join(base, "source"); // trusted source project root (parent cwd)
const worktree = join(base, "worktree"); // child execution cwd: its own checkout
const packageDir = join(base, "pkg");
for (const directory of [agentDir, source, worktree, packageDir]) mkdirSync(directory, { recursive: true });

// Global policy: the REAL production seed, byte-for-byte from resources/.
mkdirSync(join(agentDir, "extensions/pi-permission-system"), { recursive: true });
copyFileSync(join(packageRoot, "resources/permissions.json"),
  join(agentDir, "extensions/pi-permission-system/config.json"));
// Source project policy: EXACT absolute source-only rules. A "*.review"-style
// suffix wildcard would also match the worktree path itself and could not
// distinguish alias wiring from no wiring; only the workspace alias reaches
// these exact paths.
const projectConfig = join(source, ".pi/extensions/pi-permission-system/config.json");
mkdirSync(dirname(projectConfig), { recursive: true });
writeFileSync(projectConfig, JSON.stringify({ permission: { path_read: {
  [join(source, "notes.review")]: "ask",
  [join(source, "notes.secret")]: "deny",
} } }));

// ── Runtime-written shims in this fixture's own temp directory ───────────────
// The SDK shim re-exports the real SDK and redirects only the two path
// accessors; the server shim subclasses the real vendor class and only
// records the deps/instance the composition root passed. Neither replaces
// any permission behavior.
process.env.ALEHOUSE_WORKSPACE_SERVING_AGENT_DIR = agentDir;
process.env.ALEHOUSE_WORKSPACE_SERVING_PACKAGE_DIR = packageDir;
const shims = join(base, "shims");
mkdirSync(shims);
const sdkShim = join(shims, "sdk.mjs");
writeFileSync(sdkShim, `import * as real from ${JSON.stringify(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
const { getSettingsListTheme } = real;
export { getSettingsListTheme };
export const getAgentDir = () => process.env.ALEHOUSE_WORKSPACE_SERVING_AGENT_DIR;
export const getPackageDir = () => process.env.ALEHOUSE_WORKSPACE_SERVING_PACKAGE_DIR;
`);
const frsShim = join(shims, "frs.mjs");
writeFileSync(frsShim, `import { ForwardedRequestServer as RealForwardedRequestServer } from ${JSON.stringify(join(vendorSrc, "authority/forwarded-request-server.ts"))};
export class ForwardedRequestServer extends RealForwardedRequestServer {
  constructor(deps) {
    globalThis.__ALEHOUSE_WORKSPACE_SERVING_DEPS__ = deps;
    super(deps);
    globalThis.__ALEHOUSE_WORKSPACE_SERVING_SERVER__ = this;
  }
}
`);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": sdkShim,
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    // The generated vendor now uses explicit .ts specifiers. Intercept that
    // exact edge as well as the upstream spelling; the shim's absolute import
    // still delegates to the real class and does not alias back to itself.
    "#src/authority/forwarded-request-server.ts": frsShim,
    "#src/authority/forwarded-request-server": frsShim,
  },
  fsCache: false,
});
const load = (name) => jiti.import(join(vendorSrc, `${name}.ts`));

// Synthetic managed resource protection (process-global) — must exist before
// the real composition root requires it.
(await load("policy/managed-resource-protection"))
  .initializeManagedResourceProtection({ writeRoots: [], readFiles: [] });

// ── Minimal recording ExtensionAPI ──────────────────────────────────────────
const piHandlers = new Map();
const busHandlers = new Map();
const emitted = [];
const commands = [];
const bus = {
  emit(channel) { emitted.push(channel); },
  on(channel, handler) {
    if (!busHandlers.has(channel)) busHandlers.set(channel, []);
    busHandlers.get(channel).push(handler);
    return () => {};
  },
};
const pi = {
  events: bus,
  on(event, handler) {
    if (!piHandlers.has(event)) piHandlers.set(event, []);
    piHandlers.get(event).push(handler);
  },
  registerCommand(name) { commands.push(name); },
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools() {},
};

// ── Run the ACTUAL composition root under test ───────────────────────────────
const extension = await jiti.import(indexPath);
extension.default(pi);
const deps = globalThis.__ALEHOUSE_WORKSPACE_SERVING_DEPS__;
const server = globalThis.__ALEHOUSE_WORKSPACE_SERVING_SERVER__;
if (!deps || !server || typeof deps.policy?.resolve !== "function" || typeof deps.escalator?.escalate !== "function") {
  console.error("instrumented ForwardedRequestServer was not constructed with a serving policy by the composition root");
  process.exit(3);
}

// ── Parent session through the real lifecycle hook ───────────────────────────
const parent = randomUUID();
const entries = [{ type: "custom", customType: "active_agent", data: { name: "editor" } }];
const parentCtx = {
  cwd: source,
  hasUI: false, // Headless: the real escalation seam answers asks with the real DenyingAuthorizer.
  isProjectTrusted: () => true,
  ui: { notify() {} },
  sessionManager: {
    getSessionId: () => parent,
    getSessionDir: () => join(base, "parent-session"),
    getEntries: () => entries,
    getBranch: () => entries,
  },
};
const sessionStart = piHandlers.get("session_start");
if (!sessionStart?.length) {
  console.error("session_start handler was not registered by the composition root");
  process.exit(3);
}
await sessionStart[0]({ reason: "start" }, parentCtx);

// ── Child binding (explicit roots, not guessed) + registry parentage ─────────
const mwp = await load("policy/managed-workspace-policy");
const child = randomUUID();
const bound = scenario === "unbound" || scenario === "unboundClaimed" ? null : mwp.bindWorkspacePolicy({
  sessionId: child,
  cwd: worktree,
  source_cwd: source,
  checkout_root: worktree, // This synthetic worktree is its own checkout root.
  source_root: source,
  projectTrusted: true,
});
const registry = (await load("authority/subagent-registry")).getSubagentSessionRegistry();
registry.register(child, { parentSessionId: scenario === "wrongParent" ? randomUUID() : parent });

// Child-fixed forwarded intent, as the child's gate would serialize it. The
// alias list is computed by the REAL helper, never hand-written.
const file = scenario === "deny" ? "notes.secret" : "notes.review";
const matchValues = [join(worktree, file)];
const childCtx = { cwd: worktree, sessionManager: { getSessionId: () => child } };
const binding = bound ? mwp.workspacePolicyForContext(childCtx) : null;
const honest = binding ? mwp.workspacePolicyAliases(binding, matchValues) : [];
const intent = {
  surface: "path_read",
  matchValues,
  boundaryValue: join(worktree, file),
  requesterCwd: worktree,
  principal: { sessionId: child, agentName: "editor" },
};
switch (scenario) {
  case "released":
    intent.workspacePolicyValues = honest;
    bound.release();
    break;
  case "forged":
    // Same-length, non-empty, content-different: a length-only comparison
    // passes while the .every(content) check must still fail.
    intent.workspacePolicyValues = honest.map((value) => value.replace("notes.review", "notes.rview"));
    break;
  case "omitted": // Bound child, wire omits the restriction values entirely.
  case "unbound": // Ordinary public workspace request: no binding, no values.
    break;
  case "unboundClaimed": // No binding, but the wire claims restriction values.
    intent.workspacePolicyValues = [join(source, "notes.review")];
    break;
  default:
    intent.workspacePolicyValues = honest;
}

// ── (1) The ACTUAL captured serving closure, invoked directly ────────────────
let direct;
try {
  const result = deps.policy.resolve(intent);
  direct = { threw: false, state: result.state, matchedPattern: result.matchedPattern ?? null, origin: result.origin ?? null };
} catch (error) {
  direct = { threw: true, error: String(error?.message ?? error) };
}

// ── (2) Full wire: real inbox request -> real server drain -> response ───────
const pf = await load("authority/permission-forwarding");
const location = pf.createPermissionForwardingLocation(deps.forwardingDir, parent);
mkdirSync(location.requestsDir, { recursive: true });
const id = randomUUID();
const requestPath = join(location.requestsDir, `${id}.json`);
writeFileSync(requestPath, JSON.stringify({
  id, createdAt: Date.now(), requesterSessionId: child, targetSessionId: parent,
  requesterAgentName: "editor", accessIntent: intent,
}));
const serveCtx = {
  cwd: source, hasUI: false, ui: { notify() {} },
  sessionManager: {
    getSessionId: () => parent, getSessionDir: () => location.sessionRootDir,
    getEntries: () => [], getBranch: () => [],
  },
};
await server.processInbox(serveCtx);
const responsePath = join(location.responsesDir, `${id}.json`);
const wire = { responseFile: existsSync(responsePath), requestDrained: !existsSync(requestPath) };
if (wire.responseFile) {
  wire.response = (await load("authority/forwarding-io")).readForwardedPermissionResponse(null, responsePath);
}

console.log(JSON.stringify({
  scenario,
  index: indexPath,
  policyCaptured: typeof deps.policy?.resolve === "function",
  escalatorWired: typeof deps.escalator?.escalate === "function",
  bound: binding !== null,
  parent, child, file,
  matchValues,
  recomputedAliases: honest,
  wireValues: intent.workspacePolicyValues ?? null,
  direct,
  wire,
  events: emitted,
  commands,
}, null, 2));
