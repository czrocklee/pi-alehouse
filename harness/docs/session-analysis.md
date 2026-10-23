# Offline session analysis

Analyze explicit local SDK JSONL files without SDK/model calls, directory scans,
linked-file reads or transcript text output. Keep transcripts and reports private.

```sh
node scripts/analyze-pi-session.mjs [--json] [--since ISO] [--until ISO] JOURNAL.jsonl ...
```

The single-file form still works, including invocation through a symlinked
script path. Importing the module does not run the CLI. Text mode summarizes;
`--json` retains full counters, accounting diagnostics and inference limits.
Inputs must be regular files. Recorded `session_file`, `parentSession` and Run links are data, never
paths to follow; supply child journals explicitly. This differs from the
[Run/receipt audit](development.md#task-floor-and-validation-ownership).

## Window and identity

- Bounds are optional and inclusive on persisted **entry.timestamp**, not mtime,
  header/nested-message timestamps or Run completion. Use ISO date-times with
  seconds, explicit `Z`/numeric timezone and at most three fractional digits.
- All supplied records are validated and used for classification/correlation;
  only selected entries contribute usage/counts. An in-window result can use
  call arguments recorded before the window.
- Entry identity is session + entry ID. Repeated file arguments and identical
  overlapping entries count once; conflicting copies fail. Reused tool-call IDs
  in distinct entries stay counted, but argument correlation becomes ambiguous.
  Call IDs are session-scoped. Fork/clone histories under different session IDs
  are **not** deduplicated, even when they copy provider operations.
- Harness owner/session records classify parent/child/unknown, using records
  outside the window too. Missing/conflicting evidence is unknown; header
  ancestry alone may describe a fork, not a child.
- `user_messages` counts user-role records, not human requests. Parent records
  are only candidates; child task prompts and unknown sessions remain separate.

Coverage stops at supplied persisted records. Missing journals, unrecorded
activity and failed summaries cannot be reconstructed. Zero selected entries
proves nothing about work or spend outside the inputs/window.

## Accounting

| Report | Meaning |
| --- | --- |
| `raw_usage` | Assistant, compaction, standalone usage and branch-summary observations, added once per entry identity. Source/model groups remain separate. |
| `parent` | Compatibility view: assistant usage from parent **and unknown** sessions, excluding identified children. |
| `child_cost_attached` | Compatibility view of **all** tool-result attached usage, not just harness children. |
| `non_additive` | Attached usage and Run-end/unreported-usage projections may overlap raw child/nested calls and each other; never add them together. |

Assistant attribution uses `responseModel ?? model`; summary metadata may name
the requested rather than responding model. Attached usage may cover absent
nested calls or work outside the window reported inside it. Raw totals therefore
are not complete parent/child/nested spend or provider billing/payments.

Numeric zero is observed; `null` means no numeric observation. Missing, invalid
and partial components remain explicit. Partial markers include `partial`,
`harnessPartial` and `harnessModels[].partial`; attribution rows are not added
again to flat totals. Assistant `error`/`aborted` records increment
`error_or_aborted_records` and mark all components partial: SDK-initialized zeros
may lack a provider usage frame. Numeric floors and actual record counts remain.
Cache hit rates are withheld for incomplete inputs or invalid denominators.

## Orchestration counters

All nine management tools, including `agent_answer`, are recognized. Current
send `action.delivery` and historical top-level `delivery` are separate; legacy
`answered` is never converted into a modern send result or answer call.

Management-only turns contain no other tools; the compatibility count includes
parent/unknown sessions, not children. Coordination is not necessarily waste.
`ok` counts non-error replies; `finished_seen` counts presented rows. Neither
proves task quality or validation; `completed` and declared checks do not either.

Wait counts use selected tool-result timestamps. `calls` excludes errors;
`calls_including_errors` and `short_wait_le_1s` include them. Short waits require
correlated explicit `wait_ms <= 1000`; `short_timeout` and `short_timeout_le_1s`
are the same non-error timeout subset. Missing/ambiguous arguments are unknown,
not zero. Timeouts/questions, management tool errors and assistant error stops
remain separate; none is automatically a provider failure. Error text is not
mined for permission-denial or model-quality scores.

## Input limits and failures

Two streaming passes retain hashes, identities and compact call metadata, not
transcript bodies. Limits: 128 file arguments, 4 GiB per pass, 16 MiB per line,
2M unique entries/call observations, JSON depth 128 and 4096 tool/model groups.
These bound input/metadata, **not RSS**. Reports include limits and selected/
duplicate counts. One fatal UTF-8 decoder is reused per file/pass. Second-pass
content hashes bind reread entries to first-pass classification and correlation
metadata, including duplicates and out-of-window entries; stat checks do not
replace that content check. Neither hashing nor file stat checks establish an
atomic snapshot or durability; analyze stable copies.

Invalid CLI/options/bounds exit **2**. Malformed JSON/UTF-8, missing identities or
timestamps, conflicting copies, changed files and exceeded limits fail the batch
with **1**, no partial success report or salvage. Diagnostics identify file/line,
not transcript contents. Read-only analysis grants no permissions or deployment,
release or model-quality acceptance.
