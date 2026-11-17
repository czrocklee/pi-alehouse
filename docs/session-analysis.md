# Inspect history and usage

Use `/alehouse-history` in Pi to inspect Run links in the current parent session. For batch analysis, use the tools below from a **source checkout**. Both read only the SDK JSONL files you name. Neither scans directories, follows paths recorded in a journal, calls a model, repairs a journal or prints conversation text. Supply child files yourself. Keep even aggregate reports private; they can identify models, files or workspaces.

## How much activity and spend was recorded?

```sh
node scripts/analyze-pi-session.mjs parent.jsonl child.jsonl
node scripts/analyze-pi-session.mjs --json \
  --since 2026-01-01T00:00:00Z --until 2026-01-01T23:59:59.999Z parent.jsonl child.jsonl
```

Text mode gives a summary; JSON includes counters and coverage. `--since` and `--until` are inclusive on **entry timestamps**, not file mtimes or task completion. Specify seconds, timezone and at most three fractional digits. Records outside the window are still checked and can identify an in-window result's tool call or session.

| Report field   | Interpretation                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw_usage`    | Recorded assistant, compaction, standalone usage and branch-summary observations, once per session/entry identity.                                   |
| `parent`       | Assistant usage from parent **and unclassified** sessions; excludes identified children.                                                             |
| `non_additive` | Usage attached to tool results, Run ends and unreported-usage checkpoints can overlap raw observations and each other. **Do not add them together.** |

`null` means no numeric observation; zero is a reported value. Aborted or errored assistant records can carry SDK-initialized zeros and are marked partial. Assistant usage is attributed to the responding model when known; summary usage may name the requested model. This is not a provider bill.

Identical entries under the same session and entry IDs count once; conflicting copies fail. A fork with a different session ID counts separately. Reused call IDs make argument correlation ambiguous, not zero. `user_messages` counts user-role records, including child task prompts, not distinct human requests. A short wait requires a correlated explicit `wait_ms <= 1000`; a timeout is not a worker failure.

The analyzer uses two streaming passes with content-hash checks. Use stable copies. Limits are 128 file arguments, 4 GiB per pass, 16 MiB per line, 2 million unique entries and 2 million call observations, JSON depth 128 and 4096 tool/model groups. These are not process-memory limits.

## Which Runs and declared checks were observed?

```sh
node scripts/analyze-alehouse-journal.mjs parent.jsonl child.jsonl
```

This separate audit emits JSON (`--json` is optional). It correlates start, end and parent link records; counts usage once per observed Run end; reports missing boundaries, invalid-receipt markers and grouped check declarations. An unreported-usage checkpoint is a non-additive snapshot. Missing journals or receipts are coverage gaps, and a declaration is **not proof a check ran or passed**. See [dispatch receipts](task-dispatch.md).

Its limits differ from the session analyzer's: up to 64 file arguments, 8 MiB per file, 64 MiB total, 250,000 lines and 1 MiB per line. Both tools reject malformed input rather than salvage a partial report. Invalid command-line usage exits 2; a failed analysis exits 1. No selected entries or no observed usage is not evidence of zero cost elsewhere.
