# Runtime feedback

Optional decision signals only: no permission grants, automatic stop/retry/model
switch, resource release or new parent model turn.

## Repeated managed blocks

The generated authority observes `block === true` returns from its own registered
`tool_call` handlers: single-authority guard, original Bash deny/hardening,
managed scratch and vendor permissions. It preserves registration order and the
original return/throw.

Registration uses a separate facade overriding only `on`, not a Proxy of the
host API or a mutation of it. Other APIs are inherited live; this is not an
own-property clone or a promise of compatibility with receiver-branded APIs.
The producer and adapter share one exact-tool vocabulary, checked against the
generated profile union plus fixed child communication tools. Composition passes
that vocabulary into the SDK-free core as bounded configuration data; core copies
its own membership set and imports no runtime/shared adapter. Without this
configuration, optional managed-block feedback is disabled.

Each private lease binds the actual SDK session ID and authority service object.
The producer captures it before invoking the handler and rechecks it after
settlement. Revoked/replaced leases and missing/changed identities report
nothing; old releases cannot remove new leases. Observer failures never change
permission decisions. This is in-process plumbing, not a sandbox against trusted
extensions.

Only exact allowlisted tool names and opaque call IDs (1--256 UTF-16 units)
reach the adapter. Each Run retains at most 128 distinct IDs without eviction;
duplicates are ignored. Collection stops at the cap or when two distinct blocks
of one tool latch a summary. This establishes neither equivalent operations nor a deny
reason. Parent text contains no inputs, paths, IDs, reasons or model details.

The authority callback only latches facts. At the next SDK `tool_execution_end`,
the adapter marks and attempts one harness-origin alert per Run through a trusted
metadata-only callback, never the child's `alert_parent` path. Its structural
`source: "harness"` tag cannot be created by matching child-authored text. The
message addresses the parent; it does not inject instructions into the child.

One FIFO preserves scope, order and publication. Child-origin allowances remain
64 per Owner / 16 per Agent; harness-origin entries have separate limits of
16 per Owner / one pending per Agent, for at most 80 entries total. These are
admission allowances, not delivery priority. Neither lane evicts accepted work
or consumes the other's quota; a full harness allowance, closed gate or callback
error drops only this optional attempt, without retries. Commit validates source
against the original queued entry. Selection and Off rules still apply;
acceptance is not receipt or a new parent turn. Gate closure suppresses feedback,
stop seals before SDK stop, and settlement/disposal unsubscribes. Reuse starts
fresh; steering invalidates approval, not the observation lease.

**Coverage is partial.** Independent static-safety handlers, policy-grep execution,
dispatch/readiness, SDK validation, raw tool failures and handler throws are not
observed. UI `permissions:decision`, error text and `tool_execution_end.isError`
are not denial evidence. A captured block may itself be validation/fail-closed,
not policy denial. Silence proves neither no blocks nor no prohibited retries.

## Fixed-model guidance

Only settled `failed` / `execution_error` / `model_stop_reason=error` outcomes get
an optional `recovery_hint`; pending finalization is not settlement. The pure
projection reads no routing/catalogue and adds no lifecycle state. Error text,
quota, authentication, timeouts and environment failures do not establish model
unavailability or ability.

An Agent keeps its original model across routing changes, `agent_run` and
`agent_answer`. If that model is unavailable, ask the user to check worker
configuration, then explicitly spawn a fresh Agent with artifacts and a handoff.
Keep reasoning difficulty task-based. Failed tasks are not valid `after` inputs;
Off, questions, claims and confirmed-cleanup rules still apply.

The whole hint is at most 384 UTF-16 units and does not suggest continuing an
unavailable Agent. Both core and independent replies use the same conservative
record-settlement predicate; a failed Outcome alone is insufficient.
Packing tries guidance after questions, FIFO alerts and time/context hints,
before results. Identical guidance appears only once per response, including
rosters, on its first qualifying task; deduplication is not packing loss and
creates no persistent presentation state. It spends envelope bytes, not body-text
units. If it cannot fit, omit it whole and set `response_limit_reached`; required
controls, question IDs and cursors remain. List/interrupt use the same projection;
finished rows carry no hint. Neither publication nor the hint proves availability,
recovery or quality acceptance.

Use [matched resources and a fresh process](development.md#matched-resource-migration),
not an open-Owner reload or user-file replacement. See [tool contract](tool-contract.md),
[security](security.md) and [limitations](limitations.md).
