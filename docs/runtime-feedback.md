# Runtime feedback

Runtime feedback is an optional signal to the parent, not a permission grant,
retry detector, availability diagnosis or instruction to the child. It does not
stop work, change settings, release resources or start a parent model turn.

## Repeated managed blocks

The managed authority observes actual `block === true` returns from its own
registered tool-call handlers (guard, original Bash deny/hardening and vendor
permissions), without changing their return or throw. Observations bind to the
actual child SDK session and authority service. Revoked/replaced bindings and
late results from a previous task do not count. Without configured observation,
this feedback is disabled.

Only exact allowlisted tool names count. Per task, accept up to 128 distinct
opaque call IDs (1–256 UTF-16 units), with no eviction; ignore duplicates. Two
distinct blocks of **the same tool** latch one summary. At the next SDK
`tool_execution_end`, Alehouse makes at most one alert attempt for that task.
The summary names the tool but contains no inputs, paths, call IDs, reasons or
model details. Its structural `source: "managed"` tag is not child-supplied.

The alert uses the [same FIFO and publication rules](tool-contract.md#child-tools)
as child alerts, with a separate admission quota (16 per Owner, one pending per
Agent), not delivery priority. Full quota, a closed gate or an observer error
can lose the optional attempt; there is no retry or eviction. Stop seals the
observation before SDK stop; settlement/disposal unsubscribes, and reuse starts
fresh. Steering invalidates automatic approval, not this observation.

**Coverage is partial.** Independent safety hooks, policy-grep execution,
dispatch/readiness checks, SDK validation, tool failures and throws do not count.
UI permission events, error text and the SDK's `isError` flag are not evidence.
A managed block may be validation or fail-closed, not a policy denial; two calls
need not be equivalent. Silence proves neither no blocks nor no prohibited retries.

## Failures and fixed settings

Read concrete task errors and availability facts in the [tool contract](tool-contract.md).
A failed task is not evidence about model ability or availability. A different
model or binding requires a fresh Agent; `agent_run.max_turns` only changes the
new task's soft budget. Neither failure nor feedback changes question, claim,
permission or cleanup gates. See [security](security.md) and [limitations](limitations.md).
