import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Pi supplies these to extensions itself (bundled virtual modules or dist
// aliases in its Jiti loader); production installs deliberately omit them.
// A natively imported module bypasses Jiti, so its imports of these would
// otherwise fail (production) or bind a different copy (development).
export const hostModuleSpecifiers: readonly string[] = [
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui",
  "@earendil-works/pi-ai", "@earendil-works/pi-ai/compat", "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
  "@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-tui",
  "@mariozechner/pi-ai", "@mariozechner/pi-ai/compat", "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-ai/providers/all",
  "typebox", "typebox/compile", "typebox/value",
  "@sinclair/typebox", "@sinclair/typebox/compile", "@sinclair/typebox/value",
];

/** Host module namespaces by specifier, as the host resolved them for us. */
export type HostModules = Readonly<Record<string, object>>;

const STATE_KEY = "pi-alehouse:host-module-bridge";
const SCHEME = "pi-alehouse-host:";
const PARAMETER = "alehouse-host";
interface BridgeState { hooks: boolean; generations: HostModules[] }

// Process-wide: Node module hooks and the module cache outlive any one copy
// of this file (Jiti reloads), so their state must too.
function bridgeState(): BridgeState {
  const global = globalThis as unknown as Record<symbol, BridgeState | undefined>;
  return global[Symbol.for(STATE_KEY)] ??= { hooks: false, generations: [] };
}

/**
 * Tags a module URL so that its own host-module imports, static or dynamic,
 * resolve to exactly `modules`. Any other host module it imports fails with a
 * clear error. Only the tagged module is bridged, not its dependencies. Load
 * the returned URL with a native import().
 */
export function bridgedUrl(url: string, modules: HostModules): string {
  for (const [specifier, namespace] of Object.entries(modules)) {
    assert(hostModuleSpecifiers.includes(specifier), `Not a host module: ${specifier}`);
    assert(namespace !== null && typeof namespace === "object", `Invalid host module: ${specifier}`);
  }
  const state = bridgeState();
  install(state);
  // A synthetic module is cached by URL forever: new namespaces (after a
  // reload) get a new generation instead of silently reusing old ones.
  let generation = state.generations.findIndex((known) => sameModules(known, modules));
  if (generation < 0) generation = state.generations.push(Object.freeze({ ...modules })) - 1;
  const tagged = new URL(url);
  tagged.searchParams.set(PARAMETER, String(generation));
  return tagged.href;
}

function sameModules(a: HostModules, b: HostModules): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function generationOf(parentURL: string | undefined): number | undefined {
  if (!parentURL?.includes(`${PARAMETER}=`)) return undefined;
  const value = new URL(parentURL).searchParams.get(PARAMETER);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

function install(state: BridgeState): void {
  if (state.hooks) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const generation = hostModuleSpecifiers.includes(specifier) ? generationOf(context.parentURL) : undefined;
      if (generation === undefined) return nextResolve(specifier, context);
      if (!state.generations[generation]?.[specifier]) {
        throw new Error(`Researcher web access imports ${specifier}, which the harness does not supply from the host`);
      }
      return { url: `${SCHEME}${generation}/${encodeURIComponent(specifier)}`, format: "module", shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SCHEME)) return nextLoad(url, context);
      const [generation = "", encoded = ""] = url.slice(SCHEME.length).split("/", 2);
      const specifier = decodeURIComponent(encoded);
      assert(/^\d+$/.test(generation) && state.generations[Number(generation)]?.[specifier], `Unknown host module: ${url}`);
      const names = Object.keys(state.generations[Number(generation)]![specifier]!);
      const namespace = `globalThis[Symbol.for(${JSON.stringify(STATE_KEY)})].generations[${Number(generation)}][${JSON.stringify(specifier)}]`;
      const source = [`const m = ${namespace};`,
        ...names.map((name, index) => `const v${index} = m[${JSON.stringify(name)}];`),
        `export { ${names.map((name, index) => `v${index} as ${JSON.stringify(name)}`).join(", ")} };`].join("\n");
      return { format: "module", source, shortCircuit: true };
    },
  });
  state.hooks = true;
}
