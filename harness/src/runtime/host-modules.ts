// The Pi SDK modules pi-web-access imports, exactly as the host's extension
// loader resolved them for this harness (virtual modules or dist aliases). A
// researcher's natively imported pi-web-access receives these, never a copy
// found on disk: production installs omit the SDK packages entirely.
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import type { HostModules } from "./host-module-bridge.js";

export const researcherHostModules: HostModules = Object.freeze({
  "@earendil-works/pi-coding-agent": piCodingAgent,
  "@earendil-works/pi-tui": piTui,
  "@earendil-works/pi-ai": piAi,
  "@earendil-works/pi-ai/compat": piAiCompat,
  typebox,
});
