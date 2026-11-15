import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controls, fixture } from "../support/preferences-fixture.mjs";
import { SettingsStore, validateSettings } from "../../src/shared/settings-store.mjs";

/** Menu row and notification wording for the process-wide appearance switch. */
const border = (state) => `Border labels: ${state} (all Alehouse panels)`;

const reload = (f) =>
  new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: true,
  });

test("ui.borderLabels is optional, closed and strictly boolean without defaulting", () => {
  for (const borderLabels of [true, false]) {
    const document = { version: 2, ui: { borderLabels } };
    const validated = validateSettings(document);
    assert.deepEqual(validated, { version: 2, ui: { borderLabels } });
    assert.notEqual(validated.ui, document.ui);
    validated.ui.borderLabels = !borderLabels;
    assert.equal(document.ui.borderLabels, borderLabels, "validation detaches the stored leaf");
  }
  assert.deepEqual(validateSettings({ version: 2, ui: {} }), { version: 2, ui: {} });
  assert.deepEqual(validateSettings({ version: 2, ui: { beerMugs: true, borderLabels: false } }), {
    version: 2,
    ui: { beerMugs: true, borderLabels: false },
  });
  for (const borderLabels of [undefined, null, 0, 1, "true", "off", [], {}])
    assert.throws(
      () => validateSettings({ version: 2, ui: { borderLabels } }),
      /ui\.borderLabels must be a boolean/,
    );
  for (const ui of [{ borderLabels: true, extra: false }, { border: true }])
    assert.throws(() => validateSettings({ version: 2, ui }), /Invalid settings/);
  assert.equal(Object.hasOwn(validateSettings({ version: 2 }), "ui"), false);
  assert.equal(
    validateSettings({ version: 2 }).ui?.borderLabels !== false,
    true,
    "omitted consumers default border labels on",
  );
  assert.equal(validateSettings({ version: 2, ui: {} }).ui?.borderLabels !== false, true);
});

test("staging one appearance leaf leaves the sibling and unrelated ui state alone", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "beerMugs"], true);
  f.store.stage("global", ["ui", "borderLabels"], false);
  assert.deepEqual(
    f.store.pending().map(({ path, value }) => ({ path, value })),
    [
      { path: ["ui", "beerMugs"], value: true },
      { path: ["ui", "borderLabels"], value: false },
    ],
  );
  assert(f.store.flush().every((result) => !result.error));
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.global, "utf8")), {
    version: 2,
    ui: { beerMugs: true, borderLabels: false },
  });
  f.store.stage("global", ["ui", "beerMugs"], undefined);
  assert.deepEqual(f.store.pending(), [
    { scope: "global", path: ["ui", "beerMugs"], value: undefined },
  ]);
  assert(f.store.flush().every((result) => !result.error));
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.global, "utf8")), {
    version: 2,
    ui: { borderLabels: false },
  });
});

test("border labels merge by leaf: workspace false masks global true, omission inherits", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "borderLabels"], true);
  f.store.stage("global", ["ui", "beerMugs"], true);
  assert(f.store.flush().every((result) => !result.error));
  assert.equal(reload(f).effective().ui.borderLabels, true);
  f.store.stage("workspace", ["ui", "borderLabels"], false);
  assert.equal(f.store.effective().ui.borderLabels, false);
  assert.equal(f.store.effective().ui.beerMugs, true, "sibling ui leaves stay independent");
  assert(f.store.flush().every((result) => !result.error));
  const restored = reload(f);
  assert.equal(restored.effective().ui.borderLabels, false);
  assert.equal(restored.effective().ui.beerMugs, true);
  restored.stage("workspace", ["ui", "borderLabels"], undefined);
  assert.equal(restored.get("workspace").ui.borderLabels, undefined);
  assert.equal(restored.effective().ui.borderLabels, true, "pending deletion inherits global");
  assert(restored.flush().every((result) => !result.error));
  assert.deepEqual(JSON.parse(await readFile(restored.paths.workspace, "utf8")), {
    version: 2,
    ui: {},
  });
  assert.equal(reload(f).effective().ui.borderLabels, true, "omitted workspace inherits global");
});

test("border labels toggle live on/off; the initial session scope never stages or writes", async (t) => {
  const f = await fixture(t),
    c = controls(f, [border("on"), border("off")]);
  assert.equal(c.borderLabels.enabled, true);
  await c.ui.open();
  assert.equal(c.borderLabels.enabled, false);
  assert(c.selectPrompts[0].choices.includes(border("on")));
  assert(
    c.selectPrompts[0].choices.some((choice) => choice.startsWith("Beer mugs:")),
    "the sibling appearance row is preserved",
  );
  await c.ui.open();
  assert.equal(c.borderLabels.enabled, true);
  assert(c.selectPrompts[1].choices.includes(border("off")));
  assert.deepEqual(c.borderLabels.calls, [false, true]);
  assert.deepEqual(c.beerMugs.calls, []);
  assert.deepEqual(c.confirmPrompts, [], "appearance toggles need no extra dialog");
  assert(
    c.notifications.every(({ text, level }) => level === "info" && text.includes("session only")),
  );
  assert.deepEqual(f.store.pending(), []);
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const scope of ["global", "workspace"])
  test(`explicit ${scope} scope queues only ui.borderLabels and Save pending now persists it`, async (t) => {
    const f = await fixture(t),
      c = controls(f, ["Change save scope", scope, border("on"), "Save pending now"], [true]);
    await c.ui.open();
    assert.equal(f.store.scope, scope);
    assert.deepEqual(f.store.pending(), [], "scope consent alone copies nothing");
    await c.ui.open();
    assert.equal(c.borderLabels.enabled, false);
    assert.deepEqual(f.store.pending(), [{ scope, path: ["ui", "borderLabels"], value: false }]);
    await assert.rejects(
      readFile(f.store.paths[scope]),
      { code: "ENOENT" },
      "the toggle only queues persistence",
    );
    await c.ui.open();
    assert.deepEqual(JSON.parse(await readFile(f.store.paths[scope], "utf8")), {
      version: 2,
      ui: { borderLabels: false },
    });
    assert.deepEqual(f.store.pending(), []);
    assert.deepEqual(c.beerMugs.calls, [], "the sibling appearance leaf is not staged");
    assert.equal(reload(f).effective().ui.borderLabels, false);
    assert.equal(controls(f).borderLabels.enabled, false, "the helper reads effective defaults");
  });

test("a failed queue keeps the live border-label choice and warns without writing", async (t) => {
  const f = await fixture(t),
    c = controls(f, ["Change save scope", "global", border("on")], [true]);
  await c.ui.open();
  f.store.seal();
  const pending = f.store.pending();
  await c.ui.open();
  assert.equal(c.borderLabels.enabled, false);
  assert.deepEqual(c.borderLabels.calls, [false]);
  assert.deepEqual(f.store.pending(), pending);
  assert(
    c.notifications.some(
      ({ text, level }) =>
        level === "warning" && /live for this session.*defaults were not queued/.test(text),
    ),
  );
  await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
});

test("a global border-label save explains a shadowing workspace override without removing it", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "borderLabels"], false);
  f.store.stage("workspace", ["ui", "borderLabels"], false);
  f.store.stage("workspace", ["approval"], "manual");
  assert(f.store.flush().every((result) => !result.error));
  const workspaceBytes = await readFile(f.store.paths.workspace, "utf8");
  const c = controls(f, ["Change save scope", "global", border("off"), "Save pending now"], [true]);
  assert.equal(c.borderLabels.enabled, false, "the effective workspace leaf seeds the live choice");
  await c.ui.open();
  await c.ui.open();
  assert.deepEqual(f.store.pending(), [
    { scope: "global", path: ["ui", "borderLabels"], value: true },
  ]);
  const notice = c.notifications.find(({ text }) =>
    text.includes("workspace ui.borderLabels override"),
  );
  assert(notice, "the shadow warning names this leaf, not the sibling appearance leaf");
  assert.equal(notice.level, "info");
  assert(notice.text.includes(`Current session: ${border("on")}`));
  assert(
    notice.text.includes(`Next startup after saving pending writes, if any: ${border("off")}`),
  );
  assert(notice.text.includes("takes precedence") && notice.text.includes("not removed"));
  assert(!c.notifications.some(({ text }) => text.includes("workspace ui.beerMugs override")));
  await c.ui.open();
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.global, "utf8")), {
    version: 2,
    ui: { borderLabels: true },
  });
  assert.equal(
    await readFile(f.store.paths.workspace, "utf8"),
    workspaceBytes,
    "global saves never remove workspace overrides",
  );
  assert.equal(c.borderLabels.enabled, true, "saving defaults does not replace the live choice");
  assert.equal(reload(f).effective().ui.borderLabels, false, "the workspace leaf still wins");
});

test("global border-label notices ignore untrusted workspace overrides", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["ui", "borderLabels"], false);
  assert(f.store.flush().every((result) => !result.error));
  f.store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: false,
  });
  const c = controls(f, ["Change save scope", "global", border("off")], [true]);
  await c.ui.open();
  await c.ui.open();
  assert.equal(c.borderLabels.enabled, true);
  assert(!c.notifications.some(({ text }) => text.includes("workspace ui.borderLabels override")));
  assert.deepEqual(f.store.pending(), [
    { scope: "global", path: ["ui", "borderLabels"], value: true },
  ]);
});

test("removing a saved border-label override leaves the live choice and next-start default", async (t) => {
  const f = await fixture(t);
  f.store.stage("workspace", ["ui", "borderLabels"], false);
  f.store.stage("workspace", ["approval"], "manual");
  assert(f.store.flush().every((result) => !result.error));
  const c = controls(
    f,
    [
      "Remove a saved override",
      "workspace",
      JSON.stringify(["ui", "borderLabels"]),
      "Save pending now",
    ],
    [true],
  );
  assert.equal(c.borderLabels.enabled, false);
  await c.ui.open();
  assert.deepEqual(c.borderLabels.calls, [], "removal does not toggle the live appearance");
  assert.equal(c.borderLabels.enabled, false);
  assert.deepEqual(f.store.pending(), [
    { scope: "workspace", path: ["ui", "borderLabels"], value: undefined },
  ]);
  await c.ui.open();
  assert.deepEqual(JSON.parse(await readFile(f.store.paths.workspace, "utf8")), {
    version: 2,
    ui: {},
    approval: "manual",
  });
  assert.equal(reload(f).effective().ui?.borderLabels, undefined);
  assert.equal(
    reload(f).effective().ui?.borderLabels !== false,
    true,
    "next startup falls back to the documented on default",
  );
});

test("unrelated settings actions never toggle or stage border labels", async (t) => {
  const f = await fixture(t);
  for (const action of [
    "Save pending now",
    "Discard pending writes",
    "Show paths and pending changes",
    "Remember current worker settings",
  ]) {
    const c = controls(f, [action]);
    await c.ui.open();
    assert.deepEqual(c.borderLabels.calls, [], action);
    assert.equal(c.borderLabels.enabled, true);
    assert.deepEqual(f.store.pending(), []);
  }
  for (const path of Object.values(f.store.paths))
    await assert.rejects(readFile(path), { code: "ENOENT" });
});
