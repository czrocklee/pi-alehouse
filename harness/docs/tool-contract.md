# Tool contract

The trusted host explicitly registers exactly eight parent management tools for
one Owner.  There is no discovery, owner registry, legacy alias, or child copy.
Every schema is closed (`additionalProperties: false`) and is validated before
SDK preparation and again at execution because Pi hooks can mutate arguments.
The host validates its captured Owner context both before and after work.
Registration is distinct from model visibility: the `off` preset hides all eight
tools before any work is accepted, or retains only inspection/cleanup tools once
this Owner has accepted Runs (including completed/released results).

| Tool | Required identity | Contract |
| --- | --- | --- |
| `spawn_agent` | new Agent | Create an Agent and first queued Run. |
| `resume_agent` | `agent_id` | Create another Run on one idle reusable Agent. |
| `read_run` | `run_id` | Read owner-memory question/output with surrogate-safe paging. |
| `wait_runs` | 1--16 `run_ids` | Wait for `all` (default) or `any` Run condition. |
| `list_agents` | none | Page current resident latest Runs; optionally released Agents. |
| `steer_run` | `run_id` | Submit additional input only to an accepting running Run. |
| `cancel_run` | `run_id` | Request cancellation; it is not exit evidence. |
| `release_agent` | `agent_id` | Permanently release an idle Agent after safe cleanup. |

There are no old management-tool aliases.  `resume_agent` does not accept
`resume`; `read_run` uses `max_chars`, not `limit`; `list_agents.limit` remains
its row count.  The existing literal tool names, error codes, reply fields,
profile IDs, and lifecycle event contract are compatibility surface.

## Create and resume

`spawn_agent` accepts:

- `prompt` (1--131072 UTF-16 units) and `description` (1--4096);
- `profile`: `reader` or `editor`;
- required `difficulty`: integer `1`–`5`;
- optional `name` (new Agent label), `inherit_context`, `max_turns` (1--10000),
  `max_duration_ms` (1--86400000), and `wait_ms` (0--300000).

The parameter descriptions distinguish instructions, labels and capabilities:

- `prompt` is the Run's execution instruction. `description` is its current-task
  label in the panel and `list_agents`; supply a fresh description on every Run,
  including resume. `name` is a short, task-independent Agent nickname, fixed
  across reuse. Use one theme per session and a distinct nickname per Agent:
  `orca`, not `orca-windows-foundations`. Project/platform/task suffixes belong
  in `description`, not the nickname. This is naming guidance, not a new schema
  restriction or renaming endpoint. Labels are not forwarded as task instructions.
- `reader` investigates/reviews without direct edit/write tools or detectable
  project writes; `editor` performs authorized file edits. Git mutations stay
  with the parent in both. Bash remains permission-gated; no profile is an OS
  sandbox.
- `difficulty` describes the reasoning needed for this prompt's concrete task
  and requested quality, independently of permissions. It maps 1–2 to the
  preset's `light` slot, 3 to `standard`, and 4–5 to `strong`; see
  [difficulty](routing.md#difficulty). The parameter description gives the model
  the five scoring anchors, not this internal difficulty-to-slot mapping.

`resume_agent` accepts `agent_id`, `prompt`, optional `description`, optional
`answer_to_run_id`, plus the task budgets and `wait_ms`. It cannot accept or
alter difficulty, model, provider, thinking/effort, preset, profile, inherited context,
cwd, tools, or name.  Omitting its description uses `Follow-up task`; it does not retain an
old task label. Existing Agent names and previous Run descriptions are never
rewritten. For example, `orca` can first have `Review Windows foundations` as its
description and later `Review GTK direct-entry safety`, with the same Agent ID,
conversation and routing.

On `spawn_agent`, legacy `strength`, `model`, and `thinking` inputs, as well as
operator-owned `effort`, `effort_source`, and `effort_overrides`, are rejected
with `OBSOLETE_PARAMETER`; `strength` is not an alias and is never translated
to difficulty. On `resume_agent`, difficulty and other immutable settings are
rejected with `IMMUTABLE_SETTING`. The removed `role` is rejected with
`OBSOLETE_PARAMETER` on both tools, rather than silently ignored. `role`
instructions belong in `prompt`; task labels in `description`; a new-Agent label
in `name`. Parent thinking is captured before queued admission. The active
trusted preset maps difficulty to its existing slot and resolves exact child
model/thinking; neither creation nor resume changes the main model or main
thinking. See [routing](routing.md).

Receipts, `list_agents`, and errors that include Agent settings report only
`settings.profile` and the creation-time `settings.difficulty`. Resolution
errors may report `error.difficulty` directly, plus `parent_thinking` when an
inherited level is the problem. No projection exposes the preset, slot,
provider/model or resolved effort; internal UI and journal views retain them. Configuration/resolution errors
are configuration problems: report them and have the user adjust the worker
preset, effort policy, or inherited parent thinking, not difficulty as a bypass.
Fixed effort can resolve without parent thinking; `inherit` still requires it.
Only the user UI/configuration changes effort policy. It cannot change already
admitted Agent settings, including queued Agents or a same-ID creation retry.

A duplicate tool-call ID plus identical normalized task fields replays its
accepted request even if `wait_ms`, preset file, model metadata, or parent
thinking later changes, or the worker preset is now Off. A different ID is a new request, not a semantic
similarity match.  Pre-admission abort, a changed Owner, bad context, a full
queue, resident cap, history cap, unavailable Agent, stale answer, or existing
question is rejected.  Representative stable errors include `QUEUE_FULL`,
`RESIDENT_LIMIT`, `OWNER_HISTORY_LIMIT`, `AGENT_BUSY`, `AGENT_UNAVAILABLE`,
`PENDING_QUESTION`, `STALE_ANSWER`, `STALE_OWNER_CONTEXT`, and
`OWNER_CLEANUP_UNCERTAIN`; callers must consume `code` and fields, not parse
English text. `WORKERS_DISABLED` rejects new spawn/resume/external-steer work
while Off and unaccepted submissions that crossed a disable/re-enable boundary.
It does not allocate a failed Run, poison Owner health, or stop previously
accepted queued/running work. Internal finish-budget inputs remain permitted;
inspection, waits, results, cancellation and release keep their existing gates.

`max_duration_ms` defaults to 1800000.  Its timer begins at slot assignment and
initialization, not queue admission.  `wait_ms` begins **after** acceptance.
Omit it or use zero for the immediate background receipt; a positive value
wraps the normal wait projection under `wait` while top-level fields identify
the accepted Agent/Run.  Esc/abort of that wait returns accepted identities but
does not cancel the worker.

## Results and waiting

`read_run` defaults to 4096 and permits at most 16384 UTF-16 result units.  It
returns the complete recorded question separately, the last assistant output,
retention/truncation facts, and a cursor if retained output continues.  A page
may exceed a nominal limit by one unit to avoid splitting a surrogate pair.
`omitted_chars` are text that was not retained and cannot be fetched through a
later cursor or cold-history fallback. `complete` describes terminal output
coverage, not task success: failed or turn-capped Runs can have complete text.
While streaming, a split surrogate may temporarily make retained text shorter
than observed text; that does not permanently close retention.

Live replies may include `drain: { waiting_for, elapsed_ms }` while the adapter
awaits tracked inputs/abort (`deliveries`) or SDK idle (`sdk_idle`). Elapsed time
covers the whole exit-confirmation wait, not time since its last observation.
This optional diagnostic disappears at execution exit and can be omitted by
reply-budget compaction. It does not change status, wait conditions or ownership.

`wait_runs` defaults to `mode: "all"`, a five-minute timeout, and included
results.  Explicit `timeout_ms`, including zero, is honored; five minutes is
also the maximum.  `timeout` and `interrupted` never mean completion.  `any` is
level-triggered, so an already terminal Run qualifies immediately.

In `all` mode, any terminal `needs_input`, `failed`, `cancelled`, or
`completed` with `limit_reached` returns `attention` without cancelling peers.
A provisional question/outcome while finalization is still pending does not
qualify.  After a return, wait only on `pending_run_ids`; terminal records are
not a consumed global edge.  A new Owner fault returns `owner_blocked` to
already-pending waiters once and remains visible in snapshots.

Questions take priority in a shared 16384 UTF-16 text budget, followed by up to
4096 output units per terminal Run and then up to 2048 total progress units.
Questions that fit are whole and ordered by input; an overfull batch does not
make every question incomplete.  `question_complete:false`,
`result_requires_get`, or `next_cursor` directs the caller to `read_run`.
Running Runs do not consume output quota. The wait projection's JSON text inside
its serialized `content` envelope has an independent 64 KiB UTF-8 cap, including
both JSON escaping layers and any spawn/resume receipt around the wait. This is
not a bound on subsequently attached usage/attribution or other SDK metadata.
If necessary, optional diagnostics/settings are removed with
`metadata_compacted:true`; a still-invalid host wrapper fails
`WAIT_REPLY_TOO_LARGE` while retaining singleton IDs.

`notify_parent` progress is not a wake-up.  On a terminal condition/attention/
owner-blocked return, matching terminal Run progress is claimed atomically;
running peers retain theirs.  At most two messages per Run and sixteen total are
shown with `progress_claimed`, `progress_omitted`, completeness, and
notification-drop facts.  Timeout/interruption claims none.  This is deliberately
lossy at-most-once feedback, never an ACK queue; do not wait merely to drain it.

## List, steer, cancel, release

`list_agents` defaults to eight rows (maximum 16) over a live view. Filtering
precedes pagination, so offsets can move as Agents change. Default rows include
reservations that are queued, busy, or cleanup-uncertain; `include_released:true`
adds released records. Each row has a 256-unit description preview and
`description_truncated`, profile and `settings.difficulty`, `has_question`,
status, limits, and bounded diagnostics. It does not expose the resolved slot or
concrete provider/model. A description is a label, not complete instructions;
question text stays behind `read_run`.

`steer_run.message` is 1--16384 UTF-16 units.  `accepted:true` is only request
acceptance, not SDK delivery.  For an already terminal Run it returns
`accepted:false`, `RUN_INPUT_CLOSED`, and that Run's bounded result page with its
original `run_reason` preserved. Cancelling or finalizing Runs are not treated
as terminal-result success. This behavior and `RUN_NOT_FOUND` for unknown IDs
remain unchanged through cached handles while Off: Run lookup and the input-closed
check precede the Off gate, which still rejects new external input to accepting
Runs with `WORKERS_DISABLED` before recording or delivering it.

`cancel_run` returns a current Run projection and cancellation-request outcome;
wait for actual settlement.  `release_agent` requires an idle Agent, loses
reusability permanently, but leaves historical owner-memory Runs readable.  A
failed/uncertain cleanup returns `released:false`; there is no force release,
cleanup retry endpoint, or automatic eviction. Errors from explicit release or
idle shutdown remain on the latest Run's live detail view, bounded in count and
length; they do not rewrite that Run's outcome or its historical END record.

## Child tools

Children receive their rendered profile's local Pi tools plus exactly
`notify_parent` and `ask_parent`.  The management tools are explicitly excluded
from every child table, including retired names kept only in deny/exclusion
logic.  `notify_parent({ message })` and `ask_parent({ question })` each require
1--8192 nonblank UTF-16 units.  The latter records a question and asks the
child to finish; it does not force immediate termination or wake the parent.
The former records ordinary progress.  Both recheck the Run gate after SDK tool
hooks and fail `RUN_INPUT_CLOSED` when no bound Run can accept them.

Declared worker definitions can expose web capability under the broader
permission configuration, but the effective **harness child allowlist excludes
web**.  Plain `pi` has no delegation at all.  See [security](security.md) for
the distinction between definition/policy authority and this fixed child table.
