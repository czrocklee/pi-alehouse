import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { hideParentWebDeclarations } from "../../dist/orchestration/extension.js";

const tool = (name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

test("parent web projection filters every add/remove delta by exact registered name without mutating history", () => {
  const messages = freeze([
    {
      role: "system",
      content: "head",
      sections: { rules: "keep rules" },
      timestamp: 1,
      toolsAdded: [tool("bash"), tool("renamed_search"), tool("web_enable"), tool("web_search")],
    },
    { role: "user", content: "Keep the historical web_search mention.", timestamp: 2 },
    {
      role: "system",
      content: "patch",
      sections: { extra: "keep section", old: null },
      timestamp: 3,
      toolsRemoved: [{ name: "bash" }, { name: "renamed_search" }],
      toolsAdded: [tool("read"), tool("renamed_search")],
    },
    {
      role: "toolResult",
      toolCallId: "historical-call",
      toolName: "renamed_search",
      isError: false,
      content: [{ type: "text", text: "historical result" }],
      timestamp: 4,
    },
    { role: "system", content: "last patch", timestamp: 5, toolsRemoved: [{ name: "web_enable" }] },
  ]);
  const original = structuredClone(messages);
  const projected = hideParentWebDeclarations(messages, ["renamed_search", "web_enable"]);
  assert.deepEqual(
    getCurrentTools(projected).map(({ name }) => name),
    ["web_search", "read"],
  );
  assert.deepEqual(projected[0], {
    ...messages[0],
    toolsAdded: [tool("bash"), tool("web_search")],
  });
  assert.deepEqual(projected[2], {
    ...messages[2],
    toolsRemoved: [{ name: "bash" }],
    toolsAdded: [tool("read")],
  });
  assert.deepEqual(projected[4], { ...messages[4], toolsRemoved: [] });
  assert.equal(projected[1], messages[1], "conversation content is not rewritten");
  assert.equal(projected[3], messages[3], "historical tool results are not erased");
  assert.deepEqual(messages, original, "canonical tool selection and history remain unchanged");
  assert.deepEqual(
    getCurrentTools(messages).map(({ name }) => name),
    ["web_search", "read", "renamed_search"],
  );
});

test("parent web projection preserves a compacted/resumed leading system message even when no declaration remains", () => {
  const messages = freeze([
    {
      role: "system",
      content: "compacted head",
      timestamp: 1,
      toolsAdded: [tool("web_enable")],
      toolsRemoved: [{ name: "renamed_search" }],
      sections: { cwd: "/fixture", rules: "keep" },
    },
    { role: "compactionSummary", summary: "retained summary", timestamp: 2 },
    { role: "system", content: "unrelated patch", timestamp: 3 },
  ]);
  const projected = hideParentWebDeclarations(messages, ["renamed_search", "web_enable"]);
  assert.equal(projected[0].role, "system");
  assert.deepEqual(projected[0], { ...messages[0], toolsAdded: [], toolsRemoved: [] });
  assert.deepEqual(projected.slice(1), messages.slice(1));
  assert.deepEqual(getCurrentTools(projected), []);
});

test("an empty parent web registry preserves every declaration and message field", () => {
  const messages = freeze([
    {
      role: "system",
      content: "head",
      timestamp: 1,
      toolsAdded: [tool("web_search")],
      toolsRemoved: [],
    },
    { role: "custom", customType: "fixture", content: "kept", display: false, timestamp: 2 },
  ]);
  assert.deepEqual(hideParentWebDeclarations(messages, []), messages);
});
