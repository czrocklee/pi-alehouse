# Architecture

Pi Alehouse is an explicit extension composition for the host Pi process. The
launcher selects the composition and its matched generated resources; the host
supplies SDK sessions, the model runtime and credentials. There is no second
Pi installation, backend service, or extension-discovery mechanism. For the
Agent, Run and Owner concepts, see [orchestration](orchestration.md).

## Source boundary

| Area                                               | Responsibility                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `bin/`, `src/composition.ts`                       | Launch and integrity preflight; register the matched Pi extensions.              |
| `src/orchestration/extension.ts`, `routing.ts`     | Bind a parent session to the core and resolve trusted presets.                   |
| `src/orchestration/core/`                          | SDK-free Owner lifecycle, claims, scheduling, retention and accounting.          |
| `src/orchestration/runtime/`                       | Adapt Pi sessions, assemble children, observe execution and manage local leases. |
| `src/orchestration/tools/`, `permissions/`         | Model API adapters, permission readiness and Run-bound provenance.               |
| `src/orchestration/history/`                       | SDK journal links and boundaries, bounded cold reads and usage audits.           |
| `src/orchestration/ui/`, `presentation/`           | Host panels and input; shared width-independent text projections.                |
| `src/authority/`, `src/extensions/`, `src/shared/` | Authority patch inputs, policy and UI integrations, and neutral shared helpers.  |

`AgentSessionPort` is the SDK-free execution seam; `PiAgentSessionAdapter` is
its concrete Pi implementation. Runtime reports execution and drain facts to
the Owner. It does not admit or release Runs independently. Orchestration UI
only projects Owner state; it owns presentation and painted input, never an
SDK session or a second lifecycle. An explicit human Stop is routed to the
Owner with the identity of the Run it targets; rendering cannot issue it.
Runtime and UI can both use `presentation/`, but runtime must not import UI.
The independently bundled footer uses `src/shared/` for common primitives,
without importing orchestration. Centered panels use one Pi adapter in
`src/extensions/lib/centered-panel.ts`. Its shared controller in
`src/shared/centered-resize.mjs` owns frame hits, capture, keyboard sizing and
restore state. Each panel retains its own content measurement and input guards.

## Ownership and lifecycle

`OwnerController` is the only lifecycle authority. Admission reserves capacity,
result budget and declared claims together. The scheduler must see those same
reservations to decide what can run, and cleanup must know exactly which Run
and Agent own them before anything is released. Splitting admission, execution
or release into independent state owners would allow double allocation, stale
commands or premature reuse. Adapters report facts; one Owner makes those
state transitions against the original Run identities.

There is one Owner for the live parent session, with a FIFO admission queue.
The earliest dependency-ready Run with an available slot can start; an unmet
dependency or saturated provider need not block later eligible work. By default
there are four executing slots per admitted provider ID and sixteen resident
reservations across the Owner, including queued and completed-unreleased Agents.
Models under one provider ID share slots. This is not an account-wide or
cross-process rate limit. Accepted request replay is scoped to the Owner and
call identity, not semantic deduplication. A later Owner cannot take over a
stale result or command.

An execution slot is released after actual execution exit. The Agent's
reservation and required resources remain through finalization and confirmed
cleanup; uncertain cleanup quarantines instead of permitting reuse. Runs have
cooperative cancellation and a soft turn budget, not a wall-clock execution
deadline. The SDK's post-hook input race limits cancellation guarantees. The
local Linux `flock` lease is not distributed coordination or proof of detached
process exit. No force-unlock or repair path is provided.

Closing seals admission and drains the Owner permanently. Switch/fork requires
confirmed closure; an unused Owner can close automatically, while a used one
needs explicit closure or a confirmed UI drain. Closure and replacement are
not an atomic transaction. `/tree` needs explicit `/alehouse-close`. Never
reload or swap runtime under an open Owner. See [limitations](limitations.md)
for the full operational precautions.

## Profiles and working directory

`worker` maps to internal `editor`; `scout` maps to internal `researcher`.
Those internal IDs still identify managed definitions and historical data;
`researcher` is not a public alias. Worker has local tools under normal policy
and no web tools. Scout has local read/search and controlled web tools, not
model-facing Bash/edit/write. Neither is an OS sandbox. Web-derived findings
are untrusted, and lack of worker web tools is not network isolation. See
[security](security.md) for permissions, web isolation and residual effects.

Children inherit the parent's admitted cwd for resource discovery and tools.
They share local files, dependencies and Git state. Alehouse does not allocate
or manage working copies; the parent coordinates overlapping work.

## Task dispatch boundary

The [dispatch contract](task-dispatch.md) distinguishes runtime preflight and
observation from core admission. Runtime checks declared paths and profile
constraints, handles local build-directory leases and captures optional
execution-start Git metadata. Core atomically admits claims, rechecks eligibility
before startup and holds claims across pending questions and answer lineage.
Acknowledged cancellation, `ask`/unknown preflight and optional source metadata
are not approval, cleanup proof or validation. Receipts require valid history
boundaries and record only partial observations.

## State, retention, and history

Live Agents, Runs, results, request identities, alerts and questions are bounded
Owner memory. There is no automatic eviction, durable outbox or restart
hydration. Result limits cover retained and reserved text, not total heap.
Model observations consume alerts and finished facts only after valid local
publication; this is not a receipt from the SDK or model. See the
[tool contract](tool-contract.md) for paging and publication rules.

SDK journals are the only historical transcript source. Alehouse adds bounded
`alehouse:*` links, Run boundaries and audit records; they don't become a second
result store. `/alehouse-history` performs bounded reads of trusted SDK-derived
paths and can report missing or invalid history. It does not repair journals,
accept arbitrary paths or resume work. An append ID is not fsync evidence.

## Accounting

Child usage is an observed floor, attributed where the SDK provides the facts.
Totals derive from model shares; an incomplete share is not a zero. The next
parent tool result can carry settled usage as normal Pi usage. Settlement after
the last result leaves `unreported_usage`, with a best-effort audit snapshot on
orderly close. Neither a UI total nor a journal record proves complete billing.

## Host and policy seams

The host bridge validates the SDK capabilities it uses; for example,
`ModelRegistry.runtime` is a compatibility seam, not a public runtime getter.
The patched authority, worker policy, static guard, search policy and optional
Jev reviewer are composed outside the orchestration core. Readiness and
approval provenance bind a Run to the existing authority, not a second grant
system. The [immutable resource floor](security.md#immutable-resource-floor-in-writable-installations)
protects detectable effects on matched runtime resources and exact credential
paths; it isn't OS isolation. Changes at these seams need the appropriate
[validation lane](validation-evidence.md), not just a passing core test.
