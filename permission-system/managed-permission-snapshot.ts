// Private synchronous sampling only. Never retain filesystem observations across
// a parser await, gate await, authorizer, human approval or tool execution.
type SampleSpace = string | object;
interface Snapshot {
  readonly owner: string;
  readonly spaces: Map<SampleSpace, Map<string, string>>;
  entries: number;
}
const MAX_SAMPLES = 4096;
const MAX_KEY_CHARS = 8192;
interface SharedScope { current: Snapshot | undefined }
// Jiti moduleCache:false can evaluate this file in independent import graphs.
// Share only the synchronous stack slot, not persistent samples or decisions.
const scopeKey = Symbol.for("pi-alehouse:permission-sampling-scope:v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
if (globals[scopeKey] === undefined) Object.defineProperty(globals, scopeKey, {
  value: Object.freeze({ version: 1, scope: Object.seal({ current: undefined }) }),
  configurable: false, writable: false, enumerable: false,
});
const shared = globals[scopeKey];
if (!shared || typeof shared !== "object" || !Object.isFrozen(shared) ||
    Object.getOwnPropertyDescriptor(shared, "version")?.value !== 1) {
  throw new Error("Permission sampling scope is unavailable");
}
const sharedScope: unknown = Object.getOwnPropertyDescriptor(shared, "scope")?.value;
if (!sharedScope || typeof sharedScope !== "object" || !Object.isSealed(sharedScope) ||
    Object.getOwnPropertyDescriptor(sharedScope, "current")?.writable !== true) {
  throw new Error("Permission sampling scope is unavailable");
}
const scope = sharedScope as SharedScope;
// Different installed/source generations never borrow each other's samples.
// Repeated evaluation of this same module URL shares its current stack scope;
// every invocation still allocates a new snapshot and finally drops it.
const owner = import.meta.url;

/** Only the callback's synchronous prefix is scoped, even if it returns a
 * Promise. finally restores the previous scope BEFORE any continuation runs.
 * Nested/reentrant producers own independent samples. No decisions are cached. */
export function withSynchronousPermissionSnapshot<T>(read: () => T): T {
  const previous = scope.current;
  scope.current = { owner, spaces: new Map(), entries: 0 };
  try { return read(); }
  finally { scope.current = previous; }
}

/** Separate spaces keep stamps, workspace bindings and path flavors distinct.
 * Path callers must supply an already-absolute lexical key; flavor objects
 * separate canonicalization algorithms. Exceptions are never memoized. */
export function synchronousPermissionSample(space: SampleSpace, key: string, read: () => string): string {
  const snapshot = scope.current;
  if (!snapshot || snapshot.owner !== owner || key.length > MAX_KEY_CHARS) return read();
  let values = snapshot.spaces.get(space);
  const cached = values?.get(key);
  if (cached !== undefined) return cached;
  const value = read();
  if (snapshot.entries < MAX_SAMPLES) {
    if (!values) { values = new Map(); snapshot.spaces.set(space, values); }
    values.set(key, value);
    snapshot.entries += 1;
  }
  return value;
}
