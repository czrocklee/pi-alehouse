# Recover a Jev audit log offline

If Jev cannot confirm an audit append and cleanup, it defers to ordinary approval. A failed automatic allow is **not** an instruction to delete a lock. The audit lock is separate from the Owner lease. Start with the diagnostic and the state of the active log.

## Recognize the files

Under `<agentDir>/logs/`, `jev-auto-approval.jsonl` is the active log. It rotates at 1 MiB into a new private container under `jev-auto-approval.jsonl.archives/`; archives have no automatic deletion limit. `.jev-auto-approval.jsonl.lock` is a persistent **regular file**: the kernel releases the lock when the last owning descriptor closes, not when someone unlinks the file. A missing active log after rotation can be normal. These writes do not guarantee power-loss durability.

| Observation                                                                            | What to do                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Contention on the regular lock                                                         | Let the writer finish. Do not remove, rename or truncate the lock. A timeout or dead-looking PID is not proof of safe recovery. |
| A directory at the lock path, an extra hard link, or an active file without a final LF | Stop all writers and inspect with the utility below. Do not append a newline, discard the tail, or break a link by hand.        |
| `untrusted_directory_owner`                                                            | Check the ownership visible in the current user namespace. Recovery cannot fix an unverifiable ancestor.                        |
| Unknown artifacts, unsafe permissions or a changed symlink                             | Resolve the cause outside Pi. Do not broaden the protected paths or bypass a refused operation.                                 |

## Offline operator procedure

1. Close all Owners normally and stop **every** Pi process or other writer sharing the agent directory or its canonical log target, including older installations. Older unlocked writers do not honor the current kernel lock. Keep private backups. Do not invoke recovery from a model tool or an open Owner.
2. From the matching **source checkout** on Linux, run the read-only inspection below. The utility is not in the npm tarball. Use the absolute canonical log directory and the exact basename; do not supply the symlink spelling of a logs directory.

   ```sh
   node scripts/recover-jev-audit.mjs \
     --log /absolute/canonical/logs/jev-auto-approval.jsonl
   ```

3. Read the JSON plan. If you recognize the artifacts and have confirmed that all writers are stopped, apply it with a verified absolute util-linux `flock` executable:

   ```sh
   node scripts/recover-jev-audit.mjs \
     --log /absolute/canonical/logs/jev-auto-approval.jsonl \
     --flock /absolute/verified/bin/flock \
     --apply --confirm-writers-stopped
   ```

   The confirmation is your assertion, not writer detection. Apply can replace a verified empty legacy lock directory with a private lock file. For recognized damaged active files it preserves the bytes in an exclusive evidence container and creates an empty private active file. Existing archives stay intact. It **cannot reconstruct missing audit events**.

4. If a step fails, preserve the artifacts and inspect a fresh dry-run; apply is not transactional. After success, restart a fresh, matched Pi process and validate the runtime. Recovery does not grant approval or authorize a live reload.

## User-namespace ownership limit

The canonical log directory must appear owned by the current UID. Each ancestor must appear owned by that UID or root; writable-directory and sticky-bit checks also apply. A namespace with incomplete UID/GID mappings may show a host-root ancestor as the overflow UID (often 65534). That number identifies neither the original owner nor the cause. Audit and recovery fail closed until ownership is verifiable; do not whitelist the overflow UID.

Safe owned shared log directories can retain modes such as 0750. Audit files are private; new files are 0600 and archive containers 0700. A supported external logs symlink is bound at startup to the exact canonical active file, lock and archive root. The archive root itself must be a real directory. Changing targets requires a fresh process; an unrelated extension's logs need not be made read-only. See [security](security.md).
