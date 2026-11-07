// Offline parent web hiding through the real composition and the pinned
// pi-web-access: autonomous delegation leaves the parent's web declarations
// out of every request and refuses a recalled web call, while Manual, Off and
// a resumed session get pi-web-access's own selection back unchanged. A
// scripted provider answers every request; the global fetch throws.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { initialize } from "../../../scripts/init.mjs";
import { packageRoot } from "../../../bin/runtime-support.mjs";
import { controlledProvider } from "../../../harness/test/support/host.mjs";
import { autonomousWebText } from "../../../harness/dist/delegation.js";
import { PARENT_WEB_OFF_REASON } from "../../../harness/dist/extension.js";

const agentDir = process.env.PI_CODING_AGENT_DIR,
  home = process.env.HOME;
assert(agentDir && home);
const networkAttempts = [];
globalThis.fetch = (input) => {
  networkAttempts.push(String(input));
  throw new Error("Unexpected network request in offline parent-web fixture");
};
initialize({ agentDir });
// --eager: pi-web-access activates its tools at registration and never calls
// setActiveTools afterwards, so nothing rebuilds Pi's prompt options once the
// harness is ready; the first run's hidden set must come from the harness.
const activation = process.argv.includes("--eager")
  ? "eager"
  : process.argv.includes("--dynamic")
    ? "dynamic"
    : "auto";
const excludeSpawn = process.argv.includes("--exclude-spawn");
const restoreIndex = process.argv.indexOf("--restore-web");
const restorePermission = restoreIndex < 0 ? undefined : process.argv[restoreIndex + 1];
if (restoreIndex >= 0) assert(["ask", "allow"].includes(restorePermission));
writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ toolActivation: activation }));
// Only the owned disposable config changes; keep all other seeded policy rules.
const permissionPath = join(agentDir, "extensions/pi-permission-system/config.json");
const permissionConfig = JSON.parse(readFileSync(permissionPath, "utf8"));
if (activation === "dynamic" || restorePermission) {
  // The real loader only activates schemas; it performs no search/fetch. Give
  // that one synthetic call a configured allow, never a human approval.
  if (activation === "dynamic") permissionConfig.permission.web_enable = "allow";
  if (restorePermission) {
    assert.equal(activation, "eager", "exercise authority restoration, not loader activation");
    permissionConfig.permission.web_search = "deny";
  }
  writeFileSync(permissionPath, JSON.stringify(permissionConfig));
}
const permissionApi = restorePermission
  ? await createJiti(join(packageRoot, "composition.ts")).import(
      join(packageRoot, "runtime/permission-system/index.ts"),
    )
  : undefined;
writeFileSync(
  join(agentDir, "harness-presets.json"),
  JSON.stringify({
    version: 3,
    defaultPreset: "fixture",
    presets: {
      fixture: {
        version: "v1",
        slots: Object.fromEntries(
          ["d1", "d2", "d3", "d4", "d5"].map((slot) => [
            slot,
            { model: "harness-fixture/controlled" },
          ]),
        ),
      },
    },
  }),
);
initTheme(undefined, false);
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false,
});
const provider = controlledProvider(ai);
runtime.registerProvider("harness-fixture", provider.config);
const model = runtime.getModel("harness-fixture", "controlled");
const replies = [];
const cwd = join(home, "project"),
  sessions = join(home, "sessions");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessions, { recursive: true });
// pi-web-access's default names; the harness itself reads whatever it registered.
const webNames = [
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "web_enable",
];

async function parent(sessionManager) {
  const ui = { statuses: [], notices: [], dialogs: [] };
  const noop = () => {};
  const uiContext = {
    select: async (title) => {
      ui.dialogs.push(title);
      return undefined;
    },
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    notify: (message, type) => ui.notices.push({ message, type }),
    onTerminalInput: () => noop,
    setStatus: (key, value) => {
      if (key === "harness-preset") ui.statuses.push(value);
    },
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [join(packageRoot, "composition.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  // No tool allowlist: pi-web-access selects its own tools, as in production.
  // This is the pinned SDK option used by CLI --exclude-tools agent_spawn.
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    settingsManager,
    sessionManager,
    ...(excludeSpawn ? { excludeTools: ["agent_spawn"] } : {}),
  });
  await session.bindExtensions({
    mode: "rpc",
    uiContext,
    onError: (error) => ui.notices.push({ message: String(error.error), type: "error" }),
  });
  const close = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  const ask = async (text) => {
    const before = provider.requests.length;
    const canonical = [];
    provider.respond(async () => {
      // Observe the persisted SDK branch at each request, including the
      // recalled call's second request, not the projected provider transcript.
      const messages = session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      canonical.push({
        prompt: ai.getCurrentSystemPrompt(messages),
        tools: ai.getCurrentTools(messages).map((tool) => tool.name),
        activeWeb: session.getActiveToolNames().filter((name) => webNames.includes(name)),
      });
      return replies.shift() ?? { text: "OK" };
    });
    await session.prompt(text, { expandPromptTemplates: false });
    const requests = provider.requests.slice(before);
    assert.equal(
      canonical.length,
      requests.length,
      "every wire request has an independent canonical snapshot",
    );
    return requests.map(({ context }, index) => ({
      tools: context.tools.map((tool) => tool.name),
      prompt: context.systemPrompt,
      canonical: canonical[index],
    }));
  };
  return { session, ui, close, ask };
}
const declaredWeb = (request) => request.tools.filter((name) => webNames.includes(name));
const removedWeb = (session) =>
  session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system"
        ? (entry.message.toolsRemoved ?? [])
        : [],
    )
    .map((tool) => tool.name)
    .filter((name) => webNames.includes(name));
function assertHidden(request, label) {
  assert.equal(
    request.tools.includes("agent_spawn"),
    !excludeSpawn,
    `${label}: respect explicit spawn exclusion`,
  );
  assert.deepEqual(
    declaredWeb(request),
    [],
    `${label}: no parent web declaration reaches the model`,
  );
  assert.doesNotMatch(
    request.prompt,
    /web_search|source_check|fetch_content|get_search_content|web_enable/,
    `${label}: nor any web tool name or rule`,
  );
  // Its guideline belongs to agent_spawn's metadata, not a standing policy.
  if (!excludeSpawn) {
    assert(
      request.prompt.includes(autonomousWebText),
      `${label}: the guideline says where web research goes`,
    );
    assert.doesNotMatch(
      request.canonical.prompt,
      /web_search|source_check|fetch_content|get_search_content|web_enable/,
      `${label}: replayed canonical SDK prompt sections hide web names with active spawn`,
    );
  }
  assert.deepEqual(
    request.canonical.tools.filter((name) => webNames.includes(name)).toSorted(),
    request.canonical.activeWeb.toSorted(),
    `${label}: canonical transcript still declares selected active web tools; hiding is not durable removal`,
  );
}
function assertCanonicalWebVisible(request, label) {
  // These upstream tools contribute prompt snippets; the other tools need not.
  for (const name of ["web_search", "web_enable"].filter((name) =>
    request.canonical.activeWeb.includes(name),
  )) {
    assert(
      request.canonical.prompt.includes(name),
      `${label}: canonical prompt recovers selected ${name}`,
    );
  }
}

let first = await parent(SessionManager.create(cwd, sessions));
let file;
let selected;
try {
  assert.equal(first.ui.statuses.at(-1), "delegation: co-worker/fixture");
  const registered = first.session.getAllTools().map((tool) => tool.name);
  assert(
    ["web_search", "fetch_content"].every((name) => registered.includes(name)),
    JSON.stringify(registered),
  );
  assert.equal(
    registered.includes("web_enable"),
    activation !== "eager",
    "only non-eager activation registers the loader",
  );
  selected = first.session.getActiveToolNames().filter((name) => webNames.includes(name));
  if (activation === "dynamic")
    assert.deepEqual(
      selected,
      ["web_enable"],
      "true dynamic activation initially selects only the loader",
    );
  const service = permissionApi?.getPermissionsService(first.session.sessionId);
  if (restorePermission) {
    assert(service, "real generated permission authority is ready");
    assert.equal(service.isToolFullyDenied("web_search"), true);
  }
  // 1. Co-worker: the tools pi-web-access selected stay active; only their
  // declarations leave the request, from the very first run.
  const [hidden] = await first.ask("HELLO");
  assertHidden(hidden, "co-worker");
  if (restorePermission) {
    assert(
      !first.session.getActiveToolNames().includes("web_search"),
      "the real authority withheld the initially denied tool",
    );
    permissionConfig.permission.web_search = restorePermission;
    writeFileSync(permissionPath, JSON.stringify(permissionConfig));
    assert(
      !first.session.getActiveToolNames().includes("web_search"),
      "writing policy does not reactivate the tool immediately",
    );
    // No resources_discover/reload, service refresh or policy stub: the next
    // real before_agent_start must observe the hot config and restore it.
    const [restored] = await first.ask("RESTORED");
    assert.equal(
      service.isToolFullyDenied("web_search"),
      false,
      `hot deny-to-${restorePermission} reached the actual authority`,
    );
    assert.equal(service.getToolPermission("web_search"), restorePermission);
    assert(
      first.session.getActiveToolNames().includes("web_search"),
      "the authority restored web_search after harness preparation",
    );
    selected = first.session.getActiveToolNames().filter((name) => webNames.includes(name));
    assertHidden(restored, `hot deny-to-${restorePermission}`);
    assertHidden((await first.ask("FOLLOWING"))[0], "following restored turn");
  }
  if (activation === "auto") {
    // The loader is hidden too.
    first.session.setActiveToolsByName([...first.session.getActiveToolNames(), "web_enable"]);
    selected = first.session.getActiveToolNames().filter((name) => webNames.includes(name));
    assertHidden((await first.ask("WITH_LOADER"))[0], "co-worker with the loader");
  }
  assert(
    activation === "dynamic" ? selected.includes("web_enable") : selected.includes("web_search"),
    JSON.stringify(selected),
  );
  assert.deepEqual(
    first.session.getActiveToolNames().filter((name) => webNames.includes(name)),
    selected,
    "hiding changes no active tool",
  );
  // 2. A recalled web call is refused before any permission prompt or network.
  const recalledTool = activation === "dynamic" ? "web_enable" : "web_search";
  const dialogsBefore = first.ui.dialogs.length;
  replies.push(
    {
      tools: [
        {
          type: "toolCall",
          id: "recalled-web",
          name: recalledTool,
          arguments: recalledTool === "web_enable" ? {} : { query: "fixture" },
        },
      ],
    },
    { text: "DONE" },
  );
  const called = await first.ask("RECALL");
  assert.equal(called.length, 2);
  called.forEach((request, index) => assertHidden(request, `recalled call request ${index}`));
  assert.equal(
    first.ui.dialogs.length,
    dialogsBefore,
    "harness refusal precedes any permission prompt",
  );
  const result = first.session.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "recalled-web",
  );
  assert(result?.isError, JSON.stringify(result));
  assert(
    result.content
      .map((part) => part.text ?? "")
      .join("")
      .includes(PARENT_WEB_OFF_REASON),
    JSON.stringify(result.content),
  );
  assert.deepEqual(networkAttempts, []);
  // 3. Manual keeps the parent's web: pi-web-access's own selection returns.
  await first.session.prompt("/harness-mode manual");
  const [manual] = await first.ask("MANUAL");
  assert.deepEqual(
    declaredWeb(manual).toSorted(),
    selected.toSorted(),
    "Manual declares the same web tools again",
  );
  assertCanonicalWebVisible(manual, "Manual");
  assert.doesNotMatch(
    manual.prompt,
    new RegExp(autonomousWebText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  if (activation === "dynamic") {
    // Exercise actual dynamic activation, not just an explicit config spelling:
    // Manual exposes the loader, whose next request gets upstream's web tools.
    replies.push(
      { tools: [{ type: "toolCall", id: "enable-web", name: "web_enable", arguments: {} }] },
      { text: "ENABLED" },
    );
    const enabled = await first.ask("ENABLE_WEB");
    assert.equal(enabled.length, 2);
    const enabledResult = first.session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "enable-web",
    );
    assert(enabledResult && !enabledResult.isError, JSON.stringify(enabledResult));
    selected = first.session.getActiveToolNames().filter((name) => webNames.includes(name));
    assert.deepEqual(
      selected.toSorted(),
      webNames.toSorted(),
      "upstream loader really activated all four web tools",
    );
    assert.deepEqual(
      declaredWeb(enabled[1]).toSorted(),
      selected.toSorted(),
      "loader activation reaches the immediately following request",
    );
    assertCanonicalWebVisible(enabled[1], "Manual after real loader activation");
    assert.deepEqual(networkAttempts, []);
  }
  await first.session.prompt("/harness-mode co-worker");
  assertHidden((await first.ask("BACK"))[0], "back to co-worker");
  // 4. Off: no delegation, so the parent keeps its web.
  await first.session.prompt("/harness-preset off");
  const [off] = await first.ask("OFF");
  assert(!off.tools.includes("agent_spawn"));
  assert.deepEqual(
    declaredWeb(off).toSorted(),
    selected.toSorted(),
    "Off declares the parent's web tools",
  );
  assertCanonicalWebVisible(off, "Off");
  await first.session.prompt("/harness-preset fixture");
  assertHidden((await first.ask("ON_AGAIN"))[0], "preset re-enabled");
  // 5. The transcript never recorded a web removal, so nothing persists it.
  assert.deepEqual(removedWeb(first.session), []);
  await first.session.prompt("/harness-mode lead");
  file = first.session.sessionManager.getSessionFile();
  assert(file);
} finally {
  await first.close();
}

// 6. Resume restores the saved autonomous mode, hidden, and Manual brings back
// the recorded selection: no stale removal sticks to the session.
const second = await parent(SessionManager.open(file));
try {
  assert.equal(second.ui.statuses.at(-1), "delegation: lead/fixture");
  assertHidden((await second.ask("RESUMED"))[0], "resumed lead");
  await second.session.prompt("/harness-mode manual");
  const [resumedManual] = await second.ask("RESUMED_MANUAL");
  assert.deepEqual(declaredWeb(resumedManual).toSorted(), selected.toSorted());
  assertCanonicalWebVisible(resumedManual, "resumed Manual");
  assert.deepEqual(removedWeb(second.session), []);
  assert(
    !second.ui.notices.some(({ type }) => type === "error"),
    JSON.stringify(second.ui.notices),
  );
} finally {
  await second.close();
}
assert(!first.ui.notices.some(({ type }) => type === "error"), JSON.stringify(first.ui.notices));
assert.deepEqual(networkAttempts, []);
console.log(`PASS (${activation} web activation${excludeSpawn ? "; spawn excluded" : ""})`);
if (restorePermission)
  console.log(
    `PASS: hot deny-to-${restorePermission} restores web_search through the real authority without leaking its schema or prompt name`,
  );
console.log(
  "PASS: autonomous delegation hides the parent's web declarations and refuses a recalled call; Manual, Off and a resumed session keep pi-web-access's selection; nothing leaves the process",
);
