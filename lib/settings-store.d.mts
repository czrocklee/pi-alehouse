export type SettingsScope = "session" | "global" | "workspace";
export type PersistentScope = Exclude<SettingsScope, "session">;
export type ApprovalPreference = "manual" | "judge" | "judge+sub" | "yolo";
export type Slot = "d1" | "d2" | "d3" | "d4" | "d5";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Effort = ThinkingLevel | "inherit";
/** null masks lower-layer overrides in favor of the preset's default. */
export type EffortPolicy = Record<string, Partial<Record<Slot, Effort | null>>>;
/** One closed routing slot. Omitted effort is not stored; consumers default it to inherit.
 * Thinking is not configurable on a slot. */
export type PresetSlotDefinition = {
  model: string;
  effort?: Effort;
};
/** External preference preset. Flat models/effort/thinking tables and per-slot thinking are not accepted. */
export type PresetDefinition = {
  version: string;
  slots: Record<Slot, PresetSlotDefinition>;
};
export type SettingsDocument = {
  version: 2;
  preset?: string;
  delegation?: {
    mode?: "manual" | "co-worker" | "lead" | "supervisor";
    eagerness?: "reserved" | "balanced" | "eager";
  };
  effort?: EffortPolicy;
  approval?: ApprovalPreference;
  presets?: Record<string, PresetDefinition>;
};
export type SettingsPatch = { scope: PersistentScope; path: string[]; value: unknown };
export type SettingsFlushResult = { scope: PersistentScope; path: string; error?: string };

/** Closed version-2 schema; rejects version 1, legacy slot keys, retired flat
 * preset models/effort/thinking tables, and per-slot thinking without migration.
 * Empty and slot-free documents remain valid. Detached clone; 256 KiB per stored layer. Two/three layers
 * are only for trusted in-memory preference/routing merges, never file writes. */
export function validateSettings(value: unknown, layers?: 1 | 2 | 3): SettingsDocument;
export class SettingsStore {
  /** Reads only trusted layers; never creates files or directories. */
  constructor(options: { agentDir: string; cwd: string; projectTrusted: boolean });
  get paths(): Readonly<{ global: string; workspace: string }>;
  get scope(): SettingsScope;
  setScope(scope: SettingsScope): void;
  canWriteWorkspace(): boolean;
  /** Explicit path patch of 1 to 5 keys. undefined deletes the key; unchanged values are clean. */
  stage(scope: PersistentScope, path: readonly string[], value: unknown): void;
  get(scope: PersistentScope): SettingsDocument;
  /** Global then trusted workspace; preset bodies replace by name. */
  effective(): SettingsDocument;
  pending(): SettingsPatch[];
  /** In-memory discard only; does not reload disk. */
  discard(scope?: PersistentScope): void;
  /** Synchronous independent commits; failed/uncertain attempts retain pending. */
  flush(): SettingsFlushResult[];
  /** Prevents new scope/stage changes while still permitting a final flush. */
  seal(): void;
}
/** Cross-bundle registry cleanup checks that this exact store is still current. */
export function registerSettingsStore(sessionId: string, store: SettingsStore): () => void;
export function settingsStoreForSession(sessionId: string): SettingsStore | undefined;
