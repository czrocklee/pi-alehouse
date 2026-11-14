import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { controls, fixture } from "../support/preferences-fixture.mjs";
import { SettingsStore } from "../../src/shared/settings-store.mjs";

const restoredStore = (f) =>
  new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });

test("Agent skills defaults on and session toggles never stage or write", async (t) => {
  const f = await fixture(t),
    c = controls(f, ["Agent skills: on", "Agent skills: off"]);
  f.store.stage = () => assert.fail("session-only choices must not stage");
  assert.equal(c.childSkills.enabled, true);
  await c.ui.open();
  assert(c.selectPrompts[0].choices.includes("Agent skills: on"));
  assert.equal(c.childSkills.enabled, false);
  await c.ui.open();
  assert(c.selectPrompts[1].choices.includes("Agent skills: off"));
  assert.deepEqual(c.childSkills.calls, [false, true]);
  assert.deepEqual(f.store.pending(), []);
  for (const { text } of c.notifications) {
    assert.match(text, /session only; no configuration write/);
    assert.match(
      text,
      /New child sessions only; already-created sessions retain their loaded skill catalogue/,
    );
    assert.match(text, /Queued Agents without a session use the choice at session creation/);
    assert.match(text, /Off disables skill discovery, not file reads or permissions/);
  }
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const scope of ["global", "workspace"])
  test(`${scope} skills choices stage a boolean and restore false and true after explicit flush`, async (t) => {
    const f = await fixture(t);
    f.store.setScope(scope);
    const c = controls(f, ["Agent skills: on", "Save pending now", "Agent skills: off"]);
    await c.ui.open();
    assert.equal(f.store.get(scope).childSkills, false);
    assert.equal(f.store.pending().length, 1);
    await assert.rejects(readFile(f.store.paths[scope]), { code: "ENOENT" });
    await c.ui.open();
    assert.equal(JSON.parse(await readFile(f.store.paths[scope], "utf8")).childSkills, false);
    assert.deepEqual(f.store.pending(), []);
    const restored = restoredStore(f),
      next = controls({ ...f, store: restored });
    assert.equal(next.childSkills.enabled, false);
    assert.deepEqual(next.childSkills.calls, [], "restoration never applies a user toggle");
    assert.deepEqual(restored.pending(), [], "restoration never stages writes");
    await c.ui.open();
    assert.equal(f.store.get(scope).childSkills, true);
    c.ui.reportFlush();
    assert.equal(restoredStore(f).effective().childSkills, true);
    assert.deepEqual(c.childSkills.calls, [false, true]);
  });

test("a staging failure warns without rolling back the new-session live choice", async (t) => {
  const f = await fixture(t);
  f.store.setScope("global");
  f.store.stage = () => {
    throw new Error("controlled stage failure");
  };
  const c = controls(f, ["Agent skills: on"]);
  await c.ui.open();
  assert.equal(c.childSkills.enabled, false);
  assert.deepEqual(f.store.pending(), []);
  assert(
    c.notifications.some(
      ({ text, level }) =>
        level === "warning" &&
        /live for new child sessions, but defaults were not queued/.test(text) &&
        /controlled stage failure/.test(text) &&
        /already-created sessions retain/.test(text),
    ),
  );
});

for (const workspace of [false, true])
  test(`global skills saving reports a workspace ${workspace} shadow, including no-op saves`, async (t) => {
    const f = await fixture(t);
    f.store.stage("workspace", ["childSkills"], workspace);
    f.store.stage("global", ["childSkills"], workspace);
    f.store.flush();
    f.store.setScope("global");
    const c = controls(f, [
      `Agent skills: ${workspace ? "on" : "off"}`,
      `Agent skills: ${workspace ? "off" : "on"}`,
    ]);
    await c.ui.open();
    await c.ui.open();
    assert.equal(f.store.get("workspace").childSkills, workspace);
    const notices = c.notifications.filter(({ text }) =>
      /workspace childSkills override/.test(text),
    );
    assert.equal(notices.length, 2);
    for (const { text } of notices) {
      assert.match(text, /Save scope: global/);
      assert(
        text.includes(
          `Next startup after saving pending writes, if any: Agent skills: ${workspace ? "on" : "off"}`,
        ),
      );
      assert.match(text, /takes precedence.*it was not removed/);
    }
  });

for (const scope of ["global", "workspace"])
  test(`removing a saved ${scope} false skills override preserves the live choice`, async (t) => {
    const f = await fixture(t);
    f.store.stage(scope, ["childSkills"], false);
    f.store.flush();
    const c = controls(f, ["Remove a saved override", scope, '["childSkills"]'], [true]);
    await c.ui.open();
    assert.equal(c.childSkills.enabled, false);
    assert.deepEqual(c.childSkills.calls, []);
    assert.equal(f.store.get(scope).childSkills, undefined);
    assert.equal(JSON.parse(await readFile(f.store.paths[scope], "utf8")).childSkills, false);
    c.ui.reportFlush();
    assert.equal(restoredStore(f).effective().childSkills, undefined);
    assert.equal(controls({ ...f, store: restoredStore(f) }).childSkills.enabled, true);
  });

test("scope confirmation includes Agent skills but switching scope copies no choices", async (t) => {
  const f = await fixture(t),
    c = controls(f, ["Change save scope", "global"], [true]);
  await c.ui.open();
  assert.equal(f.store.scope, "global");
  assert.match(c.confirmPrompts[0].text, /Agent skills choices/);
  assert.match(c.confirmPrompts[0].text, /Switching scope alone copies nothing/);
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(c.childSkills.calls, []);
});

for (const scope of ["session", "global", "workspace"])
  for (const saved of [true, false])
    test(`CLI skill suppression cannot toggle or stage ${scope} preferences (saved ${saved})`, async (t) => {
      const f = await fixture(t);
      f.store.stage("global", ["childSkills"], saved);
      f.store.flush();
      f.store.setScope(scope);
      const before = await readFile(f.store.paths.global, "utf8"),
        c = controls(f, ["Agent skills: off (--no-skills)"]);
      c.childSkills.disabledReason = "--no-skills";
      f.store.stage = () => assert.fail("CLI-locked discovery must not stage preferences");
      await c.ui.open();
      assert(c.selectPrompts[0].choices.includes("Agent skills: off (--no-skills)"));
      assert.equal(
        c.childSkills.enabled,
        saved,
        "the saved choice remains distinct from CLI suppression",
      );
      assert.deepEqual(c.childSkills.calls, []);
      assert.deepEqual(f.store.pending(), []);
      assert.equal(await readFile(f.store.paths.global, "utf8"), before);
      assert(
        c.notifications.some(({ text }) =>
          /disabled for this launch by --no-skills \(-ns\)/.test(text),
        ),
      );
      assert(c.notifications.some(({ text }) => /Saved preferences are unchanged/.test(text)));
    });

test("skill suppression is rechecked after the settings dialog settles", async (t) => {
  const f = await fixture(t),
    c = controls(f);
  c.ctx.ui.select = async () => {
    c.childSkills.disabledReason = "--no-skills";
    return "Agent skills: on";
  };
  await c.ui.open();
  assert.deepEqual(c.childSkills.calls, []);
  assert.deepEqual(f.store.pending(), []);
});

for (const change of ["cancel", "retire", "dispose"])
  test(`a ${change} settings menu cannot toggle or stage skills`, async (t) => {
    const f = await fixture(t);
    f.store.setScope("global");
    const c = controls(f);
    c.ctx.ui.select = async () => {
      if (change === "retire") c.retire();
      if (change === "dispose") c.ui.dispose();
      return change === "cancel" ? undefined : "Agent skills: on";
    };
    if (change === "cancel") await c.ui.open();
    else await assert.rejects(c.ui.open(), { code: "SETTINGS_SESSION_CHANGED" });
    assert.deepEqual(c.childSkills.calls, []);
    assert.deepEqual(f.store.pending(), []);
  });

for (const change of ["cancel", "retire", "dispose"])
  test(`a ${change} removal confirmation cannot remove a skills override`, async (t) => {
    const f = await fixture(t);
    f.store.stage("global", ["childSkills"], false);
    f.store.flush();
    const c = controls(f, ["Remove a saved override", "global", '["childSkills"]']);
    c.ctx.ui.confirm = async () => {
      if (change === "retire") c.retire();
      if (change === "dispose") c.ui.dispose();
      return change !== "cancel";
    };
    if (change === "cancel") await c.ui.open();
    else await assert.rejects(c.ui.open(), { code: "SETTINGS_SESSION_CHANGED" });
    assert.equal(f.store.get("global").childSkills, false);
    assert.deepEqual(f.store.pending(), []);
    assert.deepEqual(c.childSkills.calls, []);
  });
