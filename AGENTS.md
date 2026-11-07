# Pi Alehouse contributor guidance

Read `docs/development.md`, `docs/security.md` and `docs/limitations.md`
before changing contracts.

## Build

- One root package that builds without Nix; `flake.nix` and `nix/` are
  optional packaging, never npm build inputs.
- Dev: `npm ci --ignore-scripts` (includes the pinned dev Pi SDK),
  `npm run build`, `npm run check`. Policy and controlled host suites run
  separately.
- Production installs only a verified built tarball with
  `--omit=dev --legacy-peer-deps --ignore-scripts`, so peers cannot pull in a
  second Pi runtime; the host supplies Pi.
- Never run real-model, network, human-approval or publishing workflows
  without explicit authorization. Inherited baselines, fixture exit codes and
  local observations are not release acceptance.

## Layout

- `src/orchestration`: orchestration layer (`core/` stays SDK-free).
  `src/extensions`, `src/shared`, `src/authority`: internal integrations.
  `resources/`: source input.
- `generated/{agents,extensions,shared,authority}` is build output: never
  edit by hand; keep the upstream license in authority output.
- `test/` lanes: `unit`, `sdk`, `packaging`, `host`, `tui`, `support`;
  `integration` holds controlled host fixtures, `extensions` holds
  extension/helper regressions.
- Generated output, reports, secrets and private transcripts are not source.
- CLI: `bin/pi-alehouse.mjs`. Root `pi.extensions: []` keeps Pi from
  autoloading `src/composition.ts` or treating this as a `pi install`
  extension.

## Boundaries and conventions

- Owner lifecycle lives in `src/orchestration/core`, Pi SDK adaptation in
  `src/orchestration/runtime`, authorization in `src/authority`; UI is
  projection only.
- **Alehouse** for user-facing labels and `/alehouse-*` commands; plain labels
  (Settings, Agents, Usage) inside branded panels; the internal layer is
  **orchestration**.
- English first. Other languages only where behavior needs them: CJK/grapheme
  fixtures and non-English input matchers (e.g.
  `src/extensions/lib/jev-review-packet.ts`).

## Compatibility

- Never rename or remove child tool names, profile IDs (`editor`,
  `researcher`), `alehouse:*` record names, on-disk config paths, lifecycle
  event names or `Symbol.for` keys.
- Historical records stay byte-literal; retaining one is not schema support
  and never revives a retired codec, renderer or selection path.
- Parent management tools are a model-facing API with no caller compatibility
  burden: design them for the model (`docs/tool-contract.md`).
- Retired: reader runtime support (with its scratch/stderr capability keys)
  and orchestration-managed worktree mode. Don't restore their machinery or
  use retirement to rename what remains; retired names stay in deny/exclusion
  lists.

## Security

- Never copy credentials, rewrite or delete existing user files or worktrees,
  silently enable models, weaken denies, or claim OS sandboxing.
- Initialize only missing user resources, by explicit command; routing
  defaults to `off`.

## Validation

- One explicitly delegated owner runs the full gate after shared
  source/policy/schema changes are frozen; other tasks run only their assigned
  focused checks.
- Report actual commands and results, including unrun, blocked or interrupted
  checks.
