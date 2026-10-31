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
  // The agent-facing refusal/denial renderer (renderPolicyDenial,
  // renderRefusal, renderUnavailableDenial and siblings) names the requester
  // through one shared clause; label it for display only. The payload's
  // agentName, patterns, values and evidence text stay internal, so no
  // authorization or session-grant semantics move with the label.
  patch("src/presentation/agent-renderer.ts", [
    ['import { DEFAULT_RENDER_BUDGET } from "./dialog-renderer";', 'import { DEFAULT_RENDER_BUDGET } from "./dialog-renderer";\nimport { publicProfileLabel } from "./managed-profile-label";'],
    ['  return agentName ? `for agent \'${agentName}\'` : "";', '  return agentName ? `for agent \'${publicProfileLabel(agentName)}\'` : "";'],
  ]);
  // The skill-input deny notice names the requester in the human UI; label it
  // the same way. The check itself still resolves on the internal agentName,
  // so only the rendered notice text changes.
  patch("src/handlers/gates/skill-input-gate-pipeline.ts", [
    ['import { describeSkillInputGate } from "./skill-input";', 'import { describeSkillInputGate } from "./skill-input";\nimport { publicProfileLabel } from "../../presentation/managed-profile-label";'],
    ['`Skill \'${skillName}\' is not permitted for agent \'${agentName}\'.`', '`Skill \'${skillName}\' is not permitted for agent \'${publicProfileLabel(agentName)}\'.`'],
  ]);
  patch("src/presentation/dialog-renderer.ts", [
    ['import type { PromptPayload } from "./prompt-payload";', 'import type { PromptPayload } from "./prompt-payload";\nimport { publicProfileLabel } from "./managed-profile-label";'],
    ['return agentName ? { label: "agent", text: agentName } : undefined;', 'return agentName ? { label: "agent", text: publicProfileLabel(agentName) } : undefined;'],
    ['const name = agentName || "unknown";', 'const name = publicProfileLabel(agentName || "unknown");'],
  ]);
}
