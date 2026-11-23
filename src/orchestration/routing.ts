import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { OrchestrationError, delegationOff } from "./core/ports.ts";
import {
  difficultySlots,
  validDifficulty,
  type Difficulty,
  type WorkerSlot,
} from "./core/contracts.ts";
import {
  defaultDelegation,
  delegationModes,
  eagernessLevels,
  type DelegationSetting,
} from "./delegation.ts";
import { validateSettings, type PresetDefinition } from "../shared/settings-store.mjs";

// Task ratings and configured slots have one fixed, one-to-one correspondence.
export const strengths = difficultySlots;
export type Strength = WorkerSlot;
export const invalidDifficultyResolution = "Use an integer from 1 to 5 for reasoning_difficulty.";
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type Effort = ThinkingLevel | "inherit";
/** Reasoning levels a worker slot's selected model accepts. Runtime computes
 * it; the picker only paints it. */
export interface EffortCapabilities {
  levels: readonly ThinkingLevel[];
  inherited?: ThinkingLevel;
  inheritError?: string;
  error?: string;
}
/** Versioned deterministic policy, included in preset selection identity. */
export const inheritedThinkingPolicy = "ceiling-v1";
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
    return (
      member?.enumerable === true &&
      Object.hasOwn(member, "value") &&
      (member.value === "inherit" || thinkingLevels.includes(member.value as ThinkingLevel))
    );
  });
}
const CONFIG_VERSION = 3;
const MAX_CONFIG_BYTES = 256 * 1024;
const RESERVED_NAMES = new Set(["off", "reload"]);

export interface PresetSnapshot {
  name: string;
  version: string;
  models: Record<Strength, string>;
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

/** A successful audited publication plus its no-I/O continuation. */
export interface PresetPublication {
  selection: PresetSelection;
  candidate: PresetCandidate;
}

type PresetBody = PresetDefinition;
type PresetConfig = {
  defaultPreset: string;
  presets: Record<string, PresetBody>;
  delegation: DelegationSetting;
};
type CandidateData = {
  owner: object;
  presets: Map<string, PresetSnapshot>;
  definitions: Record<string, PresetDefinition>;
  restored?: PresetSnapshot;
};
const candidateData = new WeakMap<PresetCandidate, CandidateData>();

/** Include the configured or recorded version without special-casing
 * operator-chosen preset names. */
export function presetLabel(preset: {
  name: string;
  version: string;
  effort_overrides?: EffortOverrides;
}): string {
  const label = preset.name === "off" ? preset.name : `${preset.name}@${preset.version}`;
  return (
    label + (preset.effort_overrides && Object.keys(preset.effort_overrides).length ? "*" : "")
  );
}

const bounded = (value: unknown): string => String(value).slice(0, 512);
const fail = (message: string): never => {
  throw new OrchestrationError("INVALID_PRESET_CONFIG", { error: bounded(message) });
};
const validName = (value: unknown): boolean =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const validEffort = (value: unknown): value is Effort =>
  value === "inherit" || thinkingLevels.includes(value as ThinkingLevel);
const validVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const validModel = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
};
const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) fail(`${at} has unsupported field: ${extra}`);
};
const canonical = (name: string, body: PresetBody): PresetSnapshot => {
  // Normalize slot definitions into the internal runtime projection. Only the
  // nested `slots` shape is accepted on disk or in persisted definitions.
  const models = Object.fromEntries(
    strengths.map((strength) => [strength, body.slots[strength].model]),
  ) as Record<Strength, string>;
  const effort_defaults = Object.fromEntries(
    strengths.map((strength) => [strength, body.slots[strength].effort ?? "inherit"]),
  ) as Record<Strength, Effort>;
  return withOverrides({ name, version: body.version, models, effort_defaults }, {});
};
const withOverrides = (
  base: Omit<PresetSnapshot, "effort" | "effort_overrides" | "digest">,
  overrides: EffortOverrides,
): PresetSnapshot => {
  const effort_overrides = Object.fromEntries(
    strengths
      .filter((strength) => Object.hasOwn(overrides, strength))
      .map((strength) => [strength, overrides[strength]]),
  ) as EffortOverrides;
  const effort = Object.fromEntries(
    strengths.map((strength) => [
      strength,
      effort_overrides[strength] ?? base.effort_defaults[strength],
    ]),
  ) as Record<Strength, Effort>;
  const selection = {
    name: base.name,
    version: base.version,
    models: base.models,
    effort_defaults: base.effort_defaults,
    effort,
    effort_overrides,
  };
  return {
    ...selection,
    digest: createHash("sha256")
      .update(JSON.stringify({ ...selection, difficultySlots, inheritedThinkingPolicy }))
      .digest("hex"),
  };
};
const snapshotFor = (base: PresetSnapshot, overrides: EffortOverrides = {}): PresetSnapshot =>
  withOverrides(base, overrides);
const frozenSnapshot = (snapshot: PresetSnapshot): PresetSnapshot => {
  Object.freeze(snapshot.models);
  Object.freeze(snapshot.effort);
  Object.freeze(snapshot.effort_defaults);
  Object.freeze(snapshot.effort_overrides);
  return Object.freeze(snapshot);
};
/** Decode only the slot-bearing shape published by the router. The caller
 * decides whether a slot-free record is a permitted compact selection. */
export function decodeRecordedPreset(data: Record<string, unknown>): PresetSnapshot | undefined {
  const invalid = (): never => {
    throw new Error("Invalid recorded preset snapshot");
  };
  if (Object.hasOwn(data, "thinking")) invalid();
  if (!["models", "effort_defaults", "effort"].some((key) => Object.hasOwn(data, key)))
    return undefined;
  const read = (record: object, key: string): unknown => {
    const member = Object.getOwnPropertyDescriptor(record, key);
    if (!member?.enumerable || !Object.hasOwn(member, "value")) return invalid();
    return member.value;
  };
  const readSlots = <T>(
    key: string,
    valid: (value: unknown) => value is T,
  ): Record<Strength, T> => {
    const table = read(data, key);
    if (!table || typeof table !== "object" || Array.isArray(table)) return invalid();
    const prototype: unknown = Object.getPrototypeOf(table);
    if (
      (prototype !== null && prototype !== Object.prototype) ||
      Reflect.ownKeys(table).length !== strengths.length
    )
      return invalid();
    return Object.fromEntries(
      strengths.map((slot) => {
        const value = read(table, slot);
        return valid(value) ? [slot, value] : invalid();
      }),
    ) as Record<Strength, T>;
  };
  const name = read(data, "name"),
    version = read(data, "version"),
    overrides = read(data, "effort_overrides");
  if (
    typeof name !== "string" ||
    !validName(name) ||
    RESERVED_NAMES.has(name) ||
    !validVersion(version)
  )
    return invalid();
  if (!validEffortOverrides(overrides)) return invalid();
  const models = readSlots("models", validModel),
    effort_defaults = readSlots("effort_defaults", validEffort),
    effort = readSlots("effort", validEffort);
  const snapshot = withOverrides({ name, version, models, effort_defaults }, overrides);
  if (
    snapshot.digest !== read(data, "digest") ||
    strengths.some((slot) => snapshot.effort[slot] !== effort[slot])
  )
    return invalid();
  return snapshot;
}

const toDefinition = (preset: PresetSnapshot): PresetDefinition => ({
  version: preset.version,
  slots: Object.fromEntries(
    strengths.map((slot) => [
      slot,
      { model: preset.models[slot], effort: preset.effort_defaults[slot] },
    ]),
  ) as PresetDefinition["slots"],
});
const ownDefinition = (
  definitions: Record<string, PresetDefinition>,
  name: string,
): PresetDefinition | undefined =>
  Object.hasOwn(definitions, name) ? definitions[name] : undefined;
const definitionDigest = (
  name: string,
  definition: PresetDefinition | undefined,
): string | undefined => definition && canonical(name, definition).digest;
const catalogue = (presets: Record<string, PresetBody>): Map<string, PresetSnapshot> =>
  new Map(Object.entries(presets).map(([name, body]) => [name, canonical(name, body)]));
const offSelection: OffPresetSnapshot = Object.freeze({
  name: "off" as const,
  version: "off-v1" as const,
  digest: createHash("sha256")
    .update(JSON.stringify({ name: "off", version: "off-v1" }))
    .digest("hex"),
});
const orderedNames = (
  presets: ReadonlyMap<string, PresetSnapshot>,
  restored?: PresetSnapshot,
): string[] => {
  const names = [...presets.keys()];
  if (restored && !presets.has(restored.name)) names.push(restored.name);
  return ["off", ...names.sort()];
};
const missing = (name: string, names: readonly string[]): OrchestrationError =>
  new OrchestrationError("PRESET_NOT_FOUND", {
    requested: bounded(name),
    allowed: names.slice(0, 32),
    ...(names.length > 32 ? { allowed_omitted: names.length - 32 } : {}),
  });

function parsePresetConfig(path: string): PresetConfig {
  let raw: unknown;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
      fail(`Config must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    fail(`Could not parse ${path}: ${bounded(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Top level must be an object");
  const root = raw as Record<string, unknown>;
  exactKeys(
    root,
    ["version", "defaultPreset", "presets", "defaultMode", "defaultEagerness"],
    "Top level",
  );
  if (root.version !== CONFIG_VERSION)
    fail(
      `version must be ${CONFIG_VERSION}; configure all five slots d1–d5 and defaultPreset. Older routing configurations are not supported or converted.`,
    );
  if (!root.presets || typeof root.presets !== "object" || Array.isArray(root.presets))
    fail("presets must be an object");
  const parsed: Record<string, PresetBody> = {};
  for (const [name, value] of Object.entries(root.presets as Record<string, unknown>)) {
    if (!validName(name)) fail(`Invalid preset name: ${name}`);
    if (RESERVED_NAMES.has(name)) fail(`Preset name is reserved: ${name}`);
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(`Preset ${name} must be an object`);
    const body = value as Record<string, unknown>;
    exactKeys(body, ["version", "slots"], `Preset ${name}`);
    if (!validVersion(body.version))
      fail(`Preset ${name}.version must be a non-empty string of at most 64 characters`);
    if (!body.slots || typeof body.slots !== "object" || Array.isArray(body.slots))
      fail(`Preset ${name}.slots must be an object`);
    const slots = body.slots as Record<string, unknown>;
    exactKeys(slots, strengths, `Preset ${name}.slots`);
    const definitions = {} as PresetDefinition["slots"];
    for (const strength of strengths) {
      const value = slots[strength];
      const at = `Preset ${name}.slots.${strength}`;
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${at} must be an object`);
      const slot = value as Record<string, unknown>;
      exactKeys(slot, ["model", "effort"], at);
      if (!validModel(slot.model)) fail(`${at}.model must be an exact provider/model ID`);
      let effort: Effort | undefined;
      if (Object.hasOwn(slot, "effort")) {
        if (!validEffort(slot.effort))
          return fail(`${at}.effort must be a Pi thinking level or inherit`);
        effort = slot.effort;
      }
      definitions[strength] = {
        model: slot.model as string,
        ...(effort === undefined ? {} : { effort }),
      };
    }
    parsed[name] = { version: body.version as string, slots: definitions };
  }
  if (
    typeof root.defaultPreset !== "string" ||
    !validName(root.defaultPreset) ||
    (root.defaultPreset !== "off" && !Object.hasOwn(parsed, root.defaultPreset))
  )
    return fail("defaultPreset must be 'off' or the name of a configured preset");
  // Optional fresh-session delegation defaults; a session's saved choice wins.
  if (
    root.defaultMode !== undefined &&
    !(delegationModes as readonly unknown[]).includes(root.defaultMode)
  )
    fail(`defaultMode must be one of ${delegationModes.join(", ")}`);
  if (
    root.defaultEagerness !== undefined &&
    !(eagernessLevels as readonly unknown[]).includes(root.defaultEagerness)
  )
    fail(`defaultEagerness must be one of ${eagernessLevels.join(", ")}`);
  const delegation = {
    mode: (root.defaultMode ?? defaultDelegation.mode) as DelegationSetting["mode"],
    eagerness: (root.defaultEagerness ??
      defaultDelegation.eagerness) as DelegationSetting["eagerness"],
  };
  return { defaultPreset: root.defaultPreset, presets: parsed, delegation };
}

/** Trusted configuration supplies the model catalogue and startup default. A
 * validated branch snapshot can pin only the active selection. Disk reads are
 * candidates: catalogue and selection change together only after commit.
 * Accepted Agents retain their resolved route in the OwnerController. */
export class PresetRouter {
  private presets: Map<string, PresetSnapshot>;
  private overrides: Map<string, EffortOverrides>;
  private activeName: string;
  private revision = 0;
  private disableRevision = 0;
  private applying = false;
  private appliedCandidate: PresetCandidate | undefined;
  private definitions: Record<string, PresetDefinition>;
  private restored: PresetSnapshot | undefined;
  /** The configured fresh-session delegation, read once at startup. */
  readonly defaultDelegation: Readonly<DelegationSetting>;

  constructor(
    readonly configPath: string,
    overrides: ReadonlyMap<string, EffortOverrides> = new Map(),
    definitions: Readonly<Record<string, PresetDefinition>> = {},
    /** Trusted, canonical selection from branch restoration. */
    restored?: PresetSnapshot,
  ) {
    const config = parsePresetConfig(configPath);
    // Two scoped preference layers plus explicit session-only definitions.
    // Stored files and session records keep their independent one-layer caps.
    this.definitions = validateSettings({ version: 2, presets: definitions }, 3).presets ?? {};
    this.defaultDelegation = Object.freeze(config.delegation);
    this.presets = catalogue({ ...config.presets, ...this.definitions });
    this.restored = restored && frozenSnapshot(structuredClone(restored));
    this.activeName = this.restored?.name ?? config.defaultPreset;
    this.overrides = new Map();
    for (const [name, slots] of overrides) {
      if (!validName(name) || name === "off" || name === "reload" || !validEffortOverrides(slots))
        fail(`Invalid effort overrides for preset ${bounded(name)}`);
      this.overrides.set(name, { ...slots });
    }
    if (this.restored) this.overrides.set(this.restored.name, this.restored.effort_overrides);
  }

  prepare(
    definitions: Readonly<Record<string, PresetDefinition>> = this.definitions,
    { configuredOnly = false }: { configuredOnly?: boolean } = {},
  ): PresetCandidate {
    const checked = validateSettings({ version: 2, presets: definitions }, 3).presets ?? {};
    const presets = catalogue({ ...parsePresetConfig(this.configPath).presets, ...checked });
    const name = this.restored?.name;
    // Use configured definitions on explicit reload/selection or replacement of
    // this definition. Unrelated definitions and effort edits keep the pin.
    const restored =
      !configuredOnly &&
      name !== undefined &&
      definitionDigest(name, ownDefinition(checked, name)) ===
        definitionDigest(name, ownDefinition(this.definitions, name))
        ? this.restored
        : undefined;
    return this.makeCandidate({ owner: this, presets, definitions: checked, restored });
  }

  private makeCandidate(data: CandidateData): PresetCandidate {
    const candidate: PresetCandidate = Object.freeze({
      revision: this.revision,
      activeName: this.activeName,
      names: Object.freeze(orderedNames(data.presets, data.restored)),
    });
    candidateData.set(candidate, data);
    return candidate;
  }

  /** User-defined model presets, never worker permission profiles. */
  customPresets(): Record<string, PresetDefinition> {
    return structuredClone(this.definitions);
  }

  private base(name: string): PresetSnapshot | undefined {
    return this.restored?.name === name ? this.restored : this.presets.get(name);
  }

  definition(name: string): PresetDefinition {
    const preset = this.base(name);
    if (!preset) throw missing(name, this.names());
    return toDefinition(preset);
  }

  /** Return a definition patch only if needed at the chosen save scope.
   * Incremental changes keep following an equivalent inherited definition;
   * an explicit snapshot pins a custom definition in the destination itself. */
  rememberedDefinition(
    name: string,
    {
      target,
      inherited,
      intent = "changes",
    }: {
      target?: PresetDefinition;
      inherited?: PresetDefinition;
      intent?: "changes" | "snapshot";
    } = {},
  ): PresetDefinition | undefined {
    validateSettings({ version: 2, preset: name });
    if (name === "off") return undefined;
    const live = this.base(name);
    if (!live) throw missing(name, this.names());
    const digest = snapshotFor(live).digest;
    const available = target ?? inherited;
    if (available && definitionDigest(name, available) === digest)
      return intent === "snapshot" && !target ? structuredClone(available) : undefined;

    const custom = ownDefinition(this.definitions, name);
    const liveCustom = custom && definitionDigest(name, custom) === digest ? custom : undefined;
    if (!available && !(intent === "snapshot" && liveCustom)) {
      const base = ownDefinition(parsePresetConfig(this.configPath).presets, name);
      if (definitionDigest(name, base) === digest) return undefined;
    }
    if (liveCustom) return structuredClone(liveCustom);
    // The base parser accepts some model/version spellings that the scoped
    // settings schema cannot represent. Fail the save rather than alter them.
    const body = toDefinition(live);
    validateSettings({ version: 2, presets: { [name]: body } });
    return body;
  }

  /** Read-only snapshots for a prepared catalogue. Inspecting never publishes
   * that catalogue or advances its revision; only commit can do either. */
  inspect(candidate: PresetCandidate): readonly PresetSelection[] {
    const data = candidateData.get(candidate);
    if (!data || data.owner !== this) throw new OrchestrationError("INVALID_PRESET_CANDIDATE");
    return Object.freeze(
      candidate.names.map((name) => {
        if (name === "off") return offSelection;
        const snapshot = data.restored?.name === name ? data.restored : data.presets.get(name);
        if (!snapshot) throw new OrchestrationError("INVALID_PRESET_CANDIDATE");
        return frozenSnapshot(snapshotFor(structuredClone(snapshot), this.overrides.get(name)));
      }),
    );
  }

  /** Validate the candidate and selection, synchronously run the caller's audit,
   * then publish catalogue/name/revision. The guard prevents an audit callback
   * from re-entering with another selection between validation and publish.
   * An audit throw leaves this router unchanged; the caller owns the shared
   * parent failure policy because SDK append failure can be ambiguous. */
  apply(
    candidate: PresetCandidate,
    name: string,
    audit: (snapshot: PresetSelection) => void,
    overrides?: EffortOverrides,
  ): PresetSelection {
    if (this.applying)
      throw new OrchestrationError("PRESET_SELECTION_IN_PROGRESS", {
        resolution: "Wait for the current preset selection to finish, then retry.",
      });
    const data = candidateData.get(candidate);
    if (!data || data.owner !== this) throw new OrchestrationError("INVALID_PRESET_CANDIDATE");
    if (candidate.revision !== this.revision)
      throw new OrchestrationError("STALE_PRESET_SELECTION", {
        active: this.activeName,
        resolution: "Retry the command against the current preset catalogue.",
      });
    const restored = data.restored?.name === name ? data.restored : undefined;
    const selected = restored ?? data.presets.get(name);
    if (!validName(name) || (name !== "off" && !selected)) throw missing(name, candidate.names);
    if (overrides !== undefined && (name === "off" || !validEffortOverrides(overrides)))
      fail(
        name === "off"
          ? "Off cannot have effort overrides"
          : `Invalid effort overrides for preset ${bounded(name)}`,
      );
    // Clone before invoking user code: neither a mutated input nor an audit
    // snapshot may change the candidate's eventual published selection.
    const selectedOverrides =
      overrides === undefined ? (this.overrides.get(name) ?? {}) : { ...overrides };
    const snapshot: PresetSelection =
      name === "off"
        ? offSelection
        : frozenSnapshot(snapshotFor(structuredClone(selected!), selectedOverrides));
    this.applying = true;
    try {
      audit(isOffPreset(snapshot) ? snapshot : structuredClone(snapshot));
    } finally {
      this.applying = false;
    }
    const wasEnabled = this.activeName !== "off";
    this.presets = data.presets;
    this.definitions = data.definitions;
    if (overrides !== undefined) this.overrides.set(name, selectedOverrides);
    this.activeName = name;
    this.restored = restored;
    this.appliedCandidate = candidate;
    this.revision++;
    if (wasEnabled && name === "off") this.disableRevision++;
    return snapshot;
  }

  /** Read-only liveness check for an already-acquired candidate; no disk read. */
  isCurrent(candidate: PresetCandidate): boolean {
    return candidateData.get(candidate)?.owner === this && candidate.revision === this.revision;
  }

  /** Continue only the candidate just published by this router, without
   * rereading the catalogue or adopting a concurrent selection's revision. */
  rebase(candidate: PresetCandidate): PresetCandidate {
    const data = candidateData.get(candidate);
    if (!data || data.owner !== this) throw new OrchestrationError("INVALID_PRESET_CANDIDATE");
    if (
      this.appliedCandidate !== candidate ||
      this.revision !== candidate.revision + 1 ||
      this.presets !== data.presets ||
      this.definitions !== data.definitions
    ) {
      throw new OrchestrationError("STALE_PRESET_SELECTION", {
        resolution: "Reopen the panel against the current selection.",
      });
    }
    return this.makeCandidate({ ...data, restored: this.restored });
  }

  /** Core-only convenience for callers with no parent audit contract. The Pi
   * extension uses apply(), never this unaudited commit path. */
  commit(candidate: PresetCandidate, name: string): PresetSelection {
    return this.apply(candidate, name, () => {});
  }

  names(): string[] {
    return orderedNames(this.presets, this.restored);
  }
  activePresetName(): string {
    return this.activeName;
  }
  admissionState(): { enabled: boolean; revision: number } {
    return { enabled: this.activeName !== "off", revision: this.disableRevision };
  }
  select(name: string): PresetSelection {
    if (this.applying)
      throw new OrchestrationError("PRESET_SELECTION_IN_PROGRESS", {
        resolution: "Wait for the current preset selection to finish, then retry.",
      });
    const names = this.names();
    if (!validName(name) || (name !== "off" && !this.base(name))) throw missing(name, names);
    const wasEnabled = this.activeName !== "off";
    if (name !== this.activeName) this.restored = undefined;
    this.activeName = name;
    this.appliedCandidate = undefined;
    this.revision++;
    if (wasEnabled && name === "off") this.disableRevision++;
    return this.current();
  }
  current(): PresetSelection {
    if (this.activeName === "off") return offSelection;
    const preset = this.base(this.activeName);
    if (!preset) throw missing(this.activeName, this.names());
    return frozenSnapshot(
      snapshotFor(structuredClone(preset), this.overrides.get(this.activeName)),
    );
  }
}

export interface ResolvedRoute {
  provider: string;
  model: string;
  /** Actual child thinking passed to Pi. */
  thinking: ThinkingLevel;
  /** Parent Pi thinking captured when this creation request was made. */
  parent_thinking?: ThinkingLevel;
  thinking_resolution: "identity" | "automatic_mapping" | "preset_fixed";
  effort_source?: "preset" | "user_override";
  preset: string;
  preset_version: string;
  selection_digest: string;
  difficulty: Difficulty;
  strength: Strength;
}

const VIRTUAL_WORKER_API = "pi-virtual";
const unavailableResolution =
  "Ask the user to check the worker preset and model configuration. Do not change reasoning_difficulty to bypass configuration errors.";
const virtualWorkerResolution =
  "Ask the user to configure a physical model for this worker preset slot. Virtual models route each request and cannot be pinned to an Agent. Do not change reasoning_difficulty to bypass configuration errors.";

/** Chat-catalogue identity only. Classifier and image catalogues are not workers. */
export type WorkerModelRef = { provider: string; id: string; api?: string };

/** Exact provider/id match that can be pinned to an Agent.
 * A unique virtual catalogue entry is unavailable even when its thinking levels
 * would otherwise match: Pi routes it per request. Missing and ambiguous matches
 * keep the existing unavailable error and are not reclassified as virtual. */
export function selectPhysicalWorkerModel<M extends WorkerModelRef>(
  models: readonly M[],
  exact: string,
  preset: { name: string; version: string },
): M {
  const matches = models.filter((model) => `${model.provider}/${model.id}` === exact);
  if (matches.length !== 1)
    throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE", {
      preset: preset.name,
      preset_version: preset.version,
      resolution: unavailableResolution,
    });
  const model = matches[0]!;
  if (model.api !== VIRTUAL_WORKER_API) return model;
  throw new OrchestrationError("PRESET_MODEL_UNAVAILABLE", {
    reason: "virtual_model",
    model_kind: "virtual",
    preset: preset.name,
    preset_version: preset.version,
    resolution: virtualWorkerResolution,
  });
}

interface RouteInput<M extends WorkerModelRef> {
  preset: PresetSelection;
  parentThinking: string | undefined;
  models: readonly M[];
  supportedThinking: (model: M) => readonly string[];
}

/** The caller supplies a task rating; only this boundary maps it to a slot. */
export function resolveRoute<M extends WorkerModelRef>(
  input: RouteInput<M> & { difficulty: number },
): ResolvedRoute {
  if (isOffPreset(input.preset)) throw delegationOff();
  if (!validDifficulty(input.difficulty))
    throw new OrchestrationError("INVALID_DIFFICULTY", {
      key: "difficulty",
      resolution: invalidDifficultyResolution,
    });
  const difficulty = input.difficulty;
  try {
    return {
      ...resolveSlotRoute({ ...input, strength: difficultySlots[difficulty - 1]! }),
      difficulty,
    };
  } catch (error) {
    if (
      error instanceof OrchestrationError &&
      ["PRESET_MODEL_UNAVAILABLE", "THINKING_INCOMPATIBLE"].includes(error.code)
    )
      throw new OrchestrationError(error.code, { ...error.details, difficulty });
    throw error;
  }
}

/** Exact-ID lookup for a trusted preset slot, also used by operator previews.
 * No task score is invented. Inherit uses the versioned automatic policy only
 * when identity is unsupported; fixed effort never maps or falls back. */
export function resolveSlotRoute<M extends WorkerModelRef>(
  input: RouteInput<M> & { strength: Strength },
): Omit<ResolvedRoute, "difficulty"> {
  if (isOffPreset(input.preset)) throw delegationOff();
  const strength = input.strength;
  const effort = input.preset.effort[strength];
  const parentValid =
    typeof input.parentThinking === "string" &&
    thinkingLevels.includes(input.parentThinking as ThinkingLevel);
  if (effort === "inherit" && !parentValid)
    throw new OrchestrationError("PARENT_THINKING_UNAVAILABLE", {
      error: "Pi did not provide a valid parent thinking level.",
      resolution:
        "Ask the user to check Pi's thinking setting or restart Pi. Do not change reasoning_difficulty to bypass configuration errors.",
    });
  const exact = input.preset.models[strength];
  // Physical check is shared with operator previews. Thinking support is not
  // consulted for a virtual slot, including one that advertises the level.
  const model = selectPhysicalWorkerModel(input.models, exact, input.preset);
  const supported = [...input.supportedThinking(model)];
  const incompatible = (reason: string): never => {
    const resolution =
      reason === "no_supported_thinking_level" && supported.includes("off")
        ? 'Ask the user to set this worker preset slot\'s fixed effort to "off", or change the parent Pi thinking level or worker preset.'
        : "Ask the user to change the parent Pi thinking level or worker preset.";
    throw new OrchestrationError("THINKING_INCOMPATIBLE", {
      key: "parent_thinking",
      reason,
      preset: input.preset.name,
      preset_version: input.preset.version,
      parent_thinking: bounded(input.parentThinking),
      resolution: `${resolution} Do not change reasoning_difficulty to bypass configuration errors.`,
    });
  };
  const parent = parentValid ? (input.parentThinking as ThinkingLevel) : undefined;
  const effort_source = Object.hasOwn(input.preset.effort_overrides, strength)
    ? "user_override"
    : "preset";
  if (effort !== "inherit") {
    if (!supported.includes(effort))
      throw new OrchestrationError("THINKING_INCOMPATIBLE", {
        reason: "fixed_effort_unsupported",
        preset: input.preset.name,
        preset_version: input.preset.version,
        resolution:
          "Ask the user to change the worker preset effort configuration to a level supported by its model. Do not change reasoning_difficulty to bypass configuration errors.",
      });
    return {
      provider: model.provider,
      model: model.id,
      thinking: effort,
      ...(parent === undefined ? {} : { parent_thinking: parent }),
      thinking_resolution: "preset_fixed",
      effort_source,
      preset: input.preset.name,
      preset_version: input.preset.version,
      selection_digest: input.preset.digest,
      strength,
    };
  }
  // Preserve exact support first. Otherwise round enabled thinking upward,
  // capped at the model's highest positive level. SDK order/duplicates/unknown
  // names do not affect this canonical policy. Never cross the off boundary.
  const inherited = parent!;
  let thinking: ThinkingLevel, thinking_resolution: ResolvedRoute["thinking_resolution"];
  if (supported.includes(inherited)) {
    thinking = inherited;
    thinking_resolution = "identity";
  } else {
    if (inherited === "off") return incompatible("off_unsupported");
    const enabled = thinkingLevels.filter((level) => level !== "off" && supported.includes(level));
    const highest = enabled.at(-1);
    if (highest === undefined) return incompatible("no_supported_thinking_level");
    thinking =
      enabled.find((level) => thinkingLevels.indexOf(level) > thinkingLevels.indexOf(inherited)) ??
      highest;
    thinking_resolution = "automatic_mapping";
  }
  return {
    provider: model.provider,
    model: model.id,
    thinking,
    parent_thinking: inherited,
    thinking_resolution,
    effort_source,
    preset: input.preset.name,
    preset_version: input.preset.version,
    selection_digest: input.preset.digest,
    strength,
  };
}
