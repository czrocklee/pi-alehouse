import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Child-local overrides only. Native SDK recovery, never a replay of a task.
 * Keep provider-internal retries off: those hide attempts from Run accounting.
 * Compaction token budgets/model overrides still come from the user's settings.
 */
export function configureChildRuntime(manager: SettingsManager): void {
  manager.applyOverrides({ compaction: { enabled: true }, retry: {
    enabled: true, maxRetries: 1, baseDelayMs: 1000, maxAgentDelayMs: 5000,
    provider: { timeoutMs: 600_000, maxRetries: 0, maxRetryDelayMs: 5000 },
  } });
}
