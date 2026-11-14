// Offline real-composition regression. Only scripted local provider responses;
// no host evidence collector, real models, network, human approvals or user state.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";

const home = process.env.ALEHOUSE_CHILD_SKILLS_FIXTURE_HOME;
assert(home && isAbsolute(home), "run through child-skills.test.mjs with an owned HOME");
assert.equal(process.env.HOME, home);
const agentDir = join(home, "agent");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
for (const [key, relative] of Object.entries({
  XDG_CONFIG_HOME: ".config",
  XDG_CACHE_HOME: ".cache",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
}))
  assert.equal(process.env[key], join(home, relative));
const scenario = process.argv[2];
assert(["preferences", "scopes", "lock", "authority"].includes(scenario));
assert.equal(process.env.PI_ALEHOUSE_NO_CHILD_SKILLS, scenario === "lock" ? "1" : undefined);

// Install before importing the SDK, composition or providers. Retain all blocks
// for the lifetime of this dedicated subprocess, including shutdown.
const network = [];
const blocked =
  (surface) =>
  (..._args) => {
    network.push(surface);
    throw new Error(`Unexpected ${surface} network IO in child-skills fixture`);
  };
globalThis.fetch = blocked("fetch");
for (const [module, names] of [
  [http, ["request", "get"]],
  [https, ["request", "get"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
])
  for (const name of names) module[name] = blocked(name);
net.Socket.prototype.connect = blocked("socket.connect");
syncBuiltinESMExports();

const { assertCatalogue, assertRead, childSkillsFixture, json, put, withParent } =
  await import("../../support/child-skills-fixture.mjs");
const f = await childSkillsFixture(home, agentDir);
const all = ["fixture-global", "fixture-project", "fixture-agents"];
const pathFor = (name) => f.paths[name];
const profileFiles = ["editor", "researcher"].map((name) => join(agentDir, "agents", `${name}.md`));
const profileBytes = profileFiles.map((path) => readFileSync(path));
const preferenceBytes = () =>
  [f.globalConfig, f.workspaceConfig].map((path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  );

async function preferences() {
  json(f.globalConfig, { version: 2, childSkills: false });
  const before = preferenceBytes();
  const p = await f.parent({ selects: ["Agent skills: off"] });
  await withParent(p, async () => {
    const old = await p.run("worker");
    assertCatalogue(old.observations, []);
    const created = p.lifecycle.filter((event) => event.kind === "session-created").length;
    await p.menu();
    assert(
      p.ui.notices.some(({ message }) => message.startsWith("Agent skills: on (session only")),
      JSON.stringify(p.ui.notices),
    );
    const reused = await p.run("worker", { agent: old.agent });
    assertCatalogue(reused.observations, []);
    assert.equal(
      p.lifecycle.filter((event) => event.kind === "session-created").length,
      created,
      "agent_run reused the existing SDK session",
    );
    for (const profile of ["worker", "scout"]) {
      const fresh = await p.run(profile);
      assertCatalogue(fresh.observations, all);
      for (const observation of fresh.observations) {
        for (const name of all) assert(observation.prompt.includes(pathFor(name)));
        assert(
          !observation.prompt.includes(pathFor("fixture-excluded")),
          "SDK exclusion survives production factory discovery",
        );
      }
    }
    assert.deepEqual(preferenceBytes(), before, "session-only UI toggle writes no preferences");
  });
  assert.deepEqual(preferenceBytes(), before, "quit also leaves saved false unchanged");
}

async function scopes() {
  // Fresh parents read preferences at the actual extension startup, not by
  // constructing a direct loader or mutating the live settings-store seam.
  for (const [global, workspace, trusted, expected] of [
    [undefined, undefined, true, all],
    [{ version: 2, childSkills: false }, { version: 2, childSkills: true }, true, all],
    [{ version: 2, childSkills: true }, { version: 2, childSkills: false }, true, []],
    [{ version: 2, childSkills: false }, { version: 2, childSkills: true }, false, []],
    [
      { version: 2, childSkills: true },
      { version: 2, childSkills: false },
      false,
      ["fixture-global"],
    ],
  ]) {
    if (global) json(f.globalConfig, global);
    if (workspace) json(f.workspaceConfig, workspace);
    const before = preferenceBytes();
    const p = await f.parent({ trusted });
    await withParent(p, async () => {
      assertCatalogue((await p.run("worker")).observations, expected);
    });
    assert.deepEqual(preferenceBytes(), before, "startup and shutdown never rewrite saved layers");
  }
}

async function lock() {
  json(f.globalConfig, { version: 2, childSkills: true });
  json(f.workspaceConfig, { version: 2, childSkills: true });
  const before = preferenceBytes();
  const label = "Agent skills: off (--no-skills)";
  const p = await f.parent({ selects: [label, undefined] });
  await withParent(p, async () => {
    for (const profile of ["worker", "scout"]) {
      const task = await p.run(profile, { reads: [pathFor("fixture-global")] });
      assertCatalogue(task.observations, []);
      assertRead(task, 0, true, "fixture-global");
    }
    await p.menu(); // Selecting the locked row cannot enable or stage anything.
    await p.menu();
    assert(
      p.ui.menus.every(({ options }) => options.includes(label)),
      JSON.stringify(p.ui.menus),
    );
    assert(
      p.ui.notices.some(({ message }) => message.includes("--no-skills")),
      JSON.stringify(p.ui.notices),
    );
    assertCatalogue((await p.run("worker")).observations, []);
  });
  assert.deepEqual(preferenceBytes(), before, "transient lock never overwrites saved true");
}

async function authority() {
  // Only disposable project-agent POLICY overrides, not the installed matched
  // definitions admitted by the factory. Preserve every shipped deny/floor.
  for (const [profile, states] of [
    ["editor", ["allow", "ask", "deny"]],
    ["researcher", ["deny", "allow", "ask"]],
  ]) {
    put(
      join(f.cwd, ".pi/agents", `${profile}.md`),
      [
        "---",
        "permission:",
        "  skill:",
        '    "*": deny',
        ...all.map((name, index) => `    "${name}": ${states[index]}`),
        "---",
        "Disposable skill policy only.",
        "",
      ].join("\n"),
    );
  }
  const policy = JSON.parse(readFileSync(f.permissionConfig, "utf8"));
  policy.authorizerChain.unshift("child-skills-fixture");
  const pathDenied = join(f.cwd, "path-denied.txt");
  const toolDenied = join(f.cwd, "read-tool-denied.txt");
  const secret = join(f.cwd, "fixture.env");
  for (const path of [pathDenied, toolDenied, secret]) put(path, "UNREADABLE_FIXTURE_CONTENT\n");
  policy.permission.path[pathDenied] = { action: "deny", reason: "CHILD_SKILLS_PATH_DENY" };
  assert.equal(policy.permission.read, "allow");
  policy.permission.read = {
    "*": "allow",
    [toolDenied]: { action: "deny", reason: "CHILD_SKILLS_READ_TOOL_DENY" },
  };
  assert.equal(policy.permission.path["*.env"], "deny");
  json(f.permissionConfig, policy);
  const p = await f.parent({ trusted: true, authorizer: true, selects: ["Agent skills: on"] });
  await withParent(p, async () => {
    const worker = await p.run("worker", { reads: all.map(pathFor) });
    assertCatalogue(worker.observations, ["fixture-global", "fixture-project"]);
    assertRead(worker, 0, true, "fixture-global");
    assertRead(worker, 1, false, "CHILD_SKILLS_CONTROLLED_ASK_DENY");
    // A metadata deny hides this skill; it is deliberately NOT a universal
    // file-read prohibition when its known path passes the ordinary gates.
    assertRead(worker, 2, true, "fixture-agents");
    const scout = await p.run("scout", { reads: all.map(pathFor) });
    assertCatalogue(scout.observations, ["fixture-project", "fixture-agents"]);
    assertRead(scout, 0, true, "fixture-global");
    assertRead(scout, 1, true, "fixture-project");
    assertRead(scout, 2, false, "CHILD_SKILLS_CONTROLLED_ASK_DENY");
    assert.equal(p.asks.length, 2, "only advertised ask-state skill reads escalate");
    assert.deepEqual(
      p.asks.map((ask) => ask.accessIntent?.surface),
      ["skill", "skill"],
    );
    assert.deepEqual(
      p.asks.map((ask) => ask.forwarding?.requesterAgentName),
      ["editor", "researcher"],
    );
    const askedSkills = ["fixture-project", "fixture-agents"];
    assert.deepEqual(
      p.asks.map((ask) => ask.accessIntent?.matchValues),
      askedSkills.map((name) => [name]),
    );
    assert.deepEqual(
      p.asks.map((ask) => ask.payload.request.value),
      askedSkills,
    );
    // Served decision events carry the child's display value: the concrete
    // read path. The named policy surface remains in the access facts/payload.
    for (const [index, name] of askedSkills.entries())
      assert(
        p.decisions.some(
          (decision) =>
            decision.requestId === p.asks[index].requestId &&
            decision.surface === "skill" &&
            decision.value === pathFor(name) &&
            decision.result === "deny" &&
            decision.resolution === "authorizer_denied",
        ),
        JSON.stringify(p.decisions),
      );

    await p.menu(); // Disable discovery through the same production live variable.
    const off = await p.run("worker", {
      reads: [
        pathFor("fixture-project"),
        pathFor("fixture-agents"),
        pathFor("fixture-excluded"),
        pathDenied,
        toolDenied,
        secret,
      ],
    });
    assertCatalogue(off.observations, []);
    for (const [index, name] of ["fixture-project", "fixture-agents", "fixture-excluded"].entries())
      assertRead(off, index, true, name);
    assertRead(off, 3, false, "CHILD_SKILLS_PATH_DENY");
    assertRead(off, 4, false, "CHILD_SKILLS_READ_TOOL_DENY");
    for (const result of off.results.slice(3))
      assert(!result.content.some((part) => part.text?.includes("UNREADABLE_FIXTURE_CONTENT")));
    assert.equal(off.results[5].isError, true, "seeded secret-path deny survives discovery off");
    assert(
      !off.results[5].content.some((part) => part.text?.includes("UNREADABLE_FIXTURE_CONTENT")),
    );
    assert.equal(
      p.asks.length,
      2,
      "off bypasses no path/tool denies and invents no hidden skill gate",
    );
  });
}

await { preferences, scopes, lock, authority }[scenario]();
for (const [index, path] of profileFiles.entries())
  assert.deepEqual(readFileSync(path), profileBytes[index], "managed profile bytes unchanged");
assert.deepEqual(network, [], "nothing attempted to leave the process");
console.log(`PASS: child skills ${scenario}, offline`);
