# Task dispatch and validation ownership

This is the bounded dispatch and validation-observation contract.
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
validation observation. Task execution has no wall-clock deadline or timed warning.

Path fields are literal relative/absolute filesystem paths, not shell words or
shell globs. No expansion is performed. Reject leading/trailing whitespace,
glob syntax, control characters,
shell quoting, `$`, backslash and leading `~` or `@`; do not wrap a path in shell
quotes to express spaces. Relative paths resolve against the Agent's
**cwd**, shared with the parent; absolute paths keep their meaning. Paths use
lexical absolute and nearest-existing-ancestor canonical aliases for
permission, external scope, conflicts and tree identity, including new outputs
and symlink aliases. Prefix overlap uses directory separator boundaries, not
arbitrary string prefixes. It is not hardlink/inode tracking, a TOCTOU barrier
or a filesystem snapshot.

Only `inputs` must already exist as ordinary files/directories. `ownership` and
`tree` may name new outputs; an existing `tree` must be a directory. Missing
inputs, invalid types, permission denials and path-resolution/IO failures are
not interchangeable diagnoses.

## Preflight and admission

The synchronous read-only host preflight uses the target internal permission
**profile**, not the Agent nickname. New model choices are `worker` (mapped to
stable `editor`) and `scout` (mapped to stable `researcher`). Checked surfaces are:

- inputs: `path_read`;
- ownership/tree: `path_write`;
- paths outside cwd, including canonical aliases: additionally the corresponding
  `external_directory_read` or `external_directory_write` surface.

Known deny rejects admission (`PREFLIGHT_DENIED`) before additional input
classification stat; permission lookup itself may canonicalize paths. The error
reports the target `profile` and checked permission `surface`; it is not a
missing-directory/type result. Worker supports project edits/builds under normal
permission; scout has no model-facing Bash/edit/write. See
[researcher web access](security.md#researcher-web-access).
A `tree` declaration does not create a profile or output-root exception. Policy
ask/unknown does not trigger approval and may pass this approximate preflight.
It is **not a grant**: child per-session rules and ordinary tool gates still
apply. A missing/throwing/invalid port is an interface failure, not a policy
unknown to silently admit. Immediate missing inputs use
`DISPATCH_INPUT_MISSING`. Preparation has no claim-installation side effects;
core finally rechecks and atomically installs the accepted claim. Accepted
request replay returns the original Run without new claims or observations.
Same-Owner overlapping ownership declarations reject with `RESOURCE_OWNED`;
a conflicting build tree rejects with `BUILD_TREE_BUSY`. Lexical and canonical
aliases participate. Declared ownership is not inferred from observed edits
and does not detect every opaque Bash effect. Undeclared work is not automatically serialized.

Dispatch facts enter both the actual child task and the parent-authored
instructions bound by the approval witness. The child-visible preface names
cwd as the relative-path base. An ownership declaration is visible
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

`after` names each Agent's current or latest task and binds fixed predecessor
Run IDs and their transitive closure at acceptance. It does not follow future
tasks or answers: wait until `agent_answer` returns before naming that Agent in
`after`, never rely on ordering in one parallel batch. Only that predecessor lineage is exempt from admission conflicts:
A → B → C may queue for the same resource; unordered B and C cannot both claim
it merely because each follows A. The exemption permits queuing, not early
execution or ignoring unfinished cleanup. Admission still checks known permission
denials, but defers input existence for an after task. If a fixed dependency
settles without completing, pump fails the queued successor at once, without an
execution slot or waiting for its other dependencies, and that settlement fails
its own successors in turn. Until the settlement finishes, the doomed
successor's reservation does not block answer or new admission. Its `after`
stays bound to the original Run IDs; the model adapter rejects naming a task
that has already settled without completing instead of accepting it.

Every dispatched Run is rechecked by pump before execution: permission/path
interpretation, inputs and claimed resources must still qualify. This occurs
when pump can progress; no free slot on that Run's own provider means no guarantee
of immediate diagnosis. Failing a doomed dependent needs no slot/session.
Missing deferred input settles as `dependency_input_missing`; other deferred
preflight failures use `dispatch_preflight_failed`. Pump failures allocate no
session/slot. Ordinary predecessor failure remains `dependency_not_completed`.

Pump/answer rechecks strictly compare all ownership/tree resources. Inputs are
not held resource locks and are revalidated for real path, permission and
existence each time (a predecessor may produce an input symlink). Every prepared
field must correspond to its literal declaration.

Explicit `agent_answer` inherits dispatch and reuses the same claim lineage in
the answer-admission transaction. If a pre-`inputEntered` continuation is
cancelled/fails and the original question reopens, its claim returns to the
pending question as well. A second needs-input outcome retains the lineage.
An existing tree lease moves with that claim, rather than reacquiring against
itself. Accepted-Run context-change failure is a failed accepted task, not an
unaccepted rollback; replay still identifies it.

Optional scout `return_to` installs that same continuation in the spawn
admission, not a later answer call. The continuation is preadmitted `after` the
exact new source Run and keeps the original `answer_to`, dispatch and claim
lineage, with the Agent's fixed settings and turn limit as `agent_answer` uses. Source dispatch is a separate scout
declaration and does not alter the inherited claim. Preflight of both sides is
all-or-none: a scout path denial, a lost or changed inherited claim, or any
other admission failure installs neither Run. Existing predecessor exemption and
`dependency_not_completed` apply to that fixed source Run. Source failure,
`needs_input` or interruption fails the pending continuation; pre-input reopen
restores the original question's claim when the worker remains healthy. No new
lock, lease, journal field or external claim store is added. The source link is
live Owner metadata for the current Owner only; it is not persisted or
restart-hydrated.

Release requires final termination and confirmed execution exit/finalization
and any necessary cleanup. Stop, kill, quarantine or Owner closure requests are
not release evidence. Tree-lease close failure is sticky: resources remain held,
and a later no-op close or successful SDK cleanup is not release evidence. A new
admission blocked only by an explicit kill/release already under way waits for
that confirmed release within a bound, then rechecks everything; see
[acceptance](tool-contract.md#acceptance-selection-and-reasons).
The execution slot is separate: it is freed after actual execution exit, even
while history finalization continues. Resident reservations, claims and leases
retain their respective finalization/confirmed-cleanup boundaries; do not hold
the provider slot merely because cleanup is uncertain, or infer resource release
from a free slot. Optional observation failure must not poison the Owner. Claims
are Owner-memory state, not persisted locks, grants or restart hydration.

## Execution limits

Runs have a turn limit, not a wall-clock execution deadline. `max_duration_ms`
is retired and rejected at admission; no hard execution timer or timed
wrap-up message is armed during queueing, initialization, execution, reuse or
answer continuation. Long tool calls cannot consume a queued steering reminder
until they return, and elapsed time alone is not evidence of a hung command.

Turn wrap still uses `soft_budget`, invalidates the automatic-approval witness
and emits `pi-alehouse:approval:invalidated`. The turn-limit grace and hard stop,
manual interruption, human Stop and Owner shutdown remain cooperative. These
operations do not guarantee remote process exit or roll back effects.
Observation waits, command/request-specific timeouts and stop/cleanup bounds
remain separate and unchanged.

Historical `deadline` outcomes remain readable without rewriting existing
journals. Retired `time_wrapped` facts are no longer interpreted by the current
codec: old-format outcome records read as explicitly unavailable, never silently
converted, and restore no timer or injected input.

## Execution-start observations

Only Runs declaring `checks` capture `source_state`, at execution start, not
admission. It is a **superproject-only, partial, non-atomic metadata observation**
of the Agent's cwd, not a build-tree parameter, validated source version,
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
`<agentDir>/alehouse-trees/<sha256(canonical tree)>/`, not files in the user tree.
Reuse the trusted flock/identity checks and retain lock files for inode identity.
True contention yields `tree_shared`; handshake/identity uncertainty yields
`tree_lock_unknown`. If the start observation itself fails, the Run notes what
it left unconfirmed: `tree_lock_unknown` when no lease is held, and
`source_state_unknown` (with source state `capture_failed`) when checks were
declared. Notes are advisory, not dispatch rejection or exclusivity
proof. Only `tree_shared` reaches the parent model; the absence of that note is
not proof that a tree is free. Nonblocking flock contention does not mean
asynchronous IO: synchronous flock still blocks the Node event loop. Different agentDirs, hosts and distinct
nested roots are not automatically coordinated.

## Notes, receipts and coverage

`dispatch_notes` is bounded to at most two notes of 120 UTF-16 units each.
The Run keeps every note, and the Agent detail pane shows them all. Model
serializers filter them to `tree_shared` before budget fitting; `tree_lock_unknown`
and `source_state_unknown` give the parent nothing to act on, and receipts
already stay out of its context. Notes are memory-only: the run-end journal
append does not record them.
Public notes are optional, yielding projections, not reserved thin controls.
Construct them through the unified snapshot/packer/final ToolResult path before
publication commit; never append after `observe` returns. Retired `time_wrapped`
facts do not enter parent-model replies. Retained Run notes are
memory-only. The read-only task ordinal selector locates retained Runs after
reuse but does not guarantee complete diagnostic recovery. There is no notes
cursor, metadata-only view or persistence.

A checks Run may attach a validation receipt to its **single existing run-end
append**, only with a successfully established valid history boundary and a
successful unique end append. This includes recordable failed outcomes,
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
_declarations_, not proved redundant verification.

Settled-reason statistics derive from retained settled Runs and need not vanish
on Owner close. `scripts/analyze-alehouse-journal.mjs` is the offline journal
audit entry, distinct from the session analysis script. It remains strict
whole-batch validation, with JSON-only output; `--json` is an explicit alias,
not a tolerant mode. Failure is not zero usage or a salvaged partial bill.
Offline usage buckets use recorded run-end usage; latest handoff residue,
partial accounting and missing-boundary coverage are separate. Residue snapshots
are not additive spend or inferred stage costs.

The offline analyzer does not interpret retired `time_wrapped` facts and emits
no `time_wrapped_attempts` counter; missing journals still leave coverage gaps.
Historical outcome reasons and usage/residue totals remain unchanged.

## Worker and validation discipline

A denied operation stays denied: do not retry the same class of request; report
the limit. This is L1 worker guidance, not runtime same-class deny counting;
L2 is outside this implementation.

Only the **single explicitly delegated validation owner** runs the full gate
after shared source is frozen. Other tasks stay within their assigned focused
checks; approval of a tool is not authorization for a wider gate. `checks` and
tree leases do not mechanically enforce this discipline. A check that cannot run
yet (no tree, a busy tree, shared source not yet ready for that check, or an
instruction to wait) is reported as unrun with its command and reason, not asked
about; missing inputs or a decision that changes what is implemented still need
the parent. Workers do not announce a declared tree as released: its claim ends
with the task, or after a question with its resolution. Omitting `tree` neither
forbids building nor makes a shared tree safe. Helpers return concise findings,
changes, actual check commands/results and unfinished or blocked work. The
explicit validation owner additionally reports evidence paths and relevant
platform/tool-version/configuration context, including zero-match checks; these
are not a universal checklist in the worker execution prompt. Shared lifecycle text and scout source hygiene do not add one. Unrun, blocked
or interrupted checks are never success. Prompt-source changes
(`resources/agent.md`, `resources/worker.md`, `resources/scout.md`) require
matched generated definition digests and separately coordinated migration, not
silent replacement of existing user resources or live-Owner deployment.
