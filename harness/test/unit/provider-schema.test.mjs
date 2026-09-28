import assert from "node:assert/strict";
import test from "node:test";
import { orderFreeSchema, orderFreeToolPayload, orderFreeToolSchemaExtension } from "../../dist/runtime/provider-schema.js";

const fetchSchema = {
  type: "object", additionalProperties: false,
  properties: {
    url: { type: "string", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://\\S+$" },
    urls: { type: "array", items: { type: "string", pattern: "^https://" } },
    mode: { type: "string", enum: ["readable", "raw"] },
  },
};
const grepSchema = { type: "object", required: ["pattern"], properties: { pattern: { type: "string" }, path: { type: "string" } } };
const editSchema = {
  type: "object", required: ["path", "edits"],
  properties: {
    path: { type: "string" },
    edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["oldText", "newText"],
      properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
  },
};
const tool = (name, parameters, strict = false) => ({ type: "function", function: { name, description: name, parameters, strict } });

test("non-strict wire schemas admit any property order and carry no whole-string patterns", () => {
  const out = orderFreeSchema(fetchSchema);
  assert.equal(out.additionalProperties, true);
  assert.deepEqual(Object.keys(out.properties), ["url", "urls", "mode"], "declared properties and their types are kept");
  assert.equal(out.properties.url.pattern, undefined);
  assert.equal(out.properties.urls.items.pattern, undefined);
  assert.deepEqual(out.properties.urls.items, { type: "string" });
  assert.deepEqual(out.properties.mode.enum, ["readable", "raw"]);
  const edit = orderFreeSchema(editSchema);
  assert.equal(edit.additionalProperties, true);
  assert.equal(edit.properties.edits.items.additionalProperties, true, "nested objects are opened too");
  assert.deepEqual(edit.required, ["path", "edits"]);
  const grep = orderFreeSchema(grepSchema);
  assert.deepEqual(grep.properties.pattern, { type: "string" }, "a property named pattern is not a pattern keyword");
  assert.deepEqual(orderFreeSchema({ anyOf: [{ type: "string", pattern: "^x" }, { type: "boolean" }] }), { anyOf: [{ type: "string" }, { type: "boolean" }] });
  assert.deepEqual(orderFreeSchema({ type: "object", additionalProperties: { type: "string", pattern: "^x" } }),
    { type: "object", additionalProperties: { type: "string" } }, "map schemas keep their value type");
});

test("only non-strict tools change, and neither the payload nor its schemas are mutated", () => {
  const strict = { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"] };
  const payload = { model: "zai-glm-5-3", stream: true, tools: [tool("fetch_content", fetchSchema), tool("strict_tool", strict, true)] };
  const before = structuredClone(payload);
  const out = orderFreeToolPayload(payload);
  assert.deepEqual(payload, before);
  assert.equal(out.model, "zai-glm-5-3");
  assert.equal(out.tools[0].function.parameters.additionalProperties, true);
  assert.equal(out.tools[0].function.strict, false);
  assert.equal(out.tools[1], payload.tools[1], "strict tools are sent as registered");
  assert.equal(orderFreeToolPayload({ model: "m", tools: [tool("s", strict, true)] }), undefined);
  assert.equal(orderFreeToolPayload({ model: "m" }), undefined);
  assert.equal(orderFreeToolPayload(undefined), undefined);
});

test("the extension rewrites only Mistral chat requests", async () => {
  const handlers = [];
  await orderFreeToolSchemaExtension({ on: (event, handler) => handlers.push([event, handler]) });
  assert.deepEqual(handlers.map(([event]) => event), ["before_provider_request"]);
  const [, handler] = handlers[0];
  const payload = { model: "zai-glm-5-3", tools: [tool("fetch_content", fetchSchema)] };
  const event = { type: "before_provider_request", payload };
  assert.equal(handler(event, { model: { api: "mistral-conversations" } }).tools[0].function.parameters.additionalProperties, true);
  for (const api of ["openai-completions", "anthropic-messages", undefined]) {
    assert.equal(handler(event, { model: api ? { api } : undefined }), undefined, String(api));
  }
});
