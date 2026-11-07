# Runtime feedback

Optional decision signals only: no permission grants, automatic stop/retry/model
switch, resource release or new parent model turn.

## Repeated managed blocks

The generated authority observes `block === true` returns from its own registered
`tool_call` handlers: single-authority guard, original Bash deny/hardening
and vendor permissions. It preserves registration order and the
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
the adapter marks and attempts one orchestration-origin alert per Run through a trusted
metadata-only callback, never the child's `alert_parent` path. Its structural
`source: "managed"` tag cannot be created by matching child-authored text. The
message addresses the parent; it does not inject instructions into the child.

One FIFO preserves scope, order and publication. Child-origin allowances remain
64 per Owner / 16 per Agent; orchestration-origin entries have separate limits of
16 per Owner / one pending per Agent, for at most 80 entries total. These are
admission allowances, not delivery priority. Neither lane evicts accepted work
or consumes the other's quota; a full orchestration allowance, closed gate or callback
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

## Failures and fixed settings

Task replies show concrete errors and availability facts, not a generic
`recovery_hint` lecture. A failed task does not establish model unavailability
or ability. An Agent's model stays fixed across routing changes, `agent_run`
and `agent_answer`; different settings require a fresh Agent.

Usage and context size remain host/UI observations, not routine parent-model
fields. Retired timed-warning attempts are not interpreted by the current codec.
Permission, question, claim and cleanup gates
remain unchanged; no failure message authorizes automatic retry or release.

Use [matched resources and a fresh process](development.md#matched-resource-migration),
not an open-Owner reload or user-file replacement. See [tool contract](tool-contract.md),
[security](security.md) and [limitations](limitations.md).
