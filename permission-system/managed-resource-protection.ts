import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { canonicalNormalizePathForComparison, normalizePathForComparison } from "#src/access-intent/path-normalization";
import { posixPathFlavor } from "#src/path/path-flavor";

/** Process-local, deny-only protection for executable policy and credentials.
 * This is not an OS sandbox: it shares upstream's detectable path-effect scope. */
export interface ManagedResourceProtection {
  readonly version: 1;
  readonly writeRoots: readonly string[];
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly string[];
}
export interface ManagedResourceProtectionInput {
  writeRoots: readonly string[];
  readFiles: readonly string[];
  writeFiles?: readonly string[];
}
const key = Symbol.for("pi-alehouse:managed-resource-protection:v1");
const registry = globalThis as unknown as Record<symbol, unknown>;
const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

function aliases(paths: readonly string[]): readonly string[] {
  assert(Array.isArray(paths) && paths.length <= 128, "Invalid protected resource list");
  const result = new Set<string>();
  for (const path of paths) {
    assert(typeof path === "string" && isAbsolute(path) && !path.includes("\0"), "Protected paths must be absolute");
    // The same path language used by AccessPath.matchValues(), including the
    // canonical alias of an existing ancestor for not-yet-created files.
    const lexical = normalizePathForComparison(path, "/", posixPathFlavor);
    const canonical = canonicalNormalizePathForComparison(path, "/", posixPathFlavor);
    assert(lexical && canonical && isAbsolute(lexical) && isAbsolute(canonical), "Invalid protected path alias");
    result.add(lexical); result.add(canonical);
  }
  return Object.freeze([...result].sort());
}
function validate(value: unknown): asserts value is ManagedResourceProtection {
  assert(value && typeof value === "object" && Object.isFrozen(value), "Managed resource protection is missing or mutable");
  const candidate = value as ManagedResourceProtection;
  assert.equal(candidate.version, 1, "Managed resource protection version mismatch");
  for (const paths of [candidate.writeRoots, candidate.readFiles, candidate.writeFiles]) {
    assert(Array.isArray(paths) && Object.isFrozen(paths) && paths.every((path) => typeof path === "string" && isAbsolute(path)), "Invalid protected resource snapshot");
  }
}
export function getManagedResourceProtection(): ManagedResourceProtection | undefined {
  const value = registry[key];
  if (value === undefined) return undefined;
  validate(value);
  return value;
}
export function requireManagedResourceProtection(): ManagedResourceProtection {
  const value = getManagedResourceProtection();
  assert(value, "Alehouse resource protection must initialize before permission authority startup");
  return value;
}
export function initializeManagedResourceProtection(input: ManagedResourceProtectionInput): ManagedResourceProtection {
  const requested: ManagedResourceProtection = Object.freeze({ version: 1,
    writeRoots: aliases(input.writeRoots), readFiles: aliases(input.readFiles),
    writeFiles: aliases([...input.readFiles, ...(input.writeFiles ?? [])]),
  });
  const existing = getManagedResourceProtection();
  if (existing) {
    // An internal child may require a subset of the parent's protection, but
    // can neither replace it nor initialize a different, unprotected generation.
    assert(requested.writeRoots.every((path) => existing.writeRoots.some((root) => within(path, root))) &&
      requested.readFiles.every((path) => existing.readFiles.includes(path)) &&
      requested.writeFiles.every((path) => existing.writeFiles.includes(path) || existing.writeRoots.some((root) => within(path, root))),
    "Protected runtime generation changed; start a fresh Pi process");
    return existing;
  }
  Object.defineProperty(registry, key, { value: requested, enumerable: false, configurable: false, writable: false });
  return requested;
}

/** Already-normalized lexical/canonical aliases, never glob patterns or a
 * second Bash parser. A defined pattern is required by upstream path gates. */
export function managedResourceMatch(protection: ManagedResourceProtection | undefined, surface: string, values: readonly string[]): string | undefined {
  if (!protection || (surface !== "path_read" && surface !== "path_write")) return undefined;
  for (const path of values) {
    if (!isAbsolute(path)) continue;
    if (surface === "path_read") {
      if (protection.readFiles.includes(path)) return path;
    } else if (protection.writeFiles.some((file) => within(file, path)) ||
      protection.writeRoots.some((root) => within(path, root) || within(root, path))) {
      // A directory mutation can remove/rename a protected descendant too.
      // Conservatively deny such ancestor effects; sibling paths remain usable.
      return path;
    }
  }
  return undefined;
}
