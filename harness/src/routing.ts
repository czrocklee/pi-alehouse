import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { HarnessError } from "./core/ports.js";
import { validDifficulty, type Difficulty } from "./core/contracts.js";

export const strengths = ["light", "standard", "strong"] as const;
export type Strength = (typeof strengths)[number];
// Task ratings are the caller contract; preset slots remain an internal route.
const difficultySlots = ["light", "light", "standard", "strong", "strong"] as const;
export const invalidDifficultyResolution = "Use an integer from 1 to 5 to rate the task difficulty.";
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ThinkingMap = Partial<Record<ThinkingLevel, ThinkingLevel>>;
export type Effort = ThinkingLevel | "inherit";
export type EffortOverrides = Partial<Record<Strength, Effort>>;
/** Session overrides are a closed, plain record; explicit undefined is not an omission. */
export function validEffortOverrides(value: unknown): value is EffortOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !strengths.includes(key as Strength)) return false;
    const member = Object.getOwnPropertyDescriptor(value, key);
    // Accessors can return one valid value during validation and a different
    // one when copied into an audited selection; overrides must be data only.
    return member?.enumerable === true && Object.hasOwn(member, "value") &&
      (member.value === "inherit" || thinkingLevels.includes(member.value as ThinkingLevel));
  });
}
const CONFIG_VERSION = 2;
const MAX_CONFIG_BYTES = 256 * 1024;
const RESERVED_NAMES = new Set(["off", "reload"]);

export interface PresetSnapshot {
  name: string;
  version: string;
  models: Record<Strength, string>;
  /** Explicit compatibility policy, consulted only when exact inherited
   * thinking is unsupported by the selected model. */
  thinking: Record<Strength, ThinkingMap>;
  /** Effective per-slot effort, including session-specific overrides. */
  effort: Record<Strength, Effort>;
  effort_defaults: Record<Strength, Effort>;
  effort_overrides: EffortOverrides;
  digest: string;
}

/** Built-in selection that disables admission for new worker work. It is not a
 * routing profile: it deliberately has no model slots or thinking policy. */
export interface OffPresetSnapshot {
  name: "off";
  version: "off-v1";
  digest: string;
}

export type PresetSelection = PresetSnapshot | OffPresetSnapshot;

export function isOffPreset(selection: PresetSelection): selection is OffPresetSnapshot {
  return selection.name === "off";
}

/** An immutable, uncommitted disk read. Its catalogue is kept private in this
 * module so callers can only atomically commit it through the originating
 * router. revision prevents an old async picker from overwriting a newer
 * selection. */
export interface PresetCandidate {
  readonly revision: number;
  readonly activeName: string;
  readonly names: readonly string[];
}

type PresetBody = { version: string; models: Record<Strength, string>; thinking?: Partial<Record<Strength, ThinkingMap>>;
  effort?: EffortOverrides };
type PresetConfig = { defaultPreset: string; presets: Record<string, PresetBody> };
type CandidateData = { owner: object; presets: Map<string, PresetSnapshot> };
const candidateData = new WeakMap<PresetCandidate, CandidateData>();

/** Every model route comes from configuration; its version makes reloads
 * visible without special-casing any operator-chosen preset name. */
export function presetLabel(preset: { name: string; version: string; effort_overrides?: EffortOverrides }): string {
  const label = preset.name === "off" ? preset.name : `${preset.name}@${preset.version}`;
  return label + (preset.effort_overrides && Object.keys(preset.effort_overrides).length ? "*" : "");
}

const bounded = (value: unknown): string => String(value).slice(0, 512);
const fail = (message: string): never => { throw new HarnessError("INVALID_PRESET_CONFIG", { error: bounded(message) }); };
const validName = (value: unknown): boolean =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const validVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const validModel = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], at: string): void => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) fail(`${at} has unsupported field: ${extra}`);
};
const canonical = (name: string, body: PresetBody): PresetSnapshot => {
  const models = Object.fromEntries(strengths.map((strength) => [strength, body.models[strength]])) as Record<Strength, string>;
  const thinking = Object.fromEntries(strengths.map((strength) => [strength,
    Object.fromEntries(thinkingLevels.filter((level) => body.thinking?.[strength]?.[level] !== undefined)
      .map((level) => [level, body.thinking![strength]![level]]))])) as Record<Strength, ThinkingMap>;
  const effort_defaults = Object.fromEntries(strengths.map((strength) =>
    [strength, body.effort?.[strength] ?? "inherit"])) as Record<Strength, Effort>;
  return withOverrides({ name, version: body.version, models, thinking, effort_defaults }, {});
};
const withOverrides = (base: Omit<PresetSnapshot, "effort" | "effort_overrides" | "digest">,
  overrides: EffortOverrides): PresetSnapshot => {
  const effort_overrides = Object.fromEntries(strengths.filter((strength) => Object.hasOwn(overrides, strength))
    .map((strength) => [strength, overrides[strength]])) as EffortOverrides;
  const effort = Object.fromEntries(strengths.map((strength) =>
    [strength, effort_overrides[strength] ?? base.effort_defaults[strength]])) as Record<Strength, Effort>;
  const selection = { name: base.name, version: base.version, models: base.models, thinking: base.thinking,
    effort_defaults: base.effort_defaults, effort, effort_overrides };
  return { ...selection, digest: createHash("sha256").update(JSON.stringify({ ...selection, difficultySlots })).digest("hex") };
};
const snapshotFor = (base: PresetSnapshot, overrides: EffortOverrides = {}): PresetSnapshot =>
  withOverrides(base, overrides);
const frozenSnapshot = (snapshot: PresetSnapshot): PresetSnapshot => {
  Object.freeze(snapshot.models);
  for (const strength of strengths) Object.freeze(snapshot.thinking[strength]);
  Object.freeze(snapshot.thinking);
  Object.freeze(snapshot.effort);
  Object.freeze(snapshot.effort_defaults);
  Object.freeze(snapshot.effort_overrides);
  return Object.freeze(snapshot);
};
const catalogue = (presets: Record<string, PresetBody>): Map<string, PresetSnapshot> =>
  new Map(Object.entries(presets).map(([name, body]) => [name, canonical(name, body)]));
const offSelection: OffPresetSnapshot = Object.freeze({ name: "off" as const, version: "off-v1" as const,
  digest: createHash("sha256").update(JSON.stringify({ name: "off", version: "off-v1" })).digest("hex") });
const orderedNames = (presets: ReadonlyMap<string, PresetSnapshot>): string[] => ["off", ...[...presets.keys()].sort()];
const missing = (name: string, names: readonly string[]): HarnessError => new HarnessError("PRESET_NOT_FOUND", {
  requested: bounded(name), allowed: names.slice(0, 32), ...(names.length > 32 ? { allowed_omitted: names.length - 32 } : {}),
});

function parsePresetConfig(path: string): PresetConfig {
  let raw: unknown;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail(`Config must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    fail(`Could not parse ${path}: ${bounded(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Top level must be an object");
  const root = raw as Record<string, unknown>;
  exactKeys(root, ["version", "defaultPreset", "presets"], "Top level");
  if (root.version !== CONFIG_VERSION) fail(`version must be ${CONFIG_VERSION}; provide the full preset catalogue and defaultPreset (version 1 additive configs must be migrated)`);
  if (!root.presets || typeof root.presets !== "object" || Array.isArray(root.presets)) fail("presets must be an object");
  const parsed: Record<string, PresetBody> = {};
  for (const [name, value] of Object.entries(root.presets as Record<string, unknown>)) {
    if (!validName(name)) fail(`Invalid preset name: ${name}`);
    if (RESERVED_NAMES.has(name)) fail(`Preset name is reserved: ${name}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Preset ${name} must be an object`);
    const body = value as Record<string, unknown>;
    exactKeys(body, ["version", "models", "thinking", "effort"], `Preset ${name}`);
    if (!validVersion(body.version)) fail(`Preset ${name}.version must be a non-empty string of at most 64 characters`);
    if (!body.models || typeof body.models !== "object" || Array.isArray(body.models)) fail(`Preset ${name}.models must be an object`);
    const models = body.models as Record<string, unknown>;
    exactKeys(models, strengths, `Preset ${name}.models`);
    for (const strength of strengths) if (!validModel(models[strength]))
      fail(`Preset ${name}.models.${strength} must be an exact provider/model ID`);
    let thinking: Partial<Record<Strength, ThinkingMap>> | undefined;
    if (body.thinking !== undefined) {
      if (!body.thinking || typeof body.thinking !== "object" || Array.isArray(body.thinking))
        fail(`Preset ${name}.thinking must be an object`);
      const slots = body.thinking as Record<string, unknown>;
      exactKeys(slots, strengths, `Preset ${name}.thinking`);
      thinking = {};
      for (const [strength, value] of Object.entries(slots)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          fail(`Preset ${name}.thinking.${strength} must be an object`);
        const mapping = value as Record<string, unknown>;
        exactKeys(mapping, thinkingLevels, `Preset ${name}.thinking.${strength}`);
        for (const [source, target] of Object.entries(mapping)) {
          if (!thinkingLevels.includes(target as ThinkingLevel))
            fail(`Preset ${name}.thinking.${strength}.${source} must be a Pi thinking level`);
          if (source === "off" && target !== "off")
            fail(`Preset ${name}.thinking.${strength}.off cannot enable thinking`);
        }
        thinking[strength as Strength] = { ...mapping };
      }
    }
    let effort: EffortOverrides | undefined;
    if (body.effort !== undefined) {
      if (!validEffortOverrides(body.effort)) fail(`Preset ${name}.effort must contain only routing slots with Pi thinking levels or inherit`);
      effort = { ...body.effort };
    }
    parsed[name] = { version: body.version as string,
      models: Object.fromEntries(strengths.map((strength) => [strength, models[strength]])) as Record<Strength, string>,
      ...(thinking ? { thinking } : {}), ...(effort ? { effort } : {}) };
  }
  if (typeof root.defaultPreset !== "string" || !validName(root.defaultPreset) ||
    (root.defaultPreset !== "off" && !Object.hasOwn(parsed, root.defaultPreset)))
    return fail("defaultPreset must be 'off' or the name of a configured preset");
  return { defaultPreset: root.defaultPreset, presets: parsed };
}

/** Trusted configuration is the sole model catalogue and startup default. Disk
 * reads are candidates: catalogue and selected name change together only after
 * commit succeeds. Accepted Agents retain their resolved AdmittedAgentConfig in
 * the OwnerController. */
export class PresetRouter {
  private presets: Map<string, PresetSnapshot>;
  private overrides: Map<string, EffortOverrides>;
  private activeName: string;
  private revision = 0;
  private disableRevision = 0;
  private applying = false;

  constructor(readonly configPath: string, overrides: ReadonlyMap<string, EffortOverrides> = new Map()) {
    const config = parsePresetConfig(configPath);
    this.presets = catalogue(config.presets);
    this.activeName = config.defaultPreset;
    this.overrides = new Map();
    for (const [name, slots] of overrides) {
      if (!validName(name) || name === "off" || name === "reload" || !validEffortOverrides(slots))
        fail(`Invalid effort overrides for preset ${bounded(name)}`);
      this.overrides.set(name, { ...slots });
    }
  }

  prepare(): PresetCandidate {
    const presets = catalogue(parsePresetConfig(this.configPath).presets);
    const candidate: PresetCandidate = Object.freeze({ revision: this.revision, activeName: this.activeName,
      names: Object.freeze(orderedNames(presets)) });
    candidateData.set(candidate, { owner: this, presets });
    return candidate;
  }

  /** Read-only snapshots for a prepared catalogue. Inspecting never publishes
   * that catalogue or advances its revision; only commit can do either. */
  inspect(candidate: PresetCandidate): readonly PresetSelection[] {
    const data = candidateData.get(candidate);
    if (!data || data.owner !== this) throw new HarnessError("INVALID_PRESET_CANDIDATE");
    return Object.freeze(candidate.names.map((name) => {
      if (name === "off") return offSelection;
      const snapshot = data.presets.get(name);
      if (!snapshot) throw new HarnessError("INVALID_PRESET_CANDIDATE");
      return frozenSnapshot(snapshotFor(structuredClone(snapshot), this.overrides.get(name)));
    }));
  }

  /** Validate the candidate and selection, synchronously run the caller's audit,
   * then publish catalogue/name/revision. The guard prevents an audit callback
   * from re-entering with another selection between validation and publish.
   * An audit throw leaves this router unchanged; the caller owns the shared
   * parent failure policy because SDK append failure can be ambiguous. */
  apply(candidate: PresetCandidate, name: string, audit: (snapshot: PresetSelection) => void,
    overrides?: EffortOverrides): PresetSelection {
    if (this.applying) throw new HarnessError("PRESET_SELECTION_IN_PROGRESS", {
      resolution: "Wait for the current preset selection to finish, then retry.",
    });
    const data = candidateData.get(candidate);
    if (!data || data.owner !== this) throw new HarnessError("INVALID_PRESET_CANDIDATE");
    if (candidate.revision !== this.revision) throw new HarnessError("STALE_PRESET_SELECTION", {
      active: this.activeName, resolution: "Retry the command against the current preset catalogue.",
    });
    if (!validName(name) || (name !== "off" && !data.presets.has(name))) throw missing(name, candidate.names);
    if (overrides !== undefined && (name === "off" || !validEffortOverrides(overrides)))
      fail(name === "off" ? "Off cannot have effort overrides" : `Invalid effort overrides for preset ${bounded(name)}`);
    // Clone before invoking user code: neither a mutated input nor an audit
    // snapshot may change the candidate's eventual published selection.
    const selectedOverrides = overrides === undefined ? this.overrides.get(name) ?? {} : { ...overrides };
    const snapshot: PresetSelection = name === "off" ? offSelection :
      frozenSnapshot(snapshotFor(structuredClone(data.presets.get(name)!), selectedOverrides));
    this.applying = true;
    try { audit(isOffPreset(snapshot) ? snapshot : structuredClone(snapshot)); }
    finally { this.applying = false; }
    const wasEnabled = this.activeName !== "off";
    this.presets = data.presets;
    if (overrides !== undefined) this.overrides.set(name, selectedOverrides);
    this.activeName = name;
    this.revision++;
    if (wasEnabled && name === "off") this.disableRevision++;
    return snapshot;
  }

  /** Core-only convenience for callers with no parent audit contract. The Pi
   * extension uses apply(), never this unaudited commit path. */
  commit(candidate: PresetCandidate, name: string): PresetSelection {
    return this.apply(candidate, name, () => {});
  }

  names(): string[] { return orderedNames(this.presets); }
  activePresetName(): string { return this.activeName; }
  admissionState(): { enabled: boolean; revision: number } {
    return { enabled: this.activeName !== "off", revision: this.disableRevision };
  }
  select(name: string): PresetSelection {
    if (this.applying) throw new HarnessError("PRESET_SELECTION_IN_PROGRESS", {
      resolution: "Wait for the current preset selection to finish, then retry.",
    });
    const names = this.names();
    if (!validName(name) || (name !== "off" && !this.presets.has(name))) throw missing(name, names);
    const wasEnabled = this.activeName !== "off";
    this.activeName = name;
    this.revision++;
    if (wasEnabled && name === "off") this.disableRevision++;
    return this.current();
  }
  current(): PresetSelection {
    if (this.activeName === "off") return offSelection;
    const preset = this.presets.get(this.activeName);
    if (!preset) throw missing(this.activeName, this.names());
    return frozenSnapshot(snapshotFor(structuredClone(preset), this.overrides.get(this.activeName)));
  }
}

export interface ResolvedRoute {
  provider: string;
  model: string;
  /** Actual child thinking passed to Pi. */
  thinking: ThinkingLevel;
  /** Parent Pi thinking captured when this creation request was made. */
  parent_thinking?: ThinkingLevel;
  thinking_resolution: "identity" | "preset_mapping" | "preset_fixed";
  effort_source?: "preset" | "user_override";
  preset: string;
  preset_version: string;
  selection_digest: string;
  difficulty: Difficulty;
  strength: Strength;
}

interface RouteInput<M extends { provider: string; id: string }> {
  preset: PresetSelection;
  parentThinking: string | undefined;
  models: readonly M[];
  supportedThinking: (model: M) => readonly string[];
}

/** The caller supplies a task rating; only this boundary maps it to a slot. */
export function resolveRoute<M extends { provider: string; id: string }>(
  input: RouteInput<M> & { difficulty: number },
): ResolvedRoute {
  if (isOffPreset(input.preset)) throw new HarnessError("WORKERS_DISABLED");
  if (!validDifficulty(input.difficulty))
    throw new HarnessError("INVALID_DIFFICULTY", { key: "difficulty",
      resolution: invalidDifficultyResolution });
  const difficulty = input.difficulty;
  try {
    return { ...resolveSlotRoute({ ...input, strength: difficultySlots[difficulty - 1]! }), difficulty };
  } catch (error) {
    if (error instanceof HarnessError && ["PRESET_MODEL_UNAVAILABLE", "THINKING_INCOMPATIBLE"].includes(error.code))
      throw new HarnessError(error.code, { ...error.details, difficulty });
    throw error;
  }
}

/** Exact-ID lookup for a trusted preset slot, also used by operator previews.
 * No task score is invented. Inherit uses explicit compatibility maps only
 * when identity is unsupported; fixed effort never maps or falls back. */
export function resolveSlotRoute<M extends { provider: string; id: string }>(
  input: RouteInput<M> & { strength: Strength },
): Omit<ResolvedRoute, "difficulty"> {
  if (isOffPreset(input.preset)) throw new HarnessError("WORKERS_DISABLED");
  const strength = input.strength;
  const effort = input.preset.effort[strength];
  const parentValid = typeof input.parentThinking === "string" &&
    thinkingLevels.includes(input.parentThinking as ThinkingLevel);
  if (effort === "inherit" && !parentValid)
    throw new HarnessError("PARENT_THINKING_UNAVAILABLE", {
      error: "Pi did not provide a valid parent thinking level.",
      resolution: "Ask the user to check Pi's thinking setting or restart Pi. Do not change difficulty to bypass configuration errors.",
    });
  const exact = input.preset.models[strength];
  const matches = input.models.filter((model) => `${model.provider}/${model.id}` === exact);
  if (matches.length !== 1) throw new HarnessError("PRESET_MODEL_UNAVAILABLE", {
    preset: input.preset.name, preset_version: input.preset.version,
    resolution: "Ask the user to check the worker preset and model configuration. Do not change difficulty to bypass configuration errors.",
  });
  const incompatible = (reason: string, thinking?: string): never => {
    throw new HarnessError("THINKING_INCOMPATIBLE", { key: "parent_thinking", reason,
      preset: input.preset.name, preset_version: input.preset.version,
      parent_thinking: bounded(input.parentThinking), ...(thinking ? { thinking: bounded(thinking) } : {}),
      resolution: "Ask the user to change the parent Pi thinking level or worker preset. Do not change difficulty to bypass configuration errors.",
    });
  };
  const parent = parentValid ? input.parentThinking as ThinkingLevel : undefined;
  const model = matches[0]!;
  const supported = [...input.supportedThinking(model)];
  const effort_source = Object.hasOwn(input.preset.effort_overrides, strength) ? "user_override" : "preset";
  if (effort !== "inherit") {
    if (!supported.includes(effort)) throw new HarnessError("THINKING_INCOMPATIBLE", {
      reason: "fixed_effort_unsupported",
      preset: input.preset.name, preset_version: input.preset.version,
      resolution: "Ask the user to change the worker preset effort configuration to a level supported by its model. Do not change difficulty to bypass configuration errors.",
    });
    return { provider: model.provider, model: model.id, thinking: effort,
      ...(parent === undefined ? {} : { parent_thinking: parent }), thinking_resolution: "preset_fixed", effort_source,
      preset: input.preset.name, preset_version: input.preset.version,
      selection_digest: input.preset.digest, strength };
  }
  // Inherit keeps identity-first semantics and its explicit compatibility map.
  const inherited = parent!;
  let thinking: ThinkingLevel, thinking_resolution: ResolvedRoute["thinking_resolution"];
  if (supported.includes(inherited)) {
    thinking = inherited;
    thinking_resolution = "identity";
  } else {
    const mapped = input.preset.thinking?.[strength]?.[inherited];
    if (mapped === undefined) return incompatible("identity_unsupported_no_mapping");
    if (inherited === "off" && mapped !== "off") return incompatible("off_mapping_forbidden", mapped);
    if (!thinkingLevels.includes(mapped) || !supported.includes(mapped))
      return incompatible("mapped_target_unsupported", mapped);
    thinking = mapped;
    thinking_resolution = "preset_mapping";
  }
  return { provider: model.provider, model: model.id, thinking, parent_thinking: inherited, thinking_resolution, effort_source,
    preset: input.preset.name, preset_version: input.preset.version,
    selection_digest: input.preset.digest, strength };
}
