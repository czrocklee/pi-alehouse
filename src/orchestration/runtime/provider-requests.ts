import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProviderRequestModel = Readonly<{ api: string; id: string; provider: string }>;

/** A trusted wire transform. Return undefined to keep the current payload. */
export type ProviderRequestRule = (model: ProviderRequestModel, payload: unknown) => unknown;

/** Reuse this factory in the parent and in each explicit child loader. */
export function providerRequestExtension(
  ...rules: ProviderRequestRule[]
): (pi: ExtensionAPI) => void {
  return (pi) => {
    // Pi chains payload replacements and isolates failures per handler.
    for (const rule of rules) {
      pi.on("before_provider_request", (event, ctx) => {
        if (!ctx.model) return undefined;
        const api: unknown = ctx.model.api;
        if (typeof api !== "string") return undefined;
        const { id, provider } = ctx.model;
        return rule({ api, id, provider }, event.payload);
      });
    }
  };
}
