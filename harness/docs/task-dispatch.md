# Task dispatch and validation ownership

This is the bounded dispatch, soft-wrap and validation-observation contract.
It does not introduce a DAG/batch scheduler, permission grant, OS sandbox,
mechanical full-suite lock or durable task recovery. Owner lifecycle remains in
core; host permission/filesystem/Git/lock IO belongs to runtime ports. See
[tool contract](tool-contract.md), [security](security.md) and
[limitations](limitations.md). Implementation and scoped validation must agree
with this contract; documentation alone is not acceptance evidence.

## Dispatch declarations

`agent_spawn` and `agent_run` accept optional closed `dispatch` data:

```ts
dispatch?: {
  inputs?: string[];    // at most 8 literal input paths
  ownership?: string[]; // at most 16 literal output/resource paths
  tree?: string;        // one literal build-tree root
  checks?: string[];    // at most 16 parent-declared check identifiers
}
```

Supplied arrays must be nonempty and contain unique entries. Each entry and
`tree` is bounded to 512 UTF-16 units. `checks` describes the
parent's planned checks (for example test-file/glob identifiers or platform),
not executable shell commands, evidence they ran or permission to execute them.
It is not a full/focused scheduler enum. There is no dispatch override that
bypasses a resource conflict. Omitting dispatch adds no dispatch claim or
validation observation; wall-clock soft wrap is a separate budget behavior.

Path fields are literal relative/absolute filesystem paths, not shell words or
shell globs. No expansion is performed. Reject leading/trailing whitespace,
glob syntax, control characters,
shell quoting, `$`, backslash and leading `~` or `@`; do not wrap a path in shell
quotes to express spaces. Resolve against the admitted cwd, then use lexical
absolute and canonical aliases derived through the nearest existing ancestor
for permission, external scope, conflicts and tree identity. This also handles
not-yet-created outputs and symlink aliases. Prefix overlap uses directory
separator boundaries, not arbitrary string prefixes. It is not hardlink/inode
tracking, a TOCTOU barrier or a filesystem snapshot.

Only `inputs` must already exist as ordinary files/directories. `ownership` and
`tree` may name new outputs; an existing `tree` must be a directory. Missing
inputs, invalid types, permission denials and path-resolution/IO failures are
not interchangeable diagnoses.

## Preflight and admission

The synchronous read-only host preflight uses the target permission **profile**
(`reader`, `editor`, `researcher`), not the Agent nickname:

- inputs: `path_read`;
- ownership/tree: `path_write`;
- paths outside cwd, including canonical aliases: additionally the corresponding
  `external_directory_read` or `external_directory_write` surface.

Known deny rejects admission (`PREFLIGHT_DENIED`) before additional input
classification stat; permission lookup itself may canonicalize paths. Policy
ask/unknown does not trigger approval and may pass this approximate preflight.
It is **not a grant**: child per-session rules and ordinary tool gates still
apply. A missing/throwing/invalid port is an interface failure, not a policy
unknown to silently admit. Immediate missing inputs use
`DISPATCH_INPUT_MISSING`. Preparation has no claim-installation side effects;
core finally rechecks and atomically installs the accepted claim. Accepted
request replay returns the original Run without new claims or observations.

Same-Owner overlapping ownership declarations reject with `RESOURCE_OWNED`;
a conflicting build tree rejects with `BUILD_TREE_BUSY`. Lexical and canonical
aliases participate. Declared ownership is not inferred from `touched`, which
only records successful direct edits/writes, and does not detect every opaque
Bash effect. Undeclared work is not automatically serialized.

Dispatch facts enter both the actual child task and the parent-authored
instructions bound by the approval witness. An ownership declaration is visible
to that review, but cannot widen authority. Delivery/validation discipline
belongs in the worker guidance, not a second permission mechanism.

## Dependencies, claims and continuations

Claims span queued, running and finalizing work, and a healthy pending
needs-input question. Task settlement with an answerable question does **not**
release its resources. A question does not yet have a continuation Run. For a
needs-input conflict, read/wait for the question token and answer, or explicitly
abandon the work, kill the Agent and wait for confirmed release. Passive waiting
or `after` on the original needs-input Run does not release its claim; interrupt
or a returned kill request is not release confirmation.

`after` binds fixed predecessor Run IDs and their transitive closure at
acceptance. Only that predecessor lineage is exempt from admission conflicts:
A → B → C may queue for the same resource; unordered B and C cannot both claim
it merely because each follows A. The exemption permits queuing, not early
execution or ignoring unfinished cleanup. Admission still checks known permission
denials, but defers input existence for an after task. If a fixed ancestor is
terminal but not completed, its doomed queued successor's reservation does not
block answer or new admission while awaiting pump settlement. Its `after` stays
bound to the original Run IDs.

Every dispatched Run is rechecked by pump before execution: permission/path
interpretation, inputs and executable resources must still qualify. This occurs
when pump can progress; no free slot means no guarantee of immediate diagnosis.
Missing dependency-produced input settles as `dependency_input_missing`; other
deferred preflight failures use `dispatch_preflight_failed`. These prestart
failures create no child session, occupy no execution slot and leave the Agent
reusable. Ordinary predecessor failure remains `dependency_not_completed`.

Explicit `agent_answer` inherits dispatch and reuses the same claim lineage in
the answer-admission transaction. If a pre-`inputEntered` continuation is
cancelled/fails and the original question reopens, its claim returns to the
pending question as well. A second needs-input outcome retains the lineage.
An existing tree lease moves with that claim, rather than reacquiring against
itself. Accepted-Run context-change failure is a failed accepted task, not an
unaccepted rollback; replay still identifies it.

Release requires final termination and confirmed execution exit/finalization
and any necessary cleanup. Stop, kill, quarantine or Owner closure requests are
not release evidence. Tree-lease close failure is sticky: resources remain held,
and a later no-op close or successful SDK cleanup is not release evidence.
Optional observation failure must not poison the Owner. Claims are Owner-memory state,
not persisted locks, grants or restart hydration.

## Wall-clock soft wrap

Let `D = max_duration_ms`. For `D > 1000`, reserve
`Δ = max(1000, min(30000, D / 5))` and arm the warning after
`max(1000, D − Δ)` ms from execution-slot assignment/initialization, not queue
admission. For `D ≤ 1000`, no wall-clock warning is armed; hard deadline remains.
In the short-budget clamp range the actual warning window may be smaller than
Δ. This changes neither duration nor the existing turn/deadline classification.

The timer latches due on its original Run. If not ready, retain due for one
best-effort attempt after the real original `inputEntered` boundary with
`canInput()` true, or at `turnStart` after hard/turn-budget decisions. Do not
inject before `port.run()` or merely when core sets inputOpen: approval binding
and the original answer-input boundary must already be established. Require the
current Run, original input entered, input readiness, no stop/exit/turn wrap,
and a hard deadline not yet reached. Not-ready checks do not count as attempts;
once attempted, catch rejection and never retry, with input drain owning
asynchronous failures. Stop prevents further attempts; execution exit clears
due/timer. Neither carries to another Run or continuation. Wall-clock does not set turn `limit_reached`; turn wrap
can still follow a wall-clock attempt.

`time_wrapped` means **a warning was attempted after passing the guard**, not
that the SDK/model received it or produced a checkpoint. It is an optional
outcome/task diagnostic, not a thin control-row flag. Long tools, turn-boundary
input delivery and event-loop blocking can prevent any checkpoint before the
unchanged hard stop. This is not forced termination or a hard monetary cap.

The warning uses `soft_budget` context change. Like turn wrap, this invalidates
the Run's automatic-approval witness and emits
`pi-harness:approval:invalidated`; subsequent automatic approval cannot rely on
the old witness. It is therefore **not merely harmless prompt injection**.
Normal human permission handling and immutable/profile floors remain.

## Execution-start observations

Only Runs declaring `checks` capture `source_state`, at execution start, not
admission. It is a **superproject-only, partial, non-atomic metadata observation**
of the admitted cwd, not the build-tree parameter, validated source version,
content fingerprint or whole-tree clean proof. HEAD and status can change
between calls; identical status text can hide different contents. Submodules
are explicitly ignored. Missing or failed capture is unknown and does not block
ordinary task execution. Capture supports only repository-root execution with
a conventional `.git` directory; linked worktrees, bare/separate-git-dir layouts,
subdirectory execution and ambiguous layouts remain unknown.

Runtime uses a supplied trusted absolute Git executable, never project PATH or
a PATH fallback. Before status overrides, inspect unsupported helper/partial
configuration using a runner without injected `core.fsmonitor=false`; presence
of `core.fsmonitor`, clean/process filters or partial/promisor configuration
withholds known state. This intentionally includes global LFS clean/process
configuration and an explicitly configured `core.fsmonitor=false`: guard by
key presence remains conservative, not narrowed by helper name/source or false
value. Both phases disable lazy fetch, optional locks, paging and replacements.
The status phase adds `-c core.fsmonitor=false` and fixed
`status --porcelain=v1 -z --ignore-submodules=all --untracked-files=normal`.
This overrides configured untracked-output suppression and includes non-ignored
untracked entries (with normal directory summaries); ignores/global excludes,
indexes, platform and other Git semantics still apply. Empty output is not
whole-disk clean proof, and the status digest is not a content fingerprint.
Git redirection, config
injection, executable-path and trace environment are isolated; unsupported or
uncertain observation is unknown, not a guessed clean state. Bounded capture
failures are advisory. Git subprocess probes are asynchronous, with per-probe
2-second/4 MiB limits and aggregate 8-second/8 MiB capture limits. These are not
hard-realtime bounds, immediate cancellation or guaranteed process-exit/kill
proof; filesystem interpretation and tree flock remain synchronous.

Only declared `tree` acquires a tree lease. Local coordination covers the same
host, same agentDir and same canonical tree identity, under private
`<agentDir>/harness-trees/<sha256(canonical tree)>/`, not files in the user tree.
Reuse the trusted flock/identity checks and retain lock files for inode identity.
True contention yields `tree_shared`; handshake/identity uncertainty yields
`tree_lock_unknown`. Both are advisory, not dispatch rejection or exclusivity
proof. Nonblocking flock contention does not mean asynchronous IO: synchronous
flock still blocks the Node event loop. Different agentDirs, hosts and distinct
nested roots are not automatically coordinated.

## Notes, receipts and coverage

`dispatch_notes` is bounded to at most two notes of 120 UTF-16 units each.
Notes and `time_wrapped` are optional, yielding projections, not reserved thin
controls. After questions and FIFO alerts, attempt `time_wrapped` independently
for each task before results/string diagnostics. It can still yield when bytes
are saturated; reaching the text cap with a long ASCII result does not itself
force omission. Notes retain lower priority. Construct them through the unified
snapshot/packer/final ToolResult path before publication commit; never append
after `observe` returns. Retained
Run data is memory-only. Later observations of a still-locatable task can try to
show omitted diagnostics again, but there is no complete-recovery guarantee,
notes cursor or new arbitrary historical task selector.

A checks Run may attach a validation receipt to its **single existing run-end
append**, only with a successfully established valid history boundary and a
successful unique end append. This includes recordable failed/deadline outcomes,
not every accepted or failed Run. Unstarted tasks, missing/invalid boundaries
and failed append leave coverage gaps; do not fabricate sessions/start/end,
perform a repair append or promise persistence from `run.record`. Parent/child
persistent session backing is necessary, not sufficient. Success means the SDK
returned an append ID for the real end record, not disk persistence or fsync
proof. Invalid optional receipt normalization is a local soft drop: the same
sole end omits it and records
`validation_receipt_error: 'invalid_validation_receipt'`, with a live
`cleanup_errors` diagnostic. A cold reader retains valid core history as
`recorded` with a receipt warning, never uses the bad receipt. Mandatory
identity/boundary/outcome/output/usage validation, diagnostic-port failures and
append failures remain strict; no retry or repair append. Existing record
names/types stay compatible.

Receipts relate declared checks/tree, source observation and the final outcome;
platform, tool versions and relevant configuration are child-reported evidence,
not automatically captured facts. They are consumed through trusted bounded
history and offline audit, **not automatically injected into the parent model**
and not through a new model tool or arbitrary journal path. A receipt neither
authorizes work nor skips a gate or rerun. Same checks/tree means repeated
*declarations*, not proved redundant verification.

Settled-reason statistics derive from retained settled Runs and need not vanish
on Owner close. `scripts/analyze-pi-harness-journal.mjs` is the offline journal
audit entry, distinct from the session analysis script. It remains strict
whole-batch validation, with JSON-only output; `--json` is an explicit alias,
not a tolerant mode. Failure is not zero usage or a salvaged partial bill.
Offline usage buckets use recorded run-end usage; latest handoff residue,
partial accounting and missing-boundary coverage are separate. Residue snapshots
are not additive spend or inferred stage costs.

`time_wrapped_attempts` is derived from retained settled Runs in live stats and
from deduplicated run-end outcomes offline, not only checks/receipt Runs. It
counts recorded warning attempts, not delivery, checkpoints or effective
wrap-up; missing journals still leave coverage gaps. It changes neither outcome
reasons nor usage/residue totals.

## Worker and validation discipline

A denied operation stays denied: do not retry the same class of request; report
the limit. This is L1 worker guidance, not runtime same-class deny counting;
L2 is outside this implementation.

Only the **single explicitly delegated validation owner** runs the full gate
after shared source is frozen. Other tasks stay within their assigned focused
checks; approval of a tool is not authorization for a wider gate. `checks` and
tree leases do not mechanically enforce this discipline. Deliver findings and
changed behavior with exact evidence paths, actual commands/results and relevant
platform/tool-version/configuration context. List unrun, blocked, interrupted
and zero-match checks as such, never as success. Worker-body changes require
matched generated definition digests and separately coordinated migration, not
silent replacement of existing user resources or live-Owner deployment.
