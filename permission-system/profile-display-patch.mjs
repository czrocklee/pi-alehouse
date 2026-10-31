// Presentation only. Do not rewrite payloads, principals, or approval grants.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function applyProfileDisplayPatch(root, patch) {
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "managed-profile-label.ts"), join(root, "src/presentation/managed-profile-label.ts"));
  // The build's patch callback asserts each exact anchor occurs once, so a
  // pinned upstream change fails generation rather than silently losing labels.
  patch("src/presentation/pattern-suggest.ts", [
    ['import type { ApprovalGrant } from "#src/session/approval-grant";', 'import type { ApprovalGrant } from "#src/session/approval-grant";\nimport { publicProfileLabel } from "./managed-profile-label";'],
    ["`This subagent ('${agentName}') only`", "`This subagent ('${publicProfileLabel(agentName)}') only`"],
  ]);
  patch("src/presentation/dialog-renderer.ts", [
    ['import type { PromptPayload } from "./prompt-payload";', 'import type { PromptPayload } from "./prompt-payload";\nimport { publicProfileLabel } from "./managed-profile-label";'],
    ['return agentName ? { label: "agent", text: agentName } : undefined;', 'return agentName ? { label: "agent", text: publicProfileLabel(agentName) } : undefined;'],
    ['const name = agentName || "unknown";', 'const name = publicProfileLabel(agentName || "unknown");'],
  ]);
}
