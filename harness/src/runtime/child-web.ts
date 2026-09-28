import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { bridgedUrl, type HostModules } from "./host-module-bridge.js";
import { webToolNames } from "../tools/tool-names.js";

/** pi-web-access's default export: registers tools and lifecycle handlers. */
export type WebFactory = (pi: ExtensionAPI) => void | Promise<void>;
export type WebModuleLoader = (specifier: string) => Promise<unknown>;

// pi-web-access keeps stored results, pending fetches and curator state in
// module scope, and its session_start/session_shutdown handlers abort and
// clear them. A child sharing the parent's instance would cancel the parent's
// fetches and wipe its stored responseIds, so every open researcher session
// gets its own instance: a query-keyed native ESM import of the verified entry.
// Native import bypasses the host's Jiti resolution, so the entry's Pi SDK and
// TypeBox imports are bridged to the host's own modules (see host-modules.ts).
/** Native loader whose loaded entry imports exactly `modules` from the host. */
export function nativeWebLoader(modules: HostModules): WebModuleLoader {
  return async (specifier) => {
    const { nativeImport } = await import("../../../lib/native-import.mjs");
    return nativeImport(bridgedUrl(specifier, modules));
  };
}

export interface WebLease {
  factory: WebFactory;
  /** Idempotent. Only after the child session has shut down. */
  release(): void;
}

/** Instances are reused after release (their session_start resets state), so
 * the count is bounded by concurrently open researcher sessions. */
export class ChildWebModules {
  private readonly idle: WebFactory[] = [];
  private readonly instances = new Set<WebFactory>();
  private readonly href: string;
  /** Claimed before any await, so concurrent acquires never share a key. */
  private loaded = 0;
  constructor(entry: string, private readonly load: WebModuleLoader) {
    this.href = pathToFileURL(entry).href;
  }

  async acquire(): Promise<WebLease> {
    let factory = this.idle.pop();
    if (!factory) {
      const shared = defaultExport(await this.load(this.href));
      const key = ++this.loaded;
      const fresh = defaultExport(await this.load(`${this.href}?alehouse-worker-web=${key}`));
      // Fail closed if a loader ever collapses the query (Jiti's import() does):
      // shared module state is exactly what this class exists to prevent.
      assert(fresh !== shared && !this.instances.has(fresh), "Researcher web module is not an isolated instance");
      this.instances.add(fresh);
      factory = fresh;
    }
    const leased = factory;
    let released = false;
    return { factory: leased, release: () => {
      if (released) return;
      released = true;
      this.idle.push(leased);
    } };
  }
}

function defaultExport(module: unknown): WebFactory {
  const factory = (module as { default?: unknown } | undefined)?.default;
  assert(typeof factory === "function", "pi-web-access has no extension factory");
  return factory as WebFactory;
}

const ACTIVATION_TOOL = "web_enable";
const ACTIVATION_WARNING = "[pi-web-access] Dynamic tool activation";
// Whole-string form: providers that enforce schemas by constrained decoding
// (Mistral-hosted GLM) treat a pattern as a full match, so a prefix-only
// pattern would admit nothing past the scheme.
const HTTP_URL = "^[Hh][Tt][Tt][Pp][Ss]?://\\S+$";

/** Parameters a researcher may not set. `auth` sends local browser cookies.
 * `proxy` is model-chosen and only scheme-checked upstream: its host is not
 * held to the SSRF guard, so it could route requests to loopback or private
 * services, or bypass a configured proxy. The configured proxy still applies. */
const RESTRICTED_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  web_search: ["proxy"], source_check: ["proxy"], fetch_content: ["auth", "proxy"],
};

/** Why a web call is outside the researcher boundary, if it is. The restricted
 * schemas already reject these before any permission prompt; this repeats the
 * check at execution in case validation is bypassed. */
export function researcherWebProblem(tool: string, params: unknown): string | undefined {
  const input = (params ?? {}) as Record<string, unknown>;
  for (const key of RESTRICTED_PARAMETERS[tool] ?? []) {
    if (input[key] !== undefined) return `${key} is unavailable to researcher Agents.`;
  }
  if (tool !== "fetch_content") return undefined;
  const urls: unknown[] = [input.url, ...(Array.isArray(input.urls) ? input.urls as unknown[] : [])].filter((url) => url !== undefined);
  for (const url of urls) {
    let protocol: string | undefined;
    try { protocol = typeof url === "string" ? new URL(url.trim()).protocol : undefined; } catch { /* reported below */ }
    if (protocol !== "http:" && protocol !== "https:") {
      return `Researcher Agents fetch only absolute http(s) URLs, not local paths or other schemes: ${String(url).slice(0, 200)}`;
    }
  }
  return undefined;
}

type SchemaRecord = Record<string | symbol, unknown> & { properties?: Record<string, Record<string | symbol, unknown>> };
type ToolLike = { name: string; parameters: SchemaRecord; execute: (...args: unknown[]) => unknown };

/** Closed object without restricted parameters; fetch_content also takes only
 * http(s) URLs. Spreads keep TypeBox's symbol-keyed metadata (kind, optional)
 * on every copied schema. */
function restrictTool(tool: ToolLike): ToolLike {
  const restricted = RESTRICTED_PARAMETERS[tool.name];
  if (!restricted) return tool;
  const properties = Object.fromEntries(Object.entries(tool.parameters.properties ?? {})
    .filter(([key]) => !restricted.includes(key)));
  if (tool.name === "fetch_content") {
    const items = properties.urls?.items as SchemaRecord | undefined;
    assert(properties.url && properties.urls && items, "Unexpected fetch_content schema");
    properties.url = { ...properties.url, pattern: HTTP_URL };
    properties.urls = { ...properties.urls, items: { ...items, pattern: HTTP_URL } };
  }
  const parameters: SchemaRecord = { ...tool.parameters, additionalProperties: false, properties };
  return { ...tool, parameters, execute: async (...args: unknown[]) => {
    const problem = researcherWebProblem(tool.name, args[1]);
    if (problem) return { content: [{ type: "text", text: `Error: ${problem}` }], details: { error: problem } };
    return tool.execute(...args);
  } };
}

// One filter for all concurrent researcher assemblies, installed while any is
// running: nested save/restore of console.warn would leave a finished child's
// filter installed when assemblies overlap out of order.
let suppressing = 0;
let originalWarn: typeof console.warn | undefined;
function suppressActivationWarning(delta: 1 | -1): void {
  suppressing += delta;
  if (delta === 1 && suppressing === 1) {
    const warn = originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(ACTIVATION_WARNING)) return;
      warn.apply(console, args);
    };
  } else if (suppressing === 0 && originalWarn) {
    console.warn = originalWarn;
    originalWarn = undefined;
  }
}

/** Runs one isolated pi-web-access instance inside a researcher child. */
export function childWebExtension(factory: WebFactory): ExtensionFactory {
  return async (pi) => {
    const registered = new Set<string>();
    const scoped = new Proxy(pi, {
      get(target, property) {
        const original = Reflect.get(target, property) as unknown;
        if (property === "registerTool") return (tool: ToolLike) => {
          // Web tools stay eagerly active: the activation loader would change
          // the admitted child tool table between requests.
          if (tool.name === ACTIVATION_TOOL) return;
          if (!webToolNames.includes(tool.name)) throw new Error(`Unexpected researcher web tool: ${tool.name}`);
          registered.add(tool.name);
          return target.registerTool(restrictTool(tool) as never);
        };
        // Background fetch notices must not start a model turn outside a Run.
        if (property === "sendMessage") {
          return (...[message, options]: Parameters<ExtensionAPI["sendMessage"]>) => {
            target.sendMessage(message, { ...options, triggerTurn: false });
          };
        }
        return typeof original === "function" ? (original as (...args: unknown[]) => unknown).bind(target) : original;
      },
    });
    // The parent already reports this once; a per-child repeat would draw
    // over the TUI. Every other warning passes through.
    suppressActivationWarning(+1);
    try { await factory(scoped); } finally { suppressActivationWarning(-1); }
    const missing = webToolNames.filter((name) => !registered.has(name));
    if (missing.length) {
      throw new Error(`Researcher web tools unavailable: ${missing.join(", ")}. Keep pi-web-access's default tool names and enable all four tools.`);
    }
  };
}
