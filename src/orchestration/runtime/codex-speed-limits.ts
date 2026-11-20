import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type SpeedLimit = "normal" | "fast" | "ultrafast";

export type SpeedLimits = {
  allowsAcceleration: boolean;
  limitFor: (provider: string, modelId: string) => SpeedLimit;
  warning?: string;
};

const CODEX_PROVIDER = /^openai-codex(?:-(?:[2-9]|[1-9]\d+))?$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const FILE_NAME = "alehouse-codex-speeds.json";
const MAX_BYTES = 64 * 1024;
const WARNING =
  "Invalid or unreadable alehouse-codex-speeds.json; Codex Fast and Ultrafast are disabled.";

// Compatibility snapshot: public priority-tier models, excluding internal IDs and GPT-5.4/5.5
// (retired for ChatGPT sign-in). This is not a live catalog or an account entitlement check.
// https://github.com/openai/codex/blob/6c0cee502d215e5df2dd9a303cf2e252229c9e12/codex-rs/models-manager/models.json
const DEFAULT_FAST_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
]);

function validModelId(id: string): boolean {
  return MODEL_ID.test(id) && id !== "prototype" && !Object.hasOwn(Object.prototype, id);
}

function validKey(key: string): boolean {
  const slash = key.indexOf("/");
  return slash === -1
    ? validModelId(key)
    : CODEX_PROVIDER.test(key.slice(0, slash)) && validModelId(key.slice(slash + 1));
}

function readConfig(path: string): string | undefined {
  // Distinguish a missing config from a present but dangling symlink.
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(WARNING);
  // Follow regular-file symlinks (e.g. Home Manager), but never wait on a FIFO.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error(WARNING);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (
      length > MAX_BYTES ||
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(WARNING);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

/** Read a snapshot from the trusted per-user agent directory only. */
export function loadSpeedLimits(agentDir: string): SpeedLimits {
  try {
    if (!isAbsolute(agentDir)) throw new Error(WARNING);
    const config = readConfig(join(agentDir, FILE_NAME));
    if (config === undefined) {
      return {
        allowsAcceleration: true,
        limitFor: (provider, modelId) =>
          CODEX_PROVIDER.test(provider) && DEFAULT_FAST_MODELS.has(modelId) ? "fast" : "normal",
      };
    }

    const document: unknown = JSON.parse(config);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new Error(WARNING);
    }
    const limits = new Map<string, SpeedLimit>();
    const entries: [string, unknown][] = Object.entries(document);
    for (const [key, value] of entries) {
      if (!validKey(key) || (value !== "normal" && value !== "fast" && value !== "ultrafast")) {
        throw new Error(WARNING);
      }
      limits.set(key, value);
    }
    return {
      allowsAcceleration: entries.some(([, value]) => value !== "normal"),
      limitFor: (provider, modelId) =>
        CODEX_PROVIDER.test(provider) && validModelId(modelId)
          ? (limits.get(`${provider}/${modelId}`) ?? limits.get(modelId) ?? "normal")
          : "normal",
    };
  } catch {
    return { allowsAcceleration: false, limitFor: () => "normal", warning: WARNING };
  }
}
