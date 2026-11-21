import { SettingsManager, type RetrySettings } from "@earendil-works/pi-coding-agent";

export function configureChildRuntime(
  manager: SettingsManager,
  parentRetry: RetrySettings | undefined,
): void {
  // pi.getSettings() includes session overrides, but omits unset fields. Resolve
  // them against SDK defaults, not the child's (possibly different) settings file.
  const agentRetry = SettingsManager.inMemory({ retry: parentRetry }).getRetrySettings();
  manager.applyOverrides({
    compaction: { enabled: true },
    retry: {
      ...agentRetry,
      // Keep each attempt visible to Run accounting; do not inherit provider retries.
      provider: { timeoutMs: 600_000, maxRetries: 0, maxRetryDelayMs: 5000 },
    },
  });
}
