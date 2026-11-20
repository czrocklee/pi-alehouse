import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { registerFastMode } = await jiti.import("../../src/orchestration/runtime/fast-mode.ts");
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
// Pi's interactive mode uses this internal list for built-in command collision
// diagnostics and autocomplete. No session, terminal, or command execution.
const { BUILTIN_SLASH_COMMANDS } = await import(new URL("core/slash-commands.js", sdkEntry));

test("Alehouse /fast does not collide with a pinned Pi built-in slash command", () => {
  const registered = [];
  registerFastMode({
    on() {},
    registerCommand: (name) => registered.push(name),
  });
  assert.deepEqual(registered, ["fast"]);
  const nativeNames = new Set(BUILTIN_SLASH_COMMANDS.map(({ name }) => name));
  assert.equal(nativeNames.has("fast"), false, "Pi now reserves /fast; review the Alehouse name");
});
