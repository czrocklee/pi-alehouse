# Task dispatch and validation ownership

Dispatch coordinates declared work in the shared cwd. It does not grant
permissions, isolate files, schedule a test suite or prove that a check ran.
See the [tool contract](tool-contract.md) and [worked dispatch](agent-tools-quickstart.md#4-declare-scope--workcheck--inspect).

## Dispatch declarations

`agent_spawn` and `agent_run` take optional closed `dispatch` data. All fields
are optional; supplied arrays are nonempty and unique. Each string is nonblank,
at most 512 UTF-16 units, with no ASCII control characters.

| Field            | Meaning                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required_paths` | Up to 32 required files/directories; optional references belong in the prompt. Preflight checks prerequisites, not contents; no recursive scan or input locks. |
| `ownership`      | Up to 16 output/resource paths to edit or create. Omit for read-only work.                                                                                     |
| `build_dir`      | One build-output directory, not a checkout. It may be new; if present on disk it must be a directory.                                                          |
| `checks`         | Up to 16 planned check names/targets (test globs allowed), not shell commands. Omit checks awaiting a go-ahead.                                                |

Paths are literal absolute or parent-cwd-relative spellings. Internal spaces
are fine; no padding, globs, shell quotes/backticks, `$`, backslash or leading
`~`/`@`. Raw schema failures return `INVALID_PARAMETERS`; a path rejected by
Alehouse's literal-path check returns `INVALID_DISPATCH`. An overlong string
can return either code: some Unicode text passes the schema's length check
but exceeds Alehouse's 512 UTF-16-unit limit. In both cases, shorten the named
field. Diagnostics identify known fields/indexes (e.g. `dispatch.required_paths.0`)
without echoing unknown keys or input values. Raw array count errors precede item errors; the
first safely mappable item error is used. Runtime path diagnostics may report
the declared and normalized paths. Declarations enter the child brief and its
parent-authored approval context, using these field names and the cwd.

## Preflight and admission

Read-only preflight checks the target profile, not the nickname: `path_read`
for required paths, `path_write` for ownership/build directory, and corresponding
`external_directory_read`/`external_directory_write` for outside-cwd paths,
including canonical aliases. Known deny (`PREFLIGHT_DENIED`, with profile and
surface) precedes filesystem type classification; permission lookup itself may
canonicalize. Ask/unknown is neither approval nor a grant, and the normal child
gates still apply. A missing/invalid permission query (`DISPATCH_PREFLIGHT_UNAVAILABLE`)
is not policy unknown; unresolved paths fail `DISPATCH_PATH_UNKNOWN`.

Required paths must be ordinary files or directories. Classifications are
`DISPATCH_REQUIRED_PATH_MISSING`, `DISPATCH_REQUIRED_PATH_TYPE`,
`DISPATCH_REQUIRED_PATH_INSPECTION_FAILED`, `DISPATCH_BUILD_DIR_TYPE` or
`DISPATCH_BUILD_DIR_INSPECTION_FAILED`. With `after`, existence and type of
required paths defer to execution preflight; path and permission checks still
run at admission. Ownership and build outputs may be new. Declaring them never
widens a profile's write access. Admission installs claims atomically; preparing
arguments and replaying accepted calls install nothing.

## Dependencies, claims and continuations

Same-Owner claims check lexical and nearest-existing-ancestor canonical aliases,
including new outputs; overlap uses directory boundaries, not string prefixes.
Conflicts report `RESOURCE_OWNED` or `BUILD_DIR_BUSY`. Claims cover declared work
only, not opaque program effects, hardlinks or filesystem races.

[`after`](tool-contract.md#after-and-handoff) exempts only the fixed transitive
predecessor lineage from admission conflicts: A → B → C can queue on one path;
unordered B and C can't both claim it just because they follow A. Before start,
recheck permissions, actual required paths and strict ownership/build-directory
identity. That can await a provider slot; a doomed dependency fails without a
slot/session or waiting for other dependencies, and ceases to block new claims.
A missing deferred prerequisite yields `dependency_input_missing`; other
recheck failures yield `dispatch_preflight_failed`; a non-completing predecessor
yields `dependency_not_completed`. Prestart failures have no child history boundary.

Claims span queued, running and finalizing work **and** healthy pending questions.
Answer (including the worker side of [`return_to`](tool-contract.md#scout-return_to))
rechecks and inherits the dispatch, claim and any build-directory lease. If a
pre-input failure reopens the question, it restores that claim/lease. The scout
has separate dispatch; both sides must preflight before either is installed.
Resolve a pending-question conflict by answering or abandoning it with confirmed
kill/release, not passive waiting or depending on the original question task.

Release requires actual termination, finalization and necessary cleanup; a
stop request is not proof. Sticky lease-close failure retains the claim even if
later SDK cleanup succeeds. A provider slot frees at execution exit, independently
of resident reservation and claim cleanup. See [release waits](tool-contract.md#acceptance-selection-and-reasons).

## Execution limits

Runs have a soft turn budget and configurable wrap-up grace, not a wall-clock
deadline. Budget wrap-up input invalidates automatic approval. Turn stops and
manual cancellation are cooperative, can't guarantee process exit or roll back
changes, and cannot make a long-running tool consume steering. Observation waits,
command timeouts and stop/cleanup bounds are separate. See [task budget inputs](tool-contract.md#run-send-and-explicit-answer).

## Execution-start observations

Only `checks` tasks capture `source_state` at execution start: HEAD, dirty flag
and status digest (or unknown) from the shared cwd. It is partial, non-atomic,
superproject-only metadata, not a content fingerprint, tested source identity
or whole-tree clean proof. Requires a conventional repository-root `.git`
directory and trusted absolute Git (no PATH fallback). Status ignores submodules
and includes normal non-ignored untracked entries. Unsupported layouts or helper/
partial config (including LFS clean/process and even configured `core.fsmonitor=false`)
withhold known state. Isolated probes disable lazy fetch, optional locks, paging
and replacement objects; limits are 2 s/4 MiB per probe and 8 s/8 MiB total, not
hard-realtime or kill guarantees. Unknown capture does not block ordinary work.

Only a declared `build_dir` takes an advisory lease for the same host, agentDir
and canonical directory. Contention notes `build_dir_shared` in model replies;
synchronous flock can still block the event loop. Missing notes do not establish
exclusivity. Different hosts, agentDirs and nested roots are not coordinated.

## Notes, receipts and coverage

`dispatch_notes` is optional (up to two 120-unit notes). Only `build_dir_shared`
is projected to the model; lease/capture uncertainty stays in Run/UI diagnostics.
Notes are memory-only and can yield under reply limits; no diagnostic paging.

A checks Run can attach a receipt (declared checks/build directory, cwd, source
state and final outcome) only with a valid history boundary and successful sole
end append. Unstarted/missing-boundary Runs or failed appends leave gaps; an SDK
append ID is not disk durability. Invalid optional receipts are dropped locally
with `validation_receipt_error: 'invalid_validation_receipt'`, a cleanup diagnostic
and a cold-read warning; mandatory validation/append stays strict, no repair retry.
Receipts are for trusted history/offline audit, not model input or a gate skip.
Use the [offline journal analyzer](session-analysis.md#which-runs-and-declared-checks-were-observed) to distinguish recorded usage, unreported residue and missing-boundary coverage.

## Worker and validation discipline

Run assigned checks only; one explicitly delegated owner runs the full gate after
shared source is stable. Neither a check declaration nor a lease enforces that
assignment. Report actual commands/results and why checks were unrun, blocked,
interrupted or matched nothing. If a check must wait, report it as unrun rather
than asking whether to run it now. Report denied-operation limits without retrying
the same class. See [validation ownership](development.md#task-floor-and-validation-ownership).
