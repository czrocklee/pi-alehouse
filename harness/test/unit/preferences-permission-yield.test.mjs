import {
  fixture,
  worker,
  tick,
  runtimeDouble,
  tuiControls,
  waitForPicker,
  heavy,
  chooseNative,
  floating,
  mouseClick,
} from "../support/preferences-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

test("permission yield is rechecked between slot dialogs and before queued model factories", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  let allowed = true;
  const c = tuiControls(f, {
    ...floating,
    registry: [worker, heavy],
    selects: ["inherit"],
    modelSelectionAllowed: () => allowed,
  });
  const editing = c.ui.editPreset("team");
  const light = await waitForPicker(c, 0);
  c.ctx.ui.select = async () => {
    allowed = false;
    return "inherit";
  };
  light.component.render(74);
  light.component.handleInput("\r");
  await editing;
  assert.equal(c.pickers.length, 1, "a permission ask between slots prevents the next selector");
  assert.deepEqual(c.published, []);

  const queued = tuiControls(f, {
    ...floating,
    registry: [worker, heavy],
    deferCustom: true,
    modelSelectionAllowed: () => allowed,
  });
  allowed = true;
  const pending = queued.ui.editModel("team", "d1");
  await tick();
  allowed = false;
  queued.runQueuedFactory();
  await pending;
  assert.deepEqual(queued.selectors, [], "a queued factory cannot mount after permission yield");
  assert.deepEqual(queued.state.refreshCalls, []);
  assert.deepEqual(queued.published, []);
});

test("permission yield cancels a queued model request without mounting or refreshing, and keeps the controls reusable", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  const c = tuiControls(f, { ...floating, registry: [worker, heavy], deferCustom: true });
  const editing = c.ui.editModel("team", "d1");
  await tick();
  c.ui.cancelModelSelection();
  c.runQueuedFactory();
  await editing;
  assert.deepEqual(
    c.selectors,
    [],
    "queued cancellation must not construct a native selector later",
  );
  assert.deepEqual(
    c.state.refreshCalls,
    [],
    "no hidden native refresh can resurrect after permission yield",
  );
  assert(c.pickers.every((entry) => entry.settled && entry.component.render(80).length === 0));
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const nextIndex = c.pickers.length;
  const next = c.ui.editModel("team", "d3");
  c.runQueuedFactory();
  const picker = await waitForPicker(c, nextIndex);
  assert.equal(c.selectors.length, 1, "cancelModelSelection is not dispose");
  picker.component.handleInput("\u001b");
  await next;
  assert.deepEqual(c.published, []);
});

test("permission yield aborts an opened refresh without dirtying; old callbacks cannot cancel a newer request", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  const c = tuiControls(f, {
    ...floating,
    registry: [worker, heavy],
    runtimeDouble: (models) => runtimeDouble({ models: [...models], pending: true }),
  });
  const editing = c.ui.editModel("team", "d1");
  const old = await waitForPicker(c, 0);
  await tick(3);
  assert(c.state.refreshCalls.length >= 1);
  c.ui.cancelModelSelection();
  await editing;
  assert.equal(c.state.refreshCalls[0].signal.aborted, true);
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const next = c.ui.editModel("team", "d3");
  const current = await waitForPicker(c, 1);
  old.component.handleInput("\u001b");
  old.component.handleInput("\r");
  const oldLines = old.component.render(70).map(stripTerminalSequences),
    closeX = oldLines[0]?.indexOf("×");
  if (closeX > 0) mouseClick(old, closeX, 0, 70, oldLines.length);
  await tick(3);
  assert.equal(
    current.settled,
    false,
    "retained old callbacks own neither the new request nor its done callback",
  );
  chooseNative(current, "heavy");
  await next;
  assert.equal(c.published.length, 1);
  assert.equal(c.published[0].definition.slots.d3.model, "fixture/heavy");
  assert.equal(c.published[0].definition.slots.d1.model, "fixture/worker");
  assert.deepEqual(f.store.pending(), []);
});
