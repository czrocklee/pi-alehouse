# Organization boundaries

Status: architecture adopted for the Pi Alehouse source layout. This is not a
release or deployment acceptance decision.

## Decision

- Keep a single root Pi Alehouse package and internal `src/` subtrees
  (`src/orchestration` for the orchestration layer, `src/extensions`,
  `src/shared` and `src/authority` for integrations).
  The explicit CLI composes generated matched `generated/` resources; there is no
  separate orchestration npm package, Nix consumer or independent Pi runtime.
- Keep one authoritative `OwnerController`. Admission, FIFO execution,
  cancellation, wait/progress claims, settlement, retention, and shutdown share
  invariants. Separate files for independent schedulers or cleanup managers
  would introduce additional mutable lifecycle authorities.
- Organize adapters by responsibility, not under a catch-all `pi/` directory.
  The runtime remains a concrete Pi SDK integration, not a generic backend
  framework. Ports exist at actual testable ownership boundaries.
- Runtime owns child observation; UI consumes observations and owns presentation
  state. Permission-dialog yielding is not approval provenance or authorization.
- Keep live Owner memory, SDK journals, and usage-audit entries distinct. Cold
  history is inspection, never Agent hydration or a second result store.
- Independently bundle small neutral helpers from `src/shared/` into footer and
  orchestration. Ordinary Pi must not require the orchestration layer to load.
- Classify tests by execution boundary. Port collectors deliberately; clearer
  command names do not authorize live provider calls or deployment.

## Compatibility

The layout does not version the public tool schemas, profile/preset IDs,
configuration paths, `alehouse:*:v1` records, permission lifecycle events, or
cross-extension Symbol keys. Internal scripts and collectors are not
compatibility surface: teach and use the canonical entrypoints only.

See [architecture](../architecture.md) for the source boundaries and
[limitations](../limitations.md) for actual support scope.
