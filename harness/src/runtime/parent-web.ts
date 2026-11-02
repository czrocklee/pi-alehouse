import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { nativeWebLoader, type WebFactory } from "./child-web.ts";
import type { HostModules } from "./host-module-bridge.ts";
import { researcherHostModules } from "./host-modules.ts";

/** The parent keeps upstream's complete factory/tool table, but its native
 * imports must use the host's export values, just like researcher instances.
 * Keep this helper behind composition's fail-closed initialization boundary. */
export async function loadParentWeb(entry: string, modules: HostModules = researcherHostModules): Promise<{ default: WebFactory }> {
  const loaded = await nativeWebLoader(modules)(pathToFileURL(entry).href);
  assert(loaded && typeof (loaded as { default?: unknown }).default === "function", "pi-web-access has no extension factory");
  return loaded as { default: WebFactory };
}
