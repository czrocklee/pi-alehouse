import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollStep, restoreFaultedLogs } from "../support/run-lifecycle-support.mjs";

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "p1-fault-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fault = (name) => {
    const file = join(root, name);
    writeFileSync(file + ".before-fault", `${name}\n`); mkdirSync(file);
    return file;
  };
  return { root, fault };
};

test("Lifecycle poll tick yields and does not sample diagnostic state on success", async () => {
  let snapshots = 0;
  const tick = pollStep("ready", () => snapshots++);
  await tick(); assert.equal(snapshots, 0);
});
test("Lifecycle poll deadline reports the phase and last observed state", () => {
  const tick = pollStep("child settled", () => ({ phase: "finalizing" }), 0);
  assert.throws(tick, /P1_POLL_TIMEOUT: child settled; last state: \{"phase":"finalizing"\}/);
});
test("Lifecycle fault restoration does not touch logs without confirmed owner closure", (t) => {
  const { fault } = fixture(t), file = fault("child.jsonl");
  for (const closed of [false, undefined, 1]) {
    assert.deepEqual(restoreFaultedLogs([undefined, file], closed), [{ file, restored: false, skipped: "OWNER_NOT_CLOSED" }]);
    assert(existsSync(file + ".before-fault"));
  }
  assert.deepEqual(restoreFaultedLogs([file], true), [{ file, restored: true }]);
  assert.equal(readFileSync(file, "utf8"), "child.jsonl\n");
});
test("Lifecycle fault restoration after closure attempts both logs despite an error", (t) => {
  const { fault } = fixture(t), first = fault("child.jsonl"), second = fault("parent.jsonl");
  writeFileSync(join(first, "block-restoration"), "fixture obstruction");
  const result = restoreFaultedLogs([first, second], true);
  assert.equal(result[0].restored, false); assert.match(result[0].error, /ENOTEMPTY|EEXIST/);
  assert(existsSync(first + ".before-fault"));
  assert.deepEqual(result[1], { file: second, restored: true });
  assert.equal(readFileSync(second, "utf8"), "parent.jsonl\n");
});
