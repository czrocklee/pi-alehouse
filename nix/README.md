# Nix packaging

Optional Nix packaging for a host Pi installation. The npm package builds
without it, and nothing here is an npm build input.

- `package.nix` builds the npm package from this repository with lifecycle
  scripts disabled and wraps the `pi-alehouse` launcher. `npmDepsHash` must be
  updated together with `package-lock.json`; `nix build .#pi-alehouse` reports
  the expected value.
- `hm-module.nix` is `homeManagerModules.default` (`programs.pi-alehouse`).
- `permission-bootstrap/` holds the persistent bootstrap and settings
  migration used for ordinary Pi.

## Home Manager module

The module installs the launcher and the generated worker profiles. The optional
`permissions` and `presets` paths become `extensions/pi-permission-system/config.json`
(restored on activation if the settings UI rewrote it) and `harness-presets.json`.
When left null those files stay user-owned. `jevApiKeyFile` passes only a
credential path. `dashboardUrl` and `grokBilling` enable the footer's personal
integrations for both launchers.

With `ordinaryPi.enable` (default), plain `pi` also loads the policy/UI
extensions and the managed permission authority from the same generated runtime.
Extensions are installed as one-line shims, not symlinks: Pi resolves an entry's
relative imports from its `~/.pi` path, so a symlinked entry cannot reach
`runtime/lib`.

## Bootstrap and rollback

Home Manager links `managed-permissions.json`, which selects the generation's
authority. Activation then copies the self-contained bootstrap to
`extensions/managed-permissions/index.ts` as a regular `0600` file and disables
npm's automatic loading of the public `@gotgenes/pi-permission-system@32.0.3`.
Changed settings are backed up once to `settings.json.before-managed-permissions-v1`;
unrelated fields and unknown files are preserved. A missing `settings.json` is
created as `{}` first.

Home Manager deliberately does **not** own the bootstrap. Rolling back to an
older generation removes only the selector, and the bootstrap then loads the
installed public `32.0.3` authority. It must stay a copy, not a store symlink
that GC could remove. A malformed or dangling selector, missing closure, wrong
fallback version, factory failure or duplicate authority blocks tools instead of
silently downgrading. The build fails if the generated authority no longer
provides what the bootstrap calls. Start a fresh Pi process after activation or
rollback; disabling the module does not remove the bootstrap or settings entry.

## Validation

`scripts/check-nix-deployment.sh HM_GENERATION [PI]` inspects an already-built
generation without activating it: selector and bootstrap, worker links and
extension shims, installed preset schema, host-only SDK and the store launcher.
It loads the installed extension entries in host Pi (RPC mode, no model calls),
then runs `scripts/check-pi-permission-bootstrap.mjs`, which exercises legacy →
managed → rollback → re-upgrade, session switch/reload, broken or partial
bootstraps and duplicate authorities in a scratch agent directory. Both scripts
also ship in the built package.
