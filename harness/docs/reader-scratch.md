# Reader scratch

Reader reads the project and can use `write` only in its own private
`/tmp/pi-alehouse-reader-*` directory. No `edit` or web. Use editor for builds
and project changes. Input read behavior is unchanged. Linux is the only
supported platform; there is no `TMPDIR` setting or output allowlist.

The trusted child factory creates a fresh mode-0700 directory and binds it to
the actual child SDK session. The child prompt names it. Follow-up tasks reuse
it; confirmed shutdown revokes access but preserves reports. Uncertain cleanup
retains the binding. No model parameter, project rule or configuration selects a
writable directory or grants the exception.

The scratch-write exception is a short-lived, process-local per-call capability
granted only at the real tool boundary of the trusted built-in `write` tool.
Eligibility requires a live token bound to the actual child SDK session, the
exact original path and the current scratch directory; path containment alone
never grants the exception. The guard checks the original absolute path,
session identity, directory identity and
canonical containment, using the same effective identity as the permission
session, including its last-known name, and runs before the vendor permission
handler. Other readers' directories, source paths, symlink escapes, dangling
aliases and detectable hardlinked files are rejected; missing, malformed or
stale provenance gets no exception. Global/project rules, project-agent floors
and immutable resource protection still apply; they do not depend on the
reader's default write floor. Session grants and yolo cannot bypass the write
guard. A binding is rechecked after an awaited approval, before returning allow.
Denial reason priority is unchanged: an existing deny can keep its own reason.

Forwarded asks retain and verify the requesting child's binding and its
direct-write capability, not the parent identity. Generic profile or
permission-service queries — including dispatch ownership/tree preflight and
existing generic followup queries — receive no scratch exception; a new spawn
has no scratch at preflight. Claims and declarations cannot invent
scratch permission.

Invocation checks inspect only the caller's record; tool-visibility queries
still scan registered directories. Idle readers and cleanup-uncertain bindings
can outlive execution slots, so concurrency is not a registry-size bound. No
performance problem has been observed; this is not a performance guarantee.

Bash receives no scratch-write exception or write capability: it preserves real
paths, including unproven effects, and retains normal approval. Use `write`
for temporary reports and helper files. Opaque programs, incomplete path
extraction and filesystem races remain outside these guarantees: this is not an
OS sandbox. See [security](security.md) and [limitations](limitations.md).

Builds regenerate matched worker definitions and policy. Installation/activation
still requires the [matched-resource migration](development.md#matched-resource-migration)
and a fresh Pi process; existing user files are never replaced automatically.
