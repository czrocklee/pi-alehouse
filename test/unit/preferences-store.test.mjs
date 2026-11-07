import {
  team,
  allSlots,
  allSlotDefinitions,
  fixture,
  controls,
  nearLimitPreferences,
} from "../support/preferences-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { stageWorkerSelection } from "../../dist/orchestration/ui/preferences-controls.js";
import { strengths } from "../../dist/orchestration/routing.js";
import {
  restorePresetRouter,
  restorePresetDefinitions,
} from "../../dist/orchestration/extension.js";
import { SettingsStore } from "../../src/shared/settings-store.mjs";

test("preferences seed fresh selections; enabled branch selections record explicit effort overrides", async (t) => {
  const f = await fixture(t);
  const prefs = { version: 2, preset: "team", effort: { team: { d1: "max", d5: null } } };
  const fresh = restorePresetRouter(f.path, [], prefs).current();
  assert.equal(fresh.name, "team");
  assert.deepEqual(fresh.effort_overrides, { d1: "max" });
  assert.equal(fresh.effort.d5, "high");
  const restored = restorePresetRouter(
    f.path,
    [{ name: "team", effort_overrides: {} }],
    prefs,
  ).current();
  assert.deepEqual(restored.effort_overrides, {});
  assert.equal(restored.effort.d1, "low");
  assert.deepEqual(
    restorePresetRouter(
      f.path,
      [{ name: "team", effort_overrides: { d5: "off" } }],
      prefs,
    ).current().effort_overrides,
    { d5: "off" },
    "a recorded selection replaces the fresh preference pins",
  );
  assert.throws(() => restorePresetRouter(f.path, [{ name: "team" }], prefs), {
    code: "INVALID_SAVED_EFFORT",
  });
  assert.throws(
    () =>
      restorePresetRouter(
        f.path,
        [{ name: "team", effort_overrides: { d5: "off" } }, { name: "team" }],
        prefs,
      ),
    { code: "INVALID_SAVED_EFFORT" },
    "a later name-only record is rejected, not silently merged",
  );
  assert.equal(restorePresetRouter(f.path, [{ name: "off" }], prefs).current().name, "off");
  assert.throws(() => restorePresetRouter(f.path, [], { version: 2, preset: "removed" }), {
    code: "PRESET_NOT_FOUND",
  });
});

test("custom model preset candidates are transactional, immutable to callers and survive branch restoration", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path, "utf8");
  const definitions = { custom: team("other") };
  const candidate = f.router.prepare(definitions);
  definitions.custom.slots.d1.model = "mutated/no";
  assert(!f.router.names().includes("custom"), "preparation alone must not publish");
  assert.equal(
    f.router.inspect(candidate).find((x) => x.name === "custom").models.d1,
    "fixture/other",
  );
  assert.throws(
    () =>
      f.router.apply(candidate, "custom", () => {
        throw new Error("audit failed");
      }),
    /audit failed/,
  );
  assert(!f.router.names().includes("custom"));
  const records = [];
  f.router.apply(candidate, "custom", (selection) =>
    records.push({ ...selection, custom_presets: { custom: team("other") } }),
  );
  assert.equal(f.router.current().models.d1, "fixture/other");
  assert.equal(restorePresetRouter(f.path, records).current().models.d1, "fixture/other");
  assert.deepEqual(restorePresetDefinitions(records), { custom: team("other") });
  assert.throws(
    () =>
      restorePresetDefinitions([
        {
          custom_presets: {
            legacy: {
              version: "v1",
              models: allSlots("fixture/worker"),
              effort: { d3: "high" },
              thinking: { d3: { high: "high" } },
            },
          },
        },
      ]),
    { code: "INVALID_SAVED_PRESETS" },
    "retired flat definitions are rejected rather than expanded or aliased",
  );
  assert.throws(() => restorePresetDefinitions([{ custom_presets: { off: team() } }]), {
    code: "INVALID_SAVED_PRESETS",
  });
  assert.equal(await readFile(f.path, "utf8"), before, "catalogue file is never rewritten");
  const old = f.router.prepare({ custom: team("old") });
  f.router.commit(f.router.prepare(), "off");
  assert.throws(() => f.router.commit(old, "custom"), { code: "STALE_PRESET_SELECTION" });
});

test(
  "saved thinking fields, including empty maps, fail restoration without mutations",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      before = await readFile(f.path, "utf8"),
      live = f.router.current();
    const definitions = [{}, null, { low: "high" }].map((thinking) => {
      const definition = team();
      definition.slots.d3.thinking = thinking;
      return definition;
    });
    // An otherwise valid changed slot cannot hide unsupported sibling fields.
    const edited = team();
    for (const slot of strengths) if (slot !== "d3") edited.slots[slot].thinking = {};
    definitions.push(edited);
    for (const definition of definitions) {
      const records = [
          { name: "team", effort_overrides: {}, custom_presets: { team: definition } },
        ],
        original = structuredClone(records);
      for (const restore of [
        () => restorePresetDefinitions(records),
        () => restorePresetRouter(f.path, records),
      ]) {
        assert.throws(restore, (error) => {
          assert.equal(error.code, "INVALID_SAVED_PRESETS");
          assert.match(error.details.resolution, /per-slot thinking fields are unsupported/);
          assert.match(error.details.resolution, /Correct configuration files explicitly/);
          assert.match(error.details.resolution, /fresh session or fork/);
          assert.match(error.details.resolution, /Do not rewrite historical journal records/);
          return true;
        });
      }
      assert.deepEqual(
        records,
        original,
        "restoration must not remove or convert a recorded thinking field",
      );
      assert.deepEqual(f.router.current(), live);
      assert.deepEqual(f.store.pending(), []);
    }
    assert.equal(await readFile(f.path, "utf8"), before);
  },
);

test("workspace preset definitions replace by name, and explicit branch edits override startup definitions", async (t) => {
  const f = await fixture(t);
  const prefs = { version: 2, preset: "team", presets: { team: team("global") } };
  assert.equal(restorePresetRouter(f.path, [], prefs).current().models.d5, "fixture/global");
  const records = [
    { name: "team", effort_overrides: {}, custom_presets: { team: team("session") } },
  ];
  assert.equal(restorePresetRouter(f.path, records, prefs).current().models.d5, "fixture/session");
});

test("routing accepts bounded global, workspace and session definitions together without enlarging stored records", async (t) => {
  const f = await fixture(t);
  const definitions = (prefix) =>
    Object.fromEntries(
      Array.from({ length: 270 }, (_unused, index) => [
        `${prefix}${index}`,
        { version: "v".repeat(64), slots: allSlotDefinitions(`fixture/${"m".repeat(100)}`) },
      ]),
    );
  f.store.stage("global", ["presets"], definitions("global"));
  f.store.stage("workspace", ["presets"], definitions("workspace"));
  assert(f.store.flush().every((result) => !result.error));
  const preferences = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  }).effective();
  const records = [
    { name: "session0", effort_overrides: {}, custom_presets: definitions("session") },
  ];
  const router = restorePresetRouter(f.path, records, preferences);
  assert.equal(router.current().name, "session0");
  assert.equal(router.names().length, 812, "base + three custom layers + off");
  assert(Buffer.byteLength(JSON.stringify(router.customPresets())) > 512 * 1024);
  assert.equal(router.prepare().names.length, router.names().length);
  assert.throws(
    () => restorePresetDefinitions([{ custom_presets: router.customPresets() }]),
    { code: "INVALID_SAVED_PRESETS" },
    "session records contain only session definitions, not the larger merged routing catalogue",
  );
});

test("applied changes stage only explicit fields; reset masks pins and Off preserves all effort preferences", async (t) => {
  const { router, store } = await fixture(t);
  const off = router.current();
  const first = router.apply(router.prepare(), "team", () => {}, { d1: "high" });
  stageWorkerSelection(store, first, off, true);
  assert.deepEqual(store.pending(), [], "Session is the initial scope");
  store.setScope("workspace");
  stageWorkerSelection(store, first, off, true);
  assert.deepEqual(store.get("workspace"), {
    version: 2,
    preset: "team",
    effort: { team: { d1: "high" } },
  });
  store.flush();
  const reset = router.apply(router.prepare(), "team", () => {}, {});
  stageWorkerSelection(store, reset, first, true, first.effort_overrides);
  assert.equal(store.get("workspace").effort.team.d1, null);
  const next = router.apply(router.prepare(), "off", () => {});
  stageWorkerSelection(store, next, reset, false);
  assert.equal(store.get("workspace").preset, "off");
  assert.equal(store.get("workspace").effort.team.d1, null);
});

test("beer mugs toggles live on/off with dynamic labels; session choices never stage or create config", async (t) => {
  const f = await fixture(t),
    before = f.router.current();
  const catalogue = await readFile(f.path, "utf8"),
    c = controls(f, ["Beer mugs: off", "Beer mugs: on"]);
  assert.equal(c.beerMugs.enabled, false);
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, true);
  assert(c.selectPrompts[0].choices.includes("Beer mugs: off"));
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, false);
  assert(c.selectPrompts[1].choices.includes("Beer mugs: on"));
  assert.deepEqual(c.beerMugs.calls, [true, false]);
  assert.deepEqual(c.confirmPrompts, [], "appearance toggles need no extra dialog");
  assert(
    c.notifications.every(({ text, level }) => level === "info" && text.includes("session only")),
  );
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.store.flush(), []);
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.deepEqual(f.router.current(), before);
  assert.equal(await readFile(f.path, "utf8"), catalogue);
});

for (const scope of ["global", "workspace"])
  test(`explicit ${scope} scope queues only the beer-mug leaf and Save pending now persists it`, async (t) => {
    const f = await fixture(t),
      c = controls(f, ["Change save scope", scope, "Beer mugs: off", "Save pending now"], [true]);
    await c.ui.open();
    assert.equal(f.store.scope, scope);
    assert.deepEqual(f.store.pending(), [], "scope consent alone copies nothing");
    assert.match(c.confirmPrompts[0].text, /worker, approval and appearance choices/);
    await c.ui.open();
    assert.equal(c.beerMugs.enabled, true);
    assert.deepEqual(f.store.pending(), [{ scope, path: ["ui", "beerMugs"], value: true }]);
    await assert.rejects(
      readFile(f.store.paths[scope]),
      { code: "ENOENT" },
      "toggle only queues persistence",
    );
    assert(c.notifications.some(({ text }) => text.includes("1 pending until exit")));
    assert(!c.notifications.some(({ text }) => text.includes("Settings saved")));
    await c.ui.open();
    assert.deepEqual(JSON.parse(await readFile(f.store.paths[scope], "utf8")), {
      version: 2,
      ui: { beerMugs: true },
    });
    assert.deepEqual(f.store.pending(), []);
    const other = scope === "global" ? "workspace" : "global";
    await assert.rejects(readFile(f.store.paths[other]), { code: "ENOENT" });
    f.store.stage(scope, ["approval"], "manual");
    assert(f.store.flush().every((result) => !result.error));
    const off = controls(f, ["Beer mugs: on", "Save pending now"]);
    assert.equal(off.beerMugs.enabled, true, "the helper initializes from effective preferences");
    await off.ui.open();
    assert.deepEqual(f.store.pending(), [{ scope, path: ["ui", "beerMugs"], value: false }]);
    await off.ui.open();
    assert.deepEqual(JSON.parse(await readFile(f.store.paths[scope], "utf8")), {
      version: 2,
      ui: { beerMugs: false },
      approval: "manual",
    });
  });

test("workspace beer-mug false masks global true and survives reload without replacing other fields", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "beerMugs"], true);
  f.store.stage("workspace", ["delegation", "mode"], "manual");
  assert(f.store.flush().every((result) => !result.error));
  const c = controls(
    f,
    ["Change save scope", "workspace", "Beer mugs: on", "Save pending now"],
    [true],
  );
  assert.equal(c.beerMugs.enabled, true);
  await c.ui.open();
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, false);
  assert.deepEqual(f.store.pending(), [
    { scope: "workspace", path: ["ui", "beerMugs"], value: false },
  ]);
  await c.ui.open();
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.workspace, "utf8")), {
    version: 2,
    delegation: { mode: "manual" },
    ui: { beerMugs: false },
  });
  f.store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });
  assert.equal(f.store.get("global").ui.beerMugs, true);
  assert.equal(f.store.effective().ui.beerMugs, false);
  assert.equal(controls(f).beerMugs.enabled, false);
});

for (const global of [false, true])
  for (const workspace of [false, true]) {
    test(`global beer-mug toggle explains workspace precedence (global=${global}, workspace=${workspace})`, async (t) => {
      const f = await fixture(t);
      f.store.stage("global", ["ui", "beerMugs"], global);
      f.store.stage("global", ["approval"], "manual");
      f.store.stage("workspace", ["ui", "beerMugs"], workspace);
      f.store.stage("workspace", ["delegation", "mode"], "lead");
      assert(f.store.flush().every((result) => !result.error));
      const workspaceBytes = await readFile(f.store.paths.workspace, "utf8");
      const c = controls(
        f,
        [
          "Change save scope",
          "global",
          `Beer mugs: ${workspace ? "on" : "off"}`,
          "Save pending now",
        ],
        [true],
      );
      await c.ui.open();
      assert.deepEqual(f.store.pending(), [], "scope consent alone stages nothing");
      await c.ui.open();
      const enabled = !workspace,
        noWrite = global === enabled;
      assert.equal(c.beerMugs.enabled, enabled);
      assert.deepEqual(
        f.store.pending(),
        noWrite ? [] : [{ scope: "global", path: ["ui", "beerMugs"], value: enabled }],
      );
      const notice = c.notifications.find(({ text }) =>
        text.includes("workspace ui.beerMugs override"),
      );
      assert(notice, "explain shadowing even when the global leaf already equals the live toggle");
      assert.equal(notice.level, "info");
      assert(notice.text.includes(`Current session: Beer mugs: ${enabled ? "on" : "off"}`));
      assert(notice.text.includes("Save scope: global"));
      assert(
        notice.text.includes(
          `Next startup after saving pending writes, if any: Beer mugs: ${workspace ? "on" : "off"}`,
        ),
      );
      assert(notice.text.includes("takes precedence") && notice.text.includes("not removed"));
      assert.equal(await readFile(f.store.paths.workspace, "utf8"), workspaceBytes);
      await c.ui.open();
      assert.deepEqual(f.store.pending(), []);
      assert.deepEqual(JSON.parse(await readFile(f.store.paths.global, "utf8")), {
        version: 2,
        ui: { beerMugs: enabled },
        approval: "manual",
      });
      assert.equal(
        await readFile(f.store.paths.workspace, "utf8"),
        workspaceBytes,
        "global saves never remove workspace overrides",
      );
      const restored = new SettingsStore({
        agentDir: join(f.root, "agent"),
        cwd: join(f.root, "work"),
        projectTrusted: true,
      });
      assert.equal(restored.effective().ui.beerMugs, workspace);
      assert.equal(c.beerMugs.enabled, enabled, "saving defaults does not replace the live choice");
      if (noWrite) {
        assert(c.notifications.some(({ text }) => text === "No pending configuration writes."));
        assert(!c.notifications.some(({ text }) => text.includes("Settings saved")));
      }
    });
  }

test("global appearance notices ignore untrusted workspace overrides and preserve unrelated pending leaves", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "beerMugs"], false);
  f.store.stage("workspace", ["ui", "beerMugs"], true);
  assert(f.store.flush().every((result) => !result.error));
  const workspaceBytes = await readFile(f.store.paths.workspace, "utf8");
  f.store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: false,
  });
  f.store.stage("global", ["approval"], "manual");
  const pending = f.store.pending(),
    c = controls(f, ["Change save scope", "global", "Beer mugs: off"], [true]);
  await c.ui.open();
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, true);
  assert.deepEqual(f.store.pending(), [
    ...pending,
    { scope: "global", path: ["ui", "beerMugs"], value: true },
  ]);
  assert.deepEqual(f.store.get("workspace"), { version: 2 });
  assert(!c.notifications.some(({ text }) => text.includes("workspace ui.beerMugs override")));
  assert.equal(await readFile(f.store.paths.workspace, "utf8"), workspaceBytes);
});

for (const change of ["cancel", "retire", "dispose"])
  test(`a ${change} settings menu never toggles appearance or queues writes`, async (t) => {
    const f = await fixture(t),
      c = controls(f);
    c.ctx.ui.select = async () => {
      if (change === "retire") c.retire();
      if (change === "dispose") c.ui.dispose();
      return change === "cancel" ? undefined : "Beer mugs: off";
    };
    if (change === "cancel") await c.ui.open();
    else await assert.rejects(c.ui.open(), { code: "SETTINGS_SESSION_CHANGED" });
    assert.deepEqual(c.beerMugs.calls, []);
    assert.equal(c.beerMugs.enabled, false);
    assert.deepEqual(f.store.pending(), []);
    for (const path of Object.values(f.store.paths))
      await assert.rejects(readFile(path), { code: "ENOENT" });
  });

test("busy settings menus and missing UI cannot dispatch another appearance toggle", async (t) => {
  const f = await fixture(t),
    c = controls(f);
  let answer,
    selects = 0;
  c.ctx.ui.select = () => {
    selects++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const opening = c.ui.open();
  await c.ui.open();
  assert.equal(selects, 1);
  assert.deepEqual(c.beerMugs.calls, []);
  answer(undefined);
  await opening;
  c.ctx.hasUI = false;
  await assert.rejects(c.ui.open(), { code: "SETTINGS_UI_REQUIRED" });
  assert.equal(selects, 1);
  assert.deepEqual(c.beerMugs.calls, []);
  assert.deepEqual(f.store.pending(), []);
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("unrelated menu choices and cancelled nested dialogs do not toggle or write appearance", async (t) => {
  const f = await fixture(t);
  for (const action of [
    "Change save scope",
    "Remember current worker settings",
    "Show paths and pending changes",
    "Save pending now",
    "Discard pending writes",
    "Remove a saved override",
  ]) {
    const c = controls(f, [action]);
    await c.ui.open();
    assert.deepEqual(c.beerMugs.calls, [], action);
    assert.equal(c.beerMugs.enabled, false);
    assert.equal(f.store.scope, "session");
    assert.deepEqual(f.store.pending(), []);
  }
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("discard and removal of a saved false affect persistence only, never the live appearance", async (t) => {
  const f = await fixture(t);
  f.store.stage("workspace", ["ui", "beerMugs"], false);
  f.store.stage("workspace", ["approval"], "manual");
  assert(f.store.flush().every((result) => !result.error));
  const path = JSON.stringify(["ui", "beerMugs"]);
  const c = controls(
    f,
    [
      "Change save scope",
      "workspace",
      "Beer mugs: off",
      "Discard pending writes",
      "Remove a saved override",
      "workspace",
      path,
      "Save pending now",
    ],
    [true, true, true],
  );
  await c.ui.open();
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, true);
  await c.ui.open();
  assert.deepEqual(f.store.pending(), []);
  assert.equal(f.store.get("workspace").ui.beerMugs, false);
  assert.equal(c.beerMugs.enabled, true);
  const restoredAfterDiscard = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });
  assert.equal(
    restoredAfterDiscard.effective().ui.beerMugs,
    false,
    "discarded live choices do not become startup defaults",
  );
  assert.match(
    c.confirmPrompts.find(({ title }) => title === "Discard pending configuration writes?").text,
    /Next startup follows the existing on-disk.*not the discarded changes/,
  );
  assert(
    c.notifications.some(({ text }) =>
      /Pending writes discarded.*Current session choices stay unchanged.*next startup follows the existing on-disk defaults/.test(
        text,
      ),
    ),
  );
  await c.ui.open();
  assert(
    c.selectPrompts.at(-3).choices.includes("Beer mugs: on"),
    "the label follows the live choice, not the discarded saved false",
  );
  assert(c.selectPrompts.at(-1).choices.includes(path), "saved false is removable");
  assert.deepEqual(f.store.pending(), [
    { scope: "workspace", path: ["ui", "beerMugs"], value: undefined },
  ]);
  await c.ui.open();
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.workspace, "utf8")), {
    version: 2,
    ui: {},
    approval: "manual",
  });
  assert.deepEqual(c.beerMugs.calls, [true]);
  assert.equal(c.beerMugs.enabled, true);
});

for (const failure of ["sealed store", "byte cap"])
  test(`appearance stays live with a warning if queuing fails (${failure})`, async (t) => {
    const f = await fixture(t);
    if (failure === "byte cap")
      f.store.stage("global", ["presets"], nearLimitPreferences({ version: 2 }, 0).presets);
    const c = controls(f, ["Change save scope", "global", "Beer mugs: off"], [true]);
    await c.ui.open();
    if (failure === "sealed store") f.store.seal();
    const pending = f.store.pending();
    await c.ui.open();
    assert.equal(c.beerMugs.enabled, true);
    assert.deepEqual(c.beerMugs.calls, [true]);
    assert.deepEqual(f.store.pending(), pending);
    assert(
      c.notifications.some(
        ({ text, level }) =>
          level === "warning" && /live for this session.*defaults were not queued/.test(text),
      ),
    );
    assert(!c.notifications.some(({ text }) => text.includes("Settings saved")));
    await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  });

test("removing a saved workspace appearance explains next-start inheritance without changing live or disk early", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "beerMugs"], true);
  f.store.stage("workspace", ["ui", "beerMugs"], false);
  f.store.stage("workspace", ["approval"], "manual");
  assert(f.store.flush().every((result) => !result.error));
  const before = await readFile(f.store.paths.workspace, "utf8");
  const c = controls(
    f,
    [
      "Remove a saved override",
      "workspace",
      JSON.stringify(["ui", "beerMugs"]),
      "Save pending now",
    ],
    [true],
  );
  assert.equal(c.beerMugs.enabled, false);
  await c.ui.open();
  assert.deepEqual(c.beerMugs.calls, []);
  assert.equal(c.beerMugs.enabled, false);
  assert.deepEqual(f.store.pending(), [
    { scope: "workspace", path: ["ui", "beerMugs"], value: undefined },
  ]);
  assert.equal(
    await readFile(f.store.paths.workspace, "utf8"),
    before,
    "removal stays pending until explicit save or exit",
  );
  assert.match(
    c.confirmPrompts[0].text,
    /Current session choices are unchanged.*After saving pending writes, next startup follows the remaining saved layers or defaults/,
  );
  assert(
    c.notifications.some(({ text }) =>
      /Override removal staged for workspace.*Current session choices stay unchanged.*next startup follows the remaining saved layers/.test(
        text,
      ),
    ),
  );
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, false);
  assert.deepEqual(c.beerMugs.calls, []);
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.workspace, "utf8")), {
    version: 2,
    ui: {},
    approval: "manual",
  });
  const restored = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });
  assert.equal(
    restored.effective().ui.beerMugs,
    true,
    "only the next startup inherits the lower global appearance",
  );
});

test("Remember current worker settings does not implicitly remember the live appearance", async (t) => {
  const f = await fixture(t),
    c = controls(f, ["Beer mugs: off", "Remember current worker settings", "global"], [true]);
  await c.ui.open();
  await c.ui.open();
  assert.equal(c.beerMugs.enabled, true);
  assert.equal(f.store.scope, "session");
  assert.equal(Object.hasOwn(f.store.get("global"), "ui"), false);
  assert(f.store.pending().every(({ path }) => path[0] !== "ui"));
  assert.deepEqual(c.beerMugs.calls, [true]);
  await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
});

test("scope consent stages nothing; explicit remember previews and queues a snapshot, not a hidden disk write", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  const c = controls(f, ["Change save scope", "workspace"], [true]);
  await c.ui.open();
  assert.equal(f.store.scope, "workspace");
  assert.deepEqual(f.store.pending(), []);
  const remember = controls(f, ["Remember current worker settings", "global"], [true]);
  await remember.ui.open();
  assert.equal(f.store.scope, "workspace", "one-shot remember never changes the ongoing scope");
  assert.deepEqual(f.store.get("global").effort.team, allSlots(null));
  assert.deepEqual(f.store.get("global").delegation, { mode: "lead", eagerness: "eager" });
  await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  f.store.seal();
  assert.equal(f.store.flush()[0].error, undefined);
  assert.equal(JSON.parse(await readFile(f.store.paths.global, "utf8")).preset, "team");
});

test("cancelled or stale scope consent never changes save scope or creates files", async (t) => {
  const f = await fixture(t);
  const c = controls(f, ["Change save scope", "workspace"], [false]);
  await c.ui.open();
  assert.equal(f.store.scope, "session");
  const stale = controls(f, ["Change save scope", "workspace"]);
  stale.ctx.ui.confirm = async () => {
    stale.retire();
    return true;
  };
  await assert.rejects(stale.ui.open(), { code: "SETTINGS_SESSION_CHANGED" });
  assert.equal(f.store.scope, "session");
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(c.beerMugs.calls, []);
  assert.deepEqual(stale.beerMugs.calls, []);
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("discard only drops pending persistence, while no-UI and untrusted workspace cannot opt in", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["preset"], "team");
  f.router.select("team");
  const c = controls(f, ["Discard pending writes"], [true]);
  await c.ui.open();
  assert.equal(f.router.current().name, "team");
  assert.deepEqual(f.store.pending(), []);
  c.ctx.hasUI = false;
  await assert.rejects(c.ui.open(), { code: "SETTINGS_UI_REQUIRED" });
  f.store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: false,
  });
  const denied = controls(f, ["Change save scope", "workspace"], [true]);
  await assert.rejects(denied.ui.open(), { code: "PROJECT_NOT_TRUSTED" });
  assert.deepEqual(f.store.pending(), []);
});
