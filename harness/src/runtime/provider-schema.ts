import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Mistral-hosted Z.ai GLM constrains every tool's arguments once any tool in
 * the request is strict (Pi's built-in read/bash/edit/write are) or a call is
 * forced, including tools sent with `strict: false`. The constraint enforces the
 * schema's declared property order and matches `pattern` against the whole
 * string. A model that writes a later-declared argument first can then no
 * longer write any earlier one: it is dropped silently (observed: fetch_content
 * without its URL, web_search without its queries). Open objects admit
 * out-of-order keys, so the wire copy of every non-strict tool is sent open and
 * pattern-free; strict tools are sent as registered. Pi still validates
 * arguments against each tool's registered schema, so no local constraint is
 * relaxed.
 */
const ORDERED_DECODING_APIS: ReadonlySet<string> = new Set(["mistral-conversations"]);

type SchemaRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is SchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_VALUES = ["items", "additionalItems", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedItems"];

/** Structural copy: only schema positions are visited, so a property that is
 * itself named `pattern` (grep's) is kept. */
export function orderFreeSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const out: SchemaRecord = { ...schema };
  delete out.pattern;
  for (const key of SCHEMA_MAPS) {
    const map = out[key];
    if (isRecord(map)) out[key] = Object.fromEntries(Object.entries(map).map(([name, value]) => [name, orderFreeSchema(value)]));
  }
  for (const key of SCHEMA_LISTS) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map(orderFreeSchema);
  }
  for (const key of SCHEMA_VALUES) {
    const value = out[key];
    if (value !== undefined) out[key] = Array.isArray(value) ? value.map(orderFreeSchema) : orderFreeSchema(value);
  }
  if (isRecord(out.properties)) {
    out.additionalProperties = true;
    delete out.unevaluatedProperties;
  } else if (isRecord(out.additionalProperties)) {
    out.additionalProperties = orderFreeSchema(out.additionalProperties);
  }
  return out;
}

/** The payload with order-free non-strict tool schemas, or undefined if unchanged. */
export function orderFreeToolPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return undefined;
  let changed = false;
  const tools = payload.tools.map((tool: unknown) => {
    const fn = isRecord(tool) ? tool.function : undefined;
    if (!isRecord(tool) || !isRecord(fn) || fn.strict === true || !isRecord(fn.parameters)) return tool;
    changed = true;
    return { ...tool, function: { ...fn, parameters: orderFreeSchema(fn.parameters) } };
  });
  return changed ? { ...payload, tools } : undefined;
}

/** Installed in the parent and in every child session. */
export function registerOrderFreeToolSchemas(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const api: unknown = ctx.model?.api;
    return typeof api === "string" && ORDERED_DECODING_APIS.has(api) ? orderFreeToolPayload(event.payload) : undefined;
  });
}

export const orderFreeToolSchemaExtension: ExtensionFactory = registerOrderFreeToolSchemas;
