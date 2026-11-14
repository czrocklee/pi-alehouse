// Imported only after the subprocess fixture establishes owned state and blocks network.
// Real src/composition.ts -> orchestration startup -> production child factory -> SDK.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import * as ai from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { packageRoot } from "../../bin/runtime-support.mjs";
import { initialize } from "../../scripts/init.mjs";
import { controlledProvider } from "./host.mjs";

export function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
export const json = (path, value) => put(path, JSON.stringify(value, null, 2) + "\n");
export const text = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

export function assertCatalogue(observations, expected) {
  assert(observations.length > 0, "a real child reached the controlled provider");
  for (const { prompt, tools } of observations) {
    const sections = [...prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)];
    const names = sections.flatMap(([, body]) =>
      [...body.matchAll(/<name>([^<]+)<\/name>/g)].map(([, name]) => name),
    );
    assert.deepEqual(names.sort(), [...expected].sort(), "provider-visible skill catalogue");
    if (!expected.length) assert.equal(sections.length, 0, "no empty advertised catalogue");
    assert(!prompt.includes("PRIVATE_SKILL_BODY_"), "only metadata, never skill bodies");
    assert(!tools.includes("skill"), "discovery does not add an executable skill tool");
    assert(!tools.includes("agent_spawn"), "no arbitrary nested delegation");
  }
}

export async function withParent(parent, body) {
  const failures = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  }
  try {
    await parent.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "child-skills scenario or cleanup failed", {
      cause: failures[0],
    });
}

export async function childSkillsFixture(home, agentDir) {
  const cwd = join(home, "project");
  const sessions = join(home, "sessions");
  mkdirSync(cwd, { recursive: true });
  // Bound SDK project-resource ancestor discovery to this owned fixture tree.
  // An empty marker suffices; do not initialize or run a real Git workflow.
  mkdirSync(join(cwd, ".git"));
  mkdirSync(sessions, { recursive: true });
  initialize({ agentDir });
  const globalConfig = join(agentDir, "extensions/pi-alehouse/config.json");
  const workspaceConfig = join(cwd, ".pi/extensions/pi-alehouse/config.json");
  const permissionConfig = join(agentDir, "extensions/pi-permission-system/config.json");
  const paths = {};
  for (const [name, base] of [
    ["fixture-global", join(agentDir, "skills")],
    ["fixture-project", join(cwd, ".pi/skills")],
    ["fixture-agents", join(cwd, ".agents/skills")],
    ["fixture-excluded", join(agentDir, "skills")],
  ]) {
    paths[name] = join(base, name, "SKILL.md");
    put(
      paths[name],
      `---\nname: ${name}\ndescription: Use for ${name} fixture tasks.\n---\nPRIVATE_SKILL_BODY_${name}\n`,
    );
  }
  // The production child settings manager must honor the SDK's exclusion too.
  json(join(agentDir, "settings.json"), {
    skills: [`-${paths["fixture-excluded"]}`],
    cacheWarming: "off",
  });
  json(join(agentDir, "alehouse-presets.json"), {
    version: 3,
    defaultPreset: "fixture",
    presets: {
      fixture: {
        version: "v1",
        slots: Object.fromEntries(
          ["d1", "d2", "d3", "d4", "d5"].map((slot) => [
            slot,
            { model: "alehouse-fixture/controlled" },
          ]),
        ),
      },
    },
  });
  initTheme(undefined, false);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const provider = controlledProvider(ai);
  runtime.registerProvider("alehouse-fixture", provider.config);
  const model = runtime.getModel("alehouse-fixture", "controlled");
  assert(model);
  const authority = await createJiti(join(packageRoot, "src/composition.ts")).import(
    join(packageRoot, "generated/authority/index.ts"),
  );
  let sequence = 0;

  async function parent({ trusted = true, selects = [], authorizer } = {}) {
    const ui = { menus: [], notices: [], errors: [] };
    const lifecycle = [];
    const asks = [];
    const decisions = [];
    const steps = [];
    const tasks = new Map();
    let scriptFailure;
    const noop = () => {};
    const uiContext = {
      select: async (title, options) => {
        ui.menus.push({ title, options });
        assert(title.startsWith("Alehouse settings"), `unexpected dialog: ${title}`);
        const answer = selects.shift();
        if (answer !== undefined)
          assert(options.includes(answer), JSON.stringify({ title, options, answer }));
        return answer;
      },
      confirm: async () => assert.fail("no human approval or confirmation in this fixture"),
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
      notify: (message, type) => ui.notices.push({ message, type }),
      onTerminalInput: () => noop,
      setStatus: noop,
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
      theme: { fg: (_color, value) => value, bold: (value) => value },
    };
    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
      { projectTrusted: trusted },
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      // Parent discovery is deliberately off independently of the child preference.
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [join(packageRoot, "src/composition.ts")],
      extensionFactories: [
        (pi) => {
          for (const kind of ["session-created", "disposed"])
            pi.events.on(`subagents:child:${kind}`, (event) => lifecycle.push({ kind, ...event }));
          pi.events.on("permissions:decision", (event) => decisions.push(event));
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      settingsManager,
      sessionManager: SessionManager.create(cwd, sessions),
      tools: ["read", "agent_spawn", "agent_run", "agent_wait"],
    });
    provider.respond(async (request) => {
      try {
        const prompt = request.context.systemPrompt;
        const profile = /<active_agent name="(\w+)"\/>/.exec(prompt)?.[1];
        if (!profile) {
          assert(!prompt.includes("<available_skills>"), "parent discovery remains off");
          const step = steps.shift();
          assert(step, "unscripted parent provider request");
          return step(request.context.messages.at(-1));
        }
        const message = request.context.messages.findLast(
          (entry) => entry.role === "user" && /SKILLS_TASK_\d+/.test(text(entry)),
        );
        const key = /SKILLS_TASK_\d+/.exec(text(message))?.[0];
        const task = tasks.get(key);
        assert(task, `unscripted child task ${key}`);
        assert.equal(profile, task.profile === "worker" ? "editor" : "researcher");
        task.observations.push({ prompt, tools: request.context.tools.map((tool) => tool.name) });
        if (!task.issued && task.reads.length) {
          task.issued = true;
          return {
            tools: task.reads.map((path, index) => ({
              type: "toolCall",
              id: `${key}-read-${index}`,
              name: "read",
              arguments: { path },
            })),
          };
        }
        task.results = task.reads.map((_path, index) =>
          request.context.messages.findLast(
            (entry) => entry.role === "toolResult" && entry.toolCallId === `${key}-read-${index}`,
          ),
        );
        return { text: `${key}_DONE` };
      } catch (error) {
        scriptFailure ??= error;
        throw error;
      }
    });
    let unregister;
    try {
      await session.bindExtensions({
        mode: "rpc",
        uiContext,
        onError: (error) => ui.errors.push(error.error),
      });
      assert.deepEqual(ui.errors, []);
      assert(session.getActiveToolNames().includes("agent_spawn"), JSON.stringify(ui.notices));
      const service = authority.getPermissionsService(session.sessionId);
      assert(service, "real generated authority is ready");
      if (authorizer)
        unregister = service.registerAuthorizer("child-skills-fixture", async (details) => {
          asks.push(details);
          return { kind: "deny", reason: "CHILD_SKILLS_CONTROLLED_ASK_DENY" };
        });
    } catch (error) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      throw error;
    }

    async function run(profile, { agent, reads = [] } = {}) {
      const key = `SKILLS_TASK_${++sequence}`;
      const task = { profile, reads, observations: [], results: [], issued: false };
      tasks.set(key, task);
      const tool = agent ? "agent_run" : "agent_spawn";
      agent ??= `bird${sequence}`;
      let waits = 0;
      const settled = (last) => {
        assert.equal(last?.toolName, waits ? "agent_wait" : tool);
        assert.equal(last.isError, false, text(last));
        const reply = JSON.parse(text(last));
        const row = reply.tasks?.find((entry) => entry.agent === agent);
        // Repeated managed read blocks can publish the runtime's one bounded
        // feedback alert before the Run settles. Consume it normally, then
        // wait through the real management API; never suppress the observer.
        if (reply.reason === "alert" && row?.status !== "completed") {
          assert.equal(waits++, 0, "at most one managed feedback alert per Run");
          steps.unshift(settled);
          return {
            tools: [
              {
                type: "toolCall",
                id: `${key}-wait-${waits}`,
                name: "agent_wait",
                arguments: { agents: [agent], wait_ms: 10000 },
              },
            ],
          };
        }
        assert(["done", "alert"].includes(reply.reason), JSON.stringify({ reply, ui }));
        assert.equal(row?.status, "completed", JSON.stringify({ reply, ui }));
        assert.equal(row.result, `${key}_DONE`);
        return { text: "PARENT_DONE" };
      };
      steps.push(
        () => ({
          tools: [
            {
              type: "toolCall",
              id: `parent-${sequence}`,
              name: tool,
              arguments: {
                agent,
                prompt: key,
                label: "Inspect fixture skill catalogue",
                ...(tool === "agent_spawn"
                  ? { profile, reasoning_difficulty: 1 }
                  : { continues: "Continue inspecting this Agent's original skill catalogue" }),
                wait_ms: 10000,
              },
            },
          ],
        }),
        settled,
      );
      await session.prompt(`PARENT_STEP_${sequence}`, { expandPromptTemplates: false });
      if (scriptFailure) throw scriptFailure;
      assert.deepEqual(steps, [], "all scripted parent requests ran");
      assert.equal(task.results.length, reads.length);
      return { ...task, agent };
    }
    return {
      run,
      ui,
      asks,
      decisions,
      lifecycle,
      menu: () => session.prompt("/alehouse-settings"),
      close: async () => {
        const failures = [];
        const ids = (kind) =>
          lifecycle
            .filter((entry) => entry.kind === kind)
            .map((entry) => entry.sessionId)
            .sort();
        for (const check of [
          () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          () => unregister?.(),
          () => session.dispose(),
          () => assert.deepEqual(selects, [], "all settings answers consumed"),
          () => assert.deepEqual(ui.errors, []),
          () =>
            assert(!ui.notices.some(({ type }) => type === "error"), JSON.stringify(ui.notices)),
          () =>
            assert(
              !ui.notices.some(({ message }) =>
                /cleanup is incomplete|Settings not saved/.test(message),
              ),
              JSON.stringify(ui.notices),
            ),
          () =>
            assert.deepEqual(ids("disposed"), ids("session-created"), "all real children disposed"),
          () => assert.equal(authority.getPermissionsService(session.sessionId), undefined),
        ]) {
          try {
            await check();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, "child-skills parent cleanup failed");
      },
    };
  }
  return { parent, cwd, paths, globalConfig, workspaceConfig, permissionConfig };
}

export function assertRead(task, index, allowed, marker) {
  const result = task.results[index];
  assert(result, `missing read result ${index}`);
  assert.equal(result.isError, !allowed, text(result));
  if (allowed) assert(text(result).includes(`PRIVATE_SKILL_BODY_${marker}`), text(result));
  else {
    assert(!text(result).includes("PRIVATE_SKILL_BODY_"), text(result));
    assert(text(result).includes(marker), text(result));
  }
}
