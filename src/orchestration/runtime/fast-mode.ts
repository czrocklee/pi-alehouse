import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_MODEL_GLYPH, FAST_MODEL_INDICATOR } from "../../shared/overlay-protocol.mjs";
import type { ProviderRequestRule } from "./provider-requests.ts";

const CODEX_PROVIDER = /^openai-codex(?:-(?:[2-9]|[1-9]\d+))?$/;
// Fast (service_tiers[].id === "priority") in OpenAI's bundled Codex catalog:
// https://github.com/openai/codex/blob/6c0cee502d215e5df2dd9a303cf2e252229c9e12/codex-rs/models-manager/models.json
// Exclude internal models and those retired for Codex with ChatGPT sign-in.
// Pi does not expose these capabilities; this is not an account entitlement check.
const FAST_MODELS: ReadonlySet<string> = new Set([
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
type ModelIdentity = { api: unknown; provider: string; id: string };

function supportsFast(model: ModelIdentity | undefined): boolean {
  return (
    model?.api === "openai-codex-responses" &&
    CODEX_PROVIDER.test(model.provider) &&
    FAST_MODELS.has(model.id)
  );
}

/** Register only on the parent. Request rules and UI use the same live switch. */
export function registerFastMode(pi: ExtensionAPI) {
  let enabled = false;
  const requestedFor = (model: ModelIdentity | undefined) => enabled && supportsFast(model);
  const publishIndicator = (ctx: ExtensionContext, model = ctx.model): void => {
    if (ctx.hasUI)
      ctx.ui.setStatus(FAST_MODEL_INDICATOR, requestedFor(model) ? FAST_MODEL_GLYPH : undefined);
  };
  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    publishIndicator(ctx);
  });
  pi.on("model_select", (event, ctx) => publishIndicator(ctx, event.model));
  pi.registerCommand("fast", {
    description: "Toggle, set, or check Codex Fast requests for this session and its Agents",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action !== "" && action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      if (action !== "status") {
        const next = action === "" ? !enabled : action === "on";
        if (next !== enabled) {
          enabled = next;
          publishIndicator(ctx);
        }
      }
      ctx.ui.notify(
        enabled
          ? "Fast is on for subsequent supported Codex requests from this session and its Agents. It may use more quota."
          : "Fast is off for this session and its Agents.",
        "info",
      );
    },
  });

  const requestRule: ProviderRequestRule = (model, payload) => {
    if (
      !requestedFor(model) ||
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      !("model" in payload) ||
      payload.model !== model.id ||
      ("service_tier" in payload && payload.service_tier !== undefined)
    )
      return undefined;
    return { ...payload, service_tier: "priority" };
  };
  return {
    requestRule,
    // Skip the UI's model lookup entirely while Fast is disabled.
    requestedForModel: (lookup: () => ModelIdentity | undefined) =>
      enabled && supportsFast(lookup()),
  };
}
