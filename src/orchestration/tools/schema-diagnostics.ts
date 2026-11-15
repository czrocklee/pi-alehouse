import type { TObject } from "typebox";
import { Errors } from "typebox/value";
import { OrchestrationError } from "../core/ports.ts";
import { QUESTION_ID_PATTERN } from "../core/question-id.ts";

// Parent schemas are closed and static. Turn pinned TypeBox errors into bounded
// model-facing guidance without echoing values or unknown property names.
type SchemaNode = Record<string, unknown>;
type ValidationError = ReturnType<typeof Errors>[number];
type Resolved = { node: SchemaNode; key?: string; schemaPath: string; segments: readonly string[] };
type Details = { key?: string; allowed?: string[]; resolution: string };
type RequiredError = Extract<ValidationError, { keyword: "required" }>;
type TypeViolation = Extract<ValidationError, { keyword: "type" }>;
type EnumError = Extract<ValidationError, { keyword: "enum" }>;
type AdditionalError = Extract<ValidationError, { keyword: "additionalProperties" }>;
type BoundError = Extract<
  ValidationError,
  { keyword: "minItems" | "maxItems" | "minLength" | "maxLength" | "minimum" | "maximum" }
>;

const hasControl = (text: string) =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const SAFE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const INDEX = /^(?:0|[1-9][0-9]?)$/;
const GENERIC =
  "The arguments do not match this tool's schema; check the required fields, their types and bounds.";
const TYPES: Readonly<Record<string, string>> = {
  object: "a JSON object",
  array: "an array",
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  null: "null",
};

const asNode = (value: unknown): SchemaNode | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as SchemaNode) : undefined;
const properties = (node: SchemaNode) => asNode(node.properties);
const safeName = (name: string) =>
  SAFE.test(name) && name !== "constructor" && name !== "prototype";

function allowedOf(values: readonly unknown[], identifiers = false): string[] {
  const allowed: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || hasControl(value)) continue;
    if (identifiers && !safeName(value)) continue;
    allowed.push(value.slice(0, 128));
    if (allowed.length === 32) break;
  }
  return allowed;
}

function resolve(root: SchemaNode, segments: readonly string[]): Resolved | undefined {
  let node = root;
  let schemaPath = "#";
  const key: string[] = [];
  for (const segment of segments) {
    const props = properties(node);
    if (props && safeName(segment) && Object.hasOwn(props, segment)) {
      const child = asNode(props[segment]);
      if (!child) return undefined;
      node = child;
      schemaPath += `/properties/${segment}`;
      key.push(segment);
      continue;
    }
    const child = asNode(node.items);
    if (child && INDEX.test(segment)) {
      node = child;
      schemaPath += "/items";
      key.push(segment);
      continue;
    }
    return undefined;
  }
  const joined = key.join(".");
  if (joined.length > 128 || hasControl(joined)) return undefined;
  return { node, key: joined || undefined, schemaPath, segments };
}

function path(root: SchemaNode, error: ValidationError): Resolved | undefined {
  const segments = error.instancePath === "" ? [] : error.instancePath.slice(1).split("/");
  const resolved = resolve(root, segments);
  return resolved && resolved.schemaPath === error.schemaPath ? resolved : undefined;
}

function actualSize(raw: unknown, segments: readonly string[]): number | undefined {
  try {
    let value: unknown = raw;
    for (const segment of segments) {
      if (!value || typeof value !== "object") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, segment);
      if (!descriptor || !("value" in descriptor)) return undefined;
      value = descriptor.value;
    }
    if (Array.isArray(value)) return value.length;
    if (typeof value === "string") return value.length;
  } catch {
    // A hostile object/proxy cannot make diagnostics throw.
  }
  return undefined;
}

const failure = (details: Details) => new OrchestrationError("INVALID_PARAMETERS", { ...details });
function fallback(root: SchemaNode): OrchestrationError {
  const allowed = allowedOf(Object.keys(properties(root) ?? {}), true);
  return failure({ ...(allowed.length ? { allowed } : {}), resolution: GENERIC });
}

function required(root: SchemaNode, error: RequiredError): OrchestrationError | undefined {
  const resolved = path(root, error);
  const props = resolved && properties(resolved.node);
  if (!resolved || !props) return undefined;
  const field = error.params.requiredProperties.find(
    (name) => safeName(name) && Object.hasOwn(props, name),
  );
  if (!field) return undefined;
  const key = resolved.key ? `${resolved.key}.${field}` : field;
  if (key.length > 128 || hasControl(key)) return undefined;
  const allowed = allowedOf(Object.keys(props), true);
  return failure({
    key,
    ...(allowed.length ? { allowed } : {}),
    resolution: `${key} is required.`,
  });
}

function typeFailure(root: SchemaNode, error: TypeViolation): OrchestrationError | undefined {
  const resolved = path(root, error);
  if (!resolved?.key) return undefined;
  const phrase = typeof error.params.type === "string" ? TYPES[error.params.type] : undefined;
  const resolution = phrase
    ? `${resolved.key} must be ${phrase}.`
    : `${resolved.key} has the wrong type.`;
  return failure({ key: resolved.key, resolution });
}

function enumFailure(root: SchemaNode, error: EnumError): OrchestrationError | undefined {
  const resolved = path(root, error);
  if (!resolved?.key) return undefined;
  const allowed = allowedOf(error.params.allowedValues);
  return failure({
    key: resolved.key,
    ...(allowed.length ? { allowed } : {}),
    resolution: `${resolved.key} must be one of the allowed values.`,
  });
}

function arrayLimitFailure(
  key: string,
  keyword: "minItems" | "maxItems",
  limit: string,
  count?: number,
): OrchestrationError {
  const direction = keyword === "minItems" ? "at least" : "at most";
  const suffix = count === undefined ? "." : `; it has ${count}.`;
  return failure({
    key,
    resolution: `${key} must contain ${direction} ${limit} ${limit === "1" ? "item" : "items"}${suffix}`,
  });
}

/** Failed arguments only: diagnose declared array bounds before TypeBox builds
 * item/duplicate errors. Walk known object fields, never the array elements.
 * This is not a validator or a general CPU bound for arbitrary schemas. */
function arrayBounds(
  root: SchemaNode,
  node: SchemaNode,
  value: unknown,
  segments: readonly string[] = [],
): OrchestrationError | undefined {
  if (node.type === "array" && Array.isArray(value)) {
    for (const keyword of ["maxItems", "minItems"] as const) {
      const limit = node[keyword];
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        !(keyword === "maxItems" ? value.length > limit : value.length < limit)
      )
        continue;
      const key = resolve(root, segments)?.key;
      if (key) return arrayLimitFailure(key, keyword, String(limit), value.length);
    }
    return undefined;
  }
  if (node.type !== "object" || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  for (const [name, child] of Object.entries(properties(node) ?? {})) {
    if (!safeName(name)) continue;
    const schema = asNode(child);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!schema || !descriptor || !("value" in descriptor)) continue;
    const result = arrayBounds(root, schema, descriptor.value, [...segments, name]);
    if (result) return result;
  }
  return undefined;
}

function questionIdFailure(resolved: Resolved): OrchestrationError {
  return failure({
    key: resolved.key,
    resolution: `${resolved.key} must be the exact pending question_id token copied from agent_wait or agent_read (q_ followed by 32 lowercase hex digits).`,
  });
}

function bound(root: SchemaNode, raw: unknown, error: BoundError): OrchestrationError | undefined {
  const resolved = path(root, error);
  if (!resolved?.key) return undefined;
  if (
    (error.keyword === "minLength" || error.keyword === "maxLength") &&
    resolved.node.pattern === QUESTION_ID_PATTERN
  )
    return questionIdFailure(resolved);
  const limit =
    typeof error.params.limit === "number" && Number.isFinite(error.params.limit)
      ? String(error.params.limit)
      : undefined;
  if (limit === undefined) return undefined;
  const key = resolved.key;
  const count = actualSize(raw, resolved.segments);
  const suffix = count === undefined ? "." : `; it has ${count}.`;
  const unit = limit === "1" ? "unit" : "units";
  switch (error.keyword) {
    case "minItems":
    case "maxItems":
      return arrayLimitFailure(key, error.keyword, limit, count);
    case "minLength":
      // TypeBox's approximate grapheme count is not JavaScript .length. In
      // particular, an invalid token can have 34 UTF-16 units and still fail.
      return failure({
        key,
        resolution: `${key} does not meet the schema's minimum string-length requirement of ${limit}.`,
      });
    case "maxLength":
      return failure({
        key,
        resolution: `${key} must be a string of at most ${limit} UTF-16 ${unit}${suffix}`,
      });
    case "minimum":
      return failure({ key, resolution: `${key} must be at least ${limit}.` });
    case "maximum":
      return failure({ key, resolution: `${key} must be at most ${limit}.` });
  }
}

function undeclared(root: SchemaNode, error: AdditionalError): OrchestrationError | undefined {
  const resolved = path(root, error);
  const props = resolved && properties(resolved.node);
  if (!resolved || !props) return undefined;
  const allowed = allowedOf(Object.keys(props), true);
  const resolution = resolved.key
    ? `${resolved.key} contains an undeclared field; use only its declared properties.`
    : "The arguments contain an undeclared field; use only the documented parameters.";
  return failure({
    ...(resolved.key ? { key: resolved.key } : {}),
    ...(allowed.length ? { allowed } : {}),
    resolution,
  });
}

function explain(
  root: SchemaNode,
  raw: unknown,
  error: ValidationError,
): OrchestrationError | undefined {
  switch (error.keyword) {
    case "required":
      return required(root, error);
    case "type":
      return typeFailure(root, error);
    case "enum":
      return enumFailure(root, error);
    case "minItems":
    case "maxItems":
    case "minLength":
    case "maxLength":
    case "minimum":
    case "maximum":
      return bound(root, raw, error);
    case "uniqueItems":
    case "pattern": {
      const resolved = path(root, error);
      if (!resolved?.key) return undefined;
      if (error.keyword === "pattern" && resolved.node.pattern === QUESTION_ID_PATTERN)
        return questionIdFailure(resolved);
      const resolution =
        error.keyword === "pattern"
          ? `${resolved.key} does not match the required format.`
          : `${resolved.key} must not contain duplicate entries.`;
      return failure({ key: resolved.key, resolution });
    }
    case "additionalProperties":
      return undeclared(root, error);
    default:
      return undefined;
  }
}

/** Explain a failed `Check(schema, raw)` with bounded model-facing guidance.
 * Callers keep their valid-path Check and specialized raw checks; this helper
 * runs only after that Check has failed. */
export function parentSchemaFailure(schema: TObject, raw: unknown): OrchestrationError {
  const root = schema as unknown as SchemaNode;
  let errors: ValidationError[];
  try {
    const arrayFailure = arrayBounds(root, root, raw);
    if (arrayFailure) return arrayFailure;
    errors = Errors(schema, raw);
  } catch {
    return fallback(root);
  }
  if (!errors.length) return fallback(root);
  for (const error of errors) {
    // Unmapped errors (including TypeBox's false-subschema companion for extra
    // fields) yield to a later safely interpretable error.
    const result = explain(root, raw, error);
    if (result) return result;
  }
  return fallback(root);
}
