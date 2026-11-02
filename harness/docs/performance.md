# Performance and safe cache boundaries

Performance work preserves the [tool contract](tool-contract.md),
[authority boundaries](security.md), and [support limits](limitations.md).
Caches are implementation details, not admission evidence or permission grants.
Generated `runtime/` files are built output, never the place to apply fixes.

## Streaming and Owner projections

The SDK adapter and Owner use an internal append/reset output seam. The Owner
retains bounded chunks and joins them only when a text reader or final result
needs a string. A new assistant attempt resets the candidate: tool commentary,
failed attempts and retries are not concatenated into the final result.
Full-output ports and final snapshots still undergo monotonic-prefix validation.
Materializing text compacts the retained chunk list to that same memoized string;
it does not keep the complete old chunk list alongside a second joined prefix.
This releases buffer references, not a promised heap/RSS ratio or immediate GC.
Split surrogate pairs, retained-prefix limits, total observed UTF-16 units and
callback failures retain their existing meanings.

Immutable inherited-context digests and byte counts are computed independently
of repeated roster projections. A presentation revision can invalidate UI data,
but does not certify lease health, current policy, task ordinals or admission.
Independent commands and explicit inspection must continue checking fresh facts.
Communication indexes are local to a projection/validation pass and preserve
original Run references rather than creating a second authority registry.

History remains bounded and **not automatically evicted**. Results, task ranks,
request replay, pending questions, handoffs and stateless result cursors depend
on retained Runs. Hitting the admission cap still requires closing the Owner and
starting fresh; an SDK journal is not a transparent replacement for that state.
Result limits are not a heap/RSS limit.

## UI and permission caches

Animation must not force a fresh historical projection just to change a glyph.
Detached roster snapshots, stable transcript projections and footer context
values can be reused only while their source identity/revision remains valid.
Lifecycle, branch, model, compaction, theme and width changes still invalidate
relevant presentation. Whole-session spend uses count-verified append traversal
where the host exposes the optional public count API. Without a reliable whole-
journal count/revision it reads fresh, even when the branch leaf is unchanged:
an unobserved A→B→A navigation can still add billed usage on B. The regular footer uses a synchronous render token instead of a
marker search; only short-viewport padding needs a detached reference copy.
Missing host capabilities retain a fresh fallback rather than inventing a
reliable cache key. UI caches never acknowledge alerts or
finished facts, and never authorize a Stop or another model command. Explicit
fresh inspection also supplies the next detached pane snapshot instead of
immediately repeating that read. Ordinary transcript invalidation preserves
settled components; real theme replacement must still repaint correctly.

Grok billing remains opt-in. Refresh attempts are throttled and final dirty
activity is coalesced; leaving the applicable provider retires delayed work.
The display distinguishes pending/failed data and the last successful refresh;
the minimum attempt interval is not a maximum data-age guarantee.

Permission optimizations favor bounded caches of pure computations, such as
compiled wildcard expressions and parsing identical configuration contents.
Cache keys must include every semantic input (including HOME expansion and path
flavor). Original-request and hardened-request checks remain distinct.
Filesystem/policy samples must not be reused across an approval wait or another
invocation: denies, workspace releases and symlink targets may change then.
Forwarding watcher registration failures use bounded backoff independently of
the unchanged 250 ms response/liveness polling; a watch is only a wake-up hint.
Jev continues revalidating current policy, action, user authorization, loaded
restrictions, Run witnesses, mode and script evidence after its asynchronous
review; leaf/entry counts alone are not a freshness proof.

Jev keeps synchronous audit confirmation: a failed append, rotation or lock
release cannot produce an automatic allow. It retains a kernel `flock` on the
persistent regular `.<log basename>.lock` inode; process death releases the OFD
lock, and normal cleanup never unlinks the lock file. The short contention wait
is followed by complete synchronous approval revalidation before writing an
allow, not a cached decision or a network/model retry.

Successful appends keep the active JSONL file within 1 MiB. Rotation uses a fresh
private container under `<log path>.archives` and atomic rename to its empty
slot, avoiding the former link/unlink interruption window without overwriting
archives. **Total audit disk usage is still unbounded.** Shared logs-directory
modes such as safe owned 0750 are preserved; audit files and containers remain
private. A symlink layout needs a startup-fixed canonical binding and immutable
protection for the exact active/lock files and archive root, not all unrelated
extensions' shared logs.

Legacy directory locks, old extra hard links and unterminated active tails still
fail closed with specific diagnostics. They require explicit offline recovery;
bytes are never silently repaired, truncated or discarded. See
[Jev audit recovery](jev-audit-recovery.md) for dry-run inspection, writer-stop
requirements, mixed-version restrictions and preserved evidence. Linux procfs
and trusted util-linux flock remain required. This audit lock is distinct from
the Owner lease and is not fsync/crash-durability evidence.

Startup optimizations must preserve host SDK export identity, parent/child web
instance isolation, factory ordering, early immutable-resource protection and
both preflight boundaries. Explicit source specifiers avoid suffix probing, but
jiti still transpiles TypeScript on a cold cache; this is not a full precompiled
runtime migration. Never use an environment flag as proof that an integrity
check can be skipped. Package changes still require a matched build,
a verified built tarball and a fresh Pi process, not a live-Owner reload.

## Reproducible offline measurements

After the normal dependency installation and build, run from the root:

```sh
node scripts/bench-pi-performance.mjs
node scripts/bench-pi-performance.mjs --legacy
```

Use `--core-only` to omit the development-SDK reference measurements. The script
prints JSON to stdout; capture evidence outside source. It uses generated
harness JS and synthetic in-memory data only: no saved journals, credentials,
model requests, host CLI, approval interaction or network. It does not build or
install anything implicitly.

The default measures bounded streaming append plus one final materialization,
plain-text wrapping, and uncached SDK context/transcript reference operations.
`--legacy` additionally times an equivalent cumulative-string protocol at small
sizes for comparison, not the old installed runtime. The uncached references
explain the cost avoided by presentation caches; they are not timings of the
cached footer or an end-to-end child session.

Record Node/SDK versions, CPU, sizes, delta granularity, cache conditions and
actual commands with observations. Prefer regression assertions about data
identity, call counts, bounded retention and invalidation to flaky wall-time
thresholds. Warm/cold startup needs its own controlled readiness and module-
identity evidence; an RPC response alone does not prove successful extension
initialization. Do not add unrelated historical measurements as current
acceptance or sum independent ablations into a promised launch latency.

Use the unique validation owner and separate portable/controlled-host lanes in
[development](development.md#task-floor-and-validation-ownership). Offline
microbenchmarks are not host compatibility, human-TUI acceptance, OS isolation,
real-model quality, durable history or public release evidence.
