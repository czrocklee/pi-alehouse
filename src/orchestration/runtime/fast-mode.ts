import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  FAST_MODEL_GLYPH,
  FAST_MODEL_INDICATOR,
  ULTRAFAST_MODEL_GLYPH,
} from "../../shared/overlay-protocol.mjs";
import { loadSpeedLimits, type SpeedLimit, type SpeedLimits } from "./codex-speed-limits.ts";
import type { ProviderRequestRule } from "./provider-requests.ts";

const SPEEDS = {
  fast: { name: "Fast", tier: "priority", glyph: FAST_MODEL_GLYPH },
  ultrafast: { name: "Ultrafast", tier: "ultrafast", glyph: ULTRAFAST_MODEL_GLYPH },
} as const;
type ModelIdentity = { api: unknown; provider: string; id: string };

/** One session ceiling; the parent and every child resolve it for their own physical model. */
export function registerFastMode(
  pi: ExtensionAPI,
  readLimits = () => loadSpeedLimits(getAgentDir()),
) {
  let ceiling: SpeedLimit = "normal";
  let limits: SpeedLimits | undefined;
  const requestedFor = (model: ModelIdentity | undefined) => {
    if (ceiling === "normal" || model?.api !== "openai-codex-responses") return undefined;
    const max = limits?.limitFor(model.provider, model.id);
    if (!max || max === "normal") return undefined;
    return SPEEDS[ceiling === "ultrafast" ? max : "fast"];
  };
  const publishIndicator = (ctx: ExtensionContext, model = ctx.model): void => {
    if (ctx.hasUI) ctx.ui.setStatus(FAST_MODEL_INDICATOR, requestedFor(model)?.glyph);
  };
  pi.on("session_start", (_event, ctx) => {
    ceiling = "normal";
    limits = readLimits();
    publishIndicator(ctx);
    if (limits.warning && ctx.hasUI) ctx.ui.notify(limits.warning, "warning");
  });
  pi.on("model_select", (event, ctx) => publishIndicator(ctx, event.model));
  pi.registerCommand("fast", {
    description:
      "Set the Codex speed ceiling for this session and its Agents: /fast [on|off|ultrafast|status]",
    handler: async (args, ctx) => {
      const action = args.trim();
      let next: SpeedLimit;
      switch (action) {
        case "":
          next = ceiling === "normal" ? "fast" : "normal";
          break;
        case "on":
          next = "fast";
          break;
        case "off":
          next = "normal";
          break;
        case "ultrafast":
          next = "ultrafast";
          break;
        case "status":
          next = ceiling;
          break;
        default:
          ctx.ui.notify("Usage: /fast [on|off|ultrafast|status]", "warning");
          return;
      }
      const changed = next !== ceiling;
      if (changed) {
        ceiling = next;
        publishIndicator(ctx);
      }
      const planned = requestedFor(ctx.model)?.name ?? "Normal (no tier added)";
      const notice =
        ceiling === "normal"
          ? "Fast is off for this session and its Agents."
          : `Speed ceiling: ${SPEEDS[ceiling].name}. This model: ${planned}. Agents match their own model limits.`;
      // Mention the cost even on a Normal parent if a child could make a faster request.
      const costNote =
        changed && ceiling !== "normal" && limits?.allowsAcceleration
          ? " Requests above Normal can consume more of your included allowance."
          : "";
      ctx.ui.notify(
        notice + costNote + (limits?.warning ? ` ${limits.warning}` : ""),
        limits?.warning ? "warning" : "info",
      );
    },
  });

  const requestRule: ProviderRequestRule = (model, payload) => {
    const choice = requestedFor(model);
    if (
      !choice ||
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      !("model" in payload) ||
      payload.model !== model.id ||
      ("service_tier" in payload && payload.service_tier !== undefined)
    )
      return undefined;
    return { ...payload, service_tier: choice.tier };
  };
  return {
    requestRule,
    glyphForModel: (lookup: () => ModelIdentity | undefined) =>
      ceiling === "normal" ? undefined : requestedFor(lookup())?.glyph,
  };
}
