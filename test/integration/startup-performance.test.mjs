// Native module identity/isolation only: no CLI, model, network or approval.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadParentWeb } from "../../dist/orchestration/runtime/parent-web.js";
import { ChildWebModules, nativeWebLoader } from "../../dist/orchestration/runtime/child-web.js";

test("parent native web imports the supplied host values without sharing child module state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-parent-web-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "web");
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const entry = join(directory, "index.js");
  writeFileSync(
    entry,
    `import { marker } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
let calls = 0;
export default function () { return { marker, Text, Type, calls: ++calls,
  compat: () => import("@earendil-works/pi-ai/compat"),
  unsupplied: () => import("@earendil-works/pi-agent-core") }; }
`,
  );
  const marker = {},
    text = {},
    type = {},
    complete = () => {};
  const modules = {
    "@earendil-works/pi-coding-agent": { marker },
    "@earendil-works/pi-tui": { Text: text },
    typebox: { Type: type },
    "@earendil-works/pi-ai/compat": { complete },
  };
  const parent = await loadParentWeb(entry, modules);
  const first = parent.default();
  assert.equal(first.marker, marker);
  assert.equal(first.Text, text);
  assert.equal(first.Type, type);
  assert.equal((await first.compat()).complete, complete);
  await assert.rejects(first.unsupplied(), /pi-agent-core, which Alehouse does not supply/);
  assert.equal(
    (await loadParentWeb(entry, { ...modules })).default,
    parent.default,
    "one stable parent instance",
  );
  const children = new ChildWebModules(entry, nativeWebLoader(modules));
  const a = await children.acquire(),
    b = await children.acquire();
  assert.notEqual(a.factory, parent.default);
  assert.notEqual(b.factory, parent.default);
  assert.notEqual(a.factory, b.factory);
  assert.equal(a.factory().calls, 1);
  assert.equal(b.factory().calls, 1);
  assert.equal(parent.default().calls, 2, "child acquisition never resets parent state");
  a.release();
  const reused = await children.acquire();
  assert.equal(reused.factory, a.factory);
  assert.equal(reused.factory().calls, 2);
  reused.release();
  b.release();
});

test("parent web fails closed when the native entry has no factory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-invalid-parent-web-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "invalid.mjs");
  writeFileSync(entry, "export const notAFactory = true;");
  await assert.rejects(loadParentWeb(entry, {}), /no extension factory/);
});
