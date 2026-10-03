import {
  accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";

/** @typedef {"session" | "global" | "workspace"} SettingsScope */
/** @typedef {Exclude<SettingsScope, "session">} PersistentScope */
/** @typedef {"manual" | "judge" | "judge+sub" | "yolo"} ApprovalPreference */
/** @typedef {"light" | "standard" | "strong"} Slot */
/** @typedef {"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} ThinkingLevel */
/** @typedef {ThinkingLevel | "inherit"} Effort */
/** @typedef {Record<string, Partial<Record<Slot, Effort | null>>>} EffortPolicy */
/** @typedef {{version: string, models: Record<Slot, string>, effort?: Partial<Record<Slot, Effort>>,
 * thinking?: Partial<Record<Slot, Partial<Record<ThinkingLevel, ThinkingLevel>>>>}} PresetDefinition */
/** @typedef {{version: 1, preset?: string, delegation?: {mode?: "manual" | "co-worker" | "lead" | "supervisor",
 * eagerness?: "reserved" | "balanced" | "eager"}, effort?: EffortPolicy, approval?: ApprovalPreference,
 * presets?: Record<string, PresetDefinition>}} SettingsDocument */
/** @typedef {{scope: PersistentScope, path: string[], value: unknown}} Patch */
/** @typedef {{scope: PersistentScope, path: string, error?: string}} FlushResult */
/** @typedef {import("node:fs").Stats} Stat */
/** @typedef {{path: string, fd: number, stat: Stat}} OwnedFile */
/** @typedef {{document: SettingsDocument, stat?: Stat}} LayerRead */

const MAX_BYTES = 256 * 1024;
const slots = ["light", "standard", "strong"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const efforts = [...thinkingLevels, "inherit"];
const persistentScopes = /** @type {const} */ (["global", "workspace"]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const registryKey = Symbol.for("pi-alehouse:settings-stores:v1");

class SettingsError extends Error {}
/** @param {string} message @returns {never} */
function invalid(message) { throw new SettingsError(`Invalid settings: ${message}`); }
/** @param {unknown} error */
function errorCode(error) {
  const code = /** @type {{code?: unknown} | null} */ (error)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "IO_ERROR";
}
/** Do not expose JSON parser messages or foreign error contents.
 * @param {unknown} error */
function safeError(error) {
  return error instanceof SettingsError ? error.message : `Filesystem operation failed (${errorCode(error)})`;
}
/** @param {unknown} value @param {string} at @returns {Record<string, unknown>} */
function record(value, at) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${at} must be a plain record`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${at} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || unsafeKeys.has(key)) invalid(`${at} has an unsafe key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid(`${at} must contain enumerable data only`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} at */
function exactKeys(value, allowed, at) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${at} has an unsupported field`);
}
/** @param {unknown} value @param {readonly string[]} allowed @param {string} at */
function enumeration(value, allowed, at) {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(`${at} has an unsupported value`);
  return value;
}
/** @param {unknown} value @param {boolean} definition */
function validName(value, definition) {
  return typeof value === "string" && namePattern.test(value) && !unsafeKeys.has(value) &&
    value !== "reload" && (!definition || value !== "off");
}
/** @param {unknown} value */
function validModel(value) {
  // Exact, bounded provider/model spelling, including nested physical model IDs.
  // Registry availability and physical-vs-virtual API checks belong to the consumer.
  return typeof value === "string" && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s\p{C}*?]+$/u.test(value);
}

/** Validate a closed version-1 document without invoking accessors or SDK code.
 * Returns a detached, JSON-safe clone; errors never include rejected values.
 * Each stored document is capped at 256 KiB. Trusted in-memory merges may
 * contain two preference layers, or those plus one session-definition layer.
 * @param {unknown} value @param {1 | 2 | 3} [layers] @returns {SettingsDocument} */
export function validateSettings(value, layers = 1) {
  if (layers !== 1 && layers !== 2 && layers !== 3) invalid("validation layers must be 1, 2 or 3");
  const root = record(value, "document");
  exactKeys(root, ["version", "preset", "delegation", "effort", "approval", "presets"], "document");
  if (!Object.hasOwn(root, "version") || root.version !== 1) invalid("version must be 1");
  if (Object.hasOwn(root, "preset") && !validName(root.preset, false)) invalid("preset must be a routing name (or off)");
  if (Object.hasOwn(root, "approval")) enumeration(root.approval, ["manual", "judge", "judge+sub", "yolo"], "approval");
  if (Object.hasOwn(root, "delegation")) {
    const delegation = record(root.delegation, "delegation");
    exactKeys(delegation, ["mode", "eagerness"], "delegation");
    if (Object.hasOwn(delegation, "mode")) enumeration(delegation.mode, ["manual", "co-worker", "lead", "supervisor"], "delegation.mode");
    if (Object.hasOwn(delegation, "eagerness")) enumeration(delegation.eagerness, ["reserved", "balanced", "eager"], "delegation.eagerness");
  }
  if (Object.hasOwn(root, "effort")) {
    for (const [name, body] of Object.entries(record(root.effort, "effort"))) {
      if (!validName(name, true)) invalid("effort has an invalid or reserved preset name");
      const policy = record(body, "effort entry");
      exactKeys(policy, slots, "effort entry");
      for (const level of Object.values(policy)) if (level !== null) enumeration(level, efforts, "effort slot");
    }
  }
  if (Object.hasOwn(root, "presets")) {
    for (const [name, value] of Object.entries(record(root.presets, "presets"))) {
      if (!validName(name, true)) invalid("presets has an invalid or reserved name");
      const body = record(value, "preset definition");
      exactKeys(body, ["version", "models", "effort", "thinking"], "preset definition");
      if (!Object.hasOwn(body, "version") || typeof body.version !== "string" || body.version.length === 0 || body.version.length > 64 || /\p{C}/u.test(body.version))
        invalid("preset version must be a nonempty string of at most 64 characters without control characters");
      if (!Object.hasOwn(body, "models")) invalid("preset models are required");
      const models = record(body.models, "preset models");
      exactKeys(models, slots, "preset models");
      for (const slot of slots) if (!Object.hasOwn(models, slot) || !validModel(models[slot])) invalid("preset models require exact provider/model IDs of at most 256 characters");
      if (Object.hasOwn(body, "effort")) {
        const policy = record(body.effort, "preset effort");
        exactKeys(policy, slots, "preset effort");
        for (const level of Object.values(policy)) enumeration(level, efforts, "preset effort slot");
      }
      if (Object.hasOwn(body, "thinking")) {
        const maps = record(body.thinking, "preset thinking");
        exactKeys(maps, slots, "preset thinking");
        for (const value of Object.values(maps)) {
          const mapping = record(value, "thinking map");
          exactKeys(mapping, thinkingLevels, "thinking map");
          for (const level of Object.values(mapping)) enumeration(level, thinkingLevels, "thinking target");
          if (Object.hasOwn(mapping, "off") && mapping.off !== "off") invalid("thinking map must not enable thinking from off");
        }
      }
    }
  }
  // All schema depths and string values are bounded above; the final byte cap
  // also bounds map cardinality and accounts for JSON escaping and the newline.
  const serialized = JSON.stringify(root);
  if (Buffer.byteLength(serialized, "utf8") + 1 > MAX_BYTES * layers) invalid(`document exceeds ${MAX_BYTES * layers} bytes`);
  return /** @type {SettingsDocument} */ (JSON.parse(serialized));
}

/** @param {unknown} scope @returns {asserts scope is PersistentScope} */
function persistentScope(scope) {
  if (scope !== "global" && scope !== "workspace") invalid("persistent scope must be global or workspace");
}
/** @param {readonly string[]} path */
function validatePath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.length > 5)
    invalid("patch path must have 1 to 5 safe, bounded string keys");
  const result = [];
  for (let index = 0; index < path.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(path, index);
    const key = descriptor?.value;
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof key !== "string" ||
      key.length === 0 || key.length > 64 || unsafeKeys.has(key))
      invalid("patch path must have 1 to 5 safe, bounded string keys");
    result.push(key);
  }
  return result;
}
/** @param {unknown} document @param {readonly string[]} path @returns {{present: boolean, value: unknown}} */
function leaf(document, path) {
  let value = document;
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return { present: false, value: undefined };
    value = /** @type {Record<string, unknown>} */ (value)[key];
  }
  return { present: true, value };
}
/** Structural equality is key-order independent and distinguishes missing from null.
 * @param {unknown} a @param {unknown} b @returns {boolean} */
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aa = /** @type {Record<string, unknown>} */ (a), bb = /** @type {Record<string, unknown>} */ (b);
  const keys = Object.keys(aa);
  return keys.length === Object.keys(bb).length && keys.every((key) => Object.hasOwn(bb, key) && equal(aa[key], bb[key]));
}
/** @param {readonly string[]} a @param {readonly string[]} b */
function prefix(a, b) { return a.length <= b.length && a.every((key, index) => key === b[index]); }
/** Apply only an explicit patch, not an effective/defaulted document.
 * @param {Record<string, unknown>} document @param {readonly string[]} path @param {unknown} value */
function applyPatch(document, path, value) {
  let target = document;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(target, key)) {
      if (value === undefined) return;
      target[key] = {};
    }
    target = record(target[key], "patch parent");
  }
  const key = /** @type {string} */ (path.at(-1));
  if (value === undefined) delete target[key];
  else target[key] = value;
}
/** @param {SettingsDocument} baseline @param {readonly Patch[]} patches */
function patched(baseline, patches) {
  const result = /** @type {Record<string, unknown>} */ (structuredClone(baseline));
  for (const patch of patches) applyPatch(result, patch.path, patch.value);
  return validateSettings(result);
}

/** @param {Stat} a @param {Stat} b */
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
/** @param {Stat} a @param {Stat} b */
function sameFile(a, b) {
  return sameIdentity(a, b) && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
/** @param {string} path @returns {Stat | undefined} */
function optionalStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}
/** Safe symlink reads are allowed; nonblocking open prevents FIFO hangs. No
 * synchronous filesystem call here has a hard wall-clock timeout.
 * @param {string} path @param {boolean} [writing] @returns {LayerRead} */
function readLayer(path, writing = false) {
  let fd;
  try {
    const before = optionalStat(path);
    if (!before) return { document: { version: 1 } };
    if (writing) writableTarget(path, before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (writing ? constants.O_NOFOLLOW : 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new SettingsError(`Config must be a regular file no larger than ${MAX_BYTES} bytes`);
    if (writing && !sameFile(before, stat)) throw new SettingsError("Config identity changed while opening; retry after inspecting it");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new SettingsError(`Config exceeds ${MAX_BYTES} bytes`);
    if (!sameFile(stat, fstatSync(fd))) throw new SettingsError("Config changed while reading; retry after inspecting it");
    let raw;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new SettingsError("Config is not valid UTF-8 JSON; repair it before retrying"); }
    return { document: validateSettings(raw), stat };
  } catch (error) {
    throw new SettingsError(`Cannot read settings at ${path}: ${safeError(error)}. Repair the config or its permissions before retrying.`);
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** @param {string} path @param {Stat} stat */
function writableTarget(path, stat) {
  if (stat.isSymbolicLink()) throw new SettingsError("Refusing to replace a symlink (including Nix-managed configs)");
  if (!stat.isFile()) throw new SettingsError("Write target must be a regular file");
  if (stat.nlink !== 1) throw new SettingsError("Refusing to replace a multiply-linked config");
  if ((stat.mode & 0o222) === 0) throw new SettingsError("Config is readonly; do not replace a managed file");
  accessSync(path, constants.W_OK);
}
/** @param {string} path @returns {Map<string, Stat>} */
function prepareParents(path) {
  if (path === "/nix/store" || path.startsWith(`/nix/store${sep}`)) throw new SettingsError("Refusing to write inside the Nix store");
  const parent = dirname(path), root = parse(parent).root;
  const parents = new Map();
  let current = root;
  for (const part of ["", ...parent.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    let stat = optionalStat(current);
    if (!stat) {
      const previous = /** @type {Stat} */ (parents.get(dirname(current)));
      if ((previous.mode & 0o222) === 0) throw new SettingsError("Parent directory is readonly");
      checkParents(parents);
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SettingsError("Write parents must be real directories, not symlinks");
    parents.set(current, stat);
  }
  const stat = /** @type {Stat} */ (parents.get(parent));
  if ((stat.mode & 0o222) === 0) throw new SettingsError("Settings directory is readonly");
  accessSync(parent, constants.W_OK);
  return parents;
}
/** @param {Map<string, Stat>} parents */
function checkParents(parents) {
  for (const [path, before] of parents) {
    const now = lstatSync(path);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameIdentity(before, now) || before.mode !== now.mode)
      throw new SettingsError("Write parent identity or permissions changed; inspect before retrying");
  }
}
/** @param {string} path @returns {OwnedFile} */
function createOwned(path) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { return { path, fd, stat: fstatSync(fd) }; }
  catch (error) {
    closeSync(fd);
    // Without a captured inode, never unlink a pathname on the assumption it is ours.
    throw new SettingsError(`File ownership unconfirmed at ${path}; retained for inspection (${errorCode(error)})`);
  }
}
/** @param {OwnedFile} owned @param {Map<string, Stat>} parents */
function checkOwned(owned, parents) {
  checkParents(parents);
  const now = lstatSync(owned.path);
  if (!now.isFile() || now.isSymbolicLink() || !sameIdentity(now, owned.stat))
    throw new SettingsError(`File ownership changed at ${owned.path}; retained for inspection`);
}
/** @param {OwnedFile} owned @param {Map<string, Stat>} parents */
function removeOwned(owned, parents) { checkOwned(owned, parents); unlinkSync(owned.path); }
/** @param {string} path @param {Stat | undefined} before @param {Map<string, Stat>} parents */
function recheckTarget(path, before, parents) {
  checkParents(parents);
  const now = optionalStat(path);
  if (now) writableTarget(path, now);
  if (before ? !now || !sameFile(before, now) : !!now)
    throw new SettingsError("Config identity or contents changed before publication; retry after inspecting it");
}

/** Cooperative, exclusive per-target lock; never steals a stale lock. Explicit
 * leaf conflicts reject a whole scope. Atomic rename is not an OS sandbox or
 * protection against a hostile process racing path operations between checks.
 * @param {string} path @param {SettingsDocument} baseline @param {readonly Patch[]} patches */
function commit(path, baseline, patches) {
  const parents = prepareParents(path);
  /** @type {OwnedFile | undefined} */ let lock;
  /** @type {OwnedFile | undefined} */ let temp;
  /** @type {number | undefined} */ let directoryFd;
  /** @type {SettingsDocument | undefined} */ let result;
  /** @type {string | undefined} */ let failure;
  let publicationStarted = false;
  try {
    checkParents(parents);
    try { lock = createOwned(`${path}.lock`); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new SettingsError(`Settings lock busy at ${path}.lock; no stale lock is automatically removed. Inspect the writer before retrying.`);
      throw error;
    }
    fchmodSync(lock.fd, 0o600);
    writeFileSync(lock.fd, `${randomUUID()}\n`, "utf8");
    fsyncSync(lock.fd);
    checkOwned(lock, parents);
    const latest = readLayer(path, true);
    for (const patch of patches) {
      const original = leaf(baseline, patch.path), current = leaf(latest.document, patch.path);
      if (original.present !== current.present || !equal(original.value, current.value))
        throw new SettingsError("Settings conflict on a dirty path; discard pending changes and reopen the store against the current config before retrying. No patches in this scope were published.");
    }
    result = patched(latest.document, patches);
    temp = createOwned(join(dirname(path), `.config.json.${randomUUID()}.tmp`));
    fchmodSync(temp.fd, 0o600);
    writeFileSync(temp.fd, `${JSON.stringify(result)}\n`, "utf8");
    fsyncSync(temp.fd);
    checkOwned(temp, parents);
    checkOwned(lock, parents);
    recheckTarget(path, latest.stat, parents);
    directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameIdentity(fstatSync(directoryFd), /** @type {Stat} */ (parents.get(dirname(path)))))
      throw new SettingsError("Settings directory identity changed before publication");
    // This is the final synchronous identity check, not a hard timeout or a
    // claim that hostile non-cooperating writers cannot race rename().
    recheckTarget(path, latest.stat, parents);
    checkOwned(lock, parents);
    checkOwned(temp, parents);
    publicationStarted = true;
    renameSync(temp.path, path);
    temp.path = path; // Never try to remove the published destination in cleanup.
    fsyncSync(directoryFd);
  } catch (error) {
    failure = safeError(error);
    if (publicationStarted) failure += `; publication/durability is unconfirmed. Lock retained at ${path}.lock for inspection`;
  } finally {
    for (const fd of [temp?.fd, directoryFd, lock?.fd]) {
      if (fd === undefined) continue;
      try { closeSync(fd); }
      catch (error) { failure = `${failure ? `${failure}; ` : ""}Descriptor cleanup failed (${errorCode(error)})`; }
    }
    if (temp && temp.path !== path) {
      try { removeOwned(temp, parents); }
      catch (error) { failure = `${failure ? `${failure}; ` : ""}Temp retained: ${safeError(error)}`; }
    }
    if (lock && !(publicationStarted && failure)) {
      try { removeOwned(lock, parents); }
      catch (error) { failure = `${failure ? `${failure}; ` : ""}Lock retained: ${safeError(error)}`; }
    }
  }
  if (failure) throw new SettingsError(failure);
  return /** @type {SettingsDocument} */ (result);
}

export class SettingsStore {
  /** @type {Readonly<{global: string, workspace: string}>} */ #paths;
  /** @type {SettingsScope} */ #scope = "session";
  /** @type {Record<PersistentScope, SettingsDocument>} */ #layers;
  /** @type {Record<PersistentScope, Patch[]>} */ #patches = { global: [], workspace: [] };
  #trusted;
  #sealed = false;

  /** Reads trusted layers once; construction never creates resources.
   * @param {{agentDir: string, cwd: string, projectTrusted: boolean}} options */
  constructor({ agentDir, cwd, projectTrusted }) {
    for (const path of [agentDir, cwd]) {
      if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0"))
        invalid("agentDir and cwd must be nonempty, bounded filesystem paths");
    }
    if (typeof projectTrusted !== "boolean") invalid("projectTrusted must be a boolean");
    this.#trusted = projectTrusted;
    this.#paths = Object.freeze({
      global: resolve(agentDir, "extensions/pi-alehouse/config.json"),
      workspace: resolve(cwd, ".pi/extensions/pi-alehouse/config.json"),
    });
    this.#layers = {
      global: readLayer(this.#paths.global).document,
      workspace: projectTrusted ? readLayer(this.#paths.workspace).document : { version: 1 },
    };
  }

  get paths() { return this.#paths; }
  get scope() { return this.#scope; }
  canWriteWorkspace() { return this.#trusted; }
  /** @param {SettingsScope} scope */
  setScope(scope) {
    if (this.#sealed) throw new SettingsError("Settings store is sealed after shutdown");
    if (scope !== "session" && scope !== "global" && scope !== "workspace") invalid("scope must be session, global or workspace");
    if (scope === "workspace" && !this.#trusted) throw new SettingsError("Workspace settings require explicit project trust");
    this.#scope = scope;
  }

  /** @param {PersistentScope} scope @param {readonly string[]} path @param {unknown} value */
  stage(scope, path, value) {
    if (this.#sealed) throw new SettingsError("Settings store is sealed after shutdown");
    persistentScope(scope);
    if (scope === "workspace" && !this.#trusted) throw new SettingsError("Workspace settings require explicit project trust");
    path = validatePath(path);
    // Validate before copying any unknown input: JSON.stringify/structuredClone
    // of an accessor or custom prototype must never execute it on our behalf.
    const candidate = /** @type {Record<string, unknown>} */ (this.get(scope));
    applyPatch(candidate, path, value);
    const validated = validateSettings(candidate);
    const existing = this.#patches[scope];
    const ancestor = existing.find((patch) => prefix(patch.path, path));
    const dirtyPath = ancestor?.path ?? [...path];
    const stagedLeaf = leaf(validated, dirtyPath), original = leaf(this.#layers[scope], dirtyPath);
    const remaining = existing.filter((patch) => !prefix(dirtyPath, patch.path));
    if (stagedLeaf.present !== original.present || !equal(stagedLeaf.value, original.value)) {
      remaining.push({ scope, path: [...dirtyPath], value: stagedLeaf.present ? structuredClone(stagedLeaf.value) : undefined });
    }
    this.#patches[scope] = remaining;
  }

  /** @param {PersistentScope} scope @returns {SettingsDocument} */
  get(scope) { persistentScope(scope); return patched(this.#layers[scope], this.#patches[scope]); }

  /** Layer merge only; null effort remains an explicit preset-default mask.
   * @returns {SettingsDocument} */
  effective() {
    const global = this.get("global");
    if (!this.#trusted) return global;
    const workspace = this.get("workspace");
    const result = { ...global, ...workspace };
    if (global.delegation || workspace.delegation) result.delegation = { ...global.delegation, ...workspace.delegation };
    if (global.presets || workspace.presets) result.presets = { ...global.presets, ...workspace.presets };
    if (global.effort || workspace.effort) {
      const effort = structuredClone(global.effort ?? {});
      for (const [name, policy] of Object.entries(workspace.effort ?? {}))
        effort[name] = { ...effort[name], ...policy };
      result.effort = effort;
    }
    return validateSettings(result, 2);
  }

  /** @returns {Patch[]} */
  pending() { return structuredClone([...this.#patches.global, ...this.#patches.workspace]); }
  /** Discard returns to the original in-memory layer, without filesystem IO.
   * @param {PersistentScope} [scope] */
  discard(scope) {
    if (scope !== undefined) { persistentScope(scope); this.#patches[scope] = []; }
    else this.#patches = { global: [], workspace: [] };
  }
  /** Independent synchronous scope attempts; failed patches remain pending.
   * @returns {FlushResult[]} */
  flush() {
    const results = [];
    for (const scope of persistentScopes) {
      if (this.#patches[scope].length === 0) continue;
      const path = this.#paths[scope];
      try {
        if (scope === "workspace" && !this.#trusted) throw new SettingsError("Workspace settings require explicit project trust");
        this.#layers[scope] = commit(path, this.#layers[scope], this.#patches[scope]);
        this.#patches[scope] = [];
        results.push({ scope, path });
      } catch (error) { results.push({ scope, path, error: safeError(error) }); }
    }
    return results;
  }
  seal() { this.#sealed = true; }
}

/** @returns {Map<string, SettingsStore>} */
function registry() {
  const root = /** @type {typeof globalThis & {[registryKey]?: Map<string, SettingsStore>}} */ (globalThis);
  return root[registryKey] ??= new Map();
}
/** Cross-bundle identity, not an SDK/session lifecycle authority.
 * @param {string} sessionId @param {SettingsStore} store @returns {() => void} */
export function registerSettingsStore(sessionId, store) {
  registry().set(sessionId, store);
  return () => { if (registry().get(sessionId) === store) registry().delete(sessionId); };
}
/** @param {string} sessionId @returns {SettingsStore | undefined} */
export function settingsStoreForSession(sessionId) { return registry().get(sessionId); }
