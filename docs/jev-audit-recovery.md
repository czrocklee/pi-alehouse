# Jev audit failures and offline recovery

Jev automatic allows require a complete, synchronous audit append and confirmed
cleanup. An unavailable audit sink falls back to normal human handling; it does
not grant permission. Specific audit diagnostics distinguish lock contention,
legacy locks, unsafe paths/identities, incomplete records and IO/cleanup errors.
Existing configured allows and the rest of the permission authority are separate.
See [security](security.md#permission-readiness-and-provenance),
[performance](performance.md) and [limitations](limitations.md#retention-history-and-accounting).

## Current protocol

For `<agentDir>/logs/jev-auto-approval.jsonl`:

- The active path is unchanged.
- `.jev-auto-approval.jsonl.lock` is a persistent private **regular file**. The
  retained open-file-description holds an exclusive kernel flock; closing its
  last descriptor or process death releases the lock. Normal operation never
  removes, renames or truncates this lock inode.
- `jev-auto-approval.jsonl.archives/` holds exclusive private containers. Rotation
  atomically renames the old active file into a fresh `audit.jsonl` slot, rather
  than overwriting an archive or using a link/unlink pair.
- The active-file append limit is 1 MiB. Archives and total disk usage have **no
  automatic retention/deletion bound**. Acknowledged writes are not fsync or
  power-loss durability evidence.
- A short kernel contention wait is followed by fresh approval validation before
  writing an allow. A timeout, invalid context or unconfirmed write/close defers.
  This is not a model/network retry or a hard filesystem latency guarantee.

The same lock pathname prevents the intervening mkdir-lock implementation from
writing while a new regular lock file exists. **The original unlocked logger
ignores both protocols.** Do not mix generations against one audit sink. An
upgrade or rollback requires stopping every old writer and using matched package,
resources and a fresh Pi process. Never remove a possibly held kernel lock file.

## What is and is not recovered automatically

A killed current-format writer does not leave a directory lock to steal. Its
kernel lock releases, and another writer can validate and append. A crash after
atomic archive rename can leave the old file safely archived and the active path
absent; a later writer creates a new private active file.

These conditions intentionally do **not** resume automatic approvals silently:

- An old directory at `.jev-auto-approval.jsonl.lock`: it may be a live legacy
  writer, not a stale lock.
- A legacy active/archive pair with an extra hard link: its relationship must be
  inspected rather than bypassing the single-link check.
- A nonempty active file without a final LF: a partial write is evidence of an
  incomplete record. Appending another JSON object, trimming bytes, or merely
  adding LF would not restore a valid audit history.
- Unsafe directory permissions, ownership, symlinks or identities; unknown
  artifacts and unconfirmed close/IO failures.

## User-namespace ownership limit

The canonical audit directory must appear owned by the current UID. Every
ancestor must appear owned by the current UID or root; permission and sticky-
directory checks still apply. An incomplete user-namespace UID/GID mapping can
make host-root-owned `/home` or `/tmp` appear as an overflow UID, often 65534
(`nobody`). That value does not reveal the original owner, and is not an extra
trusted UID. Other genuine foreign owners are rejected by the same rule.

In that environment both auditing and this recovery utility fail closed with
`untrusted_directory_owner`, even if the log directory and lock are healthy.
Jev automatic allows defer to ordinary human handling. The operator must supply
an environment with verifiable ancestry and suitable mappings; changing the
log file, flock path, permissions, or retrying recovery cannot fix hidden parent
ownership. Do not add an overflow-UID allowlist, weaken the check, or bypass a
denied sandbox operation. Tests in such a namespace may fail for this reason;
passes from a deliberately relaxed disposable copy do not verify unchanged source.

## Offline operator procedure

**Do not run recovery from a model tool or inside an open Owner.** First close
Owners normally, then stop **all** Pi/other processes sharing this agentDir or
canonical audit target, including old installations. A confirmation flag is only
an operator assertion; it does not discover or stop writers and is not PID/TTL
proof. Keep private backups/evidence and follow normal filesystem permissions.

The self-contained ESM utility does not need a second Pi SDK, Jiti, a model,
network, auth file or saved transcript. Use the verified built package's script.
Pass the exact absolute **canonical** log path and the fixed audit basename;
for a logs symlink, do not pass a spelling that follows the link implicitly.

Inspect first; the default is dry-run and must not create or change artifacts:

```sh
node scripts/recover-jev-audit.mjs \
  --log /absolute/canonical/logs/jev-auto-approval.jsonl
```

Read its JSON plan and address unsafe or unrecognized states outside Pi. Only
then, with all writers confirmed stopped, explicitly apply using an already
verified absolute util-linux flock executable (not project PATH):

```sh
node scripts/recover-jev-audit.mjs \
  --log /absolute/canonical/logs/jev-auto-approval.jsonl \
  --flock /absolute/verified/bin/flock \
  --apply --confirm-writers-stopped
```

The apply operation may convert a verified empty legacy lock directory into the
persistent regular-file protocol. For recognized damaged active records it
preserves their exact bytes in a new private evidence container and creates a
clean private active file; existing archives stay untouched. It does not
reconstruct missing audit records or claim that an earlier audit gap was closed.
Unknown links/files, occupied kernel locks or changing identities are failures,
not permission to force a repair.

Recovery is **not a transaction or rollback guarantee**. A failure may leave
some planned steps completed. Preserve artifacts, inspect a new dry-run and
resolve the specific cause; do not blindly delete locks or evidence. A reported
success still requires fresh runtime validation. Restart a matched Pi process;
never live-reload an open Owner or interpret recovery as an approval grant.

## Shared logs and symlink layouts

Safe owned shared log directories such as 0750 are not forcibly chmodded on
every append. Audit files remain 0600 and archive containers 0700. Writable or
untrusted ancestors are rejected; metadata checks are not an OS sandbox or a
hostile-same-UID defense.

A supported external logs symlink is bound to its canonical target at startup.
Before the immutable permission floor freezes, the exact active/lock files and
archive root receive lexical/canonical protection. Unrelated extension logs do
not become read-only merely because they share the directory. Later retargeting
fails; choosing a different target requires a fresh matched process. The archive
root itself must be a real directory, not a symlink to another tree. The writer
and recovery command do not silently change user symlinks or broaden authority.
