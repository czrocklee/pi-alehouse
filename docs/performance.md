# Performance and safe cache boundaries

A faster projection must not change the [tool contract](tool-contract.md),
[permission decision](security.md) or [support limits](limitations.md).
Measure source changes; never patch generated output. Use the
[single validation owner](development.md#task-floor-and-validation-ownership)
for any shared build and gate work.

## Streaming and Owner projections

The SDK adapter and Owner use an append/reset output seam. Retain bounded chunks
and materialize text only for readers and final results. A new assistant attempt
resets the candidate, so commentary and failed attempts don't become part of
the final result. Preserve prefix checks at full-output ports, Unicode boundary
handling and observed versus retained lengths. Retention limits aren't heap or
RSS limits and don't imply immediate garbage collection.

Cache immutable facts or reuse projections within a known revision. Do not
cache admission, lease health, task ordinals or original-Run validation across
independent reads. Retained Runs still support replay, questions and cursors;
there is no automatic eviction or journal-backed replacement. Faster history
lookup must find the seal on the path back to the Run start, reject intervening Run starts and exclude messages after the seal. Cold reads still validate the journal snapshot.

The offline Run journal analyzer accumulates model shares per group, then computes totals in model order. Adding pre-summed Run totals changes floating-point results. Overflow in any group still fails the batch.

## UI and permission caches

Animation can reuse detached display data without reprojecting history. Model,
branch, compaction, theme, width and lifecycle changes invalidate affected views.
Without a reliable whole-journal count or revision, footer spend falls back to
fresh reads; a stable branch leaf doesn't prove nothing was spent elsewhere.
The fullscreen Usage panel still reads spend and rebuilds layout and styling;
only fitting an identical styled row at the same position and width can be
reused. Preserve the terminal-protocol filter and Unicode width behavior; an
ASCII fast path is not valid for all styled text. UI caches don't authorize a
Stop or acknowledge a notification.

Permission caches are for pure computations with complete semantic keys (e.g.
identical config contents or a wildcard with the same path semantics). Keep
original-request and hardened-request checks distinct. Do not reuse policy,
filesystem or identity samples across an approval wait or another call. A
watcher is a wake-up hint, not a freshness proof. Jev still revalidates after
asynchronous review and requires synchronous audit confirmation for automatic
allows. See [security](security.md) and [audit recovery](jev-audit-recovery.md)
for the authority and lock boundaries.

Startup changes must preserve the host SDK export identity, parent/child web
instance isolation, integrity checks and early resource protection. Cold
TypeScript loading still uses jiti; this isn't a precompiled runtime. A new
runtime needs a [matched build and fresh process](development.md#matched-resource-migration),
not hot reload. Warm/cold startup measurements need a controlled host and
extension-readiness checks; an RPC reply alone doesn't prove initialization.

## Reproducible offline measurements

From the source root with locked development dependencies and a fresh
`npm run build` (including for `--core-only`):

```sh
node scripts/bench-pi-performance.mjs
node scripts/bench-pi-performance.mjs --core-only
```

`--core-only` skips the journal lookup and uncached SDK reference measurements.
The default measures bounded stream append plus final materialization, wrapping,
Run-local lookup after 10k/30k earlier entries and uncached SDK
context/transcript work. The SDK measurements are references, not timings of the
cached UI or a child session. The script builds nothing.

For the fullscreen Usage panel, install locked development dependencies in
both the runner and any target checkout. No generated runtime is needed:

```sh
node scripts/bench-footer-breakdown.mjs
node scripts/bench-footer-breakdown.mjs /path/to/other/checkout
```

The synthetic compositor measures stable and changing spend in wide and tight
viewports. Before timing, it checks complete styled rows against uncached
frames. Each workload's `frameSha256` covers those full frames in variant order.
Compare the hashes between revisions before comparing medians; describe any
intentional render change separately. Verification and hashing aren't timed.

Both scripts emit JSON; save it outside the checkout. Record revisions, commands,
Node and SDK/TUI versions, CPU, workload sizes and cache conditions. Prefer
regressions for data identity, invalidation and bounded retention to wall-time
thresholds. These synthetic inputs use no saved sessions, credentials, host
CLI or network. They cannot establish end-to-end latency, live model quality,
human UI acceptance or public release readiness.
